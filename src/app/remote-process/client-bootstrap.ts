/**
 * Client-only pre-connection bootstrap for the M4-B1/B2-S process entries.
 *
 * The official Client runtime requires an explicit Host carrier; M4-B1 owns
 * the authenticated cross-process transport in `local-transport.ts`. This
 * module owns two precise modes on the caller's ONE Client Context:
 *
 * - `qualification` (the default, frozen B1 contract): mount only the A0
 *   Client-local subtree (TUI startup facts, extension host, first-party
 *   builtins) and project the official Connection state into a status
 *   snapshot. No official Client domains and no physical surface.
 * - `surface` (the internal M4-B2-S real Client): mount exactly one official
 *   Client Domain graph (the shared `mountRemoteClientDomains`), the one
 *   Client UI subtree, the one split-Client application runtime (Backend +
 *   owners + presentation), then the one real PiTui runner through the
 *   process composition root's lazy `mountRunner` callback. It never creates
 *   a Host handle, never fabricates a Host service, never copies connection
 *   state into a long-lived flag, and never calls a Host shutdown.
 *
 * The surface mode's disposal order is one reverse chain: runner surface
 * (TUI + owned `tuiMainView` + session retirement + the selected Remote
 * adapters), Client UI subtree, the memoized application transport disposer
 * (presentation/backend/domains), the borrowed official transport, then the
 * Client root. `LocalClientHandle.dispose()` is the ONE Client coordinator;
 * the runner's own earlier `selected.disposeTransport()` is the same memoized
 * release, never a second unmount.
 *
 * @module app/remote-process/client-bootstrap
 */

import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { PI_TUI_EXTENSIONS_SERVICE } from '../../extensions.ts'
import type { RemoteApplicationOverride } from '../application-runtime.ts'
import { Config as TuiConfigSchema } from '../config/schema.ts'
import {
  createRemoteApplicationRuntimeFromClient,
  type SplitRemoteApplicationRuntime,
} from '../remote/application-runtime.ts'
import {
  mountRemoteClientDomains,
  type MountedRemoteClientDomains,
} from '../remote/client-runtime.ts'
import { createRemoteClientUiRuntime, type RemoteClientUiRuntime } from '../remote/client-ui-runtime.ts'
import { mergeCause } from '../remote/dispose-cause.ts'
import type { RemoteBackendFetch } from '../remote/runtime.ts'
import type { RemotePromptSerializer } from '../../runtime/remote/session-writer-remote.ts'
import { RemotePromptSerializerProduction } from '../../runtime/remote/prompt-serializer-remote.ts'
import { runDetached } from '../../runtime/process/tasks.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import type { LocalInstanceRecord } from './local-discovery.ts'
import type { LocalClientTransport } from './local-transport.ts'

/** Client-local startup facts handed to the pre-connection subtree. */
export interface LocalClientStartupFacts {
  readonly sessionId?: string
  readonly presetId?: string
}

/** The authenticated Host facts projected into Client status. */
export interface LocalClientHostFacts {
  readonly scopeId: string
  readonly instanceId: string
  readonly hostPid: number
  readonly hostStarttime: string
  readonly origin: string
  readonly protocol: string
  readonly bundleVersion: string
  readonly dshVersion: string
  readonly buildId: string
}

/** A status snapshot built from the official Connection at call time. */
export interface LocalClientStatus {
  readonly processRole: 'client'
  readonly pid: number
  readonly processStartIdentity?: string
  readonly phase: 'client-local-ready'
  readonly transport: 'not-connected' | 'connecting' | 'connected' | 'disconnected'
  /**
   * Whether the TUI SessionRuntime currently holds the official
   * `tuiMainView` reference of a Session. Derived at call time from the
   * official `sessions.retainInfo` source — not from the Domain mount, not
   * from a launch `--session` intent, not from an optimistic flag.
   */
  readonly sessionOpen: boolean
  /** The Session whose `tuiMainView` reference is held (when open). */
  readonly openSessionId?: string
  /**
   * Whether the ONE physical PiTui surface is mounted. A sessionless surface
   * is legitimately `true` with `sessionOpen: false`; the two facts are never
   * merged into one `ready`.
   */
  readonly surfaceMounted: boolean
  readonly fiberOwner: 'client-root'
  readonly rootFiberUid?: number
  readonly extensionService: { readonly present: true }
  readonly startupFacts: { readonly sessionId?: string; readonly presetId?: string }
  readonly host?: LocalClientHostFacts
  readonly generationId?: number
  readonly hostHome?: string
  /** Active lazy WebSocket wrappers; one while connected. */
  readonly activeWrappers?: number
  /** Physical mux sockets still owned; one while connected. */
  readonly liveSockets?: number
  /**
   * Surface-mode owner inventory: one entry per official Client service the
   * split Client composition owns (0 after release). This is the composition's
   * real owner count, not a per-feature guess.
   */
  readonly owners?: Readonly<Record<'typert' | 'connection' | 'remote' | 'fileUpload' | 'sessions' | 'jobs', number>>
  /** The official Client Session-list arrival phase while the Domains are live. */
  readonly sessionsListPhase?: 'pending' | 'ready'
  /** Mounted private pi-tui Remote namespaces (2 while the Domains are live). */
  readonly privateNamespaces?: number
}

