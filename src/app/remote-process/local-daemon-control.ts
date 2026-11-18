/**
 * The M6-2C daemon management control plane.
 *
 * This is the ONE module that turns a typed `DaemonControlIntent` into a real
 * local OS observation or an explicit supervision transition for ONE official
 * Profile. It owns no Host business object: Host readiness is always the
 * existing authenticated `/connect` Cookie + identity echo + fresh kernel
 * identity handshake (Linux `/proc` starttime, macOS Darwin schema 2), and a
 * Host stop remains the existing `runProfile` shutdown owner reached either
 * through the verified profile unit's manager SIGTERM, a verified user-level
 * launchd job's `bootout`, or a single verified-PID POSIX SIGTERM when the
 * authenticated Host is independent.
 *
 * `status` and `logs` are strictly read-only: they never create the profile run
 * directory, never write a service definition, never start a Host and never
 * touch a Session. The five mutating verbs (start, stop, restart, install and
 * uninstall) are serialized by one short-lived profile-scoped admin seat: Linux
 * holds the abstract-socket name, macOS holds the Darwin `O_EXLOCK` `admin` seat
 * file beside the Host singleton seat. The kernel releases it when the command
 * dies, so there is no persistent lock file or second state machine.
 *
 * @module app/remote-process/local-daemon-control
 */

import { spawn } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  readKernelProcess,
  sameKernelProcess,
  type KernelObservation,
} from '../../runtime/native-process/identity.ts'
import {
  assertClientHostCompatible,
  assertRecordedHostKernelIdentityCurrent,
  authenticateLocalHost,
  ensureLocalHost,
  inspectHostProcess,
  readLocalRecord,
  type EnsureLocalHostOptions,
  type LocalInstanceRecord,
  type VerifiedLocalHost,
} from './local-discovery.ts'
import {
  bindDarwinKernelSeat,
  bindProcessSeat,
  darwinHostProfileSeatDir,
  inspectInstalledProfileScope,
  LocalScopeError,
  readLinuxStarttime,
  scopeFromInstalledProfile,
  type LocalScope,
} from './local-scope.ts'
import {
  collectUnitFacts,
  inspectOwnedProfileUnit,
  installProfileHostUnit,
  profileIdentityDigest,
  queryOwnedProfileUnit,
  runSystemctl,
  selectRuntimeDir,
  stopOwnedProfileUnit,
  uninstallOwnedProfileUnit,
  type OwnedProfileUnit,
  type SystemctlRunner,
} from './local-host-manager.ts'
import {
  inspectLaunchdService,
  inspectOwnedLaunchdUnit,
  installLaunchdUnit,
  launchdLogPaths,
  launchdServiceMatches,
  startLaunchdService,
  stopLaunchdService,
  uninstallLaunchdUnit,
  type LaunchdAdapterDeps,
  type LaunchdServiceObservation,
  type LaunchdUnitFacts,
  type LaunchctlRunner,
  type OwnedLaunchdUnit,
} from './local-host-launchd.ts'

/** The public management verbs (the fixed M6-2C set). */
export type DaemonControlVerb = 'status' | 'start' | 'stop' | 'restart' | 'logs' | 'install' | 'uninstall'

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
/** Bound on one scope host.log tail read (from the end of the file). */
const HOST_LOG_MAX_BYTES = 256 * 1024
/** Bound on one displayed log line. */
const MAX_LOG_LINE_LENGTH = 2_000
/** The fixed journal executable. */
const JOURNALCTL = 'journalctl'
/** Stable truncation marker for bounded log reads. */
export const LOG_TRUNCATION_MARKER = '[dsh-pi-tui daemon: earlier log output truncated]'

/** Host state printed by `status` (never inferred from manager state alone). */
export type DaemonHostState = 'ready' | 'stopped' | 'starting' | 'unresponsive' | 'incompatible' | 'unknown'
/** Supervision attribution printed by `status`. */
export type DaemonManagerKind = 'systemd' | 'launchd' | 'process' | 'unmanaged'
/** Unit state printed by `status`. */
export type DaemonUnitState =
  | 'active'
  | 'inactive'
  | 'not-found'
  | 'unknown'
  /** Actual launchd job states (macOS): never a readiness verdict. */
  | 'running'
  | 'not-running'
  | 'spawn-scheduled'
/** Compatibility of the live Host (or the installed unit without a Host). */
export type DaemonCompatibility = 'compatible' | 'other-build' | 'incompatible' | 'unknown' | 'none'

/** One read-only status observation. Never readiness for `ActiveState=active`. */
export interface DaemonControlStatus {
  readonly profile: string
  readonly manager: DaemonManagerKind
  readonly userManager: 'not-checked' | 'available' | 'error'
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
  readonly systemctl?: SystemctlRunner
  readonly readRecord?: (scope: LocalScope) => LocalInstanceRecord | undefined
  readonly inspectProcess?: (record: LocalInstanceRecord) => 'alive' | 'dead'
  readonly authenticate?: (record: LocalInstanceRecord, scope: LocalScope) => Promise<VerifiedLocalHost>
  readonly ensureHost?: (options: EnsureLocalHostOptions) => Promise<VerifiedLocalHost>
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
  readonly readStarttime?: (pid: number) => string | undefined
  readonly readCmdline?: (pid: number) => string | undefined
  /** Fresh kernel-identity reader; production uses the platform-native one. */
  readonly readKernel?: (pid: number) => KernelObservation
  readonly journal?: (unit: string, lines: number) => Promise<{ code: number; stdout: string; stderr: string }>
  readonly hostLogTail?: (path: string, lines: number) => Promise<string | undefined>
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly stopTimeoutMs?: number
  /** Explicit OS account home seam for the Darwin admin seat; production uses
   *  the real account home (never `$HOME`/`DSH_HOME`). */
  readonly darwinAccountHome?: string
  /** Supervisor shutdown signal: refuse to COMMIT a new OS transition once set. */
  readonly signal?: AbortSignal
  /** Explicit Darwin launchd command seam for structural tests; production
   *  uses `/bin/launchctl`. */
  readonly launchctl?: LaunchctlRunner
}

