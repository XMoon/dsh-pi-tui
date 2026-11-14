/**
 * M6-2C daemon management native qualification cases.
 *
 * These selectable cases drive the PUBLIC `dsh --profile pi-tui daemon ...`
 * commands (never an internal entry harness) against an isolated packed install
 * and inspect the real systemd user manager, the real detached fallback Host and
 * the real Profile scope. They are strictly environment-gated: a run only
 * qualifies itself as a dedicated isolated test account whose account home IS
 * the isolated home and whose `systemctl --user` channel is genuinely reachable
 * (or genuinely absent for the fallback case). Everywhere else each case returns
 * an honest `NOT_VERIFIED` and never touches the real user manager, never
 * fabricates a PASS and never signs a stand-in as real L6.
 *
 * @module split-process/daemon-controls-m6-2c
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { userInfo } from 'node:os'

import { findIsolatedProcesses, killIsolatedProcesses } from '../../lib/split-smoke-processes.mjs'
import { createSplitSmokeProfile } from '../../lib/split-smoke-profile.mjs'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { managedHostGateReason, stopAndRemoveManagedUnit } from './managed-host-m6-2b.mjs'

const ISOLATED_HOME_ENV = 'SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME'
const ISOLATED_FLAG_ENV = 'SPLIT_PROCESS_MANAGED_HOST_ISOLATED'
const ISOLATED_MARKER = '.dsh-pi-tui-managed-host-isolated'
const SYSTEMCTL = '/usr/bin/systemctl'
const OWNER_MARKER = 'local-host-manager-v1'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The same attested isolated-account gate the managed-host cases use. */
function isolatedGate() {
  const isolatedHome = process.env[ISOLATED_HOME_ENV]
  const optIn = process.env[ISOLATED_FLAG_ENV]
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  let accountHome
  try { accountHome = userInfo().homedir } catch { accountHome = undefined }
  let markerExists = false
  if (isolatedHome !== undefined && isolatedHome !== '' && accountHome !== undefined) {
    try { markerExists = existsSync(join(requireRealpath(accountHome), ISOLATED_MARKER)) } catch { markerExists = false }
  }
  const reason = managedHostGateReason({ isolatedHome, optIn, markerExists, uid, accountHome })
  if (reason === null) return { qualified: true }
  return { qualified: false, reason }
}

function requireRealpath(path) {
  try { return realpathSync(path) } catch { return path }
}

function runtimeDir() {
  const uid = process.getuid()
  return existsSync(`/run/user/${String(uid)}`) ? `/run/user/${String(uid)}` : undefined
}

function systemctl(args) {
  return spawnSync(SYSTEMCTL, args, {
    encoding: 'utf8',
    timeout: 15_000,
    env: runtimeDir() === undefined ? process.env : { ...process.env, XDG_RUNTIME_DIR: runtimeDir() },
  })
}

function managerAvailable() {
  return systemctl(['--user', '--no-pager', '--no-ask-password', 'show-environment']).status === 0
}

function profileScopeId(uid, profileDir) {
  return createHash('sha256')
    .update(`dsh-pi-tui/local-scope/1\0${String(uid)}\0${realpathSync(profileDir)}`)
    .digest('hex')
}

function profileUnitName(profile, scopeId) {
  let slug = ''
  for (const character of profile) slug += /[A-Za-z0-9_.-]/u.test(character) ? character : '_'
  if (slug === '') slug = 'profile'
  if (!/[A-Za-z0-9]/u.test(slug[0])) slug = `p${slug}`
  return `dsh-pi-tui@${slug.slice(0, 32)}-${scopeId.slice(0, 16)}.service`
}

function unitPathOf(unit) {
  return join(realpathSync(userInfo().homedir), '.config', 'systemd', 'user', unit)
}

function classify(pid) {
  let cmdline
  try { cmdline = readFileSync(`/proc/${String(pid)}/cmdline`, 'utf8') } catch { return undefined }
  if (cmdline.includes('local-host.mjs')) return 'host'
  if (cmdline.includes('local-client.mjs')) return 'client'
  return undefined
}

