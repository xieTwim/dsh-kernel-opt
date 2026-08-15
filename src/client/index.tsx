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
import type { WireChange, WireControl, WireEnv, WireIteration, WireModels, WirePlan, WireRound, WireSeries } from '../wire.ts'
import { AXIS_GAP, CHART, chartModel, formatLatency } from '../chart.ts'
import {
  CONTROL_PATH, MODELS_PATH, PRESET_ID, SERIES_PATH,
  inWrapUpPhase, latestRunStart, samePath, unfinishedRun,
} from '../wire.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Kernel-opt panel copy. */
    'kernel-opt': LocaleKey
  }
}

const NS = 'kernel-opt'
const zh = {
  'tab.label': '评测',
  'empty.title': '暂无评测数据',
  'empty.body': 'Agent 每完成一次评测，这里会实时新增一个数据点并连成优化曲线，方案汇报与监督记录也在此展示；把 kernel 和评测方式告诉 Agent 即可开始。',
  'chips.iterations': '{count} 次迭代',
  'chips.best': '最佳 {latency}',
  'chips.profiles': '{count} 次 profile',
  'chips.hacks': '{count} 次作弊检出',
  'chips.pending': '评测中…',
  'env.title': '评测环境',
  'env.none': 'Agent 尚未汇报评测环境（数字所在的机器未知）。',
  'env.location': '运行位置',
  'env.device': '计算设备',
  'env.constraint': '约束',
  'env.versions': '工具链',
  'env.probe': '来源命令',
  'env.notes': '备注',
  'env.reported': '由 Agent 汇报',
  'plan.title': '当前方案',
  'plan.none': 'Agent 尚未汇报优化方案。',
  'plan.next': '下一步',
  'plan.count': '第 {n} 次汇报',
  'plan.history': '查看此前 {n} 次汇报',
  'plan.hide': '收起历史汇报',
  'table.title': '迭代记录',
  'status.pending': '评测中',
  'status.ok': '通过',
  'status.wrong': '未通过',
  'status.hack': '作弊检出',
  'status.error': '失败',
  'axis.best': '最佳',
  'axis.hintSpeedup': '纵轴：相对参考实现的加速比，越高越快。曲线用整个 run 汇总出的参考实现耗时换算，因此严格随延迟单调；每次评测自己报的加速比（参考实现被重新计时，带自己的抖动）保留在下方表格与各点悬停中。',
  'axis.hintLatency': '纵轴：延迟，方向已反转——越高越快。本次 run 尚无任何一次评测报出加速比，所以标注用的是延迟本身。',
  'loop.armed': '循环运行中 · 已迭代 {done}/{budget} 次',
  'loop.stopped': '循环已停止：{reason}',
  'loop.interrupted': '上一轮循环没有收尾记录：可能被手动停止，或被服务重启中断；重新启动循环会接着已有进度继续。',
  'pop.budget': '迭代次数',
  'pop.supervise': '外部监督',
  'pop.model': '监督模型',
  'pop.supNote': '已开启：循环每次驱动 Agent 继续之前，监督模型会先复审当前进展，建议自动转交 Agent；Agent 在预算未用完时宣布完成，也由监督裁定是否还有优化空间。',
  'pop.footer': '启动后 Agent 立即开始工作；每当一段工作结束而任务尚未完成，循环会自动驱动它继续，直到迭代次数达到上限。输入框中的草稿不会被自动发送；优化曲线与完整记录见「评测」页。',
  'sup.on': 'on',
  'sup.off': 'off',
  'sup.needCfg': '未配置监督模型：请在下拉框中选择，或在插件 config 中添加 supervisor: { provider, model }',
  'sup.model': '监督模型',
  'sup.default': '默认：{route}',
  'sup.pick': '选择监督模型…',
  'ctl.start': '启动循环',
  'ctl.stop': '停止循环',
  'ctl.budget': '迭代次数',
  'ctl.title': '运行控制',
  'advice.title': '监督记录',
  'advice.waiting': '监督已开启：循环每次驱动 Agent 继续之前，监督模型会先复审当前进展；结论与建议会自动转交 Agent 并记录在此。',
  'advice.round': '第 {n} 次复审',
  'advice.earlier': '（此前循环的 {n} 条复审记录未显示，完整历史保留在会话日志中）',
  'reason.finalized': '已完成收尾',
  'reason.converged': '监督确认无进一步优化空间，已收尾',
  'reason.budget': '迭代次数已用完，已请求收尾',
  'reason.no-progress': '连续无进展，已请求收尾',
  'reason.stopped': '手动停止',
  'row.plan': '生效方案',
  'row.review': '监督意见',
  'row.metrics': '指标',
  'row.error': '错误',
  'row.blocking': '阻断项',
  'row.advisory': '提示项',
  'row.notMeasured': '未测得',
  'row.subset': '工作负载子集',
  'row.evaluatorFailed': '评测器故障（不构成对 kernel 的判定）',
  'row.changes': '本次改动',
  'row.write': '整文件写入',
  'row.edit': '替换',
  'row.truncated': '（已截断）',
  'row.channelShell': 'Agent 测得',
  'row.channelReplay': '复测',
  'row.command': '来源命令',
  'row.unverifiedFinal': '最终数字未复测',
  'table.final': '最终',
  'row.wrapup': '收尾',
  'advice.wrapup': '收尾复审',
  'advice.audit': '终审',
  'advice.challenge': '早停质询',
  'advice.ok': '无异议',
  'advice.scopeRound': '审查循环纪律：预算使用是否合理、方案与实测是否一致、连续失败是否该换方向、数据来源是否可信。',
  'advice.scopeWrapup': '收尾前的最后一次复审：确认收尾时机与最终结果的数据来源。',
  'advice.scopeAudit': '收尾后的终审：核对最终表格与最终数字的来源（含插件复测）。',
  'advice.scopeChallenge': 'Agent 在预算未用完时宣布完成，监督裁定是否还有优化空间；给出未尝试方向即推翻收尾，run 继续。',
  'advice.progress': '复审时进度',
  'advice.covers': '覆盖迭代',
  'advice.coversNone': '本次复审后暂无新迭代',
  'advice.verdict': '结论',
  'advice.expandHint': '点击展开查看该次复审的范围与结论',
  'ctl.supDep': '监督只在循环的检查点运行，启动循环后才会触发。',
  'ctl.supOff': '未开启监督：Agent 自行判断何时收尾，循环仅保留预算与停滞兜底。',
  'ctl.supOn': '每次驱动前先复审；Agent 提前收尾时，由监督裁定是否还有优化空间。',
  'chips.wrapup': '收尾评测 {count} 次',
  'tip.iters': '循环内完成的优化迭代（不含收尾评测）',
  'tip.wrapup': '循环结束后的收尾评测（最终验证与复测），不计入迭代预算',
  'tip.replay': '插件对最终版本重放评测命令独立测得',
  'row.channelTool': '工具',
  'tip.tool': '由注册评测工具直接返回，非 Agent 转述',
  'tip.final': '收尾时选定的最终版本',
  'tip.best': '当前最优结果',
  'tip.ok': '正确性校验通过',
  'tip.speedup': '该次评测自己报出的加速比：评测器在同一次运行里重新给参考实现计时再相除，所以参考侧的抖动会叠进来——两行延迟几乎相同的记录出现末位差异是正常的。曲线不用逐行的这个比值，改用整个 run 汇总出的参考耗时。',
  'ctl.locked': '循环运行中：监督开关与监督模型已锁定。中途改动会让同一次 run 前后条件不一致，曲线也就不再是同一个实验；要调整请先停止循环，改完再启动——进度会接着走。',
  'ctl.lockedHint': '循环运行中不可更改：先停止循环',
  'sup.modelTip': '监督模型列表来自宿主已配置的模型服务，与对话使用的是同一份；在宿主设置里接入新的服务后会自动出现在这里。',
} satisfies Record<string, string>
/** Panel locale key union. */
type LocaleKey = keyof typeof zh
const en = {
  'tab.label': 'Evaluations',
  'empty.title': 'No evaluations yet',
  'empty.body': 'Each completed evaluation adds a live point to the optimization curve here, along with plan reports and supervision notes; hand the agent a kernel and a way to evaluate it to begin.',
  'chips.iterations': '{count} iterations',
  'chips.best': 'best {latency}',
  'chips.profiles': '{count} profiles',
  'chips.hacks': '{count} reward-hacks caught',
  'chips.pending': 'evaluating…',
  'env.title': 'Evaluation environment',
  'env.none': 'The agent has not reported where these evaluations run.',
  'env.location': 'Location',
  'env.device': 'Device',
  'env.constraint': 'Constraint',
  'env.versions': 'Toolchain',
  'env.probe': 'Read from',
  'env.notes': 'Notes',
  'env.reported': 'agent-reported',
  'plan.title': 'Current plan',
  'plan.none': 'The agent has not reported an optimization plan yet.',
  'plan.next': 'Next',
  'plan.count': 'report #{n}',
  'plan.history': 'show {n} earlier reports',
  'plan.hide': 'hide earlier reports',
  'table.title': 'Iterations',
  'status.pending': 'running',
  'status.ok': 'ok',
  'status.wrong': 'wrong',
  'status.hack': 'reward-hack',
  'status.error': 'failed',
  'axis.best': 'best',
  'axis.hintSpeedup': 'y axis: speedup over the reference kernel — higher is faster. The curve converts latency with one reference time pooled over the whole run, so it is monotone in latency; each evaluation\'s own reported speedup (measured against a freshly re-timed reference, with that jitter in it) stays in the table below and on each point.',
  'axis.hintLatency': 'y axis: latency, direction inverted — higher is faster. No evaluation in this run reported a speedup, so the labels are the latencies themselves.',
  'loop.armed': 'loop running · {done}/{budget} iterations',
  'loop.stopped': 'loop stopped: {reason}',
  'loop.interrupted': 'The last loop run has no closing record: it was stopped, or a host restart cut it off. Starting again resumes from the progress already on record.',
  'pop.budget': 'Max iterations',
  'pop.supervise': 'External supervision',
  'pop.model': 'Supervisor model',
  'pop.supNote': 'On: before the loop drives the agent onward, the supervisor reviews progress first and its advice is handed to the agent; when the agent declares itself finished with budget left, the supervisor rules on whether headroom remains.',
  'pop.footer': 'Starting puts the agent to work immediately; whenever it stops with the task unfinished, the loop drives it onward until the iteration limit is reached. Composer drafts are never auto-sent; the curve and full record live on the Evaluations tab.',
  'sup.on': 'on',
  'sup.off': 'off',
  'sup.needCfg': 'No supervisor model configured: pick one below, or add supervisor: { provider, model } to the plugin config',
  'sup.model': 'Supervisor model',
  'sup.default': 'default: {route}',
  'sup.pick': 'pick a supervisor model…',
  'ctl.start': 'Start loop',
  'ctl.stop': 'Stop loop',
  'ctl.budget': 'Max iterations',
  'ctl.title': 'Run controls',
  'advice.title': 'Supervision log',
  'advice.waiting': 'Supervision on: before each continuation the supervisor reviews progress first; its conclusions and advice are handed to the agent and recorded here.',
  'advice.round': 'review {n}',
  'advice.earlier': '({n} review records from earlier loop runs hidden; the full history stays in the session log)',
  'reason.finalized': 'finalized',
  'reason.converged': 'supervisor confirmed no further headroom; wrapped up',
  'reason.budget': 'iteration limit reached, wrap-up requested',
  'reason.no-progress': 'stalled, wrap-up requested',
  'reason.stopped': 'stopped manually',
  'row.plan': 'Plan in effect',
  'row.review': 'Supervisor advice',
  'row.metrics': 'Metrics',
  'row.error': 'Error',
  'row.blocking': 'Blocking',
  'row.advisory': 'Advisory',
  'row.notMeasured': 'Not measured',
  'row.subset': 'Workload subset',
  'row.evaluatorFailed': 'Evaluator failed (not a verdict on the kernel)',
  'row.changes': 'Changes this iteration',
  'row.write': 'full write',
  'row.edit': 'edit',
  'row.truncated': '(truncated)',
  'row.channelShell': 'agent-measured',
  'row.channelReplay': 'replayed',
  'row.command': 'Command',
  'row.unverifiedFinal': 'final number not replayed',
  'table.final': 'final',
  'row.wrapup': 'wrap-up',
  'advice.wrapup': 'wrap-up review',
  'advice.audit': 'final review',
  'advice.challenge': 'early-stop challenge',
  'advice.ok': 'no objection',
  'advice.scopeRound': 'Audits loop discipline: budget spend, plans vs measurements, family switches after repeated failure, and provenance.',
  'advice.scopeWrapup': 'The last review before wrap-up: whether it is time to finish, and where the final numbers came from.',
  'advice.scopeAudit': 'Post-finalize audit: the final table and the provenance of the final number (including the plugin replay).',
  'advice.scopeChallenge': 'The agent declared it finished with budget left; the supervisor ruled on remaining headroom — naming untried directions overrules the finalize and the run continues.',
  'advice.progress': 'Progress at review',
  'advice.covers': 'Covers iterations',
  'advice.coversNone': 'No new iterations since this review',
  'advice.verdict': 'Verdict',
  'advice.expandHint': 'Click a row to see what that review covered and concluded',
  'ctl.supDep': 'Supervision runs at the loop\'s checkpoints — it only fires once the loop is started.',
  'ctl.supOff': 'Off: the agent decides when to wrap up; the loop keeps only its budget and stall guards.',
  'ctl.supOn': 'Reviews before each continuation, and rules on remaining headroom when the agent wraps up early.',
  'chips.wrapup': '{count} wrap-up checks',
  'tip.iters': 'Optimization iterations completed in the loop (wrap-up checks excluded)',
  'tip.wrapup': 'Wrap-up evaluation after the loop ended (final verification / replay); not counted against the iteration budget',
  'tip.replay': 'Measured by the plugin replaying the evaluation command against the final version',
  'row.channelTool': 'tool',
  'tip.tool': 'Returned directly by a registered evaluator tool, not agent-relayed',
  'tip.final': 'The final version selected at wrap-up',
  'tip.best': 'Best result so far',
  'tip.ok': 'Correctness check passed',
  'tip.speedup': 'The speedup this evaluation reported for itself: the evaluator re-times the reference kernel inside the same run and divides, so reference-side jitter rides along — two rows with near-identical latency differing in the last digit is normal. The curve does not use this per-row ratio; it uses one reference time pooled over the run.',
  'ctl.locked': 'Loop running: the supervision switch and model are locked. Changing them mid-run would leave one run with two sets of conditions, and the curve would no longer be one experiment. Stop the loop to change them, then start again — progress carries over.',
  'ctl.lockedHint': 'Locked while the loop runs — stop it first',
  'sup.modelTip': 'The supervisor list comes from the models the host has configured — the same set the conversation uses. Add a service in host settings and it shows up here.',
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
  /** Halo painted behind in-plot chart text so the curve cannot cut through it. */
  halo: 'var(--dsw-alias-bg-layer-1, #fff)',
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

/** Optimization curve with per-point status, best line, profile ▲ and finalize ★. */
function Chart(props: {
  series: WireSeries
  bestLabel: string
  statusLabel: (status: ReturnType<typeof statusOf>) => string
  axisHint: (mode: 'speedup' | 'latency') => string
}): ReactNode {
  const { series, bestLabel, statusLabel, axisHint } = props
  const { iterations, profileSeqs, bestIndex } = series
  const model = useMemo(() => chartModel(iterations, iterations.length), [iterations])
  if (model === null) return null
  // The clamp label rides the first occurrence of the slowest measurement.
  const worstClampedIndex = iterations.findIndex(
    p => p.latencyMs === model.worst && model.clamped(p.latencyMs),
  )

  const best = bestIndex !== null ? iterations[bestIndex] : undefined
  // Axis position of the best line: sibling axis labels within AXIS_GAP of it
  // are suppressed so the gutter never stacks two numbers on one row.
  const bestY = best?.latencyMs !== undefined ? model.y(best.latencyMs) : Number.NEGATIVE_INFINITY
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
    <>
    <svg
      viewBox={`0 0 ${CHART.w} ${CHART.h}`}
      style={{ width: '100%', height: 'auto', display: 'block' }}
      role="img"
    >
      {/* frame + y domain bounds. Axis labels are suppressed when the best
          line's own axis label would collide with them — see below. */}
      <line x1={CHART.l} y1={CHART.t} x2={CHART.l} y2={CHART.h - CHART.b} stroke={COLOR.border} strokeWidth={1} />
      <line x1={CHART.l} y1={CHART.h - CHART.b} x2={CHART.w - CHART.r} y2={CHART.h - CHART.b} stroke={COLOR.border} strokeWidth={1} />
      {Math.abs(CHART.t - bestY) >= AXIS_GAP
        ? <text x={CHART.l - 6} y={CHART.t + 4} textAnchor="end" fontSize={12} fill={COLOR.dim}>{model.label(model.fast)}</text>
        : null}
      {Math.abs(CHART.h - CHART.b - bestY) >= AXIS_GAP
        ? <text x={CHART.l - 6} y={CHART.h - CHART.b} textAnchor="end" fontSize={12} fill={COLOR.dim}>{model.label(model.slow)}</text>
        : null}
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
            {f === 0.5 && Math.abs(gy - bestY) >= AXIS_GAP
              ? <text x={CHART.l - 6} y={gy + 4} textAnchor="end" fontSize={10} fill={COLOR.caption}>{model.label(value)}</text>
              : null}
          </g>
        )
      })}

      {/* Best dashed line, labeled in the AXIS GUTTER rather than inside the
          plot. In-plot labels have to dodge whatever the data happens to do —
          and the best line is exactly where points cluster, so every in-plot
          position collides for some run shape. Outside the plot area the
          collision is structurally impossible; only sibling AXIS labels can
          clash, and those yield above (the best value is the one worth
          reading). Colour ties it to the line; the chip above the chart
          carries the word. */}
      {best?.latencyMs !== undefined
        ? (
            <g>
              <title>{`${bestLabel} ${formatLatency(best.latencyMs)}`}</title>
              <line
                x1={CHART.l} x2={CHART.w - CHART.r}
                y1={bestY} y2={bestY}
                stroke={COLOR.ok} strokeWidth={1} strokeDasharray="4 4" opacity={0.6}
              />
              <text x={CHART.l - 6} y={bestY + 4} textAnchor="end" fontSize={12} fontWeight={500} fill={COLOR.ok}>
                {model.label(best.latencyMs, best.speedup)}
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
        // The ⚑ marks the finalize PICK only; the replay row re-measures that
        // same final version and carries its own 复测 badge in the table.
        const finalPick = p.finalized === true && p.channel !== 'replay'
        const marks = `${bestIndex === i ? ' ★' : ''}${finalPick ? ' ⚑' : ''}`
        // The tooltip carries the RAW numbers of that evaluation: its own
        // latency and, when the evaluator gave one, its own reported speedup
        // — not the pooled value the axis is drawn from.
        const reported = p.speedup !== undefined ? ` · ×${p.speedup.toPrecision(3)}` : ''
        const tip = `#${String(i + 1)} · ${p.latencyMs !== undefined ? formatLatency(p.latencyMs) : '—'}${reported} · ${statusLabel(status)}${marks}`
        if (p.latencyMs === undefined) {
          // Unmeasured (pending / failed) points sit just below the axis —
          // off the value scale, so they never read as a low latency.
          const cy = CHART.h - CHART.b + 8
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
            {/* ↓ marks a point below the focus domain, pinned to the bottom
                edge — on a better-is-up axis the outliers are the slow ones. */}
            {clamped
              ? <text x={cx} y={CHART.h - CHART.b - 10} textAnchor="middle" fontSize={9} fill={COLOR.caption}>↓</text>
              : null}
            {/* The one label that must stay inside the plot (the clamped
                slowest sits at its own point). A painted halo keeps it
                readable wherever the curve runs above it. */}
            {clamped && i === worstClampedIndex
              ? (
                  <text
                    x={cx < CHART.w / 2 ? cx + 7 : cx - 7}
                    y={CHART.h - CHART.b - 4}
                    textAnchor={cx < CHART.w / 2 ? 'start' : 'end'}
                    fontSize={11}
                    fill={COLOR.dim}
                    stroke={COLOR.halo}
                    strokeWidth={3}
                    paintOrder="stroke"
                  >
                    {model.label(model.worst)}↓
                  </text>
                )
              : null}
            {/* ★ where the best result was FIRST reached; ⚑ on the finalized
                pick. Better-is-up puts the best point AT the top of the
                domain, where a mark riding above it would leave the frame —
                so the pair flips under the point when the room is not there. */}
            {isBest
              ? <text x={cx} y={cy - 21 >= CHART.t ? cy - 8 : cy + 15} textAnchor="middle" fontSize={13} fill={COLOR.ok}>★</text>
              : null}
            {finalPick
              ? (
                  <text
                    x={cx}
                    y={cy - 21 >= CHART.t ? cy - (isBest ? 21 : 8) : cy + (isBest ? 28 : 15)}
                    textAnchor="middle"
                    fontSize={12}
                    fill={COLOR.curve}
                  >
                    ⚑
                  </text>
                )
              : null}
          </g>
        )
      })}

      {/* profiler marks */}
      {profileXs.map((x, i) => (
        <text key={`p${String(i)}`} x={x} y={CHART.h - CHART.b + 13} textAnchor="middle" fontSize={10} fill={COLOR.caption}>▲</text>
      ))}
    </svg>
    {/* What the axis is measuring. Needed in both modes for opposite reasons:
        a × axis has to say the number is not the evaluator's per-row ratio,
        and a latency axis has to say its numbers now DECREASE upward. */}
    <div style={{ padding: '4px 8px 2px', fontSize: 11, lineHeight: '16px', color: COLOR.caption }}>
      {axisHint(model.referenceMs !== undefined ? 'speedup' : 'latency')}
    </div>
    </>
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
  padding: '14px 16px',
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

