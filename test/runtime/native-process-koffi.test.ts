/**
 * The Darwin bridge's ONLY Koffi source: the installed DSH installation.
 *
 * These tests prove the anchor contract without an ambient module path:
 * a fixture DSH installation owns `dsh-subprocess-local`, which owns Koffi;
 * a non-DSH anchor fails closed even when the repository's own node_modules
 * could satisfy `@deepseek-ai/dsh-subprocess-local`; and a child process with
 * a polluted NODE_PATH still reads through the fixture Koffi.
 *
 * @module @xmoon76/dsh-pi-tui/native-process-koffi.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test, { type TestContext } from 'node:test'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { copyKoffiPackage } from '../support/darwin-koffi-fixture.ts'
import { resolveDshKoffi } from '../../src/runtime/native-process/darwin.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DARWIN_ONLY = process.platform !== 'darwin' ? 'the real Darwin bridge requires macOS' : false

interface Fixture {
  readonly root: string
  readonly anchor: string
}

function fixture(t: TestContext, options: { subprocess?: boolean; koffi?: boolean } = {}): Fixture {
  const { subprocess = true, koffi = true } = options
  const root = testLifecycle(t).tempDir('dsh-koffi-test-')
  const dshDir = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dshDir, { recursive: true })
  writeFileSync(join(dshDir, 'package.json'), `${JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.2.2-rc.5',
  }, null, 2)}\n`)
  if (subprocess) {
    const subprocessDir = join(root, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local')
    mkdirSync(subprocessDir, { recursive: true })
    writeFileSync(join(subprocessDir, 'package.json'), `${JSON.stringify({
      name: '@deepseek-ai/dsh-subprocess-local',
      version: '0.2.2-rc.5',
      dependencies: { koffi: '3.1.1' },
    }, null, 2)}\n`)
  }
  if (subprocess && koffi) {
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    copyKoffiPackage(join(root, 'node_modules'))
  }
  return { root, anchor: join(dshDir, 'package.json') }
}

function koffiVersion(entry: string): string {
  return JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')).version as string
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
  assert.equal(koffiVersion(entry), '3.1.1')
  assert.equal(entry, realpathSync(join(value.root, 'node_modules', 'koffi', 'index.cjs')))
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

test('the real Darwin bridge reads through the fixture anchor, never a polluted NODE_PATH', { skip: DARWIN_ONLY, timeout: 60_000 }, t => {
  const value = fixture(t)
  const clean = runNativeRead({ SPLIT_PROCESS_DSH_ANCHOR: value.anchor, NODE_PATH: '' })
  assert.equal(clean.status, 0, clean.stderr)
  assert.equal(JSON.parse(clean.stdout).kind, 'alive')

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
  const withPollution = runNativeRead({
    SPLIT_PROCESS_DSH_ANCHOR: value.anchor,
    NODE_PATH: join(polluted, 'node_modules'),
  })
  assert.equal(withPollution.status, 0, withPollution.stderr)
  assert.equal(JSON.parse(withPollution.stdout).kind, 'alive')
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