/** The ONE mounted split-Client TUI runner. */
export interface MountedLocalClientRunner {
  /** Resolves when the physical surface mounted; rejects on startup failure. */
  readonly ready: Promise<void>
  /** Resolves with the first exit code; a startup wait must not hang on it. */
  readonly stopped: Promise<number>
  /** Dispose the runner fiber (surface + session retirement + adapters). */
  dispose(): Promise<void>
}

/** The inputs the process composition root's lazy runner mount receives. */
export interface LocalClientRunnerMountInput {
  /** The SAME Client Context the B1 transport and Domain graph live on. */
  readonly context: Context
  /** The Client-local TUI configuration (schema defaults + startup facts). */
  readonly config: ReturnType<typeof TuiConfigSchema>
  /** The pre-built Remote selection the runner adopts by identity. */
  readonly override: RemoteApplicationOverride
}

/** The Client composition inputs that are not startup facts. */
export interface LocalClientComposition {
  /** Official transport installed on this same Client Context. */
  readonly transport?: LocalClientTransport
  /** Authenticated Host identity the transport was verified against. */
  readonly host?: LocalInstanceRecord
  /**
   * Internal mode selector: the frozen B1 `qualification` default (JSONL
   * stdin/stdout control, no Client domains, no surface) or the split
   * Client's `surface` mode. There is no public CLI/config selector.
   */
  readonly mode?: 'qualification' | 'surface'
  /** Installed DSH anchor; REQUIRED in surface mode (official module source). */
  readonly dshAnchor?: string
  /** The SAME B1 authenticated Cookie fetch; REQUIRED in surface mode. */
  readonly authenticatedFetch?: RemoteBackendFetch
  /**
   * The lazy runner mount supplied by the process composition root AFTER the
   * official `PluginPackages` resolution is live. It performs the ONE allowed
   * dynamic import of `app/bootstrap.ts` and mounts the runner fiber; it must
   * not construct a second Context/transport/Domain/surface.
   */
  readonly mountRunner?: (input: LocalClientRunnerMountInput) => Promise<MountedLocalClientRunner>
  /**
   * Surface-mode qualification telemetry: one structured status record on every
   * change of the observable tuple (transport, generation, `tuiMainView`
   * ownership, open Session id). The Client entry routes it to its private
   * JSONL file; there is no global emitter and no publication on the tty.
   */
  readonly onStatus?: (status: LocalClientStatus) => void
  /**
   * Surface-mode qualification records that are NOT a status change (the T34
   * admission-stop notification, the T36 private-RPC proof). Routed to the same
   * private sink; production never emits them.
   */
  readonly onQualification?: (record: Record<string, unknown>) => void
  /** Client diagnostics sink for detached qualification work. */
  readonly diag?: Diag
  /**
   * Surface-mode startup cancellation. A process stop closes this signal; every
   * in-flight mount/readiness wait observes it and the ONE startup chain
   * unwinds what it created before the caller disposes the transport/root.
   */
  readonly signal?: AbortSignal
}

/** A live Client composition with its own disposal owner. */
export interface LocalClientHandle {
  /** Fresh snapshot from the official Connection on every read. */
  readonly status: LocalClientStatus
  /**
   * Dispose the Client composition, then the official Client transport, then
   * the Client root. The caller still owns the process seat.
   */
  dispose(): Promise<void>
}

