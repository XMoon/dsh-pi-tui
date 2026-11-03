/**
 * Experimental official Client runtime composition (M3-1).
 *
 * Owns the official Client bundle capture, the Client `Context`, the exact
 * plugin mount order, the explicit `/remote` contributions, initial
 * readiness, and reverse disposal.
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

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import * as clientStore from '@deepseek-ai/dsh-client-store'
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
import userQuestionsRemote from '@deepseek-ai/dsh-user-questions/remote'
import fileUploadsRemote from '@deepseek-ai/dsh-client-file-upload/remote'
import workspaceFilesRemote from '@deepseek-ai/dsh-api-workspace-files/remote'
import { PI_TUI_CLIENT_CONTRIBUTION } from '../../runtime/remote/pi-tui-remote-contribution.ts'
import { mergeCause } from './dispose-cause.ts'
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

/**
 * The official web shell's platform static modules, which the browser-form
 * `/client` bundles resolve through the Loader's `require` (the published web
 * seed shares exactly these singletons). The Node Client shell is that shell:
 * it supplies the installed Harness-family `@deepseek-ai/dsh-client-store`
 * instance instead of relying on a transitive resolution from a bundle's own
 * package graph. `@deepseek-ai/cordis` is imported directly by this module and
 * therefore already resolves normally.
 */
const CLIENT_PLATFORM_MODULES: Readonly<Record<string, unknown>> = {
  '@deepseek-ai/dsh-client-store': clientStore,
}

/** The loader's bare-dependency resolver: platform statics first, then the
 *  CALLER's installation resolver. The real Client passes the DSH anchor
 *  resolver so every non-platform dependency of a browser-form bundle also
 *  resolves from the anchored installation, never from an unrelated source
 *  tree. */
function createPlatformRequire(fallback: (specifier: string) => unknown): (specifier: string) => unknown {
  return specifier => Object.hasOwn(CLIENT_PLATFORM_MODULES, specifier)
    ? CLIENT_PLATFORM_MODULES[specifier]
    : fallback(specifier)
}

/** Process-wide single-flight capture; module code evaluates once per process. */
let officialClientModulesPromise: Promise<OfficialClientModules> | undefined

/**
 * Load the six official Client bundles once per process and freeze their
 * captured module exports. Concurrent callers share the same promise.
 *
 * DSH 0.2.1-rc.1 and later select the `./client` entry by condition: `@deepseek-ai/dsh-typert-registry`,
 * `@deepseek-ai/dsh-client-connection` and `@deepseek-ai/dsh-api-gateway` publish
 * a standalone Node ESM variant (which never touches `window.__ModuleLoader__`),
 * while the remaining three publish the browser loader factory. Both channels
 * feed one table, so the registration order below still holds for every
 * `/client` dependency.
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
 * dynamic-import the six bundles in dependency order, admit each bundle from
 * exactly the channel the published `./client` entry selected (loader
 * registration or standalone Node module — see {@link captureOfficialClientModules}),
 * freeze the module-export table, and restore the previous process state in
 * `finally` — before any Client Context exists.
 */
/**
 * The exact scoped loader admission rules (module-internal seam, exercised by
 * the L5 loader-exactness test): reject an unknown registration id, a
 * duplicate id, a non-function factory, and a `/client` dependency requested
 * before its dependency-order capture; admit a directly imported Node bundle
 * for an id the loader did not register; report missing expected ids.
 */
