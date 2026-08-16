/**
 * Projection unit tests over synthetic session events shaped like the real
 * log: `tool/call` carries `{callId, name, arguments}` (arguments is a JSON
 * string), `tool/result` carries `{callId, message}` with text blocks.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DEFAULT_PROJECTION, collectResultText, hasUserTask, matchesProfileCommand, matchesTool,
  parseResultJson, project,
} from '../src/projection.ts'
import type { ProjectionEvent } from '../src/projection.ts'
import { challengeText, continuationText, finalAuditText, wrapUpText } from '../src/loop.ts'
import { inWrapUpPhase, latestRunStart, unfinishedRun } from '../src/wire.ts'
import type { WireIteration, WireRound } from '../src/wire.ts'

let seq = 0
function call(name: string, callId: string, args: object): ProjectionEvent {
  seq += 1
  return { type: 'tool/call', seq, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } }
}
/** Real rc.2 shape: callId on message.source, text nested in a tool-result block. */
function result(callId: string, payload: object | string): ProjectionEvent {
  seq += 1
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return {
    type: 'tool/result',
    seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        source: { kind: 'tool', callId },
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError: false }],
      },
    },
  }
}

/** Legacy/fallback shape: callId at the data top level, flat text block. */
function legacyResult(callId: string, payload: object): ProjectionEvent {
  seq += 1
  return {
    type: 'tool/result',
    seq,
    data: { callId, message: { role: 'tool', content: [{ type: 'text', text: JSON.stringify(payload) }] } },
  }
}

test('matchesTool: exact and separator-suffixed names', () => {
  assert.equal(matchesTool('kernel_evaluate', ['kernel_evaluate']), true)
  assert.equal(matchesTool('ako__kernel_evaluate', ['kernel_evaluate']), true)
  assert.equal(matchesTool('mcp.ako:kernel_evaluate', ['kernel_evaluate']), true)
  assert.equal(matchesTool('rekernel_evaluate', ['kernel_evaluate']), false)
  assert.equal(matchesTool('kernel_evaluate_v2', ['kernel_evaluate']), false)
})

test('matchesProfileCommand: invoked profilers only, never a bench script timing itself', () => {
  const names = DEFAULT_PROJECTION.profileCommands
  assert.equal(matchesProfileCommand('ncu --set full python bench.py', names), true)
  assert.equal(matchesProfileCommand('/usr/local/cuda/bin/ncu -o rep python bench.py', names), true)
  assert.equal(matchesProfileCommand('cd run && nsys profile ./bench.sh', names), true)
  assert.equal(matchesProfileCommand('perf stat -e cycles ./a.out', names), true)
  // The trap this rule exists for: every bench script in this domain times
  // with time.perf_counter, and `perf` is a configured profiler.
  assert.equal(matchesProfileCommand('python -c "import time; time.perf_counter()"', names), false)
  assert.equal(matchesProfileCommand('python /opt/ncu/harness/bench.py', names), false)
  assert.equal(matchesProfileCommand('./ncu-ui report.ncu-rep', names), false)
  assert.equal(matchesProfileCommand('python diag3.py', names), false) // hand-written diagnostics stay invisible
  // Wrappers are stepped over; env assignments too.
  assert.equal(matchesProfileCommand('xcrun xctrace record --template "Time Profiler" --launch ./b', names), true)
  assert.equal(matchesProfileCommand('OMP_NUM_THREADS=8 perf stat ./a.out', names), true)
  // Asking the profiler about ITSELF is not profiling — both of these were
  // marked as profile runs on a real session that never profiled at all.
  assert.equal(matchesProfileCommand("xcrun xctrace list templates | grep -i cpu; xcrun xctrace record --help", names), false)
  assert.equal(matchesProfileCommand('ls /Applications/Xcode.app/.../xctrace; ls /usr/bin | grep xctrace', names), false)
  assert.equal(matchesProfileCommand('ncu --help', names), false)
  // The `|` inside a quoted regex must not open a command position.
  assert.equal(matchesProfileCommand("ls /usr/bin | grep -E 'xctrace|instruments|sample'; which instruments", names), false)
  assert.equal(matchesProfileCommand('ncu', names), false) // no workload = usage print
})

