/**
 * The About status controller (Phase 3C / C3): ONE per-Settings-open owner of
 * the About projection's read lifecycle.
 *
 * It owns the per-open epoch, the ACTIVE page flag and the read fencing; it
 * holds NO business store. Every read goes through the injected operations
 * (the command/application composition supplies the official ports) and
 * re-proves the ORIGINAL captured SessionScope — owner AND generation, never
 * the session id alone — after every await. A session switch, an owner
 * rollover at the same id, an About leave, or a dispose can never deliver a
 * stale subject's facts, and A's result is never retargeted to B.
 *
 * Read admission (the frozen C3 freshness contract):
 *
 * - `enter()` — one semantic About entry: capture the live scope (NEVER
 *   creating a session), advance the epoch, publish the immediate
 *   version/backend + `Loading`/`No active session` frame, then start ONE
 *   stats read and ONE context re-read when a live session exists;
 * - `refresh()` — the same read logic on the current scope; an in-flight
 *   SAME-SCOPE request coalesces, an explicit later click after settle starts
 *   exactly one new read;
 * - `leave()` — the page is no longer active: pending results become no-ops
 *   and invalidation never starts reads while inactive;
 * - `dispose()` — releases the subscription and every callback.
 *
 * The controller subscribes ONCE (at construction, per workspace open) to the
 * required narrow status-invalidation trigger. A publication while the page
 * is ACTIVE re-captures the full scope: a NEW SessionScope (sessionless↔live,
 * a different id, or a same-id owner/generation rollover) admits ONE scoped
 * re-read with the immediate `Loading` frame — the previous session's view is
 * revoked at once, so a copy gesture can never emit the old subject's facts.
 * Same-scope revisions repaint already captured facts only — never a
 * per-revision stats re-fold.
 *
 * The read itself is an OWNED detached task (the repository's failure model):
 * an unexpected rejection is classified and logged, never an unhandled
 * rejection and never a user-facing error for a superseded/aborted read.
 * @module @xmoon76/dsh-pi-tui/app/command/about-status
 */

import { runDetached } from '../../runtime/process/tasks.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import {
  aboutFactRows,
  serializeAboutStatus,
  ABOUT_NO_ACTIVE_SESSION,
  type AboutBackendKind,
  type AboutStatusView,
} from '../../domain/status/about.ts'
import type { SessionStatsFacts } from '../../domain/status/stats.ts'
import type { LiveSessionScope, SessionScope } from '../session/scope.ts'
import type { SessionStatusProjection } from '../../runtime/session-reader-port.ts'

/** The injected read operations. All are NONCREATING reads: none may call
 * `requireLiveSessionScope`, `ensureSession`, or any Host write. */
export interface AboutStatusControllerOps {
  /** The exact selected backend kind (the composition's own fact). */
  readonly backendKind: AboutBackendKind
  /** ONE synchronous NONCREATING live-scope capture, or `undefined`. */
  captureLiveSessionScope(): LiveSessionScope | undefined
  /** The captured scope's currentness (owner AND generation). */
  isSessionScopeCurrent(scope: SessionScope): boolean
  /** The pinned Session's whole-log stats (`undefined` = unavailable). */
  currentSessionStats(scope: LiveSessionScope, signal?: AbortSignal): Promise<SessionStatsFacts | undefined>
  /** The ONE Session-scoped official status read of the EXACT id. */
  readSessionStatus(sessionId: string): SessionStatusProjection | undefined
  /** TRUE when the last `sessionStatus()` read for this id FAILED (the
   *  projection authority threw): an `undefined` status then means UNKNOWN,
   *  never an ordinary absence. Absent method = no failure signal. */
  sessionStatusFailed?(sessionId: string): boolean
  /** The context force + observation (the existing coordinator path). */
  forceContextMeasurementResult(): { readonly value: number | undefined; readonly observation: 'fresh' | 'last-known' | 'unavailable' }
  /** The Client-side versions (read once per open by the composition). */
  readonly versionFacts: { readonly tui: string; readonly dsh: string | undefined }
  /**
   * C3 (owner ruling on RFL-A-017): the ONE session-scope invalidation
   * trigger — the SessionOwnershipCore's payload-less owner/generation
   * notification, forwarded unchanged. This REPLACES the plan §3.2 step
   * 4/9 StatusStore subscription: the store legitimately suppresses
   * content-equal patches, so it can never guarantee a scope-identity
   * signal. The listener carries NO data — the controller re-captures the
   * live scope and fences through `isSessionScopeCurrent`.
   */
  subscribeSessionScopeInvalidation(listener: () => void): () => void
  /** The diagnostics channel of the OWNED read task (failure model). */
  readonly diag: Diag
  /** The live session id at settle time, for the owned-task diagnostics. */
  readonly sessionIdForDiagnostics?: () => string | undefined
}

