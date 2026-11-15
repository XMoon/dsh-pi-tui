/**
 * The M6-2C daemon management control plane.
 *
 * This is the ONE module that turns a typed `DaemonControlIntent` into a real
 * local OS observation or an explicit supervision transition for ONE official
 * Profile. It owns no Host business object: Host readiness is always the
 * existing authenticated `/connect` Cookie + identity echo + `/proc` starttime
 * handshake, process supervision is the existing profile unit or detached
 * fallback, and a Host stop remains the existing `runProfile` shutdown owner
 * reached through the manager's SIGTERM (or one verified single-PID SIGTERM on
 * the strict-absence fallback).
 *
 * `status` and `logs` are strictly read-only: they never create the profile run
 * directory, never write a unit, never start a Host and never touch a Session.
 * The four mutating verbs are serialized by one short-lived profile-scoped
 * Linux abstract admin seat; the kernel releases it when the command dies, so
 * there is no persistent lock file or second state machine.
 *
 * @module app/remote-process/local-daemon-control
 */

import { spawn } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  assertClientHostCompatible,
  authenticateLocalHost,
  ensureLocalHost,
  inspectHostProcess,
  readLocalRecord,
  type EnsureLocalHostOptions,
  type LocalInstanceRecord,
  type VerifiedLocalHost,
} from './local-discovery.ts'
import {
  bindProcessSeat,
  inspectInstalledProfileScope,
  LocalScopeError,
  readLinuxStarttime,
  scopeFromInstalledProfile,
  type LocalScope,
} from './local-scope.ts'
import {
  inspectOwnedProfileUnit,
  probeUserManager,
  queryOwnedProfileUnit,
  runSystemctl,
  selectRuntimeDir,
  stopOwnedProfileUnit,
  uninstallOwnedProfileUnit,
  type OwnedProfileUnit,
  type SystemctlRunner,
  type UserManagerProbe,
} from './local-host-manager.ts'

/** The public management verbs (the fixed M6-2C set). */
export type DaemonControlVerb = 'status' | 'start' | 'stop' | 'restart' | 'logs' | 'uninstall'

/** One typed management intent published by the startup row. */
export interface DaemonControlIntent {
  readonly verb: DaemonControlVerb
  /** `logs` only: 1..1000, already validated by the CLI action. */
  readonly lines?: number
}

/** The official Profile facts the control plane consumes (never guessed paths). */
export interface DaemonControlProfile {
  readonly name: string
  readonly dir: string
  readonly home: string
  readonly installAnchor: string
  readonly packageRoot: string
  readonly dshVersion: string
}

/** One command result: the process exit code plus the exact stdout/stderr text. */
export interface DaemonControlResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Stable failure codes with their fixed exit classes. */
export type DaemonControlErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'IDENTITY_OR_OWNERSHIP_REFUSED'
  | 'MANAGER_OR_OS_FAILURE'
  | 'LOG_SOURCE_UNAVAILABLE'
  | 'DAEMON_CONTROL_BUSY'
  | 'TRANSITION_UNCERTAIN'

/** The fixed exit class of every stable code. */
const EXIT_CODE: Readonly<Record<DaemonControlErrorCode, number>> = {
  UNSUPPORTED_PLATFORM: 3,
  IDENTITY_OR_OWNERSHIP_REFUSED: 3,
  MANAGER_OR_OS_FAILURE: 4,
  LOG_SOURCE_UNAVAILABLE: 4,
  DAEMON_CONTROL_BUSY: 5,
  TRANSITION_UNCERTAIN: 5,
}

/** A management failure carrying the stable code and exit class. */
export class DaemonControlError extends Error {
  readonly code: DaemonControlErrorCode
  readonly exitCode: number
  readonly reason: string
  constructor(code: DaemonControlErrorCode, reason: string, cause?: unknown) {
    super(reason, cause === undefined ? undefined : { cause })
    this.name = 'DaemonControlError'
    this.code = code
    this.exitCode = EXIT_CODE[code]
    this.reason = reason
  }
}

/** The fixed one-line error format; never a raw Error message or argv. */
export function formatDaemonControlError(error: DaemonControlError): string {
  return `dsh-pi-tui daemon: ${error.code}: ${sanitizeReason(error.reason)}\n`
}

/** Visible risk reminder printed beside log output. */
const LOG_SANITIZATION_NOTICE = 'dsh-pi-tui daemon: note: log output is best-effort sanitized; review it before sharing\n'

/** The fixed running-work warning every mutating verb prints on success. */
const RUNNING_WORK_NOTICE = 'dsh-pi-tui daemon: note: stopping or restarting the Host may interrupt a running Session, Job or Interaction; unsettled writes are not replayed automatically\n'

/** The admin seat prefix; the kernel releases the abstract name on process death. */
const ADMIN_SEAT_PREFIX = '\0dsh-pi-tui-admin-'

