/**
 * Daemon management control plane: the read-only status classification, the
 * fixed error/exit taxonomy, the explicit install/stop/restart/uninstall
 * actions and the log source rules, exercised with injected OS/discovery seams.
 *
 * Evidence level: structural (L1-L3). These prove the control module's
 * source -> decision -> sink contract; the real systemd/independent-process OS
 * evidence lives in the selectable split-process lane, never here.
 * @module @xmoon76/dsh-pi-tui/daemon-control.test
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  bindDarwinKernelSeat,
  darwinHostProfileSeatDir,
  inspectInstalledProfileScope,
  LOCAL_PROTOCOL,
  LocalScopeError,
  readLinuxStarttime,
  type LocalScope,
} from '../../src/app/remote-process/local-scope.ts'
import {
  buildUnitName,
  collectUnitFacts,
  profileIdentityDigest,
  renderUnitContent,
  type SystemctlResult,
} from '../../src/app/remote-process/local-host-manager.ts'
import {
  buildLaunchdLabel,
  launchdLogPaths,
  launchdPlistName,
  renderLaunchdPlist,
  type LaunchctlResult,
  type LaunchctlRunner,
  type LaunchdUnitFacts,
} from '../../src/app/remote-process/local-host-launchd.ts'
import {
  formatDaemonStatus,
  journalctlArgs,
  runDaemonControl,
  sanitizeLogText,
  type DaemonControlDeps,
  type DaemonControlProfile,
} from '../../src/app/remote-process/local-daemon-control.ts'
import type {
  DarwinLocalInstanceRecord,
  LinuxLocalInstanceRecord,
  LocalInstanceRecord,
} from '../../src/app/remote-process/local-discovery.ts'
import type { DarwinKernelProcessIdentity, KernelObservation } from '../../src/runtime/native-process/identity.ts'

const DSH_VERSION = '0.2.2-rc.3'
const UUID = '11111111-1111-4111-8111-111111111111'

function exited(code: number, stdout = '', stderr = ''): SystemctlResult {
  return { kind: 'exited', code, stdout, stderr }
}

interface Fixture {
  readonly profile: DaemonControlProfile
  readonly scope: LocalScope
  readonly unitDir: string
  readonly unitName: string
  /** Test account home for the Darwin admin seat (production resolves the OS
   *  account home, never `$HOME`/`DSH_HOME`). */
  readonly accountHome: string
}

