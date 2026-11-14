#!/usr/bin/env node
/**
 * Client-only split-process entry.
 *
 * The Client PID owns a real Cordis root and mounts only the Client-local
 * subtree plus the official Node Client transport. Its one scope is the
 * canonical DSH profile: the frozen `qualification` mode first claims the
 * qualification-only kernel Client seat (the real `surface` and `peer` modes
 * do not), then discovers (or safely ensures) the Host, authenticates it
 * through the official `/connect` cookie, verifies the authenticated
 * identity, and only then installs the official three-layer transport on the
 * same A0 Client Context. The Host Singleton keeps its own separate kernel
 * seat in every mode.
 *
 * Client admission compares the required local wire protocol and the exact
 * DSH runtime version, not the package bundle/build fingerprint. A different
 * installed build of the same protocol may attach; a protocol or DSH mismatch
 * is refused before any Host work is touched and never stops or replaces the
 * live Host.
 *
 * The launcher supplies the DSH installation anchor and profile name through
 * `SPLIT_PROCESS_DSH_ANCHOR` / `SPLIT_PROCESS_PROFILE` so this process can
 * install the same official package-resolution interception the dsh launcher
 * uses. The package's own `dist/` location stays the installation point — no
 * repository source path or tsx loader is involved.
 *
 * @module app/remote-process/local-client-entry
 */

import { spawn } from 'node:child_process'
import { constants, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants as osConstants } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { mergeCause } from '../remote/dispose-cause.ts'
import type { CliSessionLaunchIntent } from '../../startup.ts'
import { attachEntryControl, createEntryDiag, writeEntryRecord, type EntryControlRequest, type EntryRecordSink } from './entry-control.ts'
import {
  bindProcessSeat,
  computeBuildId,
  installedPackageRootFromEntry,
  LocalScopeError,
  readInstalledDshVersion,
  readLinuxStarttime,
  scopeFromInstalledProfile,
  type ProcessSeat,
} from './local-scope.ts'
import { ensureLocalHost, type VerifiedLocalHost } from './local-discovery.ts'
import {
  classifyLaunchWorkspace,
  type LaunchWorkspaceVerdict,
} from './local-workspace-equivalence.ts'
import type {
  LocalClientComposition,
  LocalClientHandle,
  LocalClientStatus,
  MountedLocalClientRunner,
  MountedRemoteClientDomains,
  MountedRemoteClientDomainPrerequisites,
} from './client-bootstrap.ts'
import type { InstalledLocalClientTransport, LocalClientTransport } from './local-transport.ts'
import {
  createSplitClientInteractionDelivery,
  type SplitClientInteractionDeliveryOwner,
} from './client-interaction-delivery.ts'
import { createLocalClientSurfaceBridge } from './local-client-surface.ts'
import { runDetached } from '../../runtime/process/tasks.ts'
import type { ClientReloadProcessRefusal, ClientReloadRequestResult } from '../application-runtime.ts'

/**
 * The Client process's OWN launch directory, captured ONCE at module start.
 * A later `process.cwd()` change (a shell builtin, a plugin) is not the launch
 * fact, so the automatic Workspace classifier never follows drift.
 */
const CLIENT_LAUNCH_CWD = process.cwd()
/** The DIRECTORY OBJECT the Client started in, captured at the same instant as
 *  `CLIENT_LAUNCH_CWD`. A later rename+recreation of the path must not be
 *  mistaken for the launch directory (external review EXT-P1). An unreadable
 *  capture stays `undefined`; the classifier then falls back to its own real
 *  `stat('.')` object and still fails closed. */
const CLIENT_LAUNCH_OBJECT = ((): { device: number; inode: number } | undefined => {
  try {
    const stat = statSync('.')
    return stat.isDirectory() ? { device: stat.dev, inode: stat.ino } : undefined
  } catch {
    return undefined
  }
})()

interface OfficialClientHostModules {
  readonly Context: new () => import('@deepseek-ai/cordis').Context
  readonly PluginPackages: abstract new (...args: never[]) => unknown
  readonly Loader: new (ctx: import('@deepseek-ai/cordis').Context) => import('@deepseek-ai/cordis-plugin-loader').Loader
  readonly loadProfile: (binName: string, name: string, installAnchor: string) => unknown
  readonly createRuntimeResolution: (options: {
    installAnchor: string
    profile: unknown
  }) => Promise<unknown>
  readonly resolveDshHome: () => string
  readonly resolveProfileDir: (name: string, home?: string) => string
}

/** Load the published DSH modules this entry needs, from the installation anchor. */
async function loadOfficialClientHost(anchor: string): Promise<OfficialClientHostModules> {
  const requireFromDsh = createRequire(realpathSync(anchor))
  const importResolved = async (specifier: string): Promise<Record<string, unknown>> =>
    import(pathToFileURL(requireFromDsh.resolve(specifier)).href)
  const appBoot = await importResolved('@deepseek-ai/dsh-app-boot')
  const cordis = await importResolved('@deepseek-ai/cordis')
  const loaderModule = await importResolved('@deepseek-ai/cordis-plugin-loader')
  const homePaths = await importResolved('@deepseek-ai/dsh-home-paths')
  return {
    Context: cordis.Context as OfficialClientHostModules['Context'],
    PluginPackages: appBoot.PluginPackages as OfficialClientHostModules['PluginPackages'],
    Loader: loaderModule.default as OfficialClientHostModules['Loader'],
    loadProfile: appBoot.loadProfile as OfficialClientHostModules['loadProfile'],
    createRuntimeResolution: appBoot.createRuntimeResolution as OfficialClientHostModules['createRuntimeResolution'],
    resolveDshHome: homePaths.resolveDshHome as OfficialClientHostModules['resolveDshHome'],
    resolveProfileDir: appBoot.resolveProfileDir as OfficialClientHostModules['resolveProfileDir'],
  }
}

/** The internal Client process mode: frozen B1 qualification, the real
 *  surface, or the qualification-only non-TUI answering Peer. */
export type LocalClientEntryMode = 'qualification' | 'surface' | 'peer'

/** The launcher-supplied facts one Client-only process needs. */
export interface LocalClientEntryOptions {
  /** Absolute path of the installed `@deepseek-ai/dsh/package.json`. */
  readonly dshAnchor: string
  /** Profile whose installed package table supplies the peer-resolution layer. */
  readonly profile: string
  /** Internal mode; the production default is the frozen qualification channel. */
  readonly mode: LocalClientEntryMode
  /** Surface-mode internal `--session` intent (qualified resume); absent = sessionless. */
  readonly sessionId?: string
  /** Surface-mode internal `--preset` intent (fresh-session create). */
  readonly presetId?: string
}

/** Project the authenticated record without the profile path or cookie. */
function hostRecordForTrace(host: VerifiedLocalHost): Record<string, unknown> {
  const record = host.identity
  return {
    scopeId: record.scopeId,
    instanceId: record.instanceId,
    hostPid: record.hostPid,
    hostStarttime: record.hostStarttime,
    origin: record.origin,
    protocol: record.protocol,
    bundleVersion: record.bundleVersion,
    dshVersion: record.dshVersion,
    buildId: record.buildId,
  }
}

/**
 * The surface-mode telemetry sink: an owner-managed `0600` absolute JSONL file
 * under the isolated qualification work root. Terminal bytes never carry JSON
 * in surface mode, and the file never records a Cookie, token or private Host
 * profile path. The parent directory's REAL path and ownership are validated
 * before the file is opened; a symlinked target is refused.
 */
