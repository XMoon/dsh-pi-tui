/**
 * Adapter contract tests for the Direct session reader
 * (runtime/direct/session-direct.ts, migration M1.3). The port is the
 * semantic boundary: the consumer depends on SessionReader and the Direct
 * adapter owns Host service access.
 *
 * Projection tests pin the master-safe ladder: live snapshots, zero-I/O cache
 * hints for eligible cold rows, and unknown fields on cold cache misses. A
 * picker must never activate a historical Session just to fill labels.
 * @module @xmoon76/dsh-pi-tui/session-reader-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { DirectSessionReader, type HostContextLike, type SessionQueryLike } from '../src/runtime/direct/session-direct.ts'

function header(id: string, createdAt: number, extra: Partial<{
  cwd: string
  agentPreset: string
  parentSession: string
  origin: 'subagent'
  isSeeded: boolean
}> = {}) {
  // `isSeeded: false` completes the cache identity: an unseeded row's exact
  // inherited cut is zero.
  const { parentSession, ...rest } = extra
  return {
    id: SessionId(id),
    createdAt,
    version: 3 as const,
    isSeeded: false,
    cwd: '/workspace',
    ...rest,
    ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }),
  }
}

function query(
  records: Array<{ header: ReturnType<typeof header>; live: boolean }>,
  searchSessions?: NonNullable<SessionQueryLike['searchSessions']>,
): SessionQueryLike {
  return {
    listSessions: async () => records,
    ...(searchSessions === undefined ? {} : { searchSessions }),
    // The explicit observation seam is intentionally absent from picker
    // fixtures. It remains optional for the child viewer's resume path.
  }
}

/** One provider search hit (structural subset of the official shape). */
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

function host(services: Record<string, unknown>): HostContextLike {
  return { get: (name) => services[name] }
}

function row(id: string, createdAt: number, live = false) {
  return { id, updatedAt: createdAt, createdAt, live }
}

test('list prefers the semantic query engine and sorts newest-first', async () => {
  const liveHeader = header('session-new', 300)
  const liveSession = { header: liveHeader }
  const reader = new DirectSessionReader(host({
    sessionQuery: query([
      { header: header('session-old', 100), live: false },
      { header: liveHeader, live: false },
    ]),
  }), {
    sessionOf: id => String(id) === 'session-new' ? liveSession : undefined,
    agentOf: () => undefined,
  })
  const rows = await reader.list('session-new')
  assert.ok(rows !== undefined)
  assert.deepEqual(rows.map(r => r.id), ['session-new', 'session-old'])
  assert.deepEqual(rows.map(r => r.updatedAt), [300, 100])
  assert.deepEqual(rows.map(r => r.createdAt), [300, 100])
  assert.equal(rows[0].live, true)
})

test('list matches master visibility: cold cwd-less rows are omitted but live rows remain visible', async () => {
  const cacheReads: string[] = []
  const liveHeader = header('live-no-cwd', 300, { cwd: undefined })
  const liveSession = { header: liveHeader }
  const reader = new DirectSessionReader(host({
    sessionQuery: query([
      { header: header('cold-hidden', 400, { cwd: undefined }), live: false },
      { header: liveHeader, live: false },
      { header: header('cold-visible', 200, { cwd: '/workspace' }), live: false },
    ]),
    sessionProjectionCache: {
      cachedSnapshot: (meta: { id: string }) => {
        cacheReads.push(meta.id)
        return undefined
      },
    },
  }), {
    sessionOf: id => String(id) === 'live-no-cwd' ? liveSession : undefined,
    agentOf: () => undefined,
  })
  const rows = await reader.list(undefined)
  assert.deepEqual(rows?.map(row => row.id), ['live-no-cwd', 'cold-visible'])
  const projections = await reader.projectionBatch([
    ...rows!,
    row('cold-hidden', 400),
  ])
  assert.equal(projections.has('cold-hidden'), false)
  assert.equal(cacheReads.includes('cold-hidden'), false)
})

