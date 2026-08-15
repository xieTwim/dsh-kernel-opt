/**
 * The optimization curve's axis model — the pure half of the chart, kept out
 * of the JSX so it can be tested directly.
 *
 * **The axis reads better-is-up.** The plotted quantity is 1/latency, which
 * every measured evaluation has, so a faster kernel always sits higher; the
 * LABELS read as the evaluator's speedup when the run has a reference to
 * divide by, and as latency when it does not.
 *
 * The bundled evaluator always reports a speedup (its reference is timed once
 * and frozen), but the plugin does not require any particular evaluator: a
 * user's own bench, or a session recorded before that changed, can report
 * latency alone. Plotting speedup directly would hand those runs an empty
 * chart, when they have a perfectly good latency for every point.
 */

import type { WireIteration } from './wire.ts'

/** Human latency: µs under 1 ms, ms under 1 s, s above. */
export function formatLatency(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toPrecision(3)}µs`
  if (ms < 1000) return `${ms.toPrecision(4)}ms`
  return `${(ms / 1000).toPrecision(3)}s`
}

/** Chart geometry constants (viewBox units). */
export const CHART = { w: 640, h: 200, l: 56, r: 16, t: 16, b: 26 }
/** Minimum vertical clearance between two axis-gutter labels (viewBox units). */
export const AXIS_GAP = 13

export interface ChartModel {
  /** x in viewBox units per iteration index. */
  x: (index: number) => number
  /** y in viewBox units for a latency (clamped into the focus domain). */
  y: (latencyMs: number) => number
  /** Whether a latency falls below the focus domain (pinned to the bottom edge). */
  clamped: (latencyMs: number) => boolean
  /** Whether the y axis is logarithmic. */
  log: boolean
  /** Focus-domain bounds as latencies: `fast` tops the axis, `slow` floors it. */
  fast: number
  slow: number
  /** The slowest measured latency, for the clamp label. */
  worst: number
  /** Latency at a fraction of the axis height (0 = bottom = slowest). */
  atFraction: (f: number) => number
  /**
   * Axis label for a latency. An evaluator-REPORTED speedup for that same
   * point wins over the pooled estimate, so a number the panel prints twice
   * (gutter and table) never disagrees with itself.
   */
  label: (latencyMs: number, reported?: number) => string
  /** The run's pooled reference latency, when it has one. */
  referenceMs?: number
}

/** Nearest-rank quantile of an ascending-sorted array. */
function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] ?? 0
}

/**
 * The run's reference latency, pooled over every evaluation that reported a
 * speedup: the reference kernel does not change between evaluations, so
 * `speedup × latency` estimates the same quantity every time, and the median
 * of those estimates calibrates the whole axis — including the rows that ran
 * without the reference and reported no speedup of their own.
 *
 * Pooling is also what makes the curve monotone in latency. The evaluator
 * re-times the reference INSIDE each evaluation, so its own ratio carries
 * reference-side noise on top of solution-side noise: that is how a 453µs row
 * comes back ×3.60 while a 454µs row comes back ×3.61. The table keeps those
 * reported numbers verbatim — they are the record; the curve is a trend and
 * reads the pooled estimate.
 */
export function referenceLatency(measured: readonly WireIteration[]): number | undefined {
  const implied: number[] = []
  for (const point of measured) {
    const { latencyMs, speedup } = point
    if (latencyMs === undefined || latencyMs <= 0) continue
    if (speedup === undefined || speedup <= 0) continue
    implied.push(latencyMs * speedup)
  }
  if (implied.length === 0) return undefined
  implied.sort((a, b) => a - b)
  const mid = Math.floor(implied.length / 2)
  const upper = implied[mid] ?? 0
  return implied.length % 2 === 1 ? upper : (upper + (implied[mid - 1] ?? 0)) / 2
}

/**
 * Build the y mapping from the measured latencies. The domain focuses on the
 * convergence band [best × 0.97, P90 × 1.25]: a run whose early exploration
 * sits far below its converged band would otherwise compress every later
 * improvement into a flat line, log axis or not. Points below the band stay
 * visible, pinned to the bottom edge with a ↓ mark and the worst labeled.
 */
export function chartModel(measured: readonly WireIteration[], count: number): ChartModel | null {
  const sorted: number[] = []
  for (const point of measured) {
    if (point.latencyMs !== undefined) sorted.push(point.latencyMs)
  }
  if (sorted.length === 0) return null
  sorted.sort((a, b) => a - b)
  const fastest = sorted[0] ?? 0
  const worst = sorted[sorted.length - 1] ?? 0
  let slow = worst
  if (sorted.length >= 6) {
    const band = quantile(sorted, 0.9) * 1.25
    if (band < slow) slow = band
  }
  // Headroom past each end of the domain: without it a single-point (or
  // new-best-last) chart pins its dot flush to a frame edge, colliding with
  // the labels.
  slow *= 1.015
  const fast = fastest * 0.97
  const log = fast > 0 && slow / fast > 20
  // Axis space is 1/latency, so up is faster; under a log axis that is the
  // same ordering with the ratios evenly spaced.
  const toAxis = (latencyMs: number): number => (log ? -Math.log10(latencyMs) : 1 / latencyMs)
  const axLo = toAxis(slow)
  const span = toAxis(fast) - axLo || 1
  const innerW = CHART.w - CHART.l - CHART.r
  const innerH = CHART.h - CHART.t - CHART.b
  const denom = Math.max(1, count - 1)
  // Horizontal inset keeps first/last points (and their ★/⚑ marks) off the
  // frame edges.
  const xPad = 14
  const referenceMs = referenceLatency(measured)
  return {
    x: index => CHART.l + xPad + ((innerW - 2 * xPad) * index) / denom,
    y: (latencyMs) => {
      const v = Math.max(toAxis(latencyMs), axLo)
      return CHART.t + innerH * (1 - (v - axLo) / span)
    },
    clamped: latencyMs => latencyMs > slow,
    log,
    fast,
    slow,
    worst,
    atFraction: (f) => {
      const v = axLo + span * f
      return log ? 10 ** -v : 1 / v
    },
    label: (latencyMs, reported) => {
      if (referenceMs === undefined || latencyMs <= 0) return formatLatency(latencyMs)
      const speedup = reported !== undefined && reported > 0 ? reported : referenceMs / latencyMs
      return `×${speedup.toPrecision(3)}`
    },
    ...(referenceMs !== undefined ? { referenceMs } : {}),
  }
}
