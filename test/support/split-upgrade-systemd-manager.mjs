/**
 * The real systemd user-manager adapter for the native Upgrade Scene.
 *
 * The shared Supervisor owns the reservation, receipt and lifecycle. This
 * module owns only the systemctl and unit-file IO for ONE run-owned Profile
 * unit. `inspectManagedService` is read-only and may be imported by the
 * platform business test; `reclaimManagedService` is called only by the
 * Supervisor's terminal cleanup after the official stop/uninstall path has
 * failed.
 *
 * Every returned fact is raw OS data. The Supervisor classifies it; this module
 * never reports a normalized observation state and never acts on a path or PID
 * supplied by the Worker.
 *
 * @module split-upgrade-systemd-manager
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SYSTEMCTL = '/usr/bin/systemctl'
const SYSTEMCTL_TIMEOUT_MS = 15_000
const OUTPUT_LIMIT_BYTES = 64 * 1024
const MANAGER = 'systemd'
const OWNER_MARKER = 'local-host-manager-v1'
const UNIT_DIR = Object.freeze(['.config', 'systemd', 'user'])

function profileIdentityDigest(profileRealpath) {
  try {
    return createHash('sha256')
      .update(`dsh-pi-tui/profile-identity/1\0${realpathSync(profileRealpath)}`)
      .digest('hex')
  } catch {
    return undefined
  }
}

function readMetadata(lines, key) {
  const matches = lines.filter(line => line.startsWith(`${key}=`))
  if (matches.length !== 1) return undefined
  return matches[0].slice(key.length + 1)
}

function parseProperties(text) {
  const fields = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at <= 0) continue
    fields[line.slice(0, at)] = line.slice(at + 1).trim()
  }
  return fields
}

function nonEmpty(value) {
  return typeof value === 'string' && value !== '' ? value : null
}

function verifiedRuntimeDir(uid) {
  if (!Number.isInteger(uid) || uid <= 0) return undefined
  const path = `/run/user/${String(uid)}`
  try {
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) return undefined
    return path
  } catch {
    return undefined
  }
}

function managerEnvironment(uid) {
  const runtimeDir = verifiedRuntimeDir(uid)
  if (runtimeDir === undefined) return undefined
  const env = { ...process.env, XDG_RUNTIME_DIR: runtimeDir }
  const busPath = join(runtimeDir, 'bus')
  try {
    const bus = lstatSync(busPath)
    if (!bus.isSocket() || bus.isSymbolicLink() || bus.uid !== uid) {
      delete env.DBUS_SESSION_BUS_ADDRESS
    } else {
      env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`
    }
  } catch {
    delete env.DBUS_SESSION_BUS_ADDRESS
  }
  return { runtimeDir, env }
}

async function runSystemctl(args, env) {
  if (!existsSync(SYSTEMCTL)) return { ok: false }
  try {
    const result = await execFileAsync(SYSTEMCTL, [
      '--user',
      '--no-pager',
      '--no-ask-password',
      ...args,
    ], {
      encoding: 'utf8',
      timeout: SYSTEMCTL_TIMEOUT_MS,
      maxBuffer: OUTPUT_LIMIT_BYTES,
      env,
    })
    return { ok: true, stdout: result.stdout, stderr: result.stderr }
  } catch {
    return { ok: false }
  }
}

async function showUnit(reservation, manager) {
  if (manager === undefined) {
    return { observed: false, props: null, reason: 'SYSTEMD_RUNTIME_DIR_UNAVAILABLE' }
  }
  if (!existsSync(SYSTEMCTL)) {
    return { observed: false, props: null, reason: 'SYSTEMD_CLI_UNAVAILABLE' }
  }
  const result = await runSystemctl([
    'show',
    reservation.unitName,
    '-p', 'LoadState',
    '-p', 'ActiveState',
    '-p', 'FragmentPath',
    '-p', 'MainPID',
    '-p', 'UnitFileState',
  ], manager.env)
  if (!result.ok) return { observed: false, props: null, reason: 'SYSTEMD_SHOW_FAILED' }
  return { observed: true, props: parseProperties(result.stdout), reason: null }
}

function inspectUnitFile(reservation) {
  const expectedPath = join(reservation.accountHome, ...UNIT_DIR, reservation.unitName)
  if (reservation.unitPath !== expectedPath) {
    return { kind: 'unverifiable', reason: 'RESERVATION_UNIT_PATH_MISMATCH', resolvedPath: null, fileFacts: null }
  }
  let pathInfo
  try {
    pathInfo = lstatSync(reservation.unitPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'absent', reason: null, resolvedPath: null, fileFacts: null }
    return { kind: 'unverifiable', reason: 'UNIT_FILE_UNREADABLE', resolvedPath: null, fileFacts: null }
  }
  let targetPath = reservation.unitPath
  let targetInfo = pathInfo
  if (pathInfo.isSymbolicLink()) {
    try {
      targetPath = realpathSync(reservation.unitPath)
      targetInfo = lstatSync(targetPath)
    } catch {
      return { kind: 'unverifiable', reason: 'UNIT_FILE_LINK_UNREADABLE', resolvedPath: null, fileFacts: null }
    }
    if (!targetInfo.isFile()) {
      return { kind: 'foreign', reason: 'UNIT_FILE_TARGET_NOT_REGULAR', resolvedPath: null, fileFacts: null }
    }
  } else if (!pathInfo.isFile()) {
    return { kind: 'unverifiable', reason: 'UNIT_FILE_NOT_REGULAR', resolvedPath: null, fileFacts: null }
  }
  if (pathInfo.uid !== reservation.uid || targetInfo.uid !== reservation.uid) {
    return { kind: 'foreign', reason: 'UNIT_FILE_FOREIGN_OWNER', resolvedPath: null, fileFacts: null }
  }
  let content
  try {
    content = readFileSync(targetPath, 'utf8')
  } catch {
    return { kind: 'unverifiable', reason: 'UNIT_FILE_UNREADABLE', resolvedPath: null, fileFacts: null }
  }
  const resolvedPath = realpathSync(targetPath)
  const lines = content.split('\n')
  const owner = readMetadata(lines, 'X-DshPiTuiOwner')
  const scopeId = readMetadata(lines, 'X-DshPiTuiScopeId')
  const profileIdentity = readMetadata(lines, 'X-DshPiTuiProfileIdentity')
  const installBuild = readMetadata(lines, 'X-DshPiTuiInstallBuild')
  const expectedProfileIdentity = profileIdentityDigest(reservation.profileRealpath)
  if (expectedProfileIdentity === undefined) {
    return { kind: 'unverifiable', reason: 'PROFILE_IDENTITY_UNREADABLE', resolvedPath, fileFacts: null }
  }
  if (owner !== OWNER_MARKER
    || scopeId !== reservation.scopeId
    || profileIdentity !== expectedProfileIdentity
    || typeof installBuild !== 'string'
    || !/^[0-9a-f]{64}$/u.test(installBuild)) {
    return { kind: 'foreign', reason: 'UNIT_OWNER_METADATA_MISMATCH', resolvedPath, fileFacts: null }
  }
  const execStart = readMetadata(lines, 'ExecStart')
  return {
    kind: 'owned',
    reason: null,
    resolvedPath,
    fileFacts: {
      mode: targetInfo.mode & 0o7777,
      sha256: createHash('sha256').update(content).digest('hex'),
      device: String(targetInfo.dev),
      inode: String(targetInfo.ino),
      owner,
      scopeId,
      profileIdentity,
      installBuild,
      execStart: typeof execStart === 'string' ? execStart : null,
      programArguments: null,
      nonGeneratedSha256: null,
    },
  }
}

/**
 * Report the raw systemd facts of ONE reserved Profile unit. A missing runtime
 * directory, unreadable manager channel or unsafe file is reported as raw
 * unverifiable data; the caller decides whether it may proceed.
 */
