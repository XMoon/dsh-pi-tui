/**
 * The observation state vocabulary of the ONE session-policy observation
 * owner (`session-policy-observation.ts`). A pure DTO module: no Host types,
 * no transport facts — `ready` carries the DETACHED wire read.
 *
 * @module @xmoon76/dsh-pi-tui/app/command/policy-observation-state
 */

import type { SessionPolicyRead } from '../../runtime/session-policy-port.ts'

/** One subject's committed observation state. */
export type PolicyObservationState =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ready'; readonly read: SessionPolicyRead }
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: string }
