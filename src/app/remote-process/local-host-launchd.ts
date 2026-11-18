/**
 * macOS user-level launchd LaunchAgent adapter (M6-D4).
 *
 * This module owns exactly ONE Darwin OS supervision route: a user-level
 * LaunchAgent in the account's `~/Library/LaunchAgents` directory, inside the
 * `gui/<uid>` domain. It never defines a Host/Session/Agent/Writer owner and
 * never starts a second Host launcher: the installed plist runs the existing
 * foreground `dist/local-host.mjs` entry directly.
 *
 * The installed plist file is the ONLY manager-installed identity. A live
 * `launchctl` job is attributed to this profile only when its printed source
 * file and fixed launch facts match the verified profile plist AND a real
 * process PID is present; an active job is never readiness. `bootstrap`,
 * `kickstart` and `bootout` are the only mutating commands and are always
 * invoked with a fixed argument array through `/bin/launchctl` (no shell).
 *
 * The default job does NOT start at login and is NOT restarted automatically:
 * `RunAtLoad=false` and `KeepAlive=false` are deliberate. The product does not
 * rewrite user runtime directives in an existing same-owner plist.
 *
 * @module app/remote-process/local-host-launchd
 */

import { spawn } from 'node:child_process'
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { LocalScopeError } from './local-scope.ts'

/** The fixed manager label prefix; the scope id suffix names one profile. */
const LAUNCHD_LABEL_PREFIX = 'com.xmoon.dsh-pi-tui'
/** The plist owner metadata marker shared by the product's launchd adapter. */
const LAUNCHD_OWNER_MARKER = 'local-host-launchd-v1'
/** The launchd executable: a system binary, never resolved through a shell. */
const LAUNCHCTL = '/bin/launchctl'
/** Hard bound on one `launchctl` invocation. */
const LAUNCHCTL_TIMEOUT_MS = 5_000
/** Hard cap on captured stdout/stderr bytes per invocation. */
const LAUNCHCTL_MAX_OUTPUT_BYTES = 64 * 1024
/** The fixed private log file names below the profile scope directory. */
const LAUNCHD_STDOUT_NAME = 'launchd.stdout.log'
const LAUNCHD_STDERR_NAME = 'launchd.stderr.log'
/** Bound on the post-`bootout` job-removal re-query window. */
const LAUNCHD_STOP_TIMEOUT_MS = 5_000
/** Poll interval for the post-`bootout` removal observation. */
const LAUNCHD_STOP_POLL_MS = 100
/** The fixed launchd job umask (0077 octal). */
const LAUNCHD_UMASK = 0o077

/** The validated installed facts one LaunchAgent plist is rendered from. */
export interface LaunchdUnitFacts {
  readonly dshHome: string
  /** The private profile scope run directory (`<dshHome>/run/dsh-pi-tui/<scopeId>`). */
  readonly scopeDir: string
  readonly profileRealpath: string
  readonly profile: string
  readonly scopeId: string
  /** The canonical-profile identity digest shared with the systemd unit metadata. */
  readonly profileIdentity: string
  readonly buildId: string
  readonly nodePath: string
  readonly hostEntryPath: string
  readonly dshAnchor: string
}

/** The one installed plist of a profile scope. */
export interface OwnedLaunchdUnit {
  readonly label: string
  /** The named `<account-home>/Library/LaunchAgents/<label>.plist` path. */
  readonly filePath: string
  /** The canonical target of the named path. */
  readonly resolvedPath: string
  readonly content: string
  /** The install build the plist metadata declares (may differ from the current build). */
  readonly installBuild: string
  /** Canonical target identity captured for TOCTOU re-checks. */
  readonly device: number
  readonly inode: number
  /** Identity of the named plist path itself (a symlink is refused). */
  readonly pathDevice: number
  readonly pathInode: number
}

/** The read-only installed-identity answer. */
export type LaunchdUnitInspection =
  | { readonly kind: 'none' }
  | { readonly kind: 'owned'; readonly unit: OwnedLaunchdUnit }

/** One parsed `launchctl print gui/<uid>/<label>` observation. */
export interface LaunchdLoadedService {
  readonly type: string
  readonly path: string
  readonly state: string
  readonly program: string
  readonly arguments: readonly string[]
  readonly workingDirectory: string
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly environment: Readonly<Record<string, string>>
  /** The live job PID; absent when the job has no running process. */
  readonly pid?: number
}

/** The read-only live-service answer (never Host readiness). */
export type LaunchdServiceObservation =
  | { readonly kind: 'not-loaded' }
  | { readonly kind: 'loaded'; readonly service: LaunchdLoadedService }
  /** The manager answered, but its state could not be parsed into the fixed facts. */
  | { readonly kind: 'unknown' }

