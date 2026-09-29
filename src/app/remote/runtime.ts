/**
 * M3-1 experimental Remote runtime composition owner.
 *
 * The only app-level module that joins the Host-side and Client-side Remote
 * runtimes, in the frozen order:
 *
 * ```text
 * caller Host prerequisites
 *   -> Remote Host composition (additive official rows)
 *   -> Client composition (official wire over the in-process carrier)
 * ```
 *
 * It knows nothing about `TuiApp`, surfaces, `SessionOwnerRef`, the semantic
 * `Backend`, commands, or submission. M3-1 has no production bootstrap call
 * site; the only sanctioned way to reach this module is the lazy
 * `runtime/backend-loader.ts` boundary, and tests may construct it directly.
 *
 * @module app/remote/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Backend } from '../../runtime/backend.ts'
import type { RemotePromptSerializer } from '../../runtime/remote/session-writer-remote.ts'
import { RemoteConfigPort, type RemoteConfigRuntimeSource } from '../../runtime/remote/config-remote.ts'
import { RemoteSessionArchive } from '../../runtime/remote/session-archive-remote.ts'
import { createRemoteBackend } from '../../runtime/remote/backend-remote.ts'
import { createRemoteClientRuntime, type RemoteClientRuntime } from './client-runtime.ts'
import { createRemoteHostRuntime, mergeCause, type InProcessHostCarrier, type RemoteHostRuntime } from './host-runtime.ts'
import { createRemoteM3ASemantics, remoteM3ARuntimeSourceOf, type RemoteM3ASemantics } from './m3a-semantics.ts'

/**
 * Run one disposal step with per-step error isolation: the step's failures
 * are collected (never thrown here) so the remaining cleanup steps always
 * run. Returns every collected error.
 */
async function collectDisposeErrors(dispose: () => Promise<void> | void): Promise<unknown[]> {
  try {
    await dispose()
  } catch (error) {
    return [error]
  }
  return []
}

/** Start input for the experimental Remote runtime. */
export interface ExperimentalRemoteRuntimeOptions {
  /** The already-running ordinary pi-tui Host Context (never disposed here). */
  readonly hostContext: Context
  /** Host bootstrap prerequisite barrier owned by the caller (M3-0 ordering contract). */
  readonly waitForHostPrerequisites: () => Promise<void>
  /** Lifecycle signal observed between the Host prerequisite and composition. */
  readonly signal?: AbortSignal
}

/** The joined experimental Remote runtime. Not exported from the package root. */
export interface ExperimentalRemoteRuntime {
  readonly host: RemoteHostRuntime
  readonly client: RemoteClientRuntime
  /** Dispose the Client first, then the Host additive fibers. Idempotent. */
  dispose(): Promise<void>
}

/**
 * Start the experimental Remote runtime: wait for the caller's Host
 * prerequisites (the M3-0 `legacy settings migration -> Remote Host
 * composition -> Client readiness` ordering contract), compose the Host
 * rows, then compose the Client over the Host carrier.
 *
 * Failure semantics: a Host construction failure unwinds the partial Host
 * fibers and no Client Context is created; a Client construction failure
 * unwinds the partial Client, disposes the Host runtime, and rethrows the
 * original error.
 */
export async function createExperimentalRemoteRuntime(
  options: ExperimentalRemoteRuntimeOptions,
): Promise<ExperimentalRemoteRuntime> {
  await options.waitForHostPrerequisites()
  options.signal?.throwIfAborted()

  const host = await createRemoteHostRuntime(options.hostContext)
  let client: RemoteClientRuntime
  try {
    client = await createRemoteClientRuntime({ carrier: host.carrier, signal: options.signal })
  } catch (error) {
    // §17.3: rethrow the original Client failure. A Host disposal failure
    // must not mask it — the causes aggregate instead.
    const disposeErrors = await collectDisposeErrors(() => host.dispose())
    if (disposeErrors.length > 0) {
      const secondary = disposeErrors.length === 1
        ? disposeErrors[0]
        : new AggregateError(disposeErrors, 'remote runtime: host disposal failures during client-failure unwind')
      throw mergeCause(error instanceof Error ? error : new Error(String(error)), secondary)
    }
    throw error
  }

  let disposed = false
  return {
    host,
    client,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      // Client first, then Host — both run even if the first throws; the
      // first collected error surfaces with the second attached as cause.
      const errors = [
        ...await collectDisposeErrors(() => client.dispose()),
        ...await collectDisposeErrors(() => host.dispose()),
      ]
      if (errors.length > 0) {
        const failure = errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]))
        if (errors.length > 1) {
          mergeCause(failure, new AggregateError(errors.slice(1), 'remote runtime: remaining disposal failures'))
        }
        throw failure
      }
    },
  }
}

/** Compile-time proof that the ONE M3-1 Client runtime satisfies the Remote
 *  ConfigPort's narrow source face (never called; referenced by the
 *  official-contract gate). */
export function remoteConfigRuntimeSourceOf(runtime: RemoteClientRuntime): RemoteConfigRuntimeSource {
  return runtime
}

/** Inputs for the complete experimental Remote `Backend` assembly. */
export interface RemoteBackendRuntimeOptions {
  /** The ONE M3-1 Client runtime every adapter shares. */
  readonly runtime: RemoteClientRuntime
  /** The application-owned prompt serializer (the D2.2 writer dependency). */
  readonly promptSerializer: RemotePromptSerializer
  /** The composition-owned fetch the archive adapter addresses. */
  readonly fetch: InProcessHostCarrier['fetch']
}

/** The complete experimental Remote `Backend` plus its disposal owner. */
export interface RemoteBackendRuntime {
  readonly backend: Backend
  readonly semantics: RemoteM3ASemantics
  /** Drop adapter-owned caches/subscriptions. Runs BEFORE the Client
   *  Context disposal (`RemoteClientRuntime.dispose()`). Idempotent. */
  dispose(): void
}

/**
 * Assemble the complete experimental Remote `Backend` (M3-3B) from ONE M3-1
 * Client runtime: the M3-3A semantic bundle (session/runtime/catalog/host-file
 * + the M3-3B interaction and Plugin Manager/Job-observation adapters), the
 * Remote ConfigPort mirror, and the Remote session archive. It is NOT a
 * production cutover: normal startup still selects Direct.
 */
export function createRemoteBackendRuntime(options: RemoteBackendRuntimeOptions): RemoteBackendRuntime {
  const semantics = createRemoteM3ASemantics(remoteM3ARuntimeSourceOf(options.runtime), {
    promptSerializer: options.promptSerializer,
  })
  const config = new RemoteConfigPort(remoteConfigRuntimeSourceOf(options.runtime))
  const sessionArchive = new RemoteSessionArchive({ fetch: options.fetch })
  let disposed = false
  return {
    backend: createRemoteBackend({ ...semantics, config, sessionArchive }),
    semantics,
    dispose(): void {
      if (disposed) return
      disposed = true
      semantics.dispose()
      config.dispose()
    },
  }
}
