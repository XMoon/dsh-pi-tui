/**
 * The session switch transaction — the canonical convergence-plan flow:
 *
 * ```text
 * 1. quiesce old (whenIdle + final flush, old lock held)
 * 2. ALL TUI-owned preflight (preset/composition/stale checks — BEFORE the
 *    DSH boundary, so failures abort with ZERO side effects)
 * 3. reserve the TARGET lease (physical owner lock; acquired is MANDATORY
 *    for fresh AND existing — held/unverifiable/unavailable fail closed)
 * 4. markTargetTouched — the DSH boundary: from here on NO business path
 *    may release the target lease; a failure PINNS it (the lease manager's
 *    releaseUntouched hard-assertion enforces this)
 * 5. create/resume — a rejection is NEVER retried (no same-ID recovery):
 *    the target is PINNED immediately (fail-closed) and the old session
 *    stays current
 * 6. COMMIT — a synchronous critical section (generation
 *    bump, live replacement) with NO lock changes
 * 7. RETIRE — dispose the old handle; the old lease enters COOLING
 *    (verification happens outside the transaction); child surface/catalog
 *    work is best-effort and the committed child always stands
 * ```
 *
 * The transaction deliberately does NOT decide when the OLD session may be
 * released cross-process — that is the lease manager / cooling coordinator's
 * job, and it runs after the switch. `isDurablePublished` and the
 * publication taxonomy are GONE: a post-DSH rejection is never unlocked,
 * never retried, never fallen back; it is PINNED (fail-closed). The old
 * same-ID recovery is GONE too: a rejected create/resume may have left a
 * hidden lifecycle inside this process (the first DSH call already crossed
 * the boundary), so retrying cannot clear that uncertainty — only the
 * process-lifetime PINNED quarantine (and the next opener's stale
 * takeover after exit) may.
 * @module @xmoon76/dsh-pi-tui/transition
 */

import { safeErrorMessage } from './error-boundary.ts'
import type { RetiredSessionSnapshot } from './session-lease-manager.ts'

/** The settled outcome of a transition. */
export type TransitionOutcome<T> = { ok: true; next: T } | { ok: false; message: string }

/** One open-lock acquisition's settled result (the host's acquire surface).
 *  `acquired` is the ONLY acceptable result for a transition target:
 *  `refused` (another process holds it), `unverifiable` and `unavailable`
 *  all fail closed. */
export type OpenLockResult =
  | { kind: 'acquired' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'refused'; message: string }

/** The caller-owned transition steps. */
export interface TransitionSteps<T> {
  /** The child's PRE-GENERATED session identity (mandatory). */
  target: { id: string; header?: { cwd?: string } }
  /** ALL TUI-owned preflight — runs BEFORE the target lease is taken and
   * before the DSH boundary. A throw aborts with zero side effects. */
  prepare?: () => Promise<void> | void
  /** Create or resume the child. A rejection is NEVER retried: the target
   * is PINNED immediately (the first DSH call may have left a hidden
   * lifecycle, so a same-ID retry cannot clear the uncertainty). */
  create: () => Promise<T>
}

/** The narrow host surface the orchestration drives. */
export interface TransitionHost<T> {
  /** Quiesce the OLD agent (`whenIdle`) and run its FINAL flush, with the
   * old session's open lock still held. Returns the FINAL pre-switch
   * snapshot (the cooling verifier compares the durable state against it)
   * or undefined when there was no live agent. A throw aborts with zero
   * child side effects. */
  quiesceOld(): Promise<RetiredSessionSnapshot | undefined>
  /** Reserve the TARGET's lease (physical acquire when this process does
   * not hold it). Never throws. */
  acquireTargetLease(target: { id: string; header?: { cwd?: string } }): OpenLockResult
  /** Release a lease that NEVER crossed the DSH boundary (the manager
   * throws on a touched lease — a business-path misuse). */
  releaseUntouchedTarget(sessionId: string): void
  /** The target is about to enter the DSH boundary (agents.create/resume):
   * from here on no business path may release it. */
  markTargetTouched(sessionId: string): void
  /** Synchronous COMMIT: generation bump, live replacement.
   * NO lock changes happen here. */
  commit(next: T): void
  /** Async teardown AFTER the commit: dispose the OLD handle, hand the old
   * session to the retirement/cooling lifecycle (the OLD lock is NOT
   * released here — the lease manager releases it only after verified
   * cooling), then the child surface/catalog work. Every failure is
   * recorded; the committed child always stands. */
  retireOld(next: T, oldSnapshot?: RetiredSessionSnapshot): Promise<void>
  /** Fail-closed: the target's lease stays with this process (physical
   * lock kept) until this process exits. */
  pinTarget(sessionId: string, reason: string): void
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
  // with ZERO child side effects (the old session stays live and locked).
  let oldSnapshot: RetiredSessionSnapshot | undefined
  try {
    oldSnapshot = await host.quiesceOld()
  } catch (error) {
    host.recordFailure('quiesce', error)
    return { ok: false, message: `transition failed: ${safeErrorMessage(error)}` }
  }
  // Phase 2 — ALL TUI-owned preflight, BEFORE the DSH boundary (the target
  // is not even locked yet): a failure aborts with zero side effects.
  if (steps.prepare !== undefined) {
    try {
      await steps.prepare()
    } catch (error) {
      host.recordFailure('prepare', error)
      return { ok: false, message: `transition failed: ${safeErrorMessage(error)}` }
    }
  }
  // Phase 3 — reserve the TARGET's physical lease (acquired is MANDATORY
  // for every writable target; the old lock is still held throughout).
  const lock = host.acquireTargetLease(steps.target)
  if (lock.kind !== 'acquired') {
    const reason = lock.kind === 'refused'
      ? lock.message
      : `cannot lock the session before the transition (${lock.reason})`
    host.recordFailure('target-lock', new Error(reason))
    return { ok: false, message: `transition failed: ${reason}` }
  }
  // Phase 4 — the DSH boundary: the target is touched. From here on NO
  // failure path may release the lease; a rejection is NEVER retried (the
  // first DSH call may have left a hidden lifecycle) — the target is
  // PINNED immediately and the old session stays current (fail-closed).
  host.markTargetTouched(steps.target.id)
  let next: T
  try {
    next = await steps.create()
  } catch (error) {
    host.pinTarget(steps.target.id, `DSH create/resume failed: ${safeErrorMessage(error)}`)
    host.recordFailure('create', error)
    return { ok: false, message: `transition failed: ${safeErrorMessage(error)}` }
  }
  // Phase 5 — COMMIT: a synchronous critical section, no awaits, NO lock
  // changes (the target lease stays; the old lease is released only by the
  // retirement lifecycle after verified cooling).
  host.commit(next)
  // Phase 6 — RETIRE: dispose the old handle and hand it to the retirement
  // lease; the child surface/catalog work is best-effort.
  try {
    await host.retireOld(next, oldSnapshot)
  } catch (error) {
    host.recordFailure('retire', error)
  }
  return { ok: true, next }
}