/** Bound on one journalctl invocation. */
const JOURNALCTL_TIMEOUT_MS = 10_000
/** Hard cap on captured journal output. */
const JOURNAL_MAX_OUTPUT_BYTES = 256 * 1024
/** Bound on one fallback host.log tail read (from the end of the file). */
const HOST_LOG_MAX_BYTES = 256 * 1024
/** Bound on one displayed log line. */
const MAX_LOG_LINE_LENGTH = 2_000
/** The fixed journal executable. */
const JOURNALCTL = '/usr/bin/journalctl'
/** Stable truncation marker for bounded log reads. */
export const LOG_TRUNCATION_MARKER = '[dsh-pi-tui daemon: earlier log output truncated]'

/** Host state printed by `status` (never inferred from manager state alone). */
export type DaemonHostState = 'ready' | 'stopped' | 'starting' | 'unresponsive' | 'incompatible' | 'unknown'
/** Supervision attribution printed by `status`. */
export type DaemonManagerKind = 'systemd' | 'process' | 'unmanaged'
/** Unit state printed by `status`. */
export type DaemonUnitState = 'active' | 'inactive' | 'not-found' | 'unknown'
/** Compatibility of the live Host (or the installed unit without a Host). */
export type DaemonCompatibility = 'compatible' | 'other-build' | 'incompatible' | 'unknown' | 'none'

/** One read-only status observation. Never readiness for `ActiveState=active`. */
export interface DaemonControlStatus {
  readonly profile: string
  readonly manager: DaemonManagerKind
  readonly userManager: 'available' | 'absent' | 'error'
  readonly host: DaemonHostState
  readonly unit: string | 'none'
  readonly unitState: DaemonUnitState
  readonly compatibility: DaemonCompatibility
  readonly pid?: number
  readonly instance?: string
}

/** Injectable OS/discovery seams; production omits every one of them. */
export interface DaemonControlDeps {
  readonly platform?: NodeJS.Platform
  readonly uid?: number
  /** Explicit unit directory seam for structural tests; production uses the account home. */
  readonly unitDir?: string
  readonly probe?: () => Promise<UserManagerProbe>
  readonly systemctl?: SystemctlRunner
  readonly readRecord?: (scope: LocalScope) => LocalInstanceRecord | undefined
  readonly inspectProcess?: (record: LocalInstanceRecord) => 'alive' | 'dead'
  readonly authenticate?: (record: LocalInstanceRecord, scope: LocalScope) => Promise<VerifiedLocalHost>
  readonly ensureHost?: (options: EnsureLocalHostOptions) => Promise<VerifiedLocalHost>
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly readStarttime?: (pid: number) => string | undefined
  readonly readCmdline?: (pid: number) => string | undefined
  readonly journal?: (unit: string, lines: number) => Promise<{ code: number; stdout: string; stderr: string }>
  readonly hostLogTail?: (path: string, lines: number) => Promise<string | undefined>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly stopTimeoutMs?: number
  /** Supervisor shutdown signal: refuse to COMMIT a new OS transition once set. */
  readonly signal?: AbortSignal
}

/** One internal snapshot shared by the read-only status and the pre-flight checks. */
interface Snapshot {
  readonly scope: LocalScope
  readonly probe: UserManagerProbe
  readonly unit: OwnedProfileUnit | undefined
  readonly unitState: DaemonUnitState
  readonly unitMainPid: number
  readonly record: LocalInstanceRecord | undefined
  readonly processAlive: boolean
  readonly authenticated: VerifiedLocalHost | undefined
  readonly status: DaemonControlStatus
  readonly exitCode: number
  readonly failure: DaemonControlError | undefined
}

