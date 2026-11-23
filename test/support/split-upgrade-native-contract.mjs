/**
 * The ONE stateless contract for the native managed-service upgrade bridge.
 *
 * The Split Supervisor owns every persistent fact (receipts, reservations,
 * cancellation and the single CLI slot) and the platform helpers own the OS
 * IO. This module owns the narrow behaviour those two owners share:
 *
 *   - the fixed manager kinds, daemon verbs, helper file ABI and deadlines;
 *   - admission/classification of raw manager observations against one
 *     Supervisor-owned reservation and its recorded history;
 *   - the reservation facts derived from authoritative scene inputs;
 *   - native Profile install identity, current-Profile entry and native Client
 *     OS-ownership decisions;
 *   - `runFixedDaemonVerb()`, the ONE asynchronous official daemon CLI
 *     primitive (fixed argv, the ISSUED commit point before spawn, bounded
 *     output, exact-child cancellation).
 *
 * It keeps NO state, writes nothing and never imports a platform helper on
 * module load. The platform helper files are owned by the platform business
 * PRs; this module only resolves their fixed paths and loads one on explicit
 * request.
 *
 * @module split-upgrade-native-contract
 */

import { spawn } from 'node:child_process'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SUPPORT_DIR = fileURLToPath(new URL('.', import.meta.url))

/** The two supported native manager kinds. */
export const NATIVE_MANAGER_KINDS = Object.freeze(['systemd', 'launchd'])
/** The exact public daemon verbs this bridge may execute. */
export const MANAGED_DAEMON_VERBS = Object.freeze(['status', 'install', 'start', 'restart', 'stop', 'uninstall'])
/** The fixed platform helper file names the platform PRs create. */
export const NATIVE_MANAGER_HELPER_FILES = Object.freeze({
  systemd: 'split-upgrade-systemd-manager.mjs',
  launchd: 'split-upgrade-launchd-manager.mjs',
})
/** The per-verb deadline for ONE official daemon CLI child. */
export const MANAGED_DAEMON_DEADLINES = Object.freeze({
  status: 30_000,
  install: 180_000,
  start: 180_000,
  stop: 180_000,
  uninstall: 180_000,
  restart: 240_000,
})
/** The shared stdout/stderr byte cap of ONE daemon CLI child. */
export const MANAGED_DAEMON_OUTPUT_LIMIT_BYTES = 32 * 1024
/** Bounded wait for an exactly-owned CLI child after TERM and after KILL. */
export const MANAGED_DAEMON_TERM_GRACE_MS = 3_000
export const MANAGED_DAEMON_KILL_GRACE_MS = 3_000
/** The fixed managed-profile name every native scene owns. */
export const NATIVE_PROFILE = 'pi-tui'
/** The fixed launchd customization this contract admits (and nothing else). */
export const LAUNCHD_CUSTOMIZATION = Object.freeze({
  extraEnvironmentKey: 'UPGRADE_USER_FLAG',
  value: 'keep-me',
  comment: 'user-maintained-launch-agent-comment',
})
/** Fixed cleanup action order; the helper fallback is the LAST resort. */
export const NATIVE_CLEANUP_ACTIONS = Object.freeze(['official-stop', 'official-uninstall', 'helper-reclaim'])

const INSPECTION_FILE_STATES = Object.freeze(['absent', 'owned', 'foreign', 'unverifiable'])
const MANAGER_STATES = Object.freeze(['not-loaded', 'inactive', 'active', 'unknown'])
const KERNEL_STATES = Object.freeze(['alive', 'gone', 'different', 'unknown'])
const OBSERVATION_STATES = Object.freeze(['reserved-but-absent', 'installed-inactive', 'managed-active', 'removed', 'unverifiable'])
const NATIVE_LIFECYCLES = Object.freeze(['reserved', 'mutating', 'observed', 'cleaning', 'removed', 'unverifiable'])

/** One controlled native-bridge failure; never a silent fallback. */
export class NativeContractError extends Error {
  /**
   * @param {string} code stable classification
   * @param {string} message bounded description (no secrets or private paths)
   * @param {unknown} [cause]
   */
  constructor(code, message, cause) {
    super(`${code}: ${message}`)
    this.name = 'NativeContractError'
    this.code = code
    if (cause !== undefined) this.cause = cause
  }
}

function contractError(code, message, cause) {
  return new NativeContractError(code, message, cause)
}

function fail(code, message, cause) {
  throw contractError(code, message, cause)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireObject(value, label, code = 'NATIVE_CONTRACT_INVALID') {
  if (!isPlainObject(value)) fail(code, `${label} must be an object`)
  return value
}

function requireNonEmptyString(value, label, code = 'NATIVE_CONTRACT_INVALID') {
  if (typeof value !== 'string' || value === '') fail(code, `${label} must be a non-empty string`)
  return value
}

function requireAbsolutePath(value, label, code = 'NATIVE_CONTRACT_INVALID') {
  requireNonEmptyString(value, label, code)
  if (!isAbsolute(value)) fail(code, `${label} must be an absolute path`)
  return value
}

function requirePositiveInteger(value, label, code = 'NATIVE_CONTRACT_INVALID') {
  if (!Number.isInteger(value) || value <= 0) fail(code, `${label} must be a positive integer`)
  return value
}

function requireNullablePositiveInteger(value, label) {
  if (value === null) return null
  return requirePositiveInteger(value, label)
}

function requireBoolean(value, label, code = 'NATIVE_CONTRACT_INVALID') {
  if (typeof value !== 'boolean') fail(code, `${label} must be a boolean`)
  return value
}

function requireNullableString(value, label) {
  if (value === null) return null
  if (typeof value !== 'string') fail('NATIVE_CONTRACT_INVALID', `${label} must be a string or null`)
  return value
}

function requireSha256(value, label, code = 'NATIVE_CONTRACT_INVALID') {
  requireNonEmptyString(value, label, code)
  if (!/^[0-9a-f]{64}$/u.test(value)) fail(code, `${label} must be a lowercase SHA256 digest`)
  return value
}

function requireOneOf(value, allowed, label, code = 'NATIVE_CONTRACT_INVALID') {
  if (!allowed.includes(value)) fail(code, `${label} must be one of ${allowed.join(', ')}, got ${String(value)}`)
  return value
}

function requireStringEnvironment(env, label) {
  requireObject(env, label)
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') fail('NATIVE_CONTRACT_INVALID', `${label}.${key} must be a string`)
  }
  return env
}

