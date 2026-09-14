/**
 * Contract tests for the D2.1 pending-input read projection: Direct inbox
 * collection names stay inside the adapter, while consumers receive official
 * placement and stable occurrence identity.
 * @module @xmoon76/dsh-pi-tui/pending-input-reader.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectPendingInputReader } from '../src/runtime/direct/pending-input-reader-direct.ts'

test('normalizes Direct next-turn and next-step occurrences into official placements', () => {
  const agent = {
    session: { id: 'session-queue' },
    status: 'running',
    inbox: {
      nextTurn: [
        { id: 'queued-a', content: [{ type: 'text', text: 'A' }], source: { kind: 'user' } },
        { id: 'queued-b', content: [{ type: 'text', text: 'B' }], source: { kind: 'plugin' } },
      ],
      nextStep: [
        { id: 'steering-c', content: [{ type: 'text', text: 'C' }], source: { kind: 'user' } },
        { id: 'context-d', content: [{ type: 'text', text: 'D' }], source: { kind: 'plugin' } },
        { id: 'context-e', content: [{ type: 'text', text: 'E' }] },
      ],
    },
  }
  const reader = new DirectPendingInputReader(sessionId => sessionId === agent.session.id ? agent : undefined)

  const snapshot = reader.snapshot('session-queue')
  assert.deepEqual(snapshot, {
    running: true,
    items: [
      { id: 'queued-a', placement: 'queued', content: [{ type: 'text', text: 'A' }] },
      { id: 'queued-b', placement: 'queued', content: [{ type: 'text', text: 'B' }] },
      { id: 'steering-c', placement: 'steering', content: [{ type: 'text', text: 'C' }] },
      { id: 'context-d', placement: 'context', content: [{ type: 'text', text: 'D' }] },
      { id: 'context-e', placement: 'context', content: [{ type: 'text', text: 'E' }] },
    ],
  })
  assert.ok(snapshot !== undefined)
  assert.ok(snapshot.items.every(item => !Object.hasOwn(item, 'source')))
})

test('an unavailable Direct session has no fabricated empty snapshot', () => {
  const reader = new DirectPendingInputReader(() => undefined)
  assert.equal(reader.snapshot('missing'), undefined)
})

test('a user-origin occurrence exposes its plain rpc correlation id', () => {
  const agent = {
    session: { id: 'session-rpc' },
    status: 'running',
    inbox: {
      nextTurn: [
        { id: 'queued-a', content: [], source: { kind: 'user', rpcId: 'req-1' } },
      ],
      nextStep: [
        { id: 'steering-b', content: [], source: { kind: 'user', rpcId: 'req-2' } },
      ],
    },
  }
  const reader = new DirectPendingInputReader(sessionId => sessionId === agent.session.id ? agent : undefined)
  const snapshot = reader.snapshot('session-rpc')
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.items.find(item => item.id === 'queued-a')?.rpcId, 'req-1')
  assert.equal(snapshot.items.find(item => item.id === 'steering-b')?.rpcId, 'req-2')
})

test('a non-user or malformed rpc id is omitted and source never crosses the port', () => {
  const agent = {
    session: { id: 'session-rpc-gone' },
    status: 'idle',
    inbox: {
      nextTurn: [
        { id: 'plugin-queued', content: [], source: { kind: 'plugin', plugin: 'p', rpcId: 'leak' } },
      ],
      nextStep: [
        { id: 'user-no-rpc', content: [], source: { kind: 'user' } },
        { id: 'user-malformed', content: [], source: { kind: 'user', rpcId: 42 } },
        { id: 'user-valid', content: [], source: { kind: 'user', rpcId: 'ok' } },
      ],
    },
  }
  const reader = new DirectPendingInputReader(sessionId => sessionId === agent.session.id ? agent : undefined)
  const snapshot = reader.snapshot('session-rpc-gone')
  assert.ok(snapshot !== undefined)
  assert.ok(snapshot.items.every(item => !Object.hasOwn(item, 'source')), 'source must not cross the port')
  assert.equal(snapshot.items.find(item => item.id === 'plugin-queued')?.rpcId, undefined)
  assert.equal(snapshot.items.find(item => item.id === 'user-no-rpc')?.rpcId, undefined)
  assert.equal(snapshot.items.find(item => item.id === 'user-malformed')?.rpcId, undefined)
  assert.equal(snapshot.items.find(item => item.id === 'user-valid')?.rpcId, 'ok')
})
