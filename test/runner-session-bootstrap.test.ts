/** Runner-level regression coverage for the single cold-session hydration path. */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, MessageId, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { apply as applyRunner, Config as TuiConfigSchema } from '../src/index.ts'

/** The effective merged view a real SettingsForms describe() would project
 * for the tui-app entry mounted with the given plain config input (schema
 * defaults + the passed overrides). */
function effectiveConfigView(input: Record<string, unknown>): Record<string, unknown> {
  const resolved = TuiConfigSchema(input as never) as unknown as Record<string, { get(): unknown }>
  return Object.fromEntries(
    Object.entries(resolved)
      .filter(([field]) => field !== 'sessionId' && field !== 'startupStatusOutput')
      .map(([field, ref]) => [field, ref.get()])
      .filter(([, value]) => value !== undefined),
  )
}
import { foldPendingModelSelection } from '../src/model-selection.ts'
import { StatsFolder } from '../src/stats.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp, type StreamingToolPreview } from '../src/tui-app.ts'
import {
  disposeContext,
  event,
  fakeSession,
  installVirtualProcessTerminal,
  makeHarness,
  mountRunner,
  sessionEvents,
  settle,
  type FakeSession,
  type RunnerHarness,
} from './support/runner-harness.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** One Session v2 live assistant-stream frame (the transient plane
 * replaces durable `assistant/chunk` events). The shape is the EXACT
 * upstream `AssistantStreamFrame`: only `start` carries turn/step; chunk
 * and end name their attempt plus the dense revision and dense index. */
type LiveStreamFrame =
  | { type: 'start'; attemptId: string; revision: number; turn: number; step: number }
  | { type: 'chunk'; attemptId: string; revision: number; index: number; time: number; chunk: unknown }
  | {
    type: 'end'
    attemptId: string
    revision: number
    index: number
    outcome: { kind: 'committed'; eventType: 'assistant/message' | 'assistant/attempt'; seq: number } | { kind: 'abandoned' }
  }

let liveStreamRevision = 0
test.beforeEach(() => { liveStreamRevision = 0 })

/** Start one live attempt (upstream: AssistantStreamAttempt.start). */
function liveStart(attemptId: string, turn: number, step: number): LiveStreamFrame {
  return { type: 'start', attemptId, revision: ++liveStreamRevision, turn, step }
}

/** One live attempt chunk (upstream push — no turn/step on the wire). */
function liveChunkFrame(attemptId: string, index: number, chunk: unknown): LiveStreamFrame {
  return { type: 'chunk', attemptId, revision: ++liveStreamRevision, index, time: 1_700_000_000_000 + index, chunk }
}

/** Settle a live attempt after its durable event committed. */
function liveCommittedEnd(attemptId: string, chunkCount: number, eventType: 'assistant/message' | 'assistant/attempt'): LiveStreamFrame {
  return { type: 'end', attemptId, revision: ++liveStreamRevision, index: chunkCount, outcome: { kind: 'committed', eventType, seq: 100 } }
}

/** Emit one live assistant-stream frame on the Cordis context with the
 * REAL emitting Agent object (the runner's identity fence compares exact
 * Agent identity — never a session id). The event name is master-only
 * (absent from the local Cordis Events map), so the context is read
 * through a loose emit surface. */
function emitLiveStream(ctx: Context, subject: unknown, frame: LiveStreamFrame): void {
  const emit = (ctx as unknown as { emit(name: string, payload: unknown): void }).emit
  emit('agent/assistant-stream', { agent: subject, frame })
}

/** Resolve a harness's live Agent object by session id (the same object
 * the resume returned — required for the exact-identity fence). */
function liveAgentOf(harness: RunnerHarness, sessionId: string): unknown {
  const agents = harness.agents as { get?(id: string): unknown }
  const agent = agents.get?.(sessionId)
  assert.ok(agent !== undefined, `live agent for ${sessionId} must exist`)
  return agent
}

function modelEvent(type: 'model/selection' | 'request/header', data: unknown, seq: number): SessionEvent {
  return {
    type,
    seq: SessionSeq(seq),
    time: 1_700_000_000_000 + seq * 1000,
    data,
  } as unknown as SessionEvent
}

function resequence(events: readonly SessionEvent[]): SessionEvent[] {
  return events.map((entry, index) => ({
    ...entry,
    seq: SessionSeq(index),
    time: 1_700_000_000_000 + index * 1000,
  }))
}

function modelHistory(provider: string, model: string, reasoningEffort: string): SessionEvent[] {
  const header = {
    config: { provider, model, reasoningEffort },
  }
  return [
    modelEvent('model/selection', { provider, model, reasoningEffort }, 6),
    modelEvent('request/header', { header }, 7),
  ]
}

/** The newest durable model/selection intent recorded in a Session log. */
function durableSelectionOf(session: FakeSession): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
  const event = session.snapshotEvents().findLast(candidate => (candidate as unknown as { type?: unknown }).type === 'model/selection')
  return (event as unknown as { data?: { provider?: string; model?: string; reasoningEffort?: string } } | undefined)?.data
}

interface RunnerProbe {
  transcriptApplyCount: number
  statsApplyCount: number
  transcriptHydrateCount: number
  statsHydrateCount: number
  capturedMessages: readonly { kind: string; text?: string }[] | undefined
  capturedActivities: ReadonlyMap<number, unknown> | undefined
  capturedStreamingToolPreviews: readonly StreamingToolPreview[] | undefined
  capturedViewerUsage: unknown
  capturedViewerMode: unknown
  capturedApproval: { toolName?: string; arguments?: string; danger?: boolean } | undefined
  scrollToBottomCount: number
  capturedModels: string[]
  capturedWelcomeModels: string[]
  /** Every `app.notify(message, kind)` this run surfaced. */
  notices: string[]
  apps: TuiApp[]
  restore: () => void
}

/** Observe the production runner without replacing its TUI or projection code. */
function installProbe(): RunnerProbe {
  const probe: RunnerProbe = {
    transcriptApplyCount: 0,
    statsApplyCount: 0,
    transcriptHydrateCount: 0,
    statsHydrateCount: 0,
    capturedMessages: undefined,
    capturedActivities: undefined,
    capturedStreamingToolPreviews: undefined,
    capturedViewerUsage: undefined,
    capturedViewerMode: undefined,
    capturedApproval: undefined,
    scrollToBottomCount: 0,
    capturedModels: [],
    capturedWelcomeModels: [],
    notices: [],
    apps: [],
    restore: () => {},
  }
  const originalTranscriptApply = TranscriptFolder.prototype.apply
  const originalStatsApply = StatsFolder.prototype.apply
  const originalTranscriptHydrate = TranscriptFolder.prototype.hydrate
  const originalStatsHydrate = StatsFolder.prototype.hydrate
  const originalSetTranscript = TuiApp.prototype.setTranscript
  const originalSetViewerFooter = TuiApp.prototype.setViewerFooter
  const originalSetViewerMode = TuiApp.prototype.setViewerMode
  const originalShowApprovalPrompt = TuiApp.prototype.showApprovalPrompt
  const originalSetStatus = TuiApp.prototype.setStatus
  const originalSetWelcomeCard = TuiApp.prototype.setWelcomeCard
  const originalNotify = TuiApp.prototype.notify
  const originalStart = TuiApp.prototype.start
  const originalScrollToBottom = TuiApp.prototype.scrollToBottom
  TranscriptFolder.prototype.apply = function (events) {
    probe.transcriptApplyCount += 1
    return originalTranscriptApply.call(this, events)
  }
  StatsFolder.prototype.apply = function (events) {
    probe.statsApplyCount += 1
    return originalStatsApply.call(this, events)
  }
  TranscriptFolder.prototype.hydrate = function (events) {
    probe.transcriptHydrateCount += 1
    return originalTranscriptHydrate.call(this, events)
  }
  StatsFolder.prototype.hydrate = function (events) {
    probe.statsHydrateCount += 1
    return originalStatsHydrate.call(this, events)
  }
  TuiApp.prototype.setTranscript = function (messages, activities, window, streamingToolPreviews, searchPresentation) {
    probe.capturedMessages = messages
    probe.capturedActivities = activities
    probe.capturedStreamingToolPreviews = streamingToolPreviews
    return originalSetTranscript.call(this, messages, activities, window, streamingToolPreviews, searchPresentation)
  }
  TuiApp.prototype.setViewerFooter = function (footer) {
    probe.capturedViewerUsage = footer?.usage
    return originalSetViewerFooter.call(this, footer)
  }
  TuiApp.prototype.setViewerMode = function (mode) {
    probe.capturedViewerMode = mode
    return originalSetViewerMode.call(this, mode)
  }
  TuiApp.prototype.showApprovalPrompt = function (request) {
    probe.capturedApproval = request
    return Promise.resolve('cancelled')
  }
  TuiApp.prototype.setStatus = function (status) {
    if (typeof status.model === 'string') probe.capturedModels.push(status.model)
    return originalSetStatus.call(this, status)
  }
  TuiApp.prototype.start = function () {
    probe.apps.push(this)
    return originalStart.call(this)
  }
  TuiApp.prototype.setWelcomeCard = function (facts: { cwd: string; sessionId: string; model: string; version: string; preset?: string }) {
    probe.capturedWelcomeModels.push(facts.model)
    return originalSetWelcomeCard.call(this, facts)
  }
  TuiApp.prototype.scrollToBottom = function (options: { disableFollow?: boolean } = {}) {
    probe.scrollToBottomCount += 1
    return originalScrollToBottom.call(this, options)
  }
  TuiApp.prototype.notify = function (...args: Parameters<typeof originalNotify>) {
    probe.notices.push(`${args[1] ?? 'info'}:${String(args[0])}`)
    return originalNotify.apply(this, args)
  }
  probe.restore = () => {
    TranscriptFolder.prototype.apply = originalTranscriptApply
    StatsFolder.prototype.apply = originalStatsApply
    TranscriptFolder.prototype.hydrate = originalTranscriptHydrate
    StatsFolder.prototype.hydrate = originalStatsHydrate
    TuiApp.prototype.setTranscript = originalSetTranscript
    TuiApp.prototype.setViewerFooter = originalSetViewerFooter
    TuiApp.prototype.setViewerMode = originalSetViewerMode
    TuiApp.prototype.showApprovalPrompt = originalShowApprovalPrompt
    TuiApp.prototype.setStatus = originalSetStatus
    TuiApp.prototype.setWelcomeCard = originalSetWelcomeCard
    TuiApp.prototype.notify = originalNotify
    TuiApp.prototype.start = originalStart
    TuiApp.prototype.scrollToBottom = originalScrollToBottom
  }
  return probe
}

/** Drive the /model picker to the SECOND listed model (m2) and apply it. */
async function pickSecondModel(app: TuiApp, harness: RunnerHarness): Promise<void> {
  const modelHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('model')
  assert.ok(modelHandler, 'the real runner must register /model')
  await modelHandler()
  await settle()
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  input('\x1b[B') // choose m2 instead of the first listed model
  input('\r')
  await settle()
}

test('the real runner hydrates resume, deferred create, and switch exactly once each', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-runner-bootstrap-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let resumeContext: Context | undefined
  let deferredContext: Context | undefined
  let resumeFiber: { dispose: () => Promise<unknown> } | undefined
  let deferredFiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (deferredContext !== undefined) return disposeContext(deferredContext) })
  life.defer(() => { if (resumeContext !== undefined) return disposeContext(resumeContext) })
  life.defer(() => { if (deferredFiber !== undefined) return deferredFiber.dispose() })
  life.defer(() => { if (resumeFiber !== undefined) return resumeFiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'runner-session-a',
    header: { id: 'runner-session-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [
      ...sessionEvents('resumed answer'),
      ...modelHistory('provider-a', 'model-a', 'high'),
      event('assistant/chunk', {
        turn: 0,
        step: 0,
        chunk: { type: 'tool-call-delta', index: 0, id: 'historical-preview' as ToolCallId, name: 'edit', argumentsDelta: '{"path"' },
      }, 8),
    ],
  })
  const resumeHarness = makeHarness(home, resumed, { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' })
  resumeContext = new Context()
  resumeFiber = await mountRunner(resumeContext, home, resumeHarness, { sessionId: resumed.id }, { sessionId: resumed.id })
  assert.ok(resumeHarness.resumeSignals[0], 'explicit resume must receive the runner lifecycle signal')
  assert.equal(probe.transcriptApplyCount, 1)
  assert.equal(probe.statsApplyCount, 1)
  assert.equal(probe.transcriptHydrateCount, 1)
  assert.equal(probe.statsHydrateCount, 1)
  assert.ok(probe.capturedMessages?.some(message => message.kind === 'assistant' && message.text === 'resumed answer'))
  assert.deepEqual(probe.capturedStreamingToolPreviews, [], 'cold hydration must not recreate Preparing rows')
  assert.ok(probe.capturedModels.includes('provider-a/model-a @high'),
    `resume must restore the Session-local model, not the global fallback: ${probe.capturedModels.join(', ')}`)

  // /model on the live Session: pick m2 (the second model). The choice
  // becomes the latest DEFAULT intent (a fresh Session observes it).
  const resumeApp = probe.apps.at(-1)
  assert.ok(resumeApp, 'the production runner must create a TuiApp')
  await pickSecondModel(resumeApp, resumeHarness)

  const newHandler = (resumeHarness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  await newHandler()
  await settle()
  assert.equal(probe.transcriptApplyCount, 2)
  assert.equal(probe.statsApplyCount, 2)
  assert.equal(probe.transcriptHydrateCount, 2)
  assert.equal(probe.statsHydrateCount, 2)
  assert.ok(probe.capturedMessages?.some(message => message.kind === 'assistant' && message.text === 'created answer'))
  assert.deepEqual(resumeHarness.createOptions[0], { provider: 'p', model: 'm2' },
    '/new must create with the latest DEFAULT intent, never the old Session selection')
  assert.equal(resumeHarness.createSignals[0], resumeHarness.resumeSignals[0],
    '/new must use the same runner lifecycle signal as the initial resume')
  assert.equal(durableSelectionOf(resumeHarness.createdSessions[0]!), undefined,
    '/new must not freeze a durable choice into the fresh Session once the default save settled (blank-session dynamic default)')

  await resumeFiber.dispose()
  await disposeContext(resumeContext)
  resumeFiber = undefined

  const deferredHarness = makeHarness(home)
  deferredContext = new Context()
  deferredFiber = await mountRunner(deferredContext, home, deferredHarness, {}, {})
  assert.equal(probe.transcriptApplyCount, 2, 'deferred startup must not hydrate an absent session')
  assert.equal(probe.statsApplyCount, 2, 'deferred startup must not hydrate an absent session')
  assert.equal(probe.transcriptHydrateCount, 2, 'deferred startup must not hydrate an absent session')
  assert.equal(probe.statsHydrateCount, 2, 'deferred startup must not hydrate an absent session')
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const modelHandler = (deferredHarness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('model')
  assert.ok(modelHandler, 'the deferred runner must register /model before Session creation')
  const modelResult = await modelHandler()
  assert.deepEqual(modelResult, { kind: 'success' }, 'deferred /model must be available before Session creation')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  await settle()
  input('\x1b[B') // choose m2 instead of the first listed model
  input('\r')
  await settle()
  assert.equal(deferredHarness.createOptions.length, 0, '/model must not create a Session')
  app.setDraft('first deferred prompt')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  assert.deepEqual(deferredHarness.createOptions[0], { provider: 'p', model: 'm2' },
    'deferred create must read the latest sessionless model selection')
  assert.ok(deferredHarness.createSignals[0], 'deferred create must receive the runner lifecycle signal')
  assert.equal(durableSelectionOf(deferredHarness.createdSessions[0]!), undefined,
    'the first Session must observe the settled default dynamically, not freeze a durable choice')
  assert.equal(probe.transcriptApplyCount, 3)
  assert.equal(probe.statsApplyCount, 3)
  assert.equal(probe.transcriptHydrateCount, 3)
  assert.equal(probe.statsHydrateCount, 3)
  assert.ok(probe.capturedMessages?.some(message => message.kind === 'assistant' && message.text === 'created answer'))
})


test('a main Session opening cut preserves old-Agent bookkeeping and B transient state', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-main-opening-gap-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const sessionA: FakeSession = fakeSession({
    id: 'main-opening-a',
    header: { id: 'main-opening-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('A answer'),
  })
  let nextOpeningSeq = 7
  const sessionB: FakeSession = fakeSession({
    id: 'main-opening-b',
    header: { id: 'main-opening-b', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: [
      ...sessionEvents('B history'),
      modelEvent('model/selection', { provider: 'opening-provider', model: 'opening-model', reasoningEffort: 'high' }, 6),
    ],
    append: (type, data) => ({ type, seq: nextOpeningSeq++, time: Date.now(), data }) as unknown as SessionEvent,
  })
  let holdAIdle = false
  let releaseAIdle!: () => void
  const aIdle = new Promise<void>(resolve => { releaseAIdle = resolve })
  let aIdleStarted!: () => void
  const aIdleStartedPromise = new Promise<void>(resolve => { aIdleStarted = resolve })
  let releaseBResume!: () => void
  const bResume = new Promise<void>(resolve => { releaseBResume = resolve })
  let bResumeStarted!: () => void
  const bResumeStartedPromise = new Promise<void>(resolve => { bResumeStarted = resolve })
  let releaseBIdle!: () => void
  const bIdle = new Promise<void>(resolve => { releaseBIdle = resolve })
  let bIdleStarted!: () => void
  const bIdleStartedPromise = new Promise<void>(resolve => { bIdleStarted = resolve })
  const harness = makeHarness(
    home,
    [sessionA, sessionB],
    { provider: 'p', model: 'm' },
    undefined,
    undefined,
    undefined,
    async id => {
      if (id === sessionA.id && holdAIdle) {
        aIdleStarted()
        await aIdle
      }
      if (id === sessionB.id) {
        bIdleStarted()
        await bIdle
      }
    },
    async id => {
      if (id !== sessionB.id) return
      bResumeStarted()
      await bResume
    },
  )
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: sessionA.id }, { sessionId: sessionA.id })
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(resumeHandler, 'the real runner must register /resume')
  const aAgent = liveAgentOf(harness, sessionA.id)
  ;(aAgent as { status: 'idle' | 'running' }).status = 'running'
  holdAIdle = true
  const switchPromise = (resumeHandler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: sessionB.id })
  await aIdleStartedPromise
  const oldCallId = 'main-opening-old-tool' as ToolCallId
  context.emit('session/event', sessionA as never, event('tool/call', {
    turn: 1,
    step: 0,
    callId: oldCallId,
    name: 'bash',
    arguments: '{"command":"rm -rf /tmp/old-opening-test"}',
  }, 6))
  context.emit('approval/request', {
    callId: oldCallId,
    toolName: 'bash',
    reason: 'old opening approval',
  } as never, undefined as never)
  await settle()
  assert.equal(probe.capturedApproval?.arguments, '{"command":"rm -rf /tmp/old-opening-test"}',
    'the committed main Agent must keep approval arguments while quiesce waits')
  assert.equal(probe.capturedApproval?.danger, true,
    'the committed main Agent must keep dangerous-command classification while quiesce waits')
  context.emit('session/event', sessionA as never, event('tool/result', {
    turn: 1,
    step: 0,
    message: createToolResultMessage({
      callId: oldCallId,
      content: [{ type: 'text', text: 'done' }],
      isError: false,
    }),
  }, 7))
  context.emit('approval/request', {
    callId: oldCallId,
    toolName: 'bash',
    reason: 'old result cleanup check',
  } as never, undefined as never)
  await settle()
  assert.equal(probe.capturedApproval?.arguments, undefined,
    'the old tool/result cleanup must remove arguments before the target commits')
  assert.equal(probe.capturedApproval?.danger, undefined,
    'the old tool/result cleanup must remove danger state before the target commits')
  releaseAIdle()
  await bResumeStartedPromise
  assert.equal(harness.resumeSignals[1], harness.resumeSignals[0],
    'session switch resume must use the runner lifecycle signal')

  const emitDurable = (type: string, data: unknown): SessionEvent => {
    const next = sessionB.append!(type, data) as SessionEvent
    context!.emit('session/event', sessionB as never, next)
    return next
  }
  const bAgent = liveAgentOf(harness, sessionB.id)
  emitDurable('model/selection', { provider: 'opening-provider', model: 'opening-model', reasoningEffort: 'high' })
  emitDurable('request/header', {
    header: { config: { provider: 'opening-provider', model: 'opening-model', reasoningEffort: 'high' } },
  })
  emitDurable('tool/call', {
    turn: 1,
    step: 0,
    callId: 'main-opening-tool',
    name: 'bash',
    arguments: '{"command":"rm -rf /tmp/opening-test"}',
  })
  context.emit('approval/request', {
    callId: 'main-opening-tool',
    toolName: 'bash',
    reason: 'opening approval',
  } as never, undefined as never)
  await settle()
  assert.equal(probe.capturedApproval?.arguments, '{"command":"rm -rf /tmp/opening-test"}',
    'runtime tool/call bookkeeping must run while presentation is fenced')
  assert.equal(probe.capturedApproval?.danger, true,
    'approval danger classification must retain the opening tool arguments')
  emitDurable('turn/start', { turn: 1 })
  emitDurable('step/start', { turn: 1, step: 0 })
  emitLiveStream(context, bAgent, { type: 'start', attemptId: 'main-opening-b', revision: 1, turn: 1, step: 0 })
  emitLiveStream(context, bAgent, {
    type: 'chunk', attemptId: 'main-opening-b', revision: 2, index: 0,
    time: 1_700_000_000_100, chunk: { type: 'text-delta', index: 0, text: 'B opening prefix' },
  })
  emitLiveStream(context, bAgent, {
    type: 'chunk', attemptId: 'main-opening-b', revision: 3, index: 1,
    time: 1_700_000_000_101, chunk: { type: 'usage', usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 } },
  })
  releaseBResume()
  await bIdleStartedPromise
  releaseBIdle()
  await switchPromise
  await settle()
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(probe.capturedModels.at(-1), 'p/m',
    'opening model selection must be consumed by its matching request/header before the target commits')
  const openingMessages = probe.capturedMessages ?? []
  assert.ok(openingMessages.some(message => message.text === 'B opening prefix'),
    'B transient prefix must survive the commit-to-init opening gap')
  emitDurable('assistant/message', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId('main-opening-b-message'),
      role: 'assistant',
      content: [{ type: 'text', text: 'B durable answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 13, outputTokens: 5 },
    stream: [],
  })
  emitLiveStream(context, bAgent, {
    type: 'end', attemptId: 'main-opening-b', revision: 4, index: 2,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 12 },
  })
  emitDurable('step/end', { turn: 1, step: 0 })
  emitDurable('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await settle()
  await new Promise(resolve => setTimeout(resolve, 70))

  const messages = probe.capturedMessages ?? []
  assert.equal(messages.some(message => message.text === 'A answer'), false,
    'the committed B surface must never repaint the old A transcript')
  assert.ok(messages.some(message => message.text === 'B history'),
    'the committed B surface must hydrate its own durable history')
  assert.equal(messages.filter(message => message.text === 'B durable answer').length, 1,
    'B durable settlement must appear exactly once')
})

