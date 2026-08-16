/**
 * dsh-kernel-opt — the `self_compact` tool, mounted inside the preset's
 * compaction group.
 *
 * Separate from the other three tools because of where `compaction` LIVES.
 * The standard preset puts its compaction rows in a group carrying
 * `isolate: { compaction: true }`, so the service exists only inside that
 * group: a profile-plane `ctx.inject(['compaction'], …)` never fires, and
 * this tool — which the persona tells the agent to use when it switches
 * approach families — was silently absent from every session's catalog.
 * Registering it from a row INSIDE the group is what makes it exist.
 *
 * `tools` is not isolated by that group, so the registration still reaches
 * the agent's own catalog exactly like the other rows.
 *
 * @module @xietwim/dsh-kernel-opt/self-compact
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-compaction'

export const name = 'kernel-opt-self-compact'
export const inject = ['tools', 'agents', 'compaction']

/**
 * Register the log-preserving compaction lever.
 * @param ctx - the agent-plane context of the preset's compaction group.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
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
      const agent = ctx.agents.currentInitiator()
      if (agent === undefined) throw new Error('self_compact requires an active agent turn')
      const result = await ctx.compaction.compactNow(agent, exec.signal)
      if (result === null) return 'No compactable history yet — continue as is.'
      return `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens). `
        + `Reason recorded: ${args.reason}`
    },
  }))
}
