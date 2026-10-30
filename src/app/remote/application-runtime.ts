/**
 * M3-4 PR1 Remote application runtime aggregate: the ONE application-level
 * owner that joins the existing constructors into a single Remote graph —
 *
 * ```text
 * createExperimentalRemoteRuntime(...)   ONE Host + ONE Client runtime
 *   -> createRemoteBackendRuntime(...)   ONE semantic assembly / Backend
 *   -> createRemoteSessionOwnerServices  ONE owner/retirement registry
 * ```
 *
 * It never rebuilds those constructors and never calls a second semantic
 * assembly. `promptSerializer` is an INJECTED dependency: PR1 does not own a
 * production submission serializer, so only composition tests (and the later
 * M3-4 submission PR) supply a real one; the aggregate itself never invents
 * or weakens one.
 *
 * M4-B2-S adds {@link createRemoteApplicationRuntimeFromClient}: the SAME
 * Backend/Owner/Presentation stage over an ALREADY-MOUNTED official Client
 * Domain graph (the real split Client's one Context + B1 transport). It owns
 * no Context, Connection, Gateway or Client UI subtree: those belong to the
 * Client process composition root. The two public functions share the ONE
 * private {@link composeRemoteApplicationStage}, so the Remote semantics can
 * never fork between the M3 in-process path and the split Client path.
 *
 * The transport disposer owns exactly the adapters it was given: for M3 that
 * is `clientUi.dispose()` then the presentation task then the backend runtime
 * then `wire.dispose()`; for the split Client it is the presentation task then
 * the backend runtime then the mounted Client Domains (the Client UI subtree
 * and B1 transport stay owned by the Client bootstrap). It is idempotent and
 * error-preserving, and never retires the currently selected Session — that
 * stays `app/session` ownership, and the caller order is `session retirement
 * -> disposeTransport()`.
 *
 * The only sanctioned reachability is the internal application
 * runtime-selection seam through `runtime/backend-loader.ts`; tests about
 * this composition owner may construct it directly.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/application-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ClientUiStartupFacts, SelectedApplicationRuntime } from '../application-runtime.ts'
import type { RemotePromptSerializer } from '../../runtime/remote/session-writer-remote.ts'
import type { PiTuiExtensionService } from '../../extensions.ts'
import { mergeCause } from './dispose-cause.ts'
import {
  createExperimentalRemoteRuntime,
  createRemoteBackendRuntime,
  type ExperimentalRemoteRuntime,
  type RemoteBackendFetch,
  type RemoteBackendRuntime,
} from './runtime.ts'
import { createRemoteSessionOwnerServices } from './session-owners.ts'
import {
  createRemotePresentationSource,
  type RemoteApplicationSource,
  type RemotePresentationClientSource,
} from './presentation-source.ts'
import { createRemoteClientUiRuntime, type RemoteClientUiRuntime } from './client-ui-runtime.ts'
import type { MountedRemoteClientDomains } from './client-runtime.ts'

/** Start input for the M3 Remote application runtime aggregate. */
export interface RemoteApplicationRuntimeOptions {
  /** The already-running ordinary Host Context (never disposed here). */
  readonly hostContext: Context
  /** Host bootstrap prerequisite barrier owned by the caller (M3-0 ordering
   *  contract: the Remote composition must not race the Host-local
   *  legacy-settings migration). */
  readonly waitForHostPrerequisites: () => Promise<void>
  /** Lifecycle signal observed between the Host prerequisite and composition. */
  readonly signal?: AbortSignal
  /**
   * The application-owned prompt serializer (the D2.2 writer dependency).
   * Optional since M3-4 PR3: absent selects the PRODUCTION serializer; an
   * explicit injection is a composition-test stub.
   */
  readonly promptSerializer?: RemotePromptSerializer
  /**
   * The Client-local UI startup facts (M3-6 PR1): detached
   * `sessionId`/`presetId` plain data the Client UI subtree (extension
   * host + first-party builtins on `wire.client.context`) mounts under.
   * REQUIRED — every Remote aggregate construction states the Client-local
   * startup facts explicitly (runtime-only fixtures pass `{}`).
   */
  readonly clientUiStartup: ClientUiStartupFacts
}

