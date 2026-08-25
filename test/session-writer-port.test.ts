/**
 * Adapter contract tests for the Direct session writer
 * (runtime/direct/session-writer-direct.ts, migration M1.4, contract
 * round 2): the port is identity-based — every operation addresses a
 * session by id, the Direct adapter resolves the live agent through the
 * runner-injected resolver, and a Remote adapter must satisfy the SAME
 * contract over the wire. These tests pin the contract with a fake Host
 * context, so the two backends cannot drift.
 * @module @xmoon76/dsh-pi-tui/session-writer-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSessionWriter, type HostContextLike, type LiveAgentLike } from '../src/runtime/direct/session-writer-direct.ts'

function host(services: Record<string, unknown>): HostContextLike {
  return { get: (name) => services[name] }
}

function agent(id: string, overrides: Partial<LiveAgentLike> = {}): LiveAgentLike {
  return {
    session: { id },
    followup: () => {},
    steer: () => {},
    cancel: () => {},
    inbox: { remove: () => {} },
    ...overrides,
  }
}

function writer(agents: Map<string, LiveAgentLike>, services: Record<string, unknown> = {}) {
  return new DirectSessionWriter(
    host(services),
    (sessionId) => agents.get(sessionId),
  )
}

test('followup delivers the prepared message to the session\x27s agent', () => {
  const delivered: unknown[] = []
  const agents = new Map([['session-a', agent('session-a', { followup: (m) => delivered.push(m) })]])
  writer(agents).followup('session-a', { role: 'user', text: 'hi' })
  assert.deepEqual(delivered, [{ role: 'user', text: 'hi' }])
})

test('dequeue removes exactly the pulled-back message id from the session\x27s queue', () => {
  const removed: string[] = []
  const agents = new Map([['session-a', agent('session-a', { inbox: { remove: (id) => removed.push(id) } })]])
  writer(agents).dequeue('session-a', 'message-1')
  assert.deepEqual(removed, ['message-1'])
})

test('cancel passes the reason and keepInbox through for the session', () => {
  const calls: Array<{ reason: unknown; options: unknown }> = []
  const agents = new Map([['session-a', agent('session-a', { cancel: (reason, options) => calls.push({ reason, options }) })]])
  writer(agents).cancel('session-a', { kind: 'user' }, { keepInbox: true })
  assert.deepEqual(calls, [{ reason: { kind: 'user' }, options: { keepInbox: true } }])
})

test('operations address the agent resolved by session id (a live switch is observed)', () => {
  const delivered: unknown[] = []
  let current = agent('session-a', { followup: (m) => delivered.push(m) })
  const agents = new Map<string, LiveAgentLike>([['session-a', current]])
  const w = writer(agents)
  w.followup('session-a', { text: 'one' })
  // The live surface SWITCHES to a different agent object for the same id:
  const next = agent('session-a', { followup: (m) => delivered.push(m) })
  agents.set('session-a', next)
  w.followup('session-a', { text: 'two' })
  assert.equal(delivered.length, 2, 'both deliveries landed')
  assert.deepEqual(delivered, [{ text: 'one' }, { text: 'two' }])
})

test('followup on an absent session is a silent no-op', () => {
  const w = writer(new Map())
  w.followup('session-ghost', { text: 'x' }) // must not throw
  w.cancel('session-ghost', { kind: 'user' }, { keepInbox: true })
  w.dequeue('session-ghost', 'm1')
})

test('rename pins the title through the sessionTitle service', () => {
  const renames: Array<{ session: unknown; name: string }> = []
  const agents = new Map([['session-a', agent('session-a')]])
  const w = writer(agents, {
    sessionTitle: {
      rename: (session: unknown, name: string) => renames.push({ session, name }),
      refresh: async () => undefined,
    },
  })
  assert.equal(w.rename('session-a', 'my title'), true)
  assert.equal(renames.length, 1)
  assert.equal((renames[0]!.session as { id: string }).id, 'session-a')
})

test('rename reports unavailable when the title service or the session is absent', () => {
  const w = writer(new Map())
  assert.equal(w.rename('session-a', 'x'), false)
  const w2 = writer(new Map([['session-a', agent('session-a')]]))
  assert.equal(w2.rename('session-a', 'x'), false, 'no sessionTitle service')
})

test('refreshTitle returns the regenerated title', async () => {
  const agents = new Map([['session-a', agent('session-a')]])
  const w = writer(agents, {
    sessionTitle: {
      rename: () => {},
      refresh: async () => ({ title: 'regenerated' }),
    },
  })
  const outcome = await w.refreshTitle('session-a', new AbortController().signal)
  assert.deepEqual(outcome, { kind: 'ok', title: 'regenerated' })
})

test('refreshTitle distinguishes unavailable from no-conversation', async () => {
  const agents = new Map([['session-a', agent('session-a')]])
  const w = writer(agents, {
    sessionTitle: {
      rename: () => {},
      refresh: async () => undefined,
    },
  })
  assert.deepEqual(await w.refreshTitle('session-a', new AbortController().signal), { kind: 'ok', title: undefined })
  const absent = writer(new Map([['session-a', agent('session-a')]]))
  assert.deepEqual(await absent.refreshTitle('session-a', new AbortController().signal), { kind: 'unavailable' })
})
