/**
 * Host process startup environment bootstrap.
 *
 * A daemon Host is started by an OS manager or by a detached spawn, not by an
 * interactive login shell, so its inherited PATH can omit the user tool
 * directories a shell would have added. This module answers ONE question at
 * Host startup: given the inherited environment, which common tool directories
 * that already exist should be appended to this process's PATH?
 *
 * It never imports a shell, a shell snapshot, DSH, Cordis, Client or TUI code,
 * and performs no I/O when loaded. The real process entry calls it once before
 * the official profile boot; only `process.env.PATH` changes. The inherited
 * environment keeps its exact bytes and order, other variables are never read
 * back, written or imported, and a missing directory is a normal skip.
 *
 * `inherit` (`DSH_PI_TUI_HOST_PATH_MODE=inherit`) skips all candidate work and
 * leaves PATH alone. An unrecognized mode is a startup failure with a fixed
 * message that never echoes the supplied value.
 *
 * @module app/remote-process/host-environment
 */

import { statSync } from 'node:fs'
import { userInfo } from 'node:os'
import { posix } from 'node:path'

/** One supported Host platform; the manager selection never changes this algorithm. */
export type HostPathPlatform = 'linux' | 'darwin'

/** The resolved startup policy for this Host process. */
export type HostPathMode = 'augment' | 'inherit'

/** The fixed startup failure for an unrecognized mode value. */
export const INVALID_HOST_PATH_MODE = 'Invalid DSH_PI_TUI_HOST_PATH_MODE: expected augment or inherit'

/** The optional directory probe result; `statSync` already matches this shape. */
export interface HostPathDirectoryStat {
  isDirectory(): boolean
}

/** One resolved decision; the entry owns all logging and the single application. */
export interface HostPathEnvironment {
  readonly mode: HostPathMode
  /** The PATH this process should have; `undefined` when the inherited PATH is absent and no candidate exists. */
  readonly path: string | undefined
  readonly addedPathCount: number
  /** Explicitly configured path values that were not usable absolute POSIX paths. */
  readonly skippedInvalidCount: number
  /** Existing candidates whose directory status could not be inspected. */
  readonly skippedInaccessibleCount: number
  /**
   * Whether an absolute home was available for path construction. `undefined`
   * means `inherit` never consulted HOME or the OS account.
   */
  readonly homeAvailable: boolean | undefined
}

/** Inputs of the pure decision. Filesystem and account access stay injectable. */
export interface ResolveHostPathOptions {
  readonly env: Readonly<NodeJS.ProcessEnv>
  readonly platform: HostPathPlatform
  /** Consulted only when the inherited HOME is missing or not a usable absolute path. */
  readonly accountHome?: () => string
  /** The default follows symlinks and reports the real directory entry. */
  readonly statDirectory?: (path: string) => HostPathDirectoryStat
}

/** The platform package-manager group, in contract order. */
const PLATFORM_DIRECTORIES: Readonly<Record<HostPathPlatform, readonly string[]>> = {
  linux: ['/home/linuxbrew/.linuxbrew/bin', '/home/linuxbrew/.linuxbrew/sbin'],
  darwin: ['/opt/homebrew/bin', '/opt/homebrew/sbin'],
}

/** The fixed system directory group shared by both platforms. */
const SYSTEM_DIRECTORIES: readonly string[] = ['/usr/local/bin', '/usr/local/sbin', '/usr/bin', '/usr/sbin', '/bin', '/sbin']

/** Failures that mean "this candidate cannot be inspected", never a silent absence. */
const INACCESSIBLE_STAT_CODES: ReadonlySet<string> = new Set(['EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG'])

/** A candidate assembled from one table row, with its group membership. */
interface PathCandidate {
  readonly path: string
  /** True only when the selected directory came from an explicit environment override. */
  readonly explicit: boolean
}

/** One usable directory value: the path plus whether it came from explicit configuration. */
interface SelectedPath {
  readonly path: string
  readonly explicit: boolean
}