/** The M3 Remote application runtime: the selected core plus its parts. */
export interface RemoteApplicationRuntime {
  readonly selected: SelectedApplicationRuntime
  readonly wire: ExperimentalRemoteRuntime
  readonly backendRuntime: RemoteBackendRuntime
  /**
   * The M3-4 PR2 branch-specific presentation source bundle (the reader by
   * identity, the official pending-submissions echo source, the eventSource
   * live ingress, the Session-scoped status facts) — built from the SAME
   * wire/aggregate, never a second graph. It constructs no subscription and
   * owns no disposal; the consuming bootstrap owns the ingress handles.
   */
  readonly presentation: RemoteApplicationSource
  /**
   * The M3-6 PR1 PiTui Client UI subtree on the exact official Client
   * Context (`wire.client.context`): the Client-local tuiStartup facts
   * fiber, the extension-host fiber, the first-party builtins fiber and the
   * ONE Client-local `PiTuiExtensionService` the Remote branch's UI runs
   * on. Composition/qualification input only — never part of the package
   * API.
   */
  readonly clientUi: RemoteClientUiRuntime
}

/**
 * The split-Client application runtime (M4-B2-S): the selected core plus the
 * presentation bundle and the Client-local extension service, all built over
 * the ONE mounted official Client Domain graph. It deliberately has NO `wire`
 * member: the split Client has no M3 Host carrier or in-process wire, and this
 * narrow result must not be mistaken for {@link RemoteApplicationRuntime}.
 */
export interface SplitRemoteApplicationRuntime {
  readonly selected: SelectedApplicationRuntime
  readonly presentation: RemoteApplicationSource
  /** Identity: `clientUi.extensionService` (the Client Context's service). */
  readonly extensionService: PiTuiExtensionService
}

/** Start input for the split-Client application runtime. */
export interface SplitRemoteApplicationRuntimeOptions {
  /** The mounted official Client Domain graph (ONE Context/Connection). */
  readonly domains: MountedRemoteClientDomains
  /** The SAME B1 authenticated Cookie fetch the archive adapter addresses. */
  readonly fetch: RemoteBackendFetch
  /** The already-mounted Client UI subtree (identity source of the extension
   * service). */
  readonly clientUi: RemoteClientUiRuntime
  /** Lifecycle signal observed by the Backend composition. */
  readonly signal?: AbortSignal
  /** Internal qualification input: a serializer wrapper used only to hold one
   *  write between serialization and dispatch admission (T34). Absent in
   *  production, where the production serializer is the default. */
  readonly promptSerializer?: RemotePromptSerializer
}

/** The ONE shared composition stage: Backend + owner registry + presentation. */
interface ComposedRemoteApplicationStage {
  readonly backendRuntime: RemoteBackendRuntime
  readonly owners: SelectedApplicationRuntime['owners']
  readonly retirement: SelectedApplicationRuntime['retirement']
  readonly presentation: RemoteApplicationSource
  /** Synchronously close the pre-dispatch write admission (idempotent). */
  stopSurfaceAdmission(): void
  /** Dispose the presentation task then the backend runtime (idempotent,
   *  error-preserving). Never touches the Client graph the caller owns. */
  disposeAdapters(): Promise<void>
}

/** Run one disposal step with per-step error isolation: the step's failures
 *  are collected (never thrown here) so the remaining steps always run. */
async function collectDisposeErrors(dispose: () => Promise<void> | void): Promise<unknown[]> {
  try {
    await dispose()
  } catch (error) {
    return [error]
  }
  return []
}

/** Surface the first collected failure with the rest attached as its cause. */
function throwAggregated(errors: readonly unknown[], label: string): void {
  const failure = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]))
  if (errors.length > 1) {
    mergeCause(failure, new AggregateError(errors.slice(1), `${label}: remaining disposal failures`))
  }
  throw failure
}

/**
 * The ONE Remote semantic composition stage shared by both public
 * application-runtime constructors. It composes the Backend, the ONE owner
 * registry and the presentation bundle over the supplied Client runtime
 * source. It owns no Context/Connection/Gateway/UI: the caller owns those and
 * disposes them around this stage.
 *
 * Failure semantics: a backend construction failure unwinds inside
 * `createRemoteBackendRuntime`; a LATER owner/presentation failure disposes the
 * constructed presentation task/backend before rethrowing, with the original
 * error primary.
 */
