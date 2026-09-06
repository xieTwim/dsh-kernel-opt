/**
 * dsh-kernel-opt — browser half.
 *
 * 「评测」 session tab (`conversation.view` slot): polls the Node half's
 * series route and renders the live optimization picture — latency curve over
 * evaluations (log scale when the journey is wide), correctness/reward-hack
 * status per point, the wrap-up pick, the model's latest
 * `kernel_plan`, and an iteration table. Pure projection of the session log;
 * a replayed session renders identically.
 * @module
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { CSSProperties, ReactNode } from 'react'
// Context merges: slots/locale services reach this program through their
// client entries.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleId } from '@deepseek-ai/dsh-client-locale/client'
// SlotMap merge: conversation.view is declared by the conversation contract.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  RunHeadline, RunLanguage, WireChange, WireControl, WireEnv, WireIteration, WireModelInfo,
  WireModels, WirePlan, WireRound, WireSeries,
} from '../wire.ts'
import { CHART, chartModel, formatLatency, referenceLatency } from '../chart.ts'
import {
  CONTROL_PATH, MODELS_PATH, PRESET_ID, SERIES_PATH,
  evaluationPhases, latestRunStart, referenceDrift, runHeadline, samePath, unfinishedRun,
} from '../wire.ts'
import { PANEL_CSS } from './styles.ts'
import { placePopover } from './popover.ts'
import type { PopoverPlacement } from './popover.ts'

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
  'empty.body': '智能体每完成一次评测，这里就会新增一个数据点并更新优化曲线；方案汇报和监督记录也会显示在这里。把算子实现和评测方式告诉智能体即可开始。',
  'uncollected.note': '⚠ 有 {count} 次评测经由本面板不收录的通道返回，因此没有进入下方记录，也不计入评测预算。曲线为空或数据点偏少，并不代表智能体没有进行评测。',
  'chips.iterations': '优化评测 {count} 次',
  'chips.overBudget': '预算外评测 {count} 次',
  'chips.best': '最佳 {latency}',
  'chips.profiles': '性能分析 {count} 次',
  'chips.hacks': '{count} 次作弊检出',
  'chips.pending': '评测中…',
  'env.title': '评测环境',
  'env.none': '智能体尚未汇报评测环境，因此无法确认这些数据来自哪台机器。',
  'env.location': '运行位置',
  'env.device': '计算设备',
  'env.constraint': '约束',
  'env.versions': '工具链',
  'env.probe': '来源命令',
  'env.notes': '备注',
  'env.reported': '由智能体汇报',
  'plan.title': '当前方案',
  'plan.none': '智能体尚未汇报优化方案。',
  'plan.next': '下一步',
  'plan.count': '第 {n} 次汇报',
  'plan.history': '查看此前 {n} 次汇报',
  'plan.hide': '收起历史汇报',
  'table.title': '评测记录',
  'status.pending': '评测中',
  'status.ok': '通过',
  'status.wrong': '未通过',
  'status.hack': '作弊检出',
  'status.error': '失败',
  'axis.best': '最佳',
  'axis.hintSpeedup': '纵轴显示相对参考实现的加速比，越高越快。曲线统一使用本轮汇总出的参考耗时；单次评测自报的加速比仍显示在表格和悬浮详情中。',
  'axis.drift': '⚠ 本轮评测使用了不同的参考耗时：{min}–{max}，相差 {pct}%（共 {count} 次）。曲线已按统一分母重算，因此仍可比较；表格中的逐次加速比不可直接横向比较。常见原因是评测器每次重测参考实现，或运行期间更换了机器或频率。',
  'axis.hintLatency': '本轮评测没有提供参考耗时或加速比，因此纵轴只显示延迟，并反转方向以保持“越高越快”。请让评测器在每条记录中提供 `speedup` 或 `ref_runtime_ms`。',
  'loop.armed': '循环运行中 · 已完成 {done}/{budget} 次优化评测',
  'loop.overBudget': '另有 {count} 次预算外评测',
  'loop.stopped': '循环已停止：{reason}',
  'loop.interrupted': '上一轮循环没有收尾记录：可能被手动停止，或被服务重启中断；重新启动循环会接着已有进度继续。',
  'pop.budget': '优化评测上限',
  'pop.language': '本轮输出语言',
  'pop.supervise': '外部监督',
  'pop.model': '监督模型',
  'pop.effort': '思考强度',
  'pop.supNote': '已开启：每次开始下一轮优化前，监督模型都会先复审当前进展，并将复审结果交给智能体。如果智能体在评测预算尚未用完时准备收尾，监督模型还会判断是否仍有优化空间。',
  'pop.footer': '启动后，智能体会立即开始工作。只要任务尚未完成，循环就会在每轮工作结束后自动继续，直到用完优化评测预算。输入框中的草稿不会被自动发送；优化曲线和完整记录位于「评测」页。',
  'sup.on': '开启',
  'sup.off': '关闭',
  'sup.needCfg': '未配置监督模型：请在下拉框中选择，或在插件 config 中添加 supervisor: { provider, model }',
  'sup.model': '监督模型',
  'sup.default': '默认：{route}',
  'sup.pick': '选择监督模型…',
  'sup.effortDefault': '使用模型默认值',
  'sup.effortDefaultNamed': '模型默认值：{effort}',
  'sup.effortUnavailable': '该模型未公布可选的思考强度',
  'sup.effortTip': '选项来自模型适配器；不同模型支持的档位可能不同。',
  'ctl.start': '启动循环',
  'ctl.stop': '停止循环',
  'ctl.budget': '优化评测上限',
  'advice.title': '监督记录',
  'advice.waiting': '监督已开启。每次开始下一轮优化前，监督模型都会复审当前进展，并将结果交给智能体；复审记录会显示在这里。',
  'advice.round': '第 {n} 次复审',
  'advice.earlier': '（此前循环的 {n} 条复审记录未显示，完整历史保留在会话日志中）',
  'reason.finalized': '已完成收尾',
  'reason.converged': '监督确认无进一步优化空间，已收尾',
  'reason.budget': '优化评测预算已用完，已请求收尾',
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
  'row.evaluatorFailed': '评测器故障（无法据此判断算子实现）',
  'row.changes': '本次评测前的改动',
  'row.write': '整文件写入',
  'row.edit': '替换',
  'row.truncated': '（已截断）',
  'row.channelShell': '智能体评测',
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
  'advice.scopeChallenge': '智能体在评测预算尚未用完时准备收尾；监督模型会判断是否仍有优化空间。若指出值得尝试的新方向，本次收尾会被取消，优化循环继续。',
  'advice.progress': '复审时进度',
  'advice.covers': '覆盖评测',
  'advice.coversNone': '本次复审后暂无新评测',
  'advice.verdict': '结论',
  'advice.expandHint': '点击展开查看该次复审的范围与结论',
  'ctl.supDep': '监督只在循环的检查点运行，启动循环后才会触发。',
  'ctl.supOff': '未开启监督：由智能体判断何时收尾；循环仍会在用完评测预算或连续无进展时触发收尾。',
  'ctl.supOn': '每轮继续前先由监督模型复审；智能体提前收尾时，监督模型还会判断是否仍有优化空间。',
  'chips.wrapup': '收尾验证 {count} 次',
  'tip.iters': '循环内完成的优化评测，不含预算外评测和收尾验证',
  'tip.overBudget': '同一轮次在预算检查前额外完成的评测，不计入优化评测上限',
  'tip.wrapup': '循环结束后的最终验证或插件复测，不计入优化评测预算',
  'tip.replay': '插件对最终版本重放评测命令独立测得',
  'row.channelTool': '工具',
  'tip.tool': '由注册评测工具直接返回，并非智能体转述',
  'tip.final': '收尾时选定的最终版本',
  'tip.best': '当前最优结果',
  'tip.ok': '正确性校验通过',
  'tip.speedup': '本次评测自报的加速比。它可能包含参考实现重测产生的波动；曲线改用本轮汇总的统一参考耗时。',
  'ctl.locked': '循环运行期间，监督开关、监督模型和思考强度不可更改。若要调整，请先停止循环；重新启动后会沿用已有评测进度。',
  'ctl.lockedHint': '循环运行中不可更改：先停止循环',
  'sup.modelTip': '监督模型列表来自宿主已配置的模型服务，与对话使用的是同一份；在宿主设置里接入新的服务后会自动出现在这里。',
  'row.overBudget': '预算外',
  'lang.auto': '跟随界面（{language}）',
  'lang.zh': '中文',
  'lang.en': 'English',
  'lang.tip': '启动时根据界面语言确定；本轮运行期间保持不变。',
  'axis.short': '越高越快',
  'axis.why': '指标说明',
  'row.best': '最佳',
  'hero.running': '当前最佳',
  'hero.final': '提交候选',
  'hero.from': '{reference} → {latency}',
  'hero.faster': '最高测得 {label}，来自 {artifact}——本轮没有选它收尾',
  'hero.rejected': '{count} 个候选未通过验证',
  'hero.unclaimable': '⚠ 本轮收尾选定的是 {artifact}，但那次评测没有通过验证——上面报的是本轮验证过的最佳结果，不是收尾选定的那个',
  'hero.passed': '正确性通过',
  'hero.noHack': '未检出作弊',
  'hero.pending': '评测进行中',
  'rail.running': '第 {round} 轮 · 已完成 {done}/{budget} 次优化评测',
  'rail.settings': '运行设置',
  'rail.collapse': '收起',
  'chart.candidate': '通过验证',
  'chart.rejectedDot': '未通过验证',
  'chart.best': '新最佳',
  'chart.final': '收尾选定',
  'chart.bestFinal': '最佳 · 收尾选定',
  'audit.title': '查看完整记录',
  'audit.hint': '评测环境、方案汇报历史、监督记录、逐次评测明细',
  'workspace.title': '算子优化',
  'workspace.subtitle': 'DeepSeek Harness',
  'workspace.ready': '等待评测',
  'workspace.complete': '已选定结果',
  'workspace.paused': '等待继续',
  'workspace.live': '优化进行中',
  'chart.title': '优化轨迹',
  'chart.subtitle': '每次尝试，都有记录',
  'chart.axis': '评测序号',
  'chart.select': '选择评测',
  'chart.details': '查看详情',
  'chart.latency': '耗时',
  'chart.speedup': '加速比',
  'chart.reference': '参考实现',
  'chart.optimized': '当前结果',
  'chart.help': '悬停或选择数据点，查看本次评测',
  'chart.log': '对数坐标',
  'chart.none': '等待首个耗时结果',
  'chart.driftShort': '参考耗时存在波动，曲线已统一换算。',
  'hero.ratio': '相对参考实现的加速比',
  'hero.latency': '本次评测耗时',
  'stats.evals': '优化评测',
  'stats.profiles': '性能分析',
  'stats.reviews': '监督复审',
  'recent.title': '最近评测',
  'recent.all': '全部记录',
  'plan.details': '方案详情',
  'workspace.focus': '专注展示',
  'workspace.exitFocus': '退出展示',
  'phase.done': '完成',
  'phase.baseline': '基线',
  'phase.optimize': '优化',
  'phase.explore': '探索',
  'phase.tune': '调优',
  'phase.verify': '验证',
  'phase.finalize': '收尾',
} satisfies Record<string, string>
/** Panel locale key union. */
type LocaleKey = keyof typeof zh
const en = {
  'tab.label': 'Evaluations',
  'empty.title': 'No evaluations yet',
  'empty.body': 'Each completed evaluation adds a live point to the optimization curve here, along with plan reports and supervision notes; hand the agent a kernel and a way to evaluate it to begin.',
  'uncollected.note': '⚠ {count} evaluation(s) came back through a channel this panel does not collect, so they are absent from the record below and do not count against the evaluation budget. An empty or short curve does not mean the agent measured nothing.',
  'chips.iterations': '{count} optimization evaluations',
  'chips.overBudget': '{count} over-budget evaluations',
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
  'table.title': 'Evaluation record',
  'status.pending': 'running',
  'status.ok': 'ok',
  'status.wrong': 'wrong',
  'status.hack': 'reward-hack',
  'status.error': 'failed',
  'axis.best': 'best',
  'axis.hintSpeedup': 'y axis: speedup over the reference kernel — higher is faster. The curve converts latency with one reference time pooled over the whole run, so it is monotone in latency; each evaluation\'s own reported speedup stays in the table below and on each point (an evaluator that re-times its reference per run puts that jitter in the reported number).',
  'axis.drift': '⚠ The denominator is not one number: across {count} evaluations the implied reference latency ranges {min} – {max} ({pct}% apart). The curve is recomputed against the pooled reference and stays comparable; the per-row speedups in the table are not — the same unchanged kernel reports different multiples, and a faster version can even report a lower one. Usually the evaluator re-timed its reference on each run (in an ephemeral container the frozen file dies with the container), or the machine really changed mid-run (clocks locked, a different card) — that last one is a genuine change of denominator, and the two segments have to be declared incomparable.',
  'axis.hintLatency': '⚠ The y axis fell back to latency, direction inverted — higher is faster. Not one contract line in this run carried a speedup field (`speedup` or `ref_runtime_ms`, either inside `native_metrics` or beside `latency_ms`), so the panel can neither label "× over the reference" nor pool one denominator to cancel the reference jitter of individual evaluations. The protocol asks every evaluation to carry one — an evaluator that computed the ratio but left it out of the contract line looks exactly like this.',
  'loop.armed': 'loop running · {done}/{budget} optimization evaluations',
  'loop.overBudget': 'plus {count} over-budget evaluations',
  'loop.stopped': 'loop stopped: {reason}',
  'loop.interrupted': 'The last loop run has no closing record: it was stopped, or a host restart cut it off. Starting again resumes from the progress already on record.',
  'pop.budget': 'Optimization evaluation limit',
  'pop.language': 'Output language for this run',
  'pop.supervise': 'External supervision',
  'pop.model': 'Supervisor model',
  'pop.effort': 'Reasoning effort',
  'pop.supNote': 'On: before each new optimization round, the supervisor reviews the current progress and hands its findings to the agent. If the agent tries to wrap up before the evaluation budget is exhausted, the supervisor also decides whether worthwhile optimization headroom remains.',
  'pop.footer': 'Starting puts the agent to work immediately. While the task remains unfinished, the loop continues after each round until it exhausts the optimization evaluation budget. Composer drafts are never sent automatically; the curve and full record live on the Evaluations tab.',
  'sup.on': 'On',
  'sup.off': 'Off',
  'sup.needCfg': 'No supervisor model configured: pick one below, or add supervisor: { provider, model } to the plugin config',
  'sup.model': 'Supervisor model',
  'sup.default': 'default: {route}',
  'sup.pick': 'pick a supervisor model…',
  'sup.effortDefault': 'Use model default',
  'sup.effortDefaultNamed': 'Model default: {effort}',
  'sup.effortUnavailable': 'This model does not publish selectable reasoning efforts',
  'sup.effortTip': 'Options come from the model adapter; supported levels vary by model.',
  'ctl.start': 'Start loop',
  'ctl.stop': 'Stop loop',
  'ctl.budget': 'Optimization evaluation limit',
  'advice.title': 'Supervision log',
  'advice.waiting': 'Supervision on: before each continuation the supervisor reviews progress first; its conclusions and advice are handed to the agent and recorded here.',
  'advice.round': 'review {n}',
  'advice.earlier': '({n} review records from earlier loop runs hidden; the full history stays in the session log)',
  'reason.finalized': 'finalized',
  'reason.converged': 'supervisor confirmed no further headroom; wrapped up',
  'reason.budget': 'optimization evaluation budget exhausted; wrap-up requested',
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
  'advice.covers': 'Covers evaluations',
  'advice.coversNone': 'No new evaluations since this review',
  'advice.verdict': 'Verdict',
  'advice.expandHint': 'Click a row to see what that review covered and concluded',
  'ctl.supDep': 'Supervision runs at the loop\'s checkpoints — it only fires once the loop is started.',
  'ctl.supOff': 'Off: the agent decides when to wrap up; the loop keeps only its budget and stall guards.',
  'ctl.supOn': 'Reviews before each continuation, and rules on remaining headroom when the agent wraps up early.',
  'chips.wrapup': '{count} wrap-up validations',
  'tip.iters': 'Optimization evaluations completed in the loop; over-budget evaluations and wrap-up validations are excluded',
  'tip.overBudget': 'Extra evaluations completed in the same round before the budget check; they do not increase the optimization evaluation limit',
  'tip.wrapup': 'Final validation or plugin replay performed during wrap-up; it does not count against the optimization evaluation budget',
  'tip.replay': 'Measured by the plugin replaying the evaluation command against the final version',
  'row.channelTool': 'tool',
  'tip.tool': 'Returned directly by a registered evaluator tool, not agent-relayed',
  'tip.final': 'The final version selected at wrap-up',
  'tip.best': 'Best result so far',
  'tip.ok': 'Correctness check passed',
  'tip.speedup': 'The speedup this evaluation reported for itself: the evaluator re-times the reference kernel inside the same run and divides, so reference-side jitter rides along — two rows with near-identical latency differing in the last digit is normal. The curve does not use this per-row ratio; it uses one reference time pooled over the run.',
  'ctl.locked': 'The supervision switch, model, and reasoning effort are locked while the loop runs. Stop the loop before changing them; starting again preserves the recorded evaluation progress.',
  'ctl.lockedHint': 'Locked while the loop runs — stop it first',
  'sup.modelTip': 'The supervisor list comes from the models the host has configured — the same set the conversation uses. Add a service in host settings and it shows up here.',
  'row.overBudget': 'over budget',
  'lang.auto': 'Follow interface ({language})',
  'lang.zh': '中文',
  'lang.en': 'English',
  'lang.tip': 'Resolved from the interface language when the run starts, then kept fixed for that run.',
  'axis.short': 'Higher is faster',
  'axis.why': 'About these metrics',
  'row.best': 'best',
  'hero.running': 'Best so far',
  'hero.final': 'Submission candidate',
  'hero.from': '{reference} → {latency}',
  'hero.faster': 'Fastest measured {label}, from {artifact} — not the version this run picked',
  'hero.rejected': '{count} candidates failed verification',
  'hero.unclaimable': '⚠ This run finalized on {artifact}, but that evaluation did not pass verification — the number above is the run\u2019s best VERIFIED result, not the version it picked',
  'hero.passed': 'Correctness passed',
  'hero.noHack': 'No reward hack detected',
  'hero.pending': 'Evaluation in flight',
  'rail.running': 'Round {round} · {done}/{budget} optimization evaluations done',
  'rail.settings': 'Run settings',
  'rail.collapse': 'Hide',
  'chart.candidate': 'Passed evaluations',
  'chart.rejectedDot': 'Failed verification',
  'chart.best': 'New best',
  'chart.final': 'Wrap-up pick',
  'chart.bestFinal': 'Best · wrap-up pick',
  'audit.title': 'Full audit record',
  'audit.hint': 'Environment, plan history, supervision log, per-evaluation detail',
  'workspace.title': 'Kernel optimization',
  'workspace.subtitle': 'DeepSeek Harness',
  'workspace.ready': 'Awaiting evaluation',
  'workspace.complete': 'Result selected',
  'workspace.paused': 'Ready to continue',
  'workspace.live': 'Optimizing',
  'chart.title': 'Optimization progress',
  'chart.subtitle': 'Every attempt, on the record',
  'chart.axis': 'Evaluation',
  'chart.select': 'Select evaluation',
  'chart.details': 'View details',
  'chart.latency': 'Latency',
  'chart.speedup': 'Speedup',
  'chart.reference': 'Reference',
  'chart.optimized': 'Current result',
  'chart.help': 'Hover or select a point to inspect its evaluation',
  'chart.log': 'Log scale',
  'chart.none': 'Waiting for the first measured latency',
  'chart.driftShort': 'Reference latency varies; the chart uses a pooled reference.',
  'hero.ratio': 'Speedup over the reference',
  'hero.latency': 'Measured latency',
  'stats.evals': 'Evaluations',
  'stats.profiles': 'Profiles',
  'stats.reviews': 'Reviews',
  'recent.title': 'Recent evaluations',
  'recent.all': 'All evaluations',
  'plan.details': 'Plan details',
  'workspace.focus': 'Focus view',
  'workspace.exitFocus': 'Exit focus view',
  'phase.done': 'Done',
  'phase.baseline': 'Baseline',
  'phase.optimize': 'Optimize',
  'phase.explore': 'Explore',
  'phase.tune': 'Tune',
  'phase.verify': 'Verify',
  'phase.finalize': 'Finalize',
} satisfies Record<LocaleKey, string>

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
  caption: 'var(--dsw-alias-label-secondary, #5a6270)',
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
  curve: 'light-dark(#425fdf, #9aadff)',
  ok: 'var(--dsw-alias-state-success-primary, #1f8f5f)',
  bad: 'var(--dsw-alias-state-error-primary, #d93a3f)',
  warn: 'var(--dsw-alias-state-warn-primary, #d18a1f)',
}

