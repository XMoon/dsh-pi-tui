/**
 * Local Host discovery and official authentication.
 *
 * The registry is an unauthenticated hint: it selects a candidate origin and
 * PID, while the only readiness proof is the official `/connect` launch-token
 * exchange followed by the authenticated identity Fetch route. This module
 * never creates a Host Context, a Session, an Agent or a second transport
 * authority, and it never removes another process's files.
 *
 * @module app/remote-process/local-discovery
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  LOCAL_PROTOCOL,
  LocalScopeError,
  parseProcessStat,
  readLinuxStarttime,
  readProcessStarttime,
  type LocalScope,
} from './local-scope.ts'
import {
  readKernelProcess,
  sameKernelProcess,
  type DarwinKernelProcessIdentity,
  type KernelObservation,
  type KernelProcessIdentity,
} from '../../runtime/native-process/identity.ts'
import { spawnHostCandidate, startManagedHostCandidate } from './local-host-manager.ts'

/** Registry file name inside the private scope directory. */
const REGISTRY_FILE = 'instance.json'
/** Launch-material file name inside the private scope directory. */
const LAUNCH_FILE = 'launch.json'
/** Hard read limit for the registry record. */
const MAX_REGISTRY_BYTES = 8 * 1024
/** Hard read limit for the launch material. */
const MAX_LAUNCH_BYTES = 4 * 1024
/** Bounded registry wait used by ensureLocalHost. */
const REGISTRY_WAIT_TIMEOUT_MS = 60_000
/** Bounded registry re-read interval. */
const REGISTRY_POLL_INTERVAL_MS = 250
/** Per-request bound for the official HTTP handshake. */
const AUTH_REQUEST_TIMEOUT_MS = 10_000

/** The platform-independent published Host facts. */
export interface HostInstanceSharedFields {
  readonly scopeId: string
  readonly profileRealpath: string
  readonly instanceId: string
  readonly hostPid: number
  readonly origin: string
  readonly protocol: typeof LOCAL_PROTOCOL
  readonly bundleVersion: string
  readonly dshVersion: string
  readonly buildId: string
}

/** {@link LocalInstanceSharedFields} under its historical internal name. */
type LocalInstanceSharedFields = HostInstanceSharedFields

/**
 * The frozen Linux registry schema. The JSON keys, their order and the
 * `/proc/<pid>/stat` starttime representation are a long-lived compatibility
 * contract; PR-2 adds the Darwin variant WITHOUT changing this one.
 */
export interface LinuxLocalInstanceRecord extends LocalInstanceSharedFields {
  readonly schema: 1
  readonly hostStarttime: string
}

/**
 * The Darwin registry schema: the exact PR-1 kernel identity, not a Linux
 * starttime stand-in. `hostKernelIdentity.pid` must equal `hostPid`; the
 * serialized decimal strings are the exact ABI-safe values.
 */
export interface DarwinLocalInstanceRecord extends LocalInstanceSharedFields {
  readonly schema: 2
  readonly hostKernelIdentity: DarwinKernelProcessIdentity
}

/** One published Host identity record (no secret material). */
export type LocalInstanceRecord = LinuxLocalInstanceRecord | DarwinLocalInstanceRecord

/** The identity material one Host publishes for its OWN platform. */
export type HostProcessIdentity =
  | { readonly schema: 1; readonly hostStarttime: string }
  | { readonly schema: 2; readonly hostKernelIdentity: DarwinKernelProcessIdentity }

/** The private launch material that carries the Host's official token. */
export interface LocalLaunchMaterial {
  readonly schema: 1
  readonly instanceId: string
  readonly connectUrl: string
}

/** One candidate that passed the authenticated identity comparison. */
export interface VerifiedLocalHost {
  /** The registry candidate the Client started from. */
  readonly record: LocalInstanceRecord
  /** This Client process's own signed API cookie, held only in memory. */
  readonly cookie: string
  /** The authenticated identity echo; strictly equal to `record`. */
  readonly identity: LocalInstanceRecord
}

