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
  AUDIT_CLOSE_LINE, AUDIT_LINE_PREFIX, CHALLENGE_LINE, CONTINUE_TRAILER, LOOP_LINE_PREFIX,
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
  stopReason?: 'finalized' | 'converged' | 'budget' | 'no-progress' | 'stopped'
  /** Whether the supervisor reviews at continuation points. */
  supervise: boolean
  /** Session-level supervisor route override (wins over plugin config). */
  supervisorOverride?: { provider: string; model: string }
  /** Last supervisor advice delivered (panel display). */
  lastAdvice?: string
  /**
   * seq of the finalize the supervisor already challenged and overruled. A
   * finalize at or below it no longer ends the run — the agent declared done,
   * the supervisor found headroom, and the run continues; only a NEWER
   * finalize opens a fresh stop decision.
   */
  challengedFinalizeSeq?: number
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
 * Whether the plan card has fallen behind the run: a plan exists, but a full
 * pace batch of evaluations has landed since it was reported. The panel's
 * plan card is fed ONLY by `kernel_plan` calls, so an agent that switches
 * approach and describes it in prose leaves the human reading a stale plan.
 * @param series - current projection.
 * @param evalsPerTurn - pace batch size (0 falls back to 3).
 * @returns whether the drive should ask for a fresh plan report.
 */
