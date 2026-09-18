/**
 * Contract tests for the D2.2 Remote pending-input reader under the alpha2
 * durable inbox projection: `session.projections.faceOf('inbox')` maps onto
 * the semantic projection with order, placement, identity, and detached
 * content preserved.
 * @module @xmoon76/dsh-pi-tui/remote-pending-input-reader.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  RemotePendingInputReader,
  type RemotePendingSessionFace,
  type RemotePendingSessionsSource,
} from '../src/runtime/remote/pending-input-reader-remote.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from '../src/runtime/remote/session-reader-remote.ts'

interface GenerationHarness {
  readonly source: RemoteConnectionGenerationSource
  set(value: RemoteConnectionGeneration | undefined): void
}

function generationHarness(): GenerationHarness {
  let current: RemoteConnectionGeneration | undefined = { id: 1 }
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => current,
      subscribe: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(value) {
      current = value
      for (const listener of [...listeners]) listener()
    },
  }
}

function sessionsSource(byId: Readonly<Record<string, RemotePendingSessionFace>>): RemotePendingSessionsSource {
  return { binding: id => byId[id] === undefined ? undefined : { session: byId[id] } }
}

/** One official-shaped Session whose `inbox` projection carries `value`. */
function face(options: {
  running?: boolean
  inbox?: unknown
  onRead?: () => void
}): RemotePendingSessionFace {
  return {
    getSnapshot: () => ({ running: options.running ?? false }),
    projections: {
      faceOf: key => ({
        getSnapshot: () => {
          options.onRead?.()
          return key === 'inbox' ? options.inbox : undefined
        },
      }),
    },
  }
}

const text = (value: string): readonly unknown[] => [{ type: 'text', text: value }]

test('official Session face satisfies the pending-input boundary structurally', () => {
  const faceToRemote = (session: SessionFace): RemotePendingSessionFace => session
  assert.equal(typeof faceToRemote, 'function')
})

test('next-turn is queued and next-step splits into steering and context by source kind', () => {
  const generation = generationHarness()
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({
      running: true,
      inbox: {
        'next-turn': [
          { id: 'q-1', role: 'user', content: text('A'), source: { kind: 'user', rpcId: 'req-1' } },
          { id: 'q-2', role: 'user', content: text('B'), source: { kind: 'plugin' } },
        ],
        'next-step': [
          { id: 's-1', role: 'user', content: text('C'), source: { kind: 'user', rpcId: 'req-2' } },
          { id: 'c-plugin', role: 'user', content: text('D'), source: { kind: 'plugin' } },
          { id: 'c-model', role: 'user', content: text('E'), source: { kind: 'model' } },
          { id: 'c-tool', role: 'user', content: text('F'), source: { kind: 'tool' } },
        ],
      },
    }),
  }), generation.source)

  const snapshot = reader.snapshot('session-a')
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.running, true)
  assert.deepEqual(snapshot.items.map(item => [item.id, item.placement, item.rpcId]), [
    ['q-1', 'queued', 'req-1'],
    ['q-2', 'queued', undefined],
    ['s-1', 'steering', 'req-2'],
    ['c-plugin', 'context', undefined],
    ['c-model', 'context', undefined],
    ['c-tool', 'context', undefined],
  ])
})

test('rpcId is taken only from a user source carrying a string rpcId', () => {
  const generation = generationHarness()
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({
      inbox: {
        'next-turn': [
          { id: 'q-1', content: text('A'), source: { kind: 'user', rpcId: 'req-1' } },
          { id: 'q-2', content: text('B'), source: { kind: 'user' } },
          { id: 'q-3', content: text('C'), source: { kind: 'user', rpcId: 42 } },
          { id: 'q-4', content: text('D'), source: { kind: 'plugin', rpcId: 'req-2' } },
          // A present string crosses EXACTLY as-is, including the empty one:
          // this is the Direct adapter's rule and the plan's `typeof === string`
          // rule. An empty id simply never joins a local echo.
          { id: 'q-5', content: text('E'), source: { kind: 'user', rpcId: '' } },
        ],
        'next-step': [],
      },
    }),
  }), generation.source)
  const snapshot = reader.snapshot('session-a')
  assert.ok(snapshot !== undefined)
  assert.deepEqual(snapshot.items.map(item => item.rpcId), ['req-1', undefined, undefined, undefined, ''])
})

