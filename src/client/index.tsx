/**
 * dsh-kernel-opt — browser half.
 *
 * 「评测」 session tab (`conversation.view` slot): polls the Node half's
 * series route and renders the live optimization picture — latency curve over
 * evaluations (log scale when the journey is wide), correctness/reward-hack
 * status per point, profiler ▲ and finalize ★ marks, the model's latest
 * `kernel_plan`, and an iteration table. Pure projection of the session log;
 * a replayed session renders identically.
 * @module
 */
import { useEffect, useMemo, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { CSSProperties, ReactNode } from 'react'
// Context merges: slots/locale services reach this program through their
// client entries.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// SlotMap merge: conversation.view is declared by the conversation contract.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { WireChange, WireControl, WireIteration, WireModels, WirePlan, WireRound, WireSeries } from '../wire.ts'
import { CONTROL_PATH, MODELS_PATH, PRESET_ID, SERIES_PATH, samePath } from '../wire.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Kernel-opt panel copy. */
    'kernel-opt': LocaleKey
  }
}

const NS = 'kernel-opt'
const zh = {
  'tab.label': '评测',
  'empty.title': '还没有评测数据',
  'empty.body': 'Agent 每完成一次评测,这里就会实时出现一个数据点并连成优化曲线,方案汇报与监督记录也在此展示;把 kernel 和评测方式告诉 Agent 即可开始。',
  'chips.iterations': '{count} 次评测',
  'chips.best': '最佳 {latency}',
  'chips.profiles': '{count} 次 profile',
  'chips.hacks': '{count} 次 reward-hack 拦截',
  'chips.pending': '评测中…',
  'plan.title': '当前方案',
  'plan.none': '模型尚未调用 kernel_plan 汇报方案。',
  'plan.next': '下一步',
  'plan.count': '第 {n} 次汇报',
  'table.title': '迭代记录',
  'status.pending': '评测中',
  'status.ok': '通过',
  'status.wrong': '未通过',
  'status.hack': 'reward-hack',
  'status.error': '失败',
  'axis.best': '最佳',
  'loop.armed': '循环中 · 第 {round} 轮 · {done}/{budget} 评测',
  'loop.stopped': '循环已停:{reason}',
  'ctl.needTask': '先把任务告诉 Agent(要优化的 kernel 和评测方式),再启动循环',
  'pop.budget': '循环次数',
  'pop.supervise': '外部监督',
  'pop.model': '监督模型',
  'pop.footer': '优化曲线与完整记录在「评测」页',
  'sup.on': 'on',
  'sup.off': 'off',
  'sup.needCfg': '未配置监督模型:下拉选一个,或在插件 config 加 supervisor: { provider, model }',
  'sup.model': '监督模型',
  'sup.default': '默认:{route}',
  'sup.pick': '选择监督模型…',
  'ctl.start': '启动循环',
  'ctl.stop': '停止循环',
  'ctl.budget': '循环次数',
  'advice.title': '监督记录',
  'advice.waiting': '监督已开启,将在下一个续跑点复审。',
  'advice.round': '第 {n} 轮',
  'reason.finalized': '已 finalize',
  'reason.budget': '预算用尽,已请求收尾',
  'reason.no-progress': '连续无进展,已请求收尾',
  'reason.stopped': '手动停止',
  'row.plan': '生效方案',
  'row.review': '该轮监督',
  'row.metrics': '指标',
  'row.error': '错误',
  'row.blocking': '阻断项',
  'row.advisory': '提示项',
  'row.notMeasured': '未测得',
  'row.subset': '工作负载子集',
  'row.evaluatorFailed': '评测器故障(不构成对 kernel 的判定)',
  'row.changes': '本轮改动',
  'row.write': '整文件写入',
  'row.edit': '替换',
  'row.truncated': '(已截断)',
  'row.channelShell': '自报',
  'row.channelReplay': '复测',
  'row.command': '来源命令',
  'row.unverifiedFinal': '最终数字未复测(自报值)',
  'table.final': '提交',
} satisfies Record<string, string>
/** Panel locale key union. */
type LocaleKey = keyof typeof zh
const en = {
  'tab.label': 'Evaluations',
  'empty.title': 'No evaluations yet',
  'empty.body': 'Each completed evaluation adds a live point to the optimization curve here, along with plan reports and supervision notes; hand the agent a kernel and a way to evaluate it to begin.',
  'chips.iterations': '{count} evaluations',
  'chips.best': 'best {latency}',
  'chips.profiles': '{count} profiles',
  'chips.hacks': '{count} reward-hacks caught',
  'chips.pending': 'evaluating…',
  'plan.title': 'Current plan',
  'plan.none': 'The model has not reported a plan via kernel_plan yet.',
  'plan.next': 'Next',
  'plan.count': 'report #{n}',
  'table.title': 'Iterations',
  'status.pending': 'running',
  'status.ok': 'ok',
  'status.wrong': 'wrong',
  'status.hack': 'reward-hack',
  'status.error': 'failed',
  'axis.best': 'best',
  'loop.armed': 'looping · round {round} · {done}/{budget} evals',
  'loop.stopped': 'loop stopped: {reason}',
  'ctl.needTask': 'Tell the agent the task first (which kernel, how to evaluate), then arm the loop',
  'pop.budget': 'Loop count',
  'pop.supervise': 'External supervision',
  'pop.model': 'Supervisor model',
  'pop.footer': 'Curve and full records live on the Evaluations tab',
  'sup.on': 'on',
  'sup.off': 'off',
  'sup.needCfg': 'No supervisor model configured: pick one below, or add supervisor: { provider, model } to the plugin config',
  'sup.model': 'Supervisor model',
  'sup.default': 'default: {route}',
  'sup.pick': 'pick a supervisor model…',
  'ctl.start': 'Start loop',
  'ctl.stop': 'Stop loop',
  'ctl.budget': 'Loop count',
  'advice.title': 'Supervision log',
  'advice.waiting': 'Supervision on; it reviews at the next continuation point.',
  'advice.round': 'round {n}',
  'reason.finalized': 'finalized',
  'reason.budget': 'budget exhausted, wrap-up requested',
  'reason.no-progress': 'stalled, wrap-up requested',
  'reason.stopped': 'stopped manually',
  'row.plan': 'Plan in effect',
  'row.review': 'Supervision',
  'row.metrics': 'Metrics',
  'row.error': 'Error',
  'row.blocking': 'Blocking',
  'row.advisory': 'Advisory',
  'row.notMeasured': 'Not measured',
  'row.subset': 'Workload subset',
  'row.evaluatorFailed': 'Evaluator failed (not a verdict on the kernel)',
  'row.changes': 'Changes this round',
  'row.write': 'full write',
  'row.edit': 'edit',
  'row.truncated': '(truncated)',
  'row.channelShell': 'self-reported',
  'row.channelReplay': 'replayed',
  'row.command': 'Command',
  'row.unverifiedFinal': 'final number not replayed (self-reported)',
  'table.final': 'final',
} satisfies Record<string, string>

