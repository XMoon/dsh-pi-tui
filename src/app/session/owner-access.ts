/**
 * The Direct owner-access seam consumed by the session layer (A2 §3.3).
 *
 * These types are CONSUMER-owned (`app/session`): the Direct side implements
 * them, and `app/session` never sees an `Agent` or an `AgentHandle`. Identity is
 * always the opaque `SessionOwnerRef`.
 * @module @xmoon76/dsh-pi-tui/app/session/owner-access
 */

import type { SessionHandle } from '../../runtime/session-lifecycle-port.ts'
import type { SessionOwnerRef } from './subject.ts'

/** The Direct implementation of the opaque owner mapping. */
export interface SessionOwnerAccess {
  /** Resolve the opaque owner of one lifecycle handle (Direct-only mapping). */
  fromHandle(handle: SessionHandle): SessionOwnerRef | undefined
  /** The session id of one registered opaque owner (throws when unknown). */
  sessionId(owner: SessionOwnerRef): string
  /** The exact Direct completion identity (`Agent.id`) of one owner. */
  completionIdentity(owner: SessionOwnerRef): string | undefined
  /**
   * A2 TRANSITIONAL Direct attachment escape. ONLY the A2 `initLiveSession`
   * provider may read it, and NEVER for identity/currentness.
   */
  surfaceAttachment(owner: SessionOwnerRef): unknown
}
