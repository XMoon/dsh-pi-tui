/**
 * The disposable SQLite projection of the Host accepted-input history search.
 *
 * Real `node:sqlite` databases under a test-owned private temp profile
 * directory prove the ONE index owner's contracts: private path/permissions,
 * fixed schema ownership, atomic per-Session commits, incremental checkpoints,
 * rebuilds, foreign/corrupt database handling, the three keyset scopes and the
 * exact-text row identity.
 *
 * @module @xmoon76/dsh-pi-tui/host-history-search-index.test
 */

import assert from 'node:assert/strict'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  HISTORY_SEARCH_SQLITE_APPLICATION_ID,
  HISTORY_SEARCH_SQLITE_USER_VERSION,
  HistorySearchIndex,
  HistorySearchIndexUnavailableError,
  contentSha256,
  sessionEventHash,
  sessionHeaderHash,
  type HistoryOccurrenceInput,
} from '../../src/app/host/features/history-search-index.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

function profileDir(t: Parameters<typeof testLifecycle>[0]): string {
  const life = testLifecycle(t)
  return life.tempDir('dsh-history-search-')
}

function occurrence(messageId: string, text: string, acceptedAt: number, cwd: string | null, firstEventSeq = 0): HistoryOccurrenceInput {
  return { messageId, firstEventSeq, acceptedAt, effectiveCwd: cwd, content: text, hasNonText: false }
}

function seed(
  index: HistorySearchIndex,
  sessionId: string,
  occurrences: readonly HistoryOccurrenceInput[],
  options: {
    readonly nextSeq?: number
    readonly inheritedCut?: number
    readonly headerCwd?: string | null
    readonly effectiveCwd?: string | null
    readonly sourceState?: 'persisted' | 'live'
    readonly lastEventHash?: string | null
  } = {},
): void {
  index.commitBatch({
    sessionId,
    headerHash: sessionHeaderHash({ id: sessionId }),
    inheritedCut: options.inheritedCut ?? 0,
    baseNextSeq: 0,
    nextSeq: options.nextSeq ?? 10,
    headerCwd: options.headerCwd ?? '/repo/a',
    effectiveCwd: options.effectiveCwd ?? options.headerCwd ?? '/repo/a',
    lastEventHash: options.lastEventHash ?? null,
    sourceState: options.sourceState ?? 'persisted',
    uncertainSourcesDelta: 0,
    occurrences,
  })
}

test('a fresh index owns a private 0700 directory, 0600 file and its fixed schema identity', (t) => {
  const dir = profileDir(t)
  const index = HistorySearchIndex.open({ profileDir: dir })
  try {
    const file = lstatSync(index.path)
    assert.equal(file.isFile(), true)
    assert.equal(file.mode & 0o077, 0, 'the index file must not be group/other-accessible')
    const parent = lstatSync(join(dir, '.dsh-pi-tui'))
    assert.equal(parent.mode & 0o077, 0, 'the private directory must be group/other-inaccessible')
    const db = new DatabaseSync(index.path)
    try {
      assert.equal((db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id,
        HISTORY_SEARCH_SQLITE_APPLICATION_ID)
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        HISTORY_SEARCH_SQLITE_USER_VERSION)
    } finally {
      db.close()
    }
  } finally {
    index.close()
  }
})

test('a foreign database at the derived path is refused and never rewritten', (t) => {
  const dir = profileDir(t)
  const historyDir = join(dir, '.dsh-pi-tui', 'history-search')
  mkdirSync(historyDir, { recursive: true, mode: 0o700 })
  chmodSync(join(dir, '.dsh-pi-tui'), 0o700)
  chmodSync(historyDir, 0o700)
  const dbPath = join(historyDir, 'v1.sqlite')
  const foreign = new DatabaseSync(dbPath)
  foreign.exec('CREATE TABLE someone_else (a TEXT)')
  foreign.close()
  chmodSync(dbPath, 0o600)
  const before = readFileSync(dbPath)
  assert.throws(
    () => HistorySearchIndex.open({ profileDir: dir }),
    (error: unknown) => error instanceof HistorySearchIndexUnavailableError,
  )
  assert.deepEqual(readFileSync(dbPath), before, 'a foreign database must stay byte-identical')
})