/** Poll cadence — the panel is a dashboard, not a ticker. */
const POLL_MS = 1500

/**
 * Palette: official alias tokens with safe fallbacks. Secondary text rides
 * primary-dimmed/tertiary (not caption) — caption-tier gray proved too light
 * against the panel cards in the field.
 */
const COLOR = {
  text: 'var(--dsw-alias-label-primary, #1f2329)',
  dim: 'var(--dsw-alias-label-primary-dimmed, #3d444d)',
  caption: 'var(--dsw-alias-label-tertiary, #5a6270)',
  border: 'var(--dsw-alias-border-l1, rgba(0,0,0,.12))',
  borderL2: 'var(--dsw-alias-border-l2, rgba(0,0,0,.15))',
  inputBg: 'var(--dsw-alias-bg-layer-1, #fff)',
  primaryFill: 'var(--dsw-alias-button-primary-fill, #4d6bfe)',
  primaryText: 'var(--dsw-alias-label-primary-foreground, #fff)',
  menuBg: 'var(--dsw-specific-menu, #fff)',
  menuBorder: 'var(--dsw-alias-border-inverted, rgba(0,0,0,.08))',
  tip: 'var(--dsw-specific-tip, rgba(77,107,254,.06))',
  curve: 'var(--dsw-specific-primary, #4d6bfe)',
  ok: '#1f8f5f',
  bad: '#d93a3f',
  warn: '#d18a1f',
}

/** Elevated-surface shadow (host menu dropdowns use shadow-lv3). */
const MENU_SHADOW = 'var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.14))'

/** Session-scoped polling hook for the panel series (+ manual refetch). */
/** One-shot fetch of the supervisor model catalog (picker options). */
function useModels(): WireModels | null {
  const [models, setModels] = useState<WireModels | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch(MODELS_PATH, { headers: { accept: 'application/json' } })
        if (!res.ok) return
        const data = (await res.json()) as WireModels
        if (alive && Array.isArray(data.providers)) setModels(data)
      } catch {
        // No catalog: the picker simply stays hidden; /supervise use still works.
      }
    })()
    return () => { alive = false }
  }, [])
  return models
}

/**
 * Lightweight control-state poll (GET on the control route) for the
 * chat-side loop affordances — a fraction of the series payload, so the
 * composer seats can poll without dragging the full iteration table along.
 */
