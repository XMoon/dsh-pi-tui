/**
 * The session-transition orchestration: ONE ordering for every path that
 * changes which session owns the surface (/new, /fork, conversation rewind,
 * `/sessions` switch/resume). The phase order is the whole point — it is
 * fixed here so the contract is unit-testable without the runner, and the
 * runner's `transitionTo` is a thin host adapter over it.
 *
 * Ordered invariants (each one was a review finding):
 *
 *   1. QUIESCE OLD — `whenIdle()` then the FINAL flush, with the old
 *      session's open lock still held. `AgentHandle.dispose()` is an async
 *      quiescence (`machine.cancel → whenIdle → scope.dispose`), and a
 *      cancelled RUNNING turn appends its closure events (interrupted
 *      assistant/message, step/end, turn/end) in `finally` blocks. If the
 *      old lock were released before the old agent was idle, another dsh
 *      process could resume the old session while those closures were
 *      still being appended — the exact two-writers/seq-collision the
 *      lock exists to prevent. Old-idle-then-flush closes the window:
 *      after quiescence the old session can no longer produce turn events.
 *      May fail → abort with ZERO child side effects.
 *   2. PREPARE — caller-owned gates (rewind's stale-identity check, the
 *      switch lock pre-check). May fail → abort.
 *   3. CREATE the child — may fail → abort; once it SUCCEEDS the child is
 *      published (session/created → persistence may already write its
 *      seed) and there is NO failure path after this point that may be
 *      interpreted as "the child never happened": `dispose()` stops an
 *      agent but never deletes a persisted session, and dsh has no
 *      durable rollback API.
 *   4. COMMIT — a synchronous critical section: OLD-lock release (the
 *      target lock was acquired in phase 2 and stays held), guard reset,
 *      generation bump, live handle/agent replacement — no awaits between
 *      its steps.
 *   5. RETIRE — old-handle dispose (now idle: no abort closures), child
 *      whenIdle, surface rebuild, catalog refresh. Failures are recorded
 *      by the host and NEVER roll the committed child back.
 *
 * @module @xmoon76/dsh-pi-tui/transition
 */

import { safeErrorMessage } from './error-boundary.ts'

/** The caller-owned transition steps (the runner supplies the shared host). */
export interface TransitionSteps<T> {
  /**
   * The child's PRE-GENERATED session identity — MANDATORY. The
   * transition acquires its open lock BEFORE the create — while the old
   * lock is still held — so every fallible ownership operation happens
   * before the durable child is published (review round 6: /new, /fork and
   * rewind used to create the child first and acquire its lock only in the
   * COMMIT, leaving a window where another process could grab the
   * published child's lock and both processes would hold one session).
   * A refusal aborts with ZERO child side effects; a later prepare/create
   * failure releases the target lock and the old session stays live with
   * its own lock.
   */
  target: { id: string; header?: { cwd?: string } }
  /** Whether the target is a FRESH session (not yet materialized): when
   * true, the target lock MUST settle as `acquired` — an `unavailable`
   * result means the child would be published without its lock (review
   * round 7), so the transaction aborts. An existing target may proceed
   * without a lock (the divergence guard is the backstop). */
  fresh?: boolean
  /** Runs after the old-session quiesce+flush and the target-lock acquire,
   * before the create. A throw aborts the transaction (the target lock is
   * released); the caller is responsible for undoing anything else it did
   * here (e.g. switchSession's own pre-checks). */
  prepare?: () => Promise<void> | void
  /** Create or resume the child. A throw may be a PRE-publication failure
   * (the child was never durable — the target lock is released and the
   * old session stays) OR a POST-publication failure (DSH's `session/
   * created` already fired and the seed is durable — review round 8): when
   * {@link TransitionHost.isDurablePublished} reports the child durable,
   * `recover` is invoked with the target lock STILL HELD to resume the
   * published child; a successful recovery commits it as the transition
   * result (it can no longer be treated as "never happened"). */
  create: () => Promise<T>
  /** Resume a child whose publication crossed the durable boundary but
   * whose `create` rejected (the agent was rolled back by DSH; the session
   * artifact survives). Runs with the target lock held. A throw keeps the
   * target lock and reports the child as published-but-unrecoverable. */
  recover?: () => Promise<T>
}

