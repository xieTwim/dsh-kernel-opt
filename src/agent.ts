/**
 * dsh-kernel-opt — the mode's own surfaces, mounted in the AGENT plane: the
 * model-facing tools, and the human-facing `/kloop` and `/supervise` commands.
 *
 * All of them are levers of ONE mode. A session that chose a general coding
 * preset can neither use them nor see the panel they feed, so registering them
 * at profile level put the tool descriptions in every unrelated session's tool
 * catalog and both commands in every session's slash menu. They live here
 * instead, as a row in `preset/kernel-opt/agent.cordis.yml`, and a session that
 * did not choose 「算子优化模式」 never carries them.
 *
 * The tools stay declarative: the call itself is the record. The projection
 * reads the logged arguments, so two of the three bodies only acknowledge.
 * The exception is `kernel_finalize`, which replays the recorded bench
 * command once to turn a self-reported best into a verified one.
 *
 * The commands own no state either — they read and drive the ONE loop face
 * (`runtime.loop`) that the panel's `/control` route drives, so the two can
 * never disagree about a run. Configuration is likewise not restated on the
 * preset row: it comes from the `kernelOptRuntime` service the profile-plane
 * half publishes, which is also why this row does not mount when the plugin
 * is absent.
 *
 * @module @xietwim/dsh-kernel-opt/agent
 */
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { project } from './projection.ts'
import { REPLAY_LINE_PREFIX, samePath } from './wire.ts'
import type { WireIteration } from './wire.ts'
import type { LoopOps } from './runtime.ts'

export const name = 'kernel-opt-tools'
export const inject = ['tools', 'agents', 'sessions', 'kernelOptRuntime']

/** Outcome of one replay execution. */
interface ReplayOutcome {
  output: string
  exit: number | null
  failure?: string
}

/** Run one recorded benchmark command (`bash -c`); resolves, never throws. */
function runReplay(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ReplayOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('bash', ['-c', command], {
        cwd,
        timeout: timeoutMs,
        ...(signal !== undefined ? { signal } : {}),
      })
    } catch (error) {
      resolve({ output: '', exit: null, failure: error instanceof Error ? error.message : String(error) })
      return
    }
    const chunks: string[] = []
    let size = 0
    const take = (chunk: Buffer): void => {
      if (size > 200_000) return
      size += chunk.length
      chunks.push(chunk.toString('utf8'))
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', (error) => {
      resolve({ output: chunks.join(''), exit: null, failure: error.message })
    })
    child.on('close', (code, killSignal) => {
      resolve({
        output: chunks.join(''),
        exit: code,
        ...(killSignal !== null ? { failure: `terminated by ${killSignal}` } : {}),
      })
    })
  })
}

/** Cap replay output for the tool result, keeping the tail (trailer lives there). */
function capReplayOutput(output: string, headCap = 2_000, tailCap = 10_000): string {
  if (output.length <= headCap + tailCap) return output
  return `${output.slice(0, headCap)}\n…[replay output trimmed]…\n${output.slice(output.length - tailCap)}`
}

/**
 * Register the mode's model-facing tools and its human-facing commands.
 * @param ctx - the agent-plane context of the kernel-opt preset row.
 */
