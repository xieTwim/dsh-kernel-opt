/**
 * dsh-kernel-cockpit — browser half.
 *
 * "优化驾驶舱" session tab (`conversation.view` slot): polls the Node half's
 * series route and renders the live optimization picture — latency curve over
 * evaluations (log scale when the journey is wide), correctness/reward-hack
 * status per point, profiler ▲ and finalize ★ marks, the model's latest
 * `cockpit_plan`, and an iteration table. Pure projection of the session log;
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
import type { WireIteration, WireSeries } from '../wire.ts'
import { SERIES_PATH } from '../wire.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Kernel-cockpit copy. */
    'kernel-cockpit': CockpitKey
  }
}

const NS = 'kernel-cockpit'
const zh = {
  'empty.title': '还没有评测数据',
  'empty.body': '当 agent 调用 kernel 评测工具(如 kernel_evaluate)后,这里会实时出现优化曲线;模型调用 cockpit_plan 后会展示当前方案。',
  'chips.iterations': '{count} 次评测',
  'chips.best': '最佳 {latency}',
  'chips.profiles': '{count} 次 profile',
  'chips.hacks': '{count} 次 reward-hack 拦截',
  'chips.pending': '评测中…',
  'plan.title': '当前方案',
  'plan.none': '模型尚未调用 cockpit_plan 汇报方案。',
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
  'loop.stopped': '循环已停({reason})',
  'loop.hint': '/kloop [预算] 启动循环 · /supervise on 开启第二模型监督',
  'sup.on': '监督 on',
  'sup.off': '监督 off',
  'advice.title': '监督建议',
} satisfies Record<string, string>
/** Cockpit locale key union. */
type CockpitKey = keyof typeof zh
const en = {
  'empty.title': 'No evaluations yet',
  'empty.body': 'Once the agent calls a kernel bench tool (e.g. kernel_evaluate) the optimization curve appears here live; cockpit_plan calls show the current plan.',
  'chips.iterations': '{count} evaluations',
  'chips.best': 'best {latency}',
  'chips.profiles': '{count} profiles',
  'chips.hacks': '{count} reward-hacks caught',
  'chips.pending': 'evaluating…',
  'plan.title': 'Current plan',
  'plan.none': 'The model has not reported a plan via cockpit_plan yet.',
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
  'loop.stopped': 'loop stopped ({reason})',
  'loop.hint': '/kloop [budget] arms the loop · /supervise on enables the second model',
  'sup.on': 'supervisor on',
  'sup.off': 'supervisor off',
  'advice.title': 'Supervisor advice',
} satisfies Record<string, string>

/** Poll cadence — the panel is a dashboard, not a ticker. */
const POLL_MS = 1500

/** Palette: official alias tokens with safe fallbacks. */
const COLOR = {
  text: 'var(--dsw-alias-label-primary, #1f2329)',
  dim: 'var(--dsw-alias-label-primary-dimmed, #51565d)',
  caption: 'var(--dsw-alias-label-caption, #8a9099)',
  border: 'var(--dsw-alias-border-l1, rgba(0,0,0,.12))',
  tip: 'var(--dsw-specific-tip, rgba(77,107,254,.06))',
  curve: 'var(--dsw-specific-primary, #4d6bfe)',
  ok: '#2ea56f',
  bad: '#e5484d',
  warn: '#e8a13c',
}

/** Session-scoped polling hook for the cockpit series. */
function useSeries(sessionId: string): WireSeries | null {
  const [series, setSeries] = useState<WireSeries | null>(null)
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
  }, [sessionId])
  return series
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
  /** y in viewBox units for a latency. */
  y: (latencyMs: number) => number
  /** Whether the y axis is log10. */
  log: boolean
  min: number
  max: number
}

/** Build the y mapping from the measured latencies (log when the span is wide). */
function chartModel(measured: readonly WireIteration[], count: number): ChartModel | null {
  const lats = measured.map(p => p.latencyMs).filter((v): v is number => v !== undefined)
  if (lats.length === 0) return null
  const min = Math.min(...lats)
  const max = Math.max(...lats)
  const log = min > 0 && max / min > 20
  const lo = log ? Math.log10(min) : min
  const hi = log ? Math.log10(max) : max
  const span = hi - lo || 1
  const innerW = CHART.w - CHART.l - CHART.r
  const innerH = CHART.h - CHART.t - CHART.b
  const denom = Math.max(1, count - 1)
  return {
    x: index => CHART.l + (innerW * index) / denom,
    y: (latencyMs) => {
      const v = log ? Math.log10(latencyMs) : latencyMs
      return CHART.t + innerH * (1 - (v - lo) / span)
    },
    log, min, max,
  }
}

