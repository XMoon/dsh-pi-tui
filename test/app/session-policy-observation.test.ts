/**
 * UNIT: the ONE session-policy observation owner — latest-read-serial wins,
 * generation/subject fences, invalidation, subscription/disposal lifetimes
 * and the "no stale value as fresh truth" rule (plan §6.2 R01–R03/R11).
 *
 * @module @xmoon76/dsh-pi-tui/session-policy-observation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionPolicyObservation } from '../../src/app/command/session-policy-observation.ts'
import type { SessionPolicyRead } from '../../src/runtime/session-policy-port.ts'

interface SourceFixture {
  read(sessionId: string, signal?: AbortSignal): Promise<SessionPolicyRead>
  generation(): object | undefined
  isSubjectCurrent(sessionId: string): boolean
  diag: import('../../src/runtime/process/diagnostics.ts').Diag
}

function readyRead(sessionId: string, effective: 'ask' | 'never' = 'never'): SessionPolicyRead {
  return {
    kind: 'ready',
    sessionId,
    approval: { state: 'ready', effective, override: effective },
    sandbox: { state: 'ready', effective: 'read-only' },
  }
}

function sourceFixture(options: {
  reads?: Map<string, SessionPolicyRead | Promise<SessionPolicyRead>>
  readDelay?: (sessionId: string) => Promise<void>
  subjectCurrent?: boolean
  generationStable?: boolean
} = {}): SourceFixture & {
  readonly debugs: string[]
  replaceGeneration(): void
  setSubjectCurrent(value: boolean): void
} {
  const debugs: string[] = []
  const diag = {
    debug: (message: string) => { debugs.push(message) },
    info: (message: string) => { debugs.push(message) },
    warn: (message: string) => { debugs.push(message) },
    error: (message: string) => { debugs.push(message) },
    dispose: () => {},
  }
  let generation: object | undefined = {}
  let subjectCurrent = options.subjectCurrent ?? true
  return {
    debugs,
    replaceGeneration: () => { generation = {} },
    setSubjectCurrent: (value: boolean) => { subjectCurrent = value },
    read: async (sessionId, signal) => {
      await options.readDelay?.(sessionId)
      signal?.throwIfAborted()
      const value = options.reads?.get(sessionId)
      if (value === undefined) throw new Error('no fixture read')
      return value
    },
    generation: () => (options.generationStable === false ? generation : generation),
    isSubjectCurrent: () => subjectCurrent,
    diag,
  }
}

test('readSnapshot answers checking for an unknown subject; refresh commits exactly one read', async () => {
  const source = sourceFixture({ reads: new Map([['s1', readyRead('s1')]]) })
  const observation = createSessionPolicyObservation(source)
  assert.deepEqual(observation.readSnapshot('s1'), { kind: 'checking' })
  const state = await observation.refresh('s1')
  assert.equal(state.kind, 'ready')
  assert.deepEqual(observation.readSnapshot('s1'), { kind: 'ready', read: readyRead('s1') })
})

test('R01: an older read can never overwrite a newer one (latest-serial wins)', async () => {
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
  let call = 0
  const source = sourceFixture({})
  source.read = async (sessionId) => {
    call += 1
    if (call === 1) {
      await firstGate
      return readyRead(sessionId, 'never')
    }
    return readyRead(sessionId, 'ask')
  }
  const observation = createSessionPolicyObservation(source)
  const first = observation.refresh('s1')
  const second = await observation.refresh('s1')
  assert.equal(second.kind, 'ready')
  releaseFirst?.()
  await first
  assert.equal(observation.readSnapshot('s1').kind, 'ready')
  const read = (observation.readSnapshot('s1') as { read: SessionPolicyRead }).read
  assert.ok(read.kind === 'ready' && read.approval.state === 'ready' && read.approval.effective === 'ask',
    'the NEWER read (ask) is the committed truth; the older never-later answer did not overwrite it')
})

test('R02: a generation replacement DURING a read revokes that answer; the new Host is re-read fresh', async () => {
  let releaseRead: (() => void) | undefined
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  const source = sourceFixture({})
  source.read = async sessionId => {
    // The Host REPLACES mid-read: the in-flight answer will belong to a
    // connection generation this observer no longer holds.
    source.replaceGeneration()
    await gate
    return readyRead(sessionId)
  }
  const observation = createSessionPolicyObservation(source)
  const settled = observation.refresh('s1')
  releaseRead?.()
  assert.equal((await settled).kind, 'unavailable', 'the mid-read replacement revoked the answer — the old Host value never poses as the new one')
  assert.deepEqual(observation.readSnapshot('s1'), { kind: 'unavailable', reason: 'session-not-live' })
})

test('R03/R11: a subject change revokes truth; the old subject\'s answer never repaints the new one', async () => {
  const source = sourceFixture({ reads: new Map([['s1', readyRead('s1')]]) })
  const observation = createSessionPolicyObservation(source)
  await observation.refresh('s1')
  source.setSubjectCurrent(false)
  const state = await observation.refresh('s1')
  assert.equal(state.kind, 'unavailable')
  // Two subjects stay independent: s2 knows nothing about s1's answer.
  assert.deepEqual(observation.readSnapshot('s2'), { kind: 'checking' })
})

test('a failed read stays failed (never degraded to a guessed default); invalidate revokes to checking', async () => {
  const source = sourceFixture({})
  source.read = async () => { throw new Error('boom') }
  const observation = createSessionPolicyObservation(source)
  const state = await observation.refresh('s1')
  assert.deepEqual(state, { kind: 'failed', reason: 'boom' })
  observation.invalidate('s1')
  assert.deepEqual(observation.readSnapshot('s1'), { kind: 'checking' })
  observation.invalidate()
  assert.deepEqual(observation.readSnapshot('s1'), { kind: 'checking' })
})

test('subscriptions notify on commit and invalidate; dispose stops everything exactly once', async () => {
  const source = sourceFixture({ reads: new Map([['s1', readyRead('s1')]]) })
  const observation = createSessionPolicyObservation(source)
  let notifications = 0
  const unsubscribe = observation.subscribe(() => { notifications += 1 })
  await observation.refresh('s1')
  observation.invalidate('s1')
  unsubscribe()
  observation.invalidate('s1')
  assert.equal(notifications, 1, 'ONLY a committed read repaints consumers; invalidation and read-start are silent')
  observation.dispose()
  observation.dispose()
  // After disposal a late read settles nothing and notifies nobody.
  const late = sourceFixture({ reads: new Map([['s1', readyRead('s1')]]) })
  const disposed = createSessionPolicyObservation(late)
  disposed.dispose()
  assert.equal((await disposed.refresh('s1')).kind, 'checking', 'a disposed owner commits no state')
})

test('a revisited subject whose truth was invalidated starts a fresh read (re-entry is not permanently unknown)', async () => {
  const reads: string[] = []
  let value: 'ask' | 'never' = 'ask'
  const source = sourceFixture({})
  source.read = async sessionId => {
    reads.push(sessionId)
    return readyRead(sessionId, value)
  }
  const observation = createSessionPolicyObservation(source)
  // First observation starts ONE controlled read; the answer commits.
  const first = observation.readSnapshot('child-x')
  assert.equal(first.kind, 'checking')
  await new Promise<void>(resolve => { setTimeout(resolve, 10) })
  assert.equal(observation.readSnapshot('child-x').kind, 'ready')
  assert.equal(reads.length, 1)
  // The viewer exits: the subject's truth is revoked (no synchronous re-read).
  observation.invalidate('child-x')
  assert.equal(reads.length, 1, 'invalidation itself starts no read')
  // The SAME child is re-entered: the next observation restarts a read.
  value = 'never'
  assert.equal(observation.readSnapshot('child-x').kind, 'checking')
  await new Promise<void>(resolve => { setTimeout(resolve, 10) })
  assert.equal(reads.length, 2, 're-entry starts exactly one new controlled read')
  const state = observation.readSnapshot('child-x')
  assert.ok(state.kind === 'ready' && state.read.kind === 'ready' && state.read.approval.state === 'ready')
  assert.equal(state.read.approval.effective, 'never', 'the revisited subject shows the fresh Host fact')
})
