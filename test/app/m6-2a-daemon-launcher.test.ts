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

test('a spawn throw fails closed with exit 1', () => {
  const exitCodes: number[] = []
  const spawnImpl = (() => { throw new Error('boom') }) as unknown as typeof import('node:child_process').spawn
  const c = coordinator([], exitCodes, spawnImpl)
  c.start()
  assert.deepEqual(exitCodes, [1])
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

test('a parent-only SIGTERM is forwarded to a live child once and cleaned up', () => {
  const { spawnImpl, children } = fakeSpawn()
  const exitCodes: number[] = []
  const c = coordinator(children, exitCodes, spawnImpl)
  const before = process.listenerCount('SIGTERM')
  c.start()
  assert.equal(process.listenerCount('SIGTERM'), before + 1)
  process.emit('SIGTERM')
  assert.deepEqual(children[0].kills, ['SIGTERM'])
  c.dispose()
  assert.equal(process.listenerCount('SIGTERM'), before, 'the forwarded handler is removed on dispose')
})
