/**
 * dsh-kernel-opt — Node half.
 *
 * Live kernel-optimization panel and loop for DeepSeek Harness. The session log is
 * the only data source: kernel evaluations (evaluator tool results, or
 * `KERNEL_EVAL=` contract trailers in shell output), profiler calls,
 * finalize picks, and the model's own `kernel_plan` reports are projected
 * out of `session.events` per query and served as JSON for the browser panel
 * — no plugin-side derived state to drift or leak, and replayed sessions
 * render identically.
 *
 * On top of the projection sit the run controls:
 * - `kernel_plan` / `self_compact` tools — the model's levers (plan
 *   reporting; log-preserving context compaction through the `compaction`
 *   seam, registered only when a provider is composed in);
 * - `/kloop` — a kernel-opt loop that re-drives the agent at turn settle
 *   while the projected run state says the run is unfinished (budget left,
 *   no finalize, still making progress) — run-state-driven, not a timer;
 * - `/supervise` — an optional second model that reviews a run digest at
 *   each continuation point and rides its advice on the continuation
 *   message; failures degrade to "no advice", never a stalled loop.
 *
 * @module @xietwim/dsh-kernel-opt
 */
import type { IncomingMessage } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-commands'
import { DEFAULT_PROJECTION, hasUserTask, project } from './projection.ts'
import type { ProjectionConfig } from './projection.ts'
import {
  HEADROOM_SYSTEM, SUPERVISOR_SYSTEM, adviceFromReply, challengeText, completedEvals,
  continuationText, decideContinuation, finalAuditText, initialLoopState, planStale,
  reviewable, stagnationCount, supervisorDigest, supervisorSystem, unreviewedEvals, wrapUpText,
} from './loop.ts'
import type { LoopState } from './loop.ts'
import { syncPreset } from './preset.ts'
import { CONTROL_PATH, MODELS_PATH, PRESET_ID, REPLAY_LINE_PREFIX, SERIES_PATH, samePath } from './wire.ts'
import type { WireControl, WireIteration, WireModels, WireSeries } from './wire.ts'

export const name = 'kernel-opt'
export const inject = ['tools', 'agents', 'sessions']

/** Plugin id stamped on plugin-sourced messages. */
const PLUGIN_ID = 'kernel-opt'

/** Delay between a logged turn end and the idle check that may continue. */
const SETTLE_DELAY_MS = 1200

/**
 * Plugin configuration. All fields optional; tool-name defaults cover any
 * evaluator named `kernel_evaluate` / `kernel_profile` / `run_finalize`.
 * Names match exactly or as a separator-delimited suffix, so MCP server
 * prefixes (e.g. `mcp__myeval__kernel_evaluate`) are covered without
 * configuration.
 */
