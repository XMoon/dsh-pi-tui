/**
 * Test-only typed fake for the M5-U-C required `TuiCommandRunner`
 * `sessionWorkspaceFacts` seam.
 *
 * Most command/runner suites never exercise the official Workspace facts port.
 * They still must construct the REQUIRED runner field, so they spread this
 * helper instead of inventing a Workspace registry, a baseline frame or a
 * `supported:true`-style precomputed judgement. Using the port is an explicit
 * failure: a suite that really opens the PiTUI Session Workspace supplies its
 * own real `baseline`/increment source and asserts the source → decision → UI
 * sink itself.
 *
 * This module is intentionally NOT `*.test.ts`: `pnpm test:product` globs
 * `test/*.test.ts` and must not execute it as a suite.
 * @module @xmoon76/dsh-pi-tui/test/support/session-workspace-facts-fake
 */

import type { SessionWorkspaceFactsPort } from '../../src/runtime/session-workspace-facts-port.ts'

function unconfigured(): never {
  throw new Error('the official Session Workspace facts port is not configured for this test')
}

/** The narrow fail-fast fake: never a fabricated Workspace fact. */
export function unconfiguredSessionWorkspaceFacts(): SessionWorkspaceFactsPort {
  return {
    readActivity: async () => unconfigured(),
    followWorkspaces: () => unconfigured(),
  }
}
