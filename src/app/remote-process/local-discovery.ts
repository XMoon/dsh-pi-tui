/**
 * M4-B1 local Host discovery and official authentication.
 *
 * The registry is an unauthenticated hint: it selects a candidate origin and
 * PID, while the only readiness proof is the official `/connect` launch-token
 * exchange followed by the authenticated identity Fetch route. This module
 * never creates a Host Context, a Session, an Agent or a second transport
 * authority, and it never removes another process's files.
 *
 * @module app/remote-process/local-discovery
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
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
  readProcessStarttime,
  removeOwnedScratch,
  type LocalScope,
} from './local-scope.ts'

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

/** One published Host identity record (no secret material). */
export interface LocalInstanceRecord {
  readonly schema: 1
  readonly scopeId: string
  readonly profileRealpath: string
  readonly instanceId: string
  readonly hostPid: number
  readonly hostStarttime: string
  readonly origin: string
  readonly protocol: typeof LOCAL_PROTOCOL
  readonly bundleVersion: string
  readonly dshVersion: string
  readonly buildId: string
}

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
}

/** Exact registry keys; unknown fields are rejected, not ignored. */
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

/** Exact launch-material keys. */
const LAUNCH_KEYS = ['schema', 'instanceId', 'connectUrl'] as const

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const HEX_64 = /^[0-9a-f]{64}$/u
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

/** The two scope facts a record must echo; the build facts are judged separately. */
interface RecordScope {
  readonly scopeId: string
  readonly profileRealpath: string
}

/** Parse the strict registry schema without judging build compatibility. */
function parseRecord(value: unknown, scope: RecordScope): LocalInstanceRecord {
  const record = assertExactObject(value, RECORD_KEYS, 'registry')
  if (record.schema !== 1) throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.schema must be 1')
  const scopeId = requireString(record, 'scopeId', 'registry')
  const profileRealpath = requireString(record, 'profileRealpath', 'registry')
  const instanceId = requireString(record, 'instanceId', 'registry')
  const hostStarttime = requireString(record, 'hostStarttime', 'registry')
  const origin = requireString(record, 'origin', 'registry')
  const protocol = requireString(record, 'protocol', 'registry')
  const bundleVersion = requireString(record, 'bundleVersion', 'registry')
  const dshVersion = requireString(record, 'dshVersion', 'registry')
  const buildId = requireString(record, 'buildId', 'registry')
  const hostPid = record.hostPid
  if (typeof hostPid !== 'number' || !Number.isSafeInteger(hostPid) || hostPid < 1) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.hostPid must be a positive integer')
  }
  if (!UUID_PATTERN.test(instanceId)) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.instanceId must be a UUID')
  }
  if (!/^\d+$/u.test(hostStarttime)) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.hostStarttime must be numeric')
  }
  if (!HEX_64.test(buildId)) {
    throw new LocalScopeError('LOCAL_FILE_UNSAFE', 'local discovery: registry.buildId must be 64 hex characters')
  }
  assertLoopbackOrigin(origin)
  if (scopeId !== scope.scopeId || profileRealpath !== scope.profileRealpath) {
    throw new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local discovery: registry names another profile scope')
  }
  return {
    schema: 1,
    scopeId,
    profileRealpath,
    instanceId,
    hostPid,
    hostStarttime,
    origin,
    protocol: protocol as typeof LOCAL_PROTOCOL,
    bundleVersion,
    dshVersion,
    buildId,
  }
}

