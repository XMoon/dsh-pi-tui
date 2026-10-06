/**
 * The application composition root's session startup/resume/create
 * orchestration helpers (TS2 §13).
 *
 * These reads/compositions are composition policy, not owner state: the module
 * composes the existing SessionOwnershipCore / SessionRuntime / remote
 * presentation sources through narrow injected callbacks. It owns no Session,
 * Surface, Status or Submission state, reads no Cordis service, adds no new
 * persisted state or startup fallback, and does not import the composition
 * facade (`src/app/bootstrap.ts`).
 *
 * The one piece of state it does own is the Remote compaction working-fold
 * cache slot (the §13 composition read's proven-window memo), which the
 * composition root seeds from the cold hydrate and drops on a window
 * replacement — exactly as the inline cache was seeded/dropped before.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/session-startup
 */

import type { DirectAgentComposition } from '../direct/composition.ts'
import type { RemoteApplicationSources } from '../application-runtime.ts'
import type { SessionHandle } from '../../runtime/session-lifecycle-port.ts'
import { runDetached } from '../../detached.ts'
import { workingFromLog } from '../../compaction-presentation.ts'
import { safeErrorMessage } from '../../error-boundary.ts'
import type { Diag } from '../../diag.ts'

/** The live Direct agent face the session-startup reads consume. */
export interface LiveAgentLike {
  readonly ctx: unknown
  readonly session: LiveSessionLike
}

/** The exact Direct session face the preset/working reads consume. */
export interface LiveSessionLike {
  readonly id: string
  snapshotEvents(): readonly { readonly type: string }[]
}

/** The preset roster's UX-only preflight read (never the create authority). */
export interface PresetRosterLike {
  resolve(id?: string): Promise<{ broken?: string }>
}

/** The composed-preset roster read (`ctx.get('agentPresets')`'s composed face). */
export interface ComposedPresetRosterLike {
  composedPreset?: (agentCtx: unknown) => unknown
}

/** The proven-window memo entry for the Remote compaction working fold. */
export interface WorkingFoldEntry {
  generation: number
  sessionId: string
  transportToken: unknown
  fold: boolean
  proven: boolean
}

/** The narrow session-startup inputs (composition readbacks only). */
export interface SessionStartupDeps {
  readonly isRemote: boolean
  readonly pendingPresetId: () => string | undefined
  readonly launchPresetId: () => string | undefined
  readonly resolvePresetRoster: () => PresetRosterLike | undefined
  readonly warn: (message: string) => void
  readonly diag: Diag
  readonly composeDirect: (presetId?: string) => Promise<DirectAgentComposition>
  readonly currentAgent: () => LiveAgentLike | undefined
  readonly composedPresetRoster: () => ComposedPresetRosterLike | undefined
  readonly recordedPresetOf: (session: LiveSessionLike) => string | undefined
  readonly currentSessionId: () => string | undefined
  readonly sessionPresetProjectionOf: (sessionId: string) => string | undefined
  readonly sessionBlankOf: (sessionId: string) => boolean | undefined
  readonly generation: () => number
  /** The Remote presentation sources (undefined on Direct). */
  readonly remoteSources: RemoteApplicationSources | undefined
}

/** The session startup/resume/create composition helpers. */
export interface SessionStartupHelpers {
  /** Resolve the launch composition, falling back to the default on an unknown id. */
  launchComposition(): Promise<{ composition: DirectAgentComposition; failure?: string }>
  /** The preset the live session runs on, when the deployment composes one. */
  currentPreset(): string | undefined
  /** The Host turn-boundary authority's blank state for the live Session. */
  sessionBlank(): boolean | undefined
  /** The compaction settle's log-end working read. */
  currentWorkingFromLog(): boolean
  /** Seed the Remote working-fold cache from a PROVEN cold hydrate. */
  seedWorkingFold(entry: WorkingFoldEntry): void
  /** Drop the proven-window memo (window replacement/reconnect). */
  invalidateWorkingFold(): void
}

/**
 * The branch-neutral launch intent (M3-4 PR2): the Remote branch has no Direct
 * composition, so it reports the PRESET INTENT alone. The intent is ALWAYS
 * forwarded to the official `session.create({agentPreset})` — the HOST stays
 * the single authority (an unknown/broken preset is refused THERE); the roster
 * preflight only shapes an EARLY UX notice, never drops the requested value.
 */
export function launchIntentOf(presetId: string | undefined): { agentPreset?: string } {
  return presetId === undefined ? {} : { agentPreset: presetId }
}

/**
 * Create the session-startup helpers over the composition root's narrow
 * readbacks. The factory owns only the Remote working-fold memo; it registers
 * nothing and starts no work.
 */
