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
import type { TuiDaemonClientStartup, TuiDaemonControlStartup, TuiDaemonStartupValues } from '../../startup.ts'

/** Stable Loader row id / Cordis plugin name. */
export const name = 'pi-tui-daemon-launcher'

/** The daemon Coordinator only exists when the daemon backend published its service. */
export const inject = ['tuiDaemonStartup']

/** The private v1 public-launch data channel (shared shape with the Client entry). */
const CLIENT_LAUNCH_ENVELOPE_ENV = 'SPLIT_PROCESS_CLIENT_LAUNCH_V1'

/** The launcher-provided Profile facts the Coordinator needs (official shape). */
interface ProfileContextLike {
  readonly name: string
  readonly dir: string
  readonly home: string
  readonly installAnchor: string
  readonly cwd: string
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
 * Resolve the installed Client entry from THIS package root and prove its real
 * target is a regular file. A shared npm package, a root-owned system install
 * and a legal entry symlink are normal installs; only a missing or non-regular
 * target is a hard failure — never a fallback to a source tree or `tsx`.
 */
export function resolveClientEntry(packageRoot: string): string {
  // The NAMED entry path is what the Client child receives; it locates its
  // package root from that invoked path, so a legal dist/entry symlink still
  // resolves THIS package root.
  const entry = join(packageRoot, 'dist', 'local-client.mjs')
  let real: string
  try {
    real = realpathSync(entry)
  } catch (error) {
    throw new Error(`pi-tui daemon launcher: the Client entry ${entry} is missing`, { cause: error })
  }
  if (!lstatSync(real).isFile()) {
    throw new Error(`pi-tui daemon launcher: the Client entry ${entry} must resolve to a regular file`)
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
    throw new Error(`pi-tui daemon launcher: the Client entry ${entry} cannot locate its installed package root`, { cause: error })
  }
  if (entryRoot !== expectedRoot) {
    throw new Error(`pi-tui daemon launcher: the Client entry ${entry} resolves a different installed package root`)
  }
  return entry
}

/**
 * Resolve this installed bundle's package root through the OFFICIAL profile
 * resolution. The launcher module itself may be reached through a symlinked
 * `dist`, so its own module URL is not a reliable package-root locator.
 */
function resolveProfilePackageRoot(profileDir: string): string {
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
  env.SPLIT_PROCESS_DSH_ANCHOR = profileContext.installAnchor
  env.SPLIT_PROCESS_PROFILE = profileContext.name
  env.SPLIT_PROCESS_CLIENT_MODE = 'surface'
  env[CLIENT_LAUNCH_ENVELOPE_ENV] = launchEnvelope
  return env
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
  private readonly shutdownBudgetMs: number
  private child: ChildProcess | undefined
  private childExit: Promise<void> | undefined
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
    shutdownBudgetMs?: number
  }) {
    this.spawnImpl = options.spawnImpl
    this.entry = options.entry
    this.env = options.env
    this.appExit = options.appExit
    this.diag = options.diag
    this.reportFatal = options.reportFatal ?? (() => {})
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
      this.settle(1, error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.child = child
    this.spawnCount += 1
    this.childExit = new Promise<void>(resolve => {
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    })
    child.once('error', (error: Error) => { this.settle(1, error) })
    child.once('exit', (code, signal) => { this.settle(exitCodeFor(code, signal), undefined) })
  }

  private settle(code: number, error: Error | undefined): void {
    if (this.settled) return
    this.settled = true
    if (error !== undefined) {
      this.diag.warn('pi-tui daemon: client process failed', { error: error.message })
      // R2-01: the supervisor TTY must get ONE actionable, sanitized line — never
      // a bare nonzero exit, and never the raw error (which can carry a path). The
      // spawn errno code is safe to name; everything else is fixed text.
      const errno = (error as { code?: unknown }).code
      const safeErrno = typeof errno === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/u.test(errno) ? ` (${errno})` : ''
      this.reportFatal(`dsh-pi-tui: could not start the daemon Client process${safeErrno}; the Host was not started. Reinstall the profile and re-run: DSH_PI_TUI_BACKEND=daemon dsh --profile pi-tui`)
    }
    this.appExit(code)
  }

  /**
   * The SINGLE stop owner, AWAITABLE. A spawn not yet started is cancelled; a
   * live child is asked to stop once (SIGTERM) and dispose() resolves only after
   * the child actually exited, so the parent Fiber disposer holds the child's
   * cleanup rather than the parent process exiting underneath it. The wait is
   * bounded to fit the official ~5s shutdown deadline; a child that does not exit
   * within it is escalated to SIGKILL and awaited briefly. Idempotent.
   */
  dispose(): Promise<boolean> {
    if (this.disposePromise !== undefined) return this.disposePromise
    this.disposed = true
    this.disposePromise = (async (): Promise<boolean> => {
      const child = this.child
      const exited = this.childExit
      if (child === undefined || child.exitCode !== null || child.signalCode !== null || exited === undefined) return true
      const start = Date.now()
      const budgetEnd = start + this.shutdownBudgetMs
      // Reserve part of the ONE budget for the SIGKILL phase so a SIGTERM phase
      // that never stops the child cannot consume the whole budget.
      const killReserve = Math.min(1000, Math.max(50, Math.floor(this.shutdownBudgetMs * 0.25)))
      const killAt = budgetEnd - killReserve
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
  }) {
    this.run = options.run
    this.appExit = options.appExit
    this.writeStdout = options.writeStdout ?? (text => { process.stdout.write(text) })
    this.writeStderr = options.writeStderr ?? (text => { process.stderr.write(text) })
    this.reportFatal = options.reportFatal ?? (() => {})
    this.shutdownBudgetMs = options.shutdownBudgetMs ?? 4000
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
        result = {
          code: 4,
          stdout: '',
          stderr: 'dsh-pi-tui daemon: MANAGER_OR_OS_FAILURE: an unexpected local management failure occurred\n',
        }
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

  const packageRoot = resolveProfilePackageRoot(profileContext.dir)
  const entry = resolveClientEntry(packageRoot)
  const env = buildChildEnvironment(profileContext, encodeLaunchEnvelope(startup))
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

/** Assemble ONE management operation for this official Profile. No Client
 *  artifact is resolved, no Client is spawned and no TUI/Direct row is opened. */
function applyManagement(
  ctx: Context,
  startup: TuiDaemonControlStartup,
  profileContext: ProfileContextLike,
  appExit: (code: number) => void,
): void {
  const packageRoot = resolveProfilePackageRoot(profileContext.dir)
  const profile = {
    name: profileContext.name,
    dir: profileContext.dir,
    home: profileContext.home,
    installAnchor: profileContext.installAnchor,
    packageRoot,
    dshVersion: readInstalledDshVersion(profileContext.installAnchor),
  }
  const controller = new AbortController()
  const runner = new DaemonControlRunner({
    run: async () => {
      const { runDaemonControl } = await import('./local-daemon-control.ts')
      return await runDaemonControl(startup.control, profile, { signal: controller.signal })
    },
    appExit,
  })
  // The row mounted: the startup handshake must not report a missing launcher.
  startup.markCoordinatorMounted?.()
  const ready = ctx.get('appReady') as { onReady(listener: () => void): () => void } | undefined
  if (ready === undefined) {
    runner.start()
  } else {
    let registrationReturned = false
    const cancel = ready.onReady(() => {
      if (!registrationReturned) return
      runner.start()
    })
    registrationReturned = true
    ctx.effect(() => () => { cancel() }, 'pi-tui-daemon-control readiness')
  }
  ctx.effect(() => () => {
    controller.abort()
    return runner.dispose()
  }, 'pi-tui-daemon-control lifecycle')
}
