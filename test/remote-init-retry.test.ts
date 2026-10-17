/**
 * S3-R0: the official-signal re-init of a Remote live surface whose cold hydrate
 * could not commit. Behavior-level witnesses for the production helper the
 * composition root arms (the transport-absent branch that a source lock alone
 * could not prove).
 *
 * @module @xmoon76/dsh-pi-tui/remote-init-retry.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { armRemoteInitRetry, type RemoteInitRetryDeps } from '../src/app/bootstrap/remote-init-retry.ts'

interface Harness {
  readonly deps: RemoteInitRetryDeps
  readonly runs: number[]
  setConnectionGeneration(value: unknown): void
  setOwnerGeneration(value: number): void
  setCurrentSession(value: string | undefined): void
  setCleanedUp(value: boolean): void
  /** Deliver one official generation notification. */
  notify(): void
  /** Run the detached task(s) the helper scheduled. */
  flushDetached(): Promise<void>
}

function harness(initial: {
  readonly sessionId: string
  readonly ownerGeneration: number
  readonly connectionGeneration: unknown
}): Harness {
  let connectionGeneration = initial.connectionGeneration
  let ownerGeneration = initial.ownerGeneration
  let currentSession: string | undefined = initial.sessionId
  let cleanedUp = false
  const listeners = new Set<() => void>()
  const runs: number[] = []
  const detached: Array<() => Promise<void>> = []
  const deps: RemoteInitRetryDeps = {
    isCleanedUp: () => cleanedUp,
    currentSessionId: () => currentSession,
    ownerGeneration: () => ownerGeneration,
    connectionGeneration: () => connectionGeneration,
    subscribeConnectionGeneration: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    runInit: async () => { runs.push(ownerGeneration) },
    runDetached: (_name, run) => { detached.push(run) },
  }
  return {
    deps,
    runs,
    setConnectionGeneration: value => { connectionGeneration = value },
    setOwnerGeneration: value => { ownerGeneration = value },
    setCurrentSession: value => { currentSession = value },
    setCleanedUp: value => { cleanedUp = value },
    notify: () => { for (const listener of [...listeners]) listener() },
    flushDetached: async () => {
      const queued = detached.splice(0, detached.length)
      for (const run of queued) await run()
    },
  }
}

test('RFL-002: an armed retry waits for the OFFICIAL generation, then re-inits exactly once', async () => {
  const h = harness({ sessionId: 's1', ownerGeneration: 1, connectionGeneration: undefined })
  const armed = armRemoteInitRetry(h.deps, 's1', 1)
  assert.ok(armed !== undefined)
  h.notify()
  await h.flushDetached()
  assert.deepEqual(h.runs, [], 'no generation yet: the init never runs')
  h.setConnectionGeneration({ id: 2 })
  h.notify()
  await h.flushDetached()
  assert.deepEqual(h.runs, [1], 'the returned generation re-inits exactly once')
  h.notify()
  await h.flushDetached()
  assert.deepEqual(h.runs, [1], 'the retry disarms itself after the usable signal')
})

test('RFL-002: a same-id owner commit (owner generation bumped) cancels the armed retry', async () => {
  // The reviewer's race: a same-id owner commit keeps the session id but bumps
  // the owner generation. The old retry must not run the init — its entry
  // disposes the live surface — against the new owner.
  const h = harness({ sessionId: 's1', ownerGeneration: 1, connectionGeneration: undefined })
  armRemoteInitRetry(h.deps, 's1', 1)
  h.setOwnerGeneration(2)
  h.setConnectionGeneration({ id: 2 })
  h.notify()
  await h.flushDetached()
  assert.deepEqual(h.runs, [], 'the stale attempt never re-inits over the NEW owner')
})

test('RFL-002: the owner moving between the signal and the detached task wins', async () => {
  const h = harness({ sessionId: 's1', ownerGeneration: 1, connectionGeneration: undefined })
  armRemoteInitRetry(h.deps, 's1', 1)
  h.setConnectionGeneration({ id: 2 })
  h.notify()
  // The same-id commit lands after the listener consumed the signal, before the
  // detached task runs: the same-tick fence must refuse the init.
  h.setOwnerGeneration(3)
  await h.flushDetached()
  assert.deepEqual(h.runs, [], 'the same-tick re-check refuses the superseded attempt')
})

test('RFL-002: a different session, cleanup, or a repeated undefined generation never re-inits', async () => {
  const h = harness({ sessionId: 's1', ownerGeneration: 1, connectionGeneration: undefined })
  armRemoteInitRetry(h.deps, 's1', 1)
  h.setCurrentSession('s2')
  h.setConnectionGeneration({ id: 2 })
  h.notify()
  await h.flushDetached()
  assert.deepEqual(h.runs, [], 'a different current session owns the surface')

  const cleaned = harness({ sessionId: 's3', ownerGeneration: 1, connectionGeneration: undefined })
  armRemoteInitRetry(cleaned.deps, 's3', 1)
  cleaned.setCleanedUp(true)
  cleaned.setConnectionGeneration({ id: 2 })
  cleaned.notify()
  await cleaned.flushDetached()
  assert.deepEqual(cleaned.runs, [], 'a cleaned-up app never re-inits')

  const flapping = harness({ sessionId: 's4', ownerGeneration: 1, connectionGeneration: undefined })
  armRemoteInitRetry(flapping.deps, 's4', 1)
  flapping.notify()
  flapping.notify()
  await flapping.flushDetached()
  assert.deepEqual(flapping.runs, [], 'a still-undefined generation never re-inits')
})

test('RFL-002: a cleaned-up app does not arm at all', () => {
  const h = harness({ sessionId: 's1', ownerGeneration: 1, connectionGeneration: undefined })
  h.setCleanedUp(true)
  assert.equal(armRemoteInitRetry(h.deps, 's1', 1), undefined)
})
