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
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { userInfo } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { findIsolatedProcesses, killIsolatedProcesses } from '../../lib/split-smoke-processes.mjs'
import { createSplitSmokeProfile } from '../../lib/split-smoke-profile.mjs'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostAssistantHasText, hostSessionEvents, hostUserTexts } from '../../lib/split-smoke-sessions.mjs'
import { managedHostGateReason, stopAndRemoveManagedUnit } from './managed-host-m6-2b.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

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
    // The Owner contract: an authentication failure is not a unit-ownership
    // verdict. With the launch material still broken, an EXPLICIT stop must
    // still manage the verified unit through systemd; the product does not
    // auto-recover.
    const tamperedStop = runDaemon(installation, ['stop'])
    assertStatus(tamperedStop, { host: 'stopped' }, 'stop with tampered authentication')
    await waitFor(() => hostPids(dshHome).length === 0, 'the tampered-auth service Host exit', 30_000)
    assert(processCounts(dshHome).host === 0, 'the explicit stop must stop the verified unit, not leave a second Host')
    writeFileSync(launchPath, launchBefore, { mode: 0o600 })
    launchBefore = undefined
    trace('daemon-control-status-safety', { instance: ready.instance, tamperedExit: tampered.status, tamperedStop: tamperedStop.status })
    result = { status: 'PASS', scope: 'REAL_SYSTEMD_USER_L6', noHostStatusPure: true, activeNotReady: true, envIndependent: true, authenticationFailureRecoverable: true }
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
export async function runDaemonControlSystemdLifecycle({ installation, trace, dshHome, workDir }) {
  const gate = isolatedGate()
  if (!gate.qualified) return notVerified(gate.reason)
  if (!managerAvailable()) return notVerified('NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment did not succeed')
  const uid = process.getuid()
  const scopeId = profileScopeId(uid, installation.profileDir)
  const unit = profileUnitName('pi-tui', scopeId)
  const unitPath = unitPathOf(unit)
  const profileManifest = readFileSync(join(installation.profileDir, 'package.json'))
  const dropInDir = `${unitPath}.d`
  let dropInPath
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
    const defaults = readFileSync(unitPath, 'utf8')
    const customized = `${defaults}\n[Service]\nEnvironment="MY_CUSTOM_FLAG=1"\nRestartSec=5\nExecStartPre=/usr/bin/true\n`
    writeFileSync(unitPath, customized, { mode: 0o600 })
    chmodSync(unitPath, 0o644)
    assert(systemctl(['--user', 'daemon-reload']).status === 0, 'reload the user-edited service')
    const edited = assertStatus(runDaemon(installation, ['start']), { host: 'ready', manager: 'systemd' }, 'user-edited 0644 service')
    assert(readFileSync(`/proc/${edited.pid}/environ`, 'utf8').split('\0').includes('MY_CUSTOM_FLAG=1'), 'the real Host received the user Environment directive')
    assertStatus(runDaemon(installation, ['status']), { host: 'ready' }, 'custom service status')
    assertStatus(runDaemon(installation, ['stop']), { host: 'stopped' }, 'custom service stop')
    assert(readFileSync(unitPath, 'utf8') === customized && (statSync(unitPath).mode & 0o777) === 0o644, 'management preserves user service text and 0644 mode')

    // Exercise the native systemctl edit workflow using an editor that writes
    // only the fixture's requested drop-in. script supplies systemctl's TTY.
    const editor = join(workDir, 'user-unit-editor.sh')
    writeFileSync(editor, "#!/bin/sh\nprintf '%s\\n' '[Service]' 'Environment=\"MY_DROPIN_FLAG=1\"' 'RestartSec=5' > \"$1\"\n", { mode: 0o700 })
    const edit = spawnSync('script', ['-qefc', `${SYSTEMCTL} --user edit ${unit}`, '/dev/null'], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir(), SYSTEMD_EDITOR: editor }, encoding: 'utf8', timeout: 30_000,
    })
    assert(edit.status === 0, `native systemctl edit must succeed: ${edit.stderr?.slice(-400)}`)
    const loadedDropIns = systemctl(['--user', 'show', unit, '-p', 'DropInPaths', '--value'])
    dropInPath = join(dropInDir, 'override.conf')
    assert(loadedDropIns.status === 0 && loadedDropIns.stdout.includes(dropInPath), 'systemd loaded the actual user drop-in')
    const dropInBytes = readFileSync(dropInPath, 'utf8')
    const beforeRestart = assertStatus(runDaemon(installation, ['start']), { host: 'ready' }, 'start with a real drop-in')
    assert(readFileSync(`/proc/${beforeRestart.pid}/environ`, 'utf8').split('\0').includes('MY_DROPIN_FLAG=1'), 'the Host received the real drop-in environment')
    const afterRestart = assertStatus(runDaemon(installation, ['restart']), { host: 'ready' }, 'restart preserves customized service and drop-in')
    assert(afterRestart.instance !== beforeRestart.instance, 'restart must produce a NEW Host instance')
    assert(hostPids(dshHome).length === 1, 'restart must not leave two Hosts')
    assert(readFileSync(unitPath, 'utf8') === customized && readFileSync(dropInPath, 'utf8') === dropInBytes, 'restart must not restore defaults or change drop-ins')
    assertStatus(runDaemon(installation, ['stop']), { host: 'stopped' }, 'stop before the bad ExecStart control')

    const broken = customized.replace(/^ExecStart=.*$/mu, 'ExecStart=/usr/bin/false')
    writeFileSync(unitPath, broken)
    assert(systemctl(['--user', 'daemon-reload']).status === 0, 'reload the user-selected non-Host command')
    const failedStart = runDaemon(installation, ['start'])
    assert(failedStart.status !== 0 && /MANAGER_OR_OS_FAILURE|TRANSITION_UNCERTAIN/u.test(failedStart.stderr), 'a non-Host service reports an actual startup/readiness failure')
    assert(hostPids(dshHome).length === 0 && processCounts(dshHome).client === 0, 'bad ExecStart starts no fallback Host or Client')
    assert(readFileSync(unitPath, 'utf8') === broken, 'failed start must not rewrite user configuration')
    assert(systemctl(['--user', 'stop', unit]).status === 0, 'stop the fixture non-Host service')
    writeFileSync(unitPath, customized)
    const sourceDir = join(workDir, 'user-service-source')
    mkdirSync(sourceDir, { mode: 0o700 })
    const source = join(sourceDir, unit)
    writeFileSync(source, customized, { mode: 0o644 })
    unlinkSync(unitPath)
    symlinkSync(source, unitPath)
    assert(systemctl(['--user', 'daemon-reload']).status === 0, 'reload the user-linked service')
    const linked = assertStatus(runDaemon(installation, ['start']), { host: 'ready', manager: 'systemd' }, 'user-linked service start')
    const fragment = systemctl(['--user', 'show', unit, '-p', 'FragmentPath', '--value'])
    assert(fragment.status === 0 && realpathSync(fragment.stdout.trim()) === realpathSync(source), 'manager FragmentPath resolves to the exact user configuration source')
    assertStatus(runDaemon(installation, ['status']), { host: 'ready' }, 'linked service status')
    assert(runDaemon(installation, ['logs']).status === 0, 'drop-ins and links do not deny the target unit journal')
    assertStatus(runDaemon(installation, ['stop']), { host: 'stopped' }, 'linked service stop')
    assertStatus(runDaemon(installation, ['start']), { host: 'ready' }, 'linked service restart precondition')
    const removed = runDaemon(installation, ['uninstall'])
    assertStatus(removed, { unit: 'none', host: 'stopped' }, 'daemon uninstall')
    assert(existsSync(unitPath) === false, 'uninstall must remove only the profile unit link')
    assert(readFileSync(source, 'utf8') === customized, 'uninstall preserves the linked configuration source')
    assert(readFileSync(dropInPath, 'utf8') === dropInBytes, 'uninstall preserves user drop-ins')
    assert(readFileSync(join(installation.profileDir, 'package.json')).equals(profileManifest),
      'uninstall must not rewrite the Profile manifest')
    trace('daemon-control-systemd-lifecycle', { instance: afterRestart.instance, customUnitPreserved: true, loadedDropIn: true, mode0644: true, sourcePreserved: true, badExecNoFallback: true })
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
    if (dropInPath !== undefined) {
      // This isolated Profile's drop-in was created by this case; the public
      // uninstall assertion above proved it survived. Fixture teardown owns it.
      rmSync(dropInDir, { recursive: true, force: true })
      systemctl(['--user', 'daemon-reload'])
    }
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
    // Owner decision: an owned unit from ANOTHER installed build is refused by
    // restart (cross-build migration is M6-2D work), never rewritten, and the
    // explicit uninstall of a verified same-build unit still works afterwards.
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
    assert(systemctl(['--user', '--no-pager', '--no-ask-password', 'daemon-reload']).status === 0, 'daemon-reload failed before the old-build refusal')
    const refusedOldBuild = runDaemon(installation, ['restart'])
    assert(refusedOldBuild.status === 3, `an old-build unit must be refused by restart with exit 3, saw ${String(refusedOldBuild.status)}`)
    assert(readFileSync(unitPathA, 'utf8') === oldUnit, 'a refused old-build unit must never be rewritten or removed')
    // Remove the old-build unit through the manager-verified uninstall path so
    // the closing uninstall assertions still exercise the same-build flow.
    const removedOld = runDaemon(installation, ['uninstall'])
    assert(removedOld.status === 0, `uninstalling the old-build unit must succeed: ${removedOld.stderr.slice(-300)}`)
    assert(existsSync(unitPathA) === false, 'the old-build unit file must be removed by uninstall')
    assertStatus(runDaemon(installation, ['start']), { host: 'ready' }, 'profile A restart after the old-build refusal')
    assertStatus(runDaemon(second, ['status']), { host: 'ready' }, 'profile B after the old-build refusal')
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
      oldBuildRefusedNotMigrated: true,
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

