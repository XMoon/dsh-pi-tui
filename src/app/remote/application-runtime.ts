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
 * The transport disposer owns exactly `backendRuntime.dispose()` then
 * `wire.dispose()` (adapters before Client, Client before Host additive
 * fibers) and is idempotent + error-preserving. It never retires the
 * currently selected Session — that stays `app/session` ownership, and the
 * caller order is `session retirement -> disposeTransport()`.
 *
 * The only sanctioned reachability is the internal application
 * runtime-selection seam through `runtime/backend-loader.ts`; tests about
 * this composition owner may construct it directly.
 *
 * @module @xmoon76/dsh-pi-tui/app/remote/application-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SelectedApplicationRuntime } from '../application-runtime.ts'
import type { RemotePromptSerializer } from '../../runtime/remote/session-writer-remote.ts'
import { mergeCause } from './host-runtime.ts'
import {
  createExperimentalRemoteRuntime,
  createRemoteBackendRuntime,
  type ExperimentalRemoteRuntime,
  type RemoteBackendRuntime,
} from './runtime.ts'
import { createRemoteSessionOwnerServices, type RemoteSessionOwnerServices } from './session-owners.ts'

/** Start input for the Remote application runtime aggregate. */
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
   * PR1 injects it only in composition tests; the real production serializer
   * is completed in the M3-4 submission PR.
   */
  readonly promptSerializer: RemotePromptSerializer
}

/** The Remote application runtime: the selected core plus its parts. */
export interface RemoteApplicationRuntime {
  readonly selected: SelectedApplicationRuntime
  readonly wire: ExperimentalRemoteRuntime
  readonly backendRuntime: RemoteBackendRuntime
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
 * Compose the Remote application runtime as ONE graph. Failure semantics: a
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

  let backendRuntime: RemoteBackendRuntime | undefined
  let ownerServices: RemoteSessionOwnerServices
  try {
    backendRuntime = await createRemoteBackendRuntime({
      runtime: wire.client,
      fetch: wire.host.carrier.fetch,
      promptSerializer: options.promptSerializer,
    })
    // ONE owner registry shared by owners + retirement (never constructed
    // independently — that would create a second owner truth).
    ownerServices = createRemoteSessionOwnerServices(wire.client.sessions)
  } catch (error) {
    // Unwind the partial graph: the wire (Client first, then Host additive
    // fibers) must not survive a backend/owner construction failure after the
    // Client exists — and a backend that WAS constructed is disposed first, so
    // its partial adapter state does not survive either. A disposal failure
    // rides the original error's cause chain; the original rethrows.
    const constructed = backendRuntime
    const disposeErrors = [
      ...constructed !== undefined ? await collectDisposeErrors(() => constructed.dispose()) : [],
      ...await collectDisposeErrors(() => wire.dispose()),
    ]
    if (disposeErrors.length > 0) {
      const secondary = disposeErrors.length === 1
        ? disposeErrors[0]
        : new AggregateError(disposeErrors, 'remote application runtime: disposal failures during construction-failure unwind')
      throw mergeCause(error instanceof Error ? error : new Error(String(error)), secondary)
    }
    throw error
  }

  let transportDisposed = false
  return {
    selected: {
      kind: 'remote',
      backend: backendRuntime.backend,
      owners: ownerServices.owners,
      retirement: ownerServices.retirement,
      disposeTransport: async (): Promise<void> => {
        if (transportDisposed) return
        transportDisposed = true
        // backendRuntime.dispose() drops the adapter caches/subscriptions
        // BEFORE the Client Context disposal; wire.dispose() then disposes
        // Client first, Host additive fibers last. Both steps run even when
        // the first throws; the first error surfaces with the second on its
        // cause chain.
        const errors = [
          ...await collectDisposeErrors(() => backendRuntime.dispose()),
          ...await collectDisposeErrors(() => wire.dispose()),
        ]
        if (errors.length > 0) throwAggregated(errors, 'remote application runtime transport disposal')
      },
    },
    wire,
    backendRuntime,
  }
}