/** Elevated-surface shadow (host menu dropdowns use shadow-lv3). */
const MENU_SHADOW = 'var(--dsw-shadow-lv3, 0 8px 24px rgba(0,0,0,.14))'

/** Attach {@link PANEL_CSS} once per document, whichever panel mounts first. */
function installPanelStyles(): void {
  if (typeof document === 'undefined') return
  const id = 'kernel-opt-panel-css'
  if (document.getElementById(id) !== null) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = PANEL_CSS
  document.head.append(style)
}

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

/** Resolve reasoning choices only for the supervisor route currently shown. */
function useModelInfo(provider: string | undefined, model: string | undefined): WireModelInfo | null {
  const [info, setInfo] = useState<WireModelInfo | null>(null)
  useEffect(() => {
    setInfo(null)
    if (provider === undefined || model === undefined) return
    let alive = true
    void (async () => {
      try {
        const query = new URLSearchParams({ provider, model })
        const res = await fetch(`${MODELS_PATH}?${query.toString()}`, { headers: { accept: 'application/json' } })
        if (!res.ok) return
        const data = (await res.json()) as WireModelInfo
        if (alive && data.provider === provider && data.id === model) setInfo(data)
      } catch {
        // No exact metadata: the supervisor keeps the model/provider default.
      }
    })()
    return () => { alive = false }
  }, [provider, model])
  return info
}