function useControl(sessionId: string, pollMs = 2000): { control: WireControl | null; refetch: () => void } {
  const [control, setControl] = useState<WireControl | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    const pull = async (): Promise<void> => {
      try {
        const res = await fetch(`${CONTROL_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
          headers: { accept: 'application/json' },
        })
        if (!res.ok) return
        const data = (await res.json()) as { control?: WireControl }
        if (alive && data.control !== undefined) setControl(data.control)
      } catch {
        // Transient failure: keep showing the last known state.
      }
    }
    void pull()
    const timer = setInterval(() => { void pull() }, pollMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [sessionId, pollMs, tick])
  return { control, refetch: () => { setTick(value => value + 1) } }
}

function useSeries(sessionId: string): { series: WireSeries | null; refetch: () => void } {
  const [series, setSeries] = useState<WireSeries | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`${SERIES_PATH}?sessionId=${encodeURIComponent(sessionId)}`, {
          headers: { accept: 'application/json' },
        })
        if (!res.ok) return
        const data = (await res.json()) as WireSeries
        if (alive && Array.isArray(data.iterations)) setSeries(data)
      } catch {
        // Transient network error: keep the last frame, retry next tick.
      }
    }
    void poll()
    const timer = setInterval(() => { void poll() }, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [sessionId, tick])
  return { series, refetch: () => setTick(n => n + 1) }
}

/** Human latency: µs under 1 ms, ms under 1 s, s above. */
function formatLatency(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toPrecision(3)}µs`
  if (ms < 1000) return `${ms.toPrecision(4)}ms`
  return `${(ms / 1000).toPrecision(3)}s`
}

/** Status classification of one iteration for color and label. */
function statusOf(point: WireIteration): 'pending' | 'ok' | 'wrong' | 'hack' | 'error' {
  if (point.pending === true) return 'pending'
  if (point.rewardHack === true) return 'hack'
  if (point.error !== undefined) return 'error'
  if (point.correct === true) return 'ok'
  return 'wrong'
}

const STATUS_COLOR: Record<ReturnType<typeof statusOf>, string> = {
  pending: COLOR.caption,
  ok: COLOR.ok,
  wrong: COLOR.bad,
  hack: COLOR.warn,
  error: COLOR.bad,
}

/** Chart geometry constants (viewBox units). */
const CHART = { w: 640, h: 200, l: 56, r: 16, t: 16, b: 26 }

interface ChartModel {
  /** x in viewBox units per iteration index. */
  x: (index: number) => number
  /** y in viewBox units for a latency (clamped into the focus domain). */
  y: (latencyMs: number) => number
  /** Whether a latency lies above the focus domain (pinned to the top edge). */
  clamped: (latencyMs: number) => boolean
  /** Whether the y axis is log10. */
  log: boolean
  /** Focus-domain bounds, and the true series maximum for the clamp label. */
  lo: number
  hi: number
  max: number
  /** Latency at a fraction of the axis height (0 = domain bottom), for gridlines. */
  atFraction: (f: number) => number
}

/** Nearest-rank quantile of an ascending-sorted array. */
function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] ?? 0
}

/**
 * Build the y mapping from the measured latencies. The domain focuses on the
 * convergence band [best × 0.97, P90 × 1.25]: a run whose early exploration
 * sits far above its converged band would otherwise compress every later
 * improvement into a flat line, log axis or not. Points above the band stay
 * visible, pinned to the top edge with an ↑ mark and the maximum labeled.
 */
function chartModel(measured: readonly WireIteration[], count: number): ChartModel | null {
  const sorted = measured
    .map(p => p.latencyMs)
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const min = sorted[0] ?? 0
  const max = sorted[sorted.length - 1] ?? 0
  let hi = max
  if (sorted.length >= 6) {
    const band = quantile(sorted, 0.9) * 1.25
    if (band < hi) hi = band
  }
  const lo = min * 0.97
  const log = lo > 0 && hi / lo > 20
  const toAxis = (v: number): number => (log ? Math.log10(v) : v)
  const axLo = toAxis(lo)
  const span = toAxis(hi) - axLo || 1
  const innerW = CHART.w - CHART.l - CHART.r
  const innerH = CHART.h - CHART.t - CHART.b
  const denom = Math.max(1, count - 1)
  return {
    x: index => CHART.l + (innerW * index) / denom,
    y: (latencyMs) => {
      const v = Math.min(toAxis(latencyMs), axLo + span)
      return CHART.t + innerH * (1 - (v - axLo) / span)
    },
    clamped: latencyMs => latencyMs > hi,
    log, lo, hi, max,
    atFraction: (f) => {
      const v = axLo + span * f
      return log ? 10 ** v : v
    },
  }
}

/** Latency curve with per-point status, best line, profile ▲ and finalize ★. */
function Chart(props: {
  series: WireSeries
  bestLabel: string
  statusLabel: (status: ReturnType<typeof statusOf>) => string
}): ReactNode {
  const { series, bestLabel, statusLabel } = props
  const { iterations, profileSeqs, bestIndex } = series
  const model = useMemo(() => chartModel(iterations, iterations.length), [iterations])
  if (model === null) return null
  // The clamp label rides the first occurrence of the true maximum.
  const maxClampedIndex = iterations.findIndex(
    p => p.latencyMs === model.max && model.clamped(p.latencyMs),
  )

  const best = bestIndex !== null ? iterations[bestIndex] : undefined
  const linePoints = iterations
    .map((p, i) => (p.latencyMs !== undefined ? `${model.x(i).toFixed(1)},${model.y(p.latencyMs).toFixed(1)}` : null))
    .filter((s): s is string => s !== null)
    .join(' ')

  // Profile marks sit between the evaluations that surround them in the log.
  const profileXs = profileSeqs.map((seq) => {
    let before = -1
    for (let i = 0; i < iterations.length; i += 1) {
      const it = iterations[i]
      if (it !== undefined && it.seq < seq) before = i
    }
    const after = Math.min(before + 1, iterations.length - 1)
    const frac = before < 0 ? 0 : before === after ? 1 : 0.5
    return model.x(Math.max(0, before)) + (model.x(after) - model.x(Math.max(0, before))) * frac
  })

  return (
    <svg
      viewBox={`0 0 ${CHART.w} ${CHART.h}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
      role="img"
    >
      {/* frame + y domain bounds */}
      <line x1={CHART.l} y1={CHART.t} x2={CHART.l} y2={CHART.h - CHART.b} stroke={COLOR.border} strokeWidth={1} />
      <line x1={CHART.l} y1={CHART.h - CHART.b} x2={CHART.w - CHART.r} y2={CHART.h - CHART.b} stroke={COLOR.border} strokeWidth={1} />
      <text x={CHART.l - 6} y={CHART.t + 4} textAnchor="end" fontSize={12} fill={COLOR.dim}>{formatLatency(model.hi)}</text>
      <text x={CHART.l - 6} y={CHART.h - CHART.b} textAnchor="end" fontSize={12} fill={COLOR.dim}>{formatLatency(model.lo)}</text>
      {model.log
        ? <text x={CHART.l - 6} y={(CHART.t + CHART.h - CHART.b) / 2 + 14} textAnchor="end" fontSize={11} fill={COLOR.caption}>log</text>
        : null}

      {/* horizontal gridlines (mid one labeled) */}
      {[0.25, 0.5, 0.75].map((f) => {
        const value = model.atFraction(f)
        const gy = model.y(value)
        return (
          <g key={`g${String(f)}`}>
            <line x1={CHART.l} x2={CHART.w - CHART.r} y1={gy} y2={gy} stroke={COLOR.border} strokeWidth={1} strokeDasharray="2 5" opacity={0.55} />
            {f === 0.5
              ? <text x={CHART.l - 6} y={gy + 4} textAnchor="end" fontSize={10} fill={COLOR.caption}>{formatLatency(value)}</text>
              : null}
          </g>
        )
      })}

      {/* best dashed line */}
      {best?.latencyMs !== undefined
        ? (
            <g>
              <line
                x1={CHART.l} x2={CHART.w - CHART.r}
                y1={model.y(best.latencyMs)} y2={model.y(best.latencyMs)}
                stroke={COLOR.ok} strokeWidth={1} strokeDasharray="4 4" opacity={0.6}
              />
              <text x={CHART.w - CHART.r} y={model.y(best.latencyMs) - 4} textAnchor="end" fontSize={11} fill={COLOR.ok}>
                {bestLabel} {formatLatency(best.latencyMs)}
              </text>
            </g>
          )
        : null}

      {/* curve through measured points */}
      {linePoints.length > 0
        ? <polyline points={linePoints} fill="none" stroke={COLOR.curve} strokeWidth={1.6} opacity={0.9} />
        : null}

      {/* points */}
      {iterations.map((p, i) => {
        const status = statusOf(p)
        const color = STATUS_COLOR[status]
        const cx = model.x(i)
        const marks = `${bestIndex === i ? ' ★' : ''}${p.finalized === true ? ' ⚑' : ''}`
        const tip = `#${String(i + 1)} · ${p.latencyMs !== undefined ? formatLatency(p.latencyMs) : '—'} · ${statusLabel(status)}${marks}`
        if (p.latencyMs === undefined) {
          // Unmeasured (pending / failed) points sit on the baseline.
          const cy = CHART.h - CHART.b
          return (
            <g key={p.seq}>
              <title>{tip}</title>
              <circle cx={cx} cy={cy} r={3.5} fill="none" stroke={color} strokeWidth={1.5}>
                {status === 'pending'
                  ? <animate attributeName="opacity" values="1;0.25;1" dur="1.2s" repeatCount="indefinite" />
                  : null}
              </circle>
            </g>
          )
        }
        const cy = model.y(p.latencyMs)
        const isBest = bestIndex === i
        const clamped = model.clamped(p.latencyMs)
        return (
          <g key={p.seq}>
            <title>{tip}</title>
            {status === 'ok'
              ? <circle cx={cx} cy={cy} r={3.5} fill={color} />
              : <circle cx={cx} cy={cy} r={3.5} fill="none" stroke={color} strokeWidth={1.8} />}
            {/* ↑ marks a point above the focus domain, pinned to the top edge. */}
            {clamped
              ? <text x={cx} y={CHART.t - 4} textAnchor="middle" fontSize={9} fill={COLOR.caption}>↑</text>
              : null}
            {clamped && i === maxClampedIndex
              ? (
                  <text
                    x={cx < CHART.w / 2 ? cx + 7 : cx - 7}
                    y={CHART.t + 4}
                    textAnchor={cx < CHART.w / 2 ? 'start' : 'end'}
                    fontSize={11}
                    fill={COLOR.dim}
                  >
                    {formatLatency(model.max)}↑
                  </text>
                )
              : null}
            {/* ★ where the best result was FIRST reached; ⚑ on the finalized pick. */}
            {isBest
              ? <text x={cx} y={cy - 8} textAnchor="middle" fontSize={13} fill={COLOR.ok}>★</text>
              : null}
            {p.finalized === true
              ? <text x={cx} y={cy - (isBest ? 21 : 8)} textAnchor="middle" fontSize={12} fill={COLOR.warn}>⚑</text>
              : null}
          </g>
        )
      })}

      {/* profiler marks */}
      {profileXs.map((x, i) => (
        <text key={`p${String(i)}`} x={x} y={CHART.h - CHART.b + 13} textAnchor="middle" fontSize={10} fill={COLOR.caption}>▲</text>
      ))}
    </svg>
  )
}

