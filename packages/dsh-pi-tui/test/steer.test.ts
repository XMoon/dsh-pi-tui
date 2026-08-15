/**
 * Headless tests for the steer-all orchestration (Ctrl+S): the guard
 * TOCTOU races — queue splices and session switches while the async
 * divergence guard reads the file — must abort `stale` with nothing lost
 * and nothing written to a session the guard never checked.
 * @module @xmoon76/dsh-pi-tui/steer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionUnchanged, steerAll, type SteerAgentLike, type SteerDeps, type SteerGuard } from '../src/steer.ts'

type GuardVerdict = { kind: 'ok' | 'forced' } | { kind: 'blocked'; reason: 'diverged' | 'tail-mismatch' | 'unreadable' }

/** A deferred guard the test resolves manually, to stage in-flight races. */
function deferredGuard(): {
  promise: Promise<GuardVerdict>
  resolve: (v: GuardVerdict) => void
} {
  let resolve!: (v: GuardVerdict) => void
  const promise = new Promise<GuardVerdict>(res => { resolve = res })
  return { promise, resolve }
}

interface FakeAgent extends SteerAgentLike {
  status: 'idle' | 'running'
  /** The live queue state (splices mutate this). */
  state: { nextTurn: { id: string }[]; nextStep: { id: string }[] }
  steered: { id: string; text: string }[]
  followed: { id: string; text: string }[]
}

/** A mutable fake agent whose queue can be spliced mid-flight. */
function fakeAgent(ids: string[]): FakeAgent {
  const steered: { id: string; text: string }[] = []
  const followed: { id: string; text: string }[] = []
  const state = { nextTurn: ids.map(id => ({ id })), nextStep: [] as { id: string }[] }
  return {
    session: { id: 'session-steer' },
    inbox: {
      get nextTurn() { return state.nextTurn },
      get nextStep() { return state.nextStep },
      remove(id: string) {
        state.nextTurn = state.nextTurn.filter(m => m.id !== id)
        state.nextStep = state.nextStep.filter(m => m.id !== id)
      },
    },
    status: 'idle',
    steer: (message) => { steered.push(message as { id: string; text: string }) },
    followup: (message) => { followed.push(message as { id: string; text: string }) },
    state,
    steered,
    followed,
  } as FakeAgent
}

function makeDeps(options: {
  agent: () => SteerAgentLike | undefined
  generation?: () => number
  guard: Promise<GuardVerdict>
  notices?: string[]
  restored?: string[]
}): SteerDeps {
  return {
    currentAgent: options.agent,
    currentGeneration: options.generation ?? (() => 1),
    guard: { run: async () => options.guard },
    notify: (message, kind) => options.notices?.push(`${kind}: ${message}`),
    restoreDraft: (text) => options.restored?.push(text),
    createDraft: (text) => ({ id: `draft:${text}`, text }),
    blockedNotice: (reason) => `blocked-${reason}`,
    forcedNotice: () => 'forced',
    staleNotice: () => 'changed while sending',
  }
}

test('a queue splice while the guard is in flight aborts stale, restores the draft, loses nothing', async () => {
  const agent = fakeAgent(['a'])
  const guard = deferredGuard()
  const notices: string[] = []
  const restored: string[] = []
  const pending = steerAll(makeDeps({ agent: () => agent, guard: guard.promise, notices, restored }), 'draft')
  // While the guard reads the file, another surface splices B into the queue.
  agent.state.nextTurn = [...agent.state.nextTurn, { id: 'b' }]
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'stale')
  assert.deepEqual(agent.state.nextTurn.map(m => m.id), ['a', 'b'], 'nothing may be removed while stale')
  assert.deepEqual(agent.steered, [], 'no message may be steered')
  assert.deepEqual(restored, ['draft'], 'the stale send must restore the editor draft (it was cleared before onSteer)')
  assert.ok(notices.some(note => note.includes('changed while sending')), notices.join(' | '))
})

test('a queue edit while the guard is in flight aborts stale and restores the draft', async () => {
  const agent = fakeAgent(['a', 'b'])
  const guard = deferredGuard()
  const restored: string[] = []
  const pending = steerAll(makeDeps({ agent: () => agent, guard: guard.promise, restored }), 'draft')
  // The user edits A away (delete) while the guard runs.
  agent.state.nextTurn = [{ id: 'b' }]
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'stale')
  assert.deepEqual(agent.state.nextTurn.map(m => m.id), ['b'], 'the edited queue survives untouched')
  assert.deepEqual(agent.steered, [], 'the stale snapshot must not be force-sent')
  assert.deepEqual(restored, ['draft'], 'the stale send must restore the editor draft')
})

