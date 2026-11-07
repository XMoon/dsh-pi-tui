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
 *   arrives before the first revision has attached;
 * - the CURRENT committed Session binding of the application that hosts the
 *   surface, and a presentation-only navigation hold.
 *
 * It deliberately owns NO Host pending copy, no event-id map and no second
 * RPC: each official invocation is held only by its own async closure and is
 * settled through the SAME official `next`/return value the gateway supplied.
 * A local surface detach is not a Host decision: a result produced by a
 * revision that has already been detached is discarded while the official
 * request signal is still live, and a replacement revision takes over the
 * SAME invocation.
 *
 * Navigation-first admission is the SAME rule: a forwarded request is only
 * handed to a surface while the application has committed exactly the Session
 * that owns the request and no navigation hold is active. A local withdrawal
 * (the navigation hold, or a session subject change) invalidates the
 * presentation epoch, so its local cancellation can never be forwarded as a
 * human Host decision; the same official invocation is re-presented when its
 * Session becomes admissible again.
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
  ForwardedAnswerEligibility,
  NavigationHoldRelease,
  SplitClientInteractionDelivery,
  SplitClientSurfaceInteraction,
} from '../../runtime/remote/interaction-remote.ts'
import { runSyncDisposalSteps } from '../../runtime/process/disposal.ts'

export type { ForwardedAnswerEligibility, NavigationHoldRelease } from '../../runtime/remote/interaction-remote.ts'

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

/**
 * Race one provider result against the official request lifetime. A presenter
 * that never settles on local teardown must not keep the official Gateway's
 * delivery task alive; the abandoned provider promise gets a rejection
 * observer so its late settlement cannot become an unhandled rejection.
 */
function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) {
    promise.catch(() => {})
    return Promise.reject(abortReason(signal))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      promise.catch(() => {})
      reject(abortReason(signal))
    }
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

/** Build one abort error without inventing a Host decision. */
function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason
  if (reason instanceof Error) return reason
  return new Error('client interaction delivery: the request lifetime ended before a surface answered')
}

/** The root-disposal reason: no Host result is fabricated and no local cancel
 *  is forwarded after the owner is gone. */
