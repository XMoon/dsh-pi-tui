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
 * The transport disposer owns exactly `clientUi.dispose()` (the M3-6 PR1
 * Client UI subtree: builtins -> extension host -> startup facts) then
 * `presentation.task.dispose()` then `backendRuntime.dispose()` then
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
import type { ClientUiStartupFacts, SelectedApplicationRuntime } from '../application-runtime.ts'
import type { RemotePromptSerializer } from '../../runtime/remote/session-writer-remote.ts'
import { mergeCause } from './host-runtime.ts'
import {
  createExperimentalRemoteRuntime,
  createRemoteBackendRuntime,
  type ExperimentalRemoteRuntime,
  type RemoteBackendRuntime,
} from './runtime.ts'
import { createRemoteSessionOwnerServices, type RemoteSessionOwnerServices } from './session-owners.ts'
import { createRemotePresentationSource, type RemoteApplicationSource } from './presentation-source.ts'
import { createRemoteClientUiRuntime, type RemoteClientUiRuntime } from './client-ui-runtime.ts'

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

/** The Remote application runtime: the selected core plus its parts. */
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
      // Absent = the production serializer (see createRemoteBackendRuntime).
      ...(options.promptSerializer === undefined ? {} : { promptSerializer: options.promptSerializer }),
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
  // The M3-5 PR2 presentation/task source bundle. Its Task read owns a retained
  // root Job-roster watch that must be released through THIS owner before the
  // Client Context is disposed (adapter -> Client -> Host order).
  const presentation = createRemotePresentationSource(wire, backendRuntime)
  // The M3-6 PR1 Client UI subtree on the EXACT official Client Context —
  // never a second Context. A construction failure after the
  // backend/presentation exist unwinds the partially-created subtree (its
  // own constructor owns its partial fibers), then the presentation task,
  // backend and wire, with the original error primary.
  let clientUi: RemoteClientUiRuntime
  try {
    clientUi = await createRemoteClientUiRuntime({
      context: wire.client.context,
      startup: options.clientUiStartup,
    })
  } catch (error) {
    const disposeErrors = [
      ...await collectDisposeErrors(() => presentation.task.dispose()),
      ...await collectDisposeErrors(() => backendRuntime.dispose()),
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
  return {
    selected: {
      kind: 'remote',
      backend: backendRuntime.backend,
      owners: ownerServices.owners,
      retirement: ownerServices.retirement,
      disposeTransport: async (): Promise<void> => {
        if (transportDisposed) return
        transportDisposed = true
        // clientUi.dispose() drops the Client UI plugin fibers (builtins ->
        // extension host -> startup facts) while every official Client
        // service they may consume still exists; presentation.task.dispose()
        // drops the retained roster watch and invalidates every in-flight
        // Task read; backendRuntime.dispose() then drops the adapter
        // caches/subscriptions BEFORE the Client Context disposal;
        // wire.dispose() disposes Client first, Host additive fibers last.
        // Every step runs even when an earlier one throws; the first error
        // surfaces with the rest on its cause chain.
        const errors = [
          ...await collectDisposeErrors(() => clientUi.dispose()),
          ...await collectDisposeErrors(() => presentation.task.dispose()),
          ...await collectDisposeErrors(() => backendRuntime.dispose()),
          ...await collectDisposeErrors(() => wire.dispose()),
        ]
        if (errors.length > 0) throwAggregated(errors, 'remote application runtime transport disposal')
      },
    },
    wire,
    backendRuntime,
    presentation,
    clientUi,
  }
}
