/**
 * TEST_ONLY_M3_CARRIER: the retired M3 in-process Remote runtime joiner.
 *
 * It joined the M3 Host additive rows and the M3 Client runtime over the
 * in-process carrier. It is kept ONLY as the transport-neutral L5/L6 fixture
 * carrier; production code cannot import it, and it never enters the published
 * bundle or any Host/Client/Writer authority.
 *
 * @module test/support/m3-inprocess/runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import { mergeCause } from '../../../src/app/remote/dispose-cause.ts'
import { createRemoteClientRuntime, type RemoteClientRuntime } from './client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from './host-runtime.ts'

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

