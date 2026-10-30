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
  /**
   * The current surface revision identity (qualification observation only).
   * A replacement creates a NEW number; it never grants Host authority.
   */
  readonly surfaceRevision?: number
  /** The mounted runner fiber's UID for the current revision. */
  readonly surfaceFiberUid?: number
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
  /** The runner fiber's Cordis UID (qualification observation only). */
  readonly fiberUid?: number
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
   * Qualification-only same-process surface replacement: retire the current
   * revision (runner -> UI -> memoized application/Domains) and mount a fresh
   * one on the SAME Client Context/transport. Never touches the Host. The
   * caller (local-client-entry's qualification signal path) owns the process
   * exit on failure; this method is not a public root export.
   */
  replaceSurfaceForQualification(): Promise<void>
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
  envName = 'SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY',
): Promise<void> {
  const spec = process.env[envName]
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
 * The ONE serial surface-revision task slot. Revision mounts and the final
 * Client disposal chain through it, so an HMR replacement can never overlap
 * another replacement, a stop, or the root release. A failed task settles the
 * slot and the next task still runs (the caller owns the failure decision).
 */
export class SurfaceRevisionTasks {
  private tail: Promise<void> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.then(() => {}, () => {})
    return run
  }

  /** Resolve after every task queued SO FAR has settled. */
  settle(): Promise<void> {
    return this.tail
  }
}

/** One mounted surface revision: the complete graph one runner owns. */
interface SurfaceRevision {
  readonly id: number
  domains?: MountedRemoteClientDomains
  ui?: RemoteClientUiRuntime
  application?: SplitRemoteApplicationRuntime
  runner?: MountedLocalClientRunner
  surfaceMounted: boolean
  statusCleanup?: () => void
}

/** The official `tuiMainView` reference one mounted Domain graph holds. */
function openSessionIdFor(domains: MountedRemoteClientDomains): string | undefined {
  const snapshot = domains.sessions.list.getSnapshot()
  for (const id of snapshot.ids) {
    const info = domains.sessions.retainInfo(id).getSnapshot()
    if ((info.retainedBy.tuiMainView ?? 0) > 0) return String(id)
  }
  return undefined
}

