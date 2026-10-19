/**
 * Continued-Question PARK / REOPEN contract (M3-3B addendum
 * `dsh-pi-tui-m3-3b-question-park-task-center-addendum-20260930.md` §16.1).
 *
 * The controller owns: authority interpretation, visible vs parked presentation,
 * the preserved local draft, and the explicit reopen. Task Center is the only
 * keyboard reopen path — these tests never call a reconcile trigger manually on
 * behalf of production, and they never wait for an unrelated event to pop a
 * parked Question back.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { AskUserQuestionAnswer, AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import { QuestionSurfaceController } from '../src/app/surface/question-controller.ts'
import type {
  PendingQuestionView,
  QuestionInteractionPort,
  QuestionRequestView,
  QuestionSurfaceSnapshot,
  QuestionWaitClaim,
  UserQuestionProvider,
} from '../src/runtime/interaction-port.ts'
import type { TuiQuestion, TuiQuestionAnswer, TuiQuestionStatus } from '../src/tui-app.ts'
import type { QuestionFlowDraft } from '../src/tui/interaction/question.ts'
import type { Diag } from '../src/runtime/process/diagnostics.ts'

const SILENT_DIAG: Diag = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

const QUESTIONS: readonly AskUserQuestionItem[] = [
  { id: 'q1', question: 'Use staging or production?' },
]

const CONTINUED_CALL = 'call-continued'
const SESSION = 'session-a'

interface AskRecord {
  readonly questions: readonly TuiQuestion[]
  readonly signal: AbortSignal | undefined
  readonly status: TuiQuestionStatus
}

/** One controllable fake Question port + ask hook (park/reopen focused). */
function harness(options: {
  answerContinued?: (sessionId: string, callId: string, answer: AskUserQuestionAnswer) => Promise<'queued' | 'not-continued'>
  /** The Host wait claim a timed live request receives. */
  claim?: QuestionWaitClaim | undefined
} = {}) {
  let provider: UserQuestionProvider | undefined
  let snapshot: QuestionSurfaceSnapshot | undefined
  let currentSession: string | undefined = SESSION
  let subscribers: Array<() => void> = []
  const subscribed: string[] = []
  const unsubscribed: string[] = []
  const asks: AskRecord[] = []
  /** The lifetimes the controller withdrew the PRESENTATION for (B3 finding C). */
  /** The lifetimes the CALLER withdrew after collecting them (production order). */
  const withdrawals: AbortSignal[] = []
  const notices: string[] = []
  const answered: Array<{ sessionId: string; callId: string }> = []
  let pendingAsk: { resolve: (answers: TuiQuestionAnswer[]) => void; reject: (error: unknown) => void } | undefined

  const port: QuestionInteractionPort = {
    onRequest: (next) => { provider = next; return true },
    subscribe: (sessionId, listener) => {
      subscribed.push(sessionId)
      subscribers.push(listener)
      return () => {
        unsubscribed.push(sessionId)
        subscribers = subscribers.filter(entry => entry !== listener)
      }
    },
    snapshot: () => snapshot,
    claimTimedWait: async (): Promise<QuestionWaitClaim | undefined> => options.claim,
    answerContinued: async (sessionId, callId, answer) => {
      answered.push({ sessionId, callId })
      return options.answerContinued === undefined ? 'queued' : options.answerContinued(sessionId, callId, answer)
    },
  }
  const controller = new QuestionSurfaceController({
    port,
    ask: (questions, signal, status) => new Promise<TuiQuestionAnswer[]>((resolve, reject) => {
      asks.push({ questions, signal, status })
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
    now: () => 1_000,
    tickMs: 5,
    continuedDeadlineMs: 100,
  })
  return {
    controller,
    port,
    asks,
    withdrawals,
    notices,
    answered,
    /** Install the authority the port serves. */
    setSnapshot: (next: QuestionSurfaceSnapshot | undefined) => { snapshot = next },
    attach: () => controller.attach(),
    /** The port's projection notification (production: the Client/Host feed). */
    notifyChange: () => { for (const listener of [...subscribers]) listener() },
    setSession: (sessionId: string | undefined) => { currentSession = sessionId },
    subscribed: () => [...subscribed],
    unsubscribed: () => [...unsubscribed],
    attention: () => controller.attentionRows(),
    /** Deliver one live request through the registered provider. */
    live: (request: QuestionRequestView) => provider!(request, async () => ({ answers: [] })),
    submit: (answers: TuiQuestionAnswer[]) => pendingAsk?.resolve(answers),
    cancel: () => pendingAsk?.reject(new Error('question flow cancelled')),
  }
}

/** One authoritative surface with a single continued call. */
function continuedSurface(options: {
  presentation?: 'visible' | 'parked'
  queued?: readonly string[]
  settled?: boolean
  callId?: string
  questions?: readonly AskUserQuestionItem[]
} = {}): QuestionSurfaceSnapshot {
  const callId = options.callId ?? CONTINUED_CALL
  const settled = options.settled === true
  return {
    sessionId: SESSION,
    active: settled
      ? []
      : [{
          callId,
          sessionId: SESSION,
          questions: options.questions ?? QUESTIONS,
          state: 'continued',
        } satisfies PendingQuestionView],
    settled: settled
      ? [{ callId, sessionId: SESSION, answers: [{ id: 'q1', selected: ['a'] }] }]
      : [],
    queuedReplyCallIds: new Set(options.queued ?? []),
  }
}

const settleFrames = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
}

const draftOf = (custom: string): QuestionFlowDraft => ({
  tab: 0,
  answers: [{ selected: ['a'], custom, skipped: false }],
})

test('cold attach discovers a continued Question PARKED, not visible', async () => {
  // Discovery must not steal the editor seat: the user may not even be looking
  // at the session (addendum §13.2).
  const h = harness()
  h.setSnapshot(continuedSurface())
  h.attach()
  await settleFrames()
  assert.equal(h.asks.length, 0, 'no form is mounted on cold discovery')
  assert.deepEqual(h.attention(), [
    { sessionId: SESSION, callId: CONTINUED_CALL, questions: QUESTIONS, presentation: 'parked' },
  ])
  assert.equal(h.subscribed()[0], SESSION, 'the surface observes the current session')
})

test('a live foreground timeout transition keeps the continued form VISIBLE', async () => {
  // Exception to the cold rule (§4.1): the user was already handling this call,
  // so the continued form is offered again instead of being parked away.
  const ended = Promise.withResolvers<void>()
  const h = harness({
    claim: { remainingMs: 60_000, ended: ended.promise, release: () => {} },
  })
  h.attach()
  const pending = h.live({ sessionId: SESSION, callId: CONTINUED_CALL, timed: true, questions: QUESTIONS })
  await settleFrames()
  assert.equal(h.asks.length, 1, 'the live timed request owns the seat')
  const expectsAbort = assert.rejects(() => pending, () => true)
  // The Host ends the foreground wait and authority exposes the call as
  // continued; the surface re-derives that in the same transition.
  h.setSnapshot(continuedSurface())
  ended.resolve()
  await expectsAbort
  await settleFrames()
  assert.deepEqual(h.attention().map(row => row.presentation), ['visible'])
  assert.equal(h.asks.length, 2, 'the continued form is mounted for the user already handling it')
})

test('Esc PARKS a continued form: no answer is sent and the draft survives', async () => {
  const h = harness()
  h.setSnapshot(continuedSurface())
  h.attach()
  const reopened = h.controller.reopen(SESSION, CONTINUED_CALL)
  assert.equal(reopened, true)
  await settleFrames()
  assert.equal(h.asks.length, 1)
  assert.equal(h.attention()[0]?.presentation, 'visible')

  // The flow reports progress, then the user hits Esc.
  h.asks[0]!.status.onDraftChange?.(draftOf('half typed'))
  h.cancel()
  await settleFrames()
  assert.deepEqual(h.answered, [], 'parking never answers the question')
  assert.equal(h.attention()[0]?.presentation, 'parked')
  assert.match(h.notices.join('\n'), /parked — ↓ Quick Tasks or \/tasks/u)
})

test('a parked Question stays parked across reconcile, projection and session events', async () => {
  const h = harness()
  h.setSnapshot(continuedSurface())
  h.attach()
  h.controller.reopen(SESSION, CONTINUED_CALL)
  await settleFrames()
  h.cancel()
  await settleFrames()
  assert.equal(h.asks.length, 1, 'parked: no form mounted')

  // Unrelated authority refreshes and ordinary session events must NOT reopen.
  for (let i = 0; i < 3; i += 1) {
    h.setSnapshot(continuedSurface())
    h.notifyChange()
    h.controller.reconcile()
    await settleFrames()
  }
  assert.equal(h.asks.length, 1, 'a parked Question never pops back on its own')
  assert.equal(h.attention()[0]?.presentation, 'parked')
})

test('reopen() makes a parked Question visible again with its preserved draft', async () => {
  const h = harness()
  h.setSnapshot(continuedSurface())
  h.attach()
  h.controller.reopen(SESSION, CONTINUED_CALL)
  await settleFrames()
  h.asks[0]!.status.onDraftChange?.(draftOf('half typed'))
  h.cancel()
  await settleFrames()

  assert.equal(h.controller.reopen(SESSION, CONTINUED_CALL), true)
  await settleFrames()
  assert.equal(h.asks.length, 2, 'the parked form is mounted again')
  assert.deepEqual(h.asks[1]!.status.initialDraft, draftOf('half typed'),
    'the user keeps their answers, free text and current question')
  assert.equal(h.attention()[0]?.presentation, 'visible')
})

test('reopen() while already visible reasserts instead of duplicating the flow', async () => {
  const h = harness()
  h.setSnapshot(continuedSurface())
  h.attach()
  assert.equal(h.controller.reopen(SESSION, CONTINUED_CALL), true)
  await settleFrames()
  assert.equal(h.controller.reopen(SESSION, CONTINUED_CALL), true)
  await settleFrames()
  assert.equal(h.asks.length, 1, 'one (sessionId, callId) owns at most one editable flow')
})

test('reopen() fails closed when authority moved on (stale row)', async () => {
  const h = harness()
  h.setSnapshot(continuedSurface())
  h.attach()
  await settleFrames()
  // Another client queues a reply (or the call settles) before Enter.
  h.setSnapshot(continuedSurface({ queued: [CONTINUED_CALL] }))
  assert.equal(h.controller.reopen(SESSION, CONTINUED_CALL), false)
  await settleFrames()
  assert.equal(h.asks.length, 0, 'a stale reopen creates no panel')
  h.setSnapshot(continuedSurface({ settled: true }))
  assert.equal(h.controller.reopen(SESSION, CONTINUED_CALL), false)
  assert.equal(h.controller.reopen('other-session', CONTINUED_CALL), false, 'another session never reopens this row')
})

test('a queued reply removes the entry and its Task Center attention', async () => {
  const h = harness()
  h.setSnapshot(continuedSurface())
  h.attach()
  h.controller.reopen(SESSION, CONTINUED_CALL)
  await settleFrames()
  const signal = h.asks[0]!.signal!
  h.setSnapshot(continuedSurface({ queued: [CONTINUED_CALL] }))
  h.notifyChange()
  await settleFrames()
  assert.equal(signal.aborted, true, 'the mounted form is withdrawn')
  assert.deepEqual(h.attention(), [], 'no attention row survives')
  assert.match(h.notices.join('\n'), /reply for this question is already queued/u)
  assert.deepEqual(h.answered, [])
})

test('a settled question removes the entry and its Task Center attention', async () => {
  const h = harness()
  h.setSnapshot(continuedSurface())
  h.attach()
  h.controller.reopen(SESSION, CONTINUED_CALL)
  await settleFrames()
  const signal = h.asks[0]!.signal!
  h.setSnapshot(continuedSurface({ settled: true }))
  h.notifyChange()
  await settleFrames()
  assert.equal(signal.aborted, true)
  assert.deepEqual(h.attention(), [])
  assert.match(h.notices.join('\n'), /no longer awaiting an answer/u)
})

test('a vanished call removes the entry without a notice', async () => {
  const h = harness()
  h.setSnapshot(continuedSurface())
  h.attach()
  await settleFrames()
  h.setSnapshot({ sessionId: SESSION, active: [], settled: [], queuedReplyCallIds: new Set() })
  h.notifyChange()
  await settleFrames()
  assert.deepEqual(h.attention(), [])
  assert.deepEqual(h.notices, [])
})

test('session navigation never leaks Question rows between sessions', async () => {
  const h = harness()
  h.setSnapshot(continuedSurface())
  h.attach()
  await settleFrames()
  assert.equal(h.attention().length, 1)

  // Switch away: the old session's row is not this surface's business.
  h.setSession('session-b')
  h.setSnapshot({ sessionId: 'session-b', active: [], settled: [], queuedReplyCallIds: new Set() })
  h.notifyChange()
  await settleFrames()
  assert.deepEqual(h.attention(), [], 'no row leaks into the new session')
  assert.deepEqual(h.unsubscribed(), [SESSION], 'the old observation is released')
  assert.deepEqual(h.subscribed(), [SESSION, 'session-b'])

  // Switch back: the still-continued Question is exposed PARKED again.
  h.setSession(SESSION)
  h.setSnapshot(continuedSurface())
  h.notifyChange()
  await settleFrames()
  assert.deepEqual(h.attention(), [
    { sessionId: SESSION, callId: CONTINUED_CALL, questions: QUESTIONS, presentation: 'parked' },
  ])
})

test('multiple continued Questions coexist and reopen independently', async () => {
  const h = harness()
  h.setSnapshot({
    sessionId: SESSION,
    active: [
      { callId: 'call-1', sessionId: SESSION, questions: QUESTIONS, state: 'continued' },
      { callId: 'call-2', sessionId: SESSION, questions: [{ id: 'q2', question: 'Which region?' }], state: 'continued' },
    ],
    settled: [],
    queuedReplyCallIds: new Set(),
  })
  h.attach()
  await settleFrames()
  assert.equal(h.attention().length, 2, 'every pending Question is represented')

  assert.equal(h.controller.reopen(SESSION, 'call-2'), true)
  await settleFrames()
  assert.equal(h.asks.length, 1, 'one flow at a time')
  assert.deepEqual(h.attention().map(row => [row.callId, row.presentation]), [
    ['call-1', 'parked'],
    ['call-2', 'visible'],
  ])
})

test('authority becoming unreadable hides rows and withdraws the form (fail closed)', async () => {
  const h = harness()
  h.setSnapshot(continuedSurface())
  h.attach()
  h.controller.reopen(SESSION, CONTINUED_CALL)
  await settleFrames()
  const signal = h.asks[0]!.signal!
  h.setSnapshot(undefined)
  h.notifyChange()
  await settleFrames()
  assert.equal(signal.aborted, true, 'a form cannot outlive its authority')
  assert.deepEqual(h.attention(), [], 'rows never outlive the truth that produced them')
  assert.deepEqual(h.answered, [])

  // Recovery: still continued and still parked (a reconnect is not a reopen).
  h.setSnapshot(continuedSurface())
  h.notifyChange()
  await settleFrames()
  assert.deepEqual(h.attention().map(row => row.presentation), ['parked'])
  assert.equal(h.asks.length, 1, 'reconnect alone never remounts the form')
})

test('dispose releases the observation and every entry', async () => {
  const h = harness()
  h.setSnapshot(continuedSurface())
  h.attach()
  h.controller.reopen(SESSION, CONTINUED_CALL)
  await settleFrames()
  const signal = h.asks[0]!.signal!
  h.controller.dispose()
  await settleFrames()
  assert.equal(signal.aborted, true)
  assert.deepEqual(h.attention(), [])
  assert.deepEqual(h.unsubscribed(), [SESSION])
})

test('an answer submitted through the reopened form is delivered exactly once', async () => {
  const h = harness()
  const notifications: number[] = []
  h.controller.subscribeAttention(() => { notifications.push(h.attention().length) })
  h.setSnapshot(continuedSurface())
  h.attach()
  h.controller.reopen(SESSION, CONTINUED_CALL)
  await settleFrames()
  h.submit([{ id: 'q1', selected: ['a'] }])
  await settleFrames()
  assert.deepEqual(h.answered, [{ sessionId: SESSION, callId: CONTINUED_CALL }])
  assert.deepEqual(h.attention(), [], 'the submitted interaction is spent')
  // Chrome that mirrors the attention count must be invalidated by the removal
  // itself, not by whatever projection refresh happens to come next.
  assert.deepEqual(notifications, [1, 1, 0])
})

test('a refused answer batch parks the entry instead of looping', async () => {
  const h = harness({
    answerContinued: async () => { throw new Error('batch refused') },
  })
  h.setSnapshot(continuedSurface())
  h.attach()
  h.controller.reopen(SESSION, CONTINUED_CALL)
  await settleFrames()
  h.submit([{ id: 'q1', selected: ['a'] }])
  await settleFrames()
  assert.equal(h.attention()[0]?.presentation, 'parked', 'no silent re-presentation loop')
  assert.equal(h.asks.length, 1)
})

test('the attention subscription fires on every actionable change', async () => {
  const h = harness()
  const notifications: number[] = []
  h.controller.subscribeAttention(() => { notifications.push(h.attention().length) })
  h.setSnapshot(continuedSurface())
  h.attach()
  await settleFrames()
  assert.deepEqual(notifications, [1], 'discovery notifies once')

  h.controller.reopen(SESSION, CONTINUED_CALL)
  await settleFrames()
  assert.deepEqual(notifications, [1, 1], 'a presentation change notifies (visible vs parked)')

  h.setSnapshot(continuedSurface({ settled: true }))
  h.notifyChange()
  await settleFrames()
  assert.deepEqual(notifications, [1, 1, 0], 'removal notifies once')
})

test('a direct ask on an unknown call never fabricates an entry', async () => {
  const h = harness()
  h.attach()
  await settleFrames()
  assert.equal(h.controller.reopen(SESSION, 'never-seen'), false)
  assert.deepEqual(h.attention(), [])
  assert.equal(h.asks.length, 0)
})

// ── PR3-B B3 (finding C): the presentation-only withdrawal of a replaced flow ─

test('PR3-B B3: a live flow whose Session no longer owns the surface is withdrawn WITHOUT settling its request', async () => {
  const h = harness()
  h.attach()
  await settleFrames()
  const abort = new AbortController()
  const pending = h.live({ sessionId: SESSION, callId: 'call-live', timed: false, questions: QUESTIONS, signal: abort.signal })
  await settleFrames()
  assert.equal(h.asks.length, 1, 'the live foreground form is presented')

  // A replacement Session takes the surface: the controller COLLECTS the exact
  // lifetime the presenter received, and the caller withdraws it (the production
  // ordering — one batched presentation withdrawal).
  h.setSession('session-b')
  const collected = h.controller.withdrawReplacedPresentation()
  assert.equal(collected.dropped, true, 'the replaced flow left the model')
  assert.deepEqual(collected.lifetimes, [h.asks[0]?.signal], 'the withdrawal names the exact presented lifetime')
  h.withdrawals.push(...collected.lifetimes)

  // PRESENTATION only: the official request keeps its own lifetime, so the
  // withdrawal itself settles nothing.
  let settledAs: string | undefined
  void pending.then(
    () => { settledAs = 'answered' },
    (error: unknown) => { settledAs = String((error as { readonly code?: unknown }).code) },
  )
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settledAs, undefined, 'the withdrawal never settles the official request')

  // Its OWN lifetime still ends it, classified exactly like any Host abort.
  abort.abort()
  await settleFrames()
  assert.equal(settledAs, 'ASK_ABORTED', 'the Host end classifies the withdrawn request ASK_ABORTED')
  assert.equal(h.notices.some(text => text.includes('cancelled')), false,
    'a replaced session is never reported to the user as a cancellation')
})

