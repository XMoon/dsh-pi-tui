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
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
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
 * Attach one secondary failure to `failure`'s cause chain without losing an
 * existing cause: when the failure already carries a cause, both aggregate
 * into a single `AggregateError`. Shared by the three composition owners so
 * cleanup failures never mask the original construction/readiness error.
 * A `undefined` secondary is a no-op (nothing to attach).
 */
export function mergeCause(failure: Error, secondary: unknown): Error {
  if (secondary === undefined) return failure
  const existingCause = (failure as { cause?: unknown }).cause
  ;(failure as { cause?: unknown }).cause = existingCause === undefined
    ? secondary
    : new AggregateError([existingCause, secondary], 'remote composition: aggregated failure causes')
  return failure
}

function firstError(errors: readonly unknown[]): Error {
  return errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]))
}

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
  let carrier: InProcessHostCarrier | undefined
  let disposed = false
  /**
   * Reverse-dispose every mounted fiber. Per-step error isolation: one
   * rejecting disposer cannot truncate the remaining cleanup. Returns the
   * collected disposal errors instead of throwing, so the construction
   * failure path can rethrow the ORIGINAL error with the cleanup failures
   * attached as its `cause`.
   */
  const collectUnwind = async (): Promise<unknown[]> => {
    const errors: unknown[] = []
    for (let index = fibers.length - 1; index >= 0; index -= 1) {
      try {
        await fibers[index].dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    fibers.length = 0
    return errors
  }

  try {
    // 1. Host connection — provides `connection` for the in-process carrier.
    //    No HTTP surface is composed, so the row's browser-authentication
    //    side is deliberately absent (the proven in-process fixture form);
    //    the M3-4 product bootstrap owns the server-backed composition.
    const connFiber = hostContext.plugin(connectionContext => {
      new HostConnectionService(connectionContext, [], {} as never)
    })
    fibers.push(connFiber)
    await connFiber
    // 2. Real Host file uploads - the Session controller injects `fileUploads`.
    const uploadFiber = hostContext.plugin(FileUploads)
    fibers.push(uploadFiber)
    await uploadFiber
    // 3./4. Whole-log projection units before the Session controller.
    const statsFiber = hostContext.plugin(sessionStats)
    fibers.push(statsFiber)
    await statsFiber
    const outlineFiber = hostContext.plugin(sessionTurnOutline)
    fibers.push(outlineFiber)
    await outlineFiber
    // 5. Session controller - M3/local-wire-safe: never native desktop open.
    const sessionCtrlFiber = hostContext.inject(SessionController.inject, controllerContext => {
      new SessionController(controllerContext, { nativeOpen: false })
    })
    fibers.push(sessionCtrlFiber)
    await sessionCtrlFiber
    // 6. Settings + credentials Remote owner.
    const settingsFiber = hostContext.plugin(SettingsController)
    fibers.push(settingsFiber)
    await settingsFiber
    // 6b. The rc.2 user-questions service (M3-3B): its TypertRemoteService
    //     binding publishes the `userQuestions` namespace over the gateway and
    //     registers the `userQuestions` Session projection every Client reads.
    //     `agents`/`sessionProjections` are asserted Host prerequisites above.
    const userQuestionsFiber = hostContext.plugin(UserQuestionService)
    fibers.push(userQuestionsFiber)
    await userQuestionsFiber
    // 7. Forwarded-event source over the existing gateway.
    const remotesFiber = hostContext.plugin({ inject: apiRemotesInject, apply: applyApiRemotes })
    fibers.push(remotesFiber)
    await remotesFiber
    // 8. Archive route - registers `/api/session.export` on Host `connection.fetch`.
    const exportFiber = hostContext.plugin(sessionLogExport)
    fibers.push(exportFiber)
    await exportFiber


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
      throw new Error('remote host runtime: the existing jobController service was replaced by the M3 composition')
    }

    // The carrier is part of construction: a failure here must unwind the
    // mounted fibers exactly like a failed mount.
    carrier = createInProcessCarrier(hostContext)
  } catch (error) {
    // §17.3: rethrow the ORIGINAL construction error; any disposal failures
    // ride its `cause` chain instead of masking it.
    const disposeErrors = await collectUnwind()
    if (disposeErrors.length > 0) {
      const secondary = disposeErrors.length === 1
        ? disposeErrors[0]
        : new AggregateError(disposeErrors, 'remote host runtime: unwind disposal failures')
      throw mergeCause(error instanceof Error ? error : new Error(String(error)), secondary)
    }
    throw error
  }

  return {
    hostContext,
    carrier,
    async dispose(): Promise<void> {
      if (disposed) return
      disposed = true
      const disposeErrors = await collectUnwind()
      if (disposeErrors.length > 0) {
        const failure = disposeErrors[0] instanceof Error
          ? disposeErrors[0]
          : new Error(String(disposeErrors[0]))
        if (disposeErrors.length > 1) {
          mergeCause(failure, new AggregateError(disposeErrors.slice(1), 'remote host runtime: remaining disposal failures'))
        }
        throw failure
      }
    },
  }
}
