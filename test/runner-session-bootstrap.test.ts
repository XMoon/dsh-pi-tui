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
}

interface RunnerHarness {
  readonly persistence: unknown
  readonly agents: unknown
  readonly sessions: unknown
  readonly defaultModel: unknown
  readonly commands: unknown
}

function fakeAgent(session: FakeSession): Agent {
  const agentContext = new Context()
  return {
    session,
    ctx: agentContext,
    options: { provider: 'p', model: 'm' },
    inbox: { nextTurn: [], nextStep: [] },
    whenIdle: async () => {},
  } as unknown as Agent
}

/** Build Direct services whose in-memory registry behaves like the real Host. */
function makeHarness(home: string, initial?: FakeSession): RunnerHarness {
  const persisted = new Map<string, FakeSession>()
  const live = new Map<string, Agent>()
  if (initial !== undefined) persisted.set(initial.id, initial)

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
    resume: async ({ resumeSessionId }: { resumeSessionId: unknown }) => {
      const session = persisted.get(String(resumeSessionId))
      if (session === undefined) throw new Error(`unknown test session ${String(resumeSessionId)}`)
      return makeHandle(session)
    },
    create: async ({ sessionId }: { sessionId: unknown }) => {
      const id = String(sessionId)
      const session: FakeSession = {
        id,
        header: { id, cwd: home, createdAt: Date.now(), version: SESSION_FORMAT_VERSION },
        events: sessionEvents('created answer'),
      }
      persisted.set(id, session)
      return makeHandle(session)
    },
    get: (id: string) => live.get(id),
  }
  const sessions = {
    flush: async () => {},
    get: (id: string) => live.get(id)?.session,
  }
  const defaultModel = {
    currentSelection: () => ({ provider: 'p', model: 'm' }),
    saveSelection: async () => {},
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
  return { persistence, agents, sessions, defaultModel, commands }
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
    apps: [],
    restore: () => {},
  }
  const originalTranscriptApply = TranscriptFolder.prototype.apply
  const originalStatsApply = StatsFolder.prototype.apply
  const originalTranscriptHydrate = TranscriptFolder.prototype.hydrate
  const originalStatsHydrate = StatsFolder.prototype.hydrate
  const originalSetTranscript = TuiApp.prototype.setTranscript
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
  TuiApp.prototype.start = function () {
    probe.apps.push(this)
    return originalStart.call(this)
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
  ctx.provide('commands', harness.commands as never)
  ctx.provide('loader', { await: async () => {} } as never)
  const fiber = ctx.plugin((pluginCtx) => applyRunner(pluginCtx, config))
  await fiber
  await settle()
  return fiber
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
      events: sessionEvents('resumed answer'),
    }
    const resumeHarness = makeHarness(home, resumed)
    resumeContext = new Context()
    resumeFiber = await mountRunner(resumeContext, home, resumeHarness, { sessionId: resumed.id }, { sessionId: resumed.id })
    assert.equal(probe.transcriptApplyCount, 1)
    assert.equal(probe.statsApplyCount, 1)
    assert.equal(probe.transcriptHydrateCount, 1)
    assert.equal(probe.statsHydrateCount, 1)
    assert.ok(probe.capturedMessages?.some(message => message.kind === 'assistant' && message.text === 'resumed answer'))

    const newHandler = (resumeHarness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
    assert.ok(newHandler, 'the real runner must register the /new transition command')
    await newHandler()
    await settle()
    assert.equal(probe.transcriptApplyCount, 2)
    assert.equal(probe.statsApplyCount, 2)
    assert.equal(probe.transcriptHydrateCount, 2)
    assert.equal(probe.statsHydrateCount, 2)
    assert.ok(probe.capturedMessages?.some(message => message.kind === 'assistant' && message.text === 'created answer'))

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
    app.setDraft('first deferred prompt')
    ;(app as unknown as { submitDraft(): void }).submitDraft()
    await settle()
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
