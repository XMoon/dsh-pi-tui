/**
 * Profile-aware managed Host lifecycle (M6-2B).
 *
 * This is the ONE module allowed to own the local Host OS supervision boundary:
 * it probes whether the current user's systemd user manager can safely control
 * a unit, renders and atomically installs ONE profile-scoped unit, and drives
 * `systemctl --user` with a fixed, non-PATH executable. It never imports
 * `app/bootstrap.ts`, Cordis, the Web or a Session service, and it creates no
 * manager store, daemon or public API: the Host's official 0700 scope directory,
 * abstract kernel seat, authenticated identity and `runProfile` shutdown owner
 * are all unchanged. A `systemctl start` here only means the manager accepted a
 * request; readiness is still proven later by the existing authenticated Host
 * handshake in `local-discovery.ts`.
 *
 * The three-state probe answers exactly one question — "can this user manager be
 * used safely right now?" — never "is a Host alive?". Only a strictly
 * corroborated absence falls back to the existing detached process spawn; every
 * other failure is the stable `HOST_MANAGER_ERROR` and never degrades.
 *
 * @module app/remote-process/local-host-manager
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
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
  unlinkSync,
  writeSync,
} from 'node:fs'
import { userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { LocalScopeError, type LocalScope } from './local-scope.ts'

/** The fixed OS executable this module controls the user manager through. */
const SYSTEMCTL = '/usr/bin/systemctl'
/** Hard bound on one `systemctl` invocation. */
const SYSTEMCTL_TIMEOUT_MS = 5_000
/** Hard cap on captured stdout/stderr bytes per invocation. */
const SYSTEMCTL_MAX_OUTPUT_BYTES = 64 * 1024
/** The user unit subdirectory below the account home. */
const USER_UNIT_SUBDIR = ['.config', 'systemd', 'user'] as const
/** The unit owner metadata marker. */
const UNIT_OWNER_MARKER = 'local-host-manager-v1'
/** Bound on the post-`daemon-reload` LoadState re-query window. */
const UNIT_LOAD_WAIT_MS = 3_000
/** Bound on the per-attempt LoadState poll interval. */
const UNIT_LOAD_POLL_MS = 100

/** One `systemctl` outcome; only `exited` carries a real process exit. */
export type SystemctlResult =
  | { readonly kind: 'exited'; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'spawn-error'; readonly error: NodeJS.ErrnoException }
  | { readonly kind: 'output-overflow' }

/** Whether the current user manager can be used safely right now (never Host readiness). */
export type UserManagerProbe =
  | { readonly kind: 'available' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'error'; readonly reason: string }

/** The facts one pure classification decision is derived from. */
export interface UserManagerProbeFacts {
  readonly systemctl: SystemctlResult
  /** `/run/user/<uid>/systemd/private` exists (a live user-manager endpoint). */
  readonly managerPrivatePresent: boolean
  /** `/run/user/<uid>/bus` exists (the user bus socket). */
  readonly userBusPresent: boolean
  /** `user@<uid>.service` state as the SYSTEM manager reports it. */
  readonly systemdUserServiceState: 'active' | 'inactive' | 'unknown'
}

/** The installed facts a managed Host start needs; the same shape the process fallback reads. */
export interface HostStartOptions {
  readonly scope: LocalScope
  /** Installed `dist/local-host.mjs` of this same package. */
  readonly hostEntryPath: string
  /** Installed `@deepseek-ai/dsh/package.json` anchor. */
  readonly dshAnchor: string
  /** Installed profile name. */
  readonly profile: string
}

/** The validated facts ONE unit file is rendered from. */
export interface UnitFacts {
  readonly dshHome: string
  readonly profileRealpath: string
  readonly profile: string
  readonly scopeId: string
  readonly buildId: string
  readonly nodePath: string
  readonly hostEntryPath: string
  readonly dshAnchor: string
}

/** The stable observation returned by a Host start request (never readiness). */
export type HostStartObservation = () => Error | undefined

