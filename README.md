# dsh-kernel-opt

**DSH 算子优化插件**：模型在长优化循环里跑，人类在会话页的「评测」Tab 实时看到 **latency 曲线、每个点的正确性/reward-hack 状态与来源、profile ▲、首达最佳 ★ 与 finalize ⚑ 标记、模型当前方案、监督记录**，并可随时插话引导（原生 steering）；模型自己可以在换方案族时压缩上下文继续干（`self_compact`）。

数据全部从**会话日志**投影派生（零插件侧状态），回放的会话渲染结果与实时完全一致。

## 评测契约：面板不认识任何 benchmark

插件不内置、也不适配任何评测逻辑。任何评测管线——你自己的脚本、现成评测器、远程执行——只要让结果以下面两种形态之一出现在会话日志里，就会变成曲线上的一个点：

**① 契约行（自带评测的默认路径）。** 评测脚本在结束时向 stdout 打印一行：

```
KERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":1.23,"correct":true}
```

模型经 `bash` 跑它，面板从 shell 结果里解析这一行。必需字段只有 `artifact`（测的是哪个文件）和 `correct`；测得延迟时给 `latency_ms`；可选 `compiled` / `error` / `native_metrics`（数值映射，`speedup` 或 `ref_runtime_ms` 会成为加速比列）/ `reward_hack_detected` / `workload_indices`。一行一个评测，行首开始，行内 JSON 后可跟杂质。

**② 工具结果 JSON（MCP / 注册工具评测器）。** 评测器作为工具存在时（任何名字含 `kernel_evaluate` 的工具默认命中，可配），其 result 文本里的同字段 JSON 直接进面板。

两条通道同时在线、可混用。区别是**信任级**，面板明牌标注：

| 来源 | 徽标 | 可信度 |
|---|---|---|
| 工具结果 | （无） | 模型伪造不了——由工具产生 |
| 契约行 | `自报` | 模型可控的 stdout——每个点展示**产生它的命令行**，一眼可辨 `echo` 出来的假点；监督模型的 digest 里同样带命令行 |
| finalize 复测 | `复测` | 插件自己重放命令得到——非模型转述 |

**finalize 复测（verify the verdict, not the signal）**：模型调 `kernel_finalize {artifact_path}` 收尾时，若该 artifact 的最优测量来自自报级，插件在 agent 回合之外把记录过的那条命令**重放一次**，输出附在工具结果里——其中的契约行成为"复测"级最终数字。轨迹是自报的，**最终数字是复测的**。复测失败/关闭时面板标注"最终数字未复测"。

| 组成 | 说明 |
|---|---|
| 「评测」会话 Tab | `conversation.view` 槽，**按需出现**：算子优化模式的会话常显示；其余会话检测到评测/plan/循环 armed 才持有注册。内容：SVG 曲线（y 域聚焦收敛带，离群点顶边截断，hover 精确值）+ 状态芯片与**循环/监督控件** + 当前方案卡 + 监督记录卡 + **可展开迭代表**（评测完整判定、来源命令行、生效方案、该轮监督、该轮 write/edit 改动） |
| `kernel_plan` 工具 | 模型汇报 phase/approach/hypothesis/next；调用本身即记录 |
| `kernel_finalize` 工具 | 无 id 评测管线的收尾记录（按 `artifact_path`）+ 上述复测 |
| `self_compact` 工具 | 包装官方 `compaction` seam；仅当组合里有 compaction provider 时注册 |
| `/kloop [预算]` 命令 | **kernel 优化循环**：按 run 状态驱动的续跑——turn 落定且预算未尽、未 finalize、上轮有进展才续投；续投消息带停滞计数；预算耗尽/停滞先投**收尾轮**再停 |
| `/supervise on\|off` 命令 | **第二模型监督**：每个续跑点复审 run digest（含每点来源命令行），建议随续投消息注入；失败降级为无建议 |
| series / control / models 路由 | `GET …/series?sessionId=` 即时投影；`POST …/control` 驱动与 slash 命令同一份循环/监督状态（含 `supervise-use` 会话级换监督模型）；`GET …/models` 供面板选择器枚举 provider/model |
| `skills/kernel-opt` | 优化协议（盘点→组装评测入口→自由迭代→诚实收尾），可选装 |

## 快速上手（自带 kernel）

