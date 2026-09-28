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
import { mergeCause, type InProcessHostCarrier } from './host-runtime.ts'

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

/**
 * The exact allowlist: dynamic import specifier paired with its expected
 * `__ModuleLoader__` registration id (§9.1). Kept distinct by design.
 */
export const OFFICIAL_CLIENT_BUNDLES = [
  { specifier: '@deepseek-ai/dsh-typert-registry/client', id: '@deepseek-ai/dsh-typert-registry' },
  { specifier: '@deepseek-ai/dsh-client-connection/client', id: '@deepseek-ai/dsh-client-connection' },
  { specifier: '@deepseek-ai/dsh-api-gateway/client', id: '@deepseek-ai/dsh-api-gateway' },
  { specifier: '@deepseek-ai/dsh-client-file-upload/client', id: '@deepseek-ai/dsh-client-file-upload' },
  { specifier: '@deepseek-ai/dsh-api-session-controller/client', id: '@deepseek-ai/dsh-api-session-controller' },
  { specifier: '@deepseek-ai/dsh-api-job-controller/client', id: '@deepseek-ai/dsh-api-job-controller' },
] as const

type ClientBundleId = (typeof OFFICIAL_CLIENT_BUNDLES)[number]['id']

type ModuleFactory = (requireModule: (specifier: string) => unknown) => unknown
type ModuleLoader = (registration: { id: string; factory: ModuleFactory }) => void

/** Expected registration ids, in dependency order. */
const EXPECTED_REGISTRATION_IDS: readonly ClientBundleId[] = OFFICIAL_CLIENT_BUNDLES.map(bundle => bundle.id)

/** Process-wide single-flight capture; module code evaluates once per process. */
let officialClientModulesPromise: Promise<OfficialClientModules> | undefined

/**
 * Load the six official Client bundles once per process and freeze their
 * captured module exports. Concurrent callers share the same promise.
 *
 * Failure semantics: a rejected capture stays cached (fail fast, no silent
 * retry). ESM evaluates each bundle at most once per process, so bundles
 * already imported during a failed capture can never re-register — a retry
 * would deterministically fail the completeness check anyway.
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

/**
 * Install the temporary `window.__ModuleLoader__` shim around exactly the six
 * bundle imports, preserving the exact previous process state: when
 * `globalThis.window` is absent, only the minimal temporary object is created
 * and deleted again; when a `window` own property already exists (including a
 * property whose value is `undefined`/`null`, and accessor descriptors), its
 * exact property descriptor is restored, and any pre-existing
 * `__ModuleLoader__` property descriptor on an existing window object is
 * preserved and restored verbatim.
 * @returns the restore function; it must run before any Client plugin executes
 * (and on every failure path).
 */
export function installScopedModuleLoaderShim(load: ModuleLoader): () => void {
  const globalScope = globalThis as Record<string, unknown>
  const previousWindowDescriptor = Object.getOwnPropertyDescriptor(globalScope, 'window')
  const previousWindowValue = previousWindowDescriptor?.value
  const usableExistingWindow = (typeof previousWindowValue === 'object' && previousWindowValue !== null)
    || typeof previousWindowValue === 'function'
  let previousLoaderDescriptor: PropertyDescriptor | undefined

  const install = (): void => {
    if (usableExistingWindow) {
      const existingWindow = previousWindowValue as Record<string, unknown>
      previousLoaderDescriptor = Object.getOwnPropertyDescriptor(existingWindow, '__ModuleLoader__')
      existingWindow.__ModuleLoader__ = { load }
    } else {
      Object.defineProperty(globalScope, 'window', {
        configurable: true,
        writable: true,
        value: { __ModuleLoader__: { load } },
      })
    }
  }
  const restore = (): void => {
    if (previousWindowDescriptor === undefined) {
      delete globalScope.window
      return
    }
    Object.defineProperty(globalScope, 'window', previousWindowDescriptor)
    if (usableExistingWindow) {
      const existingWindow = previousWindowValue as Record<string, unknown>
      if (previousLoaderDescriptor === undefined) {
        delete existingWindow.__ModuleLoader__
      } else {
        Object.defineProperty(existingWindow, '__ModuleLoader__', previousLoaderDescriptor)
      }
    }
  }

  install()
  return restore
}

