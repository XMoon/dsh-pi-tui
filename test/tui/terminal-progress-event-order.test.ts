/**
 * L5/L6 real-path proof (plan §6.4): the installed `@deepseek-ai/*@0.2.0-rc.2`
 * AgentLoop is run against a recording LLM adapter, and its REAL events are fed
 * through the REAL surface routing into the REAL terminal sink.
 *
 * This is deliberately not a fake-injection suite: the completion evidence the
 * terminal sees comes from actual `turn/start` / `turn/end(reason.kind)` and
 * `agent/status` emissions of the production loop, so the arrival order the
 * progress contract depends on (`turn/end` before the owning `agent/status
 * idle`) is asserted on the real source, not on a hand-built ordering.
 *
 * FIXTURE MANIFEST (plan §6.4 — which production prerequisites are real, which
 * are stand-ins, and which are intentionally absent):
 *
 * - REAL: the installed npm `@deepseek-ai/dsh-agent-loop` /
 *   `dsh-session` / `dsh-llm` / `dsh-tools` stack, the production
 *   `createSurfaceRuntime` + event routing + `TuiApp`, and the injected
 *   `VirtualTerminal` sink. The Agent/Session ids used by the routing fences
 *   are the REAL Agent/Session identities.
 * - STAND-IN: the `SurfaceEventRoutingSource` bundle is the minimal structural
 *   stand-in the surface contract requires — the transcript/stats/window
 *   targets and the Direct bookkeeping callbacks are no-ops, because none of
 *   them is on the terminal-progress evidence path (plan §4.3: the routing
 *   decision, the interval fold and the sink are the parts under test).
 * - NOT COVERED HERE: the official Client -> Gateway -> Host **Remote** wire.
 *   The Remote branch has no correlatable main `agent/status` input (the
 *   subscription is Direct-only), so this suite proves the Direct source ->
 *   routing -> fold -> sink chain only and makes NO Remote claim (plan §6.4
 *   STOP). Real GUI terminals (Ghostty/Tern) are likewise not covered here.
 * @module @xmoon76/dsh-pi-tui/terminal-progress-event-order.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  LlmError,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createSurfaceRuntime } from '../../src/app/surface/runtime.ts'
import type { SurfaceEventRoutingSource } from '../../src/app/surface/event-routing.ts'
import { PendingSubmissions, type DirectPendingSubmissionEvent } from '../../src/app/submission/pending-submission.ts'
import { DirectSubmissionPresentation } from '../../src/app/submission/presentation.ts'
import { queueTextOf as queueTextOfProduction } from '../../src/app/surface/pending-presentation.ts'
import { DirectPendingInputReader } from '../../src/runtime/direct/pending-input-reader-direct.ts'
import { DirectSessionWriter } from '../../src/runtime/direct/session-writer-direct.ts'
import type { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { installVirtualProcessTerminal } from '../support/runner-harness.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

const MAIN = 'osc7501-event-order-main'
const IDLE = '\x1b]7501;state=idle:app=dsh-pi-tui\x1b\\'
const WORKING = '\x1b]7501;state=working:app=dsh-pi-tui\x1b\\'
const DONE = '\x1b]7501;state=done:app=dsh-pi-tui\x1b\\'
const ERROR = '\x1b]7501;state=error:app=dsh-pi-tui\x1b\\'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Answers every request with one text response: the `completed` path. */
class CompletedAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(): AsyncIterable<StreamChunk> {
    for (const chunk of textResponse('ok')) yield chunk
  }
}

/** Fails the request with an official `LlmError`: the `error` path. */
class FailingAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(): AsyncIterable<StreamChunk> {
    throw new LlmError('probe failure', 'UNKNOWN')
  }
}

