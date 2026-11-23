/**
 * The launchd OS owner for one native split-upgrade managed service.
 *
 * The Split Supervisor owns every persistent fact (the durable reservation,
 * receipt, currentness and cleanup decision). This module only reads the real
 * LaunchAgent/launchctl state and performs the ONE bounded, owner-verified file
 * mutation the Supervisor requests. It exports the fixed platform-helper ABI
 * consumed by `loadNativeManagerAdapter()`:
 *
 *   - `inspectManagedService(reservation)`
 *   - `customizeManagedService(reservationWithFileIdentity, customization)`
 *   - `reclaimManagedService(reservationWithHistory)`
 *
 * It never starts, stops or restarts the Host, never creates a plist, never
 * writes before the Supervisor's durable reservation, and never acts on a
 * service whose exact canonical path, owner markers, scope, profile identity
 * and recorded file identity are not re-proven. A changed, foreign or
 * unreadable service is preserved and reported; the Supervisor decides
 * `NOT_QUIESCED`.
 *
 * The pure IO seam (`*WithIo()`) exists for the platform-level negative
 * controls: a same-label file with a different `(dev,ino,sha256)`, a foreign
 * owner marker, a loaded source path that is another file, or an unavailable
 * manager query must be refused without touching the real manager.
 *
 * @module split-upgrade-launchd-manager
 */

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { parseLaunchctlPrint, runLaunchctl } from '../../src/app/remote-process/local-host-launchd.ts'
import { profileIdentityDigest } from '../../src/app/remote-process/local-host-manager.ts'
import {
  LAUNCHD_CUSTOMIZATION,
  NativeContractError,
  requireLaunchdCustomization,
  validateReservationFacts,
} from './split-upgrade-native-contract.mjs'

const LAUNCHCTL = '/bin/launchctl'
const PLUTIL = '/usr/bin/plutil'
const OWNER_MARKER = 'local-host-launchd-v1'
const ISOLATED_FLAG = 'SPLIT_VITEST_LAUNCHD_ISOLATED'
const ISOLATED_MARKER = '.dsh-pi-tui-launchd-test-isolated'
const PLIST_MODE = 0o600
const PLUTIL_TIMEOUT_MS = 5_000
const PLUTIL_MAX_OUTPUT_BYTES = 64 * 1024
const JOB_REMOVAL_TIMEOUT_MS = 5_000
const JOB_REMOVAL_POLL_MS = 100

/**
 * The exact generated `ProgramArguments` span the product renderer writes.
 * Only this byte-exact span is excluded from the non-generated owner digest;
 * a user-customized argv is not this span and stays part of the digest.
 */
const GENERATED_PROGRAM_ARGUMENTS = {
  head: '  <key>ProgramArguments</key>\n  <array>\n',
  tail: '  </array>\n',
}
/** The exact generated install-build span the product renderer writes. */
const GENERATED_INSTALL_BUILD = {
  head: '  <key>X-DshPiTuiInstallBuild</key>\n  <string>',
  tail: '</string>\n',
}

function fail(code, message, cause) {
  throw new NativeContractError(code, message, cause)
}

function assert(condition, code, message) {
  if (!condition) fail(code, message)
}

