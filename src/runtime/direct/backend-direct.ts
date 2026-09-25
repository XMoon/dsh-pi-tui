/**
 * The Direct backend assembly (Pre-M3 PR1): the ONE place that constructs the
 * in-process `ctx.*` adapters for a `Backend`. The runner supplies the
 * Direct-only dependency resolvers (live-Agent lookup, preset composition,
 * Session accessors) and receives the semantic `Backend`; it no longer
 * constructs the Direct semantic adapters one by one, so a port can never be
 * served by a runner-local side channel that bypasses the backend vocabulary.
 *
 * This module owns assembly ONLY: no UI, transition, draft, panel or command
 * routing lives here, and it resolves no Host service itself.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/backend-direct
 */

import type { Diag } from '../../diag.ts'
import type { Backend } from '../backend.ts'
import { createDirectBackend } from '../backend.ts'
import type { TuiSettingsConfig } from '../config-port.ts'
import type { CompositionLike, DirectOwnerPoolLike } from './session-lifecycle-direct.ts'
import type { DirectSessionLiveResolvers } from './session-direct.ts'
import type { LiveAgentLike } from './session-writer-direct.ts'
import type { DirectPendingAgentLike } from './pending-input-reader-direct.ts'
import type { SessionModelSelectionOwnerLike } from './model-selection-direct.ts'
import { DirectSubagentPort } from './subagent-direct.ts'
import { DirectSessionReader } from './session-direct.ts'
import { DirectPendingInputReader } from './pending-input-reader-direct.ts'
import { DirectSessionWriter } from './session-writer-direct.ts'
import { DirectSessionLifecycle } from './session-lifecycle-direct.ts'
import { DirectInteractionPort } from './interaction-direct.ts'
import { DirectCatalogPort } from './catalog-direct.ts'
import { DirectConfigPort } from './config-direct.ts'
import { DirectHostFilePort } from './host-file-direct.ts'
import { DirectSessionArchive } from './session-archive-direct.ts'
import { DirectHostCommandPort } from './host-command-direct.ts'
import { DirectPluginManagerPort } from './plugin-manager-direct.ts'
import { DirectJobObservationPort } from './job-observation-direct.ts'

/** The minimal Host context surface the Direct adapters need (structural;
 * the services resolve from the running dsh installation). */
export interface DirectBackendContextLike {
  get(name: string): unknown
  on(event: string, listener: unknown): () => void
}

/** The live-Agent surface the Direct assembly hands to its adapters: the
 * runner's resolver satisfies every adapter's narrower structural need. */
export type DirectLiveAgentLike = LiveAgentLike & DirectPendingAgentLike

/** The Direct-only dependency resolvers the runner supplies to the assembly. */
export interface DirectBackendDeps {
  readonly ctx: DirectBackendContextLike
  readonly diag: Diag
  /** The persisted TUI-settings facade (absent without the Settings service). */
  readonly tuiSettings: TuiSettingsConfig | undefined
  /** The per-Agent model-selection owner (shared with the runner's picker). */
  readonly modelSelections: SessionModelSelectionOwnerLike
  /** The Direct Session ownership pool (lifecycle retirement/claim). */
  readonly ownerPool: DirectOwnerPoolLike
  /** Resolve one preset composition (the runner's compose). */
  readonly compose: (presetId?: string) => Promise<CompositionLike>
  /** The exact live Agent of one Session, or undefined when not mounted. */
  readonly agentFor: (sessionId: string) => DirectLiveAgentLike | undefined
  /** The live Agent plus the interactive continuable child currently viewed. */
  readonly queueAgentFor: (sessionId: string) => DirectLiveAgentLike | undefined
  /** The Host Session/Agent accessors the Direct session reader projects. */
  readonly liveResolvers: DirectSessionLiveResolvers
}

/** Assemble the complete Direct `Backend` from the runner's resolvers. */
export function createDirectRuntimeBackend(deps: DirectBackendDeps): Backend {
  return createDirectBackend(
    new DirectSubagentPort(deps.ctx),
    new DirectSessionReader(deps.ctx, deps.liveResolvers),
    new DirectPendingInputReader(deps.queueAgentFor),
    new DirectSessionWriter(deps.ctx, deps.agentFor, deps.queueAgentFor),
    new DirectSessionLifecycle(deps.ctx, deps.compose, deps.ownerPool),
    new DirectInteractionPort(deps.ctx, deps.agentFor),
    new DirectCatalogPort(deps.ctx, deps.agentFor, deps.modelSelections, deps.diag),
    new DirectConfigPort(deps.ctx, deps.tuiSettings, deps.agentFor),
    new DirectHostFilePort(deps.agentFor),
    new DirectSessionArchive(deps.ctx),
    new DirectHostCommandPort(deps.ctx, deps.agentFor),
    new DirectPluginManagerPort(deps.ctx),
    new DirectJobObservationPort(deps.ctx, deps.diag),
  )
}
