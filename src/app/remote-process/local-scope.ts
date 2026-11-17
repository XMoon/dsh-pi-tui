/**
 * Local Host/Client scope, process seats and installed-build identity.
 *
 * The ordinary DSH profile is the scope authority: this module derives a
 * stable id from the canonical profile directory and the current UID, then
 * owns the private run directory, the Host Singleton seat and the
 * qualification-only Client seat. The installed-build fingerprint remains the
 * Host's own publication/identity material; `LOCAL_PROTOCOL` below is the
 * Host/Client compatibility contract and is independent of package builds.
 *
 * The abstract sockets are admission primitives only. No business traffic
 * travels over them, and no PID file, registry record or `O_EXCL` marker can
 * substitute for the kernel's exclusive bind.
 *
 * @module app/remote-process/local-scope
 */

import { createHash } from 'node:crypto'
import { readKernelProcess, readProcessStarttime } from '../../runtime/native-process/identity.ts'
import { runSyncDisposalStepsWithPrimary } from '../../runtime/process/disposal.ts'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { Buffer } from 'node:buffer'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The required local Host/Client wire contract, independent of package builds.
 * Both sides must name exactly this value and the same DSH runtime version.
 */
export const LOCAL_PROTOCOL = 'dsh-pi-tui/local/1'

/** Private scope directory below the official DSH home. */
const RUN_ROOT_NAME = 'run'
const SCOPE_ROOT_NAME = 'dsh-pi-tui'

/** Linux abstract-socket prefixes; both names stay well below `sun_path`. The
 *  Host prefix is the singleton admission seat; the Client prefix is held by
 *  the frozen `qualification` mode only. */
const HOST_SEAT_PREFIX = '\0dsh-pi-tui-h-'
const CLIENT_SEAT_PREFIX = '\0dsh-pi-tui-c-'

/**
 * Fixed local Host/Client failure codes. The qualification harness asserts
 * these strings, so they are part of the internal contract.
 */
export type LocalScopeErrorCode =
  | 'B1_PLATFORM_UNSUPPORTED'
  | 'SCOPE_DIRECTORY_UNSAFE'
  | 'LOCAL_FILE_UNSAFE'
  | 'HOST_ALREADY_OWNED'
  | 'CLIENT_ALREADY_ACTIVE'
  | 'HOST_PROTOCOL_INCOMPATIBLE'
  | 'HOST_BUILD_INCOMPATIBLE'
  | 'HOST_IDENTITY_MISMATCH'
  | 'HOST_HANDOFF_UNAVAILABLE'
  | 'HOST_UNRESPONSIVE'
  | 'HOST_AUTH_FAILED'
  | 'HOST_START_TIMEOUT'
  | 'HOST_START_FAILED'
  | 'HOST_MANAGER_ERROR'
  | 'HOST_MANAGER_UNIT_CONFLICT'
  | 'HOST_MANAGER_START_FAILED'
  | 'HOST_STOP_TIMEOUT'
  | 'DAEMON_CONTROL_BUSY'
  | 'PROCESS_STARTTIME_UNAVAILABLE'

/** A failure that carries one stable B1 classification code. */
export class LocalScopeError extends Error {
  /** Stable classification asserted by callers and the qualification lane. */
  readonly code: LocalScopeErrorCode

  constructor(code: LocalScopeErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LocalScopeError'
    this.code = code
  }
}

/** The installed-profile facts the caller resolves through official DSH APIs. */
export interface InstalledProfileFacts {
  /** Canonical official DSH home (`resolveDshHome()` result). */
  readonly dshHome: string
  /** Official profile directory (`resolveProfileDir()` result). */
  readonly profileDir: string
  /** Installed `@xmoon76/dsh-pi-tui` package root. */
  readonly packageRoot: string
  /** Installed `@deepseek-ai/dsh` package version. */
  readonly dshVersion: string
}