async function composeRemoteApplicationStage(input: {
  readonly client: RemotePresentationClientSource
  readonly fetch: RemoteBackendFetch
  readonly promptSerializer?: RemotePromptSerializer
  readonly preservesHostPendingOnDetach?: boolean
}): Promise<ComposedRemoteApplicationStage> {
  let backendRuntime: RemoteBackendRuntime | undefined
  let ownerServices: ReturnType<typeof createRemoteSessionOwnerServices> | undefined
  let presentation: RemoteApplicationSource | undefined
  /**
   * The composition-owned pre-dispatch write admission: OPEN for the whole live
   * surface, closed ONCE and synchronously by the application's surface-stop
   * boundary (`SelectedApplicationRuntime.stopSurfaceAdmission`). A write still
   * parked before dispatch when the surface stops is then refused before any
   * Host dispatch instead of being admitted silently.
   */
  let dispatchAdmissionOpen = true
  try {
    backendRuntime = await createRemoteBackendRuntime({
      runtime: input.client,
      fetch: input.fetch,
      isDispatchAllowed: () => dispatchAdmissionOpen,
      // Absent = the production serializer (see createRemoteBackendRuntime).
      ...(input.promptSerializer === undefined ? {} : { promptSerializer: input.promptSerializer }),
    })
    // ONE owner registry shared by owners + retirement (never constructed
    // independently — that would create a second owner truth). The SAME
    // official Connection generation source fences the owner mutation replies.
    ownerServices = createRemoteSessionOwnerServices(
      input.client.sessions,
      input.client.connection.generation,
    )
    // The presentation bundle built from the SAME source. Its Task read owns a
    // retained root Job-roster watch that must be released through this stage
    // before the official Client services are unmounted.
    presentation = createRemotePresentationSource(input.client, backendRuntime)
  } catch (error) {
    const disposeErrors = [
      ...presentation === undefined ? [] : await collectDisposeErrors(() => presentation!.task.dispose()),
      ...backendRuntime === undefined ? [] : await collectDisposeErrors(() => backendRuntime!.dispose()),
    ]
    if (disposeErrors.length > 0) {
      const secondary = disposeErrors.length === 1
        ? disposeErrors[0]
        : new AggregateError(disposeErrors, 'remote application runtime: disposal failures during stage construction')
      throw mergeCause(error instanceof Error ? error : new Error(String(error)), secondary)
    }
    throw error
  }
  const composed = { backendRuntime, ownerServices, presentation }
  let adaptersDisposed = false
  return {
    backendRuntime: composed.backendRuntime,
    owners: composed.ownerServices.owners,
    retirement: composed.ownerServices.retirement,
    presentation: composed.presentation,
    stopSurfaceAdmission: (): void => { dispatchAdmissionOpen = false },
    async disposeAdapters(): Promise<void> {
      if (adaptersDisposed) return
      adaptersDisposed = true
      // The presentation task drops its retained roster watch and invalidates
      // every in-flight Task read; the backend runtime then drops its adapter
      // caches/subscriptions. Both run even when the first throws; the first
      // error surfaces with the rest on its cause chain.
      const errors = [
        ...await collectDisposeErrors(() => composed.presentation.task.dispose()),
        ...await collectDisposeErrors(() => composed.backendRuntime.dispose()),
      ]
      if (errors.length > 0) throwAggregated(errors, 'remote application runtime adapter disposal')
    },
  }
}

/**
 * Compose the M3 Remote application runtime as ONE graph. Failure semantics: a
 * Host/Client construction failure unwinds inside
 * `createExperimentalRemoteRuntime` (no leaked fibers); a backend/owner
 * failure after the wire exists disposes the wire (both steps run; the
 * original error surfaces with disposal failures on its cause chain, never
 * masked by them) and rethrows.
 */