function processCounts(dshHome) {
  const roles = findIsolatedProcesses(dshHome).map(classify)
  return { host: roles.filter(role => role === 'host').length, client: roles.filter(role => role === 'client').length }
}

function hostPids(dshHome) {
  return findIsolatedProcesses(dshHome).filter(pid => classify(pid) === 'host')
}

/** Run ONE public management command without a TTY. */
function runDaemon(installation, args, env = {}) {
  const [executable, ...prefix] = installation.dshInvocation
  const result = spawnSync(executable, [...prefix, '--profile', 'pi-tui', 'daemon', ...args], {
    cwd: installation.profileDir,
    env: { ...installation.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

/** Asynchronous public management command (for the concurrency race). */
function spawnDaemon(installation, args, env = {}) {
  const [executable, ...prefix] = installation.dshInvocation
  const child = spawn(executable, [...prefix, '--profile', 'pi-tui', 'daemon', ...args], {
    cwd: installation.profileDir,
    env: { ...installation.env, ...env },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return new Promise(resolve => {
    child.once('close', (code, signal) => resolve({ status: code, signal, stdout, stderr }))
    child.once('error', error => resolve({ status: null, signal: null, stdout, stderr, error }))
  })
}

/** Parse the stable key=value status block (last occurrence wins). */
function statusOf(stdout) {
  const fields = {}
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return fields
}

function assertStatus(result, fields, message) {
  assert(result.status === 0, `${message}: expected exit 0, saw ${String(result.status)}: ${result.stderr.slice(-500)}`)
  const status = statusOf(result.stdout)
  for (const [key, value] of Object.entries(fields)) {
    assert(status[key] === value, `${message}: expected ${key}=${value}, saw ${String(status[key])}\n${result.stdout}`)
  }
  return status
}

async function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(120)
  }
  throw new SplitSmokeAssertionError(`daemon-control: ${label} did not settle before the deadline`)
}

function cleanupCase(installation, trace) {
  stopAndRemoveManagedUnit(installation, trace)
  killIsolatedProcesses(installation.dshHome)
}

/** The stable NOT_VERIFIED result for an environment that cannot qualify. */
function notVerified(reason) {
  return { status: 'NOT_VERIFIED', reason }
}

/** status-safety: a no-Host status is a pure read, and an active-but-unauthenticated Host is never Ready. */
export async function runDaemonControlStatusSafety({ installation, trace, dshHome }) {
  const gate = isolatedGate()
  if (!gate.qualified) return notVerified(gate.reason)
  if (!managerAvailable()) return notVerified('NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment did not succeed')
  const uid = process.getuid()
  const scopeId = profileScopeId(uid, installation.profileDir)
  const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', scopeId)
  const unit = profileUnitName('pi-tui', scopeId)
  const unitPath = unitPathOf(unit)
  const scopeBefore = existsSync(scopeDir)
  const unitBefore = existsSync(unitPath)
  let launchBefore
  let launchPath
  let failure
  let result
  try {
    assert(processCounts(dshHome).host === 0, 'the status-safety scene must begin with no Host')
    for (const env of [{ DSH_PI_TUI_BACKEND: 'direct' }, { DSH_PI_TUI_BACKEND: 'daemon' }, { DSH_PI_TUI_BACKEND: 'wire-local' }, {}]) {
      const probe = runDaemon(installation, ['status'], env)
      assertStatus(probe, {
        host: 'stopped',
        manager: 'unmanaged',
        unit: 'none',
        'unit-state': 'not-found',
        'user-manager': 'available',
      }, `no-Host status with ${JSON.stringify(env)}`)
      assert(processCounts(dshHome).host === 0 && processCounts(dshHome).client === 0,
        'a read-only status must not start a Host or Client')
    }
    assert(existsSync(scopeDir) === scopeBefore, 'status must not create the profile run directory')
    assert(existsSync(unitPath) === unitBefore, 'status must not create or delete a profile unit')
    // A real Host must be started through the management command, then its
    // launch material is tampered so ACTIVE supervision cannot look Ready.
    const started = runDaemon(installation, ['start'])
    const ready = assertStatus(started, { host: 'ready', manager: 'systemd' }, 'the started management Host')
    launchPath = join(scopeDir, 'launch.json')
    launchBefore = readFileSync(launchPath, 'utf8')
    const material = JSON.parse(launchBefore)
    material.connectUrl = String(material.connectUrl).replace(/token=[^&]+/u, 'token=tampered')
    writeFileSync(launchPath, `${JSON.stringify(material)}\n`, { mode: 0o600 })
    const tampered = runDaemon(installation, ['status'])
    assert(tampered.status !== 0, 'a Host that fails authentication must make status nonzero')
    const tamperedStatus = statusOf(tampered.stdout)
    assert(tamperedStatus.host !== 'ready' && tamperedStatus.host !== 'stopped',
      `an unauthenticated Host must not report ready or stopped: ${tampered.stdout}`)
    writeFileSync(launchPath, launchBefore, { mode: 0o600 })
    launchBefore = undefined
    assert(hostPids(dshHome).length === 1, 'tampering the read-only launch material must not kill the Host')
    const stopped = runDaemon(installation, ['stop'])
    assertStatus(stopped, { host: 'stopped' }, 'the status-safety cleanup stop')
    await waitFor(() => hostPids(dshHome).length === 0, 'the status-safety Host exit', 30_000)
    trace('daemon-control-status-safety', { instance: ready.instance, tamperedExit: tampered.status })
    result = { status: 'PASS', scope: 'REAL_SYSTEMD_USER_L6', noHostStatusPure: true, activeNotReady: true, envIndependent: true }
  } catch (error) {
    failure = error
  } finally {
    if (launchBefore !== undefined && launchPath !== undefined) {
      try { writeFileSync(launchPath, launchBefore, { mode: 0o600 }) } catch { /* best effort */ }
    }
    cleanupCase(installation, trace)
  }
  if (failure !== undefined) throw failure
  return result
}

/** The full public lifecycle against the real user manager. */
export async function runDaemonControlSystemdLifecycle({ installation, trace, dshHome }) {
  const gate = isolatedGate()
  if (!gate.qualified) return notVerified(gate.reason)
  if (!managerAvailable()) return notVerified('NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment did not succeed')
  const uid = process.getuid()
  const scopeId = profileScopeId(uid, installation.profileDir)
  const unit = profileUnitName('pi-tui', scopeId)
  const unitPath = unitPathOf(unit)
  const profileManifest = readFileSync(join(installation.profileDir, 'package.json'))
  let failure
  let result
  try {
    const started = runDaemon(installation, ['start'])
    const ready = assertStatus(started, { host: 'ready', manager: 'systemd', 'unit-state': 'active' }, 'daemon start')
    assert(typeof ready.instance === 'string' && ready.instance !== '', 'start must print the instance identity')
    assert(existsSync(unitPath), 'the managed start must have installed the profile unit')
    const warm = runDaemon(installation, ['start'])
    const warmStatus = assertStatus(warm, { host: 'ready' }, 'daemon start warm reuse')
    assert(warmStatus.instance === ready.instance && warmStatus.pid === ready.pid, 'a warm start must reuse the same Host instance')
    const logs = runDaemon(installation, ['logs', '--lines', '20'])
    assert(logs.status === 0 && logs.stdout.trim() !== '', 'daemon logs must read the owned unit journal')
    const stopped = runDaemon(installation, ['stop'])
    assertStatus(stopped, { host: 'stopped' }, 'daemon stop')
    await waitFor(() => hostPids(dshHome).length === 0, 'the stopped Host exit', 30_000)
    const stoppedAgain = runDaemon(installation, ['stop'])
    assertStatus(stoppedAgain, { host: 'stopped' }, 'daemon stop idempotence')
    const restartedFromStopped = runDaemon(installation, ['start'])
    const beforeRestart = assertStatus(restartedFromStopped, { host: 'ready' }, 'the restart precondition start')
    const restarted = runDaemon(installation, ['restart'])
    const afterRestart = assertStatus(restarted, { host: 'ready' }, 'daemon restart')
    assert(afterRestart.instance !== beforeRestart.instance, 'restart must produce a NEW Host instance')
    assert(hostPids(dshHome).length === 1, 'restart must not leave two Hosts')
    const removed = runDaemon(installation, ['uninstall'])
    assertStatus(removed, { unit: 'none', host: 'stopped' }, 'daemon uninstall')
    assert(existsSync(unitPath) === false, 'uninstall must remove only the profile unit file')
    assert(readFileSync(join(installation.profileDir, 'package.json')).equals(profileManifest),
      'uninstall must not rewrite the Profile manifest')
    trace('daemon-control-systemd-lifecycle', { instance: afterRestart.instance })
    result = {
      status: 'PASS',
      scope: 'REAL_SYSTEMD_USER_L6',
      warmReuse: true,
      stopIdempotent: true,
      newInstanceOnRestart: true,
      journalLogs: true,
      uninstallProfilePreserved: true,
    }
  } catch (error) {
    failure = error
  } finally {
    cleanupCase(installation, trace)
  }
  if (failure !== undefined) throw failure
  return result
}

/** The strict-absence process fallback lifecycle. */
export async function runDaemonControlProcessFallback({ installation, trace, dshHome }) {
  const gate = isolatedGate()
  if (!gate.qualified) return notVerified(gate.reason)
  if (managerAvailable()) return notVerified('NOT_AN_ABSENT_MANAGER_ENV: a live user manager is reachable; use the systemd case')
  const uid = process.getuid()
  const scopeId = profileScopeId(uid, installation.profileDir)
  const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', scopeId)
  const hostLog = join(scopeDir, 'host.log')
  let failure
  let result
  try {
    const started = runDaemon(installation, ['start'])
    const ready = assertStatus(started, { host: 'ready', manager: 'process', unit: 'none' }, 'the fallback start')
    assert(hostPids(dshHome).length === 1, 'the fallback start must create exactly one Host')
    assert(existsSync(hostLog), 'the fallback Host must write its private host.log')
    assert((statSync(hostLog).mode & 0o777) === 0o600, 'the fallback host.log must be 0600')
    const logHashBefore = createHash('sha256').update(readFileSync(hostLog)).digest('hex')
    const logs = runDaemon(installation, ['logs', '--lines', '20'])
    assert(logs.status === 0, `the fallback logs must read the private host.log: ${logs.stderr.slice(-300)}`)
    const logHashAfter = createHash('sha256').update(readFileSync(hostLog)).digest('hex')
    assert(logHashBefore === logHashAfter, 'reading the private Host log must not change it')
    const stopped = runDaemon(installation, ['stop'])
    assertStatus(stopped, { host: 'stopped' }, 'the fallback stop')
    await waitFor(() => hostPids(dshHome).length === 0, 'the fallback Host SIGTERM exit', 60_000)
    const restartedFromStopped = runDaemon(installation, ['start'])
    const beforeRestart = assertStatus(restartedFromStopped, { host: 'ready' }, 'the fallback restart precondition')
    const restarted = runDaemon(installation, ['restart'])
    const afterRestart = assertStatus(restarted, { host: 'ready' }, 'the fallback restart')
    assert(afterRestart.instance !== beforeRestart.instance, 'the fallback restart must create a new instance')
    const uninstalled = runDaemon(installation, ['uninstall'])
    assertStatus(uninstalled, { unit: 'none' }, 'the fallback uninstall')
    assert(hostPids(dshHome).length === 1, 'uninstall must not kill a strict-absence fallback Host')
    const finalStop = runDaemon(installation, ['stop'])
    assertStatus(finalStop, { host: 'stopped' }, 'the fallback final stop')
    trace('daemon-control-process-fallback', { instance: ready.instance })
    result = {
      status: 'PASS',
      scope: 'REAL_ABSENT_MANAGER_FALLBACK_L6',
      privateLog: true,
      sigtermExit: true,
      restartNewInstance: true,
      uninstallKeepsFallbackHost: true,
    }
  } catch (error) {
    failure = error
  } finally {
    cleanupCase(installation, trace)
  }
  if (failure !== undefined) throw failure
  return result
}

/** A reachable-but-unusable user manager must fail closed with no fallback. */
export async function runDaemonControlManagerError({ installation, trace, dshHome }) {
  const gate = isolatedGate()
  if (!gate.qualified) return notVerified(gate.reason)
  if (process.env.SPLIT_PROCESS_MANAGED_HOST_FORCE_MANAGER_ERROR !== '1') {
    return notVerified('NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: set SPLIT_PROCESS_MANAGED_HOST_FORCE_MANAGER_ERROR=1 in a genuinely failing user-bus environment')
  }
  if (managerAvailable()) return notVerified('NOT_A_BROKEN_MANAGER_ENV: the user manager is reachable; use the systemd case')
  const uid = process.getuid()
  const scopeId = profileScopeId(uid, installation.profileDir)
  const unitPath = unitPathOf(profileUnitName('pi-tui', scopeId))
  let failure
  let result
  try {
    for (const args of [['status'], ['start'], ['restart']]) {
      const command = runDaemon(installation, args)
      assert(command.status !== 0, `daemon ${args[0]} must fail closed with a broken user manager`)
      assert(/MANAGER_OR_OS_FAILURE|HOST_MANAGER_ERROR/u.test(`${command.stdout}${command.stderr}`),
        `daemon ${args[0]} must report the manager failure, saw: ${command.stderr.slice(-500)}`)
      assert(processCounts(dshHome).host === 0, `daemon ${args[0]} must not fall back to a process Host`)
      assert(existsSync(unitPath) === false, `daemon ${args[0]} must not create a unit`)
    }
    trace('daemon-control-manager-error', { manager: 'error' })
    result = { status: 'PASS', scope: 'REAL_MANAGER_ERROR_L6', failClosed: true, noFallbackHost: true, noUnitSideEffect: true }
  } catch (error) {
    failure = error
  } finally {
    cleanupCase(installation, trace)
  }
  if (failure !== undefined) throw failure
  return result
}

/** Owner-safe actions across two profiles and an explicit old controlled build. */
export async function runDaemonControlOwnerAndMultiProfile({ installation, trace, dshHome, tarball, targetDshVersion, workDir }) {
  const gate = isolatedGate()
  if (!gate.qualified) return notVerified(gate.reason)
  if (!managerAvailable()) return notVerified('NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment did not succeed')
  assert(typeof tarball === 'string' && typeof targetDshVersion === 'string' && typeof workDir === 'string',
    'the owner/multi-profile case needs the lane tarball/workDir facts')
  const uid = process.getuid()
  const second = createSplitSmokeProfile({ tarball, targetDshVersion, workDir: join(workDir, 'profile-b') })
  const scopeA = profileScopeId(uid, installation.profileDir)
  const scopeB = profileScopeId(uid, second.profileDir)
  const unitA = profileUnitName('pi-tui', scopeA)
  const unitB = profileUnitName('pi-tui', scopeB)
  const unitPathA = unitPathOf(unitA)
  const unitPathB = unitPathOf(unitB)
  let failure
  let result
  try {
    assert(scopeA !== scopeB && unitA !== unitB, 'the two profiles must have distinct scopes and units')
    const readyA = assertStatus(runDaemon(installation, ['start']), { host: 'ready', unit: unitA }, 'profile A start')
    const readyB = assertStatus(runDaemon(second, ['start']), { host: 'ready' }, 'profile B start')
    assert(readyA.instance !== readyB.instance, 'the two profiles must not share a Host instance')
    assert(hostPids(installation.dshHome).length === 1 && hostPids(second.dshHome).length === 1, 'each profile must own one Host')
    // Stopping A must never affect B.
    assertStatus(runDaemon(installation, ['stop']), { host: 'stopped' }, 'profile A stop')
    assertStatus(runDaemon(second, ['status']), { host: 'ready' }, 'profile B after A stop')
    // Restarting A must never affect B.
    const restartedA = assertStatus(runDaemon(installation, ['restart']), { host: 'ready' }, 'profile A restart')
    assert(restartedA.instance !== readyA.instance, 'the restart of A must create a new instance')
    assertStatus(runDaemon(second, ['status']), { host: 'ready' }, 'profile B after A restart')
    assert(hostPids(second.dshHome).length === 1, 'profile B Host was replaced by profile A management')
    // A foreign same-named unit file must be refused and left untouched.
    assertStatus(runDaemon(installation, ['stop']), { host: 'stopped' }, 'profile A stop before the foreign-unit negative')
    const foreign = `[Unit]\nDescription=foreign\nX-DshPiTuiOwner=someone-else\nX-DshPiTuiScopeId=${scopeA}\nX-DshPiTuiProfileIdentity=x\nX-DshPiTuiInstallBuild=${'0'.repeat(64)}\n\n[Service]\nType=exec\nExecStart=/bin/true\nRestart=on-failure\n`
    writeFileSync(unitPathA, foreign, { mode: 0o600 })
    const refused = runDaemon(installation, ['status'])
    assert(refused.status === 3, `a foreign unit must be refused with exit 3, saw ${String(refused.status)}`)
    assert(readFileSync(unitPathA, 'utf8') === foreign, 'a foreign unit must never be rewritten or removed')
    unlinkSync(unitPathA)
    // The explicit restart migrates a controlled old-build unit after owner proof.
    const oldBuildId = 'a'.repeat(64)
    const encoded = value => `"${value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"').replace(/%/gu, '%%').replace(/\$/gu, '$$')}"`
    const oldUnit = [
      '[Unit]',
      'Description=dsh-pi-tui local Host (profile-scoped)',
      `X-DshPiTuiOwner=${OWNER_MARKER}`,
      `X-DshPiTuiScopeId=${scopeA}`,
      `X-DshPiTuiProfileIdentity=${createHash('sha256').update(`dsh-pi-tui/profile-identity/1\0${realpathSync(installation.profileDir)}`).digest('hex')}`,
      `X-DshPiTuiInstallBuild=${oldBuildId}`,
      'StartLimitIntervalSec=60s',
      'StartLimitBurst=3',
      '',
      '[Service]',
      'Type=exec',
      `ExecStart=${encoded(process.execPath)} ${encoded(join(installation.profilePackage, 'dist', 'local-host.mjs'))}`,
      `WorkingDirectory=${realpathSync(installation.profileDir).replace(/%/gu, '%%')}`,
      `Environment="DSH_HOME=${installation.dshHome.replace(/%/gu, '%%')}"`,
      `Environment="SPLIT_PROCESS_DSH_ANCHOR=${installation.anchor.replace(/%/gu, '%%')}"`,
      'Environment="SPLIT_PROCESS_PROFILE=pi-tui"',
      'Restart=on-failure',
      'RestartSec=2s',
      'TimeoutStopSec=15s',
      'KillMode=control-group',
      'StandardOutput=journal',
      'StandardError=journal',
      '',
    ].join('\n')
    writeFileSync(unitPathA, oldUnit, { mode: 0o600 })
    assert(systemctl(['--user', '--no-pager', '--no-ask-password', 'daemon-reload']).status === 0, 'daemon-reload failed before the old-build migration')
    const migrated = assertStatus(runDaemon(installation, ['restart']), { host: 'ready' }, 'the old-build controlled restart')
    assert(migrated.instance !== restartedA.instance, 'the migrated restart must create a new instance')
    assert(!readFileSync(unitPathA, 'utf8').includes(`X-DshPiTuiInstallBuild=${oldBuildId}`),
      'the explicit restart must replace the old controlled unit definition')
    assertStatus(runDaemon(second, ['status']), { host: 'ready' }, 'profile B after the old-build migration')
    // Uninstall A removes only A's unit; B stays ready.
    assertStatus(runDaemon(installation, ['uninstall']), { unit: 'none' }, 'profile A uninstall')
    assert(existsSync(unitPathA) === false, 'uninstall must remove only profile A unit')
    assert(existsSync(unitPathB) === true, 'uninstall must never touch profile B unit')
    assertStatus(runDaemon(second, ['status']), { host: 'ready' }, 'profile B after A uninstall')
    trace('daemon-control-owner-multi-profile', { unitA, unitB })
    result = {
      status: 'PASS',
      scope: 'REAL_SYSTEMD_USER_L6',
      twoProfiles: true,
      crossProfileUnaffected: true,
      foreignUnitRefused: true,
      oldBuildMigrated: true,
      uninstallOwnerScoped: true,
    }
  } catch (error) {
    failure = error
  } finally {
    cleanupCase(installation, trace)
    // The second profile was provisioned by this case; clean its own unit/Host.
    stopAndRemoveManagedUnit(second, trace)
    killIsolatedProcesses(second.dshHome)
  }
  if (failure !== undefined) throw failure
  return result
}

/** The admin seat serializes mutating verbs; two profiles stay independent. */
export async function runDaemonControlConcurrentControls({ installation, trace, dshHome, tarball, targetDshVersion, workDir }) {
  const gate = isolatedGate()
  if (!gate.qualified) return notVerified(gate.reason)
  if (!managerAvailable()) return notVerified('NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment did not succeed')
  assert(typeof tarball === 'string' && typeof targetDshVersion === 'string' && typeof workDir === 'string',
    'the concurrency case needs the lane tarball/workDir facts')
  const uid = process.getuid()
  const scopeA = profileScopeId(uid, installation.profileDir)
  const seatName = `\0dsh-pi-tui-admin-${scopeA.slice(0, 40)}`
  const second = createSplitSmokeProfile({ tarball, targetDshVersion, workDir: join(workDir, 'profile-b') })
  let seat
  let failure
  let result
  try {
    // A held admin seat makes the second operation a deterministic BUSY.
    seat = createServer()
    await new Promise((resolve, reject) => {
      seat.once('error', reject)
      seat.listen(seatName, resolve)
    })
    assert(processCounts(dshHome).host === 0, 'the concurrency scene must begin with no Host')
    const busy = runDaemon(installation, ['stop'])
    assert(busy.status === 5, `a concurrent management command must exit 5, saw ${String(busy.status)}: ${busy.stderr.slice(-300)}`)
    assert(/DAEMON_CONTROL_BUSY/u.test(busy.stderr), 'the busy failure must be reported as DAEMON_CONTROL_BUSY')
    assert(processCounts(dshHome).host === 0, 'a BUSY refusal must not start or stop a Host')
    // A different profile's MUTATING command takes its own seat and is never
    // blocked by this profile's held seat.
    const otherStop = runDaemon(second, ['stop'])
    assert(otherStop.status === 0, `another profile must not be blocked by this profile's seat: ${otherStop.stderr.slice(-300)}`)
    await new Promise(resolve => seat.close(resolve))
    seat = undefined
    // Two concurrent starts produce exactly one Host.
    const [left, right] = await Promise.all([
      spawnDaemon(installation, ['start']),
      spawnDaemon(installation, ['start']),
    ])
    assert(left.status === 0 || right.status === 0, 'at least one concurrent start must succeed')
    assert(hostPids(dshHome).length === 1, `two management starts must converge on ONE Host, saw ${String(hostPids(dshHome).length)}`)
    const ready = assertStatus(runDaemon(installation, ['status']), { host: 'ready' }, 'the converged concurrent Host')
    assert(typeof ready.instance === 'string', 'the converged Host must publish an instance identity')
    trace('daemon-control-concurrent-controls', { busy: busy.status, starts: [left.status, right.status] })
    result = {
      status: 'PASS',
      scope: 'REAL_SYSTEMD_USER_L6',
      adminSeatBusy: true,
      crossProfileIndependent: true,
      concurrentStartsOneHost: true,
    }
  } catch (error) {
    failure = error
  } finally {
    if (seat !== undefined) await new Promise(resolve => seat.close(resolve))
    cleanupCase(installation, trace)
    stopAndRemoveManagedUnit(second, trace)
    killIsolatedProcesses(second.dshHome)
  }
  if (failure !== undefined) throw failure
  return result
}
