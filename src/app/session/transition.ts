/**
 * The ordinary session-switch transaction — the canonical ordering shared by
 * /new and `/sessions` switch/resume:
 *
 * ```text
 * 0. user navigation only: after the barrier freeze, ONE exact-owner stop of
 *    the captured OLD generation, BEFORE the admitted-writer drain
 * 1. quiesce old (whenIdle + final flush)
 * 2. ALL TUI-owned preflight (preset/composition/stale checks — BEFORE the
 *    DSH boundary, so failures abort with ZERO side effects)
 * 3. create/resume — a rejection is NEVER retried (no same-ID recovery):
 *    the old session stays current and the user may retry
 * 4. COMMIT — a synchronous critical section (generation bump, live
 *    replacement)
 * 5. RETIRE — retire the old Direct owner (cancel → idle → drain
 *    continuable descendants → final flush → dispose); child surface/catalog
 *    work is best-effort and the committed child always stands
 * ```
 *
 * Phase 0 belongs to the transition ADMISSION (`SessionOperationBarrier`),
 * not to `runTransitionTo`: the stop must land before the writer drain, while
 * this module starts at the quiesce. A stop failure aborts before ANY phase
 * here runs.
 *
 * The DSH SessionWriteLease (kernel flock) is the ONLY cross-process writer
 * authority, so the transaction performs no TUI-side lock bookkeeping: the
 * TUI's physical owner.lock / lease / cooling / PINNED stack is removed
 * legacy. `isDurablePublished` and the publication taxonomy are GONE: a
 * post-DSH rejection is never unlocked, never retried, never fallen back —
 * the old session simply stays current.
 * @module @xmoon76/dsh-pi-tui/app/session/transition
 */

import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type { SessionScope } from './scope.ts'

/** The settled outcome of a transition. A failure carries the RAW abort so a
 *  caller can read a machine-readable cause (e.g. a `LifecycleError` with
 *  `ownership: "superseded"` or a published Session identity) instead of only
 *  a formatted message. */
export type TransitionOutcome<T> =
  | { ok: true; next: T }
  | { ok: false; message: string; error?: unknown }

/**
 * Why the one-shot navigation stop of the captured OLD owner did not settle
 * `committed`. ONLY `committed` is permission to enter the quiesce/create
 * phase; every settlement below aborts navigation before any child work.
 *
 * `stale` proves the captured owner/generation is no longer current (another
 * navigation already won) and the request never left the TUI; `rejected` is a
 * proven backend refusal; `cancelled` is the confirmed pre-dispatch family (the
 * exact Remote generation could not be addressed, or the runner is exiting) —
 * it says the cancel was NOT ADDRESSED, never that there is no old work to
 * stop; `indeterminate` is a dispatched call whose effect cannot be proven. The
 * old Turn may already have stopped only for `indeterminate`; nothing is ever
 * retried automatically.
 */
export interface NavigationStopFailure {
  readonly settlement: 'stale' | 'rejected' | 'cancelled' | 'indeterminate'
  /** The backend's own failure message (empty for `stale`). */
  readonly detail: string
}

/**
 * The user-navigation admission could not stop the old owner, so the
 * transition NEVER ran: no child was created and the old Session stays
 * current. A `stale` failure is a locally SUPERSEDED navigation (the surface
 * already moved) and settles silently; the other settlements are reported.
 * `mayHaveStoppedOldTurn` is true only for `indeterminate` (dispatched,
 * unproven) — a `cancelled`/`rejected` stop proves the cancel did not produce a
 * proven stop, not that the old Turn may have stopped.
 */
export class SessionNavigationStopError extends Error {
  readonly settlement: NavigationStopFailure['settlement']
  readonly mayHaveStoppedOldTurn: boolean

  constructor(failure: NavigationStopFailure) {
    super(failure.settlement === 'indeterminate'
      ? `stopping the current turn has an unconfirmed result (${failure.detail}); the current turn may already have stopped`
      : failure.settlement === 'stale'
        ? 'the session changed before this navigation could start'
        : failure.settlement === 'cancelled'
          ? 'the current turn could not be stopped (the cancel did not produce a proven stop); the old turn has not been proven stopped'
          : `the current turn could not be stopped (${failure.detail})`)
    this.name = 'SessionNavigationStopError'
    this.settlement = failure.settlement
    this.mayHaveStoppedOldTurn = failure.settlement === 'indeterminate'
  }
}

/** What one user-navigation admission established BEFORE its body ran. */
export interface NavigationAdmission {
  /**
   * The one-shot stop of the captured OLD owner was ACCEPTED by the backend.
   * Every later failure must state that the old Turn is already stopped
   * (cancellation is never rolled back); `false` means nothing was dispatched
   * (a sessionless surface, or a provable pre-dispatch cancellation), so the
   * failure must not imply a Turn was stopped.
   */
  readonly oldOwnerStopped: boolean
}

/**
 * One caller-owned USER NAVIGATION intent. The scope is captured by the caller
 * SYNCHRONOUSLY before its first await (never re-captured after waiting in a
 * queue); the runtime writes `admission` exactly once, from inside the frozen
 * transition admission and BEFORE the transition body runs. The command owner
 * therefore reads a fact about ITS OWN intent, not a re-derived current state.
 */
export interface NavigationIntent {
  /** The Session generation this intent is leaving. */
  readonly scope: SessionScope
  /** Filled once by the transition admission, before the body runs. */
  readonly admission: { oldOwnerStopped: boolean }
}

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
    return { ok: false, message: `transition failed: ${safeErrorMessage(error)}`, error }
  }
  // Phase 2 — ALL TUI-owned preflight, BEFORE the DSH boundary: a failure
  // aborts with zero side effects.
  if (steps.prepare !== undefined) {
    try {
      await steps.prepare()
    } catch (error) {
      host.recordFailure('prepare', error)
      return { ok: false, message: `transition failed: ${safeErrorMessage(error)}`, error }
    }
  }
  // Phase 3 — create/resume. A rejection is NEVER retried (no same-ID
  // recovery): the old session stays current and the caller may retry.
  let next: T
  try {
    next = await steps.create()
  } catch (error) {
    host.recordFailure('create', error)
    return { ok: false, message: `transition failed: ${safeErrorMessage(error)}`, error }
  }
  // Phase 4 — COMMIT: a synchronous critical section, no awaits.
  host.commit(next)
  // Phase 5 — RETIRE: retire the old Direct owner (the host adapter runs
  // cancel → idle → drain descendants → final flush → dispose); the child
  // surface/catalog work is best-effort.
  try {
    await host.retireOld(next)
  } catch (error) {
    host.recordFailure('retire', error)
  }
  return { ok: true, next }
}
