/**
 * Shared identity helpers for Host-owned `/fork` and conversation rewind.
 *
 * The actual Host operation lives on `SessionLifecycle.fork()`. This module
 * deliberately contains no seed construction, child-id generation, preset
 * inheritance or Agent creation; those are Host responsibilities after D2.4.
 * @module @xmoon76/dsh-pi-tui/session-fork
 */

/** The local identity captured when a fork/rewind navigation intent opens. */
export interface RewindLiveIdentity {
  readonly sessionId: string | undefined
  readonly generation: number
  readonly navigationEpoch: number
}

/** A captured fork/rewind intent still owns the visible surface only while all
 * three local identity facts remain unchanged. */
export function isRewindIdentityCurrent(
  live: RewindLiveIdentity,
  expected: RewindLiveIdentity,
): boolean {
  return live.sessionId === expected.sessionId
    && live.generation === expected.generation
    && live.navigationEpoch === expected.navigationEpoch
}