// Sizes sit on the host type scale (ui-theme tokens 12/13/14/16): 14 body,
// 13 secondary, 12 captions — one tier above the first draft, which read a
// step smaller than the surrounding conversation UI.
const chipStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '2px 10px', borderRadius: 999,
  border: `1px solid ${COLOR.border}`,
  fontSize: 13, lineHeight: '22px', color: COLOR.dim,
  whiteSpace: 'nowrap',
}

const cardStyle: CSSProperties = {
  border: `1px solid ${COLOR.border}`,
  borderRadius: 12,
  background: COLOR.tip,
  padding: '10px 14px',
}

/** Chip-shaped select for the supervisor model picker. */
/**
 * Compact capsule button, after the host Button primitive's `sm` geometry
 * (h28 / r14 / 12px, borderless). `outline`/`primary` variants below mirror
 * the host's variant fills.
 */
const capsuleStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
  height: 28, padding: '0 12px', border: 'none', borderRadius: 14,
  fontSize: 12, lineHeight: '18px', fontFamily: 'inherit', whiteSpace: 'nowrap',
  color: COLOR.text, background: 'transparent', cursor: 'pointer',
}

/** Outline capsule (host dialog-cancel variant); accent colors border + text. */
function buttonStyle(accent?: string): CSSProperties {
  return {
    ...capsuleStyle,
    border: `1px solid ${accent ?? COLOR.borderL2}`,
    ...(accent !== undefined ? { color: accent } : {}),
  }
}

/**
 * Filled primary capsule — the send button's exact recipe (`button-info-fill`
 * + static white glyph; the `button-primary-fill` token resolves to ink and
 * reads far too heavy here). Gated/disabled renders at opacity 0.4, which is
 * also how the send circle gets its soft pre-send blue.
 */
const primaryBtnStyle: CSSProperties = {
  ...capsuleStyle,
  background: 'var(--dsw-alias-button-info-fill, #4d6bfe)',
  color: '#fff',
}

/** Disabled dressing for either button variant. */
const disabledBtnStyle: CSSProperties = { opacity: 0.4, cursor: 'not-allowed' }

/** Field geometry after the host Input primitive (r8, l2 border, layer-1 bg). */
const fieldStyle: CSSProperties = {
  height: 28, padding: '0 8px', borderRadius: 8,
  border: `1px solid ${COLOR.borderL2}`, background: COLOR.inputBg,
  fontSize: 12, fontFamily: 'inherit', color: COLOR.text, outline: 'none',
}

const selectStyle: CSSProperties = {
  ...fieldStyle,
  cursor: 'pointer',
  maxWidth: 260,
}

const inputStyle: CSSProperties = {
  ...fieldStyle,
  width: 64,
}

/** Inline control label (循环次数 / 外部监督 / 监督模型). */
const rowLabelStyle: CSSProperties = {
  flex: 'none', fontSize: 12, color: COLOR.dim,
}

/** Popover card, after the host MenuDropdown surface (r12, lv3 shadow). */
const popoverStyle: CSSProperties = {
  position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, zIndex: 41,
  minWidth: 264, display: 'flex', flexDirection: 'column', gap: 10, padding: 12,
  border: `1px solid ${COLOR.menuBorder}`, borderRadius: 12,
  background: COLOR.menuBg, boxShadow: MENU_SHADOW,
  fontFamily: 'system-ui', fontSize: 13, color: COLOR.text,
}

/** One labeled row inside the popover. */
const popoverRowStyle: CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
}

/** Monospace block for kernel text/diff halves; accent = left-border meaning. */
function preStyle(accent?: string): CSSProperties {
  return {
    margin: 0,
    padding: '6px 8px',
    fontSize: 12,
    lineHeight: '18px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    maxHeight: 220,
    overflowY: 'auto',
    background: 'rgba(127,127,127,.08)',
    borderRadius: 6,
    borderLeft: `3px solid ${accent ?? COLOR.border}`,
    color: COLOR.text,
  }
}

const sectionLabel: CSSProperties = { fontSize: 12, fontWeight: 600, color: COLOR.dim, marginBottom: 2 }

/** Metric number formatting: integers verbatim, floats to 4 significant digits. */
function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toPrecision(4)
}

/** Latest plan stated before a log position, if any. */
function planBefore(plans: readonly WirePlan[], seq: number): WirePlan | undefined {
  let found: WirePlan | undefined
  for (const plan of plans) {
    if (plan.seq < seq) found = plan
  }
  return found
}

/** Latest reviewed loop round delivered before a log position, if any. */
function reviewBefore(rounds: readonly WireRound[], seq: number): WireRound | undefined {
  let found: WireRound | undefined
  for (const round of rounds) {
    if (round.seq < seq && round.review !== undefined) found = round
  }
  return found
}

/** One structured artifact change, rendered as labeled monospace blocks. */
function ChangeBlock(props: { change: WireChange; t: PropsLocale<'kernel-opt'>['t'] }): ReactNode {
  const { change, t } = props
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 12, color: COLOR.caption, margin: '2px 0' }}>
        {t(change.kind === 'write' ? 'row.write' : 'row.edit')} · {change.tool}
        {change.replaceAll === true ? ' · replace_all' : ''}
        {change.truncated === true ? ` ${t('row.truncated')}` : ''}
      </div>
      {change.kind === 'write'
        ? <pre style={preStyle()}>{change.content}</pre>
        : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <pre style={preStyle(COLOR.bad)}>{change.oldText}</pre>
              <pre style={preStyle(COLOR.ok)}>{change.newText}</pre>
            </div>
          )}
    </div>
  )
}

/**
 * Expanded detail of one iteration: the evaluator's full verdict, the plan
 * and supervision in effect when it ran, and the artifact changes that led
 * into it — all recovered from the session log.
 */
