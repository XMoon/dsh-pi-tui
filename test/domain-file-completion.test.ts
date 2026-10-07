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
} from '../src/domain/file-completion/query.ts'
import {
  compareScoredPaths,
  MAX_LOCAL_COMPLETION_SUGGESTIONS,
  rankPathCandidates,
  scorePathCandidate,
} from '../src/domain/file-completion/ranking.ts'
import type { PathCandidate } from '../src/domain/file-completion/types.ts'

const POSIX: PathQueryEnvironment = { homeDir: '/home/fixture', windowsHost: false }
const WINDOWS: PathQueryEnvironment = { homeDir: 'C:\\Users\\fixture', windowsHost: true }
const CWD = '/ws'

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

function file2(path: string): PathCandidate {
  return { path, kind: 'file' }
}
