<h1 align="center">dsh-kernel-opt</h1>
<p align="center"><b>在 DeepSeek Harness 里，实时看着模型把一个算子调快</b></p>
<p align="center">简体中文 | <a href="README.en.md">English</a></p>

<p align="center">
  <a href="https://github.com/xieTwim/dsh-kernel-opt/actions/workflows/ci.yml"><img src="https://github.com/xieTwim/dsh-kernel-opt/actions/workflows/ci.yml/badge.svg" alt="check"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="License: MIT"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DSH-0.1.0--rc.6-blue?logo=github" alt="DSH 0.1.0-rc.6"></a>
</p>

<p align="center"><b>觉得有用的话，欢迎点个 star 🌟</b></p>

<p align="center">
  <img src="assets/panel.png" width="820" alt="一轮跑完的「评测」页签，硬件是单卡 NVIDIA B200：上方是打开了监督的运行控制，下方的加速比曲线在 12 次优化评测里从 ×1.00 爬到 ×22.1，三次失败画在坐标轴下方，最优点带着 ★ 与 ⚑，运行控制那一行写着循环因监督确认无余量而收尾。" />
  <br/>
  <i>RoPE <code>(4, 32, 4096, 128)</code> fp16，单卡 NVIDIA B200 —— 12 次评测从 ×1.00 爬到 ×22.1，全程除以冻结在 1.0400 ms 的同一个参考耗时；3 次失败照实画出来，没有藏；最终那个数是插件自己复测的：47.3 µs，对上这轮自报的 47.1 µs。</i>
</p>

## News

- 🚀 **[2026.08.17]** **dsh-kernel-opt 开源发布** —— 实时评测面板、跑到预算就自己收尾的优化循环，以及可选的第二模型监督。

**目录**

