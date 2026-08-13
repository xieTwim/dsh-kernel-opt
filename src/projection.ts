/**
 * Pure projection from a session's logged events to the cockpit wire series.
 * The session log is the only truth: nothing here subscribes or stores state —
 * callers re-run the projection per query, so live views, reloads, and replay
 * all agree by construction.
 * @module
 */
import type { WireChange, WireIteration, WirePlan, WireRound, WireSeries } from './wire.ts'
import {
  CONTINUE_TRAILER, LOOP_LINE_PREFIX, REVIEW_HEADER, REVIEW_OK_LINE, WRAPUP_LINE_PREFIX,
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
  /** Match list for finalize calls (their `evaluation_id` marks a point ★). */
  readonly finalizeTools: readonly string[]
  /** Exact name of the plan tool. */
  readonly planTool: string
  /** Match list for structured file-change tools (write/edit shapes). */
  readonly changeTools: readonly string[]
}

/** Defaults target the AKO runtime MCP tools plus the host's tool-fs pair. */
export const DEFAULT_PROJECTION: ProjectionConfig = {
  benchTools: ['kernel_evaluate'],
  profileTools: ['kernel_profile'],
  finalizeTools: ['run_finalize'],
  planTool: 'cockpit_plan',
  changeTools: ['write', 'edit'],
}

/**
 * Whether a logged tool name matches a configured name: exact, or as a suffix
 * behind a separator (MCP registrations may prefix the server name, e.g.
 * `ako__kernel_evaluate`).
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
 * explicit `speedup` metric wins; else a `ref_runtime_ms` metric divided by
 * the measured latency. Returns undefined when the evaluator reported neither.
 */
function speedupFrom(metrics: Record<string, number> | undefined, latencyMs: number | undefined): number | undefined {
  if (metrics === undefined) return undefined
  for (const [key, value] of Object.entries(metrics)) {
    if ((key === 'speedup' || key.endsWith('.speedup')) && value > 0) return value
  }
  if (latencyMs === undefined || latencyMs <= 0) return undefined
  for (const [key, value] of Object.entries(metrics)) {
    if ((key === 'ref_runtime_ms' || key.endsWith('.ref_runtime_ms')) && value > 0) return value / latencyMs
  }
  return undefined
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

/** Fill one iteration point from a parsed evaluator payload. */
function fillFromPayload(point: WireIteration, payload: Record<string, unknown>): void {
  if (typeof payload['evaluation_id'] === 'string') point.evaluationId = payload['evaluation_id']
  if (typeof payload['compiled'] === 'boolean') point.compiled = payload['compiled']
  if (typeof payload['correct'] === 'boolean') point.correct = payload['correct']
  const latency = payload['latency_ms']
  if (typeof latency === 'number' && Number.isFinite(latency)) point.latencyMs = latency
  const metrics = numericMetrics(payload['native_metrics'])
  if (metrics !== undefined) point.metrics = metrics
  const speedup = speedupFrom(metrics, point.latencyMs)
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

/** Whether two logged paths plausibly address the same file. */
function samePath(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
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
const LOOP_PLUGIN_ID = 'kernel-cockpit'

/**
 * Parse a kernel-loop continuation/wrap-up message back out of a
 * `user/message` event. The message data is the logged UserMessage (a
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
  if (!wrapUp && !text.startsWith(LOOP_LINE_PREFIX)) return null
  const round: WireRound = { seq: event.seq }
  if (wrapUp) round.wrapUp = true
  const counters = /(\d+)\/(\d+) evaluations used/.exec(text)
  if (counters !== null) {
    round.evalsUsed = Number(counters[1])
    round.budget = Number(counters[2])
  }
  if (!wrapUp) {
    const num = /^\[kernel-loop round (\d+)\]/.exec(text)
    if (num !== null) round.round = Number(num[1])
  }
  if (text.includes(REVIEW_OK_LINE)) {
    round.review = 'ok'
  } else {
    const headerAt = text.indexOf(REVIEW_HEADER)
    if (headerAt >= 0) {
      const rest = text.slice(headerAt + REVIEW_HEADER.length)
      const trailerAt = rest.indexOf(CONTINUE_TRAILER)
      const advice = (trailerAt >= 0 ? rest.slice(0, trailerAt) : rest).trim()
      if (advice.length > 0) round.review = advice
    }
  }
  return round
}

/**
 * Project a session's events into the cockpit series.
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
  const profileSeqs: number[] = []
  const rounds: WireRound[] = []
  const finalizedIds = new Set<string>()
  /** callId → pending bench iteration awaiting its result. */
  const pendingBench = new Map<string, WireIteration>()
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
      if (matchesTool(call.name, config.profileTools)) {
        profileSeqs.push(event.seq)
        continue
      }
      if (matchesTool(call.name, config.finalizeTools)) {
        const args = parseResultJson(call.argumentsJson)
        const id = args?.['evaluation_id']
        if (typeof id === 'string') finalizedIds.add(id)
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
      }
      continue
    }

    const result = resultSlice(event)
    if (result !== null) {
      const point = pendingBench.get(result.callId)
      if (point === undefined) continue
      pendingBench.delete(result.callId)
      delete point.pending
      const payload = parseResultJson(collectResultText(result.message))
      if (payload !== null) fillFromPayload(point, payload)
    }
  }

  for (const point of iterations) {
    if (point.evaluationId !== undefined && finalizedIds.has(point.evaluationId)) point.finalized = true
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

  return { sessionId, updatedAt: Date.now(), iterations, plans, profileSeqs, rounds, bestIndex }
}