test('matchesProfileCommand: a remote GPU is profiled through an executor', () => {
  const names = DEFAULT_PROJECTION.profileCommands
  // The shape this exists for: DSH runs here, the card is over there.
  assert.equal(matchesProfileCommand("ssh box 'ncu --set full python bench.py'", names), true)
  assert.equal(matchesProfileCommand('ssh -p 16820 root@1.2.3.4 "cd /w && ncu -o r python b.py"', names), true)
  assert.equal(matchesProfileCommand('ssh -p 16820 root@1.2.3.4 ncu -o rep python bench.py', names), true)
  assert.equal(matchesProfileCommand('ssh -tt box nsys profile ./bench.sh', names), true)
  assert.equal(matchesProfileCommand('bash -c "ncu --set full python bench.py"', names), true)
  assert.equal(matchesProfileCommand('ssh a "ssh b \'ncu --set full python b.py\'"', names), true)
  // …without giving quoted PROSE a command position back.
  assert.equal(matchesProfileCommand("git commit -m 'ncu profiling added to bench'", names), false)
  assert.equal(matchesProfileCommand("echo 'ncu -o rep python bench.py' >> NOTES.md", names), false)
  assert.equal(matchesProfileCommand("ssh box 'ls /usr/local/cuda/bin | grep -E \"ncu|nsys\"'", names), false)
  assert.equal(matchesProfileCommand("ssh box 'ncu --version'", names), false)
  assert.equal(matchesProfileCommand('ssh -p 16820 root@1.2.3.4', names), false)
  assert.equal(matchesProfileCommand('rsync -az ./ box:/root/w/', names), false)
})

test('matchesProfileCommand: a bare `--` hands the command across', () => {
  const names = DEFAULT_PROJECTION.profileCommands
  // The two standard cluster shapes. Both executors were already listed, but
  // their command is not quoted, and bare arguments were followed for ssh only.
  assert.equal(matchesProfileCommand('kubectl exec pod-0 -- ncu --set full python bench.py', names), true)
  assert.equal(matchesProfileCommand('srun -N1 --gres=gpu:1 -- nsys profile ./bench.sh', names), true)
  assert.equal(matchesProfileCommand('docker run --rm img -- ncu -o rep python b.py', names), true)
  // A site's own lease/queue wrapper is never on any list here; the marker is
  // what carries the handoff, so it does not have to be.
  assert.equal(
    matchesProfileCommand("python3 gpuq.py exec L0324 --node w6 -- bash -c 'ncu --set full python bench.py'", names),
    true,
  )
  // What crosses the marker still has to BE a profiler run.
  assert.equal(matchesProfileCommand('python3 gpuq.py exec L0324 --node w6 -- python bench.py', names), false)
  assert.equal(matchesProfileCommand('kubectl exec pod-0 -- ncu --version', names), false)
  assert.equal(matchesProfileCommand('gpuq exec L0324 --', names), false) // nothing handed across
  // `--` that separates operands is not a handoff, even when a path is named
  // like a configured profiler — `perf` is the one that makes this bite.
  assert.equal(matchesProfileCommand('git log -- perf src/', names), false)
  assert.equal(matchesProfileCommand('grep -rn pattern -- ncu notes.txt', names), false)
})

test('matchesProfileCommand: crossing `--` costs two arguments, not one', () => {
  const names = DEFAULT_PROJECTION.profileCommands
  // Every one of these marked a profile run while the operand programs were
  // enumerated instead: the list only ever holds the ones someone thought of.
  assert.equal(matchesProfileCommand('head -n 5 -- perf notes.txt', names), false)
  assert.equal(matchesProfileCommand('tail -f -- perf run.log', names), false)
  assert.equal(matchesProfileCommand('wc -l -- perf out.txt', names), false)
  assert.equal(matchesProfileCommand('cat -- perf summary.txt', names), false)
  assert.equal(matchesProfileCommand('tar -cf out.tar -- perf src/', names), false)
  assert.equal(matchesProfileCommand('chmod +x -- perf run.sh', names), false)
  assert.equal(matchesProfileCommand('sort -u -- perf ids.txt', names), false)
  // A real invocation clears the floor: a flag or a subcommand, then the workload.
  assert.equal(matchesProfileCommand('xargs -- ncu --set full python b.py', names), true)
  assert.equal(matchesProfileCommand('uv run -- nsys profile ./bench.sh', names), true)
  // The floor applies to the guess, not to the head position, where one
  // argument has always been enough.
  assert.equal(matchesProfileCommand('perf stat ./a.out', names), true)
  assert.equal(matchesProfileCommand('ncu --set full -- python bench.py', names), true)
})

test('project: a profiler run through the shell earns the mark', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    call('bash', 'b1', { command: 'ncu --set full .venv/bin/python bench.py' }),
    result('b1', 'Section: SpeedOfLight'),
    call('bash', 'b2', { command: '.venv/bin/python bench.py --solution s1.py' }),
    result('b2', `${'KERNEL_EVAL='}{"artifact":"s1.py","correct":true,"latency_ms":3.0}`),
  ]
  const series = project('s', events)
  assert.equal(series.profileSeqs.length, 1)
  assert.equal(series.iterations.length, 1) // the profiler run is a mark, not a point
})

