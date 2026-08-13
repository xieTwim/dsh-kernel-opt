/** Loop decision + supervisor plumbing unit tests (pure functions only). */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  adviceFromReply, continuationText, decideContinuation, initialLoopState, supervisorDigest, wrapUpText,
} from '../src/loop.ts'
import { REVIEW_OK_LINE, WRAPUP_LINE_PREFIX } from '../src/wire.ts'
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

test('adviceFromReply: OK and empty suppress advice; long advice truncates', () => {
  assert.equal(adviceFromReply('OK'), null)
  assert.equal(adviceFromReply('ok.'), null)
  assert.equal(adviceFromReply('  \n'), null)
  assert.equal(adviceFromReply('Switch families.'), 'Switch families.')
  const long = adviceFromReply('x'.repeat(700))
  assert.ok(long !== null && long.length <= 601)
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
