/**
 * M4-B1 local Host/Client scope, process seats and installed-build identity.
 *
 * The ordinary DSH profile is the scope authority: this module derives a
 * stable id from the canonical profile directory and the current UID, then
 * owns the private run directory, the two Linux abstract-socket seats and the
 * installed-build fingerprint the Host and Client must agree on.
 *
 * The abstract sockets are admission primitives only. No business traffic
 * travels over them, and no PID file, registry record or `O_EXCL` marker can
 * substitute for the kernel's exclusive bind.
 *
 * @module app/remote-process/local-scope
 */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { createServer } from 'node:net'
import { Buffer } from 'node:buffer'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The only B1 identity protocol string. */
export const LOCAL_PROTOCOL = 'm4-b1/1'

/** Private scope directory below the official DSH home. */
const RUN_ROOT_NAME = 'run'
const SCOPE_ROOT_NAME = 'dsh-pi-tui'

/** Linux abstract-socket prefixes; both names stay well below `sun_path`. */
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
  | 'HOST_BUILD_INCOMPATIBLE'
  | 'HOST_IDENTITY_MISMATCH'
  | 'HOST_UNRESPONSIVE'
  | 'HOST_AUTH_FAILED'
  | 'HOST_START_TIMEOUT'
  | 'HOST_START_FAILED'
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
  /** Canonical profile directory the scope belongs to. */
  readonly profileRealpath: string
  /** Private 0700 run directory. */
  readonly dir: string
  /** Linux abstract Host claim name. */
  readonly hostSocketName: string
  /** Linux abstract single-Client seat name. */
  readonly clientSeatSocketName: string
  /** Installed-build fingerprint described below. */
  readonly buildId: string
  /** Installed bundle version from the package manifest. */
  readonly bundleVersion: string
  /** Installed DSH runtime version. */
  readonly dshVersion: string
}

/** One held process seat; closing it releases the kernel name. */
export interface ProcessSeat {
  close(): Promise<void>
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
 * Create and prove the private run chain WITHOUT following a pre-existing
 * symlink. Each component is lstat-checked before its child is created; the
 * final run/scope/instance directories must be real directories owned by the
 * current UID with no group/other access.
 */
function ensureScopeDirectory(dshHome: string, scopeId: string, uid: number): string {
  const runRoot = join(dshHome, RUN_ROOT_NAME)
  const scopeRoot = join(runRoot, SCOPE_ROOT_NAME)
  const dir = join(scopeRoot, scopeId)
  for (const path of [runRoot, scopeRoot, dir]) {
    let info
    try {
      info = lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: ${path} is not accessible`, error)
      }
      // The parent was already proved (or is the canonical DSH home); a
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
    if ((info.mode & 0o077) !== 0) {
      throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', `local scope: ${path} must not be readable or writable by group/other`)
    }
  }
  return dir
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
 * Build the one scope for an installed profile. The caller supplies the
 * official DSH home/profile resolution results; this module never guesses a
 * path. The run directory is created here, before any process seat or Host
 * Context exists.
 */
export function scopeFromInstalledProfile(facts: InstalledProfileFacts): LocalScope {
  const uid = assertLinux()
  const dshHome = canonicalOwnedDirectory(facts.dshHome, uid, 'DSH home')
  const profileRealpath = canonicalOwnedDirectory(facts.profileDir, uid, 'profile directory')
  const bundleVersion = readBundleVersion(facts.packageRoot)
  const scopeId = createHash('sha256')
    .update(`dsh-pi-tui/m4-b1\0${String(uid)}\0${profileRealpath}`)
    .digest('hex')
  const dir = ensureScopeDirectory(dshHome, scopeId, uid)
  return Object.freeze({
    scopeId,
    profileRealpath,
    dir,
    hostSocketName: `${HOST_SEAT_PREFIX}${scopeId.slice(0, 40)}`,
    clientSeatSocketName: `${CLIENT_SEAT_PREFIX}${scopeId.slice(0, 40)}`,
    buildId: computeBuildId(facts.packageRoot, facts.dshVersion),
    bundleVersion,
    dshVersion: facts.dshVersion,
  })
}

/**
 * Parse field 22 (`starttime`) from one `/proc/<pid>/stat` text. The comm field
 * may contain spaces and parentheses; everything after the LAST ')' is the
 * fixed positional tail whose first entry is field 3.
 */
export function parseProcessStatStarttime(stat: string): string | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  const fields = stat.slice(close + 2).trim().split(/\s+/)
  const value = fields[19]
  return value !== undefined && /^\d+$/u.test(value) ? value : undefined
}

/** Best-effort Linux `starttime` read used by A0 status surfaces (may be undefined). */
export function readProcessStarttime(pid: number = process.pid): string | undefined {
  try {
    return parseProcessStatStarttime(readFileSync(`/proc/${String(pid)}/stat`, 'utf8'))
  } catch {
    return undefined
  }
}

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
 * Claim one kernel abstract-socket seat. `EADDRINUSE` means another process
 * of this scope already holds the seat and is the sole winner; any other
 * listen error is a real failure. The returned close is idempotent.
 */
export function bindProcessSeat(
  name: string,
  conflictCode: 'HOST_ALREADY_OWNED' | 'CLIENT_ALREADY_ACTIVE',
): Promise<ProcessSeat> {
  assertLinux()
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
