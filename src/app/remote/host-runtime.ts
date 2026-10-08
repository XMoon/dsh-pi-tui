/**
 * Experimental Remote-serving Host composition (M3-1).
 *
 * This module owns ONLY the additive Host rows of the Remote runtime: the
 * package's single private Typert contribution, the private
 * `piTuiFileReferences` augmentation row, the private `piTuiTerminalProgress`
 * status row plus the exact official Remote Host composition closure. It receives the already-running ordinary
 * pi-tui Host `Context`, mounts everything as tracked Cordis fibers, and
 * exposes the narrow in-process carrier that `client-runtime.ts` installs as
 * the Client Connection transport.
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
import { PiTuiFileReferenceHostService, type FileReferencesServiceLike, type LiveAgentLike } from './pi-tui-file-reference-host.ts'
import { PiTuiTerminalProgressHostService, type LiveAgentLike as TerminalProgressLiveAgentLike } from './terminal-progress-host.ts'
import { PI_TUI_HOST_CONTRIBUTION } from '../../runtime/remote/pi-tui-remote-contribution.ts'

/**
 * Host services the ordinary Host Context must already expose before any M3
 * row mounts. The check fails fast with
 * the missing service named instead of parking the runtime.
 */
const HOST_PREREQUISITE_SERVICES = [
  'credentials',
  // The rc.2 user-questions service: `@deepseek-ai/dsh-base` already mounts
  // `id: user-questions -> @deepseek-ai/dsh-user-questions`, and this bundle
  // layers ON TOP of that base without disabling it, so the M3 composition
  // must REUSE the existing service (its TypertRemoteService binding publishes
  // the `userQuestions` namespace and registers the `userQuestions` Session
  // projection every Client reads). Mounting a second one would double-register
  // the namespace and duplicate the projection unit.
  'userQuestions',
  'typert',
  'typertGateway',
  'agents',
  'agentDefaultModel',
  'attachments',
  'commands',
  // The OFFICIAL `@`-file reference provider (the TUI composition mounts the
  // `file-reference-local` row): the private `piTuiFileReferences` bare route
  // delegates to it, so a Host without it could not serve a bare Session `@`
  // query at all. Required rather than silently degraded.
  'fileReferences',
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

/**
 * The narrow Host diagnostics channel the additive rows report through. It is
 * the runner's `Diag` shape declared structurally, so no application type
 * crosses into the Host composition; absent, the rows report through the
 * Host's own Cordis logger.
 */
export interface RemoteHostDiagnostics {
  warn(message: string, fields?: Record<string, unknown>): void
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
export async function createRemoteHostRuntime(
  hostContext: Context,
  options: { readonly diag?: RemoteHostDiagnostics } = {},
): Promise<RemoteHostRuntime> {
  assertHostPrerequisites(hostContext)
  // An unknown upstream `turn/end.reason.kind` must never be dropped silently
  // and must never crash the Host: absent an injected channel the row reports
  // through this Host's own logger.
  const diag: RemoteHostDiagnostics = options.diag ?? {
    warn: (message, fields) => { hostContext.logger('remote-host').warn(message, fields) },
  }
  /** The live Agent of one session, read PER CALL through the authoritative
   *  Host registry (never a composition-time snapshot). */
  const liveAgentFor = (sessionId: string): unknown =>
    (hostContext.reflect.get('agents') as { get(id: string): unknown } | undefined)?.get(sessionId)
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
    // 0a. The package's ONE private Typert contribution: both descriptors
    //     (`piTuiFileReferences/list`, `piTuiTerminalProgress/watch`) are
    //     registered together because rc.2 admits exactly one contribution per
    //     package identity. Registered FIRST and in its own fiber, so every
    //     private endpoint is live before any Client can call it and is
    //     withdrawn with this runtime.
    const contributionFiber = hostContext.inject(['typert'], contributionCtx => {
      contributionCtx.effect(
        () => contributionCtx.typert.register(PI_TUI_HOST_CONTRIBUTION),
        'pi-tui-private-remote-host',
      )
    })
    fibers.push(contributionFiber)
    await contributionFiber
    // 0b. The private `piTuiFileReferences` Host service (TS8-HF1): the explicit
    //    `@`-completion augmentation. Mounted ahead of the carrier so the
    //    service binding is live before the first Client call. The composition
    //    resolves the two narrow Host facts it needs (the same reflect reads
    //    the prerequisite check above uses for base services).
    const fileReferenceFiber = hostContext.inject(PiTuiFileReferenceHostService.inject, pluginCtx => {
      new PiTuiFileReferenceHostService(pluginCtx, {
        // Both facts are read PER CALL: a replaced `agents` registry or
        // `fileReferences` provider must be observed, never a composition-time
        // snapshot (the same reflect idiom the prerequisite check above uses).
        agentFor: sessionId => liveAgentFor(sessionId) as LiveAgentLike | undefined,
        official: () => hostContext.reflect.get('fileReferences') as FileReferencesServiceLike | undefined,
      })
    })
    fibers.push(fileReferenceFiber)
    await fileReferenceFiber
    // 0c. The private `piTuiTerminalProgress` Host service (plan R2 §6): the
    //     Remote branch's ONLY terminal-outcome authority. It observes the
    //     durable turn boundaries and the live Agent status of this Host with
    //     the SHARED interval fold and serves them over the private stream.
    const terminalProgressFiber = hostContext.inject(PiTuiTerminalProgressHostService.inject, pluginCtx => {
      new PiTuiTerminalProgressHostService(pluginCtx, {
        agentFor: sessionId => liveAgentFor(sessionId) as TerminalProgressLiveAgentLike | undefined,
        onUnknownReason: kind => {
          diag.warn('terminal progress: unknown turn/end reason', { kind })
        },
      })
    })
    fibers.push(terminalProgressFiber)
    await terminalProgressFiber
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
