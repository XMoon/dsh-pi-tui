/**
 * The shared Client-local Remote History seat: page/More, stale recovery,
 * exact-body readiness and the one captured-scope retirement. The real Host
 * read is covered by the Host suite and the packed lane; these are the Client
 * state-machine cases both renderers consume.
 *
 * @module @xmoon76/dsh-pi-tui/remote-search-seat.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  createRemoteHistorySeat,
  type RemoteHistorySeat,
} from '../../src/runtime/history-search-seat.ts'
import type { RemoteHistoryOpenScope } from '../../src/client/history/remote-scope.ts'
import type { HistorySearchReadPort } from '../../src/runtime/history-search-read-port.ts'
import type {
  HistoryReadTextRequest,
  HistoryReadTextResponse,
  HistorySearchItem,
  HistorySearchRequest,
  HistorySearchResponse,
} from '../../src/runtime/remote/pi-tui-history-search-contract.ts'
import {
  RemoteHistorySearchDeniedError,
  RemoteHistorySearchFailedError,
} from '../../src/runtime/remote/history-search-remote.ts'

const DIAG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

function sha(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function item(index: number, text: string): HistorySearchItem {
  return {
    sessionId: 'session-a',
    messageId: `message-${String(index)}`,
    firstEventSeq: index,
    acceptedAt: 1_000 + index,
    effectiveCwd: '/repo/host',
    preview: text.slice(0, 12),
    contentLength: text.length,
    contentSha256: sha(text),
    hasNonText: false,
  }
}

type Response = HistorySearchResponse | (() => Promise<HistorySearchResponse>)

class FakeRead implements HistorySearchReadPort {
  readonly calls: HistorySearchRequest[] = []
  readonly readCalls: HistoryReadTextRequest[] = []
  readonly responses: Response[] = []
  body: (request: HistoryReadTextRequest) => HistoryReadTextResponse = (request) => ({
    kind: 'ready',
    chunk: 'x',
    nextOffset: null,
    contentLength: 1,
  })

  async search(request: HistorySearchRequest): Promise<HistorySearchResponse> {
    this.calls.push(request)
    const next = this.responses.shift()
    if (next === undefined) throw new Error('unexpected search')
    return typeof next === 'function' ? await next() : next
  }

  async readText(request: HistoryReadTextRequest): Promise<HistoryReadTextResponse> {
    this.readCalls.push(request)
    return this.body(request)
  }
}

interface FakeScope {
  readonly scope: RemoteHistoryOpenScope
  setCurrent(current: boolean): void
  setDirectory(next: { available: boolean; cwd?: string; reason?: string }): void
  notify(): void
  readonly disposeCalls: () => number
}

function makeScope(initialScope: 'session' | 'all', directory: { available: boolean; cwd?: string; reason?: string }): FakeScope {
  let current = true
  let dir = directory
  let disposes = 0
  const listeners = new Set<() => void>()
  return {
    scope: {
      initialScope,
      directory: () => dir,
      isCurrent: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      dispose: () => { disposes += 1 },
    },
    setCurrent(next) { current = next },
    setDirectory(next) { dir = next },
    notify() { for (const listener of [...listeners]) listener() },
    disposeCalls: () => disposes,
  }
}

function seatOf(read: FakeRead, scope: FakeScope, overrides: {
  sessionId?: string | undefined
  onRetire?: () => void
  debounceMs?: number
  refreshMs?: number
} = {}): RemoteHistorySeat {
  return createRemoteHistorySeat({
    read,
    diag: DIAG,
    sessionId: overrides.sessionId ?? 'session-a',
    scope: scope.scope,
    onRetire: overrides.onRetire ?? (() => {}),
    debounceMs: overrides.debounceMs ?? 1,
    refreshMs: overrides.refreshMs ?? 50,
  })
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timeout: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('a page commits, More appends once and the selected identity survives', async () => {
  const read = new FakeRead()
  const first = Array.from({ length: 25 }, (_, index) => item(index, `row ${String(index)}`))
  const next = Array.from({ length: 5 }, (_, index) => item(25 + index, `row ${String(25 + index)}`))
  read.responses.push({ kind: 'ready', generation: 'g1', items: first, nextCursor: 'cursor-1' })
  read.responses.push({ kind: 'ready', generation: 'g1', items: next, nextCursor: null })
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  const seat = seatOf(read, scope)
  seat.open('session', 'row')
  await waitFor(() => seat.view().status === 'ready' && seat.view().rows.length === 25, 'first page')
  assert.equal(seat.view().hasMore, true)
  assert.equal(seat.view().selectedId, first[0]!.sessionId + '\u0000' + first[0]!.messageId)
  assert.deepEqual(read.calls[0], { scope: 'session', sessionId: 'session-a', query: 'row', limit: 25 })

  seat.more()
  await waitFor(() => seat.view().rows.length === 30, 'more page')
  assert.equal(seat.view().hasMore, false)
  assert.equal(seat.view().selectedId, first[0]!.sessionId + '\u0000' + first[0]!.messageId)
  assert.equal(read.calls[1]?.cursor, 'cursor-1')
  assert.equal(seat.view().rows[24]?.messageId, 'message-24')
  assert.equal(seat.view().rows[25]?.messageId, 'message-25')
  seat.close()
})

test('a too-long query never dispatches and both scopes map exactly', async () => {
  const read = new FakeRead()
  const scope = makeScope('session', { available: false, reason: 'workspace-not-confirmed' })
  const seat = seatOf(read, scope)
  seat.open('session', 'x'.repeat(257))
  await waitFor(() => seat.view().status === 'too-long', 'too-long')
  assert.equal(read.calls.length, 0)
  assert.equal(read.readCalls.length, 0)

  seat.setQuery('short')
  seat.setScope('current')
  await waitFor(() => seat.view().status === 'unavailable', 'unavailable directory')
  assert.equal(read.calls.length, 0, 'an unavailable Directory is refused locally')

  seat.setScope('all')
  read.responses.push({ kind: 'ready', generation: 'g1', items: [item(1, 'visible history')], nextCursor: null })
  seat.setQuery('visible')
  await waitFor(() => seat.view().status === 'ready' && seat.view().rows.length === 1, 'all scope')
  assert.equal(read.calls.at(-1)?.scope, 'all')
  seat.close()
})

test('the selected body is read in bounded chunks and becomes exact only after the hash matches', async () => {
  const read = new FakeRead()
  const text = 'the exact accepted body'
  read.responses.push({ kind: 'ready', generation: 'g1', items: [item(7, text)], nextCursor: null })
  read.body = (request) => {
    if (request.offset === 0) {
      return { kind: 'ready', chunk: text.slice(0, 5), nextOffset: 5, contentLength: text.length }
    }
    return { kind: 'ready', chunk: text.slice(5), nextOffset: null, contentLength: text.length }
  }
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  const seat = seatOf(read, scope)
  seat.open('session', 'exact')
  await waitFor(() => seat.view().body.kind === 'ready', 'body ready')
  const body = seat.view().body
  assert.equal(body.kind, 'ready')
  if (body.kind !== 'ready') throw new Error('expected ready')
  assert.equal(body.text, text)
  assert.deepEqual(read.readCalls.map(call => call.offset), [0, 5])
  assert.ok(read.readCalls.every(call => call.contentSha256 === sha(text)))
  seat.close()
})

test('a wrong body hash or length fails closed instead of exposing a truncated body', async () => {
  const read = new FakeRead()
  const text = 'the exact accepted body'
  read.responses.push({ kind: 'ready', generation: 'g1', items: [item(8, text)], nextCursor: null })
  read.body = () => ({ kind: 'ready', chunk: 'x'.repeat(text.length), nextOffset: null, contentLength: text.length })
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  const seat = seatOf(read, scope)
  seat.open('session', 'exact')
  await waitFor(() => seat.view().body.kind === 'failed', 'body failure')
  const body = seat.view().body
  assert.equal(body.kind, 'failed')
  if (body.kind !== 'failed') throw new Error('expected failed')
  assert.match(body.message, /hash/u)
  assert.equal(seat.view().status, 'ready', 'the result page remains usable for a Retry of the body')
  seat.close()
})

test('a stale More auto-refreshes the first page at most once, then surfaces Retry', async () => {
  const read = new FakeRead()
  read.responses.push({ kind: 'ready', generation: 'g1', items: [item(1, 'first')], nextCursor: 'cursor-1' })
  read.responses.push({ kind: 'stale', reason: 'cursor-stale' })
  read.responses.push({ kind: 'stale', reason: 'cursor-stale' })
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  const seat = seatOf(read, scope)
  seat.open('session', 'q')
  await waitFor(() => seat.view().status === 'ready', 'first')
  seat.more()
  await waitFor(() => read.calls.length === 3 && seat.view().status === 'stale', 'stale after one auto refresh')
  assert.equal(seat.view().hasMore, false)
  assert.equal(seat.view().message, 'History changed — Retry')

  read.responses.push({ kind: 'ready', generation: 'g2', items: [item(2, 'fresh')], nextCursor: null })
  seat.retry()
  await waitFor(() => seat.view().status === 'ready' && seat.view().rows[0]?.messageId === 'message-2', 'retry fresh')
  seat.close()
})

test('a captured-scope loss retires the seat and no late answer commits', async () => {
  const read = new FakeRead()
  let release: ((value: HistorySearchResponse) => void) | undefined
  read.responses.push(() => new Promise<HistorySearchResponse>((resolve) => { release = resolve }))
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  let retired = 0
  const seat = seatOf(read, scope, { onRetire: () => { retired += 1 } })
  seat.open('session', 'q')
  await waitFor(() => seat.view().status === 'searching', 'searching')
  scope.setCurrent(false)
  scope.notify()
  assert.equal(retired, 1)
  assert.equal(scope.disposeCalls(), 1)
  release?.({ kind: 'ready', generation: 'g1', items: [item(1, 'late')], nextCursor: null })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(seat.view().rows.length, 0, 'the late page never enters the retired seat')
})

test('denied and transport failures stay distinct and never become an empty result', async () => {
  const deniedRead = new FakeRead()
  deniedRead.responses.push(() => Promise.reject(new RemoteHistorySearchDeniedError('no')))
  const deniedScope = makeScope('session', { available: true, cwd: '/repo/host' })
  const denied = seatOf(deniedRead, deniedScope)
  denied.open('session', 'q')
  await waitFor(() => denied.view().status === 'denied', 'denied')
  assert.equal(denied.view().message, 'History search is not permitted')
  assert.equal(denied.view().rows.length, 0)
  denied.close()

  const failedRead = new FakeRead()
  failedRead.responses.push(() => Promise.reject(new RemoteHistorySearchFailedError('gateway/internal', 'boom')))
  const failedScope = makeScope('session', { available: true, cwd: '/repo/host' })
  const failed = seatOf(failedRead, failedScope)
  failed.open('session', 'q')
  await waitFor(() => failed.view().status === 'failed', 'failed')
  assert.match(failed.view().message, /gateway\/internal/u)
  assert.equal(failed.view().rows.length, 0)
  failed.close()
})

test('a sessionless open starts on All and adopts the first confirmed Directory baseline once', async () => {
  const read = new FakeRead()
  read.responses.push({ kind: 'ready', generation: 'g1', items: [item(1, 'all row')], nextCursor: null })
  read.responses.push({ kind: 'ready', generation: 'g1', items: [item(2, 'directory row')], nextCursor: null })
  const scope = makeScope('all', { available: false, reason: 'workspace-not-confirmed' })
  const seat = seatOf(read, scope, { sessionId: undefined })
  seat.open('all', 'row')
  await waitFor(() => seat.view().status === 'ready', 'all first')
  assert.equal(read.calls[0]?.scope, 'all')

  scope.setDirectory({ available: true, cwd: '/repo/host' })
  scope.notify()
  await waitFor(() => read.calls.length === 2 && seat.view().scope === 'current', 'directory adoption')
  assert.equal(read.calls[1]?.scope, 'directory')
  assert.equal(read.calls[1]?.cwd, '/repo/host')
  seat.close()
})

test('a user selection before the baseline refuses the sessionless Directory adoption', async () => {
  const read = new FakeRead()
  read.responses.push({ kind: 'ready', generation: 'g1', items: [item(1, 'all row'), item(2, 'second row')], nextCursor: null })
  const scope = makeScope('all', { available: false, reason: 'workspace-not-confirmed' })
  const seat = seatOf(read, scope, { sessionId: undefined })
  seat.open('all', 'row')
  await waitFor(() => seat.view().status === 'ready', 'all first')
  const id = seat.view().rows[1]?.id
  assert.ok(id)
  seat.select(id)
  await waitFor(() => read.readCalls.length >= 1, 'the user-selected body read')
  scope.setDirectory({ available: true, cwd: '/repo/host' })
  scope.notify()
  assert.equal(seat.view().scope, 'all', 'the selection is a user change: no Directory adoption')
  assert.equal(seat.view().selectedId, id, 'the selected row survives the baseline')
  assert.equal(read.calls.length, 1, 'the baseline did not start a fresh all-page')
  seat.close()
})

test('a non-ready append clears the prior page/selection/continuation', async () => {
  const read = new FakeRead()
  read.responses.push({ kind: 'ready', generation: 'g1', items: [item(1, 'one')], nextCursor: 'c1' })
  read.responses.push({ kind: 'loading' })
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  const seat = seatOf(read, scope, { sessionId: 'session-a' })
  seat.open('session', '')
  await waitFor(() => seat.view().status === 'ready', 'first page')
  seat.more()
  await waitFor(() => seat.view().status === 'loading-host', 'non-ready append')
  assert.equal(seat.view().rows.length, 0, 'no old row survives a non-ready append')
  assert.equal(seat.view().selectedId, undefined)
  assert.equal(seat.view().hasMore, false, 'the old continuation was dropped')
  assert.equal(seat.view().body.kind, 'none')
  seat.close()
})

test('a query replacement clears the prior rows, selection and continuation', async () => {
  const read = new FakeRead()
  read.responses.push({ kind: 'ready', generation: 'g1', items: [item(1, 'one'), item(2, 'two')], nextCursor: 'c1' })
  read.responses.push({ kind: 'ready', generation: 'g1', items: [item(3, 'three')], nextCursor: null })
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  const seat = seatOf(read, scope, { sessionId: 'session-a' })
  seat.open('session', '')
  await waitFor(() => seat.view().status === 'ready', 'first page')
  assert.ok(seat.view().selectedId !== undefined)
  seat.setQuery('new')
  assert.equal(seat.view().query, 'new')
  assert.equal(seat.view().status, 'searching')
  assert.equal(seat.view().rows.length, 0)
  assert.equal(seat.view().selectedId, undefined)
  assert.equal(seat.view().hasMore, false)
  assert.equal(seat.view().body.kind, 'none')
  await waitFor(() => seat.view().status === 'ready' && seat.view().rows.length === 1, 'new page')
  seat.close()
})

test('an overlong query clears the prior exact body instead of keeping it operable', async () => {
  const read = new FakeRead()
  read.responses.push({ kind: 'ready', generation: 'g1', items: [item(1, 'one')], nextCursor: null })
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  const seat = seatOf(read, scope, { sessionId: 'session-a' })
  seat.open('session', '')
  await waitFor(() => seat.view().status === 'ready', 'first page')
  seat.setQuery('x'.repeat(257))
  assert.equal(seat.view().status, 'too-long')
  assert.equal(seat.view().rows.length, 0)
  assert.equal(seat.view().body.kind, 'none')
  assert.equal(seat.view().hasMore, false)
  seat.close()
})

test('a row selection is refused while More is in flight', async () => {
  const read = new FakeRead()
  read.responses.push({ kind: 'ready', generation: 'g1', items: [item(1, 'one'), item(2, 'two')], nextCursor: 'c1' })
  read.responses.push(() => new Promise(() => {}))
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  const seat = seatOf(read, scope, { sessionId: 'session-a' })
  seat.open('session', '')
  await waitFor(() => seat.view().status === 'ready', 'first page')
  const first = seat.view().selectedId
  seat.more()
  await waitFor(() => seat.view().moreLoading, 'More in flight')
  const second = seat.view().rows[1]?.id
  assert.ok(first !== undefined && second !== undefined)
  seat.select(second)
  assert.equal(seat.view().selectedId, first, 'More pending keeps the current selection')
  seat.close()
})


test('loading→partial→ready keeps the selected exact body and stops on ready', async () => {
  const read = new FakeRead()
  const texts = new Map<string, string>()
  const rows = (order: readonly number[]) => order.map((index) => {
    const text = `text-${String(index)}`
    texts.set(`ses_a?message-${String(index)}`, text)
    return item(index, text)
  })
  read.body = (request) => {
    const text = texts.get(`ses_a?${request.messageId}`) ?? ''
    return { kind: 'ready', chunk: text, nextOffset: null, contentLength: text.length }
  }
  const first = rows([1, 2])
  const reordered = [first[1]!, first[0]!]
  const ready = [first[1]!, first[0]!, item(3, 'text-3')]
  read.responses.push({ kind: 'loading' })
  read.responses.push({ kind: 'partial', items: first, progress: { settled: 1, total: 3 } })
  read.responses.push({ kind: 'partial', items: reordered, progress: { settled: 2, total: 3 } })
  read.responses.push({ kind: 'ready', generation: 'g1', items: ready, nextCursor: null })
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  const seat = seatOf(read, scope)
  seat.open('session', 'text')
  await waitFor(() => seat.view().status === 'partial' && seat.view().body.kind === 'ready', 'first partial body')
  const selected = seat.view().selectedId
  assert.equal(selected, first[0]!.sessionId + '\u0000' + first[0]!.messageId)
  assert.deepEqual(seat.view().progress, { settled: 1, total: 3 })
  assert.equal(seat.view().hasMore, false, 'a partial page never advertises More')
  assert.equal(read.calls.length, 2, 'the first page was followed by exactly one auto refresh')
  const bodyReads = read.readCalls.length
  const pageBefore = seat.view().pageRevision

  await waitFor(() => seat.view().progress?.settled === 2, 'expanded partial')
  assert.deepEqual(seat.view().rows.map(row => row.id), reordered.map(row => row.sessionId + '\u0000' + row.messageId))
  assert.equal(seat.view().selectedId, selected, 'the same complete row identity keeps the selection')
  assert.equal(seat.view().body.kind, 'ready', 'a progress-only refresh keeps the verified body')
  assert.equal(read.readCalls.length, bodyReads, 'a progress-only refresh never re-reads the body')
  assert.ok(seat.view().pageRevision > pageBefore, 'a material reorder advances the action identity')

  await waitFor(() => seat.view().status === 'ready', 'ready')
  assert.equal(seat.view().selectedId, selected, 'ready keeps the same row identity')
  assert.equal(seat.view().body.kind, 'ready')
  assert.equal(seat.view().progress, undefined)
  const callsAtReady = read.calls.length
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(read.calls.length, callsAtReady, 'ready stops the warmup refresh')
  seat.close()
})

test('a partial refresh that returns an error or loses currentness stops and refuses stale state', async () => {
  const read = new FakeRead()
  const a = item(1, 'alpha')
  read.responses.push({ kind: 'partial', items: [a], progress: { settled: 1, total: 2 } })
  read.responses.push(() => Promise.reject(new RemoteHistorySearchFailedError('gateway/internal', 'boom')))
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  const seat = seatOf(read, scope)
  seat.open('session', 'alpha')
  await waitFor(() => seat.view().status === 'partial', 'partial')
  await waitFor(() => seat.view().status === 'failed', 'refresh failure')
  assert.equal(seat.view().rows.length, 0, 'a non-partial refresh withdraws the old rows')
  assert.equal(seat.view().selectedId, undefined)
  const callsAtFailure = read.calls.length
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(read.calls.length, callsAtFailure, 'a failure stops the warmup refresh')
  seat.close()

  const deniedRead = new FakeRead()
  deniedRead.responses.push({ kind: 'partial', items: [item(2, 'beta')], progress: { settled: 1, total: 2 } })
  deniedRead.responses.push(() => Promise.reject(new RemoteHistorySearchDeniedError('no')))
  const deniedScope = makeScope('session', { available: true, cwd: '/repo/host' })
  const denied = seatOf(deniedRead, deniedScope)
  denied.open('session', 'beta')
  await waitFor(() => denied.view().status === 'partial', 'denied partial')
  await waitFor(() => denied.view().status === 'denied', 'denied refresh')
  const deniedCalls = deniedRead.calls.length
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(deniedRead.calls.length, deniedCalls, 'denied stops the warmup refresh')
  denied.close()
})

test('a stale partial answer cannot commit after a query change', async () => {
  const read = new FakeRead()
  const a1 = item(1, 'alpha')
  const a2 = { ...a1, preview: 'alpha changed', contentSha256: sha('alpha changed'), contentLength: 'alpha changed'.length }
  const b = item(2, 'beta')
  const texts = new Map<string, string>([
    [`ses_a?message-1`, 'alpha'],
    [`ses_a?message-2`, 'beta'],
  ])
  read.body = (request) => {
    const text = texts.get(`ses_a?${request.messageId}`) ?? ''
    return { kind: 'ready', chunk: text, nextOffset: null, contentLength: text.length }
  }
  read.responses.push({ kind: 'partial', items: [a1], progress: { settled: 1, total: 2 } })
  // The auto-refresh response is held so the user query can supersede it.
  let releaseSlow: ((value: HistorySearchResponse) => void) | undefined
  read.responses.push(() => new Promise<HistorySearchResponse>((resolve) => { releaseSlow = resolve }))
  read.responses.push({ kind: 'ready', generation: 'g2', items: [b], nextCursor: null })
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  const seat = seatOf(read, scope)
  seat.open('session', 'gamma')
  await waitFor(() => seat.view().status === 'partial', 'initial partial')
  await waitFor(() => read.calls.length === 2, 'held refresh dispatched')
  seat.setQuery('new')
  releaseSlow?.({ kind: 'partial', items: [a2], progress: { settled: 2, total: 2 } })
  await waitFor(() => seat.view().status === 'ready' && seat.view().query === 'new', 'the newer query')
  assert.equal(seat.view().rows[0]?.id, b.sessionId + '\u0000' + b.messageId, 'the stale partial never commits')
  assert.equal(read.calls.at(-1)?.query, 'new')
  seat.close()
})


test('a same-id changed row identity restarts its body and a removed selection clears it', async () => {
  const read = new FakeRead()
  const a1 = item(1, 'alpha')
  const b = item(2, 'beta')
  const a2 = { ...a1, preview: 'alpha changed', contentSha256: sha('alpha changed'), contentLength: 'alpha changed'.length }
  const texts = new Map<string, string>([
    ['ses_a?message-1', 'alpha'],
    ['ses_a?message-2', 'beta'],
  ])
  read.body = (request) => {
    const text = texts.get(`ses_a?${request.messageId}`) ?? ''
    return { kind: 'ready', chunk: text, nextOffset: null, contentLength: text.length }
  }
  read.responses.push({ kind: 'partial', items: [a1, b], progress: { settled: 1, total: 3 } })
  read.responses.push({ kind: 'partial', items: [a2], progress: { settled: 2, total: 3 } })
  read.responses.push({ kind: 'partial', items: [], progress: { settled: 2, total: 3 } })
  const scope = makeScope('session', { available: true, cwd: '/repo/host' })
  const seat = seatOf(read, scope)
  seat.open('session', 'alpha')
  await waitFor(() => seat.view().status === 'partial' && seat.view().body.kind === 'ready', 'first body')
  const selected = seat.view().selectedId
  const readsBefore = read.readCalls.length
  texts.set('ses_a?message-1', 'alpha changed')
  await waitFor(() => seat.view().rows.length === 1 && seat.view().progress?.settled === 2, 'changed identity')
  assert.equal(seat.view().selectedId, selected, 'the id survived')
  assert.equal(seat.view().body.kind, 'ready')
  const changedBody = seat.view().body
  assert.equal(changedBody.kind === 'ready' ? changedBody.text : '', 'alpha changed',
    'the changed hash body was re-read instead of reusing stale text')
  assert.ok(read.readCalls.length > readsBefore, 'the changed identity issued one new exact read')
  await waitFor(() => seat.view().rows.length === 0 && seat.view().selectedId === undefined, 'removed selection')
  assert.equal(seat.view().body.kind, 'none')
  assert.equal(seat.view().hasMore, false)
  seat.close()
})
