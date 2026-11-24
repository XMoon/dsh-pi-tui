/**
 * Test-only narrow tails for a structural `RemoteSessionWorkspaceFactsSource`.
 *
 * The Remote facts adapter requires the SAME official pieces production passes:
 * the forwarded `api-session/status` seat, the reconnecting `$stream` source with
 * its own carrier-error class, and the Client-domain initial Connection identity.
 * A suite that never exercises one of those capabilities uses the fail-fast
 * tail here instead of inventing a silent default: opening it is an explicit
 * test bug.
 *
 * This module is intentionally NOT `*.test.ts`.
 * @module @xmoon76/dsh-pi-tui/test/support/remote-session-workspace-source
 */

import type {
  RemoteSessionWorkspaceFactsSource,
  RemoteWorkspaceStreamSource,
} from '../../src/runtime/remote/session-workspace-facts-remote.ts'

/** The carrier-error class a structural test source supplies. Adapter tests
 *  assert the returned error was constructed from THIS class, which is exactly
 *  the same-installation identity the production Gateway retry needs. */
export class TestRemoteStreamCarrierError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TestRemoteStreamCarrierError'
  }
}

/** A fail-fast Workspace stream source for suites that never open a
 *  `recovering` follow. */
export function unconfiguredWorkspaceStream(): RemoteWorkspaceStreamSource {
  return {
    stream: () => { throw new Error('the reconnecting Workspace stream is not configured for this test') },
    carrierError: TestRemoteStreamCarrierError,
  }
}

/** A forwarded status seat that never delivers an event (suites whose case
 *  does not drive the recovery path through the official event). */
export function silentSessionStatusEvents(): RemoteSessionWorkspaceFactsSource['events'] {
  return { onSessionStatus: () => () => {} }
}
