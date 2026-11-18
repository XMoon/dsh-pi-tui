/**
 * Profile-aware Host lifecycle: the basic detached process and the explicit
 * systemd user-service install.
 *
 * The basic Linux daemon is an independent Host process. A public cold start
 * inspects whether THIS profile has an installed unit first: no unit means
 * `spawnHostCandidate()` immediately, with no user-manager probe at all; an
 * installed, manager-loaded unit means one fixed `systemctl --user start`.
 * `installProfileHostUnit()` is the ONLY path that writes a unit, installs it
 * atomically, asks the real user manager to load it and verifies the manager's
 * `FragmentPath`/`LoadState`; it never starts, stops, enables or restarts
 * anything.
 *
 * `systemctl`/`journalctl` are invoked through the system PATH with fixed
 * argument arrays. A missing command can only affect the explicit service-
 * managed branch; the detached Host never depends on it.
 *
 * This module never imports `app/bootstrap.ts`, Cordis, the Web or a Session
 * service, and it creates no manager store, daemon or public API: the Host's
 * official 0700 scope directory, abstract kernel seat, authenticated identity
 * and `runProfile` shutdown owner are all unchanged. A `systemctl start` here
 * only means the manager accepted a request; readiness is still proven later by
 * the existing authenticated Host handshake in `local-discovery.ts`.
 *
 * @module app/remote-process/local-host-manager
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
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
import { userInfo } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installedPackageRootFromEntry, LocalScopeError, type LocalScope } from './local-scope.ts'
import {
  inspectOwnedLaunchdUnit,
  startLaunchdService,
  type LaunchdAdapterDeps,
  type LaunchdUnitFacts,
} from './local-host-launchd.ts'

/** The system manager executable resolved through PATH (distribution-agnostic). */
const SYSTEMCTL = 'systemctl'
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

/** The installed facts a managed Host start needs; the same shape the process fallback reads. */
export interface HostStartOptions {
  readonly scope: LocalScope
  /** Installed `dist/local-host.mjs` of this same package. */
  readonly hostEntryPath: string
  /** Installed `@deepseek-ai/dsh/package.json` anchor. */
  readonly dshAnchor: string
  /** Installed profile name. */
  readonly profile: string
  /** The public start policy. Only `public` may consult an installed manager
   *  job; internal/peer/reexec launches keep the detached process path. */
  readonly hostStartPolicy?: 'public' | 'public-managed'
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

/** The readiness request returned by a managed start; it is never readiness itself. */
export type HostStartObservation = () => Error | undefined

/** The user runtime directory to hand to a child `systemctl`. */
export function selectRuntimeDir(uid: number): string | undefined {
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

/**
 * Prove one built entry can locate its own installed product package root from
 * its REAL module URL. The preflight accepts a shared-store/dist symlink only
 * when the spawned process will be able to do the same.
 */
function assertEntrySelfLocation(
  entryPath: string,
  code: 'HOST_MANAGER_UNIT_CONFLICT' | 'HOST_START_FAILED',
  label: string,
): void {
  try {
    installedPackageRootFromEntry(pathToFileURL(entryPath).href)
  } catch (error) {
    throw new LocalScopeError(code, `managed Host: the ${label} cannot locate its installed package root`, error)
  }
}

/**
 * A validated installed fact: a canonical regular file. The user's install
 * layout (shared npm store, root-owned system package, legal entry symlink) is
 * not judged; only the real target file type is.
 */
function inspectOwnedRegular(path: string, label: string): string {
  let real: string
  try {
    real = realpathSync(path)
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the ${label} is not readable`, error)
  }
  const info = lstatSync(real)
  if (!info.isFile()) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the ${label} must be a regular file`)
  }
  return real
}

/**
 * Validate a trusted EXECUTABLE the unit will run (the Node interpreter). Its
 * trust is "an absolute, canonical, executable regular file", NOT "owned by this
 * uid": a system Node such as `/usr/bin/node` is normally root-owned yet a
 * normal user may run it.
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
 * Its trust is "a readable, canonical regular file declaring the exact
 * `@deepseek-ai/dsh` package and the pinned runtime version" — NOT uid,
 * mode or install layout: a normal user may run against a root-owned,
 * system-wide DSH install or a symlinked package store. The caller checks the
 * package identity and exact version pin.
 */
export function inspectTrustedDshAnchor(path: string): string {
  let real: string
  try {
    real = realpathSync(path)
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the DSH anchor is not readable', error)
  }
  const info = lstatSync(real)
  if (!info.isFile()) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the DSH anchor must be a regular file')
  }
  return real
}