/** Replace absolute paths so a probe reason never leaks a private path. */
function sanitizeReason(text: string): string {
  const line = text.split(/\r?\n/u).map(part => part.trim()).find(part => part !== '') ?? ''
  return line.replace(/\/[^\s"']+/gu, '<path>').slice(0, 200)
}

function probeError(reason: string): UserManagerProbe {
  return { kind: 'error', reason }
}

/**
 * A DEFINITIVE statement that this host has no systemd at all (systemctl exists
 * but systemd is not PID 1). With no live manager endpoint this proves absence
 * without needing a system-manager query.
 */
function isNoSystemdInit(text: string): boolean {
  return /System has not been booted with systemd as init system/iu.test(text)
}

/**
 * An explicit "there is no user bus/manager for this uid" failure. The message
 * must name the missing bus/medium explicitly — a generic connect refusal
 * (permission denied, connection refused, timeout) is NOT absence and is
 * rejected by `isUnusableManagerError` first.
 */
function isExplicitNoUserBus(text: string): boolean {
  return /No medium found/iu.test(text)
    || /Failed to connect to bus: No such file or directory/iu.test(text)
    || /Failed to connect to bus: No medium/iu.test(text)
    || /Failed to connect to (?:the )?user scope bus: No such file or directory/iu.test(text)
    || /Failed to connect to (?:the )?user scope bus: No medium/iu.test(text)
}

/** A manager channel that exists but cannot be used: always a hard error. */
function isUnusableManagerError(text: string): boolean {
  return /Permission denied/iu.test(text)
    || /Access denied/iu.test(text)
    || /Connection refused/iu.test(text)
    || /Connection timed out/iu.test(text)
    || /Protocol error/iu.test(text)
    || /Too many levels of symbolic links/iu.test(text)
    || /Transport endpoint is not connected/iu.test(text)
}

/**
 * The pure three-state classifier. It answers only "can the user manager be
 * used safely", from the observed probe outcome plus the corroborating kernel
 * endpoint facts. A present-but-unusable manager is a stable `error`; only a
 * corroborated absence falls back. Absence is proven in two independent ways:
 * (a) the fixed `systemctl` binary is missing (ENOENT) or systemd is not the
 * init system — a definitive "no systemd" statement — with no live endpoint;
 * (b) an explicit no-user-bus failure with no live endpoint and a system
 * manager that reports `user@<uid>.service` as `inactive`/`not-found`. Any
 * unconfirmed or contradictory state is `error`.
 */
export function classifyUserManagerProbe(facts: UserManagerProbeFacts): UserManagerProbe {
  const { systemctl } = facts
  if (systemctl.kind === 'timeout') return probeError('the user manager probe timed out')
  if (systemctl.kind === 'output-overflow') return probeError('the user manager probe output exceeded the limit')
  const endpointsPresent = facts.managerPrivatePresent || facts.userBusPresent
  const corroborateAbsence = (definitive: boolean): UserManagerProbe => {
    if (endpointsPresent) return probeError('the user manager endpoint exists but is not usable')
    if (facts.systemdUserServiceState === 'active') return probeError('the system manager reports a live user service')
    if (definitive) return { kind: 'absent' }
    if (facts.systemdUserServiceState === 'inactive') return { kind: 'absent' }
    return probeError('cannot confirm the user manager is absent; treating it as unavailable')
  }
  if (systemctl.kind === 'spawn-error') {
    // The fixed systemctl cannot run. Only a MISSING binary (ENOENT) can prove a
    // no-systemd host; any other spawn failure (EACCES, ...) stays a hard error.
    if (systemctl.error.code === 'ENOENT') return corroborateAbsence(true)
    return probeError('the fixed systemctl executable could not be spawned')
  }
  if (systemctl.code === 0) return { kind: 'available' }
  const combined = `${systemctl.stderr}\n${systemctl.stdout}`
  if (isUnusableManagerError(combined)) {
    return probeError(`systemctl --user cannot be used: ${sanitizeReason(combined)}`)
  }
  if (isNoSystemdInit(combined)) return corroborateAbsence(true)
  if (isExplicitNoUserBus(combined)) return corroborateAbsence(false)
  const detail = sanitizeReason(combined)
  return probeError(`systemctl --user failed: ${detail === '' ? 'non-zero exit' : detail}`)
}

/** The user runtime directory to hand to a child `systemctl`. */
function selectRuntimeDir(uid: number): string | undefined {
  const standard = `/run/user/${String(uid)}`
  try {
    const info = lstatSync(standard)
    if (info.isDirectory() && !info.isSymbolicLink() && info.uid === uid) return standard
  } catch {
    // No standard runtime dir; fall through to the ambient environment.
  }
  const ambient = process.env.XDG_RUNTIME_DIR
  if (ambient !== undefined && ambient !== '') return ambient
  return undefined
}

function systemctlEnv(runtimeDir: string | undefined): NodeJS.ProcessEnv {
  if (runtimeDir === undefined) return { ...process.env }
  return { ...process.env, XDG_RUNTIME_DIR: runtimeDir }
}

/**
 * Run exactly one fixed `systemctl` invocation: `shell: false`, an absolute
 * binary path, a hard timeout, bounded output and a fully reaped child.
 */
export function runSystemctl(args: readonly string[], runtimeDir: string | undefined): Promise<SystemctlResult> {
  return new Promise<SystemctlResult>(resolve => {
    let settled = false
    let stdout = ''
    let stderr = ''
    let overflow = false
    const settle = (result: SystemctlResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child
    try {
      child = spawn(SYSTEMCTL, [...args], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: systemctlEnv(runtimeDir),
      })
    } catch (error) {
      settle({ kind: 'spawn-error', error: error as NodeJS.ErrnoException })
      return
    }
    const timer = setTimeout(() => {
      overflow = false
      child.kill('SIGKILL')
      settle({ kind: 'timeout' })
    }, SYSTEMCTL_TIMEOUT_MS)
    const collect = (current: string, chunk: Buffer): string => {
      if (overflow) return current
      const next = current + chunk.toString('utf8')
      if (Buffer.byteLength(next, 'utf8') > SYSTEMCTL_MAX_OUTPUT_BYTES) {
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

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/** Map the system manager's `user@<uid>.service` state onto the classify input. */
function parseUserServiceState(result: SystemctlResult): 'active' | 'inactive' | 'unknown' {
  if (result.kind !== 'exited' || result.code !== 0) return 'unknown'
  const match = /^ActiveState=(\S+)$/mu.exec(result.stdout)
  if (match === null) return 'unknown'
  switch (match[1]) {
    case 'active':
    case 'activating':
    case 'deactivating':
    case 'reloading':
    case 'failed':
      return 'active'
    case 'inactive':
    case 'not-found':
      return 'inactive'
    default:
      return 'unknown'
  }
}

/** Gather the real probe facts and classify the user manager three-state. */
export async function probeUserManager(
  deps: { readonly systemctl?: SystemctlRunner; readonly pathExists?: (path: string) => boolean } = {},
): Promise<UserManagerProbe> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (process.platform !== 'linux' || uid === undefined) {
    throw new LocalScopeError('B1_PLATFORM_UNSUPPORTED', 'managed Host: the user manager probe requires Linux')
  }
  const run = deps.systemctl ?? runSystemctl
  const exists = deps.pathExists ?? pathExists
  const runtimeDir = selectRuntimeDir(uid)
  const systemctl = await run(['--user', '--no-pager', '--no-ask-password', 'show-environment'], runtimeDir)
  // A real request to the user manager already succeeded: nothing else is needed.
  if (systemctl.kind === 'exited' && systemctl.code === 0) return { kind: 'available' }
  const serviceState = await run(
    ['--system', '--no-pager', '--no-ask-password', 'show', '-p', 'ActiveState', `user@${String(uid)}.service`],
    undefined,
  )
  return classifyUserManagerProbe({
    systemctl,
    managerPrivatePresent: exists(`/run/user/${String(uid)}/systemd/private`),
    userBusPresent: exists(`/run/user/${String(uid)}/bus`),
    systemdUserServiceState: parseUserServiceState(serviceState),
  })
}

/** Reject any control character that could inject a second unit directive. */
function assertUnitSafe(value: string, label: string): void {
  if (value.includes('\0') || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the ${label} contains a control character`)
  }
}

/**
 * Encode one value for a systemd unit directive. Specifier expansion (`%`) is
 * universal, so `%` becomes `%%` everywhere; `$` variable substitution only
 * applies to command lines (`ExecStart`), so it becomes `$$` only there. Values
 * are wrapped in double quotes with the C-style backslash/quote escapes systemd
 * honours inside double quotes.
 */
export function encodeUnitValue(value: string, label: string, commandLine: boolean): string {
  assertUnitSafe(value, label)
  let out = ''
  for (const character of value) {
    switch (character) {
      case '\\': out += '\\\\'; break
      case '"': out += '\\"'; break
      case '%': out += '%%'; break
      case '$': out += commandLine ? '$$' : '$'; break
      default: out += character
    }
  }
  return `"${out}"`
}

/**
 * Encode a single systemd PATH directive (`WorkingDirectory`). Unlike command
 * lines and `Environment=`, a path setting is parsed as ONE raw value: double
 * quotes are NOT stripped, so a quoted path is a different (wrong) path. `%`
 * specifiers still expand (`%%` for a literal `%`) and a literal backslash must
 * be doubled; a `"` cannot appear unquoted without changing the parse, so it is
 * refused rather than silently corrupting the unit.
 */
export function encodeUnitPath(value: string, label: string): string {
  assertUnitSafe(value, label)
  if (value.includes('"')) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the ${label} must not contain a double quote`)
  }
  let out = ''
  for (const character of value) {
    switch (character) {
      case '\\': out += '\\\\'; break
      case '%': out += '%%'; break
      default: out += character
    }
  }
  return out
}

/**
 * Encode a systemd `Environment=` assignment (`KEY=VALUE`): the value uses the
 * no-variable-substitution rules (a literal `$` stays `$`), specifiers escape.
 */
function encodeEnvironment(key: string, value: string): string {
  return `Environment=${encodeUnitValue(`${key}=${value}`, `environment ${key}`, false)}`
}

/** The deterministic profile-identity digest stored in the unit owner metadata. */
export function profileIdentityDigest(profileRealpath: string): string {
  return createHash('sha256').update(`dsh-pi-tui/profile-identity/1\0${profileRealpath}`).digest('hex')
}

/**
 * Build the readable, ASCII-safe profile slug used ONLY in the unit file name.
 * Full scopeId ownership is always validated separately; the slug never grants
 * ownership. Non-ASCII or unsafe characters become `_`; the first character is
 * prefixed with `p` when it is not alphanumeric; the result is bounded to 32.
 */
export function profileUnitSlug(profile: string): string {
  let slug = ''
  for (const character of profile) slug += /[A-Za-z0-9_.-]/u.test(character) ? character : '_'
  if (slug === '') slug = 'profile'
  if (!/[A-Za-z0-9]/u.test(slug[0] as string)) slug = `p${slug}`
  if (slug.length > 32) slug = slug.slice(0, 32)
  return slug
}

/** The stable unit name for one (profile, scopeId) pair. */
export function buildUnitName(profile: string, scopeId: string): string {
  return `dsh-pi-tui@${profileUnitSlug(profile)}-${scopeId.slice(0, 16)}.service`
}

/** Render the complete, fixed unit file for one installed Host. */
export function renderUnitContent(facts: UnitFacts): string {
  const lines = [
    '[Unit]',
    'Description=dsh-pi-tui local Host (profile-scoped)',
    `X-DshPiTuiOwner=${UNIT_OWNER_MARKER}`,
    `X-DshPiTuiScopeId=${facts.scopeId}`,
    `X-DshPiTuiProfileIdentity=${profileIdentityDigest(facts.profileRealpath)}`,
    `X-DshPiTuiInstallBuild=${facts.buildId}`,
    'StartLimitIntervalSec=60s',
    'StartLimitBurst=3',
    '',
    '[Service]',
    'Type=exec',
    `ExecStart=${encodeUnitValue(facts.nodePath, 'node path', true)} ${encodeUnitValue(facts.hostEntryPath, 'Host entry path', true)}`,
    `WorkingDirectory=${encodeUnitPath(facts.profileRealpath, 'WorkingDirectory')}`,
    encodeEnvironment('DSH_HOME', facts.dshHome),
    encodeEnvironment('SPLIT_PROCESS_DSH_ANCHOR', facts.dshAnchor),
    encodeEnvironment('SPLIT_PROCESS_PROFILE', facts.profile),
    'Restart=on-failure',
    'RestartSec=2s',
    'TimeoutStopSec=15s',
    'KillMode=control-group',
    'StandardOutput=journal',
    'StandardError=journal',
    '',
  ]
  return lines.join('\n')
}

/** A validated installed fact (regular file, no symlink, owned by this uid). */
function inspectOwnedRegular(path: string, label: string, uid: number): string {
  let real: string
  try {
    real = realpathSync(path)
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the ${label} is not readable`, error)
  }
  const info = lstatSync(real)
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== uid) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the ${label} must be a regular file owned by uid ${String(uid)}`)
  }
  return real
}

/**
 * Validate a trusted EXECUTABLE the unit will run (the Node interpreter). Its
 * trust is "an absolute, canonical, executable regular file", NOT "owned by this
 * uid": a system Node such as `/usr/bin/node` is normally root-owned yet a
 * normal user may run it. Only the product-private Host entry is held to the
 * uid-ownership rule; the official DSH anchor has its own trust rule below.
 */
export function inspectTrustedExecutable(path: string, label: string): string {
  let real: string
  try {
    real = realpathSync(path)
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the ${label} is not readable`, error)
  }
  const info = lstatSync(real)
  if (info.isSymbolicLink() || !info.isFile() || (info.mode & 0o111) === 0) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the ${label} must be an executable regular file`)
  }
  return real
}

/**
 * Validate the official DSH install anchor (`@deepseek-ai/dsh/package.json`).
 * Its trust is "a readable, canonical, non-group/other-writable regular file
 * declaring the exact `@deepseek-ai/dsh` package and the pinned runtime version"
 * — NOT uid ownership: a normal user may run against a root-owned, system-wide
 * DSH install. The caller checks the package identity and exact version pin.
 */
export function inspectTrustedDshAnchor(path: string): string {
  let real: string
  try {
    real = realpathSync(path)
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the DSH anchor is not readable', error)
  }
  const info = lstatSync(real)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the DSH anchor must be a regular file')
  }
  if ((info.mode & 0o022) !== 0) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the DSH anchor must not be group/other writable')
  }
  return real
}

/** Collect and validate the exact installed facts one unit is rendered from. */
function collectUnitFacts(options: HostStartOptions, uid: number): UnitFacts {
  // The Node interpreter is a system executable: trust absolute + executable,
  // never uid ownership (a root-owned /usr/bin/node must work for a normal user).
  const nodePath = inspectTrustedExecutable(process.execPath, 'node executable')
  // The Host entry and DSH anchor are product-private files installed under the
  // user's own profile, so they keep the strict uid-ownership rule.
  const hostEntryPath = inspectOwnedRegular(options.hostEntryPath, 'Host entry', uid)
  // The DSH anchor is the OFFICIAL install anchor (may be a root-owned system
  // install), so it is trusted by package identity + pinned version + safe
  // permissions, not by uid ownership.
  const dshAnchor = inspectTrustedDshAnchor(options.dshAnchor)
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(dshAnchor, 'utf8'))
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the DSH anchor manifest is unreadable', error)
  }
  if (manifest === null || typeof manifest !== 'object' || (manifest as { readonly name?: unknown }).name !== '@deepseek-ai/dsh') {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the DSH anchor is not @deepseek-ai/dsh')
  }
  if ((manifest as { readonly version?: unknown }).version !== options.scope.dshVersion) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the DSH anchor version does not match the installed runtime pin')
  }
  return {
    dshHome: options.scope.dshHome,
    profileRealpath: options.scope.profileRealpath,
    profile: options.profile,
    scopeId: options.scope.scopeId,
    buildId: options.scope.buildId,
    nodePath,
    hostEntryPath,
    dshAnchor,
  }
}

/** Walk one owned directory chain, creating missing 0700 components and refusing symlinks. */
/**
 * Walk one owned directory chain, creating missing 0700 components, refusing
 * symlinks, foreign owners, AND any existing component that group/other can
 * write. A writable parent lets another local user delete and replace the unit
 * file after we validate it, so the write bit is part of the ownership check.
 */
export function ensureOwnedUnitDir(home: string, uid: number): string {
  let current = home
  for (const component of USER_UNIT_SUBDIR) {
    const next = join(current, component)
    let info
    try {
      info = lstatSync(next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the unit directory ${component} is not accessible`, error)
      }
      try {
        mkdirSync(next, { mode: 0o700 })
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the unit directory ${component} could not be created`, mkdirError)
        }
      }
      info = lstatSync(next)
    }
    if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid) {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the unit directory ${component} must be a real directory owned by uid ${String(uid)}`)
    }
    if ((info.mode & 0o022) !== 0) {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the unit directory ${component} must not be group/other writable`)
    }
    current = next
  }
  return current
}

/** Resolve the real user unit directory under the account home (never a Client HOME). */
export function resolveUserUnitDir(uid: number): string {
  let home: string
  try {
    home = realpathSync(userInfo().homedir)
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the account home is not readable', error)
  }
  const info = lstatSync(home)
  if (info.isSymbolicLink() || !info.isDirectory() || info.uid !== uid) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the account home must be a real directory owned by uid ${String(uid)}`)
  }
  if ((info.mode & 0o022) !== 0) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the account home must not be group/other writable')
  }
  return ensureOwnedUnitDir(home, uid)
}