test('collectResultText walks text blocks; parseResultJson tolerates prose wrapping', () => {
  const text = collectResultText({ content: [{ type: 'text', text: 'prefix' }, { nested: [{ type: 'text', text: '{"a":1}' }] }] })
  assert.ok(text.includes('prefix'))
  const parsed = parseResultJson('Result follows:\n{"latency_ms": 3.2, "correct": true}\ndone')
  assert.deepEqual(parsed, { latency_ms: 3.2, correct: true })
})

test('project: iterations, plan, profile marks, finalize star, best index', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    call('kernel_plan', 'p1', { phase: 'explore', approach: 'baseline triton', hypothesis: 'reference point' }),
    call('ako__kernel_evaluate', 'c1', { kernel_id: 'k1' }),
    result('c1', { evaluation_id: '0001', compiled: true, correct: true, latency_ms: 10.0, native_metrics: { speedup: 1.0 } }),
    call('ako__kernel_profile', 'pr1', { sections: ['SpeedOfLight'] }),
    call('ako__kernel_evaluate', 'c2', { kernel_id: 'k2' }),
    result('c2', { evaluation_id: '0002', compiled: true, correct: false, latency_ms: 2.0 }),
    call('ako__kernel_evaluate', 'c3', { kernel_id: 'k3' }),
    result('c3', { evaluation_id: '0003', compiled: true, correct: true, latency_ms: 4.0 }),
    call('ako__run_finalize', 'f1', { evaluation_id: '0003' }),
    call('ako__kernel_evaluate', 'c4', { kernel_id: 'k4' }),
  ]
  const series = project('s', events)

  assert.equal(series.iterations.length, 4)
  assert.equal(series.plans.length, 1)
  assert.equal(series.plans[0]?.approach, 'baseline triton')
  assert.equal(series.profileSeqs.length, 1)

  // best skips the incorrect 2.0ms point and lands on the 4.0ms correct one.
  assert.equal(series.bestIndex, 2)
  assert.equal(series.iterations[2]?.finalized, true)
  assert.equal(series.iterations[1]?.correct, false)
  // the still-pending call shows as pending.
  assert.equal(series.iterations[3]?.pending, true)
  // explicit speedup metric is forwarded verbatim.
  assert.equal(series.iterations[0]?.speedup, 1.0)
})

test('project: speedup derives from ref_runtime_ms when no explicit metric', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    call('kernel_evaluate', 'c1', {}),
    result('c1', {
      evaluation_id: '0001', compiled: true, correct: true, latency_ms: 2.0,
      native_metrics: { 'kernelbench.ref_runtime_ms': 8.0 },
    }),
    call('kernel_evaluate', 'c2', {}),
    result('c2', { evaluation_id: '0002', compiled: true, correct: true, latency_ms: 4.0 }),
  ]
  const series = project('s', events)
  assert.equal(series.iterations[0]?.speedup, 4.0)
  // no evaluator-reported reference at all → no speedup invented.
  assert.equal(series.iterations[1]?.speedup, undefined)
})

test('project: reward-hack and error rows are excluded from best', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    call('kernel_evaluate', 'c1', {}),
    result('c1', { evaluation_id: '0001', compiled: true, correct: true, latency_ms: 1.0, reward_hack_detected: true, reward_hack_detectors: ['memoized_exploit'] }),
    call('kernel_evaluate', 'c2', {}),
    result('c2', { evaluation_id: '0002', compiled: false, correct: false, error: 'compile failed', latency_ms: 0.5 }),
    call('kernel_evaluate', 'c3', {}),
    result('c3', { evaluation_id: '0003', compiled: true, correct: true, latency_ms: 5.0 }),
  ]
  const series = project('s', events)
  assert.equal(series.iterations[0]?.rewardHack, true)
  assert.equal(series.iterations[1]?.error, 'compile failed')
  assert.equal(series.bestIndex, 2)
})

test('project: legacy top-level callId still correlates', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    call('kernel_evaluate', 'c1', {}),
    legacyResult('c1', { evaluation_id: '0001', compiled: true, correct: true, latency_ms: 2.5 }),
  ]
  const series = project('s', events)
  assert.equal(series.iterations[0]?.latencyMs, 2.5)
  assert.equal(series.bestIndex, 0)
})

/** Plugin-sourced `user/message` event (rc.2 logs the UserMessage as data). */
function loopMessage(text: string): ProjectionEvent {
  seq += 1
  return {
    type: 'user/message',
    seq,
    data: {
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'kernel-opt' },
    },
  }
}