test('list uses sessionListMetadata activity when the optional capability exists', async () => {
  const old = header('session-old', 100)
  const newer = header('session-new', 300)
  const reader = new DirectSessionReader(host({
    sessionQuery: query([
      { header: old, live: false },
      { header: newer, live: false },
    ]),
    sessionProjectionCache: {
      cachedSnapshot: (meta: { id: string }, cut: unknown, keys?: readonly string[]) => {
        assert.equal(cut, SessionLogOffset(0))
        assert.deepEqual(keys, ['sessionListMetadata'])
        return meta.id === 'session-old'
          ? { values: { sessionListMetadata: { blank: false, lastPromptAt: 900 } } }
          : undefined
      },
    },
  }))
  const rows = await reader.list(undefined)
  assert.ok(rows !== undefined)
  assert.deepEqual(rows.map(r => r.id), ['session-old', 'session-new'])
  assert.deepEqual(rows.map(r => r.updatedAt), [900, 300])
  assert.deepEqual(rows.map(r => r.createdAt), [100, 300])
})

test('list falls back to createdAt when activity projection is unavailable', async () => {
  const reader = new DirectSessionReader(host({
    sessionQuery: query([
      { header: header('session-old', 100), live: false },
      { header: header('session-new', 300), live: false },
    ]),
  }))
  const rows = await reader.list(undefined)
  assert.ok(rows !== undefined)
  assert.deepEqual(rows.map(r => r.id), ['session-new', 'session-old'])
})

test('list never reads a seeded cold cache without an exact inherited cut', async () => {
  const seeded = header('session-seeded', 100, { isSeeded: true })
  let cacheReads = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: seeded, live: false }]),
    sessionProjectionCache: {
      cachedSnapshot: () => {
        cacheReads += 1
        return { values: { sessionListMetadata: { blank: false, lastPromptAt: 900 } } }
      },
    },
  }))
  const rows = await reader.list(undefined)
  assert.deepEqual(rows?.map(r => r.id), ['session-seeded'])
  assert.equal(cacheReads, 0)
})

test('list without the session-query engine is explicitly unavailable', async () => {
  const reader = new DirectSessionReader(host({}))
  assert.equal(await reader.list('session-b'), undefined)
})

test('projectionBatch uses live projection and composed preset without cold reads', async () => {
  const liveHeader = header('session-live', 400)
  const session = { header: liveHeader }
  const liveAgent = { session, ctx: {} }
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: liveHeader, live: true }]),
    sessionProjections: {
      cachedSnapshot: (target: unknown) => target === session
        ? { values: { title: 'live title' } }
        : undefined,
    },
    agentPresets: {
      composedPreset: () => 'minimal',
      list: async () => [{ id: 'minimal' }],
      resolve: async (id?: string) => ({ id: id ?? 'minimal' }),
    },
  }), {
    sessionOf: id => String(id) === 'session-live' ? session : undefined,
    agentOf: id => String(id) === 'session-live' ? liveAgent : undefined,
  })
  const rows = await reader.list(undefined)
  assert.equal((await reader.projectionBatch(rows!)).get('session-live')?.title, 'live title')
  assert.equal((await reader.projectionBatch(rows!)).get('session-live')?.preset, 'minimal')
})

test('live projection uses cached cells and never falls back to cold metadata', async () => {
  const liveHeader = header('session-live-miss', 400)
  const session = { header: liveHeader }
  const liveAgent = { session, ctx: {} }
  let materializingSnapshots = 0
  let coldCacheReads = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: liveHeader, live: true }]),
    sessionProjections: {
      snapshot: () => {
        materializingSnapshots += 1
        throw new Error('live listing must not materialize projections')
      },
      cachedSnapshot: () => undefined,
    },
    sessionProjectionCache: {
      cachedSnapshot: () => {
        coldCacheReads += 1
        throw new Error('live rows must not read cold cache')
      },
    },
    agentPresets: {
      composedPreset: () => undefined,
      list: async () => [{ id: 'minimal' }],
      resolve: async (id?: string) => ({ id: id ?? 'minimal' }),
    },
  }), {
    sessionOf: id => String(id) === 'session-live-miss' ? session : undefined,
    agentOf: id => String(id) === 'session-live-miss' ? liveAgent : undefined,
  })
  const rows = await reader.list(undefined)
  assert.deepEqual(await reader.projectionBatch(rows!), new Map())
  assert.equal(materializingSnapshots, 0)
  assert.equal(coldCacheReads, 0)
})

