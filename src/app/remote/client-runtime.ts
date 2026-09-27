/**
 * Experimental official Client runtime composition (M3-1).
 *
 * Owns the official Client bundle capture, the Client `Context`, the exact
 * plugin mount order, the explicit `/remote` contributions, initial
 * readiness, and reverse disposal (`docs/m3-entry-contract.md` §2.4.2/§2.4.3).
 * It does not assemble the TUI semantic `Backend`.
 *
 * rc.2 publishes the six required Client plugin entries as Web
 * module-loader bundles: each bundle registers through
 * `window.__ModuleLoader__.load(...)`, which plain Node dynamic imports
 * cannot consume directly. The scoped loader below is therefore a packaging
 * adapter only: it is installed around exactly the six dynamic imports,
 * rejects unknown/duplicate/missing registrations, and restores the previous
 * process state before any Client plugin runs.
 *
 * Because ESM evaluates each bundle at most once per process, the capture is
 * a process-wide single-flight: the captured package module exports are
 * reused for every Client `Context`, while each Context still gets its own
 * independent Connection, Gateway, Remote namespaces, Sessions, Jobs,
 * subscriptions, and lifetimes. Captured bundle factories are never re-run.
 *
 * @module app/remote/client-runtime
 */

import { createRequire } from 'node:module'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type * as typertRegistryClient from '@deepseek-ai/dsh-typert-registry/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { IJobs } from '@deepseek-ai/dsh-api-job-controller/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import commandsRemote from '@deepseek-ai/dsh-commands/remote'
import subagentsRemote from '@deepseek-ai/dsh-subagent/remote'
import agentPresetsRemote from '@deepseek-ai/dsh-agent-preset-registry/remote'
import pluginManagerRemote from '@deepseek-ai/dsh-plugin-manager/remote'
import permissionPresetsRemote from '@deepseek-ai/dsh-permission-presets/remote'
import llmRemote from '@deepseek-ai/dsh-llm/remote'
import sessionRemote from '@deepseek-ai/dsh-api-session-controller/remote'
import jobRemote from '@deepseek-ai/dsh-api-job-controller/remote'
import settingsRemote from '@deepseek-ai/dsh-api-settings-controller/remote'
import fileUploadsRemote from '@deepseek-ai/dsh-client-file-upload/remote'
import type { InProcessHostCarrier } from './host-runtime.ts'

type TypertClientModule = typeof typertRegistryClient
type ConnectionClientModule = typeof import('@deepseek-ai/dsh-client-connection/client')
type GatewayClientModule = typeof import('@deepseek-ai/dsh-api-gateway/client')
type FileUploadClientModule = typeof import('@deepseek-ai/dsh-client-file-upload/client')
type SessionClientModule = typeof import('@deepseek-ai/dsh-api-session-controller/client')
type JobClientModule = typeof import('@deepseek-ai/dsh-api-job-controller/client')

/** Captured official Client module exports, frozen after the single capture. */
export interface OfficialClientModules {
  readonly typert: TypertClientModule
  readonly connection: ConnectionClientModule
  readonly gateway: GatewayClientModule
  readonly fileUpload: FileUploadClientModule
  readonly session: SessionClientModule
  readonly jobs: JobClientModule
}

/** Import specifier paired with its expected `__ModuleLoader__` registration id. */
const CLIENT_BUNDLES = [
  { specifier: '@deepseek-ai/dsh-typert-registry/client', id: '@deepseek-ai/dsh-typert-registry' },
  { specifier: '@deepseek-ai/dsh-client-connection/client', id: '@deepseek-ai/dsh-client-connection' },
  { specifier: '@deepseek-ai/dsh-api-gateway/client', id: '@deepseek-ai/dsh-api-gateway' },
  { specifier: '@deepseek-ai/dsh-client-file-upload/client', id: '@deepseek-ai/dsh-client-file-upload' },
  { specifier: '@deepseek-ai/dsh-api-session-controller/client', id: '@deepseek-ai/dsh-api-session-controller' },
  { specifier: '@deepseek-ai/dsh-api-job-controller/client', id: '@deepseek-ai/dsh-api-job-controller' },
] as const