/** The one B1 scope shared by the Host and every Client of this profile. */
export interface LocalScope {
  /** sha256 over UID + canonical profile directory. */
  readonly scopeId: string
  /**
   * The canonical official DSH home (`resolveDshHome()` result) the private run
   * directory lives under. It is the already-resolved official fact, never
   * derived from `scope.dir` or a Client cwd; the managed Host unit needs it to
   * set a truthful `DSH_HOME`.
   */
  readonly dshHome: string
  /** Canonical profile directory the scope belongs to. */
  readonly profileRealpath: string
  /** Private 0700 run directory. */
  readonly dir: string
  /** Linux abstract Host claim name. */
  readonly hostSocketName: string
  /** Linux abstract qualification-only Client seat name; `surface` and `peer`
   *  Clients never bind it. */
  readonly clientSeatSocketName: string
  /**
   * Installed-build fingerprint described below. The Host publishes and the
   * authenticated identity echoes it; Client admission does not compare it.
   */
  readonly buildId: string
  /** Installed bundle version from the package manifest. */
  readonly bundleVersion: string
  /** Installed DSH runtime version. */
  readonly dshVersion: string
}

/** One held process seat; closing it releases the kernel claim. */
export interface ProcessSeat {
  /**
   * Prove the ONE kernel claim this seat represents is still the holder. The
   * Host calls this at startup and again before publishing its registry/Ready
   * fact: a seat whose file was replaced, linked, re-permissioned or moved is
   * no longer ownership, so the caller must stop instead of continuing.
   */
  assertCurrent(): void
  /** Release the kernel claim. Idempotent; never removes a foreign file. */
  close(): Promise<void>
}

/** The three independent Darwin seat purposes. Each purpose owns its own
 * deterministic file in the private per-profile scope directory, so a
 * qualification Client or a short-lived daemon-control claim can never
 * conflict with the Host Singleton (and a real surface Client holds none). */
export type ProcessSeatKind = 'host' | 'qualification-client' | 'admin'

/** The no-op seat for a caller that holds no kernel claim (every real
 * `surface` Client): nothing is held, so nothing can be lost or asserted. */
export const NO_PROCESS_SEAT: ProcessSeat = Object.freeze({
  assertCurrent: () => {},
  close: async () => {},
})

/** Darwin numeric `open(2)` flags: O_RDWR|O_CREAT|O_EXLOCK|O_NONBLOCK|
 * O_NOFOLLOW|O_CLOEXEC = 16778022 on the qualified macOS ABI (Q0: the values
 * come from the real SDK headers, not from a portable guess). */
const DARWIN_SEAT_FLAGS = 2 | 512 | 32 | 4 | 256 | 16777216
/** A seat file is created 0600; an EXISTING file must already be exactly this. */
const DARWIN_SEAT_FILE_MODE = 0o600

/** Fail before any runtime file is written on a platform the seat does not
 * implement. */
function assertDarwin(): number {
  if (process.platform !== 'darwin' || typeof process.getuid !== 'function') {
    throw new LocalScopeError(
      'B1_PLATFORM_UNSUPPORTED',
      'local scope: file-backed kernel seats require Darwin',
    )
  }
  return process.getuid()
}

/** The ONE deterministic seat-file path per scope and purpose. */
export function processSeatPath(scopeDir: string, scopeId: string, kind: ProcessSeatKind): string {
  return join(scopeDir, `seat-${kind}-${scopeId}.lock`)
}

/** Validate one already-claimed seat file: a real regular file, owned by this
 * user, readable/writable by this user ONLY, with exactly one link. */
