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
/**
* Id of the bundled「算子优化模式」agent preset the Node half seeds into the
* user preset root. Shared constant: sessions composed from this preset id
* always show the evaluation tab (before any evaluation lands).
*/
const PRESET_ID = "kernel-opt";
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
* EXAMPLE of one. A real run proved it — the plugin warned about the very
* manual that documents the channel, "1 evaluation came back through a
* channel this panel does not collect" pointing at the example line. That
* skill is gone (its protocol lives in the preset persona now), but any
* skill documenting the contract would land the same way.
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
export { WRAPUP_LINE_PREFIX as _, AUDIT_LINE_PREFIX as a, CONTROL_PATH as c, PRESET_ID as d, REPLAY_LINE_PREFIX as f, WRAPUP_CLOSE_LINE as g, SERIES_PATH as h, AUDIT_CLOSE_LINE as i, LOOP_LINE_PREFIX as l, REVIEW_OK_LINE as m, hasUserTask as n, CHALLENGE_LINE as o, REVIEW_HEADER as p, project as r, CONTINUE_TRAILER as s, DEFAULT_PROJECTION as t, MODELS_PATH as u, referenceDrift as v, samePath as y };
