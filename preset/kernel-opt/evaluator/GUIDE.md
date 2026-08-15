# KernelBench Default Benchmark

Self-contained evaluation script for AKO4ALL. Inlines core logic from [KernelBench](https://github.com/KernelBench/KernelBench) so no external dependency is needed.

## Setup

When `bench/` is empty (default bench mode), use `bench/kernelbench/bench.py` as the benchmark.

### Inputs to assemble

Three pieces must be reachable at eval time:

| Piece | Source priority | Required |
|-------|-----------------|----------|
| `class Model(nn.Module)` with `forward()` | `--ref` file | Yes |
| `get_inputs()` returning sample input tensors | `--inputs` file > `--ref` file | Yes |
| `get_init_inputs()` returning constructor args | `--inputs` file > `--ref` file > defaults to `[]` | No |

The agent's job during Setup is to assemble these three pieces from whatever the user provided — usually by pointing `--ref` / `--inputs` at the files in their existing locations, or (only when a new helper file is genuinely needed, e.g., wrapping raw `.npz` data) by writing into `source/`. Don't move or copy existing user files just to canonicalize paths. How to assemble them is up to the agent.

### Common assembly patterns

These are typical paths, not rules. Use whichever shape fits the situation.

- **KernelBench-format input** — A single file already contains all three pieces. Use it directly as `--ref`; omit `--inputs`.
- **Raw kernel** (CUDA / Triton / CuTe-DSL / TileLang / ...) — Wrap the kernel into a `class Model` (e.g., `torch.utils.cpp_extension.load_inline` for CUDA) and define `get_inputs()`. Either keep both in one file used as `--ref`, or split: `class Model` in `--ref`, `get_inputs()` in a separate `source/inputs.py` passed via `--inputs`.
- **Kernel + separate input data** — User provides a kernel plus data in some non-Python format (`.npz`, `.bin`, shape lists in `.txt`, etc.). Wrap the kernel into `class Model` in `--ref`, then write `source/inputs.py` whose `get_inputs()` loads the data file (`np.load`, `torch.load`, custom parser — agent's call) and returns tensors. Pass it via `--inputs`.
- **Kernel referenced by external path** — User points at a kernel outside this repo (e.g., a path into a KernelBench dataset). `--ref` and `--inputs` accept arbitrary paths; no need to copy files into `source/`.

### Pitfall: `get_inputs()` must produce fresh data per call

The bench script calls `get_inputs()` once per correctness trial (5 by default) and again for timing. If `get_inputs()` returns a module-level cached tensor, every trial sees identical data — correctness checks pass trivially and timing reflects cache-warm performance. Make `get_inputs()` regenerate inputs each call (`torch.randn`, re-`np.load`, etc.).

### Bench command

```
python bench/kernelbench/bench.py --ref <ref-path>.py --solution solution/<kernel>.py [--inputs <inputs-path>.py] --verbose
```

If the file passed to `--inputs` also defines `get_init_inputs()`, it overrides the ref's version too. The solution file keeps `class Model` — the bench script transparently renames it to `class ModelNew` before evaluation.

### There is always a reference

Speedup is the number the whole loop is steering by, so the evaluator never runs without a denominator. If the user handed you a reference implementation, that is it. If they did not — a bare kernel, no benchmark, nothing to compare against — then **the kernel as you received it is the reference**: copy it once, before you touch anything, and point `--ref` at that frozen copy. "×2.4 over where we started" is a real, checkable claim; a bare latency is not.

Never point `--ref` at the file you are editing. `solution/` is the only directory the loop owns; the reference lives outside it and does not change for the length of the run.

### The reference is timed once, then frozen

The reference is invariant across solution edits, so `bench.py` times it **once** and freezes the number in `--baseline` (default `.bench-baseline.json`, written next to where you run the bench). Every later run reads it back:

```
# first run: times the reference, writes the baseline
python bench/kernelbench/bench.py --ref <ref>.py --solution solution/<k>.py
  → REF_SOURCE: measured this run (baseline established)

# every run after: reference timing skipped, speedup still reported
python bench/kernelbench/bench.py --ref <ref>.py --solution solution/<k>.py
  → REF_SOURCE: frozen baseline (measured 2026-08-15T08:29:18+00:00)
```

Two things this buys, and the second is the reason it exists:

- the reference's timing phase costs nothing per iteration — the whole saving the old `--no-ref` switch bought, except `SPEEDUP` survives, which is why `--no-ref` is gone;
- `SPEEDUP` orders the same way the solution's own `RUNTIME` does. A denominator re-timed inside every evaluation carries its own noise: on one A100 the same untouched reference came back 2.14 / 2.06 / 2.03 ms across three runs, a 5% wobble — enough to report a 453µs kernel as ×3.60 and a 454µs one as ×3.61.

The baseline re-measures itself when the comparison stops being the same one: a changed reference source, machine, backend, precision, input regime, trial count or seed. Each of those prints the reason it invalidated. Correctness is untouched — the reference still runs `--num-correct-trials` times per evaluation; only its *timing* phase is cached, so trim that count (keep it ≥1) if an expensive reference is still the bottleneck.

`--refresh-baseline` re-times the reference and overwrites the frozen value. It is for a machine that may have drifted under you (thermal throttling, a noisy neighbour) — the one error a frozen denominator cannot cancel out. **Refreshing mid-run makes every earlier iteration incomparable with every later one**: the curve silently changes what it is measuring against. If you refresh, say so in your next report, and treat the numbers before and after as two series.

### Never swap what you compare against

Reducing how often the reference is *paid for* is fine — that is what the baseline does. Changing *what* the ratio is taken against, to make the number look better or the bench run faster, is not a measurement any more. That applies to `--ref`, to the input regime (`--fresh-inputs` / `--no-fresh-inputs` measure different quantities), and to precision.

## Output Format

Each run prints structured lines (parsed by the agent):

```
COMPILED: True
CORRECT: True
RUNTIME: 0.4523
REF_RUNTIME: 1.2301
SPEEDUP: 2.7197x
REF_SOURCE: frozen baseline (measured 2026-08-15T08:29:18+00:00)
KERNEL_EVAL={"artifact": "solution/kernel.py", "compiled": true, "correct": true, "latency_ms": 0.4523, "native_metrics": {"speedup": 2.7197, "ref_runtime_ms": 1.2301}}
```

- **COMPILED** — whether the solution compiled successfully
- **CORRECT** — whether outputs match the reference (within precision tolerance)
- **RUNTIME** — solution kernel **median** execution time in milliseconds (over the recorded trials; mean/std/min/max remain in the printed stats)
- **REF_RUNTIME** — reference kernel **median** execution time in milliseconds
- **SPEEDUP** — `REF_RUNTIME / RUNTIME`
- **DEVIATION** — only when `CORRECT: False`: how far off the output was (`max_abs=… avg_abs=… failed_trials=…`, or the failure kind), so a numerics-tolerance near miss and a gross logic error are distinguishable at a glance
- **MUTATION_SENTINEL** — `PASS` / `FAIL …`, printed by the performance phase: after timing, the performance input tensors are re-randomized **in place** and the solution must still track the reference on the new values. `FAIL` forces `CORRECT: False` — a cached or replayed output cannot follow a mutated input, so the timed result did not measure computation
- **REF_SOURCE** — which regime produced `REF_RUNTIME`: the frozen baseline (with when it was measured) or a fresh measurement this run. A speedup that moved is either the kernel or the denominator, and the ratio alone cannot say which
- **KERNEL_EVAL={…}** — the kernel-opt panel's contract line. **This bench emits it itself**, so the point on the curve carries the evaluator's own numbers rather than a transcription of them: do not write a second trailer by hand for a run of this bench, or the evaluation is counted twice. `speedup` and `ref_runtime_ms` ride in `native_metrics`; a mutation-sentinel failure sets `reward_hack_detected`, while an over-threshold speedup rides `advisory` — real kernels do clear 10×, so that flag is a prompt to check, not a verdict

Exit code: `0` = correct, `1` = incorrect or failed.

## CLI Arguments

| Flag | Default | Description |
|------|---------|-------------|
| `--ref` | (required) | Path to reference kernel (must define `class Model`) |
| `--solution` | (required) | Path to optimized kernel |
| `--inputs` | (none) | Optional file defining `get_inputs()` (required) and `get_init_inputs()` (optional); overrides definitions in `--ref` |
| `--timing-method` | `cuda_event` | `cuda_event`, `host_time` |
| `--precision` | `float32` | `float32`, `float16`, `bfloat16` |
| `--backend` | auto-detected | `cuda`, `triton`, `tilelang`, `cute`, `hip` (auto-detected from solution source; pass explicitly to override — see below) |
| `--num-correct-trials` | `10` | Number of correctness check iterations |
| `--num-perf-trials` | `50` | Number of recorded performance timing iterations (first trial discarded, 10 untimed warmups; the reported statistic is the median) |
| `--baseline` | `.bench-baseline.json` | Where the reference's frozen runtime lives. Measured on the first run, reused after; re-measures by itself when the reference, machine, backend, precision, input regime, trial count or seed changes, printing which one moved. |
| `--refresh-baseline` | off | Re-time the reference and overwrite the frozen value. For a machine that may have drifted; makes iterations before and after incomparable — see above. |
| ~~`--no-ref`~~ | removed | Accepted with a warning so older scripts keep running, but it no longer does anything: the frozen baseline already skips the reference's timing phase, and still reports a speedup. |
| `--fresh-inputs` | **on** | Performance phase generates fresh input values before every timed trial (solution AND reference; tensors built outside the timed region) — no trial can be served from a value cache. `--no-fresh-inputs` restores the historical reused regime. The two regimes measure different quantities (cache-warmth meaning changes): pick one per run and never compare numbers across them. |
| `--verbose` | off | Print detailed debug info |
| `--self-test` | off | Run source transformation self-test and exit |

### Backend selection (auto-detected)

`bench.py` picks the backend by sniffing the solution source: `@triton.jit` /
`import triton` → `triton`; `import tilelang` → `tilelang`; `import cute` /
`cute_dsl` → `cute`; otherwise `cuda` (exec-based loader handling raw CUDA +
`cpp_extension.load[_inline]`). Pass `--backend <name>` only to override the
sniff — useful for explicit HIP labelling or for mixed-backend solutions
where the first match is wrong. The chosen backend is printed as
`BACKEND: <name> (auto|explicit)` in the output.

The two loaders differ in how they execute solution code: `cuda` / `hip` use
`exec()` (which rejects `@triton.jit` decorators with `@jit functions should
be defined in a Python file`), while `triton` / `tilelang` / `cute` use
tempfile + `importlib` so `@jit` source inspection works. `cuda` and `hip`
are loader-equivalent; the distinction is informational only.

| Solution language | Backend chosen |
|-------------------|----------------|
| Raw CUDA via `torch.utils.cpp_extension.load[_inline]` | `cuda` |
| Triton (`@triton.jit`) | `triton` |
| TileLang | `tilelang` |
| CuTe | `cute` |
| HIP | `cuda` (pass `--backend hip` explicitly if labelling matters) |

## Solution File Requirements

- The solution file must contain `class Model(nn.Module)` with a `forward()` method matching the reference's signature.
- The bench script handles `Model` -> `ModelNew` renaming transparently — **do not** rename the class in the solution file.
- Do not include `get_inputs()` or `get_init_inputs()` in the solution file. The bench script strips the solution's module-level tail (variables and functions following the last class) as an anti-cheat boundary — any such definitions would be silently dropped, and the solution cannot influence which inputs it is tested against.

## Correctness Tolerances

Inspired by [torchbench](https://github.com/pytorch/benchmark):

| Precision | Tolerance (atol & rtol) |
|-----------|------------------------|
| float32   | 1e-4                   |
| float16   | 1e-2                   |
| bfloat16  | 1e-2                   |

## Timing Methods

- **cuda_event** (default): Uses `torch.cuda.Event` for device-side timing. Measures cold-cache performance (L2 thrashed before each trial). Most accurate for GPU kernel time.
- **host_time**: Host-side wall-clock timing via `time.perf_counter()`. Includes Python overhead, CUDA launch costs, and synchronization. Results may be longer than device-side timings.
