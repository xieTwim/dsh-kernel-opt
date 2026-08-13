/**
 * Wire types shared by the Node half (series route) and the browser half
 * (cockpit panel). Pure types — no runtime code.
 * @module
 */

/** One kernel evaluation (bench call) projected from the session log. */
export interface WireIteration {
  /** Session-log seq of the `tool/call` event (stable identity + ordering). */
  seq: number
  /** Tool name as logged (MCP tools keep their server prefix). */
  tool: string
  /** Evaluator-assigned id (e.g. `"0007"`) when the result carried one. */
  evaluationId?: string
  /** Whether the artifact compiled; absent while pending or unparsable. */
  compiled?: boolean
  /** Evaluator correctness verdict; absent while pending or not measured. */
  correct?: boolean
  /** Wall latency in milliseconds; absent when not measured. */
  latencyMs?: number
  /** Numeric extras forwarded from the evaluator (`native_metrics`). */
  metrics?: Record<string, number>
  /** The evaluator flagged a replay / reward-hack detector. */
  rewardHack?: boolean
  /** Evaluator-reported error message when the run failed. */
  error?: string
  /** Call logged but result not yet — evaluation in flight. */
  pending?: boolean
  /** This evaluation was later selected by a finalize call. */
  finalized?: boolean
}

/** One `cockpit_plan` call — the model's stated plan at that point. */
export interface WirePlan {
  /** Session-log seq of the plan call. */
  seq: number
  /** Loop phase, e.g. explore / tune / verify. */
  phase: string
  /** One-line description of the current approach. */
  approach: string
  /** Why this approach should be faster. */
  hypothesis?: string
  /** Immediate next action. */
  next?: string
}

/** Series payload served at the cockpit route for one session. */
export interface WireSeries {
  /** Session the series was projected from. */
  sessionId: string
  /** Server time of the projection (ms epoch). */
  updatedAt: number
  /** Evaluations in log order. */
  iterations: WireIteration[]
  /** Plan reports in log order (latest last). */
  plans: WirePlan[]
  /** seqs of profile-tool calls (event markers between iterations). */
  profileSeqs: number[]
  /** Index into `iterations` of the best honest measurement, if any. */
  bestIndex: number | null
}

/** Route the Node half serves and the panel polls (query: `?sessionId=`). */
export const SERIES_PATH = '/plugins/kernel-cockpit/series'
