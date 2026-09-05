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
    version: 2 as const,
    isSeeded: false,
    cwd: '/workspace',
    ...rest,
    ...(parentSession === undefined ? {} : { parentSession: SessionId(parentSession) }),
  }
}

function query(
  records: Array<{ header: ReturnType<typeof header>; live: boolean }>,
  filterEvents?: NonNullable<SessionQueryLike['filterEvents']>,
): SessionQueryLike {
  return {
    listSessions: async () => records,
    ...(filterEvents === undefined ? {} : { filterEvents }),
    // The explicit observation seam is intentionally absent from picker
    // fixtures. It remains optional for the child viewer's resume path.
  }
}

function host(services: Record<string, unknown>): HostContextLike {
  return { get: (name) => services[name] }
}

function row(id: string, createdAt: number, live = false) {
  return { id, createdAt, live }
}

test('list prefers the semantic query engine and sorts newest-first', async () => {
  const reader = new DirectSessionReader(host({
    sessionQuery: query([
      { header: header('session-old', 100), live: false },
      { header: header('session-new', 300), live: true },
    ]),
  }))
  const rows = await reader.list('session-new')
  assert.ok(rows !== undefined)
  assert.deepEqual(rows.map(r => r.id), ['session-new', 'session-old'])
  assert.equal(rows[0].live, true)
})

test('list matches master visibility: cold cwd-less rows are omitted but live rows remain visible', async () => {
  const cacheReads: string[] = []
  const reader = new DirectSessionReader(host({
    sessionQuery: query([
      { header: header('cold-hidden', 400, { cwd: undefined }), live: false },
      { header: header('live-no-cwd', 300, { cwd: undefined }), live: true },
      { header: header('cold-visible', 200, { cwd: '/workspace' }), live: false },
    ]),
    sessionProjectionCache: {
      cachedSnapshot: (meta: { id: string }) => {
        cacheReads.push(meta.id)
        return undefined
      },
    },
  }))
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
      snapshot: (target: unknown) => target === session
        ? { values: { title: 'live title' } }
        : undefined,
    },
    agentPresets: {
      composedPreset: () => 'minimal',
      list: async () => [{ id: 'minimal' }],
      resolve: async (id?: string) => ({ id: id ?? 'minimal' }),
    },
  }), id => id === 'session-live' ? liveAgent : undefined)
  const rows = await reader.list(undefined)
  assert.equal((await reader.projectionBatch(rows!)).get('session-live')?.title, 'live title')
  assert.equal((await reader.projectionBatch(rows!)).get('session-live')?.preset, 'minimal')
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

test('projectionBatch normalizes a cached legacy code through the roster', async () => {
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
  assert.deepEqual((await reader.projectionBatch(rows!)).get('session-code'), { title: 'kept title', preset: 'ptc' })
})

test('projectionBatch isolates a throwing cached preset resolver', async () => {
  const diagnostics: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const healthy = header('session-healthy', 110)
  const legacy = header('session-legacy-code', 100)
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: healthy, live: false }, { header: legacy, live: false }]),
    sessionProjectionCache: {
      cachedSnapshot: (meta: { id: string }) => meta.id === 'session-healthy'
        ? { values: { title: 'healthy title', agentPreset: 'ptc' } }
        : { values: { title: 'kept title', agentPreset: 'code' } },
    },
    agentPresets: {
      list: async () => { throw new Error('roster service down') },
      resolve: async () => { throw new Error('resolver exploded') },
    },
  }), undefined, { info: (message, fields) => diagnostics.push({ message, fields }) })
  const rows = await reader.list(undefined)
  const projections = await reader.projectionBatch(rows!)
  assert.equal(projections.get('session-healthy')?.title, 'healthy title')
  assert.equal(projections.get('session-legacy-code')?.title, 'kept title')
  assert.equal(projections.get('session-legacy-code')?.preset, undefined)
  assert.equal(diagnostics.length, 1)
  assert.match(String(diagnostics[0]!.fields?.reason), /resolver exploded/)
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