/** Project the authenticated record without the profile path. */
function hostFacts(record: LocalInstanceRecord): LocalClientHostFacts {
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

/** The exact Host startup facts object (never the Host-only readiness seam). */
function startupFactsOf(startup: LocalClientStartupFacts): { readonly sessionId?: string; readonly presetId?: string } {
  return {
    ...(startup.sessionId === undefined ? {} : { sessionId: startup.sessionId }),
    ...(startup.presetId === undefined ? {} : { presetId: startup.presetId }),
  }
}

/**
 * Qualification-only assembly hold: pause ONE startup stage until a barrier
 * file is released OR the caller aborts the startup. It is the deterministic
 * seam for the "stop during Domain readiness / Surface mount" tests; production
 * never sets `SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY`.
 */
async function waitForAssemblyHold(
  stage: 'domain' | 'surface',
  signal: AbortSignal | undefined,
  onHold: ((record: Record<string, unknown>) => void) | undefined,
): Promise<void> {
  const spec = process.env.SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY
  if (spec === undefined || spec === '') return
  const [name, path] = spec.split('@')
  if (name !== stage || path === undefined || path === '') return
  onHold?.({ op: 'assembly-hold', stage, barrier: path })
  const deadline = Date.now() + 60_000
  while (!existsSync(path)) {
    signal?.throwIfAborted()
    if (Date.now() > deadline) {
      throw new Error(`local client entry: the ${stage} assembly barrier was not released`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  signal?.throwIfAborted()
}

/** A never-resolving promise that rejects on abort, plus its listener cleanup. */
function abortable(signal: AbortSignal | undefined): { promise: Promise<never>; cancel(): void } {
  let listener: (() => void) | undefined
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal === undefined) return
    const abort = (): void => { reject(signal.reason ?? new Error('local client entry: startup aborted')) }
    if (signal.aborted) {
      abort()
      return
    }
    listener = abort
    signal.addEventListener('abort', abort, { once: true })
  })
  return {
    promise,
    cancel: () => {
      if (listener !== undefined) signal?.removeEventListener('abort', listener)
    },
  }
}

/** Wait for the qualification barrier file; a bounded wait, never a timer. */
async function waitForQualificationBarrier(path: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`local client entry: the qualification barrier was not released: ${path}`)
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Throw the collected disposal errors with the first one primary. */
function throwDisposalErrors(errors: readonly unknown[], label: string): void {
  if (errors.length === 0) return
  const primary = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]))
  for (const secondary of errors.slice(1)) mergeCause(primary, secondary)
  throw Object.assign(primary, { cleanupFailed: true })
}

/**
 * The ONE split-Client surface composition: Domain graph -> Client UI
 * subtree -> Remote application runtime -> real runner. Every stage is
 * recorded the instant it exists, so a failure at any later stage unwinds the
 * whole partial composition in reverse and the original error stays primary.
 */