/** Blocks until the turn is cancelled: the `aborted` path. */
class AbortableAdapter extends LlmAdapter {
  readonly started: Promise<void>
  private signalStarted!: () => void
  constructor() {
    super()
    this.started = new Promise(resolve => { this.signalStarted = resolve })
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.signalStarted()
    await new Promise<never>((_resolve, reject) => {
      const signal = options.signal
      if (signal === undefined) {
        reject(new Error('the loop must pass an abort signal'))
        return
      }
      if (signal.aborted) {
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
    })
  }
}

/**
 * Deterministic PREPARATION-failing adapter: the first turn's `resolveModel`
 * resolves only when the test releases it, after which the PINNED
 * `prepareCall` rejects with the official UNSUPPORTED_REASONING_EFFORT class
 * (the model advertises no reasoning-effort capability). The second turn's
 * preparation is held until released too, so a queued identity can be observed
 * as still pending across the failed turn. The provider stream is never
 * reached — the failure precedes the durable `user/message`.
 */
class PrepFailingAdapter extends LlmAdapter {
  private readonly first = Promise.withResolvers<void>()
  private readonly second = Promise.withResolvers<void>()
  readonly firstResolveStarted = Promise.withResolvers<void>()
  private calls = 0
  streamCalls = 0
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.calls += 1
    if (this.calls === 1) {
      this.firstResolveStarted.resolve()
      await this.first.promise
    } else {
      await this.second.promise
    }
    return { provider, id: model, name: model }
  }
  async * stream(): AsyncIterable<StreamChunk> {
    this.streamCalls += 1
    throw new LlmError('the preparation failure must reject before the provider stream', 'UNKNOWN')
  }
  releaseFirst(): void { this.first.resolve() }
  releaseSecond(): void { this.second.resolve() }
}

/**
 * Queue-steer transfer producer: the first turn holds its provider stream so a
 * queued message can be promoted to steering while the turn is running; the
 * promoted message's next request preparation is held and then rejects at
 * `resolveModel` (preparation, before any durable `user/message`). This is the
 * exact `remove` → insert next-step → claim → preparation window.
 */
class SteerTransferAdapter extends LlmAdapter {
  private readonly holdStream = Promise.withResolvers<void>()
  private readonly holdSecondPrep = Promise.withResolvers<void>()
  readonly streamStarted = Promise.withResolvers<void>()
  readonly secondResolveStarted = Promise.withResolvers<void>()
  private resolves = 0
  private streams = 0
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.resolves += 1
    if (this.resolves >= 2) {
      this.secondResolveStarted.resolve()
      await this.holdSecondPrep.promise
      throw new LlmError('probe preparation failure after the steering claim', 'UNKNOWN')
    }
    return { provider, id: model, name: model }
  }
  async * stream(): AsyncIterable<StreamChunk> {
    this.streams += 1
    if (this.streams > 1) throw new LlmError('only the holding stream is expected', 'UNKNOWN')
    this.streamStarted.resolve()
    await this.holdStream.promise
    for (const chunk of textResponse('holding answer')) yield chunk
  }
  releaseHeldStream(): void { this.holdStream.resolve() }
  releaseSecondPrep(): void { this.holdSecondPrep.resolve() }
}

const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

interface Probe {
  readonly order: string[]
  readonly programWrites: string[]
  /** Every REAL durable Session event the loop produced, in emission order. */
  readonly events: readonly { readonly type: string; readonly seq: number; readonly data: unknown }[]
  /** The Direct pending ledger wired into the REAL event routing. */
  readonly pending: PendingSubmissions
  /** The REAL mounted terminal sink. */
  readonly terminal: VirtualTerminal
  /** Resolves when the first `turn/end` reaches the routing. */
  readonly firstTurnEnd: Promise<void>
  /** Register one local echo exactly like the production submit path does. */
  beginEcho(requestId: string, text: string, placement?: 'transcript' | 'queued' | 'steering'): void
  /** Deliver one identified user message through the REAL `agent.followup`. */
  followupIdentified(requestId: string, text: string): void
  /** Promote one queued occurrence through the REAL Direct `updateQueue` steer
   *  adapter (the production `remove` + `agent.steer` producer sequence). */
  steerQueued(requestId: string): Promise<{ readonly kind: string }>
  /** Wait for every activity driver to settle (after releasing the fixture). */
  quiesce(): Promise<void>
  run(text: string): Promise<void>
  abortRun(text: string, adapter: AbortableAdapter): Promise<void>
  dispose(): void
}

/** The generation the fixture's ledger records pin (a stand-in for the
 *  production ownership generation; the reconciliation itself only requires
 *  the routing fence and the record to agree). */
const PENDING_GENERATION = 0

/**
 * Mount the REAL rc.2 AgentLoop + the REAL surface routing over a recording
 * terminal, and subscribe the surface to the loop's OWN events (the same
 * delegation the production composition installs).
 */
