/**
 * Adapter contract tests for the Direct session reader
 * (runtime/direct/session-direct.ts, migration M1.3): the port is the
 * semantic boundary — the consumer (commands.ts) depends on `SessionReader`,
 * the Direct adapter owns the `ctx` access, and a Remote adapter must
 * satisfy the SAME contract in a later milestone. These tests pin the
 * contract with a fake Host context, so the two backends cannot drift.
 *
 * The projection-batch tests pin the official ladder (plan §15): a fully
 * cached row reads ZERO cold observations, a cache miss performs at most ONE
 * `observeSession()` whose cut resolves title AND agentPreset together, and
 * per-row corruption is isolated with a diagnostic instead of hiding the
 * picker.
 * @module @xmoon76/dsh-pi-tui/session-reader-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { DirectSessionReader, type HostContextLike, type SessionPersistenceLike, type SessionQueryLike } from '../src/runtime/direct/session-direct.ts'
import { SESSION_PROJECTION_READ_CONCURRENCY } from '../src/runtime/direct/session-projection-direct.ts'

function header(id: string, createdAt: number, extra: Partial<{ cwd: string; agentPreset: string; parentSession: string; origin: 'subagent' }> = {}) {
  return { id, createdAt, version: 0, ...extra }
}

function persistence(headers: Array<{ id: string; createdAt: number; version: number; cwd?: string; agentPreset?: string; parentSession?: string; origin?: 'subagent' }>, contents: Record<string, string> = {}): SessionPersistenceLike {
  return {
    list: async () => headers,
    readRaw: async (id) => (contents[id] === undefined ? undefined : { content: contents[id] }),
  }
}

type ObserveSession = (id: SessionId, options?: { signal?: AbortSignal }) => Promise<unknown>

/** A fake query engine. `titleSnapshotReads` counts calls to the RETIRED
 * legacy batch title read (no longer part of the adapter's structural
 * surface) so tests can assert the projection path never touches it. */
type FakeQuery = SessionQueryLike & {
  titleSnapshotReads: number
  readTitleSnapshots(ids: readonly unknown[]): Promise<unknown[]>
}

function query(
  records: Array<{ header: ReturnType<typeof header>; live: boolean }>,
  filterEvents?: NonNullable<SessionQueryLike['filterEvents']>,
  observeSession?: ObserveSession,
): FakeQuery {
  let titleSnapshotReads = 0
  return {
    listSessions: async () => records as unknown as SessionQueryLike['listSessions'] extends Promise<infer T> ? T : never,
    readTitleSnapshots: async () => {
      titleSnapshotReads += 1
      return []
    },
    ...(filterEvents === undefined ? {} : { filterEvents }),
    ...(observeSession === undefined ? {} : { observeSession }),
    get titleSnapshotReads() {
      return titleSnapshotReads
    },
  }
}

/** One fake observation lease over the official `observeSession` seam,
 * carrying BOTH projection values in its cut. */
function observation(agentPreset: string | null | undefined, title: string | null = 'title-of-session') {
  return {
    source: 'prepared' as const,
    header: { id: 'session-x', createdAt: 0, version: 0 },
    ...(agentPreset === undefined && title === undefined ? {} : { projections: { values: { ...(title === undefined ? {} : { title }), ...(agentPreset === undefined ? {} : { agentPreset }) } } }),
    [Symbol.dispose]: () => {},
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

test('list is lightweight and projectionBatch uses the observation seam for effective state', async () => {
  const persistedHeader = header('session-selected', 100, { agentPreset: 'standard' })
  let observed = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: query(
      [{ header: persistedHeader, live: false }],
      undefined,
      async () => {
        observed += 1
        return observation('ptc')
      },
    ),
    sessionProjections: { stateOf: () => 'ptc' },
    sessionPersistence: {
      list: async () => [persistedHeader],
      readRaw: async () => undefined,
    },
  }))
  const rows = await reader.list(undefined)
  assert.ok(rows !== undefined)
  assert.equal(rows[0]?.preset, undefined, 'initial rows do not wait for projection replay')
  const projections = await reader.projectionBatch(rows)
  assert.equal(projections.get('session-selected')?.preset, 'ptc')
  assert.equal(observed, 1)
})

