/**
 * The ONE real macOS GUI launchd managed-service upgrade and rollback scene.
 *
 * The Split Supervisor owns the Profile installs, the durable Session facts,
 * the run-owned LaunchAgent reservation/receipt and every cleanup decision.
 * This Worker owns only real tui-test Clients; the launchd platform helper owns
 * the real plist/launchctl IO. The test proves the business chain:
 *
 *   old Profile -> non-managed seed Host + durable Turn/credentials -> official
 *   `daemon install/start` on the real gui/<uid> LaunchAgent -> old Client
 *   readback -> official new Profile install while H0 keeps running -> new-build
 *   Client authenticates the SAME old Host -> fixed user plist customization ->
 *   explicit `daemon restart` adopts the new installed build (no generated
 *   rewrite for an already-stable entry) and preserves every user byte ->
 *   Session/credential readback -> official NEW uninstall, OLD build reinstall
 *   and its own service definition -> H2 readback -> official stop/uninstall.
 *
 * A missing real GUI domain, isolated opt-in or marker is a controlled failure,
 * never a skipped success. The three `native-kill-ready` notes are durable
 * receipt facts consumed by the external crash probe; this test only waits when
 * the exact test-only kill point is selected.
 *
 * @module test/integration/split-upgrade/managed-daemon-launchd.vitest
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { test } from 'vitest'

import { readKernelProcess, sameKernelProcess, type KernelProcessIdentity } from '../../../src/runtime/native-process/identity.ts'
import { profileIdentityDigest } from '../../../src/app/remote-process/local-host-manager.ts'
import {
  createNativeUpgradeScene,
  type ManagedServiceObservation,
  type NativeServiceSnapshot,
  type UpgradeClientHandle,
  type UpgradeScene,
} from '../../support/split-upgrade-fixture.ts'
import {
  hostSessionEvents,
  sessionLogFiles,
  turnEndCount,
  userPromptCount,
  waitForC1Event,
  waitForHostSessionEventAfter,
  waitForPaintedText,
  waitForPidGone,
  waitForSurfaceSession,
} from './reload-observation.ts'

interface SplitUpgradeSupportModule {
  installedPayloadHash(packageRoot: string): string
  productionBuildId(packageRoot: string, dshVersion: string): string
}

interface NativeContractModule {
  LAUNCHD_CUSTOMIZATION: {
    readonly extraEnvironmentKey: 'UPGRADE_USER_FLAG'
    readonly value: 'keep-me'
    readonly comment: 'user-maintained-launch-agent-comment'
  }
  parseManagedDaemonStatus(stdout: string): {
    profile: string
    manager: string
    userManager: string
    host: string
    unit: string
    unitState: string
    compatibility: string
    pid?: number
    instance?: string
  }
  serializeKernelIdentity(identity: KernelProcessIdentity): string
}

interface LaunchdManagerModule {
  preflightLaunchdTestEnvironment(): Promise<{ uid: number; accountHome: string; markerPath: string }>
}

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = realpathSync(join(TEST_DIR, '..', '..', '..'))
const support = (await import(pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'split-upgrade-support.mjs')).href)) as SplitUpgradeSupportModule
const nativeContract = (await import(pathToFileURL(join(REPO_ROOT, 'test', 'support', 'split-upgrade-native-contract.mjs')).href)) as NativeContractModule
const launchdManager = (await import(pathToFileURL(join(REPO_ROOT, 'test', 'support', 'split-upgrade-launchd-manager.mjs')).href)) as LaunchdManagerModule

const SESSION_PROMPT = 'launchd-upgrade-durable-turn'
const CREDENTIAL_KEY = 'launchd-upgrade/credential-proof'
const USER_FLAG_KEY = 'UPGRADE_USER_FLAG'
const USER_FLAG_VALUE = 'keep-me'
const USER_COMMENT = 'user-maintained-launch-agent-comment'
const OWNER_MARKER = 'local-host-launchd-v1'
const LAUNCHD_LABEL_PREFIX = 'com.xmoon.dsh-pi-tui.'

const SEED_CLIENT = 'launchd-seed-client'
const OLD_CLIENT = 'launchd-old-client'
const UPDATED_CLIENT = 'launchd-updated-client'
const RESTARTED_CLIENT = 'launchd-restarted-client'
const ROLLBACK_CLIENT = 'launchd-rollback-client'

const KILL_SWITCH = 'SPLIT_VITEST_NATIVE_KILL_POINT'
const KILL_POINTS = [
  'managed-install-complete',
  'managed-host-client-attached',
  'managed-customization-committed',
] as const

const CREDENTIAL_RECORD_KEY_PATTERN = /^ {2}([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*):$/gmu
const HISTORY_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'turn/start', 'turn/end'])

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(path: string): string {
  return sha256(readFileSync(path))
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

/** The Scene-private Host processes; read-only `ps`, never a signal. */
function sceneHostPids(dshHome: string): number[] {
  const ps = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(ps.error, undefined, `ps could not list processes: ${String(ps.error)}`)
  assert.equal(ps.status, 0, `ps exited ${String(ps.status)}: ${ps.stderr ?? ''}`)
  const pids: number[] = []
  for (const line of (ps.stdout ?? '').split('\n')) {
    const match = /^\s*([0-9]+)\s+(.*)$/u.exec(line)
    if (match === null) continue
    const pid = Number(match[1])
    const command = match[2]
    if (!command.includes(dshHome)) continue
    if (command.includes('local-host.mjs')) pids.push(pid)
  }
  return pids.sort((left, right) => left - right)
}