test('project: write/edit calls attribute to the NEXT matching evaluation', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    call('write', 'w1', { file_path: '/work/solution.py', content: 'import triton\n# v1' }),
    call('write', 'w2', { file_path: '/work/notes.md', content: 'irrelevant' }),
    call('ako__kernel_evaluate', 'c1', { task_id: 't', artifact_path: 'solution.py' }),
    result('c1', { evaluation_id: '0001', compiled: true, correct: true, latency_ms: 5.0 }),
    call('edit', 'e1', { file_path: '/work/solution.py', old_string: '# v1', new_string: '# v2', replace_all: false }),
    call('ako__kernel_evaluate', 'c2', { task_id: 't', artifact_path: '/work/solution.py', workload_indices: [0, 3] }),
    result('c2', { evaluation_id: '0002', compiled: true, correct: true, latency_ms: 4.0 }),
  ]
  const series = project('s', events)
  const [first, second] = series.iterations
  assert.equal(first?.artifactPath, 'solution.py')
  assert.equal(first?.changes?.length, 1)
  assert.equal(first?.changes?.[0]?.kind, 'write')
  assert.ok(first?.changes?.[0]?.content?.includes('# v1'))
  // The notes.md write matched nothing and was dropped at the eval boundary.
  assert.equal(second?.changes?.length, 1)
  assert.equal(second?.changes?.[0]?.kind, 'edit')
  assert.equal(second?.changes?.[0]?.oldText, '# v1')
  assert.equal(second?.changes?.[0]?.newText, '# v2')
  assert.deepEqual(second?.workloadSubset, [0, 3])
})

test('project: evaluator detail fields forward (blocking/advisory/not_measured/evaluator_failed)', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    call('kernel_evaluate', 'c1', { artifact_path: 'solution.py' }),
    result('c1', {
      evaluator_failed: true, correct: null,
      error: 'artifact would not be evaluated as written',
      blocking: ['module-level tail after last class'], advisory: ['unused import'],
      not_measured: ['latency_ms'],
    }),
  ]
  const point = project('s', events).iterations[0]
  assert.equal(point?.evaluatorFailed, true)
  assert.deepEqual(point?.blocking, ['module-level tail after last class'])
  assert.deepEqual(point?.advisory, ['unused import'])
  assert.deepEqual(point?.notMeasured, ['latency_ms'])
})

test('project: kernel-loop messages parse back into rounds (advice / OK / wrap-up)', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    loopMessage(continuationText(1, 2, 20, null, false)),
    loopMessage(continuationText(2, 3, 20, 'Switch families.\nState a hypothesis first.', false)),
    loopMessage(continuationText(3, 5, 20, null, true)),
    loopMessage(wrapUpText(20, 20, 'budget')),
  ]
  const { rounds } = project('s', events)
  assert.equal(rounds.length, 4)
  assert.deepEqual(
    rounds.map(r => [r.round, r.review, r.wrapUp]),
    [
      [1, undefined, undefined],
      [2, 'Switch families.\nState a hypothesis first.', undefined],
      [3, 'ok', undefined],
      [undefined, undefined, true],
    ],
  )
  assert.equal(rounds[1]?.evalsUsed, 3)
  assert.equal(rounds[3]?.budget, 20)
})

test('project: an approval note is parsed back off the OK line', () => {
  seq = 0
  const note = 'four families tried, best is replay-consistent'
  const events: ProjectionEvent[] = [
    loopMessage(continuationText(2, 3, 20, null, true, 0, undefined, true, true, 0, note)),
    loopMessage(continuationText(3, 5, 20, null, true)),
  ]
  const { rounds } = project('s', events)
  assert.equal(rounds[0]?.review, 'ok')
  assert.equal(rounds[0]?.reviewNote, note)
  // A bare approval keeps the verdict without inventing a note.
  assert.equal(rounds[1]?.review, 'ok')
  assert.equal(rounds[1]?.reviewNote, undefined)
})

test('project: closing-audit parses as audit round; review blocks cut at the closing anchors', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    loopMessage(wrapUpText(5, 5, 'budget', 'kernel_finalize', 'Verify provenance of #4.')),
    loopMessage(finalAuditText(null)),
    loopMessage(finalAuditText('Replay disagrees with the self-reported final; re-verify.')),
  ]
  const { rounds } = project('s', events)
  assert.equal(rounds.length, 3)
  // The wrap-up's advice stops at its closing instructions, never swallowing them.
  assert.equal(rounds[0]?.wrapUp, true)
  assert.equal(rounds[0]?.review, 'Verify provenance of #4.')
  assert.equal(rounds[1]?.audit, true)
  assert.equal(rounds[1]?.review, 'ok')
  assert.equal(rounds[2]?.audit, true)
  assert.equal(rounds[2]?.review, 'Replay disagrees with the self-reported final; re-verify.')
})

test('project: a finalize challenge lands as that round\'s review, advice intact', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    loopMessage(challengeText(2, 6, 20, 'Try a fused epilogue.', 'kernel_finalize', 3)),
  ]
  const { rounds } = project('s', events)
  assert.equal(rounds.length, 1)
  assert.equal(rounds[0]?.round, 2)
  assert.equal(rounds[0]?.review, 'Try a fused epilogue.')
  assert.equal(rounds[0]?.evalsUsed, 6)
  assert.equal(rounds[0]?.challenge, true)
  // An ordinary continuation carrying advice is NOT a challenge.
  seq = 0
  const plain = project('s', [loopMessage(continuationText(2, 6, 20, 'Try a fused epilogue.'))]).rounds
  assert.equal(plain[0]?.challenge, undefined)
})