test('switching between two old Sessions restores each Session own model', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-runner-switch-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const sessionA: FakeSession = fakeSession({
    id: 'switch-session-a',
    header: { id: 'switch-session-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [...sessionEvents('answer a'), ...modelHistory('provider-a', 'model-a', 'high')],
  })
  const sessionB: FakeSession = fakeSession({
    id: 'switch-session-b',
    header: { id: 'switch-session-b', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [...sessionEvents('answer b'), ...modelHistory('provider-b', 'model-b', 'max')],
  })
  const harness = makeHarness(home, [sessionA, sessionB], { provider: 'global', model: 'fallback', reasoningEffort: 'low' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: sessionA.id }, { sessionId: sessionA.id })
  const lastModel = (): string | undefined => probe.capturedModels.at(-1)
  assert.equal(lastModel(), 'provider-a/model-a @high', 'resume A must restore A own model, not the global fallback')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(resumeHandler, 'the real runner must register the /resume alias')
  const resume = resumeHandler as (invocation: { rawInput: string }) => unknown
  await resume({ rawInput: 'switch-session-b' })
  await settle()
  assert.equal(lastModel(), 'provider-b/model-b @max', 'switching to B must restore B own model')
  await resume({ rawInput: 'switch-session-a' })
  await settle()
  assert.equal(lastModel(), 'provider-a/model-a @high', 'switching back to A must restore A own model again')
})

test('/new without an explicit default intent observes the persisted default, never the old Session model', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-runner-new-default-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const resumed: FakeSession = fakeSession({
    id: 'new-default-session',
    header: { id: 'new-default-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [...sessionEvents('old answer'), ...modelHistory('provider-a', 'model-a', 'high')],
  })
  const harness = makeHarness(home, resumed, { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  await newHandler()
  await settle()
  assert.deepEqual(harness.createOptions[0], { provider: 'provider-b', model: 'model-b' },
    '/new must create with the persisted global default, never the old Session selection')
  assert.equal(durableSelectionOf(harness.createdSessions[0]!), undefined,
    '/new without an explicit default intent must not freeze a durable choice into the fresh Session')
})

test('/fork inherits the Host-chosen completed prefix including the trailing source switch', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-selection-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const currentSelection = { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' }
  const sourceEvents = resequence([
    modelEvent('model/selection', { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }, 0),
    modelEvent('request/header', {
      header: { config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } },
    }, 1),
    ...sessionEvents('source answer'),
    // The source's current switch stands after the completed turn with no
    // queued-input boundary behind it, so the alpha.2 latest-completed-prefix
    // cut INCLUDES it: the child inherits the pending switch as Host state.
    modelEvent('model/selection', currentSelection, 6),
  ])
  const source: FakeSession = fakeSession({
    id: 'fork-selection-source',
    header: { id: 'fork-selection-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sourceEvents,
  })
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback', reasoningEffort: 'low' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  assert.ok(forkHandler, 'the real runner must register /fork')
  await forkHandler()
  await settle()

  assert.equal(harness.createdSessions.length, 1, 'fork creates one child')
  const child = harness.createdSessions[0]!
  const inheritedPrefix = sourceEvents
  assert.deepEqual(harness.createInheritedEventCounts, [inheritedPrefix.length],
    'the alpha.2 latest-completed-prefix cut extends through the trailing stable selection')
  assert.deepEqual(child.snapshotEvents().slice(0, inheritedPrefix.length), inheritedPrefix,
    'the child keeps the exact inherited prefix')
  assert.deepEqual(source.snapshotEvents(), sourceEvents, 'fork does not mutate the source log')
  const childBoundary = child.snapshotEvents()[inheritedPrefix.length]
  assert.equal((childBoundary as unknown as { type?: unknown } | undefined)?.type, 'session/end-seed',
    'the child-owned end-seed marker (not a runner write) sits at the inherited cut')
  const childSelections = child.snapshotEvents().filter(event => (event as unknown as { type?: unknown }).type === 'model/selection')
  assert.deepEqual((childSelections.at(-1) as unknown as { data?: unknown } | undefined)?.data, currentSelection,
    'the child inherits the source current switch that stands inside the completed prefix')
  assert.deepEqual(foldPendingModelSelection(child.snapshotEvents()).lastUsed, {
    provider: 'provider-a', model: 'model-a', reasoningEffort: 'high',
  }, 'the child effective selection remains the consumed historical A selection')
  assert.deepEqual(foldPendingModelSelection(child.snapshotEvents()).pending, currentSelection,
    'the inherited trailing switch stays a pending intent, Host-owned')
})

test('/fork leaves the source Session attached until the executor appends command/done', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-settlement-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const source = fakeSession({
    id: 'fork-settlement-source',
    header: { id: 'fork-settlement-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const harness = makeHarness(home, source)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')

  app.setDraft('/fork')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()

  assert.equal(harness.createdSessions.length, 1, '/fork must fork one child through the command plane')
  // The official executor appends `command/done` to the SOURCE Session only
  // after the handler settles; appending to a detached Session never reaches
  // the persistence writer. The source owner must therefore still be live at
  // that append — retiring it inside the handler (which detaches the Session)
  // is the regression this asserts.
  const sourceSettlements = harness.commandSettlements.filter(entry => entry.sessionId === source.id)
  assert.deepEqual(sourceSettlements.map(entry => entry.phase), ['run', 'done'])
  assert.equal(sourceSettlements.at(-1)?.ownerLive, true,
    'the source owner must stay attached through the command/done append')
  const eventTypes = source.snapshotEvents().map(event => (event as unknown as { type?: unknown }).type)
  assert.ok(eventTypes.includes('command/run') && eventTypes.includes('command/done'),
    `the source log must keep the run/done pairing: ${JSON.stringify(eventTypes)}`)

  // The retirement still happens — just after settlement, never lost.
  await settle()
  assert.ok(harness.retirementEvents.includes(`dispose:${source.id}`),
    'the source owner must still be disposed after the command settled')
})

test('/fork teardown awaits the command settlement and retires the source exactly once', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-teardown-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  let releaseCreate!: () => void
  let signalCreateStarted!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  let releaseSettlement!: () => void
  let signalSettlementReached!: () => void
  const settlementReached = new Promise<void>(resolve => { signalSettlementReached = resolve })
  const source = fakeSession({
    id: 'fork-teardown-source',
    header: { id: 'fork-teardown-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const harness = makeHarness(home, source, undefined, undefined, async () => {
    signalCreateStarted()
    await new Promise<void>(resolve => { releaseCreate = resolve })
  })
  // Hold the executor's post-handler `command/done` append open, so the test can
  // observe whether teardown respects the in-flight command settlement.
  ;(harness.commands as { settlementGate?: () => Promise<void> }).settlementGate = async () => {
    signalSettlementReached()
    await new Promise<void>(resolve => { releaseSettlement = resolve })
  }
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')

  app.setDraft('/fork')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await createStarted

  // Tear the surface down WHILE the `/fork` command is inside `agents.create`,
  // then let the fork settle but keep `command/done` open.
  const disposal = fiber.dispose()
  await settle()
  releaseCreate()
  await settlementReached
  await settle()
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${source.id}`).length, 0,
    'teardown must not retire the source while its own command is still settling')

  releaseSettlement()
  await disposal
  await settle()

  const sourceSettlements = harness.commandSettlements.filter(entry => entry.sessionId === source.id)
  assert.deepEqual(sourceSettlements.map(entry => entry.phase), ['run', 'done'],
    'the executor must still settle the source command')
  assert.equal(sourceSettlements.at(-1)?.ownerLive, true,
    'teardown must not detach the source Session before its own command/done')
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${source.id}`).length, 1,
    'teardown must retire the source owner exactly once')
  // Exactly-once shutdown cancel across BOTH owners of an in-flight `/fork`.
  // The source was the CURRENT owner when the shutdown pre-cancelled it, so its
  // own retirement cancel phase must be a no-op; the child — which the teardown
  // parks because `cleanedUp` was already set — is cancelled once by the
  // parked-owner retirement. A second cancel on either owner is the ordering
  // that can land after the root teardown unregistered the inbox projection.
  assert.equal(harness.retirementEvents.filter(event => event === `cancel:${source.id}`).length, 1,
    'teardown must cancel the fork source owner exactly once')
  const forkedChild = harness.createdSessions.at(-1)
  assert.ok(forkedChild, 'the in-flight /fork must have created its child Session')
  assert.equal(harness.retirementEvents.filter(event => event === `cancel:${forkedChild.id}`).length, 1,
    'teardown must cancel the parked fork child exactly once')
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${forkedChild.id}`).length, 1,
    'teardown must retire the parked fork child exactly once')
})

test('a rewind-picker fork awaits source retirement before its handoff completes', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-rewind-retirement-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  let releaseDrain!: () => void
  let signalDrainReached!: () => void
  const drainReached = new Promise<void>(resolve => { signalDrainReached = resolve })
  const source = fakeSession({
    id: 'rewind-retirement-source',
    header: { id: 'rewind-retirement-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [
      event('turn/start', { turn: 0 }, 0),
      event('user/message', {
        id: MessageId('rewind-retirement-one'),
        role: 'user',
        content: [{ type: 'text', text: 'first' }],
        source: { kind: 'user' },
      } as never, 1),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
      event('turn/start', { turn: 1 }, 3),
      event('user/message', {
        id: MessageId('rewind-retirement-two'),
        role: 'user',
        content: [{ type: 'text', text: 'second' }],
        source: { kind: 'user' },
      } as never, 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ],
  })
  // Gate the retirement's drain phase: the source owner must not be observable
  // as retired (nor the handoff reported complete) until teardown finishes. The
  // gate is ONE-SHOT — the teardown retirement's own drain call must pass
  // through, or the disposer would block forever.
  let drainCalls = 0
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback' }, undefined, undefined, () => ({
    drainContinuableDescendants: async () => {
      drainCalls += 1
      if (drainCalls !== 1) return
      signalDrainReached()
      await new Promise<void>(resolve => { releaseDrain = resolve })
    },
    listDescendants: async () => [],
  }))
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const rewindHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('rewind')
  assert.ok(rewindHandler, 'the real runner must register /rewind')
  await rewindHandler()
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must mount a TUI for the rewind picker')
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\r')
  const reachedDrain = await Promise.race([
    drainReached.then(() => true),
    new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 3_000) }),
  ])
  try {
    assert.equal(reachedDrain, true, 'the picker fork must reach the source-retirement drain phase')
    // Give a DETACHED handoff every chance to finish: if the picker path did not
    // await the retirement, `forkSession` would resolve here and report success.
    await settle()
    // A DSH command defers its source retirement; the picker path must NOT: the
    // handoff cannot report success (nor dispose the source) while the old owner
    // is still retiring — otherwise an immediate /resume could observe a live,
    // lease-held source.
    assert.ok(!probe.notices.some(notice => notice.includes('rewound to turn')),
      `the rewind handoff must wait for source retirement: ${probe.notices.join(', ')}`)
    assert.equal(harness.retirementEvents.filter(entry => entry === `dispose:${source.id}`).length, 0,
      'the source must not be disposed while its retirement is still draining')
  } finally {
    // Always release the gate so a failing assertion still leaves a clean
    // teardown (the disposer awaits this retirement).
    releaseDrain?.()
    await settle()
  }
  assert.ok(probe.notices.some(notice => notice.includes('rewound to turn')),
    `the picker fork must still report success: ${probe.notices.join(', ')}`)
  assert.equal(harness.retirementEvents.filter(entry => entry === `dispose:${source.id}`).length, 1,
    'the source owner must be retired exactly once')
})

test('/fork settles when the source disposal fails (contained, never a hang)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-dispose-fail-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const source = fakeSession({
    id: 'fork-dispose-fail-source',
    header: { id: 'fork-dispose-fail-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const harness = makeHarness(home, source)
  // A failing `dispose()` leaks the handle (the write lease stays held), which
  // `retireDirectOwnedSession` CONTAINS and records. The admission pin must
  // still settle, or the command workflow (which awaits the retirement) would
  // hang forever.
  harness.disposeFailures.add(source.id)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')

  app.setDraft('/fork')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  assert.equal(harness.createdSessions.length, 1, 'the fork must settle even when the source disposal fails')
  assert.ok(harness.retirementEvents.includes(`dispose:${source.id}`),
    'the source disposal must be attempted (and its failure contained)')
  const sourceSettlements = harness.commandSettlements.filter(entry => entry.sessionId === source.id)
  assert.deepEqual(sourceSettlements.map(entry => entry.phase), ['run', 'done'],
    'the source command must still settle after a contained dispose failure')
})

test('/fork does not release the submit FIFO before the source retirement completes', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-fifo-retire-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const header = (id: string) => ({ id, cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION })
  const source = fakeSession({ id: 'fifo-retire-source', header: header('fifo-retire-source'), events: sessionEvents('source answer') })
  const other = fakeSession({ id: 'fifo-retire-other', header: header('fifo-retire-other'), events: sessionEvents('other answer') })
  let releaseDrain!: () => void
  let signalDrainReached!: () => void
  const drainReached = new Promise<void>(resolve => { signalDrainReached = resolve })
  let drainCalls = 0
  const harness = makeHarness(home, [source, other], undefined, undefined, undefined, () => ({
    drainContinuableDescendants: async () => {
      drainCalls += 1
      if (drainCalls !== 1) return
      signalDrainReached()
      await new Promise<void>(resolve => { releaseDrain = resolve })
    },
    listDescendants: async () => [],
  }))
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')

  app.setDraft('/fork')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  const reached = await Promise.race([
    drainReached.then(() => true),
    new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 3_000) }),
  ])
  try {
    assert.equal(reached, true, 'the /fork source retirement must reach its drain phase')
    const runsWhileGated = harness.commandSettlements.filter(entry => entry.phase === 'run').length
    // Durability is already satisfied: command/done landed before the drain gate.
    assert.deepEqual(harness.commandSettlements.filter(entry => entry.sessionId === source.id).map(entry => entry.phase), ['run', 'done'],
      'command/done must land before the source retirement completes')
    // The command must NOT have released the submit FIFO yet: a queued second
    // submission must stay pending until the retirement finishes.
    app.setDraft(`/resume ${other.id}`)
    ;(app as unknown as { submitDraft(): void }).submitDraft()
    await settle()
    assert.equal(harness.commandSettlements.filter(entry => entry.phase === 'run').length, runsWhileGated,
      'the submit FIFO must stay held until the source retirement completes')
  } finally {
    releaseDrain?.()
    await settle()
  }
  assert.ok(harness.retirementEvents.includes(`dispose:${source.id}`),
    'the source must be disposed once the held retirement completes')
})

test('/fork dispatches at admission without waiting for a busy source', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-busy-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  let releaseCreate!: () => void
  let signalCreateStarted!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  const createGate = async (): Promise<void> => {
    signalCreateStarted()
    await new Promise<void>(resolve => { releaseCreate = resolve })
  }
  const source = fakeSession({
    id: 'fork-busy-source',
    header: { id: 'fork-busy-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('busy source answer'),
  })
  let sourceBusy = false
  let releaseSourceIdle!: () => void
  const sourceIdleGate = async (sessionId: string): Promise<void> => {
    if (sessionId === source.id && sourceBusy) {
      await new Promise<void>(resolve => { releaseSourceIdle = resolve })
    }
  }
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback' }, undefined, createGate, undefined, sourceIdleGate)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  await settle()
  await new Promise(resolve => setTimeout(resolve, 70))
  const idleBeforeFork = harness.retirementEvents.filter(event => event === `idle:${source.id}`).length
  sourceBusy = true
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  assert.ok(forkHandler, 'the real runner must register /fork')

  const forkPromise = forkHandler()
  await createStarted
  assert.equal(harness.retirementEvents.filter(event => event === `idle:${source.id}`).length, idleBeforeFork,
    'fork dispatch must not wait for the source Agent to become idle')
  releaseCreate()
  sourceBusy = false
  releaseSourceIdle?.()
  await forkPromise
  await settle()
  assert.equal(harness.createdSessions.length, 1)
})

test('/fork navigation supersession parks a Direct child for later claim', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-superseded-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  let releaseCreate!: () => void
  let signalCreateStarted!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  const createGate = async (): Promise<void> => {
    signalCreateStarted()
    await new Promise<void>(resolve => { releaseCreate = resolve })
  }
  const source = fakeSession({
    id: 'fork-superseded-source',
    header: { id: 'fork-superseded-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const target = fakeSession({
    id: 'fork-superseded-target',
    header: { id: 'fork-superseded-target', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('target answer'),
  })
  const harness = makeHarness(home, [source, target], { provider: 'global', model: 'fallback' }, undefined, createGate)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(forkHandler, 'the real runner must register /fork')
  assert.ok(resumeHandler, 'the real runner must register /resume')

  const forkPromise = forkHandler()
  await createStarted
  const resume = resumeHandler as (invocation: { rawInput: string }) => unknown
  await resume({ rawInput: target.id })
  await settle()
  assert.ok(harness.retirementEvents.includes(`dispose:${source.id}`),
    'a newer navigation must commit without waiting for the pending Host fork')

  releaseCreate()
  await forkPromise
  await settle()
  const child = harness.createdSessions[0]
  assert.ok(child, 'the pending fork must still publish its child')
  assert.equal(harness.createdSessions.length, 1)

  const resumesBeforeClaim = harness.resumeSignals.length
  await resume({ rawInput: child.id })
  await settle()
  assert.equal(harness.resumeSignals.length, resumesBeforeClaim,
    'opening a parked child must claim its existing Direct owner, not resume a second writer')
  const mountedFiber = fiber
  assert.ok(mountedFiber)
  await mountedFiber.dispose()
  fiber = undefined
  await settle()
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${child.id}`).length, 1,
    'claiming a parked child must leave exactly one teardown owner')
})