function assertSeatFileSafe(path: string, uid: number): void {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: seat ${path} is not accessible`, error)
  }
  if (info.isSymbolicLink()) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: seat ${path} must not be a symlink`)
  }
  if (!info.isFile()) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: seat ${path} must be a regular file`)
  }
  if (info.uid !== uid || (info.mode & 0o777) !== DARWIN_SEAT_FILE_MODE) {
    // Never "fix" an existing file with chmod: a mode this process did not
    // create is not ownership, it is a foreign file that must be refused.
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: seat ${path} must be owned by uid ${String(uid)} with mode 0600`)
  }
  if (info.nlink !== 1) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: seat ${path} must have exactly one link`)
  }
}

/** Validate the private 0700 directory the seat file lives in. */
function assertSeatDirectorySafe(dir: string, uid: number): { readonly dev: number; readonly ino: number } {
  let info
  try {
    info = lstatSync(dir)
  } catch (error) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: seat directory ${dir} is not accessible`, error)
  }
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid || (info.mode & 0o077) !== 0) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: seat directory ${dir} must be a real uid-${String(uid)} directory without group/other access`)
  }
  return { dev: info.dev, ino: info.ino }
}

/**
 * One held Darwin kernel seat: the kernel's exclusive `O_EXLOCK` claim on one
 * fixed inode, kept for the whole lifetime of the owning process. The FD is
 * close-on-exec, so a spawned child never inherits the Host's claim.
 */
class DarwinKernelSeat implements ProcessSeat {
  private fd: number | undefined
  private readonly path: string
  private readonly dir: string
  private readonly uid: number
  private readonly dirDev: number
  private readonly dirIno: number

  constructor(fd: number, path: string, dir: string, uid: number, dirIdentity: { readonly dev: number; readonly ino: number }) {
    this.fd = fd
    this.path = path
    this.dir = dir
    this.uid = uid
    this.dirDev = dirIdentity.dev
    this.dirIno = dirIdentity.ino
  }

  /** Re-prove the directory, the path and the held FD still name ONE inode
   * owned by this user. Called right after the claim and before Ready. */
  assertCurrent(): void {
    if (this.fd === undefined) {
      throw new LocalScopeError('HOST_IDENTITY_MISMATCH', `local scope: seat ${this.path} was already closed`)
    }
    const directory = assertSeatDirectorySafe(this.dir, this.uid)
    if (directory.dev !== this.dirDev || directory.ino !== this.dirIno) {
      throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: seat directory ${this.dir} was replaced`)
    }
    assertSeatFileSafe(this.path, this.uid)
    const held = fstatSync(this.fd)
    const pathInfo = lstatSync(this.path)
    if (held.dev !== pathInfo.dev
      || held.ino !== pathInfo.ino
      || held.uid !== pathInfo.uid
      || (held.mode & 0o777) !== (pathInfo.mode & 0o777)
      || held.nlink !== pathInfo.nlink) {
      // The path no longer names the inode this FD holds: unlink/recreate (or a
      // rename) produced a double owner. Refuse further use; the holder must
      // stop and let PR-2's admission handle the split-brain.
      throw new LocalScopeError('HOST_IDENTITY_MISMATCH', `local scope: seat ${this.path} no longer matches the held inode`)
    }
  }

  /**
   * Release the held descriptor synchronously. Idempotent: the FD is cleared
   * FIRST, so a throwing close can never leave a stale descriptor for a second
   * close, and an unpublished seat's rollback can run without a promise.
   */
  releaseSync(): void {
    const fd = this.fd
    if (fd === undefined) return
    this.fd = undefined
    closeSync(fd)
  }

  async close(): Promise<void> {
    this.releaseSync()
  }
}

/** Claim one Darwin seat file. `EAGAIN`/`EWOULDBLOCK` means another process of
 * this scope already holds this purpose; every other open failure is real and
 * is reported as-is (never re-labelled "already owned"). */