test('project: kernel_env reports project into the env series', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    call('kernel_env', 'e1', {
      location: 'kernel-box via rt',
      device: 'NVIDIA H100 80GB x1',
      constraint: 'user pinned CUDA_VISIBLE_DEVICES=0',
      versions: { python: '3.11.9', torch: '2.6.0+cu124', cuda: '12.4', cores: 96 },
      probe: 'nvidia-smi; python -c "import torch"',
    }),
    call('kernel_env', 'e2', { location: 'Modal B200', device: 'NVIDIA B200 x1' }),
    // A report missing a required field is not a report.
    call('kernel_env', 'e3', { location: 'nowhere' }),
  ]
  const { envs } = project('s', events)
  assert.equal(envs.length, 2)
  assert.equal(envs[0]?.device, 'NVIDIA H100 80GB x1')
  assert.equal(envs[0]?.constraint, 'user pinned CUDA_VISIBLE_DEVICES=0')
  assert.deepEqual(envs[0]?.versions, { python: '3.11.9', torch: '2.6.0+cu124', cuda: '12.4', cores: '96' })
  assert.ok(envs[0]?.probe?.startsWith('nvidia-smi'))
  // The latest report wins on the panel; earlier ones stay on the wire.
  assert.equal(envs[envs.length - 1]?.location, 'Modal B200')
})

test('project: non-plugin user messages never become rounds', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    {
      type: 'user/message',
      seq: 1,
      data: { role: 'user', content: [{ type: 'text', text: '[kernel-loop round 1] 0/20 evaluations used.' }], source: { kind: 'user' } },
    },
  ]
  assert.equal(project('s', events).rounds.length, 0)
})

test('hasUserTask: only a direct human prompt arms the gate', () => {
  // Empty log, tool traffic, and the loop's own plugin-sourced continuations
  // never count; a user-sourced message does — including the `message`
  // wrapper variant accepted against shape drift.
  seq = 0
  assert.equal(hasUserTask([]), false)
  const noTask: ProjectionEvent[] = [
    call('bash', 'c1', { command: 'ls' }),
    loopMessage('[kernel-loop round 1] 0/20 evaluations used.'),
  ]
  assert.equal(hasUserTask(noTask), false)
  const direct: ProjectionEvent = {
    type: 'user/message',
    seq: 90,
    data: { role: 'user', content: [{ type: 'text', text: '优化 solution.py' }], source: { kind: 'user' } },
  }
  assert.equal(hasUserTask([...noTask, direct]), true)
  const wrapped: ProjectionEvent = {
    type: 'user/message',
    seq: 91,
    data: { message: { role: 'user', content: [{ type: 'text', text: 'task' }], source: { kind: 'user' } } },
  }
  assert.equal(hasUserTask([wrapped]), true)
})

test('project: unparsable result leaves a measured-nothing row, not a crash', () => {
  seq = 0
  const events: ProjectionEvent[] = [
    call('kernel_evaluate', 'c1', {}),
    result('c1', 'GPU node exploded, no JSON here'),
  ]
  const series = project('s', events)
  assert.equal(series.iterations.length, 1)
  assert.equal(series.iterations[0]?.pending, undefined)
  assert.equal(series.iterations[0]?.latencyMs, undefined)
  assert.equal(series.bestIndex, null)
})

test('the bundled evaluator’s own trailer projects, speedup and all', () => {
  // Copied verbatim from a real run of preset/kernel-opt/evaluator/bench.py on
  // an A100 — the two halves of this repo agree on the contract, or the panel
  // silently loses the number the evaluator already computed.
  const events = [
    call('bash', 'b1', { command: './bench.sh --ref ref.py --solution solution/kernel.py' }),
    result('b1', [
      'COMPILED: True',
      'CORRECT: True',
      'RUNTIME: 1.9900',
      'REF_RUNTIME: 2.1400',
      'SPEEDUP: 1.0754x',
      'REF_SOURCE: frozen baseline (measured 2026-08-15T08:29:18+00:00)',
      'KERNEL_EVAL={"artifact": "solution/kernel.py", "compiled": true, "correct": true, "latency_ms": 1.99, "native_metrics": {"speedup": 1.075377, "ref_runtime_ms": 2.14}}',
    ].join('\n')),
  ]
  const series = project('s', events)
  assert.equal(series.iterations.length, 1)
  const point = series.iterations[0]!
  assert.equal(point.artifactPath, 'solution/kernel.py')
  assert.equal(point.latencyMs, 1.99)
  assert.equal(point.correct, true)
  assert.equal(point.compiled, true)
  // The evaluator's explicit speedup wins over deriving one from ref_runtime_ms.
  assert.ok(point.speedup !== undefined && Math.abs(point.speedup - 1.075377) < 1e-9)
})

