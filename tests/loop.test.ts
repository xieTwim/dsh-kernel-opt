/** Loop decision + supervisor plumbing unit tests (pure functions only). */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  adviceFromReply, challengeText, continuationText, decideContinuation, finalAuditText,
  initialLoopState, planStale, reviewable, stagnationCount, supervisorDigest,
  unreviewedEvals, wrapUpText,
} from '../src/loop.ts'
import {
  AUDIT_CLOSE_LINE, AUDIT_LINE_PREFIX, CONTINUE_TRAILER, LOOP_LINE_PREFIX,
  REVIEW_HEADER, REVIEW_OK_LINE, WRAPUP_LINE_PREFIX,
} from '../src/wire.ts'
import type { WireIteration, WireSeries } from '../src/wire.ts'

function series(iterations: WireIteration[], bestIndex: number | null = null): WireSeries {
  return { sessionId: 's', updatedAt: 0, iterations, plans: [], profileSeqs: [], rounds: [], bestIndex }
}
function done(seq: number, latencyMs: number, correct = true): WireIteration {
  return { seq, tool: 'kernel_evaluate', latencyMs, correct, evaluationId: String(seq).padStart(4, '0') }
}

test('decideContinuation: continues under budget, wraps up at budget', () => {
  const state = { ...initialLoopState(), armed: true, budget: 3 }
  const two = decideContinuation(series([done(1, 10), done(2, 8)]), state, 2)
  assert.equal(two.action, 'continue')
  const three = decideContinuation(series([done(1, 10), done(2, 8), done(3, 9)]), state, 2)
  assert.deepEqual(three, { action: 'wrap-up', reason: 'budget', evalsDone: 3 })
})

test('decideContinuation: finalize stops regardless of budget', () => {
  const state = { ...initialLoopState(), armed: true, budget: 20 }
  const s = series([done(1, 10), { ...done(2, 8), finalized: true }])
  assert.equal(decideContinuation(s, state, 2).action, 'stop')
  assert.equal((decideContinuation(s, state, 2) as { reason: string }).reason, 'finalized')
})

test('decideContinuation: a challenged finalize no longer ends the run', () => {
  const s = series([done(1, 10), { ...done(2, 8), finalized: true }])
  const fresh = { ...initialLoopState(), armed: true, budget: 20 }
  assert.equal(decideContinuation(s, fresh, 2).action, 'stop')
  // Once the supervisor overruled that finalize, the ordinary rules resume.
  const challenged = { ...fresh, challengedFinalizeSeq: 2, round: 1, lastEvalCount: 2 }
  assert.equal(decideContinuation(s, challenged, 2).action, 'continue')
  // A NEWER finalize re-opens the stop decision.
  const refinalized = series([done(1, 10), { ...done(2, 8), finalized: true }, { ...done(3, 7), finalized: true }])
  assert.equal(decideContinuation(refinalized, challenged, 2).action, 'stop')
})

test('adviceFromReply: DONE approves like OK (headroom challenge)', () => {
  assert.equal(adviceFromReply('DONE').advice, null)
  assert.equal(adviceFromReply('done.').advice, null)
  assert.equal(adviceFromReply('Try tiling the reduction.').advice, 'Try tiling the reduction.')
})

test('challengeText: keeps loop anchors, states the finalize is provisional', () => {
  const text = challengeText(3, 6, 20, 'Try a fused epilogue.\nTry vectorized loads.', 'kernel_finalize', 3)
  assert.ok(text.startsWith(`${LOOP_LINE_PREFIX}3]`))
  assert.ok(/6\/20 evaluations used/.test(text))
  assert.ok(text.includes(REVIEW_HEADER) && text.includes('Try a fused epilogue.'))
  assert.ok(text.includes(CONTINUE_TRAILER) && text.includes('the run is NOT over'))
  assert.ok(text.includes('Do not re-finalize the same artifact'))
  assert.ok(text.includes('at most 3 evaluations this turn'))
})