function asError(error) {
  return error instanceof Error ? error : new Error(String(error))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function fileIdentityOf(file) {
  return { device: file.device, inode: file.inode, sha256: file.sha256 }
}

function sameIdentity(left, right) {
  return left !== null
    && left !== undefined
    && right !== null
    && right !== undefined
    && left.device === right.device
    && left.inode === right.inode
    && left.sha256 === right.sha256
}

/** Decode one plist through the native decoder; structural input fails closed. */
function decodePlistJson(content) {
  const decoded = spawnSync(PLUTIL, ['-convert', 'json', '-o', '-', '--', '-'], {
    input: content,
    encoding: 'utf8',
    timeout: PLUTIL_TIMEOUT_MS,
    maxBuffer: PLUTIL_MAX_OUTPUT_BYTES,
  })
  if (decoded.error !== undefined || decoded.status !== 0
    || typeof decoded.stdout !== 'string' || decoded.stdout.trim() === '') {
    fail('NATIVE_INSPECTION_INVALID', 'launchd: the native plist decoder rejected the installed plist')
  }
  let parsed
  try {
    parsed = JSON.parse(decoded.stdout)
  } catch (error) {
    fail('NATIVE_INSPECTION_INVALID', 'launchd: the native plist decoder did not produce JSON', error)
  }
  if (!isPlainObject(parsed)) fail('NATIVE_INSPECTION_INVALID', 'launchd: the plist root is not a dictionary')
  return parsed
}

/** Run the native plist lint on one fully written temp file. */
function lintPlist(path) {
  const linted = spawnSync(PLUTIL, ['-lint', '-s', '--', path], {
    encoding: 'utf8',
    timeout: PLUTIL_TIMEOUT_MS,
    maxBuffer: PLUTIL_MAX_OUTPUT_BYTES,
  })
  if (linted.error !== undefined || linted.status !== 0) {
    fail('NATIVE_CUSTOMIZE_INVALID', 'launchd: the customized plist failed the native lint')
  }
}

/** Write one NEW temp file as 0600 without following a final symlink. */
function writeNewFile(path, content) {
  let fd
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, PLIST_MODE)
    fchmodSync(fd, PLIST_MODE)
    const buffer = Buffer.from(content, 'utf8')
    let offset = 0
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(path) } catch { /* the temp file may not exist */ }
    fail('NATIVE_CUSTOMIZE_INVALID', 'launchd: the customized plist temp file could not be written', error)
  }
}

const defaultIo = Object.freeze({
  lstat: path => lstatSync(path),
  readFile: path => readFileSync(path, 'utf8'),
  realpath: path => realpathSync(path),
  launchctl: (args, options) => runLaunchctl(args, options),
  decodePlist: content => decodePlistJson(content),
  lintPlist: path => lintPlist(path),
  writeTempFile: (path, content) => writeNewFile(path, content),
  rename: (from, to) => renameSync(from, to),
  unlink: path => unlinkSync(path),
  sleep: ms => sleep(ms),
  now: () => Date.now(),
  profileIdentityDigest,
})

/**
 * Read and classify the ONE named plist file. `owned` requires the canonical
 * target, a regular 0600 non-symlink file owned by this uid, and the product
 * owner/scope/profile-identity metadata plus the two fixed profile anchors.
 */