/** Client capability needed only while a run is being armed. */
interface RunLocaleInjected {
  /** Active interface locale, resolved to a run language at the arm click. */
  getLocale: () => LocaleId
}

/** The panel currently ships one run-language choice per interface locale. */
function runLanguageOf(locale: LocaleId): RunLanguage {
  return locale === 'en' ? 'en' : 'zh'
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

/**
 * Whether the reader has asked for reduced motion.
 *
 * The stylesheet's media query covers every CSS animation here, but the one
 * SMIL animation on the plot is outside CSS's reach entirely — so the
 * preference has to be readable from JavaScript too, or the guarantee is only
 * true of the animations that happened to be written in CSS.
 * @returns whether motion should be suppressed, live as the preference changes.
 */
function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    setReduce(query.matches)
    const onChange = (): void => { setReduce(query.matches) }
    query.addEventListener('change', onChange)
    return () => { query.removeEventListener('change', onChange) }
  }, [])
  return reduce
}

/** Stable-enough identity of one plotted evaluation across polls. */
function arrivalKey(point: WireIteration, index: number): string {
  // The latency is part of the identity on purpose: a pending call that comes
  // back measured is the moment the result LANDS, and that deserves the same
  // acknowledgement as a brand-new row.
  return `${String(point.seq)}-${String(index)}-${point.latencyMs === undefined ? 'pending' : String(point.latencyMs)}`
}

/**
 * The evaluations that appeared since the previous poll, for this session.
 *
 * Empty on first sight of a session, always. Opening a finished session — or
 * replaying one — must render the settled picture, not perform twelve
 * arrivals that happened last week: the panel's claim is that a replay looks
 * like the live run looked, and animating history is the one way to break
 * that while appearing to honour it.
 *
 * Keyed by session for the same reason. The component survives a switch in
 * the sidebar, so a set that carried over would classify every row of the
 * newly opened session as fresh and animate a finished run end to end — the
 * exact failure the first-sight rule exists to prevent, arriving through the
 * one path that does not remount.
 * @param sessionId - session the projection belongs to.
 * @param iterations - the current projection.
 * @returns arrival keys to animate this frame.
 */
function useArrivals(sessionId: string, iterations: readonly WireIteration[]): ReadonlySet<string> {
  const seen = useRef<{ sessionId: string, keys: Set<string> } | null>(null)
  const [arrived, setArrived] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    const keys = iterations.map((point, index) => arrivalKey(point, index))
    const known = seen.current
    if (known === null || known.sessionId !== sessionId) {
      seen.current = { sessionId, keys: new Set(keys) }
      // A switch may leave the previous session's arrivals marked; clearing
      // is what keeps a stale key from animating a row it does not name.
      setArrived(new Set())
      return
    }
    const fresh = keys.filter(key => !known.keys.has(key))
    for (const key of keys) known.keys.add(key)
    if (fresh.length > 0) setArrived(new Set(fresh))
  }, [sessionId, iterations])
  return arrived
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

