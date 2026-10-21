/**
 * Atomic, transport-neutral session SCOPE capture (plan A3 §1.1).
 *
 * A `SessionSubject` (A2) pins the exact owner generation for a LIVE owner, but
 * it is `undefined` while sessionless — it cannot express "this operation started
 * with no Session and must still find no Session (and the same generation) when
 * it resumes". A `SessionScope` closes that gap:
 *
 * - ONE synchronous capture pins `{ owner subject (or undefined), generation,
 *   sessionId }` together, so a consumer can never re-combine "the current
 *   session id" with "the captured generation" into a second identity.
 * - Currentness: a LIVE capture compares through the A2 subject fence (same exact
 *   owner AND generation); a SESSIONLESS capture requires the surface to still
 *   have no owner AND the generation to be unchanged — which also fails inside
 *   the first-session commit's publish-before-bump window.
 *
 * The authority keeps NO mutable state of its own: it reads the runtime's single
 * private owner slot through the supplied peek.
 * @module @xmoon76/dsh-pi-tui/app/session/scope
 */

import type { SessionSubject } from './subject.ts'

declare const sessionScopeBrand: unique symbol

/**
 * The write-admission refusal for a STALE scope (plan A3 §1.3): the captured
 * owner is no longer the current one, so the operation must not run. It is
 * deliberately DISTINCT from the barrier's `TransitionInProgressError`
 * ("a transition owns the surface now" vs "your capture no longer owns the
 * surface"); never merge the two, never report one as the other.
 */
export class SessionScopeSupersededError extends Error {
  constructor() {
    super('the captured session scope is no longer current')
    this.name = 'SessionScopeSupersededError'
  }
}

/** One synchronous read of the runtime's private owner slot. */
export type SessionScopeLive =
  | {
    readonly subject: SessionSubject
    readonly sessionId: string
    readonly generation: number
  }
  | {
    readonly subject: undefined
    readonly sessionId: undefined
    readonly generation: number
  }

/**
 * A captured scope. Consumers pass it back to `isCurrent`; the pinned record and
 * the session id are the only things it exposes.
 */
export interface SessionScope {
  readonly sessionId: string | undefined
  readonly [sessionScopeBrand]: true
}

/** A scope captured while a Session was live (both fields are then present). */
export interface LiveSessionScope extends SessionScope {
  readonly sessionId: string
  readonly subject: SessionSubject
}

/** What one captured scope pins (private to this module). */
export interface SessionScopeRecord {
  readonly generation: number
  readonly subject: SessionSubject | undefined
}

/** Capture/currentness authority over the runtime's single ownership slot. */
export interface SessionScopeAuthority {
  /** ONE synchronous capture; sessionless captures are legal and meaningful. */
  capture(): SessionScope
  /** The same capture for a session-backed path, or `undefined` while sessionless. */
  captureLive(): LiveSessionScope | undefined
  /** True only for the same exact owner AND generation, or the same sessionless generation. */
  isCurrent(scope: SessionScope): boolean
}

/**
 * Build the authority over a READ-ONLY peek of the runtime slot. `peek.current()`
 * must read live state (never a snapshot).
 */
export function createSessionScopeAuthority(peek: {
  current(): SessionScopeLive
  /** The A2 subject fence: true only for the same exact owner AND generation. */
  isSubjectCurrent(subject: SessionSubject): boolean
}): SessionScopeAuthority {
  const pinned = new WeakMap<SessionScope, SessionScopeRecord>()

  const mint = <T extends SessionScope>(live: SessionScopeLive, scope: T): T => {
    // COPY the captured values: a provider that reuses one record object must
    // never move an already-captured scope.
    pinned.set(scope, { generation: live.generation, subject: live.subject })
    return scope
  }

  return {
    capture: () => {
      const live = peek.current()
      return mint(live, { sessionId: live.sessionId } as SessionScope)
    },
    captureLive: () => {
      const live = peek.current()
      if (live.subject === undefined) return undefined
      return mint(live, {
        sessionId: live.sessionId,
        subject: live.subject,
      } as LiveSessionScope)
    },
    isCurrent: (scope) => {
      const record = pinned.get(scope)
      if (record === undefined) return false
      const live = peek.current()
      if (record.subject !== undefined) {
        // The A2 fence pins the exact owner AND generation. NEVER compare subject
        // TOKENS by object equality: every capture() mints a fresh token. The
        // session-id agreement is a belt-and-braces invariant on that owner.
        return peek.isSubjectCurrent(record.subject) && live.sessionId === scope.sessionId
      }
      // A sessionless capture is current only while the surface still has no
      // owner and the generation has not moved (the union already guarantees
      // `sessionId === undefined` in this branch).
      return live.subject === undefined && live.generation === record.generation
    },
  }
}
