---
name: kernel-opt
description: Protocol for long kernel-optimization runs under the kernel-opt plugin — inventory the materials, assemble your own evaluation entry that prints the contract trailer, iterate freely with checkpoint commits, finalize honestly. The panel derives everything from the session log.
---

# kernel-opt 优化协议

本 skill 配合 `dsh-kernel-opt` 插件使用。面板、循环、监督全部从**会话日志**派生——你不需要为它们做任何额外记录。协议只有四段：起步盘点、评测入口、自由迭代、诚实收尾。

## 0. 起步：盘点材料，报告 Resolved Plan

用户会以**任意形式**提供材料。自己浏览工作区（不要跑固定清单），识别出：

> **红线**：任务可以来自对话，也可以是用户放进**工作目录**的文件（prompt/任务说明就算任务）。两者都没有时，停下来问，等用户回答。工作目录**之外**的东西——邻居目录里的旧 run、别的会话留下的文件——**不是你的任务**，永远不要从那里"考古"出一个任务自行开工。

- **kernel**（必需）——要优化的代码，文件或目录，语言不限；
- **reference**（可选）——正确性金标准 + 加速比分母；**用户没给就以拿到手的原始 kernel 为准**：动手之前先把它原样复制到 `solution/` 之外的一个固定位置（比如 `baseline/kernel.py`），`--ref` 指那份冻结的副本。永远不要把 `--ref` 指向你正在改的文件。「比起点快 2.4 倍」是能核的说法，光一个裸延迟不是；
- **输入数据**（可选）——硬编码、独立文件、`.npz`/`.bin` 裸数据都行，你自己接线；
- **评测脚本**（可选）——用户自己的 bench；读懂它、包装它，**不要改它的 trial 数/参考处理**（那是用户的契约；快迭代开关只用用户暴露的，没有就问）；
- **硬件信息 / knowledge / hints**（可选）。

