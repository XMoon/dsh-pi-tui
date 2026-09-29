/**
 * Question lifecycle integration tests (M3-3B): the surface controller layers
 * the timed/continued lifecycle AROUND the existing QuestionFlow — claim
 * before countdown, Host-seeded remaining duration, non-destructive timeout
 * (wire-preserved `ASK_TIMED_OUT`, never a Turn cancel), countdown freeze on
 * the first real answer mutation, claim release, continued-late-answer
 * reachability driven by the authoritative projection, queued-reply read-only
 * suppression, and stale/absent-surface fences.
 * @module @xmoon76/dsh-pi-tui/question-remote-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ASK_ABORTED,
  ASK_CANCELLED,
  ASK_TIMED_OUT,
  QuestionSurfaceController,
  remainingTimeText,
} from '../src/app/surface/question-controller.ts'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type {
  QuestionInteractionPort,
  QuestionRequestView,
  QuestionSurfaceSnapshot,
  QuestionWaitClaim,
  UserQuestionProvider,
} from '../src/runtime/interaction-port.ts'
import { QuestionAnswerError, QUESTION_REPLY_QUEUED } from '../src/runtime/interaction-port.ts'
import { SupersededReadError } from '../src/runtime/read-error.ts'
import type { TuiQuestion, TuiQuestionAnswer, TuiQuestionStatus } from '../src/tui-app.ts'
import type { Diag } from '../src/diag.ts'

/** A no-op diagnostics channel (the controller only forwards detach failures). */
const SILENT_DIAG: Diag = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {},
}

type AskRecord = {
  readonly questions: readonly TuiQuestion[]
  readonly signal: AbortSignal | undefined
  readonly status: TuiQuestionStatus
}

/** A controllable fake Question port + ask hook. */
function harness(options: {
  claim?: QuestionWaitClaim | undefined
  /** Gate the claim opening so a test can abort while the first frame is in flight. */
  claimGate?: Promise<void>
  snapshot?: QuestionSurfaceSnapshot | undefined
  answerContinued?: (sessionId: string, callId: string, answer: AskUserQuestionAnswer) => Promise<'queued' | 'not-continued'>
} = {}) {
  let provider: UserQuestionProvider | undefined
  const asks: AskRecord[] = []
  const notices: string[] = []
  const answered: Array<{ sessionId: string; callId: string }> = []
  let clock = 1_000
  const claimSignals: Array<AbortSignal | undefined> = []
  const port: QuestionInteractionPort = {
    onRequest: (next) => { provider = next; return true },
    snapshot: () => options.snapshot,
    claimTimedWait: async (_sessionId, _callId, signal) => {
      claimSignals.push(signal)
      // A real adapter resolves `undefined` once its caller lifetime aborts
      // (the Host wait is released), which is what a teardown must see. The
      // ungated case keeps the plain microtask shape the other cases rely on.
      if (signal?.aborted === true) return undefined
      if (options.claimGate === undefined) return options.claim
      const aborted = new Promise<undefined>((resolve) => {
        signal?.addEventListener('abort', () => { resolve(undefined) }, { once: true })
      })
      return await Promise.race([options.claimGate.then(() => options.claim), aborted])
    },
    answerContinued: async (sessionId, callId, answer) => {
      answered.push({ sessionId, callId })
      return options.answerContinued === undefined ? 'queued' : options.answerContinued(sessionId, callId, answer)
    },
  }
  const controller = new QuestionSurfaceController({
    port,
    ask: (questions, signal, status) => new Promise<TuiQuestionAnswer[]>((resolve, reject) => {
      asks.push({ questions, signal, status })
      // The real flow settles on submit AND on its signal's abort; mirror
      // both so the controller's countdown path is exercised end to end.
      pendingAsk = { resolve, reject }
      if (signal !== undefined) {
        signal.addEventListener('abort', () => { reject(new Error('question flow cancelled')) }, { once: true })
      }
    }),
    notify: (message) => { notices.push(message) },
    repaint: () => {},
    currentSessionId: () => 'session-a',
    diag: SILENT_DIAG,
    now: () => clock,
    tickMs: 5,
    continuedDeadlineMs: 100,
  })
  let pendingAsk: { resolve: (answers: TuiQuestionAnswer[]) => void; reject: (error: unknown) => void } | undefined
  controller.attach()
  return {
    controller,
    port,
    claimSignals,
    asks,
    notices,
    answered,
    /** Advance the injected clock (the tick is manual in these tests). */
    setClock: (value: number) => { clock = value },
    /** Deliver one live request through the registered provider. */
    live: (request: QuestionRequestView) => provider!(request, async () => ({ answers: [] })),
    /** Settle the currently mounted flow. */
    submit: (answers: TuiQuestionAnswer[]) => pendingAsk?.resolve(answers),
    /** Cancel the currently mounted flow (Esc/Ctrl+C). */
    cancel: () => pendingAsk?.reject(new Error('question flow cancelled')),
  }
}