function pathInside(root, candidate) {
  const rel = relative(root, candidate)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`)
}

/** Validate one manager kind and return it. */
export function requireNativeManagerKind(manager) {
  return requireOneOf(manager, NATIVE_MANAGER_KINDS, 'manager', 'NATIVE_MANAGER_KIND_INVALID')
}

/** Validate one daemon verb and return it. */
export function requireManagedDaemonVerb(verb) {
  return requireOneOf(verb, MANAGED_DAEMON_VERBS, 'verb', 'NATIVE_DAEMON_VERB_INVALID')
}

/** The fixed helper path for one manager; never a caller-provided path. */
export function nativeManagerHelperPath(manager) {
  return join(SUPPORT_DIR, NATIVE_MANAGER_HELPER_FILES[requireNativeManagerKind(manager)])
}

/**
 * Load ONE platform helper from its fixed path. The helper must export exactly
 * the read-only inspection and the Supervisor-only reclaim primitive; only the
 * launchd helper may export the constrained customization primitive.
 *
 * `importModule` exists ONLY for the simulated tooling test: the Supervisor
 * never supplies it, so production always uses the real dynamic import.
 */
export async function loadNativeManagerAdapter(manager, options = {}) {
  requireNativeManagerKind(manager)
  const importModule = options.importModule ?? (url => import(url))
  const helperPath = nativeManagerHelperPath(manager)
  let loaded
  try {
    loaded = await importModule(pathToFileURL(helperPath).href)
  } catch (error) {
    throw contractError('NATIVE_MANAGER_ADAPTER_UNAVAILABLE',
      `the ${manager} platform helper is not available at its fixed path`, error)
  }
  requireObject(loaded, `${manager} platform helper module`, 'NATIVE_MANAGER_ADAPTER_INVALID')
  if (typeof loaded.inspectManagedService !== 'function') {
    fail('NATIVE_MANAGER_ADAPTER_INVALID', `the ${manager} platform helper exports no inspectManagedService`)
  }
  if (typeof loaded.reclaimManagedService !== 'function') {
    fail('NATIVE_MANAGER_ADAPTER_INVALID', `the ${manager} platform helper exports no reclaimManagedService`)
  }
  const hasCustomize = typeof loaded.customizeManagedService === 'function'
  if (manager === 'launchd' && !hasCustomize) {
    fail('NATIVE_MANAGER_ADAPTER_INVALID', 'the launchd platform helper exports no customizeManagedService')
  }
  if (manager === 'systemd' && hasCustomize) {
    fail('NATIVE_MANAGER_ADAPTER_INVALID', 'the systemd platform helper must never export customizeManagedService')
  }
  return Object.freeze({
    manager,
    inspectManagedService: loaded.inspectManagedService,
    reclaimManagedService: loaded.reclaimManagedService,
    ...(manager === 'launchd' ? { customizeManagedService: loaded.customizeManagedService } : {}),
  })
}

/**
 * Admit the bootstrap request's policy/platform/identity. A default scene never
 * names a manager and never loads a platform helper; a native scene must match
 * the real OS and a real non-root uid before any Scene root or install exists.
 */
export function nativeBootstrapAdmission({ policy, manager, platform = process.platform, uid } = {}) {
  if (policy === 'default') {
    if (manager !== undefined && manager !== null) {
      fail('INPUT_UNQUALIFIED', 'the default upgrade policy does not accept a native manager')
    }
    return Object.freeze({ native: false, manager: null })
  }
  if (policy !== 'native') fail('INPUT_UNQUALIFIED', `unknown upgrade policy ${String(policy)}`)
  const kind = requireNativeManagerKind(manager)
  const expectedPlatform = kind === 'systemd' ? 'linux' : 'darwin'
  if (platform !== expectedPlatform) {
    fail('NATIVE_MANAGER_PLATFORM_MISMATCH', `the ${kind} manager requires ${expectedPlatform}, got ${String(platform)}`)
  }
  if (!Number.isInteger(uid) || uid <= 0) {
    fail('NATIVE_MANAGER_UID_UNQUALIFIED', 'the native manager requires a real non-root user identity')
  }
  return Object.freeze({ native: true, manager: kind })
}

/**
 * The exact manager-derived unit/job path. The full scope/owner identity is
 * always re-verified separately; the bounded name suffix grants no ownership.
 */
export function nativeUnitTarget(manager, accountHome, scopeId) {
  const kind = requireNativeManagerKind(manager)
  requireAbsolutePath(accountHome, 'accountHome')
  requireNonEmptyString(scopeId, 'scopeId')
  if (kind === 'systemd') {
    const unitName = `dsh-pi-tui@${NATIVE_PROFILE}-${scopeId.slice(0, 16)}.service`
    return Object.freeze({ unitName, unitPath: join(accountHome, '.config', 'systemd', 'user', unitName) })
  }
  const unitName = `com.xmoon.dsh-pi-tui.${scopeId.slice(0, 40)}`
  return Object.freeze({ unitName, unitPath: join(accountHome, 'Library', 'LaunchAgents', `${unitName}.plist`) })
}

/**
 * Build ONE immutable native reservation from Supervisor-owned authoritative
 * inputs. `scopeId` comes from the officially stopped seed Host; `oldBuildId`
 * comes from this run's own old Profile install receipt.
 */
export function buildReservationFacts(input) {
  const source = requireObject(input, 'reservation input')
  const manager = requireNativeManagerKind(source.manager)
  const uid = requirePositiveInteger(source.uid, 'uid', 'NATIVE_MANAGER_UID_UNQUALIFIED')
  const accountHome = requireAbsolutePath(source.accountHome, 'accountHome')
  const profileRealpath = requireAbsolutePath(source.profileRealpath, 'profileRealpath')
  const dshHome = requireAbsolutePath(source.dshHome, 'dshHome')
  const scopeId = requireNonEmptyString(source.scopeId, 'scopeId')
  const oldBuildId = requireSha256(source.oldBuildId, 'oldBuildId')
  const sceneId = requireNonEmptyString(source.sceneId, 'sceneId')
  const parentRunId = source.parentRunId === undefined || source.parentRunId === null
    ? null
    : requireNonEmptyString(source.parentRunId, 'parentRunId')
  const { unitName, unitPath } = nativeUnitTarget(manager, accountHome, scopeId)
  return Object.freeze({
    manager,
    uid,
    accountHome,
    profile: NATIVE_PROFILE,
    profileRealpath,
    dshHome,
    scopeId,
    unitName,
    unitPath,
    parentRunId,
    sceneId,
    oldBuildId,
  })
}

/**
 * Validate and normalize one reservation. A forged uid, account home, scope or
 * unit path never reaches a manager: the derived target must match exactly.
 */
export function validateReservationFacts(facts) {
  const source = requireObject(facts, 'reservation')
  const expected = buildReservationFacts({
    manager: source.manager,
    uid: source.uid,
    accountHome: source.accountHome,
    profileRealpath: source.profileRealpath,
    dshHome: source.dshHome,
    scopeId: source.scopeId,
    oldBuildId: source.oldBuildId,
    sceneId: source.sceneId,
    parentRunId: source.parentRunId,
  })
  if (source.profile !== NATIVE_PROFILE) {
    fail('NATIVE_RESERVATION_INVALID', `the reservation profile must be ${NATIVE_PROFILE}`)
  }
  if (source.unitName !== expected.unitName || source.unitPath !== expected.unitPath) {
    fail('NATIVE_RESERVATION_INVALID', 'the reservation unit name/path is not the fixed manager-derived target')
  }
  return expected
}

function normalizeFileFacts(raw) {
  if (raw === null) return null
  const source = requireObject(raw, 'inspection.fileFacts')
  return Object.freeze({
    mode: (() => {
      if (!Number.isInteger(source.mode) || source.mode < 0 || source.mode > 0o7777) {
        fail('NATIVE_INSPECTION_INVALID', 'inspection.fileFacts.mode must be an integer permission mask')
      }
      return source.mode
    })(),
    sha256: requireSha256(source.sha256, 'inspection.fileFacts.sha256', 'NATIVE_INSPECTION_INVALID'),
    device: requireNonEmptyString(source.device, 'inspection.fileFacts.device', 'NATIVE_INSPECTION_INVALID'),
    inode: requireNonEmptyString(source.inode, 'inspection.fileFacts.inode', 'NATIVE_INSPECTION_INVALID'),
    owner: requireNonEmptyString(source.owner, 'inspection.fileFacts.owner', 'NATIVE_INSPECTION_INVALID'),
    scopeId: requireNonEmptyString(source.scopeId, 'inspection.fileFacts.scopeId', 'NATIVE_INSPECTION_INVALID'),
    profileIdentity: requireNonEmptyString(source.profileIdentity, 'inspection.fileFacts.profileIdentity', 'NATIVE_INSPECTION_INVALID'),
    installBuild: requireNonEmptyString(source.installBuild, 'inspection.fileFacts.installBuild', 'NATIVE_INSPECTION_INVALID'),
    execStart: requireNullableString(source.execStart, 'inspection.fileFacts.execStart'),
    programArguments: (() => {
      if (source.programArguments === null) return null
      if (!Array.isArray(source.programArguments) || source.programArguments.some(value => typeof value !== 'string')) {
        fail('NATIVE_INSPECTION_INVALID', 'inspection.fileFacts.programArguments must be a string array or null')
      }
      return Object.freeze([...source.programArguments])
    })(),
    nonGeneratedSha256: (() => {
      if (source.nonGeneratedSha256 === null) return null
      return requireSha256(source.nonGeneratedSha256, 'inspection.fileFacts.nonGeneratedSha256', 'NATIVE_INSPECTION_INVALID')
    })(),
  })
}

/**
 * Validate the platform helper's raw observation and drop any field this ABI
 * does not own, so a helper can never smuggle extra OS data into a receipt.
 * The helper reports raw OS facts; it never reports the normalized `state`.
 */
export function validateManagerInspection(inspection, options = {}) {
  const source = requireObject(inspection, 'inspection', 'NATIVE_INSPECTION_INVALID')
  if (options.classified !== true && source.state !== undefined) {
    fail('NATIVE_INSPECTION_INVALID', 'the platform helper must not report a normalized observation state')
  }
  return Object.freeze({
    file: requireOneOf(source.file, INSPECTION_FILE_STATES, 'inspection.file', 'NATIVE_INSPECTION_INVALID'),
    managerState: requireOneOf(source.managerState, MANAGER_STATES, 'inspection.managerState', 'NATIVE_INSPECTION_INVALID'),
    ownerVerified: requireBoolean(source.ownerVerified, 'inspection.ownerVerified', 'NATIVE_INSPECTION_INVALID'),
    managerObserved: requireBoolean(source.managerObserved, 'inspection.managerObserved', 'NATIVE_INSPECTION_INVALID'),
    unitName: requireNonEmptyString(source.unitName, 'inspection.unitName', 'NATIVE_INSPECTION_INVALID'),
    unitPath: requireAbsolutePath(source.unitPath, 'inspection.unitPath', 'NATIVE_INSPECTION_INVALID'),
    fragmentPath: source.fragmentPath === null ? null : requireAbsolutePath(source.fragmentPath, 'inspection.fragmentPath'),
    sourcePath: source.sourcePath === null ? null : requireAbsolutePath(source.sourcePath, 'inspection.sourcePath'),
    mainPid: requireNullablePositiveInteger(source.mainPid, 'inspection.mainPid'),
    loadState: requireNullableString(source.loadState, 'inspection.loadState'),
    activeState: requireNullableString(source.activeState, 'inspection.activeState'),
    unitFileState: requireNullableString(source.unitFileState, 'inspection.unitFileState'),
    jobState: requireNullableString(source.jobState, 'inspection.jobState'),
    fileFacts: normalizeFileFacts(source.fileFacts === undefined ? null : source.fileFacts),
    reason: requireNullableString(source.reason, 'inspection.reason'),
  })
}

function validateKernelFacts(kernel) {
  if (kernel === null || kernel === undefined) return null
  const source = requireObject(kernel, 'kernel observation')
  const status = requireOneOf(source.status, KERNEL_STATES, 'kernel.status')
  const uid = status === 'alive'
    ? requirePositiveInteger(source.uid, 'kernel.uid')
    : (source.uid === null || source.uid === undefined ? null : requirePositiveInteger(source.uid, 'kernel.uid'))
  return Object.freeze({ status, uid })
}

function validateAuthenticatedHost(authenticatedHost) {
  if (authenticatedHost === null || authenticatedHost === undefined) return null
  const source = requireObject(authenticatedHost, 'authenticated host')
  const ready = requireBoolean(source.ready, 'authenticatedHost.ready')
  const pid = requireNullablePositiveInteger(source.pid, 'authenticatedHost.pid')
  const scopeId = requireNullableString(source.scopeId, 'authenticatedHost.scopeId')
  const instanceId = requireNullableString(source.instanceId, 'authenticatedHost.instanceId')
  if (ready && (pid === null || scopeId === null)) {
    fail('NATIVE_CONTRACT_INVALID', 'a ready authenticated host must name its PID and scope')
  }
  return Object.freeze({ ready, pid, scopeId, instanceId })
}

/**
 * Normalize one raw manager observation against the Supervisor's own
 * reservation and history. History alone distinguishes "never installed" from
 * "installed then removed"; neither the helper nor the caller may precompute it.
 */
export function classifyManagedInspection({
  reservation,
  history,
  inspection,
  authenticatedHost = null,
  kernel = null,
  verifiedAt,
}) {
  const facts = validateReservationFacts(reservation)
  const seen = requireObject(history, 'history')
  const everObservedInstalled = requireBoolean(seen.everObservedInstalled, 'history.everObservedInstalled')
  const raw = validateManagerInspection(inspection)
  const auth = validateAuthenticatedHost(authenticatedHost)
  const kernelFacts = validateKernelFacts(kernel)
  const observedAt = verifiedAt === undefined
    ? new Date().toISOString()
    : requireNonEmptyString(verifiedAt, 'verifiedAt')
  let state
  let reason = raw.reason
  if (raw.unitName !== facts.unitName || raw.unitPath !== facts.unitPath) {
    state = 'unverifiable'
    reason = raw.reason ?? 'RESERVATION_UNIT_MISMATCH'
  } else if (raw.file === 'unverifiable' || raw.managerState === 'unknown') {
    state = 'unverifiable'
    reason = raw.reason ?? 'MANAGER_OBSERVATION_UNVERIFIABLE'
  } else if (raw.file === 'foreign') {
    state = 'unverifiable'
    reason = raw.reason ?? 'FOREIGN_SERVICE_FILE'
  } else if (raw.file === 'absent') {
    if (!raw.managerObserved) {
      state = 'unverifiable'
      reason = raw.reason ?? 'MANAGER_OBSERVATION_UNAVAILABLE'
    } else if (raw.managerState !== 'not-loaded') {
      state = 'unverifiable'
      reason = raw.reason ?? 'MANAGER_STATE_WITHOUT_FILE'
    } else {
      state = everObservedInstalled ? 'removed' : 'reserved-but-absent'
    }
  } else if (!raw.ownerVerified || !raw.managerObserved) {
    state = 'unverifiable'
    reason = raw.reason ?? 'OWNER_NOT_VERIFIED'
  } else if (raw.fileFacts === null || raw.fileFacts.scopeId !== facts.scopeId) {
    state = 'unverifiable'
    reason = raw.reason ?? 'OWNED_FILE_SCOPE_MISMATCH'
  } else if (raw.managerState === 'active') {
    if (raw.mainPid === null) {
      state = 'unverifiable'
      reason = raw.reason ?? 'MAIN_PID_MISSING'
    } else if (kernelFacts === null || kernelFacts.status === 'unknown') {
      state = 'unverifiable'
      reason = raw.reason ?? 'HOST_KERNEL_IDENTITY_UNKNOWN'
    } else if (kernelFacts.status === 'gone') {
      state = 'unverifiable'
      reason = raw.reason ?? 'MAIN_PID_GONE'
    } else if (kernelFacts.status === 'different') {
      state = 'unverifiable'
      reason = raw.reason ?? 'MAIN_PID_REUSED'
    } else if (kernelFacts.uid !== facts.uid) {
      state = 'unverifiable'
      reason = raw.reason ?? 'MAIN_PID_UID_MISMATCH'
    } else {
      state = 'managed-active'
    }
  } else {
    state = 'installed-inactive'
  }
  const authenticatedHostReady = state === 'managed-active'
    && auth !== null
    && auth.ready === true
    && auth.pid === raw.mainPid
    && auth.scopeId === facts.scopeId
  return Object.freeze({
    ...raw,
    state,
    authenticatedHostReady,
    authenticatedHostPid: raw.mainPid,
    verifiedAt: observedAt,
    reason,
  })
}

/** Validate one already-classified observation the Supervisor owns. */
export function validateServiceObservation(observation) {
  const source = requireObject(observation, 'observation', 'NATIVE_OBSERVATION_INVALID')
  const state = requireOneOf(source.state, OBSERVATION_STATES, 'observation.state', 'NATIVE_OBSERVATION_INVALID')
  const raw = validateManagerInspection(source, { classified: true })
  requireBoolean(source.authenticatedHostReady, 'observation.authenticatedHostReady')
  requireNullablePositiveInteger(source.authenticatedHostPid, 'observation.authenticatedHostPid')
  requireNonEmptyString(source.verifiedAt, 'observation.verifiedAt', 'NATIVE_OBSERVATION_INVALID')
  return Object.freeze({ ...raw, state, authenticatedHostReady: source.authenticatedHostReady, authenticatedHostPid: source.authenticatedHostPid, verifiedAt: source.verifiedAt })
}

/**
 * The ONE admission/terminal decision for one daemon verb. Every mutating verb
 * requires a reservation and a strict, owner-verified observation; unknown,
 * foreign or unverifiable service state never authorizes a manager mutation.
 */
export function allowNativeMutation({ reservation, observation, verb, cliBusy = false } = {}) {
  validateReservationFacts(reservation)
  const action = requireManagedDaemonVerb(verb)
  const observed = validateServiceObservation(observation)
  requireBoolean(cliBusy, 'cliBusy')
  const denied = reason => Object.freeze({ allowed: false, reason })
  const allowed = Object.freeze({ allowed: true, reason: null })
  if (cliBusy) return denied('NATIVE_CLI_BUSY')
  if (action === 'status') return allowed
  if (observed.state === 'unverifiable') return denied('NATIVE_SERVICE_UNVERIFIABLE')
  if (observed.state === 'reserved-but-absent' || observed.state === 'removed') {
    return action === 'install' ? allowed : denied('NATIVE_SERVICE_NOT_INSTALLED')
  }
  // installed-inactive or managed-active: an owned, verified definition exists.
  return allowed
}

/**
 * The Supervisor-side seed-Host/seat/profile gate that must pass BEFORE a
 * reservation exists. `hosts` carries the Supervisor's real generation facts.
 */
export function assertManagedReservationScene(sceneFacts) {
  const source = requireObject(sceneFacts, 'reservation scene facts', 'NATIVE_RESERVATION_SCENE_INVALID')
  if (source.kind !== 'upgrade') fail('NATIVE_RESERVATION_SCENE_INVALID', 'a native reservation requires an upgrade scene')
  if (source.policy !== 'native') fail('NATIVE_RESERVATION_SCENE_INVALID', 'a native reservation requires the native pair policy')
  if (source.manager !== source.selectedManager) {
    fail('NATIVE_RESERVATION_SCENE_INVALID', 'the reservation manager must match the selected manager')
  }
  if (source.activeHost !== false) fail('NATIVE_SEED_HOST_STILL_ACTIVE', 'a seed Host is still active')
  if (!Array.isArray(source.hosts) || source.hosts.length === 0) {
    fail('NATIVE_SEED_HOST_MISSING', 'no seed Host generation was recorded')
  }
  const seed = source.hosts[0]
  requireObject(seed, 'seed host facts', 'NATIVE_RESERVATION_SCENE_INVALID')
  if (seed.generation !== 1) fail('NATIVE_SEED_HOST_MISSING', 'the first Host generation is not the seed generation')
  if (seed.exited !== true || seed.exitCode !== 0 || seed.exitSignal !== null) {
    fail('NATIVE_SEED_HOST_NOT_STOPPED', 'the seed Host was not officially stopped with exit code 0')
  }
  if (!source.hosts.every(host => host.groupGone === true)) {
    fail('NATIVE_HOST_GROUP_ALIVE', 'a Host generation process group is still alive')
  }
  if (source.seatFree !== true) fail('NATIVE_HOST_SEAT_STILL_HELD', 'the Host seat is still held')
  if (source.profileBuildIdMatch !== true) {
    fail('NATIVE_OLD_BUILD_UNVERIFIED', 'the installed old Profile build does not match this run receipt')
  }
  return Object.freeze({ seed })
}

/**
 * The pre-registration absence check. Only a genuinely absent file with a
 * queryable, not-loaded manager may be reserved; a present or loaded service is
 * a conflict and never triggers a user-manager write or stop.
 */
export function assertManagedReservationObservable(inspection) {
  const raw = validateManagerInspection(inspection)
  if (raw.file !== 'absent' || raw.managerState !== 'not-loaded') {
    fail('NATIVE_MANAGED_SERVICE_CONFLICT', 'the expected managed service target is not absent and not-loaded')
  }
  if (!raw.managerObserved) fail('NATIVE_MANAGER_UNAVAILABLE', 'the user manager channel is not queryable')
  return raw
}

/** The receipt.native record written BEFORE any native install/start may run. */
export function nativeReservationRecord({ reservation, observation }) {
  const facts = validateReservationFacts(reservation)
  const observed = validateServiceObservation(observation)
  if (observed.state !== 'reserved-but-absent') {
    fail('NATIVE_RESERVATION_INVALID', 'a reservation record requires an absent, not-loaded target observation')
  }
  return Object.freeze({
    reservation: facts,
    lifecycle: 'reserved',
    everObservedInstalled: false,
    generation: 1,
    fileIdentity: null,
    observed,
    lastOperation: null,
    hostIdentities: Object.freeze([]),
    cleanup: null,
  })
}

function fileIdentityOf(observation) {
  if (observation.file !== 'owned' || observation.fileFacts === null) return null
  return { device: observation.fileFacts.device, inode: observation.fileFacts.inode, sha256: observation.fileFacts.sha256 }
}

/**
 * Fold one new observation into the Supervisor-owned native record. The
 * generation advances only for a legal file-identity evolution of an already
 * observed owned definition (in-place rewrite or rollback re-install).
 */
export function applyServiceObservation(record, observation, { lifecycle } = {}) {
  const source = requireObject(record, 'native record', 'NATIVE_OBSERVATION_INVALID')
  const previousReservation = validateReservationFacts(source.reservation)
  requireBoolean(source.everObservedInstalled, 'record.everObservedInstalled')
  requirePositiveInteger(source.generation, 'record.generation')
  const observed = validateServiceObservation(observation)
  const wasInstalled = source.everObservedInstalled === true
  const previousIdentity = source.fileIdentity === null || source.fileIdentity === undefined
    ? null
    : (() => {
      const identity = requireObject(source.fileIdentity, 'record.fileIdentity')
      return {
        device: requireNonEmptyString(identity.device, 'record.fileIdentity.device'),
        inode: requireNonEmptyString(identity.inode, 'record.fileIdentity.inode'),
        sha256: requireSha256(identity.sha256, 'record.fileIdentity.sha256'),
      }
    })()
  const nextIdentity = fileIdentityOf(observed)
  let generation = source.generation
  if (nextIdentity !== null) {
    const changed = previousIdentity !== null
      && (previousIdentity.device !== nextIdentity.device
        || previousIdentity.inode !== nextIdentity.inode
        || previousIdentity.sha256 !== nextIdentity.sha256)
    if (changed || (previousIdentity === null && wasInstalled)) generation += 1
  }
  const lifecycleForState = observed.state === 'reserved-but-absent'
    ? (wasInstalled ? 'removed' : 'reserved')
    : observed.state === 'removed'
      ? 'removed'
      : observed.state === 'unverifiable'
        ? 'unverifiable'
        : 'observed'
  const nextLifecycle = lifecycle === undefined
    ? lifecycleForState
    : requireOneOf(lifecycle, NATIVE_LIFECYCLES, 'lifecycle')
  return Object.freeze({
    reservation: previousReservation,
    lifecycle: nextLifecycle,
    everObservedInstalled: wasInstalled || observed.file === 'owned',
    generation,
    fileIdentity: nextIdentity,
    observed,
    lastOperation: source.lastOperation ?? null,
    hostIdentities: Object.freeze(Array.isArray(source.hostIdentities) ? [...source.hostIdentities] : []),
    cleanup: source.cleanup ?? null,
  })
}

/**
 * The ONE reservation transaction: validate the Supervisor-owned inputs, ask
 * the fixed helper for the real OS facts, classify them, then durably write the
 * record BEFORE the caller may ACK the Worker. The function keeps no state; the
 * callback is the Supervisor's single receipt writer.
 */
export async function executeNativeServiceReservation({
  reservationInput,
  adapter,
  history = { everObservedInstalled: false },
  writeDurable,
  verifiedAt,
} = {}) {
  const reservation = buildReservationFacts(reservationInput)
  const source = requireObject(adapter, 'adapter', 'NATIVE_MANAGER_ADAPTER_INVALID')
  if (typeof source.inspectManagedService !== 'function') {
    fail('NATIVE_MANAGER_ADAPTER_INVALID', 'the platform helper exports no inspectManagedService')
  }
  if (typeof writeDurable !== 'function') {
    fail('NATIVE_RESERVATION_INVALID', 'the reservation requires a durable receipt writer')
  }
  const inspection = await source.inspectManagedService(reservation)
  assertManagedReservationObservable(inspection)
  const observation = classifyManagedInspection({
    reservation,
    history,
    inspection,
    verifiedAt: verifiedAt === undefined ? new Date().toISOString() : verifiedAt,
  })
  const record = nativeReservationRecord({ reservation, observation })
  await writeDurable(record)
  return Object.freeze({ reservation, observation, record })
}

/** Validate one recorded managed-Host identity before it authorizes cleanup. */
export function validateHostIdentity(identity) {
  const source = requireObject(identity, 'host identity', 'NATIVE_HOST_IDENTITY_INVALID')
  return Object.freeze({
    pid: requirePositiveInteger(source.pid, 'host identity pid', 'NATIVE_HOST_IDENTITY_INVALID'),
    scopeId: requireNonEmptyString(source.scopeId, 'host identity scopeId', 'NATIVE_HOST_IDENTITY_INVALID'),
    instanceId: requireNonEmptyString(source.instanceId, 'host identity instanceId', 'NATIVE_HOST_IDENTITY_INVALID'),
    kernelIdentity: requireNonEmptyString(source.kernelIdentity, 'host identity kernelIdentity', 'NATIVE_HOST_IDENTITY_INVALID'),
    buildId: requireSha256(source.buildId, 'host identity buildId'),
    source: requireOneOf(source.source,
      ['official-client-auth-record', 'official-registry-and-kernel-verified'],
      'host identity source', 'NATIVE_HOST_IDENTITY_INVALID'),
  })
}

/**
 * The native-only cleanup plan. Official stop/uninstall are used only for an
 * owned, verified definition of THIS run; unknown/foreign state goes straight
 * to the helper, which still has to re-prove ownership before it acts.
 */
export function planNativeCleanup({ reservation, observation } = {}) {
  validateReservationFacts(reservation)
  const observed = validateServiceObservation(observation)
  if (observed.state === 'reserved-but-absent' || observed.state === 'removed') {
    return Object.freeze({ actions: Object.freeze([]), reason: observed.state })
  }
  if (observed.state === 'unverifiable') {
    return Object.freeze({ actions: Object.freeze(['helper-reclaim']), reason: 'NATIVE_SERVICE_UNVERIFIABLE' })
  }
  const actions = observed.state === 'managed-active'
    ? ['official-stop', 'official-uninstall', 'helper-reclaim']
    : ['official-uninstall', 'helper-reclaim']
  return Object.freeze({ actions: Object.freeze(actions), reason: observed.state })
}

/**
 * The ONE native cleanup decision sequence. The Supervisor keeps the receipt
 * writer, cancellation and CLI ownership; this function keeps the shared
 * ordering: official stop/uninstall only for strictly owned state, helper
 * reclaim only as the last resort, then the terminal quiescence verdict.
 */
export async function cleanupNativeService({
  reservation,
  record,
  adapter,
  observe,
  runOfficialVerb,
  writeRecord,
  probeKernel,
  probeHostKernel,
  probeClients,
  verifiedAt,
} = {}) {
  const facts = validateReservationFacts(reservation)
  const source = requireObject(record, 'native record', 'NATIVE_OBSERVATION_INVALID')
  if (source.reservation === undefined || validateReservationFacts(source.reservation).unitPath !== facts.unitPath) {
    fail('NATIVE_RESERVATION_INVALID', 'the native record belongs to another reservation')
  }
  const helper = requireObject(adapter, 'adapter', 'NATIVE_MANAGER_ADAPTER_INVALID')
  if (typeof helper.reclaimManagedService !== 'function') {
    fail('NATIVE_MANAGER_ADAPTER_INVALID', 'the platform helper exports no reclaimManagedService')
  }
  for (const [name, callback] of Object.entries({ observe, runOfficialVerb, writeRecord, probeKernel, probeHostKernel, probeClients })) {
    if (typeof callback !== 'function') fail('NATIVE_CONTRACT_INVALID', `cleanupNativeService requires ${name}`)
  }
  const at = () => (verifiedAt === undefined ? new Date().toISOString() : verifiedAt)
  const cleanup = { attempted: true, officialStop: 'skipped', officialUninstall: 'skipped', fallback: 'skipped' }
  let current = { ...source, lifecycle: 'cleaning', cleanup }
  await writeRecord(current)
  const failCleanup = async code => {
    current = { ...current, lifecycle: 'unverifiable', cleanup: { ...cleanup, reason: code } }
    await writeRecord(current)
    return Object.freeze({ clean: false, reason: code, record: current })
  }
  let observation
  try {
    observation = validateServiceObservation(await observe())
  } catch {
    return await failCleanup('NATIVE_MANAGER_OBSERVATION_FAILED')
  }
  const plan = planNativeCleanup({ reservation: facts, observation })
  const runVerb = async verb => {
    try {
      await runOfficialVerb(verb)
      return 'exited-0'
    } catch (error) {
      return `failed:${String(error?.code ?? 'NATIVE_DAEMON_FAILED')}`
    }
  }
  if (plan.actions.includes('official-stop')) {
    cleanup.officialStop = await runVerb('stop')
    try {
      observation = validateServiceObservation(await observe())
    } catch {
      return await failCleanup('NATIVE_MANAGER_OBSERVATION_FAILED')
    }
  }
  if (plan.actions.includes('official-uninstall')) {
    cleanup.officialUninstall = await runVerb('uninstall')
    try {
      observation = validateServiceObservation(await observe())
    } catch {
      return await failCleanup('NATIVE_MANAGER_OBSERVATION_FAILED')
    }
  }
  if (observation.state !== 'removed' && observation.state !== 'reserved-but-absent') {
    let reclaimed
    try {
      reclaimed = await helper.reclaimManagedService({
        ...facts,
        fileIdentity: source.fileIdentity ?? null,
        verifiedHostIdentities: source.hostIdentities ?? [],
        generation: source.generation,
      })
    } catch {
      return await failCleanup('NATIVE_SERVICE_RECLAIM_FAILED')
    }
    cleanup.fallback = `${String(reclaimed?.action)}:${String(reclaimed?.reason)}`
    if (reclaimed?.clean !== true) return await failCleanup('NATIVE_SERVICE_PRESERVED')
    const inspection = requireObject(reclaimed.observation, 'reclaim observation', 'NATIVE_INSPECTION_INVALID')
    try {
      const kernel = inspection.mainPid === null ? null : await probeKernel(inspection.mainPid)
      observation = classifyManagedInspection({
        reservation: facts,
        history: { everObservedInstalled: source.everObservedInstalled === true },
        inspection,
        kernel,
        verifiedAt: at(),
      })
    } catch {
      return await failCleanup('NATIVE_MANAGER_OBSERVATION_FAILED')
    }
  }
  current = {
    ...current,
    lifecycle: observation.state === 'unverifiable' ? 'unverifiable' : 'removed',
    observed: observation,
    cleanup,
  }
  await writeRecord(current)
  const hostIdentities = Array.isArray(current.hostIdentities) ? current.hostIdentities : []
  const hostsGone = []
  for (const identity of hostIdentities) {
    const factsOfHost = validateHostIdentity(identity)
    hostsGone.push({ pid: factsOfHost.pid, status: await probeHostKernel(factsOfHost.pid) })
  }
  const clientsGone = await probeClients()
  const verdict = classifyNativeCleanup({
    observation: current.observed,
    hostIdentities,
    hostsGone,
    clientsGone,
  })
  current = {
    ...current,
    cleanup: { ...cleanup, ...(verdict.clean ? {} : { reason: verdict.reasons.join(',') }) },
  }
  await writeRecord(current)
  return Object.freeze({ clean: verdict.clean, reason: verdict.clean ? null : verdict.reasons.join(','), record: current })
}

/**
 * The terminal cleanup verdict. A Scene root may be removed only when the
 * service is confirmed removed/absent and every recorded Host/Client identity
 * is proven gone or replaced by a different kernel process.
 */
export function classifyNativeCleanup({ observation, hostIdentities = [], hostsGone = [], clientsGone = [] } = {}) {
  const observed = validateServiceObservation(observation)
  const reasons = []
  if (observed.state !== 'removed' && observed.state !== 'reserved-but-absent') {
    reasons.push('NATIVE_SERVICE_NOT_REMOVED')
  }
  if (!Array.isArray(hostsGone)) fail('NATIVE_CONTRACT_INVALID', 'hostsGone must be an array')
  if (!Array.isArray(clientsGone)) fail('NATIVE_CONTRACT_INVALID', 'clientsGone must be an array')
  const recorded = new Map()
  for (const identity of hostIdentities) {
    const facts = validateHostIdentity(identity)
    recorded.set(facts.pid, facts)
  }
  const covered = new Set()
  for (const host of hostsGone) {
    const source = requireObject(host, 'hostsGone entry', 'NATIVE_CONTRACT_INVALID')
    const pid = requirePositiveInteger(source.pid, 'hostsGone.pid', 'NATIVE_CONTRACT_INVALID')
    const status = requireOneOf(source.status, KERNEL_STATES, 'hostsGone.status', 'NATIVE_CONTRACT_INVALID')
    if (!recorded.has(pid)) continue
    covered.add(pid)
    if (status !== 'gone' && status !== 'different') reasons.push('MANAGED_HOST_STILL_ALIVE')
  }
  for (const pid of recorded.keys()) {
    if (!covered.has(pid)) reasons.push('MANAGED_HOST_UNPROVEN')
  }
  for (const client of clientsGone) {
    const source = requireObject(client, 'clientsGone entry', 'NATIVE_CONTRACT_INVALID')
    requireNonEmptyString(source.label, 'clientsGone.label', 'NATIVE_CONTRACT_INVALID')
    if (source.gone !== true) reasons.push('NATIVE_CLIENT_STILL_ALIVE')
  }
  return Object.freeze({ clean: reasons.length === 0, reasons: Object.freeze(reasons) })
}

/**
 * Validate one installed Profile against the native pair rules. The default
 * policy never reaches this function; the native policy additionally refuses a
 * same-SemVer pair that installed the SAME production build id.
 */
export function assertNativeManagedProfileInstall({ role, pair, oldBuildId, installed } = {}) {
  requireOneOf(role, ['old', 'new'], 'role', 'NATIVE_PROFILE_INSTALL_INVALID')
  const artifacts = requireObject(pair, 'pair')
  const oldArtifact = requireObject(artifacts.old, 'pair.old')
  const newArtifact = requireObject(artifacts.new, 'pair.new')
  const facts = requireObject(installed, 'installed package facts', 'NATIVE_PROFILE_INSTALL_INVALID')
  const version = requireNonEmptyString(facts.version, 'installed.version', 'NATIVE_PROFILE_INSTALL_INVALID')
  const buildId = requireSha256(facts.buildId, 'installed.buildId')
  const payloadHash = requireSha256(facts.payloadHash, 'installed.payloadHash')
  const packageRoot = requireAbsolutePath(facts.packageRoot, 'installed.packageRoot')
  const entries = requireObject(facts.entries, 'installed.entries', 'NATIVE_PROFILE_INSTALL_INVALID')
  requireAbsolutePath(entries.host, 'installed.entries.host')
  requireAbsolutePath(entries.client, 'installed.entries.client')
  if (role === 'old') {
    if (version !== oldArtifact.version) {
      fail('NATIVE_ROLLBACK_VERSION_MISMATCH', 'the rollback install did not restore the old package version')
    }
    if (buildId !== oldBuildId) {
      fail('NATIVE_ROLLBACK_BUILD_MISMATCH', 'the rollback install did not restore the old production build id')
    }
  } else {
    if (version !== newArtifact.version) {
      fail('NATIVE_PROFILE_INSTALL_INVALID', 'the new Profile install did not produce the new package version')
    }
    if (oldArtifact.version === newArtifact.version && buildId === oldBuildId) {
      fail('INPUT_PAIR_BUILD_ID_EQUAL', 'the same-SemVer native pair produced identical production build ids')
    }
  }
  return Object.freeze({ version, buildId, payloadHash, packageRoot, entries: Object.freeze({ host: entries.host, client: entries.client }) })
}

/**
 * Compare the installed Profile found on disk with the Supervisor's own current
 * install receipt. Only this receipt may name the Client entry a native Client
 * is spawned from; a forged Worker build id cannot satisfy it.
 */
export function classifyCurrentProfile({ receipt, current } = {}) {
  const recorded = requireObject(receipt, 'current profile receipt', 'NATIVE_PROFILE_INSTALL_INVALID')
  const onDisk = requireObject(current, 'on-disk profile facts', 'NATIVE_PROFILE_INSTALL_INVALID')
  for (const key of ['role', 'installGeneration', 'version', 'buildId', 'payloadHash', 'packageRoot']) {
    if (recorded[key] === undefined) fail('NATIVE_PROFILE_INSTALL_INVALID', `the current profile receipt carries no ${key}`)
  }
  const entries = requireObject(recorded.entries, 'current profile receipt entries', 'NATIVE_PROFILE_INSTALL_INVALID')
  const diskEntries = requireObject(onDisk.entries, 'on-disk profile entries', 'NATIVE_PROFILE_INSTALL_INVALID')
  const mismatched = recorded.packageRoot !== onDisk.packageRoot
    || recorded.version !== onDisk.version
    || recorded.buildId !== onDisk.buildId
    || recorded.payloadHash !== onDisk.payloadHash
    || entries.client !== diskEntries.client
    || entries.host !== diskEntries.host
  return Object.freeze({
    current: !mismatched,
    reason: mismatched ? 'NATIVE_PROFILE_ENTRY_STALE' : null,
  })
}

/** The fixed key=value block `daemon status` prints; unknown keys are ignored. */
export function parseManagedDaemonStatus(stdout) {
  if (typeof stdout !== 'string') fail('NATIVE_DAEMON_STATUS_INVALID', 'daemon status output must be text')
  const fields = {}
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at)
    fields[key] = line.slice(at + 1).trim()
  }
  const requireField = key => {
    if (typeof fields[key] !== 'string' || fields[key] === '') {
      fail('NATIVE_DAEMON_STATUS_INVALID', `daemon status output has no ${key}`)
    }
    return fields[key]
  }
  const status = {
    profile: requireField('profile'),
    manager: requireField('manager'),
    userManager: requireField('user-manager'),
    host: requireField('host'),
    unit: requireField('unit'),
    unitState: requireField('unit-state'),
    compatibility: requireField('compatibility'),
  }
  if (fields.pid !== undefined) {
    const pid = Number(fields.pid)
    if (!Number.isSafeInteger(pid) || pid <= 0) fail('NATIVE_DAEMON_STATUS_INVALID', 'daemon status pid is not a positive integer')
    status.pid = pid
  }
  if (fields.instance !== undefined) status.instance = fields.instance
  return Object.freeze(status)
}

/**
 * Build the verified env of ONE official daemon CLI child. DSH data stays in
 * the Scene-private HOME/DSH_HOME; only the real user-runtime/DBus facts are
 * added, and only when the Supervisor already proved them.
 */
export function buildNativeDaemonEnvironment({ baseEnv, platform = process.platform, runtimeDir = null, busPath = null } = {}) {
  const env = { ...requireStringEnvironment(baseEnv, 'baseEnv') }
  if (platform === 'linux') {
    if (typeof runtimeDir !== 'string' || runtimeDir === '' || !isAbsolute(runtimeDir)) {
      fail('NATIVE_SYSTEMD_USER_ENV_UNAVAILABLE', 'the verified user runtime directory is required on Linux')
    }
    env.XDG_RUNTIME_DIR = runtimeDir
    if (typeof busPath === 'string' && busPath !== '' && isAbsolute(busPath)) {
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`
    } else {
      delete env.DBUS_SESSION_BUS_ADDRESS
    }
    return env
  }
  if (platform === 'darwin') {
    delete env.XDG_RUNTIME_DIR
    delete env.DBUS_SESSION_BUS_ADDRESS
    return env
  }
  fail('NATIVE_MANAGER_PLATFORM_MISMATCH', `no daemon CLI environment is defined for ${String(platform)}`)
}