function canonicalPath(path: string): string {
  try { return realpathSync(path) } catch { return resolve(path) }
}

/** Parse a `systemctl --user show-environment` body into a KEY->value map. */
export function parseManagerEnvironment(stdout: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) env[line.slice(0, at)] = line.slice(at + 1)
  }
  return env
}

/**
 * The user-unit directory the manager actually searches, from the MANAGER's own
 * environment: `$XDG_CONFIG_HOME/systemd/user` when XDG_CONFIG_HOME is set to a
 * non-default value, else `<accountHome>/.config/systemd/user`.
 */
export function managerUserUnitDir(managerEnv: Record<string, string>, accountHome: string): string {
  const configHome = managerEnv.XDG_CONFIG_HOME !== undefined && managerEnv.XDG_CONFIG_HOME !== ''
    ? managerEnv.XDG_CONFIG_HOME
    : join(accountHome, '.config')
  return join(configHome, 'systemd', 'user')
}

/**
 * Why the fixed plan install directory is NOT the manager's real user-unit
 * search directory (stable reason string), or `null` when it matches. A custom
 * `SYSTEMD_UNIT_PATH` overrides the whole search path and is unsupported by the
 * fixed plan contract. When this returns a reason the caller MUST fail closed
 * BEFORE writing a unit that the manager would never load.
 */