test('/fork retires an unclaimed parked Direct owner during teardown', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-parked-teardown-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  let signalCreateStarted!: () => void
  let releaseCreate!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  const createGate = async (): Promise<void> => {
    signalCreateStarted()
    await new Promise<void>(resolve => { releaseCreate = resolve })
  }
  const source = fakeSession({
    id: 'fork-parked-teardown-source',
    header: { id: 'fork-parked-teardown-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const target = fakeSession({
    id: 'fork-parked-teardown-target',
    header: { id: 'fork-parked-teardown-target', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('target answer'),
  })
  const harness = makeHarness(home, [source, target], { provider: 'global', model: 'fallback' }, undefined, createGate)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(forkHandler, 'the real runner must register /fork')
  assert.ok(resumeHandler, 'the real runner must register /resume')

  const forkPromise = forkHandler()
  await createStarted
  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: target.id })
  await settle()
  const mountedFiber = fiber
  assert.ok(mountedFiber)
  const teardown = mountedFiber.dispose()
  releaseCreate()
  await Promise.all([forkPromise, teardown])
  fiber = undefined
  await settle()

  const child = harness.createdSessions[0]
  assert.ok(child, 'the superseded fork must publish before teardown drains its parked owner')
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${child.id}`).length, 1,
    'an unclaimed parked Direct owner must be disposed exactly once during teardown')
})

test('/fork suppresses a delayed failure after navigation supersession', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-failure-stale-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  let signalCreateStarted!: () => void
  let releaseFailure!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  const failure = new Promise<never>((_, reject) => { releaseFailure = () => reject(new Error('delayed fork failure')) })
  const createGate = async (): Promise<never> => {
    signalCreateStarted()
    return failure
  }
  const source = fakeSession({
    id: 'fork-failure-source',
    header: { id: 'fork-failure-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('source answer'),
  })
  const target = fakeSession({
    id: 'fork-failure-target',
    header: { id: 'fork-failure-target', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('target answer'),
  })
  const harness = makeHarness(home, [source, target], { provider: 'global', model: 'fallback' }, undefined, createGate)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(forkHandler, 'the real runner must register /fork')
  assert.ok(resumeHandler, 'the real runner must register /resume')

  const forkPromise = forkHandler()
  await createStarted
  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: target.id })
  await settle()
  releaseFailure()
  await forkPromise
  await settle()

  assert.equal(harness.createdSessions.length, 0, 'a failed fork must not publish a child')
  assert.ok(!probe.notices.some(notice => notice.includes('delayed fork failure')),
    `a stale fork failure must not notify the newer session: ${probe.notices.join(', ')}`)
})

test('/rewind rejects an A to B to A stale picker selection', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-rewind-aba-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const userMessage = (id: string, text: string, seq: number): SessionEvent => event('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as never, seq)
  const source = fakeSession({
    id: 'rewind-aba-source',
    header: { id: 'rewind-aba-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [
      event('turn/start', { turn: 0 }, 0),
      userMessage('rewind-aba-one', 'first', 1),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
      event('turn/start', { turn: 1 }, 3),
      userMessage('rewind-aba-two', 'second', 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ],
  })
  const target = fakeSession({
    id: 'rewind-aba-target',
    header: { id: 'rewind-aba-target', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('target answer'),
  })
  const harness = makeHarness(home, [source, target], { provider: 'global', model: 'fallback' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const rewindHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('rewind')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(rewindHandler, 'the real runner must register /rewind')
  assert.ok(resumeHandler, 'the real runner must register /resume')
  await rewindHandler()
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must mount a TUI for the rewind picker')

  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: target.id })
  await settle()
  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: source.id })
  await settle()
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\r')
  await settle()

  assert.equal(harness.createdSessions.length, 0, 'A → B → A must not revive the old A picker row into a fork')
  assert.ok(probe.notices.some(notice => notice.includes('rewind cancelled')),
    `the stale A picker selection must be cancelled: ${probe.notices.join(', ')}`)
})

test('/rewind stale callback cannot invalidate an admitted A fork', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-rewind-stale-admitted-fork-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  let signalCreateStarted!: () => void
  let releaseCreate!: () => void
  const createStarted = new Promise<void>(resolve => { signalCreateStarted = resolve })
  const createGate = async (): Promise<void> => {
    signalCreateStarted()
    await new Promise<void>(resolve => { releaseCreate = resolve })
  }
  const userMessage = (id: string, text: string, seq: number): SessionEvent => event('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as never, seq)
  const source = fakeSession({
    id: 'rewind-stale-admitted-source',
    header: { id: 'rewind-stale-admitted-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [
      event('turn/start', { turn: 0 }, 0),
      userMessage('rewind-stale-admitted-one', 'first', 1),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
      event('turn/start', { turn: 1 }, 3),
      userMessage('rewind-stale-admitted-two', 'second', 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ],
  })
  const target = fakeSession({
    id: 'rewind-stale-admitted-target',
    header: { id: 'rewind-stale-admitted-target', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('target answer'),
  })
  const harness = makeHarness(home, [source, target], { provider: 'global', model: 'fallback' }, undefined, createGate)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const rewindHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('rewind')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  assert.ok(rewindHandler, 'the real runner must register /rewind')
  assert.ok(resumeHandler, 'the real runner must register /resume')
  assert.ok(forkHandler, 'the real runner must register /fork')
  await rewindHandler()
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must mount a TUI for the rewind picker')

  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: target.id })
  await settle()
  await (resumeHandler as (invocation: { rawInput: string }) => unknown)({ rawInput: source.id })
  await settle()

  const sourceDisposesBeforeFork = harness.retirementEvents.filter(event => event === `dispose:${source.id}`).length
  const forkPromise = forkHandler()
  await createStarted
  // This is the old picker callback, now stale. It must return before
  // consuming the epoch admitted by the legitimate /fork above.
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\r')
  await settle()
  releaseCreate()
  await forkPromise
  await settle()

  assert.equal(harness.createdSessions.length, 1, 'the admitted /fork must still publish one child')
  assert.equal(harness.retirementEvents.filter(event => event === `dispose:${source.id}`).length, sourceDisposesBeforeFork + 1,
    'the admitted /fork must adopt and retire A rather than parking its child')
})

test('/rewind forwards the Host-owned fork anchor through the real picker callback', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-rewind-selection-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const currentSelection = { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' }
  const withHumanPrompt = (text: string): SessionEvent[] => {
    const turn = sessionEvents(text)
    return [
      turn[0]!,
      event('user/message', {
        id: MessageId(`rewind-${text}`),
        role: 'user',
        content: [{ type: 'text', text: `prompt ${text}` }],
        source: { kind: 'user' },
      } as never, 1),
      ...turn.slice(1),
    ]
  }
  const firstTurn = withHumanPrompt('first answer')
  const secondTurn = withHumanPrompt('second answer').map(event => ({
    ...event,
    seq: event.seq + firstTurn.length,
    time: event.time + firstTurn.length * 1000,
  })) as unknown as SessionEvent[]
  const sourceEvents = resequence([
    modelEvent('model/selection', { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }, 0),
    modelEvent('request/header', {
      header: { config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } },
    }, 1),
    ...firstTurn,
    ...secondTurn,
    // The current switch stands after the selected rewind cursor, so the
    // exact predecessor-turn cut must exclude it from the child.
    modelEvent('model/selection', currentSelection, firstTurn.length + secondTurn.length + 2),
  ])
  const source: FakeSession = fakeSession({
    id: 'rewind-selection-source',
    header: { id: 'rewind-selection-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sourceEvents,
  })
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback', reasoningEffort: 'low' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const rewindHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('rewind')
  assert.ok(rewindHandler, 'the real runner must register /rewind')
  await rewindHandler()
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app, 'the real runner must mount a TUI for the rewind picker')
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\r')
  await settle()

  const child = harness.createdSessions[0]!
  const inheritedPrefix = sourceEvents.slice(0, 2 + firstTurn.length)
  assert.deepEqual(harness.createInheritedEventCounts, [inheritedPrefix.length])
  assert.deepEqual(child.snapshotEvents().slice(0, inheritedPrefix.length), inheritedPrefix,
    'rewind keeps the exact historical prefix')
  assert.deepEqual(source.snapshotEvents(), sourceEvents, 'rewind does not mutate the source log')
  assert.equal((child.snapshotEvents()[inheritedPrefix.length] as unknown as { type?: unknown } | undefined)?.type,
    'session/end-seed',
    'the child-owned end-seed marker — never the source current-selection event — sits at the exact cut')
  const childSelections = child.snapshotEvents().filter(event => (event as unknown as { type?: unknown }).type === 'model/selection')
  assert.deepEqual((childSelections.at(-1) as unknown as { data?: unknown } | undefined)?.data, {
    provider: 'provider-a', model: 'model-a', reasoningEffort: 'high',
  }, 'rewind preserves the historical A selection')
})

test('/rewind surfaces a current Host fork rejection', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-rewind-rejection-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const userMessage = (id: string, text: string, seq: number): SessionEvent => event('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as never, seq)
  const source = fakeSession({
    id: 'rewind-rejection-source',
    header: { id: 'rewind-rejection-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: resequence([
      event('turn/start', { turn: 0 }, 0),
      userMessage('rewind-rejection-one', 'first prompt', 1),
      event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 2),
      event('turn/start', { turn: 1 }, 3),
      userMessage('rewind-rejection-two', 'second prompt', 4),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ]),
  })
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback' }, undefined, async () => {
    throw new Error('fork refused by Host')
  })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const rewindHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('rewind')
  assert.ok(rewindHandler, 'the real runner must register /rewind')
  await rewindHandler()
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must mount a TUI for the rewind picker')
  ;(app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui.handleTerminalInput('\r')
  await settle()

  assert.equal(harness.createdSessions.length, 0, 'a rejected Host fork must not publish a child')
  assert.ok(probe.notices.some(notice => notice.includes('fork refused by Host')),
    `the current rewind failure must remain visible: ${probe.notices.join(', ')}`)
})

test('/fork inherits the source-only reasoning-effort change standing inside the completed prefix', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-selection-effort-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const currentSelection = { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' }
  const sourceEvents = resequence([
    modelEvent('model/selection', { provider: 'provider-b', model: 'model-b', reasoningEffort: 'high' }, 0),
    modelEvent('request/header', {
      header: { config: { provider: 'provider-b', model: 'model-b', reasoningEffort: 'high' } },
    }, 1),
    ...sessionEvents('source answer'),
    modelEvent('model/selection', currentSelection, 6),
  ])
  const source: FakeSession = fakeSession({
    id: 'fork-selection-effort-source',
    header: { id: 'fork-selection-effort-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sourceEvents,
  })
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback', reasoningEffort: 'low' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  assert.ok(forkHandler, 'the real runner must register /fork')
  await forkHandler()
  await settle()

  const child = harness.createdSessions[0]!
  assert.deepEqual(harness.createInheritedEventCounts, [9],
    'the alpha.2 completed prefix extends through the trailing source-only effort change')
  assert.equal((child.snapshotEvents()[9] as unknown as { type?: unknown } | undefined)?.type, 'session/end-seed',
    'the child-owned end-seed marker sits at the inherited cut')
  assert.deepEqual(foldPendingModelSelection(child.snapshotEvents()).lastUsed, {
    provider: 'provider-b', model: 'model-b', reasoningEffort: 'high',
  }, 'the child preserves the historical reasoning effort as the consumed selection')
  assert.deepEqual(foldPendingModelSelection(child.snapshotEvents()).pending, currentSelection,
    'the source-only effort change stays a pending intent inside the child prefix')
})

test('/fork avoids a duplicate selection when the inherited prefix already matches', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fork-selection-same-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const selection = { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' }
  const source: FakeSession = fakeSession({
    id: 'fork-selection-same-source',
    header: { id: 'fork-selection-same-source', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: resequence([
      modelEvent('model/selection', selection, 0),
      modelEvent('request/header', { header: { config: selection } }, 1),
      ...sessionEvents('source answer'),
    ]),
  })
  const harness = makeHarness(home, source, { provider: 'global', model: 'fallback', reasoningEffort: 'low' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: source.id }, { sessionId: source.id })
  const forkHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('fork')
  assert.ok(forkHandler, 'the real runner must register /fork')
  await forkHandler()
  await settle()

  const childSelections = harness.createdSessions[0]!.snapshotEvents().filter(event => (event as unknown as { type?: unknown }).type === 'model/selection')
  assert.deepEqual(childSelections.map(event => (event as unknown as { data: unknown }).data), [selection],
    'matching inherited state must not append a redundant child selection')
})

test('a sessionless /model choice waits for its default save before the first create', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-runner-race-bridge-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  let releaseSave!: () => void
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
  const harness = makeHarness(home, undefined, { provider: 'p', model: 'm' }, async () => saveGate)
  context = new Context()
  fiber = await mountRunner(context, home, harness, {}, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  await pickSecondModel(app, harness)
  assert.equal(harness.createOptions.length, 0, '/model must not create a Session')
  // v2 §0.3.2: while the sessionless default write is pending the footer shows
  // the AUTHORITATIVE persisted default plus the pending selection.
  assert.match(probe.capturedModels.at(-1) ?? '', /p\/m → p\/m2 \(selecting…\)/,
    `the footer must show base → pending while the default save is in flight: ${JSON.stringify(probe.capturedModels)}`)
  assert.doesNotMatch(probe.capturedModels.at(-1) ?? '', /p\/m2 → p\/m2/,
    'the footer must never paint the optimistic intent as both base and pending')
  app.setDraft('first deferred prompt')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  assert.equal(harness.createOptions.length, 0,
    'the first create must coordinate with the still-pending sessionless default save instead of racing it')
  releaseSave()
  await settle()
  assert.deepEqual(harness.createOptions[0], { provider: 'p', model: 'm2' },
    'the settled Host default is what the fresh create consumes')
  assert.equal(durableSelectionOf(harness.createdSessions[0]!), undefined,
    'a committed default save leaves the blank Session observing the Host default dynamically')
})

test('a FAILED sessionless default save is never seeded into the first create (v2 §0.8.4)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-runner-failed-default-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const harness = makeHarness(home, undefined, { provider: 'p', model: 'm' }, async () => {
    throw new Error('settings write failed')
  })
  context = new Context()
  fiber = await mountRunner(context, home, harness, {}, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  await pickSecondModel(app, harness)
  await settle()
  // An ambiguous (thrown) default write keeps an explicit unresolved footer
  // marker until a Host read/reconnect establishes truth (v2 §0.3.2).
  assert.match(probe.capturedModels.at(-1) ?? '', /\(unconfirmed\)/,
    `the footer must show the unresolved marker: ${JSON.stringify(probe.capturedModels)}`)
  app.setDraft('first deferred prompt')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  assert.deepEqual(harness.createOptions[0], { provider: 'p', model: 'm' },
    'a failed default save must fall back to the persisted Host default, never a fabricated choice')
  assert.equal(durableSelectionOf(harness.createdSessions[0]!), undefined,
    'a FAILED latest intent must NOT be seeded into the created Session')
})


test('/model refreshes the Welcome card and footer from the authoritative Session selection', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-runner-welcome-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'welcome-session',
    header: { id: 'welcome-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [...sessionEvents('welcome answer'), ...modelHistory('provider-a', 'model-a', 'high')],
  })
  const harness = makeHarness(home, resumed, { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  assert.equal(probe.capturedWelcomeModels.at(-1), 'provider-a/model-a',
    'resume must project the Session-local model onto the Welcome card')
  await pickSecondModel(app, harness)
  assert.equal(probe.capturedWelcomeModels.at(-1), 'p/m2',
    '/model must refresh the Welcome card from the committed Session selection')
  assert.equal(probe.capturedModels.at(-1), 'p/m2',
    '/model must refresh the footer from the committed Session selection')
})

test('a global-default save failure keeps the Session, footer, and Welcome on the new model', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-runner-welcome-savefail-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'welcome-savefail-session',
    header: { id: 'welcome-savefail-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [...sessionEvents('welcome answer'), ...modelHistory('provider-a', 'model-a', 'high')],
  })
  const harness = makeHarness(home, resumed, { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' },
    async () => { throw new Error('quota exceeded') })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  await pickSecondModel(app, harness)
  assert.equal(probe.capturedWelcomeModels.at(-1), 'p/m2',
    'a global-default save failure must not stale the Welcome card: the Session choice stands')
  assert.equal(probe.capturedModels.at(-1), 'p/m2',
    'a global-default save failure must not stale the footer: the Session choice stands')
  const persisted = (harness.defaultModel as { currentSelection(): { provider: string; model: string; reasoningEffort?: string } }).currentSelection()
  assert.deepEqual(persisted, { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' },
    'the failed global-default write must leave the persisted default untouched')
})

test('a failed durable append leaves the Session, footer, and Welcome on the old model', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-runner-welcome-appendfail-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'welcome-appendfail-session',
    header: { id: 'welcome-appendfail-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [...sessionEvents('welcome answer'), ...modelHistory('provider-a', 'model-a', 'high')],
    append: () => { throw new Error('append failed') },
  })
  const harness = makeHarness(home, resumed, { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  await pickSecondModel(app, harness)
  assert.equal(probe.capturedWelcomeModels.at(-1), 'provider-a/model-a',
    'a failed append must leave the Welcome card on the old Session model')
  assert.equal(probe.capturedModels.at(-1), 'provider-a/model-a @high',
    'a failed append must leave the footer on the old Session model')
})

test('malformed request/header events cannot break the session event firehose', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-runner-malformed-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'malformed-session',
    header: { id: 'malformed-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('malformed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const before = probe.transcriptApplyCount
  // Object-shaped malformed payloads exercise the model-selection guard
  // (the header extraction) without tripping unrelated folds; the Session
  // class validates real events, so primitive data never reaches the
  // firehose in production.
  for (const data of [{}, { header: null }, { header: { config: null } }, { header: { config: { provider: 'p', model: 'm' } } }]) {
    context.emit('session/event', resumed as never, {
      type: 'request/header', seq: 20, time: Date.now(), data,
    } as never)
  }
  await settle()
  // A well-formed event after the malformed ones must still process.
  context.emit('session/event', resumed as never, event('turn/start', { turn: 1 }, 21))
  await settle()
  assert.ok(probe.transcriptApplyCount > before,
    'the firehose must survive malformed request/header events')
})

test('a live /model choice survives an immediate exit and resume', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-runner-exit-resume-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'exit-resume-session',
    header: { id: 'exit-resume-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: [...sessionEvents('first answer'), ...modelHistory('provider-a', 'model-a', 'high')],
  })
  const harness = makeHarness(home, resumed, { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  await pickSecondModel(app, harness)
  assert.equal(probe.capturedModels.at(-1), 'p/m2', 'the live /model must apply')
  // The durable append must be in the Session log BEFORE any teardown.
  assert.deepEqual(durableSelectionOf(resumed), { provider: 'p', model: 'm2' })
  // Immediate exit: dispose without submitting anything.
  await fiber.dispose()
  await disposeContext(context)
  fiber = undefined
  context = undefined
  // Resume the SAME Session: the durable choice must be restored.
  const harness2 = makeHarness(home, resumed, { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' })
  context = new Context()
  fiber = await mountRunner(context, home, harness2, { sessionId: resumed.id }, { sessionId: resumed.id })
  assert.equal(probe.capturedModels.at(-1), 'p/m2',
    'resume must restore the durable /model choice, not the global fallback')
})

test('startup applies the persisted wheel step BEFORE the first fullscreen mount', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-wheel-startup-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)

  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  // A long transcript so the first fullscreen frame can scroll.
  const longText = Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n')
  const resumed: FakeSession = fakeSession({
    id: 'wheel-startup-session',
    header: { id: 'wheel-startup-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents(longText),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  // The persisted wheel step AND fullscreen 'on' ride the plugin's
  // profile-owned Config references: the runner must hand the step to the
  // app BEFORE the first alt-screen mount (the fork reads it at
  // construction). No settings service is needed for reads.
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, {
    sessionId: resumed.id,
    fullscreen: 'on',
    wheelScrollLines: '8',
  })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  await vt.waitForRender()
  const bottom = app.fullscreenScrollForTest()
  assert.ok(bottom !== undefined && bottom.maxScrollTop > 0, 'precondition: scrollable transcript')
  vt.sendInput('\x1b[<64;50;10M') // wheel up over the transcript pane
  await vt.waitForRender()
  const after = app.fullscreenScrollForTest()
  assert.equal(after?.scrollTop, bottom.maxScrollTop - 8,
    'the FIRST fullscreen mount must already use the persisted wheel step (apply before setFullscreen)')
})


test('startup restores a persisted Compact preset unchanged and /display compact applies it', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-display-compact-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const probe = installProbe()
  life.defer(probe.restore)
  const resumed: FakeSession = fakeSession({
    id: 'display-compact-session',
    header: { id: 'display-compact-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('display compact'),
  })
  const userFooterItems = [{ id: 'user-item', kind: 'text', text: 'keep me' }]
  // The persisted document rides the plugin's profile-owned Config
  // references; the Settings surface records path-scoped writes.
  const mutations: Array<{ ns: string; ops: readonly { op: string; path: readonly string[]; value?: unknown }[] }> = []
  const settings = {
    describe: () => [{
      ns: 'tui-app',
      value: effectiveConfigView({
        fullscreen: 'off',
        displayPreset: 'compact',
        footerCustomItems: [{ id: 'project-item' }],
        keybindings: { tab: 'custom' },
      }),
      user: { footerCustomItems: userFooterItems },
      revision: 1,
    }],
    mutate: async (ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
      mutations.push({ ns, ops })
    },
  }
  const context = new Context()
  const harness = makeHarness(home, resumed)
  context.provide('settings', settings as never)
  const fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, {
    sessionId: resumed.id,
    fullscreen: 'off',
    displayPreset: 'compact',
    footerCustomItems: [{ id: 'project-item' }],
    keybindings: { tab: 'custom' },
  })
  await settle()
  const app = probe.apps.at(-1)
  assert.ok(app !== undefined, 'the production runner must create a TuiApp')
  assert.equal(app.displayPreset(), 'compact', 'a persisted Compact must restore as Compact, never fall back to Full')
  // The boot completes exactly the one-shot legacy-migration marker (no
  // legacy document exists anywhere): NO preference field is pinned and the
  // USER footer definitions are not copied over the project-layer value.
  assert.deepEqual(mutations, [
    { ns: 'tui-app', ops: [{ op: 'set', path: ['legacySettingsMigrationVersion'], value: 1 }] },
  ], 'a canonical preset must not trigger a preference write')

  const displayHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('display')
  assert.ok(displayHandler !== undefined, 'the production runner must register /display')
  const compactResult = await (displayHandler as unknown as (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }>)({ rawInput: 'compact' })
  assert.deepEqual(compactResult, { kind: 'success', text: 'Display: compact.' })
  await settle()
  assert.equal(app.displayPreset(), 'compact', 'Compact stays the live preset')
  assert.equal(mutations.length, 1, 'an unchanged value emits no write (no pinning; only the boot marker)')
  const focusResult = await (displayHandler as unknown as (invocation: { rawInput: string }) => Promise<{ kind: string; text?: string }>)({ rawInput: 'focus' })
  assert.deepEqual(focusResult, { kind: 'success', text: 'Display: focus.' })
  await settle()
  assert.equal(mutations.length, 2, 'a changed value persists through one more path-scoped mutation')
  assert.deepEqual(mutations[1]!.ops, [
    { op: 'set', path: ['displayPreset'], value: 'focus' },
  ], 'only the changed field is written; the user footer items are not re-pinned')
  await fiber.dispose()
  await disposeContext(context)
})

test('startup canonicalizes an invalid display preset, preserves raw fields, and retries after a failed write', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-display-migration-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const probe = installProbe()
  life.defer(probe.restore)
  const resumed: FakeSession = fakeSession({
    id: 'display-migration-session',
    header: { id: 'display-migration-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('display migration'),
  })
  const userFooterItems = [{ id: 'user-item', kind: 'text', text: 'keep me' }]
  // The invalid canonical value rides the plugin Config references on every
  // boot; the Settings surface records (and can refuse) the canonicalizing
  // path-scoped writes.
  const written: Array<{ op: string; path: readonly string[]; value?: unknown }> = []
  let failFirstWrite = true
  const settings = {
    describe: () => [{
      ns: 'tui-app',
      value: effectiveConfigView({
        fullscreen: 'off',
        displayPreset: 'garbage',
        footerCustomItems: [{ id: 'project-item' }],
        keybindings: { tab: 'custom' },
      }),
      user: { footerCustomItems: userFooterItems },
      revision: 1,
    }],
    mutate: async (_ns: string, ops: readonly { op: string; path: readonly string[]; value?: unknown }[]) => {
      for (const op of ops) written.push({ ...op })
      if (failFirstWrite) {
        failFirstWrite = false
        throw new Error('display migration write failed')
      }
    },
  }
  const mount = async (): Promise<{ context: Context; fiber: { dispose: () => Promise<unknown> }; app: TuiApp; harness: RunnerHarness }> => {
    const context = new Context()
    const harness = makeHarness(home, resumed)
    context.provide('settings', settings as never)
    const fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, {
      sessionId: resumed.id,
      fullscreen: 'off',
      displayPreset: 'garbage',
      footerCustomItems: [{ id: 'project-item' }],
      keybindings: { tab: 'custom' },
    })
    await settle()
    const app = probe.apps.at(-1)
    assert.ok(app !== undefined, 'the production runner must create a TuiApp')
    return { context, fiber, app, harness }
  }

  const first = await mount()
  assert.equal(first.app.displayPreset(), 'full', 'an invalid canonical value resolves to Full before the first frame')
  // The boot writes: the one-shot marker completion, then the canonicalizing
  // displayPreset set — raw fields are never re-pinned.
  assert.deepEqual(written, [
    { op: 'set', path: ['legacySettingsMigrationVersion'], value: 1 },
    { op: 'set', path: ['displayPreset'], value: 'full' },
  ])
  await first.fiber.dispose()
  await disposeContext(first.context)

  const second = await mount()
  assert.equal(second.app.displayPreset(), 'full')
  // The retry boot: the marker batch is now a no-op (the fake never commits
  // the reference), so the canonicalizing write retries alone.
  assert.deepEqual(written.at(-1), { op: 'set', path: ['displayPreset'], value: 'full' },
    'a later boot must retry the failed canonicalization')
  await second.fiber.dispose()
  await disposeContext(second.context)
})

test('live repaint preserves manual scrolling in the latest window', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-live-follow-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const initialText = Array.from({ length: 80 }, (_, index) => `initial line ${index}`).join('\n')
  const resumed: FakeSession = fakeSession({
    id: 'live-follow-session',
    header: { id: 'live-follow-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents(initialText),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  app.setFullscreen(true)
  await vt.waitForRender()
  const readScroll = () => {
    const current = app.fullscreenScrollForTest()
    assert.ok(current !== undefined, 'fullscreen scrolling must remain available')
    return current
  }
  assert.ok(readScroll().maxScrollTop > 0, 'the live transcript must be scrollable')

  app.scrollToBottom()
  assert.equal(readScroll().isFollowingEnd, true, 'the bottom position must follow live output')
  app.scrollToTop({ disableFollow: true })
  assert.equal(readScroll().isFollowingEnd, false, 'manual scrolling must disable follow-end')
  probe.scrollToBottomCount = 0

  context.emit('session/event', resumed as never, event('turn/start', { turn: 1 }, 10))
  const resumedAgent = liveAgentOf(harness, resumed.id)
  emitLiveStream(context, resumedAgent, liveStart('attempt-1', 1, 0))
  emitLiveStream(context, resumedAgent, liveChunkFrame('attempt-1', 0, { type: 'text-delta', index: 0, text: 'streaming while scrolled up' }))
  emitLiveStream(context, resumedAgent, liveChunkFrame('attempt-1', 1, { type: 'tool-call-delta', index: 0, id: 'preview-call', name: 'edit', argumentsDelta: '{"path"' }))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  assert.deepEqual(probe.capturedStreamingToolPreviews?.map(preview => preview.name), ['edit'])
  context.emit('session/event', resumed as never, event('tool/call', {
    turn: 1,
    step: 0,
    callId: 'preview-call' as ToolCallId,
    name: 'edit',
    arguments: '{"path":"x"}',
  }, 13))
  emitLiveStream(context, resumedAgent, liveCommittedEnd('attempt-1', 2, 'assistant/message'))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  assert.deepEqual(probe.capturedStreamingToolPreviews, [])

  context.emit('session/event', resumed as never, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 14))
  await vt.waitForRender()
  // A late REPLAY attempt after turn/end: its own start still opens an
  // attempt record, but the completed-turn gates drop every effect.
  emitLiveStream(context, resumedAgent, liveStart('attempt-late', 1, 0))
  emitLiveStream(context, resumedAgent, liveChunkFrame('attempt-late', 0, { type: 'tool-call-delta', index: 0, id: 'late-preview', name: 'write', argumentsDelta: '{' }))
  emitLiveStream(context, resumedAgent, liveCommittedEnd('attempt-late', 1, 'assistant/attempt'))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  assert.deepEqual(probe.capturedStreamingToolPreviews, [], 'late chunks after turn/end must not resurrect a preview')
  assert.equal(probe.scrollToBottomCount, 0, 'live repaint must not force the latest window to its bottom')
  assert.equal(readScroll().isFollowingEnd, false, 'live repaint must preserve the manually disabled follow-end state')
  assert.ok(readScroll().scrollTop < readScroll().maxScrollTop, 'live repaint must leave the viewport away from the bottom')

  app.scrollToBottom()
  await vt.waitForRender()
  assert.equal(readScroll().isFollowingEnd, true, 'an explicit bottom jump must re-enable follow-end')
  probe.scrollToBottomCount = 0
  context.emit('session/event', resumed as never, event('turn/start', { turn: 2 }, 16))
  emitLiveStream(context, resumedAgent, liveStart('attempt-2', 2, 0))
  emitLiveStream(context, resumedAgent, liveChunkFrame('attempt-2', 0, { type: 'text-delta', index: 0, text: 'streaming while following' }))
  context.emit('session/event', resumed as never, event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 18))
  await vt.waitForRender()
  assert.equal(probe.scrollToBottomCount, 0, 'ScrollView follow-end must handle live output without an imperative jump')
  assert.equal(readScroll().isFollowingEnd, true, 'a viewport following the end must remain attached to live output')
  const following = readScroll()
  assert.equal(following.scrollTop, following.maxScrollTop, JSON.stringify(following))
})

test('an inactive child completion during observeSession is replayed by the viewer opening cut', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-viewer-opening-gap-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'viewer-opening-parent',
    header: { id: 'viewer-opening-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const child: FakeSession = fakeSession({
    id: 'viewer-opening-child',
    header: {
      id: 'viewer-opening-child',
      cwd: home,
      createdAt: 1_700_000_000_001,
      version: SESSION_FORMAT_VERSION,
      isSeeded: true,
      parentSession: parent.id,
    },
    events: [
      event('turn/start', { turn: 1 }, 0),
      event('step/start', { turn: 1, step: 1 }, 1),
      event('user/message', {
        id: MessageId('viewer-opening-parent-prompt'),
        role: 'user',
        content: [{ type: 'text', text: 'parent prompt hidden from child viewer' }],
        source: { kind: 'user' },
      }, 2, 'append'),
      event('user/message', {
        id: MessageId('viewer-opening-parent-notice'),
        role: 'user',
        content: [{ type: 'text', text: 'parent settlement notice hidden from child viewer' }],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          summary: 'parent settlement notice hidden from child viewer',
          senderSessionId: SessionId('viewer-opening-child'),
        },
      }, 3, 'append'),
      event('assistant/message', {
        turn: 1,
        step: 1,
        message: {
          id: MessageId('viewer-opening-parent-reply'),
          role: 'assistant',
          content: [{ type: 'text', text: 'parent reply hidden from child viewer' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        usage: { inputTokens: 9, outputTokens: 3 },
        stream: [],
      }, 4, 'append'),
      event('step/end', { turn: 1, step: 1 }, 5),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6),
      event('session/end-seed', { inherited: true }, 7),
      event('turn/start', { turn: 2 }, 8),
      event('step/start', { turn: 2, step: 1 }, 9),
      event('user/message', {
        id: MessageId('viewer-opening-first-prompt'),
        role: 'user',
        content: [{ type: 'text', text: 'child first prompt' }],
        source: { kind: 'user' },
      }, 10, 'append'),
      event('assistant/message', {
        turn: 2,
        step: 1,
        message: {
          id: MessageId('viewer-opening-first-reply'),
          role: 'assistant',
          content: [{ type: 'text', text: 'child first reply' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        usage: { inputTokens: 9, outputTokens: 3 },
        stream: [],
      }, 11, 'append'),
      event('step/end', { turn: 2, step: 1 }, 12),
      event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 13),
    ],
  })
  const subagents = {
    listDescendants: async () => [{
      kind: 'child', id: child.id, label: 'opening child', mode: 'continuable', activity: 'inactive',
      hasChildren: false, parentId: parent.id, depth: 1,
    }],
  }
  const harness = makeHarness(home, [parent, child], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  let releaseObservation!: () => void
  const observationGate = new Promise<void>(resolve => { releaseObservation = resolve })
  let observationStarted!: () => void
  const observationStartedPromise = new Promise<void>(resolve => { observationStarted = resolve })
  const sessionQuery = harness.sessionQuery as {
    observeSession: (id: unknown, options?: unknown) => Promise<{ header: unknown; events: readonly SessionEvent[]; [Symbol.dispose](): void }>
  }
  const originalObserve = sessionQuery.observeSession
  sessionQuery.observeSession = async (id, options) => {
    const snapshot = await originalObserve(id, options)
    if (String(id) === child.id) {
      observationStarted()
      await observationGate
    }
    return snapshot
  }

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  // A subagent row opens the child TRANSCRIPT (a session/viewer surface):
  // the disposition is 'close', so the Task Center must be gone — unlike a
  // Job status detail, which stays mounted underneath (see the jobs-only
  // test below).
  assert.equal(app.overlayGraphState().handles, 1, 'the Task Center must be open before the selection')
  input('\r')
  assert.equal(app.overlayGraphState().handles, 0, 'a subagent transcript must replace the browser')
  await observationStartedPromise

  const childHandle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: child.id })
  const childAgent = liveAgentOf(harness, child.id)
  const emitDurable = (type: string, data: unknown, surfaceOp?: 'append'): void => {
    const next = child.append!(type, data, surfaceOp === undefined ? undefined : { surfaceOp }) as SessionEvent
    context!.emit('session/event', child as never, next)
  }
  emitDurable('session/end-seed', {})
  emitDurable('turn/start', { turn: 3 })
  emitDurable('step/start', { turn: 3, step: 1 })
  emitDurable('user/message', {
    id: MessageId('viewer-opening-resumed-prompt'),
    role: 'user',
    content: [{ type: 'text', text: 'child resumed prompt' }],
    source: { kind: 'user' },
  }, 'append')
  emitDurable('assistant/message', {
    turn: 3,
    step: 1,
    message: {
      id: MessageId('viewer-opening-completed'),
      role: 'assistant',
      content: [{ type: 'text', text: 'child resumed reply' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 9, outputTokens: 3 },
    stream: [],
  }, 'append')
  emitDurable('step/end', { turn: 3, step: 1 })
  emitDurable('turn/end', { turn: 3, reason: { kind: 'completed' } })
  context.emit('agent/disposed', { agent: childAgent } as never)
  await childHandle.dispose()

  releaseObservation()
  await settle()
  await vt.waitForRender()
  assert.notEqual(app.getViewerGeneration(), 0, 'the child viewer must mount after the cold observation returns')
  const messages = probe.capturedMessages ?? []
  const texts = messages.map(message => message.text ?? '')
  assert.equal(texts.filter(text => text === 'child resumed reply').length, 1,
    'buffered child durable events must be hydrated exactly once after the stale observation cut')
  for (const visible of ['child first prompt', 'child first reply', 'child resumed prompt', 'child resumed reply']) {
    assert.ok(texts.includes(visible), `child history must include ${visible}: ${texts.join(' | ')}`)
  }
  for (const hidden of ['parent prompt hidden from child viewer', 'parent reply hidden from child viewer', 'parent settlement notice hidden from child viewer']) {
    assert.ok(!texts.includes(hidden), `parent history must stay hidden: ${hidden}`)
  }
  assert.ok(texts.indexOf('child first prompt') < texts.indexOf('child resumed prompt'),
    `child turns must remain in order: ${texts.join(' | ')}`)
})

test('an inactive child cold-resume replays its opening prefix and running activity', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-viewer-opening-live-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'viewer-opening-live-parent',
    header: { id: 'viewer-opening-live-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const child: FakeSession = fakeSession({
    id: 'viewer-opening-live-child',
    header: { id: 'viewer-opening-live-child', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('child history'),
  })
  const subagents = {
    listDescendants: async () => [{
      kind: 'child', id: child.id, label: 'opening live child', mode: 'continuable', activity: 'inactive',
      hasChildren: false, parentId: parent.id, depth: 1,
    }],
  }
  const harness = makeHarness(home, [parent, child], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  let releaseObservation!: () => void
  const observationGate = new Promise<void>(resolve => { releaseObservation = resolve })
  let observationStarted!: () => void
  const observationStartedPromise = new Promise<void>(resolve => { observationStarted = resolve })
  const sessionQuery = harness.sessionQuery as {
    observeSession: (id: unknown, options?: unknown) => Promise<{ header: unknown; events: readonly SessionEvent[]; [Symbol.dispose](): void }>
  }
  const originalObserve = sessionQuery.observeSession
  sessionQuery.observeSession = async (id, options) => {
    const snapshot = await originalObserve(id, options)
    if (String(id) === child.id) {
      observationStarted()
      await observationGate
    }
    return snapshot
  }

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  // A subagent row opens the child TRANSCRIPT (a session/viewer surface):
  // the disposition is 'close', so the Task Center must be gone — unlike a
  // Job status detail, which stays mounted underneath (see the jobs-only
  // test below).
  assert.equal(app.overlayGraphState().handles, 1, 'the Task Center must be open before the selection')
  input('\r')
  assert.equal(app.overlayGraphState().handles, 0, 'a subagent transcript must replace the browser')
  await observationStartedPromise

  const childHandle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: child.id })
  life.defer(() => childHandle.dispose())
  const childAgent = liveAgentOf(harness, child.id)
  ;(childAgent as { status: 'idle' | 'running' }).status = 'running'
  const emitDurable = (type: string, data: unknown): void => {
    const next = child.append!(type, data) as SessionEvent
    context!.emit('session/event', child as never, next)
  }
  emitLiveStream(context, childAgent, { type: 'start', attemptId: 'viewer-opening-live', revision: 1, turn: 1, step: 0 })
  emitLiveStream(context, childAgent, {
    type: 'chunk', attemptId: 'viewer-opening-live', revision: 2, index: 0,
    time: 1_700_000_000_200, chunk: { type: 'text-delta', index: 0, text: 'child opening prefix' },
  })
  releaseObservation()
  await settle()
  await vt.waitForRender()
  assert.notEqual(app.getViewerGeneration(), 0, 'the child viewer must mount after observation')
  assert.equal((probe.capturedViewerMode as { activity?: string } | undefined)?.activity, 'running',
    'the attached Agent runtime status must override stale catalog and durable history activity during viewer opening')
  assert.ok((probe.capturedMessages ?? []).some(message => message.text === 'child opening prefix'),
    'the exact child Agent baseline must replay after durable opening hydration')
})

test('the parent Preparing projection and child viewer lifecycle rollover stay live', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-parent-preparing-viewer-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'parent-preparing-viewer-session',
    header: { id: 'parent-preparing-viewer-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const child: FakeSession = fakeSession({
    id: 'child-preparing-viewer-session',
    header: { id: 'child-preparing-viewer-session', cwd: home, createdAt: 1_700_000_000_001, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('child answer'),
  })
  const subagents = {
    listDescendants: async () => [{
      kind: 'child',
      id: child.id,
      label: 'child viewer',
      mode: 'continuable',
      activity: 'running',
      hasChildren: false,
      parentId: parent.id,
      depth: 1,
    }],
  }
  const harness = makeHarness(home, [parent, child], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  const childHandle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: child.id })
  life.defer(() => childHandle.dispose())
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const parentArguments = '{"path":"parent.ts"}'
  const childArguments = '{"command":"child"}'

  // The main session owns the first preview before the viewer opens.
  context.emit('session/event', parent as never, event('turn/start', { turn: 1 }, 10))
  const parentAgent = liveAgentOf(harness, parent.id)
  emitLiveStream(context, parentAgent, liveStart('p1', 1, 0))
  emitLiveStream(context, parentAgent, liveChunkFrame('p1', 0, {
    type: 'tool-call-delta', index: 0, id: '', name: 'edit', argumentsDelta: parentArguments,
  }))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  assert.deepEqual(probe.capturedStreamingToolPreviews?.map(preview => [
    preview.callId, preview.name, preview.argumentBytes, preview.summary,
  ]), [['', 'edit', Buffer.byteLength(parentArguments, 'utf8'), 'parent.ts']])

  // The child Agent is already live, but its viewer has not mounted yet. Its
  // active prefix must remain available for the later exact-Agent replay.
  const childAgent = liveAgentOf(harness, child.id)
  emitLiveStream(context, childAgent, { type: 'start', attemptId: 'c1', revision: 1, turn: 1, step: 0 })
  emitLiveStream(context, childAgent, {
    type: 'chunk', attemptId: 'c1', revision: 2, index: 0,
    time: 1_700_000_000_100, chunk: { type: 'text-delta', index: 0, text: 'late child answer' },
  })
  emitLiveStream(context, childAgent, {
    type: 'chunk', attemptId: 'c1', revision: 3, index: 1,
    time: 1_700_000_000_101, chunk: {
      type: 'tool-call-delta', index: 1, id: 'child-call', name: 'bash', argumentsDelta: childArguments,
    },
  })

  // /tasks opens the real runner browser, and Enter mounts the child viewer.
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.notEqual(app.getViewerGeneration(), 0, 'the child viewer must be mounted')
  assert.ok(probe.capturedMessages?.some(message => message.kind === 'assistant' && message.text === 'late child answer'),
    'a late child viewer must replay the exact Agent baseline after durable hydration')
  assert.deepEqual(probe.capturedStreamingToolPreviews?.map(preview => [
    preview.callId, preview.name, preview.argumentBytes, preview.summary,
  ]), [['child-call', 'bash', Buffer.byteLength(childArguments, 'utf8'), 'child']])

  // The same continuable child can roll from Activation A to a new Agent B
  // without closing the viewer. A's delayed frame must stay fenced while B's
  // first live text is immediately visible.
  emitLiveStream(context, childAgent, {
    type: 'end', attemptId: 'c1', revision: 4, index: 2,
    outcome: { kind: 'abandoned' },
  })
  const childBHandle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: child.id })
  life.defer(() => childBHandle.dispose())
  const childAgentB = liveAgentOf(harness, child.id)
  context.emit('agent/disposed', { agent: childAgent } as never)
  emitLiveStream(context, childAgent, {
    type: 'chunk', attemptId: 'c1', revision: 5, index: 2,
    time: 1_700_000_000_102, chunk: { type: 'text-delta', index: 0, text: 'STALE-A' },
  })
  context.emit('session/event', child as never, event('turn/start', { turn: 2 }, 25))
  context.emit('session/event', child as never, event('step/start', { turn: 2, step: 0 }, 26))
  emitLiveStream(context, childAgentB, { type: 'start', attemptId: 'c2', revision: 1, turn: 2, step: 0 })
  emitLiveStream(context, childAgentB, {
    type: 'chunk', attemptId: 'c2', revision: 2, index: 0,
    time: 1_700_000_026_100, chunk: { type: 'text-delta', index: 0, text: 'follow-up live' },
  })
  emitLiveStream(context, childAgentB, {
    type: 'chunk', attemptId: 'c2', revision: 3, index: 1,
    time: 1_700_000_026_101, chunk: { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 } },
  })
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  assert.ok(probe.capturedMessages?.some(message => message.kind === 'assistant' && message.text === 'follow-up live'),
    'the replacement Agent must feed the still-open viewer immediately')

  emitLiveStream(context, childAgentB, {
    type: 'end', attemptId: 'c2', revision: 4, index: 2,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 30 },
  })
  context.emit('session/event', child as never, event('assistant/message', {
    turn: 2,
    step: 0,
    message: {
      id: MessageId('child-rollover-message'),
      role: 'assistant',
      content: [{ type: 'text', text: 'follow-up durable' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    usage: { inputTokens: 11, outputTokens: 3 },
    stream: [],
  }, 30, 'append'))
  context.emit('session/event', child as never, event('step/end', { turn: 2, step: 0 }, 31))
  context.emit('session/event', child as never, event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 32))
  await settle()
  await vt.waitForRender()
  assert.equal(probe.capturedMessages?.filter(message => message.kind === 'assistant' && message.text === 'follow-up durable').length, 1,
    'B durable settlement must replace its live row exactly once')
  assert.equal(probe.capturedMessages?.some(message => message.text === 'STALE-A'), false,
    'A delayed frames must not contaminate B')
  const rolloverActivity = probe.capturedActivities?.get(2) as {
    lastAssistantVisible?: boolean
    usage?: { inputTokens: number; outputTokens: number }
  } | undefined
  assert.equal(rolloverActivity?.lastAssistantVisible, true, 'Focus must follow B visibility')
  assert.deepEqual(rolloverActivity?.usage, { inputTokens: 11, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 })
  const viewerUsage = probe.capturedViewerUsage as {
    tokens?: { input: number; output: number }
    performance?: { firstTokenMs: number }
  } | undefined
  assert.deepEqual(viewerUsage?.tokens, { input: 21, output: 5, cacheRead: 0, cacheWrite: 0 })
  assert.ok((viewerUsage?.performance?.firstTokenMs ?? 0) > 0, 'B first-token timing must reach the child stats footer')

  // Parent events continue through the runner while the child owns the
  // visible transcript. Updating A and adding B must both survive the visit.
  emitLiveStream(context, parentAgent, liveChunkFrame('p1', 1, { type: 'tool-call-delta', index: 0, id: '', name: 'write', argumentsDelta: '}' }))
  emitLiveStream(context, parentAgent, liveChunkFrame('p1', 2, { type: 'tool-call-delta', index: 1, id: 'parent-call-b', name: 'read', argumentsDelta: '{' }))
  emitLiveStream(context, parentAgent, liveChunkFrame('p1', 3, {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'parent-call-a', name: 'write' },
  }))
  emitLiveStream(context, parentAgent, liveCommittedEnd('p1', 4, 'assistant/message'))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()

  // Esc returns to the parent surface; its hidden map, not a reset map, is
  // projected and therefore contains the latest A plus the new B.
  input('\x1b')
  await settle()
  await vt.waitForRender()
  assert.deepEqual(probe.capturedStreamingToolPreviews?.map(preview => [
    preview.callId, preview.name, preview.argumentBytes, preview.summary,
  ]), [
    ['parent-call-a', 'write', Buffer.byteLength(parentArguments + '}', 'utf8'), 'parent.ts'],
    ['parent-call-b', 'read', Buffer.byteLength('{', 'utf8'), undefined],
  ])

  // A parent call that materializes while the child remains visible must be
  // removed from the hidden main map, not recreated when the viewer closes.
  context.emit('session/event', parent as never, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 15))
  await vt.waitForRender()
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(app.getViewerGeneration(), 3, 'the child viewer must reopen')
  context.emit('session/event', parent as never, event('turn/start', { turn: 2 }, 16))
  emitLiveStream(context, parentAgent, liveStart('p2', 2, 0))
  emitLiveStream(context, parentAgent, liveChunkFrame('p2', 0, { type: 'tool-call-delta', index: 0, id: 'parent-call-c', name: 'edit', argumentsDelta: '{' }))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  context.emit('session/event', parent as never, event('tool/call', {
    turn: 2,
    step: 0,
    callId: 'parent-call-c' as ToolCallId,
    name: 'edit',
    arguments: '{}',
  }, 18))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  input('\x1b')
  await settle()
  await vt.waitForRender()
  assert.deepEqual(probe.capturedStreamingToolPreviews, [],
    'a parent preview materialized behind the viewer must not return on exit')
})

test('a FAILED attempt clears its streaming tool previews (durable settlement and abandoned end)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-failed-attempt-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'runner-failed-attempt-session',
    header: { id: 'runner-failed-attempt-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  app.setFullscreen(true)
  await vt.waitForRender()
  const agent = liveAgentOf(harness, resumed.id)

  // Attempt A streams a tool-call preview, then FAILS (durable log-only
  // settlement): the preview must not survive as a ghost row.
  context.emit('session/event', resumed as never, event('turn/start', { turn: 1 }, 10))
  context.emit('session/event', resumed as never, event('step/start', { turn: 1, step: 0 }, 11))
  emitLiveStream(context, agent, liveStart('fa-1', 1, 0))
  emitLiveStream(context, agent, liveChunkFrame('fa-1', 0, { type: 'tool-call-delta', index: 0, id: 'ghost-call', name: 'edit', argumentsDelta: '{' }))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  const previewsAfterA: readonly StreamingToolPreview[] | undefined = probe.capturedStreamingToolPreviews
  assert.ok(previewsAfterA !== undefined)
  assert.deepEqual(previewsAfterA.map(preview => preview.callId), ['ghost-call'])
  context.emit('session/event', resumed as never, event('assistant/attempt', { turn: 1, step: 0, stream: [] }, 12))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  assert.deepEqual(probe.capturedStreamingToolPreviews, [],
    'a durable assistant/attempt clears the step\'s previews — its deltas never materialized')
  context.emit('session/event', resumed as never, event('step/end', { turn: 1, step: 0 }, 13))

  // Attempt B streams another preview and is ABANDONED live (no durable
  // settlement at all): the preview vanishes with the transient attempt.
  context.emit('session/event', resumed as never, event('turn/start', { turn: 2 }, 14))
  emitLiveStream(context, agent, liveStart('fa-2', 2, 0))
  emitLiveStream(context, agent, liveChunkFrame('fa-2', 0, { type: 'tool-call-delta', index: 0, id: 'abandoned-call', name: 'bash', argumentsDelta: '{' }))
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  const previewsAfterB: readonly StreamingToolPreview[] | undefined = probe.capturedStreamingToolPreviews
  assert.ok(previewsAfterB !== undefined)
  assert.deepEqual(previewsAfterB.map(preview => preview.callId), ['abandoned-call'])
  emitLiveStream(context, agent, {
    type: 'end', attemptId: 'fa-2', revision: ++liveStreamRevision, index: 1,
    outcome: { kind: 'abandoned' },
  })
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  assert.deepEqual(probe.capturedStreamingToolPreviews, [],
    'an abandoned end clears the step\'s previews with the transient attempt')
})

test('the Loader barrier shows Starting DSH… then clears; explicit cold resume continues with the resume status', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-startup-status-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  // Capture the runner's status writes through the INJECTED output seam
  // (never a global process.stdout patch — that would fight the test
  // reporter's own writes) and the cordis logger messages into ONE
  // ordered log: the shared order lets the failure path assert that the
  // status is suspended BEFORE the failure logs (a TTY shares one cursor
  // between stdout and stderr).
  const orderedLog: string[] = []
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
    },
  }
  let resumeContext: Context | undefined
  let deferredContext: Context | undefined
  let failContext: Context | undefined
  let resumeFiber: { dispose: () => Promise<unknown> } | undefined
  let deferredFiber: { dispose: () => Promise<unknown> } | undefined
  let failFiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (failContext !== undefined) return disposeContext(failContext) })
  life.defer(() => { if (deferredContext !== undefined) return disposeContext(deferredContext) })
  life.defer(() => { if (resumeContext !== undefined) return disposeContext(resumeContext) })
  life.defer(() => { if (failFiber !== undefined) return failFiber.dispose() })
  life.defer(() => { if (deferredFiber !== undefined) return deferredFiber.dispose() })
  life.defer(() => { if (resumeFiber !== undefined) return resumeFiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'startup-status-session',
    header: { id: 'startup-status-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const resumeHarness = makeHarness(home, resumed)
  resumeContext = new Context()
  resumeFiber = await mountRunner(resumeContext, home, resumeHarness, { sessionId: resumed.id }, { sessionId: resumed.id, startupStatusOutput: statusOutput })
  // The FIRST pre-mount status is the Loader barrier: it must be written
  // BEFORE the barrier resolves and cleared immediately after, so a stalled
  // optional row is visible instead of a dead blank terminal.
  const startingWrites = orderedLog
    .filter(write => write.startsWith('stdout:') && (write.includes('Starting DSH…') || write === 'stdout:\r\x1b[2K'))
    .map(write => write.slice('stdout:'.length))
  assert.ok(startingWrites.some(write => write.includes('Starting DSH…')),
    `the Loader barrier must show Starting DSH…: ${JSON.stringify(startingWrites)}`)
  const startIndex = startingWrites.findIndex(write => write.includes('Starting DSH…'))
  const startClearIndex = startingWrites.findIndex((write, index) => index > startIndex && write === '\r\x1b[2K')
  assert.ok(startClearIndex > startIndex,
    `Starting DSH… must be cleared after the Loader settles: ${JSON.stringify(startingWrites)}`)
  const statusWrites = orderedLog
    .filter(write => write.startsWith('stdout:') && (write.includes('Resuming session') || write.includes('Preparing conversation') || write === 'stdout:\r\x1b[2K'))
    .map(write => write.slice('stdout:'.length))
  assert.ok(statusWrites.some(write => write.includes('Resuming session…')),
    `the resume status must be written before mount: ${JSON.stringify(statusWrites)}`)
  assert.ok(statusWrites.some(write => write.includes('Preparing conversation…')),
    `the preparing stage must replace the resume line: ${JSON.stringify(statusWrites)}`)
  const showIndexes = statusWrites
    .map((write, index) => write.includes('Resuming') || write.includes('Preparing') ? index : -1)
    .filter(index => index >= 0)
  // The status is suspended before the success log (a mid-resume clear)
  // and cleared again before mount: the LAST clear must follow the last
  // show.
  const lastClearIndex = statusWrites.map((write, index) => write === '\r\x1b[2K' ? index : -1).filter(index => index >= 0).at(-1)
  assert.ok(lastClearIndex !== undefined && lastClearIndex > showIndexes[showIndexes.length - 1]!,
    `the status must be cleared after the last show (before mount): ${JSON.stringify(statusWrites)}`)
  // The resume lifecycle is untouched: exactly one hydration, no extra
  // transcript rows.
  assert.equal(probe.transcriptHydrateCount, 1)
  assert.equal(probe.statsHydrateCount, 1)
  assert.equal(probe.transcriptApplyCount, 1)

  await resumeFiber.dispose()
  await disposeContext(resumeContext)
  resumeFiber = undefined
  resumeContext = undefined

  // A fresh (deferred) start shows ONLY the Loader barrier status: it must
  // never emit the resume/preparing stages, and the barrier line must not
  // survive into the mounted surface.
  orderedLog.length = 0
  const deferredHarness = makeHarness(home)
  deferredContext = new Context()
  deferredFiber = await mountRunner(deferredContext, home, deferredHarness, {}, { startupStatusOutput: statusOutput })
  assert.ok(orderedLog.some(write => write === 'stdout:\r\x1b[2KStarting DSH…'),
    `a fresh start must show the Loader barrier status: ${JSON.stringify(orderedLog)}`)
  assert.ok(orderedLog.some(write => write === 'stdout:\r\x1b[2K'),
    `the Loader barrier status must be cleared: ${JSON.stringify(orderedLog)}`)
  assert.ok(!orderedLog.some(write => write.includes('Resuming session') || write.includes('Preparing conversation')),
    `a fresh start must not emit the resume/preparing stages: ${JSON.stringify(orderedLog)}`)

  await deferredFiber.dispose()
  await disposeContext(deferredContext)
  deferredFiber = undefined
  deferredContext = undefined

  // A FAILED resume also clears the status (the surface starts
  // sessionless — no stale line may survive), and the clear happens
  // BEFORE the failure logs: the status owns the current terminal
  // line, so a logger write must never interleave with it (a TTY
  // shares one cursor between stdout and stderr).
  orderedLog.length = 0
  const failedSession: FakeSession = fakeSession({
    id: 'missing-session',
    header: { id: 'missing-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('failed resume history'),
  })
  const failHarness = makeHarness(
    home,
    failedSession,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new Error('boom'),
  )
  const failCtx = new Context()
  const appsBeforeFailure = probe.apps.length
  failContext = failCtx
  // Capture the runner's failure logs through the cordis logger
  // exporter (the same sink a real deployment registers). The exporter
  // threshold lives in `levels.default` (the MAXIMUM level exported):
  // WARN (2) admits the runner's warn/error lines (the default INFO
  // threshold would drop them). Registered inside a fiber — cordis
  // registers exporters through ctx.effect.
  const exporterFiber = failCtx.plugin(() => {
    failCtx.logger.exporter({
      levels: { default: 2 },
      export: (message) => {
        orderedLog.push(`log:${message.name}:${message.args.map(String).join(' ')}`)
      },
    })
  })
  await exporterFiber
  failFiber = await mountRunner(failContext, home, failHarness, { sessionId: 'missing-session' }, { sessionId: 'missing-session', startupStatusOutput: statusOutput })
  assert.equal(failHarness.resumeSignals[0]?.aborted, false,
    'an ordinary resume failure must observe a live lifecycle signal')
  assert.equal(probe.apps.length, appsBeforeFailure + 1,
    'an ordinary resume failure must keep the existing sessionless fallback mount')
  assert.ok(orderedLog.some(write => write.includes('resume missing-session failed: boom')),
    `the ordinary resume error must remain visible: ${JSON.stringify(orderedLog)}`)
  const failWrites = orderedLog.filter(write => write.includes('Resuming session') || write === 'stdout:\r\x1b[2K')
  assert.ok(failWrites.some(write => write.includes('Resuming session…')),
    `the failed resume still shows the status: ${JSON.stringify(failWrites)}`)
  assert.ok(failWrites.some(write => write === 'stdout:\r\x1b[2K'),
    `the failed resume clears the status: ${JSON.stringify(failWrites)}`)
  const clearIndexInLog = orderedLog.findIndex(write => write === 'stdout:\r\x1b[2K')
  const warnIndexInLog = orderedLog.findIndex(write => write.startsWith('log:') && write.includes('resume missing-session failed'))
  assert.ok(clearIndexInLog >= 0 && warnIndexInLog > clearIndexInLog,
    `the status must be cleared BEFORE the failure log (clear at ${clearIndexInLog}, warn at ${warnIndexInLog}): ${JSON.stringify(orderedLog)}`)
})


test('disposing before explicit resume publication cancels startup without mounting a fallback surface', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-startup-cancel-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const resumed: FakeSession = fakeSession({
    id: 'startup-cancel-session',
    header: { id: 'startup-cancel-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  let resumeStarted!: () => void
  const resumeStartedPromise = new Promise<void>(resolve => { resumeStarted = resolve })
  let capturedSignal: AbortSignal | undefined
  const agents = harness.agents as {
    resume: (options: { resumeSessionId: unknown; signal?: AbortSignal }) => Promise<never>
  }
  agents.resume = async ({ signal }) => {
    harness.resumeSignals.push(signal)
    capturedSignal = signal
    resumeStarted()
    if (signal === undefined) throw new Error('test resume did not receive a lifecycle signal')
    if (signal.aborted) throw new Error('resume cancelled')
    return await new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('resume cancelled')), { once: true })
    })
  }
  let exitCalls = 0
  const cancellationLogs: string[] = []
  context = new Context()
  const exporterFiber = context.plugin(pluginCtx => {
    pluginCtx.logger.exporter({
      levels: { default: 2 },
      export: message => {
        cancellationLogs.push(`${message.name}:${message.args.map(String).join(' ')}`)
      },
    })
  })
  await exporterFiber
  fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: resumed.id },
    { sessionId: resumed.id },
    () => { exitCalls += 1 },
  )
  await resumeStartedPromise
  assert.equal(harness.resumeSignals[0], capturedSignal)
  assert.ok(capturedSignal, 'explicit resume must receive a runner lifecycle signal')

  await fiber.dispose()
  fiber = undefined
  assert.equal(capturedSignal.aborted, true, 'fiber disposal must abort the pending resume')
  await settle()

  assert.equal(probe.apps.length, 0, 'cancelled startup must not mount a TUI')
  assert.equal(harness.createdSessions.length, 0, 'cancelled startup must not fall back to a fresh session')
  assert.equal((harness.agents as { get: (id: string) => unknown }).get(resumed.id), undefined,
    'the pre-publication fake must not publish a target Agent')
  assert.equal(exitCalls, 0, 'lifecycle cancellation must not take the fatal startup exit path')
  assert.ok(!cancellationLogs.some(log => log.includes('resume failed') || log.includes('fatal')),
    `lifecycle cancellation must not emit ordinary/fatal startup failure logs: ${JSON.stringify(cancellationLogs)}`)
  await disposeContext(context)
  context = undefined
})


test('the Preparing status stays on screen through the catalog ready barrier', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-catalog-barrier-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'slow-catalog-session',
    header: { id: 'slow-catalog-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  // A SLOW skills service: the catalog ready barrier (resolveInitialCatalog
  // → readSurfaceCatalog → readHumanSkillCatalog) takes ~300ms, so the
  // test can observe the status while the barrier is still pending.
  context.provide('skills', {
    snapshot: async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
      return { skills: [], complete: true }
    },
  } as never)
  // Start the mount WITHOUT awaiting: the barrier is in flight while
  // the assertions below run.
  const mountPromise = mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id, startupStatusOutput: statusOutput })
  const statusWrites = (): string[] => orderedLog
    .filter(write => write.startsWith('stdout:') && (write.includes('Preparing conversation') || write === 'stdout:\r\x1b[2K'))
    .map(write => write.slice('stdout:'.length))
  // Wait until the Preparing stage is on screen — the barrier is still
  // pending (its slow skills read has not settled yet).
  const deadline = Date.now() + 5000
  let observed = false
  while (Date.now() < deadline) {
    const writes = statusWrites()
    if (writes.some(write => write.includes('Preparing conversation'))) {
      const last = writes[writes.length - 1]!
      assert.ok(last.includes('Preparing conversation'),
        `the status must STAY on screen through the catalog barrier (last write: ${JSON.stringify(last)}): ${JSON.stringify(writes)}`)
      observed = true
      break
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(observed, 'the Preparing stage must appear while the barrier is pending')
  fiber = await mountPromise
  // The fiber load settles when applyRunner returns (the startup IIFE
  // is fire-and-forget), so the mount promise resolves BEFORE the
  // barrier completes: wait for the runner to actually reach the
  // mount-time clear — the barrier resolved and the TUI is about to
  // mount.
  const deadline2 = Date.now() + 5000
  while (Date.now() < deadline2) {
    const writes = statusWrites()
    if (writes[writes.length - 1] === '\r\x1b[2K') break
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const writes = statusWrites()
  const last = writes[writes.length - 1]!
  assert.equal(last, '\r\x1b[2K',
    `the status must be cleared before mount: ${JSON.stringify(writes)}`)
  // Let the post-mount wiring settle before the finally disposes the
  // context (the runner's startup IIFE is fire-and-forget).
  await new Promise(resolve => setTimeout(resolve, 200))
})

test('an emitted skills/change reaches the runner catalog refresh for the current owner', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-skills-change-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const resumed: FakeSession = fakeSession({
    id: 'skills-change-session',
    header: { id: 'skills-change-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('skills change answer'),
  })
  const harness = makeHarness(home, resumed)
  const context = new Context()
  life.defer(() => disposeContext(context))
  let snapshots = 0
  const scopes: unknown[] = []
  context.provide('skills', {
    snapshot: async (options: { readonly scope?: object }) => {
      snapshots += 1
      scopes.push(options?.scope)
      return { skills: [], complete: true }
    },
  } as never)
  const fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  life.defer(() => fiber.dispose())
  await settle()
  const before = snapshots
  const emitSkillsChange = (): void =>
    (context as unknown as { emit(name: string, payload: unknown): void }).emit('skills/change', {})
  // A BURST of invalidations: the runner's `skills/change` listener must reach
  // the CoalescingRefreshGate and drive a catalog refresh for the CURRENT
  // owner (re-reading the skill catalog), while coalescing the burst.
  emitSkillsChange()
  emitSkillsChange()
  emitSkillsChange()
  const deadline = Date.now() + 3000
  while (snapshots === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(snapshots > before,
    'an emitted skills/change must drive a catalog refresh (skill re-read) for the current owner')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.ok(snapshots - before <= 2,
    `a burst of skills/change must coalesce to at most two reads (observed ${snapshots - before})`)
  // The refresh must read in the CURRENT LIVE AGENT scope, never the standing
  // or global scope: the Agent object carries `session`; a standing key does
  // not, and the global target passes `undefined`.
  assert.ok(scopes.length > 0, 'the invalidation refresh must read the skill catalog with a scope')
  assert.ok(
    scopes.every(scope => typeof scope === 'object' && scope !== null && 'session' in scope),
    'every skills/change refresh must read the skill catalog in the LIVE AGENT scope (not standing/global)',
  )
})

test('a fresh start with a FAILING preset resolution shows only the Loader barrier status', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-fresh-preset-fail-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  // Deferred start (no sessionId) with a BROKEN agentPresets roster:
  // every compose throws (the launch-preset fallback AND the default
  // fallback), so the catalog block's catch runs. The failure path
  // must NOT re-arm the startup status: the Loader barrier line was
  // already cleared, and no resume/preparing stage may appear.
  const harness = makeHarness(home)
  context = new Context()
  context.provide('agentPresets', {
    defaultId: 'standard',
    resolve: async () => { throw new Error('roster broken') },
  } as never)
  fiber = await mountRunner(context, home, harness, {}, { startupStatusOutput: statusOutput })
  assert.ok(orderedLog.some(write => write === 'stdout:\r\x1b[2KStarting DSH…'),
    `the Loader barrier status is shown once on this path too: ${JSON.stringify(orderedLog)}`)
  assert.ok(!orderedLog.some(write => write.includes('Resuming session') || write.includes('Preparing conversation')),
    `a fresh start with a failing preset must not show the resume/preparing stages: ${JSON.stringify(orderedLog)}`)
  // The TUI still mounts (degraded — the failure is a one-shot warn).
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must still create a TuiApp')
})

test('a stalled Host Loader keeps Starting DSH… on screen with no surface and no Agent', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-loader-barrier-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  // A controllable Host Loader: the readiness barrier parks here until the
  // test releases it, exactly like a remote MCP row whose initial connect or
  // `tools/list` never answers.
  let loaderAwaited = false
  let releaseLoader!: () => void
  const loaderGate = new Promise<void>(resolve => { releaseLoader = resolve })
  const loader = {
    await: async (): Promise<void> => {
      loaderAwaited = true
      await loaderGate
    },
  }
  const resumed: FakeSession = fakeSession({
    id: 'loader-barrier-session',
    header: { id: 'loader-barrier-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: resumed.id },
    { sessionId: resumed.id, startupStatusOutput: statusOutput },
    () => {},
    loader,
  )
  // The barrier is parked: the status owns the line and NOTHING downstream
  // of the barrier may have started.
  assert.equal(loaderAwaited, true, 'the runner must await the Host Loader before creating an Agent')
  assert.deepEqual(orderedLog, ['stdout:\r\x1b[2KStarting DSH…'],
    `Starting DSH… must be the only output while the Loader stalls: ${JSON.stringify(orderedLog)}`)
  assert.equal(probe.apps.length, 0, 'the TUI must not mount while the Loader is pending')
  assert.equal(harness.resumeSignals.length, 0, 'no Agent may be resumed while the Loader is pending')
  assert.equal(harness.createdSessions.length, 0, 'no Agent may be created while the Loader is pending')

  // The Loader settles: the line clears and the ordinary startup continues.
  releaseLoader()
  await settle()
  assert.equal(orderedLog[0], 'stdout:\r\x1b[2KStarting DSH…')
  assert.equal(orderedLog[1], 'stdout:\r\x1b[2K', 'the barrier line must clear as soon as the Loader settles')
  assert.equal(harness.resumeSignals.length, 1, 'the resume must proceed after the Loader settles')
  assert.equal(probe.apps.length, 1, 'the TUI must mount after the Loader settles')
})

test('an abort while the Host Loader is still pending clears the barrier status and never mounts', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-loader-abort-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  let releaseLoader!: () => void
  const loaderGate = new Promise<void>(resolve => { releaseLoader = resolve })
  const loader = { await: async (): Promise<void> => { await loaderGate } }
  const resumed: FakeSession = fakeSession({
    id: 'loader-abort-session',
    header: { id: 'loader-abort-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: resumed.id },
    { sessionId: resumed.id, startupStatusOutput: statusOutput },
    () => {},
    loader,
  )
  assert.deepEqual(orderedLog, ['stdout:\r\x1b[2KStarting DSH…'],
    `the barrier line must be the only output while the Loader stalls: ${JSON.stringify(orderedLog)}`)

  // Teardown while the barrier is parked (HMR unload / early exit): the
  // lifecycle abort must clear the pre-mount line so no stale status survives
  // into whatever owns the terminal next, and no Agent may be created.
  await disposeContext(context)
  context = undefined
  fiber = undefined
  assert.equal(orderedLog.at(-1), 'stdout:\r\x1b[2K',
    `the abort must clear the barrier status line: ${JSON.stringify(orderedLog)}`)

  // Release the parked barrier so the startup root observes the abort and
  // returns without mounting anything.
  releaseLoader()
  await settle()
  assert.equal(probe.apps.length, 0, 'an aborted startup must not mount a TUI')
  assert.equal(harness.resumeSignals.length, 0, 'an aborted startup must not resume an Agent')
  assert.equal(harness.createdSessions.length, 0, 'an aborted startup must not create an Agent')
})

test('a rejecting Host Loader clears the barrier status before the fatal log and never mounts', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-loader-reject-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  // Status writes and the cordis fatal log share ONE ordered log: a TTY shares
  // one cursor between stdout and stderr, so the order is the contract.
  const orderedLog: string[] = []
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'loader-reject-session',
    header: { id: 'loader-reject-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  const exporterFiber = context.plugin(pluginCtx => {
    pluginCtx.logger.exporter({
      levels: { default: 2 },
      export: message => {
        orderedLog.push(`log:${message.name}:${message.args.map(String).join(' ')}`)
      },
    })
  })
  await exporterFiber
  const exitCodes: number[] = []
  const appExit = (code?: number): void => { exitCodes.push(code ?? 0) }
  const loader = {
    await: async (): Promise<void> => { throw new Error('loader exploded') },
  }
  fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: resumed.id },
    { sessionId: resumed.id, startupStatusOutput: statusOutput },
    appExit,
    loader,
  )
  await settle()

  const shownIndex = orderedLog.findIndex(write => write === 'stdout:\r\x1b[2KStarting DSH…')
  const clearIndex = orderedLog.findIndex((write, index) => index > shownIndex && write === 'stdout:\r\x1b[2K')
  const logIndex = orderedLog.findIndex(write => write.startsWith('log:') && write.includes('tui-runner'))
  assert.ok(shownIndex >= 0, `the barrier status must be shown: ${JSON.stringify(orderedLog)}`)
  assert.ok(clearIndex > shownIndex,
    `a rejected Loader must still clear the barrier line: ${JSON.stringify(orderedLog)}`)
  assert.ok(logIndex > clearIndex,
    `the fatal log must be written only AFTER the barrier line is cleared: ${JSON.stringify(orderedLog)}`)
  assert.equal(probe.apps.length, 0, 'a fatal loader rejection must not mount a TUI')
  assert.equal(harness.resumeSignals.length, 0, 'the resume must never start after a rejected Loader')
  assert.equal(harness.createdSessions.length, 0, 'no Agent may be created after a rejected Loader')
  assert.deepEqual(exitCodes, [1], 'the fatal startup path must exit(1)')
})

test('a throwing status clear cannot block the fatal teardown or exit(1)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-loader-reject-throw-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  // The status output seam throws on the ERASE-LINE write only, so the barrier
  // reports its wait and then its release fails — the failure the fatal root
  // must contain.
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
      if (text === '\r\x1b[2K') throw new Error('status stream exploded')
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'loader-reject-throw-session',
    header: { id: 'loader-reject-throw-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  const exporterFiber = context.plugin(pluginCtx => {
    pluginCtx.logger.exporter({
      levels: { default: 2 },
      export: message => {
        orderedLog.push(`log:${message.name}:${message.args.map(String).join(' ')}`)
      },
    })
  })
  await exporterFiber
  // The discarded startup chain is a terminal boundary: a rejection escaping it
  // would surface here as an unhandled rejection (and skip exit(1)).
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  life.defer(() => { process.off('unhandledRejection', onUnhandled) })
  const exitCodes: number[] = []
  const appExit = (code?: number): void => { exitCodes.push(code ?? 0) }
  const loader = {
    await: async (): Promise<void> => { throw new Error('loader exploded') },
  }
  fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: resumed.id },
    { sessionId: resumed.id, startupStatusOutput: statusOutput },
    appExit,
    loader,
  )
  await settle()

  assert.ok(orderedLog.some(write => write === 'stdout:\r\x1b[2KStarting DSH…'),
    `the barrier status must still be shown: ${JSON.stringify(orderedLog)}`)
  assert.ok(orderedLog.some(write => write.startsWith('log:') && write.includes('tui-runner')),
    `the fatal log must still be written despite the throwing clear: ${JSON.stringify(orderedLog)}`)
  assert.deepEqual(exitCodes, [1], 'the fatal path must still reach exit(1)')
  assert.deepEqual(unhandled, [], 'the discarded startup chain must not leak a rejection')
  assert.equal(probe.apps.length, 0, 'no TUI may mount')
  assert.equal(harness.resumeSignals.length, 0, 'no Agent may be resumed')
})

test('a transiently failing status erase is retried before the fatal log', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-loader-reject-retry-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  let eraseAttempts = 0
  // The FIRST erase fails (the barrier's own clear); the retry — the fatal
  // root's clear — must actually land BEFORE the log line is written.
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
      if (text === '\r\x1b[2K' && (eraseAttempts += 1) === 1) throw new Error('erase exploded once')
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'loader-reject-retry-session',
    header: { id: 'loader-reject-retry-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  const exporterFiber = context.plugin(pluginCtx => {
    pluginCtx.logger.exporter({
      levels: { default: 2 },
      export: message => {
        orderedLog.push(`log:${message.name}:${message.args.map(String).join(' ')}`)
      },
    })
  })
  await exporterFiber
  const exitCodes: number[] = []
  const appExit = (code?: number): void => { exitCodes.push(code ?? 0) }
  const loader = {
    await: async (): Promise<void> => { throw new Error('loader exploded') },
  }
  fiber = await mountRunner(
    context,
    home,
    harness,
    { sessionId: resumed.id },
    { sessionId: resumed.id, startupStatusOutput: statusOutput },
    appExit,
    loader,
  )
  await settle()

  const logIndex = orderedLog.findIndex(write => write.startsWith('log:') && write.includes('tui-runner'))
  const lastEraseIndex = orderedLog.map((write, index) => write === 'stdout:\r\x1b[2K' ? index : -1).filter(index => index >= 0).at(-1)
  assert.equal(eraseAttempts, 2, `the failed erase must be retried: ${JSON.stringify(orderedLog)}`)
  assert.ok(logIndex >= 0, `the fatal log must still be written: ${JSON.stringify(orderedLog)}`)
  assert.ok(lastEraseIndex !== undefined && lastEraseIndex < logIndex,
    `the retried erase must land BEFORE the fatal log: ${JSON.stringify(orderedLog)}`)
  assert.deepEqual(exitCodes, [1], 'the fatal path must still reach exit(1)')
  assert.equal(probe.apps.length, 0, 'no TUI may mount')
})

test('a one-off erase failure on the resume-failure path is retried before the warning', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-resume-fail-retry-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  let resumingStage = false
  let resumeEraseAttempts = 0
  let injected = false
  // Fail the FIRST erase of the resume stage only. That clear is immediately
  // followed by `ctx.logger.warn`/`diag.error`, so the retry must land inside
  // the clear and therefore BEFORE the warning.
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
      if (text.includes('Resuming session')) resumingStage = true
      if (resumingStage && text === '\r\x1b[2K') {
        resumeEraseAttempts += 1
        if (!injected) {
          injected = true
          throw new Error('erase exploded once')
        }
      }
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const failed: FakeSession = fakeSession({
    id: 'resume-fail-retry-session',
    header: { id: 'resume-fail-retry-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('failed resume history'),
  })
  const harness = makeHarness(
    home,
    failed,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    new Error('boom'),
  )
  context = new Context()
  const exporterFiber = context.plugin(pluginCtx => {
    pluginCtx.logger.exporter({
      levels: { default: 2 },
      export: message => {
        orderedLog.push(`log:${message.name}:${message.args.map(String).join(' ')}`)
      },
    })
  })
  await exporterFiber
  fiber = await mountRunner(context, home, harness, { sessionId: failed.id }, { sessionId: failed.id, startupStatusOutput: statusOutput })
  await settle()

  const warnIndex = orderedLog.findIndex(write => write.startsWith('log:') && write.includes('resume') && write.includes('failed'))
  const landedEraseIndex = orderedLog
    .map((write, index) => write === 'stdout:\r\x1b[2K' ? index : -1)
    .filter(index => index >= 0)
    .at(-1)
  assert.equal(resumeEraseAttempts, 2, `the failed resume-stage erase must be retried: ${JSON.stringify(orderedLog)}`)
  assert.ok(warnIndex >= 0, `the resume failure must still be logged: ${JSON.stringify(orderedLog)}`)
  assert.ok(landedEraseIndex !== undefined && landedEraseIndex < warnIndex,
    `the retried erase must land BEFORE the resume-failure warning: ${JSON.stringify(orderedLog)}`)
})

test('a fresh-start preset failure never re-touches the status row the barrier released', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-preset-fail-row-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  const orderedLog: string[] = []
  const statusWrites: string[] = []
  // Every write is recorded; an erase would be visible here. The point of the
  // test is that the failure paths emit NONE.
  const statusOutput = {
    isTTY: true,
    write: (text: string) => {
      orderedLog.push(`stdout:${text}`)
      statusWrites.push(text)
    },
  }
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  // Deferred start (no sessionId) with a BROKEN agentPresets roster: the
  // preset-resolution failure and the cold catalog read both take their
  // failure branch. Measured: `Preparing conversation…` is never shown on this
  // path, and the Loader barrier's `finally` already released the row, so every
  // later `clear()` is a `!shown` no-op — it must not emit an erase that could
  // damage the failure log's line.
  const harness = makeHarness(home)
  context = new Context()
  context.provide('agentPresets', {
    defaultId: 'standard',
    resolve: async () => { throw new Error('roster broken') },
  } as never)
  fiber = await mountRunner(context, home, harness, {}, { startupStatusOutput: statusOutput })
  await settle()
  assert.ok(probe.apps.at(-1), 'a degraded-but-mounted surface is expected on this path')
  assert.deepEqual(statusWrites, ['\r\x1b[2KStarting DSH…', '\r\x1b[2K'],
    `the barrier owns the row and the failure paths must not touch it: ${JSON.stringify(orderedLog)}`)
})

test('the exit resume hint names the Host profileContext profile, not the argv fallback', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-resume-profile-hint-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'resume-profile-hint-session',
    header: { id: 'resume-profile-hint-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  // The Host profile service a profile boot always publishes. Its name is the
  // ONLY source that is correct under every launch form: the positional
  // `dsh <name>` never appears as `--profile` in process.argv, so the argv
  // scrape answers the pi-tui fallback and would name the wrong profile.
  context.provide('profileContext', { name: 'tui-custom', home })
  // The hint has no injected output seam (unlike the startup status), so it is
  // captured through a pass-through stdout wrapper: every write still reaches
  // the test reporter, and only the resume-command line is recorded.
  const hintWrites: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = function (this: unknown, chunk: unknown, ...rest: unknown[]): boolean {
    const text = String(chunk)
    if (text.includes('dsh --profile')) hintWrites.push(text)
    return (originalWrite as unknown as (chunk: unknown, ...rest: unknown[]) => boolean).call(process.stdout, chunk, ...rest)
  } as typeof process.stdout.write
  life.defer(() => { process.stdout.write = originalWrite })
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  app.setDraft('exit')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  const hint = hintWrites.join('')
  assert.ok(hint.includes('dsh --profile tui-custom --session resume-profile-hint-session'),
    `the hint must name the Host profile: ${JSON.stringify(hintWrites)}`)
  assert.ok(!hint.includes('--profile pi-tui '),
    `the hint must not fall back to the argv default: ${JSON.stringify(hintWrites)}`)
})

test('an invalid --preset on a healthy resumed session never degrades the resume', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-resume-invalid-preset-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'resume-invalid-preset',
    header: { id: 'resume-invalid-preset', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed)
  context = new Context()
  context.provide('agentPresets', {
    defaultId: 'standard',
    resolve: async (id?: string) => {
      if (id === 'broken') throw new Error('agent-presets: preset "broken" not found (available: standard)')
      return { id: id ?? 'standard', trust: 'system' }
    },
    // The composition the resumed Agent mounts on (the recorded/default preset).
    mount: async () => {},
    recompose: async () => ({ id: 'standard' }),
    composedPreset: () => undefined,
    // The started resumed session refuses the launch override.
    select: async () => { throw Object.assign(new Error('session has already started; its agent preset is fixed'), { code: 'agent-preset/locked' }) },
  } as never)
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id, presetId: 'broken' }, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the healthy resume must still mount')
  assert.ok(!probe.notices.some(notice => notice.includes('unavailable; started with the default')),
    `an invalid --preset must not degrade a healthy resume: ${JSON.stringify(probe.notices)}`)
  assert.ok(!probe.notices.some(notice => notice.includes('not applied on resume')),
    `the started-session locked override is expected, not a degradation notice: ${JSON.stringify(probe.notices)}`)
})

// --- Direct owned-session retirement (exit / HMR / transition) ---

/** A subagents fake recording drainContinuableDescendants calls. */
function retirementSubagents(events: string[]): { drainContinuableDescendants: (parents: readonly unknown[]) => Promise<void> } {
  return {
    drainContinuableDescendants: async (parents: readonly unknown[]) => {
      const parent = parents[0] as { session: { id: string } } | undefined
      events.push(`drain:${parent?.session.id ?? '?'}`)
    },
  }
}

test('fiber unload retires the Direct owned session: cancel → idle → drain → flush → dispose (HMR path)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-hmr-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-hmr-session',
    header: { id: 'retire-hmr-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, (events: string[]) => ({
    drainContinuableDescendants: async () => {
      events.push(`drain:${resumed.id}`)
      // Direct retirement can emit one final session event after the surface
      // has been disposed but before the Cordis listener is detached. The
      // runner must ignore it rather than applying it to dead folders/app.
      context!.emit('session/event', resumed as never, event('turn/start', { turn: 99 }, 99))
      context!.emit('llm/adapters-updated')
      context!.emit('settings/document-updated', 'llm-pi-ai' as never, 99 as never)
    },
  }))
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const transcriptAppliesBeforeRetirement = probe.transcriptApplyCount
  const statsAppliesBeforeRetirement = probe.statsApplyCount
  const welcomeCardsBeforeRetirement = probe.capturedWelcomeModels.length
  // HMR unload: dispose the runner fiber directly (no interactive exit).
  await fiber.dispose()
  fiber = undefined
  assert.equal(probe.transcriptApplyCount, transcriptAppliesBeforeRetirement,
    'a retirement-time session event must not apply to the disposed transcript')
  assert.equal(probe.statsApplyCount, statsAppliesBeforeRetirement,
    'a retirement-time session event must not apply to the disposed stats folder')
  assert.equal(probe.capturedWelcomeModels.length, welcomeCardsBeforeRetirement,
    'retirement-time provider/settings events must not repaint the disposed welcome card')
  // The retirement order is the fixed Direct order; the drain of the
  // continuable descendants happens BEFORE the parent handle dispose.
  const events = harness.retirementEvents
  const cancel = events.filter(event => event === 'cancel:retire-hmr-session')
  const idle = events.filter(event => event === 'idle:retire-hmr-session')
  const drain = events.filter(event => event === 'drain:retire-hmr-session')
  const flush = events.filter(event => event === 'flush:retire-hmr-session')
  const dispose = events.filter(event => event === 'dispose:retire-hmr-session')
  assert.equal(cancel.length, 1, 'the owned agent must be cancelled exactly once')
  assert.equal(drain.length, 1, 'drainContinuableDescendants must be called exactly once')
  assert.equal(dispose.length, 1, 'the owned handle must be disposed exactly once')
  assert.ok(events.indexOf('drain:retire-hmr-session') < events.indexOf('dispose:retire-hmr-session'),
    'descendant drain must complete before the parent handle dispose')
  assert.ok(events.indexOf('flush:retire-hmr-session') < events.indexOf('dispose:retire-hmr-session'),
    'the final flush must complete before the parent handle dispose')
  assert.ok(events.indexOf('cancel:retire-hmr-session') < events.indexOf('drain:retire-hmr-session'),
    'cancel must precede the descendant drain')
  assert.ok(idle.length >= 1, 'whenIdle must be awaited during retirement')
  assert.ok(flush.length >= 1, 'the final flush must run during retirement')
})

test('deferred-start exit retires nothing and disposes the surface only', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-deferred-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  // Deferred start: no session, no agent, no handle.
  const harness = makeHarness(home)
  context = new Context()
  fiber = await mountRunner(context, home, harness, {}, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  await fiber.dispose()
  fiber = undefined
  assert.deepEqual(harness.retirementEvents, [],
    'a sessionless exit must not cancel/drain/flush/dispose anything')
})

test('a successful /new retires the OLD owner post-commit (cancel → idle → drain → flush → dispose)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-switch-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-switch-old',
    header: { id: 'retire-switch-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  await newHandler()
  await settle()
  // The OLD owner was retired post-commit: cancel + drain + dispose exactly
  // once each, and the drain happened before the old handle dispose.
  const events = harness.retirementEvents
  const oldCancel = events.filter(event => event === 'cancel:retire-switch-old')
  const oldDrain = events.filter(event => event === 'drain:retire-switch-old')
  const oldDispose = events.filter(event => event === 'dispose:retire-switch-old')
  assert.equal(oldCancel.length, 1, 'the old agent must be cancelled exactly once post-commit')
  assert.equal(oldDrain.length, 1, 'the old continuable descendants must be drained exactly once post-commit')
  assert.equal(oldDispose.length, 1, 'the old handle must be disposed exactly once post-commit')
  assert.ok(events.indexOf('drain:retire-switch-old') < events.indexOf('dispose:retire-switch-old'),
    'the old descendant drain must precede the old handle dispose')
  // The child stays current: the surface still owns the NEW session.
  const created = harness.createdSessions.at(-1)
  assert.ok(created, '/new must create a child session')
  assert.notEqual(created.id, 'retire-switch-old')
  // A later teardown retires the NEW owner exactly once (the old owner is
  // not retired again — the memoized retirement is per-owner).
  await fiber.dispose()
  fiber = undefined
  const newDispose = events.filter(event => event === `dispose:${created.id}`)
  assert.equal(newDispose.length, 1, 'the new current owner must be retired on teardown')
  assert.equal(oldDispose.length, 1, 'the old owner must never be retired twice')
})

test('a failed child create does NOT drain or dispose the current old owner', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-create-fail-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-create-fail-old',
    header: { id: 'retire-create-fail-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  // The child create throws: the transition must abort with ZERO old-owner
  // side effects (no drain, no dispose — the old session stays current).
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, async () => { throw new Error('create failed') }, retirementSubagents)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  await newHandler()
  await settle()
  const events = harness.retirementEvents
  assert.ok(!events.some(event => event === 'drain:retire-create-fail-old'),
    'a failed child create must never drain the old owner descendants')
  assert.ok(!events.some(event => event === 'dispose:retire-create-fail-old'),
    'a failed child create must never dispose the old owner handle')
  assert.equal(harness.createdSessions.length, 0, 'a failed create must not publish a child')
  // The old session is still current: teardown retires it exactly once.
  await fiber.dispose()
  fiber = undefined
  assert.equal(events.filter(event => event === 'dispose:retire-create-fail-old').length, 1,
    'the still-current old owner must be retired on teardown')
})

test('exit during an in-flight transition does not deadlock and retires the current owner exactly once', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-during-switch-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-during-switch-old',
    header: { id: 'retire-during-switch-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents)
  // The child create awaits the lifecycle signal: an exit during the
  // transition aborts it (the unsafe late commit is prevented).
  let createStarted!: () => void
  const createStartedPromise = new Promise<void>(resolve => { createStarted = resolve })
  const agents = harness.agents as {
    create: (options: { sessionId: unknown; signal?: AbortSignal }) => Promise<never>
  }
  agents.create = async ({ signal }) => {
    createStarted()
    if (signal === undefined) throw new Error('test create did not receive a lifecycle signal')
    if (signal.aborted) throw new Error('create cancelled')
    return await new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('create cancelled')), { once: true })
    })
  }
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await createStartedPromise
  // Exit while the child create is still awaiting: the fiber disposer must
  // not deadlock on the transition gate (the abort settles the create).
  await fiber.dispose()
  fiber = undefined
  await transition
  const events = harness.retirementEvents
  const oldDispose = events.filter(event => event === 'dispose:retire-during-switch-old')
  assert.equal(oldDispose.length, 1, 'the still-current old owner must be retired exactly once')
  assert.equal(harness.createdSessions.length, 0, 'the aborted create must not publish a child')
})

test('a late non-cooperative child create skips disposed-surface commit work and is retired', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-late-commit-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-late-commit-old',
    header: { id: 'retire-late-commit-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  let releaseCreate!: () => void
  const createRelease = new Promise<void>(resolve => { releaseCreate = resolve })
  let createStarted!: () => void
  const createStartedPromise = new Promise<void>(resolve => { createStarted = resolve })
  const harness = makeHarness(
    home,
    resumed,
    { provider: 'p', model: 'm' },
    undefined,
    async () => {
      createStarted()
      await createRelease
    },
    retirementSubagents,
  )
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const welcomeCardsBeforeDispose = probe.capturedWelcomeModels.length
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await createStartedPromise

  // The fake Direct create deliberately ignores lifecycle cancellation. The
  // fiber disposer still runs surface cleanup first, then waits behind the
  // transition gate for the child owner to settle.
  const disposal = fiber.dispose()
  try {
    await settle()
    assert.equal(app.isDisposed(), true, 'surface disposal must finish before the late child resolves')
    releaseCreate()
    await transition
    await disposal
    fiber = undefined
  } finally {
    releaseCreate()
  }

  assert.equal(probe.capturedWelcomeModels.length, welcomeCardsBeforeDispose,
    'a late transition commit must not repaint the disposed welcome card')
  const child = harness.createdSessions.at(-1)
  assert.ok(child, 'the non-cooperative create still produces a child owner')
  const events = harness.retirementEvents
  assert.equal(events.filter(event => event === 'dispose:retire-late-commit-old').length, 1,
    'the old owner must be retired exactly once')
  assert.equal(events.filter(event => event === `dispose:${child.id}`).length, 1,
    'the late committed child owner must be retired exactly once')
})

test('an interactive exit during a non-cooperative transition create cancels each owner exactly once', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-late-commit-exit-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-late-commit-exit-old',
    header: { id: 'retire-late-commit-exit-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  // The fake Direct create deliberately ignores lifecycle cancellation: it
  // resolves only when the test releases it, AFTER the interactive exit has
  // already started the appExit root teardown.
  let releaseCreate!: () => void
  const createRelease = new Promise<void>(resolve => { releaseCreate = resolve })
  let createStarted!: () => void
  const createStartedPromise = new Promise<void>(resolve => { createStarted = resolve })
  const harness = makeHarness(
    home,
    resumed,
    { provider: 'p', model: 'm' },
    undefined,
    async () => {
      createStarted()
      await createRelease
    },
    retirementSubagents,
  )
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id }, () => {
    harness.retirementEvents.push('appExit')
    // The launcher's appExit disposes the application tree: the runner fiber
    // disposer joins the memoized retirement.
    void fiber?.dispose()
  })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await createStartedPromise

  // Interactive exit while the create is pending: the exit preparation cancels
  // the CURRENT owner synchronously, before appExit starts the root teardown.
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  app.setDraft('exit')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  const beforeRelease = harness.retirementEvents
  assert.equal(beforeRelease.filter(event => event === 'cancel:retire-late-commit-exit-old').length, 1,
    `the interactive exit must pre-cancel the current owner exactly once: ${JSON.stringify(beforeRelease)}`)
  assert.ok(beforeRelease.indexOf('cancel:retire-late-commit-exit-old') < beforeRelease.indexOf('appExit'),
    `the pre-cancel must land before appExit: ${JSON.stringify(beforeRelease)}`)

  // The non-cooperative create now commits its child after appExit began: the
  // transition's own post-commit retirement must NOT cancel the old owner a
  // second time (that second cancel is the one that can land after the inbox
  // projection was unregistered).
  releaseCreate()
  await settle()
  await transition
  const events = harness.retirementEvents
  const child = harness.createdSessions.at(-1)
  assert.ok(child, 'the non-cooperative create still produces a child owner')
  assert.equal(events.filter(event => event === 'cancel:retire-late-commit-exit-old').length, 1,
    `the replaced owner must not be cancelled again after the root teardown began: ${JSON.stringify(events)}`)
  assert.equal(events.filter(event => event === `cancel:${child.id}`).length, 1,
    `the committed NEW owner must be cancelled exactly once by the retirement: ${JSON.stringify(events)}`)
  assert.equal(events.filter(event => event === 'dispose:retire-late-commit-exit-old').length, 1,
    'the replaced owner must be retired exactly once')
  assert.equal(events.filter(event => event === `dispose:${child.id}`).length, 1,
    'the late committed child owner must be retired exactly once')
})

test('a throwing shutdown cancel inside the abort listener is contained and retried, never an uncaught exception', async (t) => {
  const life = testLifecycle(t)
  /** One full shutdown run for the value thrown on the first cancel. */
  const scenario = async (label: string, thrown: unknown) => {
    const home = life.tempDir(`dsh-pi-tui-retire-abort-throw-${label}-`)
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    life.defer(() => {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    })
    const probe = installProbe()
    life.defer(probe.restore)
    let context: Context | undefined
    let fiber: { dispose: () => Promise<unknown> } | undefined
    life.defer(() => { if (context !== undefined) return disposeContext(context) })
    life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
    const sessionId = `retire-abort-throw-${label}-old`
    const resumed: FakeSession = fakeSession({
      id: sessionId,
      header: { id: sessionId, cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: sessionEvents('old answer'),
    })
    // The FIRST whenIdle (startup resume) settles; the SECOND (the /new
    // pre-commit quiesce) hangs, so the transition parks in `whenIdleOrAbort`
    // with its lifecycle-abort listener armed.
    let idleCalls = 0
    const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents, async () => {
      idleCalls += 1
      if (idleCalls > 1) await new Promise<void>(() => {})
    })
    context = new Context()
    fiber = await mountRunner(context, home, harness, { sessionId }, { sessionId })
    const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
    assert.ok(newHandler, 'the real runner must register the /new transition command')
    const transition = newHandler()
    await settle()
    assert.equal(idleCalls, 2, 'the /new pre-commit quiesce must be awaiting the stuck whenIdle')

    // The FIRST shutdown cancel throws — exactly the
    // `cannot read inbox state: its projection registration is not active`
    // failure the hardening exists for. An AbortSignal listener is a Node
    // EventTarget: an escaping throw would become an uncaughtException that no
    // `try { disposeSurface() } catch` can see.
    const liveAgent = (harness.agents as { get(id: string): { cancel(): void } | undefined }).get(sessionId)
    assert.ok(liveAgent, 'the resumed session must have a live Agent')
    const originalCancel = liveAgent.cancel.bind(liveAgent)
    let cancelAttempts = 0
    liveAgent.cancel = () => {
      cancelAttempts += 1
      if (cancelAttempts === 1) throw thrown
      originalCancel()
    }
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => { uncaught.push(error) }
    process.on('uncaughtException', onUncaught)
    life.defer(() => { process.off('uncaughtException', onUncaught) })

    await fiber.dispose()
    fiber = undefined
    await transition
    await settle()
    return { sessionId, uncaught, cancelAttempts, events: harness.retirementEvents }
  }

  // A plain Error AND a non-Error value whose coercion itself throws: the
  // listener must not format the value at all, because ANY formatting step
  // (`String(value)`, an unprotected `instanceof`, a `.message` read) can throw
  // for the hostile value and would then escape as an uncaughtException.
  const hostile: unknown = Object.create(null)
  for (const [label, thrown] of [
    ['error', new Error('cancel exploded before the projection was torn down')],
    ['hostile', hostile],
  ] as const) {
    const { sessionId, uncaught, cancelAttempts, events } = await scenario(label, thrown)
    assert.deepEqual(uncaught, [], `a ${label} shutdown cancel must never escape the abort listener`)
    assert.equal(cancelAttempts, 2, `the failed ${label} cancel must be retried by the retirement cancel phase`)
    assert.equal(events.filter(event => event === `cancel:${sessionId}`).length, 1,
      `only the successful ${label} retry cancels the fake agent`)
    assert.equal(events.filter(event => event === `dispose:${sessionId}`).length, 1,
      `the ${label} owner must still be disposed exactly once`)
  }
})

test('an interactive exit retires the owned session through the appExit disposal', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-interactive-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-interactive-session',
    header: { id: 'retire-interactive-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents)
  let exitCalls = 0
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id }, () => {
    exitCalls += 1
    // Recorded in the SAME event log as the retirement phases so the test can
    // assert that the first cancel lands BEFORE the root teardown starts.
    harness.retirementEvents.push('appExit')
    // The launcher's appExit disposes the application tree: the runner
    // fiber disposer runs the Direct owned-session retirement.
    void fiber?.dispose()
  })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  // Interactive exit: submit the plain `exit` prompt (shell muscle memory).
  app.setDraft('exit')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  assert.equal(exitCalls, 1, 'the interactive exit must request appExit exactly once')
  const events = harness.retirementEvents
  assert.equal(events.filter(event => event === 'cancel:retire-interactive-session').length, 1,
    'the interactive exit must cancel the owned agent exactly once (pre-cancel and the retirement cancel phase are the same Agent)')
  assert.equal(events.filter(event => event === 'drain:retire-interactive-session').length, 1,
    'the interactive exit must drain the continuable descendants')
  assert.equal(events.filter(event => event === 'dispose:retire-interactive-session').length, 1,
    'the interactive exit must dispose the owned handle')
  // The hardening contract: the FIRST cancel is synchronous shutdown
  // preparation and must precede appExit, because the root teardown
  // unregisters the inbox projection the later cancel depends on. Only the
  // cancel comes forward — idle/drain/flush/dispose stay inside the
  // appExit-bounded disposal.
  const cancelIndex = events.indexOf('cancel:retire-interactive-session')
  const appExitIndex = events.indexOf('appExit')
  assert.ok(cancelIndex >= 0 && appExitIndex >= 0 && cancelIndex < appExitIndex,
    `the pre-cancel must land before appExit (cancel at ${cancelIndex}, appExit at ${appExitIndex}): ${JSON.stringify(events)}`)
  assert.ok(events.indexOf('drain:retire-interactive-session') > appExitIndex,
    'the descendant drain must stay inside the appExit disposal')
  assert.ok(events.indexOf('dispose:retire-interactive-session') > events.indexOf('drain:retire-interactive-session'),
    'the descendant drain must precede the parent handle dispose on the interactive path too')
})

test('a FAILING pre-cancel is not recorded as done: appExit still runs and the retirement retries the cancel', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-precancel-failure-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-precancel-failure-session',
    header: { id: 'retire-precancel-failure-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents)
  let exitCalls = 0
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id }, () => {
    exitCalls += 1
    harness.retirementEvents.push('appExit')
    void fiber?.dispose()
  })
  // The FIRST cancel throws (exactly the projection-already-unregistered
  // failure this hardening exists for); the retirement's own cancel phase
  // must retry it rather than treating the failed preparation as done.
  const liveAgent = (harness.agents as { get(id: string): { cancel(): void } | undefined }).get(resumed.id)
  assert.ok(liveAgent, 'the resumed session must have a live Agent')
  const originalCancel = liveAgent.cancel.bind(liveAgent)
  let cancelAttempts = 0
  liveAgent.cancel = () => {
    cancelAttempts += 1
    if (cancelAttempts === 1) throw new Error('cancel exploded before the projection was torn down')
    originalCancel()
  }
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  app.setDraft('exit')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  assert.equal(exitCalls, 1, 'a failing preparation must never block appExit')
  assert.equal(cancelAttempts, 2, 'the failed pre-cancel must be retried by the retirement cancel phase')
  const events = harness.retirementEvents
  assert.equal(events.filter(event => event === 'cancel:retire-precancel-failure-session').length, 1,
    'only the successful retry cancels the fake agent')
  assert.equal(events.filter(event => event === 'dispose:retire-precancel-failure-session').length, 1,
    'the retirement must still dispose the owner exactly once')
  assert.ok(events.indexOf('appExit') >= 0, 'appExit must have been requested')
})

test('exit after a transition COMMITTED retires the NEW current owner, never the old twice', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-after-commit-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-after-commit-old',
    header: { id: 'retire-after-commit-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  // The child create is gated: the transition commits only after the gate
  // releases, so the test can exit in the post-commit window.
  let releaseCreate!: () => void
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, () => createGate, retirementSubagents)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await settle()
  // The child create completes and the transition commits.
  releaseCreate()
  await settle()
  // Exit in the post-commit window: the retirement must target the NEW
  // current owner (the old owner was already retired post-commit).
  await fiber.dispose()
  fiber = undefined
  await transition
  const events = harness.retirementEvents
  const created = harness.createdSessions.at(-1)
  assert.ok(created, '/new must create a child session')
  const oldDisposes = events.filter(event => event === 'dispose:retire-after-commit-old')
  const newDisposes = events.filter(event => event === `dispose:${created.id}`)
  assert.equal(oldDisposes.length, 1, 'the old owner must be retired exactly once (post-commit)')
  assert.equal(newDisposes.length, 1, 'the NEW current owner must be the shutdown target')
  assert.ok(events.indexOf(`dispose:${created.id}`) > events.indexOf('dispose:retire-after-commit-old'),
    'the new owner retirement must follow the old owner retirement')
})

test('exit during a transition stuck in pre-commit whenIdle: the pre-cancel unblocks it and the old owner is retired', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-whenidle-stuck-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-whenidle-stuck-old',
    header: { id: 'retire-whenidle-stuck-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  // The FIRST whenIdle (startup resume) settles; the SECOND (the /new
  // pre-commit quiesce) hangs — the old agent is "busy" and its whenIdle
  // does not observe the lifecycle signal, exactly like a real LLM turn.
  let idleCalls = 0
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents, async () => {
    idleCalls += 1
    if (idleCalls >= 2) {
      await new Promise<void>(() => {})
    }
  })
  // The child create observes the lifecycle signal: the exit aborts it.
  const agents = harness.agents as {
    create: (options: { sessionId: unknown; signal?: AbortSignal }) => Promise<never>
  }
  agents.create = async ({ signal }) => {
    if (signal === undefined) throw new Error('test create did not receive a lifecycle signal')
    if (signal.aborted) throw new Error('create cancelled')
    return await new Promise<never>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('create cancelled')), { once: true })
    })
  }
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await settle()
  assert.equal(idleCalls, 2, 'the /new pre-commit quiesce must be awaiting the stuck whenIdle')
  // Exit while the transition is stuck in its pre-commit quiesce: the
  // retirement pre-cancel must unblock the whenIdle (no deadlock), the
  // aborted create must fail the transition, and the still-current old
  // owner must be retired.
  await fiber.dispose()
  fiber = undefined
  await transition
  const events = harness.retirementEvents
  assert.equal(events.filter(event => event === 'dispose:retire-whenidle-stuck-old').length, 1,
    'the still-current old owner must be retired exactly once')
  assert.equal(events.filter(event => event === 'cancel:retire-whenidle-stuck-old').length, 1,
    'the old owner must be cancelled EXACTLY once: the lifecycle-abort cancel and the shutdown pre-cancel are the same cancel')
  assert.equal(harness.createdSessions.length, 0, 'the aborted create must not publish a child')
})

test('a pre-mount unload while the resume whenIdle is pending cancels the agent and retires the owner', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-premount-whenidle-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  const resumed: FakeSession = fakeSession({
    id: 'premount-whenidle-session',
    header: { id: 'premount-whenidle-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  // The resume whenIdle hangs (a busy agent): the pre-mount wait must be
  // broken by the lifecycle abort, not left hanging forever.
  let whenIdleStarted!: () => void
  const whenIdleStartedPromise = new Promise<void>(resolve => { whenIdleStarted = resolve })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents, async () => {
    whenIdleStarted()
    await new Promise<void>(() => {})
  })
  context = new Context()
  // Provide the same host services as mountRunner, but do NOT await the
  // startup settle: the IIFE is stuck in the pre-mount whenIdle. The early
  // lifecycle-cancellation effect is registered before the resume, so
  // disposing the context aborts the signal.
  context.provide('appExit', () => {})
  context.provide(TUI_STARTUP_SERVICE, { sessionId: resumed.id, shippedPresetRoot: home })
  context.provide('sessionPersistence', harness.persistence as never)
  context.provide('sessionQuery', harness.sessionQuery as never)
  context.provide('agents', harness.agents as never)
  context.provide('sessions', harness.sessions as never)
  context.provide('agentDefaultModel', harness.defaultModel as never)
  context.provide('llm', harness.llm as never)
  context.provide('commands', harness.commands as never)
  context.provide('subagents', harness.subagents as never)
  context.provide('loader', { await: async () => {} } as never)
  const fiber = context.plugin((pluginCtx) => applyRunner(pluginCtx, TuiConfigSchema({ sessionId: resumed.id } as never)))
  await fiber
  await whenIdleStartedPromise
  await disposeContext(context)
  context = undefined
  await settle()
  const events = harness.retirementEvents
  assert.ok(events.some(event => event === 'cancel:premount-whenidle-session'),
    'the abort must cancel the agent so the pre-mount whenIdle settles')
  assert.equal(events.filter(event => event === 'dispose:premount-whenidle-session').length, 1,
    'the just-created owner must be retired exactly once')
  assert.equal(probe.apps.length, 0, 'the cancelled startup must not mount a TUI')
})

test('exit with TWO queued transitions: the second quiesce is abort-aware and the current owner is retired', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-two-queued-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-two-queued-old',
    header: { id: 'retire-two-queued-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  // The FIRST /new create is gated; the SECOND /new queues behind it. The
  // second transition's quiesce targets the FIRST transition's committed
  // child, whose whenIdle hangs (busy) — the exit must cancel it.
  let releaseCreateA!: () => void
  const createGateA = new Promise<void>(resolve => { releaseCreateA = resolve })
  let createCalls = 0
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, async () => {
    createCalls += 1
    if (createCalls === 1) await createGateA
  }, retirementSubagents, async (sessionId) => {
    // The FIRST child (committed by the first /new) is busy: its whenIdle
    // hangs in BOTH the first transition's post-commit child quiesce and
    // the second transition's pre-commit quiesce.
    if (sessionId !== 'retire-two-queued-old') {
      await new Promise<void>(() => {})
    }
  })
  // The SECOND create observes the lifecycle signal: the exit aborts it.
  const agents = harness.agents as {
    create: (options: { sessionId: unknown; signal?: AbortSignal }) => Promise<never>
  }
  const originalCreate = agents.create as (options: { sessionId: unknown; signal?: AbortSignal }) => Promise<never>
  agents.create = async (options) => {
    createCalls += 1
    if (createCalls === 1) {
      await createGateA
      return originalCreate(options)
    }
    if (options.signal === undefined) throw new Error('test create did not receive a lifecycle signal')
    if (options.signal.aborted) throw new Error('create cancelled')
    return await new Promise<never>((_, reject) => {
      options.signal!.addEventListener('abort', () => reject(new Error('create cancelled')), { once: true })
    })
  }
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const first = newHandler()
  const second = newHandler()
  await settle()
  releaseCreateA()
  await settle()
  // Exit: the pre-cancel (and the abort-aware quiesce) must unblock the
  // first transition's post-commit child quiesce AND the second
  // transition's pre-commit quiesce, the aborted create must fail the
  // second transition, and the current owner must be retired.
  await fiber.dispose()
  fiber = undefined
  await first
  await second
  const events = harness.retirementEvents
  const created = harness.createdSessions.at(-1)
  assert.ok(created, 'the first /new must create a child')
  assert.equal(events.filter(event => event === 'dispose:retire-two-queued-old').length, 1,
    'the original owner must be retired exactly once (first transition post-commit)')
  assert.equal(events.filter(event => event === `dispose:${created.id}`).length, 1,
    'the still-current first child must be retired exactly once (teardown)')
  assert.equal(events.filter(event => event === `cancel:${created.id}`).length, 1,
    'the first child must be cancelled EXACTLY once (abort-aware quiesce and retirement share one cancel)')
})

test('exit during the post-commit child quiesce skips surface init and retires the committed child', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-child-idle-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'exit-after-commit-old',
    header: { id: 'exit-after-commit-old', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('old answer'),
  })
  let releaseCreate!: () => void
  const createGate = new Promise<void>(resolve => { releaseCreate = resolve })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, () => createGate, retirementSubagents, async (sessionId) => {
    // The committed child is busy: its post-commit quiesce hangs.
    if (sessionId !== 'exit-after-commit-old') {
      await new Promise<void>(() => {})
    }
  })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the real runner must register the /new transition command')
  const transition = newHandler()
  await settle()
  releaseCreate()
  await settle()
  // The transition committed the child and is now stuck in the post-commit
  // child quiesce. Exit: the abort-aware quiesce cancels the child, the
  // surface init is skipped, and the committed child is retired.
  await fiber.dispose()
  fiber = undefined
  await transition
  const events = harness.retirementEvents
  const created = harness.createdSessions.at(-1)
  assert.ok(created, '/new must create a child session')
  assert.equal(events.filter(event => event === 'dispose:exit-after-commit-old').length, 1,
    'the old owner must be retired exactly once (post-commit)')
  assert.equal(events.filter(event => event === `dispose:${created.id}`).length, 1,
    'the committed child must be retired exactly once (teardown)')
  assert.equal(events.filter(event => event === `cancel:${created.id}`).length, 1,
    'the committed child must be cancelled EXACTLY once by the abort-aware quiesce, not again by retirement')
})

test('a retirement flush failure warns the user on stderr (durability is not silently lost)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-warn-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-warn-session',
    header: { id: 'retire-warn-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents)
  // The final retirement flush fails (disk full): the user must see a
  // warning, not a silent clean exit.
  ;(harness.sessions as { flush: (session?: unknown) => Promise<unknown> }).flush = async () => {
    throw new Error('disk full')
  }
  const stderrWrites: string[] = []
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown) => {
    stderrWrites.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  life.defer(() => { process.stderr.write = originalWrite })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  await fiber.dispose()
  fiber = undefined
  assert.ok(stderrWrites.some(write => write.includes('session flush failed during retirement') && write.includes('disk full')),
    `the user must see the flush-failure warning on stderr: ${JSON.stringify(stderrWrites)}`)
  assert.ok(stderrWrites.some(write => write.includes('the latest events may not be persisted')),
    'the warning must state the durability consequence')
})

test('a retirement descendant-drain failure warns with the failing phases (not the flush wording)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-retire-warn-drain-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  const resumed: FakeSession = fakeSession({
    id: 'retire-warn-drain-session',
    header: { id: 'retire-warn-drain-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('resumed answer'),
  })
  // The descendant drain fails: the warning must name the failing phases,
  // NOT use the flush-specific durability wording.
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, (events: string[]) => ({
    drainContinuableDescendants: async () => {
      events.push('drain:retire-warn-drain-session')
      throw new Error('drain exploded')
    },
  }))
  const stderrWrites: string[] = []
  const originalWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown) => {
    stderrWrites.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  life.defer(() => { process.stderr.write = originalWrite })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  await fiber.dispose()
  fiber = undefined
  assert.ok(stderrWrites.some(write => write.includes('session retirement failed during descendants')),
    `the warning must name the failing phase: ${JSON.stringify(stderrWrites)}`)
  assert.ok(!stderrWrites.some(write => write.includes('the latest events may not be persisted')),
    'a non-flush failure must not claim a durability loss')
})

test('the interactive child viewer projects its own authoritative steering and never leaks the parent subject', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-child-steering-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent = fakeSession({
    id: 'parent-child-steering',
    header: { id: 'parent-child-steering', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const child = fakeSession({
    id: 'child-child-steering',
    header: {
      id: 'child-child-steering',
      cwd: home,
      createdAt: 1_700_000_000_001,
      version: SESSION_FORMAT_VERSION,
      parentSession: 'parent-child-steering',
    },
    events: sessionEvents('child answer'),
  })
  const subagents = {
    listDescendants: async () => [{
      kind: 'child',
      id: child.id,
      label: 'child steer',
      mode: 'continuable',
      activity: 'running',
      hasChildren: false,
      parentId: parent.id,
      depth: 1,
    }],
  }
  const harness = makeHarness(home, [parent, child], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  const childHandle = await (harness.agents as { resume: (options: { resumeSessionId: string }) => Promise<{ dispose: () => Promise<void> }> }).resume({ resumeSessionId: child.id })
  life.defer(() => childHandle.dispose())
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, { sessionId: parent.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }

  // Both subjects hold an authoritative user steering occurrence in their inbox.
  const parentAgent = liveAgentOf(harness, parent.id) as unknown as { inbox: { nextStep: unknown[] } }
  const childAgent = liveAgentOf(harness, child.id) as unknown as { status: string; inbox: { nextStep: unknown[] } }
  parentAgent.inbox.nextStep.push({
    id: 'parent-step-1',
    role: 'user',
    content: [{ type: 'text', text: 'PARENT-STEER' }],
    source: { kind: 'user', rpcId: 'parent-rpc' },
  })
  childAgent.status = 'running'
  childAgent.inbox.nextStep.push({
    id: 'child-step-1',
    role: 'user',
    content: [{ type: 'text', text: 'CHILD-STEER' }],
    source: { kind: 'user', rpcId: 'child-rpc' },
  })
  context.emit('session/event', parent as never, event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [] }, 40))
  await settle()
  await vt.waitForRender()
  assert.ok(app.pendingInputForTest().steering.some(row => row.text === 'PARENT-STEER'),
    'the main subject shows its authoritative steering before the viewer opens')

  // Enter the interactive continuable child viewer.
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.notEqual(app.getViewerGeneration(), 0, 'the child viewer must be mounted')

  context.emit('session/event', child as never, event('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [] }, 41))
  await settle()
  await vt.waitForRender()
  const viewed = app.pendingInputForTest()
  assert.ok(viewed.steering.some(row => row.text === 'CHILD-STEER' && row.rpcId === 'child-rpc'),
    `the child authoritative steering must be visible: ${JSON.stringify(viewed.steering)}`)
  assert.ok(!viewed.steering.some(row => row.text === 'PARENT-STEER'),
    'the parent pending row must not leak into the child viewer')

  // Leaving the viewer re-projects the MAIN subject: the child row must not leak.
  const mountedGeneration = app.getViewerGeneration()
  input('\x1b')
  await settle()
  await vt.waitForRender()
  assert.ok(app.getViewerGeneration() > mountedGeneration, 'Esc must close the viewer')
  const restored = app.pendingInputForTest()
  assert.ok(!restored.steering.some(row => row.text === 'CHILD-STEER'),
    'the closed child pending row must not leak to the parent surface')
  assert.ok(restored.steering.some(row => row.text === 'PARENT-STEER'),
    'the parent subject is re-projected after the viewer closes')
})

/** A mutable jobs-registry fake for the Task Center runner paths. */
function makeJobsFake(
  initial: readonly { id: string; kind: string; label: string; status: string; startedAt: number }[],
) {
  type Entry = { id: string; kind: string; label: string; status: string; startedAt: number }
  let entries: Entry[] = initial.map(entry => ({ ...entry }))
  let listFailure: Error | undefined
  const listeners: Array<(event: { type: string }) => void> = []
  const subscribeFilters: unknown[] = []
  let subscribeDisposals = 0
  const registry = {
    list: (caller?: unknown): Entry[] => {
      // DSH 0.1.7 JobRegistry ownership: the caller, when present, is the
      // owning SessionId — never an Agent object.
      if (caller !== undefined && typeof caller !== 'string') {
        throw new Error(`jobs.list must receive a SessionId, got ${String(caller)}`)
      }
      if (listFailure !== undefined) throw listFailure
      return entries.map(entry => ({ ...entry }))
    },
    get: (id: string, caller?: unknown): Entry => {
      if (caller !== undefined && typeof caller !== 'string') {
        throw new Error(`jobs.get must receive a SessionId, got ${String(caller)}`)
      }
      const entry = entries.find(candidate => candidate.id === id)
      // A vanished job is the registry's own "not found" contract.
      if (entry === undefined) throw new Error(`unknown job ${id}`)
      return { ...entry }
    },
    kill: (id: string, caller?: unknown): string => {
      if (caller !== undefined && typeof caller !== 'string') {
        throw new Error(`jobs.kill must receive a SessionId, got ${String(caller)}`)
      }
      return 'accepted'
    },
    // DSH 0.1.7 JobRegistry unified event seam: the runner subscribes
    // through `events.subscribe(filter, listener)`; the disposer removes
    // the listener so disposal semantics are observable. Emissions carry
    // the official JobEvent type vocabulary so the listener's event-type
    // filtering is exercised exactly as the registry delivers it.
    events: {
      subscribe: (filter: unknown, listener: (event: { type: string }) => void): (() => void) => {
        subscribeFilters.push(filter)
        listeners.push(listener)
        return () => {
          subscribeDisposals += 1
          const index = listeners.indexOf(listener)
          if (index !== -1) listeners.splice(index, 1)
        }
      },
    },
    setEntries: (next: readonly Entry[]): void => { entries = next.map(entry => ({ ...entry })) },
    setListFailure: (error: Error | undefined): void => { listFailure = error },
    emit: (type = 'settled'): void => { for (const listener of [...listeners]) listener({ type }) },
    /** C1 contract probes: exactly-once subscribe/dispose observability. */
    subscribeCount: (): number => subscribeFilters.length,
    disposalCount: (): number => subscribeDisposals,
    activeListenerCount: (): number => listeners.length,
    filterAt: (index: number): unknown => subscribeFilters[index],
  }
  return registry
}

test('a Job detail opened from /tasks keeps its parent mounted and live-refreshes it (jobs-only)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-task-disposition-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'task-disposition-parent',
    header: { id: 'task-disposition-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  // NO subagents service: this is the jobs-only path (the fallback browser).
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' })
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')

  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'the Task Center must be the only overlay')

  input('\r') // open the selected running job's status detail
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 2, 'the Job detail must keep the parent browser mounted')

  // The job settles WHILE the parent is hidden. In a jobs-only session the
  // only channel is jobs.events.subscribe → refreshTasks, which must repaint the
  // open (hidden) browser, not just the dock badge.
  jobs.setEntries([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'completed', startedAt: 1 }])
  jobs.emit()
  await settle()
  await vt.waitForRender()

  input('\x1b') // Esc closes ONLY the Job detail
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'Esc must close only the Job detail')
  assert.ok(view().includes('completed'),
    `the restored parent must show the live-refreshed job status:\n${view()}`)

  // A vanished job must leave the parent usable: the registry lookup throws,
  // so openJobView opens nothing and reports keep-open.
  jobs.setEntries([])
  input('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1,
    'a vanished job must not dismiss the parent browser')
})

test('the runner-level Job event subscription is exactly-once and disposed with the surface (C1)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-jobs-events-lifecycle-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'jobs-events-lifecycle-parent',
    header: { id: 'jobs-events-lifecycle-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' })
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  assert.ok(probe.apps.at(-1), 'the production runner must create a TuiApp')
  await settle()

  // The runner subscribes exactly once through the unified event seam, with
  // the composition scope filter — never process-global observation.
  assert.equal(jobs.subscribeCount(), 1,
    'the runner must subscribe exactly once through jobs.events')
  assert.deepEqual(jobs.filterAt(0), { owners: 'scope' },
    'the runner-level filter must be the composition scope, not { owners: \'all\' }')

  // A live emission still reaches the refresh channel.
  jobs.setEntries([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'completed', startedAt: 1 }])
  jobs.emit()
  await settle()

  // Surface teardown releases the subscription exactly once, and a later
  // emission has no listener left to fire a post-disposal refresh.
  const mountedFiber = fiber
  assert.ok(mountedFiber)
  await mountedFiber.dispose()
  fiber = undefined
  await settle()
  assert.equal(jobs.disposalCount(), 1, 'the subscription must be disposed exactly once')
  assert.equal(jobs.activeListenerCount(), 0, 'no listener may survive the surface teardown')
  jobs.emit()
  await settle()
  assert.equal(jobs.disposalCount(), 1, 'a post-disposal emission must not re-subscribe')
  assert.equal(jobs.subscribeCount(), 1, 'a post-disposal emission must not create a new subscription')
})

test('job events route by semantics: output ignored, progress/stopping runtime-only, membership full (rc.1)', async (t) => {
  // rc.1 JobEvent semantic routing: `output` (one ring append per streamed
  // chunk) is pure stream noise; `progress`/`stopping` change only JobView
  // runtime facts; only the membership vocabulary (registered/settled/
  // removed) may move the subagent catalog, whose refresh (listDescendants)
  // can read persistence — so routing matches the TaskBrowserRuntime's own
  // catalog/runtime split.
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-jobs-event-routing-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)

  const parent: FakeSession = fakeSession({
    id: 'jobs-output-filter-parent',
    header: { id: 'jobs-output-filter-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  let descendantReads = 0
  const subagents = {
    listDescendants: async () => {
      descendantReads += 1
      return []
    },
  }
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  harness.jobs = jobs

  // refreshTasks lands in app.setTasks; count calls through the prototype
  // to observe exactly which emissions reached the refreshes.
  const setTasksCalls: number[] = []
  const originalSetTasks = TuiApp.prototype.setTasks
  TuiApp.prototype.setTasks = function (tasks: unknown) {
    setTasksCalls.push((tasks as { id: string }[]).length)
    return originalSetTasks.call(this, tasks as never)
  }
  life.defer(() => { TuiApp.prototype.setTasks = originalSetTasks })

  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  assert.ok(probe.apps.at(-1), 'the production runner must create a TuiApp')
  await settle()
  // The initial seed refresh (+ the subagents-backed catalog refresh).
  const setTasksBaseline = setTasksCalls.length
  const descendantBaseline = descendantReads
  assert.ok(descendantBaseline > 0, 'the mount must have performed the initial catalog refresh')

  // A burst of output events (one per streamed chunk) must reach NEITHER
  // refresh channel: no task repaint, no catalog read.
  for (let chunk = 0; chunk < 5; chunk += 1) jobs.emit('output')
  await settle()
  await vt.waitForRender()
  assert.equal(setTasksCalls.length, setTasksBaseline, 'output events must not repaint the Task rows')
  assert.equal(descendantReads, descendantBaseline, 'output events must not trigger the subagent catalog refresh')

  // `progress` (a producer's live progress line) and `stopping` (a kill
  // acknowledged) change only JobView runtime facts: the Task rows repaint
  // from the runtime-only refresh while the CATALOG (listDescendants —
  // which may read persistence) stays untouched.
  for (const type of ['progress', 'stopping'] as const) {
    const taskBaseline = setTasksCalls.length
    const catalogBaseline = descendantReads
    jobs.emit(type)
    await settle()
    await vt.waitForRender()
    assert.ok(setTasksCalls.length > taskBaseline, `a ${type} event must repaint the Task rows`)
    assert.equal(descendantReads, catalogBaseline, `a ${type} event must NOT trigger the subagent catalog refresh`)
  }

  // Lifecycle vocabulary still refreshes normally: the roster changed and
  // a settlement implies membership may have moved.
  jobs.setEntries([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'completed', startedAt: 1 }])
  for (const type of ['settled', 'registered', 'removed'] as const) {
    const taskBaseline = setTasksCalls.length
    const catalogBaseline = descendantReads
    jobs.emit(type)
    await settle()
    await vt.waitForRender()
    assert.ok(setTasksCalls.length > taskBaseline, `a ${type} event must repaint the Task rows`)
    assert.ok(descendantReads > catalogBaseline, `a ${type} event must trigger the subagent catalog refresh`)
  }
})

test('a failed jobs read never blanks the retained Task Browser parent', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-task-read-failure-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'task-read-failure-parent',
    header: { id: 'task-read-failure-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' })
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')

  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'the Task Center must be the only overlay')
  assert.ok(view().includes('build'), `the browser must show the job:\n${view()}`)

  input('\r') // Job detail; the parent stays mounted but hidden
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 2)

  // The close-time refresh hits a transient registry failure: that must NOT
  // be interpreted as an authoritative empty catalog.
  jobs.setListFailure(new Error('registry unavailable'))
  input('\x1b') // close the Job detail → onClose → refreshTasks()
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 1, 'Esc must close only the Job detail')
  assert.ok(view().includes('build'),
    `the retained parent must keep its rows across a failed registry read:\n${view()}`)
})

test('a failed jobs read never blanks a coordinator-backed Task Browser', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-task-runtime-read-failure-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const parent: FakeSession = fakeSession({
    id: 'task-runtime-read-failure-parent',
    header: { id: 'task-runtime-read-failure-parent', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('parent answer'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  // A subagents service makes this the COORDINATOR-backed runtime path (the
  // TaskBrowserRuntime.readJobs hook), not the jobs-only fallback browser.
  const subagents = { listDescendants: async () => [] }
  const harness = makeHarness(home, [parent], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: parent.id }, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')

  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.ok(view().includes('build'), `the browser must show the job:\n${view()}`)

  // A runtime refresh (jobs change → refreshAgents → TaskBrowserRuntime.apply)
  // whose registry read fails must keep the retained Job rows.
  jobs.setListFailure(new Error('registry unavailable'))
  jobs.emit()
  await settle()
  await vt.waitForRender()
  assert.ok(view().includes('build'),
    `the coordinator-backed browser must keep its rows across a failed registry read:\n${view()}`)
})

test('a session switch never inherits the previous session cached Job rows', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-task-cache-switch-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const sessionA: FakeSession = fakeSession({
    id: 'cache-switch-a',
    header: { id: 'cache-switch-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('answer a'),
  })
  const sessionB: FakeSession = fakeSession({
    id: 'cache-switch-b',
    header: { id: 'cache-switch-b', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('answer b'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  const subagents = { listDescendants: async () => [] }
  const harness = makeHarness(home, [sessionA, sessionB], { provider: 'p', model: 'm' }, undefined, undefined, subagents)
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: sessionA.id }, { sessionId: sessionA.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(resumeHandler, 'the real runner must register the /resume alias')
  const resume = resumeHandler as (invocation: { rawInput: string }) => unknown

  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.ok(view().includes('build'), `session A must show its job:\n${view()}`)

  // Switch sessions while the registry read fails: the cached A rows belong to
  // A's session identity and must not be committed into B.
  jobs.setListFailure(new Error('registry unavailable'))
  await resume({ rawInput: sessionB.id })
  await settle()
  await vt.waitForRender()
  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.ok(!view().includes('build'),
    `session B must not inherit session A cached Job rows:\n${view()}`)
})

test('switching sessions tears down the Job status viewer with its Task Browser', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-job-viewer-switch-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(80, 24)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  life.defer(() => { if (context !== undefined) return disposeContext(context) })
  life.defer(() => { if (fiber !== undefined) return fiber.dispose() })

  const sessionA: FakeSession = fakeSession({
    id: 'job-viewer-switch-a',
    header: { id: 'job-viewer-switch-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('answer a'),
  })
  const sessionB: FakeSession = fakeSession({
    id: 'job-viewer-switch-b',
    header: { id: 'job-viewer-switch-b', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('answer b'),
  })
  const jobs = makeJobsFake([{ id: 'bash-1', kind: 'bash', label: 'build', status: 'running', startedAt: 1 }])
  const harness = makeHarness(home, [sessionA, sessionB], { provider: 'p', model: 'm' })
  harness.jobs = jobs

  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: sessionA.id }, { sessionId: sessionA.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  const view = (): string => vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
  const tasksHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('tasks')
  assert.ok(tasksHandler, 'the real runner must register /tasks')
  const resumeHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('resume')
  assert.ok(resumeHandler, 'the real runner must register the /resume alias')
  const resume = resumeHandler as (invocation: { rawInput: string }) => unknown

  await tasksHandler()
  await settle()
  await vt.waitForRender()
  assert.ok(view().includes('build'), `the browser must show the job:\n${view()}`)

  input('\r') // open the Job status detail (a child overlay of the browser)
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 2, 'browser + Job detail')
  assert.ok(view().includes('Esc back'), `the Job detail shows Esc back:\n${view()}`)

  await resume({ rawInput: sessionB.id })
  await settle()
  await vt.waitForRender()
  assert.equal(app.overlayGraphState().handles, 0, 'the whole Task Center stack is torn down')
  assert.ok(!view().includes('Esc back'), `the old Job View must not survive the switch:\n${view()}`)
  assert.ok(!view().includes('build'), `the old browser must not survive the switch:\n${view()}`)
  assert.equal(app.focusSeatForTest(), 'editor', 'the new-session editor owns the keyboard')
})
