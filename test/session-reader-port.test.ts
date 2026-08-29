/**
 * Adapter contract tests for the Direct session reader
 * (runtime/direct/session-direct.ts, migration M1.3): the port is the
 * semantic boundary — the consumer (commands.ts) depends on `SessionReader`,
 * the Direct adapter owns the `ctx` access, and a Remote adapter must
 * satisfy the SAME contract in a later milestone. These tests pin the
 * contract with a fake Host context, so the two backends cannot drift.
 * @module @xmoon76/dsh-pi-tui/session-reader-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DirectSessionReader, SESSION_PRESET_READ_CONCURRENCY, type HostContextLike, type SessionPersistenceLike } from '../src/runtime/direct/session-direct.ts'
import type { SessionQueryLike } from '../src/sessions.ts'

function header(id: string, createdAt: number, extra: Partial<{ cwd: string; agentPreset: string; parentSession: string; origin: 'subagent' }> = {}) {
  return { id, createdAt, version: 0, ...extra }
}

function persistence(headers: Array<{ id: string; createdAt: number; version: number; cwd?: string; agentPreset?: string; parentSession?: string; origin?: 'subagent' }>, contents: Record<string, string> = {}): SessionPersistenceLike {
  return {
    list: async () => headers,
    readRaw: async (id) => (contents[id] === undefined ? undefined : { content: contents[id] }),
    inspect: async () => ({ events: [] }),
  }
}

function query(
  records: Array<{ header: ReturnType<typeof header>; live: boolean }>,
  filterEvents?: NonNullable<SessionQueryLike['filterEvents']>,
): SessionQueryLike {
  return {
    listSessions: async () => records as unknown as SessionQueryLike['listSessions'] extends Promise<infer T> ? T : never,
    readTitleSnapshots: async (ids) =>
      ids.map(id => ({ sessionId: String(id), status: 'fulfilled' as const, value: { title: { title: `title-of-${id}` } } })),
    ...(filterEvents === undefined ? {} : { filterEvents }),
  }
}

function host(services: Record<string, unknown>): HostContextLike {
  return { get: (name) => services[name] }
}

test('list prefers the session-query engine and sorts newest-first', async () => {
  const reader = new DirectSessionReader(host({
    sessionQuery: query([
      { header: header('session-old', 100), live: false },
      { header: header('session-new', 300), live: true },
    ]),
    sessionPersistence: persistence([header('session-old', 100), header('session-new', 300)]),
  }))
  const rows = await reader.list('session-new')
  assert.ok(rows !== undefined)
  assert.deepEqual(rows.map(r => r.id), ['session-new', 'session-old'])
  assert.equal(rows[0].live, true)
})

test('list falls back to persistence and marks the current session live', async () => {
  const reader = new DirectSessionReader(host({
    sessionPersistence: persistence([header('session-a', 100), header('session-b', 200)]),
  }))
  const rows = await reader.list('session-b')
  assert.ok(rows !== undefined)
  assert.deepEqual(rows.map(r => r.id), ['session-b', 'session-a'])
  assert.equal(rows[0].live, true)
  assert.equal(rows[1].live, false)
})

test('list uses the semantic query roster without requiring raw persistence', async () => {
  const reader = new DirectSessionReader(host({
    sessionQuery: query([
      { header: header('session-a', 100), live: false },
      { header: header('session-b', 200), live: true },
    ]),
  }))
  const rows = await reader.list(undefined)
  assert.ok(rows !== undefined)
  assert.deepEqual(rows.map(row => row.id), ['session-b', 'session-a'])
  assert.equal(rows[0].live, true)
})

test('list is lightweight and presetBatch uses the projection for effective state', async () => {
  const persistedHeader = header('session-selected', 100, { agentPreset: 'standard' })
  let inspected = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persistedHeader, live: false }]),
    sessionProjections: { stateOf: () => 'ptc' },
    sessionPersistence: {
      list: async () => [persistedHeader],
      readRaw: async () => undefined,
      inspect: async () => {
        inspected += 1
        return { meta: persistedHeader as never, events: [] }
      },
    },
  }))
  const rows = await reader.list(undefined)
  assert.ok(rows !== undefined)
  assert.equal(rows[0]?.preset, undefined, 'initial rows do not wait for projection replay')
  const presets = await reader.presetBatch!(rows)
  assert.equal(presets.get('session-selected'), 'ptc')
  assert.equal(inspected, 1)
})

test('presetBatch preserves a projected custom code preset when the roster contains code', async () => {
  const persistedHeader = header('session-custom-code', 100, { agentPreset: 'standard' })
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persistedHeader, live: false }]),
    sessionProjections: { stateOf: () => 'code' },
    sessionPersistence: {
      list: async () => [persistedHeader],
      readRaw: async () => undefined,
      inspect: async () => ({ meta: persistedHeader as never, events: [] }),
    },
    agentPresets: {
      list: async () => [{ id: 'ptc' }, { id: 'code' }],
      resolve: async (id?: string) => ({ id: id ?? 'ptc' }),
    },
  }))
  const rows = await reader.list(undefined)
  assert.equal((await reader.presetBatch!(rows!)).get('session-custom-code'), 'code')
})

test('presetBatch omits legacy code when the roster has neither code nor ptc', async () => {
  const persistedHeader = header('session-empty-roster', 100, { agentPreset: 'code' })
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persistedHeader, live: false }]),
    sessionProjections: { stateOf: () => 'code' },
    sessionPersistence: {
      list: async () => [persistedHeader],
      readRaw: async () => undefined,
      inspect: async () => ({ meta: persistedHeader as never, events: [] }),
    },
    agentPresets: {
      list: async () => [],
      resolve: async (id?: string) => ({ id: id ?? 'ptc' }),
    },
  }))
  const rows = await reader.list(undefined)
  assert.deepEqual(await reader.presetBatch!(rows!), new Map())
})

test('list does not treat a persisted header as effective preset without the projection service', async () => {
  let inspected = 0
  const persistedHeader = header('session-unprojected', 100, { agentPreset: 'standard' })
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persistedHeader, live: false }]),
    sessionPersistence: {
      list: async () => [persistedHeader],
      readRaw: async () => undefined,
      inspect: async () => {
        inspected += 1
        throw new Error('projectionless listing must not inspect durable events')
      },
    },
  }))
  const rows = await reader.list(undefined)
  assert.ok(rows !== undefined)
  assert.equal(rows[0]?.preset, undefined)
  assert.equal(inspected, 0)
})

test('list bounds cold-session projection inspections', async () => {
  let active = 0
  let maximum = 0
  let persistenceLists = 0
  const headers = Array.from({ length: SESSION_PRESET_READ_CONCURRENCY * 3 }, (_, index) => header(`session-cold-${index}`, index))
  const reader = new DirectSessionReader(host({
    sessionQuery: query(headers.map(item => ({ header: item, live: false }))),
    sessionProjections: { stateOf: () => 'standard' },
    sessionPersistence: {
      list: async () => {
        persistenceLists += 1
        return headers
      },
      readRaw: async () => undefined,
      inspect: async (sessionId: SessionId) => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active -= 1
        const meta = headers.find(item => String(item.id) === String(sessionId))
        return { meta: meta as never, events: [] }
      },
    },
  }))
  const rows = await reader.list(undefined)
  assert.equal(rows?.length, headers.length)
  await reader.presetBatch!(rows!)
  assert.ok(maximum <= SESSION_PRESET_READ_CONCURRENCY,
    `cold-session inspections exceeded the bound: ${maximum}`)
  assert.equal(persistenceLists, 0, 'query-backed enrichment must use the semantic query roster and never list persistence')
})

test('presetBatch fails closed when a cold projection inspection rejects', async () => {
  const refusal = new Error('projection replay failed')
  const persistedHeader = header('session-broken', 100)
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persistedHeader, live: false }]),
    sessionProjections: { stateOf: () => 'standard' },
    sessionPersistence: {
      list: async () => [persistedHeader],
      readRaw: async () => undefined,
      inspect: async () => { throw refusal },
    },
  }))
  const rows = await reader.list(undefined)
  assert.deepEqual(await reader.presetBatch!(rows!), new Map(), 'a failed log never falls back to header metadata')
})

test('list cancellation stops new cold inspections and forwards the signal', async () => {
  const controller = new AbortController()
  const refusal = new Error('listing cancelled')
  const headers = Array.from({ length: SESSION_PRESET_READ_CONCURRENCY * 2 }, (_, index) =>
    header(`session-cancel-${index}`, index))
  let inspections = 0
  let receivedSignal: AbortSignal | undefined
  const reader = new DirectSessionReader(host({
    sessionQuery: query(headers.map(item => ({ header: item, live: false }))),
    sessionProjections: { stateOf: () => 'standard' },
    sessionPersistence: {
      list: async () => headers,
      readRaw: async () => undefined,
      inspect: async (sessionId: SessionId, signal?: AbortSignal) => {
        receivedSignal = signal
        inspections += 1
        if (inspections === 1) controller.abort(refusal)
        signal?.throwIfAborted()
        const meta = headers.find(item => String(item.id) === String(sessionId))
        return { meta: meta as never, events: [] }
      },
    },
  }))
  const rows = await reader.list(undefined, controller.signal)
  await assert.rejects(reader.presetBatch!(rows!, controller.signal), error => error === refusal)
  assert.equal(receivedSignal, controller.signal)
  assert.equal(inspections, 1, 'no cold inspection may start after cancellation')
})

test('list returns undefined when persistence is unavailable', async () => {
  const reader = new DirectSessionReader(host({}))
  assert.equal(await reader.list(undefined), undefined)
})

test('search uses semantic sessionQuery filtering without requiring persistence', async () => {
  let listedFromPersistence = 0
  let readRaw = 0
  const records = [
    { header: header('session-live', 300), live: true },
    { header: header('session-hit', 200), live: false },
    { header: header('session-miss', 100), live: false },
  ]
  const reader = new DirectSessionReader(host({
    sessionQuery: query(records, async (id, filters) => {
      assert.deepEqual(filters, [{ kind: 'text', text: 'needle' }])
      if (String(id) !== 'session-hit') return []
      return [{
        sessionId: id,
        seq: 4,
        type: 'message/user',
        time: 200,
        surface: 'current',
        text: 'prefix Needle suffix',
      }]
    }),
    sessionPersistence: {
      list: async () => {
        listedFromPersistence += 1
        throw new Error('semantic search must not list persistence')
      },
      readRaw: async () => {
        readRaw += 1
        throw new Error('semantic search must not read raw artifacts')
      },
      inspect: async () => ({ events: [] }),
    },
  }))
  const hits = await reader.search('needle')
  assert.deepEqual(hits, [{ id: 'session-hit', createdAt: 200, snippet: 'prefix Needle suffix' }])
  assert.equal(listedFromPersistence, 0)
  assert.equal(readRaw, 0)
})

test('search keeps the raw traversal only as an explicit no-query capability fallback', async () => {
  const reader = new DirectSessionReader(host({
    sessionPersistence: persistence(
      [header('session-hit', 200), header('session-miss', 100)],
      { 'session-hit': 'prefix needle suffix' },
    ),
  }))
  const hits = await reader.search('needle')
  assert.ok(hits !== undefined)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'session-hit')
  assert.ok(hits[0].snippet.includes('needle'))
})

test('search falls back to raw artifacts only when semantic search is explicitly disabled', async () => {
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: header('session-hit', 200), live: false }], async () => {
      throw Object.assign(new Error('search disabled'), { code: 'SESSION_QUERY_SEARCH_DISABLED' })
    }),
    sessionPersistence: persistence(
      [header('session-hit', 200)],
      { 'session-hit': 'prefix needle suffix' },
    ),
  }))
  const hits = await reader.search('needle')
  assert.ok(hits !== undefined)
  assert.equal(hits[0].id, 'session-hit')
})

test('search scans the newest 100 sessions and returns bounded snippets', async () => {
  const reader = new DirectSessionReader(host({
    sessionPersistence: persistence(
      [header('session-hit', 200), header('session-miss', 100)],
      { 'session-hit': 'prefix needle suffix' },
    ),
  }))
  const hits = await reader.search('needle')
  assert.ok(hits !== undefined)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, 'session-hit')
  assert.ok(hits[0].snippet.includes('needle'))
})

test('search skips unreadable sessions and caps at 20 hits', async () => {
  const headers = Array.from({ length: 30 }, (_, i) => header(`session-${i}`, 1000 - i))
  const contents: Record<string, string> = {}
  for (let i = 0; i < 30; i++) contents[`session-${i}`] = `x needle ${i}`
  const reader = new DirectSessionReader(host({
    sessionPersistence: {
      list: async () => headers,
      readRaw: async (id: string) => (id === 'session-0' ? Promise.reject(new Error('boom')) : { content: contents[id] }),
    },
  }))
  const hits = await reader.search('needle')
  assert.ok(hits !== undefined)
  assert.equal(hits.length, 20, 'capped at 20')
  assert.ok(!hits.some(h => h.id === 'session-0'), 'unreadable session skipped')
})

test('search preserves an unsupported session-format refusal', async () => {
  const refusal = Object.assign(new Error('unknown durable event'), { name: 'SessionFormatUnsupportedError' })
  const reader = new DirectSessionReader(host({
    sessionPersistence: {
      list: async () => [header('session-unknown', 100)],
      readRaw: async () => { throw refusal },
    },
  }))
  await assert.rejects(reader.search('needle'), error => error === refusal)
})

test('search never sorts the persistence list in place (the shared array stays untouched)', async () => {
  // The persistence service may hand out a SHARED array: an in-place sort
  // inside the adapter would reorder it for every other consumer (review
  // finding). The adapter must copy before sorting.
  const shared = [header('session-old', 100), header('session-new', 300)]
  const before = [...shared]
  const reader = new DirectSessionReader(host({
    sessionPersistence: {
      list: async () => shared,
      readRaw: async (id: string) => (id === 'session-new' ? { content: 'needle here' } : undefined),
    },
  }))
  const hits = await reader.search('needle')
  assert.ok(hits !== undefined)
  assert.equal(hits[0].id, 'session-new')
  assert.deepEqual(shared, before, 'the shared array keeps its original order')
})

test('titles delegates to the title batch loader through the query engine', async () => {
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: header('session-a', 100), live: false }]),
    sessionPersistence: persistence([header('session-a', 100)]),
  }))
  const titles = await reader.titles([{ id: 'session-a', createdAt: 100, live: false }])
  assert.equal(titles.get('session-a'), 'title-of-session-a')
})

test('titles never consults persistence behind the engine, even for rejected reads', async () => {
  // The engine's cold path already performs the same persistence
  // inspection behind its consistency guards; a rejected read must NOT be
  // retried by the adapter (port contract — the engine decides).
  let inspected = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async (ids: readonly SessionId[]) =>
        ids.map(id => String(id) === 'session-broken'
          ? { sessionId: String(id), status: 'rejected' as const, reason: new Error('engine boom') }
          : { sessionId: String(id), status: 'fulfilled' as const, value: { title: { title: `title-of-${id}` } } }),
    },
    sessionPersistence: {
      list: async () => [],
      readRaw: async () => undefined,
      inspect: async () => {
        inspected += 1
        return { events: [] }
      },
    },
  }))
  const titles = await reader.titles([
    { id: 'session-ok', createdAt: 100, live: false },
    { id: 'session-broken', createdAt: 90, live: false },
  ])
  assert.equal(titles.get('session-ok'), 'title-of-session-ok')
  assert.equal(titles.has('session-broken'), false, 'a rejected read must leave the row untitled')
  assert.equal(inspected, 0, 'persistence must never be consulted behind the engine')
})

test('titles reports rejected engine reads at INFO with the engine code and reason', async () => {
  const diagnostics: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const reader = new DirectSessionReader(host({
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async (ids: readonly SessionId[]) =>
        ids.map(id => ({
          sessionId: String(id),
          status: 'rejected' as const,
          reason: Object.assign(new Error('corrupt log'), { code: 'SESSION_QUERY_CORRUPT_SESSION' }),
        })),
    },
    sessionPersistence: persistence([header('session-broken', 90)]),
  }), undefined, {
    info: (message: string, fields?: Record<string, unknown>) => diagnostics.push({ message, fields }),
  })
  const titles = await reader.titles([{ id: 'session-broken', createdAt: 90, live: false }])
  assert.equal(titles.has('session-broken'), false)
  assert.equal(diagnostics.length, 1, 'the rejection must land in diagnostics')
  assert.equal(diagnostics[0]!.message, 'session title unavailable')
  assert.equal(diagnostics[0]!.fields?.code, 'SESSION_QUERY_CORRUPT_SESSION', 'the engine code must be exposed')
  assert.match(String(diagnostics[0]!.fields?.reason), /corrupt log/, 'the engine reason must be preserved')
})

test('titles preserves an unsupported engine format refusal after diagnosing it', async () => {
  const refusal = Object.assign(new Error('unknown durable event'), { name: 'SessionFormatUnsupportedError' })
  const diagnostics: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const reader = new DirectSessionReader(host({
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshots: async () => [{
        sessionId: 'session-unknown',
        status: 'rejected' as const,
        reason: refusal,
      }],
    },
  }), undefined, {
    info: (message: string, fields?: Record<string, unknown>) => diagnostics.push({ message, fields }),
  })
  await assert.rejects(
    reader.titles([{ id: 'session-unknown', createdAt: 90, live: false }]),
    error => error === refusal,
  )
  assert.equal(diagnostics[0]?.message, 'session title unavailable')
})

test('readExportData preserves a REJECTED log read as an error with the diagnostic', async () => {
  const reader = new DirectSessionReader(host({
    sessionPersistence: {
      list: async () => [],
      readRaw: async () => { throw new Error('corrupt zstd frame') },
    },
  }))
  const result = await reader.readExportData('session-broken')
  assert.equal(result.kind, 'error', 'a corrupt log is a REAL failure, never "no materialized log"')
  if (result.kind === 'error') assert.ok(result.message.includes('corrupt zstd frame'))
})