export async function bindDarwinKernelSeat(scopeDir: string, scopeId: string, kind: ProcessSeatKind, conflictCode: ProcessSeatConflictCode): Promise<ProcessSeat> {
  const uid = assertDarwin()
  const dirIdentity = assertSeatDirectorySafe(scopeDir, uid)
  const path = processSeatPath(scopeDir, scopeId, kind)
  // An existing seat file is validated BEFORE the open: O_CREAT must never
  // "repair" a symlink, hardlink or over-permissive file in place.
  let existing = true
  try {
    lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: seat ${path} is not accessible`, error)
    }
    existing = false
  }
  if (existing) assertSeatFileSafe(path, uid)
  let fd: number
  try {
    fd = openSync(path, DARWIN_SEAT_FLAGS, DARWIN_SEAT_FILE_MODE)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EAGAIN' || code === 'EWOULDBLOCK') {
      throw new LocalScopeError(conflictCode, `local scope: the ${kind} seat of this profile is already held by another live process`, error)
    }
    throw error
  }
  const seat = new DarwinKernelSeat(fd, path, scopeDir, uid, dirIdentity)
  try {
    seat.assertCurrent()
  } catch (error) {
    // A failed post-open proof must release the claim it just took. This is a
    // PRIMARY-failure rollback, so it runs synchronously through the owning
    // disposal primitive: the proof failure is never replaced by a release
    // failure, and no fire-and-forget promise is discarded.
    runSyncDisposalStepsWithPrimary('release unproven Darwin seat', error, [() => seat.releaseSync()])
  }
  return seat
}

/** Fail before any runtime file is written on a platform B1 does not implement. */
function assertLinux(): number {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
    throw new LocalScopeError(
      'B1_PLATFORM_UNSUPPORTED',
      'local B1 split process requires Linux abstract AF_UNIX sockets',
    )
  }
  return process.getuid()
}

/** The profile scope itself is OS-neutral POSIX state: the canonical official
 *  DSH home/profile directory object plus the current UID. Linux and Darwin
 *  both derive the same hash domain and private 0700 run directory; only the
 *  kernel CLAIM below differs per platform. */
function assertSupportedPosixScopePlatform(): number {
  if ((process.platform !== 'linux' && process.platform !== 'darwin') || typeof process.getuid !== 'function') {
    throw new LocalScopeError(
      'B1_PLATFORM_UNSUPPORTED',
      `local scope: the local split backend requires Linux or macOS (this is ${process.platform})`,
    )
  }
  return process.getuid()
}

/** Read a real directory and reject a non-directory or a different owner. */
function canonicalOwnedDirectory(path: string, uid: number, label: string): string {
  let real: string
  try {
    real = realpathSync(path)
  } catch (error) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: ${label} is not a readable directory`, error)
  }
  const info = lstatSync(real)
  if (!info.isDirectory() || info.uid !== uid) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: ${label} must be a real directory owned by uid ${String(uid)}`)
  }
  return real
}

/**
 * Create and prove one directory component WITHOUT following a pre-existing
 * symlink. Each component is lstat-checked before its child is created. A
 * `privateMode` component must have no group/other access at all (0700); an
 * inherited account-level parent may be readable but never group/other
 * writable, because only its owner may create the private chain below it.
 */
function ensureOwnedDirectory(path: string, uid: number, privateMode: boolean): void {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: ${path} is not accessible`, error)
    }
    // The parent was already proved (or is the canonical base directory); a
    // non-recursive mkdir cannot traverse a symlink for this component. A
    // concurrent first start may win the mkdir with EEXIST; that is not an
    // unsafe path, so re-read and validate the winner's directory instead of
    // turning a normal kernel-seat race into SCOPE_DIRECTORY_UNSAFE.
    try {
      mkdirSync(path, { mode: 0o700 })
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: ${path} could not be created safely`, mkdirError)
      }
    }
    try {
      info = lstatSync(path)
    } catch (lstatError) {
      throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: ${path} is not accessible after creation`, lstatError)
    }
  }
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: ${path} must be a real directory owned by uid ${String(uid)}`)
  }
  const forbiddenMode = privateMode ? 0o077 : 0o022
  if ((info.mode & forbiddenMode) !== 0) {
    throw new LocalScopeError(
      'SCOPE_DIRECTORY_UNSAFE',
      privateMode
        ? `local scope: ${path} must not be readable or writable by group/other`
        : `local scope: ${path} must not be writable by group/other`,
    )
  }
}

function ensureScopeDirectory(dshHome: string, scopeId: string, uid: number): string {
  const runRoot = join(dshHome, RUN_ROOT_NAME)
  const scopeRoot = join(runRoot, SCOPE_ROOT_NAME)
  const dir = join(scopeRoot, scopeId)
  for (const path of [runRoot, scopeRoot, dir]) ensureOwnedDirectory(path, uid, true)
  return dir
}

/**
 * The per-UID Darwin Host seat directory. The local Host singleton must not
 * depend on which DSH_HOME resolved the profile, so the Host seat lives under
 * the OS ACCOUNT home (`os.userInfo().homedir`, never `$HOME`/`DSH_HOME`/
 * `$TMPDIR`), keyed only by the scope id. The qualification-only Client seat
 * remains in the per-DSH-home scope directory.
 */
export function darwinHostProfileSeatDir(scopeId: string, accountHome?: string): string {
  const uid = assertDarwin()
  const home = accountHome === undefined
    ? resolveDarwinAccountHome(uid)
    : canonicalOwnedDirectory(accountHome, uid, 'Darwin test account home')
  // `~/.dsh-pi-tui` may already exist as the user's 0755 theme/config
  // directory. It is safe as the account-level parent as long as it is a real
  // uid-owned directory that group/other cannot WRITE; the `run` chain and the
  // per-scope seat directory below it are created strictly 0700.
  const root = join(home, '.dsh-pi-tui')
  ensureOwnedDirectory(root, uid, false)
  const run = join(root, RUN_ROOT_NAME)
  ensureOwnedDirectory(run, uid, true)
  const dir = join(run, scopeId)
  ensureOwnedDirectory(dir, uid, true)
  return dir
}

/** Resolve the REAL account home for the effective UID. */
function resolveDarwinAccountHome(uid: number): string {
  let home: string
  try {
    const info = userInfo()
    if (info.uid !== uid) {
      throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'local scope: the OS account uid does not match this process uid')
    }
    home = info.homedir
  } catch (error) {
    if (error instanceof LocalScopeError) throw error
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'local scope: the OS account home is unavailable', error)
  }
  return canonicalOwnedDirectory(home, uid, 'Darwin account home')
}

/** Resolve the installed package root from this built entry's own URL. */
export function installedPackageRootFromEntry(entryUrl: string): string {
  const root = realpathSync(dirname(dirname(fileURLToPath(entryUrl))))
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch (error) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'local scope: this entry is not running from an installed package root', error)
  }
  if (manifest === null || typeof manifest !== 'object' || (manifest as { readonly name?: unknown }).name !== '@xmoon76/dsh-pi-tui') {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'local scope: this entry is not running from an installed @xmoon76/dsh-pi-tui package')
  }
  return root
}

/** Read the installed DSH version from the launcher's package anchor. */
export function readInstalledDshVersion(dshAnchor: string): string {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(realpathSync(dshAnchor), 'utf8'))
  } catch (error) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'local scope: the installed DSH manifest is unreadable', error)
  }
  const version = manifest === null || typeof manifest !== 'object' ? undefined : (manifest as { readonly version?: unknown }).version
  if (typeof version !== 'string' || version === '') {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'local scope: the installed DSH manifest has no version')
  }
  return version
}

/** Read and validate the installed bundle manifest. */
function readBundleVersion(packageRoot: string): string {
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  } catch (error) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'local scope: the installed package manifest is unreadable', error)
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'local scope: the installed package manifest is not an object')
  }
  const record = manifest as Record<string, unknown>
  if (record.name !== '@xmoon76/dsh-pi-tui' || typeof record.version !== 'string' || record.version === '') {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'local scope: the installed package manifest is not @xmoon76/dsh-pi-tui')
  }
  return record.version
}

/** Every regular `.mjs` file below `dist`, sorted by UTF-8 bytes. */
function listInstalledDistFiles(packageRoot: string): readonly string[] {
  const distDir = join(packageRoot, 'dist')
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: installed payload contains a symlink: ${path}`)
      }
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile()) {
        throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: installed payload contains a non-file: ${path}`)
      }
      if (entry.name.endsWith('.mjs')) files.push(relative(packageRoot, path).split(sep).join('/'))
    }
  }
  walk(distDir)
  files.sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
  return files
}

/**
 * Fingerprint the actual installed payload. Every regular `dist/**` `.mjs`
 * contributes `relative-posix-name NUL sha256(content) LF` in UTF-8 byte
 * order; the bundle and DSH versions close the stream. The value is computed
 * once by the Host at startup and once by each Client from its own install.
 */
export function computeBuildId(packageRoot: string, dshVersion: string): string {
  if (dshVersion === '') throw new Error('local scope: the installed DSH version must not be empty')
  const hash = createHash('sha256')
  for (const relativeName of listInstalledDistFiles(packageRoot)) {
    const content = readFileSync(join(packageRoot, ...relativeName.split('/')))
    hash.update(relativeName)
    hash.update('\0')
    hash.update(createHash('sha256').update(content).digest('hex'))
    hash.update('\n')
  }
  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
    readonly name: string
    readonly version: string
  }
  hash.update('package.json\0')
  hash.update(manifest.name)
  hash.update('\0')
  hash.update(manifest.version)
  hash.update('\n')
  hash.update('@deepseek-ai/dsh\0')
  hash.update(dshVersion)
  hash.update('\n')
  return hash.digest('hex')
}