async function createProbe(
  adapter: LlmAdapter,
  agentOptions: { readonly reasoningEffort?: ReturnType<typeof ReasoningEffortId> } = {},
): Promise<Probe> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  // The official executor owns batch settlement (DSH 0.2.2 Base installs it;
  // this standalone fixture must do the same).
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['probe'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(MAIN), {
    provider: 'probe',
    model: 'probe-model',
    ...agentOptions,
  })
  // The Direct pending echo lifecycle: the REAL ledger, the REAL Direct
  // pending-input reader over the live Agent inbox, and the REAL submission
  // presentation source — the same composition production mounts.
  const pending = new PendingSubmissions()
  const submissionPresentation = new DirectSubmissionPresentation(pending)
  const pendingReader = new DirectPendingInputReader(() => agent)

  const vt = new VirtualTerminal(100, 30)
  const programWrites: string[] = []
  const passthroughWrite = vt.write.bind(vt)
  vt.write = (data: string) => {
    for (const match of data.matchAll(/\x1b\]7501;[^\x1b]*\x1b\\/g)) programWrites.push(match[0])
    passthroughWrite(data)
  }
  const restoreTerminal = installVirtualProcessTerminal(vt)

  const emptySink = { apply: () => {} }
  const emptyFolder = {
    apply: () => {},
    groupedTurns: () => [],
    turnActivities: () => [],
    searchRevision: () => 0,
    window: () => ({ messages: [], firstTurn: undefined, lastTurn: undefined, hasNewer: false }),
  } as unknown as TranscriptFolder
  const mainWindow = new TranscriptWindowController()
  const routingSource = {
    isCleanedUp: () => false,
    isAttachedSession: () => true,
    currentSessionId: () => MAIN,
    hasLiveAgent: () => true,
    completionOwnerId: () => agent.id,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => ({
      folder: emptyFolder, stats: emptySink, window: mainWindow, previews: new Map(),
      applyToolPreview: () => {}, refreshRecentPerformanceAvailability: () => {},
    }),
    viewedChildId: () => undefined,
    viewedChild: () => { throw new Error('no viewed child in this probe') },
    mainFolder: () => emptyFolder,
    viewedChildFolder: () => emptyFolder,
    pendingSubjectId: (): string => MAIN,
    pendingSnapshot: (sessionId: string) => pendingReader.snapshot(sessionId),
    submissionEchoes: (sessionId: string | undefined) => submissionPresentation.snapshot(sessionId),
    queueTextOf: (content: readonly unknown[]) => queueTextOfProduction(content as never),
    exitView: () => {},
    refreshStatusCheap: () => {},
    refreshStatusAndWelcome: () => {},
    applyGoalChange: () => {},
    sessionTitleOf: () => undefined,
    extendLoadedHistory: () => false,
    settleLocalSubmitAck: () => {},
    markSubmitLatency: () => {},
    observeDurableSubmission: () => {},
    // PR1: the Direct terminal reconciliation, wired exactly like the Direct
    // composition binds it — the REAL ledger folds the REAL Host events the
    // routing forwards.
    observeDirectPendingSubmissionEvent: (event: DirectPendingSubmissionEvent, sessionId: string) =>
      pending.observeDirectHostEvent({ sessionId, generation: PENDING_GENERATION, event }),
    markContextDirty: () => {},
    refreshContextMeasurement: () => {},
    currentWorkingFromLog: () => false,
    flushTurn: () => {},
    registeredAgentIs: () => true,
    isCurrentOwnerAgent: () => true,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: () => {},
    applyMainAssistantInput: () => {},
  } as unknown as SurfaceEventRoutingSource<never>

  const surface = createSurfaceRuntime({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    terminalProgress: undefined,
    mainProgressAuthority: 'local-events',
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
  })
  surface.attachEventRouting(routingSource)
  surface.setCompletionOwner(agent.id)
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised by this test')) },
    readImage: () => Promise.reject(new Error('not exercised by this test')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    captureHistoryScope: () => ({ sessionId: MAIN, isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: (text) => text,
  })

  // The production delegation, installed AFTER the mount exactly as the
  // composition root does: the surface consumes the loop's own events.
  const order: string[] = []
  const events: Array<{ type: string; seq: number; data: unknown }> = []
  const firstTurnEnd = Promise.withResolvers<void>()
  let firstTurnEndSeen = false
  ctx.on('session/event', (session, event) => {
    assert.equal(session.id, MAIN, 'every routed session event belongs to the main session')
    events.push({ type: event.type, seq: Number(event.seq), data: event.data })
    if (event.type === 'turn/start') order.push('turn/start')
    else if (event.type === 'turn/end') order.push(`turn/end:${(event.data as { reason: { kind: string } }).reason.kind}`)
    if (event.type === 'turn/end' && !firstTurnEndSeen) {
      firstTurnEndSeen = true
      firstTurnEnd.resolve()
    }
    surface.routeSessionEvent(session, event)
  })
  ctx.on('agent/status', ({ agent: subject, status }) => {
    assert.equal(subject.id, agent.id, 'every routed status belongs to the live Agent')
    order.push(`status:${status}`)
    surface.routeAgentStatus(subject.id, status)
  })

  let disposed = false
  return {
    order,
    programWrites,
    events,
    pending,
    terminal: vt,
    firstTurnEnd: firstTurnEnd.promise,
    beginEcho: (requestId, text, placement = 'transcript') => {
      pending.begin({ requestId, placement, text, createdAt: 1, sessionId: MAIN, generation: PENDING_GENERATION })
      surface.refreshPendingInput()
    },
    steerQueued: async (requestId) => {
      const message = agent.inbox.nextTurn.find(candidate =>
        (candidate.source as { readonly rpcId?: unknown } | undefined)?.rpcId === requestId)
      if (message === undefined) throw new Error(`no queued occurrence for "${requestId}"`)
      // The REAL Direct adapter: `inbox.remove` then `agent.steer`, two Host
      // Inbox mutations — the producer sequence the ledger must survive.
      const writer = new DirectSessionWriter(
        { get: () => ({ retirePrompt: () => {} }) } as never,
        sessionId => sessionId === MAIN ? agent : undefined,
      )
      return writer.updateQueue(MAIN, message.id, { kind: 'steer' })
    },
    followupIdentified: (requestId, text) => {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'user', rpcId: requestId } as never,
      }))
    },
    quiesce: () => agent.whenIdle(),
    run: async (text) => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
    abortRun: async (text, abortable) => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      const idle = agent.whenIdle()
      await abortable.started
      agent.cancel({ kind: 'user' })
      await idle
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      surface.dispose()
      restoreTerminal()
    },
  }
}