// ── PR3-B B3: the same controller driving the REAL TSP interaction seat ──────

test('PR3-B B3: the REAL TSP seat parks a continued form on Esc and reopens it with the preserved draft', async () => {
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
  let snapshot: QuestionSurfaceSnapshot | undefined = continuedSurface()
  const delivered: AskUserQuestionAnswer[] = []
  const controller = new QuestionSurfaceController({
    port: {
      onRequest: () => true,
      subscribe: () => () => {},
      snapshot: () => snapshot,
      claimTimedWait: async () => undefined,
      answerContinued: async (_sessionId, _callId, answer) => {
        delivered.push(answer)
        return 'queued'
      },
    },
    ask: (questions, signal, status, agentInputWait) => seat.presenter.askQuestions(questions, signal, status, agentInputWait),
    notify: () => {},
    repaint: () => {},
    currentSessionId: () => SESSION,
    isAdmissibleSession: sessionId => sessionId === SESSION,
    diag: SILENT_DIAG,
  })
  try {
    controller.attach()
    // The cold discovery PARKS the call: no form is presented yet.
    assert.equal(seat.hasModalSeat(), false, 'a cold continued call never steals the seat')
    assert.equal(controller.attentionRows().filter(row => row.presentation === 'parked').length, 1)

    // The explicit reopen presents the REAL seat.
    assert.equal(controller.reopen(SESSION, CONTINUED_CALL), true)
    assert.equal(seat.hasModalSeat(), true, 'the reopened form owns the seat')

    // A real edit, then Esc: the controller parks the form (never cancels the Host).
    seat.handleKey(key('x', { text: 'x' }), callbacks)
    // An OPTIONLESS question's first Esc leaves the free-text edit (the text
    // survives); the second one cancels the form, which the controller parks.
    seat.handleKey(key('escape'), callbacks)
    seat.handleKey(key('escape'), callbacks)
    await settleFrames()
    assert.equal(seat.hasModalSeat(), false, 'Esc withdrew the form')
    assert.equal(controller.attentionRows().filter(row => row.presentation === 'parked').length, 1,
      'the parked entry is still the authority')

    // Reopen: the seat must restore the DRAFT the controller kept.
    assert.equal(controller.reopen(SESSION, CONTINUED_CALL), true)
    assert.equal(seat.hasModalSeat(), true)
    seat.handleKey(key('enter'), callbacks)   // confirm the restored free text
    seat.handleKey(key('enter'), callbacks)   // submit the batch from review
    await settleFrames()
    assert.equal(delivered.length, 1, 'the late answer was delivered exactly once')
    assert.deepEqual(delivered[0]?.answers, [{ id: 'q1', selected: [], custom: 'x' }],
      'the draft preserved across park/reopen is the real answer')
  } finally {
    controller.dispose()
    seat.dispose()
  }
})