export function planStale(series: WireSeries, evalsPerTurn = 3): boolean {
  const lastPlanSeq = series.plans.reduce((seq, p) => Math.max(seq, p.seq), -1)
  if (lastPlanSeq < 0) return false
  const since = series.iterations.filter(p => p.pending !== true && p.seq > lastPlanSeq).length
  return since >= Math.max(2, evalsPerTurn > 0 ? evalsPerTurn : 3)
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
  // A finalize the supervisor already overruled is spent: the run continues
  // on the ordinary budget/progress rules until the agent finalizes AGAIN.
  const lastFinalizeSeq = series.iterations
    .filter(p => p.finalized === true)
    .reduce((seq, p) => Math.max(seq, p.seq), -1)
  if (lastFinalizeSeq > (state.challengedFinalizeSeq ?? -1)) {
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

/** Profiler/native metrics shown per row, and how many of them. */
const DIGEST_METRIC_CAP = 5
/** Evaluations whose artifact changes are rendered as evidence. */
const DIGEST_CHANGE_TAIL = 4
/** Changes rendered per evaluation. */
const DIGEST_CHANGES_PER_ITERATION = 3
/** Chars kept per change text field. */
const DIGEST_CHANGE_TEXT = 220

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
  // The evaluator's own numeric extras. Latency alone cannot say WHY a kernel
  // is slow; occupancy, bandwidth and cache numbers are what a headroom
  // judgement is actually made of, and they already ride the eval contract.
  // `speedup`/`ref_runtime_ms` already have a column of their own; repeating
  // them here would crowd out the numbers nothing else shows.
  const entries = Object.entries(point.metrics ?? {})
    .filter(([key]) => key !== 'speedup' && key !== 'ref_runtime_ms')
  const metrics = entries.length > 0
    ? ` metrics:{${entries.slice(0, DIGEST_METRIC_CAP).map(([k, v]) => `${k}=${String(v)}`).join(', ')}${
      entries.length > DIGEST_METRIC_CAP ? ', …' : ''}}`
    : ''
  return `#${String(index + 1)} ${point.evaluationId ?? '?'} ${latency} ${status}${star}${best}${channel}${command}${metrics}`
}

/** Cap one change text field onto a single digest line. */
function snip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > DIGEST_CHANGE_TEXT ? `${flat.slice(0, DIGEST_CHANGE_TEXT)}…` : flat
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
function digestChanges(series: WireSeries): string[] {
  const withChanges = series.iterations
    .map((point, index) => ({ point, index }))
    .filter(entry => (entry.point.changes?.length ?? 0) > 0)
    .slice(-DIGEST_CHANGE_TAIL)
  if (withChanges.length === 0) return []
  const lines = [
    'Artifact changes before those evaluations (what was actually edited, not what the plan claimed):',
  ]
  for (const { point, index } of withChanges) {
    const changes = point.changes ?? []
    for (const change of changes.slice(0, DIGEST_CHANGES_PER_ITERATION)) {
      const mark = change.truncated === true ? ' [cut]' : ''
      if (change.kind === 'write') {
        const body = change.content !== undefined ? ` ${snip(change.content)}` : ''
        lines.push(`#${String(index + 1)} rewrote:${body}${mark}`)
      } else {
        lines.push(`#${String(index + 1)} edit: - ${snip(change.oldText ?? '')}`)
        lines.push(`${' '.repeat(String(index + 1).length + 1)}       + ${snip(change.newText ?? '')}${mark}`)
      }
    }
    if (changes.length > DIGEST_CHANGES_PER_ITERATION) {
      lines.push(`#${String(index + 1)} … ${String(changes.length - DIGEST_CHANGES_PER_ITERATION)} more edits`)
    }
  }
  return lines
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
export function supervisorDigest(series: WireSeries, state: LoopState, tail = 10, evalsPerTurn = 0): string {
  const evalsDone = completedEvals(series)
  const lines: string[] = [
    `Budget: ${String(evalsDone)}/${String(state.budget)} evaluations used; continuation round ${String(state.round)}.`,
  ]
  if (evalsPerTurn > 0 && series.rounds.length > 0) {
    const lastDriveSeq = series.rounds[series.rounds.length - 1]?.seq ?? -1
    const lastTurn = series.iterations.filter(p => p.seq > lastDriveSeq).length
    lines.push(`Pace: the drive asks for at most ${String(evalsPerTurn)} evaluations per turn; `
      + `the last turn ran ${String(lastTurn)}.`)
  }
  const stagnant = stagnationCount(series)
  if (stagnant >= 3) lines.push(`Stagnation: ${String(stagnant)} evaluations since the last improvement.`)
  const shellCount = series.iterations.filter(p => p.channel === 'shell').length
  if (shellCount > 0) {
    lines.push(`Provenance: ${String(shellCount)}/${String(series.iterations.length)} evaluations are self-reported `
      + '(parsed from agent-run shell output; cmd shown per row). A row whose cmd is not a benchmark invocation is fabricated.')
  }
  // Whether it ever asked WHY the kernel is slow. Absence is a soft signal —
  // only real profilers are recognised, not hand-written diagnostic scripts.
  // Presence is a soft signal too: the run that motivated this line narrated
  // "profiler-backed analysis" with IPC figures no row ever reported, and a
  // bare count of profiler invocations let that pass as established.
  const metricRows = series.iterations.filter(p => Object.keys(p.metrics ?? {})
    .some(key => key !== 'speedup' && key !== 'ref_runtime_ms')).length
  if (series.profileSeqs.length > 0) {
    lines.push(`Profiling: ${String(series.profileSeqs.length)} command(s) invoked a profiler`
      + (metricRows > 0
        ? `, and ${String(metricRows)} evaluation(s) carried metrics.`
        : ', but NO evaluation carried a single metric — profiler findings that appear only in '
          + 'the agent\'s prose are unverified here, so treat them as claims, not evidence.'))
  } else if (evalsDone >= 3) {
    lines.push('Profiling: no profiler invocation seen on the command lines — the run may be optimizing by '
      + 'guesswork rather than measurement (hand-written diagnostic scripts would not be detected here).')
  }
  const env = series.envs[series.envs.length - 1]
  if (env !== undefined) {
    lines.push(`Environment (agent-reported): ${env.device} @ ${env.location}`
      + `${env.constraint !== undefined ? ` — constraint: ${env.constraint}` : ''}`)
  } else {
    lines.push('Environment: not reported — the agent has not stated where these measurements run.')
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
  lines.push(...digestChanges(series))
  return lines.join('\n')
}

/** System rubric for the supervisor model. */
export const SUPERVISOR_SYSTEM = [
  'You supervise a kernel-optimization agent. You see a digest of its run: budget, its stated plans, the evaluation '
  + 'table with whatever metrics its evaluator reported, and the artifact edits behind the recent rows.',
  'Judge how the run is being conducted — you are not reviewing the kernel line by line:',
  '- correctness first: WRONG or REWARD-HACK rows are failures, not progress;',
  '- budget discipline: repeated evaluations of one idea without a stated hypothesis waste budget;',
  '- approach diversity: several consecutive failures of one family should trigger a family switch;',
  '- plan vs diff: the change log is your independent evidence. A plan naming a family the edits do not show '
  + '(a "tiling" plan whose diff only moves a constant) is a real miss — say so, and say what the edit would have to touch;',
  '- metrics: when the evaluator reports occupancy/bandwidth/cache numbers, read them. A kernel far from a stated '
  + 'roof has headroom the latency column alone does not show;',
  '- diagnosis: several evaluations with no profiler run and no reported metrics is optimizing by guesswork — '
  + 'ask for one profiled run before more variants;',
  '- plan hygiene: plans should exist and match what the table shows;',
  '- provenance: on [shell] rows the trajectory is self-reported — judge whether each cmd is a real benchmark invocation and whether the numbers move like real measurements;',
  '- pace: the drive caps evaluations per turn so the loop can steer mid-run; a turn that overran the cap is a discipline miss worth one line of advice;',
  '- finishing: near budget exhaustion the agent should finalize its best honest result.',
  'If the run looks healthy, reply `OK: ` followed by ONE short sentence naming what you checked and the strongest '
  + 'signal you saw (e.g. "OK: four families tried, best is replay-consistent, budget on track"). The sentence is '
  + 'shown to the human as the record of this review, so never reply with a bare OK.',
  'Otherwise reply with at most 3 short imperative sentences of advice. No preamble, no code.',
].join('\n')

/**
 * Rubric for the finalize challenge: the agent declared the run finished
 * while budget remained, and the supervisor decides whether that stands. The
 * bar is deliberately asymmetric — "the current result looks fine" is not a
 * reason to stop; only an argued absence of headroom is.
 */
export const HEADROOM_SYSTEM = [
  'You supervise a kernel-optimization agent that just declared its run FINISHED while evaluation budget remained.',
  'You decide whether that ending stands. Judge from the digest: the plans it stated, the evaluation table with its '
  + 'metrics, the artifact edits behind the recent rows, and the provenance of the numbers.',
  'Read the change log before you accept any claim of coverage: it shows which families were ACTUALLY attempted, '
  + 'while the plan lines are the agent describing its own work. A family named in a plan but absent from the diffs is untried.',
  'The bar is asymmetric — an agent stopping early wastes the budget the human paid for:',
  '- "the result is good enough" or "the improvement is large already" is NOT a reason to stop;',
  '- a plateau over the last few evaluations is not convergence if whole approach families are untried;',
  '- untried families are evidence of headroom: different algorithm/layout, different tiling or blocking,',
  '  fusion or launch-overhead removal, precision/vectorization, library or compiler paths, tuning of exposed parameters;',
  '- stopping IS justified when the remaining ideas are argued to be dominated, when measurements sit at a stated',
  '  hardware or semantic floor, or when several distinct families all failed to beat the current best;',
  '- a run that never profiled and reports no metrics cannot claim it sits at a floor — it never located the',
  '  bottleneck, so "no headroom" is a guess. Send it to profile once before accepting the ending;',
  '- counters quoted only in the agent\'s prose (an IPC, a bandwidth, a saturation claim) with no metric on any',
  '  row are the agent\'s own account, not evidence. Ask for the number on a row before letting it close the run.',
  'If the run is genuinely converged, reply `DONE: ` followed by ONE short sentence stating WHY no headroom remains '
  + '(which families were tried and what floor the measurements sit at). That sentence is shown to the human as the '
  + 'justification for ending the run, so never reply with a bare DONE.',
  'Otherwise reply with at most 3 short imperative sentences, each naming a CONCRETE untried direction worth one evaluation. No preamble, no code.',
].join('\n')

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
export function adviceFromReply(reply: string): { advice: string | null; note: string | null } {
  const text = reply.trim()
  if (text.length === 0) return { advice: null, note: null }
  const approved = /^(ok|done)\b[.:!—-]*\s*/i.exec(text)
  if (approved !== null) {
    const note = text.slice(approved[0].length).trim().split('\n')[0]?.trim() ?? ''
    return { advice: null, note: note.length > 0 ? (note.length > 300 ? `${note.slice(0, 300)}…` : note) : null }
  }
  // 600 chars cut a real direction mid-sentence ("Test a norm-only parallel
  // pass with…"): three sentences of kernel advice carry tool names, counters
  // and instruction counts, and a half-sentence direction cannot be pursued.
  return { advice: text.length > 1500 ? `${text.slice(0, 1500)}…` : text, note: null }
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
  okNote: string | null = null,
  planStale = false,
  envKnown = true,
): string {
  const lines = [
    `${LOOP_LINE_PREFIX}${String(round)}] ${String(evalsDone)}/${String(budget)} evaluations used.`,
  ]
  // The pace instruction leads the message: at the bottom it read as a
  // footnote and the model drifted to double the cap by the second turn.
  // The checkpoint framing is load-bearing: a forced write-up mid-idea
  // otherwise crystallises an unfinished line into a negative verdict, and
  // the model then abandons a direction it was one evaluation away from.
  if (evalsPerTurn > 0) {
    lines.push(
      `PACE — hard stop for this turn: run AT MOST ${String(evalsPerTurn)} evaluations, then end the turn and `
      + 'report, even mid-idea. Failed and aborted runs count toward that number. The loop reviews your progress '
      + 'and drives you straight onward, so ending the turn costs you nothing and is not a reason to finalize early.',
      'That report is a CHECKPOINT, not a verdict: say what you are in the middle of and what you will run next. '
      + 'An idea you had to cut short is unfinished, not refuted — do not write it off as a dead end, and do not '
      + 'let a flat result you have not explained yet become a reason to switch away.',
    )
  }
  if (stagnant >= 3) {
    lines.push(`Note: ${String(stagnant)} evaluations since the last improvement — consider re-profiling or `
      + 'switching approach family before spending more budget on the current line.')
  }
  if (advice !== null) {
    lines.push('', REVIEW_HEADER, advice)
  } else if (reviewedOk) {
    lines.push('', okNote !== null && okNote.length > 0 ? `${REVIEW_OK_LINE} ${okNote}` : REVIEW_OK_LINE)
  }
  if (taskKnown) {
    lines.push(
      '',
      `${CONTINUE_TRAILER}: analyse the latest result, state the plan with kernel_plan if it changed, improve the kernel, and evaluate again.`,
    )
    if (!planKnown) {
      lines.push('No kernel_plan is on record yet — report your resolved plan with it (phase, approach, hypothesis) before evaluating further.')
    }
    if (!envKnown) {
      lines.push('No kernel_env is on record — report where these evaluations actually run (host, device, '
        + 'any user constraint on the device, key toolchain versions, and the commands you read them from). '
        + 'Latency numbers are unreadable without the machine behind them.')
    }
    if (planKnown && planStale) {
      lines.push('Your last kernel_plan predates the recent evaluations — call it again with what you are actually pursuing now. '
        + 'kernel_plan is the ONLY channel to the human\'s plan panel; a progress write-up in the reply text never reaches it.')
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
  okNote: string | null = null,
): string {
  const lines = [
    `${WRAPUP_LINE_PREFIX} ${String(evalsDone)}/${String(budget)} evaluations used; stopping (${reason}).`,
  ]
  if (advice !== null) {
    lines.push('', REVIEW_HEADER, advice)
  } else if (reviewedOk) {
    lines.push('', okNote !== null && okNote.length > 0 ? `${REVIEW_OK_LINE} ${okNote}` : REVIEW_OK_LINE)
  }
  lines.push(
    '',
    `${WRAPUP_CLOSE_LINE} — do not start new optimization work.`,
    `If an honest best result exists, finalize it now (${finalizeHint}; pass the evaluation_id from your evaluator, or the artifact path for kernel_finalize).`,
    'Restore the best artifact verbatim first if a later edit regressed it.',
    'Report a closing kernel_plan naming the approach you are actually delivering — abandoned '
    + 'exploration must not be what the human is left reading in the plan panel.',
    'Then summarize the run: best result, what worked, what failed, and what a future attempt should try first.',
  )
  return lines.join('\n')
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
export function challengeText(
  round: number,
  evalsDone: number,
  budget: number,
  advice: string,
  finalizeHint = 'run_finalize / kernel_finalize',
  evalsPerTurn = 0,
): string {
  const lines = [
    `${LOOP_LINE_PREFIX}${String(round)}] ${String(evalsDone)}/${String(budget)} evaluations used.`,
    '',
    REVIEW_HEADER,
    advice,
    '',
    `${CONTINUE_TRAILER}: ${CHALLENGE_LINE}. You declared it finished, but budget remains and the supervisor `
    + 'identified headroom above — treat your finalize as provisional and pursue those directions now.',
    'Do not re-finalize the same artifact to end the run: either produce a measurement that beats the current best, '
    + 'or come back with EVIDENCE that a direction is dominated (what you tried, what it measured, why it cannot win).',
    `When the remaining budget genuinely cannot beat the current best, finalize the result you stand behind (${finalizeHint}), `
    + 'report a closing kernel_plan naming the approach you are delivering, then summarize.',
  ]
  if (evalsPerTurn > 0) {
    lines.push(`Pace: complete at most ${String(evalsPerTurn)} evaluations this turn, then settle and report.`)
  }
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
 * @param okNote - the supervisor's one-line justification on approval.
 * @returns the followup text.
 */
export function finalAuditText(advice: string | null, okNote: string | null = null): string {
  const lines = [`${AUDIT_LINE_PREFIX} the run has finalized; the supervisor audited the final table.`]
  if (advice !== null) {
    lines.push(
      '', REVIEW_HEADER, advice,
      '',
      `${AUDIT_CLOSE_LINE}: verify or correct the finalized result (re-finalize if the artifact changes), then close with a short note.`,
      'Do not start new optimization work beyond what the findings require.',
    )
  } else {
    lines.push(
      '',
      okNote !== null && okNote.length > 0 ? `${REVIEW_OK_LINE} ${okNote}` : REVIEW_OK_LINE,
      '',
      'No action needed — this note closes the run.',
    )
  }
  return lines.join('\n')
}
