# dsh-kernel-cockpit

**算子优化驾驶舱** — DeepSeek Harness 插件:模型在长优化循环里跑,人类在会话页的「算子优化」Tab 实时看到 **latency 曲线、每个点的正确性/reward-hack 状态、profile ▲、首达最佳 ★ 与 finalize ⚑ 标记、模型当前方案**,并可随时插话引导(原生 steering);模型自己可以在换方案族时压缩上下文继续干(`self_compact`)。

数据全部从**会话日志**投影派生(零插件侧状态):兼容任何把评测结果以 JSON 写进 tool result 的 bench 工具,默认对准 [AKO Runtime](../ako-runtime) 的 MCP 工具(`kernel_evaluate` / `kernel_profile` / `run_finalize`)。回放的会话渲染结果与实时完全一致。

| 组成 | 说明 |
|---|---|
| 「算子优化」会话 Tab | `conversation.view` 槽;SVG 曲线(跨度大时自动 log 轴)+ 状态芯片 + 当前方案卡 + 监督建议卡 + 迭代表 |
| `cockpit_plan` 工具 | 模型汇报 phase/approach/hypothesis/next;调用本身即记录 |
| `self_compact` 工具 | 包装官方 `compaction` seam(`compactNow`);仅当组合里有 compaction provider 时注册 |
| `/kloop [预算]` 命令 | **kernel 优化循环**:按 run 状态驱动的续跑(不是定时器)——turn 落定且预算未尽、未 finalize、上轮有进展才续投;`stop`/`status` 子命令 |
| `/supervise on\|off` 命令 | **第二模型监督**(按需开启):每个续跑点用配置的 provider/model 复审 run digest,建议随续投消息注入主模型 |
| series 路由 | `GET /plugins/kernel-cockpit/series?sessionId=` — 每次查询即时投影 `session.events`(含 loop/监督状态) |
| `skills/kernel-cockpit` | 循环纪律(何时 plan / 何时 compact / 诚实红线),可选装 |

## 循环与监督

```sh
/kloop            # 启动循环,默认预算 20 次评测(/kloop 30 自定义)
/kloop stop       # 停;/kloop status 查看
/supervise on     # 开启第二模型监督(需先配置,见下)
```

循环在每次 turn 落定后检查投影出的 run 状态:**finalize 已记录 → 停;评测数达预算 → 停;连续 2 轮零新评测 → 停(防空转烧 token)**;否则投递续跑消息(带预算进度 + 监督建议)。人类插话永远优先:agent 非 idle 时本轮跳过,监督复审后还会二次确认 idle 才续投。

监督模型是硬门槛配置(`~/.dsh/cordis.patch.yml` 的插件行,或 profile patch):

```yaml
- id: kernel-cockpit
  config:
    supervisor:
      provider: deepseek-official   # Models 设置里的 provider 路由
      model: deepseek-v4-flash      # 建议与主模型不同档,便宜的就够
```

监督者只看 run 的**形状**(预算纪律/正确性优先/方法族多样性/plan 卫生/该收尾时收尾),不看 kernel 源码;回复 OK 则不注入;任何失败/超时降级为无建议,永不卡住主循环。

## 安装

构建产物随仓库分发(`lib/` 已提交),安装免构建:

```sh
dsh plugin --profile web add /path/to/dsh-kernel-cockpit   # 本地目录
# 或 git 源(pin commit):
dsh plugin --profile web add "github:<owner>/dsh-kernel-cockpit#<sha>"
```

重启 `dsh web` 生效。验证:

```sh
dsh --profile web --dump-config | grep kernel-cockpit   # 应出现 bundle 层
# 打开任意会话 → 顶部视图切换出现「算子优化」
```

## 配置(cordis.patch.yml 或设置页)

| key | 默认 | 说明 |
|---|---|---|
| `benchTools` | `['kernel_evaluate']` | 计入曲线的评测工具名(精确或分隔符后缀匹配,MCP 前缀自动覆盖) |
| `profileTools` | `['kernel_profile']` | 记为 ▲ 标记的 profiler 工具名 |
| `finalizeTools` | `['run_finalize']` | 其 `evaluation_id` 参数把对应点标 ⚑(★ 恒为首次达到最佳的点) |

评测结果解析字段(JSON,取自 tool result 文本):`evaluation_id` / `compiled` / `correct` / `latency_ms` / `native_metrics`(数值项)/ `reward_hack_detected` / `error`。`correct !== true`、reward-hack、error 的点**永不参与 best**。

## 人类怎么引导

DSH 原生支持运行中插话(steering):模型在跑时直接在输入框打字,消息会插进它的下一步。配合面板:看到方案卡不对 → 立刻说;看到 `phase=stuck` → 模型在显式请求引导。

## 开发

```sh
pnpm install
pnpm run check        # typecheck(host+client)+ 投影单测 + 双 half 构建
```

类型解析走同目录 DSH 快照的 `lib/types`(见 tsconfig `paths`;先在快照仓库 `pnpm install && pnpm run build`)。客户端 external 只允许 loader 平台模块表条目(`PLATFORM_MODULES` + runtime exemption),与官方 `tsdown.client.ts` 合同一致。

## 兼容基线

rc.2(snapshot `20260812T172954Z`):使用 `ctx.webServer` / `ctx.compaction` / `sessionId` 标准 prop。不兼容 0811 改名前的快照。

## 已知边界

- 面板只覆盖**内存中的会话**(`ctx.sessions`):dsh 重启后旧会话在被重新载入前查不到序列。
- 评测结果必须是 tool result 文本里可解析出的 JSON 对象;纯文本结果会显示为"未测得"行。
- `self_compact` 的压缩范围由官方 compaction backend 决定(保留尾部策略等均为 backend 配置)。
