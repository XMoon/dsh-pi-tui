/**
 * Contract tests for the TS8-HF1 Host `@`-completion router
 * (runtime/direct/host-file-augmentation-direct.ts): the routing boundary is
 * BARE workspace fuzzy (official `ctx.fileReferences`) vs EXPLICIT path
 * navigation (dsh-pi-tui Host scoped discovery). Every case proves the route
 * through its real SOURCE→SINK witnesses — the official service call count and
 * the production discovery driver's recorded scope — never by calling the
 * private classifier.
 *
 * @module @xmoon76/dsh-pi-tui/host-file-augmentation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, basename } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { PathQueryEnvironment } from '../src/domain/file-completion/query.ts'
import type { LocalDirectoryEntry } from '../src/domain/file-completion/discovery-policy.ts'
import { DirectHostDiscoveryDriver } from '../src/runtime/direct/file-completion/host-discovery.ts'
import {
  listPiTuiHostFileReferences,
  type FileReferencesServiceLike,
  type LiveAgentLike,
  type PiTuiHostFileReferenceDeps,
} from '../src/runtime/direct/host-file-augmentation-direct.ts'
import type { HostFileListResult } from '../src/runtime/host-file-port.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

const abort = new AbortController().signal

/** One recording harness: the official stand-in, the production Host driver
 * (fd pinned OFF so the bounded scan is deterministic) and both call logs. */
function harness(
  life: TestLifecycle,
  files: Record<string, string>,
  options: {
    readonly workspaceCwd?: string
    readonly homeDir?: string
    readonly windowsHost?: boolean
    readonly officialAbsent?: boolean
    readonly officialItems?: readonly { path: string; kind: 'file' | 'directory' }[]
  } = {},
) {
  const workspaceCwd = options.workspaceCwd ?? life.tempDir('dsh-hfa-ws-')
  const homeDir = options.homeDir ?? life.tempDir('dsh-hfa-home-')
  for (const [relative, content] of Object.entries(files)) {
    const path = join(workspaceCwd, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const officialCalls: string[] = []
  const official: FileReferencesServiceLike = {
    list: async (_agent, query) => {
      officialCalls.push(query)
      return options.officialItems ?? []
    },
  }
  const officialDefined = options.officialAbsent === true ? undefined : official
  const driverCalls: string[] = []
  const driver = new DirectHostDiscoveryDriver(null)
  const originalFind = driver.find
  const originalList = driver.listDirectory
  driver.find = async (baseDir: string, term: string, signal: AbortSignal) => {
    driverCalls.push(`find:${baseDir}:${term}`)
    return originalFind.call(driver, baseDir, term, signal)
  }
  driver.listDirectory = async (baseDir: string, relativeDir: string, signal: AbortSignal): Promise<readonly LocalDirectoryEntry[] | null> => {
    driverCalls.push(`list:${baseDir}:${relativeDir}`)
    return originalList.call(driver, baseDir, relativeDir, signal)
  }
  const environment: PathQueryEnvironment = {
    homeDir,
    windowsHost: options.windowsHost ?? false,
  }
  const deps: PiTuiHostFileReferenceDeps = {
    official: officialDefined,
    driver,
    environment,
  }
  const agent: LiveAgentLike = { session: { header: { cwd: workspaceCwd } } }
  return { workspaceCwd, homeDir, deps, agent, officialCalls, driverCalls }
}

function okItems(result: HostFileListResult): readonly { path: string; kind: string }[] {
  assert.equal(result.kind, 'ok')
  return result.kind === 'ok' ? result.items : []
}

test('a BARE query delegates the official authority exactly once and never enters the Host scanner', async (t) => {
  const life = testLifecycle(t)
  const officialItems = [{ path: 'host/answer.ts', kind: 'file' as const }]
  for (const query of ['foo', 'src', 'readme', '.env']) {
    const h = harness(life, { 'src/utility.ts': 'x' }, { officialItems })
    assert.deepEqual(await listPiTuiHostFileReferences(h.agent, query, abort, h.deps),
      { kind: 'ok', items: officialItems },
      `@${query} returns the official answer verbatim`)
    assert.deepEqual(h.officialCalls, [query], `@${query} calls the official service once`)
    assert.deepEqual(h.driverCalls, [], `@${query} never enters the Host scanner`)
  }
})

test('an official EMPTY answer stays authoritative empty — never a scanner fallback', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life, { 'src/utility.ts': 'x' }, { officialItems: [] })
  assert.deepEqual(await listPiTuiHostFileReferences(h.agent, 'uti', abort, h.deps),
    { kind: 'ok', items: [] })
  assert.deepEqual(h.officialCalls, ['uti'])
  assert.deepEqual(h.driverCalls, [], 'the scanner is never a fallback for an empty official answer')
})