/** Responsive, keyboard-accessible plot of the recorded evaluations. */
function Chart(props: {
  series: WireSeries
  t: T
  onInspect: (index: number) => void
}): ReactNode {
  const { series, t, onInspect } = props
  const { iterations, bestIndex } = series
  const frameRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(640)
  const [selection, setSelection] = useState<{ session: string, index: number } | null>(null)
  const arrivals = useArrivals(series.sessionId, iterations)
  const reduceMotion = useReducedMotion()
  useEffect(() => {
    const node = frameRef.current
    if (node === null) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry !== undefined && entry.contentRect.width > 0) setWidth(entry.contentRect.width)
    })
    observer.observe(node)
    return () => { observer.disconnect() }
  }, [])
  const frame = useMemo(() => ({ ...CHART, w: width, h: 250, l: 80, r: 18, t: 22, b: 38 }), [width])
  const model = useMemo(() => chartModel(iterations, iterations.length, frame), [iterations, frame])
  const drift = useMemo(() => referenceDrift(iterations), [iterations])
  const headline = runHeadline(iterations, bestIndex)
  const defaultIndex = headline.claim !== undefined ? iterations.indexOf(headline.claim) : iterations.length - 1
  const selectedIndex = selection?.session === series.sessionId && iterations[selection.index] !== undefined
    ? selection.index : defaultIndex
  const selected = iterations[selectedIndex]
  const select = (index: number): void => { setSelection({ session: series.sessionId, index }) }
  // Keep original evaluation indices so skipped failures retain their horizontal space.
  const linePoints = model === null ? '' : iterations.flatMap((point, index) =>
    statusOf(point) === 'ok' && point.latencyMs !== undefined
      && Number.isFinite(point.latencyMs) && point.latencyMs > 0
      ? [`${model.x(index)},${model.y(point.latencyMs)}`] : [],
  ).join(' ')
  const bottom = frame.h - frame.b
  const stride = Math.max(1, Math.ceil((iterations.length - 1) / Math.max(2, Math.floor(width / 65))))
  const ticks = iterations.map((_, i) => i).filter(i => i === 0 || i === iterations.length - 1 || (i % stride === 0 && i < iterations.length - stride / 2))
  const selectedStatus = selected !== undefined ? statusOf(selected) : undefined
  return (
    <div className="ko-chart" ref={frameRef}>
      {model === null
        ? <div className="ko-empty">{t('chart.none')}</div>
        : (
          <svg viewBox={`0 0 ${frame.w} ${frame.h}`} role="group" aria-label={t('chart.title')}>
            {[0, .25, .5, .75, 1].map(f => {
              const value = model.atFraction(f)
              const y = model.y(value)
              return <g key={f}>
                <line x1={frame.l} x2={frame.w - frame.r} y1={y} y2={y} stroke={COLOR.border} strokeDasharray={f === 0 ? undefined : '3 5'} opacity={.65} />
                <text x={frame.l - 10} y={y + 4} textAnchor="end" fontSize={14} fill={COLOR.caption}>{model.label(value)}</text>
              </g>
            })}
            {linePoints !== '' ? <polyline points={linePoints} fill="none" stroke={COLOR.curve}
              strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" opacity={.8} /> : null}
            {selected !== undefined ? <line x1={model.x(selectedIndex)} x2={model.x(selectedIndex)} y1={frame.t} y2={bottom} stroke={COLOR.curve} strokeDasharray="3 4" opacity={.25} /> : null}
            {ticks.map(i => <text key={i} x={model.x(i)} y={bottom + 24} textAnchor="middle" fontSize={14} fill={COLOR.caption}>{String(i + 1).padStart(2, '0')}</text>)}
            {series.profileSeqs.map((seq, i) => {
              const next = iterations.findIndex(point => point.seq > seq)
              const before = next < 0 ? iterations.length - 1 : Math.max(0, next - 1)
              const after = next < 0 ? before : next
              const x = (model.x(before) + model.x(after)) / 2
              return <path key={`profile-${seq}-${i}`} d={`M ${x - 3} ${bottom - 4} l 3 -4 l 3 4 l -3 4 Z`} fill={COLOR.caption} opacity={.6}>
                <title>{t('chips.profiles', { count: i + 1 })}</title>
              </path>
            })}
            {iterations.map((point, i) => {
              const status = statusOf(point)
              const color = status === 'ok' ? COLOR.curve : STATUS_COLOR[status]
              const x = model.x(i)
              const y = point.latencyMs !== undefined ? model.y(point.latencyMs) : bottom + 5
              const active = selectedIndex === i
              const fresh = arrivals.has(arrivalKey(point, i))
              const label = `${t('chart.select')} ${i + 1} · ${point.latencyMs !== undefined ? formatLatency(point.latencyMs) : '—'} · ${t(`status.${status}`)}`
              return <g key={`${point.seq}-${i}`} role="button" tabIndex={0} aria-label={label} aria-pressed={active}
                onMouseEnter={() => { select(i) }} onFocus={() => { select(i) }} onClick={() => { select(i) }}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(i) }
                  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                    event.preventDefault()
                    const target = event.key === 'ArrowRight' ? event.currentTarget.nextElementSibling : event.currentTarget.previousElementSibling
                    if (target?.getAttribute('role') === 'button') (target as SVGElement).focus()
                  }
                }}>
                <title>{label}</title>
                <circle className="ko-hit" cx={x} cy={y} r={12} fill="transparent" />
                {active ? <circle cx={x} cy={y} r={9} fill={COLOR.curve} opacity={.13} /> : null}
                {fresh && bestIndex === i ? <circle className="kernel-opt-halo" cx={x} cy={y} r={6} fill="none" stroke={COLOR.curve} style={{ animation: 'kernelOptHalo 900ms ease-out forwards' }} /> : null}
                <circle className={fresh ? 'kernel-opt-arrive' : undefined} cx={x} cy={y} r={active || bestIndex === i ? 4.5 : 3.2}
                  fill={status === 'ok' ? color : COLOR.inputBg} stroke={status === 'ok' ? COLOR.inputBg : color} strokeWidth={1.7}
                  style={fresh ? { animation: 'kernelOptArrive 200ms ease-out', transformOrigin: `${x}px ${y}px` } : undefined}>
                  {status === 'pending' && !reduceMotion ? <animate attributeName="opacity" values="1;.3;1" dur="1.2s" repeatCount="indefinite" /> : null}
                </circle>
                {point.latencyMs !== undefined && model.clamped(point.latencyMs) ? <text x={x} y={y - 12} textAnchor="middle" fontSize={14} fill={COLOR.caption}>↓</text> : null}
              </g>
            })}
          </svg>
        )}
      <div className="ko-chart-legend">
        <span><i className="ko-line-key" style={{ color: COLOR.curve }} />{t('chart.candidate')}</span>
        <span><i className="ko-dot-key" />{t('chart.rejectedDot')}</span>
        <span style={{ marginLeft: 'auto' }}>{t('chart.axis')}{model?.log === true ? ` · ${t('chart.log')}` : ''}</span>
      </div>
      {selected !== undefined && selectedStatus !== undefined ? (
        <div className="ko-inspector">
          <span className="ko-muted">#{String(selectedIndex + 1).padStart(2, '0')}</span>
          <strong>{selected.latencyMs !== undefined ? formatLatency(selected.latencyMs) : '—'}</strong>
          {selected.speedup !== undefined ? <span>{selected.speedup.toPrecision(3)}×</span> : null}
          <span style={{ color: STATUS_COLOR[selectedStatus] }}>{t(`status.${selectedStatus}`)}</span>
          {selectedIndex === bestIndex ? <span style={{ color: COLOR.curve }}>{t('row.best')}</span> : null}
          {selected.finalized === true && selected.channel !== 'replay' ? <span style={{ color: COLOR.curve }}>{t('table.final')}</span> : null}
          <button className="ko-text-button" type="button" onClick={() => { onInspect(selectedIndex) }}>{t('chart.details')} ↗</button>
        </div>
      ) : null}
      <details className="ko-chart-explanation">
        <summary><span>{t('chart.help')}</span><span>{t('axis.why')} ⓘ</span></summary>
        <p>{t(model?.referenceMs !== undefined ? 'axis.hintSpeedup' : 'axis.hintLatency')}</p>
        {drift !== undefined ? <p style={{ color: COLOR.warn }}>{t('axis.drift', { count: drift.count, min: formatLatency(drift.min), max: formatLatency(drift.max), pct: Math.round((drift.ratio - 1) * 100) })}</p> : null}
      </details>
      {drift !== undefined ? <div className="ko-chart-explanation" style={{ color: COLOR.warn, marginTop: 5 }}>{t('chart.driftShort')}</div> : null}
    </div>
  )
}

// Sizes sit on the host type scale (ui-theme tokens 12/13/14/16): 14 body,
// 13 secondary, 12 captions — one tier above the first draft, which read a
// step smaller than the surrounding conversation UI.
const chipStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '2px 10px', borderRadius: 999,
  border: `1px solid ${COLOR.border}`,
  fontSize: 'var(--ko-body, 13px)', lineHeight: 'var(--ko-line-body, 22px)', color: COLOR.dim,
  whiteSpace: 'nowrap',
}

const cardStyle: CSSProperties = {
  border: `1px solid ${COLOR.border}`,
  borderRadius: 12,
  background: COLOR.tip,
  padding: '14px 16px',
}

/** Last path segment — the artifact's identity, without the run's directory layout. */
function baseName(path: string): string {
  return path.split('/').filter(s => s.length > 0).pop() ?? path
}