function createSurfaceRecordSink(): { emit: EntryRecordSink; close(): void } | undefined {
  const target = process.env.SPLIT_PROCESS_CLIENT_RECORD_FILE
  // Optional: a real daemon Client is launched with NO record file. The
  // surface sink is initialized only when the qualification channel explicitly
  // injects one; otherwise the caller uses a silent, non-tty observation sink.
  if (target === undefined || target === '') return undefined
  if (!isAbsolute(target)) {
    throw new Error('local client entry: the surface record file path must be absolute')
  }
  const directory = realpathSync(dirname(target))
  const directoryStats = statSync(directory)
  if (!directoryStats.isDirectory()) {
    throw new Error('local client entry: the surface record directory is not a directory')
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && directoryStats.uid !== uid) {
    throw new Error('local client entry: the surface record directory is not owned by this process user')
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error('local client entry: the surface record file must not be a symlink')
  }
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
  // `openSync` honors the supplied creation mode only for a NEW file; an
  // existing broader mode is narrowed explicitly so the sink is always 0600.
  if ((fstatSync(fd).mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
  if ((fstatSync(fd).mode & 0o777) !== 0o600) {
    closeSync(fd)
    throw new Error('local client entry: the surface record file must have mode 0600')
  }
  return {
    emit: record => { writeSync(fd, `${JSON.stringify(record)}\n`) },
    close: () => { closeSync(fd) },
  }
}

/** The private v1 public-launch data channel (M6-2A). Carries ONLY the public
 *  `sessionLaunch`/`presetId` intent from the daemon Coordinator; it never
 *  carries a token, Host URL, Profile secret or exact Session id. */
const CLIENT_LAUNCH_ENVELOPE_ENV = 'SPLIT_PROCESS_CLIENT_LAUNCH_V1'
/** A hard ceiling on the decoded envelope size (plan §A4.1: 16 KiB). */
const MAX_CLIENT_LAUNCH_ENVELOPE_BYTES = 16 * 1024

/** The decoded public launch envelope. */
export interface ClientLaunchEnvelope {
  readonly sessionLaunch?: CliSessionLaunchIntent
  readonly presetId?: string
  /** The read-only launch backend source (value + env/profile provenance). */
  readonly backendSource?: { readonly value: 'direct' | 'daemon'; readonly source: 'env' | 'profile' }
}

/** Decode ONE public launch intent, strictly: exactly the known keys, a browse
 *  with an empty query, or a lookup with a non-empty query, or a continue with
 *  no query. Every other shape fails closed before the Host is ensured. */
function decodeLaunchIntent(value: unknown): CliSessionLaunchIntent {
  if (!isRecord(value)) throw new Error('local client entry: the launch envelope sessionLaunch must be an object')
  const keys = Object.keys(value).sort()
  if (value.kind === 'browse') {
    if (keys.length !== 2 || value.query !== '') {
      throw new Error('local client entry: a browse launch is exactly { kind: "browse", query: "" }')
    }
    return { kind: 'browse', query: '' }
  }
  if (value.kind === 'lookup') {
    if (keys.length !== 2 || typeof value.query !== 'string' || value.query.trim() === '') {
      throw new Error('local client entry: a lookup launch needs exactly a non-empty "query"')
    }
    return { kind: 'lookup', query: value.query.trim() }
  }
  if (value.kind === 'continue') {
    if (keys.length !== 1) throw new Error('local client entry: a continue launch carries no query')
    return { kind: 'continue' }
  }
  throw new Error('local client entry: unknown launch envelope sessionLaunch kind')
}

/** Decode the raw envelope: bounded, valid JSON, exactly the known keys, and a
 *  validated public intent. `version` is frozen at 1. */
export function decodeClientLaunchEnvelope(raw: string): ClientLaunchEnvelope {
  if (Buffer.byteLength(raw, 'utf8') > MAX_CLIENT_LAUNCH_ENVELOPE_BYTES) {
    throw new Error('local client entry: the launch envelope exceeds 16 KiB')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error('local client entry: the launch envelope is not valid JSON', { cause: error })
  }
  if (!isRecord(parsed)) throw new Error('local client entry: the launch envelope must be a JSON object')
  for (const key of Object.keys(parsed)) {
    if (key !== 'version' && key !== 'sessionLaunch' && key !== 'presetId' && key !== 'backendSource') {
      throw new Error(`local client entry: unexpected launch envelope key ${JSON.stringify(key)}`)
    }
  }
  if (parsed.version !== 1) throw new Error('local client entry: the launch envelope version must be 1')
  const envelope: { sessionLaunch?: CliSessionLaunchIntent; presetId?: string; backendSource?: { value: 'direct' | 'daemon'; source: 'env' | 'profile' } } = {}
  if ('sessionLaunch' in parsed) envelope.sessionLaunch = decodeLaunchIntent(parsed.sessionLaunch)
  if ('backendSource' in parsed) {
    const bs = parsed.backendSource
    if (!isRecord(bs) || (bs.value !== 'direct' && bs.value !== 'daemon') || (bs.source !== 'env' && bs.source !== 'profile')) {
      throw new Error('local client entry: the launch envelope backendSource must be { value: "direct"|"daemon", source: "env"|"profile" }')
    }
    envelope.backendSource = { value: bs.value, source: bs.source }
  }
  if ('presetId' in parsed) {
    if (typeof parsed.presetId !== 'string' || parsed.presetId.trim() === '') {
      throw new Error('local client entry: the launch envelope presetId must be a non-empty string')
    }
    envelope.presetId = parsed.presetId
  }
  return envelope
}

/** Read and decode the envelope when it is present; absent otherwise. */
function readClientLaunchEnvelope(): ClientLaunchEnvelope | undefined {
  const raw = process.env[CLIENT_LAUNCH_ENVELOPE_ENV]
  return raw === undefined ? undefined : decodeClientLaunchEnvelope(raw)
}

/** The surface-mode startup intent: an explicit internal input, never a
 *  control-channel override of published behavior. The public envelope and the
 *  internal exact `SPLIT_PROCESS_CLIENT_SESSION` channel are mutually exclusive;
 *  the exact channel is what reexec and qualification use. */
export function surfaceStartupFacts(
  options: LocalClientEntryOptions,
  envelope: ClientLaunchEnvelope | undefined,
): { sessionId?: string; presetId?: string; sessionLaunch?: CliSessionLaunchIntent } {
  const sessionId = process.env.SPLIT_PROCESS_CLIENT_SESSION
  const presetId = process.env.SPLIT_PROCESS_CLIENT_PRESET
  if (options.mode !== 'surface') return {}
  if (sessionId !== undefined && sessionId.trim() === '') {
    throw new Error('local client entry: SPLIT_PROCESS_CLIENT_SESSION must be non-empty when set')
  }
  if (presetId !== undefined && presetId.trim() === '') {
    throw new Error('local client entry: SPLIT_PROCESS_CLIENT_PRESET must be non-empty when set')
  }
  if (envelope !== undefined && sessionId !== undefined) {
    throw new Error('local client entry: the public launch envelope is mutually exclusive with the internal exact Session channel')
  }
  const effectivePreset = envelope?.presetId !== undefined
    ? envelope.presetId
    : presetId === undefined || presetId === ''
      ? undefined
      : presetId
  return {
    ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
    ...(effectivePreset === undefined ? {} : { presetId: effectivePreset }),
    ...(envelope?.sessionLaunch === undefined ? {} : { sessionLaunch: envelope.sessionLaunch }),
  }
}

/** The single internal Loader builtin name of the interaction startup gate. */
export const INTERACTION_STARTUP_GATE = 'pi-tui-interaction-startup-gate'

/** One validated replacement Client package (a real installed/side-by-side root). */
export interface ClientReexecTarget {
  readonly packageRoot: string
  readonly entry: string
  readonly buildId: string
  readonly bundleVersion: string
}

/** The one-shot facts handed to the replacement Client OS process. */
export interface ClientReexecIntent {
  readonly expectedInstanceId: string
  readonly sessionId?: string
  readonly dshAnchor: string
  readonly profile: string
  readonly dshVersion: string
  readonly targetPackageRoot: string
  readonly targetEntry: string
  readonly targetBuildId: string
  readonly targetBundleVersion: string
}

const CLIENT_PACKAGE_NAME = '@xmoon76/dsh-pi-tui'
/** The exact DSH runtime pin a candidate manifest declares (npm `devDependencies`). */
const DSH_PIN_PACKAGE = '@deepseek-ai/dsh-agent'
const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
/**
 * Environment that belongs to the OLD Client's qualification/fault-injection
 * surface only. A replacement Client must not inherit a second SIGUSR2 probe,
 * a stale hold barrier or a one-shot fault injection: those are not handoff
 * state and would corrupt the new process.
 */
const OLD_CLIENT_ENVIRONMENT = [
  'SPLIT_PROCESS_CLIENT_REEXEC_PROBE',
  'SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT',
  'SPLIT_PROCESS_CLIENT_REEXEC_CHILD_FAILURE',
  'SPLIT_PROCESS_CLIENT_HMR_PROBE',
  'SPLIT_PROCESS_CLIENT_HMR_FAIL',
  'SPLIT_PROCESS_CLIENT_HMR_HOLD',
  'SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF',
  'SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE',
  'SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY',
  'SPLIT_PROCESS_CLIENT_HOLD_BEFORE_START',
  'SPLIT_PROCESS_CLIENT_HOLD_STARTUP_GATE',
  'SPLIT_PROCESS_CLIENT_FORCE_FAILURE',
  'SPLIT_PROCESS_CLIENT_FORCE_STARTUP_FATAL',
  'SPLIT_PROCESS_CLIENT_FORCE_REFRESH_UNRESPONSIVE_ONCE',
  'SPLIT_PROCESS_CLIENT_DROP_PROMPT_ACK',
  'SPLIT_PROCESS_CLIENT_DROP_MODEL_ACK',
  'SPLIT_PROCESS_CLIENT_OMIT_COOKIE',
  'SPLIT_PROCESS_CLIENT_WORKSPACE_INTENT_PATH',
] as const

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate one replacement Client package root and derive its production build
 * fingerprint. The same checks apply to the package currently installed in the
 * official profile and to the qualification-only side-by-side root override.
 */
export function inspectClientReexecTarget(packageRoot: string, dshVersion: string): ClientReexecTarget {
  if (!isAbsolute(packageRoot)) throw new Error('local client reexec: the target package root must be absolute')
  let root: string
  try {
    root = realpathSync(packageRoot)
  } catch (error) {
    throw new Error('local client reexec: the target package root is not readable', { cause: error })
  }
  const rootInfo = lstatSync(root)
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (!rootInfo.isDirectory()) throw new Error('local client reexec: the target package root is not a directory')
  if (uid !== undefined && rootInfo.uid !== uid) {
    throw new Error('local client reexec: the target package root is not owned by this process user')
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as unknown
  } catch (error) {
    throw new Error('local client reexec: the target package manifest is not readable JSON', { cause: error })
  }
  if (!isRecord(manifest) || manifest.name !== CLIENT_PACKAGE_NAME) {
    throw new Error(`local client reexec: the target package is not ${CLIENT_PACKAGE_NAME}`)
  }
  if (typeof manifest.version !== 'string' || manifest.version === '') {
    throw new Error('local client reexec: the target package manifest has no version')
  }
  const devDependencies = manifest.devDependencies
  if (!isRecord(devDependencies) || devDependencies[DSH_PIN_PACKAGE] !== dshVersion) {
    throw new Error('local client reexec: the target package is pinned to a different DSH runtime')
  }
  const entry = join(root, 'dist', 'local-client.mjs')
  let entryInfo
  try {
    entryInfo = lstatSync(entry)
  } catch (error) {
    throw new Error('local client reexec: the target package has no Client entry', { cause: error })
  }
  if (entryInfo.isSymbolicLink() || !entryInfo.isFile() || (uid !== undefined && entryInfo.uid !== uid)) {
    throw new Error('local client reexec: the target Client entry must be a regular file owned by this process user')
  }
  return {
    packageRoot: root,
    entry,
    buildId: computeBuildId(root, dshVersion),
    bundleVersion: manifest.version,
  }
}

/** Resolve the replacement package through the ACTIVE official profile. */
export function resolveProfileInstalledClientTarget(profileDir: string, dshVersion: string): ClientReexecTarget {
  let manifestPath: string
  try {
    manifestPath = createRequire(join(profileDir, 'package.json')).resolve(`${CLIENT_PACKAGE_NAME}/package.json`)
  } catch (error) {
    throw new Error(`local client reexec: the active profile does not resolve the installed ${CLIENT_PACKAGE_NAME}`, { cause: error })
  }
  return inspectClientReexecTarget(dirname(manifestPath), dshVersion)
}

/** The exact preflight of one reexec request. Pure: no Client resource is released. */
export interface PrepareClientReexecOptions {
  readonly status: LocalClientStatus
  readonly verifiedHostInstanceId: string
  readonly profileDir: string
  readonly dshAnchor: string
  readonly profile: string
  readonly dshVersion: string
  /** The RUNNING Client build fingerprint (`scope.buildId`), compared with the
   *  resolved replacement target so the same installed build is never swapped
   *  for itself. */
  readonly currentBuildId: string
  /** Qualification-only side-by-side root, already a legal installed package. */
  readonly targetPackageRootOverride?: string
}

/**
 * One typed preflight refusal. The reason is the process-owned vocabulary the
 * command layer maps onto a fixed user notice; the message is the diagnostic
 * detail (never surfaced verbatim by the command).
 */
export class ClientReexecRefusal extends Error {
  readonly reason: ClientReloadProcessRefusal

  constructor(reason: ClientReloadProcessRefusal, message: string) {
    super(message)
    this.name = 'ClientReexecRefusal'
    this.reason = reason
  }
}

export function prepareClientReexec(options: PrepareClientReexecOptions): ClientReexecIntent {
  const { status } = options
  if (status.transport !== 'connected') throw new ClientReexecRefusal('not-ready', 'local client reexec: the Client transport is not connected')
  if (status.surfaceMounted !== true) throw new ClientReexecRefusal('not-ready', 'local client reexec: the Client surface is not mounted')
  const host = status.host
  if (host === undefined) throw new ClientReexecRefusal('not-ready', 'local client reexec: the Client has no authenticated Host identity')
  if (host.instanceId !== options.verifiedHostInstanceId) {
    throw new ClientReexecRefusal('not-ready', 'local client reexec: the live Host is not the authenticated Host instance')
  }
  let sessionId: string | undefined
  if (status.sessionOpen) {
    const open = status.openSessionId
    if (open === undefined || open === '') {
      throw new ClientReexecRefusal('not-ready', 'local client reexec: the open Session has no authoritative id')
    }
    sessionId = open
  }
  const target = options.targetPackageRootOverride === undefined
    ? resolveProfileInstalledClientTarget(options.profileDir, options.dshVersion)
    : inspectClientReexecTarget(options.targetPackageRootOverride, options.dshVersion)
  // The installed package IS this running build: a replacement would change
  // nothing, so this is a truthful refusal instead of a pointless process swap.
  // The comparison uses the SAME production fingerprint the replacement child
  // is verified against — never an npm version guess or an install timestamp.
  if (target.buildId === options.currentBuildId) {
    throw new ClientReexecRefusal('already-current', 'local client reexec: the installed Client already runs this build')
  }
  return {
    expectedInstanceId: host.instanceId,
    ...(sessionId === undefined ? {} : { sessionId }),
    dshAnchor: options.dshAnchor,
    profile: options.profile,
    dshVersion: options.dshVersion,
    targetPackageRoot: target.packageRoot,
    targetEntry: target.entry,
    targetBuildId: target.buildId,
    targetBundleVersion: target.bundleVersion,
  }
}

/**
 * Which entry raised ONE reexec request. The source is part of the request
 * contract because it decides TARGET RESOLUTION: only the internal
 * qualification probe may use the side-by-side package override; the user's
 * manual `/reload-client` always resolves the ACTIVE PROFILE installation,
 * even when both entries live in the same process.
 */
export type ClientReexecRequestSource = 'manual' | 'qualification'

/** The one-shot request latch and its decision order (status -> preflight -> stop). */
export interface ClientReexecRequestOptions {
  /** The CURRENT Client status; `undefined` before the handle is ready. */
  status(): LocalClientStatus | undefined
  /** Prepare the ONE intent for THIS source; only `qualification` may use the
   *  side-by-side target override. */
  prepare(status: LocalClientStatus, source: ClientReexecRequestSource): ClientReexecIntent
  requestStop(code: number): void
  emit(record: Record<string, unknown>): void
  onAccepted?(intent: ClientReexecIntent): void
  /** False once the ONE stop coordinator already owns shutdown. */
  canRequest?(): boolean
}

export interface ClientReexecRequestHandler {
  /**
   * The ONE synchronous request entry. `source` is the calling entry's own
   * identity and is forwarded to the preflight unchanged. It reports the
   * process preflight's decision so a command handler can publish a fixed user
   * notice; the qualification SIGUSR2 probe ignores the result.
   */
  request(source: ClientReexecRequestSource): ClientReloadRequestResult
  readonly intent: ClientReexecIntent | undefined
}

/**
 * The ONLY reexec request path. The first accepted request latches one intent
 * and asks the existing stop coordinator for a normal exit; later requests are
 * observable no-ops. A rejected preflight leaves the Client running and
 * unlatched, so a later explicit request may retry a different target. The ONE
 * latch is shared by both sources; only the target resolution differs.
 */
export function createClientReexecRequestHandler(options: ClientReexecRequestOptions): ClientReexecRequestHandler {
  let intent: ClientReexecIntent | undefined
  return {
    request(source: ClientReexecRequestSource): ClientReloadRequestResult {
      if (intent !== undefined) {
        options.emit({ m4r: 'handoff-request-ignored', processRole: 'client', pid: process.pid, reason: 'already-requested' })
        return { kind: 'refused', reason: 'stopping' }
      }
      if (options.canRequest?.() === false) {
        options.emit({ m4r: 'handoff-request-ignored', processRole: 'client', pid: process.pid, reason: 'stopping' })
        return { kind: 'refused', reason: 'stopping' }
      }
      const status = options.status()
      if (status === undefined) {
        options.emit({ m4r: 'handoff-request-ignored', processRole: 'client', pid: process.pid, reason: 'not-ready' })
        return { kind: 'refused', reason: 'not-ready' }
      }
      let prepared: ClientReexecIntent
      try {
        prepared = options.prepare(status, source)
      } catch (error) {
        options.emit({
          m4r: 'handoff-request-rejected',
          processRole: 'client',
          pid: process.pid,
          error: failureMessage(error),
        })
        return {
          kind: 'refused',
          reason: error instanceof ClientReexecRefusal ? error.reason : 'target-invalid',
        }
      }
      intent = prepared
      options.onAccepted?.(prepared)
      options.emit({
        m4r: 'handoff-requested',
        processRole: 'client',
        pid: process.pid,
        source,
        expectedHostInstanceId: prepared.expectedInstanceId,
        ...(prepared.sessionId === undefined ? {} : { sessionId: prepared.sessionId }),
        targetBuildId: prepared.targetBuildId,
        targetBundleVersion: prepared.targetBundleVersion,
      })
      options.requestStop(0)
      return { kind: 'accepted' }
    },
    get intent(): ClientReexecIntent | undefined {
      return intent
    },
  }
}

/** Build the environment of the ONE replacement Client child. */
export function createClientReexecChildEnvironment(
  intent: ClientReexecIntent,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source }
  const injectedFailure = source.SPLIT_PROCESS_CLIENT_REEXEC_CHILD_FAILURE
  for (const name of OLD_CLIENT_ENVIRONMENT) delete env[name]
  // A handoff never creates a fresh Session through a preset.
  delete env.SPLIT_PROCESS_CLIENT_PRESET
  // The public launch envelope is consumed by the ORIGINAL Client only; a
  // replacement Client resumes the confirmed exact Session instead, so the
  // envelope must never ride the handoff (it would re-run lookup/-c).
  delete env.SPLIT_PROCESS_CLIENT_LAUNCH_V1
  env.SPLIT_PROCESS_CLIENT_MODE = 'surface'
  env.SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID = intent.expectedInstanceId
  env.SPLIT_PROCESS_DSH_ANCHOR = intent.dshAnchor
  env.SPLIT_PROCESS_PROFILE = intent.profile
  if (intent.sessionId === undefined) delete env.SPLIT_PROCESS_CLIENT_SESSION
  else env.SPLIT_PROCESS_CLIENT_SESSION = intent.sessionId
  // Test-only child fault injection: only the replacement child receives the
  // existing injection variable, never the old Client and never a later child.
  if (injectedFailure !== undefined && injectedFailure !== '') env.SPLIT_PROCESS_CLIENT_FORCE_FAILURE = injectedFailure
  return env
}

/** The real-exit result of the ONE replacement Client child. */
export interface ClientReexecChildExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** Spawn the replacement Client on the SAME inherited terminal and await its exit. */
async function spawnClientReexecChild(
  entry: string,
  env: NodeJS.ProcessEnv,
  onSpawned: (child: ReexecChildHandle) => void,
): Promise<ClientReexecChildExit> {
  const child = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env,
    stdio: 'inherit',
    detached: false,
  })
  onSpawned({ kill: signal => child.kill(signal) })
  return await new Promise<ClientReexecChildExit>((resolve, reject) => {
    let settled = false
    child.once('error', error => {
      if (settled) return
      settled = true
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      resolve({ code, signal })
    })
  })
}

