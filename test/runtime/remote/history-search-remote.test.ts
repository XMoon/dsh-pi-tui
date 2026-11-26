/**
 * The Remote `piTuiHistorySearch` read adapter: one transport boundary, one
 * typed outcome vocabulary. These are structural L3 adapter cases; the real
 * generated namespace and Owner gate are proved by the Host suite and the
 * packed lane, not here.
 *
 * @module @xmoon76/dsh-pi-tui/history-search-remote.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteError, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  RemoteHistorySearchDeniedError,
  RemoteHistorySearchFailedError,
  RemoteHistorySearchPort,
  RemoteHistorySearchSupersededError,
  type RemoteHistorySearchNamespace,
} from '../../../src/runtime/remote/history-search-remote.ts'
import type { RemoteConnectionGenerationSource } from '../../../src/runtime/remote/session-reader-remote.ts'
import type {
  HistoryReadTextRequest,
  HistorySearchRequest,
} from '../../../src/runtime/remote/pi-tui-history-search-contract.ts'

const SEARCH: HistorySearchRequest = { scope: 'all', query: 'needle', limit: 25 }
const READ: HistoryReadTextRequest = {
  sessionId: 's1',
  messageId: 'm1',
  contentSha256: 'a'.repeat(64),
  offset: 0,
  limit: 16,
}

function generationOf(id: string): RemoteConnectionGenerationSource {
  const current = { id }
  return {
    getSnapshot: () => current,
    subscribe: () => () => {},
  }
}

function failure(code: string, message: string): RemoteResult<never> {
  return { ok: false, error: new RemoteError(code as never, message, {} as never) }
}

function namespaceOf(overrides: Partial<RemoteHistorySearchNamespace>): RemoteHistorySearchNamespace {
  return {
    search: async () => ({ ok: true, value: { kind: 'ready', generation: 'g', items: [], nextCursor: null } }),
    readText: async () => ({ ok: true, value: { kind: 'ready', chunk: 'x', nextOffset: null, contentLength: 1 } }),
    ...overrides,
  }
}

test('a missing private namespace is a truthful service-missing answer', async () => {
  const port = new RemoteHistorySearchPort(undefined, generationOf('g'))
  assert.deepEqual(await port.search(SEARCH, new AbortController().signal),
    { kind: 'unavailable', reason: 'service-missing' })
  assert.deepEqual(await port.readText(READ, new AbortController().signal),
    { kind: 'unavailable', reason: 'service-missing' })
})

test('a mounted namespace answer crosses unchanged and receives the caller signal', async () => {
  let received: AbortSignal | undefined
  const controller = new AbortController()
  const port = new RemoteHistorySearchPort(namespaceOf({
    search: async (_request, signal) => {
      received = signal
      return { ok: true, value: { kind: 'incomplete', reason: 'reconciling' } }
    },
  }), generationOf('g'))
  assert.deepEqual(await port.search(SEARCH, controller.signal), { kind: 'incomplete', reason: 'reconciling' })
  assert.equal(received, controller.signal)
})

test('an unregistered method is service-missing while a non-Owner refusal stays distinct', async () => {
  const missing = new RemoteHistorySearchPort(namespaceOf({
    search: async () => failure('gateway/invocation-unavailable', 'missing'),
  }), generationOf('g'))
  assert.deepEqual(await missing.search(SEARCH, new AbortController().signal),
    { kind: 'unavailable', reason: 'service-missing' })

  const denied = new RemoteHistorySearchPort(namespaceOf({
    search: async () => failure('remote-access/denied', 'denied'),
  }), generationOf('g'))
  await assert.rejects(denied.search(SEARCH, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof RemoteHistorySearchDeniedError)
    return true
  })

  const failed = new RemoteHistorySearchPort(namespaceOf({
    readText: async () => failure('gateway/internal', 'boom'),
  }), generationOf('g'))
  await assert.rejects(failed.readText(READ, new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof RemoteHistorySearchFailedError)
    assert.equal(error.code, 'gateway/internal')
    return true
  })
})

test('a carrier cancellation without a caller abort is a superseded read, never an empty answer', async () => {
  const port = new RemoteHistorySearchPort(namespaceOf({
    search: async () => failure('gateway/cancelled', 'cancelled'),
  }), generationOf('g'))
  await assert.rejects(port.search(SEARCH, new AbortController().signal), RemoteHistorySearchSupersededError)
})

test('a replaced generation discards both a late success and a late failure', async () => {
  let generation = { id: 'g1' }
  const source: RemoteConnectionGenerationSource = {
    getSnapshot: () => generation,
    subscribe: () => () => {},
  }
  let resolveSearch: ((value: { ok: true; value: { kind: 'ready'; generation: string; items: never[]; nextCursor: null } }) => void) | undefined
  const port = new RemoteHistorySearchPort(namespaceOf({
    search: async () => await new Promise((resolve) => { resolveSearch = resolve }),
  }), source)
  const pending = port.search(SEARCH, new AbortController().signal)
  generation = { id: 'g2' }
  resolveSearch?.({ ok: true, value: { kind: 'ready', generation: 'late', items: [], nextCursor: null } })
  await assert.rejects(pending, RemoteHistorySearchSupersededError)

  let rejectRead: ((error: unknown) => void) | undefined
  const failing = new RemoteHistorySearchPort(namespaceOf({
    readText: async () => await new Promise((_resolve, reject) => { rejectRead = reject }),
  }), source)
  const read = failing.readText(READ, new AbortController().signal)
  generation = { id: 'g3' }
  rejectRead?.(new RemoteError('gateway/internal' as never, 'late', {} as never))
  await assert.rejects(read, RemoteHistorySearchSupersededError)
})

test('a caller abort is observed before dispatch and after a late carrier answer', async () => {
  let calls = 0
  const port = new RemoteHistorySearchPort(namespaceOf({
    search: async () => {
      calls += 1
      return { ok: true, value: { kind: 'ready', generation: 'g', items: [], nextCursor: null } }
    },
  }), generationOf('g'))
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(port.search(SEARCH, aborted.signal), { name: 'AbortError' })
  assert.equal(calls, 0, 'an already-aborted request never dispatches')

  const late = new AbortController()
  let resolveLate: ((value: { ok: true; value: { kind: 'ready'; generation: string; items: never[]; nextCursor: null } }) => void) | undefined
  const hanging = new RemoteHistorySearchPort(namespaceOf({
    search: async () => await new Promise((resolve) => { resolveLate = resolve }),
  }), generationOf('g'))
  const pending = hanging.search(SEARCH, late.signal)
  late.abort()
  resolveLate?.({ ok: true, value: { kind: 'ready', generation: 'late', items: [], nextCursor: null } })
  await assert.rejects(pending, { name: 'AbortError' })
})
