/**
 * Adapter contract tests for the Direct session writer (D2.1): the port is
 * identity-based, semantic and outcome-bearing. Direct resolves the live
 * Agent through the runner-injected resolver; the tests pin the operation
 * vocabulary and the Direct behavior.
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
    status: 'running',
    inbox: { nextTurn: [], nextStep: [], replace: () => true, remove: () => true },
    ...overrides,
  }
}

function writer(
  agents: Map<string, LiveAgentLike>,
  services: Record<string, unknown> = {},
  queueAgents: Map<string, LiveAgentLike> = agents,
) {
  return new DirectSessionWriter(
    host(services),
    (sessionId) => agents.get(sessionId),
    (sessionId) => queueAgents.get(sessionId),
  )
}

test('prompt delivers one prepared message with the caller-selected mode', async () => {
  const delivered: Array<{ mode: string; message: unknown }> = []
  const agents = new Map([['session-a', agent('session-a', {
    followup: (message) => delivered.push({ mode: 'queue', message }),
    steer: (message) => delivered.push({ mode: 'steer', message }),
  })]])
  const w = writer(agents)
  assert.deepEqual(await w.prompt('session-a', { role: 'user', text: 'queued' }, 'queue'), { kind: 'committed', value: undefined })
  assert.deepEqual(await w.prompt('session-a', { role: 'user', text: 'steered' }, 'steer'), { kind: 'committed', value: undefined })
  assert.deepEqual(delivered, [
    { mode: 'queue', message: { role: 'user', text: 'queued' } },
    { mode: 'steer', message: { role: 'user', text: 'steered' } },
  ])
})

test('updateQueue steers one exact next-turn occurrence', async () => {
  const delivered: unknown[] = []
  const removed: string[] = []
  const one = { id: 'one', role: 'user' as const, content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }
  const agents = new Map([['session-a', agent('session-a', {
    inbox: {
      nextTurn: [one, { id: 'two' }, { id: 'message-1' }, { id: 'message-2' }],
      nextStep: [],
      replace: () => true,
      remove: (id) => { removed.push(id); return true },
    },
    steer: (message) => delivered.push(message),
  })]])
  const outcome = await writer(agents).updateQueue('session-a', 'one', { kind: 'steer' })
  assert.deepEqual(outcome, { kind: 'committed', value: undefined })
  assert.deepEqual(removed, ['one'])
  assert.deepEqual(delivered, [one])
})

test('updateQueue steer rejects an idle turn without removing or replaying the occurrence', async () => {
  const removed: string[] = []
  const delivered: unknown[] = []
  const message = { id: 'message-1' }
  const agents = new Map([['session-a', agent('session-a', {
    status: 'idle',
    inbox: { nextTurn: [message], nextStep: [], replace: () => true, remove: (id) => { removed.push(id); return true } },
    steer: (value) => delivered.push(value),
  })]])
  assert.deepEqual(await writer(agents).updateQueue('session-a', 'message-1', { kind: 'steer' }), {
    kind: 'rejected',
    error: { code: 'session/steer-unavailable', message: 'queued item "message-1" cannot be steered while the session is not running' },
  })
  assert.deepEqual(removed, [])
  assert.deepEqual(delivered, [])
})

test('updateQueue rejects a missing occurrence without inventing a message', async () => {
  const agents = new Map([['session-a', agent('session-a')]])
  assert.deepEqual(await writer(agents).updateQueue('session-a', 'missing', { kind: 'remove' }), {
    kind: 'rejected',
    error: { code: 'session/queue-item-not-found', message: 'queued item "missing" is no longer pending' },
  })
})

test('updateQueue edit preserves occurrence metadata while replacing content in place', async () => {
  const original = {
    id: 'message-1',
    role: 'user' as const,
    content: [{ type: 'text', text: 'old' }],
    source: { kind: 'plugin', plugin: 'reviewer' },
  }
  let replacement: unknown
  const agents = new Map([['session-a', agent('session-a', {
    inbox: {
      nextTurn: [original, { id: 'message-2' }],
      nextStep: [],
      replace: (_id, message) => { replacement = message; return true },
      remove: () => true,
    },
  })]])
  assert.deepEqual(await writer(agents).updateQueue('session-a', 'message-1', {
    kind: 'edit',
    content: [{ type: 'text', text: 'new' }],
  }), { kind: 'committed', value: undefined })
  assert.deepEqual(replacement, {
    ...original,
    content: [{ type: 'text', text: 'new' }],
  })
})

test('updateQueue remove handles next-turn and next-step occurrences', async () => {
  const removed: string[] = []
  const agents = new Map([['session-a', agent('session-a', {
    inbox: {
      nextTurn: [{ id: 'message-1' }, { id: 'message-2' }],
      nextStep: [{ id: 'message-3' }],
      replace: () => true,
      remove: (id) => { removed.push(id); return true },
    },
  })]])
  const w = writer(agents)
  assert.deepEqual(await w.updateQueue('session-a', 'message-1', { kind: 'remove' }), { kind: 'committed', value: undefined })
  assert.deepEqual(await w.updateQueue('session-a', 'message-3', { kind: 'remove' }), { kind: 'committed', value: undefined })
  assert.deepEqual(removed, ['message-1', 'message-3'])
})

test('updateQueue reports queue-item-not-found when an atomic edit or remove misses', async () => {
  const message = { id: 'message-1' }
  const agents = new Map([['session-a', agent('session-a', {
    inbox: {
      nextTurn: [message],
      nextStep: [],
      replace: () => false,
      remove: () => false,
    },
  })]])
  const w = writer(agents)
  assert.deepEqual(await w.updateQueue('session-a', 'message-1', { kind: 'edit', content: [] }), {
    kind: 'rejected',
    error: { code: 'session/queue-item-not-found', message: 'queued item "message-1" is no longer pending' },
  })
  assert.deepEqual(await w.updateQueue('session-a', 'message-1', { kind: 'remove' }), {
    kind: 'rejected',
    error: { code: 'session/queue-item-not-found', message: 'queued item "message-1" is no longer pending' },
  })
})

test('updateQueue edit settles indeterminate when Inbox.replace throws', async () => {
  const failure = new Error('replace failed')
  const agents = new Map([['session-a', agent('session-a', {
    inbox: {
      nextTurn: [{ id: 'message-1' }],
      nextStep: [],
      replace: () => { throw failure },
      remove: () => true,
    },
  })]])
  assert.deepEqual(await writer(agents).updateQueue('session-a', 'message-1', { kind: 'edit', content: [] }), {
    kind: 'indeterminate',
    error: { code: 'session/write-indeterminate', message: 'replace failed' },
  })
})

test('updateQueue remove settles indeterminate when Inbox.remove throws', async () => {
  const failure = new Error('remove failed')
  const agents = new Map([['session-a', agent('session-a', {
    inbox: {
      nextTurn: [{ id: 'message-1' }],
      nextStep: [],
      replace: () => true,
      remove: () => { throw failure },
    },
  })]])
  assert.deepEqual(await writer(agents).updateQueue('session-a', 'message-1', { kind: 'remove' }), {
    kind: 'indeterminate',
    error: { code: 'session/write-indeterminate', message: 'remove failed' },
  })
})

test('updateQueue steer settles indeterminate when Inbox.remove throws before steering', async () => {
  let steered = 0
  const failure = new Error('remove failed')
  const agents = new Map([['session-a', agent('session-a', {
    inbox: {
      nextTurn: [{ id: 'message-1' }],
      nextStep: [],
      replace: () => true,
      remove: () => { throw failure },
    },
    steer: () => { steered += 1 },
  })]])
  assert.deepEqual(await writer(agents).updateQueue('session-a', 'message-1', { kind: 'steer' }), {
    kind: 'indeterminate',
    error: { code: 'session/write-indeterminate', message: 'remove failed' },
  })
  assert.equal(steered, 0)
})

test('updateQueue steer never calls Agent.steer when atomic removal misses', async () => {
  let steered = 0
  const agents = new Map([['session-a', agent('session-a', {
    inbox: { nextTurn: [{ id: 'message-1' }], nextStep: [], replace: () => true, remove: () => false },
    steer: () => { steered += 1 },
  })]])
  assert.deepEqual(await writer(agents).updateQueue('session-a', 'message-1', { kind: 'steer' }), {
    kind: 'rejected',
    error: { code: 'session/queue-item-not-found', message: 'queued item "message-1" is no longer pending' },
  })
  assert.equal(steered, 0)
})

test('cancel hides Direct reason and keepInbox knobs while preserving their behavior', async () => {
  const calls: Array<{ reason: unknown; options: unknown }> = []
  const agents = new Map([['session-a', agent('session-a', { cancel: (reason, options) => calls.push({ reason, options }) })]])
  assert.deepEqual(await writer(agents).cancel('session-a'), { kind: 'committed', value: undefined })
  assert.deepEqual(calls, [{ reason: { kind: 'user' }, options: { keepInbox: true } }])
})

test('operations address the agent resolved by session id at call time', async () => {
  const delivered: unknown[] = []
  const agents = new Map<string, LiveAgentLike>([['session-a', agent('session-a', { followup: (message) => delivered.push(message) })]])
  const w = writer(agents)
  await w.prompt('session-a', { text: 'one' }, 'queue')
  const next = agent('session-a', { followup: (message) => delivered.push(message) })
  agents.set('session-a', next)
  await w.prompt('session-a', { text: 'two' }, 'queue')
  assert.deepEqual(delivered, [{ text: 'one' }, { text: 'two' }])
})

test('updateQueue uses its child resolver without widening ordinary prompt authority', async () => {
  const delivered: unknown[] = []
  const removed: string[] = []
  const child = agent('child', {
    inbox: {
      nextTurn: [{ id: 'child-queued' }, { id: 'child-remove' }],
      nextStep: [],
      replace: () => true,
      remove: id => { removed.push(id); return true },
    },
    steer: message => delivered.push(message),
  })
  const w = writer(new Map(), {}, new Map([['child', child]]))

  assert.deepEqual(await w.prompt('child', { text: 'must remain parent-authorized' }, 'queue'), {
    kind: 'rejected',
    error: { code: 'session/not-found', message: 'session "child" is not available' },
  })
  assert.deepEqual(await w.updateQueue('child', 'child-queued', { kind: 'steer' }), { kind: 'committed', value: undefined })
  assert.deepEqual(await w.updateQueue('child', 'child-remove', { kind: 'remove' }), { kind: 'committed', value: undefined })
  assert.deepEqual(removed, ['child-queued', 'child-remove'])
  assert.deepEqual(delivered, [{ id: 'child-queued' }])
})

test('known operations reject when the session is absent', async () => {
  const w = writer(new Map())
  assert.deepEqual(await w.prompt('session-ghost', { text: 'x' }, 'queue'), {
    kind: 'rejected',
    error: { code: 'session/not-found', message: 'session "session-ghost" is not available' },
  })
  assert.deepEqual(await w.updateQueue('session-ghost', 'm1', { kind: 'steer' }), {
    kind: 'rejected',
    error: { code: 'session/queue-item-not-found', message: 'queued item "m1" is no longer pending' },
  })
  assert.deepEqual(await w.updateQueue('session-ghost', 'm1', { kind: 'remove' }), {
    kind: 'rejected',
    error: { code: 'session/queue-item-not-found', message: 'queued item "m1" is no longer pending' },
  })
  assert.deepEqual(await w.cancel('session-ghost'), {
    kind: 'rejected',
    error: { code: 'session/not-found', message: 'session "session-ghost" is not available' },
  })
})

test('rename returns the accepted normalized title from the sessionTitle service', async () => {
  const renames: Array<{ session: unknown; name: string }> = []
  const agents = new Map([['session-a', agent('session-a')]])
  const w = writer(agents, {
    sessionTitle: {
      rename: (session: unknown, name: string) => {
        renames.push({ session, name })
        return { title: 'normalized title' }
      },
      refresh: async () => undefined,
    },
  })
  assert.deepEqual(await w.rename('session-a', 'my title'), { kind: 'committed', value: { title: 'normalized title' } })
  assert.equal(renames.length, 1)
  assert.equal((renames[0]!.session as { id: string }).id, 'session-a')
})

test('rename rejects when the title service or the session is absent', async () => {
  const noService = writer(new Map([['session-a', agent('session-a')]]))
  assert.deepEqual(await noService.rename('session-a', 'x'), {
    kind: 'rejected',
    error: { code: 'service/unavailable', message: 'session title service unavailable' },
  })
  const noSession = writer(new Map(), { sessionTitle: { rename: () => ({ title: 'x' }), refresh: async () => undefined } })
  assert.deepEqual(await noSession.rename('session-a', 'x'), {
    kind: 'rejected',
    error: { code: 'session/not-found', message: 'session "session-a" is not available' },
  })
})

test('refreshTitle returns the regenerated title or explicit unsupported settlement', async () => {
  const agents = new Map([['session-a', agent('session-a')]])
  const w = writer(agents, {
    sessionTitle: {
      rename: () => ({ title: 'x' }),
      refresh: async () => ({ title: 'regenerated' }),
    },
  })
  assert.deepEqual(await w.refreshTitle('session-a', new AbortController().signal), { kind: 'ok', title: 'regenerated' })
  const absent = writer(new Map([['session-a', agent('session-a')]]))
  assert.deepEqual(await absent.refreshTitle('session-a', new AbortController().signal), { kind: 'unsupported', reason: 'session title service unavailable' })
})

test('unexpected Direct write exceptions reject instead of claiming committed', async () => {
  const failure = new Error('invariant failure')
  const w = writer(new Map([['session-a', agent('session-a', { followup: () => { throw failure } })]]))
  await assert.rejects(w.prompt('session-a', { text: 'x' }, 'queue'), failure)
})

test('updateQueue steer returns indeterminate when steering throws after removal', async () => {
  const failure = new Error('steer invariant failure')
  const removed: string[] = []
  const agents = new Map([['session-a', agent('session-a', {
    inbox: { nextTurn: [{ id: 'message-1' }], nextStep: [], replace: () => true, remove: (id) => {
      removed.push(id)
      return true
    } },
    steer: () => { throw failure },
  })]])
  assert.deepEqual(await writer(agents).updateQueue('session-a', 'message-1', { kind: 'steer' }), {
    kind: 'indeterminate',
    error: { code: 'session/write-indeterminate', message: 'steer invariant failure' },
  })
  assert.deepEqual(removed, ['message-1'], 'the exact occurrence was removed before the uncertain steer')
})