/** One `launchctl` outcome; only `exited` carries a real process exit. */
export type LaunchctlResult =
  | { readonly kind: 'exited'; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'spawn-error'; readonly error: NodeJS.ErrnoException }
  | { readonly kind: 'output-overflow' }

/** The injectable `launchctl` runner shape (production uses `runLaunchctl`). */
export type LaunchctlRunner = (
  args: readonly string[],
  options?: { readonly discardStdout?: boolean },
) => Promise<LaunchctlResult>

/** Injectable OS/file seams; production omits every one of them. */
export interface LaunchdAdapterDeps {
  /** Explicit account home seam for structural/native tests; production uses
   *  the OS account home (`userInfo().homedir`, never `$HOME`/`DSH_HOME`). */
  readonly accountHome?: string
  readonly uid?: number
  readonly launchctl?: LaunchctlRunner
  readonly stopTimeoutMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}

/** The result of one explicit LaunchAgent install. */
export interface LaunchdUnitInstall {
  readonly label: string
  readonly filePath: string
  /** True when THIS call created the plist; false when an owned file already existed. */
  readonly created: boolean
}

/** The deterministic job label for one profile scope. */
export function buildLaunchdLabel(scopeId: string): string {
  return `${LAUNCHD_LABEL_PREFIX}.${scopeId.slice(0, 40)}`
}

/** The fixed private launchd stdout/stderr paths below the profile scope. */
export function launchdLogPaths(scopeDir: string): { readonly stdout: string; readonly stderr: string } {
  return {
    stdout: join(scopeDir, LAUNCHD_STDOUT_NAME),
    stderr: join(scopeDir, LAUNCHD_STDERR_NAME),
  }
}

/** The fixed file name of one LaunchAgent. */
export function launchdPlistName(scopeId: string): string {
  return `${buildLaunchdLabel(scopeId)}.plist`
}

/** Reject any value that could corrupt the XML document or add a new key. */
function assertPlistSafe(value: string, label: string): void {
  if (value === '' || value.includes('\0') || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `launchd: the ${label} is empty or contains a control character`)
  }
}

/** Encode one value for an XML text node. */
function encodePlistValue(value: string, label: string): string {
  assertPlistSafe(value, label)
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}

/** Decode the five predefined XML entities (values are product-owned ASCII). */
function decodePlistValue(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&')
}

/** Render the complete, fixed LaunchAgent plist for one installed Host. */
export function renderLaunchdPlist(facts: LaunchdUnitFacts): string {
  const label = buildLaunchdLabel(facts.scopeId)
  const logs = launchdLogPaths(facts.scopeDir)
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${encodePlistValue(label, 'Label')}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${encodePlistValue(facts.nodePath, 'node path')}</string>`,
    `    <string>${encodePlistValue(facts.hostEntryPath, 'Host entry path')}</string>`,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  <string>${encodePlistValue(facts.profileRealpath, 'WorkingDirectory')}</string>`,
    '  <key>RunAtLoad</key>',
    '  <false/>',
    '  <key>KeepAlive</key>',
    '  <false/>',
    '  <key>StandardOutPath</key>',
    `  <string>${encodePlistValue(logs.stdout, 'StandardOutPath')}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${encodePlistValue(logs.stderr, 'StandardErrorPath')}</string>`,
    '  <key>Umask</key>',
    `  <integer>${String(LAUNCHD_UMASK)}</integer>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>DSH_HOME</key>',
    `    <string>${encodePlistValue(facts.dshHome, 'DSH_HOME')}</string>`,
    '    <key>SPLIT_PROCESS_DSH_ANCHOR</key>',
    `    <string>${encodePlistValue(facts.dshAnchor, 'SPLIT_PROCESS_DSH_ANCHOR')}</string>`,
    '    <key>SPLIT_PROCESS_PROFILE</key>',
    `    <string>${encodePlistValue(facts.profile, 'SPLIT_PROCESS_PROFILE')}</string>`,
    '  </dict>',
    '  <key>X-DshPiTuiOwner</key>',
    `  <string>${encodePlistValue(LAUNCHD_OWNER_MARKER, 'owner marker')}</string>`,
    '  <key>X-DshPiTuiScopeId</key>',
    `  <string>${encodePlistValue(facts.scopeId, 'scope id')}</string>`,
    '  <key>X-DshPiTuiProfileIdentity</key>',
    `  <string>${encodePlistValue(facts.profileIdentity, 'profile identity')}</string>`,
    '  <key>X-DshPiTuiInstallBuild</key>',
    `  <string>${encodePlistValue(facts.buildId, 'install build')}</string>`,
    '</dict>',
    '</plist>',
    '',
  ]
  return lines.join('\n')
}

/** Read one exact plist `<key>...</key><string>...</string>` value, rejecting duplicates. */
function readPlistString(content: string, key: string): string {
  const pattern = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`, 'gu')
  const matches = [...content.matchAll(pattern)]
  if (matches.length !== 1) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `launchd: the plist has no single ${key} value`)
  }
  return decodePlistValue(matches[0][1] as string)
}

