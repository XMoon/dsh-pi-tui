/**
 * The M6-2A daemon Coordinator (`@xmoon76/dsh-pi-tui/daemon-launcher`).
 *
 * A Loader row gated on `tuiDaemonStartup`: when the daemon backend is selected,
 * it spawns exactly ONE foreground Client OS process (`dist/local-client.mjs`)
 * and waits for its real exit. It owns NO Host: the Client entry performs the
 * Host authentication / `ensureLocalHost` itself before it mounts the surface.
 * The Coordinator never calls `ensureLocalHost`, never binds a Host seat and
 * never creates a Session/Agent/Writer.
 *
 * Lifecycle: one idempotent child lifecycle. A terminal `SIGINT` is delivered by
 * the kernel to BOTH the parent and the foreground child (same process group),
 * so the Coordinator does NOT re-forward it; a parent-only `SIGTERM` (the child
 * still alive) is forwarded once. Terminal stdout/stderr belong to the real TUI
 * Client; the Coordinator prints no records.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote-process/daemon-launcher
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import { constants, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync, writeSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { installedPackageRootFromEntry, readInstalledDshVersion } from './local-scope.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { createEntryDiag } from './entry-control.ts'
import type { TuiAcpControlStartup, TuiAcpStdioStartup, TuiDaemonClientStartup, TuiDaemonControlStartup, TuiDaemonStartupValues, TuiWebControlStartup } from '../../startup.ts'
import { scrubProgramResumeEnvironment } from '../../client/program-resume/handoff.ts'
import { daemonProgramResumeCapability } from '../../client/program-resume/target.ts'
import { admitProgramResume } from '../program-resume-admission.ts'
import { applyProgramResumeChildEnvironment } from './program-resume-child.ts'

/**
 * The read-only ACP stdio launch target, structurally identical to the
 * `local-daemon-control` DTO. It is declared here so the public
 * `daemon-launcher.d.mts` stays free of internal module paths while the real
 * producer remains `readAcpStdioTarget`.
 */
type AcpStdioTarget =
  | { readonly kind: 'ready'; readonly socketPath: string; readonly instanceId: string }
  | { readonly kind: 'host-unavailable' | 'acp-disabled' | 'acp-unavailable' }

/** Stable Loader row id / Cordis plugin name. */
export const name = 'pi-tui-daemon-launcher'

/** The daemon Coordinator only exists when the daemon backend published its service. */
export const inject = ['tuiDaemonStartup']

/** The private v1 public-launch data channel (shared shape with the Client entry). */
const CLIENT_LAUNCH_ENVELOPE_ENV = 'SPLIT_PROCESS_CLIENT_LAUNCH_V1'

/** The private ACP stdio Adapter target channel. The Parent overwrites it. */
export const ACP_STDIO_SOCKET_ENV = 'DSH_PI_TUI_ACP_STDIO_SOCKET_V1'

/** The launcher-provided Profile facts the Coordinator needs (official shape). */
interface ProfileContextLike {
  readonly name: string
  readonly dir: string
  readonly home: string
  readonly installAnchor: string
  readonly cwd: string
  readonly overlays?: readonly unknown[]
  readonly telemetryDisabledEnv?: string | undefined
}

/** The small launch-environment view used only to build the private capability. */
interface LaunchEnvironmentLike {
  getFrom(
    name: string,
    sources: readonly ('process' | 'project-env' | 'user-env')[],
  ): { readonly value: string; readonly source: string } | undefined
}

/** The one-shot public launch envelope encoded for the Client child. */
export function encodeLaunchEnvelope(startup: TuiDaemonClientStartup): string {
  return JSON.stringify({
    version: 1,
    ...(startup.sessionLaunch === undefined ? {} : { sessionLaunch: startup.sessionLaunch }),
    ...(startup.presetId === undefined ? {} : { presetId: startup.presetId }),
    ...(startup.backendSource === undefined ? {} : { backendSource: startup.backendSource }),
  })
}

/**
 * Resolve one installed internal process entry from THIS package root and prove
 * its real target is a regular file. A shared npm package, a root-owned system
 * install and a legal entry symlink are normal installs; only a missing or
 * non-regular target is a hard failure — never a fallback to a source tree or
 * `tsx`.
 */
function resolveProcessEntry(packageRoot: string, fileName: string, label: string): string {
  // The NAMED entry path is what the child receives; it locates its package
  // root from that invoked path, so a legal dist/entry symlink still resolves
  // THIS package root.
  const entry = join(packageRoot, 'dist', fileName)
  let real: string
  try {
    real = realpathSync(entry)
  } catch (error) {
    throw new Error(`pi-tui daemon launcher: the ${label} entry ${entry} is missing`, { cause: error })
  }
  if (!lstatSync(real).isFile()) {
    throw new Error(`pi-tui daemon launcher: the ${label} entry ${entry} must resolve to a regular file`)
  }
  let expectedRoot: string
  try {
    expectedRoot = realpathSync(packageRoot)
  } catch (error) {
    throw new Error(`pi-tui daemon launcher: the package root ${packageRoot} is not readable`, { cause: error })
  }
  let entryRoot: string
  try {
    entryRoot = installedPackageRootFromEntry(pathToFileURL(entry).href)
  } catch (error) {
    throw new Error(`pi-tui daemon launcher: the ${label} entry ${entry} cannot locate its installed package root`, { cause: error })
  }
  if (entryRoot !== expectedRoot) {
    throw new Error(`pi-tui daemon launcher: the ${label} entry ${entry} resolves a different installed package root`)
  }
  return entry
}

