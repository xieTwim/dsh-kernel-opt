import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/self-compact.ts
const name = "kernel-opt-self-compact";
const inject = [
	"tools",
	"agents",
	"compaction"
];
/**
* Register the log-preserving compaction lever.
* @param ctx - the agent-plane context of the preset's compaction group.
*/
function apply(ctx) {
	ctx.tools.register(defineTool({
		name: "self_compact",
		description: "Compact THIS session's older history into a summary now, keeping the recent tail. Use when you switch to a different optimization approach family and the accumulated tool output no longer pays rent, or when old exploration details stop being relevant. The full history stays in the durable session log; only the model-visible context shrinks. State what must survive in reason — it becomes part of the record.",
		parameters: { reason: {
			type: "string",
			required: true,
			description: "Why compaction is safe now and what must survive."
		} },
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute: async (args, exec) => {
			const agent = ctx.agents.currentInitiator();
			if (agent === void 0) throw new Error("self_compact requires an active agent turn");
			const result = await ctx.compaction.compactNow(agent, exec.signal);
			if (result === null) return "No compactable history yet — continue as is.";
			return `Compacted ${result.shadowedSeqs.length} history items (~${result.shadowedTokenCount} tokens). Reason recorded: ${args.reason}`;
		}
	}));
}
//#endregion
export { apply, inject, name };
