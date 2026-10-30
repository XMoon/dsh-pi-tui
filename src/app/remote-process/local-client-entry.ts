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
  MountedRemoteClientDomains,
  MountedRemoteClientDomainPrerequisites,
} from './client-bootstrap.ts'
import type { InstalledLocalClientTransport, LocalClientTransport } from './local-transport.ts'
import {
  createSplitClientInteractionDelivery,
  type SplitClientInteractionDeliveryOwner,
} from './client-interaction-delivery.ts'
import { createLocalClientSurfaceBridge } from './local-client-surface.ts'
import { runDetached } from '../../runtime/process/tasks.ts'

interface OfficialClientHostModules {
  readonly Context: new () => import('@deepseek-ai/cordis').Context
  readonly PluginPackages: abstract new (...args: never[]) => unknown
  readonly Loader: new (ctx: import('@deepseek-ai/cordis').Context) => import('@deepseek-ai/cordis-plugin-loader').Loader
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
  const loaderModule = await importResolved('@deepseek-ai/cordis-plugin-loader')
  const homePaths = await importResolved('@deepseek-ai/dsh-home-paths')
  return {
    Context: cordis.Context as OfficialClientHostModules['Context'],
    PluginPackages: appBoot.PluginPackages as OfficialClientHostModules['PluginPackages'],
    Loader: loaderModule.default as OfficialClientHostModules['Loader'],
    loadProfile: appBoot.loadProfile as OfficialClientHostModules['loadProfile'],
    createRuntimeResolution: appBoot.createRuntimeResolution as OfficialClientHostModules['createRuntimeResolution'],
    resolveDshHome: homePaths.resolveDshHome as OfficialClientHostModules['resolveDshHome'],
    resolveProfileDir: appBoot.resolveProfileDir as OfficialClientHostModules['resolveProfileDir'],
  }
}

/** The internal Client process mode: frozen B1 qualification, the real
 *  surface, or the qualification-only non-TUI answering Peer. */
export type LocalClientEntryMode = 'qualification' | 'surface' | 'peer'

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

/** The single internal Loader builtin name of the interaction startup gate. */
export const INTERACTION_STARTUP_GATE = 'pi-tui-interaction-startup-gate'

/**
 * The ONE interaction startup gate entry: its async Loader plugin holds the
 * official Gateway's `loader.await()` until the official Session resolver and
 * the root interaction listeners exist. Settles once; a stop/failure rejects
 * the pending gate so the Gateway never starts after cancellation.
 */
interface InteractionStartupGate {
  readonly plugin: () => Promise<void>
  readonly pending: boolean
  release(): void
  cancel(reason: unknown): void
}

export function createInteractionStartupGate(): InteractionStartupGate {
  let resolveBarrier: (() => void) | undefined
  let rejectBarrier: ((reason: unknown) => void) | undefined
  let state: 'pending' | 'released' | 'cancelled' = 'pending'
  const barrier = new Promise<void>((resolve, reject) => {
    resolveBarrier = resolve
    rejectBarrier = reject
  })
  return {
    plugin: async () => { await barrier },
    get pending(): boolean { return state === 'pending' },
    release(): void {
      if (state !== 'pending') return
      state = 'released'
      resolveBarrier?.()
    },
    cancel(reason: unknown): void {
      if (state !== 'pending') return
      state = 'cancelled'
      rejectBarrier?.(reason)
    },
  }
}

/** The official Remote service subset the qualification Peer observes. */
interface PeerRemoteService {
  readonly events?: {
    answer?: (frame: { readonly event: string; readonly eventId: string }, clientId: string, signal?: AbortSignal) => Promise<unknown>
  }
  readonly userQuestions?: {
    answer(sessionId: string, callId: string, answer: unknown): Promise<{ readonly ok: boolean; readonly value?: boolean; readonly error?: { readonly code?: string } }>
  }
}

/** One pending forwarded interaction held by the non-TUI answering Peer. */
interface PeerInteractionSeat {
  answer(kind: 'question' | 'approval', callId: string, value: unknown): boolean
  dispose(): void
}