export function userUnitPathUnsupportedReason(managerEnv: Record<string, string>, accountHome: string, targetDir: string): string | null {
  const unitPath = managerEnv.SYSTEMD_UNIT_PATH
  if (unitPath !== undefined && unitPath.trim() !== '') return 'the user manager sets a custom SYSTEMD_UNIT_PATH'
  const expected = managerUserUnitDir(managerEnv, accountHome)
  if (canonicalPath(expected) !== canonicalPath(targetDir)) return 'the user manager searches $XDG_CONFIG_HOME/systemd/user, not the fixed home path'
  return null
}

/** The result of one atomic unit installation. */
export interface UnitInstallResult {
  /** True when THIS call created the unit file; false when an identical one existed. */
  readonly created: boolean
}

/** Read a controlled existing unit file strictly (0600 regular file owned by uid, no symlink). */
function readOwnedUnitFile(path: string, uid: number): string {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== uid || (info.mode & 0o777) !== 0o600) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: ${path} is not a 0600 regular file owned by uid ${String(uid)}`)
  }
  return readFileSync(path, 'utf8')
}

/**
 * Atomically install ONE unit file: write a private 0600 temp, `fsync`, then
 * `linkSync` it into place so an existing file is never overwritten. Two
 * concurrent identical installs converge on byte-identical content; any
 * pre-existing byte difference is `HOST_MANAGER_UNIT_CONFLICT` and is left
 * untouched.
 */
export function installProfileUnit(options: {
  readonly unitDir: string
  readonly unitName: string
  readonly content: string
  readonly uid: number
}): UnitInstallResult {
  const finalPath = join(options.unitDir, options.unitName)
  const tempPath = join(options.unitDir, `.${options.unitName}.${String(process.pid)}.${randomUUID()}.tmp`)
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
    try { unlinkSync(tempPath) } catch { /* temp may not exist */ }
    if (error instanceof LocalScopeError) throw error
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: the unit temp file could not be written', error)
  }
  let created = false
  try {
    linkSync(tempPath, finalPath)
    created = true
  } catch (linkError) {
    if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') {
      try { unlinkSync(tempPath) } catch { /* temp may not exist */ }
      throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: the unit could not be installed atomically', linkError)
    }
    // A concurrent or earlier install won the name: it must be OUR identical unit.
    const existing = readOwnedUnitFile(finalPath, options.uid)
    if (existing !== options.content) {
      try { unlinkSync(tempPath) } catch { /* temp may not exist */ }
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: an existing unit has a different owner metadata or install build')
    }
  } finally {
    try { unlinkSync(tempPath) } catch { /* temp may already be gone */ }
  }
  return { created }
}

/** One parsed `systemctl show` property set for the target unit. */
export interface UnitLoadState {
  readonly loadState: string
  readonly activeState: string
  readonly fragmentPath: string
  /** The drop-in override paths the manager actually loaded (empty when none). */
  readonly dropInPaths: string
}

/** The injectable `systemctl` runner shape (production uses `runSystemctl`). */
export type SystemctlRunner = (args: readonly string[], runtimeDir: string | undefined) => Promise<SystemctlResult>

/** Narrow test seam for the start orchestration; production omits it. */
export interface HostManagerDeps {
  readonly probe?: () => Promise<UserManagerProbe>
  readonly unitDir?: (uid: number) => string
  readonly systemctl?: SystemctlRunner
}

/** Run `systemctl --user show -p ... <unit>` and parse the properties. */
async function showUnit(unitName: string, runtimeDir: string | undefined, systemctl: SystemctlRunner): Promise<UnitLoadState> {
  const result = await systemctl(
    ['--user', '--no-pager', '--no-ask-password', 'show', '-p', 'LoadState', '-p', 'ActiveState', '-p', 'FragmentPath', '-p', 'DropInPaths', unitName],
    runtimeDir,
  )
  if (result.kind !== 'exited' || result.code !== 0) {
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: the unit state could not be queried')
  }
  const read = (key: string): string => {
    const match = new RegExp(`^${key}=(.*)$`, 'mu').exec(result.stdout)
    return match === null ? '' : match[1].trim()
  }
  return {
    loadState: read('LoadState'),
    activeState: read('ActiveState'),
    fragmentPath: read('FragmentPath'),
    dropInPaths: read('DropInPaths'),
  }
}

/**
 * Verify the manager actually loads THIS controlled target from THIS file and
 * from NO drop-in override. A `FragmentPath` alone is not enough: a same-named
 * `*.d/*.conf` drop-in can override `ExecStart`/`Environment`/`Restart` while
 * `FragmentPath` still names our owned file, so any loaded drop-in is a
 * `HOST_MANAGER_UNIT_CONFLICT` and the manager is never started.
 */
