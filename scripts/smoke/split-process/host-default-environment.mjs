/**
 * PR1 Host default environment: one selectable, environment-gated real-process
 * case for the Host startup PATH contract.
 *
 * The case drives the PUBLIC `dsh --profile pi-tui daemon ...` commands against
 * one isolated packed install and a REAL systemd user unit or launchd
 * LaunchAgent. The managed Host's own profile patch carries the scripted
 * provider; the REAL standard-preset `bash` tool (foreground and background)
 * and the official `ctx.subprocess` service run fixed, run-owned probes by
 * bare name. Client-only PATH state is a negative control: it must never leak
 * into the Host.
 *
 * Stages (plan PR1 P1-P7):
 *   P1 detached Host, official bash, augmentation by default;
 *   P2 Direct TUI negative and two Clients with different synthetic env on
 *      the SAME managed Host;
 *   P3 real manager: install without PATH, inject the minimal test service
 *      environment, start, manager PID == authenticated Host PID;
 *   P4 official background job settlement + one official ctx.subprocess spawn;
 *   P5 warm reuse and restart (new instance, unchanged service bytes);
 *   P6 `inherit` cold start: explicit PATH only, no augmentation;
 *   P7 public stop/uninstall and scoped quiescence.
 *
 * The case is environment-gated. A Linux run needs the attested isolated
 * systemd test account; a macOS run needs the attested isolated launchd test
 * account. Without it the case returns `NOT_VERIFIED` with the concrete reason
 * and touches no manager. It never fabricates a PASS.
 *
 * @module split-process/host-default-environment
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import { basename, join } from 'node:path'
import * as xterm from '@xterm/headless'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { alive, saveFile, restoreFile, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForC1WorkEvent, writeC1WorkFixture } from '../../lib/split-smoke-fixtures.mjs'
import { hostSessionEvents } from '../../lib/split-smoke-sessions.mjs'
import { installedArtifactBuildId, managedHostGateReason, unitBelongsToRun } from './managed-host-m6-2b.mjs'
import { waitForComposerMode, waitForComposerText } from './shell-tui-driving.mjs'

const SYSTEMCTL = '/usr/bin/systemctl'
const LAUNCHCTL = '/bin/launchctl'
const PLUTIL = '/usr/bin/plutil'
const ISOLATED_FLAG_ENV = 'SPLIT_PROCESS_MANAGED_HOST_ISOLATED'
const ISOLATED_HOME_ENV = 'SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME'
const ISOLATED_MARKER = '.dsh-pi-tui-managed-host-isolated'
const LAUNCHD_FLAG_ENV = 'SPLIT_VITEST_LAUNCHD_ISOLATED'
const LAUNCHD_MARKER = '.dsh-pi-tui-launchd-test-isolated'
const LAUNCHD_LABEL_PREFIX = 'com.xmoon.dsh-pi-tui'
const CASE_ID = 'daemon-control.host-default-environment'
const TIMEOUTS = {
  command: 180_000,
  session: 180_000,
  process: 60_000,
  manager: 120_000,
}

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** One bounded poll on a real observable fact. */
async function waitForValue(probe, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined && value !== false) return value
    await sleep(100)
  }
  throw new SplitSmokeAssertionError(`${CASE_ID}: ${label}: the observed fact did not settle before the deadline`)
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}

/** The stable NOT_VERIFIED result for an environment that cannot qualify. */
function notVerified(reason) {
  return { status: 'NOT_VERIFIED', reason }
}

// ── native manager gate ─────────────────────────────────────────────────────

/** The attested isolated macOS launchd environment, implemented at the JS boundary. */
function launchdGate() {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    return { qualified: false, reason: 'NATIVE_MACOS_GUI_ENV_UNAVAILABLE: a non-root local user is required' }
  }
  if (process.env[LAUNCHD_FLAG_ENV] !== '1') {
    return { qualified: false, reason: `NATIVE_MACOS_GUI_ENV_UNAVAILABLE: ${LAUNCHD_FLAG_ENV} is not set` }
  }
  const uid = process.getuid()
  let accountHome
  try {
    accountHome = realpathSync(userInfo().homedir)
  } catch {
    return { qualified: false, reason: 'NATIVE_MACOS_GUI_ENV_UNAVAILABLE: the account home is not readable' }
  }
  let console
  try {
    console = lstatSync('/dev/console')
  } catch {
    return { qualified: false, reason: 'NATIVE_MACOS_GUI_ENV_UNAVAILABLE: the console/GUI account is not readable' }
  }
  if (console.uid !== uid) {
    return { qualified: false, reason: 'NATIVE_MACOS_GUI_ENV_UNAVAILABLE: the console GUI account is not this user' }
  }
  const markerPath = join(accountHome, LAUNCHD_MARKER)
  let marker
  try {
    marker = lstatSync(markerPath)
  } catch {
    return { qualified: false, reason: `NATIVE_MACOS_GUI_ENV_UNAVAILABLE: the isolated launchd test marker is absent: ${markerPath}` }
  }
  if (!marker.isFile() || marker.isSymbolicLink() || marker.uid !== uid) {
    return { qualified: false, reason: 'NATIVE_MACOS_GUI_ENV_UNAVAILABLE: the isolated launchd test marker is not a regular user-owned file' }
  }
  const domain = spawnSync(LAUNCHCTL, ['print', `gui/${String(uid)}`], { encoding: 'utf8', timeout: 15_000 })
  if (domain.error !== undefined || domain.status !== 0) {
    return { qualified: false, reason: 'NATIVE_MACOS_GUI_ENV_UNAVAILABLE: the real gui/<uid> launchd domain is not queryable' }
  }
  return { qualified: true, uid, accountHome }
}