/** Flush the routing microtasks/scheduled repaints. */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

test('rc.2 completed: turn/end arrives before the owning agent/status idle and settles done', async () => {
  const probe = await createProbe(new CompletedAdapter())
  try {
    await settle()
    assert.deepEqual(probe.programWrites, [IDLE], 'the mount asserts idle')
    await probe.run('finish this turn')
    await settle()
    const order = probe.order
    const start = order.indexOf('turn/start')
    const end = order.indexOf('turn/end:completed')
    const idle = order.indexOf('status:idle')
    assert.ok(start >= 0, `the real turn/start was observed: ${order.join(', ')}`)
    assert.ok(end > start, 'turn/end arrives after its turn/start')
    assert.ok(idle > end, 'the owning agent/status idle arrives AFTER turn/end (the settle fence holds)')
    assert.deepEqual(probe.programWrites, [IDLE, WORKING, DONE],
      'the real loop settles OSC 7501 done exactly once')
  } finally {
    probe.dispose()
  }
})

test('rc.2 error: a failing request settles error, never done', async () => {
  const probe = await createProbe(new FailingAdapter())
  try {
    await settle()
    await probe.run('fail this turn')
    await settle()
    const order = probe.order
    const start = order.indexOf('turn/start')
    const end = order.indexOf('turn/end:error')
    const idle = order.indexOf('status:idle')
    assert.ok(start >= 0 && end > start, `the error turn/end follows its start: ${order.join(', ')}`)
    assert.ok(idle > end, 'the idle status arrives after the error turn/end')
    assert.deepEqual(probe.programWrites, [IDLE, WORKING, ERROR])
  } finally {
    probe.dispose()
  }
})

test('rc.2 aborted: a cancelled turn settles idle, never a fabricated completion', async () => {
  const adapter = new AbortableAdapter()
  const probe = await createProbe(adapter)
  try {
    await settle()
    await probe.abortRun('cancel this turn', adapter)
    await settle()
    const order = probe.order
    const start = order.indexOf('turn/start')
    const end = order.indexOf('turn/end:aborted')
    const idle = order.indexOf('status:idle')
    assert.ok(start >= 0 && end > start, `the aborted turn/end follows its start: ${order.join(', ')}`)
    assert.ok(idle > end, 'the idle status arrives after the aborted turn/end')
    assert.deepEqual(probe.programWrites, [IDLE, WORKING, IDLE],
      'an aborted turn is honestly idle — not done')
  } finally {
    probe.dispose()
  }
})