function assertOneHost(scene: UpgradeScene, label: string): number {
  const pids = sceneHostPids(scene.installation.dshHome)
  assert.equal(pids.length, 1, `${label}: expected exactly one Scene Host, saw ${JSON.stringify(pids)}`)
  return pids[0]!
}

function assertNoHost(scene: UpgradeScene, label: string): void {
  const pids = sceneHostPids(scene.installation.dshHome)
  assert.deepEqual(pids, [], `${label}: a Scene Host process survived: ${JSON.stringify(pids)}`)
}

function launchctlPrint(label: string): { status: number | null; stdout: string; stderr: string } {
  const uid = process.getuid?.()
  assert.ok(typeof uid === 'number', 'the launchd test requires a real local uid')
  const result = spawnSync('/bin/launchctl', ['print', `gui/${String(uid)}/${label}`], {
    encoding: 'utf8',
    timeout: 15_000,
  })
  assert.equal(result.error, undefined, `launchctl print could not run: ${String(result.error)}`)
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function printedPid(stdout: string): number | undefined {
  const match = /^\tpid = ([0-9]+)$/mu.exec(stdout)
  return match === null ? undefined : Number(match[1])
}

function printedSource(stdout: string): string | undefined {
  const match = /^\tpath = (.+)$/mu.exec(stdout)
  return match === null ? undefined : match[1]
}

function assertPrintedJob(label: string, expectedPid: number, plistPath: string): void {
  const printed = launchctlPrint(label)
  assert.equal(printed.status, 0, `launchctl print ${label} exited ${String(printed.status)}: ${printed.stderr.slice(-400)}`)
  assert.equal(printedPid(printed.stdout), expectedPid, `launchctl printed another job PID for ${label}`)
  const source = printedSource(printed.stdout)
  assert.ok(typeof source === 'string', `launchctl printed no source path for ${label}`)
  assert.equal(realpathSync(source), realpathSync(plistPath), `launchctl printed a foreign source path for ${label}`)
}

function assertJobAbsent(label: string): void {
  const printed = launchctlPrint(label)
  assert.equal(printed.status, 113, `the run-owned launchd job ${label} is still loaded or unqueryable: ${String(printed.status)}`)
}

interface ParsedDaemonStatus {
  profile: string
  manager: string
  userManager: string
  host: string
  unit: string
  unitState: string
  compatibility: string
  pid?: number
  instance?: string
}

function assertDaemon(
  result: { exitCode: number; stdout: string; stderr: string },
  expected: Partial<ParsedDaemonStatus>,
  label: string,
): ParsedDaemonStatus {
  assert.equal(result.exitCode, 0, `${label}: daemon exited ${String(result.exitCode)}: ${result.stderr.slice(-500)}`)
  const status = nativeContract.parseManagedDaemonStatus(result.stdout)
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual((status as Record<string, unknown>)[key], value,
      `${label}: expected ${key}=${String(value)}, saw ${JSON.stringify(status)}`)
  }
  return status
}

function decodePlist(content: string): Record<string, any> {
  const decoded = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], {
    input: content,
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 64 * 1024,
  })
  assert.equal(decoded.error, undefined, `plutil could not decode the plist: ${String(decoded.error)}`)
  assert.equal(decoded.status, 0, `plutil rejected the plist: ${decoded.stderr ?? ''}`)
  return JSON.parse(decoded.stdout) as Record<string, any>
}

interface PlistSnapshot {
  path: string
  content: string
  decoded: Record<string, any>
  mode: number
}

function plistSnapshot(path: string): PlistSnapshot {
  const stats = statSync(path)
  const content = readFileSync(path, 'utf8')
  return { path, content, decoded: decodePlist(content), mode: stats.mode & 0o777 }
}

function assertPlistIdentity(
  scene: UpgradeScene,
  snapshot: PlistSnapshot,
  reservation: { unitName: string; scopeId: string; unitPath: string },
): void {
  const decoded = snapshot.decoded
  assert.equal(snapshot.mode, 0o600, 'the managed plist must be 0600')
  assert.equal(decoded.Label, reservation.unitName, 'the managed plist Label is not the reserved label')
  assert.equal(decoded['X-DshPiTuiOwner'], OWNER_MARKER, 'the managed plist carries no product owner marker')
  assert.equal(decoded['X-DshPiTuiScopeId'], reservation.scopeId, 'the managed plist belongs to another scope')
  assert.equal(decoded['X-DshPiTuiProfileIdentity'], profileIdentityDigest(realpathSync(scene.installation.profileDir)),
    'the managed plist profile identity is not this profile')
  assert.match(decoded['X-DshPiTuiInstallBuild'], /^[0-9a-f]{64}$/u, 'the managed plist has no install build identity')
  assert.equal(decoded.RunAtLoad, false, 'the generated LaunchAgent must not run at login')
  assert.equal(decoded.KeepAlive, false, 'the generated LaunchAgent must not auto-restart the Host')
  assert.equal(decoded.Umask, 0o077, 'the generated LaunchAgent umask changed')
  const environment = decoded.EnvironmentVariables
  assert.equal(environment?.DSH_HOME, scene.installation.dshHome, 'the plist DSH_HOME anchor changed')
  assert.equal(environment?.SPLIT_PROCESS_DSH_ANCHOR, scene.installation.anchor, 'the plist DSH anchor changed')
  assert.equal(environment?.SPLIT_PROCESS_PROFILE, 'pi-tui', 'the plist profile anchor changed')
  assert.equal(snapshot.path, reservation.unitPath, 'the plist is not the reserved path')
}