/** The attested isolated Linux systemd-user environment. */
function systemdGate() {
  const isolatedHome = process.env[ISOLATED_HOME_ENV]
  const optIn = process.env[ISOLATED_FLAG_ENV]
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  let accountHome
  try {
    accountHome = userInfo().homedir
  } catch {
    accountHome = undefined
  }
  let markerExists = false
  if (isolatedHome !== undefined && isolatedHome !== '' && accountHome !== undefined) {
    try {
      markerExists = existsSync(join(realpathSync(accountHome), ISOLATED_MARKER))
    } catch {
      markerExists = false
    }
  }
  const reason = managedHostGateReason({ isolatedHome, optIn, markerExists, uid, accountHome })
  if (reason !== null) return { qualified: false, reason }
  if (systemctl(['--user', '--no-pager', '--no-ask-password', 'show-environment']).status !== 0) {
    return { qualified: false, reason: 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment did not succeed' }
  }
  return { qualified: true, uid, accountHome }
}

function nativeManagerGate() {
  if (process.platform === 'linux') return systemdGate()
  if (process.platform === 'darwin') return launchdGate()
  return { qualified: false, reason: `UNSUPPORTED_PLATFORM: ${process.platform}` }
}

function runtimeDir() {
  const uid = process.getuid()
  return existsSync(`/run/user/${String(uid)}`) ? `/run/user/${String(uid)}` : undefined
}

function systemctl(args) {
  const env = runtimeDir() === undefined ? process.env : { ...process.env, XDG_RUNTIME_DIR: runtimeDir() }
  return spawnSync(SYSTEMCTL, args, { encoding: 'utf8', timeout: 30_000, env })
}

function runLaunchctl(args) {
  return spawnSync(LAUNCHCTL, args, { encoding: 'utf8', timeout: 30_000 })
}

// ── canonical service identity (the product's own derivations) ─────────────

function profileScopeId(uid, profileDir) {
  return createHash('sha256')
    .update(`dsh-pi-tui/local-scope/1\0${String(uid)}\0${realpathSync(profileDir)}`)
    .digest('hex')
}

function systemdUnitName(profile, scopeId) {
  let slug = ''
  for (const character of profile) slug += /[A-Za-z0-9_.-]/u.test(character) ? character : '_'
  if (slug === '') slug = 'profile'
  if (!/[A-Za-z0-9]/u.test(slug[0])) slug = `p${slug}`
  return `dsh-pi-tui@${slug.slice(0, 32)}-${scopeId.slice(0, 16)}.service`
}

function launchdLabel(scopeId) {
  return `${LAUNCHD_LABEL_PREFIX}.${scopeId.slice(0, 40)}`
}

function serviceFacts(installation) {
  const uid = process.getuid()
  const scopeId = profileScopeId(uid, installation.profileDir)
  if (process.platform === 'linux') {
    const unit = systemdUnitName('pi-tui', scopeId)
    const unitPath = join(realpathSync(userInfo().homedir), '.config', 'systemd', 'user', unit)
    return { kind: 'systemd', uid, scopeId, unit, unitPath, dropInDir: `${unitPath}.d`, dropInPath: `${unitPath}.d/50-pr1-host-environment.conf` }
  }
  const label = launchdLabel(scopeId)
  return { kind: 'launchd', uid, scopeId, label, plistPath: join(realpathSync(userInfo().homedir), 'Library', 'LaunchAgents', `${label}.plist`) }
}

function definitionPathOf(service) {
  return service.kind === 'systemd' ? service.unitPath : service.plistPath
}

function definitionPresent(service) {
  return existsSync(definitionPathOf(service))
}

/** The real manager attribution facts, never readiness. */
function managerFacts(service) {
  if (service.kind === 'systemd') {
    const result = systemctl(['--user', '--no-pager', '--no-ask-password', 'show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'FragmentPath', '-p', 'MainPID', service.unit])
    assert(result.status === 0, `${CASE_ID}: systemctl show failed for ${service.unit}`)
    const props = {}
    for (const line of (result.stdout ?? '').split('\n')) {
      const at = line.indexOf('=')
      if (at > 0) props[line.slice(0, at)] = line.slice(at + 1).trim()
    }
    return { ...props, source: props.FragmentPath, pid: Number(props.MainPID ?? '0') }
  }
  const print = runLaunchctl(['print', `gui/${String(service.uid)}/${service.label}`])
  assert(print.status === 0, `${CASE_ID}: launchctl print failed for ${service.label}: ${String(print.status)}`)
  const source = /^\s*path = (.+)$/mu.exec(print.stdout)?.[1]
  const pid = /^\tpid = (\d+)$/mu.exec(print.stdout)?.[1]
  const state = /^\tstate = (.+)$/mu.exec(print.stdout)?.[1]
  return { source, pid: pid === undefined ? 0 : Number(pid), state }
}

// ── public management commands ─────────────────────────────────────────────

function daemonEnvironment(installation, extraEnv = {}) {
  const env = { ...installation.env, ...extraEnv, NO_COLOR: '1' }
  if (process.platform === 'linux' && runtimeDir() !== undefined) env.XDG_RUNTIME_DIR = runtimeDir()
  return env
}

/** Run ONE public management command without a TTY. */
function runDaemon(installation, args, extraEnv = {}) {
  const [executable, ...prefix] = installation.dshInvocation
  const result = spawnSync(executable, [...prefix, '--profile', 'pi-tui', 'daemon', ...args], {
    cwd: installation.profileDir,
    env: daemonEnvironment(installation, extraEnv),
    encoding: 'utf8',
    timeout: TIMEOUTS.command,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error }
}

/** Parse the last stable key=value status block. */
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

function assertStatus(result, expected, message) {
  assert(result.status === 0, `${CASE_ID}: ${message}: expected exit 0, saw ${String(result.status)}: ${result.stderr.slice(-800)}`)
  const status = statusOf(result.stdout)
  for (const [key, value] of Object.entries(expected)) {
    assert(status[key] === value, `${CASE_ID}: ${message}: expected ${key}=${value}, saw ${String(status[key])}\n${result.stdout}`)
  }
  return status
}

// ── published Host registry ────────────────────────────────────────────────

function scopeDirectories(dshHome) {
  const root = join(dshHome, 'run', 'dsh-pi-tui')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(root, entry.name))
}

function publishedRecords(dshHome) {
  return scopeDirectories(dshHome).flatMap(dir => {
    const path = join(dir, 'instance.json')
    if (!existsSync(path)) return []
    try {
      return [JSON.parse(readFileSync(path, 'utf8'))]
    } catch {
      return []
    }
  })
}

/** Report one public-CLI-created Host identity to the selected lane. */
function recordHostIdentity(context, record) {
  if (typeof context.recordProcessIdentity !== 'function') return
  context.recordProcessIdentity({
    role: 'host',
    pid: record.hostPid,
    instanceId: record.instanceId,
    scopeId: record.scopeId,
    kernelUniqueId: record.schema === 2 ? record.hostKernelIdentity?.uniqueId : record.hostStarttime,
  })
}

/** Read and record the ONE live Host identity a public command produced. */
async function captureHostIdentity(context, label, expectedInstance) {
  const record = await waitForValue(
    () => publishedRecords(context.dshHome).find(record => typeof record.hostPid === 'number' && alive(record.hostPid)
      && (expectedInstance === undefined || record.instanceId.slice(0, 8) === expectedInstance)),
    `${label} authenticated Host record`,
    TIMEOUTS.process,
  )
  recordHostIdentity(context, record)
  trackRunOwnedHost(context, record)
  return record
}

// ── service definition environment injection ───────────────────────────────

function systemdEnvironmentLine(key, value) {
  const escaped = `${key}=${String(value)}`.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
  return `Environment="${escaped}"`
}

function renderSystemdDropIn(environment) {
  return ['[Service]', ...Object.entries(environment).map(([key, value]) => systemdEnvironmentLine(key, value)), ''].join('\n')
}

/** Insert extra keys into the generated plist's EnvironmentVariables dict. */
function injectLaunchdEnvironment(original, environment) {
  const head = '  <key>EnvironmentVariables</key>\n  <dict>\n'
  const tail = '  </dict>\n  <key>X-DshPiTuiOwner</key>'
  const start = original.indexOf(head)
  assert(start >= 0, `${CASE_ID}: the installed plist has no EnvironmentVariables dict`)
  const bodyStart = start + head.length
  const end = original.indexOf(tail, bodyStart)
  assert(end >= 0, `${CASE_ID}: the installed plist has no EnvironmentVariables terminator`)
  const rows = Object.entries(environment)
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>\n`)
    .join('')
  return `${original.slice(0, end)}${rows}${original.slice(end)}`
}

function assertPlistValid(path) {
  const lint = spawnSync(PLUTIL, ['-lint', path], { encoding: 'utf8', timeout: 15_000 })
  assert(lint.status === 0, `${CASE_ID}: plutil -lint rejected the plist: ${lint.stderr?.slice(-500)}`)
  const decoded = spawnSync(PLUTIL, ['-convert', 'json', '-o', '-', path], { encoding: 'utf8', timeout: 15_000 })
  assert(decoded.status === 0, `${CASE_ID}: plutil could not decode the plist`)
  return JSON.parse(decoded.stdout)
}

/** The exact file identity this run recorded: (dev, ino, content hash, mode, uid). */
function fileIdentity(path) {
  const info = lstatSync(path)
  return {
    dev: String(info.dev),
    ino: String(info.ino),
    sha256: sha256File(path),
    mode: info.mode & 0o777,
    uid: info.uid,
    regular: info.isFile(),
    symlink: info.isSymbolicLink(),
  }
}

function sameFileIdentity(left, right) {
  return left !== undefined && right !== undefined
    && left.dev === right.dev && left.ino === right.ino && left.sha256 === right.sha256
}

/** Refuse every mutation unless the current file is still the one this run wrote. */
function assertRunOwnedFile(path, expected, label) {
  let current
  try {
    current = fileIdentity(path)
  } catch {
    throw new SplitSmokeAssertionError(`${CASE_ID}: ${label}: the run-owned file is missing or unreadable; preserving every resource`)
  }
  if (!current.regular || current.symlink || current.uid !== process.getuid() || !sameFileIdentity(expected, current)) {
    throw new SplitSmokeAssertionError(`${CASE_ID}: ${label}: the file identity changed after this run wrote it; preserving every resource`)
  }
}

/** Prove the freshly installed systemd definition is THIS run's unit. */
function assertSystemdDefinitionOwned(installation, service) {
  const content = readFileSync(service.unitPath, 'utf8')
  const reason = unitBelongsToRun(content, {
    scopeId: service.scopeId,
    publishedBuildId: installedArtifactBuildId(installation),
  })
  assert(reason === null, `${CASE_ID}: the installed unit is not this run's definition (${String(reason)}); preserving it`)
  const props = managerFacts(service)
  assert(props.LoadState === 'loaded' && props.FragmentPath !== undefined
    && realpathSync(props.FragmentPath) === realpathSync(service.unitPath),
  `${CASE_ID}: the manager does not load this exact unit file; preserving it`)
}

/** Prove the freshly installed LaunchAgent is THIS run's plist. */
function assertLaunchdDefinitionOwned(service) {
  const decoded = assertPlistValid(service.plistPath)
  assert(decoded.Label === service.label
    && decoded['X-DshPiTuiOwner'] === 'local-host-launchd-v1'
    && decoded['X-DshPiTuiScopeId'] === service.scopeId,
  `${CASE_ID}: the installed plist is not this run's definition; preserving it`)
}

/**
 * Create or verify the ONE run-owned systemd drop-in directory. A pre-existing
 * directory is admitted only when it is empty; this run removes only the exact
 * file it created and the directory only when this run created it and it is
 * empty.
 */
function ensureOwnedDropInDirectory(service, ownership) {
  if (existsSync(service.dropInDir)) {
    const entries = readdirSync(service.dropInDir)
    assert(entries.length === 0 || (entries.length === 1 && entries[0] === basename(service.dropInPath)),
      `${CASE_ID}: the profile drop-in directory already contains foreign files; preserving it`)
    return
  }
  mkdirSync(service.dropInDir, { mode: 0o755 })
  ownership.dropInDirCreated = true
}

/**
 * Apply the minimal test service environment to ONE run-owned definition. The
 * current file identity is re-proven before every write; the exact bytes this
 * run wrote are recorded for the terminal restore.
 */
function writeServiceEnvironment(installation, service, ownership, environment) {
  if (service.kind === 'systemd') {
    assertSystemdDefinitionOwned(installation, service)
    ensureOwnedDropInDirectory(service, ownership)
    if (ownership.dropIn !== undefined) {
      assertRunOwnedFile(service.dropInPath, ownership.dropIn, 'systemd test drop-in')
    }
    writeFileSync(service.dropInPath, renderSystemdDropIn(environment), { mode: 0o600 })
    ownership.dropIn = fileIdentity(service.dropInPath)
    const reload = systemctl(['--user', 'daemon-reload'])
    assert(reload.status === 0, `${CASE_ID}: systemctl --user daemon-reload failed: ${reload.stderr.slice(-500)}`)
    return
  }
  assertRunOwnedFile(service.plistPath, ownership.current, 'installed LaunchAgent plist')
  assertLaunchdDefinitionOwned(service)
  const edited = injectLaunchdEnvironment(ownership.original.bytes.toString('utf8'), environment)
  writeFileSync(service.plistPath, edited, { mode: ownership.original.mode })
  const decoded = assertPlistValid(service.plistPath)
  const anchors = decoded.EnvironmentVariables ?? {}
  assert(typeof anchors.DSH_HOME === 'string' && typeof anchors.SPLIT_PROCESS_DSH_ANCHOR === 'string'
    && anchors.SPLIT_PROCESS_PROFILE === 'pi-tui', `${CASE_ID}: the edited plist lost the official profile anchors`)
  for (const [key, value] of Object.entries(environment)) {
    assert(anchors[key] === value, `${CASE_ID}: the edited plist did not retain ${key}`)
  }
  ownership.current = fileIdentity(service.plistPath)
}

/**
 * Restore ONLY this run's definition to its freshly installed bytes. A changed
 * file is preserved and reported, never overwritten.
 */
function restoreOwnedDefinition(installation, service, ownership) {
  if (service.kind === 'systemd') {
    assertSystemdDefinitionOwned(installation, service)
    if (ownership.dropIn !== undefined) {
      assertRunOwnedFile(service.dropInPath, ownership.dropIn, 'systemd test drop-in')
      unlinkSync(service.dropInPath)
    }
    if (ownership.dropInDirCreated && existsSync(service.dropInDir)) {
      assert(readdirSync(service.dropInDir).length === 0,
        `${CASE_ID}: the run-owned drop-in directory is not empty after removing this run's file; preserving it`)
      rmdirSync(service.dropInDir)
    }
    const reload = systemctl(['--user', 'daemon-reload'])
    assert(reload.status === 0, `${CASE_ID}: cleanup systemctl --user daemon-reload failed`)
    return
  }
  assertRunOwnedFile(service.plistPath, ownership.current, 'edited LaunchAgent plist')
  restoreFile(service.plistPath, ownership.original)
  const restored = fileIdentity(service.plistPath)
  assert(restored.sha256 === ownership.original.sha256 && restored.mode === ownership.original.mode,
    `${CASE_ID}: the restored plist doesn't match the installed bytes; preserving it`)
  ownership.current = restored
}

// ── file fixtures / probes ─────────────────────────────────────────────────

function writeExecutable(path, line) {
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${line}'\n`, { mode: 0o700 })
  chmodSync(path, 0o700)
}

function createProbeFixtures(workDir, hostHome, nonce) {
  const localBin = join(hostHome, '.local', 'bin')
  const miseShims = join(hostHome, '.local', 'share', 'mise', 'shims')
  const cargoBin = join(hostHome, '.cargo', 'bin')
  const pnpmDir = process.platform === 'darwin' ? join(hostHome, 'Library', 'pnpm') : join(hostHome, '.local', 'share', 'pnpm')
  const explicitBin = join(workDir, 'explicit bin')
  const clientOnlyBin = join(workDir, 'client-only bin')
  for (const dir of [localBin, miseShims, cargoBin, pnpmDir, explicitBin, clientOnlyBin]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeExecutable(join(localBin, 'dsh-pr1-user-probe'), `PR1_USER=default:${nonce}`)
  writeExecutable(join(miseShims, 'dsh-pr1-mise-probe'), `PR1_MISE=${nonce}`)
  writeExecutable(join(cargoBin, 'dsh-pr1-cargo-probe'), `PR1_CARGO=${nonce}`)
  writeExecutable(join(pnpmDir, 'dsh-pr1-pnpm-probe'), `PR1_PNPM=${nonce}`)
  writeExecutable(join(localBin, 'dsh-pr1-shadow-probe'), `PR1_SHADOW=DEFAULT_SHADOWED:${nonce}`)
  writeExecutable(join(explicitBin, 'dsh-pr1-shadow-probe'), `PR1_SHADOW=EXPLICIT_FIRST:${nonce}`)
  writeExecutable(join(clientOnlyBin, 'dsh-pr1-client-only-probe'), `PR1_CLIENT_ONLY=${nonce}`)
  return { localBin, miseShims, cargoBin, pnpmDir, explicitBin, clientOnlyBin }
}

/** Merge the run-owned work fixture rows into the installed Profile patch. */
function mountHostWorkFixture(installation, workDir) {
  const fixture = writeC1WorkFixture(installation.profileDir, workDir)
  const profilePatchPath = join(installation.profileDir, 'cordis.patch.yml')
  const existing = existsSync(profilePatchPath) ? parseYaml(readFileSync(profilePatchPath, 'utf8')) ?? [] : []
  const rows = parseYaml(readFileSync(fixture.patchPath, 'utf8'))
  assert(Array.isArray(existing) && Array.isArray(rows), `${CASE_ID}: the Profile patch or work fixture is not an array`)
  writeFileSync(profilePatchPath, stringifyYaml([...existing, ...rows]), { mode: 0o600 })
  return fixture
}

// ── sessions ───────────────────────────────────────────────────────────────

function sessionIds(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return []
  const ids = []
  for (const scope of readdirSync(root, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue
    for (const session of readdirSync(join(root, scope.name), { withFileTypes: true })) {
      if (session.isDirectory() && session.name.startsWith('session-')) ids.push(session.name)
    }
  }
  return ids
}

function eventData(event) {
  return event?.data ?? {}
}

function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content.map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('\n')
}

/** A user/session message carries its content at the event root; a tool result nests it under `message`. */
function messageText(event) {
  const data = eventData(event)
  return contentText(data.content ?? data.message?.content)
}

function toolResultText(event) {
  return messageText(event)
}

function toolCallIdOf(event) {
  return String(eventData(event).callId ?? '')
}

function toolResultCallId(event) {
  return String(eventData(event).message?.toolCallId ?? '')
}

/** The Client's own opened Session id from its authoritative surface status. */
async function clientSessionId(client, label) {
  const status = await waitForSurfaceStatus(
    client,
    record => record.sessionOpen === true && typeof record.openSessionId === 'string' && record.openSessionId !== '',
    `${label} opened Session`,
  )
  return status.openSessionId
}

/**
 * One exact authored prompt and the turn/end that settles it, read from the
 * KNOWN Client Session. The prompt must appear exactly once before that
 * settlement; a substring match in another session/turn can never satisfy it.
 */
function exactUserTurn(dshHome, sessionId, prompt) {
  const events = hostSessionEvents(dshHome, sessionId)
  if (events === undefined) return undefined
  const starts = events.flatMap((event, index) => event.type === 'user/message' && messageText(event).includes(prompt) ? [index] : [])
  if (starts.length !== 1) return undefined
  const start = starts[0]
  const end = events.findIndex((event, index) => index > start && event.type === 'turn/end')
  if (end < 0) return undefined
  return { events, start, end }
}

async function waitExactTurn(dshHome, sessionId, prompt, label) {
  return await waitForValue(() => exactUserTurn(dshHome, sessionId, prompt), label, TIMEOUTS.session)
}

/** The ONE committed tool call/result pair for the exact committed call id. */
function exactToolCall(turn, callId) {
  const matches = turn.events
    .map((event, index) => ({ event, index }))
    .filter(({ event, index }) => index > turn.start && index < turn.end && event.type === 'tool/call' && toolCallIdOf(event) === callId)
  assert(matches.length === 1, `${CASE_ID}: expected exactly one tool/call ${callId}, found ${String(matches.length)}`)
  return matches[0]
}

function exactToolResult(turn, callId) {
  const call = exactToolCall(turn, callId)
  const matches = turn.events
    .map((event, index) => ({ event, index }))
    .filter(({ event, index }) => index > call.index && index < turn.end && event.type === 'tool/result' && toolResultCallId(event) === callId)
  assert(matches.length === 1, `${CASE_ID}: expected exactly one tool/result ${callId}, found ${String(matches.length)}`)
  return matches[0].event
}

// ── raw-shell positive/negative control ────────────────────────────────────

/**
 * The exact harmless probe the REAL system shell runs without any Host
 * bootstrap. The control proves the explicit directory is usable and every
 * default/shims directory is NOT discoverable before the Host starts.
 */
const RAW_SHELL_PRECHECK = [
  'for p in dsh-pr1-user-probe dsh-pr1-mise-probe dsh-pr1-cargo-probe dsh-pr1-pnpm-probe dsh-pr1-client-only-probe; do',
  'if command -v "$p" >/dev/null 2>&1; then printf "PR1_RAW_PRESENT=%s\\n" "$p"; else printf "PR1_ABSENT=%s\\n" "$p"; fi;',
  'done;',
  'dsh-pr1-shadow-probe;',
  'printf "PR1_RAW_SHELL=%s\\n" "${DSH_SHELL:-unset}"',
].join(' ')

function runRawShellPrecheck({ env, nonce, label }) {
  const result = spawnSync('/bin/sh', ['-c', RAW_SHELL_PRECHECK], {
    cwd: env.HOME,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert(result.status === 0, `${CASE_ID}: ${label}: the raw-shell precheck exited ${String(result.status)}: ${(result.stderr ?? '').slice(-800)}`)
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert(text.includes(`PR1_SHADOW=EXPLICIT_FIRST:${nonce}`),
    `${CASE_ID}: ${label}: the raw shell could not execute the explicit program: ${text.slice(-1200)}`)
  assert(!text.includes('DEFAULT_SHADOWED'), `${CASE_ID}: ${label}: the raw shell executed the default same-name program`)
  assert(!text.includes('PR1_RAW_PRESENT='), `${CASE_ID}: ${label}: a default/shims program was already discoverable before the Host started: ${text.slice(-1200)}`)
  for (const probe of ['dsh-pr1-user-probe', 'dsh-pr1-mise-probe', 'dsh-pr1-cargo-probe', 'dsh-pr1-pnpm-probe', 'dsh-pr1-client-only-probe']) {
    assert(text.includes(`PR1_ABSENT=${probe}`), `${CASE_ID}: ${label}: the raw shell did not report ${probe} absent`)
  }
  assert(text.includes('PR1_RAW_SHELL=unset'), `${CASE_ID}: ${label}: the raw shell unexpectedly carried the managed DSH shell environment`)
}

// ── probe output assertions ────────────────────────────────────────────────

function assertProbeOutput(text, { nonce, augmented, label }) {
  assert(text.includes(`PR1_SHADOW=EXPLICIT_FIRST:${nonce}`),
    `${CASE_ID}: ${label}: the explicit same-name program did not win: ${text.slice(-1200)}`)
  assert(!text.includes('DEFAULT_SHADOWED'), `${CASE_ID}: ${label}: the default same-name program executed`)
  assert(text.includes('PR1_SHELL=1'), `${CASE_ID}: ${label}: the official DSH managed shell marker is missing: ${text.slice(-1200)}`)
  assert(text.includes('PR1_SECRET=unset'), `${CASE_ID}: ${label}: the sensitive test variable was not scrubbed: ${text.slice(-1200)}`)
  assert(text.includes('PR1_ABSENT=dsh-pr1-client-only-probe'),
    `${CASE_ID}: ${label}: a Client-only program was visible to the Host Shell: ${text.slice(-1200)}`)
  for (const [probe, token] of [
    ['dsh-pr1-user-probe', `PR1_USER=default:${nonce}`],
    ['dsh-pr1-mise-probe', `PR1_MISE=${nonce}`],
    ['dsh-pr1-cargo-probe', `PR1_CARGO=${nonce}`],
    ['dsh-pr1-pnpm-probe', `PR1_PNPM=${nonce}`],
  ]) {
    if (augmented) {
      assert(text.includes(token), `${CASE_ID}: ${label}: ${probe} did not resolve: ${text.slice(-1200)}`)
    } else {
      assert(text.includes(`PR1_ABSENT=${probe}`), `${CASE_ID}: ${label}: ${probe} resolved without augmentation: ${text.slice(-1200)}`)
    }
  }
}

// ── managed Host Client driving ────────────────────────────────────────────

function createManagedClient(context, { cwd, env, label, columns = 110 }) {
  const { SurfaceEntryProcess, entries, base, workDir } = context
  return new SurfaceEntryProcess(entries.client, {
    ...base,
    workDir,
    cwd,
    columns,
    env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: '', ...env },
  })
}

async function submitText(client, text, label) {
  await waitForComposerMode(client, 'prompt', `${label} empty composer`)
  client.send(text)
  await waitForComposerText(client, text, `${label} draft`)
  client.send('\r')
}

/** Select the official danger-full-access preset through the real command path. */
async function selectFullAccess(client, label) {
  await submitText(client, '/yolo', `${label} /yolo`)
  await waitForValue(async () => ((await client.viewport()).join('\n').includes('[yolo]') ? true : undefined),
    `${label} footer shows the applied full-access preset`, 30_000)
  await waitForComposerMode(client, 'prompt', `${label} composer after /yolo`)
}

/**
 * One full Client probe: seed a real Session, choose the official
 * danger-full-access preset, submit the fixed foreground marker and return the
 * settled Session events with the correlated bash tool result.
 */
async function runForegroundProbe(context, client, { prompt, nonce, label }) {
  await client.waitFor(record => record.m4a0 === 'ready', `${label} Client ready`, 180_000)
  await submitText(client, `pr1-seed-${nonce}`, `${label} seed prompt`)
  const sessionId = await clientSessionId(client, label)
  await waitExactTurn(context.dshHome, sessionId, `pr1-seed-${nonce}`, `${label} seed turn settlement`)
  await selectFullAccess(client, label)
  const promptText = `${prompt} ${nonce}`
  await submitText(client, promptText, `${label} probe prompt`)
  const turn = await waitExactTurn(context.dshHome, sessionId, promptText, `${label} probe turn settlement`)
  const result = exactToolResult(turn, `pr1-foreground-${sessionId}`)
  const text = toolResultText(result)
  assert(eventData(result).message?.isError !== true, `${CASE_ID}: ${label}: the bash tool result is an error: ${text.slice(-1200)}`)
  assert(!text.includes('[exit code:'), `${CASE_ID}: ${label}: an earlier probe exited nonzero: ${text.slice(-1200)}`)
  return { sessionId, events: turn.events, result, text }
}

// ── public Direct TUI (negative control) ───────────────────────────────────

/** One real PUBLIC `dsh --profile pi-tui` Direct surface. */
class PublicDirectTui {
  constructor(installation, { cwd, env }) {
    this.platform = process.platform
    this.socket = `dsh-pr1-direct-${randomUUID().slice(0, 8)}`
    const [executable, entry] = installation.dshInvocation
    const effectiveEnv = {
      ...installation.env,
      ...env,
      DSH_PI_TUI_BACKEND: 'direct',
      NO_COLOR: '1',
      COLUMNS: '120',
      LINES: '40',
    }
    delete effectiveEnv.SPLIT_PROCESS_EXTRA_PATCH
    // `tmux new-session -e` does NOT carry PATH into the pane (observed: the
    // pane keeps the tmux server's PATH). A real shell assignment prefix is the
    // explicit, portable way to launch the public CLI with THIS environment.
    const assignments = Object.entries(effectiveEnv)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => `${key}=${shellQuote(value)}`)
      .join(' ')
    const command = `${assignments} ${shellQuote(executable)} ${shellQuote(entry)} --profile pi-tui`
    this.disposed = false
    if (this.platform === 'darwin') {
      const start = spawnSync('tmux', [
        '-L', this.socket, '-f', '/dev/null',
        'new-session', '-d', '-s', 'direct', '-x', '120', '-y', '40', '-c', cwd, command,
      ], { encoding: 'utf8', timeout: 30_000 })
      assert(start.status === 0, `${CASE_ID}: the Direct tmux pane did not start: ${(start.stderr ?? '').slice(-600)}`)
      const panes = this.tmuxSend(['list-panes', '-t', 'direct', '-F', '#{pane_pid}'])
      this.panePid = Number((panes.stdout ?? '').trim())
      assert(Number.isSafeInteger(this.panePid) && this.panePid > 0,
        `${CASE_ID}: the Direct tmux pane published no real pane PID`)
      return
    }
    this.term = new xterm.Terminal({ cols: 120, rows: 40, disableStdin: true, allowProposedApi: true })
    this.child = spawn('script', ['-qefc', command, '/dev/null'], {
      cwd,
      env: effectiveEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', chunk => this.term.write(chunk))
    this.child.stderr.on('data', chunk => this.term.write(chunk))
    this.exit = new Promise(resolveExit => this.child.once('close', (code, signal) => resolveExit({ code, signal })))
  }

  /** The OS process this Direct surface owns; the selected receipt names it. */
  pid() {
    return this.platform === 'darwin' ? this.panePid : this.child?.pid
  }

  tmuxSend(args) {
    const result = spawnSync('tmux', ['-L', this.socket, ...args], { encoding: 'utf8', timeout: 20_000 })
    assert(result.status === 0, `${CASE_ID}: tmux ${args[0]} failed: ${(result.stderr ?? '').slice(-500)}`)
    return result
  }

  async viewport() {
    if (this.platform === 'darwin') {
      return this.tmuxSend(['capture-pane', '-p', '-t', 'direct']).stdout
    }
    await new Promise(resolve => this.term.write('', resolve))
    const buffer = this.term.buffer.active
    const lines = []
    for (let index = 0; index < this.term.rows; index += 1) {
      const line = buffer.getLine(buffer.viewportY + index)
      lines.push(line === undefined ? '' : line.translateToString(true))
    }
    return lines.join('\n')
  }

  /** Type the literal draft text without submitting it. */
  type(text) {
    if (this.platform === 'darwin') {
      this.tmuxSend(['send-keys', '-t', 'direct', '-l', text])
      return
    }
    this.child.stdin.write(text)
  }

  /** Submit the current editor line. */
  enter() {
    if (this.platform === 'darwin') {
      this.tmuxSend(['send-keys', '-t', 'direct', 'Enter'])
      return
    }
    this.child.stdin.write('\r')
  }

  async dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.platform === 'darwin') {
      const kill = spawnSync('tmux', ['-L', this.socket, 'kill-server'], { encoding: 'utf8', timeout: 20_000 })
      const stderr = kill.stderr ?? ''
      assert(kill.status === 0 || /no server running/u.test(stderr),
        `${CASE_ID}: the Direct tmux server could not be killed: ${stderr.slice(-500)}`)
      await waitForValue(() => (this.panePid !== undefined && !alive(this.panePid) ? true : undefined),
        'Direct pane process exit', 20_000)
      const session = spawnSync('tmux', ['-L', this.socket, 'has-session', '-t', 'direct'], { encoding: 'utf8', timeout: 10_000 })
      assert(session.status !== 0, `${CASE_ID}: the Direct tmux session survived its killed server`)
      return
    }
    if (this.child === undefined || this.child.exitCode !== null) return
    const waitExit = async (timeoutMs) => Promise.race([
      this.exit.then(() => true, () => true),
      sleep(timeoutMs).then(() => false),
    ])
    try { process.kill(-this.child.pid, 'SIGTERM') } catch { /* already gone */ }
    if (await waitExit(15_000)) return
    try { process.kill(-this.child.pid, 'SIGKILL') } catch { /* already gone */ }
    assert(await waitExit(10_000), `${CASE_ID}: the Direct PTY process group survived SIGTERM/SIGKILL`)
  }
}

/** Submit one prompt through the real Direct TUI editor and wait for its painting. */
async function directSubmit(tui, text, label) {
  await waitForValue(async () => ((await tui.viewport()).includes('❯') ? true : undefined), `${label} composer painted`, 120_000)
  tui.type(text)
  await waitForValue(async () => ((await tui.viewport()).includes(text) ? true : undefined), `${label} draft painted`, 30_000)
  tui.enter()
}

// ── the case ───────────────────────────────────────────────────────────────

/** Track one authenticated Host with the runner's identity-checked backstop. */
function trackRunOwnedHost(context, record) {
  if (typeof context.trackDetachedPid !== 'function') return
  context.trackDetachedPid(record.hostPid, record.schema === 2 ? record.hostKernelIdentity : record.hostStarttime)
}

/** Stop the public Host and prove every Host THIS CASE started has exited. */
async function stopRunOwnedHosts(context, installation, ownedHosts, label) {
  const stopped = assertStatus(runDaemon(installation, ['stop']), { host: 'stopped' }, label)
  await waitForValue(
    () => (ownedHosts.every(host => !alive(host.pid)) ? true : undefined),
    `${label}: every run-owned Host exited`,
    60_000,
  )
  for (const host of ownedHosts) context.untrackDetachedPid?.(host.pid)
  return stopped
}

/** The ONE Session containing the exact authored prompt; any ambiguity fails. */
async function uniqueSessionForPrompt(dshHome, prompt, label) {
  return await waitForValue(() => {
    const matches = sessionIds(dshHome).filter(sessionId => {
      const events = hostSessionEvents(dshHome, sessionId) ?? []
      return events.some(event => event.type === 'user/message' && messageText(event).includes(prompt))
    })
    return matches.length === 1 ? matches[0] : undefined
  }, `${label} unique Session`, TIMEOUTS.session)
}

export async function runHostDefaultEnvironment(context) {
  const gate = nativeManagerGate()
  if (!gate.qualified) return notVerified(gate.reason)

  const { installation, dshHome, workDir, trace } = context
  const service = serviceFacts(installation)
  const nonce = randomUUID().slice(0, 10)
  const sentinel = `pr1-fake-api-key-${nonce}`
  const hostHome = join(workDir, 'pr1-host-home')
  const clientHomeA = join(workDir, 'pr1-client-home-a')
  const clientHomeB = join(workDir, 'pr1-client-home-b')
  const workspace = join(workDir, 'pr1-workspace')
  const hostWorkRoot = join(workDir, 'pr1-host-work')
  const directWorkRoot = join(workDir, 'pr1-direct-work')
  for (const dir of [hostHome, clientHomeA, clientHomeB, workspace, hostWorkRoot, directWorkRoot]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  const probes = createProbeFixtures(workDir, hostHome, nonce)
  mountHostWorkFixture(installation, workDir)

  // Run-owned admission BEFORE any cleanup authority exists: a pre-existing
  // definition or Host record is never this invocation's resource.
  assert(!definitionPresent(service),
    `${CASE_ID}: refusing to run beside a pre-existing service definition (${definitionPathOf(service)})`)
  assert(publishedRecords(dshHome).length === 0,
    `${CASE_ID}: refusing to run beside a pre-existing published Host record`)

  const clients = []
  const rawEnvironment = { PATH: `${probes.explicitBin}:/usr/bin:/bin`, HOME: hostHome }
  const detachedEnvironment = {
    ...rawEnvironment,
    C1_SCENARIO: 'host-default-environment',
    C1_WORK_ROOT: hostWorkRoot,
    PR1_API_KEY: sentinel,
  }
  // Every tool override is pinned at the RUN-OWNED service boundary, so a
  // manager environment cannot change which candidate this case exercises.
  const managedEnvironment = {
    ...detachedEnvironment,
    XDG_DATA_HOME: join(hostHome, '.local', 'share'),
    MISE_DATA_DIR: join(hostHome, '.local', 'share', 'mise'),
    ASDF_DATA_DIR: join(hostHome, '.asdf'),
    CARGO_HOME: join(hostHome, '.cargo'),
    GOBIN: join(hostHome, 'go', 'bin'),
    VOLTA_HOME: join(hostHome, '.volta'),
    BUN_INSTALL: join(hostHome, '.bun'),
    PNPM_HOME: probes.pnpmDir,
  }
  const ownership = { original: undefined, current: undefined, dropIn: undefined, dropInDirCreated: false }
  const ownedHosts = []
  let detachedStarted = false
  let detachedStopped = false
  let managedStarted = false
  let managedStopped = false
  let directTui
  let failure
  let evidence
  try {
    // ── P1: the detached Host augments the inherited PATH ──────────────────
    runRawShellPrecheck({ env: rawEnvironment, nonce, label: 'P1 before the detached Host' })
    const detached = assertStatus(
      runDaemon(installation, ['start'], detachedEnvironment),
      { host: 'ready', manager: 'process', unit: 'none' },
      'P1 detached daemon start',
    )
    detachedStarted = true
    const detachedRecord = await captureHostIdentity(context, 'P1 detached', detached.instance)
    ownedHosts.push(detachedRecord)
    assert(detachedRecord.instanceId.slice(0, 8) === detached.instance, 'P1: the authenticated instance does not match the status instance')
    const clientA = createManagedClient(context, {
      cwd: workspace,
      env: { HOME: clientHomeA, PATH: '/usr/bin:/bin' },
      label: 'P1 Client A',
    })
    clients.push(clientA)
    const p1 = await runForegroundProbe(context, clientA, { prompt: 'pr1-foreground-probe', nonce: `p1-${nonce}`, label: 'P1 Client A' })
    assertProbeOutput(p1.text, { nonce, augmented: true, label: 'P1 detached Host' })

    // ── P2a: the real Direct process never receives this augmentation ──────
    directTui = new PublicDirectTui(installation, {
      cwd: workspace,
      env: { ...rawEnvironment, C1_SCENARIO: 'host-default-environment', C1_WORK_ROOT: directWorkRoot, PR1_API_KEY: sentinel },
    })
    const directPid = directTui.pid()
    assert(Number.isSafeInteger(directPid), 'P2: the Direct surface published no OS PID')
    context.recordProcessIdentity?.({ role: 'direct-client', pid: directPid })
    try {
      const directSeed = `pr1-seed-p2-direct-${nonce}`
      await directSubmit(directTui, directSeed, 'P2 Direct seed')
      const directSession = await uniqueSessionForPrompt(dshHome, directSeed, 'P2 Direct seed')
      await waitExactTurn(dshHome, directSession, directSeed, 'P2 Direct seed turn settlement')
      await directSubmit(directTui, '/yolo', 'P2 Direct full access')
      await waitForValue(async () => ((await directTui.viewport()).includes('[yolo]') ? true : undefined), 'P2 Direct footer full access', 30_000)
      const directPrompt = `pr1-foreground-probe p2-direct-${nonce}`
      await directSubmit(directTui, directPrompt, 'P2 Direct probe')
      const directTurn = await waitExactTurn(dshHome, directSession, directPrompt, 'P2 Direct probe settlement')
      const directResult = exactToolResult(directTurn, `pr1-foreground-${directSession}`)
      assert(eventData(directResult).message?.isError !== true, 'P2: the Direct bash tool result is an error')
      assertProbeOutput(toolResultText(directResult), { nonce, augmented: false, label: 'P2 Direct Host' })
    } finally {
      await directTui.dispose()
      directTui = undefined
    }

    // ── P2b: two Clients with different synthetic env share ONE Host ───────
    const clientB = createManagedClient(context, {
      cwd: workspace,
      env: { HOME: clientHomeB, PATH: `${probes.clientOnlyBin}:/usr/bin:/bin` },
      label: 'P2 Client B',
    })
    clients.push(clientB)
    const p2 = await runForegroundProbe(context, clientB, { prompt: 'pr1-foreground-probe', nonce: `p2-b-${nonce}`, label: 'P2 Client B' })
    assertProbeOutput(p2.text, { nonce, augmented: true, label: 'P2 managed Host / Client B' })
    const afterClients = assertStatus(runDaemon(installation, ['status'], { HOME: clientHomeA, PATH: '/usr/bin:/bin' }), { host: 'ready', manager: 'process' }, 'P2 same Host after a different Client env')
    assert(afterClients.instance === detached.instance && afterClients.pid === detached.pid,
      'P2: the Client environment changed the Host identity')

    // ── P3: the real manager runs the augmented Host ───────────────────────
    await stopRunOwnedHosts(context, installation, ownedHosts, 'P3 stop the detached Host')
    detachedStopped = true
    const installedResult = runDaemon(installation, ['install'])
    assert(installedResult.status === 0, `P3 daemon install failed: ${installedResult.stderr.slice(-800)}`)
    assert(definitionPresent(service), 'P3 daemon install did not create the owned service definition')
    const afterInstall = assertStatus(runDaemon(installation, ['status']), { host: 'stopped' }, 'P3 status directly after install')
    assert(afterInstall.unit === (service.kind === 'systemd' ? service.unit : service.label),
      `P3: the installed definition is not attributed (unit=${String(afterInstall.unit)})`)
    if (service.kind === 'systemd') {
      assertSystemdDefinitionOwned(installation, service)
      const installedFacts = managerFacts(service)
      assert(installedFacts.ActiveState === 'inactive' && installedFacts.pid === 0,
        `P3: daemon install must leave the unit inactive (ActiveState=${String(installedFacts.ActiveState)}, MainPID=${String(installedFacts.pid)})`)
    } else {
      assertLaunchdDefinitionOwned(service)
      const notLoaded = runLaunchctl(['print', `gui/${String(service.uid)}/${service.label}`])
      assert(notLoaded.status === 113,
        `P3: daemon install must not load or start the LaunchAgent (launchctl print exited ${String(notLoaded.status)})`)
    }
    const generatedDefinition = readFileSync(definitionPathOf(service), 'utf8')
    assert(!generatedDefinition.includes(probes.explicitBin),
      'P3: the generated definition must not gain the test PATH')
    const anchorKeys = service.kind === 'systemd'
      ? ['DSH_HOME=', 'SPLIT_PROCESS_DSH_ANCHOR=', 'SPLIT_PROCESS_PROFILE=']
      : ['<key>DSH_HOME</key>', '<key>SPLIT_PROCESS_DSH_ANCHOR</key>', '<key>SPLIT_PROCESS_PROFILE</key>']
    for (const anchor of anchorKeys) {
      assert(generatedDefinition.includes(anchor), `P3: the generated definition lost the official anchor ${anchor}`)
    }
    ownership.original = { ...saveFile(definitionPathOf(service)), ...fileIdentity(definitionPathOf(service)) }
    ownership.current = fileIdentity(definitionPathOf(service))
    writeServiceEnvironment(installation, service, ownership, managedEnvironment)
    runRawShellPrecheck({ env: managedEnvironment, nonce, label: 'P3 before the managed Host' })
    const managed = runDaemon(installation, ['start'], { HOME: clientHomeA, PATH: '/usr/bin:/bin' })
    const managedStatus = assertStatus(managed, {
      host: 'ready',
      manager: service.kind === 'systemd' ? 'systemd' : 'launchd',
      unit: service.kind === 'systemd' ? service.unit : service.label,
    }, 'P3 managed daemon start')
    managedStarted = true
    const managedRecord = await captureHostIdentity(context, 'P3 managed', managedStatus.instance)
    ownedHosts.push(managedRecord)
    assert(managedRecord.instanceId.slice(0, 8) === managedStatus.instance, 'P3: the authenticated instance does not match status')
    assert(Number(managedStatus.pid) === managedRecord.hostPid, 'P3: the status PID is not the authenticated Host PID')
    const installedManagerFacts = managerFacts(service)
    assert(installedManagerFacts.pid === managedRecord.hostPid,
      `P3: the manager PID ${String(installedManagerFacts.pid)} is not the authenticated Host PID ${String(managedRecord.hostPid)}`)
    assert(installedManagerFacts.source !== undefined && realpathSync(installedManagerFacts.source) === realpathSync(definitionPathOf(service)),
      'P3: the manager source is not the owned service definition')
    const clientC = createManagedClient(context, {
      cwd: workspace,
      env: { HOME: clientHomeB, PATH: '/usr/bin:/bin' },
      label: 'P3 Client',
    })
    clients.push(clientC)
    const p3 = await runForegroundProbe(context, clientC, { prompt: 'pr1-foreground-probe', nonce: `p3-${nonce}`, label: 'P3 managed Host' })
    assertProbeOutput(p3.text, { nonce, augmented: true, label: 'P3 managed Host' })
    assert(!JSON.stringify(p3.events).includes(sentinel), 'P3: the fake sensitive value leaked into the Session events')

    // ── P4: background job settlement + official ctx.subprocess spawn ──────
    const backgroundPrompt = `pr1-background-probe p4-${nonce}`
    await submitText(clientC, backgroundPrompt, 'P4 background probe')
    const backgroundTurn = await waitExactTurn(dshHome, p3.sessionId, backgroundPrompt, 'P4 background turn settlement')
    const backgroundResult = exactToolResult(backgroundTurn, `pr1-background-${p3.sessionId}`)
    const backgroundText = toolResultText(backgroundResult)
    const jobId = /started background job (\S+)/u.exec(backgroundText)?.[1]
    assert(typeof jobId === 'string' && jobId !== '',
      `P4: the background bash result carried no job id: ${backgroundText.slice(-1200)}`)
    const jobEvent = await waitForC1WorkEvent(hostWorkRoot,
      event => event.kind === 'job-event' && event.jobId === jobId && event.event === 'settled'
        && event.status === 'completed' && typeof event.output === 'string' && event.output.includes(`PR1_USER=default:${nonce}`),
      `P4 exact background job ${jobId} settled with its stdout token`, 180_000)
    assert(jobEvent.status === 'completed',
      `P4: the official background job did not complete: ${String(jobEvent.status)}`)
    const subprocessPrompt = `pr1-subprocess-probe p4-${nonce}`
    await submitText(clientC, subprocessPrompt, 'P4 subprocess probe')
    await waitExactTurn(dshHome, p3.sessionId, subprocessPrompt, 'P4 subprocess turn settlement')
    const subprocessEvent = await waitForC1WorkEvent(hostWorkRoot,
      event => event.kind === 'subprocess-probe' && event.sessionId === p3.sessionId && event.exitCode === 0
        && typeof event.stdout === 'string' && event.stdout.includes(`PR1_USER=default:${nonce}`),
      'P4 official ctx.subprocess bare spawn returned the probe token for the exact Session', 180_000)
    assert(subprocessEvent.stderr === '', 'P4: the official ctx.subprocess spawn wrote an unexpected stderr')

    // ── P5: warm reuse, restart and unchanged service bytes ────────────────
    const warm = assertStatus(runDaemon(installation, ['start']), { host: 'ready' }, 'P5 warm start')
    assert(warm.instance === managedStatus.instance && warm.pid === managedStatus.pid, 'P5: a warm start replaced the Host')
    const warmClient = createManagedClient(context, {
      cwd: workspace,
      env: { HOME: clientHomeB, PATH: '/usr/bin:/bin' },
      label: 'P5 warm Client',
    })
    clients.push(warmClient)
    const p5Warm = await runForegroundProbe(context, warmClient, { prompt: 'pr1-foreground-probe', nonce: `p5-warm-${nonce}`, label: 'P5 warm Host' })
    assertProbeOutput(p5Warm.text, { nonce, augmented: true, label: 'P5 warm Host' })
    const beforeRestartDefinition = { sha256: sha256File(definitionPathOf(service)), mode: statSync(definitionPathOf(service)).mode & 0o777 }
    const beforeRestartDropIn = service.kind === 'systemd'
      ? { sha256: sha256File(service.dropInPath), mode: statSync(service.dropInPath).mode & 0o777 }
      : undefined
    const restarted = assertStatus(runDaemon(installation, ['restart'], { HOME: clientHomeA, PATH: '/usr/bin:/bin' }), { host: 'ready' }, 'P5 restart')
    assert(restarted.instance !== managedStatus.instance, 'P5: restart did not create a new Host instance')
    const restartedRecord = await captureHostIdentity(context, 'P5 restarted', restarted.instance)
    ownedHosts.push(restartedRecord)
    assert(restartedRecord.instanceId.slice(0, 8) === restarted.instance, 'P5: the restarted authenticated instance does not match status')
    assert(Number(restarted.pid) === restartedRecord.hostPid, 'P5: the restarted status PID is not the authenticated Host PID')
    assert(sha256File(definitionPathOf(service)) === beforeRestartDefinition.sha256
      && (statSync(definitionPathOf(service)).mode & 0o777) === beforeRestartDefinition.mode,
    'P5: the same-build restart changed the service definition bytes or mode')
    if (beforeRestartDropIn !== undefined) {
      assert(sha256File(service.dropInPath) === beforeRestartDropIn.sha256
        && (statSync(service.dropInPath).mode & 0o777) === beforeRestartDropIn.mode,
      'P5: the same-build restart changed the test drop-in')
    }
    const clientD = createManagedClient(context, {
      cwd: workspace,
      env: { HOME: clientHomeA, PATH: '/usr/bin:/bin' },
      label: 'P5 Client',
    })
    clients.push(clientD)
    const p5 = await runForegroundProbe(context, clientD, { prompt: 'pr1-foreground-probe', nonce: `p5-${nonce}`, label: 'P5 restarted Host' })
    assertProbeOutput(p5.text, { nonce, augmented: true, label: 'P5 restarted Host' })

    // ── P6: inherit cold start leaves the explicit PATH exactly as given ────
    await stopRunOwnedHosts(context, installation, ownedHosts, 'P6 stop the managed Host')
    managedStopped = true
    const inheritEnvironment = { ...managedEnvironment, DSH_PI_TUI_HOST_PATH_MODE: 'inherit' }
    writeServiceEnvironment(installation, service, ownership, inheritEnvironment)
    runRawShellPrecheck({ env: rawEnvironment, nonce, label: 'P6 before the inherit Host' })
    const inherited = assertStatus(runDaemon(installation, ['start'], { HOME: clientHomeA, PATH: '/usr/bin:/bin' }), { host: 'ready', manager: service.kind === 'systemd' ? 'systemd' : 'launchd' }, 'P6 inherit cold start')
    managedStarted = true
    managedStopped = false
    const inheritedRecord = await captureHostIdentity(context, 'P6 inherit', inherited.instance)
    ownedHosts.push(inheritedRecord)
    assert(inheritedRecord.instanceId.slice(0, 8) === inherited.instance, 'P6: the inherited authenticated instance does not match status')
    const clientE = createManagedClient(context, {
      cwd: workspace,
      env: { HOME: clientHomeB, PATH: '/usr/bin:/bin' },
      label: 'P6 Client',
    })
    clients.push(clientE)
    const p6 = await runForegroundProbe(context, clientE, { prompt: 'pr1-foreground-probe', nonce: `p6-${nonce}`, label: 'P6 inherit Host' })
    assertProbeOutput(p6.text, { nonce, augmented: false, label: 'P6 inherit Host' })

    evidence = {
      status: 'PASS',
      scope: service.kind === 'systemd' ? 'PACKED_REAL_SYSTEMD_PROCESS' : 'PACKED_REAL_LAUNCHD_PROCESS',
      nonce,
      rawShellPrecheck: true,
      augmentedBareCommands: true,
      explicitSameNameFirst: true,
      sensitiveValueScrubbed: true,
      clientOnlyPathNotLeaked: true,
      directProcessNotAugmented: true,
      warmReuse: true,
      newInstanceOnRestart: true,
      serviceBytesUnchangedOnRestart: true,
      inheritDisablesAugmentation: true,
      backgroundJobSettled: true,
      officialSubprocessSpawn: true,
      exactSessionTurnCallCorrelation: true,
      instances: [detached.instance, managedStatus.instance, restarted.instance, inherited.instance],
      serviceSha256: ownership.original.sha256,
    }
    trace(`${CASE_ID}-pass`, {
      hostInstances: evidence.instances.length,
      service: service.kind,
      nonce,
    })
  } catch (error) {
    failure = error
  } finally {
    // ── P7: public stop/uninstall, definition restore and scoped quiescence ─
    const cleanupErrors = []
    let hostStopUnconfirmed = false
    for (const client of clients) {
      try { await client.dispose() } catch (error) { cleanupErrors.push(`Client dispose: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (directTui !== undefined) {
      try { await directTui.dispose() } catch (error) { cleanupErrors.push(`Direct dispose: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if ((detachedStarted && !detachedStopped) || (managedStarted && !managedStopped)) {
      try {
        await stopRunOwnedHosts(context, installation, ownedHosts, 'P7 public stop')
      } catch (error) {
        hostStopUnconfirmed = true
        cleanupErrors.push(`public stop did not prove every run-owned Host gone: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (ownership.original === undefined && definitionPresent(service)) {
      cleanupErrors.push('a service definition appeared during this run without a proven run ownership; it was preserved')
    }
    if (ownership.original !== undefined) {
      if (hostStopUnconfirmed) {
        cleanupErrors.push('the owned service definition was preserved because the Host stop was not confirmed')
      } else {
        try {
          assertRunOwnedFile(definitionPathOf(service), ownership.current, 'owned service definition before uninstall')
          restoreOwnedDefinition(installation, service, ownership)
          const uninstalled = runDaemon(installation, ['uninstall'])
          if (uninstalled.status !== 0) throw new Error(`daemon uninstall exited ${String(uninstalled.status)}: ${uninstalled.stderr.slice(-400)}`)
          assert(!definitionPresent(service), 'the owned service definition survived public uninstall')
        } catch (error) {
          cleanupErrors.push(`service cleanup: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    if (cleanupErrors.length > 0) {
      const message = `${CASE_ID}: NOT_QUIESCED: ${cleanupErrors.join('; ')}`
      failure = failure instanceof Error
        ? new SplitSmokeAssertionError(`${failure.message}; ${message}`)
        : new SplitSmokeAssertionError(message)
    }
  }
  if (failure !== undefined) throw failure
  return evidence
}
