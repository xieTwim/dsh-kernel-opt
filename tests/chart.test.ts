/**
 * Axis-model tests. The chart's one contract is that a faster kernel sits
 * HIGHER, whatever the labels say — the panel is read at a glance, and a
 * curve that falls as the work succeeds is read wrong.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { CHART, chartModel, formatLatency, referenceLatency } from '../src/chart.ts'
import type { WireIteration } from '../src/wire.ts'

let seq = 0
/** One measured evaluation; `speedup` omitted models a `--no-ref` iteration. */
function point(latencyMs?: number, speedup?: number): WireIteration {
  seq += 1
  const out: WireIteration = { seq, tool: 'bash', channel: 'shell' }
  if (latencyMs !== undefined) out.latencyMs = latencyMs
  if (speedup !== undefined) out.speedup = speedup
  return out
}

const TOP = CHART.t
const BOTTOM = CHART.h - CHART.b

test('faster is higher on the axis', () => {
  const points = [point(2.0), point(1.0), point(0.5)]
  const model = chartModel(points, points.length)
  assert.ok(model !== null)
  assert.ok(model.y(0.5) < model.y(1.0), '0.5ms must sit above 1.0ms')
  assert.ok(model.y(1.0) < model.y(2.0), '1.0ms must sit above 2.0ms')
  // The domain's own bounds land on the frame, best at the top.
  assert.ok(Math.abs(model.y(model.fast) - TOP) < 0.01)
  assert.ok(Math.abs(model.y(model.slow) - BOTTOM) < 0.01)
  assert.ok(model.fast < model.slow, 'fast bound is the SMALLER latency')
})

test('a converged run keeps its slow outliers pinned to the bottom', () => {
  // Eight evaluations: one 20ms exploration, the rest converged near 0.26ms.
  const points = [
    point(20.4), point(0.34), point(0.33), point(0.26),
    point(0.257), point(0.259), point(0.258), point(0.26),
  ]
  const model = chartModel(points, points.length)
  assert.ok(model !== null)
  assert.equal(model.worst, 20.4)
  assert.ok(model.clamped(20.4), 'the 20ms row falls outside the focus band')
  assert.ok(!model.clamped(0.34), 'the converged band is inside')
  // Pinned to the BOTTOM edge, not the top: slow is the bad direction now.
  assert.ok(Math.abs(model.y(20.4) - BOTTOM) < 0.01)
  assert.ok(model.y(0.257) < model.y(0.34), 'ordering survives the clamp')
})

test('the reference is pooled over every row that reported one', () => {
  // Same kernel timed three times: 1.631 / 1.639 / 1.635 ms implied.
  const points = [
    point(0.453, 3.6003), // 1.6309
    point(0.454, 3.6101), // 1.6390
    point(0.4535, 3.6047), // 1.6347
  ]
  const ref = referenceLatency(points)
  assert.ok(ref !== undefined)
  assert.ok(Math.abs(ref - 1.6347) < 0.001, `median implied reference, got ${String(ref)}`)
  assert.equal(referenceLatency([point(0.5), point(0.4)]), undefined)
  // A row that reported no speedup contributes nothing but is not fatal.
  assert.ok(referenceLatency([point(0.5), point(0.453, 3.6003)]) !== undefined)
})

test('the pooled reference makes the curve monotone where the raw ratios are not', () => {
  // The reported numbers invert: 453µs came back ×3.60, 454µs came back ×3.61.
  const faster = point(0.453, 3.6003)
  const slower = point(0.454, 3.6101)
  assert.ok((slower.speedup ?? 0) > (faster.speedup ?? 0), 'the raw ratios really do invert')
  const points = [faster, slower]
  const model = chartModel(points, points.length)
  assert.ok(model !== null)
  assert.ok(model.y(0.453) < model.y(0.454), 'the faster row is still drawn higher')
})

test('labels read as × once the run has a reference, as latency before that', () => {
  const withRef = chartModel([point(0.453, 3.6), point(0.5, 3.26)], 2)
  assert.ok(withRef !== null)
  assert.ok(withRef.referenceMs !== undefined)
  assert.match(withRef.label(0.453), /^×3\.6/)
  // An evaluator-reported value for that same point wins over the pooled one,
  // so the gutter never contradicts the table.
  assert.equal(withRef.label(0.454, 3.6101), '×3.61')

  const noRef = chartModel([point(0.453), point(0.5)], 2)
  assert.ok(noRef !== null)
  assert.equal(noRef.referenceMs, undefined)
  assert.equal(noRef.label(0.453), formatLatency(0.453))
})

test('a run with no measured latency has no chart', () => {
  assert.equal(chartModel([point(), point()], 2), null)
  assert.equal(chartModel([], 0), null)
})

test('a wide spread switches the axis to log and keeps the direction', () => {
  const points = [point(100), point(50), point(10), point(2), point(1), point(0.5)]
  const model = chartModel(points, points.length)
  assert.ok(model !== null)
  assert.ok(model.log, 'two orders of magnitude is a log axis')
  assert.ok(model.y(0.5) < model.y(100))
  // Gridline values still come back as latencies, ordered with the axis.
  assert.ok(model.atFraction(0.9) < model.atFraction(0.1), 'higher fraction = faster')
})

test('latency formatting spans µs to s', () => {
  assert.equal(formatLatency(0.453), '453µs')
  assert.equal(formatLatency(20.4), '20.40ms')
  assert.equal(formatLatency(2000), '2.00s')
})
