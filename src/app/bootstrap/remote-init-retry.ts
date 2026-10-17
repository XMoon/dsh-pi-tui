/**
 * S3-R0: the ONE official-signal re-init of a Remote live surface whose cold
 * hydrate could not commit.
 *
 * The recovery belongs to the FAILED ATTEMPT — its session id AND the TUI owner
 * generation captured when that attempt started — because a same-id owner commit
 * keeps the session id while it bumps the owner generation. An old retry must
 * never run the live-surface init (whose entry disposes the current surface)
 * against the new owner, and it must never create a second publisher (plan §2.5
 * terminal determinism / single publisher).
 *
 * The wakeup source is the OFFICIAL Connection generation channel: the retry
 * fires once a generation exists again, never on a timer, and it disarms itself
 * on the first usable signal so a flapping transport cannot loop.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/remote-init-retry
 */

/** The narrow faces the retry borrows (the composition root owns them). */
export interface RemoteInitRetryDeps {
  readonly isCleanedUp: () => boolean
  readonly currentSessionId: () => string | undefined
  readonly ownerGeneration: () => number
  readonly connectionGeneration: () => unknown
  readonly subscribeConnectionGeneration: (listener: () => void) => () => void
  /** Re-run the whole live-surface init for the attempt's session. */
  readonly runInit: () => Promise<void>
  /** The repository's detached ownership wrapper (failure reporting). */
  readonly runDetached: (name: string, run: () => Promise<void>) => void
}

/** The armed retry: `dispose` cancels it (idempotent). */
export interface RemoteInitRetryHandle {
  dispose(): void
}

/**
 * Arm the official-generation retry for one failed attempt. Returns undefined
 * when the app is already cleaned up.
 */
export function armRemoteInitRetry(
  deps: RemoteInitRetryDeps,
  sessionId: string,
  failedAttemptGeneration: number,
): RemoteInitRetryHandle | undefined {
  if (deps.isCleanedUp()) return undefined
  let disposed = false
  let unsubscribe: () => void = () => {}
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    unsubscribe()
  }
  /** The attempt this retry serves is still the CURRENT owner (checked both at
   *  the signal and again in the detached task, in the same synchronous tick as
   *  the init entry). */
  const stillTheFailedAttempt = (): boolean =>
    !deps.isCleanedUp()
    && deps.currentSessionId() === sessionId
    && deps.ownerGeneration() === failedAttemptGeneration
  unsubscribe = deps.subscribeConnectionGeneration(() => {
    if (disposed) return
    if (deps.isCleanedUp()) { dispose(); return }
    // Still disconnected: keep waiting for the official generation.
    if (deps.connectionGeneration() === undefined) return
    // A newer owner (a same-id commit included) already owns the surface: this
    // retry is obsolete and must not touch it.
    if (!stillTheFailedAttempt()) { dispose(); return }
    dispose()
    deps.runDetached('remote live surface retry', async () => {
      // Same-tick fence: the owner may have moved between the signal and this
      // task; a same-id commit wins.
      if (!stillTheFailedAttempt()) return
      await deps.runInit()
    })
  })
  return { dispose }
}