function clientReexecExitCode(exit: ClientReexecChildExit): number {
  if (exit.code !== null) return exit.code
  if (exit.signal === null) return 1
  const number = (osConstants.signals as Record<string, number | undefined>)[exit.signal]
  return number === undefined ? 1 : 128 + number
}

/** The one replacement child as seen by the waiting parent. */
export interface ReexecChildHandle {
  kill(signal: NodeJS.Signals): boolean
}

/**
 * Route one termination signal while a handoff is pending or already waiting.
 * With no handoff, return false so the existing stop coordinator keeps owning
 * the normal exit. A running replacement child receives the SAME signal; a
 * handoff accepted but not yet spawned is cancelled instead of silently
 * ignoring the signal. The old Client never starts a second stop.
 */
export function routeReexecTermination(
  handoffAccepted: boolean,
  child: ReexecChildHandle | undefined,
  signal: NodeJS.Signals,
  cancelPending: () => void,
): boolean {
  if (!handoffAccepted) return false
  if (child !== undefined) {
    child.kill(signal)
    return true
  }
  cancelPending()
  return true
}

/** The one Client shutdown tail: the mode-held seat close and the complete stop precede any child spawn. */
export interface ClientEntryShutdownOptions {
  readonly seat: ProcessSeat
  readonly reexec?: {
    readonly intent: ClientReexecIntent
    readonly teardownSucceeded: boolean
    /**
     * Live pre-spawn cancellation latch. It is read AFTER the seat close (a
     * no-op for `surface`), so a termination signal arriving while that close
     * is pending is observed.
     */
    readonly cancelled?: () => boolean
  }
  readonly emit: EntryRecordSink
  readonly stderr: (line: string) => void
  /** Observe the spawned child so a waiting parent can forward signals. */
  readonly onChildSpawned?: (child: ReexecChildHandle) => void
  /** Narrow test seam; production spawns the real replacement process. */
  readonly spawnChild?: (
    entry: string,
    env: NodeJS.ProcessEnv,
    onSpawned: (child: ReexecChildHandle) => void,
  ) => Promise<ClientReexecChildExit>
}

/**
 * Finish the ONE Client process: release the process seat this mode actually
 * holds (qualification) or close the no-op seat, and only after a fully
 * successful teardown re-validate the replacement package and run the child.
 * A failed teardown, seat close, target re-check or spawn never starts C1 and
 * never touches the Host. Returns the replacement exit code when a handoff was
 * requested, otherwise `undefined`.
 */
export async function finishClientEntryShutdown(options: ClientEntryShutdownOptions): Promise<number | undefined> {
  let seatClosed = false
  try {
    await options.seat.close()
    seatClosed = true
  } catch (error) {
    options.emit({
      m4a0: 'cleanup-failure',
      processRole: 'client',
      phase: 'shutdown',
      pid: process.pid,
      step: 'client-seat',
      error: failureMessage(error),
    })
  }
  const reexec = options.reexec
  if (reexec === undefined) return seatClosed ? undefined : 1
  if (reexec.cancelled?.() === true) {
    const reason = new Error('local client entry: the Client handoff was cancelled by a termination signal')
    options.emit({
      m4r: 'handoff-failed',
      processRole: 'client',
      pid: process.pid,
      phase: 'cancelled',
      expectedHostInstanceId: reexec.intent.expectedInstanceId,
      error: reason.message,
    })
    options.stderr(handoffStartupFailureLine(reason))
    return 1
  }
  if (!seatClosed || !reexec.teardownSucceeded) {
    const reason = new Error(seatClosed
      ? 'local client entry: the previous Client teardown did not complete'
      : 'local client entry: the previous Client seat did not close')
    options.emit({
      m4r: 'handoff-failed',
      processRole: 'client',
      pid: process.pid,
      phase: 'teardown',
      expectedHostInstanceId: reexec.intent.expectedInstanceId,
      error: reason.message,
    })
    options.stderr(handoffStartupFailureLine(reason))
    return 1
  }
  let target: ClientReexecTarget
  try {
    target = inspectClientReexecTarget(reexec.intent.targetPackageRoot, reexec.intent.dshVersion)
  } catch (error) {
    options.emit({
      m4r: 'handoff-failed',
      processRole: 'client',
      pid: process.pid,
      phase: 'target',
      expectedHostInstanceId: reexec.intent.expectedInstanceId,
      error: failureMessage(error),
    })
    options.stderr(handoffStartupFailureLine(error))
    return 1
  }
  if (target.buildId !== reexec.intent.targetBuildId || target.entry !== reexec.intent.targetEntry) {
    const changed = new Error('local client reexec: the replacement Client package changed between the preflight and the spawn')
    options.emit({
      m4r: 'handoff-failed',
      processRole: 'client',
      pid: process.pid,
      phase: 'target',
      expectedHostInstanceId: reexec.intent.expectedInstanceId,
      error: changed.message,
    })
    options.stderr(handoffStartupFailureLine(changed))
    return 1
  }
  const spawnChild = options.spawnChild ?? spawnClientReexecChild
  let exit: ClientReexecChildExit
  try {
    exit = await spawnChild(
      target.entry,
      createClientReexecChildEnvironment(reexec.intent),
      child => options.onChildSpawned?.(child),
    )
  } catch (error) {
    options.emit({
      m4r: 'handoff-failed',
      processRole: 'client',
      pid: process.pid,
      phase: 'spawn',
      expectedHostInstanceId: reexec.intent.expectedInstanceId,
      error: failureMessage(error),
    })
    options.stderr(handoffStartupFailureLine(error))
    return 1
  }
  options.emit({
    m4r: 'handoff-parent-exit',
    processRole: 'client',
    pid: process.pid,
    code: exit.code,
    signal: exit.signal,
  })
  return clientReexecExitCode(exit)
}

/**
 * The FINAL gate before a replacement Client publishes `handoff-restored`.
 * It reads the LIVE status after the Session-open proof and refuses a Client
 * whose official transport fatal, expected Host instance, connection or
 * physical surface is no longer current. `status.host` is the composition's
 * authenticated record (a static fact), so the meaningful currentness checks
 * are the transport state/generation (the proof rejects a generation rollover)
 * and this terminal-fatal gate.
 */
export function assertHandoffRestored(
  status: LocalClientStatus,
  expectedInstanceId: string,
  terminalError?: unknown,
): { readonly hostInstanceId: string } {
  if (terminalError !== undefined) {
    throw terminalError instanceof Error ? terminalError : new Error(String(terminalError))
  }
  const hostInstanceId = status.host?.instanceId
  if (hostInstanceId !== expectedInstanceId) {
    throw new LocalScopeError(
      'HOST_IDENTITY_MISMATCH',
      'local client entry: the handoff Client is no longer authenticated to the expected Host instance',
    )
  }
  if (status.transport !== 'connected') {
    throw new Error('local client entry: the handoff Client has no connected official transport')
  }
  if (status.surfaceMounted !== true) {
    throw new Error('local client entry: the handoff Client surface is not mounted')
  }
  return { hostInstanceId }
}

/** Read the one-shot handoff expectation; absent outside a replacement Client. */
export function expectedHostInstanceFromEnvironment(mode: LocalClientEntryMode): string | undefined {
  const raw = process.env.SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID
  if (raw === undefined || raw === '') return undefined
  if (mode !== 'surface') {
    throw new Error('local client entry: SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID requires surface mode')
  }
  if (!INSTANCE_ID_PATTERN.test(raw)) {
    throw new Error('local client entry: SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID must be a Host instance UUID')
  }
  return raw
}

/**
 * The internal reexec probe is one SIGUSR2 consumer; it may never share the
 * process with the HMR, private-RPC or T34 qualification SIGUSR2 handlers, and
 * a replacement Client may not also be a probe Client.
 */
export function assertHandoffSignalExclusivity(mode: LocalClientEntryMode, expectedInstanceId: string | undefined): void {
  const reexecProbe = process.env.SPLIT_PROCESS_CLIENT_REEXEC_PROBE === '1'
  const otherSignalMode = process.env.SPLIT_PROCESS_CLIENT_HMR_PROBE === '1'
    || process.env.SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF === '1'
    || (process.env.SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE ?? '') !== ''
  if (!reexecProbe) {
    if (expectedInstanceId !== undefined && otherSignalMode) {
      throw new Error('local client entry: a handoff Client may not inherit another SIGUSR2 qualification mode')
    }
    return
  }
  if (mode !== 'surface') throw new Error('local client entry: the reexec probe requires surface mode')
  if (otherSignalMode) {
    throw new Error('local client entry: the reexec qualification signal is mutually exclusive with the HMR/private-RPC/T34 SIGUSR2 modes')
  }
  if (expectedInstanceId !== undefined) {
    throw new Error('local client entry: the reexec probe and the handoff expectation are mutually exclusive')
  }
}

