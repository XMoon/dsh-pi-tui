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

test('steerBatch removes exact queue ids before preserving Direct message order', async () => {
  const delivered: unknown[] = []
  const removed: string[] = []
  const agents = new Map([['session-a', agent('session-a', {
    inbox: { remove: (id) => removed.push(id) },
    steer: (message) => delivered.push(message),
  })]])
  const outcome = await writer(agents).steerBatch('session-a', [{ id: 'one' }, { id: 'two' }], ['queued-a', 'queued-b'])
  assert.deepEqual(outcome, { kind: 'committed', value: undefined })
  assert.deepEqual(removed, ['queued-a', 'queued-b'])
  assert.deepEqual(delivered, [{ id: 'one' }, { id: 'two' }])
})

test('removeQueued removes exactly one pulled-back message id', async () => {
  const removed: string[] = []
  const agents = new Map([['session-a', agent('session-a', { inbox: { remove: (id) => removed.push(id) } })]])
  assert.deepEqual(await writer(agents).removeQueued('session-a', 'message-1'), { kind: 'committed', value: undefined })
  assert.deepEqual(removed, ['message-1'])
})

test('removeQueuedBatch settles exact pull-back ids as one operation', async () => {
  const removed: string[] = []
  const agents = new Map([['session-a', agent('session-a', { inbox: { remove: (id) => removed.push(id) } })]])
  assert.deepEqual(await writer(agents).removeQueuedBatch('session-a', ['message-1', 'message-2']), { kind: 'committed', value: undefined })
  assert.deepEqual(removed, ['message-1', 'message-2'])
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

test('known operations reject when the session is absent', async () => {
  const w = writer(new Map())
  assert.deepEqual(await w.prompt('session-ghost', { text: 'x' }, 'queue'), {
    kind: 'rejected',
    error: { code: 'session/not-found', message: 'session "session-ghost" is not available' },
  })
  assert.deepEqual(await w.steerBatch('session-ghost', []), {
    kind: 'rejected',
    error: { code: 'session/not-found', message: 'session "session-ghost" is not available' },
  })
  assert.deepEqual(await w.removeQueued('session-ghost', 'm1'), {
    kind: 'rejected',
    error: { code: 'session/not-found', message: 'session "session-ghost" is not available' },
  })
  assert.deepEqual(await w.removeQueuedBatch('session-ghost', ['m1']), {
    kind: 'rejected',
    error: { code: 'session/not-found', message: 'session "session-ghost" is not available' },
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