const PEER_ABORTED = Symbol('peer-request-aborted')

/**
 * The qualification-only non-TUI answering Peer: it registers the two official
 * `$on` listeners and holds each forwarded request until the smoke sends the
 * exact `peer-answer` control record. It never renders, never takes the TUI
 * seat and never invents a Host decision.
 */
function createPeerInteractionSeat(
  remote: import('./client-interaction-delivery.ts').SplitClientInteractionEventsSource,
  sessions: { scopeOf(owner: unknown): string | undefined },
  emit: EntryRecordSink,
): PeerInteractionSeat {
  const pending = new Map<string, (value: unknown) => void>()
  const owned: Array<() => void> = []
  let sequence = 0
  const KEY = (kind: 'question' | 'approval', key: string): string => `${kind}:${key}`
  const waitForAnswer = async (
    kind: 'question' | 'approval',
    callId: string,
    signal: AbortSignal | undefined,
  ): Promise<unknown> => {
    return await new Promise<unknown>(resolve => {
      let settled = false
      const settle = (value: unknown): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        pending.delete(KEY(kind, callId))
        resolve(value)
      }
      const onAbort = (): void => { settle(PEER_ABORTED) }
      pending.set(KEY(kind, callId), settle)
      if (signal?.aborted === true) onAbort()
      else signal?.addEventListener('abort', onAbort, { once: true })
    })
  }
  owned.push(remote.$on('user-questions/request', async function (this: unknown, request, next) {
    const sessionId = sessions.scopeOf(this)
    if (sessionId === undefined) return next()
    const callId = request.wait?.callId
    const peerKey = typeof callId === 'string' ? callId : `question-${++sequence}`
    emit({
      m4a0: 'peer-interaction',
      kind: 'question',
      peerKey,
      callId: typeof callId === 'string' ? callId : undefined,
      sessionId,
    })
    const value = await waitForAnswer('question', peerKey, request.signal)
    if (value === PEER_ABORTED) throw new Error('local client entry: peer question request aborted')
    return value as never
  }))
  owned.push(remote.$on('approval/request', async function (this: unknown, request, next) {
    const sessionId = sessions.scopeOf(this)
    if (sessionId === undefined) return (next as () => unknown)()
    const callId = request.callId
    const peerKey = typeof callId === 'string' ? callId : `approval-${++sequence}`
    emit({
      m4a0: 'peer-interaction',
      kind: 'approval',
      peerKey,
      callId: typeof callId === 'string' ? callId : undefined,
      sessionId,
    })
    const value = await waitForAnswer('approval', peerKey, request.signal)
    if (value === PEER_ABORTED) throw new Error('local client entry: peer approval request aborted')
    return value
  }))
  return {
    answer(kind, callId, value): boolean {
      const settle = pending.get(KEY(kind, callId))
      if (settle === undefined) return false
      settle(value)
      return true
    },
    dispose(): void {
      for (const off of owned.splice(0)) off()
      for (const settle of [...pending.values()]) settle(PEER_ABORTED)
    },
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
  // The qualification-only answering Peer is NOT a TUI and must not take the
  // single-TUI seat: it is the protocol counterpart used by the stale-result
  // negative controls while the real TUI Client owns the seat.
  const seat: ProcessSeat = options.mode === 'peer'
    ? { close: async () => {} }
    : await bindProcessSeat(scope.clientSeatSocketName, 'CLIENT_ALREADY_ACTIVE')
  let context: import('@deepseek-ai/cordis').Context | undefined
  let loaderFiber: Fiber | undefined
  let startupGate: InteractionStartupGate | undefined
  let installedTransport: InstalledLocalClientTransport | undefined
  let transport: LocalClientTransport | undefined
  let domainPrerequisites: MountedRemoteClientDomainPrerequisites | undefined
  let mountedDomains: MountedRemoteClientDomains | undefined
  let interactionDelivery: SplitClientInteractionDeliveryOwner | undefined
  let peerSeat: PeerInteractionSeat | undefined
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
        // A stop before the Client Context exists has no startup graph to
        // wait for. Once the Context exists, the in-flight staged startup owns
        // the partial graph; wait for its single startup gate so the root is
        // never disposed underneath a late `startLocalClient` call.
        if (startupPromise === undefined && context !== undefined && !compositionDone) await startupReady
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
        try { interactionDelivery?.dispose() } catch (error) { errors.push(error) }
        try { peerSeat?.dispose() } catch (error) { errors.push(error) }
        // Stop the official Gateway/Connection before the Session Client goes
        // away; its generation signal is what releases every pending delivery.
        try { await transport?.dispose() } catch (error) { errors.push(error) }
        try { await domainPrerequisites?.dispose() } catch (error) { errors.push(error) }
        try { await mountedDomains?.dispose() } catch (error) { errors.push(error) }
        // Only after the official Gateway/Connection is disposed may the gate
        // settle: the upstream Loader await cannot call a live connection.start
        // after cancellation.
        startupGate?.cancel(failure ?? new Error('local client entry: stop requested during startup'))
        try { await loaderFiber?.dispose() } catch (error) { errors.push(error) }
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

  // Install the process-lifetime shutdown handlers BEFORE the first staged
  // startup resource exists. The Loader gate, transport fibers and Domain
  // prerequisites are all created below; a SIGTERM/SIGINT during any of those
  // stages must enter the ONE stop coordinator instead of the default action.
  process.on('SIGTERM', () => {
    emit({ m4a0: 'signal', processRole: 'client', pid: process.pid, signal: 'SIGTERM' })
    runDetached('local client: SIGTERM shutdown', () => stop(0), { diag })
  })
  process.on('SIGINT', () => {
    emit({ m4a0: 'signal', processRole: 'client', pid: process.pid, signal: 'SIGINT' })
    runDetached('local client: SIGINT shutdown', () => stop(130), { diag })
  })

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
    startupAbort.signal.throwIfAborted()
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

    // The official resolution interception is live before these dynamic
    // imports; the chunks' bare @deepseek-ai imports therefore resolve exactly
    // like a Loader-mounted plugin's would.
    const transportModule = await import('./local-transport.ts')
    const { mountSurfaceClientDomainPrerequisites, startLocalClient } = await import('./client-bootstrap.ts')
    const onTransportFatal = (error: unknown): void => {
      terminalError ??= error
      // Before the composition is ready, the sequential startup path owns the
      // single stop; a concurrent stop while the UI subtree is mounting could
      // tear down the context twice and race the readiness publication.
      if (compositionDone) {
        runDetached('local client: terminal transport identity failure', () => stop(1, terminalError), { diag })
      }
    }
    if (options.mode === 'surface' || options.mode === 'peer') {
      const clientContext = context
      if (clientContext === undefined) throw new Error('local client entry: the Client root Context is missing')
      // 1. The REAL Cordis Loader is installed first and owns the official
      // Gateway's startup gate. Its one internal builtin entry stays pending
      // until the Session resolver and the root interaction listeners exist;
      // the upstream `ClientRemoteService` sees that pending entry in
      // `loader.await()` and therefore does not start `connection.start()`.
      loaderFiber = clientContext.plugin(hostModules.Loader as never, {} as never)
      await loaderFiber
      const loader = clientContext.get('loader') as import('@deepseek-ai/cordis-plugin-loader').Loader | undefined
      if (loader === undefined) throw new Error('local client entry: the official Cordis Loader did not install')
      startupGate = createInteractionStartupGate()
      loader.builtins[INTERACTION_STARTUP_GATE] = startupGate.plugin as never
      await loader.create({ name: `cordis:${INTERACTION_STARTUP_GATE}` })
      startupAbort.signal.throwIfAborted()
      if (!startupGate.pending) throw new Error('local client entry: the interaction startup gate failed before the transport install')
      const gateHold = process.env.SPLIT_PROCESS_CLIENT_HOLD_STARTUP_GATE
      if (gateHold !== undefined && gateHold !== '') {
        emit({ m4b2s: 'qualification', op: 'startup-gate-hold', stage: 'loader-gate', barrier: gateHold })
        await waitForStartupHold(gateHold, startupAbort.signal)
      }
      // 2. Install typert/connection/gateway. Gateway applies its service but
      // its event pump waits for the Loader gate above.
      installedTransport = await transportModule.installLocalTransport(clientContext, {
        dshAnchor: options.dshAnchor,
        host,
        scope,
        diag,
        signal: startupAbort.signal,
        onFatal: onTransportFatal,
      })
      transport = installedTransport
      startupAbort.signal.throwIfAborted()
      // 3. Mount the official Session Client (Agent resolver) and the other
      // Domain prerequisites while the event pump is still gated.
      domainPrerequisites = await mountSurfaceClientDomainPrerequisites(clientContext, { dshAnchor: options.dshAnchor })
      const remote = clientContext.get('remote') as unknown as import('./client-interaction-delivery.ts').SplitClientInteractionEventsSource | undefined
      if (remote === undefined) throw new Error('local client entry: the official Client Remote service did not install')
      const remoteService = clientContext.get('remote') as unknown as PeerRemoteService | undefined
      const peerFrames = new Map<string, { readonly clientId: string; readonly event: string }>()
      if (options.mode === 'peer' && remoteService?.events?.answer !== undefined) {
        // Test-only protocol observer: capture the official forwarded-event
        // identity (clientId/eventId) and the frame before the real answerer
        // runs. It never replaces the official dispatcher: the original method
        // is called unbound on its own owner.
        const events = remoteService.events
        const originalAnswer = events.answer
        if (originalAnswer === undefined) throw new Error('local client entry: the official Remote event dispatcher is unavailable')
        events.answer = async function (frame, clientId, signal) {
          peerFrames.set(String(frame.eventId), { clientId, event: frame.event })
          emit({
            m4a0: 'peer-frame',
            event: frame.event,
            eventId: String(frame.eventId),
            clientId,
          })
          return await originalAnswer.call(events, frame, clientId, signal)
        }
      }
      // 4. Register the TWO official listeners EXACTLY ONCE for this Client
      // root, then release the gate. Only now may the Gateway start. The
      // surface mode borrows the root delivery owner; the qualification-only
      // answering Peer registers its own held-answer listeners.
      if (options.mode === 'surface') {
        interactionDelivery = createSplitClientInteractionDelivery({ remote, sessions: domainPrerequisites.sessions })
      } else {
        peerSeat = createPeerInteractionSeat(remote, domainPrerequisites.sessions, emit)
      }
      const typert = clientContext.get('typert') as unknown as {
        contexts: { getClient(name: string): unknown }
      } | undefined
      emit({
        m4b2s: 'qualification',
        op: 'interaction-startup-gate',
        phase: 'listeners-ready',
        agentResolver: typert?.contexts.getClient('agent') !== undefined,
        questionListeners: 1,
        approvalListeners: 1,
        loaderTasks: loader.getTasks().length,
      })
      startupGate.release()
      // 5. First real generation + authenticated identity audit. `transport`
      // is the same installed handle once ready.
      transport = await transportModule.awaitLocalTransportReady(installedTransport, { signal: startupAbort.signal })
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
      // 6. Complete the root Domain graph: Jobs Client + official initial
      // readiness. Every surface revision below borrows this ONE graph.
      mountedDomains = await domainPrerequisites.complete({ signal: startupAbort.signal })
      domainPrerequisites = undefined
      startupAbort.signal.throwIfAborted()
      emit({ m4b2s: 'qualification', op: 'startup-stage', stage: 'domains-ready', pid: process.pid })
      if (options.mode === 'peer') {
        emit({
          m4a0: 'ready',
          processRole: 'client',
          pid: process.pid,
          phase: 'peer-ready',
          mode: 'peer',
          hostPid: host.identity.hostPid,
          hostInstanceId: host.identity.instanceId,
          ...traceTransportStatus(),
        })
        compositionDone = true
        attachEntryControl(async request => {
          if (request.op === 'status') {
            emit({ m4a0: 'status', pid: process.pid, ...traceTransportStatus() })
            return false
          }
          if (request.op === 'peer-answer') {
            const kind = request.kind
            const callId = request.callId
            const value = request.value
            if ((kind !== 'question' && kind !== 'approval') || typeof callId !== 'string') {
              emit({ m4a0: 'control-error', error: 'peer-answer requires kind/callId/value' })
              return false
            }
            const delivered = peerSeat?.answer(kind, callId, value) === true
            emit({ m4a0: 'peer-answer-sent', kind, callId, delivered })
            return false
          }
          if (request.op === 'peer-send-stale-result') {
            const eventId = request.eventId
            const clientId = request.clientId
            const outcome = request.value
            if (typeof eventId !== 'string' || typeof clientId !== 'string' || outcome === undefined) {
              emit({ m4a0: 'control-error', error: 'peer-send-stale-result requires eventId/clientId/value' })
              return false
            }
            const connection = clientContext.get('connection') as unknown as {
              rpc: { call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<{ readonly ok: boolean; readonly error?: { readonly code?: string; readonly message?: string } }> }
            } | undefined
            if (connection === undefined) throw new Error('local client entry: the qualification Peer has no Connection RPC')
            const response = await connection.rpc.call('/api', '$events/result', {
              args: { clientId, eventId, outcome },
            })
            emit({
              m4a0: 'peer-stale-result-sent',
              eventId,
              clientId,
              ok: response.ok === true,
              ...(response.error?.code === undefined ? {} : { errorCode: response.error.code }),
            })
            return false
          }
          if (request.op === 'peer-question-answer') {
            const sessionId = request.sessionId
            const callId = request.callId
            const value = request.value
            if (typeof sessionId !== 'string' || typeof callId !== 'string' || value === undefined) {
              emit({ m4a0: 'control-error', error: 'peer-question-answer requires sessionId/callId/value' })
              return false
            }
            if (remoteService?.userQuestions === undefined) throw new Error('local client entry: the qualification Peer has no userQuestions namespace')
            const result = await remoteService.userQuestions.answer(sessionId, callId, value)
            emit({
              m4a0: 'peer-question-answer',
              sessionId,
              callId,
              ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
              ok: result.ok === true,
              ...(result.ok ? { value: result.value === true } : { errorCode: result.error?.code, error: result.error }),
            })
            return false
          }
          if (request.op === 'shutdown') {
            await stop(0)
            return true
          }
          emit({ m4a0: 'control-error', error: `local client entry: unknown op ${JSON.stringify(request.op)}` })
          return false
        })
        await stopped
        return
      }
    } else {
      transport = await transportModule.startLocalTransport(context, {
        dshAnchor: options.dshAnchor,
        host,
        scope,
        diag,
        onFatal: onTransportFatal,
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
    }

    // Qualification-only startup-failure control. The internal entry is not a
    // public surface; this flag lets the process lane exercise the after-
    // context reverse cleanup without perturbing the installed-build
    // fingerprint that a renamed chunk would change.
    if (process.env.SPLIT_PROCESS_CLIENT_FORCE_FAILURE === 'client-bootstrap') {
      throw new Error('local client entry: qualification forced client bootstrap failure')
    }
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
            return run.catch(error => stop(1, error))
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
          domains: mountedDomains,
          interactionDelivery,
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
      // Release a stop that is waiting for the one startup gate; this path is
      // the startup chain's own failure exit, so no `startLocalClient` call
      // can still arrive.
      startupReadyResolve?.()
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
      try { interactionDelivery?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      try { peerSeat?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      try { await transport?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      try { await domainPrerequisites?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      try { await mountedDomains?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
      startupGate?.cancel(primary)
      try { await loaderFiber?.dispose() } catch (cleanupError) { cleanupErrors.push(cleanupError) }
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
  if (raw === 'qualification' || raw === 'surface' || raw === 'peer') return raw
  throw new Error(`local client entry: invalid SPLIT_PROCESS_CLIENT_MODE ${JSON.stringify(raw)}; expected "qualification", "surface" or "peer"`)
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