/** The installed plist metadata of one owned unit. */
function inspectLaunchdIdentity(content: string, facts: LaunchdUnitFacts, label: string): string {
  if (readPlistString(content, 'Label') !== label) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the plist Label is not this profile scope')
  }
  if (readPlistString(content, 'X-DshPiTuiOwner') !== LAUNCHD_OWNER_MARKER) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the plist is not owned by this product')
  }
  if (readPlistString(content, 'X-DshPiTuiScopeId') !== facts.scopeId) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the plist belongs to another profile scope')
  }
  if (readPlistString(content, 'X-DshPiTuiProfileIdentity') !== facts.profileIdentity) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the plist belongs to another canonical profile')
  }
  const installBuild = readPlistString(content, 'X-DshPiTuiInstallBuild')
  if (!/^[0-9a-f]{64}$/u.test(installBuild)) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the plist has no valid install build identity')
  }
  return installBuild
}

/** Resolve and prove the OS account home without trusting `$HOME`/`DSH_HOME`. */
function resolveAccountHome(deps: LaunchdAdapterDeps): string {
  const uid = effectiveUid(deps)
  let home: string
  if (deps.accountHome !== undefined) {
    try {
      home = realpathSync(deps.accountHome)
    } catch (error) {
      throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'launchd: the account home is not readable', error)
    }
  } else {
    let info: ReturnType<typeof userInfo>
    try {
      info = userInfo()
    } catch (error) {
      throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'launchd: the OS account home is unavailable', error)
    }
    if (info.uid !== uid) {
      throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'launchd: the OS account uid does not match this process uid')
    }
    try {
      home = realpathSync(info.homedir)
    } catch (error) {
      throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'launchd: the OS account home is not readable', error)
    }
  }
  let info: Stats
  try {
    info = lstatSync(home)
  } catch (error) {
    throw new LocalScopeError('SCOPE_DIRECTORY_UNSAFE', 'launchd: the account home is not accessible', error)
  }
  // Match the existing Darwin scope owner rule: the OS account home is the
  // user's own layout and is not judged by mode; only a real uid-owned directory
  // is required. The plist itself is created 0600 and never follows a symlink.
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) {
    throw new LocalScopeError(
      'SCOPE_DIRECTORY_UNSAFE',
      'launchd: the account home must be a real uid-owned directory',
    )
  }
  return home
}

function effectiveUid(deps: LaunchdAdapterDeps): number {
  const uid = deps.uid ?? (typeof process.getuid === 'function' ? process.getuid() : undefined)
  if (uid === undefined) {
    throw new LocalScopeError('B1_PLATFORM_UNSUPPORTED', 'launchd: this operation requires a local user identity')
  }
  return uid
}

/** The `<account-home>/Library/LaunchAgents` path WITHOUT creating it. */
function launchAgentsDir(accountHome: string): string {
  return join(accountHome, 'Library', 'LaunchAgents')
}

/**
 * Walk the LaunchAgents directory chain, creating only missing components 0700.
 * An existing real directory or resolvable directory symlink is accepted as the
 * user's own layout and is never chmodded; only an inaccessible path or a
 * non-directory is refused.
 */
function ensureLaunchAgentsDir(accountHome: string): string {
  let current = accountHome
  for (const component of ['Library', 'LaunchAgents'] as const) {
    const next = join(current, component)
    let real: string
    try {
      real = realpathSync(next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `launchd: the ${component} directory is not accessible`, error)
      }
      try {
        mkdirSync(next, { mode: 0o700 })
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `launchd: the ${component} directory could not be created`, mkdirError)
        }
      }
      try {
        real = realpathSync(next)
      } catch (realpathError) {
        throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `launchd: the ${component} directory is not accessible`, realpathError)
      }
    }
    if (!statSync(real).isDirectory()) {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `launchd: the ${component} directory is not a directory`)
    }
    current = next
  }
  return current
}

/** The exact named plist path without touching the filesystem. */
function plistPathOf(accountHome: string, scopeId: string): string {
  return join(launchAgentsDir(accountHome), launchdPlistName(scopeId))
}

/** Read the named plist and its regular canonical target without mutation. */
function readLaunchdFileIdentity(filePath: string): {
  readonly content: string
  readonly resolvedPath: string
  readonly pathDevice: number
  readonly pathInode: number
  readonly device: number
  readonly inode: number
} {
  let pathInfo: Stats
  try {
    pathInfo = lstatSync(filePath)
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the profile plist is not accessible', error)
  }
  if (pathInfo.isSymbolicLink()) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the profile plist must not be a symlink')
  }
  if (!pathInfo.isFile()) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the profile plist must be a regular file')
  }
  let resolvedPath: string
  let target: Stats
  try {
    resolvedPath = realpathSync(filePath)
    target = lstatSync(resolvedPath)
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the profile plist target is not readable', error)
  }
  if (!target.isFile()) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the profile plist target must be a regular file')
  }
  let content: string
  try {
    content = readFileSync(resolvedPath, 'utf8')
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the profile plist is not readable', error)
  }
  return {
    content,
    resolvedPath,
    pathDevice: pathInfo.dev,
    pathInode: pathInfo.ino,
    device: target.dev,
    inode: target.ino,
  }
}

