/**
 * Experimental Remote-serving Host composition (M3-1).
 *
 * This module owns ONLY the additive official Host rows of the Remote
 * runtime: it receives the already-running ordinary pi-tui Host `Context`,
 * mounts the exact `docs/m3-entry-contract.md` §2.4.1 closure as tracked
 * Cordis fibers, and exposes the narrow in-process carrier that
 * `client-runtime.ts` installs as the Client Connection transport.
 *
 * It does not boot a second Host Context, does not edit or emulate
 * `cordis.patch.yml`, and never touches the existing `jobController` row.
 * After disposal the Host Context is exactly as it was before.
 *
 * The composition is experimental and non-product in M3-1: structural
 * composition errors fail fast with a diagnostic naming the missing piece.
 *
 * @module app/remote/host-runtime
 */

import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { TypertGateway } from '@deepseek-ai/dsh-api-gateway'
import SessionController from '@deepseek-ai/dsh-api-session-controller'
import { apply as applyApiRemotes, inject as apiRemotesInject } from '@deepseek-ai/dsh-api-remotes'
import SettingsController from '@deepseek-ai/dsh-api-settings-controller'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import * as sessionLogExport from '@deepseek-ai/dsh-session-log-export'
import * as sessionStats from '@deepseek-ai/dsh-session-stats'
import * as sessionTurnOutline from '@deepseek-ai/dsh-session-turn-outline'

/**
 * Host services the ordinary Host Context must already expose before any M3
 * row mounts (`docs/m3-entry-contract.md` §2.4.1). The check fails fast with
 * the missing service named instead of parking the runtime.
 */
const HOST_PREREQUISITE_SERVICES = [
  'credentials',
  'typert',
  'typertGateway',
  'agents',
  'agentDefaultModel',
  'attachments',
  'commands',
  'fs',
  'llm',
  'sessions',
  'sessionProjections',
  'sessionQuery',
  'workspaceRegistry',
  'jobController',
] as const

/**
 * Fixed private base URL used only to construct valid `Request` objects for
 * the shared Fetch handler. It is not a global location, a server URL, a TCP
 * listener, or an authentication surface.
 */
const IN_PROCESS_BASE_URL = 'http://dsh-pi-tui-remote.in-process/'

/** Explicit in-process transport hooks carried from the Host to the Client. */
export interface InProcessHostCarrier {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>
  openStream(
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
  ): AsyncIterable<unknown>
  readonly ownsHost: true
}

/** The composed additive Host-side Remote runtime. */
export interface RemoteHostRuntime {
  /** The ordinary Host Context this composition mounted onto (never disposed here). */
  readonly hostContext: Context
  /** In-process carrier for the Client Connection transport. */
  readonly carrier: InProcessHostCarrier
  /** Reverse-dispose exactly the fibers this runtime created. Idempotent. */
  dispose(): Promise<void>
}

async function* emptyUplink(): AsyncIterable<unknown> {}

/**
 * Fail fast when the ordinary Host lacks one of the required base services.
 * Reads via the reflect store so the diagnostic can name the missing key
 * without depending on any one service's shape.
 */
function assertHostPrerequisites(hostContext: Context): void {
  for (const service of HOST_PREREQUISITE_SERVICES) {
    if (hostContext.reflect.get(service) === undefined) {
      throw new Error(`remote host runtime: the Host Context is missing the required "${service}" service`)
    }
  }
}

/** Build the in-process carrier over the Host connection + gateway seams. */
function createInProcessCarrier(hostContext: Context): InProcessHostCarrier {
  const shared = hostContext.connection.createSharedFetchHandler('/api')
  const gateway: TypertGateway = hostContext.typertGateway
  return {
    ownsHost: true,
    fetch(input, init) {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), IN_PROCESS_BASE_URL), init)
      return shared.fetch(request)
    },
    openStream(endpoint, payload, signal, uplink) {
      return (async function* () {
        yield* await gateway.wireStream.open(endpoint, payload, uplink ?? emptyUplink(), undefined, signal)
      })()
    },
  }
}

/**
 * Mount the exact additive official Host closure (§2.4.1) onto the existing
 * Host Context and await every fiber. The existing `jobController` service is
 * asserted before and after construction and never re-mounted.
 *
 * On a partial construction failure the already-mounted fibers unwind in
 * reverse order before the original error rethrows.
 */
export async function createRemoteHostRuntime(hostContext: Context): Promise<RemoteHostRuntime> {
  assertHostPrerequisites(hostContext)
  const jobControllerBefore = hostContext.reflect.get('jobController') as { typertRemote?: unknown }

  const fibers: Fiber[] = []
  let disposed = false
  const unwind = async (): Promise<void> => {
    disposed = true
    for (let index = fibers.length - 1; index >= 0; index -= 1) {
      await fibers[index].dispose()
    }
  }

  try {
    // 1. Host connection — provides `connection` for the in-process carrier.
    //    No HTTP surface is composed, so the row's browser-authentication
    //    side is deliberately absent (the proven in-process fixture form);
    //    the M3-4 product bootstrap owns the server-backed composition.
    fibers.push(await hostContext.plugin(connectionContext => {
      new HostConnectionService(connectionContext, [], {} as never)
    }))
    // 2. Real Host file uploads — the Session controller injects `fileUploads`.
    fibers.push(await hostContext.plugin(FileUploads))
    // 3./4. Whole-log projection units before the Session controller.
    fibers.push(await hostContext.plugin(sessionStats))
    fibers.push(await hostContext.plugin(sessionTurnOutline))
    // 5. Session controller — M3/local-wire-safe: never native desktop open.
    fibers.push(await hostContext.inject(SessionController.inject, controllerContext => {
      new SessionController(controllerContext, { nativeOpen: false })
    }))
    // 6. Settings + credentials Remote owner.
    fibers.push(await hostContext.plugin(SettingsController))
    // 7. Forwarded-event source over the existing gateway.
    fibers.push(await hostContext.plugin({ inject: apiRemotesInject, apply: applyApiRemotes }))
    // 8. Archive route — registers `/api/session.export` on Host `connection.fetch`.
    fibers.push(await hostContext.plugin(sessionLogExport))
  } catch (error) {
    await unwind()
    throw error
  }

  // The Cordis reflect read wraps services in a per-call traceable proxy, so
  // the same-instance check compares the service's stable Typert binding
  // (never re-mounted, never replaced) instead of proxy identity.
  const jobControllerAfter = hostContext.reflect.get('jobController') as
    { typertRemote?: unknown } | undefined
  if (
    jobControllerAfter === undefined
    || jobControllerAfter.typertRemote === undefined
    || jobControllerAfter.typertRemote !== jobControllerBefore.typertRemote
  ) {
    await unwind()
    throw new Error('remote host runtime: the existing jobController service was replaced by the M3 composition')
  }

  return {
    hostContext,
    carrier: createInProcessCarrier(hostContext),
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      for (let index = fibers.length - 1; index >= 0; index -= 1) {
        await fibers[index].dispose()
      }
    },
  }
}
