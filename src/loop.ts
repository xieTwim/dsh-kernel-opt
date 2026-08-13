/**
 * Kernel-opt loop: run-state-driven turn continuation, with an optional
 * second-model supervisor reviewed at each continuation point.
 *
 * The loop is not a wall-clock timer: it re-drives the agent only when a turn
 * has settled AND the projected run state says the run is unfinished — budget
 * remaining, no finalize recorded, and the last round made progress. The
 * supervisor is a one-shot `ctx.llm.stream()` call over a compact digest of
 * the projected series; its advice rides the continuation message, and any
 * supervisor failure degrades to "no advice", never a stalled loop.
 * @module
 */
import type { WireIteration, WireSeries } from './wire.ts'
import {
  CONTINUE_TRAILER, LOOP_LINE_PREFIX, REVIEW_HEADER, REVIEW_OK_LINE, WRAPUP_LINE_PREFIX,
} from './wire.ts'

/** Per-session loop control state (in-memory; the loop is a live-run aid). */
export interface LoopState {
  /** Whether the loop re-drives the agent at turn settle. */
  armed: boolean
  /** Evaluation budget the run was armed with. */
  budget: number
  /** Continuations delivered so far. */
  round: number
  /** Completed-evaluation count at the previous continuation. */
  lastEvalCount: number
  /** Consecutive continuations that produced no new completed evaluation. */
  noProgressRounds: number
  /** Why the loop disarmed, for the panel (undefined while armed/never armed). */
  stopReason?: 'finalized' | 'budget' | 'no-progress' | 'stopped'
  /** Whether the supervisor reviews at continuation points. */
  supervise: boolean
  /** Last supervisor advice delivered (panel display). */
  lastAdvice?: string
}

/** A fresh disarmed state. */
export function initialLoopState(): LoopState {
  return { armed: false, budget: 0, round: 0, lastEvalCount: 0, noProgressRounds: 0, supervise: false }
}

/** Completed (non-pending) evaluations in a projected series. */
export function completedEvals(series: WireSeries): number {
  return series.iterations.filter(p => p.pending !== true).length
}

/**
 * What the loop should do at one settled-turn checkpoint. A `wrap-up`
 * disarms like a stop, but first delivers one closing message asking the
 * model to finalize its best honest result — budget exhaustion and stalling
 * end with a clean finish, never a silent power-cut.
 */
export type LoopDecision =
  | { action: 'continue'; evalsDone: number }
  | { action: 'wrap-up'; reason: 'budget' | 'no-progress'; evalsDone: number }
  | { action: 'stop'; reason: 'finalized'; evalsDone: number }

/**
 * Decide continuation from the projected run state. Pure — the caller owns
 * state mutation and delivery.
 * @param series - current projection of the session log.
 * @param state - loop state as of the previous checkpoint.
 * @param maxNoProgressRounds - consecutive empty rounds tolerated before stopping.
 * @returns the decision and the completed-evaluation count it was based on.
 */
export function decideContinuation(
  series: WireSeries,
  state: LoopState,
  maxNoProgressRounds: number,
): LoopDecision {
  const evalsDone = completedEvals(series)
  if (series.iterations.some(p => p.finalized === true)) {
    return { action: 'stop', reason: 'finalized', evalsDone }
  }
  if (evalsDone >= state.budget) {
    return { action: 'wrap-up', reason: 'budget', evalsDone }
  }
  if (state.round > 0 && evalsDone <= state.lastEvalCount
    && state.noProgressRounds + 1 >= maxNoProgressRounds) {
    return { action: 'wrap-up', reason: 'no-progress', evalsDone }
  }
  return { action: 'continue', evalsDone }
}