const QUESTIONS = [{ id: 'q1', question: 'Pick one', options: [{ label: 'a' }] }]

test('remainingTimeText renders a mm:ss countdown', () => {
  assert.equal(remainingTimeText(0), '0:00')
  assert.equal(remainingTimeText(1), '0:01')
  assert.equal(remainingTimeText(61_000), '1:01')
  assert.equal(remainingTimeText(-5), '0:00')
})

test('a timed request claims the Host wait BEFORE the countdown starts', async () => {
  const claim: QuestionWaitClaim = { remainingMs: 90_000, ended: new Promise(() => {}), release: () => { released += 1 } }
  let released = 0
  const h = harness({ claim })
  const pending = h.live({ sessionId: 'session-a', callId: 'call-1', timed: true, questions: QUESTIONS })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.asks.length, 1, 'exactly one flow is mounted')
  assert.match(h.asks[0]!.status.text ?? '', /1:30/u, 'the first frame seeds the countdown from the Host remainingMs')
  h.submit([{ id: 'q1', selected: ['a'] }])
  const result = await pending
  assert.deepEqual(result, { answers: [{ id: 'q1', selected: ['a'] }] })
  assert.equal(released, 1, 'the claim is released when the flow settles')
})

test('the local countdown reaching zero rejects ASK_TIMED_OUT without cancelling the Turn', async () => {
  let released = 0
  const claim: QuestionWaitClaim = { remainingMs: 1_000, ended: new Promise(() => {}), release: () => { released += 1 } }
  const h = harness({ claim })
  const pending = h.live({ sessionId: 'session-a', callId: 'call-1', timed: true, questions: QUESTIONS })
  await Promise.resolve(); await Promise.resolve()
  // Attach the rejection expectation BEFORE the tick can reject, then
  // advance past the local deadline and let one tick fire.
  const expectsTimeout = assert.rejects(() => pending, (error: unknown) => {
    assert.equal((error as { code?: string }).code, ASK_TIMED_OUT)
    assert.equal((error as Error).name, 'UserQuestionError')
    return true
  })
  h.setClock(2_000)
  await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
  await expectsTimeout
  assert.equal(released, 1, 'the claim is released when the countdown ends')
})

test('a user cancel rejects ASK_CANCELLED and a Host abort rejects ASK_ABORTED', async () => {
  const cancelled = harness({ claim: undefined })
  const pendingCancel = cancelled.live({ sessionId: 'session-a', callId: 'call-1', timed: true, questions: QUESTIONS })
  await Promise.resolve(); await Promise.resolve()
  cancelled.cancel()
  await assert.rejects(() => pendingCancel, (error: unknown) => {
    assert.equal((error as { code?: string }).code, ASK_CANCELLED)
    assert.equal((error as Error).name, 'UserQuestionError')
    return true
  })

  const aborted = harness({ claim: undefined })
  const hostAbort = new AbortController()
  const pendingAbort = aborted.live({
    sessionId: 'session-a',
    callId: 'call-2',
    timed: true,
    questions: QUESTIONS,
    signal: hostAbort.signal,
  })
  await Promise.resolve(); await Promise.resolve()
  hostAbort.abort(new Error('turn cancelled'))
  aborted.cancel()
  await assert.rejects(() => pendingAbort, (error: unknown) => {
    assert.equal((error as { code?: string }).code, ASK_ABORTED)
    return true
  })
})