/** Options for one bounded local Host ensure. */
export interface EnsureLocalHostOptions {
  readonly scope: LocalScope
  /** Installed `dist/local-host.mjs` of this same package. */
  readonly hostEntryPath: string
  /** Installed `@deepseek-ai/dsh/package.json` anchor. */
  readonly dshAnchor: string
  /** Installed profile name. */
  readonly profile: string
  /**
   * Client-handoff expectation: this Client must attach to THIS authenticated
   * Host instance and never spawn or replace a Host. The ordinary ensure path
   * stays byte-for-byte unchanged when it is absent.
   */
  readonly expectedInstanceId?: string
  /** The caller's startup/lifecycle cancellation. A cancelled ensure never
   *  commits an authentication result and never signals a Host. */
  readonly signal?: AbortSignal
  /**
   * How a cold Client with no reusable Host asks for the Host to be started.
   * `undefined` is the historical detached process spawn (internal
   * qualification/peer/manual paths). `public-managed` is the M6-2B public
   * daemon path: the profile-scoped systemd user manager when safely available,
   * the strict-absence process fallback otherwise. It never changes the wire,
   * business or readiness semantics.
   */
  readonly hostStartPolicy?: 'public-managed'
}

/** Exact Linux registry keys; unknown fields are rejected, not ignored. */
const RECORD_KEYS = [
  'schema',
  'scopeId',
  'profileRealpath',
  'instanceId',
  'hostPid',
  'hostStarttime',
  'origin',
  'protocol',
  'bundleVersion',
  'dshVersion',
  'buildId',
] as const

/** Exact Darwin registry keys; `hostKernelIdentity` replaces `hostStarttime`. */
const DARWIN_RECORD_KEYS = [
  'schema',
  'scopeId',
  'profileRealpath',
  'instanceId',
  'hostPid',
  'hostKernelIdentity',
  'origin',
  'protocol',
  'bundleVersion',
  'dshVersion',
  'buildId',
] as const

/** Exact Darwin kernel-identity keys (the complete PR-1 identity ABI). */
const DARWIN_IDENTITY_KEYS = [
  'platform',
  'pid',
  'bootUUID',
  'uniqueId',
  'parentUniqueId',
  'processUUID',
  'startSec',
  'startUsec',
  'ppid',
  'pgid',
  'sid',
  'uid',
  'state',
] as const

/** Exact launch-material keys. */
const LAUNCH_KEYS = ['schema', 'instanceId', 'connectUrl'] as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const HEX_64 = /^[0-9a-f]{64}$/u
const HEX_32 = /^[0-9a-f]{32}$/u
const DECIMAL = /^\d+$/u
const COOKIE_PAIR = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[^;\s]*$/u

/** A strict object with exactly the expected own keys. */
function assertExactObject(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', `local discovery: ${label} must be a JSON object`)
  }
  const record = value as Record<string, unknown>
  const actual = Object.keys(record).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', `local discovery: ${label} has unexpected fields`)
  }
  return record
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value === '') {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', `local discovery: ${label}.${key} must be a non-empty string`)
  }
  return value
}

/** Validate the loopback-only origin shape B1 accepts. */
function assertLoopbackOrigin(origin: string): void {
  let url: URL
  try {
    url = new URL(origin)
  } catch (error) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: origin is not a URL', error)
  }
  if (
    url.protocol !== 'http:'
    || url.hostname !== '127.0.0.1'
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
    || url.port === ''
    || Number(url.port) < 1
    || Number(url.port) > 65535
    || url.origin !== origin
  ) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', `local discovery: origin must be one canonical http://127.0.0.1:<port>`)
  }
}

/**
 * Build one Host publication record in the canonical serialization order. The
 * authenticated identity echo and `writeLocalRecord` must share this ONE
 * insertion order: Linux schema 1 is a frozen bytes contract, so
 * `hostStarttime` stays between `hostPid` and `origin`.
 */
export function buildHostInstanceRecord(
  shared: HostInstanceSharedFields,
  hostIdentity: HostProcessIdentity,
): LocalInstanceRecord {
  if (hostIdentity.schema === 1) {
    return {
      schema: 1,
      scopeId: shared.scopeId,
      profileRealpath: shared.profileRealpath,
      instanceId: shared.instanceId,
      hostPid: shared.hostPid,
      hostStarttime: hostIdentity.hostStarttime,
      origin: shared.origin,
      protocol: shared.protocol,
      bundleVersion: shared.bundleVersion,
      dshVersion: shared.dshVersion,
      buildId: shared.buildId,
    }
  }
  return {
    schema: 2,
    scopeId: shared.scopeId,
    profileRealpath: shared.profileRealpath,
    instanceId: shared.instanceId,
    hostPid: shared.hostPid,
    hostKernelIdentity: hostIdentity.hostKernelIdentity,
    origin: shared.origin,
    protocol: shared.protocol,
    bundleVersion: shared.bundleVersion,
    dshVersion: shared.dshVersion,
    buildId: shared.buildId,
  }
}

