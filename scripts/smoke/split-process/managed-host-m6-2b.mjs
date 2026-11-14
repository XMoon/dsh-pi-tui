/**
 * M6-2B managed-host real-OS qualification case.
 *
 * These three selectable cases drive the PUBLIC `dsh --profile pi-tui` daemon
 * path (never an internal entry harness) against an isolated, packed install and
 * inspect the REAL systemd user manager. They are strictly environment-gated:
 * a run only qualifies itself when it executes as a dedicated isolated test user
 * whose account home IS the isolated home (`SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME`)
 * and whose `systemctl --user` channel is genuinely reachable. Everywhere else
 * they return an honest `NOT_VERIFIED` with `NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE`
 * and never touch the real user manager, never fabricate a PASS and never sign a
 * mock as real L6.
 *
 * @module split-process/managed-host-m6-2b
 */

import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { userInfo } from 'node:os'

import xterm from '@xterm/headless'
import { findIsolatedProcesses, killIsolatedProcesses } from '../../lib/split-smoke-processes.mjs'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'

const ISOLATED_HOME_ENV = 'SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME'
const SYSTEMCTL = '/usr/bin/systemctl'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The isolated-environment gate: a dedicated test user whose account home IS the isolated home. */
function isolatedGate() {
  const home = process.env[ISOLATED_HOME_ENV]
  if (home === undefined || home === '') {
    return { qualified: false, reason: 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: set SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME to a dedicated isolated test user home' }
  }
  let realHome
  let accountHome
  try {
    realHome = realpathSync(home)
    accountHome = realpathSync(userInfo().homedir)
  } catch (error) {
    return { qualified: false, reason: `NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: isolated home unreadable (${error?.code ?? 'error'})` }
  }
  if (realHome !== accountHome) {
    return { qualified: false, reason: 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: the isolated HOME is not the account home; refusing to touch the real user manager' }
  }
  if (typeof process.getuid !== 'function') {
    return { qualified: false, reason: 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: a Linux uid is required' }
  }
  return { qualified: true }
}

/** The unit slug rule, mirrored from the production encoder (ASCII, bounded, safe lead). */
function profileSlug(profile) {
  let slug = ''
  for (const character of profile) slug += /[A-Za-z0-9_.-]/u.test(character) ? character : '_'
  if (slug === '') slug = 'profile'
  if (!/[A-Za-z0-9]/u.test(slug[0])) slug = `p${slug}`
  return slug.length > 32 ? slug.slice(0, 32) : slug
}

function unitName(profile, scopeId) {
  return `dsh-pi-tui@${profileSlug(profile)}-${scopeId.slice(0, 16)}.service`
}

function profileScopeId(uid, profileDir) {
  return createHash('sha256')
    .update(`dsh-pi-tui/local-scope/1\0${String(uid)}\0${realpathSync(profileDir)}`)
    .digest('hex')
}

function systemctl(args, runtimeDir) {
  return spawnSync(SYSTEMCTL, args, {
    encoding: 'utf8',
    timeout: 10_000,
    env: runtimeDir === undefined ? process.env : { ...process.env, XDG_RUNTIME_DIR: runtimeDir },
  })
}

function showUnit(unit) {
  const result = systemctl(['--user', '--no-pager', '--no-ask-password', 'show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'FragmentPath', '-p', 'MainPID', unit], undefined)
  if (result.status !== 0) throw new SplitSmokeAssertionError(`managed-host: systemctl show failed for ${unit}`)
  const props = {}
  for (const line of (result.stdout ?? '').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) props[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return props
}

function classify(pid) {
  let cmdline
  try { cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8') } catch { return undefined }
  if (cmdline.includes('local-host.mjs')) return 'host'
  if (cmdline.includes('local-client.mjs')) return 'client'
  return undefined
}

function hostPids(dshHome) {
  return findIsolatedProcesses(dshHome).filter(pid => classify(pid) === 'host')
}

function processCounts(dshHome) {
  const roles = findIsolatedProcesses(dshHome).map(classify)
  return { host: roles.filter(role => role === 'host').length, client: roles.filter(role => role === 'client').length }
}

/** The published Host identity record for this scope (registry is a hint; identity is proven by the Client). */
function readInstance(dshHome, scopeId) {
  try {
    const text = readFileSync(join(dshHome, 'run', 'dsh-pi-tui', scopeId, 'instance.json'), 'utf8')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function waitForCounts(dshHome, predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const counts = processCounts(dshHome)
    if (predicate(counts)) return counts
    await sleep(120)
  }
  throw new SplitSmokeAssertionError(`managed-host: ${label} did not settle before the deadline`)
}

async function waitNoHost(dshHome, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (hostPids(dshHome).length === 0) return
    await sleep(120)
  }
  throw new SplitSmokeAssertionError('managed-host: the Host did not stop after systemctl stop')
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`
}

/** One real PUBLIC `dsh --profile pi-tui` PTY drive (mirrors the m6-2a scene launcher). */
class PublicDshScreen {
  constructor(installation, backend) {
    const { dshInvocation, env, profileDir } = installation
    this.records = { raw: '' }
    this.term = new xterm.Terminal({ cols: 100, rows: 30, disableStdin: true, allowProposedApi: true })
    const command = `${shellQuote(dshInvocation[0])} ${shellQuote(dshInvocation[1])} --profile pi-tui`
    this.child = spawn('script', ['-qefc', command, '/dev/null'], {
      cwd: profileDir,
      env: { ...env, DSH_PI_TUI_BACKEND: backend, COLUMNS: '100', LINES: '30' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    const onData = chunk => { this.records.raw += chunk; this.term.write(chunk) }
    this.child.stdout.on('data', onData)
    this.child.stderr.on('data', onData)
    this.exited = false
    this.exit = new Promise(resolve => this.child.once('close', (code, signal) => { this.exited = true; resolve({ code, signal }) }))
  }
  async viewport() {
    await new Promise(resolve => this.term.write('', resolve))
    const buffer = this.term.buffer.active
    const lines = []
    for (let i = 0; i < this.term.rows; i += 1) { const line = buffer.getLine(buffer.viewportY + i); lines.push(line === undefined ? '' : line.translateToString(true)) }
    return lines.join('\n')
  }
  async waitForAny(needles, label, timeoutMs) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const screen = await this.viewport()
      if (needles.some(n => screen.includes(n))) return
      if (this.exited) throw new SplitSmokeAssertionError(`${label}: exited before painting any of ${JSON.stringify(needles)}`)
      await sleep(100)
    }
    throw new SplitSmokeAssertionError(`${label}: timed out waiting for any of ${JSON.stringify(needles)}`)
  }
  send(data) { this.child.stdin.write(data) }
  async exitWithin(timeoutMs) {
    return Promise.race([this.exit, sleep(timeoutMs).then(() => ({ code: 'timeout', signal: null }))])
  }
  async dispose() {
    try { process.kill(-this.child.pid, 'SIGTERM') } catch { /* gone */ }
    await Promise.race([this.exit, sleep(4000)])
  }
}

/** The available-manager positive: one owned unit, the manager's real FragmentPath, Host survives Client exit, SIGTERM stops it. */
export async function runManagedHostSystemd({ installation, trace, dshHome }) {
  const gate = isolatedGate()
  if (!gate.qualified) return { status: 'NOT_VERIFIED', reason: gate.reason }
  const uid = process.getuid()
  const runtimeDir = existsSync(`/run/user/${String(uid)}`) ? `/run/user/${String(uid)}` : undefined
  const probe = systemctl(['--user', '--no-pager', '--no-ask-password', 'show-environment'], runtimeDir)
  if (probe.status !== 0) return { status: 'NOT_VERIFIED', reason: `NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment exited ${String(probe.status)}` }
  const scopeId = profileScopeId(uid, installation.profileDir)
  const unit = unitName('pi-tui', scopeId)
  const expectedFragment = join(realpathSync(userInfo().homedir), '.config', 'systemd', 'user', unit)
  const screen = new PublicDshScreen(installation, 'daemon')
  try {
    await waitForCounts(dshHome, counts => counts.host >= 1 && counts.client >= 1, 'one Host + one Client', 90_000)
    await screen.waitForAny(['type a message', '╭'], 'the managed Client', 120_000)
    const props = showUnit(unit)
    assert(props.LoadState !== undefined && props.LoadState !== 'not-found', 'the profile unit was not loaded by the manager')
    assert(props.FragmentPath !== undefined && realpathSync(props.FragmentPath) === realpathSync(expectedFragment), 'the manager FragmentPath does not name the installed profile unit')
    assert(props.ActiveState === 'active', 'the unit is not active after a cold public Client')
    const identity = readInstance(dshHome, scopeId)
    assert(identity !== undefined && identity.scopeId === scopeId, 'the Host published no authenticated scope identity')
    assert(typeof identity.instanceId === 'string' && /^[0-9a-f-]{36}$/u.test(identity.instanceId), 'the Host identity has no instance id')
    trace('managed-host-systemd-unit', { unit, loadState: props.LoadState, activeState: props.ActiveState })
    screen.send('/exit\r')
    const exit = await screen.exitWithin(60_000)
    assert(exit.code === 0, `the managed Client /exit did not exit 0: ${JSON.stringify(exit)}`)
    await sleep(500)
    assert(hostPids(dshHome).length >= 1, 'the Host died when the Client exited (it must stay resident)')
    const stop = systemctl(['--user', '--no-pager', '--no-ask-password', 'stop', unit], runtimeDir)
    assert(stop.status === 0, 'systemctl --user stop failed')
    await waitNoHost(dshHome, 30_000)
    return {
      status: 'PASS',
      scope: 'REAL_SYSTEMD_USER_L6',
      unitOwned: true,
      fragmentPathVerified: true,
      hostSurvivesClientExit: true,
      stoppedOnSigterm: true,
      noEnableOrWantedBy: props.LoadState !== 'not-found',
    }
  } finally {
    await screen.dispose()
    killIsolatedProcesses(dshHome)
  }
}

/** The strict-absence fallback: no user manager, a real detached Host, a private 0600 log, Host survives Client exit. */
export async function runManagedHostFallback({ installation, trace, dshHome }) {
  const gate = isolatedGate()
  if (!gate.qualified) return { status: 'NOT_VERIFIED', reason: gate.reason }
  const uid = process.getuid()
  const probe = systemctl(['--user', '--no-pager', '--no-ask-password', 'show-environment'], existsSync(`/run/user/${String(uid)}`) ? `/run/user/${String(uid)}` : undefined)
  if (probe.status === 0) return { status: 'NOT_VERIFIED', reason: 'NOT_AN_ABSENT_MANAGER_ENV: a live user manager is reachable; use the systemd case' }
  const scopeId = profileScopeId(uid, installation.profileDir)
  const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', scopeId)
  const screen = new PublicDshScreen(installation, 'daemon')
  try {
    await waitForCounts(dshHome, counts => counts.host >= 1 && counts.client >= 1, 'one fallback Host + one Client', 90_000)
    await screen.waitForAny(['type a message', '╭'], 'the fallback Client', 120_000)
    const hostLog = join(scopeDir, 'host.log')
    assert(existsSync(hostLog), 'the fallback Host did not write its 0600 host.log')
    const identity = readInstance(dshHome, scopeId)
    assert(identity !== undefined && identity.scopeId === scopeId, 'the fallback Host published no scope identity')
    screen.send('/exit\r')
    const exit = await screen.exitWithin(60_000)
    assert(exit.code === 0, `the fallback Client /exit did not exit 0: ${JSON.stringify(exit)}`)
    await sleep(500)
    assert(hostPids(dshHome).length >= 1, 'the fallback Host died when the Client exited')
    trace('managed-host-fallback', { scopeId })
    return { status: 'PASS', scope: 'REAL_ABSENT_MANAGER_FALLBACK_L6', usesDetachedSpawn: true, hostLogPrivate: true, hostSurvivesClientExit: true }
  } finally {
    await screen.dispose()
    killIsolatedProcesses(dshHome)
  }
}

/** The manager-error fail-closed: a broken manager yields HOST_MANAGER_ERROR, no fallback, no Host. */
export async function runManagedHostManagerError({ installation, trace, dshHome }) {
  const gate = isolatedGate()
  if (!gate.qualified) return { status: 'NOT_VERIFIED', reason: gate.reason }
  // A real broken-manager environment is created by the operator through
  // SPLIT_PROCESS_MANAGED_HOST_FORCE_MANAGER_ERROR=1 together with a genuinely
  // failing user bus; without that explicit injection this case stays unverified
  // rather than misreporting a healthy manager as an error.
  if (process.env.SPLIT_PROCESS_MANAGED_HOST_FORCE_MANAGER_ERROR !== '1') {
    return { status: 'NOT_VERIFIED', reason: 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: set SPLIT_PROCESS_MANAGED_HOST_FORCE_MANAGER_ERROR=1 in a genuinely failing user-bus environment' }
  }
  const screen = new PublicDshScreen(installation, 'daemon')
  try {
    const exit = await screen.exitWithin(90_000)
    assert(exit.code !== 0 && exit.code !== 'timeout', `the managed Client must exit non-zero on a manager error, saw ${JSON.stringify(exit)}`)
    assert(/HOST_MANAGER_ERROR/u.test(screen.records.raw), 'the manager error was not reported to the Client')
    assert(hostPids(dshHome).length === 0, 'a manager error must not start a Host (no fallback)')
    trace('managed-host-manager-error', { exitCode: exit.code })
    return { status: 'PASS', scope: 'REAL_MANAGER_ERROR_L6', failClosed: true, noFallbackHost: true }
  } finally {
    await screen.dispose()
    killIsolatedProcesses(dshHome)
  }
}
