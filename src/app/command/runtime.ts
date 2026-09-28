/**
 * The BOUND command runtime (A3 plan §3/§6 A3-5): the command layer's own
 * application owner for the SEMANTIC command surface.
 *
 * It owns the ONE currentness fence every scope-bound command facade shares
 * (`liveSessionId`: a stale scope throws `SupersededReadError` BEFORE any
 * dispatch, a sessionless capture is refused for a live read) and the facade
 * shapes the command layer consumes:
 *
 * - the scope/currentness facts and the atomic `requireLiveSessionScope`;
 * - the scoped command view and the skill execution facade (validate before
 *   dispatch, re-validate the ORIGINAL scope after an await);
 * - the stats / read facades (the owner's running state, routing, approval
 *   override, folded stats and last assistant text);
 * - the catalog refresh facades (a LIVE session's agent-scoped refresh plus
 *   the sessionless STANDING preset refresh — never downgraded one into the
 *   other);
 * - the prompt-admission facade and the `SessionRuntime.withWriter` exposure.
 *
 * It NEVER sees a Direct module, a Host Agent or a raw `ctx.*` service: every
 * Direct fact arrives as a narrow {@link CommandRuntimeSurface} hook and every
 * Host catalog read goes through the semantic `SkillCatalogCapability` port.
 * The runner keeps the Direct composition + the presentation dependency bag
 * (A5 bootstrap finalizes that); this module is the semantic runtime, not a
 * forwarding shell for the presentation surface.
 * @module @xmoon76/dsh-pi-tui/app/command/runtime
 */

import { SupersededReadError } from '../../runtime/read-error.ts'
import type { SkillCatalogCapability, SkillDefinitionResult } from '../../runtime/catalog-port.ts'
import type { CatalogRefreshOutcome, CatalogRefreshSource } from '../../skill-catalog-refresh.ts'
import type { HumanSkillCatalog } from '../../skill-catalog.ts'
import type { SessionStats } from '../../stats.ts'
import type { SurfaceCommandSummary } from '../../surface-catalog.ts'
import type { LiveSessionScope, SessionScope, SessionScopeAuthority } from '../session/scope.ts'

/** The session-runtime entries the command runtime drives. */
export interface CommandSessionRuntime {
  /** Create the first session lazily when none exists (deferred start). */
  ensureSession(): Promise<void>
  /** `SessionRuntime.withWriter`: the scope-bound writer admission. */
  withWriter<T>(scope: LiveSessionScope, task: () => Promise<T> | T): Promise<T>
}

/**
 * The owner-resolved Direct facts the scope-bound facades read. Every method
 * receives the ALREADY-validated live session id: the runner resolves the
 * exact Direct attachment in the SAME synchronous step (the module's
 * `liveSessionId` fence ran immediately before), so the scope's owner is
 * proven and the attachment cannot be retargeted.
 */
export interface CommandRuntimeSurface {
  /** The scoped command view of the CURRENT surface (a display read). */
  listScopedCommands(): readonly SurfaceCommandSummary[]
  /** Whether the live owner is running. */
  sessionRunning(sessionId: string): boolean
  /** The live owner's routing facts (`provider`/`model` are optional). */
  sessionRouting(sessionId: string): {
    readonly provider: string | undefined
    readonly model: string | undefined
    readonly cwd: string
  }
  /** The live owner's approval-policy override, or `undefined`. */
  approvalOverride(sessionId: string): 'ask' | 'never' | undefined
  /** The live owner's folded stats, or `undefined`. */
  sessionStats(sessionId: string): SessionStats | undefined
  /** The live owner's last assistant text, or `undefined`. */
  lastAssistantText(sessionId: string): string | undefined
  /** The LIVE agent-scoped catalog refresh (exact owner + generation captured
   *  in the same synchronous step). */
  refreshLiveCatalog(sessionId: string, source: CatalogRefreshSource): Promise<CatalogRefreshOutcome>
  /** The sessionless STANDING preset refresh (no Agent, no session). */
  refreshStandingCatalog(presetId: string | undefined, source: CatalogRefreshSource): Promise<CatalogRefreshOutcome>
  /** The owner-resolved per-Agent prompt/image admission window. */
  promptAdmission<T>(sessionId: string, line: string, task: () => Promise<T> | T): Promise<T>
}

export interface CommandRuntimeDeps {
  /** The ownership-core scope authority (the ONLY currentness source). */
  readonly scope: SessionScopeAuthority
  /** The bound session runtime. */
  readonly session: CommandSessionRuntime
  /** The Host skill catalog port (session-id keyed, never an Agent). */
  readonly skills: SkillCatalogCapability
  /** The Direct facts, resolved by the runner. */
  readonly surface: CommandRuntimeSurface
}