function IterationDetail(props: {
  point: WireIteration
  plans: readonly WirePlan[]
  rounds: readonly WireRound[]
  t: PropsLocale<'kernel-opt'>['t']
  unverifiedFinal?: boolean
}): ReactNode {
  const { point, plans, rounds, t, unverifiedFinal } = props
  const plan = planBefore(plans, point.seq)
  const review = reviewBefore(rounds, point.seq)
  return (
    <div style={{
      padding: '8px 14px 12px 40px', borderBottom: `1px solid ${COLOR.border}`,
      display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13,
    }}>
      <div style={{ color: COLOR.caption, fontSize: 12 }}>
        {point.tool} · seq {point.seq}
        {point.channel !== undefined ? ` · ${t(point.channel === 'replay' ? 'row.channelReplay' : 'row.channelShell')}` : ''}
        {point.artifactPath !== undefined ? ` · ${point.artifactPath}` : ''}
        {point.workloadSubset !== undefined ? ` · ${t('row.subset')} [${point.workloadSubset.join(', ')}]` : ''}
      </div>
      {unverifiedFinal === true
        ? <div style={{ color: COLOR.warn, fontSize: 12 }}>⚠ {t('row.unverifiedFinal')}</div>
        : null}
      {point.command !== undefined
        ? (
            <div>
              <div style={sectionLabel}>{t('row.command')}</div>
              <pre style={preStyle(COLOR.border)}>{point.command}</pre>
            </div>
          )
        : null}
      {point.evaluatorFailed === true
        ? <div style={{ color: COLOR.warn }}>{t('row.evaluatorFailed')}</div>
        : null}
      {point.error !== undefined
        ? (
            <div>
              <div style={sectionLabel}>{t('row.error')}</div>
              <pre style={preStyle(COLOR.bad)}>{point.error}</pre>
            </div>
          )
        : null}
      {point.blocking !== undefined
        ? (
            <div>
              <div style={sectionLabel}>{t('row.blocking')}</div>
              {point.blocking.map((line, index) => (
                <div key={index} style={{ fontSize: 12, color: COLOR.bad }}>· {line}</div>
              ))}
            </div>
          )
        : null}
      {point.advisory !== undefined
        ? (
            <div>
              <div style={sectionLabel}>{t('row.advisory')}</div>
              {point.advisory.map((line, index) => (
                <div key={index} style={{ fontSize: 12, color: COLOR.dim }}>· {line}</div>
              ))}
            </div>
          )
        : null}
      {point.notMeasured !== undefined
        ? <div style={{ fontSize: 12, color: COLOR.caption }}>{t('row.notMeasured')}: {point.notMeasured.join(', ')}</div>
        : null}
      {point.metrics !== undefined
        ? (
            <div>
              <div style={sectionLabel}>{t('row.metrics')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Object.entries(point.metrics).map(([key, value]) => (
                  <span key={key} style={{ ...chipStyle, fontSize: 12, lineHeight: '18px', padding: '1px 8px' }}>
                    {key} = {formatMetric(value)}
                  </span>
                ))}
              </div>
            </div>
          )
        : null}
      {plan !== undefined
        ? (
            <div>
              <div style={sectionLabel}>{t('row.plan')}</div>
              <div style={{ color: COLOR.dim }}>[{plan.phase}] {plan.approach}</div>
            </div>
          )
        : null}
      {review !== undefined
        ? (
            <div>
              <div style={sectionLabel}>{t('row.review')}</div>
              {review.review === 'ok'
                ? <div style={{ color: COLOR.ok }}>✓ OK</div>
                : <div style={{ color: COLOR.dim, whiteSpace: 'pre-wrap' }}>{review.review}</div>}
            </div>
          )
        : null}
      {/* Only when structured write/edit calls were captured — a bash-written
          round shows no section rather than a permanent placeholder. */}
      {point.changes !== undefined
        ? (
            <div>
              <div style={sectionLabel}>{t('row.changes')}</div>
              {point.changes.map(change => <ChangeBlock key={change.seq} change={change} t={t} />)}
            </div>
          )
        : null}
    </div>
  )
}

/** Locale binding shape shared by the panel and the chat-side components. */
type T = PropsLocale<'kernel-opt'>['t']

/**
 * Supervision on/off capsule, shared by the panel row and the launch
 * popover. Unconfigured (no config route, no session override) renders
 * disabled with the how-to in its tooltip.
 */
function SuperviseToggle(props: { control: WireControl; t: T; onToggle: () => void }): ReactNode {
  const { control, t, onToggle } = props
  const enabled = control.supervisor.enabled
  const configured = control.supervisor.configured
  return (
    <button
      type="button"
      style={{
        ...buttonStyle(enabled ? COLOR.warn : undefined),
        ...(configured ? {} : disabledBtnStyle),
      }}
      disabled={!configured}
      title={configured ? undefined : t('sup.needCfg')}
      onClick={onToggle}
    >
      {t(enabled ? 'sup.on' : 'sup.off')}
    </button>
  )
}

/**
 * Supervisor-model picker, shared by the panel row and the launch popover.
 * Two-layer semantics: '' = the plugin-config default (labeled with the
 * actual route when one is configured), any other value = session override.
 */
function SupervisorSelect(props: {
  control: WireControl
  models: WireModels | null
  t: T
  onUse: (provider: string, model: string) => void
  style?: CSSProperties
}): ReactNode {
  const { control, models, t, onUse } = props
  const effective = control.supervisor.effective
  const overrideValue = effective !== undefined && effective.source === 'session'
    ? `${effective.provider}/${effective.model}`
    : ''
  const providers = models?.providers ?? []
  const known = providers.flatMap(p => p.models.map(m => `${p.id}/${m.id}`))
  // Options show model DISPLAY names (the official picker's convention);
  // the provider/model id pair stays in the option value only.
  const displayName = (provider: string, model: string): string => {
    for (const p of providers) {
      if (p.id !== provider) continue
      const match = p.models.find(m => m.id === model)
      if (match !== undefined) return match.name
    }
    return `${provider}/${model}`
  }
  const configRoute = control.supervisor.configRoute
  const defaultLabel = configRoute !== undefined
    ? t('sup.default', { route: displayName(configRoute.provider, configRoute.model) })
    : t('sup.pick')
  const optionsFor = (provider: WireModels['providers'][number]): ReactNode =>
    provider.models.map(model => (
      <option key={`${provider.id}/${model.id}`} value={`${provider.id}/${model.id}`}>
        {model.name}
      </option>
    ))
  return (
    <select
      value={overrideValue}
      title={t('sup.model')}
      style={{ ...selectStyle, ...props.style }}
      onChange={(event) => {
        const value = event.target.value
        if (value === '') {
          onUse('', '')
          return
        }
        // First slash splits: provider routes carry no slash, model ids may
        // (org/model).
        const slash = value.indexOf('/')
        onUse(value.slice(0, slash), value.slice(slash + 1))
      }}
    >
      <option value="">{defaultLabel}</option>
      {overrideValue !== '' && !known.includes(overrideValue)
        ? <option value={overrideValue}>{overrideValue}</option>
        : null}
      {providers.length === 1 && providers[0] !== undefined
        ? optionsFor(providers[0])
        : providers.map(provider => (
            <optgroup key={provider.id} label={provider.name}>
              {optionsFor(provider)}
            </optgroup>
          ))}
    </select>
  )
}

