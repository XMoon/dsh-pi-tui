/**
 * TEST_ONLY_M3_CARRIER: the retired M3 Remote application runtime aggregate.
 *
 * It joined the in-process wire, the shared application stage and the Client UI
 * subtree into ONE Remote graph for the historical L5/L6 suites. It is NOT a
 * production composition: `src/**` cannot import it, it never enters the
 * published bundle, and the real split Client uses
 * `createRemoteApplicationRuntimeFromClient` in `src/app/remote/application-runtime.ts`
 * with the SAME `composeRemoteApplicationStage`, so the Remote semantics can
 * never fork between the two.
 *
 * @module test/support/m3-inprocess/application-runtime
 */

import type { ClientUiStartupFacts, SelectedApplicationRuntime } from '../../../src/app/application-runtime.ts'
import type { RemotePromptSerializer } from '../../../src/runtime/remote/session-writer-remote.ts'
import { mergeCause } from '../../../src/app/remote/dispose-cause.ts'
import type { RemoteBackendRuntime } from '../../../src/app/remote/runtime.ts'
import {
  collectDisposeErrors,
  composeRemoteApplicationStage,
} from '../../../src/app/remote/application-stage.ts'
import type { RemoteApplicationSource } from '../../../src/app/remote/presentation-source.ts'
import { createRemoteClientUiRuntime, type RemoteClientUiRuntime } from '../../../src/app/remote/client-ui-runtime.ts'
import { createExperimentalRemoteRuntime, type ExperimentalRemoteRuntime } from './runtime.ts'

/** Start input for the M3 Remote application runtime aggregate. */
export interface RemoteApplicationRuntimeOptions {
  /** The already-running ordinary Host Context (never disposed here). */
  readonly hostContext: import('@deepseek-ai/cordis').Context
  /** Host bootstrap prerequisite barrier owned by the caller. */
  readonly waitForHostPrerequisites: () => Promise<void>
  /** Lifecycle signal observed between the Host prerequisite and composition. */
  readonly signal?: AbortSignal
  /** Explicit serializer injection (composition-test stub). */
  readonly promptSerializer?: RemotePromptSerializer
  /** Build a serializer over the joined wire (qualification wrappers that must
   * observe/decorate the PRODUCTION serializer, e.g. a hold between upload and
   * dispatch). Takes precedence only when `promptSerializer` is absent. */
  readonly buildPromptSerializer?: (wire: ExperimentalRemoteRuntime) => RemotePromptSerializer
  /** The Client-local UI startup facts. */
  readonly clientUiStartup: ClientUiStartupFacts
}

/** The M3 Remote application runtime: the selected core plus its parts. */
export interface RemoteApplicationRuntime {
  readonly selected: SelectedApplicationRuntime
  readonly wire: ExperimentalRemoteRuntime
  readonly backendRuntime: RemoteBackendRuntime
  readonly presentation: RemoteApplicationSource
  readonly clientUi: RemoteClientUiRuntime
}

/**
 * Compose the M3 in-process Remote application runtime as ONE graph. Failure
 * semantics are unchanged from the retired production module: a construction
 * failure unwinds every already-created part (Client UI -> stage adapters ->
 * wire) and the original error stays primary.
 */
export async function createRemoteApplicationRuntime(
  options: RemoteApplicationRuntimeOptions,
): Promise<RemoteApplicationRuntime> {
  const wire = await createExperimentalRemoteRuntime({
    hostContext: options.hostContext,
    waitForHostPrerequisites: options.waitForHostPrerequisites,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })

  let stage: Awaited<ReturnType<typeof composeRemoteApplicationStage>>
  try {
    // Read the caller's serializer input INSIDE the post-wire unwind window:
    // an injected getter that throws must still unwind the constructed wire.
    const promptSerializer = options.promptSerializer
      ?? options.buildPromptSerializer?.(wire)
    stage = await composeRemoteApplicationStage({
      client: wire.client,
      fetch: wire.host.carrier.fetch,
      ...(promptSerializer === undefined ? {} : { promptSerializer }),
    })
  } catch (error) {
    const disposeErrors = await collectDisposeErrors(() => wire.dispose())
    if (disposeErrors.length > 0) {
      const secondary = disposeErrors.length === 1
        ? disposeErrors[0]
        : new AggregateError(disposeErrors, 'remote application runtime: disposal failures during stage-failure unwind')
      throw mergeCause(error instanceof Error ? error : new Error(String(error)), secondary)
    }
    throw error
  }

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
        const errors = [
          ...await collectDisposeErrors(() => clientUi.dispose()),
          ...await collectDisposeErrors(() => stage.disposeAdapters()),
          ...await collectDisposeErrors(() => wire.dispose()),
        ]
        if (errors.length > 0) {
          const failure = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]))
          if (errors.length > 1) {
            mergeCause(failure, new AggregateError(errors.slice(1), 'remote application runtime transport disposal: remaining disposal failures'))
          }
          throw failure
        }
      },
    },
    wire,
    backendRuntime: stage.backendRuntime,
    presentation: stage.presentation,
    clientUi,
  }
}