async function captureOfficialClientModules(): Promise<OfficialClientModules> {
  const loader = createScopedClientModuleLoader(EXPECTED_REGISTRATION_IDS)

  const restoreShim = installScopedModuleLoaderShim(loader.load)
  try {
    for (const bundle of OFFICIAL_CLIENT_BUNDLES) {
      await import(bundle.specifier)
    }
    loader.assertComplete()
  } finally {
    restoreShim()
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
 * Reverse-dispose the recorded `/remote` contribution disposers. Per-step
 * error isolation: one rejecting disposer cannot truncate the remaining
 * cleanup. Returns the collected cleanup errors in encounter order.
 *
 * Exported so the L5 suite can exercise the exact collection semantics the
 * production composition relies on (module-internal seam, like
 * `createScopedClientModuleLoader`).
 */
export async function disposeRemoteContributions(
  disposers: ReadonlyArray<() => Promise<void> | void>,
): Promise<unknown[]> {
  const errors: unknown[] = []
  for (let index = disposers.length - 1; index >= 0; index -= 1) {
    try {
      await disposers[index]()
    } catch (error) {
      errors.push(error)
    }
  }
  return errors
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
  let typertFiber: Fiber | undefined
  let connectionFiber: Fiber | undefined
  let gatewayFiber: Fiber | undefined
  let fileUploadFiber: Fiber | undefined
  let sessionFiber: Fiber | undefined
  let jobsFiber: Fiber | undefined
  let services: { connection: ConnectionHandle; sessions: ISessions; jobs: IJobs } | undefined
  const contributionDisposers: Array<() => Promise<void> | void> = []
  let disposed = false

  /**
   * The frozen §16 shutdown sequence: domain Clients (reverse), the explicit
   * `/remote` contributions (reverse), Gateway/Connection/Typert (reverse),
   * then the Client root. Unwinding a partial composition runs the SAME
   * order over whatever subset exists: a fiber whose startup rejected is
   * already assigned, so it unwinds at its own position; only stages that
   * were never reached are skipped.
   *
   * Contribution-disposer failures are isolated (collected, never allowed to
   * truncate the remaining cleanup). Cordis contains unload-disposer failures
   * inside `fiber.dispose()` (they are logged there, never propagated), so
   * the fiber steps cannot reject.
   *
   * @returns the collected contribution-disposer cleanup errors.
   */
  const shutdown = async (): Promise<unknown[]> => {
    for (const fiber of [jobsFiber, sessionFiber, fileUploadFiber]) {
      await fiber?.dispose()
    }
    const contributionErrors = await disposeRemoteContributions(contributionDisposers)
    contributionDisposers.length = 0
    for (const fiber of [gatewayFiber, connectionFiber, typertFiber]) {
      await fiber?.dispose()
    }
    await context.fiber.dispose()
    return contributionErrors
  }

  const unwind = async (): Promise<unknown[]> => {
    disposed = true
    return shutdown()
  }

  try {
    // Each fiber is assigned to its named stage variable BEFORE awaiting
    // startup: a plugin whose startup rejects is still owned by `shutdown()`
    // and unwinds at its frozen §16 position. Assigning after the await (the
    // previous shape) left the failed fiber to the Client root sweep, which
    // disposed it late and out of order.

    // 1. Typert registry.
    typertFiber = context.plugin(modules.typert)
    await typertFiber
    // 2. Connection as a Cordis-owned fiber: explicit composition transport,
    //    never the bundle's page-global default adapter, no location.
    connectionFiber = context.plugin(connectionContext => {
      modules.connection.installConnection(connectionContext, {
        transport: {
          ownsHost: true,
          fetch: carrier.fetch,
          openStream: carrier.openStream,
        },
      })
    })
    await connectionFiber
    // 3. API Gateway.
    gatewayFiber = context.plugin(modules.gateway)
    await gatewayFiber
    // 4. Explicit generated /remote contributions, in mount order.
    for (const contribution of REMOTE_CONTRIBUTIONS) {
      contributionDisposers.push(await context.remote.$mount(contribution))
    }
    // 5./6./7. Domain Clients - fileUpload before Sessions is contractual
    // (the Session Client injects `fileUpload`).
    fileUploadFiber = context.plugin(modules.fileUpload)
    await fileUploadFiber
    sessionFiber = context.plugin(modules.session)
    await sessionFiber
    jobsFiber = context.plugin(modules.jobs)
    await jobsFiber

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
    // The original construction/readiness error stays the primary failure;
    // any cleanup failures ride its cause chain instead of masking it.
    const cleanupErrors = await unwind()
    const failure = error instanceof Error ? error : new Error(String(error))
    if (cleanupErrors.length > 0) {
      const secondary = cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, 'remote client runtime: unwind disposal failures')
      mergeCause(failure, secondary)
    }
    throw failure
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
      // Exactly the frozen §16 sequence (shared with the failure unwind);
      // the first cleanup failure surfaces to the caller, with any remaining
      // failures attached as its cause.
      const cleanupErrors = await shutdown()
      if (cleanupErrors.length > 0) {
        const failure = cleanupErrors[0] instanceof Error
          ? cleanupErrors[0]
          : new Error(String(cleanupErrors[0]))
        if (cleanupErrors.length > 1) {
          mergeCause(failure, new AggregateError(cleanupErrors.slice(1), 'remote client runtime: remaining disposal failures'))
        }
        throw failure
      }
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
  // The already-aborted case outranks the already-ready fast path: a cancelled
  // lifecycle may not be reported as a successful composition merely because
  // readiness landed during the Host/Client mount sequence.
  if (signal?.aborted) {
    throw new Error('remote client runtime: aborted before initial readiness', { cause: signal.reason })
  }
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