function credentialRecordKeys(text: string): string[] {
  return [...text.matchAll(CREDENTIAL_RECORD_KEY_PATTERN)].map(match => match[1]!).sort()
}

interface SeededCredentialStore {
  path: string
  sentinel: string
  sha256: string
  recordKeys: string[]
}

function seedCredentialStore(scene: UpgradeScene): SeededCredentialStore {
  const path = join(scene.installation.dshHome, '.credentials.yaml')
  const sentinel = `launchd-credential-${randomUUID()}`
  const content = [
    'version: 1',
    'refs: {}',
    'records:',
    `  ${CREDENTIAL_KEY}:`,
    '    kind: grant',
    '    payload:',
    `      token: ${sentinel}`,
    '',
  ].join('\n')
  writeFileSync(path, content, { mode: 0o600 })
  return { path, sentinel, sha256: sha256(content), recordKeys: credentialRecordKeys(content) }
}

function assertCredentialStorePreserved(store: SeededCredentialStore, label: string): void {
  const text = readFileSync(store.path, 'utf8')
  // The product may normalize its store envelope and add its own official
  // Client-connection records; the seeded record block/key must survive.
  const recordKeys = credentialRecordKeys(text)
  for (const key of store.recordKeys) {
    assert.ok(recordKeys.includes(key), `${label}: the seeded credential key ${key} is gone`)
  }
  assert.ok(text.includes(`token: ${store.sentinel}`), `${label}: the seeded credential record is gone`)
}

async function waitForComposerDraft(
  client: UpgradeClientHandle,
  needle: string,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const viewport = (await client.text()).split('\n')
    const separators: number[] = []
    for (let index = 0; index < viewport.length; index += 1) {
      if (/^─+$/u.test(viewport[index].trim())) separators.push(index)
    }
    if (separators.length > 0) {
      const top = separators.length >= 2 ? separators[separators.length - 2] : separators[separators.length - 1]
      const bottom = separators.length >= 2 ? separators[separators.length - 1] : viewport.length
      const composer = viewport.slice(top + 1, bottom).join('\n')
      if (composer.includes('❯') && composer.includes(needle)) return
    }
    await sleep(50)
  }
  throw new Error(`${label}: the editor composer never contained the test probe`)
}

async function leaveCredentialList(client: UpgradeClientHandle, label: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = `launchd-editor-${attempt}`
    await client.type(probe)
    try {
      await waitForComposerDraft(client, probe, label)
      await client.press('Ctrl+U')
      return
    } catch {
      await client.press('Ctrl+U')
      await client.press('Escape')
      await sleep(250)
    }
  }
  throw new Error(`${label}: the main editor never regained the seat`)
}

async function assertCredentialReadback(client: UpgradeClientHandle, store: SeededCredentialStore, label: string): Promise<void> {
  await client.submit('/logout')
  await waitForPaintedText(client, CREDENTIAL_KEY, `${label}: the stored credential key`, 120_000)
  const visible = `${await client.text(true)}\n${readFileSync(client.recordFile, 'utf8')}`
  assert.ok(!visible.includes(store.sentinel), `${label}: the stored credential secret leaked into the Client`)
  await leaveCredentialList(client, label)
}

async function closeClient(client: UpgradeClientHandle, label: string): Promise<void> {
  await client.submit('/exit')
  const exit = await client.waitForExit(120_000)
  assert.equal(exit.code, 0, `${label}: /exit returned ${JSON.stringify(exit)}`)
  assert.equal(exit.signal, null, `${label}: /exit was signal ${String(exit.signal)}`)
  await client.close()
}

function readReceipt(scene: UpgradeScene): Record<string, any> {
  const tmpBase = process.env.SPLIT_VITEST_TMP_BASE
  assert.ok(typeof tmpBase === 'string', 'SPLIT_VITEST_TMP_BASE is required')
  const parentRunId = process.env.SPLIT_VITEST_RUN_ID ?? 'split-upgrade'
  const path = join(tmpBase, 'split-resources', `${parentRunId}-${scene.sceneId}.json`)
  assert.ok(existsSync(path), `the native Supervisor receipt is missing: ${path}`)
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
}

function assertNativeObservation(
  observation: ManagedServiceObservation,
  expected: { pid: number; scopeId: string; installBuild?: string },
  label: string,
): void {
  assert.equal(observation.state, 'managed-active', `${label}: the managed service is ${observation.state}`)
  assert.equal(observation.file, 'owned', `${label}: the managed plist is ${observation.file}`)
  assert.equal(observation.ownerVerified, true, `${label}: the managed plist owner was not verified`)
  assert.equal(observation.authenticatedHostReady, true, `${label}: the managed Host is not authenticated Ready`)
  assert.equal(observation.authenticatedHostPid, expected.pid, `${label}: another Host PID is authenticated`)
  assert.equal(observation.mainPid, expected.pid, `${label}: the managed job runs another PID`)
  assert.equal(observation.managerState, 'active', `${label}: the managed job state is ${String(observation.managerState)}`)
  assert.equal(observation.fileFacts?.scopeId, expected.scopeId, `${label}: the plist scope changed`)
  if (expected.installBuild !== undefined) {
    assert.equal(observation.fileFacts?.installBuild, expected.installBuild, `${label}: the plist install build changed`)
  }
  assert.equal(observation.fileFacts?.mode, 0o600, `${label}: the managed plist is not 0600`)
  assert.equal(typeof observation.sourcePath, 'string', `${label}: launchctl printed no source path`)
}