/**
 * Inspect the exact profile plist path. A missing `LaunchAgents` directory or
 * plist is `none`; an existing file that is not this product/profile scope is a
 * hard ownership refusal. No directory is created and `launchctl` is not invoked.
 */
export function inspectOwnedLaunchdUnit(
  facts: LaunchdUnitFacts,
  deps: LaunchdAdapterDeps = {},
): LaunchdUnitInspection {
  const accountHome = resolveAccountHome(deps)
  const label = buildLaunchdLabel(facts.scopeId)
  const filePath = plistPathOf(accountHome, facts.scopeId)
  let exists = true
  try {
    lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false
    else throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the profile plist path is not accessible', error)
  }
  if (!exists) return { kind: 'none' }
  const file = readLaunchdFileIdentity(filePath)
  const installBuild = inspectLaunchdIdentity(file.content, facts, label)
  return {
    kind: 'owned',
    unit: { label, filePath, installBuild, ...file },
  }
}

/** Re-prove one owned plist's captured file identity before a mutation. */
function assertLaunchdFileIdentity(unit: OwnedLaunchdUnit, facts: LaunchdUnitFacts, deps: LaunchdAdapterDeps): void {
  const inspected = inspectOwnedLaunchdUnit(facts, deps)
  if (inspected.kind !== 'owned'
    || inspected.unit.filePath !== unit.filePath
    || inspected.unit.resolvedPath !== unit.resolvedPath
    || inspected.unit.pathDevice !== unit.pathDevice
    || inspected.unit.pathInode !== unit.pathInode
    || inspected.unit.device !== unit.device
    || inspected.unit.inode !== unit.inode
    || inspected.unit.content !== unit.content) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the profile plist changed during the transition')
  }
}

/**
 * Run exactly one fixed `launchctl` invocation: `shell: false`, an absolute
 * binary path, a hard timeout, bounded output and a fully reaped child.
 */
export function runLaunchctl(
  args: readonly string[],
  options: { readonly discardStdout?: boolean } = {},
): Promise<LaunchctlResult> {
  return new Promise<LaunchctlResult>(resolve => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let overflow = false
    const settle = (result: LaunchctlResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child
    try {
      child = spawn(LAUNCHCTL, [...args], {
        shell: false,
        stdio: options.discardStdout === true ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'pipe', 'pipe'],
        env: process.env,
      })
    } catch (error) {
      settle({ kind: 'spawn-error', error: error as NodeJS.ErrnoException })
      return
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      settle({ kind: 'timeout' })
    }, LAUNCHCTL_TIMEOUT_MS)
    const collect = (current: string, chunk: Buffer): string => {
      if (overflow) return current
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next, 'utf8') > LAUNCHCTL_MAX_OUTPUT_BYTES) {
        overflow = true
        child.kill('SIGKILL')
        return current
      }
      return next
    }
    child.stdout?.on('data', (chunk: Buffer) => { stdout = collect(stdout, chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderr = collect(stderr, chunk) })
    child.once('error', (error: NodeJS.ErrnoException) => {
      settle({ kind: 'spawn-error', error })
    })
    child.once('close', (code: number | null) => {
      if (overflow) {
        settle({ kind: 'output-overflow' })
        return
      }
      settle({ kind: 'exited', code: code ?? 1, stdout, stderr })
    })
  })
}

/** One scalar `key = value` line of `launchctl print` (first occurrence wins). */
function readLaunchctlScalar(lines: readonly string[], key: string): string | undefined {
  const prefix = `${key} = `
  for (const line of lines) {
    if (line.startsWith(prefix)) return line.slice(prefix.length)
  }
  return undefined
}

/** One `name = { ... }` block of `launchctl print`, preserving raw entry lines. */
function readLaunchctlBlock(lines: readonly string[], key: string): readonly string[] | undefined {
  const head = `${key} = {`
  const start = lines.indexOf(head)
  if (start < 0) return undefined
  const entries: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line === '}') return entries
    if (!line.startsWith('\t')) return undefined
    entries.push(line.slice(1))
  }
  return undefined
}

/**
 * Parse the ONE narrow set of real facts this product consumes from
 * `launchctl print gui/<uid>/<label>`. The manager's whole output is never
 * cached or treated as a second state machine; an incomplete or ambiguous
 * answer is `undefined` (the caller must fail closed).
 */