function assertUnitOwned(state: UnitLoadState, finalPath: string): void {
  if (state.loadState === '' || state.loadState === 'not-found') {
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: the installed unit is not loaded by the manager')
  }
  if (state.fragmentPath === '') {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the manager reported no FragmentPath for the unit')
  }
  let realFragment: string
  try {
    realFragment = realpathSync(state.fragmentPath)
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the manager FragmentPath is not a readable file', error)
  }
  if (realFragment !== realpathSync(finalPath)) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the manager loaded a different unit file than the installed target')
  }
  const dropIns = state.dropInPaths.split(/\s+/u).filter(path => path !== '')
  if (dropIns.length > 0) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the loaded unit has one or more drop-in overrides')
  }
}

async function waitForUnitLoaded(unitName: string, runtimeDir: string | undefined, systemctl: SystemctlRunner): Promise<UnitLoadState> {
  const deadline = Date.now() + UNIT_LOAD_WAIT_MS
  for (;;) {
    const state = await showUnit(unitName, runtimeDir, systemctl)
    if (state.loadState !== 'not-found') return state
    if (Date.now() >= deadline) return state
    await new Promise(resolve => setTimeout(resolve, UNIT_LOAD_POLL_MS))
  }
}

/**
 * Start ONE managed Host candidate for the public daemon path. The user manager
 * is probed first: a strict absence uses the exact process fallback; any error
 * or unit conflict is thrown and NEVER degrades. On the manager path the unit is
 * atomically installed, verified through the real `FragmentPath`/`LoadState`,
 * then `systemctl start` merely submits the request — the caller still proves
 * Host readiness through the authenticated handshake.
 */