test('a bare query without the official capability is unavailable, never a scanner fallback', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life, { 'src/utility.ts': 'x' }, { officialAbsent: true })
  const result = await listPiTuiHostFileReferences(h.agent, 'foo', abort, h.deps)
  assert.equal(result.kind, 'unavailable')
  assert.deepEqual(h.driverCalls, [])
})

test('an EXPLICIT scoped query uses the Host scanner inside the typed scope and never calls the official service', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life, { 'src/deep/utility.ts': 'x', 'other/utility.ts': 'y' })
  const result = await listPiTuiHostFileReferences(h.agent, 'src/uti', abort, h.deps)
  const paths = okItems(result).map(item => item.path)
  assert.ok(paths.includes('src/deep/utility.ts'), `the scoped recursive fuzzy finds the nested file: ${JSON.stringify(paths)}`)
  assert.ok(!paths.includes('other/utility.ts'), 'the scope stays exactly `src/`')
  assert.deepEqual(h.officialCalls, [], 'the official provider is never called on the explicit route')
  assert.ok(h.driverCalls.some(entry => entry === `find:${join(h.workspaceCwd, 'src')}:uti`),
    `the scanner is scoped at workspace/src: ${JSON.stringify(h.driverCalls)}`)
})

test('`./src/uti` addresses the same explicit scope as `src/uti`', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life, { 'src/deep/utility.ts': 'x' })
  const paths = okItems(await listPiTuiHostFileReferences(h.agent, './src/uti', abort, h.deps)).map(item => item.path)
  assert.deepEqual(paths, ['./src/deep/utility.ts'])
  assert.deepEqual(h.officialCalls, [])
})

test('an explicit parent scope resolves on the HOST cwd and keeps the ../ prefix', async (t) => {
  const life = testLifecycle(t)
  const parent = life.tempDir('dsh-hfa-parent-')
  const root = join(parent, 'ws')
  mkdirSync(root)
  mkdirSync(join(parent, 'shared'))
  writeFileSync(join(parent, 'shared', 'foo.txt'), 'x')
  writeFileSync(join(root, 'unrelated.txt'), 'x')
  const h = harness(life, {}, { workspaceCwd: root })
  const paths = okItems(await listPiTuiHostFileReferences(h.agent, '../shared/fo', abort, h.deps)).map(item => item.path)
  assert.deepEqual(paths, ['../shared/foo.txt'])
  assert.deepEqual(h.officialCalls, [])
})