/** The two scope facts a record must echo; the build facts are judged separately. */
interface RecordScope {
  readonly scopeId: string
  readonly profileRealpath: string
}

function requirePositiveInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', `local discovery: ${label}.${key} must be a positive integer`)
  }
  return value
}

function requireDecimal(record: Record<string, unknown>, key: string, label: string): string {
  const value = requireString(record, key, label)
  if (!DECIMAL.test(value)) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', `local discovery: ${label}.${key} must be an exact decimal string`)
  }
  return value
}

/** Parse the complete Darwin kernel identity. Every field is required, typed
 *  and exact: a malformed/truncated identity can never stand in for a live
 *  process. `pid` must be the same numeric Host pid the record names. */
function parseDarwinKernelIdentity(value: unknown, hostPid: number): DarwinKernelProcessIdentity {
  const identity = assertExactObject(value, DARWIN_IDENTITY_KEYS, 'registry.hostKernelIdentity')
  if (identity.platform !== 'darwin') {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.hostKernelIdentity.platform must be darwin')
  }
  const pid = requirePositiveInteger(identity, 'pid', 'registry.hostKernelIdentity')
  if (pid !== hostPid) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.hostKernelIdentity.pid must equal registry.hostPid')
  }
  const bootUUID = requireString(identity, 'bootUUID', 'registry.hostKernelIdentity')
  if (!UUID_PATTERN.test(bootUUID)) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.hostKernelIdentity.bootUUID must be a UUID')
  }
  const processUUID = requireString(identity, 'processUUID', 'registry.hostKernelIdentity')
  if (!HEX_32.test(processUUID)) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.hostKernelIdentity.processUUID must be 32 lowercase hex characters')
  }
  return {
    platform: 'darwin',
    pid,
    bootUUID,
    uniqueId: requireDecimal(identity, 'uniqueId', 'registry.hostKernelIdentity'),
    parentUniqueId: requireDecimal(identity, 'parentUniqueId', 'registry.hostKernelIdentity'),
    processUUID,
    startSec: requireDecimal(identity, 'startSec', 'registry.hostKernelIdentity'),
    startUsec: requireDecimal(identity, 'startUsec', 'registry.hostKernelIdentity'),
    ppid: requirePositiveInteger(identity, 'ppid', 'registry.hostKernelIdentity'),
    pgid: requirePositiveInteger(identity, 'pgid', 'registry.hostKernelIdentity'),
    sid: requirePositiveInteger(identity, 'sid', 'registry.hostKernelIdentity'),
    uid: requireDecimalInteger(identity, 'uid', 'registry.hostKernelIdentity'),
    state: requireDecimalInteger(identity, 'state', 'registry.hostKernelIdentity'),
  }
}

function requireDecimalInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', `local discovery: ${label}.${key} must be a non-negative integer`)
  }
  return value
}

/** The shared fields both schemas serialize, in their exact key order. */
function parseSharedRecord(record: Record<string, unknown>, scope: RecordScope): Omit<LocalInstanceSharedFields, 'hostPid'> & { readonly hostPid: number } {
  const scopeId = requireString(record, 'scopeId', 'registry')
  const profileRealpath = requireString(record, 'profileRealpath', 'registry')
  const instanceId = requireString(record, 'instanceId', 'registry')
  const origin = requireString(record, 'origin', 'registry')
  const protocol = requireString(record, 'protocol', 'registry')
  const bundleVersion = requireString(record, 'bundleVersion', 'registry')
  const dshVersion = requireString(record, 'dshVersion', 'registry')
  const buildId = requireString(record, 'buildId', 'registry')
  const hostPid = requirePositiveInteger(record, 'hostPid', 'registry')
  if (!UUID_PATTERN.test(instanceId)) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.instanceId must be a UUID')
  }
  if (!HEX_64.test(buildId)) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.buildId must be 64 hex characters')
  }
  assertLoopbackOrigin(origin)
  if (scopeId !== scope.scopeId || profileRealpath !== scope.profileRealpath) {
    throw new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local discovery: registry names another profile scope')
  }
  return {
    scopeId,
    profileRealpath,
    instanceId,
    hostPid,
    origin,
    protocol: protocol as typeof LOCAL_PROTOCOL,
    bundleVersion,
    dshVersion,
    buildId,
  }
}

