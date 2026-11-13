/**
 * H1: the ONE official-Connection-generation lifecycle of the Remote main-Agent
 * terminal-progress watch.
 *
 * A valid generation owns exactly one watch. A generation change (valid ->
 * `undefined`, `undefined` -> new valid, or valid -> new valid) invalidates
 * the Host progress identity: the old watch is stopped and the Pane
 * qualification is released BEFORE anything else, so an extended outage can
 * never keep a stale `working`/`blocked` registration. Only the next watch's
 * opening Host snapshot may requalify the Pane.
 *
 * The first arm may itself observe `undefined` (the transport was lost between
 * hydrate and mount). In that case the SAME official listener stays armed and
 * creates the first watch when the next real generation arrives — no timer, no
 * poll and no second running/status authority.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/remote-progress-watch
 */

/** The narrow faces the lifecycle borrows from the composition root. */
export interface RemoteProgressWatchGenerationDeps {
  readonly isCleanedUp: () => boolean
  readonly currentSessionId: () => string | undefined
  readonly ownerGeneration: () => number
  /** The owner attempt this lifecycle belongs to. */
  readonly sessionId: string
  readonly ownerGenerationAtInit: number
  readonly connectionGeneration: () => unknown
  readonly subscribeConnectionGeneration: (listener: () => void) => () => void
  /** Invalidate the external Pane qualification (ordered release). */
  readonly release: () => void
  /** Stop the current watch, if any. */
  readonly disposeWatch: () => void
  /** Start exactly ONE watch pinned to the observed generation. */
  readonly startWatch: (generation: unknown) => void
}

/** The armed lifecycle; `dispose` releases the official subscription. */
export interface RemoteProgressWatchGeneration {
  dispose(): void
}

/**
 * Arm the ONE generation lifecycle of this owner attempt. `observeCurrent`
 * must be called once after construction so a generation that is already valid
 * starts the first watch, while an `undefined` one keeps the listener armed.
 */
export function armRemoteProgressWatchGeneration(
  deps: RemoteProgressWatchGenerationDeps,
): RemoteProgressWatchGeneration & { observeCurrent(): void } {
  let observed: unknown
  let observedKnown = false
  let disposed = false

  const onGeneration = (): void => {
    if (disposed) return
    const now = deps.connectionGeneration()
    if (observedKnown && Object.is(now, observed)) return
    const firstObservation = !observedKnown
    observed = now
    observedKnown = true
    if (deps.isCleanedUp()
      || deps.currentSessionId() !== deps.sessionId
      || deps.ownerGeneration() !== deps.ownerGenerationAtInit) return
    // A real identity CHANGE releases first: a stale working/blocked must not
    // survive the outage, and a reconnect must never look idle. The very first
    // observation has no earlier registration to withdraw.
    if (!firstObservation) {
      deps.release()
      deps.disposeWatch()
    }
    if (now !== undefined) deps.startWatch(now)
  }

  const unsubscribe = deps.subscribeConnectionGeneration(onGeneration)
  return {
    observeCurrent: onGeneration,
    dispose: () => {
      if (disposed) return
      disposed = true
      unsubscribe()
    },
  }
}