/** A non-empty, absolute POSIX path usable as a PATH entry. */
function isUsablePath(value: string): boolean {
  return value !== '' && value.startsWith('/') && !value.includes(':') && !value.includes('\0')
}

/** Resolve the requested policy, rejecting everything else with the fixed message. */
function resolveMode(value: string | undefined): HostPathMode {
  if (value === undefined || value === 'augment') return 'augment'
  if (value === 'inherit') return 'inherit'
  throw new Error(INVALID_HOST_PATH_MODE)
}

/** The default probe: a real stat that follows a legal directory symlink. */
function statDirectory(path: string): HostPathDirectoryStat {
  return statSync(path)
}

/** One probe outcome: a directory to append, a normal absence, or an unreadable entry. */
type ProbeOutcome = 'directory' | 'missing' | 'inaccessible'

/** Classify one candidate without turning an unexpected filesystem failure into absence. */
function probeDirectory(probe: (path: string) => HostPathDirectoryStat, path: string): ProbeOutcome {
  try {
    return probe(path).isDirectory() ? 'directory' : 'missing'
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
    if (INACCESSIBLE_STAT_CODES.has(code)) return 'inaccessible'
    throw error
  }
}

/**
 * Build the ordered candidate plan from the authoritative inherited `env`.
 * Invalid explicit values are counted and skipped; each tool then uses its
 * regular default, and a usable override never falls back to that default.
 */
function planCandidates(options: {
  readonly env: Readonly<NodeJS.ProcessEnv>
  readonly platform: HostPathPlatform
  readonly home: string | undefined
  readonly countInvalid: () => void
}): readonly PathCandidate[] {
  const { env, platform, home, countInvalid } = options
  /** One explicit value: unset, unusable, or a usable path (with suffix applied by the caller). */
  const explicit = (value: string | undefined, suffix?: string): SelectedPath | undefined => {
    if (value === undefined || value === '') return undefined
    if (!isUsablePath(value)) {
      countInvalid()
      return undefined
    }
    return { path: suffix === undefined ? value : posix.join(value, suffix), explicit: true }
  }
  const fallback = (path: string | undefined): SelectedPath | undefined =>
    path === undefined ? undefined : { path, explicit: false }
  const first = (...selected: readonly (SelectedPath | undefined)[]): SelectedPath | undefined =>
    selected.find(candidate => candidate !== undefined)

  let dataHome: SelectedPath | undefined
  const xdgDataHome = env.XDG_DATA_HOME
  if (xdgDataHome !== undefined && xdgDataHome !== '') {
    dataHome = explicit(xdgDataHome) ?? fallback(home === undefined ? undefined : posix.join(home, '.local/share'))
  } else {
    dataHome = fallback(home === undefined ? undefined : posix.join(home, '.local/share'))
  }

  const mise = first(
    explicit(env.MISE_SHIMS_DIR),
    explicit(env.MISE_DATA_DIR, 'shims'),
    dataHome === undefined ? undefined : { path: posix.join(dataHome.path, 'mise', 'shims'), explicit: dataHome.explicit },
  )
  const asdf = first(
    explicit(env.ASDF_DATA_DIR, 'shims'),
    fallback(home === undefined ? undefined : posix.join(home, '.asdf', 'shims')),
  )
  const cargo = first(
    explicit(env.CARGO_HOME, 'bin'),
    fallback(home === undefined ? undefined : posix.join(home, '.cargo', 'bin')),
  )
  const go = first(
    explicit(env.GOBIN),
    fallback(home === undefined ? undefined : posix.join(home, 'go', 'bin')),
  )
  const volta = first(
    explicit(env.VOLTA_HOME, 'bin'),
    fallback(home === undefined ? undefined : posix.join(home, '.volta', 'bin')),
  )
  const bun = first(
    explicit(env.BUN_INSTALL, 'bin'),
    fallback(home === undefined ? undefined : posix.join(home, '.bun', 'bin')),
  )
  const pnpm = first(
    explicit(env.PNPM_HOME),
    platform === 'linux'
      ? dataHome === undefined ? undefined : { path: posix.join(dataHome.path, 'pnpm'), explicit: dataHome.explicit }
      : fallback(home === undefined ? undefined : posix.join(home, 'Library', 'pnpm')),
  )

  const rows: readonly (SelectedPath | undefined)[] = [
    fallback(home === undefined ? undefined : posix.join(home, '.local/bin')),
    fallback(home === undefined ? undefined : posix.join(home, 'bin')),
    mise,
    asdf,
    cargo,
    go,
    volta,
    bun,
    pnpm,
  ]
  const candidates: PathCandidate[] = []
  for (const selected of rows) {
    if (selected === undefined) continue
    candidates.push({ path: selected.path, explicit: selected.explicit })
  }
  for (const path of PLATFORM_DIRECTORIES[platform]) candidates.push({ path, explicit: false })
  for (const path of SYSTEM_DIRECTORIES) candidates.push({ path, explicit: false })
  return candidates
}