/** Replace absolute paths and control characters in a human reason. */
function sanitizeReason(text: string): string {
  const line = text.split(/\r?\n/u).map(part => part.trim()).find(part => part !== '') ?? ''
  return line
    .replace(/\/[^\s"']+/gu, '<path>')
    .replace(/https?:\/\/[^\s"']+/giu, '<url>')
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .slice(0, 200)
}

/** Map a lower-level stable failure onto the management error taxonomy. */
function toDaemonControlError(error: unknown): DaemonControlError {
  if (error instanceof DaemonControlError) return error
  if (error instanceof LocalScopeError) {
    switch (error.code) {
      case 'B1_PLATFORM_UNSUPPORTED':
        return new DaemonControlError('UNSUPPORTED_PLATFORM', 'this daemon command requires Linux')
      case 'HOST_MANAGER_UNIT_CONFLICT':
      case 'HOST_IDENTITY_MISMATCH':
      case 'HOST_PROTOCOL_INCOMPATIBLE':
      case 'HOST_BUILD_INCOMPATIBLE':
      case 'HOST_AUTH_FAILED':
      case 'SCOPE_DIRECTORY_UNSAFE':
      case 'LOCAL_FILE_UNSAFE':
      case 'PROCESS_STARTTIME_UNAVAILABLE':
        return new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', error.message, error)
      case 'HOST_STOP_TIMEOUT':
      case 'HOST_START_TIMEOUT':
        return new DaemonControlError('TRANSITION_UNCERTAIN', error.message, error)
      case 'DAEMON_CONTROL_BUSY':
        return new DaemonControlError('DAEMON_CONTROL_BUSY', 'another daemon control operation is already running for this profile', error)
      case 'HOST_UNRESPONSIVE':
        return new DaemonControlError('MANAGER_OR_OS_FAILURE', error.message, error)
      default:
        return new DaemonControlError('MANAGER_OR_OS_FAILURE', error.message, error)
    }
  }
  return new DaemonControlError('MANAGER_OR_OS_FAILURE', 'an unexpected local management failure occurred', error)
}

/** Throw when the supervisor is shutting down and the operation must settle. */
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal !== undefined && signal.aborted) {
    throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the management operation was cancelled by supervisor shutdown')
  }
}

/** The effective platform/uid inputs. */
function platformOf(deps: DaemonControlDeps): NodeJS.Platform {
  return deps.platform ?? process.platform
}

function uidOf(deps: DaemonControlDeps): number {
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
  if (uid === undefined) throw new DaemonControlError('UNSUPPORTED_PLATFORM', 'this daemon command requires a local user identity')
  return uid
}

/** Compute the read-only scope; no directory is created. */
function inspectScope(profile: DaemonControlProfile, deps: DaemonControlDeps): LocalScope {
  if (platformOf(deps) !== 'linux') {
    throw new DaemonControlError('UNSUPPORTED_PLATFORM', 'this daemon command requires Linux')
  }
  try {
    return inspectInstalledProfileScope({
      dshHome: profile.home,
      profileDir: profile.dir,
      packageRoot: profile.packageRoot,
      dshVersion: profile.dshVersion,
    })
  } catch (error) {
    throw toDaemonControlError(error)
  }
}

/** The installed Host entry path of this Profile's package (never guessed). */
function hostEntryOf(profile: DaemonControlProfile): string {
  return join(profile.packageRoot, 'dist', 'local-host.mjs')
}

/** Resolve the fixed runtime dir for the current user. */
function runtimeDirOf(deps: DaemonControlDeps): string | undefined {
  return selectRuntimeDir(uidOf(deps))
}

/** Read-only snapshot; `status`, pre-flight checks and `logs` consume it. */
async function readSnapshot(profile: DaemonControlProfile, deps: DaemonControlDeps, scope: LocalScope): Promise<Snapshot> {
  const uid = uidOf(deps)
  const probe = await (deps.probe ?? probeUserManager)()
  const systemctl = deps.systemctl ?? runSystemctl
  const runtimeDir = runtimeDirOf(deps)
  let unit: OwnedProfileUnit | undefined
  let unitState: DaemonUnitState = 'not-found'
  let unitMainPid = 0
  try {
    const inspected = inspectOwnedProfileUnit(scope, profile.name, uid, deps.unitDir, hostEntryOf(profile))
    if (inspected.kind === 'owned') {
      unit = inspected
      if (probe.kind === 'available') {
        const state = await queryOwnedProfileUnit(inspected, runtimeDir, systemctl)
        unitMainPid = state.mainPid
        unitState = state.loadState === 'not-found'
          ? 'not-found'
          : state.activeState === 'active'
            ? 'active'
            : state.activeState === 'inactive' || state.activeState === 'failed'
              ? 'inactive'
              : 'unknown'
      } else {
        unitState = 'unknown'
      }
    }
  } catch (error) {
    const failure = toDaemonControlError(error)
    return {
      scope,
      probe,
      unit: undefined,
      unitState: 'unknown',
      unitMainPid: 0,
      record: undefined,
      processAlive: false,
      authenticated: undefined,
      status: {
        profile: profile.name,
        manager: 'unmanaged',
        userManager: probe.kind === 'available' ? 'available' : probe.kind === 'absent' ? 'absent' : 'error',
        host: 'unknown',
        unit: 'none',
        unitState: 'unknown',
        compatibility: 'unknown',
      },
      exitCode: failure.exitCode,
      failure,
    }
  }
  const readRecord = deps.readRecord ?? readLocalRecord
  const inspectProcess = deps.inspectProcess ?? inspectHostProcess
  let host: DaemonHostState = 'stopped'
  // A verified, loaded profile unit is the supervision attribution even before
  // the Host reaches authenticated readiness (ActiveState is not readiness).
  let manager: DaemonManagerKind = unit !== undefined && unitState !== 'not-found' && unitState !== 'unknown'
    ? 'systemd'
    : 'unmanaged'
  let compatibility: DaemonCompatibility = 'none'
  let authenticated: VerifiedLocalHost | undefined
  let failure: DaemonControlError | undefined
  let exitCode = 0
  let record: LocalInstanceRecord | undefined
  try {
    record = readRecord(scope)
  } catch (error) {
    failure = toDaemonControlError(error)
    exitCode = failure.exitCode
  }
  let processAlive = false
  if (record !== undefined) {
    try {
      processAlive = inspectProcess(record) === 'alive'
    } catch (error) {
      failure = failure ?? toDaemonControlError(error)
      exitCode = failure.exitCode
    }
  }
  if (failure !== undefined) {
    host = 'unknown'
  } else if (processAlive && record !== undefined) {
    try {
      assertClientHostCompatible(record, scope)
      compatibility = record.buildId === scope.buildId ? 'compatible' : 'other-build'
    } catch (error) {
      host = 'incompatible'
      compatibility = 'incompatible'
      failure = toDaemonControlError(error)
      exitCode = failure.exitCode
    }
    if (failure === undefined) {
      try {
        const authenticate = deps.authenticate ?? authenticateLocalHost
        authenticated = await authenticate(record, scope)
        host = 'ready'
      } catch (error) {
        const mapped = toDaemonControlError(error)
        host = 'unresponsive'
        failure = mapped
        exitCode = mapped.exitCode
      }
    }
    if (failure === undefined && authenticated !== undefined) {
      if (unit !== undefined && unitState === 'active') {
        if (unitMainPid !== record.hostPid) {
          failure = new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the active profile unit does not supervise the authenticated Host')
          exitCode = failure.exitCode
        }
      } else {
        // A live fallback Host under a manager that is now absent (or with no
        // loaded unit) is process-supervised, never the inactive unit's.
        manager = probe.kind === 'absent' ? 'process' : 'unmanaged'
      }
    }
  } else if (unitState === 'active') {
    // Active manager supervision without an authenticated identity is never Ready.
    host = 'starting'
  }
  if (failure === undefined && probe.kind === 'error' && host !== 'ready') {
    // A manager error only fails commands that would NEED the manager. An
    // already-authenticated compatible Host is reused exactly like
    // ensureLocalHost reuses it: the manager decides supervision for a NEW
    // Host, never the reuse of a live one (B02/C05).
    failure = new DaemonControlError('MANAGER_OR_OS_FAILURE', `the user manager is unavailable: ${probe.reason}`)
    exitCode = failure.exitCode
  }
  if (failure !== undefined && host === 'stopped') host = 'unknown'
  if (failure === undefined && processAlive && record !== undefined && host === 'ready') {
    compatibility = record.buildId === scope.buildId ? 'compatible' : 'other-build'
  } else if (failure === undefined && unit !== undefined && unitState !== 'not-found'
    && unit.installBuild !== scope.buildId) {
    // A stopped/starting profile still reports a controlled unit that belongs to
    // another installed build; it never claims a live Host is compatible.
    compatibility = 'other-build'
  }
  if (probe.kind === 'error' && compatibility === 'none') compatibility = 'unknown'
  return {
    scope,
    probe,
    unit,
    unitState,
    unitMainPid,
    record,
    processAlive,
    authenticated,
    status: {
      profile: profile.name,
      manager,
      userManager: probe.kind === 'available' ? 'available' : probe.kind === 'absent' ? 'absent' : 'error',
      host,
      unit: unit === undefined ? 'none' : unit.unitName,
      unitState,
      compatibility,
      ...(processAlive && record !== undefined ? { pid: record.hostPid } : {}),
      ...(processAlive && record !== undefined ? { instance: record.instanceId.slice(0, 8) } : {}),
    },
    exitCode,
    failure,
  }
}

/** The stable `key=value` status block (no secret or private path). */
export function formatDaemonStatus(status: DaemonControlStatus): string {
  const profile = status.profile.replace(/[\u0000-\u001f\u007f]/gu, '')
  const lines = [
    `profile=${profile}`,
    `manager=${status.manager}`,
    `user-manager=${status.userManager}`,
    `host=${status.host}`,
    `unit=${status.unit}`,
    `unit-state=${status.unitState}`,
    `compatibility=${status.compatibility}`,
  ]
  if (status.pid !== undefined) lines.push(`pid=${String(status.pid)}`)
  if (status.instance !== undefined) lines.push(`instance=${status.instance}`)
  return `${lines.join('\n')}\n`
}

/**
 * Acquire the ONE profile-scoped admin seat for a mutating verb. The seat is
 * held for exactly the lifetime of THIS command's operation: two concurrently
 * running management commands of the same Profile cannot interleave, and the
 * kernel releases the abstract name when the process exits. There is no
 * persistent lock file and no in-memory shadow of OS operations — a command
 * that dies with the process releases the seat, and the next command re-reads
 * the real systemd/Host state.
 */
async function withAdminSeat<T>(scope: LocalScope, operation: () => Promise<T>): Promise<T> {
  let seat
  try {
    seat = await bindProcessSeat(`${ADMIN_SEAT_PREFIX}${scope.scopeId.slice(0, 40)}`, 'DAEMON_CONTROL_BUSY')
  } catch (error) {
    throw toDaemonControlError(error)
  }
  try {
    return await operation()
  } finally {
    await seat.close()
  }
}

/** A stable local error for an unknown Host state. */
function refuseHostState(status: DaemonControlStatus): DaemonControlError {
  if (status.host === 'incompatible') {
    return new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the live Host uses an incompatible protocol or DSH runtime')
  }
  if (status.host === 'unresponsive') {
    return new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the live Host could not prove its authenticated identity')
  }
  return new DaemonControlError('TRANSITION_UNCERTAIN', `the Host is ${status.host}; refusing to change supervision`)
}

/** The bounded post-stop wait: the old PID/starttime must actually disappear. */
async function waitForHostStopped(
  record: LocalInstanceRecord | undefined,
  mainPid: number,
  deps: DaemonControlDeps,
): Promise<void> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const readStarttime = deps.readStarttime ?? ((pid: number) => {
    try { return readLinuxStarttime(pid) } catch { return undefined }
  })
  const deadline = now() + (deps.stopTimeoutMs ?? 20_000)
  for (;;) {
    // The stop request is already committed: await its real bounded settlement
    // instead of turning a shutdown signal into a premature "unknown".
    const targetPid = record?.hostPid ?? mainPid
    const observed = targetPid === 0 ? undefined : readStarttime(targetPid)
    const starttimeGone = targetPid === 0 || observed === undefined
      || (record !== undefined && observed !== record.hostStarttime)
    const recordGone = record === undefined || inspectHostProcess(record) === 'dead'
    if (starttimeGone && recordGone) return
    if (now() >= deadline) {
      throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the old Host process did not exit within the bounded window')
    }
    await sleep(100)
  }
}

/** Verify a fallback Host process really is the product Host entry of this user. */
function assertProcessHostOwnership(record: LocalInstanceRecord, deps: DaemonControlDeps): void {
  const readCmdline = deps.readCmdline ?? ((pid: number) => {
    try { return readFileString(`/proc/${String(pid)}/cmdline`) } catch { return undefined }
  })
  const cmdline = readCmdline(record.hostPid)
  if (cmdline === undefined || cmdline === '') {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the Host process command line is unavailable')
  }
  const argv = cmdline.split('\0').filter(part => part !== '')
  const entry = argv[1]
  if (entry === undefined || !entry.endsWith('/dist/local-host.mjs')) {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the live process is not the product Host entry')
  }
  let realEntry: string
  try {
    realEntry = realpathSync(entry)
  } catch {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the live Host entry is not readable')
  }
  const info = lstatSync(realEntry)
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== uidOf(deps)) {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the live Host entry is not an owned product file')
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(dirname(dirname(realEntry)), 'package.json'), 'utf8'))
  } catch {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the live Host entry has no readable package identity')
  }
  if (manifest === null || typeof manifest !== 'object' || (manifest as { readonly name?: unknown }).name !== '@xmoon76/dsh-pi-tui') {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the live Host entry is not @xmoon76/dsh-pi-tui')
  }
}

