#!/usr/bin/env node
/**
 * M4-B1 Client-only process entry.
 *
 * The Client PID owns a real Cordis root and mounts only the Client-local
 * subtree plus the official Node Client transport. Its one scope is the
 * canonical DSH profile: it first claims the kernel single-TUI seat, then
 * discovers (or safely ensures) the Host, authenticates it through the
 * official `/connect` cookie, verifies the authenticated identity, and only
 * then installs the official three-layer transport on the same A0 Client
 * Context.
 *
 * The launcher supplies the DSH installation anchor and profile name through
 * `SPLIT_PROCESS_DSH_ANCHOR` / `SPLIT_PROCESS_PROFILE` so this process can
 * install the same official package-resolution interception the dsh launcher
 * uses. The package's own `dist/` location stays the installation point — no
 * repository source path or tsx loader is involved.
 *
 * @module app/remote-process/local-client-entry
 */

import { constants, closeSync, existsSync, fchmodSync, fstatSync, lstatSync, openSync, realpathSync, statSync, writeSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import { mergeCause } from '../remote/dispose-cause.ts'
import { attachEntryControl, createEntryDiag, writeEntryRecord, type EntryRecordSink } from './entry-control.ts'
import {
  bindProcessSeat,
  installedPackageRootFromEntry,
  LocalScopeError,
  readInstalledDshVersion,
  readLinuxStarttime,
  scopeFromInstalledProfile,
  type ProcessSeat,
} from './local-scope.ts'
import { ensureLocalHost, type VerifiedLocalHost } from './local-discovery.ts'
import type {
  LocalClientComposition,
  LocalClientHandle,
  MountedLocalClientRunner,
} from './client-bootstrap.ts'
import type { LocalClientTransport } from './local-transport.ts'
import { createLocalClientSurfaceBridge } from './local-client-surface.ts'
import { runDetached } from '../../runtime/process/tasks.ts'

interface OfficialClientHostModules {
  readonly Context: new () => import('@deepseek-ai/cordis').Context
  readonly PluginPackages: abstract new (...args: never[]) => unknown
  readonly loadProfile: (binName: string, name: string, installAnchor: string) => unknown
  readonly createRuntimeResolution: (options: {
    installAnchor: string
    profile: unknown
  }) => Promise<unknown>
  readonly resolveDshHome: () => string
  readonly resolveProfileDir: (name: string, home?: string) => string
}

/** Load the published DSH modules this entry needs, from the installation anchor. */
async function loadOfficialClientHost(anchor: string): Promise<OfficialClientHostModules> {
  const requireFromDsh = createRequire(realpathSync(anchor))
  const importResolved = async (specifier: string): Promise<Record<string, unknown>> =>
    import(pathToFileURL(requireFromDsh.resolve(specifier)).href)
  const appBoot = await importResolved('@deepseek-ai/dsh-app-boot')
  const cordis = await importResolved('@deepseek-ai/cordis')
  const homePaths = await importResolved('@deepseek-ai/dsh-home-paths')
  return {
    Context: cordis.Context as OfficialClientHostModules['Context'],
    PluginPackages: appBoot.PluginPackages as OfficialClientHostModules['PluginPackages'],
    loadProfile: appBoot.loadProfile as OfficialClientHostModules['loadProfile'],
    createRuntimeResolution: appBoot.createRuntimeResolution as OfficialClientHostModules['createRuntimeResolution'],
    resolveDshHome: homePaths.resolveDshHome as OfficialClientHostModules['resolveDshHome'],
    resolveProfileDir: appBoot.resolveProfileDir as OfficialClientHostModules['resolveProfileDir'],
  }
}

/** The internal Client process mode: frozen B1 qualification or the real surface. */
export type LocalClientEntryMode = 'qualification' | 'surface'

/** The launcher-supplied facts one Client-only process needs. */
export interface LocalClientEntryOptions {
  /** Absolute path of the installed `@deepseek-ai/dsh/package.json`. */
  readonly dshAnchor: string
  /** Profile whose installed package table supplies the peer-resolution layer. */
  readonly profile: string
  /** Internal mode; the production default is the frozen qualification channel. */
  readonly mode: LocalClientEntryMode
  /** Surface-mode internal `--session` intent (qualified resume); absent = sessionless. */
  readonly sessionId?: string
  /** Surface-mode internal `--preset` intent (fresh-session create). */
  readonly presetId?: string
}

/** Project the authenticated record without the profile path or cookie. */
function hostRecordForTrace(host: VerifiedLocalHost): Record<string, unknown> {
  const record = host.identity
  return {
    scopeId: record.scopeId,
    instanceId: record.instanceId,
    hostPid: record.hostPid,
    hostStarttime: record.hostStarttime,
    origin: record.origin,
    protocol: record.protocol,
    bundleVersion: record.bundleVersion,
    dshVersion: record.dshVersion,
    buildId: record.buildId,
  }
}

/**
 * The surface-mode telemetry sink: an owner-managed `0600` absolute JSONL file
 * under the isolated qualification work root. Terminal bytes never carry JSON
 * in surface mode, and the file never records a Cookie, token or private Host
 * profile path. The parent directory's REAL path and ownership are validated
 * before the file is opened; a symlinked target is refused.
 */
function createSurfaceRecordSink(): { emit: EntryRecordSink; close(): void } {
  const target = process.env.SPLIT_PROCESS_CLIENT_RECORD_FILE
  if (target === undefined || target === '') {
    throw new Error('local client entry: surface mode requires SPLIT_PROCESS_CLIENT_RECORD_FILE')
  }
  if (!isAbsolute(target)) {
    throw new Error('local client entry: the surface record file path must be absolute')
  }
  const directory = realpathSync(dirname(target))
  const directoryStats = statSync(directory)
  if (!directoryStats.isDirectory()) {
    throw new Error('local client entry: the surface record directory is not a directory')
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && directoryStats.uid !== uid) {
    throw new Error('local client entry: the surface record directory is not owned by this process user')
  }
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new Error('local client entry: the surface record file must not be a symlink')
  }
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600)
  // `openSync` honors the supplied creation mode only for a NEW file; an
  // existing broader mode is narrowed explicitly so the sink is always 0600.
  if ((fstatSync(fd).mode & 0o777) !== 0o600) fchmodSync(fd, 0o600)
  if ((fstatSync(fd).mode & 0o777) !== 0o600) {
    closeSync(fd)
    throw new Error('local client entry: the surface record file must have mode 0600')
  }
  return {
    emit: record => { writeSync(fd, `${JSON.stringify(record)}\n`) },
    close: () => { closeSync(fd) },
  }
}

