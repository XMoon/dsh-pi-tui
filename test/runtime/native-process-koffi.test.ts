/**
 * The Darwin bridge's ONLY Koffi source: the installed DSH installation.
 *
 * These tests prove the anchor contract without an ambient module path:
 * a fixture DSH installation owns `dsh-subprocess-local`, which owns Koffi;
 * a non-DSH anchor fails closed even when the repository's own node_modules
 * could satisfy `@deepseek-ai/dsh-subprocess-local`; and a child process with
 * a polluted NODE_PATH still reads through the fixture Koffi. The fixture
 * Koffi wrapper records its own load so a resolver that silently loaded the
 * repository's Koffi cannot pass.
 *
 * @module @xmoon76/dsh-pi-tui/native-process-koffi.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { copyKoffiPackage } from '../support/darwin-koffi-fixture.ts'
import { resolveDshKoffi } from '../../src/runtime/native-process/darwin.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const KOFFI_VERSION = JSON.parse(readFileSync(join(dirname(createRequire(import.meta.url).resolve('koffi')), 'package.json'), 'utf8')).version as string
const DARWIN_ONLY = process.platform !== 'darwin' ? 'Darwin kernel process identity requires macOS' : false

interface Fixture {
  readonly root: string
  readonly anchor: string
  readonly marker?: string
}

function writeManifest(directory: string, manifest: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

function writeKoffiOwner(directory: string, declaredVersion = KOFFI_VERSION): void {
  writeManifest(directory, {
    name: '@deepseek-ai/dsh-subprocess-local',
    version: '0.2.2-rc.5',
    dependencies: { koffi: declaredVersion },
  })
}

function writeDsh(directory: string): void {
  writeManifest(directory, { name: '@deepseek-ai/dsh', version: '0.2.2-rc.5' })
}

/** Replace the fixture Koffi with a load-recording wrapper around the real
 * pinned package. A wrong implementation that loads the repository's Koffi
 * directly can therefore never produce the marker. */
function wrapFixtureKoffi(nodeModules: string, marker: string): void {
  const real = join(nodeModules, 'koffi-real')
  renameSync(join(nodeModules, 'koffi'), real)
  writeManifest(join(nodeModules, 'koffi'), { name: 'koffi', version: KOFFI_VERSION, main: 'index.cjs' })
  writeFileSync(join(nodeModules, 'koffi', 'index.cjs'), [
    "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'fixture-koffi-loaded\\n')",
    'module.exports = require(' + JSON.stringify(join(real, 'index.cjs')) + ')',
    '',
  ].join('\n'))
}

function fixture(t: TestContext, options: { subprocess?: boolean; koffi?: boolean; wrapped?: boolean; declaredVersion?: string } = {}): Fixture {
  const { subprocess = true, koffi = true, wrapped = false, declaredVersion = KOFFI_VERSION } = options
  const root = testLifecycle(t).tempDir('dsh-koffi-test-')
  const nodeModules = join(root, 'node_modules')
  const dshDir = join(nodeModules, '@deepseek-ai', 'dsh')
  writeDsh(dshDir)
  if (subprocess) writeKoffiOwner(join(nodeModules, '@deepseek-ai', 'dsh-subprocess-local'), declaredVersion)
  if (subprocess && koffi) copyKoffiPackage(nodeModules)
  let marker: string | undefined
  if (wrapped) {
    marker = join(root, 'koffi-loaded.txt')
    wrapFixtureKoffi(nodeModules, marker)
  }
  return { root, anchor: join(dshDir, 'package.json'), ...(marker === undefined ? {} : { marker }) }
}

/** A DSH package nested below another module root, with its dependency either
 * in the SAME nested node_modules or in a polluted outer node_modules. */
