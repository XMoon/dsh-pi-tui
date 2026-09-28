/**
 * @xmoon76/dsh-pi-tui — the bundle's runner plugin. Waits for the startup
 * service (the parsed `dsh --profile pi-tui` flags) and Loader settlement,
 * creates or resumes an Agent through the core registry, renders its session
 * log into the TUI transcript, and routes editor submissions back through
 * `agent.followup`. Streaming arrives through the `session/event` firehose;
 * a persistent `TranscriptFolder` folds appended events incrementally and a
 * coalesced repaint flushes the windowed transcript (older turns collapse
 * into a summary), so long sessions never re-scan the whole log per event.
 *
 * This entry is the package FACADE (plan §28): it declares the Cordis row
 * (`name` / `inject` / `Config`), re-exports the public root surface, and
 * `apply()` delegates the application composition to `src/app/bootstrap.ts`.
 *
 * KEYS ARE NOT HARD-CODED IN THE RUNNER: host shortcuts are semantic actions (app.*)
 * resolved through the user-orchestrable keymap; the single source of truth
 * for default keys is src/keybindings/definitions.ts and the effective map
 * is inspectable at runtime with `/keybindings`. User-FACING strings derive
 * key labels through the keymap's keyHint(); key
 * names in comments are shorthand for the default binding and must never be
 * relied on as the live binding.
 * @module @xmoon76/dsh-pi-tui
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { TUI_STARTUP_SERVICE } from './startup.ts'
import { type ProgressUpdatesState, type ResponseStyleState } from './communication-policy.ts'
import { type DisplayState } from './display-preset.ts'

import { type Diag } from './diag.ts'
import {
  resolveInitialCatalog as resolveInitialCatalogImpl,
  type InitialCatalogResolution,
  type SurfaceCatalogContext,
} from './surface-catalog.ts'
import { applyRunner } from './app/bootstrap.ts'
import { composeDirectAgent, recordedDirectPreset } from './app/direct/composition.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the TUI can mount. */
export const inject = ['agentDefaultModel', 'agents', 'sessions', TUI_STARTUP_SERVICE]

import type { Config } from './tui-config.ts'
export { Config } from './tui-config.ts'

// Relocated root helpers (A5-1/A5-1b, plan §27): every helper implementation
// lives in its natural top-level module; the package-root exports are preserved
// here unchanged.
export { SESSIONLESS_COMMANDS, LOCAL_COMMANDS, commandRejectsImages, HOST_COMMAND_CATALOG, isLocalCommandLine, isBareCommandLine, commandIsLocalForAttachments, resolveSubmitDelivery, normalizeSkillInvocation, shouldConsumeAdvertisedMiss, isPlainExitPrompt, dangerCommand } from './command-policy.ts'
export { interruptAgent, type InterruptWriteOutcome, type InterruptAgentLike, type InterruptWriterLike } from './interrupt.ts'
export { createViewerOpenToken, teardownViewerForSessionSwap, viewerActionCapability, matchPendingSubagentCall, type PendingSubagentCall, type ViewerOpenToken } from './subagent-viewer.ts'
export type { InitialCatalogResolution } from './surface-catalog.ts'

/**
 * Options for {@link resolveInitialCatalog}.
 *
 * The public declaration stays here (A5a review P1): `liveAgent` keeps the Host
 * `Agent` type it has always had, so consumers that READ the property keep
 * compiling. The implementation consumes the structural
 * `SurfaceCatalogResolutionOptions` in `surface-catalog.ts`.
 */
export interface ResolveInitialCatalogOptions {
  /** The resumed live agent, if any (prefetch path). */
  readonly liveAgent?: Agent
  /** The effective preset id for the cold standing read (undefined = the
   * deployment default; only consulted for the deferred start). */
  readonly presetId?: string
  readonly signal: AbortSignal
  /** The context surface the collectors read services from. */
  readonly ctx: SurfaceCatalogContext
  readonly diag: Diag
  /** Suspend the pre-mount startup status before an ordinary log write
   * (the status owns the current terminal line; a TTY shares one cursor
   * between stdout and stderr). Called right before every diag.warn this
   * function may emit. */
  readonly onLog?: () => void
}

/**
 * The pre-mount surface catalog resolution (plan §27): the published entry for
 * {@link ResolveInitialCatalogOptions}. An explicit `--session` start
 * prefetches the resumed agent's effective catalog; the deferred start reads the
 * cold HUMAN SKILL catalog through the preset's STANDING SCOPE — no Agent, no
 * session, no turn — so the first input sees human-invocable skills without any
 * durable side effect. The implementation and its failure taxonomy live in
 * `surface-catalog.ts`.
 * @param options - injected dependencies (see {@link ResolveInitialCatalogOptions}).
 * @returns the snapshot / skill catalog to install and an optional notice.
 */
export async function resolveInitialCatalog(options: ResolveInitialCatalogOptions): Promise<InitialCatalogResolution> {
  return resolveInitialCatalogImpl(options)
}

export { subagentJobTranscriptId, taskRowSelectionDisposition, subagentJobViewHint } from './task-presentation.ts'
export { foldQueueRows, type QueueFoldResult, type QueueInboxMessage } from './pending-presentation.ts'
export { compactingFromLog } from './compaction-presentation.ts'

