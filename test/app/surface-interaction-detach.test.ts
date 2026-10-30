/**
 * M4-C1 — Client surface teardown versus Host-owned interaction settlement.
 *
 * A Client surface retirement is NOT a human decision. The official Host
 * Gateway keeps a forwarded Question/Approval pending for the next legal
 * Client; this suite pins that the surface-owned answerers never turn their
 * local presentation cancellation into a Host result/cancellation.
 *
 * EVIDENCE LEVEL: L6 unit/composition contract. The real two-PID Host/Client
 * delivery is proven by `scripts/split-process-smoke.mjs` T49–T55.
 *
 * @module @xmoon76/dsh-pi-tui/surface-interaction-detach.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  InteractionPort,
  QuestionInteractionPort,
  UserQuestionProvider,
} from '../../src/runtime/interaction-port.ts'
import { createInteractionRuntime } from '../../src/app/surface/interaction-runtime.ts'
import type { ApprovalOutcome, SurfaceInteractionPresenter } from '../../src/app/surface/interaction-presenter.ts'

const never = (): Promise<never> => new Promise<never>(() => {})
const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

/** A minimal presenter whose prompts are settled by the test, not by a TUI. */
function createPresenter(overrides: Partial<SurfaceInteractionPresenter> = {}): SurfaceInteractionPresenter {
  return {
    showApprovalPrompt: () => never(),
    askQuestions: () => never(),
    setSettledQuestionAnswersLookup: () => {},
    notify: () => {},
    setQuestionAttention: () => {},
    withdrawPending: () => {},
    withdrawPresentations: () => {},
    closeTransientList: () => {},
    presentedModalKind: () => undefined,
    ...overrides,
  } as unknown as SurfaceInteractionPresenter
}

/** A port that captures the runtime's registered answerers. */
function createPort(): {
  port: InteractionPort
  approvalListener: ((request: unknown, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>) | undefined
  questionProvider: UserQuestionProvider | undefined
} {
  const captured: {
    approvalListener?: (request: unknown, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>
    questionProvider?: UserQuestionProvider
  } = {}
  const questions = {
    preservesHostPendingOnDetach: true,
    onRequest: (provider: UserQuestionProvider) => { captured.questionProvider = provider; return true },
    subscribe: () => () => {},
    snapshot: () => undefined,
    claimTimedWait: async () => undefined,
    answerContinued: async () => 'queued' as const,
  } as unknown as QuestionInteractionPort
  const port = {
    preservesHostPendingOnDetach: true,
    questions,
    onApprovalRequest: (listener: unknown) => {
      captured.approvalListener = listener as typeof captured.approvalListener
    },
    setApprovalPolicy: () => true,
  } as unknown as InteractionPort
  return {
    port,
    get approvalListener() { return captured.approvalListener },
    get questionProvider() { return captured.questionProvider },
  } as never
}

function createRuntime(presenter: SurfaceInteractionPresenter) {
  return createInteractionRuntime({
    presenter: () => presenter,
    livePresenter: () => presenter,
    display: () => ({ supportsModals: true }) as never,
    currentSessionId: () => 'session-c1-detach',
    isAdmissibleSession: () => true,
    schedulePaint: () => {},
    diag: () => ({ log: () => {}, warn: () => {}, error: () => {} }) as never,
    isCleanedUp: () => false,
    onAttentionChanged: () => {},
    publishActivity: () => {},
  })
}

test('a surface teardown leaves a Host-owned approval pending instead of returning cancelled', async () => {
  let resolvePrompt: ((outcome: ApprovalOutcome) => void) | undefined
  const presenter = createPresenter({
    showApprovalPrompt: (_request, _agentInputWait) => new Promise<ApprovalOutcome>(resolve => { resolvePrompt = resolve }),
  })
  const runtime = createRuntime(presenter)
  const captured = createPort()
  runtime.attach(captured.port, { lookupCallArgs: () => undefined, dangerCommand: () => false })

  const hostSignal = new AbortController()
  const hostAnswerer = () => Promise.resolve<ApprovalOutcome>('allowed-once')
  const hostPromise = captured.approvalListener?.({
    toolName: 'bash',
    reason: 'C1 detach proof',
    signal: hostSignal.signal,
  }, hostAnswerer)
  assert.ok(hostPromise !== undefined, 'the approval answerer was not registered')

  runtime.dispose()
  // The TUI's own disposal settles the local prompt cancelled AFTER the
  // interaction owner has retired. That local settlement must not reach the
  // Host waterfall.
  resolvePrompt?.('cancelled')
  let settled = false
  hostPromise.then(() => { settled = true }, () => { settled = true })
  await tick()
  await tick()
  assert.equal(settled, false, 'the Host approval waterfall was settled by the Client surface teardown')
})

test('a surface teardown leaves a Host-owned question pending instead of rejecting the waterfall', async () => {
  let questionSignal: AbortSignal | undefined
  const presenter = createPresenter({
    askQuestions: (_questions, signal) => new Promise((_resolve, reject) => {
      questionSignal = signal
      if (signal === undefined) throw new Error('the question surface received no lifetime')
      if (signal.aborted) {
        reject(new Error('surface withdrawn'))
        return
      }
      signal.addEventListener('abort', () => reject(new Error('surface withdrawn')), { once: true })
    }),
  })
  const runtime = createRuntime(presenter)
  const captured = createPort()
  runtime.attach(captured.port, { lookupCallArgs: () => undefined, dangerCommand: () => false })

  const hostSignal = new AbortController()
  const hostAnswerer = () => Promise.resolve({ answers: [{ id: 'c1-question', selected: ['Proceed'] }] })
  const hostPromise = captured.questionProvider?.({
    sessionId: 'session-c1-detach',
    callId: 'call-c1-detach',
    timed: false,
    questions: [{ id: 'c1-question', question: 'Continue?', options: [{ label: 'Proceed' }] }],
    signal: hostSignal.signal,
  }, hostAnswerer)
  assert.ok(hostPromise !== undefined, 'the question provider was not registered')
  assert.ok(questionSignal !== undefined, 'the question surface was not mounted')

  runtime.dispose()
  assert.equal(questionSignal?.aborted, true, 'the surface flow was not withdrawn')
  let settled = false
  hostPromise.then(() => { settled = true }, () => { settled = true })
  await tick()
  await tick()
  assert.equal(settled, false, 'the Host question waterfall was settled by the Client surface teardown')
})