/** The settled outcome of a transition. */
export type TransitionOutcome<T> = { ok: true; next: T } | { ok: false; message: string }

/** A child that crossed the durable publication boundary but whose create
 * rejected AND could not be recovered: the session exists on disk and
 * stays locked. This is NOT a pre-publication failure — callers must
 * abort, never fall back to a second fresh session (review round 17). */
export class DurablePublishedUnrecoverableError extends Error {
  constructor(sessionId: string, detail: string) {
    super(`session ${sessionId} was durable-published but could not be recovered (${detail}); it exists and stays locked`)
    this.name = 'DurablePublishedUnrecoverableError'
  }
}

/** One open-lock acquisition's state (the host's acquire surface).
 * `unavailable` and `refused` are DISTINCT: an EXISTING target may proceed
 * without a lock (the divergence guard is the write-path backstop), but a
 * FRESH target's target-lock-before-create transaction must see
 * `acquired` — anything else means the child would be published without
 * its lock (review round 7: the old `string | undefined` return conflated
 * "locked" with "cannot lock", so a fresh pre-acquire silently degenerated
 * to publish-before-lock via no-lock-dir). */
export type OpenLockResult =
  | { kind: 'acquired' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'refused'; message: string }

/** The narrow host surface the orchestration drives. */
export interface TransitionHost<T> {
  /** Quiesce the OLD agent (`whenIdle`) and run its FINAL flush — with the
   * old session's open lock still held. A throw aborts with zero child
   * side effects. A no-op when there is no live agent. */
  quiesceOld(): Promise<void>
  /** Acquire the TARGET's open lock BEFORE the child is created (the old
   * lock is still held — the multi-slot holder; a FRESH target's artifact
   * directory is pre-created by the host so the lock can physically exist
   * before the session log does). Never throws. */
  acquireTargetLock(target: { id: string; header?: { cwd?: string } }): OpenLockResult
  /** Release one open lock (idempotent) — the failure paths release the
   * target lock here; the COMMIT releases the old lock. */
  releaseLock(sessionId: string): void
  /** Synchronous lock handover: release the OLD session's lock. The TARGET
   * lock was already acquired and verified in phase 2 (before the create)
   * and stays held — there is deliberately no re-acquire here. */
  handoverLocks(next: T): void
  /** Synchronous commit: guard reset, generation bump, live replacement. */
  commit(next: T): void
  /** Async teardown AFTER the commit: old-handle dispose, child whenIdle,
   * surface rebuild, catalog refresh. Never throws — every failure is
   * recorded by the host and the committed child stands. */
  retire(next: T): Promise<void>
  /** Whether one session already has a DURABLE artifact (materialized in
   * the persistence backend). The host checks this after a rejected
   * `create`: DSH's `agents.create()` publication can reject AFTER
   * `session/created` fired (a later synchronous listener threw; the
   * rollback disposes the agent but never deletes the durable artifact —
   * review round 8), so a rejection does NOT imply the child was never
   * published. Never throws. */
  isDurablePublished(sessionId: string): Promise<boolean>
  /** Record one phase failure (the host owns the diagnostics sink). */
  recordFailure(phase: string, error: unknown): void
}

/** The create-with-publication-recovery helper shared by the standalone
 * fresh-creation paths (ensureSession's createWithLock and the --session
 * resume fallback, which do not run inside runTransitionTo): a rejected
 * create may still have PUBLISHED (review round 8) — when the session is
 * durable, `resume` runs (the caller holds the target lock) and its
 * handle is returned; an unrecoverable published child throws
 * {@link DurablePublishedUnrecoverableError} with the lock STILL HELD,
 * so the caller can never fall back past it (review round 17). A
 * pre-publication failure releases the target lock and rethrows. */
