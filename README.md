<h1 align="center">dsh-kernel-opt</h1>
<p align="center"><b>DeepSeek Harness 插件：实时查看并干预算子优化过程</b></p>
<p align="center">简体中文 | <a href="README.en.md">English</a></p>

<p align="center">
  <a href="https://github.com/xieTwim/dsh-kernel-opt/actions/workflows/ci.yml"><img src="https://github.com/xieTwim/dsh-kernel-opt/actions/workflows/ci.yml/badge.svg" alt="check"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="License: MIT"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DSH-0.1.0--rc.6-blue?logo=github" alt="DSH 0.1.0-rc.6"></a>
</p>

<p align="center"><b>觉得有用的话，欢迎点个 star 🌟</b></p>

<p align="center">
  <img src="assets/panel.png" width="820" alt="一轮结束后的「评测」页签，硬件为单卡 NVIDIA B200。上方是运行控制，监督已打开；下方的加速比曲线在 12 次优化评测中从 ×1.00 升到 ×22.1，3 次失败画在坐标轴下方，最优点带有 ★ 与 ⚑ 标记，运行控制一行显示循环因监督确认无余量而收尾。" />
  <br/>
  <i>RoPE <code>(4, 32, 4096, 128)</code> fp16，单卡 NVIDIA B200。12 次评测，加速比从 ×1.00 到 ×22.1，全程除以同一个参考耗时（冻结在 1.0400 ms）。</i>
</p>

## News

- 🚀 **[2026.08.17]** **dsh-kernel-opt 开源发布**：实时评测面板、按预算运行并自行收尾的优化循环，以及可选的第二模型监督。

**目录**