/** Latency curve with per-point status, best line, profile ▲ and finalize ★. */
function Chart(props: { series: WireSeries; bestLabel: string }): ReactNode {
  const { series, bestLabel } = props
  const { iterations, profileSeqs, bestIndex } = series
  const model = useMemo(() => chartModel(iterations, iterations.length), [iterations])
  if (model === null) return null

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
      {/* frame + y extremes */}
      <line x1={CHART.l} y1={CHART.t} x2={CHART.l} y2={CHART.h - CHART.b} stroke={COLOR.border} strokeWidth={1} />
      <line x1={CHART.l} y1={CHART.h - CHART.b} x2={CHART.w - CHART.r} y2={CHART.h - CHART.b} stroke={COLOR.border} strokeWidth={1} />
      <text x={CHART.l - 6} y={CHART.t + 4} textAnchor="end" fontSize={10} fill={COLOR.caption}>{formatLatency(model.max)}</text>
      <text x={CHART.l - 6} y={CHART.h - CHART.b} textAnchor="end" fontSize={10} fill={COLOR.caption}>{formatLatency(model.min)}</text>
      {model.log
        ? <text x={CHART.l - 6} y={(CHART.t + CHART.h - CHART.b) / 2} textAnchor="end" fontSize={9} fill={COLOR.caption}>log</text>
        : null}

      {/* best dashed line */}
      {best?.latencyMs !== undefined
        ? (
            <g>
              <line
                x1={CHART.l} x2={CHART.w - CHART.r}
                y1={model.y(best.latencyMs)} y2={model.y(best.latencyMs)}
                stroke={COLOR.ok} strokeWidth={1} strokeDasharray="4 4" opacity={0.6}
              />
              <text x={CHART.w - CHART.r} y={model.y(best.latencyMs) - 4} textAnchor="end" fontSize={10} fill={COLOR.ok}>
                {bestLabel} {formatLatency(best.latencyMs)}
              </text>
            </g>
          )
        : null}

      {/* curve through measured points */}
      {linePoints.length > 0
        ? <polyline points={linePoints} fill="none" stroke={COLOR.curve} strokeWidth={1.5} opacity={0.75} />
        : null}

      {/* points */}
      {iterations.map((p, i) => {
        const status = statusOf(p)
        const color = STATUS_COLOR[status]
        const cx = model.x(i)
        if (p.latencyMs === undefined) {
          // Unmeasured (pending / failed) points sit on the baseline.
          const cy = CHART.h - CHART.b
          return (
            <g key={p.seq}>
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
        return (
          <g key={p.seq}>
            {isBest ? <circle cx={cx} cy={cy} r={7} fill="none" stroke={COLOR.ok} strokeWidth={1.5} opacity={0.9} /> : null}
            {status === 'ok'
              ? <circle cx={cx} cy={cy} r={3.5} fill={color} />
              : <circle cx={cx} cy={cy} r={3.5} fill="none" stroke={color} strokeWidth={1.8} />}
            {p.finalized === true
              ? <text x={cx} y={cy - 8} textAnchor="middle" fontSize={11} fill={COLOR.warn}>★</text>
              : null}
          </g>
        )
      })}

      {/* profiler marks */}
      {profileXs.map((x, i) => (
        <text key={`p${String(i)}`} x={x} y={CHART.h - CHART.b + 12} textAnchor="middle" fontSize={9} fill={COLOR.caption}>▲</text>
      ))}
    </svg>
  )
}

const chipStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '2px 10px', borderRadius: 999,
  border: `1px solid ${COLOR.border}`,
  fontSize: 12, lineHeight: '20px', color: COLOR.dim,
  whiteSpace: 'nowrap',
}

const cardStyle: CSSProperties = {
  border: `1px solid ${COLOR.border}`,
  borderRadius: 12,
  background: COLOR.tip,
  padding: '10px 14px',
}

