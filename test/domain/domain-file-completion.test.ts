/**
 * The neutral domain file-completion policy pins (TS8-A §16.1): the pure path
 * query resolver — including EXPLICIT environment injection for `~` and the
 * host-platform join choice, proven WITHOUT touching `process.platform` — the
 * display-base reattachment and the ranking model. No filesystem, no process
 * environment: the domain layer never discovers its own facts.
 * @module @xmoon76/dsh-pi-tui/domain-file-completion.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { posix, win32 } from 'node:path'
import {
  expandHomeToken,
  reattachDisplayBase,
  resolvePathQuery,
  separatorOfRaw,
  termOfRaw,
  type PathQueryEnvironment,
} from '../../src/domain/file-completion/query.ts'
import {
  createFinderRecordStream,
  discoverForQuery,
  MAX_UNTERMINATED_FINDER_CODE_UNITS,
  normalizeFinderRecord,
  type FinderRecord,
  type LocalDiscoveryDriver,
} from '../../src/domain/file-completion/discovery-policy.ts'
import {
  compareScoredPaths,
  createBoundedFinderCandidateCollector,
  MAX_LOCAL_COMPLETION_SUGGESTIONS,
  rankPathCandidates,
  scorePathCandidate,
} from '../../src/domain/file-completion/ranking.ts'
import type { PathCandidate } from '../../src/domain/file-completion/types.ts'

const POSIX: PathQueryEnvironment = { homeDir: '/home/fixture', windowsHost: false }
const WINDOWS: PathQueryEnvironment = { homeDir: 'C:\\Users\\fixture', windowsHost: true }
const CWD = '/ws'
const abort = new AbortController().signal

test('the resolver is environment-neutral: the explicit windowsHost selects the join, never process.platform', () => {
  // The same raw token and cwd under the two INJECTED host facts. Every expected
  // value is the EXPLICIT posix/win32 algebra — never the ambient default export
  // (which would make the expectation itself machine-dependent).
  const windows = resolvePathQuery('sub\\fi', CWD, WINDOWS)
  const posixQuery = resolvePathQuery('sub\\fi', CWD, POSIX)
  assert.equal(windows.searchBase, win32.join(CWD, 'sub'))
  assert.equal(posixQuery.searchBase, posix.join(CWD, 'sub'))
  assert.equal(windows.searchTerm, 'fi')
  assert.equal(posixQuery.searchTerm, 'fi')
  assert.equal(posixQuery.winAbsolute, false, 'a relative backslash token is a dialect, not an absolute Windows path')
  // A forward-slash relative token under a Windows-looking cwd: the scope and
  // parent algebra must be the HOST's, so the same input can never silently
  // collapse to the running process cwd.
  assert.equal(resolvePathQuery('src/fo', 'C:\\ws', WINDOWS).searchBase, win32.join('C:\\ws', 'src'))
  assert.equal(resolvePathQuery('../fo', 'C:\\ws', WINDOWS).searchBase, win32.join('C:\\ws', '..'))
  assert.equal(resolvePathQuery('../fo', 'C:\\ws', WINDOWS).searchBase, 'C:\\',
    'the Windows parent of a drive root stays the drive root')
  assert.notEqual(resolvePathQuery('../fo', 'C:\\ws', WINDOWS).searchBase, '.',
    'the POSIX join of the same input collapses to the process cwd — never here')
  // The POSIX side is unchanged and never mixed.
  assert.equal(resolvePathQuery('src/fo', CWD, POSIX).searchBase, posix.join(CWD, 'src'))
  assert.equal(resolvePathQuery('../fo', CWD, POSIX).searchBase, posix.join(CWD, '..'))
  // An unmistakable drive/UNC cwd keeps the win32 joiner even on a POSIX host.
  assert.equal(resolvePathQuery('sub\\fi', 'C:\\ws', POSIX).searchBase, win32.join('C:\\ws', 'sub'))
  // The token GRAMMAR follows the same explicit facts: a drive-relative name is
  // an ordinary POSIX name on a POSIX host, and a drive-relative path on Windows.
  assert.equal(resolvePathQuery('C:foo', CWD, POSIX).searchTerm, 'C:foo')
  assert.equal(resolvePathQuery('C:foo', CWD, WINDOWS).searchTerm, 'foo')
})

test('`~` forms expand through the INJECTED homeDir AND the injected host algebra', () => {
  assert.equal(expandHomeToken('~', '/home/fixture', false), '/home/fixture')
  assert.equal(expandHomeToken('~/a', '/home/fixture', false), posix.join('/home/fixture', 'a'))
  assert.equal(expandHomeToken('~\\a', '/home/fixture', false), posix.join('/home/fixture', 'a'),
    'a Windows-looking home token still resolves against the injected home')
  assert.equal(expandHomeToken('~/a', 'C:\\Users\\fixture', true), win32.join('C:\\Users\\fixture', 'a'))
  assert.equal(expandHomeToken('~\\a', 'C:\\Users\\fixture', true), win32.join('C:\\Users\\fixture', 'a'))
  assert.equal(expandHomeToken('plain', '/home/fixture', false), 'plain')
  // The resolver never calls homedir(): an explicit fixture home is authoritative.
  assert.equal(resolvePathQuery('~', CWD, { homeDir: '/nowhere-fixture', windowsHost: false }).searchBase,
    '/nowhere-fixture')
  assert.equal(resolvePathQuery('~/pics/a', CWD, POSIX).searchBase, posix.join('/home/fixture', 'pics'))
  assert.equal(resolvePathQuery('~/pics/a', CWD, WINDOWS).searchBase, win32.join('C:\\Users\\fixture', 'pics'),
    'a Windows host expands the home subdirectory with the Windows algebra')
  assert.equal(resolvePathQuery('~/../pics', CWD, WINDOWS).searchBase,
    win32.join('C:\\Users\\fixture', '..'),
    'the parent algebra of a Windows home is the Windows one — never the POSIX process cwd')
  assert.notEqual(resolvePathQuery('~/../pics', CWD, WINDOWS).searchBase, '.',
    'the un-neutralized join collapsed this to the process cwd')
  assert.equal(resolvePathQuery('~/../pics', CWD, WINDOWS).searchTerm, 'pics')
  assert.equal(resolvePathQuery('~/../pics', CWD, POSIX).searchBase, posix.join('/home/fixture', '..'))
  assert.equal(resolvePathQuery('~', CWD, WINDOWS).searchBase, 'C:\\Users\\fixture')
})

test('bare scope forms list their own directory with an explicit display base', () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    // raw, expected searchBase, expected displayBase
    ['', CWD, ''],
    ['.', CWD, './'],
    ['..', '/', '../'],
    ['./', `${CWD}/`, './'],
    ['../', '/', '../'],
    ['/', '/', '/'],
  ]
  for (const [raw, searchBase, displayBase] of cases) {
    const query = resolvePathQuery(raw, CWD, POSIX)
    assert.equal(query.searchBase, searchBase, `searchBase for ${JSON.stringify(raw)}`)
    assert.equal(query.displayBase, displayBase, `displayBase for ${JSON.stringify(raw)}`)
    assert.equal(query.searchTerm, '', `a bare scope form lists children: ${JSON.stringify(raw)}`)
    assert.equal(query.explicitScope, true)
  }
  // `~` and `~/` map to the injected home with the `~/` display dialect.
  assert.equal(resolvePathQuery('~', CWD, POSIX).displayBase, '~/')
  assert.equal(resolvePathQuery('~/', CWD, POSIX).searchBase, '/home/fixture')
})

test('scoped tokens search only their resolved directory; unscoped tokens are whole-tree', () => {
  const scoped = [
    ['src/fo', '/ws/src', 'fo', 'src/'],
    ['../foo', '/', 'foo', '../'],
    ['/tmp/foo', '/tmp', 'foo', '/tmp/'],
    ['C:\\Users\\sh', 'C:\\Users', 'sh', 'C:\\Users\\'],
    ['\\\\server\\share\\fo', '\\\\server\\share\\', 'fo', '\\\\server\\share\\'],
    ['foo\\bar', '/ws/foo', 'bar', 'foo\\'],
  ] as const
  for (const [raw, searchBase, searchTerm, displayBase] of scoped) {
    const query = resolvePathQuery(raw, CWD, POSIX)
    assert.equal(query.searchBase, searchBase, `searchBase for ${raw}`)
    assert.equal(query.searchTerm, searchTerm, `searchTerm for ${raw}`)
    assert.equal(query.displayBase, displayBase, `displayBase for ${raw}`)
    assert.equal(query.explicitScope, true, `${raw} names an explicit scope`)
  }
  const unscoped = resolvePathQuery('nested', CWD, POSIX)
  assert.equal(unscoped.searchBase, CWD, 'an unscoped token searches the whole cwd tree')
  assert.equal(unscoped.searchTerm, 'nested')
  assert.equal(unscoped.displayBase, '', 'an unscoped display base is empty')
  assert.equal(unscoped.explicitScope, false)
  // A trailing separator (either dialect) lists the directory.
  assert.equal(resolvePathQuery('src/', CWD, POSIX).searchTerm, '')
  assert.equal(resolvePathQuery('src\\', CWD, POSIX).searchTerm, '')
})

test('the display base reattaches onto the discovered relative path', () => {
  const scoped = resolvePathQuery('../sib', CWD, POSIX)
  assert.deepEqual(reattachDisplayBase({ path: 'sibling.ts', kind: 'file' }, scoped),
    { path: '../sibling.ts', kind: 'file' })
  const home = resolvePathQuery('~/pics/a', CWD, POSIX)
  assert.deepEqual(reattachDisplayBase({ path: 'a.png', kind: 'file' }, home),
    { path: '~/pics/a.png', kind: 'file' })
  const unscoped = resolvePathQuery('nested', CWD, POSIX)
  assert.deepEqual(reattachDisplayBase({ path: 'src/deep.ts', kind: 'file' }, unscoped),
    { path: 'src/deep.ts', kind: 'file' }, 'an empty display base returns the candidate unchanged')
})

test('separator/term helpers keep the user dialect', () => {
  assert.equal(separatorOfRaw('src/foo', false), '/')
  assert.equal(separatorOfRaw('C:\\Users\\foo', true), '\\')
  assert.equal(separatorOfRaw('C:/mixed\\dir\\foo', true), '\\', 'the LAST separator wins')
  assert.equal(separatorOfRaw('plain', true), '\\')
  assert.equal(termOfRaw('src/de'), 'de')
  assert.equal(termOfRaw('src/'), '')
  assert.equal(termOfRaw('.'), '')
  assert.equal(termOfRaw('..'), '')
  assert.equal(termOfRaw('a/b/..'), '')
})

test('ranking: exact > prefix > substring > full path, with the directory bonus', () => {
  const file = (path: string): PathCandidate => ({ path, kind: 'file' })
  assert.equal(scorePathCandidate(file('foo.txt'), 'foo'), 80)
  assert.equal(scorePathCandidate(file('src/foo.txt'), 'foo'), 80)
  assert.equal(scorePathCandidate(file('src/a-foo.ts'), 'foo'), 50)
  assert.equal(scorePathCandidate(file('foo/deep.ts'), 'foo'), 30)
  assert.equal(scorePathCandidate(file('src/foo.txt'), 'foo.txt'), 100, 'exact basename wins')
  assert.equal(scorePathCandidate(file('unrelated.ts'), 'foo'), 0)
  assert.equal(scorePathCandidate({ path: 'foodir', kind: 'directory' }, 'foo'), 90,
    'a directory carries the +10 bonus on a scoring match')
  // Listings (empty query): directories lead, shallow paths lead.
  assert.equal(scorePathCandidate({ path: 'adir', kind: 'directory' }, ''), 120)
  assert.equal(scorePathCandidate(file('deep/nested.txt'), ''), 99)
})

test('deterministic order: score desc, directory first, path asc', () => {
  // A LISTING (empty query) scores every entry — directories 120, files
  // 100 − depth — so nothing is filtered and the ordering is fully determined.
  const ranked = rankPathCandidates([
    { path: 'b.txt', kind: 'file' },
    { path: 'a-dir', kind: 'directory' },
    { path: 'a.txt', kind: 'file' },
    { path: 'unrelated', kind: 'file' },
  ], '')
  assert.deepEqual(ranked.map(candidate => candidate.path), ['a-dir', 'a.txt', 'b.txt', 'unrelated'],
    'directories lead, then the path-ascending tie-break')
  // A scoring query filters the zero-score candidates and orders by score.
  const byScore = rankPathCandidates([
    file2('a-foo.ts'), file2('foo.txt'), file2('deep/foo/x.ts'), file2('unrelated.txt'),
  ], 'foo')
  assert.deepEqual(byScore.map(candidate => candidate.path), ['foo.txt', 'a-foo.ts', 'deep/foo/x.ts'])
  // compareScoredPaths is the exact tie-break contract used by the adapter.
  assert.ok(compareScoredPaths(
    { candidate: { path: 'a', kind: 'file' }, score: 10 },
    { candidate: { path: 'b', kind: 'file' }, score: 10 },
  ) < 0)
})

test('the ranked set is bounded by the locality-neutral completion cap', () => {
  const many: PathCandidate[] = Array.from({ length: MAX_LOCAL_COMPLETION_SUGGESTIONS + 7 }, (_value, index) => ({
    path: `file-${String(index).padStart(3, '0')}.txt`,
    kind: 'file',
  }))
  assert.equal(rankPathCandidates(many, 'file').length, MAX_LOCAL_COMPLETION_SUGGESTIONS)
  assert.equal(MAX_LOCAL_COMPLETION_SUGGESTIONS, 50)
})

// ── the finder's incremental two-top-50 competition ──────────────────────

test('the bounded finder collector keeps a late exact basename beyond any early-output cutoff', () => {
  const collector = createBoundedFinderCandidateCollector('needle')
  for (let index = 0; index < 150; index += 1) {
    collector.offer({ path: `nested/needle-${String(index).padStart(3, '0')}.txt`, kind: 'file' })
  }
  collector.offer({ path: 'needle', kind: 'file' })
  const ranked = rankPathCandidates(collector.finish(), 'needle')
  assert.equal(ranked[0]?.path, 'needle', 'the exact basename wins despite 150 earlier records')
  assert.equal(ranked.length, MAX_LOCAL_COMPLETION_SUGGESTIONS, 'the presentation cap stays 50')
})

test('the collector keeps a directory-only top 50 even when files fill the all-types top 50', () => {
  const collector = createBoundedFinderCandidateCollector('needle')
  // 60 files score as basename prefixes (80); 60 directories match only
  // through the full-path tier (30 + 10) — the all-types top 50 is all files.
  for (let index = 0; index < 60; index += 1) {
    collector.offer({ path: `needle-file-${String(index).padStart(3, '0')}.txt`, kind: 'file' })
  }
  for (let index = 0; index < 60; index += 1) {
    collector.offer({ path: `deep/needle/deeper-${String(index).padStart(3, '0')}`, kind: 'directory' })
  }
  const union = collector.finish()
  assert.ok(union.length <= 100, `the union is capped by the two top-50 competitions: ${union.length}`)
  const overall = rankPathCandidates(union, 'needle')
  assert.equal(overall.length, MAX_LOCAL_COMPLETION_SUGGESTIONS)
  assert.ok(overall.every(candidate => candidate.kind === 'file'),
    `the all-types top 50 is genuinely filled by files: ${JSON.stringify(overall.map(candidate => candidate.path))}`)
  // The Save Location consumer filters the SAME union to directories: its own
  // top 50 must still exist even though no directory reached the all-types set.
  const directories = rankPathCandidates(union.filter(candidate => candidate.kind === 'directory'), 'needle')
  assert.equal(directories.length, MAX_LOCAL_COMPLETION_SUGGESTIONS,
    'the directory top 50 survives beside the all-types competition')
  assert.deepEqual(directories.map(candidate => candidate.path), Array.from({ length: 50 }, (_value, index) =>
    `deep/needle/deeper-${String(index).padStart(3, '0')}`),
  'the directory competition uses the shared score/compare order')
})

test('the collector reuses the one scoring model: case, ties, empty term, zero score and duplicates', () => {
  const cased = createBoundedFinderCandidateCollector('FOO')
  cased.offer({ path: 'foo.txt', kind: 'file' })
  assert.deepEqual(cased.finish(), [{ path: 'foo.txt', kind: 'file' }],
    'the collector lowercases the term exactly like scorePathCandidate')
  const listing = createBoundedFinderCandidateCollector('')
  listing.offer({ path: 'b.txt', kind: 'file' })
  listing.offer({ path: 'adir', kind: 'directory' })
  assert.deepEqual(rankPathCandidates(listing.finish(), '').map(candidate => candidate.path), ['adir', 'b.txt'],
    'an empty term keeps the listing order (directories lead)')
  const duplicate = createBoundedFinderCandidateCollector('foo')
  duplicate.offer({ path: 'foo-dir', kind: 'directory' })
  duplicate.offer({ path: 'foo-dir', kind: 'directory' })
  const union = duplicate.finish()
  assert.deepEqual(union, [{ path: 'foo-dir', kind: 'directory' }],
    'a directory competes in both sets but appears ONCE in the union')
  const zero = createBoundedFinderCandidateCollector('foo')
  zero.offer({ path: 'unrelated.txt', kind: 'file' })
  assert.deepEqual(zero.finish(), [], 'a score-0 candidate is discarded')
  const tie = createBoundedFinderCandidateCollector('foo')
  tie.offer({ path: 'b-foo.txt', kind: 'file' })
  tie.offer({ path: 'a-foo.txt', kind: 'file' })
  assert.deepEqual(rankPathCandidates(tie.finish(), 'foo').map(candidate => candidate.path),
    ['a-foo.txt', 'b-foo.txt'], 'ties fall back to the shared path-ascending comparator')
})

// ── the finder stdout record stream ───────────────────────────────────────

test('a finder record stream parses NUL records split across chunks and normalizes each record', () => {
  const records: FinderRecord[] = []
  const stream = createFinderRecordStream(record => records.push(record))
  assert.equal(stream.push('./src/foo'), true)
  assert.equal(stream.push('bar.ts\0./baz'), true)
  assert.equal(stream.push('dir/\0./.git/config\0'), true)
  assert.equal(stream.finish(), true)
  assert.deepEqual(records, [
    { path: 'src/foobar.ts', directoryHint: false },
    { path: 'bazdir', directoryHint: true },
  ], 'a record split across chunks is ONE record; .git records never surface')
  // The single-record normalizer is the same policy for every caller.
  assert.deepEqual(normalizeFinderRecord('./a/b.txt'), { path: 'a/b.txt', directoryHint: false })
  assert.deepEqual(normalizeFinderRecord('dir/'), { path: 'dir', directoryHint: true })
  assert.equal(normalizeFinderRecord('.git'), undefined)
  assert.equal(normalizeFinderRecord('x/.git/y'), undefined)
  assert.equal(normalizeFinderRecord(''), undefined)
})

test('a NUL-free newline dialect is only accepted at close; a truncated NUL run fails', () => {
  const legacy: FinderRecord[] = []
  const newlineDialect = createFinderRecordStream(record => legacy.push(record))
  assert.equal(newlineDialect.push('a.txt\nmy file.txt\n'), true)
  assert.equal(legacy.length, 0,
    'nothing is emitted while the whole output may still be one unfinished NUL record')
  assert.equal(newlineDialect.finish(), true)
  assert.deepEqual(legacy.map(record => record.path), ['a.txt', 'my file.txt'])

  const truncated: FinderRecord[] = []
  const cut = createFinderRecordStream(record => truncated.push(record))
  assert.equal(cut.push('ok.txt\0partial'), true)
  assert.equal(cut.finish(), false, 'an unterminated --print0 record is a failure')
  assert.deepEqual(truncated, [{ path: 'ok.txt', directoryHint: false }],
    'a failed stream is never consumed as a partial result')
})

test('an unterminated record over the IO bound trips the stream guard', () => {
  const stream = createFinderRecordStream(() => {})
  assert.equal(stream.push('a'.repeat(MAX_UNTERMINATED_FINDER_CODE_UNITS + 1)), false)
  assert.equal(stream.finish(), false)
})

// ── the discovery routes (Owner amendment D2: direct-child-first scopes) ──

/** A recording driver: `find` never answers unless the test wants it to. */
function recordingDriver(options: {
  readonly entries?: readonly { name: string; kind: 'file' | 'directory' }[]
  readonly findResult?: readonly PathCandidate[] | null
} = {}): LocalDiscoveryDriver & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async listDirectory(_baseDir, relativeDir) {
      calls.push(`list:${relativeDir}`)
      return (options.entries ?? []).map(entry => ({
        name: entry.name,
        kind: entry.kind,
        descendable: entry.kind === 'directory',
      }))
    },
    async find() {
      calls.push('find')
      return options.findResult ?? []
    },
  }
}