test('projectionBatch preserves a projected custom code preset when the roster contains code', async () => {
  const persistedHeader = header('session-custom-code', 100, { agentPreset: 'standard' })
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persistedHeader, live: false }], undefined, () => Promise.resolve(observation('code'))),
    sessionProjections: { stateOf: () => 'code' },
    sessionPersistence: {
      list: async () => [persistedHeader],
      readRaw: async () => undefined,
    },
    agentPresets: {
      list: async () => [{ id: 'ptc' }, { id: 'code' }],
      resolve: async (id?: string) => ({ id: id ?? 'ptc' }),
    },
  }))
  const rows = await reader.list(undefined)
  assert.equal((await reader.projectionBatch(rows!)).get('session-custom-code')?.preset, 'code')
})

test('projectionBatch omits legacy code when the roster has neither code nor ptc', async () => {
  const persistedHeader = header('session-empty-roster', 100, { agentPreset: 'code' })
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persistedHeader, live: false }], undefined, () => Promise.resolve(observation('code', null))),
    sessionProjections: { stateOf: () => 'code' },
    sessionPersistence: {
      list: async () => [persistedHeader],
      readRaw: async () => undefined,
    },
    agentPresets: {
      list: async () => [],
      resolve: async (id?: string) => ({ id: id ?? 'ptc' }),
    },
  }))
  const rows = await reader.list(undefined)
  // The unusable preset identity is dropped; the combined observation still
  // yields the (here null → absent) title without a second read.
  assert.deepEqual(await reader.projectionBatch(rows!), new Map())
})

test('list does not treat a persisted header as effective preset without the observation seam', async () => {
  const persistedHeader = header('session-unprojected', 100, { agentPreset: 'standard' })
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persistedHeader, live: false }]),
    sessionPersistence: {
      list: async () => [persistedHeader],
      readRaw: async () => undefined,
    },
  }))
  const rows = await reader.list(undefined)
  assert.ok(rows !== undefined)
  assert.equal(rows[0]?.preset, undefined)
  assert.deepEqual(await reader.projectionBatch(rows), new Map(), 'no observation seam means no cold projection enrichment')
})

