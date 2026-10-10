/**
 * PR3-B B3 L6 runner tests (the B3 addendum's §5.2): the production
 * source→decision→sink chain for Question and Approval on the TSP renderer.
 *
 * Chain under test (REAL unless marked otherwise):
 *
 *     official InteractionPort request (the Direct adapter over the Host plane)
 *       -> the REAL `createSurfaceRuntime` + its ONE `InteractionRuntime`
 *       -> the REAL `QuestionSurfaceController` (claim/continued/park/settled)
 *       -> the REAL TSP renderer mount + the REAL interaction seat
 *       -> real SDK keys through the ONE input loop (scripted pane)
 *       -> the ORIGINAL approve/answer sink the official port was given
 *
 * FIXTURE MANIFEST
 * - REAL: `createSurfaceRuntime`, `InteractionRuntime`, `SurfaceInteractionPresenter`
 *   wiring, `QuestionSurfaceController`, `mountTspRenderer`, the shipped SDK
 *   session/surface, `DirectInteractionPort`, the session-currentness reads.
 * - STAND-IN (the single external boundary): the Host SERVICE PLANE behind the
 *   Direct adapter (`userQuestions.attachWait/answer`, the `sessionProjections`
 *   registry, the `approval/request` + `user-questions/request` emitters) and
 *   the scripted tty pane. No renderer-local business state is fabricated: the
 *   questions, the projection snapshot and the answer sink all arrive from the
 *   Host side of the port.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-interaction-runner.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect as sdkConnect, concatBytes } from '@stencil-hq/tern'
import type { Op, Session, TermInput, TermOutput } from '@stencil-hq/tern'
import { EventEmitter, getEventListeners } from 'node:events'
import { DirectInteractionPort, type HostContextLike } from '../src/runtime/direct/interaction-direct.ts'
import { createSurfaceRuntime, type SurfaceRuntime, type SurfaceRendererMount } from '../src/app/surface/runtime.ts'
import type { SurfaceEventRoutingSource } from '../src/app/surface/event-routing.ts'
import { TranscriptFolder } from '../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../src/domain/transcript/window.ts'
import { createPluginManagerPanel } from '../src/tui/plugin-manager/panel.ts'
import { mountTspRenderer, type TspRenderer } from '../src/tui/tsp/session.ts'
import type { TuiQuestionStatus } from '../src/app/surface/interaction-presenter.ts'
type AskUserQuestionAnswer = { readonly answers: readonly { readonly id: string; readonly selected: string[]; readonly custom?: string }[] }

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()
const SESSION_ID = 'session-b3-runner'

// ── The scripted tty pane ───────────────────────────────────────────────────

class FakeInput extends EventEmitter implements TermInput {
  readonly isTTY = true
  isRaw = false
  readonly raw: boolean[] = []
  setRawMode(mode: boolean): void { this.isRaw = mode; this.raw.push(mode) }
  type(text: string): void { this.emit('data', ENCODER.encode(text)) }
}

class FakeOutput implements TermOutput {
  readonly isTTY = true
  readonly columns = 100
  readonly rows = 30
  readonly chunks: Uint8Array[] = []
  onWrite: ((bytes: Uint8Array) => void) | undefined
  write(data: Uint8Array | string): boolean {
    const bytes = typeof data === 'string' ? ENCODER.encode(data) : data
    this.chunks.push(bytes)
    this.onWrite?.(bytes)
    return true
  }
  text(): string { return DECODER.decode(concatBytes(this.chunks)) }
}

const HELLO = {
  r: 'hello', v: 1, term: 'tern', ver: '0.6.2',
  kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool'],
  features: ['flow', 'styles'], apc: 65536, credits: 4, cols: 120,
  cell: { w: 8, h: 17 }, dark: true, reduceMotion: false, hour12: false,
}

interface WireFrame { readonly sf: string; readonly s: number; readonly ops: readonly Op[] }

class ScriptedTern {
  readonly input = new FakeInput()
  readonly output = new FakeOutput()
  readonly frames: WireFrame[] = []
  readonly closeBodies: unknown[] = []
  constructor() {
    this.output.onWrite = bytes => {
      const text = DECODER.decode(bytes)
      if (text.includes('\u001b[c')) {
        setTimeout(() => this.input.type(`\u001b_tsp;r;${JSON.stringify(HELLO)}\u001b\\\u001b[?62;52;c`), 1)
        return
      }
      for (const match of text.matchAll(/\u001b_tsp;x;([\s\S]*?)\u001b\\/g)) {
        try { this.closeBodies.push(JSON.parse(match[1]!)) } catch { /* not a close body */ }
      }
      for (const match of text.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
        const frame = JSON.parse(match[1]!) as WireFrame
        this.frames.push(frame)
        setTimeout(() => this.input.type(
          `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
        ), 0)
      }
    }
  }
  ops(): Op[] { return this.frames.flatMap(frame => frame.ops) }
  key(sequence: string): void { this.input.type(sequence) }
}

// ── The fake Host SERVICE PLANE (the one external boundary) ─────────────────

interface HostPlane {
  ctx: HostContextLike
  readonly listeners: Map<string, (request: unknown, next: unknown) => unknown>
  /** The official projection state the `sessionProjections` service reports,
   *  keyed by session id (`currentSessionId` decides which one is read). */
  readonly states: Map<string, { questions: { active: unknown[]; settled: unknown[] } }>
  /** Fire the projection-change subscription (the controller reconciles). */
  changed(): void
  /** The session the Host plane currently books projections for. */
  currentSessionId: string
  /** How many claims the CALLER's lifetime released (the adapter's `release()`). */
  claimReleases: number
  /** A synchronous hook fired by every projection READ the port performs. */
  onProjectionRead: (() => void) | undefined
  /** The answers the Host `userQuestions.answer` sink received. */
  readonly continuedAnswers: { callId: string; answer: AskUserQuestionAnswer }[]
  /** Whether the Host still accepts the continued answer for `callId`. */
  answerable: boolean
  /** The claim stream the timed wait observes (Host side). */
  claim: (callId: string, signal: AbortSignal) => AsyncIterable<{ remainingMs: number }>
  /** The deadline the NEXT claim reports (the Host's remaining wait). */
  remainingMs: number
  /**
   * End the live Host wait from the HOST side (a stream loss or the Host
   * closing the wait): the claim's `ended` settles without any user action.
   */
  endClaim(): void
  /** The Host records the timed call as `continued` (its own timeout bookkeeping). */
  markContinued(callId: string, questions: readonly unknown[]): void
  /** The Host settles the call with the late answer batch (its own bookkeeping). */
  settle(callId: string, answers: readonly unknown[]): void
}

function hostPlane(): HostPlane {
  const listeners = new Map<string, (request: unknown, next: unknown) => unknown>()
  const states = new Map<string, { questions: { active: unknown[]; settled: unknown[] } }>()
  const stateOf = (sessionId: string) => {
    const existing = states.get(sessionId)
    if (existing !== undefined) return existing
    const created = { questions: { active: [] as unknown[], settled: [] as unknown[] } }
    states.set(sessionId, created)
    return created
  }
  const plane: HostPlane = {
    listeners,
    states,
    changed: () => { for (const listener of projectionListeners) listener() },
    currentSessionId: SESSION_ID,
    claimReleases: 0,
    onProjectionRead: undefined,
    continuedAnswers: [],
    answerable: true,
    remainingMs: 60_000,
    claim: (_callId, signal) => ({
      async *[Symbol.asyncIterator]() {
        // The first frame opens the claim with the Host's remaining wait. The
        // stream then ends for ONE of the two real reasons, exactly like the
        // Host wait the Direct adapter wires: the CALLER releases the claim
        // (its lifetime signal aborts — the adapter's `release()`), or the HOST
        // ends it (a stream loss / the Host closing the wait).
        yield { remainingMs: plane.remainingMs }
        await new Promise<void>((_resolve, reject) => {
          const onRelease = (): void => {
            endWait = undefined
            plane.claimReleases += 1
            reject(new Error('the claim lifetime was released'))
          }
          const onHostEnd = (): void => {
            signal.removeEventListener('abort', onRelease)
            reject(new Error('the Host wait ended'))
          }
          endWait = onHostEnd
          if (signal.aborted) { onRelease(); return }
          signal.addEventListener('abort', onRelease, { once: true })
        })
      },
    }),
    endClaim: () => { const end = endWait; endWait = undefined; end?.() },
    markContinued: (callId, questions) => {
      stateOf(plane.currentSessionId).questions.active = [{ callId, questions, state: 'continued' }]
      plane.changed()
    },
    settle: (callId, answers) => {
      const state = stateOf(plane.currentSessionId)
      state.questions.active = state.questions.active.filter(call => (call as { callId?: string }).callId !== callId)
      state.questions.settled = [...state.questions.settled, { callId, answers }]
      plane.changed()
    },
    ctx: undefined as unknown as HostContextLike,
  }
  let endWait: (() => void) | undefined
  const projectionListeners = new Set<() => void>()
  const services: Record<string, unknown> = {
    userQuestions: {
      attachWait: (_agent: unknown, callId: string, signal: AbortSignal) => plane.claim(callId, signal),
      answer: (_agent: unknown, callId: string, answer: AskUserQuestionAnswer) => {
        if (!plane.answerable) return false
        plane.continuedAnswers.push({ callId, answer })
        return true
      },
    },
    sessionProjections: {
      stateOf: (session: unknown, key: string) => {
        if (key !== 'userQuestions') return undefined
        // A REAL synchronous port read: a reentrant official request created
        // here runs inside the controller's own snapshot call.
        plane.onProjectionRead?.()
        const id = (session as { readonly id?: unknown } | undefined)?.id
        return typeof id === 'string' ? stateOf(id) : undefined
      },
      onChanged: (listener: () => void) => {
        projectionListeners.add(listener)
        return () => { projectionListeners.delete(listener) }
      },
    },
  }
  plane.ctx = {
    get: (name: string) => services[name],
    on: (event: string, listener: (request: unknown, next: unknown) => unknown) => {
      listeners.set(event, listener)
      return listener
    },
  } as unknown as HostContextLike
  return plane
}

// ── The harness: the REAL SurfaceRuntime over the scripted pane ─────────────

const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(message)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

interface RunnerHarness {
  readonly tern: ScriptedTern
  readonly surface: SurfaceRuntime<never>
  readonly plane: HostPlane
  readonly port: DirectInteractionPort
  /** Deliver one official approval request through the Host event plane. */
  readonly approvalRequest: (request: Record<string, unknown>) => Promise<unknown>
  /** Deliver one official question request through the Host event plane. */
  readonly questionRequest: (request: Record<string, unknown>) => Promise<unknown>
  /** Move the surface's currentness to another session (an A→B switch). */
  setSession(sessionId: string): void
  /** How many times the application CANCEL path ran (a modal must own its Esc). */
  cancelCalls(): number
  route(event: { type: string; seq?: number; data?: unknown }): void
  dispose(): Promise<void>
}

async function mountRunnerHarness(options: {
  /** The official projection state present BEFORE `attachInteraction` runs. */
  readonly projection?: { readonly active: unknown[]; readonly settled: unknown[] }
  /** The remaining wait the NEXT official claim reports (the Host deadline). */
  readonly remainingMs?: number
} = {}): Promise<RunnerHarness> {
  const tern = new ScriptedTern()
  const session: Session | null = await sdkConnect({
    env: {},
    input: tern.input,
    output: tern.output,
    exitHooks: false,
    timeout: 500,
  })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  const plane = hostPlane()
  if (options.remainingMs !== undefined) plane.remainingMs = options.remainingMs
  let currentSessionId = SESSION_ID
  const sessionState = () => {
    const existing = plane.states.get(currentSessionId)
    if (existing !== undefined) return existing
    const created = { questions: { active: [] as unknown[], settled: [] as unknown[] } }
    plane.states.set(currentSessionId, created)
    return created
  }
  if (options.projection !== undefined) {
    sessionState().questions.active = [...options.projection.active]
    sessionState().questions.settled = [...options.projection.settled]
  }
  const port = new DirectInteractionPort(plane.ctx, sessionId => ({ session: { id: sessionId } }))

  let folder = new TranscriptFolder()
  let mountedRenderer: TspRenderer | undefined
  let exitCount = 0
  let cancelCalls = 0
  const controller = new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 })
  const source: SurfaceEventRoutingSource<never> = {
    isCleanedUp: () => false,
    isAttachedSession: candidate => (candidate as { id?: string }).id === currentSessionId,
    currentSessionId: () => currentSessionId,
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => ({
      folder: { apply: (events: readonly never[]) => folder.apply(events) },
      stats: { apply: () => {} },
      get window() { return controller },
      previews: new Map(),
      applyToolPreview: () => {},
      refreshRecentPerformanceAvailability: () => {},
    }),
    viewedChildId: () => undefined,
    viewedChild: () => { throw new Error('no viewer in this harness') },
    mainFolder: () => folder,
    viewedChildFolder: () => { throw new Error('no viewer in this harness') },
    pendingSubjectId: () => undefined,
    pendingSnapshot: () => undefined,
    submissionEchoes: () => undefined,
    queueTextOf: () => '',
    exitView: () => {},
    refreshStatusCheap: () => {},
    refreshStatusAndWelcome: () => {},
    applyGoalChange: () => {},
    sessionTitleOf: () => undefined,
    extendLoadedHistory: () => false,
    settleLocalSubmitAck: () => {},
    markSubmitLatency: () => {},
    observeDurableSubmission: () => {},
    markContextDirty: () => {},
    refreshContextMeasurement: () => {},
    currentWorkingFromLog: () => false,
    flushTurn: () => {},
    registeredAgentIs: () => false,
    isCurrentOwnerAgent: () => false,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: () => { throw new Error('no viewer in this harness') },
    applyMainAssistantInput: () => {},
  }

  const surface = createSurfaceRuntime<never>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    mainProgressAuthority: 'local-events',
    terminalProgress: undefined,
    createPluginManagerPanel,
  })
  surface.attachEventRouting(source)
  const renderer: SurfaceRendererMount = {
    mount: () => {
      mountedRenderer = mountTspRenderer(session, { requestExit: () => { exitCount += 1 } })
      return mountedRenderer
    },
    releaseUnmounted: async () => { await mountedRenderer?.dispose() },
  }
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {}, onCancel: () => { cancelCalls += 1 } },
    renderer,
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    sessionId: () => currentSessionId,
    onTerminalResize: () => {},
    copySelection: async () => false,
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
  })
  // The PRODUCTION order (bootstrap): the Task Center owner attaches first (the
  // interaction owner borrows its diagnostics channel), then the ONE input
  // bind, then the interaction attach.
  surface.attachTasks({
    sessionId: () => SESSION_ID,
    captureSubject: () => undefined,
    subjectMatches: () => true,
    enterView: async () => {},
    interruptSubagent: async () => ({ kind: 'refused', code: 'not-exercised' }),
    rowSelectionDisposition: () => 'keep-open',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: () => '',
    jobObservation: {
      open: () => () => {},
      stop: async () => ({ kind: 'stopped' }),
    },
  } as never, { diag: SILENT_DIAG, isCleanedUp: () => false })
  surface.bindRendererInput()
  surface.attachInteraction(port, { lookupCallArgs: () => undefined, dangerCommand: () => false })

  const deliver = async (event: string, request: Record<string, unknown>): Promise<unknown> => {
    const listener = plane.listeners.get(event)
    assert.ok(listener !== undefined, `${event} is registered by the real Direct port`)
    return await listener(request, async () => ({ answers: [] }))
  }

  return {
    tern,
    surface,
    plane,
    port,
    approvalRequest: request => deliver('approval/request', request),
    questionRequest: request => deliver('user-questions/request', request),
    setSession: (sessionId: string) => { currentSessionId = sessionId; plane.currentSessionId = sessionId },
    cancelCalls: () => cancelCalls,
    route: event => { surface.routeSessionEvent({ id: currentSessionId } as never, event as never) },
    async dispose() {
      surface.dispose()
      await surface.whenRendererReleased()
      await session.close()
    },
  }
}

const T0 = 1_700_000_000_000

/** The task-center diagnostics stand-in (the runner's own channel shape). */
const SILENT_DIAG = { debug() {}, info() {}, warn() {}, error() {}, dispose() {} }

/** One `ask_user_question` tool call + its recorded (possibly timed-out) result. */
function questionToolEvents(callId: string, result: string): { type: string; seq: number; time: number; data: unknown }[] {
  return [
    { type: 'tool/call', seq: 1, time: T0, data: { turn: 1, step: 0, callId, name: 'ask_user_question', arguments: '{"questions":[]}' } },
    {
      type: 'tool/result',
      seq: 2,
      time: T0 + 1,
      data: {
        turn: 1,
        step: 0,
        message: {
          id: `result-${callId}`,
          role: 'tool',
          toolCallId: callId,
          content: [{ type: 'text', text: result }],
          source: { kind: 'tool', callId },
        },
      },
    },
  ]
}


/** Every string a frame carried (node props included), for exact-value scans:
 *  the wire JSON escapes quotes, so a substring check on the raw text is not
 *  an honest way to look for a JSON payload. */
function frameStrings(frames: readonly WireFrame[]): string[] {
  const out: string[] = []
  const visit = (value: unknown): void => {
    if (typeof value === 'string') { out.push(value); return }
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (typeof value === 'object' && value !== null) {
      for (const child of Object.values(value)) visit(child)
    }
  }
  for (const frame of frames) visit(frame.ops)
  return out
}

/** One overlay id added to the `layer` region (in wire order). */
/** The OVERLAY ids added to the `layer` region — exactly `layer.modal-<n>`,
 *  never a nested node of one (which would inflate every modal-count assert). */
function overlayAdds(ops: readonly Op[]): string[] {
  return ops
    .filter(op => op[0] === 'add' && /^layer\.modal-\d+$/.test(String(op[1])))
    .map(op => String(op[1]))
}

/** The overlay ids STILL mounted after replaying every op in order. */
function liveOverlays(ops: readonly Op[]): string[] {
  const live = new Set<string>()
  for (const op of ops) {
    if (op[0] === 'add' && /^layer\.modal-\d+$/u.test(op[1])) live.add(op[1])
    else if (op[0] === 'del' && /^layer\.modal-\d+$/u.test(op[1])) live.delete(op[1])
  }
  return [...live]
}

// ── Approval: official request → TSP key → the ORIGINAL sink ────────────────

test('B3 L6: an official approval request is answered on the TSP pane and resolves the ORIGINAL sink', async () => {
  const harness = await mountRunnerHarness()
  try {
    const delivered = harness.approvalRequest({
      toolName: 'bash',
      reason: 'needs the shell',
      signal: new AbortController().signal,
    })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the approval modal reached the TSP pane')
    assert.ok(harness.tern.output.text().includes('needs the shell'), 'the official reason is rendered')
    harness.tern.key('y')
    assert.equal(await delivered, 'allowed-once', 'the explicit y resolved the official approval answer')
    await waitFor(() => harness.tern.ops().some(op => op[0] === 'del' && String(op[1]).startsWith('layer.modal-')), 'the modal unmounted')
  } finally {
    await harness.dispose()
  }
})

// ── Question: official request → real controller → TSP form → sink ──────────

test('B3 L6: an official Question request is answered through the real controller and the official sink', async () => {
  const harness = await mountRunnerHarness()
  try {
    const delivered = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-b3-1' },
      questions: [{ id: 'q1', question: 'Which target?', options: [{ label: 'alpha' }, { label: 'beta' }] }],
      signal: new AbortController().signal,
    })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the question form reached the pane')
    assert.ok(harness.tern.output.text().includes('Which target?'), 'the official question text is rendered')
    harness.tern.key('\r')
    harness.tern.key('\r')
    const answer = await delivered
    assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['alpha'] }] }, 'the official producer observed the real answers')
  } finally {
    await harness.dispose()
  }
})

// ── Cold continued: projection → parked count → Alt+Q → late answer ─────────

test('B3 L6: a cold continued projection is parked, counted in the dock, and answered through Alt+Q', async () => {
  const harness = await mountRunnerHarness({
    projection: {
      active: [{
        callId: 'call-b3-continued',
        questions: [{ id: 'q-c', question: 'Late answer?', options: [{ label: 'yes' }, { label: 'no' }] }],
        state: 'continued',
      }],
      settled: [],
    },
  })
  try {
    // The attach-time reconcile discovered it as PARKED: no form stole the seat.
    await waitFor(() => harness.tern.output.text().includes('Continued questions: 1'), 'the dock shows the parked count')
    assert.equal(overlayAdds(harness.tern.ops()).length, 0, 'a cold discovery mounts no form')
    harness.tern.key('\x1bq')
    await waitFor(() => harness.tern.output.text().includes('call-b3-continued'), 'the Alt+Q list shows the parked row')
    harness.tern.key('\r')
    await waitFor(() => harness.tern.output.text().includes('Late answer?'), 'the controller mounted the real form')
    harness.tern.key('\r')   // adopt 'yes' and advance to review
    harness.tern.key('\r')   // submit the late answer
    await waitFor(() => harness.plane.continuedAnswers.length === 1, 'the official answerContinued sink received exactly one answer')
    assert.deepEqual(harness.plane.continuedAnswers[0]?.answer, { answers: [{ id: 'q-c', selected: ['yes'] }] })
  } finally {
    await harness.dispose()
  }
})

// ── The authoritative settled batch on the transcript row ───────────────────

test('B3 L6: the official settled batch reaches the tool row, and an EMPTY batch never falls back', async () => {
  const harness = await mountRunnerHarness({
    projection: {
      active: [],
      settled: [{ callId: 'call-b3-settled', answers: [{ id: 'q1', selected: ['yes'] }] }],
    },
  })
  try {
    for (const event of questionToolEvents('call-b3-settled', 'the question timed out')) harness.route(event as never)
    harness.surface.paintNow()
    const settled = '{"answers":[{"id":"q1","selected":["yes"]}]}'
    await waitFor(() => frameStrings(harness.tern.frames).includes(settled), 'the settled batch reached the row')
    assert.equal(frameStrings(harness.tern.frames).includes('the question timed out'), false, 'the timeout payload was replaced by the authoritative batch')
  } finally {
    await harness.dispose()
  }
})

test('B3 L6: an EMPTY settled batch is authoritative and does not fall back to the recorded result', async () => {
  const harness = await mountRunnerHarness({
    projection: { active: [], settled: [{ callId: 'call-b3-empty', answers: [] }] },
  })
  try {
    for (const event of questionToolEvents('call-b3-empty', 'the question timed out')) harness.route(event as never)
    harness.surface.paintNow()
    await waitFor(() => frameStrings(harness.tern.frames).includes('{"answers":[]}'), 'the empty batch reached the row')
    assert.equal(frameStrings(harness.tern.frames).includes('the question timed out'), false, 'an empty batch is a real settled outcome')
  } finally {
    await harness.dispose()
  }
})

// ── Lifecycle: teardown settles the live form and closes the SDK once ───────

test('B3 L6: disposal settles the live approval, closes the SDK exactly once and leaves input inert', async () => {
  const harness = await mountRunnerHarness()
  let disposed = false
  try {
    const delivered = harness.approvalRequest({
      toolName: 'bash',
      reason: 'teardown',
      signal: new AbortController().signal,
    })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the modal opened')
    await harness.dispose()
    disposed = true
    assert.equal(await delivered, 'cancelled', 'the pending approval settled cancelled at teardown')
    assert.equal(harness.tern.closeBodies.length, 1, 'exactly one SDK close frame')
    const frames = harness.tern.frames.length
    harness.tern.key('y')
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(harness.tern.frames.length, frames, 'input after retirement stays inert')
  } finally {
    if (!disposed) await harness.dispose()
  }
})

// ── F4: the settled lookup is read even when the recorded result is empty ────

test('B3 F4: a settled batch reaches a row whose recorded result is EMPTY', async () => {
  const harness = await mountRunnerHarness({
    projection: {
      active: [],
      settled: [{ callId: 'call-b3-empty-result', answers: [{ id: 'q1', selected: ['yes'] }] }],
    },
  })
  try {
    for (const event of questionToolEvents('call-b3-empty-result', '')) harness.route(event as never)
    harness.surface.paintNow()
    const settled = '{"answers":[{"id":"q1","selected":["yes"]}]}'
    await waitFor(() => frameStrings(harness.tern.frames).includes(settled),
      'the official settled batch reached the row with no recorded result')
  } finally {
    await harness.dispose()
  }
})

test('B3 F4 control: with no settled entry an empty recorded result still renders no result body', async () => {
  const harness = await mountRunnerHarness()
  try {
    for (const event of questionToolEvents('call-b3-no-settlement', '')) harness.route(event as never)
    harness.surface.paintNow()
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(
      frameStrings(harness.tern.frames).some(text => text.includes('"answers"')),
      false,
      'an absent settled entry fabricates no result body',
    )
  } finally {
    await harness.dispose()
  }
})

// ── F6.2: the official approval sink covers rejection and every abort shape ──

test('B3 F6.2: rejection and each abort shape settle through the official approval sink', async () => {
  const harness = await mountRunnerHarness()
  try {
    const rejected = harness.approvalRequest({ toolName: 'bash', reason: 'no thanks', signal: new AbortController().signal })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the modal opened')
    harness.tern.key('n')
    assert.equal(await rejected, 'rejected', 'the explicit n resolved the official rejection')

    const already = new AbortController()
    already.abort()
    assert.equal(await harness.approvalRequest({ toolName: 'bash', reason: 'gone', signal: already.signal }), 'cancelled')
    assert.equal(overlayAdds(harness.tern.ops()).length, 1, 'an already-aborted request never mounts')

    const activeAbort = new AbortController()
    const active = harness.approvalRequest({ toolName: 'bash', reason: 'active', signal: activeAbort.signal })
    const queuedAbort = new AbortController()
    const queued = harness.approvalRequest({ toolName: 'bash', reason: 'queued', signal: queuedAbort.signal })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 2, 'the active modal opened')
    queuedAbort.abort()
    assert.equal(await queued, 'cancelled', 'a queued abort settles only its own request')
    activeAbort.abort()
    assert.equal(await active, 'cancelled', 'an active abort settles cancelled — never an allow')

    const allowed = harness.approvalRequest({ toolName: 'bash', reason: 'final', signal: new AbortController().signal })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 3, 'the last modal opened')
    harness.tern.key('y')
    assert.equal(await allowed, 'allowed-once', 'the ONE answerer stays interactive after every abort')
  } finally {
    await harness.dispose()
  }
})

// ── F6.4: reentrant successors and mixed Question/Approval handoff ──────────

test('B3 F6.4: a successor created from the answered request is not answered by the same key', async () => {
  const harness = await mountRunnerHarness()
  try {
    // The production reentry shape: the official consumer of the FIRST answer
    // immediately asks again (a microtask reentry, not a pre-created pair).
    const first = harness.approvalRequest({ toolName: 'bash', reason: 'first', signal: new AbortController().signal })
    const successor = first.then(() => harness.approvalRequest({ toolName: 'bash', reason: 'successor', signal: new AbortController().signal }))
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the first modal opened')
    harness.tern.key('y')
    assert.equal(await first, 'allowed-once')
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 2, 'the successor took the seat')
    assert.equal(String(await Promise.race([successor, new Promise(resolve => setTimeout(() => resolve('pending'), 150))])), 'pending',
      'the key that answered the first request settled nothing else')
    harness.tern.key('n')
    assert.equal(await successor, 'rejected', 'the successor needed its OWN key')
  } finally {
    await harness.dispose()
  }
})

test('B3 F6.4: a question created while an approval owns the seat waits its turn (mixed handoff)', async () => {
  const harness = await mountRunnerHarness()
  try {
    const approval = harness.approvalRequest({ toolName: 'bash', reason: 'owns the seat', signal: new AbortController().signal })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the approval modal opened')
    // A question arrives while the approval is up: it must QUEUE, not replace.
    const question = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-b3-mixed' },
      questions: [{ id: 'q-mixed', question: 'Pick', options: [{ label: 'A' }] }],
      signal: new AbortController().signal,
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(overlayAdds(harness.tern.ops()).length, 1, 'the queued question did not steal the seat')
    harness.tern.key('y')
    assert.equal(await approval, 'allowed-once')
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 2, 'the queued question took the seat')
    assert.ok(harness.tern.output.text().includes('Pick'), 'the question form is the one now presented')
    harness.tern.key('\r')   // adopt A
    harness.tern.key('\r')   // submit
    assert.deepEqual(await question, { answers: [{ id: 'q-mixed', selected: ['A'] }] })
  } finally {
    await harness.dispose()
  }
})

test('B3 F6.4: an approval created while a question owns the seat waits its turn', async () => {
  const harness = await mountRunnerHarness()
  try {
    const question = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-b3-sym' },
      questions: [{ id: 'q-sym', question: 'Pick', options: [{ label: 'A' }] }],
      signal: new AbortController().signal,
    })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the question owns the seat')
    const approval = harness.approvalRequest({ toolName: 'bash', reason: 'queued behind the question', signal: new AbortController().signal })
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(overlayAdds(harness.tern.ops()).length, 1, 'the approval queued instead of preempting')
    harness.tern.key('\r')   // adopt A
    harness.tern.key('\r')   // submit
    assert.deepEqual(await question, { answers: [{ id: 'q-sym', selected: ['A'] }] })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 2, 'the queued approval took the seat afterwards')
    assert.ok(harness.tern.output.text().includes('queued behind the question'), 'the approval form is the one now shown')
    harness.tern.key('y')
    assert.equal(await approval, 'allowed-once')
  } finally {
    await harness.dispose()
  }
})

test('B3 F6.4: a reentrant official request created inside a controller projection READ does not preempt the form', async () => {
  const harness = await mountRunnerHarness()
  try {
    let reentered: Promise<unknown> | undefined
    const question = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-b3-readreentry' },
      questions: [{ id: 'q-read', question: 'Pick', options: [{ label: 'A' }] }],
      signal: new AbortController().signal,
    })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the question opened')
    // EVERY projection read the controller performs now creates an official
    // approval SYNCHRONOUSLY — a callback reentry inside the port read path.
    harness.plane.onProjectionRead = () => {
      if (reentered !== undefined) return
      reentered = harness.approvalRequest({ toolName: 'bash', reason: 'reentrant read', signal: new AbortController().signal })
    }
    harness.route({ type: 'turn/start', seq: 1, data: { turn: 1 } })
    await waitFor(() => reentered !== undefined, 'the reentrant request was created inside the read')
    harness.plane.onProjectionRead = undefined
    assert.equal(overlayAdds(harness.tern.ops()).length, 1, 'the reentrant approval did not preempt the active question')
    harness.tern.key('\r')
    harness.tern.key('\r')
    assert.deepEqual(await question, { answers: [{ id: 'q-read', selected: ['A'] }] })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 2, 'the queued approval took the seat')
    harness.tern.key('y')
    assert.equal(await reentered, 'allowed-once')
  } finally {
    await harness.dispose()
  }
})

// ── F6.1: the genuine timed claim → timeout → continued → late answer ───────

test('B3 F6.1: a real timed claim times out into the continued form (the official sink sees ASK_TIMED_OUT)', async () => {
  const harness = await mountRunnerHarness({ remainingMs: 150 })
  try {
    const delivered = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-b3-timed', timed: true },
      questions: [{ id: 'q-timed', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }],
      signal: new AbortController().signal,
    }).then(value => value, (error: unknown) => error)
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the timed form opened')
    assert.ok(harness.tern.output.text().includes('Foreground wait'), 'the real countdown status is rendered')

    // The Host records its own timeout bookkeeping: the call becomes continued.
    await new Promise(resolve => setTimeout(resolve, 1_200))
    harness.plane.markContinued('call-b3-timed', [{ id: 'q-timed', question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }])

    // The controller rejected ASK_TIMED_OUT (NOT a user cancel) and re-offered
    // the call as the continued form with its own status text.
    const timedOut = await delivered
    assert.equal((timedOut as { code?: string }).code, 'ASK_TIMED_OUT')
    await waitFor(() => harness.tern.output.text().includes('The Agent continued'), 'the continued form was offered', 8_000)

    // SAME CALL, the rest of the chain: park it, reach it through the dock +
    // Alt+Q, answer late, and see the authority confirm the queued answer and
    // the settled result card.
    // The continued page is the OPTION LIST, so ONE Escape parks the form. A
    // second Escape would leave the modal seat and reach the main cancel path,
    // which this test asserts never happens.
    harness.tern.key('\x1b')
    await waitFor(() => harness.tern.output.text().includes('Continued questions: 1'), 'the parked count is in the dock', 8_000)
    assert.equal(harness.cancelCalls(), 0, 'parking a continued form never reaches the main cancel path')
    harness.tern.key('\x1b[113;3u')  // Alt+Q (CSI-u): the fresh authoritative list
    await waitFor(() => harness.tern.output.text().includes('call-b3-timed'), 'the parked row is listed', 8_000)
    harness.tern.key('\r')     // reopen through the controller's own recheck
    await waitFor(() => harness.tern.output.text().includes('The Agent continued'), 'the reopened late-answer form is presented', 8_000)
    harness.tern.key('\r')     // adopt A
    harness.tern.key('\r')     // submit the late answer
    await waitFor(() => harness.plane.continuedAnswers.length === 1, 'the official answerContinued sink got exactly one answer', 8_000)
    assert.deepEqual(harness.plane.continuedAnswers[0]?.answer, { answers: [{ id: 'q-timed', selected: ['A'] }] })
    await waitFor(() => harness.tern.output.text().includes('queued'), 'the authority confirmed the queued reply', 8_000)

    // §3.9's retained-row contract: the tool row is on screen FIRST, carrying
    // its recorded timeout payload, and the later authoritative batch must
    // UPDATE that same node (a re-created row would prove nothing).
    for (const event of questionToolEvents('call-b3-timed', 'the recorded timeout payload')) harness.route(event as never)
    harness.surface.paintNow()
    await waitFor(() => harness.tern.output.text().includes('the recorded timeout payload'), 'the timeout row is on screen first', 8_000)
    // A nested node rides its parent's `add` payload, so the row identity is
    // collected by walking the payloads rather than by scanning op ids.
    const resultRowIds = (): string[] => {
      const ids: string[] = []
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) { for (const item of value) visit(item); return }
        if (typeof value !== 'object' || value === null) return
        const record = value as { readonly id?: unknown; readonly c?: unknown }
        if (typeof record.id === 'string' && record.id.endsWith('.result')) ids.push(record.id)
        visit(record.c)
      }
      for (const frame of harness.tern.frames) visit(frame.ops)
      return ids
    }
    const rowIds = resultRowIds()
    const rowId = rowIds[rowIds.length - 1]
    assert.notEqual(rowId, undefined, 'the timeout row has its own node identity')

    harness.plane.settle('call-b3-timed', [{ id: 'q-timed', selected: ['A'] }])
    harness.surface.paintNow()
    // The wire text encodes the payload as JSON inside the frame, so the
    // assertion reads the row's OWN ops rather than a raw substring.
    const rowOps = (): Op[] => harness.tern.ops().filter(op => op[1] === rowId)
    /** The payload the row's LAST update carried (the op argument itself, so
     *  the frame's JSON escaping never hides the value). */
    const rowUpdateText = (): string => {
      const update = [...rowOps()].reverse().find(op => op[0] === 'text' || op[0] === 'set')
      if (update === undefined) return ''
      return update[0] === 'text' ? String(update[3]) : JSON.stringify(update[2])
    }
    const expectedBatch = JSON.stringify({ answers: [{ id: 'q-timed', selected: ['A'] }] })
    await waitFor(() => rowUpdateText() === expectedBatch,
      'the retained row carries the EXACT authoritative batch (never a wrong/empty one)', 8_000)
    assert.equal(rowOps().some(op => op[0] === 'del'), false, 'the retained row was never deleted and re-created')
    assert.deepEqual(resultRowIds(), rowIds, 'no second result row was created for the same call')

    // The removal control: with the settled entry gone the SAME row falls back
    // to its own recorded result (never a stale batch).
    const state = harness.plane.states.get(SESSION_ID)
    assert.ok(state !== undefined)
    state.questions.settled = []
    harness.surface.paintNow()
    await waitFor(() => {
      const latest = harness.tern.ops().filter(op => op[1] === rowId && (op[0] === 'text' || op[0] === 'set')).at(-1)
      return JSON.stringify(latest ?? {}).includes('the recorded timeout payload')
    }, 'dropping the settled entry falls the same row back to its recorded result', 8_000)
  } finally {
    await harness.dispose()
  }
})

test('B3 F6.1: a real answer mutation before the deadline freezes the countdown', async () => {
  const harness = await mountRunnerHarness({ remainingMs: 300 })
  try {
    const delivered = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-b3-frozen', timed: true },
      questions: [{ id: 'q-frozen', question: 'Pick any', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }],
      signal: new AbortController().signal,
    })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the timed form opened')
    harness.tern.key(' ')    // a REAL answer mutation: the controller freezes
    await waitFor(() => harness.tern.output.text().includes('Editing —'), 'the countdown froze on the real mutation')
    await new Promise(resolve => setTimeout(resolve, 1_500))
    assert.equal(overlayAdds(harness.tern.ops()).length, 1, 'the frozen form is still the seat')
    assert.equal(harness.tern.output.text().includes('The Agent continued'), false, 'a frozen form never times out')
    harness.tern.key('\r')   // continue -> review
    harness.tern.key('\r')   // submit
    assert.deepEqual(await delivered, { answers: [{ id: 'q-frozen', selected: ['A'] }] })
  } finally {
    await harness.dispose()
  }
})

test('B3 F6.1: the Host closing the timed wait rejects ASK_ABORTED, never a user cancel', async () => {
  const harness = await mountRunnerHarness({ remainingMs: 5_000 })
  try {
    const delivered = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-b3-hostended', timed: true },
      questions: [{ id: 'q-host', question: 'Pick', options: [{ label: 'A' }] }],
      signal: new AbortController().signal,
    }).then(value => value, (error: unknown) => error)
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the timed form opened')
    harness.plane.endClaim()
    const ended = await delivered
    assert.equal((ended as { code?: string }).code, 'ASK_ABORTED', 'the Host-ended wait is aborted, not cancelled by the user')
  } finally {
    await harness.dispose()
  }
})

// ── F6.3: currentness — retirement never writes into the new session ────────

test('B3 F6.3: a retired request cannot touch the new session, and B gets a FRESH seat identity', async () => {
  const harness = await mountRunnerHarness({
    projection: {
      active: [],
      settled: [{ callId: 'call-b3-cross', answers: [{ id: 'q-a', selected: ['ANS-ONLY-IN-A'] }] }],
    },
  })
  try {
    const aSignal = new AbortController()
    const pending = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-b3-live-a' },
      questions: [{ id: 'q-live-a', question: 'A question', options: [{ label: 'A' }] }],
      signal: aSignal.signal,
    }).then(value => value, (error: unknown) => error)
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the A form opened')

    // The surface moves to B: the production router re-derives answerability.
    harness.setSession('session-b3-beta')
    harness.route({ type: 'turn/start', seq: 1, data: { turn: 1 } })
    const composer = harness.surface.composer
    composer.setDraft('B draft')

    // The Host waterfall owns a LIVE request's retirement; the seat must follow
    // it without writing into the session now on screen.
    const opsBefore = harness.tern.ops().length
    aSignal.abort()
    const retired = await pending
    assert.equal((retired as { code?: string }).code, 'ASK_ABORTED',
      'the Host-ended request is classified ABORTED, never a user cancel')
    await waitFor(() => harness.tern.ops().some(op => op[0] === 'del' && op[1] === 'layer.modal-1'),
      'the retired A modal left the pane')
    const retirementDelta = harness.tern.ops().slice(opsBefore)
    assert.equal(retirementDelta.some(op => op[0] === 'add' && String(op[1]).startsWith('layer.modal-')), false,
      'the retirement mounted NO form: the delta adds no overlay at all')
    assert.equal(composer.getDraft(), 'B draft', "the retired request never wrote into B's composer")

    // B's own request gets its OWN seat identity (never a reused A overlay).
    const bQuestion = harness.questionRequest({
      agent: { session: { id: 'session-b3-beta' } },
      wait: { callId: 'call-b3-b' },
      questions: [{ id: 'q-b', question: 'B question', options: [{ label: 'X' }] }],
      signal: new AbortController().signal,
    })
    await waitFor(() => harness.tern.output.text().includes('B question'), "B's own form is presented")
    assert.deepEqual(overlayAdds(harness.tern.ops()), ['layer.modal-1', 'layer.modal-2'],
      "B's form is a FRESH seat id, not the retired A overlay")
    harness.tern.key('\r')   // adopt X
    harness.tern.key('\r')   // submit
    assert.deepEqual(await bQuestion, { answers: [{ id: 'q-b', selected: ['X'] }] })

    // The same callId in B carries none of A's settled answers.
    for (const event of questionToolEvents('call-b3-cross', 'the recorded timeout payload')) harness.route(event as never)
    harness.surface.paintNow()
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(frameStrings(harness.tern.frames).some(text => text.includes('ANS-ONLY-IN-A')), false,
      "another session's settled answers never reach this session's row")
    assert.ok(frameStrings(harness.tern.frames).includes('the recorded timeout payload'),
      'the row falls back to its own recorded result')
  } finally {
    await harness.dispose()
  }
})

// ── F6.1: the claim lifetime is released when the surface retires ────────────

test('B3 F6.1: disposing the surface releases the live Host claim (the caller lifetime)', async () => {
  const harness = await mountRunnerHarness({ remainingMs: 30_000 })
  try {
    const delivered = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-b3-release', timed: true },
      questions: [{ id: 'q-release', question: 'Pick', options: [{ label: 'A' }] }],
      signal: new AbortController().signal,
    }).then(value => value, (error: unknown) => error)
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the timed form opened with a held claim')
    assert.equal(harness.plane.claimReleases, 0, 'the claim is held while the form is up')
    await harness.dispose()
    assert.equal(harness.plane.claimReleases, 1, 'the surface teardown released the claim exactly once')
    assert.equal((await delivered as { code?: string }).code, 'ASK_ABORTED',
      'a claim the surface released ends the request as ABORTED')
  } finally {
    await harness.dispose()
  }
})

// ── Findings F9/F10: per-request identity and admission currentness ─────────

test('B3 F9: two approvals sharing ONE borrowed cancellation scope are BOTH withdrawn at publication', async () => {
  const harness = await mountRunnerHarness()
  try {
    // The official request's signal is a BORROWED caller cancellation scope: two
    // legal approvals may share it. Each presentation must still be separately
    // addressable, or the queued one survives into the replacement.
    const shared = new AbortController()
    const sessionRef = { session: { id: SESSION_ID } }
    const first = harness.approvalRequest({ agent: sessionRef, toolName: 'bash', reason: 'first', signal: shared.signal })
    const second = harness.approvalRequest({ agent: sessionRef, toolName: 'bash', reason: 'second', signal: shared.signal })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the first prompt is presented')
    assert.ok(harness.tern.output.text().includes('first'), 'the first prompt owns the seat')

    // The replacement Session is published: BOTH presentations must leave.
    harness.setSession('session-b')
    harness.surface.reconcileInteractionPresentation()
    await waitFor(() => liveOverlays(harness.tern.ops()).length === 0,
      'the queued second prompt was NOT promoted after the sweep')

    // Only the Host's own lifetime settles them, fail-closed.
    shared.abort()
    assert.equal(await first, 'cancelled')
    assert.equal(await second, 'cancelled')
  } finally {
    await harness.dispose()
  }
})

test('B3 F9: answering the FIRST of two shared-scope approvals does not erase the SECOND request\'s registration', async () => {
  const harness = await mountRunnerHarness()
  try {
    const shared = new AbortController()
    const sessionRef = { session: { id: SESSION_ID } }
    const first = harness.approvalRequest({ agent: sessionRef, toolName: 'bash', reason: 'first', signal: shared.signal })
    const second = harness.approvalRequest({ agent: sessionRef, toolName: 'bash', reason: 'second', signal: shared.signal })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the first prompt is presented')
    harness.tern.key('y')
    assert.equal(await first, 'allowed-once', 'the first approval is answered explicitly')
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 2, 'the queued prompt took the seat')

    // The first request's settlement must not have deleted the second's
    // registration: the publication sweep still finds it.
    harness.setSession('session-b')
    harness.surface.reconcileInteractionPresentation()
    await waitFor(() => liveOverlays(harness.tern.ops()).length === 0,
      'the pending second prompt was withdrawn by the sweep')
    shared.abort()
    assert.equal(await second, 'cancelled')
  } finally {
    await harness.dispose()
  }
})

test('B3 F10: a replaced subject\'s request that arrives AFTER the publication never mounts', async () => {
  const harness = await mountRunnerHarness()
  let release: (() => void) | undefined
  try {
    // A legal upstream waterfall middleware awaits before calling `next`, so the
    // request reaches this answerer only after the replacement was published.
    const original = harness.plane.listeners.get('user-questions/request')
    assert.ok(original !== undefined, 'the Direct port registered the question listener')
    const held = new Promise<void>(resolve => { release = resolve })
    let admitted = false
    harness.plane.listeners.set('user-questions/request', (request, next) => held.then(() => {
      admitted = true
      return original(request, next)
    }))
    const abort = new AbortController()
    let settledAs: string | undefined
    const delivered = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-late' },
      questions: [{ id: 'q-late', question: 'Late?', options: [{ label: 'yes' }] }],
      signal: abort.signal,
    })
    void delivered.then(
      () => { settledAs = 'answered' },
      (error: unknown) => { settledAs = String((error as { readonly code?: unknown }).code) },
    )
    assert.deepEqual(overlayAdds(harness.tern.ops()), [], 'nothing is presented while the middleware holds it')

    harness.setSession('session-b')
    harness.surface.reconcileInteractionPresentation()
    release!()
    // The proof is the REAL admission, not a timer: the listener was invoked...
    await waitFor(() => admitted, 'the delayed request reached the Direct listener')
    // ...and the answerer refused it synchronously.
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(overlayAdds(harness.tern.ops()), [],
      'the replaced subject\'s late request is never mounted into the replacement')
    assert.equal(settledAs, undefined, 'it keeps its own lifetime (no fabricated settlement)')

    abort.abort()
    await waitFor(() => settledAs !== undefined, 'its own lifetime ends it')
    assert.equal(settledAs, 'ASK_ABORTED', 'the Host end classifies it ASK_ABORTED')
  } finally {
    // A held middleware always has a fallback release: a failing assertion must
    // never leave the fake Host's request chain parked.
    release?.()
    await harness.dispose()
  }
})

// ── Findings F11/F12: refused-admission ownership and opening consistency ────

test('B3 F11: a refused approval admission is drained by the surface teardown (and its borrowed listener detached)', async () => {
  const harness = await mountRunnerHarness()
  let release: (() => void) | undefined
  try {
    // A legal upstream delay: the request reaches the answerer only after the
    // replacement was published, so it is refused at admission and NEVER
    // registered in the seat or the live-approval registry.
    const original = harness.plane.listeners.get('approval/request')
    assert.ok(original !== undefined, 'the Direct port registered the approval listener')
    const held = new Promise<void>(resolve => { release = resolve })
    harness.plane.listeners.set('approval/request', (request, next) => held.then(() => original(request, next)))
    const host = new AbortController()
    let settledAs: string | undefined
    const delivered = harness.approvalRequest({
      agent: { session: { id: SESSION_ID } },
      toolName: 'bash',
      reason: 'refused admission',
      signal: host.signal,
    })
    void delivered.then(
      value => { settledAs = String(value) },
      (error: unknown) => { settledAs = `rejected:${String(error)}` },
    )
    harness.setSession('session-b')
    harness.surface.reconcileInteractionPresentation()
    release!()
    await waitFor(() => getEventListeners(host.signal, 'abort').length === 1,
      'the refused admission wired the borrowed Host lifetime')
    await Promise.resolve()
    assert.deepEqual(overlayAdds(harness.tern.ops()), [], 'a refused admission mounts nothing')
    assert.equal(settledAs, undefined, 'a refused admission does not settle early')

    // The surface teardown owns this wait: it must drain it exactly once and
    // detach the borrowed listener instead of leaving an unowned pending promise.
    harness.surface.dispose()
    await waitFor(() => settledAs !== undefined, 'the surface teardown settled the refused admission')
    assert.equal(settledAs, 'cancelled', 'the fail-closed outcome, never an allow')
    assert.equal(getEventListeners(host.signal, 'abort').length, 0,
      'the borrowed Host listener was detached with the drained wait')
    harness.surface.dispose()
    assert.equal(settledAs, 'cancelled', 'a repeated dispose is inert')
  } finally {
    // A held middleware always has a fallback release: a failing assertion must
    // never leave the fake Host's request chain parked.
    release?.()
    await harness.dispose()
  }
})

test('B3 F11/P2-A: a signal-less refused admission settles fail-closed at admission (never waits for TUI exit)', async () => {
  const harness = await mountRunnerHarness()
  let release: (() => void) | undefined
  try {
    const original = harness.plane.listeners.get('approval/request')
    assert.ok(original !== undefined)
    const held = new Promise<void>(resolve => { release = resolve })
    harness.plane.listeners.set('approval/request', (request, next) => held.then(() => original(request, next)))
    let settledAs: string | undefined
    const delivered = harness.approvalRequest({
      agent: { session: { id: SESSION_ID } },
      toolName: 'bash',
      reason: 'signal-less refused admission',
    })
    void delivered.then(
      value => { settledAs = String(value) },
      (error: unknown) => { settledAs = `rejected:${String(error)}` },
    )
    harness.setSession('session-b')
    harness.surface.reconcileInteractionPresentation()
    release!()
    // The official signal is optional, so THIS owner is the only possible end:
    // an already-inadmissible request settles at admission (P2-A) instead of
    // waiting for the surface teardown.
    await waitFor(() => settledAs !== undefined, 'the refused admission settled at admission')
    assert.equal(settledAs, 'cancelled', 'fail-closed, never an allow')
    // A teardown afterwards is still inert and leaves nothing behind.
    harness.surface.dispose()
    assert.equal(settledAs, 'cancelled')
  } finally {
    // A held middleware always has a fallback release: a failing assertion must
    // never leave the fake Host's request chain parked.
    release?.()
    await harness.dispose()
  }
})

test('B3 F12: an OPENING target\'s flow is admitted, survives the ordinary reconcile, and is retired on rollback', async () => {
  const harness = await mountRunnerHarness()
  try {
    const token = harness.surface.openingJournal.begin('session-target')
    const abort = new AbortController()
    let settledAs: string | undefined
    const delivered = harness.questionRequest({
      agent: { session: { id: 'session-target' } },
      wait: { callId: 'call-opening' },
      questions: [{ id: 'q-opening', question: 'Opening target?', options: [{ label: 'yes' }] }],
      signal: abort.signal,
    })
    void delivered.then(
      () => { settledAs = 'answered' },
      (error: unknown) => { settledAs = String((error as { readonly code?: unknown }).code) },
    )
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1,
      'the opening target\'s request IS admitted (a tentative opening is not a replacement)')

    // The ordinary activity poll must NOT treat the opening target as replaced.
    harness.surface.reconcileInteractionPresentation()
    // Give any (possibly coalesced) withdrawal frame its chance to land: the
    // negative must rest on the AUTHORITATIVE wire fact — no withdrawal frame was
    // ever committed — never on a timing artifact.
    await new Promise<void>(resolve => { setTimeout(resolve, 100) })
    assert.equal(harness.surface.openingJournal.isOpening('session-target'), true, 'the journal is still opening it')
    assert.equal(
      harness.tern.ops().some(op => op[0] === 'del' && /^layer\.modal-/u.test(String(op[1]))), false,
      'the ordinary reconcile committed NO withdrawal frame for the opening target')
    assert.deepEqual(liveOverlays(harness.tern.ops()).length, 1,
      'the opening target keeps its flow through the ordinary reconcile')
    assert.equal(settledAs, undefined, 'and its request is untouched')

    // The opening is ROLLED BACK (cleared without publication): the same rule that
    // admitted it now retires it, without waiting for a publication that never comes.
    harness.surface.openingJournal.clear(token)
    harness.surface.reconcileInteractionPresentation()
    await waitFor(() => liveOverlays(harness.tern.ops()).length === 0,
      'the rolled-back target\'s flow is retired by the ordinary pass')
    assert.equal(settledAs, undefined, 'the presentation-only retirement settles nothing')

    abort.abort()
    await waitFor(() => settledAs !== undefined, 'its own lifetime ends it')
    assert.equal(settledAs, 'ASK_ABORTED', 'the Host end classifies it ASK_ABORTED')
  } finally {
    await harness.dispose()
  }
})

test('B3 F11: a request admitted only AFTER the surface ended takes the fail-closed cancellation (never a new unowned wait)', async () => {
  const harness = await mountRunnerHarness()
  let release: (() => void) | undefined
  try {
    // The DECLARED one-sided stand-in chain (this fake Host plane's listener map,
    // invoked directly — this witness exercises no Cordis dispatch) still holds the
    // request when the surface ends: the answerer is reached only afterwards, so a
    // registration here could never be drained by anyone.
    const original = harness.plane.listeners.get('approval/request')
    assert.ok(original !== undefined, 'the Direct port registered the approval listener')
    const held = new Promise<void>(resolve => { release = resolve })
    harness.plane.listeners.set('approval/request', (request, next) => held.then(() => original(request, next)))
    const host = new AbortController()
    let withSignal: string | undefined
    let withoutSignal: string | undefined
    // A session that is neither the shown one nor an opening target: the request
    // is NON-admissible, so it reaches the REFUSED branch (never the seat's own
    // disposed guard, which would mask a missing owner fence).
    const first = harness.approvalRequest({
      agent: { session: { id: 'session-foreign' } },
      toolName: 'bash',
      reason: 'admitted after the end (with signal)',
      signal: host.signal,
    })
    const second = harness.approvalRequest({
      agent: { session: { id: 'session-foreign' } },
      toolName: 'bash',
      reason: 'admitted after the end (no signal)',
    })
    void first.then(value => { withSignal = String(value) }, error => { withSignal = `rejected:${String(error)}` })
    void second.then(value => { withoutSignal = String(value) }, error => { withoutSignal = `rejected:${String(error)}` })

    // The surface ends (interaction owner, renderer release) while the requests
    // are still upstream.
    harness.surface.dispose()
    await harness.surface.whenRendererReleased()
    assert.equal(withSignal, undefined, 'nothing settled before the request arrived')
    assert.equal(withoutSignal, undefined, 'nothing settled before the request arrived')

    release!()
    await waitFor(() => withSignal !== undefined && withoutSignal !== undefined,
      'both post-dispose admissions took the fail-closed cancellation')
    assert.equal(withSignal, 'cancelled', 'never a registration nothing can drain')
    assert.equal(withoutSignal, 'cancelled', 'the signal-less shape is settled too, never pending')
    assert.equal(getEventListeners(host.signal, 'abort').length, 0, 'no borrowed listener was attached after the end')
    harness.surface.dispose()
    assert.equal(withSignal, 'cancelled', 'a repeated disposal stays inert')
    assert.equal(withoutSignal, 'cancelled')
  } finally {
    release?.()
    await harness.dispose()
  }
})

// ── External review P2-1/P2-2: late continued offers and signal-less waits ──

test('B3 P2-1: a late continued offer never mounts into the replacement published while it waited', async () => {
  const harness = await mountRunnerHarness({ remainingMs: 60 })
  try {
    let outcome: string | undefined
    const delivered = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-late-offer', timed: true },
      questions: [{ id: 'q-late-offer', question: 'Late offer?', options: [{ label: 'yes' }] }],
      signal: new AbortController().signal,
    })
    void delivered.then(
      () => { outcome = 'answered' },
      (error: unknown) => { outcome = String((error as { readonly code?: unknown }).code) },
    )
    // The foreground wait times out: the controller now waits (bounded) for the
    // official `continued` projection, which is still absent.
    await waitFor(() => outcome === 'ASK_TIMED_OUT', 'the foreground wait timed out')
    const addsBefore = overlayAdds(harness.tern.ops()).length
    await waitFor(() => liveOverlays(harness.tern.ops()).length === 0, 'the timed-out form left the seat')

    // The replacement is published while the offer is still waiting...
    harness.setSession('session-b')
    harness.surface.reconcileInteractionPresentation()
    // ...and A's projection NOW exposes the call as `continued`.
    const state = harness.plane.states.get(SESSION_ID) ?? { questions: { active: [] as unknown[], settled: [] as unknown[] } }
    harness.plane.states.set(SESSION_ID, state)
    state.questions.active.push({
      callId: 'call-late-offer',
      questions: [{ id: 'q-late-offer', question: 'Late offer?', options: [{ label: 'yes' }] }],
      state: 'continued',
    })

    // Give the bounded offer loop several of its polling cycles.
    await new Promise<void>(resolve => { setTimeout(resolve, 400) })
    assert.equal(overlayAdds(harness.tern.ops()).length, addsBefore,
      'the late offer never mounted into the replacement')
    assert.deepEqual(liveOverlays(harness.tern.ops()), [], 'the replacement still owns the seat')
    assert.equal(state.questions.active.length, 1,
      'the official continued call stays exactly as answerable as the Host made it')
  } finally {
    await harness.dispose()
  }
})

test('B3 P2-2: signal-less live requests are settled by the replacement (fail-closed, never left hanging)', async () => {
  const harness = await mountRunnerHarness()
  try {
    // The official signal is OPTIONAL for both kinds: these requests have no
    // lifetime of their own, so only this owner can ever end them.
    let questionOutcome: string | undefined
    let approvalOutcome: string | undefined
    const question = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-nosignal-question' },
      questions: [{ id: 'q-nosignal', question: 'No signal?', options: [{ label: 'yes' }] }],
    })
    const approval = harness.approvalRequest({
      agent: { session: { id: SESSION_ID } },
      toolName: 'bash',
      reason: 'no signal',
    })
    void question.then(
      () => { questionOutcome = 'answered' },
      (error: unknown) => { questionOutcome = String((error as { readonly code?: unknown }).code) },
    )
    void approval.then(
      value => { approvalOutcome = String(value) },
      (error: unknown) => { approvalOutcome = `rejected:${String(error)}` },
    )
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the first request is presented')
    assert.equal(questionOutcome, undefined, 'nothing is settled while its Session is still admissible')

    // The replacement: the presentation leaves AND the signal-less requests are
    // settled by their owner (only the Host's own lifetime could do it otherwise).
    harness.setSession('session-b')
    harness.surface.reconcileInteractionPresentation()
    await waitFor(() => questionOutcome !== undefined && approvalOutcome !== undefined,
      'the replacement settled both signal-less requests')
    assert.equal(questionOutcome, 'ASK_ABORTED', 'a session-driven end, never a user cancel')
    assert.equal(approvalOutcome, 'cancelled', 'the approval stays fail-closed, never an allow')
    assert.deepEqual(liveOverlays(harness.tern.ops()), [], 'no stale slot is left behind')
  } finally {
    await harness.dispose()
  }
})

test('B3 P2-A: an inadmissible request with NO Host lifetime settles at admission (no TUI exit needed)', async () => {
  const harness = await mountRunnerHarness()
  let release: (() => void) | undefined
  try {
    // Both kinds are held by a legal upstream middleware and released only AFTER
    // the replacement was published: they reach the answerers already
    // inadmissible, and neither carries a Host lifetime.
    const questionOriginal = harness.plane.listeners.get('user-questions/request')
    const approvalOriginal = harness.plane.listeners.get('approval/request')
    assert.ok(questionOriginal !== undefined && approvalOriginal !== undefined,
      'the Direct port registered both listeners')
    const held = new Promise<void>(resolve => { release = resolve })
    harness.plane.listeners.set('user-questions/request', (request, next) => held.then(() => questionOriginal(request, next)))
    harness.plane.listeners.set('approval/request', (request, next) => held.then(() => approvalOriginal(request, next)))
    let questionOutcome: string | undefined
    let approvalOutcome: string | undefined
    const question = harness.questionRequest({
      agent: { session: { id: SESSION_ID } },
      wait: { callId: 'call-p2a-question' },
      questions: [{ id: 'q-p2a', question: 'Late?', options: [{ label: 'yes' }] }],
    })
    const approval = harness.approvalRequest({
      agent: { session: { id: SESSION_ID } },
      toolName: 'bash',
      reason: 'late admission',
    })
    void question.then(
      () => { questionOutcome = 'answered' },
      (error: unknown) => { questionOutcome = String((error as { readonly code?: unknown }).code) },
    )
    void approval.then(
      value => { approvalOutcome = String(value) },
      (error: unknown) => { approvalOutcome = `rejected:${String(error)}` },
    )

    harness.setSession('session-b')
    harness.surface.reconcileInteractionPresentation()
    release!()
    await waitFor(() => questionOutcome !== undefined && approvalOutcome !== undefined,
      'both late requests settled at admission — WITHOUT any surface teardown')
    assert.equal(questionOutcome, 'ASK_ABORTED', 'the Question keeps its truthful Host-side classification')
    assert.equal(approvalOutcome, 'cancelled', 'the approval stays fail-closed, never an allow')
    assert.deepEqual(overlayAdds(harness.tern.ops()), [], 'neither late request was ever presented')

    // POSITIVE CONTROL: the surface is still alive and usable (nothing was
    // disposed to settle them) — the CURRENT subject's request presents normally.
    const current = harness.questionRequest({
      agent: { session: { id: 'session-b' } },
      wait: { callId: 'call-still-alive' },
      questions: [{ id: 'q-alive', question: 'Alive?', options: [{ label: 'yes' }] }],
    })
    await waitFor(() => overlayAdds(harness.tern.ops()).length === 1, 'the replacement still presents its own request')
    harness.tern.key('\r')
    harness.tern.key('\r')
    assert.deepEqual(await current, { answers: [{ id: 'q-alive', selected: ['yes'] }] })
  } finally {
    release?.()
    await harness.dispose()
  }
})