export function parseLaunchctlPrint(stdout: string): LaunchdLoadedService | undefined {
  // `launchctl print` indents every field with exactly one tab; strip it so
  // block entries are the raw values and scalar keys match exactly.
  const lines = stdout.replace(/\r\n/gu, '\n').split('\n').map(line => (line.startsWith('\t') ? line.slice(1) : line))
  const type = readLaunchctlScalar(lines, 'type')
  const path = readLaunchctlScalar(lines, 'path')
  const state = readLaunchctlScalar(lines, 'state')
  const program = readLaunchctlScalar(lines, 'program')
  const workingDirectory = readLaunchctlScalar(lines, 'working directory')
  const stdoutPath = readLaunchctlScalar(lines, 'stdout path')
  const stderrPath = readLaunchctlScalar(lines, 'stderr path')
  const argumentLines = readLaunchctlBlock(lines, 'arguments')
  const environmentLines = readLaunchctlBlock(lines, 'environment')
  if (type === undefined || path === undefined || state === undefined || program === undefined
    || workingDirectory === undefined || stdoutPath === undefined || stderrPath === undefined
    || argumentLines === undefined || environmentLines === undefined) return undefined
  if (type !== 'LaunchAgent' || !path.startsWith('/') || !program.startsWith('/') || !workingDirectory.startsWith('/')
    || !stdoutPath.startsWith('/') || !stderrPath.startsWith('/')) return undefined
  const argumentsList: string[] = []
  for (const line of argumentLines) {
    if (line === '') return undefined
    argumentsList.push(line)
  }
  if (argumentsList.length === 0) return undefined
  const environment: Record<string, string> = {}
  for (const line of environmentLines) {
    const separator = line.indexOf(' => ')
    if (separator <= 0) return undefined
    const key = line.slice(0, separator)
    if (Object.hasOwn(environment, key)) return undefined
    environment[key] = line.slice(separator + 4)
  }
  const pidText = readLaunchctlScalar(lines, 'pid')
  let pid: number | undefined
  if (pidText !== undefined) {
    if (!/^[0-9]+$/u.test(pidText)) return undefined
    const parsed = Number(pidText)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined
    pid = parsed
  }
  return {
    type,
    path,
    state,
    program,
    arguments: argumentsList,
    workingDirectory,
    stdoutPath,
    stderrPath,
    environment,
    ...(pid === undefined ? {} : { pid }),
  }
}

/** Map one launchctl answer into the narrow read-only service observation. */
function launchctlFailure(result: LaunchctlResult, action: string): LocalScopeError {
  switch (result.kind) {
    case 'timeout':
      return new LocalScopeError('HOST_MANAGER_ERROR', `launchd: launchctl ${action} timed out`)
    case 'spawn-error':
      return new LocalScopeError('HOST_MANAGER_ERROR', `launchd: launchctl ${action} could not be spawned`, result.error)
    case 'output-overflow':
      return new LocalScopeError('HOST_MANAGER_ERROR', `launchd: launchctl ${action} produced too much output`)
    case 'exited':
      return new LocalScopeError('HOST_MANAGER_ERROR', `launchd: launchctl ${action} failed (exit ${String(result.code)})`)
  }
}

/** Query the current service of one fixed job label. */
async function inspectLaunchdServiceByLabel(label: string, deps: LaunchdAdapterDeps): Promise<LaunchdServiceObservation> {
  const uid = effectiveUid(deps)
  const launchctl = deps.launchctl ?? runLaunchctl
  const result = await launchctl(['print', `gui/${String(uid)}/${label}`])
  if (result.kind !== 'exited') throw launchctlFailure(result, 'print')
  if (result.code === 113) return { kind: 'not-loaded' }
  if (result.code === 112) {
    throw new LocalScopeError('HOST_MANAGER_ERROR', 'launchd: the user GUI domain is not available')
  }
  if (result.code !== 0) throw launchctlFailure(result, 'print')
  const service = parseLaunchctlPrint(result.stdout)
  if (service === undefined) return { kind: 'unknown' }
  return { kind: 'loaded', service }
}

/** Read-only inspection of one owned plist's live launchd service. */
export async function inspectLaunchdService(
  unit: OwnedLaunchdUnit,
  deps: LaunchdAdapterDeps = {},
): Promise<LaunchdServiceObservation> {
  return await inspectLaunchdServiceByLabel(unit.label, deps)
}

/**
 * True only when the loaded job was bootstrapped from THIS profile's exact
 * plist target and its fixed launch facts are the current installed facts.
 * User-owned runtime directives outside these facts are not identity.
 */
