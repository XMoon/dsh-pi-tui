/**
 * The TUI-writer / transition mutual exclusion barrier.
 *
 * The old `transitionGate.busy` check only refuses writers that START after
 * a transition began. It cannot stop a writer that started BEFORE the
 * transition and is still awaiting a provider/IO when the transition
 * quiesces and switches — that late completion would append to a session
 * the transition is retiring (the old agent is being disposed and the
 * surface has moved).
 *
 * This barrier gives every TUI-owned session writer a `runWriter` section
 * and every transition a `runTransition` section:
 *
 * ```text
 * normal writer:  frozen ? refuse : writers++, run the WHOLE async
 *                 operation, writers-- (finally)
 * transition:     frozen = true, wait writers == 0, run the whole
 *                 transition, frozen = false
 * control:        run NOW, with no writer count and no wait (the caller
 *                 owns the exact-owner/currentness fence)
 * ```
 *
 * A transition therefore waits for in-flight TUI writers to drain BEFORE
 * it quiesces the old agent, and no new writer can enter while it runs.
 * The old FIFO gate (SessionTransitionGate) remains for the single-writer
 * transition rule; correctness no longer rests on a `busy` flag.
 *
 * CONTROL is the ONE exception: a user Stop gesture (Busy Esc / extension
 * `cancel-activity`) and the Task-Center subagent Stop must still reach
 * their EXACT captured owner while a navigation transition holds the
 * barrier. They are not session writes: they never increment `writers`,
 * never wait for the transition, and never release an ordinary writer.
 * The session runtime owns their scope/owner fence; this hook only owns
 * the documented admission, so no ordinary business write can use it as
 * a bypass.
 *
 * A user NAVIGATION (`/new`, a selected-session switch) additionally stops
 * the owner it is about to replace. That stop must land after the freeze but
 * BEFORE the drain, because the drain can be held open by a writer the old
 * owner is still executing; `runTransition`'s optional `stopOldOwner` hook is
 * that one seam. It is not a writer admission either: ordinary writes stay
 * refused while the transition is frozen.
 * @module @xmoon76/dsh-pi-tui/app/session/operation-barrier
 */

/** Thrown by `runWriter` while a transition is frozen: the caller refuses
 *  the write (restores the draft / keeps the shell card) and notifies. */
export class TransitionInProgressError extends Error {
  constructor() {
    super('a session transition is in progress')
    this.name = 'TransitionInProgressError'
  }
}

/** The writer/transition barrier (one instance per runner mount). */
export class SessionOperationBarrier {
  private frozen = false
  private writers = 0
  private readonly wait: Array<() => void> = []

  /** Whether a transition currently holds the barrier (UX quick refusal). */
  get inTransition(): boolean {
    return this.frozen
  }

  /** How many TUI writers are currently inside `runWriter` (diagnostics). */
  get activeWriters(): number {
    return this.writers
  }

  /**
   * Run one TUI-owned session write. Refuses (throws
   * {@link TransitionInProgressError}) while a transition holds the
   * barrier. The WHOLE async operation runs inside the section, so a
   * transition started after this writer began waits for it to drain.
   */
  async runWriter<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    if (this.frozen) throw new TransitionInProgressError()
    this.writers += 1
    try {
      return await fn()
    } finally {
      this.writers -= 1
      if (this.writers === 0 && this.wait.length > 0) {
        const pending = this.wait.splice(0)
        for (const resolve of pending) resolve()
      }
    }
  }

  /**
   * Run one CONTROL operation — a user interrupt of the captured owner or a
   * selected subagent Stop — while a transition may hold the barrier.
   *
   * A control section is deliberately NOT a writer admission: it never
   * increments `writers`, never waits for the transition to drain, and never
   * unfreezes/releases an ordinary writer. The caller owns the exact captured
   * owner/scope fence and the typed settlement; only the session runtime's
   * control entries (`withControl` / `interrupt`) and the Task-Center Stop
   * use this hook. Ordinary prompts, steer/queue edits, Host commands,
   * `/preset`, `/model` and shutdown keep `runWriter` / `runTransition`.
   */
  async runControl<T>(fn: () => Promise<T> | T): Promise<T> {
    return await fn()
  }

  /**
   * Run a whole session transition exclusively: freezes new writers,
   * waits for in-flight writers to drain, runs the transition, then
   * unfreezes. Reentrant transitions are a bug and are refused loudly.
   *
   * `stopOldOwner` is the NARROW user-navigation seam (a fresh Session or a
   * selected-session switch), never a general hook: when supplied it runs
   * EXACTLY ONCE, after the freeze and BEFORE the admitted-writer drain, and
   * a throw aborts the transition with ZERO body side effects (the barrier
   * unfreezes and the caller reports the precise failure). The drain must not
   * come first: an admitted writer (e.g. a slow Host command) can keep the
   * old Turn's owner busy, and a navigation that waited for it before
   * stopping the old Turn would reintroduce the wait this seam exists to
   * remove. The callback owns the exact-owner/currentness fence; the barrier
   * only owns the documented order.
   */
  async runTransition<T>(fn: () => Promise<T>, stopOldOwner?: () => Promise<void>): Promise<T> {
    if (this.frozen) {
      throw new Error('BUG: reentrant session transition')
    }
    this.frozen = true
    try {
      if (stopOldOwner !== undefined) await stopOldOwner()
      while (this.writers > 0) {
        await new Promise<void>(resolve => this.wait.push(resolve))
      }
      return await fn()
    } finally {
      this.frozen = false
      if (this.wait.length > 0) {
        const pending = this.wait.splice(0)
        for (const resolve of pending) resolve()
      }
    }
  }
}
