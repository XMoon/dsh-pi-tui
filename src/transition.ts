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
 *   4. COMMIT — a synchronous critical section: old-lock release, new-lock
 *      acquire, guard reset, generation bump, live handle/agent
 *      replacement — no awaits between its steps.
 *   5. RETIRE — old-handle dispose (now idle: no abort closures), child
 *      whenIdle, surface rebuild, catalog refresh. Failures are recorded
 *      by the host and NEVER roll the committed child back.
 *
 * @module @xmoon76/dsh-pi-tui/transition
 */

import { safeErrorMessage } from './error-boundary.ts'

/** The caller-owned transition steps (the runner supplies the shared host). */
export interface TransitionSteps<T> {
  /** Runs after the old-session quiesce+flush, before the create. A throw
   * aborts the transaction; the caller is responsible for undoing anything
   * it did here (e.g. switchSession re-takes the released from-lock). */
  prepare?: () => Promise<void> | void
  /** Create or resume the child. A throw aborts the transaction with no
   * child published. */
  create: () => Promise<T>
}

/** The settled outcome of a transition. */
export type TransitionOutcome<T> = { ok: true; next: T } | { ok: false; message: string }

/** The narrow host surface the orchestration drives. */
export interface TransitionHost<T> {
  /** Quiesce the OLD agent (`whenIdle`) and run its FINAL flush — with the
   * old session's open lock still held. A throw aborts with zero child
   * side effects. A no-op when there is no live agent. */
  quiesceOld(): Promise<void>
  /** Synchronous lock handover: release the old session's lock, acquire
   * the new one (a refusal is defensive-only and recorded, never fatal). */
  handoverLocks(next: T): void
  /** Synchronous commit: guard reset, generation bump, live replacement. */
  commit(next: T): void
  /** Async teardown AFTER the commit: old-handle dispose, child whenIdle,
   * surface rebuild, catalog refresh. Never throws — every failure is
   * recorded by the host and the committed child stands. */
  retire(next: T): Promise<void>
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
  try {
    await host.quiesceOld()
  } catch (error) {
    host.recordFailure('quiesce', error)
    return { ok: false, message: `transition failed: ${safeErrorMessage(error)}` }
  }
  // Phase 2 — caller-owned preparation. Failures abort before anything is
  // published (the caller is responsible for its own rollback).
  if (steps.prepare !== undefined) {
    try {
      await steps.prepare()
    } catch (error) {
      host.recordFailure('prepare', error)
      return { ok: false, message: `transition failed: ${safeErrorMessage(error)}` }
    }
  }
  // Phase 3 — create the child. From here on there is NO rollback.
  let next: T
  try {
    next = await steps.create()
  } catch (error) {
    host.recordFailure('create', error)
    return { ok: false, message: `transition failed: ${safeErrorMessage(error)}` }
  }
  // Phase 4 — COMMIT: a synchronous critical section, no awaits.
  host.handoverLocks(next)
  host.commit(next)
  // Phase 5 — RETIRE: best-effort teardown; failures are recorded and the
  // committed child always stands.
  try {
    await host.retire(next)
  } catch (error) {
    host.recordFailure('retire', error)
  }
  return { ok: true, next }
}
