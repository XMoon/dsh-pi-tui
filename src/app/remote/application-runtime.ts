/**
 * The split-Client application runtime (M4-B2-S): the ONE application-level
 * owner of the real internal split Client.
 *
 * It composes the shared {@link composeRemoteApplicationStage} over the
 * ALREADY-MOUNTED official Client Domain graph (the split Client's one Context
 * and B1 transport). It owns no Context, Connection, Gateway or Client UI
 * subtree: those belong to the Client process composition root.
 *
 * The retired M3 in-process aggregate is NOT here. It was test-only, so it
 * lives in `test/support/m3-inprocess/application-runtime.ts` and shares this
 * same stage; production code cannot reach it.
 *
 * The transport disposer owns exactly the adapters it was given: the
 * presentation task then the backend runtime then the mounted Client Domains
 * (the Client UI subtree and B1 transport stay owned by the Client bootstrap).
 * It is idempotent and error-preserving, and never retires the currently
 * selected Session — that stays `app/session` ownership, and the caller order
 * is `session retirement -> disposeTransport()`.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/application-runtime
 */

import type { SelectedApplicationRuntime } from '../application-runtime.ts'
import type { RemotePromptSerializer } from '../../runtime/remote/session-writer-remote.ts'
import type { PiTuiExtensionService } from '../../extensions.ts'
import type { RemoteBackendFetch } from './runtime.ts'
import type { RemoteApplicationSource } from './presentation-source.ts'
import type { RemoteClientUiRuntime } from './client-ui-runtime.ts'
import type { MountedRemoteClientDomains } from './client-runtime.ts'
import type { SplitClientInteractionDelivery } from '../../runtime/remote/interaction-remote.ts'
import {
  collectDisposeErrors,
  composeRemoteApplicationStage,
  throwAggregated,
} from './application-stage.ts'

/**
 * The split-Client application runtime (M4-B2-S): the selected core plus the
 * presentation bundle and the Client-local extension service, all built over
 * the ONE mounted official Client Domain graph. It deliberately has NO `wire`
 * member: the split Client has no M3 Host carrier or in-process wire, and this
 * narrow result must not be mistaken for the retired M3 aggregate (which is
 * test-only now: `test/support/m3-inprocess/application-runtime.ts`).
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
  /** The authenticated Host listener origin from the Client's verified identity. */
  readonly trustedHostOrigin?: string
  /** The already-mounted Client UI subtree (identity source of the extension
   * service). */
  readonly clientUi: RemoteClientUiRuntime
  /** Lifecycle signal observed by the Backend composition. */
  readonly signal?: AbortSignal
  /** Internal qualification input: a serializer wrapper used only to hold one
   *  write between serialization and dispatch admission (T34). Absent in
   *  production, where the production serializer is the default. */
  readonly promptSerializer?: RemotePromptSerializer
  /** Split-Client only: the Client-root interaction delivery owner. When
   *  present, the Remote interaction adapter borrows THIS surface revision's
   *  two providers instead of registering per-revision `$on` listeners. */
  readonly delivery?: SplitClientInteractionDelivery
  /** Split-Client only: the surface revision identity attached to `delivery`. */
  readonly surfaceRevision?: number
  /** Qualification-only telemetry forwarded to the Remote interaction port. */
  readonly onQualification?: (record: Record<string, unknown>) => void
}

/**
 * Compose the split-Client application runtime over the ONE already-mounted
 * official Client Domain graph. The caller (the Client process composition
 * root) owns the Context, B1 transport, Domain mount and Client UI subtree;
 * this function owns exactly the Backend, owner registry, presentation bundle
 * and the selected core.
 *
 * `selected.disposeTransport()` memoizes ONE release of the presentation and
 * backend adapters, so the runner (which may call it during its own teardown)
 * and the Client bootstrap (final fallback) can both ask for it without a
 * second unmount. It never releases the Client UI subtree, the root Domain
 * graph or the B1 transport — those stay with the Client bootstrap.
 */
export async function createRemoteApplicationRuntimeFromClient(
  options: SplitRemoteApplicationRuntimeOptions,
): Promise<SplitRemoteApplicationRuntime> {
  const stage = await composeRemoteApplicationStage({
    client: options.domains,
    fetch: options.fetch,
    ...(options.trustedHostOrigin === undefined ? {} : { trustedHostOrigin: options.trustedHostOrigin }),
    ...(options.promptSerializer === undefined ? {} : { promptSerializer: options.promptSerializer }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
    ...(options.surfaceRevision === undefined ? {} : { surfaceRevision: options.surfaceRevision }),
    ...(options.onQualification === undefined ? {} : { onQualification: options.onQualification }),
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
        // mounted), then the backend adapters. The root Domain graph, the
        // Client UI subtree and the B1 transport are NOT owned here: the
        // split Client root disposes them after every surface revision.
        const errors = [
          ...await collectDisposeErrors(() => stage.disposeAdapters()),
        ]
        if (errors.length > 0) throwAggregated(errors, 'split remote application transport disposal')
      },
    },
    presentation: stage.presentation,
    extensionService: options.clientUi.extensionService,
  }
}