/**
 * Compute the READ-ONLY identity of one installed profile scope. The caller
 * supplies the official DSH home/profile resolution results; this module never
 * guesses a path. This function performs NO filesystem mutation: it does not
 * `mkdir`, does not touch the registry or a unit, and returns the scope with
 * `dir` as the EXPECTED private run directory path (which may not exist yet).
 * It is the single scope-id authority; `scopeFromInstalledProfile()` composes
 * the exact same computation with the one directory-creation step.
 */
export function inspectInstalledProfileScope(facts: InstalledProfileFacts): LocalScope {
  const uid = assertSupportedPosixScopePlatform()
  const dshHome = canonicalOwnedDirectory(facts.dshHome, uid, 'DSH home')
  const profileRealpath = canonicalOwnedDirectory(facts.profileDir, uid, 'profile directory')
  const bundleVersion = readBundleVersion(facts.packageRoot)
  // Fixed hash domain: the scope id names one canonical profile + uid pair for
  // the local protocol family. It is not a package-build compatibility key. The
  // read-only inspection uses exactly this domain; the mutation form below must
  // never drift from it.
  const scopeId = createHash('sha256')
    .update(`dsh-pi-tui/local-scope/1\0${String(uid)}\0${profileRealpath}`)
    .digest('hex')
  return Object.freeze({
    scopeId,
    dshHome,
    profileRealpath,
    dir: join(dshHome, RUN_ROOT_NAME, SCOPE_ROOT_NAME, scopeId),
    hostSocketName: `${HOST_SEAT_PREFIX}${scopeId.slice(0, 40)}`,
    clientSeatSocketName: `${CLIENT_SEAT_PREFIX}${scopeId.slice(0, 40)}`,
    buildId: computeBuildId(facts.packageRoot, facts.dshVersion),
    bundleVersion,
    dshVersion: facts.dshVersion,
  })
}