/**
 * The ONE interaction startup gate entry: its async Loader plugin holds the
 * official Gateway's `loader.await()` until the official Session resolver and
 * the root interaction listeners exist. Settles once; a stop/failure rejects
 * the pending gate so the Gateway never starts after cancellation.
 */
interface InteractionStartupGate {
  readonly plugin: () => Promise<void>
  readonly pending: boolean
  release(): void
  cancel(reason: unknown): void
}

export function createInteractionStartupGate(): InteractionStartupGate {
  let resolveBarrier: (() => void) | undefined
  let rejectBarrier: ((reason: unknown) => void) | undefined
  let state: 'pending' | 'released' | 'cancelled' = 'pending'
  const barrier = new Promise<void>((resolve, reject) => {
    resolveBarrier = resolve
    rejectBarrier = reject
  })
  return {
    plugin: async () => { await barrier },
    get pending(): boolean { return state === 'pending' },
    release(): void {
      if (state !== 'pending') return
      state = 'released'
      resolveBarrier?.()
    },
    cancel(reason: unknown): void {
      if (state !== 'pending') return
      state = 'cancelled'
      rejectBarrier?.(reason)
    },
  }
}

/** The official Remote service subset the qualification Peer observes. */
interface PeerRemoteService {
  readonly userQuestions?: {
    answer(sessionId: string, callId: string, answer: unknown): Promise<{ readonly ok: boolean; readonly value?: boolean; readonly error?: { readonly code?: string } }>
  }
  /** The package's private official-Web-frontend toggle (`piTuiWebAccess`). */
  readonly piTuiWebAccess?: {
    getStatus(): Promise<PeerRemoteResult>
    setEnabled(enabled: boolean): Promise<PeerRemoteResult>
    getAuthenticatedUrl(): Promise<PeerRemoteResult>
  }
  /**
   * The official generated settings namespace. The qualification Peer uses it
   * to read/write the profile-owned Web startup preference through the SAME
   * revision-checked wire the Remote ConfigPort uses — never a local file edit.
   */
  readonly settings?: {
    describe(): Promise<PeerRemoteResult>
    mutate(
      ns: string,
      ops: readonly { readonly op: 'set'; readonly path: readonly string[]; readonly value: unknown }[],
      expectedRevision?: number,
    ): Promise<PeerRemoteResult>
  }
  /**
   * The official generated Workspace namespace. The qualification Peer adopts
   * ONE existing absolute directory as a Workspace through the SAME wire the
   * Web/UI domains use; it creates no Host route and writes no profile file.
   */
  readonly workspace?: {
    create(input: { readonly path: string }): Promise<PeerRemoteResult>
  }
}

/** One RemoteResult as the Client face resolves it (structural, non-secret). */
interface PeerRemoteResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly error?: { readonly code?: string; readonly message?: string }
}

/** Production fail-closed preflight for the interaction startup gate.
 *
 * The Gateway's event pump must not start merely because the Session plugin
 * mounted: the official `typert.contexts` Agent resolver is the exact target
 * every forwarded request needs. A missing resolver is a startup failure, not
 * a later `next()` fallback that would irreversibly settle a Host request.
 */
export function assertInteractionStartupReady(
  gate: { readonly pending: boolean },
  agentResolver: unknown,
): void {
  if (!gate.pending) throw new Error('local client entry: the interaction startup gate failed before the transport install')
  if (agentResolver === undefined) throw new Error('local client entry: the official Session Agent resolver did not install')
}

/** One pending forwarded interaction held by the non-TUI answering Peer. */
interface PeerInteractionSeat {
  answer(kind: 'question' | 'approval', callId: string, value: unknown): boolean
  dispose(): void
}

const PEER_ABORTED = Symbol('peer-request-aborted')

/**
 * The qualification-only non-TUI answering Peer: it registers the two official
 * `$on` listeners and holds each forwarded request until the smoke sends the
 * exact `peer-answer` control record. It never renders, never takes the TUI
 * seat and never invents a Host decision.
 */
function createPeerInteractionSeat(
  remote: import('./client-interaction-delivery.ts').SplitClientInteractionEventsSource,
  sessions: { scopeOf(owner: unknown): string | undefined },
  emit: EntryRecordSink,
): PeerInteractionSeat {
  const pending = new Map<string, (value: unknown) => void>()
  const owned: Array<() => void> = []
  let sequence = 0
  const KEY = (kind: 'question' | 'approval', key: string): string => `${kind}:${key}`
  const waitForAnswer = async (
    kind: 'question' | 'approval',
    callId: string,
    signal: AbortSignal | undefined,
  ): Promise<unknown> => {
    return await new Promise<unknown>(resolve => {
      let settled = false
      const settle = (value: unknown): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        pending.delete(KEY(kind, callId))
        resolve(value)
      }
      const onAbort = (): void => { settle(PEER_ABORTED) }
      pending.set(KEY(kind, callId), settle)
      if (signal?.aborted === true) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  owned.push(remote.$on('user-questions/request', async function (this: unknown, request, next) {
    const sessionId = sessions.scopeOf(this)
    if (sessionId === undefined) return next()
    const callId = request.wait?.callId
    const peerKey = typeof callId === 'string' ? callId : `question-${++sequence}`
    emit({
      m4a0: 'peer-interaction',
      kind: 'question',
      peerKey,
      callId: typeof callId === 'string' ? callId : undefined,
      sessionId,
    })
    const value = await waitForAnswer('question', peerKey, request.signal)
    if (value === PEER_ABORTED) throw new Error('local client entry: peer question request aborted')
    return value as never
  }))
  owned.push(remote.$on('approval/request', async function (this: unknown, request, next) {
    const sessionId = sessions.scopeOf(this)
    if (sessionId === undefined) return (next as () => unknown)()
    const callId = request.callId
    const peerKey = typeof callId === 'string' ? callId : `approval-${++sequence}`
    emit({
      m4a0: 'peer-interaction',
      kind: 'approval',
      peerKey,
      callId: typeof callId === 'string' ? callId : undefined,
      sessionId,
    })
    const value = await waitForAnswer('approval', peerKey, request.signal)
    if (value === PEER_ABORTED) throw new Error('local client entry: peer approval request aborted')
    return value
  }))
  return {
    answer(kind, callId, value): boolean {
      const settle = pending.get(KEY(kind, callId))
      if (settle === undefined) return false
      settle(value)
      return true
    },
    dispose(): void {
      for (const off of owned.splice(0)) off()
      for (const settle of [...pending.values()]) settle(PEER_ABORTED)
    },
  }
}

/** Qualification-only read-only observer of the official transport frames.
 *  It records the Gateway `$events` clientId/eventId without changing any
 *  Gateway method or frame. */
function observeQualificationSocket(
  socket: import('./local-transport.ts').ConnectionWebSocketLike,
  emit: EntryRecordSink,
): void {
  let clientId: string | undefined
  socket.addEventListener('message', event => {
    const data: unknown = event.data
    const text = typeof data === 'string'
      ? data
      : Buffer.isBuffer(data)
        ? data.toString('utf8')
        : data instanceof ArrayBuffer
          ? Buffer.from(data).toString('utf8')
          : ArrayBuffer.isView(data)
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
            : ''
    if (text === '') return
    const client = /"clientId":"([^"]+)"/u.exec(text)
    if (client !== null) clientId = client[1]
    const eventId = /"eventId":"([^"]+)"/u.exec(text)
    if (eventId === null) return
    const eventName = /"event":"([^"]+)"/u.exec(text)
    emit({
      m4a0: 'peer-frame',
      event: eventName?.[1] ?? 'unknown',
      eventId: eventId[1],
      ...(clientId === undefined ? {} : { clientId }),
    })
  })
}

/**
 * Run one Client-only process until its launcher requests shutdown. Exported
 * for the qualification harness; `import.meta.main` is the only production
 * caller.
 */