test('a live row stays cache-free when its Agent mapping races teardown', async () => {
  const liveHeader = header('session-live-race', 500)
  const session = { header: liveHeader }
  let coldCacheReads = 0
  let rosterReads = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: liveHeader, live: true }]),
    sessionProjectionCache: {
      cachedSnapshot: () => {
        coldCacheReads += 1
        throw new Error('live row must not use the cold cache')
      },
    },
    agentPresets: {
      list: async () => {
        rosterReads += 1
        throw new Error('live row must not read the cold roster')
      },
    },
  }), {
    sessionOf: id => String(id) === 'session-live-race' ? session : undefined,
    agentOf: () => undefined,
  })
  const rows = await reader.list(undefined)
  assert.deepEqual(rows?.map(row => row.id), ['session-live-race'])
  assert.deepEqual(await reader.projectionBatch(rows!), new Map())
  assert.equal(coldCacheReads, 0)
  assert.equal(rosterReads, 0)
})

test('list captures the attached Session header and live activity after query listing', async () => {
  const queryHeader = header('session-live-header', 100, { cwd: '/query' })
  const liveHeader = header('session-live-header', 900, { cwd: '/attached' })
  const liveSession = { header: liveHeader }
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: queryHeader, live: false }]),
    sessionProjections: {
      cachedSnapshot: (target: unknown, keys?: readonly string[]) => {
        assert.equal(target, liveSession)
        assert.deepEqual(keys, ['sessionListMetadata'])
        return { values: { sessionListMetadata: { blank: false, lastPromptAt: 1_200 } } }
      },
    },
  }), {
    sessionOf: id => String(id) === 'session-live-header' ? liveSession : undefined,
    agentOf: () => undefined,
  })
  const rows = await reader.list(undefined)
  assert.deepEqual(rows, [{ id: 'session-live-header', updatedAt: 1_200, createdAt: 900, cwd: '/attached', parentSession: undefined, origin: undefined, live: true }])
})

test('projectionBatch classifies live rows from the attached Session without cold fallback', async () => {
  const liveHeader = header('session-toctou', 500)
  const session = { header: liveHeader }
  const agent = { session, ctx: {} }
  let attached = true
  let coldReads = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: liveHeader, live: false }]),
    sessionProjections: {
      cachedSnapshot: (target: unknown) => target === session ? { values: { title: 'attached title' } } : undefined,
    },
    sessionProjectionCache: {
      cachedSnapshot: () => {
        coldReads += 1
        throw new Error('a previously live row must not fall through to cold cache')
      },
    },
    agentPresets: { composedPreset: () => 'attached' },
  }), {
    sessionOf: id => attached && String(id) === 'session-toctou' ? session : undefined,
    agentOf: id => attached && String(id) === 'session-toctou' ? agent : undefined,
  })
  const liveNow = await reader.projectionBatch([{ id: 'session-toctou', updatedAt: 500, createdAt: 500, live: false }])
  assert.deepEqual(liveNow.get('session-toctou'), { title: 'attached title', preset: 'attached' })
  attached = false
  const staleRows = await reader.projectionBatch([{ id: 'session-toctou', updatedAt: 500, createdAt: 500, live: true }])
  assert.deepEqual(staleRows, new Map())
  assert.equal(coldReads, 0)
})

test('projectionBatch treats a row that became live after listing as live', async () => {
  const headerValue = header('session-late-live', 600)
  const session = { header: headerValue }
  const agent = { session, ctx: {} }
  let attached = false
  let coldReads = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: headerValue, live: false }]),
    sessionProjections: { cachedSnapshot: () => ({ values: { title: 'late live title' } }) },
    sessionProjectionCache: { cachedSnapshot: () => { coldReads += 1; return { values: { title: 'wrong cold title' } } } },
    agentPresets: { composedPreset: () => 'late-live' },
  }), {
    sessionOf: id => attached && String(id) === 'session-late-live' ? session : undefined,
    agentOf: id => attached && String(id) === 'session-late-live' ? agent : undefined,
  })
  attached = true
  const projections = await reader.projectionBatch([{ id: 'session-late-live', updatedAt: 600, createdAt: 600, live: false }])
  assert.equal(projections.get('session-late-live')?.title, 'late live title')
  assert.equal(coldReads, 0)
})