test('search uses semantic sessionQuery filtering without persistence', async () => {
  const records = [
    { header: header('session-live', 300), live: true },
    { header: header('session-hit', 200, { cwd: '/workspace' }), live: false },
    { header: header('session-miss', 100, { cwd: '/workspace' }), live: false },
  ]
  const reader = new DirectSessionReader(host({
    sessionQuery: query(records, async (id, filters) => {
      assert.deepEqual(filters, [{ kind: 'text', text: 'needle' }])
      if (String(id) !== 'session-hit') return []
      return [{ sessionId: id, seq: 4, type: 'message/user', time: 200, surface: 'current', text: 'prefix Needle suffix' }]
    }),
  }))
  assert.deepEqual(await reader.search('needle'), [{ id: 'session-hit', createdAt: 200, snippet: 'prefix Needle suffix' }])
})

test('search excludes cold cwd-less sessions before semantic filtering', async () => {
  const queried: string[] = []
  const reader = new DirectSessionReader(host({
    sessionQuery: query([
      { header: header('hidden-match', 300, { cwd: undefined }), live: false },
      { header: header('visible-match', 200, { cwd: '/workspace' }), live: false },
    ], async id => {
      queried.push(String(id))
      return String(id) === 'visible-match'
        ? [{ sessionId: id, seq: 1, type: 'message/user', time: 200, surface: 'current', text: 'needle' }]
        : []
    }),
  }))
  assert.deepEqual(await reader.search('needle'), [{ id: 'visible-match', createdAt: 200, snippet: 'needle' }])
  assert.deepEqual(queried, ['visible-match'])
})

test('search applies visibility before the newest-100 work bound', async () => {
  const hidden = Array.from({ length: 101 }, (_, index) => ({
    header: header(`hidden-${index}`, 10_000 - index, { cwd: undefined }),
    live: false,
  }))
  const visible = { header: header('visible-old', 1, { cwd: '/workspace' }), live: false }
  const reader = new DirectSessionReader(host({
    sessionQuery: query([...hidden, visible], async id => [
      { sessionId: id, seq: 1, type: 'message/user', time: 1, surface: 'current', text: 'needle' },
    ]),
  }))
  assert.deepEqual(await reader.search('needle'), [{ id: 'visible-old', createdAt: 1, snippet: 'needle' }])
})

test('search without semantic filtering is explicitly unavailable', async () => {
  const reader = new DirectSessionReader(host({ sessionQuery: query([{ header: header('session-hit', 200), live: false }]) }))
  assert.equal(await reader.search('needle'), undefined)
})

test('search returns undefined when semantic search is explicitly disabled', async () => {
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: header('session-hit', 200, { cwd: '/workspace' }), live: false }], async () => {
      throw Object.assign(new Error('search disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
    }),
  }))
  assert.equal(await reader.search('needle'), undefined)
})

test('search scans newest sessions and returns bounded snippets', async () => {
  const reader = new DirectSessionReader(host({
    sessionQuery: query([
      { header: header('session-hit', 200, { cwd: '/workspace' }), live: false },
      { header: header('session-miss', 100, { cwd: '/workspace' }), live: false },
    ], async id => String(id) === 'session-hit'
      ? [{ sessionId: id, seq: 4, type: 'message/user', time: 200, surface: 'current', text: 'prefix needle suffix' }]
      : []),
  }))
  const hits = await reader.search('needle')
  assert.ok(hits !== undefined)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'session-hit')
})

test('search caps at 20 hits', async () => {
  const headers = Array.from({ length: 30 }, (_, i) => header(`session-${i}`, 1000 - i, { cwd: '/workspace' }))
  const reader = new DirectSessionReader(host({
    sessionQuery: query(headers.map(item => ({ header: item, live: false })), async id => [
      { sessionId: id, seq: 1, type: 'message/user', time: 1000, surface: 'current', text: `x needle ${id}` },
    ]),
  }))
  const hits = await reader.search('needle')
  assert.equal(hits?.length, 20)
})

test('search preserves an unsupported session-format refusal', async () => {
  const refusal = Object.assign(new Error('unknown durable event'), { name: 'SessionFormatUnsupportedError' })
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: header('session-unknown', 100, { cwd: '/workspace' }), live: false }], async () => { throw refusal }),
  }))
  await assert.rejects(reader.search('needle'), error => error === refusal)
})