test('an explicit scope answers from its DIRECT children first and never calls the finder', async () => {
  // The Owner-amended contract (D2): the user explicitly named this directory,
  // so its own matching entries answer before any subtree work — however many
  // deeper candidates a finder would race in.
  const driver = recordingDriver({
    entries: [
      { name: 'tmp', kind: 'directory' },
      { name: 'home', kind: 'directory' },
    ],
  })
  const found = await discoverForQuery(resolvePathQuery('/tm', '/', POSIX), driver, abort)
  assert.deepEqual(found, [{ path: 'tmp', kind: 'directory' }],
    'the direct child matching the term is the answer')
  assert.ok(!driver.calls.includes('find'),
    `the finder never runs when a direct child matches: ${JSON.stringify(driver.calls)}`)
  // The empty-term scoped listing keeps its complete-children route.
  const listing = await discoverForQuery(resolvePathQuery('/', '/', POSIX), driver, abort)
  assert.deepEqual(listing.map(candidate => candidate.path), ['tmp', 'home'])
})

test('a direct prefix match outranks a deeper exact basename on an explicit scope', async () => {
  // The finder WOULD return `dir/src` (exact basename, score 100); the direct
  // child `srcray` matches only as a prefix (80). The amended contract answers
  // with the direct match and skips the subtree race entirely.
  const driver = recordingDriver({
    entries: [{ name: 'srcray', kind: 'file' }],
    findResult: [{ path: 'src', kind: 'file' }],
  })
  const found = await discoverForQuery(resolvePathQuery('dir/sr', '/ws', POSIX), driver, abort)
  assert.deepEqual(found, [{ path: 'srcray', kind: 'file' }])
  assert.ok(!driver.calls.includes('find'))
})

