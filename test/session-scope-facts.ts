/**
 * Test-only adapter that projects a stub runner's live session state onto the
 * three A3-0 `TuiCommandRunner` CAPTURE members. It wires the REAL production
 * authorities (`createSessionSubjectAuthority` + `createSessionScopeAuthority`)
 * over the same mutable stub state, so a capture is invalidated by an Agent
 * swap and by a generation bump exactly like production — never by a
 * hand-rolled test approximation.
 *
 * `currentSessionId` is deliberately NOT supplied: spreading this helper would
 * evaluate such a getter ONCE and freeze it to the stub-construction value. A
 * stub must expose `currentSessionId` from its OWN live state instead.
 *
 * This module is intentionally NOT `*.test.ts`: `pnpm test:product` globs
 * `test/*.test.ts` and must not execute it as a suite.
 * @module @xmoon76/dsh-pi-tui/session-scope-facts
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createSessionScopeAuthority,
  type LiveSessionScope,
  type SessionScope,
  type SessionScopeAuthority,
} from '../src/app/session/scope.ts'
import {
  createSessionSubjectAuthority,
  type SessionOwnerRef,
} from '../src/app/session/subject.ts'

/** The subset of `TuiCommandRunner` the scope helper supplies: the CAPTURE
 * members only. A stub must also expose `currentSessionId` from its OWN live
 * state (a live getter, or `undefined` for a sessionless stub). */
export interface SessionScopeFacts {
  captureSessionScope(): SessionScope
  isSessionScopeCurrent(scope: SessionScope): boolean
  requireLiveSessionScope(): Promise<LiveSessionScope>
  /** The transitional paired resolution (`Agent` + its scope, one sync step). */
  requireLiveAgentScope(): Promise<{ readonly agent: Agent; readonly scope: LiveSessionScope }>
}

/**
 * Build the scope CAPTURE members over a stub's live state.
 *
 * @param currentAgent - re-reads the stub's live agent (its OWNER is the agent
 *   object itself, so swapping the agent invalidates a capture).
 * @param currentGeneration - re-reads the stub's current generation.
 */
export function sessionScopeFacts(
  currentAgent: () => Agent | undefined,
  currentGeneration: () => number,
): SessionScopeFacts {
  const subjectAuthority = createSessionSubjectAuthority(() => {
    const agent = currentAgent()
    if (agent === undefined) return undefined
    return { owner: agent as unknown as SessionOwnerRef, generation: currentGeneration() }
  })

  const scopeAuthority: SessionScopeAuthority = createSessionScopeAuthority({
    current: () => {
      const subject = subjectAuthority.capture()
      if (subject === undefined) {
        return { subject: undefined, sessionId: undefined, generation: currentGeneration() }
      }
      const agent = currentAgent()
      if (agent === undefined) throw new Error('a live ownership subject must carry a session id')
      return { subject, sessionId: agent.session.id, generation: currentGeneration() }
    },
    isSubjectCurrent: (subject) => subjectAuthority.isCurrent(subject),
  })

  return {
    captureSessionScope: () => scopeAuthority.capture(),
    isSessionScopeCurrent: (scope) => scopeAuthority.isCurrent(scope),
    requireLiveSessionScope: async () => {
      const scope = scopeAuthority.captureLive()
      if (scope === undefined) throw new Error('session could not be created')
      return scope
    },
    requireLiveAgentScope: async () => {
      // Mirrors the production facade: ONE synchronous step for both identities.
      const scope = scopeAuthority.captureLive()
      const agent = currentAgent()
      if (scope === undefined || agent === undefined) throw new Error('session could not be created')
      return { agent, scope }
    },
  }
}