/** Build one immutable About view from captured pieces. */
function viewOf(
  epoch: number,
  versionFacts: { readonly tui: string; readonly dsh: string | undefined },
  backendKind: AboutBackendKind,
  session: AboutStatusView['session'],
): AboutStatusView {
  return {
    runtime: { tui: versionFacts.tui, dsh: versionFacts.dsh, backend: backendKind },
    session,
    epoch,
  }
}

/** The sessionless view. */
function sessionlessView(
  epoch: number,
  versionFacts: { readonly tui: string; readonly dsh: string | undefined },
  backendKind: AboutBackendKind,
): AboutStatusView {
  return viewOf(epoch, versionFacts, backendKind, { kind: 'none' })
}

/**
 * The per-open About owner. Constructed lazily per Settings workspace open;
 * `dispose()` runs on the workspace teardown.
 */
export class AboutStatusController {
  private readonly ops: AboutStatusControllerOps
  private epoch = 0
  private snapshot: AboutStatusView
  private readonly listeners = new Set<() => void>()
  private readonly unsubscribe: () => void
  private disposed = false
  /** Whether the About page is ACTIVE (between enter and leave/dispose):
   *  only an active page admits invalidation-driven reads. */
  private active = false
  /** The full captured scope identity of the DISPLAYED view (the object
   *  reference is the owner+generation identity, never the id string). */
  private displayedScope: LiveSessionScope | undefined
  /** The in-flight read's admission epoch + scope: a superseded read never
   *  publishes, and a same-scope in-flight read coalesces a refresh. */
  private inFlight: { readonly epoch: number; readonly scope: LiveSessionScope } | undefined

  constructor(ops: AboutStatusControllerOps) {
    this.ops = ops
    // The initial frame: versions/backend are Client facts, the sessionless
    // state is the honest default until an entry proves otherwise.
    this.snapshot = sessionlessView(0, ops.versionFacts, ops.backendKind)
    // Exactly ONE subscription for this controller's lifetime (acquired at
    // page open — construction IS the page open — released at dispose).
    this.unsubscribe = ops.subscribeSessionScopeInvalidation(() => { this.onScopeInvalidation() })
  }

  /** The current immutable view (the panel renders `aboutFactRows` of THIS). */
  snapshotView(): AboutStatusView {
    return this.snapshot
  }

  /**
   * Whether `scope` is the SAME owner+generation as the DISPLAYED captured
   * scope. The ONE production identity channel is `isSessionScopeCurrent`:
   * `captureLive()` mints a FRESH scope object on every call (the subject
   * token is never an identity — `app/session/subject.ts`), so object
   * reference equality would classify every unchanged live scope as a new
   * one. `isCurrent(displayed)` pins the recorded owner AND generation
   * against the live record — exactly the fence every other consumer uses.
   */
  private displaysScope(scope: LiveSessionScope | undefined): boolean {
    if (scope === undefined) return this.displayedScope === undefined
    return this.displayedScope !== undefined && this.ops.isSessionScopeCurrent(this.displayedScope)
      && this.displayedScope.sessionId === scope.sessionId
  }