export function resolveClientEntry(packageRoot: string): string {
  return resolveProcessEntry(packageRoot, 'local-client.mjs', 'Client')
}

/** Resolve the internal ACP stdio Adapter entry with the same installed-package
 *  proof as the Client entry. It is never a public bin or export. */
export function resolveAcpStdioEntry(packageRoot: string): string {
  return resolveProcessEntry(packageRoot, 'acp-stdio.mjs', 'ACP stdio')
}

/**
 * Resolve this installed bundle's package root through the OFFICIAL profile
 * resolution. The launcher module itself may be reached through a symlinked
 * `dist`, so its own module URL is not a reliable package-root locator.
 * Exported for the M6 UX PR2 Direct-side admin port, which must reuse the SAME
 * official Profile resolution as this CLI path — never a second copy.
 */
export function resolveProfilePackageRoot(profileDir: string): string {
  let manifestPath: string
  try {
    manifestPath = createRequire(join(profileDir, 'package.json')).resolve('@xmoon76/dsh-pi-tui/package.json')
  } catch (error) {
    throw new Error('pi-tui daemon launcher: the official profile does not resolve the installed @xmoon76/dsh-pi-tui', { cause: error })
  }
  const root = realpathSync(dirname(manifestPath))
  let manifest: unknown
  try {
    manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error('pi-tui daemon launcher: the installed package manifest is not readable', { cause: error })
  }
  if (manifest === null || typeof manifest !== 'object' || (manifest as { readonly name?: unknown }).name !== '@xmoon76/dsh-pi-tui') {
    throw new Error('pi-tui daemon launcher: the official profile resolves a different package')
  }
  return root
}

/**
 * Build the child environment at the ONE new-spawn boundary. Every inherited
 * `SPLIT_PROCESS_*` test/qualification injection is stripped first, then the
 * four required internal facts are set explicitly. The supervisor's own role /
 * Host-entry markers and the one-shot public selector are never propagated.
 */
export function buildChildEnvironment(
  profileContext: ProfileContextLike,
  launchEnvelope: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source }
  for (const key of Object.keys(env)) {
    if (key.startsWith('SPLIT_PROCESS_')) delete env[key]
  }
  delete env.DSH_PI_TUI_ROLE
  delete env.DSH_PI_TUI_HOST_ENTRY
  delete env.DSH_PI_TUI_BACKEND
  // The OSC capability is process-private and never inherited by a generic
  // Split child. Only an admitted foreground Client receives the protocol
  // token and the non-secret v1 launch facts.
  scrubProgramResumeEnvironment(env)
  env.SPLIT_PROCESS_DSH_ANCHOR = profileContext.installAnchor
  env.SPLIT_PROCESS_PROFILE = profileContext.name
  env.SPLIT_PROCESS_CLIENT_MODE = 'surface'
  env[CLIENT_LAUNCH_ENVELOPE_ENV] = launchEnvelope
  return env
}

/**
 * Build the ACP stdio Adapter child environment at the ONE new-spawn boundary.
 * The adapter is a pure Node stream relay: it receives the Parent-selected
 * public UDS path and no Split Client/Host role, launch envelope, Cookie or
 * token. Every inherited internal role fact is stripped before the one
 * authoritative socket value is written.
 */
export function buildAcpStdioEnvironment(
  socketPath: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source }
  for (const key of Object.keys(env)) {
    if (key.startsWith('SPLIT_PROCESS_')) delete env[key]
  }
  delete env.DSH_PI_TUI_ROLE
  delete env.DSH_PI_TUI_HOST_ENTRY
  delete env.DSH_PI_TUI_BACKEND
  // ACP stdio is a pure relay: it is never a program-resume reporter.
  scrubProgramResumeEnvironment(env)
  delete env[ACP_STDIO_SOCKET_ENV]
  env[ACP_STDIO_SOCKET_ENV] = socketPath
  return env
}

/** POSIX-safe single-argument quoting for the copy-paste fatal line. */
function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/**
 * The one copy-pasteable re-run command for a Client spawn failure. POSIX keeps
 * its environment-assignment form; Windows gets the PowerShell-equivalent form
 * because `VAR=value cmd` is not a Windows command. The profile is quoted for
 * the target shell: POSIX close-reopen quoting versus PowerShell doubled quotes.
 */
function daemonClientRerunCommand(
  profile: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const profileArg = platform === 'win32' ? powershellQuote(profile) : shellQuote(profile)
  return platform === 'win32'
    ? `$env:DSH_PI_TUI_BACKEND='daemon'; dsh --profile ${profileArg}`
    : `DSH_PI_TUI_BACKEND=daemon dsh --profile ${profileArg}`
}

/** PowerShell single-quoted literal: an embedded quote is doubled (`''`), not
 *  the POSIX close-reopen sequence. */
function powershellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(value)) return value
  return `'${value.replace(/'/gu, "''")}'`
}

