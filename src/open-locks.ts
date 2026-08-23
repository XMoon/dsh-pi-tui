/**
 * The multi-slot open-lock holder: this process may legitimately hold the
 * open lock of MORE THAN ONE session at a time — during a session
 * transition the OLD session keeps its lock while the TARGET's lock is
 * acquired (review round 5: releasing the old lock first opened a vacuum
 * window where another process could grab the old session while the
 * switch was still failing; a failed re-acquire then left the current
 * session live WITHOUT its lock — two processes holding one session, the
 * exact corruption the lock exists to prevent).
 *
 * With the multi-slot holder the handoff order becomes: old stays locked
 * → target acquired (non-blocking refusal — never a wait, so two
 * processes switching in opposite directions both refuse and keep their
 * own locks) → commit → old released. A failed switch never drops the old
 * lock in the first place, so there is nothing to re-acquire.
 *
 * All operations are idempotent; `releaseAll` covers the exit path.
 * @module @xmoon76/dsh-pi-tui/open-locks
 */

/** The process-local open-lock registry (sessionId → release callback). */
export class OpenLockHolder {
  private readonly locks = new Map<string, () => void>()

  /** Whether this process currently holds the lock for one session. */
  has(sessionId: string): boolean {
    return this.locks.has(sessionId)
  }

  /** How many sessions this process currently holds (diagnostics). */
  get size(): number {
    return this.locks.size
  }

  /**
   * Record one acquired lock. Idempotent per session: a second `add` for a
   * session this process already holds is a no-op (the caller keeps the
   * FIRST release — the commit's re-acquire of a pre-acquired target hits
   * this).
   * @returns true when the lock was newly recorded, false when this
   *   process already held it.
   */
  add(sessionId: string, release: () => void): boolean {
    if (this.locks.has(sessionId)) return false
    this.locks.set(sessionId, release)
    return true
  }

  /** Release and forget one lock (idempotent; unknown ids are no-ops). */
  release(sessionId: string): void {
    const release = this.locks.get(sessionId)
    if (release === undefined) return
    this.locks.delete(sessionId)
    release()
  }

  /** Release EVERY lock this process holds (clean exit / teardown). */
  releaseAll(): void {
    for (const release of this.locks.values()) release()
    this.locks.clear()
  }
}