export { runningProfile, hostRunningProfile, resumeCommand, type ProfileContextReadLike } from './dsh-profile.ts'

// A4-7: the compaction/context presentation folds live in the top-level
// compaction-presentation module (plan §16/§27) and are consumed by the
// surface routing; the root entry point re-exports them unchanged so the
// published package surface stays byte-compatible.
export {
  foldCompactionEvent,
  settleCompactionSurface,
  busyAfterTurnBoundary,
  contextRefreshKind,
} from './compaction-presentation.ts'
export type { CompactionFold, CompactionSettleSurface } from './compaction-presentation.ts'


/** One agent's preset composition: the id to record and the setup that installs it. */
export interface AgentComposition {
  /** Preset id for the session header, absent when the deployment composes no roster. */
  agentPreset?: string
  /** Agent-factory setup: model selection, then the preset mount when composed. */
  setup: (agentCtx: Context, agent: Agent) => Promise<void> | void
}

/**
 * Source-compatible composition returned for standalone callers that provide
 * their own ModelSelectionRef instead of an Agent-local installer.
 */
interface LegacyAgentComposition {
  /** Preset id for the session header, absent when the deployment composes no roster. */
  agentPreset?: string
  /** Standalone setup installs the caller-owned model selection ref. */
  setup: (agentCtx: Context) => Promise<void> | void
}

/**
 * Resolve the preset an agent will be composed from, and the setup that
 * installs it.
 *
 * The id is resolved BEFORE the session exists because the session boundary
 * snapshots `meta` before asynchronous setup begins — a preset discovered
 * during setup could never reach the header. Mounting still happens in setup,
 * where a failure rolls the whole creation back rather than leaving a
 * published session whose capabilities are half-installed.
 *
 * A deployment with no roster composes nothing and every session shares the
 * host composition, which is the behavior before presets existed.
 * @param ctx - the runner context (services read through `ctx.get`).
 * @param installSelection - installs a fresh Agent-local model selection ref
 *   during setup using the explicit Agent identity supplied by DSH. A
 *   ModelSelectionRef is also accepted for source compatibility with
 *   standalone composition callers; that branch installs the caller-owned ref
 *   and does not require an Agent.
 * @param presetId - the requested preset, or `undefined` for the default.
 * @param displayState - the shared canonical DisplayState. When provided, the
 *   setup also installs the dynamic Focus system-prompt
 *   section exactly once per composed agent (plan §9 — every composed
 *   root TUI agent gets it; /focus toggles never re-register).
 * @param diag - the diagnostics channel, when the caller has one.
 * @param progressUpdatesState - optional live mid-turn update cadence. The
 *   effective text is derived from this state AND `displayState` (Focus
 *   suppresses the progress section without mutating this state), so a
 *   progress state without a display state is not installable.
 * @param responseStyleState - optional live visible-answer style guidance,
 *   independent of display.
 * @returns the id to record on the header (absent without a roster) and the setup callback.
 * @throws when the roster supplies no such preset.
 */
export function composeAgent(
  ctx: Context,
  installSelection: ModelSelectionRef,
  presetId?: string,
  displayState?: DisplayState,
  diag?: Diag,
  progressUpdatesState?: ProgressUpdatesState,
  responseStyleState?: ResponseStyleState,
): Promise<LegacyAgentComposition>
export function composeAgent(
  ctx: Context,
  installSelection: (agentCtx: Context, agent: Agent) => void,
  presetId?: string,
  displayState?: DisplayState,
  diag?: Diag,
  progressUpdatesState?: ProgressUpdatesState,
  responseStyleState?: ResponseStyleState,
): Promise<AgentComposition>
export async function composeAgent(
  ctx: Context,
  installSelection: ModelSelectionRef | ((agentCtx: Context, agent: Agent) => void),
  presetId?: string,
  displayState?: DisplayState,
  diag?: Diag,
  progressUpdatesState?: ProgressUpdatesState,
  responseStyleState?: ResponseStyleState,
): Promise<LegacyAgentComposition | AgentComposition> {
  // The Direct-only body lives in app/direct (plan §27); the entry keeps the
  // public overloads above and delegates the composition here.
  return composeDirectAgent(ctx, installSelection, presetId, displayState, diag, progressUpdatesState, responseStyleState)
}

/**
 * The preset a persisted session actually runs, read from the DSH 0.1.6 V3
 * session projection (header initialization plus the latest selection event).
 * @param ctx - the runner context.
 * @param sessionId - the persisted session id.
 * @returns the recorded preset id, or undefined to compose the default.
 */
export async function recordedPreset(ctx: Context, sessionId: string): Promise<string | undefined> {
  return recordedDirectPreset(ctx, sessionId)
}


/**
 * Mount the TUI: resolve the model selection, create or resume the agent,
 * wire the surface to the agent, and subscribe to the session firehose.
 * @param ctx - plugin context carrying core services.
 * @param config - validated config with the optional resumed session id.
 */
export function apply(ctx: Context, config: Config): void {
  applyRunner(ctx, config)
}
