import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { SessionId } from "@deepseek-ai/dsh-session";
import { ReasoningEffortId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
//#region src/wire.ts
/**
* Whether two logged paths plausibly address the same file (exact, or one is
* the other's path suffix). Shared protocol helper: the projection matches
* changes/finalizes with it and the panel matches replay coverage.
*/
function samePath(a, b) {
	return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}
/**
* The reference latency each evaluation actually divided by, recovered as
* `latency × speedup`. A frozen denominator repeats one value; an evaluator
* that re-times its reference per evaluation returns a slightly different one
* each time, and one that re-times it per CONTAINER — the normal shape of
* remote evaluation, where the cache file dies with the container — can return
* a very different one. Shared protocol helper: the chart pools these into the
* axis, and the drift check below reads their spread.
*/
function impliedReferences(iterations) {
	const out = [];
	for (const point of iterations) {
		const { latencyMs, speedup } = point;
		if (latencyMs === void 0 || latencyMs <= 0) continue;
		if (speedup === void 0 || speedup <= 0) continue;
		out.push(latencyMs * speedup);
	}
	return out;
}
const REFERENCE_DRIFT_MIN_POINTS = 4;
function referenceDrift(iterations) {
	const implied = impliedReferences(iterations);
	if (implied.length < REFERENCE_DRIFT_MIN_POINTS) return void 0;
	let min = implied[0];
	let max = min;
	for (const value of implied) {
		if (value < min) min = value;
		if (value > max) max = value;
	}
	const ratio = max / min;
	return ratio >= 1.15 ? {
		min,
		max,
		ratio,
		count: implied.length
	} : void 0;
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
/** First-line prefix of the closing-audit message after a finalized run. */
const AUDIT_LINE_PREFIX = "[kernel-loop final review]";
/** Line opening the wrap-up's closing instructions (ends a review block). */
const WRAPUP_CLOSE_LINE = "The kernel loop is ending";
/** Line opening the audit's closing instructions (ends a review block). */
const AUDIT_CLOSE_LINE = "Address the findings";
/**
* Sentence marking a continuation as an overruled finalize (the run was
* declared finished and the supervisor found headroom). Sits inside the
* challenge's trailer, so the projection flags the round from the text alone.
*/
const CHALLENGE_LINE = "the run is NOT over";
/** Header line introducing a supervisor advice block. */
const REVIEW_HEADER = "Supervisor review (advisory, from the second model):";
/** Whole line recording that the supervisor reviewed and approved. */
const REVIEW_OK_LINE = "Supervisor review: OK.";
/**
* Start of the fixed trailer paragraph (terminates the advice block). The
* anchor is task-neutral: the sentence completing it adapts to whether the
* session already carries a task (see `continuationText`).
*/
const CONTINUE_TRAILER = "Continue the kernel-optimization run";
//#endregion
//#region src/projection.ts
/** Defaults cover any `kernel_evaluate`-named evaluator (MCP prefixes match as suffixes) plus the host's tool-fs pair and shell. */
const DEFAULT_PROJECTION = {
	benchTools: ["kernel_evaluate"],
	profileTools: ["kernel_profile"],
	profileCommands: [
		"ncu",
		"nv-nsight-cu-cli",
		"nsys",
		"nvprof",
		"rocprof",
		"rocprofv2",
		"rocprofv3",
		"omniperf",
		"vtune",
		"perf",
		"xctrace",
		"instruments"
	],
	finalizeTools: ["run_finalize", "kernel_finalize"],
	planTool: "kernel_plan",
	envTool: "kernel_env",
	changeTools: ["write", "edit"],
	shellTools: ["bash"],
	jobTools: ["job_output"]
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
/** Shell operators that open a new command position. */
const SEGMENT_SPLIT = /[;|&\n]+|\$\(|`/;
/** Programs that run another program: the profiler may follow one of these. */
const COMMAND_WRAPPERS = /* @__PURE__ */ new Set([
	"xcrun",
	"sudo",
	"env",
	"nohup",
	"time",
	"command",
	"stdbuf",
	"exec"
]);
/** Programs whose quoted argument is itself a command line to run elsewhere. */
const COMMAND_EXECUTORS = /* @__PURE__ */ new Set([
	"ssh",
	"bash",
	"sh",
	"zsh",
	"docker",
	"podman",
	"kubectl",
	"srun",
	"sbatch"
]);
/** Arguments that turn a profiler invocation into a question ABOUT the profiler. */
const INSPECTION_ARGS = /* @__PURE__ */ new Set([
	"--help",
	"-h",
	"help",
	"--version",
	"-V",
	"--list",
	"list"
]);
/** Leading `FOO=bar` environment assignments. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Placeholder standing in for one quoted span, by index. */
const QUOTED_SLOT = /^\0(\d+)\0$/;
/** ssh flags that take no value, so only one token gets skipped. */
const SSH_BOOLEAN_FLAGS = /^-[46AaCfGgKkMNnqsTtVvXxYy]+$/;
/** End-of-options marker: for most programs holding one, a command line follows. */
const HANDOFF = "--";
/**
* Programs that only read text back. A contract line in their output was
* printed by an evaluation that already happened somewhere else, so collecting
* it would invent a second point for one measurement — the phantom the README
* warns about, observed for real when a run grepped its own bench log and put
* three points on an otherwise empty chart.
*/
const READER_COMMANDS = /* @__PURE__ */ new Set([
	"cat",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"head",
	"tail",
	"less",
	"more",
	"od",
	"xxd",
	"strings",
	"wc",
	"ls",
	"find",
	"diff"
]);
/** Text a shell tool returns when it puts the command in the background. */
const BACKGROUND_JOB_ANNOUNCE = /started background job (\S+)/;
/**
* Tools that hand back stored text. A contract line in their output restates a
* measurement rather than reporting a new one, so their silence on the curve
* is correct and needs no warning — unlike a channel nobody thought about,
* which is what {@link WireSeries.uncollectedSeqs} exists to surface.
*
* `skill` belongs here for a sharper reason than the readers: it returns a
* skill's own text, so the only contract line it can carry is a documented
* EXAMPLE of one. Without it the plugin warns about its own SKILL.md, which is
* what a real run did — "1 evaluation came back through a channel this panel
* does not collect" pointing at the line that documents the channel.
*/
const TEXT_READING_TOOLS = /* @__PURE__ */ new Set([
	"read",
	"glob",
	"grep",
	"notebook_read",
	"skill"
]);
/** Programs whose `--` introduces operands — usually paths — rather than a command. */
const HANDOFF_OPERANDS = /* @__PURE__ */ new Set([
	"git",
	"grep",
	"rg",
	"find",
	"ls",
	"rm",
	"cp",
	"mv",
	"diff"
]);
/** How deep to follow `ssh host 'ssh other "…"'` before giving up. */
const EXECUTOR_DEPTH = 3;
/**
* Whether a shell command line actually RUNS one of the configured profilers.
*
* Position, not substring: the name must be the program a command segment
* invokes (after env assignments and wrappers like `xcrun`/`sudo`), so
* `ls /opt/xctrace` and `python /opt/ncu/bench.py` do not qualify. An
* invocation whose arguments only interrogate the tool (`xctrace list
* templates`, `ncu --help`) does not qualify either — measured on a real
* run, where availability probes were the only matches and the panel then
* claimed the agent had profiled.
*
* Quoted text is data, not shell syntax — except when the program holding it
* exists to run a command line somewhere else. `ssh box 'ncu … python bench.py'`
* is the normal shape of profiling a remote GPU, so an executor's quoted
* argument is re-scanned as a command line, while `git commit -m 'ncu run'`
* and `grep -E 'xctrace|instruments'` stay data.
*
* A bare `--` is followed the same way, because the command handed across it is
* usually not quoted: `kubectl exec pod -- ncu … a.py` and `srun -N1 -- nsys …`
* are the standard cluster shapes. Following the marker rather than the program
* in front of it also covers a scheduler that is not on any list here, which is
* what a site's own lease/queue wrapper always is. Where `--` separates operands
* instead, what crosses it must carry two arguments to count, which is what a
* path named `perf` next to one sibling path cannot do; the handful of programs
* that pass paths in pairs (`git log -- perf src/ tests/`) are named as well.
* @param command - the logged command line.
* @param names - configured profiler executables.
* @returns whether any segment invokes a profiler on a workload.
*/
/**
* Whether a command line only reads stored text back, so its contract lines
* restate measurements rather than produce them. Every segment must be a
* reader: `cat log | bash` runs something, and one real program anywhere on
* the line makes the whole line an execution.
* @param command - the shell command line as logged.
* @returns whether the line cannot have produced a measurement.
*/
function isReadBackCommand(command) {
	const quoted = [];
	const stash = (_match, body) => `\0${String(quoted.push(body) - 1)}\0`;
	const shell = command.replace(/'([^']*)'/g, stash).replace(/"([^"]*)"/g, stash);
	let sawReader = false;
	for (const segment of shell.split(SEGMENT_SPLIT)) {
		const tokens = segment.trim().split(/\s+/).filter((token) => token.length > 0);
		let at = 0;
		while (at < tokens.length) {
			const token = tokens[at] ?? "";
			if (!ENV_ASSIGNMENT.test(token) && !COMMAND_WRAPPERS.has(token)) break;
			at += 1;
		}
		const head = tokens[at];
		if (head === void 0) continue;
		const program = head.slice(head.lastIndexOf("/") + 1);
		if (program === "cd" || program === "echo") continue;
		if (!READER_COMMANDS.has(program)) return false;
		sawReader = true;
	}
	return sawReader;
}
function matchesProfileCommand(command, names) {
	const quoted = [];
	const stash = (_match, body) => `\0${String(quoted.push(body) - 1)}\0`;
	return scanSegments(command.replace(/'([^']*)'/g, stash).replace(/"([^"]*)"/g, stash), quoted, names, EXECUTOR_DEPTH);
}
/**
* Whether any command segment of an already-stashed line invokes a profiler.
* @param shell - the line with quoted spans replaced by slot placeholders.
* @param quoted - bodies of the stashed quoted spans, by index.
* @param names - configured profiler executables.
* @param depth - remaining executor hops to follow.
* @param minArgs - how many arguments the profiler must carry to count.
* @returns whether any segment invokes a profiler on a workload.
*/
function scanSegments(shell, quoted, names, depth, minArgs = 1) {
	for (const segment of shell.split(SEGMENT_SPLIT)) {
		const tokens = segment.trim().split(/\s+/).filter((token) => token.length > 0);
		let at = 0;
		while (at < tokens.length) {
			const token = tokens[at] ?? "";
			if (!ENV_ASSIGNMENT.test(token) && !COMMAND_WRAPPERS.has(token)) break;
			at += 1;
		}
		const head = tokens[at];
		if (head === void 0) continue;
		const program = head.slice(head.lastIndexOf("/") + 1);
		const args = tokens.slice(at + 1);
		if (depth > 0 && !HANDOFF_OPERANDS.has(program)) {
			const marker = args.indexOf(HANDOFF);
			const rest = marker === -1 ? [] : args.slice(marker + 1);
			if (rest.length > 0 && scanSegments(rest.join(" "), quoted, names, depth - 1, 2)) return true;
		}
		if (COMMAND_EXECUTORS.has(program)) {
			if (depth > 0 && followsExecutor(program, args, quoted, names, depth)) return true;
			continue;
		}
		if (!names.includes(program)) continue;
		if (args.length < minArgs) continue;
		if (args.some((token) => INSPECTION_ARGS.has(token))) continue;
		return true;
	}
	return false;
}
/**
* Whether the command an executor was handed runs a profiler.
*
* Two shapes carry it: quoted (`ssh box 'ncu … a.py'`, `bash -c "ncu … a.py"`)
* and bare, where ssh's own flags and destination sit between the executor and
* the program it will run (`ssh -p 22 root@box ncu … a.py`).
* @param program - the executor's own name.
* @param args - the executor's arguments, quoted spans still stashed.
* @param quoted - bodies of the stashed quoted spans, by index.
* @param names - configured profiler executables.
* @param depth - remaining executor hops to follow.
* @returns whether the handed-off command line profiles.
*/
function followsExecutor(program, args, quoted, names, depth) {
	for (const token of args) {
		const slot = QUOTED_SLOT.exec(token);
		const body = slot === null ? void 0 : quoted[Number(slot[1])];
		if (body !== void 0 && scanSegments(body, quoted, names, depth - 1)) return true;
	}
	if (program !== "ssh") return false;
	let at = 0;
	while (at < args.length && (args[at] ?? "").startsWith("-")) at += SSH_BOOLEAN_FLAGS.test(args[at] ?? "") ? 1 : 2;
	const rest = args.slice(at + 1);
	return rest.length > 0 && scanSegments(rest.join(" "), quoted, names, depth - 1);
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
* explicit `speedup` wins; else `ref_runtime_ms` divided by the measured
* latency. Each is looked up inside `native_metrics` first — the documented
* home, and where the bundled evaluator writes it — and then at the payload's
* own top level, beside `latency_ms`.
*
* Reading both places is not politeness about schema. An agent-written
* evaluator printed `"speedup": 29.221` next to `"latency_ms"` on all 31 of a
* run's contract lines; reading only `native_metrics` dropped every one of
* them, which cost the × axis, cost the pooled reference the chart derives
* FROM those ratios (`referenceLatency`) — the one thing that would have
* cancelled a denominator re-timed in each of 13 containers — and left the
* panel telling the reader that no evaluation had reported a speedup.
* A number named `speedup` sitting in a contract line means one thing.
*/
function speedupFrom(metrics, payload, latencyMs) {
	const pick = (name) => {
		for (const [key, value] of Object.entries(metrics ?? {})) if ((key === name || key.endsWith(`.${name}`)) && value > 0) return value;
		const direct = payload[name];
		if (typeof direct === "number" && Number.isFinite(direct) && direct > 0) return direct;
	};
	const explicit = pick("speedup");
	if (explicit !== void 0) return explicit;
	if (latencyMs === void 0 || latencyMs <= 0) return void 0;
	const ref = pick("ref_runtime_ms");
	return ref === void 0 ? void 0 : ref / latencyMs;
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
	const speedup = speedupFrom(metrics, payload, point.latencyMs);
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
* Parse a kernel-loop continuation/wrap-up/closing-audit message back out of
* a `user/message` event. The message data is the logged UserMessage (a
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
	const audit = text.startsWith(AUDIT_LINE_PREFIX);
	if (!wrapUp && !audit && !text.startsWith("[kernel-loop round ")) return null;
	const round = { seq: event.seq };
	if (wrapUp) round.wrapUp = true;
	if (audit) round.audit = true;
	if (text.includes("the run is NOT over")) round.challenge = true;
	const counters = /(\d+)\/(\d+) evaluations used/.exec(text);
	if (counters !== null) {
		round.evalsUsed = Number(counters[1]);
		round.budget = Number(counters[2]);
	}
	if (!wrapUp && !audit) {
		const num = /^\[kernel-loop round (\d+)\]/.exec(text);
		if (num !== null) round.round = Number(num[1]);
	}
	const okAt = text.indexOf(REVIEW_OK_LINE);
	if (okAt >= 0) {
		round.review = "ok";
		const note = text.slice(okAt + 22).split("\n")[0]?.trim() ?? "";
		if (note.length > 0) round.reviewNote = note;
	} else {
		const headerAt = text.indexOf(REVIEW_HEADER);
		if (headerAt >= 0) {
			const rest = text.slice(headerAt + 52);
			const ends = [
				CONTINUE_TRAILER,
				WRAPUP_CLOSE_LINE,
				AUDIT_CLOSE_LINE
			].map((anchor) => rest.indexOf(anchor)).filter((at) => at >= 0);
			const advice = (ends.length > 0 ? rest.slice(0, Math.min(...ends)) : rest).trim();
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
	const envs = [];
	const profileSeqs = [];
	const rounds = [];
	const finalizedIds = /* @__PURE__ */ new Set();
	/** Artifacts named by finalize calls (`artifact_path`), best point gets ⚑. */
	const finalizedArtifacts = [];
	/** callId → pending bench iteration awaiting its result. */
	const pendingBench = /* @__PURE__ */ new Map();
	/** callId → shell-call provenance awaiting its result (trailer scan). */
	const pendingShell = /* @__PURE__ */ new Map();
	/** callId → id of the background job being read, awaiting its result. */
	const pendingJob = /* @__PURE__ */ new Map();
	/** Background job id → the shell command that launched it (provenance). */
	const jobCommands = /* @__PURE__ */ new Map();
	/**
	* Contract line → index of the point that already carries it, for the whole
	* session rather than for one job. One measurement is one point no matter
	* how many times its line comes back, and a run has more ways to fetch a
	* line again than a job re-read: a real run polled `modal app logs <app> |
	* grep KERNEL_EVAL` beside the job that was producing the lines, and every
	* poll minted a fresh copy of evaluations already on the curve — 15 real
	* evaluations became 20 points.
	*
	* The identity is the payload verbatim: same artifact, same latency, same
	* ratio, same metrics. Two independent runs of one kernel do not land there
	* — they differ in a digit somewhere, which is exactly what a re-timed
	* reference and instance variance keep producing. A genuine repeat that DID
	* match to the last digit would lose a duplicate row of an identical number;
	* counting a fetched line twice inflates the curve and the budget.
	*/
	const trailerIndex = /* @__PURE__ */ new Map();
	/** Indices whose command came from a job announcement (the launching run). */
	const jobLaunched = /* @__PURE__ */ new Set();
	/** One entry per contract line that reached no collecting channel. */
	const uncollectedSeqs = [];
	/** callId → tool name, so an unrecognised channel can still be named. */
	const callNames = /* @__PURE__ */ new Map();
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
			callNames.set(call.callId, call.name);
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
			if (call.name === config.envTool) {
				const args = parseResultJson(call.argumentsJson);
				if (args !== null && typeof args["location"] === "string" && typeof args["device"] === "string") {
					const env = {
						seq: event.seq,
						location: args["location"],
						device: args["device"]
					};
					for (const key of [
						"constraint",
						"probe",
						"notes"
					]) {
						const value = args[key];
						if (typeof value === "string" && value.length > 0) env[key] = value;
					}
					const versions = asRecord(args["versions"]);
					if (versions !== null) {
						const pairs = {};
						for (const [vName, value] of Object.entries(versions)) if (typeof value === "string" && value.length > 0) pairs[vName] = value;
						else if (typeof value === "number") pairs[vName] = String(value);
						if (Object.keys(pairs).length > 0) env.versions = pairs;
					}
					envs.push(env);
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
				if (typeof command === "string" && matchesProfileCommand(command, config.profileCommands)) profileSeqs.push(event.seq);
				pendingShell.set(call.callId, {
					name: call.name,
					...typeof command === "string" && isReadBackCommand(command) ? { readBack: true } : {},
					...typeof command === "string" && command.length > 0 ? { command: capCommand(command) } : {}
				});
			} else if (matchesTool(call.name, config.jobTools)) {
				const jobId = parseResultJson(call.argumentsJson)?.["job_id"];
				pendingJob.set(call.callId, typeof jobId === "string" ? jobId : "");
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
				const announcedId = BACKGROUND_JOB_ANNOUNCE.exec(text)?.[1];
				if (announcedId !== void 0 && shell.command !== void 0) jobCommands.set(announcedId, shell.command);
				if (!text.includes("KERNEL_EVAL=")) continue;
				if (shell.readBack === true) continue;
				let consumed = false;
				for (const payload of trailerPayloads(text)) {
					const key = JSON.stringify(payload);
					if (trailerIndex.has(key)) continue;
					const point = trailerPoint(event.seq, shell.name, "shell", payload);
					if (point === null) continue;
					if (shell.command !== void 0) point.command = shell.command;
					trailerIndex.set(key, iterations.length);
					const artifact = point.artifactPath;
					if (artifact !== void 0) {
						const matched = pendingChanges.filter((entry) => samePath(entry.path, artifact)).map((entry) => entry.change).slice(-8);
						if (matched.length > 0) point.changes = matched;
					}
					iterations.push(point);
					consumed = true;
				}
				if (consumed) pendingChanges = [];
				continue;
			}
			const jobId = pendingJob.get(result.callId);
			if (jobId !== void 0) {
				pendingJob.delete(result.callId);
				const text = collectResultText(result.message);
				if (!text.includes("KERNEL_EVAL=")) continue;
				const command = jobCommands.get(jobId);
				let consumed = false;
				for (const payload of trailerPayloads(text)) {
					const key = JSON.stringify(payload);
					const prior = trailerIndex.get(key);
					if (prior !== void 0) {
						if (command !== void 0 && !jobLaunched.has(prior)) {
							const existing = iterations[prior];
							if (existing !== void 0) existing.command = command;
							jobLaunched.add(prior);
						}
						continue;
					}
					const point = trailerPoint(event.seq, jobId, "shell", payload);
					if (point === null) continue;
					if (command !== void 0) {
						point.command = command;
						jobLaunched.add(iterations.length);
					}
					trailerIndex.set(key, iterations.length);
					const artifact = point.artifactPath;
					if (artifact !== void 0) {
						const matched = pendingChanges.filter((entry) => samePath(entry.path, artifact)).map((entry) => entry.change).slice(-8);
						if (matched.length > 0) point.changes = matched;
					}
					iterations.push(point);
					consumed = true;
				}
				if (consumed) pendingChanges = [];
				continue;
			}
			const toolName = callNames.get(result.callId);
			if (toolName !== void 0 && !TEXT_READING_TOOLS.has(toolName)) {
				const text = collectResultText(result.message);
				if (text.includes("KERNEL_EVAL=")) for (const _payload of trailerPayloads(text)) uncollectedSeqs.push(event.seq);
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
		envs,
		profileSeqs,
		uncollectedSeqs,
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
		profileCommands: config.profileCommands ?? DEFAULT_PROJECTION.profileCommands,
		finalizeTools: config.finalizeTools ?? DEFAULT_PROJECTION.finalizeTools,
		changeTools: config.changeTools ?? DEFAULT_PROJECTION.changeTools,
		shellTools: config.shellTools ?? DEFAULT_PROJECTION.shellTools,
		jobTools: config.jobTools ?? DEFAULT_PROJECTION.jobTools,
		planTool: DEFAULT_PROJECTION.planTool,
		envTool: DEFAULT_PROJECTION.envTool
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
		name: "kernel_env",
		description: "Report the environment your EVALUATIONS run in, to the human evaluation panel. Call once after inventory and BEFORE the first evaluation, and again whenever the environment changes (you move to a remote host, switch device, or the user constrains it). Report where the BENCHMARK executes, not where you are thinking: if the user pointed you at a remote machine or a cloud runner, describe THAT machine. If the user ruled a device out (\"CPU only\", a pinned CUDA_VISIBLE_DEVICES), state the device you are actually using and put the instruction in constraint. Read the facts, never guess them, and name the commands you read them from in probe.",
		parameters: {
			location: {
				type: "string",
				required: true,
				description: "Where evaluations execute, e.g. \"本机 (macOS)\" / \"kernel-box via rt\" / \"Modal B200 容器\"."
			},
			device: {
				type: "string",
				required: true,
				description: "The compute device the timed runs use, e.g. \"NVIDIA H100 80GB ×1\" / \"Apple M5 CPU (10 核)\"."
			},
			constraint: {
				type: "string",
				description: "User/task instruction that decided the device, e.g. \"用户要求仅用 CPU\" / \"CUDA_VISIBLE_DEVICES=0\"."
			},
			versions: {
				type: "object",
				additionalProperties: true,
				description: "Key toolchain versions as read, e.g. {\"python\":\"3.11.9\",\"torch\":\"2.6.0+cu124\",\"cuda\":\"12.4\",\"driver\":\"550.90\"}."
			},
			probe: {
				type: "string",
				description: "Command(s) these facts were read from, e.g. \"nvidia-smi; python -c ...\"."
			},
			notes: {
				type: "string",
				description: "Anything qualifying the measurements (clocks not locked, shared host, …)."
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
			return `Environment recorded: ${args.device} @ ${args.location}`;
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