export async function startManagedHostCandidate(
  options: HostStartOptions,
  deps: HostManagerDeps = {},
): Promise<HostStartObservation> {
  const probe = await (deps.probe ?? probeUserManager)()
  if (probe.kind === 'error') {
    throw new LocalScopeError('HOST_MANAGER_ERROR', `managed Host: ${probe.reason}`)
  }
  if (probe.kind === 'absent') {
    return spawnHostCandidate(options)
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid === undefined) throw new LocalScopeError('B1_PLATFORM_UNSUPPORTED', 'managed Host: the user id is unavailable')
  const systemctl = deps.systemctl ?? runSystemctl
  const runtimeDir = selectRuntimeDir(uid)
  const facts = collectUnitFacts(options, uid)
  const unitDir = (deps.unitDir ?? resolveUserUnitDir)(uid)
  // The fixed plan path (<account-home>/.config/systemd/user) must be exactly the
  // directory this manager searches. A custom XDG_CONFIG_HOME or SYSTEMD_UNIT_PATH
  // would make the written unit unloadable, so fail closed BEFORE writing. Test
  // seams (deps) bypass this real-manager query.
  if (deps.probe === undefined && deps.unitDir === undefined) {
    const environment = await systemctl(['--user', '--no-pager', '--no-ask-password', 'show-environment'], runtimeDir)
    if (environment.kind !== 'exited' || environment.code !== 0) {
      throw new LocalScopeError('HOST_MANAGER_ERROR', 'managed Host: the user manager environment could not be queried')
    }
    const unsupported = userUnitPathUnsupportedReason(
      parseManagerEnvironment(environment.stdout),
      canonicalPath(userInfo().homedir),
      unitDir,
    )
    if (unsupported !== null) {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the plan-supported user unit path is not the manager's search path (${unsupported})`)
    }
  }
  const unitName = buildUnitName(options.profile, options.scope.scopeId)
  const content = renderUnitContent(facts)
  const finalPath = join(unitDir, unitName)
  const installed = installProfileUnit({ unitDir, unitName, content, uid })
  let state = await showUnit(unitName, runtimeDir, systemctl)
  if (installed.created || state.loadState === 'not-found') {
    const reload = await systemctl(['--user', '--no-pager', '--no-ask-password', 'daemon-reload'], runtimeDir)
    if (reload.kind !== 'exited' || reload.code !== 0) {
      throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: systemctl daemon-reload failed after the unit install')
    }
    state = await waitForUnitLoaded(unitName, runtimeDir, systemctl)
  }
  assertUnitOwned(state, finalPath)
  const start = await systemctl(['--user', '--no-pager', '--no-ask-password', 'start', unitName], runtimeDir)
  if (start.kind !== 'exited' || start.code !== 0) {
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: systemctl could not start the unit')
  }
  return () => undefined
}

