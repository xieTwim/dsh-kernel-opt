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
  AUDIT_CLOSE_LINE, AUDIT_LINE_PREFIX, CONTINUE_TRAILER, LOOP_LINE_PREFIX,
  REVIEW_HEADER, REVIEW_OK_LINE, WRAPUP_CLOSE_LINE, WRAPUP_LINE_PREFIX,
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
  /** Session-level supervisor route override (wins over plugin config). */
  supervisorOverride?: { provider: string; model: string }
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
 * Whether a supervisor review of this run would carry any signal. Without a
 * single evaluation or stated plan the digest is an empty table — a review
 * would spend a supervisor call solemnly approving nothing and mint a phantom
 * "round 1 OK" record every time a fresh session is armed.
 */
export function reviewable(series: WireSeries): boolean {
  return series.iterations.length > 0 || series.plans.length > 0
}

/**
 * Whether evaluations exist that no delivered review has seen: rows logged
 * after the last review-carrying loop message, or any rows when no review
 * ever ran. The closing audit fires on this — a run the agent finishes in a
 * single turn has its only checkpoint after the finalize, so without the
 * audit the supervisor would never speak at all.
 */
export function unreviewedEvals(series: WireSeries): boolean {
  let lastReviewSeq = -1
  for (const round of series.rounds) {
    if (round.review !== undefined) lastReviewSeq = round.seq
  }
  return series.iterations.some(p => p.seq > lastReviewSeq)
}

/**
 * Completed evaluations since the best honest measurement — the run's
 * stagnation streak. All completed evaluations count when no best exists yet.
 */
export function stagnationCount(series: WireSeries): number {
  let count = 0
  for (let i = series.iterations.length - 1; i >= 0; i -= 1) {
    if (series.bestIndex !== null && i <= series.bestIndex) break
    const point = series.iterations[i]
    if (point !== undefined && point.pending !== true) count += 1
  }
  return count
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
  const channel = point.channel !== undefined ? ` [${point.channel}]` : ''
  const command = point.command !== undefined
    ? ` cmd:"${point.command.length > 60 ? `${point.command.slice(0, 60)}…` : point.command}"`
    : ''
  return `#${String(index + 1)} ${point.evaluationId ?? '?'} ${latency} ${status}${star}${best}${channel}${command}`
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
  const stagnant = stagnationCount(series)
  if (stagnant >= 3) lines.push(`Stagnation: ${String(stagnant)} evaluations since the last improvement.`)
  const shellCount = series.iterations.filter(p => p.channel === 'shell').length
  if (shellCount > 0) {
    lines.push(`Provenance: ${String(shellCount)}/${String(series.iterations.length)} evaluations are self-reported `
      + '(parsed from agent-run shell output; cmd shown per row). A row whose cmd is not a benchmark invocation is fabricated.')
  }
  const plans = series.plans.slice(-3)
  if (plans.length > 0) {
    lines.push('Recent plans (oldest first):')
    for (const plan of plans) {
      lines.push(`- [${plan.phase}] ${plan.approach}${plan.hypothesis !== undefined ? ` — ${plan.hypothesis}` : ''}`)
    }
  } else {
    lines.push('No kernel_plan reports yet.')
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
  '- provenance: on [shell] rows the trajectory is self-reported — judge whether each cmd is a real benchmark invocation and whether the numbers move like real measurements;',
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
 * @returns the followup text.
 */
export function continuationText(
  round: number,
  evalsDone: number,
  budget: number,
  advice: string | null,
  reviewedOk = false,
  stagnant = 0,
  finalizeHint = 'run_finalize / kernel_finalize',
  taskKnown = true,
  planKnown = true,
  evalsPerTurn = 0,
): string {
  const lines = [
    `${LOOP_LINE_PREFIX}${String(round)}] ${String(evalsDone)}/${String(budget)} evaluations used.`,
  ]
  if (stagnant >= 3) {
    lines.push(`Note: ${String(stagnant)} evaluations since the last improvement — consider re-profiling or `
      + 'switching approach family before spending more budget on the current line.')
  }
  if (advice !== null) {
    lines.push('', REVIEW_HEADER, advice)
  } else if (reviewedOk) {
    lines.push('', REVIEW_OK_LINE)
  }
  if (taskKnown) {
    lines.push(
      '',
      `${CONTINUE_TRAILER}: analyse the latest result, state the plan with kernel_plan if it changed, improve the kernel, and evaluate again.`,
    )
    if (!planKnown) {
      lines.push('No kernel_plan is on record yet — report your resolved plan with it (phase, approach, hypothesis) before evaluating further.')
    }
    lines.push(
      `If you are done or the remaining budget cannot beat the current best, finalize the result you stand behind (${finalizeHint}), then summarize.`,
    )
  } else {
    lines.push(
      '',
      `${CONTINUE_TRAILER}: the conversation carries no task yet. Inventory the WORKING DIRECTORY for the `
      + 'task the user prepared (prompt/task files, kernels, bench scripts) and start from what you find, '
      + 'reporting your resolved plan with kernel_plan before the first evaluation. '
      + 'If the workspace carries no task either, ask the user what to optimize and stop — never adopt '
      + 'anything found outside the working directory.',
    )
  }
  if (evalsPerTurn > 0) {
    lines.push(
      `Pace: complete at most ${String(evalsPerTurn)} evaluations this turn, then settle and report — `
      + 'the loop reviews progress and drives you onward; do not finalize early just because the turn ends.',
    )
  }
  return lines.join('\n')
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
export function wrapUpText(
  evalsDone: number,
  budget: number,
  reason: 'budget' | 'no-progress',
  finalizeHint = 'run_finalize / kernel_finalize',
  advice: string | null = null,
  reviewedOk = false,
): string {
  const lines = [
    `${WRAPUP_LINE_PREFIX} ${String(evalsDone)}/${String(budget)} evaluations used; stopping (${reason}).`,
  ]
  if (advice !== null) {
    lines.push('', REVIEW_HEADER, advice)
  } else if (reviewedOk) {
    lines.push('', REVIEW_OK_LINE)
  }
  lines.push(
    '',
    `${WRAPUP_CLOSE_LINE} — do not start new optimization work.`,
    `If an honest best result exists, finalize it now (${finalizeHint}; pass the evaluation_id from your evaluator, or the artifact path for kernel_finalize).`,
    'Restore the best artifact verbatim first if a later edit regressed it.',
    'Then summarize the run: best result, what worked, what failed, and what a future attempt should try first.',
  )
  return lines.join('\n')
}

/**
 * Closing-audit message body: delivered once when a finalized run still
 * carries evaluations the supervisor never reviewed (a single-turn run's only
 * checkpoint lands after the finalize). An approving verdict just closes the
 * run on the record; findings give the agent one bounded chance to verify or
 * correct the finalized result — the loop stays disarmed either way, so the
 * reply turn is never re-driven.
 * @param advice - supervisor advice, or null when it approved.
 * @returns the followup text.
 */
export function finalAuditText(advice: string | null): string {
  const lines = [`${AUDIT_LINE_PREFIX} the run has finalized; the supervisor audited the final table.`]
  if (advice !== null) {
    lines.push(
      '', REVIEW_HEADER, advice,
      '',
      `${AUDIT_CLOSE_LINE}: verify or correct the finalized result (re-finalize if the artifact changes), then close with a short note.`,
      'Do not start new optimization work beyond what the findings require.',
    )
  } else {
    lines.push('', REVIEW_OK_LINE, '', 'No action needed — this note closes the run.')
  }
  return lines.join('\n')
}
