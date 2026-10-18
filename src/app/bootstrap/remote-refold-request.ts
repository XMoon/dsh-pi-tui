/**
 * S3-R0: how an incoming window-reconcile request folds into the surface's
 * pending refold state.
 *
 * The distinction the fold protects is `paging` versus `recovery`: a `loadOlder`
 * prepend only makes OLDER history visible, so the reconcile must not re-measure
 * the context, while a recovery (rollover / replace / revision discontinuity /
 * hydrate gap) may carry events the surface never saw and must measure. A
 * recovery always escalates an already pending paging request, and a paging
 * request never downgrades a pending recovery.
 *
 * @module @xmoon76/dsh-pi-tui/app/bootstrap/remote-refold-request
 */

import type { RemoteRefoldReason } from '../remote/live-ingress.ts'

/** The pump's pending state: whether a reconcile is queued and whether it may
 *  re-measure the context. */
export interface RemoteRefoldRequestState {
  readonly pending: boolean
  readonly measure: boolean
}

/** The state a pump starts/resets from: nothing queued, measurement allowed. */
export const IDLE_REMOTE_REFOLD_REQUEST: RemoteRefoldRequestState = { pending: false, measure: true }

/**
 * Fold one request (with its optional reason) into the pending state. A missing
 * reason is treated as a recovery (measure), and an in-flight paging request
 * keeps its no-measure decision only while no recovery arrives.
 */
export function requestRemoteRefold(
  current: RemoteRefoldRequestState,
  reason: RemoteRefoldReason | undefined,
): RemoteRefoldRequestState {
  const measure = reason !== 'paging'
  return { pending: true, measure: measure || (current.pending && current.measure) }
}