/** The eligible result, with its own reference and verification status. */
function Hero(props: {
  headline: RunHeadline
  referenceMs: number | undefined
  pendingCount: number
  t: T
}): ReactNode {
  const { headline, referenceMs, pendingCount, t } = props
  const claim = headline.claim
  if (claim?.latencyMs === undefined) return null
  const ratio = claim.speedup ?? (referenceMs !== undefined ? referenceMs / claim.latencyMs : undefined)
  const reference = ratio !== undefined ? ratio * claim.latencyMs : undefined
  const maxLatency = Math.max(reference ?? claim.latencyMs, claim.latencyMs)
  const faster = headline.fasterMeasured
  const fasterRatio = faster?.latencyMs === undefined ? undefined
    : faster.speedup ?? (referenceMs !== undefined ? referenceMs / faster.latencyMs : undefined)
  return (
    <div className="ko-hero">
      <div>
        <div className="ko-hero-label"><i />{t(headline.finalized ? 'hero.final' : 'hero.running')}</div>
        <div className="ko-hero-number">
          {ratio !== undefined ? <>{ratio.toPrecision(3)}<small>×</small></> : formatLatency(claim.latencyMs)}
        </div>
        <div className="ko-hero-caption">{t(ratio !== undefined ? 'hero.ratio' : 'hero.latency')}</div>
      </div>
      {reference !== undefined ? <div className="ko-comparison">
        <div>
          <div className="ko-comparison-label"><span>{t('chart.reference')}</span><strong>{formatLatency(reference)}</strong></div>
          <div className="ko-bar"><span style={{ width: `${reference / maxLatency * 100}%` }} /></div>
        </div>
        <div>
          <div className="ko-comparison-label"><span>{t('chart.optimized')}</span><strong>{formatLatency(claim.latencyMs)}</strong></div>
          <div className="ko-bar" data-result><span style={{ width: `${claim.latencyMs / maxLatency * 100}%` }} /></div>
        </div>
      </div> : null}
      <div className="ko-hero-footer">
        {claim.artifactPath !== undefined ? <span className="ko-artifact" title={claim.artifactPath}>{baseName(claim.artifactPath)}</span> : null}
        <div className="ko-checks">
          {claim.correct === true ? <span>✓ {t('hero.passed')}</span> : null}
          {claim.rewardHack !== true ? <span>✓ {t('hero.noHack')}</span> : null}
        </div>
        {headline.rejected > 0 ? <div style={{ marginTop: 7 }}>{t('hero.rejected', { count: headline.rejected })}</div> : null}
        {pendingCount > 0 ? <div style={{ marginTop: 7 }}>{t('hero.pending')}</div> : null}
      </div>
      {faster !== undefined && fasterRatio !== undefined ? <div className="ko-hero-note">
        {t('hero.faster', { label: `×${fasterRatio.toPrecision(3)}`, artifact: faster.artifactPath !== undefined ? baseName(faster.artifactPath) : '—' })}
      </div> : null}
      {headline.unclaimablePick !== undefined ? <div className="ko-hero-note" data-error>
        {t('hero.unclaimable', { artifact: headline.unclaimablePick.artifactPath !== undefined ? baseName(headline.unclaimablePick.artifactPath) : '—' })}
      </div> : null}
    </div>
  )
}

/** Kernel and rising curve, used as the panel's navigation mark. */
function KernelMark(): ReactNode {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="5" y="5" width="14" height="14" rx="3" />
    <path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3M8 15l3-3 2 1 3-4" />
  </svg>
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
  fontSize: 'var(--ko-small, 12px)', lineHeight: 'var(--ko-line-small, 18px)', fontFamily: 'inherit', whiteSpace: 'nowrap',
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
  fontSize: 'var(--ko-small, 12px)', fontFamily: 'inherit', color: COLOR.text, outline: 'none',
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
  flex: 'none', fontSize: 'var(--ko-small, 12px)', color: COLOR.dim,
}

