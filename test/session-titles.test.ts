/**
 * Unit tests for the session-title performance work (requirement 4): the
 * progressive batch constants, the local title cache (hit skips the
 * engine/fallback reads, size/mtime invalidation, corrupt-file
 * degradation), and the best-effort log-path derivation matching the
 * JSONL persistence layout.
 * @module @xmoon76/dsh-pi-tui/session-titles.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Carries the `session/title` event map augmentation into the test program.
import type {} from '@deepseek-ai/dsh-session-title'
import {
  PROJECTION_BATCH_SIZE,
  PROJECTION_FIRST_BATCH,
  fileTitleCache,
  loadSessionTitleBatch,
  sessionLogPath,
  titleCachePath,
  type TitleCache,
} from '../src/sessions.ts'

/** A fake $DSH_HOME with one session log whose size/mtime the cache can
 * verify against. */
function fixtureHome(): { home: string; logPath: string } {
  const home = mkdtempSync(join(tmpdir(), 'dsh-titles-'))
  const logPath = sessionLogPath(join(home, 'sessions'), '/ws', 'session-a')
  mkdirSync(dirname(logPath), { recursive: true })
  writeFileSync(logPath, 'log-line-one\n')
  mkdirSync(dirname(titleCachePath(home)), { recursive: true })
  return { home, logPath }
}

/** A query engine that records whether it was consulted. */
function recordingQuery(reads: { count: number }) {
  return {
    readTitleSnapshots: async (ids: readonly string[]) => {
      reads.count += 1
      return ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { session: {}, title: { title: 'alpha title' } } }))
    },
  }
}

test('progressive loading constants keep the first batch visible-window sized', () => {
  assert.equal(PROJECTION_FIRST_BATCH, 20, 'the first batch must fill the visible picker window')
  assert.ok(Number.isInteger(PROJECTION_BATCH_SIZE) && PROJECTION_BATCH_SIZE > 0 && PROJECTION_BATCH_SIZE >= PROJECTION_FIRST_BATCH)
})

test('a valid cache hit skips the engine read entirely', async () => {
  const { home, logPath } = fixtureHome()
  const stats = statSync(logPath)
  const cache: TitleCache = { 'session-a': { title: 'cached title', logSize: stats.size, logMtimeMs: stats.mtimeMs } }
  writeFileSync(titleCachePath(home), JSON.stringify(cache))
  const reads = { count: 0 }
  const titles = await loadSessionTitleBatch(recordingQuery(reads) as never, undefined, home, [{ id: 'session-a', cwd: '/ws' }])
  assert.equal(titles.get('session-a'), 'cached title', 'the cached title must win')
  assert.equal(reads.count, 0, 'a valid cache hit must not touch the engine')
})

test('a stale cache entry (log size changed) re-reads and refreshes the cache', async () => {
  const { home, logPath } = fixtureHome()
  const before = statSync(logPath)
  const cache: TitleCache = { 'session-a': { title: 'stale title', logSize: before.size + 999, logMtimeMs: before.mtimeMs } }
  writeFileSync(titleCachePath(home), JSON.stringify(cache))
  const reads = { count: 0 }
  const titles = await loadSessionTitleBatch(recordingQuery(reads) as never, undefined, home, [{ id: 'session-a', cwd: '/ws' }])
  assert.equal(titles.get('session-a'), 'alpha title', 'a stale entry must re-read the engine')
  assert.equal(reads.count, 1)
  const updated = JSON.parse(await import('node:fs/promises').then(fs => fs.readFile(titleCachePath(home), 'utf8'))) as TitleCache
  const entry = updated['session-a']!
  assert.equal(entry.title, 'alpha title', 'the refreshed entry must be written back')
  assert.equal(entry.logSize, statSync(logPath).size, 'the refreshed entry must carry the current log size')
})

test('an unchanged log keeps serving the cache across calls (no engine reads)', async () => {
  const { home } = fixtureHome()
  const reads = { count: 0 }
  // First call: engine read + write-back.
  await loadSessionTitleBatch(recordingQuery(reads) as never, undefined, home, [{ id: 'session-a', cwd: '/ws' }])
  assert.equal(reads.count, 1)
  // Second call: the cache (same size/mtime) must serve it without the engine.
  await loadSessionTitleBatch(recordingQuery(reads) as never, undefined, home, [{ id: 'session-a', cwd: '/ws' }])
  assert.equal(reads.count, 1, 'a second call with an unchanged log must hit the cache')
})

