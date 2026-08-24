/**
 * Adapter contract tests for the Direct session writer
 * (runtime/direct/session-writer-direct.ts, migration M1.4): the port is
 * the semantic boundary — the runner depends on `SessionWriter`, the Direct
 * adapter owns the raw agent/session operations and the `ctx.sessionTitle`
 * service, and a Remote adapter must satisfy the SAME contract in a later
 * milestone. These tests pin the contract with a fake Host context, so the
 * two backends cannot drift.
 * @module @xmoon76/dsh-pi-tui/session-writer-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSessionWriter, type HostContextLike, type SessionTitleServiceLike } from '../src/runtime/direct/session-writer-direct.ts'
import type { AgentLike, CancelAgentLike, SessionLike } from '../src/runtime/session-writer-port.ts'

function agent(overrides: Partial<AgentLike> = {}): AgentLike {
  return {
    session: { id: 'session-a' },
    followup: () => {},
    inbox: { remove: () => {} },
    ...overrides,
  }
}

function host(services: Record<string, unknown>): HostContextLike {
  return { get: (name) => services[name] }
}

test('followup delivers the prepared message to the agent', () => {
  const delivered: unknown[] = []
  const writer = new DirectSessionWriter(host({}))
  const a = agent({ followup: (message) => delivered.push(message) })
  writer.followup(a, { role: 'user', text: 'hi' })
  assert.deepEqual(delivered, [{ role: 'user', text: 'hi' }])
})

test('dequeue removes exactly the pulled-back message id', () => {
  const removed: string[] = []
  const writer = new DirectSessionWriter(host({}))
  const a = agent({ inbox: { remove: (id) => removed.push(id) } })
  writer.dequeue(a, 'message-1')
  assert.deepEqual(removed, ['message-1'])
})

test('cancel passes the reason and keepInbox through', () => {
  const calls: Array<{ reason: unknown; options: unknown }> = []
  const writer = new DirectSessionWriter(host({}))
  const a: CancelAgentLike = { cancel: (reason, options) => calls.push({ reason, options }) }
  writer.cancel(a, { kind: 'user' }, { keepInbox: true })
  assert.deepEqual(calls, [{ reason: { kind: 'user' }, options: { keepInbox: true } }])
})

test('rename pins the title through the sessionTitle service', () => {
  const renames: Array<{ session: unknown; name: string }> = []
  const titles: SessionTitleServiceLike = {
    rename: (session, name) => renames.push({ session, name }),
    refresh: async () => undefined,
  }
  const writer = new DirectSessionWriter(host({ sessionTitle: titles }))
  const session: SessionLike = { id: 'session-a' }
  assert.equal(writer.rename(session, 'my title'), true)
  assert.deepEqual(renames, [{ session, name: 'my title' }])
})

test('rename reports unavailable when the title service is absent', () => {
  const writer = new DirectSessionWriter(host({}))
  assert.equal(writer.rename({ id: 'session-a' }, 'x'), false)
})

test('refreshTitle returns the regenerated title', async () => {
  const titles: SessionTitleServiceLike = {
    rename: () => {},
    refresh: async () => ({ title: 'regenerated' }),
  }
  const writer = new DirectSessionWriter(host({ sessionTitle: titles }))
  const outcome = await writer.refreshTitle({ id: 'session-a' }, new AbortController().signal)
  assert.deepEqual(outcome, { kind: 'ok', title: 'regenerated' })
})

test('refreshTitle distinguishes unavailable from no-conversation', async () => {
  const titles: SessionTitleServiceLike = {
    rename: () => {},
    refresh: async () => undefined,
  }
  const writer = new DirectSessionWriter(host({ sessionTitle: titles }))
  assert.deepEqual(await writer.refreshTitle({ id: 'session-a' }, new AbortController().signal), { kind: 'ok', title: undefined })
  const absent = new DirectSessionWriter(host({}))
  assert.deepEqual(await absent.refreshTitle({ id: 'session-a' }, new AbortController().signal), { kind: 'unavailable' })
})

test('steer delegates to the guard-orchestrated steer seam', async () => {
  const writer = new DirectSessionWriter(host({}))
  const a = agent()
  const outcome = await writer.steer({
    currentAgent: () => a as never,
    currentGeneration: () => 1,
    guard: { run: async () => ({ kind: 'ok' }) },
    notify: () => {},
    restoreDraft: () => true,
    createDraft: () => ({ role: 'user', text: 'draft' }),
    blockedNotice: () => 'blocked',
    forcedNotice: () => 'forced',
    staleNotice: () => 'stale',
    mergedNotice: () => 'merged',
  }, 'draft text', { onlyDraft: true })
  assert.equal(outcome, 'ok')
})