/** Throw unless the candidate speaks this Client's exact protocol and build. */
export function assertBuildCompatible(record: LocalInstanceRecord, scope: LocalScope): void {
  if (
    record.protocol !== LOCAL_PROTOCOL
    || record.bundleVersion !== scope.bundleVersion
    || record.dshVersion !== scope.dshVersion
    || record.buildId !== scope.buildId
  ) {
    throw new LocalScopeError(
      'HOST_BUILD_INCOMPATIBLE',
      'local discovery: the live Host was built from a different package payload or protocol',
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
export function inspectHostProcess(record: LocalInstanceRecord, procRoot = '/proc'): 'alive' | 'dead' {
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
async function authFetch(url: string | URL, init: LocalRequestInit): Promise<Response> {
  const request: LocalRequestInit = { ...init, signal: AbortSignal.timeout(AUTH_REQUEST_TIMEOUT_MS) }
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
): Promise<string> {
  const url = new URL(launch.connectUrl)
  url.searchParams.set('interactions', 'answer')
  const response = await authFetch(url, { method: 'GET', redirect: 'manual', cache: 'no-store' })
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
): Promise<LocalInstanceRecord> {
  const response = await authFetch(`${record.origin}/api/pi-tui.local-host`, {
    method: 'GET',
    headers: { cookie },
    redirect: 'manual',
    cache: 'no-store',
  })
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
  for (const key of RECORD_KEYS) {
    if (identity[key] !== record[key]) {
      throw new LocalScopeError('HOST_IDENTITY_MISMATCH', `local discovery: authenticated identity differs from the registry at ${key}`)
    }
  }
  return identity
}

/**
 * Run the full authenticated handshake: launch material, official `/connect`
 * cookie, identity echo, then a fresh kernel starttime check. The returned
 * cookie stays in this Client process only.
 */
export async function authenticateLocalHost(
  record: LocalInstanceRecord,
  scope: LocalScope,
): Promise<VerifiedLocalHost> {
  const launch = readLaunchMaterial(scope, record)
  const cookie = await connectForCookie(record, launch)
  const identity = await readAuthenticatedIdentity(record, cookie)
  const liveStarttime = readProcessStarttime(identity.hostPid)
  if (liveStarttime === undefined) {
    throw new LocalScopeError('PROCESS_STARTTIME_UNAVAILABLE', 'local discovery: the authenticated Host process starttime is unavailable')
  }
  if (liveStarttime !== identity.hostStarttime) {
    throw new LocalScopeError('HOST_IDENTITY_MISMATCH', 'local discovery: the authenticated Host PID is no longer the registry process')
  }
  return { record, cookie, identity }
}

/** Bound the registry wait without a fixed readiness sleep. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Start one Host candidate; the Host's own OS seat decides the winner. */
function spawnHostCandidate(options: EnsureLocalHostOptions): () => Error | undefined {
  let info
  try {
    info = lstatSync(options.hostEntryPath)
  } catch (error) {
    throw new LocalScopeError('HOST_START_FAILED', 'local discovery: the installed Host entry is not readable', error)
  }
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.()) {
    throw new LocalScopeError('HOST_START_FAILED', 'local discovery: the installed Host entry must be a regular file owned by this uid')
  }
  const logPath = join(options.scope.dir, 'host.log')
  let fd: number | undefined
  let scratch: string | undefined
  try {
    fd = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    fchmodSync(fd, 0o600)
    scratch = mkdtempSync(join(options.scope.dir, 'host-scratch-'))
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SPLIT_PROCESS_DSH_ANCHOR: options.dshAnchor,
      SPLIT_PROCESS_PROFILE: options.profile,
      SPLIT_PROCESS_SCRATCH: scratch,
    }
    delete env.SPLIT_PROCESS_EXTRA_PATCH
    delete env.DSH_PI_TUI_ROLE
    delete env.DSH_PI_TUI_HOST_ENTRY
    const child = spawn(process.execPath, [options.hostEntryPath], {
      cwd: options.scope.profileRealpath,
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
    })
    let spawnFailure: Error | undefined
    child.once('error', error => {
      spawnFailure = error
      if (scratch !== undefined) removeOwnedScratch(options.scope.dir, scratch)
    })
    child.unref()
    return () => spawnFailure
  } catch (error) {
    if (error instanceof LocalScopeError) throw error
    throw new LocalScopeError('HOST_START_FAILED', 'local discovery: the Host candidate could not be spawned', error)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Ensure one authenticated Host for this scope. A live registry candidate is
 * never killed and never replaced; a dead one may be replaced by a new Host
 * whose kernel seat is the only winner. Authentication failure is terminal.
 */
export async function ensureLocalHost(options: EnsureLocalHostOptions): Promise<VerifiedLocalHost> {
  const { scope } = options
  const existing = readLocalRecord(scope)
  if (existing !== undefined && inspectHostProcess(existing) === 'alive') {
    assertBuildCompatible(existing, scope)
    return await authenticateLocalHost(existing, scope)
  }

  const spawnFailure = spawnHostCandidate(options)
  const deadline = Date.now() + REGISTRY_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const failure = spawnFailure()
    if (failure !== undefined) {
      throw new LocalScopeError('HOST_START_FAILED', 'local discovery: the Host candidate failed to start', failure)
    }
    const candidate = readLocalRecord(scope)
    if (candidate !== undefined && inspectHostProcess(candidate) === 'alive') {
      assertBuildCompatible(candidate, scope)
      return await authenticateLocalHost(candidate, scope)
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
  assertBuildCompatible(parsed, scope)
  writePrivateJsonFile(join(scope.dir, REGISTRY_FILE), parsed)
}

/** Publish the official launch material before the registry is visible. */
export function writeLaunchMaterial(
  scope: LocalScope,
  record: LocalInstanceRecord,
  material: LocalLaunchMaterial,
): void {
  const parsed = parseRecord(record, scope)
  assertBuildCompatible(parsed, scope)
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
