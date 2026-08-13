import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/projection.ts
/** Defaults target the AKO runtime MCP tools plus this plugin's own tools. */
const DEFAULT_PROJECTION = {
	benchTools: ["kernel_evaluate"],
	profileTools: ["kernel_profile"],
	finalizeTools: ["run_finalize"],
	planTool: "cockpit_plan"
};
/**
* Whether a logged tool name matches a configured name: exact, or as a suffix
* behind a separator (MCP registrations may prefix the server name, e.g.
* `ako__kernel_evaluate`).
* @param name - tool name as logged.
* @param patterns - configured names.
* @returns whether any pattern matches.
*/
function matchesTool(name, patterns) {
	return patterns.some((p) => {
		if (name === p) return true;
		if (!name.endsWith(p)) return false;
		const before = name.charAt(name.length - p.length - 1);
		return before === "_" || before === "-" || before === "." || before === "/" || before === ":";
	});
}
/** Narrow an unknown to a plain record. */
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
/** Read the `tool/call` payload defensively (merge-extensible event map). */
function callSlice(event) {
	if (event.type !== "tool/call") return null;
	const data = asRecord(event.data);
	if (data === null) return null;
	const { callId, name } = data;
	if (typeof callId !== "string" || typeof name !== "string") return null;
	return {
		callId,
		name,
		argumentsJson: typeof data["arguments"] === "string" ? data["arguments"] : "{}"
	};
}
/**
* Read the `tool/result` payload defensively. The correlating call id rides
* the result message's `source.callId` (observed rc.2 shape); a top-level
* `data.callId` or a `tool-result` block's `toolCallId` are accepted as
* fallbacks so shape drift degrades to a still-correlated point.
*/
function resultSlice(event) {
	if (event.type !== "tool/result") return null;
	const data = asRecord(event.data);
	if (data === null) return null;
	const message = data["message"];
	const source = asRecord(asRecord(message)?.["source"]);
	const blocks = asRecord(message)?.["content"];
	const firstBlock = Array.isArray(blocks) ? asRecord(blocks[0]) : null;
	const callId = typeof source?.["callId"] === "string" ? source["callId"] : typeof data["callId"] === "string" ? data["callId"] : typeof firstBlock?.["toolCallId"] === "string" ? firstBlock["toolCallId"] : null;
	if (callId === null) return null;
	return {
		callId,
		message
	};
}
/**
* Collect the text of a tool-result message: every string value found under a
* `text` key of a `{ type: 'text' }`-shaped node, joined in encounter order.
* Shapes vary across tool sources (first-party, MCP), so this walks instead of
* assuming one layout.
* @param value - the logged result message.
* @returns concatenated text, possibly empty.
*/
function collectResultText(value) {
	const parts = [];
	const walk = (node) => {
		if (typeof node === "string") return;
		if (Array.isArray(node)) {
			for (const item of node) walk(item);
			return;
		}
		const record = asRecord(node);
		if (record === null) return;
		if (typeof record["text"] === "string") parts.push(record["text"]);
		for (const [key, child] of Object.entries(record)) {
			if (key === "text") continue;
			walk(child);
		}
	};
	walk(value);
	return parts.join("\n");
}
/**
* Parse the first JSON object found in a result text. Evaluators reply with a
* JSON payload, sometimes wrapped in prose or fences.
* @param text - collected result text.
* @returns the parsed object, or null when none parses.
*/
function parseResultJson(text) {
	const trimmed = text.trim();
	const attempts = [trimmed];
	const first = trimmed.indexOf("{");
	const last = trimmed.lastIndexOf("}");
	if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1));
	for (const candidate of attempts) try {
		const record = asRecord(JSON.parse(candidate));
		if (record !== null) return record;
	} catch {}
	return null;
}
/** Numeric subset of `native_metrics`, capped so the wire stays small. */
function numericMetrics(value, cap = 12) {
	const record = asRecord(value);
	if (record === null) return void 0;
	const out = {};
	let count = 0;
	for (const [key, entry] of Object.entries(record)) {
		if (typeof entry !== "number" || !Number.isFinite(entry)) continue;
		out[key] = entry;
		count += 1;
		if (count >= cap) break;
	}
	return count > 0 ? out : void 0;
}
/** Fill one iteration point from a parsed evaluator payload. */
function fillFromPayload(point, payload) {
	if (typeof payload["evaluation_id"] === "string") point.evaluationId = payload["evaluation_id"];
	if (typeof payload["compiled"] === "boolean") point.compiled = payload["compiled"];
	if (typeof payload["correct"] === "boolean") point.correct = payload["correct"];
	const latency = payload["latency_ms"];
	if (typeof latency === "number" && Number.isFinite(latency)) point.latencyMs = latency;
	const metrics = numericMetrics(payload["native_metrics"]);
	if (metrics !== void 0) point.metrics = metrics;
	if (payload["reward_hack_detected"] === true) point.rewardHack = true;
	if (typeof payload["error"] === "string" && payload["error"].length > 0) point.error = payload["error"];
}
/**
* Project a session's events into the cockpit series.
* @param sessionId - session the events came from (echoed on the wire).
* @param events - the session log in seq order.
* @param config - tool-name routing.
* @returns the wire series (iterations/plans/profile marks/best index).
*/
function project(sessionId, events, config = DEFAULT_PROJECTION) {
	const iterations = [];
	const plans = [];
	const profileSeqs = [];
	const finalizedIds = /* @__PURE__ */ new Set();
	/** callId → pending bench iteration awaiting its result. */
	const pendingBench = /* @__PURE__ */ new Map();
	for (const event of events) {
		const call = callSlice(event);
		if (call !== null) {
			if (call.name === config.planTool) {
				const args = parseResultJson(call.argumentsJson);
				if (args !== null && typeof args["phase"] === "string" && typeof args["approach"] === "string") {
					const plan = {
						seq: event.seq,
						phase: args["phase"],
						approach: args["approach"]
					};
					if (typeof args["hypothesis"] === "string" && args["hypothesis"].length > 0) plan.hypothesis = args["hypothesis"];
					if (typeof args["next"] === "string" && args["next"].length > 0) plan.next = args["next"];
					plans.push(plan);
				}
				continue;
			}
			if (matchesTool(call.name, config.profileTools)) {
				profileSeqs.push(event.seq);
				continue;
			}
			if (matchesTool(call.name, config.finalizeTools)) {
				const id = parseResultJson(call.argumentsJson)?.["evaluation_id"];
				if (typeof id === "string") finalizedIds.add(id);
				continue;
			}
			if (matchesTool(call.name, config.benchTools)) {
				const point = {
					seq: event.seq,
					tool: call.name,
					pending: true
				};
				iterations.push(point);
				pendingBench.set(call.callId, point);
			}
			continue;
		}
		const result = resultSlice(event);
		if (result !== null) {
			const point = pendingBench.get(result.callId);
			if (point === void 0) continue;
			pendingBench.delete(result.callId);
			delete point.pending;
			const payload = parseResultJson(collectResultText(result.message));
			if (payload !== null) fillFromPayload(point, payload);
		}
	}
	for (const point of iterations) if (point.evaluationId !== void 0 && finalizedIds.has(point.evaluationId)) point.finalized = true;
	let bestIndex = null;
	for (let i = 0; i < iterations.length; i += 1) {
		const point = iterations[i];
		if (point === void 0) continue;
		if (point.correct !== true || point.rewardHack === true || point.error !== void 0) continue;
		if (point.latencyMs === void 0) continue;
		const best = bestIndex === null ? void 0 : iterations[bestIndex];
		if (best?.latencyMs === void 0 || point.latencyMs < best.latencyMs) bestIndex = i;
	}
	return {
		sessionId,
		updatedAt: Date.now(),
		iterations,
		plans,
		profileSeqs,
		bestIndex
	};
}
//#endregion
//#region src/loop.ts
/** A fresh disarmed state. */
function initialLoopState() {
	return {
		armed: false,
		budget: 0,
		round: 0,
		lastEvalCount: 0,
		noProgressRounds: 0,
		supervise: false
	};
}
/** Completed (non-pending) evaluations in a projected series. */
function completedEvals(series) {
	return series.iterations.filter((p) => p.pending !== true).length;
}
/**
* Decide continuation from the projected run state. Pure — the caller owns
* state mutation and delivery.
* @param series - current projection of the session log.
* @param state - loop state as of the previous checkpoint.
* @param maxNoProgressRounds - consecutive empty rounds tolerated before stopping.
* @returns the decision and the completed-evaluation count it was based on.
*/
function decideContinuation(series, state, maxNoProgressRounds) {
	const evalsDone = completedEvals(series);
	if (series.iterations.some((p) => p.finalized === true)) return {
		action: "stop",
		reason: "finalized",
		evalsDone
	};
	if (evalsDone >= state.budget) return {
		action: "stop",
		reason: "budget",
		evalsDone
	};
	if (state.round > 0 && evalsDone <= state.lastEvalCount && state.noProgressRounds + 1 >= maxNoProgressRounds) return {
		action: "stop",
		reason: "no-progress",
		evalsDone
	};
	return {
		action: "continue",
		evalsDone
	};
}
/** One line of the digest table handed to the supervisor. */
function digestRow(point, index, bestIndex) {
	const status = point.pending === true ? "pending" : point.rewardHack === true ? "REWARD-HACK" : point.error !== void 0 ? `error: ${point.error.slice(0, 80)}` : point.correct === true ? "ok" : "WRONG";
	const latency = point.latencyMs !== void 0 ? `${point.latencyMs}ms` : "—";
	const star = point.finalized === true ? " ★finalized" : "";
	const best = bestIndex === index ? " ←best" : "";
	return `#${String(index + 1)} ${point.evaluationId ?? "?"} ${latency} ${status}${star}${best}`;
}
/**
* Compact text digest of the run for the supervisor: budget state, recent
* plans, and the tail of the iteration table. Deliberately small — the
* supervisor reviews the run's shape, not the kernel source.
* @param series - current projection.
* @param state - loop state (budget/round).
* @param tail - iterations included from the end.
* @returns the digest text.
*/
function supervisorDigest(series, state, tail = 10) {
	const evalsDone = completedEvals(series);
	const lines = [`Budget: ${String(evalsDone)}/${String(state.budget)} evaluations used; continuation round ${String(state.round)}.`];
	const plans = series.plans.slice(-3);
	if (plans.length > 0) {
		lines.push("Recent plans (oldest first):");
		for (const plan of plans) lines.push(`- [${plan.phase}] ${plan.approach}${plan.hypothesis !== void 0 ? ` — ${plan.hypothesis}` : ""}`);
	} else lines.push("No cockpit_plan reports yet.");
	const from = Math.max(0, series.iterations.length - tail);
	lines.push(`Iterations ${String(from + 1)}..${String(series.iterations.length)}:`);
	for (let i = from; i < series.iterations.length; i += 1) {
		const point = series.iterations[i];
		if (point !== void 0) lines.push(digestRow(point, i, series.bestIndex));
	}
	return lines.join("\n");
}
/** System rubric for the supervisor model. */
const SUPERVISOR_SYSTEM = [
	"You supervise a kernel-optimization agent. You see a digest of its run: budget, its stated plans, and the evaluation table.",
	"Judge ONLY loop discipline, not kernel code:",
	"- correctness first: WRONG or REWARD-HACK rows are failures, not progress;",
	"- budget discipline: repeated evaluations of one idea without a stated hypothesis waste budget;",
	"- approach diversity: several consecutive failures of one family should trigger a family switch;",
	"- plan hygiene: plans should exist and match what the table shows;",
	"- finishing: near budget exhaustion the agent should finalize its best honest result.",
	"If the run looks healthy, reply exactly OK.",
	"Otherwise reply with at most 3 short imperative sentences of advice. No preamble, no code."
].join("\n");
/** Strip a supervisor reply to advice, or null when it approves or is empty. */
function adviceFromReply(reply) {
	const text = reply.trim();
	if (text.length === 0) return null;
	if (/^ok[.!]?$/i.test(text)) return null;
	return text.length > 600 ? `${text.slice(0, 600)}…` : text;
}
/**
* Continuation message body. The advice block, when present, is labeled as
* supervisor output so the primary model can weigh it as advisory input.
* @param round - continuation round being delivered (1-based).
* @param evalsDone - completed evaluations so far.
* @param budget - armed budget.
* @param advice - supervisor advice, if any.
* @returns the followup text.
*/
function continuationText(round, evalsDone, budget, advice) {
	const lines = [`[kernel-loop round ${String(round)}] ${String(evalsDone)}/${String(budget)} evaluations used.`];
	if (advice !== null) lines.push("", "Supervisor review (advisory, from the second model):", advice);
	lines.push("", "Continue optimizing per the original task: analyse the latest result, state the plan with cockpit_plan if it changed, improve solution.py, and evaluate again.", "If you are done or the remaining budget cannot beat the current best, call run_finalize with the evaluation_id you stand behind, then summarize.");
	return lines.join("\n");
}
//#endregion
//#region src/wire.ts
/** Route the Node half serves and the panel polls (query: `?sessionId=`). */
const SERIES_PATH = "/plugins/kernel-cockpit/series";
//#endregion
//#region src/index.ts
const name = "kernel-cockpit";
const inject = [
	"tools",
	"agents",
	"sessions"
];
/** Plugin id stamped on plugin-sourced messages. */
const PLUGIN_ID = "kernel-cockpit";
/** Delay between a logged turn end and the idle check that may continue. */
const SETTLE_DELAY_MS = 1200;
/** Resolve the projection routing from plugin config over defaults. */
function resolveProjection(config) {
	return {
		benchTools: config.benchTools ?? DEFAULT_PROJECTION.benchTools,
		profileTools: config.profileTools ?? DEFAULT_PROJECTION.profileTools,
		finalizeTools: config.finalizeTools ?? DEFAULT_PROJECTION.finalizeTools,
		planTool: DEFAULT_PROJECTION.planTool
	};
}
/**
* Mount the cockpit: model tools, kernel loop + supervisor commands, and the
* per-session series route the browser panel polls.
* @param ctx - plugin context.
* @param config - optional routing/loop/supervisor overrides.
*/
function apply(ctx, config = {}) {
	const projection = resolveProjection(config);
	const maxNoProgress = config.loop?.maxNoProgressRounds ?? 2;
	const defaultBudget = config.loop?.defaultBudget ?? 20;
	/** Per-session loop state; sessions without an entry never looped. */
	const loops = /* @__PURE__ */ new Map();
	const stateFor = (sessionId) => {
		let state = loops.get(sessionId);
		if (state === void 0) {
			state = initialLoopState();
			loops.set(sessionId, state);
		}
		return state;
	};
	ctx.tools.register(defineTool({
		name: "cockpit_plan",
		description: "Report your CURRENT kernel-optimization plan to the human cockpit panel. Call BEFORE starting a new approach and again whenever the plan changes, so the human can steer early instead of after a wasted iteration. Keep every field to one short line. phase: loop stage (e.g. explore / tune / verify / stuck). approach: the technique being tried (e.g. \"split-K over KV, BLOCK_H=8\"). hypothesis: why it should be faster. next: the immediate action.",
		parameters: {
			phase: {
				type: "string",
				required: true,
				description: "Loop stage: explore / tune / verify / stuck / done."
			},
			approach: {
				type: "string",
				required: true,
				description: "One-line description of the current technique."
			},
			hypothesis: {
				type: "string",
				description: "Why this should be faster (one line)."
			},
			next: {
				type: "string",
				description: "Immediate next action (one line)."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute: async (args) => {
			return `Plan recorded (${args.phase}): ${args.approach}`;
		}
	}));
	ctx.inject(["compaction"], (cctx) => {
		cctx.tools.register(defineTool({
			name: "self_compact",
			description: "Compact THIS session's older history into a summary now, keeping the recent tail. Use when you switch to a different optimization approach family and the accumulated tool output no longer pays rent, or when old exploration details stop being relevant. The full history stays in the durable session log; only the model-visible context shrinks. State what must survive in reason — it becomes part of the record.",
			parameters: { reason: {
				type: "string",
				required: true,
				description: "Why compaction is safe now and what must survive."
			} },
			output: {
				schema: { type: "string" },
				render: (_args, value) => [{
					type: "text",
					text: value
				}]
			},
			execute: async (args, exec) => {
				const agent = cctx.agents.currentInitiator();
				if (agent === void 0) throw new Error("self_compact requires an active agent turn");
				const result = await cctx.compaction.compactNow(agent, exec.signal);
				if (result === null) return "No compactable history yet — continue as is.";
				return `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens). Reason recorded: ${args.reason}`;
			}
		}));
	});
	ctx.inject(["commands", "llm"], (lctx) => {
		/** Pending settle timers, cleared with the plugin. */
		const timers = /* @__PURE__ */ new Set();
		lctx.effect(() => () => {
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
		}, "kernel-cockpit: loop timers");
		/** One supervisor review; any failure degrades to null advice. */
		const review = async (sessionId, state) => {
			const supervisor = config.supervisor;
			if (supervisor === void 0 || !state.supervise) return null;
			const session = lctx.sessions.get(SessionId(sessionId));
			if (session === void 0) return null;
			try {
				const digest = supervisorDigest(project(sessionId, session.events, projection), state);
				let reply = "";
				const stream = lctx.llm.stream({
					provider: supervisor.provider,
					model: supervisor.model,
					system: SUPERVISOR_SYSTEM,
					messages: [createUserMessage({
						content: [{
							type: "text",
							text: digest
						}],
						source: {
							kind: "plugin",
							plugin: PLUGIN_ID
						}
					})],
					...supervisor.temperature !== void 0 ? { temperature: supervisor.temperature } : {},
					maxTokens: supervisor.maxTokens ?? 400,
					signal: AbortSignal.timeout(6e4)
				});
				for await (const chunk of stream) if (chunk.type === "text-delta") reply += chunk.text;
				return adviceFromReply(reply);
			} catch {
				return null;
			}
		};
		/** Settle checkpoint: decide from projected run state, then re-drive. */
		const checkpoint = async (sessionId) => {
			const state = loops.get(sessionId);
			if (state === void 0 || !state.armed) return;
			const agent = lctx.agents.get(SessionId(sessionId));
			const session = lctx.sessions.get(SessionId(sessionId));
			if (agent === void 0 || session === void 0) {
				state.armed = false;
				state.stopReason = "stopped";
				return;
			}
			if (agent.status !== "idle") return;
			const decision = decideContinuation(project(sessionId, session.events, projection), state, maxNoProgress);
			if (decision.action === "stop") {
				state.armed = false;
				state.stopReason = decision.reason;
				return;
			}
			state.noProgressRounds = state.round > 0 && decision.evalsDone <= state.lastEvalCount ? state.noProgressRounds + 1 : 0;
			state.round += 1;
			state.lastEvalCount = decision.evalsDone;
			const advice = await review(sessionId, state);
			state.lastAdvice = advice ?? state.lastAdvice;
			if (lctx.agents.get(SessionId(sessionId)) !== agent || agent.status !== "idle") return;
			agent.followup(createUserMessage({
				content: [{
					type: "text",
					text: continuationText(state.round, decision.evalsDone, state.budget, advice)
				}],
				source: {
					kind: "plugin",
					plugin: PLUGIN_ID
				}
			}));
		};
		const scheduleCheckpoint = (sessionId, delayMs) => {
			const timer = setTimeout(() => {
				timers.delete(timer);
				checkpoint(sessionId);
			}, delayMs);
			timers.add(timer);
		};
		lctx.on("session/event", (session, event) => {
			if (event.type !== "turn/end") return;
			const state = loops.get(session.id);
			if (state === void 0 || !state.armed) return;
			scheduleCheckpoint(session.id, SETTLE_DELAY_MS);
		});
		lctx.on("agent/disposed", ({ agent }) => {
			loops.delete(agent.id);
		});
		lctx.commands.register({
			name: "kloop",
			description: "Kernel-opt loop: /kloop [budget] arms run-state-driven continuation (stops on finalize, budget exhaustion, or no progress); /kloop stop disarms; /kloop status reports.",
			input: { hint: "[budget] | stop | status" },
			handler: (invocation) => {
				const raw = invocation.rawInput.trim();
				const sessionId = invocation.agent.id;
				const state = stateFor(sessionId);
				if (raw === "stop") {
					if (!state.armed) return {
						kind: "error",
						text: "kernel loop is not armed."
					};
					state.armed = false;
					state.stopReason = "stopped";
					return {
						kind: "success",
						text: "Kernel loop stopped."
					};
				}
				if (raw === "status" || raw !== "" && !/^\d+$/.test(raw)) {
					const supervise = state.supervise ? "on" : "off";
					return {
						kind: "success",
						text: state.armed ? `armed: round ${String(state.round)}, budget ${String(state.budget)}, supervisor ${supervise}.` : `not armed${state.stopReason !== void 0 ? ` (last stop: ${state.stopReason})` : ""}; supervisor ${supervise}. Usage: /kloop [budget]`
					};
				}
				state.armed = true;
				state.budget = raw === "" ? defaultBudget : Number(raw);
				state.round = 0;
				state.lastEvalCount = 0;
				state.noProgressRounds = 0;
				delete state.stopReason;
				scheduleCheckpoint(sessionId, 10);
				return {
					kind: "success",
					text: `Kernel loop armed: budget ${String(state.budget)} evaluations, supervisor ${state.supervise ? "on" : "off"}. It continues the run whenever a turn settles unfinished; /kloop stop disarms.`
				};
			}
		});
		lctx.commands.register({
			name: "supervise",
			description: "Second-model supervisor: /supervise on|off toggles review at kernel-loop continuation points (requires supervisor {provider, model} in the kernel-cockpit plugin config).",
			input: { hint: "on | off | status" },
			handler: (invocation) => {
				const raw = invocation.rawInput.trim();
				const state = stateFor(invocation.agent.id);
				if (raw === "on") {
					if (config.supervisor === void 0) return {
						kind: "error",
						text: "No supervisor model configured. Add to the kernel-cockpit plugin config: supervisor: { provider: <route>, model: <id> } — a distinct route/model from the primary."
					};
					state.supervise = true;
					return {
						kind: "success",
						text: `Supervisor on (${config.supervisor.provider}/${config.supervisor.model}); reviews run at kernel-loop continuation points.`
					};
				}
				if (raw === "off") {
					state.supervise = false;
					return {
						kind: "success",
						text: "Supervisor off."
					};
				}
				return {
					kind: "success",
					text: `supervisor ${state.supervise ? "on" : "off"}; ${config.supervisor !== void 0 ? `configured: ${config.supervisor.provider}/${config.supervisor.model}` : "not configured"}.`
				};
			}
		});
	});
	ctx.inject(["webServer"], (wctx) => {
		wctx.effect(() => wctx.webServer.register({
			kind: "exact",
			path: SERIES_PATH,
			handler: (req, res) => {
				const respond = (status, payload) => {
					res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify(payload));
				};
				try {
					const rawId = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("sessionId") ?? "";
					if (rawId === "") {
						respond(400, { error: "sessionId query parameter required" });
						return;
					}
					const session = wctx.sessions.get(SessionId(rawId));
					if (session === void 0) {
						respond(404, { error: "unknown session" });
						return;
					}
					const series = project(rawId, session.events, projection);
					const state = loops.get(rawId);
					const control = {
						loop: {
							armed: state?.armed ?? false,
							budget: state?.budget ?? 0,
							round: state?.round ?? 0,
							evalsDone: completedEvals(series),
							...state?.stopReason !== void 0 ? { stopReason: state.stopReason } : {}
						},
						supervisor: {
							enabled: state?.supervise ?? false,
							configured: config.supervisor !== void 0,
							...state?.lastAdvice !== void 0 ? { lastAdvice: state.lastAdvice } : {}
						}
					};
					respond(200, {
						...series,
						control
					});
				} catch (error) {
					respond(500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		}), "kernel-cockpit: series route");
	});
}
//#endregion
export { apply, inject, name };
