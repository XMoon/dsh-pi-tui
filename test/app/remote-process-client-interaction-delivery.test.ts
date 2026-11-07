/**
 * Split-Client root interaction delivery contracts.
 *
 * Evidence level: L3 adapter composition over a structural official-event
 * seat. The real two-process question/approval handoff is proven by the
 * split-process smoke; this suite pins the local delivery semantics that make
 * that handoff safe: one listener pair per Client root, no early `next`, no
 * Host decision from a detached surface, a replacement revision taking over
 * the SAME official invocation, and navigation-first admission — a forwarded
 * request is presented only while its own Session is the committed subject,
 * the navigation hold withdraws the local seat without settling the Host, and
 * the SAME invocation is re-offered when that Session is current again.
 *
 * @module @xmoon76/dsh-pi-tui/remote-process-client-interaction-delivery.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import {
  createSplitClientInteractionDelivery,
  type SplitClientInteractionEventsSource,
} from '../../src/app/remote-process/client-interaction-delivery.ts'
import type { ApprovalRequestListener, UserQuestionProvider } from '../../src/runtime/interaction-port.ts'

type QuestionListener = (
  this: unknown,
  request: { questions: readonly { id?: string; question: string; options?: readonly { label: string }[] }[]; wait?: { callId?: unknown; timed?: unknown }; signal?: AbortSignal },
  next: () => Promise<AskUserQuestionAnswer>,
) => Promise<AskUserQuestionAnswer>

type ApprovalListener = (this: unknown, request: unknown, next: unknown) => unknown

/** One structural `remote.$on` seat that records every registration. */
class EventSeat {
  readonly questionListeners: QuestionListener[] = []
  readonly approvalListeners: ApprovalListener[] = []
  readonly offCalls: string[] = []

  $on(event: string, listener: QuestionListener | ApprovalListener): () => void {
    if (event === 'user-questions/request') {
      this.questionListeners.push(listener as QuestionListener)
      return () => { this.offCalls.push(event) }
    }
    this.approvalListeners.push(listener as ApprovalListener)
    return () => { this.offCalls.push(event) }
  }

  emitQuestion(request: Parameters<QuestionListener>[0], next: () => Promise<AskUserQuestionAnswer>): Promise<AskUserQuestionAnswer> {
    assert.equal(this.questionListeners.length, 1, 'exactly one root question listener must exist')
    return this.questionListeners[0].call({ scope: 'agent' }, request, next)
  }

  emitApproval(request: unknown, next: unknown): unknown {
    assert.equal(this.approvalListeners.length, 1, 'exactly one root approval listener must exist')
    return this.approvalListeners[0].call({ scope: 'agent' }, request, next)
  }
}

/** The official Session scope seat: every non-root `this` resolves to one Session. */
class SessionSeat {
  scopeOf(owner: unknown): string | undefined {
    return owner === undefined || owner === null ? undefined : 'session-1'
  }
}

const QUESTIONS = [{ id: 'q1', question: 'Continue?', options: [{ label: 'Proceed' }] }]

const PROCEED: AskUserQuestionAnswer = {
  answers: [{ id: 'q1', selected: ['Proceed'] }],
} as unknown as AskUserQuestionAnswer

