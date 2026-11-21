/**
 * TEST_ONLY_M3_CARRIER: the retired M3 in-process official Client runtime.
 *
 * It composes its OWN official Client `Context` over the in-process carrier
 * (`test/support/m3-inprocess/host-runtime.ts`) and reuses the PRODUCTION
 * shared Domain mount (`mountRemoteClientDomains` from
 * `src/app/remote/client-runtime.ts`), so the official Client plugin order,
 * `/remote` contributions and readiness semantics stay one implementation.
 *
 * Kept ONLY for the historical L5/L6 suites. It must never be imported by
 * `src/**`, never enter the published `dist` graph, and never be treated as a
 * production Client/Writer/Gateway owner.
 *
 * @module test/support/m3-inprocess/client-runtime
 */

import { Context, type Fiber } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { IJobs } from '@deepseek-ai/dsh-api-job-controller/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  loadOfficialClientModulesOnce,
  mountRemoteClientDomains,
  type MountedRemoteClientDomains,
} from '../../../src/app/remote/client-runtime.ts'
import { mergeCause } from '../../../src/app/remote/dispose-cause.ts'
import type { InProcessHostCarrier } from './host-runtime.ts'

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