type ClientBundleId = (typeof CLIENT_BUNDLES)[number]['id']

type ModuleFactory = (requireModule: (specifier: string) => unknown) => unknown
type ModuleLoader = (registration: { id: string; factory: ModuleFactory }) => void

/** Expected registration ids, in dependency order. */
const EXPECTED_REGISTRATION_IDS: readonly ClientBundleId[] = CLIENT_BUNDLES.map(bundle => bundle.id)

/** Process-wide single-flight capture; module code evaluates once per process. */
let officialClientModulesPromise: Promise<OfficialClientModules> | undefined

/**
 * Load the six official Client bundles once per process and freeze their
 * captured module exports. Concurrent callers share the same promise.
 */
export function loadOfficialClientModulesOnce(): Promise<OfficialClientModules> {
  officialClientModulesPromise ??= captureOfficialClientModules()
  return officialClientModulesPromise
}

/**
 * Exact scoped loader capture: install a temporary `window.__ModuleLoader__`,
 * dynamic-import the six bundles in dependency order, validate and evaluate
 * every registration, freeze the module-export table, and restore the
 * previous process state in `finally` — before any Client Context exists.
 */
/**
 * The exact scoped loader admission rules (module-internal seam, exercised by
 * the L5 loader-exactness test): reject an unknown registration id, a
 * duplicate id, a non-function factory, and a `/client` dependency requested
 * before its dependency-order capture; report missing expected ids.
 */
export function createScopedClientModuleLoader(expectedIds: readonly string[]): {
  load: ModuleLoader
  requireModule: (specifier: string) => unknown
  registeredIds(): readonly string[]
  assertComplete(): void
} {
  const nodeRequire = createRequire(import.meta.url)
  const registrations = new Map<string, ModuleFactory>()
  const captured = new Map<string, unknown>()

  const requireModule = (specifier: string): unknown => {
    if (specifier.endsWith('/client')) {
      const id = specifier.slice(0, -'/client'.length)
      const module = captured.get(id)
      if (module === undefined) {
        throw new Error(`official Client module ${specifier} was requested before ${id} was captured`)
      }
      return module
    }
    return nodeRequire(specifier)
  }

  const load: ModuleLoader = ({ id, factory }) => {
    if (!expectedIds.includes(id)) {
      throw new Error(`official Client bundle loader received an unexpected registration id: ${String(id)}`)
    }
    if (registrations.has(id)) {
      throw new Error(`official Client bundle ${id} registered twice`)
    }
    if (typeof factory !== 'function') {
      throw new Error(`official Client bundle ${id} registered a non-function factory`)
    }
    registrations.set(id, factory)
    captured.set(id, factory(requireModule))
  }

  return {
    load,
    requireModule,
    registeredIds: () => [...registrations.keys()],
    assertComplete(): void {
      for (const id of expectedIds) {
        if (!registrations.has(id)) {
          throw new Error(`official Client bundle ${id} never registered through __ModuleLoader__`)
        }
      }
    },
  }
}

async function captureOfficialClientModules(): Promise<OfficialClientModules> {
  const loader = createScopedClientModuleLoader(EXPECTED_REGISTRATION_IDS)
  const { load } = loader

  const globalScope = globalThis as { window?: unknown }
  const previousWindow = globalScope.window
  let previousLoaderDescriptor: PropertyDescriptor | undefined
  const windowExisted = previousWindow !== undefined
  try {
    if (windowExisted) {
      const existingWindow = previousWindow as Record<string, unknown>
      previousLoaderDescriptor = Object.getOwnPropertyDescriptor(existingWindow, '__ModuleLoader__')
      existingWindow.__ModuleLoader__ = { load }
    } else {
      globalScope.window = { __ModuleLoader__: { load } }
    }

    for (const bundle of CLIENT_BUNDLES) {
      await import(bundle.specifier)
    }

    loader.assertComplete()
  } finally {
    if (windowExisted) {
      const existingWindow = previousWindow as Record<string, unknown>
      if (previousLoaderDescriptor === undefined) {
        delete existingWindow.__ModuleLoader__
      } else {
        Object.defineProperty(existingWindow, '__ModuleLoader__', previousLoaderDescriptor)
      }
    } else {
      delete globalScope.window
    }
  }

  const captured = new Map<string, unknown>()
  for (const id of loader.registeredIds()) {
    captured.set(id, loader.requireModule(`${id}/client`))
  }
  return freezeOfficialClientModules(captured)
}

