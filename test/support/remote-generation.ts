/** Remote adapter/parity test primitives for the official Connection
 * generation source.
 *
 * Two observable behaviors are kept deliberately distinct:
 *
 * - `createObservableGenerationHarness` synchronously notifies its subscribers
 *   on `set`, so reconnect/supersession notification is part of the test;
 * - `createSnapshotGenerationHarness` only advances the snapshot, so tests that
 *   exercise before/after dispatch generation fences get an inert subscription.
 *
 * The production `RemoteConnectionGenerationSource` type is reused; no parallel
 * generation DTO is defined here. */

import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from '../../src/runtime/remote/session-reader-remote.ts'

export interface GenerationHarness {
  readonly source: RemoteConnectionGenerationSource
  set(value: RemoteConnectionGeneration | undefined): void
}

/** A generation source that synchronously notifies current subscribers on set. */
export function createObservableGenerationHarness(
  initial: RemoteConnectionGeneration | undefined = { id: 1 },
): GenerationHarness {
  let current: RemoteConnectionGeneration | undefined = initial
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => current,
      subscribe: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(value) {
      current = value
      for (const listener of [...listeners]) listener()
    },
  }
}

/** A snapshot-only generation source whose subscription is inert. */
export function createSnapshotGenerationHarness(
  initial: RemoteConnectionGeneration | undefined = { id: 1 },
): GenerationHarness {
  let current: RemoteConnectionGeneration | undefined = initial
  return {
    source: { getSnapshot: () => current, subscribe: () => () => {} },
    set(value) { current = value },
  }
}
