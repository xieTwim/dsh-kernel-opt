/**
 * dsh-kernel-cockpit — Node half.
 *
 * Live kernel-optimization cockpit for DeepSeek Harness. The session log is
 * the only data source: kernel evaluations (e.g. the AKO runtime's MCP
 * `kernel_evaluate`), profiler calls, finalize picks, and the model's own
 * `cockpit_plan` reports are projected out of `session.events` per query and
 * served as JSON for the browser panel — no plugin-side derived state to
 * drift or leak, and replayed sessions render identically.
 *
 * On top of the projection sit the run controls:
 * - `cockpit_plan` / `self_compact` tools — the model's levers (plan
 *   reporting; log-preserving context compaction through the `compaction`
 *   seam, registered only when a provider is composed in);
 * - `/kloop` — a kernel-opt loop that re-drives the agent at turn settle
 *   while the projected run state says the run is unfinished (budget left,
 *   no finalize, still making progress) — run-state-driven, not a timer;
 * - `/supervise` — an optional second model that reviews a run digest at
 *   each continuation point and rides its advice on the continuation
 *   message; failures degrade to "no advice", never a stalled loop.
 *
 * @module @xietwim/dsh-kernel-cockpit
 */
import type { IncomingMessage } from 'node:http'
import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-commands'
import { DEFAULT_PROJECTION, project } from './projection.ts'
import type { ProjectionConfig } from './projection.ts'
import {
  SUPERVISOR_SYSTEM, adviceFromReply, completedEvals, continuationText,
  decideContinuation, initialLoopState, stagnationCount, supervisorDigest, wrapUpText,
} from './loop.ts'
import type { LoopState } from './loop.ts'
import { CONTROL_PATH, REPLAY_LINE_PREFIX, SERIES_PATH, samePath } from './wire.ts'
import type { WireControl, WireIteration, WireSeries } from './wire.ts'

export const name = 'kernel-cockpit'
export const inject = ['tools', 'agents', 'sessions']

/** Plugin id stamped on plugin-sourced messages. */
const PLUGIN_ID = 'kernel-cockpit'

/** Delay between a logged turn end and the idle check that may continue. */
const SETTLE_DELAY_MS = 1200

/**
 * Cockpit configuration. All fields optional; tool-name defaults target the
 * AKO runtime MCP tools (`kernel_evaluate` / `kernel_profile` /
 * `run_finalize`). Names match exactly or as a separator-delimited suffix, so
 * MCP server prefixes (e.g. `mcp__ako__kernel_evaluate`) are covered without
 * configuration.
 */
export interface Config {
  /** Tool names treated as kernel evaluations (curve points). */
  benchTools?: string[]
  /** Tool names treated as profiler calls (▲ markers). */
  profileTools?: string[]
  /** Tool names treated as finalize picks (★ marker via `evaluation_id`). */
  finalizeTools?: string[]
  /** Tool names treated as structured artifact changes (default `write`/`edit`). */
  changeTools?: string[]
  /**
   * Shell tools whose results are scanned for the `KERNEL_COCKPIT_EVAL=`
   * contract trailer (self-reported channel; default `['bash']`).
   */
  shellTools?: string[]
  /** Kernel-loop tuning. */
  loop?: {
    /** Budget when `/kloop` is armed without a number (default 20). */
    defaultBudget?: number
    /** Consecutive zero-progress continuations tolerated (default 2). */
    maxNoProgressRounds?: number
  }
  /**
   * Finalize replay: when `cockpit_finalize` names an artifact whose best
   * measurement is self-reported (shell channel), the plugin re-executes the
   * recorded command once — outside any agent turn — and appends the output
   * to the tool result; the trailer inside becomes the verified final
   * measurement. On by default; every failure degrades to "stays
   * self-reported", never a blocked finalize.
   */
  replay?: {
    /** Master switch (default true). */
    enabled?: boolean
    /** Kill the replayed command after this many seconds (default 900). */
    timeoutSec?: number
  }
  /**
   * Second-model supervisor route. `/supervise on` is a hard gate on this
   * being present — without it the toggle reports how to configure instead of
   * silently reviewing with the primary model.
   */
  supervisor?: {
    /** Registered provider route (as in the Models settings). */
    provider: string
    /** Model id on that provider. */
    model: string
    temperature?: number
    /** Advice budget per review (default 400). */
    maxTokens?: number
  }
}