/** The child-exit mapping: a real code, or 128+signal when the child was signalled. */
function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code
  if (signal === null) return 1
  const number = (osConstants.signals as Record<string, number | undefined>)[signal]
  return number === undefined ? 1 : 128 + number
}

/** Injectable spawn for a structural (L2/L3) test; production uses `child_process.spawn`. */
export type SpawnImpl = typeof spawn

/**
 * The ONE child lifecycle. Idempotent start/dispose; a single settle drives the
 * launcher `appExit` exactly once. `dispose()` is the SINGLE stop owner: it is
 * driven by the row's fiber disposal (the official `runProfile` SIGTERM → shutdown
 * → fiber disposal path) and asks the live child to stop once. The Coordinator
 * installs NO second SIGTERM/SIGINT handler — a terminal SIGINT already reaches
 * the foreground child through the shared TTY group, and the parent's own SIGTERM
 * is the official shutdown's, so there is exactly one stop request.
 */
export class DaemonCoordinator {
  private readonly spawnImpl: SpawnImpl
  private readonly entry: string
  private readonly env: NodeJS.ProcessEnv
  private readonly appExit: (code: number) => void
  private readonly diag: Diag
  /** A sanitized human line for the supervisor TTY when the Client cannot be
   *  spawned at all (never a JSON record, never a raw error/message/path). */
  private readonly reportFatal: (line: string) => void
  /** Optional ACP-specific formatter; the default keeps the Client wording. */
  private readonly failureLine: ((safeErrno: string) => string) | undefined
  private readonly spawnFailureExitCode: number
  private readonly shutdownBudgetMs: number
  private child: ChildProcess | undefined
  private childExited: Promise<void> | undefined
  private started = false
  private disposed = false
  private settled = false
  private disposePromise: Promise<boolean> | undefined
  /** Test observation: how many children were actually spawned. */
  spawnCount = 0

  constructor(options: {
    spawnImpl: SpawnImpl
    entry: string
    env: NodeJS.ProcessEnv
    appExit: (code: number) => void
    diag: Diag
    reportFatal?: (line: string) => void
    failureLine?: (safeErrno: string) => string
    spawnFailureExitCode?: number
    shutdownBudgetMs?: number
  }) {
    this.spawnImpl = options.spawnImpl
    this.entry = options.entry
    this.env = options.env
    this.appExit = options.appExit
    this.diag = options.diag
    this.reportFatal = options.reportFatal ?? (() => {})
    this.failureLine = options.failureLine
    this.spawnFailureExitCode = options.spawnFailureExitCode ?? 1
    // A SINGLE budget strictly below the official ~5s parent shutdown deadline
    // (leaving margin for the other fibers): the whole SIGTERM→SIGKILL sequence
    // must fit inside it, never 4s + 1.5s = 5.5s.
    this.shutdownBudgetMs = options.shutdownBudgetMs ?? 4000
  }

