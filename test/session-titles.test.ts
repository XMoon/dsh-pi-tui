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
import {
  TITLE_BATCH_SIZE,
  TITLE_FIRST_BATCH,
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
  assert.equal(TITLE_FIRST_BATCH, 20, 'the first batch must fill the visible picker window')
  assert.ok(Number.isInteger(TITLE_BATCH_SIZE) && TITLE_BATCH_SIZE > 0 && TITLE_BATCH_SIZE >= TITLE_FIRST_BATCH)
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
