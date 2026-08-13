---
name: kernel-cockpit
description: Discipline for long kernel-optimization loops under the kernel-cockpit plugin — when to report a plan, when to self-compact, how the human steers.
---

# kernel-cockpit 循环纪律

本 skill 配合 `dsh-kernel-cockpit` 插件使用。面板从会话日志派生,你不需要为它做任何额外记录——只需遵守两条纪律,人类就能实时看懂并引导你的优化循环。

## 1. cockpit_plan:先声明,再动手

在**每次开始一个新方案**(新的 kernel 结构、新的 tiling 策略、新的方法族)之前,调用 `cockpit_plan`:

- `phase`:explore(找方向)/ tune(参数微调)/ verify(验证正确性与稳定性)/ stuck(卡住,需要人类输入)/ done。
- `approach`:一句话说清这次要做什么,如 "split-K over KV, BLOCK_H=8"。
- `hypothesis`:为什么它应该更快(一句话)。
- `next`:紧接着的第一个动作。

方案变化时**再调一次**。人类靠这个卡片决定要不要在你浪费一轮评测之前插话引导(用户输入会以 steering 方式插进你的下一步)。`phase=stuck` 是显式请求人类引导的信号。

## 2. self_compact:换方案族时清上下文

满足以下任一条件时,调用 `self_compact`(带 `reason`,说明什么信息必须存活):

- 你要**换到不同的方法族**,旧方案的逐行调试细节不再有用;
- 累积的工具输出(profile 全文、编译报错)已经消费完毕,只剩结论有用;
- 你注意到自己开始重复检索早已确认过的事实。

压缩只影响模型可见上下文;完整历史仍在会话日志里,面板曲线不受影响。**不要**在评测仍在进行、或刚拿到需要逐行分析的 profile 输出时压缩。

## 3. 诚实红线

- 评测数字以 `kernel_evaluate` 的返回为准,不要在 plan 里声称未测得的加速比。
- 出现 `reward_hack_detected` 时,当作方法失败处理并换方向,不要绕检测器。
- `correct: false` 的低延迟不是进展;面板会把它标红并排除出 best。
