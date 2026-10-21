/**
 * The transport-teardown ownership shared by the Remote runner fixtures.
 *
 * The transport is disposed by the RUNNER FIBER's teardown effect
 * (`registerRunnerDisposal` → `disposeSelectedTransport`), so the fiber
 * disposal owns it. The fixture must not register a SECOND, unconditional
 * `selected.disposeTransport()`: it would reach the SAME idempotent disposer
 * again, and the "the transport disposes exactly once" assertions count the
 * downstream owner releases, so the extra call could only ever be noise on a
 * counter that is about the teardown.
 *
 * The FALLBACK is the safety net for the one case the fiber effect cannot
 * cover: the runner never mounted (the mount threw), so no teardown effect
 * exists and nothing else would release the transport. It disposes ONLY when
 * the transport disposer was never REACHED, so it can never add a second
 * call to a transport the runner already disposed — the production disposer
 * is idempotent, so a call after the first one tears nothing down again.
 *
 * A failed fallback is NOT swallowed: the test lifecycle
 * (`test/support/temp-lifecycle.ts`) collects the cleanup failures and
 * reports them, so a broken teardown is visible instead of leaving a
 * resource behind without a trace.
 *
 * @module @xmoon76/dsh-pi-tui/transport-teardown-ownership
 */

/** The transport teardown the fallback owns. */
export interface DisposableTransport {
  disposeTransport(): Promise<void>
}

/** The transport-teardown ownership a fixture installs. */
export interface TransportTeardownOwnership {
  /** The fallback, as the lifecycle cleanup runs it. */
  readonly runFallback: () => Promise<void>
  /**
   * Whether the transport disposer was REACHED.
   *
   * It is NOT "the transport was released": the flag is set when the disposer
   * is entered, so a disposer that then FAILS still leaves it set. That is
   * the right gate for the fallback, because the production disposer is
   * idempotent — once it was reached, a second call tears nothing down
   * again — but the name says exactly that, so it is not confused with the
   * completed releases the teardown observer counts.
   */
  readonly disposeTransportReached: () => boolean
}

/**
 * Install the transport ownership on the aggregate.
 *
 * The returned `runFallback` is what the lifecycle cleanup runs; it is
 * exposed so a case can prove the fallback's failure handling directly,
 * instead of inferring it from a teardown that happened to fail.
 */
export function ownTransportTeardown(
  transport: DisposableTransport,
): TransportTeardownOwnership {
  let disposeTransportReached = false
  const originalDisposeTransport = transport.disposeTransport.bind(transport)
  transport.disposeTransport = async (): Promise<void> => {
    // The disposer was reached: the production one is idempotent, so a
    // second call would tear nothing down again and the fallback must NOT
    // add one.
    disposeTransportReached = true
    await originalDisposeTransport()
  }
  const runFallback = async (): Promise<void> => {
    if (disposeTransportReached) return
    await transport.disposeTransport()
  }
  return { runFallback, disposeTransportReached: () => disposeTransportReached }
}