/**
 * Build the one scope for an installed profile AND create/prove its private
 * 0700 run directory, before any process seat or Host Context exists. The
 * scope identity comes from the same read-only computation above; only the run
 * directory creation is added here, so Host admission and stdout/qualification
 * shapes stay unchanged.
 */
export function scopeFromInstalledProfile(facts: InstalledProfileFacts): LocalScope {
  const inspected = inspectInstalledProfileScope(facts)
  const uid = assertSupportedPosixScopePlatform()
  const dir = ensureScopeDirectory(inspected.dshHome, inspected.scopeId, uid)
  return Object.freeze({ ...inspected, dir })
}

/**
 * The `/proc/<pid>/stat` parser and best-effort starttime reader moved to the
 * shared kernel-identity seam (`runtime/native-process/identity.ts`), which is
 * now the ONLY owner of that parsing. These re-exports preserve the long-lived
 * local-scope surface (and its external behavior) for existing callers and
 * tests.
 */
export {
  parseProcessStat,
  parseProcessStatStarttime,
  readProcessStarttime,
  type LinuxProcessStat,
} from '../../runtime/native-process/identity.ts'

/**
 * Strict Linux process-start identity. B1 identity comparison never falls
 * back to a bare PID: a missing `/proc` value is a hard failure.
 */