/** One line of the digest table handed to the supervisor. */
function digestRow(point: WireIteration, index: number, bestIndex: number | null): string {
  const status = point.pending === true
    ? 'pending'
    : point.rewardHack === true
      ? 'REWARD-HACK'
      : point.error !== undefined
        ? `error: ${point.error.slice(0, 80)}`
        : point.correct === true ? 'ok' : 'WRONG'
  const latency = point.latencyMs !== undefined ? `${point.latencyMs}ms` : '—'
  const star = point.finalized === true ? ' ★finalized' : ''
  const best = bestIndex === index ? ' ←best' : ''
  return `#${String(index + 1)} ${point.evaluationId ?? '?'} ${latency} ${status}${star}${best}`
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
export function supervisorDigest(series: WireSeries, state: LoopState, tail = 10): string {
  const evalsDone = completedEvals(series)
  const lines: string[] = [
    `Budget: ${String(evalsDone)}/${String(state.budget)} evaluations used; continuation round ${String(state.round)}.`,
  ]
  const plans = series.plans.slice(-3)
  if (plans.length > 0) {
    lines.push('Recent plans (oldest first):')
    for (const plan of plans) {
      lines.push(`- [${plan.phase}] ${plan.approach}${plan.hypothesis !== undefined ? ` — ${plan.hypothesis}` : ''}`)
    }
  } else {
    lines.push('No cockpit_plan reports yet.')
  }
  const from = Math.max(0, series.iterations.length - tail)
  lines.push(`Iterations ${String(from + 1)}..${String(series.iterations.length)}:`)
  for (let i = from; i < series.iterations.length; i += 1) {
    const point = series.iterations[i]
    if (point !== undefined) lines.push(digestRow(point, i, series.bestIndex))
  }
  return lines.join('\n')
}

/** System rubric for the supervisor model. */
export const SUPERVISOR_SYSTEM = [
  'You supervise a kernel-optimization agent. You see a digest of its run: budget, its stated plans, and the evaluation table.',
  'Judge ONLY loop discipline, not kernel code:',
  '- correctness first: WRONG or REWARD-HACK rows are failures, not progress;',
  '- budget discipline: repeated evaluations of one idea without a stated hypothesis waste budget;',
  '- approach diversity: several consecutive failures of one family should trigger a family switch;',
  '- plan hygiene: plans should exist and match what the table shows;',
  '- finishing: near budget exhaustion the agent should finalize its best honest result.',
  'If the run looks healthy, reply exactly OK.',
  'Otherwise reply with at most 3 short imperative sentences of advice. No preamble, no code.',
].join('\n')

/** Strip a supervisor reply to advice, or null when it approves or is empty. */
export function adviceFromReply(reply: string): string | null {
  const text = reply.trim()
  if (text.length === 0) return null
  if (/^ok[.!]?$/i.test(text)) return null
  return text.length > 600 ? `${text.slice(0, 600)}…` : text
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
 * @returns the followup text.
 */
export function continuationText(
  round: number,
  evalsDone: number,
  budget: number,
  advice: string | null,
  reviewedOk = false,
): string {
  const lines = [
    `${LOOP_LINE_PREFIX}${String(round)}] ${String(evalsDone)}/${String(budget)} evaluations used.`,
  ]
  if (advice !== null) {
    lines.push('', REVIEW_HEADER, advice)
  } else if (reviewedOk) {
    lines.push('', REVIEW_OK_LINE)
  }
  lines.push(
    '',
    `${CONTINUE_TRAILER}: analyse the latest result, state the plan with cockpit_plan if it changed, improve solution.py, and evaluate again.`,
    'If you are done or the remaining budget cannot beat the current best, call run_finalize with the evaluation_id you stand behind, then summarize.',
  )
  return lines.join('\n')
}

/**
 * Wrap-up message body: the loop's one closing delivery before it disarms on
 * budget exhaustion or stalling. Asks for a finalize of the best honest
 * result — never for new optimization work.
 * @param evalsDone - completed evaluations at the stop decision.
 * @param budget - armed budget.
 * @param reason - why the loop is ending.
 * @returns the followup text.
 */
export function wrapUpText(evalsDone: number, budget: number, reason: 'budget' | 'no-progress'): string {
  return [
    `${WRAPUP_LINE_PREFIX} ${String(evalsDone)}/${String(budget)} evaluations used; stopping (${reason}).`,
    '',
    'The kernel loop is ending — do not start new optimization work.',
    'If an honest best result exists, call run_finalize with its evaluation_id now.',
    'Then summarize the run: best result, what worked, what failed, and what a future attempt should try first.',
  ].join('\n')
}