/** One internal snapshot shared by the read-only status and the pre-flight checks. */
interface Snapshot {
  readonly scope: LocalScope
  /** The installed-unit fact: the ONLY admission for manager IO. */
  readonly unit: OwnedProfileUnit | undefined
  /** `not-checked` when no unit exists, so no manager query was issued. */
  readonly userManager: 'not-checked' | 'available' | 'error'
  /** A named unit path that is NOT this Profile's verified unit. */
  readonly unitInspectionFailure: DaemonControlError | undefined
  /** The manager could not report the installed unit's state. */
  readonly unitQueryFailure: DaemonControlError | undefined
  readonly unitState: DaemonUnitState
  /** The manager's raw ActiveState; `unitState` is the coarse presentation. */
  readonly unitActiveState: string
  readonly unitMainPid: number
  /** The installed launchd plist fact (Darwin only); the ONLY launchd-IO admission. */
  readonly launchdUnit: OwnedLaunchdUnit | undefined
  readonly launchdService: LaunchdServiceObservation | undefined
  readonly launchdFacts: LaunchdUnitFacts | undefined
  readonly launchdInspectionFailure: DaemonControlError | undefined
  readonly launchdQueryFailure: DaemonControlError | undefined
  readonly record: LocalInstanceRecord | undefined
  readonly processAlive: boolean
  readonly authenticated: VerifiedLocalHost | undefined
  /** True only when the authenticated `/connect` handshake failed for a live Host. */
  readonly hostAuthenticationFailed: boolean
  /** True only when a live Host failed protocol/DSH compatibility before auth. */
  readonly hostCompatibilityFailed: boolean
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
        return new DaemonControlError('UNSUPPORTED_PLATFORM', 'this daemon command requires Linux or macOS')
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
        return new DaemonControlError('TRANSITION_UNCERTAIN', error.message, error)
      case 'HOST_START_TIMEOUT':
        return afterCommittedAction(new DaemonControlError('TRANSITION_UNCERTAIN', error.message, error), 'Host start')
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

/** Add recovery context only to a completed operation's failed confirmation. */
function afterCommittedAction(failure: DaemonControlError, action: string): DaemonControlError {
  return new DaemonControlError(
    failure.code,
    `${action} may already be committed; final verification failed. Run daemon status before retrying. ${failure.reason}`,
    failure,
  )
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
  const platform = platformOf(deps)
  if (platform !== 'linux' && platform !== 'darwin') {
    throw new DaemonControlError('UNSUPPORTED_PLATFORM', 'this daemon command requires Linux or macOS')
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

/** Resolve the fixed runtime dir for the current user. */
function runtimeDirOf(deps: DaemonControlDeps): string | undefined {
  return selectRuntimeDir(uidOf(deps))
}

/** The Darwin launchd adapter inputs; production uses the OS account home and
 *  the real `/bin/launchctl`. */
function launchdDepsOf(deps: DaemonControlDeps): LaunchdAdapterDeps {
  return {
    uid: uidOf(deps),
    ...(deps.darwinAccountHome === undefined ? {} : { accountHome: deps.darwinAccountHome }),
    ...(deps.launchctl === undefined ? {} : { launchctl: deps.launchctl }),
  }
}

/** Collect the validated launchd facts for one installed profile. */
function launchdFactsOf(scope: LocalScope, profile: DaemonControlProfile): LaunchdUnitFacts {
  const facts = collectUnitFacts({
    scope,
    hostEntryPath: join(profile.packageRoot, 'dist', 'local-host.mjs'),
    dshAnchor: profile.installAnchor,
    profile: profile.name,
  })
  return {
    ...facts,
    scopeDir: scope.dir,
    profileIdentity: profileIdentityDigest(scope.profileRealpath),
  }
}

/** Map one actual launchd job state onto the stable status vocabulary. */
function launchdUnitState(state: string): DaemonUnitState {
  switch (state) {
    case 'running': return 'running'
    case 'not running': return 'not-running'
    case 'spawn scheduled': return 'spawn-scheduled'
    default: return 'unknown'
  }
}

/**
 * Read-only snapshot; `status`, pre-flight checks and `logs` consume it.
 *
 * The installed unit fact is the ONLY manager-IO admission: with no unit file
 * (or no user unit directory) no `systemctl` invocation is made at all, so a
 * missing/broken user manager cannot affect an independent basic Host. With a
 * unit, exactly one `systemctl show` of that unit decides `user-manager` and
 * the unit state. The Host's own registry/authentication chain is always read,
 * even after a unit-identity refusal, so `status` can report a real ready Host
 * beside a foreign unit while still exiting nonzero.
 */
async function readSnapshot(profile: DaemonControlProfile, deps: DaemonControlDeps, scope: LocalScope): Promise<Snapshot> {
  const platform = platformOf(deps)
  let unit: OwnedProfileUnit | undefined
  let unitState: DaemonUnitState = 'not-found'
  /** The manager's raw ActiveState; `unitState` is the coarse presentation. */
  let unitActiveState = ''
  let unitMainPid = 0
  let userManager: 'not-checked' | 'available' | 'error' = 'not-checked'
  let unitInspectionFailure: DaemonControlError | undefined
  let unitQueryFailure: DaemonControlError | undefined
  let launchdUnit: OwnedLaunchdUnit | undefined
  let launchdService: LaunchdServiceObservation | undefined
  let launchdFacts: LaunchdUnitFacts | undefined
  let launchdInspectionFailure: DaemonControlError | undefined
  let launchdQueryFailure: DaemonControlError | undefined
  if (platform === 'linux') {
    // Only Linux has the verified systemd user unit. Darwin has its own
    // LaunchAgent branch below; the two manager facts never substitute for
    // each other and no other platform reaches the manager IO at all.
    const systemctl = deps.systemctl ?? runSystemctl
    const runtimeDir = runtimeDirOf(deps)
    try {
      const inspected = inspectOwnedProfileUnit(scope, profile.name, deps.unitDir)
      if (inspected.kind === 'owned') {
        unit = inspected
        unitInspectionFailure = undefined
        try {
          const state = await queryOwnedProfileUnit(inspected, runtimeDir, systemctl)
          userManager = 'available'
          unitMainPid = state.mainPid
          unitActiveState = state.loadState === 'not-found' ? '' : state.activeState
          unitState = state.loadState === 'not-found'
            ? 'not-found'
            : state.activeState === 'active'
              ? 'active'
              : state.activeState === 'inactive' || state.activeState === 'failed'
                ? 'inactive'
                : 'unknown'
        } catch (error) {
          userManager = 'error'
          unitQueryFailure = toDaemonControlError(error)
          unitState = 'unknown'
        }
      }
    } catch (error) {
      // A named unit path exists but is not this Profile's verified unit. The
      // refusal owns the management decision; the Host observation below still
      // runs so `status` reports the authenticated Host truthfully.
      unitInspectionFailure = toDaemonControlError(error)
      unitState = 'unknown'
    }
  } else if (platform === 'darwin') {
    // The installed plist file is the ONLY launchd-IO admission: with no owned
    // plist no launchctl call is made at all, so a missing/broken GUI domain
    // cannot affect the basic independent Host.
    try {
      launchdFacts = launchdFactsOf(scope, profile)
      const launchdDeps = launchdDepsOf(deps)
      const inspected = inspectOwnedLaunchdUnit(launchdFacts, launchdDeps)
      if (inspected.kind === 'owned') {
        launchdUnit = inspected.unit
        try {
          launchdService = await inspectLaunchdService(inspected.unit, launchdDeps)
          userManager = 'available'
          if (launchdService.kind === 'not-loaded') {
            unitState = 'not-found'
          } else if (launchdService.kind === 'loaded') {
            const service = launchdService.service
            unitActiveState = service.state
            unitState = launchdUnitState(service.state)
            unitMainPid = service.pid ?? 0
            if (!launchdServiceMatches(launchdFacts, inspected.unit, service)) {
              launchdQueryFailure = new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the loaded launchd job does not match the installed profile plist')
            }
          } else {
            userManager = 'error'
            unitState = 'unknown'
            launchdQueryFailure = new DaemonControlError('MANAGER_OR_OS_FAILURE', 'the loaded launchd job state is not recognizable')
          }
        } catch (error) {
          userManager = 'error'
          unitState = 'unknown'
          launchdQueryFailure = toDaemonControlError(error)
        }
      }
    } catch (error) {
      launchdInspectionFailure = toDaemonControlError(error)
      unitState = 'unknown'
    }
  }
  let failure = unitInspectionFailure ?? unitQueryFailure ?? launchdInspectionFailure ?? launchdQueryFailure
  let exitCode = failure?.exitCode ?? 0

  const readRecord = deps.readRecord ?? readLocalRecord
  const inspectProcess = deps.inspectProcess ?? inspectHostProcess
  let host: DaemonHostState = 'stopped'
  let manager: DaemonManagerKind = 'unmanaged'
  let compatibility: DaemonCompatibility = 'none'
  let authenticated: VerifiedLocalHost | undefined
  let hostAuthenticationFailed = false
  let hostCompatibilityFailed = false
  let record: LocalInstanceRecord | undefined
  try {
    record = readRecord(scope)
  } catch (error) {
    if (failure === undefined) {
      failure = toDaemonControlError(error)
      exitCode = failure.exitCode
    }
  }
  let processAlive = false
  if (record !== undefined) {
    try {
      processAlive = inspectProcess(record) === 'alive'
    } catch (error) {
      if (failure === undefined) {
        failure = toDaemonControlError(error)
        exitCode = failure.exitCode
      }
    }
  }
  if (processAlive && record !== undefined) {
    let compatibilityFailure: DaemonControlError | undefined
    try {
      assertClientHostCompatible(record, scope)
      compatibility = record.buildId === scope.buildId ? 'compatible' : 'other-build'
    } catch (error) {
      host = 'incompatible'
      compatibility = 'incompatible'
      hostCompatibilityFailed = true
      compatibilityFailure = toDaemonControlError(error)
      if (failure === undefined) {
        failure = compatibilityFailure
        exitCode = failure.exitCode
      }
    }
    if (compatibilityFailure === undefined) {
      try {
        const authenticate = deps.authenticate ?? authenticateLocalHost
        authenticated = await authenticate(record, scope)
        host = 'ready'
      } catch (error) {
        const mapped = toDaemonControlError(error)
        host = 'unresponsive'
        hostAuthenticationFailed = true
        if (failure === undefined) {
          failure = mapped
          exitCode = mapped.exitCode
        }
      }
    }
  }

  if (authenticated !== undefined && record !== undefined) {
    if (platform === 'darwin') {
      // `manager=launchd` is claimed ONLY when the loaded job was bootstrapped
      // from THIS profile plist, its fixed launch facts match the installed
      // profile, and its real PID is the authenticated Host PID. A job in flux
      // never relabels the authenticated Host as verified supervision.
      if (launchdUnit === undefined) {
        manager = 'process'
      } else if (launchdInspectionFailure !== undefined || launchdQueryFailure !== undefined || launchdService === undefined) {
        manager = 'unmanaged'
      } else if (launchdService.kind === 'loaded') {
        const service = launchdService.service
        if (service.state === 'running') {
          if (service.pid === undefined) {
            manager = 'unmanaged'
            if (failure === undefined) {
              failure = new DaemonControlError('TRANSITION_UNCERTAIN', 'the launchd job reports running without a PID')
              exitCode = failure.exitCode
            }
          } else if (service.pid === record.hostPid) {
            manager = 'launchd'
          } else {
            manager = 'process'
            if (failure === undefined) {
              failure = new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the launchd job PID is not the authenticated Host; use launchctl for this custom service')
              exitCode = failure.exitCode
            }
          }
        } else if (service.state === 'spawn scheduled') {
          // A job that is still starting could become a second Host beside the
          // authenticated one; neither independent-process nor launchd
          // supervision is proven.
          manager = 'unmanaged'
          if (failure === undefined) {
            failure = new DaemonControlError('TRANSITION_UNCERTAIN', 'the launchd job is still starting beside a live Host')
            exitCode = failure.exitCode
          }
        } else if (service.state === 'not running') {
          manager = 'process'
        } else {
          manager = 'unmanaged'
          if (failure === undefined) {
            failure = new DaemonControlError('TRANSITION_UNCERTAIN', `the launchd job is in an unconfirmed state (${service.state === '' ? 'unknown' : service.state})`)
            exitCode = failure.exitCode
          }
        }
      } else {
        manager = 'process'
      }
    } else {
      // `manager=systemd` is claimed ONLY when the loaded unit's MainPID is the
      // authenticated Host PID. An independent authenticated Host is `process`
      // even when a usable user bus exists; a unit that does not supervise it
      // never re-labels that Host. With NO authoritative unit observation
      // (inspection refusal or manager query failure) neither attribution is
      // proven: keep the authenticated `host=ready` truth but leave `manager`
      // unmanaged until the unit state can be read.
      const loaded = unit !== undefined && unitState !== 'not-found'
      const running = unitActiveState === 'active' || unitActiveState === 'activating'
      const ended = unitActiveState === 'inactive' || unitActiveState === 'failed'
      if (unitInspectionFailure !== undefined || unitQueryFailure !== undefined) {
        manager = 'unmanaged'
      } else if (loaded && running) {
        if (unitMainPid === record.hostPid) {
          manager = 'systemd'
        } else {
          manager = 'process'
          if (failure === undefined) {
            failure = new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the unit MainPID is not the authenticated Host; use systemctl --user for this custom service')
            exitCode = failure.exitCode
          }
        }
      } else if (loaded && !ended) {
        // A loaded unit in a transitional/unknown state cannot prove that the
        // authenticated Host is an independent process (nor that it is
        // systemd-supervised). Keep the truthful host=ready and the nonzero
        // uncertainty, but never assert verified independent-process supervision.
        manager = 'unmanaged'
        if (failure === undefined) {
          failure = new DaemonControlError('TRANSITION_UNCERTAIN', `the profile unit is in an unconfirmed state (${unitActiveState === '' ? 'unknown' : unitActiveState})`)
          exitCode = failure.exitCode
        }
      } else {
        manager = 'process'
      }
    }
  } else if (record === undefined || !processAlive) {
    if (platform === 'darwin') {
      if (launchdUnit !== undefined && launchdService?.kind === 'loaded') {
        const state = launchdService.service.state
        if (state === 'running' || state === 'spawn scheduled') {
          host = 'starting'
        } else if (state === 'not running') {
          host = 'stopped'
        } else {
          host = 'unknown'
          if (failure === undefined) {
            failure = new DaemonControlError('TRANSITION_UNCERTAIN', `the launchd job is in an unconfirmed state (${state === '' ? 'unknown' : state})`)
            exitCode = failure.exitCode
          }
        }
      }
    } else {
      const loaded = unit !== undefined && unitState !== 'not-found'
      if (loaded && (unitActiveState === 'active' || unitActiveState === 'activating')) {
        host = 'starting'
      } else if (loaded && unitActiveState !== 'inactive' && unitActiveState !== 'failed') {
        host = 'unknown'
        if (failure === undefined) {
          failure = new DaemonControlError('TRANSITION_UNCERTAIN', `the profile unit is in an unconfirmed state (${unitActiveState === '' ? 'unknown' : unitActiveState})`)
          exitCode = failure.exitCode
        }
      }
    }
  }
  if (failure !== undefined && host === 'stopped') host = 'unknown'
  if (failure === undefined && authenticated !== undefined && record !== undefined) {
    compatibility = record.buildId === scope.buildId ? 'compatible' : 'other-build'
  } else if (failure === undefined && unit !== undefined && unitState !== 'not-found'
    && unit.installBuild !== scope.buildId) {
    compatibility = 'other-build'
  } else if (failure === undefined && launchdUnit !== undefined && launchdUnit.installBuild !== scope.buildId) {
    compatibility = 'other-build'
  }
  if ((unitQueryFailure !== undefined || launchdQueryFailure !== undefined) && compatibility === 'none') compatibility = 'unknown'
  return {
    scope,
    unit,
    launchdUnit,
    launchdService,
    launchdFacts,
    launchdInspectionFailure,
    launchdQueryFailure,
    userManager,
    unitInspectionFailure,
    unitQueryFailure,
    unitState,
    unitActiveState,
    unitMainPid,
    record,
    processAlive,
    authenticated,
    hostAuthenticationFailed,
    hostCompatibilityFailed,
    status: {
      profile: profile.name,
      manager,
      userManager,
      host,
      unit: platform === 'darwin'
        ? (launchdUnit === undefined ? 'none' : launchdUnit.label)
        : (unit === undefined ? 'none' : unit.unitName),
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
 * kernel releases the claim when the process exits. Linux keeps its abstract
 * socket name; Darwin claims the existing `admin` `O_EXLOCK` file beside the
 * Host singleton seat. There is no persistent lock file and no in-memory shadow
 * of OS operations — a command that dies with the process releases the seat,
 * and the next command re-reads the real systemd/Host state.
 */
async function withAdminSeat<T>(scope: LocalScope, deps: DaemonControlDeps, operation: () => Promise<T>): Promise<T> {
  let seat
  try {
    seat = platformOf(deps) === 'linux'
      ? await bindProcessSeat(`${ADMIN_SEAT_PREFIX}${scope.scopeId.slice(0, 40)}`, 'DAEMON_CONTROL_BUSY')
      : await bindDarwinKernelSeat(
        darwinHostProfileSeatDir(scope.scopeId, deps.darwinAccountHome),
        scope.scopeId,
        'admin',
        'DAEMON_CONTROL_BUSY',
      )
  } catch (error) {
    throw toDaemonControlError(error)
  }
  try {
    return await operation()
  } finally {
    await seat.close()
  }
}

/** A live Host authentication or compatibility failure is a diagnosis, not a
 *  unit-ownership verdict. A verified current-Profile service remains
 *  manageable through the manager; every other snapshot failure keeps its
 *  normal admission. The product never auto-recovers — this only permits an
 *  explicit user command. */
function verifiedUnitManagementAdmitted(snapshot: Snapshot): boolean {
  return (snapshot.hostAuthenticationFailed || snapshot.hostCompatibilityFailed)
    && snapshot.unit !== undefined
    && snapshot.userManager === 'available'
}

/** The same admission for a verified launchd job whose real PID is the live
 *  Host record (or whose job state proves no process is running). */
function verifiedLaunchdManagementAdmitted(snapshot: Snapshot): boolean {
  const { launchdUnit, launchdFacts, launchdService, record, processAlive } = snapshot
  if (launchdUnit === undefined || launchdFacts === undefined || launchdService?.kind !== 'loaded') return false
  if (!launchdServiceMatches(launchdFacts, launchdUnit, launchdService.service)) return false
  if (!processAlive || record === undefined) return true
  return launchdService.service.pid !== undefined && launchdService.service.pid === record.hostPid
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

/** The bounded post-stop wait: the old process identity must actually
 *  disappear. Linux keeps its frozen `/proc` starttime proof; Darwin requires
 *  the recorded schema-2 kernel identity to become `gone`/`different`. An
 *  `unknown` kernel read is uncertainty and never proves a stop. */
async function waitForHostStopped(
  record: LocalInstanceRecord | undefined,
  mainPid: number,
  deps: DaemonControlDeps,
): Promise<void> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const deadline = now() + (deps.stopTimeoutMs ?? 20_000)
  if (platformOf(deps) === 'darwin') {
    if (record === undefined || record.schema !== 2) {
      throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the Host kernel identity is unavailable for the stop proof')
    }
    const readKernel = deps.readKernel ?? readKernelProcess
    for (;;) {
      const classification = sameKernelProcess(record.hostKernelIdentity, readKernel(record.hostPid))
      if (classification === 'gone' || classification === 'different') return
      if (now() >= deadline) {
        throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the old Host process did not exit within the bounded window')
      }
      await sleep(100)
    }
  }
  const readStarttime = deps.readStarttime ?? ((pid: number) => {
    try { return readLinuxStarttime(pid) } catch { return undefined }
  })
  for (;;) {
    // The stop request is already committed: await its real bounded settlement
    // instead of turning a shutdown signal into a premature "unknown".
    const targetPid = record?.hostPid ?? mainPid
    const observed = targetPid === 0 ? undefined : readStarttime(targetPid)
    const starttimeGone = targetPid === 0 || observed === undefined
      || (record !== undefined && (record.schema !== 1 || observed !== record.hostStarttime))
    const recordGone = record === undefined || inspectHostProcess(record) === 'dead'
    if (starttimeGone && recordGone) return
    if (now() >= deadline) {
      throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the old Host process did not exit within the bounded window')
    }
    await sleep(100)
  }
}

/** Verify a live independent Host process really is this product Host entry. */
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
  if (!lstatSync(realEntry).isFile()) {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the live Host entry is not a product file')
  }
  // The installed package root is the ORIGINAL entry's package tree: a legal
  // shared-store `dist` symlink resolves outside its own package directory, but
  // the package identity still lives beside the named entry.
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(dirname(dirname(entry)), 'package.json'), 'utf8'))
  } catch {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the live Host entry has no readable package identity')
  }
  if (manifest === null || typeof manifest !== 'object' || (manifest as { readonly name?: unknown }).name !== '@xmoon76/dsh-pi-tui') {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the live Host entry is not @xmoon76/dsh-pi-tui')
  }
}

/**
 * Verify a live independent Darwin Host really is the recorded kernel process
 * before one SIGTERM. The registry schema, the authenticated instance and a
 * FRESH kernel read must all agree; the read is repeated immediately before the
 * signal so a pid that exited/was reused between the handshake and the signal
 * is refused with zero signal. `unknown` is never a kill permit.
 */
function assertDarwinHostOwnership(
  record: LocalInstanceRecord,
  authenticated: VerifiedLocalHost,
  deps: DaemonControlDeps,
): void {
  if (record.schema !== 2) {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the Host registry is not a macOS kernel identity')
  }
  if (authenticated.record.instanceId !== record.instanceId
    || authenticated.record.hostPid !== record.hostPid) {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the authenticated Host is not the recorded instance')
  }
  const readKernel = deps.readKernel ?? readKernelProcess
  try {
    assertRecordedHostKernelIdentityCurrent(record, readKernel)
  } catch (error) {
    throw toDaemonControlError(error)
  }
  if (sameKernelProcess(record.hostKernelIdentity, readKernel(record.hostPid)) !== 'same') {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the Host kernel identity changed before the signal')
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

/** Stop one live independent authenticated Host through exactly one verified
 *  POSIX SIGTERM (Linux procfs identity or Darwin schema-2 kernel identity). */
async function stopIndependentHost(
  snapshot: Snapshot,
  deps: DaemonControlDeps,
): Promise<void> {
  const record = snapshot.record
  if (record === undefined) {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the Host registry disappeared before the stop')
  }
  const authenticate = deps.authenticate ?? authenticateLocalHost
  let authenticated: VerifiedLocalHost
  try {
    authenticated = await authenticate(record, snapshot.scope)
  } catch (error) {
    throw toDaemonControlError(error)
  }
  if (platformOf(deps) === 'darwin') {
    assertDarwinHostOwnership(record, authenticated, deps)
  } else {
    assertProcessHostOwnership(record, deps)
    const readStarttime = deps.readStarttime ?? ((pid: number) => {
      try { return readLinuxStarttime(pid) } catch { return undefined }
    })
    if (record.schema !== 1 || readStarttime(record.hostPid) !== record.hostStarttime) {
      throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the Host process start identity changed before the signal')
    }
  }
  assertNotAborted(deps.signal)
  const kill = deps.kill ?? process.kill
  try {
    kill(record.hostPid, 'SIGTERM')
  } catch (error) {
    throw new DaemonControlError('MANAGER_OR_OS_FAILURE', 'the verified Host process could not be signalled', error)
  }
  try {
    await waitForHostStopped(record, record.hostPid, deps)
  } catch (error) {
    throw afterCommittedAction(toDaemonControlError(error), 'Host stop')
  }
}

/**
 * Stop the snapshot's Host and prove the original instance is gone.
 *
 * Linux routing follows the authenticated attribution, never the mere presence
 * of a systemd user bus:
 * - a loaded active/activating unit whose MainPID IS the authenticated Host is
 *   stopped through that unit and its exit is awaited;
 * - an independent authenticated Host (no unit, or a loaded unit that systemd
 *   reports as inactive/failed/not-found) is re-authenticated, its platform
 *   ownership proof (Linux procfs starttime + exact product Host entry, Darwin
 *   schema-2 kernel identity) is re-checked, and exactly that PID receives one
 *   SIGTERM;
 * - a live Host beside an active unit with a different MainPID, a unit in flux,
 *   or an unreadable manager is refused WITHOUT trying the other stop method.
 *
 * Darwin routing uses the verified LaunchAgent instead of a systemd unit: a
 * loaded job whose fixed launch facts match this profile and whose real PID is
 * the authenticated Host is stopped only through `bootout`; a job that is
 * loaded but not running is booted out without a signal; anything transitional,
 * foreign or unreadable is refused.
 */
async function stopFromSnapshot(
  snapshot: Snapshot,
  deps: DaemonControlDeps,
): Promise<void> {
  if (platformOf(deps) === 'darwin') return await stopDarwinFromSnapshot(snapshot, deps)
  const { unit, unitState, unitActiveState, unitMainPid, record, processAlive } = snapshot
  const systemctl = deps.systemctl ?? runSystemctl
  const liveHost = processAlive && record !== undefined
  const loaded = unit !== undefined && unitState !== 'not-found'
  const running = loaded && (unitActiveState === 'active' || unitActiveState === 'activating')
  const ended = loaded && (unitActiveState === 'inactive' || unitActiveState === 'failed')
  if (snapshot.userManager === 'error') {
    throw snapshot.unitQueryFailure ?? new DaemonControlError('MANAGER_OR_OS_FAILURE', 'the user manager cannot verify the profile unit')
  }
  if (liveHost) {
    if (running) {
      if (unit === undefined || unitMainPid !== record.hostPid) {
        throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the unit MainPID is not the authenticated Host; refusing to signal an unknown process')
      }
      assertNotAborted(deps.signal)
      await stopOwnedProfileUnit(unit, runtimeDirOf(deps), systemctl, deps.stopTimeoutMs)
      try {
        await waitForHostStopped(record, unitMainPid, deps)
      } catch (error) {
        throw afterCommittedAction(toDaemonControlError(error), 'Host stop')
      }
      return
    }
    if (loaded && !ended) {
      throw new DaemonControlError('TRANSITION_UNCERTAIN', `the profile unit is in an unconfirmed state (${unitActiveState === '' ? 'unknown' : unitActiveState}); refusing to signal the Host`)
    }
    if (!running) {
      await stopIndependentHost(snapshot, deps)
      return
    }
  }
  if (loaded) {
    if (!ended && !running) {
      throw new DaemonControlError('TRANSITION_UNCERTAIN', `the profile unit is in an unconfirmed state (${unitActiveState === '' ? 'unknown' : unitActiveState}); refusing to change supervision`)
    }
    if (unit === undefined) return
    assertNotAborted(deps.signal)
    await stopOwnedProfileUnit(unit, runtimeDirOf(deps), systemctl, deps.stopTimeoutMs)
    try {
      await waitForHostStopped(undefined, unitMainPid, deps)
    } catch (error) {
      throw afterCommittedAction(toDaemonControlError(error), 'Host stop')
    }
  }
  // No live Host and no loaded unit: already stopped (idempotent no-op).
}

/** The Darwin stop route: verified LaunchAgent bootout or one verified SIGTERM. */
async function stopDarwinFromSnapshot(snapshot: Snapshot, deps: DaemonControlDeps): Promise<void> {
  const { launchdUnit, launchdFacts, launchdService, record, processAlive } = snapshot
  if (snapshot.launchdInspectionFailure !== undefined) throw snapshot.launchdInspectionFailure
  if (snapshot.launchdQueryFailure !== undefined) throw snapshot.launchdQueryFailure
  const loaded = launchdService?.kind === 'loaded' ? launchdService.service : undefined
  if (launchdService?.kind === 'unknown') {
    throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the launchd job state is not recognizable; refusing to change supervision')
  }
  if (launchdUnit !== undefined && launchdFacts === undefined) {
    throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the launchd job facts are unavailable; refusing to change supervision')
  }
  if (launchdUnit !== undefined && loaded !== undefined && launchdFacts !== undefined
    && !launchdServiceMatches(launchdFacts, launchdUnit, loaded)) {
    throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the loaded launchd job does not match the profile plist; refusing to signal an unknown process')
  }
  const liveHost = processAlive && record !== undefined
  if (liveHost && launchdUnit !== undefined && launchdFacts !== undefined && loaded !== undefined) {
    if (loaded.state === 'running') {
      if (loaded.pid === undefined) {
        throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the launchd job reports running without a PID; refusing to signal the Host')
      }
      if (loaded.pid !== record.hostPid) {
        throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the launchd job PID is not the authenticated Host; refusing to signal an unknown process')
      }
      assertNotAborted(deps.signal)
      // Pass the authenticated Host PID: a job that changed PID between this
      // observation and the adapter's re-inspection must not be booted out.
      await stopLaunchdService(launchdFacts, launchdUnit, launchdDepsOf(deps), record.hostPid)
      try {
        await waitForHostStopped(record, loaded.pid, deps)
      } catch (error) {
        throw afterCommittedAction(toDaemonControlError(error), 'Host stop')
      }
      return
    }
    if (loaded.state === 'spawn scheduled') {
      throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the launchd job is still starting beside the live Host; refusing to signal the Host')
    }
    if (loaded.state !== 'not running') {
      throw new DaemonControlError('TRANSITION_UNCERTAIN', `the launchd job is in an unconfirmed state (${loaded.state === '' ? 'unknown' : loaded.state}); refusing to signal the Host`)
    }
  }
  if (liveHost) {
    // The Host is independent: the launchd job (if any) does not supervise it.
    await stopIndependentHost(snapshot, deps)
    return
  }
  if (loaded !== undefined) {
    if (launchdUnit === undefined || launchdFacts === undefined) {
      throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the launchd job facts are unavailable; refusing to change supervision')
    }
    // With no authenticated Host record, a running/starting job has no proven
    // process identity or exit proof. Bootout/kill/new-start must fail closed;
    // only a genuinely not-running, PID-less definition is safe to unload.
    if (loaded.pid !== undefined || loaded.state === 'running' || loaded.state === 'spawn scheduled') {
      throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the launchd job has a process but no authenticated Host record proves its identity; refusing to change supervision')
    }
    if (loaded.state === 'not running') {
      assertNotAborted(deps.signal)
      await stopLaunchdService(launchdFacts, launchdUnit, launchdDepsOf(deps))
      return
    }
    throw new DaemonControlError('TRANSITION_UNCERTAIN', `the launchd job is in an unconfirmed state (${loaded.state === '' ? 'unknown' : loaded.state}); refusing to change supervision`)
  }
  if (snapshot.launchdQueryFailure !== undefined) throw snapshot.launchdQueryFailure
  // No live Host and no loaded job: already stopped (idempotent no-op).
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
  return await withAdminSeat(inspected, deps, async () => {
    const pre = await readSnapshot(profile, deps, inspected)
    // The snapshot's failure set is the STATUS contract (a manager error is a
    // nonzero diagnostic). `start` owns a different question — does THIS
    // command still need the manager? An authenticated ready Host does not: it
    // is reused exactly like ensureLocalHost reuses it (B02/C05), manager or
    // not. Any other failure (unsafe unit, incompatible/unresponsive Host)
    // still refuses the start.
    if (pre.status.host === 'ready') {
      if (pre.failure !== undefined && pre.failure.code !== 'MANAGER_OR_OS_FAILURE') throw pre.failure
      return { code: 0, stdout: formatDaemonStatus(pre.status), stderr: '' }
    }
    if (pre.failure !== undefined) throw pre.failure
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
        hostStartPolicy: 'public',
      })
    } catch (error) {
      throw toDaemonControlError(error)
    }
    // A cold start's completion needs BOTH facts: no blocking failure and
    // authenticated readiness. The warm-start exemption does not apply here.
    try {
      const post = await readSnapshot(profile, deps, scope)
      if (post.failure !== undefined) throw post.failure
      if (post.status.host !== 'ready') throw refuseHostState(post.status)
      return { code: 0, stdout: formatDaemonStatus(post.status), stderr: '' }
    } catch (error) {
      throw afterCommittedAction(toDaemonControlError(error), 'Host start')
    }
  })
}

/** The `stop` handler. */
async function runStop(profile: DaemonControlProfile, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  const inspected = inspectScope(profile, deps)
  return await withAdminSeat(inspected, deps, async () => {
    const pre = await readSnapshot(profile, deps, inspected)
    if (pre.failure !== undefined && !verifiedUnitManagementAdmitted(pre) && !verifiedLaunchdManagementAdmitted(pre)) throw pre.failure
    assertNotAborted(deps.signal)
    await stopFromSnapshot(pre, deps)
    try {
      const post = await readSnapshot(profile, deps, inspected)
      if (post.failure !== undefined) throw post.failure
      if (post.status.host !== 'stopped') throw refuseHostState(post.status)
      return { code: 0, stdout: formatDaemonStatus(post.status), stderr: RUNNING_WORK_NOTICE }
    } catch (error) {
      throw afterCommittedAction(toDaemonControlError(error), 'Host stop')
    }
  })
}

/** The `restart` handler: stop -> confirmed exit -> controlled unit refresh -> start. */
async function runRestart(profile: DaemonControlProfile, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  const inspected = inspectScope(profile, deps)
  return await withAdminSeat(inspected, deps, async () => {
    const pre = await readSnapshot(profile, deps, inspected)
    const launchdLoaded = pre.launchdService?.kind === 'loaded' ? pre.launchdService.service : undefined
    const launchdVerified = pre.launchdUnit !== undefined && pre.launchdFacts !== undefined && launchdLoaded !== undefined
      && launchdServiceMatches(pre.launchdFacts, pre.launchdUnit, launchdLoaded)
    const unitFailureRecovery = verifiedUnitManagementAdmitted(pre)
      && (pre.record === undefined || !pre.processAlive || pre.unitMainPid === pre.record.hostPid)
    const launchdFailureRecovery = launchdVerified
      && (pre.hostAuthenticationFailed || pre.hostCompatibilityFailed)
      && (pre.record === undefined || !pre.processAlive || launchdLoaded?.pid === pre.record.hostPid)
    // An explicit restart is a service operation, not a Ready verdict. A
    // verified current-Profile unit/job that is active/starting may be stuck
    // before readiness; the same verified stop target that `stop` accepts must
    // be restartable. Transitional/foreign states remain refusals.
    const verifiedUnitRestart = pre.unit !== undefined
      && pre.userManager === 'available'
      && (pre.unitActiveState === 'active' || pre.unitActiveState === 'activating')
      && (pre.record === undefined || !pre.processAlive || pre.unitMainPid === pre.record.hostPid)
    const verifiedLaunchdRestart = launchdVerified
      && launchdLoaded !== undefined
      && (launchdLoaded.state === 'running' || launchdLoaded.state === 'spawn scheduled' || launchdLoaded.state === 'not running')
      && (pre.record === undefined || !pre.processAlive || launchdLoaded.pid === pre.record.hostPid)
    const serviceFailureRecovery = unitFailureRecovery || launchdFailureRecovery
    if (pre.failure !== undefined && !serviceFailureRecovery) throw pre.failure
    if (pre.status.host !== 'ready' && pre.status.host !== 'stopped'
      && !serviceFailureRecovery && !verifiedUnitRestart && !verifiedLaunchdRestart) throw refuseHostState(pre.status)
    const oldInstance = pre.record?.instanceId
    // Owner decision (M6-2C scope): an owned service from ANOTHER installed
    // build is never migrated here. Cross-build replacement is the upgrade
    // flow's work; this stage refuses it BEFORE any stop so a refused restart
    // leaves the running old-build Host and its service exactly as they were.
    if (pre.unit !== undefined && pre.unit.installBuild !== pre.scope.buildId) {
      throw new DaemonControlError(
        'IDENTITY_OR_OWNERSHIP_REFUSED',
        'the profile unit belongs to another installed build; removing or replacing it is deferred to the upgrade flow',
      )
    }
    if (pre.launchdUnit !== undefined && pre.launchdUnit.installBuild !== pre.scope.buildId) {
      throw new DaemonControlError(
        'IDENTITY_OR_OWNERSHIP_REFUSED',
        'the profile LaunchAgent belongs to another installed build; removing or replacing it is deferred to the upgrade flow',
      )
    }
    assertNotAborted(deps.signal)
    await stopFromSnapshot(pre, deps)
    try {
      assertNotAborted(deps.signal)
      const scope = scopeFromInstalledProfile({
        dshHome: profile.home,
        profileDir: profile.dir,
        packageRoot: profile.packageRoot,
        dshVersion: profile.dshVersion,
      })
      assertNotAborted(deps.signal)
      const ensureHost = deps.ensureHost ?? ensureLocalHost
      await ensureHost({
        scope,
        hostEntryPath: join(profile.packageRoot, 'dist', 'local-host.mjs'),
        dshAnchor: profile.installAnchor,
        profile: profile.name,
        hostStartPolicy: 'public',
      })
      const post = await readSnapshot(profile, deps, scope)
      if (post.failure !== undefined) throw post.failure
      if (post.status.host !== 'ready') throw refuseHostState(post.status)
      if (oldInstance !== undefined && post.record?.instanceId === oldInstance) {
        throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the restart did not produce a new Host instance')
      }
      return {
        code: 0,
        stdout: `previous=${oldInstance === undefined ? 'none' : oldInstance.slice(0, 8)}\n${formatDaemonStatus(post.status)}`,
        stderr: RUNNING_WORK_NOTICE,
      }
    } catch (error) {
      throw afterCommittedAction(toDaemonControlError(error), 'Host restart')
    }
  })
}

/** The `install` handler: explicit unit installation only, never host control. */
async function runInstall(profile: DaemonControlProfile, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  if (platformOf(deps) === 'darwin') return await runDarwinInstall(profile, deps)
  const inspected = inspectScope(profile, deps)
  return await withAdminSeat(inspected, deps, async () => {
    const pre = await readSnapshot(profile, deps, inspected)
    // An install owns exactly one question: may this Profile write/verify its
    // unit? A foreign unit or an unreadable manager blocks it; a Host that is
    // merely unauthenticated/incompatible does not (install never touches it).
    if (pre.unitInspectionFailure !== undefined) throw pre.unitInspectionFailure
    if (pre.unitQueryFailure !== undefined) throw pre.unitQueryFailure
    const unitDir = deps.unitDir
    assertNotAborted(deps.signal)
    try {
      await installProfileHostUnit(
        {
          scope: inspected,
          hostEntryPath: join(profile.packageRoot, 'dist', 'local-host.mjs'),
          dshAnchor: profile.installAnchor,
          profile: profile.name,
        },
        {
          ...(deps.systemctl === undefined ? {} : { systemctl: deps.systemctl }),
          ...(unitDir === undefined ? {} : { unitDir: () => unitDir }),
        },
      )
    } catch (error) {
      throw toDaemonControlError(error)
    }
    // Post-verification: the unit must be this Profile's verified unit, and a
    // running independent Host must be exactly the same instance afterward —
    // install never migrates or restarts it.
    try {
      const post = await readSnapshot(profile, deps, inspected)
      if (post.unitInspectionFailure !== undefined) throw post.unitInspectionFailure
      if (post.unitQueryFailure !== undefined) throw post.unitQueryFailure
      if (post.unit === undefined) {
        throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the installed profile unit could not be confirmed')
      }
      if (post.unit.installBuild !== post.scope.buildId) {
        throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the installed profile unit belongs to another installed build')
      }
      if (pre.processAlive && pre.record !== undefined
        && (!post.processAlive || post.record === undefined || post.record.instanceId !== pre.record.instanceId)) {
        throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the running Host instance changed during the unit install')
      }
      return { code: 0, stdout: formatDaemonStatus(post.status), stderr: '' }
    } catch (error) {
      throw afterCommittedAction(toDaemonControlError(error), 'profile unit install')
    }
  })
}

/** The `uninstall` handler: remove this Profile's service definition only. */
async function runUninstall(profile: DaemonControlProfile, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  if (platformOf(deps) === 'darwin') return await runDarwinUninstall(profile, deps)
  const inspected = inspectScope(profile, deps)
  return await withAdminSeat(inspected, deps, async () => {
    const pre = await readSnapshot(profile, deps, inspected)
    // A named unit that is NOT this Profile's verified unit stays a hard
    // refusal. Uninstall owns ONLY the service definition, so with no owned
    // unit it is an idempotent no-op regardless of unrelated Host registry or
    // authentication health: it never needs to control the Host.
    if (pre.unitInspectionFailure !== undefined) throw pre.unitInspectionFailure
    if (pre.unit === undefined) {
      return { code: 0, stdout: formatDaemonStatus(pre.status), stderr: '' }
    }
    if (pre.failure !== undefined && !verifiedUnitManagementAdmitted(pre)) throw pre.failure
    if (pre.userManager !== 'available') {
      throw new DaemonControlError('MANAGER_OR_OS_FAILURE', 'the user manager cannot verify the profile unit')
    }
    // Cross-build unit replacement is the upgrade flow's job. Never rewrite or
    // remove a unit this installed build does not own.
    if (pre.unit.installBuild !== pre.scope.buildId) {
      throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the profile unit belongs to another installed build; use the upgrade flow')
    }
    const loaded = pre.unitState !== 'not-found'
    const running = loaded && (pre.unitActiveState === 'active' || pre.unitActiveState === 'activating')
    const ended = loaded && (pre.unitActiveState === 'inactive' || pre.unitActiveState === 'failed')
    const liveHost = pre.processAlive && pre.record !== undefined
    if (loaded && !running && !ended) {
      throw new DaemonControlError('TRANSITION_UNCERTAIN', `the profile unit is in an unconfirmed state (${pre.unitActiveState === '' ? 'unknown' : pre.unitActiveState}); refusing to uninstall`)
    }
    // Only a running unit that IS the current authenticated Host may be
    // stopped. A unit that supervises no Host (inactive/failed/not-loaded) is
    // unlink-only and leaves any independent Host running.
    if (running) {
      if (liveHost && pre.unitMainPid !== pre.record.hostPid) {
        throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the profile unit MainPID is not the live Host; refusing to uninstall')
      }
      const systemctl = deps.systemctl ?? runSystemctl
      assertNotAborted(deps.signal)
      await stopOwnedProfileUnit(pre.unit, runtimeDirOf(deps), systemctl, deps.stopTimeoutMs)
      const ownHost = liveHost && pre.record !== undefined && pre.record.hostPid === pre.unitMainPid ? pre.record : undefined
      try {
        await waitForHostStopped(ownHost, pre.unitMainPid, deps)
      } catch (error) {
        throw afterCommittedAction(toDaemonControlError(error), 'Host stop for uninstall')
      }
    }
    const systemctl = deps.systemctl ?? runSystemctl
    assertNotAborted(deps.signal)
    uninstallOwnedProfileUnit(pre.unit, pre.scope, profile.name)
    try {
      const reload = await systemctl(['--user', '--no-pager', '--no-ask-password', 'daemon-reload'], runtimeDirOf(deps))
      if (reload.kind !== 'exited' || reload.code !== 0) {
        throw new DaemonControlError('MANAGER_OR_OS_FAILURE', 'daemon-reload failed after removing the profile unit')
      }
      const post = await readSnapshot(profile, deps, inspected)
      if (post.unitInspectionFailure !== undefined) throw post.unitInspectionFailure
      if (post.unitQueryFailure !== undefined) throw post.unitQueryFailure
      if (existsSync(pre.unit.filePath)) {
        throw new DaemonControlError('MANAGER_OR_OS_FAILURE', 'the profile unit could not be confirmed removed')
      }
      return { code: 0, stdout: formatDaemonStatus(post.status), stderr: running ? RUNNING_WORK_NOTICE : '' }
    } catch (error) {
      throw afterCommittedAction(toDaemonControlError(error), 'profile unit removal')
    }
  })
}

/** The Darwin `install` handler: explicit LaunchAgent plist only, never host control. */
async function runDarwinInstall(profile: DaemonControlProfile, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  const inspected = inspectScope(profile, deps)
  return await withAdminSeat(inspected, deps, async () => {
    const pre = await readSnapshot(profile, deps, inspected)
    // An install owns exactly one question: may this Profile write/verify its
    // plist? A foreign plist/job or an unreadable manager blocks it; a Host that
    // is merely unauthenticated/incompatible does not (install never touches it).
    if (pre.launchdInspectionFailure !== undefined) throw pre.launchdInspectionFailure
    if (pre.launchdQueryFailure !== undefined) throw pre.launchdQueryFailure
    assertNotAborted(deps.signal)
    try {
      const facts = pre.launchdFacts ?? launchdFactsOf(inspected, profile)
      await installLaunchdUnit(facts, launchdDepsOf(deps))
    } catch (error) {
      throw toDaemonControlError(error)
    }
    try {
      const post = await readSnapshot(profile, deps, inspected)
      if (post.launchdInspectionFailure !== undefined) throw post.launchdInspectionFailure
      if (post.launchdQueryFailure !== undefined) throw post.launchdQueryFailure
      if (post.launchdUnit === undefined) {
        throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the installed launchd plist could not be confirmed')
      }
      if (post.launchdUnit.installBuild !== post.scope.buildId) {
        throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the installed launchd plist belongs to another installed build')
      }
      if (pre.processAlive && pre.record !== undefined
        && (!post.processAlive || post.record === undefined || post.record.instanceId !== pre.record.instanceId)) {
        throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the running Host instance changed during the plist install')
      }
      return { code: 0, stdout: formatDaemonStatus(post.status), stderr: '' }
    } catch (error) {
      throw afterCommittedAction(toDaemonControlError(error), 'launchd plist install')
    }
  })
}

/** The Darwin `uninstall` handler: remove this Profile's LaunchAgent only. */
async function runDarwinUninstall(profile: DaemonControlProfile, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  const inspected = inspectScope(profile, deps)
  return await withAdminSeat(inspected, deps, async () => {
    const pre = await readSnapshot(profile, deps, inspected)
    if (pre.launchdInspectionFailure !== undefined) throw pre.launchdInspectionFailure
    // A named plist is the ONLY uninstall target. With no owned plist this is
    // an idempotent no-op and no launchctl call is made.
    if (pre.launchdUnit === undefined) {
      return { code: 0, stdout: formatDaemonStatus(pre.status), stderr: '' }
    }
    if (pre.launchdQueryFailure !== undefined) throw pre.launchdQueryFailure
    if (pre.launchdFacts === undefined) {
      throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the launchd plist facts are unavailable; refusing to uninstall')
    }
    // Cross-build replacement is the upgrade flow's job. Never rewrite or
    // remove a plist this installed build does not own.
    if (pre.launchdUnit.installBuild !== pre.scope.buildId) {
      throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the profile LaunchAgent belongs to another installed build; use the upgrade flow')
    }
    const service = pre.launchdService
    if (service?.kind === 'unknown') {
      throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the launchd job state is not recognizable; refusing to uninstall')
    }
    const loadedService = service?.kind === 'loaded' ? service.service : undefined
    const liveHost = pre.processAlive && pre.record !== undefined
    const running = loadedService !== undefined
      && (loadedService.pid !== undefined || loadedService.state === 'running' || loadedService.state === 'spawn scheduled')
    // Only a running job that IS the live authenticated Host may stop that
    // Host. A job whose real PID is another live Host is a conflict, never a
    // permission to signal.
    if (running && liveHost && pre.record !== undefined && loadedService?.pid !== pre.record.hostPid) {
      throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the launchd job PID is not the live Host; refusing to uninstall')
    }
    if (running && !liveHost) {
      throw new DaemonControlError('IDENTITY_OR_OWNERSHIP_REFUSED', 'the launchd job has a process but no authenticated Host record proves its identity; refusing to uninstall')
    }
    assertNotAborted(deps.signal)
    try {
      // Pass the live Host PID whenever one exists, not only when the job was
      // already running at snapshot time: an external kickstart can turn a
      // loaded-but-not-running job into a different process before the adapter
      // re-inspects it, and that process must never be booted out.
      const expectedPid = liveHost && pre.record !== undefined ? pre.record.hostPid : undefined
      await uninstallLaunchdUnit(pre.launchdFacts, pre.launchdUnit, launchdDepsOf(deps), expectedPid)
      if (running && liveHost && pre.record !== undefined) {
        await waitForHostStopped(pre.record, loadedService?.pid ?? pre.record.hostPid, deps)
      }
    } catch (error) {
      throw afterCommittedAction(toDaemonControlError(error), 'launchd plist removal')
    }
    try {
      const post = await readSnapshot(profile, deps, inspected)
      if (post.launchdInspectionFailure !== undefined) throw post.launchdInspectionFailure
      if (post.launchdUnit !== undefined) {
        throw new DaemonControlError('TRANSITION_UNCERTAIN', 'the profile LaunchAgent could not be confirmed removed')
      }
      return { code: 0, stdout: formatDaemonStatus(post.status), stderr: running ? RUNNING_WORK_NOTICE : '' }
    } catch (error) {
      throw afterCommittedAction(toDaemonControlError(error), 'launchd plist removal')
    }
  })
}

/**
 * Run one fixed `journalctl --user-unit <verified-name>` invocation.
 *
 * `--unit` filters the SYSTEM unit field (`_SYSTEMD_UNIT`), so with `--user` it
 * never matches a user unit's entries — it silently prints nothing. The user
 * unit field is selected by `--user-unit` (`_SYSTEMD_USER_UNIT`), which is the
 * only form that returns the managed unit's journal.
 */
export function journalctlArgs(unit: string, lines: number): string[] {
  return ['--user-unit', unit, '--no-pager', '-o', 'cat', '-n', String(lines)]
}

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
      child = spawn(JOURNALCTL, journalctlArgs(unit, lines), {
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

/**
 * Read the tail of the scope `host.log`. The read is bounded and never follows
 * a final symlink, but it does not judge the user's existing owner/mode: an
 * existing 0644 log chosen by the user is readable. New logs are still created
 * 0600 by `spawnHostCandidate`.
 */
async function tailHostLog(path: string, lines: number): Promise<string | undefined> {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // A missing log, or an existing final symlink (never followed), means there
    // is no readable source. Any other failure is a real read failure and is
    // reported instead of being disguised as "no log".
    if (code === 'ENOENT' || code === 'ELOOP') return undefined
    throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the Host log could not be opened')
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile()) return undefined
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

/**
 * Darwin log source: a verified loaded LaunchAgent governs the profile and its
 * private `launchd.stdout.log` / `launchd.stderr.log` are read as two
 * separately bounded, separately labelled streams (never presented as one
 * time-merged log). A job that is installed but NOT loaded does not govern an
 * independent Host, so that Host keeps reading `host.log`. After the launchd
 * job has stopped there is no live authority proving whether the retained
 * launchd streams or an earlier `host.log` is the most recent Host; the source
 * is unprovable and the command fails closed instead of guessing a file.
 */
async function runDarwinLogs(
  scope: LocalScope,
  intent: DaemonControlIntent,
  deps: DaemonControlDeps,
  snapshot: Snapshot,
): Promise<DaemonControlResult> {
  if (snapshot.launchdInspectionFailure !== undefined) throw snapshot.launchdInspectionFailure
  if (snapshot.launchdQueryFailure !== undefined) {
    // A launchd job-identity refusal is the ownership refusal it already is;
    // any other manager failure means no source can be attributed.
    if (snapshot.launchdQueryFailure.code === 'IDENTITY_OR_OWNERSHIP_REFUSED') throw snapshot.launchdQueryFailure
    throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', `the launchd job cannot be verified: ${snapshot.launchdQueryFailure.reason}`)
  }
  const lines = intent.lines ?? 100
  const { launchdUnit, launchdFacts, launchdService, record, processAlive, authenticated } = snapshot
  const liveHost = processAlive && record !== undefined
  const loadedService = launchdService?.kind === 'loaded' ? launchdService.service : undefined
  let launchdSource: LaunchdUnitFacts | undefined
  if (liveHost) {
    if (authenticated === undefined) {
      throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the authenticated Host is unavailable; refusing to guess a log source')
    }
    if (snapshot.status.manager === 'launchd') {
      if (launchdUnit === undefined || launchdFacts === undefined || loadedService === undefined) {
        throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the launchd-managed Host facts are unavailable; refusing to guess a log source')
      }
      if (!launchdServiceMatches(launchdFacts, launchdUnit, loadedService)) {
        throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the launchd job does not match the profile plist; refusing to guess a log source')
      }
      if (loadedService.pid !== record?.hostPid) {
        throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the launchd job PID is not the authenticated Host; refusing to guess a log source')
      }
      launchdSource = launchdFacts
    } else if (snapshot.status.manager === 'process') {
      // The authenticated Host is independent. A loaded job that is actually
      // running/scheduled beside it is a conflicting supervisor; a merely
      // loaded, not-running job does not govern this Host, so host.log is the
      // current source (plan L08).
      if (launchdUnit !== undefined && launchdFacts === undefined) {
        throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the launchd job facts are unavailable; refusing to guess a log source')
      }
      if (launchdService?.kind === 'unknown') {
        throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the launchd job state is not recognizable; refusing to guess a log source')
      }
      if (launchdUnit !== undefined && launchdFacts !== undefined && loadedService !== undefined) {
        if (!launchdServiceMatches(launchdFacts, launchdUnit, loadedService)) {
          throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the launchd job does not match the profile plist; refusing to guess a log source')
        }
        if (loadedService.pid !== undefined || loadedService.state === 'running' || loadedService.state === 'spawn scheduled') {
          throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the loaded launchd job does not supervise the authenticated Host; refusing to guess a log source')
        }
      }
    } else {
      throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', `the Host supervision is ${snapshot.status.manager}; refusing to guess a log source`)
    }
  } else if (launchdUnit !== undefined) {
    if (launchdFacts === undefined) {
      throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the launchd job facts are unavailable; refusing to guess a log source')
    }
    if (launchdService?.kind === 'unknown') {
      throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the launchd job state is not recognizable; refusing to guess a log source')
    }
    if (loadedService !== undefined) {
      if (!launchdServiceMatches(launchdFacts, launchdUnit, loadedService)) {
        throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the launchd job does not match the profile plist; refusing to guess a log source')
      }
      launchdSource = launchdFacts
    } else if (launchdService?.kind === 'not-loaded') {
      // A stopped job leaves two possible historical sources (the retained
      // launchd streams and an earlier independent host.log) and no live
      // authority that proves which one is the most recent Host. Never choose
      // one by file existence; the caller can read the retained files directly.
      throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the last Host log source cannot be proven after the launchd job stopped; read the retained launchd logs or host.log directly')
    }
  }
  if (launchdSource !== undefined) {
    const logs = launchdLogPaths(launchdSource.scopeDir)
    const tail = deps.hostLogTail ?? tailHostLog
    const stdout = await tail(logs.stdout, lines)
    const stderr = await tail(logs.stderr, lines)
    const sections: string[] = []
    if (stdout !== undefined && stdout.trim() !== '') {
      sections.push(`[dsh-pi-tui daemon: launchd stdout]\n${sanitizeLogText(stdout).replace(/\n*$/u, '\n')}`)
    }
    if (stderr !== undefined && stderr.trim() !== '') {
      sections.push(`[dsh-pi-tui daemon: launchd stderr]\n${sanitizeLogText(stderr).replace(/\n*$/u, '\n')}`)
    }
    if (sections.length === 0) {
      throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'no launchd Host log output is available for this profile')
    }
    return { code: 0, stdout: sections.join(''), stderr: LOG_SANITIZATION_NOTICE }
  }
  if (!liveHost && launchdUnit === undefined) {
    const logs = launchdLogPaths(scope.dir)
    if (existsSync(logs.stdout) || existsSync(logs.stderr)) {
      throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the last Host log source cannot be proven after the launchd plist was removed; read the retained launchd logs or host.log directly')
    }
  }
  // No live launchd-managed Host: the independent Host (or the last stopped
  // independent Host) writes the scope host.log.
  const path = join(scope.dir, 'host.log')
  const tail = deps.hostLogTail ?? tailHostLog
  const value = await tail(path, lines)
  if (value === undefined || value.trim() === '') {
    throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'no Host log is available for this profile')
  }
  return { code: 0, stdout: `${sanitizeLogText(value)}`, stderr: LOG_SANITIZATION_NOTICE }
}

/**
 * The `logs` handler. The source follows the SAME verified attribution as
 * `status`: an installed, manager-loaded unit that actually supervises the
 * current Host (or governs a stopped/starting profile) reads its
 * `journalctl --user-unit` journal; a genuinely independent Host, or a profile
 * with no loaded unit, reads the scope `host.log`. An unreadable manager or a
 * unit whose ownership is in flux is an explicit failure — the command never
 * guesses a source.
 */
async function runLogs(profile: DaemonControlProfile, intent: DaemonControlIntent, deps: DaemonControlDeps): Promise<DaemonControlResult> {
  const scope = inspectScope(profile, deps)
  const snapshot = await readSnapshot(profile, deps, scope)
  if (platformOf(deps) === 'darwin') return await runDarwinLogs(scope, intent, deps, snapshot)
  if (snapshot.unitInspectionFailure !== undefined) throw snapshot.unitInspectionFailure
  if (snapshot.unitQueryFailure !== undefined) {
    // A manager channel failure is a log-source failure; a unit-identity refusal
    // stays the ownership refusal it already is.
    if (snapshot.unitQueryFailure.code === 'IDENTITY_OR_OWNERSHIP_REFUSED') throw snapshot.unitQueryFailure
    throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', `the user manager cannot verify the profile unit: ${snapshot.unitQueryFailure.reason}`)
  }
  const lines = intent.lines ?? 100
  const { unit, unitState, unitActiveState, unitMainPid, record, processAlive, authenticated } = snapshot
  const liveHost = processAlive && record !== undefined
  const loaded = unit !== undefined && unitState !== 'not-found'
  const running = loaded && (unitActiveState === 'active' || unitActiveState === 'activating')
  const ended = loaded && (unitActiveState === 'inactive' || unitActiveState === 'failed')
  let source: 'journal' | 'host-log'
  if (running) {
    if (liveHost) {
      // A live Host beside a running unit is attributable ONLY when the
      // authenticated PID is that unit's MainPID. Anything else is unresolved.
      if (authenticated === undefined || record === undefined || unitMainPid !== record.hostPid) {
        throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'the unit MainPID is not the authenticated Host; refusing to guess a log source')
      }
    }
    source = 'journal'
  } else if (loaded && !ended) {
    throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', `the profile unit is in an unconfirmed state (${unitActiveState === '' ? 'unknown' : unitActiveState}); refusing to guess a log source`)
  } else {
    // No loaded unit (no unit, or the file is not loaded): the Host, if any, is
    // independent and writes the scope host.log. A loaded inactive/failed unit
    // with no live Host still has its journal.
    source = ended && !liveHost ? 'journal' : 'host-log'
  }
  let text: string
  if (source === 'journal' && unit !== undefined) {
    const journal = deps.journal ?? runJournalctl
    const result = await journal(unit.unitName, lines)
    if (result.code !== 0 || result.stdout.trim() === '') {
      throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'no journal entries are available for the owned profile unit')
    }
    text = result.stdout
  } else {
    const path = join(scope.dir, 'host.log')
    const tail = deps.hostLogTail ?? tailHostLog
    const value = await tail(path, lines)
    if (value === undefined || value.trim() === '') {
      throw new DaemonControlError('LOG_SOURCE_UNAVAILABLE', 'no Host log is available for this profile')
    }
    text = value
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
      case 'install':
        return await runInstall(profile, deps)
      case 'uninstall':
        return await runUninstall(profile, deps)
    }
  } catch (error) {
    const failure = toDaemonControlError(error)
    const notice = intent.verb === 'stop' || intent.verb === 'restart'
      ? RUNNING_WORK_NOTICE
      : ''
    return { code: failure.exitCode, stdout: '', stderr: `${formatDaemonControlError(failure)}${notice}` }
  }
}
