/**
 * The Client-local file-completion adapter pins (TS8-A §16.3): the Client
 * process's OWN filesystem behind the neutral `LocalDiscoveryDriver` contract —
 * finder preference and pinning, finder argv/parsing, the bounded fallback,
 * `.git` exclusion, symlink facts, abort and root-child completeness. These
 * tests deliberately never instantiate the Direct Host adapter: the Client
 * capability must stand alone under a future Remote attach.
 * @module @xmoon76/dsh-pi-tui/client-file-completion.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ClientLocalDiscoveryDriver,
  clientPathQueryEnvironment,
  resolveFdPath,
} from '../src/client/file-completion/local-discovery.ts'
import { discoverForQuery, MAX_FALLBACK_SCAN } from '../src/domain/file-completion/discovery-policy.ts'
import { resolvePathQuery, type PathQueryEnvironment } from '../src/domain/file-completion/query.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

const ENV: PathQueryEnvironment = { homeDir: '/home/fixture', windowsHost: false }
const abort = new AbortController().signal

/** A pinned fake CLIENT finder: records its argv and prints the given stdout. */
function fakeFinder(life: TestLifecycle, body: string): { path: string; argsFile: string } {
  const dir = life.tempDir('dsh-client-fd-')
  const path = join(dir, 'fd')
  const argsFile = join(dir, 'args.txt')
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsFile)}\n${body}\n`)
  chmodSync(path, 0o755)
  return { path, argsFile }
}

/** The Client environment facts are the CLIENT process's own. */
test('the Client query environment reports the Client process facts', () => {
  const environment = clientPathQueryEnvironment()
  assert.equal(typeof environment.homeDir, 'string')
  assert.equal(environment.windowsHost, process.platform === 'win32')
})

test('resolveFdPath prefers fd on the Client PATH, falls back to fdfind and honors PATHEXT', (t) => {
  const life = testLifecycle(t)
  const savedPath = process.env.PATH
  const savedPathExt = process.env.PATHEXT
  try {
    const dir = life.tempDir('dsh-client-fd-pref-')
    const fd = join(dir, 'fd')
    const fdfind = join(dir, 'fdfind')
    writeFileSync(fd, '#!/bin/sh\nexit 0\n')
    writeFileSync(fdfind, '#!/bin/sh\nexit 0\n')
    chmodSync(fd, 0o755)
    chmodSync(fdfind, 0o755)
    process.env.PATH = dir
    assert.equal(resolveFdPath(), fd, 'fd wins over fdfind')
    const only = life.tempDir('dsh-client-fdfind-')
    const justFdfind = join(only, 'fdfind')
    writeFileSync(justFdfind, '#!/bin/sh\nexit 0\n')
    chmodSync(justFdfind, 0o755)
    process.env.PATH = only
    assert.equal(resolveFdPath(), justFdfind, 'fdfind is the Debian fallback')
    process.env.PATH = '/nonexistent-dir'
    assert.equal(resolveFdPath(), null, 'no finder on PATH yields null')
    // PATHEXT-style suffixes make the same probe work on a Windows host.
    const extDir = life.tempDir('dsh-client-fd-ext-')
    const fdExe = join(extDir, 'fd.exe')
    writeFileSync(fdExe, '#!/bin/sh\nexit 0\n')
    chmodSync(fdExe, 0o755)
    process.env.PATH = extDir
    process.env.PATHEXT = '.EXE'
    assert.equal(resolveFdPath()?.toLowerCase(), fdExe.toLowerCase())
  } finally {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    if (savedPathExt === undefined) delete process.env.PATHEXT
    else process.env.PATHEXT = savedPathExt
  }
})

test('a pinned Client finder drives the fast path; the literal term is regex-escaped and the .git/.hidden contract holds', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-fastpath-')
  writeFileSync(join(cwd, 'file[+].ts'), 'x')
  const finder = fakeFinder(life, `printf '%s\\0' './file[+].ts'`)
  const driver = new ClientLocalDiscoveryDriver(finder.path)
  assert.equal(driver.fdPath, finder.path, 'a string pins the finder')
  const query = resolvePathQuery('file[+]', cwd, ENV)
  const candidates = await discoverForQuery(query, driver, abort)
  assert.ok(candidates.some(candidate => candidate.path === 'file[+].ts' && candidate.kind === 'file'),
    `the finder candidates flow through as path-only facts:\n${JSON.stringify(candidates)}`)
  const args = readFileSync(finder.argsFile, 'utf8').split(/\r?\n/)
  assert.ok(args.includes('--full-path'), 'the finder matches the full relative path')
  assert.ok(args.includes('--print0'), 'the finder emits NUL-delimited records')
  assert.ok(args.includes('--hidden'), 'hidden files are part of the completion contract')
  assert.ok(args.includes('--max-results') && args.includes('100'), 'the finder result cap is bounded')
  assert.ok(args.includes('file\\[\\+\\]'), `the literal term is regex-escaped: ${JSON.stringify(args)}`)
})

test('null pins the bounded fallback: no finder is probed and the scan answers', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-null-')
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'main.ts'), 'x')
  writeFileSync(join(cwd, '.env'), 'x')
  mkdirSync(join(cwd, '.git'))
  writeFileSync(join(cwd, '.git', 'config'), 'x')
  const driver = new ClientLocalDiscoveryDriver(null)
  assert.equal(driver.fdPath, null)
  assert.equal(await driver.find(cwd, 'main', abort), null, 'a null pin forces the fallback')
  const listing = await discoverForQuery(resolvePathQuery('', cwd, ENV), driver, abort)
  assert.ok(listing.some(candidate => candidate.path === 'src' && candidate.kind === 'directory'))
  assert.ok(listing.some(candidate => candidate.path === '.env'), 'a hidden file stays a candidate')
  assert.ok(!listing.some(candidate => candidate.path === '.git'), '.git must never be listed')
  const nested = await discoverForQuery(resolvePathQuery('main', cwd, ENV), driver, abort)
  assert.ok(nested.some(candidate => candidate.path === 'src/main.ts'), 'the bounded subtree scan finds nested files')
})

test('the finder output parser: NUL records, whitespace, the newline fallback and .git exclusion', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-parse-')
  const nul = fakeFinder(life, `printf '%s\\0' './ leading file.txt' '.git/config' './src/'`)
  const nulCandidates = await discoverForQuery(
    resolvePathQuery('leading', cwd, ENV),
    new ClientLocalDiscoveryDriver(nul.path),
    abort,
  )
  assert.ok(nulCandidates.some(candidate => candidate.path === ' leading file.txt' && candidate.kind === 'file'),
    `a NUL record keeps the filename whitespace: ${JSON.stringify(nulCandidates)}`)
  assert.ok(!nulCandidates.some(candidate => candidate.path.includes('.git')), '.git records are excluded')
  // A fake/older finder that ignores --print0 is accepted through the newline
  // fallback (unlike trim(), it preserves meaningful spaces). The finder's own
  // records pass through verbatim — the finder already applied the term.
  const lines = fakeFinder(life, `printf 'a.txt\\nmy file.txt\\n'`)
  const lineCandidates = await discoverForQuery(
    resolvePathQuery('a', cwd, ENV),
    new ClientLocalDiscoveryDriver(lines.path),
    abort,
  )
  assert.deepEqual(lineCandidates.map(candidate => candidate.path), ['a.txt', 'my file.txt'])
})

test('symlink facts: a symlinked directory is a candidate but is never descended, at the root or below', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-symlink-')
  mkdirSync(join(cwd, 'real'))
  writeFileSync(join(cwd, 'real', 'inside.ts'), 'x')
  symlinkSync('real', join(cwd, 'linkdir'))
  mkdirSync(join(cwd, 'dir'))
  symlinkSync(join('..', 'real'), join(cwd, 'dir', 'nested-link'))
  // A link that points OUTSIDE the scan root must not widen the traversal.
  mkdirSync(join(cwd, '..', 'dsh-client-symlink-outside'), { recursive: true })
  writeFileSync(join(cwd, '..', 'dsh-client-symlink-outside', 'outside.ts'), 'x')
  symlinkSync(join('..', 'dsh-client-symlink-outside'), join(cwd, 'escape'))
  const driver = new ClientLocalDiscoveryDriver(null)
  // The adapter reports the FACT (a symlink to a directory IS a directory
  // candidate) and whether the neutral policy may descend it.
  const root = await driver.listDirectory(cwd, '', abort)
  assert.ok(root !== null)
  assert.deepEqual(root.find(entry => entry.name === 'linkdir'),
    { name: 'linkdir', kind: 'directory', descendable: false })
  assert.deepEqual(root.find(entry => entry.name === 'real'),
    { name: 'real', kind: 'directory', descendable: true })
  assert.deepEqual(root.find(entry => entry.name === 'escape'),
    { name: 'escape', kind: 'directory', descendable: false })
  // Fuzzy: the symlink stays a DIRECTORY candidate (a `@linkdir/` accept still
  // continues into the link), while its target's children are never enumerated —
  // at the search root and below it alike (the pre-TS8-A root pass used
  // Dirent.isDirectory(), which is false for a symlink, so it never descended
  // one either).
  const hits = await discoverForQuery(resolvePathQuery('inside', cwd, ENV), driver, abort)
  const paths = hits.map(candidate => candidate.path)
  assert.ok(paths.includes('real/inside.ts'), `the real directory is traversed: ${JSON.stringify(paths)}`)
  assert.ok(paths.includes('linkdir'), `the root symlink is still a directory candidate: ${JSON.stringify(paths)}`)
  assert.ok(paths.includes('dir/nested-link'), `the deeper symlink is still a candidate: ${JSON.stringify(paths)}`)
  assert.ok(!paths.includes('linkdir/inside.ts'), `a root symlinked directory must not be descended: ${JSON.stringify(paths)}`)
  assert.ok(!paths.includes('dir/nested-link/inside.ts'), `a below-root symlinked directory must not be descended: ${JSON.stringify(paths)}`)
  assert.ok(!paths.some(path => path.startsWith('escape/')), `a symlink must not widen the scan outside the root: ${JSON.stringify(paths)}`)
})

test('abort wins: an aborted Client request never serves a late finder result', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-abort-')
  writeFileSync(join(cwd, 'visible.txt'), 'x')
  const sleeping = fakeFinder(life, 'sleep 30')
  const controller = new AbortController()
  const pending = discoverForQuery(
    resolvePathQuery('visible', cwd, ENV),
    new ClientLocalDiscoveryDriver(sleeping.path),
    controller.signal,
  )
  controller.abort()
  assert.deepEqual(await pending, [], 'a cancelled finder settles as an empty result, never a late candidate')
  // An already-aborted request never touches the filesystem at all.
  const already = new AbortController()
  already.abort()
  assert.deepEqual(await discoverForQuery(resolvePathQuery('', cwd, ENV), new ClientLocalDiscoveryDriver(null), already.signal), [])
})

test('root direct children stay complete over a bounded deep fallback', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-large-')
  mkdirSync(join(cwd, 'src'))
  writeFileSync(join(cwd, 'src', 'wanted.ts'), 'x')
  const filler = join(cwd, 'filler')
  mkdirSync(filler)
  for (let index = 0; index < MAX_FALLBACK_SCAN + 40; index += 1) {
    writeFileSync(join(filler, `f-${index}.txt`), 'x')
  }
  const driver = new ClientLocalDiscoveryDriver(null)
  // The root's direct children are outside the traversal bound, so a
  // root-level `src` is found even though the workspace holds more entries
  // than the fallback may descend.
  //
  // `discoverForQuery` returns the raw traversal set for an unscoped query (the
  // ranking/filtering happens in the consumer), so the bound is directly
  // observable: the two root children (never capped) plus EXACTLY
  // MAX_FALLBACK_SCAN descended entries — the 40 surplus filler entries are
  // never enumerated. Which directory supplies the descended entries depends on
  // the filesystem's readdir order, so the assertion is on the deep total.
  const scanned = await discoverForQuery(resolvePathQuery('zzz-nothing-matches', cwd, ENV), driver, abort)
  const paths = scanned.map(candidate => candidate.path)
  assert.ok(paths.includes('src'), `the root-level directory survives the bound: ${JSON.stringify(paths.slice(0, 4))}`)
  assert.equal(scanned.length, MAX_FALLBACK_SCAN + 2, 'root children + the bounded deep traversal only')
  assert.equal(scanned.filter(candidate => candidate.path.includes('/')).length, MAX_FALLBACK_SCAN,
    'the deep traversal stops exactly at the bound')
  // A scoped listing of that directory is never a whole-tree scan.
  const children = await discoverForQuery(resolvePathQuery('src/', cwd, ENV), driver, abort)
  assert.deepEqual(children.map(candidate => candidate.path), ['wanted.ts'])
})