  /** One semantic About entry: at most one scoped snapshot refresh. An
   *  entry while the page is ALREADY active with the same current scope is
   *  a no-op (focusing the content from the rail inside About is not a new
   *  entry — the plan's "at most one per entry event"). */
  enter(): void {
    if (this.disposed) return
    const scope = this.ops.captureLiveSessionScope()
    if (this.active && this.displaysScope(scope)) {
      // Same page, same owner+generation: the entry event carries no new
      // information.
      return
    }
    this.active = true
    this.epoch += 1
    if (scope === undefined) {
      // Sessionless: NO read, NO session creation, no stats request.
      this.inFlight = undefined
      this.displayedScope = undefined
      this.publish(sessionlessView(this.epoch, this.ops.versionFacts, this.ops.backendKind))
      return
    }
    // Immediate frame: the captured id + Loading (never a fabricated zero).
    // The previous session's facts are revoked HERE (one publication), so a
    // copy gesture between the switch and the settle can never emit them.
    // The in-flight marker is committed BEFORE the publication: a synchronous
    // listener re-entering refresh()/enter() during the callback hits the
    // same-scope coalesce guard instead of minting a new read.
    this.displayedScope = scope
    this.inFlight = { epoch: this.epoch, scope }
    this.publish(viewOf(this.epoch, this.ops.versionFacts, this.ops.backendKind, {
      kind: 'loading',
      sessionId: scope.sessionId,
    }))
    this.startScopedRead(scope, this.epoch)
  }

  /** The manual refresh (`r` / the Refresh action): one new read on the
   *  current scope; an in-flight SAME-SCOPE request coalesces. */
  refresh(): void {
    if (this.disposed || !this.active) return
    const scope = this.ops.captureLiveSessionScope()
    if (scope === undefined) {
      // The session went away between entry and refresh: the honest frame.
      this.epoch += 1
      this.inFlight = undefined
      this.displayedScope = undefined
      if (this.snapshot.session.kind !== 'none') {
        this.publish(sessionlessView(this.epoch, this.ops.versionFacts, this.ops.backendKind))
      }
      return
    }
    if (this.displaysScope(scope) && this.inFlight !== undefined) return
    this.epoch += 1
    this.displayedScope = scope
    // The in-flight marker is committed BEFORE the Loading publication (the
    // same synchronous-reentry fence as enter()).
    this.inFlight = { epoch: this.epoch, scope }
    this.publish(viewOf(this.epoch, this.ops.versionFacts, this.ops.backendKind, {
      kind: 'loading',
      sessionId: scope.sessionId,
    }))
    this.startScopedRead(scope, this.epoch)
  }

  /** Leave the About page: pending results become no-ops and the page is
   *  inactive — invalidation never starts a read until the next `enter()`. */
  leave(): void {
    this.active = false
    this.epoch += 1
    this.inFlight = undefined
  }

  /** Subscribe to snapshot publications; returns the disposer. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Release the subscription; every pending read becomes a no-op. */
  dispose(): void {
    this.disposed = true
    this.active = false
    this.epoch += 1
    this.inFlight = undefined
    this.listeners.clear()
    this.unsubscribe()
  }

  /**
   * The ONE invalidation entry: the live-owner projection changed. While the
   * page is ACTIVE, re-capture and compare against the DISPLAYED scope via
   * `isSessionScopeCurrent` (the owner+generation fence — never the object
   * reference, which `captureLive()` re-mints per call, and never the id
   * string alone):
   *
   * - sessionless→live, live→sessionless, a different id, and a same-id
   *   owner/generation rollover each admit ONE new scoped read (with the
   *   immediate revoking frame);
   * - the same owner+generation merely repainted (a same-scope revision) is
   *   ignored — the already captured facts stay the view's truth.
   */
  private onScopeInvalidation(): void {
    if (this.disposed || !this.active) return
    const scope = this.ops.captureLiveSessionScope()
    if (this.displaysScope(scope)) return
    // A superseding scope: revoke the old view immediately and read once.
    // (An identical re-notification while the new read is already in flight
    // coalesces: the displayed scope is the NEW one and an in-flight read
    // for it exists — `refresh()`'s coalesce guard covers the same case.)
    if (this.displayedScope !== undefined
      && this.ops.isSessionScopeCurrent(this.displayedScope)
      && this.inFlight !== undefined
      && this.inFlight.scope.sessionId === scope?.sessionId) return
    this.epoch += 1
    this.displayedScope = scope
    if (scope === undefined) {
      this.inFlight = undefined
      this.publish(sessionlessView(this.epoch, this.ops.versionFacts, this.ops.backendKind))
      return
    }
    // The in-flight marker is committed BEFORE the Loading publication (the
    // same synchronous-reentry fence as enter()/refresh(): a subscriber that
    // calls refresh() from inside this publication coalesces instead of
    // admitting a second read).
    this.inFlight = { epoch: this.epoch, scope }
    this.publish(viewOf(this.epoch, this.ops.versionFacts, this.ops.backendKind, {
      kind: 'loading',
      sessionId: scope.sessionId,
    }))
    this.startScopedRead(scope, this.epoch)
  }

