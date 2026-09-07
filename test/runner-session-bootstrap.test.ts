/** Runner-level regression coverage for the single cold-session hydration path. */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ProcessTerminal } from '@xmoon76/pi-tui'
import { createToolResultMessage, MessageId, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { apply as applyRunner, type Config } from '../src/index.ts'
import { foldPendingModelSelection } from '../src/model-selection.ts'
import { StatsFolder } from '../src/stats.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp, type StreamingToolPreview } from '../src/tui-app.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** Build a minimal event envelope for tests. The type parameter is widened
 * to any string so legacy v1 `assistant/chunk` events (absent from master's
 * SessionEventMap) can be constructed; known types keep their typed data
 * surface, widened with `Record<string, unknown>` so Session v2 fields the
 * installed dsh-session may lag (e.g. `assistant/message.stream`) can be
 * supplied. */
function event<K extends string>(
  type: K,
  data: (K extends SessionEvent['type'] ? SessionEvent<K>['data'] : Record<string, unknown>) & Record<string, unknown>,
  seq: number,
  surfaceOp?: 'append',
): SessionEvent {
  return {
    type,
    seq,
    time: 1_700_000_000_000 + seq * 1000,
    data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  } as SessionEvent
}

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
    seq,
    time: 1_700_000_000_000 + seq * 1000,
    data,
  } as unknown as SessionEvent
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

function sessionEvents(text: string): SessionEvent[] {
  return [
    event('turn/start', { turn: 0 }, 0),
    event('step/start', { turn: 0, step: 0 }, 1),
    event('assistant/chunk', {
      turn: 0,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text },
    }, 2),
    event('assistant/message', {
      turn: 0,
      step: 0,
      message: {
        id: MessageId('runner-bootstrap-message'),
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 2 },
      stream: [],
    }, 3, 'append'),
    event('step/end', { turn: 0, step: 0 }, 4),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
  ]
}

/** A FakeSession literal before the alpha.4 log accessors are attached. */
interface FakeSessionInit {
  id: string
  header: {
    id: string
    cwd: string
    createdAt: number
    version: number
    isSeeded?: boolean
    parentSession?: string
  }
  events: SessionEvent[]
  requestHeader?: () => unknown
  append?: (type: string, data: unknown, options?: { surfaceOp?: 'append' }) => unknown
}

/** The alpha.4 Session shape: the backing log is PRIVATE — production code
 * sees only `seq` / `eventAt` / `snapshotEvents`, so a mock can never again
 * mask old `Session.events` API drift (compatibility-plan B4). */
interface FakeSession {
  id: string
  header: {
    id: string
    cwd: string
    createdAt: number
    version: number
    isSeeded?: boolean
    parentSession?: string
  }
  readonly seq: number
  eventAt(seq: number): SessionEvent | undefined
  snapshotEvents(): readonly SessionEvent[]
  requestHeader?(): unknown
  append?(type: string, data: unknown, options?: { surfaceOp?: 'append' }): unknown
}

/** Build the alpha.4 Session mock over a private backing log. */
function fakeSession(init: FakeSessionInit): FakeSession {
  const events = [...init.events]
  return {
    id: init.id,
    header: init.header,
    get seq() { return events.length },
    eventAt: (seq: number) => events[seq],
    snapshotEvents: () => Object.freeze([...events]),
    requestHeader: init.requestHeader ?? (() => {
      const found = events.findLast(candidate => (candidate as unknown as { type?: unknown }).type === 'request/header')
      return (found as unknown as { data?: { header?: unknown } } | undefined)?.data?.header
    }),
    append: init.append ?? ((type: string, data: unknown, options?: { surfaceOp?: 'append' }) => {
      const appended = {
        type,
        seq: events.length,
        time: Date.now(),
        data,
        ...(options?.surfaceOp === undefined ? {} : { surfaceOp: options.surfaceOp }),
      } as unknown as SessionEvent
      events.push(appended)
      return appended
    }),
  }
}