test('a corrupt own database is quarantined instead of deleted and a fresh index opens', (t) => {
  const dir = profileDir(t)
  const historyDir = join(dir, '.dsh-pi-tui', 'history-search')
  mkdirSync(historyDir, { recursive: true, mode: 0o700 })
  chmodSync(join(dir, '.dsh-pi-tui'), 0o700)
  chmodSync(historyDir, 0o700)
  const dbPath = join(historyDir, 'v1.sqlite')
  writeFileSync(dbPath, 'this is not a sqlite database', { mode: 0o600 })
  const index = HistorySearchIndex.open({ profileDir: dir })
  try {
    index.close()
    const names = readdirSync(historyDir)
    assert.ok(names.includes('v1.sqlite'), 'a fresh index file must exist')
    assert.ok(names.some(name => name.startsWith('v1.sqlite.quarantine-')),
      `the corrupt bytes must be preserved under a quarantined name: ${names.join(', ')}`)
    const quarantined = names.find(name => name.startsWith('v1.sqlite.quarantine-'))
    assert.equal(readFileSync(join(historyDir, quarantined!)).toString('utf8'), 'this is not a sqlite database')
  } finally {
    index.close()
  }
})

test('a symlinked index file or a non-private directory refuses the derived index', (t) => {
  const dir = profileDir(t)
  const target = join(dir, 'elsewhere.sqlite')
  writeFileSync(target, '', { mode: 0o600 })
  const historyDir = join(dir, '.dsh-pi-tui', 'history-search')
  mkdirSync(historyDir, { recursive: true, mode: 0o700 })
  chmodSync(join(dir, '.dsh-pi-tui'), 0o700)
  chmodSync(historyDir, 0o700)
  symlinkSync(target, join(historyDir, 'v1.sqlite'))
  assert.throws(
    () => HistorySearchIndex.open({ profileDir: dir }),
    (error: unknown) => error instanceof HistorySearchIndexUnavailableError,
  )

  const second = profileDir(t)
  mkdirSync(join(second, '.dsh-pi-tui'), { recursive: true, mode: 0o755 })
  chmodSync(join(second, '.dsh-pi-tui'), 0o755)
  assert.throws(
    () => HistorySearchIndex.open({ profileDir: second }),
    (error: unknown) => error instanceof HistorySearchIndexUnavailableError,
  )
})

test('the checkpoint + occurrence rows commit atomically and refuse a moved base seq', (t) => {
  const index = HistorySearchIndex.open({ profileDir: profileDir(t) })
  try {
    seed(index, 's1', [occurrence('m1', 'first prompt', 1000, '/repo/a')], { nextSeq: 3 })
    const checkpoint = index.checkpointOf('s1')
    assert.equal(checkpoint?.nextSeq, 3)
    assert.equal(index.occurrenceCount(), 1)

    index.commitBatch({
      sessionId: 's1',
      headerHash: sessionHeaderHash({ id: 's1' }),
      inheritedCut: 0,
      baseNextSeq: 3,
      nextSeq: 7,
      headerCwd: '/repo/a',
      effectiveCwd: '/repo/a',
      lastEventHash: 'tail-hash',
      sourceState: 'persisted',
      uncertainSourcesDelta: 2,
      occurrences: [occurrence('m2', 'second prompt', 2000, '/repo/a', 5)],
    })
    assert.equal(index.checkpointOf('s1')?.nextSeq, 7)
    assert.equal(index.checkpointOf('s1')?.uncertainSources, 2)
    assert.equal(index.checkpointOf('s1')?.lastEventHash, 'tail-hash')

    assert.throws(() => index.commitBatch({
      sessionId: 's1',
      headerHash: sessionHeaderHash({ id: 's1' }),
      inheritedCut: 0,
      baseNextSeq: 3,
      nextSeq: 8,
      headerCwd: '/repo/a',
      effectiveCwd: '/repo/a',
      lastEventHash: null,
      sourceState: 'persisted',
      uncertainSourcesDelta: 0,
      occurrences: [occurrence('m3', 'stale batch', 3000, '/repo/a', 9)],
    }), /checkpoint moved/u)
    assert.equal(index.checkpointOf('s1')?.nextSeq, 7, 'the refused batch must not move the checkpoint')
    assert.equal(index.occurrenceCount(), 2, 'the refused batch must not insert rows')
  } finally {
    index.close()
  }
})