test('projectionBatch passes exact cut zero and reads a fully cached row', async () => {
  const persisted = header('session-cached', 100)
  const cuts: unknown[] = []
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persisted, live: false }]),
    sessionProjectionCache: {
      cachedSnapshot: (_meta: unknown, cut: unknown, keys?: readonly string[]) => {
        cuts.push(cut)
        if (cuts.length === 1) assert.deepEqual(keys, ['sessionListMetadata'])
        else assert.deepEqual(keys, ['title', 'agentPreset'])
        return { values: { title: 'cached title', agentPreset: 'ptc' } }
      },
    },
    agentPresets: {
      list: async () => [{ id: 'ptc' }],
      resolve: async (id?: string) => ({ id: id ?? 'ptc' }),
    },
  }))
  const rows = await reader.list(undefined)
  const projections = await reader.projectionBatch(rows!)
  assert.deepEqual(cuts, [SessionLogOffset(0), SessionLogOffset(0)])
  assert.deepEqual(projections.get('session-cached'), { title: 'cached title', preset: 'ptc' })
})

test('projectionBatch uses the predecessor title hint without a cold observation', async () => {
  const persisted = header('session-predecessor', 100)
  let observed = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: {
      ...query([{ header: persisted, live: false }]),
      observeSession: async () => {
        observed += 1
        throw new Error('picker projection must not observe')
      },
    },
    sessionProjectionCache: {
      cachedSnapshot: () => undefined,
      cachedPredecessorTitle: () => ({ values: { title: 'predecessor title' } }),
    },
  }))
  const rows = await reader.list(undefined)
  const projections = await reader.projectionBatch(rows!)
  assert.equal(projections.get('session-predecessor')?.title, 'predecessor title')
  assert.equal(observed, 0)
})

test('projectionBatch keeps partial cache values and leaves misses unknown', async () => {
  const partial = header('session-partial', 200)
  const miss = header('session-miss', 100)
  let observed = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: {
      ...query([{ header: partial, live: false }, { header: miss, live: false }]),
      observeSession: async () => {
        observed += 1
        throw new Error('cache miss must not activate a Session')
      },
    },
    sessionProjectionCache: {
      cachedSnapshot: (meta: { id: string }) => meta.id === 'session-partial'
        ? { values: { title: 'partial title', agentPreset: null } }
        : undefined,
    },
  }))
  const rows = await reader.list(undefined)
  const projections = await reader.projectionBatch(rows!)
  assert.deepEqual(projections.get('session-partial'), { title: 'partial title' })
  assert.equal(projections.has('session-miss'), false)
  assert.equal(observed, 0)
})

test('projectionBatch skips all cache reads for a seeded row without an exact cut', async () => {
  const seeded = header('session-seeded', 100, { isSeeded: true })
  let cacheReads = 0
  let observed = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: {
      ...query([{ header: seeded, live: false }]),
      observeSession: async () => {
        observed += 1
        throw new Error('seeded picker row must remain unknown')
      },
    },
    sessionProjectionCache: {
      cachedSnapshot: () => {
        cacheReads += 1
        return { values: { title: 'wrong', agentPreset: 'wrong' } }
      },
      cachedPredecessorTitle: () => {
        cacheReads += 1
        return { values: { title: 'wrong' } }
      },
    },
  }))
  const rows = await reader.list(undefined)
  assert.deepEqual(await reader.projectionBatch(rows!), new Map())
  assert.equal(cacheReads, 0)
  assert.equal(observed, 0)
})

test('projectionBatch preserves a native V3 cached code projection', async () => {
  const persisted = header('session-code', 100)
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persisted, live: false }]),
    sessionProjectionCache: {
      cachedSnapshot: () => ({ values: { title: 'kept title', agentPreset: 'code' } }),
    },
    agentPresets: {
      list: async () => [{ id: 'ptc' }],
      resolve: async (id?: string) => ({ id: id ?? 'ptc' }),
    },
  }))
  const rows = await reader.list(undefined)
  assert.deepEqual((await reader.projectionBatch(rows!)).get('session-code'), { title: 'kept title', preset: 'code' })
})

test('projectionBatch keeps cached V3 preset values without a roster resolver', async () => {
  const healthy = header('session-healthy', 110)
  const nativeCode = header('session-native-code', 100)
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: healthy, live: false }, { header: nativeCode, live: false }]),
    sessionProjectionCache: {
      cachedSnapshot: (meta: { id: string }) => meta.id === 'session-healthy'
        ? { values: { title: 'healthy title', agentPreset: 'ptc' } }
        : { values: { title: 'kept title', agentPreset: 'code' } },
    },
  }))
  const rows = await reader.list(undefined)
  const projections = await reader.projectionBatch(rows!)
  assert.deepEqual(projections.get('session-healthy'), { title: 'healthy title', preset: 'ptc' })
  assert.deepEqual(projections.get('session-native-code'), { title: 'kept title', preset: 'code' })
})