  /** Start ONE scoped read (stats + context) for the captured scope, as an
   *  OWNED detached task: every rejection is classified (a superseded/aborted
   *  read is debug-only; anything else warns), never an unhandled rejection. */
  private startScopedRead(scope: LiveSessionScope, epoch: number): void {
    runDetached('about status read', () => this.runScopedRead(scope, epoch), {
      diag: this.ops.diag,
      sessionId: this.ops.sessionIdForDiagnostics ?? (() => scope.sessionId),
    })
  }

  /** The fenced read: stats + projection + context for the EXACT captured
   *  scope; every await re-proves the original scope, the epoch, and
   *  disposal. EACH GROUP'S failure is isolated: a throwing projection /
   *  context read marks only ITS OWN group failed and the already-settled
   *  authoritative groups still publish (the truthful degraded frame) — a
   *  group failure never discards the others and never leaves the view in
   *  Loading. Superseded/aborted reads publish nothing. EVERY terminal
   *  outcome settles the matching in-flight marker. */
  private async runScopedRead(scope: LiveSessionScope, epoch: number): Promise<void> {
    try {
      const stale = (): boolean =>
        this.disposed || epoch !== this.epoch || !this.ops.isSessionScopeCurrent(scope)
      const stats = await this.readStats(scope)
      if (stale()) return
      // The projection read is SYNCHRONOUS and atomic with its failure bit;
      // a throw marks the group failed instead of discarding the whole read.
      let projection: { readonly status: SessionStatusProjection | undefined; readonly failed: boolean } | undefined
      let projectionThrew = false
      try {
        projection = this.readProjectionGuarded(scope)
      } catch {
        projectionThrew = true
      }
      if (stale()) return
      let context: { readonly value: number | undefined; readonly window: number | undefined; readonly observation: 'fresh' | 'last-known' | 'unavailable' }
      let contextThrew = false
      try {
        context = this.readContextGuarded(scope, projection)
      } catch {
        context = { value: undefined, window: undefined, observation: 'unavailable' }
        contextThrew = true
      }
      if (stale()) return
      if (this.inFlight !== undefined && this.inFlight.epoch === epoch) this.inFlight = undefined
      // The projection's own availability is a SEPARATE fact from the stats
      // group's: a missing/failed projection with authoritative stats still
      // carries its stats, and the view words the projection state explicitly
      // (`projectionUnavailable` → the state row), never a fabricated frame.
      const projectionStatus = projection?.status
      const projectionUnavailable = projectionStatus === undefined
      this.publish(viewOf(epoch, this.ops.versionFacts, this.ops.backendKind, {
        kind: projectionUnavailable && stats === undefined ? 'unavailable' : 'ready',
        sessionId: scope.sessionId,
        ...(projectionStatus === undefined ? {} : this.factsOfProjection(projectionStatus)),
        // The projection's OWN failure/absence state word, independent of the
        // stats groups — the ATOMICALLY captured bit distinguishes a thrown
        // authority (`Projection: Failed`) from an answered absence
        // (`Projection: Unavailable`).
        projectionUnavailable,
        projectionFailed: projectionUnavailable && (projectionThrew || projection?.failed === true),
        // The stats group: an authoritative answer survives EVERY other
        // group's failure (the whole point of the group isolation).
        ...(stats === undefined ? {} : { stats }),
        // The context group words its own failure: a thrown force is NOT a
        // "fresh" observation and never discards the stats groups.
        context: contextThrew ? 'unavailable' : context.observation,
        ...(context.value === undefined ? {} : { contextUsed: context.value }),
        ...(context.window === undefined ? {} : { contextWindow: context.window }),
      }))
    } finally {
      // THE settlement guarantee: a throwing sync operation (projection read,
      // context force, window read) must never leave the marker armed — the
      // same-scope refresh coalesce would otherwise block every retry. A
      // superseded epoch's marker was already replaced by the newer
      // admission and must not be cleared here.
      if (this.inFlight !== undefined && this.inFlight.epoch === epoch) this.inFlight = undefined
    }
  }