export async function createWithPublicationRecovery<T>(deps: {
  /** The fresh session id (for diagnostics). */
  targetId: string
  /** Create the child (may reject before OR after publication). */
  create(): Promise<T>
  /** Resume the child after a post-publication rejection (lock held). */
  resume(): Promise<T>
  /** Whether the child is already durable (persistence list). */
  isDurablePublished(): Promise<boolean>
  /** Release the target lock on a PRE-publication failure only. */
  releaseTargetLock(): void
}): Promise<T> {
  try {
    return await deps.create()
  } catch (error) {
    if (await deps.isDurablePublished()) {
      try {
        return await deps.resume()
      } catch (recoverError) {
        // The child exists and stays locked: never a fallback trigger.
        throw new DurablePublishedUnrecoverableError(deps.targetId, safeErrorMessage(recoverError))
      }
    }
    deps.releaseTargetLock()
    throw error
  }
}

/** Run one session transition in the canonical order. Must be called inside
 * the session-transition gate by the caller (the single-writer rule). */
export async function runTransitionTo<T>(
  host: TransitionHost<T>,
  steps: TransitionSteps<T>,
): Promise<TransitionOutcome<T>> {
  // Phase 1 — quiesce + final flush of the old session. Failing here aborts
  // with ZERO child side effects (the old session stays live and locked).
  try {
    await host.quiesceOld()
  } catch (error) {
    host.recordFailure('quiesce', error)
    return { ok: false, message: `transition failed: ${safeErrorMessage(error)}` }
  }
  // Phase 2 — the TARGET lock, BEFORE the create (the old lock is still
  // held). Every fallible ownership operation happens before the durable
  // child is published: a refusal aborts with zero child side effects, and
  // a FRESH target treats an unavailable lock as a failure too — the
  // child must never be published without its lock (review round 7).
  const lock = host.acquireTargetLock(steps.target)
  if (lock.kind === 'refused') {
    host.recordFailure('target-lock', new Error(lock.message))
    return { ok: false, message: `transition failed: ${lock.message}` }
  }
  if (lock.kind === 'unavailable' && steps.fresh === true) {
    const reason = `cannot lock the fresh session before creating it (${lock.reason})`
    host.recordFailure('target-lock', new Error(reason))
    return { ok: false, message: `transition failed: ${reason}` }
  }
  // Phase 3 — caller-owned preparation. Failures abort before anything is
  // published; the target lock (if acquired) is released.
  if (steps.prepare !== undefined) {
    try {
      await steps.prepare()
    } catch (error) {
      host.releaseLock(steps.target.id)
      host.recordFailure('prepare', error)
      return { ok: false, message: `transition failed: ${safeErrorMessage(error)}` }
    }
  }
  // Phase 4 — create the child. A PRE-publication failure (the child was
  // never durable) releases the target lock and leaves the old session
  // untouched. A POST-publication failure is different: DSH's publication
  // can reject AFTER session/created fired (a later synchronous listener
  // threw; the rollback disposes the agent but never deletes the durable
  // artifact), so a rejection does NOT imply "never published". When the
  // child is durable, `recover` resumes it WITH THE TARGET LOCK STILL HELD
  // and the recovered child commits as the transition result — the third
  // state (UI says failed, disk has a child) is never allowed.
  let next: T
  try {
    next = await steps.create()
  } catch (error) {
    if (steps.recover !== undefined && await host.isDurablePublished(steps.target.id)) {
      try {
        next = await steps.recover()
      } catch (recoverError) {
        // Published but unrecoverable: keep the target lock (the session
        // exists on disk and must not silently become openable as a ghost
        // without its owner knowing) and report the explicit state.
        host.recordFailure('create', new Error(`${safeErrorMessage(error)}; the child was durable-published but could not be recovered (${safeErrorMessage(recoverError)})`))
        return {
          ok: false,
          message: `transition failed: the child session ${steps.target.id} was durable-published but could not be recovered (${safeErrorMessage(recoverError)}); it exists and stays locked`,
        }
      }
    } else {
      host.releaseLock(steps.target.id)
      host.recordFailure('create', error)
      return { ok: false, message: `transition failed: ${safeErrorMessage(error)}` }
    }
  }
  // Phase 5 — COMMIT: a synchronous critical section, no awaits.
  host.handoverLocks(next)
  host.commit(next)
  // Phase 6 — RETIRE: best-effort teardown; failures are recorded and the
  // committed child always stands.
  try {
    await host.retire(next)
  } catch (error) {
    host.recordFailure('retire', error)
  }
  return { ok: true, next }
}