function readPlistFile(io, reservation) {
  const filePath = reservation.unitPath
  let stats
  try {
    stats = io.lstat(filePath)
  } catch (error) {
    if (asError(error).code === 'ENOENT') return { kind: 'absent', filePath, resolvedPath: null, reason: null }
    return { kind: 'unverifiable', filePath, resolvedPath: null, reason: 'PLIST_PATH_UNREADABLE' }
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    return { kind: 'unverifiable', filePath, resolvedPath: null, reason: 'PLIST_NOT_A_REGULAR_FILE' }
  }
  if (typeof stats.uid === 'number' && stats.uid !== reservation.uid) {
    return { kind: 'foreign', filePath, resolvedPath: null, reason: 'FOREIGN_FILE_OWNER' }
  }
  if ((stats.mode & 0o7777) !== PLIST_MODE) {
    return { kind: 'unverifiable', filePath, resolvedPath: null, reason: 'PLIST_MODE_NOT_0600' }
  }
  let content
  let resolvedPath
  try {
    content = io.readFile(filePath)
    resolvedPath = io.realpath(filePath)
  } catch (error) {
    return { kind: 'unverifiable', filePath, resolvedPath: null, reason: 'PLIST_UNREADABLE' }
  }
  let decoded
  try {
    decoded = io.decodePlist(content)
  } catch (error) {
    return { kind: 'unverifiable', filePath, resolvedPath, reason: 'PLIST_DECODE_FAILED' }
  }
  const label = decoded.Label
  const owner = decoded['X-DshPiTuiOwner']
  const scopeId = decoded['X-DshPiTuiScopeId']
  const recordedProfileIdentity = decoded['X-DshPiTuiProfileIdentity']
  const installBuild = decoded['X-DshPiTuiInstallBuild']
  const environment = decoded.EnvironmentVariables
  if (label !== reservation.unitName) {
    return { kind: 'foreign', filePath, resolvedPath, reason: 'PLIST_LABEL_MISMATCH' }
  }
  if (owner !== OWNER_MARKER) {
    return { kind: 'foreign', filePath, resolvedPath, reason: 'FOREIGN_OWNER_MARKER' }
  }
  if (scopeId !== reservation.scopeId) {
    return { kind: 'foreign', filePath, resolvedPath, reason: 'PLIST_SCOPE_MISMATCH' }
  }
  let expectedProfileIdentity
  try {
    expectedProfileIdentity = io.profileIdentityDigest(reservation.profileRealpath)
  } catch (error) {
    return { kind: 'unverifiable', filePath, resolvedPath, reason: 'PROFILE_IDENTITY_UNAVAILABLE' }
  }
  if (recordedProfileIdentity !== expectedProfileIdentity) {
    return { kind: 'foreign', filePath, resolvedPath, reason: 'PLIST_PROFILE_IDENTITY_MISMATCH' }
  }
  if (typeof installBuild !== 'string' || !/^[0-9a-f]{64}$/u.test(installBuild)) {
    return { kind: 'unverifiable', filePath, resolvedPath, reason: 'PLIST_INSTALL_BUILD_INVALID' }
  }
  if (!isPlainObject(environment)) {
    return { kind: 'unverifiable', filePath, resolvedPath, reason: 'PLIST_ENVIRONMENT_MISSING' }
  }
  if (environment.DSH_HOME !== reservation.dshHome
    || environment.SPLIT_PROCESS_PROFILE !== reservation.profile
    || typeof environment.SPLIT_PROCESS_DSH_ANCHOR !== 'string'
    || environment.SPLIT_PROCESS_DSH_ANCHOR === '') {
    return { kind: 'foreign', filePath, resolvedPath, reason: 'PLIST_PROFILE_ANCHOR_MISMATCH' }
  }
  const programArguments = Array.isArray(decoded.ProgramArguments)
    && decoded.ProgramArguments.every(value => typeof value === 'string')
    ? [...decoded.ProgramArguments]
    : null
  return {
    kind: 'owned',
    filePath,
    resolvedPath,
    reason: null,
    mode: stats.mode & 0o7777,
    device: String(stats.dev),
    inode: String(stats.ino),
    sha256: sha256(content),
    content,
    decoded,
    owner,
    scopeId,
    profileIdentity: recordedProfileIdentity,
    installBuild,
    programArguments,
    nonGeneratedSha256: nonGeneratedDigest(content),
  }
}

/**
 * The owner digest of all bytes OUTSIDE the product's generated
 * `ProgramArguments` and `X-DshPiTuiInstallBuild` spans. It is the durable
 * witness that an explicit restart migrated only generated bytes and preserved
 * every user-authored byte (comments, extra environment keys, formatting).
 */
function nonGeneratedDigest(content) {
  let withoutGenerated = content
  const programStart = withoutGenerated.indexOf(GENERATED_PROGRAM_ARGUMENTS.head)
  if (programStart >= 0) {
    const programEnd = withoutGenerated.indexOf(GENERATED_PROGRAM_ARGUMENTS.tail, programStart + GENERATED_PROGRAM_ARGUMENTS.head.length)
    if (programEnd >= 0) {
      const end = programEnd + GENERATED_PROGRAM_ARGUMENTS.tail.length
      withoutGenerated = withoutGenerated.slice(0, programStart) + withoutGenerated.slice(end)
    }
  }
  const buildStart = withoutGenerated.indexOf(GENERATED_INSTALL_BUILD.head)
  if (buildStart >= 0) {
    const valueStart = buildStart + GENERATED_INSTALL_BUILD.head.length
    const valueEnd = withoutGenerated.indexOf(GENERATED_INSTALL_BUILD.tail, valueStart)
    if (valueEnd >= 0 && /^[0-9a-f]{64}$/u.test(withoutGenerated.slice(valueStart, valueEnd))) {
      withoutGenerated = withoutGenerated.slice(0, valueStart) + '<install-build>' + withoutGenerated.slice(valueEnd)
    }
  }
  return sha256(withoutGenerated)
}