test('a corrupt cache file degrades to direct reads', async () => {
  const { home } = fixtureHome()
  writeFileSync(titleCachePath(home), '{not json!!')
  const reads = { count: 0 }
  const titles = await loadSessionTitleBatch(recordingQuery(reads) as never, undefined, home, [{ id: 'session-a', cwd: '/ws' }])
  assert.equal(titles.get('session-a'), 'alpha title', 'corrupt cache must not block reads')
  assert.equal(reads.count, 1)
})

test('an absent home disables the cache (plain loadSessionTitles semantics)', async () => {
  const reads = { count: 0 }
  const titles = await loadSessionTitleBatch(recordingQuery(reads) as never, undefined, undefined, [{ id: 'session-a', cwd: '/ws' }])
  assert.equal(titles.get('session-a'), 'alpha title')
  assert.equal(reads.count, 1)
})

test('sessionLogPath mirrors the JSONL persistence layout', () => {
  const root = '/home/u/.dsh/sessions'
  assert.equal(
    sessionLogPath(root, '/home/xmoon/project/dsh-pi-tui', 'session-a'),
    join(root, '--home-xmoon-project-dsh-pi-tui--', 'session-a', 'session.jsonl.zstd'),
  )
  assert.equal(
    sessionLogPath(root, undefined, 'session-b'),
    join(root, '_no-cwd', 'session-b', 'session.jsonl.zstd'),
  )
})

test('fileTitleCache.write creates the cache directory with 0600 permissions', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-titles-'))
  try {
    const store = fileTitleCache(home)
    store.write({ 'session-a': { title: 't', logSize: 1, logMtimeMs: 2 } })
    const mode = statSync(titleCachePath(home)).mode & 0o777
    assert.equal(mode, 0o600, `cache file must be private:\n${mode.toString(8)}`)
    assert.deepEqual(store.read(), { 'session-a': { title: 't', logSize: 1, logMtimeMs: 2 } })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('loadSessionTitleBatch honors an aborted signal through the engine path', async () => {
  const controller = new AbortController()
  controller.abort()
  const query = {
    readTitleSnapshots: async (_ids: readonly string[], signal?: AbortSignal) => {
      signal?.throwIfAborted()
      return []
    },
  }
  await assert.rejects(
    loadSessionTitleBatch(query as never, undefined, undefined, [{ id: 'session-a' }], controller.signal),
    /abort/i,
  )
})

// ── per-session failure isolation: rejected engine reads are NEVER
//    silently dropped AND never retried behind the engine's back — the
//    engine's cold path already runs the same persistence inspection, so
//    a fallback would reproduce the identical failure (PERSISTENCE_FAILED
//    / CORRUPT_SESSION) or bypass its header-identity guard
//    (SOURCE_CONFLICT). The rejection is surfaced as an info diagnostic
//    carrying the engine's code and reason instead. ──────────────────────

/** A title event minimal enough for foldSessionTitle. */
function titleEvent(title: string, seq = 1, time = 1000): SessionEvent<'session/title'> {
  return {
    type: 'session/title',
    seq,
    time,
    data: { title, messageSeqs: [seq], source: { kind: 'user' } },
  } as SessionEvent<'session/title'>
}

/** A query engine returning fulfilled titles except for the given ids. */
function mixedQuery(rejectedIds: readonly string[]) {
  return {
    readTitleSnapshots: async (ids: readonly string[]) =>
      ids.map(id => rejectedIds.includes(String(id))
        ? { sessionId: String(id), status: 'rejected' as const, reason: new Error('engine boom') }
        : { sessionId: String(id), status: 'fulfilled' as const, value: { session: {}, title: { title: 'alpha title' } } }),
  }
}

/** A diag recorder asserting the info channel is used (default-visible). */
function recordingDiag() {
  const diagnostics: Array<{ message: string; fields?: Record<string, unknown> }> = []
  return {
    diagnostics,
    diag: {
      info: (message: string, fields?: Record<string, unknown>) => diagnostics.push({ message, fields }),
    },
  }
}

test('a rejected engine read stays untitled and never touches persistence', async () => {
  let inspected = 0
  const persistence = {
    inspect: async () => {
      inspected += 1
      return { events: [titleEvent('beta title')] }
    },
  }
  const { diagnostics, diag } = recordingDiag()
  const titles = await loadSessionTitleBatch(
    mixedQuery(['session-b']) as never,
    persistence as never,
    undefined,
    [{ id: 'session-a' }, { id: 'session-b' }],
    undefined,
    diag,
  )
  assert.equal(titles.get('session-a'), 'alpha title')
  assert.equal(titles.has('session-b'), false, 'a rejected read must leave the row untitled')
  assert.equal(inspected, 0, 'persistence must never be consulted behind the engine')
  assert.equal(diagnostics.length, 1, 'the rejection must land exactly one diagnostic')
  assert.equal(diagnostics[0]!.message, 'session title unavailable')
  assert.equal(diagnostics[0]!.fields?.session, 'session-b')
  assert.equal(diagnostics[0]!.fields?.code, 'UNKNOWN', 'a plain Error reason carries no engine code')
  assert.match(String(diagnostics[0]!.fields?.reason), /engine boom/, 'the real engine reason must be preserved')
})

test('a rejected read exposes the engine error code at info level', async () => {
  const { diagnostics, diag } = recordingDiag()
  const query = {
    readTitleSnapshots: async (ids: readonly string[]) =>
      ids.map(id => ({
        sessionId: String(id),
        status: 'rejected' as const,
        reason: Object.assign(new Error('session source headers conflict'), { code: 'SESSION_QUERY_SOURCE_CONFLICT' }),
      })),
  }
  await loadSessionTitleBatch(query as never, undefined, undefined, [{ id: 'session-a' }], undefined, diag)
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0]!.fields?.code, 'SESSION_QUERY_SOURCE_CONFLICT', 'the engine code must be exposed')
  assert.match(String(diagnostics[0]!.fields?.reason), /headers conflict/)
})

