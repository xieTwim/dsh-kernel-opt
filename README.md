<h1 align="center">dsh-kernel-opt</h1>
<p align="center"><b>Watch a model optimize a kernel — live, inside DeepSeek Harness</b></p>

<p align="center">
  <a href="https://github.com/xieTwim/dsh-kernel-opt/actions/workflows/ci.yml"><img src="https://github.com/xieTwim/dsh-kernel-opt/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="License: MIT"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DSH-0.1.0--rc.6-blue?logo=github" alt="DSH 0.1.0-rc.6"></a>
  <img src="https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87-lightgrey" alt="Docs in Chinese">
</p>

<p align="center"><b>If you find this useful, please consider giving us a star 🌟</b></p>

<p align="center">
  <img src="assets/panel.png" width="820" alt="The plugin's evaluation tab after a finished run: a run-control card (evaluation budget, output language, supervision toggle, supervisor model, reasoning effort) above a speedup curve climbing from x0.748 to x581 over 15 optimization evaluations, with the best point starred, the finalized point flagged, one profiler mark and two marks for points clamped to the axis floor." />
  <br/>
  <i>One finished run: 15 optimization evaluations from ×0.748 to ×581, one of them profiled, the honest best finalized.</i>
</p>

## News

- 🚀 **[2026.08.17]** **dsh-kernel-opt is released** — the live evaluation panel, the `/kloop` optimization loop, and optional second-model supervision.

**Table of Contents**