test('an agent-written evaluator’s top-level speedup counts too', () => {
  // Verbatim shape from a real Modal run: this evaluator put `speedup` and
  // `ref_runtime_ms` beside `latency_ms` rather than inside `native_metrics`,
  // and reading only the nested home dropped the ratio on every line of the
  // run — taking the × axis and the pooled reference down with it.
  const events = [
    call('bash', 'b1', { command: 'modal run bench_modal.py' }),
    result('b1', [
      'KERNEL_EVAL={"artifact": "solution/v3_compile.py", "correct": true, "latency_ms": 0.0696,'
      + ' "ref_runtime_ms": 2.0347, "speedup": 29.221,'
      + ' "native_metrics": {"floor_copy_ms": 0.0471, "achieved_gbs": 3848.8}}',
    ].join('\n')),
  ]
  const series = project('s', events)
  const point = series.iterations[0]!
  assert.ok(point.speedup !== undefined && Math.abs(point.speedup - 29.221) < 1e-9)
  // The nested metrics still arrive intact — top-level reading is additive.
  assert.equal(point.metrics?.['floor_copy_ms'], 0.0471)
})

test('top-level ref_runtime_ms derives a speedup, and native_metrics still wins', () => {
  const events = [
    call('bash', 'b1', { command: './bench.sh' }),
    result('b1', 'KERNEL_EVAL={"artifact":"solution/k.py","correct":true,"latency_ms":2.0,"ref_runtime_ms":8.0}'),
    call('bash', 'b2', { command: './bench.sh' }),
    // Both homes populated and disagreeing: the documented one is the answer.
    result('b2', 'KERNEL_EVAL={"artifact":"solution/k.py","correct":true,"latency_ms":2.0,"speedup":99,'
      + '"native_metrics":{"speedup":3.5}}'),
  ]
  const series = project('s', events)
  assert.ok(series.iterations[0]?.speedup !== undefined && Math.abs(series.iterations[0].speedup - 4) < 1e-9)
  assert.equal(series.iterations[1]?.speedup, 3.5)
})

test('a zero or negative top-level speedup is not a reading', () => {
  const events = [
    call('bash', 'b1', { command: './bench.sh' }),
    result('b1', 'KERNEL_EVAL={"artifact":"solution/k.py","correct":true,"latency_ms":2.0,"speedup":0,"ref_runtime_ms":0}'),
  ]
  const series = project('s', events)
  assert.equal(series.iterations[0]?.speedup, undefined)
})

test('shell channel: bash trailer lines become self-reported points with provenance + changes', () => {
  const events = [
    call('write', 'w1', { file_path: 'solution/k.py', content: 'v2 kernel' }),
    call('bash', 'ls1', { command: 'ls trajectory' }),
    result('ls1', 'nothing relevant'),
    call('bash', 'b1', { command: 'bash scripts/bench.sh' }),
    result('b1', [
      '[bench] compiling...',
      'Trial 1: 1.31 ms',
      '  KERNEL_EVAL={"artifact":"solution/k.py","latency_ms":1.23,"correct":true,"evaluation_id":"agent-made-up","native_metrics":{"ref_runtime_ms":4.92}}  # exit 0',
      'done',
    ].join('\n')),
  ]
  const series = project('s', events)
  assert.equal(series.iterations.length, 1)
  const point = series.iterations[0]!
  assert.equal(point.channel, 'shell')
  assert.equal(point.tool, 'bash')
  assert.equal(point.command, 'bash scripts/bench.sh')
  assert.equal(point.artifactPath, 'solution/k.py')
  assert.equal(point.latencyMs, 1.23)
  assert.equal(point.correct, true)
  assert.ok(point.speedup !== undefined && Math.abs(point.speedup - 4) < 1e-9)
  // The non-eval bash call between write and bench must not consume changes.
  assert.equal(point.changes?.length, 1)
  assert.equal(point.changes?.[0]?.kind, 'write')
  // Agent-relayed ids never become identity on the self-reported channel.
  assert.equal(point.evaluationId, undefined)
  assert.equal(series.bestIndex, 0)
})

test('shell channel: invalid payloads and mid-line mentions are ignored; multiple trailers all count', () => {
  const events = [
    call('bash', 'b1', { command: 'bash scripts/bench_all.sh' }),
    result('b1', [
      'KERNEL_EVAL={"artifact":"a.py","latency_ms":2.0,"correct":true}',
      'KERNEL_EVAL={"artifact":"b.py","latency_ms":1.5,"correct":true,"workload_indices":[0,3]}',
      'KERNEL_EVAL={"latency_ms":9.9,"correct":true}',
      'KERNEL_EVAL={"artifact":"c.py","latency_ms":9.9}',
      'KERNEL_EVAL={broken json',
      'docs say: the line KERNEL_EVAL={"artifact":"doc.py","latency_ms":0.1,"correct":true} reports results',
    ].join('\n')),
  ]
  const series = project('s', events)
  assert.equal(series.iterations.length, 2)
  assert.equal(series.iterations[0]?.artifactPath, 'a.py')
  assert.equal(series.iterations[1]?.artifactPath, 'b.py')
  assert.deepEqual(series.iterations[1]?.workloadSubset, [0, 3])
})

