/**
 * Simulated-manager contract for the native managed-service upgrade bridge.
 *
 * These cases never touch a real systemd/launchd manager and never load a
 * platform helper: they drive the SAME shared classifier, reservation,
 * ownership and daemon-CLI primitives the Split Supervisor uses, from fake raw
 * OS observations to a decision, a mutation spy and a durable receipt. Passing
 * here is contract evidence (L1), never a real native L6 qualification.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/split-upgrade-native-contract.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { npmDshVersion } from '../../scripts/lib/dsh-distribution.mjs'
import {
  applyServiceObservation,
  assertManagedReservationObservable,
  assertManagedReservationScene,
  assertNativeManagedProfileInstall,
  buildNativeDaemonEnvironment,
  buildReservationFacts,
  classifyCurrentProfile,
  classifyManagedInspection,
  classifyNativeCleanup,
  classifyNativeClientOwnership,
  combineNativeFailures,
  LAUNCHD_CUSTOMIZATION,
  loadNativeManagerAdapter,
  MANAGED_DAEMON_OUTPUT_LIMIT_BYTES,
  nativeBootstrapAdmission,
  nativeManagerHelperPath,
  nativeReservationRecord,
  NATIVE_MANAGER_HELPER_FILES,
  allowNativeMutation,
  parseManagedDaemonStatus,
  planNativeCleanup,
  requireLaunchdCustomization,
  requireManagedDaemonVerb,
  runFixedDaemonVerb,
  sanitizeDaemonOutput,
  serializeKernelIdentity,
  validateManagerInspection,
  validateReservationFacts,
} from '../support/split-upgrade-native-contract.mjs'
import {
  inspectSplitUpgradePair,
  UPGRADE_PACKAGE_NAME,
} from '../support/split-upgrade-pair.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const TARGET_PIN = npmDshVersion()
const DSH_AGENT = '@deepseek-ai/dsh-agent'
const BUILD_A = 'a'.repeat(64)
const BUILD_B = 'b'.repeat(64)
const PAYLOAD_A = 'c'.repeat(64)
const PAYLOAD_B = 'd'.repeat(64)
const SCOPED = 'scope-0123456789abcdef-0123456789abcdef0123456789abcdef'

function expectContractError(run, code) {
  assert.throws(run, error => {
    assert.equal(error?.name, 'NativeContractError')
    assert.equal(error?.code, code)
    return true
  })
}

function pair(overrides = {}) {
  return {
    old: { path: '/tmp/old.tgz', version: '0.5.8', sha256: '1'.repeat(64), manifestPin: TARGET_PIN },
    new: { path: '/tmp/new.tgz', version: '0.5.8', sha256: '2'.repeat(64), manifestPin: TARGET_PIN },
    targetDshVersion: TARGET_PIN,
    policy: 'native',
    ...overrides,
  }
}

function installed(overrides = {}) {
  return {
    packageRoot: '/tmp/pnpm/profile/node_modules/@xmoon76/dsh-pi-tui',
    version: '0.5.8',
    buildId: BUILD_B,
    payloadHash: PAYLOAD_B,
    entries: {
      host: '/tmp/pnpm/profile/node_modules/@xmoon76/dsh-pi-tui/dist/local-host.mjs',
      client: '/tmp/pnpm/profile/node_modules/@xmoon76/dsh-pi-tui/dist/local-client.mjs',
    },
    ...overrides,
  }
}

function reservationInput(overrides = {}) {
  return {
    manager: 'systemd',
    uid: 501,
    accountHome: '/Users/tester',
    profileRealpath: '/tmp/dsh-home/profiles/pi-tui',
    dshHome: '/tmp/dsh-home',
    scopeId: SCOPED,
    oldBuildId: BUILD_A,
    sceneId: 'scene-1',
    parentRunId: 'run-1',
    ...overrides,
  }
}

function reservation(overrides = {}) {
  return buildReservationFacts(reservationInput(overrides))
}

function rawInspection(overrides = {}) {
  return {
    file: 'absent',
    managerState: 'not-loaded',
    ownerVerified: false,
    managerObserved: true,
    unitName: 'dsh-pi-tui@pi-tui-0123456789abcdef.service',
    unitPath: '/Users/tester/.config/systemd/user/dsh-pi-tui@pi-tui-0123456789abcdef.service',
    fragmentPath: null,
    sourcePath: null,
    mainPid: null,
    loadState: null,
    activeState: null,
    unitFileState: null,
    jobState: null,
    fileFacts: null,
    reason: null,
    ...overrides,
  }
}

function ownedFileFacts(overrides = {}) {
  return {
    mode: 0o600,
    sha256: 'e'.repeat(64),
    device: '16777220',
    inode: '1234567',
    owner: 'local-host-manager-v1',
    scopeId: SCOPED,
    profileIdentity: 'f'.repeat(64),
    installBuild: BUILD_A,
    execStart: '"/usr/bin/node" "/tmp/dsh-home/profiles/pi-tui/node_modules/@xmoon76/dsh-pi-tui/dist/local-host.mjs"',
    programArguments: null,
    nonGeneratedSha256: null,
    ...overrides,
  }
}

function absentObservation(facts, history = { everObservedInstalled: false }) {
  return classifyManagedInspection({
    reservation: facts,
    history,
    inspection: rawInspection({ unitName: facts.unitName, unitPath: facts.unitPath }),
    verifiedAt: '2026-11-23T00:00:00.000Z',
  })
}

function ownedInspection(facts, overrides = {}) {
  return rawInspection({
    file: 'owned',
    managerState: 'inactive',
    ownerVerified: true,
    managerObserved: true,
    unitName: facts.unitName,
    unitPath: facts.unitPath,
    fragmentPath: facts.unitPath,
    sourcePath: null,
    fileFacts: ownedFileFacts({ scopeId: facts.scopeId }),
    ...overrides,
  })
}

function activeObservation(facts, overrides = {}) {
  return classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection: ownedInspection(facts, {
      managerState: 'active',
      activeState: 'active',
      loadState: 'loaded',
      unitFileState: 'enabled',
      mainPid: 4242,
      ...overrides.inspection,
    }),
    kernel: overrides.kernel ?? { status: 'alive', uid: facts.uid },
    authenticatedHost: overrides.authenticatedHost ?? null,
    verifiedAt: '2026-11-23T00:00:00.000Z',
  })
}

function syntheticTarball(root, name, manifest) {
  const stage = join(root, `${name}-stage`)
  mkdirSync(join(stage, 'package'), { recursive: true })
  writeFileSync(join(stage, 'package', 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const path = join(root, `${name}.tgz`)
  const packed = spawnSync('tar', ['-czf', path, '-C', stage, 'package'], {
    encoding: 'utf8',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  })
  assert.equal(packed.status, 0, `the synthetic fixture could not be packed: ${packed.stderr}`)
  return path
}

// ── input / policy ──────────────────────────────────────────────────────────

test('a same-SemVer native pair is admitted by preflight only when its real build ids differ', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('native-contract-pair-')
  const manifest = version => ({
    name: UPGRADE_PACKAGE_NAME,
    version,
    devDependencies: { [DSH_AGENT]: TARGET_PIN },
  })
  const oldPath = syntheticTarball(root, 'old', manifest('0.5.8'))
  const newPath = syntheticTarball(root, 'new', manifest('0.5.8'))
  const qualified = inspectSplitUpgradePair(oldPath, newPath, { policy: 'native' })
  assert.equal(qualified.policy, 'native')
  assert.equal(qualified.old.version, qualified.new.version)
  assert.ok(qualified.old.sha256 !== qualified.new.sha256)
  // The same artifact bytes under the default policy stay refused.
  assert.throws(() => inspectSplitUpgradePair(oldPath, newPath),
    error => error?.code === 'INPUT_PAIR_SAME_VERSION')

  // The pair preflight is NOT a build identity: the real installed build gate
  // must reject the same production build id and admit a different one.
  const facts = pair(qualified)
  expectContractError(() => assertNativeManagedProfileInstall({
    role: 'new',
    pair: facts,
    oldBuildId: BUILD_A,
    installed: installed({ buildId: BUILD_A }),
  }), 'INPUT_PAIR_BUILD_ID_EQUAL')
  const admitted = assertNativeManagedProfileInstall({
    role: 'new',
    pair: facts,
    oldBuildId: BUILD_A,
    installed: installed({ buildId: BUILD_B }),
  })
  assert.equal(admitted.buildId, BUILD_B)
})

test('a rollback install must restore the exact old production build id', () => {
  expectContractError(() => assertNativeManagedProfileInstall({
    role: 'old',
    pair: pair(),
    oldBuildId: BUILD_A,
    installed: installed({ buildId: BUILD_B }),
  }), 'NATIVE_ROLLBACK_BUILD_MISMATCH')
  const admitted = assertNativeManagedProfileInstall({
    role: 'old',
    pair: pair(),
    oldBuildId: BUILD_A,
    installed: installed({ buildId: BUILD_A }),
  })
  assert.equal(admitted.buildId, BUILD_A)
})

// ── manager / platform admission ───────────────────────────────────────────

test('a default bootstrap admission never selects a native manager', () => {
  assert.deepEqual(nativeBootstrapAdmission({ policy: 'default' }), { native: false, manager: null })
  expectContractError(() => nativeBootstrapAdmission({ policy: 'default', manager: 'systemd' }), 'INPUT_UNQUALIFIED')
  expectContractError(() => nativeBootstrapAdmission({ policy: 'forced' }), 'INPUT_UNQUALIFIED')
  expectContractError(() => nativeBootstrapAdmission({ policy: 'native', manager: 'upstart', platform: 'linux', uid: 501 }), 'NATIVE_MANAGER_KIND_INVALID')
})

test('a native bootstrap admission requires the matching platform and a non-root uid', () => {
  assert.deepEqual(
    nativeBootstrapAdmission({ policy: 'native', manager: 'systemd', platform: 'linux', uid: 501 }),
    { native: true, manager: 'systemd' },
  )
  expectContractError(() => nativeBootstrapAdmission({ policy: 'native', manager: 'systemd', platform: 'darwin', uid: 501 }),
    'NATIVE_MANAGER_PLATFORM_MISMATCH')
  expectContractError(() => nativeBootstrapAdmission({ policy: 'native', manager: 'launchd', platform: 'linux', uid: 501 }),
    'NATIVE_MANAGER_PLATFORM_MISMATCH')
  expectContractError(() => nativeBootstrapAdmission({ policy: 'native', manager: 'systemd', platform: 'linux', uid: 0 }),
    'NATIVE_MANAGER_UID_UNQUALIFIED')
  expectContractError(() => nativeBootstrapAdmission({ policy: 'native', manager: 'systemd', platform: 'linux' }),
    'NATIVE_MANAGER_UID_UNQUALIFIED')
})

test('a missing or malformed platform helper is refused before any native side effect', async () => {
  const manager = 'systemd'
  const expectedUrl = pathToFileURL(nativeManagerHelperPath(manager)).href
  const imported = []
  await assert.rejects(
    loadNativeManagerAdapter(manager, {
      importModule: async url => {
        imported.push(url)
        const error = new Error('Cannot find module')
        error.code = 'ERR_MODULE_NOT_FOUND'
        throw error
      },
    }),
    error => error?.code === 'NATIVE_MANAGER_ADAPTER_UNAVAILABLE',
  )
  assert.deepEqual(imported, [expectedUrl], 'only the fixed helper path may be imported')

  // The test never asks the loader for launchd here: its fixed path is still
  // the frozen ABI this bridge will load once the platform PR provides it.
  assert.equal(NATIVE_MANAGER_HELPER_FILES.launchd, 'split-upgrade-launchd-manager.mjs')
})

test('a platform helper must expose exactly the frozen exports', async () => {
  const inspect = async () => rawInspection()
  const reclaim = async () => ({ clean: true, action: 'removed', reason: 'test', observation: rawInspection() })
  const customize = async () => ({ fileIdentity: null, observation: rawInspection() })
  const load = module => loadNativeManagerAdapter('launchd', { importModule: async () => module })

  await assert.rejects(load({ inspectManagedService: inspect }), error => error?.code === 'NATIVE_MANAGER_ADAPTER_INVALID')
  await assert.rejects(load({ inspectManagedService: inspect, reclaimManagedService: reclaim }),
    error => error?.code === 'NATIVE_MANAGER_ADAPTER_INVALID')
  const adapter = await load({ inspectManagedService: inspect, reclaimManagedService: reclaim, customizeManagedService: customize })
  assert.deepEqual(Object.keys(adapter).sort(), ['customizeManagedService', 'inspectManagedService', 'manager', 'reclaimManagedService'])
  assert.equal(typeof adapter.inspectManagedService, 'function')

  // A systemd helper must never carry the launchd-only mutation capability.
  await assert.rejects(
    loadNativeManagerAdapter('systemd', {
      importModule: async () => ({ inspectManagedService: inspect, reclaimManagedService: reclaim, customizeManagedService: customize }),
    }),
    error => error?.code === 'NATIVE_MANAGER_ADAPTER_INVALID',
  )
})

// ── reservation ────────────────────────────────────────────────────────────

test('reservation facts derive the fixed unit path from the real account home and scope', () => {
  const systemd = reservation()
  assert.equal(systemd.manager, 'systemd')
  assert.equal(systemd.profile, 'pi-tui')
  assert.equal(systemd.unitName, 'dsh-pi-tui@pi-tui-scope-0123456789.service')
  assert.equal(systemd.unitPath, '/Users/tester/.config/systemd/user/dsh-pi-tui@pi-tui-scope-0123456789.service')
  const launchd = reservation({
    manager: 'launchd',
    accountHome: '/Users/tester',
  })
  assert.equal(launchd.unitName, 'com.xmoon.dsh-pi-tui.scope-0123456789abcdef-0123456789abcdef0')
  assert.equal(launchd.unitPath, '/Users/tester/Library/LaunchAgents/com.xmoon.dsh-pi-tui.scope-0123456789abcdef-0123456789abcdef0.plist')
  assert.deepEqual(validateReservationFacts(systemd), systemd)
})

test('a forged reservation uid, home or unit path never reaches a manager', () => {
  const facts = reservation()
  expectContractError(() => validateReservationFacts({ ...facts, uid: 0 }), 'NATIVE_MANAGER_UID_UNQUALIFIED')
  expectContractError(() => validateReservationFacts({ ...facts, unitPath: '/Users/tester/Library/LaunchAgents/other.plist' }),
    'NATIVE_RESERVATION_INVALID')
  expectContractError(() => validateReservationFacts({ ...facts, profile: 'other' }), 'NATIVE_RESERVATION_INVALID')
  expectContractError(() => validateReservationFacts({ ...facts, accountHome: 'relative/home' }), 'NATIVE_CONTRACT_INVALID')
  // A forged unit name alone is refused even when the path is left untouched.
  expectContractError(() => validateReservationFacts({ ...facts, unitName: 'dsh-pi-tui@pi-tui-ffffffffffffffff.service' }),
    'NATIVE_RESERVATION_INVALID')
})

function sceneFacts(overrides = {}) {
  return {
    kind: 'upgrade',
    policy: 'native',
    manager: 'systemd',
    selectedManager: 'systemd',
    activeHost: false,
    hosts: [{ generation: 1, exited: true, exitCode: 0, exitSignal: null, groupGone: true }],
    seatFree: true,
    profileBuildIdMatch: true,
    ...overrides,
  }
}

test('a reservation is admitted only after the seed Host officially stopped and its seat was released', () => {
  assert.equal(assertManagedReservationScene(sceneFacts()).seed.generation, 1)
  expectContractError(() => assertManagedReservationScene(sceneFacts({ activeHost: true })), 'NATIVE_SEED_HOST_STILL_ACTIVE')
  expectContractError(() => assertManagedReservationScene(sceneFacts({ hosts: [] })), 'NATIVE_SEED_HOST_MISSING')
  expectContractError(() => assertManagedReservationScene(sceneFacts({
    hosts: [{ generation: 1, exited: false, exitCode: null, exitSignal: null, groupGone: true }],
  })), 'NATIVE_SEED_HOST_NOT_STOPPED')
  expectContractError(() => assertManagedReservationScene(sceneFacts({
    hosts: [{ generation: 1, exited: true, exitCode: 0, exitSignal: 'SIGTERM', groupGone: true }],
  })), 'NATIVE_SEED_HOST_NOT_STOPPED')
  expectContractError(() => assertManagedReservationScene(sceneFacts({
    hosts: [{ generation: 1, exited: true, exitCode: 0, exitSignal: null, groupGone: false }],
  })), 'NATIVE_HOST_GROUP_ALIVE')
  expectContractError(() => assertManagedReservationScene(sceneFacts({ seatFree: false })), 'NATIVE_HOST_SEAT_STILL_HELD')
  expectContractError(() => assertManagedReservationScene(sceneFacts({ profileBuildIdMatch: false })), 'NATIVE_OLD_BUILD_UNVERIFIED')
  expectContractError(() => assertManagedReservationScene(sceneFacts({ policy: 'default' })), 'NATIVE_RESERVATION_SCENE_INVALID')
  expectContractError(() => assertManagedReservationScene(sceneFacts({ manager: 'launchd' })), 'NATIVE_RESERVATION_SCENE_INVALID')
})

test('the pre-registration absence check refuses a present, loaded or unqueryable target', () => {
  const facts = reservation()
  assert.equal(assertManagedReservationObservable(rawInspection({ unitName: facts.unitName, unitPath: facts.unitPath })).file, 'absent')
  expectContractError(() => assertManagedReservationObservable(rawInspection({
    unitName: facts.unitName, unitPath: facts.unitPath, file: 'owned', managerState: 'inactive',
  })), 'NATIVE_MANAGED_SERVICE_CONFLICT')
  expectContractError(() => assertManagedReservationObservable(rawInspection({
    unitName: facts.unitName, unitPath: facts.unitPath, managerState: 'active',
  })), 'NATIVE_MANAGED_SERVICE_CONFLICT')
  expectContractError(() => assertManagedReservationObservable(rawInspection({
    unitName: facts.unitName, unitPath: facts.unitPath, file: 'foreign', managerState: 'not-loaded',
  })), 'NATIVE_MANAGED_SERVICE_CONFLICT')
  expectContractError(() => assertManagedReservationObservable(rawInspection({
    unitName: facts.unitName, unitPath: facts.unitPath, managerObserved: false,
  })), 'NATIVE_MANAGER_UNAVAILABLE')
})

test('the durable reservation is written before any native install and the ACK mirrors the receipt', async () => {
  const facts = reservation()
  const inspection = rawInspection({ unitName: facts.unitName, unitPath: facts.unitPath })
  const observation = classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: false },
    inspection,
    verifiedAt: '2026-11-23T00:00:00.000Z',
  })
  const order = []
  const mutations = []
  let durableRecord
  const adapter = {
    async inspectManagedService(received) {
      order.push('inspect')
      assert.deepEqual(received, facts)
      return inspection
    },
    async reclaimManagedService() {
      throw new Error('reclaim must never run during reservation')
    },
  }
  const writeDurable = async record => {
    order.push('receipt')
    durableRecord = record
  }
  const inspectionResult = await adapter.inspectManagedService(facts)
  assertManagedReservationObservable(inspectionResult)
  const record = nativeReservationRecord({ reservation: facts, observation })
  await writeDurable(record)
  const ack = { reservation: record.reservation, observation: record.observed }
  mutations.push('install')
  assert.deepEqual(order, ['inspect', 'receipt'])
  assert.deepEqual(ack.reservation, facts)
  assert.deepEqual(ack.observation, observation)
  assert.equal(record.lifecycle, 'reserved')
  assert.equal(record.everObservedInstalled, false)
  assert.equal(record.generation, 1)
  assert.equal(record.fileIdentity, null)
  assert.equal(record.lastOperation, null)
  assert.deepEqual(record.hostIdentities, [])
  assert.equal(record.cleanup, null)
  assert.equal(allowNativeMutation({ reservation: facts, observation, verb: 'install' }).allowed, true)
  assert.deepEqual(mutations, ['install'])
})

test('a conflicting managed target is refused before the durable receipt and before install', () => {
  const facts = reservation()
  const inspection = rawInspection({
    unitName: facts.unitName,
    unitPath: facts.unitPath,
    file: 'foreign',
    managerState: 'not-loaded',
  })
  expectContractError(() => assertManagedReservationObservable(inspection), 'NATIVE_MANAGED_SERVICE_CONFLICT')
  const order = []
  const durable = () => order.push('receipt')
  const mutations = []
  const run = () => {
    assertManagedReservationObservable(inspection)
    durable()
    mutations.push('install')
  }
  expectContractError(run, 'NATIVE_MANAGED_SERVICE_CONFLICT')
  assert.deepEqual(order, [])
  assert.deepEqual(mutations, [])
})

// ── fake manager state classification ──────────────────────────────────────

test('raw manager observations normalize into the five observation states from history', () => {
  const facts = reservation()
  assert.equal(absentObservation(facts).state, 'reserved-but-absent')
  assert.equal(absentObservation(facts, { everObservedInstalled: true }).state, 'removed')
  const inactive = classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection: ownedInspection(facts),
    verifiedAt: '2026-11-23T00:00:00.000Z',
  })
  assert.equal(inactive.state, 'installed-inactive')
  assert.equal(activeObservation(facts).state, 'managed-active')
})

test('ambiguous, foreign or unqueryable manager observations never become ownership', () => {
  const facts = reservation()
  const classify = (inspection, extra = {}) => classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection,
    verifiedAt: '2026-11-23T00:00:00.000Z',
    ...extra,
  })
  assert.equal(classify(ownedInspection(facts, { file: 'unverifiable' })).state, 'unverifiable')
  assert.equal(classify(ownedInspection(facts, { managerState: 'unknown' })).state, 'unverifiable')
  assert.equal(classify(ownedInspection(facts, { file: 'foreign' })).state, 'unverifiable')
  assert.equal(classify(ownedInspection(facts, { managerObserved: false })).state, 'unverifiable')
  assert.equal(classify(rawInspection({ unitName: facts.unitName, unitPath: facts.unitPath, managerObserved: false })).state,
    'unverifiable', 'an unqueryable manager never turns an absent file into a truthful reservation/removal')
  assert.equal(classify(ownedInspection(facts, { ownerVerified: false })).state, 'unverifiable')
  assert.equal(classify(ownedInspection(facts, { unitName: 'dsh-pi-tui@pi-tui-ffffffffffffffff.service' })).state, 'unverifiable')
  assert.equal(classify(ownedInspection(facts, { fileFacts: ownedFileFacts({ scopeId: 'another-scope' }) })).state, 'unverifiable',
    'an owned file for another scope is never this reservation\'s service')
  // A managed-active unit whose main PID cannot be kernel-proven is unverifiable.
  const managed = ownedInspection(facts, { managerState: 'active', mainPid: 4242, activeState: 'active' })
  const classifyActive = kernel => classify(managed, { kernel })
  assert.equal(classifyActive(null).state, 'unverifiable')
  assert.equal(classifyActive({ status: 'unknown', uid: null }).state, 'unverifiable')
  assert.equal(classifyActive({ status: 'gone', uid: null }).state, 'unverifiable')
  assert.equal(classifyActive({ status: 'different', uid: null }).state, 'unverifiable')
  assert.equal(classifyActive({ status: 'alive', uid: 999 }).state, 'unverifiable')
  const managedActive = classifyActive({ status: 'alive', uid: facts.uid })
  assert.equal(managedActive.state, 'managed-active')
  assert.equal(managedActive.authenticatedHostReady, false, 'manager activity alone is never product Ready')
})

test('a managed-active host is Ready only with a matching authenticated Host identity', () => {
  const facts = reservation()
  const ready = activeObservation(facts, {
    authenticatedHost: { ready: true, pid: 4242, scopeId: facts.scopeId, instanceId: 'instance-1' },
  })
  assert.equal(ready.state, 'managed-active')
  assert.equal(ready.authenticatedHostReady, true)
  assert.equal(ready.authenticatedHostPid, 4242)
  assert.equal(activeObservation(facts).authenticatedHostReady, false)
  const otherScope = activeObservation(facts, {
    authenticatedHost: { ready: true, pid: 4242, scopeId: 'another-scope', instanceId: 'instance-1' },
  })
  assert.equal(otherScope.authenticatedHostReady, false)
  const otherPid = activeObservation(facts, {
    authenticatedHost: { ready: true, pid: 4243, scopeId: facts.scopeId, instanceId: 'instance-1' },
  })
  assert.equal(otherPid.authenticatedHostReady, false)
})

test('the platform helper must never report a normalized observation state', () => {
  const facts = reservation()
  const inspection = ownedInspection(facts)
  expectContractError(() => validateManagerInspection({ ...inspection, state: 'managed-active' }), 'NATIVE_INSPECTION_INVALID')
  expectContractError(() => validateManagerInspection({ ...inspection, file: 'present' }), 'NATIVE_INSPECTION_INVALID')
  expectContractError(() => validateManagerInspection({ ...inspection, fileFacts: ownedFileFacts({ sha256: 'not-a-digest' }) }),
    'NATIVE_INSPECTION_INVALID')
})

// ── mutation admission ─────────────────────────────────────────────────────

test('every mutating verb requires a reservation and a strict owner-verified state', () => {
  const facts = reservation()
  const reserved = absentObservation(facts)
  const removed = absentObservation(facts, { everObservedInstalled: true })
  const inactive = classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection: ownedInspection(facts),
    verifiedAt: '2026-11-23T00:00:00.000Z',
  })
  const active = activeObservation(facts)
  const unknown = classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection: ownedInspection(facts, { file: 'foreign' }),
    verifiedAt: '2026-11-23T00:00:00.000Z',
  })
  for (const verb of ['install', 'start', 'restart', 'stop', 'uninstall']) {
    assert.equal(allowNativeMutation({ reservation: facts, observation: unknown, verb }).allowed, false, `${verb} on unverifiable`)
    assert.equal(allowNativeMutation({ reservation: facts, observation: unknown, verb }).reason, 'NATIVE_SERVICE_UNVERIFIABLE')
  }
  assert.equal(allowNativeMutation({ reservation: facts, observation: reserved, verb: 'install' }).allowed, true)
  assert.equal(allowNativeMutation({ reservation: facts, observation: removed, verb: 'install' }).allowed, true)
  assert.equal(allowNativeMutation({ reservation: facts, observation: reserved, verb: 'start' }).reason, 'NATIVE_SERVICE_NOT_INSTALLED')
  assert.equal(allowNativeMutation({ reservation: facts, observation: inactive, verb: 'start' }).allowed, true)
  assert.equal(allowNativeMutation({ reservation: facts, observation: inactive, verb: 'restart' }).allowed, true)
  assert.equal(allowNativeMutation({ reservation: facts, observation: inactive, verb: 'uninstall' }).allowed, true)
  assert.equal(allowNativeMutation({ reservation: facts, observation: active, verb: 'stop' }).allowed, true)
  assert.equal(allowNativeMutation({ reservation: facts, observation: active, verb: 'status' }).allowed, true)
  assert.equal(allowNativeMutation({ reservation: facts, observation: inactive, verb: 'status', cliBusy: true }).reason, 'NATIVE_CLI_BUSY')
  assert.equal(allowNativeMutation({ reservation: facts, observation: inactive, verb: 'install', cliBusy: true }).allowed, false)
  expectContractError(() => allowNativeMutation({ reservation: facts, observation: inactive, verb: 'logs' }), 'NATIVE_DAEMON_VERB_INVALID')
  expectContractError(() => allowNativeMutation({ observation: inactive, verb: 'install' }), 'NATIVE_CONTRACT_INVALID')
})

test('a foreign or unowned service state is never mutated but is still planned for helper reclamation', () => {
  const facts = reservation()
  const unknown = classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection: ownedInspection(facts, { file: 'foreign' }),
    verifiedAt: '2026-11-23T00:00:00.000Z',
  })
  assert.deepEqual(planNativeCleanup({ reservation: facts, observation: unknown }).actions, ['helper-reclaim'])
  const active = activeObservation(facts)
  assert.deepEqual(planNativeCleanup({ reservation: facts, observation: active }).actions,
    ['official-stop', 'official-uninstall', 'helper-reclaim'])
  const inactive = classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection: ownedInspection(facts),
    verifiedAt: '2026-11-23T00:00:00.000Z',
  })
  assert.deepEqual(planNativeCleanup({ reservation: facts, observation: inactive }).actions,
    ['official-uninstall', 'helper-reclaim'])
  const absent = absentObservation(facts)
  assert.deepEqual(planNativeCleanup({ reservation: facts, observation: absent }).actions, [])
})

test('a committed fake install is reclaimed only through the shared plan and the reserved unit', async () => {
  const facts = reservation()
  const installed = classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection: ownedInspection(facts),
    verifiedAt: '2026-11-23T00:00:00.000Z',
  })
  const official = []
  const helper = []
  const removed = rawInspection({ unitName: facts.unitName, unitPath: facts.unitPath })
  const adapter = {
    async inspectManagedService() {
      return removed
    },
    async reclaimManagedService(input) {
      helper.push(input)
      return { clean: true, action: 'removed', reason: 'verified-owner', observation: removed }
    },
  }
  // The worker died after the install committed; the Supervisor starts from the
  // last real observation, never from "never installed".
  const plan = planNativeCleanup({ reservation: facts, observation: installed })
  assert.deepEqual(plan.actions, ['official-uninstall', 'helper-reclaim'])
  for (const action of plan.actions) {
    if (action === 'official-uninstall') {
      // The official path re-reads the real manager and sees the file gone.
      official.push(action)
      continue
    }
    if (action === 'helper-reclaim') {
      const inspection = await adapter.inspectManagedService(facts)
      const observation = classifyManagedInspection({
        reservation: facts,
        history: { everObservedInstalled: true },
        inspection,
        verifiedAt: '2026-11-23T00:00:01.000Z',
      })
      assert.equal(observation.state, 'removed')
      continue
    }
    helper.push(action)
  }
  assert.deepEqual(official, ['official-uninstall'])
  assert.deepEqual(helper, [], 'a service already confirmed removed never needs the helper fallback')
  const verdict = classifyNativeCleanup({
    observation: classifyManagedInspection({
      reservation: facts,
      history: { everObservedInstalled: true },
      inspection: removed,
      verifiedAt: '2026-11-23T00:00:02.000Z',
    }),
    hostIdentities: [hostIdentity()],
    hostsGone: [{ pid: 4242, status: 'gone' }],
    clientsGone: [{ label: 'client-a', gone: true }],
  })
  assert.deepEqual(verdict, { clean: true, reasons: [] })
})

test('a foreign service state never drives an official stop and a helper preserve stays NOT_QUIESCED', async () => {
  const facts = reservation()
  const foreign = classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection: ownedInspection(facts, { file: 'foreign' }),
    verifiedAt: '2026-11-23T00:00:00.000Z',
  })
  const official = []
  const helper = []
  const preserved = rawInspection({
    unitName: facts.unitName,
    unitPath: facts.unitPath,
    file: 'foreign',
    managerState: 'not-loaded',
    reason: 'FOREIGN_SERVICE_FILE',
  })
  const plan = planNativeCleanup({ reservation: facts, observation: foreign })
  assert.deepEqual(plan.actions, ['helper-reclaim'])
  for (const action of plan.actions) {
    if (action === 'official-stop' || action === 'official-uninstall') {
      official.push(action)
      continue
    }
    helper.push(await Promise.resolve({ clean: false, action: 'preserve', reason: 'OWNER_UNPROVEN', observation: preserved }))
  }
  assert.deepEqual(official, [], 'unknown/foreign state must never reach a mutating official verb')
  assert.deepEqual(helper.map(result => result.action), ['preserve'])
  const verdict = classifyNativeCleanup({ observation: foreign, hostIdentities: [], hostsGone: [], clientsGone: [] })
  assert.equal(verdict.clean, false)
  assert.ok(verdict.reasons.includes('NATIVE_SERVICE_NOT_REMOVED'))
})

// ── daemon CLI primitive ───────────────────────────────────────────────────

function fakeChild({ closeOnSignal = true, emitStdout = '', emitStderr = '' } = {}) {
  const child = new EventEmitter()
  child.pid = 7000 + Math.floor(Math.random() * 1000)
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.signals = []
  child.kill = signal => {
    child.signals.push(signal)
    if (!closeOnSignal) return true
    process.nextTick(() => child.emit('close', null, signal))
    return true
  }
  child.emitOutput = () => {
    child.stdout.write(emitStdout)
    child.stderr.write(emitStderr)
    child.stdout.end()
    child.stderr.end()
    process.nextTick(() => child.emit('close', 0, null))
  }
  return child
}

const INSTALLATION = {
  dshInvocation: ['/usr/bin/node', '/tmp/harness/node_modules/@deepseek-ai/dsh/lib/bin.js'],
  profileDir: '/tmp/dsh-home/profiles/pi-tui',
  platform: 'linux',
  runtimeDir: '/run/user/501',
  busPath: '/run/user/501/bus',
  env: {
    PATH: '/usr/bin:/bin',
    HOME: '/tmp/scene/home',
    DSH_HOME: '/tmp/scene/dsh-home',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/stale-bus',
  },
}

test('the fixed daemon CLI child receives the exact argv and the verified environment', async () => {
  const calls = []
  const child = fakeChild()
  const hooks = []
  const result = await runFixedDaemonVerb({
    installation: INSTALLATION,
    verb: 'install',
    hooks: {
      onIssued: ({ verb, at }) => { hooks.push(['issued', verb, at]); assert.equal(calls.length, 0) },
      onSpawned: ({ pid }) => { hooks.push(['spawned', pid]) },
      onExited: ({ exitCode, signal }) => { hooks.push(['exited', exitCode, signal]) },
    },
    spawnImpl: (executable, argv, options) => {
      calls.push({ executable, argv, options })
      process.nextTick(child.emitOutput)
      return child
    },
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].executable, '/usr/bin/node')
  assert.deepEqual(calls[0].argv, [
    '/tmp/harness/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '--profile', 'pi-tui', 'daemon', 'install',
  ])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.cwd, '/tmp/dsh-home/profiles/pi-tui')
  assert.equal(calls[0].options.stdio[0], 'ignore')
  assert.equal(calls[0].options.env.HOME, '/tmp/scene/home')
  assert.equal(calls[0].options.env.DSH_HOME, '/tmp/scene/dsh-home')
  assert.equal(calls[0].options.env.XDG_RUNTIME_DIR, '/run/user/501')
  assert.equal(calls[0].options.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/501/bus')
  assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' })
  assert.equal(hooks[0][0], 'issued')
  assert.equal(hooks[0][1], 'install')
  assert.equal(hooks[1][0], 'spawned')
  assert.deepEqual(hooks[2], ['exited', 0, null])
})

test('a stale inherited DBus address is removed when no real bus socket was proven', () => {
  const env = buildNativeDaemonEnvironment({
    baseEnv: { HOME: '/tmp/home', DSH_HOME: '/tmp/dsh-home', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/stale' },
    platform: 'linux',
    runtimeDir: '/run/user/501',
    busPath: null,
  })
  assert.equal(env.XDG_RUNTIME_DIR, '/run/user/501')
  assert.ok(!('DBUS_SESSION_BUS_ADDRESS' in env))
  expectContractError(() => buildNativeDaemonEnvironment({
    baseEnv: { HOME: '/tmp/home' },
    platform: 'linux',
    runtimeDir: null,
  }), 'NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE')
  const darwin = buildNativeDaemonEnvironment({
    baseEnv: { HOME: '/tmp/home', XDG_RUNTIME_DIR: '/run/user/501', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus' },
    platform: 'darwin',
  })
  assert.ok(!('XDG_RUNTIME_DIR' in darwin))
  assert.ok(!('DBUS_SESSION_BUS_ADDRESS' in darwin))
})

test('daemon output is bounded and credential material is redacted', async () => {
  const child = fakeChild({
    emitStdout: 'Authorization: Bearer private-token\ntoken=secret-value\nhost=ready\n',
    emitStderr: 'Cookie: session=private-cookie\n',
  })
  const result = await runFixedDaemonVerb({
    installation: INSTALLATION,
    verb: 'status',
    spawnImpl: () => { process.nextTick(child.emitOutput); return child },
  })
  assert.match(result.stdout, /Authorization: \[redacted\]/u)
  assert.match(result.stdout, /token=\[redacted\]/u)
  assert.match(result.stdout, /host=ready/u)
  assert.match(result.stderr, /Cookie: \[redacted\]/u)
  assert.equal(sanitizeDaemonOutput('https://user:pass@host/connect?token=abc'), 'https://user:pass@host/connect?token=[redacted]')
})

test('an over-limit child is still drained and the real OUTPUT_LIMIT_EXCEEDED failure is raised', async () => {
  const oversized = 'x'.repeat(MANAGED_DAEMON_OUTPUT_LIMIT_BYTES + 1)
  const child = fakeChild({ emitStdout: oversized })
  const exits = []
  await assert.rejects(runFixedDaemonVerb({
    installation: INSTALLATION,
    verb: 'status',
    hooks: { onExited: facts => exits.push(facts) },
    spawnImpl: () => { process.nextTick(child.emitOutput); return child },
  }), error => error?.code === 'OUTPUT_LIMIT_EXCEEDED')
  assert.equal(exits.length, 1)
  assert.equal(exits[0].outputLimitExceeded, true)
  assert.equal(exits[0].exitCode, 0)
})

test('a nonzero exit and a signalled child are reported, never disguised as success', async () => {
  await assert.rejects(runFixedDaemonVerb({
    installation: INSTALLATION,
    verb: 'start',
    spawnImpl: () => {
      const child = fakeChild()
      process.nextTick(() => {
        child.stdout.end()
        child.stderr.end()
        child.emit('close', 4, null)
      })
      return child
    },
  }), error => error?.code === 'NATIVE_DAEMON_FAILED')
  await assert.rejects(runFixedDaemonVerb({
    installation: INSTALLATION,
    verb: 'stop',
    spawnImpl: () => {
      const child = fakeChild()
      process.nextTick(() => child.emit('close', null, 'SIGTERM'))
      return child
    },
  }), error => error?.code === 'NATIVE_DAEMON_SIGNALLED')
})

test('cancellation signals exactly the issued CLI child and reports CANCELLED after it exits', async () => {
  const controller = new AbortController()
  const child = fakeChild()
  const exits = []
  const run = runFixedDaemonVerb({
    installation: INSTALLATION,
    verb: 'restart',
    abortSignal: controller.signal,
    hooks: { onExited: facts => exits.push(facts) },
    spawnImpl: () => {
      process.nextTick(() => controller.abort())
      return child
    },
  })
  await assert.rejects(run, error => error?.code === 'NATIVE_DAEMON_CANCELLED')
  assert.deepEqual(child.signals, ['SIGTERM'])
  assert.equal(exits.length, 1)
  assert.equal(exits[0].signal, 'SIGTERM')
})

test('a child that never settles after TERM/KILL is NOT_QUIESCED, not a quiet success', async () => {
  const controller = new AbortController()
  const child = fakeChild({ closeOnSignal: false })
  await assert.rejects(runFixedDaemonVerb({
    installation: INSTALLATION,
    verb: 'uninstall',
    abortSignal: controller.signal,
    timing: { termGraceMs: 10, killGraceMs: 10 },
    spawnImpl: () => {
      process.nextTick(() => controller.abort())
      return child
    },
  }), error => error?.code === 'NOT_QUIESCED')
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'])
})

test('a deadline cancels exactly the CLI child and reports TIMEOUT, never a service stop', async () => {
  const child = fakeChild()
  await assert.rejects(runFixedDaemonVerb({
    installation: INSTALLATION,
    verb: 'status',
    timing: { deadlineMs: 20, termGraceMs: 20, killGraceMs: 20 },
    spawnImpl: () => child,
  }), error => error?.code === 'NATIVE_DAEMON_TIMEOUT')
  assert.deepEqual(child.signals, ['SIGTERM'])
})

test('an already-cancelled request spawns nothing and an unknown verb never parses', async () => {
  const controller = new AbortController()
  controller.abort()
  let spawned = 0
  await assert.rejects(runFixedDaemonVerb({
    installation: INSTALLATION,
    verb: 'status',
    abortSignal: controller.signal,
    spawnImpl: () => { spawned += 1; return fakeChild() },
  }), error => error?.code === 'NATIVE_DAEMON_CANCELLED')
  assert.equal(spawned, 0)
  expectContractError(() => requireManagedDaemonVerb('logs'), 'NATIVE_DAEMON_VERB_INVALID')
})

test('the daemon status key=value block is parsed without inventing readiness', () => {
  const parsed = parseManagedDaemonStatus([
    'profile=pi-tui',
    'manager=systemd',
    'user-manager=available',
    'host=ready',
    'unit=dsh-pi-tui@pi-tui-0123456789abcdef.service',
    'unit-state=active',
    'compatibility=compatible',
    'pid=4242',
    'instance=deadbeef',
    'acp=disabled',
    '',
  ].join('\n'))
  assert.equal(parsed.host, 'ready')
  assert.equal(parsed.pid, 4242)
  assert.equal(parsed.unitState, 'active')
  assert.ok(!('acp' in parsed))
  expectContractError(() => parseManagedDaemonStatus('profile=pi-tui\n'), 'NATIVE_DAEMON_STATUS_INVALID')
})

// ── current Profile entry ─────────────────────────────────────────────────

test('the native Client entry is the current installed Profile, not a stale bootstrap snapshot', () => {
  const receipt = {
    role: 'new',
    installGeneration: 2,
    version: '0.5.8',
    buildId: BUILD_B,
    payloadHash: PAYLOAD_B,
    packageRoot: '/tmp/profile/node_modules/@xmoon76/dsh-pi-tui',
    entries: {
      host: '/tmp/profile/node_modules/@xmoon76/dsh-pi-tui/dist/local-host.mjs',
      client: '/tmp/profile/node_modules/@xmoon76/dsh-pi-tui/dist/local-client.mjs',
    },
  }
  assert.deepEqual(classifyCurrentProfile({ receipt, current: { ...receipt } }), { current: true, reason: null })
  const stale = classifyCurrentProfile({
    receipt,
    current: { ...receipt, packageRoot: '/tmp/old-store/package', entries: {
      host: '/tmp/old-store/package/dist/local-host.mjs',
      client: '/tmp/old-store/package/dist/local-client.mjs',
    } },
  })
  assert.deepEqual(stale, { current: false, reason: 'NATIVE_PROFILE_ENTRY_STALE' })
  expectContractError(() => classifyCurrentProfile({
    receipt: { ...receipt, buildId: undefined },
    current: receipt,
  }), 'NATIVE_PROFILE_INSTALL_INVALID')
})

// ── owner currentness ─────────────────────────────────────────────────────

test('a legal reinstall changes the identity generation while an identical observation does not', () => {
  const facts = reservation()
  const reserved = nativeReservationRecord({ reservation: facts, observation: absentObservation(facts) })
  const first = applyServiceObservation(reserved, classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection: ownedInspection(facts),
    verifiedAt: '2026-11-23T00:00:00.000Z',
  }))
  assert.equal(first.everObservedInstalled, true)
  assert.equal(first.generation, 1)
  assert.equal(first.lifecycle, 'observed')
  assert.equal(first.fileIdentity.inode, '1234567')
  const same = applyServiceObservation(first, classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection: ownedInspection(facts),
    verifiedAt: '2026-11-23T00:00:01.000Z',
  }))
  assert.equal(same.generation, 1)
  const rewritten = applyServiceObservation(first, classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection: ownedInspection(facts, { fileFacts: ownedFileFacts({ inode: '9999999' }) }),
    verifiedAt: '2026-11-23T00:00:02.000Z',
  }))
  assert.equal(rewritten.generation, 2)
  assert.equal(rewritten.fileIdentity.inode, '9999999')
  const removed = applyServiceObservation(rewritten, absentObservation(facts, { everObservedInstalled: true }))
  assert.equal(removed.lifecycle, 'removed')
  assert.equal(removed.fileIdentity, null)
  assert.equal(removed.everObservedInstalled, true)
  const reinstalled = applyServiceObservation(removed, classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection: ownedInspection(facts),
    verifiedAt: '2026-11-23T00:00:03.000Z',
  }))
  assert.equal(reinstalled.generation, 3, 'a rollback reinstall is a new identity generation')
})

test('an ownership change on any identity field is unverifiable and blocks mutation', () => {
  const facts = reservation()
  const classify = inspection => classifyManagedInspection({
    reservation: facts,
    history: { everObservedInstalled: true },
    inspection,
    kernel: { status: 'alive', uid: facts.uid },
    verifiedAt: '2026-11-23T00:00:00.000Z',
  })
  for (const inspection of [
    ownedInspection(facts, { ownerVerified: false }),
    ownedInspection(facts, { fileFacts: ownedFileFacts({ scopeId: 'another-scope' }) }),
    ownedInspection(facts, { fragmentPath: '/tmp/foreign.service', ownerVerified: false }),
  ]) {
    const observation = classify(inspection)
    assert.equal(observation.state, 'unverifiable')
    assert.equal(allowNativeMutation({ reservation: facts, observation, verb: 'stop' }).allowed, false)
  }
})

// ── cleanup verdict ───────────────────────────────────────────────────────

function hostIdentity(overrides = {}) {
  return {
    pid: 4242,
    scopeId: SCOPED,
    instanceId: 'instance-1',
    kernelIdentity: 'linux:12345',
    buildId: BUILD_A,
    source: 'official-client-auth-record',
    ...overrides,
  }
}

test('a terminal cleanup is clean only with a removed service and proven-gone Hosts/Clients', () => {
  const facts = reservation()
  const removed = absentObservation(facts, { everObservedInstalled: true })
  const clean = classifyNativeCleanup({
    observation: removed,
    hostIdentities: [hostIdentity()],
    hostsGone: [{ pid: 4242, status: 'gone' }],
    clientsGone: [{ label: 'client-a', gone: true }],
  })
  assert.deepEqual(clean, { clean: true, reasons: [] })
  assert.deepEqual(classifyNativeCleanup({
    observation: removed,
    hostIdentities: [hostIdentity()],
    hostsGone: [{ pid: 4242, status: 'alive' }],
    clientsGone: [],
  }).reasons, ['MANAGED_HOST_STILL_ALIVE'])
  assert.deepEqual(classifyNativeCleanup({
    observation: removed,
    hostIdentities: [hostIdentity()],
    hostsGone: [],
    clientsGone: [],
  }).reasons, ['MANAGED_HOST_UNPROVEN'])
  assert.deepEqual(classifyNativeCleanup({
    observation: absentObservation(facts),
    hostIdentities: [],
    hostsGone: [],
    clientsGone: [{ label: 'client-a', gone: false }],
  }), { clean: false, reasons: ['NATIVE_CLIENT_STILL_ALIVE'] })
  assert.deepEqual(classifyNativeCleanup({
    observation: activeObservation(facts),
    hostIdentities: [],
    hostsGone: [],
    clientsGone: [],
  }).reasons, ['NATIVE_SERVICE_NOT_REMOVED'])
})

test('a failed primary operation and a failed cleanup keep both independent reasons', () => {
  const primary = new Error('official install exited 4')
  const cleanup = new Error('managed service is not removed')
  const combined = combineNativeFailures(primary, cleanup)
  assert.ok(combined instanceof AggregateError)
  assert.equal(combined.errors.length, 2)
  assert.equal(combined.errors[0], primary)
  assert.equal(combined.errors[1], cleanup)
  assert.equal(combineNativeFailures(primary, undefined), primary)
  assert.equal(combineNativeFailures(undefined, cleanup), cleanup)
  assert.equal(combineNativeFailures(undefined, undefined), undefined)
})

// ── native Client OS ownership ───────────────────────────────────────────

const SCENE_ROOT = '/tmp/upgrade-scene-root'
const CLIENT_SCRATCH = '/tmp/upgrade-scene-root/clients/a-1/scratch'
const CLIENT_ENTRY = '/tmp/dsh-home/profiles/pi-tui/node_modules/@xmoon76/dsh-pi-tui/dist/local-client.mjs'

function registeredClient(overrides = {}) {
  return {
    pid: 5151,
    uid: 501,
    birth: 'linux:777',
    scratch: CLIENT_SCRATCH,
    entry: CLIENT_ENTRY,
    ...overrides,
  }
}

function observedClient(overrides = {}) {
  return {
    pid: 5151,
    uid: 501,
    birth: 'linux:777',
    scratch: CLIENT_SCRATCH,
    entry: CLIENT_ENTRY,
    ...overrides,
  }
}

test('a native Client is reclaimable only with the same uid, kernel birth, scratch and entry', () => {
  const owned = classifyNativeClientOwnership({
    registered: registeredClient(),
    observed: observedClient(),
    sceneRoot: SCENE_ROOT,
    uid: 501,
  })
  assert.deepEqual(owned, { owned: true, reason: null })
  for (const [observed, reason] of [
    [null, 'PROCESS_IDENTITY_UNREADABLE'],
    [observedClient({ pid: 5152 }), 'PID_MISMATCH'],
    [observedClient({ uid: 999 }), 'UID_MISMATCH'],
    [observedClient({ birth: 'linux:999' }), 'PID_REUSED'],
    [observedClient({ scratch: '/tmp/other-scene/scratch' }), 'SCRATCH_FOREIGN'],
    [observedClient({ entry: '/tmp/other/dist/local-client.mjs' }), 'ENTRY_MISMATCH'],
  ]) {
    assert.deepEqual(classifyNativeClientOwnership({
      registered: registeredClient(),
      observed,
      sceneRoot: SCENE_ROOT,
      uid: 501,
    }), { owned: false, reason })
  }
  assert.deepEqual(classifyNativeClientOwnership({
    registered: registeredClient({ uid: 999 }),
    observed: observedClient(),
    sceneRoot: SCENE_ROOT,
    uid: 501,
  }), { owned: false, reason: 'REGISTERED_UID_FOREIGN' })
  assert.deepEqual(classifyNativeClientOwnership({
    registered: registeredClient({ scratch: '/tmp/sibling-scene/clients/a/scratch' }),
    observed: observedClient({ scratch: '/tmp/sibling-scene/clients/a/scratch' }),
    sceneRoot: SCENE_ROOT,
    uid: 501,
  }), { owned: false, reason: 'REGISTERED_SCRATCH_FOREIGN' })
})

test('the tui-test shell is proven by uid, kernel birth and command without a Client scratch', () => {
  const shell = {
    pid: 5200,
    uid: 501,
    birth: 'linux:888',
    scratch: null,
    entry: '/bin/bash -c node /tmp/dsh-home/profiles/pi-tui/node_modules/@xmoon76/dsh-pi-tui/dist/local-client.mjs',
  }
  const observedShell = { pid: 5200, uid: 501, birth: 'linux:888', scratch: null, entry: shell.entry }
  assert.deepEqual(classifyNativeClientOwnership({
    registered: shell,
    observed: observedShell,
    sceneRoot: SCENE_ROOT,
    uid: 501,
  }), { owned: true, reason: null })
  assert.deepEqual(classifyNativeClientOwnership({
    registered: shell,
    observed: { ...observedShell, scratch: '/tmp/other/scratch' },
    sceneRoot: SCENE_ROOT,
    uid: 501,
  }), { owned: false, reason: 'SCRATCH_FOREIGN' })
  assert.deepEqual(classifyNativeClientOwnership({
    registered: shell,
    observed: { ...observedShell, birth: 'linux:999' },
    sceneRoot: SCENE_ROOT,
    uid: 501,
  }), { owned: false, reason: 'PID_REUSED' })
})

test('kernel identity serialization is exact per platform and refuses an unknown ABI', () => {
  assert.equal(serializeKernelIdentity({
    platform: 'linux',
    pid: 1,
    startTicks: '12345',
    ppid: 1,
    pgid: 1,
    sid: 1,
    state: 'S',
  }), 'linux:12345')
  assert.equal(serializeKernelIdentity({
    platform: 'darwin',
    pid: 1,
    bootUUID: 'boot',
    uniqueId: 'u',
    parentUniqueId: 'p',
    processUUID: 'abc',
    startSec: '10',
    startUsec: '20',
    ppid: 1,
    pgid: 1,
    sid: 1,
    uid: 501,
    state: 2,
  }), 'darwin:boot:u:abc:10:20')
  expectContractError(() => serializeKernelIdentity({ platform: 'win32' }), 'NATIVE_CLIENT_IDENTITY_INVALID')
})

// ── launchd customization ────────────────────────────────────────────────

test('the launchd customization admits exactly the fixed safe transaction input', () => {
  assert.deepEqual(requireLaunchdCustomization({ ...LAUNCHD_CUSTOMIZATION }), LAUNCHD_CUSTOMIZATION)
  expectContractError(() => requireLaunchdCustomization({ ...LAUNCHD_CUSTOMIZATION, extraEnvironmentKey: 'OTHER' }), 'NATIVE_CUSTOMIZE_INVALID')
  expectContractError(() => requireLaunchdCustomization({ ...LAUNCHD_CUSTOMIZATION, value: 'other' }), 'NATIVE_CUSTOMIZE_INVALID')
  expectContractError(() => requireLaunchdCustomization({ ...LAUNCHD_CUSTOMIZATION, comment: 'other' }), 'NATIVE_CUSTOMIZE_INVALID')
  expectContractError(() => requireLaunchdCustomization({ ...LAUNCHD_CUSTOMIZATION, path: '/tmp/other.plist' }), 'NATIVE_CUSTOMIZE_INVALID')
})