/** Query the ONE fixed job label and return the real manager state. */
async function queryLaunchdJob(io, reservation) {
  const result = await io.launchctl(['print', `gui/${String(reservation.uid)}/${reservation.unitName}`])
  if (result.kind !== 'exited') {
    return { managerState: 'unknown', managerObserved: false, reason: `MANAGER_QUERY_${String(result.kind).toUpperCase()}`, service: null }
  }
  if (result.code === 113) return { managerState: 'not-loaded', managerObserved: true, reason: null, service: null }
  if (result.code !== 0) {
    return {
      managerState: 'unknown',
      managerObserved: false,
      reason: result.code === 112 ? 'GUI_DOMAIN_UNAVAILABLE' : `MANAGER_QUERY_EXIT_${String(result.code)}`,
      service: null,
    }
  }
  const service = parseLaunchctlPrint(result.stdout)
  if (service === undefined) {
    return { managerState: 'unknown', managerObserved: false, reason: 'MANAGER_OUTPUT_UNRECOGNIZED', service: null }
  }
  const pid = service.pid ?? null
  let managerState
  if (service.state === 'running') managerState = pid === null ? 'unknown' : 'active'
  else if (service.state === 'not running') managerState = pid === null ? 'inactive' : 'unknown'
  else managerState = 'unknown'
  return { managerState, managerObserved: true, reason: null, service }
}

/** Normalize one file + manager observation into the bridge's raw ABI shape. */
function buildInspection(io, reservation, file, job) {
  const loaded = job.service !== null
  let ownerVerified = file.kind === 'owned'
  let reason = file.reason ?? job.reason ?? null
  if (file.kind === 'owned' && loaded) {
    const sameSource = job.service.path === file.resolvedPath || (() => {
      try {
        return io.realpath(job.service.path) === file.resolvedPath
      } catch {
        return false
      }
    })()
    const environment = job.service.environment
    const sameAnchors = isPlainObject(environment)
      && environment.DSH_HOME === reservation.dshHome
      && environment.SPLIT_PROCESS_PROFILE === reservation.profile
      && typeof environment.SPLIT_PROCESS_DSH_ANCHOR === 'string'
      && environment.SPLIT_PROCESS_DSH_ANCHOR !== ''
    ownerVerified = sameSource && sameAnchors
    if (!sameSource) reason = 'LOADED_SOURCE_NOT_THIS_PLIST'
    else if (!sameAnchors) reason = 'PROFILE_ANCHORS_CHANGED'
  }
  return {
    file: file.kind,
    managerState: job.managerState,
    ownerVerified,
    managerObserved: job.managerObserved,
    unitName: reservation.unitName,
    unitPath: reservation.unitPath,
    fragmentPath: null,
    sourcePath: loaded ? job.service.path : null,
    mainPid: loaded ? (job.service.pid ?? null) : null,
    loadState: null,
    activeState: null,
    unitFileState: null,
    jobState: loaded ? job.service.state : null,
    fileFacts: file.kind === 'owned'
      ? {
        mode: file.mode,
        sha256: file.sha256,
        device: file.device,
        inode: file.inode,
        owner: file.owner,
        scopeId: file.scopeId,
        profileIdentity: file.profileIdentity,
        installBuild: file.installBuild,
        execStart: null,
        programArguments: file.programArguments,
        nonGeneratedSha256: file.nonGeneratedSha256,
      }
      : null,
    reason,
  }
}

/**
 * The adapter's read-only inspection. The reservation is validated first; a
 * helper loaded for another manager refuses before reading any OS state.
 */
export async function inspectManagedService(reservation) {
  return await inspectManagedServiceWithIo(reservation, defaultIo)
}

/** The IO-seam inspection used by the platform negative controls. */
export async function inspectManagedServiceWithIo(reservation, io = defaultIo) {
  const facts = validateReservationFacts(reservation)
  assert(facts.manager === 'launchd', 'NATIVE_MANAGER_KIND_INVALID', 'the launchd manager helper received another manager kind')
  const file = readPlistFile(io, facts)
  const job = await queryLaunchdJob(io, facts)
  return buildInspection(io, facts, file, job)
}

/** The fixed customization is already committed byte-for-byte. */
function customizationPresent(content, decoded, customization) {
  if (!isPlainObject(decoded.EnvironmentVariables)) return false
  return decoded.EnvironmentVariables[customization.extraEnvironmentKey] === customization.value
    && content.includes(`<!-- ${customization.comment} -->`)
}