/** Collect and validate the exact installed facts one unit is rendered from. */
export function collectUnitFacts(options: HostStartOptions): UnitFacts {
  // The Node interpreter is a system executable: trust absolute + executable.
  const nodePath = inspectTrustedExecutable(process.execPath, 'node executable')
  // The Host entry and DSH anchor are installed package files. A legal package
  // entry may be a symlink (shared npm store) or root-owned (system install), so
  // only the canonical regular target and the package identity are trusted.
  if (!isAbsolute(options.hostEntryPath)) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the Host entry path must be absolute')
  }
  inspectOwnedRegular(options.hostEntryPath, 'Host entry')
  assertEntrySelfLocation(options.hostEntryPath, 'HOST_MANAGER_UNIT_CONFLICT', 'Host entry')
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
    // Keep the INVOKED named entry (<root>/dist/local-host.mjs) so the Host can
    // locate its package root through a legal dist/entry symlink.
    hostEntryPath: options.hostEntryPath,
    dshAnchor,
  }
}

/**
 * Walk the user unit directory chain below the account home, creating missing
 * components 0700. Existing user components are used as-is: an existing real
 * directory or a resolvable directory symlink is accepted regardless of owner or
 * mode, and nothing is chmodded. Only "not accessible", "not a directory" and a
 * real filesystem failure are refused.
 */
export function ensureOwnedUnitDir(home: string): string {
  let current = home
  for (const component of USER_UNIT_SUBDIR) {
    const next = join(current, component)
    let real: string
    try {
      real = realpathSync(next)
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
      try {
        real = realpathSync(next)
      } catch (realpathError) {
        throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the unit directory ${component} is not accessible`, realpathError)
      }
    }
    if (!statSync(real).isDirectory()) {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the unit directory ${component} is not a directory`)
    }
    current = next
  }
  return current
}

/** The canonical account home (never a Client HOME). */
function accountHome(): string {
  let home: string
  try {
    home = realpathSync(userInfo().homedir)
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the account home is not readable', error)
  }
  if (!statSync(home).isDirectory()) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the account home is not a directory')
  }
  return home
}

/**
 * The fixed `<account-home>/.config/systemd/user` target WITHOUT creating it.
 * The manager UnitPath gate must run before ANY user-directory write; the
 * account-home spelling is kept (not realpathed) so the manager's own default
 * search path compares exactly even when the tail does not exist yet.
 */
function userUnitDirPath(): string {
  return join(userInfo().homedir, ...USER_UNIT_SUBDIR)
}

/**
 * Prove the RUNNING user manager is genuinely reachable BEFORE any unit write.
 * The manager's `UnitPath` is deliberately not used as a pre-write admission
 * gate: systemd omits still-empty directories from that property, so a clean
 * account's first install could never reach the mkdir. Manager reachability is
 * proven by a real bounded request; the POST-write `daemon-reload` plus the
 * real `LoadState`/`FragmentPath` verification decide whether the manager
 * loaded this exact file. A manager failure is a hard error and never falls
 * back to a detached process.
 */
async function assertUserManagerAvailable(
  runtimeDir: string | undefined,
  systemctl: SystemctlRunner,
): Promise<void> {
  const result = await systemctl(['--user', '--no-pager', '--no-ask-password', 'show', '-p', 'UnitPath', '--value'], runtimeDir)
  if (result.kind !== 'exited' || result.code !== 0) {
    throw new LocalScopeError('HOST_MANAGER_ERROR', 'managed Host: the user manager is not reachable')
  }
}

/** The result of one atomic unit installation. */
export interface UnitInstallResult {
  /** True when THIS call created the unit file; false when a target already existed. */
  readonly created: boolean
}

/**
 * Atomically install ONE default unit file. A pre-existing target is a user
 * configuration fact, not a template conflict: leave it byte-for-byte untouched
 * and let the later identity/FragmentPath checks decide whether this Profile may
 * manage it. Two concurrent creators still converge on exactly one winner.
 */
