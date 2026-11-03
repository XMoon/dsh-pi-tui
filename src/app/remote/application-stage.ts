/**
 * The ONE Remote semantic composition stage shared by every Remote
 * application-runtime constructor that still exists.
 *
 * It composes the semantic `Backend`, the ONE owner registry and the
 * presentation bundle over a supplied Client runtime source. It owns no
 * Context, Connection, Gateway or Client UI: the caller owns those and disposes
 * them around this stage. The split Client and the test-only M3 in-process
 * aggregate therefore share ONE implementation, so the Remote semantics can
 * never fork between them.
 *
 * This module is production code: it is imported by the split Client
 * composition. It contains no in-process carrier and no Host composition.
 *
 * @module app/remote/application-stage
 */

import type { SelectedApplicationRuntime } from '../application-runtime.ts'
import type { RemotePromptSerializer } from '../../runtime/remote/session-writer-remote.ts'
import { mergeCause } from './dispose-cause.ts'
import {
  createRemoteBackendRuntime,
  type RemoteBackendFetch,
  type RemoteBackendRuntime,
} from './runtime.ts'
import { createRemoteSessionOwnerServices } from './session-owners.ts'
import {
  createRemotePresentationSource,
  type RemoteApplicationSource,
  type RemotePresentationClientSource,
} from './presentation-source.ts'
import type { SplitClientInteractionDelivery } from '../../runtime/remote/interaction-remote.ts'

/** The ONE shared composition stage: Backend + owner registry + presentation. */
export interface ComposedRemoteApplicationStage {
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
export async function collectDisposeErrors(dispose: () => Promise<void> | void): Promise<unknown[]> {
  try {
    await dispose()
  } catch (error) {
    return [error]
  }
  return []
}

/** Surface the first collected failure with the rest attached as its cause. */
export function throwAggregated(errors: readonly unknown[], label: string): void {
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
export async function composeRemoteApplicationStage(input: {
  readonly client: RemotePresentationClientSource
  readonly fetch: RemoteBackendFetch
  readonly promptSerializer?: RemotePromptSerializer
  readonly delivery?: SplitClientInteractionDelivery
  readonly surfaceRevision?: number
  readonly onQualification?: (record: Record<string, unknown>) => void
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
      ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      ...(input.surfaceRevision === undefined ? {} : { surfaceRevision: input.surfaceRevision }),
      ...(input.onQualification === undefined ? {} : { onQualification: input.onQualification }),
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