test('search never sorts the shared query list in place', async () => {
  const shared = [header('session-old', 100, { cwd: '/workspace' }), header('session-new', 300, { cwd: '/workspace' })]
  const before = [...shared]
  const reader = new DirectSessionReader(host({
    sessionQuery: query(shared.map(item => ({ header: item, live: false })), async id => String(id) === 'session-new'
      ? [{ sessionId: id, seq: 1, type: 'message/user', time: 300, surface: 'current', text: 'needle here' }]
      : []),
  }))
  const hits = await reader.search('needle')
  assert.equal(hits?.[0]?.id, 'session-new')
  assert.deepEqual(shared, before)
})

test('readExportData serializes the committed log through a read handle', async () => {
  const committedHeader = header('session-export', 100, { cwd: '/ws' })
  let closed = 0
  const reader = new DirectSessionReader(host({
    sessionPersistence: {
      open: async () => ({
        header: committedHeader,
        read: async () => [{ type: 'message/user', seq: 1, time: 100, content: 'hi' }],
        close: async () => { closed += 1 },
      }),
    },
  }))
  const result = await reader.readExportData('session-export')
  assert.equal(result.kind, 'found')
  if (result.kind === 'found') {
    assert.equal(result.data.filename, 'session-export.jsonl')
    const lines = result.data.content.trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]!).type, 'session')
    assert.equal(JSON.parse(lines[0]!).id, 'session-export')
    assert.equal(JSON.parse(lines[1]!).type, 'message/user')
  }
  assert.equal(closed, 1)
})

test('readExportData flushes a live session before the committed read', async () => {
  const committedHeader = header('session-flush', 100)
  let flushed = 0
  let opened = false
  const reader = new DirectSessionReader(host({
    sessions: { get: () => ({ id: 'session-flush' }), flush: async () => { flushed += 1 } },
    sessionPersistence: {
      open: async () => {
        opened = true
        return { header: committedHeader, read: async () => [], close: async () => {} }
      },
    },
  }))
  const result = await reader.readExportData('session-flush')
  assert.equal(result.kind, 'found')
  assert.equal(flushed, 1)
  assert.equal(opened, true)
})

test('readExportData reads committed events only and never needs sessionQuery', async () => {
  const committedHeader = header('session-crash', 100)
  const reader = new DirectSessionReader(host({
    sessionPersistence: {
      open: async () => ({
        header: committedHeader,
        read: async () => [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } }],
        close: async () => {},
      }),
    },
  }))
  const result = await reader.readExportData('session-crash')
  assert.equal(result.kind, 'found')
  if (result.kind === 'found') assert.equal(result.data.content.trim().split('\n').length, 2)
})

test('readExportData without the persistence read seam is unavailable', async () => {
  const reader = new DirectSessionReader(host({}))
  assert.equal((await reader.readExportData('session-any')).kind, 'unavailable')
})

test('readExportData maps the official absence error to no materialized log', async () => {
  const reader = new DirectSessionReader(host({
    sessionPersistence: {
      open: async () => { throw Object.assign(new Error('session not found'), { name: 'SessionPersistenceNotFoundError' }) },
    },
  }))
  assert.equal((await reader.readExportData('session-gone')).kind, 'none')
})

test('readExportData preserves a rejected log read as an error', async () => {
  const reader = new DirectSessionReader(host({
    sessionPersistence: {
      open: async () => ({
        header: header('session-broken', 100),
        read: async () => { throw new Error('corrupt zstd frame') },
        close: async () => {},
      }),
    },
  }))
  const result = await reader.readExportData('session-broken')
  assert.equal(result.kind, 'error')
  if (result.kind === 'error') assert.match(result.message, /corrupt zstd frame/)
})

test('readExportData fails loudly when closing a successful read fails', async () => {
  const closeFailure = new Error('close failed')
  const reader = new DirectSessionReader(host({
    sessionPersistence: {
      open: async () => ({
        header: header('session-close-failure', 100),
        read: async () => [],
        close: async () => { throw closeFailure },
      }),
    },
  }))
  await assert.rejects(reader.readExportData('session-close-failure'), error => error === closeFailure)
})