function fixture(t: TestContext): Fixture {
  const root = testLifecycle(t).tempDir('m62c-control-')
  const home = join(root, 'dsh-home')
  const profileDir = join(root, 'profiles', 'pi-tui')
  const packageRoot = join(root, 'package')
  const anchor = join(root, 'dsh', 'package.json')
  const accountHome = join(root, 'account-home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(packageRoot, 'dist'), { recursive: true, mode: 0o700 })
  mkdirSync(join(root, 'dsh'), { recursive: true, mode: 0o700 })
  mkdirSync(accountHome, { recursive: true, mode: 0o700 })
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version: '0.5.7' })}\n`)
  writeFileSync(join(packageRoot, 'dist', 'index.mjs'), 'export const value = 1\n')
  writeFileSync(join(packageRoot, 'dist', 'local-host.mjs'), 'process.exit(0)\n')
  writeFileSync(anchor, `${JSON.stringify({ name: '@deepseek-ai/dsh', version: DSH_VERSION })}\n`, { mode: 0o644 })
  const profile: DaemonControlProfile = {
    name: 'pi-tui',
    dir: profileDir,
    home,
    installAnchor: anchor,
    packageRoot,
    dshVersion: DSH_VERSION,
  }
  const scope = inspectInstalledProfileScope({ dshHome: home, profileDir, packageRoot, dshVersion: DSH_VERSION })
  const unitDir = join(root, 'user-units')
  mkdirSync(unitDir, { recursive: true, mode: 0o700 })
  return { profile, scope, unitDir, unitName: buildUnitName(profile.name, scope.scopeId), accountHome }
}

function recordOf(scope: LocalScope, overrides: Partial<LinuxLocalInstanceRecord> = {}): LinuxLocalInstanceRecord {
  return {
    schema: 1,
    scopeId: scope.scopeId,
    profileRealpath: scope.profileRealpath,
    instanceId: UUID,
    hostPid: 4242,
    hostStarttime: '12345',
    origin: 'http://127.0.0.1:4517',
    protocol: LOCAL_PROTOCOL,
    bundleVersion: scope.bundleVersion,
    dshVersion: scope.dshVersion,
    buildId: scope.buildId,
    ...overrides,
  }
}

/** One structurally valid Darwin kernel identity for a synthetic Host PID. */
function darwinIdentityOf(pid: number, overrides: Partial<DarwinKernelProcessIdentity> = {}): DarwinKernelProcessIdentity {
  return {
    platform: 'darwin',
    pid,
    bootUUID: '11111111-1111-4111-8111-111111111111',
    uniqueId: '9001',
    parentUniqueId: '1',
    processUUID: '22222222222222222222222222222222',
    startSec: '1700000000',
    startUsec: '123456',
    ppid: 1,
    pgid: pid,
    sid: pid,
    uid: process.getuid?.() ?? 501,
    state: 2,
    ...overrides,
  }
}

function darwinRecordOf(scope: LocalScope, overrides: Partial<DarwinLocalInstanceRecord> = {}): DarwinLocalInstanceRecord {
  const hostPid = overrides.hostPid ?? 4242
  return {
    schema: 2,
    scopeId: scope.scopeId,
    profileRealpath: scope.profileRealpath,
    instanceId: UUID,
    hostPid,
    origin: 'http://127.0.0.1:4517',
    protocol: LOCAL_PROTOCOL,
    bundleVersion: scope.bundleVersion,
    dshVersion: scope.dshVersion,
    buildId: scope.buildId,
    hostKernelIdentity: darwinIdentityOf(hostPid),
    ...overrides,
  }
}

function writeOwnedUnit(fx: Fixture): { readonly path: string; readonly content: string } {
  const content = renderUnitContent({
    dshHome: fx.scope.dshHome,
    profileRealpath: fx.scope.profileRealpath,
    profile: fx.profile.name,
    scopeId: fx.scope.scopeId,
    buildId: fx.scope.buildId,
    nodePath: process.execPath,
    hostEntryPath: join(fx.profile.packageRoot, 'dist', 'local-host.mjs'),
    dshAnchor: fx.profile.installAnchor,
  })
  const path = join(fx.unitDir, fx.unitName)
  writeFileSync(path, content, { mode: 0o600 })
  return { path, content }
}

interface UnitState {
  loadState?: string
  activeState?: string
  mainPid?: number
  unitFileState?: string
  fragmentPath?: string
  stopResult?: SystemctlResult
  reloadResult?: SystemctlResult
  unitPathResult?: SystemctlResult
}

function unitSystemctl(path: string, initial: UnitState = {}) {
  const state = {
    loadState: initial.loadState ?? 'loaded',
    activeState: initial.activeState ?? 'active',
    mainPid: initial.mainPid ?? 4242,
    unitFileState: initial.unitFileState ?? 'disabled',
  }
  const calls: string[][] = []
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    calls.push([...args])
    if (args.includes('UnitPath')) {
      return initial.unitPathResult ?? exited(0, join(path, '..'))
    }
    if (args.includes('daemon-reload')) return initial.reloadResult ?? exited(0)
    if (args.includes('stop')) {
      if (initial.stopResult !== undefined) return initial.stopResult
      state.activeState = 'inactive'
      state.mainPid = 0
      return exited(0)
    }
    if (args.includes('start')) return exited(0)
    if (args.includes('show')) {
      return exited(0, [
        `LoadState=${state.loadState}`,
        `ActiveState=${state.activeState}`,
        `FragmentPath=${state.loadState === 'not-found' ? '' : (initial.fragmentPath ?? path)}`,
        'DropInPaths=',
        `MainPID=${String(state.mainPid)}`,
        `UnitFileState=${state.unitFileState}`,
        '',
      ].join('\n'))
    }
    return exited(0)
  }
  return { run, calls }
}

function depsOf(fx: Fixture, overrides: Partial<DaemonControlDeps> = {}): DaemonControlDeps {
  return {
    platform: 'linux',
    uid: process.getuid?.() ?? 1000,
    unitDir: fx.unitDir,
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
    ...overrides,
  }
}

function darwinDepsOf(fx: Fixture, overrides: Partial<DaemonControlDeps> = {}): DaemonControlDeps {
  return {
    platform: 'darwin',
    uid: process.getuid?.() ?? 1000,
    unitDir: fx.unitDir,
    darwinAccountHome: fx.accountHome,
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
    ...overrides,
  }
}

const UID = process.getuid?.() ?? 1000

/** The same validated launchd facts the Darwin management path derives. */
function launchdFactsOf(fx: Fixture): LaunchdUnitFacts {
  const base = collectUnitFacts({
    scope: fx.scope,
    hostEntryPath: join(fx.profile.packageRoot, 'dist', 'local-host.mjs'),
    dshAnchor: fx.profile.installAnchor,
    profile: fx.profile.name,
  })
  return {
    ...base,
    scopeDir: fx.scope.dir,
    profileIdentity: profileIdentityDigest(fx.scope.profileRealpath),
  }
}

function launchdPlistPathOf(fx: Fixture): string {
  return join(fx.accountHome, 'Library', 'LaunchAgents', launchdPlistName(fx.scope.scopeId))
}

function writeOwnedLaunchd(fx: Fixture): { readonly path: string; readonly content: string; readonly facts: LaunchdUnitFacts } {
  const facts = launchdFactsOf(fx)
  const path = launchdPlistPathOf(fx)
  mkdirSync(join(fx.accountHome, 'Library', 'LaunchAgents'), { recursive: true, mode: 0o700 })
  const content = renderLaunchdPlist(facts)
  writeFileSync(path, content, { mode: 0o600 })
  return { path, content, facts }
}

function exitedLaunchctl(code: number, stdout = '', stderr = ''): LaunchctlResult {
  return { kind: 'exited', code, stdout, stderr }
}

interface FakeLaunchdJob {
  loaded: boolean
  state: string
  pid?: number
  path: string
  program: string
  arguments: readonly string[]
  workingDirectory: string
  stdoutPath: string
  stderrPath: string
  environment: Readonly<Record<string, string>>
}

interface FakeLaunchdOptions {
  loaded?: boolean
  state?: string
  pid?: number
  path?: string
  program?: string
  arguments?: readonly string[]
  workingDirectory?: string
  stdoutPath?: string
  stderrPath?: string
  environment?: Readonly<Record<string, string>>
  domainCode?: number
  onBootout?: () => void
}

/** One real-format `launchctl print` answer for the narrow structural seam. */
function launchdPrint(fx: Fixture, job: FakeLaunchdJob): string {
  const label = buildLaunchdLabel(fx.scope.scopeId)
  const args = job.arguments.map(value => `\t\t${value}`).join('\n')
  const env = Object.entries(job.environment).map(([key, value]) => `\t\t${key} => ${value}`).join('\n')
  return [
    `gui/${String(UID)}/${label} = {`,
    '\tactive count = 1',
    `\tpath = ${job.path}`,
    '\ttype = LaunchAgent',
    `\tstate = ${job.state}`,
    '',
    `\tprogram = ${job.program}`,
    '\targuments = {',
    args,
    '\t}',
    '',
    `\tworking directory = ${job.workingDirectory}`,
    '',
    `\tstdout path = ${job.stdoutPath}`,
    `\tstderr path = ${job.stderrPath}`,
    '',
    '\tenvironment = {',
    env,
    '\t}',
    '',
    ...(job.pid === undefined ? [] : [`\tpid = ${String(job.pid)}`]),
    '\truns = 1',
    '\tlast exit code = (never exited)',
    '\tproperties = partial import | inferred program',
    '}',
    '',
  ].join('\n')
}

function fakeLaunchd(fx: Fixture, options: FakeLaunchdOptions = {}) {
  const facts = launchdFactsOf(fx)
  const logs = launchdLogPaths(facts.scopeDir)
  const label = buildLaunchdLabel(fx.scope.scopeId)
  const job: FakeLaunchdJob = {
    loaded: options.loaded ?? false,
    state: options.state ?? 'not running',
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    path: options.path ?? launchdPlistPathOf(fx),
    program: options.program ?? facts.nodePath,
    arguments: options.arguments ?? [facts.nodePath, facts.hostEntryPath],
    workingDirectory: options.workingDirectory ?? facts.profileRealpath,
    stdoutPath: options.stdoutPath ?? logs.stdout,
    stderrPath: options.stderrPath ?? logs.stderr,
    environment: options.environment ?? {
      DSH_HOME: facts.dshHome,
      SPLIT_PROCESS_DSH_ANCHOR: facts.dshAnchor,
      SPLIT_PROCESS_PROFILE: facts.profile,
    },
  }
  const calls: string[][] = []
  const run: LaunchctlRunner = async args => {
    calls.push([...args])
    if (args[0] === 'print' && args[1] === `gui/${String(UID)}`) {
      return (options.domainCode ?? 0) === 0 ? exitedLaunchctl(0, `gui/${String(UID)} = {\n}\n`) : exitedLaunchctl(options.domainCode as number, '', 'domain unavailable')
    }
    if (args[0] === 'print' && args[1] === `gui/${String(UID)}/${label}`) {
      return job.loaded ? exitedLaunchctl(0, launchdPrint(fx, job)) : exitedLaunchctl(113, '', `Could not find service "${label}"`)
    }
    if (args[0] === 'bootstrap') {
      job.loaded = true
      job.state = 'not running'
      delete job.pid
      return exitedLaunchctl(0)
    }
    if (args[0] === 'kickstart') {
      job.loaded = true
      job.state = 'running'
      job.pid = 4242
      return exitedLaunchctl(0)
    }
    if (args[0] === 'bootout') {
      if (!job.loaded) return exitedLaunchctl(3, '', 'No such process')
      job.loaded = false
      job.state = 'not running'
      delete job.pid
      options.onBootout?.()
      return exitedLaunchctl(0)
    }
    return exitedLaunchctl(2, '', 'unexpected launchctl verb')
  }
  return { run, calls, job }
}

function assertCode(result: { code: number; stdout: string; stderr: string }, code: number, pattern?: RegExp): void {
  assert.equal(result.code, code, `expected exit ${String(code)}, got ${String(result.code)}; stderr=${result.stderr}`)
  if (pattern !== undefined) assert.match(`${result.stdout}${result.stderr}`, pattern)
}

// ── status: read-only classification ────────────────────────────────────────

test('status with no Host and no unit reports stopped and never queries the manager', async t => {
  const fx = fixture(t)
  const systemctl = unitSystemctl(join(fx.unitDir, fx.unitName))
  assert.equal(existsSync(fx.scope.dir), false, 'the fixture must start without a run directory')
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, { systemctl: systemctl.run }))
  assertCode(result, 0)
  assert.match(result.stdout, /^profile=pi-tui$/mu)
  assert.match(result.stdout, /^manager=unmanaged$/mu)
  assert.match(result.stdout, /^user-manager=not-checked$/mu)
  assert.match(result.stdout, /^host=stopped$/mu)
  assert.match(result.stdout, /^unit=none$/mu)
  assert.match(result.stdout, /^unit-state=not-found$/mu)
  assert.match(result.stdout, /^compatibility=none$/mu)
  assert.equal(existsSync(fx.scope.dir), false, 'status must never create the scope run directory')
  assert.deepEqual(systemctl.calls, [], 'no installed unit means NO systemctl call at all')
})

test('an active unit without an authenticated Host reports starting, never ready', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: 9001 })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, { systemctl: systemctl.run }))
  assertCode(result, 0)
  assert.match(result.stdout, /^host=starting$/mu)
  assert.match(result.stdout, /^manager=unmanaged$/mu)
  assert.match(result.stdout, /^unit-state=active$/mu)
  assert.match(result.stdout, /^user-manager=available$/mu)
  assert.doesNotMatch(result.stdout, /^host=ready$/mu)
})

test('status treats a unit file the manager has not loaded as an installed but unloaded unit', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { loadState: 'not-found', activeState: 'inactive', mainPid: 0 })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, { systemctl: systemctl.run }))
  assertCode(result, 0)
  assert.match(result.stdout, /^user-manager=available$/mu)
  assert.match(result.stdout, /^unit-state=not-found$/mu)
  assert.match(result.stdout, /^manager=unmanaged$/mu, 'an unloaded file is not systemd supervision')
  assert.match(result.stdout, /^host=stopped$/mu)
  assert.equal(existsSync(unit.path), true)
})

test('status reports an authenticated Host under a deactivating unit as uncertain, never success', { skip: process.platform !== 'linux' ? 'Linux systemd user-unit tests require Linux' : false }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { activeState: 'deactivating', mainPid: record.hostPid })
  const status = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(status, 5, /TRANSITION_UNCERTAIN/u)
  assert.match(status.stdout, /^host=ready$/mu, 'the authenticated readiness stays truthful')
  assert.match(status.stdout, /^manager=unmanaged$/mu, 'a retiring unit cannot prove independent-process supervision')
  // start must NOT reuse a Host the manager is retiring, and must not start one.
  let ensured = 0
  const start = await runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    ensureHost: async () => { ensured += 1; throw new Error('must not start past an uncertain transition') },
  }))
  assert(start.code !== 0, `start must refuse an uncertain unit transition, saw ${String(start.code)}`)
  assert(/TRANSITION_UNCERTAIN/u.test(`${start.stdout}${start.stderr}`), 'start must carry the stable uncertain code')
  assert.equal(ensured, 0)
  assert.equal(existsSync(unit.path), true)
})

test('status reports an activating unit with no registry as starting, never stopped', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  // Real `systemctl show` shape: systemd accepted the start, no MainPID yet and
  // the Host has not published instance.json.
  const systemctl = unitSystemctl(unit.path, { activeState: 'activating', mainPid: 0 })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, { systemctl: systemctl.run }))
  assert.doesNotMatch(result.stdout, /^host=stopped$/mu, 'an activating unit is not a stopped Host')
  assert.match(result.stdout, /^host=starting$/mu)
  assert.match(result.stdout, /^unit-state=unknown$/mu)
  assert.match(result.stdout, /^manager=unmanaged$/mu)
})

test('restart stops and replaces an activating unit that has not published a Host', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'activating', mainPid: 0 })
  const newRecord = recordOf(fx.scope, { instanceId: '44444444-4444-4444-8444-444444444444', hostPid: 6464 })
  let stopped = false
  let ensured = 0
  let stoppedBeforeEnsure = false
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    systemctl: async args => {
      const outcome = await systemctl.run(args)
      if (args.includes('stop')) stopped = true
      return outcome
    },
    readRecord: () => (ensured > 0 ? newRecord : undefined),
    inspectProcess: recordValue => (recordValue?.instanceId === newRecord.instanceId ? 'alive' : 'dead'),
    authenticate: async recordValue => ({ record: recordValue, cookie: 'c', identity: recordValue }),
    ensureHost: async () => {
      stoppedBeforeEnsure = stopped
      ensured += 1
      return { record: newRecord, cookie: 'c', identity: newRecord }
    },
  }))
  assertCode(result, 0)
  assert.equal(ensured, 1)
  assert.equal(stoppedBeforeEnsure, true, 'the explicit restart must stop the activating unit before starting a new Host')
  assert.equal(systemctl.calls.some(args => args.includes('stop')), true, 'systemctl stop must be issued for the activating unit')
  assert.match(result.stdout, /^instance=44444444$/mu)
})

test('restart never starts after an activating unit stop fails', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'activating', mainPid: 0, stopResult: exited(1) })
  let ensured = 0
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    ensureHost: async () => { ensured += 1; throw new Error('must not start a second Host') },
  }))
  assert(result.code !== 0, 'a failed stop must fail the restart')
  assert.equal(ensured, 0, 'restart must not start after an unconfirmed stop')
  assert.equal(systemctl.calls.some(args => args.includes('start')), false)
})

test('status reports an unconfirmed transitional unit state as unknown and nonzero', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'deactivating', mainPid: 0 })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, { systemctl: systemctl.run }))
  assertCode(result, 5, /TRANSITION_UNCERTAIN/u)
  assert.match(result.stdout, /^host=unknown$/mu)
  assert.doesNotMatch(result.stdout, /^host=stopped$/mu)
  assert.match(result.stdout, /^manager=unmanaged$/mu)
})

test('an activating unit that supervises the authenticated Host is verified systemd supervision', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { activeState: 'activating', mainPid: record.hostPid })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  // A start that has already converged onto the authenticated Host IS verified
  // systemd supervision: ready + systemd, not `unmanaged` and not uncertain.
  assertCode(result, 0)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.match(result.stdout, /^manager=systemd$/mu)
})

test('an activating unit without a matching MainPID cannot claim the authenticated Host', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  for (const mainPid of [0, 9001]) {
    const systemctl = unitSystemctl(unit.path, { activeState: 'activating', mainPid })
    const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
      systemctl: systemctl.run,
      readRecord: () => record,
      inspectProcess: () => 'alive',
      authenticate: async () => ({ record, cookie: 'c', identity: record }),
    }))
    // The handshake really is Ready — the refusal is the supervision
    // attribution, which must make the COMMAND fail.
    assertCode(result, 3, /unit MainPID is not the authenticated Host/u)
    assert.match(result.stdout, /^host=ready$/mu, `MainPID=${String(mainPid)}: the Ready observation itself stays truthful`)
    assert.match(result.stdout, /^manager=process$/mu)
  }
})

test('a reloading unit or an unrecognized ActiveState stays uncertain beside a live Host', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  for (const activeState of ['reloading', 'maintenance']) {
    const systemctl = unitSystemctl(unit.path, { activeState, mainPid: record.hostPid })
    const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
      systemctl: systemctl.run,
      readRecord: () => record,
      inspectProcess: () => 'alive',
      authenticate: async () => ({ record, cookie: 'c', identity: record }),
    }))
    assertCode(result, 5, /TRANSITION_UNCERTAIN/u)
    assert.match(result.stdout, /^host=ready$/mu, `${activeState}: the authenticated Host observation stays truthful`)
    assert.match(result.stdout, /^manager=unmanaged$/mu, `${activeState}: a transitional unit cannot prove independent-process supervision`)
  }
})

test('a unit file the manager has not loaded cannot claim a healthy live Host', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { loadState: 'not-found', activeState: 'inactive', mainPid: 0 })
  const deps = {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive' as const,
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }
  const status = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, deps))
  assertCode(status, 0)
  assert.match(status.stdout, /^host=ready$/mu)
  assert.match(status.stdout, /^manager=process$/mu)
  assert.match(status.stdout, /^unit-state=not-found$/mu)
  // ...and a warm start reuses that Host without touching any OS state.
  let ensured = 0
  const start = await runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    ...deps,
    ensureHost: async () => { ensured += 1; throw new Error('a healthy Host must be reused') },
  }))
  assertCode(start, 0)
  assert.equal(ensured, 0)
  assert.match(start.stdout, /^instance=11111111$/mu)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), false)
  assert.equal(existsSync(unit.path), true, 'the unowned-by-manager file must stay untouched')
})

test('a rejected systemctl stop is not reported as a committed action', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: 4242, stopResult: exited(1, '', 'rejected') })
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, { systemctl: systemctl.run }))
  assertCode(result, 4, /could not stop the unit/u)
  assert.doesNotMatch(result.stderr, /may already be committed|Run daemon status/u,
    'the manager rejected stop before a committed stop request was observed')
  assert.equal(existsSync(unit.path), true)
})

test('an active unit that accepts stop but misses its deadline reports committed-but-unconfirmed', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const activeState = 'active'
  let stopCalls = 0
  const systemctl = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('stop')) stopCalls += 1
    return exited(0, [
      'LoadState=loaded',
      `ActiveState=${activeState}`,
      `FragmentPath=${unit.path}`,
      'DropInPaths=',
      `MainPID=${activeState === 'active' ? '4242' : '0'}`,
      'UnitFileState=disabled',
      '',
    ].join('\n'))
  }
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    systemctl,
    stopTimeoutMs: 1,
  }))
  assertCode(result, 5, /TRANSITION_UNCERTAIN/u)
  assert.match(result.stderr, /Host stop may already be committed; final verification failed/u)
  assert.match(result.stderr, /Run daemon status before retrying/u)
  assert.equal(stopCalls, 1, 'systemd accepted the stop request before the confirmation timeout')
})

test('post-stop manager query failure retains ownership refusal and recovery guidance', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const fake = unitSystemctl(unit.path, { activeState: 'active', mainPid: 4242 })
  let stopCalls = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    systemctl: async args => {
      if (args.includes('stop')) stopCalls += 1
      if (args.includes('show') && stopCalls > 0) {
        return exited(0, 'LoadState=loaded\nActiveState=inactive\nFragmentPath=/foreign.service\nDropInPaths=\nMainPID=0\n')
      }
      return fake.run(args)
    },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(stopCalls, 1)
  assert.match(result.stderr, /stop may already be committed; final verification failed/u)
  assert.match(result.stderr, /Run daemon status before retrying/u)
  assert.equal(existsSync(unit.path), true)
})

test('completed start and restart requests report an unconfirmed expected result without retrying', { skip: process.platform !== 'linux' }, async t => {
  for (const verb of ['start', 'restart'] as const) {
    await t.test(verb, async t => {
      const fx = fixture(t)
      const old = recordOf(fx.scope)
      let oldAlive = verb === 'restart'
      let ensured = 0
      let signals = 0
      const result = await runDaemonControl({ verb }, fx.profile, depsOf(fx, {
        readRecord: () => (verb === 'restart' && (oldAlive || ensured > 0) ? old : undefined),
        inspectProcess: () => 'alive',
        authenticate: async record => ({ record, cookie: 'c', identity: record }),
        readCmdline: () => `node\0${join(fx.profile.packageRoot, 'dist', 'local-host.mjs')}\0`,
        readStarttime: () => oldAlive ? old.hostStarttime : undefined,
        kill: () => { signals += 1; oldAlive = false },
        ensureHost: async () => { ensured += 1; return { record: old, cookie: 'c', identity: old } },
        sleep: async () => {},
        now: () => 0,
      }))
      assertCode(result, 5, /TRANSITION_UNCERTAIN/u)
      assert.equal(ensured, 1)
      assert.equal(signals, verb === 'restart' ? 1 : 0)
      assert.match(result.stderr, /may already be committed; final verification failed/u)
      assert.match(result.stderr, /Run daemon status before retrying/u)
      assert.match(result.stderr, verb === 'start' ? /Host is stopped/u : /did not produce a new Host instance/u)
      assert.equal(result.stdout, '')
    })
  }
})

test('an inactive owned unit with no Host is stopped and stop stays an idempotent no-op', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'inactive', mainPid: 0 })
  const status = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, { systemctl: systemctl.run }))
  assertCode(status, 0)
  assert.match(status.stdout, /^host=stopped$/mu)
  assert.match(status.stdout, /^manager=unmanaged$/mu)
  assert.match(status.stdout, /^unit-state=inactive$/mu)
  const stop = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(stop, 0)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), false, 'an inactive unit needs no stop call')
  assert.equal(existsSync(unit.path), true, 'stop must never remove the unit file')
})

test('a live Host that fails the authenticated handshake is unresponsive and nonzero', async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => { throw new LocalScopeError('HOST_AUTH_FAILED', 'no cookie') },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.match(result.stdout, /^host=unresponsive$/mu)
  assert.doesNotMatch(result.stdout, /^host=stopped$/mu)
})

test('stop acts on a verified unit when Host authentication fails, without a PID signal', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: record.hostPid })
  let stopped = false
  let signals = 0
  const systemctlRun = async (args: readonly string[]): Promise<SystemctlResult> => {
    const result = await systemctl.run(args)
    if (args.includes('stop')) stopped = true
    return result
  }
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    systemctl: systemctlRun,
    readRecord: () => (stopped ? undefined : record),
    inspectProcess: () => (stopped ? 'dead' : 'alive'),
    authenticate: async () => { throw new LocalScopeError('HOST_AUTH_FAILED', 'tampered launch material') },
    kill: () => { signals += 1 },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^host=stopped$/mu)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), true, 'the verified unit must be stopped through the manager')
  assert.equal(signals, 0, 'authentication failure never authorizes a PID signal')
  assert.equal(existsSync(unit.path), true, 'stop must not remove the unit file')
})

test('stop refuses a mismatched unit MainPID even when Host authentication failed', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: 9999 })
  let signals = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => { throw new LocalScopeError('HOST_AUTH_FAILED', 'tampered launch material') },
    kill: () => { signals += 1 },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), false, 'a mismatched unit is not the authenticated Host target')
  assert.equal(signals, 0, 'a mismatched target is never PID-signalled')
})

test('stop acts on a verified unit when the live Host protocol is incompatible', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope, { protocol: 'dsh-pi-tui/local/0' as typeof LOCAL_PROTOCOL })
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: record.hostPid })
  let stopped = false
  let signals = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    systemctl: async args => {
      const outcome = await systemctl.run(args)
      if (args.includes('stop')) stopped = true
      return outcome
    },
    readRecord: () => (stopped ? undefined : record),
    inspectProcess: () => (stopped ? 'dead' : 'alive'),
    authenticate: async () => { throw new Error('incompatible Host must not be authenticated') },
    kill: () => { signals += 1 },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^host=stopped$/mu)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), true)
  assert.equal(signals, 0, 'incompatible supervision is never a PID signal')
})

test('stop refuses an incompatible Host whose unit MainPID differs', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope, { protocol: 'dsh-pi-tui/local/0' as typeof LOCAL_PROTOCOL })
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: 9999 })
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    kill: () => { throw new Error('must not signal') },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), false)
})

test('restart replaces a verified incompatible Host after stopping its unit', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const oldRecord = recordOf(fx.scope, { protocol: 'dsh-pi-tui/local/0' as typeof LOCAL_PROTOCOL })
  const newRecord = recordOf(fx.scope, { instanceId: '55555555-5555-4555-8555-555555555555', hostPid: 6565 })
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: oldRecord.hostPid })
  let stopped = false
  let ensured = 0
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    systemctl: async args => {
      const outcome = await systemctl.run(args)
      if (args.includes('stop')) stopped = true
      return outcome
    },
    readRecord: () => (stopped ? (ensured > 0 ? newRecord : undefined) : oldRecord),
    inspectProcess: recordValue => (recordValue?.instanceId === newRecord.instanceId ? 'alive' : stopped ? 'dead' : 'alive'),
    authenticate: async recordValue => {
      if (recordValue.protocol !== LOCAL_PROTOCOL) throw new LocalScopeError('HOST_PROTOCOL_INCOMPATIBLE', 'different runtime')
      return { record: recordValue, cookie: 'c', identity: recordValue }
    },
    ensureHost: async () => { ensured += 1; return { record: newRecord, cookie: 'c', identity: newRecord } },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.equal(ensured, 1)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), true)
  assert.match(result.stdout, /^instance=55555555$/mu)
})

test('uninstall removes a verified incompatible Host unit', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope, { protocol: 'dsh-pi-tui/local/0' as typeof LOCAL_PROTOCOL })
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: record.hostPid })
  let stopped = false
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, {
    systemctl: async args => {
      const outcome = await systemctl.run(args)
      if (args.includes('stop')) stopped = true
      return outcome
    },
    readRecord: () => (stopped ? undefined : record),
    inspectProcess: () => (stopped ? 'dead' : 'alive'),
    authenticate: async () => { throw new Error('incompatible Host must not be authenticated') },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.equal(existsSync(unit.path), false)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), true)
})

test('a live Host with a different DSH runtime reports incompatible, not stopped', async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope, { dshVersion: '0.1.0' })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.match(result.stdout, /^host=incompatible$/mu)
  assert.match(result.stdout, /^compatibility=incompatible$/mu)
})

test('an unreadable registry is nonzero with an unknown Host, never stopped', async t => {
  const fx = fixture(t)
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    readRecord: () => { throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'registry is unsafe') },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.match(result.stdout, /^host=unknown$/mu)
  assert.doesNotMatch(result.stdout, /^host=stopped$/mu)
})

test('a live independent Host beside an inactive unit is process-supervised, not systemd', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { activeState: 'inactive', mainPid: 0 })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.match(result.stdout, /^manager=process$/mu)
})

test('a user-manager query error is nonzero and never reported as stopped', async t => {
  const fx = fixture(t)
  writeOwnedUnit(fx)
  const systemctl = unitSystemctl(join(fx.unitDir, fx.unitName), {
    unitPathResult: exited(1, '', 'Failed to connect to bus: Connection refused'),
  })
  const broken = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('show')) return exited(1, '', 'Failed to connect to bus: Connection refused')
    return await systemctl.run(args)
  }
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, { systemctl: broken }))
  assertCode(result, 4, /MANAGER_OR_OS_FAILURE/u)
  assert.match(result.stdout, /^user-manager=error$/mu)
  assert.match(result.stdout, /^host=unknown$/mu)
})

test('a compatible live Host is attributed to the verified active unit and reports ready', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: record.hostPid })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.match(result.stdout, /^manager=systemd$/mu)
  assert.match(result.stdout, /^compatibility=compatible$/mu)
  assert.match(result.stdout, /^pid=4242$/mu)
  assert.match(result.stdout, /^instance=11111111$/mu)
})

test('an active unit whose MainPID is not the authenticated Host is refused', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: 777 })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
})

test('a different installed build is reported as other-build while a compatible Host stays ready', async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope, { buildId: 'f'.repeat(64) })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.match(result.stdout, /^compatibility=other-build$/mu)
})

test('a foreign or unsafe unit file is refused and still reports an authenticated Host', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  writeFileSync(unit.path, unit.content.replace('X-DshPiTuiOwner=local-host-manager-v1', 'X-DshPiTuiOwner=someone-else'), { mode: 0o600 })
  const record = recordOf(fx.scope)
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.match(result.stdout, /^host=ready$/mu, 'the authenticated Host observation stays truthful')
  assert.match(result.stdout, /^manager=unmanaged$/mu, 'a foreign unit leaves no verified supervision attribution')
})

test('a user-linked unit with Profile metadata is followed for status', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const real = join(fx.unitDir, 'real.service')
  writeFileSync(real, unit.content, { mode: 0o600 })
  unlinkSync(unit.path)
  symlinkSync(real, unit.path)
  const systemctl = unitSystemctl(real)
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, { systemctl: systemctl.run }))
  assertCode(result, 0)
  assert.match(result.stdout, /^user-manager=available$/mu)
})

test('an unsupported platform exits 3 before touching the filesystem', async t => {
  const fx = fixture(t)
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, { platform: 'win32' })
  assertCode(result, 3, /UNSUPPORTED_PLATFORM/u)
  assert.equal(existsSync(fx.scope.dir), false, 'an unsupported platform must not create the scope')
})

// ── darwin (macOS): process-only management ─────────────────────────────────

test('darwin status with no Host reports the fixed no-unit facts without touching the filesystem', async t => {
  const fx = fixture(t)
  const systemctlCalls: string[][] = []
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, darwinDepsOf(fx, {
    systemctl: async args => { systemctlCalls.push([...args]); return exited(0) },
    launchctl: async () => { throw new Error('no installed plist means NO launchctl call') },
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^manager=unmanaged$/mu)
  assert.match(result.stdout, /^user-manager=not-checked$/mu)
  assert.match(result.stdout, /^host=stopped$/mu)
  assert.match(result.stdout, /^unit=none$/mu)
  assert.match(result.stdout, /^unit-state=not-found$/mu)
  assert.match(result.stdout, /^compatibility=none$/mu)
  assert.deepEqual(systemctlCalls, [], 'macOS never probes a systemd user manager')
  assert.equal(existsSync(fx.scope.dir), false, 'status must never create the scope run directory')
  assert.equal(existsSync(join(fx.accountHome, '.dsh-pi-tui')), false, 'status must never create the Darwin seat chain')
})

test('darwin status never inspects an installed systemd unit file', async t => {
  const fx = fixture(t)
  writeOwnedUnit(fx)
  const systemctlCalls: string[][] = []
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, darwinDepsOf(fx, {
    systemctl: async args => { systemctlCalls.push([...args]); return exited(0) },
    launchctl: async () => { throw new Error('a systemd unit file is not a launchd unit') },
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^unit=none$/mu)
  assert.match(result.stdout, /^unit-state=not-found$/mu)
  assert.match(result.stdout, /^manager=unmanaged$/mu)
  assert.deepEqual(systemctlCalls, [], 'a Linux unit file is not a macOS unit fact')
})

test('darwin status reports an authenticated Host as process-supervised with no unit facts', async t => {
  const fx = fixture(t)
  const record = darwinRecordOf(fx.scope)
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, darwinDepsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    launchctl: async () => { throw new Error('an independent Host needs no launchctl query') },
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.match(result.stdout, /^manager=process$/mu)
  assert.match(result.stdout, /^user-manager=not-checked$/mu)
  assert.match(result.stdout, /^unit=none$/mu)
  assert.match(result.stdout, /^compatibility=compatible$/mu)
  assert.match(result.stdout, /^pid=4242$/mu)
  assert.match(result.stdout, /^instance=11111111$/mu)
})

test('darwin logs reads the scope host.log and never a unit journal', async t => {
  const fx = fixture(t)
  let journalReads = 0
  const result = await runDaemonControl({ verb: 'logs', lines: 20 }, fx.profile, darwinDepsOf(fx, {
    launchctl: async () => { throw new Error('an independent Host log needs no launchctl query') },
    journal: async () => { journalReads += 1; return { code: 0, stdout: 'unit journal\n', stderr: '' } },
    hostLogTail: async (path, lines) => {
      assert.equal(path, join(fx.scope.dir, 'host.log'))
      assert.equal(lines, 20)
      return 'token=SECRET host line\n'
    },
  }))
  assertCode(result, 0)
  assert.equal(journalReads, 0, 'macOS has no systemd journal source')
  assert.doesNotMatch(result.stdout, /SECRET/u)
  assert.match(result.stdout, /host line/u)
})

test('darwin install writes one owned LaunchAgent without starting, stopping or migrating an independent Host', { skip: process.platform !== 'darwin' ? 'the Darwin admin seat requires macOS' : false }, async t => {
  const fx = fixture(t)
  const record = darwinRecordOf(fx.scope)
  const launchctl = fakeLaunchd(fx, { loaded: false })
  const result = await runDaemonControl({ verb: 'install' }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(result, 0)
  assert.match(result.stdout, new RegExp(`^unit=${buildLaunchdLabel(fx.scope.scopeId)}$`, 'mu'))
  assert.match(result.stdout, /^unit-state=not-found$/mu)
  assert.match(result.stdout, /^manager=process$/mu)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.match(result.stdout, /^pid=4242$/mu)
  assert.equal(existsSync(launchdPlistPathOf(fx)), true, 'install must write the owned plist')
  assert.equal(statSync(launchdPlistPathOf(fx)).mode & 0o777, 0o600)
  assert.equal(existsSync(fx.scope.dir), false, 'install must not create the profile runtime scope')
  assert.equal(launchctl.calls.some(args => args[0] === 'bootstrap' || args[0] === 'kickstart' || args[0] === 'bootout'), false,
    'install never starts or stops a job')
  assert.equal(existsSync(join(fx.unitDir, fx.unitName)), false, 'macOS must not write a systemd unit')
})

test('darwin install is idempotent and refuses a same-label job from another source', { skip: process.platform !== 'darwin' ? 'the Darwin admin seat requires macOS' : false }, async t => {
  const fx = fixture(t)
  const launchctl = fakeLaunchd(fx, { loaded: false })
  const deps = darwinDepsOf(fx, { launchctl: launchctl.run })
  const first = await runDaemonControl({ verb: 'install' }, fx.profile, deps)
  assertCode(first, 0)
  const content = readFileSync(launchdPlistPathOf(fx), 'utf8')
  const second = await runDaemonControl({ verb: 'install' }, fx.profile, deps)
  assertCode(second, 0)
  assert.equal(readFileSync(launchdPlistPathOf(fx), 'utf8'), content, 'a repeat install never rewrites the owned plist')

  const foreignFx = fixture(t)
  const foreignPath = join(foreignFx.accountHome, 'foreign.plist')
  writeFileSync(foreignPath, '<?xml?><plist/>', { mode: 0o600 })
  const foreignLaunchctl = fakeLaunchd(foreignFx, { loaded: true, path: foreignPath })
  const refused = await runDaemonControl({ verb: 'install' }, foreignFx.profile, darwinDepsOf(foreignFx, { launchctl: foreignLaunchctl.run }))
  assertCode(refused, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(existsSync(launchdPlistPathOf(foreignFx)), false, 'no plist is written while a foreign job owns the label')
})

test('darwin status claims launchd only when the real job PID is the authenticated Host', async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const record = darwinRecordOf(fx.scope)
  const launchctl = fakeLaunchd(fx, { loaded: true, state: 'running', pid: record.hostPid })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^manager=launchd$/mu)
  assert.match(result.stdout, /^user-manager=available$/mu)
  assert.match(result.stdout, new RegExp(`^unit=${buildLaunchdLabel(fx.scope.scopeId)}$`, 'mu'))
  assert.match(result.stdout, /^unit-state=running$/mu)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.match(result.stdout, /^pid=4242$/mu)
})

test('darwin status refuses a launchd PID that is not the authenticated Host without claiming launchd', async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const record = darwinRecordOf(fx.scope)
  const launchctl = fakeLaunchd(fx, { loaded: true, state: 'running', pid: 5151 })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.match(result.stdout, /^manager=process$/mu)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.doesNotMatch(result.stdout, /^manager=launchd$/mu)
})

test('darwin status reports a loaded not-running job as stopped and never as launchd supervision', async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const launchctl = fakeLaunchd(fx, { loaded: true, state: 'not running' })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, darwinDepsOf(fx, { launchctl: launchctl.run }))
  assertCode(result, 0)
  assert.match(result.stdout, /^manager=unmanaged$/mu)
  assert.match(result.stdout, /^host=stopped$/mu)
  assert.match(result.stdout, /^unit-state=not-running$/mu)
  assert.match(result.stdout, new RegExp(`^unit=${buildLaunchdLabel(fx.scope.scopeId)}$`, 'mu'))
})

test('darwin status fails closed when the loaded job does not match the installed plist', async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const record = darwinRecordOf(fx.scope)
  const launchctl = fakeLaunchd(fx, {
    loaded: true,
    state: 'running',
    pid: record.hostPid,
    environment: { DSH_HOME: '/other', SPLIT_PROCESS_DSH_ANCHOR: '/other', SPLIT_PROCESS_PROFILE: 'other' },
  })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.match(result.stdout, /^manager=unmanaged$/mu)
  assert.match(result.stdout, /^host=ready$/mu)
})

test('darwin start reuses an authenticated Host before any launchctl call', { skip: process.platform !== 'darwin' ? 'the Darwin admin seat requires macOS' : false }, async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const record = darwinRecordOf(fx.scope)
  const launchctl = fakeLaunchd(fx, { loaded: true, state: 'running', pid: record.hostPid })
  const result = await runDaemonControl({ verb: 'start' }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    ensureHost: async () => { throw new Error('a warm start must never create a Host') },
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.match(result.stdout, /^instance=11111111$/mu)
  assert.equal(launchctl.calls.some(args => args[0] !== 'print'), false, 'a reused Host needs no launchctl mutation')
  assert.equal(launchctl.calls.filter(args => args[0] === 'print').length, 1, 'the snapshot reads the current service once')
})

test('darwin stop boots out only the verified job and proves the old kernel identity gone', { skip: process.platform !== 'darwin' ? 'the Darwin admin seat requires macOS' : false }, async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const record = darwinRecordOf(fx.scope)
  let alive = true
  let kernelReads = 0
  const signals: NodeJS.Signals[] = []
  const launchctl = fakeLaunchd(fx, {
    loaded: true,
    state: 'running',
    pid: record.hostPid,
    onBootout: () => { alive = false },
  })
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    readRecord: () => (alive ? record : undefined),
    inspectProcess: () => (alive ? 'alive' : 'dead'),
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    readKernel: () => {
      kernelReads += 1
      return alive ? { kind: 'alive', identity: record.hostKernelIdentity } : { kind: 'gone' }
    },
    kill: (_pid, signal) => { signals.push(signal) },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^host=stopped$/mu)
  assert.deepEqual(signals, [], 'a verified launchd job is stopped through bootout, never a raw PID signal')
  assert.equal(launchctl.calls.filter(args => args[0] === 'bootout').length, 1)
  assert.ok(kernelReads >= 1, 'the recorded kernel identity must be observed after bootout')
})

test('darwin stop boots out a loaded job with no live Host and never signals', { skip: process.platform !== 'darwin' ? 'the Darwin admin seat requires macOS' : false }, async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const launchctl = fakeLaunchd(fx, { loaded: true, state: 'not running' })
  const signals: NodeJS.Signals[] = []
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    kill: (_pid, signal) => { signals.push(signal) },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^host=stopped$/mu)
  assert.deepEqual(signals, [])
  assert.equal(launchctl.calls.filter(args => args[0] === 'bootout').length, 1)
})

test('darwin stop refuses a launchd PID that is not the live Host with zero bootout', { skip: process.platform !== 'darwin' ? 'the Darwin admin seat requires macOS' : false }, async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const record = darwinRecordOf(fx.scope)
  const launchctl = fakeLaunchd(fx, { loaded: true, state: 'running', pid: 5151 })
  const signals: NodeJS.Signals[] = []
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    kill: (_pid, signal) => { signals.push(signal) },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.deepEqual(signals, [])
  assert.equal(launchctl.calls.some(args => args[0] === 'bootout'), false, 'a mismatched job is never booted out')
})

test('darwin restart stops the launchd job and starts a new instance through the public ensure', { skip: process.platform !== 'darwin' ? 'the Darwin admin seat requires macOS' : false }, async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const oldRecord = darwinRecordOf(fx.scope)
  const newRecord = darwinRecordOf(fx.scope, {
    instanceId: '44444444-4444-4444-8444-444444444444',
    hostPid: 6464,
  })
  let alive = true
  let current: LocalInstanceRecord | undefined = oldRecord
  let ensured = 0
  const launchctl = fakeLaunchd(fx, { loaded: true, state: 'running', pid: oldRecord.hostPid, onBootout: () => { alive = false } })
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    readRecord: () => current,
    inspectProcess: record => (record.instanceId === oldRecord.instanceId ? (alive ? 'alive' : 'dead') : (ensured > 0 ? 'alive' : 'dead')),
    authenticate: async record => ({ record, cookie: 'c', identity: record }),
    readKernel: pid => {
      if (pid === oldRecord.hostPid) return alive ? { kind: 'alive', identity: oldRecord.hostKernelIdentity } : { kind: 'gone' }
      return { kind: 'alive', identity: newRecord.hostKernelIdentity }
    },
    ensureHost: async options => {
      ensured += 1
      assert.equal(options.hostStartPolicy, 'public')
      current = newRecord
      return { record: newRecord, cookie: 'c', identity: newRecord }
    },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.equal(ensured, 1)
  assert.match(result.stdout, /^previous=11111111$/mu)
  assert.match(result.stdout, /^instance=44444444$/mu)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.equal(launchctl.calls.filter(args => args[0] === 'bootout').length, 1)
})

test('darwin uninstall removes only the verified job and plist, keeps the logs and never signals', { skip: process.platform !== 'darwin' ? 'the Darwin admin seat requires macOS' : false }, async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const facts = launchdFactsOf(fx)
  mkdirSync(facts.scopeDir, { recursive: true, mode: 0o700 })
  const logs = launchdLogPaths(facts.scopeDir)
  writeFileSync(logs.stdout, 'managed stdout retained\n', { mode: 0o600 })
  writeFileSync(logs.stderr, 'managed stderr retained\n', { mode: 0o600 })
  const record = darwinRecordOf(fx.scope)
  let alive = true
  const signals: NodeJS.Signals[] = []
  const launchctl = fakeLaunchd(fx, { loaded: true, state: 'running', pid: record.hostPid, onBootout: () => { alive = false } })
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    readRecord: () => (alive ? record : undefined),
    inspectProcess: () => (alive ? 'alive' : 'dead'),
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    readKernel: () => (alive ? { kind: 'alive', identity: record.hostKernelIdentity } : { kind: 'gone' }),
    kill: (_pid, signal) => { signals.push(signal) },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.equal(existsSync(launchdPlistPathOf(fx)), false, 'uninstall removes the owned plist')
  assert.equal(readFileSync(logs.stdout, 'utf8'), 'managed stdout retained\n')
  assert.equal(readFileSync(logs.stderr, 'utf8'), 'managed stderr retained\n')
  assert.deepEqual(signals, [])
  assert.equal(launchctl.calls.filter(args => args[0] === 'bootout').length, 1)
})

test('darwin uninstall with no plist is an idempotent no-op and never calls launchctl', { skip: process.platform !== 'darwin' ? 'the Darwin admin seat requires macOS' : false }, async t => {
  const fx = fixture(t)
  const run: LaunchctlRunner = async () => { throw new Error('uninstall with no plist must not query launchctl') }
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, darwinDepsOf(fx, { launchctl: run }))
  assertCode(result, 0)
  assert.match(result.stdout, /^unit=none$/mu)
})

test('darwin logs reads the two launchd streams with explicit sources and never host.log', async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const facts = launchdFactsOf(fx)
  const logs = launchdLogPaths(facts.scopeDir)
  const record = darwinRecordOf(fx.scope)
  const launchctl = fakeLaunchd(fx, { loaded: true, state: 'running', pid: record.hostPid })
  const result = await runDaemonControl({ verb: 'logs', lines: 20 }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    hostLogTail: async (path, lines) => {
      assert.equal(lines, 20)
      if (path === logs.stdout) return 'managed out token=SECRET\n'
      if (path === logs.stderr) return 'managed err\n'
      assert.fail(`the launchd log source must not read ${path}`)
    },
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /\[dsh-pi-tui daemon: launchd stdout\]/u)
  assert.match(result.stdout, /\[dsh-pi-tui daemon: launchd stderr\]/u)
  assert.match(result.stdout, /managed out/u)
  assert.match(result.stdout, /managed err/u)
  assert.doesNotMatch(result.stdout, /SECRET/u)
})

test('darwin logs keeps host.log for an independent Host beside an installed but unloaded plist', async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const record = darwinRecordOf(fx.scope)
  const launchctl = fakeLaunchd(fx, { loaded: false })
  const result = await runDaemonControl({ verb: 'logs', lines: 20 }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    hostLogTail: async (path, lines) => {
      assert.equal(path, join(fx.scope.dir, 'host.log'))
      assert.equal(lines, 20)
      return 'independent host line\n'
    },
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /independent host line/u)
})

test('darwin logs reports an unavailable launchd source without inventing one', async t => {
  const fx = fixture(t)
  writeOwnedLaunchd(fx)
  const record = darwinRecordOf(fx.scope)
  const launchctl = fakeLaunchd(fx, { loaded: true, state: 'running', pid: record.hostPid })
  const result = await runDaemonControl({ verb: 'logs', lines: 20 }, fx.profile, darwinDepsOf(fx, {
    launchctl: launchctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    hostLogTail: async () => undefined,
  }))
  assertCode(result, 4, /LOG_SOURCE_UNAVAILABLE/u)
})

test('darwin stop signals the kernel-verified Host exactly once and waits for its identity to go', { skip: process.platform !== 'darwin' ? 'Darwin kernel seats require macOS' : false }, async t => {
  const fx = fixture(t)
  const record = darwinRecordOf(fx.scope)
  let alive = true
  let kernelReads = 0
  const signals: Array<[number, NodeJS.Signals]> = []
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, darwinDepsOf(fx, {
    readRecord: () => (alive ? record : undefined),
    inspectProcess: () => (alive ? 'alive' : 'dead'),
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    readKernel: () => {
      kernelReads += 1
      return alive ? { kind: 'alive', identity: record.hostKernelIdentity } : { kind: 'gone' }
    },
    kill: (pid, signal) => { signals.push([pid, signal]); alive = false },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.deepEqual(signals, [[record.hostPid, 'SIGTERM']], 'exactly one SIGTERM to the verified Host')
  assert.match(result.stdout, /^host=stopped$/mu)
  assert.ok(kernelReads >= 2, 'the kernel identity is re-read after the handshake AND immediately before the signal')
})

test('darwin stop refuses a kernel identity that changed before the signal with zero signal', { skip: process.platform !== 'darwin' ? 'Darwin kernel seats require macOS' : false }, async t => {
  const fx = fixture(t)
  const record = darwinRecordOf(fx.scope)
  let reads = 0
  let signals = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, darwinDepsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    readKernel: (): KernelObservation => {
      reads += 1
      // First read satisfies the handshake; the immediate pre-signal read sees
      // a reused PID.
      return reads === 1
        ? { kind: 'alive', identity: record.hostKernelIdentity }
        : { kind: 'alive', identity: darwinIdentityOf(record.hostPid, { uniqueId: '9002' }) }
    },
    kill: () => { signals += 1 },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(signals, 0, 'a changed identity is never signalled')
})

test('darwin stop refuses an unreadable kernel identity with zero signal', { skip: process.platform !== 'darwin' ? 'Darwin kernel seats require macOS' : false }, async t => {
  const fx = fixture(t)
  const record = darwinRecordOf(fx.scope)
  let signals = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, darwinDepsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    readKernel: () => ({ kind: 'unknown', code: 'NATIVE_UNAVAILABLE' }),
    kill: () => { signals += 1 },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(signals, 0, 'an unreadable identity is not a kill permit')
})

test('darwin stop reports a committed-but-unconfirmed stop without a second signal', { skip: process.platform !== 'darwin' ? 'Darwin kernel seats require macOS' : false }, async t => {
  const fx = fixture(t)
  const record = darwinRecordOf(fx.scope)
  let now = 0
  const signals: NodeJS.Signals[] = []
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, darwinDepsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    readKernel: () => ({ kind: 'alive', identity: record.hostKernelIdentity }),
    kill: (_pid, signal) => { signals.push(signal) },
    stopTimeoutMs: 100,
    sleep: async () => { now += 50 },
    now: () => now,
  }))
  assertCode(result, 5, /TRANSITION_UNCERTAIN/u)
  assert.match(result.stderr, /Host stop may already be committed; final verification failed/u)
  assert.deepEqual(signals, ['SIGTERM'], 'the timeout never sends a second signal or SIGKILL')
})

test('darwin start cold-starts through the shared public ensure and a warm start reuses the same instance', { skip: process.platform !== 'darwin' ? 'Darwin kernel seats require macOS' : false }, async t => {
  const fx = fixture(t)
  let current: LocalInstanceRecord | undefined
  let ensured = 0
  const result = await runDaemonControl({ verb: 'start' }, fx.profile, darwinDepsOf(fx, {
    readRecord: () => current,
    inspectProcess: () => (current === undefined ? 'dead' : 'alive'),
    authenticate: async record => ({ record, cookie: 'c', identity: record }),
    ensureHost: async options => {
      ensured += 1
      assert.equal(options.hostStartPolicy, 'public')
      current = darwinRecordOf(fx.scope)
      return { record: current, cookie: 'c', identity: current }
    },
  }))
  assertCode(result, 0)
  assert.equal(ensured, 1)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.match(result.stdout, /^manager=process$/mu)
  assert.match(result.stdout, /^unit=none$/mu)
  assert.match(result.stdout, /^instance=11111111$/mu)
  const warm = await runDaemonControl({ verb: 'start' }, fx.profile, darwinDepsOf(fx, {
    readRecord: () => current,
    inspectProcess: () => 'alive',
    authenticate: async record => ({ record, cookie: 'c', identity: record }),
    ensureHost: async () => { ensured += 1; throw new Error('a warm start must reuse the authenticated Host') },
  }))
  assertCode(warm, 0)
  assert.equal(ensured, 1, 'a warm start must not spawn a second Host')
  assert.match(warm.stdout, /^instance=11111111$/mu)
})

test('darwin restart proves the old kernel identity gone and returns a new instance', { skip: process.platform !== 'darwin' ? 'Darwin kernel seats require macOS' : false }, async t => {
  const fx = fixture(t)
  const oldRecord = darwinRecordOf(fx.scope)
  const newRecord = darwinRecordOf(fx.scope, {
    instanceId: '44444444-4444-4444-8444-444444444444',
    hostPid: 6464,
  })
  let current: LocalInstanceRecord | undefined = oldRecord
  let stopped = false
  let ensured = 0
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, darwinDepsOf(fx, {
    readRecord: () => current,
    inspectProcess: record => {
      if (record.instanceId === oldRecord.instanceId) return stopped ? 'dead' : 'alive'
      return ensured > 0 ? 'alive' : 'dead'
    },
    authenticate: async record => ({ record, cookie: 'c', identity: record }),
    readKernel: pid => {
      if (pid === oldRecord.hostPid) return stopped ? { kind: 'gone' } : { kind: 'alive', identity: oldRecord.hostKernelIdentity }
      if (pid === newRecord.hostPid) return { kind: 'alive', identity: newRecord.hostKernelIdentity }
      return { kind: 'gone' }
    },
    kill: path => {
      assert.equal(path, oldRecord.hostPid)
      stopped = true
    },
    ensureHost: async () => {
      ensured += 1
      current = newRecord
      return { record: newRecord, cookie: 'c', identity: newRecord }
    },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.equal(ensured, 1)
  assert.match(result.stdout, /^previous=11111111$/mu)
  assert.match(result.stdout, /^instance=44444444$/mu)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.equal(stopped, true)
})

test('darwin mutating verbs take the admin seat and another profile keeps its own seat', { skip: process.platform !== 'darwin' ? 'Darwin kernel seats require macOS' : false }, async t => {
  const fx = fixture(t)
  const dir = darwinHostProfileSeatDir(fx.scope.scopeId, fx.accountHome)
  const seat = await bindDarwinKernelSeat(dir, fx.scope.scopeId, 'admin', 'DAEMON_CONTROL_BUSY')
  t.after(async () => { await seat.close() })
  const busy = await runDaemonControl({ verb: 'start' }, fx.profile, darwinDepsOf(fx))
  assertCode(busy, 5, /DAEMON_CONTROL_BUSY/u)

  // A different Profile owns a different scope and therefore a different admin
  // seat file: the held seat above must not block it.
  const other = fixture(t)
  let current: LocalInstanceRecord | undefined
  const independent = await runDaemonControl({ verb: 'start' }, other.profile, darwinDepsOf(other, {
    readRecord: () => current,
    inspectProcess: () => (current === undefined ? 'dead' : 'alive'),
    authenticate: async record => ({ record, cookie: 'c', identity: record }),
    ensureHost: async () => {
      current = darwinRecordOf(other.scope)
      return { record: current, cookie: 'c', identity: current }
    },
  }))
  assertCode(independent, 0)
})

// ── stop: explicit supervision only ─────────────────────────────────────────

test('stop with no live Host and no owned unit is an idempotent no-op', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const systemctl = unitSystemctl(join(fx.unitDir, fx.unitName), { loadState: 'not-found' })
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, { systemctl: systemctl.run }))
  assertCode(result, 0)
  assert.match(result.stdout, /^host=stopped$/mu)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), false, 'nothing may be stopped')
})

test('stop uses the unit of an activating supervisor that owns the Host', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { activeState: 'activating', mainPid: record.hostPid })
  let signals = 0
  let stopped = false
  const run = async (args: readonly string[]): Promise<SystemctlResult> => {
    const result = await systemctl.run(args)
    if (args.includes('stop')) stopped = true
    return result
  }
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    systemctl: run,
    readRecord: () => (stopped ? undefined : record),
    inspectProcess: () => (stopped ? 'dead' : 'alive'),
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    kill: () => { signals += 1 },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), true, 'the verified unit must be stopped through the manager')
  assert.equal(signals, 0, 'a unit-supervised Host is never PID-signalled')
})

test('stop signals an authenticated independent Host even when a user manager exists', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let alive = true
  const signals: Array<[number, NodeJS.Signals]> = []
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    readRecord: () => alive ? record : undefined,
    inspectProcess: () => alive ? 'alive' : 'dead',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    readCmdline: () => `node\0${join(fx.profile.packageRoot, 'dist', 'local-host.mjs')}\0`,
    readStarttime: () => alive ? record.hostStarttime : undefined,
    kill: (pid, signal) => { signals.push([pid, signal]); alive = false },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.deepEqual(signals, [[record.hostPid, 'SIGTERM']])
  assert.match(result.stdout, /^host=stopped$/mu)
})

test('stop refuses a live Host whose manager state cannot be confirmed', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  let signals = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    systemctl: async args => args.includes('show') ? exited(1, '', 'bus unavailable') : exited(0),
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    kill: () => { signals += 1 },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 4, /MANAGER_OR_OS_FAILURE/u)
  assert.equal(signals, 0, 'an unreadable manager never authorizes a PID signal')
  assert.equal(existsSync(unit.path), true)
})

test('the process identity check reads a real procfs cmdline despite st_size=0', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  // The production default reads THIS process's real /proc/<pid>/cmdline, which
  // reports st_size = 0: a size-based read returns an empty string and would
  // refuse every real independent Host. Node's own argv must come back intact.
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    readRecord: () => {
      const withOwnPid = { ...record, hostPid: process.pid, hostStarttime: readLinuxStarttime(process.pid) }
      return withOwnPid
    },
    inspectProcess: r => (r.hostPid === process.pid ? 'alive' : 'dead'),
    authenticate: async r => ({ record: r, cookie: 'c', identity: r }),
    readStarttime: () => readLinuxStarttime(process.pid),
    kill: () => {},
    sleep: async () => {},
    now: () => 0,
  }))
  // The identity check passed (node is not the Host entry, so the command must
  // refuse on ownership — NOT on an empty command line).
  assertCode(result, 3, /is not the product Host entry/u)
})

test('stop refuses a non-Host command line and never signals it', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let signals = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    readCmdline: () => 'node\0/tmp/not-the-host.mjs\0',
    kill: () => { signals += 1 },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(signals, 0)
})

test('stop refuses when the kernel starttime changed before the signal', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let signals = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    readCmdline: () => `node\0${join(fx.profile.packageRoot, 'dist', 'local-host.mjs')}\0`,
    readStarttime: () => '99999',
    kill: () => { signals += 1 },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(signals, 0)
})

test('stop signals an independent Host beside a loaded inactive unit and leaves the unit file', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope, { hostPid: 7777 })
  const systemctl = unitSystemctl(unit.path, { activeState: 'inactive', mainPid: 0 })
  let alive = true
  const signals: number[] = []
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => alive ? record : undefined,
    inspectProcess: () => alive ? 'alive' : 'dead',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    readCmdline: () => `node\0${join(fx.profile.packageRoot, 'dist', 'local-host.mjs')}\0`,
    readStarttime: () => alive ? record.hostStarttime : undefined,
    kill: pid => { signals.push(pid); alive = false },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.deepEqual(signals, [7777])
  assert.equal(systemctl.calls.some(args => args.includes('stop')), false, 'an inactive unit is not stopped through systemd')
  assert.equal(existsSync(unit.path), true, 'stop must never remove the unit file')
})

test('a stop that cannot confirm the Host exit is TRANSITION_UNCERTAIN, not stopped', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let now = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    readCmdline: () => `node\0${join(fx.profile.packageRoot, 'dist', 'local-host.mjs')}\0`,
    readStarttime: () => record.hostStarttime,
    kill: () => {},
    stopTimeoutMs: 100,
    sleep: async () => { now += 50 },
    now: () => now,
  }))
  assertCode(result, 5, /TRANSITION_UNCERTAIN/u)
  assert.match(result.stderr, /Host stop may already be committed; final verification failed/u)
  assert.match(result.stderr, /Run daemon status before retrying/u)
})

/** Wait until a held fake entered its awaited phase (real event, no fixed sleep). */
async function waitUntil(predicate: () => boolean): Promise<void> {
  for (;;) {
    if (predicate()) return
    await new Promise(resolve => setImmediate(resolve))
  }
}

test('an abort during the pre-flight snapshot starts no Host and creates no scope', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  writeOwnedUnit(fx)
  const controller = new AbortController()
  let releaseGate: (() => void) | undefined
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  let showEntered = false
  let ensured = 0
  const resultPromise = runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    signal: controller.signal,
    systemctl: async args => {
      if (args.includes('show')) {
        showEntered = true
        await gate
        return exited(0, [
          'LoadState=loaded',
          'ActiveState=inactive',
          `FragmentPath=${join(fx.unitDir, fx.unitName)}`,
          'DropInPaths=',
          'MainPID=0',
          'UnitFileState=disabled',
          '',
        ].join('\n'))
      }
      return exited(0)
    },
    ensureHost: async () => { ensured += 1; throw new Error('must not start after abort') },
  }))
  await waitUntil(() => showEntered)
  controller.abort()
  releaseGate?.()
  const result = await resultPromise
  assertCode(result, 5, /TRANSITION_UNCERTAIN/u)
  assert.equal(ensured, 0, 'an aborted pre-flight must never commit a Host start')
  assert.equal(existsSync(fx.scope.dir), false, 'an aborted pre-flight must not create the run directory')
})

test('an abort during the restart pre-flight commits no stop, reload or start', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'inactive', mainPid: 0 })
  const controller = new AbortController()
  let releaseGate: (() => void) | undefined
  const gate = new Promise<void>(resolve => { releaseGate = resolve })
  let entered = false
  let ensured = 0
  const resultPromise = runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    signal: controller.signal,
    systemctl: async args => {
      if (args.includes('show')) {
        entered = true
        await gate
      }
      return await systemctl.run(args)
    },
    ensureHost: async () => { ensured += 1; throw new Error('must not start after abort') },
  }))
  await waitUntil(() => entered)
  controller.abort()
  releaseGate?.()
  const result = await resultPromise
  assertCode(result, 5, /TRANSITION_UNCERTAIN/u)
  assert.equal(ensured, 0)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), false, 'no stop may be committed after abort')
  assert.equal(systemctl.calls.some(args => args.includes('daemon-reload')), false, 'no reload may be committed after abort')
  assert.equal(existsSync(unit.path), true, 'the owned unit file must be untouched')
})

test('a second concurrent management operation is DAEMON_CONTROL_BUSY', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const { bindProcessSeat } = await import('../../src/app/remote-process/local-scope.ts')
  const seat = await bindProcessSeat(`\0dsh-pi-tui-admin-${fx.scope.scopeId.slice(0, 40)}`, 'DAEMON_CONTROL_BUSY')
  t.after(async () => { await seat.close() })
  const result = await runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx))
  assertCode(result, 5, /DAEMON_CONTROL_BUSY/u)
})

// ── start / restart ─────────────────────────────────────────────────────────

test('start reuses an already authenticated Host without calling ensure', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let ensured = 0
  const result = await runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    ensureHost: async () => { ensured += 1; throw new Error('must not ensure') },
  }))
  assertCode(result, 0)
  assert.equal(ensured, 0)
  assert.match(result.stdout, /^instance=11111111$/mu)
})

test('start refuses an incompatible live Host without starting another one', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope, { protocol: 'dsh-pi-tui/local/0' as typeof LOCAL_PROTOCOL })
  let ensured = 0
  const result = await runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    ensureHost: async () => { ensured += 1; throw new Error('must not ensure') },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(ensured, 0)
})

test('start reuses an authenticated Host even when the user manager is erroring', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  let ensured = 0
  const systemctlCalls: string[][] = []
  const result = await runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    systemctl: async args => {
      systemctlCalls.push([...args])
      return args.includes('show') ? exited(1, '', 'bus broke') : exited(0)
    },
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    ensureHost: async () => { ensured += 1; throw new Error('a live Host must be reused, not re-ensured') },
  }))
  assertCode(result, 0)
  assert.equal(ensured, 0, 'a live authenticated Host must be reused without any ensure call')
  assert.equal(systemctlCalls.some(args => args.includes('start')), false, 'no systemctl start may be issued for a reused Host')
  assert.match(result.stdout, /^host=ready$/mu)
  assert.match(result.stdout, /^instance=11111111$/mu)
})

test('status keeps host=ready under a unit query failure but never claims process supervision', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const deps = {
    systemctl: async (args: readonly string[]): Promise<SystemctlResult> => args.includes('show') ? exited(1, '', 'bus is broken') : exited(0),
    readRecord: () => record,
    inspectProcess: () => 'alive' as const,
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, deps))
  assertCode(result, 4, /MANAGER_OR_OS_FAILURE/u)
  assert.match(result.stdout, /^host=ready$/mu, 'the authenticated readiness stays truthful')
  assert.match(result.stdout, /^user-manager=error$/mu)
  assert.match(result.stdout, /^manager=unmanaged$/mu, 'without the authoritative unit state, process supervision is unproven')
  // A warm start may reuse the authenticated Host, but it must print the SAME
  // unverified attribution instead of asserting an independent process.
  let ensured = 0
  const start = await runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    ...deps,
    ensureHost: async () => { ensured += 1; throw new Error('a ready Host must be reused') },
  }))
  assertCode(start, 0)
  assert.equal(ensured, 0)
  assert.match(start.stdout, /^host=ready$/mu)
  assert.match(start.stdout, /^manager=unmanaged$/mu)
})

test('start reports a manager error for an installed unit without falling back to a process Host', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  writeOwnedUnit(fx)
  let ensured = 0
  const result = await runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    systemctl: async args => args.includes('show') ? exited(1, '', 'bus is broken') : exited(0),
    ensureHost: async () => { ensured += 1; throw new Error('must not ensure') },
  }))
  assertCode(result, 4, /MANAGER_OR_OS_FAILURE/u)
  assert.doesNotMatch(result.stderr, /already.*committed|final verification failed/u, 'a pre-flight refusal committed no operation')
  assert.equal(ensured, 0)
})

test('start with no installed unit never depends on the user manager', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  let ensured = 0
  const calls: string[][] = []
  const result = await runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    systemctl: async args => { calls.push([...args]); return exited(1, '', 'no manager') },
    ensureHost: async () => {
      ensured += 1
      const record = recordOf(fx.scope)
      return { record, cookie: 'c', identity: record }
    },
    readRecord: () => ensured > 0 ? recordOf(fx.scope) : undefined,
    inspectProcess: () => 'alive',
    authenticate: async record => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(result, 0)
  assert.equal(ensured, 1)
  assert.deepEqual(calls, [], 'no unit means NO manager access, even on a broken manager')
  assert.match(result.stdout, /^manager=process$/mu)
})

test('restart refuses to start when the old Host exit is unconfirmed', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let ensured = 0
  let now = 0
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    readCmdline: () => `node\0${join(fx.profile.packageRoot, 'dist', 'local-host.mjs')}\0`,
    readStarttime: () => record.hostStarttime,
    kill: () => {},
    ensureHost: async () => { ensured += 1; throw new Error('must not ensure') },
    stopTimeoutMs: 100,
    sleep: async () => { now += 50 },
    now: () => now,
  }))
  assertCode(result, 5, /TRANSITION_UNCERTAIN/u)
  assert.equal(ensured, 0, 'a stop that did not settle must never be followed by a start')
})

test('restart refuses an owned unit from another installed build and leaves it untouched', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const otherBuild = 'a'.repeat(64)
  const content = renderUnitContent({
    dshHome: fx.scope.dshHome,
    profileRealpath: fx.scope.profileRealpath,
    profile: 'pi-tui',
    scopeId: fx.scope.scopeId,
    buildId: otherBuild,
    nodePath: process.execPath,
    hostEntryPath: join(fx.profile.packageRoot, 'dist', 'local-host.mjs'),
    dshAnchor: fx.profile.installAnchor,
  })
  const path = join(fx.unitDir, fx.unitName)
  writeFileSync(path, content, { mode: 0o600 })
  const systemctl = unitSystemctl(path, { activeState: 'inactive', mainPid: 0 })
  let ensured = 0
  // No live Host: the pre-flight reaches the owned-unit build check directly.
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    ensureHost: async () => { ensured += 1; throw new Error('must not start past a refused unit') },
  }))
  assertCode(result, 3, /another installed build/u)
  assert.equal(ensured, 0)
  assert.equal(readFileSync(path, 'utf8'), content, 'the other-build unit file must be untouched')
})

test('restart refuses an ACTIVE other-build Host before stopping it', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const otherBuild = 'a'.repeat(64)
  const content = renderUnitContent({
    dshHome: fx.scope.dshHome,
    profileRealpath: fx.scope.profileRealpath,
    profile: 'pi-tui',
    scopeId: fx.scope.scopeId,
    buildId: otherBuild,
    nodePath: process.execPath,
    hostEntryPath: join(fx.profile.packageRoot, 'dist', 'local-host.mjs'),
    dshAnchor: fx.profile.installAnchor,
  })
  const path = join(fx.unitDir, fx.unitName)
  writeFileSync(path, content, { mode: 0o600 })
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(path, { activeState: 'active', mainPid: record.hostPid })
  let ensured = 0
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    ensureHost: async () => { ensured += 1; throw new Error('must not start past a refused unit') },
  }))
  assertCode(result, 3, /another installed build/u)
  assert.equal(ensured, 0)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), false, 'the live other-build Host must NOT be stopped by a refused restart')
  assert.equal(readFileSync(path, 'utf8'), content, 'the other-build unit file must be untouched')
})

test('restart recovers a verified unit when the old Host authentication fails', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const oldRecord = recordOf(fx.scope)
  const newRecord = recordOf(fx.scope, { instanceId: '33333333-3333-4333-8333-333333333333', hostPid: 6363 })
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: oldRecord.hostPid })
  let stopped = false
  let ensured = 0
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    systemctl: async args => {
      const outcome = await systemctl.run(args)
      if (args.includes('stop')) stopped = true
      return outcome
    },
    readRecord: () => (stopped ? (ensured > 0 ? newRecord : undefined) : oldRecord),
    inspectProcess: recordValue => (recordValue?.instanceId === newRecord.instanceId ? 'alive' : stopped ? 'dead' : 'alive'),
    authenticate: async recordValue => {
      if (recordValue.instanceId === oldRecord.instanceId) throw new LocalScopeError('HOST_AUTH_FAILED', 'tampered launch material')
      return { record: recordValue, cookie: 'c', identity: recordValue }
    },
    ensureHost: async () => { ensured += 1; return { record: newRecord, cookie: 'c', identity: newRecord } },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.equal(ensured, 1)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), true, 'the verified old unit must be stopped')
  assert.match(result.stdout, /^instance=33333333$/mu)
})

test('restart refuses an unmatched live Host even when authentication failed', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const oldRecord = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: 9999 })
  let ensured = 0
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => oldRecord,
    inspectProcess: () => 'alive',
    authenticate: async () => { throw new LocalScopeError('HOST_AUTH_FAILED', 'tampered launch material') },
    ensureHost: async () => { ensured += 1; throw new Error('must not start a second Host past an unmatched supervisor') },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(ensured, 0)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), false, 'an unmatched unit is not stopped as the old Host')
})

test('restart starts a fresh authenticated instance after the old Host stopped', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const oldRecord = recordOf(fx.scope)
  const newRecord = recordOf(fx.scope, { instanceId: '22222222-2222-4222-8222-222222222222', hostPid: 5252 })
  let alive = true
  let ensured = 0
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    // Before ensureHost runs the old registry is still the only candidate; after
    // the start it must resolve to the NEW instance.
    readRecord: () => alive ? oldRecord : (ensured > 0 ? newRecord : undefined),
    inspectProcess: recordValue => recordValue === undefined ? 'dead' : 'alive',
    authenticate: async recordValue => ({ record: recordValue, cookie: 'c', identity: recordValue }),
    readCmdline: () => `node\0${join(fx.profile.packageRoot, 'dist', 'local-host.mjs')}\0`,
    readStarttime: () => alive ? oldRecord.hostStarttime : undefined,
    kill: () => { alive = false },
    ensureHost: async () => { ensured += 1; return { record: newRecord, cookie: 'c', identity: newRecord } },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.equal(ensured, 1)
  assert.match(result.stdout, /^instance=22222222$/mu)
})

// ── logs ────────────────────────────────────────────────────────────────────

test('logs reads the verified unit journal and strips ANSI plus token material', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const result = await runDaemonControl({ verb: 'logs', lines: 50 }, fx.profile, depsOf(fx, {
    systemctl: unitSystemctl(unit.path).run,
    journal: async () => ({ code: 0, stdout: '\u001b[31mtoken=SECRET\u001b[0m host started\n', stderr: '' }),
  }))
  assertCode(result, 0)
  assert.doesNotMatch(result.stdout, /\u001b/u)
  assert.doesNotMatch(result.stdout, /SECRET/u)
  assert.match(result.stdout, /host started/u)
  assert.match(result.stderr, /best-effort sanitized/u)
})

test('logs refuses an unavailable unit journal and never falls back to raw files', async t => {
  const fx = fixture(t)
  writeOwnedUnit(fx)
  let fellBack = 0
  const result = await runDaemonControl({ verb: 'logs' }, fx.profile, depsOf(fx, {
    systemctl: unitSystemctl(join(fx.unitDir, fx.unitName)).run,
    journal: async () => ({ code: 1, stdout: '', stderr: 'no journal' }),
    hostLogTail: async () => { fellBack += 1; return 'raw' },
  }))
  assertCode(result, 4, /LOG_SOURCE_UNAVAILABLE/u)
  assert.equal(fellBack, 0)
})

test('logs reads the scope host.log when no unit is installed', async t => {
  const fx = fixture(t)
  const result = await runDaemonControl({ verb: 'logs', lines: 5 }, fx.profile, depsOf(fx, {
    hostLogTail: async (path, lines) => {
      assert.equal(path, join(fx.scope.dir, 'host.log'))
      assert.equal(lines, 5)
      return 'independent line\n'
    },
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /independent line/u)
})

test('logs reads the host.log of an independent Host beside an installed but unloaded unit', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  let journalReads = 0
  const result = await runDaemonControl({ verb: 'logs', lines: 5 }, fx.profile, depsOf(fx, {
    systemctl: unitSystemctl(unit.path, { loadState: 'not-found', activeState: 'inactive', mainPid: 0 }).run,
    journal: async () => { journalReads += 1; return { code: 0, stdout: 'stale journal\n', stderr: '' } },
    hostLogTail: async () => 'real host.log line\n',
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /real host.log line/u)
  assert.equal(journalReads, 0, 'an unloaded unit has no journal source')
})

test('logs reads the journal of a loaded inactive unit when no Host is live', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  let journalUnit = ''
  const result = await runDaemonControl({ verb: 'logs' }, fx.profile, depsOf(fx, {
    systemctl: unitSystemctl(unit.path, { activeState: 'inactive', mainPid: 0 }).run,
    journal: async (unitName) => { journalUnit = unitName; return { code: 0, stdout: 'inactive unit log\n', stderr: '' } },
    hostLogTail: async () => { throw new Error('must not read host.log for a loaded unit') },
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /inactive unit log/u)
  assert.equal(journalUnit, unitName(fx))
})

test('logs refuses a journal whose manager FragmentPath is not the owned file', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const other = join(fx.unitDir, 'other.service')
  let journalReads = 0
  const result = await runDaemonControl({ verb: 'logs' }, fx.profile, depsOf(fx, {
    systemctl: unitSystemctl(unit.path, { fragmentPath: other }).run,
    journal: async () => { journalReads += 1; return { code: 0, stdout: 'foreign entries\n', stderr: '' } },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(journalReads, 0, 'a journal from a different loaded unit must never be read')
  assert.equal(existsSync(unit.path), true)
})

test('logs refuses to guess when the unit MainPID is not the authenticated Host', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  let journalReads = 0
  let hostLogReads = 0
  const result = await runDaemonControl({ verb: 'logs' }, fx.profile, depsOf(fx, {
    systemctl: unitSystemctl(unit.path, { activeState: 'active', mainPid: 9999 }).run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    journal: async () => { journalReads += 1; return { code: 0, stdout: 'x\n', stderr: '' } },
    hostLogTail: async () => { hostLogReads += 1; return 'x\n' },
  }))
  assertCode(result, 4, /LOG_SOURCE_UNAVAILABLE/u)
  assert.equal(journalReads, 0)
  assert.equal(hostLogReads, 0)
})

test('logs refuses when the manager state of an installed unit cannot be read', async t => {
  const fx = fixture(t)
  writeOwnedUnit(fx)
  let hostLogReads = 0
  const result = await runDaemonControl({ verb: 'logs' }, fx.profile, depsOf(fx, {
    systemctl: async args => args.includes('show') ? exited(1, '', 'bus broke') : exited(0),
    hostLogTail: async () => { hostLogReads += 1; return 'x\n' },
  }))
  assertCode(result, 4, /LOG_SOURCE_UNAVAILABLE/u)
  assert.equal(hostLogReads, 0, 'ownership cannot be proven, so no log source is guessed')
})

test('logs reports no available log source without inventing one', async t => {
  const fx = fixture(t)
  const result = await runDaemonControl({ verb: 'logs' }, fx.profile, depsOf(fx, {
    hostLogTail: async () => undefined,
  }))
  assertCode(result, 4, /LOG_SOURCE_UNAVAILABLE/u)
})

function unitName(fx: Fixture): string {
  return buildUnitName(fx.profile.name, fx.scope.scopeId)
}

test('journalctl selects the USER unit field, not the system unit field', () => {
  // `--user --unit X` filters `_SYSTEMD_UNIT` and therefore never matches a
  // user unit's entries: it exits 0 with empty output on a real host. The user
  // unit field is selected by `--user-unit` (`_SYSTEMD_USER_UNIT`).
  const args = journalctlArgs('pi-tui-x.service', 20)
  assert.deepEqual(args, ['--user-unit', 'pi-tui-x.service', '--no-pager', '-o', 'cat', '-n', '20'])
  assert.equal(args.includes('--unit'), false, 'the system-unit selector must never be used for a user unit')
})

test('sanitizeLogText redacts the whole credential value behind common header schemes', () => {
  const text = [
    'GET http://127.0.0.1:4517/connect?token=QUERYSECRET',
    'Authorization: Bearer HEADERSECRET',
    'Proxy-Authorization: Basic UHJveHlTZWNyZXQ=',
    'X-Api-Key: APISECRET',
    'Cookie: sid=COOKIESECRET; token=COOKIETOKEN',
    'Set-Cookie: session=SETCOOKIESECRET',
    'password: MULTI WORD SECRET',
    'api_key=GENERICSECRET',
    'normal line',
  ].join('\r\n')
  const out = sanitizeLogText(text)
  for (const secret of [
    'QUERYSECRET',
    'HEADERSECRET',
    'UHJveHlTZWNyZXQ=',
    'APISECRET',
    'COOKIESECRET',
    'COOKIETOKEN',
    'SETCOOKIESECRET',
    'MULTI WORD SECRET',
    'GENERICSECRET',
  ]) {
    assert.equal(out.includes(secret), false, `the sanitized output must not contain ${secret}`)
  }
  assert.match(out, /normal line/u)
})

// ── install ─────────────────────────────────────────────────────────────────

test('install writes this profile unit without starting, stopping or migrating an independent Host', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  const calls: string[][] = []
  const systemctl = async (args: readonly string[]): Promise<SystemctlResult> => {
    calls.push([...args])
    if (args.includes('UnitPath')) return exited(0, fx.unitDir)
    if (args.includes('daemon-reload')) return exited(0)
    if (args.includes('show')) {
      return exited(0, [`LoadState=loaded`, 'ActiveState=inactive', `FragmentPath=${join(fx.unitDir, fx.unitName)}`, 'DropInPaths=', 'MainPID=0', 'UnitFileState=disabled', ''].join('\n'))
    }
    return exited(0)
  }
  const result = await runDaemonControl({ verb: 'install' }, fx.profile, depsOf(fx, {
    systemctl,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(result, 0)
  assert.equal(existsSync(join(fx.unitDir, fx.unitName)), true, 'the unit file must be installed')
  assert.match(result.stdout, /^manager=process$/mu, 'the running independent Host is not migrated')
  assert.match(result.stdout, /^instance=11111111$/mu, 'the running Host instance is unchanged')
  assert.equal(calls.some(args => args.includes('start')), false, 'install must never start the unit')
  assert.equal(calls.some(args => args.includes('stop')), false, 'install must never stop anything')
  assert.equal(calls.some(args => args.includes('enable')), false, 'install must never enable the unit')
  assert.equal(existsSync(fx.scope.dir), false, 'install must not create the runtime scope directory')
})

test('a repeat install of the same unit is idempotent', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const systemctl = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('UnitPath')) return exited(0, fx.unitDir)
    if (args.includes('daemon-reload')) return exited(0)
    if (args.includes('show')) {
      return exited(0, [`LoadState=loaded`, 'ActiveState=inactive', `FragmentPath=${join(fx.unitDir, fx.unitName)}`, 'DropInPaths=', 'MainPID=0', 'UnitFileState=disabled', ''].join('\n'))
    }
    return exited(0)
  }
  const first = await runDaemonControl({ verb: 'install' }, fx.profile, depsOf(fx, { systemctl }))
  assertCode(first, 0)
  const second = await runDaemonControl({ verb: 'install' }, fx.profile, depsOf(fx, { systemctl }))
  assertCode(second, 0)
  assert.equal(existsSync(join(fx.unitDir, fx.unitName)), true)
})

test('install refuses a foreign unit without overwriting it', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  writeFileSync(unit.path, unit.content.replace('X-DshPiTuiOwner=local-host-manager-v1', 'X-DshPiTuiOwner=someone-else'), { mode: 0o600 })
  const result = await runDaemonControl({ verb: 'install' }, fx.profile, depsOf(fx, {
    systemctl: async args => args.includes('UnitPath') ? exited(0, fx.unitDir) : exited(0),
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.match(readFileSync(unit.path, 'utf8'), /X-DshPiTuiOwner=someone-else/u, 'a foreign unit is never overwritten')
})

test('install refuses an unusable user manager instead of writing a unit', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const result = await runDaemonControl({ verb: 'install' }, fx.profile, depsOf(fx, {
    systemctl: async args => args.includes('UnitPath') ? exited(1, '', 'Failed to connect to bus: No such file or directory') : exited(0),
  }))
  assertCode(result, 4, /MANAGER_OR_OS_FAILURE/u)
  assert.equal(existsSync(join(fx.unitDir, fx.unitName)), false, 'no unit may be written without a working manager')
})

// ── uninstall ───────────────────────────────────────────────────────────────

test('uninstall with no owned unit leaves an independent Host untouched and claims no interruption', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let signals = 0
  const systemctlCalls: string[][] = []
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, {
    systemctl: async args => { systemctlCalls.push([...args]); return exited(0) },
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    kill: () => { signals += 1 },
  }))
  assertCode(result, 0)
  assert.equal(signals, 0, 'uninstall never kills an independent Host')
  assert.deepEqual(systemctlCalls, [], 'no unit means no manager call')
  assert.equal(result.stderr, '', 'an idempotent uninstall must not claim an interrupted Session')
})

test('uninstall with no unit is an idempotent no-op even when the Host registry is unreadable', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const calls: string[][] = []
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, {
    systemctl: async args => { calls.push([...args]); return exited(0) },
    readRecord: () => { throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'registry is unsafe') },
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^unit=none$/mu)
  assert.deepEqual(calls, [], 'uninstall owns only the unit definition; a broken Host registry needs no manager call')
})

test('uninstall with no unit does not signal an unauthenticated live Host', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let signals = 0
  const calls: string[][] = []
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, {
    systemctl: async args => { calls.push([...args]); return exited(0) },
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => { throw new LocalScopeError('HOST_AUTH_FAILED', 'tampered launch material') },
    kill: () => { signals += 1 },
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^unit=none$/mu)
  assert.equal(signals, 0, 'no unit means uninstall never signals a Host')
  assert.deepEqual(calls, [], 'no unit means uninstall never queries the manager')
})

test('uninstall removes an inactive owned unit without killing an unrelated independent Host', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope, { hostPid: 7777 })
  const systemctl = unitSystemctl(unit.path, { activeState: 'inactive', mainPid: 0 })
  let signals = 0
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    kill: () => { signals += 1 },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.equal(existsSync(unit.path), false, 'the inactive owned unit file must be removed')
  assert.equal(signals, 0, 'an unrelated independent Host must not be signalled')
  assert.equal(result.stderr, '', 'removing an inactive unit must not claim an interrupted Session')
})

test('uninstall stops and removes only the verified profile unit, then reloads', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: 4242 })
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.equal(existsSync(unit.path), false, 'the owned unit file must be removed')
  assert.equal(systemctl.calls.some(args => args.includes('stop')), true)
  assert.equal(systemctl.calls.some(args => args.includes('daemon-reload')), true)
  assert.match(result.stderr, /may interrupt a running Session/u, 'stopping a live unit keeps the risk notice')
  assert.equal(existsSync(join(fx.scope.dir, 'instance.json')), false)
})

test('uninstall removes a verified unit when Host authentication fails, without a PID signal', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: record.hostPid })
  let stopped = false
  let signals = 0
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, {
    systemctl: async args => {
      const outcome = await systemctl.run(args)
      if (args.includes('stop')) stopped = true
      return outcome
    },
    readRecord: () => (stopped ? undefined : record),
    inspectProcess: () => (stopped ? 'dead' : 'alive'),
    authenticate: async () => { throw new LocalScopeError('HOST_AUTH_FAILED', 'tampered launch material') },
    kill: () => { signals += 1 },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 0)
  assert.equal(existsSync(unit.path), false, 'the verified unit path must be removed')
  assert.equal(systemctl.calls.some(args => args.includes('stop')), true)
  assert.equal(systemctl.calls.some(args => args.includes('daemon-reload')), true)
  assert.equal(signals, 0, 'uninstall never falls back to an unverified PID signal')
  assert.equal(existsSync(join(fx.scope.dir, 'instance.json')), false, 'uninstall must not create registry state')
})

test('uninstall still refuses an unverified unit when Host authentication fails', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  writeFileSync(unit.path, unit.content.replace('X-DshPiTuiOwner=local-host-manager-v1', 'X-DshPiTuiOwner=someone-else'), { mode: 0o600 })
  const record = recordOf(fx.scope)
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => { throw new LocalScopeError('HOST_AUTH_FAILED', 'tampered launch material') },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(existsSync(unit.path), true, 'an unverified unit is never removed')
})

test('uninstall refuses a live Host whose verified unit MainPID differs', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: 9999 })
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => { throw new LocalScopeError('HOST_AUTH_FAILED', 'tampered launch material') },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), false, 'a mismatched unit must not be stopped')
  assert.equal(systemctl.calls.some(args => args.includes('daemon-reload')), false, 'a refused uninstall must not reload')
  assert.equal(existsSync(unit.path), true, 'a mismatched unit path must remain')
})

test('uninstall refuses an owned unit from another installed build', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const content = renderUnitContent({
    dshHome: fx.scope.dshHome,
    profileRealpath: fx.scope.profileRealpath,
    profile: 'pi-tui',
    scopeId: fx.scope.scopeId,
    buildId: 'a'.repeat(64),
    nodePath: process.execPath,
    hostEntryPath: join(fx.profile.packageRoot, 'dist', 'local-host.mjs'),
    dshAnchor: fx.profile.installAnchor,
  })
  const path = join(fx.unitDir, fx.unitName)
  writeFileSync(path, content, { mode: 0o600 })
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, {
    systemctl: unitSystemctl(path, { activeState: 'inactive', mainPid: 0 }).run,
  }))
  assertCode(result, 3, /another installed build/u)
  assert.equal(existsSync(path), true, 'a refused old-build uninstall must not remove or rewrite the unit')
})

test('start does not report success when the new Host fails the post-snapshot ownership check', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  let ensured = 0
  let postPhase = false
  // Pre: no Host, an inactive owned unit (a legal cold start). Post: the Host is
  // authenticated BUT the manager's MainPID belongs to a different process.
  const systemctlWithPost = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('show')) {
      return exited(0, [
        'LoadState=loaded',
        `ActiveState=active`,
        `FragmentPath=${unit.path}`,
        'DropInPaths=',
        `MainPID=${String(postPhase ? 9999 : 0)}`,
        'UnitFileState=disabled',
        '',
      ].join('\n'))
    }
    return exited(0)
  }
  const result = await runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    systemctl: systemctlWithPost,
    readRecord: () => (ensured > 0 ? record : undefined),
    inspectProcess: recordValue => recordValue === undefined ? 'dead' : 'alive',
    authenticate: async recordValue => ({ record: recordValue, cookie: 'c', identity: recordValue }),
    ensureHost: async () => { ensured += 1; postPhase = true; return { record, cookie: 'c', identity: record } },
    sleep: async () => {},
    now: () => 0,
  }))
  assert.equal(ensured, 1, 'the cold start must have run ensure exactly once')
  assertCode(result, 3, /unit MainPID is not the authenticated Host/u)
  assert.match(result.stderr, /may already be committed; final verification failed/u)
  assert.match(result.stderr, /daemon status/u)
  assert.doesNotMatch(result.stdout, /^host=ready$/mu)
})

test('stop reports committed-but-unconfirmed when the post-snapshot manager query fails', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: 4242 })
  let queries = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    systemctl: async args => {
      if (args.includes('show')) {
        queries += 1
        // Pre-flight (1), stop settlement before state (2) and its post-stop
        // state (3) must succeed; the FINAL post-snapshot query (4) fails.
        if (queries > 3) return exited(1, '', 'bus failed after stop')
      }
      return await systemctl.run(args)
    },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 4, /Host stop may already be committed/u)
  assert.match(result.stderr, /unit state could not be queried/u)
  assert.match(result.stderr, /Run daemon status before retrying/u)
  assert.equal(systemctl.calls.filter(args => args.includes('stop')).length, 1)
  assert.equal(existsSync(unit.path), true, 'stop must never remove the owned unit')
})

test('uninstall verifies the unit file is gone without querying the manager again', { skip: process.platform !== 'linux' }, async t => {
  // After the verified unit file is removed there is no installed unit left, so
  // the post-verification must NOT issue another manager query: the removal fact
  // is checked directly on the verified path.
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  let showCalls = 0
  const systemctl = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('show')) showCalls += 1
    if (args.includes('daemon-reload')) return exited(0)
    return exited(0, [
      'LoadState=loaded',
      'ActiveState=inactive',
      `FragmentPath=${unit.path}`,
      'DropInPaths=',
      'MainPID=0',
      'UnitFileState=disabled',
      '',
    ].join('\n'))
  }
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, { systemctl }))
  assertCode(result, 0)
  assert.equal(existsSync(unit.path), false)
  assert.equal(showCalls, 1, 'only the pre-flight snapshot queries the manager')
})

test('uninstall reports a failed daemon-reload instead of claiming completion', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'inactive', mainPid: 0, reloadResult: exited(1, '', 'reload failed') })
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, { systemctl: systemctl.run }))
  assertCode(result, 4, /MANAGER_OR_OS_FAILURE/u)
  assert.match(result.stderr, /profile unit removal may already be committed; final verification failed/u)
  assert.match(result.stderr, /Run daemon status before retrying/u)
  assert.equal(existsSync(unit.path), false, 'the file removal itself is recorded before the reload failure')
})

// ── output contract ─────────────────────────────────────────────────────────

test('the status block is stable key=value text and never prints the DSH home path', async t => {
  const fx = fixture(t)
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx))
  assertCode(result, 0)
  const lines = result.stdout.trimEnd().split('\n')
  for (const line of lines) assert.match(line, /^[a-z-]+=/u)
  assert.equal(result.stdout.includes(fx.profile.home), false)
})

test('formatDaemonStatus keeps an abbreviated instance identity only', () => {
  const text = formatDaemonStatus({
    profile: 'pi-tui',
    manager: 'systemd',
    userManager: 'available',
    host: 'ready',
    unit: 'dsh-pi-tui@pi-tui-abc.service',
    unitState: 'active',
    compatibility: 'compatible',
    pid: 12,
    instance: 'abcdef12',
  })
  assert.match(text, /^instance=abcdef12$/mu)
  assert.equal(text.includes(UUID), false)
})
