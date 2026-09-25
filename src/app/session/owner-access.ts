/**
 * The session ownership seams consumed by the session layer (A2 §3.3).
 *
 * These types are CONSUMER-owned (`app/session`): a backend implements them,
 * and `app/session` never sees an `Agent` or an `AgentHandle`. Identity is
 * always the opaque `SessionOwnerRef`.
 *
 * The retirement semantics below are the ones the OFFICIAL session lifecycle
 * requires (the DSH session-close order); a backend adapter maps them onto its
 * own implementation. They must not be reshaped to mirror what the Direct
 * backend happens to do internally.
 * @module @xmoon76/dsh-pi-tui/app/session/owner-access
 */

import type { SessionHandle } from '../../runtime/session-lifecycle-port.ts'
import type { SessionOwnerRef } from './subject.ts'

/** A backend's implementation of the opaque owner mapping. */
export interface SessionOwnerAccess {
  /** Resolve the opaque owner of one lifecycle handle (backend-side mapping). */
  fromHandle(handle: SessionHandle): SessionOwnerRef | undefined
  /** The session id of one registered opaque owner (throws when unknown). */
  sessionId(owner: SessionOwnerRef): string
  /** The backend's stable completion identity for one owner. */
  completionIdentity(owner: SessionOwnerRef): string | undefined
  /**
   * A2 TRANSITIONAL attachment escape. ONLY the A2 live-session provider may
   * read it, and NEVER for identity/currentness.
   */
  surfaceAttachment(owner: SessionOwnerRef): unknown
}

/** One contained retirement failure. `phase` is a BACKEND-defined diagnostic
 *  label (the consumer only prints it); it is never a cross-backend contract. */
export interface SessionRetirementFailure {
  readonly phase: string
  readonly error: string
}

/** The retirement outcome: every contained failure, never a throw, plus the
 *  SEMANTIC fact the surface acts on. */
export interface SessionRetirementReport {
  readonly failures: readonly SessionRetirementFailure[]
  /** The failure that means the latest events may not be persisted, if any. */
  readonly durabilityFailure: SessionRetirementFailure | undefined
}

/**
 * The owner retirement the session layer needs: quiesce/cancel one owner and
 * retire it in the official session-close order. `mode` selects the cancel
 * policy (`'transition'` = an explicit session switch; `'shutdown'` = the
 * runner is exiting), never a different order.
 */
export interface SessionOwnerRetirement {
  /** Await the owner's quiescence and report which condition ended the wait:
   *  `true` when `signal` aborted first, `false` when the owner settled by
   *  itself. HOW an abort is reflected onto the owner is the backend's decision
   *  (a backend may cancel it, or merely stop waiting). */
  whenIdleOrAbort(owner: SessionOwnerRef, signal: AbortSignal): Promise<boolean>
  /** The final durable flush of the owner's session. */
  flush(owner: SessionOwnerRef): Promise<void>
  /** Synchronously cancel the owner's work BEFORE the surface is torn down. */
  preCancel(owner: SessionOwnerRef): void
  /** Retire the owner in the official session-close order. */
  retire(owner: SessionOwnerRef, mode: 'transition' | 'shutdown'): Promise<SessionRetirementReport>
  /** Park the owner's handle for a future reopen. */
  park(owner: SessionOwnerRef): void
  /** Retire every parked owner (the exit drain). */
  retireParked(): Promise<SessionRetirementReport>
}