export async function runLocalClientEntry(options: LocalClientEntryOptions): Promise<void> {
  // Handoff mode is validated before ANY process seat or Context exists: a
  // contradictory environment is refused without touching a seat.
  const expectedHostInstanceId = expectedHostInstanceFromEnvironment(options.mode)
  assertHandoffSignalExclusivity(options.mode, expectedHostInstanceId)
  // Decode the public launch envelope BEFORE any Host/seat/Context work: a
  // malformed, oversized or contradictory envelope fails closed with no Host
  // interaction. Surface mode only; the qualification/peer channels never read it.
  const launchEnvelope = options.mode === 'surface' ? readClientLaunchEnvelope() : undefined
  // Mutually-exclusive channels are checked HERE, before ensureHost / seat /
  // Context: a contradictory public envelope + internal exact Session input must
  // have ZERO Host side effects. The later surfaceStartupFacts check stays as a
  // second fence but this is the zero-side-effect gate.
  if (launchEnvelope !== undefined && process.env.SPLIT_PROCESS_CLIENT_SESSION !== undefined) {
    throw new Error('local client entry: the public launch envelope is mutually exclusive with the internal exact Session channel')
  }
  if (launchEnvelope?.backendSource !== undefined) {
    // A read-only launch fact for the Settings row. It is NOT DSH_PI_TUI_BACKEND
    // (so it can never recurse into backend selection) and is never persisted.
    process.env.SPLIT_PROCESS_CLIENT_LAUNCH_BACKEND = JSON.stringify(launchEnvelope.backendSource)
  }
  const hostModules = await loadOfficialClientHost(options.dshAnchor)
  const dshHome = hostModules.resolveDshHome()
  const packageRoot = installedPackageRootFromEntry(import.meta.url)
  const profileDir = hostModules.resolveProfileDir(options.profile, dshHome)
  const scope = scopeFromInstalledProfile({
    dshHome,
    profileDir,
    packageRoot,
    dshVersion: readInstalledDshVersion(options.dshAnchor),
  })
  const processStartIdentity = readLinuxStarttime()
  // Surface mode separates the terminal (owned by PiTui) from the structured
  // telemetry channel (a private 0600 JSONL file). Qualification keeps the
  // frozen JSONL control channel on stdin/stdout.
  const recordSink = options.mode === 'surface' ? createSurfaceRecordSink() : undefined
  // Surface mode never writes JSON to the terminal. With no explicitly injected
  // record file the sink is a silent, non-tty observation sink (never a
  // writeEntryRecord fallback that would corrupt the TUI).
  const emit: EntryRecordSink = recordSink?.emit ?? (options.mode === 'surface' ? () => {} : writeEntryRecord)
  // Publish the business PID before any seat/assembly work: a signal-stop test
  // must be able to address THIS process while it is still assembling and no
  // ready record exists yet. No secret/path is carried.
  emit({ m4a0: 'client-started', processRole: 'client', pid: process.pid, phase: 'startup' })
  // Admission: the Host Singleton keeps its own kernel seat in every mode. The
  // Client kernel seat is qualification-only — the frozen qualification harness
  // must still fail CLIENT_ALREADY_ACTIVE on a second process, while every real
  // `surface` (and the answering `peer`) is an independent Client that reaches
  // the same authenticated Host without a profile-global seat.
  const seat: ProcessSeat = options.mode === 'qualification'
    ? await bindProcessSeat(scope.clientSeatSocketName, 'CLIENT_ALREADY_ACTIVE')
    : { close: async () => {} }
  let context: import('@deepseek-ai/cordis').Context | undefined
  let loaderFiber: Fiber | undefined
  let startupGate: InteractionStartupGate | undefined
  let installedTransport: InstalledLocalClientTransport | undefined
  let transport: LocalClientTransport | undefined
  let domainPrerequisites: MountedRemoteClientDomainPrerequisites | undefined
  let mountedDomains: MountedRemoteClientDomains | undefined
  let interactionDelivery: SplitClientInteractionDeliveryOwner | undefined
  let peerSeat: PeerInteractionSeat | undefined
  let handle: LocalClientHandle | undefined
  /** The ONE accepted one-shot handoff intent (never a second Client owner). */
  let reexecIntent: ClientReexecIntent | undefined
  /** The reexec request latch of the qualification-only SIGUSR2 probe. */
  let reexecHandler: ClientReexecRequestHandler | undefined
  /** Set only when the ORIGINAL stop chain released every Client resource. */
  let reexecTeardownSucceeded = false
  /** The ONE replacement child while the old PID waits as its parent. */
  let reexecChild: ReexecChildHandle | undefined
  /** A termination signal arrived after the handoff was accepted, before spawn. */
  let reexecCancelled = false
  /** The CURRENT revision's surface bridge behind the ONE root `appExit`. */
  let activeBridge: import('./local-client-surface.ts').LocalClientSurfaceBridge | undefined
  /** The ONE serial revision task slot shared by HMR and stop. */
  let revisionTask: Promise<void> = Promise.resolve()
  const enqueueRevisionTask = (task: () => Promise<void>): Promise<void> => {
    const run = revisionTask.then(task, task)
    revisionTask = run.then(() => {}, () => {})
    return run
  }
  const diag = createEntryDiag('client', recordSink?.emit ?? (options.mode === 'surface' ? () => {} : undefined))
  const CLIENT_DISPOSE_DEADLINE_MS = 10_000
  const disposeWithinDeadline = async (dispose: () => Promise<void>, errors: unknown[]): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), CLIENT_DISPOSE_DEADLINE_MS)
    })
    const done = dispose().then(() => false, error => { errors.push(error); return false })
    const timedOut = await Promise.race([done, deadline])
    if (timer !== undefined) clearTimeout(timer)
    if (timedOut) errors.push(new Error('local client entry: client disposal deadline exceeded'))
    return timedOut
  }
  const forceExitAfterCleanupFailure = (): void => {
    process.stdin.pause()
    // One immediate turn lets the small structured records reach the pipe; the
    // official fiber that failed to settle must not keep the process parked.
    setImmediate(() => { process.exit(1) })
  }
  let stopping: Promise<void> | undefined
  /** Resolves when the ONE startup chain has been entered/finished. A stop
   *  that lands before `startupPromise` exists waits here instead of disposing
   *  the root underneath a late `startLocalClient` call. */
  let startupReadyResolve: (() => void) | undefined
  const startupReady = new Promise<void>(resolve => { startupReadyResolve = resolve })
  /** The ONE startup cancellation owner: a stop aborts every in-flight mount
   *  and readiness wait before any teardown starts. */
  const startupAbort = new AbortController()
  /** The in-flight ONE startup chain; `stop` awaits it before disposing. */
  let startupPromise: Promise<LocalClientHandle> | undefined
  /** Whether the transport/root release already happened (single-root latch). */
  let rootReleased = false
  let resolveStopped: (() => void) | undefined
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve })
  let terminalError: unknown
  let compositionDone = false

  const stop = (code: number, failure?: unknown): Promise<void> => {
    if (stopping !== undefined) return stopping
    // A signal/exit request while the assembly is still running aborts the
    // Domain readiness, assembly holds and runner readiness FIRST; the startup
    // chain then unwinds exactly the graph it created, and this coordinator
    // performs the ONE transport/root release after it settles.
    startupAbort.abort(failure ?? new Error('local client entry: stop requested during startup'))
    stopping = (async () => {
      if (failure !== undefined) {
        const primary = failure instanceof Error ? failure : new Error(String(failure))
        emit({
          m4a0: 'failure',
          processRole: 'client',
          phase: context === undefined ? 'startup' : 'after-context',
          pid: process.pid,
          ...(failure instanceof LocalScopeError ? { code: failure.code } : {}),
          error: primary.message,
          ...(primary.stack === undefined ? {} : { stack: primary.stack }),
        })
      }
      const errors: unknown[] = []
      const timedOut = await disposeWithinDeadline(async () => {
        if (rootReleased) return
        // A stop can land during the dynamic client-bootstrap import or before
        // `startupPromise` is assigned. Wait for the startup gate so the root
        // is never disposed underneath a late `startLocalClient` call.
        // A stop before the Client Context exists has no startup graph to
        // wait for. Once the Context exists, the in-flight staged startup owns
        // the partial graph; wait for its single startup gate so the root is
        // never disposed underneath a late `startLocalClient` call.
        if (startupPromise === undefined && context !== undefined && !compositionDone) await startupReady
        // Wait for the in-flight assembly to settle: a success publishes the
        // ONE handle, a failure has already unwound the graph it created.
        if (startupPromise !== undefined && handle === undefined) {
          try {
            handle = await startupPromise
          } catch {
            // The startup's failure unwind owns the graph. The borrowed
            // transport/root still belong to this coordinator.
          }
        }
        if (handle !== undefined) {
          // A same-process surface revision in flight owns the Context until it
          // settles. Stop aborted its signal first; now wait for the ONE serial
          // revision slot before releasing the root.
          await revisionTask
          try { await handle.dispose() } catch (error) { errors.push(error) }
          rootReleased = true
          return
        }
        try { interactionDelivery?.dispose() } catch (error) { errors.push(error) }
        try { peerSeat?.dispose() } catch (error) { errors.push(error) }
        // Stop the official Gateway/Connection before the Session Client goes
        // away; its generation signal is what releases every pending delivery.
        try { await transport?.dispose() } catch (error) { errors.push(error) }
        try { await domainPrerequisites?.dispose() } catch (error) { errors.push(error) }
        try { await mountedDomains?.dispose() } catch (error) { errors.push(error) }
        // Only after the official Gateway/Connection is disposed may the gate
        // settle: the upstream Loader await cannot call a live connection.start
        // after cancellation.
        startupGate?.cancel(failure ?? new Error('local client entry: stop requested during startup'))
        try { await loaderFiber?.dispose() } catch (error) { errors.push(error) }
        try { await context?.fiber.dispose() } catch (error) { errors.push(error) }
        rootReleased = true
      }, errors)
      if (options.mode === 'surface' && handle !== undefined) {
        // The final owner inventory the qualification reads after the process
        // left: every Client-owned service row and `tuiMainView` reference is
        // released (0), while the Host is untouched. Emitted BEFORE the record
        // sink closes and before the process exits.
        emit({ m4b2s: 'client-closed', ...traceStatus(handle.status) })
      }
      const transportCleanupFailed = errors.some(error => error instanceof Error && (error as { cleanupFailed?: boolean }).cleanupFailed === true)
      if (errors.length > 0 || timedOut) {
        const primary = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0] ?? 'client disposal failed'))
        emit({
          m4a0: 'cleanup-failure',
          processRole: 'client',
          phase: 'shutdown',
          pid: process.pid,
          error: primary.message,
        })
        process.exitCode = 1
      } else if (failure !== undefined) {
        emit({ m4a0: 'cleanup', processRole: 'client', phase: 'after-context', pid: process.pid, status: 'completed' })
        process.exitCode = 1
      } else {
        process.exitCode = code
        // The handoff tail may start only after THIS coordinator released the
        // root, official transport, the seat this mode actually held and every
        // owned object.
        if (code === 0 && reexecIntent !== undefined) reexecTeardownSucceeded = true
      }
      // Pause the qualification control channel so its resumed stdin pipe no
      // longer keeps the process alive after disposal. The dispatcher's own
      // stop hook does the same for a control-channel shutdown.
      // Surface mode owns the tty: an async terminal/channel failure that
      // drives this stop path also gets ONE sanitized human line (a clean
      // /exit or signal carries no failure and prints nothing).
      if (options.mode === 'surface' && failure !== undefined) {
        process.stderr.write(`${surfaceStartupFailureLine(failure)}\n`)
      }
      process.stdin.pause()
      resolveStopped?.()
      if (timedOut || transportCleanupFailed) forceExitAfterCleanupFailure()
    })()
    return stopping
  }

  // Install the process-lifetime shutdown handlers BEFORE the first staged
  // startup resource exists. The Loader gate, transport fibers and Domain
  // prerequisites are all created below; a SIGTERM/SIGINT during any of those
  // stages must enter the ONE stop coordinator instead of the default action.
  process.on('SIGTERM', () => {
    emit({ m4a0: 'signal', processRole: 'client', pid: process.pid, signal: 'SIGTERM' })
    if (routeReexecTermination(reexecIntent !== undefined, reexecChild, 'SIGTERM', () => { reexecCancelled = true })) return
    runDetached('local client: SIGTERM shutdown', () => stop(0), { diag })
  })
  process.on('SIGINT', () => {
    emit({ m4a0: 'signal', processRole: 'client', pid: process.pid, signal: 'SIGINT' })
    if (routeReexecTermination(reexecIntent !== undefined, reexecChild, 'SIGINT', () => { reexecCancelled = true })) return
    runDetached('local client: SIGINT shutdown', () => stop(130), { diag })
  })

  /**
   * The structured status of the transport for a record. Surface mode strips
   * the private Host home path; the qualification channel keeps its frozen
   * shape. Cookie/token values never enter a record on either path.
   */
  const traceTransportStatus = (): Record<string, unknown> => {
    if (transport === undefined) return {}
    const observed = transport.status()
    if (options.mode !== 'surface') return observed as unknown as Record<string, unknown>
    const { hostHome: _hostHome, ...safe } = observed
    return safe
  }
  /**
   * The same projection for the handle status (surface mode strips the Host
   * home path; the qualification status shape is unchanged).
   */
  const traceStatus = (status: LocalClientHandle['status']): Record<string, unknown> => {
    if (options.mode !== 'surface') return status as unknown as Record<string, unknown>
    const { hostHome: _hostHome, ...safe } = status
    return safe
  }

  try {
    const host = await ensureLocalHost({
      scope,
      hostEntryPath: join(packageRoot, 'dist', 'local-host.mjs'),
      dshAnchor: options.dshAnchor,
      profile: options.profile,
      ...(expectedHostInstanceId === undefined ? {} : { expectedInstanceId: expectedHostInstanceId }),
    })
    startupAbort.signal.throwIfAborted()
    emit({
      m4a0: 'host-authenticated',
      processRole: 'client',
      pid: process.pid,
      phase: 'host-authenticated',
      host: hostRecordForTrace(host),
    })

    const loadedProfile = hostModules.loadProfile('split-process-client', options.profile, options.dshAnchor)
    const resolution = await hostModules.createRuntimeResolution({
      installAnchor: options.dshAnchor,
      profile: loadedProfile,
    })
    context = new hostModules.Context()
    const packageFiber = context.plugin(hostModules.PluginPackages as never, { resolution } as never)
    await packageFiber
    emit({ m4a0: 'context-ready', processRole: 'client', pid: process.pid, phase: 'context-ready' })

    // The official resolution interception is live before these dynamic
    // imports; the chunks' bare @deepseek-ai imports therefore resolve exactly
    // like a Loader-mounted plugin's would.
    const transportModule = await import('./local-transport.ts')
    const { mountSurfaceClientDomainPrerequisites, startLocalClient } = await import('./client-bootstrap.ts')
    const onTransportFatal = (error: unknown): void => {
      terminalError ??= error
      // Before the composition is ready, the sequential startup path owns the
      // single stop; a concurrent stop while the UI subtree is mounting could
      // tear down the context twice and race the readiness publication.
      if (compositionDone) {
        runDetached('local client: terminal transport identity failure', () => stop(1, terminalError), { diag })
      }
    }
    if (options.mode === 'surface' || options.mode === 'peer') {
      const clientContext = context
      if (clientContext === undefined) throw new Error('local client entry: the Client root Context is missing')
      // 1. The REAL Cordis Loader is installed first and owns the official
      // Gateway's startup gate. Its one internal builtin entry stays pending
      // until the Session resolver and the root interaction listeners exist;
      // the upstream `ClientRemoteService` sees that pending entry in
      // `loader.await()` and therefore does not start `connection.start()`.
      loaderFiber = clientContext.plugin(hostModules.Loader as never, {} as never)
      await loaderFiber
      const loader = clientContext.get('loader') as import('@deepseek-ai/cordis-plugin-loader').Loader | undefined
      if (loader === undefined) throw new Error('local client entry: the official Cordis Loader did not install')
      startupGate = createInteractionStartupGate()
      loader.builtins[INTERACTION_STARTUP_GATE] = startupGate.plugin as never
      await loader.create({ name: `cordis:${INTERACTION_STARTUP_GATE}` })
      startupAbort.signal.throwIfAborted()
      if (!startupGate.pending) throw new Error('local client entry: the interaction startup gate failed before the transport install')
      const gateHold = process.env.SPLIT_PROCESS_CLIENT_HOLD_STARTUP_GATE
      if (gateHold !== undefined && gateHold !== '') {
        emit({ m4b2s: 'qualification', op: 'startup-gate-hold', stage: 'loader-gate', barrier: gateHold })
        await waitForStartupHold(gateHold, startupAbort.signal)
      }
      // 2. Install typert/connection/gateway. Gateway applies its service but
      // its event pump waits for the Loader gate above.
      installedTransport = await transportModule.installLocalTransport(clientContext, {
        dshAnchor: options.dshAnchor,
        host,
        scope,
        diag,
        signal: startupAbort.signal,
        onFatal: onTransportFatal,
        ...(options.mode === 'peer'
          ? { qualificationWebSocketObserver: (_url, socket) => observeQualificationSocket(socket, emit) }
          : {}),
      })
      transport = installedTransport
      startupAbort.signal.throwIfAborted()
      // 3. Mount the official Session Client (Agent resolver) and the other
      // Domain prerequisites while the event pump is still gated.
      domainPrerequisites = await mountSurfaceClientDomainPrerequisites(clientContext, { dshAnchor: options.dshAnchor })
      const remote = clientContext.get('remote') as unknown as import('./client-interaction-delivery.ts').SplitClientInteractionEventsSource | undefined
      if (remote === undefined) throw new Error('local client entry: the official Client Remote service did not install')
      const remoteService = clientContext.get('remote') as unknown as PeerRemoteService | undefined
      // 4. Register the TWO official listeners EXACTLY ONCE for this Client
      // root, then release the gate. Only now may the Gateway start. The
      // surface mode borrows the root delivery owner; the qualification-only
      // answering Peer registers its own held-answer listeners.
      if (options.mode === 'surface') {
        interactionDelivery = createSplitClientInteractionDelivery({ remote, sessions: domainPrerequisites.sessions })
      } else {
        peerSeat = createPeerInteractionSeat(remote, domainPrerequisites.sessions, emit)
      }
      const typert = clientContext.get('typert') as unknown as {
        contexts: { getClient(name: string): unknown }
      } | undefined
      const agentResolver = typert?.contexts.getClient('agent')
      assertInteractionStartupReady(startupGate, agentResolver)
      emit({
        m4b2s: 'qualification',
        op: 'interaction-startup-gate',
        phase: 'listeners-ready',
        agentResolver: agentResolver !== undefined,
        questionListeners: 1,
        approvalListeners: 1,
        loaderTasks: loader.getTasks().length,
      })
      startupGate.release()
      // 5. First real generation + authenticated identity audit. `transport`
      // is the same installed handle once ready.
      transport = await transportModule.awaitLocalTransportReady(installedTransport, { signal: startupAbort.signal })
      if (terminalError !== undefined) {
        await stop(1, terminalError)
        return
      }
      emit({
        m4a0: 'transport-ready',
        processRole: 'client',
        pid: process.pid,
        phase: 'transport-ready',
        ...traceTransportStatus(),
      })
      // 6. Complete the root Domain graph: Jobs Client + official initial
      // readiness. Every surface revision below borrows this ONE graph.
      mountedDomains = await domainPrerequisites.complete({ signal: startupAbort.signal })
      domainPrerequisites = undefined
      startupAbort.signal.throwIfAborted()
      emit({ m4b2s: 'qualification', op: 'startup-stage', stage: 'domains-ready', pid: process.pid })
      if (options.mode === 'peer') {
        emit({
          m4a0: 'ready',
          processRole: 'client',
          pid: process.pid,
          phase: 'peer-ready',
          mode: 'peer',
          hostPid: host.identity.hostPid,
          hostInstanceId: host.identity.instanceId,
          ...traceTransportStatus(),
        })
        compositionDone = true
        attachEntryControl(async request => {
          if (request.op === 'status') {
            emit({ m4a0: 'status', pid: process.pid, ...traceTransportStatus() })
            return false
          }
          if (request.op === 'peer-answer') {
            const kind = request.kind
            const callId = request.callId
            const value = request.value
            if ((kind !== 'question' && kind !== 'approval') || typeof callId !== 'string') {
              emit({ m4a0: 'control-error', error: 'peer-answer requires kind/callId/value' })
              return false
            }
            const delivered = peerSeat?.answer(kind, callId, value) === true
            emit({ m4a0: 'peer-answer-sent', kind, callId, delivered })
            return false
          }
          if (request.op === 'peer-send-stale-result') {
            const eventId = request.eventId
            const clientId = request.clientId
            const outcome = request.value
            if (typeof eventId !== 'string' || typeof clientId !== 'string' || outcome === undefined) {
              emit({ m4a0: 'control-error', error: 'peer-send-stale-result requires eventId/clientId/value' })
              return false
            }
            const connection = clientContext.get('connection') as unknown as {
              rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly error?: { readonly code?: string; readonly message?: string } }> }
            } | undefined
            if (connection === undefined) throw new Error('local client entry: the qualification Peer has no Connection RPC')
            const response = await connection.rpc.call('/api', '$events/result', {
              args: { clientId, eventId, outcome },
            })
            emit({
              m4a0: 'peer-stale-result-sent',
              eventId,
              clientId,
              ok: response.ok === true,
              ...(response.error?.code === undefined ? {} : { errorCode: response.error.code }),
            })
            return false
          }
          if (request.op === 'peer-question-answer') {
            const sessionId = request.sessionId
            const callId = request.callId
            const value = request.value
            if (typeof sessionId !== 'string' || typeof callId !== 'string' || value === undefined) {
              emit({ m4a0: 'control-error', error: 'peer-question-answer requires sessionId/callId/value' })
              return false
            }
            if (remoteService?.userQuestions === undefined) throw new Error('local client entry: the qualification Peer has no userQuestions namespace')
            const result = await remoteService.userQuestions.answer(sessionId, callId, value)
            emit({
              m4a0: 'peer-question-answer',
              sessionId,
              callId,
              ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
              ok: result.ok === true,
              ...(result.ok ? { value: result.value === true } : { errorCode: result.error?.code, error: result.error }),
            })
            return false
          }
          if (request.op === 'qualification-web-access') {
            // Qualification-only: the SAME authenticated non-TUI Peer drives
            // the Host's private official-Web-frontend toggle through the real
            // v2 Gateway. It is a control op of this internal entry: it never
            // appears on a published CLI, a Surface stream or an HTTP bypass,
            // and the response carries only the status vocabulary.
            const enabled = request.webAccessEnabled
            const webAccess = remoteService?.piTuiWebAccess
            if (webAccess === undefined) {
              throw new Error('local client entry: the qualification Peer has no piTuiWebAccess namespace')
            }
            // A supplied value is NOT validated here: the v2 Remote contract's
            // argument codec is the one authority, so a malformed value is
            // refused by the Gateway exactly like any other Remote caller.
            const result = enabled === undefined
              ? await webAccess.getStatus()
              : await webAccess.setEnabled(enabled as boolean)
            emit({
              m4a0: 'qualification',
              op: 'web-access',
              processRole: 'client',
              pid: process.pid,
              action: enabled === undefined ? 'getStatus' : 'setEnabled',
              ...(enabled === undefined ? {} : { enabled }),
              ok: result.ok === true,
              ...(result.ok
                ? { status: result.value }
                : {
                    errorCode: result.error?.code,
                    ...(result.error?.message === undefined ? {} : { error: result.error.message.slice(0, 300) }),
                  }),
              ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
            })
            return false
          }
          if (request.op === 'qualification-workspace-create') {
            // Qualification-only: adopt ONE existing absolute directory as a
            // Workspace through the official generated `workspace` Remote. The
            // real Browser then starts the Session in that Workspace through its
            // own UI; no Host route, profile file or second authority is added.
            const workspace = remoteService?.workspace
            if (workspace === undefined) {
              throw new Error('local client entry: the qualification Peer has no workspace namespace')
            }
            const path = request.workspacePath
            if (typeof path !== 'string' || path === '') {
              throw new Error('local client entry: qualification-workspace-create requires an absolute workspacePath')
            }
            const result = await workspace.create({ path })
            const value = result.ok
              ? result.value as { readonly created?: unknown; readonly workspace?: { readonly workspaceId?: unknown } } | undefined
              : undefined
            emit({
              m4a0: 'qualification',
              op: 'workspace-create',
              processRole: 'client',
              pid: process.pid,
              ok: result.ok === true,
              ...(value === undefined
                ? { errorCode: result.error?.code }
                : {
                    created: value.created === true,
                    ...(typeof value.workspace?.workspaceId === 'string' ? { workspaceId: value.workspace.workspaceId } : {}),
                  }),
              ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
            })
            return false
          }
          if (request.op === 'qualification-web-autostart') {
            // Qualification-only: read/write the profile-owned Web startup
            // preference through the SAME official generated `settings` wire the
            // Remote ConfigPort consumes. It never edits a profile file and never
            // touches the current Host's Web rows.
            const settings = remoteService?.settings
            if (settings === undefined) throw new Error('local client entry: the qualification Peer has no settings namespace')
            const preferenceOf = (value: unknown): { autoStart: boolean; revision: number; userOverridden: boolean } | undefined => {
              const namespaces = (value as { readonly namespaces?: readonly {
                readonly ns?: unknown
                readonly value?: unknown
                readonly user?: unknown
                readonly revision?: unknown
              }[] } | undefined)?.namespaces
              const entry = namespaces?.find(candidate => candidate.ns === 'pi-tui-web-preferences')
              if (entry === undefined) return undefined
              const projected = entry.value as { readonly autoStart?: unknown } | undefined
              if (typeof projected?.autoStart !== 'boolean' || typeof entry.revision !== 'number') return undefined
              const user = entry.user as { readonly autoStart?: unknown } | undefined
              return {
                autoStart: projected.autoStart,
                revision: entry.revision,
                userOverridden: user?.autoStart !== undefined,
              }
            }
            const before = await settings.describe()
            const current = before.ok ? preferenceOf(before.value) : undefined
            if (current === undefined) {
              emit({
                m4a0: 'qualification',
                op: 'web-autostart',
                processRole: 'client',
                pid: process.pid,
                ok: false,
                errorCode: 'preference/unavailable',
                ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
              })
              return false
            }
            const requested = request.webAutoStart
            if (requested === undefined) {
              emit({
                m4a0: 'qualification',
                op: 'web-autostart',
                processRole: 'client',
                pid: process.pid,
                action: 'read',
                ...current,
                ok: true,
                ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
              })
              return false
            }
            if (typeof requested !== 'boolean') throw new Error('local client entry: qualification-web-autostart requires a boolean webAutoStart')
            const write = await settings.mutate(
              'pi-tui-web-preferences',
              [{ op: 'set', path: ['autoStart'], value: requested }],
              current.revision,
            )
            const after = await settings.describe()
            const settled = after.ok ? preferenceOf(after.value) : undefined
            emit({
              m4a0: 'qualification',
              op: 'web-autostart',
              processRole: 'client',
              pid: process.pid,
              action: 'write',
              requested,
              ok: write.ok && settled !== undefined,
              ...(settled === undefined ? {} : settled),
              readBack: settled?.autoStart === requested,
              ...(write.ok
                ? {}
                : {
                    errorCode: write.error?.code,
                    ...(write.error?.message === undefined ? {} : { error: write.error.message.slice(0, 300) }),
                  }),
              ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
            })
            return false
          }
          if (request.op === 'qualification-web-access-url') {
            // Qualification-only: obtain the official authenticated launch URL and
            // prove it can really be exchanged for a page. The URL and its launch
            // token are NEVER emitted: only the protocol, the parameter SHAPE,
            // the exchange status and the follow-up page status are recorded.
            const webAccess = remoteService?.piTuiWebAccess
            if (webAccess === undefined) throw new Error('local client entry: the qualification Peer has no piTuiWebAccess namespace')
            const result = await webAccess.getAuthenticatedUrl()
            if (!result.ok) {
              emit({
                m4a0: 'qualification',
                op: 'web-access-url',
                processRole: 'client',
                pid: process.pid,
                ok: false,
                ...(result.error?.code === undefined ? {} : { errorCode: result.error.code }),
                ...(result.error?.message === undefined ? {} : { error: result.error.message.slice(0, 300) }),
                ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
              })
              return false
            }
            const url = new URL((result.value as { readonly url: string }).url)
            const exchange = await fetch(url, { redirect: 'manual' })
            await exchange.body?.cancel()
            const cookies = exchange.headers.getSetCookie()
              .map(header => header.split(';')[0] ?? '')
              .filter(pair => pair !== '')
            const cookieHeader = cookies.join('; ')
            let pageStatus: number | undefined
            let pageBytes = 0
            if (cookieHeader !== '') {
              const page = await fetch(`${url.origin}/`, {
                redirect: 'manual',
                headers: { cookie: cookieHeader },
              })
              const body = await page.text()
              pageStatus = page.status
              pageBytes = body.length
            }
            emit({
              m4a0: 'qualification',
              op: 'web-access-url',
              processRole: 'client',
              pid: process.pid,
              ok: true,
              loopback: url.hostname === '127.0.0.1',
              protocol: url.protocol,
              pathname: url.pathname,
              tokenParams: url.searchParams.getAll('token').length,
              paramNames: [...url.searchParams.keys()],
              exchangeStatus: exchange.status,
              cookieNames: cookies.map(pair => pair.split('=')[0]),
              ...(pageStatus === undefined ? {} : { pageStatus, pageBytes }),
              ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
            })
            return false
          }
          if (request.op === 'shutdown') {
            await stop(0)
            return true
          }
          emit({ m4a0: 'control-error', error: `local client entry: unknown op ${JSON.stringify(request.op)}` })
          return false
        })
        await stopped
        return
      }
    } else {
      transport = await transportModule.startLocalTransport(context, {
        dshAnchor: options.dshAnchor,
        host,
        scope,
        diag,
        onFatal: onTransportFatal,
      })
      if (terminalError !== undefined) {
        await stop(1, terminalError)
        return
      }
      emit({
        m4a0: 'transport-ready',
        processRole: 'client',
        pid: process.pid,
        phase: 'transport-ready',
        ...traceTransportStatus(),
      })
    }

    // Qualification-only startup-failure control. The internal entry is not a
    // public surface; this flag lets the process lane exercise the after-
    // context reverse cleanup without perturbing the installed-build
    // fingerprint that a renamed chunk would change.
    if (process.env.SPLIT_PROCESS_CLIENT_FORCE_FAILURE === 'client-bootstrap') {
      throw new Error('local client entry: qualification forced client bootstrap failure')
    }
    const clientContext = context
    if (clientContext === undefined) throw new Error('local client entry: the Client root Context is missing')
    const surfaceFacts = surfaceStartupFacts(options, launchEnvelope)
    /**
     * The ONE allowed process-composition edge into `app/bootstrap.ts`
     * (architecture gate: exact lazy dynamic import, this entry only). It runs
     * only AFTER `PluginPackages` installed the official runtime resolution and
     * the Client bootstrap mounted the official Domain/UI/application graph; it
     * mounts the runner as its own Cordis fiber on the SAME Client Context.
     */
    const mountRunner: NonNullable<LocalClientComposition['mountRunner']> = async input => {
      const bridge = createLocalClientSurfaceBridge(code => {
        runDetached('local client: surface exit', () => stop(code), { diag })
      })
      // The root `appExit` bridge (provided ONCE below) reads the CURRENT
      // revision's bridge. It must never point at a disposed revision's
      // callback after a same-process surface replacement.
      activeBridge = bridge
      const { applyRunnerWithRuntime } = await import('../bootstrap.ts')
      // M6-1/F5-B: the ONE automatic Workspace eligibility check. It runs after
      // the official Host authentication and before this surface revision's
      // runner exists; the verdict only permits an AUTO host-path proposal (the
      // Host still signs the WorkspaceId). Every unreadable/uncertain fact is
      // `unverified`, so the surface stays unselected until the user picks a
      // Host Workspace through the existing Browser.
      const launchWorkspace: LaunchWorkspaceVerdict = classifyLaunchWorkspace(host.identity, CLIENT_LAUNCH_CWD, {
        ...(CLIENT_LAUNCH_OBJECT === undefined ? {} : { launchObject: CLIENT_LAUNCH_OBJECT }),
      })
      let runnerFiber: Fiber | undefined
      try {
        runnerFiber = clientContext.plugin(pluginContext => {
          applyRunnerWithRuntime(pluginContext, input.config, input.override, {
            surfaceReady: () => bridge.markMounted(),
            surfaceFailed: error => bridge.fail(error),
            // M4 PR4: the ONE process-owned manual reload capability of this
            // real surface mount. The command handler has already made the
            // Client-local safety decision in the SAME synchronous stack; this
            // callback only drives the existing PR3 request latch/preflight.
            ...(reexecHandler === undefined
              ? {}
              : { requestClientReload: () => reexecHandler!.request('manual') }),
          }, launchWorkspace)
        })
        await runnerFiber
      } catch (error) {
        bridge.fail(error)
        throw error
      }
      const fiber = runnerFiber
      return {
        ready: bridge.ready,
        stopped: bridge.stopped,
        dispose: async (): Promise<void> => { await fiber.dispose() },
        ...(fiber.uid == null ? {} : { fiberUid: fiber.uid }),
      }
    }
    if (options.mode === 'surface') {
      // The ONE root `appExit` service. It delegates to the CURRENT revision's
      // bridge; a replacement swaps `activeBridge` before the new runner mounts.
      clientContext.provide('appExit', (code: number) => { activeBridge?.requestStop(code) })
      // Qualification-only same-process surface HMR (M4-C1): SIGUSR2 retires
      // and remounts the Client surface on the SAME PID/Context/transport. It
      // is mutually exclusive with the T34/T36 SIGUSR2 qualification modes.
      if (process.env.SPLIT_PROCESS_CLIENT_HMR_PROBE === '1') {
        if (process.env.SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF === '1'
          || process.env.SPLIT_PROCESS_CLIENT_REEXEC_PROBE === '1'
          || (process.env.SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE !== undefined
            && process.env.SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE !== '')) {
          throw new Error('local client entry: the HMR qualification signal is mutually exclusive with the T34/T36/reexec SIGUSR2 modes')
        }
        process.on('SIGUSR2', () => {
          if (handle === undefined) return
          runDetached('local client: surface HMR', () => {
            const run = enqueueRevisionTask(async () => {
              await handle!.replaceSurfaceForQualification()
            })
            // Failure is observed OUTSIDE the serial task: `stop()` waits for
            // the same slot, so awaiting stop from inside it would deadlock.
            return run.catch(error => stop(1, error))
          }, { diag })
        })
      }
      // The ONE Client reexec request handler of this surface process (M4
      // PR3/PR4). It is created for EVERY real surface Client, because the
      // public manual `/reload-client` command and the qualification SIGUSR2
      // probe share this SAME latch, preflight and stop path. The
      // side-by-side target override belongs to the qualification flag ONLY:
      // the production command always resolves the replacement through the
      // active official profile.
      const reexecProbe = process.env.SPLIT_PROCESS_CLIENT_REEXEC_PROBE === '1'
      const targetOverride = reexecProbe ? process.env.SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT : undefined
      if (targetOverride !== undefined && targetOverride !== '' && !isAbsolute(targetOverride)) {
        throw new Error('local client entry: SPLIT_PROCESS_CLIENT_REEXEC_TARGET_PACKAGE_ROOT must be an absolute path')
      }
      reexecHandler = createClientReexecRequestHandler({
        status: () => handle?.status,
        // TARGET-SOURCE ISOLATION: the manual command always resolves the
        // ACTIVE PROFILE installation. Only the internal qualification request
        // (with its own probe flag) may use the side-by-side package override,
        // even while both entries share this process and this ONE latch.
        prepare: (status, source) => prepareClientReexec({
          status,
          verifiedHostInstanceId: host.identity.instanceId,
          profileDir,
          dshAnchor: options.dshAnchor,
          profile: options.profile,
          dshVersion: scope.dshVersion,
          currentBuildId: scope.buildId,
          ...(source === 'qualification' && reexecProbe && targetOverride !== undefined && targetOverride !== ''
            ? { targetPackageRootOverride: targetOverride }
            : {}),
        }),
        requestStop: () => {
          runDetached('local client: reexec handoff', () => stop(0), { diag })
        },
        emit,
        canRequest: () => stopping === undefined,
        onAccepted: accepted => { reexecIntent = accepted },
      })
      if (reexecProbe) process.on('SIGUSR2', () => { reexecHandler?.request('qualification') })
      // A closed terminal (PTY HUP) is a normal Client exit: the physical
      // surface can no longer render or accept input. It joins the SAME
      // idempotent stop path as Esc / `/exit` / SIGINT / SIGTERM.
      const onTerminalEnd = (): void => {
        runDetached('local client: terminal EOF shutdown', () => stop(0), { diag })
      }
      process.stdin.on('end', onTerminalEnd)
      process.stdin.on('close', onTerminalEnd)
      // Qualification-only transport-rollover trigger (the B1 control channel
      // has no tty in surface mode): SIGUSR1 drops the physical mux socket
      // exactly like `qualification-drop-websocket`, never a production path.
      process.on('SIGUSR1', () => {
        transport?.dropWebSocketsForQualification()
        emit({ m4b2s: 'qualification', op: 'drop-websocket', processRole: 'client', pid: process.pid })
      })
    }
    const composition: LocalClientComposition = options.mode === 'surface'
      ? {
          mode: 'surface',
          signal: startupAbort.signal,
          transport,
          host: host.identity,
          dshAnchor: options.dshAnchor,
          authenticatedFetch: transport.authenticatedFetch,
          domains: mountedDomains,
          interactionDelivery,
          mountRunner,
          diag,
          onStatus: status => {
            emit({ m4b2s: 'surface-status', ...traceStatus(status) })
          },
          onQualification: record => {
            emit({ m4b2s: 'qualification', ...record })
          },
        }
      : { mode: 'qualification', transport, host: host.identity }
    try {
      // Qualification-only hold in the pre-assignment window (the dynamic
      // import and the composition are already resolved, but `startupPromise`
      // is not assigned yet): a SIGTERM here must wait for this ONE gate.
      const holdBeforeStart = process.env.SPLIT_PROCESS_CLIENT_HOLD_BEFORE_START
      if (holdBeforeStart !== undefined && holdBeforeStart !== '') {
        emit({ m4a0: 'qualification', op: 'before-start-hold', processRole: 'client', pid: process.pid })
        await waitForStartupHold(holdBeforeStart, startupAbort.signal)
      }
      startupPromise = startLocalClient(clientContext, surfaceFacts, processStartIdentity, composition)
      handle = await startupPromise
    } finally {
      startupReadyResolve?.()
      startupReadyResolve = undefined
    }
    if (stopping !== undefined) {
      // The signal/exit coordinator already owns the teardown; never publish a
      // ready surface after a stop was requested.
      await stopping
      return
    }
    if (terminalError !== undefined) {
      // A terminal transport failure may have arrived while the UI subtree was
      // mounting; never emit a ready state after stop was requested.
      await stop(1, terminalError)
      return
    }
    if (expectedHostInstanceId !== undefined) {
      // A replacement Client may only claim success against the expected Host
      // and the OFFICIAL current Session history open. `ready`/`sessionOpen`
      // alone are not restore evidence.
      const restoredHost = handle.status.host
      if (restoredHost === undefined || restoredHost.instanceId !== expectedHostInstanceId) {
        throw new LocalScopeError(
          'HOST_IDENTITY_MISMATCH',
          'local client entry: the handoff Client authenticated a different Host instance',
        )
      }
      if (handle.status.transport !== 'connected') {
        throw new Error('local client entry: the handoff Client has no connected official transport')
      }
      const proof = await handle.awaitHandoffOpen(surfaceFacts.sessionId, startupAbort.signal)
      // A stop/signal or an official transport fatal may have landed during the
      // open proof; never publish `handoff-restored` after either.
      if (stopping !== undefined) {
        await stopping
        return
      }
      const restored = handle.status
      const restoredFacts = assertHandoffRestored(restored, expectedHostInstanceId, terminalError)
      // Final synchronous currentness fence over the generation/Session the
      // proof settled on, immediately before the success claim.
      proof.verify()
      emit({
        m4r: 'handoff-restored',
        processRole: 'client',
        pid: process.pid,
        expectedHostInstanceId,
        hostInstanceId: restoredFacts.hostInstanceId,
        ...(surfaceFacts.sessionId === undefined ? {} : { sessionId: surfaceFacts.sessionId }),
        clientBuildId: scope.buildId,
        transport: restored.transport,
        sessionOpen: restored.sessionOpen,
        sessionHistoryOpen: surfaceFacts.sessionId !== undefined,
        surfaceMounted: restored.surfaceMounted,
      })
    }
    emit({ m4a0: 'ready', ...traceStatus(handle.status) })
    compositionDone = true

    if (options.mode === 'surface') {
      // Surface mode owns the tty: the B1 JSONL control channel must never
      // touch stdin/stdout. The process is driven by the real terminal.
      await stopped
      return
    }
    attachEntryControl(async request => {
      if (request.op === 'status') {
        emit({
          m4a0: 'status',
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
          ...handle!.status,
        })
        return false
      }
      if (request.op === 'shutdown') {
        await stop(0)
        return true
      }
      if (request.op === 'qualification-drop-websocket') {
        transport?.dropWebSocketsForQualification()
        emit({
          m4a0: 'qualification',
          op: 'drop-websocket',
          processRole: 'client',
          pid: process.pid,
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        })
        return false
      }
      if (request.op === 'qualification-host-foundation') {
        // Qualification-only: mount the Remote contributions on THIS live
        // Client Context, prove the official/private RPC and (when requested)
        // the official `workspace` namespace, then unmount them. The module is
        // loaded dynamically so it never joins the normal startup path or the
        // Client entry's static dependency graph.
        if (context === undefined) throw new Error('local client entry: the qualification probe has no Client Context')
        // `workspacePath` is the harness-created directory the Host must
        // canonicalize and register. It is a qualification control input only:
        // the surface runtime and the package API never receive it. Absent = the
        // caller does not request the Workspace proof (the M4 cross-build lane
        // runs a new Client against a Host that predates the namespace); a
        // supplied value must be a real path string.
        const qualificationRequest = request as EntryControlRequest & {
          readonly workspacePath?: unknown
          readonly workspaceResume?: unknown
          readonly schedule?: unknown
        }
        const workspacePath = qualificationRequest.workspacePath
        if (workspacePath !== undefined && (typeof workspacePath !== 'string' || workspacePath === '')) {
          throw new Error('local client entry: a supplied workspacePath must be a non-empty string')
        }
        // `workspaceResume` asks for the generation-currentness proof: the probe
        // holds the live Workspace stream open while THIS entry drops the
        // Client's physical carrier, so the stream can only continue by
        // resuming on the replacement generation. Qualification-only; the
        // surface runtime never receives it.
        const workspaceResume = qualificationRequest.workspaceResume
        if (workspaceResume !== undefined && workspaceResume !== true) {
          throw new Error('local client entry: workspaceResume must be the boolean true when supplied')
        }
        if (workspaceResume === true && workspacePath === undefined) {
          throw new Error('local client entry: the generation-resume control requires a workspacePath')
        }
        // `schedule` asks for the official Schedule Remote namespace proof. It
        // is a qualification control input only and must never leak into the
        // surface runtime or the package API.
        const schedule = qualificationRequest.schedule
        if (schedule !== undefined && schedule !== true) {
          throw new Error('local client entry: schedule must be the boolean true when supplied')
        }
        const { runHostFoundationProbe } = await import('./host-foundation-probe.ts')
        const proof = await runHostFoundationProbe(context, {
          dshAnchor: options.dshAnchor,
          host,
          ...(workspacePath === undefined ? {} : { workspacePath }),
          ...(schedule === true ? { schedule: true } : {}),
          ...(workspaceResume !== true
            ? {}
            : {
                // The entry's own transport projection is the generation
                // authority the smoke already reads; the probe never resolves
                // the Client Context's `connection` service itself.
                readGeneration: () => transport?.status().generationId,
                dropCarrier: () => {
                  transport?.dropWebSocketsForQualification()
                  emit({
                    m4a0: 'qualification',
                    op: 'drop-websocket',
                    label: 'workspace-hold',
                    processRole: 'client',
                    pid: process.pid,
                  })
                },
              }),
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        })
        emit({
          ...proof,
          processRole: 'client',
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        })
        return false
      }
      emit({ m4a0: 'control-error', error: `local client entry: unknown op ${JSON.stringify(request.op)}` })
      return false
    })
    await stopped
  } catch (error) {
    // A signal/exit coordinator may already own the teardown (the startup was
    // aborted by `stop`). Wait for that ONE coordinator and do not report a
    // second cleanup or a duplicate failure for the expected cancellation.
    if (stopping !== undefined) {
      // Release a stop that is waiting for the one startup gate; this path is
      // the startup chain's own failure exit, so no `startLocalClient` call
      // can still arrive.
      startupReadyResolve?.()
      await stopping
      return
    }
    const failure = terminalError ?? error
    let primary = failure instanceof Error ? failure : new Error(String(failure))
    const cleanupErrors: unknown[] = []
    const timedOut = await disposeWithinDeadline(async () => {
      if (rootReleased) return
      if (handle !== undefined) {
        try { await handle.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
        rootReleased = true
        return
      }
      try { interactionDelivery?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      try { peerSeat?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      try { await transport?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      try { await domainPrerequisites?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      try { await mountedDomains?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      startupGate?.cancel(primary)
      try { await loaderFiber?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      try { await context?.fiber.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      rootReleased = true
    }, cleanupErrors)
    for (const cleanupError of cleanupErrors) primary = mergeCause(primary, cleanupError)
    const transportCleanupFailed = (error instanceof Error && (error as { cleanupFailed?: boolean }).cleanupFailed === true)
      || cleanupErrors.some(cleanupError => cleanupError instanceof Error && (cleanupError as { cleanupFailed?: boolean }).cleanupFailed === true)
    emit({
      m4a0: 'failure',
      processRole: 'client',
      phase: context === undefined ? 'startup' : 'after-context',
      pid: process.pid,
      ...traceTransportStatus(),
      ...(failure instanceof LocalScopeError ? { code: failure.code } : {}),
      error: primary.message,
      ...(primary.stack === undefined ? {} : { stack: primary.stack }),
      ...(primary.cause === undefined ? {} : { cause: primary.cause instanceof Error ? primary.cause.message : String(primary.cause) }),
    })
    // Surface mode owns the tty: EVERY startup failure gets ONE concise,
    // actionable human line on stderr (a handoff Client gets its own restore
    // line; every other failure, including ordinary Host init / Loader /
    // assembly failures, gets the sanitized surface line). Never a bare exit 1.
    if (options.mode === 'surface') {
      const line = expectedHostInstanceId !== undefined
        ? handoffStartupFailureLine(failure)
        : surfaceStartupFailureLine(failure)
      process.stderr.write(`${line}\n`)
    }
    process.stdin.pause()
    if (cleanupErrors.length === 0 && !timedOut && !transportCleanupFailed) {
      emit({ m4a0: 'cleanup', processRole: 'client', phase: 'after-context', pid: process.pid, status: 'completed' })
    } else {
      const cleanup = cleanupErrors[0] instanceof Error ? cleanupErrors[0] : new Error(String(cleanupErrors[0]))
      emit({
        m4a0: 'cleanup-failure',
        processRole: 'client',
        phase: 'after-context',
        pid: process.pid,
        error: cleanup.message,
      })
    }
    process.exitCode = 1
    if (timedOut || transportCleanupFailed) forceExitAfterCleanupFailure()
  } finally {
    process.stdin.pause()
    // The ONE shutdown tail: release the seat this mode actually holds (the
    // qualification Client seat; `surface`/`peer` hold none) BEFORE any
    // replacement Client can spawn. A reexec starts only for a fully successful
    // teardown; its child inherits this process's terminal only after the old
    // surface/root are gone.
    const reexecExitCode = await finishClientEntryShutdown({
      seat,
      ...(reexecIntent === undefined
        ? {}
        : { reexec: { intent: reexecIntent, teardownSucceeded: reexecTeardownSucceeded, cancelled: () => reexecCancelled } }),
      emit,
      stderr: line => { process.stderr.write(`${line}\n`) },
      onChildSpawned: child => { reexecChild = child },
    })
    if (reexecExitCode !== undefined) process.exitCode = reexecExitCode
    try {
      recordSink?.close()
    } catch (error) {
      process.exitCode = 1
      process.stderr.write(`local client entry: closing the surface record sink failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
  }
}

/**
 * Dispose the Client-owned root and classify a rejecting disposer as a real
 * cleanup failure. The requested success code becomes 1; an interrupt/signal
 * code keeps its nonzero identity. Never returns the success code after a
 * failed dispose, and a second stop call is prevented by the caller's latch.
 */
export async function stopLocalClient(
  handle: { dispose(): Promise<void> },
  requestedCode: number,
  emit: (record: Record<string, unknown>) => void = writeEntryRecord,
): Promise<number> {
  try {
    await handle.dispose()
    return requestedCode
  } catch (error) {
    emit({
      m4a0: 'cleanup-failure',
      processRole: 'client',
      phase: 'shutdown',
      pid: process.pid,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    })
    return requestedCode === 0 ? 1 : requestedCode
  }
}

/** Qualification-only hold in the pre-startup assignment window. */
async function waitForStartupHold(path: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 60_000
  while (!existsSync(path)) {
    signal.throwIfAborted()
    if (Date.now() > deadline) {
      throw new Error(`local client entry: the pre-startup barrier was not released: ${path}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  signal.throwIfAborted()
}

/**
 * The human-facing surface line for one startup failure. The live-Host
 * protocol/DSH refusal gets a dedicated, actionable line that names the code,
 * keeps the old Host untouched, requires an explicit owner-verified OS stop
 * and says that automatic in-memory migration is unsupported. It never
 * includes the registry PID, the launch URL/token or a private profile path.
 * Every other startup failure keeps the existing diagnostic.
 */
export function surfaceStartupFailureLine(error: unknown): string {
  if (error instanceof LocalScopeError && error.code === 'HOST_PROTOCOL_INCOMPATIBLE') {
    return 'HOST_PROTOCOL_INCOMPATIBLE: Another live local Host for this profile uses a different local protocol or DSH runtime. The Host has not been stopped or replaced. Finish or save your work in that Host, then explicitly stop that Host through its normal operating-system shutdown signal and start a compatible Host. Automatic upgrade and migration of in-memory work are not supported.'
  }
  return `split client surface: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * The human-facing line for ONE replacement-Client handoff failure. It names
 * the classified reason (expected Host absent/replaced/protocol, invalid
 * replacement package, or Session history open) and says how to recover
 * manually. Only fixed entry-owned messages are surfaced: an arbitrary
 * startup/spawn error may carry a private path or PID and is replaced with a
 * generic reason. No Cookie/token/launch URL ever enters this line.
 */
export function handoffStartupFailureLine(error: unknown): string {
  let reason: string
  if (error instanceof LocalScopeError) {
    if (error.code === 'HOST_HANDOFF_UNAVAILABLE') reason = 'the expected Host is no longer available'
    else if (error.code === 'HOST_IDENTITY_MISMATCH') reason = 'the live local Host is not the expected instance'
    else if (error.code === 'HOST_PROTOCOL_INCOMPATIBLE') reason = 'the expected Host uses a different local protocol or DSH runtime'
    else reason = 'the expected Host could not be authenticated'
  } else if (error instanceof Error
    && (error.message.startsWith('local client entry: ') || error.message.startsWith('local client reexec: '))) {
    reason = error.message.slice(error.message.indexOf(': ') + 2)
  } else {
    reason = 'the replacement Client could not restore the expected Host and Session'
  }
  return `Client handoff failed: ${reason}. The Host was not stopped or replaced. Start a compatible Client manually to continue.`
}

/**
 * Read the internal Client mode. Absent/empty keeps the frozen B1
 * `qualification` contract; `surface` is the internal real-terminal mode. Any
 * other value fails closed (never a silent default).
 */
function clientModeFromEnvironment(): LocalClientEntryMode {
  const raw = process.env.SPLIT_PROCESS_CLIENT_MODE
  if (raw === undefined || raw === '') return 'qualification'
  if (raw === 'qualification' || raw === 'surface' || raw === 'peer') return raw
  throw new Error(`local client entry: invalid SPLIT_PROCESS_CLIENT_MODE ${JSON.stringify(raw)}; expected "qualification", "surface" or "peer"`)
}

/** Read the launcher environment; a missing anchor is a hard startup failure. */
function optionsFromEnvironment(): LocalClientEntryOptions {
  const dshAnchor = process.env.SPLIT_PROCESS_DSH_ANCHOR
  if (dshAnchor === undefined || dshAnchor === '') {
    throw new Error('local client entry: SPLIT_PROCESS_DSH_ANCHOR must name the installed @deepseek-ai/dsh/package.json')
  }
  return {
    dshAnchor,
    profile: process.env.SPLIT_PROCESS_PROFILE ?? 'pi-tui',
    mode: clientModeFromEnvironment(),
  }
}

if (import.meta.main) {
  try {
    await runLocalClientEntry(optionsFromEnvironment())
  } catch (error) {
    const record = {
      m4a0: 'failure',
      processRole: 'client',
      phase: 'startup',
      pid: process.pid,
      ...(error instanceof LocalScopeError ? { code: error.code } : {}),
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    }
    if (process.env.SPLIT_PROCESS_CLIENT_MODE === 'surface') {
      // Surface mode owns the tty: a launcher/startup failure is a human line
      // on stderr, never a JSON record on the terminal.
      const handoff = process.env.SPLIT_PROCESS_CLIENT_EXPECTED_INSTANCE_ID
      const line = handoff === undefined || handoff === ''
        ? surfaceStartupFailureLine(error)
        : handoffStartupFailureLine(error)
      process.stderr.write(`${line}\n`)
    } else {
      writeEntryRecord(record)
    }
    process.exit(1)
  }
}
