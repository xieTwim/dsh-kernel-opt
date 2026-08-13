import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/wire.ts
/**
* Whether two logged paths plausibly address the same file (exact, or one is
* the other's path suffix). Shared protocol helper: the projection matches
* changes/finalizes with it and the panel matches replay coverage.
*/
function samePath(a, b) {
	return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}
/** Route the Node half serves and the panel polls (query: `?sessionId=`). */
const SERIES_PATH = "/plugins/kernel-opt/series";
/**
* Control route. POST `{ sessionId, action, budget?, provider?, model? }`
* with action one of `loop-arm` / `loop-stop` / `supervise-on` /
* `supervise-off` / `supervise-use` (both provider+model set the session
* override; both empty resets to config). GET `?sessionId=` returns the same
* fresh {@link WireControl} without acting — the lightweight poll for the
* chat-side loop affordances. The slash commands remain the scriptable twin
* of the same state.
*/
const CONTROL_PATH = "/plugins/kernel-opt/control";
/** Models route (GET): the {@link WireModels} catalog for the picker. */
const MODELS_PATH = "/plugins/kernel-opt/models";
/**
* Line the Node half writes into a `kernel_finalize` tool result naming the
* command it replayed; the projection reads it back as the replay point's
* provenance.
*/
const REPLAY_LINE_PREFIX = "[replay] ";
/** First-line prefix of a continuation message (`round N` follows). */
const LOOP_LINE_PREFIX = "[kernel-loop round ";
/** First-line prefix of the wrap-up message. */
const WRAPUP_LINE_PREFIX = "[kernel-loop wrap-up]";
/** Header line introducing a supervisor advice block. */
const REVIEW_HEADER = "Supervisor review (advisory, from the second model):";
/** Whole line recording that the supervisor reviewed and approved. */
const REVIEW_OK_LINE = "Supervisor review: OK.";
/** Start of the fixed trailer paragraph (terminates the advice block). */
const CONTINUE_TRAILER = "Continue optimizing per the original task";
//#endregion
//#region src/projection.ts
/** Defaults cover any `kernel_evaluate`-named evaluator (MCP prefixes match as suffixes) plus the host's tool-fs pair and shell. */
const DEFAULT_PROJECTION = {
	benchTools: ["kernel_evaluate"],
	profileTools: ["kernel_profile"],
	finalizeTools: ["run_finalize", "kernel_finalize"],
	planTool: "kernel_plan",
	changeTools: ["write", "edit"],
	shellTools: ["bash"]
};
/**
* Whether a logged tool name matches a configured name: exact, or as a suffix
* behind a separator (MCP registrations may prefix the server name, e.g.
* `myeval__kernel_evaluate`).
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
/**
* Extract the first balanced JSON object from a text fragment (string- and
* escape-aware), tolerating trailing garbage after the object. Returns null
* when nothing balanced parses.
*/
function extractJsonObject(text) {
	const bounded = text.length > 2e4 ? text.slice(0, 2e4) : text;
	const start = bounded.indexOf("{");
	if (start < 0) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < bounded.length; i += 1) {
		const ch = bounded[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (ch === "\\") escaped = true;
			else if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") inString = true;
		else if (ch === "{") depth += 1;
		else if (ch === "}") {
			depth -= 1;
			if (depth === 0) try {
				return asRecord(JSON.parse(bounded.slice(start, i + 1)));
			} catch {
				return null;
			}
		}
	}
	return null;
}
/**
* Contract trailer payloads in a shell result text: one per line whose
* trimmed form STARTS with {@link EVAL_TRAILER_PREFIX} (mid-line mentions —
* prose, docs quoted by `cat` — do not qualify). Trailing garbage after the
* JSON object is tolerated.
*/
function trailerPayloads(text) {
	const out = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trimStart();
		if (!trimmed.startsWith("KERNEL_EVAL=")) continue;
		const payload = extractJsonObject(trimmed.slice(12));
		if (payload !== null) out.push(payload);
	}
	return out;
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
/**
* Speedup vs the reference kernel, from the evaluator's own numbers only: an
* explicit `speedup` metric wins; else a `ref_runtime_ms` metric divided by
* the measured latency. Returns undefined when the evaluator reported neither.
*/
function speedupFrom(metrics, latencyMs) {
	if (metrics === void 0) return void 0;
	for (const [key, value] of Object.entries(metrics)) if ((key === "speedup" || key.endsWith(".speedup")) && value > 0) return value;
	if (latencyMs === void 0 || latencyMs <= 0) return void 0;
	for (const [key, value] of Object.entries(metrics)) if ((key === "ref_runtime_ms" || key.endsWith(".ref_runtime_ms")) && value > 0) return value / latencyMs;
}
/** String entries of an unknown array, each capped, the list capped. */
function stringList(value, entryCap = 300, listCap = 8) {
	if (!Array.isArray(value)) return void 0;
	const out = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		out.push(entry.length > entryCap ? `${entry.slice(0, entryCap)}…` : entry);
		if (out.length >= listCap) break;
	}
	return out.length > 0 ? out : void 0;
}
/**
* Fill one iteration point from a parsed evaluator payload.
* `includeEvaluatorId` is false for trailer payloads: on the self-reported
* channel identity is the log seq — an agent-relayed id must not become one.
*/
function fillFromPayload(point, payload, includeEvaluatorId = true) {
	if (includeEvaluatorId && typeof payload["evaluation_id"] === "string") point.evaluationId = payload["evaluation_id"];
	if (typeof payload["compiled"] === "boolean") point.compiled = payload["compiled"];
	if (typeof payload["correct"] === "boolean") point.correct = payload["correct"];
	const latency = payload["latency_ms"];
	if (typeof latency === "number" && Number.isFinite(latency)) point.latencyMs = latency;
	const metrics = numericMetrics(payload["native_metrics"]);
	if (metrics !== void 0) point.metrics = metrics;
	const speedup = speedupFrom(metrics, point.latencyMs);
	if (speedup !== void 0) point.speedup = speedup;
	if (payload["reward_hack_detected"] === true) point.rewardHack = true;
	if (typeof payload["error"] === "string" && payload["error"].length > 0) point.error = payload["error"];
	const blocking = stringList(payload["blocking"]);
	if (blocking !== void 0) point.blocking = blocking;
	const advisory = stringList(payload["advisory"]);
	if (advisory !== void 0) point.advisory = advisory;
	const notMeasured = stringList(payload["not_measured"]);
	if (notMeasured !== void 0) point.notMeasured = notMeasured;
	if (payload["evaluator_failed"] === true) point.evaluatorFailed = true;
}
/** Wire caps for change payloads (a kernel file is a few KB; keep polls sane). */
const WRITE_CONTENT_CAP = 12e3;
const EDIT_TEXT_CAP = 3e3;
/** Cap one text field, marking the change truncated when it cut. */
function capText(change, text, cap) {
	if (text.length <= cap) return text;
	change.truncated = true;
	return `${text.slice(0, cap)}…`;
}
/** Command-line provenance cap on the wire. */
const COMMAND_CAP = 300;
/** Cap a provenance command line. */
function capCommand(command) {
	return command.length > COMMAND_CAP ? `${command.slice(0, COMMAND_CAP)}…` : command;
}
/**
* Build an iteration point from one contract trailer payload, or null when
* the payload misses the contract's required fields (`artifact` + boolean
* `correct`) — near-misses drop rather than render as noise rows.
*/
function trailerPoint(seq, tool, channel, payload) {
	const artifact = payload["artifact"] ?? payload["artifact_path"];
	if (typeof artifact !== "string" || artifact.length === 0) return null;
	if (typeof payload["correct"] !== "boolean") return null;
	const point = {
		seq,
		tool,
		channel
	};
	point.artifactPath = artifact;
	const subset = payload["workload_indices"];
	if (Array.isArray(subset) && subset.every((n) => typeof n === "number") && subset.length > 0) point.workloadSubset = subset;
	fillFromPayload(point, payload, false);
	return point;
}
/** Provenance command named by a `[replay] ` line, when present. */
function replayCommand(text) {
	for (const line of text.split("\n")) {
		const trimmed = line.trimStart();
		if (trimmed.startsWith("[replay] ")) {
			const command = trimmed.slice(9).trim();
			if (command.length > 0) return capCommand(command);
		}
	}
}
/**
* Read a structured file-change call (`write` / `edit` arg shapes) into a
* pending change record. Returns the target path alongside so the caller can
* match it against the next evaluation's artifact.
*/
function changeSlice(call, seq) {
	const args = parseResultJson(call.argumentsJson);
	const path = args?.["file_path"];
	if (args === null || typeof path !== "string" || path.length === 0) return null;
	const content = args["content"];
	if (typeof content === "string") {
		const change = {
			seq,
			tool: call.name,
			kind: "write"
		};
		change.content = capText(change, content, WRITE_CONTENT_CAP);
		return {
			path,
			change
		};
	}
	const oldText = args["old_string"];
	const newText = args["new_string"];
	if (typeof oldText === "string" && typeof newText === "string") {
		const change = {
			seq,
			tool: call.name,
			kind: "edit"
		};
		change.oldText = capText(change, oldText, EDIT_TEXT_CAP);
		change.newText = capText(change, newText, EDIT_TEXT_CAP);
		if (args["replace_all"] === true) change.replaceAll = true;
		return {
			path,
			change
		};
	}
	return null;
}
/** Plugin id whose `user/message` events carry the loop protocol texts. */
const LOOP_PLUGIN_ID = "kernel-opt";
/**
* Whether the log carries a direct human prompt: a `user/message` whose
* source kind is `'user'` (plugin injections — including the loop's own
* continuations — never count). The loop's arming gate: a loop started over
* a session with no human task has nothing to continue, and telling the
* model to "continue the original task" anyway primes it to invent one from
* ambient filesystem state instead of asking.
*/
function hasUserTask(events) {
	return events.some((event) => {
		if (event.type !== "user/message") return false;
		const data = asRecord(event.data);
		if (data === null) return false;
		return asRecord((asRecord(data["message"]) ?? data)["source"])?.["kind"] === "user";
	});
}
/**
* Parse a kernel-loop continuation/wrap-up message back out of a
* `user/message` event. The message data is the logged UserMessage (a
* `message` wrapper is accepted against shape drift); only plugin-sourced
* messages carrying the loop's first-line prefixes qualify.
*/
function roundSlice(event) {
	if (event.type !== "user/message") return null;
	const data = asRecord(event.data);
	if (data === null) return null;
	const message = asRecord(data["message"]) ?? data;
	const source = asRecord(message["source"]);
	if (source?.["kind"] !== "plugin" || source["plugin"] !== LOOP_PLUGIN_ID) return null;
	const text = collectResultText(message["content"]);
	const wrapUp = text.startsWith(WRAPUP_LINE_PREFIX);
	if (!wrapUp && !text.startsWith("[kernel-loop round ")) return null;
	const round = { seq: event.seq };
	if (wrapUp) round.wrapUp = true;
	const counters = /(\d+)\/(\d+) evaluations used/.exec(text);
	if (counters !== null) {
		round.evalsUsed = Number(counters[1]);
		round.budget = Number(counters[2]);
	}
	if (!wrapUp) {
		const num = /^\[kernel-loop round (\d+)\]/.exec(text);
		if (num !== null) round.round = Number(num[1]);
	}
	if (text.includes("Supervisor review: OK.")) round.review = "ok";
	else {
		const headerAt = text.indexOf(REVIEW_HEADER);
		if (headerAt >= 0) {
			const rest = text.slice(headerAt + 52);
			const trailerAt = rest.indexOf(CONTINUE_TRAILER);
			const advice = (trailerAt >= 0 ? rest.slice(0, trailerAt) : rest).trim();
			if (advice.length > 0) round.review = advice;
		}
	}
	return round;
}
/**
* Project a session's events into the panel series.
* @param sessionId - session the events came from (echoed on the wire).
* @param events - the session log in seq order.
* @param config - tool-name routing.
* @returns the wire series (iterations/plans/profile marks/best index).
*/
function project(sessionId, events, config = DEFAULT_PROJECTION) {
	const iterations = [];
	const plans = [];
	const profileSeqs = [];
	const rounds = [];
	const finalizedIds = /* @__PURE__ */ new Set();
	/** Artifacts named by finalize calls (`artifact_path`), best point gets ⚑. */
	const finalizedArtifacts = [];
	/** callId → pending bench iteration awaiting its result. */
	const pendingBench = /* @__PURE__ */ new Map();
	/** callId → shell-call provenance awaiting its result (trailer scan). */
	const pendingShell = /* @__PURE__ */ new Map();
	/** callId → finalize call awaiting its result (a replay trailer may ride it). */
	const pendingFinalize = /* @__PURE__ */ new Map();
	/** Structured file changes since the previous bench call, any path. */
	let pendingChanges = [];
	for (const event of events) {
		const round = roundSlice(event);
		if (round !== null) {
			rounds.push(round);
			continue;
		}
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
				const args = parseResultJson(call.argumentsJson);
				const id = args?.["evaluation_id"];
				if (typeof id === "string") finalizedIds.add(id);
				const artifactRaw = args?.["artifact_path"] ?? args?.["artifact"];
				if (typeof artifactRaw === "string" && artifactRaw.length > 0) finalizedArtifacts.push(artifactRaw);
				pendingFinalize.set(call.callId, { name: call.name });
				continue;
			}
			if (matchesTool(call.name, config.changeTools)) {
				const change = changeSlice(call, event.seq);
				if (change !== null) pendingChanges.push(change);
				continue;
			}
			if (matchesTool(call.name, config.benchTools)) {
				const point = {
					seq: event.seq,
					tool: call.name,
					pending: true
				};
				const args = parseResultJson(call.argumentsJson);
				const artifactPath = args?.["artifact_path"];
				if (typeof artifactPath === "string" && artifactPath.length > 0) {
					point.artifactPath = artifactPath;
					const matched = pendingChanges.filter((entry) => samePath(entry.path, artifactPath)).map((entry) => entry.change).slice(-8);
					if (matched.length > 0) point.changes = matched;
				}
				const subset = args?.["workload_indices"];
				if (Array.isArray(subset) && subset.every((n) => typeof n === "number")) {
					if (subset.length > 0) point.workloadSubset = subset;
				}
				pendingChanges = [];
				iterations.push(point);
				pendingBench.set(call.callId, point);
			} else if (matchesTool(call.name, config.shellTools)) {
				const command = parseResultJson(call.argumentsJson)?.["command"];
				pendingShell.set(call.callId, {
					name: call.name,
					...typeof command === "string" && command.length > 0 ? { command: capCommand(command) } : {}
				});
			}
			continue;
		}
		const result = resultSlice(event);
		if (result !== null) {
			const benchPoint = pendingBench.get(result.callId);
			if (benchPoint !== void 0) {
				pendingBench.delete(result.callId);
				delete benchPoint.pending;
				const payload = parseResultJson(collectResultText(result.message));
				if (payload !== null) fillFromPayload(benchPoint, payload);
				continue;
			}
			const finalize = pendingFinalize.get(result.callId);
			if (finalize !== void 0) {
				pendingFinalize.delete(result.callId);
				const text = collectResultText(result.message);
				if (text.includes("KERNEL_EVAL=")) {
					const command = replayCommand(text);
					for (const payload of trailerPayloads(text)) {
						const point = trailerPoint(event.seq, finalize.name, "replay", payload);
						if (point === null) continue;
						point.finalized = true;
						if (command !== void 0) point.command = command;
						iterations.push(point);
					}
				}
				continue;
			}
			const shell = pendingShell.get(result.callId);
			if (shell !== void 0) {
				pendingShell.delete(result.callId);
				const text = collectResultText(result.message);
				if (!text.includes("KERNEL_EVAL=")) continue;
				let consumed = false;
				for (const payload of trailerPayloads(text)) {
					const point = trailerPoint(event.seq, shell.name, "shell", payload);
					if (point === null) continue;
					if (shell.command !== void 0) point.command = shell.command;
					const artifact = point.artifactPath;
					if (artifact !== void 0) {
						const matched = pendingChanges.filter((entry) => samePath(entry.path, artifact)).map((entry) => entry.change).slice(-8);
						if (matched.length > 0) point.changes = matched;
					}
					iterations.push(point);
					consumed = true;
				}
				if (consumed) pendingChanges = [];
			}
		}
	}
	for (const point of iterations) if (point.evaluationId !== void 0 && finalizedIds.has(point.evaluationId)) point.finalized = true;
	for (const artifact of finalizedArtifacts) {
		let best;
		for (const point of iterations) {
			if (point.channel === "replay") continue;
			if (point.artifactPath === void 0 || !samePath(point.artifactPath, artifact)) continue;
			if (point.correct !== true || point.rewardHack === true || point.error !== void 0) continue;
			if (point.latencyMs === void 0) continue;
			if (best?.latencyMs === void 0 || point.latencyMs < best.latencyMs) best = point;
		}
		if (best !== void 0) best.finalized = true;
	}
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
		rounds,
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
* Completed evaluations since the best honest measurement — the run's
* stagnation streak. All completed evaluations count when no best exists yet.
*/
function stagnationCount(series) {
	let count = 0;
	for (let i = series.iterations.length - 1; i >= 0; i -= 1) {
		if (series.bestIndex !== null && i <= series.bestIndex) break;
		const point = series.iterations[i];
		if (point !== void 0 && point.pending !== true) count += 1;
	}
	return count;
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
		action: "wrap-up",
		reason: "budget",
		evalsDone
	};
	if (state.round > 0 && evalsDone <= state.lastEvalCount && state.noProgressRounds + 1 >= maxNoProgressRounds) return {
		action: "wrap-up",
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
	const channel = point.channel !== void 0 ? ` [${point.channel}]` : "";
	const command = point.command !== void 0 ? ` cmd:"${point.command.length > 60 ? `${point.command.slice(0, 60)}…` : point.command}"` : "";
	return `#${String(index + 1)} ${point.evaluationId ?? "?"} ${latency} ${status}${star}${best}${channel}${command}`;
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
	const stagnant = stagnationCount(series);
	if (stagnant >= 3) lines.push(`Stagnation: ${String(stagnant)} evaluations since the last improvement.`);
	const shellCount = series.iterations.filter((p) => p.channel === "shell").length;
	if (shellCount > 0) lines.push(`Provenance: ${String(shellCount)}/${String(series.iterations.length)} evaluations are self-reported (parsed from agent-run shell output; cmd shown per row). A row whose cmd is not a benchmark invocation is fabricated.`);
	const plans = series.plans.slice(-3);
	if (plans.length > 0) {
		lines.push("Recent plans (oldest first):");
		for (const plan of plans) lines.push(`- [${plan.phase}] ${plan.approach}${plan.hypothesis !== void 0 ? ` — ${plan.hypothesis}` : ""}`);
	} else lines.push("No kernel_plan reports yet.");
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
	"- provenance: on [shell] rows the trajectory is self-reported — judge whether each cmd is a real benchmark invocation and whether the numbers move like real measurements;",
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
* supervisor output so the primary model can weigh it as advisory input; a
* review that approved is recorded as one OK line. Both anchors are parsed
* back out of the log by the projection (supervision history), so the text
* layout here is protocol, not prose.
* @param round - continuation round being delivered (1-based).
* @param evalsDone - completed evaluations so far.
* @param budget - armed budget.
* @param advice - supervisor advice, if any.
* @param reviewedOk - a review ran and approved (ignored when advice given).
* @param stagnant - completed evaluations since the last improvement (a
*   re-assessment nudge rides along from 3 — data plus a suggestion, never an
*   order; the agent owns its policy).
* @param finalizeHint - finalize tool name(s) to name in the closing line.
* @returns the followup text.
*/
function continuationText(round, evalsDone, budget, advice, reviewedOk = false, stagnant = 0, finalizeHint = "run_finalize / kernel_finalize") {
	const lines = [`${LOOP_LINE_PREFIX}${String(round)}] ${String(evalsDone)}/${String(budget)} evaluations used.`];
	if (stagnant >= 3) lines.push(`Note: ${String(stagnant)} evaluations since the last improvement — consider re-profiling or switching approach family before spending more budget on the current line.`);
	if (advice !== null) lines.push("", REVIEW_HEADER, advice);
	else if (reviewedOk) lines.push("", REVIEW_OK_LINE);
	lines.push("", `${CONTINUE_TRAILER}: analyse the latest result, state the plan with kernel_plan if it changed, improve the kernel, and evaluate again.`, `If you are done or the remaining budget cannot beat the current best, finalize the result you stand behind (${finalizeHint}), then summarize.`);
	return lines.join("\n");
}
/**
* Wrap-up message body: the loop's one closing delivery before it disarms on
* budget exhaustion or stalling. Asks for a finalize of the best honest
* result — never for new optimization work.
* @param evalsDone - completed evaluations at the stop decision.
* @param budget - armed budget.
* @param reason - why the loop is ending.
* @param finalizeHint - finalize tool name(s) to name.
* @returns the followup text.
*/
function wrapUpText(evalsDone, budget, reason, finalizeHint = "run_finalize / kernel_finalize") {
	return [
		`${WRAPUP_LINE_PREFIX} ${String(evalsDone)}/${String(budget)} evaluations used; stopping (${reason}).`,
		"",
		"The kernel loop is ending — do not start new optimization work.",
		`If an honest best result exists, finalize it now (${finalizeHint}; pass the evaluation_id from your evaluator, or the artifact path for kernel_finalize).`,
		"Restore the best artifact verbatim first if a later edit regressed it.",
		"Then summarize the run: best result, what worked, what failed, and what a future attempt should try first."
	].join("\n");
}
//#endregion
//#region src/index.ts
const name = "kernel-opt";
const inject = [
	"tools",
	"agents",
	"sessions"
];
/** Plugin id stamped on plugin-sourced messages. */
const PLUGIN_ID = "kernel-opt";
/** Delay between a logged turn end and the idle check that may continue. */
const SETTLE_DELAY_MS = 1200;
/** Resolve the projection routing from plugin config over defaults. */
function resolveProjection(config) {
	return {
		benchTools: config.benchTools ?? DEFAULT_PROJECTION.benchTools,
		profileTools: config.profileTools ?? DEFAULT_PROJECTION.profileTools,
		finalizeTools: config.finalizeTools ?? DEFAULT_PROJECTION.finalizeTools,
		changeTools: config.changeTools ?? DEFAULT_PROJECTION.changeTools,
		shellTools: config.shellTools ?? DEFAULT_PROJECTION.shellTools,
		planTool: DEFAULT_PROJECTION.planTool
	};
}
/** Absolute path of the bundled preset directory (repo/package layout). */
function bundledPresetDir() {
	return join(dirname(fileURLToPath(import.meta.url)), "../preset/kernel-opt");
}
/** Expand a leading `~/` the way the preset roots document it. */
function expandHome(path) {
	return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}
/** Run one recorded benchmark command (`bash -c`); resolves, never throws. */
function runReplay(command, cwd, timeoutMs, signal) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn("bash", ["-c", command], {
				cwd,
				timeout: timeoutMs,
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			resolve({
				output: "",
				exit: null,
				failure: error instanceof Error ? error.message : String(error)
			});
			return;
		}
		const chunks = [];
		let size = 0;
		const take = (chunk) => {
			if (size > 2e5) return;
			size += chunk.length;
			chunks.push(chunk.toString("utf8"));
		};
		child.stdout?.on("data", take);
		child.stderr?.on("data", take);
		child.on("error", (error) => {
			resolve({
				output: chunks.join(""),
				exit: null,
				failure: error.message
			});
		});
		child.on("close", (code, killSignal) => {
			resolve({
				output: chunks.join(""),
				exit: code,
				...killSignal !== null ? { failure: `terminated by ${killSignal}` } : {}
			});
		});
	});
}
/** Cap replay output for the tool result, keeping the tail (trailer lives there). */
function capReplayOutput(output, headCap = 2e3, tailCap = 1e4) {
	if (output.length <= headCap + tailCap) return output;
	return `${output.slice(0, headCap)}\n…[replay output trimmed]…\n${output.slice(output.length - tailCap)}`;
}
/** Read and parse a small JSON request body; null on any shape/size problem. */
function readJsonBody(req, maxBytes = 16384) {
	return new Promise((resolve) => {
		const chunks = [];
		let size = 0;
		let settled = false;
		const done = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > maxBytes) {
				done(null);
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			try {
				const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				done(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null);
			} catch {
				done(null);
			}
		});
		req.on("error", () => {
			done(null);
		});
	});
}
/**
* Mount the plugin: model tools, kernel loop + supervisor commands, and the
* per-session series route the browser panel polls.
* @param ctx - plugin context.
* @param config - optional routing/loop/supervisor overrides.
*/
function apply(ctx, config = {}) {
	const projection = resolveProjection(config);
	const maxNoProgress = config.loop?.maxNoProgressRounds ?? 2;
	const defaultBudget = config.loop?.defaultBudget ?? 20;
	const finalizeHint = projection.finalizeTools.join(" / ");
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
	/**
	* Loop-machinery face shared with the control route. `arm` exists exactly
	* while the commands/llm composition is live; the route degrades to an
	* explicit 503 instead of arming a loop nothing would drive.
	*/
	const bridge = {};
	/**
	* Disarm a session's loop by human decision (no wrap-up round), and abort
	* the in-flight turn: a human pressing stop means stop NOW, not "after the
	* model finishes what it is doing". Queued human messages survive the
	* cancel; an idle agent makes it a no-op.
	*/
	const stopLoop = (sessionId) => {
		const state = loops.get(sessionId);
		if (state === void 0 || !state.armed) return false;
		state.armed = false;
		state.stopReason = "stopped";
		ctx.agents.get(SessionId(sessionId))?.cancel({ kind: "user" }, { keepInbox: true });
		return true;
	};
	/** Arming-gate refusal text, shared by /kloop and the control route. */
	const NEEDS_TASK = "The kernel loop needs a task first: tell the agent which kernel to optimize and how to evaluate it, then arm the loop.";
	/**
	* The supervisor route reviews would use for a session: the session
	* override wins, plugin config is the fallback, absent means unconfigured.
	*/
	const effectiveSupervisor = (state) => {
		if (state?.supervisorOverride !== void 0) return {
			...state.supervisorOverride,
			source: "session"
		};
		if (config.supervisor !== void 0) return {
			provider: config.supervisor.provider,
			model: config.supervisor.model,
			source: "config"
		};
	};
	/** Toggle supervision; returns an error string when the gate fails. */
	const setSupervise = (sessionId, enabled) => {
		const state = stateFor(sessionId);
		if (enabled && effectiveSupervisor(state) === void 0) return "No supervisor model configured. Pick one (/supervise use <provider>/<model>, or the panel picker), or add to the kernel-opt plugin config: supervisor: { provider: <route>, model: <id> } — a distinct route/model from the primary.";
		state.supervise = enabled;
		return null;
	};
	ctx.tools.register(defineTool({
		name: "kernel_plan",
		description: "Report your CURRENT kernel-optimization plan to the human evaluation panel. Call BEFORE starting a new approach and again whenever the plan changes, so the human can steer early instead of after a wasted iteration. Keep every field to one short line. phase: loop stage (e.g. explore / tune / verify / stuck). approach: the technique being tried (e.g. \"split-K over KV, BLOCK_H=8\"). hypothesis: why it should be faster. next: the immediate action.",
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
	ctx.tools.register(defineTool({
		name: "kernel_finalize",
		description: "Record your FINAL kernel choice by artifact path (for evaluation pipelines without evaluator-issued ids; with an id-issuing evaluator call its own finalize instead). Call once, at the end, with the artifact you stand behind — restore it verbatim first if a later edit regressed it. When the best measurement for that artifact is self-reported, the plugin replays the recorded benchmark command once and appends the output as the verified final measurement.",
		parameters: {
			artifact_path: {
				type: "string",
				required: true,
				description: "Path of the final artifact, as printed in its KERNEL_EVAL trailer."
			},
			note: {
				type: "string",
				description: "One-line closing note (optional)."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute: async (args, exec) => {
			const ack = `Finalize recorded for ${args.artifact_path}.${args.note !== void 0 ? ` Note: ${args.note}` : ""}`;
			const agent = ctx.agents.currentInitiator();
			if (agent === void 0) return `${ack} (no active agent turn; not replayed)`;
			const session = ctx.sessions.get(SessionId(agent.id));
			if (session === void 0) return `${ack} (session not found; not replayed)`;
			if (config.replay?.enabled === false) return `${ack} Replay disabled by config; the final number stays self-reported.`;
			const series = project(agent.id, session.events, projection);
			let best;
			for (const point of series.iterations) {
				if (point.channel !== "shell") continue;
				if (point.artifactPath === void 0 || !samePath(point.artifactPath, args.artifact_path)) continue;
				if (point.correct !== true || point.rewardHack === true || point.error !== void 0) continue;
				if (point.latencyMs === void 0) continue;
				if (best?.latencyMs === void 0 || point.latencyMs < best.latencyMs) best = point;
			}
			if (best === void 0) return `${ack} No self-reported measurement found for this artifact — nothing to replay (tool-channel measurements are already verified).`;
			const command = best.command;
			if (command === void 0 || command.endsWith("…")) return `${ack} Recorded command ${command === void 0 ? "unavailable" : "truncated in the projection"}; not replayed.`;
			const cwd = session.header.cwd;
			if (typeof cwd !== "string" || cwd.length === 0) return `${ack} Session working directory unknown; not replayed.`;
			const outcome = await runReplay(command, cwd, (config.replay?.timeoutSec ?? 900) * 1e3, exec.signal);
			const lines = [ack, `${REPLAY_LINE_PREFIX}${command}`];
			if (outcome.failure !== void 0) lines.push(`Replay failed: ${outcome.failure}. The final number stays self-reported.`);
			lines.push("--- replay output ---", capReplayOutput(outcome.output));
			if (outcome.exit !== null) lines.push(`[replay exit ${String(outcome.exit)}]`);
			return lines.join("\n");
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
		}, "kernel-opt: loop timers");
		/** One supervisor review; any failure degrades to unreviewed/no advice. */
		const review = async (sessionId, state) => {
			const supervisor = effectiveSupervisor(state);
			if (supervisor === void 0 || !state.supervise) return {
				advice: null,
				reviewed: false
			};
			const session = lctx.sessions.get(SessionId(sessionId));
			if (session === void 0) return {
				advice: null,
				reviewed: false
			};
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
					...config.supervisor?.temperature !== void 0 ? { temperature: config.supervisor.temperature } : {},
					maxTokens: config.supervisor?.maxTokens ?? 400,
					signal: AbortSignal.timeout(6e4)
				});
				for await (const chunk of stream) if (chunk.type === "text-delta") reply += chunk.text;
				return {
					advice: adviceFromReply(reply),
					reviewed: true
				};
			} catch {
				return {
					advice: null,
					reviewed: false
				};
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
			const series = project(sessionId, session.events, projection);
			const decision = decideContinuation(series, state, maxNoProgress);
			if (decision.action === "stop") {
				state.armed = false;
				state.stopReason = decision.reason;
				return;
			}
			if (decision.action === "wrap-up") {
				state.armed = false;
				state.stopReason = decision.reason;
				agent.followup(createUserMessage({
					content: [{
						type: "text",
						text: wrapUpText(decision.evalsDone, state.budget, decision.reason, finalizeHint)
					}],
					source: {
						kind: "plugin",
						plugin: PLUGIN_ID
					}
				}));
				return;
			}
			state.noProgressRounds = state.round > 0 && decision.evalsDone <= state.lastEvalCount ? state.noProgressRounds + 1 : 0;
			state.round += 1;
			state.lastEvalCount = decision.evalsDone;
			const { advice, reviewed } = await review(sessionId, state);
			state.lastAdvice = advice ?? state.lastAdvice;
			if (!state.armed || lctx.agents.get(SessionId(sessionId)) !== agent || agent.status !== "idle") return;
			agent.followup(createUserMessage({
				content: [{
					type: "text",
					text: continuationText(state.round, decision.evalsDone, state.budget, advice, reviewed && advice === null, stagnationCount(series), finalizeHint)
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
		/** Arm (or re-arm) the loop for a session; shared by /kloop and the control route. */
		const armLoop = (sessionId, budget) => {
			const state = stateFor(sessionId);
			state.armed = true;
			state.budget = budget;
			state.round = 0;
			state.lastEvalCount = 0;
			state.noProgressRounds = 0;
			delete state.stopReason;
			scheduleCheckpoint(sessionId, 10);
		};
		bridge.arm = armLoop;
		lctx.effect(() => () => {
			delete bridge.arm;
		}, "kernel-opt: loop bridge");
		lctx.on("session/event", (session, event) => {
			if (event.type !== "turn/end") return;
			const state = loops.get(session.id);
			if (state === void 0 || !state.armed) return;
			if (event.data.reason.kind === "aborted") {
				state.armed = false;
				state.stopReason = "stopped";
				return;
			}
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
					if (!stopLoop(sessionId)) return {
						kind: "error",
						text: "kernel loop is not armed."
					};
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
				{
					const session = lctx.sessions.get(SessionId(sessionId));
					if (session === void 0 || !hasUserTask(session.events)) return {
						kind: "error",
						text: NEEDS_TASK
					};
				}
				armLoop(sessionId, raw === "" ? defaultBudget : Number(raw));
				return {
					kind: "success",
					text: `Kernel loop armed: budget ${String(state.budget)} evaluations, supervisor ${state.supervise ? "on" : "off"}. It continues the run whenever a turn settles unfinished, and asks for a finalize before stopping on budget/stall; /kloop stop disarms.`
				};
			}
		});
		lctx.commands.register({
			name: "supervise",
			description: "Second-model supervisor: /supervise on|off toggles review at kernel-loop continuation points; /supervise use <provider>/<model> overrides the supervisor route for this session (\"use default\" follows the plugin config again).",
			input: { hint: "on | off | use <provider>/<model> | status" },
			handler: (invocation) => {
				const raw = invocation.rawInput.trim();
				const state = stateFor(invocation.agent.id);
				if (raw === "on") {
					const error = setSupervise(invocation.agent.id, true);
					if (error !== null) return {
						kind: "error",
						text: error
					};
					const supervisor = effectiveSupervisor(state);
					return {
						kind: "success",
						text: `Supervisor on${supervisor !== void 0 ? ` (${supervisor.provider}/${supervisor.model}, ${supervisor.source})` : ""}; reviews run at kernel-loop continuation points.`
					};
				}
				if (raw === "off") {
					setSupervise(invocation.agent.id, false);
					return {
						kind: "success",
						text: "Supervisor off."
					};
				}
				if (raw.startsWith("use ") || raw === "use") {
					const spec = raw.slice(3).trim();
					if (spec === "default" || spec === "") {
						delete state.supervisorOverride;
						const fallback = effectiveSupervisor(state);
						return {
							kind: "success",
							text: fallback !== void 0 ? `Supervisor override cleared; following config: ${fallback.provider}/${fallback.model}.` : "Supervisor override cleared; nothing configured — /supervise use <provider>/<model> to pick one."
						};
					}
					const slash = spec.indexOf("/");
					if (slash <= 0 || slash === spec.length - 1) return {
						kind: "error",
						text: "Usage: /supervise use <provider>/<model> (or `use default` to follow config)."
					};
					state.supervisorOverride = {
						provider: spec.slice(0, slash),
						model: spec.slice(slash + 1)
					};
					return {
						kind: "success",
						text: `Supervisor model for this session: ${spec}.${state.supervise ? "" : " Enable with /supervise on."}`
					};
				}
				const effective = effectiveSupervisor(state);
				return {
					kind: "success",
					text: `supervisor ${state.supervise ? "on" : "off"}; ${effective !== void 0 ? `route: ${effective.provider}/${effective.model} (${effective.source})` : "not configured"}.`
				};
			}
		});
	});
	ctx.inject(["agentPresets"], (pctx) => {
		if (config.preset?.install === false) return;
		const id = config.preset?.id ?? "kernel-opt";
		(async () => {
			try {
				const userRoot = pctx.agentPresets.roots.find((root) => root.trust === "user");
				if (userRoot === void 0) return;
				const source = bundledPresetDir();
				if (!existsSync(join(source, "agent.cordis.yml"))) return;
				const target = join(expandHome(userRoot.path), id);
				if (existsSync(target)) return;
				await cp(source, target, { recursive: true });
			} catch {}
		})();
	});
	ctx.inject(["webServer"], (wctx) => {
		const buildControl = (sessionId, series, taskReady) => {
			const state = loops.get(sessionId);
			return {
				loop: {
					armed: state?.armed ?? false,
					budget: state?.budget ?? 0,
					round: state?.round ?? 0,
					evalsDone: completedEvals(series),
					available: bridge.arm !== void 0,
					taskReady,
					defaultBudget,
					...state?.stopReason !== void 0 ? { stopReason: state.stopReason } : {}
				},
				supervisor: {
					enabled: state?.supervise ?? false,
					configured: effectiveSupervisor(state) !== void 0,
					...config.supervisor !== void 0 ? { configRoute: {
						provider: config.supervisor.provider,
						model: config.supervisor.model
					} } : {},
					...(() => {
						const effective = effectiveSupervisor(state);
						return effective !== void 0 ? { effective } : {};
					})(),
					...state?.lastAdvice !== void 0 ? { lastAdvice: state.lastAdvice } : {}
				}
			};
		};
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
					respond(200, {
						...series,
						control: buildControl(rawId, series, hasUserTask(session.events))
					});
				} catch (error) {
					respond(500, { error: error instanceof Error ? error.message : String(error) });
				}
			}
		}), "kernel-opt: series route");
		wctx.effect(() => wctx.webServer.register({
			kind: "exact",
			path: CONTROL_PATH,
			handler: (req, res) => {
				const respond = (status, payload) => {
					res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify(payload));
				};
				if (req.method === "GET") {
					try {
						const rawId = new URL(req.url ?? "/", "http://dsh.internal").searchParams.get("sessionId") ?? "";
						const session = rawId === "" ? void 0 : wctx.sessions.get(SessionId(rawId));
						if (session === void 0) {
							respond(rawId === "" ? 400 : 404, { error: rawId === "" ? "sessionId query parameter required" : "unknown session" });
							return;
						}
						const series = project(rawId, session.events, projection);
						respond(200, { control: buildControl(rawId, series, hasUserTask(session.events)) });
					} catch (error) {
						respond(500, { error: error instanceof Error ? error.message : String(error) });
					}
					return;
				}
				if (req.method !== "POST") {
					respond(405, { error: "GET or POST only" });
					return;
				}
				(async () => {
					try {
						const body = await readJsonBody(req);
						if (body === null) {
							respond(400, { error: "JSON body required" });
							return;
						}
						const sessionId = typeof body["sessionId"] === "string" ? body["sessionId"] : "";
						const action = typeof body["action"] === "string" ? body["action"] : "";
						const session = sessionId === "" ? void 0 : wctx.sessions.get(SessionId(sessionId));
						if (session === void 0) {
							respond(404, { error: "unknown session" });
							return;
						}
						let error = null;
						if (action === "loop-arm") {
							const arm = bridge.arm;
							if (arm === void 0) {
								respond(503, { error: "loop machinery not composed (commands/llm absent)" });
								return;
							}
							if (!hasUserTask(session.events)) error = NEEDS_TASK;
							else {
								const raw = body["budget"];
								arm(sessionId, typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw <= 9999 ? raw : defaultBudget);
							}
						} else if (action === "loop-stop") stopLoop(sessionId);
						else if (action === "supervise-on") error = setSupervise(sessionId, true);
						else if (action === "supervise-off") error = setSupervise(sessionId, false);
						else if (action === "supervise-use") {
							const state = stateFor(sessionId);
							const provider = typeof body["provider"] === "string" ? body["provider"].trim() : "";
							const model = typeof body["model"] === "string" ? body["model"].trim() : "";
							if (provider === "" && model === "") delete state.supervisorOverride;
							else if (provider === "" || model === "") {
								respond(400, { error: "provider and model must both be given (or both empty to follow config)" });
								return;
							} else state.supervisorOverride = {
								provider,
								model
							};
						} else {
							respond(400, { error: `unknown action: ${action}` });
							return;
						}
						const series = project(sessionId, session.events, projection);
						const control = buildControl(sessionId, series, hasUserTask(session.events));
						if (error !== null) {
							respond(409, {
								error,
								control
							});
							return;
						}
						respond(200, { control });
					} catch (err) {
						respond(500, { error: err instanceof Error ? err.message : String(err) });
					}
				})();
			}
		}), "kernel-opt: control route");
	});
	ctx.inject(["webServer", "llm"], (mctx) => {
		mctx.effect(() => mctx.webServer.register({
			kind: "exact",
			path: MODELS_PATH,
			handler: (req, res) => {
				const respond = (status, payload) => {
					res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify(payload));
				};
				if (req.method !== void 0 && req.method !== "GET") {
					respond(405, { error: "GET only" });
					return;
				}
				(async () => {
					try {
						const catalog = { providers: [] };
						for (const provider of mctx.llm.listProviders().slice(0, 20)) {
							let models = [];
							try {
								models = (await mctx.llm.listModels(provider.id)).slice(0, 50).map((model) => ({
									id: model.id,
									name: model.name
								}));
							} catch {}
							catalog.providers.push({
								id: provider.id,
								name: provider.name,
								models
							});
						}
						respond(200, catalog);
					} catch (error) {
						respond(500, { error: error instanceof Error ? error.message : String(error) });
					}
				})();
			}
		}), "kernel-opt: models route");
	});
}
//#endregion
export { apply, inject, name };
