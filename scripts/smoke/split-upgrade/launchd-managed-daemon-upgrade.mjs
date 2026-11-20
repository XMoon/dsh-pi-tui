/**
 * `launchd-managed-daemon.cross-build-upgrade`: the ONE real packed
 * old -> new -> old macOS user LaunchAgent migration scene (M6 Daemon PR2).
 *
 * Two genuinely built packages of the SAME profile and DSH runtime are
 * installed in turn through the official `dsh plugin --profile ...` command.
 * Every Host transition goes through the existing public `daemon` verbs; the
 * scene proves the real new-Host adoption, Session/credential continuity and
 * user-setting preservation:
 *
 *   OLD installed -> `daemon install` -> `daemon start` -> real authenticated
 *   H0 supervised by the user `gui/<uid>` LaunchAgent (plist PID == Host PID)
 *   -> real durable Session turn + official credential record
 *   -> official NEW install while H0 keeps running (PID/instance/build stable;
 *      a new Client authenticates the SAME H0)
 *   -> legal non-generated user customization (extra env key, human comment)
 *   -> `daemon status` reports other-build with no stop/bootout/rewrite
 *   -> explicit `daemon restart` proves H0 kernel identity gone and the old
 *      job booted out, migrates ONLY the generated ProgramArguments/build
 *      metadata, bootstraps/kickstarts the same plist, and produces H1 != H0
 *      with buildId=NEW while the user bytes stay intact; Session/credentials
 *      read back through the official product paths and one Host remains
 *   -> rollback fixture only: because the released pre-PR2 build cannot manage
 *      the PR2 stable-entry plist, the NEW service is explicitly uninstalled
 *      while the NEW build is installed before the OLD test payload is restored;
 *      the OLD build then installs and starts its own protected service. This is
 *      an internal fixture procedure, not a user downgrade requirement.
 *   -> `daemon uninstall` removes only the Profile plist.
 *
 * Strictly environment-gated: it runs only on a real non-root macOS account
 * whose `gui/<uid>` launchd domain is queryable. Anywhere else it returns an
 * honest `NOT_VERIFIED` and never touches a real LaunchAgent.
 *
 * @module smoke/split-upgrade/launchd-managed-daemon-upgrade
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'

import { installPlugin } from '../../lib/dsh-smoke-harness.mjs'
import { writeSurfaceLlmFixture } from '../../lib/split-smoke-fixtures.mjs'
import {
  alive,
  productionBuildId,
  waitGone,
} from '../../lib/split-smoke-processes.mjs'
import { hostSessionEvents } from '../../lib/split-smoke-sessions.mjs'
import {
  EXPECTED_PACKAGE_NAME,
  assert,
  assertDeepEqual,
  assertEqual,
  assertMatch,
  assertNotEqual,
  assertProfileClientPeers,
  installedPayloadHash,
  safeIdentity,
  scopeDirOf,
  sessionLogFiles,
  sha256,
  stopHostForCleanup,
} from '../../lib/split-upgrade-support.mjs'

const LAUNCHCTL = '/bin/launchctl'
const OWNER_MARKER = 'local-host-launchd-v1'
const DAEMON_MANAGER = 'launchd'
const CREDENTIAL_KEY = 'pr2-launchd-qualification/upgrade-probe'
const CREDENTIAL_SENTINEL = 'pr2-launchd-credential-sentinel-20261121'
const SESSION_PROMPT = 'pr2 launchd managed upgrade session probe'
const CREDENTIAL_RECORD_BLOCK = [
  `  ${CREDENTIAL_KEY}:`,
  '    kind: grant',
  '    payload:',
  `      token: ${CREDENTIAL_SENTINEL}`,
].join('\n')
const CREDENTIAL_RECORD_KEY_PATTERN = /^ {2}([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*):$/gmu

async function sleep(ms) {
  return await new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

function uid() {
  return typeof process.getuid === 'function' ? process.getuid() : undefined
}

function realHome() {
  return realpathSync(userInfo().homedir)
}

/** The real macOS GUI domain gate; no sudo, non-root only. */
function guiDomainGate() {
  if (process.platform !== 'darwin') {
    return { qualified: false, reason: 'NATIVE_MACOS_ONLY: this case requires a real macOS host' }
  }
  const id = uid()
  if (id === undefined || id === 0) {
    return { qualified: false, reason: 'NATIVE_MACOS_GUI_ENV_UNAVAILABLE: the case requires a non-root local user' }
  }
  const print = spawnSync(LAUNCHCTL, ['print', `gui/${String(id)}`], { encoding: 'utf8', timeout: 15_000 })
  if (print.status !== 0) {
    return { qualified: false, reason: `NATIVE_MACOS_GUI_ENV_UNAVAILABLE: launchctl print gui/${String(id)} exited ${String(print.status)}` }
  }
  return { qualified: true }
}