export function createSessionStartupHelpers(deps: SessionStartupDeps): SessionStartupHelpers {
  const {
    isRemote,
    pendingPresetId,
    launchPresetId,
    resolvePresetRoster,
    warn,
    diag,
    composeDirect,
    currentAgent,
    composedPresetRoster,
    recordedPresetOf,
    currentSessionId,
    sessionPresetProjectionOf,
    sessionBlankOf,
    generation,
    remoteSources,
  } = deps

  const launchComposition = async (): Promise<{ composition: DirectAgentComposition; failure?: string }> => {
    if (remoteSources !== undefined) {
      const presetId = pendingPresetId() ?? launchPresetId()
      const composition = launchIntentOf(presetId)
      if (presetId !== undefined) {
        // UX-only preflight (never the authority): a clearly-broken roster
        // answer warns early; the requested preset still reaches the Host,
        // whose refusal remains the single create-time authority.
        const presets = resolvePresetRoster()
        let broken: string | undefined
        try {
          broken = presets === undefined ? undefined : (await presets.resolve(presetId)).broken
        } catch (error) {
          const message = safeErrorMessage(error)
          warn(`tui-runner: launch preset preflight failed: ${message}`)
          diag.warn('preset preflight failed', { preset: presetId, error: message })
        }
        if (broken !== undefined) {
          const failure = `preset "${presetId}" may be unavailable (${broken}); the Host will refuse or accept it at create time`
          warn(`tui-runner: launch preset preflight: ${failure}`)
          return { composition: composition as DirectAgentComposition, failure }
        }
      }
      return { composition: composition as DirectAgentComposition }
    }
    try {
      return { composition: await composeDirect(pendingPresetId() ?? launchPresetId()) }
    } catch (error) {
      const message = safeErrorMessage(error)
      warn(`tui-runner: launch preset unavailable: ${message}`)
      diag.warn('preset unavailable', { preset: launchPresetId() ?? 'default', error: message })
      return {
        composition: await composeDirect(),
        failure: `preset "${launchPresetId()}" unavailable; started with the default`,
      }
    }
  }

  /** The preset the live session runs on, when the deployment composes one.
   *  Branch-neutral (M3-4 PR5 §3.4): Direct prefers the live composed
   *  preset (`composedPreset(agent.ctx)` — the actual composition
   *  authority) with the recorded projection as fallback; Remote reads the
   *  official `agentPreset` projection through the SAME semantic
   *  `SessionReader.sessionStatus` port. Sessionless = undefined. */
  const currentPreset = (): string | undefined => {
    const agent = currentAgent()
    if (agent !== undefined) {
      const presets = composedPresetRoster()
      if (typeof presets?.composedPreset === 'function') {
        try {
          const composed = presets.composedPreset(agent.ctx)
          if (typeof composed === 'string') return composed
        } catch {
          // During teardown, fall back to the DSH projection read below.
        }
      }
      return recordedPresetOf(agent.session)
    }
    // Remote branch: the official Session projection is the authority (a
    // sessionless surface answers undefined).
    const sessionId = currentSessionId()
    if (sessionId === undefined) return undefined
    return sessionPresetProjectionOf(sessionId)
  }

  /** The Host turn-boundary authority's blank state for the live Session —
   *  the SAME projection the official `agentPresets.select` re-check reads.
   *  Never derived from the TUI transcript. Branch-neutral (PR5 §3.4): the
   *  current session id drives the semantic reader, never a Direct-Agent
   *  prerequisite. */
  const sessionBlank = (): boolean | undefined => {
    const agent = currentAgent()
    const sessionId = agent === undefined ? currentSessionId() : agent.session.id
    if (sessionId === undefined) return undefined
    // The Host-authoritative blank read lives BEHIND the semantic Session
    // reader port (v2 §0.6): the runner no longer knows the Direct
    // projection name or the turn-boundary reducer.
    return sessionBlankOf(sessionId)
  }

  /** The Remote compaction working-fold memo (plan §13): one proven window,
   *  fenced by ownership generation + session id AND the transport token it
   *  was captured under. Seeded from the cold hydrate, dropped on a window
   *  replacement. */
  let remoteWorkingFoldFor: WorkingFoldEntry | undefined

  /** The compaction settle's log-end working read: the runner owns the
   *  live-session log read; the surface only decides WHEN the settle
   *  re-measures. */
  const currentWorkingFromLog = (): boolean => {
    const agent = currentAgent()
    if (agent !== undefined) return workingFromLog(agent.session.snapshotEvents())
    // Remote branch: the working fact folds from the CURRENT official
    // window; a bounded window that cannot prove a boundary falls back to
    // the exact binding's official `running` bit (never a guess).
    if (remoteSources === undefined) return false
    const sessionId = currentSessionId()
    if (sessionId === undefined) return false
    // The CURRENT official window is the working-fold authority; a window
    // that cannot prove a boundary falls back to the exact binding's
    // official `running` bit (never a guess, never the rendered rows).
    // The refresh is detached (failure keeps the last-known fold; the
    // synchronous `running` read below remains the immediate answer).
    // The proof hierarchy matches the presentation owner's cold-hydrate
    // contract (test/remote-working-fold-equivalence.test.ts): a COMPLETE
    // window (hasMore=false, including the EMPTY window) ALWAYS prefers
    // the fold - only a TRUNCATED window defers to the official running
    // bit. The cache is keyed by ownership generation + session id, so a
    // stale fold never crosses an owner change; the async refresh commits
    // only while the same generation/session still owns the surface.
    const ownerGeneration = generation()
    const transportToken = remoteSources.sessionFacts.captureTransportToken(sessionId)
    const cached = remoteWorkingFoldFor
    // EVERY cache read validates BOTH identities: the owner (generation +
    // session) AND the transport token the entry was captured under (a
    // same-owner Connection/binding rollover voids the old window's proof).
    const cacheValid = cached !== undefined
      && cached.generation === ownerGeneration
      && cached.sessionId === sessionId
      && remoteSources.sessionFacts.isTransportTokenCurrent(sessionId, cached.transportToken)
    const provenForThisOwner = cacheValid && cached!.proven
    runDetached('remote working fold', async () => {
      const snapshot = await remoteSources.presentationReader.read(sessionId)
      if (snapshot === undefined) return
      // Fence the cache commit: a settled read for a replaced owner must
      // not mutate the shared slot. The fence covers BOTH identities: the
      // ownership generation AND the Remote transport token (a
      // Connection/binding rollover without a TUI owner commit invalidates
      // the pending answer too).
      if (generation() !== ownerGeneration || currentSessionId() !== sessionId) return
      if (!remoteSources.sessionFacts.isTransportTokenCurrent(sessionId, transportToken)) return
      remoteWorkingFoldFor = {
        generation: ownerGeneration,
        sessionId,
        transportToken,
        fold: !snapshot.hasMore
          ? workingFromLog(snapshot.durableEvents)
          : (remoteSources.sessionFacts.running(sessionId) ?? false),
        proven: !snapshot.hasMore,
      }
    }, { diag, sessionId: () => sessionId })
    if (provenForThisOwner) return cached!.fold
    return remoteSources.sessionFacts.running(sessionId) ?? (cacheValid && cached!.proven ? cached!.fold : false)
  }

  return {
    launchComposition,
    currentPreset,
    sessionBlank,
    currentWorkingFromLog,
    seedWorkingFold: (entry) => { remoteWorkingFoldFor = entry },
    invalidateWorkingFold: () => { remoteWorkingFoldFor = undefined },
  }
}

