/**
 * The session switch transaction — the canonical ordering shared by /new,
 * /fork, conversation rewind and `/sessions` switch/resume:
 *
 * ```text
 * 1. quiesce old (whenIdle + final flush)
 * 2. ALL TUI-owned preflight (preset/composition/stale checks — BEFORE the
 *    DSH boundary, so failures abort with ZERO side effects)
 * 3. create/resume — a rejection is NEVER retried (no same-ID recovery):
 *    the old session stays current and the user may retry
 * 4. COMMIT — a synchronous critical section (generation bump, live
 *    replacement)
 * 5. RETIRE — dispose the old handle; child surface/catalog work is
 *    best-effort and the committed child always stands
 * ```
 *
 * The DSH SessionWriteLease (kernel flock) is the ONLY cross-process writer
 * authority, so the transaction performs no TUI-side lock bookkeeping: the
 * TUI's physical owner.lock / lease / cooling / PINNED stack is removed
 * legacy. `isDurablePublished` and the publication taxonomy are GONE: a
 * post-DSH rejection is never unlocked, never retried, never fallen back —
 * the old session simply stays current.
 * @module @xmoon76/dsh-pi-tui/transition
 */

import { safeErrorMessage } from './error-boundary.ts'

/** The settled outcome of a transition. */
export type TransitionOutcome<T> = { ok: true; next: T } | { ok: false; message: string }

/** The caller-owned transition steps. */
export interface TransitionSteps<T> {
  /** The child's PRE-GENERATED session identity (mandatory). */
  target: { id: string; header?: { cwd?: string } }
  /** ALL TUI-owned preflight — runs BEFORE the DSH boundary. A throw
   * aborts with zero side effects. */
  prepare?: () => Promise<void> | void
  /** Create or resume the child. A rejection is NEVER retried: the old
   * session stays current and the caller may retry. */
  create: () => Promise<T>
}

/** The narrow host surface the orchestration drives. */
export interface TransitionHost<T> {
  /** Quiesce the OLD agent (`whenIdle`) and run its FINAL flush. A throw
   * aborts with zero child side effects. */
  quiesceOld(): Promise<void>
  /** Synchronous COMMIT: generation bump, live replacement. */
  commit(next: T): void
  /** Async teardown AFTER the commit: dispose the OLD handle, then the
   * child surface/catalog work. Every failure is recorded; the committed
   * child always stands. */
  retireOld(next: T): Promise<void>
  /** Record one phase failure (the host owns the diagnostics sink). */
  recordFailure(phase: string, error: unknown): void
}

/** Run one session transition in the canonical order. Must be called inside
 * the session-transition gate by the caller (the single-writer rule). */
export async function runTransitionTo<T>(
  host: TransitionHost<T>,
  steps: TransitionSteps<T>,
): Promise<TransitionOutcome<T>> {
  // Phase 1 — quiesce + final flush of the old session. Failing here aborts
  // with ZERO child side effects (the old session stays live).
  try {
    await host.quiesceOld()
  } catch (error) {
    host.recordFailure('quiesce', error)
    return { ok: false, message: `transition failed: ${safeErrorMessage(error)}` }
  }
  // Phase 2 — ALL TUI-owned preflight, BEFORE the DSH boundary: a failure
  // aborts with zero side effects.
  if (steps.prepare !== undefined) {
    try {
      await steps.prepare()
    } catch (error) {
      host.recordFailure('prepare', error)
      return { ok: false, message: `transition failed: ${safeErrorMessage(error)}` }
    }
  }
  // Phase 3 — create/resume. A rejection is NEVER retried (no same-ID
  // recovery): the old session stays current and the caller may retry.
  let next: T
  try {
    next = await steps.create()
  } catch (error) {
    host.recordFailure('create', error)
    return { ok: false, message: `transition failed: ${safeErrorMessage(error)}` }
  }
  // Phase 4 — COMMIT: a synchronous critical section, no awaits.
  host.commit(next)
  // Phase 5 — RETIRE: dispose the old handle; the child surface/catalog
  // work is best-effort.
  try {
    await host.retireOld(next)
  } catch (error) {
    host.recordFailure('retire', error)
  }
  return { ok: true, next }
}