/**
 * Start one Host candidate as a detached OS process. This is the EXACT
 * pre-existing fallback moved here unchanged: a private 0600 `host.log`, the
 * validated Node/Host entry, `cwd` the canonical profile, detach/unref, and the
 * role/extra-patch markers cleared. It is used for the strict `absent` manager
 * probe and for the legacy internal qualification/peer/manual paths; it has no
 * periodic auto-restart (that is systemd-only) and never claims one.
 */
export function spawnHostCandidate(options: HostStartOptions): HostStartObservation {
  let info
  try {
    info = lstatSync(options.hostEntryPath)
  } catch (error) {
    throw new LocalScopeError('HOST_START_FAILED', 'managed Host: the installed Host entry is not readable', error)
  }
  if (info.isSymbolicLink() || !info.isFile() || info.uid !== process.getuid?.()) {
    throw new LocalScopeError('HOST_START_FAILED', 'managed Host: the installed Host entry must be a regular file owned by this uid')
  }
  const logPath = join(options.scope.dir, 'host.log')
  let fd: number | undefined
  try {
    fd = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
    fchmodSync(fd, 0o600)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SPLIT_PROCESS_DSH_ANCHOR: options.dshAnchor,
      SPLIT_PROCESS_PROFILE: options.profile,
    }
    delete env.SPLIT_PROCESS_EXTRA_PATCH
    delete env.DSH_PI_TUI_ROLE
    delete env.DSH_PI_TUI_HOST_ENTRY
    // A one-shot public backend selector belongs to the launching Client only; it
    // must never reach the Host process this fallback starts.
    delete env.DSH_PI_TUI_BACKEND
    const child = spawn(process.execPath, [options.hostEntryPath], {
      cwd: options.scope.profileRealpath,
      detached: true,
      stdio: ['ignore', fd, fd],
      env,
    })
    let spawnFailure: Error | undefined
    child.once('error', error => { spawnFailure = error })
    child.unref()
    return () => spawnFailure
  } catch (error) {
    if (error instanceof LocalScopeError) throw error
    throw new LocalScopeError('HOST_START_FAILED', 'managed Host: the Host candidate could not be spawned', error)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
