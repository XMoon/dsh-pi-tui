/** Runner-level regression coverage for the single cold-session hydration path. */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ProcessTerminal } from '@xmoon76/pi-tui'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { apply as applyRunner, type Config } from '../src/index.ts'
import { StatsFolder } from '../src/stats.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

function event<K extends SessionEvent['type']>(
  type: K,
  data: SessionEvent<K>['data'],
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
  const event = [...session.events].reverse().find(candidate => (candidate as unknown as { type?: unknown }).type === 'model/selection')
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
    }, 3, 'append'),
    event('step/end', { turn: 0, step: 0 }, 4),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
  ]
}

interface FakeSession {
  id: string
  header: { id: string; cwd: string; createdAt: number; version: number }
  events: SessionEvent[]
  requestHeader?: () => unknown
  append?: (type: string, data: unknown) => unknown
}

interface RunnerHarness {
  readonly persistence: unknown
  readonly agents: unknown
  readonly sessions: unknown
  readonly defaultModel: unknown
  readonly llm: unknown
  readonly createOptions: { provider?: string; model?: string }[]
  readonly createdSessions: FakeSession[]
  readonly commands: unknown
}

function fakeAgent(session: FakeSession): Agent {
  // A small structural Agent context is sufficient for the Direct setup
  // callbacks and lets the harness expose the public `ctx.agent` setup seam.
  const agentContext = {
    get: () => undefined,
    on: () => () => {},
    agent: undefined as Agent | undefined,
  }
  const agent = {
    session,
    ctx: agentContext,
    options: { provider: 'p', model: 'm' },
    inbox: { nextTurn: [], nextStep: [] },
    whenIdle: async () => {},
  } as unknown as Agent
  agentContext.agent = agent
  if (session.requestHeader === undefined) {
    session.requestHeader = () => {
      const event = [...session.events].reverse().find(candidate => (candidate as unknown as { type?: unknown }).type === 'request/header')
      return (event as unknown as { data?: { header?: unknown } } | undefined)?.data?.header
    }
  }
  if (session.append === undefined) {
    session.append = (type: string, data: unknown) => {
      const event = { type, seq: session.events.length, time: Date.now(), data } as unknown as SessionEvent
      session.events.push(event)
      return event
    }
  }
  return agent
}

