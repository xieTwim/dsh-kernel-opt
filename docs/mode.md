# 算子优化模式

装上插件后（部署组合了 `agentPresets` 时），Node 半会把一个「算子优化模式」preset 写进用户 preset 根（`~/.dsh/.agent-presets/kernel-opt/`），并在之后的每次启动**让它跟上插件版本**。

新建会话选这个模式即可。

## persona 是协议的唯一来源

约 9.2 KB，全部规矩都在里面：盘点材料 → `kernel_plan` 报 resolved plan → 组装评测入口（契约行）→ 自由迭代 → 诚实收尾，连同分母冻结、别改用户的 bench、内置评测器自己打契约行等具体条款。

**你只需要在第一条消息里给三样：**

1. kernel 在哪
2. 怎么评测（或让它用内置评测器）
3. 预算／卡信息

该模式的会话「评测」Tab **常显示**（不等第一次评测）。

## 这个模式独有的操纵杆

**四个工具与两条命令只在「算子优化模式」的会话里存在**，不在插件的 profile 层注册。别的 preset 的会话既用不了，也看不到它们喂的面板。

理由是成本：工具描述是每轮都在的上下文，命令则会出现在每个会话的斜杠菜单里——无关会话不该为它们付账。

| 组成 | 说明 |
|---|---|
| `kernel_plan` 工具 | 模型汇报 phase／approach／hypothesis／next；调用本身即记录 |
| `kernel_env` 工具 | 模型汇报**评测跑在哪**（主机／设备／约束／版本／探测命令）；跑分的机器不一定是插件所在的机器 |
| `kernel_finalize` 工具 | 无 id 评测管线的收尾记录（按 `artifact_path`）+ [finalize 复测](eval-contract.md#finalize-复测verify-the-verdict-not-the-signal) |
| `self_compact` 工具 | 包装官方 `compaction` seam，模型换方案族时可自行压缩上下文继续干 |
| `/kloop [预算]` 命令 | 见 [`loop.md`](loop.md) |
| `/supervise on\|off` 命令 | 见 [`loop.md`](loop.md) |

## 「评测」Tab 里有什么

`conversation.view` 槽，**按需出现**：算子优化模式的会话常显示；其余会话检测到评测／plan／循环 armed 才持有注册。

- **SVG 曲线**——**纵轴越高越快**：绘制量是 1/延迟，标注在本 run 报出过加速比时读作 ×、否则读作延迟；y 域聚焦收敛带，慢的离群点底边截断，hover 给该次评测的原始延迟与它自己报的 ×
- **标记**：profile ▲、当前最优 ★（并列时保留先出现的那个）、finalize ⚑
- 状态芯片与**循环／监督控件**
- 当前方案卡
- 监督记录卡
- **可展开迭代表**：评测完整判定、来源命令行、生效方案、该轮监督、该轮 write/edit 改动

## 内置评测器

没有评测手段时用插件自带的评测器，随模式落盘在 `~/.dsh/.agent-presets/kernel-opt/evaluator/`（`bench.py` + `GUIDE.md`），开箱即用：

- 正确性检查
- median 计时
- fresh 输入
- mutation sentinel 反作弊
- **参考实现只计时一次后冻结**——因此每次评测都带加速比，且加速比随延迟单调

源自公开的 [AKO4ALL](https://github.com/TongmingLAIC/AKO4ALL)，见仓库根的 `THIRD_PARTY_NOTICES.md`。

## 落盘的所有权跟踪

preset 是 rc.6 standard 的衍生（全套编码工具，只换 persona），并附带 `evaluator/`。落盘**逐文件同步**：

- 不存在的补种
- **插件写下、你没动过的会跟着插件更新**
- 你改过的原样保留（并在宿主日志里点名，删掉它即可换回插件版本）

清单记在该目录下的 `.dsh-kernel-opt-files.json`，记的始终是「插件上次写下的哈希」，所以你改过的文件此后一直算你的。

**早于该机制的目录**（清单还不存在）分不清「你改过的」和「旧版残留」：那次同步会把差异文件备份成 `*.bak-<时间戳>` 再更新，什么都不丢，此后走上面的干净规则。

这条是必须的——此前「已存在的文件永不覆盖」意味着插件升级后磁盘上的 `bench.py` 永远停在首次安装那版，而插件本体已经在按新版行为工作，工具和它自己的说明静默地各说各话。

## 关掉或改名

| config | 效果 |
|---|---|
| `preset.install: false` | 关闭自动落盘 |
| `preset.id` | 换落盘目录／id。Tab 常显示的判定只认默认 id，改 id 后回退到信号检测 |

## 人类怎么引导

DSH 原生支持运行中插话（steering）：模型在跑时直接在输入框打字，消息会插进它的下一步。

配合面板：

- 看到方案卡不对 → 立刻说
- 看到 `phase=stuck` → 模型在显式请求引导
- 看到自报点的命令行可疑 → 问它
