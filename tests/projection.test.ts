/**
 * Projection unit tests over synthetic session events shaped like the real
 * log: `tool/call` carries `{callId, name, arguments}` (arguments is a JSON
 * string), `tool/result` carries `{callId, message}` with text blocks.
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { collectResultText, matchesTool, parseResultJson, project } from '../src/projection.ts'
import type { ProjectionEvent } from '../src/projection.ts'

let seq = 0
function call(name: string, callId: string, args: object): ProjectionEvent {
  seq += 1
  return { type: 'tool/call', seq, data: { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) } }
}
function result(callId: string, payload: object | string): ProjectionEvent {
  seq += 1
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
  return { type: 'tool/result', seq, data: { callId, message: { role: 'tool', content: [{ type: 'text', text }] } } }
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
    call('cockpit_plan', 'p1', { phase: 'explore', approach: 'baseline triton', hypothesis: 'reference point' }),
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
