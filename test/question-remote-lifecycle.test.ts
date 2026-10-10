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
import type { Diag } from '../src/runtime/process/diagnostics.ts'

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
  answerContinued?: (sessionId: string, callId: string, answer: AskUserQuestionAnswer) => Promise<'queued' | 'not-continued'>
  /** Make the projection unsubscribe throw AFTER doing its real release (the
   *  M3-6 PR3 partial-disposer fault injection). */
  unsubscribeFailure?: Error
} = {}) {
  let provider: UserQuestionProvider | undefined
  const asks: AskRecord[] = []
  const notices: string[] = []
  const answered: Array<{ sessionId: string; callId: string }> = []
  let clock = 1_000
  const claimSignals: Array<AbortSignal | undefined> = []
  // The projection read is installed by the test AFTER construction, so each
  // test chooses whether the COLD attach-time reconcile sees a snapshot
  // (production always has one by then — `initLiveSession` precedes
  // `attachInteraction`).
  let snapshot: QuestionSurfaceSnapshot | undefined
  let currentSession: string | undefined = 'session-a'
  const subscribed: string[] = []
  const unsubscribed: string[] = []
  let subscribers: Array<() => void> = []
  const port: QuestionInteractionPort = {
    onRequest: (next) => { provider = next; return true },
    subscribe: (sessionId, listener) => {
      subscribed.push(sessionId)
      subscribers.push(listener)
      return () => {
        unsubscribed.push(sessionId)
        subscribers = subscribers.filter(entry => entry !== listener)
        if (options.unsubscribeFailure !== undefined) throw options.unsubscribeFailure
      }
    },
    snapshot: () => snapshot,
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
    currentSessionId: () => currentSession,
    isAdmissibleSession: sessionId => sessionId === currentSession,
    diag: SILENT_DIAG,
    now: () => clock,
    tickMs: 5,
    continuedDeadlineMs: 100,
  })
  let pendingAsk: { resolve: (answers: TuiQuestionAnswer[]) => void; reject: (error: unknown) => void } | undefined
  return {
    controller,
    port,
    claimSignals,
    /** Install the projection the port serves (call BEFORE attach to model the
     *  cold path, or after to model a later reconcile). */
    setSnapshot: (next: QuestionSurfaceSnapshot | undefined) => { snapshot = next },
    /** Register the live channel (production: `attachInteraction`). */
    attach: () => controller.attach(),
    /** The sessions this controller is observing right now. */
    subscribed: () => [...subscribed],
    unsubscribed: () => [...unsubscribed],
    /** Fire the port's projection notification (production: the Client/Host
     *  projection change feed) WITHOUT any Session event or manual reconcile. */
    notifyChange: () => { for (const listener of [...subscribers]) listener() },
    /** Switch the current session like a real session navigation. */
    setSession: (sessionId: string | undefined) => { currentSession = sessionId },
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
  h.attach()
  h.attach()
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
  h.attach()
  h.attach()
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
  cancelled.attach()
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
  aborted.attach()
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
  h.attach()
  h.attach()
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

test('dispose releases controller state and stops offering questions', async () => {
  const snapshot: QuestionSurfaceSnapshot = {
    sessionId: 'session-a',
    active: [{ callId: 'call-continued', sessionId: 'session-a', questions: QUESTIONS, state: 'continued' }],
    settled: [],
    queuedReplyCallIds: new Set(),
  }
  const h = harness()
  h.setSnapshot(snapshot)
  h.controller.dispose()
  h.attach()
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
  h.attach()
  h.attach()
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
  const h = harness({ claim })
  h.attach()
  const pending = h.live({ sessionId: 'session-a', callId: 'call-1', timed: true, questions: QUESTIONS })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(h.asks.length, 1, 'only the live request is mounted while the wait is open')

  const expectsAbort = assert.rejects(() => pending, (error: unknown) => {
    assert.equal((error as { code?: string }).code, ASK_ABORTED, 'a Host-driven end is an abort, not a user cancel')
    assert.notEqual((error as { code?: string }).code, ASK_CANCELLED)
    return true
  })
  // The projection exposes the call as `continued` only once the Host closed
  // the wait — that is the authority the late answer is offered from.
  h.setSnapshot(snapshot)
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

/** One authoritative surface with a single continued call. */
function continuedSurface(options: { queued?: readonly string[]; settled?: boolean } = {}): QuestionSurfaceSnapshot {
  const settled = options.settled === true
  return {
    sessionId: 'session-a',
    active: settled ? [] : [{ callId: 'call-continued', sessionId: 'session-a', questions: QUESTIONS, state: 'continued' }],
    settled: settled
      ? [{ callId: 'call-continued', sessionId: 'session-a', answers: [{ id: 'q1', selected: ['a'] }] }]
      : [],
    queuedReplyCallIds: new Set(options.queued ?? []),
  }
}

const settleFrames = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
}


test('M3-6 PR2 (review F3): a proven settlement does not notify the REPLACEMENT subject\'s surface after a session switch', async () => {
  // The adapter keeps the dispatched settlement real (no post-dispatch
  // generation re-check); the CONSUMER must therefore own the visibility
  // fence. When the answer was dispatched for session A's continued call and
  // the surface switched to session B while the settlement was in flight,
  // reconcile deletes A's entry — B's surface must NOT see A's "Answer
  // queued" notice. The same retained-session reconnect case stays positive
  // in the mounted L6 (runner-remote-permission).
  let releaseSettlement: (() => void) | undefined
  const settlementGate = new Promise<void>(resolve => { releaseSettlement = resolve })
  const h = harness({
    answerContinued: async (sessionId, callId) => {
      assert.equal(sessionId, 'session-a')
      assert.equal(callId, 'call-f3')
      await settlementGate
      return 'queued'
    },
  })
  // The projection shows session A's continued call; the form is mounted.
  h.setSnapshot({
    sessionId: 'session-a',
    active: [{ sessionId: 'session-a', callId: 'call-f3', state: 'continued', questions: QUESTIONS as never }],
    settled: [],
    queuedReplyCallIds: new Set<string>(),
  })
  h.attach()
  h.controller.reconcile()
  const reopened = h.controller.reopen('session-a', 'call-f3')
  assert.equal(reopened, true, 'the continued form mounts for the current session')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.asks.length, 1, 'the form is up')

  // Answer submitted; wait for the AUTHORITATIVE dispatch marker
  // (`answered` is appended by the port when `answerContinued` is entered,
  // BEFORE the held settlement), so the switch below happens strictly AFTER
  // the dispatch — the window the finding is about. Pure microtask drain: no
  // timer, and the held gate guarantees the settlement is still in flight.
  h.submit([{ id: 'q1', selected: ['A'] }] as never)
  for (let i = 0; i < 50 && h.answered.length === 0; i += 1) await Promise.resolve()
  assert.deepEqual(h.answered, [{ sessionId: 'session-a', callId: 'call-f3' }],
    'the answer dispatch must have happened before the switch (authoritative marker)')

  // The surface switches to session B: reconcile drops A's entries.
  h.setSession('session-b')
  h.setSnapshot({
    sessionId: 'session-b',
    active: [{ sessionId: 'session-b', callId: 'call-b', state: 'continued', questions: QUESTIONS as never }],
    settled: [],
    queuedReplyCallIds: new Set<string>(),
  })
  h.controller.reconcile()

  // The proven settlement lands: A's entry is gone, so B's surface must not
  // be notified about it.
  releaseSettlement!()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(h.notices.some(text => text.includes('Answer queued')), false,
    'the replacement subject\'s surface never sees the old subject\'s settlement notice')
})

test('M3-6 PR2 (review F3b): a superseded settlement never retires a NEWER entry for the same call', async () => {
  // The reachable sequence the entry-mutation fence exists for: session A's
  // continued answer is dispatched and the Host accepts it (settlement held);
  // the queued reply reaches the projection; the user then DISCARDS that
  // queued reply (official inbox discard), so the call becomes answerable
  // again; reconcile creates a NEW entry for the SAME (session, call) and the
  // user reopens it. When the OLD settlement finally lands it must neither
  // notify (identity fence) nor DELETE/ABORT the newer live form.
  let releaseSettlement: (() => void) | undefined
  const settlementGate = new Promise<void>(resolve => { releaseSettlement = resolve })
  const h = harness({ answerContinued: async () => { await settlementGate; return 'queued' } })
  const drain = async (): Promise<void> => { for (let i = 0; i < 50; i += 1) await Promise.resolve() }
  const continuedCall = (): never => ({ sessionId: 'session-a', callId: 'call-f3b', state: 'continued', questions: QUESTIONS }) as never

  // A's continued form is mounted and the answer dispatched (held).
  h.setSnapshot({
    sessionId: 'session-a',
    active: [continuedCall()],
    settled: [],
    queuedReplyCallIds: new Set<string>(),
  })
  h.attach()
  h.controller.reconcile()
  assert.equal(h.controller.reopen('session-a', 'call-f3b'), true, 'the first form mounts')
  await drain()
  h.submit([{ id: 'q1', selected: ['A'] }] as never)
  for (let i = 0; i < 50 && h.answered.length === 0; i += 1) await Promise.resolve()
  assert.equal(h.answered.length, 1, 'the dispatch happened before the reply is discarded')

  // The queued reply reaches the projection: reconcile retires the old entry.
  h.setSnapshot({
    sessionId: 'session-a',
    active: [{ sessionId: 'session-a', callId: 'call-f3b', state: 'continued', questions: QUESTIONS as never }],
    settled: [],
    queuedReplyCallIds: new Set(['call-f3b']),
  })
  h.controller.reconcile()
  assert.equal(h.controller.attentionRows().length, 0, 'the queued reply retires the old entry')

  // The user discards the queued reply: the call is answerable again, so
  // reconcile creates a NEW entry for the SAME call, which the user reopens.
  h.setSnapshot({
    sessionId: 'session-a',
    active: [continuedCall()],
    settled: [],
    queuedReplyCallIds: new Set<string>(),
  })
  h.controller.reconcile()
  assert.equal(h.controller.attentionRows().length, 1, 'the re-answerable call offers a new entry')
  assert.equal(h.controller.reopen('session-a', 'call-f3b'), true, 'the newer form mounts')
  await drain()
  const newerSignal = h.asks.at(-1)?.signal
  assert.equal(newerSignal?.aborted, false, 'the newer form is live')

  // The OLD settlement lands: it must not touch the newer entry.
  releaseSettlement!()
  await drain()
  assert.equal(newerSignal?.aborted, false,
    'the superseded settlement must not abort the newer form')
  assert.equal(h.controller.attentionRows().length, 1,
    'the superseded settlement must not delete the newer entry')
  assert.equal(h.notices.some(text => text.includes('Answer queued')), false,
    'the superseded settlement is still not announced on the current surface')
})

test('M3-6 PR3: a throwing projection unsubscribe cannot strand the mounted form abort or the active cleanup', async () => {
  const failure = new Error('projection unsubscribe failed')
  let released = 0
  const claim: QuestionWaitClaim = { remainingMs: 60_000, ended: new Promise(() => {}), release: () => { released += 1 } }
  const h = harness({ claim, unsubscribeFailure: failure })
  h.setSnapshot(continuedSurface())
  h.attach()
  h.controller.reconcile()
  assert.equal(h.controller.reopen('session-a', 'call-continued'), true, 'the continued form mounts')
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  const mountedSignal = h.asks.at(-1)?.signal
  assert.equal(mountedSignal?.aborted, false, 'the continued form is live')

  const live = h.live({ sessionId: 'session-a', callId: 'call-live', timed: true, questions: QUESTIONS })
  // `handleLive` registers its teardown cleanup BEFORE the claim await.
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  assert.equal(h.claimSignals.length, 1, 'the live claim is held')

  assert.throws(() => h.controller.dispose(), (error: unknown) => error === failure)
  assert.equal(released, 1, 'the active cleanup still ran after the throwing unsubscribe')
  assert.equal(mountedSignal?.aborted, true, 'the mounted continued form was still aborted')

  h.controller.dispose()
  assert.equal(released, 1, 'a second disposal is inert')

  await assert.rejects(() => live, (error: unknown) => {
    assert.equal((error as { code?: string }).code, ASK_ABORTED)
    return true
  })
})

// ── PR3-B B3: the timed lifecycle driving the REAL TSP seat ──────────────────

test('PR3-B B3: the timed claim, timeout and continued late answer drive the REAL TSP seat', async () => {
  const { createTspInteractionSeat } = await import('../src/tui/tsp/interaction.ts')
  const seat = createTspInteractionSeat({
    render: () => {},
    onFatal: () => {},
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
  })
  const key = (name: string, extra: Partial<{ text: string; ctrl: boolean; alt: boolean; shift: boolean; meta: boolean }> = {}) =>
    ({ name, ctrl: false, alt: false, shift: false, meta: false, ...extra })
  const callbacks = { listContinuedQuestions: () => [], reopenContinuedQuestion: () => false }
  const renderText = (): string => JSON.stringify(seat.renderLayer())
  let snapshot: QuestionSurfaceSnapshot | undefined
  let clock = 1_000
  let released = 0
  const delivered: AskUserQuestionAnswer[] = []
  const claim: QuestionWaitClaim = {
    remainingMs: 1_000,
    ended: new Promise(() => {}),
    release: () => { released += 1 },
  }
  let provider: UserQuestionProvider | undefined
  const controller = new QuestionSurfaceController({
    port: {
      onRequest: (next) => { provider = next; return true },
      subscribe: () => () => {},
      snapshot: () => snapshot,
      claimTimedWait: async () => claim,
      answerContinued: async (_sessionId, _callId, answer) => { delivered.push(answer); return 'queued' },
    },
    ask: (questions, signal, status, agentInputWait) => seat.presenter.askQuestions(questions, signal, status, agentInputWait),
    notify: () => {},
    repaint: () => {},
    currentSessionId: () => 'session-a',
    isAdmissibleSession: sessionId => sessionId === 'session-a',
    diag: SILENT_DIAG,
    now: () => clock,
    tickMs: 20,
  })
  try {
    controller.attach()
    assert.ok(provider !== undefined)
    const pending = provider!(
      { sessionId: 'session-a', callId: 'call-timed-seat', timed: true, questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'a' }] }] } as never,
      async () => ({ answers: [] }),
    )
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    assert.equal(seat.hasModalSeat(), true, 'the REAL seat presents the live timed form')
    assert.match(renderText(), /Foreground wait/u, "the controller's countdown status is rendered by the seat")

    // The local deadline expires: the seat's form is withdrawn and the request
    // is classified ASK_TIMED_OUT (never a user cancel).
    clock = 5_000
    const timedOut = await pending.then(() => undefined, (error: unknown) => error)
    assert.equal((timedOut as { code?: string }).code, ASK_TIMED_OUT)
    assert.equal(released, 1, 'the claim is released exactly once')
    assert.equal(seat.hasModalSeat(), false, 'the timed-out form left the seat')

    // The Host records the call as continued: the controller re-offers it, and
    // the REAL seat answers the late batch into the official sink.
    snapshot = {
      sessionId: 'session-a',
      active: [{ callId: 'call-timed-seat', sessionId: 'session-a', questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'a' }] }], state: 'continued' }],
      settled: [],
      queuedReplyCallIds: new Set(),
    } as never
    await new Promise<void>((resolve) => { setTimeout(resolve, 400) })
    assert.equal(seat.hasModalSeat(), true, 'the continued form is re-offered to the REAL seat')
    // The seat's keys are the SDK's decoded Key objects, so the name is
    // `enter` (the raw '\r' byte is what the DECODER turns into it).
    seat.handleKey(key('enter'), callbacks)   // adopt 'a'
    seat.handleKey(key('enter'), callbacks)   // submit from review
    await new Promise<void>((resolve) => { setTimeout(resolve, 200) })
    assert.deepEqual(delivered, [{ answers: [{ id: 'q1', selected: ['a'] }] }],
      'the late answer reached the official continued sink exactly once')
  } finally {
    controller.dispose()
    seat.dispose()
  }
})