/** The cockpit tab. */
export function CockpitTab(
  props: PropsRuntime<'conversation.view'> & PropsLocale<'kernel-cockpit'>,
): ReactNode {
  const { t, sessionId } = props
  const series = useSeries(sessionId)

  const iterations = series?.iterations ?? []
  const plans = series?.plans ?? []
  const latestPlan = plans.length > 0 ? plans[plans.length - 1] : undefined
  const best = series !== null && series.bestIndex !== null ? iterations[series.bestIndex] : undefined
  const hackCount = iterations.filter(p => p.rewardHack === true).length
  const pendingCount = iterations.filter(p => p.pending === true).length

  if (iterations.length === 0 && plans.length === 0) {
    return (
      <div style={{ padding: 24, maxWidth: 720, margin: '0 auto', fontFamily: 'system-ui', color: COLOR.dim }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: COLOR.text, marginBottom: 8 }}>{t('empty.title')}</div>
        <div style={{ fontSize: 13, lineHeight: '22px' }}>{t('empty.body')}</div>
        <div style={{ fontSize: 12, lineHeight: '20px', marginTop: 10, color: COLOR.caption }}>{t('loop.hint')}</div>
      </div>
    )
  }

  return (
    <div style={{
      padding: '16px 20px', maxWidth: 860, margin: '0 auto',
      display: 'flex', flexDirection: 'column', gap: 14,
      fontFamily: 'system-ui', color: COLOR.text,
    }}>
      {/* header chips */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {series?.control?.loop.armed === true
          ? (
              <span style={{ ...chipStyle, color: COLOR.curve, borderColor: COLOR.curve }}>
                ⟳ {t('loop.armed', {
                  round: series.control.loop.round,
                  done: series.control.loop.evalsDone,
                  budget: series.control.loop.budget,
                })}
              </span>
            )
          : series?.control?.loop.stopReason !== undefined
            ? <span style={chipStyle}>{t('loop.stopped', { reason: series.control.loop.stopReason })}</span>
            : null}
        {series?.control !== undefined && (series.control.supervisor.enabled || series.control.supervisor.configured)
          ? (
              <span style={{ ...chipStyle, ...(series.control.supervisor.enabled ? { color: COLOR.warn, borderColor: COLOR.warn } : {}) }}>
                {t(series.control.supervisor.enabled ? 'sup.on' : 'sup.off')}
              </span>
            )
          : null}
        <span style={chipStyle}>{t('chips.iterations', { count: iterations.length })}</span>
        {best?.latencyMs !== undefined
          ? <span style={{ ...chipStyle, color: COLOR.ok, borderColor: COLOR.ok }}>{t('chips.best', { latency: formatLatency(best.latencyMs) })}</span>
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

      {/* curve */}
      {iterations.length > 0
        ? (
            <div style={cardStyle}>
              <Chart series={series as WireSeries} bestLabel={t('axis.best')} />
            </div>
          )
        : null}

      {/* latest plan */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{t('plan.title')}</span>
          {latestPlan !== undefined
            ? (
                <span style={{ fontSize: 11, color: COLOR.caption }}>
                  {t('plan.count', { n: plans.length })}
                </span>
              )
            : null}
        </div>
        {latestPlan === undefined
          ? <div style={{ fontSize: 13, color: COLOR.caption }}>{t('plan.none')}</div>
          : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    ...chipStyle,
                    color: COLOR.curve, borderColor: COLOR.curve,
                    fontSize: 11, padding: '0 8px',
                  }}>{latestPlan.phase}</span>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{latestPlan.approach}</span>
                </div>
                {latestPlan.hypothesis !== undefined
                  ? <div style={{ fontSize: 12, color: COLOR.dim }}>{latestPlan.hypothesis}</div>
                  : null}
                {latestPlan.next !== undefined
                  ? <div style={{ fontSize: 12, color: COLOR.caption }}>{t('plan.next')} → {latestPlan.next}</div>
                  : null}
              </div>
            )}
      </div>

      {/* supervisor advice */}
      {series?.control?.supervisor.lastAdvice !== undefined
        ? (
            <div style={{ ...cardStyle, borderColor: COLOR.warn }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: COLOR.warn }}>{t('advice.title')}</div>
              <div style={{ fontSize: 12, lineHeight: '20px', color: COLOR.dim, whiteSpace: 'pre-wrap' }}>
                {series.control.supervisor.lastAdvice}
              </div>
            </div>
          )
        : null}

      {/* iteration table */}
      {iterations.length > 0
        ? (
            <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '8px 14px', fontSize: 13, fontWeight: 600, borderBottom: `1px solid ${COLOR.border}` }}>
                {t('table.title')}
              </div>
              <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                {[...iterations].reverse().map((p) => {
                  const status = statusOf(p)
                  const index = iterations.indexOf(p) + 1
                  const ratio = best?.latencyMs !== undefined && p.latencyMs !== undefined && p.latencyMs > 0
                    ? p.latencyMs / best.latencyMs
                    : undefined
                  return (
                    <div key={p.seq} style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '4px 14px', fontSize: 12, lineHeight: '20px',
                      borderBottom: `1px solid ${COLOR.border}`,
                    }}>
                      <span style={{ flex: 'none', width: 28, color: COLOR.caption }}>#{index}</span>
                      <span style={{ flex: 'none', width: 52, color: COLOR.caption }}>{p.evaluationId ?? '—'}</span>
                      <span style={{ flex: 'none', width: 86, color: COLOR.text, fontVariantNumeric: 'tabular-nums' }}>
                        {p.latencyMs !== undefined ? formatLatency(p.latencyMs) : '—'}
                      </span>
                      <span style={{ flex: 'none', width: 64, color: COLOR.dim, fontVariantNumeric: 'tabular-nums' }}>
                        {ratio !== undefined ? `×${ratio.toPrecision(3)}` : ''}
                      </span>
                      <span style={{ flex: 1 }} />
                      {p.finalized === true ? <span style={{ flex: 'none', color: COLOR.warn }}>★</span> : null}
                      <span style={{ flex: 'none', color: STATUS_COLOR[status], fontWeight: 500 }}>
                        {t(`status.${status}`)}
                      </span>
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

/** Client-half service requirements. */
export const inject = ['slots', 'locale']

/** Mount the locale namespace and the session tab. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'kernel-cockpit: dictionaries')
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register({
      name: 'conversation.view',
      id: 'kernel-cockpit',
      order: 30,
      label: '优化驾驶舱',
      locale: NS,
    }, CockpitTab))
}