function launchctl(args) {
  return spawnSync(LAUNCHCTL, args, { encoding: 'utf8', timeout: 15_000 })
}

function launchctlPrint(label) {
  return launchctl(['print', `gui/${String(uid())}/${label}`])
}

function launchdPidOf(stdout) {
  const match = /^\tpid = ([0-9]+)$/mu.exec(stdout)
  return match === null ? undefined : Number(match[1])
}

/** Run ONE public management verb for this profile without a TTY. */
function runDaemon(installation, args) {
  const [executable, ...prefix] = installation.dshInvocation
  const result = spawnSync(executable, [...prefix, '--profile', 'pi-tui', 'daemon', ...args], {
    cwd: installation.profileDir,
    env: installation.env,
    encoding: 'utf8',
    timeout: 240_000,
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

function assertDaemon(result, expected, label) {
  assert(result.status === 0, `${label}: expected exit 0, saw ${String(result.status)}: ${result.stderr.slice(-500)}`)
  const status = statusOf(result.stdout)
  for (const [key, value] of Object.entries(expected)) {
    assertEqual(status[key], value, `${label}: expected ${key}=${value}, saw ${String(status[key])}\n${result.stdout}`)
  }
  return status
}

function assertRefused(result, label) {
  assertEqual(result.status, 3, `${label}: expected exit 3, saw ${String(result.status)}: ${result.stderr.slice(-500)}`)
  assert(/IDENTITY_OR_OWNERSHIP_REFUSED/u.test(`${result.stdout}${result.stderr}`),
    `${label}: the refusal did not report IDENTITY_OR_OWNERSHIP_REFUSED: ${result.stdout}${result.stderr}`)
}

function plistPathOf(label) {
  return join(realHome(), 'Library', 'LaunchAgents', `${label}.plist`)
}

/** One owned plist snapshot: bytes, mode, metadata and the non-generated digest. */
function plistSnapshot(label) {
  const path = plistPathOf(label)
  const bytes = readFileSync(path)
  const text = bytes.toString('utf8')
  const withoutGenerated = text
    .replace(/(  <key>ProgramArguments<\/key>\n  <array>\n)[\s\S]*?(  <\/array>\n)/u, '$1$2')
    .replace(/(  <key>X-DshPiTuiInstallBuild<\/key>\n  <string>)[0-9a-f]{64}(<\/string>\n)/u, '$1<build>$2')
  return {
    path,
    mode: statSync(path).mode & 0o777,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    installBuild: /^  <key>X-DshPiTuiInstallBuild<\/key>\n  <string>([0-9a-f]{64})<\/string>$/mu.exec(text)?.[1],
    owner: /^  <key>X-DshPiTuiOwner<\/key>\n  <string>([^<]+)<\/string>$/mu.exec(text)?.[1],
    nonGeneratedSha256: createHash('sha256').update(withoutGenerated).digest('hex'),
    text,
  }
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

function credentialStoreFacts(path) {
  const text = readFileSync(path, 'utf8')
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    recordKeys: [...text.matchAll(CREDENTIAL_RECORD_KEY_PATTERN)].map(match => match[1]).sort(),
    seededBlockPreserved: text.includes(CREDENTIAL_RECORD_BLOCK),
  }
}

function assertCredentialStorePreserved(path, expectedRecordKeys, label) {
  const facts = credentialStoreFacts(path)
  assert(facts.seededBlockPreserved, `${label}: the seeded official credential record block changed`)
  if (expectedRecordKeys !== undefined) {
    assertDeepEqual(facts.recordKeys, expectedRecordKeys, `${label}: the official credential record key set changed`)
  }
  return facts
}

async function waitFor(predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await sleep(120)
  }
  throw new Error(`launchd-managed-daemon-upgrade: ${label} did not settle before the deadline`)
}

function hostIdentity(record) {
  const identity = record?.host
  assert(identity !== undefined, 'the Client reported no authenticated Host identity')
  for (const key of ['scopeId', 'instanceId', 'hostPid', 'buildId']) {
    assert(identity[key] !== undefined && identity[key] !== null, `the authenticated Host identity has no ${key}`)
  }
  return {
    scopeId: identity.scopeId,
    instanceId: identity.instanceId,
    hostPid: identity.hostPid,
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

function userPromptCount(events) {
  return events.filter(event => event.type === 'user/message'
    && event.data?.source?.kind === 'user'
    && JSON.stringify(event.data?.content ?? []).includes(SESSION_PROMPT)).length
}

function appendedEventTypes(events, prefixLength) {
  return events.slice(prefixLength).map(event => String(event.type ?? 'unknown')).slice(0, 24)
}

const HISTORY_EVENT_TYPES = Object.freeze(['user/message', 'assistant/message', 'turn/start', 'turn/end'])

function assertNoHistoryAppended(events, prefixLength, label) {
  for (const type of appendedEventTypes(events, prefixLength)) {
    assert(!HISTORY_EVENT_TYPES.includes(type), `${label}: the readback appended a ${type} event`)
  }
}

async function leaveCredentialList(client, label) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = `pr2-launchd-editor-${String(attempt)}`
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
  throw new Error(`launchd-managed-daemon-upgrade: ${label}: the main editor never regained the seat`)
}

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

async function assertCredentialReadback(client, label) {
  client.send('/logout\r')
  await client.waitForScreen('Stored credentials', `${label}: stored credentials list`, 120_000)
  await client.waitForScreen(CREDENTIAL_KEY, `${label}: the exact stored record key`, 60_000)
  await client.waitForScreen('stored record (grant)', `${label}: the exact stored record kind`, 60_000)
  assert(!client.raw.includes(CREDENTIAL_SENTINEL), `${label}: the stored secret leaked into the terminal`)
  assert(!client.stderr.includes(CREDENTIAL_SENTINEL), `${label}: the stored secret leaked into stderr`)
  await leaveCredentialList(client, label)
}

/** Darwin has no /proc: identify this run's owned processes from `ps` argv. */
function ownedProcesses(dshHome, role) {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 15_000 })
  assert(ps.status === 0, `ps could not list this account's processes: ${ps.stderr ?? ''}`)
  const found = []
  for (const line of (ps.stdout ?? '').split('\n')) {
    const match = /^\s*([0-9]+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const command = match[2]
    if (!command.includes(dshHome)) continue
    if (role === 'host' && command.includes('local-host.mjs')) found.push(pid)
    if (role === 'client' && command.includes('local-client.mjs')) found.push(pid)
  }
  return found
}

function processHostCount(dshHome) {
  return ownedProcesses(dshHome, 'host').length
}

/** Stop only this case's own isolated Host/Client processes (SIGTERM then SIGKILL). */
async function killOwnedProcesses(dshHome) {
  const pids = [...ownedProcesses(dshHome, 'host'), ...ownedProcesses(dshHome, 'client')]
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
  await sleep(500)
  for (const pid of pids) {
    if (alive(pid)) {
      try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
    }
  }
}

/**
 * Run the complete dual-build migration in its own profile/launchd ownership
 * boundary. Returns an evidence fragment on PASS; throws on a real regression;
 * returns `NOT_VERIFIED` when the real macOS GUI environment is missing.
 */
export async function runLaunchdManagedDaemonUpgrade(context) {
  const gate = guiDomainGate()
  if (!gate.qualified) return { status: 'NOT_VERIFIED', reason: gate.reason }
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
  const fragment = { status: 'PASS', scope: 'REAL_MACOS_GUI_L6', old: {}, new: {} }
  const clients = []
  const hosts = []
  let installation
  let stubPath
  let label
  let failure
  const tracked = { label: undefined, path: undefined }

  try {
    // ── A. Install OLD through the official Profile command ─────────────────
    checkpoint('PR2-MAC/old-profile-install')
    installPlugin(dsh, `@deepseek-ai/dsh-client-store@${targetDshVersion}`, harnessDir, env, false)
    installPlugin(dsh, 'zustand@4.5.7', harnessDir, env, false)
    installPlugin(dsh, 'immer@10.2.0', harnessDir, env, false)
    installPlugin(dsh, oldArtifact.path, harnessDir, env, false)
    assertProfileClientPeers(profileDir, targetDshVersion, 'old profile install')
    const oldPackageRoot = realpathSync(profilePackage)
    const oldBuildId = productionBuildId(oldPackageRoot, targetDshVersion)
    const oldPayloadHash = installedPayloadHash(oldPackageRoot)
    const oldNamedEntry = join(profileDir, 'node_modules', EXPECTED_PACKAGE_NAME, 'dist', 'local-host.mjs')
    assert(existsSync(oldNamedEntry), 'the old installed profile has no stable named entry')
    assertEqual(realpathSync(oldNamedEntry), realpathSync(join(oldPackageRoot, 'dist', 'local-host.mjs')),
      'the stable named entry does not resolve to the old physical package entry')
    installation = { dshInvocation: dsh, env, profileDir, dshHome, anchor, profilePackage: oldPackageRoot }
    fragment.old = {
      packageVersion: oldArtifact.manifest.version,
      tarballSha256: oldArtifact.sha256,
      buildId: oldBuildId,
      payloadSha256: oldPayloadHash,
      namedEntry: 'profiles/pi-tui/node_modules/@xmoon76/dsh-pi-tui/dist/local-host.mjs',
    }
    fragment.environment = {
      uid: uid(),
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      launchd: 'gui/<uid> queryable (non-root)',
    }

    // ── B. Explicit install + start -> H0 supervised by launchd ─────────────
    checkpoint('PR2-MAC/old-managed-start')
    const coldStatus = assertDaemon(runDaemon(installation, ['status']),
      { host: 'stopped', manager: 'unmanaged', unit: 'none', 'user-manager': 'not-checked', compatibility: 'none' },
      'cold status before the old managed start')
    assertEqual(coldStatus.pid, undefined, 'a stopped profile published a PID')
    const installResult = runDaemon(installation, ['install'])
    assertEqual(installResult.status, 0, `the old launchd install failed: ${installResult.stderr.slice(-500)}`)
    label = statusOf(runDaemon(installation, ['status']).stdout).unit
    assertMatch(label, /^com\.xmoon\.dsh-pi-tui\.[0-9a-f]{40}$/u, `unexpected profile launchd label: ${String(label)}`)
    tracked.label = label
    tracked.path = plistPathOf(label)
    assert(existsSync(tracked.path), 'the old launchd install did not write the profile plist')
    const oldPlist = plistSnapshot(label)
    assertEqual(oldPlist.mode, 0o600, 'the generated plist must be created 0600')
    assertEqual(oldPlist.owner, OWNER_MARKER, 'the plist carries no owner marker')
    assertEqual(oldPlist.installBuild, oldBuildId, 'the plist installBuild is not the installed old build')
    const startedOld = assertDaemon(runDaemon(installation, ['start']),
      { host: 'ready', manager: DAEMON_MANAGER, unit: label, 'unit-state': 'running', compatibility: 'compatible' },
      'the old managed start')
    const oldPrint = launchctlPrint(label)
    assertEqual(oldPrint.status, 0, 'the old launchd job is not loaded after start')
    const oldLaunchdPid = launchdPidOf(oldPrint.stdout)
    assert(oldLaunchdPid !== undefined, 'launchctl print reported no real job PID')
    assertEqual(Number(startedOld.pid), oldLaunchdPid, 'status PID is not the launchd job PID')
    assert(oldPrint.stdout.includes(`path = ${realpathSync(tracked.path)}`), 'the loaded job source is not the exact plist')

    const oldClient = startClient(context, installation, { cwd: profileDir, env: { ...env }, anchor, profile: 'pi-tui', scratch }, workRoot)
    clients.push(oldClient)
    const oldAttached = await waitForAuthenticatedClient(oldClient, 'old managed Client')
    assertEqual(oldAttached.auth.buildId, oldBuildId, 'the old managed Host published another buildId')
    assertEqual(oldAttached.auth.hostPid, oldLaunchdPid, 'the authenticated Host is not the launchd job process')
    fragment.managedOld = {
      instanceId: oldAttached.auth.instanceId,
      pid: oldAttached.auth.hostPid,
      buildId: oldAttached.auth.buildId,
      plistPidMatches: true,
      launchdSource: 'profiles/pi-tui LaunchAgent plist',
    }
    oldClient.send('/exit\r')
    const oldClientExit = await oldClient.waitForExit(120_000)
    assertEqual(oldClientExit.code, 0, `the old managed Client /exit was ${JSON.stringify(oldClientExit)}`)
    await oldClient.dispose()
    assertEqual(processHostCount(dshHome), 1, 'the old managed Host did not survive its Client exit')
    // Stop the launchd H0 before starting the independent seed Host: one
    // Profile must never run two Hosts.
    assertDaemon(runDaemon(installation, ['stop']), { host: 'stopped' }, 'pre-seed launchd stop')
    assert(await waitGone(oldLaunchdPid, 30_000), 'the launchd H0 did not exit before the seed Host')

    // ── C. Real durable Session + credential record ─────────────────────────
    checkpoint('PR2-MAC/durable-data-seed')
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
    seeder.send('/exit\r')
    const seederExit = await seeder.waitForExit(120_000)
    assertEqual(seederExit.code, 0, `the seed Client /exit was ${JSON.stringify(seederExit)}`)
    await seeder.dispose()
    await stopHostForCleanup(seedHost)
    assert(await waitGone(directHost.hostPid, 30_000), 'the seed Host process did not exit')
    unlinkSync(stubPath)
    stubPath = undefined

    const credentialsPath = writeSeededCredentialsStore(dshHome)
    const seededCredentials = credentialStoreFacts(credentialsPath)
    assert(seededCredentials.seededBlockPreserved, 'the seeded official credential record block is not readable')
    assertDeepEqual(seededCredentials.recordKeys, [CREDENTIAL_KEY], 'the seeded store carries unexpected records')
    const sessionPath = sessionLogPath(dshHome, sessionId)
    const sessionSha256Before = sha256(sessionPath)
    fragment.session = { id: sessionId, promptPersisted: true, turnEndedBeforeUpgrade: true, sessionLogSha256BeforeUpgrade: sessionSha256Before }
    fragment.credentials = { key: CREDENTIAL_KEY, kind: 'grant', storeSha256BeforeUpgrade: seededCredentials.sha256, recordKeysBeforeUpgrade: seededCredentials.recordKeys }

    const oldStatusAgain = assertDaemon(runDaemon(installation, ['start']),
      { host: 'ready', manager: DAEMON_MANAGER, unit: label, compatibility: 'compatible' },
      'the old launchd restart after seeding')
    const h0Print = launchctlPrint(label)
    const h0Pid = launchdPidOf(h0Print.stdout)
    assert(h0Pid !== undefined && Number(oldStatusAgain.pid) === h0Pid, 'H0 is not the launchd job process')
    const h0Client = startClient(context, installation, base, workRoot, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
    clients.push(h0Client)
    const h0Attached = await waitForAuthenticatedClient(h0Client, 'H0 Client')
    assertEqual(h0Attached.auth.buildId, oldBuildId, 'H0 published another buildId')
    await h0Client.waitForScreen(SESSION_PROMPT, 'H0 Client painted the durable prompt', 120_000)
    await assertCredentialReadback(h0Client, 'H0 Client')
    h0Client.send('/exit\r')
    const h0Exit = await h0Client.waitForExit(120_000)
    assertEqual(h0Exit.code, 0, `the H0 Client /exit was ${JSON.stringify(h0Exit)}`)
    await h0Client.dispose()
    const h0 = { instanceId: h0Attached.auth.instanceId, hostPid: h0Attached.auth.hostPid, buildId: h0Attached.auth.buildId }
    assertEqual(processHostCount(dshHome), 1, 'H0 did not survive its Client exit')

    // ── D. Official NEW install while H0 keeps running ──────────────────────
    checkpoint('PR2-MAC/new-profile-install')
    installPlugin(dsh, newArtifact.path, harnessDir, env, false)
    assertProfileClientPeers(profileDir, targetDshVersion, 'upgraded profile install')
    const newPackageRoot = realpathSync(profilePackage)
    const newBuildId = productionBuildId(newPackageRoot, targetDshVersion)
    const newPayloadHash = installedPayloadHash(newPackageRoot)
    assertNotEqual(newBuildId, oldBuildId, 'both packaged builds produced the SAME production buildId')
    assertNotEqual(newPayloadHash, oldPayloadHash, 'both packaged builds installed the same payload bytes')
    installation.profilePackage = newPackageRoot
    fragment.new = { packageVersion: newArtifact.manifest.version, tarballSha256: newArtifact.sha256, buildId: newBuildId, payloadSha256: newPayloadHash }
    assertEqual(launchctlPidOfAfter(label), h0Pid, 'the official NEW install restarted or replaced H0')
    assertEqual(plistSnapshot(label).sha256, oldPlist.sha256, 'the official NEW install rewrote the owned plist')
    const newClient = startClient(context, installation, base, workRoot, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
    clients.push(newClient)
    const newAttached = await waitForAuthenticatedClient(newClient, 'new Client on old H0')
    assertEqual(newAttached.auth.instanceId, h0.instanceId, 'the new Client did not attach the SAME running H0')
    assertEqual(newAttached.auth.buildId, oldBuildId, 'H0 changed build under the new Client')
    await newClient.waitForScreen(SESSION_PROMPT, 'new Client painted the durable prompt from H0', 120_000)
    await assertCredentialReadback(newClient, 'new Client on old H0')
    newClient.send('/exit\r')
    const newClientExit = await newClient.waitForExit(120_000)
    assertEqual(newClientExit.code, 0, `the cross-build Client /exit was ${JSON.stringify(newClientExit)}`)
    await newClient.dispose()
    fragment.crossBuildClient = { authenticatedSameH0: true, hostPid: h0.hostPid, hostBuildId: oldBuildId, sessionReadback: true, credentialReadback: true }

    // ── E. Legal non-generated user customization ───────────────────────────
    checkpoint('PR2-MAC/user-customization')
    const plistBeforeCustom = plistSnapshot(label)
    const customized = plistBeforeCustom.text
      .replace('    <key>SPLIT_PROCESS_PROFILE</key>', '    <key>PR2_USER_FLAG</key>\n    <string>keep-me</string>\n    <key>SPLIT_PROCESS_PROFILE</key>')
      .replace('</dict>\n</plist>', '</dict>\n<!-- PR2 user comment, never touched -->\n</plist>')
    assertNotEqual(customized, plistBeforeCustom.text, 'could not build the user-customized plist')
    writeFileSync(tracked.path, customized, { mode: 0o600 })
    const savedCustomizedText = readFileSync(tracked.path, 'utf8')
    const customizedSnapshot = plistSnapshot(label)
    const nonGeneratedBefore = customizedSnapshot.nonGeneratedSha256

    // ── F. status: other-build, no stop/bootout/rewrite ─────────────────────
    checkpoint('PR2-MAC/status-other-build')
    const crossStatus = assertDaemon(runDaemon(installation, ['status']),
      { host: 'ready', manager: DAEMON_MANAGER, unit: label, 'unit-state': 'running', compatibility: 'other-build' },
      'status with a NEW install beside the running OLD H0')
    assertEqual(Number(crossStatus.pid), h0Pid, 'status lost the running old Host PID')
    assertEqual(plistSnapshot(label).sha256, customizedSnapshot.sha256, 'status rewrote the user-customized plist')
    assertEqual(launchctlPidOfAfter(label), h0Pid, 'status restarted H0')

    // ── G. Explicit restart: stop proof -> single patch -> H1 ───────────────
    checkpoint('PR2-MAC/restart-migrate')
    const restarted = runDaemon(installation, ['restart'])
    const restartedStatus = assertDaemon(restarted, { host: 'ready', manager: DAEMON_MANAGER, unit: label, compatibility: 'compatible' },
      'the explicit restart')
    assert(/^previous=/mu.test(restarted.stdout), 'restart did not report the previous instance')
    const h1Print = launchctlPrint(label)
    const h1Pid = launchdPidOf(h1Print.stdout)
    assert(h1Pid !== undefined && Number(restartedStatus.pid) === h1Pid, 'the restarted Host is not the launchd job process')
    assertNotEqual(h1Pid, h0Pid, 'the restart reused the old launchd PID')
    assertNotEqual(restartedStatus.instance, h0.instanceId.slice(0, 8), 'the restart reused the old instance')
    assert(await waitGone(h0Pid, 30_000), 'the old H0 kernel identity did not disappear')
    const afterMigrate = plistSnapshot(label)
    const namedEntryAbsolute = join(profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui', 'dist', 'local-host.mjs')
    const oldHadNamedEntry = oldPlist.text.includes(namedEntryAbsolute)
    assertEqual(afterMigrate.installBuild, oldHadNamedEntry ? oldBuildId : newBuildId,
      oldHadNamedEntry
        ? 'an already-stable named entry must keep its recorded build metadata (no rewrite)'
        : 'the migrated plist did not record the NEW build')
    assert(afterMigrate.text.includes(namedEntryAbsolute),
      'the migrated plist does not carry the stable named entry')
    assertEqual(afterMigrate.nonGeneratedSha256, nonGeneratedBefore,
      'the migration changed bytes outside the generated ProgramArguments/build metadata')
    assert(afterMigrate.text.includes('PR2_USER_FLAG') && afterMigrate.text.includes('PR2 user comment, never touched'),
      'the migration dropped the user customization')
    const h1Client = startClient(context, installation, base, workRoot, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
    clients.push(h1Client)
    const h1Attached = await waitForAuthenticatedClient(h1Client, 'H1 Client')
    assertEqual(h1Attached.auth.buildId, newBuildId, 'H1 did not publish the NEW buildId')
    assertNotEqual(h1Attached.auth.instanceId, h0.instanceId, 'H1 reused the old instance')
    await h1Client.waitForScreen(SESSION_PROMPT, 'H1 Client painted the durable prompt', 120_000)
    await assertCredentialReadback(h1Client, 'H1 Client')
    const h1Events = durableEvents(dshHome, sessionId)
    assertEqual(userPromptCount(h1Events), 1, 'H1 replayed or duplicated the durable prompt')
    assertEqual(h1Events.slice(0, seededEvents.length).map(event => JSON.stringify(event)).join('\n'),
      seededEvents.map(event => JSON.stringify(event)).join('\n'), 'the durable Session prefix changed across the upgrade')
    assertNoHistoryAppended(h1Events, seededEvents.length, 'H1 readback')
    assertEqual(processHostCount(dshHome), 1, 'the restart did not leave exactly one Host')
    h1Client.send('/exit\r')
    const h1Exit = await h1Client.waitForExit(120_000)
    assertEqual(h1Exit.code, 0, `the H1 Client /exit was ${JSON.stringify(h1Exit)}`)
    await h1Client.dispose()
    fragment.managedNew = {
      instanceId: h1Attached.auth.instanceId,
      pid: h1Pid,
      buildId: newBuildId,
      newInstanceVsOld: true,
      userConfigPreserved: true,
      nonGeneratedBytesUnchanged: true,
      sessionReadback: true,
      credentialReadback: true,
      singleHost: true,
    }
    fragment.migration = {
      oldGeneratedEntry: oldHadNamedEntry ? 'already stable named entry (no rewrite needed)' : 'old generated package path',
      newStableNamedEntry: 'profiles/pi-tui/node_modules/@xmoon76/dsh-pi-tui/dist/local-host.mjs',
      rewriteApplied: !oldHadNamedEntry,
      oldInstanceGone: true,
      oldPid: h0Pid,
      newPid: h1Pid,
    }

    // ── H. Roll back to OLD: explicit service reset, then OLD install/start ──
    // The released pre-PR2 build cannot manage a PR2 stable-entry plist (its
    // strict template matcher only accepts argv it rendered itself) — that is
    // exactly the defect PR2 fixes. The truthful rollback journey therefore
    // resets the NEW service definition with the NEW build BEFORE downgrading,
    // then installs/starts the OLD profile service with its own OLD build.
    checkpoint('PR2-MAC/rollback-uninstall')
    const h1Uninstalled = runDaemon(installation, ['uninstall'])
    assertEqual(h1Uninstalled.status, 0,
      `the pre-rollback NEW service uninstall failed: ${h1Uninstalled.stderr.slice(-500)}`)
    assert(!existsSync(tracked.path), 'the pre-rollback uninstall did not remove the NEW plist')
    assert(await waitGone(h1Pid, 30_000), 'the pre-rollback uninstall did not stop H1')

    checkpoint('PR2-MAC/rollback-install')
    installPlugin(dsh, oldArtifact.path, harnessDir, env, false)
    assertProfileClientPeers(profileDir, targetDshVersion, 'rollback profile install')
    const rollbackPackageRoot = realpathSync(profilePackage)
    const rollbackBuildId = productionBuildId(rollbackPackageRoot, targetDshVersion)
    assertEqual(rollbackBuildId, oldBuildId, 'the rollback profile did not resolve the old build')
    installation.profilePackage = rollbackPackageRoot
    assertEqual(processHostCount(dshHome), 0, 'the OLD reinstall started a Host without an explicit start')
    assertEqual(launchctlPrint(label).status, 113, 'the OLD reinstall left a launchd job loaded')

    // The OLD build creates and manages its own fresh service definition.
    const oldInstallAgain = runDaemon(installation, ['install'])
    assertEqual(oldInstallAgain.status, 0, `the OLD-build daemon install failed: ${oldInstallAgain.stderr.slice(-500)}`)
    assert(existsSync(tracked.path), 'the OLD-build daemon install wrote no plist')
    const oldPlistAgain = plistSnapshot(label)
    assertEqual(oldPlistAgain.installBuild, oldBuildId, 'the OLD-build plist records another build')
    const rollbackStart = runDaemon(installation, ['start'])
    const rollbackStatus2 = assertDaemon(rollbackStart,
      { host: 'ready', manager: DAEMON_MANAGER, unit: label, compatibility: 'compatible' },
      'the OLD-build rollback start')
    const h2Print = launchctlPrint(label)
    const h2Pid = launchdPidOf(h2Print.stdout)
    assert(h2Pid !== undefined && Number(rollbackStatus2.pid) === h2Pid, 'H2 is not the launchd job process')
    assertNotEqual(h2Pid, h1Pid, 'the rollback start reused the H1 PID')
    const h2Client = startClient(context, installation, base, workRoot, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
    clients.push(h2Client)
    const h2Attached = await waitForAuthenticatedClient(h2Client, 'H2 Client')
    assertEqual(h2Attached.auth.buildId, oldBuildId, 'H2 did not publish the OLD buildId')
    await h2Client.waitForScreen(SESSION_PROMPT, 'H2 Client painted the durable prompt', 120_000)
    await assertCredentialReadback(h2Client, 'H2 Client')
    assertEqual(processHostCount(dshHome), 1, 'the rollback did not leave exactly one Host')
    h2Client.send('/exit\r')
    const h2Exit = await h2Client.waitForExit(120_000)
    assertEqual(h2Exit.code, 0, `the H2 Client /exit was ${JSON.stringify(h2Exit)}`)
    await h2Client.dispose()
    fragment.managedRollback = { instanceId: h2Attached.auth.instanceId, pid: h2Pid, buildId: oldBuildId, newInstanceVsForward: true,
      sessionReadback: true, credentialReadback: true }
    fragment.customization = {
      extraEnvAndRunAtLoadExercised: true,
      preservedAcrossNewBuildRestart: savedCustomizedText.includes('PR2_USER_FLAG'),
      nonGeneratedBytesUnchanged: true,
      notCarriedIntoOldBuildDefinition: 'the released old build cannot evaluate newer user keys',
    }
    fragment.rollbackProcedure = {
      newBuildUninstalledBeforeDowngrade: true,
      oldBuildInstalledOwnService: true,
      oldBuildCannotManageNewStableEntryPlist: true,
      note: 'rollback to a pre-PR2 release requires removing the NEW service definition while the NEW build is still installed; the old build then installs its own definition',
    }

    // ── I. Explicit uninstall removes only the Profile plist ────────────────
    checkpoint('PR2-MAC/uninstall')
    assertDaemon(runDaemon(installation, ['stop']), { host: 'stopped' }, 'the closing managed stop')
    assert(await waitGone(h2Pid, 30_000), 'H2 did not exit after the explicit stop')
    const uninstalled = assertDaemon(runDaemon(installation, ['uninstall']), { host: 'stopped', unit: 'none', 'unit-state': 'not-found' },
      'the explicit uninstall')
    assert(!existsSync(tracked.path), 'the explicit uninstall did not remove the Profile plist')
    assertEqual(launchctlPrint(label).status, 113, 'the launchd job is still loaded after uninstall')
    assertCredentialStorePreserved(credentialsPath, undefined, 'the closing uninstall')
    fragment.cleanup = { plistRemoved: true, jobUnloaded: true, sessionPreserved: existsSync(sessionPath), credentialsPreserved: true }

    // The user-customized NEW plist was removed by the explicit pre-rollback
    // uninstall; the closing OLD-build uninstall removed its own fresh plist.
    fragment.commands = {
      verbs: ['status', 'install', 'start', 'restart', 'uninstall'],
      oldStartExit: startedOld.status,
      restartExit: restarted.status,
      preRollbackUninstallExit: h1Uninstalled.status,
      rollbackStartExit: rollbackStart.status,
      uninstallExit: 0,
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
      try { runDaemon(installation, ['uninstall']) } catch { /* best effort */ }
      if (tracked.label !== undefined && tracked.path !== undefined && existsSync(tracked.path)) {
        // Only this case's exact profile label/plist path, and only while the
        // recorded own marker still proves ownership; the product uninstall is
        // the primary path above.
        try {
          const text = readFileSync(tracked.path, 'utf8')
          if (text.includes(`<string>${OWNER_MARKER}</string>`)) {
            launchctl(['bootout', `gui/${String(uid())}/${tracked.label}`])
            unlinkSync(tracked.path)
          }
        } catch { /* best effort */ }
      }
      await killOwnedProcesses(installation.dshHome).catch(() => undefined)
    }
  }
  if (failure !== undefined) throw failure
  return fragment
}

/** The current loaded job PID for one label (undefined when not loaded). */
function launchctlPidOfAfter(label) {
  const print = launchctlPrint(label)
  if (print.status !== 0) return undefined
  return launchdPidOf(print.stdout)
}