/** Bounded read-to-EOF for procfs text files: `/proc` entries report
 *  `st_size = 0` even when the content is readable, so the length must come
 *  from reading until EOF under an explicit byte cap, never from `fstat.size`. */
function readFileString(path: string): string {
  const fd = openSync(path, constants.O_RDONLY)
  try {
    const chunks: Buffer[] = []
    let total = 0
    for (;;) {
      const chunk = Buffer.alloc(4096)
      const read = readSync(fd, chunk, 0, chunk.length, null)
      if (read <= 0) break
      total += read
      if (total > 64 * 1024) throw new Error('unexpected process command line size')
      chunks.push(read === chunk.length ? chunk : chunk.subarray(0, read))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** Stop the snapshot's supervised Host and prove it actually stopped. */
async function stopFromSnapshot(
  profile: DaemonControlProfile,
  snapshot: Snapshot,
  deps: DaemonControlDeps,
): Promise<void> {
  const { probe, unit, unitState, unitMainPid, record, processAlive } = snapshot
  if (probe.kind === 'error') {
    throw new DaemonControlError('MANAGER_OR_OS_FAILURE', `the user manager is unavailable: ${probe.reason}`)
  }
  const systemctl = deps.systemctl ?? runSystemctl
  const liveHost = processAlive && record !== undefined
  if (liveHost) {
    const unitSupervisesHost = unit !== undefined && unitState === 'active' && unitMainPid === record.hostPid
    if (unitSupervisesHost) {
      if (probe.kind !== 'available') {
        throw new DaemonControlError('MANAGER_OR_OS_FAILURE', 'the user manager cannot verify the profile unit')
      }
      assertNotAborted(deps.signal)
      await stopOwnedProfileUnit(unit, runtimeDirOf(deps), systemctl)
      await waitForHostStopped(record, unitMainPid, deps)
      return
    }
    if (probe.kind === 'absent' && unitState !== 'active') {
      const authenticate = deps.authenticate ?? authenticateLocalHost
      try {
        await authenticate(record, snapshot.scope)
      } catch (error) {
        throw toDaemonControlError(error)
      }
      assertProcessHostOwnership(record, deps)
      const readStarttime = deps.readStarttime ?? ((pid: number) => {
        try { return readLinuxStarttime(pid) } catch { return undefined }
      })
      if (readStarttime(record.hostPid) !== record.hostStarttime) {
        throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the Host process start identity changed before the signal')
      }
      assertNotAborted(deps.signal)
      const kill = deps.kill ?? process.kill
      try {
        kill(record.hostPid, 'SIGTERM')
      } catch (error) {
        throw new DaemonControlError('MANAGER_OR_OS_FAILURE', 'the verified Host process could not be signalled', error)
      }
      await waitForHostStopped(record, record.hostPid, deps)
      return
    }
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'a live Host has no verifiable supervision attribution')
  }
  if (unit !== undefined && unitState !== 'not-found' && probe.kind === 'available') {
    assertNotAborted(deps.signal)
    await stopOwnedProfileUnit(unit, runtimeDirOf(deps), systemctl)
    await waitForHostStopped(undefined, unitMainPid, deps)
  }
  // No live Host and no manager-supervised unit: already stopped. With a
  // strictly absent manager the unit file cannot be loaded at all.
}

/** The `status` handler. */
async function runStatus(profile: DaemonControlProfile, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  const scope = inspectScope(profile, deps)
  const snapshot = await readSnapshot(profile, deps, scope)
  const stderr = snapshot.failure === undefined ? '' : formatDaemonControlError(snapshot.failure)
  return { code: snapshot.exitCode, stdout: formatDaemonStatus(snapshot.status), stderr }
}

/** The `start` handler. */
async function runStart(profile: DaemonControlProfile, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  const inspected = inspectScope(profile, deps)
  return await withAdminSeat(inspected, async () => {
    const pre = await readSnapshot(profile, deps, inspected)
    if (pre.failure !== undefined) throw pre.failure
    if (pre.status.host === 'ready') return { code: 0, stdout: formatDaemonStatus(pre.status), stderr: '' }
    if (pre.status.host !== 'stopped' && pre.status.host !== 'starting') throw refuseHostState(pre.status)
    // The long read-only snapshot above may have taken seconds. Shutdown that
    // arrived during it must be observed BEFORE creating the run directory or
    // committing any Host start.
    assertNotAborted(deps.signal)
    const scope = scopeFromInstalledProfile({
      dshHome: profile.home,
      profileDir: profile.dir,
      packageRoot: profile.packageRoot,
      dshVersion: profile.dshVersion,
    })
    assertNotAborted(deps.signal)
    const ensureHost = deps.ensureHost ?? ensureLocalHost
    try {
      // One committed OS transition: once the request is issued its real result
      // is awaited as-is; a later abort does not invent a rollback.
      await ensureHost({
        scope,
        hostEntryPath: join(profile.packageRoot, 'dist', 'local-host.mjs'),
        dshAnchor: profile.installAnchor,
        profile: profile.name,
        hostStartPolicy: 'public-managed',
      })
    } catch (error) {
      throw toDaemonControlError(error)
    }
    const post = await readSnapshot(profile, deps, scope)
    if (post.status.host !== 'ready') throw refuseHostState(post.status)
    return { code: 0, stdout: formatDaemonStatus(post.status), stderr: '' }
  })
}

/** The `stop` handler. */
async function runStop(profile: DaemonControlProfile, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  const inspected = inspectScope(profile, deps)
  return await withAdminSeat(inspected, async () => {
    const pre = await readSnapshot(profile, deps, inspected)
    if (pre.failure !== undefined) throw pre.failure
    assertNotAborted(deps.signal)
    await stopFromSnapshot(profile, pre, deps)
    const post = await readSnapshot(profile, deps, inspected)
    if (post.status.host !== 'stopped') throw refuseHostState(post.status)
    return { code: 0, stdout: formatDaemonStatus(post.status), stderr: RUNNING_WORK_NOTICE }
  })
}

/** The `restart` handler: stop -> confirmed exit -> controlled unit refresh -> start. */
async function runRestart(profile: DaemonControlProfile, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  const inspected = inspectScope(profile, deps)
  return await withAdminSeat(inspected, async () => {
    const pre = await readSnapshot(profile, deps, inspected)
    if (pre.failure !== undefined) throw pre.failure
    if (pre.status.host !== 'ready' && pre.status.host !== 'stopped') throw refuseHostState(pre.status)
    const oldInstance = pre.record?.instanceId
    // Owner decision (M6-2C scope): an owned unit from ANOTHER installed build
    // is never migrated here. Cross-build unit replacement is M6-2D work; this
    // stage refuses it BEFORE any stop so a refused restart leaves the running
    // old-build Host and its unit exactly as they were, instead of guessing the
    // old build's compatibility from its metadata alone.
    if (pre.unit !== undefined && pre.unit.installBuild !== pre.scope.buildId) {
      throw new DaemonControlError(
        'IDENTITY_OR_OWNERSHIP_REFUSED',
        'the profile unit belongs to another installed build; removing or replacing it is deferred to the upgrade flow',
      )
    }
    assertNotAborted(deps.signal)
    await stopFromSnapshot(profile, pre, deps)
    assertNotAborted(deps.signal)
    const scope = scopeFromInstalledProfile({
      dshHome: profile.home,
      profileDir: profile.dir,
      packageRoot: profile.packageRoot,
      dshVersion: profile.dshVersion,
    })
    assertNotAborted(deps.signal)
    const ensureHost = deps.ensureHost ?? ensureLocalHost
    try {
      await ensureHost({
        scope,
        hostEntryPath: join(profile.packageRoot, 'dist', 'local-host.mjs'),
        dshAnchor: profile.installAnchor,
        profile: profile.name,
        hostStartPolicy: 'public-managed',
      })
    } catch (error) {
      throw toDaemonControlError(error)
    }
    const post = await readSnapshot(profile, deps, scope)
    if (post.status.host !== 'ready') throw refuseHostState(post.status)
    if (oldInstance !== undefined && post.record?.instanceId === oldInstance) {
      throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the restart did not produce a new Host instance')
    }
    return {
      code: 0,
      stdout: `previous=${oldInstance === undefined ? 'none' : oldInstance.slice(0, 8)}\n${formatDaemonStatus(post.status)}`,
      stderr: RUNNING_WORK_NOTICE,
    }
  })
}

/** The `uninstall` handler. */
async function runUninstall(profile: DaemonControlProfile, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  const inspected = inspectScope(profile, deps)
  return await withAdminSeat(inspected, async () => {
    const pre = await readSnapshot(profile, deps, inspected)
    if (pre.failure !== undefined) throw pre.failure
    if (pre.unit === undefined) {
      // No owned unit: nothing to remove, and a fallback Host is never killed.
      return { code: 0, stdout: formatDaemonStatus(pre.status), stderr: RUNNING_WORK_NOTICE }
    }
    if (pre.probe.kind !== 'available') {
      throw new DaemonControlError('MANAGER_OR_OS_FAILURE', 'the user manager cannot verify the profile unit')
    }
    const systemctl = deps.systemctl ?? runSystemctl
    assertNotAborted(deps.signal)
    if (pre.unitState === 'active' || pre.unitState === 'unknown') {
      await stopOwnedProfileUnit(pre.unit, runtimeDirOf(deps), systemctl)
      // Only the unit's own Host is waited for; an unrelated strict-absence
      // fallback Host is never killed by uninstall.
      const ownHost = pre.record !== undefined && pre.record.hostPid === pre.unitMainPid ? pre.record : undefined
      await waitForHostStopped(ownHost, pre.unitMainPid, deps)
    }
    assertNotAborted(deps.signal)
    uninstallOwnedProfileUnit(pre.unit, pre.scope, profile.name, uidOf(deps))
    const reload = await systemctl(['--user', '--no-pager', '--no-ask-password', 'daemon-reload'], runtimeDirOf(deps))
    if (reload.kind !== 'exited' || reload.code !== 0) {
      throw new DaemonControlError('MANAGER_OR_OS_FAILURE', 'daemon-reload failed after removing the profile unit')
    }
    const post = await readSnapshot(profile, deps, inspected)
    return { code: 0, stdout: formatDaemonStatus(post.status), stderr: RUNNING_WORK_NOTICE }
  })
}

/** Run one fixed `journalctl --user --unit <verified-name>` invocation. */
function runJournalctl(unit: string, lines: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let overflow = false
    const settle = (result: { code: number; stdout: string; stderr: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child
    try {
      child = spawn(JOURNALCTL, ['--user', '--unit', unit, '--no-pager', '-o', 'cat', '-n', String(lines)], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch {
      settle({ code: 1, stdout: '', stderr: 'journalctl could not be spawned' })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ code: 1, stdout: '', stderr: 'journalctl timed out' })
    }, JOURNALCTL_TIMEOUT_MS)
    const collect = (current: string, chunk: Buffer): string => {
      if (overflow) return current
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next, 'utf8') > JOURNAL_MAX_OUTPUT_BYTES) {
        overflow = true
        child.kill('SIGKILL')
        return current
      }
      return next
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk) })
    child.once('error', () => { settle({ code: 1, stdout: '', stderr: 'journalctl could not be spawned' }) })
    child.once('close', (code: number | null) => {
      if (overflow) {
        settle({ code: 0, stdout: `${stdout}\n${LOG_TRUNCATION_MARKER}\n`, stderr })
        return
      }
      settle({ code: code ?? 1, stdout, stderr })
    })
  })
}