export async function inspectManagedService(reservation) {
  const base = {
    file: 'unverifiable',
    managerState: 'unknown',
    ownerVerified: false,
    managerObserved: false,
    unitName: typeof reservation?.unitName === 'string' ? reservation.unitName : '',
    unitPath: typeof reservation?.unitPath === 'string' ? reservation.unitPath : '',
    fragmentPath: null,
    sourcePath: null,
    mainPid: null,
    loadState: null,
    activeState: null,
    unitFileState: null,
    jobState: null,
    fileFacts: null,
    reason: null,
  }
  if (reservation === null || typeof reservation !== 'object' || reservation.manager !== MANAGER) {
    return { ...base, reason: 'RESERVATION_MANAGER_MISMATCH' }
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== reservation.uid) return { ...base, reason: 'UID_MISMATCH' }
  const unitFile = inspectUnitFile(reservation)
  const manager = managerEnvironment(reservation.uid)
  const managerObservation = await showUnit(reservation, manager)
  let managerState = 'unknown'
  let loadState = null
  let activeState = null
  let unitFileState = null
  let fragmentPath = null
  let mainPid = null
  let reason = unitFile.reason ?? null
  let ownerVerified = unitFile.kind === 'owned' && unitFile.fileFacts !== null
  if (managerObservation.observed) {
    const props = managerObservation.props
    loadState = nonEmpty(props.LoadState)
    activeState = nonEmpty(props.ActiveState)
    unitFileState = nonEmpty(props.UnitFileState)
    const parsedPid = Number(props.MainPID)
    mainPid = Number.isSafeInteger(parsedPid) && parsedPid > 0 ? parsedPid : null
    const rawFragment = nonEmpty(props.FragmentPath)
    if (rawFragment !== null) {
      try {
        fragmentPath = realpathSync(rawFragment)
      } catch {
        fragmentPath = null
        if (reason === null) reason = 'FRAGMENT_PATH_UNREADABLE'
      }
    }
    if (loadState === 'not-found') {
      managerState = activeState === 'inactive' ? 'not-loaded' : 'unknown'
      if (managerState === 'unknown' && reason === null) reason = 'MANAGER_STATE_INCONSISTENT'
    } else if (loadState === 'loaded' && activeState === 'active') managerState = 'active'
    else if (loadState === 'loaded' && (activeState === 'inactive' || activeState === 'failed')) managerState = 'inactive'
    else {
      managerState = 'unknown'
      if (reason === null) reason = 'MANAGER_STATE_UNRECOGNIZED'
    }
    if (ownerVerified && managerState !== 'not-loaded') {
      if (fragmentPath === null) {
        ownerVerified = false
        if (reason === null) reason = 'FRAGMENT_PATH_MISSING'
      } else if (unitFile.resolvedPath !== undefined && fragmentPath !== unitFile.resolvedPath) {
        ownerVerified = false
        if (reason === null) reason = 'FRAGMENT_PATH_MISMATCH'
      }
    }
    if (unitFile.kind === 'absent' && managerState !== 'not-loaded' && reason === null) {
      reason = 'MANAGER_STATE_WITHOUT_FILE'
    }
  } else {
    managerState = 'unknown'
    if (reason === null) reason = managerObservation.reason ?? 'MANAGER_UNQUERYABLE'
  }
  if (unitFile.kind === 'foreign' && reason === null) reason = 'FOREIGN_SERVICE_FILE'
  if (unitFile.kind === 'unverifiable' && reason === null) reason = 'UNIT_FILE_UNVERIFIABLE'
  if (unitFile.kind === 'owned' && ownerVerified === false && reason === null) reason = 'OWNER_NOT_VERIFIED'
  return {
    file: unitFile.kind,
    managerState,
    ownerVerified: unitFile.kind === 'owned' && ownerVerified === true && unitFile.fileFacts !== null,
    managerObserved: managerObservation.observed,
    unitName: reservation.unitName,
    unitPath: reservation.unitPath,
    fragmentPath,
    sourcePath: null,
    mainPid,
    loadState,
    activeState,
    unitFileState,
    jobState: null,
    fileFacts: unitFile.kind === 'owned' ? unitFile.fileFacts : null,
    reason,
  }
}