function nestedFixture(t: TestContext, { pollutedAncestor = false } = {}): Fixture {
  const root = testLifecycle(t).tempDir('dsh-koffi-nested-')
  const outerModules = join(root, 'node_modules')
  const nestedModules = join(outerModules, 'outer', 'node_modules')
  const dshDir = join(nestedModules, '@deepseek-ai', 'dsh')
  writeDsh(dshDir)
  if (pollutedAncestor) {
    writeKoffiOwner(join(outerModules, '@deepseek-ai', 'dsh-subprocess-local'))
    copyKoffiPackage(outerModules)
  } else {
    writeKoffiOwner(join(nestedModules, '@deepseek-ai', 'dsh-subprocess-local'))
    copyKoffiPackage(nestedModules)
  }
  return { root, anchor: join(dshDir, 'package.json') }
}

/** A pnpm-style virtual store: packages sit in separate `<name>@<version>`
 * directories under one `.mise` store, with a shared hoisted `node_modules`. */
function pnpmFixture(t: TestContext): Fixture {
  const root = testLifecycle(t).tempDir('dsh-koffi-pnpm-')
  const store = join(root, 'node_modules', '.mise')
  const dshDir = join(store, '@deepseek-ai+dsh@0.2.2-rc.5_a', 'node_modules', '@deepseek-ai', 'dsh')
  const subprocessDir = join(store, '@deepseek-ai+dsh-subprocess-local@0.2.2-rc.5_a', 'node_modules', '@deepseek-ai', 'dsh-subprocess-local')
  writeDsh(dshDir)
  writeKoffiOwner(subprocessDir)
  const hoistedModules = join(store, 'node_modules')
  copyKoffiPackage(hoistedModules)
  mkdirSync(join(hoistedModules, '@deepseek-ai'), { recursive: true })
  symlinkSync(subprocessDir, join(hoistedModules, '@deepseek-ai', 'dsh-subprocess-local'), 'dir')
  return { root, anchor: join(dshDir, 'package.json') }
}

function koffiPackageName(entry: string): string {
  return JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')).name as string
}

function runNativeRead(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const identity = pathToFileURL(join(ROOT, 'src', 'runtime', 'native-process', 'identity.ts')).href
  const script = `import { readKernelProcess } from ${JSON.stringify(identity)}; process.stdout.write(JSON.stringify(readKernelProcess(process.pid)))`
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  })
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}

test('Koffi resolves from the DSH subprocess-local dependency', t => {
  const value = fixture(t)
  const entry = resolveDshKoffi(value.anchor)
  assert.equal(koffiPackageName(entry), 'koffi')
  assert.equal(entry, realpathSync(join(value.root, 'node_modules', 'koffi', 'index.cjs')))
})

test('the owner version string is not a runtime Koffi version gate', t => {
  const value = fixture(t, { declaredVersion: '^999.0.0' })
  assert.equal(koffiPackageName(resolveDshKoffi(value.anchor)), 'koffi')
})

test('a changed owner Koffi version string does not block the real bridge', { skip: DARWIN_ONLY, timeout: 60_000 }, t => {
  const value = fixture(t, { wrapped: true, declaredVersion: '^999.0.0' })
  const read = runNativeRead({ SPLIT_PROCESS_DSH_ANCHOR: value.anchor, NODE_PATH: '' })
  assert.equal(read.status, 0, read.stderr)
  assert.equal(JSON.parse(read.stdout).kind, 'alive')
  assert.ok(value.marker !== undefined && existsSync(value.marker), 'the fixture wrapper must have loaded')
})

test('a non-DSH anchor cannot borrow Koffi from an ancestor node_modules', t => {
  // The TUI's own manifest is NOT a DSH installation, but this checkout does
  // have `@deepseek-ai/dsh-subprocess-local` in its devDependency tree. The
  // name check must reject the anchor before createRequire can walk there.
  assert.throws(() => resolveDshKoffi(join(ROOT, 'package.json')), /DSH anchor/u)
  const value = fixture(t)
  assert.throws(() => resolveDshKoffi(join(value.root, 'package.json')), /DSH anchor/u)
})

test('a DSH installation without the subprocess-local owner or Koffi fails closed', t => {
  const withoutSubprocess = fixture(t, { subprocess: false })
  assert.throws(() => resolveDshKoffi(withoutSubprocess.anchor))
  const withoutKoffi = fixture(t, { koffi: false })
  assert.throws(() => resolveDshKoffi(withoutKoffi.anchor))
})

