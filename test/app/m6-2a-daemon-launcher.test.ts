/**
 * M6-2A daemon Coordinator: the pure helpers (envelope encode, child
 * environment, installed Client entry resolution) and the single child
 * lifecycle, exercised with an injected fake spawn.
 *
 * Evidence level: structural (L2/L3). It proves the Coordinator's contract, NOT
 * a real spawned Client process — that is the packed split smoke.
 * @module @xmoon76/dsh-pi-tui/m6-2a-daemon-launcher.test
 */

import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { EventEmitter } from 'node:events'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DaemonCoordinator,
  encodeLaunchEnvelope,
  buildChildEnvironment,
  resolveClientEntry,
} from '../../src/app/remote-process/daemon-launcher.ts'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const silentDiag = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {},
} as unknown as Diag

const PROFILE = { name: 'pi-tui', dir: '/home/.dsh/profiles/pi-tui', home: '/home/.dsh', installAnchor: '/x/@deepseek-ai/dsh/package.json', cwd: '/work' }

// ── pure helpers ─────────────────────────────────────────────────────────

test('encodes only the present public launch fields', () => {
  assert.deepEqual(JSON.parse(encodeLaunchEnvelope({})), { version: 1 })
  assert.deepEqual(
    JSON.parse(encodeLaunchEnvelope({ sessionLaunch: { kind: 'continue' }, presetId: 'std' })),
    { version: 1, sessionLaunch: { kind: 'continue' }, presetId: 'std' },
  )
})

test('buildChildEnvironment strips SPLIT_PROCESS_* and role markers, sets the four facts', () => {
  const source: NodeJS.ProcessEnv = {
    SPLIT_PROCESS_CLIENT_RECORD_FILE: '/tmp/x',
    SPLIT_PROCESS_CLIENT_MODE: 'qualification',
    DSH_PI_TUI_ROLE: 'host',
    DSH_PI_TUI_HOST_ENTRY: '/x/local-host.mjs',
    DSH_PI_TUI_BACKEND: 'daemon',
    DSH_PI_TUI_PRESET: 'keep-me',
    PATH: '/usr/bin',
  }
  const env = buildChildEnvironment(PROFILE, 'ENVELOPE', source)
  assert.equal(env.SPLIT_PROCESS_CLIENT_RECORD_FILE, undefined, 'no record file is injected')
  assert.equal(env.DSH_PI_TUI_ROLE, undefined)
  assert.equal(env.DSH_PI_TUI_HOST_ENTRY, undefined)
  assert.equal(env.DSH_PI_TUI_BACKEND, undefined, 'the one-shot selector is not propagated')
  assert.equal(env.SPLIT_PROCESS_DSH_ANCHOR, PROFILE.installAnchor)
  assert.equal(env.SPLIT_PROCESS_PROFILE, 'pi-tui')
  assert.equal(env.SPLIT_PROCESS_CLIENT_MODE, 'surface')
  assert.equal(env.SPLIT_PROCESS_CLIENT_LAUNCH_V1, 'ENVELOPE')
  assert.equal(env.PATH, '/usr/bin', 'the ordinary environment is preserved')
  assert.equal(env.DSH_PI_TUI_PRESET, 'keep-me', 'the preset env is preserved')
})

test('resolveClientEntry requires a real regular dist/local-client.mjs', (t: TestContext) => {
  const life = testLifecycle(t)
  const root = life.tempDir('m62a-pkg-')
  mkdirSync(join(root, 'dist'), { recursive: true })
  const entry = join(root, 'dist', 'local-client.mjs')
  writeFileSync(entry, '')
  assert.equal(resolveClientEntry(root), entry)
  assert.throws(() => resolveClientEntry(join(root, 'nope')), /missing/u)

  const linked = life.tempDir('m62a-link-')
  mkdirSync(join(linked, 'dist'), { recursive: true })
  symlinkSync(entry, join(linked, 'dist', 'local-client.mjs'))
  assert.throws(() => resolveClientEntry(linked), /regular file/u)
})

// ── the single child lifecycle ───────────────────────────────────────────

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kills: NodeJS.Signals[] = []
  kill(signal: NodeJS.Signals): boolean { this.kills.push(signal); return true }
  finish(code: number): void { this.exitCode = code; this.emit('exit', code, null) }
  finishSignal(signal: NodeJS.Signals): void { this.signalCode = signal; this.emit('exit', null, signal) }
}

function fakeSpawn(): { spawnImpl: typeof import('node:child_process').spawn; children: FakeChild[] } {
  const children: FakeChild[] = []
  const spawnImpl = (() => {
    const child = new FakeChild()
    children.push(child)
    return child
  }) as unknown as typeof import('node:child_process').spawn
  return { spawnImpl, children }
}