/** Parse the strict registry schema without judging build compatibility. */
function parseRecord(value: unknown, scope: RecordScope): LocalInstanceRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry must be a JSON object')
  }
  const schema = (value as Record<string, unknown>).schema
  if (schema === 1) {
    const record = assertExactObject(value, RECORD_KEYS, 'registry')
    const shared = parseSharedRecord(record, scope)
    const hostStarttime = requireString(record, 'hostStarttime', 'registry')
    if (!DECIMAL.test(hostStarttime)) {
      throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.hostStarttime must be numeric')
    }
    // The schema 1 insertion order is the frozen Linux serialization order:
    // `hostStarttime` stays between `hostPid` and `origin`. Never spread a
    // shared object here, because that would move it last in the JSON bytes.
    return {
      schema: 1,
      scopeId: shared.scopeId,
      profileRealpath: shared.profileRealpath,
      instanceId: shared.instanceId,
      hostPid: shared.hostPid,
      hostStarttime,
      origin: shared.origin,
      protocol: shared.protocol,
      bundleVersion: shared.bundleVersion,
      dshVersion: shared.dshVersion,
      buildId: shared.buildId,
    }
  }
  if (schema === 2) {
    const record = assertExactObject(value, DARWIN_RECORD_KEYS, 'registry')
    const shared = parseSharedRecord(record, scope)
    return {
      schema: 2,
      scopeId: shared.scopeId,
      profileRealpath: shared.profileRealpath,
      instanceId: shared.instanceId,
      hostPid: shared.hostPid,
      hostKernelIdentity: parseDarwinKernelIdentity(record.hostKernelIdentity, shared.hostPid),
      origin: shared.origin,
      protocol: shared.protocol,
      bundleVersion: shared.bundleVersion,
      dshVersion: shared.dshVersion,
      buildId: shared.buildId,
    }
  }
  throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.schema must be 1 or 2')
}

/** Reject a schema that cannot belong to the running local platform. A Linux
 *  schema1 record on macOS (or the reverse) is not a candidate this process may
 *  authenticate, spawn around or treat as a readiness proof. */
function assertRecordSchemaPlatform(record: LocalInstanceRecord): void {
  if (record.schema === 1 && process.platform !== 'linux') {
    throw new LocalScopeError('HOST_PROTOCOL_INCOMPATIBLE', 'local discovery: schema 1 is a Linux Host publication')
  }
  if (record.schema === 2 && process.platform !== 'darwin') {
    throw new LocalScopeError('HOST_PROTOCOL_INCOMPATIBLE', 'local discovery: schema 2 is a macOS Host publication')
  }
}

/** The ONE record equality used by authentication and transport currentness:
 *  the shared fields plus the schema-specific kernel identity. */
export function sameLocalInstanceRecord(left: LocalInstanceRecord, right: LocalInstanceRecord): boolean {
  if (left.schema !== right.schema
    || left.scopeId !== right.scopeId
    || left.profileRealpath !== right.profileRealpath
    || left.instanceId !== right.instanceId
    || left.hostPid !== right.hostPid
    || left.origin !== right.origin
    || left.protocol !== right.protocol
    || left.bundleVersion !== right.bundleVersion
    || left.dshVersion !== right.dshVersion
    || left.buildId !== right.buildId) {
    return false
  }
  if (left.schema === 1 && right.schema === 1) return left.hostStarttime === right.hostStarttime
  if (left.schema === 2 && right.schema === 2) {
    const a = left.hostKernelIdentity
    const b = right.hostKernelIdentity
    return a.platform === b.platform
      && a.pid === b.pid
      && a.bootUUID === b.bootUUID
      && a.uniqueId === b.uniqueId
      && a.parentUniqueId === b.parentUniqueId
      && a.processUUID === b.processUUID
      && a.startSec === b.startSec
      && a.startUsec === b.startUsec
      && a.ppid === b.ppid
      && a.pgid === b.pgid
      && a.sid === b.sid
      && a.uid === b.uid
      && a.state === b.state
  }
  return false
}

/** Can this Client speak the live Host's required local wire contract? */
export function assertClientHostCompatible(record: LocalInstanceRecord, scope: LocalScope): void {
  if (record.protocol !== LOCAL_PROTOCOL || record.dshVersion !== scope.dshVersion) {
    throw new LocalScopeError(
      'HOST_PROTOCOL_INCOMPATIBLE',
      'local discovery: the live Host uses a different local protocol or DSH runtime',
    )
  }
}