/** The semantic command surface the runner facade delegates to. */
export interface CommandRuntime {
  captureSessionScope(): SessionScope
  captureLiveSessionScope(): LiveSessionScope | undefined
  isSessionScopeCurrent(scope: SessionScope): boolean
  /** Ensure the lazy first session, then capture ONE atomic live scope. Throws
   *  'session could not be created' when still sessionless. */
  requireLiveSessionScope(): Promise<LiveSessionScope>
  /** The scoped command view of the CURRENT surface. */
  listScopedCommands(): readonly SurfaceCommandSummary[]
  /** Resolve ONE skill definition of the exact owner the scope pins: validated
   *  BEFORE the dispatch and again after the read settles. */
  resolveScopedSkill(scope: LiveSessionScope, name: string): Promise<SkillDefinitionResult>
  /** Whether the Host's skill pre-step loads the body for the exact owner the
   *  scope pins: validated BEFORE the synchronous read. */
  hostLoadsSkillBody(scope: LiveSessionScope): boolean
  /** Read the human skill catalog of the exact owner the scope pins: validated
   *  BEFORE the dispatch and again after the read settles. */
  listScopedSkills(scope: LiveSessionScope, signal?: AbortSignal): Promise<HumanSkillCatalog | undefined>
  currentSessionActivity(scope: LiveSessionScope): { readonly running: boolean }
  currentSessionRouting(scope: LiveSessionScope): {
    readonly provider: string | undefined
    readonly model: string | undefined
    readonly cwd: string
  }
  currentApprovalOverride(scope: LiveSessionScope): 'ask' | 'never' | undefined
  currentSessionStats(scope: LiveSessionScope): SessionStats | undefined
  lastAssistantText(scope: LiveSessionScope): string | undefined
  /** Refresh the LIVE Session's scoped catalog. The scope is validated at the
   *  SYNC admission (the exact owner is captured there) and again after the
   *  read settles. Accepts a sessionless-capable capture so /preset's live
   *  branch can pass the scope it fences with. */
  refreshSessionCatalog(scope: SessionScope, source: CatalogRefreshSource): Promise<CatalogRefreshOutcome>
  /** Refresh the sessionless STANDING catalog of `presetId`. */
  refreshStandingCatalog(presetId: string | undefined, source: CatalogRefreshSource): Promise<CatalogRefreshOutcome>
  /** `SessionRuntime.withWriter`: the scope-bound writer admission. */
  withWriter<T>(scope: LiveSessionScope, task: () => Promise<T> | T): Promise<T>
  /** The owner-resolved prompt/image admission of the exact scope owner. */
  withPromptAdmission<T>(scope: LiveSessionScope, line: string, task: () => Promise<T> | T): Promise<T>
}

export function bindCommandRuntime(deps: CommandRuntimeDeps): CommandRuntime {
  /**
   * The ONE stale-throwing admission every scope-bound facade shares: a stale
   * scope is refused with {@link SupersededReadError} BEFORE any dispatch (and
   * never retargeted to the current replacement owner); a sessionless capture
   * has no live read. The returned id is passed to an owner-resolving surface
   * hook in the SAME synchronous stack, so the fence cannot be overtaken.
   */
  const liveSessionId = (scope: SessionScope): string => {
    if (!deps.scope.isCurrent(scope)) {
      throw new SupersededReadError('the session changed before the read')
    }
    const sessionId = scope.sessionId
    if (sessionId === undefined) throw new Error('a live read requires a Session scope')
    return sessionId
  }

  return {
    captureSessionScope: () => deps.scope.capture(),
    captureLiveSessionScope: () => deps.scope.captureLive(),
    isSessionScopeCurrent: (scope) => deps.scope.isCurrent(scope),
    requireLiveSessionScope: async () => {
      await deps.session.ensureSession()
      const scope = deps.scope.captureLive()
      if (scope === undefined) throw new Error('session could not be created')
      return scope
    },
    // The synchronous current read (display/collision baseline), never a fence.
    listScopedCommands: () => deps.surface.listScopedCommands(),
    // The skill catalog reads of the owner the scope pins: validate BEFORE
    // dispatching (never downgraded to a bare session id handed to a
    // current-owner resolver) and re-validate the ORIGINAL scope after the
    // await, so a superseded read is never presented.
    resolveScopedSkill: async (scope, name) => {
      const sessionId = liveSessionId(scope)
      const resolved = await deps.skills.resolveSkill(sessionId, name)
      if (!deps.scope.isCurrent(scope)) {
        throw new SupersededReadError('the session changed while loading the skill')
      }
      return resolved
    },
    hostLoadsSkillBody: (scope) => {
      const sessionId = liveSessionId(scope)
      return deps.skills.hostLoadsSkillBody(sessionId)
    },
    listScopedSkills: async (scope, signal) => {
      const sessionId = liveSessionId(scope)
      const catalog = await deps.skills.listHumanSkills(sessionId, signal)
      if (!deps.scope.isCurrent(scope)) {
        throw new SupersededReadError('the session changed while reading the skill catalog')
      }
      return catalog
    },
    currentSessionActivity: (scope) => ({ running: deps.surface.sessionRunning(liveSessionId(scope)) }),
    // `provider`/`model` are OPTIONAL in the DSH AgentOptions contract (and the
    // Direct composition may leave them unset): their absence is real semantic
    // optionality, never an invariant break — the presentation renders
    // "unconfigured".
    currentSessionRouting: (scope) => deps.surface.sessionRouting(liveSessionId(scope)),
    // The scope's owner is proven current before the read; the port resolves
    // the session id to its exact live Agent internally.
    currentApprovalOverride: (scope) => deps.surface.approvalOverride(liveSessionId(scope)),
    currentSessionStats: (scope) => deps.surface.sessionStats(liveSessionId(scope)),
    lastAssistantText: (scope) => deps.surface.lastAssistantText(liveSessionId(scope)),
    refreshSessionCatalog: async (scope, source) => {
      // SYNC admission: the scope must still be the current owner, and the
      // exact Direct owner is captured by the surface in this same step.
      const sessionId = liveSessionId(scope)
      const outcome = await deps.surface.refreshLiveCatalog(sessionId, source)
      // Judge staleness with the ORIGINAL scope after settle; a read that did
      // not own the surface must not present its result.
      if (!deps.scope.isCurrent(scope)) {
        throw new SupersededReadError('the session changed during the catalog refresh')
      }
      return outcome
    },
    refreshStandingCatalog: (presetId, source) => deps.surface.refreshStandingCatalog(presetId, source),
    withWriter: (scope, task) => deps.session.withWriter(scope, task),
    withPromptAdmission: (scope, line, task) => deps.surface.promptAdmission(liveSessionId(scope), line, task),
  }
}
