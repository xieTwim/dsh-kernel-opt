/**
 * Pure projection from a session's logged events to the panel wire series.
 * The session log is the only truth: nothing here subscribes or stores state —
 * callers re-run the projection per query, so live views, reloads, and replay
 * all agree by construction.
 * @module
 */
import type { WireChange, WireEnv, WireIteration, WirePlan, WireRound, WireSeries } from './wire.ts'
import {
  AUDIT_CLOSE_LINE, AUDIT_LINE_PREFIX, CHALLENGE_LINE, CONTINUE_TRAILER, EVAL_TRAILER_PREFIX,
  LOOP_LINE_PREFIX, REPLAY_LINE_PREFIX, REVIEW_HEADER, REVIEW_OK_LINE,
  WRAPUP_CLOSE_LINE, WRAPUP_LINE_PREFIX, samePath,
} from './wire.ts'

/** Structural slice of a logged session event the projection reads. */
export interface ProjectionEvent {
  readonly type: string
  readonly seq: number
  readonly data?: unknown
}

/** Tool-name routing for the projection. */
export interface ProjectionConfig {
  /** Match list for evaluation calls. */
  readonly benchTools: readonly string[]
  /** Match list for profiler calls. */
  readonly profileTools: readonly string[]
  /**
   * Profiler executables recognised on a shell command line, also ▲ markers.
   * {@link ProjectionConfig.profileTools} only fires for a registered profiler
   * TOOL, which the open-source shape has none of — the agent assembles its
   * own entry and profiles through the shell — so without this the mark could
   * never appear. Known limit: it recognises real profilers, not the
   * hand-written diagnostic scripts an agent falls back on where none exists
   * (a CPU box, an unsupported accelerator), so absence is weak evidence.
   */
  readonly profileCommands: readonly string[]
  /** Match list for finalize calls (their `evaluation_id` marks a point ★). */
  readonly finalizeTools: readonly string[]
  /** Exact name of the plan tool. */
  readonly planTool: string
  /** Tool the agent reports its evaluation environment with. */
  readonly envTool: string
  /** Match list for structured file-change tools (write/edit shapes). */
  readonly changeTools: readonly string[]
  /**
   * Match list for shell tools whose results are scanned for the
   * {@link EVAL_TRAILER_PREFIX} contract line (the self-reported channel).
   * Background-job readers (`job_output`) are deliberately not defaulted:
   * polling re-reads would duplicate every trailer they contain.
   */
  readonly shellTools: readonly string[]
  /**
   * Match list for background-job readers. Their results ARE scanned: a bench
   * that runs long enough to be backgrounded is still a bench, and a cloud
   * evaluation is reached that way as a matter of course. A Modal run measured
   * here produced 32 contract lines across 12 job reads and never repeated
   * one, so the duplication this channel was once excluded for did not occur;
   * trailers are deduplicated per job anyway, since inventing a second point
   * for one measurement is worse than merging two identical ones.
   *
   * Provenance comes from the shell call that launched the job, matched by the
   * id it announced, so a background point carries the command a human or the
   * supervising model can audit.
   */
  readonly jobTools: readonly string[]
}

/** Defaults cover any `kernel_evaluate`-named evaluator (MCP prefixes match as suffixes) plus the host's tool-fs pair and shell. */
export const DEFAULT_PROJECTION: ProjectionConfig = {
  benchTools: ['kernel_evaluate'],
  profileTools: ['kernel_profile'],
  // Profilers only: a correctness checker or a device monitor answers a
  // different question than "why is this slow", and would dilute the mark.
  profileCommands: [
    'ncu', 'nv-nsight-cu-cli', 'nsys', 'nvprof',
    'rocprof', 'rocprofv2', 'rocprofv3', 'omniperf',
    'vtune', 'perf', 'xctrace', 'instruments',
  ],
  finalizeTools: ['run_finalize', 'kernel_finalize'],
  planTool: 'kernel_plan',
  envTool: 'kernel_env',
  changeTools: ['write', 'edit'],
  shellTools: ['bash'],
  jobTools: ['job_output'],
}

/**
 * Whether a logged tool name matches a configured name: exact, or as a suffix
 * behind a separator (MCP registrations may prefix the server name, e.g.
 * `myeval__kernel_evaluate`).
 * @param name - tool name as logged.
 * @param patterns - configured names.
 * @returns whether any pattern matches.
 */
export function matchesTool(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (name === p) return true
    if (!name.endsWith(p)) return false
    const before = name.charAt(name.length - p.length - 1)
    return before === '_' || before === '-' || before === '.' || before === '/' || before === ':'
  })
}