test('decideContinuation: repeated no-progress rounds wrap the loop up', () => {
  const state = { ...initialLoopState(), armed: true, budget: 20, round: 2, lastEvalCount: 2, noProgressRounds: 1 }
  const stalled = series([done(1, 10), done(2, 8)])
  assert.deepEqual(decideContinuation(stalled, state, 2), { action: 'wrap-up', reason: 'no-progress', evalsDone: 2 })
  // Progress resets the tolerance.
  const progressed = series([done(1, 10), done(2, 8), done(3, 7)])
  assert.equal(decideContinuation(progressed, state, 2).action, 'continue')
})

test('decideContinuation: pending evaluations do not count toward budget', () => {
  const state = { ...initialLoopState(), armed: true, budget: 2 }
  const s = series([done(1, 10), { seq: 2, tool: 'kernel_evaluate', pending: true }])
  const decision = decideContinuation(s, state, 2)
  assert.equal(decision.action, 'continue')
  assert.equal(decision.evalsDone, 1)
})

test('reviewable: false only while the log carries no evaluations and no plans', () => {
  assert.equal(reviewable(series([])), false)
  assert.equal(reviewable(series([done(1, 10)])), true)
  const planned = { ...series([]), plans: [{ seq: 1, phase: 'explore', approach: 'split-K' }] }
  assert.equal(reviewable(planned), true)
})

test('adviceFromReply: approval carries its note; advice truncates', () => {
  assert.deepEqual(adviceFromReply('OK'), { advice: null, note: null })
  assert.deepEqual(adviceFromReply('ok.'), { advice: null, note: null })
  assert.deepEqual(adviceFromReply('  \n'), { advice: null, note: null })
  // The one-line observation the rubric now requires is captured, not dropped.
  assert.deepEqual(
    adviceFromReply('OK: four families tried, best is replay-consistent.'),
    { advice: null, note: 'four families tried, best is replay-consistent.' },
  )
  assert.deepEqual(
    adviceFromReply('DONE: NEON path sits at the 1-exp/element floor.'),
    { advice: null, note: 'NEON path sits at the 1-exp/element floor.' },
  )
  assert.deepEqual(adviceFromReply('Switch families.'), { advice: 'Switch families.', note: null })
  const long = adviceFromReply('x'.repeat(700))
  assert.ok(long.advice !== null && long.advice.length <= 601)
})

test('approval notes ride the OK line in every delivery kind', () => {
  const note = 'four families tried, best is replay-consistent'
  assert.ok(continuationText(2, 3, 20, null, true, 0, undefined, true, true, 0, note)
    .includes(`${REVIEW_OK_LINE} ${note}`))
  assert.ok(wrapUpText(5, 5, 'budget', 'kernel_finalize', null, true, note).includes(`${REVIEW_OK_LINE} ${note}`))
  assert.ok(finalAuditText(null, note).includes(`${REVIEW_OK_LINE} ${note}`))
  // Without a note the bare line still parses as an approval.
  assert.ok(finalAuditText(null).includes(REVIEW_OK_LINE))
})

test('planStale: a full pace batch of evaluations since the last plan', () => {
  const plans = [{ seq: 10, phase: 'tune', approach: 'v6' }]
  const withPlan = (its: WireIteration[]): WireSeries => ({ ...series(its), plans })
  assert.equal(planStale(withPlan([done(11, 5), done(12, 4)]), 3), false)
  assert.equal(planStale(withPlan([done(11, 5), done(12, 4), done(13, 4)]), 3), true)
  // Evaluations BEFORE the plan do not age it; no plan at all is not stale.
  assert.equal(planStale(withPlan([done(1, 5), done(2, 4), done(3, 4)]), 3), false)
  assert.equal(planStale(series([done(1, 5), done(2, 4), done(3, 4)]), 3), false)
})

test('continuation asks for a fresh plan once the plan card fell behind', () => {
  const stale = continuationText(3, 6, 20, null, false, 0, 'kernel_finalize', true, true, 3, null, true)
  assert.ok(stale.includes('Your last kernel_plan predates the recent evaluations'))
  assert.ok(stale.includes('ONLY channel'))
  assert.ok(!continuationText(3, 6, 20, null, false, 0, 'kernel_finalize', true, true, 3, null, false)
    .includes('predates the recent evaluations'))
})