/** Build Direct services whose in-memory registry behaves like the real Host. */
function makeHarness(
  home: string,
  initial?: FakeSession | readonly FakeSession[],
  initialDefault: { provider: string; model: string; reasoningEffort?: string } = { provider: 'p', model: 'm' },
  saveDefault?: (next: { provider: string; model: string; reasoningEffort?: string }) => Promise<unknown>,
  createGate?: () => Promise<unknown>,
): RunnerHarness {
  const persisted = new Map<string, FakeSession>()
  const live = new Map<string, Agent>()
  const createOptions: { provider?: string; model?: string }[] = []
  const createdSessions: FakeSession[] = []
  for (const session of initial === undefined ? [] : Array.isArray(initial) ? initial : [initial]) {
    persisted.set(session.id, session)
  }

  const makeHandle = (session: FakeSession): { agent: Agent; dispose: () => Promise<void> } => {
    const agent = fakeAgent(session)
    live.set(session.id, agent)
    return {
      agent,
      dispose: async () => {
        live.delete(session.id)
      },
    }
  }

  const persistence = {
    list: async () => [...persisted.values()].map(session => session.header),
    inspect: async (id: unknown) => {
      const session = persisted.get(String(id))
      if (session === undefined) throw new Error(`unknown test session ${String(id)}`)
      return { meta: session.header, events: session.events }
    },
    readRaw: async () => undefined,
    locate: ({ id }: { id: string }) => ({ kind: 'session', path: join(home, 'sessions', `${id}.jsonl`) }),
  }
  const agents = {
    resume: async ({ resumeSessionId, setup }: { resumeSessionId: unknown; setup?: (agentCtx: unknown) => unknown }) => {
      const session = persisted.get(String(resumeSessionId))
      if (session === undefined) throw new Error(`unknown test session ${String(resumeSessionId)}`)
      const handle = makeHandle(session)
      await setup?.(handle.agent.ctx)
      return handle
    },
    create: async ({ sessionId, agentOptions, setup }: {
      sessionId: unknown
      agentOptions?: { provider?: string; model?: string }
      setup?: (agentCtx: unknown) => unknown
    }) => {
      createOptions.push({ ...agentOptions })
      if (createGate !== undefined) await createGate()
      const id = String(sessionId)
      const session: FakeSession = {
        id,
        header: { id, cwd: home, createdAt: Date.now(), version: SESSION_FORMAT_VERSION },
        events: sessionEvents('created answer'),
      }
      createdSessions.push(session)
      persisted.set(id, session)
      const handle = makeHandle(session)
      await setup?.(handle.agent.ctx)
      return handle
    },
    get: (id: string) => live.get(id),
  }
  const sessions = {
    flush: async () => {},
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
  return { persistence, agents, sessions, defaultModel, llm, createOptions, createdSessions, commands }
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
  TuiApp.prototype.setTranscript = function (messages, activities) {
    probe.capturedMessages = messages
    return originalSetTranscript.call(this, messages, activities)
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
  startup: { sessionId?: string },
  config: Config,
) {
  ctx.provide('appExit', () => {})
  ctx.provide(TUI_STARTUP_SERVICE, { ...startup, shippedPresetRoot: home })
  ctx.provide('sessionPersistence', harness.persistence as never)
  ctx.provide('agents', harness.agents as never)
  ctx.provide('sessions', harness.sessions as never)
  ctx.provide('agentDefaultModel', harness.defaultModel as never)
  ctx.provide('llm', harness.llm as never)
  ctx.provide('commands', harness.commands as never)
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

test('the real runner hydrates resume, deferred create, and switch exactly once each', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-runner-bootstrap-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const probe = installProbe()
  let resumeContext: Context | undefined
  let deferredContext: Context | undefined
  let resumeFiber: { dispose: () => Promise<unknown> } | undefined
  let deferredFiber: { dispose: () => Promise<unknown> } | undefined
  try {
    const resumed: FakeSession = {
      id: 'runner-session-a',
      header: { id: 'runner-session-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: [...sessionEvents('resumed answer'), ...modelHistory('provider-a', 'model-a', 'high')],
    }
    const resumeHarness = makeHarness(home, resumed, { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' })
    resumeContext = new Context()
    resumeFiber = await mountRunner(resumeContext, home, resumeHarness, { sessionId: resumed.id }, { sessionId: resumed.id })
    assert.equal(probe.transcriptApplyCount, 1)
    assert.equal(probe.statsApplyCount, 1)
    assert.equal(probe.transcriptHydrateCount, 1)
    assert.equal(probe.statsHydrateCount, 1)
    assert.ok(probe.capturedMessages?.some(message => message.kind === 'assistant' && message.text === 'resumed answer'))
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
    assert.equal(durableSelectionOf(deferredHarness.createdSessions[0]!), undefined,
      'the first Session must observe the settled default dynamically, not freeze a durable choice')
    assert.equal(probe.transcriptApplyCount, 3)
    assert.equal(probe.statsApplyCount, 3)
    assert.equal(probe.transcriptHydrateCount, 3)
    assert.equal(probe.statsHydrateCount, 3)
    assert.ok(probe.capturedMessages?.some(message => message.kind === 'assistant' && message.text === 'created answer'))
  } finally {
    if (resumeFiber !== undefined) await resumeFiber.dispose()
    if (deferredFiber !== undefined) await deferredFiber.dispose()
    if (resumeContext !== undefined) await disposeContext(resumeContext)
    if (deferredContext !== undefined) await disposeContext(deferredContext)
    probe.restore()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})


test('switching between two old Sessions restores each Session own model', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-runner-switch-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const probe = installProbe()
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  try {
    const sessionA: FakeSession = {
      id: 'switch-session-a',
      header: { id: 'switch-session-a', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: [...sessionEvents('answer a'), ...modelHistory('provider-a', 'model-a', 'high')],
    }
    const sessionB: FakeSession = {
      id: 'switch-session-b',
      header: { id: 'switch-session-b', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: [...sessionEvents('answer b'), ...modelHistory('provider-b', 'model-b', 'max')],
    }
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
  } finally {
    if (fiber !== undefined) await fiber.dispose()
    if (context !== undefined) await disposeContext(context)
    probe.restore()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('/new without an explicit default intent observes the persisted default, never the old Session model', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-runner-new-default-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const probe = installProbe()
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  try {

    const resumed: FakeSession = {
      id: 'new-default-session',
      header: { id: 'new-default-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: [...sessionEvents('old answer'), ...modelHistory('provider-a', 'model-a', 'high')],
    }
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
  } finally {
    if (fiber !== undefined) await fiber.dispose()
    if (context !== undefined) await disposeContext(context)
    probe.restore()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a sessionless /model choice seeds the first Session while its default save is still pending', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-runner-race-bridge-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const probe = installProbe()
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  try {
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
  } finally {
    if (fiber !== undefined) await fiber.dispose()
    if (context !== undefined) await disposeContext(context)
    probe.restore()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a newer sessionless /model during the awaited first create seeds the newest pending choice', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-runner-create-race-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const probe = installProbe()
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  try {
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
  } finally {
    if (fiber !== undefined) await fiber.dispose()
    if (context !== undefined) await disposeContext(context)
    probe.restore()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('/model refreshes the Welcome card and footer from the authoritative Session selection', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-runner-welcome-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const probe = installProbe()
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  try {
    const resumed: FakeSession = {
      id: 'welcome-session',
      header: { id: 'welcome-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: [...sessionEvents('welcome answer'), ...modelHistory('provider-a', 'model-a', 'high')],
    }
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
  } finally {
    if (fiber !== undefined) await fiber.dispose()
    if (context !== undefined) await disposeContext(context)
    probe.restore()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a global-default save failure keeps the Session, footer, and Welcome on the new model', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-runner-welcome-savefail-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const probe = installProbe()
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  try {
    const resumed: FakeSession = {
      id: 'welcome-savefail-session',
      header: { id: 'welcome-savefail-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: [...sessionEvents('welcome answer'), ...modelHistory('provider-a', 'model-a', 'high')],
    }
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
  } finally {
    if (fiber !== undefined) await fiber.dispose()
    if (context !== undefined) await disposeContext(context)
    probe.restore()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a failed durable append leaves the Session, footer, and Welcome on the old model', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-runner-welcome-appendfail-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const probe = installProbe()
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  try {
    const resumed: FakeSession = {
      id: 'welcome-appendfail-session',
      header: { id: 'welcome-appendfail-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: [...sessionEvents('welcome answer'), ...modelHistory('provider-a', 'model-a', 'high')],
      append: () => { throw new Error('append failed') },
    }
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
  } finally {
    if (fiber !== undefined) await fiber.dispose()
    if (context !== undefined) await disposeContext(context)
    probe.restore()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('malformed request/header events cannot break the session event firehose', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-runner-malformed-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const probe = installProbe()
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  try {
    const resumed: FakeSession = {
      id: 'malformed-session',
      header: { id: 'malformed-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: sessionEvents('malformed answer'),
    }
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
  } finally {
    if (fiber !== undefined) await fiber.dispose()
    if (context !== undefined) await disposeContext(context)
    probe.restore()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('a live /model choice survives an immediate exit and resume', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-runner-exit-resume-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const probe = installProbe()
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  try {
    const resumed: FakeSession = {
      id: 'exit-resume-session',
      header: { id: 'exit-resume-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: [...sessionEvents('first answer'), ...modelHistory('provider-a', 'model-a', 'high')],
    }
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
  } finally {
    if (fiber !== undefined) await fiber.dispose()
    if (context !== undefined) await disposeContext(context)
    probe.restore()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('startup applies the persisted wheel step BEFORE the first fullscreen mount', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-wheel-startup-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const vt = new VirtualTerminal(100, 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)

  const probe = installProbe()
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  try {

    // A long transcript so the first fullscreen frame can scroll.
    const longText = Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n')
    const resumed: FakeSession = {
      id: 'wheel-startup-session',
      header: { id: 'wheel-startup-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: sessionEvents(longText),
    }
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
  } finally {
    if (fiber !== undefined) await fiber.dispose()
    if (context !== undefined) await disposeContext(context)
    probe.restore()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})


test('live repaint preserves manual scrolling in the latest window', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-live-follow-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const vt = new VirtualTerminal(80, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  const probe = installProbe()
  let context: Context | undefined
  let fiber: { dispose: () => Promise<unknown> } | undefined
  try {
    const initialText = Array.from({ length: 80 }, (_, index) => `initial line ${index}`).join('\n')
    const resumed: FakeSession = {
      id: 'live-follow-session',
      header: { id: 'live-follow-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: sessionEvents(initialText),
    }
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
    context.emit('session/event', resumed as never, event('assistant/chunk', {
      turn: 1,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: 'streaming while scrolled up' },
    }, 11))
    context.emit('session/event', resumed as never, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 12))
    await vt.waitForRender()
    assert.equal(probe.scrollToBottomCount, 0, 'live repaint must not force the latest window to its bottom')
    assert.equal(readScroll().isFollowingEnd, false, 'live repaint must preserve the manually disabled follow-end state')
    assert.ok(readScroll().scrollTop < readScroll().maxScrollTop, 'live repaint must leave the viewport away from the bottom')

    app.scrollToBottom()
    await vt.waitForRender()
    assert.equal(readScroll().isFollowingEnd, true, 'an explicit bottom jump must re-enable follow-end')
    probe.scrollToBottomCount = 0
    context.emit('session/event', resumed as never, event('turn/start', { turn: 2 }, 13))
    context.emit('session/event', resumed as never, event('assistant/chunk', {
      turn: 2,
      step: 0,
      chunk: { type: 'text-delta', index: 0, text: 'streaming while following' },
    }, 14))
    context.emit('session/event', resumed as never, event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 15))
    await vt.waitForRender()
    assert.equal(probe.scrollToBottomCount, 0, 'ScrollView follow-end must handle live output without an imperative jump')
    assert.equal(readScroll().isFollowingEnd, true, 'a viewport following the end must remain attached to live output')
    const following = readScroll()
    assert.equal(following.scrollTop, following.maxScrollTop, JSON.stringify(following))
  } finally {
    if (fiber !== undefined) await fiber.dispose()
    if (context !== undefined) await disposeContext(context)
    probe.restore()
    restoreTerminal()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})

test('explicit cold resume shows the pre-mount status and clears it before mount; fresh start stays silent', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-startup-status-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const probe = installProbe()
  // Capture the runner's DIRECT stdout writes (the status seam) and the
  // cordis logger messages into ONE ordered log: the TUI itself writes
  // through the ProcessTerminal, so filtering for the status strings
  // isolates exactly the pre-mount status lines, and the shared order
  // lets the failure path assert that the status is suspended BEFORE the
  // failure logs (a TTY shares one cursor between stdout and stderr).
  const orderedLog: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((text: unknown) => {
    const line = String(text)
    orderedLog.push(`stdout:${line}`)
    return true
  }) as typeof process.stdout.write
  // The status seam is TTY-gated: force the test runner's piped stdout to
  // look interactive so the wiring is exercised (the pure helper tests
  // cover the non-TTY silence).
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  let resumeContext: Context | undefined
  let deferredContext: Context | undefined
  let failContext: Context | undefined
  let resumeFiber: { dispose: () => Promise<unknown> } | undefined
  let deferredFiber: { dispose: () => Promise<unknown> } | undefined
  let failFiber: { dispose: () => Promise<unknown> } | undefined
  try {
    const resumed: FakeSession = {
      id: 'startup-status-session',
      header: { id: 'startup-status-session', cwd: home, createdAt: 1_700_000_000_000, version: SESSION_FORMAT_VERSION },
      events: sessionEvents('resumed answer'),
    }
    const resumeHarness = makeHarness(home, resumed)
    resumeContext = new Context()
    resumeFiber = await mountRunner(resumeContext, home, resumeHarness, { sessionId: resumed.id }, { sessionId: resumed.id })
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
    deferredFiber = await mountRunner(deferredContext, home, deferredHarness, {}, {})
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
    const failHarness = makeHarness(home) // no persisted session
    const failCtx = new Context()
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
    failFiber = await mountRunner(failContext, home, failHarness, { sessionId: 'missing-session' }, { sessionId: 'missing-session' })
    const failWrites = orderedLog.filter(write => write.includes('Resuming session') || write === 'stdout:\r\x1b[2K')
    assert.ok(failWrites.some(write => write.includes('Resuming session…')),
      `the failed resume still shows the status: ${JSON.stringify(failWrites)}`)
    assert.ok(failWrites.some(write => write === 'stdout:\r\x1b[2K'),
      `the failed resume clears the status: ${JSON.stringify(failWrites)}`)
    const clearIndexInLog = orderedLog.findIndex(write => write === 'stdout:\r\x1b[2K')
    const warnIndexInLog = orderedLog.findIndex(write => write.startsWith('log:') && write.includes('resume missing-session failed'))
    assert.ok(clearIndexInLog >= 0 && warnIndexInLog > clearIndexInLog,
      `the status must be cleared BEFORE the failure log (clear at ${clearIndexInLog}, warn at ${warnIndexInLog}): ${JSON.stringify(orderedLog)}`)
  } finally {
    if (resumeFiber !== undefined) await resumeFiber.dispose()
    if (deferredFiber !== undefined) await deferredFiber.dispose()
    if (failFiber !== undefined) await failFiber.dispose()
    if (resumeContext !== undefined) await disposeContext(resumeContext)
    if (deferredContext !== undefined) await disposeContext(deferredContext)
    if (failContext !== undefined) await disposeContext(failContext)
    probe.restore()
    process.stdout.write = originalWrite
    if (originalIsTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
    else Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(home, { recursive: true, force: true })
  }
})
