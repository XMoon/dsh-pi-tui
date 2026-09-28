/**
 * Shared identity helpers for Host-owned `/fork` and conversation rewind.
 *
 * The actual Host operation lives on `SessionLifecycle.fork()`. This module
 * deliberately contains no seed construction, child-id generation, preset
 * inheritance or Agent creation; those are Host responsibilities after D2.4.
 * @module @xmoon76/dsh-pi-tui/session-fork
 */

/** The local NAVIGATION identity captured when a fork/rewind navigation intent
 *  opens. This is a view-level supersession token ONLY (mirroring the official
 *  Client split: `ClientSessions` owns Session identity/references and never a
 *  global current selection; view navigation belongs to the UI owner). It is
 *  deliberately NOT the surface `generation` — that axis invalidates
 *  presentation/async work (`SessionSubject`, `resetForGeneration`) and is
 *  bumped by a commit section itself, so reusing it here would misclassify a
 *  local commit-seam failure as user supersession. The monotonic
 *  `navigationEpoch` alone already solves A → B → A staleness. */
export interface RewindNavigationIdentity {
  readonly sessionId: string | undefined
  readonly navigationEpoch: number
}

/** A captured fork/rewind intent still owns the visible surface only while the
 *  session id and the navigation epoch remain unchanged. */
export function isRewindIdentityCurrent(
  live: RewindNavigationIdentity,
  expected: RewindNavigationIdentity,
): boolean {
  return live.sessionId === expected.sessionId
    && live.navigationEpoch === expected.navigationEpoch
}