export function installProfileUnit(options: {
  readonly unitDir: string
  readonly unitName: string
  readonly content: string
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
    // Existing regular files and user-created symlinks are preserved. The
    // downstream identity inspection owns the authorization decision.
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
  /** The unit's current main PID (`0` when inactive or not reported). */
  readonly mainPid: string
  /** The manager's install state (`UnitFileState`), e.g. `disabled`/`enabled`. */
  readonly unitFileState: string
}

/** The injectable `systemctl` runner shape (production uses `runSystemctl`). */
export type SystemctlRunner = (args: readonly string[], runtimeDir: string | undefined) => Promise<SystemctlResult>

/** Narrow test seam for the start orchestration; production omits it. */
export interface HostManagerDeps {
  /** Explicit unit directory seam for structural tests; production uses the account home. */
  readonly unitDir?: (uid: number) => string
  readonly systemctl?: SystemctlRunner
  /** Explicit Darwin launchd seam for structural/native tests; production uses
   *  the real OS account home and `/bin/launchctl`. */
  readonly launchd?: LaunchdAdapterDeps
}

/** Run `systemctl --user show -p ... <unit>` and parse the properties. */
async function showUnit(unitName: string, runtimeDir: string | undefined, systemctl: SystemctlRunner): Promise<UnitLoadState> {
  const result = await systemctl(
    [
      '--user', '--no-pager', '--no-ask-password', 'show',
      '-p', 'LoadState',
      '-p', 'ActiveState',
      '-p', 'FragmentPath',
      '-p', 'MainPID',
      '-p', 'UnitFileState',
      unitName,
    ],
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
    mainPid: read('MainPID'),
    unitFileState: read('UnitFileState'),
  }
}

/** Verify the manager loaded this Profile's canonical unit target. */
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
  // Drop-ins are user-owned runtime configuration. systemd merges them;
  // their presence does not change this unit's identity.
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

// ── Daemon control: read-only ownership facts and the explicit narrow actions ──
//
// These are the ONLY management writes of the Host supervision boundary. They
// never create a Host, never run a Session/Agent and never replace the official
// Host shutdown owner: stop sends the manager's SIGTERM, uninstall removes only
// the verified profile unit path. Runtime configuration is never rewritten.

/** One profile unit path whose identity metadata belongs to this scope/profile. */
export interface OwnedProfileUnit {
  readonly unitName: string
  readonly unitDir: string
  /** The unit path as named by this Profile; it may be a user-created symlink. */
  readonly filePath: string
  readonly content: string
  readonly resolvedPath: string
  /** The install build the unit file declares; may differ from the current build. */
  readonly installBuild: string
  /** Canonical target identity captured for TOCTOU re-checks. */
  readonly device: number
  readonly inode: number
  /** Identity of the named unit path itself, including a symlink inode. */
  readonly pathDevice: number
  readonly pathInode: number
}

/** The read-only file ownership answer: this Profile's unit, or none at all. */
export type OwnedProfileUnitInspection =
  | { readonly kind: 'none' }
  | ({ readonly kind: 'owned' } & OwnedProfileUnit)

/** The manager facts of one owned profile unit (never Host readiness). */
export interface OwnedProfileUnitState {
  readonly loadState: string
  readonly activeState: string
  readonly mainPid: number
  readonly unitFileState: string
}

/** The outcome of one explicit stop attempt. */
export interface StopOwnedProfileUnitResult {
  /** True when a running unit was asked to stop and its main process exited. */
  readonly stopped: boolean
  /** True when the unit was already inactive; the caller reports an idempotent no-op. */
  readonly alreadyInactive: boolean
  /** The MainPID observed before the stop request (`0` when none). */
  readonly mainPid: number
}

/** The stable stop-settlement window (systemd TimeoutStopSec is 15s). */
const UNIT_STOP_TIMEOUT_MS = 20_000
/** Poll interval for the post-stop MainPID/ActiveState observation. */
const UNIT_STOP_POLL_MS = 100

/**
 * Resolve the fixed user unit directory WITHOUT creating it. The management
 * queries must be side-effect free, so this returns `undefined` when any
 * component of `<home>/.config/systemd/user` is missing. Existing user
 * components are not judged by owner/mode, and a resolvable directory symlink
 * is followed exactly like the account's own layout.
 */
export function inspectExistingUserUnitDir(): string | undefined {
  let home: string
  try {
    home = realpathSync(userInfo().homedir)
  } catch (error) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the account home is not readable', error)
  }
  if (!statSync(home).isDirectory()) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the account home is not a directory')
  }
  let current = home
  for (const component of USER_UNIT_SUBDIR) {
    const next = join(current, component)
    let real: string
    try {
      real = realpathSync(next)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the unit directory ${component} is not accessible`, error)
    }
    if (!statSync(real).isDirectory()) {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the unit directory ${component} is not a directory`)
    }
    current = next
  }
  return current
}

/** Read one exact `X-DshPiTui...` unit metadata value, rejecting duplicates. */
function readUnitMetadata(lines: readonly string[], key: string): string {
  const matches = lines.filter(line => line.startsWith(`${key}=`))
  if (matches.length !== 1) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', `managed Host: the unit has no single ${key} owner metadata line`)
  }
  return matches[0].slice(key.length + 1)
}