function freezeOfficialClientModules(captured: Map<string, unknown>): OfficialClientModules {
  const modules = {
    typert: captured.get('@deepseek-ai/dsh-typert-registry'),
    connection: captured.get('@deepseek-ai/dsh-client-connection'),
    gateway: captured.get('@deepseek-ai/dsh-api-gateway'),
    fileUpload: captured.get('@deepseek-ai/dsh-client-file-upload'),
    session: captured.get('@deepseek-ai/dsh-api-session-controller'),
    jobs: captured.get('@deepseek-ai/dsh-api-job-controller'),
  } as OfficialClientModules
  for (const [id, module] of Object.entries(modules)) {
    if (module === undefined) {
      throw new Error(`official Client bundle capture produced no module exports for ${id}`)
    }
  }
  return Object.freeze(modules)
}

/** Explicit generated `/remote` contributions (§2.4.2), never the aggregate. */
const REMOTE_CONTRIBUTIONS = [
  sessionRemote,
  jobRemote,
  commandsRemote,
  subagentsRemote,
  agentPresetsRemote,
  pluginManagerRemote,
  settingsRemote,
  permissionPresetsRemote,
  llmRemote,
  fileUploadsRemote,
] as const

/** The composed official Client runtime. Not exported from the package root. */
export interface RemoteClientRuntime {
  readonly context: Context
  readonly connection: ConnectionHandle
  readonly sessions: ISessions
  readonly jobs: IJobs
  readonly remote: ClientRemote
  dispose(): Promise<void>
}

export interface RemoteClientRuntimeOptions {
  /** Explicit in-process transport from the composed Host runtime. */
  readonly carrier: InProcessHostCarrier
  /** Lifecycle signal; aborting rejects the initial-readiness wait. */
  readonly signal?: AbortSignal
}

/**
 * Compose one fresh official Client `Context` over the Host carrier:
 * typert -> Connection (explicit transport) -> Gateway -> the ten explicit
 * `/remote` contributions -> fileUpload -> Sessions -> Jobs, then wait for
 * initial readiness. On construction failure the partial composition unwinds
 * immediately; the loader shim is never active during plugin execution.
 */