async function startSurfaceLocalClient(
  context: Context,
  startup: LocalClientStartupFacts,
  processStartIdentity: string | undefined,
  composition: LocalClientComposition,
): Promise<LocalClientHandle> {
  const { transport, host, dshAnchor, authenticatedFetch, mountRunner } = composition
  const signal = composition.signal
  if (transport === undefined || host === undefined) {
    throw new Error('local client entry: surface mode requires the official transport and the authenticated Host')
  }
  if (dshAnchor === undefined || dshAnchor === '') {
    throw new Error('local client entry: surface mode requires the installed DSH anchor')
  }
  if (authenticatedFetch === undefined) {
    throw new Error('local client entry: surface mode requires the authenticated Host fetch')
  }
  if (mountRunner === undefined) {
    throw new Error('local client entry: surface mode requires the process composition runner mount')
  }

  let domains: MountedRemoteClientDomains | undefined
  let ui: RemoteClientUiRuntime | undefined
  let application: SplitRemoteApplicationRuntime | undefined
  let runner: MountedLocalClientRunner | undefined
  let disposed = false
  let surfaceMounted = false
  let domainsOpen = false
  let surfaceStatusCleanup: (() => void) | undefined

  /** The official `tuiMainView` reference the visible SessionRuntime holds. */
  const openSessionId = (): string | undefined => {
    if (!domainsOpen || domains === undefined) return undefined
    const snapshot = domains.sessions.list.getSnapshot()
    for (const id of snapshot.ids) {
      const info = domains.sessions.retainInfo(id).getSnapshot()
      if ((info.retainedBy.tuiMainView ?? 0) > 0) return String(id)
    }
    return undefined
  }

  const unwind = async (): Promise<void> => {
    surfaceMounted = false
    domainsOpen = false
    surfaceStatusCleanup?.()
    surfaceStatusCleanup = undefined
    const errors: unknown[] = []
    if (runner !== undefined) {
      try { await runner.dispose() } catch (error) { errors.push(error) }
    }
    if (ui !== undefined) {
      try { await ui.dispose() } catch (error) { errors.push(error) }
    }
    // The runner may already have released the selected adapters; this is the
    // SAME memoized release (idempotent). When the runner never mounted, this
    // is the first release and still runs BEFORE the borrowed transport.
    if (application !== undefined) {
      try { await application.selected.disposeTransport() } catch (error) { errors.push(error) }
    } else if (domains !== undefined) {
      try { await domains.dispose() } catch (error) { errors.push(error) }
    }
    // The borrowed transport and the Client root are the ENTRY coordinator's
    // ownership: this function unwinds only the graph it created, so a stop
    // during startup and the final handle disposal never race two root owners.
    throwDisposalErrors(errors, 'local client surface graph')
  }

  const base = {
    processRole: 'client' as const,
    pid: process.pid,
    ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
    phase: 'client-local-ready' as const,
    fiberOwner: 'client-root' as const,
    ...(context.fiber.uid == null ? {} : { rootFiberUid: context.fiber.uid }),
    extensionService: { present: true as const },
    startupFacts: startupFactsOf(startup),
    host: hostFacts(host),
  }
  const status = (): LocalClientStatus => {
    const observed = transport.status()
    const current = openSessionId()
    const privateRemote = domains?.remote as unknown as {
      readonly piTuiFileReferences?: unknown
      readonly piTuiTerminalProgress?: unknown
    } | undefined
    return {
      ...base,
      transport: observed.transport,
      sessionOpen: current !== undefined,
      ...(current === undefined ? {} : { openSessionId: current }),
      surfaceMounted,
      ...(observed.generationId === undefined ? {} : { generationId: observed.generationId }),
      ...(observed.hostHome === undefined ? {} : { hostHome: observed.hostHome }),
      activeWrappers: observed.activeWrappers,
      liveSockets: observed.liveSockets,
      owners: {
        typert: context.reflect.get('typert') === undefined ? 0 : 1,
        connection: context.reflect.get('connection') === undefined ? 0 : 1,
        remote: context.reflect.get('remote') === undefined ? 0 : 1,
        fileUpload: context.reflect.get('fileUpload') === undefined ? 0 : 1,
        sessions: context.reflect.get('sessions') === undefined ? 0 : 1,
        jobs: context.reflect.get('jobs') === undefined ? 0 : 1,
      },
      ...(domainsOpen && domains !== undefined
        ? { sessionsListPhase: domains.sessions.list.getSnapshot().phase }
        : {}),
      privateNamespaces: domainsOpen
        && privateRemote?.piTuiFileReferences !== undefined
        && privateRemote.piTuiTerminalProgress !== undefined
        ? 2
        : 0,
    }
  }

  try {
    signal?.throwIfAborted()
    domains = await mountRemoteClientDomains({
      context,
      dshAnchor,
      ...(signal === undefined ? {} : { signal }),
    })
    domainsOpen = true
    await waitForAssemblyHold('domain', signal, composition.onQualification)
    signal?.throwIfAborted()
    ui = await createRemoteClientUiRuntime({ context, startup: startupFactsOf(startup) })
    signal?.throwIfAborted()
    // T34 qualification input: hold ONE write between its real serialization
    // and the writer's dispatch-admission check. Production never sets this
    // variable; the production serializer stays the default.
    const holdPath = process.env.SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE
    let promptSerializer: RemotePromptSerializer | undefined
    if (holdPath !== undefined && holdPath !== '') {
      const production = RemotePromptSerializerProduction.overSessions(domains.sessions)
      promptSerializer = {
        preflight: message => production.preflight(message),
        async serialize(message) {
          const serialized = await production.serialize(message)
          await waitForQualificationBarrier(holdPath)
          return serialized
        },
      }
    }
    application = await createRemoteApplicationRuntimeFromClient({
      domains,
      fetch: authenticatedFetch,
      clientUi: ui,
      ...(signal === undefined ? {} : { signal }),
      ...(promptSerializer === undefined ? {} : { promptSerializer }),
    })
    signal?.throwIfAborted()
    // T36 qualification input: probe the private Host RPCs through the ALREADY
    // mounted Domain namespaces (no second private contribution).
    if (process.env.SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF === '1') {
      if (composition.diag === undefined) {
        throw new Error('local client entry: the private RPC qualification requires the Client diagnostics sink')
      }
      const diag = composition.diag
      process.on('SIGUSR2', () => {
        const target = openSessionId() ?? domains?.sessions.list.getSnapshot().ids[0]
        if (target === undefined || domains === undefined) {
          composition.onQualification?.({ op: 'private-rpc-proof', error: 'no retained Session' })
          return
        }
        const currentDomains = domains
        runDetached('surface private RPC proof', async () => {
          const remote = currentDomains.remote as unknown as {
            readonly piTuiFileReferences: {
              list(sessionId: string, query: string): Promise<{ readonly ok: boolean; readonly value?: { readonly kind?: unknown } }>
            }
            readonly piTuiTerminalProgress: {
              watch(sessionId: string): {
                dispose(): void
                [Symbol.asyncIterator](): AsyncIterator<{ readonly kind?: unknown }>
              }
            }
          }
          const sessionId = String(target)
          const file = await remote.piTuiFileReferences.list(sessionId, 'notes')
          const watch = remote.piTuiTerminalProgress.watch(sessionId)
          const iterator = watch[Symbol.asyncIterator]()
          let terminalKind: unknown
          try {
            const first = await iterator.next()
            terminalKind = first.done === true ? 'ended' : first.value?.kind
          } finally {
            watch.dispose()
          }
          composition.onQualification?.({
            op: 'private-rpc-proof',
            sessionId,
            fileOk: file.ok === true,
            fileKind: file.ok ? file.value?.kind : undefined,
            terminalKind,
            owners: status().owners,
            privateNamespaces: status().privateNamespaces,
          })
        }, { diag })
      })
    }
    // T34 qualification input: close the writer's pre-dispatch admission while
    // the serializer barrier holds the write; the surface stays mounted so the
    // restored draft is observable.
    if (holdPath !== undefined && holdPath !== '') {
      // SIGUSR2 is the T34 admission-stop trigger; the private-RPC proof above
      // uses the same signal in its own process (the two env flags never
      // coexist), keeping the qualification surface to standard POSIX signals.
      process.on('SIGUSR2', () => {
        application?.selected.stopSurfaceAdmission?.()
        composition.onQualification?.({ op: 'stop-surface-admission' })
      })
    }
    const override: RemoteApplicationOverride = {
      selected: application.selected,
      presentation: application.presentation,
      extensionService: application.extensionService,
    }
    // Schema defaults + the explicit Client-local startup facts. No fabricated
    // profile document: a preference's absence resolves to its schema default.
    const config = TuiConfigSchema({
      ...(startup.sessionId === undefined ? {} : { sessionId: startup.sessionId }),
    } as never)
    signal?.throwIfAborted()
    runner = await mountRunner({ context, config, override })
    await waitForAssemblyHold('surface', signal, composition.onQualification)
    signal?.throwIfAborted()
    // Wait for the physical surface, not merely the mounted runner fiber. An
    // exit request raised during startup is CANCELLATION, never a silent hang.
    const abortReady = abortable(signal)
    try {
      await Promise.race([
        runner.ready,
        runner.stopped.then(code => {
          throw new Error(`local client entry: the surface startup was cancelled by exit request ${String(code)}`)
        }),
        abortReady.promise,
      ])
    } finally {
      abortReady.cancel()
    }
    surfaceMounted = true
    // The qualification-visible projection of the REAL `tuiMainView`
    // ownership: the official Session list names the candidate ids and each
    // id's official `retainInfo` source is the authoritative reference count.
    // A same-id re-retain or an owner switch therefore emits a new record, and
    // a sessionless surface keeps reporting `sessionOpen: false`.
    let lastStatusKey = ''
    const emitStatus = (): void => {
      if (composition.onStatus === undefined) return
      const current = status()
      const key = JSON.stringify([current.transport, current.generationId, current.sessionOpen, current.openSessionId])
      if (key === lastStatusKey) return
      lastStatusKey = key
      composition.onStatus(current)
    }
    const watched = new Map<string, () => void>()
    const watchListedSessions = (): void => {
      if (domains === undefined) return
      for (const id of domains.sessions.list.getSnapshot().ids) {
        const key = String(id)
        if (watched.has(key)) continue
        watched.set(key, domains.sessions.retainInfo(id).subscribe(emitStatus))
      }
    }
    const unsubscribeList = domains.sessions.list.subscribe(() => {
      watchListedSessions()
      emitStatus()
    })
    // The transport identity is part of the observable tuple: a physical mux
    // drop/reconnect changes the official Connection generation and must emit
    // a new record (the retained `tuiMainView` reference is re-adopted by the
    // official service; this record proves the Client observed the rollover).
    const unsubscribeGeneration = transport.connection.generation.subscribe(emitStatus)
    surfaceStatusCleanup = (): void => {
      unsubscribeList()
      unsubscribeGeneration()
      for (const unsubscribe of watched.values()) unsubscribe()
      watched.clear()
    }
    watchListedSessions()
    emitStatus()
  } catch (error) {
    const cleanupErrors: unknown[] = []
    try {
      await unwind()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    let primary = error instanceof Error ? error : new Error(String(error))
    for (const cleanupError of cleanupErrors) primary = mergeCause(primary, cleanupError)
    throw primary
  }

  return {
    get status(): LocalClientStatus {
      return status()
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      try { await unwind() } catch (error) { errors.push(error) }
      try { await transport.dispose() } catch (error) { errors.push(error) }
      try { await context.fiber.dispose() } catch (error) { errors.push(error) }
      throwDisposalErrors(errors, 'local client surface')
    },
  }
}

/**
 * Mount the Client-local subtree on the supplied Client `Context` and report
 * the live status. The caller owns the Context and must dispose this handle
 * before the root; a construction failure unwinds exactly what this call
 * mounted and never disposes the root twice.
 */
export async function startLocalClient(
  context: Context,
  startup: LocalClientStartupFacts,
  processStartIdentity?: string,
  composition: LocalClientComposition = {},
): Promise<LocalClientHandle> {
  if ((composition.transport === undefined) !== (composition.host === undefined)) {
    throw new Error('local client entry: the official transport and the authenticated Host must be supplied together')
  }
  if (composition.mode === 'surface') {
    return await startSurfaceLocalClient(context, startup, processStartIdentity, composition)
  }
  if (composition.mode !== undefined && composition.mode !== 'qualification') {
    throw new Error(`local client entry: unknown Client mode ${JSON.stringify(composition.mode)}`)
  }
  let ui: RemoteClientUiRuntime
  try {
    ui = await createRemoteClientUiRuntime({ context, startup })
  } catch (error) {
    // The UI runtime already unwound the fibers it mounted. The Client root and
    // the official transport belong to the caller.
    throw error
  }
  const extensionService = context.get(PI_TUI_EXTENSIONS_SERVICE)
  if (extensionService === undefined) {
    await ui.dispose()
    throw new Error('local client entry: the Client-local extension host did not publish piTuiExtensions')
  }
  const { transport, host } = composition
  let disposed = false
  const startupFacts = startupFactsOf(startup)
  return {
    get status(): LocalClientStatus {
      const base = {
        processRole: 'client' as const,
        pid: process.pid,
        ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
        phase: 'client-local-ready' as const,
        sessionOpen: false as const,
        surfaceMounted: false as const,
        fiberOwner: 'client-root' as const,
        ...(context.fiber.uid == null ? {} : { rootFiberUid: context.fiber.uid }),
        extensionService: { present: true as const },
        startupFacts,
        ...(host === undefined ? {} : { host: hostFacts(host) }),
      }
      if (transport === undefined) {
        return { ...base, transport: 'not-connected' as const }
      }
      const observed = transport.status()
      return {
        ...base,
        transport: observed.transport,
        ...(observed.generationId === undefined ? {} : { generationId: observed.generationId }),
        ...(observed.hostHome === undefined ? {} : { hostHome: observed.hostHome }),
        activeWrappers: observed.activeWrappers,
        liveSockets: observed.liveSockets,
      }
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      const errors: unknown[] = []
      try {
        await ui.dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        await transport?.dispose()
      } catch (error) {
        errors.push(error)
      }
      try {
        await context.fiber.dispose()
      } catch (error) {
        errors.push(error)
      }
      throwDisposalErrors(errors, 'local client')
    },
  }
}
