/**
 * dsh-kernel-cockpit — Node half.
 *
 * Live kernel-optimization cockpit for DeepSeek Harness. The session log is
 * the only data source: kernel evaluations (e.g. the AKO runtime's MCP
 * `kernel_evaluate`), profiler calls, finalize picks, and the model's own
 * `cockpit_plan` reports are projected out of `session.events` per query and
 * served as JSON for the browser panel — no plugin-side state to drift or
 * leak, and replayed sessions render identically.
 *
 * Model-facing levers registered here:
 * - `cockpit_plan` — state the current optimization plan to the human panel;
 * - `self_compact` — compact this session's older history through the
 *   `compaction` seam when the accumulated context stops paying rent
 *   (registered only when a compaction provider is composed in).
 *
 * @module @xsyshuishui/dsh-kernel-cockpit
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-compaction'
import { DEFAULT_PROJECTION, project } from './projection.ts'
import type { ProjectionConfig } from './projection.ts'
import { SERIES_PATH } from './wire.ts'

export const name = 'kernel-cockpit'
export const inject = ['tools', 'agents', 'sessions']

/**
 * Cockpit configuration. All fields optional; defaults target the AKO runtime
 * MCP tools (`kernel_evaluate` / `kernel_profile` / `run_finalize`). Names
 * match exactly or as a separator-delimited suffix, so MCP server prefixes
 * (e.g. `ako__kernel_evaluate`) are covered without configuration.
 */
export interface Config {
  /** Tool names treated as kernel evaluations (curve points). */
  benchTools?: string[]
  /** Tool names treated as profiler calls (▲ markers). */
  profileTools?: string[]
  /** Tool names treated as finalize picks (★ marker via `evaluation_id`). */
  finalizeTools?: string[]
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
 * Mount the cockpit: plan tool, optional self-compaction tool, and the
 * per-session series route the browser panel polls.
 * @param ctx - plugin context.
 * @param config - optional tool-name routing overrides.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const projection = resolveProjection(config)

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

  // Series route — pure projection of session.events per query. register()
  // returns the route disposer, so the registration rides an effect.
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
          respond(200, project(rawId, session.events, projection))
        } catch (error) {
          respond(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'kernel-cockpit: series route')
  })
}