export async function createRemoteClientRuntime(options: RemoteClientRuntimeOptions): Promise<RemoteClientRuntime> {
  const modules = await loadOfficialClientModulesOnce()
  const { carrier } = options

  const context = new Context()
  const mountedFibers: Fiber[] = []
  let typertFiber: Fiber | undefined
  let connectionFiber: Fiber | undefined
  let gatewayFiber: Fiber | undefined
  let fileUploadFiber: Fiber | undefined
  let sessionFiber: Fiber | undefined
  let jobsFiber: Fiber | undefined
  let services: { connection: ConnectionHandle; sessions: ISessions; jobs: IJobs } | undefined
  const contributionDisposers: Array<() => Promise<void> | void> = []
  let disposed = false

  const unwind = async (): Promise<void> => {
    disposed = true
    for (let index = contributionDisposers.length - 1; index >= 0; index -= 1) {
      await contributionDisposers[index]()
    }
    contributionDisposers.length = 0
    for (let index = mountedFibers.length - 1; index >= 0; index -= 1) {
      await mountedFibers[index].dispose()
    }
    mountedFibers.length = 0
    await context.fiber.dispose()
  }

  const mount = async (fiber: Fiber & PromiseLike<Fiber>): Promise<Fiber> => {
    mountedFibers.push(fiber)
    return fiber
  }

  try {
    // 1. Typert registry.
    typertFiber = await mount(context.plugin(modules.typert))
    // 2. Connection as a Cordis-owned fiber: explicit composition transport,
    //    never the bundle's page-global default adapter, no location.
    connectionFiber = await mount(context.plugin(connectionContext => {
      modules.connection.installConnection(connectionContext, {
        transport: {
          ownsHost: true,
          fetch: carrier.fetch,
          openStream: carrier.openStream,
        },
      })
    }))
    // 3. API Gateway.
    gatewayFiber = await mount(context.plugin(modules.gateway))
    // 4. Explicit generated /remote contributions, in mount order.
    for (const contribution of REMOTE_CONTRIBUTIONS) {
      contributionDisposers.push(await context.remote.$mount(contribution))
    }
    // 5./6./7. Domain Clients — fileUpload before Sessions is contractual
    // (the Session Client injects `fileUpload`).
    fileUploadFiber = await mount(context.plugin(modules.fileUpload))
    sessionFiber = await mount(context.plugin(modules.session))
    jobsFiber = await mount(context.plugin(modules.jobs))

    // The Client and Host packages augment the same Cordis `Context` service
    // names, so the augmented property types resolve to the Direct Host faces
    // inside this compilation. The services installed by the captured Client
    // bundles are read through their own public Client faces instead.
    services = {
      connection: context.get('connection') as unknown as ConnectionHandle,
      sessions: context.get('sessions') as unknown as ISessions,
      jobs: context.get('jobs') as unknown as IJobs,
    }
    // Initial readiness is part of construction: a failure (an aborted
    // lifecycle signal included) must unwind the whole partial composition.
    await waitForInitialReadiness(services.connection, services.sessions, options.signal)
  } catch (error) {
    await unwind()
    throw error
  }
  // The catch above always rethrows, so reaching here means construction
  // (including initial readiness) completed.
  const { connection, sessions, jobs } = services!

  const runtime: RemoteClientRuntime = {
    context,
    connection,
    sessions,
    jobs,
    remote: context.remote,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      // Domain Clients first, then contributions, then the wire, then the root.
      for (const fiber of [jobsFiber, sessionFiber, fileUploadFiber]) {
        await fiber?.dispose()
      }
      for (let index = contributionDisposers.length - 1; index >= 0; index -= 1) {
        await contributionDisposers[index]()
      }
      contributionDisposers.length = 0
      for (const fiber of [gatewayFiber, connectionFiber, typertFiber]) {
        await fiber?.dispose()
      }
      mountedFibers.length = 0
      await context.fiber.dispose()
    },
  }
  return runtime
}

/**
 * Initial readiness (`docs/m3-entry-contract.md` §4.1): a defined Connection
 * generation AND a `ready` Session list. Subscription-driven with no
 * production timeout; the lifecycle signal aborts the wait and every listener
 * is removed on settle or abort.
 */
async function waitForInitialReadiness(
  connection: ConnectionHandle,
  sessions: ISessions,
  signal?: AbortSignal,
): Promise<void> {
  const isReady = (): boolean =>
    connection.generation.getSnapshot() !== undefined
    && sessions.list.getSnapshot().phase === 'ready'
  if (isReady()) return

  await new Promise<void>((resolve, reject) => {
    let settled = false
    let abortListener: (() => void) | undefined
    const settle = (): void => {
      if (settled) return
      if (isReady()) {
        settled = true
        cleanup()
        resolve()
      }
    }
    const generationUnsubscribe = connection.generation.subscribe(settle)
    const listUnsubscribe = sessions.list.subscribe(settle)
    const cleanup = (): void => {
      generationUnsubscribe()
      listUnsubscribe()
      if (abortListener !== undefined) signal?.removeEventListener('abort', abortListener)
    }
    if (signal !== undefined) {
      abortListener = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error('remote client runtime: aborted before initial readiness', { cause: signal.reason }))
      }
      if (signal.aborted) {
        abortListener()
        return
      }
      signal.addEventListener('abort', abortListener, { once: true })
    }
    settle()
  })
}
