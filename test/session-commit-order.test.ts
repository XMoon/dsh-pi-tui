/**
 * Order locks for the four session-commit shapes (A2 plan §4) and the
 * generation-bump primitives. These lock the behavior that the OLD inline
 * `src/index.ts` code had, BEFORE the ownership cutover moves that state.
 * @module @xmoon76/dsh-pi-tui/session-commit-order.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runFirstSessionCommit,
  runForkCommit,
  runGenerationBump,
  runOrdinaryCommit,
  runResumeCommit,
  type OrdinaryCommitSeams,
} from '../src/app/session/commit-order.ts'

/** The shared publication + bump seams, recording their call order. */
function publication(log: string[]) {
  return {
    publishOwner: (_owner: unknown): string | undefined => { log.push('publish'); return 'agent-1' },
    setCompletionOwner: (identity: string | undefined): void => { log.push(`completion:${identity ?? 'undefined'}`) },
    bumpGeneration: (): number => { log.push('bump'); return 1 },
  }
}

test('A ordinary transition: recall settle → ack → latency → bump(reset) → publish → completion', () => {
  const log: string[] = []
  const seams: OrdinaryCommitSeams = {
    isSurfaceDisposed: () => false,
    settlePendingQueueRecalls: (committed) => { log.push(`recalls:${committed}`) },
    settleLocalSubmitAck: (reason) => { log.push(`ack:${reason}`) },
    resetSubmitLatency: () => { log.push('latency') },
    ...publication(log),
  }
  runOrdinaryCommit(seams, { id: 'next' })
  assert.deepEqual(log, ['recalls:true', 'ack:session switched', 'latency', 'bump', 'publish', 'completion:agent-1'])
  assert.ok(log.indexOf('bump') < log.indexOf('publish'),
    'the generation reset must run BEFORE the new owner is published (it observes the OLD owner)')
})

test('A ordinary transition on a disposed surface: only the recall settle and the owner publication', () => {
  const log: string[] = []
  const seams: OrdinaryCommitSeams = {
    isSurfaceDisposed: () => true,
    settlePendingQueueRecalls: (committed) => { log.push(`recalls:${committed}`) },
    settleLocalSubmitAck: (reason) => { log.push(`ack:${reason}`) },
    resetSubmitLatency: () => { log.push('latency') },
    ...publication(log),
  }
  runOrdinaryCommit(seams, { id: 'next' })
  assert.deepEqual(log, ['recalls:true', 'publish'],
    'a disposed surface must skip ack/latency/bump and the completion reset, but still publish the late child for retirement')
})

test('B fork adoption: recall settle → ack(session forked) → latency → bump(reset) → publish → completion', () => {
  const log: string[] = []
  runForkCommit({
    settlePendingQueueRecalls: (committed) => { log.push(`recalls:${committed}`) },
    settleLocalSubmitAck: (reason) => { log.push(`ack:${reason}`) },
    resetSubmitLatency: () => { log.push('latency') },
    ...publication(log),
  }, { id: 'child' })
  assert.deepEqual(log, ['recalls:true', 'ack:session forked', 'latency', 'bump', 'publish', 'completion:agent-1'])
  assert.ok(log.indexOf('bump') < log.indexOf('publish'),
    'fork adoption must also reset the generation before publishing the child')
})

test('C first session: publish → completion → await child idle → bump(reset) → init', async () => {
  const log: string[] = []
  const committed = await runFirstSessionCommit({
    ...publication(log),
    quiesceChild: async () => { log.push('quiesce'); return false },
    initChild: async () => { log.push('init') },
  }, { id: 'first' })
  assert.equal(committed, true)
  assert.deepEqual(log, ['publish', 'completion:agent-1', 'quiesce', 'bump', 'init'])
  assert.ok(log.indexOf('publish') < log.indexOf('bump'),
    'the first-session create bumps AFTER publishing its committed child (unlike A/B)')
})

test('C first session aborted during the child idle: no bump and no init', async () => {
  const log: string[] = []
  const committed = await runFirstSessionCommit({
    ...publication(log),
    quiesceChild: async () => { log.push('quiesce'); return true },
    initChild: async () => { log.push('init') },
  }, { id: 'first' })
  assert.equal(committed, false)
  assert.deepEqual(log, ['publish', 'completion:agent-1', 'quiesce'])
})

test('D startup resume with no agent: publication stays SYNCHRONOUS (no promise, no microtask yield)', () => {
  const log: string[] = []
  const wait = runResumeCommit({
    ...publication(log),
    preMountQuiesce: () => {
      log.push('quiesce-check')
      return undefined
    },
  }, {})
  assert.equal(wait, undefined, 'a sessionless startup must not return a quiesce promise')
  assert.deepEqual(log, ['publish', 'completion:agent-1', 'quiesce-check'],
    'publication and the quiesce decision must both happen synchronously')
})

test('D startup resume with an owner: publish → completion → pre-mount quiesce (no bump)', async () => {
  const log: string[] = []
  const wait = runResumeCommit({
    ...publication(log),
    preMountQuiesce: async () => { log.push('quiesce') },
  }, { id: 'resumed' })
  assert.ok(wait instanceof Promise, 'an actual owner must return the quiesce promise for the caller to await')
  await wait
  assert.deepEqual(log, ['publish', 'completion:agent-1', 'quiesce'])
})

test('generation bump: the synchronous reset observes the bumped value', () => {
  let value = 0
  const observed: number[] = []
  const returned = runGenerationBump({
    isSurfaceDisposed: () => false,
    get: () => value,
    set: (next) => { value = next },
    reset: () => { observed.push(value) },
  })
  assert.equal(returned, 1)
  assert.deepEqual(observed, [1], 'the reset must see the NEW generation')
})

test('generation bump: a throwing reset does NOT roll the generation back', () => {
  let value = 4
  assert.throws(() => runGenerationBump({
    isSurfaceDisposed: () => false,
    get: () => value,
    set: (next) => { value = next },
    reset: () => { throw new Error('reset failed') },
  }), /reset failed/)
  assert.equal(value, 5, 'the increment stands even though the reset threw')
})

test('generation bump: a re-entrant reset that bumps again is reflected in the returned value', () => {
  let value = 0
  const seams = {
    isSurfaceDisposed: () => false,
    get: () => value,
    set: (next: number) => { value = next },
    reset: () => { if (value === 1) runGenerationBump(seams) },
  }
  assert.equal(runGenerationBump(seams), 2,
    'the outer bump must return the generation read at the END, after a re-entrant bump')
})

test('generation bump: a disposed surface returns the current value without bumping or resetting', () => {
  let resets = 0
  const returned = runGenerationBump({
    isSurfaceDisposed: () => true,
    get: () => 7,
    set: () => { throw new Error('a disposed bump must not set') },
    reset: () => { resets += 1 },
  })
  assert.equal(returned, 7)
  assert.equal(resets, 0)
})
