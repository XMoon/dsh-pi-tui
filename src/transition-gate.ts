/**
 * The process-local session-transition gate: ONE writer for the live
 * session at a time.
 *
 * Every path that changes which session owns the surface — /new, /fork,
 * conversation rewind, `/sessions` switch/resume, the first-session
 * creation — must run its whole workflow (prepare/create/resume → flush →
 * dispose old → assign new → generation bump) inside {@link
 * SessionTransitionGate.run}. Without it, two interleaved transitions can:
 *
 * - create a child whose metadata mixes two surfaces (parent captured
 *   before an await, cwd read after a concurrent switch — the P2 "cwd
 *   race");
 * - publish a forked child (session/created → persistence starts writing
 *   its seed) and then detect "stale" only AFTER the create, leaving a
 *   durable ghost branch the user never entered — `handle.dispose()` stops
 *   the agent but does NOT delete the persisted session;
 * - pass a stale identity check and then yield inside the swap (flush /
 *   old-handle dispose), letting a second transition land in between and
 *   later get overwritten by the first continuation.
 *
 * The gate is a promise chain (a single-writer queue): tasks run strictly
 * one at a time in FIFO order, a rejected task never blocks the next one,
 * and a task that re-enters the gate (calls `run` from inside its own
 * async continuation) is refused loudly via AsyncLocalStorage — re-entry
 * would deadlock the queue.
 * @module @xmoon76/dsh-pi-tui/transition-gate
 */

import { AsyncLocalStorage } from 'node:async_hooks'

const transitionContext = new AsyncLocalStorage<boolean>()

/**
 * The single-writer queue for session transitions. See the module doc for
 * why every live-session-mutating path must serialize through it.
 */
export class SessionTransitionGate {
  private tail: Promise<unknown> = Promise.resolve()
  private active = false

  /** Whether a transition task is currently executing (visible to every
   * caller — the AsyncLocalStorage context is task-internal only). */
  get busy(): boolean {
    return this.active
  }

  /**
   * Run one session-transition workflow exclusively. Tasks run strictly in
   * FIFO order; a rejected task propagates to its own caller and never
   * blocks the next queued task.
   * @param task - the transition workflow (create/resume → swap → restore).
   * @returns the task's result.
   * @throws when called from INSIDE another transition task (re-entry would
   *   deadlock the FIFO queue — detected via AsyncLocalStorage, which
   *   follows the caller's async chain).
   */
  run<T>(task: () => Promise<T> | T): Promise<T> {
    if (transitionContext.getStore() === true) {
      throw new Error('session transition re-entered while one is in flight')
    }
    const start = this.tail.then(() => transitionContext.run(true, () => {
      this.active = true
      return task()
    }))
    // The queue advances regardless of the task's outcome; the caller still
    // receives the task's own rejection. `active` clears exactly when the
    // task's continuation finishes — before the next queued task starts —
    // so `busy` is true for the whole exclusive section.
    this.tail = start.then(
      () => { this.active = false },
      () => { this.active = false },
    )
    return start
  }
}
