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
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { installVirtualProcessTerminal } from '../support/runner-harness.ts'
import { stripVTControlCharacters } from 'node:util'
import { createSurfaceRuntime } from '../../src/app/surface/runtime.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
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

test('a sessionless committed surface admits no forwarded request and reads no stale routed id', async () => {
  // REAL production seams: createSurfaceRuntime + a mounted PiTUI surface
  // (surface.start over a VirtualTerminal with the virtual ProcessTerminal
  // installed, like the terminal-progress harness) + attachInteraction. The
  // routed subject deliberately still names the OLD session while the
  // installed committed authority reports "no session".
  const committed: { current: string | undefined } = { current: undefined }
  const vt = new VirtualTerminal(100, 30)
  installVirtualProcessTerminal(vt)
  const surface = createSurfaceRuntime({
    tuiVersion: '0.0.0-test',
    notificationPresentation: { showNotice: () => {}, clearNotice: () => {} } as never,
    notificationMode: undefined,
    notificationMethod: undefined,
    terminalProgress: undefined,
    mainProgressAuthority: 'local-events',
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
    committedSessionId: () => committed.current,
  })
  try {
    surface.attachEventRouting({ currentSessionId: () => 'session-x' } as never)
    surface.start({
      events: { onSubmit: () => {}, onExit: () => {} },
      workspaceRoot: '/tmp',
      iconStyle: 'emoji',
      displayState: { preset: 'compact' },
      historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
      readImage: () => Promise.reject(new Error('not exercised')),
      imageScope: () => undefined,
      present: { call: () => undefined, result: () => undefined },
      sessionCwd: () => '/tmp',
      captureHistoryScope: () => ({ sessionId: 'session-x', isCurrent: () => true }),
      onTerminalResize: () => {},
      copySelection: async () => false,
      deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
      openExternalUrl: () => {},
      readClipboardText: async () => undefined,
      imageFallbackColor: (text: string) => text,
    } as never)
    surface.attachTasks({} as never, { isCleanedUp: () => false } as never)
    type Provider = (request: unknown, next: () => unknown) => unknown
    let provider: Provider | undefined
    surface.attachInteraction({
      questions: {
        onRequest: (next: never) => { provider = next as Provider; return true },
        snapshot: () => undefined,
        subscribe: () => () => {},
        claimTimedWait: async () => undefined,
        answerContinued: async () => 'queued',
      },
      onApprovalRequest: () => {},
      setApprovalPolicy: () => false,
    }, { lookupCallArgs: () => undefined, dangerCommand: () => false })
    assert.ok(provider !== undefined, 'the runtime registered the live question provider')
    const question = {
      sessionId: 'session-x',
      callId: 'call-1',
      timed: false,
      questions: [{ id: 'q1', question: 'Continue the C1 test?', options: [{ label: 'Proceed' }] }],
    }
    const painted = (): boolean => stripVTControlCharacters(vt.getViewport().join('\n')).includes('Continue the C1 test?')

    // 1. SESSIONLESS: the authority is installed and reports no session; the
    //    STALE routed id ('session-x') must not rescue admission.
    const controller = new AbortController()
    const asked = Promise.resolve(provider(
      { ...question, signal: controller.signal },
      () => 'next',
    ))
    asked.catch(() => {})
    for (let poll = 0; poll < 40 && !painted(); poll += 1) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(painted(), false, 'a sessionless surface presents nothing')
    const early = await Promise.race([
      asked.then(() => 'settled', () => 'settled'),
      // fixed window: negative-observation deadline — the wait must stay
      // unsettled for a bounded window with nothing to poll (no signal exists).
      new Promise<'pending'>(resolve => { setTimeout(() => resolve('pending'), 200).unref?.() }),
    ])
    assert.equal(early, 'pending', 'the sessionless wait settles nothing by itself')

    // 2. The official abort ends it as the LOCAL fail-closed classification
    //    (ASK_ABORTED — never an answer). The delivery layer's rejection
    //    contract is pinned in its own suite.
    controller.abort(new Error('withdrawn'))
    await assert.rejects(asked, /aborted before the user answered/u)

    // 3. COMMIT: the SAME class of request presents through the real seam.
    committed.current = 'session-x'
    const asked2 = Promise.resolve(provider({ ...question, callId: 'call-2' }, () => 'next'))
    asked2.catch(() => {})
    for (let poll = 0; poll < 120 && !painted(); poll += 1) await new Promise(resolve => setTimeout(resolve, 25))
    assert.equal(painted(), true, 'the committed session presents the question flow')
    vt.sendInput('\x1b')
    await assert.rejects(asked2, /cancelled/u, 'cleanup: the flow cancels normally')
  } finally {
    surface.dispose()
  }
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