function hostIdentity(record: Record<string, any> | undefined): Record<string, any> {
  const identity = record?.host
  assert.equal(identity !== null && typeof identity === 'object', true, 'the Client did not report its authenticated Host')
  for (const key of ['scopeId', 'instanceId', 'hostPid', 'buildId']) {
    assert.ok(identity[key] !== undefined && identity[key] !== null, `the authenticated Host identity has no ${key}`)
  }
  return identity as Record<string, any>
}

function kernelIdentity(pid: number, label: string): KernelProcessIdentity {
  const observed = readKernelProcess(pid)
  assert.ok(observed.kind === 'alive', `${label}: PID ${String(pid)} has no live kernel identity (${observed.kind})`)
  return observed.identity
}

async function reportKillPoint(scene: UpgradeScene, point: (typeof KILL_POINTS)[number]): Promise<void> {
  await scene.report('native-kill-ready', { point })
  if (process.env[KILL_SWITCH] === point) {
    // The external probe owns the actual SIGKILL; this bounded passive wait only
    // keeps the real manager/Host/Client state observable at the exact point.
    await sleep(120_000)
  }
}

test('LaunchAgent restart adopts the installed build without losing user customization, and rollback restores the previous Host', async () => {
  const preflight = await launchdManager.preflightLaunchdTestEnvironment()
  const uid = process.getuid?.()
  assert.equal(preflight.uid, uid, 'the native launchd preflight resolved another account')
  const requestedKillPoint = process.env[KILL_SWITCH]
  if (requestedKillPoint !== undefined) {
    assert.ok((KILL_POINTS as readonly string[]).includes(requestedKillPoint),
      `the test-only native kill point ${JSON.stringify(requestedKillPoint)} is not one of ${KILL_POINTS.join(', ')}`)
  }

  let scene: UpgradeScene | undefined
  let primary: Error | undefined
  try {
    scene = await createNativeUpgradeScene({ manager: 'launchd' })
    assert.equal(sha256File(scene.pair.old.path), scene.pair.old.sha256, 'the frozen old tarball changed before the Scene started')
    assert.equal(sha256File(scene.pair.new.path), scene.pair.new.sha256, 'the frozen new tarball changed before the Scene started')

    // ── A. Old Profile, non-managed seed Host, durable Turn and credentials ──
    const oldProfile = await scene.installOldProfile()
    assert.equal(oldProfile.version, scene.pair.old.version, 'the old Profile install carries another version')
    assert.equal(support.installedPayloadHash(oldProfile.packageRoot), oldProfile.payloadHash,
      'the old Profile payload differs from this run\'s install receipt')
    assert.equal(support.productionBuildId(oldProfile.packageRoot, scene.pair.targetDshVersion), oldProfile.buildId,
      'the old Profile build identity differs from this run\'s install receipt')

    const seedHost = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
    assert.equal(seedHost.generation, 1, 'the seed Host is not generation 1')
    assert.equal(seedHost.buildId, oldProfile.buildId, 'the seed Host does not run the old build')
    const seedClient = await scene.startClient({ source: 'profile', label: SEED_CLIENT })
    await seedClient.submit(SESSION_PROMPT)
    await waitForPaintedText(seedClient, SESSION_PROMPT, 'the seed Client painted its admitted prompt')
    const sessionId = (await waitForSurfaceSession(seedClient, 'the seed Client opened the Session')).openSessionId
    const releaseBoundary = hostSessionEvents(scene, sessionId)?.length ?? 0
    await waitForC1Event(seedHost.workRoot,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
      'the seed Host held its durable Turn')
    await scene.releaseHeldTurn(seedHost)
    await waitForHostSessionEventAfter(scene, sessionId, releaseBoundary,
      event => event.type === 'turn/end', 'the seed Host settled its durable Turn')
    const seedEvents = hostSessionEvents(scene, sessionId) ?? []
    assert.equal(userPromptCount(scene, sessionId, SESSION_PROMPT), 1, 'the seed Session did not persist exactly one human prompt')
    assert.equal(turnEndCount(scene, sessionId), 1, 'the seed Session did not persist exactly one Turn end')
    await closeClient(seedClient, 'the seed Client')
    const seedStop = await scene.stopHost(seedHost)
    assert.equal(seedStop.code, 0, `the seed Host stop returned ${JSON.stringify(seedStop)}`)
    await waitForPidGone(seedHost.ready.pid, 'the seed Host PID')
    assertNoHost(scene, 'after the seed Host stop')

    const store = seedCredentialStore(scene)
    assert.equal(statSync(store.path).mode & 0o777, 0o600, 'the seeded credential store is not 0600')
    assert.deepEqual(store.recordKeys, [CREDENTIAL_KEY], 'the seeded credential store carries unexpected records')

    const snapshot = await scene.reserveManagedService()
    assert.equal(snapshot.reservation.manager, 'launchd', 'the Supervisor reserved another manager')
    assert.equal(snapshot.observation.state, 'reserved-but-absent', 'the managed target was not absent before the reservation')
    const reservation = snapshot.reservation
    const label = reservation.unitName
    const plistPath = reservation.unitPath
    assert.match(label, /^com\.xmoon\.dsh-pi-tui\.[0-9a-f]{40}$/u, 'the reserved label is not the product-derived label')
    assert.equal(label.startsWith(LAUNCHD_LABEL_PREFIX), true, 'the reserved label has a foreign prefix')
    assert.equal(existsSync(plistPath), false, 'the reserved plist path already exists')
    assertJobAbsent(label)
    const coldStatus = assertDaemon(await scene.runProfileDaemon('status'), {
      host: 'stopped',
      manager: 'unmanaged',
      unit: 'none',
      compatibility: 'none',
    }, 'the cold status before the managed install')
    assert.equal(coldStatus.pid, undefined, 'a stopped Profile published a PID')
    const receiptAfterReserve = readReceipt(scene)
    assert.equal(receiptAfterReserve.phase, 'NATIVE_SERVICE_RESERVED', 'the reservation receipt phase is not durable')
    assert.equal(receiptAfterReserve.native?.reservation?.unitPath, plistPath, 'the receipt names another plist')

    // ── B. Official old LaunchAgent install/start and native owner proof ─────
    const install = await scene.runProfileDaemon('install')
    assert.equal(install.exitCode, 0, `the old launchd install failed: ${install.stderr.slice(-500)}`)
    assertJobAbsent(label)
    assertNoHost(scene, 'after the official install (install must not start a Host)')
    const installedSnapshot = plistSnapshot(plistPath)
    assertPlistIdentity(scene, installedSnapshot, reservation)
    assert.equal(installedSnapshot.decoded['X-DshPiTuiInstallBuild'], oldProfile.buildId,
      'the installed plist does not record the old build')
    const installed = await scene.verifyManagedService()
    assert.equal(installed.observation.state, 'installed-inactive', `the installed plist is ${installed.observation.state}`)
    assert.equal(installed.observation.file, 'owned', 'the installed plist is not owned')
    assert.equal(installed.observation.fileFacts?.installBuild, oldProfile.buildId, 'the installed plist records another build')
    assert.equal(installed.observation.fileFacts?.mode, 0o600, 'the installed plist is not 0600')
    await reportKillPoint(scene, 'managed-install-complete')

    const start = await scene.runProfileDaemon('start')
    const oldStatus = assertDaemon(start, {
      host: 'ready',
      manager: 'launchd',
      unit: label,
      unitState: 'running',
      compatibility: 'compatible',
    }, 'the old managed start')
    const h0Pid = oldStatus.pid
    assert.ok(Number.isInteger(h0Pid) && h0Pid! > 0, 'the old managed start published no real PID')
    assertPrintedJob(label, h0Pid!, plistPath)
    const h0Instance = oldStatus.instance
    assert.equal(typeof h0Instance, 'string', 'the old managed status published no instance id')
    const h0KernelIdentity = kernelIdentity(h0Pid!, 'old managed Host H0')
    const h0Kernel = nativeContract.serializeKernelIdentity(h0KernelIdentity)
    assert.equal(assertOneHost(scene, 'after the old managed start'), h0Pid, 'the managed Host PID is not the Scene Host PID')

    const oldClient = await scene.startClient({ source: 'profile', label: OLD_CLIENT, sessionId })
    const oldAuth = hostIdentity(await oldClient.waitForRecord(
      record => record.m4a0 === 'host-authenticated', 'the old Client authenticated Host H0'))
    assert.equal(oldAuth.hostPid, h0Pid, 'the old Client authenticated another Host PID')
    assert.equal(oldAuth.buildId, oldProfile.buildId, 'the old Client authenticated another build')
    assert.equal(oldAuth.scopeId, reservation.scopeId, 'the old Client authenticated another scope')
    assert.ok(oldAuth.instanceId.startsWith(h0Instance), 'the old Client authenticated another Host instance')
    await waitForPaintedText(oldClient, SESSION_PROMPT, 'the old Client painted the durable prompt')
    await assertCredentialReadback(oldClient, store, 'the old Client')
    await reportKillPoint(scene, 'managed-host-client-attached')
    await closeClient(oldClient, 'the old Client')
    const oldSurvived = await scene.verifyManagedService()
    assertNativeObservation(oldSurvived.observation,
      { pid: h0Pid!, scopeId: reservation.scopeId, installBuild: oldProfile.buildId },
      'the managed Host after the old Client exit')
    assertOneHost(scene, 'after the old Client exit')

    // ── C. Official new Profile install while H0 keeps running ───────────────
    const plistBeforeNew = plistSnapshot(plistPath)
    const newProfile = await scene.installManagedProfile('new')
    assert.equal(newProfile.version, scene.pair.new.version, 'the new Profile install carries another version')
    assert.notEqual(newProfile.buildId, oldProfile.buildId, 'the two packed builds produced the same build identity')
    const newProfileObserved = await scene.verifyManagedService()
    assertNativeObservation(newProfileObserved.observation,
      { pid: h0Pid!, scopeId: reservation.scopeId, installBuild: oldProfile.buildId },
      'the running old Host after the new Profile install')
    assert.equal(plistSnapshot(plistPath).content, plistBeforeNew.content, 'the new Profile install rewrote the managed plist')
    const crossStatus = assertDaemon(await scene.runProfileDaemon('status'), {
      host: 'ready',
      manager: 'launchd',
      unit: label,
      compatibility: 'other-build',
    }, 'the status of the new install beside the running old Host')
    assert.equal(crossStatus.pid, h0Pid, 'the status lost the running old Host PID')
    assert.equal(plistSnapshot(plistPath).content, plistBeforeNew.content, 'the status rewrote the managed plist')

    const updatedClient = await scene.startClient({ source: 'profile', label: UPDATED_CLIENT, sessionId })
    const updatedAuth = hostIdentity(await updatedClient.waitForRecord(
      record => record.m4a0 === 'host-authenticated', 'the new-build Client authenticated the old Host'))
    assert.equal(updatedAuth.hostPid, h0Pid, 'the new-build Client authenticated another Host PID')
    assert.equal(updatedAuth.buildId, oldProfile.buildId, 'the old Host changed build under the new-build Client')
    assert.ok(updatedAuth.instanceId.startsWith(h0Instance), 'the new-build Client authenticated another Host instance')
    await waitForPaintedText(updatedClient, SESSION_PROMPT, 'the new-build Client painted the durable prompt')
    await assertCredentialReadback(updatedClient, store, 'the new-build Client')
    await closeClient(updatedClient, 'the new-build Client')
    assertOneHost(scene, 'after the new-build Client exit')

    const beforeCustomization = await scene.verifyManagedService()
    const nonGeneratedBeforeCustomization = beforeCustomization.observation.fileFacts?.nonGeneratedSha256
    assert.equal(typeof nonGeneratedBeforeCustomization, 'string', 'the managed plist has no non-generated digest')
    const customization = await scene.customizeManagedService({ ...nativeContract.LAUNCHD_CUSTOMIZATION })
    assert.equal(customization.observation.file, 'owned', 'the customized plist is not owned')
    assert.equal(customization.observation.ownerVerified, true, 'the customized plist owner was not verified')
    const customizedSnapshot = plistSnapshot(plistPath)
    assertPlistIdentity(scene, customizedSnapshot, reservation)
    assert.equal(customizedSnapshot.decoded.EnvironmentVariables[USER_FLAG_KEY], USER_FLAG_VALUE,
      'the fixed user environment key was not installed')
    assert.ok(customizedSnapshot.content.includes(`<!-- ${USER_COMMENT} -->`),
      'the fixed human launch-agent comment was not installed')
    assert.deepEqual(customizedSnapshot.decoded.ProgramArguments, plistBeforeNew.decoded.ProgramArguments,
      'the user customization changed the generated ProgramArguments')
    assert.equal(customizedSnapshot.decoded['X-DshPiTuiInstallBuild'],
      plistBeforeNew.decoded['X-DshPiTuiInstallBuild'], 'the user customization changed the generated install build')
    const nonGeneratedAfterCustomization = customization.observation.fileFacts?.nonGeneratedSha256
    assert.equal(typeof nonGeneratedAfterCustomization, 'string', 'the customized plist has no non-generated digest')
    assert.notEqual(nonGeneratedAfterCustomization, nonGeneratedBeforeCustomization,
      'the user customization did not change the non-generated bytes')
    const customizedReceipt = readReceipt(scene)
    assert.equal(customizedReceipt.phase, 'NATIVE_SERVICE_CUSTOMIZED', 'the customization receipt phase is not durable')
    assert.equal(customizedReceipt.native?.fileIdentity?.sha256, customization.observation.fileFacts?.sha256,
      'the Supervisor receipt did not persist the customized file identity')
    await reportKillPoint(scene, 'managed-customization-committed')
    const h0AfterCustomization = await scene.verifyManagedService()
    assertNativeObservation(h0AfterCustomization.observation,
      { pid: h0Pid!, scopeId: reservation.scopeId, installBuild: oldProfile.buildId },
      'the running old Host after the user customization')
    assert.equal(h0AfterCustomization.observation.fileFacts?.sha256, customization.observation.fileFacts?.sha256,
      'the customization observation and the durable receipt disagree')
    assert.equal(h0AfterCustomization.observation.fileFacts?.nonGeneratedSha256, nonGeneratedAfterCustomization,
      'the customized non-generated bytes changed before the restart')
    const statusAfterCustomization = assertDaemon(await scene.runProfileDaemon('status'), {
      host: 'ready',
      manager: 'launchd',
      unit: label,
      compatibility: 'other-build',
    }, 'the status after the user customization')
    assert.equal(statusAfterCustomization.pid, h0Pid, 'the status after customization lost the running old Host PID')
    assert.equal(plistSnapshot(plistPath).content, customizedSnapshot.content,
      'the status rewrote the user-customized plist')

    // ── D. Explicit restart adopts the installed build through a stable entry ─
    const oldEntry = plistBeforeNew.decoded.ProgramArguments
    assert.equal(Array.isArray(oldEntry) && oldEntry.length === 2, true, 'the generated plist argv is not the two-string block')
    const stableEntry = join(realpathSync(scene.installation.profileDir),
      'node_modules', '@xmoon76', 'dsh-pi-tui', 'dist', 'local-host.mjs')
    const wasStableEntry = (() => {
      try {
        return realpathSync(oldEntry[1] as string) === realpathSync(stableEntry)
      } catch {
        return false
      }
    })()
    const restart = await scene.runProfileDaemon('restart')
    const restartedStatus = assertDaemon(restart, {
      host: 'ready',
      manager: 'launchd',
      unit: label,
      compatibility: 'compatible',
    }, 'the explicit managed restart')
    const h1Pid = restartedStatus.pid
    assert.ok(Number.isInteger(h1Pid) && h1Pid! > 0, 'the restarted Host published no real PID')
    assert.notEqual(h1Pid, h0Pid, 'the restart reused the old Host PID')
    assert.notEqual(restartedStatus.instance, h0Instance, 'the restart reused the old Host instance')
    assertPrintedJob(label, h1Pid!, plistPath)
    await waitForPidGone(h0Pid!, 'old managed Host H0 after the restart')
    const h0AfterRestart = readKernelProcess(h0Pid!)
    const h0Classification = sameKernelProcess(h0KernelIdentity, h0AfterRestart)
    assert.ok(h0Classification === 'gone' || h0Classification === 'different',
      `the old Host kernel identity is still current (${h0Classification})`)
    const h1KernelIdentity = kernelIdentity(h1Pid!, 'restarted managed Host H1')
    assert.notEqual(nativeContract.serializeKernelIdentity(h1KernelIdentity), h0Kernel,
      'the restarted Host reused the old Darwin kernel identity')
    const restartedSnapshot = plistSnapshot(plistPath)
    assertPlistIdentity(scene, restartedSnapshot, reservation)
    assert.equal(restartedSnapshot.decoded.EnvironmentVariables[USER_FLAG_KEY], USER_FLAG_VALUE,
      'the restart dropped the fixed user environment key')
    assert.ok(restartedSnapshot.content.includes(`<!-- ${USER_COMMENT} -->`),
      'the restart dropped the human launch-agent comment')
    assert.equal(restartedSnapshot.decoded.ProgramArguments.length, 2, 'the restart restructured the generated argv')
    assert.equal(realpathSync(restartedSnapshot.decoded.ProgramArguments[1] as string), realpathSync(stableEntry),
      'the restarted plist does not carry the stable lexical Host entry')
    if (wasStableEntry) {
      assert.equal(restartedSnapshot.decoded['X-DshPiTuiInstallBuild'], oldProfile.buildId,
        'an already-stable generated entry was unnecessarily rewritten')
    } else {
      assert.equal(restartedSnapshot.decoded['X-DshPiTuiInstallBuild'], newProfile.buildId,
        'a migrated generated entry did not record the new build')
    }
    assertOneHost(scene, 'after the explicit restart')

    const restartedClient = await scene.startClient({ source: 'profile', label: RESTARTED_CLIENT, sessionId })
    const restartedAuth = hostIdentity(await restartedClient.waitForRecord(
      record => record.m4a0 === 'host-authenticated', 'the restarted Client authenticated Host H1'))
    assert.equal(restartedAuth.hostPid, h1Pid, 'the restarted Client authenticated another Host PID')
    assert.equal(restartedAuth.buildId, newProfile.buildId, 'the restarted Host did not publish the new build')
    assert.ok(restartedAuth.instanceId.startsWith(restartedStatus.instance), 'the restarted Client authenticated another Host instance')
    assert.equal(restartedAuth.scopeId, reservation.scopeId, 'the restarted Client authenticated another scope')
    await waitForPaintedText(restartedClient, SESSION_PROMPT, 'the restarted Client painted the durable prompt')
    const h1Observed = await scene.verifyManagedService()
    assertNativeObservation(h1Observed.observation,
      { pid: h1Pid!, scopeId: reservation.scopeId,
        installBuild: wasStableEntry ? oldProfile.buildId : newProfile.buildId },
      'the restarted managed Host')
    assert.equal(h1Observed.observation.fileFacts?.nonGeneratedSha256, nonGeneratedAfterCustomization,
      'the restart changed bytes outside the generated entry')
    await assertCredentialReadback(restartedClient, store, 'the restarted Client')
    await closeClient(restartedClient, 'the restarted Client')
    const eventsAfterRestart = hostSessionEvents(scene, sessionId) ?? []
    assert.equal(userPromptCount(scene, sessionId, SESSION_PROMPT), 1, 'the upgraded Session replayed or duplicated the prompt')
    assert.equal(eventsAfterRestart.slice(0, seedEvents.length).map(event => JSON.stringify(event)).join('\n'),
      seedEvents.map(event => JSON.stringify(event)).join('\n'), 'the durable Session prefix changed across the upgrade')
    const appendedTypes = eventsAfterRestart.slice(seedEvents.length).map(event => String(event.type ?? 'unknown'))
    for (const type of appendedTypes) {
      assert.equal(HISTORY_EVENT_TYPES.has(type), false, `the upgrade appended a ${type} history event`)
    }
    assertCredentialStorePreserved(store, 'after the upgraded Host readback')
    assertOneHost(scene, 'after the restarted Client exit')

    // ── E. Truthful rollback: explicit NEW uninstall, then OLD install/start ─
    assertDaemon(await scene.runProfileDaemon('stop'), { host: 'stopped' },
      'the explicit stop before the rollback uninstall')
    await waitForPidGone(h1Pid!, 'managed Host H1 after the explicit stop')
    const preRollbackUninstall = await scene.runProfileDaemon('uninstall')
    assert.equal(preRollbackUninstall.exitCode, 0, `the pre-rollback NEW service uninstall failed: ${preRollbackUninstall.stderr.slice(-500)}`)
    assert.equal(existsSync(plistPath), false, 'the pre-rollback uninstall did not remove the NEW plist')
    assertJobAbsent(label)
    const removed = await scene.verifyManagedService()
    assert.equal(removed.observation.state, 'removed', `the NEW service is ${removed.observation.state} after uninstall`)
    assert.equal(removed.observation.file, 'absent', 'the NEW plist still exists after uninstall')
    assert.equal(removed.observation.managerState, 'not-loaded', 'the NEW job is still loaded after uninstall')

    const oldAgain = await scene.installManagedProfile('old')
    assert.equal(oldAgain.buildId, oldProfile.buildId, 'the rollback Profile install did not restore the old build')
    assertNoHost(scene, 'after the rollback Profile install (install must not start a Host)')
    assertJobAbsent(label)
    const rollbackInstall = await scene.runProfileDaemon('install')
    assert.equal(rollbackInstall.exitCode, 0, `the OLD build service install failed: ${rollbackInstall.stderr.slice(-500)}`)
    assertJobAbsent(label)
    assertNoHost(scene, 'after the OLD build service install')
    const rollbackPlist = plistSnapshot(plistPath)
    assertPlistIdentity(scene, rollbackPlist, reservation)
    assert.equal(rollbackPlist.decoded['X-DshPiTuiInstallBuild'], oldProfile.buildId,
      'the OLD build service definition records another install build')
    assert.equal(rollbackPlist.decoded.EnvironmentVariables[USER_FLAG_KEY], undefined,
      'the explicitly uninstalled NEW service customization was not removed with that definition')
    const rollbackStart = await scene.runProfileDaemon('start')
    const rollbackStatus = assertDaemon(rollbackStart, {
      host: 'ready',
      manager: 'launchd',
      unit: label,
      compatibility: 'compatible',
    }, 'the OLD build managed rollback start')
    const h2Pid = rollbackStatus.pid
    assert.ok(Number.isInteger(h2Pid) && h2Pid! > 0, 'the rollback Host published no real PID')
    assert.notEqual(h2Pid, h1Pid, 'the rollback Host reused the forward Host PID')
    assert.notEqual(rollbackStatus.instance, restartedStatus.instance, 'the rollback Host reused the forward Host instance')
    assertPrintedJob(label, h2Pid!, plistPath)
    const h2KernelIdentity = kernelIdentity(h2Pid!, 'rollback managed Host H2')
    assert.notEqual(nativeContract.serializeKernelIdentity(h2KernelIdentity), nativeContract.serializeKernelIdentity(h1KernelIdentity),
      'the rollback Host reused the forward Host kernel identity')
    assertOneHost(scene, 'after the rollback managed start')

    const rollbackClient = await scene.startClient({ source: 'profile', label: ROLLBACK_CLIENT, sessionId })
    const rollbackAuth = hostIdentity(await rollbackClient.waitForRecord(
      record => record.m4a0 === 'host-authenticated', 'the rollback Client authenticated Host H2'))
    assert.equal(rollbackAuth.hostPid, h2Pid, 'the rollback Client authenticated another Host PID')
    assert.equal(rollbackAuth.buildId, oldProfile.buildId, 'the rollback Host did not publish the old build')
    assert.ok(rollbackAuth.instanceId.startsWith(rollbackStatus.instance), 'the rollback Client authenticated another Host instance')
    assert.equal(rollbackAuth.scopeId, reservation.scopeId, 'the rollback Client authenticated another scope')
    await waitForPaintedText(rollbackClient, SESSION_PROMPT, 'the rollback Client painted the durable prompt')
    const rollbackObserved = await scene.verifyManagedService()
    assertNativeObservation(rollbackObserved.observation,
      { pid: h2Pid!, scopeId: reservation.scopeId, installBuild: oldProfile.buildId },
      'the rollback managed Host')
    await assertCredentialReadback(rollbackClient, store, 'the rollback Client')
    await closeClient(rollbackClient, 'the rollback Client')
    assert.ok((hostSessionEvents(scene, sessionId) ?? []).length > 0, 'the rollback lost the durable Session')
    assertCredentialStorePreserved(store, 'after the rollback readback')
    assertOneHost(scene, 'after the rollback Client exit')

    // ── F. Official close and independent resource cleanup ───────────────────
    assertDaemon(await scene.runProfileDaemon('stop'), { host: 'stopped' }, 'the closing managed stop')
    await waitForPidGone(h2Pid!, 'rollback managed Host H2 after the closing stop')
    const uninstalled = assertDaemon(await scene.runProfileDaemon('uninstall'), {
      host: 'stopped',
      unit: 'none',
      unitState: 'not-found',
    }, 'the closing managed uninstall')
    assert.equal(uninstalled.manager, 'unmanaged', 'the closing uninstall still reports a managed service')
    assert.equal(existsSync(plistPath), false, 'the closing uninstall did not remove the managed plist')
    assertJobAbsent(label)
    assertNoHost(scene, 'after the closing uninstall')
    const finalStatus = assertDaemon(await scene.runProfileDaemon('status'), {
      host: 'stopped',
      manager: 'unmanaged',
      unit: 'none',
      unitState: 'not-found',
      compatibility: 'none',
    }, 'the final status with no managed service')
    assert.equal(finalStatus.pid, undefined, 'the final stopped Profile still publishes a PID')
    assertCredentialStorePreserved(store, 'after the closing uninstall')
    assert.ok(sessionLogFiles(scene).length > 0, 'the durable Session log was deleted by stop/uninstall')

    await scene.finish()
  } catch (error) {
    primary = error instanceof Error ? error : new Error(String(error))
  } finally {
    if (scene !== undefined) {
      try {
        await scene.dispose()
      } catch (cleanupError) {
        const cleanup = cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
        primary = primary === undefined
          ? cleanup
          : new AggregateError([primary, cleanup], 'the launchd managed scene failed and its Scene cleanup also failed')
      }
    }
  }
  if (primary !== undefined) throw primary
})