test('a scoped query with NO direct match keeps the finder and its result merge', async () => {
  const driver = recordingDriver({
    entries: [{ name: 'sub', kind: 'directory' }],
    findResult: [{ path: 'sub/utility.ts', kind: 'file' }],
  })
  const found = await discoverForQuery(resolvePathQuery('dir/uti', '/ws', POSIX), driver, abort)
  assert.deepEqual(found, [{ path: 'sub/utility.ts', kind: 'file' }],
    'no direct child matches `uti`, so the finder answers')
  assert.equal(driver.calls.filter(call => call === 'find').length, 1)
})

test('a record that reaches the bound and is terminated in a later chunk still trips the guard', () => {
  // The reviewer's exact probe: the fragment sits exactly at the bound, then
  // the over-bound completion and its NUL arrive in ONE later chunk. The
  // completed record is over the bound, so the run fails — the record is
  // never emitted as a success.
  const records: FinderRecord[] = []
  const stream = createFinderRecordStream(record => records.push(record))
  assert.equal(stream.push('a'.repeat(MAX_UNTERMINATED_FINDER_CODE_UNITS)), true)
  assert.equal(stream.push('a\0'), false)
  assert.equal(stream.finish(), false)
  assert.equal(records.length, 0, 'an over-bound record is never emitted')
})

function file2(path: string): PathCandidate {
  return { path, kind: 'file' }
}