test('a first-wins identity ignores a later same-message insert and a reset rebuilds it', (t) => {
  const index = HistorySearchIndex.open({ profileDir: profileDir(t) })
  try {
    seed(index, 's1', [occurrence('m1', 'accepted body', 1000, '/repo/a')])
    index.commitBatch({
      sessionId: 's1',
      headerHash: sessionHeaderHash({ id: 's1' }),
      inheritedCut: 0,
      baseNextSeq: 10,
      nextSeq: 11,
      headerCwd: '/repo/a',
      effectiveCwd: '/repo/a',
      lastEventHash: null,
      sourceState: 'persisted',
      uncertainSourcesDelta: 0,
      occurrences: [occurrence('m1', 'edited body', 9999, '/repo/b', 10)],
    })
    const stored = index.occurrence('s1', 'm1')
    assert.equal(stored?.content, 'accepted body')
    assert.equal(stored?.acceptedAt, 1000)
    assert.equal(stored?.effectiveCwd, '/repo/a')

    index.resetSession('s1')
    assert.equal(index.checkpointOf('s1'), undefined)
    assert.equal(index.occurrenceCount(), 0)
  } finally {
    index.close()
  }
})

test('deleting derived Sessions keeps only the authoritative ids', (t) => {
  const index = HistorySearchIndex.open({ profileDir: profileDir(t) })
  try {
    seed(index, 's1', [occurrence('m1', 'one', 1000, '/repo/a')])
    seed(index, 's2', [occurrence('m2', 'two', 2000, '/repo/a')])
    seed(index, 's3', [occurrence('m3', 'three', 3000, '/repo/a')])
    const removed = index.deleteSessionsExcept(new Set(['s1', 's3']))
    assert.deepEqual(removed, ['s2'])
    assert.deepEqual(index.listSessions().map(row => row.sessionId), ['s1', 's3'])
    assert.equal(index.occurrence('s2', 'm2'), undefined)
  } finally {
    index.close()
  }
})

test('the Session header hash and tail event hash identity are stable canonical facts', () => {
  assert.equal(
    sessionHeaderHash({ id: 's1', cwd: '/repo/a', isSeeded: false }),
    sessionHeaderHash({ isSeeded: false, cwd: '/repo/a', id: 's1' }),
    'the header hash must ignore object key order',
  )
  assert.notEqual(
    sessionHeaderHash({ id: 's1', cwd: '/repo/a' }),
    sessionHeaderHash({ id: 's1', cwd: '/repo/b' }),
  )
  const event = { seq: 3, type: 'user/message', time: 1000, data: { id: 'm1' } }
  assert.equal(sessionEventHash(event), sessionEventHash({ data: { id: 'm1' }, time: 1000, type: 'user/message', seq: 3 }))
  assert.equal(contentSha256('hello'), contentSha256('hello'))
  assert.notEqual(contentSha256('hello'), contentSha256('Hello'))
})

test('the three scopes return literal substring matches in the fixed order', (t) => {
  const index = HistorySearchIndex.open({ profileDir: profileDir(t) })
  try {
    seed(index, 's-a', [
      occurrence('m1', 'Hello 中文世界 😀 100%_quote', 3000, '/repo/a', 5),
      occurrence('m2', 'HELLO second', 1000, '/repo/a', 2),
    ])
    seed(index, 's-b', [occurrence('m3', 'other hello', 3000, '/repo/b', 7)])
    index.commitBatch({
      sessionId: 's-null',
      headerHash: sessionHeaderHash({ id: 's-null' }),
      inheritedCut: 0,
      baseNextSeq: 0,
      nextSeq: 2,
      headerCwd: null,
      effectiveCwd: null,
      lastEventHash: null,
      sourceState: 'persisted',
      uncertainSourcesDelta: 0,
      occurrences: [occurrence('m4', 'no directory hello', 2000, null, 1)],
    })

    const all = index.search({ scope: 'all', query: 'hello', limit: 25 })
    assert.deepEqual(all.rows.map(row => row.messageId), ['m1', 'm3', 'm4', 'm2'],
      'acceptedAt DESC, then sessionId ASC, then firstEventSeq DESC')
    assert.equal(all.hasMore, false)

    const cjk = index.search({ scope: 'all', query: '中文世界', limit: 25 })
    assert.deepEqual(cjk.rows.map(row => row.messageId), ['m1'])
    const emoji = index.search({ scope: 'all', query: '😀', limit: 25 })
    assert.deepEqual(emoji.rows.map(row => row.messageId), ['m1'])
    const percent = index.search({ scope: 'all', query: '100%_', limit: 25 })
    assert.deepEqual(percent.rows.map(row => row.messageId), ['m1'])
    const whole = index.search({ scope: 'all', query: '100%_quote', limit: 25 })
    assert.deepEqual(whole.rows.map(row => row.messageId), ['m1'])
    const noMatch = index.search({ scope: 'all', query: '100x_', limit: 25 })
    assert.deepEqual(noMatch.rows, [])

    const sessionPage = index.search({ scope: 'session', sessionId: 's-a', query: '', limit: 25 })
    assert.deepEqual(sessionPage.rows.map(row => row.messageId), ['m1', 'm2'])

    const directoryPage = index.search({ scope: 'directory', cwd: '/repo/a', query: 'hello', limit: 25 })
    assert.deepEqual(directoryPage.rows.map(row => row.messageId), ['m1', 'm2'])
    const nullDirectory = index.search({ scope: 'directory', cwd: '/repo/a', query: 'directory', limit: 25 })
    assert.deepEqual(nullDirectory.rows, [], 'a NULL-directory occurrence never matches a concrete directory scope')

    // One-code-unit and two-code-unit queries stay literal substring scans.
    assert.deepEqual(index.search({ scope: 'all', query: 'h', limit: 25 }).rows.length, 4)
    assert.deepEqual(index.search({ scope: 'all', query: 'he', limit: 25 }).rows.length, 4)
  } finally {
    index.close()
  }
})

