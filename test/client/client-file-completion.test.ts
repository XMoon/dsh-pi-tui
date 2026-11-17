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
} from '../../src/client/file-completion/local-discovery.ts'
import { discoverForQuery, MAX_FALLBACK_SCAN } from '../../src/domain/file-completion/discovery-policy.ts'
import { rankPathCandidates } from '../../src/domain/file-completion/ranking.ts'
import { resolvePathQuery, type PathQueryEnvironment } from '../../src/domain/file-completion/query.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

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

/**
 * A pinned fake CLIENT finder over a scripted record list. It records its argv
 * and honours fd's OWN `--max-results` bound, so an early-output cutoff in the
 * production argument list is observable as BEHAVIOUR (a capped finder really
 * omits the late record), not only as an argument-list string. The records
 * arrive through a file so legal filename bytes (newlines, spaces, UTF-8) stay
 * verbatim.
 */
function scriptedFinder(life: TestLifecycle, records: readonly string[]): { path: string; argsFile: string } {
  const dir = life.tempDir('dsh-client-fd-scripted-')
  const recordFile = join(dir, 'records.bin')
  writeFileSync(recordFile, records.map(record => `${record}\0`).join(''))
  const path = join(dir, 'fd')
  const argsFile = join(dir, 'args.txt')
  writeFileSync(path, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.writeFileSync(${JSON.stringify(argsFile)}, args.join('\\n'))
const maxIndex = args.indexOf('--max-results')
const max = maxIndex === -1 ? Infinity : Number(args[maxIndex + 1])
const records = fs.readFileSync(${JSON.stringify(recordFile)}, 'utf8').split('\\u0000')
if (records.at(-1) === '') records.pop()
process.stdout.write(records.slice(0, max).map(record => record + '\\u0000').join(''))
`)
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
  assert.ok(!args.includes('--max-results'),
    `the finder must NOT truncate before ranking: ${JSON.stringify(args)}`)
  assert.ok(args.includes('file\\[\\+\\]'), `the literal term is regex-escaped: ${JSON.stringify(args)}`)
})

test('a strong finder match emitted after 100 weaker records still reaches the ranked set', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-uncapped-')
  // 150 weaker prefix matches (score 80) stream out first; the EXACT basename
  // match (score 100) is emitted LAST, i.e. beyond the retired 100-record cap.
  const records = Array.from({ length: 150 }, (_value, index) =>
    `nested/needle-${String(index).padStart(3, '0')}.txt`)
  records.push('needle')
  const finder = scriptedFinder(life, records)
  const driver = new ClientLocalDiscoveryDriver(finder.path)
  const candidates = await discoverForQuery(resolvePathQuery('needle', cwd, ENV), driver, abort)
  const args = readFileSync(finder.argsFile, 'utf8').split(/\r?\n/)
  assert.ok(!args.includes('--max-results'),
    `no early-output cap may reach the Client finder: ${JSON.stringify(args)}`)
  const ranked = rankPathCandidates(candidates, 'needle')
  assert.equal(ranked[0]?.path, 'needle',
    `the late exact match must win the ranked presentation set: ${JSON.stringify(ranked)}`)
  assert.equal(ranked.length, 50, 'the presentation cap stays the existing 50')
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
  // fallback (unlike trim(), it preserves meaningful spaces). The records carry
  // the searched bytes, exactly like a real finder that applied its own term:
  // the collector drops a score-0 record, so a non-matching mock candidate must
  // not be presented as a user suggestion.
  const lines = fakeFinder(life, `printf 'a-t.txt\\nmy t-file.txt\\n'`)
  const lineCandidates = await discoverForQuery(
    resolvePathQuery('t', cwd, ENV),
    new ClientLocalDiscoveryDriver(lines.path),
    abort,
  )
  assert.deepEqual(lineCandidates.map(candidate => candidate.path), ['a-t.txt', 'my t-file.txt'])
})

test('a large finder stream keeps UTF-8, legal whitespace and the finder facts across chunks', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-stream-')
  mkdirSync(join(cwd, 'nested'))
  mkdirSync(join(cwd, 'real'))
  symlinkSync(join(cwd, 'real'), join(cwd, 'nested', 'linkdir'))
  // ~70 KiB of NUL records: the pipe delivers several data events, so records
  // and multi-byte UTF-8 sequences cross chunk boundaries in the REAL stream.
  const records = Array.from({ length: 2600 }, (_value, index) =>
    `nested/大文件-${String(index).padStart(4, '0')}.txt`)
  records.push(' leading  space.txt', 'line\nbreak.txt', './.git/config', 'nested/linkdir')
  const finder = scriptedFinder(life, records)
  const driver = new ClientLocalDiscoveryDriver(finder.path)
  const ranked = async (term: string): Promise<readonly { path: string; kind: string }[]> =>
    rankPathCandidates(
      await discoverForQuery(resolvePathQuery(term, cwd, ENV), driver, abort),
      term,
    )
  const bulk = await ranked('大文件')
  assert.equal(bulk.length, 50, 'the bounded collector trims the 2600-record stream')
  assert.equal(bulk[0]?.path, 'nested/大文件-0000.txt', 'the multi-byte record decoded verbatim')
  assert.ok(bulk.every(candidate => !candidate.path.includes('.git')), '.git records are excluded')
  const spaced = await ranked('space')
  assert.deepEqual(spaced.map(candidate => candidate.path), [' leading  space.txt'],
    'the leading/double space filename survives the stream verbatim')
  const newline = await ranked('line\nbreak')
  assert.deepEqual(newline.map(candidate => candidate.path), ['line\nbreak.txt'],
    'a legal newline inside a NUL record is not a record boundary')
  const link = await ranked('link')
  assert.deepEqual(link, [{ path: 'nested/linkdir', kind: 'directory' }],
    'the finder record is classified against the Client filesystem (symlink to a directory)')
})

test('a non-zero finder exit discards its partial matches and the bounded fallback answers', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-nonzero-')
  writeFileSync(join(cwd, 'fallback-needle.txt'), 'x')
  const finder = fakeFinder(life, `printf '%s\\0' 'fake-only-needle.txt'; exit 3`)
  const driver = new ClientLocalDiscoveryDriver(finder.path)
  const candidates = await discoverForQuery(resolvePathQuery('needle', cwd, ENV), driver, abort)
  const paths = candidates.map(candidate => candidate.path)
  assert.ok(paths.includes('fallback-needle.txt'), `the bounded fallback answers: ${JSON.stringify(paths)}`)
  assert.ok(!paths.includes('fake-only-needle.txt'), 'a failed finder contributes no partial match')
})

test('a truncated --print0 record is a finder failure, never a partial success', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-truncated-')
  writeFileSync(join(cwd, 'fallback-needle.txt'), 'x')
  // One terminated record then an unterminated tail: the run was cut off.
  const finder = fakeFinder(life, `printf '%s\\0' 'fake-only-needle.txt'; printf '%s' 'partial-needle'`)
  const driver = new ClientLocalDiscoveryDriver(finder.path)
  const candidates = await discoverForQuery(resolvePathQuery('needle', cwd, ENV), driver, abort)
  const paths = candidates.map(candidate => candidate.path)
  assert.ok(paths.includes('fallback-needle.txt'), `the bounded fallback answers: ${JSON.stringify(paths)}`)
  assert.ok(!paths.includes('fake-only-needle.txt') && !paths.includes('partial-needle'),
    'a cut-off finder stream is a failure, never a partial success')
})

test('an unterminated record over the IO bound is a finder failure with the fallback answer', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-overbound-')
  writeFileSync(join(cwd, 'fallback-needle.txt'), 'x')
  // 70000 NUL-free code units exceed the 65_536 guard: the child is killed and
  // the run fails instead of accumulating an unbounded candidate string.
  const finder = fakeFinder(life, `dd if=/dev/zero bs=70000 count=1 2>/dev/null | tr '\\0' 'a'`)
  const driver = new ClientLocalDiscoveryDriver(finder.path)
  const candidates = await discoverForQuery(resolvePathQuery('needle', cwd, ENV), driver, abort)
  assert.ok(candidates.some(candidate => candidate.path === 'fallback-needle.txt'),
    `the bounded fallback answers after the guard trips: ${JSON.stringify(candidates.map(candidate => candidate.path))}`)
})

test('a single terminated record over the IO bound is a finder failure with the fallback answer', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-overbound-terminated-')
  writeFileSync(join(cwd, 'fallback-needle.txt'), 'x')
  // One NUL-terminated record longer than the guard: the completion and its
  // NUL arrive inside the same chunk, so only the completed-record check can
  // catch it. The run fails and the bounded fallback answers.
  const finder = scriptedFinder(life, ['x'.repeat(65_600)])
  const driver = new ClientLocalDiscoveryDriver(finder.path)
  const candidates = await discoverForQuery(resolvePathQuery('needle', cwd, ENV), driver, abort)
  const paths = candidates.map(candidate => candidate.path)
  assert.ok(paths.includes('fallback-needle.txt'),
    `the bounded fallback answers after the guard trips: ${JSON.stringify(paths)}`)
  assert.ok(!paths.some(path => path.length > 65_536),
    'the over-bound record never surfaces as a candidate')
})

test('a successful finder with no matches is a valid empty result, never a fallback scan', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-empty-')
  mkdirSync(join(cwd, 'sub'))
  writeFileSync(join(cwd, 'sub', 'needle.txt'), 'x')
  // A no-op fake finder exits 0 with no output: the finder's answer is
  // authoritative, so the bounded subtree scan must not fabricate a candidate.
  const finder = fakeFinder(life, ':')
  const driver = new ClientLocalDiscoveryDriver(finder.path)
  assert.deepEqual(await discoverForQuery(resolvePathQuery('needle', cwd, ENV), driver, abort), [],
    'a valid empty finder result does not rescan the tree')
})

test('symlink facts: a symlinked directory is a candidate but is never descended, at the root or below', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-client-symlink-')
  mkdirSync(join(cwd, 'real'))
  writeFileSync(join(cwd, 'real', 'inside.ts'), 'x')
  symlinkSync('real', join(cwd, 'linkdir'))
  mkdirSync(join(cwd, 'dir'))
  symlinkSync(join('..', 'real'), join(cwd, 'dir', 'nested-link'))
  // A link that points OUTSIDE the scan root must not widen the traversal. The
  // target is a lifecycle-owned directory (`tempDir` creates directly under
  // `os.tmpdir()`, so `join(cwd, '..')` would be a shared, never-cleaned path).
  const outside = life.tempDir('dsh-client-symlink-outside-')
  writeFileSync(join(outside, 'outside.ts'), 'x')
  symlinkSync(outside, join(cwd, 'escape'))
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
