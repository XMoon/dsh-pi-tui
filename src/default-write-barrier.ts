/**
 * The sessionless `/model` global-default write barrier (D2.3).
 *
 * The Direct catalog adapter intentionally allows overlapping default writes:
 * an OLDER write can still be settling — and re-asserting the newest committed
 * value through its fenced correction — after a NEWER one resolved. A fresh
 * create must therefore wait for EVERY in-flight write, not just the newest,
 * before it reads the persisted Host default for Agent activation.
 *
 * Each tracked promise is the caller's settlement promise, which (for Direct)
 * already includes its own fenced correction. The barrier owns no Host state,
 * performs no I/O, and is pure enough to unit-test directly.
 * @module @xmoon76/dsh-pi-tui/default-write-barrier
 */

/** Tracks every in-flight default write and lets a caller await them all. */
export class DefaultWriteBarrier {
  private readonly active = new Set<Promise<unknown>>()

  /** Track one write. The entry removes itself on settle, so no detached bare
   *  promise is left behind (the `.then` IS the tracked entry). */
  track(write: Promise<unknown>): void {
    let tracked!: Promise<unknown>
    tracked = write.catch(() => undefined).then(() => { this.active.delete(tracked) })
    this.active.add(tracked)
  }

  /** Number of currently in-flight writes (test/diagnostic read). */
  get size(): number {
    return this.active.size
  }

  /**
   * Await every currently in-flight write, looping while a newer one starts.
   * Aborts as soon as `signal` aborts, so a hung write can never block a caller
   * past its lifetime.
   */
  async wait(signal?: AbortSignal): Promise<void> {
    for (;;) {
      // Check the lifetime signal BEFORE the empty early-return too: an
      // already-aborted caller must never proceed into create admission.
      signal?.throwIfAborted()
      const snapshot = [...this.active]
      if (snapshot.length === 0) return
      if (signal === undefined) {
        await Promise.all(snapshot)
      } else {
        const abort = abortRejection(signal)
        try {
          await Promise.race([Promise.all(snapshot), abort.promise])
        } finally {
          abort.dispose()
        }
      }
    }
  }
}

/** Reject as soon as the signal aborts; the listener is removed once the race
 *  settles so the helper can never reject unhandled after the write won. */
function abortRejection(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort: (() => void) | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('aborted while waiting for the model default write'))
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return {
    promise,
    dispose: () => { if (onAbort !== undefined) signal.removeEventListener('abort', onAbort) },
  }
}