/** Popover card, after the host MenuDropdown surface (r12, lv3 shadow). */
const popoverStyle: CSSProperties = {
  position: 'fixed', zIndex: 41, boxSizing: 'border-box',
  display: 'flex', flexDirection: 'column', gap: 10, padding: 12,
  overflowY: 'auto', overscrollBehavior: 'contain',
  border: `1px solid ${COLOR.menuBorder}`, borderRadius: 12,
  background: COLOR.menuBg, boxShadow: MENU_SHADOW,
  fontFamily: 'system-ui', fontSize: 'var(--ko-body, 13px)', color: COLOR.text,
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
    fontSize: 'var(--ko-small, 12px)',
    lineHeight: 'var(--ko-line-small, 18px)',
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

const sectionLabel: CSSProperties = { fontSize: 'var(--ko-small, 12px)', fontWeight: 600, color: COLOR.dim, marginBottom: 2 }

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
      display: 'flex', flexDirection: 'column', gap: 6, fontSize: 'var(--ko-small, 12px)', color: COLOR.dim,
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
    <div style={{ display: 'flex', gap: 10, fontSize: 'var(--ko-body, 13px)', lineHeight: 'var(--ko-line-body, 21px)' }}>
      <span style={{ flex: 'none', minWidth: 62, color: COLOR.caption }}>{label}</span>
      <span style={{ color: COLOR.text, wordBreak: 'break-word' }}>{value}</span>
    </div>
  )
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <span style={{ fontSize: 'var(--ko-body, 14px)', fontWeight: 600 }}>{t('env.title')}</span>
        {env !== undefined
          ? <span style={{ fontSize: 'var(--ko-small, 12px)', color: COLOR.caption }}>{t('env.reported')}</span>
          : null}
      </div>
      {env === undefined
        ? <div style={{ fontSize: 'var(--ko-body, 14px)', color: COLOR.caption }}>{t('env.none')}</div>
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
                    <div style={{ display: 'flex', gap: 10, fontSize: 'var(--ko-small, 12px)', lineHeight: 'var(--ko-line-small, 20px)', marginTop: 2 }}>
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
      <div style={{ fontSize: 'var(--ko-small, 12px)', color: COLOR.caption, margin: '2px 0' }}>
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
      display: 'flex', flexDirection: 'column', gap: 8, fontSize: 'var(--ko-body, 13px)',
    }}>
      <div style={{ color: COLOR.caption, fontSize: 'var(--ko-small, 12px)' }}>
        {point.tool} · seq {point.seq}
        {point.channel !== undefined ? ` · ${t(point.channel === 'replay' ? 'row.channelReplay' : 'row.channelShell')}` : ''}
        {point.artifactPath !== undefined ? ` · ${point.artifactPath}` : ''}
        {point.workloadSubset !== undefined ? ` · ${t('row.subset')} [${point.workloadSubset.join(', ')}]` : ''}
      </div>
      {unverifiedFinal === true
        ? <div style={{ color: COLOR.warn, fontSize: 'var(--ko-small, 12px)' }}>⚠ {t('row.unverifiedFinal')}</div>
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
                <div key={index} style={{ fontSize: 'var(--ko-small, 12px)', color: COLOR.bad }}>· {line}</div>
              ))}
            </div>
          )
        : null}
      {point.advisory !== undefined
        ? (
            <div>
              <div style={sectionLabel}>{t('row.advisory')}</div>
              {point.advisory.map((line, index) => (
                <div key={index} style={{ fontSize: 'var(--ko-small, 12px)', color: COLOR.dim }}>· {line}</div>
              ))}
            </div>
          )
        : null}
      {point.notMeasured !== undefined
        ? <div style={{ fontSize: 'var(--ko-small, 12px)', color: COLOR.caption }}>{t('row.notMeasured')}: {point.notMeasured.join(', ')}</div>
        : null}
      {point.metrics !== undefined
        ? (
            <div>
              <div style={sectionLabel}>{t('row.metrics')}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {Object.entries(point.metrics).map(([key, value]) => (
                  <span key={key} style={{ ...chipStyle, fontSize: 'var(--ko-small, 12px)', lineHeight: 'var(--ko-line-small, 18px)', padding: '1px 8px' }}>
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

/** Adapter-published reasoning-effort picker for the effective supervisor route. */
function SupervisorEffortSelect(props: {
  control: WireControl
  info: WireModelInfo | null
  t: T
  locked?: boolean
  onUse: (provider: string, model: string, reasoningEffort: string) => void
  style?: CSSProperties
}): ReactNode {
  const { control, info, t, locked = false, onUse } = props
  const effective = control.supervisor.effective
  if (effective === undefined) return null
  const efforts = info?.reasoning?.efforts ?? []
  const selected = effective.reasoningEffort ?? ''
  const known = efforts.some(effort => effort.id === selected)
  const defaultId = info?.reasoning?.defaultEffort
  const defaultName = efforts.find(effort => effort.id === defaultId)?.name
  const defaultLabel = defaultName === undefined
    ? t('sup.effortDefault')
    : t('sup.effortDefaultNamed', { effort: defaultName })
  const disabled = locked || info === null || efforts.length === 0
  return (
    <select
      value={selected}
      disabled={disabled}
      title={locked
        ? t('ctl.lockedHint')
        : efforts.length === 0 ? t('sup.effortUnavailable') : t('sup.effortTip')}
      style={{ ...selectStyle, ...props.style, ...(disabled ? disabledBtnStyle : {}) }}
      onChange={(event) => { onUse(effective.provider, effective.model, event.target.value) }}
    >
      <option value="">{defaultLabel}</option>
      {selected !== '' && !known ? <option value={selected}>{selected}</option> : null}
      {efforts.map(effort => (
        <option key={effort.id} value={effort.id} title={effort.description}>{effort.name}</option>
      ))}
    </select>
  )
}

/** The evaluation tab. */
export function KernelOptTab(
  props: PropsRuntime<'conversation.view'> & PropsLocale<'kernel-opt'> & InjectFace<RunLocaleInjected>,
): ReactNode {
  const { t, sessionId, getLocale } = props
  const { series, refetch } = useSeries(sessionId)
  const models = useModels()
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null)
  const [languageDraft, setLanguageDraft] = useState<'auto' | RunLanguage>('auto')
  // Keyed by the iteration's INDEX, not its seq: one shell call that prints
  // two contract lines (two seeds in one bench run) yields two iterations
  // sharing a seq, and a seq-keyed expansion opens both rows at once.
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)
  const [expandedReview, setExpandedReview] = useState<number | null>(null)
  const [planHistory, setPlanHistory] = useState(false)
  /** Run settings, folded out of the rail; opened on demand. */
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** The audit sections (environment, plans, supervision, table), folded. */
  const [auditOpen, setAuditOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    const sync = (): void => { setFocused(document.fullscreenElement === panelRef.current) }
    document.addEventListener('fullscreenchange', sync)
    return () => { document.removeEventListener('fullscreenchange', sync) }
  }, [])
  const toggleFocus = async (): Promise<void> => {
    try {
      if (document.fullscreenElement === panelRef.current) await document.exitFullscreen()
      else await panelRef.current?.requestFullscreen()
    } catch { /* An embedding host may decline fullscreen; the panel stays usable. */ }
  }
  useEffect(() => { setExpandedIdx(null); setAuditOpen(false); setPlanHistory(false) }, [sessionId])

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
  const effectiveSupervisor = control?.supervisor.effective
  const modelInfo = useModelInfo(effectiveSupervisor?.provider, effectiveSupervisor?.model)
  const latestPlan = plans.length > 0 ? plans[plans.length - 1] : undefined
  const envs = series?.envs ?? []
  const env = envs.length > 0 ? envs[envs.length - 1] : undefined
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
  const recordedBudget = [...rounds].reverse().find(round => round.budget !== undefined)?.budget ?? 0
  const phaseBudget = control !== undefined && control.loop.budget > 0 ? control.loop.budget : recordedBudget
  const phases = evaluationPhases(iterations, rounds, phaseBudget)
  const optimizationEvals = phases.filter(phase => phase === 'optimization').length
  const overBudgetEvals = phases.filter(phase => phase === 'over-budget').length
  const wrapUpChecks = phases.filter(phase => phase === 'wrap-up').length
  const currentRunLanguage = runLanguageOf(getLocale())
  const outputLanguage = languageDraft === 'auto' ? currentRunLanguage : languageDraft
  const reasonLabel = (reason: string): string =>
    reason === 'finalized' || reason === 'converged' || reason === 'budget'
    || reason === 'no-progress' || reason === 'stopped'
      ? t(`reason.${reason}`)
      : reason

  const empty = iterations.length === 0 && plans.length === 0
  // The chart uses the pooled reference; the headline uses it only when the
  // selected evaluation did not report its own speedup.
  const pooledReference = useMemo(() => referenceLatency(iterations), [iterations])
  const headline = useMemo(
    () => runHeadline(iterations, series?.bestIndex ?? null),
    [iterations, series?.bestIndex],
  )

  const auditRef = useRef<HTMLDivElement>(null)
  const inspectIteration = (index: number): void => {
    setExpandedIdx(index)
    setAuditOpen(true)
  }
  useEffect(() => {
    if (auditOpen && expandedIdx !== null) auditRef.current?.querySelector(`[data-iteration="${expandedIdx}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [auditOpen, expandedIdx])
  const phaseLabel = (phase: string): string => {
    const normalized = phase.toLowerCase()
    return normalized === 'explore' || normalized === 'tune' || normalized === 'verify' || normalized === 'finalize'
      || normalized === 'done' || normalized === 'baseline' || normalized === 'optimize'
      ? t(`phase.${normalized}`) : phase
  }

  return (
    <div className="ko-panel" ref={panelRef}>
      <header className="ko-header">
        <div className="ko-brand"><KernelMark /></div>
        <div><h1>{t('workspace.title')}</h1><div className="ko-header-sub">{t('workspace.subtitle')}</div></div>
        <span className="ko-state" data-live={control?.loop.armed === true}>
          <i style={control?.loop.armed === true ? { animation: 'kernelOptPulse 1.6s ease-in-out infinite' } : undefined} />
          {t(control?.loop.armed === true ? 'workspace.live' : headline.finalized ? 'workspace.complete' : empty ? 'workspace.ready' : 'workspace.paused')}
        </span>
        {typeof document !== 'undefined' && document.fullscreenEnabled ? <button type="button" className="ko-focus-button" onClick={() => { void toggleFocus() }} aria-pressed={focused}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4" /></svg>
          {t(focused ? 'workspace.exitFocus' : 'workspace.focus')}
        </button> : null}
      </header>
      {/* The run rail: ONE line, because on a screen someone is watching this
          block competes with the result for first read and must lose. It used
          to be a titled card carrying five controls and two caption
          paragraphs above the number the reader came for — a page whose
          largest object is its settings reads as a thing you configure, not a
          thing that produced something. Everything removed from here is one
          click away below, and nothing is removed while it is actionable:
          budget and start stay in the rail when idle, stop stays when armed. */}
      <div className="ko-rail">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', minHeight: 28 }}>
          {control?.loop.armed === true
            ? (
                <>
                  <span style={{
                    flex: 'none', width: 8, height: 8, borderRadius: 999,
                    background: COLOR.curve, animation: 'kernelOptPulse 1.6s ease-in-out infinite',
                  }} />
                  <span style={{ fontSize: 'var(--ko-body, 14px)', color: COLOR.curve, fontWeight: 500 }}>
                    {t('rail.running', {
                      round: control.loop.round,
                      done: Math.min(control.loop.evalsDone, control.loop.budget),
                      budget: control.loop.budget,
                    })}
                  </span>
                  {control.loop.evalsOverBudget > 0
                    ? <span style={{ fontSize: 'var(--ko-body, 13px)', color: COLOR.warn }}>{t('loop.overBudget', { count: control.loop.evalsOverBudget })}</span>
                    : null}
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
                      void post('loop-arm', {
                        ...(Number.isInteger(budget) && budget > 0 ? { budget } : {}),
                        outputLanguage,
                      })
                    }}
                  >
                    ⟳ {t('ctl.start')}
                  </button>
                  {control.loop.stopReason !== undefined
                    ? (
                        <span style={{ fontSize: 'var(--ko-body, 13px)', color: COLOR.caption }}>
                          {t('loop.stopped', { reason: reasonLabel(control.loop.stopReason) })}
                        </span>
                      )
                    : null}
                </>
              )
            : null}
          <span style={{ flex: 1 }} />
          {control !== undefined
            ? (
                <button type="button" className="ko-text-button" aria-expanded={settingsOpen}
                  onClick={() => { setSettingsOpen(value => !value) }}>
                  {settingsOpen ? `${t('rail.collapse')} ▴` : `${t('rail.settings')} ▾`}
                </button>
              )
            : null}
        </div>
        {control?.loop.armed === true && control.loop.budget > 0
          ? <progress className="ko-progress" max={control.loop.budget} value={Math.min(control.loop.evalsDone, control.loop.budget)} aria-label={t('stats.evals')} /> : null}
        {/* An armed run that lost its state (host restart) leaves the log's
            last word as a continuation and no finalize. That is a fact about
            the DATA on screen, not a setting, so it stays in the rail while
            the settings it sat among fold away. */}
        {control?.loop.armed === false && control.loop.stopReason === undefined
          && unfinishedRun(rounds, iterations)
          ? (
              <div style={{ fontSize: 'var(--ko-body, 13px)', lineHeight: 'var(--ko-line-small, 19px)', color: COLOR.warn }}>
                {t('loop.interrupted')}
              </div>
            )
          : null}
        {settingsOpen && control !== undefined
          ? (
              <div style={{
                display: 'flex', flexDirection: 'column', gap: 8,
                paddingTop: 8, borderTop: `1px solid ${COLOR.border}`,
              }}>
                {control.loop.armed === false && control.loop.available
                  ? (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                        <span style={rowLabelStyle}>{t('pop.language')}</span>
                        <select
                          value={languageDraft}
                          title={t('lang.tip')}
                          style={selectStyle}
                          onChange={(event) => { setLanguageDraft(event.target.value as 'auto' | RunLanguage) }}
                        >
                          <option value="auto">{t('lang.auto', { language: t(`lang.${currentRunLanguage}`) })}</option>
                          <option value="zh">{t('lang.zh')}</option>
                          <option value="en">{t('lang.en')}</option>
                        </select>
                      </div>
                    )
                  : null}
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
                  <span style={{ ...rowLabelStyle, marginLeft: 6 }}>{t('pop.effort')}</span>
                  <SupervisorEffortSelect
                    control={control}
                    info={modelInfo}
                    t={t}
                    locked={control.loop.armed}
                    onUse={(provider, model, reasoningEffort) => {
                      void post('supervise-use', { provider, model, reasoningEffort })
                    }}
                  />
                </div>
                {/* Supervision is a setting OF the loop, not a peer feature: it
                    only ever runs at the loop's checkpoints. The caption states
                    which half of that relationship currently applies. */}
                <div style={{ fontSize: 'var(--ko-small, 12px)', lineHeight: 'var(--ko-line-small, 18px)', color: COLOR.caption }}>
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
                      <div style={{ fontSize: 'var(--ko-small, 12px)', lineHeight: 'var(--ko-line-small, 18px)', color: COLOR.caption }}>
                        {t('ctl.locked')}
                      </div>
                    )
                  : null}
              </div>
            )
          : null}
      </div>

      {/* Evaluations that ran in a background job: their contract line reached
          the log but not this panel, so an empty curve here would otherwise
          read as "the agent measured nothing". Say which it is. */}
      {series !== null && series.uncollectedSeqs.length > 0
        ? (
            <div style={{ ...cardStyle, padding: '14px 16px', color: COLOR.warn }}>
              <div style={{ fontSize: 'var(--ko-body, 14px)', lineHeight: 'var(--ko-line-body, 22px)' }}>
                {t('uncollected.note', { count: series.uncollectedSeqs.length })}
              </div>
            </div>
          )
        : null}

      {empty ? <div className="ko-empty">
        <KernelMark /><h2>{t('empty.title')}</h2><p>{t('empty.body')}</p>
      </div> : null}

      {iterations.length > 0 ? <>
        <div className="ko-overview" style={headline.claim === undefined ? { gridTemplateColumns: '1fr' } : undefined}>
          <Hero headline={headline} referenceMs={pooledReference} pendingCount={pendingCount} t={t} />
          <div className="ko-chart-card">
            <div className="ko-section-head"><h2>{t('chart.title')}</h2><small>{t('axis.short')}</small></div>
            <div className="ko-chart-meta">
              <span>{t('chips.iterations', { count: optimizationEvals })}</span>
              {overBudgetEvals > 0 ? <span style={{ color: COLOR.warn }}>{t('chips.overBudget', { count: overBudgetEvals })}</span> : null}
              {wrapUpChecks > 0 ? <span>{t('chips.wrapup', { count: wrapUpChecks })}</span> : null}
              {hackCount > 0 ? <span style={{ color: COLOR.bad }}>{t('chips.hacks', { count: hackCount })}</span> : null}
            </div>
            <Chart series={series as WireSeries} t={t} onInspect={inspectIteration} />
          </div>
        </div>
        <div className="ko-stats">
          <div className="ko-stat" title={t('tip.iters')}><strong>{optimizationEvals}</strong><span>{t('stats.evals')}</span></div>
          <div className="ko-stat"><strong>{series?.profileSeqs.length ?? 0}</strong><span>{t('stats.profiles')}</span></div>
          <div className="ko-stat"><strong>{reviewedRounds.length}</strong><span>{t('stats.reviews')}</span></div>
          {env !== undefined ? <span className="ko-device" title={`${t('env.reported')} · ${env.device}`}>{env.device.split(/[（(]/)[0]?.trim()}</span> : null}
        </div>
      </> : null}

      {!empty ? <div className="ko-lower">
        <section className="ko-plan">
          <div className="ko-section-head">
            <h2>{t('plan.title')}</h2>
            {latestPlan !== undefined ? <small>{t('plan.count', { n: plans.length })}</small> : null}
          </div>
          {latestPlan === undefined ? <p className="ko-plan-copy">{t('plan.none')}</p> : <>
            <span className="ko-phase">{phaseLabel(latestPlan.phase)}</span>
            <h3>{latestPlan.approach}</h3>
            <details><summary>{t('plan.details')}</summary>
              <p>{latestPlan.approach}</p>
              {latestPlan.hypothesis !== undefined ? <p>{latestPlan.hypothesis}</p> : null}
              {latestPlan.next !== undefined ? <p>{t('plan.next')} · {latestPlan.next}</p> : null}
            </details>
            {plans.length > 1 ? <>
              <button type="button" className="ko-text-button" aria-expanded={planHistory} onClick={() => { setPlanHistory(value => !value) }}>
                {planHistory ? t('plan.hide') : t('plan.history', { n: plans.length - 1 })}
              </button>
              {planHistory ? <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
                {plans.slice(0, -1).reverse().map(plan => <div key={plan.seq} className="ko-plan-copy">
                  <span className="ko-phase">{phaseLabel(plan.phase)}</span> {plan.approach}
                  {plan.hypothesis !== undefined ? <p>{plan.hypothesis}</p> : null}
                </div>)}
              </div> : null}
            </> : null}
          </>}
        </section>
        <section className="ko-recent">
          <div className="ko-section-head"><h2>{t('recent.title')}</h2>
            <button type="button" className="ko-text-button" style={{ marginLeft: 'auto' }} onClick={() => { inspectIteration(iterations.length - 1) }}>{t('recent.all')} ↗</button>
          </div>
          <div className="ko-recent-list">
            {iterations.slice(-5).reverse().map((point, i) => {
              const index = iterations.length - 1 - i
              const status = statusOf(point)
              return <button className="ko-recent-row" type="button" key={`${point.seq}-${index}`} onClick={() => { inspectIteration(index) }}>
                <span className="ko-muted">{String(index + 1).padStart(2, '0')}</span>
                <span className="ko-recent-file" title={point.artifactPath}>{point.artifactPath !== undefined ? baseName(point.artifactPath) : point.evaluationId ?? '—'}</span>
                <span>{point.latencyMs !== undefined ? formatLatency(point.latencyMs) : '—'}</span>
                <strong style={{ color: status === 'ok' ? COLOR.curve : COLOR.caption, fontWeight: 500 }}>{point.speedup !== undefined ? `${point.speedup.toPrecision(3)}×` : '—'}</strong>
                <span className="ko-recent-status" style={{ color: STATUS_COLOR[status] }}>{t(`status.${status}`)}</span>
              </button>
            })}
          </div>
        </section>
      </div> : null}

      {!empty ? <button type="button" className="ko-audit-toggle" aria-expanded={auditOpen} onClick={() => { setAuditOpen(value => !value) }}>
        <strong>{auditOpen ? '−' : '+'} {t('audit.title')}</strong><small>{t('audit.hint')}</small>
      </button> : null}

      {/* the machine behind the numbers */}
      {empty || !auditOpen ? null : <EnvCard env={env} t={t} />}

      {/* supervision log — parsed back from the continuation messages, so it
          survives restarts and replays with the rest of the projection. */}
      {auditOpen && (reviewedRounds.length > 0 || earlierReviews > 0 || control?.supervisor.enabled === true)
        ? (
            <div style={cardStyle}>
              <div style={{ fontSize: 'var(--ko-body, 14px)', fontWeight: 600, marginBottom: 8 }}>{t('advice.title')}</div>
              {reviewedRounds.length === 0
                ? <div style={{ fontSize: 'var(--ko-body, 13px)', color: COLOR.caption }}>{t('advice.waiting')}</div>
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
                              style={{ display: 'flex', gap: 8, fontSize: 'var(--ko-body, 13px)', lineHeight: 'var(--ko-line-body, 24px)', cursor: 'pointer' }}
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
                    <div style={{ fontSize: 'var(--ko-small, 12px)', color: COLOR.caption, marginTop: 6 }}>
                      {t('advice.earlier', { n: earlierReviews })}
                    </div>
                  )
                : null}
            </div>
          )
        : null}

      {/* iteration table */}
      {auditOpen && iterations.length > 0
        ? (
            <div ref={auditRef} style={{ ...cardStyle, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '11px 16px', fontSize: 'var(--ko-body, 14px)', fontWeight: 600, borderBottom: `1px solid ${COLOR.border}` }}>
                {t('table.title')}
              </div>
              <div style={{ maxHeight: 420, overflow: 'auto' }}>
                {[...iterations].reverse().map((p) => {
                  const status = statusOf(p)
                  const idx = iterations.indexOf(p)
                  const isBest = series !== null && series.bestIndex === idx
                  const expanded = expandedIdx === idx
                  // A finalized self-reported point without a replay point on
                  // the same artifact: the final number was never re-measured.
                  const unverifiedFinal = p.finalized === true && p.channel === 'shell'
                    && !iterations.some(q => q.channel === 'replay' && q.artifactPath !== undefined
                      && p.artifactPath !== undefined && samePath(q.artifactPath, p.artifactPath))
                  return (
                    <div key={idx} data-iteration={idx}>
                      <div
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '6px 16px', fontSize: 'var(--ko-body, 13px)', lineHeight: 'var(--ko-line-body, 22px)', minWidth: 600,
                          borderBottom: `1px solid ${COLOR.border}`,
                          cursor: 'pointer',
                        }}
                        onClick={() => { setExpandedIdx(expanded ? null : idx) }}
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
                        {phases[idx] === 'wrap-up'
                          ? (
                              <span
                                title={t('tip.wrapup')}
                                style={{
                                  flex: 'none', fontSize: 'var(--ko-small, 11px)', lineHeight: 'var(--ko-line-small, 16px)', padding: '0 6px',
                                  borderRadius: 4, border: `1px solid ${COLOR.border}`, color: COLOR.caption,
                                }}
                              >
                                {t('row.wrapup')}
                              </span>
                            )
                          : null}
                        {phases[idx] === 'over-budget'
                          ? (
                              <span
                                title={t('tip.overBudget')}
                                style={{
                                  flex: 'none', fontSize: 'var(--ko-small, 11px)', lineHeight: 'var(--ko-line-small, 16px)', padding: '0 6px',
                                  borderRadius: 4, border: `1px solid ${COLOR.warn}`, color: COLOR.warn,
                                }}
                              >
                                {t('row.overBudget')}
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
                                  flex: 'none', fontSize: 'var(--ko-small, 11px)', lineHeight: 'var(--ko-line-small, 16px)', padding: '0 6px',
                                  borderRadius: 4, border: `1px solid ${COLOR.border}`,
                                  color: p.channel === 'replay' ? COLOR.ok : COLOR.caption,
                                }}
                              >
                                {t(p.channel === 'replay' ? 'row.channelReplay' : 'row.channelTool')}
                              </span>
                            )
                          : null}
                        {isBest ? <span style={{ flex: 'none', color: COLOR.ok, fontWeight: 500 }} title={t('tip.best')}>{t('row.best')}</span> : null}
                        {p.finalized === true && p.channel !== 'replay'
                          ? <span style={{ flex: 'none', color: COLOR.curve, fontWeight: 500 }} title={t('tip.final')}>{t('table.final')}</span>
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
  props: PropsRuntime<'conversation.input.left'> & PropsLocale<'kernel-opt'> & InjectFace<RunLocaleInjected>,
): ReactNode {
  const { t, getLocale } = props
  const sessionId = props.session.sessionId
  const { control, refetch } = useControl(sessionId)
  const models = useModels()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [placement, setPlacement] = useState<PopoverPlacement | null>(null)
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null)
  const [languageDraft, setLanguageDraft] = useState<'auto' | RunLanguage>('auto')
  const effectiveSupervisor = control?.supervisor.effective
  const modelInfo = useModelInfo(effectiveSupervisor?.provider, effectiveSupervisor?.model)
  useEffect(() => {
    if (!open) return
    const update = (): void => {
      const trigger = triggerRef.current
      if (trigger === null) return
      setPlacement(placePopover(trigger.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight,
      }))
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open])
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
  const currentRunLanguage = runLanguageOf(getLocale())
  const outputLanguage = languageDraft === 'auto' ? currentRunLanguage : languageDraft
  const arm = async (): Promise<void> => {
    const budget = Number(budgetValue)
    await post('loop-arm', {
      ...(Number.isInteger(budget) && budget > 0 ? { budget } : {}),
      outputLanguage,
    })
    setOpen(false)
  }
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={triggerRef}
        type="button"
        style={buttonStyle(COLOR.curve)}
        title={t('ctl.start')}
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          const trigger = triggerRef.current
          if (trigger !== null) {
            setPlacement(placePopover(trigger.getBoundingClientRect(), {
              width: window.innerWidth,
              height: window.innerHeight,
            }))
          }
          setOpen(true)
        }}
      >
        ⟳ {t('ctl.start')}
      </button>
      {open && placement !== null
        ? (
            <>
              {/* Click-away layer: the popover closes like a host menu. */}
              <div style={{ position: 'fixed', inset: 0, zIndex: 40 }} onClick={() => { setOpen(false) }} />
              <div style={{ ...popoverStyle, ...placement }}>
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
                <label style={popoverRowStyle}>
                  <span>{t('pop.language')}</span>
                  <select
                    value={languageDraft}
                    title={t('lang.tip')}
                    style={{ ...selectStyle, maxWidth: 170 }}
                    onChange={(event) => { setLanguageDraft(event.target.value as 'auto' | RunLanguage) }}
                  >
                    <option value="auto">{t('lang.auto', { language: t(`lang.${currentRunLanguage}`) })}</option>
                    <option value="zh">{t('lang.zh')}</option>
                    <option value="en">{t('lang.en')}</option>
                  </select>
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
                <div style={{ fontSize: 'var(--ko-small, 12px)', lineHeight: 'var(--ko-line-small, 18px)', color: COLOR.caption }}>
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
                <div style={popoverRowStyle}>
                  <span>{t('pop.effort')}</span>
                  <SupervisorEffortSelect
                    control={control}
                    info={modelInfo}
                    t={t}
                    onUse={(provider, model, reasoningEffort) => {
                      void post('supervise-use', { provider, model, reasoningEffort })
                    }}
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
                <div style={{ fontSize: 'var(--ko-small, 12px)', lineHeight: 'var(--ko-line-small, 18px)', color: COLOR.caption }}>
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
    <div className="ko-strip" style={{
      boxSizing: 'border-box',
      width: 'calc(100% - var(--dsh-composer-side-clearance, 12px) * 2)',
      maxWidth: 'var(--dsh-composer-card-max-width, 800px)',
      margin: '0 auto',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10,
        padding: '10px 14px', fontSize: 'var(--ko-body, 13px)', fontFamily: 'system-ui',
        border: `1px solid ${COLOR.border}`, borderRadius: 12,
        background: COLOR.tip, color: COLOR.text,
      }}>
        <span style={{
          flex: 'none', width: 7, height: 7, borderRadius: 999,
          background: COLOR.curve, animation: 'kernelOptPulse 1.6s ease-in-out infinite',
        }} />
        <span style={{ color: COLOR.curve, fontWeight: 500 }}>
          {t('rail.running', {
            round: control.loop.round,
            done: Math.min(control.loop.evalsDone, control.loop.budget),
            budget: control.loop.budget,
          })}
        </span>
        {/* The number, on the screen the reader is actually looking at.
            A run takes many minutes, and for almost all of them the
            conversation is what is on screen — the curve lives one tab away.
            Without this the chat says the agent is busy and nothing else,
            and the only evidence that the work is going anywhere is in a
            tab nobody is looking at. */}
        {control.result !== undefined
          ? (
              <span style={{ color: COLOR.ok, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                {t(control.result.finalized ? 'hero.final' : 'hero.running')}
                {' '}
                {control.result.speedup !== undefined
                  ? `×${control.result.speedup.toPrecision(3)}`
                  : formatLatency(control.result.latencyMs)}
              </span>
            )
          : null}
        {control.loop.evalsOverBudget > 0
          ? <span style={{ color: COLOR.warn }}>{t('loop.overBudget', { count: control.loop.evalsOverBudget })}</span>
          : null}
        <span style={{ flex: 1 }} />
        <button type="button" style={buttonStyle(COLOR.bad)} onClick={() => { void stop() }}>
          ■ {t('ctl.stop')}
        </button>
        {control.loop.budget > 0 ? <progress className="ko-progress" max={control.loop.budget} value={Math.min(control.loop.evalsDone, control.loop.budget)} aria-label={t('stats.evals')} /> : null}
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
  const runLocale = (): RunLocaleInjected => ({ getLocale: () => ctx.locale.getSnapshot().active })
  installPanelStyles()
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
          inject: runLocale,
        }, KernelOptTab),
        ctx.slots.register({
          name: 'conversation.input.left', id: 'kernel-opt-loop', order: 50, locale: NS, inject: runLocale,
        }, ChatLoopButton),
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