test('projectionBatch rejects an already-aborted signal before reading', async () => {
  const controller = new AbortController()
  controller.abort()
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: header('session-a', 100), live: false }]),
    sessionProjectionCache: { cachedSnapshot: () => { throw new Error('must not read') } },
  }))
  await assert.rejects(reader.projectionBatch([row('session-a', 100)], controller.signal), /abort/i)
})

test('search calls searchSessions with the official filters and returns the page', async () => {
  const records = [
    { header: header('session-live', 300), live: true },
    { header: header('session-hit', 200, { cwd: '/workspace' }), live: false },
  ]
  const controller = new AbortController()
  const calls: Array<{ query: string; eventFilters: unknown; limit: number; signal?: AbortSignal }> = []
  const reader = new DirectSessionReader(host({
    sessionQuery: query(records, async (request, exec) => {
      calls.push({ query: request.query, eventFilters: request.eventFilters, limit: request.limit, signal: exec?.signal })
      return { items: [hit('session-hit')] }
    }),
  }))
  const page = await reader.search('needle', controller.signal)
  assert.deepEqual(page, { items: [{ sessionId: 'session-hit', snippet: 'needle in session-hit' }], hasMore: false })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.query, 'needle')
  assert.deepEqual(calls[0]!.eventFilters, [
    { kind: 'type', values: ['user/message', 'assistant/message'] },
    { kind: 'surface', values: ['current'] },
  ])
  assert.equal(calls[0]!.limit, 20)
  assert.equal(calls[0]!.signal, controller.signal, 'the caller signal must reach the provider')
})

test('search excludes cold cwd-less sessions from the visible corpus', async () => {
  const reader = new DirectSessionReader(host({
    sessionQuery: query([
      { header: header('hidden-match', 300, { cwd: undefined }), live: false },
      { header: header('visible-match', 200, { cwd: '/workspace' }), live: false },
    ], async () => ({ items: [hit('hidden-match'), hit('visible-match')] })),
  }))
  const page = await reader.search('needle')
  assert.deepEqual(page, { items: [{ sessionId: 'visible-match', snippet: 'needle in visible-match' }], hasMore: false })
})

test('search finds a match beyond the old newest-100 cutoff', async () => {
  // The regression guard for the retired private rule: the ONLY match is
  // the oldest session (position 101+ by createdAt). The official
  // searchSessions provider finds it — the TUI must not re-impose a
  // newest-100 window over the provider result.
  const older = Array.from({ length: 101 }, (_, index) => ({
    header: header(`older-${index}`, 10_000 - index, { cwd: '/workspace' }),
    live: false,
  }))
  const oldest = { header: header('oldest-match', 1, { cwd: '/workspace' }), live: false }
  const reader = new DirectSessionReader(host({
    sessionQuery: query([...older, oldest], async () => ({ items: [hit('oldest-match')] })),
  }))
  const page = await reader.search('needle')
  assert.deepEqual(page, { items: [{ sessionId: 'oldest-match', snippet: 'needle in oldest-match' }], hasMore: false })
})

test('search without the searchSessions capability is explicitly unavailable', async () => {
  const reader = new DirectSessionReader(host({ sessionQuery: query([{ header: header('session-hit', 200), live: false }]) }))
  assert.equal(await reader.search('needle'), undefined)
})

test('search without the session-query engine is explicitly unavailable', async () => {
  const reader = new DirectSessionReader(host({}))
  assert.equal(await reader.search('needle'), undefined)
})

test('search validates the query before capability detection', async () => {
  // Plan §6.3 / master parity: query validation comes FIRST — an invalid
  // query is a caller error and rejects even when the capability is
  // missing (it must not degrade to the unavailable `undefined`).
  const reader = new DirectSessionReader(host({}))
  await assert.rejects(reader.search('   '), /must not be empty/)
  await assert.rejects(reader.search('x'.repeat(501)), /at most 500/)
  await assert.rejects(reader.search('a\0b'), /must not contain NUL/)
})