test('a `..` scope searches the PHYSICAL traversal, so completion and read agree under a symlinked cwd', async (t) => {
  const life = testLifecycle(t)
  const real = life.tempDir('dsh-hfa-real-')
  mkdirSync(join(real, 'project'))
  mkdirSync(join(real, 'shared'))
  writeFileSync(join(real, 'shared', 'correct.txt'), 'physical')
  const alias = life.tempDir('dsh-hfa-alias-')
  symlinkSync(join(real, 'project'), join(alias, 'workspace'))
  const cwd = join(alias, 'workspace')
  const h = harness(life, {}, { workspaceCwd: cwd })
  // The Host's local fs backend anchors `../shared/correct.txt` with its PHYSICAL
  // spelling: the kernel resolves the `workspace` symlink BEFORE the parent step,
  // landing in <real>/shared. The scoped search must land there too.
  assert.deepEqual(okItems(await listPiTuiHostFileReferences(h.agent, '../shared/cor', abort, h.deps))
    .map(item => item.path), ['../shared/correct.txt'],
  'the scoped search resolves the symlink before the parent step')
  // NEGATIVE: a match that exists ONLY in the lexically joined sibling must never
  // be offered — the model's read of `../shared/decoy.txt` would resolve physically
  // and find nothing (or a different file).
  mkdirSync(join(alias, 'shared'))
  writeFileSync(join(alias, 'shared', 'decoy.txt'), 'lexical')
  assert.deepEqual(okItems(await listPiTuiHostFileReferences(h.agent, '../shared/dec', abort, h.deps)), [],
    'a lexically-only sibling is never offered')
  assert.deepEqual(h.officialCalls, [], 'the whole case stays on the scoped route')
})

test('a symlink traversed MID-scope before `..` is resolved physically too', async (t) => {
  const life = testLifecycle(t)
  const outside = life.tempDir('dsh-hfa-outside-')
  mkdirSync(join(outside, 'project'))
  mkdirSync(join(outside, 'shared'))
  writeFileSync(join(outside, 'shared', 'mid.txt'), 'physical')
  const root = life.tempDir('dsh-hfa-mid-')
  symlinkSync(join(outside, 'project'), join(root, 'link'))
  mkdirSync(join(root, 'shared'))
  writeFileSync(join(root, 'shared', 'mid-decoy.txt'), 'lexical')
  const h = harness(life, {}, { workspaceCwd: root })
  assert.deepEqual(okItems(await listPiTuiHostFileReferences(h.agent, 'link/../shared/mid', abort, h.deps))
    .map(item => item.path), ['link/../shared/mid.txt'],
  'the mid-scope symlink is resolved before the parent step')
})