export interface Config {
  /** Tool names treated as kernel evaluations (curve points). */
  benchTools?: string[]
  /** Tool names treated as profiler calls (▲ markers). */
  profileTools?: string[]
  /** Profiler executables recognised on a shell command line (▲ markers). */
  profileCommands?: string[]
  /** Tool names treated as finalize picks (★ marker via `evaluation_id`). */
  finalizeTools?: string[]
  /** Tool names treated as structured artifact changes (default `write`/`edit`). */
  changeTools?: string[]
  /**
   * Shell tools whose results are scanned for the `KERNEL_EVAL=`
   * contract trailer (self-reported channel; default `['bash']`).
   */
  shellTools?: string[]
  /** Kernel-loop tuning. */
  loop?: {
    /** Budget when `/kloop` is armed without a number (default 20). */
    defaultBudget?: number
    /** Consecutive zero-progress continuations tolerated (default 2). */
    maxNoProgressRounds?: number
    /**
     * Pace instruction carried by every drive: complete at most this many
     * evaluations per turn, then settle and report — it manufactures the
     * turn boundaries that give the supervisor periodic checkpoints and
     * keep the budget gate near-real-time even when a capable model could
     * finish the whole run in one turn (default 3; 0 disables).
     */
    evalsPerTurn?: number
    /**
     * Whether an early finalize is put to the supervisor before it ends the
     * run: with budget left, "finished" becomes a proposal the supervisor can
     * overrule by naming untried directions (default true; needs supervision
     * on — without a supervisor the agent's finalize stands as before).
     */
    challengeFinalize?: boolean
  }
  /**
   * 「算子优化模式」agent preset self-install. On by default: when the
   * deployment composes `agentPresets`, the bundled preset directory
   * (persona + the built-in evaluator under `evaluator/`) is synced into
   * the user preset root (`~/.dsh/.agent-presets/<id>/`) on boot: missing
   * files are seeded, files the plugin wrote and nobody edited are UPDATED
   * to the shipped version, and files the user changed are kept and named
   * in the log (see `syncPreset`). The
   * evaluation tab always shows for sessions composed from the DEFAULT id
   * — an overridden `id` keeps the preset but falls back to signal-based
   * tab detection.
   */
  preset?: {
    /** Master switch (default true). */
    install?: boolean
    /** Directory/preset id to install under (default `kernel-opt`). */
    id?: string
  }
  /**
   * Finalize replay: when `kernel_finalize` names an artifact whose best
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
    /**
     * Output budget per review (default 16000). Sized for THINKING, not for
     * the answer: the rubric asks for at most three sentences, but reviewers
     * run with the deployment's reasoning default and reasoning spends this
     * same budget — measured on this plugin, V4-Flash burned 4000 tokens of
     * reasoning on a 15-row digest and never answered. A cap raised alone
     * only moves that cliff, so an exhausted review retries without thinking.
     */
    maxTokens?: number
    /**
     * What language the review is written in — a name the model will
     * recognise (`中文`, `Chinese`, `日本語`, …). Unset, the reviewer follows
     * the language the agent states its own plans in, since the review is
     * read beside them.
     */
    language?: string
    /**
     * Extra house rules, appended to the rubric. For what THIS project counts
     * as a finding — a hardware quirk to watch, a metric that must appear, a
     * habit to call out. It is appended, never a replacement: the review
     * discipline is the plugin's and a config cannot delete it, the same way
     * an override picks the route and not the rubric.
     */
    instructions?: string
  }
}

/** Resolve the projection routing from plugin config over defaults. */
function resolveProjection(config: Config): ProjectionConfig {
  return {
    benchTools: config.benchTools ?? DEFAULT_PROJECTION.benchTools,
    profileTools: config.profileTools ?? DEFAULT_PROJECTION.profileTools,
    profileCommands: config.profileCommands ?? DEFAULT_PROJECTION.profileCommands,
    finalizeTools: config.finalizeTools ?? DEFAULT_PROJECTION.finalizeTools,
    changeTools: config.changeTools ?? DEFAULT_PROJECTION.changeTools,
    shellTools: config.shellTools ?? DEFAULT_PROJECTION.shellTools,
    planTool: DEFAULT_PROJECTION.planTool,
    envTool: DEFAULT_PROJECTION.envTool,
  }
}

/** Absolute path of the bundled preset directory (repo/package layout). */
function bundledPresetDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '../preset/kernel-opt')
}