const CANCEL: AskUserQuestionAnswer = {
  answers: [{ id: 'q1', selected: ['Cancel'] }],
} as unknown as AskUserQuestionAnswer

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } => {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** Build the one production delivery owner over a recording event seat and
 *  bind the committed-Session authority the runner installs. */
function createDelivery(initialSessionId: string | undefined = 'session-1'): {
  seat: EventSeat
  delivery: ReturnType<typeof createSplitClientInteractionDelivery>
  setSessionId(sessionId: string | undefined): void
  notifyCommittedSession(): void
} {
  const seat = new EventSeat()
  const delivery = createSplitClientInteractionDelivery({
    remote: seat as unknown as SplitClientInteractionEventsSource,
    sessions: new SessionSeat(),
  })
  let currentSessionId: string | undefined = initialSessionId
  const listeners = new Set<() => void>()
  delivery.bindCommittedSession(
    () => currentSessionId,
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  )
  return {
    seat,
    delivery,
    setSessionId: (sessionId: string | undefined) => { currentSessionId = sessionId },
    notifyCommittedSession: () => { for (const listener of [...listeners]) listener() },
  }
}

test('the delivery registers exactly one official listener pair for the whole Client root', () => {
  const { seat, delivery } = createDelivery()
  assert.equal(seat.questionListeners.length, 1)
  assert.equal(seat.approvalListeners.length, 1)
  delivery.dispose()
  assert.deepEqual(seat.offCalls, ['user-questions/request', 'approval/request'])
})

test('a request that arrives before any surface attaches waits, then answers through the attached revision', async () => {
  const { seat, delivery } = createDelivery()
  let nextCalls = 0
  const result = seat.emitQuestion({ questions: QUESTIONS, wait: { callId: 'call-1' } }, async () => {
    nextCalls += 1
    return PROCEED
  })
  await tick()
  assert.equal(nextCalls, 0, 'an unattached delivery must never delegate the official request')
  delivery.attachSurface(1, {
    onQuestion: async request => {
      assert.equal(request.sessionId, 'session-1')
      assert.equal(request.callId, 'call-1')
      assert.equal(request.timed, false)
      return CANCEL
    },
    onApproval: () => 'rejected',
  })
  assert.deepEqual(await result, CANCEL)
  assert.equal(nextCalls, 0)
  delivery.dispose()
})

test('an aborted request lifetime settles without delegating or leaking a pending task', async () => {
  const { seat, delivery } = createDelivery()
  const controller = new AbortController()
  let nextCalls = 0
  const result = seat.emitQuestion(
    { questions: QUESTIONS, wait: { callId: 'call-2' }, signal: controller.signal },
    async () => { nextCalls += 1; return PROCEED },
  )
  controller.abort(new Error('host cancelled the question'))
  await assert.rejects(result, /host cancelled the question/u)
  assert.equal(nextCalls, 0, 'an aborted request must not delegate to the Host fallback')
  delivery.dispose()
})

test('an uncooperative provider is released by the official request abort', async () => {
  const { seat, delivery } = createDelivery()
  const controller = new AbortController()
  const result = seat.emitQuestion(
    { questions: QUESTIONS, wait: { callId: 'call-abort-provider' }, signal: controller.signal },
    async () => PROCEED,
  )
  delivery.attachSurface(1, {
    onQuestion: async () => await new Promise<never>(() => {}),
    onApproval: () => 'rejected',
  })
  await tick()
  controller.abort(new Error('host lifetime ended'))
  await assert.rejects(result, /host lifetime ended/u)
  delivery.dispose()
})

test('a stale revision result is discarded and the replacement revision settles the SAME question', async () => {
  const { seat, delivery } = createDelivery()
  const first = deferred<AskUserQuestionAnswer>()
  let nextCalls = 0
  const result = seat.emitQuestion({ questions: QUESTIONS, wait: { callId: 'call-3' } }, async () => {
    nextCalls += 1
    return PROCEED
  })
  const detachFirst = delivery.attachSurface(1, {
    onQuestion: () => first.promise,
    onApproval: () => 'rejected',
  })
  await tick()
  detachFirst()
  let secondCalls = 0
  delivery.attachSurface(2, {
    onQuestion: async () => {
      secondCalls += 1
      return CANCEL
    },
    onApproval: () => 'rejected',
  })
  first.resolve(PROCEED)
  assert.deepEqual(await result, CANCEL, 'the stale revision answer must not settle the Host invocation')
  assert.equal(secondCalls, 1)
  assert.equal(nextCalls, 0)
  delivery.dispose()
})

test('a stale approval allow is discarded and the current revision rejection is the only outcome', async () => {
  const { seat, delivery } = createDelivery()
  const first = deferred<unknown>()
  const result = Promise.resolve(seat.emitApproval(
    { toolName: 'bash', callId: 'call-4' },
    async () => 'next',
  ))
  const detachFirst = delivery.attachSurface(1, {
    onQuestion: async () => PROCEED,
    onApproval: () => first.promise,
  })
  await tick()
  detachFirst()
  delivery.attachSurface(2, {
    onQuestion: async () => PROCEED,
    onApproval: async request => {
      assert.equal(request.sessionId, 'session-1')
      assert.equal(request.callId, 'call-4')
      return 'rejected'
    },
  })
  first.resolve('allowed-once')
  assert.equal(await result, 'rejected')
  delivery.dispose()
})

test('the current revision decision is forwarded unchanged, including a human rejection', async () => {
  const { seat, delivery } = createDelivery()
  delivery.attachSurface(1, {
    onQuestion: async () => PROCEED,
    onApproval: () => 'rejected',
  })
  assert.equal(await seat.emitApproval({ toolName: 'bash', callId: 'call-5' }, async () => 'next'), 'rejected')
  delivery.dispose()
})

test('an unbound delivery keeps the legacy immediate forward (TSP split)', async () => {
  const seat = new EventSeat()
  const delivery = createSplitClientInteractionDelivery({
    remote: seat as unknown as SplitClientInteractionEventsSource,
    sessions: new SessionSeat(),
  })
  // No committed-Session authority is installed: this is the TSP split path,
  // whose native modal seat keeps its own admission. The root must forward
  // immediately (pre-G567 behavior), not hold the request.
  let providerCalls = 0
  delivery.attachSurface(1, {
    onQuestion: async () => { providerCalls += 1; return PROCEED },
    onApproval: () => 'rejected',
  })
  assert.deepEqual(await seat.emitQuestion({ questions: QUESTIONS, wait: { callId: 'legacy' } }, async () => CANCEL), PROCEED)
  assert.equal(providerCalls, 1)
  delivery.dispose()
})

test('a request whose owner has no Session takes the official fail-closed next path', async () => {
  const seat = new EventSeat()
  const delivery = createSplitClientInteractionDelivery({
    remote: seat as unknown as SplitClientInteractionEventsSource,
    sessions: { scopeOf: () => undefined },
  })
  let nextCalls = 0
  const result = await seat.emitQuestion({ questions: QUESTIONS }, async () => {
    nextCalls += 1
    return PROCEED
  })
  assert.deepEqual(result, PROCEED)
  assert.equal(nextCalls, 1)
  delivery.dispose()
})

test('A(Y) never presents X: the same question is mounted only after the committed subject becomes X', async () => {
  const { seat, delivery, setSessionId, notifyCommittedSession } = createDelivery('session-Y')
  let nextCalls = 0
  let providerCalls = 0
  const presented = deferred<AskUserQuestionAnswer>()
  const result = seat.emitQuestion({ questions: QUESTIONS, wait: { callId: 'call-nav-q' } }, async () => {
    nextCalls += 1
    return PROCEED
  })
  delivery.attachSurface(1, {
    onQuestion: async () => { providerCalls += 1; return presented.promise },
    onApproval: () => 'rejected',
  })
  await tick()
  await tick()
  assert.equal(providerCalls, 0, 'the Y surface must not receive the X question')
  assert.deepEqual(delivery.currentEligibleRequests(), [{ sessionId: 'session-1', kind: 'question', live: true }])
  // The real Session switch commits X and its coalesced notification wakes the
  // root; the SAME invocation is then presented once.
  setSessionId('session-1')
  notifyCommittedSession()
  await tick()
  await tick()
  assert.equal(providerCalls, 1, 'the X question is presented exactly once after the commit')
  presented.resolve(PROCEED)
  assert.deepEqual(await result, PROCEED)
  assert.equal(nextCalls, 0)
  assert.deepEqual(delivery.currentEligibleRequests(), [], 'a settled invocation leaves the eligible read view')
  delivery.dispose()
})

test('A(Y) never presents X Approval: the same request is mounted only after the committed subject becomes X', async () => {
  const { seat, delivery, setSessionId, notifyCommittedSession } = createDelivery('session-Y')
  let nextCalls = 0
  let providerCalls = 0
  const result = Promise.resolve(seat.emitApproval({ toolName: 'bash', callId: 'call-nav-a' }, async () => {
    nextCalls += 1
    return 'next'
  }))
  delivery.attachSurface(1, {
    onQuestion: async () => PROCEED,
    onApproval: () => { providerCalls += 1; return 'allowed-once' },
  })
  await tick()
  assert.equal(providerCalls, 0, 'the Y surface must not receive the X approval')
  setSessionId('session-1')
  notifyCommittedSession()
  assert.equal(await result, 'allowed-once')
  assert.equal(providerCalls, 1)
  assert.equal(nextCalls, 0)
  delivery.dispose()
})

test('a navigation hold discards the withdrawn local cancellation and re-offers the SAME question on return', async () => {
  const { seat, delivery, setSessionId, notifyCommittedSession } = createDelivery()
  let nextCalls = 0
  const first = deferred<AskUserQuestionAnswer>()
  let providerCalls = 0
  const result = seat.emitQuestion({ questions: QUESTIONS, wait: { callId: 'call-hold-q' } }, async () => {
    nextCalls += 1
    return PROCEED
  })
  delivery.attachSurface(1, {
    onQuestion: async () => {
      providerCalls += 1
      return providerCalls === 1 ? first.promise : CANCEL
    },
    onApproval: () => 'rejected',
  })
  await tick()
  assert.equal(providerCalls, 1)
  // Alt+W: the root hold is committed FIRST, then the local seat is withdrawn.
  const hold = delivery.beginNavigationHold()
  first.reject(new Error('question flow cancelled'))
  await tick()
  await tick()
  assert.equal(providerCalls, 1, 'the withdrawn local attempt must not be re-presented while held')
  // The user browsed to Y; the hold releases on workspace close. X is still the
  // request owner, so nothing is presented on Y.
  setSessionId('session-Y')
  notifyCommittedSession()
  hold.release()
  await tick()
  await tick()
  assert.equal(providerCalls, 1, 'the X request stays suspended while the committed subject is Y')
  // Returning to X re-offers the SAME official invocation (no second callId).
  setSessionId('session-1')
  notifyCommittedSession()
  assert.deepEqual(await result, CANCEL, 'the second real presentation answers the Host exactly once')
  assert.equal(providerCalls, 2)
  assert.equal(nextCalls, 0)
  delivery.dispose()
})

test('a navigation hold discards a withdrawn approval cancellation and re-offers the SAME approval on return', async () => {
  const { seat, delivery, setSessionId, notifyCommittedSession } = createDelivery()
  let nextCalls = 0
  const first = deferred<unknown>()
  let providerCalls = 0
  const result = Promise.resolve(seat.emitApproval({ toolName: 'bash', callId: 'call-hold-a' }, async () => {
    nextCalls += 1
    return 'next'
  }))
  delivery.attachSurface(1, {
    onQuestion: async () => PROCEED,
    onApproval: () => {
      providerCalls += 1
      return providerCalls === 1 ? first.promise : 'allowed-once'
    },
  })
  await tick()
  assert.equal(providerCalls, 1)
  const hold = delivery.beginNavigationHold()
  first.resolve('cancelled')
  await tick()
  await tick()
  assert.equal(providerCalls, 1, 'the withdrawn local cancellation must not be re-presented while held')
  setSessionId('session-Y')
  notifyCommittedSession()
  hold.release()
  await tick()
  await tick()
  assert.equal(providerCalls, 1, 'the X approval stays suspended while the committed subject is Y')
  assert.deepEqual(delivery.currentEligibleRequests(), [{ sessionId: 'session-1', kind: 'approval', live: true }])
  setSessionId('session-1')
  notifyCommittedSession()
  assert.equal(await result, 'allowed-once', 'the second real presentation is the ONE Host decision')
  assert.equal(providerCalls, 2)
  assert.equal(nextCalls, 0)
  assert.deepEqual(delivery.currentEligibleRequests(), [])
  delivery.dispose()
})

test('a hold released before the withdrawn attempt settles still cannot forward its local cancellation', async () => {
  const { seat, delivery } = createDelivery()
  let providerCalls = 0
  const first = deferred<AskUserQuestionAnswer>()
  const result = seat.emitQuestion({ questions: QUESTIONS, wait: { callId: 'call-hold-early' } }, async () => PROCEED)
  delivery.attachSurface(1, {
    onQuestion: async () => { providerCalls += 1; return providerCalls === 1 ? first.promise : CANCEL },
    onApproval: () => 'rejected',
  })
  await tick()
  const hold = delivery.beginNavigationHold()
  hold.release()
  // The withdrawn local promise settles only AFTER the release: the epoch must
  // still classify it as stale (a release never makes an old attempt current).
  first.reject(new Error('question flow cancelled'))
  assert.deepEqual(await result, CANCEL)
  assert.equal(providerCalls, 2, 'the root re-offers the request after the stale cancellation')
  delivery.dispose()
})

test('Abort during a navigation hold terminates the wait without a second presentation', async () => {
  const { seat, delivery } = createDelivery()
  const controller = new AbortController()
  const first = deferred<AskUserQuestionAnswer>()
  let providerCalls = 0
  const result = seat.emitQuestion(
    { questions: QUESTIONS, wait: { callId: 'call-hold-abort' }, signal: controller.signal },
    async () => PROCEED,
  )
  delivery.attachSurface(1, {
    onQuestion: async () => { providerCalls += 1; return first.promise },
    onApproval: () => 'rejected',
  })
  await tick()
  const hold = delivery.beginNavigationHold()
  controller.abort(new Error('host withdrew the question during navigation'))
  await assert.rejects(result, /host withdrew the question during navigation/u)
  first.reject(new Error('question flow cancelled'))
  hold.release()
  await tick()
  await tick()
  assert.equal(providerCalls, 1, 'an aborted request must never be re-presented')
  delivery.dispose()
  assert.deepEqual(seat.offCalls, ['user-questions/request', 'approval/request'])
})

test('a provider result that resolves before an official abort is never forwarded', async () => {
  const { seat, delivery } = createDelivery()
  const controller = new AbortController()
  let providerCalls = 0
  let releaseProvider: ((value: AskUserQuestionAnswer) => void) | undefined
  let nextCalls = 0
  const result = seat.emitQuestion(
    { questions: QUESTIONS, wait: { callId: 'call-race-q' }, signal: controller.signal },
    async () => { nextCalls += 1; return PROCEED },
  )
  delivery.attachSurface(1, {
    onQuestion: () => new Promise<AskUserQuestionAnswer>(resolve => {
      providerCalls += 1
      releaseProvider = resolve
    }),
    onApproval: () => 'rejected',
  })
  await tick()
  assert.equal(providerCalls, 1)
  // Provider resolve FIRST; the official abort fires before the delivery's
  // await continuation runs. The resolved answer must NOT reach the Gateway.
  releaseProvider?.(PROCEED)
  controller.abort(new Error('question was withdrawn by the Host'))
  // Two microtasks: the promise.resolve(invoke) wrapper and the
  // raceWithAbort .then hop. By the time the delivery continuation runs the
  // abort is already observable, which is exactly the reviewed race.
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.signal.aborted, true)
  await assert.rejects(result, /question was withdrawn by the Host/u,
    'a provider answer that raced the official abort must not be forwarded')
  delivery.dispose()
})

