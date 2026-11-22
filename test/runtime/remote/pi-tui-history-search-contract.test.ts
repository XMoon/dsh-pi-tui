/**
 * The private `piTuiHistorySearch` wire contract codec.
 *
 * Pins the strict request/response shapes the Host and Client share: the three
 * exact scopes, cursor round-trip and staleness vocabulary, bounded preview and
 * readText chunking, and the closed enum/field rejection rules (a drifting
 * frame must fail instead of being silently coerced).
 *
 * @module @xmoon76/dsh-pi-tui/pi-tui-history-search-contract.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  HISTORY_SEARCH_CURSOR_MAX_BYTES,
  HISTORY_SEARCH_LIMIT_MAX,
  HISTORY_SEARCH_PREVIEW_MAX_CHARS,
  HISTORY_SEARCH_QUERY_MAX_CHARS,
  HISTORY_SEARCH_READ_TEXT_LIMIT_MAX,
  PI_TUI_HISTORY_SEARCH,
  PI_TUI_HISTORY_SEARCH_READ_TEXT,
  PI_TUI_HISTORY_SEARCH_NAMESPACE,
  decodeHistorySearchCursor,
  encodeHistorySearchCursor,
  historyReadTextChunk,
  historySearchPreview,
  parseHistoryReadTextRequest,
  parseHistoryReadTextResponse,
  parseHistorySearchRequest,
  parseHistorySearchResponse,
  type HistorySearchCursor,
} from '../../../src/runtime/remote/pi-tui-history-search-contract.ts'

const CURSOR: HistorySearchCursor = {
  v: 1,
  incarnation: 'inc-1',
  revision: 7,
  scope: 'all',
  query: 'needle',
  scopeId: null,
  after: { acceptedAt: 1000, sessionId: 's1', firstEventSeq: 3, messageId: 'm1' },
}

test('the contract owns exactly the two strict unary endpoints of the private namespace', () => {
  assert.equal(PI_TUI_HISTORY_SEARCH.id, '@xmoon76/dsh-pi-tui#piTuiHistorySearch/search')
  assert.equal(PI_TUI_HISTORY_SEARCH_READ_TEXT.id, '@xmoon76/dsh-pi-tui#piTuiHistorySearch/readText')
  assert.equal(PI_TUI_HISTORY_SEARCH.service, PI_TUI_HISTORY_SEARCH_NAMESPACE)
  assert.equal(PI_TUI_HISTORY_SEARCH_READ_TEXT.namespace, PI_TUI_HISTORY_SEARCH_NAMESPACE)
  assert.equal(PI_TUI_HISTORY_SEARCH.method, 'search')
  assert.equal(PI_TUI_HISTORY_SEARCH_READ_TEXT.method, 'readText')
  assert.deepEqual(PI_TUI_HISTORY_SEARCH.parameters.map(parameter => parameter.name), ['request'])
  assert.deepEqual(PI_TUI_HISTORY_SEARCH_READ_TEXT.parameters.map(parameter => parameter.name), ['request'])
  assert.deepEqual(PI_TUI_HISTORY_SEARCH.cancellation, { parameter: 'signal' })
})

test('every scope accepts exactly its own keys and rejects extra or foreign fields', () => {
  assert.deepEqual(parseHistorySearchRequest({ scope: 'all', query: '', limit: 1 }), { scope: 'all', query: '', limit: 1 })
  assert.deepEqual(parseHistorySearchRequest({ scope: 'session', sessionId: 's1', query: 'q', limit: 25 }),
    { scope: 'session', sessionId: 's1', query: 'q', limit: 25 })
  assert.deepEqual(parseHistorySearchRequest({ scope: 'directory', cwd: '/repo/a', query: 'q', limit: 2, cursor: 'abc' }),
    { scope: 'directory', cwd: '/repo/a', query: 'q', limit: 2, cursor: 'abc' })

  assert.throws(() => parseHistorySearchRequest({ scope: 'all', sessionId: 's1', query: '', limit: 1 }), /unexpected field/u)
  assert.throws(() => parseHistorySearchRequest({ scope: 'session', query: '', limit: 1 }), /sessionId/u)
  assert.throws(() => parseHistorySearchRequest({ scope: 'session', sessionId: 's1', cwd: '/repo/a', query: '', limit: 1 }), /unexpected field/u)
  assert.throws(() => parseHistorySearchRequest({ scope: 'directory', cwd: 'relative/path', query: '', limit: 1 }), /absolute/u)
  assert.throws(() => parseHistorySearchRequest({ scope: 'directory', cwd: '/repo/\0a', query: '', limit: 1 }), /NUL/u)
  assert.throws(() => parseHistorySearchRequest({ scope: 'global', query: '', limit: 1 }), /scope/u)
  assert.throws(() => parseHistorySearchRequest({ scope: 'all', query: 'x'.repeat(HISTORY_SEARCH_QUERY_MAX_CHARS + 1), limit: 1 }), /at most/u)
  assert.throws(() => parseHistorySearchRequest({ scope: 'all', query: '', limit: 0 }), /within/u)
  assert.throws(() => parseHistorySearchRequest({ scope: 'all', query: '', limit: HISTORY_SEARCH_LIMIT_MAX + 1 }), /within/u)
  assert.throws(() => parseHistorySearchRequest({ scope: 'all', query: '', limit: 1.5 }), /safe integer/u)
  assert.throws(() => parseHistorySearchRequest({ scope: 'all', query: '', limit: 1, cursor: '' }), /non-empty/u)
  assert.throws(() => parseHistorySearchRequest({ scope: 'all', query: '', limit: 1, cursor: 'x'.repeat(HISTORY_SEARCH_CURSOR_MAX_BYTES + 1) }), /exceeds/u)
  assert.throws(() => parseHistorySearchRequest(null), /object/u)
  assert.throws(() => parseHistorySearchRequest([]), /object/u)
})

test('the cursor round-trips and strictly rejects a foreign or extended payload', () => {
  const encoded = encodeHistorySearchCursor(CURSOR)
  assert.deepEqual(decodeHistorySearchCursor(encoded), CURSOR)
  assert.throws(() => decodeHistorySearchCursor('not-base64-json'), /base64url JSON/u)
  const extended = Buffer.from(JSON.stringify({ ...CURSOR, extra: true }), 'utf8').toString('base64url')
  assert.throws(() => decodeHistorySearchCursor(extended), /unexpected field/u)
  const missing = Buffer.from(JSON.stringify({ ...CURSOR, after: { acceptedAt: 1 } }), 'utf8').toString('base64url')
  assert.throws(() => decodeHistorySearchCursor(missing), /missing field/u)
  const badVersion = Buffer.from(JSON.stringify({ ...CURSOR, v: 2 }), 'utf8').toString('base64url')
  assert.throws(() => decodeHistorySearchCursor(badVersion), /version/u)
  const badScope = Buffer.from(JSON.stringify({ ...CURSOR, scope: 'global' }), 'utf8').toString('base64url')
  assert.throws(() => decodeHistorySearchCursor(badScope), /scope/u)
  assert.throws(() => decodeHistorySearchCursor('x'.repeat(HISTORY_SEARCH_CURSOR_MAX_BYTES + 1)), /exceeds/u)
  assert.throws(() => encodeHistorySearchCursor({ ...CURSOR, revision: -1 }), /non-negative/u)
})

test('a ready search answer needs exact fields and a bounded preview', () => {
  const item = {
    sessionId: 's1',
    messageId: 'm1',
    firstEventSeq: 2,
    acceptedAt: 1000,
    effectiveCwd: '/repo/a',
    preview: 'hello',
    contentLength: 5,
    contentSha256: 'a'.repeat(64),
    hasNonText: false,
  }
  assert.deepEqual(parseHistorySearchResponse({
    kind: 'ready', generation: 'g1', items: [item], nextCursor: null,
  }), {
    kind: 'ready', generation: 'g1', items: [item], nextCursor: null,
  })
  const nullCwd = parseHistorySearchResponse({
    kind: 'ready', generation: 'g1', items: [{ ...item, effectiveCwd: null }], nextCursor: 'c1',
  })
  assert.equal(nullCwd.kind, 'ready')
  if (nullCwd.kind !== 'ready') throw new Error('expected ready')
  assert.equal(nullCwd.items[0]!.effectiveCwd, null)

  assert.throws(() => parseHistorySearchResponse({ kind: 'ready', generation: 'g1', items: [{ ...item, preview: 'x'.repeat(HISTORY_SEARCH_PREVIEW_MAX_CHARS + 1) }], nextCursor: null }), /preview/u)
  assert.throws(() => parseHistorySearchResponse({ kind: 'ready', generation: 'g1', items: [{ ...item, contentSha256: 'A'.repeat(64) }], nextCursor: null }), /SHA-256/u)
  assert.throws(() => parseHistorySearchResponse({ kind: 'ready', generation: 'g1', items: [{ ...item, extra: 1 }], nextCursor: null }), /unexpected field/u)
  assert.throws(() => parseHistorySearchResponse({ kind: 'ready', generation: 'g1', items: [], nextCursor: 3 }), /nextCursor/u)
  assert.throws(() => parseHistorySearchResponse({ kind: 'ok', items: [] }), /unknown kind/u)
})

test('the non-ready search vocabulary is closed and exact', () => {
  assert.deepEqual(parseHistorySearchResponse({ kind: 'loading' }), { kind: 'loading' })
  assert.deepEqual(parseHistorySearchResponse({ kind: 'incomplete', reason: 'source-uncertain' }),
    { kind: 'incomplete', reason: 'source-uncertain' })
  assert.deepEqual(parseHistorySearchResponse({ kind: 'incomplete', reason: 'reconciling' }),
    { kind: 'incomplete', reason: 'reconciling' })
  assert.deepEqual(parseHistorySearchResponse({ kind: 'incomplete', reason: 'resource-limit' }),
    { kind: 'incomplete', reason: 'resource-limit' })
  assert.deepEqual(parseHistorySearchResponse({ kind: 'incomplete', reason: 'source-read-failed' }),
    { kind: 'incomplete', reason: 'source-read-failed' })
  assert.deepEqual(parseHistorySearchResponse({ kind: 'unavailable', reason: 'index-unavailable' }),
    { kind: 'unavailable', reason: 'index-unavailable' })
  assert.deepEqual(parseHistorySearchResponse({ kind: 'unavailable', reason: 'service-missing' }),
    { kind: 'unavailable', reason: 'service-missing' })
  assert.deepEqual(parseHistorySearchResponse({ kind: 'stale', reason: 'cursor-stale' }),
    { kind: 'stale', reason: 'cursor-stale' })
  assert.throws(() => parseHistorySearchResponse({ kind: 'incomplete', reason: 'nope' }), /unknown incomplete reason/u)
  assert.throws(() => parseHistorySearchResponse({ kind: 'unavailable', reason: 'nope' }), /unknown unavailable reason/u)
  assert.throws(() => parseHistorySearchResponse({ kind: 'stale', reason: 'foreign' }), /unknown stale reason/u)
  assert.throws(() => parseHistorySearchResponse({ kind: 'loading', extra: 1 }), /unexpected field/u)
})

test('the readText request/answer enforce exact identity, offsets and chunk bounds', () => {
  const request = {
    sessionId: 's1',
    messageId: 'm1',
    contentSha256: 'b'.repeat(64),
    offset: 0,
    limit: 16,
  }
  assert.deepEqual(parseHistoryReadTextRequest(request), request)
  assert.throws(() => parseHistoryReadTextRequest({ ...request, limit: 0 }), /within/u)
  assert.throws(() => parseHistoryReadTextRequest({ ...request, limit: HISTORY_SEARCH_READ_TEXT_LIMIT_MAX + 1 }), /within/u)
  assert.throws(() => parseHistoryReadTextRequest({ ...request, offset: -1 }), /non-negative/u)
  assert.throws(() => parseHistoryReadTextRequest({ ...request, contentSha256: 'short' }), /SHA-256/u)
  assert.throws(() => parseHistoryReadTextRequest({ ...request, extra: 1 }), /unexpected field/u)

  assert.deepEqual(parseHistoryReadTextResponse({ kind: 'ready', chunk: 'hello', nextOffset: 5, contentLength: 10 }),
    { kind: 'ready', chunk: 'hello', nextOffset: 5, contentLength: 10 })
  assert.deepEqual(parseHistoryReadTextResponse({ kind: 'ready', chunk: 'end', nextOffset: null, contentLength: 3 }),
    { kind: 'ready', chunk: 'end', nextOffset: null, contentLength: 3 })
  assert.deepEqual(parseHistoryReadTextResponse({ kind: 'unavailable', reason: 'stale-content' }),
    { kind: 'unavailable', reason: 'stale-content' })
  assert.deepEqual(parseHistoryReadTextResponse({ kind: 'unavailable', reason: 'not-found' }),
    { kind: 'unavailable', reason: 'not-found' })
  assert.throws(() => parseHistoryReadTextResponse({ kind: 'ready', chunk: '', nextOffset: -1, contentLength: 0 }), /non-negative/u)
  assert.throws(() => parseHistoryReadTextResponse({ kind: 'unavailable', reason: 'gone' }), /unknown unavailable reason/u)
  assert.throws(() => parseHistoryReadTextResponse({ kind: 'stale', reason: 'cursor-stale' }), /unknown kind/u)
})

test('the preview is a bounded code-point-safe prefix', () => {
  assert.equal(historySearchPreview('short'), 'short')
  const exact = 'a'.repeat(HISTORY_SEARCH_PREVIEW_MAX_CHARS)
  assert.equal(historySearchPreview(exact), exact)
  const longer = 'a'.repeat(HISTORY_SEARCH_PREVIEW_MAX_CHARS) + 'tail'
  assert.equal(historySearchPreview(longer), exact)

  // A surrogate pair straddling the boundary is dropped whole, never split.
  const emojiBoundary = 'a'.repeat(HISTORY_SEARCH_PREVIEW_MAX_CHARS - 1) + '😀'
  const preview = historySearchPreview(emojiBoundary)
  assert.equal(preview.length, HISTORY_SEARCH_PREVIEW_MAX_CHARS - 1)
  assert.equal(preview, 'a'.repeat(HISTORY_SEARCH_PREVIEW_MAX_CHARS - 1))
})

test('readText chunks never split a surrogate pair and end with a null offset', () => {
  const text = 'ab😀cd'
  const first = historyReadTextChunk(text, 0, 2)
  assert.equal(first.chunk, 'ab')
  assert.equal(first.nextOffset, 2)
  const second = historyReadTextChunk(text, 2, 1)
  assert.equal(second.chunk, '😀')
  assert.equal(second.nextOffset, 4)
  const final = historyReadTextChunk(text, 4, 2)
  assert.equal(final.chunk, 'cd')
  assert.equal(final.nextOffset, null)
  // A hostile offset inside the pair is advanced instead of emitting a lone
  // low surrogate.
  const splitOffset = historyReadTextChunk(text, 3, 2)
  assert.equal(splitOffset.chunk, 'cd')
  assert.equal(splitOffset.nextOffset, null)
  assert.throws(() => historyReadTextChunk(text, text.length + 1, 1), /exceeds/u)
  const empty = historyReadTextChunk('', 0, 1)
  assert.deepEqual(empty, { chunk: '', nextOffset: null })
})
test('oversized response cursor and chunk frames fail the strict codec', () => {
  const item = {
    sessionId: 's1',
    messageId: 'm1',
    firstEventSeq: 2,
    acceptedAt: 1000,
    effectiveCwd: '/repo/a',
    preview: 'hello',
    contentLength: 5,
    contentSha256: 'a'.repeat(64),
    hasNonText: false,
  }
  assert.throws(() => parseHistorySearchResponse({
    kind: 'ready',
    generation: 'g1',
    items: [item],
    nextCursor: 'x'.repeat(HISTORY_SEARCH_CURSOR_MAX_BYTES + 1),
  }), /nextCursor exceeds/u)
  // A chunk may exceed the requested limit by exactly ONE UTF-16 unit for a
  // non-splittable surrogate pair, never by more.
  assert.deepEqual(parseHistoryReadTextResponse({
    kind: 'ready', chunk: 'a'.repeat(HISTORY_SEARCH_READ_TEXT_LIMIT_MAX + 1), nextOffset: 1, contentLength: 2,
  }).kind, 'ready')
  assert.throws(() => parseHistoryReadTextResponse({
    kind: 'ready', chunk: 'a'.repeat(HISTORY_SEARCH_READ_TEXT_LIMIT_MAX + 2), nextOffset: 1, contentLength: 2,
  }), /chunk exceeds/u)
})