test('a session switch while the guard is in flight aborts stale and restores the draft', async () => {
  let current: FakeAgent | undefined = fakeAgent(['a'])
  const guard = deferredGuard()
  const steeredFirst = current.steered
  const restored: string[] = []
  const pending = steerAll(makeDeps({ agent: () => current, guard: guard.promise, restored }), 'x')
  current = fakeAgent(['z']) // session switch mid-guard
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'stale')
  assert.deepEqual(steeredFirst, [], 'the OLD session must not receive the payload')
  assert.deepEqual(current.steered, [], 'the NEW session must not receive an unguarded payload')
  assert.deepEqual(restored, ['x'], 'the stale send must restore the editor draft')
})

test('a generation bump while the guard is in flight aborts stale and restores the draft', async () => {
  let generation = 1
  const agent = fakeAgent(['a'])
  const guard = deferredGuard()
  const restored: string[] = []
  const pending = steerAll(makeDeps({ agent: () => agent, generation: () => generation, guard: guard.promise, restored }), 'x')
  generation = 2 // session switch (generation bump)
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'stale')
  assert.deepEqual(agent.steered, [])
  assert.deepEqual(restored, ['x'], 'the stale send must restore the editor draft')
})

test('a clean guard steers exactly the confirmed messages and removes only them', async () => {
  const agent = fakeAgent(['a', 'b'])
  const guard = deferredGuard()
  const notices: string[] = []
  const pending = steerAll(makeDeps({ agent: () => agent, guard: guard.promise, notices }), 'draft')
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'ok')
  assert.deepEqual(agent.state.nextTurn, [], 'confirmed messages are removed')
  assert.equal(agent.steered.length, 3, 'two queued messages + the draft')
  assert.deepEqual(agent.steered.map(m => m.id), ['a', 'b', 'draft:draft'])
  assert.ok(notices.some(note => note.includes('steering 3 messages')), notices.join(' | '))
})

test('a blocked guard restores the draft and reports the divergence kind', async () => {
  const agent = fakeAgent(['a'])
  const guard = deferredGuard()
  const notices: string[] = []
  const restored: string[] = []
  const pending = steerAll(makeDeps({ agent: () => agent, guard: guard.promise, notices, restored }), 'draft')
  guard.resolve({ kind: 'blocked', reason: 'tail-mismatch' })
  assert.equal(await pending, 'blocked')
  assert.deepEqual(restored, ['draft'], 'the draft must be restored for a retry')
  assert.ok(notices.some(note => note.includes('blocked-tail-mismatch')), notices.join(' | '))
  assert.deepEqual(agent.steered, [])
})

test('a clean guard with an empty queue falls back to the classic single-draft steer', async () => {
  const agent = fakeAgent([])
  agent.status = 'idle'
  const guard = deferredGuard()
  const pending = steerAll(makeDeps({ agent: () => agent, guard: guard.promise }), 'hello')
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'ok')
  assert.deepEqual(agent.followed.map(m => m.id), ['draft:hello'], 'an idle agent takes a followup')
  agent.status = 'running'
  const guard2 = deferredGuard()
  const pending2 = steerAll(makeDeps({ agent: () => agent, guard: guard2.promise }), 'hello')
  guard2.resolve({ kind: 'ok' })
  assert.equal(await pending2, 'ok')
  assert.deepEqual(agent.steered.map(m => m.id), ['draft:hello'], 'a running agent takes a steer')
})

test('a forced guard skips the info notice and still sends', async () => {
  const agent = fakeAgent(['a'])
  const guard = deferredGuard()
  const notices: string[] = []
  const pending = steerAll(makeDeps({ agent: () => agent, guard: guard.promise, notices }), '')
  guard.resolve({ kind: 'forced' })
  assert.equal(await pending, 'ok')
  assert.deepEqual(agent.steered.map(m => m.id), ['a'])
  assert.ok(notices.some(note => note === 'error: forced'), notices.join(' | '))
  assert.ok(!notices.some(note => note.includes('steering')), 'no info notice when forced')
})

test('sessionUnchanged requires the same agent object and generation', () => {
  const a = { id: 'a' }
  assert.equal(sessionUnchanged({ agent: a, generation: 1 }, a, 1), true)
  assert.equal(sessionUnchanged({ agent: a, generation: 1 }, a, 2), false, 'generation bump')
  assert.equal(sessionUnchanged({ agent: a, generation: 1 }, { id: 'b' }, 1), false, 'agent switch')
  assert.equal(sessionUnchanged({ agent: a, generation: 1 }, undefined, 1), false, 'agent gone')
})