/**
 * Resolve the Host startup PATH decision without touching the real process.
 *
 * The original non-empty PATH is preserved byte for byte, including relative,
 * empty and duplicate entries; only candidates whose exact string is not
 * already present are stat-probed and appended. Explicit user tool
 * configuration is appended before the regular user defaults, which are
 * followed by the platform package-manager and system directories.
 */
export function resolveHostPath(options: ResolveHostPathOptions): HostPathEnvironment {
  const { env, platform } = options
  const mode = resolveMode(env.DSH_PI_TUI_HOST_PATH_MODE)
  if (mode === 'inherit') {
    return {
      mode,
      path: env.PATH,
      addedPathCount: 0,
      skippedInvalidCount: 0,
      skippedInaccessibleCount: 0,
      homeAvailable: undefined,
    }
  }

  let skippedInvalidCount = 0
  const countInvalid = (): void => {
    skippedInvalidCount += 1
  }

  let home = env.HOME
  if (home === undefined || !isUsablePath(home)) {
    const accountHome = (options.accountHome ?? (() => userInfo().homedir))()
    home = isUsablePath(accountHome) ? accountHome : undefined
  }

  const probe = options.statDirectory ?? statDirectory
  const inherited = env.PATH === undefined || env.PATH === '' ? [] : env.PATH.split(':')
  const seen = new Set(inherited)
  let skippedInaccessibleCount = 0
  const appended: string[] = []
  const candidates = planCandidates({ env, platform, home, countInvalid })
  // Explicit configuration wins the document order: the whole explicit group is
  // appended before the regular user defaults, whatever row it came from.
  const ordered = [...candidates.filter(candidate => candidate.explicit), ...candidates.filter(candidate => !candidate.explicit)]
  for (const candidate of ordered) {
    if (seen.has(candidate.path)) continue
    const outcome = probeDirectory(probe, candidate.path)
    if (outcome === 'missing') continue
    if (outcome === 'inaccessible') {
      skippedInaccessibleCount += 1
      continue
    }
    appended.push(candidate.path)
    seen.add(candidate.path)
  }

  let path = env.PATH
  if (appended.length > 0) {
    path = env.PATH === undefined || env.PATH === '' ? appended.join(':') : `${env.PATH}:${appended.join(':')}`
  }
  return {
    mode,
    path,
    addedPathCount: appended.length,
    skippedInvalidCount,
    skippedInaccessibleCount,
    homeAvailable: home !== undefined,
  }
}

/**
 * Apply the real startup decision to this Host process exactly once. The
 * entry owns the resulting log record and warning; this function only reads
 * `process.env` and writes PATH when the value actually changes.
 */
export function initializeHostEnvironment(platform: HostPathPlatform): HostPathEnvironment {
  const environment = resolveHostPath({ env: process.env, platform })
  if (environment.path !== undefined && environment.path !== process.env.PATH) {
    process.env.PATH = environment.path
  }
  return environment
}