export function createScopedClientModuleLoader(
  expectedIds: readonly string[],
  /**
   * The bare-specifier resolver a captured bundle uses for its non-`/client`
   * dependencies. Defaults to this module's own installation; an installed
   * Client process passes the resolver anchored at its real DSH installation
   * so no source-tree copy can participate.
   */
  requireFrom: (specifier: string) => unknown = createRequire(import.meta.url),
): {
  load: ModuleLoader
  requireModule: (specifier: string) => unknown
  registeredIds(): readonly string[]
  acceptImported(id: string, module: unknown): void
  assertComplete(): void
} {
  const nodeRequire = requireFrom
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

  /**
   * Admit one directly imported bundle whose `./client` entry did not register
   * through the loader shim (the standalone Node variant). The module joins the
   * SAME table {@link requireModule} resolves `/client` dependencies from, so a
   * registering bundle can still depend on a Node-variant one. A bundle that did
   * register is left to its own registration: the browser factory result is the
   * authoritative module for that id.
   * @param id - the bundle's registration id.
   * @param module - the imported module namespace.
   * @throws when the id is unexpected or already admitted by a direct import.
   */
  const acceptImported = (id: string, module: unknown): void => {
    if (!expectedIds.includes(id)) {
      throw new Error(`official Client bundle import produced an unexpected id: ${String(id)}`)
    }
    if (registrations.has(id)) return
    if (captured.has(id)) {
      throw new Error(`official Client bundle ${id} was imported as a Node module twice`)
    }
    captured.set(id, module)
  }

  return {
    load,
    requireModule,
    registeredIds: () => [...registrations.keys()],
    acceptImported,
    assertComplete(): void {
      for (const id of expectedIds) {
        if (!captured.has(id)) {
          throw new Error(`official Client bundle ${id} was neither registered through __ModuleLoader__ nor imported as a Node module`)
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
  const loader = createScopedClientModuleLoader(
    EXPECTED_REGISTRATION_IDS,
    createPlatformRequire(createRequire(import.meta.url)),
  )

  const restoreShim = installScopedModuleLoaderShim(loader.load)
  try {
    for (const bundle of OFFICIAL_CLIENT_BUNDLES) {
      // Each published `./client` entry selects its own channel: the browser
      // variant registers through the shim above, the standalone Node variant
      // is admitted directly. `acceptImported` is a no-op for a bundle that
      // registered itself.
      loader.acceptImported(bundle.id, await import(bundle.specifier))
    }
    loader.assertComplete()
  } finally {
    restoreShim()
  }

  const captured = new Map<string, unknown>()
  for (const id of EXPECTED_REGISTRATION_IDS) {
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
  userQuestionsRemote,
  workspaceFilesRemote,
] as const

/**
 * The exact generated `/remote` contribution specifiers in the SAME frozen
 * order as {@link REMOTE_CONTRIBUTIONS}. A real installed Client process
 * resolves THESE from its DSH installation anchor instead of consuming the
 * statically imported source-tree copy; both channels produce the one table
 * `mountRemoteClientDomains` mounts.
 */
const REMOTE_CONTRIBUTION_SPECIFIERS = [
  '@deepseek-ai/dsh-api-session-controller/remote',
  '@deepseek-ai/dsh-api-job-controller/remote',
  '@deepseek-ai/dsh-commands/remote',
  '@deepseek-ai/dsh-subagent/remote',
  '@deepseek-ai/dsh-agent-preset-registry/remote',
  '@deepseek-ai/dsh-plugin-manager/remote',
  '@deepseek-ai/dsh-api-settings-controller/remote',
  '@deepseek-ai/dsh-permission-presets/remote',
  '@deepseek-ai/dsh-llm/remote',
  '@deepseek-ai/dsh-client-file-upload/remote',
  '@deepseek-ai/dsh-user-questions/remote',
  '@deepseek-ai/dsh-api-workspace-files/remote',
] as const

/** The official Client-side modules and generated `/remote` contributions one
 *  mount consumes, captured from ONE source (this process's modules for M3, or
 *  the installed DSH anchor for the real split Client). */
interface InstalledClientDomainModules {
  readonly modules: OfficialClientModules
  readonly contributions: readonly TypertRemoteContribution[]
}

/** Per-installation single-flight captures, keyed by the real anchor path. */
const installedClientDomainModules = new Map<string, Promise<InstalledClientDomainModules>>()

/** Capture the six official `/client` bundles through the installation anchor. */
async function captureInstalledOfficialClientModules(requireFromAnchor: NodeJS.Require): Promise<OfficialClientModules> {
  // The bundle FILES and their non-platform dependencies resolve from the
  // installed DSH anchor. The browser-form bundles' platform statics come from
  // the seed above; resolving the remaining deps from the anchor keeps the
  // whole captured module graph on that installation.
  const loader = createScopedClientModuleLoader(
    EXPECTED_REGISTRATION_IDS,
    createPlatformRequire(requireFromAnchor),
  )
  const restoreShim = installScopedModuleLoaderShim(loader.load)
  try {
    for (const bundle of OFFICIAL_CLIENT_BUNDLES) {
      // `resolve` runs the published package's Node condition set: the three
      // packages with an explicit node/browser split return their standalone
      // Node entry, the other three return the loader-registered bundle.
      const resolved = requireFromAnchor.resolve(bundle.specifier)
      loader.acceptImported(bundle.id, await import(pathToFileURL(resolved).href))
    }
    loader.assertComplete()
  } finally {
    restoreShim()
  }
  const captured = new Map<string, unknown>()
  for (const id of EXPECTED_REGISTRATION_IDS) captured.set(id, loader.requireModule(`${id}/client`))
  return freezeOfficialClientModules(captured)
}

/**
 * Capture ONE installed DSH generation's whole Client domain composition: the
 * six official `/client` bundles and the generated `/remote` contributions,
 * every specifier resolved from `dshAnchor`. A rejection stays cached (fail
 * fast; a retry cannot succeed because ESM evaluates the bundles once).
 */
async function captureInstalledClientDomainModules(anchor: string): Promise<InstalledClientDomainModules> {
  const requireFromAnchor = createRequire(anchor)
  const modules = await captureInstalledOfficialClientModules(requireFromAnchor)
  const contributions: TypertRemoteContribution[] = []
  for (const specifier of REMOTE_CONTRIBUTION_SPECIFIERS) {
    const namespace = await import(pathToFileURL(requireFromAnchor.resolve(specifier)).href) as { readonly default?: unknown }
    const contribution = namespace.default
    if (
      typeof contribution !== 'object'
      || contribution === null
      || !Array.isArray((contribution as { readonly descriptors?: unknown }).descriptors)
    ) {
      throw new Error(`remote client domains: installed ${specifier} is not a generated Remote contribution`)
    }
    contributions.push(contribution as TypertRemoteContribution)
  }
  return { modules, contributions }
}

/** Load the Client domain composition from one installed DSH anchor (single-flight). */
function loadInstalledClientDomainModules(dshAnchor: string): Promise<InstalledClientDomainModules> {
  const anchor = realpathSync(dshAnchor)
  let pending = installedClientDomainModules.get(anchor)
  if (pending === undefined) {
    pending = captureInstalledClientDomainModules(anchor)
    installedClientDomainModules.set(anchor, pending)
  }
  return pending
}

/** The shared, Domain-only Client composition. Not exported from the package root. */
export interface MountedRemoteClientDomains {
  /** The caller's exact Context (`Object.is` holds; never disposed here). */
  readonly context: Context
  /** The caller's already-installed authenticated Connection. */
  readonly connection: ConnectionHandle
  readonly sessions: ISessions
  readonly jobs: IJobs
  readonly remote: ClientRemote
  /** Release exactly the mounted Domains and `/remote` contributions, in
   *  reverse order. Never disposes the Context, Connection or Gateway. */
  dispose(): Promise<void>
}

/**
 * The staged split-Client domain prerequisites: the generated `/remote`
 * contributions, the private pi-tui contribution, the official fileUpload and
 * Session Clients. This stage must be reachable BEFORE the official Gateway's
 * first Connection generation exists, because:
 *
 * - the Session Client installs the official `typert.contexts` Agent resolver
 *   the Gateway's forwarded-event dispatch needs; and
 * - the root interaction delivery owner subscribes its two official `$on`
 *   listeners only after the Session Client is mounted.
 *
 * The remaining Jobs Client and the Session-list readiness wait belong to
 * {@link MountedRemoteClientDomainPrerequisites.complete}, which requires the
 * first real generation. The M3 in-process path keeps the one-shot
 * {@link mountRemoteClientDomains} wrapper.
 */
export interface MountedRemoteClientDomainPrerequisites {
  readonly context: Context
  readonly connection: ConnectionHandle
  readonly remote: ClientRemote
  readonly sessions: ISessions
  /** Mount the Jobs Client and await the official initial readiness. */
  complete(options?: { readonly signal?: AbortSignal }): Promise<MountedRemoteClientDomains>
  /** Release every mounted prerequisite in reverse order (idempotent). */
  dispose(): Promise<void>
}

export interface MountRemoteClientDomainsOptions {
  /** The caller's ONE Client Context with typert/connection/remote installed. */
  readonly context: Context
  /**
   * Installed `@deepseek-ai/dsh/package.json` anchor. The real split Client
   * process MUST pass it: every official Client bundle and generated
   * `/remote` descriptor is resolved from that installation. Absent = the M3
   * in-process composition reuses this process's captured official modules.
   */
  readonly dshAnchor?: string
  /** Lifecycle signal for the initial-readiness wait. */
  readonly signal?: AbortSignal
}

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

/** One Domain graph's mutable ownership state shared by the staged handles. */
interface RemoteClientDomainState {
  readonly context: Context
  readonly connection: ConnectionHandle
  readonly remote: ClientRemote
  sessions: ISessions
  readonly contributionDisposers: Array<() => Promise<void> | void>
  fileUploadFiber?: Fiber
  sessionFiber?: Fiber
  jobsFiber?: Fiber
  completion?: Promise<MountedRemoteClientDomains>
  disposed: boolean
}

/** Reverse-order Domain teardown. Contribution failures are isolated. */
async function shutdownDomainState(state: RemoteClientDomainState): Promise<unknown[]> {
  if (state.disposed) return []
  state.disposed = true
  for (const fiber of [state.jobsFiber, state.sessionFiber, state.fileUploadFiber]) {
    await fiber?.dispose()
  }
  state.jobsFiber = undefined
  state.sessionFiber = undefined
  state.fileUploadFiber = undefined
  const contributionErrors = await disposeRemoteContributions(state.contributionDisposers)
  state.contributionDisposers.length = 0
  return contributionErrors
}

/**
 * Mount the official Client Domain prerequisites on the caller's
 * ALREADY-AUTHENTICATED Client `Context`: the twelve generated `/remote`
 * contributions, the private pi-tui contribution, the official fileUpload
 * Client, then the official Session Client (which registers the `agent`
 * `typert.contexts` resolver). It deliberately does NOT wait for a Connection
 * generation: the split Client must mount the Session resolver and its root
 * interaction listeners before the official Gateway starts its event pump.
 *
 * Failure semantics: a construction failure unwinds exactly what this stage
 * created, in reverse order; the original error stays primary and any cleanup
 * failures ride its cause chain.
 */
export async function mountRemoteClientDomainPrerequisites(
  options: MountRemoteClientDomainsOptions,
): Promise<MountedRemoteClientDomainPrerequisites> {
  const { context } = options
  // The caller installed the one B1 transport graph. Reading it here is an
  // assertion, never a mount: this function must not create a second
  // Typert/Connection/Gateway.
  const connection = context.get('connection') as unknown as ConnectionHandle | undefined
  const remote = context.get('remote') as ClientRemote | undefined
  if (context.get('typert') === undefined || connection === undefined || remote === undefined) {
    throw new Error('remote client domains: the caller must install typert, the authenticated connection and the API gateway first')
  }

  const source = options.dshAnchor === undefined
    ? { modules: await loadOfficialClientModulesOnce(), contributions: REMOTE_CONTRIBUTIONS as readonly TypertRemoteContribution[] }
    : await loadInstalledClientDomainModules(options.dshAnchor)

  const state: RemoteClientDomainState = {
    context,
    connection,
    remote,
    sessions: undefined as unknown as ISessions,
    contributionDisposers: [],
    disposed: false,
  }

  const unwind = async (error: unknown): Promise<never> => {
    const cleanupErrors = await shutdownDomainState(state)
    const failure = error instanceof Error ? error : new Error(String(error))
    if (cleanupErrors.length > 0) {
      const secondary = cleanupErrors.length === 1
        ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, 'remote client domains: unwind disposal failures')
      mergeCause(failure, secondary)
    }
    throw failure
  }

  try {
    // The explicit generated `/remote` contributions in the frozen order.
    for (const contribution of source.contributions) {
      state.contributionDisposers.push(await remote.$mount(contribution))
    }
    // The private pi-tui contribution: mounted explicitly, AFTER the official
    // generated contributions and deliberately kept separate from that list.
    // It is the package's ONE contribution (rc.2 admits exactly one per
    // package), carrying BOTH private descriptors — the
    // `piTuiFileReferences` augmentation (the official `fileReferences`
    // namespace stays mounted and authoritative for bare queries) and the
    // `piTuiTerminalProgress` status stream.
    state.contributionDisposers.push(await remote.$mount(PI_TUI_CLIENT_CONTRIBUTION))
    // Domain Clients: fileUpload before Sessions is contractual (the Session
    // Client injects `fileUpload`). Each fiber is assigned BEFORE it is
    // awaited: a plugin whose startup rejects is still owned by the reverse
    // teardown at its own position.
    state.fileUploadFiber = context.plugin(source.modules.fileUpload)
    await state.fileUploadFiber
    state.sessionFiber = context.plugin(source.modules.session)
    await state.sessionFiber
    // The Client and Host packages augment the same Cordis `Context` service
    // names, so the augmented property types resolve to the Direct Host faces
    // inside this compilation. The services installed by the captured Client
    // bundles are read through their own public Client faces instead.
    state.sessions = context.get('sessions') as unknown as ISessions
    if (state.sessions === undefined) throw new Error('remote client domains: the official Session Client did not install')
  } catch (error) {
    return await unwind(error)
  }

  return {
    context,
    connection,
    remote,
    sessions: state.sessions,
    async complete(completeOptions = {}): Promise<MountedRemoteClientDomains> {
      if (state.disposed) throw new Error('remote client domains: the prerequisites were already disposed')
      state.completion ??= (async () => {
        try {
          state.jobsFiber = context.plugin(source.modules.jobs)
          await state.jobsFiber
          // Initial readiness is part of construction: a failure (an aborted
          // lifecycle signal included) must unwind the whole partial
          // composition. It runs before the Jobs service assertion so an
          // already-aborted lifecycle keeps its abort classification.
          await waitForInitialReadiness(connection, state.sessions, completeOptions.signal)
          const jobs = context.get('jobs') as unknown as IJobs
          if (jobs === undefined) throw new Error('remote client domains: the official Jobs Client did not install')
          return {
            context,
            connection,
            sessions: state.sessions,
            jobs,
            remote,
            async dispose(): Promise<void> {
              const cleanupErrors = await shutdownDomainState(state)
              if (cleanupErrors.length === 0) return
              const failure = cleanupErrors[0] instanceof Error
                ? cleanupErrors[0]
                : new Error(String(cleanupErrors[0]))
              if (cleanupErrors.length > 1) {
                mergeCause(failure, new AggregateError(cleanupErrors.slice(1), 'remote client domains: remaining disposal failures'))
              }
              throw failure
            },
          }
        } catch (error) {
          return await unwind(error)
        }
      })()
      return await state.completion
    },
    async dispose(): Promise<void> {
      const cleanupErrors = await shutdownDomainState(state)
      if (cleanupErrors.length === 0) return
      const failure = cleanupErrors[0] instanceof Error
        ? cleanupErrors[0]
        : new Error(String(cleanupErrors[0]))
      if (cleanupErrors.length > 1) {
        mergeCause(failure, new AggregateError(cleanupErrors.slice(1), 'remote client domains: remaining disposal failures'))
      }
      throw failure
    },
  }
}

/**
 * Mount the official Client data plane on the caller's ALREADY-AUTHENTICATED
 * Client `Context`: the full staged domain graph (prerequisites + Jobs) and
 * the initial-readiness wait. This wrapper preserves the M3 in-process
 * composition contract; the split Client uses the staged functions directly
 * so its interaction owner exists before the Gateway starts.
 */
export async function mountRemoteClientDomains(
  options: MountRemoteClientDomainsOptions,
): Promise<MountedRemoteClientDomains> {
  const prerequisites = await mountRemoteClientDomainPrerequisites(options)
  return await prerequisites.complete(options.signal === undefined ? {} : { signal: options.signal })
}

/**
 * Compose one fresh official Client `Context` over the M3 in-process carrier:
 * typert -> Connection (explicit transport) -> Gateway -> the shared Domain
 * mount ({@link mountRemoteClientDomains}, which owns the `/remote`
 * contributions and the fileUpload -> Sessions -> Jobs plugins) -> initial
 * readiness. On construction failure the partial composition unwinds
 * immediately; the loader shim is never active during plugin execution.
 */
export async function createRemoteClientRuntime(options: RemoteClientRuntimeOptions): Promise<RemoteClientRuntime> {
  const modules = await loadOfficialClientModulesOnce()
  const { carrier } = options

  const context = new Context()
  let typertFiber: Fiber | undefined
  let connectionFiber: Fiber | undefined
  let gatewayFiber: Fiber | undefined
  let domains: MountedRemoteClientDomains | undefined
  let disposed = false

  /**
   * The frozen §16 shutdown sequence: the shared Domain mount (Jobs -> Sessions
   * -> fileUpload -> `/remote` contributions reverse), Gateway/Connection/
   * Typert (reverse), then the Client root. Unwinding a partial composition
   * runs the SAME order over whatever subset exists.
   *
   * A Domain teardown failure is collected (never allowed to truncate the
   * remaining cleanup). Cordis contains unload-disposer failures inside
   * `fiber.dispose()` (they are logged there, never propagated), so the
   * remaining fiber steps cannot reject.
   *
   * @returns the collected cleanup errors.
   */
  const shutdown = async (): Promise<unknown[]> => {
    const errors: unknown[] = []
    try {
      await domains?.dispose()
    } catch (error) {
      errors.push(error)
    }
    for (const fiber of [gatewayFiber, connectionFiber, typertFiber]) {
      await fiber?.dispose()
    }
    await context.fiber.dispose()
    return errors
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
    //    `interactions: 'answer'` is declared explicitly: the official default
    //    is `answer` only for a page carrier (a location) and `none` for a
    //    non-browser composition, and this in-process Client is the TUI's ONE
    //    answering surface — forwarded events and Host waterfalls are refused
    //    outright under `none`.
    connectionFiber = context.plugin(connectionContext => {
      modules.connection.installConnection(connectionContext, {
        interactions: 'answer',
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
    // 4. The ONE shared official Domain mount.
    domains = await mountRemoteClientDomains({ context, ...(options.signal === undefined ? {} : { signal: options.signal }) })
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
  const mounted = domains!

  const runtime: RemoteClientRuntime = {
    context,
    connection: mounted.connection,
    sessions: mounted.sessions,
    jobs: mounted.jobs,
    remote: mounted.remote,
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
 * Initial readiness: a defined Connection
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