/** Read the named user unit and its regular canonical target without mutation. */
function readUnitFileIdentity(filePath: string): {
  readonly content: string
  readonly resolvedPath: string
  readonly pathDevice: number
  readonly pathInode: number
  readonly device: number
  readonly inode: number
} {
  try {
    const pathInfo = lstatSync(filePath)
    const resolvedPath = realpathSync(filePath)
    const target = lstatSync(resolvedPath)
    if (!target.isFile()) {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the unit target is not a regular configuration file')
    }
    return {
      content: readFileSync(resolvedPath, 'utf8'),
      resolvedPath,
      pathDevice: pathInfo.dev,
      pathInode: pathInfo.ino,
      device: target.dev,
      inode: target.ino,
    }
  } catch (error) {
    if (error instanceof LocalScopeError) throw error
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the unit configuration could not be read', error)
  }
}

/** Runtime directives belong to the user and systemd; only metadata proves scope. */
function inspectUnitIdentity(content: string, scope: LocalScope): string {
  const lines = content.split('\n')
  if (readUnitMetadata(lines, 'X-DshPiTuiOwner') !== UNIT_OWNER_MARKER) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the unit is not owned by this product')
  }
  if (readUnitMetadata(lines, 'X-DshPiTuiScopeId') !== scope.scopeId) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the unit belongs to another profile scope')
  }
  if (readUnitMetadata(lines, 'X-DshPiTuiProfileIdentity') !== profileIdentityDigest(scope.profileRealpath)) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the unit belongs to another canonical profile')
  }
  const installBuild = readUnitMetadata(lines, 'X-DshPiTuiInstallBuild')
  if (!/^[0-9a-f]{64}$/u.test(installBuild)) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the unit has no valid install build identity')
  }
  return installBuild
}

/** Compare this operation's observation, never the generated default template. */
function assertUnitFileIdentity(unit: OwnedProfileUnit): void {
  const current = readUnitFileIdentity(unit.filePath)
  if (current.pathDevice !== unit.pathDevice || current.pathInode !== unit.pathInode
    || current.resolvedPath !== unit.resolvedPath
    || current.device !== unit.device || current.inode !== unit.inode
    || current.content !== unit.content) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the profile unit file changed during the transition')
  }
}

/** Inspect the exact Profile unit path, following a user-created configuration link. */
export function inspectOwnedProfileUnit(scope: LocalScope, profile: string, unitDir?: string): OwnedProfileUnitInspection {
  const dir = unitDir ?? inspectExistingUserUnitDir()
  if (dir === undefined) return { kind: 'none' }
  const unitName = buildUnitName(profile, scope.scopeId)
  const filePath = join(dir, unitName)
  try {
    lstatSync(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'none' }
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the profile unit path is not accessible', error)
  }
  const file = readUnitFileIdentity(filePath)
  return { kind: 'owned', unitName, unitDir: dir, filePath,
    installBuild: inspectUnitIdentity(file.content, scope), ...file }
}

/**
 * Query the manager facts of ONE owned profile unit and cross-check that the
 * manager really loads THIS file, including a canonical symlink target. A `not-found`
 * LoadState is returned as such (the file exists but is not loaded); every
 * contradicting fact is an ownership refusal.
 */
export async function queryOwnedProfileUnit(
  unit: OwnedProfileUnit,
  runtimeDir: string | undefined,
  systemctl: SystemctlRunner,
): Promise<OwnedProfileUnitState> {
  const state = await showUnit(unit.unitName, runtimeDir, systemctl)
  if (state.loadState === 'not-found') {
    return { loadState: state.loadState, activeState: state.activeState, mainPid: 0, unitFileState: state.unitFileState }
  }
  assertUnitOwned(state, unit.resolvedPath)
  return {
    loadState: state.loadState,
    activeState: state.activeState,
    mainPid: Number(state.mainPid) === 0 ? 0 : Number(state.mainPid),
    unitFileState: state.unitFileState,
  }
}

/**
 * Stop ONE verified owned profile unit through the user manager and wait for
 * its original MainPID to actually disappear. This never falls back to a PID
 * signal: the manager is the only supervision authority. A timeout is the
 * stable `HOST_STOP_TIMEOUT`, never a claimed stop.
 */