test('the first real answer mutation freezes the countdown and the claim stays held', async () => {
  let released = 0
  const claim: QuestionWaitClaim = { remainingMs: 60_000, ended: new Promise(() => {}), release: () => { released += 1 } }
  const h = harness({ claim })
  const pending = h.live({ sessionId: 'session-a', callId: 'call-1', timed: true, questions: QUESTIONS })
  await Promise.resolve(); await Promise.resolve()
  const status = h.asks[0]!.status
  assert.doesNotMatch(status.text ?? '', /Editing/u)
  status.onAnswerMutation?.()
  assert.match(status.text ?? '', /Editing/u, 'the mutation freezes the local deadline into indefinite editing')
  assert.equal(released, 0, 'focus/edit never releases the claim')
  h.submit([{ id: 'q1', selected: ['a'] }])
  await pending
  assert.equal(released, 1)
})

test('reconcile offers a continued call without a queued reply exactly once', async () => {
  const snapshot: QuestionSurfaceSnapshot = {
    sessionId: 'session-a',
    active: [{ callId: 'call-continued', sessionId: 'session-a', questions: QUESTIONS, state: 'continued' }],
    settled: [],
    queuedReplyCallIds: new Set(),
  }
  const h = harness({ snapshot })
  h.controller.reconcile()
  h.controller.reconcile()
  await Promise.resolve()
  assert.equal(h.asks.length, 1, 'one continued flow is mounted, not one per reconcile')
  h.submit([{ id: 'q1', selected: ['a'] }])
  await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(h.answered, [{ sessionId: 'session-a', callId: 'call-continued' }])
  assert.match(h.notices.at(-1) ?? '', /Answer queued/u)
})

test('reconcile never offers a continued call whose reply is durably queued', async () => {
  const snapshot: QuestionSurfaceSnapshot = {
    sessionId: 'session-a',
    active: [{ callId: 'call-continued', sessionId: 'session-a', questions: QUESTIONS, state: 'continued' }],
    settled: [],
    queuedReplyCallIds: new Set(['call-continued']),
  }
  const h = harness({ snapshot })
  h.controller.reconcile()
  await Promise.resolve()
  assert.equal(h.asks.length, 0, 'a queued reply withdraws the editable surface')
})

test('reconcile does nothing without an authoritative surface (capability absence)', async () => {
  const h = harness({ snapshot: undefined })
  h.controller.reconcile()
  await Promise.resolve()
  assert.equal(h.asks.length, 0)
})

test('an open call is never offered as a continued late answer', async () => {
  const snapshot: QuestionSurfaceSnapshot = {
    sessionId: 'session-a',
    active: [{ callId: 'call-open', sessionId: 'session-a', questions: QUESTIONS, state: 'open' }],
    settled: [],
    queuedReplyCallIds: new Set(),
  }
  const h = harness({ snapshot })
  h.controller.reconcile()
  await Promise.resolve()
  assert.equal(h.asks.length, 0, 'the live waterfall, not reconcile, owns the open case')
})

test('REPLY_QUEUED on a late answer preserves intent as a read-only notice', async () => {
  const snapshot: QuestionSurfaceSnapshot = {
    sessionId: 'session-a',
    active: [{ callId: 'call-continued', sessionId: 'session-a', questions: QUESTIONS, state: 'continued' }],
    settled: [],
    queuedReplyCallIds: new Set(),
  }
  const h = harness({
    snapshot,
    answerContinued: async () => { throw new QuestionAnswerError(QUESTION_REPLY_QUEUED, 'a reply is already queued') },
  })
  h.controller.reconcile()
  await Promise.resolve()
  h.submit([{ id: 'q1', selected: ['a'] }])
  await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  assert.match(h.notices.join('\n'), /already queued/u)
})

test('dispose releases controller state and stops offering questions', async () => {
  const snapshot: QuestionSurfaceSnapshot = {
    sessionId: 'session-a',
    active: [{ callId: 'call-continued', sessionId: 'session-a', questions: QUESTIONS, state: 'continued' }],
    settled: [],
    queuedReplyCallIds: new Set(),
  }
  const h = harness({ snapshot })
  h.controller.dispose()
  h.controller.reconcile()
  await Promise.resolve()
  assert.equal(h.asks.length, 0)
})