- [简介](#简介)
- [安装](#安装)
- [快速开始](#快速开始)
- [接入你自己的评测](#接入你自己的评测)
- [循环](#循环)
- [文档](#文档)
- [兼容性](#兼容性)
- [许可](#许可)
- [致谢](#致谢)

## 简介

**dsh-kernel-opt 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的插件。算子优化要跑很多轮，它把每一轮的评测结果实时画进同一个会话，人可以边看边介入。**

模型一轮轮地读代码、改代码、跑评测，同一个会话里多出一个「评测」页签，实时显示加速比曲线（越高越快）、每个点的正确性与是否奖励作弊（reward hack）、模型当前的方案和监督模型的意见，并用 ▲ ★ ⚑ 分别标出做过性能分析、当前最优、以及收尾选定的那个点。**每个点还带着自己的来源和可信程度**，见下面的评测契约。

随时可以发消息改变方向，和平时用 DSH 一样。模型换思路时，可以压缩自己的上下文后继续。

面板显示的内容全部**从会话日志投影而来**，插件不另存一份，所以回放一个会话，画面与当时实时看到的一致。

**评测命令在哪台机器上执行，GPU 就在哪里**：本机、容器、投到集群的作业都可以。插件本身不需要 GPU。

## 安装

安装需要 DeepSeek Harness，以及 **`PATH` 中有 pnpm**——`dsh plugin` 会把参数转发给 pnpm。面板属于 DSH 的 **web** 界面，所以插件要装进 web profile。

插件本身不需要构建，`lib/` 已经提交进仓库。

```sh
# 仓库是公开的，不需要凭据
dsh plugin --profile web add "github:xieTwim/dsh-kernel-opt"

# 或者钉住某个 commit，使安装可复现
dsh plugin --profile web add "github:xieTwim/dsh-kernel-opt#<commit-sha>"

# 或者安装本地 checkout，用于开发
dsh plugin --profile web add /path/to/dsh-kernel-opt
```

如果还没有 `dsh`，上面的命令可以走 npx：`npx -p @deepseek-ai/dsh dsh plugin …`，启动则是 `npx -p @deepseek-ai/dsh dsh web`。

升级时用新的 sha 再执行一次 `add`。

重启 `dsh web`，然后验证：

```sh
dsh --profile web --dump-config | grep kernel-opt   # 应该能看到这个插件
```

## 快速开始

1. **安装插件**，重启 `dsh web`。
2. **把算子放进工作目录。** 参考实现、输入数据、你自己的评测脚本都是可选的，形式不限，模型会自己确认有哪些材料并把评测接起来。没有参考实现时，最初那版算子会被冻结为分母。连评测脚本也没有时，使用**内置评测器**：检查正确性、取中位数计时、每次换新的输入值，并用一项检查识别重放缓存答案的实现，参考实现只计时一次然后冻结。它运行在 Python 与 PyTorch 上，**执行评测的那台机器**需要有 CUDA GPU。
3. **新建一个「算子优化模式」的会话**，告诉它三件事：算子在哪、怎么评测、预算和硬件。也可以用输入框旁边的启动器直接交给循环。
4. **打开会话顶部的「评测」页签**，曲线、状态、方案、监督都在这里。随时发消息即可改变方向。

「算子优化模式」是插件写入 `~/.dsh/.agent-presets/kernel-opt/` 的一个 agent preset，每次启动时同步到当前插件版本；你手动改过的文件不会被覆盖，`preset.install: false` 可以整个关闭。插件添加的工具和命令**只存在于这个模式**，其他会话不会加载。

→ [`docs/mode.md`](docs/mode.md)

## 接入你自己的评测

**面板对评测方式不做任何假设。** 你自己的脚本、现成的评测器、投到远端机器的作业，只要往 stdout 打印一行，就成为曲线上的一个点：

```
KERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":1.23,"correct":true}
```

**必需**：`artifact`（测的是哪个文件）与 `correct`。**测到延迟时带上 `latency_ms`**。**可选**：`compiled`、`error`、`native_metrics`（数值映射）、`reward_hack_detected`、`advisory`、`workload_indices`。一行一个评测，从行首开始，JSON 之后可以跟其他字符。

评测器本身就是**工具**（MCP 或注册工具）时不需要打印这一行，它结果文本中的同名字段直接进入面板。名称中含 `kernel_evaluate` 的工具默认收录，其余的写进 `benchTools` 配置。

每个点都记录了来源，面板直接显示出来：自报的点会附上产生它的那条命令；模型收尾时，插件会自己把那条命令重跑一遍。**过程由模型自报，最终数字由插件复测。** 复测不是无条件的：可以关闭，记录下来的命令超过 300 字符也无法复测，这两种情况下面板会标明最终数字未经复测。

→ 全部字段、信任级、统一分母（以及缺少它会如何影响整轮的可比性）、去重规则：[`docs/eval-contract.md`](docs/eval-contract.md)

## 循环

模型做完一轮，循环推它继续，直到预算用完或者收尾。

**在界面上开关**：「评测」页签顶部有循环与监督两行；会话还是空的时候页签尚未出现，用输入框旁边的启动器，选项相同。

预算只计优化评测——收尾时的验证、以及模型在同一回合内多做的那次，都保留并单独显示。预算用完、或连续两轮没有新评测，循环会先要一次收尾（装回最优版本、finalize、总结）再停。**人可以随时打断**：停止按钮和中断回合都立刻生效且不做收尾，你发的消息也优先于循环要发的内容。

**监督**是把运行摘要和最近几次的真实改动交给第二个模型，让它评判这一轮**是怎么跑的**：预算、方向多样性、有没有做性能分析、自报点的命令行像不像真评测、diff 与方案是否一致。它不读整份算子代码——算子快不快，由评测器实测回答。**复审没有结论不等于通过**：失败、超时、没有答复都不留记录，也不阻塞循环。

同一份状态也可以用 slash 命令驱动。三件事只能靠它们：手填下拉列不出来的复审模型、在循环运行期间调整监督（界面上那一行此时锁住）、把操作写进消息交给脚本。

```sh
/kloop [n]                          # 启动，默认预算 20 次评测；stop 停止，status 查看
/supervise on                       # 打开第二模型复审
/supervise use <provider>/<model>   # 手填本会话的复审模型
```

→ [`docs/loop.md`](docs/loop.md)

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/eval-contract.md`](docs/eval-contract.md) | 评测契约全文：两条通道、全部字段、信任级、finalize 复测、统一分母、去重规则 |
| [`docs/mode.md`](docs/mode.md) | 算子优化模式：它让模型做什么、往会话里加了什么、面板显示什么、内置评测器、以及它安装了哪些文件 |
| [`docs/loop.md`](docs/loop.md) | 循环与监督：每一轮怎么判定、空会话如何启动、复审模型如何选择、复审能查出和查不出什么 |
| [`docs/config.md`](docs/config.md) | 全部配置项，以及 HTTP 接口 |
| [`docs/limits.md`](docs/limits.md) | 已知边界，按对面板判读的影响程度排序 |
| [`docs/development.md`](docs/development.md) | 开发、插件如何注册自己、支持的宿主版本与 semver、CI |

## 兼容性

在 DeepSeek Harness **0.1.0-rc.6** 上测试。插件用到了 2026-08-11 那次改名引入的宿主 API（`httpServer→webServer`、`compact→compaction`），**更旧的宿主无法加载**。peer 范围是对 DSH 的各个分包分别声明的，而不是对 `@deepseek-ai/dsh` 整体，原因见 [`docs/development.md`](docs/development.md#peer-范围为什么是两段式)。

## 许可

MIT，见 [`LICENSE`](LICENSE)。

## 致谢

- **[AKO4ALL](https://github.com/TongmingLAIC/AKO4ALL)**：插件的内置评测器（`preset/kernel-opt/evaluator/bench.py`）由 AKO4ALL 附带的评测脚本改写而来。
- **[KernelBench](https://github.com/ScalingIntelligence/KernelBench)**：AKO4ALL 的脚本内联了它的核心评测逻辑，因此它也传到了这里。

两者都是 MIT，许可声明原样收录在 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 与文件头部。