export function readLinuxStarttime(pid: number = process.pid): string {
  assertLinux()
  const value = readProcessStarttime(pid)
  if (value === undefined) {
    throw new LocalScopeError(
      'PROCESS_STARTTIME_UNAVAILABLE',
      `local scope: /proc/${String(pid)}/stat does not expose a starttime`,
    )
  }
  return value
}

/**
 * A qualification-only process-start diagnostic for the CURRENT process. It is
 * never an identity authority: Linux keeps its original `/proc` starttime
 * string, Darwin uses the exact boot-session/unique/start tuple so the value is
 * stable and ABI-safe, and an unverifiable read yields `undefined`.
 */
export function readProcessStartDiagnostic(pid: number = process.pid): string | undefined {
  if (process.platform === 'linux') return readProcessStarttime(pid)
  if (process.platform === 'darwin') {
    const observed = readKernelProcess(pid)
    if (observed.kind !== 'alive' || observed.identity.platform !== 'darwin') return undefined
    const identity = observed.identity
    return `${identity.bootUUID}:${identity.uniqueId}:${identity.startSec}.${identity.startUsec}`
  }
  return undefined
}

/** The stable conflict classification each seat purpose reports. */
type ProcessSeatConflictCode = 'HOST_ALREADY_OWNED' | 'CLIENT_ALREADY_ACTIVE' | 'DAEMON_CONTROL_BUSY'

/**
 * Claim one kernel abstract-socket seat. `EADDRINUSE` means another process
 * of this scope already holds the seat and is the sole winner; any other
 * listen error is a real failure. The Host Singleton, the frozen
 * `qualification` Client and the short-lived daemon-control seat are the live
 * users; a real `surface` Client holds no seat. The returned close is
 * idempotent.
 */
function bindLinuxAbstractSeat(
  name: string,
  conflictCode: ProcessSeatConflictCode,
): Promise<ProcessSeat> {
  if (!name.startsWith('\0')) {
    return Promise.reject(new Error('local scope: process seats require a Linux abstract socket name'))
  }
  return new Promise<ProcessSeat>((resolve, reject) => {
    const server = createServer()
    let settled = false
    let closed: Promise<void> | undefined
    server.once('error', error => {
      if (settled) return
      settled = true
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EADDRINUSE') {
        reject(new LocalScopeError(conflictCode, `local scope: ${name.slice(1)} is already owned by another live process`, error))
        return
      }
      reject(error)
    })
    server.listen(name, () => {
      if (settled) return
      settled = true
      resolve({
        assertCurrent(): void {
          if (!server.listening) {
            throw new LocalScopeError('HOST_IDENTITY_MISMATCH', `local scope: ${name.slice(1)} seat is no longer held`)
          }
        },
        close(): Promise<void> {
          if (closed !== undefined) return closed
          closed = new Promise<void>((resolveClose, rejectClose) => {
            server.close(error => {
              if (error === undefined) resolveClose()
              else rejectClose(error)
            })
          })
          return closed
        },
      })
    })
  })
}

