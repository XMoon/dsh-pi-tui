/**
 * The ONE Client-root interaction delivery owner for the split Client.
 *
 * The official Host Gateway forwards `user-questions/request` and
 * `approval/request` waterfalls to whichever authenticated Client currently
 * owns the Agent scope. The split Client must have exactly ONE listener pair
 * registered for the whole Client root: mounting a pair per surface revision
 * would (a) race the official event pump at startup and (b) let an HMR-retired
 * revision keep a stale answerer alive beside the new one.
 *
 * This owner therefore owns exactly:
 *
 * - the two official `remote.$on` registrations (once per Client root);
 * - the CURRENT surface revision's two presentation providers;
 * - an abort-aware wait for the current surface when a forwarded request
 *   arrives before the first revision has attached.
 *
 * It deliberately owns NO Host pending copy, no event-id map and no second
 * RPC: each official invocation is held only by its own async closure and is
 * settled through the SAME official `next`/return value the gateway supplied.
 * A local surface detach is not a Host decision: a result produced by a
 * revision that has already been detached is discarded while the official
 * request signal is still live, and a replacement revision takes over the
 * SAME invocation.
 *
 * @module app/remote-process/client-interaction-delivery
 */

import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type {
  ApprovalRequestLike,
  ApprovalRequestListener,
  QuestionRequestView,
  UserQuestionProvider,
} from '../../runtime/interaction-port.ts'
import type {
  SplitClientInteractionDelivery,
  SplitClientSurfaceInteraction,
} from '../../runtime/remote/interaction-remote.ts'
import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'

export type { SplitClientInteractionDelivery } from '../../runtime/remote/interaction-remote.ts'

/** The Client-root interaction delivery implementation adds its own dispose. */
export interface SplitClientInteractionDeliveryOwner extends SplitClientInteractionDelivery {
  /** Remove both official listeners and drop the local surface references. */
  dispose(): void
}

/** One forwarded question request as the official gateway materializes it. */
interface ForwardedQuestionRequest {
  readonly questions: QuestionRequestView['questions']
  readonly wait?: { readonly callId?: unknown; readonly timed?: unknown }
  readonly signal?: AbortSignal
}

/** One forwarded approval request as the official gateway materializes it. */
interface ForwardedApprovalRequest {
  readonly signal?: AbortSignal
  readonly callId?: string
  readonly toolName: string
  readonly reason?: string
}

/** The narrow official-event seat this owner consumes. */
export interface SplitClientInteractionEventsSource {
  $on(
    event: 'user-questions/request',
    listener: (
      this: unknown,
      request: ForwardedQuestionRequest,
      next: () => Promise<AskUserQuestionAnswer>,
    ) => Promise<AskUserQuestionAnswer>,
  ): () => void
  $on(
    event: 'approval/request',
    listener: (this: unknown, request: ForwardedApprovalRequest, next: unknown) => unknown,
  ): () => void
}

/** The official Client Sessions scope face. */
export interface SplitClientInteractionSessionsSource {
  scopeOf(owner: unknown): string | undefined
}

export interface SplitClientInteractionDeliveryOptions {
  readonly remote: SplitClientInteractionEventsSource
  readonly sessions: SplitClientInteractionSessionsSource
}

interface SurfaceAttachment extends SplitClientSurfaceInteraction {
  readonly revision: number
}

/** Wrap a waterfall `next` so one official invocation delegates AT MOST once. */
function onceNext<T>(next: () => T): () => T {
  let called = false
  let result: T
  return () => {
    if (!called) {
      called = true
      result = next()
    }
    return result
  }
}

/** Build one abort error without inventing a Host decision. */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new Error('client interaction delivery: the request lifetime ended before a surface answered')
}

/**
 * Create the ONE root interaction delivery owner over the official Client
 * Remote event seat. The caller must have mounted the official Session client
 * (the Agent scope resolver) before the official event pump can start.
 */
export function createSplitClientInteractionDelivery(
  options: SplitClientInteractionDeliveryOptions,
): SplitClientInteractionDeliveryOwner {
  let current: SurfaceAttachment | undefined
  let disposed = false
  const surfaceWaiters = new Set<() => void>()
  const owned: Array<() => void> = []

  const notifySurfaceWaiters = (): void => {
    for (const waiter of [...surfaceWaiters]) {
      surfaceWaiters.delete(waiter)
      waiter()
    }
  }

  /** Wait for the current surface attachment or the official request abort. */
  const waitForSurface = async (signal: AbortSignal | undefined): Promise<SurfaceAttachment> => {
    if (current !== undefined) return current
    if (signal?.aborted === true) throw abortReason(signal)
    return await new Promise<SurfaceAttachment>((resolve, reject) => {
      const cleanup = (): void => {
        surfaceWaiters.delete(onSurface)
        signal?.removeEventListener('abort', onAbort)
      }
      const onSurface = (): void => {
        if (current === undefined) return
        cleanup()
        resolve(current)
      }
      const onAbort = (): void => {
        cleanup()
        reject(abortReason(signal))
      }
      surfaceWaiters.add(onSurface)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  const deliverQuestion = async function (
    this: unknown,
    request: ForwardedQuestionRequest,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    // The official Agent scope is the ONLY Session identity source. A request
    // whose owner cannot be resolved follows the official fail-closed path.
    const sessionId = options.sessions.scopeOf(this)
    if (sessionId === undefined) return next()
    const callId = request.wait?.callId
    const view: QuestionRequestView = {
      sessionId,
      callId: typeof callId === 'string' ? callId : undefined,
      timed: request.wait?.timed === true,
      questions: request.questions,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }
    const nextOnce = onceNext(next)
    for (;;) {
      const attachment = await waitForSurface(request.signal)
      try {
        const result = await attachment.onQuestion(view, nextOnce)
        if (current === attachment) return result
        if (request.signal?.aborted === true) return result
      } catch (error) {
        if (current === attachment) throw error
        if (request.signal?.aborted === true) throw error
      }
    }
  }

  const deliverApproval = async function (
    this: unknown,
    request: ForwardedApprovalRequest,
    next: unknown,
  ): Promise<unknown> {
    const sessionId = options.sessions.scopeOf(this)
    if (sessionId === undefined) return (next as () => unknown)()
    const view: ApprovalRequestLike = {
      toolName: request.toolName,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      ...(request.callId === undefined ? {} : { callId: request.callId }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
      sessionId,
    }
    const nextOnce = onceNext(next as () => unknown)
    for (;;) {
      const attachment = await waitForSurface(request.signal)
      try {
        const result = await attachment.onApproval(view, nextOnce)
        if (current === attachment) return result
        if (request.signal?.aborted === true) return result
      } catch (error) {
        if (current === attachment) throw error
        if (request.signal?.aborted === true) throw error
      }
    }
  }

  owned.push(options.remote.$on('user-questions/request', deliverQuestion))
  owned.push(options.remote.$on('approval/request', deliverApproval))

  return {
    attachSurface(revision, input): () => void {
      if (disposed) throw new Error('client interaction delivery: disposed')
      const attachment: SurfaceAttachment = { revision, ...input }
      current = attachment
      notifySurfaceWaiters()
      return () => {
        if (current !== attachment) return
        current = undefined
      }
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      current = undefined
      runSyncDisposalSteps('client interaction delivery disposal', [
        ...owned.splice(0).map(off => () => { off() }),
      ])
    },
  }
}