/** Shell operators that open a new command position. */
const SEGMENT_SPLIT = /[;|&\n]+|\$\(|`/
/** Programs that run another program: the profiler may follow one of these. */
const COMMAND_WRAPPERS = new Set(['xcrun', 'sudo', 'env', 'nohup', 'time', 'command', 'stdbuf', 'exec'])
/** Programs whose quoted argument is itself a command line to run elsewhere. */
const COMMAND_EXECUTORS = new Set(['ssh', 'bash', 'sh', 'zsh', 'docker', 'podman', 'kubectl', 'srun', 'sbatch'])
/** Arguments that turn a profiler invocation into a question ABOUT the profiler. */
const INSPECTION_ARGS = new Set(['--help', '-h', 'help', '--version', '-V', '--list', 'list'])
/** Leading `FOO=bar` environment assignments. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Placeholder standing in for one quoted span, by index. */
const QUOTED_SLOT = /^\0(\d+)\0$/
/** ssh flags that take no value, so only one token gets skipped. */
const SSH_BOOLEAN_FLAGS = /^-[46AaCfGgKkMNnqsTtVvXxYy]+$/
/** End-of-options marker: for most programs holding one, a command line follows. */
const HANDOFF = '--'
/**
 * Programs that only read text back. A contract line in their output was
 * printed by an evaluation that already happened somewhere else, so collecting
 * it would invent a second point for one measurement — the phantom the README
 * warns about, observed for real when a run grepped its own bench log and put
 * three points on an otherwise empty chart.
 */
const READER_COMMANDS = new Set([
  'cat', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'less', 'more',
  'od', 'xxd', 'strings', 'wc', 'ls', 'find', 'diff',
])
/** Text a shell tool returns when it puts the command in the background. */
const BACKGROUND_JOB_ANNOUNCE = /started background job (\S+)/
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
const TEXT_READING_TOOLS = new Set(['read', 'glob', 'grep', 'notebook_read', 'skill'])
/** Programs whose `--` introduces operands — usually paths — rather than a command. */
const HANDOFF_OPERANDS = new Set(['git', 'grep', 'rg', 'find', 'ls', 'rm', 'cp', 'mv', 'diff'])
/** How deep to follow `ssh host 'ssh other "…"'` before giving up. */
const EXECUTOR_DEPTH = 3

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
export function isReadBackCommand(command: string): boolean {
  const quoted: string[] = []
  const stash = (_match: string, body: string): string => `\0${String(quoted.push(body) - 1)}\0`
  const shell = command.replace(/'([^']*)'/g, stash).replace(/"([^"]*)"/g, stash)
  let sawReader = false
  for (const segment of shell.split(SEGMENT_SPLIT)) {
    const tokens = segment.trim().split(/\s+/).filter(token => token.length > 0)
    let at = 0
    while (at < tokens.length) {
      const token = tokens[at] ?? ''
      if (!ENV_ASSIGNMENT.test(token) && !COMMAND_WRAPPERS.has(token)) break
      at += 1
    }
    const head = tokens[at]
    if (head === undefined) continue
    // `cd …` is navigation, not a program that could measure anything.
    const program = head.slice(head.lastIndexOf('/') + 1)
    if (program === 'cd' || program === 'echo') continue
    if (!READER_COMMANDS.has(program)) return false
    sawReader = true
  }
  return sawReader
}

export function matchesProfileCommand(command: string, names: readonly string[]): boolean {
  // One stash for the whole line: a body lifted out of `ssh a "ssh b 'ncu …'"`
  // still refers to slots the outer pass filled, so recursion can resolve them.
  const quoted: string[] = []
  const stash = (_match: string, body: string): string => `\0${String(quoted.push(body) - 1)}\0`
  const shell = command.replace(/'([^']*)'/g, stash).replace(/"([^"]*)"/g, stash)
  return scanSegments(shell, quoted, names, EXECUTOR_DEPTH)
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
function scanSegments(
  shell: string,
  quoted: readonly string[],
  names: readonly string[],
  depth: number,
  minArgs = 1,
): boolean {
  for (const segment of shell.split(SEGMENT_SPLIT)) {
    const tokens = segment.trim().split(/\s+/).filter(token => token.length > 0)
    let at = 0
    while (at < tokens.length) {
      const token = tokens[at] ?? ''
      if (!ENV_ASSIGNMENT.test(token) && !COMMAND_WRAPPERS.has(token)) break
      at += 1
    }
    const head = tokens[at]
    if (head === undefined) continue
    const program = head.slice(head.lastIndexOf('/') + 1)
    const args = tokens.slice(at + 1)
    // A bare `--` ends the host program's own options, so what follows is the
    // command line it will run. This is how the two standard cluster shapes
    // carry a profiler — `kubectl exec pod -- ncu … a.py`, `srun -N1 -- nsys …`
    // — neither of which is quoted, and bare arguments were previously followed
    // for `ssh` alone. It also reaches a scheduler this file has never heard of
    // (`gpuq exec L0324 --node w6 -- bash -c 'ncu … a.py'`), which is the point:
    // the marker is a convention, so it does not need the wrapper enumerated.
    //
    // Crossing the marker is a GUESS that the owner meant a command and not
    // operands, so it costs more evidence than the head position does: two
    // arguments, not one. A profiler on a workload carries a flag or a
    // subcommand plus the thing it runs (`ncu --set full python b.py`,
    // `nsys profile ./bench.sh`); an operand list after `--` is a path named
    // like a profiler plus a sibling path (`head -n5 -- perf notes.txt`), and
    // `perf` being both a configured name and an ordinary word is what makes
    // that bite. The floor closes that shape without enumerating its programs;
    // HANDOFF_OPERANDS still covers the multi-path cases it cannot see
    // (`git log -- perf src/ tests/`).
    if (depth > 0 && !HANDOFF_OPERANDS.has(program)) {
      const marker = args.indexOf(HANDOFF)
      const rest = marker === -1 ? [] : args.slice(marker + 1)
      if (rest.length > 0 && scanSegments(rest.join(' '), quoted, names, depth - 1, 2)) return true
    }
    if (COMMAND_EXECUTORS.has(program)) {
      if (depth > 0 && followsExecutor(program, args, quoted, names, depth)) return true
      continue
    }
    if (!names.includes(program)) continue
    // A profiler with nothing to profile prints its usage.
    if (args.length < minArgs) continue
    if (args.some(token => INSPECTION_ARGS.has(token))) continue
    return true
  }
  return false
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
function followsExecutor(
  program: string,
  args: readonly string[],
  quoted: readonly string[],
  names: readonly string[],
  depth: number,
): boolean {
  for (const token of args) {
    const slot = QUOTED_SLOT.exec(token)
    const body = slot === null ? undefined : quoted[Number(slot[1])]
    if (body !== undefined && scanSegments(body, quoted, names, depth - 1)) return true
  }
  if (program !== 'ssh') return false
  // `ssh [-p 22] [-o K=V] host cmd …`: skip flags with their values, then the destination.
  let at = 0
  while (at < args.length && (args[at] ?? '').startsWith('-')) {
    at += SSH_BOOLEAN_FLAGS.test(args[at] ?? '') ? 1 : 2
  }
  const rest = args.slice(at + 1)
  return rest.length > 0 && scanSegments(rest.join(' '), quoted, names, depth - 1)
}

/** Narrow an unknown to a plain record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** `tool/call` event payload slice. */
interface CallSlice {
  callId: string
  name: string
  argumentsJson: string
}

/** Read the `tool/call` payload defensively (merge-extensible event map). */
function callSlice(event: ProjectionEvent): CallSlice | null {
  if (event.type !== 'tool/call') return null
  const data = asRecord(event.data)
  if (data === null) return null
  const { callId, name } = data
  if (typeof callId !== 'string' || typeof name !== 'string') return null
  const argumentsJson = typeof data['arguments'] === 'string' ? data['arguments'] : '{}'
  return { callId, name, argumentsJson }
}

/**
 * Read the `tool/result` payload defensively. The correlating call id rides
 * the result message's `source.callId` (observed rc.2 shape); a top-level
 * `data.callId` or a `tool-result` block's `toolCallId` are accepted as
 * fallbacks so shape drift degrades to a still-correlated point.
 */
function resultSlice(event: ProjectionEvent): { callId: string; message: unknown } | null {
  if (event.type !== 'tool/result') return null
  const data = asRecord(event.data)
  if (data === null) return null
  const message = data['message']
  const source = asRecord(asRecord(message)?.['source'])
  const blocks = asRecord(message)?.['content']
  const firstBlock = Array.isArray(blocks) ? asRecord(blocks[0]) : null
  const callId = typeof source?.['callId'] === 'string'
    ? source['callId']
    : typeof data['callId'] === 'string'
      ? data['callId']
      : typeof firstBlock?.['toolCallId'] === 'string' ? firstBlock['toolCallId'] : null
  if (callId === null) return null
  return { callId, message }
}

/**
 * Collect the text of a tool-result message: every string value found under a
 * `text` key of a `{ type: 'text' }`-shaped node, joined in encounter order.
 * Shapes vary across tool sources (first-party, MCP), so this walks instead of
 * assuming one layout.
 * @param value - the logged result message.
 * @returns concatenated text, possibly empty.
 */
export function collectResultText(value: unknown): string {
  const parts: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === 'string') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item)
      return
    }
    const record = asRecord(node)
    if (record === null) return
    if (typeof record['text'] === 'string') parts.push(record['text'])
    for (const [key, child] of Object.entries(record)) {
      if (key === 'text') continue
      walk(child)
    }
  }
  walk(value)
  return parts.join('\n')
}

/**
 * Parse the first JSON object found in a result text. Evaluators reply with a
 * JSON payload, sometimes wrapped in prose or fences.
 * @param text - collected result text.
 * @returns the parsed object, or null when none parses.
 */
export function parseResultJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  const attempts: string[] = [trimmed]
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(trimmed.slice(first, last + 1))
  for (const candidate of attempts) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      const record = asRecord(parsed)
      if (record !== null) return record
    } catch {
      // Not JSON in this shape; try the next candidate.
    }
  }
  return null
}

/**
 * Extract the first balanced JSON object from a text fragment (string- and
 * escape-aware), tolerating trailing garbage after the object. Returns null
 * when nothing balanced parses.
 */
function extractJsonObject(text: string): Record<string, unknown> | null {
  const bounded = text.length > 20_000 ? text.slice(0, 20_000) : text
  const start = bounded.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < bounded.length; i += 1) {
    const ch = bounded[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return asRecord(JSON.parse(bounded.slice(start, i + 1)))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/**
 * Contract trailer payloads in a shell result text: one per line whose
 * trimmed form STARTS with {@link EVAL_TRAILER_PREFIX} (mid-line mentions —
 * prose, docs quoted by `cat` — do not qualify). Trailing garbage after the
 * JSON object is tolerated.
 */
export function trailerPayloads(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith(EVAL_TRAILER_PREFIX)) continue
    const payload = extractJsonObject(trimmed.slice(EVAL_TRAILER_PREFIX.length))
    if (payload !== null) out.push(payload)
  }
  return out
}

/** Numeric subset of `native_metrics`, capped so the wire stays small. */
function numericMetrics(value: unknown, cap = 12): Record<string, number> | undefined {
  const record = asRecord(value)
  if (record === null) return undefined
  const out: Record<string, number> = {}
  let count = 0
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) continue
    out[key] = entry
    count += 1
    if (count >= cap) break
  }
  return count > 0 ? out : undefined
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
function speedupFrom(
  metrics: Record<string, number> | undefined,
  payload: Record<string, unknown>,
  latencyMs: number | undefined,
): number | undefined {
  const pick = (name: string): number | undefined => {
    for (const [key, value] of Object.entries(metrics ?? {})) {
      if ((key === name || key.endsWith(`.${name}`)) && value > 0) return value
    }
    const direct = payload[name]
    if (typeof direct === 'number' && Number.isFinite(direct) && direct > 0) return direct
    return undefined
  }
  const explicit = pick('speedup')
  if (explicit !== undefined) return explicit
  if (latencyMs === undefined || latencyMs <= 0) return undefined
  const ref = pick('ref_runtime_ms')
  return ref === undefined ? undefined : ref / latencyMs
}

/** String entries of an unknown array, each capped, the list capped. */
function stringList(value: unknown, entryCap = 300, listCap = 8): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    out.push(entry.length > entryCap ? `${entry.slice(0, entryCap)}…` : entry)
    if (out.length >= listCap) break
  }
  return out.length > 0 ? out : undefined
}

/**
 * Fill one iteration point from a parsed evaluator payload.
 * `includeEvaluatorId` is false for trailer payloads: on the self-reported
 * channel identity is the log seq — an agent-relayed id must not become one.
 */
function fillFromPayload(point: WireIteration, payload: Record<string, unknown>, includeEvaluatorId = true): void {
  if (includeEvaluatorId && typeof payload['evaluation_id'] === 'string') point.evaluationId = payload['evaluation_id']
  if (typeof payload['compiled'] === 'boolean') point.compiled = payload['compiled']
  if (typeof payload['correct'] === 'boolean') point.correct = payload['correct']
  const latency = payload['latency_ms']
  if (typeof latency === 'number' && Number.isFinite(latency)) point.latencyMs = latency
  const metrics = numericMetrics(payload['native_metrics'])
  if (metrics !== undefined) point.metrics = metrics
  const speedup = speedupFrom(metrics, payload, point.latencyMs)
  if (speedup !== undefined) point.speedup = speedup
  if (payload['reward_hack_detected'] === true) point.rewardHack = true
  if (typeof payload['error'] === 'string' && payload['error'].length > 0) point.error = payload['error']
  const blocking = stringList(payload['blocking'])
  if (blocking !== undefined) point.blocking = blocking
  const advisory = stringList(payload['advisory'])
  if (advisory !== undefined) point.advisory = advisory
  const notMeasured = stringList(payload['not_measured'])
  if (notMeasured !== undefined) point.notMeasured = notMeasured
  if (payload['evaluator_failed'] === true) point.evaluatorFailed = true
}

/** Wire caps for change payloads (a kernel file is a few KB; keep polls sane). */
const WRITE_CONTENT_CAP = 12_000
const EDIT_TEXT_CAP = 3_000
const CHANGES_PER_ITERATION_CAP = 8

/** Cap one text field, marking the change truncated when it cut. */
function capText(change: WireChange, text: string, cap: number): string {
  if (text.length <= cap) return text
  change.truncated = true
  return `${text.slice(0, cap)}…`
}

/** Command-line provenance cap on the wire. */
const COMMAND_CAP = 300

/** Cap a provenance command line. */
function capCommand(command: string): string {
  return command.length > COMMAND_CAP ? `${command.slice(0, COMMAND_CAP)}…` : command
}

/**
 * Build an iteration point from one contract trailer payload, or null when
 * the payload misses the contract's required fields (`artifact` + boolean
 * `correct`) — near-misses drop rather than render as noise rows.
 */
function trailerPoint(
  seq: number,
  tool: string,
  channel: 'shell' | 'replay',
  payload: Record<string, unknown>,
): WireIteration | null {
  const artifact = payload['artifact'] ?? payload['artifact_path']
  if (typeof artifact !== 'string' || artifact.length === 0) return null
  if (typeof payload['correct'] !== 'boolean') return null
  const point: WireIteration = { seq, tool, channel }
  point.artifactPath = artifact
  const subset = payload['workload_indices']
  if (Array.isArray(subset) && subset.every((n): n is number => typeof n === 'number') && subset.length > 0) {
    point.workloadSubset = subset
  }
  fillFromPayload(point, payload, false)
  return point
}

/** Provenance command named by a `[replay] ` line, when present. */
function replayCommand(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith(REPLAY_LINE_PREFIX)) {
      const command = trimmed.slice(REPLAY_LINE_PREFIX.length).trim()
      if (command.length > 0) return capCommand(command)
    }
  }
  return undefined
}

/**
 * Read a structured file-change call (`write` / `edit` arg shapes) into a
 * pending change record. Returns the target path alongside so the caller can
 * match it against the next evaluation's artifact.
 */
function changeSlice(call: CallSlice, seq: number): { path: string; change: WireChange } | null {
  const args = parseResultJson(call.argumentsJson)
  const path = args?.['file_path']
  if (args === null || typeof path !== 'string' || path.length === 0) return null
  const content = args['content']
  if (typeof content === 'string') {
    const change: WireChange = { seq, tool: call.name, kind: 'write' }
    change.content = capText(change, content, WRITE_CONTENT_CAP)
    return { path, change }
  }
  const oldText = args['old_string']
  const newText = args['new_string']
  if (typeof oldText === 'string' && typeof newText === 'string') {
    const change: WireChange = { seq, tool: call.name, kind: 'edit' }
    change.oldText = capText(change, oldText, EDIT_TEXT_CAP)
    change.newText = capText(change, newText, EDIT_TEXT_CAP)
    if (args['replace_all'] === true) change.replaceAll = true
    return { path, change }
  }
  return null
}

/** Plugin id whose `user/message` events carry the loop protocol texts. */
const LOOP_PLUGIN_ID = 'kernel-opt'

/**
 * Whether the log carries a direct human prompt: a `user/message` whose
 * source kind is `'user'` (plugin injections — including the loop's own
 * continuations — never count). The loop's arming gate: a loop started over
 * a session with no human task has nothing to continue, and telling the
 * model to "continue the original task" anyway primes it to invent one from
 * ambient filesystem state instead of asking.
 */
export function hasUserTask(events: readonly ProjectionEvent[]): boolean {
  return events.some((event) => {
    if (event.type !== 'user/message') return false
    const data = asRecord(event.data)
    if (data === null) return false
    const message = asRecord(data['message']) ?? data
    return asRecord(message['source'])?.['kind'] === 'user'
  })
}

/**
 * Parse a kernel-loop continuation/wrap-up/closing-audit message back out of
 * a `user/message` event. The message data is the logged UserMessage (a
 * `message` wrapper is accepted against shape drift); only plugin-sourced
 * messages carrying the loop's first-line prefixes qualify.
 */
function roundSlice(event: ProjectionEvent): WireRound | null {
  if (event.type !== 'user/message') return null
  const data = asRecord(event.data)
  if (data === null) return null
  const message = asRecord(data['message']) ?? data
  const source = asRecord(message['source'])
  if (source?.['kind'] !== 'plugin' || source['plugin'] !== LOOP_PLUGIN_ID) return null
  const text = collectResultText(message['content'])
  const wrapUp = text.startsWith(WRAPUP_LINE_PREFIX)
  const audit = text.startsWith(AUDIT_LINE_PREFIX)
  if (!wrapUp && !audit && !text.startsWith(LOOP_LINE_PREFIX)) return null
  const round: WireRound = { seq: event.seq }
  if (wrapUp) round.wrapUp = true
  if (audit) round.audit = true
  if (text.includes(CHALLENGE_LINE)) round.challenge = true
  const counters = /(\d+)\/(\d+) evaluations used/.exec(text)
  if (counters !== null) {
    round.evalsUsed = Number(counters[1])
    round.budget = Number(counters[2])
  }
  if (!wrapUp && !audit) {
    const num = /^\[kernel-loop round (\d+)\]/.exec(text)
    if (num !== null) round.round = Number(num[1])
  }
  const okAt = text.indexOf(REVIEW_OK_LINE)
  if (okAt >= 0) {
    round.review = 'ok'
    // The approval note rides the rest of that line.
    const note = text.slice(okAt + REVIEW_OK_LINE.length).split('\n')[0]?.trim() ?? ''
    if (note.length > 0) round.reviewNote = note
  } else {
    const headerAt = text.indexOf(REVIEW_HEADER)
    if (headerAt >= 0) {
      // The advice block runs until the message's own closing instructions —
      // each delivery kind has a fixed anchor line (continuation trailer,
      // wrap-up close, audit close); the earliest one present ends the block.
      const rest = text.slice(headerAt + REVIEW_HEADER.length)
      const ends = [CONTINUE_TRAILER, WRAPUP_CLOSE_LINE, AUDIT_CLOSE_LINE]
        .map(anchor => rest.indexOf(anchor)).filter(at => at >= 0)
      const advice = (ends.length > 0 ? rest.slice(0, Math.min(...ends)) : rest).trim()
      if (advice.length > 0) round.review = advice
    }
  }
  return round
}

/**
 * Project a session's events into the panel series.
 * @param sessionId - session the events came from (echoed on the wire).
 * @param events - the session log in seq order.
 * @param config - tool-name routing.
 * @returns the wire series (iterations/plans/profile marks/best index).
 */
export function project(
  sessionId: string,
  events: readonly ProjectionEvent[],
  config: ProjectionConfig = DEFAULT_PROJECTION,
): WireSeries {
  const iterations: WireIteration[] = []
  const plans: WirePlan[] = []
  const envs: WireEnv[] = []
  const profileSeqs: number[] = []
  const rounds: WireRound[] = []
  const finalizedIds = new Set<string>()
  /** Artifacts named by finalize calls (`artifact_path`), best point gets ⚑. */
  const finalizedArtifacts: string[] = []
  /** callId → pending bench iteration awaiting its result. */
  const pendingBench = new Map<string, WireIteration>()
  /** callId → shell-call provenance awaiting its result (trailer scan). */
  const pendingShell = new Map<string, { name: string; command?: string; readBack?: boolean }>()
  /** callId → id of the background job being read, awaiting its result. */
  const pendingJob = new Map<string, string>()
  /** Background job id → the shell command that launched it (provenance). */
  const jobCommands = new Map<string, string>()
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
  const trailerIndex = new Map<string, number>()
  /** Indices whose command came from a job announcement (the launching run). */
  const jobLaunched = new Set<number>()
  /** One entry per contract line that reached no collecting channel. */
  const uncollectedSeqs: number[] = []
  /** callId → tool name, so an unrecognised channel can still be named. */
  const callNames = new Map<string, string>()
  /** callId → finalize call awaiting its result (a replay trailer may ride it). */
  const pendingFinalize = new Map<string, { name: string }>()
  /** Structured file changes since the previous bench call, any path. */
  let pendingChanges: { path: string; change: WireChange }[] = []

  for (const event of events) {
    const round = roundSlice(event)
    if (round !== null) {
      rounds.push(round)
      continue
    }
    const call = callSlice(event)
    if (call !== null) {
      callNames.set(call.callId, call.name)
      if (call.name === config.planTool) {
        const args = parseResultJson(call.argumentsJson)
        if (args !== null && typeof args['phase'] === 'string' && typeof args['approach'] === 'string') {
          const plan: WirePlan = { seq: event.seq, phase: args['phase'], approach: args['approach'] }
          if (typeof args['hypothesis'] === 'string' && args['hypothesis'].length > 0) plan.hypothesis = args['hypothesis']
          if (typeof args['next'] === 'string' && args['next'].length > 0) plan.next = args['next']
          plans.push(plan)
        }
        continue
      }
      if (call.name === config.envTool) {
        const args = parseResultJson(call.argumentsJson)
        if (args !== null && typeof args['location'] === 'string' && typeof args['device'] === 'string') {
          const env: WireEnv = { seq: event.seq, location: args['location'], device: args['device'] }
          for (const key of ['constraint', 'probe', 'notes'] as const) {
            const value = args[key]
            if (typeof value === 'string' && value.length > 0) env[key] = value
          }
          const versions = asRecord(args['versions'])
          if (versions !== null) {
            const pairs: Record<string, string> = {}
            for (const [vName, value] of Object.entries(versions)) {
              if (typeof value === 'string' && value.length > 0) pairs[vName] = value
              else if (typeof value === 'number') pairs[vName] = String(value)
            }
            if (Object.keys(pairs).length > 0) env.versions = pairs
          }
          envs.push(env)
        }
        continue
      }
      if (matchesTool(call.name, config.profileTools)) {
        profileSeqs.push(event.seq)
        continue
      }
      if (matchesTool(call.name, config.finalizeTools)) {
        const args = parseResultJson(call.argumentsJson)
        const id = args?.['evaluation_id']
        if (typeof id === 'string') finalizedIds.add(id)
        const artifactRaw = args?.['artifact_path'] ?? args?.['artifact']
        if (typeof artifactRaw === 'string' && artifactRaw.length > 0) finalizedArtifacts.push(artifactRaw)
        pendingFinalize.set(call.callId, { name: call.name })
        continue
      }
      if (matchesTool(call.name, config.changeTools)) {
        const change = changeSlice(call, event.seq)
        if (change !== null) pendingChanges.push(change)
        continue
      }
      if (matchesTool(call.name, config.benchTools)) {
        const point: WireIteration = { seq: event.seq, tool: call.name, pending: true }
        const args = parseResultJson(call.argumentsJson)
        const artifactPath = args?.['artifact_path']
        if (typeof artifactPath === 'string' && artifactPath.length > 0) {
          point.artifactPath = artifactPath
          const matched = pendingChanges
            .filter(entry => samePath(entry.path, artifactPath))
            .map(entry => entry.change)
            .slice(-CHANGES_PER_ITERATION_CAP)
          if (matched.length > 0) point.changes = matched
        }
        const subset = args?.['workload_indices']
        if (Array.isArray(subset) && subset.every((n): n is number => typeof n === 'number')) {
          if (subset.length > 0) point.workloadSubset = subset
        }
        // Changes attribute to exactly one evaluation: the next one.
        pendingChanges = []
        iterations.push(point)
        pendingBench.set(call.callId, point)
      } else if (matchesTool(call.name, config.shellTools)) {
        const args = parseResultJson(call.argumentsJson)
        const command = args?.['command']
        if (typeof command === 'string' && matchesProfileCommand(command, config.profileCommands)) {
          // A profiler run may also be an evaluation (`ncu … python bench.py`
          // still prints its trailer); the mark is independent of the point.
          profileSeqs.push(event.seq)
        }
        pendingShell.set(call.callId, {
          name: call.name,
          // Judged on the full line, not the capped one the panel shows: the
          // cap elides the middle, and a run hidden there would read back as
          // a pure file read and have its measurement silently dropped.
          ...(typeof command === 'string' && isReadBackCommand(command) ? { readBack: true } : {}),
          ...(typeof command === 'string' && command.length > 0 ? { command: capCommand(command) } : {}),
        })
      } else if (matchesTool(call.name, config.jobTools)) {
        const args = parseResultJson(call.argumentsJson)
        const jobId = args?.['job_id']
        pendingJob.set(call.callId, typeof jobId === 'string' ? jobId : '')
      }
      continue
    }

    const result = resultSlice(event)
    if (result !== null) {
      const benchPoint = pendingBench.get(result.callId)
      if (benchPoint !== undefined) {
        pendingBench.delete(result.callId)
        delete benchPoint.pending
        const payload = parseResultJson(collectResultText(result.message))
        if (payload !== null) fillFromPayload(benchPoint, payload)
        continue
      }
      const finalize = pendingFinalize.get(result.callId)
      if (finalize !== undefined) {
        // A finalize result may carry the plugin's replay output: the replayed
        // command's trailer becomes the run's verified final measurement.
        pendingFinalize.delete(result.callId)
        const text = collectResultText(result.message)
        if (text.includes(EVAL_TRAILER_PREFIX)) {
          const command = replayCommand(text)
          for (const payload of trailerPayloads(text)) {
            const point = trailerPoint(event.seq, finalize.name, 'replay', payload)
            if (point === null) continue
            point.finalized = true
            if (command !== undefined) point.command = command
            iterations.push(point)
          }
        }
        continue
      }
      const shell = pendingShell.get(result.callId)
      if (shell !== undefined) {
        pendingShell.delete(result.callId)
        const text = collectResultText(result.message)
        // A shell call that went to the background names the job it started.
        // Its measurements arrive later through the job reader, and the
        // command has to travel with them or the point loses its provenance.
        const announced = BACKGROUND_JOB_ANNOUNCE.exec(text)
        const announcedId = announced?.[1]
        if (announcedId !== undefined && shell.command !== undefined) {
          jobCommands.set(announcedId, shell.command)
        }
        if (!text.includes(EVAL_TRAILER_PREFIX)) continue
        // Reading a bench log back is not a second measurement.
        if (shell.readBack === true) continue
        let consumed = false
        for (const payload of trailerPayloads(text)) {
          const key = JSON.stringify(payload)
          if (trailerIndex.has(key)) continue
          const point = trailerPoint(event.seq, shell.name, 'shell', payload)
          if (point === null) continue
          if (shell.command !== undefined) point.command = shell.command
          trailerIndex.set(key, iterations.length)
          const artifact = point.artifactPath
          if (artifact !== undefined) {
            const matched = pendingChanges
              .filter(entry => samePath(entry.path, artifact))
              .map(entry => entry.change)
              .slice(-CHANGES_PER_ITERATION_CAP)
            if (matched.length > 0) point.changes = matched
          }
          iterations.push(point)
          consumed = true
        }
        // Changes attribute to exactly one evaluation: the next one — but a
        // shell call that carried no evaluation leaves them pending.
        if (consumed) pendingChanges = []
        continue
      }
      const jobId = pendingJob.get(result.callId)
      if (jobId !== undefined) {
        pendingJob.delete(result.callId)
        const text = collectResultText(result.message)
        if (!text.includes(EVAL_TRAILER_PREFIX)) continue
        const command = jobCommands.get(jobId)
        let consumed = false
        for (const payload of trailerPayloads(text)) {
          // One measurement, one point: a poll that re-reads output already
          // collected must not enter the curve twice.
          const key = JSON.stringify(payload)
          const prior = trailerIndex.get(key)
          if (prior !== undefined) {
            // The same line already arrived on a plain shell result, which for
            // a job's own output means it was FETCHED — from a log tail, a
            // cloud log command, wherever the run puts its output. This branch
            // knows the command that launched the run, so hand the existing
            // point the better provenance and still keep one point.
            if (command !== undefined && !jobLaunched.has(prior)) {
              const existing = iterations[prior]
              if (existing !== undefined) existing.command = command
              jobLaunched.add(prior)
            }
            continue
          }
          const point = trailerPoint(event.seq, jobId, 'shell', payload)
          if (point === null) continue
          if (command !== undefined) {
            point.command = command
            jobLaunched.add(iterations.length)
          }
          trailerIndex.set(key, iterations.length)
          const artifact = point.artifactPath
          if (artifact !== undefined) {
            const matched = pendingChanges
              .filter(entry => samePath(entry.path, artifact))
              .map(entry => entry.change)
              .slice(-CHANGES_PER_ITERATION_CAP)
            if (matched.length > 0) point.changes = matched
          }
          iterations.push(point)
          consumed = true
        }
        if (consumed) pendingChanges = []
        continue
      }
      // Last net: a contract line in a channel none of the branches above
      // claimed. Nothing to collect it, so at least refuse to be silent —
      // an empty curve beside real measurements is indistinguishable, to the
      // human, from an agent that measured nothing.
      const toolName = callNames.get(result.callId)
      if (toolName !== undefined && !TEXT_READING_TOOLS.has(toolName)) {
        const text = collectResultText(result.message)
        if (text.includes(EVAL_TRAILER_PREFIX)) {
          for (const _payload of trailerPayloads(text)) uncollectedSeqs.push(event.seq)
        }
      }
    }
  }

  for (const point of iterations) {
    if (point.evaluationId !== undefined && finalizedIds.has(point.evaluationId)) point.finalized = true
  }

  // Artifact-named finalizes (the self-reported channel has no evaluator ids):
  // the best honest measurement of that artifact carries the ⚑.
  for (const artifact of finalizedArtifacts) {
    let best: WireIteration | undefined
    for (const point of iterations) {
      if (point.channel === 'replay') continue
      if (point.artifactPath === undefined || !samePath(point.artifactPath, artifact)) continue
      if (point.correct !== true || point.rewardHack === true || point.error !== undefined) continue
      if (point.latencyMs === undefined) continue
      if (best?.latencyMs === undefined || point.latencyMs < best.latencyMs) best = point
    }
    if (best !== undefined) best.finalized = true
  }

  let bestIndex: number | null = null
  for (let i = 0; i < iterations.length; i += 1) {
    const point = iterations[i]
    if (point === undefined) continue
    if (point.correct !== true || point.rewardHack === true || point.error !== undefined) continue
    if (point.latencyMs === undefined) continue
    const best = bestIndex === null ? undefined : iterations[bestIndex]
    if (best?.latencyMs === undefined || point.latencyMs < best.latencyMs) bestIndex = i
  }

  return { sessionId, updatedAt: Date.now(), iterations, plans, envs, profileSeqs, uncollectedSeqs, rounds, bestIndex }
}