/** Which kind of review a round carries, for its label and scope note. */
function reviewKind(round: WireRound): 'audit' | 'challenge' | 'wrapup' | 'round' {
  if (round.audit === true) return 'audit'
  if (round.challenge === true) return 'challenge'
  if (round.wrapUp === true) return 'wrapup'
  return 'round'
}

/**
 * Expanded detail of one supervision record. A verdict alone ("OK") tells the
 * reader nothing, so the row opens into what that review actually was: which
 * question the supervisor was answering, the iterations it covered (the log
 * span since the previous review), the progress at the time, and the verdict
 * in full.
 */
function ReviewDetail(props: {
  round: WireRound
  rounds: readonly WireRound[]
  iterations: readonly WireIteration[]
  t: PropsLocale<'kernel-opt'>['t']
}): ReactNode {
  const { round, rounds, iterations, t } = props
  const kind = reviewKind(round)
  const scope = { audit: 'advice.scopeAudit', challenge: 'advice.scopeChallenge', wrapup: 'advice.scopeWrapup', round: 'advice.scopeRound' } as const
  // The review saw everything logged since the previous review-carrying round.
  const priorSeq = rounds
    .filter(r => r.review !== undefined && r.seq < round.seq)
    .reduce((seq, r) => Math.max(seq, r.seq), -1)
  const covered = iterations
    .map((p, i) => ({ p, n: i + 1 }))
    .filter(({ p }) => p.seq > priorSeq && p.seq < round.seq)
  const first = covered[0]?.n
  const last = covered[covered.length - 1]?.n
  return (
    <div style={{
      padding: '6px 4px 10px 66px',
      display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: COLOR.dim,
    }}>
      <div style={{ color: COLOR.caption }}>{t(scope[kind])}</div>
      <div>
        {t('advice.covers')}：
        {first === undefined
          ? t('advice.coversNone')
          : first === last ? `#${String(first)}` : `#${String(first)} – #${String(last)}`}
        {round.evalsUsed !== undefined && round.budget !== undefined
          ? ` · ${t('advice.progress')} ${String(round.evalsUsed)}/${String(round.budget)}`
          : ''}
      </div>
      <div style={{ color: COLOR.text, whiteSpace: 'pre-wrap' }}>
        {t('advice.verdict')}：
        {round.review === 'ok'
          ? `✓ ${t('advice.ok')}${round.reviewNote !== undefined ? ` — ${round.reviewNote}` : ''}`
          : round.review}
      </div>
    </div>
  )
}