/** Replace bounded credential material in captured CLI output. */
export function sanitizeDaemonOutput(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)\s*[:=]\s*)[^\r\n]+/giu, '$1[redacted]')
    .replace(/([?&][A-Za-z0-9_.~-]*(?:token|secret|credential|password|api[_-]?key)[A-Za-z0-9_.~-]*=)[^&\s]+/giu, '$1[redacted]')
    .replace(/(\b(?:token|secret|credential|password|api[_-]?key)=)[^&\s]+/giu, '$1[redacted]')
}

/** Serialize one product kernel identity into the receipt's stable string. */
export function serializeKernelIdentity(identity) {
  const source = requireObject(identity, 'kernel identity', 'NATIVE_CLIENT_IDENTITY_INVALID')
  if (source.platform === 'linux') {
    return `linux:${requireNonEmptyString(source.startTicks, 'kernel identity startTicks', 'NATIVE_CLIENT_IDENTITY_INVALID')}`
  }
  if (source.platform === 'darwin') {
    return [
      'darwin',
      requireNonEmptyString(source.bootUUID, 'kernel identity bootUUID', 'NATIVE_CLIENT_IDENTITY_INVALID'),
      requireNonEmptyString(source.uniqueId, 'kernel identity uniqueId', 'NATIVE_CLIENT_IDENTITY_INVALID'),
      requireNonEmptyString(source.processUUID, 'kernel identity processUUID', 'NATIVE_CLIENT_IDENTITY_INVALID'),
      requireNonEmptyString(source.startSec, 'kernel identity startSec', 'NATIVE_CLIENT_IDENTITY_INVALID'),
      requireNonEmptyString(source.startUsec, 'kernel identity startUsec', 'NATIVE_CLIENT_IDENTITY_INVALID'),
    ].join(':')
  }
  fail('NATIVE_CLIENT_IDENTITY_INVALID', `unsupported kernel identity platform ${String(source.platform)}`)
}