test('the Host filesystem backend reads the accepted `..` value exactly where the scoped search looked', async (t) => {
  const life = testLifecycle(t)
  const real = life.tempDir('dsh-hfa-read-real-')
  mkdirSync(join(real, 'project'))
  mkdirSync(join(real, 'shared'))
  writeFileSync(join(real, 'shared', 'correct.txt'), 'physical')
  const alias = life.tempDir('dsh-hfa-read-alias-')
  symlinkSync(join(real, 'project'), join(alias, 'workspace'))
  const cwd = join(alias, 'workspace')
  const h = harness(life, {}, { workspaceCwd: cwd })
  const [offered] = okItems(await listPiTuiHostFileReferences(h.agent, '../shared/cor', abort, h.deps))
  assert.equal(offered?.path, '../shared/correct.txt')

  // The AUTHORITATIVE consumer: the Host's `ctx.fs` (what the read tool resolves
  // against) must land on the very same physical file for the offered value.
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem)
  try {
    const target = await ctx.fs.resolve(offered!.path, { cwd })
    assert.equal(target.displayPath, `${cwd}/../shared/correct.txt`,
      'the Host keeps the PHYSICAL spelling of a `..` path')
    assert.equal(readFileSync(target.displayPath, 'utf8'), 'physical',
      'the accepted value reads the file the scoped search found')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a Session cwd that itself carries `..` keeps the physical spelling too', async (t) => {
  const life = testLifecycle(t)
  const real = life.tempDir('dsh-hfa-cwd-real-')
  mkdirSync(join(real, 'child'))
  mkdirSync(join(real, 'project', 'src'), { recursive: true })
  writeFileSync(join(real, 'project', 'src', 'correct.ts'), 'physical')
  const alias = life.tempDir('dsh-hfa-cwd-alias-')
  symlinkSync(join(real, 'child'), join(alias, 'link'))
  mkdirSync(join(alias, 'project', 'src'), { recursive: true })
  writeFileSync(join(alias, 'project', 'src', 'decoy.ts'), 'lexical')
  // NOT path.join: the cwd spelling itself carries the symlink + `..` the Host
  // filesystem backend anchors physically.
  const cwd = `${alias}/link/../project`
  const h = harness(life, {}, { workspaceCwd: cwd })
  const paths = okItems(await listPiTuiHostFileReferences(h.agent, 'src/cor', abort, h.deps)).map(item => item.path)
  assert.deepEqual(paths, ['src/correct.ts'],
    `the cwd's own parent traversal is resolved physically: ${JSON.stringify(paths)}`)
  assert.deepEqual(okItems(await listPiTuiHostFileReferences(h.agent, 'src/dec', abort, h.deps)), [],
    'a lexically-only sibling of a `..` cwd is never offered')
  assert.deepEqual(h.officialCalls, [], 'the whole case stays on the scoped route')

  const ctx = new Context()
  await ctx.plugin(LocalFileSystem)
  try {
    const target = await ctx.fs.resolve('src/correct.ts', { cwd })
    assert.equal(target.displayPath, `${cwd}/src/correct.ts`,
      'the Host keeps the PHYSICAL spelling anchored on the cwd')
    assert.equal(readFileSync(target.displayPath, 'utf8'), 'physical',
      'the accepted value reads the file the scoped search found')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('the HOME shorthand searches exactly the directory its absolute value names', async (t) => {
  const life = testLifecycle(t)
  const real = life.tempDir('dsh-hfa-home-real-')
  mkdirSync(join(real, 'child'))
  mkdirSync(join(real, 'project', 'Downloads'), { recursive: true })
  writeFileSync(join(real, 'project', 'Downloads', 'loads.txt'), 'physical')
  const alias = life.tempDir('dsh-hfa-home-alias-')
  symlinkSync(join(real, 'child'), join(alias, 'link'))
  mkdirSync(join(alias, 'project', 'Downloads'), { recursive: true })
  writeFileSync(join(alias, 'project', 'Downloads', 'decoy.txt'), 'lexical')
  // A HOME spelling that carries both a symlink and a `..`.
  const home = `${alias}/link/../project`
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem)
  try {
    for (const query of ['~', '~/', '~/Down']) {
      const h = harness(life, {}, { homeDir: home })
      const offered = okItems(await listPiTuiHostFileReferences(h.agent, query, abort, h.deps))
      assert.ok(offered.length > 0, `@${query} offers the Host home's entries`)
      for (const item of offered) {
        assert.ok(isAbsolute(item.path) && !item.path.startsWith('~'),
          `@${query} emits an absolute Host path: ${item.path}`)
        // The authoritative consumer: an absolute value is resolved by the Host's
        // own filesystem backend; it must name the directory the search read.
        const target = await ctx.fs.resolve(item.path, { cwd: '/' })
        assert.equal(target.displayPath, item.path)
        assert.ok(existsSync(target.displayPath),
          `@${query} emitted a value the Host cannot open: ${item.path}`)
      }
    }
  } finally {
    await ctx.fiber.dispose()
  }
})

test('an explicitly named excluded directory is searchable on the scoped route', async (t) => {
  const life = testLifecycle(t)
  // `dist` is an official workspace exclusion, but the user explicitly named it.
  const h = harness(life, { 'dist/chunk.js': 'x', 'src/chunk.js': 'y' })
  const paths = okItems(await listPiTuiHostFileReferences(h.agent, 'dist/ch', abort, h.deps)).map(item => item.path)
  assert.deepEqual(paths, ['dist/chunk.js'])
})

test('an explicit symlink scope is addressable, while nested symlink descent stays disabled', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-hfa-link-')
  const target = life.tempDir('dsh-hfa-target-')
  writeFileSync(join(target, 'inside.ts'), 'x')
  mkdirSync(join(root, 'real'))
  writeFileSync(join(root, 'real', 'inside.ts'), 'y')
  symlinkSync(target, join(root, 'shared-link'))
  symlinkSync(join(target), join(root, 'real', 'nested-link'))
  const h = harness(life, {}, { workspaceCwd: root })
  // The EXPLICITLY selected symlink scope may be searched.
  const scoped = okItems(await listPiTuiHostFileReferences(h.agent, 'shared-link/in', abort, h.deps))
    .map(item => item.path)
  assert.deepEqual(scoped, ['shared-link/inside.ts'],
    'the explicitly addressed symlink scope is searchable')
  // A symlink encountered BELOW the scope is a candidate, never descended.
  const nested = okItems(await listPiTuiHostFileReferences(h.agent, 'real/', abort, h.deps))
    .map(item => item.path)
  assert.ok(nested.includes('real/nested-link'), `the nested symlink is exposed: ${JSON.stringify(nested)}`)
  assert.ok(!nested.some(path => path.startsWith('real/nested-link/')),
    `a nested symlink is never traversed: ${JSON.stringify(nested)}`)
})

test('a Host-absolute scope is searched without any workspace containment rule', async (t) => {
  const life = testLifecycle(t)
  const outside = life.tempDir('dsh-hfa-abs-')
  mkdirSync(join(outside, 'logs'))
  writeFileSync(join(outside, 'logs', 'app.log'), 'x')
  const h = harness(life, { 'logs/app.log': 'y' })
  const paths = okItems(await listPiTuiHostFileReferences(h.agent, `${outside}/lo`, abort, h.deps))
    .map(item => item.path)
  assert.equal(paths[0], `${outside}/logs`, `the absolute scope answers first: ${JSON.stringify(paths)}`)
  assert.ok(paths.includes(`${outside}/logs/app.log`), 'the absolute scope scans without containment rules')
  assert.deepEqual(h.officialCalls, [])
})

test('the HOME shorthand scores the scope-relative candidate, never the absolute home prefix', async (t) => {
  const life = testLifecycle(t)
  // The HOME directory's OWN name is the query term: no candidate's relative
  // path contains it, so a correct ranking answers empty. Ranking the
  // materialized absolute paths instead would match EVERY candidate through the
  // `<home>/` prefix and fabricate a full suggestion list.
  const home = life.tempDir('dsh-hfa-home-')
  mkdirSync(join(home, 'Downloads'))
  writeFileSync(join(home, 'Downloads', 'loads.txt'), 'x')
  const h = harness(life, {}, { homeDir: home })
  assert.deepEqual(okItems(await listPiTuiHostFileReferences(h.agent, `~/${basename(home)}`, abort, h.deps)), [],
    'the absolute HOME prefix never fabricates matches')
  assert.deepEqual(h.officialCalls, [], 'the home shorthand stays on the scoped route')
  // POSITIVE CONTROL: a genuine relative match still completes, absolute.
  const paths = okItems(await listPiTuiHostFileReferences(h.agent, '~/Down', abort, h.deps)).map(item => item.path)
  assert.ok(paths.includes(join(home, 'Downloads', 'loads.txt')),
    `a real home-scope match still completes: ${JSON.stringify(paths)}`)
})

test('the HOME shorthand uses the Host home and returns ABSOLUTE paths, never `~/...`', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-hfa-home-')
  mkdirSync(join(home, 'Downloads'))
  writeFileSync(join(home, 'Downloads', 'loads.txt'), 'x')
  const h = harness(life, {}, { homeDir: home })
  const paths = okItems(await listPiTuiHostFileReferences(h.agent, '~/Down', abort, h.deps)).map(item => item.path)
  assert.ok(paths.includes(join(home, 'Downloads', 'loads.txt')),
    `the Host HOME scope drives discovery: ${JSON.stringify(paths)}`)
  assert.ok(paths.every(path => isAbsolute(path) && !path.startsWith('~')),
    `every returned value is an ABSOLUTE Host path: ${JSON.stringify(paths)}`)
  assert.deepEqual(h.officialCalls, [], 'the home shorthand runs on the scoped route')
})