/** The evaluation tab. */
export function KernelOptTab(
  props: PropsRuntime<'conversation.view'> & PropsLocale<'kernel-opt'>,
): ReactNode {
  const { t, sessionId } = props
  const { series, refetch } = useSeries(sessionId)
  const models = useModels()
  const [budgetDraft, setBudgetDraft] = useState('20')
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null)

  /** Drive the control route, then re-pull so the panel reflects it now. */
  const post = async (action: string, extra?: Record<string, unknown>): Promise<void> => {
    try {
      await fetch(CONTROL_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, action, ...extra }),
      })
    } catch {
      // Transient failure: the poll keeps showing the authoritative state.
    }
    refetch()
  }

  const iterations = series?.iterations ?? []
  const plans = series?.plans ?? []
  const rounds = series?.rounds ?? []
  const control = series?.control
  const latestPlan = plans.length > 0 ? plans[plans.length - 1] : undefined
  const best = series !== null && series.bestIndex !== null ? iterations[series.bestIndex] : undefined
  const hackCount = iterations.filter(p => p.rewardHack === true).length
  const pendingCount = iterations.filter(p => p.pending === true).length
  const reviewedRounds = rounds.filter(r => r.review !== undefined)
  const reasonLabel = (reason: string): string =>
    reason === 'finalized' || reason === 'budget' || reason === 'no-progress' || reason === 'stopped'
      ? t(`reason.${reason}`)
      : reason

  const empty = iterations.length === 0 && plans.length === 0

  return (
    <div style={{
      padding: '16px 20px', maxWidth: 860, margin: '0 auto',
      display: 'flex', flexDirection: 'column', gap: 14,
      fontFamily: 'system-ui', color: COLOR.text,
    }}>
      {/* controls: one row for the loop, one for supervision, then data chips */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {control?.loop.armed === true
            ? (
                <>
                  <span style={{ fontSize: 13, color: COLOR.curve, fontWeight: 500 }}>
                    ⟳ {t('loop.armed', {
                      round: control.loop.round,
                      done: control.loop.evalsDone,
                      budget: control.loop.budget,
                    })}
                  </span>
                  <button type="button" style={buttonStyle(COLOR.bad)} onClick={() => { void post('loop-stop') }}>
                    ■ {t('ctl.stop')}
                  </button>
                </>
              )
            : null}
          {control !== undefined && control.loop.armed === false && control.loop.available
            ? (
                <>
                  <span style={rowLabelStyle}>{t('pop.budget')}</span>
                  <input
                    type="number"
                    min={1}
                    max={9999}
                    value={budgetDraft}
                    title={t('ctl.budget')}
                    style={inputStyle}
                    onChange={(event) => { setBudgetDraft(event.target.value) }}
                  />
                  <button
                    type="button"
                    style={{ ...primaryBtnStyle, ...(control.loop.taskReady ? {} : disabledBtnStyle) }}
                    disabled={!control.loop.taskReady}
                    title={control.loop.taskReady ? undefined : t('ctl.needTask')}
                    onClick={() => {
                      const budget = Number(budgetDraft)
                      void post('loop-arm', Number.isInteger(budget) && budget > 0 ? { budget } : {})
                    }}
                  >
                    ⟳ {t('ctl.start')}
                  </button>
                  {control.loop.stopReason !== undefined
                    ? (
                        <span style={{ fontSize: 12, color: COLOR.caption }}>
                          {t('loop.stopped', { reason: reasonLabel(control.loop.stopReason) })}
                        </span>
                      )
                    : null}
                </>
              )
            : null}
        </div>
        {control !== undefined
          ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <span style={rowLabelStyle}>{t('pop.supervise')}</span>
                <SuperviseToggle
                  control={control}
                  t={t}
                  onToggle={() => { void post(control.supervisor.enabled ? 'supervise-off' : 'supervise-on') }}
                />
                <span style={{ ...rowLabelStyle, marginLeft: 6 }}>{t('pop.model')}</span>
                <SupervisorSelect
                  control={control}
                  models={models}
                  t={t}
                  onUse={(provider, model) => { void post('supervise-use', { provider, model }) }}
                />
              </div>
            )
          : null}
        {iterations.length > 0 || (series !== null && series.profileSeqs.length > 0)
          ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <span style={chipStyle}>{t('chips.iterations', { count: iterations.length })}</span>
                {best?.latencyMs !== undefined
                  ? (
                      <span style={{ ...chipStyle, color: COLOR.ok, borderColor: COLOR.ok, fontWeight: 500 }}>
                        {t('chips.best', { latency: formatLatency(best.latencyMs) })}
                        {best.speedup !== undefined ? ` · ×${best.speedup.toPrecision(3)}` : ''}
                      </span>
                    )
                  : null}
                {series !== null && series.profileSeqs.length > 0
                  ? <span style={chipStyle}>{t('chips.profiles', { count: series.profileSeqs.length })}</span>
                  : null}
                {hackCount > 0
                  ? <span style={{ ...chipStyle, color: COLOR.warn, borderColor: COLOR.warn }}>{t('chips.hacks', { count: hackCount })}</span>
                  : null}
                {pendingCount > 0
                  ? <span style={{ ...chipStyle, color: COLOR.caption }}>{t('chips.pending')}</span>
                  : null}
              </div>
            )
          : null}
      </div>

      {/* empty-state guidance: the controls above stay usable before the
          first evaluation; only the data area explains itself. */}
      {empty
        ? (
            <div style={{ padding: '18px 4px', color: COLOR.dim }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: COLOR.text, marginBottom: 8 }}>{t('empty.title')}</div>
              <div style={{ fontSize: 14, lineHeight: '23px' }}>{t('empty.body')}</div>
            </div>
          )
        : null}

      {/* curve */}
      {iterations.length > 0
        ? (
            <div style={cardStyle}>
              <Chart
                series={series as WireSeries}
                bestLabel={t('axis.best')}
                statusLabel={status => t(`status.${status}`)}
              />
            </div>
          )
        : null}

      {/* latest plan (hidden while empty — the guidance block covers it) */}
      {empty
        ? null
        : (
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{t('plan.title')}</span>
          {latestPlan !== undefined
            ? (
                <span style={{ fontSize: 12, color: COLOR.caption }}>
                  {t('plan.count', { n: plans.length })}
                </span>
              )
            : null}
        </div>
        {latestPlan === undefined
          ? <div style={{ fontSize: 14, color: COLOR.caption }}>{t('plan.none')}</div>
          : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    ...chipStyle,
                    color: COLOR.curve, borderColor: COLOR.curve,
                    fontSize: 12, padding: '0 8px',
                  }}>{latestPlan.phase}</span>
                  <span style={{ fontSize: 14, fontWeight: 500 }}>{latestPlan.approach}</span>
                </div>
                {latestPlan.hypothesis !== undefined
                  ? <div style={{ fontSize: 13, color: COLOR.dim }}>{latestPlan.hypothesis}</div>
                  : null}
                {latestPlan.next !== undefined
                  ? <div style={{ fontSize: 13, color: COLOR.dim }}>{t('plan.next')} → {latestPlan.next}</div>
                  : null}
              </div>
            )}
      </div>
          )}

      {/* supervision log — parsed back from the continuation messages, so it
          survives restarts and replays with the rest of the projection. */}
      {reviewedRounds.length > 0 || control?.supervisor.enabled === true
        ? (
            <div style={{ ...cardStyle, borderColor: COLOR.warn }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: COLOR.warn }}>{t('advice.title')}</div>
              {reviewedRounds.length === 0
                ? <div style={{ fontSize: 13, color: COLOR.caption }}>{t('advice.waiting')}</div>
                : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 200, overflowY: 'auto' }}>
                      {[...reviewedRounds].reverse().map(round => (
                        <div key={round.seq} style={{ display: 'flex', gap: 10, fontSize: 13, lineHeight: '20px' }}>
                          <span style={{ flex: 'none', minWidth: 56, color: COLOR.caption }}>
                            {t('advice.round', { n: round.round ?? '—' })}
                          </span>
                          {round.review === 'ok'
                            ? <span style={{ color: COLOR.ok }}>✓ OK</span>
                            : <span style={{ color: COLOR.dim, whiteSpace: 'pre-wrap' }}>{round.review}</span>}
                        </div>
                      ))}
                    </div>
                  )}
            </div>
          )
        : null}

      {/* iteration table */}
      {iterations.length > 0
        ? (
            <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '8px 14px', fontSize: 14, fontWeight: 600, borderBottom: `1px solid ${COLOR.border}` }}>
                {t('table.title')}
              </div>
              <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                {[...iterations].reverse().map((p) => {
                  const status = statusOf(p)
                  const idx = iterations.indexOf(p)
                  const isBest = series !== null && series.bestIndex === idx
                  const expanded = expandedSeq === p.seq
                  // A finalized self-reported point without a replay point on
                  // the same artifact: the final number was never re-measured.
                  const unverifiedFinal = p.finalized === true && p.channel === 'shell'
                    && !iterations.some(q => q.channel === 'replay' && q.artifactPath !== undefined
                      && p.artifactPath !== undefined && samePath(q.artifactPath, p.artifactPath))
                  return (
                    <div key={p.seq}>
                      <div
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '5px 14px', fontSize: 13, lineHeight: '22px',
                          borderBottom: `1px solid ${COLOR.border}`,
                          cursor: 'pointer',
                        }}
                        onClick={() => { setExpandedSeq(expanded ? null : p.seq) }}
                      >
                        <span style={{ flex: 'none', width: 14, color: COLOR.caption }}>{expanded ? '▾' : '▸'}</span>
                        <span style={{ flex: 'none', width: 32, color: COLOR.caption }}>#{idx + 1}</span>
                        <span style={{ flex: 'none', width: 58, color: COLOR.dim }}>{p.evaluationId ?? '—'}</span>
                        <span style={{ flex: 'none', width: 92, color: COLOR.text, fontVariantNumeric: 'tabular-nums' }}>
                          {p.latencyMs !== undefined ? formatLatency(p.latencyMs) : '—'}
                        </span>
                        {/* speedup vs the reference kernel (evaluator-reported) — rises and falls. */}
                        <span style={{
                          flex: 'none', width: 70, fontVariantNumeric: 'tabular-nums', fontWeight: isBest ? 600 : 400,
                          color: isBest ? COLOR.ok : COLOR.dim,
                        }}>
                          {p.speedup !== undefined ? `×${p.speedup.toPrecision(3)}` : ''}
                        </span>
                        <span style={{ flex: 1 }} />
                        {p.channel !== undefined
                          ? (
                              <span style={{
                                flex: 'none', fontSize: 11, lineHeight: '16px', padding: '0 6px',
                                borderRadius: 4, border: `1px solid ${COLOR.border}`,
                                color: p.channel === 'replay' ? COLOR.ok : COLOR.caption,
                              }}>
                                {t(p.channel === 'replay' ? 'row.channelReplay' : 'row.channelShell')}
                              </span>
                            )
                          : null}
                        {isBest ? <span style={{ flex: 'none', color: COLOR.ok }}>★</span> : null}
                        {p.finalized === true ? <span style={{ flex: 'none', color: COLOR.warn }}>⚑ {t('table.final')}</span> : null}
                        <span style={{ flex: 'none', color: STATUS_COLOR[status], fontWeight: 500 }}>
                          {t(`status.${status}`)}
                        </span>
                      </div>
                      {expanded
                        ? <IterationDetail point={p} plans={plans} rounds={rounds} t={t} unverifiedFinal={unverifiedFinal} />
                        : null}
                    </div>
                  )
                })}
              </div>
            </div>
          )
        : null}
    </div>
  )
}