/**
 * The ONE native Client ownership decision. A numeric PID alone never
 * authorizes a signal: the same uid, the SAME kernel birth identity, the
 * registered run-owned scratch and the registered Client entry must all agree.
 */
export function classifyNativeClientOwnership({ registered, observed, sceneRoot, uid } = {}) {
  const recorded = requireObject(registered, 'registered client identity', 'NATIVE_CLIENT_IDENTITY_INVALID')
  const registeredPid = requirePositiveInteger(recorded.pid, 'registered.pid', 'NATIVE_CLIENT_IDENTITY_INVALID')
  const registeredUid = requirePositiveInteger(recorded.uid, 'registered.uid', 'NATIVE_CLIENT_IDENTITY_INVALID')
  const registeredBirth = requireNonEmptyString(recorded.birth, 'registered.birth', 'NATIVE_CLIENT_IDENTITY_INVALID')
  // A Client business process requires its run-owned scratch; the tui-test
  // shell may carry no SPLIT_PROCESS_SCRATCH and is proven by uid/birth/command.
  const registeredScratch = recorded.scratch === null || recorded.scratch === undefined
    ? null
    : requireAbsolutePath(recorded.scratch, 'registered.scratch', 'NATIVE_CLIENT_IDENTITY_INVALID')
  const registeredEntry = requireNonEmptyString(recorded.entry, 'registered.entry', 'NATIVE_CLIENT_IDENTITY_INVALID')
  const processUid = requirePositiveInteger(uid, 'uid', 'NATIVE_CLIENT_IDENTITY_INVALID')
  const root = requireAbsolutePath(sceneRoot, 'sceneRoot', 'NATIVE_CLIENT_IDENTITY_INVALID')
  if (registeredUid !== processUid) {
    return Object.freeze({ owned: false, reason: 'REGISTERED_UID_FOREIGN' })
  }
  if (registeredScratch !== null && !pathInside(root, registeredScratch)) {
    return Object.freeze({ owned: false, reason: 'REGISTERED_SCRATCH_FOREIGN' })
  }
  if (observed === null || observed === undefined) {
    return Object.freeze({ owned: false, reason: 'PROCESS_IDENTITY_UNREADABLE' })
  }
  const live = requireObject(observed, 'observed client identity', 'NATIVE_CLIENT_IDENTITY_INVALID')
  if (requirePositiveInteger(live.pid, 'observed.pid', 'NATIVE_CLIENT_IDENTITY_INVALID') !== registeredPid) {
    return Object.freeze({ owned: false, reason: 'PID_MISMATCH' })
  }
  if (requirePositiveInteger(live.uid, 'observed.uid', 'NATIVE_CLIENT_IDENTITY_INVALID') !== registeredUid) {
    return Object.freeze({ owned: false, reason: 'UID_MISMATCH' })
  }
  if (requireNonEmptyString(live.birth, 'observed.birth', 'NATIVE_CLIENT_IDENTITY_INVALID') !== registeredBirth) {
    return Object.freeze({ owned: false, reason: 'PID_REUSED' })
  }
  if (registeredScratch !== null) {
    if (requireAbsolutePath(live.scratch, 'observed.scratch', 'NATIVE_CLIENT_IDENTITY_INVALID') !== registeredScratch) {
      return Object.freeze({ owned: false, reason: 'SCRATCH_FOREIGN' })
    }
  } else if (live.scratch !== null && live.scratch !== undefined) {
    return Object.freeze({ owned: false, reason: 'SCRATCH_FOREIGN' })
  }
  if (requireNonEmptyString(live.entry, 'observed.entry', 'NATIVE_CLIENT_IDENTITY_INVALID') !== registeredEntry) {
    return Object.freeze({ owned: false, reason: 'ENTRY_MISMATCH' })
  }
  return Object.freeze({ owned: true, reason: null })
}