test('PR3-B B3 finding F7: a held timed claim retired by a publication never mounts its form (and is not revived)', async () => {
  const { createTspInteractionSeat } = await import('../src/tui/tsp/interaction.ts')
  const seat = createTspInteractionSeat({
    render: () => {},
    onFatal: () => {},
    notify: () => {},
    setSettledQuestionAnswersLookup: () => {},
  })
  let releaseClaim: (() => void) | undefined
  const claimHeld = new Promise<void>(resolve => { releaseClaim = resolve })
  /** The lifetimes the CALLER withdrew after collecting them (production order). */
  const withdrawals: AbortSignal[] = []
  // The exact lifetime the presenter receives (the controller's combined
  // local+request signal, built BEFORE the claim): the withdrawal must name it.
  let presentedLifetime: AbortSignal | undefined
  let provider: UserQuestionProvider | undefined
  // A HELD claim opening: the controller is parked inside `claimTimedWait` when
  // the replacement Session is published — the exact F7 window.
  const controller = new QuestionSurfaceController({
    port: {
      onRequest: (next) => { provider = next; return true },
      subscribe: () => () => {},
      snapshot: () => undefined,
      claimTimedWait: async () => { await claimHeld; return undefined },
      answerContinued: async () => 'queued',
    },
    ask: (questions, signal, status, agentInputWait) => {
      presentedLifetime = signal
      return seat.presenter.askQuestions(questions, signal, status, agentInputWait)
    },
    notify: () => {},
    repaint: () => {},
    currentSessionId: () => currentSession,
    isAdmissibleSession: sessionId => sessionId === currentSession,
    diag: SILENT_DIAG,
  })
  let currentSession: string | undefined = SESSION
  const abort = new AbortController()
  // The outcome is observed FROM THE START (a failure path must never leave an
  // unobserved rejection), and the held claim always has a fallback release in
  // the test's own cleanup.
  let settledAs: string | undefined
  let pending: Promise<AskUserQuestionAnswer> | undefined
  try {
    controller.attach()
    pending = provider!({
      sessionId: SESSION,
      callId: 'call-held-claim',
      timed: true,
      questions: QUESTIONS,
      signal: abort.signal,
    }, async () => ({ answers: [] }))
    const observed = pending
    void observed.then(
      () => { settledAs = 'answered' },
      (error: unknown) => { settledAs = String((error as { readonly code?: unknown }).code) },
    )
    await settleFrames()
    assert.equal(seat.hasModalSeat(), false, 'the flow is still opening its claim: nothing is presented yet')

    // The replacement Session is published while the claim is still opening.
    currentSession = 'session-b'
    const collected = controller.withdrawReplacedPresentation()
    seat.presenter.withdrawPresentations(collected.lifetimes)
    withdrawals.push(...collected.lifetimes)
    assert.equal(withdrawals.length, 1, 'the opening flow IS retired by the publication (registered before the await)')

    // The claim finally lands: the presenter is reached, but the form must never
    // mount — and the retirement named exactly the lifetime it received.
    releaseClaim!()
    await settleFrames()
    assert.notEqual(presentedLifetime, undefined, 'the retired flow still reached its own request')
    assert.equal(withdrawals[0], presentedLifetime, 'the retirement names the exact lifetime the presenter received')
    assert.equal(seat.hasModalSeat(), false, 'a retired flow never mounts after its claim resolves')
    assert.equal(settledAs, undefined, 'the official request keeps its own lifetime (no fabricated settlement)')

    // Returning to A does NOT revive the retired flow: only a fresh authority
    // (a projection offer) may present something, and this call offers none.
    currentSession = SESSION
    controller.reconcile()
    await settleFrames()
    assert.equal(seat.hasModalSeat(), false, 'the retired flow is never revived by the return')
    assert.equal(settledAs, undefined, 'and it is still pending after the return')

    // Its OWN lifetime ends it, classified like any Host abort.
    abort.abort()
    await settleFrames()
    assert.equal(settledAs, 'ASK_ABORTED', 'the Host end classifies the retired flow ASK_ABORTED')
  } finally {
    // A held gate always has a fallback release: a failing assertion must never
    // leave the mock's claim opening unresolved.
    releaseClaim?.()
    await settleFrames()
    controller.dispose()
    seat.dispose()
  }
})