/** Read the tail of the fallback `host.log` through the strict private-file rules. */
async function tailHostLog(path: string, lines: number): Promise<string | undefined> {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return undefined
  }
  try {
    const info = fstatSync(fd)
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
    if (!info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600) return undefined
    const length = Math.min(info.size, HOST_LOG_MAX_BYTES)
    const start = info.size - length
    const buffer = Buffer.alloc(length)
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, start + offset)
      if (read <= 0) break
      offset += read
    }
    const text = buffer.toString('utf8', 0, offset)
    const all = text.split('\n')
    if (all.length > 0 && all[all.length - 1] === '') all.pop()
    const tail = all.slice(Math.max(0, all.length - lines))
    return `${start > 0 ? `${LOG_TRUNCATION_MARKER}\n` : ''}${tail.join('\n')}${tail.length === 0 ? '' : '\n'}`
  } finally {
    closeSync(fd)
  }
}

/** Remove terminal control sequences and best-effort secret material. */
export function sanitizeLogText(text: string): string {
  const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/gu
  return text
    .replace(ansi, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .split('\n')
    .map(line => line
      // Header-style credentials carry a scheme and a token separated by a
      // space, so the WHOLE remaining value must be removed (not just the
      // scheme). This also covers multi-word secret assignments.
      .replace(/\b((?:proxy-)?authorization|x-api-key|x-auth-token|cookie|set-cookie|secret|password)\s*[:=]\s*.*$/gimu, '$1=[redacted]')
      .replace(/\b(token|access_token|refresh_token|api[_-]?key)\s*[:=]\s*[^\s&]+/gimu, '$1=[redacted]')
      .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gimu, '$1[redacted]')
      .replace(/https?:\/\/[^\s"']*(?:token=|key=|secret=|password=)[^\s"']*/giu, '[redacted-url]')
      .replace(/\bconnectUrl\b[^\s]*/giu, 'connectUrl=[redacted]')
      .slice(0, MAX_LOG_LINE_LENGTH))
    .join('\n')
}

/** The `logs` handler: journal for an owned unit, private host.log only on strict absence. */
async function runLogs(profile: DaemonControlProfile, intent: DaemonControlIntent, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  const scope = inspectScope(profile, deps)
  const probe = await (deps.probe ?? probeUserManager)()
  if (probe.kind === 'error') {
    throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', `the user manager is unavailable: ${probe.reason}`)
  }
  const uid = uidOf(deps)
  let unit: OwnedProfileUnit | undefined
  try {
    const inspected = inspectOwnedProfileUnit(scope, profile.name, uid, deps.unitDir, hostEntryOf(profile))
    if (inspected.kind === 'owned') unit = inspected
  } catch (error) {
    throw toDaemonControlError(error)
  }
  const lines = intent.lines ?? 100
  let text: string
  // A strictly absent manager cannot be running any unit, so a leftover owned
  // unit FILE on disk must not hide the real process-supervised Host log.
  if (probe.kind === 'absent') {
    const path = join(scope.dir, 'host.log')
    const tail = deps.hostLogTail ?? tailHostLog
    const value = await tail(path, lines)
    if (value === undefined || value.trim() === '') {
      throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'no private fallback Host log is available')
    }
    text = value
  } else if (unit !== undefined) {
    // The journal belongs to the unit the manager actually loads. A disk file
    // with valid owner metadata is not enough: verify FragmentPath names THIS
    // file and no drop-in overrides it, exactly like stop/uninstall do.
    const systemctl = deps.systemctl ?? runSystemctl
    let loaded = false
    try {
      const state = await queryOwnedProfileUnit(unit, runtimeDirOf(deps), systemctl)
      loaded = state.loadState !== 'not-found'
    } catch (error) {
      throw toDaemonControlError(error)
    }
    if (!loaded) {
      throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the owned profile unit is not loaded by the manager')
    }
    const journal = deps.journal ?? runJournalctl
    const result = await journal(unit.unitName, lines)
    if (result.code !== 0 || result.stdout.trim() === '') {
      throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'no journal entries are available for the owned profile unit')
    }
    text = result.stdout
  } else {
    throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'no owned unit or strict-absence Host log exists for this profile')
  }
  return { code: 0, stdout: `${sanitizeLogText(text)}`, stderr: LOG_SANITIZATION_NOTICE }
}

/**
 * Run ONE daemon management command for ONE official Profile. Every failure is
 * mapped to the fixed stable code/exit taxonomy; no raw Error message, command
 * argv, Host URL, Cookie or private path reaches stdout/stderr.
 */
export async function runDaemonControl(
  intent: DaemonControlIntent,
  profile: DaemonControlProfile,
  deps: DaemonControlDeps = {},
): Promise<DaemonControlResult> {
  try {
    switch (intent.verb) {
      case 'status':
        return await runStatus(profile, deps)
      case 'start':
        return await runStart(profile, deps)
      case 'stop':
        return await runStop(profile, deps)
      case 'restart':
        return await runRestart(profile, deps)
      case 'logs':
        return await runLogs(profile, intent, deps)
      case 'uninstall':
        return await runUninstall(profile, deps)
    }
  } catch (error) {
    const failure = toDaemonControlError(error)
    const notice = intent.verb === 'stop' || intent.verb === 'restart' || intent.verb === 'uninstall'
      ? RUNNING_WORK_NOTICE
      : ''
    return { code: failure.exitCode, stdout: '', stderr: `${formatDaemonControlError(failure)}${notice}` }
  }
}