export function apply(ctx: Context): void {
  applyCommands(ctx)

  // kernel_plan — the call itself is the record: the projection reads the
  // logged arguments, so the tool body only acknowledges.
  ctx.tools.register(defineTool({
    name: 'kernel_plan',
    description: 'Report your CURRENT kernel-optimization plan to the human evaluation panel. '
      + 'Call BEFORE starting a new approach and again whenever the plan changes, so the human '
      + 'can steer early instead of after a wasted iteration. Keep every field to one short line. '
      + 'phase: loop stage (e.g. explore / tune / verify / stuck). approach: the technique being '
      + 'tried (e.g. "split-K over KV, BLOCK_H=8"). hypothesis: why it should be faster. '
      + 'next: the immediate action.',
    parameters: {
      phase: { type: 'string', required: true, description: 'Loop stage: explore / tune / verify / stuck / done.' },
      approach: { type: 'string', required: true, description: 'One-line description of the current technique.' },
      hypothesis: { type: 'string', description: 'Why this should be faster (one line).' },
      next: { type: 'string', description: 'Immediate next action (one line).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args) => {
      return `Plan recorded (${args.phase}): ${args.approach}`
    },
  }))

  // kernel_env — the environment the MEASUREMENTS happen in, reported by the
  // agent rather than probed here. The plugin runs where the panel is served,
  // which is not necessarily where the benchmark executes (remote box, cloud
  // runner, container), and even on one host the user may have ruled a device
  // out; only the agent knows what it actually decided to run on.
  ctx.tools.register(defineTool({
    name: 'kernel_env',
    description: 'Report the environment your EVALUATIONS run in, to the human evaluation panel. '
      + 'Call once after inventory and BEFORE the first evaluation, and again whenever the '
      + 'environment changes (you move to a remote host, switch device, or the user constrains it). '
      + 'Report where the BENCHMARK executes, not where you are thinking: if the user pointed you at '
      + 'a remote machine or a cloud runner, describe THAT machine. If the user ruled a device out '
      + '("CPU only", a pinned CUDA_VISIBLE_DEVICES), state the device you are actually using and put '
      + 'the instruction in constraint. Read the facts, never guess them, and name the commands you '
      + 'read them from in probe.',
    parameters: {
      location: {
        type: 'string',
        required: true,
        description: 'Where evaluations execute, e.g. "本机 (macOS)" / "远程 GPU 主机" / "Modal B200 容器".',
      },
      device: {
        type: 'string',
        required: true,
        description: 'The compute device the timed runs use, e.g. "NVIDIA H100 80GB ×1" / "Apple M5 CPU (10 核)".',
      },
      constraint: {
        type: 'string',
        description: 'User/task instruction that decided the device, e.g. "用户要求仅用 CPU" / "CUDA_VISIBLE_DEVICES=0".',
      },
      versions: {
        type: 'object',
        // Open map: the useful version keys differ per backend (cuda/driver on
        // NVIDIA, none of them on a CPU-only run), so the schema fixes none.
        additionalProperties: true,
        description: 'Key toolchain versions as read, e.g. {"python":"3.11.9","torch":"2.6.0+cu124","cuda":"12.4","driver":"550.90"}.',
      },
      probe: { type: 'string', description: 'Command(s) these facts were read from, e.g. "nvidia-smi; python -c ...".' },
      notes: { type: 'string', description: 'Anything qualifying the measurements (clocks not locked, shared host, …).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args) => {
      return `Environment recorded: ${args.device} @ ${args.location}`
    },
  }))

  // kernel_finalize — the finalize record for evaluation pipelines with no
  // evaluator-issued ids (the self-reported channel). The call itself is the
  // record; when the artifact's best measurement is self-reported and replay
  // is enabled, the plugin re-executes that recorded command once and appends
  // its output — the trailer inside becomes the verified [replay] final
  // measurement, read back by the projection like everything else.
  ctx.tools.register(defineTool({
    name: 'kernel_finalize',
    description: 'Record your FINAL kernel choice by artifact path (for evaluation pipelines without '
      + 'evaluator-issued ids; with an id-issuing evaluator call its own finalize instead). Call once, at the '
      + 'end, with the artifact you stand behind — restore it verbatim first if a later edit regressed it. '
      + 'When the best measurement for that artifact is self-reported, the plugin replays the recorded '
      + 'benchmark command once and appends the output as the verified final measurement.',
    parameters: {
      artifact_path: { type: 'string', required: true, description: 'Path of the final artifact, as printed in its KERNEL_EVAL trailer.' },
      note: { type: 'string', description: 'One-line closing note (optional).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute: async (args, exec) => {
      const ack = `Finalize recorded for ${args.artifact_path}.${args.note !== undefined ? ` Note: ${args.note}` : ''}`
      const agent = ctx.agents.currentInitiator()
      if (agent === undefined) return `${ack} (no active agent turn; not replayed)`
      const session = ctx.sessions.get(SessionId(agent.id))
      if (session === undefined) return `${ack} (session not found; not replayed)`
      const runtime = ctx.kernelOptRuntime
      if (!runtime.replay.enabled) return `${ack} Replay disabled by config; the final number stays self-reported.`
      const series = project(agent.id, session.events, runtime.projection)
      let best: WireIteration | undefined
      for (const point of series.iterations) {
        if (point.channel !== 'shell') continue
        if (point.artifactPath === undefined || !samePath(point.artifactPath, args.artifact_path)) continue
        if (point.correct !== true || point.rewardHack === true || point.error !== undefined) continue
        if (point.latencyMs === undefined) continue
        if (best?.latencyMs === undefined || point.latencyMs < best.latencyMs) best = point
      }
      if (best === undefined) {
        return `${ack} No self-reported measurement found for this artifact — nothing to replay `
          + '(tool-channel measurements are already verified).'
      }
      const command = best.command
      if (command === undefined || command.endsWith('…')) {
        return `${ack} Recorded command ${command === undefined ? 'unavailable' : 'truncated in the projection'}; not replayed.`
      }
      const cwd: unknown = session.header.cwd
      if (typeof cwd !== 'string' || cwd.length === 0) return `${ack} Session working directory unknown; not replayed.`
      const outcome = await runReplay(command, cwd, runtime.replay.timeoutMs, exec.signal)
      const lines = [ack, `${REPLAY_LINE_PREFIX}${command}`]
      if (outcome.failure !== undefined) {
        lines.push(`Replay failed: ${outcome.failure}. The final number stays self-reported.`)
      }
      lines.push('--- replay output ---', capReplayOutput(outcome.output))
      if (outcome.exit !== null) lines.push(`[replay exit ${String(outcome.exit)}]`)
      return lines.join('\n')
    },
  }))
}

/**
 * Register `/kloop` and `/supervise`.
 *
 * Soft-gated on `commands` rather than declared in this module's `inject`: a
 * deployment without the command registry should lose the slash commands, not
 * the tools — and a row that fails to activate fails the whole preset mount.
 * @param ctx - the agent-plane context of the kernel-opt preset row.
 */
function applyCommands(ctx: Context): void {
  ctx.inject(['commands'], (cctx) => {
    const loop = (): LoopOps => cctx.kernelOptRuntime.loop

    cctx.commands.register({
      name: 'kloop',
      description: 'Kernel-opt loop: /kloop [budget] arms run-state-driven continuation '
        + '(stops on finalize, budget exhaustion, or no progress); /kloop stop disarms; /kloop status reports.',
      input: { hint: '[budget] | stop | status' },
      handler: (invocation) => {
        const raw = invocation.rawInput.trim()
        const sessionId = invocation.agent.id
        const ops = loop()
        if (raw === 'stop') {
          if (!ops.stop(sessionId)) return { kind: 'error', text: 'kernel loop is not armed.' }
          return { kind: 'success', text: 'Kernel loop stopped.' }
        }
        if (raw === 'status' || (raw !== '' && !/^\d+$/.test(raw))) {
          const state = ops.status(sessionId)
          const supervise = state.supervise ? 'on' : 'off'
          return {
            kind: 'success',
            text: state.armed
              ? `armed: round ${String(state.round)}, budget ${String(state.budget)}, supervisor ${supervise}.`
              : `not armed${state.stopReason !== undefined ? ` (last stop: ${state.stopReason})` : ''}; supervisor ${supervise}. Usage: /kloop [budget]`,
          }
        }
        // The same refusal the panel's control route gives: nothing would
        // advance a run the loop armed, so it does not arm one.
        const arm = ops.arm
        if (arm === undefined) return { kind: 'error', text: 'loop machinery not composed (llm absent).' }
        arm(sessionId, raw === '' ? ops.defaultBudget : Number(raw))
        const state = ops.status(sessionId)
        return {
          kind: 'success',
          text: `Kernel loop armed: budget ${String(state.budget)} evaluations, supervisor ${state.supervise ? 'on' : 'off'}. `
            + 'It continues the run whenever a turn settles unfinished, and asks for a finalize before stopping on '
            + 'budget/stall; /kloop stop disarms.',
        }
      },
    })

    cctx.commands.register({
      name: 'supervise',
      description: 'Second-model supervisor: /supervise on|off toggles review at kernel-loop continuation '
        + 'points; /supervise use <provider>/<model> overrides the supervisor route for this session '
        + '("use default" follows the plugin config again).',
      input: { hint: 'on | off | use <provider>/<model> | status' },
      handler: (invocation) => {
        const raw = invocation.rawInput.trim()
        const sessionId = invocation.agent.id
        const ops = loop()
        if (raw === 'on') {
          const error = ops.setSupervise(sessionId, true)
          if (error !== null) return { kind: 'error', text: error }
          const { supervisor } = ops.status(sessionId)
          return {
            kind: 'success',
            text: `Supervisor on${supervisor !== undefined ? ` (${supervisor.provider}/${supervisor.model}, ${supervisor.source})` : ''}; reviews run at kernel-loop continuation points.`,
          }
        }
        if (raw === 'off') {
          ops.setSupervise(sessionId, false)
          return { kind: 'success', text: 'Supervisor off.' }
        }
        if (raw.startsWith('use ') || raw === 'use') {
          const spec = raw.slice(3).trim()
          if (spec === 'default' || spec === '') {
            ops.setSupervisorRoute(sessionId, undefined)
            const { supervisor } = ops.status(sessionId)
            return {
              kind: 'success',
              text: supervisor !== undefined
                ? `Supervisor override cleared; following config: ${supervisor.provider}/${supervisor.model}.`
                : 'Supervisor override cleared; nothing configured — /supervise use <provider>/<model> to pick one.',
            }
          }
          // First slash splits: provider routes carry no slash, model ids may.
          const slash = spec.indexOf('/')
          if (slash <= 0 || slash === spec.length - 1) {
            return { kind: 'error', text: 'Usage: /supervise use <provider>/<model> (or `use default` to follow config).' }
          }
          ops.setSupervisorRoute(sessionId, { provider: spec.slice(0, slash), model: spec.slice(slash + 1) })
          const state = ops.status(sessionId)
          return {
            kind: 'success',
            text: `Supervisor model for this session: ${spec}.${state.supervise ? '' : ' Enable with /supervise on.'}`,
          }
        }
        const state = ops.status(sessionId)
        return {
          kind: 'success',
          text: `supervisor ${state.supervise ? 'on' : 'off'}; ${state.supervisor !== undefined ? `route: ${state.supervisor.provider}/${state.supervisor.model} (${state.supervisor.source})` : 'not configured'}.`,
        }
      },
    })
  })
}