test('search calls searchSessions as a method of the query service (receiver preserved)', async () => {
  // The real engine's `searchSessions` is a class method that reads `this`
  // (search enablement, serialized execution, generation state). The
  // adapter must never extract it as a bare function.
  const records = [{ header: header('session-hit', 200, { cwd: '/workspace' }), live: false }]
  const service = {
    marker: 'receiver-ok',
    listSessions: async () => records,
    searchSessions: async function (this: unknown, request: { query: string }) {
      if ((this as { marker?: string }).marker !== 'receiver-ok') {
        throw new Error('searchSessions lost its receiver')
      }
      return { items: [hit('session-hit')] }
    },
  }
  const reader = new DirectSessionReader(host({ sessionQuery: service }))
  const page = await reader.search('needle')
  assert.deepEqual(page, { items: [{ sessionId: 'session-hit', snippet: 'needle in session-hit' }], hasMore: false })
})

test('search maps a list-side provider abort to a cancellation', async () => {
  // The listing runs inside the same error mapping as the search provider:
  // a `SESSION_QUERY_ABORTED` from `listSessions` must surface as an
  // abort-shaped rejection, never as a raw provider error.
  const reader = new DirectSessionReader(host({
    sessionQuery: {
      listSessions: async () => {
        throw Object.assign(new Error('list aborted'), { code: 'SESSION_QUERY_ABORTED' })
      },
      searchSessions: async () => { throw new Error('search provider must not be reached') },
    },
  }))
  await assert.rejects(reader.search('needle'), error => {
    assert.equal((error as Error).name, 'AbortError', 'a list-side abort must map to an abort-shaped error')
    return true
  })
})

test('search rejects an aborted signal even when the capability is missing', async () => {
  // Cancellation preflight comes before capability detection: an aborted
  // signal must reject with an abort-shaped error, never degrade to the
  // "capability unavailable" `undefined` (port contract).
  const controller = new AbortController()
  controller.abort()
  const reader = new DirectSessionReader(host({}))
  await assert.rejects(reader.search('needle', controller.signal), /abort/i)
})

test('search returns undefined when semantic search is explicitly disabled', async () => {
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: header('session-hit', 200, { cwd: '/workspace' }), live: false }], async () => {
      throw Object.assign(new Error('search disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
    }),
  }))
  assert.equal(await reader.search('needle'), undefined)
})

test('search rejects a real provider failure', async () => {
  const refusal = Object.assign(new Error('unknown durable event'), { name: 'SessionFormatUnsupportedError' })
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: header('session-unknown', 100, { cwd: '/workspace' }), live: false }], async () => { throw refusal }),
  }))
  await assert.rejects(reader.search('needle'), error => error === refusal)
})

test('search caps the page at 20 hits and reports hasMore', async () => {
  const headers = Array.from({ length: 30 }, (_, i) => header(`session-${i}`, 1000 - i, { cwd: '/workspace' }))
  const first = headers.slice(0, 20)
  const reader = new DirectSessionReader(host({
    sessionQuery: query(headers.map(item => ({ header: item, live: false })), async (request) => {
      if (request.cursor === undefined) {
        return { items: first.map(item => hit(String(item.id))), nextCursor: 'c1' }
      }
      return { items: headers.slice(20).map(item => hit(String(item.id))) }
    }),
  }))
  const page = await reader.search('needle')
  assert.ok(page !== undefined)
  assert.equal(page.items.length, 20)
  assert.equal(page.hasMore, true)
})

test('search returns an empty page when no cwd-bearing session exists', async () => {
  let providerCalls = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: query([
      { header: header('live-no-cwd', 300, { cwd: undefined }), live: true },
    ], async () => {
      providerCalls += 1
      return { items: [] }
    }),
  }))
  assert.deepEqual(await reader.search('needle'), { items: [], hasMore: false })
  assert.equal(providerCalls, 0, 'an empty visible corpus must not call the provider')
})

test('search honors cancellation through list and provider', async () => {
  const controller = new AbortController()
  controller.abort()
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: header('session-hit', 200, { cwd: '/workspace' }), live: false }], async () => {
      throw new Error('provider must not be reached')
    }),
  }))
  await assert.rejects(reader.search('needle', controller.signal), /abort/i)
})