/** The narrow inputs of the startup-resume pre-mount quiesce. */
export interface ResumeQuiesceDeps<Owner> {
  readonly publishResumedOwner: (
    handle: SessionHandle | undefined,
    preMountQuiesce: (owner: Owner) => Promise<unknown> | undefined,
  ) => Promise<unknown> | undefined
  readonly showPreparingStage: () => void
  readonly whenIdleOrAbort: (owner: Owner, signal: AbortSignal) => Promise<unknown>
  readonly signal: AbortSignal
}

/**
 * The startup-resume publication ORDER is fixed by `runResumeCommit`
 * (A2 plan §4D) inside the runtime: publish owner → completion → pre-mount
 * quiesce. The publication itself stays SYNCHRONOUS; a sessionless (deferred)
 * startup has nothing to quiesce and must not gain a microtask yield here —
 * `publishResumedOwner` returns undefined and this helper returns undefined.
 */
export function quiesceResumedOwner<Owner>(
  handle: SessionHandle | undefined,
  deps: ResumeQuiesceDeps<Owner>,
): Promise<unknown> | undefined {
  return deps.publishResumedOwner(handle, (owner) => {
    // The resume transaction succeeded; the remaining pre-mount wait is
    // the conversation preparation (whenIdle + the catalog ready
    // barrier) — the second status stage replaces the first in place
    // and STAYS until the barrier completes (the catalog prefetch can
    // take seconds; a cleared line would read as a hang again).
    deps.showPreparingStage()
    // The pre-mount whenIdle does NOT observe the lifecycle signal, and
    // the full surface disposer is not registered yet (the pre-mount
    // abort path below has not been reached) — an early HMR/app disposal
    // would otherwise leave this await hanging forever and the
    // just-created owner would never be retired. Cancel the agent on
    // abort so whenIdle settles, then the pre-mount abort path below
    // retires the owner.
    return deps.whenIdleOrAbort(owner, deps.signal)
  })
}
