/**
 * Split-Client root interaction delivery contracts.
 *
 * Evidence level: L3 adapter composition over a structural official-event
 * seat. The real two-process question/approval handoff is proven by the
 * split-process smoke; this suite pins the local delivery semantics that make
 * that handoff safe: one listener pair per Client root, no early `next`, no
 * Host decision from a detached surface, and a replacement revision taking
 * over the SAME official invocation.
 *
 * @module @xmoon76/dsh-pi-tui/remote-process-client-interaction-delivery.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import {
  createSplitClientInteractionDelivery,
  type SplitClientInteractionEventsSource,
  type SplitClientInteractionSessionsSource,
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

/** The official Session scope seat: every non-root `this` resolves to a Session. */
class SessionSeat implements SplitClientInteractionSessionsSource {
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

/** Build the one production delivery owner over a recording event seat. */
function createDelivery(): {
  seat: EventSeat
  delivery: ReturnType<typeof createSplitClientInteractionDelivery>
  answered: AskUserQuestionAnswer[]
  nextCalls: number
} {
  const seat = new EventSeat()
  const delivery = createSplitClientInteractionDelivery({
    remote: seat as unknown as SplitClientInteractionEventsSource,
    sessions: new SessionSeat(),
  })
  return { seat, delivery, answered: [], nextCalls: 0 }
}

const deferred = <T>(): { promise: Promise<T>; resolve: (value: T) => void } => {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>(res => { resolve = res })
  return { promise, resolve }
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
  await new Promise(resolve => setTimeout(resolve, 0))
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
  await new Promise(resolve => setTimeout(resolve, 0))
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
  await new Promise(resolve => setTimeout(resolve, 0))
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
  await new Promise(resolve => setTimeout(resolve, 0))
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