test('a cancellation rejects at entry and outranks every route', async (t) => {
  const life = testLifecycle(t)
  const h = harness(life, { 'src/deep/utility.ts': 'x' })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(listPiTuiHostFileReferences(h.agent, 'src/uti', controller.signal, h.deps), /aborted/u)
  await assert.rejects(listPiTuiHostFileReferences(h.agent, 'bare', controller.signal, h.deps), /aborted/u)
  assert.deepEqual(h.officialCalls, [], 'an aborted bare request never reaches the official service')
  assert.deepEqual(h.driverCalls, [], 'an aborted scoped request never reaches the scanner')
})

test('the Windows Host classifier treats backslashes and drive/UNC paths as explicit scopes', async (t) => {
  const life = testLifecycle(t)
  for (const query of ['foo\\bar', 'dir\\name/foo', 'C:\\work\\x', '\\\\server\\share\\y']) {
    const h = harness(life, {}, { windowsHost: true })
    const result = await listPiTuiHostFileReferences(h.agent, query, abort, h.deps)
    assert.equal(result.kind, 'ok')
    assert.deepEqual(h.officialCalls, [], `a Windows Host path is an explicit scope: ${query}`)
    assert.ok(h.driverCalls.length > 0, `the Windows Host path enters the scanner: ${query}`)
  }
  const bare = harness(life, {}, { windowsHost: true })
  await listPiTuiHostFileReferences(bare.agent, 'foo', abort, bare.deps)
  assert.deepEqual(bare.officialCalls, ['foo'], 'a bare Windows token stays official')
  assert.deepEqual(bare.driverCalls, [])
})

