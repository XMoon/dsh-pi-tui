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
  HISTORY_SEARCH_SOURCE_PROOF_CONTRACT_VERSION,
  HISTORY_SEARCH_SQLITE_APPLICATION_ID,
  HISTORY_SEARCH_SQLITE_USER_VERSION,
  HistorySearchIndex,
  HistorySearchIndexUnavailableError,
  contentSha256,
  historyCheckpointHash,
  sessionEventHash,
  sessionHeaderHash,
  type HistoryOccurrenceInput,
  type HistorySessionCheckpointRow,
  type HistorySourceProofBasis,
} from '../../src/app/host/features/history-search-index.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

function profileDir(t: Parameters<typeof testLifecycle>[0]): string {
  const life = testLifecycle(t)
  return life.tempDir('dsh-history-search-')
}

function occurrence(
  messageId: string,
  text: string,
  acceptedAt: number,
  cwd: string | null,
  firstEventSeq = 0,
  rpcId?: string,
): HistoryOccurrenceInput {
  return {
    messageId,
    ...(rpcId === undefined ? {} : { rpcId }),
    firstEventSeq,
    acceptedAt,
    effectiveCwd: cwd,
    content: text,
    hasNonText: false,
  }
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
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, HISTORY_SEARCH_SQLITE_USER_VERSION)
      const columns = (db.prepare('PRAGMA table_info(history_occurrences)').all() as Array<{ name: string }>)
        .map(column => column.name)
      assert.ok(columns.includes('preview'), 'the active v3 schema owns the bounded preview column')
      assert.ok(columns.includes('rpc_id'), 'the active v3 schema owns the optional official request correlation')
      assert.ok(columns.includes('content_length'), 'the active v3 schema owns the exact UTF-16 length column')
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
  const dbPath = join(historyDir, 'v3.sqlite')
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
  const dbPath = join(historyDir, 'v3.sqlite')
  writeFileSync(dbPath, 'this is not a sqlite database', { mode: 0o600 })
  const index = HistorySearchIndex.open({ profileDir: dir })
  try {
    index.close()
    const names = readdirSync(historyDir)
    assert.ok(names.includes('v3.sqlite'), 'a fresh index file must exist')
    assert.ok(names.some(name => name.startsWith('v3.sqlite.quarantine-')),
      `the corrupt bytes must be preserved under a quarantined name: ${names.join(', ')}`)
    const quarantined = names.find(name => name.startsWith('v3.sqlite.quarantine-'))
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
  symlinkSync(target, join(historyDir, 'v3.sqlite'))
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

test('deleting one derived Session removes its occurrences without touching other Sessions', (t) => {
  const index = HistorySearchIndex.open({ profileDir: profileDir(t) })
  try {
    seed(index, 's1', [occurrence('m1', 'one', 1000, '/repo/a')])
    seed(index, 's2', [occurrence('m2', 'two', 2000, '/repo/a')])
    seed(index, 's3', [occurrence('m3', 'three', 3000, '/repo/a')])
    index.deleteSession('s2')
    assert.deepEqual(index.listSessions().map(row => row.sessionId), ['s1', 's3'])
    assert.equal(index.checkpointOf('s2'), undefined)
    assert.equal(index.occurrence('s2', 'm2'), undefined)
    assert.equal(index.occurrence('s1', 'm1')?.content, 'one', 'an exact-ID delete must not cascade into another Session')
    assert.equal(index.occurrence('s3', 'm3')?.content, 'three', 'an exact-ID delete must not cascade into another Session')
    assert.equal(index.occurrenceCount(), 2)
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
  return join(profileDirPath, '.dsh-pi-tui', 'history-search', 'v3.sqlite')
}
test('an existing empty SQLite database is refused without being rewritten', (t) => {
  const dir = profileDir(t)
  const historyDir = join(dir, '.dsh-pi-tui', 'history-search')
  mkdirSync(historyDir, { recursive: true, mode: 0o700 })
  chmodSync(join(dir, '.dsh-pi-tui'), 0o700)
  chmodSync(historyDir, 0o700)
  const dbPath = join(historyDir, 'v3.sqlite')
  const empty = new DatabaseSync(dbPath)
  empty.close()
  chmodSync(dbPath, 0o600)
  const before = readFileSync(dbPath)
  assert.throws(
    () => HistorySearchIndex.open({ profileDir: dir }),
    (error: unknown) => error instanceof HistorySearchIndexUnavailableError,
  )
  assert.deepEqual(readFileSync(dbPath), before,
    'an existing database without the application identity must stay byte-identical')
})

test('unsafe WAL or SHM sidecars refuse the derived index', (t) => {
  const dir = profileDir(t)
  const first = HistorySearchIndex.open({ profileDir: dir })
  first.close()
  const historyDir = join(dir, '.dsh-pi-tui', 'history-search')
  const dbPath = join(historyDir, 'v3.sqlite')
  const target = join(dir, 'foreign-sidecar')
  writeFileSync(target, '', { mode: 0o600 })
  symlinkSync(target, `${dbPath}-wal`)
  assert.throws(
    () => HistorySearchIndex.open({ profileDir: dir }),
    (error: unknown) => error instanceof HistorySearchIndexUnavailableError,
  )

  const second = profileDir(t)
  const secondIndex = HistorySearchIndex.open({ profileDir: second })
  secondIndex.close()
  const secondDir = join(second, '.dsh-pi-tui', 'history-search')
  writeFileSync(join(secondDir, 'v3.sqlite-shm'), '', { mode: 0o644 })
  assert.throws(
    () => HistorySearchIndex.open({ profileDir: second }),
    (error: unknown) => error instanceof HistorySearchIndexUnavailableError,
  )
})

test('a fresh index materializes only private sidecars and refuses dangling symlinks', (t) => {
  const dir = profileDir(t)
  const first = HistorySearchIndex.open({ profileDir: dir })
  try {
    seed(first, 's1', [occurrence('m1', 'private sidecars', 1000, '/repo/a')])
    const historyDir = join(dir, '.dsh-pi-tui', 'history-search')
    for (const suffix of ['-wal', '-shm'] as const) {
      const path = join(historyDir, `v3.sqlite${suffix}`)
      if (!existsSync(path)) continue
      assert.equal(lstatSync(path).mode & 0o077, 0,
        `the materialized ${suffix} sidecar must stay private`)
    }
  } finally {
    first.close()
  }

  // A DANGLING symlink at the main path or a sidecar path is an existing entry:
  // `existsSync` would follow it and miss the refusal.
  for (const name of ['v3.sqlite', 'v3.sqlite-wal'] as const) {
    const second = profileDir(t)
    const historyDir = join(second, '.dsh-pi-tui', 'history-search')
    mkdirSync(historyDir, { recursive: true, mode: 0o700 })
    chmodSync(join(second, '.dsh-pi-tui'), 0o700)
    chmodSync(historyDir, 0o700)
    symlinkSync(join(historyDir, 'missing-target'), join(historyDir, name))
    assert.throws(
      () => HistorySearchIndex.open({ profileDir: second }),
      (error: unknown) => error instanceof HistorySearchIndexUnavailableError,
      `a dangling ${name} symlink must refuse the index`,
    )
  }
})

test('search returns only the stored bounded preview and never a full body', (t) => {
  const index = HistorySearchIndex.open({ profileDir: profileDir(t) })
  try {
    const big = `${'a'.repeat(20_000)}😀tail`
    seed(index, 's-big', [
      occurrence('m0', big, 5000, '/repo/big', 0),
      occurrence('m1', `${big} one`, 4000, '/repo/big', 1),
      occurrence('m2', `${big} two`, 3000, '/repo/big', 2),
    ])
    const page = index.search({ scope: 'all', query: '', limit: 25 })
    assert.equal(page.rows.length, 3)
    for (const row of page.rows) {
      assert.equal(Object.hasOwn(row, 'content'), false,
        'a search row must not carry the full body')
      assert.ok(row.preview.length <= 4096, `preview length ${String(row.preview.length)} exceeds the bound`)
      assert.equal(row.contentLength >= 20_000, true)
    }
    // The exact body stays available only through the readText occurrence path.
    const full = index.occurrence('s-big', 'm0')
    assert.equal(full?.content, big)
    assert.equal(full?.preview.length, 4096)
    assert.equal(full?.contentLength, big.length)
  } finally {
    index.close()
  }
})

test('session recall reads one exact Session in Host order with the stored identity facts', (t) => {
  const index = HistorySearchIndex.open({ profileDir: profileDir(t) })
  try {
    const composite = {
      messageId: 'm-composite',
      firstEventSeq: 5,
      acceptedAt: 2500,
      effectiveCwd: '/repo/a',
      content: 'attached only',
      hasNonText: true,
    } as const
    seed(index, 's-recall', [
      occurrence('m-newest', 'newest prompt', 5000, '/repo/a', 0, 'rpc-newest'),
      occurrence('m-blank', '   ', 4500, '/repo/a', 1),
      occurrence('m-shell', '!ls -la', 4000, '/repo/a', 2),
      occurrence('m-unicode', '部署 ✓ deploy', 3000, '/repo/b', 3),
      occurrence('m-long-ascii', 'x'.repeat(8193), 2000, '/repo/a', 4),
      occurrence('m-preover', 'y'.repeat(65_537), 1500, '/repo/a', 5),
      occurrence('m-rpc', 'correlated prompt', 1000, '/repo/a', 6, 'rpc-1'),
      composite,
    ])
    seed(index, 's-other', [occurrence('m-other', 'other session newest', 6000, '/repo/a', 0)])

    const rows = index.sessionRecallRows('s-recall', 100, 64 * 1024)
    assert.deepEqual(rows.map(row => row.messageId), [
      'm-newest', 'm-blank', 'm-shell', 'm-unicode', 'm-long-ascii', 'm-rpc',
    ], 'exact session + non-text/absolute-preover excluded BEFORE the limit; long ASCII is admitted')
    assert.equal(rows[0]?.rpcId, 'rpc-newest')
    assert.equal('rpcId' in (rows[1] as object), false, 'optional correlation is absent, not null/empty')
    assert.equal(rows[3]?.effectiveCwd, '/repo/b')
    assert.equal(index.sessionRecallRows('s-recall', 2, 64 * 1024).length, 2, 'the candidate batch cap is independent of the cap')
    assert.equal(rows.find(row => row.messageId === 'm-long-ascii')?.content.length, 8193,
      'a long ASCII row is admitted whole, never truncated by the old 8192 prefilter')
    assert.deepEqual(index.sessionRecallRows('missing', 100, 64 * 1024), [], 'an absent target returns no rows')
    assert.equal(index.occurrence('s-recall', 'm-rpc')?.rpcId, 'rpc-1')
  } finally {
    index.close()
  }
})

/** One synthetic durable proof basis; the opaque revision is compared literally. */
function sourceBasis(
  scopeKey = 'a'.repeat(64),
  revision = 'rev-1',
  sourcePath = '/root/sessions/s1.jsonl',
): HistorySourceProofBasis {
  return { scopeKey, sourcePath, sourceRevision: revision }
}

function historyPaths(dir: string): { historyDir: string; dbPath: string; wal: string; shm: string } {
  const historyDir = join(dir, '.dsh-pi-tui', 'history-search')
  const dbPath = join(historyDir, 'v3.sqlite')
  return { historyDir, dbPath, wal: `${dbPath}-wal`, shm: `${dbPath}-shm` }
}

/** Seed one clean persisted checkpoint with a consistent tail and mint its proof. */
function seedProof(
  index: HistorySearchIndex,
  sessionId: string,
  basis: HistorySourceProofBasis = sourceBasis(),
): HistorySessionCheckpointRow {
  seed(index, sessionId, [occurrence(`${sessionId}-m`, `body of ${sessionId}`, 1000, '/repo/a')], {
    nextSeq: 10,
    lastEventHash: `tail-${sessionId}`,
  })
  const checkpoint = index.checkpointOf(sessionId)
  assert.ok(checkpoint !== undefined)
  index.commitSourceProof(checkpoint, basis)
  return checkpoint
}

test('v3 owns the exact source-proof schema and never touches the legacy v1/v2 file sets', (t) => {
  const dir = profileDir(t)
  const { historyDir, dbPath } = historyPaths(dir)
  mkdirSync(historyDir, { recursive: true, mode: 0o700 })
  chmodSync(join(dir, '.dsh-pi-tui'), 0o700)
  chmodSync(historyDir, 0o700)
  const legacyFiles = new Map<string, { readonly bytes: Buffer; readonly ino: number; readonly mode: number; readonly mtimeMs: number }>()
  for (const [fileName, contents] of [
    ['v1.sqlite', 'legacy-v1-main'],
    ['v1.sqlite-wal', 'legacy-v1-wal'],
    ['v1.sqlite-shm', 'legacy-v1-shm'],
    ['v2.sqlite', 'dormant-v2-main'],
    ['v2.sqlite-wal', 'dormant-v2-wal'],
    ['v2.sqlite-shm', 'dormant-v2-shm'],
  ] as const) {
    const path = join(historyDir, fileName)
    writeFileSync(path, contents, { mode: 0o600 })
    const stat = lstatSync(path)
    legacyFiles.set(path, { bytes: readFileSync(path), ino: stat.ino, mode: stat.mode, mtimeMs: stat.mtimeMs })
  }

  const index = HistorySearchIndex.open({ profileDir: dir })
  try {
    assert.equal(index.path, dbPath)
    seedProof(index, 's-proof')
    const db = new DatabaseSync(dbPath)
    try {
      assert.equal((db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id,
        HISTORY_SEARCH_SQLITE_APPLICATION_ID)
      assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, HISTORY_SEARCH_SQLITE_USER_VERSION)
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>).map(row => row.name)
      assert.deepEqual(tables, ['history_occurrences', 'history_sessions', 'history_source_proofs'])
      const columns = (db.prepare('PRAGMA table_info(history_source_proofs)').all() as Array<{ name: string }>)
        .map(row => row.name)
      assert.deepEqual(columns, ['session_id', 'contract_version', 'scope_key', 'source_path', 'source_revision', 'checkpoint_hash'])
      const foreignKeys = db.prepare('PRAGMA foreign_key_list(history_source_proofs)').all() as Array<{
        table: string
        from: string
        to: string
        on_delete: string
      }>
      assert.deepEqual(foreignKeys.map(row => [row.table, row.from, row.to, row.on_delete]),
        [['history_sessions', 'session_id', 'session_id', 'CASCADE']])
    } finally {
      db.close()
    }
    assert.equal(index.sourceProofOf('s-proof')?.contractVersion, HISTORY_SEARCH_SOURCE_PROOF_CONTRACT_VERSION)
    assert.equal(index.sourceProofOf('s-proof')?.sourcePath, '/root/sessions/s1.jsonl')
  } finally {
    index.close()
  }

  for (const [path, before] of legacyFiles) {
    const after = lstatSync(path)
    assert.deepEqual(readFileSync(path), before.bytes, `the dormant ${path} bytes must stay identical`)
    assert.equal(after.ino, before.ino, `the dormant ${path} inode must never be replaced`)
    assert.equal(after.mode, before.mode)
    assert.equal(after.mtimeMs, before.mtimeMs)
  }
  assert.equal(existsSync(join(historyDir, 'v1.sqlite.quarantine-')), false)
  assert.equal(existsSync(join(historyDir, 'v2.sqlite.quarantine-')), false)
})

test('a legacy schema version at the active v3 path is refused untouched', (t) => {
  const dir = profileDir(t)
  const { historyDir, dbPath } = historyPaths(dir)
  mkdirSync(historyDir, { recursive: true, mode: 0o700 })
  chmodSync(join(dir, '.dsh-pi-tui'), 0o700)
  chmodSync(historyDir, 0o700)
  const legacy = new DatabaseSync(dbPath)
  legacy.exec('CREATE TABLE history_sessions (session_id TEXT PRIMARY KEY)')
  legacy.exec(`PRAGMA application_id = ${String(HISTORY_SEARCH_SQLITE_APPLICATION_ID)}`)
  legacy.exec('PRAGMA user_version = 2')
  legacy.close()
  chmodSync(dbPath, 0o600)
  const before = readFileSync(dbPath)
  assert.throws(
    () => HistorySearchIndex.open({ profileDir: dir }),
    (error: unknown) => error instanceof HistorySearchIndexUnavailableError,
  )
  assert.deepEqual(readFileSync(dbPath), before, 'the legacy-schema file must not be migrated or rewritten')
})

test('every checkpoint mutation revokes exactly its own source proof atomically', (t) => {
  const index = HistorySearchIndex.open({ profileDir: profileDir(t) })
  try {
    const reset = (): void => {
      index.resetSession('s-a')
      index.resetSession('s-b')
    }
    const seedBoth = (): void => {
      seedProof(index, 's-a')
      seedProof(index, 's-b', sourceBasis('b'.repeat(64), 'rev-b', '/root/sessions/s2.jsonl'))
    }

    // A proof commit is metadata-only for the content generation.
    seedBoth()
    const revision = index.revision
    index.commitSourceProof(index.checkpointOf('s-a')!, sourceBasis())
    assert.equal(index.revision, revision)

    // Same-value marker rewrites are conservatively revoked too.
    index.markSession({ sessionId: 's-a', dirty: false })
    assert.equal(index.sourceProofOf('s-a'), undefined)
    assert.ok(index.sourceProofOf('s-b') !== undefined)
    assert.equal(index.sourceProofRevocations, 1)

    reset()
    seedBoth()
    const beforeEmptyMarker = index.sourceProofRevocations
    index.markSession({ sessionId: 's-a' })
    assert.ok(index.sourceProofOf('s-a') !== undefined, 'an empty marker is no mutation')
    assert.equal(index.sourceProofRevocations, beforeEmptyMarker, 'an empty marker revokes nothing')

    const cases: Array<{ readonly label: string; readonly run: () => void }> = [
      {
        label: 'an incremental batch',
        run: () => index.commitBatch({
          sessionId: 's-a',
          headerHash: sessionHeaderHash({ id: 's-a' }),
          inheritedCut: 0,
          baseNextSeq: 10,
          nextSeq: 11,
          headerCwd: '/repo/a',
          effectiveCwd: '/repo/a',
          lastEventHash: 'next-tail',
          sourceState: 'persisted',
          uncertainSourcesDelta: 0,
          occurrences: [],
        }),
      },
      {
        label: 'a zero-event batch',
        run: () => index.commitBatch({
          sessionId: 's-a',
          headerHash: sessionHeaderHash({ id: 's-a' }),
          inheritedCut: 0,
          baseNextSeq: 10,
          nextSeq: 10,
          headerCwd: '/repo/a',
          effectiveCwd: '/repo/a',
          lastEventHash: 'tail-s-a',
          sourceState: 'persisted',
          uncertainSourcesDelta: 0,
          occurrences: [],
        }),
      },
      { label: 'a dirty marker', run: () => index.markSession({ sessionId: 's-a', dirty: true }) },
      { label: 'a source-state marker', run: () => index.markSession({ sessionId: 's-a', sourceState: 'live' }) },
      { label: 'an uncertain marker', run: () => index.markSession({ sessionId: 's-a', uncertainSources: 1 }) },
      { label: 'an exact reset', run: () => index.resetSession('s-a') },
    ]
    for (const { label, run } of cases) {
      reset()
      seedBoth()
      const beforeMutation: number = index.sourceProofRevocations
      run()
      assert.equal(index.sourceProofOf('s-a'), undefined, `${label} must revoke the session proof`)
      assert.ok(index.sourceProofOf('s-b') !== undefined, `${label} must not revoke another session`)
      assert.equal(index.sourceProofRevocations, beforeMutation + 1, `${label} must count its committed revocation`)
    }

    // An exact delete cascades the proof with the session row.
    reset()
    seedBoth()
    const revocations = index.sourceProofRevocations
    index.deleteSession('s-a')
    assert.equal(index.sourceProofOf('s-a'), undefined)
    assert.ok(index.sourceProofOf('s-b') !== undefined)
    assert.equal(index.sourceProofRevocations, revocations + 1)

    // A refused batch rolls the revocation back with the old rows.
    reset()
    seedBoth()
    const beforeRollback = index.sourceProofRevocations
    const checkpoint = index.checkpointOf('s-a')
    assert.ok(checkpoint !== undefined)
    assert.throws(() => index.commitBatch({
      sessionId: 's-a',
      headerHash: sessionHeaderHash({ id: 's-a' }),
      inheritedCut: 0,
      baseNextSeq: 9,
      nextSeq: 11,
      headerCwd: '/repo/a',
      effectiveCwd: '/repo/a',
      lastEventHash: 'next-tail',
      sourceState: 'persisted',
      uncertainSourcesDelta: 0,
      occurrences: [],
    }), /checkpoint moved/u)
    assert.deepEqual(index.sourceProofOf('s-a'), {
      sessionId: 's-a',
      contractVersion: HISTORY_SEARCH_SOURCE_PROOF_CONTRACT_VERSION,
      scopeKey: 'a'.repeat(64),
      sourcePath: '/root/sessions/s1.jsonl',
      sourceRevision: 'rev-1',
      checkpointHash: historyCheckpointHash(checkpoint),
    }, 'a rolled-back batch must restore the previous proof')
    assert.equal(index.sourceProofRevocations, beforeRollback)
  } finally {
    index.close()
  }
})

test('a proof requires the exact clean persisted checkpoint and exact contract version', (t) => {
  const index = HistorySearchIndex.open({ profileDir: profileDir(t) })
  try {
    seedProof(index, 's-a')
    const checkpoint = index.checkpointOf('s-a')!
    for (const [label, mutated] of [
      ['header cwd', { ...checkpoint, headerCwd: '/repo/other' }],
      ['inherited cut', { ...checkpoint, inheritedCut: 1 }],
      ['next seq', { ...checkpoint, nextSeq: checkpoint.nextSeq + 1 }],
      ['effective cwd', { ...checkpoint, effectiveCwd: '/repo/other' }],
      ['tail hash', { ...checkpoint, lastEventHash: 'other-tail' }],
      ['header hash', { ...checkpoint, headerHash: 'other-header' }],
      ['source state', { ...checkpoint, sourceState: 'live' as const }],
      ['uncertain count', { ...checkpoint, uncertainSources: 1 }],
      ['dirty flag', { ...checkpoint, dirty: true }],
    ] as const) {
      assert.notEqual(historyCheckpointHash(mutated), historyCheckpointHash(checkpoint), `${label} must change the digest`)
      assert.throws(() => index.commitSourceProof(mutated, sourceBasis()), Error, `${label} mismatch must refuse the mint`)
    }
    assert.ok(index.sourceProofOf('s-a') !== undefined, 'the refused mints must leave the original proof untouched')

    // A genuinely empty terminal source carries a valid zero checkpoint.
    seed(index, 's-empty', [], { nextSeq: 0, lastEventHash: null, sourceState: 'persisted' })
    const empty = index.checkpointOf('s-empty')!
    index.commitSourceProof(empty, sourceBasis('c'.repeat(64), 'rev-empty', '/root/sessions/empty.jsonl'))
    assert.equal(index.sourceProofOf('s-empty')?.checkpointHash, historyCheckpointHash(empty))

    // A dirty or uncertain actual checkpoint refuses the mint even when the
    // caller's expected row claims it is clean.
    seed(index, 's-dirty', [], { nextSeq: 0, lastEventHash: null })
    const clean = index.checkpointOf('s-dirty')!
    index.markSession({ sessionId: 's-dirty', dirty: true })
    const dirty = index.checkpointOf('s-dirty')!
    assert.throws(() => index.commitSourceProof(dirty, sourceBasis()), Error)
    assert.throws(() => index.commitSourceProof(clean, sourceBasis()), Error)
    assert.equal(index.sourceProofOf('s-dirty'), undefined)
  } finally {
    index.close()
  }
})

test('proof-only transactions fail closed on unsafe or unmaterialized sidecars', (t) => {
  const dir = profileDir(t)
  const index = HistorySearchIndex.open({ profileDir: dir })
  const { wal, dbPath } = historyPaths(dir)
  try {
    seedProof(index, 's-a')
    index.resetSession('s-a')
    seed(index, 's-a', [occurrence('m1', 'body', 1000, '/repo/a')], { nextSeq: 10, lastEventHash: 'tail' })
    const checkpoint = index.checkpointOf('s-a')!
    assert.ok(existsSync(wal), 'the WAL is materialized by the previous write')

    // Pre-transaction safety check: an unsafe sidecar refuses the proof.
    chmodSync(wal, 0o644)
    assert.throws(() => index.commitSourceProof(checkpoint, sourceBasis()), /not private/u)
    assert.equal(index.sourceProofOf('s-a'), undefined)
    chmodSync(wal, 0o600)
    index.commitSourceProof(checkpoint, sourceBasis())
    assert.ok(index.sourceProofOf('s-a') !== undefined)

    // A successful proof commit is durable: closing and reopening the index
    // reads the SAME row (there is no fallible post-COMMIT validation window).
    index.close()
    const reopened = HistorySearchIndex.open({ profileDir: dir })
    try {
      assert.equal(reopened.sourceProofOf('s-a')?.sourceRevision, 'rev-1')
      // In-transaction safety failure: make the sidecar unsafe only after the
      // pre-check. The transaction must roll the proof insert back.
      reopened.resetSession('s-a')
      seed(reopened, 's-a', [occurrence('m1', 'body', 1000, '/repo/a')], { nextSeq: 10, lastEventHash: 'tail' })
      const second = reopened.checkpointOf('s-a')!
      const internals = reopened as unknown as {
        transaction<T>(work: () => T): T
      }
      const original = internals.transaction
      let injected = false
      internals.transaction = function injectUnsafeSidecar<T>(work: () => T): T {
        return original.call(reopened, () => {
          if (!injected) {
            injected = true
            chmodSync(wal, 0o644)
          }
          return work()
        }) as T
      }
      try {
        assert.throws(() => reopened.commitSourceProof(second, sourceBasis('d'.repeat(64), 'rev-2')), /not private/u)
      } finally {
        internals.transaction = original
        chmodSync(wal, 0o600)
      }
      assert.equal(injected, true)
      assert.equal(reopened.sourceProofOf('s-a'), undefined, 'the in-transaction failure must roll the proof back')
    } finally {
      reopened.close()
    }
    // The partial insert is never reused after a reopen.
    const final = HistorySearchIndex.open({ profileDir: dir })
    try {
      assert.equal(final.sourceProofOf('s-a'), undefined)
    } finally {
      final.close()
    }
  } finally {
    try {
      index.close()
    } catch {
      // Already closed for the reopen assertions.
    }
    if (existsSync(dbPath)) chmodSync(dbPath, 0o600)
  }
})

test('a failed checkpoint update after the proof delete rolls the proof back atomically', (t) => {
  const dir = profileDir(t)
  const { dbPath } = historyPaths(dir)
  const index = HistorySearchIndex.open({ profileDir: dir })
  const control = new DatabaseSync(dbPath)
  const trigger = 'fail_s_a_checkpoint_update'
  try {
    seedProof(index, 's-a')
    const checkpoint = index.checkpointOf('s-a')
    const proof = index.sourceProofOf('s-a')
    assert.ok(checkpoint !== undefined && proof !== undefined)
    const revocations = index.sourceProofRevocations
    const revision = index.revision
    const occurrences = index.occurrenceCount()

    // The UPDATE is deliberately aborted AFTER the batch already executed the
    // proof DELETE: this is the rollback boundary that stale-admission tests do
    // not exercise. The trigger is test-owned schema, removed in cleanup.
    control.exec(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON history_sessions
      WHEN OLD.session_id = 's-a'
      BEGIN SELECT RAISE(ABORT, 'forced checkpoint failure'); END`)
    assert.throws(() => index.commitBatch({
      sessionId: 's-a',
      headerHash: sessionHeaderHash({ id: 's-a' }),
      inheritedCut: 0,
      baseNextSeq: 10,
      nextSeq: 11,
      headerCwd: '/repo/a',
      effectiveCwd: '/repo/a',
      lastEventHash: 'next-tail',
      sourceState: 'persisted',
      uncertainSourcesDelta: 0,
      occurrences: [],
    }), /forced checkpoint failure/u)

    assert.deepEqual(index.checkpointOf('s-a'), checkpoint, 'the old checkpoint must be restored')
    assert.deepEqual(index.sourceProofOf('s-a'), proof, 'the old durable proof must be restored')
    assert.equal(index.sourceProofRevocations, revocations, 'the revocation counter must not advance')
    assert.equal(index.revision, revision, 'the content generation must not change')
    assert.equal(index.occurrenceCount(), occurrences, 'the occurrence rows must not change')
  } finally {
    try {
      control.exec(`DROP TRIGGER IF EXISTS ${trigger}`)
    } finally {
      control.close()
      index.close()
    }
  }

  const reopened = HistorySearchIndex.open({ profileDir: dir })
  try {
    assert.deepEqual(reopened.checkpointOf('s-a'), {
      sessionId: 's-a',
      headerCwd: '/repo/a',
      inheritedCut: 0,
      nextSeq: 10,
      effectiveCwd: '/repo/a',
      lastEventHash: 'tail-s-a',
      headerHash: sessionHeaderHash({ id: 's-a' }),
      sourceState: 'persisted',
      uncertainSources: 0,
      dirty: false,
    })
    assert.equal(reopened.sourceProofOf('s-a')?.sourceRevision, 'rev-1')
    assert.equal(reopened.sourceProofRevocations, 0, 'a fresh handle starts with no committed revocation')
  } finally {
    reopened.close()
  }
})
