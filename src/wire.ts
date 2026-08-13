/**
 * Wire types and protocol constants shared by the Node half (series/control
 * routes, loop texts) and the browser half (cockpit panel). The continuation
 * message anchors live here because they are a two-sided protocol: `loop.ts`
 * builds continuation/wrap-up texts around them, and `projection.ts` parses
 * the same texts back out of the session log.
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
  /**
   * Speedup vs the benchmark's reference kernel, taken from the evaluator's
   * own numbers (an explicit `speedup` metric, else `ref_runtime_ms` ÷
   * latency); absent when the evaluator reported neither.
   */
  speedup?: number
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
  /** Blocking build-gate findings forwarded from the evaluator. */
  blocking?: string[]
  /** Advisory build-gate findings forwarded from the evaluator. */
  advisory?: string[]
  /** Fields the evaluator explicitly named as not measured. */
  notMeasured?: string[]
  /** The evaluator itself failed — no verdict on the kernel exists. */
  evaluatorFailed?: boolean
  /** Workload subset requested on the call, when not a full evaluation. */
  workloadSubset?: number[]
  /** Artifact path passed to the evaluation call. */
  artifactPath?: string
  /** Structured artifact edits logged since the previous evaluation call. */
  changes?: WireChange[]
  /**
   * How the measurement entered the log. Absent = a registered/MCP tool
   * result (not forgeable by the agent). `'shell'` = a contract trailer line
   * parsed out of a shell tool's output — agent-relayed, so self-reported;
   * judge it with `command`. `'replay'` = the plugin re-executed the recorded
   * command itself at finalize (not agent-relayed).
   */
  channel?: 'shell' | 'replay'
  /** Command line that produced this point (shell/replay channels). */
  command?: string
}

/**
 * One logged `write`/`edit` tool call against the evaluated artifact,
 * attributed to the evaluation that followed it.
 */
export interface WireChange {
  /** Session-log seq of the change call. */
  seq: number
  /** Tool name as logged. */
  tool: string
  kind: 'write' | 'edit'
  /** Full file content for writes (possibly truncated). */
  content?: string
  /** Replaced text for edits (possibly truncated). */
  oldText?: string
  /** Replacement text for edits (possibly truncated). */
  newText?: string
  /** The edit had `replace_all` set. */
  replaceAll?: boolean
  /** Some text field was cut at the wire cap. */
  truncated?: boolean
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

/**
 * One kernel-loop message parsed back from the session log: a continuation
 * round or the final wrap-up. Durable — survives restarts and replays, unlike
 * the in-memory control state.
 */
export interface WireRound {
  /** Session-log seq of the delivered message. */
  seq: number
  /** 1-based continuation round (absent on wrap-up messages). */
  round?: number
  /** Completed evaluations at delivery. */
  evalsUsed?: number
  /** Armed budget at delivery. */
  budget?: number
  /**
   * Supervisor outcome for the round: `'ok'` when it reviewed and approved,
   * the advice text when it objected, absent when no review ran.
   */
  review?: string
  /** This message was the wrap-up delivery (budget / no-progress ending). */
  wrapUp?: boolean
}

/** Loop + supervisor control state for the panel. */
export interface WireControl {
  loop: {
    /** Whether the kernel loop re-drives this session at turn settle. */
    armed: boolean
    /** Armed evaluation budget. */
    budget: number
    /** Continuations delivered so far. */
    round: number
    /** Completed evaluations at last projection. */
    evalsDone: number
    /** Why the loop disarmed, when it did. */
    stopReason?: string
    /** Whether the loop machinery is composed (commands/llm present). */
    available: boolean
  }
  supervisor: {
    /** Whether reviews run at continuation points (per-session toggle). */
    enabled: boolean
    /** Whether a supervisor model is configured at all (plugin config). */
    configured: boolean
    /** Last delivered advice, for display. */
    lastAdvice?: string
  }
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
  /** Kernel-loop continuation/wrap-up messages in log order. */
  rounds: WireRound[]
  /** Index into `iterations` of the best honest measurement, if any. */
  bestIndex: number | null
  /** Loop/supervisor state when the cockpit loop is present for this session. */
  control?: WireControl
}

/**
 * Whether two logged paths plausibly address the same file (exact, or one is
 * the other's path suffix). Shared protocol helper: the projection matches
 * changes/finalizes with it and the panel matches replay coverage.
 */
export function samePath(a: string, b: string): boolean {
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)
}

/**
 * Id of the bundled「算子优化模式」agent preset the Node half seeds into the
 * user preset root. Shared constant: sessions composed from this preset id
 * always show the cockpit tab (before any evaluation lands).
 */
export const PRESET_ID = 'kernel-opt'

/** Route the Node half serves and the panel polls (query: `?sessionId=`). */
export const SERIES_PATH = '/plugins/kernel-cockpit/series'

/**
 * Control route (POST): `{ sessionId, action, budget? }` with action one of
 * `loop-arm` / `loop-stop` / `supervise-on` / `supervise-off`. Responds with
 * the fresh {@link WireControl}. The slash commands remain the scriptable
 * twin of the same state.
 */
export const CONTROL_PATH = '/plugins/kernel-cockpit/control'

/**
 * Prefix of the evaluation contract trailer line. Any evaluation pipeline —
 * whatever it does internally — participates in the cockpit by printing one
 * line to stdout:
 *
 * `KERNEL_COCKPIT_EVAL={"artifact":"solution/k.py","latency_ms":1.23,"correct":true}`
 *
 * Required: `artifact` (which file this measures) and `correct`; `latency_ms`
 * whenever the run was timed. Optional: `compiled`, `error`, `native_metrics`
 * (numeric map; `speedup`/`ref_runtime_ms` feed the speedup column),
 * `reward_hack_detected`, `workload_indices`. One line per evaluation. This is
 * a public contract — published scripts print it, so it must never change.
 */
export const EVAL_TRAILER_PREFIX = 'KERNEL_COCKPIT_EVAL='

/**
 * Line the Node half writes into a `cockpit_finalize` tool result naming the
 * command it replayed; the projection reads it back as the replay point's
 * provenance.
 */
export const REPLAY_LINE_PREFIX = '[cockpit-replay] '

/** First-line prefix of a continuation message (`round N` follows). */
export const LOOP_LINE_PREFIX = '[kernel-loop round '
/** First-line prefix of the wrap-up message. */
export const WRAPUP_LINE_PREFIX = '[kernel-loop wrap-up]'
/** Header line introducing a supervisor advice block. */
export const REVIEW_HEADER = 'Supervisor review (advisory, from the second model):'
/** Whole line recording that the supervisor reviewed and approved. */
export const REVIEW_OK_LINE = 'Supervisor review: OK.'
/** Start of the fixed trailer paragraph (terminates the advice block). */
export const CONTINUE_TRAILER = 'Continue optimizing per the original task'
