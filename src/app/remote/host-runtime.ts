/**
 * Experimental Remote-serving Host additive composition (M3-1).
 *
 * M3-ONLY. The production M4 Host composition is the built-in
 * `@xmoon76/dsh-pi-tui/host-runtime` Loader row plus the official
 * Session-serving rows in the Host-only overlay; this module is retained only
 * for the old in-process L5 fixtures and is deleted with B2-S.
 *
 * This module owns ONLY the M3-only additive official rows of the Remote
 * runtime: the official Connection/FileUpload/stats/outline/SessionController/
 * SettingsController/api-remotes/archive closure. It receives the
 * already-running ordinary pi-tui Host `Context` and exposes the narrow
 * in-process carrier that `client-runtime.ts` installs as the Client
 * Connection transport.
 *
 * The private PiFile/TerminalProgress services, their package contribution and
 * the Performance projection are NOT mounted here: the caller must have mounted
 * the built-in PiTui Host Runtime (and the Performance row) first, and this
 * function only verifies their readiness gates exist.
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
import { mergeCause } from './dispose-cause.ts'
import { assertRemoteHostPrerequisites } from './host-prerequisites.ts'

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

/**
 * The M3-only additive Host-side Remote runtime.
 */
export interface RemoteHostRuntime {
  /** The ordinary Host Context this composition mounted onto (never disposed here). */
  readonly hostContext: Context
  /** In-process carrier for the Client Connection transport. */
  readonly carrier: InProcessHostCarrier
  /** Reverse-dispose exactly the fibers this runtime created. Idempotent. */
  dispose(): Promise<void>
}

async function* emptyUplink(): AsyncIterable<unknown> {}

function firstError(errors: readonly unknown[]): Error {
  return errors[0] instanceof Error ? errors[0] : new Error(String(errors[0]))
}

/** Build the in-process carrier over the Host connection + gateway seams.
 *
 * The carrier speaks for the Host Connection's OWN owner Peer
 * (`HostConnectionService.browserPeer`, created inside the service constructor
 * with `principal: { kind: 'owner' }` and disposed by the Connection plugin
 * fiber). The SAME reference is passed to the shared Fetch handler and to
 * `wireStream.open`, so one identity — and one lifetime — covers both the
 * unary and the streaming path; the carrier never creates, caches, or disposes
 * a Peer of its own. */
function createInProcessCarrier(hostContext: Context): InProcessHostCarrier {
  const connection = hostContext.connection
  const peer = connection.browserPeer
  const shared = connection.createSharedFetchHandler('/api')
  const gateway: TypertGateway = hostContext.typertGateway
  return {
    ownsHost: true,
    fetch(input, init) {
      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(new URL(String(input), IN_PROCESS_BASE_URL), init)
      return shared.fetch(request, peer)
    },
    openStream(endpoint, payload, signal, uplink) {
      return (async function* () {
        yield* await gateway.wireStream.open(endpoint, payload, uplink ?? emptyUplink(), peer, signal)
      })()
    },
  }
}

/**
 * Mount the exact M3-only additive official Host closure onto the existing Host
 * Context and await every fiber. The caller must already have mounted the
 * built-in PiTui Host Runtime (private services + readiness) and the
 * Performance projection row exactly once; this function verifies both
 * readiness gates and then mounts only the M3-only official additive fibers.
 *
 * The existing `jobController`/`userQuestions` services are asserted before and
 * after construction and never re-mounted.
 *
 * On a partial construction failure the already-mounted fibers unwind in
 * reverse order before the original error rethrows.
 */
export async function createRemoteHostRuntime(hostContext: Context): Promise<RemoteHostRuntime> {
  assertRemoteHostPrerequisites(hostContext)
  // M3-ONLY: the private services/contribution and Performance belong to the
  // built-in PiTui Host Runtime / Performance row mounted by the caller's
  // fixture or Profile. Never silently mount a second copy here (B2-S deletes
  // this whole M3-only composition).
  for (const service of ['piTuiHostReady', 'piTuiFileReferences', 'piTuiTerminalProgress', 'piTuiPerformanceReady'] as const) {
    if (hostContext.reflect.get(service) === undefined) {
      throw new Error(
        `remote host runtime: the M3 composition requires the mounted PiTui Host Runtime and Performance row; missing "${service}"`,
      )
    }
  }
  const jobControllerBefore = hostContext.reflect.get('jobController') as { typertRemote?: unknown }
  const userQuestionsBefore = hostContext.reflect.get('userQuestions') as { typertRemote?: unknown }

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
    // 3. Whole-log projection units before the Session controller.
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
    // The user-questions service is REUSED, never re-mounted: its stable Typert
    // binding must be the very same one the caller had before this composition
    // (a second mount would replace the namespace owner and duplicate the
    // projection unit).
    const userQuestionsAfter = hostContext.reflect.get('userQuestions') as { typertRemote?: unknown } | undefined
    if (
      userQuestionsAfter === undefined
      || userQuestionsAfter.typertRemote === undefined
      || userQuestionsAfter.typertRemote !== userQuestionsBefore?.typertRemote
    ) {
      throw new Error('remote host runtime: the existing userQuestions service was replaced by the M3 composition')
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