export async function stopOwnedProfileUnit(
  unit: OwnedProfileUnit,
  runtimeDir: string | undefined,
  systemctl: SystemctlRunner,
  timeoutMs: number = UNIT_STOP_TIMEOUT_MS,
): Promise<StopOwnedProfileUnitResult> {
  const before = await queryOwnedProfileUnit(unit, runtimeDir, systemctl)
  // Only a state systemd itself reports as ENDED is a stop no-op. A transition
  // state (`activating`/`deactivating`/`reloading`) or an unrecognized state
  // must go through `systemctl stop` even with MainPID not yet assigned —
  // an `activating` unit with MainPID=0 can still finish starting a Host, and
  // returning early there would claim success while the Host comes up.
  const ended = before.activeState === 'inactive' || before.activeState === 'failed'
  if (ended) {
    return { stopped: false, alreadyInactive: true, mainPid: before.mainPid }
  }
  if (before.activeState !== 'active' && before.activeState !== 'activating'
    && before.activeState !== 'deactivating' && before.activeState !== 'reloading') {
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', `managed Host: the unit is in an unrecognized state (${before.activeState})`)
  }
  assertUnitFileIdentity(unit)
  const stop = await systemctl(['--user', '--no-pager', '--no-ask-password', 'stop', unit.unitName], runtimeDir)
  if (stop.kind !== 'exited' || stop.code !== 0) {
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: systemctl could not stop the unit')
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let after: OwnedProfileUnitState
    try {
      after = await queryOwnedProfileUnit(unit, runtimeDir, systemctl)
    } catch (error) {
      if (!(error instanceof LocalScopeError)) throw error
      throw new LocalScopeError(error.code, `managed Host stop may already be committed; final verification failed. Run daemon status before retrying. ${error.message}`, error)
    }
    const settled = after.loadState === 'not-found'
      || after.activeState === 'inactive'
      || after.activeState === 'failed'
    if (settled && (after.mainPid === 0 || after.mainPid !== before.mainPid)) {
      return { stopped: true, alreadyInactive: false, mainPid: before.mainPid }
    }
    if (Date.now() >= deadline) {
      throw new LocalScopeError('HOST_STOP_TIMEOUT', 'managed Host stop may already be committed; final verification failed. Run daemon status before retrying. The unit did not stop within the bounded window')
    }
    await new Promise(resolve => setTimeout(resolve, UNIT_STOP_POLL_MS))
  }
}

/** Remove ONE verified owned profile unit file. There is no Host kill here: an
 * independent Host is not unit-supervised and is never stopped by uninstall. The
 * caller owns the `daemon-reload` that follows.
 */
export function uninstallOwnedProfileUnit(unit: OwnedProfileUnit, scope: LocalScope, profile: string): void {
  const current = inspectOwnedProfileUnit(scope, profile, unit.unitDir)
  if (current.kind !== 'owned' || current.filePath !== unit.filePath
    || current.device !== unit.device || current.inode !== unit.inode) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the profile unit file changed during the transition')
  }
  assertUnitFileIdentity(unit)
  try {
    unlinkSync(unit.filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: the profile unit file could not be removed', error)
  }
}

/**
 * Prove the manager does not already run THIS unit name from another source
 * before a fresh high-priority unit file may shadow it. A loaded definition
 * with a different FragmentPath is either a foreign service (must be refused,
 * never redefined) or an obsolete cache of a removed file. Only the latter is
 * recoverable: the manager must report the previous file as gone for the
 * refusal to lift. The unit name embeds the profile slug and scope prefix, so
 * an unrelated same-named service is an ownership conflict by construction.
 */
async function assertFreshUnitNameIsNotShadowed(
  unitName: string,
  unitDir: string,
  runtimeDir: string | undefined,
  systemctl: SystemctlRunner,
): Promise<void> {
  const finalPath = join(unitDir, unitName)
  const state = await showUnit(unitName, runtimeDir, systemctl)
  const mainPid = Number(state.mainPid)
  const definitelyInactive = state.activeState === 'inactive' && Number.isFinite(mainPid) && mainPid === 0
  if (state.loadState === '') {
    // An unreadable/unknown load state is not proof that the name is unused.
    throw new LocalScopeError(
      'HOST_MANAGER_UNIT_CONFLICT',
      'managed Host: the manager did not report a load state for this unit name; refusing to shadow a possibly live unit',
    )
  }
  if (state.loadState === 'not-found') {
    // `LoadState` and `ActiveState` are independent: a name that is
    // not-found but still active/transitioning must not be treated as unused.
    if (definitelyInactive) return
    throw new LocalScopeError(
      'HOST_MANAGER_UNIT_CONFLICT',
      `managed Host: the manager reports this unit name as ${state.activeState === '' ? 'unknown' : state.activeState} while it is not loaded; refusing to shadow a possibly live unit`,
    )
  }
  // The fresh target file does not exist yet, so only the LOADED source decides:
  // a resolvable FragmentPath names a real foreign file this install would
  // shadow, while an unresolvable one is only an obsolete cache of a removed
  // file and may be reloaded away — but ONLY when the manager proves the unit
  // itself is inactive with no MainPID. A running/transitioning unit keeps its
  // old source even if that file was deleted, and must not be redefined.
  let fragmentReal: string | undefined
  try {
    fragmentReal = realpathSync(state.fragmentPath)
  } catch (error) {
    // ONLY a definitively missing file (ENOENT) can prove an obsolete cache.
    // An inaccessible/looping/busy path (EACCES, EIO, ELOOP, ...) may still be
    // a live foreign unit this install would shadow, so it stays refused.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new LocalScopeError(
        'HOST_MANAGER_UNIT_CONFLICT',
        'managed Host: the loaded source of this unit name cannot be verified; refusing to shadow a possibly live unit',
        error,
      )
    }
    fragmentReal = undefined
  }
  if (fragmentReal === undefined) {
    if (definitelyInactive) return
    throw new LocalScopeError(
      'HOST_MANAGER_UNIT_CONFLICT',
      `managed Host: the loaded source is gone but the unit is ${state.activeState === '' ? 'in unknown state' : state.activeState}; refusing to shadow a possibly running foreign service`,
    )
  }
  // The manager runs this name from another EXISTING file: a foreign service
  // that a fresh high-priority file would shadow. Refuse before any write.
  throw new LocalScopeError(
    'HOST_MANAGER_UNIT_CONFLICT',
    'managed Host: the user manager already runs this unit name from another unit file; refusing to shadow a foreign service',
  )
}