test('dispose during the claim opening aborts the attempt and never mounts a stale countdown', async () => {
  // The claim's first frame is still in flight when the surface tears down.
  // Without a cancellable claim the controller would keep awaiting, and the
  // Host wait would stay held by a claim nobody releases (plan §15.2).
  const gate = Promise.withResolvers<void>()
  const claim: QuestionWaitClaim = { remainingMs: 60_000, ended: new Promise(() => {}), release: () => { released += 1 } }
  let released = 0
  const h = harness({ claim, claimGate: gate.promise })
  const pending = h.live({ sessionId: 'session-a', callId: 'call-1', timed: true, questions: QUESTIONS })
  await Promise.resolve()
  assert.equal(h.asks.length, 0, 'the flow waits for the claim before mounting')
  assert.equal(h.claimSignals.length, 1, 'the claim received the caller lifetime signal')
  assert.equal(h.claimSignals[0]?.aborted, false)

  h.controller.dispose()
  assert.equal(h.claimSignals[0]?.aborted, true, 'teardown aborts the in-flight claim opening')

  // The live waterfall still has to settle: the abort reaches it through the
  // same combined signal, so the request never hangs.
  gate.resolve()
  await assert.rejects(() => pending, (error: unknown) => {
    assert.equal((error as { code?: string }).code, ASK_ABORTED)
    return true
  })
  assert.equal(h.asks.length, 0, 'a torn-down surface never mounts the countdown')
  assert.equal(released, 0, 'the Host-side claim was released by the abort, not by a returned handle')
})

test('a Host-ended claim rejects ASK_ABORTED, never the user-cancel code, and stays answerable', async () => {
  // The Host/claim lifetime ends the foreground attempt (stream loss or a wait
  // the Host closed). That is NOT a user cancel: reporting ASK_CANCELLED would
  // record a cancellation the human never made, and the question must remain
  // durably answerable as `continued`.
  const ended = Promise.withResolvers<void>()
  let released = 0
  const claim: QuestionWaitClaim = { remainingMs: 60_000, ended: ended.promise, release: () => { released += 1 } }
  const snapshot: QuestionSurfaceSnapshot = {
    sessionId: 'session-a',
    active: [{ callId: 'call-1', sessionId: 'session-a', questions: QUESTIONS, state: 'continued' }],
    settled: [],
    queuedReplyCallIds: new Set(),
  }
  const h = harness({ claim, snapshot })
  const pending = h.live({ sessionId: 'session-a', callId: 'call-1', timed: true, questions: QUESTIONS })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(h.asks.length, 1)

  const expectsAbort = assert.rejects(() => pending, (error: unknown) => {
    assert.equal((error as { code?: string }).code, ASK_ABORTED, 'a Host-driven end is an abort, not a user cancel')
    assert.notEqual((error as { code?: string }).code, ASK_CANCELLED)
    return true
  })
  ended.resolve()
  await expectsAbort
  assert.equal(released, 1, 'the claim is released when the Host ends it')

  // The expired/closed wait leaves the call durably answerable: the controller
  // offers the continued late answer from the projection.
  await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  assert.equal(h.asks.length, 2, 'the continued late-answer surface is offered again')
  h.submit([{ id: 'q1', selected: ['a'] }])
  await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
  assert.deepEqual(h.answered, [{ sessionId: 'session-a', callId: 'call-1' }])
})

test('a superseded late-answer completion does not touch the current Question surface', async () => {
  // The Remote adapter fences the answer on the Connection generation and
  // throws a superseded read when it was replaced. The controller must stay
  // silent: the new generation owns its own truth, and notifying "Answer
  // queued" would repaint a surface the completion no longer describes.
  const snapshot: QuestionSurfaceSnapshot = {
    sessionId: 'session-a',
    active: [{ callId: 'call-continued', sessionId: 'session-a', questions: QUESTIONS, state: 'continued' }],
    settled: [],
    queuedReplyCallIds: new Set(),
  }
  const h = harness({
    snapshot,
    answerContinued: async () => { throw new SupersededReadError('the generation changed') },
  })
  h.controller.reconcile()
  await Promise.resolve()
  assert.equal(h.asks.length, 1)
  h.submit([{ id: 'q1', selected: ['a'] }])
  await new Promise<void>((resolve) => { setTimeout(resolve, 10) })
  assert.deepEqual(h.notices, [], 'a superseded completion produces no user-facing claim')
})