test('an approval decision that resolves before an official abort is never forwarded', async () => {
  const { seat, delivery } = createDelivery()
  const controller = new AbortController()
  let providerCalls = 0
  let releaseProvider: ((value: unknown) => void) | undefined
  const result = Promise.resolve(seat.emitApproval(
    { toolName: 'bash', callId: 'call-race-a', signal: controller.signal },
    async () => 'next',
  ))
  delivery.attachSurface(1, {
    onQuestion: async () => PROCEED,
    onApproval: () => new Promise<unknown>(resolve => {
      providerCalls += 1
      releaseProvider = resolve
    }),
  })
  await tick()
  assert.equal(providerCalls, 1)
  releaseProvider?.('allowed-once')
  controller.abort(new Error('approval was withdrawn by the Host'))
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(controller.signal.aborted, true)
  await assert.rejects(result, /approval was withdrawn by the Host/u,
    'a stale allowed-once that raced the official abort must not be forwarded')
  delivery.dispose()
})

test('the eligibility read view notifies on add and remove but never answers', async () => {
  const { seat, delivery } = createDelivery()
  const events: string[] = []
  const unsubscribe = delivery.subscribeEligibility(() => {
    const current = delivery.currentEligibleRequests().map(entry => `${entry.kind}:${entry.sessionId}`)
    events.push(current.join(','))
  })
  let providerCalls = 0
  const result = seat.emitQuestion({ questions: QUESTIONS, wait: { callId: 'call-eligible' } }, async () => PROCEED)
  delivery.attachSurface(1, {
    onQuestion: async () => { providerCalls += 1; return PROCEED },
    onApproval: () => 'rejected',
  })
  assert.deepEqual(await result, PROCEED)
  assert.equal(providerCalls, 1)
  assert.equal(events.length, 2, 'one notification when the invocation starts, one when it settles')
  assert.equal(events[0], 'question:session-1')
  assert.equal(events[1], '')
  unsubscribe()
  delivery.dispose()
})

test('root disposal terminates an in-flight delivery without delegating to next', async () => {
  const { seat, delivery } = createDelivery()
  let nextCalls = 0
  const result = seat.emitQuestion({ questions: QUESTIONS, wait: { callId: 'call-dispose' } }, async () => {
    nextCalls += 1
    return PROCEED
  })
  delivery.attachSurface(1, {
    onQuestion: async () => await new Promise<never>(() => {}),
    onApproval: () => 'rejected',
  })
  await tick()
  delivery.dispose()
  await assert.rejects(result, /disposed before the official request settled/u)
  assert.equal(nextCalls, 0)
})