/** The installed facts and manager verification of one explicit install. */
export interface ProfileHostUnitInstall {
  readonly unitName: string
  readonly unitPath: string
  /** True when THIS call created the unit file. */
  readonly created: boolean
  /** True when this call issued the one `daemon-reload` that loaded the unit. */
  readonly reloaded: boolean
}

/** The Linux uid this Host-supervision operation needs. */
function requireLinuxUid(): number {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
    throw new LocalScopeError('B1_PLATFORM_UNSUPPORTED', 'managed Host: this operation requires Linux')
  }
  return process.getuid()
}

/**
 * Install the ONE explicit systemd user unit for this profile. This is the only
 * path that writes a unit: it proves the user manager is reachable before any
 * write (an empty target directory is legitimately absent from `UnitPath`),
 * installs the rendered file atomically (never overwriting user content),
 * re-verifies the same-profile metadata/build identity and reloads/verifies the
 * manager's real `LoadState`/`FragmentPath`. It never starts, stops,
 * enables or restarts a unit and never creates a Client/Host.
 */
export async function installProfileHostUnit(
  options: HostStartOptions,
  deps: HostManagerDeps = {},
): Promise<ProfileHostUnitInstall> {
  const uid = requireLinuxUid()
  const systemctl = deps.systemctl ?? runSystemctl
  const runtimeDir = selectRuntimeDir(uid)
  const unitDir = deps.unitDir !== undefined ? deps.unitDir(uid) : userUnitDirPath()
  // The manager gate runs BEFORE any user-directory write. Only a usable
  // manager whose UnitPath covers the target may lead to creating missing
  // components below the account home.
  await assertUserManagerAvailable(runtimeDir, systemctl)
  if (deps.unitDir === undefined) {
    ensureOwnedUnitDir(accountHome())
  } else {
    try {
      mkdirSync(unitDir, { recursive: true, mode: 0o700 })
    } catch (error) {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the unit directory is not accessible', error)
    }
  }
  const unitName = buildUnitName(options.profile, options.scope.scopeId)
  const content = renderUnitContent(collectUnitFacts(options))
  let unit = inspectOwnedProfileUnit(options.scope, options.profile, unitDir)
  let created = false
  if (unit.kind === 'none') {
    // A fresh file may otherwise SHADOW a same-named unit the manager already
    // runs from a lower-priority path; refuse that before any write/reload.
    await assertFreshUnitNameIsNotShadowed(unitName, unitDir, runtimeDir, systemctl)
    created = installProfileUnit({ unitDir, unitName, content }).created
    unit = inspectOwnedProfileUnit(options.scope, options.profile, unitDir)
  }
  if (unit.kind !== 'owned') {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the installed unit could not be confirmed')
  }
  if (unit.installBuild !== options.scope.buildId) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the installed unit belongs to another installed build')
  }
  let reloaded = false
  if (created) {
    // A FRESH unit file must be reloaded BEFORE any manager attribution check:
    // systemd can still cache an older definition (same or different
    // FragmentPath) and LoadState=loaded would otherwise let `start` dispatch
    // a stale ExecStart. Only the post-reload LoadState/FragmentPath owns the
    // decision. A failed reload rolls the file we just created back so a retry
    // is a fresh install again (it can never silently reuse the cached unit).
    const reload = await systemctl(['--user', '--no-pager', '--no-ask-password', 'daemon-reload'], runtimeDir)
    if (reload.kind !== 'exited' || reload.code !== 0) {
      const reloadFailure = new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: systemctl daemon-reload failed after the unit install')
      const rollbackFailure = rollbackFreshUnit(unit)
      if (rollbackFailure !== undefined) {
        throw new LocalScopeError(
          'HOST_MANAGER_START_FAILED',
          'managed Host: daemon-reload failed after the unit install and the freshly created unit could not be rolled back',
          new AggregateError([reloadFailure, rollbackFailure]),
        )
      }
      throw reloadFailure
    }
    reloaded = true
    let state: Awaited<ReturnType<typeof waitForUnitLoaded>>
    try {
      state = await waitForUnitLoaded(unitName, runtimeDir, systemctl)
    } catch (error) {
      // The post-reload verification itself failed (timeout/spawn/nonzero):
      // the committed state of this fresh file is unknown. Treat it exactly
      // like the other unverified outcomes and roll this install's file back;
      // an unreadable manager must not leave a poisoned unit behind.
      const rollbackFailure = rollbackFreshUnit(unit)
      if (rollbackFailure !== undefined) {
        throw new LocalScopeError(
          'HOST_MANAGER_START_FAILED',
          'managed Host: the freshly installed unit could not be verified and could not be rolled back',
          new AggregateError([error instanceof Error ? error : new Error(String(error)), rollbackFailure]),
        )
      }
      throw error instanceof LocalScopeError
        ? error
        : new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: the freshly installed unit could not be verified after the reload', error)
    }
    if (state.loadState === 'not-found') {
      // A reload the manager accepted but did not load leaves the fresh file
      // owned-but-unloadable: every later start would refuse instead of using
      // the basic daemon. Roll this install's own file back so the profile
      // returns to the no-unit state (a foreign file is never touched).
      const rollbackFailure = rollbackFreshUnit(unit)
      if (rollbackFailure !== undefined) {
        throw new LocalScopeError(
          'HOST_MANAGER_START_FAILED',
          'managed Host: the freshly installed unit is not loaded by the manager and could not be rolled back',
          rollbackFailure,
        )
      }
      throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: the freshly installed unit is not loadable by this user manager (its unit search path does not include the target directory)')
    }
    try {
      assertUnitOwned(state, unit.resolvedPath)
    } catch (error) {
      // The manager loaded the name but not from our file: the fresh file is
      // unverified, so remove exactly what this install created. The loaded
      // definition itself is the manager's/foreign service's and is never
      // modified here; a retry re-runs the fresh-install checks.
      const rollbackFailure = rollbackFreshUnit(unit)
      if (rollbackFailure !== undefined) {
        throw new LocalScopeError(
          'HOST_MANAGER_UNIT_CONFLICT',
          'managed Host: the freshly installed unit was not adopted by the manager and could not be rolled back',
          new AggregateError([error instanceof Error ? error : new Error(String(error)), rollbackFailure]),
        )
      }
      throw error instanceof LocalScopeError ? error : new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the freshly installed unit was not adopted by the manager', error)
    }
  } else {
    const loaded = await queryOwnedProfileUnit(unit, runtimeDir, systemctl)
    if (loaded.loadState === 'not-found') {
      const reload = await systemctl(['--user', '--no-pager', '--no-ask-password', 'daemon-reload'], runtimeDir)
      if (reload.kind !== 'exited' || reload.code !== 0) {
        throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: systemctl daemon-reload failed after the unit install')
      }
      reloaded = true
      const state = await waitForUnitLoaded(unitName, runtimeDir, systemctl)
      if (state.loadState === 'not-found') {
        throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: the installed unit is not loaded by the manager')
      }
      assertUnitOwned(state, unit.resolvedPath)
    }
  }
  assertUnitFileIdentity(unit)
  return { unitName, unitPath: unit.filePath, created, reloaded }
}

