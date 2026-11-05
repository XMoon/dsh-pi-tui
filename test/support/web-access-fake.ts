/**
 * The truthful-unavailable {@link WebAccessPort} for `TuiCommandRunner` fakes.
 *
 * A runner fake is not a Web frontend: it serves the same missing capability a
 * Direct backend serves, so a `/web` handler driven through it observes the
 * unsupported path instead of a fabricated status. Tests that exercise the
 * Remote `/web` flow supply their own explicit port.
 *
 * @module test/support/web-access-fake
 */

import type { WebAccessPort } from '../../src/runtime/web-access-port.ts'

/** One unavailable Web access port (status/toggle answer, URL refuses). */
export function unavailableWebAccess(): WebAccessPort {
  const reason = 'test: the Web frontend controls are unavailable'
  return {
    getStatus: async () => ({ state: 'unavailable', reason }),
    setEnabled: async () => ({ state: 'unavailable', reason }),
    getAuthenticatedUrl: async () => {
      throw new Error(reason)
    },
  }
}
