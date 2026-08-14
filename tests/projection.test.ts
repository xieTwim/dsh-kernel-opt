/**
 * Projection unit tests over synthetic session events shaped like the real
 * log: `tool/call` carries `{callId, name, arguments}` (arguments is a JSON
 * string), `tool/result` carries `{callId, message}` with text blocks.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { collectResultText, hasUserTask, matchesTool, parseResultJson, project } from '../src/projection.ts'
import type { ProjectionEvent } from '../src/projection.ts'
import { challengeText, continuationText, finalAuditText, wrapUpText } from '../src/loop.ts'
import { inWrapUpPhase, latestRunStart } from '../src/wire.ts'
import type { WireRound } from '../src/wire.ts'

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
