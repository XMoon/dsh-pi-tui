/**
 * M6-2B managed-host real-OS qualification case.
 *
 * These selectable cases drive the PUBLIC `dsh --profile pi-tui` daemon and
 * `daemon ...` command paths (never an internal entry harness) against an
 * isolated, packed install and inspect the REAL systemd user manager. The basic
 * independent-process cases need no manager at all; the systemd cases FIRST run
 * the real `daemon install` and only then a public cold start. They are strictly
 * environment-gated:
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
import { createSplitSmokeProfile } from '../../lib/split-smoke-profile.mjs'
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
export function installedArtifactBuildId(installation) {
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
 * Decide whether a unit file belongs to this isolated run's scope and build. Returns a stable reason string when it is NOT ours, else null.
 */
export function unitBelongsToRun(content, { scopeId, publishedBuildId }) {
  const lines = content.split('\n')
  if (!lines.includes('X-DshPiTuiOwner=local-host-manager-v1')) return 'foreign-owner'
  if (!lines.includes(`X-DshPiTuiScopeId=${scopeId}`)) return 'foreign-scope'
  // A missing/empty install build cannot bind the unit to this run: NOT ours.
  if (typeof publishedBuildId !== 'string' || publishedBuildId === '') return 'no-published-build'
  if (!lines.includes(`X-DshPiTuiInstallBuild=${publishedBuildId}`)) return 'other-build'
  return null
}

/**
 * A cleanup target must be OUR private unit file: a same-uid regular file or user-created configuration link. Returns a stable reason when unsafe, else null.
 */
export function unitFileSafetyError(info, uid) {
  if ((!info.isSymbolicLink() && !info.isFile()) || info.uid !== uid) return 'unsafe-file'
  return null
}

/**
 * Stop and remove THIS run's managed unit, and only when it is provably ours:
 * a same-uid unit path, matching owner/scope/install build, and (if loaded) a
 * canonical manager FragmentPath matching its configuration target. User
 * runtime directives and drop-ins are preserved. The install build comes from the live Host identity when
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
  const foreign = unitBelongsToRun(content, { scopeId, publishedBuildId })
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

/** Field 22 (`starttime`) from `/proc/<pid>/stat` (undefined when unavailable). */
function linuxStarttime(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    const close = stat.lastIndexOf(')')
    if (close < 0) return undefined
    const fields = stat.slice(close + 2).trim().split(/\s+/u)
    return /^\d+$/u.test(fields[19] ?? '') ? fields[19] : undefined
  } catch {
    return undefined
  }
}

/**
 * Authorization for the B13 crash scene. The registry PID is an unauthenticated
 * hint; a SIGKILL is allowed only when the target is the VERIFIED managed unit's
 * MainPID, a live Host process of THIS isolated scope, and the same kernel
 * process identity (starttime) the published record names.
 */
export function killAuthorizationError({ targetPid, unitMainPid, hostPids: liveHostPids, publishedStarttime, liveStarttime }) {
  if (!Number.isSafeInteger(targetPid) || targetPid < 1) return 'invalid target pid'
  if (!Number.isSafeInteger(unitMainPid) || unitMainPid !== targetPid) return 'target pid is not the verified unit MainPID'
  if (!Array.isArray(liveHostPids) || !liveHostPids.includes(targetPid)) return 'target pid is not a live Host process of this isolated scope'
  if (typeof publishedStarttime !== 'string' || publishedStarttime === '' || publishedStarttime !== liveStarttime) return 'target pid kernel starttime does not match the published Host identity'
  return null
}