- [这是什么](#这是什么)
- [安装](#安装)
- [快速开始](#快速开始)
- [接入你自己的评测](#接入你自己的评测)
- [循环](#循环)
- [文档](#文档)
- [兼容性](#兼容性)
- [许可](#许可)
- [致谢](#致谢)

## 这是什么

**dsh-kernel-opt 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件，把一次漫长的算子优化过程，变成人看得见、也随时插得上手的东西。**

模型在那儿一轮轮地读、改、测，同一个会话里多出一个**「评测」页签**，实时显示：加速比曲线（越高越快）、每个点的正确性与 reward hack 状态、**每个数从哪来、能信到什么程度**、profile ▲ ／当前最优 ★ ／收尾 ⚑ 三种标记、模型当前的方案，以及监督模型的意见。任何时候都能打字插话改方向，和你平时用 DSH 一样。模型换思路时，它能自己压掉上下文接着跑。

面板上的一切都是**从会话日志投影出来的**——它显示的东西没有一样另存在别处，所以回放一个会话，画面和当时实时看到的一模一样。

**GPU 在哪，取决于你的评测命令在哪跑**——本机、容器、投到集群的作业都行。插件不关心，它自己也不需要 GPU。

## 安装

**需要** DeepSeek Harness，以及 **`PATH` 里有 pnpm**——`dsh plugin` 是把参数原样转发给 pnpm 的。面板属于 DSH 的 **web** 界面，所以插件要装进 web profile。

插件本身不用编译：`lib/` 是提交进仓库的，装上就能用。

```sh
# 仓库是公开的，不需要凭据
dsh plugin --profile web add "github:xieTwim/dsh-kernel-opt"

# 或者钉住某个 commit，安装可复现
dsh plugin --profile web add "github:xieTwim/dsh-kernel-opt#<commit-sha>"

# 或者装本地 checkout，开发时用
dsh plugin --profile web add /path/to/dsh-kernel-opt
```

还没有 `dsh`？上面的命令走 npx 一样能跑——`npx -p @deepseek-ai/dsh dsh plugin …`，然后 `npx -p @deepseek-ai/dsh dsh web`。

升级就是换个新 sha 再 `add` 一次。

重启 `dsh web`，然后验证：

```sh
dsh --profile web --dump-config | grep kernel-opt   # 应该能看到这个插件
```

## 快速开始

1. **装上插件**，重启 `dsh web`。
2. **把算子放进工作目录。** 参考实现、输入数据、你自己的评测脚本**都是可选的**，什么形态都行——模型会自己盘点、自己接起来。没有参考实现时，拿到手的那版算子原样成为分母并冻结。连评测脚本都没有时，用**内置评测器**（正确性、中位数计时、每次换新输入值，外加一个抓「重放缓存答案」的检查，参考实现只计时一次然后冻结）。它跑在 Python + PyTorch 上，**评测所在的那台机器**要有 CUDA GPU。
3. **新建一个「算子优化模式」的会话**，告诉它三件事：算子在哪、怎么评测、你的预算和硬件。或者直接 `/kloop 30` 交给循环。
4. **打开会话顶部的「评测」页签**——曲线、状态、方案、监督都在那儿。随时打字就能改方向。

**「算子优化模式」**是插件写进 `~/.dsh/.agent-presets/kernel-opt/` 的一个 agent preset，每次启动都会让它跟上插件版本——你手动改过的文件它不动，`preset.install: false` 能整个关掉。插件加的那些工具和命令**只存在于这个模式里**，别的会话一点代价都不付。

→ [`docs/mode.md`](docs/mode.md)

## 接入你自己的评测

**面板不认识、也不迁就任何一种评测。** 你自己的脚本、现成的评测器、投到远端机器的作业——只要往 stdout 打一行，它就成了曲线上的一个点：

```
KERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":1.23,"correct":true}
```

**必需**：`artifact`（测的是哪个文件）和 `correct`。**测到延迟就带上 `latency_ms`**。**可选**：`compiled`、`error`、`native_metrics`（数值映射）、`reward_hack_detected`、`advisory`、`workload_indices`。一行一个评测，从行首开始，JSON 后面跟别的字符没关系。

评测器本身就是个**工具**（MCP 或注册工具）的话，连这行都不用打——它结果文本里的同名字段直接进面板。名字里含 `kernel_evaluate` 的工具默认收录，其余的写进 `benchTools` 配置。

每个点都带着自己的来源，面板明着标出来：自报的点永远显示**产生它的那条命令**；模型收尾时，插件会**自己把那条命令重跑一遍**。**过程是模型自报的，最终那个数是复测出来的**——在能复测的前提下。复测可以关掉，记录下来的命令超过 300 字符也没法复测，这时面板会标明最终数字未经复测。

→ 全部字段、信任级、统一分母（以及少了它会赔上整轮的可比性）、去重规则：[`docs/eval-contract.md`](docs/eval-contract.md)

## 循环

```sh
/kloop            # 启动；默认预算 20 次评测（/kloop 30 可指定）
/kloop stop       # 停止（/kloop status 看状态）
/supervise on     # 打开第二模型复审
/supervise use deepseek-official/deepseek-v4-flash   # 为本会话指定复审模型
```

也可以完全在界面里操作：在面板上、或者在输入框旁边的启动器里开关和配置循环，循环跑起来后那里还会显示轮次与预算进度。两条路驱动的是同一份状态。

启动一轮时还会钉住这轮的输出语言，并从复审模型**实际支持**的档位里挑思考强度。预算**只算优化评测**——收尾时的验证、以及模型在同一个 turn 里多测出来的那次，都会保留并单独显示，不记在预算头上。

每个 turn 结束后，循环看一眼当前进展。模型已经收尾了，就停。预算用完、或者连着两轮没有新评测，就**先要一次收尾**（把最优版本装回去、在它上面 finalize、做个总结），然后才停。其余情况就推模型继续，并把还剩多少预算、卡了多久、复审说了什么一并带过去。

**人的停止永远压过机器的续跑**——停止按钮、`/kloop stop`、以及中断一个 turn，都会立刻停掉循环，不做收尾。你打的任何字，优先级都高于循环本来要发的东西。

**监督**是把一份运行摘要交给第二个模型——预算、方案、评测表，**外加最近几行背后的真实改动**。它判的是这轮**是怎么跑的**：正确性有没有排在速度前面、预算花得合不合理、有没有试过不止一族方法、有没有 profile 过、每个自报点的命令行像不像真在做评测、diff 和它自称的方案对不对得上。**它读改动，不读整份算子**——算子对不对、快不快，那是评测器用实测回答的问题。**沉默不算通过**：复审失败、超时、或者一个字没答，那一轮就不留复审记录，也永远不会卡住循环。

→ [`docs/loop.md`](docs/loop.md)

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/eval-contract.md`](docs/eval-contract.md) | 评测契约全文：两条通道、全部字段、信任级、finalize 复测、统一分母、去重规则 |
| [`docs/mode.md`](docs/mode.md) | 算子优化模式：它让模型做什么、往会话里加了什么、面板显示什么、内置评测器、以及它装了哪些文件 |
| [`docs/loop.md`](docs/loop.md) | 循环与监督：每一轮怎么判、空会话怎么起、复审模型怎么选、复审能查出和查不出什么 |
| [`docs/config.md`](docs/config.md) | 全部配置项，以及 HTTP 接口 |
| [`docs/limits.md`](docs/limits.md) | 已知边界——按「会不会让你读错面板」排序 |
| [`docs/development.md`](docs/development.md) | 开发、插件怎么注册自己、支持的宿主版本与 semver、CI |

## 兼容性

在 DeepSeek Harness **0.1.0-rc.6** 上测过。它用到了 2026-08-11 那次改名引入的宿主 API（`httpServer→webServer`、`compact→compaction`），所以**更旧的宿主装不上**。peer 范围是对 DSH 的各个分包分别声明的，不是对着 `@deepseek-ai/dsh` 整体——原因见 [`docs/development.md`](docs/development.md#peer-范围为什么是两段式)。

## 许可

MIT，见 [`LICENSE`](LICENSE)。

## 致谢

- **[AKO4ALL](https://github.com/TongmingLAIC/AKO4ALL)** —— 插件的内置评测器（`preset/kernel-opt/evaluator/bench.py`）由 AKO4ALL 附带的那份评测脚本改写而来。
- **[KernelBench](https://github.com/ScalingIntelligence/KernelBench)** —— AKO4ALL 的脚本内联了它的核心评测逻辑，因此它也一路传到了这里。

两者都是 MIT；许可声明原样收录在 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 与文件头部。
