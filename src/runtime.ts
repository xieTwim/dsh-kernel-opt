/**
 * The profile-plane half's resolved configuration, published as a Cordis
 * service.
 *
 * The model-facing tools moved to the AGENT plane (they belong to the
 * 「算子优化模式」 preset, not to every session in the deployment), but their
 * behaviour is still governed by the ONE plugin config block the README
 * documents — `shellTools`, `jobTools`, `replay`, and the rest. Handing that
 * across as a service is what keeps it one config surface: a preset row that
 * had to restate `benchTools` would be a second place to forget.
 *
 * Consuming direction only. A preset row must never PUBLISH a service into
 * the process-global realm (`agentPresets`' mount invariant refuses it); it
 * may read what the host composition provides, and this is provided by the
 * profile-plane plugin.
 *
 * @module @xietwim/dsh-kernel-opt/runtime
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_PROJECTION } from './projection.ts'
import type { ProjectionConfig } from './projection.ts'
import type { LoopState } from './loop.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    kernelOptRuntime: KernelOptRuntime
  }
}

/** Service name, shared by the provider and the two agent-plane rows. */
export const RUNTIME_SERVICE = 'kernelOptRuntime'

/** Finalize-replay settings, resolved over their defaults. */
export interface ReplaySettings {
  /** Whether `kernel_finalize` re-executes the recorded bench command. */
  enabled: boolean
  /** Kill the replayed command after this many milliseconds. */
  timeoutMs: number
}

/** Which supervisor route a session would review with, and where it came from. */
export interface SupervisorRoute {
  provider: string
  model: string
  source: 'session' | 'config'
}

/** What `/kloop status` and the panel's control block both report. */
export interface LoopStatus {
  armed: boolean
  round: number
  budget: number
  supervise: boolean
  stopReason?: LoopState['stopReason']
  supervisor?: SupervisorRoute
}

/**
 * The loop's operations, as the ONE face both drivers use: the panel's
 * `/control` route (profile plane) and the `/kloop` / `/supervise` commands
 * (agent plane). Neither owns the state — it lives with the loop machinery in
 * the plugin's `apply`, and both reach it through here.
 */
export interface LoopOps {
  /** Budget used when `/kloop` is armed without a number. */
  readonly defaultBudget: number
  /**
   * Arm (or re-arm) a session's loop. Absent while the machinery that would
   * drive it is not composed (`llm`), which is what lets both drivers refuse
   * with the same reason instead of arming a loop nothing advances.
   */
  arm?: (sessionId: string, budget: number) => void
  /** Disarm by human decision, cancelling the in-flight turn; false if not armed. */
  stop: (sessionId: string) => boolean
  /** Toggle supervision; returns an error string when no supervisor is configured. */
  setSupervise: (sessionId: string, enabled: boolean) => string | null
  /** Override this session's supervisor route; `undefined` follows plugin config again. */
  setSupervisorRoute: (sessionId: string, route: { provider: string; model: string } | undefined) => void
  /** Current loop/supervisor state for a session (never creates one). */
  status: (sessionId: string) => LoopStatus
}

/** The subset of plugin config the agent-plane tool rows need. */
export interface RuntimeSettings {
  projection: ProjectionConfig
  replay: ReplaySettings
  loop: LoopOps
}

/**
 * Resolved plugin configuration, readable from the agent plane.
 *
 * Registered on construction and removed with the owning fiber, so a
 * disabled or hot-reloaded plugin takes its tools with it: the preset rows
 * inject this service and simply do not mount without it.
 */
export class KernelOptRuntime extends Service {
  readonly projection: ProjectionConfig
  readonly replay: ReplaySettings
  readonly loop: LoopOps

  constructor(ctx: Context, settings: RuntimeSettings) {
    super(ctx, RUNTIME_SERVICE)
    this.projection = settings.projection
    this.replay = settings.replay
    this.loop = settings.loop
  }
}

/**
 * Resolve projection routing from plugin config over defaults.
 * @param config - the plugin's projection-related keys (all optional).
 * @returns a complete routing table.
 */
export function resolveProjection(config: {
  benchTools?: string[]
  profileTools?: string[]
  profileCommands?: string[]
  finalizeTools?: string[]
  changeTools?: string[]
  shellTools?: string[]
  jobTools?: string[]
}): ProjectionConfig {
  return {
    benchTools: config.benchTools ?? DEFAULT_PROJECTION.benchTools,
    profileTools: config.profileTools ?? DEFAULT_PROJECTION.profileTools,
    profileCommands: config.profileCommands ?? DEFAULT_PROJECTION.profileCommands,
    finalizeTools: config.finalizeTools ?? DEFAULT_PROJECTION.finalizeTools,
    changeTools: config.changeTools ?? DEFAULT_PROJECTION.changeTools,
    shellTools: config.shellTools ?? DEFAULT_PROJECTION.shellTools,
    jobTools: config.jobTools ?? DEFAULT_PROJECTION.jobTools,
    planTool: DEFAULT_PROJECTION.planTool,
    envTool: DEFAULT_PROJECTION.envTool,
  }
}
