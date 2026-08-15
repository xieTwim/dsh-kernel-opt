/** Loop decision + supervisor plumbing unit tests (pure functions only). */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  HEADROOM_SYSTEM, SUPERVISOR_SYSTEM, adviceFromReply, challengeText, continuationText,
  decideContinuation, finalAuditText,
  initialLoopState, planStale, reviewable, stagnationCount, supervisorDigest,
  supervisorSystem, unreviewedEvals, wrapUpText,
} from '../src/loop.ts'
import {
  AUDIT_CLOSE_LINE, AUDIT_LINE_PREFIX, CONTINUE_TRAILER, LOOP_LINE_PREFIX,
  REVIEW_HEADER, REVIEW_OK_LINE, WRAPUP_LINE_PREFIX,
} from '../src/wire.ts'
import type { WireIteration, WireSeries } from '../src/wire.ts'

function series(iterations: WireIteration[], bestIndex: number | null = null): WireSeries {
  return { sessionId: 's', updatedAt: 0, iterations, plans: [], envs: [], profileSeqs: [], rounds: [], bestIndex }
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
  // Three sentences of kernel advice run long; only runaway replies are cut.
  const kept = adviceFromReply('x'.repeat(700))
  assert.equal(kept.advice, 'x'.repeat(700))
  const long = adviceFromReply('x'.repeat(2000))
  assert.ok(long.advice !== null && long.advice.length <= 1501)
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

test('continuation demands kernel_env while the machine is unknown', () => {
  const demand = continuationText(2, 3, 20, null, false, 0, 'kernel_finalize', true, true, 3, null, false, false)
  assert.ok(demand.includes('No kernel_env is on record'))
  assert.ok(demand.includes('where these evaluations actually run'))
  assert.ok(!continuationText(2, 3, 20, null, false, 0, 'kernel_finalize', true, true, 3, null, false, true)
    .includes('No kernel_env is on record'))
})

test('supervisor digest states the environment, or that none was reported', () => {
  const state = { ...initialLoopState(), armed: true, budget: 20, round: 2 }
  assert.ok(supervisorDigest(series([done(1, 10)]), state).includes('Environment: not reported'))
  const withEnv = {
    ...series([done(1, 10)]),
    envs: [{ seq: 5, location: 'kernel-box', device: 'H100 80GB x1', constraint: 'CUDA_VISIBLE_DEVICES=0' }],
  }
  const digest = supervisorDigest(withEnv, state)
  assert.ok(digest.includes('H100 80GB x1 @ kernel-box'))
  assert.ok(digest.includes('CUDA_VISIBLE_DEVICES=0'))
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
  // The closing plan: without it the panel keeps whatever exploration the
  // agent reported last, which is not what it delivered.
  assert.ok(text.includes('closing kernel_plan'))
  assert.ok(challengeText(3, 6, 20, 'Try tiling.').includes('closing kernel_plan'))
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

test('continuation pace cap leads the drive without disturbing the anchors', () => {
  const paced = continuationText(2, 3, 20, 'Switch families.', false, 0, 'kernel_finalize', true, true, 3)
  assert.ok(paced.includes('AT MOST 3 evaluations'))
  assert.ok(paced.includes('Failed and aborted runs count'))
  // Leading, not trailing: a footnote is what the model drifted past.
  assert.ok(paced.indexOf('PACE') < paced.indexOf(REVIEW_HEADER))
  assert.ok(paced.includes(CONTINUE_TRAILER)) // parse anchor intact after the advice block
  assert.ok(/3\/20 evaluations used/.test(paced))
  // The inventory (taskless) drive is paced too; 0 disables the line.
  assert.ok(continuationText(1, 0, 20, null, false, 0, 'kernel_finalize', false, true, 3)
    .includes('AT MOST 3 evaluations'))
  assert.ok(!continuationText(2, 3, 20, null).includes('PACE'))
  // A forced write-up must not read as a verdict on the unfinished idea.
  assert.ok(paced.includes('CHECKPOINT, not a verdict'))
  assert.ok(paced.includes('unfinished, not refuted'))
})

test('supervisor digest reports the pace cap against what the last turn ran', () => {
  const state = { ...initialLoopState(), armed: true, budget: 20, round: 3 }
  const s = {
    ...series([done(20, 5), done(30, 4), done(40, 4), done(50, 4)]),
    rounds: [{ seq: 10, round: 3 }],
  }
  const digest = supervisorDigest(s, state, 10, 3)
  assert.ok(digest.includes('at most 3 evaluations per turn'))
  assert.ok(digest.includes('the last turn ran 4'))
  // Without a cap configured the digest stays silent about pace.
  assert.ok(!supervisorDigest(s, state, 10, 0).includes('Pace:'))
})

test('supervisor digest carries the evaluator metrics and the edits behind the rows', () => {
  const state = { ...initialLoopState(), armed: true, budget: 20, round: 2 }
  const s = series([
    { ...done(10, 5), metrics: { speedup: 2, ref_runtime_ms: 9, occupancy: 0.31, dram_pct: 74 } },
    {
      ...done(20, 4),
      changes: [
        { seq: 18, tool: 'edit', kind: 'edit', oldText: 'BLOCK = 32', newText: 'BLOCK = 128' },
        { seq: 19, tool: 'write', kind: 'write', content: '@triton.jit\ndef k(...):', truncated: true },
      ],
    },
  ])
  const digest = supervisorDigest(s, state)
  // Profiler numbers reach the reviewer; `speedup` stays in its own column.
  assert.ok(digest.includes('occupancy=0.31'))
  assert.ok(digest.includes('dram_pct=74'))
  assert.ok(!digest.includes('speedup=2'))
  assert.ok(!digest.includes('ref_runtime_ms'))
  // The change log is the independent record of what was tried.
  assert.ok(digest.includes('what was actually edited'))
  assert.ok(digest.includes('- BLOCK = 32'))
  assert.ok(digest.includes('+ BLOCK = 128'))
  assert.ok(digest.includes('#2 rewrote: @triton.jit def k(...):'))
  assert.ok(digest.includes('[cut]'))
  // Nothing captured, nothing claimed.
  assert.ok(!supervisorDigest(series([done(10, 5)]), state).includes('what was actually edited'))
})

test('supervisor digest flags a run that never profiled, and stays quiet early', () => {
  const state = { ...initialLoopState(), armed: true, budget: 20, round: 2 }
  const blind = series([done(10, 5), done(20, 4), done(30, 4)])
  assert.ok(supervisorDigest(blind, state).includes('no profiler invocation seen'))
  // Two evaluations in, not profiling yet is normal — no nagging.
  assert.ok(!supervisorDigest(series([done(10, 5), done(20, 4)]), state).includes('Profiling:'))
  // Profiler runs with no metric on any row: a count alone let the reviewer
  // accept "profiler-backed analysis" that no row could support.
  const profiled = { ...blind, profileSeqs: [15, 25] }
  const bare = supervisorDigest(profiled, state)
  assert.ok(bare.includes('2 command(s) invoked a profiler'))
  assert.ok(bare.includes('NO evaluation carried a single metric'))
  const withMetrics = {
    ...profiled,
    iterations: [...blind.iterations.slice(0, 2), { ...done(30, 4), metrics: { occupancy: 0.5 } }],
  }
  const backed = supervisorDigest(withMetrics, state)
  assert.ok(backed.includes('1 evaluation(s) carried metrics'))
  assert.ok(!backed.includes('NO evaluation'))
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
    sessionId: 's', updatedAt: 0, plans: [], envs: [], profileSeqs: [], rounds: [],
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
    sessionId: 's', updatedAt: 0, plans: [], envs: [], profileSeqs: [], rounds: [], bestIndex: 0,
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

test('config can set the review language and add house rules, never remove the rubric', () => {
  const plain = supervisorSystem(SUPERVISOR_SYSTEM)
  // Unset, the reviewer follows the agent's own plans — the panel shows the
  // review beside them, so an English review under Chinese plans reads wrong.
  assert.ok(plain.includes('the language the agent states its own plans'))
  assert.ok(plain.startsWith(SUPERVISOR_SYSTEM), 'the rubric leads, additions follow')

  const zh = supervisorSystem(SUPERVISOR_SYSTEM, { language: '中文' })
  assert.ok(zh.includes('Write the review in 中文.'))
  assert.ok(!zh.includes('the language the agent states its own plans'))

  // Whatever the language, the verdict token stays ASCII: adviceFromReply
  // recognises approval by a literal OK/DONE, and a translated token would
  // record every approval as advice and inject it into the agent.
  for (const text of [plain, zh, supervisorSystem(HEADROOM_SYSTEM, { language: '日本語' })]) {
    assert.ok(text.includes('`OK:` / `DONE:` exactly as written above, in ASCII'))
  }
  assert.equal(adviceFromReply('OK: 四个方向都试过了,最优点复测一致').advice, null)
  assert.equal(adviceFromReply('OK: 四个方向都试过了,最优点复测一致').note, '四个方向都试过了,最优点复测一致')

  // House rules are appended and capped; the rubric survives verbatim.
  const housed = supervisorSystem(SUPERVISOR_SYSTEM, { instructions: 'Flag any run that never reports DRAM bandwidth.' })
  assert.ok(housed.includes(SUPERVISOR_SYSTEM))
  assert.ok(housed.includes('they add findings, they never remove a check'))
  assert.ok(housed.includes('Flag any run that never reports DRAM bandwidth.'))
  assert.ok(supervisorSystem(SUPERVISOR_SYSTEM, { instructions: 'x'.repeat(3000) }).includes('…'))
  // Empty / whitespace-only config values are not a directive.
  assert.equal(supervisorSystem(SUPERVISOR_SYSTEM, { language: '   ', instructions: '  ' }), plain)
})