test('keyset pagination returns every row exactly once with a bounded page size', (t) => {
  const index = HistorySearchIndex.open({ profileDir: profileDir(t) })
  try {
    seed(index, 's1', [
      occurrence('m1', 'page text 1', 5000, '/repo/a', 1),
      occurrence('m2', 'page text 2', 4000, '/repo/a', 2),
      occurrence('m3', 'page text 3', 3000, '/repo/a', 3),
      occurrence('m4', 'page text 4', 2000, '/repo/a', 4),
      occurrence('m5', 'page text 5', 1000, '/repo/a', 5),
    ])
    const seen: string[] = []
    let after: { acceptedAt: number; sessionId: string; firstEventSeq: number; messageId: string } | undefined
    for (let page = 0; page < 10; page += 1) {
      const result = index.search({ scope: 'all', query: 'page text', limit: 2, ...(after === undefined ? {} : { after }) })
      assert.ok(result.rows.length <= 2)
      seen.push(...result.rows.map(row => row.messageId))
      if (!result.hasMore) break
      const last = result.rows.at(-1)!
      after = {
        acceptedAt: last.acceptedAt,
        sessionId: last.sessionId,
        firstEventSeq: last.firstEventSeq,
        messageId: last.messageId,
      }
    }
    assert.deepEqual(seen, ['m1', 'm2', 'm3', 'm4', 'm5'])

    const sessionAfter = index.search({
      scope: 'session',
      sessionId: 's1',
      query: '',
      limit: 2,
      after: { acceptedAt: 3000, sessionId: 's1', firstEventSeq: 3, messageId: 'm3' },
    })
    assert.deepEqual(sessionAfter.rows.map(row => row.messageId), ['m4', 'm5'])
  } finally {
    index.close()
  }
})

test('one stored occurrence keeps the exact content identity used by readText', (t) => {
  const index = HistorySearchIndex.open({ profileDir: profileDir(t) })
  try {
    const content = 'exact original text with 中文 and 😀'
    seed(index, 's1', [occurrence('m1', content, 1000, '/repo/a')])
    const row = index.occurrence('s1', 'm1')
    assert.equal(row?.content, content)
    assert.equal(row?.contentSha256, contentSha256(content))
    assert.equal(index.occurrence('s1', 'missing'), undefined)
  } finally {
    index.close()
  }
})

test('an incremental checkpoint survives close/reopen and a renamed-away file is not trusted', (t) => {
  const dir = profileDir(t)
  const first = HistorySearchIndex.open({ profileDir: dir })
  seed(first, 's1', [occurrence('m1', 'persisted prompt', 1000, '/repo/a')], { nextSeq: 4 })
  const before = first.checkpointOf('s1')
  first.close()

  const reopened = HistorySearchIndex.open({ profileDir: dir })
  try {
    assert.deepEqual(reopened.checkpointOf('s1'), before)
    reopened.close()
    // A whole-file replacement is a foreign/own-corrupt decision at open time;
    // the derived rows must never be trusted across an unreconciled replacement.
    renameSync(rejoinedDbPath(dir), join(dir, 'moved-away.sqlite'))
    assert.equal(existsSync(rejoinedDbPath(dir)), false)
    const fresh = HistorySearchIndex.open({ profileDir: dir })
    try {
      assert.equal(fresh.checkpointOf('s1'), undefined)
    } finally {
      fresh.close()
    }
  } finally {
    reopened.close()
  }
})

function rejoinedDbPath(profileDirPath: string): string {
  return join(profileDirPath, '.dsh-pi-tui', 'history-search', 'v1.sqlite')
}