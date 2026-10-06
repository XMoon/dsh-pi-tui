/**
 * Context-measurement coordinator (PR D2): the single cached, session-bound
 * context-pressure value behind the footer's status surface.
 *
 * The runner NEVER measures context in a generic status refresh — a UI-only
 * refresh (theme, keybinding, permission, focus, resize, search, …) reads the
 * cache and never touches a reader. Model-visible lifecycle events
 * (step/start, turn/end, compaction/end, session identity change) mark the
 * cache dirty and re-measure through the semantic `SessionReader` port
 * (`measureContext`), so the future Remote adapter can serve measurements
 * over the wire while the TUI stays transport-neutral.
 *
 * Policy (plan §17):
 *
 * ```text
 * session generation owns the cache
 * model-visible lifecycle events mark dirty
 * a measure clears dirty
 * UI-only events never mark dirty
 * ```
 *
 * A measurement FAILURE keeps the last-good value (never clears it) and
 * stays dirty, so the next lifecycle trigger retries. A session identity
 * change clears the old session's value — the new session can never inherit
 * the old measurement.
 * @module @xmoon76/dsh-pi-tui/status/context-measurement
 */

/** Why the runner is (re)measuring context — informational today, the seam
 * for future coalescing/force policies. */
export type ContextMeasureReason =
  | 'initial'
  | 'step-start'
  | 'turn-end'
  | 'compaction-end'
  | 'explicit-status'
  | 'session-switch'

/** The coordinator's observable state (test seam). */
export interface ContextMeasurementSnapshot {
  readonly sessionId: string | undefined
  readonly value: number | undefined
  readonly dirty: boolean
}

/** The session-bound context measurement cache. Pure and synchronous —
 * the Direct `measureContext` port is sync today, and the coordinator must
 * not assume a future wire backend stays sync (the runner's generation
 * fence owns stale-result protection across async deferrals). */
export class ContextMeasurementCoordinator {
  private sessionId: string | undefined
  private value: number | undefined
  private dirty = false

  /** Rebind to a new session identity. A DIFFERENT session clears the old
   * value (an old session's contextTokens must never ride a new session);
   * the same session is a no-op, so a same-session refresh cycle keeps the
   * last-good value without re-marking. `undefined` (no live session)
   * clears everything. */
  bind(sessionId: string | undefined): void {
    if (sessionId === this.sessionId) return
    this.sessionId = sessionId
    this.value = undefined
    this.dirty = sessionId !== undefined
  }

  /** Mark the bound session's context possibly changed (model-visible
   * lifecycle events only). No-op without a bound session — UI-only
   * refresh cycles must not be able to arm a measurement. */
  markDirty(): void {
    if (this.sessionId === undefined) return
    this.dirty = true
  }

  /** Whether a measurement is pending for the bound session. */
  isDirty(): boolean {
    return this.dirty
  }

  /** The cached value, ONLY for the given session identity — any other
   * session (or none) reads `undefined`, never a foreign measurement. */
  valueFor(sessionId: string | undefined): number | undefined {
    return sessionId !== undefined && sessionId === this.sessionId ? this.value : undefined
  }

  /**
   * Measure the given session through the reader port WHEN DIRTY; a clean
   * cache skips the reader entirely (same-sync-chain dedupe — plan §17).
   *
   * Only the BOUND session can be measured: a different (stale/foreign)
   * session id is refused outright — a deferred caller that slipped past
   * the runner's generation fence can never commit a measurement under the
   * wrong identity, because `bind()` is the ONLY way the cache changes
   * session.
   *
   * Failure semantics: the reader returning `undefined` (or throwing — the
   * coordinator swallows best-effort) keeps the last-good value and the
   * dirty flag stays set, so the next trigger retries; a successful number
   * commits and clears dirty. The cached value (fresh or last-good) is
   * returned.
   *
   * @param sessionId - the session to measure (the runner's CURRENT live
   * session; must match the bound identity).
   * @param reader - the semantic measurement port call.
   */
  measure(sessionId: string | undefined, reader: (sessionId: string) => number | undefined): number | undefined {
    if (sessionId === undefined || sessionId !== this.sessionId) return undefined
    if (!this.dirty) return this.value
    let fresh: number | undefined
    try {
      fresh = reader(sessionId)
    } catch {
      // Best-effort: a throwing reader/backend must never crash the TUI.
      // The last-good value survives and the dirty flag stays for a retry.
      fresh = undefined
    }
    if (fresh !== undefined) {
      this.value = fresh
      this.dirty = false
    }
    return this.value
  }

  /** The full observable state (test seam). */
  snapshot(): ContextMeasurementSnapshot {
    return { sessionId: this.sessionId, value: this.value, dirty: this.dirty }
  }
}

/**
 * Defer one context measurement past the first usable paint (plan §16.2):
 * hydrate → bounded repaint → cheap status → THIS deferral → measure on the
 * next event-loop turn. The runner captures the session generation + id and
 * provides the fence; the callback is a no-op when the captured session no
 * longer owns the surface (switch, /new, viewer swap, dispose).
 *
 * Returns a cancel function (the runner's cleanup path).
 *
 * @param schedule - the deferral primitive (the runner injects
 * `setImmediate`; tests inject a fake to drive the callback deterministically).
 * @param fence - true only while the captured session still owns the surface.
 * @param run - the measurement + cheap repaint (markContextDirty +
 * refreshContextMeasurement('initial') in the runner).
 */
export function deferInitialContextMeasure(
  schedule: (callback: () => void) => unknown,
  fence: () => boolean,
  run: () => void,
): () => void {
  let handle: unknown
  handle = schedule(() => {
    handle = undefined
    if (fence()) run()
  })
  return () => {
    const current = handle
    handle = undefined
    if (current === undefined || current === null) return
    if (typeof current === 'object' && 'cancel' in current && typeof (current as { cancel?: unknown }).cancel === 'function') {
      ;(current as { cancel: () => void }).cancel()
    } else {
      clearImmediate(current as NodeJS.Immediate)
    }
  }
}
