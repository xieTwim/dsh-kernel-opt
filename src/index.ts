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
 * @module @xsyshuishui/dsh-kernel-cockpit
 */
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
  decideContinuation, initialLoopState, supervisorDigest,
} from './loop.ts'
import type { LoopState } from './loop.ts'
import { SERIES_PATH } from './wire.ts'
import type { WireControl } from './wire.ts'

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
  /** Kernel-loop tuning. */
  loop?: {
    /** Budget when `/kloop` is armed without a number (default 20). */
    defaultBudget?: number
    /** Consecutive zero-progress continuations tolerated (default 2). */
    maxNoProgressRounds?: number
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
    planTool: DEFAULT_PROJECTION.planTool,
  }
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

    /** One supervisor review; any failure degrades to null advice. */
    const review = async (sessionId: string, state: LoopState): Promise<string | null> => {
      const supervisor = config.supervisor
      if (supervisor === undefined || !state.supervise) return null
      const session = lctx.sessions.get(SessionId(sessionId))
      if (session === undefined) return null
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
        return adviceFromReply(reply)
      } catch {
        // A broken or slow reviewer must never stall the primary loop.
        return null
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
      state.noProgressRounds = state.round > 0 && decision.evalsDone <= state.lastEvalCount
        ? state.noProgressRounds + 1
        : 0
      state.round += 1
      state.lastEvalCount = decision.evalsDone
      const advice = await review(sessionId, state)
      state.lastAdvice = advice ?? state.lastAdvice
      // Re-check idleness after the (possibly slow) review; a human message
      // that arrived meanwhile owns the session.
      if (lctx.agents.get(SessionId(sessionId)) !== agent || agent.status !== 'idle') return
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: continuationText(state.round, decision.evalsDone, state.budget, advice) }],
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
          if (!state.armed) return { kind: 'error', text: 'kernel loop is not armed.' }
          state.armed = false
          state.stopReason = 'stopped'
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
        state.armed = true
        state.budget = raw === '' ? defaultBudget : Number(raw)
        state.round = 0
        state.lastEvalCount = 0
        state.noProgressRounds = 0
        delete state.stopReason
        scheduleCheckpoint(sessionId, 10)
        return {
          kind: 'success',
          text: `Kernel loop armed: budget ${String(state.budget)} evaluations, supervisor ${state.supervise ? 'on' : 'off'}. `
            + 'It continues the run whenever a turn settles unfinished; /kloop stop disarms.',
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
          if (config.supervisor === undefined) {
            return {
              kind: 'error',
              text: 'No supervisor model configured. Add to the kernel-cockpit plugin config: '
                + 'supervisor: { provider: <route>, model: <id> } — a distinct route/model from the primary.',
            }
          }
          state.supervise = true
          return { kind: 'success', text: `Supervisor on (${config.supervisor.provider}/${config.supervisor.model}); reviews run at kernel-loop continuation points.` }
        }
        if (raw === 'off') {
          state.supervise = false
          return { kind: 'success', text: 'Supervisor off.' }
        }
        return {
          kind: 'success',
          text: `supervisor ${state.supervise ? 'on' : 'off'}; ${config.supervisor !== undefined ? `configured: ${config.supervisor.provider}/${config.supervisor.model}` : 'not configured'}.`,
        }
      },
    })
  })

  // Series route — pure projection of session.events per query, plus the
  // loop/supervisor control state. register() returns the route disposer, so
  // the registration rides an effect.
  ctx.inject(['webServer'], (wctx) => {
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
          const state = loops.get(rawId)
          const control: WireControl = {
            loop: {
              armed: state?.armed ?? false,
              budget: state?.budget ?? 0,
              round: state?.round ?? 0,
              evalsDone: completedEvals(series),
              ...(state?.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
            },
            supervisor: {
              enabled: state?.supervise ?? false,
              configured: config.supervisor !== undefined,
              ...(state?.lastAdvice !== undefined ? { lastAdvice: state.lastAdvice } : {}),
            },
          }
          respond(200, { ...series, control })
        } catch (error) {
          respond(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'kernel-cockpit: series route')
  })
}
