/**
 * Contract tests for the official-parity Direct session content search
 * (runtime/direct/session-search-direct.ts, master `ApiSessionList.search()`
 * business semantics): provider invocation, visibility/authorization,
 * dedupe, cursor fill, stale-cursor restart, invalid-limit retry, the
 * provider-call work budget, and the bounded page assembly. The Direct
 * adapter's capability mapping (unavailable/disabled → `undefined`) is
 * covered in session-reader-port.test.ts.
 * @module @xmoon76/dsh-pi-tui/session-search-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  SEARCH_PROVIDER_CALL_LIMIT,
  SESSION_SEARCH_RESULT_LIMIT,
  normalizeSessionSearchQuery,
  searchSessionContentPage,
  truncateUnicodeCodePoints,
  type SessionSearchPageLike,
  type SessionSearchProviderLike,
} from '../src/runtime/direct/session-search-direct.ts'

/** One provider hit (structural subset of the official shape). */
function hit(id: string, extra: Partial<{ type: string; surface: string; snippet: string; sessionId: string }> = {}) {
  return {
    header: { id: SessionId(id) },
    bestMatch: {
      sessionId: SessionId(id),
      type: 'user/message',
      surface: 'current',
      snippet: `needle in ${id}`,
      ...extra,
    },
  }
}

/** A scripted provider: pages are consumed in order; a `nextCursor` on a
 * page is echoed back by the next call unless the script says otherwise. */
function makeProvider(pages: SessionSearchPageLike[]): {
  provider: SessionSearchProviderLike
  calls: Array<{ query: string; eventFilters: unknown; limit: number; cursor?: unknown; signal?: AbortSignal }>
} {
  const calls: Array<{ query: string; eventFilters: unknown; limit: number; cursor?: unknown; signal?: AbortSignal }> = []
  let index = 0
  return {
    provider: {
      searchSessions: async (request, exec) => {
        calls.push({ query: request.query, eventFilters: request.eventFilters, limit: request.limit, cursor: request.cursor, signal: exec?.signal })
        const page = pages[Math.min(index, pages.length - 1)]!
        index += 1
        return page
      },
    },
    calls,
  }
}

const visible = (ids: string[]): Set<string> => new Set(ids)

test('normalizeSessionSearchQuery trims and validates like the official contract', () => {
  assert.equal(normalizeSessionSearchQuery('  needle  '), 'needle')
  assert.throws(() => normalizeSessionSearchQuery('   '), /must not be empty/)
  assert.throws(() => normalizeSessionSearchQuery('x'.repeat(501)), /at most 500/)
  assert.throws(() => normalizeSessionSearchQuery('a\0b'), /must not contain NUL/)
  // Exactly 500 code units is legal.
  assert.equal(normalizeSessionSearchQuery('x'.repeat(500)).length, 500)
})

test('truncateUnicodeCodePoints never splits a surrogate pair', () => {
  const emoji = 'a\u{1F600}b' // 'a' + 😀 + 'b'
  assert.equal(truncateUnicodeCodePoints(emoji, 1), 'a')
  assert.equal(truncateUnicodeCodePoints(emoji, 2), 'a\u{1F600}')
  assert.equal(truncateUnicodeCodePoints(emoji, 3), emoji)
  assert.equal(truncateUnicodeCodePoints(emoji, 10), emoji)
})

test('searchSessions is called with the official event filters and the public limit', async () => {
  const { provider, calls } = makeProvider([{ items: [hit('session-a')] }])
  const page = await searchSessionContentPage(provider, visible(['session-a']), 'needle')
  assert.deepEqual(page, { items: [{ sessionId: 'session-a', snippet: 'needle in session-a' }], hasMore: false })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]!.eventFilters, [
    { kind: 'type', values: ['user/message', 'assistant/message'] },
    { kind: 'surface', values: ['current'] },
  ])
  assert.equal(calls[0]!.limit, SESSION_SEARCH_RESULT_LIMIT)
  assert.equal(calls[0]!.cursor, undefined)
})

