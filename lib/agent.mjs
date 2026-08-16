import { f as REPLAY_LINE_PREFIX, r as project, y as samePath } from "./chunk-projection-CsZov8Cm.mjs";
import { SessionId } from "@deepseek-ai/dsh-session";
import { spawn } from "node:child_process";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/agent.ts
/**
* dsh-kernel-opt — the model-facing tools, mounted in the AGENT plane.
*
* `kernel_plan`, `kernel_env` and `kernel_finalize` are the levers of ONE
* mode. A session that chose a general coding preset can neither use them nor
* see the panel they feed, so registering them at profile level put their
* descriptions in every unrelated session's tool catalog for nothing. They
* live here instead, as a row in `preset/kernel-opt/agent.cordis.yml`, and a
* session that did not choose 「算子优化模式」 never carries them.
*
* The tools stay declarative: the call itself is the record. The projection
* reads the logged arguments, so two of the three bodies only acknowledge.
* The exception is `kernel_finalize`, which replays the recorded bench
* command once to turn a self-reported best into a verified one.
*
* Configuration is NOT restated on the preset row — it is read from the
* `kernelOptRuntime` service the profile-plane half publishes, which is also
* why this row does not mount when the plugin is absent.
*
* @module @xietwim/dsh-kernel-opt/agent
*/
const name = "kernel-opt-tools";
const inject = [
	"tools",
	"agents",
	"sessions",
	"kernelOptRuntime"
];
/** Run one recorded benchmark command (`bash -c`); resolves, never throws. */
function runReplay(command, cwd, timeoutMs, signal) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn("bash", ["-c", command], {
				cwd,
				timeout: timeoutMs,
				...signal !== void 0 ? { signal } : {}
			});
		} catch (error) {
			resolve({
				output: "",
				exit: null,
				failure: error instanceof Error ? error.message : String(error)
			});
			return;
		}
		const chunks = [];
		let size = 0;
		const take = (chunk) => {
			if (size > 2e5) return;
			size += chunk.length;
			chunks.push(chunk.toString("utf8"));
		};
		child.stdout?.on("data", take);
		child.stderr?.on("data", take);
		child.on("error", (error) => {
			resolve({
				output: chunks.join(""),
				exit: null,
				failure: error.message
			});
		});
		child.on("close", (code, killSignal) => {
			resolve({
				output: chunks.join(""),
				exit: code,
				...killSignal !== null ? { failure: `terminated by ${killSignal}` } : {}
			});
		});
	});
}
/** Cap replay output for the tool result, keeping the tail (trailer lives there). */
function capReplayOutput(output, headCap = 2e3, tailCap = 1e4) {
	if (output.length <= headCap + tailCap) return output;
	return `${output.slice(0, headCap)}\n…[replay output trimmed]…\n${output.slice(output.length - tailCap)}`;
}
/**
* Register the mode's model-facing tools.
* @param ctx - the agent-plane context of the kernel-opt preset row.
*/
function apply(ctx) {
	ctx.tools.register(defineTool({
		name: "kernel_plan",
		description: "Report your CURRENT kernel-optimization plan to the human evaluation panel. Call BEFORE starting a new approach and again whenever the plan changes, so the human can steer early instead of after a wasted iteration. Keep every field to one short line. phase: loop stage (e.g. explore / tune / verify / stuck). approach: the technique being tried (e.g. \"split-K over KV, BLOCK_H=8\"). hypothesis: why it should be faster. next: the immediate action.",
		parameters: {
			phase: {
				type: "string",
				required: true,
				description: "Loop stage: explore / tune / verify / stuck / done."
			},
			approach: {
				type: "string",
				required: true,
				description: "One-line description of the current technique."
			},
			hypothesis: {
				type: "string",
				description: "Why this should be faster (one line)."
			},
			next: {
				type: "string",
				description: "Immediate next action (one line)."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute: async (args) => {
			return `Plan recorded (${args.phase}): ${args.approach}`;
		}
	}));
	ctx.tools.register(defineTool({
		name: "kernel_env",
		description: "Report the environment your EVALUATIONS run in, to the human evaluation panel. Call once after inventory and BEFORE the first evaluation, and again whenever the environment changes (you move to a remote host, switch device, or the user constrains it). Report where the BENCHMARK executes, not where you are thinking: if the user pointed you at a remote machine or a cloud runner, describe THAT machine. If the user ruled a device out (\"CPU only\", a pinned CUDA_VISIBLE_DEVICES), state the device you are actually using and put the instruction in constraint. Read the facts, never guess them, and name the commands you read them from in probe.",
		parameters: {
			location: {
				type: "string",
				required: true,
				description: "Where evaluations execute, e.g. \"本机 (macOS)\" / \"远程 GPU 主机\" / \"Modal B200 容器\"."
			},
			device: {
				type: "string",
				required: true,
				description: "The compute device the timed runs use, e.g. \"NVIDIA H100 80GB ×1\" / \"Apple M5 CPU (10 核)\"."
			},
			constraint: {
				type: "string",
				description: "User/task instruction that decided the device, e.g. \"用户要求仅用 CPU\" / \"CUDA_VISIBLE_DEVICES=0\"."
			},
			versions: {
				type: "object",
				additionalProperties: true,
				description: "Key toolchain versions as read, e.g. {\"python\":\"3.11.9\",\"torch\":\"2.6.0+cu124\",\"cuda\":\"12.4\",\"driver\":\"550.90\"}."
			},
			probe: {
				type: "string",
				description: "Command(s) these facts were read from, e.g. \"nvidia-smi; python -c ...\"."
			},
			notes: {
				type: "string",
				description: "Anything qualifying the measurements (clocks not locked, shared host, …)."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute: async (args) => {
			return `Environment recorded: ${args.device} @ ${args.location}`;
		}
	}));
	ctx.tools.register(defineTool({
		name: "kernel_finalize",
		description: "Record your FINAL kernel choice by artifact path (for evaluation pipelines without evaluator-issued ids; with an id-issuing evaluator call its own finalize instead). Call once, at the end, with the artifact you stand behind — restore it verbatim first if a later edit regressed it. When the best measurement for that artifact is self-reported, the plugin replays the recorded benchmark command once and appends the output as the verified final measurement.",
		parameters: {
			artifact_path: {
				type: "string",
				required: true,
				description: "Path of the final artifact, as printed in its KERNEL_EVAL trailer."
			},
			note: {
				type: "string",
				description: "One-line closing note (optional)."
			}
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{
				type: "text",
				text: value
			}]
		},
		execute: async (args, exec) => {
			const ack = `Finalize recorded for ${args.artifact_path}.${args.note !== void 0 ? ` Note: ${args.note}` : ""}`;
			const agent = ctx.agents.currentInitiator();
			if (agent === void 0) return `${ack} (no active agent turn; not replayed)`;
			const session = ctx.sessions.get(SessionId(agent.id));
			if (session === void 0) return `${ack} (session not found; not replayed)`;
			const runtime = ctx.kernelOptRuntime;
			if (!runtime.replay.enabled) return `${ack} Replay disabled by config; the final number stays self-reported.`;
			const series = project(agent.id, session.events, runtime.projection);
			let best;
			for (const point of series.iterations) {
				if (point.channel !== "shell") continue;
				if (point.artifactPath === void 0 || !samePath(point.artifactPath, args.artifact_path)) continue;
				if (point.correct !== true || point.rewardHack === true || point.error !== void 0) continue;
				if (point.latencyMs === void 0) continue;
				if (best?.latencyMs === void 0 || point.latencyMs < best.latencyMs) best = point;
			}
			if (best === void 0) return `${ack} No self-reported measurement found for this artifact — nothing to replay (tool-channel measurements are already verified).`;
			const command = best.command;
			if (command === void 0 || command.endsWith("…")) return `${ack} Recorded command ${command === void 0 ? "unavailable" : "truncated in the projection"}; not replayed.`;
			const cwd = session.header.cwd;
			if (typeof cwd !== "string" || cwd.length === 0) return `${ack} Session working directory unknown; not replayed.`;
			const outcome = await runReplay(command, cwd, runtime.replay.timeoutMs, exec.signal);
			const lines = [ack, `${REPLAY_LINE_PREFIX}${command}`];
			if (outcome.failure !== void 0) lines.push(`Replay failed: ${outcome.failure}. The final number stays self-reported.`);
			lines.push("--- replay output ---", capReplayOutput(outcome.output));
			if (outcome.exit !== null) lines.push(`[replay exit ${String(outcome.exit)}]`);
			return lines.join("\n");
		}
	}));
}
//#endregion
export { apply, inject, name };