/**
 * Evaluation environment card: the machine the numbers were taken on. Purely
 * agent-reported (see `WireEnv`) — the panel's host is not necessarily the
 * benchmark's host, and a user instruction can rule a local device out — so
 * it is labelled as reported and shows the probe command when one was given.
 */
function EnvCard(props: { env: WireEnv | undefined; t: PropsLocale<'kernel-opt'>['t'] }): ReactNode {
  const { env, t } = props
  const row = (label: string, value: string): ReactNode => (
    <div style={{ display: 'flex', gap: 10, fontSize: 13, lineHeight: '21px' }}>
      <span style={{ flex: 'none', minWidth: 62, color: COLOR.caption }}>{label}</span>
      <span style={{ color: COLOR.text, wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{t('env.title')}</span>
        {env !== undefined
          ? <span style={{ fontSize: 12, color: COLOR.caption }}>{t('env.reported')}</span>
          : null}
      </div>
      {env === undefined
        ? <div style={{ fontSize: 14, color: COLOR.caption }}>{t('env.none')}</div>
        : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {row(t('env.device'), env.device)}
              {row(t('env.location'), env.location)}
              {env.constraint !== undefined ? row(t('env.constraint'), env.constraint) : null}
              {env.versions !== undefined
                ? row(t('env.versions'), Object.entries(env.versions).map(([k, v]) => `${k} ${v}`).join(' · '))
                : null}
              {env.notes !== undefined ? row(t('env.notes'), env.notes) : null}
              {env.probe !== undefined
                ? (
                    <div style={{ display: 'flex', gap: 10, fontSize: 12, lineHeight: '20px', marginTop: 2 }}>
                      <span style={{ flex: 'none', minWidth: 62, color: COLOR.caption }}>{t('env.probe')}</span>
                      <code style={{ color: COLOR.caption, wordBreak: 'break-all' }}>{env.probe}</code>
                    </div>
                  )
                : null}
            </div>
          )}
    </div>
  )
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
function SuperviseToggle(props: { control: WireControl; t: T; locked?: boolean; onToggle: () => void }): ReactNode {
  const { control, t, locked = false, onToggle } = props
  const enabled = control.supervisor.enabled
  const configured = control.supervisor.configured
  const disabled = locked || !configured
  return (
    <button
      type="button"
      style={{
        ...buttonStyle(enabled ? COLOR.curve : undefined),
        ...(disabled ? disabledBtnStyle : {}),
      }}
      disabled={disabled}
      title={locked ? t('ctl.lockedHint') : configured ? undefined : t('sup.needCfg')}
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
  /** A running loop freezes its own conditions — see `ctl.locked`. */
  locked?: boolean
  onUse: (provider: string, model: string) => void
  style?: CSSProperties
}): ReactNode {
  const { control, models, t, locked = false, onUse } = props
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
      disabled={locked}
      title={locked ? t('ctl.lockedHint') : t('sup.modelTip')}
      style={{ ...selectStyle, ...props.style, ...(locked ? disabledBtnStyle : {}) }}
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
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null)
  const [expandedSeq, setExpandedSeq] = useState<number | null>(null)
  const [expandedReview, setExpandedReview] = useState<number | null>(null)
  const [planHistory, setPlanHistory] = useState(false)

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
  const envs = series?.envs ?? []
  const env = envs.length > 0 ? envs[envs.length - 1] : undefined
  const best = series !== null && series.bestIndex !== null ? iterations[series.bestIndex] : undefined
  const hackCount = iterations.filter(p => p.rewardHack === true).length
  const pendingCount = iterations.filter(p => p.pending === true).length
  // The supervision card scopes to the CURRENT loop run: each re-arm resets
  // the round counter, so without segmentation every historical run's
  // "round 1" would pile up in the card. Earlier runs collapse to a count.
  // The budget field mirrors the run's armed budget once one exists (kept in
  // sync with the composer popover through the shared control state); the
  // config default only seeds a session that has never armed.
  const budgetValue = budgetDraft
    ?? String(control !== undefined && control.loop.budget > 0 ? control.loop.budget : control?.loop.defaultBudget ?? 20)
  const runStart = latestRunStart(rounds)
  const reviewedRounds = rounds.slice(runStart).filter(r => r.review !== undefined)
  const earlierReviews = rounds.slice(0, runStart).filter(r => r.review !== undefined).length
  // Wrap-up-phase evaluations (finalize verification + plugin replay) are not
  // budgeted optimization work: the chips split them out so "N 次迭代" stays
  // aligned with the armed budget, and their table rows carry a 收尾 badge.
  const wrapUpChecks = iterations.filter(p => p.channel === 'replay' || inWrapUpPhase(rounds, p.seq)).length
  const reasonLabel = (reason: string): string =>
    reason === 'finalized' || reason === 'converged' || reason === 'budget'
    || reason === 'no-progress' || reason === 'stopped'
      ? t(`reason.${reason}`)
      : reason

  const empty = iterations.length === 0 && plans.length === 0

  return (
    <div style={{
      padding: '20px 20px 28px', maxWidth: 860, margin: '0 auto',
      display: 'flex', flexDirection: 'column', gap: 20,
      fontFamily: 'system-ui', color: COLOR.text,
    }}>
      {/* Run controls live in a card like everything else: naked rows above a
          column of cards gave the page two visual languages, and the reader
          had no block boundary between "what I can change" and "what the run
          produced". The result chips are data, so they head the chart card
          below rather than trailing the controls here. */}
      <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 14, fontWeight: 600 }}>{t('ctl.title')}</div>
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
                    value={budgetValue}
                    title={t('ctl.budget')}
                    style={inputStyle}
                    onChange={(event) => { setBudgetDraft(event.target.value) }}
                  />
                  <button
                    type="button"
                    style={primaryBtnStyle}
                    onClick={() => {
                      const budget = Number(budgetValue)
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
              <>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <span style={rowLabelStyle}>{t('pop.supervise')}</span>
                  <SuperviseToggle
                    control={control}
                    t={t}
                    locked={control.loop.armed}
                    onToggle={() => { void post(control.supervisor.enabled ? 'supervise-off' : 'supervise-on') }}
                  />
                  <span style={{ ...rowLabelStyle, marginLeft: 6 }}>{t('pop.model')}</span>
                  <SupervisorSelect
                    control={control}
                    models={models}
                    t={t}
                    locked={control.loop.armed}
                    onUse={(provider, model) => { void post('supervise-use', { provider, model }) }}
                  />
                </div>
                {/* Supervision is a setting OF the loop, not a peer feature: it
                    only ever runs at the loop's checkpoints. The caption states
                    which half of that relationship currently applies. */}
                <div style={{ fontSize: 12, lineHeight: '18px', color: COLOR.caption }}>
                  {!control.supervisor.enabled
                    ? t('ctl.supOff')
                    : control.loop.armed ? t('ctl.supOn') : t('ctl.supDep')}
                </div>
                {/* A run's conditions are frozen for the length of the run: the
                    panel is a record of ONE experiment, and a supervision
                    switch flipped at round 7 makes rounds 1-6 and 8-20 two
                    different runs sharing a curve. */}
                {control.loop.armed
                  ? (
                      <div style={{ fontSize: 12, lineHeight: '18px', color: COLOR.caption }}>
                        {t('ctl.locked')}
                      </div>
                    )
                  : null}
                {/* An armed run that lost its state (host restart) leaves the
                    log's last word as a continuation and no finalize: say so,
                    instead of handing back an unfinished curve in silence. */}
                {control.loop.armed === false && control.loop.stopReason === undefined
                  && unfinishedRun(rounds, iterations)
                  ? (
                      <div style={{ fontSize: 12, lineHeight: '18px', color: COLOR.warn }}>
                        {t('loop.interrupted')}
                      </div>
                    )
                  : null}
              </>
            )
          : null}
      </div>

      {/* empty-state guidance: the controls above stay usable before the
          first evaluation; only the data area explains itself. */}
      {empty
        ? (
            <div style={{ ...cardStyle, padding: '18px 16px', color: COLOR.dim }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: COLOR.text, marginBottom: 8 }}>{t('empty.title')}</div>
              <div style={{ fontSize: 14, lineHeight: '23px' }}>{t('empty.body')}</div>
            </div>
          )
        : null}

      {/* curve, headed by the run's result chips — they summarise what the
          chart plots, so they belong to its block, not to the controls. */}
      {iterations.length > 0
        ? (
            <div style={{ ...cardStyle, padding: '14px 10px 8px' }}>
              <div style={{
                display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
                padding: '0 6px', marginBottom: 10,
              }}>
                <span style={chipStyle} title={t('tip.iters')}>
                  {t('chips.iterations', { count: iterations.length - wrapUpChecks })}
                </span>
                {wrapUpChecks > 0
                  ? <span style={{ ...chipStyle, color: COLOR.caption }} title={t('tip.wrapup')}>{t('chips.wrapup', { count: wrapUpChecks })}</span>
                  : null}
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
              <Chart
                series={series as WireSeries}
                bestLabel={t('axis.best')}
                statusLabel={status => t(`status.${status}`)}
                axisHint={mode => t(mode === 'speedup' ? 'axis.hintSpeedup' : 'axis.hintLatency')}
              />
            </div>
          )
        : null}

      {/* the machine behind the numbers (hidden while the panel is empty) */}
      {empty ? null : <EnvCard env={env} t={t} />}

      {/* latest plan (hidden while empty — the guidance block covers it) */}
      {empty
        ? null
        : (
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{t('plan.title')}</span>
          {latestPlan !== undefined
            ? (
                <span style={{ fontSize: 12, color: COLOR.caption }}>
                  {t('plan.count', { n: plans.length })}
                </span>
              )
            : null}
          {/* Earlier reports stay one click away: the approach history is how
              a reader reconstructs WHY the run went where it went. */}
          {plans.length > 1
            ? (
                <span
                  style={{ fontSize: 12, color: COLOR.curve, cursor: 'pointer' }}
                  onClick={() => { setPlanHistory(value => !value) }}
                >
                  {planHistory ? t('plan.hide') : t('plan.history', { n: plans.length - 1 })}
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
        {planHistory && plans.length > 1
          ? (
              <div style={{
                marginTop: 10, paddingTop: 8, borderTop: `1px solid ${COLOR.border}`,
                display: 'flex', flexDirection: 'column', gap: 8,
              }}>
                {plans.slice(0, -1).reverse().map((plan, i) => (
                  <div key={plan.seq} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 12, color: COLOR.caption, minWidth: 62 }}>
                        {t('plan.count', { n: plans.length - 1 - i })}
                      </span>
                      <span style={{
                        ...chipStyle, color: COLOR.caption,
                        fontSize: 11, padding: '0 7px', lineHeight: '18px',
                      }}>{plan.phase}</span>
                      <span style={{ fontSize: 13, color: COLOR.dim }}>{plan.approach}</span>
                    </div>
                    {plan.hypothesis !== undefined
                      ? <div style={{ fontSize: 12, color: COLOR.caption, paddingLeft: 70 }}>{plan.hypothesis}</div>
                      : null}
                  </div>
                ))}
              </div>
            )
          : null}
      </div>
          )}

      {/* supervision log — parsed back from the continuation messages, so it
          survives restarts and replays with the rest of the projection. */}
      {reviewedRounds.length > 0 || earlierReviews > 0 || control?.supervisor.enabled === true
        ? (
            <div style={cardStyle}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>{t('advice.title')}</div>
              {reviewedRounds.length === 0
                ? <div style={{ fontSize: 13, color: COLOR.caption }}>{t('advice.waiting')}</div>
                : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 260, overflowY: 'auto' }}>
                      {[...reviewedRounds].reverse().map((round, revIndex) => {
                        const kind = reviewKind(round)
                        const open = expandedReview === round.seq
                        // Numbered by REVIEW ordinal, not by loop round: the
                        // first drive of a fresh session has nothing to review,
                        // so round numbers would start the list at "2".
                        const ordinal = reviewedRounds.length - revIndex
                        return (
                          <div key={round.seq}>
                            <div
                              style={{ display: 'flex', gap: 8, fontSize: 13, lineHeight: '24px', cursor: 'pointer' }}
                              title={t('advice.expandHint')}
                              onClick={() => { setExpandedReview(open ? null : round.seq) }}
                            >
                              <span style={{ flex: 'none', width: 12, color: COLOR.caption }}>{open ? '▾' : '▸'}</span>
                              <span style={{ flex: 'none', minWidth: 56, color: COLOR.caption }}>
                                {kind === 'audit'
                                  ? t('advice.audit')
                                  : kind === 'challenge'
                                    ? t('advice.challenge')
                                    : kind === 'wrapup' ? t('advice.wrapup') : t('advice.round', { n: ordinal })}
                              </span>
                              {round.review === 'ok'
                                ? (
                                    <>
                                      <span style={{ flex: 'none', color: COLOR.ok }}>✓ {t('advice.ok')}</span>
                                      {round.reviewNote !== undefined
                                        ? (
                                            <span style={{
                                              color: COLOR.caption, whiteSpace: 'nowrap',
                                              overflow: 'hidden', textOverflow: 'ellipsis',
                                            }}>
                                              {round.reviewNote}
                                            </span>
                                          )
                                        : null}
                                    </>
                                  )
                                : (
                                    <span style={{
                                      color: COLOR.dim, whiteSpace: 'nowrap',
                                      overflow: 'hidden', textOverflow: 'ellipsis',
                                    }}>
                                      {round.review}
                                    </span>
                                  )}
                            </div>
                            {open
                              ? <ReviewDetail round={round} rounds={rounds} iterations={iterations} t={t} />
                              : null}
                          </div>
                        )
                      })}
                    </div>
                  )}
              {earlierReviews > 0
                ? (
                    <div style={{ fontSize: 12, color: COLOR.caption, marginTop: 6 }}>
                      {t('advice.earlier', { n: earlierReviews })}
                    </div>
                  )
                : null}
            </div>
          )
        : null}

      {/* iteration table */}
      {iterations.length > 0
        ? (
            <div style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '11px 16px', fontSize: 14, fontWeight: 600, borderBottom: `1px solid ${COLOR.border}` }}>
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
                          padding: '6px 16px', fontSize: 13, lineHeight: '22px',
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
                        {/* Speedup vs the reference kernel, exactly as the
                            evaluator reported it — reference re-timed per
                            evaluation, so it does not order the same way the
                            latency column does. The tooltip says why; the
                            curve sidesteps it with a pooled reference. */}
                        <span
                          title={p.speedup !== undefined ? t('tip.speedup') : undefined}
                          style={{
                            flex: 'none', width: 70, fontVariantNumeric: 'tabular-nums', fontWeight: isBest ? 600 : 400,
                            color: isBest ? COLOR.ok : COLOR.dim,
                          }}
                        >
                          {p.speedup !== undefined ? `×${p.speedup.toPrecision(3)}` : ''}
                        </span>
                        <span style={{ flex: 1 }} />
                        {inWrapUpPhase(rounds, p.seq)
                          ? (
                              <span
                                title={t('tip.wrapup')}
                                style={{
                                  flex: 'none', fontSize: 11, lineHeight: '16px', padding: '0 6px',
                                  borderRadius: 4, border: `1px solid ${COLOR.border}`, color: COLOR.caption,
                                }}
                              >
                                {t('row.wrapup')}
                              </span>
                            )
                          : null}
                        {/* Self-reported (shell) is the default working mode and stays
                            unbadged — the table legend states it once; badges mark the
                            deviations: the plugin's replay and registered-tool results. */}
                        {p.channel !== 'shell'
                          ? (
                              <span
                                title={t(p.channel === 'replay' ? 'tip.replay' : 'tip.tool')}
                                style={{
                                  flex: 'none', fontSize: 11, lineHeight: '16px', padding: '0 6px',
                                  borderRadius: 4, border: `1px solid ${COLOR.border}`,
                                  color: p.channel === 'replay' ? COLOR.ok : COLOR.caption,
                                }}
                              >
                                {t(p.channel === 'replay' ? 'row.channelReplay' : 'row.channelTool')}
                              </span>
                            )
                          : null}
                        {isBest ? <span style={{ flex: 'none', color: COLOR.ok }} title={t('tip.best')}>★</span> : null}
                        {p.finalized === true && p.channel !== 'replay'
                          ? <span style={{ flex: 'none', color: COLOR.curve }} title={t('tip.final')}>⚑ {t('table.final')}</span>
                          : null}
                        <span
                          style={{ flex: 'none', color: STATUS_COLOR[status], fontWeight: 500 }}
                          title={status === 'ok' ? t('tip.ok') : undefined}
                        >
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
  const budgetValue = budgetDraft ?? String(control.loop.budget > 0 ? control.loop.budget : control.loop.defaultBudget)
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
                {/* Both states get a note: supervision is what gives the loop
                    authority over an early finalize, so its absence is a
                    meaningful choice the user should see stated. */}
                <div style={{ fontSize: 12, lineHeight: '18px', color: COLOR.caption }}>
                  {control.supervisor.enabled ? t('pop.supNote') : t('ctl.supOff')}
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
                  style={{ ...primaryBtnStyle, marginTop: 2 }}
                  onClick={() => { void arm() }}
                >
                  ⟳ {t('ctl.start')}
                </button>
                <div style={{ fontSize: 12, lineHeight: '18px', color: COLOR.caption }}>
                  {t('pop.footer')}
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