  /** Spawn the ONE foreground Client. No-op after a prior start or dispose. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    let child: ChildProcess
    try {
      child = this.spawnImpl(process.execPath, [this.entry], {
        cwd: process.cwd(),
        stdio: 'inherit',
        shell: false,
        env: this.env,
      })
    } catch (error) {
      this.settle(this.spawnFailureExitCode, error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.child = child
    this.spawnCount += 1
    // Exit-only truth: an 'error' (for example a refused kill/TerminateProcess)
    // is NOT an actual exit and must never satisfy the dispose cleanup budget.
    this.childExited = new Promise<void>(resolve => {
      child.once('exit', () => resolve())
    })
    // A post-spawn 'error' is a cleanup fact, not a spawn failure. Only a
    // never-spawned child may claim "could not start ... Host was not started".
    const spawned = child.pid !== undefined
    child.once('error', (error: Error) => {
      if (spawned) {
        this.diag.warn('pi-tui daemon: child process error after spawn', { error: error.message })
        return
      }
      this.settle(this.spawnFailureExitCode, error)
    })
    child.once('exit', (code, signal) => { this.settle(exitCodeFor(code, signal), undefined) })
  }

  private settle(code: number, error: Error | undefined): void {
    if (this.settled) return
    this.settled = true
    if (error !== undefined) {
      this.diag.warn('pi-tui daemon: child process failed', { error: error.message })
      // R2-01: the supervisor TTY must get ONE actionable, sanitized line — never
      // a bare nonzero exit, and never the raw error (which can carry a path). The
      // spawn errno code is safe to name; everything else is fixed text.
      const errno = (error as { code?: unknown }).code
      const safeErrno = typeof errno === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/u.test(errno) ? ` (${errno})` : ''
      this.reportFatal(this.failureLine !== undefined
        ? this.failureLine(safeErrno)
        : `dsh-pi-tui: could not start the daemon Client process${safeErrno}; the Host was not started. Reinstall the profile and re-run: ${daemonClientRerunCommand(this.env.SPLIT_PROCESS_PROFILE!)}`)
    }
    this.appExit(code)
  }

  /**
   * The SINGLE stop owner, AWAITABLE. A spawn not yet started is cancelled; a
   * live child is asked to stop once and dispose() resolves only after the child
   * actually exited, so the parent Fiber disposer holds the child's cleanup
   * rather than the parent process exiting underneath it. On POSIX the bounded
   * SIGTERM→SIGKILL sequence fits the official ~5s shutdown deadline. Windows
   * has no catchable POSIX SIGTERM: the direct child is forcibly terminated once
   * and only its ACTUAL exit inside the same budget is success; no graceful claim
   * is made. Idempotent.
   */
  dispose(): Promise<boolean> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    this.disposePromise = (async (): Promise<boolean> => {
      const child = this.child
      const exited = this.childExited
      if (child === undefined || child.exitCode !== null || child.signalCode !== null || exited === undefined) return true
      const start = Date.now()
      const budgetEnd = start + this.shutdownBudgetMs
      const disposeStartedAt = performance.now()
      // The budget deadline is a LOSSING fallback, never a second completion
      // path: cancel its timer whenever the child's real exit wins, otherwise
      // the supervisor keeps a referenced timer alive after the child is gone.
      const waitExitUntil = async (absoluteDeadline: number): Promise<boolean> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<boolean>(resolve => {
          timer = setTimeout(() => resolve(false), Math.max(0, absoluteDeadline - Date.now()))
        })
        try {
          return await Promise.race([exited.then(() => true), deadline])
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      }
      if (process.platform === 'win32') {
        // Windows has no catchable POSIX SIGTERM: the direct child is forcibly
        // terminated by the OS (TerminateProcess), and the ONLY truthful result
        // is whether the exact ChildProcess actually exited inside the budget.
        // No SIGTERM→SIGKILL double act and no graceful claim.
        try { child.kill() } catch { /* already gone */ }
        if (await waitExitUntil(budgetEnd)) {
          this.diag.debug('pi-tui daemon: client exited after forced process termination', { durationMs: Math.round((performance.now() - disposeStartedAt) * 10) / 10 })
          return true
        }
        this.reportFatal('dsh-pi-tui: the daemon Client did not exit after forced process termination within the shutdown budget; it may be left running')
        return false
      }
      // Reserve part of the ONE budget for the SIGKILL phase so a SIGTERM phase
      // that never stops the child cannot consume the whole budget.
      const killReserve = Math.min(1000, Math.max(50, Math.floor(this.shutdownBudgetMs * 0.25)))
      const killAt = budgetEnd - killReserve
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      const sigtermWaitAt = performance.now()
      if (await waitExitUntil(killAt)) {
        this.diag.debug('pi-tui daemon: client exited after SIGTERM', { durationMs: Math.round((performance.now() - sigtermWaitAt) * 10) / 10 })
        return true
      }
      // Escalate within the SAME budget; the total never exceeds shutdownBudgetMs.
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      if (await waitExitUntil(budgetEnd)) {
        this.diag.debug('pi-tui daemon: client exited after SIGKILL', { durationMs: Math.round((performance.now() - disposeStartedAt) * 10) / 10 })
        return true
      }
      // A child that never exits inside the unified budget is an ABNORMAL cleanup
      // result, never reported as success: return false and surface a sanitized
      // line. NOTE: the official DSH SIGTERM shutdown calls shutdown.interrupt(0)
      // and exits 0 after fiber disposal, so we do NOT (and cannot truthfully)
      // force a nonzero supervisor exit here — the observable signal is the
      // stderr line plus the false return, not a claimed exit code.
      this.reportFatal('dsh-pi-tui: the daemon Client did not exit after SIGKILL within the shutdown budget; it may be left running')
      return false
    })()
    return this.disposePromise
  }
}

/** The injected seams of one trusted-profile ACP stdio launch. */
export interface AcpStdioRunnerOptions {
  readonly profileName: string
  readonly preflight: (signal: AbortSignal) => Promise<AcpStdioTarget>
  readonly resolveEntry: () => string
  readonly spawnImpl: SpawnImpl
  readonly appExit: (code: number) => void
  readonly diag: Diag
  readonly writeStderr?: (line: string) => void
  readonly shutdownBudgetMs?: number
}

/**
 * The ONE trusted-profile ACP stdio launch lifecycle: one read-only target
 * preflight followed by at most one internal Adapter child. The launch promise
 * is created before the cold-ready callback can run, so a reentrant callback or
 * a fiber disposal can never start a second launch. Disposal aborts the
 * preflight, awaits its settlement, then disposes the one child.
 */
export class AcpStdioRunner {
  private readonly options: AcpStdioRunnerOptions
  private readonly controller = new AbortController()
  private readonly startGate: Promise<void>
  private releaseStartGate!: () => void
  private launchPromise: Promise<void> | undefined
  private coordinator: DaemonCoordinator | undefined
  private started = false
  private disposed = false
  private settled = false
  private disposePromise: Promise<boolean> | undefined

  constructor(options: AcpStdioRunnerOptions) {
    this.options = options
    this.startGate = new Promise<void>(resolve => { this.releaseStartGate = resolve })
  }

  /** Create the ONE launch promise now; it waits for {@link start}. */
  prepare(): Promise<void> {
    if (this.launchPromise === undefined) {
      this.launchPromise = this.startGate
        .then(() => this.launch())
        .catch(() => {
          if (this.disposed) return
          this.fail('ACP_STDIO_STATUS_UNAVAILABLE',
            `check the Host state with dsh --profile ${shellQuote(this.options.profileName)} daemon status`, 3)
        })
    }
    return this.launchPromise
  }