**手里有 kernel 但没有评测手段时**，用插件自带的评测器：把 `~/.dsh/.agent-presets/kernel-opt/evaluator/bench.py` 复制进工作区，把材料组装成 `Model`/`get_inputs()` 即可用（正确性 + median 计时 + fresh 输入 + mutation sentinel 反作弊；组装模式见同目录 GUIDE.md）。它来自公开的 [AKO4ALL](https://github.com/TongmingLAIC/AKO4ALL)——只有自带副本不在时才去 GitHub 装。**对用户统一称"内置评测器"**：面向用户的文字（提问选项、方案复述、总结）里不要出现 AKO / AKO4ALL 这类工具包名，用户不认识它们。评测器只回答"怎么评测"，不回答"优化什么"——没有任务时，不要把"跑个公开 kernel 试试"当作选项提给用户，直接问任务就好。

盘点完成后，先调 `kernel_plan`（phase=explore，approach 写一句 resolved plan），并在第一次评测前调 `kernel_env` 汇报**评测实际发生的机器**——运行位置、计时所用设备、决定该设备的用户指令（如「只许用 CPU」）、关键工具链版本、以及你读到这些事实所用的命令。注意汇报的是 benchmark 执行的那台机器：用户把你指向远程机 / 集群节点 / 云端 runner 时，那台才是要写进去的；事实要读出来，不要臆断；环境变了就再调一次。再用一小段文字向用户复述你认定的各项（kernel 路径 / 评测方式 / 预算），**只在真有歧义时才提问**——复述是为了让用户能在你没想到要问的地方纠正你。

## 1. 评测入口：你自己组装，末尾打一行契约

评测怎么跑由你定（推荐包一个 `scripts/bench.sh`）。**唯一硬性要求**：每完成一次真实评测，stdout 上要有一行契约（行首，一行一个评测）。用内置评测器时这行由它自己打，你什么都不用做——**别再手写第二行**；包别人的评测器、或自己写评测时，才由你来打：

```
KERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":1.23,"correct":true}
```

| 字段 | 必需 | 含义 |
|---|---|---|
| `artifact` | ✅ | 本次测的是哪个文件（路径） |
| `correct` | ✅ | 正确性判定（未验证就写 `false`） |
| `latency_ms` | 测得就写 | 延迟毫秒数 |
| `compiled` / `error` | 可选 | 编译结果 / 失败信息 |
| `speedup` / `ref_runtime_ms` | 测了就写 | 分母。面板的加速比列与曲线纵轴都靠它；写进 `native_metrics` 或与 `latency_ms` 并排都认，前者优先 |
| `native_metrics` | 测了就写 | 其余数值映射（profile 出来的数写这儿） |
| `reward_hack_detected` / `workload_indices` | 可选 | 评测器的反作弊标记 / 子集评测 |

规矩：

- **profile 出来的数就写进 `native_metrics`**（occupancy、实测带宽及其占峰值比例、cache 命中率、每 block 寄存器/共享内存……）。延迟说不出「为什么慢」，判断还有多少余量靠的是这些数；profile 完只留在自己上下文里、只报一个延迟，等于把证据扔了；
- **每次评测都要把分母写进契约行**（`speedup` 或 `ref_runtime_ms`）。评测器算出来的数不转述，丢的不只是一列加速比：面板靠这些比值反推出**一个统一分母**去抵消"每次评测各自重测参考"的抖动，分母一漏，整轮的可比性跟着丢。实测一轮 13 个容器的远程 run，同一份没改过的 kernel 自报 ×35.5／×46.3／×53.2／×35.5，统一分母后是 ×34.9／×35.5／×34.9／×35.5。**用内置评测器时你不用管**：它自己打这行契约（连 speedup 一起），你再手写一行就会把同一次评测记成两个点；
- **bench 前台后台都收**：后台 job 的契约行会经 `started background job <id>` 追回启动命令，同 job 内按契约行去重。远程/慢评测该开后台就开。唯一别做的是**用回读伪造契约行**——`cat bench.log`、`grep KERNEL_EVAL out.txt` 这类纯读取命令不计点，因为它们不是一次评测；
- 包装脚本**env 自包含**（conda activate / PATH export 写进脚本里）——这同时是 finalize 复测能成功的前提；
- 契约行**只能由真实评测产生**。`echo`/`cat` 出一行契约=伪造：面板给每个点标注产生它的命令行，监督模型会审这些命令行，人类看得见;
- 有 MCP/注册工具评测器时不用契约行——工具结果 JSON 直接进面板（同样字段，走 `benchTools` 配置），且不可伪造。

## 2. 迭代：自由，但有三个 checkpoint

改 kernel → 评测 → 看结果 → 再改。不用写迭代日志、不用逐轮 commit——日志和面板就是记录。目录结构自便，多变体并行（`experiments/candidate-A/B/`）也行：面板按 `artifact` 逐点记录，各变体曲线自然分开。

**git checkpoint 三时机**（`git commit`，不必更频繁）：出现新的最佳结果时；换方法族时；finalize 时。commit 是 artifact 检查点（回滚/对比），不是日志。

**每次评测都要有加速比**。reference 在整轮优化里是不变的，所以它只该被计时**一次**：内置评测器把这个数冻在 `--baseline`（默认 `.bench-baseline.json`）里，之后每次评测直接读回来——省掉的正是"reference 很贵"要省的那部分开销，而 `SPEEDUP` 照常有。别再为了快而放弃分母。这样还顺带修掉一件事：分母每次重测就会自带抖动（同一份没动过的 reference 在一台 A100 上量出 2.14 / 2.06 / 2.03 ms），足以让 453µs 报 ×3.60、454µs 报 ×3.61 —— 冻住之后加速比严格随 solution 自身延迟单调。机器可能漂了（降频、邻居抢卡）才用 `--refresh-baseline`，且**换了分母之后前后两段就不可比**，要在下一次汇报里说出来。用户自带的评测脚本另说：trial 数和参考处理是用户的契约，别去改。

**停滞**：循环续跑消息会带"距上次改进已 N 评"的计数。要不要重新 profile、换方法族、上网查，你自己判断——没有固定门槛。同样，**不要为改写而改写**：带宽顶限的 elementwise op 该做的可能是调度而不是重写；改动半径跟着 headroom 证据走。

**kernel_env**：第一次评测前调一次，环境变了再调——面板据此告诉人类这些数字是在哪台机器、什么设备上测的。**kernel_plan**：开始新方案（新结构/新 tiling/新方法族）前调一次，变了再调。`phase=stuck` 是显式请求人类引导的信号。**self_compact**：换方法族、旧调试细节不再有用时调（带 `reason` 说明什么必须存活）；评测进行中或刚拿到要逐行分析的 profile 时不要压。

## 3. 收尾：最优 artifact 原样恢复 → 全量 verdict → finalize

最优版本经常不是最后版本。结束时：

1. 从 git **原样恢复**最优 iter 的 artifact（`git checkout <sha> -- <path>`，绝不凭记忆重写）；
2. 跑一次**全量 verdict**（完整 trial 数、真实 reference）；
3. finalize：评测器发 id 的（如 `run_finalize`）用它的 id；否则调 `kernel_finalize` 传 `artifact_path`——插件会把该 artifact 最优点的记录命令**重放一次**，重放输出里的契约行成为"复测"级最终数字（这就是包装脚本要 env 自包含的原因）；
4. 总结：最佳结果、什么有效、什么无效、下次先试什么。

## 4. 诚实红线

- 评测数字以真实执行输出为准；不在 plan/总结里声称未测得的加速比。
- 伪造契约行（echo/cat/手写）是伪造实验数据，没有任何理由可以做。
- `reward_hack_detected` 出现时当作方法失败并换方向，不要绕检测器；`correct: false` 的低延迟不是进展。
- 不要对着 finalize 复测做特化（比如检测复测环境走捷径）——复测就是要在你之外再测一次。
