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
import { DirectSessionReader, type HostContextLike, type SessionPersistenceLike } from '../src/runtime/direct/session-direct.ts'
import type { SessionQueryLike } from '../src/sessions.ts'

function header(id: string, createdAt: number, extra: Partial<{ cwd: string; agentPreset: string; parentSession: string; origin: 'subagent' }> = {}) {
  return { id, createdAt, version: 1, ...extra }
}

function persistence(headers: Array<{ id: string; createdAt: number; version: number; cwd?: string; agentPreset?: string; parentSession?: string; origin?: 'subagent' }>, contents: Record<string, string> = {}): SessionPersistenceLike {
  return {
    list: async () => headers,
    readRaw: async (id) => (contents[id] === undefined ? undefined : { content: contents[id] }),
    inspect: async () => ({ events: [] }),
  }
}

function query(records: Array<{ header: ReturnType<typeof header>; live: boolean }>): SessionQueryLike {
  return {
    listSessions: async () => records as unknown as SessionQueryLike['listSessions'] extends Promise<infer T> ? T : never,
    readTitleSnapshots: async (ids) =>
      ids.map(id => ({ sessionId: String(id), status: 'fulfilled' as const, value: { title: { title: `title-of-${id}` } } })),
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

test('list returns undefined when persistence is unavailable', async () => {
  const reader = new DirectSessionReader(host({}))
  assert.equal(await reader.list(undefined), undefined)
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
