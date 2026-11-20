/**
 * The LIVE exit-intent facts (M6 UX PR1).
 *
 * Extracted from the composition root so the exact source -> decision chain is
 * testable without a Cordis context: ONE synchronous capture of the full
 * Session scope (the SESSIONLESS generation included), the exact Remote
 * transport identity and the authoritative activity, plus the currentness read
 * the coordinator consumes at every confirmation.
 *
 * Authority rules (never substituted):
 * - presence/activity come from the ONE `SessionScopeAuthority` capture, the
 *   official Remote `SessionSnapshot.running` (or the Direct Agent status),
 *   and the existing application admissions (a held submission, a running user
 *   shell). A pending navigation is not substituted for the current Session's
 *   observed activity: the transition/retirement contracts own the
 *   exit-versus-navigation ordering.
 * - a Sessionless scope is still an identity: `capture()` (not only
 *   `captureLive()`) is stored, so the first Session publication invalidates it.
 * - the Remote transport token is captured beside the scope on EVERY Remote
 *   capture — including the admission/shell shortcuts — because the
 *   confirm fence compares BOTH the ownership generation and the exact
 *   Connection/binding identity. A sessionless Client fences the Connection
 *   generation with the empty-session sentinel.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/exit-facts
 */

import type { ExitBackendKind, ExitSessionActivity } from '../../domain/command/policy.ts'
import type { LiveSessionScope, SessionScope, SessionScopeAuthority } from '../session/scope.ts'
import type { ExitIntentFacts } from './exit-intent.ts'

/** The optional Remote transport read (the official Session facts port). */
export interface ExitIntentRemoteFacts {
  /** The official `SessionSnapshot.running` of the exact retained binding. */
  running(sessionId: string): boolean | undefined
  /** The official Connection-generation + exact-binding identity snapshot. */
  captureTransportToken(sessionId: string): unknown
  /** Whether the captured transport identity is still the live one. */
  isTransportTokenCurrent(sessionId: string, token: unknown): boolean
}

/** The narrow composition seams the facts read. */
export interface ExitIntentFactSources {
  /** The backend selected for THIS process. */
  backend(): ExitBackendKind
  /** The ONE session scope authority (capture + currentness). */
  scopes: Pick<SessionScopeAuthority, 'capture' | 'captureLive' | 'isCurrent'>
  /** Whether a submission admission currently holds the composer. */
  admissionPending(): boolean
  /** Whether an independent user-shell run is in flight. */
  shellRunning(): boolean
  /** Remote only: the official Session facts (undefined = not observable). */
  remote?: ExitIntentRemoteFacts
  /** Direct only: the attached Agent's official running/idle status. */
  directAgentRunning?(): boolean | undefined
}

/**
 * The sentinel Session id used to fence the Connection generation of a
 * sessionless Client: the official transport token then carries an absent
 * binding plus the live Connection generation, so a rollover still invalidates
 * the captured identity while a same-generation read stays current.
 */
const SESSIONLESS_TRANSPORT_SENTINEL = ''

/**
 * Build the ONE live fact source over the composition seams.
 * @param sources - the narrow truth owners.
 * @returns the coordinator's capture/currentness surface.
 */
export function createExitIntentFacts(sources: ExitIntentFactSources): ExitIntentFacts {
  const capture = (): ReturnType<ExitIntentFacts['capture']> => {
    const live = sources.scopes.captureLive()
    // A sessionless capture is a real identity: the generation must be fenced
    // too, or a choice opened before the first Session could exit it later.
    const scope = live ?? sources.scopes.capture()
    const backend = sources.backend()
    // The policy backend name is `daemon`; the transport is Remote-backed.
    const remote = backend === 'daemon'
    // The Client-owned user shell is a DISTINCT work owner: it is not the
    // Session Agent Turn, and the Agent idle waiter cannot prove it finished.
    const shellRunning = sources.shellRunning()
    const transportToken = remote
      ? sources.remote?.captureTransportToken(live?.sessionId ?? SESSIONLESS_TRANSPORT_SENTINEL)
      : undefined
    const base = {
      scope,
      live,
      shellRunning,
      ...(remote ? { transportToken } : {}),
    }
    // A pending navigation is NOT part of the current Session's activity. The
    // repository owns the exit-vs-navigation order in two accepted contracts:
    // `/exit` is never deferred behind a `/new` pre-gate Workspace resolution
    // (test/app/runner-session-bootstrap.test.ts), and an interactive exit
    // during a non-cooperative transition create pre-cancels the CURRENT owner
    // exactly once (test/app/runner-session-retirement.test.ts). Treating the
    // transition as `unknown` would replace those immediate exits with a
    // choice and break the contract, so presence/activity stay authoritative.
    if (live === undefined) {
      return {
        ...base,
        activity: sources.admissionPending() ? 'working' as ExitSessionActivity : 'idle' as ExitSessionActivity,
      }
    }
    if (sources.admissionPending() || shellRunning) {
      return { ...base, activity: 'working' as ExitSessionActivity }
    }
    if (remote) {
      const facts = sources.remote
      if (facts === undefined) return { ...base, activity: 'unknown' as ExitSessionActivity }
      // Re-read the exact Connection/binding identity captured above: a
      // rollover between the scope and this read is NOT an idle claim.
      if (!facts.isTransportTokenCurrent(live.sessionId, transportToken)) {
        return { ...base, activity: 'unknown' as ExitSessionActivity }
      }
      const running = facts.running(live.sessionId)
      return {
        ...base,
        activity: running === true ? 'working' as ExitSessionActivity : running === false ? 'idle' as ExitSessionActivity : 'unknown' as ExitSessionActivity,
      }
    }
    const running = sources.directAgentRunning?.()
    // A live Direct scope always carries its attached Agent; a missing status
    // is unobservable, never idle.
    if (running === undefined) return { ...base, activity: 'unknown' as ExitSessionActivity }
    return { ...base, activity: running ? 'working' as ExitSessionActivity : 'idle' as ExitSessionActivity }
  }

  return {
    currentBackend: sources.backend,
    capture,
    isScopeCurrent: (scope: SessionScope, transportToken: unknown): boolean => {
      if (!sources.scopes.isCurrent(scope)) return false
      if (sources.backend() === 'direct') return true
      const facts = sources.remote
      if (facts === undefined) return false
      return facts.isTransportTokenCurrent(scope.sessionId ?? SESSIONLESS_TRANSPORT_SENTINEL, transportToken)
    },
  }
}