/** A conflicting or partial customization is never "completed" by a rewrite. */
function customizationConflict(decoded, customization) {
  return isPlainObject(decoded.EnvironmentVariables)
    && Object.hasOwn(decoded.EnvironmentVariables, customization.extraEnvironmentKey)
}

/**
 * Insert the fixed user environment key and human comment. The insertion is
 * lexical (the generated XML shape is fixed); the result is decoded again
 * before it can be written, and the native lint runs on the temp file.
 */
function insertCustomization(content, customization) {
  const environmentHead = '  <key>EnvironmentVariables</key>\n  <dict>\n'
  const environmentStart = content.indexOf(environmentHead)
  if (environmentStart < 0) fail('NATIVE_CUSTOMIZE_INVALID', 'launchd: the managed plist has no EnvironmentVariables dictionary')
  if (content.indexOf(environmentHead, environmentStart + 1) >= 0) {
    fail('NATIVE_CUSTOMIZE_INVALID', 'launchd: the managed plist has several EnvironmentVariables dictionaries')
  }
  const environmentEnd = content.indexOf('  </dict>\n', environmentStart + environmentHead.length)
  if (environmentEnd < 0) fail('NATIVE_CUSTOMIZE_INVALID', 'launchd: the EnvironmentVariables dictionary is not closed')
  const insertion = `    <key>${customization.extraEnvironmentKey}</key>\n    <string>${customization.value}</string>\n`
  let next = content.slice(0, environmentEnd) + insertion + content.slice(environmentEnd)
  const comment = `<!-- ${customization.comment} -->\n`
  const plistEnd = next.lastIndexOf('</plist>')
  if (plistEnd < 0) fail('NATIVE_CUSTOMIZE_INVALID', 'launchd: the managed plist has no closing plist element')
  next = next.slice(0, plistEnd) + comment + next.slice(plistEnd)
  return next
}

/** Re-read the file and require the exact captured identity before any write. */
function assertRecordedIdentity(io, reservation, recorded) {
  const current = readPlistFile(io, reservation)
  if (current.kind !== 'owned') fail('NATIVE_CUSTOMIZE_IDENTITY_MISMATCH', 'launchd: the managed plist is no longer an owned regular file')
  if (!sameIdentity(recorded, fileIdentityOf(current))) {
    fail('NATIVE_CUSTOMIZE_IDENTITY_MISMATCH', 'launchd: the managed plist changed after its recorded identity')
  }
  return current
}

/** Publish one customized plist through a same-directory atomic rename. */
function publishPlist(io, reservation, current, content) {
  const tempPath = join(dirname(current.filePath), `.${basename(current.filePath)}.${String(process.pid)}.${randomUUID()}.tmp`)
  let created = false
  try {
    io.writeTempFile(tempPath, content)
    created = true
    io.lintPlist(tempPath)
    io.rename(tempPath, current.filePath)
    created = false
  } catch (error) {
    if (created) {
      try { io.unlink(tempPath) } catch { /* the temp file may already be gone */ }
    }
    throw error
  }
  const written = readPlistFile(io, reservation)
  if (written.kind !== 'owned' || written.content !== content) {
    fail('NATIVE_CUSTOMIZE_INVALID', 'launchd: the customized plist could not be confirmed after the atomic replacement')
  }
  return written
}

/**
 * The one launchd user-customization transaction. The Supervisor has already
 * proven a strictly owned installed definition and passes the recorded file
 * identity from its durable receipt; this function re-proves that identity,
 * applies only the fixed admitted bytes and returns the NEW identity and raw
 * observation so the Supervisor can persist them before acknowledging.
 */
export async function customizeManagedService(reservationWithFileIdentity, customization) {
  return await customizeManagedServiceWithIo(reservationWithFileIdentity, customization, defaultIo)
}

