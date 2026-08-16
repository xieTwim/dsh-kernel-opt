import { _ as WRAPUP_LINE_PREFIX, a as AUDIT_LINE_PREFIX, c as CONTROL_PATH, g as WRAPUP_CLOSE_LINE, h as SERIES_PATH, i as AUDIT_CLOSE_LINE, l as LOOP_LINE_PREFIX, m as REVIEW_OK_LINE, n as hasUserTask, o as CHALLENGE_LINE, p as REVIEW_HEADER, r as project, s as CONTINUE_TRAILER, t as DEFAULT_PROJECTION, u as MODELS_PATH, v as referenceDrift } from "./chunk-projection-CsZov8Cm.mjs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionId } from "@deepseek-ai/dsh-session";
import { ReasoningEffortId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { Service } from "@deepseek-ai/cordis";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
//#region src/runtime.ts
/**
* The profile-plane half's resolved configuration, published as a Cordis
* service.
*
* The model-facing tools moved to the AGENT plane (they belong to the
* 「算子优化模式」 preset, not to every session in the deployment), but their
* behaviour is still governed by the ONE plugin config block the README
* documents — `shellTools`, `jobTools`, `replay`, and the rest. Handing that
* across as a service is what keeps it one config surface: a preset row that
* had to restate `benchTools` would be a second place to forget.
*
* Consuming direction only. A preset row must never PUBLISH a service into
* the process-global realm (`agentPresets`' mount invariant refuses it); it
* may read what the host composition provides, and this is provided by the
* profile-plane plugin.
*
* @module @xietwim/dsh-kernel-opt/runtime
*/
/** Service name, shared by the provider and the two agent-plane rows. */
const RUNTIME_SERVICE = "kernelOptRuntime";
/**
* Resolved plugin configuration, readable from the agent plane.
*
* Registered on construction and removed with the owning fiber, so a
* disabled or hot-reloaded plugin takes its tools with it: the preset rows
* inject this service and simply do not mount without it.
*/
var KernelOptRuntime = class extends Service {
	projection;
	replay;
	constructor(ctx, settings) {
		super(ctx, RUNTIME_SERVICE);
		this.projection = settings.projection;
		this.replay = settings.replay;
	}
};
/**
* Resolve projection routing from plugin config over defaults.
* @param config - the plugin's projection-related keys (all optional).
* @returns a complete routing table.
*/
function resolveProjection(config) {
	return {
		benchTools: config.benchTools ?? DEFAULT_PROJECTION.benchTools,
		profileTools: config.profileTools ?? DEFAULT_PROJECTION.profileTools,
		profileCommands: config.profileCommands ?? DEFAULT_PROJECTION.profileCommands,
		finalizeTools: config.finalizeTools ?? DEFAULT_PROJECTION.finalizeTools,
		changeTools: config.changeTools ?? DEFAULT_PROJECTION.changeTools,
		shellTools: config.shellTools ?? DEFAULT_PROJECTION.shellTools,
		jobTools: config.jobTools ?? DEFAULT_PROJECTION.jobTools,
		planTool: DEFAULT_PROJECTION.planTool,
		envTool: DEFAULT_PROJECTION.envTool
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
* Whether a supervisor review of this run would carry any signal. Without a
* single evaluation or stated plan the digest is an empty table — a review
* would spend a supervisor call solemnly approving nothing and mint a phantom
* "round 1 OK" record every time a fresh session is armed.
*/
function reviewable(series) {
	return series.iterations.length > 0 || series.plans.length > 0;
}
/**
* Whether evaluations exist that no delivered review has seen: rows logged
* after the last review-carrying loop message, or any rows when no review
* ever ran. The closing audit fires on this — a run the agent finishes in a
* single turn has its only checkpoint after the finalize, so without the
* audit the supervisor would never speak at all.
*/
function unreviewedEvals(series) {
	let lastReviewSeq = -1;
	for (const round of series.rounds) if (round.review !== void 0) lastReviewSeq = round.seq;
	return series.iterations.some((p) => p.seq > lastReviewSeq);
}
/**
* Whether the plan card has fallen behind the run: a plan exists, but a full
* pace batch of evaluations has landed since it was reported. The panel's
* plan card is fed ONLY by `kernel_plan` calls, so an agent that switches
* approach and describes it in prose leaves the human reading a stale plan.
* @param series - current projection.
* @param evalsPerTurn - pace batch size (0 falls back to 3).
* @returns whether the drive should ask for a fresh plan report.
*/
function planStale(series, evalsPerTurn = 3) {
	const lastPlanSeq = series.plans.reduce((seq, p) => Math.max(seq, p.seq), -1);
	if (lastPlanSeq < 0) return false;
	return series.iterations.filter((p) => p.pending !== true && p.seq > lastPlanSeq).length >= Math.max(2, evalsPerTurn > 0 ? evalsPerTurn : 3);
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
	if (series.iterations.filter((p) => p.finalized === true).reduce((seq, p) => Math.max(seq, p.seq), -1) > (state.challengedFinalizeSeq ?? -1)) return {
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
/** Profiler/native metrics shown per row, and how many of them. */
const DIGEST_METRIC_CAP = 5;
/** Changes rendered per evaluation. */
const DIGEST_CHANGES_PER_ITERATION = 3;
/** Chars kept per change text field. */
const DIGEST_CHANGE_TEXT = 220;
/** Command fragment budget in the digest: opening context, then the tail. */
const CMD_HEAD = 80;
/**
* A command line as the reviewer sees it. Two things the obvious version got
* wrong, both measured on a real run:
*
* Long commands are elided in the MIDDLE, never at the tail. An agent edits
* and then measures in one `&&` chain, so the benchmark invocation sits at the
* END — a head-only cut hides exactly what the rubric asks the reviewer to
* judge. On the kopt-gpu2 run, four rows opened with a patch heredoc or a
* `git checkout` and ran `./eval.sh` past character 400; the reviewer, shown
* the first 60 characters, called two of them non-benchmark rows in the
* closing audit. They were real, and one of them tied the best result.
*
* Whitespace collapses first: a heredoc's newlines would otherwise break one
* table row into several, and the digest's rows are its structure.
*/
function shownCommand(command) {
	const flat = command.replace(/\s+/g, " ").trim();
	if (flat.length <= 253) return flat;
	return `${flat.slice(0, CMD_HEAD)} … ${flat.slice(-170)}`;
}
/** One line of the digest table handed to the supervisor. */
function digestRow(point, index, bestIndex) {
	const status = point.pending === true ? "pending" : point.rewardHack === true ? "REWARD-HACK" : point.error !== void 0 ? `error: ${point.error.slice(0, 80)}` : point.correct === true ? "ok" : "WRONG";
	const latency = point.latencyMs !== void 0 ? `${point.latencyMs}ms` : "—";
	const star = point.finalized === true ? " ★finalized" : "";
	const best = bestIndex === index ? " ←best" : "";
	const channel = point.channel !== void 0 ? ` [${point.channel}]` : "";
	const command = point.command !== void 0 ? ` cmd:"${shownCommand(point.command)}"` : "";
	const entries = Object.entries(point.metrics ?? {}).filter(([key]) => key !== "speedup" && key !== "ref_runtime_ms");
	const metrics = entries.length > 0 ? ` metrics:{${entries.slice(0, DIGEST_METRIC_CAP).map(([k, v]) => `${k}=${String(v)}`).join(", ")}${entries.length > DIGEST_METRIC_CAP ? ", …" : ""}}` : "";
	return `#${String(index + 1)} ${point.evaluationId ?? "?"} ${latency} ${status}${star}${best}${channel}${command}${metrics}`;
}
/** Cap one change text field onto a single digest line. */
function snip(text) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > DIGEST_CHANGE_TEXT ? `${flat.slice(0, DIGEST_CHANGE_TEXT)}…` : flat;
}
/**
* What the agent actually edited before its recent evaluations, rendered from
* the projected change log.
*
* This is the supervisor's only INDEPENDENT evidence of which approach
* families were tried. Without it the rubric's "untried families" test runs
* entirely on the agent's own `kernel_plan` labels — the reviewed party
* narrating its own coverage — so an aspirational label ("tiling") passes as
* an attempt even when the diff shows a constant being nudged.
* @param series - current projection.
* @returns digest lines, empty when no changes were captured.
*/
function digestChanges(series) {
	const withChanges = series.iterations.map((point, index) => ({
		point,
		index
	})).filter((entry) => (entry.point.changes?.length ?? 0) > 0).slice(-4);
	if (withChanges.length === 0) return [];
	const lines = ["Artifact changes before those evaluations (what was actually edited, not what the plan claimed):"];
	for (const { point, index } of withChanges) {
		const changes = point.changes ?? [];
		for (const change of changes.slice(0, DIGEST_CHANGES_PER_ITERATION)) {
			const mark = change.truncated === true ? " [cut]" : "";
			if (change.kind === "write") {
				const body = change.content !== void 0 ? ` ${snip(change.content)}` : "";
				lines.push(`#${String(index + 1)} rewrote:${body}${mark}`);
			} else {
				lines.push(`#${String(index + 1)} edit: - ${snip(change.oldText ?? "")}`);
				lines.push(`${" ".repeat(String(index + 1).length + 1)}       + ${snip(change.newText ?? "")}${mark}`);
			}
		}
		if (changes.length > DIGEST_CHANGES_PER_ITERATION) lines.push(`#${String(index + 1)} … ${String(changes.length - DIGEST_CHANGES_PER_ITERATION)} more edits`);
	}
	return lines;
}
/**
* Compact text digest of the run for the supervisor: budget state, recent
* plans, the tail of the iteration table with the evaluator's own metrics, and
* the artifact edits behind those rows. Bounded, but not shape-only: asked for
* headroom while shown nothing but latencies and the agent's own plan labels,
* a reviewer can only agree, which is what an unbroken run of bare approvals
* looks like.
* @param series - current projection.
* @param state - loop state (budget/round).
* @param tail - iterations included from the end.
* @returns the digest text.
*/
function supervisorDigest(series, state, tail = 10, evalsPerTurn = 0) {
	const evalsDone = completedEvals(series);
	const lines = [`Budget: ${String(evalsDone)}/${String(state.budget)} evaluations used; continuation round ${String(state.round)}.`];
	if (evalsPerTurn > 0 && series.rounds.length > 0) {
		const lastDriveSeq = series.rounds[series.rounds.length - 1]?.seq ?? -1;
		const lastTurn = series.iterations.filter((p) => p.seq > lastDriveSeq).length;
		lines.push(`Pace: the drive asks for at most ${String(evalsPerTurn)} evaluations per turn; the last turn ran ${String(lastTurn)}.`);
	}
	const stagnant = stagnationCount(series);
	if (stagnant >= 3) lines.push(`Stagnation: ${String(stagnant)} evaluations since the last improvement.`);
	const shellCount = series.iterations.filter((p) => p.channel === "shell").length;
	if (shellCount > 0) lines.push(`Provenance: ${String(shellCount)}/${String(series.iterations.length)} evaluations are self-reported (parsed from agent-run shell output; cmd shown per row). A row whose cmd is not a benchmark invocation is fabricated.`);
	const metricRows = series.iterations.filter((p) => Object.keys(p.metrics ?? {}).some((key) => key !== "speedup" && key !== "ref_runtime_ms")).length;
	if (series.profileSeqs.length > 0) lines.push(`Profiling: ${String(series.profileSeqs.length)} command(s) invoked a profiler` + (metricRows > 0 ? `, and ${String(metricRows)} evaluation(s) carried metrics.` : ", but NO evaluation carried a single metric — profiler findings that appear only in the agent's prose are unverified here, so treat them as claims, not evidence."));
	else if (evalsDone >= 3) lines.push("Profiling: no profiler invocation seen on the command lines — the run may be optimizing by guesswork rather than measurement (hand-written diagnostic scripts would not be detected here).");
	const drift = referenceDrift(series.iterations);
	if (drift !== void 0) lines.push(`Denominator: NOT one number. Across ${String(drift.count)} evaluations the reference latency each one divided by ranges ${drift.min.toPrecision(4)}–${drift.max.toPrecision(4)} ms (${String(Math.round((drift.ratio - 1) * 100))}% apart), so the evaluator re-timed its reference instead of freezing it, or the machine changed mid-run. Speedups from different evaluations are NOT comparable with each other: judge progress by latency, because a speedup that moves while the latency it belongs to does not is the denominator moving, not the kernel. That cuts both ways here — a faster version can carry a lower reported multiple than a slower one.`);
	if (series.uncollectedSeqs.length > 0) lines.push(`Uncollected: ${String(series.uncollectedSeqs.length)} contract line(s) arrived through a channel this record does not collect, so those evaluations are NOT listed above and NOT counted against the budget. Judge this run on what is listed, and say that measurements are missing rather than assuming the numbers above are the whole picture.`);
	const env = series.envs[series.envs.length - 1];
	if (env !== void 0) lines.push(`Environment (agent-reported): ${env.device} @ ${env.location}${env.constraint !== void 0 ? ` — constraint: ${env.constraint}` : ""}`);
	else lines.push("Environment: not reported — the agent has not stated where these measurements run.");
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
	lines.push(...digestChanges(series));
	return lines.join("\n");
}
/** System rubric for the supervisor model. */
const SUPERVISOR_SYSTEM = [
	"You supervise a kernel-optimization agent. You see a digest of its run: budget, its stated plans, the evaluation table with whatever metrics its evaluator reported, and the artifact edits behind the recent rows.",
	"Judge how the run is being conducted — you are not reviewing the kernel line by line:",
	"- correctness first: WRONG or REWARD-HACK rows are failures, not progress;",
	"- budget discipline: repeated evaluations of one idea without a stated hypothesis waste budget;",
	"- approach diversity: several consecutive failures of one family should trigger a family switch;",
	"- plan vs diff: the change log is your independent evidence. A plan naming a family the edits do not show (a \"tiling\" plan whose diff only moves a constant) is a real miss — say so, and say what the edit would have to touch;",
	"- metrics: when the evaluator reports occupancy/bandwidth/cache numbers, read them. A kernel far from a stated roof has headroom the latency column alone does not show;",
	"- diagnosis: several evaluations with no profiler run and no reported metrics is optimizing by guesswork — ask for one profiled run before more variants;",
	"- plan hygiene: plans should exist and match what the table shows;",
	"- provenance: on [shell] rows the trajectory is self-reported — judge whether each cmd is a real benchmark invocation and whether the numbers move like real measurements. Long commands are shown ELIDED IN THE MIDDLE (`head … tail`), and an agent commonly edits and measures in one chain: a cmd opening with a patch or a git checkout may well have run the bench in the part you were not shown. When the fragment does not settle it, say the evidence is inconclusive and ask for the invocation — never call a row fabricated on the strength of a fragment;",
	"- pace: the drive caps evaluations per turn so the loop can steer mid-run; a turn that overran the cap is a discipline miss worth one line of advice;",
	"- finishing: near budget exhaustion the agent should finalize its best honest result.",
	"If the run looks healthy, reply `OK: ` followed by ONE short sentence naming what you checked and the strongest signal you saw (e.g. \"OK: four families tried, best is replay-consistent, budget on track\"). The sentence is shown to the human as the record of this review, so never reply with a bare OK.",
	"Otherwise reply with at most 3 short imperative sentences of advice. No preamble, no code."
].join("\n");
/**
* Rubric for the finalize challenge: the agent declared the run finished
* while budget remained, and the supervisor decides whether that stands. The
* bar is deliberately asymmetric — "the current result looks fine" is not a
* reason to stop; only an argued absence of headroom is.
*/
const HEADROOM_SYSTEM = [
	"You supervise a kernel-optimization agent that just declared its run FINISHED while evaluation budget remained.",
	"You decide whether that ending stands. Judge from the digest: the plans it stated, the evaluation table with its metrics, the artifact edits behind the recent rows, and the provenance of the numbers.",
	"Read the change log before you accept any claim of coverage: it shows which families were ACTUALLY attempted, while the plan lines are the agent describing its own work. A family named in a plan but absent from the diffs is untried.",
	"The bar is asymmetric — an agent stopping early wastes the budget the human paid for:",
	"- \"the result is good enough\" or \"the improvement is large already\" is NOT a reason to stop;",
	"- a plateau over the last few evaluations is not convergence if whole approach families are untried;",
	"- untried families are evidence of headroom: different algorithm/layout, different tiling or blocking,",
	"  fusion or launch-overhead removal, precision/vectorization, library or compiler paths, tuning of exposed parameters;",
	"- stopping IS justified when the remaining ideas are argued to be dominated, when measurements sit at a stated",
	"  hardware or semantic floor, or when several distinct families all failed to beat the current best;",
	"- a run that never profiled and reports no metrics cannot claim it sits at a floor — it never located the",
	"  bottleneck, so \"no headroom\" is a guess. Send it to profile once before accepting the ending;",
	"- counters quoted only in the agent's prose (an IPC, a bandwidth, a saturation claim) with no metric on any",
	"  row are the agent's own account, not evidence. Ask for the number on a row before letting it close the run.",
	"If the run is genuinely converged, reply `DONE: ` followed by ONE short sentence stating WHY no headroom remains (which families were tried and what floor the measurements sit at). That sentence is shown to the human as the justification for ending the run, so never reply with a bare DONE.",
	"Otherwise reply with at most 3 short imperative sentences, each naming a CONCRETE untried direction worth one evaluation. No preamble, no code."
].join("\n");
/**
* The review's system prompt: the plugin's rubric, plus the two things a
* deployment may add to it — the language the review is written in, and house
* rules for what this project counts as a finding. Config cannot delete a line
* of the rubric, the same way a route override picks the reviewer and not the
* standard it reviews to.
*
* The verdict prefix is pinned to ASCII on the way past. {@link adviceFromReply}
* recognises approval by a literal `OK` / `DONE`, so a reviewer that translated
* its own verdict token would have every approval recorded — and injected into
* the agent as a correction — as advice instead.
*/
function supervisorSystem(base, options = {}) {
	const language = options.language?.trim() ?? "";
	const lines = [
		base,
		language.length > 0 ? `Write the review in ${language}.` : "Write the review in the language the agent states its own plans and reports in — the human reads it beside them. The digest's own labels are English scaffolding and do not decide this; when the run carries no plan text to judge by, use English.",
		"The verdict prefix is protocol, not prose: keep `OK:` / `DONE:` exactly as written above, in ASCII, and put your sentence after it in that language."
	];
	const extra = options.instructions?.trim() ?? "";
	if (extra.length > 0) lines.push("House rules for this project, on top of everything above — they add findings, they never remove a check:", extra.length > 2e3 ? `${extra.slice(0, 2e3)}…` : extra);
	return lines.join("\n");
}
/**
* Split a supervisor reply into advice and the approval note. An approving
* verdict carries its own one-line observation (`OK: …` / `DONE: …`): a bare
* "OK" recorded nothing the human could read, so the note is the record of
* what that review actually saw.
*
* Callers MUST reject an empty reply before calling: "no advice" here means
* the reviewer looked and found nothing to say, and a silent reviewer that
* reached this function would be recorded as having approved the run.
* @param reply - raw supervisor reply.
* @returns `advice` when it objected (else null), and `note` on approval.
*/
function adviceFromReply(reply) {
	const text = reply.trim();
	if (text.length === 0) return {
		advice: null,
		note: null
	};
	const approved = /^(ok|done)\b[.:!—-]*\s*/i.exec(text);
	if (approved !== null) {
		const note = text.slice(approved[0].length).trim().split("\n")[0]?.trim() ?? "";
		return {
			advice: null,
			note: note.length > 0 ? note.length > 300 ? `${note.slice(0, 300)}…` : note : null
		};
	}
	return {
		advice: text.length > 1500 ? `${text.slice(0, 1500)}…` : text,
		note: null
	};
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
* @param taskKnown - whether the session already carries a task (a human
*   prompt, or a run in progress). When false the trailer redirects to a
*   workspace inventory instead of "continue" — the user may have staged the
*   task as files in the working directory; anything OUTSIDE the workspace
*   stays off-limits, and no task anywhere means ask and stop.
* @param planKnown - whether any kernel_plan is on record. When false the
*   message demands the initial plan report before further evaluation — the
*   persona asks for it too, but the drive message is the enforcement point
*   (a whole run without a single plan renders the plan panel dead).
* @param evalsPerTurn - pace cap carried by the drive: at most this many
*   evaluations per turn, then settle and report. Manufactures the turn
*   boundaries that give the supervisor periodic checkpoints and keep the
*   budget gate near-real-time when a capable model would otherwise finish
*   the whole run in one turn (0 = no pace line).
* @param okNote - the supervisor's one-line observation when it approved.
* @param planStale - evaluations have piled up since the last plan report, so
*   the panel's plan card no longer describes what the agent is doing; the
*   drive asks for a fresh one (prose in chat never reaches the panel).
* @param envKnown - whether the evaluation environment has been reported. The
*   numbers on the panel mean nothing without the machine they were taken on,
*   and only the agent knows which machine that is.
* @returns the followup text.
*/
function continuationText(round, evalsDone, budget, advice, reviewedOk = false, stagnant = 0, finalizeHint = "run_finalize / kernel_finalize", taskKnown = true, planKnown = true, evalsPerTurn = 0, okNote = null, planStale = false, envKnown = true) {
	const lines = [`${LOOP_LINE_PREFIX}${String(round)}] ${String(evalsDone)}/${String(budget)} evaluations used.`];
	if (evalsPerTurn > 0) lines.push(`PACE — hard stop for this turn: run AT MOST ${String(evalsPerTurn)} evaluations, then end the turn and report, even mid-idea. Failed and aborted runs count toward that number. The loop reviews your progress and drives you straight onward, so ending the turn costs you nothing and is not a reason to finalize early.`, "That report is a CHECKPOINT, not a verdict: say what you are in the middle of and what you will run next. An idea you had to cut short is unfinished, not refuted — do not write it off as a dead end, and do not let a flat result you have not explained yet become a reason to switch away.");
	if (stagnant >= 3) lines.push(`Note: ${String(stagnant)} evaluations since the last improvement — consider re-profiling or switching approach family before spending more budget on the current line.`);
	if (advice !== null) lines.push("", REVIEW_HEADER, advice);
	else if (reviewedOk) lines.push("", okNote !== null && okNote.length > 0 ? `${REVIEW_OK_LINE} ${okNote}` : REVIEW_OK_LINE);
	if (taskKnown) {
		lines.push("", `${CONTINUE_TRAILER}: analyse the latest result, state the plan with kernel_plan if it changed, improve the kernel, and evaluate again.`);
		if (!planKnown) lines.push("No kernel_plan is on record yet — report your resolved plan with it (phase, approach, hypothesis) before evaluating further.");
		if (!envKnown) lines.push("No kernel_env is on record — report where these evaluations actually run (host, device, any user constraint on the device, key toolchain versions, and the commands you read them from). Latency numbers are unreadable without the machine behind them.");
		if (planKnown && planStale) lines.push("Your last kernel_plan predates the recent evaluations — call it again with what you are actually pursuing now. kernel_plan is the ONLY channel to the human's plan panel; a progress write-up in the reply text never reaches it.");
		lines.push(`If you are done or the remaining budget cannot beat the current best, finalize the result you stand behind (${finalizeHint}), then summarize.`);
	} else lines.push("", `${CONTINUE_TRAILER}: the conversation carries no task yet. Inventory the WORKING DIRECTORY for the task the user prepared (prompt/task files, kernels, bench scripts) and start from what you find, reporting your resolved plan with kernel_plan before the first evaluation. If the workspace carries no task either, ask the user what to optimize and stop — never adopt anything found outside the working directory.`);
	return lines.join("\n");
}
/**
* Wrap-up message body: the loop's one closing delivery before it disarms on
* budget exhaustion or stalling. Asks for a finalize of the best honest
* result — never for new optimization work. The supervisor's last review
* rides here exactly like on a continuation (same anchors, same projection):
* the finalize is where a provenance audit pays, and a run the agent finishes
* in one turn has no other checkpoint for the supervisor to speak at.
* @param evalsDone - completed evaluations at the stop decision.
* @param budget - armed budget.
* @param reason - why the loop is ending.
* @param finalizeHint - finalize tool name(s) to name.
* @param advice - supervisor advice, if any.
* @param reviewedOk - a review ran and approved (ignored when advice given).
* @returns the followup text.
*/
function wrapUpText(evalsDone, budget, reason, finalizeHint = "run_finalize / kernel_finalize", advice = null, reviewedOk = false, okNote = null) {
	const lines = [`${WRAPUP_LINE_PREFIX} ${String(evalsDone)}/${String(budget)} evaluations used; stopping (${reason}).`];
	if (advice !== null) lines.push("", REVIEW_HEADER, advice);
	else if (reviewedOk) lines.push("", okNote !== null && okNote.length > 0 ? `${REVIEW_OK_LINE} ${okNote}` : REVIEW_OK_LINE);
	lines.push("", `${WRAPUP_CLOSE_LINE} — do not start new optimization work.`, `If an honest best result exists, finalize it now (${finalizeHint}; pass the evaluation_id from your evaluator, or the artifact path for kernel_finalize).`, "Restore the best artifact verbatim first if a later edit regressed it.", "Report a closing kernel_plan naming the approach you are actually delivering — abandoned exploration must not be what the human is left reading in the plan panel.", "Then summarize the run: best result, what worked, what failed, and what a future attempt should try first.");
	return lines.join("\n");
}
/**
* Challenge message: the agent finalized with budget left and the supervisor
* found headroom, so the run continues and the finalize is provisional. Rides
* the ordinary round anchors — the panel records it as that round's review
* like any other, and the counters stay parseable.
* @param round - continuation round being delivered (1-based).
* @param evalsDone - completed evaluations so far.
* @param budget - armed budget.
* @param advice - the supervisor's concrete untried directions.
* @param finalizeHint - finalize tool name(s) to name in the closing line.
* @param evalsPerTurn - per-turn pace cap (0 = no pace line).
* @returns the followup text.
*/
function challengeText(round, evalsDone, budget, advice, finalizeHint = "run_finalize / kernel_finalize", evalsPerTurn = 0) {
	const lines = [
		`${LOOP_LINE_PREFIX}${String(round)}] ${String(evalsDone)}/${String(budget)} evaluations used.`,
		"",
		REVIEW_HEADER,
		advice,
		"",
		`${CONTINUE_TRAILER}: ${CHALLENGE_LINE}. You declared it finished, but budget remains and the supervisor identified headroom above — treat your finalize as provisional and pursue those directions now.`,
		"Do not re-finalize the same artifact to end the run: either produce a measurement that beats the current best, or come back with EVIDENCE that a direction is dominated (what you tried, what it measured, why it cannot win).",
		`When the remaining budget genuinely cannot beat the current best, finalize the result you stand behind (${finalizeHint}), report a closing kernel_plan naming the approach you are delivering, then summarize.`
	];
	if (evalsPerTurn > 0) lines.push(`Pace: complete at most ${String(evalsPerTurn)} evaluations this turn, then settle and report.`);
	return lines.join("\n");
}
/**
* Closing-audit message body: delivered once when a finalized run still
* carries evaluations the supervisor never reviewed (a single-turn run's only
* checkpoint lands after the finalize). An approving verdict just closes the
* run on the record; findings give the agent one bounded chance to verify or
* correct the finalized result — the loop stays disarmed either way, so the
* reply turn is never re-driven.
* @param advice - supervisor advice, or null when it approved.
* @param okNote - the supervisor's one-line justification on approval.
* @returns the followup text.
*/
function finalAuditText(advice, okNote = null) {
	const lines = [`${AUDIT_LINE_PREFIX} the run has finalized; the supervisor audited the final table.`];
	if (advice !== null) lines.push("", REVIEW_HEADER, advice, "", `${AUDIT_CLOSE_LINE}: verify or correct the finalized result (re-finalize if the artifact changes), then close with a short note.`, "Do not start new optimization work beyond what the findings require.");
	else lines.push("", okNote !== null && okNote.length > 0 ? `${REVIEW_OK_LINE} ${okNote}` : REVIEW_OK_LINE, "", "No action needed — this note closes the run.");
	return lines.join("\n");
}
//#endregion
//#region src/preset.ts
/**
* Keeping the user's copy of the bundled agent preset in step with the plugin.
*
* Split out of index.ts because this is the one place the plugin writes into a
* directory the user also owns: four branches, a manifest, and a backup path.
* That deserves tests it can actually be given.
*/
/** What this plugin last wrote into the user's preset directory. */
const PRESET_MANIFEST = ".dsh-kernel-opt-files.json";
function sha256(data) {
	return createHash("sha256").update(data).digest("hex");
}
/** Every file under `dir`, as paths relative to it. */
async function walkFiles(dir, prefix = "") {
	const out = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...await walkFiles(join(dir, entry.name), rel));
		else if (entry.isFile()) out.push(rel);
	}
	return out;
}
/**
* Seed the bundled preset into the user's preset root, and keep it in step
* with the plugin on every later update.
*
* The old rule was copy-once — existing files were never overwritten, so a
* user's edits survived. That protected the wrong thing: after any plugin
* update the on-disk `evaluator/bench.py` stayed at whatever shipped the day
* it was first installed, while SKILL.md (read live from the package) described
* the new one. The tool and its own documentation disagreed, silently, and the
* only way out was a manual copy nobody knows to make.
*
* So ownership is tracked instead of assumed. A manifest records the hash of
* every file this plugin wrote; on each install a file is
*
*   - written when absent,
*   - left alone when it already matches the bundled version,
*   - UPDATED when its hash is still the one we recorded — nobody has touched
*     it since we wrote it, so there is nothing to protect,
*   - KEPT when it differs from both: the user edited it. It stays flagged as
*     theirs for good (the manifest keeps recording OUR last hash, not
*     theirs), and the log names it so the divergence is visible.
*
* An install that predates the manifest cannot tell an edit from a stale copy.
* There it backs the file up next to itself and updates, which loses nothing
* and puts the directory on the clean path above from then on.
*
* @returns lines worth putting in the host log (empty when nothing moved).
*/
async function syncPreset(source, target) {
	const manifestPath = join(target, PRESET_MANIFEST);
	let recorded = {};
	let firstSync = true;
	try {
		const files = JSON.parse(await readFile(manifestPath, "utf8"))?.files;
		if (files !== null && typeof files === "object") {
			recorded = files;
			firstSync = false;
		}
	} catch {}
	const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
	const written = {};
	const updated = [];
	const kept = [];
	const backedUp = [];
	for (const rel of await walkFiles(source)) {
		const to = join(target, rel);
		const bundled = await readFile(join(source, rel));
		const bundledHash = sha256(bundled);
		let current = null;
		try {
			current = await readFile(to);
		} catch {
			current = null;
		}
		if (current === null) {
			await mkdir(dirname(to), { recursive: true });
			await writeFile(to, bundled);
			written[rel] = bundledHash;
			continue;
		}
		const currentHash = sha256(current);
		if (currentHash === bundledHash) {
			written[rel] = bundledHash;
			continue;
		}
		const ours = recorded[rel];
		if (ours === currentHash) {
			await writeFile(to, bundled);
			written[rel] = bundledHash;
			updated.push(rel);
			continue;
		}
		if (firstSync) {
			await rename(to, `${to}.bak-${stamp}`);
			await writeFile(to, bundled);
			written[rel] = bundledHash;
			backedUp.push(rel);
			continue;
		}
		if (ours !== void 0) written[rel] = ours;
		kept.push(rel);
	}
	try {
		await mkdir(target, { recursive: true });
		await writeFile(manifestPath, `${JSON.stringify({
			schema: 1,
			files: written
		}, null, 2)}\n`);
	} catch {}
	const lines = [];
	if (updated.length > 0) lines.push(`preset: updated ${updated.join(", ")} in ${target}`);
	if (backedUp.length > 0) lines.push(`preset: updated ${backedUp.join(", ")} in ${target}; the previous copy of each is kept alongside as *.bak-${stamp} (this directory predates update tracking)`);
	if (kept.length > 0) lines.push(`preset: kept your edited ${kept.join(", ")} — the bundled version has changed since. Delete a file to take the new one.`);
	return lines;
}
//#endregion
//#region src/index.ts
const name = "kernel-opt";
const inject = ["agents", "sessions"];
/** Plugin id stamped on plugin-sourced messages. */
const PLUGIN_ID = "kernel-opt";
/** Delay between a logged turn end and the idle check that may continue. */
const SETTLE_DELAY_MS = 1200;
/** Absolute path of the bundled preset directory (repo/package layout). */
function bundledPresetDir() {
	return join(dirname(fileURLToPath(import.meta.url)), "../preset/kernel-opt");
}
/** Expand a leading `~/` the way the preset roots document it. */
function expandHome(path) {
	return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
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
	const evalsPerTurn = config.loop?.evalsPerTurn ?? 3;
	const challengeFinalize = config.loop?.challengeFinalize ?? true;
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
	new KernelOptRuntime(ctx, {
		projection,
		replay: {
			enabled: config.replay?.enabled !== false,
			timeoutMs: (config.replay?.timeoutSec ?? 900) * 1e3
		}
	});
	ctx.inject(["commands", "llm"], (lctx) => {
		/** Pending settle timers, cleared with the plugin. */
		const timers = /* @__PURE__ */ new Set();
		lctx.effect(() => () => {
			for (const timer of timers) clearTimeout(timer);
			timers.clear();
		}, "kernel-opt: loop timers");
		/**
		* One supervisor review; any failure degrades to unreviewed/no advice.
		* `mode` picks the question: `round` audits loop discipline mid-run,
		* `closing` audits the finished table, `headroom` decides whether an
		* early finalize stands (its own rubric, since "looks fine" must not end
		* a run with budget left).
		*/
		const review = async (state, series, mode = "round") => {
			const supervisor = effectiveSupervisor(state);
			if (supervisor === void 0 || !state.supervise) return {
				advice: null,
				note: null,
				reviewed: false
			};
			const warn = (message) => {
				console.warn(`[kernel-opt] supervisor: ${message}`);
			};
			try {
				const base = supervisorDigest(series, state, 10, evalsPerTurn);
				const digest = mode === "closing" ? `${base}\nThe run has finalized — this is the closing audit: judge the final table and its provenance (the finalize and its replay above all); continuation advice is moot.` : mode === "headroom" ? `${base}\nThe agent has just declared the run FINISHED with ${String(state.budget - completedEvals(series))} evaluations of budget still unspent. Decide whether that ending stands.` : base;
				/** One review call; `thinking` false spends the budget on the answer. */
				const ask = async (thinking) => {
					let reply = "";
					let finish;
					const stream = lctx.llm.stream({
						provider: supervisor.provider,
						model: supervisor.model,
						system: supervisorSystem(mode === "headroom" ? HEADROOM_SYSTEM : SUPERVISOR_SYSTEM, {
							...config.supervisor?.language !== void 0 ? { language: config.supervisor.language } : {},
							...config.supervisor?.instructions !== void 0 ? { instructions: config.supervisor.instructions } : {}
						}),
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
						...thinking ? {} : { reasoningEffort: ReasoningEffortId("off") },
						maxTokens: config.supervisor?.maxTokens ?? 16e3,
						signal: AbortSignal.timeout(thinking ? 12e4 : 45e3)
					});
					for await (const chunk of stream) if (chunk.type === "text-delta") reply += chunk.text;
					else if (chunk.type === "finish") finish = chunk.reason.kind;
					return {
						reply,
						...finish !== void 0 ? { finish } : {}
					};
				};
				let { reply, finish } = await ask(true);
				if (reply.trim().length === 0 && finish === "max-tokens") {
					warn(`${supervisor.provider}/${supervisor.model} spent its whole budget thinking; retrying the review without reasoning`);
					({reply, finish} = await ask(false));
				}
				if (reply.trim().length === 0) {
					warn(`${supervisor.provider}/${supervisor.model} produced no answer (finish: ${finish ?? "unknown"}); the review is recorded as not run`);
					return {
						advice: null,
						note: null,
						reviewed: false
					};
				}
				return {
					...adviceFromReply(reply),
					reviewed: true
				};
			} catch (error) {
				warn(`${supervisor.provider}/${supervisor.model} failed: ${String(error)}`);
				return {
					advice: null,
					note: null,
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
				const budgetLeft = state.budget - decision.evalsDone;
				const lastFinalizeSeq = series.iterations.filter((p) => p.finalized === true).reduce((seq, p) => Math.max(seq, p.seq), -1);
				const challengeable = challengeFinalize && state.supervise && budgetLeft > 0 && lastFinalizeSeq > (state.challengedFinalizeSeq ?? -1);
				if (challengeable || state.supervise && unreviewedEvals(series)) {
					const { advice, note, reviewed } = await review(state, series, challengeable ? "headroom" : "closing");
					state.lastAdvice = advice ?? state.lastAdvice;
					if (!state.armed || lctx.agents.get(SessionId(sessionId)) !== agent || agent.status !== "idle") return;
					if (challengeable && advice !== null) {
						state.challengedFinalizeSeq = lastFinalizeSeq;
						state.round += 1;
						state.lastEvalCount = decision.evalsDone;
						agent.followup(createUserMessage({
							content: [{
								type: "text",
								text: challengeText(state.round, decision.evalsDone, state.budget, advice, finalizeHint, evalsPerTurn)
							}],
							source: {
								kind: "plugin",
								plugin: PLUGIN_ID
							}
						}));
						return;
					}
					state.armed = false;
					state.stopReason = challengeable && reviewed ? "converged" : decision.reason;
					if (reviewed) agent.followup(createUserMessage({
						content: [{
							type: "text",
							text: finalAuditText(advice, note)
						}],
						source: {
							kind: "plugin",
							plugin: PLUGIN_ID
						}
					}));
					return;
				}
				state.armed = false;
				state.stopReason = decision.reason;
				return;
			}
			if (decision.action === "wrap-up") {
				const { advice, note, reviewed } = reviewable(series) ? await review(state, series) : {
					advice: null,
					note: null,
					reviewed: false
				};
				state.lastAdvice = advice ?? state.lastAdvice;
				if (!state.armed || lctx.agents.get(SessionId(sessionId)) !== agent || agent.status !== "idle") return;
				state.armed = false;
				state.stopReason = decision.reason;
				agent.followup(createUserMessage({
					content: [{
						type: "text",
						text: wrapUpText(decision.evalsDone, state.budget, decision.reason, finalizeHint, advice, reviewed && advice === null, note)
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
			const { advice, note, reviewed } = reviewable(series) ? await review(state, series) : {
				advice: null,
				note: null,
				reviewed: false
			};
			state.lastAdvice = advice ?? state.lastAdvice;
			if (!state.armed || lctx.agents.get(SessionId(sessionId)) !== agent || agent.status !== "idle") return;
			const taskKnown = series.iterations.length > 0 || series.plans.length > 0 || hasUserTask(session.events);
			agent.followup(createUserMessage({
				content: [{
					type: "text",
					text: continuationText(state.round, decision.evalsDone, state.budget, advice, reviewed && advice === null, stagnationCount(series), finalizeHint, taskKnown, series.plans.length > 0, evalsPerTurn, note, planStale(series, evalsPerTurn), series.envs.length > 0)
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
			delete state.challengedFinalizeSeq;
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
				for (const line of await syncPreset(source, target)) console.warn(`[kernel-opt] ${line}`);
			} catch {}
		})();
	});
	ctx.inject(["webServer"], (wctx) => {
		const buildControl = (sessionId, series) => {
			const state = loops.get(sessionId);
			return {
				loop: {
					armed: state?.armed ?? false,
					budget: state?.budget ?? 0,
					round: state?.round ?? 0,
					evalsDone: completedEvals(series),
					available: bridge.arm !== void 0,
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
						control: buildControl(rawId, series)
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
						respond(200, { control: buildControl(rawId, series) });
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
							const raw = body["budget"];
							arm(sessionId, typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw <= 9999 ? raw : defaultBudget);
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
						const control = buildControl(sessionId, series);
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