test('a nested DSH closure resolves its own dependency and rejects an outer hoist', t => {
  const nested = nestedFixture(t)
  assert.equal(koffiPackageName(resolveDshKoffi(nested.anchor)), 'koffi')
  const polluted = nestedFixture(t, { pollutedAncestor: true })
  assert.throws(() => resolveDshKoffi(polluted.anchor), /outside the installed DSH module tree|does not declare/u)
})

test('a pnpm virtual-store DSH closure resolves through its .mise store', t => {
  const value = pnpmFixture(t)
  const entry = resolveDshKoffi(value.anchor)
  assert.equal(koffiPackageName(entry), 'koffi')
  assert.ok(realpathSync(entry).includes(`${join('node_modules', '.mise')}`))
})

test('the real Darwin bridge reads through the fixture anchor, never a polluted NODE_PATH', { skip: DARWIN_ONLY, timeout: 60_000 }, t => {
  const value = fixture(t, { wrapped: true })
  const cleanMarker = value.marker
  assert.ok(cleanMarker !== undefined, 'the wrapped fixture must expose its load marker')
  if (cleanMarker === undefined) return
  assert.equal(existsSync(cleanMarker), false, 'the marker must not exist before the first load')
  const clean = runNativeRead({ SPLIT_PROCESS_DSH_ANCHOR: value.anchor, NODE_PATH: '' })
  assert.equal(clean.status, 0, clean.stderr)
  assert.equal(JSON.parse(clean.stdout).kind, 'alive')
  assert.ok(existsSync(cleanMarker), 'the fixture Koffi wrapper must be the module that actually loaded')

  const badAnchor = runNativeRead({ SPLIT_PROCESS_DSH_ANCHOR: join(ROOT, 'package.json'), NODE_PATH: '' })
  assert.equal(badAnchor.status, 0, badAnchor.stderr)
  assert.deepEqual(JSON.parse(badAnchor.stdout), { kind: 'unknown', code: 'NATIVE_UNAVAILABLE' })

  const polluted = join(value.root, 'polluted')
  mkdirSync(join(polluted, 'node_modules', 'koffi'), { recursive: true })
  writeFileSync(join(polluted, 'node_modules', 'koffi', 'package.json'), `${JSON.stringify({
    name: 'koffi',
    version: '3.3.8',
    main: 'index.cjs',
  })}\n`)
  writeFileSync(join(polluted, 'node_modules', 'koffi', 'index.cjs'), "throw new Error('ambient koffi must not be loaded')\n")
  rmSync(cleanMarker, { force: true })
  const withPollution = runNativeRead({
    SPLIT_PROCESS_DSH_ANCHOR: value.anchor,
    NODE_PATH: join(polluted, 'node_modules'),
  })
  assert.equal(withPollution.status, 0, withPollution.stderr)
  assert.equal(JSON.parse(withPollution.stdout).kind, 'alive')
  assert.ok(existsSync(cleanMarker), 'the fixture Koffi wrapper must still be the loaded module under pollution')
})

test('a Direct launcher entry supplies the DSH anchor through argv', { skip: DARWIN_ONLY, timeout: 60_000 }, t => {
  const value = fixture(t)
  const entry = join(value.root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  mkdirSync(dirname(entry), { recursive: true })
  const scopeModule = pathToFileURL(join(ROOT, 'src', 'app', 'remote-process', 'local-scope.ts')).href
  writeFileSync(entry, `import { readProcessStartDiagnostic } from ${JSON.stringify(scopeModule)}; process.stdout.write(JSON.stringify({ value: readProcessStartDiagnostic() }))\n`)
  const result = spawnSync(process.execPath, [entry], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, SPLIT_PROCESS_DSH_ANCHOR: '', NODE_PATH: '' },
  })
  assert.equal(result.status, 0, result.stderr)
  const observed = JSON.parse(result.stdout) as { value?: string }
  const diagnostic = observed.value
  assert.equal(typeof diagnostic, 'string')
  if (typeof diagnostic !== 'string') return
  assert.match(diagnostic, /^[0-9A-F-]{36}:\d+:\d+\.\d+$/u)
})