/** The IO-seam customization used by the platform negative controls. */
export async function customizeManagedServiceWithIo(reservationWithFileIdentity, customization, io = defaultIo) {
  const reservation = validateReservationFacts(reservationWithFileIdentity)
  assert(reservation.manager === 'launchd', 'NATIVE_MANAGER_KIND_INVALID', 'the launchd manager helper received another manager kind')
  const fixed = requireLaunchdCustomization(customization)
  const before = await inspectManagedServiceWithIo(reservation, io)
  if (before.file !== 'owned' || before.ownerVerified !== true || before.fileFacts === null) {
    fail('NATIVE_CUSTOMIZE_UNOWNED', 'launchd: the managed plist is not strictly owned by this run')
  }
  if (before.managerState === 'unknown') {
    fail('NATIVE_CUSTOMIZE_UNOWNED', 'launchd: the loaded job state is not verifiable')
  }
  const current = assertRecordedIdentity(io, reservation, reservationWithFileIdentity.fileIdentity)
  if (customizationPresent(current.content, current.decoded, fixed)) {
    return { fileIdentity: fileIdentityOf(current), observation: before }
  }
  if (customizationConflict(current.decoded, fixed)) {
    fail('NATIVE_CUSTOMIZE_INVALID', 'launchd: the managed plist carries a conflicting user environment key')
  }
  const content = insertCustomization(current.content, fixed)
  const decoded = io.decodePlist(content)
  if (!isPlainObject(decoded.EnvironmentVariables)
    || decoded.EnvironmentVariables[fixed.extraEnvironmentKey] !== fixed.value) {
    fail('NATIVE_CUSTOMIZE_INVALID', 'launchd: the customized plist did not adopt the fixed user environment key')
  }
  if (!content.includes(`<!-- ${fixed.comment} -->`)) {
    fail('NATIVE_CUSTOMIZE_INVALID', 'launchd: the customized plist did not adopt the human comment')
  }
  const written = publishPlist(io, reservation, current, content)
  const after = await inspectManagedServiceWithIo(reservation, io)
  return { fileIdentity: fileIdentityOf(written), observation: after }
}

/** Bounded wait for the exact label to become genuinely not loaded. */
async function waitForJobRemoval(io, reservation) {
  const deadline = io.now() + JOB_REMOVAL_TIMEOUT_MS
  for (;;) {
    const job = await queryLaunchdJob(io, reservation)
    if (job.managerState === 'not-loaded' && job.managerObserved === true) return
    if (io.now() >= deadline) fail('NATIVE_RECLAIM_FAILED', 'launchd: the managed job did not leave the manager within the bounded window')
    await io.sleep(JOB_REMOVAL_POLL_MS)
  }
}

/**
 * The LAST-RESORT cleanup of one run-owned service. It is used only after the
 * Supervisor's official stop/uninstall did not confirm removal, and only when
 * the recorded file identity and (for a live job) an authenticated Host PID
 * still prove this run's exact service. Every unknown/foreign/changed state is
 * preserved for `NOT_QUIESCED`.
 */
export async function reclaimManagedService(reservationWithHistory) {
  return await reclaimManagedServiceWithIo(reservationWithHistory, defaultIo)
}

