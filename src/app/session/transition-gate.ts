/**
 * The process-local session-transition gate: ONE writer for the live
 * session at a time.
 *
 * Every ordinary path that changes which session owns the surface — /new,
 * `/sessions` switch/resume, and first-session creation — must run its whole
 * workflow (quiesce old → preflight → create/resume → COMMIT (assign new +
 * generation bump) → retire old) inside {@link SessionTransitionGate.run}.
 * Host fork dispatch runs outside this FIFO; only adoption of a returned Direct
 * child enters the gate. Without this gate, two interleaved transitions can:
 *
 * - create a child whose metadata mixes two surfaces (parent captured
 *   before an await, cwd read after a concurrent switch — the P2 "cwd
 *   race");
 * - publish an ordinary child (session/created → persistence starts writing
 *   its seed) and then detect a stale surface only AFTER the create, leaving
 *   two live Direct surfaces with no serialized adoption/retirement order;
 * - pass a stale identity check and then yield inside the swap (flush /
 *   old-owner retirement), letting a second transition land in between and
 *   later get overwritten by the first continuation.
 *
 * The gate is a promise chain (a single-writer queue): tasks run strictly
 * one at a time in FIFO order, a rejected task never blocks the next one,
 * and a task that re-enters the gate (calls `run` from inside its own
 * async continuation) is refused loudly via AsyncLocalStorage — re-entry
 * would deadlock the queue.
 * @module @xmoon76/dsh-pi-tui/app/session/transition-gate
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
  private queued = 0
  /**
   * Accepted navigation intents that have not entered the FIFO yet: a user
   * navigation whose PRE-GATE preflight (the `/new` Workspace resolution) is
   * still awaiting Host IO. They do not occupy a FIFO slot and do not freeze
   * the barrier — a refused preflight must leave the old owner untouched —
   * but they keep {@link pending} true (and {@link whenSettled} waiting) so a
   * concurrent submission never decides the surface state from the
   * not-yet-replaced owner. Released by the intent owner at its terminal
   * settlement.
   */
  private readonly intents = new Set<Promise<void>>()

  /** Whether a transition task is currently executing (visible to every
   * caller — the AsyncLocalStorage context is task-internal only). */
  get busy(): boolean {
    return this.active
  }

  /** Whether a transition task is QUEUED or executing, or an accepted
   * navigation intent is still in its pre-gate preflight. The exit retirement
   * pre-cancel keys on this, not on `busy`: a queued-but-not-started
   * transition is about to quiesce the old agent, whose `whenIdle()` does
   * not observe the lifecycle signal — the pre-cancel must fire before the
   * task starts, or the retirement queued behind it can never unblock it.
   * An intent counts for the same reason: the navigation has been accepted
   * and will either enter the FIFO or leave the surface untouched. */
  get pending(): boolean {
    return this.queued > 0 || this.intents.size > 0
  }

  /**
   * Register one accepted navigation intent BEFORE its pre-gate preflight
   * (the `/new` Workspace resolution) so `pending`/`whenSettled` cover the
   * whole accepted navigation, not only the gated part. The returned release
   * is idempotent and must be called at the intent owner's terminal
   * settlement (success, refusal or failure).
   *
   * An intent deliberately does NOT occupy the FIFO and does NOT touch the
   * barrier: the workspace pre-selection must be able to refuse without
   * stopping the old owner, and a transition queued behind an intent still
   * runs in order. It only widens the PENDING observation window.
   */
  beginIntent(): () => void {
    let release!: () => void
    const settled = new Promise<void>(resolve => { release = resolve })
    this.intents.add(settled)
    let released = false
    return () => {
      if (released) return
      released = true
      this.intents.delete(settled)
      release()
    }
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
    this.queued += 1
    const start = this.tail.then(() => transitionContext.run(true, () => {
      this.active = true
      return task()
    }))
    // The queue advances regardless of the task's outcome; the caller still
    // receives the task's own rejection. `active` clears exactly when the
    // task's continuation finishes — before the next queued task starts —
    // so `busy` is true for the whole exclusive section.
    this.tail = start.then(
      () => { this.active = false; this.queued -= 1 },
      () => { this.active = false; this.queued -= 1 },
    )
    return start
  }

  /**
   * Wait until the gate has no transition executing or queued AND no accepted
   * navigation intent is still in its pre-gate preflight.
   *
   * A reader that observed a TRANSIENT surface facts state (a create whose
   * Host Session exists but whose owner is not published yet, or an accepted
   * `/new` still resolving its Workspace) uses this to make its decision
   * against the settled surface instead. The wait is promise-based and
   * re-checks both sources, so a transition/intent added while this call waits
   * is included; a NEW one added after it settles is not (the same
   * best-effort boundary as any observation).
   *
   * Only callers OUTSIDE a transition task may await this: the task's own
   * `tail` has not settled, so waiting from inside would deadlock.
   */
  async whenSettled(): Promise<void> {
    // `queued` covers the executing task too (it is decremented only when
    // that task's tail continuation runs), and every queued task extends
    // `tail` before the next iteration re-reads the field. An intent releases
    // its own promise, so awaiting the CURRENT set re-checks both sources.
    while (this.queued > 0 || this.intents.size > 0) {
      await Promise.allSettled([this.tail, ...this.intents])
    }
  }
}
