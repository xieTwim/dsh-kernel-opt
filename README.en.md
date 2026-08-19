<h1 align="center">dsh-kernel-opt</h1>
<p align="center"><b>A DeepSeek Harness plugin for watching and steering a kernel-optimization run</b></p>
<p align="center"><a href="README.md">简体中文</a> | English</p>

<p align="center">
  <a href="https://github.com/xieTwim/dsh-kernel-opt/actions/workflows/ci.yml"><img src="https://github.com/xieTwim/dsh-kernel-opt/actions/workflows/ci.yml/badge.svg" alt="check"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue" alt="License: MIT"></a>
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DSH-0.1.0--rc.6-blue?logo=github" alt="DSH 0.1.0-rc.6"></a>
  <img src="https://img.shields.io/badge/docs-%E4%B8%AD%E6%96%87-lightgrey" alt="Docs in Chinese">
</p>

<p align="center"><b>If you find this useful, please consider giving us a star 🌟</b></p>

<p align="center">
  <img src="assets/panel.png" width="820" alt="The plugin's evaluation tab after a finished run on one NVIDIA B200: run controls with supervision switched on, above a speedup curve rising from x1.00 to x22.1 over 12 optimization evaluations, three failed evaluations drawn below the axis, the best point starred and finalized, and a note that the loop stopped because the reviewer confirmed no headroom was left." />
  <br/>
  <i>RoPE <code>(4, 32, 4096, 128)</code> fp16 on one NVIDIA B200. 12 evaluations, ×1.00 to ×22.1, every one dividing by the same reference latency frozen at 1.0400 ms.</i>
</p>

## News

- 🚀 **[2026.08.17]** **dsh-kernel-opt is released** — the live evaluation panel, an optimization loop that runs to a budget and wraps up on its own, and optional second-model supervision.

**Table of Contents**