/** Does this Host publish the exact installed identity of its OWN build? */
export function assertHostPublicationIdentity(record: LocalInstanceRecord, scope: LocalScope): void {
  assertRecordSchemaPlatform(record)
  if (
    record.protocol !== LOCAL_PROTOCOL
    || record.bundleVersion !== scope.bundleVersion
    || record.dshVersion !== scope.dshVersion
    || record.buildId !== scope.buildId
  ) {
    throw new LocalScopeError(
      'HOST_BUILD_INCOMPATIBLE',
      'local discovery: the Host cannot publish identity for a different local protocol or installed build',
    )
  }
}

/**
 * Read one private scope file with `O_NOFOLLOW`, an owner/mode check and a hard
 * byte cap. Returns `undefined` for a missing file; every unsafe or malformed
 * file is a hard failure.
 */
function readPrivateJsonFile(path: string, maxBytes: number, label: string): unknown | undefined {
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', `local discovery: ${label} is not readable without following a link`, error)
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) {
      throw new LocalScopeError('LOCAL_FILE_UNSAFE', `local discovery: ${label} must be a 0600 regular file owned by this uid`)
    }
    if (info.size > maxBytes) {
      throw new LocalScopeError('LOCAL_FILE_UNSAFE', `local discovery: ${label} exceeds ${String(maxBytes)} bytes`)
    }
    const text = readFileSync(fd, 'utf8')
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      throw new LocalScopeError('LOCAL_FILE_UNSAFE', `local discovery: ${label} is not valid JSON`, error)
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * Strictly read `<scope>/instance.json`. The record is an unauthenticated
 * candidate only; this function performs no liveness or build decision.
 */
export function readLocalRecord(scope: LocalScope): LocalInstanceRecord | undefined {
  const value = readPrivateJsonFile(join(scope.dir, REGISTRY_FILE), MAX_REGISTRY_BYTES, 'instance.json')
  if (value === undefined) return undefined
  return parseRecord(value, scope)
}

/** Strictly read `<scope>/launch.json` after its registry candidate matched. */
export function readLaunchMaterial(scope: LocalScope, record: LocalInstanceRecord): LocalLaunchMaterial {
  const value = readPrivateJsonFile(join(scope.dir, LAUNCH_FILE), MAX_LAUNCH_BYTES, 'launch.json')
  if (value === undefined) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: instance.json has no matching launch.json')
  }
  const launch = assertExactObject(value, LAUNCH_KEYS, 'launch.json')
  if (launch.schema !== 1) throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: launch.json.schema must be 1')
  const instanceId = requireString(launch, 'instanceId', 'launch.json')
  const connectUrl = requireString(launch, 'connectUrl', 'launch.json')
  if (instanceId !== record.instanceId) {
    throw new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local discovery: launch.json names a different Host instance')
  }
  assertConnectUrl(connectUrl, record)
  return { schema: 1, instanceId, connectUrl }
}

/** Validate the exact `/connect` URL shape without exposing its token. */
function assertConnectUrl(connectUrl: string, record: LocalInstanceRecord): void {
  let url: URL
  try {
    url = new URL(connectUrl)
  } catch (error) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: launch.json.connectUrl is not a URL', error)
  }
  const tokens = url.searchParams.getAll('token')
  const keys = [...url.searchParams.keys()]
  if (
    url.origin !== record.origin
    || url.pathname !== '/connect'
    || url.username !== ''
    || url.password !== ''
    || url.hash !== ''
    || tokens.length !== 1
    || tokens[0] === ''
    || keys.length !== 1
  ) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: launch.json.connectUrl is not the Host-owned /connect token URL')
  }
}

/**
 * Liveness is a negative selection fact, never readiness. A missing
 * `/proc/<pid>/stat` (ENOENT) is a definite dead PID; an unreadable or
 * malformed file is UNKNOWN and is a hard failure, never permission to spawn.
 * `procRoot` exists only so the fail-closed classification is testable.
 */