/** Resolve the projection routing from plugin config over defaults. */
function resolveProjection(config: Config): ProjectionConfig {
  return {
    benchTools: config.benchTools ?? DEFAULT_PROJECTION.benchTools,
    profileTools: config.profileTools ?? DEFAULT_PROJECTION.profileTools,
    finalizeTools: config.finalizeTools ?? DEFAULT_PROJECTION.finalizeTools,
    changeTools: config.changeTools ?? DEFAULT_PROJECTION.changeTools,
    shellTools: config.shellTools ?? DEFAULT_PROJECTION.shellTools,
    planTool: DEFAULT_PROJECTION.planTool,
  }
}

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

/** Read and parse a small JSON request body; null on any shape/size problem. */
function readJsonBody(req: IncomingMessage, maxBytes = 16_384): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const done = (value: Record<string, unknown> | null): void => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        done(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        done(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : null)
      } catch {
        done(null)
      }
    })
    req.on('error', () => {
      done(null)
    })
  })
}

/**
 * Mount the cockpit: model tools, kernel loop + supervisor commands, and the
 * per-session series route the browser panel polls.
 * @param ctx - plugin context.
 * @param config - optional routing/loop/supervisor overrides.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const projection = resolveProjection(config)
  const maxNoProgress = config.loop?.maxNoProgressRounds ?? 2
  const defaultBudget = config.loop?.defaultBudget ?? 20
  const finalizeHint = projection.finalizeTools.join(' / ')

  /** Per-session loop state; sessions without an entry never looped. */
  const loops = new Map<string, LoopState>()
  const stateFor = (sessionId: string): LoopState => {
    let state = loops.get(sessionId)
    if (state === undefined) {
      state = initialLoopState()
      loops.set(sessionId, state)
    }
    return state
  }

  /**
   * Loop-machinery face shared with the control route. `arm` exists exactly
   * while the commands/llm composition is live; the route degrades to an
   * explicit 503 instead of arming a loop nothing would drive.
   */
  const bridge: { arm?: (sessionId: string, budget: number) => void } = {}

  /** Disarm a session's loop by human decision (no wrap-up round). */
  const stopLoop = (sessionId: string): boolean => {
    const state = loops.get(sessionId)
    if (state === undefined || !state.armed) return false
    state.armed = false
    state.stopReason = 'stopped'
    return true
  }

  /** Toggle supervision; returns an error string when the gate fails. */
  const setSupervise = (sessionId: string, enabled: boolean): string | null => {
    if (enabled && config.supervisor === undefined) {
      return 'No supervisor model configured. Add to the kernel-cockpit plugin config: '
        + 'supervisor: { provider: <route>, model: <id> } — a distinct route/model from the primary.'
    }
    stateFor(sessionId).supervise = enabled
    return null
  }

  // cockpit_plan — the call itself is the record: the projection reads the
  // logged arguments, so the tool body only acknowledges.
  ctx.tools.register(defineTool({
    name: 'cockpit_plan',
    description: 'Report your CURRENT kernel-optimization plan to the human cockpit panel. '
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

  // cockpit_finalize — the finalize record for evaluation pipelines with no
  // evaluator-issued ids (the self-reported channel). The call itself is the
  // record; when the artifact's best measurement is self-reported and replay
  // is enabled, the plugin re-executes that recorded command once and appends
  // its output — the trailer inside becomes the verified [replay] final
  // measurement, read back by the projection like everything else.
  ctx.tools.register(defineTool({
    name: 'cockpit_finalize',
    description: 'Record your FINAL kernel choice by artifact path (for evaluation pipelines without '
      + 'evaluator-issued ids; with an id-issuing evaluator call its own finalize instead). Call once, at the '
      + 'end, with the artifact you stand behind — restore it verbatim first if a later edit regressed it. '
      + 'When the best measurement for that artifact is self-reported, the cockpit replays the recorded '
      + 'benchmark command once and appends the output as the verified final measurement.',
    parameters: {
      artifact_path: { type: 'string', required: true, description: 'Path of the final artifact, as printed in its KERNEL_COCKPIT_EVAL trailer.' },
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
      if (config.replay?.enabled === false) return `${ack} Replay disabled by config; the final number stays self-reported.`
      const series = project(agent.id, session.events, projection)
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
      const outcome = await runReplay(command, cwd, (config.replay?.timeoutSec ?? 900) * 1000, exec.signal)
      const lines = [ack, `${REPLAY_LINE_PREFIX}${command}`]
      if (outcome.failure !== undefined) {
        lines.push(`Replay failed: ${outcome.failure}. The final number stays self-reported.`)
      }
      lines.push('--- replay output ---', capReplayOutput(outcome.output))
      if (outcome.exit !== null) lines.push(`[replay exit ${String(outcome.exit)}]`)
      return lines.join('\n')
    },
  }))

  // self_compact — only exists when a compaction provider is composed in.
  ctx.inject(['compaction'], (cctx) => {
    cctx.tools.register(defineTool({
      name: 'self_compact',
      description: 'Compact THIS session\'s older history into a summary now, keeping the recent tail. '
        + 'Use when you switch to a different optimization approach family and the accumulated '
        + 'tool output no longer pays rent, or when old exploration details stop being relevant. '
        + 'The full history stays in the durable session log; only the model-visible context shrinks. '
        + 'State what must survive in reason — it becomes part of the record.',
      parameters: {
        reason: { type: 'string', required: true, description: 'Why compaction is safe now and what must survive.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: async (args, exec) => {
        const agent = cctx.agents.currentInitiator()
        if (agent === undefined) throw new Error('self_compact requires an active agent turn')
        const result = await cctx.compaction.compactNow(agent, exec.signal)
        if (result === null) return 'No compactable history yet — continue as is.'
        return `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens). `
          + `Reason recorded: ${args.reason}`
      },
    }))
  })

  // Kernel loop + supervisor: commands, settle-driven continuation, review.
  ctx.inject(['commands', 'llm'], (lctx) => {
    /** Pending settle timers, cleared with the plugin. */
    const timers = new Set<ReturnType<typeof setTimeout>>()
    lctx.effect(() => () => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }, 'kernel-cockpit: loop timers')

    /** One supervisor review; any failure degrades to unreviewed/no advice. */
    const review = async (
      sessionId: string,
      state: LoopState,
    ): Promise<{ advice: string | null; reviewed: boolean }> => {
      const supervisor = config.supervisor
      if (supervisor === undefined || !state.supervise) return { advice: null, reviewed: false }
      const session = lctx.sessions.get(SessionId(sessionId))
      if (session === undefined) return { advice: null, reviewed: false }
      try {
        const digest = supervisorDigest(project(sessionId, session.events, projection), state)
        let reply = ''
        const stream = lctx.llm.stream({
          provider: supervisor.provider,
          model: supervisor.model,
          system: SUPERVISOR_SYSTEM,
          messages: [createUserMessage({
            content: [{ type: 'text', text: digest }],
            source: { kind: 'plugin', plugin: PLUGIN_ID },
          })],
          ...(supervisor.temperature !== undefined ? { temperature: supervisor.temperature } : {}),
          maxTokens: supervisor.maxTokens ?? 400,
          signal: AbortSignal.timeout(60_000),
        })
        for await (const chunk of stream) {
          if (chunk.type === 'text-delta') reply += chunk.text
        }
        return { advice: adviceFromReply(reply), reviewed: true }
      } catch {
        // A broken or slow reviewer must never stall the primary loop.
        return { advice: null, reviewed: false }
      }
    }

    /** Settle checkpoint: decide from projected run state, then re-drive. */
    const checkpoint = async (sessionId: string): Promise<void> => {
      const state = loops.get(sessionId)
      if (state === undefined || !state.armed) return
      const agent = lctx.agents.get(SessionId(sessionId))
      const session = lctx.sessions.get(SessionId(sessionId))
      if (agent === undefined || session === undefined) {
        state.armed = false
        state.stopReason = 'stopped'
        return
      }
      // A queued user turn or still-running work owns the session; the next
      // turn end re-triggers this checkpoint.
      if (agent.status !== 'idle') return
      const series = project(sessionId, session.events, projection)
      const decision = decideContinuation(series, state, maxNoProgress)
      if (decision.action === 'stop') {
        state.armed = false
        state.stopReason = decision.reason
        return
      }
      if (decision.action === 'wrap-up') {
        // Budget/stall endings finish clean: disarm, then one closing message
        // asking the model to finalize its best honest result. No review —
        // the budget is spent; the wrap-up instruction is fixed.
        state.armed = false
        state.stopReason = decision.reason
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: wrapUpText(decision.evalsDone, state.budget, decision.reason, finalizeHint) }],
          source: { kind: 'plugin', plugin: PLUGIN_ID },
        }))
        return
      }
      state.noProgressRounds = state.round > 0 && decision.evalsDone <= state.lastEvalCount
        ? state.noProgressRounds + 1
        : 0
      state.round += 1
      state.lastEvalCount = decision.evalsDone
      const { advice, reviewed } = await review(sessionId, state)
      state.lastAdvice = advice ?? state.lastAdvice
      // Re-check idleness after the (possibly slow) review; a human message
      // that arrived meanwhile owns the session.
      if (lctx.agents.get(SessionId(sessionId)) !== agent || agent.status !== 'idle') return
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: continuationText(
            state.round, decision.evalsDone, state.budget, advice,
            reviewed && advice === null, stagnationCount(series), finalizeHint,
          ),
        }],
        source: { kind: 'plugin', plugin: PLUGIN_ID },
      }))
    }

    const scheduleCheckpoint = (sessionId: string, delayMs: number): void => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        void checkpoint(sessionId)
      }, delayMs)
      timers.add(timer)
    }

    /** Arm (or re-arm) the loop for a session; shared by /kloop and the control route. */
    const armLoop = (sessionId: string, budget: number): void => {
      const state = stateFor(sessionId)
      state.armed = true
      state.budget = budget
      state.round = 0
      state.lastEvalCount = 0
      state.noProgressRounds = 0
      delete state.stopReason
      scheduleCheckpoint(sessionId, 10)
    }
    bridge.arm = armLoop
    lctx.effect(() => () => {
      delete bridge.arm
    }, 'kernel-cockpit: loop bridge')

    // The loop trigger is the logged turn boundary — the same surface the
    // projection reads, so a continuation can never race its own data.
    lctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const state = loops.get(session.id)
      if (state === undefined || !state.armed) return
      scheduleCheckpoint(session.id, SETTLE_DELAY_MS)
    })

    lctx.on('agent/disposed', ({ agent }) => {
      loops.delete(agent.id)
    })

    lctx.commands.register({
      name: 'kloop',
      description: 'Kernel-opt loop: /kloop [budget] arms run-state-driven continuation '
        + '(stops on finalize, budget exhaustion, or no progress); /kloop stop disarms; /kloop status reports.',
      input: { hint: '[budget] | stop | status' },
      handler: (invocation) => {
        const raw = invocation.rawInput.trim()
        const sessionId = invocation.agent.id
        const state = stateFor(sessionId)
        if (raw === 'stop') {
          if (!stopLoop(sessionId)) return { kind: 'error', text: 'kernel loop is not armed.' }
          return { kind: 'success', text: 'Kernel loop stopped.' }
        }
        if (raw === 'status' || (raw !== '' && !/^\d+$/.test(raw))) {
          const supervise = state.supervise ? 'on' : 'off'
          return {
            kind: 'success',
            text: state.armed
              ? `armed: round ${String(state.round)}, budget ${String(state.budget)}, supervisor ${supervise}.`
              : `not armed${state.stopReason !== undefined ? ` (last stop: ${state.stopReason})` : ''}; supervisor ${supervise}. Usage: /kloop [budget]`,
          }
        }
        armLoop(sessionId, raw === '' ? defaultBudget : Number(raw))
        return {
          kind: 'success',
          text: `Kernel loop armed: budget ${String(state.budget)} evaluations, supervisor ${state.supervise ? 'on' : 'off'}. `
            + 'It continues the run whenever a turn settles unfinished, and asks for a finalize before stopping on '
            + 'budget/stall; /kloop stop disarms.',
        }
      },
    })

    lctx.commands.register({
      name: 'supervise',
      description: 'Second-model supervisor: /supervise on|off toggles review at kernel-loop '
        + 'continuation points (requires supervisor {provider, model} in the kernel-cockpit plugin config).',
      input: { hint: 'on | off | status' },
      handler: (invocation) => {
        const raw = invocation.rawInput.trim()
        const state = stateFor(invocation.agent.id)
        if (raw === 'on') {
          const error = setSupervise(invocation.agent.id, true)
          if (error !== null) return { kind: 'error', text: error }
          const supervisor = config.supervisor
          return {
            kind: 'success',
            text: `Supervisor on${supervisor !== undefined ? ` (${supervisor.provider}/${supervisor.model})` : ''}; reviews run at kernel-loop continuation points.`,
          }
        }
        if (raw === 'off') {
          setSupervise(invocation.agent.id, false)
          return { kind: 'success', text: 'Supervisor off.' }
        }
        return {
          kind: 'success',
          text: `supervisor ${state.supervise ? 'on' : 'off'}; ${config.supervisor !== undefined ? `configured: ${config.supervisor.provider}/${config.supervisor.model}` : 'not configured'}.`,
        }
      },
    })
  })

  // Series + control routes — the series is a pure projection of
  // session.events per query; the control route drives the same in-memory
  // loop state as the slash commands. register() returns the route disposer,
  // so each registration rides an effect.
  ctx.inject(['webServer'], (wctx) => {
    const buildControl = (sessionId: string, series: WireSeries): WireControl => {
      const state = loops.get(sessionId)
      return {
        loop: {
          armed: state?.armed ?? false,
          budget: state?.budget ?? 0,
          round: state?.round ?? 0,
          evalsDone: completedEvals(series),
          available: bridge.arm !== undefined,
          ...(state?.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
        },
        supervisor: {
          enabled: state?.supervise ?? false,
          configured: config.supervisor !== undefined,
          ...(state?.lastAdvice !== undefined ? { lastAdvice: state.lastAdvice } : {}),
        },
      }
    }

    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: SERIES_PATH,
      handler: (req, res) => {
        const respond = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        }
        try {
          const url = new URL(req.url ?? '/', 'http://dsh.internal')
          const rawId = url.searchParams.get('sessionId') ?? ''
          if (rawId === '') {
            respond(400, { error: 'sessionId query parameter required' })
            return
          }
          const session = wctx.sessions.get(SessionId(rawId))
          if (session === undefined) {
            respond(404, { error: 'unknown session' })
            return
          }
          const series = project(rawId, session.events, projection)
          respond(200, { ...series, control: buildControl(rawId, series) })
        } catch (error) {
          respond(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'kernel-cockpit: series route')

    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: CONTROL_PATH,
      handler: (req, res) => {
        const respond = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        }
        if (req.method !== 'POST') {
          respond(405, { error: 'POST only' })
          return
        }
        void (async () => {
          try {
            const body = await readJsonBody(req)
            if (body === null) {
              respond(400, { error: 'JSON body required' })
              return
            }
            const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : ''
            const action = typeof body['action'] === 'string' ? body['action'] : ''
            const session = sessionId === '' ? undefined : wctx.sessions.get(SessionId(sessionId))
            if (session === undefined) {
              respond(404, { error: 'unknown session' })
              return
            }
            let error: string | null = null
            if (action === 'loop-arm') {
              const arm = bridge.arm
              if (arm === undefined) {
                respond(503, { error: 'loop machinery not composed (commands/llm absent)' })
                return
              }
              const raw = body['budget']
              const budget = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 && raw <= 9999
                ? raw
                : defaultBudget
              arm(sessionId, budget)
            } else if (action === 'loop-stop') {
              stopLoop(sessionId)
            } else if (action === 'supervise-on') {
              error = setSupervise(sessionId, true)
            } else if (action === 'supervise-off') {
              error = setSupervise(sessionId, false)
            } else {
              respond(400, { error: `unknown action: ${action}` })
              return
            }
            const series = project(sessionId, session.events, projection)
            if (error !== null) {
              respond(409, { error, control: buildControl(sessionId, series) })
              return
            }
            respond(200, { control: buildControl(sessionId, series) })
          } catch (err) {
            respond(500, { error: err instanceof Error ? err.message : String(err) })
          }
        })()
      },
    }), 'kernel-cockpit: control route')
  })
}