- [What is dsh-kernel-opt?](#what-is-dsh-kernel-opt)
- [The Evaluation Contract](#the-evaluation-contract)
- [Install](#install)
- [Quick Start](#quick-start)
- [The Loop](#the-loop)
- [Documentation](#documentation)
- [Compatibility](#compatibility)
- [License](#license)
- [Acknowledgments](#acknowledgments)

## What is dsh-kernel-opt?

**dsh-kernel-opt is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that turns a long kernel-optimization run into something a human can watch and steer.**

The model iterates — read, edit, benchmark, repeat — and an **evaluation tab** in the same session shows, in real time: the speed curve (higher is faster), each point's correctness and reward-hack status, **where each point came from and how far it can be trusted**, profiling ▲ / first-best ★ / finalize ⚑ markers, the model's current approach, and the supervisor's notes. You can cut in and redirect at any moment — DSH's native steering. When the model changes tack, it can compact its own context and keep going (`self_compact`).

Everything on the panel is **projected from the session log** — the plugin keeps no state of its own, so a replayed session renders exactly like the live one.

**The GPU is wherever your benchmark command runs** — this machine, a container, a job submitted to a cluster. The plugin does not care and does not need one.

## The Evaluation Contract

**The panel does not know, and does not adapt to, any benchmark.** Any evaluation pipeline — your own script, an off-the-shelf evaluator, a remote runner — becomes a point on the curve as soon as its result reaches the session log in one of two shapes:

**① A contract line.** Your script prints one line to stdout when it finishes:

```
KERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":1.23,"correct":true}
```

**② A tool result.** An evaluator that exists as a tool (MCP or registered) — the same JSON fields inside its result text go straight in.

The two channels can be mixed. What separates them is **trust level, and the panel labels it in the open**:

| Source | How the panel labels it | Why you can (or can't) trust it |
|---|---|---|
| Tool result | `tool` | Produced by a tool — the model cannot forge it |
| Contract line | `agent-measured`, next to the command line that produced it | Model-controlled stdout — an `echo`-ed fake is visible at a glance |
| Finalize re-run | `replayed` | The plugin replayed the command itself, outside the agent's turn |

That last row is the point: when the model calls `kernel_finalize`, the plugin **re-runs the recorded command once, on its own**. The trajectory is self-reported; **the final number is re-measured.**

→ Full field list, the pooled-reference denominator (and why a missing one costs you the whole run's comparability), and the de-duplication rules: [`docs/eval-contract.md`](docs/eval-contract.md)

## Install

Build output ships with the repo (`lib/` is committed), so there is nothing to build and no toolchain beyond Node:

```sh
# from git, pinned to a commit (the repo is public — no credentials needed)
dsh plugin --profile web add "github:xieTwim/dsh-kernel-opt#<sha>"

# or a local checkout, for development
dsh plugin --profile web add /path/to/dsh-kernel-opt
```

Upgrading = `add` again with a newer sha.

Restart `dsh web`, then verify:

```sh
dsh --profile web --dump-config | grep kernel-opt   # a bundle layer should appear
```

## Quick Start

1. **Install the plugin** and restart `dsh web`.
2. **Put the kernel in your working directory.** A reference, input data and your own benchmark script are all optional, in any form — the model takes inventory and wires them up. With no reference, the original kernel as received becomes the denominator, frozen. With no benchmark at all, the **built-in evaluator** is used (correctness + median timing + fresh inputs + a mutation sentinel, with the reference timed once and frozen).
3. **Start a session in Kernel-Opt mode** and give it three things: where the kernel is, how to evaluate it, and your budget / hardware. Or hand it to the loop with `/kloop 30`.
4. **Open the Evaluations tab** at the top of the session — curve, status, approach, supervision. Type any time to steer.

The **Kernel-Opt mode** is an agent preset the plugin installs into `~/.dsh/.agent-presets/kernel-opt/` and keeps in step with itself on every start. Its persona is the single source of the protocol, and the four tools and two commands exist **only in that mode** — an unrelated session pays nothing for them (3897 B of tool descriptions per turn, measured).

→ [`docs/mode.md`](docs/mode.md)

## The Loop

```sh
/kloop            # start; default budget 20 evaluations (/kloop 30 to set it)
/kloop stop       # stop  (/kloop status to inspect)
/supervise on     # turn on second-model review
/supervise use deepseek-official/deepseek-v4-flash   # pick a reviewer for this session
```

Or drive it entirely from the UI: the panel has a loop row and a supervision row, and the composer has a **⟳ start loop** launcher plus a live status strip. Both drive the same state as the slash commands.

The launcher also fixes this run's output language (following the current interface by default) and exposes the supervisor model's adapter-declared reasoning efforts. Evaluation records are split into budgeted optimization work, same-turn budget overshoot, and wrap-up validation, so a `12/12` budget stays `12/12` even when the final turn returns one extra measurement.

After every turn the loop reads the projected run state and decides: finalized → stop; budget spent or two rounds with no new evaluation → post **a wrap-up message first** (restore the best artifact, finalize the honest best, summarize), then disarm; otherwise post a continuation carrying budget progress, a stall count and the supervisor's advice.

**A human stop always beats a machine continuation** — the stop button, `/kloop stop`, and aborting a turn in the composer all disarm immediately, without a wrap-up. Human messages always take priority: if the agent is not idle, the loop skips that round.

**Supervision** hands a second model the run's *digest* — budget discipline, correctness-first, method diversity, whether the plan matches the diffs, whether anything was profiled, whether each self-reported point's command line looks like a real evaluation. It does not review the kernel line by line. **Silence is not approval**: a failed, timed-out or empty review is recorded as "not reviewed this round" and never blocks the loop.

→ [`docs/loop.md`](docs/loop.md)

## Documentation

Written in Chinese.

| Doc | What's in it |
|---|---|
| [`docs/eval-contract.md`](docs/eval-contract.md) | The contract in full: both channels, every field, the trust levels, the finalize re-run, the pooled-reference denominator, the de-duplication rules |
| [`docs/mode.md`](docs/mode.md) | Kernel-Opt mode: the persona, the four tools, what the panel shows, the built-in evaluator, how the installed files are tracked |
| [`docs/loop.md`](docs/loop.md) | The loop and supervision: how a round is decided, starting from an empty session, the two-layer supervisor resolution, the limits of the rubric |
| [`docs/config.md`](docs/config.md) | Every config key, and the HTTP routes |
| [`docs/limits.md`](docs/limits.md) | Known limits — ordered by how badly each one can make you misread the panel |
| [`docs/development.md`](docs/development.md) | Development, the two registration planes, the compatibility baseline and semver, CI |

## Compatibility

`@deepseek-ai/dsh` **0.1.0-rc.6**. Uses the `ctx.webServer` / `ctx.compaction` / `sessionId` props, so it is **incompatible with hosts older than the 2026-08-11 rename** (`httpServer→webServer`, `compact→compaction`). The peer range is deliberately two-segment — see [`docs/development.md`](docs/development.md#peer-范围为什么是两段式).

## License

MIT — see [`LICENSE`](LICENSE).

## Acknowledgments

- **[AKO4ALL](https://github.com/TongmingLAIC/AKO4ALL)** — the plugin's built-in evaluator (`preset/kernel-opt/evaluator/bench.py`) is derived from the benchmark script AKO4ALL ships.
- **[KernelBench](https://github.com/ScalingIntelligence/KernelBench)** — whose core evaluation logic AKO4ALL's script inlines, and which therefore reaches here too.

Both are MIT; their notices are reproduced verbatim in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and at the top of the file itself.
