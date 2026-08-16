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

/** The subset of plugin config the agent-plane tool rows need. */
export interface RuntimeSettings {
  projection: ProjectionConfig
  replay: ReplaySettings
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

  constructor(ctx: Context, settings: RuntimeSettings) {
    super(ctx, RUNTIME_SERVICE)
    this.projection = settings.projection
    this.replay = settings.replay
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