/** Expand a leading `~/` the way the preset roots document it. */
function expandHome(path: string): string {
  return path.startsWith('~') ? join(homedir(), path.slice(1)) : path
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
 * Mount the plugin: model tools, kernel loop + supervisor commands, and the
 * per-session series route the browser panel polls.
 * @param ctx - plugin context.
 * @param config - optional routing/loop/supervisor overrides.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const projection = resolveProjection(config)
  const maxNoProgress = config.loop?.maxNoProgressRounds ?? 2
  const defaultBudget = config.loop?.defaultBudget ?? 20
  const evalsPerTurn = config.loop?.evalsPerTurn ?? 3
  const challengeFinalize = config.loop?.challengeFinalize ?? true
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

  /**
   * Disarm a session's loop by human decision (no wrap-up round), and abort
   * the in-flight turn: a human pressing stop means stop NOW, not "after the
   * model finishes what it is doing". Queued human messages survive the
   * cancel; an idle agent makes it a no-op.
   */
  const stopLoop = (sessionId: string): boolean => {
    const state = loops.get(sessionId)
    if (state === undefined || !state.armed) return false
    state.armed = false
    state.stopReason = 'stopped'
    ctx.agents.get(SessionId(sessionId))?.cancel({ kind: 'user' }, { keepInbox: true })
    return true
  }


  /**
   * The supervisor route reviews would use for a session: the session
   * override wins, plugin config is the fallback, absent means unconfigured.
   */
  const effectiveSupervisor = (
    state: LoopState | undefined,
  ): { provider: string; model: string; source: 'session' | 'config' } | undefined => {
    if (state?.supervisorOverride !== undefined) return { ...state.supervisorOverride, source: 'session' }
    if (config.supervisor !== undefined) {
      return { provider: config.supervisor.provider, model: config.supervisor.model, source: 'config' }
    }
    return undefined
  }

  /** Toggle supervision; returns an error string when the gate fails. */
  const setSupervise = (sessionId: string, enabled: boolean): string | null => {
    const state = stateFor(sessionId)
    if (enabled && effectiveSupervisor(state) === undefined) {
      return 'No supervisor model configured. Pick one (/supervise use <provider>/<model>, or the panel picker), '
        + 'or add to the kernel-opt plugin config: supervisor: { provider: <route>, model: <id> } — '
        + 'a distinct route/model from the primary.'
    }
    state.supervise = enabled
    return null
  }

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
        description: 'Where evaluations execute, e.g. "本机 (macOS)" / "kernel-box via rt" / "Modal B200 容器".',
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
    }, 'kernel-opt: loop timers')

    /**
     * One supervisor review; any failure degrades to unreviewed/no advice.
     * `mode` picks the question: `round` audits loop discipline mid-run,
     * `closing` audits the finished table, `headroom` decides whether an
     * early finalize stands (its own rubric, since "looks fine" must not end
     * a run with budget left).
     */
    const review = async (
      state: LoopState,
      series: WireSeries,
      mode: 'round' | 'closing' | 'headroom' = 'round',
    ): Promise<{ advice: string | null; note: string | null; reviewed: boolean }> => {
      const supervisor = effectiveSupervisor(state)
      if (supervisor === undefined || !state.supervise) return { advice: null, note: null, reviewed: false }
      // Degrading silently is what hid the empty-answer bug for four
      // sessions: every reviewer failure looked identical to a clean
      // approval. Console, not `ctx.logger`, because the operator reads the
      // server log the host was started with, and that is where this belongs.
      const warn = (message: string): void => {
        console.warn(`[kernel-opt] supervisor: ${message}`)
      }
      try {
        const base = supervisorDigest(series, state, 10, evalsPerTurn)
        const digest = mode === 'closing'
          ? `${base}\nThe run has finalized — this is the closing audit: judge the final `
            + 'table and its provenance (the finalize and its replay above all); continuation advice is moot.'
          : mode === 'headroom'
            ? `${base}\nThe agent has just declared the run FINISHED with `
              + `${String(state.budget - completedEvals(series))} evaluations of budget still unspent. `
              + 'Decide whether that ending stands.'
            : base
        /** One review call; `thinking` false spends the budget on the answer. */
        const ask = async (thinking: boolean): Promise<{ reply: string; finish?: string }> => {
          let reply = ''
          let finish: string | undefined
          const stream = lctx.llm.stream({
            provider: supervisor.provider,
            model: supervisor.model,
            system: supervisorSystem(
              mode === 'headroom' ? HEADROOM_SYSTEM : SUPERVISOR_SYSTEM,
              {
                ...(config.supervisor?.language !== undefined ? { language: config.supervisor.language } : {}),
                ...(config.supervisor?.instructions !== undefined ? { instructions: config.supervisor.instructions } : {}),
              },
            ),
            messages: [createUserMessage({
              content: [{ type: 'text', text: digest }],
              source: { kind: 'plugin', plugin: PLUGIN_ID },
            })],
            // Sampling knobs stay config-owned: an override picks the route,
            // not the review discipline.
            ...(config.supervisor?.temperature !== undefined ? { temperature: config.supervisor.temperature } : {}),
            ...(thinking ? {} : { reasoningEffort: ReasoningEffortId('off') }),
            maxTokens: config.supervisor?.maxTokens ?? 16_000,
            signal: AbortSignal.timeout(thinking ? 120_000 : 45_000),
          })
          for await (const chunk of stream) {
            if (chunk.type === 'text-delta') reply += chunk.text
            else if (chunk.type === 'finish') finish = chunk.reason.kind
          }
          return { reply, ...(finish !== undefined ? { finish } : {}) }
        }
        let { reply, finish } = await ask(true)
        if (reply.trim().length === 0 && finish === 'max-tokens') {
          // Reasoning spends the same output budget as the answer, so a
          // reviewer can think until the cap and never speak — measured at
          // 4000 tokens on a 15-row digest. Raising the cap alone only moves
          // the cliff, so the retry drops thinking instead: a shallower
          // review beats none, and none used to read as approval.
          warn(`${supervisor.provider}/${supervisor.model} spent its whole budget thinking; `
            + 'retrying the review without reasoning')
          ;({ reply, finish } = await ask(false))
        }
        if (reply.trim().length === 0) {
          // Silence is NOT approval: an empty reply used to reach the human
          // as "reviewed, no findings", including as the supervisor's
          // blessing on an early finalize.
          warn(`${supervisor.provider}/${supervisor.model} produced no answer `
            + `(finish: ${finish ?? 'unknown'}); the review is recorded as not run`)
          return { advice: null, note: null, reviewed: false }
        }
        return { ...adviceFromReply(reply), reviewed: true }
      } catch (error) {
        // A broken or slow reviewer must never stall the primary loop.
        warn(`${supervisor.provider}/${supervisor.model} failed: ${String(error)}`)
        return { advice: null, note: null, reviewed: false }
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
        // The agent finalized. Who gets to end the run depends on whether
        // budget is left: with supervision on and budget unspent, the
        // supervisor is asked whether the ending stands (user ruling
        // 2026-08-14 — an agent calling "good enough" at 6/20 wastes the
        // budget the human set). Headroom found → the finalize is overruled
        // and the run continues; DONE → it stands, and the same call doubles
        // as the closing audit.
        const budgetLeft = state.budget - decision.evalsDone
        const lastFinalizeSeq = series.iterations
          .filter(p => p.finalized === true)
          .reduce((seq, p) => Math.max(seq, p.seq), -1)
        const challengeable = challengeFinalize && state.supervise && budgetLeft > 0
          && lastFinalizeSeq > (state.challengedFinalizeSeq ?? -1)
        if (challengeable || (state.supervise && unreviewedEvals(series))) {
          const { advice, note, reviewed } = await review(state, series, challengeable ? 'headroom' : 'closing')
          state.lastAdvice = advice ?? state.lastAdvice
          // Re-check after the (possibly slow) review: a human message or a
          // stop that arrived meanwhile owns the session.
          if (!state.armed || lctx.agents.get(SessionId(sessionId)) !== agent || agent.status !== 'idle') return
          if (challengeable && advice !== null) {
            // Overruled: stay armed, spend a round, hand the agent the
            // untried directions. Recording the challenged finalize keeps the
            // next checkpoint from re-deciding on the same one.
            state.challengedFinalizeSeq = lastFinalizeSeq
            state.round += 1
            state.lastEvalCount = decision.evalsDone
            agent.followup(createUserMessage({
              content: [{
                type: 'text',
                text: challengeText(state.round, decision.evalsDone, state.budget, advice, finalizeHint, evalsPerTurn),
              }],
              source: { kind: 'plugin', plugin: PLUGIN_ID },
            }))
            return
          }
          // The ending stands. Only a review that actually answered may be
          // reported as convergence: an unanswered challenge leaves the
          // agent's own finalize as the reason, never the supervisor's.
          state.armed = false
          state.stopReason = challengeable && reviewed ? 'converged' : decision.reason
          if (reviewed) {
            agent.followup(createUserMessage({
              content: [{ type: 'text', text: finalAuditText(advice, note) }],
              source: { kind: 'plugin', plugin: PLUGIN_ID },
            }))
          }
          return
        }
        state.armed = false
        state.stopReason = decision.reason
        return
      }
      if (decision.action === 'wrap-up') {
        // Budget/stall endings finish clean: one closing message asking the
        // model to finalize its best honest result. The supervisor reviews
        // this drive like any continuation — the finalize is exactly where a
        // provenance audit pays, and a run finished in a single turn has no
        // other checkpoint where the supervisor could speak.
        const { advice, note, reviewed } = reviewable(series)
          ? await review(state, series)
          : { advice: null, note: null, reviewed: false }
        state.lastAdvice = advice ?? state.lastAdvice
        // Re-check after the (possibly slow) review; a human message or stop
        // that arrived meanwhile owns the session, and the next settle will
        // re-decide the wrap-up from fresh state.
        if (!state.armed || lctx.agents.get(SessionId(sessionId)) !== agent || agent.status !== 'idle') return
        state.armed = false
        state.stopReason = decision.reason
        agent.followup(createUserMessage({
          content: [{
            type: 'text',
            text: wrapUpText(decision.evalsDone, state.budget, decision.reason, finalizeHint,
              advice, reviewed && advice === null, note),
          }],
          source: { kind: 'plugin', plugin: PLUGIN_ID },
        }))
        return
      }
      state.noProgressRounds = state.round > 0 && decision.evalsDone <= state.lastEvalCount
        ? state.noProgressRounds + 1
        : 0
      state.round += 1
      state.lastEvalCount = decision.evalsDone
      // Review only when the digest carries signal: a fresh arm over an empty
      // session has nothing to audit, so no supervisor call and no OK record.
      const { advice, note, reviewed } = reviewable(series)
        ? await review(state, series)
        : { advice: null, note: null, reviewed: false }
      state.lastAdvice = advice ?? state.lastAdvice
      // Re-check idleness and armed state after the (possibly slow) review; a
      // human message or stop that arrived meanwhile owns the session.
      if (!state.armed || lctx.agents.get(SessionId(sessionId)) !== agent || agent.status !== 'idle') return
      // A session with a human prompt, an evaluation, or a plan report has a
      // task in flight; otherwise the continuation redirects the model to a
      // workspace inventory (the user may have staged the task as files)
      // instead of "continue" over nothing.
      const taskKnown = series.iterations.length > 0 || series.plans.length > 0
        || hasUserTask(session.events)
      agent.followup(createUserMessage({
        content: [{
          type: 'text',
          text: continuationText(
            state.round, decision.evalsDone, state.budget, advice,
            reviewed && advice === null, stagnationCount(series), finalizeHint, taskKnown,
            series.plans.length > 0, evalsPerTurn, note, planStale(series, evalsPerTurn),
            series.envs.length > 0,
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
      // A re-arm re-opens the question: an earlier run's finalize may be
      // challenged again under the new budget.
      delete state.challengedFinalizeSeq
      scheduleCheckpoint(sessionId, 10)
    }
    bridge.arm = armLoop
    lctx.effect(() => () => {
      delete bridge.arm
    }, 'kernel-opt: loop bridge')

    // The loop trigger is the logged turn boundary — the same surface the
    // projection reads, so a continuation can never race its own data.
    lctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      const state = loops.get(session.id)
      if (state === undefined || !state.armed) return
      // A cancelled turn is a stop order (human stop button, host teardown):
      // the loop disarms instead of re-driving over it. Re-arm to resume.
      if (event.data.reason.kind === 'aborted') {
        state.armed = false
        state.stopReason = 'stopped'
        return
      }
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
      description: 'Second-model supervisor: /supervise on|off toggles review at kernel-loop continuation '
        + 'points; /supervise use <provider>/<model> overrides the supervisor route for this session '
        + '("use default" follows the plugin config again).',
      input: { hint: 'on | off | use <provider>/<model> | status' },
      handler: (invocation) => {
        const raw = invocation.rawInput.trim()
        const state = stateFor(invocation.agent.id)
        if (raw === 'on') {
          const error = setSupervise(invocation.agent.id, true)
          if (error !== null) return { kind: 'error', text: error }
          const supervisor = effectiveSupervisor(state)
          return {
            kind: 'success',
            text: `Supervisor on${supervisor !== undefined ? ` (${supervisor.provider}/${supervisor.model}, ${supervisor.source})` : ''}; reviews run at kernel-loop continuation points.`,
          }
        }
        if (raw === 'off') {
          setSupervise(invocation.agent.id, false)
          return { kind: 'success', text: 'Supervisor off.' }
        }
        if (raw.startsWith('use ') || raw === 'use') {
          const spec = raw.slice(3).trim()
          if (spec === 'default' || spec === '') {
            delete state.supervisorOverride
            const fallback = effectiveSupervisor(state)
            return {
              kind: 'success',
              text: fallback !== undefined
                ? `Supervisor override cleared; following config: ${fallback.provider}/${fallback.model}.`
                : 'Supervisor override cleared; nothing configured — /supervise use <provider>/<model> to pick one.',
            }
          }
          // First slash splits: provider routes carry no slash, model ids may.
          const slash = spec.indexOf('/')
          if (slash <= 0 || slash === spec.length - 1) {
            return { kind: 'error', text: 'Usage: /supervise use <provider>/<model> (or `use default` to follow config).' }
          }
          state.supervisorOverride = { provider: spec.slice(0, slash), model: spec.slice(slash + 1) }
          return {
            kind: 'success',
            text: `Supervisor model for this session: ${spec}.${state.supervise ? '' : ' Enable with /supervise on.'}`,
          }
        }
        const effective = effectiveSupervisor(state)
        return {
          kind: 'success',
          text: `supervisor ${state.supervise ? 'on' : 'off'}; ${effective !== undefined ? `route: ${effective.provider}/${effective.model} (${effective.source})` : 'not configured'}.`,
        }
      },
    })
  })

  // Agent-preset self-install: composing this plugin makes an「算子优化模式」
  // preset appear in the picker, and keeps that copy in step with the plugin
  // it came from — see syncPreset. Host discovery is unmemoized, so it shows
  // up without a restart. Best-effort: any failure leaves the plugin fully
  // functional.
  ctx.inject(['agentPresets'], (pctx) => {
    if (config.preset?.install === false) return
    const id = config.preset?.id ?? PRESET_ID
    void (async () => {
      try {
        const userRoot = pctx.agentPresets.roots.find(root => root.trust === 'user')
        if (userRoot === undefined) return
        const source = bundledPresetDir()
        if (!existsSync(join(source, 'agent.cordis.yml'))) return
        const target = join(expandHome(userRoot.path), id)
        for (const line of await syncPreset(source, target)) console.warn(`[kernel-opt] ${line}`)
      } catch {
        // Preset install is a convenience; the plugin works without it.
      }
    })()
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
          defaultBudget,
          ...(state?.stopReason !== undefined ? { stopReason: state.stopReason } : {}),
        },
        supervisor: {
          enabled: state?.supervise ?? false,
          configured: effectiveSupervisor(state) !== undefined,
          ...(config.supervisor !== undefined
            ? { configRoute: { provider: config.supervisor.provider, model: config.supervisor.model } }
            : {}),
          ...((): { effective?: WireControl['supervisor']['effective'] } => {
            const effective = effectiveSupervisor(state)
            return effective !== undefined ? { effective } : {}
          })(),
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
    }), 'kernel-opt: series route')

    wctx.effect(() => wctx.webServer.register({
      kind: 'exact',
      path: CONTROL_PATH,
      handler: (req, res) => {
        const respond = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        }
        // GET: fresh control state without acting — the lightweight poll for
        // the chat-side loop button and armed strip.
        if (req.method === 'GET') {
          try {
            const url = new URL(req.url ?? '/', 'http://dsh.internal')
            const rawId = url.searchParams.get('sessionId') ?? ''
            const session = rawId === '' ? undefined : wctx.sessions.get(SessionId(rawId))
            if (session === undefined) {
              respond(rawId === '' ? 400 : 404, { error: rawId === '' ? 'sessionId query parameter required' : 'unknown session' })
              return
            }
            const series = project(rawId, session.events, projection)
            respond(200, { control: buildControl(rawId, series) })
          } catch (error) {
            respond(500, { error: error instanceof Error ? error.message : String(error) })
          }
          return
        }
        if (req.method !== 'POST') {
          respond(405, { error: 'GET or POST only' })
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
            } else if (action === 'supervise-use') {
              const state = stateFor(sessionId)
              const provider = typeof body['provider'] === 'string' ? body['provider'].trim() : ''
              const model = typeof body['model'] === 'string' ? body['model'].trim() : ''
              if (provider === '' && model === '') {
                // Both empty = follow config again.
                delete state.supervisorOverride
              } else if (provider === '' || model === '') {
                respond(400, { error: 'provider and model must both be given (or both empty to follow config)' })
                return
              } else {
                state.supervisorOverride = { provider, model }
              }
            } else {
              respond(400, { error: `unknown action: ${action}` })
              return
            }
            const series = project(sessionId, session.events, projection)
            const control = buildControl(sessionId, series)
            if (error !== null) {
              respond(409, { error, control })
              return
            }
            respond(200, { control })
          } catch (err) {
            respond(500, { error: err instanceof Error ? err.message : String(err) })
          }
        })()
      },
    }), 'kernel-opt: control route')
  })

  // Models route — the panel's supervisor picker. Read-only enumeration of
  // provider routes and their models; a provider whose discovery fails still
  // appears with an empty model list (its route is selectable by hand).
  ctx.inject(['webServer', 'llm'], (mctx) => {
    mctx.effect(() => mctx.webServer.register({
      kind: 'exact',
      path: MODELS_PATH,
      handler: (req, res) => {
        const respond = (status: number, payload: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(payload))
        }
        if (req.method !== undefined && req.method !== 'GET') {
          respond(405, { error: 'GET only' })
          return
        }
        void (async () => {
          try {
            const catalog: WireModels = { providers: [] }
            for (const provider of mctx.llm.listProviders().slice(0, 20)) {
              let models: { id: string; name: string }[] = []
              try {
                models = (await mctx.llm.listModels(provider.id))
                  .slice(0, 50)
                  .map(model => ({ id: model.id, name: model.name }))
              } catch {
                // Discovery-less providers stay listed, model field free-form.
              }
              catalog.providers.push({ id: provider.id, name: provider.name, models })
            }
            respond(200, catalog)
          } catch (error) {
            respond(500, { error: error instanceof Error ? error.message : String(error) })
          }
        })()
      },
    }), 'kernel-opt: models route')
  })
}