export function launchdServiceMatches(
  facts: LaunchdUnitFacts,
  unit: OwnedLaunchdUnit,
  service: LaunchdLoadedService,
): boolean {
  const logs = launchdLogPaths(facts.scopeDir)
  return service.type === 'LaunchAgent'
    && service.path === unit.resolvedPath
    && service.program === facts.nodePath
    && service.arguments.length === 2
    && service.arguments[0] === facts.nodePath
    && service.arguments[1] === facts.hostEntryPath
    && service.workingDirectory === facts.profileRealpath
    && service.stdoutPath === logs.stdout
    && service.stderrPath === logs.stderr
    && service.environment.DSH_HOME === facts.dshHome
    && service.environment.SPLIT_PROCESS_DSH_ANCHOR === facts.dshAnchor
    && service.environment.SPLIT_PROCESS_PROFILE === facts.profile
}

/** Prove the user GUI domain is queryable before an install writes anything. */
async function assertLaunchdDomain(deps: LaunchdAdapterDeps): Promise<void> {
  const uid = effectiveUid(deps)
  const launchctl = deps.launchctl ?? runLaunchctl
  const result = await launchctl(['print', `gui/${String(uid)}`], { discardStdout: true })
  if (result.kind !== 'exited' || result.code !== 0) {
    if (result.kind === 'exited' && result.code === 112) {
      throw new LocalScopeError('HOST_MANAGER_ERROR', 'launchd: the user GUI domain is not available')
    }
    throw launchctlFailure(result, 'domain check')
  }
}

/** Create a NEW private log file without truncating an existing one. The
 *  creation mode is 0600; an existing user file is opened append-only and its
 *  mode is never changed. */
function ensureLaunchdLogFile(path: string): void {
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    closeSync(fd)
    fd = undefined
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    if (error instanceof LocalScopeError) throw error
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'launchd: the private log file could not be prepared', error)
  }
}

/**
 * Prepare the two independent private launchd log sinks 0600 before a job
 * starts. An existing file is opened append-only and never chmodded/truncated;
 * a final symlink is refused (O_NOFOLLOW) and never followed.
 */
function ensureLaunchdLogFiles(facts: LaunchdUnitFacts): void {
  const logs = launchdLogPaths(facts.scopeDir)
  ensureLaunchdLogFile(logs.stdout)
  ensureLaunchdLogFile(logs.stderr)
}