/**
 * Combine a primary native failure and a cleanup failure without losing
 * either reason. With one reason the original error is returned unchanged.
 */
export function combineNativeFailures(primary, cleanup) {
  if (primary === undefined) return cleanup
  if (cleanup === undefined) return primary
  return new AggregateError([primary, cleanup], 'the native operation failed and its cleanup also failed')
}

/**
 * The exact official daemon CLI child. `onIssued` is the commit point: the
 * Supervisor persists `phase=ISSUED` BEFORE the spawn. Only this exact child is
 * ever signalled on timeout/abort; a timeout never escalates to a service PID.
 */
export async function runFixedDaemonVerb({ installation, verb, abortSignal = null, hooks = {}, spawnImpl = spawn, timing } = {}) {
  const action = requireManagedDaemonVerb(verb)
  const source = requireObject(installation, 'installation', 'NATIVE_DAEMON_INSTALLATION_INVALID')
  if (!Array.isArray(source.dshInvocation) || source.dshInvocation.length < 2
    || source.dshInvocation.some(value => typeof value !== 'string' || value === '')) {
    fail('NATIVE_DAEMON_INSTALLATION_INVALID', 'installation.dshInvocation must be the executable plus its entry')
  }
  const profileDir = requireAbsolutePath(source.profileDir, 'installation.profileDir', 'NATIVE_DAEMON_INSTALLATION_INVALID')
  const env = buildNativeDaemonEnvironment({
    baseEnv: source.env,
    platform: source.platform ?? process.platform,
    runtimeDir: source.runtimeDir ?? null,
    busPath: source.busPath ?? null,
  })
  requireObject(hooks, 'hooks')
  for (const [name, hook] of Object.entries(hooks)) {
    if (!['onIssued', 'onSpawned', 'onExited', 'onNotQuiesced'].includes(name) || typeof hook !== 'function') {
      fail('NATIVE_CONTRACT_INVALID', `unsupported daemon verb hook ${name}`)
    }
  }
  // Simulated node:test runs may shorten the real grace windows; the
  // Supervisor never passes `timing`, so production always uses the constants.
  const windows = timing === undefined
    ? { deadlineMs: MANAGED_DAEMON_DEADLINES[action], termGraceMs: MANAGED_DAEMON_TERM_GRACE_MS, killGraceMs: MANAGED_DAEMON_KILL_GRACE_MS }
    : (() => {
      const provided = requireObject(timing, 'timing')
      const pick = (key, fallback) => {
        if (provided[key] === undefined) return fallback
        const value = requirePositiveInteger(provided[key], `timing.${key}`, 'NATIVE_CONTRACT_INVALID')
        return value
      }
      return {
        deadlineMs: pick('deadlineMs', MANAGED_DAEMON_DEADLINES[action]),
        termGraceMs: pick('termGraceMs', MANAGED_DAEMON_TERM_GRACE_MS),
        killGraceMs: pick('killGraceMs', MANAGED_DAEMON_KILL_GRACE_MS),
      }
    })()
  if (abortSignal !== null && typeof abortSignal?.aborted !== 'boolean') {
    fail('NATIVE_CONTRACT_INVALID', 'abortSignal must be an AbortSignal or null')
  }
  if (abortSignal?.aborted === true) {
    const error = contractError('NATIVE_DAEMON_CANCELLED', `daemon ${action} was cancelled before it was issued`)
    // The previous lastOperation stays the truth: this command never committed.
    error.issued = false
    throw error
  }
  const argv = [...source.dshInvocation.slice(1), '--profile', NATIVE_PROFILE, 'daemon', action]
  await hooks.onIssued?.({ verb: action, at: new Date().toISOString() })

  let child
  try {
    child = spawnImpl(source.dshInvocation[0], argv, {
      shell: false,
      cwd: profileDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw contractError('NATIVE_DAEMON_SPAWN_FAILED', `daemon ${action} could not be spawned`, error)
  }
  if (child?.pid === undefined || child.pid === null) {
    throw contractError('NATIVE_DAEMON_SPAWN_FAILED', `daemon ${action} produced no child process`)
  }
  await hooks.onSpawned?.({ verb: action, pid: child.pid, at: new Date().toISOString() })

  let stdoutBytes = 0
  let stderrBytes = 0
  let outputLimitExceeded = false
  let stdout = ''
  let stderr = ''
  const collect = (chunk, stream) => {
    const size = Buffer.byteLength(chunk)
    if (stream === 'stdout') {
      stdoutBytes += size
      if (stdoutBytes > MANAGED_DAEMON_OUTPUT_LIMIT_BYTES) outputLimitExceeded = true
      else stdout += chunk
      return
    }
    stderrBytes += size
    if (stderrBytes > MANAGED_DAEMON_OUTPUT_LIMIT_BYTES) outputLimitExceeded = true
    else stderr += chunk
  }
  child.stdout?.setEncoding('utf8')
  child.stderr?.setEncoding('utf8')
  // Both streams are always drained, even after the byte cap, so a verbose
  // command can never deadlock on a full pipe.
  child.stdout?.on('data', chunk => collect(chunk, 'stdout'))
  child.stderr?.on('data', chunk => collect(chunk, 'stderr'))

  let spawnError
  let closed = false
  const closePromise = new Promise((resolve, reject) => {
    child.once('error', error => {
      spawnError = error
      if (child.pid === undefined) reject(error)
    })
    child.once('close', (code, signal) => {
      closed = true
      resolve({ code, signal })
    })
  })
  let timedOut = false
  let cancelled = false
  let forceResolve
  const forcePromise = new Promise(resolve => { forceResolve = resolve })
  let killTimer
  let forceTimer
  const terminate = () => {
    if (closed) return
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    killTimer = setTimeout(() => {
      if (closed) return
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, windows.termGraceMs)
    forceTimer = setTimeout(() => {
      if (!closed) forceResolve()
    }, windows.termGraceMs + windows.killGraceMs)
  }
  const deadlineTimer = setTimeout(() => {
    timedOut = true
    terminate()
  }, windows.deadlineMs)
  const onAbort = () => {
    cancelled = true
    terminate()
  }
  abortSignal?.addEventListener('abort', onAbort, { once: true })
  const raced = await Promise.race([
    closePromise.then(value => ({ settled: true, value }), error => ({ settled: false, error })),
    forcePromise.then(() => ({ forced: true })),
  ])
  clearTimeout(deadlineTimer)
  if (killTimer !== undefined) clearTimeout(killTimer)
  if (forceTimer !== undefined) clearTimeout(forceTimer)
  abortSignal?.removeEventListener('abort', onAbort)
  if (raced.forced === true) {
    await hooks.onNotQuiesced?.({ verb: action, pid: child.pid, at: new Date().toISOString() })
    throw contractError('NOT_QUIESCED', `daemon ${action} child ${String(child.pid)} did not exit after TERM/KILL`)
  }
  if (raced.settled === false) {
    throw contractError('NATIVE_DAEMON_SPAWN_FAILED', `daemon ${action} could not be spawned`, raced.error ?? spawnError)
  }
  const exit = raced.value
  await hooks.onExited?.({
    verb: action,
    pid: child.pid,
    exitCode: exit.code ?? null,
    signal: exit.signal ?? null,
    stdoutBytes,
    stderrBytes,
    outputLimitExceeded,
    at: new Date().toISOString(),
  })
  if (outputLimitExceeded) {
    throw contractError('OUTPUT_LIMIT_EXCEEDED', `daemon ${action} output exceeded ${String(MANAGED_DAEMON_OUTPUT_LIMIT_BYTES)} bytes per stream`)
  }
  if (timedOut) {
    throw contractError('NATIVE_DAEMON_TIMEOUT', `daemon ${action} exceeded its ${String(windows.deadlineMs)}ms deadline`)
  }
  if (cancelled) {
    const error = contractError('NATIVE_DAEMON_CANCELLED', `daemon ${action} was cancelled`)
    error.issued = true
    throw error
  }
  if (spawnError !== undefined || (exit.code === null && exit.signal === null)) {
    throw contractError('NATIVE_DAEMON_SPAWN_FAILED', `daemon ${action} did not run`, spawnError)
  }
  if (exit.signal !== null) {
    throw contractError('NATIVE_DAEMON_SIGNALLED', `daemon ${action} exited on signal ${String(exit.signal)}`)
  }
  if (exit.code !== 0) {
    throw contractError('NATIVE_DAEMON_FAILED', `daemon ${action} exited with code ${String(exit.code)}`)
  }
  return Object.freeze({
    exitCode: exit.code,
    stdout: sanitizeDaemonOutput(stdout),
    stderr: sanitizeDaemonOutput(stderr),
  })
}

/** The exact launchd customization this bridge admits; unknown input refuses. */
export function requireLaunchdCustomization(input) {
  const source = requireObject(input, 'customization', 'NATIVE_CUSTOMIZE_INVALID')
  for (const key of Object.keys(source)) {
    if (!Object.hasOwn(LAUNCHD_CUSTOMIZATION, key)) {
      fail('NATIVE_CUSTOMIZE_INVALID', `unsupported customization field ${key}`)
    }
  }
  for (const [key, expected] of Object.entries(LAUNCHD_CUSTOMIZATION)) {
    if (source[key] !== expected) {
      fail('NATIVE_CUSTOMIZE_INVALID', `the ${key} customization is not the fixed admitted value`)
    }
  }
  return LAUNCHD_CUSTOMIZATION
}