interface RunnerHarness {
  readonly persistence: unknown
  readonly sessionQuery: unknown
  readonly agents: unknown
  readonly sessions: unknown
  readonly defaultModel: unknown
  readonly llm: unknown
  readonly createOptions: { provider?: string; model?: string }[]
  readonly createInheritedEventCounts: (number | undefined)[]
  readonly createSignals: (AbortSignal | undefined)[]
  readonly resumeSignals: (AbortSignal | undefined)[]
  readonly createdSessions: FakeSession[]
  readonly commands: unknown
  readonly subagents?: unknown
  /** Retirement-phase records (`cancel:<id>` / `idle:<id>` / `drain:<id>` /
   * `flush:<id>` / `dispose:<id>`) in call order — the Direct
   * owned-session retirement assertions. */
  readonly retirementEvents: string[]
}

function fakeAgent(session: FakeSession, whenIdleGate?: () => Promise<void>, retirementEvents?: string[]): Agent {
  // A small structural Agent context is sufficient for the Direct setup
  // callbacks and lets the harness expose the public `ctx.agent` setup seam.
  const agentContext = {
    get: () => undefined,
    on: () => () => {},
    agent: undefined as Agent | undefined,
  }
  // cancel is idempotent and BREAKS a pending whenIdle (the real Agent
  // contract): a cancelled agent's whenIdle settles immediately, which is
  // exactly what the exit pre-cancel relies on to unblock a transition
  // stuck in its pre-commit quiesce.
  let cancelled = false
  let releaseIdle: (() => void) | undefined
  const agent = {
    session,
    ctx: agentContext,
    options: { provider: 'p', model: 'm' },
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    whenIdle: async () => {
      retirementEvents?.push(`idle:${session.id}`)
      if (cancelled) return
      await new Promise<void>(resolve => {
        releaseIdle = resolve
        const gate = whenIdleGate?.()
        if (gate !== undefined) void gate.then(resolve, resolve)
        else resolve()
      })
    },
    cancel: () => {
      retirementEvents?.push(`cancel:${session.id}`)
      cancelled = true
      releaseIdle?.()
    },
  } as unknown as Agent
  agentContext.agent = agent
  return agent
}

