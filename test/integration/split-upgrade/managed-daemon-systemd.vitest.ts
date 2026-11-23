/**
 * One real systemd user-manager upgrade and rollback scene.
 *
 * The test drives the official Profile install and daemon commands across two
 * immutable packages. A real PTY Client seeds one durable Session and one
 * credential record, the systemd unit is installed and started, a new package
 * is installed without replacing the live Host, an explicit restart adopts it,
 * two independent Clients read the durable data, and an explicit stop/install/
 * restart/uninstall sequence rolls back and reclaims the run-owned unit.
 *
 * The shared Supervisor owns the reservation, the manager process and cleanup.
 * This file owns only the Worker-side assertions and the real Clients.
 *
 * @module test/integration/split-upgrade/managed-daemon-systemd.vitest
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, relative, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { test } from 'vitest'

import {
  createNativeUpgradeScene,
  type NativeManagerInspection,
  type NativeReservationFacts,
  type NativeServiceSnapshot,
  type UpgradeClientHandle,
  type UpgradeScene,
} from '../../support/split-upgrade-fixture.ts'
import {
  hostArtifacts,
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

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = realpathSync(join(TEST_DIR, '..', '..', '..'))

interface SystemdManagerModule {
  inspectManagedService(reservation: NativeReservationFacts): Promise<NativeManagerInspection>
}

interface ManagedDaemonStatus {
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

interface NativeContractModule {
  parseManagedDaemonStatus(stdout: string): ManagedDaemonStatus
}

interface SplitUpgradeSupportModule {
  installedPayloadHash(packageRoot: string): string
  productionBuildId(packageRoot: string, dshVersion: string): string
}

const systemdManager = await import(
  pathToFileURL(join(REPO_ROOT, 'test', 'support', 'split-upgrade-systemd-manager.mjs')).href
) as SystemdManagerModule
const nativeContract = await import(
  pathToFileURL(join(REPO_ROOT, 'test', 'support', 'split-upgrade-native-contract.mjs')).href
) as NativeContractModule
const splitUpgradeSupport = await import(
  pathToFileURL(join(REPO_ROOT, 'scripts', 'lib', 'split-upgrade-support.mjs')).href
) as SplitUpgradeSupportModule

const TEST_TITLE = 'systemd-managed Host adopts the installed build on explicit restart and rollback preserves the durable Session'
const PROMPT = 'systemd-upgrade-durable-turn'
const ANSWER = 'long-turn answer 1'
const CREDENTIAL_KEY = 'managed-upgrade/credential-proof'
const CREDENTIAL_TOKEN = 'managed-upgrade-credential-sentinel'
const CREDENTIAL_BLOCK = [
  `  ${CREDENTIAL_KEY}:`,
  '    kind: grant',
  '    payload:',
  `      token: ${CREDENTIAL_TOKEN}`,
].join('\n')
const CREDENTIAL_KEY_PATTERN = /^ {2}([a-z][a-z0-9-]*\/[a-z][a-z0-9-]*):$/gmu
const UNIT_NAME_PATTERN = /^dsh-pi-tui@pi-tui-[0-9a-f]{16}\.service$/u
const HISTORY_EVENT_TYPES = Object.freeze(['user/message', 'assistant/message', 'turn/start', 'turn/end'])
const SEED_CLIENT = 'managed-systemd-client-seed'
const OLD_CLIENT = 'managed-systemd-client-old'
const NEW_CLIENT_A = 'managed-systemd-client-new-a'
const NEW_CLIENT_B = 'managed-systemd-client-new-b'
const ROLLBACK_CLIENT = 'managed-systemd-client-rollback'
const KILL_INSTALL = 'managed-install-complete'
const KILL_CLIENT_ATTACHED = 'managed-host-client-attached'
const TEST_TIMEOUT_MS = 900_000

interface SystemdEnvironment {
  accountHome: string
  runtimeDir: string
  tmpBase: string
  uid: number
}

function failEnvironment(message: string): never {
  const error = new TypeError(`NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE: ${message}`)
  Object.assign(error, { code: 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE' })
  throw error
}

function failInput(message: string): never {
  const error = new TypeError(`INPUT_UNQUALIFIED: ${message}`)
  Object.assign(error, { code: 'INPUT_UNQUALIFIED' })
  throw error
}

function requireAbsoluteDirectory(path: string, label: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) failInput(`${label} must be an absolute path`)
  let real: string
  try {
    real = realpathSync(path)
  } catch (error) {
    failInput(`${label} cannot be resolved (${(error as NodeJS.ErrnoException).code ?? 'UNKNOWN'})`)
  }
  let info
  try {
    info = statSync(real)
  } catch (error) {
    failInput(`${label} cannot be inspected (${(error as NodeJS.ErrnoException).code ?? 'UNKNOWN'})`)
  }
  if (!info.isDirectory()) failInput(`${label} is not a directory`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid === undefined) failInput(`${label} requires a real uid`)
  if (info.uid !== uid) failInput(`${label} is not owned by this user`)
  if ((info.mode & 0o777) !== 0o700) failInput(`${label} must have mode 0700`)
  const rel = relative(REPO_ROOT, real)
  if (rel !== '..' && !rel.startsWith(`..${sep}`)) failInput(`${label} must be outside the checkout`)
  return real
}

function requireFrozenTarball(envName: string): void {
  const value = process.env[envName]
  if (typeof value !== 'string' || !value.startsWith('/')) failInput(`${envName} must be an absolute path`)
  let real: string
  try {
    real = realpathSync(value)
  } catch (error) {
    failInput(`${envName} cannot be resolved (${(error as NodeJS.ErrnoException).code ?? 'UNKNOWN'})`)
  }
  let info
  try {
    info = statSync(real)
  } catch (error) {
    failInput(`${envName} cannot be inspected (${(error as NodeJS.ErrnoException).code ?? 'UNKNOWN'})`)
  }
  if (!info.isFile()) failInput(`${envName} is not a regular file`)
  if ((info.mode & 0o222) !== 0) failInput(`${envName} must be read-only/frozen`)
  let linkInfo
  try {
    linkInfo = lstatSync(value)
  } catch (error) {
    failInput(`${envName} cannot be inspected (${(error as NodeJS.ErrnoException).code ?? 'UNKNOWN'})`)
  }
  if (linkInfo.nlink !== 1) failInput(`${envName} must have one hard link`)
}

function requireSystemdEnvironment(): SystemdEnvironment {
  if (process.platform !== 'linux') failEnvironment(`platform ${process.platform} is not Linux`)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (typeof uid !== 'number' || !Number.isInteger(uid) || uid <= 0) {
    failEnvironment('a real non-root uid is required')
  }
  const isolatedHome = process.env.SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME
  if (process.env.SPLIT_PROCESS_MANAGED_HOST_ISOLATED !== '1') {
    failEnvironment('SPLIT_PROCESS_MANAGED_HOST_ISOLATED must be 1')
  }
  if (typeof isolatedHome !== 'string' || isolatedHome === '') {
    failEnvironment('SPLIT_PROCESS_MANAGED_HOST_ISOLATED_HOME is required')
  }
  let accountHome: string
  try {
    accountHome = realpathSync(userInfo().homedir)
  } catch (error) {
    failEnvironment(`the real account home cannot be resolved (${(error as NodeJS.ErrnoException).code ?? 'UNKNOWN'})`)
  }
  let isolatedReal: string
  try {
    isolatedReal = realpathSync(isolatedHome)
  } catch (error) {
    failEnvironment(`the provisioned isolated home cannot be resolved (${(error as NodeJS.ErrnoException).code ?? 'UNKNOWN'})`)
  }
  if (accountHome !== isolatedReal) {
    failEnvironment('the real account home is not the provisioned isolated home')
  }
  if (!existsSync(join(accountHome, '.dsh-pi-tui-managed-host-isolated'))) {
    failEnvironment('the isolated-home marker is missing')
  }
  const runtimeDir = `/run/user/${String(uid)}`
  let runtimeInfo
  try {
    runtimeInfo = lstatSync(runtimeDir)
  } catch (error) {
    failEnvironment(`the real systemd user runtime directory is unavailable (${(error as NodeJS.ErrnoException).code ?? 'UNKNOWN'})`)
  }
  if (!runtimeInfo.isDirectory() || runtimeInfo.isSymbolicLink() || runtimeInfo.uid !== uid) {
    failEnvironment('the real systemd user runtime directory is unavailable')
  }
  const managerEnv: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: runtimeDir }
  const busPath = join(runtimeDir, 'bus')
  let busInfo
  try {
    busInfo = lstatSync(busPath)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      failEnvironment(`the session-bus path is unreadable (${code ?? 'UNKNOWN'})`)
    }
    busInfo = undefined
  }
  if (busInfo !== undefined) {
    if (busInfo.isSymbolicLink() || !busInfo.isSocket() || busInfo.uid !== uid) {
      failEnvironment('the session-bus path is not a user-owned socket')
    }
    managerEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`
  } else {
    delete managerEnv.DBUS_SESSION_BUS_ADDRESS
  }
  const managerProbe = spawnSync('/usr/bin/systemctl', [
    '--user', '--no-pager', '--no-ask-password', 'show-environment',
  ], { encoding: 'utf8', timeout: 15_000, env: managerEnv })
  if (managerProbe.error !== undefined || managerProbe.status !== 0) {
    failEnvironment('systemctl --user show-environment did not succeed')
  }
  const managerEnvironment = String(managerProbe.stdout ?? '').split('\n')
  if (!managerEnvironment.includes(`XDG_RUNTIME_DIR=${runtimeDir}`)) {
    failEnvironment('the user manager does not expose the expected XDG_RUNTIME_DIR')
  }
  const tmpBaseRaw = process.env.SPLIT_VITEST_TMP_BASE
  if (typeof tmpBaseRaw !== 'string' || tmpBaseRaw === '') failInput('SPLIT_VITEST_TMP_BASE is required')
  const tmpBase = requireAbsoluteDirectory(tmpBaseRaw, 'SPLIT_VITEST_TMP_BASE')
  requireFrozenTarball('SPLIT_VITEST_UPGRADE_OLD_TGZ')
  requireFrozenTarball('SPLIT_VITEST_UPGRADE_NEW_TGZ')
  return { accountHome, runtimeDir, tmpBase, uid }
}

function systemdManagerEnv(environment: SystemdEnvironment): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: environment.runtimeDir }
  const busPath = join(environment.runtimeDir, 'bus')
  if (existsSync(busPath)) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`
  else delete env.DBUS_SESSION_BUS_ADDRESS
  return env
}

function systemctlUser(args: string[], environment: SystemdEnvironment): string {
  const result = spawnSync('/usr/bin/systemctl', [
    '--user', '--no-pager', '--no-ask-password', ...args,
  ], { encoding: 'utf8', timeout: 15_000, env: systemdManagerEnv(environment) })
  assert.equal(result.status, 0, `systemctl --user ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
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

function processGroupAlive(pgid: number | undefined): boolean {
  if (pgid === undefined || !Number.isInteger(pgid) || pgid <= 0) return false
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    throw error
  }
}

function readDaemon(
  result: { exitCode: number; stdout: string; stderr: string },
  expected: Record<string, unknown>,
  label: string,
): ManagedDaemonStatus {
  assert.equal(result.exitCode, 0, `${label}: expected exit 0, saw ${String(result.exitCode)}: ${result.stderr}`)
  const status = nativeContract.parseManagedDaemonStatus(result.stdout)
  for (const [key, value] of Object.entries(expected)) {
    assert.equal((status as unknown as Record<string, unknown>)[key], value,
      `${label}: expected ${key}=${String(value)}, saw ${String((status as unknown as Record<string, unknown>)[key])}`)
  }
  return status
}

function assertObservation(
  snapshot: NativeServiceSnapshot,
  expected: Record<string, unknown>,
  label: string,
): NativeManagerInspection {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal((snapshot.observation as unknown as Record<string, unknown>)[key], value,
      `${label}: expected observation.${key}=${String(value)}, saw ${String((snapshot.observation as unknown as Record<string, unknown>)[key])}`)
  }
  return snapshot.observation
}

function assertUnitFile(
  observation: NativeManagerInspection,
  reservation: NativeReservationFacts,
  expectedBuildId: string,
  label: string,
): void {
  assert.equal(observation.file, 'owned', `${label}: the Profile unit is not an owned file`)
  assert.equal(observation.ownerVerified, true, `${label}: the Profile unit ownership is not verified`)
  assert.equal(observation.managerObserved, true, `${label}: the user manager was not observed`)
  assert.equal(observation.unitName, reservation.unitName, `${label}: the observed unit name changed`)
  assert.equal(observation.unitPath, reservation.unitPath, `${label}: the observed unit path changed`)
  assert.equal(observation.fragmentPath, realpathSync(reservation.unitPath), `${label}: the manager FragmentPath is not the canonical unit`)
  const facts = observation.fileFacts
  assert.ok(facts !== null, `${label}: the owned unit carries no file facts`)
  assert.equal(facts.mode, 0o600, `${label}: the generated unit is not 0600`)
  assert.equal(facts.owner, 'local-host-manager-v1', `${label}: the unit owner marker changed`)
  assert.equal(facts.scopeId, reservation.scopeId, `${label}: the unit scope changed`)
  assert.match(facts.profileIdentity, /^[0-9a-f]{64}$/u, `${label}: the unit profile identity is invalid`)
  assert.equal(facts.installBuild, expectedBuildId, `${label}: the unit install build is not the expected provenance`)
  assert.equal(facts.sha256, sha256File(reservation.unitPath), `${label}: the unit SHA does not match the file bytes`)
}

function unitText(path: string): string {
  return readFileSync(path, 'utf8')
}

function stripGeneratedUnitFields(text: string): string {
  return text.split('\n')
    .filter(line => !line.startsWith('ExecStart=') && !line.startsWith('X-DshPiTuiInstallBuild='))
    .join('\n')
}

function readSessionLogPath(scene: UpgradeScene, sessionId: string): string {
  const relativePath = sessionLogFiles(scene).find(name => name.includes(sessionId))
  assert.ok(relativePath !== undefined, `the durable Session log for ${sessionId} was not found`)
  return join(scene.installation.dshHome, 'sessions', relativePath)
}

function durableEvents(scene: UpgradeScene, sessionId: string): Array<Record<string, any>> {
  return (hostSessionEvents(scene, sessionId) ?? []) as Array<Record<string, any>>
}

function appendedEventTypes(events: Array<Record<string, any>>, prefixLength: number): string[] {
  return events.slice(prefixLength).map(event => String(event.type ?? 'unknown')).slice(0, 24)
}

function assertNoHistoryAppended(events: Array<Record<string, any>>, prefixLength: number, label: string): void {
  for (const type of appendedEventTypes(events, prefixLength)) {
    assert.ok(!HISTORY_EVENT_TYPES.includes(type), `${label}: the readback appended a ${type} event`)
  }
}

function assertEventPrefix(events: Array<Record<string, any>>, prefix: Array<Record<string, any>>, label: string): void {
  assert.equal(
    events.slice(0, prefix.length).map(event => JSON.stringify(event)).join('\n'),
    prefix.map(event => JSON.stringify(event)).join('\n'),
    `${label}: the durable Session event prefix changed`,
  )
}

function writeSeededCredentialsStore(dshHome: string): string {
  const path = join(dshHome, '.credentials.yaml')
  writeFileSync(path, [
    'version: 1',
    'refs: {}',
    'records:',
    `  ${CREDENTIAL_KEY}:`,
    '    kind: grant',
    '    payload:',
    `      token: ${CREDENTIAL_TOKEN}`,
    '',
  ].join('\n'), { mode: 0o600 })
  return path
}

function credentialStoreFacts(path: string): {
  sha256: string
  recordKeys: string[]
  seededBlockPreserved: boolean
} {
  const text = readFileSync(path, 'utf8')
  return {
    sha256: createHash('sha256').update(text).digest('hex'),
    recordKeys: [...text.matchAll(CREDENTIAL_KEY_PATTERN)].map(match => match[1]!).sort(),
    seededBlockPreserved: text.includes(CREDENTIAL_BLOCK),
  }
}

function assertCredentialStorePreserved(
  path: string,
  expectedKeys: readonly string[] | undefined,
  label: string,
): { sha256: string; recordKeys: string[] } {
  const facts = credentialStoreFacts(path)
  assert.ok(facts.seededBlockPreserved, `${label}: the seeded credential record block changed`)
  if (expectedKeys !== undefined) {
    assert.deepEqual(facts.recordKeys, [...expectedKeys], `${label}: the credential record key set changed`)
  }
  return facts
}

async function paintedComposer(client: UpgradeClientHandle): Promise<string | undefined> {
  const viewport = (await client.text()).split('\n')
  const separators: number[] = []
  for (let index = 0; index < viewport.length; index += 1) {
    if (/^─+$/u.test(viewport[index]!.trim())) separators.push(index)
  }
  if (separators.length === 0) return undefined
  const top = separators.length >= 2 ? separators[separators.length - 2]! : separators[separators.length - 1]!
  const bottom = separators.length >= 2 ? separators[separators.length - 1]! : viewport.length
  return viewport.slice(top + 1, bottom).join('\n')
}

async function waitForComposerDraft(
  client: UpgradeClientHandle,
  text: string,
  label: string,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const composer = await paintedComposer(client).catch(() => undefined)
    if (composer !== undefined && composer.includes('❯') && composer.includes(text)) return
    if (!(await client.isAlive())) {
      throw new Error(`${label}: the Client exited before the composer regained the editor`)
    }
    await sleep(50)
  }
  throw new Error(`${label}: the painted composer never held ${JSON.stringify(text)}`)
}

async function leaveCredentialList(client: UpgradeClientHandle, label: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = `managed-upgrade-editor-probe-${String(attempt)}`
    await client.type(probe)
    try {
      await waitForComposerDraft(client, probe, `${label}: editor regained its seat`)
      await client.press('Ctrl+U')
      return
    } catch {
      await client.press('Ctrl+U')
      await client.press('Escape')
      await sleep(250)
    }
  }
  throw new Error(`${label}: the stored-credentials screen never returned to the editor`)
}

async function assertCredentialReadback(client: UpgradeClientHandle, label: string): Promise<void> {
  await client.submit('/logout')
  await waitForPaintedText(client, 'Stored credentials', `${label}: stored credentials list`, 120_000)
  await waitForPaintedText(client, CREDENTIAL_KEY, `${label}: the exact stored record key`, 60_000)
  await waitForPaintedText(client, 'stored record (grant)', `${label}: the exact stored record kind`, 60_000)
  const frame = await client.text(true)
  assert.ok(!frame.includes(CREDENTIAL_TOKEN), `${label}: the stored secret leaked into the terminal`)
  await leaveCredentialList(client, label)
}

async function waitForClientHostIdentity(
  client: UpgradeClientHandle,
  label: string,
): Promise<Record<string, any>> {
  const record = await client.waitForRecord(
    value => value.m4a0 === 'host-authenticated',
    `${label}: official host-authenticated record`,
    120_000,
  )
  const host = record.host
  assert.ok(host !== null && typeof host === 'object', `${label}: the Client authenticated no Host identity`)
  for (const key of ['scopeId', 'instanceId', 'hostPid', 'hostStarttime', 'buildId']) {
    assert.ok(host[key] !== undefined && host[key] !== null, `${label}: the authenticated Host identity has no ${key}`)
  }
  return host as Record<string, any>
}

async function waitForExternalKill(point: string): Promise<never> {
  await sleep(120_000)
  throw new Error(`the external probe did not deliver the ${point} kill within the bounded wait`)
}

function workerKillIdentity(): { pid: number; ppid: number; kernelIdentity: string } {
  const stat = readFileSync('/proc/self/stat', 'utf8')
  const close = stat.lastIndexOf(')')
  assert.ok(close > 0, 'the Worker kernel identity is unreadable')
  const fields = stat.slice(close + 2).trim().split(/\s+/u)
  const ppid = Number(fields[1])
  const startTicks = fields[19] ?? ''
  assert.ok(Number.isSafeInteger(ppid) && ppid > 0, 'the Worker parent PID is unreadable')
  assert.match(startTicks, /^\d+$/u, 'the Worker kernel start time is unreadable')
  return { pid: process.pid, ppid, kernelIdentity: `linux:${startTicks}` }
}

async function runScene(run: (scene: UpgradeScene) => Promise<void>): Promise<void> {
  let scene: UpgradeScene | undefined
  let primary: unknown
  try {
    scene = await createNativeUpgradeScene({ manager: 'systemd' })
    await run(scene)
  } catch (error) {
    primary = error
  } finally {
    if (scene !== undefined) {
      try {
        await scene.dispose()
      } catch (cleanupError) {
        if (primary !== undefined) {
          throw new AggregateError([primary, cleanupError],
            'the systemd-managed business scene failed and its Scene cleanup also failed')
        }
        throw cleanupError
      }
    }
  }
  if (primary !== undefined) throw primary
}

test(TEST_TITLE, async () => {
  const environment = requireSystemdEnvironment()
  const killPoint = process.env.SPLIT_VITEST_NATIVE_KILL_POINT
  await runScene(async scene => {
    assert.equal(scene.pair.policy, 'native', 'the Scene did not select the native pair policy')
    assert.equal(sha256File(scene.pair.old.path), scene.pair.old.sha256, 'the frozen old tarball changed before the Scene started')
    assert.equal(sha256File(scene.pair.new.path), scene.pair.new.sha256, 'the frozen new tarball changed before the Scene started')

    const oldProfile = await scene.installOldProfile()
    assert.equal(oldProfile.version, scene.pair.old.version, 'the old Profile version does not match the frozen pair')
    assert.equal(splitUpgradeSupport.installedPayloadHash(oldProfile.packageRoot), oldProfile.payloadHash,
      'the old Profile payload differs from the Supervisor install facts')
    assert.equal(splitUpgradeSupport.productionBuildId(oldProfile.packageRoot, scene.pair.targetDshVersion), oldProfile.buildId,
      'the old Profile build identity differs from the Supervisor install facts')

    // ── one real seed Host and durable Session ──────────────────────────────
    const seedHost = await scene.startHost({ source: 'profile', scenario: 'long-turn' })
    assert.equal(seedHost.generation, 1, 'the seed Host is not the first generation')
    assert.equal(seedHost.buildId, oldProfile.buildId, 'the seed Host does not run the old Profile build')
    const seedArtifacts = await hostArtifacts(scene, seedHost)
    const seedIdentity = seedArtifacts.identity
    assert.equal(seedIdentity.hostPid, seedHost.ready.pid, 'the seed Host identity does not name the started process')
    assert.equal(seedIdentity.buildId, oldProfile.buildId, 'the seed Host identity names another build')
    const seedPgid = seedHost.pgid
    assert.ok(Number.isInteger(seedPgid) && (seedPgid as number) > 0, 'the seed Host has no real process group')

    const seedClient = await scene.startClient({ source: 'profile', label: SEED_CLIENT })
    const seedClientPid = (await seedClient.businessPid())!
    assert.ok(Number.isInteger(seedClientPid) && seedClientPid > 0, 'the seed Client has no real business PID')
    await seedClient.submit(PROMPT)
    await waitForPaintedText(seedClient, PROMPT, 'the seed Client painted its prompt')
    const sessionId = (await waitForSurfaceSession(seedClient, 'the seed Client opened the Session')).openSessionId
    const held = await waitForC1Event(
      seedHost.workRoot,
      event => event.kind === 'long-turn-held' && event.sessionId === sessionId,
      'the seed Host held the durable Turn',
    )
    assert.equal(held.agentStatus, 'running', 'the held seed Turn is not running')
    const seededEventPrefixLength = durableEvents(scene, sessionId).length
    await scene.releaseHeldTurn(seedHost)
    await waitForC1Event(
      seedHost.workRoot,
      event => event.kind === 'long-turn-released' && event.sessionId === sessionId,
      'the seed Host released the durable Turn',
    )
    await waitForHostSessionEventAfter(scene, sessionId, seededEventPrefixLength,
      event => event.type === 'turn/end', 'the seed Turn settled durably')
    await waitForPaintedText(seedClient, ANSWER, 'the seed Client painted the completed answer')
    const seededEvents = durableEvents(scene, sessionId)
    assert.equal(userPromptCount(scene, sessionId, PROMPT), 1, 'the seed Session did not persist exactly one human prompt')
    assert.equal(turnEndCount(scene, sessionId), 1, 'the seed Session did not settle exactly one Turn')
    assert.ok(seededEvents.some(event => event.type === 'assistant/message' && JSON.stringify(event).includes(ANSWER)),
      'the seed Session persisted no assistant answer')
    await seedClient.close()
    await waitForPidGone(seedClientPid, 'the seed Client')
    const stoppedSeed = await scene.stopHost(seedHost)
    assert.deepEqual(stoppedSeed, { code: 0, signal: null, generation: 1 },
      'the seed Host did not stop through the official owner-governed path')
    await waitForPidGone(seedIdentity.hostPid, 'the seed Host')
    assert.equal(processGroupAlive(seedPgid), false, 'the seed Host process group is still visible')
    assert.equal(existsSync(join(seedArtifacts.scopeDir, 'instance.json')), false, 'the seed Host left its instance registry behind')
    assert.equal(existsSync(join(seedArtifacts.scopeDir, 'launch.json')), false, 'the seed Host left its launch material behind')

    // ── the official credential record and durable prefix ───────────────────
    const credentialsPath = writeSeededCredentialsStore(scene.installation.dshHome)
    const seededCredentials = credentialStoreFacts(credentialsPath)
    assert.ok(seededCredentials.seededBlockPreserved, 'the seeded credential record block is not readable')
    assert.deepEqual(seededCredentials.recordKeys, [CREDENTIAL_KEY], 'the seeded credential store carries unexpected records')
    const sessionPath = readSessionLogPath(scene, sessionId)

    // ── a loaded foreign unit at the target path must be refused untouched ──
    const targetUnitName = `dsh-pi-tui@pi-tui-${seedIdentity.scopeId.slice(0, 16)}.service`
    assert.match(targetUnitName, UNIT_NAME_PATTERN, 'the seed scope does not name the Profile unit')
    const targetUnitDir = join(environment.accountHome, '.config', 'systemd', 'user')
    const targetUnitPath = join(targetUnitDir, targetUnitName)
    assert.equal(existsSync(targetUnitPath), false, 'the target unit path is not absent before the foreign-unit control')
    mkdirSync(targetUnitDir, { recursive: true, mode: 0o700 })
    const foreignUnitText = [
      '[Unit]',
      'Description=Foreign qualification unit',
      '[Service]',
      'Type=oneshot',
      'ExecStart=/bin/true',
      'X-DshPiTuiOwner=local-host-manager-v1',
      `X-DshPiTuiScopeId=${'f'.repeat(64)}`,
      `X-DshPiTuiProfileIdentity=${'a'.repeat(64)}`,
      `X-DshPiTuiInstallBuild=${'b'.repeat(64)}`,
      '',
    ].join('\n')
    writeFileSync(targetUnitPath, foreignUnitText, { mode: 0o600 })
    const foreignBytes = readFileSync(targetUnitPath)
    const statBefore = lstatSync(targetUnitPath)
    const foreignShowArgs = ['show', targetUnitName, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'FragmentPath', '-p', 'MainPID']
    try {
      systemctlUser(['daemon-reload'], environment)
      const showBefore = systemctlUser(foreignShowArgs, environment)
      assert.match(showBefore, /LoadState=loaded/u, 'the foreign unit was not loaded')
      assert.match(showBefore, /ActiveState=inactive/u, 'the foreign unit is not inactive')
      assert.equal(readFileSync(targetUnitPath, 'utf8'), foreignUnitText, 'the foreign unit bytes changed before the refusal')
      await assert.rejects(scene.reserveManagedService(), (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        return message.includes('NATIVE_MANAGED_SERVICE_CONFLICT') || message.includes('not absent and not-loaded')
      })
      assert.deepEqual(readFileSync(targetUnitPath), foreignBytes, 'the refused foreign unit bytes changed')
      const statAfter = statSync(targetUnitPath)
      assert.equal(statAfter.dev, statBefore.dev, 'the refused foreign unit device changed')
      assert.equal(statAfter.ino, statBefore.ino, 'the refused foreign unit inode changed')
      assert.equal(statAfter.mode & 0o7777, statBefore.mode & 0o7777, 'the refused foreign unit mode changed')
      assert.equal(systemctlUser(foreignShowArgs, environment), showBefore, 'the refused foreign unit manager state changed')
    } finally {
      let removeForeign = false
      let cleanupError: unknown
      try {
        const current = lstatSync(targetUnitPath)
        removeForeign = current.dev === statBefore.dev
          && current.ino === statBefore.ino
          && (current.mode & 0o7777) === (statBefore.mode & 0o7777)
          && readFileSync(targetUnitPath).equals(foreignBytes)
        if (removeForeign) unlinkSync(targetUnitPath)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT') cleanupError = error
      }
      try {
        systemctlUser(['daemon-reload'], environment)
      } catch (reloadError) {
        if (cleanupError === undefined) throw reloadError
        throw new AggregateError([cleanupError, reloadError], 'the foreign unit cleanup and manager reload both failed')
      }
      if (cleanupError !== undefined) throw cleanupError
    }
    assert.equal(existsSync(targetUnitPath), false, 'the foreign unit was not removed')
    assert.match(systemctlUser(['show', targetUnitName, '-p', 'LoadState'], environment), /^LoadState=not-found$/mu,
      'the removed foreign unit is still loaded')

    // ── reserve the run-owned unit before any service write ─────────────────
    const reserved = await scene.reserveManagedService()
    assertObservation(reserved, {
      state: 'reserved-but-absent',
      file: 'absent',
      managerState: 'not-loaded',
      managerObserved: true,
      ownerVerified: false,
      mainPid: null,
      fileFacts: null,
      reason: null,
      authenticatedHostReady: false,
    }, 'the native service reservation')
    const reservation = reserved.reservation
    assert.equal(reservation.manager, 'systemd', 'the reservation selected another manager')
    assert.equal(reservation.uid, environment.uid, 'the reservation carries another uid')
    assert.equal(reservation.accountHome, environment.accountHome, 'the reservation carries another account home')
    assert.equal(reservation.profile, 'pi-tui', 'the reservation carries another profile')
    assert.equal(reservation.profileRealpath, realpathSync(scene.installation.profileDir),
      'the reservation profile realpath is not the Scene profile')
    assert.equal(reservation.dshHome, realpathSync(scene.installation.dshHome),
      'the reservation DSH home is not the Scene DSH home')
    assert.equal(reservation.scopeId, seedIdentity.scopeId, 'the reservation changed the seed Host scope')
    assert.equal(reservation.oldBuildId, oldProfile.buildId, 'the reservation old build is not the installed old build')
    assert.equal(reservation.sceneId, scene.sceneId, 'the reservation belongs to another Scene')
    assert.match(reservation.unitName, UNIT_NAME_PATTERN, 'the reservation unit name is not the Profile unit')
    assert.equal(reservation.unitName, targetUnitName, 'the reservation target changed after the foreign-unit control')
    assert.equal(reservation.unitPath, targetUnitPath, 'the reservation did not return to the controlled target path')

    const cold = readDaemon(await scene.runProfileDaemon('status'), {
      host: 'stopped',
      manager: 'unmanaged',
      unit: 'none',
      userManager: 'not-checked',
      compatibility: 'none',
    }, 'cold status before the old unit install')
    assert.equal(cold.pid, undefined, 'a stopped Profile published a PID')
    const installed = readDaemon(await scene.runProfileDaemon('install'), {
      host: 'stopped',
      manager: 'unmanaged',
    }, 'the old unit install')
    const unitName = installed.unit
    assert.match(unitName, UNIT_NAME_PATTERN, `the managed unit name is not the Profile unit: ${String(unitName)}`)
    const unitPath = join(environment.accountHome, '.config', 'systemd', 'user', unitName)
    assert.equal(unitPath, reservation.unitPath, 'the installed unit path differs from the reservation')
    assert.ok(existsSync(unitPath), 'daemon install did not create the Profile unit')
    assert.equal(statSync(unitPath).mode & 0o777, 0o600, 'the generated managed unit must be created 0600')
    const installedSnapshot = await scene.verifyManagedService()
    assertObservation(installedSnapshot, {
      state: 'installed-inactive',
      file: 'owned',
      managerState: 'inactive',
      managerObserved: true,
      ownerVerified: true,
      mainPid: null,
      activeState: 'inactive',
      loadState: 'loaded',
      authenticatedHostReady: false,
    }, 'the installed inactive unit')
    assertUnitFile(installedSnapshot.observation, reservation, oldProfile.buildId, 'the installed old unit')
    const installedRaw = await systemdManager.inspectManagedService(reservation)
    assert.equal(installedRaw.file, 'owned', 'the direct helper did not observe the installed unit')
    assert.equal(installedRaw.ownerVerified, true, 'the direct helper did not verify the installed unit owner')
    assert.equal(installedRaw.fileFacts?.installBuild, oldProfile.buildId, 'the direct helper saw another install build')
    assert.equal(installedRaw.mainPid, null, 'daemon install started a Host')
    const unitTextBefore = unitText(unitPath)
    const unitModeBefore = statSync(unitPath).mode & 0o7777
    const oldExecStart = installedRaw.fileFacts?.execStart ?? null
    const oldUnitSha = installedRaw.fileFacts?.sha256
    assert.ok(oldUnitSha !== undefined, 'the installed unit carries no SHA')
    const stableProfileEntry = join(realpathSync(scene.installation.profileDir),
      'node_modules', '@xmoon76', 'dsh-pi-tui', 'dist', 'local-host.mjs')
    const oldEntryIsStable = typeof oldExecStart === 'string' && oldExecStart.includes(stableProfileEntry)

    if (killPoint === KILL_INSTALL) {
      await scene.report('native-kill-ready', { point: KILL_INSTALL, worker: workerKillIdentity() })
      await waitForExternalKill(KILL_INSTALL)
    }

    // ── the old managed Host is a real systemd unit ─────────────────────────
    const started = readDaemon(await scene.runProfileDaemon('start'), {
      host: 'ready',
      manager: 'systemd',
      userManager: 'available',
      unit: unitName,
      unitState: 'active',
      compatibility: 'compatible',
    }, 'the old managed start')
    const oldHostPid = started.pid
    assert.ok(Number.isInteger(oldHostPid) && (oldHostPid as number) > 0, 'the old managed start published no Host PID')
    const activeOld = await scene.verifyManagedService()
    assertObservation(activeOld, {
      state: 'managed-active',
      file: 'owned',
      managerState: 'active',
      managerObserved: true,
      ownerVerified: true,
      mainPid: oldHostPid,
      activeState: 'active',
      loadState: 'loaded',
    }, 'the old managed active unit')
    assertUnitFile(activeOld.observation, reservation, oldProfile.buildId, 'the active old unit')
    const activeOldRaw = await systemdManager.inspectManagedService(reservation)
    assert.equal(activeOldRaw.mainPid, oldHostPid, 'systemctl show MainPID is not the authenticated Host PID')
    assert.equal(activeOldRaw.fragmentPath, realpathSync(unitPath), 'systemctl show FragmentPath is not the profile unit')

    const oldClient = await scene.startClient({ source: 'profile', label: OLD_CLIENT, sessionId })
    const oldClientPid = (await oldClient.businessPid())!
    assert.ok(Number.isInteger(oldClientPid) && oldClientPid > 0, 'the old managed Client has no real business PID')
    const oldHost = await waitForClientHostIdentity(oldClient, 'the old managed Client')
    assert.equal(oldHost.buildId, oldProfile.buildId, 'the old managed Host published another build')
    assert.equal(oldHost.hostPid, oldHostPid, 'the old managed status PID is not the authenticated Host PID')
    assert.equal(oldHost.scopeId, reservation.scopeId, 'the old managed Host changed the profile scope')
    assert.ok(typeof oldHost.instanceId === 'string' && oldHost.instanceId !== '', 'the old managed Host has no instance identity')
    assert.ok(oldHost.hostStarttime !== undefined && oldHost.hostStarttime !== null, 'the old managed Host has no kernel starttime')
    await waitForPaintedText(oldClient, PROMPT, 'the old managed Client painted the durable prompt')
    const oldSession = await waitForSurfaceSession(oldClient, 'the old managed Client opened the durable Session')
    assert.equal(oldSession.openSessionId, sessionId, 'the old managed Client opened another Session')
    await assertCredentialReadback(oldClient, 'the old managed Client')
    const activeWithClient = await scene.verifyManagedService()
    assertObservation(activeWithClient, {
      state: 'managed-active',
      mainPid: oldHostPid,
      authenticatedHostReady: true,
      authenticatedHostPid: oldHostPid,
    }, 'the old managed Host with its Client attached')

    if (killPoint === KILL_CLIENT_ATTACHED) {
      await scene.report('native-kill-ready', { point: KILL_CLIENT_ATTACHED, worker: workerKillIdentity() })
      await waitForExternalKill(KILL_CLIENT_ATTACHED)
    }

    await oldClient.submit('/exit')
    assert.deepEqual(await oldClient.waitForExit(120_000), { code: 0, signal: null },
      'the old managed Client /exit was not a clean terminal exit')
    await oldClient.close()
    await waitForPidGone(oldClientPid, 'the old managed Client')
    const oldReadbackStatus = readDaemon(await scene.runProfileDaemon('status'), {
      host: 'ready',
      manager: 'systemd',
      unit: unitName,
      unitState: 'active',
      compatibility: 'compatible',
    }, 'the status after the old managed Client exit')
    assert.equal(oldReadbackStatus.pid, oldHostPid, 'the old managed Host did not survive its Client exit')
    const oldReadbackEvents = durableEvents(scene, sessionId)
    assert.equal(userPromptCount(scene, sessionId, PROMPT), 1, 'the old managed readback duplicated the durable prompt')
    assertEventPrefix(oldReadbackEvents, seededEvents, 'the old managed readback')
    assertNoHistoryAppended(oldReadbackEvents, seededEvents.length, 'the old managed readback')
    const sessionShaAfterOldRead = sha256File(sessionPath)
    const credentialsAfterOldRead = assertCredentialStorePreserved(credentialsPath, undefined, 'the old managed readback')
    const credentialKeysAfterOldRead = credentialsAfterOldRead.recordKeys
    assert.ok(credentialKeysAfterOldRead.includes(CREDENTIAL_KEY), 'the old managed readback lost the seeded credential record')

    // ── install the new package while the old Host keeps running ────────────
    const newProfile = await scene.installManagedProfile('new')
    assert.equal(newProfile.version, scene.pair.new.version, 'the new Profile install carries another version')
    assert.notEqual(newProfile.buildId, oldProfile.buildId, 'both packaged builds produced the same production buildId')
    assert.equal(splitUpgradeSupport.productionBuildId(newProfile.packageRoot, scene.pair.targetDshVersion), newProfile.buildId,
      'the new Profile build identity differs from the Supervisor install facts')
    assert.equal(splitUpgradeSupport.installedPayloadHash(newProfile.packageRoot), newProfile.payloadHash,
      'the new Profile payload differs from its own install receipt')
    const statusAfterNewInstall = readDaemon(await scene.runProfileDaemon('status'), {
      host: 'ready',
      manager: 'systemd',
      unit: unitName,
      unitState: 'active',
      compatibility: 'other-build',
    }, 'status with the old Host under the new install')
    assert.equal(statusAfterNewInstall.pid, oldHostPid, 'the official package install replaced the old Host instance')
    assert.equal(unitText(unitPath), unitTextBefore, 'the new Profile install rewrote the old managed unit')
    assert.equal(statSync(unitPath).mode & 0o7777, unitModeBefore, 'the new Profile install changed the managed unit mode')
    const newInstallSnapshot = await scene.verifyManagedService()
    assertObservation(newInstallSnapshot, {
      state: 'managed-active',
      mainPid: oldHostPid,
      authenticatedHostReady: true,
      authenticatedHostPid: oldHostPid,
    }, 'the old managed Host under the new install')
    assert.equal(sha256File(sessionPath), sessionShaAfterOldRead,
      'the new Profile install changed the durable Session bytes')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the new Profile install')

    // ── explicit restart adopts the new install ────────────────────────────
    const restarted = readDaemon(await scene.runProfileDaemon('restart'), {
      host: 'ready',
      manager: 'systemd',
      userManager: 'available',
      unit: unitName,
      unitState: 'active',
      compatibility: 'compatible',
    }, 'the new managed restart')
    const newHostPid = restarted.pid
    assert.ok(Number.isInteger(newHostPid) && (newHostPid as number) > 0, 'the new managed start published no Host PID')
    assert.notEqual(newHostPid, oldHostPid, 'the new managed Host reused the old PID')
    await waitForPidGone(oldHostPid as number, 'the old managed Host after restart')
    const restartedSnapshot = await scene.verifyManagedService()
    assertObservation(restartedSnapshot, {
      state: 'managed-active',
      mainPid: newHostPid,
      ownerVerified: true,
    }, 'the new managed active unit')
    const restartedRaw = await systemdManager.inspectManagedService(reservation)
    assert.equal(restartedRaw.mainPid, newHostPid, 'the new systemctl MainPID is not the authenticated Host PID')
    assert.equal(restartedRaw.fragmentPath, realpathSync(unitPath), 'the new FragmentPath is not the profile unit')
    const unitTextAfterRestart = unitText(unitPath)
    const unitModeAfterRestart = statSync(unitPath).mode & 0o7777
    assert.equal(unitModeAfterRestart, unitModeBefore, 'the explicit restart changed the managed unit mode')
    if (oldEntryIsStable) {
      assert.equal(restartedRaw.fileFacts?.sha256, oldUnitSha, 'an already stable entry was rewritten by the restart')
      assert.equal(restartedRaw.fileFacts?.installBuild, oldProfile.buildId,
        'historical install-build provenance changed without a necessary entry migration')
      assert.equal(unitTextAfterRestart, unitTextBefore, 'an already stable unit changed bytes on the restart')
    } else {
      assert.notEqual(restartedRaw.fileFacts?.sha256, oldUnitSha, 'the generated legacy entry was not migrated by the explicit restart')
      assert.equal(restartedRaw.fileFacts?.installBuild, newProfile.buildId,
        'the migrated unit install build is not the newly installed build')
      assert.ok(typeof restartedRaw.fileFacts?.execStart === 'string'
        && restartedRaw.fileFacts.execStart.includes(stableProfileEntry),
      'the migrated ExecStart does not launch the stable Profile entry')
      assert.equal(stripGeneratedUnitFields(unitTextAfterRestart), stripGeneratedUnitFields(unitTextBefore),
        'the explicit restart changed user-owned unit content outside the generated fields')
    }
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the new managed restart')
    assert.equal(sha256File(sessionPath), sessionShaAfterOldRead, 'the new managed restart changed the durable Session bytes')

    // ── two independent Clients attach to the new managed Host ──────────────
    const newClientA = await scene.startClient({ source: 'profile', label: NEW_CLIENT_A, sessionId })
    const newClientB = await scene.startClient({ source: 'profile', label: NEW_CLIENT_B })
    const newAPid = (await newClientA.businessPid())!
    const newBPid = (await newClientB.businessPid())!
    assert.ok(Number.isInteger(newAPid) && newAPid > 0, 'the new managed Client A has no real business PID')
    assert.ok(Number.isInteger(newBPid) && newBPid > 0, 'the new managed Client B has no real business PID')
    assert.notEqual(newAPid, newBPid, 'the two new managed Clients shared one business PID')
    const newHostA = await waitForClientHostIdentity(newClientA, 'the new managed Client A')
    const newHostB = await waitForClientHostIdentity(newClientB, 'the new managed Client B')
    assert.equal(newHostA.buildId, newProfile.buildId, 'the new managed Client A authenticated another build')
    assert.equal(newHostB.buildId, newProfile.buildId, 'the new managed Client B authenticated another build')
    assert.equal(newHostA.instanceId, newHostB.instanceId, 'the two new Clients attached to different Host instances')
    assert.equal(newHostA.scopeId, reservation.scopeId, 'the new managed Host changed the profile scope')
    assert.equal(newHostA.hostPid, newHostPid, 'the new managed Client A authenticated another Host PID')
    assert.notEqual(newHostA.instanceId, oldHost.instanceId, 'the new managed Host reused the old instance id')
    assert.notEqual(newHostA.hostStarttime, oldHost.hostStarttime, 'the new managed Host reused the old kernel starttime')
    const newSession = await waitForSurfaceSession(newClientA, 'the new managed Client A opened the durable Session')
    assert.equal(newSession.openSessionId, sessionId, 'the new managed Client A opened another Session')
    await waitForPaintedText(newClientA, PROMPT, 'the new managed Client A painted the durable prompt')
    await waitForPaintedText(newClientA, ANSWER, 'the new managed Client A painted the completed answer')
    const newReadEvents = durableEvents(scene, sessionId)
    assert.equal(userPromptCount(scene, sessionId, PROMPT), 1, 'the upgraded Host replayed or duplicated the durable prompt')
    assertEventPrefix(newReadEvents, seededEvents, 'the upgraded Host readback')
    assertNoHistoryAppended(newReadEvents, oldReadbackEvents.length, 'the upgraded Host readback')
    assert.equal(sha256File(sessionPath), sessionShaAfterOldRead,
      'the upgraded Host readback changed the durable Session bytes after the first managed resume')
    await assertCredentialReadback(newClientA, 'the new managed Client A')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the new managed readback')
    const twoClientStatus = readDaemon(await scene.runProfileDaemon('status'), {
      host: 'ready',
      manager: 'systemd',
      unit: unitName,
      unitState: 'active',
      compatibility: 'compatible',
    }, 'the status with two new managed Clients')
    assert.equal(twoClientStatus.pid, newHostPid, 'the new managed stage did not keep one Host PID')
    await newClientA.submit('/exit')
    assert.deepEqual(await newClientA.waitForExit(120_000), { code: 0, signal: null },
      'the new managed Client A /exit was not a clean terminal exit')
    await newClientA.close()
    await newClientB.submit('/exit')
    assert.deepEqual(await newClientB.waitForExit(120_000), { code: 0, signal: null },
      'the new managed Client B /exit was not a clean terminal exit')
    await newClientB.close()
    await waitForPidGone(newAPid, 'the new managed Client A')
    await waitForPidGone(newBPid, 'the new managed Client B')
    const afterNewClients = await scene.verifyManagedService()
    assertObservation(afterNewClients, {
      state: 'managed-active',
      mainPid: newHostPid,
      authenticatedHostReady: true,
      authenticatedHostPid: newHostPid,
    }, 'the new managed Host after both Clients exited')

    // ── stop the new build, then roll back through the official install ─────
    const stoppedNew = readDaemon(await scene.runProfileDaemon('stop'), {
      host: 'stopped',
      unitState: 'inactive',
    }, 'the new managed stop')
    assert.equal(stoppedNew.pid, undefined, 'the stopped new managed Host still published a PID')
    await waitForPidGone(newHostPid as number, 'the new managed Host')
    const stoppedNewSnapshot = await scene.verifyManagedService()
    assertObservation(stoppedNewSnapshot, {
      state: 'installed-inactive',
      file: 'owned',
      managerState: 'inactive',
      mainPid: null,
      activeState: 'inactive',
      authenticatedHostReady: false,
    }, 'the stopped new managed unit')
    assert.equal(unitText(unitPath), unitTextAfterRestart, 'the new managed stop rewrote the unit')
    assert.equal(sha256File(sessionPath), sessionShaAfterOldRead, 'the new managed stop changed the durable Session bytes')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the new managed stop')
    const rollback = await scene.installManagedProfile('old')
    assert.equal(rollback.version, scene.pair.old.version, 'the rollback Profile install carries another version')
    assert.equal(rollback.buildId, oldProfile.buildId, 'the rollback Profile install did not restore the old build')
    assert.equal(splitUpgradeSupport.productionBuildId(rollback.packageRoot, scene.pair.targetDshVersion), oldProfile.buildId,
      'the rollback Profile build identity differs from the Supervisor install facts')
    assert.equal(splitUpgradeSupport.installedPayloadHash(rollback.packageRoot), rollback.payloadHash,
      'the rollback Profile payload differs from its own install receipt')
    assert.equal(unitText(unitPath), unitTextAfterRestart, 'the rollback Profile install rewrote the managed unit')
    const rollbackStatus = readDaemon(await scene.runProfileDaemon('status'), {
      host: 'stopped',
      manager: 'unmanaged',
      unit: unitName,
      unitState: 'inactive',
      ...(oldEntryIsStable ? { compatibility: 'none' } : { compatibility: 'other-build' }),
    }, 'status with the installed old build and the inactive unit')
    assert.equal(rollbackStatus.pid, undefined, 'the rollback status published a Host PID')
    assert.equal(sha256File(sessionPath), sessionShaAfterOldRead, 'the rollback Profile install changed the durable Session bytes')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the rollback Profile install')

    const rollbackStarted = readDaemon(await scene.runProfileDaemon('restart'), {
      host: 'ready',
      manager: 'systemd',
      userManager: 'available',
      unit: unitName,
      unitState: 'active',
      compatibility: 'compatible',
    }, 'the rollback managed restart')
    const rollbackHostPid = rollbackStarted.pid
    assert.ok(Number.isInteger(rollbackHostPid) && (rollbackHostPid as number) > 0, 'the rollback restart published no Host PID')
    assert.notEqual(rollbackHostPid, newHostPid, 'the rollback Host reused the new Host PID')
    assert.equal(unitText(unitPath), unitTextAfterRestart, 'the rollback restart rewrote an already stable unit')
    const rollbackSnapshot = await scene.verifyManagedService()
    assertObservation(rollbackSnapshot, {
      state: 'managed-active',
      mainPid: rollbackHostPid,
      ownerVerified: true,
    }, 'the rollback managed active unit')
    const rollbackRaw = await systemdManager.inspectManagedService(reservation)
    assert.equal(rollbackRaw.mainPid, rollbackHostPid, 'the rollback systemctl MainPID is not the authenticated Host PID')

    const rollbackClient = await scene.startClient({ source: 'profile', label: ROLLBACK_CLIENT, sessionId })
    const rollbackClientPid = (await rollbackClient.businessPid())!
    assert.ok(Number.isInteger(rollbackClientPid) && rollbackClientPid > 0, 'the rollback Client has no real business PID')
    const rollbackHost = await waitForClientHostIdentity(rollbackClient, 'the rollback Client')
    assert.equal(rollbackHost.buildId, oldProfile.buildId, 'the rollback Host published another build')
    assert.equal(rollbackHost.hostPid, rollbackHostPid, 'the rollback Host PID is not the authenticated Host PID')
    assert.equal(rollbackHost.scopeId, reservation.scopeId, 'the rollback Host changed the profile scope')
    assert.notEqual(rollbackHost.instanceId, newHostA.instanceId, 'the rollback Host reused the new instance id')
    const rollbackSession = await waitForSurfaceSession(rollbackClient, 'the rollback Client opened the durable Session')
    assert.equal(rollbackSession.openSessionId, sessionId, 'the rollback Client opened another Session')
    await waitForPaintedText(rollbackClient, PROMPT, 'the rollback Client painted the durable prompt')
    await waitForPaintedText(rollbackClient, ANSWER, 'the rollback Client painted the completed answer')
    await assertCredentialReadback(rollbackClient, 'the rollback Client')
    const rollbackEvents = durableEvents(scene, sessionId)
    assert.equal(userPromptCount(scene, sessionId, PROMPT), 1, 'the rollback Host replayed or duplicated the durable prompt')
    assertEventPrefix(rollbackEvents, seededEvents, 'the rollback Host readback')
    assertNoHistoryAppended(rollbackEvents, newReadEvents.length, 'the rollback Host readback')
    assert.equal(sha256File(sessionPath), sessionShaAfterOldRead,
      'the rollback Host readback changed the durable Session bytes after the first managed resume')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the rollback Host readback')
    await rollbackClient.submit('/exit')
    assert.deepEqual(await rollbackClient.waitForExit(120_000), { code: 0, signal: null },
      'the rollback Client /exit was not a clean terminal exit')
    await rollbackClient.close()
    await waitForPidGone(rollbackClientPid, 'the rollback Client')
    const afterRollbackClient = await scene.verifyManagedService()
    assertObservation(afterRollbackClient, {
      state: 'managed-active',
      mainPid: rollbackHostPid,
      authenticatedHostReady: true,
      authenticatedHostPid: rollbackHostPid,
    }, 'the rollback Host after its Client exited')

    // ── official stop and uninstall leave no service or run-owned Host ──────
    const stoppedRollback = readDaemon(await scene.runProfileDaemon('stop'), {
      host: 'stopped',
      unitState: 'inactive',
    }, 'the rollback managed stop')
    assert.equal(stoppedRollback.pid, undefined, 'the stopped rollback Host still published a PID')
    await waitForPidGone(rollbackHostPid as number, 'the rollback Host')
    const stoppedRollbackSnapshot = await scene.verifyManagedService()
    assertObservation(stoppedRollbackSnapshot, {
      state: 'installed-inactive',
      file: 'owned',
      managerState: 'inactive',
      mainPid: null,
      activeState: 'inactive',
      authenticatedHostReady: false,
    }, 'the stopped rollback managed unit')
    const uninstalled = readDaemon(await scene.runProfileDaemon('uninstall'), {
      host: 'stopped',
      unit: 'none',
      unitState: 'not-found',
    }, 'the closing rollback uninstall')
    assert.equal(uninstalled.pid, undefined, 'the closing uninstall published a Host PID')
    assert.equal(existsSync(unitPath), false, 'the closing uninstall did not remove the rollback unit')
    const removedSnapshot = await scene.verifyManagedService()
    assertObservation(removedSnapshot, {
      state: 'removed',
      file: 'absent',
      managerState: 'not-loaded',
      managerObserved: true,
      ownerVerified: false,
      mainPid: null,
      fileFacts: null,
      authenticatedHostReady: false,
    }, 'the removed managed unit')
    const removedRaw = await systemdManager.inspectManagedService(reservation)
    assert.equal(removedRaw.file, 'absent', 'the direct helper still sees a unit file after uninstall')
    assert.equal(removedRaw.managerState, 'not-loaded', 'the manager still loads the removed unit')
    assert.ok(existsSync(scene.installation.profileDir), 'the closing uninstall removed the Profile')
    assert.ok(existsSync(credentialsPath), 'the closing uninstall removed the credential store')
    assert.ok(existsSync(sessionPath), 'the closing uninstall removed the Session log')
    assert.equal(sha256File(sessionPath), sessionShaAfterOldRead, 'the closing uninstall changed the durable Session bytes')
    assertCredentialStorePreserved(credentialsPath, credentialKeysAfterOldRead, 'the closing uninstall')

    await scene.finish()
    assert.equal(sha256File(scene.pair.old.path), scene.pair.old.sha256, 'the frozen old tarball changed during the Scene')
    assert.equal(sha256File(scene.pair.new.path), scene.pair.new.sha256, 'the frozen new tarball changed during the Scene')
    const receiptDir = join(environment.tmpBase, 'split-resources')
    const receiptName = readdirSync(receiptDir)
      .find(name => name.endsWith(`-${scene.sceneId}.json`))
    assert.ok(receiptName !== undefined, 'the Supervisor wrote no final receipt for this Scene')
    const finalReceipt = JSON.parse(readFileSync(join(receiptDir, receiptName), 'utf8')) as Record<string, any>
    assert.equal(finalReceipt.phase, 'FINALIZED', 'the Supervisor did not reach FINALIZED')
    assert.equal(finalReceipt.native?.reservation?.unitPath, unitPath, 'the final receipt names another managed unit')
    assert.equal(finalReceipt.native?.observed?.state, 'removed', 'the final receipt did not confirm the managed service removed')
    assert.equal(finalReceipt.native?.cleanup?.attempted, true, 'the native cleanup was not attempted')
    assert.equal(existsSync(scene.workRoot), false, 'the Scene root still exists after FINALIZE')
    assert.equal(pidAlive(rollbackHostPid as number), false, 'the rollback Host survived the final cleanup')
  })
}, TEST_TIMEOUT_MS)
