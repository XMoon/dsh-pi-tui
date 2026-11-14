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
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installedPackageRootFromEntry } from './local-scope.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { createEntryDiag } from './entry-control.ts'
import type { TuiDaemonStartupValues } from '../../startup.ts'

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
export function encodeLaunchEnvelope(startup: TuiDaemonStartupValues): string {
  return JSON.stringify({
    version: 1,
    ...(startup.sessionLaunch === undefined ? {} : { sessionLaunch: startup.sessionLaunch }),
    ...(startup.presetId === undefined ? {} : { presetId: startup.presetId }),
    ...(startup.backendSource === undefined ? {} : { backendSource: startup.backendSource }),
  })
}

/**
 * Resolve the installed Client entry from THIS package root and prove it is a
 * real regular file owned by this process user. A missing/non-regular/symlinked
 * entry is a hard failure — never a fallback to a source tree or `tsx`.
 */
export function resolveClientEntry(packageRoot: string): string {
  const entry = join(packageRoot, 'dist', 'local-client.mjs')
  let info
  try {
    info = lstatSync(entry)
  } catch (error) {
    throw new Error(`pi-tui daemon launcher: the Client entry ${entry} is missing`, { cause: error })
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`pi-tui daemon launcher: the Client entry ${entry} must be a regular file`)
  }
  if (uid !== undefined && info.uid !== uid) {
    throw new Error(`pi-tui daemon launcher: the Client entry ${entry} is not owned by this process user`)
  }
  return entry
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
  private child: ChildProcess | undefined
  private started = false
  private disposed = false
  private settled = false
  /** Test observation: how many children were actually spawned. */
  spawnCount = 0

  constructor(options: {
    spawnImpl: SpawnImpl
    entry: string
    env: NodeJS.ProcessEnv
    appExit: (code: number) => void
    diag: Diag
  }) {
    this.spawnImpl = options.spawnImpl
    this.entry = options.entry
    this.env = options.env
    this.appExit = options.appExit
    this.diag = options.diag
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
    child.once('error', (error: Error) => { this.settle(1, error) })
    child.once('exit', (code, signal) => { this.settle(exitCodeFor(code, signal), undefined) })
  }

  private settle(code: number, error: Error | undefined): void {
    if (this.settled) return
    this.settled = true
    if (error !== undefined) this.diag.warn('pi-tui daemon: client process failed', { error: error.message })
    this.appExit(code)
  }

  /**
   * The SINGLE stop owner. A spawn not yet started is cancelled; a live child is
   * asked to stop once (SIGTERM) and the process is NOT re-exited by dispose (the
   * single settle owns the exit code). Idempotent.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    if (child !== undefined && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
    }
  }
}

/** The production Coordinator row: resolve the installed Client, spawn it once
 *  on the real cold-start readiness settlement, and own its single lifecycle. */
export function apply(ctx: Context): void {
  const startup = ctx.get('tuiDaemonStartup') as TuiDaemonStartupValues | undefined
  if (startup === undefined) return
  const appExit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (appExit === undefined) throw new Error('pi-tui daemon launcher: ctx.appExit is required')
  const profileContext = ctx.get('profileContext') as ProfileContextLike | undefined
  if (profileContext === undefined) throw new Error('pi-tui daemon launcher: ctx.profileContext is required')

  const packageRoot = installedPackageRootFromEntry(import.meta.url)
  const entry = resolveClientEntry(packageRoot)
  const env = buildChildEnvironment(profileContext, encodeLaunchEnvelope(startup))
  // The daemon supervisor paints nothing: keep its diagnostics off the terminal.
  const diag = createEntryDiag('host', () => {})
  const coordinator = new DaemonCoordinator({ spawnImpl: spawn, entry, env, appExit, diag })

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
  ctx.effect(() => () => { coordinator.dispose() }, 'pi-tui-daemon-launcher child lifecycle')
}