/** The IO-seam reclaim used by the platform negative controls. */
export async function reclaimManagedServiceWithIo(reservationWithHistory, io = defaultIo) {
  const reservation = validateReservationFacts(reservationWithHistory)
  assert(reservation.manager === 'launchd', 'NATIVE_MANAGER_KIND_INVALID', 'the launchd manager helper received another manager kind')
  const before = await inspectManagedServiceWithIo(reservation, io)
  if (before.file === 'absent') {
    if (before.managerState !== 'not-loaded') {
      return { action: 'preserve', reason: 'MANAGER_STATE_WITHOUT_FILE', clean: false, observation: before }
    }
    return { action: 'absent', reason: 'already-absent', clean: true, observation: before }
  }
  if (before.file !== 'owned' || before.ownerVerified !== true || before.fileFacts === null) {
    return { action: 'preserve', reason: before.reason ?? 'NATIVE_SERVICE_UNVERIFIABLE', clean: false, observation: before }
  }
  if (!sameIdentity(reservationWithHistory.fileIdentity, fileIdentityOf(before.fileFacts))) {
    return { action: 'preserve', reason: 'FILE_IDENTITY_CHANGED', clean: false, observation: before }
  }
  if (before.managerState === 'unknown') {
    return { action: 'preserve', reason: 'MANAGER_STATE_UNKNOWN', clean: false, observation: before }
  }
  if (before.managerState === 'active') {
    const pid = before.mainPid
    const proven = Number.isInteger(pid)
      && Array.isArray(reservationWithHistory.verifiedHostIdentities)
      && reservationWithHistory.verifiedHostIdentities.some(identity =>
        identity?.pid === pid && identity?.scopeId === reservation.scopeId)
    if (!proven) return { action: 'preserve', reason: 'NATIVE_HOST_UNPROVEN', clean: false, observation: before }
  }
  if (before.managerState === 'active' || before.managerState === 'inactive') {
    const booted = await io.launchctl(['bootout', `gui/${String(reservation.uid)}/${reservation.unitName}`])
    if (booted.kind !== 'exited' || (booted.code !== 0 && booted.code !== 3)) {
      fail('NATIVE_RECLAIM_FAILED', `launchd: bootout of the verified managed job failed (${String(booted.kind)}${booted.kind === 'exited' ? ` ${String(booted.code)}` : ''})`)
    }
    await waitForJobRemoval(io, reservation)
  }
  const current = assertRecordedIdentity(io, reservation, reservationWithHistory.fileIdentity)
  try {
    io.unlink(current.filePath)
  } catch (error) {
    if (asError(error).code !== 'ENOENT') {
      fail('NATIVE_RECLAIM_FAILED', 'launchd: the verified managed plist could not be removed', error)
    }
  }
  const after = await inspectManagedServiceWithIo(reservation, io)
  if (after.file !== 'absent' || after.managerState !== 'not-loaded' || after.managerObserved !== true) {
    return { action: 'preserve', reason: 'NATIVE_RECLAIM_UNCONFIRMED', clean: false, observation: after }
  }
  return { action: 'removed', reason: 'owner-verified-reclaim', clean: true, observation: after }
}

/**
 * The explicit test-layer environment gate. It performs only read-only
 * identity/domain queries and never touches a LaunchAgent. Every missing or
 * ambiguous fact is a controlled failure, never a skipped success.
 */
export async function preflightLaunchdTestEnvironment(io = defaultIo) {
  if (process.platform !== 'darwin') {
    fail('NATIVE_MACOS_ONLY', 'the native launchd scene requires a real macOS host')
  }
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    fail('NATIVE_MACOS_GUI_ENV_UNAVAILABLE', 'the native launchd scene requires a non-root local user')
  }
  if (process.env[ISOLATED_FLAG] !== '1') {
    fail('NATIVE_MACOS_GUI_ENV_UNAVAILABLE', `the ${ISOLATED_FLAG} opt-in is not set`)
  }
  const uid = process.getuid()
  const accountHome = io.realpath(userInfo().homedir)
  const markerPath = join(accountHome, ISOLATED_MARKER)
  let consoleUser
  try {
    consoleUser = io.lstat('/dev/console')
  } catch (error) {
    fail('NATIVE_MACOS_GUI_ENV_UNAVAILABLE', 'the current console/GUI account is not readable')
  }
  if (consoleUser.uid !== uid) {
    fail('NATIVE_MACOS_GUI_ENV_UNAVAILABLE', 'the current console GUI account is not this user')
  }
  let marker
  try {
    marker = io.lstat(markerPath)
  } catch (error) {
    fail('NATIVE_MACOS_GUI_ENV_UNAVAILABLE', `the isolated launchd test marker is absent: ${markerPath}`)
  }
  if (!marker.isFile() || marker.isSymbolicLink() || marker.uid !== uid) {
    fail('NATIVE_MACOS_GUI_ENV_UNAVAILABLE', 'the isolated launchd test marker is not a regular user-owned file')
  }
  const domain = await io.launchctl(['print', `gui/${String(uid)}`], { discardStdout: true })
  if (domain.kind !== 'exited' || domain.code !== 0) {
    fail('NATIVE_MACOS_GUI_ENV_UNAVAILABLE', 'the real gui/<uid> launchd domain is not queryable')
  }
  return { uid, accountHome, markerPath }
}

/** The fixed customization values this platform helper will ever admit. */
export { LAUNCHD_CUSTOMIZATION }
