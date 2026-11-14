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
import { readFileSync, existsSync, lstatSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { userInfo } from 'node:os'

import xterm from '@xterm/headless'
import { findIsolatedProcesses, killIsolatedProcesses, productionBuildId } from '../../lib/split-smoke-processes.mjs'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'

const ISOLATED_HOME_ENV = 'SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME'
/** Explicit operator opt-in that this run targets a dedicated throwaway test account. */
const ISOLATED_FLAG_ENV = 'SPLIT_PROCESS_MANAGED_HOST_ISOLATED'
/** Operator-provisioned attestation file that marks a dedicated isolated account. */
const ISOLATED_MARKER = '.dsh-pi-tui-managed-host-isolated'
const SYSTEMCTL = '/usr/bin/systemctl'

/**
 * The native-L6 isolation gate. It refuses to touch a real user manager unless
 * the run is an explicitly attested DEDICATED non-root throwaway account:
 *  - `SPLIT_PROCESS_MANAGED_HOST_ISOLATED=1` (explicit operator opt-in),
 *  - `SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME` realpath == the account home,
 *  - a provisioning marker file exists in that home, and
 *  - the uid is a non-root uid.
 * An env var equal to `$HOME` alone is NOT proof of isolation, so this stays
 * NOT_VERIFIED rather than risking the real user manager. Returns a reason
 * string when NOT qualified, else null.
 */
export function managedHostGateReason({ isolatedHome, optIn, markerExists, uid, accountHome }) {
  if (optIn !== '1') return 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: set SPLIT_PROCESS_MANAGED_HOST_ISOLATED=1 on a dedicated throwaway test account'
  if (isolatedHome === undefined || isolatedHome === '') return 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: set SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME to the dedicated test account home'
  let realHome
  let acctHome
  try {
    realHome = realpathSync(isolatedHome)
    acctHome = realpathSync(accountHome)
  } catch {
    return 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: the isolated/account home is unreadable'
  }
  if (realHome !== acctHome) return 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: the isolated HOME is not the account home; refusing to touch the real user manager'
  if (typeof uid !== 'number' || uid === 0) return 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: a non-root dedicated test uid is required'
  if (markerExists !== true) return `NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: this account is not attested as an isolated qualification account (missing ${ISOLATED_MARKER})`
  return null
}

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The isolated-environment gate: a dedicated test user whose account home IS the isolated home. */
function isolatedGate() {
  const isolatedHome = process.env[ISOLATED_HOME_ENV]
  const optIn = process.env[ISOLATED_FLAG_ENV]
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  let accountHome
  try { accountHome = userInfo().homedir } catch { accountHome = undefined }
  let markerExists = false
  if (isolatedHome !== undefined && isolatedHome !== '' && accountHome !== undefined) {
    try { markerExists = existsSync(join(realpathSync(accountHome), ISOLATED_MARKER)) } catch { markerExists = false }
  }
  const reason = managedHostGateReason({ isolatedHome, optIn, markerExists, uid, accountHome })
  if (reason === null) return { qualified: true }
  return { qualified: false, reason }
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

/**
 * Mirror the production ExecStart argument encoding (encodeUnitValue with
 * commandLine=true): backslash, double-quote, `%` specifier and `$` variable
 * escapes, wrapped in double quotes. Cleanup must match the ENCODED form the
 * unit file actually contains, not the raw path (`%`/`$`/`\`/`"`).
 */
export function encodeExecArg(value) {
  let out = ''
  for (const character of value) {
    switch (character) {
      case '\\': out += '\\\\'; break
      case '"': out += '\\"'; break
      case '%': out += '%%'; break
      case '$': out += '$$'; break
      default: out += character
    }
  }
  return `"${out}"`
}

function showUnit(unit, runtimeDir, run = systemctl) {
  const result = run(['--user', '--no-pager', '--no-ask-password', 'show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'FragmentPath', '-p', 'MainPID', '-p', 'UnitFileState', '-p', 'DropInPaths', unit], runtimeDir)
  if (result.status !== 0) throw new SplitSmokeAssertionError(`managed-host: systemctl show failed for ${unit}`)
  const props = {}
  for (const line of (result.stdout ?? '').split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) props[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return props
}

/**
 * The production build fingerprint of THIS installation's package, computed from
 * the verified install artifact (no Host identity required). Cached per package.
 * This lets cleanup recognize a unit the Host created before it published any
 * `instance.json` identity.
 */
const artifactBuildCache = new Map()
function installedArtifactBuildId(installation) {
  try {
    const root = realpathSync(installation.profilePackage)
    if (artifactBuildCache.has(root)) return artifactBuildCache.get(root)
    const dshVersion = JSON.parse(readFileSync(installation.anchor, 'utf8')).version
    const value = productionBuildId(root, dshVersion)
    artifactBuildCache.set(root, value)
    return value
  } catch {
    return undefined
  }
}

/**
 * Decide whether a unit FILE belongs to THIS run — the exact scope, this
 * installation's Host-entry path (unique per install) and the Host's/artifact's
 * install build. Returns a stable reason string when it is NOT ours, else null.
 * The ExecStart match uses the SAME encoding the production unit applies.
 */
export function unitBelongsToRun(content, { scopeId, hostEntry, publishedBuildId }) {
  const lines = content.split('\n')
  if (!lines.includes('X-DshPiTuiOwner=local-host-manager-v1')) return 'foreign-owner'
  if (!lines.includes(`X-DshPiTuiScopeId=${scopeId}`)) return 'foreign-scope'
  // A missing/empty install build cannot bind the unit to this run: NOT ours.
  if (typeof publishedBuildId !== 'string' || publishedBuildId === '') return 'no-published-build'
  if (!lines.includes(`X-DshPiTuiInstallBuild=${publishedBuildId}`)) return 'other-build'
  const encodedHostEntry = encodeExecArg(hostEntry)
  if (!lines.some(line => line.startsWith('ExecStart=') && line.includes(encodedHostEntry))) return 'other-install'
  return null
}

/**
 * A cleanup target must be OUR private unit file: a same-uid, 0600, regular
 * (non-symlink) file. Returns a stable reason when unsafe, else null.
 */
export function unitFileSafetyError(info, uid) {
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600) return 'unsafe-file'
  return null
}

/**
 * Stop and remove THIS run's managed unit, and only when it is provably ours:
 * a same-uid 0600 non-symlink unit file, matching owner/scope/encoded Host-entry/
 * install build, and (if loaded) a manager FragmentPath that names this exact
 * file with no drop-in. The install build comes from the live Host identity when
 * available, else from the verified installation artifact (pre-publish case), so
 * a unit created before the Host published identity is still cleaned up. A
 * failed stop never silently unlinks. `deps` is a test seam; production omits it.
 */
/**
 * A cleanup result is a scenario FAILURE unless it removed this run's unit or
 * there was nothing to remove ('absent'); a foreign/other-build refusal or a
 * stop/unlink failure must be surfaced to the scenario verdict, never silently
 * dropped.
 */
export function cleanupOutcomeError(cleanup) {
  if (cleanup === undefined || cleanup === null) return 'managed-host: cleanup produced no result'
  if (cleanup.removed === true) return undefined
  if (cleanup.reason === 'absent') return undefined
  return `managed-host: this run's managed unit was not cleaned up (${cleanup.reason})`
}

export function stopAndRemoveManagedUnit(installation, trace = () => {}, expectedBuildId, deps = {}) {
  const uid = typeof deps.uid === 'number'
    ? deps.uid
    : (typeof process.getuid === 'function' ? process.getuid() : undefined)
  if (typeof uid !== 'number') return { removed: false, reason: 'no-uid' }
  const run = deps.systemctl ?? systemctl
  let scopeId
  try { scopeId = profileScopeId(uid, installation.profileDir) } catch { return { removed: false, reason: 'no-scope' } }
  const unit = unitName('pi-tui', scopeId)
  let home = deps.homeDir
  if (home === undefined) { try { home = realpathSync(userInfo().homedir) } catch { home = undefined } }
  if (home === undefined) return { removed: false, reason: 'no-home' }
  const unitPath = join(home, '.config', 'systemd', 'user', unit)
  if (!existsSync(unitPath)) return { removed: false, reason: 'absent' }
  let info
  try { info = lstatSync(unitPath) } catch { return { removed: false, reason: 'unreadable' } }
  const fileError = unitFileSafetyError(info, uid)
  if (fileError !== null) return { removed: false, reason: fileError }
  let content
  try { content = readFileSync(unitPath, 'utf8') } catch { return { removed: false, reason: 'unreadable' } }
  let hostEntry
  try { hostEntry = realpathSync(join(installation.profilePackage, 'dist', 'local-host.mjs')) } catch { return { removed: false, reason: 'no-entry' } }
  const instanceBuild = deps.instanceBuild ?? (() => readInstance(installation.dshHome, scopeId)?.buildId)
  const artifactBuild = deps.artifactBuild ?? (() => installedArtifactBuildId(installation))
  // The CANDIDATE artifact fingerprint is the necessary ownership condition: a
  // running Host's identity may belong to an OLDER compatible build that the
  // public Client legitimately reused, so it can only CROSS-CHECK, never grant
  // "this run's install" ownership. Without a candidate build we cannot bind the
  // unit to this run and must not touch it.
  const candidateBuild = artifactBuild()
  if (typeof candidateBuild !== 'string' || candidateBuild === '') return { removed: false, reason: 'no-artifact-build' }
  const observedBuild = (typeof expectedBuildId === 'string' && expectedBuildId !== '') ? expectedBuildId : instanceBuild()
  if (typeof observedBuild === 'string' && observedBuild !== '' && observedBuild !== candidateBuild) {
    return { removed: false, reason: 'not-this-install' }
  }
  const publishedBuildId = candidateBuild
  const foreign = unitBelongsToRun(content, { scopeId, hostEntry, publishedBuildId })
  if (foreign !== null) return { removed: false, reason: foreign }
  const runtimeDir = deps.runtimeDir !== undefined
    ? deps.runtimeDir
    : (existsSync(`/run/user/${String(uid)}`) ? `/run/user/${String(uid)}` : undefined)
  let props
  try { props = showUnit(unit, runtimeDir, run) } catch { return { removed: false, reason: 'manager-unqueryable' } }
  if (props.LoadState !== 'not-found') {
    let realFragment
    try { realFragment = realpathSync(props.FragmentPath) } catch { return { removed: false, reason: 'fragment-unreadable' } }
    if (realFragment !== realpathSync(unitPath)) return { removed: false, reason: 'fragment-mismatch' }
    if ((props.DropInPaths ?? '').trim() !== '') return { removed: false, reason: 'dropin' }
    const stop = run(['--user', '--no-pager', '--no-ask-password', 'stop', unit], runtimeDir)
    if (stop.status !== 0) return { removed: false, reason: 'stop-failed' }
  }
  try { unlinkSync(unitPath) } catch (error) { if (error?.code !== 'ENOENT') return { removed: false, reason: 'unlink-failed' } }
  // The unit FILE is gone, but the manager's loaded state is only refreshed once
  // `daemon-reload` succeeds. Report a distinct failure if it does not, so a
  // stale manager state is never reported as a completed cleanup.
  const reload = run(['--user', '--no-pager', '--no-ask-password', 'daemon-reload'], runtimeDir)
  if (reload.status !== 0) return { removed: false, fileRemoved: true, reason: 'reload-failed' }
  trace('managed-host-unit-removed', { unit })
  return { removed: true }
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
  // Captured while the Host is alive: its registry is gone once stopped, but the
  // cleanup still needs the published install build to prove unit ownership.
  let unitBuildId
  let result
  let failure
  try {
    await waitForCounts(dshHome, counts => counts.host >= 1 && counts.client >= 1, 'one Host + one Client', 90_000)
    await screen.waitForAny(['type a message', '╭'], 'the managed Client', 120_000)
    const props = showUnit(unit, runtimeDir)
    assert(props.LoadState !== undefined && props.LoadState !== 'not-found', 'the profile unit was not loaded by the manager')
    assert(props.FragmentPath !== undefined && realpathSync(props.FragmentPath) === realpathSync(expectedFragment), 'the manager FragmentPath does not name the installed profile unit')
    assert(props.ActiveState === 'active', 'the unit is not active after a cold public Client')
    const identity = readInstance(dshHome, scopeId)
    assert(identity !== undefined && identity.scopeId === scopeId, 'the Host published no authenticated scope identity')
    assert(typeof identity.instanceId === 'string' && /^[0-9a-f-]{36}$/u.test(identity.instanceId), 'the Host identity has no instance id')
    unitBuildId = identity.buildId
    trace('managed-host-systemd-unit', { unit, loadState: props.LoadState, activeState: props.ActiveState })
    // WARM REUSE (B02, NOT B10 cold-start): a second Client attaching while a
    // Host is already running/Ready reuses the SAME single Host and unit. The
    // genuine concurrent cold-start race is proven separately by
    // runManagedHostConcurrentColdStart.
    const second = new PublicDshScreen(installation, 'daemon')
    try {
      await waitForCounts(dshHome, counts => counts.host === 1 && counts.client >= 2, 'a second Client reusing a warm Host', 90_000)
      await second.waitForAny(['type a message', '╭'], 'the second Client', 120_000)
      assert(hostPids(dshHome).length === 1, 'a second Client created or replaced the Host')
      const props2 = showUnit(unit, runtimeDir)
      assert(props2.FragmentPath !== undefined && realpathSync(props2.FragmentPath) === realpathSync(expectedFragment), 'the second Client changed the unit FragmentPath')
      assert(props2.ActiveState === 'active', 'the unit is not active with two Clients')
      trace('managed-host-warm-reuse', { clients: 2, hosts: 1 })
      second.send('/exit\r')
      await second.exitWithin(60_000)
      await waitForCounts(dshHome, counts => counts.client === 1, 'the second Client exit', 30_000)
      assert(hostPids(dshHome).length === 1, 'the Host died when the second Client exited')
    } finally {
      await second.dispose()
    }
    screen.send('/exit\r')
    const exit = await screen.exitWithin(60_000)
    assert(exit.code === 0, `the managed Client /exit did not exit 0: ${JSON.stringify(exit)}`)
    await sleep(500)
    assert(hostPids(dshHome).length >= 1, 'the Host died when the Client exited (it must stay resident)')
    const stop = systemctl(['--user', '--no-pager', '--no-ask-password', 'stop', unit], runtimeDir)
    assert(stop.status === 0, 'systemctl --user stop failed')
    await waitNoHost(dshHome, 30_000)
    assert(props.UnitFileState !== 'enabled', 'the profile unit must not be login auto-enabled')
    result = {
      status: 'PASS',
      scope: 'REAL_SYSTEMD_USER_L6',
      unitOwned: true,
      fragmentPathVerified: true,
      hostSurvivesClientExit: true,
      stoppedOnSigterm: true,
      noEnableOrWantedBy: props.UnitFileState !== 'enabled',
    }
  } catch (error) {
    failure = error
  } finally {
    await screen.dispose()
    // Stop through the manager + remove the owned unit BEFORE the kill backstop.
    // The cleanup result feeds the scenario verdict: a this-run unit that could
    // not be stopped/removed is a real failure, not a PASS.
    const cleanup = stopAndRemoveManagedUnit(installation, trace, unitBuildId)
    const outcomeError = cleanupOutcomeError(cleanup)
    if (outcomeError !== undefined && failure === undefined) failure = new SplitSmokeAssertionError(outcomeError)
    // Only SIGKILL the isolated set when no supervised unit remains; if our unit
    // could not be stopped/removed, killing a still-supervised Host would trip
    // Restart=on-failure, so we leave it and surface the failure above.
    if (cleanup.removed === true || cleanup.reason === 'absent') killIsolatedProcesses(dshHome)
  }
  if (failure !== undefined) throw failure
  return result
}

/**
 * B10: TWO public Clients COLD-start with no Host yet. They must race the full
 * readLocalRecord -> probe -> install unit -> daemon-reload -> start -> readiness
 * chain and converge to ONE Host and ONE unit, with both Clients authenticated to
 * that single Host (unit MainPID equals the published Host PID).
 */
export async function runManagedHostConcurrentColdStart({ installation, trace, dshHome }) {
  const gate = isolatedGate()
  if (!gate.qualified) return { status: 'NOT_VERIFIED', reason: gate.reason }
  const uid = process.getuid()
  const runtimeDir = existsSync(`/run/user/${String(uid)}`) ? `/run/user/${String(uid)}` : undefined
  const probe = systemctl(['--user', '--no-pager', '--no-ask-password', 'show-environment'], runtimeDir)
  if (probe.status !== 0) return { status: 'NOT_VERIFIED', reason: `NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment exited ${String(probe.status)}` }
  const scopeId = profileScopeId(uid, installation.profileDir)
  const unit = unitName('pi-tui', scopeId)
  const expectedFragment = join(realpathSync(userInfo().homedir), '.config', 'systemd', 'user', unit)
  assert(hostPids(dshHome).length === 0, 'the concurrent cold-start scene must begin with no Host')
  // Launch BOTH clients before either has ensured a Host, so they race the full
  // production start chain (not a warm reuse of an already-Ready Host).
  const a = new PublicDshScreen(installation, 'daemon')
  const b = new PublicDshScreen(installation, 'daemon')
  let result
  let failure
  try {
    await waitForCounts(dshHome, counts => counts.host === 1 && counts.client >= 2, 'one Host converged from two cold Clients', 120_000)
    await a.waitForAny(['type a message', '╭'], 'cold Client A', 120_000)
    await b.waitForAny(['type a message', '╭'], 'cold Client B', 120_000)
    assert(hostPids(dshHome).length === 1, 'two cold Clients converged to more than one Host')
    const props = showUnit(unit, runtimeDir)
    assert(props.LoadState !== undefined && props.LoadState !== 'not-found', 'the converged unit is not loaded')
    assert(props.FragmentPath !== undefined && realpathSync(props.FragmentPath) === realpathSync(expectedFragment), 'the converged unit FragmentPath is not the installed unit')
    assert(props.ActiveState === 'active', 'the converged unit is not active')
    const identity = readInstance(dshHome, scopeId)
    assert(identity !== undefined && identity.scopeId === scopeId, 'the converged Host published no scope identity')
    assert(Number(props.MainPID) === identity.hostPid, 'the unit MainPID is not the authenticated Host PID')
    trace('managed-host-concurrent-cold-start', { hosts: 1, clients: 2 })
    result = { status: 'PASS', scope: 'REAL_SYSTEMD_USER_L6', concurrentColdStart: true, oneHost: true, oneUnit: true, bothAuthenticated: true }
  } catch (error) {
    failure = error
  } finally {
    try { a.send('/exit\r') } catch { /* already gone */ }
    try { b.send('/exit\r') } catch { /* already gone */ }
    await a.exitWithin(60_000)
    await b.exitWithin(60_000)
    await a.dispose()
    await b.dispose()
    const cleanup = stopAndRemoveManagedUnit(installation, trace)
    const outcomeError = cleanupOutcomeError(cleanup)
    if (outcomeError !== undefined && failure === undefined) failure = new SplitSmokeAssertionError(outcomeError)
    if (cleanup.removed === true || cleanup.reason === 'absent') killIsolatedProcesses(dshHome)
  }
  if (failure !== undefined) throw failure
  return result
}

async function waitForCondition(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(150)
  }
  throw new SplitSmokeAssertionError(`managed-host: ${label} did not settle before the deadline`)
}

/**
 * B07 negative: the managed unit is ACTIVE, yet a NEW cold Client must not treat
 * that manager state as readiness. With tampered launch material it fails closed
 * on the authenticated identity, and the live Host/unit are neither killed nor
 * replaced.
 */
export async function runManagedHostAuthFailureNegative({ installation, trace, dshHome }) {
  const gate = isolatedGate()
  if (!gate.qualified) return { status: 'NOT_VERIFIED', reason: gate.reason }
  const uid = process.getuid()
  const runtimeDir = existsSync(`/run/user/${String(uid)}`) ? `/run/user/${String(uid)}` : undefined
  const probe = systemctl(['--user', '--no-pager', '--no-ask-password', 'show-environment'], runtimeDir)
  if (probe.status !== 0) return { status: 'NOT_VERIFIED', reason: `NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment exited ${String(probe.status)}` }
  const scopeId = profileScopeId(uid, installation.profileDir)
  const unit = unitName('pi-tui', scopeId)
  const expectedFragment = join(realpathSync(userInfo().homedir), '.config', 'systemd', 'user', unit)
  const launchPath = join(dshHome, 'run', 'dsh-pi-tui', scopeId, 'launch.json')
  const screen = new PublicDshScreen(installation, 'daemon')
  let result
  let failure
  let launchBefore
  try {
    await waitForCounts(dshHome, counts => counts.host >= 1 && counts.client >= 1, 'one Host + one Client', 90_000)
    await screen.waitForAny(['type a message', '╭'], 'the managed Client', 120_000)
    const identity = readInstance(dshHome, scopeId)
    assert(identity !== undefined && identity.scopeId === scopeId, 'the Host published no scope identity')
    const hostBefore = hostPids(dshHome)
    assert(hostBefore.length === 1, 'expected exactly one live Host')
    const propsBefore = showUnit(unit, runtimeDir)
    assert(propsBefore.ActiveState === 'active', 'the managed unit is not active')
    // ACTIVE is not Ready: a new Client must still prove the authenticated identity.
    launchBefore = readFileSync(launchPath, 'utf8')
    writeFileSync(launchPath, `${JSON.stringify({ schema: 1, instanceId: '00000000-0000-4000-8000-000000000000', connectUrl: `${identity.origin}/connect?token=tampered` })}\n`, { mode: 0o600 })
    const second = new PublicDshScreen(installation, 'daemon')
    try {
      const exit = await second.exitWithin(60_000)
      assert(exit.code !== 0 && exit.code !== 'timeout', `a tampered Host identity must fail the new Client, saw ${JSON.stringify(exit)}`)
      assert(/HOST_IDENTITY_MISMATCH|HOST_AUTH_FAILED|LOCAL_FILE_UNSAFE/u.test(second.records.raw), 'the authentication failure was not reported')
    } finally {
      await second.dispose()
    }
    writeFileSync(launchPath, launchBefore, { mode: 0o600 })
    launchBefore = undefined
    assert(hostPids(dshHome).length === 1 && hostPids(dshHome)[0] === hostBefore[0], 'a failed authentication killed or replaced the live Host')
    const propsAfter = showUnit(unit, runtimeDir)
    assert(propsAfter.ActiveState === 'active' && propsAfter.FragmentPath !== undefined && realpathSync(propsAfter.FragmentPath) === realpathSync(expectedFragment), 'the managed unit changed after a failed authentication')
    trace('managed-host-auth-failure-negative', { hostPid: hostBefore[0] })
    result = { status: 'PASS', scope: 'REAL_SYSTEMD_USER_L6', authFailureFailsClosed: true, liveHostUnchanged: true }
  } catch (error) {
    failure = error
  } finally {
    if (launchBefore !== undefined) { try { writeFileSync(launchPath, launchBefore, { mode: 0o600 }) } catch { /* best effort */ } }
    try { screen.send('/exit\r') } catch { /* gone */ }
    await screen.exitWithin(60_000)
    await screen.dispose()
    const cleanup = stopAndRemoveManagedUnit(installation, trace)
    const outcomeError = cleanupOutcomeError(cleanup)
    if (outcomeError !== undefined && failure === undefined) failure = new SplitSmokeAssertionError(outcomeError)
    if (cleanup.removed === true || cleanup.reason === 'absent') killIsolatedProcesses(dshHome)
  }
  if (failure !== undefined) throw failure
  return result
}

/**
 * B13: a crashed managed Host is restarted by systemd `Restart=on-failure` as a
 * NEW authenticated instance under the SAME owned unit.
 */
export async function runManagedHostCrashRestart({ installation, trace, dshHome }) {
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
  let result
  let failure
  try {
    await waitForCounts(dshHome, counts => counts.host >= 1 && counts.client >= 1, 'one Host + one Client', 90_000)
    await screen.waitForAny(['type a message', '╭'], 'the managed Client', 120_000)
    const before = readInstance(dshHome, scopeId)
    assert(before !== undefined && before.scopeId === scopeId, 'the Host published no scope identity')
    const oldPid = before.hostPid
    const oldInstance = before.instanceId
    process.kill(oldPid, 'SIGKILL')
    await waitForCondition(() => {
      const current = readInstance(dshHome, scopeId)
      return current !== undefined && current.instanceId !== oldInstance && current.hostPid !== oldPid && hostPids(dshHome).includes(current.hostPid)
    }, 'the systemd-restarted Host', 60_000)
    const after = readInstance(dshHome, scopeId)
    assert(after !== undefined && after.instanceId !== oldInstance && after.hostPid !== oldPid, 'the restarted Host is not a new instance')
    const props = showUnit(unit, runtimeDir)
    assert(props.ActiveState === 'active', 'the unit is not active after the Host crash')
    assert(props.FragmentPath !== undefined && realpathSync(props.FragmentPath) === realpathSync(expectedFragment), 'the unit FragmentPath changed after the restart')
    assert(Number(props.MainPID) === after.hostPid, 'the restarted unit MainPID is not the new Host PID')
    trace('managed-host-crash-restart', { oldPid, newPid: after.hostPid })
    result = { status: 'PASS', scope: 'REAL_SYSTEMD_USER_L6', crashRestartedByManager: true, newInstance: true }
  } catch (error) {
    failure = error
  } finally {
    try { screen.send('/exit\r') } catch { /* gone */ }
    await screen.exitWithin(60_000)
    await screen.dispose()
    const cleanup = stopAndRemoveManagedUnit(installation, trace)
    const outcomeError = cleanupOutcomeError(cleanup)
    if (outcomeError !== undefined && failure === undefined) failure = new SplitSmokeAssertionError(outcomeError)
    if (cleanup.removed === true || cleanup.reason === 'absent') killIsolatedProcesses(dshHome)
  }
  if (failure !== undefined) throw failure
  return result
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
    assert(existsSync(hostLog), 'the fallback Host did not write its host.log')
    const hostLogPrivate = (statSync(hostLog).mode & 0o777) === 0o600
    assert(hostLogPrivate, 'the fallback host.log must be 0600')
    const identity = readInstance(dshHome, scopeId)
    assert(identity !== undefined && identity.scopeId === scopeId, 'the fallback Host published no scope identity')
    screen.send('/exit\r')
    const exit = await screen.exitWithin(60_000)
    assert(exit.code === 0, `the fallback Client /exit did not exit 0: ${JSON.stringify(exit)}`)
    await sleep(500)
    assert(hostPids(dshHome).length >= 1, 'the fallback Host died when the Client exited')
    trace('managed-host-fallback', { scopeId })
    return { status: 'PASS', scope: 'REAL_ABSENT_MANAGER_FALLBACK_L6', usesDetachedSpawn: true, hostLogPrivate, hostSurvivesClientExit: true }
  } finally {
    await screen.dispose()
    stopAndRemoveManagedUnit(installation, trace)
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
    stopAndRemoveManagedUnit(installation, trace)
    killIsolatedProcesses(dshHome)
  }
}