function disposedReason(): Error {
  return new Error('client interaction delivery: disposed before the official request settled')
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
  /**
   * Marks every PRESENTATION attempt made before a navigation hold / committed
   * subject change as stale. This is a presentation fence only: it never
   * settles or answers the official invocation, and it survives a hold release
   * so a local cancellation produced by the withdrawal can never be mistaken
   * for a late human answer.
   */
  let presentationEpoch = 0
  let navigationHold: NavigationHoldRelease | undefined
  /** Wake-ups for a delivery wait (surface attach, subject change, hold, dispose). */
  const waiters = new Set<() => void>()
  /**
   * The committed-Session authority of the CURRENT surface revision's
   * application. `undefined` means "not bound yet": a forwarded request waits
   * rather than presenting into a surface that has no committed subject.
   */
  let committedSessionId: (() => string | undefined) | undefined
  let bindingToken: object | undefined
  let bindingDisposal: (() => void) | undefined
  /**
   * The official invocations this root currently holds. Each entry is created
   * by its own callback stack and removed when that SAME invocation settles,
   * aborts or the root disposes — never a Host pending copy.
   */
  const eligibleRequests = new Set<ForwardedAnswerEligibility>()
  const eligibilityListeners = new Set<() => void>()
  const rootLifetime = new AbortController()

  const wakeWaiters = (): void => {
    for (const waiter of [...waiters]) {
      waiters.delete(waiter)
      waiter()
    }
  }

  const notifyEligibility = (): void => {
    for (const listener of [...eligibilityListeners]) {
      try {
        listener()
      } catch {
        // A UI invalidation listener must never break the official delivery
        // owner; the next eligibility change re-invalidates it.
      }
    }
  }

  const addEligible = (sessionId: string, kind: 'question' | 'approval'): ForwardedAnswerEligibility => {
    const token: ForwardedAnswerEligibility = { sessionId, kind, live: true }
    eligibleRequests.add(token)
    notifyEligibility()
    return token
  }

  const removeEligible = (token: ForwardedAnswerEligibility): void => {
    if (eligibleRequests.delete(token)) notifyEligibility()
  }

  /** The combined official lifetime plus the root lifetime. */
  const lifetimeOf = (signal: AbortSignal | undefined): AbortSignal =>
    signal === undefined ? rootLifetime.signal : AbortSignal.any([signal, rootLifetime.signal])

  /**
   * Whether the application has committed exactly the request's Session.
   * An UNBOUND delivery is the legacy path (TSP split / a composition that
   * never installs the PiTUI split authority): it keeps the pre-G567 forward
   * behavior, and the surface's own admission still applies. The PiTUI split
   * runner binds BEFORE the surface's interaction providers attach.
   */
  const isCommittedSubject = (sessionId: string): boolean =>
    committedSessionId === undefined || committedSessionId() === sessionId

  /** Wake on any state change, then re-check admission. */
  const waitForWake = (lifetime: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
    if (lifetime.aborted) {
      reject(abortReason(lifetime))
      return
    }
    const cleanup = (): void => {
      waiters.delete(onWake)
      lifetime.removeEventListener('abort', onAbort)
    }
    const onWake = (): void => { cleanup(); resolve() }
    const onAbort = (): void => { cleanup(); reject(abortReason(lifetime)) }
    waiters.add(onWake)
    lifetime.addEventListener('abort', onAbort, { once: true })
  })

  /**
   * Wait until the ONE admissible presentation state holds: a surface is
   * attached, no navigation hold is active, and the request's own Session is
   * the committed subject. Aborts on the official request lifetime/root
   * disposal; it never settles the invocation itself.
   */
  const waitForAdmission = async (sessionId: string, lifetime: AbortSignal): Promise<void> => {
    for (;;) {
      if (disposed) throw disposedReason()
      if (lifetime.aborted) throw abortReason(lifetime)
      if (current !== undefined && navigationHold === undefined && isCommittedSubject(sessionId)) return
      await waitForWake(lifetime)
    }
  }

  /**
   * Run ONE presentation attempt of the SAME official invocation. A local
   * result is accepted only while the attempt still belongs to the CURRENT
   * attachment, the SAME presentation epoch, the SAME (absent) hold and the
   * request's committed Session; otherwise it is dropped and the loop waits for
   * the next admissible presentation. The official `next` is never called here.
   */
  const presentWhenAdmissible = async <T>(
    sessionId: string,
    requestSignal: AbortSignal | undefined,
    invoke: (attachment: SurfaceAttachment) => Promise<T> | T,
  ): Promise<T> => {
    const lifetime = lifetimeOf(requestSignal)
    for (;;) {
      await waitForAdmission(sessionId, lifetime)
      const attachment = current
      if (attachment === undefined) continue
      const hold = navigationHold
      const epoch = presentationEpoch
      let presentation: Promise<T>
      try {
        // Call the CURRENT provider synchronously after the admission check:
        // no extra microtask may let a session commit land between the proof
        // and the provider's own admission.
        presentation = Promise.resolve(invoke(attachment))
      } catch (error) {
        presentation = Promise.reject(error)
      }
      try {
        const result = await raceWithAbort(presentation, lifetime)
        if (current === attachment
          && navigationHold === hold
          && presentationEpoch === epoch
          && isCommittedSubject(sessionId)) {
          return result
        }
        if (lifetime.aborted) return result
      } catch (error) {
        if (lifetime.aborted) throw error
        if (current === attachment
          && navigationHold === hold
          && presentationEpoch === epoch
          && isCommittedSubject(sessionId)) {
          throw error
        }
      }
    }
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
    const eligible = addEligible(sessionId, 'question')
    try {
      return await presentWhenAdmissible(sessionId, request.signal, attachment => attachment.onQuestion(view, nextOnce))
    } finally {
      removeEligible(eligible)
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
    const eligible = addEligible(sessionId, 'approval')
    try {
      return await presentWhenAdmissible(sessionId, request.signal, attachment => attachment.onApproval(view, nextOnce))
    } finally {
      removeEligible(eligible)
    }
  }

  const owned: Array<() => void> = []
  owned.push(options.remote.$on('user-questions/request', deliverQuestion))
  owned.push(options.remote.$on('approval/request', deliverApproval))

  return {
    attachSurface(revision, input): () => void {
      if (disposed) throw new Error('client interaction delivery: disposed')
      const attachment: SurfaceAttachment = { revision, ...input }
      current = attachment
      wakeWaiters()
      return () => {
        if (current !== attachment) return
        current = undefined
        wakeWaiters()
      }
    },
    currentEligibleRequests(): readonly ForwardedAnswerEligibility[] {
      return [...eligibleRequests]
    },
    subscribeEligibility(listener): () => void {
      eligibilityListeners.add(listener)
      return () => { eligibilityListeners.delete(listener) }
    },
    bindCommittedSession(currentSessionId, subscribeCommittedSession): () => void {
      if (disposed) throw new Error('client interaction delivery: disposed')
      // A replacement surface revision REPLACES the previous binding; only the
      // newest binding may wake waiters or clear the subject authority.
      bindingDisposal?.()
      bindingDisposal = undefined
      bindingToken = undefined
      committedSessionId = undefined
      const token = {}
      const off = subscribeCommittedSession(() => {
        if (bindingToken !== token) return
        presentationEpoch += 1
        wakeWaiters()
      })
      bindingToken = token
      committedSessionId = currentSessionId
      bindingDisposal = off
      presentationEpoch += 1
      wakeWaiters()
      return () => {
        if (bindingToken !== token) return
        bindingToken = undefined
        bindingDisposal = undefined
        committedSessionId = undefined
        presentationEpoch += 1
        off()
        wakeWaiters()
      }
    },
    beginNavigationHold(): NavigationHoldRelease {
      if (disposed) throw new Error('client interaction delivery: disposed')
      if (navigationHold !== undefined) throw new Error('client interaction delivery: a navigation hold is already active')
      presentationEpoch += 1
      let released = false
      const handle: NavigationHoldRelease = {
        release: (): void => {
          if (released) return
          released = true
          if (navigationHold !== handle) return
          navigationHold = undefined
          wakeWaiters()
        },
      }
      navigationHold = handle
      wakeWaiters()
      return handle
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      current = undefined
      navigationHold = undefined
      committedSessionId = undefined
      bindingToken = undefined
      const binding = bindingDisposal
      bindingDisposal = undefined
      eligibleRequests.clear()
      notifyEligibility()
      rootLifetime.abort(disposedReason())
      wakeWaiters()
      runSyncDisposalSteps('client interaction delivery disposal', [
        () => binding?.(),
        ...owned.splice(0).map(off => () => { off() }),
      ])
    },
  }
}
