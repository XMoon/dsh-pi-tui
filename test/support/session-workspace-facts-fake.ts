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

import type {
  ActivityObservation,
  SessionActivityFact,
  SessionWorkspaceFactsPort,
} from '../../src/runtime/session-workspace-facts-port.ts'

function unconfigured(): never {
  throw new Error('the official Session Workspace facts port is not configured for this test')
}

/** The narrow fail-fast fake: never a fabricated Workspace fact. */
export function unconfiguredSessionWorkspaceFacts(): SessionWorkspaceFactsPort {
  return {
    readActivity: async () => unconfigured(),
    // The Session Browser always opens ONE observation: without a configured
    // source it publishes the truthful unknown facts instead of failing the
    // whole open. `readActivity`/`followWorkspaces` remain fail-fast because a
    // suite that reaches them asked for real Host facts.
    observeActivity: () => inertActivityObservation(),
    followWorkspaces: () => unconfigured(),
  }
}

/** An inert per-open Activity observation: it accepts every roster commit and
 *  publishes the truthful UNKNOWN facts for each row. Suites whose case does
 *  not exercise real activity facts use it as the port's observation seat; a
 *  suite that asserts activity facts supplies its OWN observation. */
export function inertActivityObservation(): ActivityObservation {
  let rosterRevision = 0
  let revision = 0
  let facts: readonly SessionActivityFact[] = []
  const listeners = new Set<() => void>()
  return {
    setRoster(rows, revisionOfRoster) {
      rosterRevision = revisionOfRoster
      facts = rows
        .filter(row => row.origin !== 'subagent')
        .map(row => ({
          sessionId: row.id,
          running: undefined,
          pendingKinds: undefined,
          continuedQuestionCallIds: undefined,
          attention: 'unknown',
          attentionSourceState: 'unknown',
        }))
      revision += 1
      for (const listener of [...listeners]) listener()
    },
    setPriorityIds() {},
    getSnapshot: () => ({ rosterRevision, revision, facts }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose: () => { listeners.clear() },
  }
}
