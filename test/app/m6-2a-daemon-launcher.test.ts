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
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  DaemonControlRunner,
  DaemonCoordinator,
  encodeLaunchEnvelope,
  buildChildEnvironment,
  resolveClientEntry,
  writeQualificationDump,
  createLoaderDumpScheduler,
} from '../../src/app/remote-process/daemon-launcher.ts'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const silentDiag = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {},
} as unknown as Diag

const PROFILE = { name: 'pi-tui', dir: '/home/.dsh/profiles/pi-tui', home: '/home/.dsh', installAnchor: '/x/@deepseek-ai/dsh/package.json', cwd: '/work' }

// ── pure helpers ─────────────────────────────────────────────────────────

test('encodes only the present public launch fields', () => {
  assert.deepEqual(JSON.parse(encodeLaunchEnvelope({ kind: 'client' })), { version: 1 })
  assert.deepEqual(
    JSON.parse(encodeLaunchEnvelope({ kind: 'client', sessionLaunch: { kind: 'continue' }, presetId: 'std' })),
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

test('resolveClientEntry keeps the named dist entry for legal shared-store and symlinked layouts', (t: TestContext) => {
  const life = testLifecycle(t)
  const root = life.tempDir('m62a-pkg-')
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.5.4' }))
  const entry = join(root, 'dist', 'local-client.mjs')
  writeFileSync(entry, 'export {}\n')
  assert.equal(resolveClientEntry(root), entry)
  assert.throws(() => resolveClientEntry(join(root, 'nope')), /missing/u)

  // A symlinked entry file inside this package keeps the NAMED entry path so the
  // spawned Client can locate this package root from its invoked path.
  const shared = join(root, 'dist', 'shared-client.mjs')
  writeFileSync(shared, 'export {}\n')
  unlinkSync(entry)
  symlinkSync(shared, entry)
  assert.equal(resolveClientEntry(root), entry)

  // A shared build directory outside the package is a legal installed layout:
  // the named entry under <root>/dist still resolves <root>/package.json.
  const externalRoot = life.tempDir('m62a-external-root-')
  writeFileSync(join(externalRoot, 'package.json'), JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.5.4' }))
  const externalDist = life.tempDir('m62a-shared-dist-')
  writeFileSync(join(externalDist, 'local-client.mjs'), 'export {}\n')
  symlinkSync(externalDist, join(externalRoot, 'dist'))
  assert.equal(resolveClientEntry(externalRoot), join(externalRoot, 'dist', 'local-client.mjs'))

  // A directory that merely carries the entry NAME is not a regular file.
  const directory = life.tempDir('m62a-dir-')
  mkdirSync(join(directory, 'dist', 'local-client.mjs'), { recursive: true })
  assert.throws(() => resolveClientEntry(directory), /regular file/u)
})

test('a real child process locates the package root from a symlinked dist invoked path', (t: TestContext) => {
  const life = testLifecycle(t)
  const root = life.tempDir('m62a-child-root-')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.5.4' }))
  const externalDist = life.tempDir('m62a-child-dist-')
  const helperUrl = pathToFileURL(join(ROOT, 'src', 'app', 'remote-process', 'local-scope.ts')).href
  writeFileSync(join(externalDist, 'probe.mjs'), [
    `import { installedPackageRootFromEntry } from ${JSON.stringify(helperUrl)}`,
    `import { fileURLToPath, pathToFileURL } from 'node:url'`,
    `process.stdout.write(installedPackageRootFromEntry(pathToFileURL(process.argv[1]).href))`,
    '',
  ].join('\n'))
  symlinkSync(externalDist, join(root, 'dist'))
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', join(root, 'dist', 'probe.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  })
  assert.equal(result.status, 0, `the probe failed: ${result.stderr}`)
  assert.equal(result.stdout, realpathSync(root), 'the invoked symlinked entry must locate THIS package root')
})

// ── the single child lifecycle ───────────────────────────────────────────

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  readonly kills: NodeJS.Signals[] = []
  autoExitSignal: NodeJS.Signals | undefined
  kill(signal: NodeJS.Signals): boolean {
    this.kills.push(signal)
    if (this.autoExitSignal === signal && this.exitCode === null && this.signalCode === null) {
      this.exitCode = signal === 'SIGKILL' ? 1 : 0
      setImmediate(() => this.emit('exit', this.exitCode, null))
    }
    return true
  }
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

function coordinator(children: FakeChild[], exitCodes: number[], spawnImpl?: typeof import('node:child_process').spawn, extra: Record<string, unknown> = {}): DaemonCoordinator {
  return new DaemonCoordinator({
    spawnImpl: spawnImpl ?? fakeSpawn().spawnImpl,
    entry: '/x/pkg/dist/local-client.mjs',
    env: {},
    appExit: code => { exitCodes.push(code) },
    diag: silentDiag,
    ...extra,
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

test('dispose after start asks the live child to stop once and resolves after its exit', async () => {
  const { spawnImpl, children } = fakeSpawn()
  const exitCodes: number[] = []
  const c = coordinator(children, exitCodes, spawnImpl)
  c.start()
  children[0].autoExitSignal = 'SIGTERM'
  assert.equal(await c.dispose(), true)
  assert.equal(await c.dispose(), true)
  assert.deepEqual(children[0].kills, ['SIGTERM'], 'the live child is asked to stop exactly once')
})

test('dispose escalates to SIGKILL within the SAME budget when SIGTERM does not stop the child', async () => {
  const { spawnImpl, children } = fakeSpawn()
  const exitCodes: number[] = []
  const c = coordinator(children, exitCodes, spawnImpl, { shutdownBudgetMs: 80 })
  c.start()
  children[0].autoExitSignal = 'SIGKILL' // only SIGKILL triggers the exit
  assert.equal(await c.dispose(), true)
  assert.deepEqual(children[0].kills, ['SIGTERM', 'SIGKILL'], 'escalates to SIGKILL inside the budget')
})

test('dispose does NOT resolve until the child has actually exited', async () => {
  const { spawnImpl, children } = fakeSpawn()
  const exitCodes: number[] = []
  const c = coordinator(children, exitCodes, spawnImpl, { shutdownBudgetMs: 3000 })
  c.start()
  let resolved = false
  let value: boolean | undefined
  const pending = c.dispose().then(v => { resolved = true; value = v; return v })
  await sleep(60)
  assert.equal(resolved, false, 'dispose must stay pending while the child is still alive')
  children[0].finish(0)
  assert.equal(await pending, true)
  assert.equal(value, true)
})

test('an unresponsive child is an ABNORMAL cleanup result, never success', async () => {
  const { spawnImpl, children } = fakeSpawn()
  const exitCodes: number[] = []
  const fatalLines: string[] = []
  const c = coordinator(children, exitCodes, spawnImpl, { shutdownBudgetMs: 60, reportFatal: (line: string) => { fatalLines.push(line) } })
  c.start()
  children[0].autoExitSignal = undefined // ignores SIGTERM and SIGKILL forever
  assert.equal(await c.dispose(), false, 'an unconfirmed exit must NOT resolve as success')
  assert.deepEqual(children[0].kills, ['SIGTERM', 'SIGKILL'], 'the whole budget is used, then SIGKILL')
  assert.equal(fatalLines.length, 1)
  assert.match(fatalLines[0], /did not exit after SIGKILL/u)
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

// ── R7-01: qualification dump file safety + lifecycle ────────────────────

test('writeQualificationDump refuses a relative path', () => {
  assert.throws(() => writeQualificationDump('relative/dump.json', 'x'), /absolute/u)
})

test('writeQualificationDump writes a fresh 0600 file into an owned private dir', (t: TestContext) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('m62a-dump-')
  const target = join(dir, 'dump.json')
  writeQualificationDump(target, '[{"id":"session"}]')
  assert.equal(readFileSync(target, 'utf8'), '[{"id":"session"}]')
  assert.equal(statSync(target).mode & 0o777, 0o600)
})

test('writeQualificationDump NEVER overwrites an existing file', (t: TestContext) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('m62a-dump-existing-')
  const target = join(dir, 'dump.json')
  writeFileSync(target, 'ORIGINAL', { mode: 0o600 })
  assert.throws(() => writeQualificationDump(target, 'OVERWRITE'), /already exists/u)
  assert.equal(readFileSync(target, 'utf8'), 'ORIGINAL', 'the existing file must be untouched')
})

test('writeQualificationDump refuses a symlink target (no follow)', (t: TestContext) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('m62a-dump-symlink-')
  const real = join(dir, 'real.json')
  writeFileSync(real, 'REAL', { mode: 0o600 })
  const link = join(dir, 'link.json')
  symlinkSync(real, link)
  assert.throws(() => writeQualificationDump(link, 'X'))
  assert.equal(readFileSync(real, 'utf8'), 'REAL', 'the symlink target must be untouched')
})

test('a disposed LoaderDumpScheduler never writes (timers cancelled)', async () => {
  const writes: string[] = []
  const scheduler = createLoaderDumpScheduler(() => 'PAYLOAD', text => { writes.push(text) })
  scheduler.schedule(20)
  scheduler.dispose()
  await sleep(60)
  assert.deepEqual(writes, [], 'dispose must cancel the scheduled write')
  scheduler.flush()
  assert.deepEqual(writes, [], 'flush after dispose must not write')
})

test('a live LoaderDumpScheduler writes exactly once', async () => {
  const writes: string[] = []
  const scheduler = createLoaderDumpScheduler(() => 'PAYLOAD', text => { writes.push(text) })
  scheduler.schedule(10)
  scheduler.schedule(10)
  await sleep(60)
  scheduler.flush()
  assert.deepEqual(writes, ['PAYLOAD'], 'only ONE dump is written')
})

// ── the management operation lifecycle ───────────────────────────────────

test('a management operation writes its output and requests appExit exactly once', async () => {
  const exitCodes: number[] = []
  const stdout: string[] = []
  const stderr: string[] = []
  let exited: (() => void) | undefined
  const settled = new Promise<void>(resolve => { exited = resolve })
  const runner = new DaemonControlRunner({
    run: async () => ({ code: 0, stdout: 'profile=pi-tui\n', stderr: 'note\n' }),
    appExit: code => { exitCodes.push(code); exited?.() },
    writeStdout: text => { stdout.push(text) },
    writeStderr: text => { stderr.push(text) },
  })
  runner.start()
  runner.start()
  await settled
  assert.equal(runner.runCount, 1, 'a second start never runs another operation')
  assert.deepEqual(stdout, ['profile=pi-tui\n'])
  assert.deepEqual(stderr, ['note\n'])
  assert.deepEqual(exitCodes, [0])
  assert.equal(await runner.dispose(), true)
})

test('a disposed management runner suppresses a late result and never exits', async () => {
  const exitCodes: number[] = []
  let release: ((value: { code: number; stdout: string; stderr: string }) => void) | undefined
  const runner = new DaemonControlRunner({
    run: () => new Promise(resolve => { release = resolve }),
    appExit: code => { exitCodes.push(code) },
    writeStdout: () => {},
    writeStderr: () => {},
    shutdownBudgetMs: 10,
  })
  runner.start()
  const disposed = await runner.dispose()
  release?.({ code: 0, stdout: 'late\n', stderr: '' })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(disposed, false, 'an unsettled operation is reported as an abnormal shutdown wait')
  assert.deepEqual(exitCodes, [], 'a late result must not request an exit after disposal')
})

test('an unexpected management throw is a sanitized non-zero failure', async () => {
  const exitCodes: number[] = []
  const stderr: string[] = []
  let exited: (() => void) | undefined
  const settled = new Promise<void>(resolve => { exited = resolve })
  const runner = new DaemonControlRunner({
    run: async () => { throw new Error('raw secret at /home/u/.dsh') },
    appExit: code => { exitCodes.push(code); exited?.() },
    writeStdout: () => {},
    writeStderr: text => { stderr.push(text) },
  })
  runner.start()
  await settled
  assert.deepEqual(exitCodes, [4])
  assert.match(stderr.join(''), /MANAGER_OR_OS_FAILURE/u)
  assert.doesNotMatch(stderr.join(''), /raw secret|\/home\/u/u)
})