test('content is detached and frozen so Client-owned nested values cannot escape', () => {
  const generation = generationHarness()
  const content = text('original')
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({ inbox: { 'next-turn': [{ id: 'q-1', content, source: { kind: 'user' } }], 'next-step': [] } }),
  }), generation.source)
  const snapshot = reader.snapshot('session-a')
  assert.ok(snapshot !== undefined)
  assert.notEqual(snapshot.items[0]?.content, content)
  assert.deepEqual(snapshot.items[0]?.content, content)
  assert.ok(Object.isFrozen(snapshot.items[0]?.content))
  assert.ok(Object.isFrozen((snapshot.items[0]?.content as readonly { text: string }[])[0]))
})

test('placement is derived only from the inbox list and source kind, never from running', () => {
  const generation = generationHarness()
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({
      running: true,
      inbox: { 'next-turn': [], 'next-step': [{ id: 's-1', content: text('A'), source: { kind: 'user' } }] },
    }),
  }), generation.source)
  const snapshot = reader.snapshot('session-a')
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.running, true)
  assert.equal(snapshot.items[0]?.placement, 'steering')
})

test('an empty durable inbox is an empty projection, never undefined', () => {
  const generation = generationHarness()
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({ inbox: { 'next-turn': [], 'next-step': [] } }),
  }), generation.source)
  assert.deepEqual(reader.snapshot('session-a'), { running: false, items: [] })
})

test('an absent inbox projection baseline is an empty projection', () => {
  const generation = generationHarness()
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({ inbox: undefined }),
  }), generation.source)
  assert.deepEqual(reader.snapshot('session-a'), { running: false, items: [] })
})

test('an absent binding has no fabricated snapshot', () => {
  const generation = generationHarness()
  const reader = new RemotePendingInputReader(sessionsSource({}), generation.source)
  assert.equal(reader.snapshot('missing'), undefined)
})

test('a replaced generation is unavailable rather than stale data', () => {
  const generation = generationHarness()
  const generationAtRead: RemoteConnectionGeneration = { id: 1 }
  generation.set(generationAtRead)
  const session = face({
    inbox: { 'next-turn': [{ id: 'q-1', content: text('A'), source: { kind: 'user' } }], 'next-step': [] },
    onRead: () => { generation.set({ id: 2 }) },
  })
  const reader = new RemotePendingInputReader(sessionsSource({ 'session-a': session }), generation.source)
  assert.equal(reader.snapshot('session-a'), undefined)
})

test('a disconnected generation has no snapshot', () => {
  const generation = generationHarness()
  generation.set(undefined)
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({ inbox: { 'next-turn': [], 'next-step': [] } }),
  }), generation.source)
  assert.equal(reader.snapshot('session-a'), undefined)
})

test('Direct inbox collection names never appear in the projection', () => {
  const generation = generationHarness()
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({
      inbox: { 'next-turn': [{ id: 'q-1', content: text('A'), source: { kind: 'user' } }], 'next-step': [] },
    }),
  }), generation.source)
  const snapshot = reader.snapshot('session-a')
  assert.ok(snapshot !== undefined)
  assert.ok(snapshot.items.every(item => !Object.hasOwn(item, 'nextTurn') && !Object.hasOwn(item, 'nextStep')))
})

test('a PRESENT inbox value violating the official shape is a contract error, never an empty queue', () => {
  const generation = generationHarness()
  // `undefined` alone means "no baseline yet" (reads empty). Every other
  // non-conforming value is a wire-contract violation: reporting it as an empty
  // queue would hide durable input the Host may still execute, and reusing
  // `undefined` would mislabel a live session as unavailable.
  for (const inbox of [42, 'not-an-object', null, [], { 'next-turn': 'not-an-array', 'next-step': [] }, { 'next-turn': [], 'next-step': { nope: true } }, {}, { 'next-turn': [] }]) {
    const reader = new RemotePendingInputReader(sessionsSource({ 'session-a': face({ inbox }) }), generation.source)
    assert.throws(
      () => reader.snapshot('session-a'),
      /inbox projection is malformed/u,
      `inbox=${JSON.stringify(inbox)} must fail loudly`,
    )
  }
})

test('a PRESENT inbox row violating the official shape is a contract error, never a dropped row', () => {
  const generation = generationHarness()
  for (const row of [{ id: '', content: text('x') }, { id: 'q-1', content: 'not-an-array' }, { content: text('x') }, 'not-a-message', null, 7]) {
    const reader = new RemotePendingInputReader(sessionsSource({
      'session-a': face({ inbox: { 'next-turn': [row], 'next-step': [] } }),
    }), generation.source)
    assert.throws(
      () => reader.snapshot('session-a'),
      /inbox projection is malformed/u,
      `row=${JSON.stringify(row)} must fail loudly`,
    )
  }
})
