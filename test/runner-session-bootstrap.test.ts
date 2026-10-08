/** Runner-level regression coverage for the live main-Session bootstrap
 * surface: resume/deferred-create/switch hydration, opening cuts, per-Session
 * model restoration, model/preset persistence, startup display preference
 * ordering, the main-session repaint path, and the bootstrap catalog/skills
 * refresh. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, MessageId, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import { SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { Config as TuiConfigSchema } from '../src/index.ts'
import { TuiApp } from '../src/tui-app.ts'
import type { StreamingToolPreview } from '../src/app/surface/streaming-tool-preparing.ts'
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
import {
  emitLiveStream,
  installProbe,
  liveAgentOf,
  liveChunkFrame,
  liveCommittedEnd,
  liveStart,
  modelEvent,
  nextLiveStreamRevision,
} from './support/runner-session-fixtures.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

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
    type: 'end', attemptId: 'fa-2', revision: nextLiveStreamRevision(), index: 1,
    outcome: { kind: 'abandoned' },
  })
  await new Promise(resolve => setTimeout(resolve, 70))
  await vt.waitForRender()
  assert.deepEqual(probe.capturedStreamingToolPreviews, [],
    'an abandoned end clears the step\'s previews with the transient attempt')
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

test('a skills/change emitted after surface teardown performs no further catalog read', async (t) => {
  // A5b-3 review P2: the Direct `skills/change` capability offers no
  // unsubscribe, so a late invalidation can reach the coalescing gate after the
  // surface is torn down. Disposal clears the refresh request slot, so the late
  // event must become a NO-OP — no extra catalog read and no late error.
  //
  // Scope note: disposing the runner fiber also tears down the listener path in
  // this harness, so this end-to-end test proves NO post-teardown read (it is a
  // real teardown-path regression guard), while the late-LISTENER mechanism is
  // pinned structurally by the A5b closure lock on `disposeCatalog`.
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-skills-change-teardown-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const resumed: FakeSession = fakeSession({
    id: 'skills-teardown-session',
    header: { id: 'skills-teardown-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
    events: sessionEvents('skills teardown answer'),
  })
  const harness = makeHarness(home, resumed)
  const context = new Context()
  life.defer(() => disposeContext(context))
  let snapshots = 0
  context.provide('skills', {
    snapshot: async () => {
      snapshots += 1
      return { skills: [], complete: true }
    },
  } as never)
  const fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  life.defer(() => fiber.dispose())
  await settle()
  const emitSkillsChange = (): void =>
    (context as unknown as { emit(name: string, payload: unknown): void }).emit('skills/change', {})
  // The live path must drive a read first: otherwise the teardown assertion
  // could pass only because no listener ever existed.
  const before = snapshots
  emitSkillsChange()
  const deadline = Date.now() + 3000
  while (snapshots === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(snapshots > before,
    'a live skills/change must drive a catalog read before the teardown assertion can mean anything')
  await new Promise(resolve => setTimeout(resolve, 250))
  const afterLive = snapshots
  await fiber.dispose()
  await settle()
  emitSkillsChange()
  emitSkillsChange()
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(snapshots, afterLive,
    'a post-teardown skills/change must not read the catalog again (the disposed coordinator must stay untouched)')
})
