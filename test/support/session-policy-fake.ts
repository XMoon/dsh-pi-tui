/**
 * Shared session-policy test doubles (M6-1 F8): the fail-closed port and
 * observation stubs generic runner fakes spread in. A suite that exercises
 * policy behavior overrides the members after the spread — these defaults
 * only keep the contracts honest (a read answers "no live session", a write
 * is refused, an observation stays `checking`).
 */

import type { SessionPolicyPort, SessionPolicySetOutcome } from '../../src/runtime/session-policy-port.ts'
import type { SessionPolicyObservation } from '../../src/app/command/session-policy-observation.ts'
import type { PolicyObservationState } from '../../src/app/command/policy-observation-state.ts'

/** The generic fail-closed port: no session is live, no write is admitted. */
export function unconfiguredSessionPolicyPort(): SessionPolicyPort {
  return {
    async read(sessionId) {
      return { kind: 'unavailable', sessionId, reason: 'session-not-live' }
    },
    async setApproval(sessionId): Promise<SessionPolicySetOutcome> {
      return { kind: 'refused', reason: 'session-not-live' }
    },
  }
}

/** The generic observation stub: everything stays `checking`, no listeners. */
export function unconfiguredPolicyObservation(): SessionPolicyObservation {
  const states = new Map<string, PolicyObservationState>()
  return {
    readSnapshot: sessionId => states.get(sessionId) ?? { kind: 'checking' },
    async refresh(sessionId) {
      return states.get(sessionId) ?? { kind: 'checking' }
    },
    invalidate: sessionId => {
      if (sessionId === undefined) states.clear()
      else states.delete(sessionId)
    },
    subscribe: () => () => {},
    dispose: () => {},
  }
}