export function inspectHostProcess(
  record: LocalInstanceRecord,
  procRoot = '/proc',
  readKernel: (pid: number) => KernelObservation = readKernelProcess,
): 'alive' | 'dead' {
  assertRecordSchemaPlatform(record)
  if (record.schema === 2) {
    // PR-1 kernel identity, never a numeric pid alone. `unknown` is a hard
    // failure (it cannot authorize a spawn around a possibly live Host);
    // `gone`/`different` are a stale registry candidate, never a kill permit.
    const observed = readKernel(record.hostPid)
    if (observed.kind === 'unknown') {
      throw new LocalScopeError(
        'PROCESS_STARTTIME_UNAVAILABLE',
        `local discovery: the kernel identity of Host pid ${String(record.hostPid)} is unavailable`,
      )
    }
    return sameKernelProcess(record.hostKernelIdentity, observed) === 'same' ? 'alive' : 'dead'
  }
  let stat: string
  try {
    stat = readFileSync(join(procRoot, String(record.hostPid), 'stat'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'dead'
    throw new LocalScopeError(
      'PROCESS_STARTTIME_UNAVAILABLE',
      `local discovery: /proc/${String(record.hostPid)}/stat is not readable`,
      error,
    )
  }
  const parsed = parseProcessStat(stat)
  if (parsed === undefined) {
    throw new LocalScopeError(
      'PROCESS_STARTTIME_UNAVAILABLE',
      `local discovery: /proc/${String(record.hostPid)}/stat has no usable state/starttime`,
    )
  }
  if (parsed.starttime !== record.hostStarttime) return 'dead'
  // A killed but not-yet-reaped Host is a zombie (Z) or dead (X/x): Linux keeps
  // its /proc stat and starttime until the parent reaps it, but it holds no
  // socket and can never become ready. Classify it dead so the Client can
  // replace it through the one kernel seat.
  if (parsed.state === 'Z' || parsed.state === 'X' || parsed.state === 'x') return 'dead'
  return 'alive'
}

/** Read a bounded UTF-8 body; an over-limit identity response is a mismatch. */
async function readBoundedText(response: Response, maxBytes: number, label: string): Promise<string> {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new LocalScopeError('HOST_IDENTITY_MISMATCH', `local discovery: ${label} exceeds ${String(maxBytes)} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

/** Discard a response body without leaking it to logs. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // A response body that cannot be cancelled owns no B1 decision.
  }
}

/** Node's `RequestInit` omits the cache mode; B1 requires `no-store` explicitly. */
type LocalRequestInit = RequestInit & { readonly cache?: 'no-store' }

/** Fetch with the bounded auth timeout; network failure is HOST_UNRESPONSIVE. */
async function authFetch(url: string | URL, init: LocalRequestInit, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS)
  const request: LocalRequestInit = {
    ...init,
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  }
  try {
    return await fetch(url, request)
  } catch (error) {
    throw new LocalScopeError('HOST_UNRESPONSIVE', 'local discovery: the Host did not answer the official HTTP handshake', error)
  }
}

/** Exchange the launch token for this Client process's own signed cookie. */
export async function connectForCookie(
  record: LocalInstanceRecord,
  launch: LocalLaunchMaterial,
  signal?: AbortSignal,
): Promise<string> {
  const url = new URL(launch.connectUrl)
  url.searchParams.set('interactions', 'answer')
  const response = await authFetch(url, { method: 'GET', redirect: 'manual', cache: 'no-store' }, signal)
  if (response.status !== 302) {
    await discard(response)
    throw new LocalScopeError('HOST_AUTH_FAILED', `local discovery: /connect rejected this Client with HTTP ${String(response.status)}`)
  }
  const cacheControl = response.headers.get('cache-control') ?? ''
  if (!/\bno-store\b/iu.test(cacheControl)) {
    await discard(response)
    throw new LocalScopeError('HOST_AUTH_FAILED', 'local discovery: /connect response was not marked no-store')
  }
  const location = response.headers.get('location')
  await discard(response)
  if (location === null) throw new LocalScopeError('HOST_AUTH_FAILED', 'local discovery: /connect returned no mux redirect')
  let redirect: URL
  try {
    redirect = new URL(location, url)
  } catch (error) {
    throw new LocalScopeError('HOST_AUTH_FAILED', 'local discovery: /connect returned an unparsable redirect', error)
  }
  if (redirect.origin !== record.origin || redirect.pathname !== '/api/remote.mux') {
    throw new LocalScopeError('HOST_AUTH_FAILED', 'local discovery: /connect redirected outside the authenticated local mux')
  }
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  const raw = headers.getSetCookie?.() ?? (response.headers.get('set-cookie') === null ? [] : [response.headers.get('set-cookie') as string])
  if (raw.length === 0) throw new LocalScopeError('HOST_AUTH_FAILED', 'local discovery: /connect returned no signed cookie')
  const pair = raw[0].split(';', 1)[0].trim()
  if (!COOKIE_PAIR.test(pair)) {
    throw new LocalScopeError('HOST_AUTH_FAILED', 'local discovery: /connect returned an invalid cookie pair')
  }
  return pair
}

/** Read and compare the authenticated identity echo with the registry. */
export async function readAuthenticatedIdentity(
  record: LocalInstanceRecord,
  cookie: string,
  signal?: AbortSignal,
): Promise<LocalInstanceRecord> {
  const response = await authFetch(`${record.origin}/api/pi-tui.local-host`, {
    method: 'GET',
    headers: { cookie },
    redirect: 'manual',
    cache: 'no-store',
  }, signal)
  if (response.status === 401 || response.status === 403) {
    await discard(response)
    throw new LocalScopeError('HOST_AUTH_FAILED', 'local discovery: the identity route rejected the signed cookie')
  }
  if (response.status !== 200) {
    await discard(response)
    throw new LocalScopeError('HOST_UNRESPONSIVE', `local discovery: identity route answered HTTP ${String(response.status)}`)
  }
  const contentType = response.headers.get('content-type') ?? ''
  const cacheControl = response.headers.get('cache-control') ?? ''
  if (!/^application\/json\b/iu.test(contentType) || !/\bno-store\b/iu.test(cacheControl)) {
    await discard(response)
    throw new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local discovery: identity route response has the wrong shape')
  }
  const text = await readBoundedText(response, MAX_REGISTRY_BYTES, 'identity route response')
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch (error) {
    throw new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local discovery: identity route response is not JSON', error)
  }
  const identity = parseRecord(value, record)
  if (!sameLocalInstanceRecord(identity, record)) {
    throw new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local discovery: authenticated identity differs from the registry')
  }
  return identity
}

/**
 * Re-read the live kernel identity of the recorded Host and require it to be
 * the SAME process. Linux uses the frozen `/proc` starttime; Darwin uses the
 * complete PR-1 identity. `unknown` is always `PROCESS_STARTTIME_UNAVAILABLE`;
 * a different/absent process is `HOST_IDENTITY_MISMATCH` (never a kill permit).
 */
export function assertRecordedHostKernelIdentityCurrent(
  record: LocalInstanceRecord,
  readKernel: (pid: number) => KernelObservation = readKernelProcess,
): void {
  assertRecordSchemaPlatform(record)
  if (record.schema === 2) {
    const observed = readKernel(record.hostPid)
    if (observed.kind === 'unknown') {
      throw new LocalScopeError('PROCESS_STARTTIME_UNAVAILABLE', 'local discovery: the Host kernel identity is unavailable')
    }
    if (sameKernelProcess(record.hostKernelIdentity, observed) !== 'same') {
      throw new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local discovery: the Host PID is no longer the recorded process')
    }
    return
  }
  const liveStarttime = readProcessStarttime(record.hostPid)
  if (liveStarttime === undefined) {
    throw new LocalScopeError('PROCESS_STARTTIME_UNAVAILABLE', 'local discovery: the Host process starttime is unavailable')
  }
  if (liveStarttime !== record.hostStarttime) {
    throw new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local discovery: the Host PID is no longer the registry process')
  }
}

/**
 * Read the identity material THIS Host process publishes for its own
 * platform. The kernel fact is captured here and re-proved before Ready; it is
 * never inferred from a path, a registry file or a bare numeric pid.
 */
export function readHostProcessIdentity(pid: number = process.pid): HostProcessIdentity {
  if (process.platform === 'linux') {
    return { schema: 1, hostStarttime: readLinuxStarttime(pid) }
  }
  if (process.platform === 'darwin') {
    const observed = readKernelProcess(pid)
    if (observed.kind !== 'alive' || observed.identity.platform !== 'darwin') {
      throw new LocalScopeError('PROCESS_STARTTIME_UNAVAILABLE', 'local discovery: the Host kernel identity is unavailable')
    }
    return { schema: 2, hostKernelIdentity: observed.identity }
  }
  throw new LocalScopeError(
    'B1_PLATFORM_UNSUPPORTED',
    `local discovery: no Host process identity is implemented for ${process.platform}`,
  )
}

/**
 * Run the full authenticated handshake: launch material, official `/connect`
 * cookie, identity echo, then a fresh kernel identity check. The returned
 * cookie stays in this Client process only.
 */
export async function authenticateLocalHost(
  record: LocalInstanceRecord,
  scope: LocalScope,
  signal?: AbortSignal,
): Promise<VerifiedLocalHost> {
  const launch = readLaunchMaterial(scope, record)
  const cookie = await connectForCookie(record, launch, signal)
  const identity = await readAuthenticatedIdentity(record, cookie, signal)
  signal?.throwIfAborted()
  assertRecordedHostKernelIdentityCurrent(identity)
  return { record, cookie, identity }
}

/** Bound the registry wait without a fixed readiness sleep. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Ensure one authenticated Host for this scope. A live registry candidate is
 * never killed and never replaced; a dead one may be replaced by a new Host
 * whose kernel seat is the only winner. Authentication failure is terminal.
 */
export async function ensureLocalHost(options: EnsureLocalHostOptions): Promise<VerifiedLocalHost> {
  const { scope } = options
  if (options.expectedInstanceId !== undefined) {
    // A Client handoff carries one already-authenticated Host identity. Any
    // absent/dead/replaced candidate is a terminal refusal reached BEFORE the
    // ordinary spawn path: a handoff never creates, replaces or kills a Host.
    const record = readLocalRecord(scope)
    if (record === undefined || inspectHostProcess(record) === 'dead') {
      throw new LocalScopeError(
        'HOST_HANDOFF_UNAVAILABLE',
        'local discovery: the expected Host is no longer available for Client handoff',
      )
    }
    if (record.instanceId !== options.expectedInstanceId) {
      throw new LocalScopeError(
        'HOST_IDENTITY_MISMATCH',
        'local discovery: the live Host is not the expected handoff instance',
      )
    }
    assertClientHostCompatible(record, scope)
    return await authenticateLocalHost(record, scope, options.signal)
  }
  const existing = readLocalRecord(scope)
  if (existing !== undefined && inspectHostProcess(existing) === 'alive') {
    assertClientHostCompatible(existing, scope)
    return await authenticateLocalHost(existing, scope, options.signal)
  }

  const spawnFailure = options.hostStartPolicy === 'public-managed'
    ? await startManagedHostCandidate(options)
    : spawnHostCandidate(options)
  const deadline = Date.now() + REGISTRY_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    options.signal?.throwIfAborted()
    const failure = spawnFailure()
    if (failure !== undefined) {
      throw new LocalScopeError('HOST_START_FAILED', 'local discovery: the Host candidate failed to start', failure)
    }
    const candidate = readLocalRecord(scope)
    if (candidate !== undefined && inspectHostProcess(candidate) === 'alive') {
      assertClientHostCompatible(candidate, scope)
      return await authenticateLocalHost(candidate, scope, options.signal)
    }
    await delay(REGISTRY_POLL_INTERVAL_MS)
  }
  throw new LocalScopeError('HOST_START_TIMEOUT', `local discovery: no ready Host registry appeared within ${String(REGISTRY_WAIT_TIMEOUT_MS / 1000)}s`)
}

/** Write one 0600 file through an exclusively-created same-directory temp file. */
function writePrivateJsonFile(path: string, value: unknown): void {
  const text = `${JSON.stringify(value)}\n`
  const temp = join(dirname(path), `.${basename(path)}.${String(process.pid)}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    fchmodSync(fd, 0o600)
    writeFileSync(fd, text, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(temp, path)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temp) } catch { /* the temp file may not exist */ }
    if (error instanceof LocalScopeError) throw error
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', `local discovery: ${basename(path)} could not be written atomically`, error)
  }
}

/** Publish the one registry record; the Host calls this as its Ready commit. */
export function writeLocalRecord(scope: LocalScope, record: LocalInstanceRecord): void {
  const parsed = parseRecord(record, scope)
  assertHostPublicationIdentity(parsed, scope)
  writePrivateJsonFile(join(scope.dir, REGISTRY_FILE), parsed)
}

/** Publish the official launch material before the registry is visible. */
export function writeLaunchMaterial(
  scope: LocalScope,
  record: LocalInstanceRecord,
  material: LocalLaunchMaterial,
): void {
  const parsed = parseRecord(record, scope)
  assertHostPublicationIdentity(parsed, scope)
  if (material.schema !== 1 || material.instanceId !== parsed.instanceId) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: launch material does not name the published instance')
  }
  assertConnectUrl(material.connectUrl, parsed)
  writePrivateJsonFile(join(scope.dir, LAUNCH_FILE), material)
}

/**
 * Remove only the files this exact instance published. Used after the official
 * shutdown owner has run and as a synchronous process-exit backstop; a new
 * Host instance's files are never touched.
 */
export function cleanupOwnedFiles(scope: LocalScope, instanceId: string): void {
  for (const file of [REGISTRY_FILE, LAUNCH_FILE]) {
    const path = join(scope.dir, file)
    try {
      const value = JSON.parse(readFileSync(path, 'utf8')) as { readonly instanceId?: unknown }
      if (value.instanceId === instanceId) unlinkSync(path)
    } catch {
      // Missing/unreadable/foreign files are not this instance's to remove.
    }
  }
}
