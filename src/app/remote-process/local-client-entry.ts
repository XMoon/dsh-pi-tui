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

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mergeCause } from '../remote/dispose-cause.ts'
import { attachEntryControl, createEntryDiag, writeEntryRecord } from './entry-control.ts'
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
import type { LocalClientHandle } from './client-bootstrap.ts'
import type { LocalClientTransport } from './local-transport.ts'
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

/** The launcher-supplied facts one Client-only process needs. */
export interface LocalClientEntryOptions {
  /** Absolute path of the installed `@deepseek-ai/dsh/package.json`. */
  readonly dshAnchor: string
  /** Profile whose installed package table supplies the peer-resolution layer. */
  readonly profile: string
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
  // The single-TUI seat precedes discovery: a second Client never spawns a
  // Host or touches the existing connection.
  const seat: ProcessSeat = await bindProcessSeat(scope.clientSeatSocketName, 'CLIENT_ALREADY_ACTIVE')
  let context: import('@deepseek-ai/cordis').Context | undefined
  let transport: LocalClientTransport | undefined
  let handle: LocalClientHandle | undefined
  const diag = createEntryDiag('client')
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
  let resolveStopped: (() => void) | undefined
  const stopped = new Promise<void>(resolve => { resolveStopped = resolve })
  let terminalError: unknown
  let compositionDone = false

  const stop = (code: number, failure?: unknown): Promise<void> => {
    if (stopping !== undefined) return stopping
    stopping = (async () => {
      if (failure !== undefined) {
        const primary = failure instanceof Error ? failure : new Error(String(failure))
        writeEntryRecord({
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
        if (handle !== undefined) {
          // UI subtree -> official transport -> Client root, all owned by the
          // handle's single reverse-disposal path.
          try { await handle.dispose() } catch (error) { errors.push(error) }
          return
        }
        try { await transport?.dispose() } catch (error) { errors.push(error) }
        try { await context?.fiber.dispose() } catch (error) { errors.push(error) }
      }, errors)
      const transportCleanupFailed = errors.some(error => error instanceof Error && (error as { cleanupFailed?: boolean }).cleanupFailed === true)
      if (errors.length > 0 || timedOut) {
        const primary = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0] ?? 'client disposal failed'))
        writeEntryRecord({
          m4a0: 'cleanup-failure',
          processRole: 'client',
          phase: 'shutdown',
          pid: process.pid,
          error: primary.message,
        })
        process.exitCode = 1
      } else if (failure !== undefined) {
        writeEntryRecord({ m4a0: 'cleanup', processRole: 'client', phase: 'after-context', pid: process.pid, status: 'completed' })
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

  try {
    const host = await ensureLocalHost({
      scope,
      hostEntryPath: join(packageRoot, 'dist', 'local-host.mjs'),
      dshAnchor: options.dshAnchor,
      profile: options.profile,
    })
    writeEntryRecord({
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
    writeEntryRecord({ m4a0: 'context-ready', processRole: 'client', pid: process.pid, phase: 'context-ready' })

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
    writeEntryRecord({
      m4a0: 'transport-ready',
      processRole: 'client',
      pid: process.pid,
      phase: 'transport-ready',
      ...transport.status(),
    })

    // Qualification-only startup-failure control. The internal entry is not a
    // public surface; this flag lets the process lane exercise the after-
    // context reverse cleanup without perturbing the installed-build
    // fingerprint that a renamed chunk would change.
    if (process.env.SPLIT_PROCESS_CLIENT_FORCE_FAILURE === 'client-bootstrap') {
      throw new Error('local client entry: qualification forced client bootstrap failure')
    }
    const { startLocalClient } = await import('./client-bootstrap.ts')
    handle = await startLocalClient(context, {}, processStartIdentity, { transport, host: host.identity })
    if (terminalError !== undefined) {
      // A terminal transport failure may have arrived while the UI subtree was
      // mounting; never emit a ready state after stop was requested.
      await stop(1, terminalError)
      return
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
    writeEntryRecord({ m4a0: 'ready', ...handle.status })
    compositionDone = true

    attachEntryControl(async request => {
      if (request.op === 'status') {
        writeEntryRecord({
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
        writeEntryRecord({
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
        })
        writeEntryRecord({
          ...proof,
          processRole: 'client',
          ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
        })
        return false
      }
      writeEntryRecord({ m4a0: 'control-error', error: `local client entry: unknown op ${JSON.stringify(request.op)}` })
      return false
    })
    await stopped
  } catch (error) {
    const failure = terminalError ?? error
    let primary = failure instanceof Error ? failure : new Error(String(failure))
    const cleanupErrors: unknown[] = []
    const timedOut = await disposeWithinDeadline(async () => {
      if (handle !== undefined) {
        try { await handle.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
        return
      }
      try { await transport?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      try { await context?.fiber.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
    }, cleanupErrors)
    for (const cleanupError of cleanupErrors) primary = mergeCause(primary, cleanupError)
    const transportCleanupFailed = (error instanceof Error && (error as { cleanupFailed?: boolean }).cleanupFailed === true)
      || cleanupErrors.some(cleanupError => cleanupError instanceof Error && (cleanupError as { cleanupFailed?: boolean }).cleanupFailed === true)
    writeEntryRecord({
      m4a0: 'failure',
      processRole: 'client',
      phase: context === undefined ? 'startup' : 'after-context',
      pid: process.pid,
      ...(transport?.status() ?? {}),
      ...(failure instanceof LocalScopeError ? { code: failure.code } : {}),
      error: primary.message,
      ...(primary.stack === undefined ? {} : { stack: primary.stack }),
      ...(primary.cause === undefined ? {} : { cause: primary.cause instanceof Error ? primary.cause.message : String(primary.cause) }),
    })
    process.stdin.pause()
    if (cleanupErrors.length === 0 && !timedOut && !transportCleanupFailed) {
      writeEntryRecord({ m4a0: 'cleanup', processRole: 'client', phase: 'after-context', pid: process.pid, status: 'completed' })
    } else {
      const cleanup = cleanupErrors[0] instanceof Error ? cleanupErrors[0] : new Error(String(cleanupErrors[0]))
      writeEntryRecord({
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
      await seat.close()
    } catch (error) {
      writeEntryRecord({
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

/** Read the launcher environment; a missing anchor is a hard startup failure. */
function optionsFromEnvironment(): LocalClientEntryOptions {
  const dshAnchor = process.env.SPLIT_PROCESS_DSH_ANCHOR
  if (dshAnchor === undefined || dshAnchor === '') {
    throw new Error('local client entry: SPLIT_PROCESS_DSH_ANCHOR must name the installed @deepseek-ai/dsh/package.json')
  }
  return { dshAnchor, profile: process.env.SPLIT_PROCESS_PROFILE ?? 'pi-tui' }
}

if (import.meta.main) {
  try {
    await runLocalClientEntry(optionsFromEnvironment())
  } catch (error) {
    writeEntryRecord({
      m4a0: 'failure',
      processRole: 'client',
      phase: 'startup',
      pid: process.pid,
      ...(error instanceof LocalScopeError ? { code: error.code } : {}),
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
    })
    process.exit(1)
  }
}