/** The surface-mode startup intent: an explicit internal input, never a
 *  control-channel override of published behavior. */
function surfaceStartupFacts(options: LocalClientEntryOptions): { sessionId?: string; presetId?: string } {
  const sessionId = process.env.SPLIT_PROCESS_CLIENT_SESSION
  const presetId = process.env.SPLIT_PROCESS_CLIENT_PRESET
  if (options.mode !== 'surface') return {}
  if (sessionId !== undefined && sessionId.trim() === '') {
    throw new Error('local client entry: SPLIT_PROCESS_CLIENT_SESSION must be non-empty when set')
  }
  if (presetId !== undefined && presetId.trim() === '') {
    throw new Error('local client entry: SPLIT_PROCESS_CLIENT_PRESET must be non-empty when set')
  }
  return {
    ...(sessionId === undefined || sessionId === '' ? {} : { sessionId }),
    ...(presetId === undefined || presetId === '' ? {} : { presetId }),
  }
}

/**
 * Run one Client-only process until its launcher requests shutdown. Exported
 * for the qualification harness; `import.meta.main` is the only production
 * caller.
 */
export async function runLocalClientEntry(options: LocalClientEntryOptions): Promise<void> {
  const hostModules = await loadOfficialClientHost(options.dshAnchor)
  const dshHome = hostModules.resolveDshHome()
  const packageRoot = installedPackageRootFromEntry(import.meta.url)
  const scope = scopeFromInstalledProfile({
    dshHome,
    profileDir: hostModules.resolveProfileDir(options.profile, dshHome),
    packageRoot,
    dshVersion: readInstalledDshVersion(options.dshAnchor),
  })
  const processStartIdentity = readLinuxStarttime()
  // Surface mode separates the terminal (owned by PiTui) from the structured
  // telemetry channel (a private 0600 JSONL file). Qualification keeps the
  // frozen JSONL control channel on stdin/stdout.
  const recordSink = options.mode === 'surface' ? createSurfaceRecordSink() : undefined
  const emit: EntryRecordSink = recordSink?.emit ?? writeEntryRecord
  // Publish the business PID before any seat/assembly work: a signal-stop test
  // must be able to address THIS process while it is still assembling and no
  // ready record exists yet. No secret/path is carried.
  emit({ m4a0: 'client-started', processRole: 'client', pid: process.pid, phase: 'startup' })
  // The single-TUI seat precedes discovery: a second Client never spawns a
  // Host or touches the existing connection.
  const seat: ProcessSeat = await bindProcessSeat(scope.clientSeatSocketName, 'CLIENT_ALREADY_ACTIVE')
  let context: import('@deepseek-ai/cordis').Context | undefined
  let transport: LocalClientTransport | undefined
  let handle: LocalClientHandle | undefined
  /** The CURRENT revision's surface bridge behind the ONE root `appExit`. */
  let activeBridge: import('./local-client-surface.ts').LocalClientSurfaceBridge | undefined
  /** The ONE serial revision task slot shared by HMR and stop. */
  let revisionTask: Promise<void> = Promise.resolve()
  const enqueueRevisionTask = (task: () => Promise<void>): Promise<void> => {
    const run = revisionTask.then(task, task)
    revisionTask = run.then(() => {}, () => {})
    return run
  }
  const diag = createEntryDiag('client', recordSink?.emit)
  const CLIENT_DISPOSE_DEADLINE_MS = 10_000
  const disposeWithinDeadline = async (dispose: () => Promise<void>, errors: unknown[]): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(true), CLIENT_DISPOSE_DEADLINE_MS)
    })
    const done = dispose().then(() => false, error => { errors.push(error); return false })
    const timedOut = await Promise.race([done, deadline])
    if (timer !== undefined) clearTimeout(timer)
    if (timedOut) errors.push(new Error('local client entry: client disposal deadline exceeded'))
    return timedOut
  }
  const forceExitAfterCleanupFailure = (): void => {
    process.stdin.pause()
    // One immediate turn lets the small structured records reach the pipe; the
    // official fiber that failed to settle must not keep the process parked.
    setImmediate(() => { process.exit(1) })
  }
  let stopping: Promise<void> | undefined
  /** Resolves when the ONE startup chain has been entered/finished. A stop
   *  that lands before `startupPromise` exists waits here instead of disposing
   *  the root underneath a late `startLocalClient` call. */
  let startupReadyResolve: (() => void) | undefined
  const startupReady = new Promise<void>(resolve => { startupReadyResolve = resolve })
  /** The ONE startup cancellation owner: a stop aborts every in-flight mount
   *  and readiness wait before any teardown starts. */
  const startupAbort = new AbortController()
  /** The in-flight ONE startup chain; `stop` awaits it before disposing. */
  let startupPromise: Promise<LocalClientHandle> | undefined
  /** Whether the transport/root release already happened (single-root latch). */
  let rootReleased = false
  let resolveStopped: (() => void) | undefined
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve })
  let terminalError: unknown
  let compositionDone = false

  const stop = (code: number, failure?: unknown): Promise<void> => {
    if (stopping !== undefined) return stopping
    // A signal/exit request while the assembly is still running aborts the
    // Domain readiness, assembly holds and runner readiness FIRST; the startup
    // chain then unwinds exactly the graph it created, and this coordinator
    // performs the ONE transport/root release after it settles.
    startupAbort.abort(failure ?? new Error('local client entry: stop requested during startup'))
    stopping = (async () => {
      if (failure !== undefined) {
        const primary = failure instanceof Error ? failure : new Error(String(failure))
        emit({
          m4a0: 'failure',
          processRole: 'client',
          phase: context === undefined ? 'startup' : 'after-context',
          pid: process.pid,
          ...(failure instanceof LocalScopeError ? { code: failure.code } : {}),
          error: primary.message,
          ...(primary.stack === undefined ? {} : { stack: primary.stack }),
        })
      }
      const errors: unknown[] = []
      const timedOut = await disposeWithinDeadline(async () => {
        if (rootReleased) return
        // A stop can land during the dynamic client-bootstrap import or before
        // `startupPromise` is assigned. Wait for the startup gate so the root
        // is never disposed underneath a late `startLocalClient` call.
        if (startupPromise === undefined && !compositionDone) await startupReady
        // Wait for the in-flight assembly to settle: a success publishes the
        // ONE handle, a failure has already unwound the graph it created.
        if (startupPromise !== undefined && handle === undefined) {
          try {
            handle = await startupPromise
          } catch {
            // The startup's failure unwind owns the graph. The borrowed
            // transport/root still belong to this coordinator.
          }
        }
        if (handle !== undefined) {
          // A same-process surface revision in flight owns the Context until it
          // settles. Stop aborted its signal first; now wait for the ONE serial
          // revision slot before releasing the root.
          await revisionTask
          try { await handle.dispose() } catch (error) { errors.push(error) }
          rootReleased = true
          return
        }
        try { await transport?.dispose() } catch (error) { errors.push(error) }
        try { await context?.fiber.dispose() } catch (error) { errors.push(error) }
        rootReleased = true
      }, errors)
      if (options.mode === 'surface' && handle !== undefined) {
        // The final owner inventory the qualification reads after the process
        // left: every Client-owned service row and `tuiMainView` reference is
        // released (0), while the Host is untouched. Emitted BEFORE the record
        // sink closes and before the process exits.
        emit({ m4b2s: 'client-closed', ...traceStatus(handle.status) })
      }
      const transportCleanupFailed = errors.some(error => error instanceof Error && (error as { cleanupFailed?: boolean }).cleanupFailed === true)
      if (errors.length > 0 || timedOut) {
        const primary = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0] ?? 'client disposal failed'))
        emit({
          m4a0: 'cleanup-failure',
          processRole: 'client',
          phase: 'shutdown',
          pid: process.pid,
          error: primary.message,
        })
        process.exitCode = 1
      } else if (failure !== undefined) {
        emit({ m4a0: 'cleanup', processRole: 'client', phase: 'after-context', pid: process.pid, status: 'completed' })
        process.exitCode = 1
      } else {
        process.exitCode = code
      }
      // Pause the qualification control channel so its resumed stdin pipe no
      // longer keeps the process alive after disposal. The dispatcher's own
      // stop hook does the same for a control-channel shutdown.
      process.stdin.pause()
      resolveStopped?.()
      if (timedOut || transportCleanupFailed) forceExitAfterCleanupFailure()
    })()
    return stopping
  }

  /**
   * The structured status of the transport for a record. Surface mode strips
   * the private Host home path; the qualification channel keeps its frozen
   * shape. Cookie/token values never enter a record on either path.
   */
  const traceTransportStatus = (): Record<string, unknown> => {
    if (transport === undefined) return {}
    const observed = transport.status()
    if (options.mode !== 'surface') return observed as unknown as Record<string, unknown>
    const { hostHome: _hostHome, ...safe } = observed
    return safe
  }
  /**
   * The same projection for the handle status (surface mode strips the Host
   * home path; the qualification status shape is unchanged).
   */
  const traceStatus = (status: LocalClientHandle['status']): Record<string, unknown> => {
    if (options.mode !== 'surface') return status as unknown as Record<string, unknown>
    const { hostHome: _hostHome, ...safe } = status
    return safe
  }

  try {
    const host = await ensureLocalHost({
      scope,
      hostEntryPath: join(packageRoot, 'dist', 'local-host.mjs'),
      dshAnchor: options.dshAnchor,
      profile: options.profile,
    })
    emit({
      m4a0: 'host-authenticated',
      processRole: 'client',
      pid: process.pid,
      phase: 'host-authenticated',
      host: hostRecordForTrace(host),
    })

    const loadedProfile = hostModules.loadProfile('split-process-client', options.profile, options.dshAnchor)
    const resolution = await hostModules.createRuntimeResolution({
      installAnchor: options.dshAnchor,
      profile: loadedProfile,
    })
    context = new hostModules.Context()
    const packageFiber = context.plugin(hostModules.PluginPackages as never, { resolution } as never)
    await packageFiber
    emit({ m4a0: 'context-ready', processRole: 'client', pid: process.pid, phase: 'context-ready' })

    // The official resolution interception is live before this dynamic import;
    // the transport chunk's bare @deepseek-ai imports therefore resolve exactly
    // like a Loader-mounted plugin's would.
    const { startLocalTransport } = await import('./local-transport.ts')
    transport = await startLocalTransport(context, {
      dshAnchor: options.dshAnchor,
      host,
      scope,
      diag,
      onFatal: error => {
        terminalError ??= error
        // Before the composition is ready, the sequential startup path owns the
        // single stop; a concurrent stop while the UI subtree is mounting could
        // tear down the context twice and race the readiness publication.
        if (compositionDone) {
          runDetached('local client: terminal transport identity failure', () => stop(1, terminalError), { diag })
        }
      },
    })
    if (terminalError !== undefined) {
      await stop(1, terminalError)
      return
    }
    emit({
      m4a0: 'transport-ready',
      processRole: 'client',
      pid: process.pid,
      phase: 'transport-ready',
      ...traceTransportStatus(),
    })

    // Qualification-only startup-failure control. The internal entry is not a
    // public surface; this flag lets the process lane exercise the after-
    // context reverse cleanup without perturbing the installed-build
    // fingerprint that a renamed chunk would change.
    if (process.env.SPLIT_PROCESS_CLIENT_FORCE_FAILURE === 'client-bootstrap') {
      throw new Error('local client entry: qualification forced client bootstrap failure')
    }
    // Install the process-lifetime shutdown handlers BEFORE the ready record:
    // the qualification harness sends SIGTERM as soon as it observes ready, and
    // a handler installed afterwards loses that race to the default action.
    process.on('SIGTERM', () => {
      runDetached('local client: SIGTERM shutdown', () => stop(0), { diag })
    })
    process.on('SIGINT', () => {
      runDetached('local client: SIGINT shutdown', () => stop(130), { diag })
    })
    const clientContext = context
    if (clientContext === undefined) throw new Error('local client entry: the Client root Context is missing')
    const surfaceFacts = surfaceStartupFacts(options)
    /**
     * The ONE allowed process-composition edge into `app/bootstrap.ts`
     * (architecture gate: exact lazy dynamic import, this entry only). It runs
     * only AFTER `PluginPackages` installed the official runtime resolution and
     * the Client bootstrap mounted the official Domain/UI/application graph; it
     * mounts the runner as its own Cordis fiber on the SAME Client Context.
     */
    const mountRunner: NonNullable<LocalClientComposition['mountRunner']> = async input => {
      const bridge = createLocalClientSurfaceBridge(code => {
        runDetached('local client: surface exit', () => stop(code), { diag })
      })
      // The root `appExit` bridge (provided ONCE below) reads the CURRENT
      // revision's bridge. It must never point at a disposed revision's
      // callback after a same-process surface replacement.
      activeBridge = bridge
      const { applyRunnerWithRuntime } = await import('../bootstrap.ts')
      let runnerFiber: Fiber | undefined
      try {
        runnerFiber = clientContext.plugin(pluginContext => {
          applyRunnerWithRuntime(pluginContext, input.config, input.override, {
            surfaceReady: () => bridge.markMounted(),
            surfaceFailed: error => bridge.fail(error),
          })
        })
        await runnerFiber
      } catch (error) {
        bridge.fail(error)
        throw error
      }
      const fiber = runnerFiber
      return {
        ready: bridge.ready,
        stopped: bridge.stopped,
        dispose: async (): Promise<void> => { await fiber.dispose() },
        ...(fiber.uid == null ? {} : { fiberUid: fiber.uid }),
      }
    }
    if (options.mode === 'surface') {
      // The ONE root `appExit` service. It delegates to the CURRENT revision's
      // bridge; a replacement swaps `activeBridge` before the new runner mounts.
      clientContext.provide('appExit', (code: number) => { activeBridge?.requestStop(code) })
      // Qualification-only same-process surface HMR (M4-C1): SIGUSR2 retires
      // and remounts the Client surface on the SAME PID/Context/transport. It
      // is mutually exclusive with the T34/T36 SIGUSR2 qualification modes.
      if (process.env.SPLIT_PROCESS_CLIENT_HMR_PROBE === '1') {
        if (process.env.SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF === '1'
          || (process.env.SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE !== undefined
            && process.env.SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE !== '')) {
          throw new Error('local client entry: the HMR qualification signal is mutually exclusive with the T34/T36 SIGUSR2 modes')
        }
        process.on('SIGUSR2', () => {
          if (handle === undefined) return
          runDetached('local client: surface HMR', () => {
            const run = enqueueRevisionTask(async () => {
              await handle!.replaceSurfaceForQualification()
            })
            // Failure is observed OUTSIDE the serial task: `stop()` waits for
            // the same slot, so awaiting stop from inside it would deadlock.
            run.catch(error => stop(1, error))
          }, { diag })
        })
      }
      // A closed terminal (PTY HUP) is a normal Client exit: the physical
      // surface can no longer render or accept input. It joins the SAME
      // idempotent stop path as Esc / `/exit` / SIGINT / SIGTERM.
      const onTerminalEnd = (): void => {
        runDetached('local client: terminal EOF shutdown', () => stop(0), { diag })
      }
      process.stdin.on('end', onTerminalEnd)
      process.stdin.on('close', onTerminalEnd)
      // Qualification-only transport-rollover trigger (the B1 control channel
      // has no tty in surface mode): SIGUSR1 drops the physical mux socket
      // exactly like `qualification-drop-websocket`, never a production path.
      process.on('SIGUSR1', () => {
        transport?.dropWebSocketsForQualification()
        emit({ m4b2s: 'qualification', op: 'drop-websocket', processRole: 'client', pid: process.pid })
      })
    }
    const composition: LocalClientComposition = options.mode === 'surface'
      ? {
          mode: 'surface',
          signal: startupAbort.signal,
          transport,
          host: host.identity,
          dshAnchor: options.dshAnchor,
          authenticatedFetch: transport.authenticatedFetch,
          mountRunner,
          diag,
          onStatus: status => {
            emit({ m4b2s: 'surface-status', ...traceStatus(status) })
          },
          onQualification: record => {
            emit({ m4b2s: 'qualification', ...record })
          },
        }
      : { mode: 'qualification', transport, host: host.identity }
    try {
      const { startLocalClient } = await import('./client-bootstrap.ts')
      // Qualification-only hold in the pre-assignment window (the dynamic
      // import and the composition are already resolved, but `startupPromise`
      // is not assigned yet): a SIGTERM here must wait for this ONE gate.
      const holdBeforeStart = process.env.SPLIT_PROCESS_CLIENT_HOLD_BEFORE_START
      if (holdBeforeStart !== undefined && holdBeforeStart !== '') {
        emit({ m4a0: 'qualification', op: 'before-start-hold', processRole: 'client', pid: process.pid })
        await waitForStartupHold(holdBeforeStart, startupAbort.signal)
      }
      startupPromise = startLocalClient(clientContext, surfaceFacts, processStartIdentity, composition)
      handle = await startupPromise
    } finally {
      startupReadyResolve?.()
      startupReadyResolve = undefined
    }
    if (stopping !== undefined) {
      // The signal/exit coordinator already owns the teardown; never publish a
      // ready surface after a stop was requested.
      await stopping
      return
    }
    if (terminalError !== undefined) {
      // A terminal transport failure may have arrived while the UI subtree was
      // mounting; never emit a ready state after stop was requested.
      await stop(1, terminalError)
      return
    }
    emit({ m4a0: 'ready', ...traceStatus(handle.status) })
    compositionDone = true

    if (options.mode === 'surface') {
      // Surface mode owns the tty: the B1 JSONL control channel must never
      // touch stdin/stdout. The process is driven by the real terminal.
      await stopped
      return
    }
    attachEntryControl(async request => {
      if (request.op === 'status') {
        emit({
          m4a0: 'status',
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
          ...handle!.status,
        })
        return false
      }
      if (request.op === 'shutdown') {
        await stop(0)
        return true
      }
      if (request.op === 'qualification-drop-websocket') {
        transport?.dropWebSocketsForQualification()
        emit({
          m4a0: 'qualification',
          op: 'drop-websocket',
          processRole: 'client',
          pid: process.pid,
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        })
        return false
      }
      if (request.op === 'qualification-host-foundation') {
        // Qualification-only: mount the two Remote contributions on THIS live
        // Client Context, prove the official/private RPC and unmount them. The
        // module is loaded dynamically so it never joins the normal startup
        // path or the Client entry's static dependency graph.
        if (context === undefined) throw new Error('local client entry: the qualification probe has no Client Context')
        const { runHostFoundationProbe } = await import('./host-foundation-probe.ts')
        const proof = await runHostFoundationProbe(context, {
          dshAnchor: options.dshAnchor,
          host,
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        })
        emit({
          ...proof,
          processRole: 'client',
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        })
        return false
      }
      emit({ m4a0: 'control-error', error: `local client entry: unknown op ${JSON.stringify(request.op)}` })
      return false
    })
    await stopped
  } catch (error) {
    // A signal/exit coordinator may already own the teardown (the startup was
    // aborted by `stop`). Wait for that ONE coordinator and do not report a
    // second cleanup or a duplicate failure for the expected cancellation.
    if (stopping !== undefined) {
      await stopping
      return
    }
    const failure = terminalError ?? error
    let primary = failure instanceof Error ? failure : new Error(String(failure))
    const cleanupErrors: unknown[] = []
    const timedOut = await disposeWithinDeadline(async () => {
      if (rootReleased) return
      if (handle !== undefined) {
        try { await handle.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
        rootReleased = true
        return
      }
      try { await transport?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      try { await context?.fiber.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      rootReleased = true
    }, cleanupErrors)
    for (const cleanupError of cleanupErrors) primary = mergeCause(primary, cleanupError)
    const transportCleanupFailed = (error instanceof Error && (error as { cleanupFailed?: boolean }).cleanupFailed === true)
      || cleanupErrors.some(cleanupError => cleanupError instanceof Error && (cleanupError as { cleanupFailed?: boolean }).cleanupFailed === true)
    emit({
      m4a0: 'failure',
      processRole: 'client',
      phase: context === undefined ? 'startup' : 'after-context',
      pid: process.pid,
      ...traceTransportStatus(),
      ...(failure instanceof LocalScopeError ? { code: failure.code } : {}),
      error: primary.message,
      ...(primary.stack === undefined ? {} : { stack: primary.stack }),
      ...(primary.cause === undefined ? {} : { cause: primary.cause instanceof Error ? primary.cause.message : String(primary.cause) }),
    })
    process.stdin.pause()
    if (cleanupErrors.length === 0 && !timedOut && !transportCleanupFailed) {
      emit({ m4a0: 'cleanup', processRole: 'client', phase: 'after-context', pid: process.pid, status: 'completed' })
    } else {
      const cleanup = cleanupErrors[0] instanceof Error ? cleanupErrors[0] : new Error(String(cleanupErrors[0]))
      emit({
        m4a0: 'cleanup-failure',
        processRole: 'client',
        phase: 'after-context',
        pid: process.pid,
        error: cleanup.message,
      })
    }
    process.exitCode = 1
    if (timedOut || transportCleanupFailed) forceExitAfterCleanupFailure()
  } finally {
    process.stdin.pause()
    try {
      recordSink?.close()
    } catch (error) {
      process.exitCode = 1
      process.stderr.write(`local client entry: closing the surface record sink failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    try {
      await seat.close()
    } catch (error) {
      emit({
        m4a0: 'cleanup-failure',
        processRole: 'client',
        phase: 'shutdown',
        pid: process.pid,
        step: 'client-seat',
        error: error instanceof Error ? error.message : String(error),
      })
      process.exitCode = 1
    }
  }
}

/**
 * Dispose the Client-owned root and classify a rejecting disposer as a real
 * cleanup failure. The requested success code becomes 1; an interrupt/signal
 * code keeps its nonzero identity. Never returns the success code after a
 * failed dispose, and a second stop call is prevented by the caller's latch.
 */
export async function stopLocalClient(
  handle: { dispose(): Promise<void> },
  requestedCode: number,
  emit: (record: Record<string, unknown>) => void = writeEntryRecord,
): Promise<number> {
  try {
    await handle.dispose()
    return requestedCode
  } catch (error) {
    emit({
      m4a0: 'cleanup-failure',
      processRole: 'client',
      phase: 'shutdown',
      pid: process.pid,
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    })
    return requestedCode === 0 ? 1 : requestedCode
  }
}

/** Qualification-only hold in the pre-startup assignment window. */
async function waitForStartupHold(path: string, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 60_000
  while (!existsSync(path)) {
    signal.throwIfAborted()
    if (Date.now() > deadline) {
      throw new Error(`local client entry: the pre-startup barrier was not released: ${path}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  signal.throwIfAborted()
}

/**
 * Read the internal Client mode. Absent/empty keeps the frozen B1
 * `qualification` contract; `surface` is the internal real-terminal mode. Any
 * other value fails closed (never a silent default).
 */
function clientModeFromEnvironment(): LocalClientEntryMode {
  const raw = process.env.SPLIT_PROCESS_CLIENT_MODE
  if (raw === undefined || raw === '') return 'qualification'
  if (raw === 'qualification' || raw === 'surface') return raw
  throw new Error(`local client entry: invalid SPLIT_PROCESS_CLIENT_MODE ${JSON.stringify(raw)}; expected "qualification" or "surface"`)
}

/** Read the launcher environment; a missing anchor is a hard startup failure. */
function optionsFromEnvironment(): LocalClientEntryOptions {
  const dshAnchor = process.env.SPLIT_PROCESS_DSH_ANCHOR
  if (dshAnchor === undefined || dshAnchor === '') {
    throw new Error('local client entry: SPLIT_PROCESS_DSH_ANCHOR must name the installed @deepseek-ai/dsh/package.json')
  }
  return {
    dshAnchor,
    profile: process.env.SPLIT_PROCESS_PROFILE ?? 'pi-tui',
    mode: clientModeFromEnvironment(),
  }
}

if (import.meta.main) {
  try {
    await runLocalClientEntry(optionsFromEnvironment())
  } catch (error) {
    const record = {
      m4a0: 'failure',
      processRole: 'client',
      phase: 'startup',
      pid: process.pid,
      ...(error instanceof LocalScopeError ? { code: error.code } : {}),
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    }
    if (process.env.SPLIT_PROCESS_CLIENT_MODE === 'surface') {
      // Surface mode owns the tty: a launcher/startup failure is a human line
      // on stderr, never a JSON record on the terminal.
      process.stderr.write(`split client surface: ${record.error}\n`)
    } else {
      writeEntryRecord(record)
    }
    process.exit(1)
  }
}