test('the caller signal reaches the provider', async () => {
  const controller = new AbortController()
  const { provider, calls } = makeProvider([{ items: [] }])
  await searchSessionContentPage(provider, visible([]), 'needle', controller.signal)
  assert.equal(calls[0]!.signal, controller.signal)
})

test('authorization drops unknown, mismatched, non-current and non-message hits', async () => {
  const { provider } = makeProvider([{ items: [
    hit('session-ok'),
    hit('session-unknown'),
    hit('session-mismatch', { sessionId: 'session-other' }),
    hit('session-shadowed', { surface: 'shadowed' }),
    hit('session-tool', { type: 'tool/result' }),
  ] }])
  const page = await searchSessionContentPage(provider, visible(['session-ok', 'session-mismatch', 'session-shadowed', 'session-tool']), 'needle')
  assert.deepEqual(page.items.map(item => item.sessionId), ['session-ok'])
  assert.equal(page.hasMore, false)
})

test('duplicate sessions are deduped to one row', async () => {
  const { provider } = makeProvider([{ items: [hit('session-a'), hit('session-a')] }])
  const page = await searchSessionContentPage(provider, visible(['session-a']), 'needle')
  assert.deepEqual(page.items.map(item => item.sessionId), ['session-a'])
})

test('snippets are truncated to the official code-point cap', async () => {
  const long = 'x'.repeat(500)
  const { provider } = makeProvider([{ items: [hit('session-a', { snippet: long })] }])
  const page = await searchSessionContentPage(provider, visible(['session-a']), 'needle')
  assert.equal(page.items[0]!.snippet.length, 240)
})

test('cursor fill continues past unauthorized hits until the window is full', async () => {
  const { provider, calls } = makeProvider([
    { items: [hit('session-unauthorized')], nextCursor: 'c1' },
    { items: [hit('session-a'), hit('session-b')], nextCursor: 'c2' },
    { items: [hit('session-c')] },
  ])
  const page = await searchSessionContentPage(provider, visible(['session-a', 'session-b', 'session-c']), 'needle')
  assert.deepEqual(page.items.map(item => item.sessionId), ['session-a', 'session-b', 'session-c'])
  assert.equal(page.hasMore, false)
  assert.deepEqual(calls.map(call => call.cursor), [undefined, 'c1', 'c2'])
})

test('hasMore is true when more than the public limit is authorized', async () => {
  const first = Array.from({ length: SESSION_SEARCH_RESULT_LIMIT }, (_, i) => hit(`session-${i}`))
  const { provider } = makeProvider([
    { items: first, nextCursor: 'c1' },
    { items: [hit('session-extra')] },
  ])
  const page = await searchSessionContentPage(
    provider,
    visible([...first.map(item => String(item.header.id)), 'session-extra']),
    'needle',
  )
  assert.equal(page.items.length, SESSION_SEARCH_RESULT_LIMIT)
  assert.equal(page.hasMore, true)
})

test('a repeated continuation cursor fails loud', async () => {
  const { provider } = makeProvider([
    { items: [hit('session-a')], nextCursor: 'same' },
    { items: [hit('session-b')], nextCursor: 'same' },
  ])
  await assert.rejects(
    searchSessionContentPage(provider, visible(['session-a', 'session-b']), 'needle'),
    /repeated a continuation cursor/,
  )
})

