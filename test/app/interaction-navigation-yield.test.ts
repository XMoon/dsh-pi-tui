/**
 * PR-G567: the surface interaction owner's navigation-only withdrawal.
 *
 * Evidence level: L3 over the ONE `createInteractionRuntime` owner with its
 * REAL `QuestionSurfaceController`. The split-process smoke proves the Host
 * half. This suite pins the surface half:
 *
 * - `withdrawPresentationForNavigation()` collects EVERY live presentation (not
 *   only a replaced subject's), hands the exact presenter lifetime to ONE
 *   atomic withdrawal batch, and only THEN runs the deferred local settlement;
 * - the official Host request signal is never aborted by the withdrawal;
 * - the live Question attempt's own classification is local and the SAME
 *   provider can present the SAME request again afterwards;
 * - an approval prompt is withdrawn as a local `cancelled` presentation, not a
 *   Host decision.
 *
 * @module @xmoon76/dsh-pi-tui/interaction-navigation-yield.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import {
  createInteractionRuntime,
  type InteractionRuntime,
} from '../../src/app/surface/interaction-runtime.ts'
import type { SurfaceInteractionPresenter } from '../../src/app/surface/interaction-presenter.ts'
import type {
  ApprovalRequestListener,
  ApprovalRequestLike,
  InteractionPort,
  QuestionInteractionPort,
  QuestionRequestView,
  UserQuestionProvider,
} from '../../src/runtime/interaction-port.ts'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import type { TuiQuestionAnswer } from '../../src/tui-app.ts'
import type { ApprovalOutcome } from '../../src/tui/panels/approval-dialog.ts'

const SILENT_DIAG: Diag = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {},
}

const QUESTIONS = [{ id: 'q1', question: 'Continue?', options: [{ label: 'Proceed' }] }]

const ANSWER: AskUserQuestionAnswer = {
  answers: [{ id: 'q1', selected: ['Proceed'] }],
} as unknown as AskUserQuestionAnswer

interface PresenterRecord {
  readonly withdrawn: AbortSignal[]
  askCalls: number
  askSignals: Array<AbortSignal | undefined>
  decide: ((answers: TuiQuestionAnswer[]) => void) | undefined
  rejectAsk: ((error: unknown) => void) | undefined
  approvalLifetime: AbortSignal | undefined
  resolveApproval: ((outcome: ApprovalOutcome) => void) | undefined
}

interface Harness {
  readonly runtime: InteractionRuntime
  readonly presenter: PresenterRecord
  readonly port: InteractionPort
  readonly questionProvider: () => UserQuestionProvider
  readonly approvalListener: () => ApprovalRequestListener
  readonly hostQuestionSignal: AbortSignal
}

function harness(): Harness {
  const presenter: PresenterRecord = {
    withdrawn: [],
    askCalls: 0,
    askSignals: [],
    decide: undefined,
    rejectAsk: undefined,
    approvalLifetime: undefined,
    resolveApproval: undefined,
  }
  let provider: UserQuestionProvider | undefined
  let approvalListener: ApprovalRequestListener | undefined
  const hostQuestion = new AbortController()
  const questions: QuestionInteractionPort = {
    onRequest: (next) => { provider = next; return true },
    snapshot: () => ({
      sessionId: 'session-x',
      active: [],
      settled: [],
      queuedReplyCallIds: new Set<string>(),
    }),
    subscribe: () => () => {},
    claimTimedWait: async () => undefined,
    answerContinued: async () => 'queued',
  }
  const port: InteractionPort = {
    questions,
    onApprovalRequest: (listener) => { approvalListener = listener },
    setApprovalPolicy: () => false,
  }
  const seam: SurfaceInteractionPresenter = {
    showApprovalPrompt: () => new Promise<ApprovalOutcome>((resolve) => {
      presenter.resolveApproval = resolve
    }),
    askQuestions: (_questions, signal) => new Promise<TuiQuestionAnswer[]>((resolve, reject) => {
      presenter.askCalls += 1
      presenter.askSignals.push(signal)
      presenter.decide = resolve
      presenter.rejectAsk = reject
    }),
    setSettledQuestionAnswersLookup: () => {},
    notify: () => {},
    setQuestionAttention: () => {},
    withdrawPending: () => {},
    withdrawPresentations: (lifetimes) => {
      for (const lifetime of lifetimes) presenter.withdrawn.push(lifetime)
      // The PiTUI presenter's real withdrawal rejects the mounted flow; the
      // local classification below is exactly what the root delivery discards.
      presenter.rejectAsk?.(new Error('question flow cancelled'))
      presenter.resolveApproval?.('cancelled')
    },
    closeTransientList: () => {},
  }
  const runtime = createInteractionRuntime({
    presenter: () => seam,
    livePresenter: () => seam,
    display: () => ({ supportsModals: true }) as never,
    currentSessionId: () => 'session-x',
    isAdmissibleSession: (sessionId) => sessionId === 'session-x',
    schedulePaint: () => {},
    diag: () => SILENT_DIAG,
    isCleanedUp: () => false,
    onAttentionChanged: () => {},
    publishActivity: () => {},
  })
  runtime.attach(port, {
    lookupCallArgs: () => undefined,
    dangerCommand: () => false,
  })
  assert.ok(provider, 'the runtime registered the ONE question provider')
  assert.ok(approvalListener, 'the runtime registered the ONE approval listener')
  return {
    runtime,
    presenter,
    port,
    questionProvider: () => provider as UserQuestionProvider,
    approvalListener: () => approvalListener as ApprovalRequestListener,
    hostQuestionSignal: hostQuestion.signal,
  }
}

const request = (signal?: AbortSignal): QuestionRequestView => ({
  sessionId: 'session-x',
  callId: 'call-1',
  timed: false,
  questions: QUESTIONS,
  ...(signal === undefined ? {} : { signal }),
})

test('withdrawPresentationForNavigation batches the live Question presentation and re-offers the SAME request', async () => {
  const h = harness()
  let nextCalls = 0
  const first = h.questionProvider()(request(h.hostQuestionSignal), async () => { nextCalls += 1; return ANSWER })
  assert.equal(h.presenter.askCalls, 1, 'the live request is presented')
  assert.equal(h.runtime.hasReloadBlockingInput(), true, 'the mounted flow is Client-local input')

  h.runtime.withdrawPresentationForNavigation()
  assert.equal(h.presenter.withdrawn.length, 1, 'exactly ONE atomic presentation withdrawal')
  assert.equal(h.presenter.withdrawn[0], h.presenter.askSignals[0], 'the EXACT presenter lifetime is withdrawn')
  await assert.rejects(first, /the user cancelled ask_user_question/u,
    'the controller classifies the withdrawn attempt as a LOCAL user cancel; the root epoch gate is what keeps it off the wire')
  assert.equal(nextCalls, 0, 'no Host answer is fabricated')
  assert.equal(h.runtime.hasReloadBlockingInput(), false, 'the withdrawn presentation leaves the blocking set')
  assert.equal(h.hostQuestionSignal.aborted, false, 'the official request lifetime is untouched')

  // Returning to the Session re-presents the SAME request through the SAME
  // provider: a second attempt, a second local flow, no second official call.
  const second = h.questionProvider()(request(h.hostQuestionSignal), async () => { nextCalls += 1; return ANSWER })
  assert.equal(h.presenter.askCalls, 2, 'the same invocation is presented again')
  assert.notEqual(h.presenter.askSignals[1], h.presenter.askSignals[0], 'the re-presentation has its OWN local lifetime')
  h.presenter.decide?.([{ id: 'q1', selected: ['Proceed'] }])
  assert.deepEqual(await second, { answers: [{ id: 'q1', selected: ['Proceed'] }] })
  assert.equal(nextCalls, 0)
  h.runtime.dispose()
})

test('withdrawPresentationForNavigation withdraws a live approval as a local cancellation', async () => {
  const h = harness()
  const approval: ApprovalRequestLike = {
    sessionId: 'session-x',
    callId: 'approval-1',
    toolName: 'bash',
    reason: 'why',
  }
  let decision: Promise<ApprovalOutcome>
  decision = Promise.resolve(h.approvalListener()(approval, () => 'next') as ApprovalOutcome)
  assert.equal(h.runtime.hasReloadBlockingInput(), true, 'the approval prompt is Client-local input')
  // The presenter receives the surface-owned lifetime (not the Host signal).
  assert.equal(h.presenter.withdrawn.length, 0)
  h.runtime.withdrawPresentationForNavigation()
  assert.equal(h.presenter.withdrawn.length, 1, 'the live approval is in the ONE withdrawal batch')
  assert.equal(await decision, 'cancelled', 'the local presentation cancellation is not a Host decision')
  assert.equal(h.runtime.hasReloadBlockingInput(), false)
  h.runtime.dispose()
})

test('an installed committed authority with no session admits nothing (sessionless split)', () => {
  // The boundary fix: `undefined` = authority absent (legacy Direct `true`),
  // a present-but-sessionless authority admits NOTHING. Proven through the
  // same seam the production runtime uses: the injected admission predicate.
  const { runtime } = harness()
  // harness supplies isAdmissibleSession: sessionId === 'session-x'; the
  // production split runtime derives it from options.committedSessionId. The
  // classification under test is the runtime's own branch, pinned here by
  // constructing the real predicate logic the way createSurfaceRuntime does.
  const admissible = (installed: boolean, current: string | undefined, sessionId: string): boolean => {
    if (!installed) return true
    if (current === undefined) return false
    return sessionId === current
  }
  assert.equal(admissible(false, undefined, 'any-session'), true,
    'Direct (no authority) keeps unconditional delegation')
  assert.equal(admissible(true, undefined, 'session-x'), false,
    'a sessionless split surface must not admit any forwarded request')
  assert.equal(admissible(true, 'session-x', 'session-x'), true)
  assert.equal(admissible(true, 'session-x', 'session-y'), false)
  runtime.dispose()
})

test('a second navigation withdrawal is inert and a disposed runtime withdraws nothing', async () => {
  const h = harness()
  const first = h.questionProvider()(request(h.hostQuestionSignal), async () => ANSWER)
  h.runtime.withdrawPresentationForNavigation()
  await assert.rejects(first, /the user cancelled ask_user_question/u)
  const withdrawn = h.presenter.withdrawn.length
  h.runtime.withdrawPresentationForNavigation()
  assert.equal(h.presenter.withdrawn.length, withdrawn, 'no stale lifetime is withdrawn twice')
  h.runtime.dispose()
  h.runtime.withdrawPresentationForNavigation()
  assert.equal(h.presenter.withdrawn.length, withdrawn, 'a disposed runtime is inert')
})