test('an ambiguous POSIX token containing a backslash is NOT claimed by the scoped route (TS8-HF1 boundary)', async (t) => {
  const life = testLifecycle(t)
  // On a POSIX Host `\` is an ordinary filename character. The reused TS8-A
  // resolver selects its Windows dialect from the token alone and normalizes the
  // separators (a pinned Client-local cross-dialect contract), so a mixed
  // `/`+`\` token has an exact scope the augmentation cannot represent: it fails
  // closed to the official provider instead of searching a different directory.
  const officialItems = [{ path: 'official/answer.ts', kind: 'file' as const }]
  for (const query of ['foo\\bar', 'dir\\name/foo', 'src/foo\\bar', './dir\\name/foo']) {
    const h = harness(life, { 'src/deep/utility.ts': 'x' }, { officialItems })
    assert.deepEqual(await listPiTuiHostFileReferences(h.agent, query, abort, h.deps),
      { kind: 'ok', items: officialItems },
      `@${query} delegates the official provider`)
    assert.deepEqual(h.officialCalls, [query], `exactly one official call for @${query}`)
    assert.deepEqual(h.driverCalls, [], `the Host scanner is never entered for an ambiguous POSIX token: ${query}`)
  }
  // NEGATIVE CONTROL against the boundary over-reaching: a pure POSIX path is
  // still scoped, so the guard is not a blanket POSIX opt-out.
  const scoped = harness(life, { 'src/deep/utility.ts': 'x' })
  const scopedPaths = okItems(await listPiTuiHostFileReferences(scoped.agent, 'src/deep', abort, scoped.deps))
    .map(item => item.path)
  assert.ok(scopedPaths.includes('src/deep/utility.ts'),
    `a pure POSIX path is still scoped: ${JSON.stringify(scopedPaths)}`)
  assert.deepEqual(scoped.officialCalls, [])
})