/**
 * Composer tool-row loop launcher — the idle half of the chat-side loop
 * affordance. One trigger capsule in the tool row; clicking opens a
 * menu-styled popover carrying the full launch settings (budget, supervision
 * toggle, supervisor model), the arm button (gated until the session has a
 * human task, mirroring the Node-side gate), and a pointer to the
 * Evaluations tab for the live curve.
 */
export function ChatLoopButton(
  props: PropsRuntime<'conversation.input.left'> & PropsLocale<'kernel-opt'>,
): ReactNode {
  const { t } = props
  const sessionId = props.session.sessionId
  const { control, refetch } = useControl(sessionId)
  const models = useModels()
  const [open, setOpen] = useState(false)
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null)
  if (control === null || !control.loop.available || control.loop.armed) return null
  const post = async (action: string, extra?: Record<string, unknown>): Promise<void> => {
    try {
      await fetch(CONTROL_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, action, ...extra }),
      })
    } catch {
      // Transient failure: the poll keeps showing the authoritative state.
    }
    refetch()
  }
  const ready = control.loop.taskReady
  const budgetValue = budgetDraft ?? String(control.loop.defaultBudget)
  const arm = async (): Promise<void> => {
    const budget = Number(budgetValue)
    await post('loop-arm', Number.isInteger(budget) && budget > 0 ? { budget } : {})
    setOpen(false)
  }
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        style={buttonStyle(COLOR.curve)}
        title={t('ctl.start')}
        onClick={() => { setOpen(value => !value) }}
      >
        ⟳ {t('ctl.start')}
      </button>
      {open
        ? (
            <>
              {/* Click-away layer: the popover closes like a host menu. */}
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => { setOpen(false) }} />
              <div style={popoverStyle}>
                <label style={popoverRowStyle}>
                  <span>{t('pop.budget')}</span>
                  <input
                    type="number"
                    min={1}
                    max={9999}
                    value={budgetValue}
                    style={inputStyle}
                    onChange={(event) => { setBudgetDraft(event.target.value) }}
                  />
                </label>
                <div style={popoverRowStyle}>
                  <span>{t('pop.supervise')}</span>
                  <SuperviseToggle
                    control={control}
                    t={t}
                    onToggle={() => { void post(control.supervisor.enabled ? 'supervise-off' : 'supervise-on') }}
                  />
                </div>
                <div style={popoverRowStyle}>
                  <span>{t('pop.model')}</span>
                  <SupervisorSelect
                    control={control}
                    models={models}
                    t={t}
                    onUse={(provider, model) => { void post('supervise-use', { provider, model }) }}
                    style={{ maxWidth: 170 }}
                  />
                </div>
                <button
                  type="button"
                  style={{ ...primaryBtnStyle, ...(ready ? {} : disabledBtnStyle), marginTop: 2 }}
                  disabled={!ready}
                  onClick={() => { void arm() }}
                >
                  ⟳ {t('ctl.start')}
                </button>
                <div style={{ fontSize: 12, lineHeight: '18px', color: COLOR.caption }}>
                  {ready ? t('pop.footer') : t('ctl.needTask')}
                </div>
              </div>
            </>
          )
        : null}
    </span>
  )
}