/**
 * C13: a REAL Host Session turn stays in flight across `stop`, and the restarted
 * Host never replays it.
 *
 * A systemd-managed Host strips the internal test-patch channel, so the offline
 * model route is installed as ORDINARY profile configuration (a row in the
 * profile's own `cordis.patch.yml` pointing at a module inside the profile).
 * The fixture creates one real Agent through the official service, sends one
 * follow-up turn and holds the model stream until the Host's shutdown signal.
 */
export async function runDaemonControlInflightStop({ installation, trace, dshHome, workDir }) {
  const gate = isolatedGate()
  if (!gate.qualified) return notVerified(gate.reason)
  if (!managerAvailable()) return notVerified('NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment did not succeed')
  const proofPath = join(workDir, 'c13-inflight.jsonl')
  const sessionId = `m6-2c-inflight-${String(process.pid)}-${String(Date.now())}`
  const fixturePath = join(installation.profileDir, 'm6-2c-inflight-work.mjs')
  const patchPath = join(installation.profileDir, 'cordis.patch.yml')
  writeFileSync(proofPath, '', { mode: 0o600 })
  writeFileSync(fixturePath, readFileSync(join(SCRIPT_DIR, '..', '..', 'fixtures', 'daemon-control-inflight-work.mjs')), { mode: 0o600 })
  const markerPath = join(installation.profileDir, 'm6-2c-inflight-submitted.marker')
  const patchBefore = readFileSync(patchPath, 'utf8')
  const proofEvents = () => readFileSync(proofPath, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
  let failure
  let result
  try {
    writeFileSync(patchPath, [
      '- insert:',
      '    - id: m6-2c-inflight-work',
      `      name: '${pathToFileURL(fixturePath).href}'`,
      '      inject: [llm, agents, tools]',
      '      config:',
      `        proofPath: '${proofPath}'`,
      `        sessionId: '${sessionId}'
        markerPath: '${markerPath}'`,
      `        cwd: '${installation.profileDir}'`,
      '- id: agent-default-model',
      '  config:',
      '    provider: c1-qualification',
      '    model: c1',
      '',
    ].join('\n'), { mode: 0o600 })

    const started = runDaemon(installation, ['start'])
    assertStatus(started, { host: 'ready', manager: 'systemd' }, 'the C13 managed Host')

    // The turn must be REAL and in flight before stop: the offline route has
    // already produced its first chunk and is still holding the stream.
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline && !proofEvents().some(event => event.kind === 'turn-start')) {
      await sleep(200)
    }
    const inFlight = proofEvents().find(event => event.kind === 'turn-start')
    assert(inFlight !== undefined, 'the C13 turn never started inside the managed Host')
    const startedSession = proofEvents().find(event => event.kind === 'session-created')
    assert(startedSession !== undefined, 'the C13 Agent was never created')

    // The turn is unbounded, so the Host cannot always drain inside
    // TimeoutStopSec. Both truthful outcomes are allowed — a reported failure
    // and a reported stop — but a "success" MUST mean the Host really exited,
    // and a failure MUST use the stable taxonomy. Neither may claim completion.
    const stopped = runDaemon(installation, ['stop'])
    if (stopped.status === 0) {
      assertStatus(stopped, { host: 'stopped' }, 'the C13 in-flight stop')
    } else {
      assert(/MANAGER_OR_OS_FAILURE|HOST_STOP_TIMEOUT|TRANSITION_UNCERTAIN/u.test(`${stopped.stdout}${stopped.stderr}`),
        `the C13 in-flight stop must report a stable failure code, saw: ${stopped.stderr.slice(-500)}`)
    }
    await waitFor(() => hostPids(dshHome).length === 0, 'the C13 Host exit with an in-flight turn', 60_000)
    assert(systemctl(['--user', '--no-pager', 'is-active', profileUnitName('pi-tui', profileScopeId(process.getuid(), installation.profileDir))]).stdout.trim() !== 'active',
      'the C13 unit must not stay active after an in-flight stop')
    // A graceful stop must abort the in-flight turn (the fixture records the
    // Host's own shutdown signal reaching the stream). A manager-enforced stop
    // kills the cgroup, so no abort is observable — but in BOTH cases the turn
    // must leave no completed assistant message (asserted below against the
    // durable Session log, which is the settlement authority).
    const aborted = proofEvents().some(event => event.kind === 'turn-aborted')
    if (stopped.status === 0) {
      assert(aborted, 'a successful in-flight stop must abort the turn instead of letting it settle')
    }
    // A failed stop leaves the unit in `failed`; an explicit start clears it.
    systemctl(['--user', '--no-pager', 'reset-failed'])
    const restarted = runDaemon(installation, ['start'])
    const after = assertStatus(restarted, { host: 'ready', manager: 'systemd' }, 'the C13 restart')
    assert(after.instance !== statusOf(started.stdout).instance, 'the C13 restart must create a new instance')
    // reason: bounded observation window for an automatic replay; the restarted
    // Host has no client, so any second turn-start would be a replay.
    await sleep(15_000)
    const turnStarts = proofEvents().filter(event => event.kind === 'turn-start').length
    assert(turnStarts === 1,
      `the restarted Host must never replay the interrupted turn (turn-start=${String(turnStarts)}: ${JSON.stringify(proofEvents().map(event => event.kind))})`)

    const events = hostSessionEvents(dshHome, String(startedSession.sessionId))
    assert(events !== undefined, 'the interrupted Session must keep its durable log')
    assert(hostUserTexts(events).includes('C13 in-flight turn'),
      'the interrupted turn must keep its real user message')
    assert(!events.some(event => event.type === 'assistant/message'),
      'the interrupted turn must never settle into an assistant message')
    assert(!hostAssistantHasText(events, 'C13 partial answer finished'),
      'the interrupted turn must never gain its completion text')

    trace('daemon-control-inflight-stop', {
      session: String(startedSession.sessionId),
      instance: after.instance,
      stopExit: stopped.status,
      turnAborted: aborted,
      turnStarts,
    })
    result = {
      status: 'PASS',
      scope: 'REAL_SYSTEMD_USER_L6',
      inFlightAtStop: true,
      hostExited: true,
      stopExit: stopped.status,
      turnAborted: aborted,
      noReplay: true,
      noFabricatedCompletion: true,
    }
  } catch (error) {
    failure = error
  } finally {
    try { writeFileSync(patchPath, patchBefore, { mode: 0o600 }) } catch { /* best effort */ }
    try { unlinkSync(fixturePath) } catch { /* best effort */ }
    try { unlinkSync(markerPath) } catch { /* best effort */ }
    cleanupCase(installation, trace)
  }
  if (failure !== undefined) throw failure
  return result
}
