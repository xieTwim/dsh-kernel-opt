#!/usr/bin/env python3
"""
Self-contained kernel benchmark — the kernel-opt plugin's built-in evaluator.

Evaluates an optimized kernel (solution) against a reference kernel. Core
logic from KernelBench's eval.py and timing.py is inlined, so nothing outside
the standard library and torch is needed at run time.

Measurement protocol (2026-08 upgrade):
- RUNTIME / REF_RUNTIME report the median over the recorded trials
  (--num-perf-trials, default 50; first trial discarded; 10 untimed warmups)
  — robust to the outlier trial a mean folds in. mean/std/min/max stay in
  the stats dict as context.
- The performance phase defaults to FRESH input values per timed trial
  (both solution and reference; tensors are built OUTSIDE the timed region):
  no trial can be served from a value cache keyed on the previous trial's
  tensors. `--no-fresh-inputs` restores the historical reused regime — the
  two regimes measure different quantities (cache-warmth meaning changes),
  so never compare numbers across them.
- After the timed trials the performance inputs are re-randomized in
  place and the solution must still track the reference on the new values
  (mutation sentinel): a solution that keys on input identity and replays a
  stored output fails instead of timing a cache hit.
- On CORRECT: False the trailer carries a DEVIATION line stating how far off
  the output was, so a numerics-tolerance miss and a logic bug are
  distinguishable from the structured output alone. Emitted only on failure —
  a margin printed on success would navigate an agent toward the tolerance
  edge.
- The reference's runtime is measured once and FROZEN in a baseline file
  (--baseline, default .bench-baseline.json), then reused by every later run
  whose reference / machine / backend / precision / input regime / trial count
  is unchanged. That is what makes every evaluation report a speedup at no
  per-iteration cost, and what makes the speedup order the same way the
  solution's own latency does — a denominator re-timed inside each evaluation
  carries its own noise, enough to invert the ranking of two kernels a
  microsecond apart. REF_SOURCE names the regime on every run.

Usage:
    python bench/kernelbench/bench.py --ref <ref-path> --solution solution/<kernel> [options]

Output (structured, one per line):
    COMPILED: True/False
    CORRECT: True/False
    RUNTIME: <ms>
    REF_RUNTIME: <ms>
    SPEEDUP: <x>
    REF_SOURCE: frozen baseline (measured <when>) | measured this run
    DEVIATION: <how wrong>   (only present when CORRECT is False)
    KERNEL_EVAL={...}        (the kernel-opt panel's contract line)

Provenance. This file is a derivative of the benchmark shipped with AKO4ALL
(https://github.com/TongmingLAIC/AKO4ALL), which in turn inlines core logic
from KernelBench (https://github.com/ScalingIntelligence/KernelBench). The
kernel-opt plugin's changes on top of the AKO4ALL version are the ones the
measurement-protocol notes above describe. Both upstreams are MIT; their
notices follow, and this file stays MIT with them.

--- AKO4ALL ---

Copyright (c) 2026 TongmingLAIC

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

--- KernelBench ---

Copyright (c) 2023 Anne Ouyang, Simon Guo, Azalia Mirhoseini

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

import argparse
import hashlib
import importlib
import importlib.util
import json
import os
import re
import statistics
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass, field
from io import StringIO
from typing import Any, Optional, Union

import torch
import torch.nn as nn


###############################################################################
# Inlined from KernelBench — timing utilities
###############################################################################


def clear_l2_cache(device: torch.device | str = "cuda"):
    """Clear L2 cache by thrashing with a large tensor (~256 MB)."""
    dummy = torch.empty((32, 1024, 1024), dtype=torch.int64, device=device)
    dummy.fill_(42)
    del dummy


def time_execution_with_cuda_event(
    kernel_fn: callable,
    args: list[Any],
    num_warmup: int = 10,
    num_trials: int = 10,
    discard_first: int = 1,
    verbose: bool = True,
    device: torch.device = None,
    inputs_factory: callable = None,
) -> list[float]:
    """
    Time a CUDA kernel over multiple trials using torch.cuda.Event.
    Measures cold-cache performance (L2 thrashed before each trial).

    `inputs_factory`, when given, is called before every timed trial and its
    return value replaces `args` for that trial — the fresh-values timing
    regime (`--fresh-inputs`, the default). Construction happens OUTSIDE the
    event window either way, so the timed region does not move; what changes
    is that no trial can be served from a value cache keyed on the previous
    trial's tensors. Warmup keeps the initial `args`: its job is JIT/autotune
    on the right shapes, and values are irrelevant to it.

    Returns list of elapsed times in milliseconds.
    """
    if device is None:
        device = torch.cuda.current_device()

    with torch.cuda.device(device):
        # Warm ups
        for _ in range(num_warmup):
            kernel_fn(*args)
            torch.cuda.synchronize(device=device)

        torch.cuda.empty_cache()

        print(
            f"[Profiling] Using device: {device} {torch.cuda.get_device_name(device)}, "
            f"warm up {num_warmup}, trials {num_trials}"
        )

        elapsed_times: list[float] = []

        for trial in range(num_trials + discard_first):
            if inputs_factory is not None:
                args = inputs_factory()
            torch.cuda.synchronize(device=device)

            start_event = torch.cuda.Event(enable_timing=True)
            end_event = torch.cuda.Event(enable_timing=True)

            clear_l2_cache(device=device)

            start_event.record()
            _ = kernel_fn(*args)
            end_event.record()

            torch.cuda.synchronize(device=device)

            elapsed_time_ms = start_event.elapsed_time(end_event)

            if trial >= discard_first:
                if verbose:
                    logical_idx = trial - discard_first + 1
                    print(f"Trial {logical_idx}: {elapsed_time_ms:.3g} ms")
                elapsed_times.append(elapsed_time_ms)

    return elapsed_times


def time_execution_with_host_time(
    kernel_fn: callable,
    args: list[Any],
    num_warmup: int = 10,
    num_trials: int = 10,
    discard_first: int = 1,
    verbose: bool = True,
    device: torch.device | None = None,
    inputs_factory: callable = None,
) -> list[float]:
    """
    Time a CUDA kernel using host-side wall-clock time (perf_counter).
    Includes Python overhead, launch costs, and synchronization.

    `inputs_factory`: same contract as the cuda_event path — fresh args per
    timed trial, built before the clock reads, warmup on the initial args.

    Returns list of elapsed times in milliseconds.
    """
    if device is None:
        device = torch.cuda.current_device()

    for _ in range(num_warmup):
        kernel_fn(*args)
        torch.cuda.synchronize(device=device)

    print(
        f"[Profiling] Using device: {device} {torch.cuda.get_device_name(device)}, "
        f"warm up {num_warmup}, trials {num_trials}"
    )

    torch.cuda.empty_cache()
    elapsed_times = []

    for trial in range(num_trials + discard_first):
        if inputs_factory is not None:
            args = inputs_factory()
        torch.cuda.synchronize(device=device)
        clear_l2_cache(device=device)

        start_time = time.perf_counter()
        kernel_fn(*args)
        torch.cuda.synchronize(device=device)
        end_time = time.perf_counter()

        elapsed_time_ms = (end_time - start_time) * 1000
        if trial >= discard_first:
            if verbose:
                logical_idx = trial - discard_first + 1
                print(f"Trial {logical_idx}: {elapsed_time_ms:.3g} ms")
            elapsed_times.append(elapsed_time_ms)

    return elapsed_times


def get_timing_function(method: str = "cuda_event") -> callable:
    """
    Return timing function by method name.

    Available: "cuda_event" (default), "host_time".
    """
    print(f"[Profiling] Using timing method: {method}")
    match method:
        case "cuda_event":
            return time_execution_with_cuda_event
        case "host_time":
            return time_execution_with_host_time
        case _:
            raise ValueError(
                f"Unsupported timing method: {method}. "
                f"Available: cuda_event, host_time"
            )


def get_timing_stats(elapsed_times: list[float], device: torch.device = None) -> dict:
    """Compute median/mean/std/min/max from a list of elapsed times (ms).

    `median` is the reported statistic (see RUNTIME in the module docstring):
    robust to the outlier trial a mean folds in. The rest stay as context —
    more recorded facts, one reported number.
    """
    median_val = statistics.median(elapsed_times)
    mean_val = statistics.mean(elapsed_times)
    std_val = statistics.stdev(elapsed_times) if len(elapsed_times) > 1 else 0.0

    stats = {
        "median": float(f"{median_val:.3g}"),
        "mean": float(f"{mean_val:.3g}"),
        "std": float(f"{std_val:.3g}"),
        "min": float(f"{min(elapsed_times):.3g}"),
        "max": float(f"{max(elapsed_times):.3g}"),
        "num_trials": len(elapsed_times),
    }

    if device:
        stats["hardware"] = torch.cuda.get_device_name(device=device)
        stats["device"] = str(device)

    return stats


###############################################################################
# Inlined from KernelBench — eval utilities
###############################################################################


@dataclass
class KernelExecResult:
    """Result of a single kernel evaluation."""

    compiled: bool = False
    correctness: bool = False
    metadata: dict = field(default_factory=dict)
    runtime: float = -1.0  # ms
    runtime_stats: dict = field(default_factory=dict)
    ref_runtime: float = -1.0  # ms
    ref_runtime_stats: dict = field(default_factory=dict)


def set_seed(seed: int):
    torch.manual_seed(seed)
    torch.cuda.manual_seed(seed)


def get_tolerance_for_precision(precision: Union[str, torch.dtype]) -> float:
    """
    Tolerance for correctness checks, inspired by torchbench.

    fp32: 1e-4, fp16/bf16: 1e-2.
    """
    if isinstance(precision, str):
        dtype_map = {
            "fp32": torch.float32,
            "float32": torch.float32,
            "fp16": torch.float16,
            "float16": torch.float16,
            "bf16": torch.bfloat16,
            "bfloat16": torch.bfloat16,
        }
        precision = dtype_map[precision]

    tolerances = {
        torch.float32: 1e-4,
        torch.float16: 1e-2,
        torch.bfloat16: 1e-2,
    }
    assert precision in tolerances, f"Unsupported precision: {precision}"
    return tolerances[precision]


def _process_input_tensor(
    inp, device, backend="cuda", precision=torch.float32
):
    """Move tensor to device with correct dtype. Non-tensors pass through."""
    if not isinstance(inp, torch.Tensor):
        return inp
    return inp.to(dtype=precision, device=device)


def get_error_name(e: Exception) -> str:
    return f"{e.__class__.__module__}.{e.__class__.__name__}"


def load_original_model_and_inputs(
    model_original_src: str, context: dict, source_path: Optional[str] = None
) -> tuple:
    """
    exec() the reference source. Returns (Model, get_init_inputs, get_inputs).

    If source_path is given, it is injected as __file__ in the exec context so
    the loaded code can use os.path.dirname(__file__) to find sibling files
    (e.g., multi-file CUDA solutions loaded via torch.utils.cpp_extension.load).
    """
    if source_path is not None:
        context["__file__"] = os.path.abspath(source_path)

    try:
        compile(model_original_src, "<string>", "exec")
    except SyntaxError as e:
        print(f"Syntax Error in original code {e}")
        return None

    try:
        exec(model_original_src, context)
    except Exception as e:
        print(f"Error in executing original code {e}")
        return None

    return (
        context.get("Model"),
        context.get("get_init_inputs"),
        context.get("get_inputs"),
    )


def load_custom_model(
    model_custom_src: str,
    context: dict,
    build_directory: str = None,
    source_path: Optional[str] = None,
) -> Optional[nn.Module]:
    """Load ModelNew via exec() (CUDA backend).

    If source_path is given, it is injected as __file__ in the exec context so
    solutions that use `os.path.dirname(__file__)` (e.g., multi-file
    `torch.utils.cpp_extension.load(sources=[...])`) can find their sibling
    files.
    """
    if source_path is not None:
        context["__file__"] = os.path.abspath(source_path)

    if build_directory:
        context["BUILD_DIRECTORY"] = build_directory
        model_custom_src = (
            "import os\n"
            f"os.environ['TORCH_EXTENSIONS_DIR'] = '{build_directory}'\n"
        ) + model_custom_src

    try:
        compile(model_custom_src, "<string>", "exec")
        exec(model_custom_src, context)
    except SyntaxError as e:
        print(f"Syntax Error in custom generated code or Compilation Error {e}")
        return None

    return context.get("ModelNew")


def load_custom_model_with_tempfile(model_custom_src, entry_point="ModelNew"):
    """Load ModelNew via tempfile + importlib (Triton/TileLang/CuTe backend)."""
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".py", delete=False
    ) as tmp_file:
        tmp_file.write(model_custom_src)
        tempfile_path = tmp_file.name
        temp_file = tmp_file

    spec = importlib.util.spec_from_file_location("temp_module", tempfile_path)
    temp_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(temp_module)

    ModelNew = getattr(temp_module, entry_point)
    return ModelNew, temp_file


def graceful_eval_cleanup(
    curr_context: dict,
    device: torch.device,
    temp_file=None,
):
    """Clean up GPU cache and optional tempfile after evaluation."""
    del curr_context
    with torch.cuda.device(device):
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats(device=device)
        torch.cuda.synchronize(device=device)
    if temp_file:
        temp_file.close()
        os.remove(temp_file.name)


def register_and_format_exception(
    exception_type: str,
    exception_msg,
    metadata: dict,
    verbose: bool = False,
    truncate=False,
    max_length=200,
):
    exception_str = str(exception_msg)
    if truncate and len(exception_str) > max_length:
        exception_str = exception_str[: max_length - 3] + "..."
    if verbose:
        print(f"[Exception {exception_type}] {exception_str}")
    metadata[exception_type] = exception_str
    return metadata


def run_and_check_correctness(
    original_model_instance: nn.Module,
    new_model_instance: nn.Module,
    get_inputs_fn: callable,
    metadata: dict,
    num_correct_trials: int,
    verbose: bool = False,
    seed: int = 42,
    device: Optional[torch.device] = None,
    backend: str = "cuda",
    precision: torch.dtype = torch.float32,
) -> KernelExecResult:
    """Run model and check correctness over multiple random-input trials."""
    pass_count = 0

    torch.manual_seed(seed)
    correctness_trial_seeds = [
        torch.randint(0, 2**32 - 1, (1,)).item()
        for _ in range(num_correct_trials)
    ]

    with torch.no_grad():
        for trial in range(num_correct_trials):
            trial_seed = correctness_trial_seeds[trial]
            if verbose:
                print(f"[Eval] Generating Random Input with seed {trial_seed}")

            set_seed(trial_seed)
            inputs = get_inputs_fn()
            inputs = [
                _process_input_tensor(x, device, backend, precision) for x in inputs
            ]

            set_seed(trial_seed)
            model = original_model_instance.to(device=device, dtype=precision)

            set_seed(trial_seed)
            model_new = new_model_instance.to(device=device, dtype=precision)

            output = model(*inputs)
            torch.cuda.synchronize(device=device)

            try:
                output_new = model_new(*inputs)
                torch.cuda.synchronize(device=device)

                if output.shape != output_new.shape:
                    metadata = register_and_format_exception(
                        "correctness_issue",
                        f"Output shape mismatch: Expected {output.shape}, got {output_new.shape}",
                        metadata,
                    )
                    metadata["correctness_issue_name"] = "correctness_issue"
                    if verbose:
                        print(
                            f"[FAIL] trial {trial}: Output shape mismatch: "
                            f"Expected {output.shape}, got {output_new.shape}"
                        )
                    return KernelExecResult(
                        compiled=True, correctness=False, metadata=metadata
                    )

                tolerance = get_tolerance_for_precision(precision)
                if not torch.allclose(
                    output, output_new, atol=tolerance, rtol=tolerance
                ):
                    max_diff = torch.max(torch.abs(output - output_new)).item()
                    avg_diff = torch.mean(torch.abs(output - output_new)).item()
                    metadata.setdefault("max_difference", []).append(
                        f"{max_diff:.3e}"
                    )
                    metadata.setdefault("avg_difference", []).append(
                        f"{avg_diff:.3e}"
                    )
                    metadata["correctness_issue"] = "Output mismatch"
                    if verbose:
                        print(f"[FAIL] trial {trial}: Output mismatch")
                else:
                    pass_count += 1
                    if verbose:
                        print(f"[PASS] trial {trial}: New Model matches Model")

            except Exception as e:
                print("[Error] Exception happens during correctness check")
                print(f"Error in launching kernel for ModelNew: {e}")
                print("\n[Full Traceback]:")
                traceback.print_exc()
                print()

                metadata = register_and_format_exception(
                    "runtime_error", e, metadata, truncate=True
                )
                metadata["runtime_error_name"] = get_error_name(e)
                metadata["runtime_error_traceback"] = traceback.format_exc()
                return KernelExecResult(
                    compiled=True, correctness=False, metadata=metadata
                )

    if verbose:
        print(
            f"[Eval] Pass count: {pass_count}, num_correct_trials: {num_correct_trials}"
        )

    metadata["correctness_trials"] = f"({pass_count} / {num_correct_trials})"

    if pass_count == num_correct_trials:
        return KernelExecResult(compiled=True, correctness=True, metadata=metadata)
    else:
        return KernelExecResult(compiled=True, correctness=False, metadata=metadata)


# ---------------------------------------------------------------------------
# Reference baseline cache
# ---------------------------------------------------------------------------
#
# The reference is invariant across solution edits, so its runtime is measured
# ONCE per (reference, machine, measurement regime) and then frozen for the
# rest of the optimization run. Two things follow, and the second is why this
# is a comparability device and not merely a cache:
#
#   * the reference's timing phase stops costing anything per iteration — the
#     entire saving the old --no-ref switch bought, except SPEEDUP survives,
#     so there is no longer a reason to run without a speedup at all; and
#   * SPEEDUP becomes monotone in the solution's own latency. A denominator
#     re-timed inside every evaluation carries its own noise on top of the
#     solution's, which is how a 453µs solution comes back x3.60 while a
#     454µs one comes back x3.61 — the ranking inverts on reference jitter.
#
# Every iteration of one run therefore divides by the same number. The key
# below is what keeps that honest: a different reference, machine, backend,
# precision, input regime or trial count is a different measurement and
# re-measures instead of reusing. The one risk a frozen denominator carries is
# machine drift within a run (thermal throttling, a noisy neighbour): the
# ratio no longer cancels it out. `--refresh-baseline` is the answer when that
# is suspected, and REF_SOURCE states on every run which regime produced the
# number.

BASELINE_SCHEMA = 1
DEFAULT_BASELINE_PATH = ".bench-baseline.json"


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _baseline_key(
    ref_src: str,
    inputs_src: Optional[str],
    hardware: str,
    backend: str,
    precision: torch.dtype,
    fresh_inputs: bool,
    num_perf_trials: int,
    timing_method: str,
    seed_num: int,
) -> dict:
    """Everything a cached reference runtime is only valid under."""
    return {
        "schema": BASELINE_SCHEMA,
        "ref_sha256": _sha256(ref_src),
        "inputs_sha256": _sha256(inputs_src) if inputs_src else None,
        "hardware": hardware,
        "backend": backend,
        "precision": str(precision),
        "fresh_inputs": bool(fresh_inputs),
        "num_perf_trials": int(num_perf_trials),
        "timing_method": timing_method,
        "seed": int(seed_num),
    }


def _load_baseline(path: str, key: dict) -> Optional[dict]:
    """The cached reference runtime, or None with the reason printed.

    A mismatch is never silent: an agent that sees its speedup move needs to
    know whether the kernel changed or the denominator did.
    """
    if not path or not os.path.exists(path):
        return None
    try:
        with open(path) as f:
            entry = json.load(f)
    except (OSError, ValueError) as e:
        print(f"[Baseline] {path} unreadable ({e}); re-measuring the reference.")
        return None
    cached_key = entry.get("key", {})
    for field_name, want in key.items():
        got = cached_key.get(field_name)
        if got != want:
            shown = "ref source" if field_name == "ref_sha256" else field_name
            if field_name.endswith("_sha256"):
                print(f"[Baseline] {shown} changed; re-measuring the reference.")
            else:
                print(f"[Baseline] {shown} changed ({got} -> {want}); re-measuring the reference.")
            return None
    if not isinstance(entry.get("ref_runtime_ms"), (int, float)) or entry["ref_runtime_ms"] <= 0:
        print(f"[Baseline] {path} holds no usable reference runtime; re-measuring.")
        return None
    return entry


def _save_baseline(path: str, key: dict, ref_runtime_ms: float, stats: dict) -> None:
    """Write the frozen denominator via tmp+rename, so a crash never truncates it."""
    if not path:
        return
    entry = {
        "key": key,
        "ref_runtime_ms": ref_runtime_ms,
        "ref_runtime_stats": stats,
        "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    tmp = path + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(entry, f, indent=2)
        os.replace(tmp, path)
        print(f"[Baseline] reference timed and frozen in {path} "
              f"({ref_runtime_ms:.4f} ms) — later runs reuse it.")
    except OSError as e:
        print(f"[Baseline] could not write {path} ({e}); the reference will be "
              f"re-timed every run.")


def eval_kernel_against_ref(
    original_model_src: str,
    custom_model_src: str,
    seed_num: int = 42,
    num_correct_trials: int = 1,
    num_perf_trials: int = 10,
    measure_performance: bool = False,
    timing_method: str = "cuda_event",
    verbose: bool = False,
    build_dir: os.PathLike = None,
    device: Union[torch.device, int] = None,
    backend: str = "cuda",
    precision: torch.dtype = torch.float32,
    check_for_excessive_speedup: bool = True,
    excessive_speedup_threshold: float = 10,
    get_inputs_override: Optional[callable] = None,
    get_init_inputs_override: Optional[callable] = None,
    ref_path: Optional[str] = None,
    sol_path: Optional[str] = None,
    fresh_inputs: bool = False,
    baseline_path: Optional[str] = DEFAULT_BASELINE_PATH,
    refresh_baseline: bool = False,
    inputs_src: Optional[str] = None,
) -> KernelExecResult:
    """
    Evaluate a custom kernel against the reference model.

    Compiles and loads both models, checks correctness, and optionally
    measures performance (timing + speedup).

    The reference's runtime is measured once and frozen in `baseline_path`
    (see the baseline-cache section above): every iteration gets a REF_RUNTIME
    and a SPEEDUP without paying to re-time the reference, and the speedup
    orders the same way the solution's own latency does. `refresh_baseline`
    forces a fresh measurement — use it when the machine may have drifted.
    Correctness still runs the reference num_correct_trials times; only the
    timing phase is cached.

    If `get_inputs_override` / `get_init_inputs_override` are provided, they
    take precedence over any definitions found inside `original_model_src`.

    If `ref_path` / `sol_path` are provided, they are injected as `__file__`
    into the respective exec contexts so code that uses
    `os.path.dirname(__file__)` to find sibling files (e.g. multi-file
    `cpp_extension.load(sources=[...])`) works. Only effective for the CUDA
    backend (exec-based loader); Triton/TileLang/CuTe backends load via
    tempfile so `__file__` already points at a real `.py` (but the tempfile
    path, not the original source).

    `fresh_inputs=True` switches the performance phase to fresh values per
    timed trial (both solution and reference timing), the
    `performance_values: "fresh"` regime — the CLI defaults to it; pass
    --no-fresh-inputs for the historical reused regime. It closes the
    value-cache seam the reused pool leaves open (a version-guarded cache
    can time as a hit under reuse while still answering correctly under
    mutation), at the cost of per-trial input generation walltime and a
    changed cache-warmth meaning. The timed region itself does not move:
    factories run outside the event window.
    """
    assert torch.cuda.is_available(), "CUDA is not available, cannot run Eval"

    if device is None:
        device = torch.cuda.current_device()

    torch.set_printoptions(
        precision=4, threshold=10, edgeitems=3, linewidth=80
    )

    torch.cuda.set_device(device)

    uses_tempfile = backend.lower() in ["triton", "tilelang", "cute"]

    metadata = {}
    metadata["hardware"] = torch.cuda.get_device_name(device=device)
    metadata["device"] = str(device)

    if uses_tempfile:
        if isinstance(device, int):
            device_num = device
        elif isinstance(device, torch.device):
            assert device.type == "cuda", "CUDA is not available on device"
            device_num = device.index
        else:
            raise ValueError(
                f"device must be an int or torch.device, got {type(device)}"
            )
        os.environ["CUDA_VISIBLE_DEVICES"] = str(device_num)

    context = {}

    if verbose:
        print(f"[Eval] Start Evaluation! on device: {device}")
        print("[Eval] Loading Original Model")

    Model, ref_get_init_inputs, ref_get_inputs = load_original_model_and_inputs(
        original_model_src, context, source_path=ref_path
    )

    # Override chain: explicit override > definition inside reference file.
    # get_inputs is required (no sensible default); get_init_inputs defaults to [].
    get_inputs = (
        get_inputs_override if get_inputs_override is not None else ref_get_inputs
    )
    get_init_inputs = (
        get_init_inputs_override
        if get_init_inputs_override is not None
        else ref_get_init_inputs
    )

    if get_inputs is None:
        msg = (
            "get_inputs() not found. Define it in the reference file or pass "
            "--inputs <file> with a top-level get_inputs() function."
        )
        print(f"[Eval] {msg}")
        metadata["error"] = "missing_get_inputs"
        metadata["error_message"] = msg
        return KernelExecResult(compiled=False, metadata=metadata)

    set_seed(seed_num)
    init_inputs = [] if get_init_inputs is None else get_init_inputs()
    init_inputs = [
        _process_input_tensor(x, device, backend, precision) for x in init_inputs
    ]

    with torch.no_grad():
        set_seed(seed_num)
        original_model = Model(*init_inputs)
        assert hasattr(original_model, "forward")
        if verbose:
            print("[Eval] Original Model Loaded")

    if verbose:
        print("[Eval] Loading and Compiling New Model with Custom CUDA Kernel")

    # Compilation
    try:
        os.environ["TORCH_USE_CUDA_DSA"] = "1"
        temp_file = None

        if backend.lower() in ["triton", "tilelang", "cute"]:
            ModelNew, temp_file = load_custom_model_with_tempfile(
                custom_model_src, entry_point="ModelNew"
            )
        else:
            ModelNew = load_custom_model(
                custom_model_src, context, build_dir, source_path=sol_path
            )
        torch.cuda.synchronize(device=device)
    except Exception as e:
        print(
            f"Failed to compile custom CUDA kernel: Record as compilation failure.\nError: {e}"
        )
        if "lock" in str(e) or "No such file or directory" in str(e):
            print(f"[Eval] Lock file error during compilation, Please retry. Error: {e}")
            graceful_eval_cleanup(context, device, temp_file)
            return None
        else:
            metadata["compilation_error_name"] = get_error_name(e)
            metadata["compilation_error"] = str(e)
            graceful_eval_cleanup(context, device, temp_file)
            return KernelExecResult(compiled=False, metadata=metadata)

    if ModelNew is None:
        print(
            "Failed to load custom model: Syntax error or ModelNew not found. "
            "Record as compilation failure."
        )
        metadata["compilation_error_name"] = "SyntaxError"
        metadata["compilation_error"] = (
            "Syntax error in custom generated code or ModelNew not found"
        )
        graceful_eval_cleanup(context, device, temp_file)
        return KernelExecResult(compiled=False, metadata=metadata)

    # Instantiate custom model
    try:
        with torch.no_grad():
            set_seed(seed_num)
            custom_model = ModelNew(*init_inputs)
            assert hasattr(custom_model, "forward")
            original_model = original_model.to(device=device, dtype=precision)
            custom_model = custom_model.to(device=device, dtype=precision)
            torch.cuda.synchronize(device=device)
        if verbose:
            print("[Eval] New Model with Custom CUDA Kernel Loaded")
    except RuntimeError as e:
        print(
            f"Failed to load custom CUDA kernel; Compiled but not able to run.\nError: {e}"
        )
        graceful_eval_cleanup(context, device, temp_file)
        metadata["runtime_error"] = str(e)
        metadata["runtime_error_name"] = get_error_name(e)
        return KernelExecResult(compiled=True, correctness=False, metadata=metadata)

    # Correctness
    kernel_exec_result = None
    if verbose:
        print("[Eval] Checking Correctness")
    try:
        kernel_exec_result = run_and_check_correctness(
            original_model,
            custom_model,
            get_inputs,
            metadata=metadata,
            num_correct_trials=num_correct_trials,
            verbose=verbose,
            seed=seed_num,
            device=device,
            backend=backend,
            precision=precision,
        )
    except Exception as e:
        metadata["runtime_error"] = str(e)
        metadata["runtime_error_name"] = get_error_name(e)
        kernel_exec_result = KernelExecResult(
            compiled=True, correctness=False, metadata=metadata
        )

    # Performance measurement
    if measure_performance:
        try:
            if kernel_exec_result and kernel_exec_result.correctness:
                if verbose:
                    print("[Eval] Measuring Performance as Sample is Correct")

                torch.cuda.synchronize(device=device)
                set_seed(seed_num)
                inputs = get_inputs()
                inputs = [
                    _process_input_tensor(x, device, backend, precision)
                    for x in inputs
                ]

                model_new = custom_model.to(device=device, dtype=precision)
                torch.cuda.synchronize(device=device)

                # The fresh-values regime: new tensors before every timed
                # trial, drawn from the seeded stream (deterministic
                # sequence), built outside the event window. None under the
                # reused regime — the loop then behaves exactly as it
                # always has.
                inputs_factory = None
                if fresh_inputs:
                    def inputs_factory():
                        fresh = get_inputs()
                        return [
                            _process_input_tensor(x, device, backend, precision)
                            for x in fresh
                        ]

                timing_fn = get_timing_function(timing_method)
                elapsed_times = timing_fn(
                    model_new,
                    inputs,
                    num_trials=num_perf_trials,
                    verbose=verbose,
                    device=device,
                    inputs_factory=inputs_factory,
                )
                runtime_stats = get_timing_stats(elapsed_times, device=device)

                if verbose:
                    print(f"[Eval] Performance Stats: {runtime_stats}")
                kernel_exec_result.runtime = runtime_stats["median"]
                kernel_exec_result.runtime_stats = runtime_stats

                # Mutation sentinel (untimed). The timed loop reuses ONE input
                # tensor for every trial, so a solution can key on tensor
                # identity and replay a stored output — the timed result then
                # measures a cache hit, under either timing method.
                #
                # The mutation is a full in-place re-randomize of the SAME
                # tensor objects, deliberately non-affine: normalization-family
                # tasks are invariant to per-row affine changes (x*a+b shifts
                # mean/std, output unchanged), so "add a constant" would be a
                # blind sentinel. It runs AFTER timing, so it costs zero timed
                # trials and cannot touch the measurement.
                sentinel_mutated = False
                with torch.no_grad():
                    for x in inputs:
                        if isinstance(x, torch.Tensor) and x.is_floating_point():
                            x.copy_(torch.randn_like(x))
                            sentinel_mutated = True
                if sentinel_mutated:
                    original_on_device = original_model.to(
                        device=device, dtype=precision
                    )
                    torch.cuda.synchronize(device=device)
                    with torch.no_grad():
                        sentinel_new = model_new(*inputs)
                        sentinel_ref = original_on_device(*inputs)
                    torch.cuda.synchronize(device=device)
                    sentinel_tol = get_tolerance_for_precision(precision)
                    if torch.allclose(
                        sentinel_ref, sentinel_new,
                        atol=sentinel_tol, rtol=sentinel_tol,
                    ):
                        kernel_exec_result.metadata["mutation_sentinel"] = "pass"
                        print("MUTATION_SENTINEL: PASS")
                    else:
                        diff = (sentinel_ref - sentinel_new).abs()
                        max_abs = diff.max().item()
                        avg_abs = diff.mean().item()
                        kernel_exec_result.correctness = False
                        kernel_exec_result.metadata["mutation_sentinel"] = "fail"
                        print(
                            f"MUTATION_SENTINEL: FAIL max_abs={max_abs:.3e} "
                            f"avg_abs={avg_abs:.3e}"
                        )
                        print(
                            "[Error] Mutation sentinel: after an in-place change "
                            "to the performance-phase input, the solution's "
                            "output no longer tracks the reference. A cached or "
                            "replayed output cannot follow a mutated input; the "
                            "timed result does not measure computation."
                        )

        except Exception as e:
            if verbose:
                print(f"[Eval] Error in Measuring Performance: {e}")
            kernel_exec_result.metadata["error_during_performance"] = str(e)

    # Reference timing (the speedup denominator) + the excessive-speedup
    # reward-hack flag, which needs the ref/solution ratio. The reference is
    # invariant across solution edits, so it is timed once and frozen — see
    # the baseline-cache section. Nothing here is optional any more: an
    # evaluation that measured a kernel always reports what it beat.
    if measure_performance and check_for_excessive_speedup:
        baseline_key = _baseline_key(
            ref_src=original_model_src,
            inputs_src=inputs_src,
            hardware=metadata["hardware"],
            backend=backend,
            precision=precision,
            fresh_inputs=fresh_inputs,
            num_perf_trials=num_perf_trials,
            timing_method=timing_method,
            seed_num=seed_num,
        )
        cached = None if refresh_baseline else _load_baseline(baseline_path, baseline_key)

        if cached is not None:
            kernel_exec_result.ref_runtime = cached["ref_runtime_ms"]
            kernel_exec_result.ref_runtime_stats = cached.get("ref_runtime_stats", {})
            kernel_exec_result.metadata["baseline_source"] = "cached"
            kernel_exec_result.metadata["baseline_measured_at"] = cached.get("measured_at", "")
        else:
            if verbose:
                print("[Eval] Timing the reference to establish the baseline")

            torch.cuda.synchronize(device=device)
            set_seed(seed_num)
            inputs = get_inputs()
            inputs = [
                _process_input_tensor(x, device, backend, precision) for x in inputs
            ]

            torch.cuda.synchronize(device=device)

            # Same regime for the denominator as for the numerator: a speedup
            # whose two sides ran under different input policies would not be a
            # ratio of like things.
            reference_factory = None
            if fresh_inputs:
                def reference_factory():
                    fresh = get_inputs()
                    return [
                        _process_input_tensor(x, device, backend, precision)
                        for x in fresh
                    ]

            timing_fn = get_timing_function(timing_method)
            reference_elapsed_times = timing_fn(
                original_model,
                inputs,
                num_trials=num_perf_trials,
                verbose=verbose,
                device=device,
                inputs_factory=reference_factory,
            )
            reference_runtime_stats = get_timing_stats(
                reference_elapsed_times, device=device
            )
            kernel_exec_result.ref_runtime = reference_runtime_stats["median"]
            kernel_exec_result.ref_runtime_stats = reference_runtime_stats
            kernel_exec_result.metadata["baseline_source"] = "measured"
            _save_baseline(
                baseline_path, baseline_key,
                reference_runtime_stats["median"], reference_runtime_stats,
            )

        # A failed or unmeasured solution has no ratio to check — the
        # denominator is still valid and stays recorded.
        effective_speedup = (
            kernel_exec_result.ref_runtime / kernel_exec_result.runtime
            if kernel_exec_result.runtime and kernel_exec_result.runtime > 0
            else -1
        )

        if verbose and effective_speedup > 0:
            print(
                f"[Eval] Effective Speedup is {effective_speedup:.2f}x "
                f"using timing method {timing_method}"
            )

        if effective_speedup > excessive_speedup_threshold:
            kernel_exec_result.metadata["excessive_speedup"] = True
            kernel_exec_result.metadata["excessive_speedup_threshold"] = excessive_speedup_threshold
            print(
                f"[WARNING] Excessive speedup {effective_speedup:.2f}x "
                f"over {excessive_speedup_threshold}x threshold detected"
            )
            print(
                "[WARNING] Double check your kernel carefully to ensure "
                "it is not reward hacking."
            )

    graceful_eval_cleanup(context, device, temp_file)
    return kernel_exec_result


###############################################################################
# Source transformation (from original kernelbench-bench.py)
###############################################################################


def read_file(path: str) -> str:
    with open(path, "r") as f:
        return f.read()


def rename_model_to_modelnew(src: str) -> str:
    """
    Rename `class Model(...)` -> `class ModelNew(...)` in solution source.
    Also renames `super(Model, self)` -> `super(ModelNew, self)`.
    """
    if re.search(r"\bclass\s+ModelNew\b", src):
        return src  # already has ModelNew

    src = re.sub(r"\bclass\s+Model\s*\(", "class ModelNew(", src)
    src = re.sub(r"\bsuper\s*\(\s*Model\s*,", "super(ModelNew,", src)
    return src


def _find_tail_section(src: str) -> int:
    """
    Find character offset where the "tail section" begins (module-level code
    after the *last* class body: variables like N=2048, get_inputs(),
    get_init_inputs()).
    """
    lines = src.split("\n")
    last_class_idx = -1

    for i, line in enumerate(lines):
        if re.match(r"^class\s+", line):
            last_class_idx = i

    if last_class_idx == -1:
        return len(src)

    for i in range(last_class_idx + 1, len(lines)):
        line = lines[i]
        if line.strip() == "" or (line and line[0] in (" ", "\t")):
            continue
        return sum(len(l) + 1 for l in lines[:i])

    return len(src)


def prepare_solution_source(sol_src: str) -> str:
    """
    Prepare solution source for eval:
    1. Rename class Model -> class ModelNew
    2. Strip solution's tail section (module-level vars, get_inputs,
       get_init_inputs, etc.).

    The tail strip is the anti-cheat boundary: get_inputs / get_init_inputs
    come from the reference file or the --inputs file, never from the solution.
    Stripping prevents the solution (which is exec'd into the same context as
    the reference) from silently overriding them.
    """
    modified = rename_model_to_modelnew(sol_src)
    sol_tail_start = _find_tail_section(modified)
    return modified[:sol_tail_start].rstrip() + "\n"


def _auto_detect_backend(sol_src: str) -> str:
    """Pick backend from solution source. Conservative — defaults to cuda.

    The `cuda` return also covers HIP at the loader level (both go through the
    exec-based path); pass `--backend hip` explicitly if labelling matters.
    """
    if "@triton.jit" in sol_src or "import triton" in sol_src:
        return "triton"
    if "import tilelang" in sol_src:
        return "tilelang"
    if "import cute" in sol_src or "cute_dsl" in sol_src:
        return "cute"
    return "cuda"


def load_inputs_module(path: str) -> tuple[Optional[callable], Optional[callable]]:
    """
    Load `get_inputs` (required) and `get_init_inputs` (optional) from an
    external Python file. Used when the user supplies `--inputs <file>` to
    decouple test-input definition from the reference kernel file.

    Returns (get_inputs, get_init_inputs). The latter may be None.
    """
    spec = importlib.util.spec_from_file_location("ako_inputs_module", path)
    if spec is None or spec.loader is None:
        raise ValueError(f"Cannot load inputs module from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    get_inputs = getattr(module, "get_inputs", None)
    get_init_inputs = getattr(module, "get_init_inputs", None)

    if get_inputs is None:
        raise ValueError(
            f"Inputs file {path} must define a top-level get_inputs() function"
        )

    return get_inputs, get_init_inputs


###############################################################################
# Self-test for source transformation
###############################################################################


def _self_test():
    """Verify source transformation and inputs-loading logic."""
    sol = '''import torch
import torch.nn as nn

class Model(nn.Module):
    def __init__(self):
        super(Model, self).__init__()

    def forward(self, x):
        return x * 3

N = 4096

def get_inputs():
    return [torch.randn(N)]

def get_init_inputs():
    return [42]
'''
    result = prepare_solution_source(sol)

    # Must have ModelNew, not Model
    assert "class ModelNew(" in result, "ModelNew rename failed"
    assert "class Model(" not in result, "Original Model class still present"
    assert "super(ModelNew," in result, "super() rename failed"

    # Solution tail must be stripped — anti-cheat boundary
    assert "N = 4096" not in result, "Solution's N must not leak"
    assert "def get_inputs" not in result, "Solution's get_inputs must be stripped"
    assert "def get_init_inputs" not in result, (
        "Solution's get_init_inputs must be stripped"
    )
    assert "return [42]" not in result, "Solution's get_init_inputs body must be stripped"

    print("Self-test PASSED: source transformation is correct.")

    # --- Multi-class regression (issue #7) ---
    sol_multi = '''import torch
import torch.nn as nn

class Helper(nn.Module):
    def forward(self, x):
        return x

def helper_fn():
    pass

class Model(nn.Module):
    def __init__(self):
        super(Model, self).__init__()

    def forward(self, x):
        return x * 3

N = 4096

def get_inputs():
    return [torch.randn(N)]

def get_init_inputs():
    return [42]
'''
    result_multi = prepare_solution_source(sol_multi)
    assert "class Helper(" in result_multi, "Helper class should be preserved"
    assert "class ModelNew(" in result_multi, "ModelNew rename failed (multi-class)"
    assert "def helper_fn" in result_multi, "helper_fn should be preserved"
    assert "N = 4096" not in result_multi, "Solution's N must not leak (multi-class)"
    assert "def get_inputs" not in result_multi, (
        "Solution's get_inputs must be stripped (multi-class)"
    )
    assert "return [42]" not in result_multi, (
        "Solution's get_init_inputs body must be stripped"
    )
    print("Self-test PASSED: multi-class transformation is correct (issue #7).")

    # --- No-class edge case ---
    no_class_src = "import torch\nN = 1\n"
    assert _find_tail_section(no_class_src) == len(no_class_src), \
        "No class: entire source should be kept (offset == len)"
    print("Self-test PASSED: no-class edge case.")

    # --- load_inputs_module: both get_inputs and get_init_inputs ---
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(
            "def get_inputs():\n"
            "    return [1, 2, 3]\n"
            "\n"
            "def get_init_inputs():\n"
            "    return ['a']\n"
        )
        tmp_path = f.name
    try:
        gi, gii = load_inputs_module(tmp_path)
        assert gi() == [1, 2, 3], "load_inputs_module: get_inputs return mismatch"
        assert gii() == ["a"], "load_inputs_module: get_init_inputs return mismatch"
        print("Self-test PASSED: load_inputs_module (both functions).")
    finally:
        os.remove(tmp_path)

    # --- load_inputs_module: get_inputs only ---
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write("def get_inputs():\n    return [42]\n")
        tmp_path = f.name
    try:
        gi, gii = load_inputs_module(tmp_path)
        assert gi() == [42]
        assert gii is None, "get_init_inputs should be None when absent"
        print("Self-test PASSED: load_inputs_module (get_inputs only).")
    finally:
        os.remove(tmp_path)

    # --- load_inputs_module: missing get_inputs must raise ---
    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write("def get_init_inputs():\n    return []\n")
        tmp_path = f.name
    try:
        try:
            load_inputs_module(tmp_path)
            assert False, "Should have raised for missing get_inputs"
        except ValueError as e:
            assert "get_inputs" in str(e)
        print("Self-test PASSED: load_inputs_module rejects missing get_inputs.")
    finally:
        os.remove(tmp_path)


###############################################################################
# CLI
###############################################################################


def main():
    parser = argparse.ArgumentParser(
        description="Evaluate optimized kernel against reference (self-contained KernelBench)"
    )
    parser.add_argument(
        "--ref",
        default=None,
        help="Path to reference kernel (with class Model). "
             "Required unless --self-test is given.",
    )
    parser.add_argument(
        "--solution",
        default=None,
        help="Path to optimized kernel (with class Model - renamed automatically). "
             "Required unless --self-test is given.",
    )
    parser.add_argument(
        "--inputs",
        default=None,
        help="Optional path to a separate Python file defining get_inputs() "
             "(required) and get_init_inputs() (optional). When provided, "
             "these override any definitions found in --ref.",
    )
    parser.add_argument(
        "--timing-method",
        default="cuda_event",
        choices=["cuda_event", "host_time"],
        help="GPU timing method (default: cuda_event)",
    )
    parser.add_argument(
        "--precision",
        default="float32",
        choices=["float32", "float16", "bfloat16"],
        help="Precision for evaluation (default: float32)",
    )
    parser.add_argument(
        "--backend",
        default=None,
        choices=["cuda", "triton", "tilelang", "cute", "hip"],
        help="Backend for kernel compilation. Auto-detected from solution source if omitted.",
    )
    parser.add_argument(
        "--num-correct-trials",
        type=int,
        default=10,
        help="Number of correctness trials (default: 10)",
    )
    parser.add_argument(
        "--num-perf-trials",
        type=int,
        default=50,
        help="Number of performance trials (default: 50)",
    )
    parser.add_argument(
        "--baseline",
        default=DEFAULT_BASELINE_PATH,
        help=f"Where the reference's frozen runtime lives (default: "
             f"{DEFAULT_BASELINE_PATH}). Measured on the first run and reused "
             f"after, so every later evaluation reports a SPEEDUP without "
             f"paying to re-time the reference — and the speedup orders the "
             f"same way the solution's own latency does. Re-measures by itself "
             f"when the reference, machine, backend, precision, input regime or "
             f"trial count changes.",
    )
    parser.add_argument(
        "--refresh-baseline",
        action="store_true",
        help="Re-time the reference and overwrite the frozen baseline. For when "
             "the machine itself may have drifted (thermal throttling, a noisy "
             "neighbour) — that is the one thing a frozen denominator cannot "
             "cancel out.",
    )
    parser.add_argument(
        "--no-ref",
        action="store_true",
        help=argparse.SUPPRESS,  # removed; accepted so older scripts keep running
    )
    parser.add_argument(
        "--fresh-inputs",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Performance phase generates fresh input values before every timed "
             "trial (both solution and reference) instead of reusing one tensor "
             "set — the performance_values: 'fresh' regime, the default. It "
             "closes the value-cache seam input reuse leaves open, at the cost "
             "of per-trial generation walltime and a changed cache-warmth "
             "meaning; the timed region does not move. --no-fresh-inputs "
             "restores the historical reused regime (numbers from the two "
             "regimes are different quantities — never compare across them).",
    )
    parser.add_argument(
        "--verbose", action="store_true", help="Enable verbose output"
    )
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="Run source transformation self-test and exit",
    )

    args = parser.parse_args()

    if args.self_test:
        _self_test()
        sys.exit(0)

    if args.ref is None or args.solution is None:
        parser.error("--ref and --solution are required (unless --self-test is given)")

    precision_map = {
        "float32": torch.float32,
        "float16": torch.float16,
        "bfloat16": torch.bfloat16,
    }
    precision = precision_map[args.precision]

    if args.no_ref:
        print(
            "[Warning] --no-ref no longer does anything and will be dropped. It "
            "existed to skip the reference's timing phase; the frozen baseline "
            "(--baseline) skips exactly that, for every run after the first, "
            "and still reports a SPEEDUP.",
            file=sys.stderr,
        )

    ref_src = read_file(args.ref)
    sol_src = read_file(args.solution)
    inputs_src = read_file(args.inputs) if args.inputs else None

    if args.backend is None:
        args.backend = _auto_detect_backend(sol_src)
        backend_origin = "auto"
    else:
        backend_origin = "explicit"

    modified_sol_src = prepare_solution_source(sol_src)

    get_inputs_override = None
    get_init_inputs_override = None
    if args.inputs:
        get_inputs_override, get_init_inputs_override = load_inputs_module(args.inputs)
        if args.verbose:
            print(f"[Inputs] Loaded get_inputs from {args.inputs}")
            if get_init_inputs_override is not None:
                print(f"[Inputs] Loaded get_init_inputs from {args.inputs}")

    if args.verbose:
        print("=" * 60)
        print("REFERENCE SOURCE:")
        print("=" * 60)
        print(ref_src[:500], "..." if len(ref_src) > 500 else "")
        print()
        print("=" * 60)
        print("MODIFIED SOLUTION SOURCE:")
        print("=" * 60)
        print(modified_sol_src[:500], "..." if len(modified_sol_src) > 500 else "")
        print()

    result: KernelExecResult = eval_kernel_against_ref(
        original_model_src=ref_src,
        custom_model_src=modified_sol_src,
        num_correct_trials=args.num_correct_trials,
        num_perf_trials=args.num_perf_trials,
        measure_performance=True,
        timing_method=args.timing_method,
        verbose=args.verbose,
        backend=args.backend,
        precision=precision,
        get_inputs_override=get_inputs_override,
        get_init_inputs_override=get_init_inputs_override,
        ref_path=args.ref,
        sol_path=args.solution,
        fresh_inputs=args.fresh_inputs,
        baseline_path=args.baseline,
        refresh_baseline=args.refresh_baseline,
        inputs_src=inputs_src,
    )

    if result is None:
        print("COMPILED: False")
        print("CORRECT: False")
        print(f"BACKEND: {args.backend} ({backend_origin})")
        print("RUNTIME: -1")
        print("REF_RUNTIME: -1")
        print("SPEEDUP: -1")
        print("ERROR: eval_kernel_against_ref returned None (possible lock file error)")
        sys.exit(1)

    runtime_ms = result.runtime if result.runtime > 0 else -1
    ref_runtime_ms = result.ref_runtime if result.ref_runtime > 0 else -1

    if runtime_ms > 0 and ref_runtime_ms > 0:
        speedup = ref_runtime_ms / runtime_ms
    else:
        speedup = -1

    print(f"COMPILED: {result.compiled}")
    print(f"CORRECT: {result.correctness}")
    if not result.correctness and result.metadata:
        # Say HOW wrong, only on failure (module docstring): an agent told
        # only "wrong" cannot tell a numerics problem (3e-4) from a logic
        # bug (17), and the two point at opposite fixes.
        md = result.metadata
        if md.get("max_difference"):
            worst = max(float(v) for v in md["max_difference"])
            avg_part = ""
            if md.get("avg_difference"):
                avg_part = f" avg_abs={max(float(v) for v in md['avg_difference']):.3e}"
            print(
                f"DEVIATION: max_abs={worst:.3e}{avg_part} "
                f"failed_trials={len(md['max_difference'])}"
            )
        elif md.get("correctness_issue"):
            print(f"DEVIATION: {md['correctness_issue']}")
    print(f"BACKEND: {args.backend} ({backend_origin})")
    print(f"RUNTIME: {runtime_ms:.4f}" if runtime_ms > 0 else "RUNTIME: -1")
    print(
        f"REF_RUNTIME: {ref_runtime_ms:.4f}" if ref_runtime_ms > 0 else "REF_RUNTIME: -1"
    )
    print(f"SPEEDUP: {speedup:.4f}x" if speedup > 0 else "SPEEDUP: -1")
    # Where the denominator came from. Printed on every run, because a speedup
    # that moved is either the kernel or the baseline and the reader cannot
    # tell which from the ratio alone.
    baseline_source = result.metadata.get("baseline_source")
    if baseline_source == "cached":
        when = result.metadata.get("baseline_measured_at") or "earlier"
        print(f"REF_SOURCE: frozen baseline (measured {when})")
    elif baseline_source == "measured":
        print("REF_SOURCE: measured this run (baseline established)")

    # Contract trailer for the kernel-opt panel: this evaluator speaks the
    # contract itself, so the numbers on the curve are the ones the evaluator
    # printed rather than an agent's transcription of them. An agent driving
    # THIS bench must not add a trailer of its own — that would double-count
    # the evaluation.
    trailer = {
        "artifact": args.solution,
        "compiled": bool(result.compiled),
        "correct": bool(result.correctness),
    }
    if runtime_ms > 0:
        trailer["latency_ms"] = runtime_ms
    native_metrics = {}
    if speedup > 0:
        native_metrics["speedup"] = round(speedup, 6)
    if ref_runtime_ms > 0:
        native_metrics["ref_runtime_ms"] = ref_runtime_ms
    if native_metrics:
        trailer["native_metrics"] = native_metrics
    # A replayed output caught by the mutation sentinel is a proven hack. An
    # over-threshold speedup is NOT — it is a number worth an independent look,
    # and real kernels do clear 10x — so it rides the advisory channel.
    if result.metadata.get("mutation_sentinel") == "fail":
        trailer["reward_hack_detected"] = True
    if result.metadata.get("excessive_speedup"):
        threshold = result.metadata.get("excessive_speedup_threshold", 10)
        trailer["advisory"] = [
            f"speedup {speedup:.2f}x is over the {threshold:g}x flag threshold "
            f"— worth checking independently before it is believed"
        ]
    error_text = (
        result.metadata.get("compilation_error")
        or result.metadata.get("runtime_error")
        or result.metadata.get("error_message")
    )
    if not result.correctness and error_text:
        trailer["error"] = str(error_text)[:400]
    print("KERNEL_EVAL=" + json.dumps(trailer, ensure_ascii=False))

    if args.verbose:
        print()
        print("--- Details ---")
        if result.runtime_stats:
            print(f"Runtime stats: {result.runtime_stats}")
        if result.ref_runtime_stats:
            print(f"Ref runtime stats: {result.ref_runtime_stats}")
        if result.metadata:
            for k, v in result.metadata.items():
                print(f"  {k}: {v}")

    sys.exit(0 if result.correctness else 1)


if __name__ == "__main__":
    main()