/**
 * Above-composer strip — the armed half of the chat-side loop affordance:
 * round/budget state plus a stop button, so a running loop is visible and
 * stoppable without leaving the chat view. Renders nothing while disarmed,
 * so the idle composer stays untouched.
 */
export function ChatLoopStrip(
  props: PropsRuntime<'conversation.input.dock'> & PropsLocale<'kernel-opt'>,
): ReactNode {
  const { t } = props
  const sessionId = props.session.sessionId
  const { control, refetch } = useControl(sessionId)
  if (control === null || !control.loop.armed) return null
  const stop = async (): Promise<void> => {
    try {
      await fetch(CONTROL_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, action: 'loop-stop' }),
      })
    } catch {
      // Transient failure: the poll keeps showing the authoritative state.
    }
    refetch()
  }
  return (
    // Width rides the composer card's own tokens (the QueueDock recipe), so
    // the strip lines up with the input card instead of spanning the page.
    <div style={{
      boxSizing: 'border-box',
      width: 'calc(100% - var(--dsh-composer-side-clearance, 12px) * 2)',
      maxWidth: 'var(--dsh-composer-card-max-width, 800px)',
      margin: '0 auto',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '5px 12px', fontSize: 13, fontFamily: 'system-ui',
        border: `1px solid ${COLOR.curve}`, borderRadius: 12,
        background: COLOR.tip, color: COLOR.text,
      }}>
        <span style={{ color: COLOR.curve, fontWeight: 500 }}>
          ⟳ {t('loop.armed', { round: control.loop.round, done: control.loop.evalsDone, budget: control.loop.budget })}
        </span>
        <span style={{ flex: 1 }} />
        <button type="button" style={buttonStyle(COLOR.bad)} onClick={() => { void stop() }}>
          ■ {t('ctl.stop')}
        </button>
      </div>
    </div>
  )
}

/** Client-half service requirements. */
export const inject = ['slots', 'locale', 'sessions']

/** How often the watcher re-checks the current session for kernel-opt signals. */
const DETECT_MS = 3000

/** Whether a session has anything the evaluation tab could show. */
function kernelOptRelevant(series: WireSeries): boolean {
  return series.iterations.length > 0
    || series.plans.length > 0
    || series.control?.loop.armed === true
}

/**
 * Mount the locale namespace and the session tab. The tab is NOT registered
 * unconditionally: a watcher follows the current session (`ctx.sessions.list`)
 * and holds the `conversation.view` registration only while that session
 * shows kernel-opt signals — evaluations, plans, or an armed loop. Unrelated
 * conversations never grow the tab; it appears by itself once the first
 * evaluation (or `/kloop`) lands, and the view ring follows registration
 * changes reactively (an active view that disappears falls back to the first
 * tab).
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'kernel-opt: dictionaries')
  ctx.slots.inject('conversation.view', () => {
    let hold: (() => void) | undefined
    let disposed = false
    let generation = 0
    const show = (): void => {
      if (disposed || hold !== undefined) return
      // The tab and both chat-side loop affordances ride one visibility
      // decision: a session that deserves the evaluation tab also deserves
      // the composer loop entry and the armed strip.
      const holds = [
        ctx.slots.register({
          name: 'conversation.view',
          id: 'kernel-opt',
          order: 30,
          // Locale-thunked like the host's own tabs (ui-trajectory), so the
          // tab name follows the active language without re-registration.
          label: () => t('tab.label'),
          locale: NS,
        }, KernelOptTab),
        ctx.slots.register({ name: 'conversation.input.left', id: 'kernel-opt-loop', order: 50, locale: NS }, ChatLoopButton),
        ctx.slots.register({ name: 'conversation.input.dock', id: 'kernel-opt-strip', order: 50, locale: NS }, ChatLoopStrip),
      ]
      hold = () => { for (const dispose of holds) dispose() }
    }
    const hide = (): void => {
      hold?.()
      hold = undefined
    }
    const sync = async (): Promise<void> => {
      const gen = ++generation
      const state = ctx.sessions.list.getSnapshot()
      const current = state.current
      if (current === undefined) {
        hide()
        return
      }
      // Preset-first: a session composed from the kernel-opt preset is a
      // kernel-optimization session by declaration — the tab shows before
      // any evaluation lands, no series fetch needed.
      if (state.byId[current]?.agentPreset === PRESET_ID) {
        show()
        return
      }
      try {
        const res = await fetch(`${SERIES_PATH}?sessionId=${encodeURIComponent(current)}`, {
          headers: { accept: 'application/json' },
        })
        if (gen !== generation || disposed) return
        if (!res.ok) {
          hide()
          return
        }
        const data = (await res.json()) as WireSeries
        if (gen !== generation || disposed) return
        if (kernelOptRelevant(data)) show()
        else hide()
      } catch {
        // Transient network error: keep the current visibility.
      }
    }
    const unsubscribe = ctx.sessions.list.subscribe(() => { void sync() })
    const timer = setInterval(() => { void sync() }, DETECT_MS)
    void sync()
    return () => {
      disposed = true
      clearInterval(timer)
      unsubscribe()
      hide()
    }
  })
}
