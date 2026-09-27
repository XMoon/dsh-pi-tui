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
import { createRemoteClientRuntime, type RemoteClientRuntime } from './client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from './host-runtime.ts'

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
    await host.dispose()
    throw error
  }

  let disposed = false
  return {
    host,
    client,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      await client.dispose()
      await host.dispose()
    },
  }
}