1. 安装插件（见下），重启 `dsh web`；
2. 把要优化的 kernel 丢进工作目录——reference / 输入数据 / 你自己的评测脚本都可选，**任意形式**，模型自己盘点组装；没有评测手段就装公开的 [AKO4ALL](https://github.com/TongmingLAIC/AKO4ALL)，其内置评测器（正确性 + median 计时 + mutation sentinel 反作弊）开箱即用；
3. 对模型说"优化这个 kernel"（建议配合 skill），或直接 `/kloop 30` 交给循环；
4. 会话页顶部出现「评测」Tab——曲线、状态、方案、监督，全在里面；想引导随时打字。

GPU 在评测命令跑的地方——本机、容器、远程提交都行，插件不关心。

## 算子优化模式（agent preset 自动落盘）

装上插件后（部署组合了 `agentPresets` 时），Node 半会把一个「算子优化模式」preset 写进用户 preset 根（`~/.dsh/.agent-presets/kernel-opt/`，**仅当不存在时**；想重置就删掉该目录再重启）。新建会话选这个模式：

- persona 就是任务书的通用半：盘点材料 → `kernel_plan` 报 resolved plan → 组装评测入口（契约行）→ 自由迭代 → 诚实收尾。你只需要在第一条消息里给三样：**kernel 在哪、怎么评测（或让它用 AKO4ALL 内置评测器）、预算/卡信息**；
- 该模式的会话「评测」Tab **常显示**（不等第一次评测）；
- preset 是 rc.6 standard 的衍生（全套编码工具，只换 persona），落盘后想改就直接改——插件永不覆盖已存在的副本；
- 关闭自动落盘：config `preset.install: false`；换 id：`preset.id`（Tab 常显示判定只认默认 id，改 id 后回退到信号检测）。

## 循环与监督

```sh
/kloop            # 启动循环,默认预算 20 次评测(/kloop 30 自定义)
/kloop stop       # 停;/kloop status 查看
/supervise on     # 开启第二模型监督(需先有监督模型:配置或当场指定,见下)
/supervise use deepseek-official/deepseek-v4-flash   # 本会话换监督模型
/supervise use default                               # 回到配置默认
```

也可以全程不打命令：评测页顶部分两行——**循环行**（循环次数 + 启动/停止）与**监督行**（外部监督开关 + 监督模型下拉，默认项直接显示配置的模型名）——与 slash 命令驱动同一份状态；**对话页**也有双态入口——未启动时 composer 工具行里有一个「⟳ 启动循环」触发器，点开是 DSH 菜单样式的**启动卡**（预算 / 监督开关 / 监督模型 / 启动，底部提示曲线在评测页），循环中 composer 上方出现**状态条**（轮次/预算进度 + 停止按钮），停止即消失。

**空会话也能直接启动**：任务不一定来自对话——用户常把 prompt/任务说明放在工作目录里。会话里还没有任务时，循环的第一条驱动消息不说"继续原任务"，而是明确指示：**盘点工作目录找用户准备的任务文件；工作目录里也没有就问用户并停下，绝不把工作目录之外的东西当任务**（persona 与 skill 同款红线，封死从邻居目录"考古"旧任务的路径）。

循环在每次 turn 落定后检查投影出的 run 状态：**finalize 已记录 → 停；评测数达预算或连续 2 轮零新评测 → 先投一条收尾消息（要求原样恢复最优 artifact、finalize 最好的诚实结果并总结），随即 disarm**——预算耗尽永远是干净的收束，不是静默断电；`/kloop stop` 与面板/状态条的停止按钮是人类决定，**立即 disarm 并中止在跑的轮次**（排队中的人类消息保留），不投收尾。**人类在对话框手动终止回合（turn 以 aborted 收场）同样立即解除循环**——人的停止永远压过机器的续跑，想继续就重新启动。否则投递续跑消息（预算进度 + 停滞计数 + 监督结果）。人类插话永远优先：agent 非 idle 时本轮跳过，监督复审后还会二次确认 idle 与 armed 才续投。预算按**已完成评测数**计——单个 turn 内连评多次可能小幅超支，turn 结束即被截住。

**监督记录是从会话日志解析回来的**：每轮续投消息里的建议块（或 OK 行）由投影按固定锚点解析成 `rounds`，面板的「监督记录」卡与迭代表展开里的"该轮监督"都来自它——重启、回放后依然完整。

**监督模型两层解析**：面板下拉/`/supervise use` 的**会话级覆盖** > 插件 config 默认。下拉选项来自 models 路由（`llm.listProviders()`/`listModels()`，发现失败的 provider 仍列出、模型手填走 `/supervise use`）；覆盖只换路由，temperature/maxTokens 等复审纪律仍随 config。没配 config 也可以：下拉选一个（或 `/supervise use`）后 `/supervise on` 即可用。config 写法（`~/.dsh/cordis.patch.yml` 的插件行，或 profile patch）：

```yaml
- id: kernel-opt
  config:
    supervisor:
      provider: deepseek-official   # Models 设置里的 provider 路由
      model: deepseek-v4-flash      # 建议与主模型不同档,便宜的就够
```

监督者只看 run 的**形状与来源**（预算纪律/正确性优先/方法族多样性/plan 卫生/每个自报点的命令行像不像真实评测/该收尾时收尾），不看 kernel 源码；回复 OK 则不注入；任何失败/超时降级为无建议，永不卡住主循环。

## 安装

构建产物随仓库分发（`lib/` 已提交），安装免构建：

```sh
dsh plugin --profile web add /path/to/dsh-kernel-opt   # 本地目录
# 或 git 源(pin commit;私有仓库需本机 git 具备访问权):
dsh plugin --profile web add "github:xieTwim/dsh-kernel-opt#<sha>"
```

重启 `dsh web` 生效。验证：

```sh
dsh --profile web --dump-config | grep kernel-opt   # 应出现 bundle 层
# 在有评测/plan/循环信号的会话里,顶部视图切换出现「评测」(无关会话不显示 Tab)
```

## 配置（cordis.patch.yml 或设置页）

| key | 默认 | 说明 |
|---|---|---|
| `benchTools` | `['kernel_evaluate']` | 计入曲线的评测**工具**名（精确或分隔符后缀匹配，MCP 前缀自动覆盖） |
| `shellTools` | `['bash']` | 扫描契约行的 shell 工具名（自报通道；后台 job 读取器不默认收——轮询重复读会复制契约行） |
| `profileTools` | `['kernel_profile']` | 记为 ▲ 标记的 profiler 工具名 |
| `finalizeTools` | `['run_finalize', 'kernel_finalize']` | finalize 工具名：`evaluation_id` 参数把对应点标 ⚑，`artifact_path` 参数把该 artifact 最优诚实点标 ⚑ |
| `changeTools` | `['write', 'edit']` | 计为"该轮改动"的结构化文件工具名，与评测的 artifact 匹配后挂到该行 |
| `replay.enabled` | `true` | finalize 复测开关 |
| `replay.timeoutSec` | `900` | 复测命令超时（秒） |
| `preset.install` | `true` | 「算子优化模式」preset 自动落盘开关 |
| `preset.id` | `kernel-opt` | preset 落盘目录/id（改动后 Tab 常显示回退为信号检测） |
| `loop.defaultBudget` | `20` | `/kloop` 不带数字时的预算 |
| `supervisor.*` | 无 | 见「循环与监督」 |

工具结果 JSON 与契约行共享字段语义：`evaluation_id`（仅工具通道；自报通道身份=日志 seq，模型转述的 id 不作身份）/ `compiled` / `correct` / `latency_ms` / `native_metrics` / `reward_hack_detected` / `error`。`correct !== true`、reward-hack、error 的点**永不参与 best**。

## 人类怎么引导

DSH 原生支持运行中插话（steering）：模型在跑时直接在输入框打字，消息会插进它的下一步。配合面板：看到方案卡不对 → 立刻说；看到 `phase=stuck` → 模型在显式请求引导；看到自报点的命令行可疑 → 问它。

## 开发

```sh
pnpm install
pnpm run check        # typecheck(host+client)+ 单测 + 双 half 构建
```

类型直接来自 npm 的 `@deepseek-ai/*` 包（devDependencies，`pnpm install` 后即可 typecheck；需要读实现时看公开仓库 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）。客户端 external 只允许 loader 平台模块表条目（`PLATFORM_MODULES` + runtime exemption），与官方 `tsdown.client.ts` 合同一致。

## 兼容基线

`@deepseek-ai/dsh` **0.1.0-rc.6**（2026-08-13 公开发布构建，npm dist-tag `latest`）。使用 `ctx.webServer` / `ctx.compaction` / `sessionId` 标准 prop，不兼容 2026-08-11 改名（`httpServer→webServer`、`compact→compaction`）之前的版本；peer 范围声明为 `>=0.1.0-rc.2 <0.2`。

## 已知边界

- 面板只覆盖**内存中的会话**（`ctx.sessions`）：dsh 重启后旧会话在被重新载入前查不到序列。
- 契约行按"行首前缀"识别：`cat` 一个**整行包含**契约的文件会产生幻影点（面板会显示其来源命令是 `cat …`，一眼可辨）；文档里引用契约时写在句中即可避免。自报通道的点由 agent 转述，**可被伪造**——防线是来源命令行明牌 + 监督 + finalize 复测，不是不可伪造性。
- 后台 bench（`run_in_background`）的输出不被扫描——前台跑评测。
- finalize 复测以**会话工作目录**为 cwd、以 dsh 服务进程 env 运行：包装脚本 env 自包含（skill 有要求）时可靠；命令超过 300 字符会因投影截断而跳过复测（面板如实标注"未复测"）。
- 评测结果必须能按上述两种形态之一解析；纯文本工具结果显示为"未测得"行。
- `self_compact` 的压缩范围由官方 compaction backend 决定。
- Tab 的按需出现由 client watcher 轮询判定（会话切换/首个信号后 ≤3s 出现）。
- kernel 源码本体不进面板（结构化 `write`/`edit` 改动在展开行里可见；完整源码在你的工作区与 git 历史里）。
- **信任链以会话日志完整性为前提**：它成立靠"写权限限制在 workspace 内 + 日志存放在 workspace 外"这对组合。若把会话 workspace 圈到 `~/.dsh` 或其上层（agent 因而能改写自己的日志），来源/复测的一切结论不再适用。