test('projectionBatch bounds cold-session observations', async () => {
  let active = 0
  let maximum = 0
  let persistenceLists = 0
  const headers = Array.from({ length: SESSION_PROJECTION_READ_CONCURRENCY * 3 }, (_, index) => header(`session-cold-${index}`, index))
  const reader = new DirectSessionReader(host({
    sessionQuery: query(
      headers.map(item => ({ header: item, live: false })),
      undefined,
      async () => {
        active += 1
        maximum = Math.max(maximum, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active -= 1
        return observation('standard')
      },
    ),
    sessionProjections: { stateOf: () => 'standard' },
    sessionPersistence: {
      list: async () => {
        persistenceLists += 1
        return headers
      },
      readRaw: async () => undefined,
    },
  }))
  const rows = await reader.list(undefined)
  assert.equal(rows?.length, headers.length)
  await reader.projectionBatch(rows!)
  assert.ok(maximum <= SESSION_PROJECTION_READ_CONCURRENCY,
    `cold-session observations exceeded the bound: ${maximum}`)
  assert.equal(persistenceLists, 0, 'enrichment must use the list() header snapshot and never list persistence again')
})

test('projectionBatch fails closed per row when one cold observation rejects', async () => {
  const corrupt = Object.assign(new Error('corrupt session log'), { code: 'SESSION_QUERY_CORRUPT_SESSION' })
  const diagnostics: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const healthy = header('session-healthy', 110)
  const broken = header('session-broken', 100)
  const reader = new DirectSessionReader(host({
    sessionQuery: query(
      [{ header: healthy, live: false }, { header: broken, live: false }],
      undefined,
      id => String(id) === 'session-broken' ? Promise.reject(corrupt) : Promise.resolve(observation('ptc', 'healthy title')),
    ),
    sessionPersistence: {
      list: async () => [healthy, broken],
      readRaw: async () => undefined,
    },
  }), undefined, {
    info: (message, fields) => diagnostics.push({ message, fields }),
  })
  const rows = await reader.list(undefined)
  const projections = await reader.projectionBatch(rows!)
  assert.equal(projections.get('session-healthy')?.title, 'healthy title', 'the healthy row keeps its enrichment')
  assert.equal(projections.get('session-healthy')?.preset, 'ptc')
  assert.equal(projections.has('session-broken'), false, 'a corrupt row is omitted, never faked')
  assert.equal(diagnostics.length, 1, 'the corrupt row lands in diagnostics')
  assert.equal(diagnostics[0]!.message, 'session projection unavailable')
  assert.equal(diagnostics[0]!.fields?.session, 'session-broken')
  assert.equal(diagnostics[0]!.fields?.code, 'SESSION_QUERY_CORRUPT_SESSION')
})

test('list cancellation stops new cold observations and forwards the signal', async () => {
  const controller = new AbortController()
  const refusal = new Error('listing cancelled')
  const headers = Array.from({ length: SESSION_PROJECTION_READ_CONCURRENCY * 2 }, (_, index) =>
    header(`session-cancel-${index}`, index))
  let observations = 0
  let receivedSignal: AbortSignal | undefined
  const reader = new DirectSessionReader(host({
    sessionQuery: query(
      headers.map(item => ({ header: item, live: false })),
      undefined,
      async (_id, options) => {
        receivedSignal = options?.signal
        observations += 1
        if (observations === 1) controller.abort(refusal)
        options?.signal?.throwIfAborted()
        return observation('standard')
      },
    ),
    sessionProjections: { stateOf: () => 'standard' },
    sessionPersistence: {
      list: async () => headers,
      readRaw: async () => undefined,
    },
  }))
  const rows = await reader.list(undefined, controller.signal)
  await assert.rejects(reader.projectionBatch(rows!, controller.signal), error => error === refusal)
  assert.equal(receivedSignal, controller.signal)
  assert.equal(observations, 1, 'no cold observation may start after cancellation')
})

test('projectionBatch rejects an already-aborted signal without observing', async () => {
  const controller = new AbortController()
  controller.abort()
  const reader = new DirectSessionReader(host({
    sessionQuery: query([header('session-a', 100)].map(item => ({ header: item, live: false })), undefined, () => {
      throw new Error('an aborted batch must never observe')
    }),
  }))
  await assert.rejects(
    reader.projectionBatch([{ id: 'session-a', createdAt: 100, live: false }], controller.signal),
    /abort/i,
  )
})

test('projectionBatch serves a fully cached title+preset with ZERO cold observations', async () => {
  const headers = Array.from({ length: 250 }, (_, index) => header(`session-cached-${index}`, index))
  let observed = 0
  const fakeQuery = query(
    headers.map(item => ({ header: item, live: false })),
    undefined,
    () => {
      observed += 1
      return Promise.reject(new Error('a cache hit must not observe the session'))
    },
  )
  const reader = new DirectSessionReader(host({
    sessionQuery: fakeQuery,
    sessionProjectionCache: {
      cachedSnapshot: (meta: { id: unknown }) => ({
        asOfSeq: 3,
        values: { title: `title-of-${String(meta.id)}`, agentPreset: 'ptc' },
      }),
    },
    agentPresets: {
      list: async () => [{ id: 'ptc' }],
      resolve: async (id?: string) => ({ id: id ?? 'ptc' }),
    },
  }))
  const rows = await reader.list(undefined)
  const projections = await reader.projectionBatch(rows!)
  assert.equal(projections.size, 250)
  assert.equal(projections.get('session-cached-42')?.title, 'title-of-session-cached-42')
  assert.equal(projections.get('session-cached-42')?.preset, 'ptc')
  assert.equal(observed, 0, 'a cache hit must not observe the session')
  assert.equal(fakeQuery.titleSnapshotReads, 0, 'the legacy batch title read is retired')
})

test('projectionBatch resolves title AND preset from ONE observation on a cache miss', async () => {
  const persistedHeader = header('session-cold', 100)
  let observed = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persistedHeader, live: false }], undefined, async () => {
      observed += 1
      return observation('standard', 'foo')
    }),
    sessionProjectionCache: {
      cachedSnapshot: () => undefined,
    },
  }))
  const rows = await reader.list(undefined)
  const projections = await reader.projectionBatch(rows!)
  assert.equal(projections.get('session-cold')?.title, 'foo')
  assert.equal(projections.get('session-cold')?.preset, 'standard')
  assert.equal(observed, 1, 'a cache miss observes the session exactly once — never once per field')
})

test('projectionBatch treats a null cached title as final and a null cached preset as a miss', async () => {
  const persistedHeader = header('session-nulls', 100)
  let observed = 0
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persistedHeader, live: false }], undefined, async () => {
      observed += 1
      return observation('minimal', null)
    }),
    sessionProjectionCache: {
      cachedSnapshot: () => ({ asOfSeq: 1, values: { title: null, agentPreset: null } }),
    },
  }))
  const rows = await reader.list(undefined)
  const projections = await reader.projectionBatch(rows!)
  assert.equal(observed, 1, 'a null agentPreset is not a usable identity — the row is observed')
  assert.deepEqual(projections.get('session-nulls'), { preset: 'minimal' }, 'the observed preset resolves; the null title stays absent')
})

