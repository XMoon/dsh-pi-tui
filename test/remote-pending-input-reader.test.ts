/**
 * Contract tests for the D2.2 Remote pending-input reader: the official Client
 * Session queue snapshot maps onto the semantic projection with order, placement,
 * identity, and detached content preserved.
 * @module @xmoon76/dsh-pi-tui/remote-pending-input-reader.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionFace } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  RemotePendingInputReader,
  type RemotePendingSessionFace,
  type RemotePendingSessionSnapshot,
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

function face(snapshot: { running: boolean; queue: readonly unknown[] }): RemotePendingSessionFace {
  return { getSnapshot: () => snapshot as RemotePendingSessionSnapshot }
}

test('official Session face satisfies the pending-input boundary structurally', () => {
  const faceToRemote = (session: SessionFace): RemotePendingSessionFace => session
  assert.equal(typeof faceToRemote, 'function')
})

test('official queue order and placement are preserved verbatim', () => {
  const generation = generationHarness()
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({
      running: true,
      queue: [
        { id: 'q-1', messageId: 'm-1', placement: 'queued', rpcId: 'req-1', content: [{ type: 'text', text: 'A' }], preview: 'A', text: 'A' },
        { id: 's-1', messageId: 'm-2', placement: 'steering', content: [{ type: 'text', text: 'B' }], preview: 'B', text: 'B' },
        { id: 'c-1', messageId: 'm-3', placement: 'context', content: [{ type: 'text', text: 'C' }], preview: 'C', text: 'C' },
      ],
    }),
  }), generation.source)

  const snapshot = reader.snapshot('session-a')
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.running, true)
  assert.deepEqual(snapshot.items.map(item => [item.id, item.placement, item.rpcId]), [
    ['q-1', 'queued', 'req-1'],
    ['s-1', 'steering', undefined],
    ['c-1', 'context', undefined],
  ])
})

test('content is detached and frozen so Client-owned nested values cannot escape', () => {
  const generation = generationHarness()
  const content = [{ type: 'text', text: 'original' }]
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({ running: false, queue: [{ id: 'q-1', placement: 'queued', content }] }),
  }), generation.source)
  const snapshot = reader.snapshot('session-a')
  assert.ok(snapshot !== undefined)
  assert.notEqual(snapshot.items[0]?.content, content)
  assert.deepEqual(snapshot.items[0]?.content, content)
  assert.ok(Object.isFrozen(snapshot.items[0]?.content))
  assert.ok(Object.isFrozen((snapshot.items[0]?.content as readonly { text: string }[])[0]))
})

test('an empty authoritative queue is an empty projection, never undefined', () => {
  const generation = generationHarness()
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({ running: false, queue: [] }),
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
  const session: RemotePendingSessionFace = {
    getSnapshot: () => {
      generation.set({ id: 2 })
      return { running: false, queue: [{ id: 'q-1', placement: 'queued', content: [] }] }
    },
  }
  const reader = new RemotePendingInputReader(sessionsSource({ 'session-a': session }), generation.source)
  assert.equal(reader.snapshot('session-a'), undefined)
})

test('a disconnected generation has no snapshot', () => {
  const generation = generationHarness()
  generation.set(undefined)
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({ running: false, queue: [] }),
  }), generation.source)
  assert.equal(reader.snapshot('session-a'), undefined)
})

test('placement is never inferred from running and Direct inbox names never appear', () => {
  const generation = generationHarness()
  const reader = new RemotePendingInputReader(sessionsSource({
    'session-a': face({
      running: true,
      queue: [{ id: 'c-1', placement: 'context', content: [] }],
    }),
  }), generation.source)
  const snapshot = reader.snapshot('session-a')
  assert.ok(snapshot !== undefined)
  assert.equal(snapshot.items[0]?.placement, 'context')
  assert.ok(snapshot.items.every(item => !Object.hasOwn(item, 'nextTurn') && !Object.hasOwn(item, 'nextStep')))
})
