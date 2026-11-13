/**
 * H1 F3: the official Connection-generation lifecycle of the Remote
 * terminal-progress watch. These are the three transitions the Reviewer
 * required, driven deterministically through the official generation channel:
 *
 * - valid -> `undefined`: release immediately, stop the watch, start nothing;
 * - `undefined` -> new valid: start exactly ONE watch (requalification comes
 *   only from its opening Host snapshot);
 * - first arm already `undefined`: keep the official listener and create the
 *   first watch on the next generation.
 *
 * @module @xmoon76/dsh-pi-tui/remote-progress-watch-generation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  armRemoteProgressWatchGeneration,
  type RemoteProgressWatchGenerationDeps,
} from '../../src/app/bootstrap/remote-progress-watch.ts'

interface Harness {
  readonly deps: RemoteProgressWatchGenerationDeps
  readonly releases: number[]
  readonly starts: unknown[]
  readonly disposed: number[]
  setGeneration(value: unknown): void
  notify(): void
  setOwnerGeneration(value: number): void
  setSession(value: string | undefined): void
  setCleanedUp(value: boolean): void
  readonly unsubscribed: () => number
}

function harness(initial: { generation: unknown; ownerGeneration?: number }): Harness {
  let generation = initial.generation
  let ownerGeneration = initial.ownerGeneration ?? 1
  let currentSession: string | undefined = 's1'
  let cleanedUp = false
  let unsubscribed = 0
  const listeners = new Set<() => void>()
  const releases: number[] = []
  const starts: unknown[] = []
  const disposed: number[] = []
  return {
    deps: {
      isCleanedUp: () => cleanedUp,
      currentSessionId: () => currentSession,
      ownerGeneration: () => ownerGeneration,
      sessionId: 's1',
      ownerGenerationAtInit: 1,
      connectionGeneration: () => generation,
      subscribeConnectionGeneration: listener => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
          unsubscribed += 1
        }
      },
      release: () => { releases.push(0) },
      disposeWatch: () => { disposed.push(0) },
      startWatch: value => { starts.push(value) },
    },
    releases,
    starts,
    disposed,
    setGeneration: value => { generation = value },
    notify: () => { for (const listener of [...listeners]) listener() },
    setOwnerGeneration: value => { ownerGeneration = value },
    setSession: value => { currentSession = value },
    setCleanedUp: value => { cleanedUp = value },
    unsubscribed: () => unsubscribed,
  }
}

test('a first arm with a valid generation starts exactly ONE watch, without releasing', () => {
  const h = harness({ generation: { id: 1 } })
  const lifecycle = armRemoteProgressWatchGeneration(h.deps)
  lifecycle.observeCurrent()
  assert.deepEqual(h.starts, [{ id: 1 }])
  assert.deepEqual(h.releases, [], 'a first registration has nothing to release')
  assert.deepEqual(h.disposed, [])
  lifecycle.dispose()
  assert.equal(h.unsubscribed(), 1)
})

test('valid -> undefined releases immediately and starts nothing while the outage lasts', () => {
  const h = harness({ generation: { id: 1 } })
  const lifecycle = armRemoteProgressWatchGeneration(h.deps)
  lifecycle.observeCurrent()
  h.setGeneration(undefined)
  h.notify()
  assert.equal(h.releases.length, 1, 'the Pane is withdrawn on the lost generation')
  assert.equal(h.disposed.length, 1, 'the stale watch is stopped')
  assert.deepEqual(h.starts, [{ id: 1 }], 'no replacement watch without a generation')
  // Repeated undefined notifications are inert (no extra release/start).
  h.notify()
  assert.equal(h.releases.length, 1)
  assert.deepEqual(h.starts, [{ id: 1 }])
})

test('undefined -> new valid starts exactly ONE watch after the release', () => {
  const h = harness({ generation: undefined })
  const lifecycle = armRemoteProgressWatchGeneration(h.deps)
  lifecycle.observeCurrent()
  assert.deepEqual(h.starts, [], 'no watch while the generation is invalid')
  h.setGeneration({ id: 2 })
  h.notify()
  assert.equal(h.releases.length, 1, 'the previous qualification is released before requalification')
  assert.deepEqual(h.starts, [{ id: 2 }], 'the new generation creates exactly one watch')
  h.notify()
  assert.deepEqual(h.starts, [{ id: 2 }], 'a repeated notification cannot duplicate the watch')
})

test('a first arm while already undefined keeps the official listener for the next generation', () => {
  const h = harness({ generation: undefined })
  const lifecycle = armRemoteProgressWatchGeneration(h.deps)
  lifecycle.observeCurrent()
  assert.equal(h.unsubscribed(), 0, 'the listener must stay armed across the initial outage')
  h.setGeneration({ id: 3 })
  h.notify()
  assert.deepEqual(h.starts, [{ id: 3 }], 'the recovered generation creates the first watch')
  assert.equal(h.releases.length, 1, 'qualification starts from an explicit release state')
})

test('an owner move or cleanup never releases or starts a watch', () => {
  const moved = harness({ generation: { id: 1 } })
  const movedLifecycle = armRemoteProgressWatchGeneration(moved.deps)
  movedLifecycle.observeCurrent()
  moved.setOwnerGeneration(2)
  moved.setGeneration({ id: 2 })
  moved.notify()
  assert.deepEqual(moved.releases, [], 'a superseded owner commit owns no Pane')
  assert.deepEqual(moved.starts, [{ id: 1 }])

  const cleaned = harness({ generation: { id: 1 } })
  const cleanedLifecycle = armRemoteProgressWatchGeneration(cleaned.deps)
  cleanedLifecycle.observeCurrent()
  cleaned.setCleanedUp(true)
  cleaned.setGeneration(undefined)
  cleaned.notify()
  assert.deepEqual(cleaned.releases, [], 'a cleaned-up runner must not touch the Pane')
})