- [What is dsh-kernel-opt?](#what-is-dsh-kernel-opt)
- [Install](#install)
- [Quick Start](#quick-start)
- [Bring Your Own Benchmark](#bring-your-own-benchmark)
- [The Loop](#the-loop)
- [Documentation](#documentation)
- [Compatibility](#compatibility)
- [License](#license)
- [Acknowledgments](#acknowledgments)

## What is dsh-kernel-opt?

**dsh-kernel-opt is a plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) that turns a long kernel-optimization run into something a human can watch and steer.**

The model iterates — read, edit, benchmark, repeat — and an **evaluation tab** in the same session shows, in real time, the speed curve (higher is faster), each point's correctness and reward-hack status, the model's current approach and the supervisor's notes, with ▲ ★ ⚑ marking what was profiled, the best result so far, and the point it finalized on. **Each point also carries where it came from and how far it can be trusted** — see the contract below.

You can cut in and redirect at any moment, the same way you steer any DSH session. When the model changes tack, it can compact its own context and keep going.

Everything on the panel is **projected from the session log**; the plugin keeps no second copy, so a replayed session renders exactly like the live one.

**The GPU is wherever your benchmark command runs** — this machine, a container, a job submitted to a cluster. The plugin itself does not need one.

## Install

**You need** DeepSeek Harness, and **pnpm on `PATH`** — `dsh plugin` forwards its arguments to pnpm. The panel is part of the DSH **web** UI, so the plugin installs into a web profile.

The plugin itself has nothing to build: `lib/` is committed, so it installs without a build step.

```sh
# the repo is public — no credentials needed
dsh plugin --profile web add "github:xieTwim/dsh-kernel-opt"

# or pin a commit, for a reproducible install
dsh plugin --profile web add "github:xieTwim/dsh-kernel-opt#<commit-sha>"

# or a local checkout, for development
dsh plugin --profile web add /path/to/dsh-kernel-opt
```

No `dsh` yet? The same commands work through npx — `npx -p @deepseek-ai/dsh dsh plugin …`, then `npx -p @deepseek-ai/dsh dsh web`.

To upgrade, run `add` again with a newer sha.

Restart `dsh web`, then verify:

```sh
dsh --profile web --dump-config | grep kernel-opt   # the plugin should be listed
```

## Quick Start

1. **Install the plugin** and restart `dsh web`.
2. **Put the kernel in your working directory.** A reference, input data and your own benchmark script are all optional, in any form — the model takes inventory and wires them up. With no reference, the original kernel as received becomes the denominator, frozen. With no benchmark at all, the **built-in evaluator** is used (correctness, median timing, new input values per trial, and a check that catches a kernel replaying a cached answer, with the reference timed once and frozen). It runs on Python + PyTorch and needs a CUDA GPU on whatever machine executes the benchmark.
3. **Start a session in Kernel-Opt mode** — it appears in the mode picker as 「算子优化模式」 — and give it three things: where the kernel is, how to evaluate it, and your budget / hardware. Or hand it straight to the loop from the launcher next to the message box.
4. **Open the Evaluations tab** at the top of the session — curve, status, approach, supervision. Type any time to steer.

The **Kernel-Opt mode** is an agent preset the plugin installs into `~/.dsh/.agent-presets/kernel-opt/` and brings up to date on each start — it leaves files you have edited alone, and `preset.install: false` turns the whole thing off. Everything the plugin adds, its tools and its commands, exists **only in that mode**; other sessions do not load them.

→ [`docs/mode.md`](docs/mode.md)

## Bring Your Own Benchmark

**The panel assumes nothing about how you benchmark.** Your own script, an off-the-shelf evaluator, a job on a remote box — it becomes a point on the curve as soon as it prints one line to stdout:

```
KERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":1.23,"correct":true}
```

**Required:** `artifact` (which file was measured) and `correct`. **Add `latency_ms`** whenever you measured one. **Optional:** `compiled`, `error`, `native_metrics` (a numeric map), `reward_hack_detected`, `advisory`, `workload_indices`. One evaluation per line, starting at column 1; anything may follow the JSON.

An evaluator that exists as a **tool** (MCP or registered) needs no line at all — the same fields inside its result text go straight in. Any tool whose name contains `kernel_evaluate` is collected by default; anything else goes in the `benchTools` config.

Every point carries where it came from, and the panel says so in the open: a self-reported point always displays the command that produced it, and when the model finalizes, the plugin **re-runs that command itself**. The trajectory is self-reported; the final number is re-measured — when it can be. Replay can be switched off, and a recorded command over 300 characters is not replayable; the panel then marks the final number as never re-measured.

→ Every field, the trust levels, the pooled-reference denominator (and why a missing one costs the whole run's comparability), and the de-duplication rules: [`docs/eval-contract.md`](docs/eval-contract.md)

## The Loop

When the model finishes a turn, the loop pushes it onward until the budget runs out or it wraps up.

**Drive it from the UI**: the evaluation tab carries a loop row and a supervision row; in a session with nothing in it yet the tab has not appeared, so use the launcher next to the message box, which offers the same options.

The budget counts optimization work only — a wrap-up measurement, or one extra evaluation squeezed into the same turn, is kept and shown separately. When the budget runs out, or two rounds pass with no new evaluation, the loop asks for a wrap-up first (put the best version back, finalize on it, summarize) and then stops. **You can cut in at any point**: the stop button and aborting a turn both take effect immediately with no wrap-up, and anything you type outranks what the loop would have sent.

**Supervision** hands a second model a summary of the run together with the real edits behind the recent rows, and asks it to judge **how the run is being conducted**: budget discipline, whether more than one family of ideas was tried, whether anything was profiled, whether each self-reported command line looks like a real evaluation, and whether the diffs match the plan. It does not read the whole kernel — whether the kernel is fast is the evaluator's question, answered by measurement. **A review with no verdict is not approval**: one that fails, times out or comes back empty leaves no record and never blocks the loop.

The same state is also driven by slash commands, and three things need them: naming a reviewer model the dropdown cannot enumerate, changing supervision while the loop runs (that row is locked in the UI), and putting the action in a message for a script to send.

```sh
/kloop [n]                          # start, default budget 20 evaluations; stop, status
/supervise on                       # turn on second-model review
/supervise use <provider>/<model>   # name a reviewer for this session by hand
```

→ [`docs/loop.md`](docs/loop.md)

## Documentation

Written in Chinese.

| Doc | What's in it |
|---|---|
| [`docs/eval-contract.md`](docs/eval-contract.md) | The contract in full: both channels, every field, the trust levels, the finalize re-run, the pooled-reference denominator, the de-duplication rules |
| [`docs/mode.md`](docs/mode.md) | Kernel-Opt mode: what it tells the model to do, what it adds to the session, what the panel shows, the built-in evaluator, and what it installs |
| [`docs/loop.md`](docs/loop.md) | The loop and supervision: how each round is decided, starting from an empty session, how the reviewer model is chosen, and what its review can and cannot catch |
| [`docs/config.md`](docs/config.md) | Every config key, and the HTTP API |
| [`docs/limits.md`](docs/limits.md) | Known limits — ordered by how badly each one can make you misread the panel |
| [`docs/development.md`](docs/development.md) | Development, how the plugin registers itself, the supported host versions and semver, CI |

## Compatibility

Tested against DeepSeek Harness **0.1.0-rc.6**. It uses host APIs introduced by the 2026-08-11 rename (`httpServer→webServer`, `compact→compaction`), so **an older host cannot load it**. Peer ranges are declared against the individual DSH packages rather than `@deepseek-ai/dsh` as a whole — the policy is in [`docs/development.md`](docs/development.md#peer-范围为什么是两段式).

## License

MIT — see [`LICENSE`](LICENSE).

## Acknowledgments

- **[AKO4ALL](https://github.com/TongmingLAIC/AKO4ALL)** — the plugin's built-in evaluator (`preset/kernel-opt/evaluator/bench.py`) is derived from the benchmark script AKO4ALL ships.
- **[KernelBench](https://github.com/ScalingIntelligence/KernelBench)** — whose core evaluation logic AKO4ALL's script inlines, and which therefore reaches here too.

Both are MIT; their notices are reproduced verbatim in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and at the top of the file itself.