/** One kernel-claim request: the Linux abstract socket name or the Darwin
 * per-purpose file. Both variants are claimed ONLY through {@link bindKernelSeat}
 * so the ProcessSeat contract (idempotent close, currentness proof) has one
 * implementation family and one error taxonomy. */
type KernelSeatClaim =
  | { readonly claim: 'linux-abstract'; readonly name: string }
  | { readonly claim: 'darwin-file'; readonly dir: string; readonly scopeId: string; readonly kind: ProcessSeatKind }

function bindKernelSeat(claim: KernelSeatClaim, conflictCode: ProcessSeatConflictCode): Promise<ProcessSeat> {
  return claim.claim === 'linux-abstract'
    ? bindLinuxAbstractSeat(claim.name, conflictCode)
    : bindDarwinKernelSeat(claim.dir, claim.scopeId, claim.kind, conflictCode)
}

/**
 * Claim one kernel abstract-socket seat. `EADDRINUSE` means another process
 * of this scope already holds the seat and is the sole winner; any other
 * listen error is a real failure. The Host Singleton, the frozen
 * `qualification` Client and the short-lived daemon-control seat are the live
 * users; a real `surface` Client holds no seat. The returned close is
 * idempotent.
 */
export function bindProcessSeat(
  name: string,
  conflictCode: ProcessSeatConflictCode,
): Promise<ProcessSeat> {
  assertLinux()
  return bindKernelSeat({ claim: 'linux-abstract', name }, conflictCode)
}

/**
 * Claim the profile-scoped kernel seat for one Host or qualification-Client
 * purpose. Linux keeps its original abstract-socket binder; Darwin claims the
 * per-purpose `O_EXLOCK` file seat in the same private scope directory. This is
 * the ONLY seat dispatch the Host and the qualification Client use.
 * `bindProcessSeat` remains the Linux abstract binder for the separate
 * daemon-control purpose (PR-3 owns a Darwin admin seat).
 */
export interface ProfileKernelSeatOptions {
  /** Test-only account home; production resolves `os.userInfo().homedir`. */
  readonly accountHome?: string
}

export async function bindProfileKernelSeat(
  scope: LocalScope,
  kind: 'host' | 'qualification-client',
  conflictCode: ProcessSeatConflictCode,
  options: ProfileKernelSeatOptions = {},
): Promise<ProcessSeat> {
  if (process.platform === 'linux') {
    return bindKernelSeat(
      { claim: 'linux-abstract', name: kind === 'host' ? scope.hostSocketName : scope.clientSeatSocketName },
      conflictCode,
    )
  }
  if (process.platform === 'darwin') {
    const dir = kind === 'host'
      ? darwinHostProfileSeatDir(scope.scopeId, options.accountHome)
      : scope.dir
    return bindKernelSeat({ claim: 'darwin-file', dir, scopeId: scope.scopeId, kind }, conflictCode)
  }
  throw new LocalScopeError(
    'B1_PLATFORM_UNSUPPORTED',
    `local scope: no profile kernel seat is implemented for ${process.platform}`,
  )
}

/**
 * Remove one scratch directory only when it is exactly a Client-created
 * `host-scratch-*` child of this scope. A SIGKILL leaves it for deferred
 * cleanup; an active Host's scratch is never touched by a new Client.
 */
export function removeOwnedScratch(scopeDir: string, scratchDir: string): void {
  if (dirname(scratchDir) !== scopeDir) return
  if (!basename(scratchDir).startsWith('host-scratch-')) return
  rmSync(scratchDir, { recursive: true, force: true })
}