test('projectionBatch observes only what the ladder leaves open (mixed hit/miss/live)', async () => {
  const liveHeader = header('session-live', 400)
  const hitHeader = header('session-hit', 300)
  const partialHeader = header('session-partial', 200)
  const missHeader = header('session-miss', 100)
  const observed: string[] = []
  const session = { header: liveHeader }
  const liveAgent = { session }
  const reader = new DirectSessionReader(host({
    sessionQuery: query(
      [{ header: liveHeader, live: true }, { header: hitHeader, live: false }, { header: partialHeader, live: false }, { header: missHeader, live: false }],
      undefined,
      async id => {
        observed.push(String(id))
        // The partial row's fresher cut reports the title CLEARED (null).
        const title = String(id) === 'session-partial' ? null : `title-${String(id)}`
        return observation('standard', title)
      },
    ),
    sessionProjections: {
      stateOf: () => 'minimal',
      snapshot: (target: unknown) => (target === session ? { asOfSeq: 9, values: { title: 'live title' } } : undefined),
    },
    sessionProjectionCache: {
      cachedSnapshot: (meta: { id: unknown }) => {
        const id = String(meta.id)
        if (id === 'session-hit') return { asOfSeq: 2, values: { title: 'cached title', agentPreset: 'ptc' } }
        if (id === 'session-partial') return { asOfSeq: 1, values: { title: 'stale title', agentPreset: null } }
        return undefined
      },
    },
    agentPresets: {
      list: async () => [{ id: 'ptc' }, { id: 'minimal' }],
      resolve: async (id?: string) => ({ id: id ?? 'ptc' }),
    },
  }), id => (id === 'session-live' ? liveAgent : undefined))
  const rows = await reader.list(undefined)
  const projections = await reader.projectionBatch(rows!)
  // Live: in-memory projection + composed preset, never observed.
  assert.equal(projections.get('session-live')?.title, 'live title')
  assert.equal(projections.get('session-live')?.preset, 'minimal')
  // Full hit: cache only.
  assert.equal(projections.get('session-hit')?.title, 'cached title')
  assert.equal(projections.get('session-hit')?.preset, 'ptc')
  // Partial hit: ONE observation replaces the cached partial values with the
  // fresher cut (null observed title = no title NOW — the stale cached title
  // is dropped).
  assert.equal(projections.get('session-partial')?.title, undefined)
  assert.equal(projections.get('session-partial')?.preset, 'standard')
  // Miss: ONE observation for BOTH fields.
  assert.equal(projections.get('session-miss')?.title, 'title-session-miss')
  assert.equal(projections.get('session-miss')?.preset, 'standard')
  assert.deepEqual(observed, ['session-partial', 'session-miss'], 'live and full-hit rows are never observed')
})

test('projectionBatch normalizes a cached legacy code through the roster', async () => {
  const persistedHeader = header('session-cached-code', 100)
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persistedHeader, live: false }], undefined, () => Promise.reject(new Error('a cache hit must not observe the session'))),
    sessionProjectionCache: {
      cachedSnapshot: () => ({ asOfSeq: 1, values: { title: 'kept title', agentPreset: 'code' } }),
    },
    agentPresets: {
      list: async () => [{ id: 'ptc' }],
      resolve: async (id?: string) => ({ id: id ?? 'ptc' }),
    },
  }))
  const rows = await reader.list(undefined)
  const projections = await reader.projectionBatch(rows!)
  assert.equal(projections.get('session-cached-code')?.preset, 'ptc')
  assert.equal(projections.get('session-cached-code')?.title, 'kept title')
})

test('projectionBatch keeps the cached partial fields when the observation rejects', async () => {
  const persistedHeader = header('session-partial-broken', 100)
  const diagnostics: Array<{ message: string; fields?: Record<string, unknown> }> = []
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: persistedHeader, live: false }], undefined, () => Promise.reject(new Error('corrupt log'))),
    sessionProjectionCache: {
      cachedSnapshot: () => ({ asOfSeq: 1, values: { title: 'kept title', agentPreset: null } }),
    },
  }), undefined, {
    info: (message, fields) => diagnostics.push({ message, fields }),
  })
  const rows = await reader.list(undefined)
  const projections = await reader.projectionBatch(rows!)
  assert.equal(projections.get('session-partial-broken')?.title, 'kept title', 'a cached field survives an isolated observation failure')
  assert.equal(projections.get('session-partial-broken')?.preset, undefined)
  assert.equal(diagnostics.length, 1)
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
