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

test('titles delegates to the title batch loader through the query engine', async () => {
  const reader = new DirectSessionReader(host({
    sessionQuery: query([{ header: header('session-a', 100), live: false }]),
    sessionPersistence: persistence([header('session-a', 100)]),
  }))
  const titles = await reader.titles([{ id: 'session-a', createdAt: 100, live: false }])
  assert.equal(titles.get('session-a'), 'title-of-session-a')
})