/** Kill only an authorized target; returns whether a kill was actually issued. */
export function killVerifiedHost({ targetPid, unitMainPid, hostPids: liveHostPids, publishedStarttime, readStarttime = linuxStarttime, kill = process.kill }) {
  const reason = killAuthorizationError({
    targetPid, unitMainPid, hostPids: liveHostPids, publishedStarttime, liveStarttime: readStarttime(targetPid),
  })
  if (reason !== null) return { killed: false, reason }
  try {
    kill(targetPid, 'SIGKILL')
    return { killed: true }
  } catch (error) {
    return { killed: false, reason: `kill failed: ${error?.code ?? 'error'}` }
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

/** Run ONE public `dsh --profile pi-tui ...` command without a TTY. */
function runPublicDsh(installation, args, extraEnv = {}) {
  const [executable, ...prefix] = installation.dshInvocation
  const result = spawnSync(executable, [...prefix, '--profile', 'pi-tui', ...args], {
    cwd: installation.profileDir,
    env: { ...installation.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 120_000,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** The fixed user unit facts for ONE installation. */
export function unitFactsFor(installation) {
  const uid = process.getuid()
  const scopeId = profileScopeId(uid, installation.profileDir)
  return {
    scopeId,
    unit: unitName('pi-tui', scopeId),
    unitPath: join(realpathSync(userInfo().homedir), '.config', 'systemd', 'user', unitName('pi-tui', scopeId)),
  }
}

/**
 * The explicit install step every systemd case starts with: the real
 * `daemon install` must create/verify ONE loaded but INACTIVE unit and must not
 * start or enable a Host. A second install is idempotent.
 */
function installVerifiedUnit(installation, runtimeDir) {
  const facts = unitFactsFor(installation)
  assert(!existsSync(facts.unitPath), 'the systemd case must begin with no installed unit')
  assert(hostPids(installation.dshHome).length === 0, 'the systemd case must begin with no Host')
  const installed = runPublicDsh(installation, ['daemon', 'install'])
  assert(installed.status === 0, `daemon install failed: ${installed.stderr.slice(-800)}`)
  assert(existsSync(facts.unitPath), 'daemon install did not create the profile unit')
  const props = showUnit(facts.unit, runtimeDir)
  assert(props.LoadState === 'loaded', `install did not make the manager load the unit (LoadState=${String(props.LoadState)})`)
  assert(props.ActiveState === 'inactive', `install must not start the unit (ActiveState=${String(props.ActiveState)})`)
  assert(props.UnitFileState !== 'enabled', 'install must not enable the unit')
  assert(Number(props.MainPID ?? '0') === 0, 'install must not start a Host')
  assert(hostPids(installation.dshHome).length === 0, 'install must not start a Host process')
  const repeat = runPublicDsh(installation, ['daemon', 'install'])
  assert(repeat.status === 0, `a repeat daemon install must be idempotent: ${repeat.stderr.slice(-500)}`)
  const repeatProps = showUnit(facts.unit, runtimeDir)
  assert(repeatProps.ActiveState === 'inactive' && Number(repeatProps.MainPID ?? '0') === 0,
    'a repeat install must not start the unit or a Host')
  return facts
}

/** Parse the last stable key=value status block a management command printed. */
function statusOf(stdout) {
  const lines = stdout.split('\n')
  const start = lines.findLastIndex(line => line.startsWith('profile='))
  const fields = {}
  if (start < 0) return fields
  for (const line of lines.slice(start)) {
    const at = line.indexOf('=')
    if (at > 0 && !line.includes(' ')) fields[line.slice(0, at)] = line.slice(at + 1)
  }
  return fields
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
  const { scopeId, unit, unitPath } = unitFactsFor(installation)
  const expectedFragment = unitPath
  // Captured while the Host is alive: its registry is gone once stopped, but the
  // cleanup still needs the published install build to prove unit ownership.
  let unitBuildId
  let result
  let failure
  let screen
  try {
    installVerifiedUnit(installation, runtimeDir)
    screen = new PublicDshScreen(installation, 'daemon')
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
    if (screen !== undefined) await screen.dispose()
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
 * The basic-daemon positive: with NO installed unit, two public Clients
 * cold-start, converge on exactly ONE independent Host, authenticate to it, and
 * never create a unit or depend on the user manager.
 */
export async function runManagedHostConcurrentColdStart({ installation, trace, dshHome }) {
  const gate = isolatedGate()
  if (!gate.qualified) return { status: 'NOT_VERIFIED', reason: gate.reason }
  const uid = process.getuid()
  const runtimeDir = existsSync(`/run/user/${String(uid)}`) ? `/run/user/${String(uid)}` : undefined
  const probe = systemctl(['--user', '--no-pager', '--no-ask-password', 'show-environment'], runtimeDir)
  if (probe.status !== 0) {
    // P01 is specifically "systemd usable but no unit installed": without a
    // reachable manager this case cannot prove that condition.
    return { status: 'NOT_VERIFIED', reason: `NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment exited ${String(probe.status)}` }
  }
  const { scopeId, unitPath } = unitFactsFor(installation)
  assert(hostPids(dshHome).length === 0, 'the concurrent cold-start scene must begin with no Host')
  assert(!existsSync(unitPath), 'the basic-daemon scene must begin with no installed unit')
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
    assert(!existsSync(unitPath), 'a public cold start with no installed unit must never create a unit')
    const identity = readInstance(dshHome, scopeId)
    assert(identity !== undefined && identity.scopeId === scopeId, 'the converged Host published no scope identity')
    assert(hostPids(dshHome).includes(identity.hostPid), 'the converged registry PID is not the live Host')
    const status = runPublicDsh(installation, ['daemon', 'status'])
    const fields = statusOf(status.stdout)
    assert(status.status === 0, `the basic-daemon status must succeed: ${status.stderr.slice(-500)}`)
    assert(fields.manager === 'process' && fields['user-manager'] === 'not-checked' && fields.unit === 'none',
      `the basic-daemon status must report manager=process/user-manager=not-checked/unit=none: ${status.stdout}`)
    trace('managed-host-basic-daemon', { hosts: 1, clients: 2, unit: 'none' })
    result = { status: 'PASS', scope: 'REAL_BASIC_DAEMON_L6', concurrentColdStart: true, oneHost: true, noUnitCreated: true, managerProcess: true }
  } catch (error) {
    failure = error
  } finally {
    try { a.send('/exit\r') } catch { /* already gone */ }
    try { b.send('/exit\r') } catch { /* already gone */ }
    await a.exitWithin(60_000)
    await b.exitWithin(60_000)
    await a.dispose()
    await b.dispose()
    killIsolatedProcesses(dshHome)
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
  const { scopeId, unit, unitPath } = unitFactsFor(installation)
  const expectedFragment = unitPath
  const launchPath = join(dshHome, 'run', 'dsh-pi-tui', scopeId, 'launch.json')
  let screen
  let result
  let failure
  let launchBefore
  try {
    installVerifiedUnit(installation, runtimeDir)
    screen = new PublicDshScreen(installation, 'daemon')
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
    if (screen !== undefined) {
      try { screen.send('/exit\r') } catch { /* gone */ }
      await screen.exitWithin(60_000)
      await screen.dispose()
    }
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
  const { scopeId, unit, unitPath } = unitFactsFor(installation)
  const expectedFragment = unitPath
  let screen
  let result
  let failure
  try {
    installVerifiedUnit(installation, runtimeDir)
    screen = new PublicDshScreen(installation, 'daemon')
    await waitForCounts(dshHome, counts => counts.host >= 1 && counts.client >= 1, 'one Host + one Client', 90_000)
    await screen.waitForAny(['type a message', '╭'], 'the managed Client', 120_000)
    const before = readInstance(dshHome, scopeId)
    assert(before !== undefined && before.scopeId === scopeId, 'the Host published no scope identity')
    const oldPid = before.hostPid
    const oldInstance = before.instanceId
    const propsBefore = showUnit(unit, runtimeDir)
    assert(propsBefore.ActiveState === 'active', 'the managed unit must be active before the crash')
    // The registry PID is a hint, never kill authority: require the verified
    // unit MainPID, an isolated Host process, and the same kernel starttime.
    const killResult = killVerifiedHost({
      targetPid: oldPid,
      unitMainPid: Number(propsBefore.MainPID),
      hostPids: hostPids(dshHome),
      publishedStarttime: before.hostStarttime,
    })
    assert(killResult.killed === true, `refusing an unverified crash target: ${killResult.reason}`)
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
    if (screen !== undefined) {
      try { screen.send('/exit\r') } catch { /* gone */ }
      await screen.exitWithin(60_000)
      await screen.dispose()
    }
    const cleanup = stopAndRemoveManagedUnit(installation, trace)
    const outcomeError = cleanupOutcomeError(cleanup)
    if (outcomeError !== undefined && failure === undefined) failure = new SplitSmokeAssertionError(outcomeError)
    if (cleanup.removed === true || cleanup.reason === 'absent') killIsolatedProcesses(dshHome)
  }
  if (failure !== undefined) throw failure
  return result
}

/**
 * B11: TWO real Profile installations under the same isolated account stay
 * isolated — distinct scopes, Host instances and units; stopping one profile's
 * Host never affects the other.
 */
export async function runManagedHostTwoProfileIsolation({ installation, trace, dshHome, tarball, targetDshVersion, workDir }) {
  const gate = isolatedGate()
  if (!gate.qualified) return { status: 'NOT_VERIFIED', reason: gate.reason }
  const uid = process.getuid()
  const runtimeDir = existsSync(`/run/user/${String(uid)}`) ? `/run/user/${String(uid)}` : undefined
  const probe = systemctl(['--user', '--no-pager', '--no-ask-password', 'show-environment'], runtimeDir)
  if (probe.status !== 0) return { status: 'NOT_VERIFIED', reason: `NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment exited ${String(probe.status)}` }
  assert(typeof tarball === 'string' && typeof targetDshVersion === 'string' && typeof workDir === 'string', 'the two-profile case needs the lane tarball/workDir facts')
  // Provision a SECOND real Profile installation (its own DSH home/profile path).
  const second = createSplitSmokeProfile({ tarball, targetDshVersion, workDir: join(workDir, 'profile-b') })
  const { scopeId: scopeA, unit: unitA } = unitFactsFor(installation)
  const { scopeId: scopeB, unit: unitB } = unitFactsFor(second)
  assert(scopeA !== scopeB, 'the two profiles resolved to the same scope')
  assert(unitA !== unitB, 'the two profiles resolved to the same unit name')
  let a
  let b
  let result
  let failure
  try {
    installVerifiedUnit(installation, runtimeDir)
    installVerifiedUnit(second, runtimeDir)
    a = new PublicDshScreen(installation, 'daemon')
    b = new PublicDshScreen(second, 'daemon')
    await waitForCounts(installation.dshHome, counts => counts.host >= 1 && counts.client >= 1, 'profile A Host/Client', 120_000)
    await waitForCounts(second.dshHome, counts => counts.host >= 1 && counts.client >= 1, 'profile B Host/Client', 120_000)
    await a.waitForAny(['type a message', '╭'], 'profile A Client', 120_000)
    await b.waitForAny(['type a message', '╭'], 'profile B Client', 120_000)
    const identityA = readInstance(installation.dshHome, scopeA)
    const identityB = readInstance(second.dshHome, scopeB)
    assert(identityA !== undefined && identityB !== undefined, 'both Hosts must publish an identity')
    assert(identityA.instanceId !== identityB.instanceId, 'the two profiles shared one Host instance')
    assert(identityA.hostPid !== identityB.hostPid, 'the two profiles shared one Host PID')
    assert(showUnit(unitA, runtimeDir).ActiveState === 'active' && showUnit(unitB, runtimeDir).ActiveState === 'active', 'both profile units must be active')
    // Stopping profile A's Host/unit must never touch profile B.
    assert(systemctl(['--user', '--no-pager', '--no-ask-password', 'stop', unitA], runtimeDir).status === 0, 'stopping profile A unit failed')
    await waitNoHost(installation.dshHome, 30_000)
    assert(hostPids(second.dshHome).length === 1, 'stopping profile A killed the profile B Host')
    assert(showUnit(unitB, runtimeDir).ActiveState === 'active', 'profile B unit stopped together with profile A')
    trace('managed-host-two-profile-isolation', { unitA, unitB })
    result = { status: 'PASS', scope: 'REAL_SYSTEMD_USER_L6', twoProfiles: true, distinctInstances: true, crossProfileUnaffected: true }
  } catch (error) {
    failure = error
  } finally {
    if (a !== undefined) {
      try { a.send('/exit\r') } catch { /* gone */ }
      await a.exitWithin(60_000)
      await a.dispose()
    }
    if (b !== undefined) {
      try { b.send('/exit\r') } catch { /* gone */ }
      await b.exitWithin(60_000)
      await b.dispose()
    }
    const cleanupA = stopAndRemoveManagedUnit(installation, trace)
    const cleanupB = stopAndRemoveManagedUnit(second, trace)
    const outcomeError = cleanupOutcomeError(cleanupA) ?? cleanupOutcomeError(cleanupB)
    if (outcomeError !== undefined && failure === undefined) failure = new SplitSmokeAssertionError(outcomeError)
    if (cleanupA.removed === true || cleanupA.reason === 'absent') killIsolatedProcesses(installation.dshHome)
    if (cleanupB.removed === true || cleanupB.reason === 'absent') killIsolatedProcesses(second.dshHome)
  }
  if (failure !== undefined) throw failure
  return result
}

/** The basic daemon: a real independent Host, private 0600 log, survives Client exit, creates no unit. */
export async function runManagedHostFallback({ installation, trace, dshHome }) {
  const gate = isolatedGate()
  if (!gate.qualified) return { status: 'NOT_VERIFIED', reason: gate.reason }
  const { scopeId, unitPath } = unitFactsFor(installation)
  const scopeDir = join(dshHome, 'run', 'dsh-pi-tui', scopeId)
  assert(!existsSync(unitPath), 'the basic-daemon case must begin with no installed unit')
  const screen = new PublicDshScreen(installation, 'daemon')
  try {
    await waitForCounts(dshHome, counts => counts.host >= 1 && counts.client >= 1, 'one independent Host + one Client', 90_000)
    await screen.waitForAny(['type a message', '╭'], 'the independent Client', 120_000)
    const hostLog = join(scopeDir, 'host.log')
    assert(existsSync(hostLog), 'the independent Host did not write its host.log')
    const hostLogPrivate = (statSync(hostLog).mode & 0o777) === 0o600
    assert(hostLogPrivate, 'the independent host.log must be 0600')
    assert(!existsSync(unitPath), 'the basic daemon must never install a unit')
    const identity = readInstance(dshHome, scopeId)
    assert(identity !== undefined && identity.scopeId === scopeId, 'the independent Host published no scope identity')
    screen.send('/exit\r')
    const exit = await screen.exitWithin(60_000)
    assert(exit.code === 0, `the independent Client /exit did not exit 0: ${JSON.stringify(exit)}`)
    await sleep(500)
    assert(hostPids(dshHome).length >= 1, 'the independent Host died when the Client exited')
    trace('managed-host-basic-daemon-process', { scopeId })
    return { status: 'PASS', scope: 'REAL_BASIC_DAEMON_L6', usesDetachedSpawn: true, hostLogPrivate, hostSurvivesClientExit: true, noUnitCreated: true }
  } finally {
    await screen.dispose()
    stopAndRemoveManagedUnit(installation, trace)
    killIsolatedProcesses(dshHome)
  }
}

/**
 * The manager-error fail-closed: an INSTALLED profile unit + a genuinely broken
 * user manager must make public start/status/install fail closed and never fall
 * back to an independent Host. The operator pre-provisions the unit with the
 * real `daemon install` while the manager is usable, then breaks the bus; the
 * broken bus itself cannot run install, so a missing unit is NOT_VERIFIED rather
 * than a fabricated pass.
 */
export async function runManagedHostManagerError({ installation, trace, dshHome }) {
  const gate = isolatedGate()
  if (!gate.qualified) return { status: 'NOT_VERIFIED', reason: gate.reason }
  if (process.env.SPLIT_PROCESS_MANAGED_HOST_FORCE_MANAGER_ERROR !== '1') {
    return { status: 'NOT_VERIFIED', reason: 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: set SPLIT_PROCESS_MANAGED_HOST_FORCE_MANAGER_ERROR=1 in a genuinely failing user-bus environment' }
  }
  const { scopeId, unitPath } = unitFactsFor(installation)
  if (!existsSync(unitPath)) {
    return { status: 'NOT_VERIFIED', reason: 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: provision the profile unit with daemon install while the manager is usable, then run this case with a genuinely broken user bus' }
  }
  const content = readFileSync(unitPath, 'utf8')
  const artifactBuild = installedArtifactBuildId(installation)
  const foreign = unitBelongsToRun(content, { scopeId, publishedBuildId: artifactBuild })
  if (foreign !== null) {
    return { status: 'NOT_VERIFIED', reason: `NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: the pre-provisioned unit is not this candidate build (${foreign})` }
  }
  const runtimeDir = existsSync(`/run/user/${String(process.getuid())}`) ? `/run/user/${String(process.getuid())}` : undefined
  const probe = systemctl(['--user', '--no-pager', '--no-ask-password', 'show-environment'], runtimeDir)
  if (probe.status === 0) return { status: 'NOT_VERIFIED', reason: 'NOT_A_BROKEN_MANAGER_ENV: the user manager is reachable; use the systemd case' }
  const screen = new PublicDshScreen(installation, 'daemon')
  try {
    const exit = await screen.exitWithin(90_000)
    assert(exit.code !== 0 && exit.code !== 'timeout', `the managed Client must exit non-zero on a manager error, saw ${JSON.stringify(exit)}`)
    assert(/HOST_MANAGER_(?:ERROR|START_FAILED|UNIT_CONFLICT)/u.test(screen.records.raw), 'the manager error was not reported to the Client')
    assert(hostPids(dshHome).length === 0, 'a manager error must not start a Host (no fallback)')
    const started = runPublicDsh(installation, ['daemon', 'start'])
    assert(started.status !== 0 && /MANAGER_OR_OS_FAILURE|HOST_MANAGER/u.test(`${started.stdout}${started.stderr}`),
      'daemon start must report the manager failure with an installed unit')
    const installed = runPublicDsh(installation, ['daemon', 'install'])
    assert(installed.status !== 0 && /MANAGER_OR_OS_FAILURE|HOST_MANAGER/u.test(`${installed.stdout}${installed.stderr}`),
      'daemon install must fail closed on a broken manager')
    assert(hostPids(dshHome).length === 0, 'no management command may start a fallback Host')
    trace('managed-host-manager-error', { exitCode: exit.code })
    return { status: 'PASS', scope: 'REAL_MANAGER_ERROR_L6', failClosed: true, noFallbackHost: true }
  } finally {
    await screen.dispose()
    // The manager is deliberately broken, so no manager stop/reload is possible.
    // Remove exactly the pre-provisioned unit this case verified above.
    try { unlinkSync(unitPath) } catch { /* already gone */ }
    killIsolatedProcesses(dshHome)
  }
}