test('digest and continuation text carry budget state and advice', () => {
  const state = { ...initialLoopState(), armed: true, budget: 20, round: 3 }
  const digest = supervisorDigest(series([done(1, 10), { ...done(2, 8, false) }], 0), state)
  assert.ok(digest.includes('2/20'))
  assert.ok(digest.includes('WRONG'))
  const text = continuationText(4, 7, 20, 'Try split-K.')
  assert.ok(text.includes('round 4') && text.includes('7/20') && text.includes('Try split-K.'))
  assert.ok(continuationText(1, 0, 20, null).includes('run_finalize'))
})

test('continuation text records an approving review as the OK line', () => {
  assert.ok(continuationText(2, 3, 20, null, true).includes(REVIEW_OK_LINE))
  assert.ok(!continuationText(2, 3, 20, null, false).includes(REVIEW_OK_LINE))
  // Advice wins over the OK line.
  assert.ok(!continuationText(2, 3, 20, 'Switch families.', true).includes(REVIEW_OK_LINE))
})

test('wrapUpText asks for finalize, never for new work', () => {
  const text = wrapUpText(20, 20, 'budget')
  assert.ok(text.startsWith(WRAPUP_LINE_PREFIX))
  assert.ok(text.includes('20/20'))
  assert.ok(text.includes('run_finalize'))
  assert.ok(text.includes('do not start new optimization work'))
})

test('wrapUpText carries the supervisor review block like a continuation', () => {
  const advised = wrapUpText(5, 5, 'budget', 'kernel_finalize', 'Verify provenance of #4 before finalizing.')
  assert.ok(advised.startsWith(WRAPUP_LINE_PREFIX))
  assert.ok(advised.includes(REVIEW_HEADER))
  assert.ok(advised.includes('Verify provenance of #4 before finalizing.'))
  const approved = wrapUpText(5, 5, 'budget', 'kernel_finalize', null, true)
  assert.ok(approved.includes(REVIEW_OK_LINE))
  // No review ran: neither anchor appears; advice wins over the OK line.
  const silent = wrapUpText(5, 5, 'budget')
  assert.ok(!silent.includes(REVIEW_HEADER) && !silent.includes(REVIEW_OK_LINE))
  assert.ok(!advised.includes(REVIEW_OK_LINE))
})

test('continuation demands the initial kernel_plan while none is on record', () => {
  const demand = continuationText(2, 3, 20, null, false, 0, 'kernel_finalize', true, false)
  assert.ok(demand.includes('No kernel_plan is on record yet'))
  assert.ok(!continuationText(2, 3, 20, null, false, 0, 'kernel_finalize', true, true)
    .includes('No kernel_plan is on record yet'))
  // The taskless inventory branch demands the plan inline.
  assert.ok(continuationText(1, 0, 20, null, false, 0, 'kernel_finalize', false).includes('kernel_plan'))
})

test('continuation pace cap rides every drive without disturbing the anchors', () => {
  const paced = continuationText(2, 3, 20, 'Switch families.', false, 0, 'kernel_finalize', true, true, 3)
  assert.ok(paced.includes('at most 3 evaluations this turn'))
  assert.ok(paced.includes(CONTINUE_TRAILER)) // parse anchor intact after the advice block
  assert.ok(/3\/20 evaluations used/.test(paced))
  // The inventory (taskless) drive is paced too; 0 disables the line.
  assert.ok(continuationText(1, 0, 20, null, false, 0, 'kernel_finalize', false, true, 3)
    .includes('at most 3 evaluations this turn'))
  assert.ok(!continuationText(2, 3, 20, null).includes('evaluations this turn'))
})