/** Write one NEW plist atomically; an existing file is preserved untouched. */
function installLaunchdFile(options: {
  readonly dir: string
  readonly label: string
  readonly content: string
}): { readonly created: boolean } {
  const finalPath = join(options.dir, `${options.label}.plist`)
  const tempPath = join(options.dir, `.${options.label}.${String(process.pid)}.${randomUUID()}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    fchmodSync(fd, 0o600)
    const buffer = Buffer.from(options.content, 'utf8')
    let offset = 0
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(tempPath) } catch { /* the temp file may not exist */ }
    if (error instanceof LocalScopeError) throw error
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'launchd: the plist temp file could not be written', error)
  }
  let created = false
  try {
    linkSync(tempPath, finalPath)
    created = true
  } catch (linkError) {
    if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') {
      try { unlinkSync(tempPath) } catch { /* the temp file may not exist */ }
      throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'launchd: the plist could not be installed atomically', linkError)
    }
    // A user file already at the target is preserved; the caller re-inspects it.
  } finally {
    try { unlinkSync(tempPath) } catch { /* the temp file may already be gone */ }
  }
  return { created }
}

/**
 * Install the ONE explicit user-level LaunchAgent for this profile. This path
 * verifies the GUI domain, the current owned file (if any) and the same-label
 * job source, then writes the plist atomically. A job loaded from our target
 * path with no owned file is an unprovable source and is refused rather than
 * conflated with a new file. It never bootstraps, kickstarts, enables, stops or
 * restarts a job and never creates the profile runtime scope.
 */
export async function installLaunchdUnit(
  facts: LaunchdUnitFacts,
  deps: LaunchdAdapterDeps = {},
): Promise<LaunchdUnitInstall> {
  const accountHome = resolveAccountHome(deps)
  const label = buildLaunchdLabel(facts.scopeId)
  await assertLaunchdDomain(deps)
  const dir = ensureLaunchAgentsDir(accountHome)
  const filePath = join(dir, `${label}.plist`)
  const canonicalTarget = join(realpathSync(dir), `${label}.plist`)
  // Inspect the CURRENT file BEFORE the loaded-job source check. A loaded job
  // from our target path is reusable only when the exact owned plist still
  // exists: with no file there is no proven relationship between the loaded
  // job and any new file, so install must fail closed instead of conflating
  // them.
  const existing = inspectOwnedLaunchdUnit(facts, deps)
  if (existing.kind === 'owned' && existing.unit.installBuild !== facts.buildId) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the installed profile plist belongs to another installed build')
  }
  const observed = await inspectLaunchdServiceByLabel(label, deps)
  if (observed.kind === 'unknown') {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the loaded job state of this label is unknown; refusing to install')
  }
  if (observed.kind === 'loaded') {
    if (observed.service.path !== filePath && observed.service.path !== canonicalTarget) {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: this label is already loaded from another source; refusing to install')
    }
    if (existing.kind === 'none') {
      throw new LocalScopeError(
        'HOST_MANAGER_UNIT_CONFLICT',
        'launchd: this label is loaded from the profile plist path but no owned plist exists; the loaded source cannot be proven, refusing to install',
      )
    }
  }
  if (existing.kind === 'owned') {
    return { label, filePath: existing.unit.filePath, created: false }
  }
  const content = renderLaunchdPlist(facts)
  const created = installLaunchdFile({ dir, label, content }).created
  const verified = inspectOwnedLaunchdUnit(facts, deps)
  if (verified.kind !== 'owned') {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the installed profile plist could not be confirmed')
  }
  if (verified.unit.installBuild !== facts.buildId) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the installed profile plist belongs to another installed build')
  }
  return { label, filePath: verified.unit.filePath, created }
}

/** Issue one kickstart for a verified job. */
async function kickstartLaunchdJob(unit: OwnedLaunchdUnit, deps: LaunchdAdapterDeps): Promise<void> {
  const uid = effectiveUid(deps)
  const launchctl = deps.launchctl ?? runLaunchctl
  const result = await launchctl(['kickstart', `gui/${String(uid)}/${unit.label}`])
  if (result.kind !== 'exited' || result.code !== 0) throw launchctlFailure(result, 'kickstart')
}

/**
 * Start the installed job through launchd only: prove the canonical fixed
 * definition, inspect the current service, refuse a foreign/stale loaded
 * definition, `bootstrap` exactly once when the job is not loaded, then
 * `kickstart` exactly once when no process is running. A user-edited plist is
 * preserved on disk but is never bootstrapped: `RunAtLoad=true` can execute a
 * modified program during `bootstrap`, before a post-load check. The manager
 * request is never readiness; the caller still waits for the official
 * authenticated Host.
 */
export async function startLaunchdService(
  facts: LaunchdUnitFacts,
  unit: OwnedLaunchdUnit,
  deps: LaunchdAdapterDeps = {},
): Promise<void> {
  const uid = effectiveUid(deps)
  // The caller inspected the file before the read-only observation above; a
  // user/launchctl actor can still replace it between that observation and this
  // mutation. Re-prove the captured file identity at the adapter boundary and
  // again immediately before each mutating request.
  assertLaunchdFileIdentity(unit, facts, deps)
  // A user-edited plist can change RunAtLoad or ProgramArguments. `bootstrap`
  // may execute such a definition IMMEDIATELY (verified by the native probe),
  // so the fixed definition must be proven before any manager operation that
  // could start it. User edits are preserved on disk; they are never
  // bootstrapped by this product.
  if (unit.content !== renderLaunchdPlist(facts)) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the profile plist contains user edits; refusing to bootstrap an unverified definition')
  }
  let observed = await inspectLaunchdService(unit, deps)
  if (observed.kind === 'unknown') {
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'launchd: the loaded job state is not recognizable; refusing to start')
  }
  if (observed.kind === 'loaded') {
    if (!launchdServiceMatches(facts, unit, observed.service)) {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the loaded job does not match this profile plist; run daemon uninstall before reinstalling')
    }
    if (observed.service.pid !== undefined) return
    ensureLaunchdLogFiles(facts)
    assertLaunchdFileIdentity(unit, facts, deps)
    await kickstartLaunchdJob(unit, deps)
    return
  }
  // Not loaded: prepare the private sinks BEFORE launchd opens them, then
  // bootstrap exactly once from the verified plist path.
  ensureLaunchdLogFiles(facts)
  assertLaunchdFileIdentity(unit, facts, deps)
  const launchctl = deps.launchctl ?? runLaunchctl
  const bootstrap = await launchctl(['bootstrap', `gui/${String(uid)}`, unit.filePath])
  if (bootstrap.kind !== 'exited' || bootstrap.code !== 0) {
    // A concurrent Client may have bootstrapped the same label first. Admit it
    // only when the current service is genuinely this profile's job.
    const raced = await inspectLaunchdService(unit, deps)
    if (raced.kind !== 'loaded' || !launchdServiceMatches(facts, unit, raced.service)) {
      throw launchctlFailure(bootstrap, 'bootstrap')
    }
    if (raced.service.pid !== undefined) return
    assertLaunchdFileIdentity(unit, facts, deps)
    await kickstartLaunchdJob(unit, deps)
    return
  }
  observed = await inspectLaunchdService(unit, deps)
  if (observed.kind !== 'loaded' || !launchdServiceMatches(facts, unit, observed.service)) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the bootstrapped job is not this profile plist')
  }
  if (observed.service.pid !== undefined) return
  assertLaunchdFileIdentity(unit, facts, deps)
  await kickstartLaunchdJob(unit, deps)
}

/** Bounded wait until a verified label is genuinely no longer loaded. */
async function waitForLaunchdJobRemoved(unit: OwnedLaunchdUnit, deps: LaunchdAdapterDeps): Promise<void> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const deadline = now() + (deps.stopTimeoutMs ?? LAUNCHD_STOP_TIMEOUT_MS)
  for (;;) {
    const observed = await inspectLaunchdService(unit, deps)
    if (observed.kind === 'not-loaded') return
    if (now() >= deadline) {
      throw new LocalScopeError('HOST_STOP_TIMEOUT', 'launchd: the profile job did not leave the manager within the bounded window')
    }
    await sleep(LAUNCHD_STOP_POLL_MS)
  }
}

/**
 * Stop the verified profile job through `bootout` only. `bootout` is a shutdown
 * REQUEST, not proof of process exit: the caller still waits for the recorded
 * Darwin kernel identity to become gone/different. A loaded job that does not
 * match the current profile plist is never booted out.
 */
export async function stopLaunchdService(
  facts: LaunchdUnitFacts,
  unit: OwnedLaunchdUnit,
  deps: LaunchdAdapterDeps = {},
  /** The authenticated live Host PID the caller verified, when one exists.
   *  A loaded job that now runs a DIFFERENT real PID is never booted out. */
  expectedPid?: number,
): Promise<{ readonly stopped: boolean }> {
  assertLaunchdFileIdentity(unit, facts, deps)
  const observed = await inspectLaunchdService(unit, deps)
  if (observed.kind === 'not-loaded') return { stopped: false }
  if (observed.kind === 'unknown') {
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'launchd: the loaded job state is not recognizable; refusing to stop')
  }
  if (!launchdServiceMatches(facts, unit, observed.service)) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the loaded job does not match this profile plist; refusing to stop an unknown process')
  }
  if (expectedPid !== undefined) {
    if (observed.service.pid !== undefined) {
      if (observed.service.state !== 'running') {
        throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the loaded job has a process in an unconfirmed state; refusing to stop')
      }
      if (observed.service.pid !== expectedPid) {
        throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the loaded job PID changed before the stop; refusing to bootout an unverified process')
      }
    } else {
      if (observed.service.state === 'running' || observed.service.state === 'spawn scheduled') {
        throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the loaded job is starting without a verifiable PID; refusing to stop')
      }
      if (observed.service.state !== 'not running') {
        throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `launchd: the loaded job is in an unconfirmed state (${observed.service.state === '' ? 'unknown' : observed.service.state}); refusing to stop`)
      }
      // A genuinely not-running job has no process to signal; bootout is the
      // safe way to remove the loaded definition.
    }
  }
  const stopped = observed.service.pid !== undefined || observed.service.state === 'running' || observed.service.state === 'spawn scheduled'
  assertLaunchdFileIdentity(unit, facts, deps)
  const uid = effectiveUid(deps)
  const launchctl = deps.launchctl ?? runLaunchctl
  const result = await launchctl(['bootout', `gui/${String(uid)}/${unit.label}`])
  if (result.kind !== 'exited' || (result.code !== 0 && result.code !== 3)) {
    throw launchctlFailure(result, 'bootout')
  }
  await waitForLaunchdJobRemoved(unit, deps)
  return { stopped }
}

/**
 * Remove ONE verified profile plist and, only when it is loaded from THIS exact
 * file, the verified job. An independent Host, Sessions, Workspace,
 * credentials, `host.log` and the launchd private logs are never removed.
 */
export async function uninstallLaunchdUnit(
  facts: LaunchdUnitFacts,
  unit: OwnedLaunchdUnit,
  deps: LaunchdAdapterDeps = {},
  /** The authenticated live Host PID the caller verified, when one exists. */
  expectedPid?: number,
): Promise<void> {
  // Prove the captured file identity BEFORE any bootout: a changed plist must
  // never stop a job and only then discover the change.
  assertLaunchdFileIdentity(unit, facts, deps)
  const observed = await inspectLaunchdService(unit, deps)
  if (observed.kind === 'unknown') {
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'launchd: the loaded job state is not recognizable; refusing to uninstall')
  }
  if (observed.kind === 'loaded') {
    if (!launchdServiceMatches(facts, unit, observed.service)) {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the loaded job does not match this profile plist; refusing to remove the job')
    }
    await stopLaunchdService(facts, unit, deps, expectedPid)
  }
  assertLaunchdFileIdentity(unit, facts, deps)
  try {
    unlinkSync(unit.filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the profile plist vanished during uninstall')
    }
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'launchd: the profile plist could not be removed', error)
  }
  const remaining = inspectOwnedLaunchdUnit(facts, deps)
  if (remaining.kind !== 'none') {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'launchd: the profile plist could not be confirmed removed')
  }
}
