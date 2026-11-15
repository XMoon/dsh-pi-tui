/**
 * M6-2C daemon management control plane: the read-only status classification,
 * the fixed error/exit taxonomy, the explicit stop/restart/uninstall actions and
 * the log source rules, exercised with injected OS/discovery seams.
 *
 * Evidence level: structural (L1-L3). These prove the control module's
 * source -> decision -> sink contract; the real systemd/absent/manager-error OS
 * evidence lives in the selectable split-process lane, never here.
 * @module @xmoon76/dsh-pi-tui/daemon-control.test
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  inspectInstalledProfileScope,
  LOCAL_PROTOCOL,
  LocalScopeError,
  readLinuxStarttime,
  type LocalScope,
} from '../../src/app/remote-process/local-scope.ts'
import {
  buildUnitName,
  renderUnitContent,
  type SystemctlResult,
  type UserManagerProbe,
} from '../../src/app/remote-process/local-host-manager.ts'
import {
  formatDaemonStatus,
  journalctlArgs,
  runDaemonControl,
  sanitizeLogText,
  type DaemonControlDeps,
  type DaemonControlProfile,
} from '../../src/app/remote-process/local-daemon-control.ts'
import type { LocalInstanceRecord } from '../../src/app/remote-process/local-discovery.ts'

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
}

function fixture(t: TestContext): Fixture {
  const root = testLifecycle(t).tempDir('m62c-control-')
  const home = join(root, 'dsh-home')
  const profileDir = join(root, 'profiles', 'pi-tui')
  const packageRoot = join(root, 'package')
  const anchor = join(root, 'dsh', 'package.json')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(packageRoot, 'dist'), { recursive: true, mode: 0o700 })
  mkdirSync(join(root, 'dsh'), { recursive: true, mode: 0o700 })
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
  return { profile, scope, unitDir, unitName: buildUnitName(profile.name, scope.scopeId) }
}

function recordOf(scope: LocalScope, overrides: Partial<LocalInstanceRecord> = {}): LocalInstanceRecord {
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
  stopResult?: SystemctlResult
  reloadResult?: SystemctlResult
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
    if (args.includes('daemon-reload')) return initial.reloadResult ?? exited(0)
    if (args.includes('stop')) {
      if (initial.stopResult !== undefined) return initial.stopResult
      state.activeState = 'inactive'
      state.mainPid = 0
      return exited(0)
    }
    if (args.includes('show')) {
      return exited(0, [
        `LoadState=${state.loadState}`,
        `ActiveState=${state.activeState}`,
        `FragmentPath=${state.loadState === 'not-found' ? '' : path}`,
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
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'available' }),
    systemctl: unitSystemctl(join(fx.unitDir, fx.unitName)).run,
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
    ...overrides,
  }
}

function assertCode(result: { code: number; stdout: string; stderr: string }, code: number, pattern?: RegExp): void {
  assert.equal(result.code, code, `expected exit ${String(code)}, got ${String(result.code)}; stderr=${result.stderr}`)
  if (pattern !== undefined) assert.match(`${result.stdout}${result.stderr}`, pattern)
}

// ── status: read-only classification ────────────────────────────────────────

test('status with no Host reports stopped and creates no run directory', async t => {
  const fx = fixture(t)
  assert.equal(existsSync(fx.scope.dir), false, 'the fixture must start without a run directory')
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx))
  assertCode(result, 0)
  assert.match(result.stdout, /^profile=pi-tui$/mu)
  assert.match(result.stdout, /^manager=unmanaged$/mu)
  assert.match(result.stdout, /^user-manager=available$/mu)
  assert.match(result.stdout, /^host=stopped$/mu)
  assert.match(result.stdout, /^unit=none$/mu)
  assert.match(result.stdout, /^unit-state=not-found$/mu)
  assert.match(result.stdout, /^compatibility=none$/mu)
  assert.equal(existsSync(fx.scope.dir), false, 'status must never create the scope run directory')
})

test('an active unit without an authenticated Host reports starting, never ready', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'active', mainPid: 9001 })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, { systemctl: systemctl.run }))
  assertCode(result, 0)
  assert.match(result.stdout, /^host=starting$/mu)
  assert.match(result.stdout, /^manager=systemd$/mu)
  assert.match(result.stdout, /^unit-state=active$/mu)
  assert.doesNotMatch(result.stdout, /^host=ready$/mu)
})

test('status reports an absent manager with a stale unit file as unmanaged, never systemd', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }),
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^user-manager=absent$/mu)
  assert.match(result.stdout, /^manager=unmanaged$/mu, 'a unit FILE on disk is not supervision: the absent manager loads nothing')
  assert.match(result.stdout, /^unit-state=unknown$/mu)
  assert.match(result.stdout, /^host=stopped$/mu)
  assert.equal(existsSync(unit.path), true)
})

test('status reports an authenticated Host under a deactivating unit as uncertain, never success', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  const systemctl = unitSystemctl(unit.path, { activeState: 'deactivating', mainPid: record.hostPid })
  let ensured = 0
  const status = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  assertCode(status, 5, /TRANSITION_UNCERTAIN/u)
  assert.match(status.stdout, /^host=unknown$/mu)
  assert.doesNotMatch(status.stdout, /^host=ready$/mu, 'an authenticated handshake cannot outrank an unconfirmed supervisor')
  // start must NOT reuse a Host the manager is retiring, and must not start one.
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
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
  }))
  assert.doesNotMatch(result.stdout, /^host=stopped$/mu, 'an activating unit is not a stopped Host')
  assert.match(result.stdout, /^host=starting$/mu)
  assert.match(result.stdout, /^unit-state=unknown$/mu)
  assert.match(result.stdout, /^manager=systemd$/mu)
})

test('status reports an unconfirmed transitional unit state as unknown and nonzero', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'deactivating', mainPid: 0 })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
  }))
  assertCode(result, 5, /TRANSITION_UNCERTAIN/u)
  assert.match(result.stdout, /^host=unknown$/mu)
  assert.doesNotMatch(result.stdout, /^host=stopped$/mu)
  assert.match(result.stdout, /^manager=systemd$/mu)
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
    assertCode(result, 3, /does not supervise the authenticated Host/u)
    assert.match(result.stdout, /^host=ready$/mu, `MainPID=${String(mainPid)}: the Ready observation itself stays truthful`)
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
    assert.match(result.stdout, /^host=unknown$/mu, `${activeState} must not report a confirmed Host`)
    assert.doesNotMatch(result.stdout, /^host=ready$/mu)
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
  // An unloaded file loads nothing, so it neither supervises nor disclaims the
  // Host: this is the ordinary live fallback under a live manager.
  const status = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, deps))
  assertCode(status, 0)
  assert.match(status.stdout, /^host=ready$/mu)
  assert.match(status.stdout, /^manager=unmanaged$/mu)
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
  // stop must refuse: an unloaded file grants no supervision attribution.
  let signals = 0
  const stop = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    ...deps,
    kill: () => { signals += 1 },
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(stop, 3)
  assert.equal(signals, 0, 'no PID signal without a supervision attribution')
  assert.equal(systemctl.calls.some(args => args.includes('stop')), false, 'no systemctl stop without a loaded unit')
  assert.equal(existsSync(unit.path), true, 'the unowned-by-manager file must stay untouched')
})

test('an inactive owned unit with no Host is stopped and stop stays an idempotent no-op', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'inactive', mainPid: 0 })
  const status = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
  }))
  assertCode(status, 0)
  assert.match(status.stdout, /^host=stopped$/mu)
  assert.match(status.stdout, /^manager=systemd$/mu)
  assert.match(status.stdout, /^unit-state=inactive$/mu)
  const stop = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(stop, 0)
  assert.equal(systemctl.calls.some(args => args.includes('stop')), false, 'an inactive unit needs no stop call')
  assert.equal(existsSync(unit.path), true, 'stop must never remove the unit file')
})

test('a unit file the manager has not loaded gets no supervision attribution', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { loadState: 'not-found', activeState: 'inactive', mainPid: 0 })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    systemctl: systemctl.run,
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /^unit-state=not-found$/mu)
  assert.match(result.stdout, /^manager=unmanaged$/mu, 'an unloaded file is not systemd supervision')
  assert.equal(existsSync(unit.path), true)
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

test('a live fallback Host under a now-available manager is unmanaged, not the inactive unit owner', async t => {
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
  assert.match(result.stdout, /^manager=unmanaged$/mu)
})

test('a user-manager error is nonzero and never reported as stopped', async t => {
  const fx = fixture(t)
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'error', reason: 'connection refused' }),
  }))
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

test('a foreign or unsafe unit file is refused before any Host claim', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  writeFileSync(unit.path, unit.content.replace('X-DshPiTuiOwner=local-host-manager-v1', 'X-DshPiTuiOwner=someone-else'), { mode: 0o600 })
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.doesNotMatch(result.stdout, /^host=ready$/mu)
})

test('a symlinked unit file is refused, not followed', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const real = join(fx.unitDir, 'real.service')
  writeFileSync(real, unit.content, { mode: 0o600 })
  const { unlinkSync } = await import('node:fs')
  unlinkSync(unit.path)
  symlinkSync(real, unit.path)
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
})

test('an unsupported platform exits 3 before touching the filesystem', async t => {
  const fx = fixture(t)
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, { platform: 'darwin' })
  assertCode(result, 3, /UNSUPPORTED_PLATFORM/u)
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

test('stop refuses a live Host with no verifiable supervision attribution', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let signals = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    kill: () => { signals += 1 },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(signals, 0, 'an unverifiable Host is never signalled')
})

test('the fallback process identity check reads a real procfs cmdline despite st_size=0', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  // The production default reads THIS process's real /proc/<pid>/cmdline, which
  // reports st_size = 0: a size-based read returns an empty string and would
  // refuse every real fallback Host. Node's own argv must come back intact.
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }),
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

test('stop sends one SIGTERM to the authenticated strict-absence Host PID', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let alive = true
  const signals: Array<[number, NodeJS.Signals]> = []
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }),
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

test('stop refuses a non-Host command line and never signals it', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let signals = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }),
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
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }),
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

test('a stop that cannot confirm the Host exit is TRANSITION_UNCERTAIN, not stopped', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let now = 0
  const result = await runDaemonControl({ verb: 'stop' }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }),
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
  const controller = new AbortController()
  let releaseProbe: (() => void) | undefined
  const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
  let probeEntered = false
  let ensured = 0
  const resultPromise = runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    signal: controller.signal,
    probe: async (): Promise<UserManagerProbe> => {
      probeEntered = true
      await probeGate
      return { kind: 'available' }
    },
    ensureHost: async () => { ensured += 1; throw new Error('must not start after abort') },
  }))
  await waitUntil(() => probeEntered)
  controller.abort()
  releaseProbe?.()
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
  let releaseProbe: (() => void) | undefined
  const probeGate = new Promise<void>(resolve => { releaseProbe = resolve })
  let probeEntered = false
  let ensured = 0
  const resultPromise = runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    signal: controller.signal,
    systemctl: systemctl.run,
    probe: async (): Promise<UserManagerProbe> => {
      probeEntered = true
      await probeGate
      return { kind: 'available' }
    },
    ensureHost: async () => { ensured += 1; throw new Error('must not start after abort') },
  }))
  await waitUntil(() => probeEntered)
  controller.abort()
  releaseProbe?.()
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
  const record = recordOf(fx.scope)
  let ensured = 0
  const systemctlCalls: string[][] = []
  const result = await runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'error', reason: 'bus is broken' }),
    systemctl: async args => { systemctlCalls.push([...args]); return { kind: 'exited', code: 0, stdout: '', stderr: '' } },
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    ensureHost: async () => { ensured += 1; throw new Error('a live Host must be reused, not re-ensured') },
  }))
  assertCode(result, 0)
  assert.equal(ensured, 0, 'a live authenticated Host must be reused without any ensure call')
  assert.equal(systemctlCalls.length, 0, 'no systemctl start may be issued for a reused Host')
  assert.match(result.stdout, /^host=ready$/mu)
  assert.match(result.stdout, /^instance=11111111$/mu)
})

test('status keeps host=ready under a manager error but still exits 4 per its contract', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  const result = await runDaemonControl({ verb: 'status' }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'error', reason: 'bus is broken' }),
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
  }))
  // The Host observation stays truthful; the supervisor state is unconfirmed,
  // so the diagnostic command stays nonzero (plan §3.2/§3.3).
  assertCode(result, 4, /MANAGER_OR_OS_FAILURE/u)
  assert.match(result.stdout, /^host=ready$/mu)
  assert.match(result.stdout, /^user-manager=error$/mu)
})

test('start reports a manager error without falling back to a process Host', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  let ensured = 0
  const result = await runDaemonControl({ verb: 'start' }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'error', reason: 'bus is broken' }),
    ensureHost: async () => { ensured += 1; throw new Error('must not ensure') },
  }))
  assertCode(result, 4, /MANAGER_OR_OS_FAILURE/u)
  assert.equal(ensured, 0)
})

test('restart refuses to start when the old Host exit is unconfirmed', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let ensured = 0
  let now = 0
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }),
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
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
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

test('restart starts a fresh authenticated instance after the old Host stopped', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const oldRecord = recordOf(fx.scope)
  const newRecord = recordOf(fx.scope, { instanceId: '22222222-2222-4222-8222-222222222222', hostPid: 5252 })
  let alive = true
  let ensured = 0
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }),
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
    journal: async () => ({ code: 1, stdout: '', stderr: 'no journal' }),
    hostLogTail: async () => { fellBack += 1; return 'raw' },
  }))
  assertCode(result, 4, /LOG_SOURCE_UNAVAILABLE/u)
  assert.equal(fellBack, 0)
})

test('logs refuses a unit the manager has not loaded as this profile unit', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  let journalReads = 0
  const result = await runDaemonControl({ verb: 'logs' }, fx.profile, depsOf(fx, {
    systemctl: unitSystemctl(unit.path, { loadState: 'not-found' }).run,
    journal: async () => { journalReads += 1; return { code: 0, stdout: 'entries\n', stderr: '' } },
  }))
  assertCode(result, 4, /LOG_SOURCE_UNAVAILABLE/u)
  assert.equal(journalReads, 0, 'an unloaded foreign unit journal must never be read')
})

test('logs reads the strict-absence private host.log only without a manager', async t => {
  const fx = fixture(t)
  const result = await runDaemonControl({ verb: 'logs', lines: 5 }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }),
    hostLogTail: async (path, lines) => {
      assert.equal(path, join(fx.scope.dir, 'host.log'))
      assert.equal(lines, 5)
      return 'fallback line\n'
    },
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /fallback line/u)
})

test('logs reads the strict-absence host.log even when an owned unit file remains on disk', async t => {
  const fx = fixture(t)
  writeOwnedUnit(fx)
  let journalReads = 0
  const result = await runDaemonControl({ verb: 'logs', lines: 5 }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }),
    journal: async () => { journalReads += 1; return { code: 0, stdout: 'stale journal\n', stderr: '' } },
    hostLogTail: async () => 'real fallback line\n',
  }))
  assertCode(result, 0)
  assert.match(result.stdout, /real fallback line/u)
  assert.equal(journalReads, 0, 'a strictly absent manager cannot serve the stale unit journal')
})

test('logs refuses a journal whose manager FragmentPath is not the owned file', async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const other = join(fx.unitDir, 'other.service')
  let journalReads = 0
  const result = await runDaemonControl({ verb: 'logs' }, fx.profile, depsOf(fx, {
    systemctl: unitSystemctl(other).run,
    journal: async () => { journalReads += 1; return { code: 0, stdout: 'foreign entries\n', stderr: '' } },
  }))
  assertCode(result, 3, /IDENTITY_OR_OWNERSHIP_REFUSED/u)
  assert.equal(journalReads, 0, 'a journal from a different loaded unit must never be read')
  assert.equal(existsSync(unit.path), true)
})

test('logs refuses a private file when a user manager exists without an owned unit', async t => {
  const fx = fixture(t)
  const result = await runDaemonControl({ verb: 'logs' }, fx.profile, depsOf(fx, {
    hostLogTail: async () => { throw new Error('must not read') },
  }))
  assertCode(result, 4, /LOG_SOURCE_UNAVAILABLE/u)
})

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

// ── uninstall ───────────────────────────────────────────────────────────────

test('uninstall with no owned unit leaves a strict-absence Host untouched', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const record = recordOf(fx.scope)
  let signals = 0
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, {
    probe: async (): Promise<UserManagerProbe> => ({ kind: 'absent' }),
    readRecord: () => record,
    inspectProcess: () => 'alive',
    authenticate: async () => ({ record, cookie: 'c', identity: record }),
    kill: () => { signals += 1 },
  }))
  assertCode(result, 0)
  assert.equal(signals, 0, 'uninstall never kills a fallback Host')
})

test('uninstall removes an inactive owned unit without killing an unrelated fallback Host', { skip: process.platform !== 'linux' }, async t => {
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
  assert.equal(signals, 0, 'an unrelated fallback Host must not be signalled')
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
  assert.equal(existsSync(join(fx.scope.dir, 'instance.json')), false)
})

test('start does not report success when the new Host fails the post-snapshot ownership check', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const record = recordOf(fx.scope)
  let ensured = 0
  let postPhase = false
  // Pre: no Host, an inactive owned unit (a legal cold start). Post: the Host is
  // authenticated BUT the manager's MainPID belongs to a different process.
  const systemctl = unitSystemctl(unit.path, { activeState: 'inactive', mainPid: 0 })
  const systemctlWithPost = async (args: readonly string[]): Promise<SystemctlResult> => {
    const result = await systemctl.run(args)
    void result
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
  assertCode(result, 3, /does not supervise the authenticated Host/u)
  assert.doesNotMatch(result.stdout, /^host=ready$/mu)
})

test('restart does not report success when the new instance fails the post-snapshot check', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const oldRecord = recordOf(fx.scope)
  const newRecord = recordOf(fx.scope, { instanceId: '22222222-2222-4222-8222-222222222222', hostPid: 5252 })
  let ensured = 0
  let phase: 'old' | 'stopped' | 'new' = 'old'
  // The manager is available during the pre/stop phases (so the stop goes
  // through the verified unit) and again after ensure, where the post-snapshot
  // reports host=ready together with an ownership failure: the unit is active
  // but its MainPID is NOT the new Host. `ready` alone must not be success.
  const systemctl = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('stop')) { phase = phase === 'old' ? 'stopped' : phase; return exited(0) }
    if (args.includes('show')) {
      return exited(0, [
        'LoadState=loaded',
        `ActiveState=${phase === 'old' ? 'active' : phase === 'stopped' ? 'inactive' : 'active'}`,
        `FragmentPath=${unit.path}`,
        'DropInPaths=',
        `MainPID=${String(phase === 'old' ? oldRecord.hostPid : phase === 'new' ? 9999 : 0)}`,
        'UnitFileState=disabled',
        '',
      ].join('\n'))
    }
    return exited(0)
  }
  const result = await runDaemonControl({ verb: 'restart' }, fx.profile, depsOf(fx, {
    systemctl,
    readRecord: () => (phase === 'old' ? oldRecord : phase === 'new' ? newRecord : undefined),
    inspectProcess: recordValue => recordValue === undefined ? 'dead' : 'alive',
    authenticate: async recordValue => ({ record: recordValue, cookie: 'c', identity: recordValue }),
    readCmdline: () => `node\0${join(fx.profile.packageRoot, 'dist', 'local-host.mjs')}\0`,
    readStarttime: () => phase === 'old' ? oldRecord.hostStarttime : undefined,
    kill: () => {},
    ensureHost: async () => { ensured += 1; phase = 'new'; return { record: newRecord, cookie: 'c', identity: newRecord } },
    sleep: async () => {},
    now: () => 0,
  }))
  assert.equal(ensured, 1, 'the restart must have run ensure exactly once')
  // The post snapshot reached `host=ready` (the ownership refusal is only
  // produced on the authenticated path) and still must not be reported as a
  // completed restart: the failure wins over the Ready observation.
  assertCode(result, 3, /does not supervise the authenticated Host/u)
  assert.doesNotMatch(result.stdout, /previous=/u, 'a failed post-snapshot must not print a completed restart block')
  assert.doesNotMatch(result.stdout, /^host=ready$/mu, 'a failed post-snapshot must not be presented as Ready success')
})

test('uninstall reports an incomplete verification when the post-snapshot manager query fails', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  let reloads = 0
  let postPhase = false
  const systemctl = async (args: readonly string[]): Promise<SystemctlResult> => {
    if (args.includes('daemon-reload')) { reloads += 1; postPhase = true; return exited(0) }
    if (args.includes('stop')) return exited(0)
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
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, {
    systemctl,
    probe: async (): Promise<UserManagerProbe> => (postPhase
      ? { kind: 'error', reason: 'bus broke after the reload' }
      : { kind: 'available' }),
    readRecord: () => undefined,
    inspectProcess: () => 'dead',
    sleep: async () => {},
    now: () => 0,
  }))
  assertCode(result, 4, /user manager is unavailable/u)
  assert.equal(existsSync(unit.path), false, 'the owned unit file must be removed (the OS action committed)')
  assert.equal(reloads, 1, 'daemon-reload must run exactly once')
})

test('uninstall reports a failed daemon-reload instead of claiming completion', { skip: process.platform !== 'linux' }, async t => {
  const fx = fixture(t)
  const unit = writeOwnedUnit(fx)
  const systemctl = unitSystemctl(unit.path, { activeState: 'inactive', mainPid: 0, reloadResult: exited(1, '', 'reload failed') })
  const result = await runDaemonControl({ verb: 'uninstall' }, fx.profile, depsOf(fx, { systemctl: systemctl.run }))
  assertCode(result, 4, /MANAGER_OR_OS_FAILURE/u)
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