function coordinator(children: FakeChild[], exitCodes: number[], spawnImpl?: typeof import('node:child_process').spawn): DaemonCoordinator {
  return new DaemonCoordinator({
    spawnImpl: spawnImpl ?? fakeSpawn().spawnImpl,
    entry: '/x/pkg/dist/local-client.mjs',
    env: {},
    appExit: code => { exitCodes.push(code) },
    diag: silentDiag,
  })
}

test('start spawns exactly one child and a zero exit requests exit 0 once', () => {
  const { spawnImpl, children } = fakeSpawn()
  const exitCodes: number[] = []
  const c = coordinator(children, exitCodes, spawnImpl)
  c.start()
  c.start()
  assert.equal(children.length, 1, 'a second start never spawns again')
  assert.equal(c.spawnCount, 1)
  children[0].finish(0)
  children[0].finish(0)
  assert.deepEqual(exitCodes, [0], 'the exit is settled exactly once')
})

test('a signalled child maps to 128+signal', () => {
  const { spawnImpl, children } = fakeSpawn()
  const exitCodes: number[] = []
  const c = coordinator(children, exitCodes, spawnImpl)
  c.start()
  children[0].finishSignal('SIGSEGV')
  assert.deepEqual(exitCodes, [128 + 11])
})

test('a nonzero child exit maps to that code', () => {
  const { spawnImpl, children } = fakeSpawn()
  const exitCodes: number[] = []
  const c = coordinator(children, exitCodes, spawnImpl)
  c.start()
  children[0].finish(3)
  assert.deepEqual(exitCodes, [3])
})

test('a spawn throw fails closed with exit 1 and one sanitized fatal line', () => {
  const exitCodes: number[] = []
  const fatalLines: string[] = []
  const spawnError = Object.assign(new Error('spawn failed at /home/secret/dsh/lib/bin.js for http://10.0.0.1/x'), { code: 'ENOENT' })
  const spawnImpl = (() => { throw spawnError }) as unknown as typeof import('node:child_process').spawn
  const c = new DaemonCoordinator({ spawnImpl, entry: '/x/pkg/dist/local-client.mjs', env: {}, appExit: code => { exitCodes.push(code) }, diag: silentDiag, reportFatal: line => { fatalLines.push(line) } })
  c.start()
  assert.deepEqual(exitCodes, [1])
  assert.equal(fatalLines.length, 1, 'exactly one fatal line')
  // R2-01: a safe errno name is allowed; the raw message/path/url is NOT.
  assert.match(fatalLines[0], /could not start the daemon Client process \(ENOENT\)/u)
  assert.ok(!fatalLines[0].includes('/home/secret') && !fatalLines[0].includes('10.0.0.1'), 'no path or URL leaks')
})

test('dispose before start cancels the spawn', () => {
  const { spawnImpl, children } = fakeSpawn()
  const exitCodes: number[] = []
  const c = coordinator(children, exitCodes, spawnImpl)
  c.dispose()
  c.start()
  assert.equal(children.length, 0, 'a disposed coordinator never spawns')
  assert.deepEqual(exitCodes, [])
})

test('dispose after start asks the live child to stop once, without a second exit', () => {
  const { spawnImpl, children } = fakeSpawn()
  const exitCodes: number[] = []
  const c = coordinator(children, exitCodes, spawnImpl)
  c.start()
  c.dispose()
  c.dispose()
  assert.deepEqual(children[0].kills, ['SIGTERM'], 'the live child is asked to stop exactly once')
  assert.deepEqual(exitCodes, [], 'dispose does not itself re-exit')
})

test('the Coordinator installs no second SIGTERM/SIGINT handler (single stop owner)', () => {
  const { spawnImpl, children } = fakeSpawn()
  const exitCodes: number[] = []
  const c = coordinator(children, exitCodes, spawnImpl)
  const sigtermBefore = process.listenerCount('SIGTERM')
  const sigintBefore = process.listenerCount('SIGINT')
  c.start()
  // Disposal is the SINGLE stop owner (driven by the row's fiber disposal on the
  // official shutdown path); the Coordinator adds no competing signal handler.
  assert.equal(process.listenerCount('SIGTERM'), sigtermBefore, 'no extra SIGTERM handler')
  assert.equal(process.listenerCount('SIGINT'), sigintBefore, 'no extra SIGINT handler')
  c.dispose()
  assert.deepEqual(children[0].kills, ['SIGTERM'], 'the single owner asks the live child to stop once')
})