  /** Release the cold-ready gate exactly once. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.releaseStartGate()
  }

  private writeStderr(line: string): void {
    try { (this.options.writeStderr ?? (text => { process.stderr.write(text) }))(line) } catch { /* best effort */ }
  }

  private report(code: string, hint: string): void {
    this.writeStderr(`dsh-pi-tui acp stdio: ${code}${hint === '' ? '' : `: ${hint}`}\n`)
  }

  private finish(code: number): void {
    if (this.settled || this.disposed) return
    this.settled = true
    this.options.appExit(code)
  }

  private fail(code: string, hint: string, exitCode: number): void {
    this.report(code, hint)
    this.finish(exitCode)
  }

  private async launch(): Promise<void> {
    if (this.disposed) return
    let target: AcpStdioTarget
    try {
      target = await this.options.preflight(this.controller.signal)
    } catch {
      if (this.disposed || this.controller.signal.aborted) return
      this.fail('ACP_STDIO_STATUS_UNAVAILABLE',
        `check the Host state with dsh --profile ${shellQuote(this.options.profileName)} daemon status`, 3)
      return
    }
    if (this.disposed || this.controller.signal.aborted) return
    switch (target.kind) {
      case 'host-unavailable':
        this.fail('ACP_STDIO_HOST_NOT_READY',
          `start the Host explicitly with dsh --profile ${shellQuote(this.options.profileName)} daemon start`, 3)
        return
      case 'acp-disabled':
        this.fail('ACP_STDIO_LISTENER_DISABLED', 'enable ACP from a connected TUI with /acp', 3)
        return
      case 'acp-unavailable':
        this.fail('ACP_STDIO_LISTENER_UNAVAILABLE',
          `check the Host state with dsh --profile ${shellQuote(this.options.profileName)} daemon status`, 3)
        return
      case 'ready':
        break
    }
    let entry: string
    try {
      entry = this.options.resolveEntry()
    } catch {
      if (this.disposed) return
      this.fail('ACP_STDIO_ENTRY_MISSING', 'reinstall the profile and re-run the command', 4)
      return
    }
    if (this.disposed) return
    const coordinator = new DaemonCoordinator({
      spawnImpl: this.options.spawnImpl,
      entry,
      env: buildAcpStdioEnvironment(target.socketPath),
      appExit: code => { this.finish(code) },
      diag: this.options.diag,
      reportFatal: line => { this.writeStderr(`${line}\n`) },
      failureLine: () => 'dsh-pi-tui acp stdio: ACP_STDIO_SPAWN_FAILED',
      spawnFailureExitCode: 4,
      ...(this.options.shutdownBudgetMs === undefined ? {} : { shutdownBudgetMs: this.options.shutdownBudgetMs }),
    })
    this.coordinator = coordinator
    coordinator.start()
  }

  /** Abort the preflight, await the ONE launch promise and dispose any child. */
  dispose(): Promise<boolean> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    this.controller.abort()
    this.releaseStartGate()
    const launch = this.launchPromise
    this.disposePromise = (async (): Promise<boolean> => {
      if (launch !== undefined) await launch
      const coordinator = this.coordinator
      return coordinator === undefined ? true : await coordinator.dispose()
    })()
    return this.disposePromise
  }
}

/** The result of one management operation, as written to the real TTY. */
export interface DaemonManagementResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** One management executor: the production one dynamically imports the control
 *  module; a structural test supplies its own. */
export type DaemonManagementExecutor = () => Promise<DaemonManagementResult>

/**
 * The ONE management operation lifecycle. It runs at most once, writes its
 * output and requests `appExit` exactly once, and a fiber disposal before the
 * result settles suppresses both the output and the exit so a late result can
 * never surface after the supervisor has gone away. The operation itself is
 * bounded so a shutdown never waits indefinitely on a management action.
 */
export class DaemonControlRunner {
  private readonly run: DaemonManagementExecutor
  private readonly appExit: (code: number) => void
  private readonly writeStdout: (text: string) => void
  private readonly writeStderr: (text: string) => void
  private readonly reportFatal: (line: string) => void
  private readonly shutdownBudgetMs: number
  /** The fixed result for an unexpected local throw; the daemon manager text
   *  stays the default so its behavior is unchanged. */
  private readonly fallback: DaemonManagementResult
  private started = false
  private disposed = false
  private settled = false
  private operation: Promise<void> | undefined
  /** Test observation: how many management operations actually started. */
  runCount = 0

  constructor(options: {
    run: DaemonManagementExecutor
    appExit: (code: number) => void
    writeStdout?: (text: string) => void
    writeStderr?: (text: string) => void
    reportFatal?: (line: string) => void
    shutdownBudgetMs?: number
    fallback?: DaemonManagementResult
  }) {
    this.run = options.run
    this.appExit = options.appExit
    this.writeStdout = options.writeStdout ?? (text => { process.stdout.write(text) })
    this.writeStderr = options.writeStderr ?? (text => { process.stderr.write(text) })
    this.reportFatal = options.reportFatal ?? (() => {})
    this.shutdownBudgetMs = options.shutdownBudgetMs ?? 4000
    this.fallback = options.fallback ?? {
      code: 4,
      stdout: '',
      stderr: 'dsh-pi-tui daemon: MANAGER_OR_OS_FAILURE: an unexpected local management failure occurred\n',
    }
  }