/** Build Direct services whose in-memory registry behaves like the real Host. */
function makeHarness(
  home: string,
  initial?: FakeSession | readonly FakeSession[],
  initialDefault: { provider: string; model: string; reasoningEffort?: string } = { provider: 'p', model: 'm' },
  saveDefault?: (next: { provider: string; model: string; reasoningEffort?: string }) => Promise<unknown>,
  createGate?: () => Promise<unknown>,
  /** A subagents service, or a factory receiving the harness retirement
   * events array (so a drain fake records into the SAME assertion log). */
  subagents?: unknown | ((events: string[]) => unknown),
  whenIdleGate?: (sessionId: string) => Promise<void>,
  resumeGate?: (sessionId: string) => Promise<void>,
  resumeError?: Error,
): RunnerHarness {
  const persisted = new Map<string, FakeSession>()
  const live = new Map<string, Agent>()
  const retirementEvents: string[] = []
  const createOptions: { provider?: string; model?: string }[] = []
  const createInheritedEventCounts: (number | undefined)[] = []
  const createSignals: (AbortSignal | undefined)[] = []
  const resumeSignals: (AbortSignal | undefined)[] = []
  const createdSessions: FakeSession[] = []
  for (const session of initial === undefined ? [] : Array.isArray(initial) ? initial : [initial]) {
    persisted.set(session.id, session)
  }

  const makeHandle = (session: FakeSession): { agent: Agent; dispose: () => Promise<void> } => {
    const agent = fakeAgent(session, whenIdleGate === undefined ? undefined : () => whenIdleGate(session.id), retirementEvents)
    live.set(session.id, agent)
    return {
      agent,
      dispose: async () => {
        retirementEvents.push(`dispose:${session.id}`)
        live.delete(session.id)
      },
    }
  }

  const persistence = {
    list: async () => [...persisted.values()].map(session => session.header),
    inspect: async (id: unknown) => {
      const session = persisted.get(String(id))
      if (session === undefined) throw new Error(`unknown test session ${String(id)}`)
      return { meta: session.header, events: [...session.snapshotEvents()] }
    },
  }
  // The semantic session-query seam (master contract): the reader's list /
  // recorded-preset / export paths read ONLY this service now — the raw
  // persistence fallback is removed legacy.
  const sessionQuery = {
    listSessions: async () => [...persisted.values()].map(session => ({
      header: session.header,
      live: live.has(session.id),
    })),
    observeSession: async (id: unknown) => {
      const session = persisted.get(String(id))
      if (session === undefined) throw new Error(`unknown test session ${String(id)}`)
      return { header: session.header, events: [...session.snapshotEvents()], [Symbol.dispose]: () => {} }
    },
  }
  const agents = {
    resume: async ({ resumeSessionId, setup, signal }: { resumeSessionId: unknown; setup?: (agentCtx: unknown) => unknown; signal?: AbortSignal }) => {
      resumeSignals.push(signal)
      if (resumeError !== undefined) throw resumeError
      const session = persisted.get(String(resumeSessionId))
      if (session === undefined) throw new Error(`unknown test session ${String(resumeSessionId)}`)
      const handle = makeHandle(session)
      await setup?.(handle.agent.ctx)
      await resumeGate?.(String(resumeSessionId))
      return handle
    },
    create: async ({ sessionId, agentOptions, setup, seed, inheritedEventCount, signal }: {
      sessionId: unknown
      agentOptions?: { provider?: string; model?: string }
      setup?: (agentCtx: unknown) => unknown
      seed?: readonly SessionEvent[]
      inheritedEventCount?: number
      signal?: AbortSignal
    }) => {
      createOptions.push({ ...agentOptions })
      createInheritedEventCounts.push(inheritedEventCount)
      createSignals.push(signal)
      if (createGate !== undefined) await createGate()
      const id = String(sessionId)
      const session: FakeSession = fakeSession({
        id,
        header: { id, cwd: home, createdAt: Date.now(), version: SESSION_FORMAT_VERSION },
        events: seed === undefined ? sessionEvents('created answer') : [...seed],
      })
      createdSessions.push(session)
      persisted.set(id, session)
      const handle = makeHandle(session)
      await setup?.(handle.agent.ctx)
      return handle
    },
    get: (id: string) => live.get(id),
  }
  const sessions = {
    flush: async (session?: unknown) => {
      retirementEvents.push(`flush:${(session as { id?: string } | undefined)?.id ?? '?'}`)
    },
    get: (id: string) => live.get(id)?.session,
  }
  let defaultSelection = { ...initialDefault }
  const defaultModel = {
    currentSelection: () => ({ ...defaultSelection }),
    saveSelection: saveDefault ?? (async (next: { provider: string; model: string; reasoningEffort?: string }) => {
      defaultSelection = { ...next }
    }),
  }
  const llm = {
    listProviders: () => [{ id: 'p', name: 'provider p' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({}),
    discoverModels: async () => [],
    listConfigurableProviders: () => [],
  }
  const definitions = new Map<string, { name: string; description: string; handler: (...args: never[]) => unknown }>()
  const commands = {
    register: (definition: { name: string; description: string; handler: (...args: never[]) => unknown }) => {
      definitions.set(definition.name, definition)
      return () => {
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
      }
    },
    list: () => [...definitions.values()].map(({ name, description }) => ({ name, description })),
    execute: async () => ({ result: { kind: 'success' } }),
    handler: (name: string) => definitions.get(name)?.handler,
  }
  const subagentsService = typeof subagents === 'function'
    ? (subagents as (events: string[]) => unknown)(retirementEvents)
    : subagents
  return { persistence, sessionQuery, agents, sessions, defaultModel, llm, createOptions, createInheritedEventCounts, createSignals, resumeSignals, createdSessions, commands, subagents: subagentsService, retirementEvents }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await Promise.resolve()
}

/** Dispose every fiber created by the real Cordis context. */
async function disposeContext(ctx: Context): Promise<void> {
  for (const runtime of [...ctx.registry.values()]) {
    for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
  }
}

/** Route production ProcessTerminal instances into a deterministic xterm. */
function installVirtualProcessTerminal(vt: VirtualTerminal): () => void {
  const prototype = ProcessTerminal.prototype as object
  const names = [
    'start', 'stop', 'drainInput', 'write', 'moveBy', 'hideCursor', 'showCursor',
    'clearLine', 'clearFromCursor', 'clearScreen', 'setTitle', 'setProgress',
    'columns', 'rows', 'kittyProtocolActive', 'modifyOtherKeysActive',
  ]
  const originals = new Map<string, PropertyDescriptor | undefined>()
  const virtual = vt as unknown as Record<string, unknown>
  const methods = new Set([
    'start', 'stop', 'drainInput', 'write', 'moveBy', 'hideCursor', 'showCursor',
    'clearLine', 'clearFromCursor', 'clearScreen', 'setTitle', 'setProgress',
  ])
  for (const name of names) {
    originals.set(name, Object.getOwnPropertyDescriptor(prototype, name))
    if (methods.has(name)) {
      Object.defineProperty(prototype, name, {
        configurable: true,
        value: (...args: unknown[]) => {
          const method = virtual[name]
          if (typeof method !== 'function') throw new Error(`virtual terminal method missing: ${name}`)
          return (method as (...args: unknown[]) => unknown).apply(vt, args)
        },
      })
    } else {
      Object.defineProperty(prototype, name, {
        configurable: true,
        get: () => name === 'modifyOtherKeysActive' ? false : virtual[name],
      })
    }
  }
  return () => {
    for (const name of names) {
      const descriptor = originals.get(name)
      if (descriptor === undefined) delete (prototype as Record<string, unknown>)[name]
      else Object.defineProperty(prototype, name, descriptor)
    }
  }
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
  TuiApp.prototype.setTranscript = function (messages, activities, window, streamingToolPreviews) {
    probe.capturedMessages = messages
    probe.capturedActivities = activities
    probe.capturedStreamingToolPreviews = streamingToolPreviews
    return originalSetTranscript.call(this, messages, activities, window, streamingToolPreviews)
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
    TuiApp.prototype.start = originalStart
    TuiApp.prototype.scrollToBottom = originalScrollToBottom
  }
  return probe
}

async function mountRunner(
  ctx: Context,
  home: string,
  harness: RunnerHarness,
  startup: { sessionId?: string; presetId?: string },
  config: Config,
  appExit: () => void = () => {},
) {
  ctx.provide('appExit', appExit)
  ctx.provide(TUI_STARTUP_SERVICE, { ...startup, shippedPresetRoot: home })
  ctx.provide('sessionPersistence', harness.persistence as never)
  ctx.provide('sessionQuery', harness.sessionQuery as never)
  ctx.provide('agents', harness.agents as never)
  ctx.provide('sessions', harness.sessions as never)
  ctx.provide('agentDefaultModel', harness.defaultModel as never)
  ctx.provide('llm', harness.llm as never)
  ctx.provide('commands', harness.commands as never)
  if (harness.subagents !== undefined) ctx.provide('subagents', harness.subagents as never)
  ctx.provide('loader', { await: async () => {} } as never)
  const fiber = ctx.plugin((pluginCtx) => applyRunner(pluginCtx, config))
  await fiber
  await settle()
  return fiber
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
  input('\r') // provider -> model list
  await settle()
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
  input('\r') // provider -> model list
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

test('/fork applies the source current selection after its historical inherited prefix', async (t) => {
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
  const sourceEvents = [
    modelEvent('model/selection', { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }, 0),
    modelEvent('request/header', {
      header: { config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } },
    }, 1),
    ...sessionEvents('source answer'),
    // This is the source's current switch, after the completed turn, so the
    // fork seed deliberately excludes it and retains only historical A.
    modelEvent('model/selection', currentSelection, 6),
  ]
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
  const inheritedPrefix = sourceEvents.slice(0, 8)
  assert.deepEqual(harness.createInheritedEventCounts, [inheritedPrefix.length],
    'inheritedEventCount ends exactly at the historical prefix')
  assert.deepEqual(child.snapshotEvents().slice(0, inheritedPrefix.length), inheritedPrefix,
    'the child keeps the exact historical A prefix')
  assert.deepEqual(source.snapshotEvents(), sourceEvents, 'fork does not mutate the source log')
  const childBoundary = child.snapshotEvents()[inheritedPrefix.length]
  assert.equal((childBoundary as unknown as { type?: unknown } | undefined)?.type, 'model/selection',
    'the current selection starts in the child-owned suffix')
  assert.deepEqual((childBoundary as unknown as { data?: unknown } | undefined)?.data, currentSelection)
  const childSelections = child.snapshotEvents().filter(event => (event as unknown as { type?: unknown }).type === 'model/selection')
  assert.deepEqual((childSelections.at(-1) as unknown as { data?: unknown } | undefined)?.data, currentSelection,
    'the child-owned suffix records the source current B/max selection')
  assert.deepEqual(foldPendingModelSelection(child.snapshotEvents()).pending, currentSelection,
    'the child effective next selection is B/max')
})

test('/rewind forwards the source selection through the real picker callback', async (t) => {
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
  const sourceEvents = [
    modelEvent('model/selection', { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' }, 0),
    modelEvent('request/header', {
      header: { config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } },
    }, 1),
    ...firstTurn,
    ...secondTurn,
    // The current switch is after the selected rewind cursor. It must be
    // written after the inherited historical prefix in the child.
    modelEvent('model/selection', currentSelection, firstTurn.length + secondTurn.length + 2),
  ]
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
  assert.deepEqual((child.snapshotEvents()[inheritedPrefix.length] as unknown as { data?: unknown } | undefined)?.data, currentSelection,
    'the real rewind call site writes B/max in the child suffix')
  assert.deepEqual(foldPendingModelSelection(child.snapshotEvents()).pending, currentSelection)
})

test('/fork treats a reasoning-effort change as a new selection', async (t) => {
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
  const sourceEvents = [
    modelEvent('model/selection', { provider: 'provider-b', model: 'model-b', reasoningEffort: 'high' }, 0),
    modelEvent('request/header', {
      header: { config: { provider: 'provider-b', model: 'model-b', reasoningEffort: 'high' } },
    }, 1),
    ...sessionEvents('source answer'),
    modelEvent('model/selection', currentSelection, 6),
  ]
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
  assert.deepEqual(harness.createInheritedEventCounts, [8])
  const childBoundary = child.snapshotEvents()[8]
  assert.deepEqual((childBoundary as unknown as { data?: unknown } | undefined)?.data, currentSelection,
    'same provider/model with a changed effort writes the new child selection')
  assert.deepEqual(foldPendingModelSelection(child.snapshotEvents()).pending, currentSelection)
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
    events: [
      modelEvent('model/selection', selection, 0),
      modelEvent('request/header', { header: { config: selection } }, 1),
      ...sessionEvents('source answer'),
    ],
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

test('a sessionless /model choice seeds the first Session while its default save is still pending', async (t) => {
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
  app.setDraft('first deferred prompt')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  assert.deepEqual(harness.createOptions[0], { provider: 'p', model: 'm2' },
    'deferred create must read the pending sessionless choice')
  assert.deepEqual(durableSelectionOf(harness.createdSessions[0]!), {
    provider: 'p', model: 'm2',
  }, 'the pending default intent must bridge the race and seed the first Session durably')
  releaseSave()
  await settle()
})

test('a newer sessionless /model during the awaited first create seeds the newest pending choice', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-runner-create-race-')
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
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve })
  let releaseSave!: () => void
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
  const harness = makeHarness(home, undefined, { provider: 'p', model: 'm' }, async () => saveGate, async () => createGate)
  context = new Context()
  fiber = await mountRunner(context, home, harness, {}, {})
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  const modelHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('model')
  assert.ok(modelHandler, 'the real runner must register /model')
  const input = (data: string): void => {
    const tui = (app as unknown as { tui: { handleTerminalInput(data: string): void } }).tui
    tui.handleTerminalInput(data)
  }
  // /model → m1 (its save hangs on the gate).
  await modelHandler()
  await settle()
  input('\r') // provider -> model list
  await settle()
  input('\r') // select m1
  await settle()
  // Submit: the first create hangs on the gate.
  app.setDraft('first deferred prompt')
  ;(app as unknown as { submitDraft(): void }).submitDraft()
  await settle()
  // A NEWER /model → m2 while the create is still awaiting.
  input('\r') // back to the provider list
  await settle()
  input('\r') // provider -> model list
  await settle()
  input('\x1b[B') // choose m2 instead of the first listed model
  input('\r')
  await settle()
  // Release the create: the seed must use the NEWEST pending choice (m2).
  releaseCreate()
  await settle()
  assert.deepEqual(durableSelectionOf(harness.createdSessions[0]!), {
    provider: 'p', model: 'm2',
  }, 'the first Session must seed the newest pending sessionless choice, not the captured one')
  releaseSave()
  await settle()
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
  // A settings service carrying the persisted wheel step AND fullscreen
  // 'on': the runner must hand the step to the app BEFORE the first
  // alt-screen mount (the fork reads it at construction).
  const doc: Record<string, unknown> = {
    theme: 'auto', iconStyle: 'emoji', footer: 'full', fullscreen: 'on',
    busyEnter: 'queue', localShellSandbox: 'bypass', homeEndKeys: 'input',
    focusMode: 'off', wheelScrollLines: '8',
  }
  context.provide('settings', {
    register: () => ({
      get: () => ({ ...doc }),
      replace: async (next: Record<string, unknown>) => { Object.assign(doc, next) },
    }),
  } as never)
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
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
  input('\r')
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
  input('\r')
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

test('explicit cold resume shows the pre-mount status and clears it before mount; fresh start stays silent', async (t) => {
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

  // A fresh (deferred) start must not emit the resume status.
  orderedLog.length = 0
  const deferredHarness = makeHarness(home)
  deferredContext = new Context()
  deferredFiber = await mountRunner(deferredContext, home, deferredHarness, {}, { startupStatusOutput: statusOutput })
  assert.ok(!orderedLog.some(write => write.includes('Resuming session')),
    `a fresh start must stay silent: ${JSON.stringify(orderedLog)}`)

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

test('a fresh start with a FAILING preset resolution stays silent (no Preparing status)', async (t) => {
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
  // must NOT re-arm the startup status — a fresh start never shows
  // any status, on the happy path OR the failure path.
  const harness = makeHarness(home)
  context = new Context()
  context.provide('agentPresets', {
    defaultId: 'standard',
    resolve: async () => { throw new Error('roster broken') },
  } as never)
  fiber = await mountRunner(context, home, harness, {}, { startupStatusOutput: statusOutput })
  assert.ok(!orderedLog.some(write => write.includes('Resuming session') || write.includes('Preparing conversation')),
    `a fresh start with a failing preset must not show any startup status: ${JSON.stringify(orderedLog)}`)
  // The TUI still mounts (degraded — the failure is a one-shot warn).
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must still create a TuiApp')
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
  const harness = makeHarness(home, resumed, { provider: 'p', model: 'm' }, undefined, undefined, retirementSubagents)
  context = new Context()
  fiber = await mountRunner(context, home, harness, { sessionId: resumed.id }, { sessionId: resumed.id })
  const app = probe.apps.at(-1)
  assert.ok(app, 'the production runner must create a TuiApp')
  // HMR unload: dispose the runner fiber directly (no interactive exit).
  await fiber.dispose()
  fiber = undefined
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
    'the interactive exit must cancel the owned agent')
  assert.equal(events.filter(event => event === 'drain:retire-interactive-session').length, 1,
    'the interactive exit must drain the continuable descendants')
  assert.equal(events.filter(event => event === 'dispose:retire-interactive-session').length, 1,
    'the interactive exit must dispose the owned handle')
  assert.ok(events.indexOf('drain:retire-interactive-session') < events.indexOf('dispose:retire-interactive-session'),
    'the descendant drain must precede the parent handle dispose on the interactive path too')
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
  assert.ok(events.filter(event => event === 'cancel:retire-whenidle-stuck-old').length >= 1,
    'the old owner must be cancelled (pre-cancel and/or the retirement cancel phase)')
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
  const fiber = context.plugin((pluginCtx) => applyRunner(pluginCtx, { sessionId: resumed.id }))
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
  assert.ok(events.filter(event => event === `cancel:${created.id}`).length >= 1,
    'the first child must be cancelled (pre-cancel and/or the abort-aware quiesce)')
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
  assert.ok(events.filter(event => event === `cancel:${created.id}`).length >= 1,
    'the committed child must be cancelled by the abort-aware quiesce')
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