test('a stale cursor clears the aggregate and restarts from the first page', async () => {
  const calls: Array<{ cursor?: unknown }> = []
  const scripted = {
    searchSessions: async (request: Parameters<SessionSearchProviderLike['searchSessions']>[0]) => {
      calls.push({ cursor: request.cursor })
      if (request.cursor === 'stale') {
        throw Object.assign(new Error('stale cursor'), { code: 'SESSION_QUERY_STALE_CURSOR' })
      }
      if (calls.length === 1) return { items: [hit('session-a')], nextCursor: 'stale' }
      return { items: [hit('session-b'), hit('session-c')] }
    },
  }
  const page = await searchSessionContentPage(scripted, visible(['session-a', 'session-b', 'session-c']), 'needle')
  // The stale-cursor restart drops the first page's authorized hit.
  assert.deepEqual(page.items.map(item => item.sessionId), ['session-b', 'session-c'])
  assert.deepEqual(calls.map(call => call.cursor), [undefined, 'stale', undefined])
})

test('an invalid limit on the first page halves the page limit and retries', async () => {
  const { provider, calls } = makeProvider([
    { items: [] },
    { items: [hit('session-a')] },
  ])
  const scripted = {
    searchSessions: async (request: Parameters<SessionSearchProviderLike['searchSessions']>[0], exec?: { signal?: AbortSignal }) => {
      calls.push({ query: request.query, eventFilters: request.eventFilters, limit: request.limit, cursor: request.cursor, signal: exec?.signal })
      if (calls.length === 1) {
        throw Object.assign(new Error('limit too big'), { code: 'SESSION_QUERY_INVALID_LIMIT' })
      }
      return { items: [hit('session-a')] }
    },
  }
  const page = await searchSessionContentPage(scripted, visible(['session-a']), 'needle')
  assert.deepEqual(page.items.map(item => item.sessionId), ['session-a'])
  assert.deepEqual(calls.map(call => call.limit), [SESSION_SEARCH_RESULT_LIMIT, 10])
})

test('an invalid limit at limit 1 fails loud', async () => {
  const scripted = {
    searchSessions: async () => {
      throw Object.assign(new Error('limit too big'), { code: 'SESSION_QUERY_INVALID_LIMIT' })
    },
  }
  await assert.rejects(
    searchSessionContentPage(scripted, visible(['session-a']), 'needle'),
    /limit too big/,
  )
})

test('a provider page over the requested limit fails loud', async () => {
  const items = Array.from({ length: SESSION_SEARCH_RESULT_LIMIT + 1 }, (_, i) => hit(`session-${i}`))
  const { provider } = makeProvider([{ items }])
  await assert.rejects(
    searchSessionContentPage(provider, visible(items.map(item => String(item.header.id))), 'needle'),
    new RegExp(`returned ${SESSION_SEARCH_RESULT_LIMIT + 1} items; maximum is ${SESSION_SEARCH_RESULT_LIMIT}`),
  )
})

test('the provider-call work budget fails loud', async () => {
  let calls = 0
  const scripted = {
    searchSessions: async () => {
      calls += 1
      // A fresh cursor every page: the repeated-cursor guard must not fire
      // before the work budget does.
      return { items: [], nextCursor: `again-${calls}` }
    },
  }
  await assert.rejects(
    searchSessionContentPage(scripted, visible(['session-a']), 'needle'),
    new RegExp(`exceeded the ${SEARCH_PROVIDER_CALL_LIMIT}-call work budget`),
  )
  assert.equal(calls, SEARCH_PROVIDER_CALL_LIMIT)
})

test('an aborted signal rejects before and between provider calls', async () => {
  const controller = new AbortController()
  const { provider } = makeProvider([{ items: [hit('session-a')], nextCursor: 'c1' }])
  const pending = searchSessionContentPage(provider, visible(['session-a']), 'needle', controller.signal)
  controller.abort()
  await assert.rejects(pending, /abort/i)
})

test('a provider abort error propagates as a rejection, not an empty page', async () => {
  const scripted = {
    searchSessions: async () => {
      throw Object.assign(new Error('aborted'), { code: 'SESSION_QUERY_ABORTED' })
    },
  }
  await assert.rejects(
    searchSessionContentPage(scripted, visible(['session-a']), 'needle'),
    /aborted/,
  )
})