/**
 * Remove only the unit file THIS install just created, after a failed load
 * request. A changed identity is left alone (the user won the race).
 */
function rollbackFreshUnit(unit: OwnedProfileUnit): Error | undefined {
  try {
    assertUnitFileIdentity(unit)
    unlinkSync(unit.filePath)
    return undefined
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}

/**
 * Start the public daemon Host candidate. The ONE decision input is the
 * installed unit fact: no unit means the basic detached Host immediately, with
 * no user-manager probe and no systemctl call; an installed unit must be loaded
 * by the real manager with a matching FragmentPath and this installed build,
 * and is then started through exactly one `systemctl --user start`. A manager
 * failure or unit conflict is thrown and NEVER degrades to a detached process.
 */
export async function startPublicHostCandidate(
  options: HostStartOptions,
  deps: HostManagerDeps = {},
): Promise<HostStartObservation> {
  const uid = requireLinuxUid()
  const unitDir = deps.unitDir !== undefined ? deps.unitDir(uid) : inspectExistingUserUnitDir()
  if (unitDir === undefined) return spawnHostCandidate(options)
  const unit = inspectOwnedProfileUnit(options.scope, options.profile, unitDir)
  if (unit.kind === 'none') return spawnHostCandidate(options)
  if (unit.installBuild !== options.scope.buildId) {
    throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the installed unit belongs to another installed build')
  }
  const systemctl = deps.systemctl ?? runSystemctl
  const runtimeDir = selectRuntimeDir(uid)
  const state = await queryOwnedProfileUnit(unit, runtimeDir, systemctl)
  if (state.loadState === 'not-found') {
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: the installed unit is not loaded by the manager')
  }
  assertUnitFileIdentity(unit)
  const start = await systemctl(['--user', '--no-pager', '--no-ask-password', 'start', unit.unitName], runtimeDir)
  if (start.kind !== 'exited' || start.code !== 0) {
    throw new LocalScopeError('HOST_MANAGER_START_FAILED', 'managed Host: systemctl could not start the unit')
  }
  return () => undefined
}

/**
 * Collect the same validated installed facts for BOTH manager renderers; the
 * profile identity digest is the shared canonical-profile owner.
 */
function collectLaunchdUnitFacts(options: HostStartOptions): LaunchdUnitFacts {
  const facts = collectUnitFacts(options)
  return {
    ...facts,
    scopeDir: options.scope.dir,
    profileIdentity: profileIdentityDigest(options.scope.profileRealpath),
  }
}

/**
 * Compatibility entry for the managed public-start policy.
 *
 * Linux follows the D0 public policy: the installed-unit fact decides between
 * the basic detached daemon and the verified systemd unit. On macOS only the
 * real public start consults the installed user LaunchAgent: no plist keeps the
 * historic detached process; an owned plist must start through the verified
 * launchd job and never degrades to a detached Host. The internal
 * qualification/peer/manual/reexec policies never consider a manager job.
 */
export async function startManagedHostCandidate(
  options: HostStartOptions,
  deps: HostManagerDeps = {},
): Promise<HostStartObservation> {
  if (process.platform === 'darwin') {
    if (options.hostStartPolicy !== 'public') return spawnHostCandidate(options)
    const launchdDeps = deps.launchd ?? {}
    const facts = collectLaunchdUnitFacts(options)
    const inspected = inspectOwnedLaunchdUnit(facts, launchdDeps)
    if (inspected.kind === 'none') return spawnHostCandidate(options)
    if (inspected.unit.installBuild !== options.scope.buildId) {
      throw new LocalScopeError('HOST_MANAGER_UNIT_CONFLICT', 'managed Host: the installed launchd plist belongs to another installed build')
    }
    await startLaunchdService(facts, inspected.unit, launchdDeps)
    return () => undefined
  }
  return startPublicHostCandidate(options, deps)
}

/**
 * Start one Host candidate as a detached OS process: the default basic daemon
 * whenever no profile unit is installed, and the internal qualification/peer/
 * manual path. It opens/creates the scope `host.log` (a NEW file is 0600; an
 * existing user-owned log is appended to as-is and never chmodded), validates
 * the installed Node/Host entry by its canonical regular-file target, runs with
 * the canonical profile as cwd, detaches/unrefs and never claims a periodic
 * auto-restart (that is systemd-only).
 */
export function spawnHostCandidate(options: HostStartOptions): HostStartObservation {
  if (!isAbsolute(options.hostEntryPath)) {
    throw new LocalScopeError('HOST_START_FAILED', 'managed Host: the installed Host entry path must be absolute')
  }
  let realEntry: string
  try {
    realEntry = realpathSync(options.hostEntryPath)
  } catch (error) {
    throw new LocalScopeError('HOST_START_FAILED', 'managed Host: the installed Host entry is not readable', error)
  }
  if (!lstatSync(realEntry).isFile()) {
    throw new LocalScopeError('HOST_START_FAILED', 'managed Host: the installed Host entry must be a regular file')
  }
  assertEntrySelfLocation(options.hostEntryPath, 'HOST_START_FAILED', 'installed Host entry')
  const logPath = join(options.scope.dir, 'host.log')
  let fd: number | undefined
  try {
    fd = openSync(logPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
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
