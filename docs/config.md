# 配置

写在 `~/.dsh/cordis.patch.yml` 的插件行（或 profile patch），也可以走设置页：

```yaml
- id: kernel-opt
  config:
    replay:
      timeoutSec: 1800
    loop:
      defaultBudget: 30
```

## 全部 key

| key | 默认 | 说明 |
|---|---|---|
| `benchTools` | `['kernel_evaluate']` | 计入曲线的评测**工具**名（精确或分隔符后缀匹配，MCP 前缀自动覆盖） |
| `shellTools` | `['bash']` | 扫描契约行的 shell 工具名（自报通道）。命令行**只做读取**时不计点，见 [`eval-contract.md`](eval-contract.md#哪些命令不计点) |
| `jobTools` | `['job_output']` | 后台任务读取器，**照常计点**：跑得久到要放后台的 bench 仍然是 bench |
| `profileTools` | `['kernel_profile']` | 记为 ▲ 标记的 profiler **工具**名（注册工具／MCP 评测器才有；自组装评测入口的形态下不会触发） |
| `profileCommands` | `ncu`／`nsys`／`nvprof`／`rocprof*`／`omniperf`／`vtune`／`perf`／`xctrace`／`instruments`／`sample` 等 | 记为 ▲ 标记的 profiler **命令**名，按 shell 命令行**可执行位置**的 token 匹配，且必须带参数（路径前缀算；`time.perf_counter`、`python sample.py`、`ncu --help` 都不算） |
| `finalizeTools` | `['run_finalize', 'kernel_finalize']` | finalize 工具名：`evaluation_id` 参数把对应点标 ⚑，`artifact_path` 参数把该 artifact 最优诚实点标 ⚑ |
| `changeTools` | `['write', 'edit']` | 计为「该轮改动」的结构化文件工具名，与评测的 artifact 匹配后挂到该行 |
| `replay.enabled` | `true` | finalize 复测开关 |
| `replay.timeoutSec` | `900` | 复测命令超时（秒） |
| `preset.install` | `true` | 「算子优化模式」preset 自动落盘开关 |
| `preset.id` | `kernel-opt` | preset 落盘目录／id（改动后 Tab 常显示回退为信号检测） |
| `loop.defaultBudget` | `20` | `/kloop` 不带数字时的预算 |
| `supervisor.provider` | 无 | 监督模型的 provider 路由，见 [`loop.md`](loop.md#监督模型的两层解析) |
| `supervisor.model` | 无 | 监督模型 |
| `supervisor.language` | 无 | 复审语言；不写则跟随 Agent |
| `supervisor.instructions` | 无 | 本项目的加码 rubric，**追加**而非替换 |

## HTTP 路由

| 路由 | 用途 |
|---|---|
| `GET …/series?sessionId=` | 即时投影 |
| `POST …/control` | 驱动与 slash 命令同一份循环／监督状态（含 `supervise-use` 会话级换监督模型） |
| `GET …/models` | 供面板选择器枚举 provider/model |