export async function createRemoteApplicationRuntime(
  options: RemoteApplicationRuntimeOptions,
): Promise<RemoteApplicationRuntime> {
  const wire = await createExperimentalRemoteRuntime({
    hostContext: options.hostContext,
    waitForHostPrerequisites: options.waitForHostPrerequisites,
    signal: options.signal,
  })

  let stage: ComposedRemoteApplicationStage
  try {
    stage = await composeRemoteApplicationStage({
      client: wire.client,
      fetch: wire.host.carrier.fetch,
      ...(options.promptSerializer === undefined ? {} : { promptSerializer: options.promptSerializer }),
    })
  } catch (error) {
    // The wire (Client first, then Host additive fibers) must not survive a
    // stage construction failure after the Client exists. The original error
    // rethrows; a disposal failure rides its cause chain.
    const disposeErrors = await collectDisposeErrors(() => wire.dispose())
    if (disposeErrors.length > 0) {
      const secondary = disposeErrors.length === 1
        ? disposeErrors[0]
        : new AggregateError(disposeErrors, 'remote application runtime: disposal failures during stage-failure unwind')
      throw mergeCause(error instanceof Error ? error : new Error(String(error)), secondary)
    }
    throw error
  }

  // The M3-6 PR1 Client UI subtree on the EXACT official Client Context —
  // never a second Context. A construction failure after the
  // backend/presentation exist unwinds the partially-created subtree (its
  // own constructor owns its partial fibers), then the stage adapters and the
  // wire, with the original error primary.
  let clientUi: RemoteClientUiRuntime
  try {
    clientUi = await createRemoteClientUiRuntime({
      context: wire.client.context,
      startup: options.clientUiStartup,
    })
  } catch (error) {
    const disposeErrors = [
      ...await collectDisposeErrors(() => stage.disposeAdapters()),
      ...await collectDisposeErrors(() => wire.dispose()),
    ]
    if (disposeErrors.length > 0) {
      const secondary = disposeErrors.length === 1
        ? disposeErrors[0]
        : new AggregateError(disposeErrors, 'remote application runtime: disposal failures during client-UI construction failure')
      throw mergeCause(error instanceof Error ? error : new Error(String(error)), secondary)
    }
    throw error
  }

  let transportDisposed = false
  return {
    selected: {
      kind: 'remote',
      backend: stage.backendRuntime.backend,
      owners: stage.owners,
      retirement: stage.retirement,
      stopSurfaceAdmission: stage.stopSurfaceAdmission,
      disposeTransport: async (): Promise<void> => {
        if (transportDisposed) return
        transportDisposed = true
        // clientUi.dispose() drops the Client UI plugin fibers (builtins ->
        // extension host -> startup facts) while every official Client
        // service they may consume still exists; the stage then drops the
        // presentation/task + backend adapters; wire.dispose() disposes Client
        // first, Host additive fibers last. Every step runs even when an
        // earlier one throws; the first error surfaces with the rest on its
        // cause chain.
        const errors = [
          ...await collectDisposeErrors(() => clientUi.dispose()),
          ...await collectDisposeErrors(() => stage.disposeAdapters()),
          ...await collectDisposeErrors(() => wire.dispose()),
        ]
        if (errors.length > 0) throwAggregated(errors, 'remote application runtime transport disposal')
      },
    },
    wire,
    backendRuntime: stage.backendRuntime,
    presentation: stage.presentation,
    clientUi,
  }
}

/**
 * Compose the split-Client application runtime over the ONE already-mounted
 * official Client Domain graph. The caller (the Client process composition
 * root) owns the Context, B1 transport, Domain mount and Client UI subtree;
 * this function owns exactly the Backend, owner registry, presentation bundle
 * and the selected core.
 *
 * `selected.disposeTransport()` memoizes ONE release of presentation/backend/
 * domains, so the runner (which may call it during its own teardown) and the
 * Client bootstrap (final fallback) can both ask for it without a second
 * unmount. It never releases the Client UI subtree or the B1 transport — those
 * stay with the Client bootstrap.
 */
export async function createRemoteApplicationRuntimeFromClient(
  options: SplitRemoteApplicationRuntimeOptions,
): Promise<SplitRemoteApplicationRuntime> {
  const stage = await composeRemoteApplicationStage({
    client: options.domains,
    fetch: options.fetch,
    ...(options.promptSerializer === undefined ? {} : { promptSerializer: options.promptSerializer }),
    preservesHostPendingOnDetach: true,
  })
  let transportDisposed = false
  return {
    selected: {
      kind: 'remote',
      backend: stage.backendRuntime.backend,
      owners: stage.owners,
      retirement: stage.retirement,
      stopSurfaceAdmission: stage.stopSurfaceAdmission,
      disposeTransport: async (): Promise<void> => {
        if (transportDisposed) return
        transportDisposed = true
        // Presentation task first (official ClientSessions / JobClient still
        // mounted), then the backend adapters, then the borrowed Client
        // Domain graph. The Client UI subtree and B1 transport are NOT ours.
        const errors = [
          ...await collectDisposeErrors(() => stage.disposeAdapters()),
          ...await collectDisposeErrors(() => options.domains.dispose()),
        ]
        if (errors.length > 0) throwAggregated(errors, 'split remote application transport disposal')
      },
    },
    presentation: stage.presentation,
    extensionService: options.clientUi.extensionService,
  }
}