  /** Start exactly one management operation. A no-op after a prior start/dispose. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.runCount += 1
    this.operation = (async (): Promise<void> => {
      let result: DaemonManagementResult
      try {
        result = await this.run()
      } catch {
        // The control module maps every known failure itself; this arm exists
        // only so a hostile unexpected throw cannot escape as an unhandled
        // rejection or look successful.
        result = this.fallback
      }
      if (this.disposed || this.settled) return
      this.settled = true
      try {
        if (result.stdout !== '') this.writeStdout(result.stdout)
        if (result.stderr !== '') this.writeStderr(result.stderr)
      } catch {
        // A closed output stream must not abort the ONE exit request; the
        // command already settled its OS state.
        this.reportFatal('dsh-pi-tui: the daemon management output could not be written')
      }
      try {
        this.appExit(result.code)
      } catch {
        // The launcher's exit owner is authoritative; nothing else to do.
      }
    })()
  }

  /** Stop accepting a late result and bound the wait for an in-flight one. */
  async dispose(): Promise<boolean> {
    this.disposed = true
    if (this.operation === undefined) return true
    // The budget deadline is only the abnormal-hang fallback: a completed
    // management operation must not keep a referenced 4s timer (or the parent
    // process) alive after it settled.
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), this.shutdownBudgetMs)
    })
    let settled: boolean
    try {
      settled = await Promise.race([this.operation.then(() => true, () => true), deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
    if (!settled) this.reportFatal('dsh-pi-tui: the daemon management operation did not settle within the shutdown budget')
    return settled
  }
}


/**
 * Write a qualification dump to a SAFE, PRIVATE target: absolute path, a real
 * parent directory owned by this process user, NEVER overwriting an existing
 * file and never following a symlink; created 0600. Throws on any unsafe target
 * (mirrors the qualification record-sink contract in local-client-entry).
 */
export function writeQualificationDump(target: string, text: string): void {
  if (!isAbsolute(target)) throw new Error('the qualification dump path must be absolute')
  const directory = realpathSync(dirname(target))
  const dirStats = statSync(directory)
  if (!dirStats.isDirectory()) throw new Error('the qualification dump parent is not a directory')
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && dirStats.uid !== uid) throw new Error('the qualification dump parent is not owned by this process user')
  if (existsSync(target)) throw new Error('the qualification dump target already exists (refusing to overwrite)')
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    if ((fstatSync(fd).mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
    writeSync(fd, text)
  } finally {
    closeSync(fd)
  }
}

/** A cancelable, Fiber-lifecycle-owned one-shot qualification dump scheduler. */
export interface LoaderDumpScheduler {
  schedule(delayMs: number): void
  flush(): void
  dispose(): void
}
export function createLoaderDumpScheduler(produce: () => string, write: (text: string) => void): LoaderDumpScheduler {
  let disposed = false
  let done = false
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const emit = (): void => {
    if (disposed || done) return
    done = true
    try { write(produce()) } catch { /* best effort once */ }
  }
  return {
    schedule(delayMs: number): void {
      if (disposed) return
      const timer = setTimeout(() => { timers.delete(timer); emit() }, delayMs)
      timers.add(timer)
    },
    flush(): void { emit() },
    dispose(): void {
      disposed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    },
  }
}

/** The production Coordinator row. A `client` launch spawns the ONE foreground
 *  Client; a `control` launch runs ONE management operation. Both settle on the
 *  real cold-ready commit and are owned by this row's Fiber. */
export function apply(ctx: Context): void {
  const startup = ctx.get('tuiDaemonStartup') as TuiDaemonStartupValues | undefined
  if (startup === undefined) return
  const appExit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (appExit === undefined) throw new Error('pi-tui daemon launcher: ctx.appExit is required')
  const profileContext = ctx.get('profileContext') as ProfileContextLike | undefined
  if (profileContext === undefined) throw new Error('pi-tui daemon launcher: ctx.profileContext is required')
  if (startup.kind === 'control') {
    applyManagement(ctx, startup, profileContext, appExit)
    return
  }
  if (startup.kind === 'web-control') {
    applyWebControl(ctx, startup, profileContext, appExit)
    return
  }
  if (startup.kind === 'acp-control') {
    applyAcpControl(ctx, startup, profileContext, appExit)
    return
  }
  if (startup.kind === 'acp-stdio') {
    applyAcpStdio(ctx, startup, profileContext, appExit)
    return
  }

  const packageRoot = resolveProfilePackageRoot(profileContext.dir)
  const entry = resolveClientEntry(packageRoot)
  const launchEnvironment = ctx.get('launchEnvironment') as LaunchEnvironmentLike | undefined
  const programResume = admitProgramResume(process.env, () => launchEnvironment === undefined
    ? undefined
    : daemonProgramResumeCapability({
        profileContext: {
          name: profileContext.name,
          home: profileContext.home,
          cwd: profileContext.cwd,
          installAnchor: profileContext.installAnchor,
          overlays: profileContext.overlays ?? [],
          telemetryDisabledEnv: profileContext.telemetryDisabledEnv,
        },
        launch: launchEnvironment,
        presetId: startup.presetId,
        env: process.env,
        execArgv: process.execArgv,
        argv: process.argv,
        execPath: process.execPath,
        stdinIsTTY: process.stdin.isTTY === true,
        stdoutIsTTY: process.stdout.isTTY === true,
        platform: process.platform,
      }))
  const env = buildChildEnvironment(profileContext, encodeLaunchEnvelope(startup), process.env)
  if (programResume !== undefined) applyProgramResumeChildEnvironment(env, programResume)
  // The daemon supervisor paints nothing: keep its diagnostics off the terminal.
  const diag = createEntryDiag('host', () => {})
  const reportFatal = (line: string): void => { try { process.stderr.write(`${line}\n`) } catch { /* best effort */ } }
  // Qualification-only (env-gated) runtime Loader-state dump: writes every entry's
  // EVALUATED `disabled` + fiber state from the real supervisor Context, so the
  // isolation proof reads real admission state, not composed config strings.
  const loaderDumpPath = process.env.M62A_LOADER_DUMP
  if (loaderDumpPath !== undefined && loaderDumpPath !== '') {
    // Qualification-only, env-gated. Writes to a SAFE private target only (see
    // writeQualificationDump) and its timers/subscription are owned by this row's
    // Fiber via ctx.effect; after dispose no timer fires and nothing is written.
    const produce = (): string => {
      const loader = ctx.get('loader') as { entries?: () => Iterable<{ id: string; disabled?: boolean; fiber?: { state?: unknown } }> } | undefined
      const rows: Array<{ id: string; disabled: boolean; state: unknown }> = []
      if (loader !== undefined && typeof loader.entries === 'function') {
        for (const entry of loader.entries()) rows.push({ id: entry.id, disabled: entry.disabled === true, state: entry.fiber !== undefined ? entry.fiber.state : null })
      }
      return JSON.stringify(rows)
    }
    const scheduler = createLoaderDumpScheduler(produce, text => writeQualificationDump(loaderDumpPath, text))
    const readyForDump = ctx.get('appReady') as { onReady?: (listener: () => void) => () => void } | undefined
    const cancelReady = readyForDump !== undefined && typeof readyForDump.onReady === 'function' ? readyForDump.onReady(() => { scheduler.schedule(800) }) : undefined
    scheduler.schedule(4000)
    ctx.effect(() => () => { cancelReady?.(); scheduler.dispose() }, 'm62a-loader-dump lifecycle')
  }
  const coordinator = new DaemonCoordinator({ spawnImpl: spawn, entry, env, appExit, diag, reportFatal })

  // The launcher row is successfully assembled: report it to the startup row's
  // cold-ready handshake. Setting this synchronously (during mount, before the
  // launcher's own readiness-deferred spawn) is what lets that handshake
  // distinguish a mounted launcher from a missing/failed/pending one.
  startup.markCoordinatorMounted?.()

  // Start only on the REAL cold-start readiness settlement: an HMR re-apply that
  // runs after readiness already committed must not spawn a second Client.
  const ready = ctx.get('appReady') as { onReady(listener: () => void): () => void } | undefined
  if (ready === undefined) {
    coordinator.start()
  } else {
    let registrationReturned = false
    const cancel = ready.onReady(() => {
      if (!registrationReturned) return
      coordinator.start()
    })
    registrationReturned = true
    ctx.effect(() => () => { cancel() }, 'pi-tui-daemon-launcher readiness')
  }
  // The fiber disposer RETURNS the awaitable dispose so Cordis waits for the
  // Client's real exit during shutdown (never exits the parent underneath a
  // still-cleaning child). Still the ONE stop owner — no second signal manager.
  ctx.effect(() => () => coordinator.dispose(), 'pi-tui-daemon-launcher child lifecycle')
}

/** Assemble the ONE trusted-profile ACP stdio launch for this official Profile.
 *  No Client artifact, TUI, Host or Session is created by the parent; the
 *  preflight is a read-only authenticated `readAcpStdioTarget` call. */
function applyAcpStdio(
  ctx: Context,
  startup: TuiAcpStdioStartup,
  profileContext: ProfileContextLike,
  appExit: (code: number) => void,
): void {
  const profile = managementProfile(profileContext)
  const runner = new AcpStdioRunner({
    profileName: profile.name,
    preflight: async signal => {
      const { readAcpStdioTarget } = await import('./local-daemon-control.ts')
      return await readAcpStdioTarget(profile, signal)
    },
    resolveEntry: () => resolveAcpStdioEntry(profile.packageRoot),
    spawnImpl: spawn,
    appExit,
    diag: createEntryDiag('host', () => {}),
  })
  // The launch Promise exists BEFORE the cold-ready callback can run; the
  // callback only releases its gate.
  runner.prepare()
  startup.markCoordinatorMounted?.()
  const ready = ctx.get('appReady') as { onReady(listener: () => void): () => void } | undefined
  if (ready === undefined) {
    runner.start()
  } else {
    let registrationReturned = false
    const cancel = ready.onReady(() => {
      // A callback that ran INSIDE `onReady` means readiness was committed
      // before this row existed (an HMR re-apply); this row witnessed no
      // startup and must not spawn a child.
      if (!registrationReturned) return
      runner.start()
    })
    registrationReturned = true
    ctx.effect(() => () => { cancel() }, 'pi-tui-acp-stdio readiness')
  }
  ctx.effect(() => () => runner.dispose(), 'pi-tui-acp-stdio lifecycle')
}

/** The official Profile facts the one-shot management runners need. */
function managementProfile(profileContext: ProfileContextLike): {
  readonly name: string
  readonly dir: string
  readonly home: string
  readonly installAnchor: string
  readonly packageRoot: string
  readonly dshVersion: string
} {
  return {
    name: profileContext.name,
    dir: profileContext.dir,
    home: profileContext.home,
    installAnchor: profileContext.installAnchor,
    packageRoot: resolveProfilePackageRoot(profileContext.dir),
    dshVersion: readInstalledDshVersion(profileContext.installAnchor),
  }
}

/** Mount the ONE one-shot management lifecycle: mark the launcher mounted, start
 *  only on the real cold-ready commit, and dispose through the row fiber. */
function mountManagementRunner(
  ctx: Context,
  startup: TuiDaemonControlStartup | TuiWebControlStartup | TuiAcpControlStartup,
  runner: DaemonControlRunner,
  controller: AbortController,
): void {
  // The row mounted: the startup handshake must not report a missing launcher.
  startup.markCoordinatorMounted?.()
  const ready = ctx.get('appReady') as { onReady(listener: () => void): () => void } | undefined
  const lifecycleName = startup.kind === 'web-control'
    ? 'pi-tui-web-control'
    : startup.kind === 'acp-control'
      ? 'pi-tui-acp-control'
      : 'pi-tui-daemon-control'
  if (ready === undefined) {
    runner.start()
  } else {
    let registrationReturned = false
    const cancel = ready.onReady(() => {
      if (!registrationReturned) return
      runner.start()
    })
    registrationReturned = true
    ctx.effect(() => () => { cancel() }, `${lifecycleName} readiness`)
  }
  ctx.effect(() => () => {
    controller.abort()
    return runner.dispose()
  }, `${lifecycleName} lifecycle`)
}

/** Assemble ONE daemon management operation for this official Profile. No
 *  Client artifact is resolved, no Client is spawned and no TUI/Direct row is
 *  opened. */
function applyManagement(
  ctx: Context,
  startup: TuiDaemonControlStartup,
  profileContext: ProfileContextLike,
  appExit: (code: number) => void,
): void {
  const profile = managementProfile(profileContext)
  const controller = new AbortController()
  const runner = new DaemonControlRunner({
    run: async () => {
      const { runDaemonControl } = await import('./local-daemon-control.ts')
      return await runDaemonControl(startup.control, profile, { signal: controller.signal })
    },
    appExit,
  })
  mountManagementRunner(ctx, startup, runner, controller)
}

/** Assemble ONE headless ACP CLI operation for this official Profile. It never
 *  resolves a Client artifact, never spawns a Client or the ACP stdio adapter
 *  and never opens the TUI. */
function applyAcpControl(
  ctx: Context,
  startup: TuiAcpControlStartup,
  profileContext: ProfileContextLike,
  appExit: (code: number) => void,
): void {
  const profile = managementProfile(profileContext)
  const controller = new AbortController()
  const runner = new DaemonControlRunner({
    run: async () => {
      const { runLocalAcpControl } = await import('./local-acp-control.ts')
      return await runLocalAcpControl(startup.control, profile, { signal: controller.signal })
    },
    appExit,
    // An unexpected ACP CLI failure must never be reported as a daemon manager
    // or stdio-bridge failure: the fixed prefix names the acp command and
    // carries no secret.
    fallback: {
      code: 4,
      stdout: '',
      stderr: 'dsh-pi-tui acp: ACP_CLI_UNAVAILABLE: an unexpected local ACP CLI failure occurred\n',
    },
  })
  mountManagementRunner(ctx, startup, runner, controller)
}

/** Assemble ONE headless Web CLI operation for this official Profile. It never
 *  resolves a Client artifact, never spawns a Client and never opens the TUI. */
function applyWebControl(
  ctx: Context,
  startup: TuiWebControlStartup,
  profileContext: ProfileContextLike,
  appExit: (code: number) => void,
): void {
  const profile = managementProfile(profileContext)
  const controller = new AbortController()
  const runner = new DaemonControlRunner({
    run: async () => {
      const { runLocalWebControl } = await import('./local-web-control.ts')
      return await runLocalWebControl(startup.control, profile, { signal: controller.signal })
    },
    appExit,
    // An unexpected Web CLI failure must never be reported as a daemon manager
    // failure: the fixed prefix names the web command and carries no secret.
    fallback: {
      code: 4,
      stdout: '',
      stderr: 'dsh-pi-tui web: WEB_CLI_UNAVAILABLE: an unexpected local web CLI failure occurred\n',
    },
  })
  mountManagementRunner(ctx, startup, runner, controller)
}
