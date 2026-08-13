/**
 * Pure projection from a session's logged events to the cockpit wire series.
 * The session log is the only truth: nothing here subscribes or stores state —
 * callers re-run the projection per query, so live views, reloads, and replay
 * all agree by construction.
 * @module
 */
import type { WireIteration, WirePlan, WireSeries } from './wire.ts'

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
}

/** Defaults target the AKO runtime MCP tools plus this plugin's own tools. */
export const DEFAULT_PROJECTION: ProjectionConfig = {
  benchTools: ['kernel_evaluate'],
  profileTools: ['kernel_profile'],
  finalizeTools: ['run_finalize'],
  planTool: 'cockpit_plan',
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
  const finalizedIds = new Set<string>()
  /** callId → pending bench iteration awaiting its result. */
  const pendingBench = new Map<string, WireIteration>()

  for (const event of events) {
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
      if (matchesTool(call.name, config.benchTools)) {
        const point: WireIteration = { seq: event.seq, tool: call.name, pending: true }
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

  return { sessionId, updatedAt: Date.now(), iterations, plans, profileSeqs, bestIndex }
}