test('finalize by artifact: kernel_finalize flags the best honest point and parses the replay trailer', () => {
  const events = [
    call('bash', 'b1', { command: 'bash scripts/bench.sh' }),
    result('b1', 'KERNEL_EVAL={"artifact":"solution/k.py","latency_ms":2.4,"correct":true}'),
    call('bash', 'b2', { command: 'bash scripts/bench.sh' }),
    result('b2', 'KERNEL_EVAL={"artifact":"solution/k.py","latency_ms":1.1,"correct":true}'),
    call('bash', 'b3', { command: 'bash scripts/bench.sh' }),
    result('b3', 'KERNEL_EVAL={"artifact":"solution/k.py","latency_ms":0.9,"correct":false}'),
    call('kernel_finalize', 'f1', { artifact_path: 'solution/k.py' }),
    result('f1', [
      'Finalize recorded for solution/k.py.',
      '[replay] bash scripts/bench.sh',
      'Trial 1: 1.15 ms',
      'KERNEL_EVAL={"artifact":"solution/k.py","latency_ms":1.12,"correct":true}',
    ].join('\n')),
  ]
  const series = project('s', events)
  assert.equal(series.iterations.length, 4)
  // Best honest point (1.1, correct) carries the flag — not the faster incorrect one.
  assert.equal(series.iterations[1]?.finalized, true)
  assert.equal(series.iterations[0]?.finalized, undefined)
  assert.equal(series.iterations[2]?.finalized, undefined)
  const replay = series.iterations[3]!
  assert.equal(replay.channel, 'replay')
  assert.equal(replay.finalized, true)
  assert.equal(replay.command, 'bash scripts/bench.sh')
  assert.equal(replay.latencyMs, 1.12)
})

test('latestRunStart: re-armed runs segment at the round-counter reset', () => {
  const r = (round: number | undefined, at: number, wrapUp = false): WireRound =>
    ({ seq: at, ...(round !== undefined ? { round } : {}), ...(wrapUp ? { wrapUp: true } : {}) })
  assert.equal(latestRunStart([]), 0)
  // One uninterrupted run keeps everything.
  assert.equal(latestRunStart([r(1, 10), r(2, 20), r(3, 30)]), 0)
  // A wrap-up (no round number) stays with the run it closes; the next
  // round-1 opens the new run.
  assert.equal(latestRunStart([r(1, 10), r(undefined, 20, true), r(1, 30), r(2, 40)]), 2)
  // Repeated single-round arms: only the last one is current.
  assert.equal(latestRunStart([r(1, 10), r(1, 20), r(1, 30)]), 2)
})

test('unfinishedRun: a run whose last word is a drive, with no finalize after it', () => {
  const r = (round: number | undefined, at: number, kind?: 'wrapUp' | 'audit'): WireRound =>
    ({ seq: at, ...(round !== undefined ? { round } : {}), ...(kind !== undefined ? { [kind]: true } : {}) })
  const it = (at: number, finalized = false): WireIteration =>
    ({ seq: at, tool: 'bash', latencyMs: 1, correct: true, ...(finalized ? { finalized: true } : {}) })
  // Cut off mid-run: drives, evaluations, nothing closing.
  assert.equal(unfinishedRun([r(1, 10), r(2, 50)], [it(20), it(60)]), true)
  // Closed properly: wrap-up or closing audit had the last word.
  assert.equal(unfinishedRun([r(1, 10), r(undefined, 50, 'wrapUp')], [it(20)]), false)
  assert.equal(unfinishedRun([r(1, 10), r(undefined, 50, 'audit')], [it(20)]), false)
  // The agent finalized after the last drive: the run ended on its own terms.
  assert.equal(unfinishedRun([r(1, 10)], [it(20), it(30, true)]), false)
  // A finalize BEFORE the last drive does not close what came after it.
  assert.equal(unfinishedRun([r(1, 10), r(2, 40)], [it(30, true), it(50)]), true)
  // No loop messages at all: nothing was ever armed.
  assert.equal(unfinishedRun([], [it(20)]), false)
})