// FIXTURE MANIFEST for the case below (the plan's §7 "L5" shorthand for the
// real pinned AgentLoop producer; canonical host-client.md L5 is the official
// Client→Gateway→Host wire, which this Direct producer integration does not
// include and does not claim):
// - REAL: the published pinned AgentLoop / session / LLM runtime, its own
//   `agent/inbox/spliced` producer and `turn/end` emission, the actual event
//   router, the actual Direct pending ledger and the actual terminal sink.
// - STAND-IN: a deterministic adapter that makes the pinned `prepareCall`
//   reject with UNSUPPORTED_REASONING_EFFORT before the message is admitted,
//   the fixture routing source's transcript/stats no-op targets, and the
//   fixture ledger generation constant.
// - ABSENT: network/live provider credentials, the official Client→Gateway→
//   Host wire, the official Remote wire and the physical GUI.
test('a preparation failure after the real Inbox claim retires only that Direct echo', async () => {
  const adapter = new PrepFailingAdapter()
  const probe = await createProbe(adapter, { reasoningEffort: ReasoningEffortId('xhigh') })
  try {
    const claimedId = 'real-input-claimed'
    const queuedId = 'real-input-queued'
    probe.beginEcho(claimedId, '再看看')
    await probe.terminal.waitForRender()
    const pendingFrame = probe.terminal.getViewport().join('\n')
    assert.ok(pendingFrame.includes('再看看'), `the local echo renders while pending:\n${pendingFrame}`)
    assert.ok(pendingFrame.includes('sending…'), `the pending row advertises sending:\n${pendingFrame}`)

    // The REAL Host accepts the prompt through agent.followup; the REAL loop
    // then claims it and enters request preparation.
    probe.followupIdentified(claimedId, '再看看')
    await adapter.firstResolveStarted.promise
    const splices = probe.events.filter(entry => entry.type === 'agent/inbox/spliced')
    assert.ok(splices.some(entry => {
      const data = entry.data as { inserted?: readonly { source?: { rpcId?: unknown } }[] }
      return data.inserted?.some(message => message.source?.rpcId === claimedId) === true
    }), 'the real Host Inbox insertion carries the exact request identity')
    assert.ok(splices.some(entry => (entry.data as { removedCount?: unknown }).removedCount === 1),
      'the real loop CLAIMED the accepted input before request preparation')

    // A second identity queues behind the in-flight turn and must survive the
    // first identity's failure.
    probe.beginEcho(queuedId, 'kept queued')
    probe.followupIdentified(queuedId, 'kept queued')

    // Release the preparation: the pinned capability validation rejects, so
    // the turn ends with error and NO durable user/message is ever appended.
    adapter.releaseFirst()
    await probe.firstTurnEnd
    await probe.terminal.waitForRender()

    assert.ok(!probe.events.some(entry => entry.type === 'user/message'),
      'the preparation failure precedes every durable user/message')
    const errorEnd = probe.events.find(entry => {
      const data = entry.data as { reason?: { kind?: unknown } }
      return entry.type === 'turn/end' && data.reason?.kind === 'error'
    })
    assert.ok(errorEnd, 'the real loop ends the failed turn with an error boundary')
    assert.equal((errorEnd.data as { reason: { error: { code: string } } }).reason.error.code,
      'UNSUPPORTED_REASONING_EFFORT',
      'the failure is the official pre-admission capability rejection class')
    assert.equal(adapter.streamCalls, 0, 'the provider stream is never reached')
    assert.deepEqual(probe.pending.snapshot().map(echo => echo.requestId), [queuedId],
      'the claimed-and-failed echo retires; the queued sibling remains')

    const settledFrame = probe.terminal.getViewport().join('\n')
    assert.ok(!settledFrame.includes('再看看'),
      `the failed echo no longer renders as pending:\n${settledFrame}`)
    assert.ok(settledFrame.includes('kept queued'),
      `the queued sibling stays visible:\n${settledFrame}`)
    // The sibling is the SAME pending identity in whichever presentation its
    // exact Host state implies: the authoritative queue row while it is still
    // in the Inbox, or its local sending echo once that row was claimed but no
    // terminal boundary has crossed it.
    assert.ok(settledFrame.includes('Queue · 1') || settledFrame.includes('sending…'),
      `the still-pending sibling advertises its pending state:\n${settledFrame}`)
  } finally {
    // The held preparation gates are fixture-owned promises the real loop's
    // teardown cannot cancel. Release them unconditionally on EVERY exit path
    // (assertion failure, fixture throw, completion) and let the loop settle
    // before disposing the surface, so a failure never hangs the Context
    // teardown that awaits the pending turn.
    adapter.releaseFirst()
    adapter.releaseSecond()
    await probe.quiesce()
    probe.dispose()
  }
})