/**
 * The ONE split-Client surface composition: Domain graph -> Client UI
 * subtree -> Remote application runtime -> real runner. Every stage is
 * recorded the instant it exists, so a failure at any later stage unwinds the
 * whole partial composition in reverse and the original error stays primary.
 *
 * The composition is a sequence of SURFACE REVISIONS over the SAME Client
 * Context and B1 transport. A normal Client process mounts exactly one
 * revision; the qualification-only replacement path retires the current
 * revision (runner -> Client UI -> the memoized application/Domain release)
 * and mounts a fresh one on the same Context. The host is never involved:
 * its `runProfile`, Agent, Job and service fibers stay owned by the Host
 * process.
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

  let currentRevision: SurfaceRevision | undefined
  let revisionSequence = 0
  let disposed = false
  const revisionTasks = new SurfaceRevisionTasks()
  const enqueueRevision = <T>(task: () => Promise<T>): Promise<T> => revisionTasks.run(task)
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
    const revision = currentRevision
    const domains = revision?.domains
    const domainsOpen = revision !== undefined && domains !== undefined
    const current = domainsOpen ? openSessionIdFor(domains) : undefined
    const privateRemote = domains?.remote as unknown as {
      readonly piTuiFileReferences?: unknown
      readonly piTuiTerminalProgress?: unknown
    } | undefined
    return {
      ...base,
      transport: observed.transport,
      sessionOpen: current !== undefined,
      ...(current === undefined ? {} : { openSessionId: current }),
      surfaceMounted: revision?.surfaceMounted === true,
      ...(revision === undefined ? {} : { surfaceRevision: revision.id }),
      ...(revision?.runner?.fiberUid === undefined ? {} : { surfaceFiberUid: revision.runner.fiberUid }),
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

  let lastStatusKey = ''
  const emitStatus = (): void => {
    if (composition.onStatus === undefined) return
    const current = status()
    const key = JSON.stringify([
      current.transport,
      current.generationId,
      current.sessionOpen,
      current.openSessionId,
      current.surfaceMounted,
      current.surfaceRevision,
      current.surfaceFiberUid,
    ])
    if (key === lastStatusKey) return
    lastStatusKey = key
    composition.onStatus(current)
  }

  /** Attach the revision-local official status subscriptions. */
  const subscribeRevisionStatus = (revision: SurfaceRevision): void => {
    const domains = revision.domains
    if (domains === undefined) return
    const watched = new Map<string, () => void>()
    const watchListedSessions = (): void => {
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
    // a new record. The retained `tuiMainView` reference is re-adopted by the
    // official service; this record proves the Client observed the rollover.
    const unsubscribeGeneration = transport.connection.generation.subscribe(emitStatus)
    revision.statusCleanup = (): void => {
      unsubscribeList()
      unsubscribeGeneration()
      for (const unsubscribe of watched.values()) unsubscribe()
      watched.clear()
    }
    watchListedSessions()
  }

  /** Mount one fresh revision on the SAME Client Context/transport. */
  const mountRevision = async (kind: 'initial' | 'hmr', sessionIdOverride?: string): Promise<SurfaceRevision> => {
    signal?.throwIfAborted()
    const revision: SurfaceRevision = { id: ++revisionSequence, surfaceMounted: false }
    currentRevision = revision
    revision.domains = await mountRemoteClientDomains({
      context,
      dshAnchor,
      ...(signal === undefined ? {} : { signal }),
    })
    await waitForAssemblyHold('domain', signal, composition.onQualification)
    signal?.throwIfAborted()
    const revisionStartup = {
      ...startupFactsOf(startup),
      ...(sessionIdOverride === undefined ? {} : { sessionId: sessionIdOverride }),
    }
    revision.ui = await createRemoteClientUiRuntime({ context, startup: revisionStartup })
    signal?.throwIfAborted()
    // T34 qualification input: hold ONE write between its real serialization
    // and the writer's dispatch-admission check. Production never sets this
    // variable; the production serializer stays the default.
    const holdPath = process.env.SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE
    let promptSerializer: RemotePromptSerializer | undefined
    if (holdPath !== undefined && holdPath !== '') {
      const production = RemotePromptSerializerProduction.overSessions(revision.domains.sessions)
      promptSerializer = {
        preflight: message => production.preflight(message),
        async serialize(message) {
          const serialized = await production.serialize(message)
          await waitForQualificationBarrier(holdPath)
          return serialized
        },
      }
    }
    revision.application = await createRemoteApplicationRuntimeFromClient({
      domains: revision.domains,
      fetch: authenticatedFetch,
      clientUi: revision.ui,
      ...(signal === undefined ? {} : { signal }),
      ...(promptSerializer === undefined ? {} : { promptSerializer }),
    })
    signal?.throwIfAborted()
    // T59 qualification input: force the NEW revision's UI mount to fail after
    // the old revision was already retired. Production never sets this.
    if (kind === 'hmr' && process.env.SPLIT_PROCESS_CLIENT_HMR_FAIL === '1') {
      throw new Error('local client entry: qualification forced HMR surface mount failure')
    }
    const override: RemoteApplicationOverride = {
      selected: revision.application.selected,
      presentation: revision.application.presentation,
      extensionService: revision.application.extensionService,
    }
    // Schema defaults + the explicit Client-local startup facts. No fabricated
    // profile document: a preference's absence resolves to its schema default.
    const activeSessionId = sessionIdOverride ?? startup.sessionId
    const config = TuiConfigSchema({
      ...(activeSessionId === undefined ? {} : { sessionId: activeSessionId }),
    } as never)
    signal?.throwIfAborted()
    revision.runner = await mountRunner({ context, config, override })
    // T59 mid-HMR hold: a replacement-only barrier between the new runner
    // fiber mount and its physical surface readiness. Production never sets it.
    await waitForAssemblyHold(
      'surface',
      signal,
      composition.onQualification,
      kind === 'hmr' ? 'SPLIT_PROCESS_CLIENT_HMR_HOLD' : 'SPLIT_PROCESS_CLIENT_HOLD_ASSEMBLY',
    )
    signal?.throwIfAborted()
    // Wait for the physical surface, not merely the mounted runner fiber. An
    // exit request raised during startup is CANCELLATION, never a silent hang.
    const abortReady = abortable(signal)
    try {
      await Promise.race([
        revision.runner.ready,
        revision.runner.stopped.then(code => {
          throw new Error(`local client entry: the surface startup was cancelled by exit request ${String(code)}`)
        }),
        abortReady.promise,
      ])
    } finally {
      abortReady.cancel()
    }
    revision.surfaceMounted = true
    subscribeRevisionStatus(revision)
    emitStatus()
    return revision
  }

  /** Reverse-dispose exactly one revision: runner -> UI -> application/Domains. */
  const disposeRevision = async (revision: SurfaceRevision): Promise<void> => {
    revision.surfaceMounted = false
    emitStatus()
    revision.statusCleanup?.()
    revision.statusCleanup = undefined
    const errors: unknown[] = []
    if (revision.runner !== undefined) {
      try { await revision.runner.dispose() } catch (error) { errors.push(error) }
    }
    if (revision.ui !== undefined) {
      try { await revision.ui.dispose() } catch (error) { errors.push(error) }
    }
    // The runner may already have released the selected adapters; this is the
    // SAME memoized release. When the runner never mounted, this is the first
    // release.
    if (revision.application !== undefined) {
      try { await revision.application.selected.disposeTransport() } catch (error) { errors.push(error) }
    } else if (revision.domains !== undefined) {
      try { await revision.domains.dispose() } catch (error) { errors.push(error) }
    }
    revision.runner = undefined
    revision.ui = undefined
    revision.application = undefined
    revision.domains = undefined
    throwDisposalErrors(errors, 'local client surface revision')
  }

  // T36 qualification input: probe the private Host RPCs through the ALREADY
  // mounted Domain namespaces (no second private contribution). Registered
  // ONCE on the process: a revision replacement must not duplicate listeners.
  if (process.env.SPLIT_PROCESS_CLIENT_PRIVATE_RPC_PROOF === '1') {
    if (composition.diag === undefined) {
      throw new Error('local client entry: the private RPC qualification requires the Client diagnostics sink')
    }
    const diag = composition.diag
    process.on('SIGUSR2', () => {
      const revision = currentRevision
      const domains = revision?.domains
      if (domains === undefined) {
        composition.onQualification?.({ op: 'private-rpc-proof', error: 'no retained Session' })
        return
      }
      const target = openSessionIdFor(domains) ?? domains.sessions.list.getSnapshot().ids[0]
      if (target === undefined) {
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
  // restored draft is observable. Registered ONCE for the process.
  if (process.env.SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE !== undefined
    && process.env.SPLIT_PROCESS_CLIENT_HOLD_SERIALIZE !== '') {
    process.on('SIGUSR2', () => {
      currentRevision?.application?.selected.stopSurfaceAdmission?.()
      composition.onQualification?.({ op: 'stop-surface-admission' })
    })
  }

  try {
    await enqueueRevision(async () => { await mountRevision('initial') })
  } catch (error) {
    const partial = currentRevision
    currentRevision = undefined
    const cleanupErrors: unknown[] = []
    if (partial !== undefined) {
      try { await disposeRevision(partial) } catch (cleanupError) { cleanupErrors.push(cleanupError) }
    }
    let primary = error instanceof Error ? error : new Error(String(error))
    for (const cleanupError of cleanupErrors) primary = mergeCause(primary, cleanupError)
    throw primary
  }

  return {
    get status(): LocalClientStatus {
      return status()
    },
    async replaceSurfaceForQualification(): Promise<void> {
      await enqueueRevision(async () => {
        if (disposed) throw new Error('local client entry: the surface revision owner is already disposed')
        const previous = currentRevision
        if (previous === undefined) throw new Error('local client entry: no mounted surface revision to replace')
        const previousSessionId = previous.domains === undefined ? undefined : openSessionIdFor(previous.domains)
        composition.onQualification?.({ op: 'hmr-revision-start', revision: revisionSequence + 1 })
        previous.surfaceMounted = false
        emitStatus()
        try {
          await disposeRevision(previous)
        } catch (error) {
          composition.onQualification?.({
            op: 'hmr-revision-failure',
            phase: 'retire',
            revision: previous.id,
            error: error instanceof Error ? error.message : String(error),
          })
          throw error
        }
        composition.onQualification?.({ op: 'hmr-revision-retired', revision: previous.id })
        try {
          const next = await mountRevision('hmr', previousSessionId)
          composition.onQualification?.({
            op: 'hmr-revision-ready',
            revision: next.id,
            pid: process.pid,
            ...(next.runner?.fiberUid === undefined ? {} : { fiberUid: next.runner.fiberUid }),
            ...(status().generationId === undefined ? {} : { generationId: status().generationId }),
          })
        } catch (error) {
          const partial = currentRevision
          currentRevision = undefined
          const cleanupErrors: unknown[] = []
          if (partial !== undefined) {
            try { await disposeRevision(partial) } catch (cleanupError) { cleanupErrors.push(cleanupError) }
          }
          composition.onQualification?.({
            op: 'hmr-revision-failure',
            phase: 'mount',
            revision: revisionSequence,
            error: error instanceof Error ? error.message : String(error),
          })
          let primary = error instanceof Error ? error : new Error(String(error))
          for (const cleanupError of cleanupErrors) primary = mergeCause(primary, cleanupError)
          throw primary
        }
      })
    },
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      // Stop is the ONE outer coordinator: it first aborts the in-flight
      // revision through `signal`, then waits for that revision task before
      // releasing the Context. Never release the root underneath a mount.
      await revisionTasks.settle()
      const errors: unknown[] = []
      const revision = currentRevision
      currentRevision = undefined
      if (revision !== undefined) {
        try { await disposeRevision(revision) } catch (error) { errors.push(error) }
      }
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
    async replaceSurfaceForQualification(): Promise<void> {
      throw new Error('local client entry: surface replacement requires the internal surface mode')
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