test('inWrapUpPhase: evaluations after the wrap-up delivery are wrap-up phase', () => {
  const r = (round: number | undefined, at: number, wrapUp = false): WireRound =>
    ({ seq: at, ...(round !== undefined ? { round } : {}), ...(wrapUp ? { wrapUp: true } : {}) })
  const rounds = [r(1, 10), r(undefined, 50, true)]
  assert.equal(inWrapUpPhase(rounds, 5), false) // before any loop message
  assert.equal(inWrapUpPhase(rounds, 20), false) // budgeted work between drives
  assert.equal(inWrapUpPhase(rounds, 60), true) // finalize verification after wrap-up
  // A re-armed run's first continuation closes the wrap-up phase again.
  const rearmed = [...rounds, r(1, 80)]
  assert.equal(inWrapUpPhase(rearmed, 60), true)
  assert.equal(inWrapUpPhase(rearmed, 90), false)
  // The closing audit enters (or keeps) the phase: post-audit corrections are
  // closing work, not budgeted iterations.
  const audited: WireRound[] = [r(1, 10), { seq: 70, audit: true }]
  assert.equal(inWrapUpPhase(audited, 75), true)
  assert.equal(inWrapUpPhase(audited, 60), false)
})

test('background-job trailers are collected, with the launching command as provenance', () => {
  // The failure this guards: two runs put their bench in a background job —
  // one on an A100, one in a Modal container — and the panel sat at zero
  // iterations while 5 and 32 real evaluations sat in the log, which also
  // left kernel_finalize with nothing to replay.
  const series = project('s', [
    call('bash', 'b1', { command: 'bash scripts/bench.sh iter-0' }),
    result('b1', 'started background job bash-14'),
    call('job_output', 'j1', { job_id: 'bash-14' }),
    result('j1', 'KERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":0.0215,"correct":true}'),
  ])
  assert.equal(series.iterations.length, 1)
  assert.equal(series.iterations[0]?.latencyMs, 0.0215)
  assert.equal(series.iterations[0]?.command, 'bash scripts/bench.sh iter-0')
  assert.equal(series.uncollectedSeqs.length, 0)
})

test('a job re-read does not enter the same measurement twice', () => {
  // Measured across two real runs: 17 job reads, 37 trailers, zero repeats —
  // but a poll that returned cumulative output would double the curve.
  const trailer = 'KERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":1.5,"correct":true}'
  const series = project('s', [
    call('job_output', 'j1', { job_id: 'bash-2' }),
    result('j1', trailer),
    call('job_output', 'j2', { job_id: 'bash-2' }),
    result('j2', `${trailer}\nKERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":1.2,"correct":true}`),
  ])
  assert.deepEqual(series.iterations.map(p => p.latencyMs), [1.5, 1.2])
})

test('background-job reads without a trailer are not counted', () => {
  // Polling a job that is still compiling must not raise the alarm.
  const series = project('s', [
    call('job_output', 'j1', { job_id: 'bash-14' }),
    result('j1', 'ninja: building extension...'),
  ])
  assert.equal(series.iterations.length, 0)
  assert.equal(series.uncollectedSeqs.length, 0)
})

test('reading a bench log back does not invent points', () => {
  // Observed: a run grepped its own output file and put three points on an
  // otherwise empty chart, two of them without a latency.
  const trailer = 'KERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":0.058,"correct":true}'
  const readBack = project('s', [
    call('bash', 'b1', { command: 'cd /w && ls trajectory/ && grep -a "KERNEL_EVAL" _bench_output-iter-4.txt | head -10' }),
    result('b1', trailer),
  ])
  assert.equal(readBack.iterations.length, 0)
  assert.equal(readBack.uncollectedSeqs.length, 0)
  // One real program anywhere on the line makes it an execution again.
  const executes = project('s', [
    call('bash', 'b1', { command: 'cat prelude.sh && ./bench.sh' }),
    result('b1', trailer),
  ])
  assert.equal(executes.iterations.length, 1)
})

test('a contract line from an unrecognised channel is still surfaced', () => {
  // The net that caught the background-job gap, kept for the next unknown.
  const series = project('s', [
    call('some_future_runner', 'x1', {}),
    result('x1', 'KERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":1.1,"correct":true}'),
  ])
  assert.equal(series.iterations.length, 0)
  assert.equal(series.uncollectedSeqs.length, 1)
  // Reading a file back is not a missing measurement.
  const readTool = project('s', [
    call('read', 'r1', { file_path: '/w/_bench_output-iter-0.txt' }),
    result('r1', 'KERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":1.1,"correct":true}'),
  ])
  assert.equal(readTool.uncollectedSeqs.length, 0)
})

test('a foreground bash trailer stays a real point, uncounted as uncollected', () => {
  const series = project('s', [
    call('bash', 'b1', { command: './bench.sh' }),
    result('b1', 'KERNEL_EVAL={"artifact":"solution/kernel.py","latency_ms":1.5,"correct":true}'),
  ])
  assert.equal(series.iterations.length, 1)
  assert.equal(series.uncollectedSeqs.length, 0)
})
