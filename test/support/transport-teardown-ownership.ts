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
 * the runner never released it, so it can never add a second call to a
 * transport the runner already disposed.
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
  /** Whether the runner's own teardown already released the transport. */
  readonly releasedByRunner: () => boolean
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
  let releasedByRunner = false
  const originalDisposeTransport = transport.disposeTransport.bind(transport)
  transport.disposeTransport = async (): Promise<void> => {
    // The runner's teardown effect reached the transport: the fallback must
    // NOT add a second call.
    releasedByRunner = true
    await originalDisposeTransport()
  }
  const runFallback = async (): Promise<void> => {
    if (releasedByRunner) return
    await transport.disposeTransport()
  }
  return { runFallback, releasedByRunner: () => releasedByRunner }
}