function readStartTicks(pid) {
  try {
    const stat = readFileSync(`/proc/${String(pid)}/stat`, 'utf8')
    const tail = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u)
    return tail[19] ?? null
  } catch (error) {
    return error?.code === 'ENOENT' ? null : undefined
  }
}

function hostProcessState(identity) {
  if (identity === null || typeof identity !== 'object') return 'unknown'
  const pid = Number(identity.pid)
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown'
  if (typeof identity.kernelIdentity !== 'string' || !identity.kernelIdentity.startsWith('linux:')) return 'unknown'
  const expected = identity.kernelIdentity.slice('linux:'.length)
  try {
    process.kill(pid, 0)
  } catch {
    return 'gone'
  }
  const ticks = readStartTicks(pid)
  if (ticks === undefined) return 'unknown'
  if (ticks === null) return 'gone'
  return ticks === expected ? 'alive' : 'different'
}

/**
 * Reclaim ONE reserved unit only after the official stop/uninstall path has
 * failed. The recorded file identity and any recorded Host kernel identity must
 * still prove ownership; a changed file, a live Host or an unreadable manager
 * preserves the resource and returns `clean:false`.
 */
export async function reclaimManagedService(input) {
  const current = await inspectManagedService(input)
  const preserve = reason => ({ clean: false, action: 'preserve', reason, observation: current })
  if (current.file === 'absent' && current.managerState === 'not-loaded') {
    return { clean: true, action: 'removed', reason: 'already-absent', observation: current }
  }
  if (current.file !== 'owned' || current.ownerVerified !== true || current.fileFacts === null) {
    return preserve(current.reason ?? 'OWNER_UNPROVEN')
  }
  const recordedIdentity = input.fileIdentity
  if (recordedIdentity !== null && recordedIdentity !== undefined) {
    if (typeof recordedIdentity !== 'object'
      || typeof recordedIdentity.device !== 'string'
      || typeof recordedIdentity.inode !== 'string'
      || typeof recordedIdentity.sha256 !== 'string') {
      return preserve('FILE_IDENTITY_INVALID')
    }
    if (recordedIdentity.device !== current.fileFacts.device
      || recordedIdentity.inode !== current.fileFacts.inode
      || recordedIdentity.sha256 !== current.fileFacts.sha256) {
      return preserve('FILE_IDENTITY_CHANGED')
    }
  }
  for (const identity of Array.isArray(input.verifiedHostIdentities) ? input.verifiedHostIdentities : []) {
    const state = hostProcessState(identity)
    if (state === 'alive') return preserve('MANAGED_HOST_STILL_ALIVE')
    if (state === 'unknown') return preserve('MANAGED_HOST_IDENTITY_UNKNOWN')
  }
  if (current.managerState === 'unknown') return preserve('MANAGER_UNVERIFIABLE')
  const manager = managerEnvironment(input.uid)
  if (manager === undefined) return preserve('SYSTEMD_RUNTIME_DIR_UNAVAILABLE')
  if (current.managerState === 'active' || current.managerState === 'inactive') {
    const stop = await runSystemctl(['stop', input.unitName], manager.env)
    if (!stop.ok) return preserve('SYSTEMD_STOP_FAILED')
    const afterStop = await inspectManagedService(input)
    if (afterStop.file !== 'owned' || afterStop.ownerVerified !== true) {
      return { clean: false, action: 'preserve', reason: 'SERVICE_CHANGED_AFTER_STOP', observation: afterStop }
    }
    if (afterStop.managerState === 'active') {
      return { clean: false, action: 'preserve', reason: 'SYSTEMD_STOP_NOT_SETTLED', observation: afterStop }
    }
    if (afterStop.managerState === 'unknown') {
      return { clean: false, action: 'preserve', reason: 'MANAGER_UNVERIFIABLE', observation: afterStop }
    }
  }
  const beforeUnlink = await inspectManagedService(input)
  if (beforeUnlink.file !== 'owned' || beforeUnlink.ownerVerified !== true || beforeUnlink.fileFacts === null) {
    return { clean: false, action: 'preserve', reason: 'SERVICE_CHANGED_BEFORE_UNLINK', observation: beforeUnlink }
  }
  if (recordedIdentity !== null && recordedIdentity !== undefined
    && (recordedIdentity.device !== beforeUnlink.fileFacts.device
      || recordedIdentity.inode !== beforeUnlink.fileFacts.inode
      || recordedIdentity.sha256 !== beforeUnlink.fileFacts.sha256)) {
    return { clean: false, action: 'preserve', reason: 'FILE_IDENTITY_CHANGED', observation: beforeUnlink }
  }
  let pathInfo
  try {
    pathInfo = lstatSync(input.unitPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { clean: false, action: 'preserve', reason: 'UNIT_FILE_UNREADABLE', observation: beforeUnlink }
    }
    pathInfo = undefined
  }
  if (pathInfo !== undefined) {
    if (pathInfo.uid !== input.uid) {
      return { clean: false, action: 'preserve', reason: 'UNIT_FILE_FOREIGN_OWNER', observation: beforeUnlink }
    }
    try {
      unlinkSync(input.unitPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        return { clean: false, action: 'preserve', reason: 'UNIT_UNLINK_FAILED', observation: beforeUnlink }
      }
    }
  }
  const reload = await runSystemctl(['daemon-reload'], manager.env)
  if (!reload.ok) {
    return { clean: false, action: 'preserve', reason: 'SYSTEMD_RELOAD_FAILED', observation: beforeUnlink }
  }
  const after = await inspectManagedService(input)
  if (after.file === 'absent' && after.managerState === 'not-loaded') {
    return { clean: true, action: 'removed', reason: 'verified-owner', observation: after }
  }
  return { clean: false, action: 'preserve', reason: after.reason ?? 'SERVICE_RECLAIM_UNVERIFIED', observation: after }
}
