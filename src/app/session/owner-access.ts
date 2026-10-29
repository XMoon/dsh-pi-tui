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
import type { WriteOutcome } from '../../runtime/session-writer-port.ts'
import type { SessionOwnerRef } from './subject.ts'

/** A backend's implementation of the opaque owner mapping. */
export interface SessionOwnerAccess {
  /** Resolve the opaque owner of one lifecycle handle (backend-side mapping). */
  fromHandle(handle: SessionHandle): SessionOwnerRef | undefined
  /** The session id of one registered opaque owner (throws when unknown). */
  sessionId(owner: SessionOwnerRef): string
  /** The backend's stable completion identity for one owner. */
  completionIdentity(owner: SessionOwnerRef): string | undefined
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
 * The phase-resolved cancellation settlement a USER NAVIGATION consumes. It
 * deliberately separates "the request was never addressed" from "the request
 * was dispatched but its effect is unproven": only `committed` is permission to
 * proceed, and only `indeterminate` may claim the old Turn's state is an
 * improvement. The control `cancel` keeps the shared `WriteOutcome` taxonomy
 * (where a dispatched caller/carrier cancellation is `cancelled` for the user
 * Stop gesture); this seam only answers the navigation question without
 * changing that classification.
 */
export type NavigationCancelSettlement =
  | { readonly kind: 'committed' }
  | { readonly kind: 'rejected'; readonly detail: string }
  /** Confirmed pre-dispatch: the exact generation could not be addressed (or
   *  the runner is exiting). NEVER permission to switch. */
  | { readonly kind: 'cancelled' }
  /** The request WAS dispatched and its effect cannot be proven (a superseded
   *  reply, a caller/carrier cancellation, an unknown carrier failure). Never
   *  retried. */
  | { readonly kind: 'indeterminate'; readonly detail: string }

/**
 * The owner retirement the session layer needs: quiesce/cancel one owner and
 * retire it in the official session-close order. `mode` selects the cancel
 * policy (`'transition'` = an explicit session switch; `'shutdown'` = the
 * runner is exiting), never a different order.
 */
export interface SessionOwnerRetirement {
  /** Await the owner's quiescence and report which condition ended the wait:
   *  `true` when `signal` aborted first, `false` when the EXACT owner was
   *  OBSERVED settling by itself, and `'unobservable'` when the exact owner
   *  generation can no longer be observed (a replaced/retired Remote binding, a
   *  changed Connection generation, or a missing Direct attachment).
   *  `'unobservable'` is NOT proof of idle and
   *  must never be consumed as one. HOW an abort is reflected onto the owner is
   *  the backend's decision (a backend may cancel it, or merely stop waiting). */
  whenIdleOrAbort(owner: SessionOwnerRef, signal: AbortSignal): Promise<boolean | 'unobservable'>
  /** ONE-SHOT user cancel of this EXACT owner's current work, preserving its
   *  pending inbox (the Busy Esc / Stop semantic). This is deliberately NOT
   *  {@link preCancel}: that one is the synchronous shutdown preparation and
   *  makes no keepInbox promise. The backend addresses the captured owner
   *  generation itself and returns the shared write settlement — only
   *  `committed` means the backend accepted the cancel; a stale/gone
   *  generation is `cancelled`, a proven refusal is `rejected`, and an
   *  unproven carrier failure is `indeterminate` (never retried). */
  cancel(owner: SessionOwnerRef): Promise<WriteOutcome<undefined>>
  /**
   * The USER-NAVIGATION stop of this EXACT owner's current work: the same
   * one-shot cancel, reported with the pre-dispatch/dispatched phase resolved
   * (see {@link NavigationCancelSettlement}). It never changes what
   * {@link cancel} means for the user Stop gesture; it only gives navigation
   * the fact it needs to decide whether the transition may proceed (only
   * `committed`) and whether the old Turn may already have stopped (only
   * `indeterminate`).
   */
  cancelForNavigation(owner: SessionOwnerRef): Promise<NavigationCancelSettlement>
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
