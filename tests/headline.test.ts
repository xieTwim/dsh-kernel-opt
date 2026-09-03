/**
 * What the panel is allowed to print in its largest type.
 *
 * Every case here came out of an adversarial review of the headline, and each
 * one is a way for the panel to state something the session log does not
 * support. That is the failure this plugin can least afford: the whole claim
 * is that every number on screen is checkable, so a headline that contradicts
 * its own verification record is worse than a crash.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { eligibleBest, runHeadline } from '../src/wire.ts'
import type { WireIteration } from '../src/wire.ts'

let seq = 0
/** One projected evaluation; `correct` defaults to a passing verdict. */
function point(fields: Partial<WireIteration> = {}): WireIteration {
  seq += 1
  return { seq, tool: 'bash', channel: 'shell', correct: true, ...fields }
}

/** The projection's own best-point rule, so tests share it rather than guess. */
function bestIndexOf(points: readonly WireIteration[]): number | null {
  let best: number | null = null
  points.forEach((p, i) => {
    if (!eligibleBest(p)) return
    const current = best === null ? undefined : points[best]
    if (current?.latencyMs === undefined || p.latencyMs < current.latencyMs) best = i
  })
  return best
}

/** Resolve a headline the way both halves of the plugin do. */
function headlineOf(points: readonly WireIteration[]): ReturnType<typeof runHeadline> {
  return runHeadline(points, bestIndexOf(points))
}

test('a finalize on a failed evaluation is never the claim', () => {
  // `kernel_finalize` marks whatever evaluation_id it is handed, verdict
  // included — so this is reachable without any bug in the projection.
  const failed = point({ latencyMs: 0.1, correct: false, finalized: true, finalizeSeq: 90, artifactPath: 'a.py' })
  const good = point({ latencyMs: 0.5, artifactPath: 'b.py' })
  const h = headlineOf([failed, good])
  assert.equal(h.claim, good, 'the claim falls back to the verified best')
  assert.equal(h.finalized, false, 'and is not labelled a submission candidate')
  assert.equal(h.unclaimablePick, failed, 'the finalize itself is still reported')
})

test('a reward-hacked or untimed finalize is refused the same way', () => {
  for (const bad of [
    point({ latencyMs: 0.1, rewardHack: true, finalized: true, finalizeSeq: 90 }),
    point({ latencyMs: 0.1, error: 'evaluator crashed', finalized: true, finalizeSeq: 90 }),
    point({ finalized: true, finalizeSeq: 90 }),
  ]) {
    const good = point({ latencyMs: 0.5 })
    const h = headlineOf([bad, good])
    assert.equal(h.claim, good)
    assert.equal(h.finalized, false)
    assert.equal(h.unclaimablePick, bad)
  }
})

test('two finalizes resolve to the later CALL, in either log order', () => {
  // The loop's finalize challenge produces exactly this: an early "done" is
  // overruled, the run continues, and it finalizes again. Both marks survive
  // in the projection, and the evaluation a second call names can sit either
  // side of the first — so BOTH orders are asserted. Ordering by log position
  // gets one of them right by luck, which is how this went unnoticed.
  const stale = (): WireIteration =>
    point({ latencyMs: 0.30, artifactPath: 'overruled.py', finalized: true, finalizeSeq: 100 })
  const shipped = (): WireIteration =>
    point({ latencyMs: 0.40, artifactPath: 'shipped.py', finalized: true, finalizeSeq: 400 })

  for (const order of ['stale-first', 'shipped-first'] as const) {
    const a = stale()
    const b = shipped()
    const h = headlineOf(order === 'stale-first' ? [a, b] : [b, a])
    assert.equal(h.claim, b, `the latest finalize call wins (${order})`)
    assert.equal(h.finalized, true)
    assert.equal(h.fasterMeasured, a, 'and the faster one it did not ship is named')
  }
})

test('a zero or negative latency is a broken measurement, not a fast kernel', () => {
  const zero = point({ latencyMs: 0 })
  const negative = point({ latencyMs: -1 })
  const real = point({ latencyMs: 0.5 })
  assert.equal(eligibleBest(zero), false)
  assert.equal(eligibleBest(negative), false)
  const h = headlineOf([zero, negative, real])
  assert.equal(h.claim, real, 'a zero-latency row cannot become the headline')
  assert.equal(h.rejected, 2)
})

test('the replay row re-measures the pick and is never a pick of its own', () => {
  const pick = point({ latencyMs: 0.5, artifactPath: 'k.py', finalized: true, finalizeSeq: 100 })
  const replay = point({ latencyMs: 0.48, artifactPath: 'k.py', channel: 'replay', finalized: true, finalizeSeq: 100 })
  const h = headlineOf([pick, replay])
  assert.equal(h.claim, pick)
  assert.equal(h.finalized, true)
})

test('an equal-latency best is not reported as faster than the claim', () => {
  const pick = point({ latencyMs: 0.5, artifactPath: 'k.py', finalized: true, finalizeSeq: 100 })
  const tie = point({ latencyMs: 0.5, artifactPath: 'other.py' })
  const h = headlineOf([pick, tie])
  assert.equal(h.fasterMeasured, undefined)
})

test('a run with nothing claimable has no headline at all', () => {
  const h = headlineOf([point({ correct: false }), point({ pending: true })])
  assert.equal(h.claim, undefined)
  assert.equal(h.finalized, false)
  assert.equal(h.unclaimablePick, undefined)
  // A call still in flight has returned no verdict, so it is not a rejection.
  assert.equal(h.rejected, 1)
  assert.deepEqual(headlineOf([]), { finalized: false, rejected: 0 })
})

test('the claim is always one the eligibility rule admits', () => {
  // The invariant the Hero's verification ticks are read off.
  const runs: WireIteration[][] = [
    [point({ latencyMs: 0.5 })],
    [point({ latencyMs: 0.1, correct: false, finalized: true, finalizeSeq: 9 }), point({ latencyMs: 0.5 })],
    [point({ latencyMs: 0.5, finalized: true, finalizeSeq: 9 }), point({ latencyMs: 0.4, rewardHack: true })],
    [point({ latencyMs: 0 }), point({ latencyMs: 0.5 })],
  ]
  for (const run of runs) {
    const claim = headlineOf(run).claim
    if (claim !== undefined) assert.ok(eligibleBest(claim), 'a claim must pass eligibility')
  }
})