  /** The whole-log stats read; a SupersededReadError is staleness, not an
   *  error (the scope fence below would refuse it anyway). */
  private async readStats(scope: LiveSessionScope): Promise<SessionStatsFacts | undefined> {
    try {
      return await this.ops.currentSessionStats(scope)
    } catch {
      // A stale/aborted read is refused by the fence; the view simply does
      // not publish it. Never a user-facing error, never a retry.
      return undefined
    }
  }

  /** The official projection read of the EXACT captured id (no fallback to
   *  global routing facts); a mismatch is treated as unavailable — the
   *  projection answered for someone else, which must never ride this view.
   *  The FAILED bit is captured ATOMICALLY with the read it describes (the
   *  port's bit describes the LAST read for the id, so a later unrelated
   *  read would otherwise clear it): one call, one bit, one classification.
   *  ALWAYS returns the bit — the caller needs it even when the projection
   *  itself is absent. */
  private readProjectionGuarded(scope: LiveSessionScope): {
    readonly status: SessionStatusProjection | undefined
    readonly failed: boolean
  } {
    const status = this.ops.readSessionStatus(scope.sessionId)
    const failed = this.ops.sessionStatusFailed?.(scope.sessionId) === true
    const usable = status !== undefined && status.sessionId === scope.sessionId ? status : undefined
    return { status: usable, failed }
  }

  /** The context re-read through the EXISTING coordinator (one measurement,
   *  no second cache) + the official window of THIS session. The window
   *  read re-uses the ALREADY-captured projection (one sessionStatus read
   *  per About cycle — a second read here would also clear the failure bit
   *  the projection group just captured). */
  private readContextGuarded(scope: LiveSessionScope, projection: { readonly status: SessionStatusProjection | undefined; readonly failed: boolean } | undefined): {
    readonly value: number | undefined
    readonly window: number | undefined
    readonly observation: 'fresh' | 'last-known' | 'unavailable'
  } {
    const result = this.ops.forceContextMeasurementResult()
    const window = projection?.status?.context?.contextWindow
    return { value: result.value, window, observation: result.observation }
  }

  /** The projection's present facts (each only when its authority answered;
   *  never a fallback from process.cwd() or UI defaults). */
  private factsOfProjection(status: SessionStatusProjection): {
    readonly title?: string
    readonly provider?: string
    readonly model?: string
    readonly effort?: string
    readonly preset?: string
    readonly cwd?: string
  } {
    return {
      ...(status.title === undefined ? {} : { title: status.title }),
      ...(status.model?.provider === undefined ? {} : { provider: status.model.provider }),
      ...(status.model?.model === undefined ? {} : { model: status.model.model }),
      ...(status.model?.reasoningEffort === undefined ? {} : { effort: status.model.reasoningEffort }),
      ...(status.preset === undefined ? {} : { preset: status.preset }),
      ...(status.cwd === undefined ? {} : { cwd: status.cwd }),
    }
  }

  /** Publish one meaningful change (one publication per read settle, never
   *  per render). */
  private publish(next: AboutStatusView): void {
    this.snapshot = next
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A throwing listener must never break the controller or the
        // other listeners (the panel repaint is best-effort).
      }
    }
  }
}

/** Re-exported so the panel/composition can read the state words from the
 *  same module the rows come from (no second vocabulary). */
export { aboutFactRows, serializeAboutStatus, ABOUT_NO_ACTIVE_SESSION }