// FIXTURE MANIFEST for the case below (the plan's §7 "L5" shorthand for the
// real pinned producer; canonical host-client.md L5 is the official
// Client→Gateway→Host wire, which this Direct producer integration does not
// include and does not claim):
// - REAL: the pinned AgentLoop / session / LLM runtime, its own Inbox splice
//   producer, the REAL Direct `SessionWriter.updateQueue` steer adapter
//   (`inbox.remove` + `agent.steer`), the actual event router, the actual
//   Direct pending ledger and the actual terminal sink.
// - STAND-IN: the holding/preparation-failing adapter, the writer's Host
//   context read (only the queue-remove file-upload retirement seam, which a
//   steer never reaches), the fixture routing source's no-op transcript
//   targets and the fixture ledger generation constant.
// - ABSENT: network/live provider credentials, the Client→Gateway→Host wire,
//   the official Remote wire and the physical GUI.
test('a queue steer keeps the promoted echo visible until its claimed boundary', async () => {
  const adapter = new SteerTransferAdapter()
  const probe = await createProbe(adapter)
  try {
    const promotedId = 'queue-steer-promoted'
    // Hold a live turn so the occurrence-level steer is legal.
    probe.followupIdentified('holder', 'hold this turn')
    await adapter.streamStarted.promise

    probe.beginEcho(promotedId, 'steer me', 'queued')
    probe.followupIdentified(promotedId, 'steer me')
    await probe.terminal.waitForRender()

    const outcome = await probe.steerQueued(promotedId)
    assert.equal(outcome.kind, 'committed', 'the real Direct writer committed the steer')

    // The removal alone must not retire the echo; the promotion follows the
    // occurrence into the steering lane.
    const promoted = probe.pending.snapshot().find(echo => echo.requestId === promotedId)
    assert.ok(promoted, 'the queued echo survives the canceled removal')
    assert.equal(promoted.placement, 'steering', 'the echo follows the steering placement')
    assert.ok(probe.events.some(entry => {
      const data = entry.data as { target?: unknown; inserted?: readonly { source?: { rpcId?: unknown } }[] }
      return entry.type === 'agent/inbox/spliced' && data.target === 'next-step'
        && data.inserted?.some(message => message.source?.rpcId === promotedId) === true
    }), 'the real Agent Inbox produced the next-step insertion for the same identity')

    // Finish the held turn: the loop then claims the promoted occurrence for
    // its next request preparation, which is HELD.
    adapter.releaseHeldStream()
    await adapter.secondResolveStarted.promise
    await probe.terminal.waitForRender()
    assert.ok(probe.pending.snapshot().some(echo => echo.requestId === promotedId),
      'the claimed-but-not-admitted echo is still the only local representation')
    const claimedFrame = probe.terminal.getViewport().join('\n')
    assert.ok(claimedFrame.includes('steer me'), `the promoted content stays visible:\n${claimedFrame}`)
    assert.ok(claimedFrame.includes('steering…'), `the pending row keeps its steering status:\n${claimedFrame}`)
    assert.ok(probe.events.some(entry => {
      const data = entry.data as { target?: unknown; removedCount?: unknown }
      return entry.type === 'agent/inbox/spliced' && data.target === 'next-step' && data.removedCount === 1
    }), 'the real loop claimed the promoted occurrence')

    // The preparation then fails without a durable user/message: the claimed
    // echo retires on the strictly later turn boundary.
    adapter.releaseSecondPrep()
    await probe.quiesce()
    await probe.terminal.waitForRender()
    assert.deepEqual(probe.pending.snapshot(), [])
    assert.ok(!probe.events.some(entry => {
      const data = entry.data as { source?: { rpcId?: unknown } }
      return entry.type === 'user/message' && data.source?.rpcId === promotedId
    }), 'the promoted input never became a durable user message')
    const settledFrame = probe.terminal.getViewport().join('\n')
    assert.ok(!settledFrame.includes('steer me'), `the failed echo no longer renders:\n${settledFrame}`)
  } finally {
    // Fixture-owned gates are always released (no hanging teardown on any
    // failing assertion).
    adapter.releaseHeldStream()
    adapter.releaseSecondPrep()
    await probe.quiesce()
    probe.dispose()
  }
})