test('unreviewedEvals: true when rows exist past the last delivered review', () => {
  const rows = [done(10, 5), done(20, 4)]
  const reviewed = { ...series(rows), rounds: [{ seq: 15, round: 1, review: 'ok' }] }
  assert.equal(unreviewedEvals(reviewed), true) // seq 20 landed after the review
  const covered = { ...series([done(10, 5)]), rounds: [{ seq: 15, round: 1, review: 'ok' }] }
  assert.equal(unreviewedEvals(covered), false)
  assert.equal(unreviewedEvals(series(rows)), true) // no review ever ran
  assert.equal(unreviewedEvals(series([])), false)
})

test('finalAuditText: OK closes on the record; findings demand bounded correction', () => {
  const ok = finalAuditText(null)
  assert.ok(ok.startsWith(AUDIT_LINE_PREFIX))
  assert.ok(ok.includes(REVIEW_OK_LINE))
  const findings = finalAuditText('Replay disagrees with the self-reported final; re-verify.')
  assert.ok(findings.startsWith(AUDIT_LINE_PREFIX))
  assert.ok(findings.includes(REVIEW_HEADER))
  assert.ok(findings.includes('Replay disagrees with the self-reported final; re-verify.'))
  assert.ok(findings.includes(AUDIT_CLOSE_LINE))
  assert.ok(!findings.includes(REVIEW_OK_LINE))
})

test('stagnationCount counts completed evals after best; continuation nudges from 3', () => {
  const mk = (latencyMs: number | undefined, correct = true) => ({ seq: 1, tool: 'bash', ...(latencyMs !== undefined ? { latencyMs } : {}), correct })
  const series = {
    sessionId: 's', updatedAt: 0, plans: [], profileSeqs: [], rounds: [],
    iterations: [mk(2.0), mk(1.0), mk(1.5), mk(1.4), mk(undefined, false)],
    bestIndex: 1,
  }
  assert.equal(stagnationCount(series), 3)
  const text = continuationText(2, 5, 20, null, false, 3)
  assert.ok(text.includes('3 evaluations since the last improvement'))
  assert.ok(!continuationText(2, 5, 20, null, false, 2).includes('since the last improvement'))
  // The counters anchor the projection parses must survive the added line.
  assert.ok(/5\/20 evaluations used/.test(text))
})

test('finalize hint is threaded into continuation and wrap-up texts', () => {
  assert.ok(continuationText(1, 0, 20, null, false, 0, 'my_finalize').includes('my_finalize'))
  assert.ok(wrapUpText(20, 20, 'budget', 'my_finalize').includes('my_finalize'))
  // Defaults name both finalize tools.
  assert.ok(wrapUpText(20, 20, 'budget').includes('kernel_finalize'))
})

test('taskless continuation redirects to a workspace inventory, same anchor', () => {
  const text = continuationText(1, 0, 20, null, false, 0, 'kernel_finalize', false)
  assert.ok(text.includes(`${CONTINUE_TRAILER}: the conversation carries no task yet`))
  assert.ok(text.includes('Inventory the WORKING DIRECTORY'))
  assert.ok(text.includes('never adopt anything found outside the working directory'))
  // The task-known form keeps the same parse anchor.
  assert.ok(continuationText(2, 3, 20, 'switch family', false, 0).includes(CONTINUE_TRAILER))
})

test('supervisor digest carries provenance for self-reported rows', () => {
  const series = {
    sessionId: 's', updatedAt: 0, plans: [], profileSeqs: [], rounds: [], bestIndex: 0,
    iterations: [
      { seq: 1, tool: 'bash', channel: 'shell' as const, command: 'bash scripts/bench.sh', latencyMs: 1.2, correct: true },
      { seq: 2, tool: 'kernel_evaluate', evaluationId: '0002', latencyMs: 1.5, correct: true },
    ],
  }
  const digest = supervisorDigest(series, { armed: true, budget: 20, round: 1, lastEvalCount: 0, noProgressRounds: 0, supervise: true })
  assert.ok(digest.includes('[shell]'))
  assert.ok(digest.includes('cmd:"bash scripts/bench.sh"'))
  assert.ok(digest.includes('self-reported'))
})