test('only rejected reads produce diagnostics (fulfilled rows are silent)', async () => {
  const { diagnostics, diag } = recordingDiag()
  const query = {
    readTitleSnapshots: async (ids: readonly string[]) =>
      ids.map(id => String(id) === 'session-b'
        ? { sessionId: String(id), status: 'rejected' as const, reason: new Error('boom') }
        : String(id) === 'session-c'
          ? { sessionId: String(id), status: 'fulfilled' as const, value: { session: {} } }
          : { sessionId: String(id), status: 'fulfilled' as const, value: { session: {}, title: { title: 'alpha title' } } }),
  }
  const titles = await loadSessionTitleBatch(
    query as never,
    undefined,
    undefined,
    [{ id: 'session-a' }, { id: 'session-b' }, { id: 'session-c' }],
    undefined,
    diag,
  )
  assert.equal(titles.get('session-a'), 'alpha title')
  assert.equal(titles.has('session-c'), false, 'a genuinely untitled session stays untitled')
  assert.equal(diagnostics.length, 1, 'only the rejected session may be diagnosed')
  assert.equal(diagnostics[0]!.fields?.session, 'session-b')
})

test('a fulfilled read without a title never falls back to persistence', async () => {
  let inspected = 0
  const persistence = {
    inspect: async () => {
      inspected += 1
      return { events: [] }
    },
  }
  const query = {
    readTitleSnapshots: async (ids: readonly string[]) =>
      ids.map(id => ({ sessionId: String(id), status: 'fulfilled' as const, value: { session: {} } })),
  }
  const titles = await loadSessionTitleBatch(query as never, persistence as never, undefined, [{ id: 'session-a' }])
  assert.equal(titles.has('session-a'), false, 'a genuinely untitled session stays untitled')
  assert.equal(inspected, 0, 'fulfilled-without-title must not trigger the fallback')
})

test('an aborted signal never starts the persistence fallback', async () => {
  const controller = new AbortController()
  controller.abort()
  let inspected = 0
  const persistence = {
    inspect: async () => {
      inspected += 1
      return { events: [] }
    },
  }
  await assert.rejects(
    loadSessionTitleBatch(mixedQuery(['session-a']) as never, persistence as never, undefined, [{ id: 'session-a' }], controller.signal),
    /abort/i,
  )
  assert.equal(inspected, 0, 'the fallback must never start on an aborted signal')
})
