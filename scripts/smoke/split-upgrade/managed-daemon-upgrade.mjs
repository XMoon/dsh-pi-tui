/**
 * `managed-daemon.cross-build-upgrade-rollback`: the ONE real packed
 * old -> new -> old systemd user-manager migration scene (M6-2D).
 *
 * Two genuinely built packages of the SAME profile and DSH runtime are installed
 * in turn through the official `dsh plugin --profile ...` command while every
 * Host transition goes through the six EXISTING public `daemon` verbs. The
 * scene proves the user-controlled runbook and the failure boundaries:
 *
 *   OLD installed -> `daemon start` -> real Host identity / unit installBuild
 *   -> official durable Session turn + official credential-store record
 *   -> explicit `daemon stop` (manager-inactive, original PID/starttime gone)
 *   -> NEW installed while the OLD unit file stays untouched
 *   -> `status` reports `other-build`, `start`/`restart` refuse with the
 *      ownership exit class BEFORE any second Host or service start/stop
 *   -> explicit `daemon uninstall` removes only the Profile unit path
 *   -> `daemon start` creates the NEW build unit and a genuinely new,
 *      authenticated Host instance; two real PTY Clients attach to it and the
 *      durable Session + credential record read back through the official
 *      product paths
 *   -> the same sequence in reverse for the rollback (NEW unit refused while
 *      the OLD build is installed, explicit uninstall, OLD Host Ready again).
 *
 * The scene is strictly environment-gated exactly like the M6-2B/M6-2C native
 * cases: it only qualifies itself as a dedicated, attested, non-root test
 * account whose account home IS the isolated home and whose
 * `systemctl --user` channel is genuinely reachable. Anywhere else it returns an
 * honest `NOT_VERIFIED` and never touches the real user manager.
 *
 * @module smoke/split-upgrade/managed-daemon-upgrade
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'

import { installPlugin } from '../../lib/dsh-smoke-harness.mjs'
import { writeSurfaceLlmFixture } from '../../lib/split-smoke-fixtures.mjs'
import {
  findIsolatedProcesses,
  killIsolatedProcesses,
  productionBuildId,
  waitGone,
} from '../../lib/split-smoke-processes.mjs'
import { hostSessionEvents } from '../../lib/split-smoke-sessions.mjs'
import {
  EXPECTED_PACKAGE_NAME,
  assert,
  assertDeepEqual,
  assertEqual,
  assertNotEqual,
  assertProfileClientPeers,
  installedPayloadHash,
  safeIdentity,
  scopeDirOf,
  sessionLogFiles,
  sha256,
  stopHostForCleanup,
} from '../../lib/split-upgrade-support.mjs'
import {
  cleanupOutcomeError,
  managedHostGateReason,
  stopAndRemoveManagedUnit,
} from '../split-process/managed-host-m6-2b.mjs'

const ISOLATED_HOME_ENV = 'SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME'
const ISOLATED_FLAG_ENV = 'SPLIT_PROCESS_MANAGED_HOST_ISOLATED'
const ISOLATED_MARKER = '.dsh-pi-tui-managed-host-isolated'
const SYSTEMCTL = '/usr/bin/systemctl'
const DAEMON_MANAGER = 'systemd'
/** The user-owned unit metadata the product renders for one profile scope. */
const UNIT_OWNER_MARKER = 'local-host-manager-v1'
/** The exact public management verbs this scene drives (logs stays with M6-2C). */
const VERBS = Object.freeze(['status', 'start', 'stop', 'restart', 'uninstall'])
/** The isolated official credential-store record seeded before the upgrade. */
const CREDENTIAL_KEY = 'm6-2d-qualification/upgrade-probe'
const CREDENTIAL_SENTINEL = 'm6-2d-credential-sentinel-20261116'
/** The one prompt of the durable Session created before the upgrade. */
const SESSION_PROMPT = 'm6-2d managed upgrade session probe'
/** The exact seeded official credential record block; every stage must keep it. */
const CREDENTIAL_RECORD_BLOCK = [
  `  ${CREDENTIAL_KEY}:`,
  '    kind: grant',
  '    payload:',
  `      token: ${CREDENTIAL_SENTINEL}`,
].join('\n')
/** The addressable record keys in the official credentials document. */
const CREDENTIAL_RECORD_KEY_PATTERN = /^ {2}([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*):$/gmu

function assertMatch(actual, pattern, message) {
  assert(typeof actual === 'string' && pattern.test(actual), message)
}

async function sleep(ms) {
  return await new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

/**
 * The same attested isolated-account gate every native systemd case uses: an
 * explicit opt-in, the isolated home equal to the ACCOUNT home, a provisioning
 * marker, and a non-root uid. `$HOME` alone is never proof of isolation.
 */
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

function runtimeDir() {
  const uid = process.getuid()
  return existsSync(`/run/user/${String(uid)}`) ? `/run/user/${String(uid)}` : undefined
}

/** One fixed `systemctl --user` invocation against the real user manager. */
function systemctl(args) {
  const dir = runtimeDir()
  return spawnSync(SYSTEMCTL, args, {
    encoding: 'utf8',
    timeout: 15_000,
    env: dir === undefined ? process.env : { ...process.env, XDG_RUNTIME_DIR: dir },
  })
}

function managerAvailable() {
  return systemctl(['--user', '--no-pager', '--no-ask-password', 'show-environment']).status === 0
}

/** Run ONE public management verb for this profile without a TTY. */
function runDaemon(installation, args) {
  const [executable, ...prefix] = installation.dshInvocation
  const dir = runtimeDir()
  const result = spawnSync(executable, [...prefix, '--profile', 'pi-tui', 'daemon', ...args], {
    cwd: installation.profileDir,
    env: {
      ...installation.env,
      ...(dir === undefined ? {} : { XDG_RUNTIME_DIR: dir }),
    },
    encoding: 'utf8',
    timeout: 180_000,
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

/** Parse one stable `key=value` management block (last occurrence wins). */
function statusOf(stdout) {
  const fields = {}
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return fields
}

/** Assert one successful verb's exit class and stable status facts. */
function assertDaemon(result, expected, label) {
  assert(result.status === 0, `${label}: expected exit 0, saw ${String(result.status)}: ${result.stderr.slice(-500)}`)
  const status = statusOf(result.stdout)
  for (const [key, value] of Object.entries(expected)) {
    assertEqual(status[key], value, `${label}: expected ${key}=${value}, saw ${String(status[key])}\n${result.stdout}`)
  }
  return status
}

function assertRefused(result, label) {
  assertEqual(result.status, 3, `${label}: the ownership refusal must use exit 3, saw ${String(result.status)}: ${result.stderr.slice(-500)}`)
  assert(/IDENTITY_OR_OWNERSHIP_REFUSED/u.test(`${result.stdout}${result.stderr}`),
    `${label}: the refusal did not report IDENTITY_OR_OWNERSHIP_REFUSED: ${result.stdout}${result.stderr}`)
}

function realHome() {
  return realpathSync(userInfo().homedir)
}

function unitPathOf(unit) {
  return join(realHome(), '.config', 'systemd', 'user', unit)
}

/** One owned unit file snapshot: bytes, mode and the product metadata it carries. */
function unitSnapshot(path) {
  const bytes = readFileSync(path)
  const text = bytes.toString('utf8')
  return {
    mode: statSync(path).mode & 0o777,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    installBuild: /^X-DshPiTuiInstallBuild=([0-9a-f]{64})$/mu.exec(text)?.[1],
    owner: /^X-DshPiTuiOwner=(.+)$/mu.exec(text)?.[1],
  }
}

/** The manager's own view of one unit, parsed as a property map. */
function showUnit(unit) {
  const result = systemctl(['--user', '--no-pager', '--no-ask-password', 'show', unit,
    '-p', 'LoadState', '-p', 'ActiveState', '-p', 'FragmentPath', '-p', 'MainPID', '-p', 'UnitFileState'])
  assertEqual(result.status, 0, `systemctl --user show ${unit} failed: ${result.stderr}`)
  const props = {}
  for (const line of result.stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) props[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return props
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

async function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(120)
  }
  throw new Error(`managed-daemon-upgrade: ${label} did not settle before the deadline`)
}

/** The authoritative Host identity carried by one `host-authenticated` record. */
function hostIdentity(record) {
  const identity = record?.host
  assert(identity !== undefined, 'the Client reported no authenticated Host identity')
  for (const key of ['scopeId', 'instanceId', 'hostPid', 'hostStarttime', 'buildId']) {
    assert(identity[key] !== undefined && identity[key] !== null, `the authenticated Host identity has no ${key}`)
  }
  return {
    scopeId: identity.scopeId,
    instanceId: identity.instanceId,
    hostPid: identity.hostPid,
    hostStarttime: identity.hostStarttime,
    buildId: identity.buildId,
    dshVersion: identity.dshVersion,
  }
}

function sessionLogPath(dshHome, sessionId) {
  const relativePath = sessionLogFiles(dshHome).find(name => name.includes(sessionId))
  assert(relativePath !== undefined, `the durable Session log for ${sessionId} was not found`)
  return join(dshHome, 'sessions', relativePath)
}

function durableEvents(dshHome, sessionId) {
  return hostSessionEvents(dshHome, sessionId) ?? []
}

async function waitForDurableEvent(dshHome, sessionId, predicate, label, timeoutMs = 120_000) {
  let events
  await waitFor(() => {
    events = durableEvents(dshHome, sessionId)
    return events.some(predicate)
  }, label, timeoutMs)
  return events
}

/** The event types appended after the pre-upgrade seed facts (bounded names). */
function appendedEventTypes(events, prefixLength) {
  return events.slice(prefixLength).map(event => String(event.type ?? 'unknown')).slice(0, 24)
}

/** A resume may append session-format markers, never Session history events. */
const HISTORY_EVENT_TYPES = Object.freeze(['user/message', 'assistant/message', 'turn/start', 'turn/end'])

function assertNoHistoryAppended(events, prefixLength, label) {
  for (const type of appendedEventTypes(events, prefixLength)) {
    assert(!HISTORY_EVENT_TYPES.includes(type), `${label}: the readback appended a ${type} event`)
  }
}

/** The exact human-authored prompt count in one durable Session. */
function userPromptCount(events) {
  return events.filter(event => event.type === 'user/message'
    && event.data?.source?.kind === 'user'
    && JSON.stringify(event.data?.content ?? []).includes(SESSION_PROMPT)).length
}

/** The seeded official credential-store document (version 1, records only). */
function writeSeededCredentialsStore(dshHome) {
  const path = join(dshHome, '.credentials.yaml')
  writeFileSync(path, [
    'version: 1',
    'refs: {}',
    'records:',
    `  ${CREDENTIAL_KEY}:`,
    '    kind: grant',
    '    payload:',
    `      token: ${CREDENTIAL_SENTINEL}`,
    '',
  ].join('\n'), { mode: 0o600 })
  return path
}

/** One official credential-store snapshot: bytes, keys and the seeded record block. */
function credentialStoreFacts(path) {
  const text = readFileSync(path, 'utf8')
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    recordKeys: [...text.matchAll(CREDENTIAL_RECORD_KEY_PATTERN)].map(match => match[1]).sort(),
    seededBlockPreserved: text.includes(CREDENTIAL_RECORD_BLOCK),
  }
}

/**
 * The seeded record must survive byte-for-byte. The product owns its OWN
 * records (the local Host writes its connection grant), so the whole document
 * is not expected to stay byte-identical; the user-seeded entry's block and the
 * record key set are the durable facts this scene protects.
 */
function assertCredentialStorePreserved(path, expectedRecordKeys, label) {
  const facts = credentialStoreFacts(path)
  assert(facts.seededBlockPreserved, `${label}: the seeded official credential record block changed`)
  if (expectedRecordKeys !== undefined) {
    assertDeepEqual(facts.recordKeys, expectedRecordKeys, `${label}: the official credential record key set changed`)
  }
  return facts
}

/** Leave the stored-credentials page and prove the main editor regained its seat. */
async function leaveCredentialList(client, label) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = `m6-2d-editor-${String(attempt)}`
    client.send(probe)
    try {
      await client.waitForComposerDraft(probe, 2_000)
      client.send('\x15')
      return
    } catch {
      client.send('\x15')
      client.send('\x1b')
      await sleep(250)
    }
  }
  throw new Error(`managed-daemon-upgrade: ${label}: the main editor never regained the seat`)
}

/**
 * Start one real PTY Client entry against the current installed profile and
 * return it once the Host identity is authenticated. The caller owns disposal.
 */
function startClient(context, installation, base, workRoot, extraEnv = {}) {
  return new context.SurfaceEntryProcess(join(installation.profilePackage, 'dist', 'local-client.mjs'), {
    ...base,
    workDir: workRoot,
    env: { ...base.env, ...extraEnv },
  })
}

async function waitForAuthenticatedClient(client, label, timeoutMs = 240_000) {
  const ready = await client.waitFor(record => record.m4a0 === 'ready', `${label}: ready`, timeoutMs)
  assert(Number.isInteger(ready.pid), `${label}: the ready record names no business PID`)
  const auth = await client.waitFor(record => record.m4a0 === 'host-authenticated', `${label}: authenticated Host`, 120_000)
  return { ready, auth: hostIdentity(auth) }
}

/** Read the stored-credential list through the real `/logout` product surface. */
async function assertCredentialReadback(client, label) {
  client.send('/logout\r')
  await client.waitForScreen('Stored credentials', `${label}: stored credentials list`, 120_000)
  await client.waitForScreen(CREDENTIAL_KEY, `${label}: the exact stored record key`, 60_000)
  await client.waitForScreen('stored record (grant)', `${label}: the exact stored record kind`, 60_000)
  assert(!client.raw.includes(CREDENTIAL_SENTINEL), `${label}: the stored secret leaked into the terminal`)
  assert(!client.stderr.includes(CREDENTIAL_SENTINEL), `${label}: the stored secret leaked into stderr`)
  await leaveCredentialList(client, label)
}

/**
 * Run the complete dual-build migration in its own profile/unit ownership
 * boundary. Returns an evidence fragment on PASS; throws on a real product
 * regression; returns `NOT_VERIFIED` when the real isolated environment is
 * missing.
 */
export async function runManagedDaemonUpgrade(context) {
  const gate = isolatedGate()
  if (!gate.qualified) return { status: 'NOT_VERIFIED', reason: gate.reason }
  if (!managerAvailable()) {
    return { status: 'NOT_VERIFIED', reason: 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: systemctl --user show-environment did not succeed' }
  }
  const {
    workRoot,
    dshHome,
    harnessDir,
    env,
    dsh,
    anchor,
    targetDshVersion,
    oldArtifact,
    newArtifact,
    checkpoint,
    SurfaceEntryProcess,
  } = context
  assert(typeof workRoot === 'string' && typeof dshHome === 'string', 'the native case needs the runner work root and DSH home')
  assert(typeof targetDshVersion === 'string', 'the native case needs the exact DSH runtime pin')
  assert(oldArtifact !== undefined && newArtifact !== undefined, 'the native case needs both packaged artifacts')

  const profileDir = join(dshHome, 'profiles', 'pi-tui')
  const profilePackage = join(profileDir, 'node_modules', EXPECTED_PACKAGE_NAME)
  const scratch = join(workRoot, 'scratch')
  const fragment = { status: 'PASS', scope: 'REAL_SYSTEMD_USER_L6', old: {}, new: {} }
  const clients = []
  const hosts = []
  let installation
  let stubPath
  let unitName
  let failure
  let lastCleanup
  try {
    // ── Install the OLD build through the official Profile command ──────────
    checkpoint('C09/old-profile-install')
    installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)
    installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)
    installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)
    installPlugin(dsh, oldArtifact.path, harnessDir, env, false)
    assertProfileClientPeers(profileDir, targetDshVersion, 'old profile install')
    const oldPackageRoot = realpathSync(profilePackage)
    const oldBuildId = productionBuildId(oldPackageRoot, targetDshVersion)
    const oldPayloadHash = installedPayloadHash(oldPackageRoot)
    assert(existsSync(join(oldPackageRoot, 'dist', 'local-host.mjs')), 'the old installed package has no local Host entry')
    installation = { dshInvocation: dsh, env, profileDir, dshHome, anchor, profilePackage: oldPackageRoot }
    const profileManifestPath = join(profileDir, 'package.json')
    fragment.old = {
      packageVersion: oldArtifact.manifest.version,
      tarballSha256: oldArtifact.sha256,
      buildId: oldBuildId,
      payloadSha256: oldPayloadHash,
    }
    fragment.environment = {
      uid: process.getuid(),
      platform: process.platform,
      systemd: systemctl(['--version']).stdout.split('\n')[0]?.trim(),
    }

    // ── Seed the official durable Session and credential record ─────────────
    // The Session is a REAL product Turn written by the old build's real Host.
    // The Host is started explicitly with the qualification-only offline LLM
    // overlay (a Client cold start would strip that internal test channel), and
    // a real PTY Client attaches to it exactly like the cross-build case does.
    checkpoint('C09/durable-data-seed')
    const surfaceLlm = writeSurfaceLlmFixture(profileDir, workRoot)
    stubPath = surfaceLlm.stubPath
    const base = { cwd: profileDir, env: { ...env }, anchor, profile: 'pi-tui', scratch }
    const seedHost = new context.EntryProcess('host', join(oldPackageRoot, 'dist', 'local-host.mjs'), {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_EXTRA_PATCH: surfaceLlm.patchPath },
    })
    hosts.push(seedHost)
    const seedHostReady = await seedHost.waitFor(record => record.m4a0 === 'ready', 'seed Host ready', 240_000)
    const directHost = safeIdentity(seedHostReady.localHost)
    assertEqual(directHost.buildId, oldBuildId, 'the seed Host published another buildId')
    const seeder = startClient(context, installation, base, workRoot)
    clients.push(seeder)
    const seeded = await waitForAuthenticatedClient(seeder, 'seed Client')
    assertEqual(seeded.auth.instanceId, directHost.instanceId, 'the seed Client authenticated another Host instance')
    // The first REAL prompt is what opens the product Session; wait for that
    // submission before demanding a Session identity.
    seeder.send(`${SESSION_PROMPT}\r`)
    await seeder.waitForScreen(SESSION_PROMPT, 'seed Client painted the submitted prompt', 120_000)
    const seededSession = await seeder.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && typeof record.openSessionId === 'string',
      'seed Client opened its Session',
      120_000,
    )
    const sessionId = seededSession.openSessionId
    await seeder.waitForScreen('stub answer', 'seed Client painted the offline answer', 120_000)
    const seededEvents = await waitForDurableEvent(dshHome, sessionId, event => event.type === 'turn/end', 'seed Turn settled durably')
    assertEqual(userPromptCount(seededEvents), 1, 'the seed Session did not persist exactly one human prompt')
    assert(seededEvents.some(event => event.type === 'assistant/message' && JSON.stringify(event).includes('stub answer')),
      'the seed Session persisted no assistant answer')
    seeder.send('/exit\r')
    const seederExit = await seeder.waitForExit(120_000)
    assertEqual(seederExit.code, 0, `the seed Client /exit was ${JSON.stringify(seederExit)}`)
    await seeder.dispose()
    await stopHostForCleanup(seedHost)
    assert(await waitGone(directHost.hostPid, 30_000), 'the seed Host process did not exit')
    assert(!existsSync(join(scopeDirOf(dshHome, directHost.scopeId), 'instance.json')),
      'the seed Host left its instance.json behind')
    unlinkSync(stubPath)
    stubPath = undefined

    const credentialsPath = writeSeededCredentialsStore(dshHome)
    const seededCredentials = credentialStoreFacts(credentialsPath)
    assert(seededCredentials.seededBlockPreserved, 'the seeded official credential record block is not readable')
    assertDeepEqual(seededCredentials.recordKeys, [CREDENTIAL_KEY], 'the seeded store carries unexpected records')
    const sessionPath = sessionLogPath(dshHome, sessionId)
    const sessionSha256Before = sha256(sessionPath)
    fragment.session = {
      id: sessionId,
      promptPersisted: true,
      turnEndedBeforeUpgrade: true,
      sessionLogSha256BeforeUpgrade: sessionSha256Before,
    }
    fragment.credentials = {
      key: CREDENTIAL_KEY,
      kind: 'grant',
      storeSha256BeforeUpgrade: seededCredentials.sha256,
      recordKeysBeforeUpgrade: seededCredentials.recordKeys,
    }

    // ── OLD build managed Host: real unit, real identity ────────────────────
    checkpoint('C09/old-managed-start')
    const coldStatus = assertDaemon(runDaemon(installation, ['status']),
      { host: 'stopped', manager: 'unmanaged', unit: 'none', 'user-manager': 'available', compatibility: 'none' },
      'cold status before the old managed start')
    assertEqual(coldStatus.pid, undefined, 'a stopped profile published a PID')
    const startedOld = runDaemon(installation, ['start'])
    const oldStatus = assertDaemon(startedOld, {
      'user-manager': 'available',
      manager: DAEMON_MANAGER,
      host: 'ready',
      'unit-state': 'active',
      compatibility: 'compatible',
    }, 'the old managed start')
    unitName = oldStatus.unit
    assertMatch(unitName, /^dsh-pi-tui@pi-tui-[0-9a-f]{16}\.service$/u, `the managed unit name is not the profile unit: ${String(unitName)}`)
    assert(Number.isInteger(Number(oldStatus.pid)) && Number(oldStatus.pid) > 0, 'the old managed start published no Host PID')
    const unitPath = unitPathOf(unitName)
    assert(existsSync(unitPath), 'the old managed start did not install the profile unit')
    const oldUnit = unitSnapshot(unitPath)
    assertEqual(oldUnit.mode, 0o600, 'the generated managed unit must be created 0600')
    assertEqual(oldUnit.owner, UNIT_OWNER_MARKER, 'the managed unit carries no owner marker')
    assertEqual(oldUnit.installBuild, oldBuildId, 'the managed unit installBuild is not the installed old build')
    const oldManager = showUnit(unitName)
    assertEqual(oldManager.LoadState, 'loaded', 'the old managed unit was not loaded by the manager')
    assertEqual(oldManager.ActiveState, 'active', 'the old managed unit is not active')
    assertEqual(Number(oldManager.MainPID), Number(oldStatus.pid), 'the manager MainPID is not the authenticated Host PID')
    assertEqual(realpathSync(oldManager.FragmentPath), realpathSync(unitPath), 'the manager FragmentPath is not the installed profile unit')

    const oldClient = startClient(context, installation, base, workRoot, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
    clients.push(oldClient)
    const oldAttached = await waitForAuthenticatedClient(oldClient, 'old managed Client')
    assertEqual(oldAttached.auth.buildId, oldBuildId, 'the old managed Host published another buildId')
    assert(existsSync(scopeDirOf(dshHome, oldAttached.auth.scopeId)),
      'the authenticated old managed Host published no scope directory')
    assertEqual(Number(oldStatus.pid), oldAttached.auth.hostPid, 'the old managed status PID is not the authenticated Host PID')
    const oldSession = await oldClient.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionId,
      'old managed Client opened the durable Session',
      120_000,
    )
    assertEqual(oldSession.openSessionId, sessionId)
    await oldClient.waitForScreen(SESSION_PROMPT, 'old managed Client painted the durable prompt', 120_000)
    await assertCredentialReadback(oldClient, 'old managed Client')
    oldClient.send('/exit\r')
    const oldClientExit = await oldClient.waitForExit(120_000)
    assertEqual(oldClientExit.code, 0, `the old managed Client /exit was ${JSON.stringify(oldClientExit)}`)
    await oldClient.dispose()
    assertEqual(processCounts(dshHome).host, 1, 'the old managed Host did not survive its Client exit')
    fragment.managedOld = {
      instanceId: oldAttached.auth.instanceId,
      pid: oldAttached.auth.hostPid,
      starttime: oldAttached.auth.hostStarttime,
      buildId: oldAttached.auth.buildId,
      mainPidMatches: true,
      sessionReadback: true,
      credentialReadback: true,
    }

    // ── Explicit old stop: unit inactive, identity and run material gone ────
    checkpoint('C09/old-managed-stop')
    const stoppedOld = runDaemon(installation, ['stop'])
    assertDaemon(stoppedOld, { host: 'stopped', 'unit-state': 'inactive' }, 'the old managed stop')
    assert(await waitGone(oldAttached.auth.hostPid, 60_000), 'the old managed Host did not exit after the explicit stop')
    assertEqual(processCounts(dshHome).host, 0, 'the explicit stop left a Host running')
    assertEqual(showUnit(unitName).ActiveState, 'inactive', 'the old managed unit stayed active after the explicit stop')
    assert(!existsSync(join(scopeDirOf(dshHome, oldAttached.auth.scopeId), 'instance.json')),
      'the old managed Host left its instance.json behind')
    assert(!existsSync(join(scopeDirOf(dshHome, oldAttached.auth.scopeId), 'launch.json')),
      'the old managed Host left its launch material behind')
    const oldReadEvents = durableEvents(dshHome, sessionId)
    assertEqual(userPromptCount(oldReadEvents), 1, 'the old managed readback replayed or duplicated the durable prompt')
    assertEqual(oldReadEvents.slice(0, seededEvents.length).map(event => JSON.stringify(event)).join('\n'),
      seededEvents.map(event => JSON.stringify(event)).join('\n'),
      'the durable Session event prefix changed on the old managed readback')
    assertNoHistoryAppended(oldReadEvents, seededEvents.length, 'the old managed readback')
    const oldSessionAfterStop = sha256(sessionLogPath(dshHome, sessionId))
    const credentialFactsAfterOldRead = assertCredentialStorePreserved(credentialsPath, undefined, 'the old managed readback')
    const credentialKeysAfterOldRead = credentialFactsAfterOldRead.recordKeys
    assert(credentialKeysAfterOldRead.includes(CREDENTIAL_KEY), 'the old managed readback lost the seeded credential record')
    fragment.session.readbackOnOld = {
      changedBytes: oldSessionAfterStop !== sessionSha256Before,
      appendedEvents: appendedEventTypes(oldReadEvents, seededEvents.length),
    }
    fragment.credentials.readbackOnOld = {
      recordKeys: credentialKeysAfterOldRead,
      changedBytes: credentialFactsAfterOldRead.sha256 !== seededCredentials.sha256,
      seededRecordPreserved: true,
    }
    fragment.managedOld.unit = {
      name: unitName,
      path: join('.config', 'systemd', 'user', unitName),
      mode: '0600',
      installBuild: oldUnit.installBuild,
      sha256: oldUnit.sha256,
    }

    // ── Install the NEW build while the OLD unit stays untouched ────────────
    checkpoint('C09/new-profile-install')
    installPlugin(dsh, newArtifact.path, harnessDir, env, false)
    assertProfileClientPeers(profileDir, targetDshVersion, 'upgraded profile install')
    const newPackageRoot = realpathSync(profilePackage)
    const newBuildId = productionBuildId(newPackageRoot, targetDshVersion)
    const newPayloadHash = installedPayloadHash(newPackageRoot)
    assertNotEqual(newBuildId, oldBuildId, 'both packaged builds produced the SAME production buildId')
    assertNotEqual(newPayloadHash, oldPayloadHash, 'both packaged builds installed the same payload bytes')
    installation.profilePackage = newPackageRoot
    fragment.new = {
      packageVersion: newArtifact.manifest.version,
      tarballSha256: newArtifact.sha256,
      buildId: newBuildId,
      payloadSha256: newPayloadHash,
    }
    assertEqual(unitSnapshot(unitPath).sha256, oldUnit.sha256, 'the new profile install rewrote the old managed unit')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the new profile install')
    assertEqual(sha256(sessionLogPath(dshHome, sessionId)), oldSessionAfterStop,
      'the new profile install changed the durable Session bytes')

    // ── Wrong-build refusals: no stop, no start, no rewrite, no second Host ─
    checkpoint('C09/wrong-build-refusal')
    const crossStatus = assertDaemon(runDaemon(installation, ['status']),
      { host: 'stopped', manager: DAEMON_MANAGER, unit: unitName, 'unit-state': 'inactive', compatibility: 'other-build' },
      'status with an other-build unit and no Host')
    assertEqual(crossStatus.pid, undefined, 'an other-build status published a Host PID')
    assertEqual(unitSnapshot(unitPath).sha256, oldUnit.sha256, 'status rewrote the other-build unit')
    const refusedStart = runDaemon(installation, ['start'])
    assertRefused(refusedStart, 'new-build start against the old unit')
    assertEqual(unitSnapshot(unitPath).sha256, oldUnit.sha256, 'the refused new-build start rewrote the old unit')
    assertEqual(unitSnapshot(unitPath).mode, 0o600, 'the refused new-build start changed the old unit mode')
    assertEqual(showUnit(unitName).ActiveState, 'inactive', 'the refused new-build start started the old unit')
    assertEqual(processCounts(dshHome).host, 0, 'the refused new-build start created a Host')
    assert(!existsSync(join(scopeDirOf(dshHome, oldAttached.auth.scopeId), 'instance.json')),
      'the refused new-build start published an instance')
    const refusedRestart = runDaemon(installation, ['restart'])
    assertRefused(refusedRestart, 'new-build restart against the old unit')
    assertEqual(unitSnapshot(unitPath).sha256, oldUnit.sha256, 'the refused new-build restart rewrote the old unit')
    assertEqual(showUnit(unitName).ActiveState, 'inactive', 'the refused new-build restart started the old unit')
    assertEqual(processCounts(dshHome).host, 0, 'the refused new-build restart created a Host')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the wrong-build refusals')
    assertEqual(sha256(sessionLogPath(dshHome, sessionId)), oldSessionAfterStop,
      'the wrong-build refusals changed the durable Session bytes')
    fragment.wrongBuild = {
      compatibilityAtOldUnit: 'other-build',
      startExitCode: refusedStart.status,
      restartExitCode: refusedRestart.status,
      unitBytesUnchanged: true,
      unitModeUnchanged: true,
      noSecondHost: true,
      noServiceStartOrStop: true,
    }

    // ── Explicit uninstall: only the Profile unit path goes away ────────────
    checkpoint('C09/old-unit-uninstall')
    const uninstalled = runDaemon(installation, ['uninstall'])
    assertDaemon(uninstalled, { host: 'stopped', unit: 'none', 'unit-state': 'not-found' }, 'the explicit old-unit uninstall')
    assert(!existsSync(unitPath), 'the explicit uninstall did not remove the Profile unit path')
    assertEqual(showUnit(unitName).LoadState, 'not-found', 'the manager still loads the removed unit')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the explicit old-unit uninstall')
    assertEqual(sha256(sessionLogPath(dshHome, sessionId)), oldSessionAfterStop,
      'the explicit uninstall changed the durable Session bytes')
    assert(readFileSync(profileManifestPath).length > 0, 'the explicit uninstall removed the Profile manifest')

    // ── NEW build managed Host: new unit, new instance, two real Clients ────
    checkpoint('C09/new-managed-start')
    const startedNew = runDaemon(installation, ['start'])
    const newStatus = assertDaemon(startedNew, {
      manager: DAEMON_MANAGER,
      host: 'ready',
      unit: unitName,
      'unit-state': 'active',
      compatibility: 'compatible',
    }, 'the new managed start')
    const newUnit = unitSnapshot(unitPath)
    assertEqual(newUnit.mode, 0o600, 'the new generated managed unit must be created 0600')
    assertEqual(newUnit.installBuild, newBuildId, 'the new managed unit installBuild is not the installed new build')
    assertEqual(Number(showUnit(unitName).MainPID), Number(newStatus.pid), 'the new unit MainPID is not the authenticated Host PID')

    const newClientA = startClient(context, installation, base, workRoot, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
    clients.push(newClientA)
    const newClientB = startClient(context, installation, base, workRoot)
    clients.push(newClientB)
    const newA = await waitForAuthenticatedClient(newClientA, 'new managed Client A')
    const newB = await waitForAuthenticatedClient(newClientB, 'new managed Client B')
    assertEqual(newA.auth.buildId, newBuildId, 'the new managed Host published another buildId')
    assertEqual(newB.auth.buildId, newBuildId, 'new managed Client B authenticated another build')
    assertEqual(newA.auth.instanceId, newB.auth.instanceId, 'the two Clients attached to different Host instances')
    assertEqual(newA.auth.scopeId, oldAttached.auth.scopeId, 'the upgraded Host changed the profile scope')
    assertNotEqual(newB.ready.pid, newA.ready.pid, 'the two Clients shared one OS process')
    assertNotEqual(newA.auth.instanceId, oldAttached.auth.instanceId, 'the new managed Host reused the old instance id')
    assertNotEqual(newA.auth.hostPid, oldAttached.auth.hostPid, 'the new managed Host reused the old PID')
    assertNotEqual(newA.auth.hostStarttime, oldAttached.auth.hostStarttime, 'the new managed Host reused the old starttime')
    const newSession = await newClientA.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionId,
      'new managed Client A reopened the durable Session',
      120_000,
    )
    assertEqual(newSession.openSessionId, sessionId)
    await newClientA.waitForScreen(SESSION_PROMPT, 'new managed Client A painted the durable prompt', 120_000)
    const readbackEvents = durableEvents(dshHome, sessionId)
    assertEqual(userPromptCount(readbackEvents), 1, 'the upgraded Host replayed or duplicated the durable prompt')
    assert(readbackEvents.some(event => event.type === 'turn/end'), 'the upgraded Host lost the durable turn/end')
    assertEqual(readbackEvents.slice(0, seededEvents.length).map(event => JSON.stringify(event)).join('\n'),
      seededEvents.map(event => JSON.stringify(event)).join('\n'),
      'the durable Session event prefix changed across the upgrade')
    await assertCredentialReadback(newClientA, 'new managed Client A')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the new managed readback')
    assertNoHistoryAppended(readbackEvents, seededEvents.length, 'the new managed readback')
    const newSessionSha256 = sha256(sessionLogPath(dshHome, sessionId))
    assertEqual(newSessionSha256, oldSessionAfterStop,
      'the upgraded Host readback changed the durable Session bytes after the first managed resume')
    fragment.session.readbackOnNew = {
      stableAfterFirstResume: true,
      appendedEvents: appendedEventTypes(readbackEvents, seededEvents.length),
    }
    assertEqual(processCounts(dshHome).host, 1, 'the new managed stage did not keep exactly one Host')

    newClientA.send('/exit\r')
    const newAExit = await newClientA.waitForExit(120_000)
    assertEqual(newAExit.code, 0, `new managed Client A /exit was ${JSON.stringify(newAExit)}`)
    newClientB.send('/exit\r')
    const newBExit = await newClientB.waitForExit(120_000)
    assertEqual(newBExit.code, 0, `new managed Client B /exit was ${JSON.stringify(newBExit)}`)
    await newClientA.dispose()
    await newClientB.dispose()
    assertEqual(processCounts(dshHome).host, 1, 'the new managed Host did not survive both Client exits')
    fragment.managedNew = {
      instanceId: newA.auth.instanceId,
      pid: newA.auth.hostPid,
      starttime: newA.auth.hostStarttime,
      buildId: newA.auth.buildId,
      mainPidMatches: true,
      newInstanceVsOld: true,
      twoRealClientsSameInstance: true,
      clientPids: [newA.ready.pid, newB.ready.pid],
      sessionReadback: true,
      credentialReadback: true,
      durableSessionStableAfterFirstResume: true,
    }

    checkpoint('C09/new-managed-stop')
    const stoppedNew = runDaemon(installation, ['stop'])
    assertDaemon(stoppedNew, { host: 'stopped', 'unit-state': 'inactive' }, 'the new managed stop')
    assert(await waitGone(newA.auth.hostPid, 60_000), 'the new managed Host did not exit after the explicit stop')
    assertEqual(processCounts(dshHome).host, 0, 'the new managed stop left a Host running')
    assertEqual(showUnit(unitName).ActiveState, 'inactive', 'the new managed unit stayed active after the explicit stop')

    // ── Rollback: install OLD, refuse the NEW unit, uninstall, start OLD ────
    checkpoint('C09/rollback-install')
    installPlugin(dsh, oldArtifact.path, harnessDir, env, false)
    assertProfileClientPeers(profileDir, targetDshVersion, 'rollback profile install')
    const rollbackPackageRoot = realpathSync(profilePackage)
    const rollbackBuildId = productionBuildId(rollbackPackageRoot, targetDshVersion)
    const rollbackPayloadHash = installedPayloadHash(rollbackPackageRoot)
    assertEqual(rollbackBuildId, oldBuildId, 'the rollback profile did not resolve the old build')
    assertEqual(rollbackPayloadHash, oldPayloadHash, 'the rollback profile installed different old payload bytes')
    installation.profilePackage = rollbackPackageRoot
    assertEqual(unitSnapshot(unitPath).sha256, newUnit.sha256, 'the rollback install rewrote the new managed unit')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the rollback profile install')
    assertEqual(sha256(sessionLogPath(dshHome, sessionId)), newSessionSha256,
      'the rollback install changed the durable Session bytes')
    const rollbackStatus = assertDaemon(runDaemon(installation, ['status']),
      { host: 'stopped', manager: DAEMON_MANAGER, unit: unitName, 'unit-state': 'inactive', compatibility: 'other-build' },
      'status with the new-build unit and the old build installed')
    assertEqual(rollbackStatus.pid, undefined, 'the rollback status published a Host PID')
    const refusedRollbackStart = runDaemon(installation, ['start'])
    assertRefused(refusedRollbackStart, 'rollback start against the new unit')
    const refusedRollbackRestart = runDaemon(installation, ['restart'])
    assertRefused(refusedRollbackRestart, 'rollback restart against the new unit')
    assertEqual(unitSnapshot(unitPath).sha256, newUnit.sha256, 'the rollback refusals rewrote the new unit')
    assertEqual(showUnit(unitName).ActiveState, 'inactive', 'the rollback refusals started the new unit')
    assertEqual(processCounts(dshHome).host, 0, 'the rollback refusals created a Host')
    fragment.wrongBuild.rollbackStartExitCode = refusedRollbackStart.status
    fragment.wrongBuild.rollbackRestartExitCode = refusedRollbackRestart.status

    checkpoint('C09/new-unit-uninstall')
    assertDaemon(runDaemon(installation, ['uninstall']), { host: 'stopped', unit: 'none', 'unit-state': 'not-found' },
      'the explicit new-unit uninstall')
    assert(!existsSync(unitPath), 'the explicit rollback uninstall did not remove the new-build unit')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the rollback uninstall')

    checkpoint('C09/rollback-start')
    const startedRollback = runDaemon(installation, ['start'])
    const rollbackHost = assertDaemon(startedRollback, {
      manager: DAEMON_MANAGER,
      host: 'ready',
      unit: unitName,
      'unit-state': 'active',
      compatibility: 'compatible',
    }, 'the rollback managed start')
    const rollbackUnit = unitSnapshot(unitPath)
    assertEqual(rollbackUnit.installBuild, oldBuildId, 'the rollback unit installBuild is not the old build')
    assertEqual(Number(showUnit(unitName).MainPID), Number(rollbackHost.pid), 'the rollback unit MainPID is not the authenticated Host PID')
    const rollbackClient = startClient(context, installation, base, workRoot, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
    clients.push(rollbackClient)
    const rollbackAttached = await waitForAuthenticatedClient(rollbackClient, 'rollback Client')
    assertEqual(rollbackAttached.auth.buildId, oldBuildId, 'the rollback Host published another buildId')
    assertEqual(rollbackAttached.auth.scopeId, oldAttached.auth.scopeId, 'the rollback Host changed the profile scope')
    assertNotEqual(rollbackAttached.auth.instanceId, newA.auth.instanceId, 'the rollback Host reused the new instance id')
    assertNotEqual(rollbackAttached.auth.hostPid, newA.auth.hostPid, 'the rollback Host reused the new PID')
    assertNotEqual(rollbackAttached.auth.hostStarttime, newA.auth.hostStarttime, 'the rollback Host reused the new starttime')
    const rollbackSession = await rollbackClient.waitFor(
      record => record.m4b2s === 'surface-status' && record.sessionOpen === true && record.openSessionId === sessionId,
      'rollback Client reopened the durable Session',
      120_000,
    )
    assertEqual(rollbackSession.openSessionId, sessionId)
    await rollbackClient.waitForScreen(SESSION_PROMPT, 'rollback Client painted the durable prompt', 120_000)
    await assertCredentialReadback(rollbackClient, 'rollback Client')
    const rollbackEvents = durableEvents(dshHome, sessionId)
    assertEqual(userPromptCount(rollbackEvents), 1, 'the rollback Host replayed or duplicated the durable prompt')
    assertEqual(rollbackEvents.slice(0, seededEvents.length).map(event => JSON.stringify(event)).join('\n'),
      seededEvents.map(event => JSON.stringify(event)).join('\n'),
      'the durable Session event prefix changed across the rollback')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the rollback readback')
    assertNoHistoryAppended(rollbackEvents, seededEvents.length, 'the rollback readback')
    const rollbackSessionSha256 = sha256(sessionLogPath(dshHome, sessionId))
    assertEqual(rollbackSessionSha256, oldSessionAfterStop,
      'the rollback readback changed the durable Session bytes after the first managed resume')
    fragment.session.readbackOnRollback = {
      stableAfterFirstResume: true,
      appendedEvents: appendedEventTypes(rollbackEvents, seededEvents.length),
    }
    rollbackClient.send('/exit\r')
    const rollbackExit = await rollbackClient.waitForExit(120_000)
    assertEqual(rollbackExit.code, 0, `the rollback Client /exit was ${JSON.stringify(rollbackExit)}`)
    await rollbackClient.dispose()
    assertEqual(processCounts(dshHome).host, 1, 'the rollback Host did not survive its Client exit')
    fragment.managedRollback = {
      instanceId: rollbackAttached.auth.instanceId,
      pid: rollbackAttached.auth.hostPid,
      starttime: rollbackAttached.auth.hostStarttime,
      buildId: rollbackAttached.auth.buildId,
      mainPidMatches: true,
      newInstanceVsForward: true,
      sessionReadback: true,
      credentialReadback: true,
    }

    checkpoint('C09/rollback-stop')
    assertDaemon(runDaemon(installation, ['stop']), { host: 'stopped', 'unit-state': 'inactive' }, 'the rollback managed stop')
    assert(await waitGone(rollbackAttached.auth.hostPid, 60_000), 'the rollback Host did not exit after the explicit stop')
    assertEqual(processCounts(dshHome).host, 0, 'the rollback stop left a Host running')

    // The explicit uninstall is also the closing cleanup of the rollback unit;
    // the finally block still runs the product path as a backstop.
    assertDaemon(runDaemon(installation, ['uninstall']), { host: 'stopped', unit: 'none', 'unit-state': 'not-found' },
      'the closing rollback uninstall')
    assert(!existsSync(unitPath), 'the closing uninstall did not remove the rollback unit')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the closing uninstall')
    assertEqual(sha256(sessionLogPath(dshHome, sessionId)), rollbackSessionSha256,
      'the closing uninstall changed the durable Session bytes')
    assertEqual(realpathSync(installation.profilePackage), rollbackPackageRoot, 'the closing uninstall moved the installed profile')
    fragment.cleanup = {
      unitRemoved: true,
      profilePreserved: true,
      sessionPreserved: true,
      credentialsPreserved: true,
      wrongBuildNeverStoppedOrStarted: true,
    }
    fragment.commands = {
      verbs: [...VERBS],
      startOldExit: startedOld.status,
      stopOldExit: stoppedOld.status,
      refusedForwardStartExit: refusedStart.status,
      refusedForwardRestartExit: refusedRestart.status,
      startNewExit: startedNew.status,
      stopNewExit: stoppedNew.status,
      refusedRollbackStartExit: refusedRollbackStart.status,
      refusedRollbackRestartExit: refusedRollbackRestart.status,
      startRollbackExit: startedRollback.status,
    }
  } catch (error) {
    failure = error
  } finally {
    for (const client of clients) {
      try { await client.dispose?.() } catch { /* best effort */ }
    }
    for (const host of hosts) await stopHostForCleanup(host).catch(() => undefined)
    if (stubPath !== undefined) {
      try { unlinkSync(stubPath) } catch { /* best effort */ }
    }
    if (installation !== undefined) {
      // Cleanup is USER-FACING product behavior here too: the explicit
      // `uninstall` removes a verified unit of EITHER known build, and the
      // manager-verified helper below is only the backstop for a scene that
      // failed before its own uninstall step.
      const uninstall = runDaemon(installation, ['uninstall'])
      lastCleanup = { uninstallExit: uninstall.status }
      const cleanup = stopAndRemoveManagedUnit(installation, () => {})
      lastCleanup.unit = cleanup.removed === true ? 'removed' : cleanup.reason
      const outcomeError = cleanupOutcomeError(cleanup)
      if (outcomeError !== undefined) lastCleanup.outcomeError = outcomeError
      if (cleanup.removed === true || cleanup.reason === 'absent') killIsolatedProcesses(installation.dshHome)
      if (unitName !== undefined && existsSync(unitPathOf(unitName))) {
        systemctl(['--user', '--no-pager', '--no-ask-password', 'stop', unitName])
      }
    }
  }
  if (failure !== undefined) throw failure
  if (lastCleanup?.outcomeError !== undefined) throw new Error(lastCleanup.outcomeError)
  return fragment
}
