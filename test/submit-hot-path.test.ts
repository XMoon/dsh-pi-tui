/**
 * Runner-level regression gates for the submit ownership model (plan
 * B/C/D): after the divergence-guard removal the Enter/Ctrl+S write path
 * must reach `followup` WITHOUT touching `sessionPersistence` at all —
 * the single-writer safety net is the DSH SessionWriteLease (kernel
 * flock), acquired by the Host at open/transition, never a per-submit
 * consistency probe. The submit work must be INDEPENDENT of the session
 * history length, and the local submit acknowledgement row must appear
 * with the submit gesture and settle on the first authoritative event.
 * @module @xmoon76/dsh-pi-tui/submit-hot-path.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ProcessTerminal } from '@xmoon76/pi-tui'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { apply as applyRunner, type Config } from '../src/index.ts'
import { apply as applyExtensionHost, PI_TUI_EXTENSIONS_SERVICE } from '../src/extensions.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { TuiApp } from '../src/tui-app.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

function event<K extends string>(
  type: K,
  data: (K extends SessionEvent['type'] ? SessionEvent<K>['data'] : Record<string, unknown>) & Record<string, unknown>,
  seq: number,
): SessionEvent {
  // DSH 0.1.2+ requires the top-level `surfaceOp` marker on surface-eligible
  // (message-producing) events — exactly user/message, assistant/message and
  // tool/result — and REJECTS the marker on log-only events
  // (packages/core/session/src/surface.ts). request/context is log-only.
  const surfaceOp = type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
    ? { surfaceOp: 'append' as const }
    : {}
  return { type, seq, time: 1_700_000_000_000 + seq * 1000, data, ...surfaceOp } as SessionEvent
}

/** A plain-text turn: user/message → assistant/message → boundaries. */
function turnEvents(turn: number, text: string, fromSeq: number): SessionEvent[] {
  return [
    event('turn/start', { turn }, fromSeq),
    event('step/start', { turn, step: 0 }, fromSeq + 1),
    event('user/message', {
      id: MessageId(`user-message-${turn}`),
      role: 'user',
      content: [{ type: 'text', text: `q${turn}` }],
      source: { kind: 'user' },
    }, fromSeq + 2),
    event('assistant/message', {
      turn,
      step: 0,
      message: {
        id: MessageId(`bootstrap-message-${turn}`),
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
      usage: { inputTokens: 10, outputTokens: 2 },
      stream: [],
    }, fromSeq + 3),
    event('step/end', { turn, step: 0 }, fromSeq + 4),
    event('turn/end', { turn, reason: { kind: 'completed' } }, fromSeq + 5),
  ]
}

function sessionEvents(text: string): SessionEvent[] {
  return turnEvents(0, text, 0)
}

/** `totalTurns` plain-text turns — the long-session fixture (proves the
 * submit path does no session-size-proportional work). */
function longSessionEvents(totalTurns: number): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let turn = 0; turn < totalTurns; turn += 1) {
    events.push(...turnEvents(turn, `answer ${turn}`, events.length))
  }
  return events
}

/** The alpha.4 Session shape: the backing log is private; production code
 * sees only the snapshot reads (compatibility-plan B4). */
interface LiveSession {
  id: string
  header: { id: string; cwd: string; createdAt: number; version: number }
  readonly seq: number
  eventAt(seq: number): SessionEvent | undefined
  snapshotEvents(): readonly SessionEvent[]
}

/** Build the alpha.4 Session mock over a private backing log. */
function makeLiveSession(id: string, header: LiveSession['header'], events: readonly SessionEvent[]): LiveSession {
  const log = [...events]
  return {
    id,
    header,
    get seq() { return log.length },
    eventAt: (seq: number) => log[seq],
    snapshotEvents: () => Object.freeze([...log]),
  }
}

interface FakeAgentHost {
  status: 'idle' | 'running'
  /** When set, the next write REJECTS (the failure-path gate). */
  failFollowup: boolean
  /** When set, the write rejects with a CANCELLATION-shaped error. */
  failFollowupAbort: boolean
  followedUp: unknown[]
  steered: unknown[]
  /** The skill-body fallback injections (agent.inject), in call order. */
  injected: unknown[]
}

function fakeAgent(session: LiveSession, host: FakeAgentHost | undefined): Agent {
  const agentContext = new Context()
  return {
    session,
    ctx: agentContext,
    options: { provider: 'p', model: 'm' },
    // The live inbox surface (queue gates and the steer snapshot).
    inbox: {
      nextTurn: [],
      nextStep: [],
      remove: (id: string) => { void id },
    },
    get status() { return host?.status ?? ('idle' as const) },
    whenIdle: async () => {},
    followup: (message: unknown) => {
      if (host?.failFollowupAbort === true) {
        const error = new Error('aborted')
        error.name = 'AbortError'
        ;(error as Error & { code?: string }).code = 'ABORT_ERR'
        throw error
      }
      if (host?.failFollowup === true) throw new Error('deliver boom')
      host?.followedUp.push(message)
    },
    steer: (message: unknown) => { host?.steered.push(message) },
    inject: (message: unknown) => { host?.injected.push(message) },
    cancel: (_reason: unknown, _options: { keepInbox: boolean }) => { /* the interrupt transport */ },
  } as unknown as Agent
}

interface CountingPersistenceProxy {
  proxy: unknown
  /** Persistence property accesses recorded while armed. */
  accesses: () => number
  /** The property NAMES accessed while armed (failure diagnostics). */
  accessed: () => string[]
  arm: () => void
  disarm: () => void
}

/** Wrap the harness persistence so EVERY property access is observable:
 * the submit gate asserts ZERO accesses while a submit runs — the write
 * path may not locate/stat/read through the persistence service. */
function countingProxy(persistence: Record<string, unknown>): CountingPersistenceProxy & { accessed: () => string[] } {
  let armed = false
  let count = 0
  const accessed: string[] = []
  const proxy = new Proxy(persistence, {
    get(target, prop, receiver) {
      if (armed) {
        count += 1
        accessed.push(String(prop))
      }
      const value = Reflect.get(target, prop, receiver)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    proxy,
    accesses: () => count,
    accessed: () => [...accessed],
    arm: () => { armed = true },
    disarm: () => { armed = false },
  }
}

function makeHarness(home: string, initial?: { id: string; events: SessionEvent[] }): {
  // (host is exposed for the failFollowup gate)
  counting: CountingPersistenceProxy
  agents: unknown
  sessions: unknown
  defaultModel: unknown
  commands: unknown
  host: FakeAgentHost
  /** Every `commands.execute` line, in call order (the command plane). */
  executed: { line: string }[]
  readonly session: LiveSession | undefined
  armCreateGate(): void
  releaseCreateGate(): void
} {
  const host: FakeAgentHost = { status: 'idle', failFollowup: false, failFollowupAbort: false, followedUp: [], steered: [], injected: [] }
  const persisted = new Map<string, LiveSession>()
  const live = new Map<string, Agent>()
  let liveSession: LiveSession | undefined
  if (initial !== undefined) {
    liveSession = makeLiveSession(initial.id, { id: initial.id, cwd: home, createdAt: 1_700_000_000_000, version: 0 }, initial.events)
    persisted.set(liveSession.id, liveSession)
  }
  const makeHandle = (session: LiveSession): { agent: Agent; dispose: () => Promise<void> } => {
    const agent = fakeAgent(session, host)
    live.set(session.id, agent)
    return {
      agent,
      dispose: async () => { live.delete(session.id) },
    }
  }
  const rawPersistence: Record<string, unknown> = {
    list: async () => [...persisted.values()].map(session => session.header),
    // DSH 0.1.2+ preset resolution materializes `meta` through the real
    // Session.fromRestore validation — the inspection must carry the header.
    inspect: async (id: unknown) => {
      const session = persisted.get(String(id))
      return { meta: session?.header, events: session === undefined ? [] : [...session.snapshotEvents()] }
    },
    readFrom: async (id: unknown, from: number) => ({
      events: (persisted.get(String(id))?.snapshotEvents() ?? []).slice(Number(from)),
    }),
    locate: ({ id }: { id: string; cwd?: string }) => ({ kind: 'session', path: join(home, 'sessions', `${id}.jsonl`) }),
  }
  const counting = countingProxy(rawPersistence)
  /** Deferred-create gate: armCreateGate() makes the NEXT create await
   * releaseCreateGate() — a deterministic slow-ensureSession regression.
   * (AGENTS.md trap: mutable state, not copied parameters.) */
  let createGate: Promise<void> | undefined
  let releaseCreateGate: (() => void) | undefined
  const armCreateGate = (): void => {
    createGate = new Promise<void>(resolve => { releaseCreateGate = resolve })
  }
  const agents = {
    create: async ({ sessionId }: { sessionId: string }) => {
      if (createGate !== undefined) await createGate
      const session = makeLiveSession(String(sessionId), { id: String(sessionId), cwd: home, createdAt: Date.now(), version: 0 }, [])
      persisted.set(session.id, session)
      return makeHandle(session)
    },
    resume: async ({ resumeSessionId }: { resumeSessionId: unknown }) => {
      const session = persisted.get(String(resumeSessionId))
      if (session === undefined) throw new Error(`unknown test session ${String(resumeSessionId)}`)
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
  const definitions = new Map<string, { name: string; description?: string; handler: (...args: never[]) => unknown }>()
  const executed: { line: string }[] = []
  const commands = {
    register: (definition: { name: string; handler: (...args: never[]) => unknown; description?: string; input?: { hint: string } }): (() => void) => {
      definitions.set(definition.name, definition)
      return () => {
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
      }
    },
    list: () => [...definitions.values()].map(({ name, description }) => ({ name, description: description ?? '', input: { hint: '' } })),
    find: () => undefined,
    // A REGISTERED command executes through the command plane (the Host
    // command semantics): the handler runs with a CommandRuntime-shaped
    // invocation, so a real handler (e.g. /skill → loadSkill) delivers
    // like production. A plain prompt is NOT a command: undefined falls
    // back to the follow-up delivery (the runner's real semantics). Only
    // ACTUAL executions are recorded — an attempted miss is not a command.
    execute: async (agent: unknown, line: string) => {
      const name = line.trim().replace(/^\//, '').split(/\s+/)[0] ?? ''
      const def = definitions.get(name)
      if (def === undefined) return undefined
      executed.push({ line })
      const rawInput = line.slice(line.indexOf(name) + name.length)
      const result = await (def.handler as (inv: unknown) => unknown)({
        commandId: CommandId('cmd-test'),
        agent,
        rawInput,
        signal: new AbortController().signal,
      })
      return { result }
    },
    handler: (name: string) => definitions.get(name)?.handler,
  }
  return {
    counting,
    agents,
    sessions,
    defaultModel,
    commands,
    host,
    executed,
    get session() { return liveSession as LiveSession | undefined as LiveSession },
    armCreateGate,
    releaseCreateGate: () => { releaseCreateGate?.() },
  }
}

async function disposeContext(ctx: Context): Promise<void> {
  for (const runtime of [...ctx.registry.values()]) {
    for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
  }
}

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

async function mountRunner(
  ctx: Context,
  home: string,
  harness: ReturnType<typeof makeHarness>,
  startup: { sessionId?: string },
  config: Config = {},
): Promise<{ dispose: () => Promise<void>; app: TuiApp }> {
  ctx.provide('appExit', () => {})
  // The startup service is normally provided here; an extension-hosting
  // harness provides it earlier (the extension host's `inject` gate needs it
  // mounted BEFORE the runner reads the service).
  if (ctx.get(TUI_STARTUP_SERVICE) === undefined) {
    ctx.provide(TUI_STARTUP_SERVICE, { ...startup, shippedPresetRoot: home })
  }
  ctx.provide('sessionPersistence', harness.counting.proxy as never)
  ctx.provide('agents', harness.agents as never)
  ctx.provide('sessions', harness.sessions as never)
  ctx.provide('agentDefaultModel', harness.defaultModel as never)
  ctx.provide('commands', harness.commands as never)
  ctx.provide('loader', { await: async () => {} } as never)
  let app: TuiApp | undefined
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function (this: TuiApp) {
    app = this
    return originalStart.call(this)
  }
  try {
    const fiber = ctx.plugin((pluginCtx) => applyRunner(pluginCtx, { sessionId: startup.sessionId, ...config }))
    await fiber
    for (let index = 0; index < 60; index += 1) await Promise.resolve()
  } finally {
    TuiApp.prototype.start = originalStart
  }
  assert.ok(app, 'the runner must mount a TuiApp')
  return {
    dispose: () => Promise.resolve(),
    app: app as TuiApp,
  }
}

/** Poll until the submission's terminal write lands on the fake agent.
 * Drains deterministic flushes (microtask batches + setImmediate — the
 * child_process events need the loop's poll phase; AGENTS.md trap: race
 * tests never poll fixed wall-clock delays). */
async function waitForDelivery(host: FakeAgentHost, label: string): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    if (host.followedUp.length > 0 || host.steered.length > 0) return
    for (let index = 0; index < 50; index += 1) await Promise.resolve()
    await new Promise<void>(resolve => process.nextTick(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.ok(host.followedUp.length > 0 || host.steered.length > 0,
    `${label}: the submission must reach the agent's inbox`)
}

/** The surface-eligible event types under DSH 0.1.2 (the exact set in
 * packages/core/session/src/types.ts `SurfaceEventType`). */
const SURFACE_ELIGIBLE_TYPES = ['user/message', 'assistant/message', 'tool/result'] as const

test('event fixtures carry surfaceOp exactly on the surface-eligible types (review round 1)', () => {
  // A seeded event the real Session.fromRestore validates must match DSH's
  // surface rules: the marker is REQUIRED on surface-eligible types and
  // FORBIDDEN on log-only ones (request/context included).
  const surfaceType = event('user/message', {
    id: MessageId('probe'),
    role: 'user',
    content: [{ type: 'text', text: 'q' }],
    source: { kind: 'user' },
  }, 0)
  assert.equal((surfaceType as SessionEvent & { surfaceOp?: unknown }).surfaceOp, 'append')
  const logOnlyType = event('request/context', {} as never, 1)
  assert.equal((logOnlyType as SessionEvent & { surfaceOp?: unknown }).surfaceOp, undefined)
  for (const type of SURFACE_ELIGIBLE_TYPES) {
    const marked = event(type, {} as never, 2) as SessionEvent & { surfaceOp?: unknown }
    assert.equal(marked.surfaceOp, 'append', `${type} must carry the marker`)
  }
  for (const type of ['turn/start', 'step/start', 'step/end', 'turn/end', 'request/context'] as const) {
    const unmarked = event(type, {} as never, 3) as SessionEvent & { surfaceOp?: unknown }
    assert.equal(unmarked.surfaceOp, undefined, `${type} must NOT carry the marker`)
  }
})

test('Enter: a submit reaches followup with ZERO sessionPersistence work (steady state)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-submit-hot-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const context = new Context()
  life.defer(() => disposeContext(context))
  const harness = makeHarness(home, { id: 'submit-session-a', events: sessionEvents('resumed answer') })
  const mounted = await mountRunner(context, home, harness, { sessionId: 'submit-session-a' })

  mounted.app.setDraft('hello world')
  harness.counting.arm()
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'submit')
  harness.counting.disarm()

  assert.equal(harness.counting.accesses(), 0,
    'a steady-state submit must not touch sessionPersistence (no locate/stat/readFrom/inspect)')
  assert.equal(harness.host.followedUp.length, 1, 'exactly one followup for one submit')
  const message = harness.host.followedUp[0] as { content: { type: string; text: string }[] }
  assert.equal(message.content[0]?.type, 'text')
  assert.equal(message.content[0]?.text, 'hello world')
})

test('Ctrl+S: a steer delivers without sessionPersistence work', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-submit-hot-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const context = new Context()
  life.defer(() => disposeContext(context))
  const harness = makeHarness(home, { id: 'submit-session-b', events: sessionEvents('resumed answer') })
  const mounted = await mountRunner(context, home, harness, { sessionId: 'submit-session-b' })
  harness.host.status = 'idle' // an idle Ctrl+S starts a regular turn (followup)
  mounted.app.setDraft('steer me')
  harness.counting.arm()
  const dispatched = (mounted.app as unknown as {
    actionDispatcher: { dispatch: (action: string, data?: string) => boolean }
  }).actionDispatcher.dispatch('app.input.steer')
  await waitForDelivery(harness.host, 'steer')
  harness.counting.disarm()
  assert.equal(dispatched, true, 'the steer action must be dispatched')
  assert.equal(harness.counting.accesses(), 0,
    'a Ctrl+S steer must not touch sessionPersistence (no locate/stat/readFrom)')
  assert.equal(harness.host.followedUp.length, 1, 'an idle agent takes the draft as a followup')
})

test('submit work does not scale with session history length', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-submit-hot-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const context = new Context()
  life.defer(() => disposeContext(context))
  // A LONG session: 1,000 turns = 6k log events. The submit path's
  // persistence work must stay ZERO — never proportional to history.
  const harness = makeHarness(home, { id: 'submit-session-long', events: longSessionEvents(1_000) })
  const mounted = await mountRunner(context, home, harness, { sessionId: 'submit-session-long' })
  mounted.app.setDraft('one more')
  harness.counting.arm()
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'long-session submit')
  harness.counting.disarm()
  assert.equal(harness.counting.accesses(), 0,
    `submit work must not grow with the session history (accessed: ${harness.counting.accessed().join(', ') || 'none'})`)
  assert.equal(harness.host.followedUp.length, 1)
})

test('the local submit ack appears with the gesture and settles on the first authoritative event', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-submit-hot-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const context = new Context()
  life.defer(() => disposeContext(context))
  const harness = makeHarness(home, { id: 'submit-session-c', events: sessionEvents('resumed answer') })
  const mounted = await mountRunner(context, home, harness, { sessionId: 'submit-session-c' })

  mounted.app.setDraft('hello again')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForRenderView(vt)
  const pending = vt.getViewport().join('\n')
  assert.ok(pending.includes('Submitting…'), `the ack row must appear with the gesture:\n${pending}`)

  // The FIRST authoritative event settles the row (agent/inbox/spliced
  // arrives as soon as the inbox accepted the followup).
  context.emit('session/event', harness.session as never, event('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [],
  }, 100) as never)
  await waitForRenderView(vt)
  const settled = vt.getViewport().join('\n')
  assert.ok(!settled.includes('Submitting…'), `the ack row must clear on the authoritative event:\n${settled}`)
})

test('a context `!` submit shows the ack DURING the run and settles on the authoritative event', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-submit-hot-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const context = new Context()
  life.defer(() => disposeContext(context))
  const harness = makeHarness(home, { id: 'submit-session-c', events: sessionEvents('resumed answer') })
  const mounted = await mountRunner(context, home, harness, { sessionId: 'submit-session-c' })

  // A context `!` line: the ack must appear AT THE GESTURE (while the
  // command still runs), not only after it settles.
  mounted.app.setDraft('!true')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForRenderView(vt)
  const during = vt.getViewport().join('\n')
  assert.ok(during.includes('Submitting…'), `the ack row must appear during the run:\n${during}`)

  // The command settles and the submit delivers; the row STAYS (never
  // cleared at delivery).
  await waitForDelivery(harness.host, 'shell submit')
  await waitForRenderView(vt)
  const delivered = vt.getViewport().join('\n')
  assert.ok(delivered.includes('Submitting…'), `the ack row must survive the delivery:\n${delivered}`)
  assert.equal(harness.host.followedUp.length, 1, 'the run output reached the session')

  // The authoritative inbox event ends the wait.
  context.emit('session/event', harness.session as never, event('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [],
  }, 100) as never)
  await waitForRenderView(vt)
  const settled = vt.getViewport().join('\n')
  assert.ok(!settled.includes('Submitting…'), `the ack row must clear on the event:\n${settled}`)
})

test('a cancelled `!` run ends the ack (no submit happens) — never stuck pending', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-submit-hot-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const context = new Context()
  life.defer(() => disposeContext(context))
  const harness = makeHarness(home, { id: 'submit-session-c', events: sessionEvents('resumed answer') })
  const mounted = await mountRunner(context, home, harness, { sessionId: 'submit-session-c' })

  // A slow context `!` run: the ack row shows during the run. The agent
  // is RUNNING so a single Esc fires the cancel directly (idle Esc only
  // arms the exit window).
  harness.host.status = 'running'
  mounted.app.setDraft('!sleep 0.3')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForRenderView(vt)
  assert.ok(vt.getViewport().join('\n').includes('Queued…'),
    'the ack row must be armed while the command runs (running: Queued…)')

  // The user cancels (Esc → app.agent.interrupt): the aborted gate
  // suppresses submitResult, and the abort must TERMINATE the ack row
  // (otherwise the pending "Submitting…" outlives the gesture forever).
  const dispatched = (mounted.app as unknown as {
    actionDispatcher: { dispatch: (action: string, data?: string) => boolean }
  }).actionDispatcher.dispatch('app.agent.interrupt')
  assert.equal(dispatched, true, 'the interrupt action must be dispatched')
  for (let round = 0; round < 60; round += 1) {
    await waitForRenderView(vt)
    if (!vt.getViewport().join('\n').includes('Submitting…')) break
    // The child exits on its own (sleep 0.3); drain deterministically
    // while the terminal settle propagates through the render loop.
    for (let index = 0; index < 50; index += 1) await Promise.resolve()
    await new Promise<void>(resolve => process.nextTick(resolve))
  }
  const settled = vt.getViewport().join('\n')
  assert.ok(!settled.includes('Submitting…'),
    `the cancelled run must clear the ack row (never stuck pending):\n${settled}`)
  assert.equal(harness.host.followedUp.length, 0,
    'an aborted run never submits its output')
})

test('a DEFERRED context `!` submit arms the ack BEFORE the session exists', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-submit-hot-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const context = new Context()
  life.defer(() => disposeContext(context))
  const harness = makeHarness(home) // NO initial session: a deferred start
  harness.armCreateGate() // session create resolves ONLY when released
  const mounted = await mountRunner(context, home, harness, {})

  mounted.app.setDraft('!true')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForRenderView(vt)
  // While ensureSession still awaits the (gated) create, the ack row
  // MUST already be visible — the deferred create is part of the
  // no-feedback window the local ack exists to cover (plan D).
  const during = vt.getViewport().join('\n')
  assert.ok(during.includes('Submitting…'),
    `the ack row must appear before the slow session create resolves:\n${during}`)
  assert.equal(harness.host.followedUp.length, 0, 'nothing delivered yet')

  // Release the create: the run executes and the submit delivers.
  harness.releaseCreateGate()
  await waitForDelivery(harness.host, 'deferred shell submit')
  assert.equal(harness.host.followedUp.length, 1)
})

/** Wait for one render pass through the virtual terminal. */
async function waitForRenderView(vt: VirtualTerminal): Promise<void> {
  await vt.waitForRender()
}

test('a Ctrl+S steer shows the ack until the authoritative event (never cleared at delivery)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-submit-hot-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const context = new Context()
  life.defer(() => disposeContext(context))
  const harness = makeHarness(home, { id: 'submit-session-d', events: sessionEvents('resumed answer') })
  const mounted = await mountRunner(context, home, harness, { sessionId: 'submit-session-d' })
  mounted.app.setDraft('steer ack')
  ;(mounted.app as unknown as {
    actionDispatcher: { dispatch: (action: string, data?: string) => boolean }
  }).actionDispatcher.dispatch('app.input.steer')
  await waitForDelivery(harness.host, 'steer ack')
  await waitForRenderView(vt)
  const pending = vt.getViewport().join('\n')
  assert.ok(pending.includes('Submitting…'),
    `the steer ack must stay visible after the delivery until the event:\n${pending}`)
  // The authoritative inbox event ends the wait.
  context.emit('session/event', harness.session as never, event('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [],
  }, 100) as never)
  await waitForRenderView(vt)
  const settled = vt.getViewport().join('\n')
  assert.ok(!settled.includes('Submitting…'), `the steer ack must clear on the event:\n${settled}`)
})

test('a session switch settles the ack: old-session pending never leaks', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-submit-hot-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const context = new Context()
  life.defer(() => disposeContext(context))
  const harness = makeHarness(home, { id: 'submit-session-e', events: sessionEvents('resumed answer') })
  const mounted = await mountRunner(context, home, harness, { sessionId: 'submit-session-e' })
  mounted.app.setDraft('hello switch')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForRenderView(vt)
  assert.ok(vt.getViewport().join('\n').includes('Submitting…'),
    'the ack row must be pending before the switch')
  // An ACTUAL session switch (transition commit) settles the old
  // session's pending row — it must never leak into the new session.
  const newHandler = (harness.commands as { handler(name: string): ((...args: never[]) => unknown) | undefined }).handler('new')
  assert.ok(newHandler, 'the runner must register the /new transition command')
  await (newHandler as () => Promise<void>)()
  await waitForRenderView(vt)
  const settled = vt.getViewport().join('\n')
  assert.ok(!settled.includes('Submitting…'), `old pending must clear on the switch:\n${settled}`)
})

test('a failed submit clears the pending row and surfaces the error', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-submit-hot-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const context = new Context()
  life.defer(() => disposeContext(context))
  const harness = makeHarness(home, { id: 'submit-session-f', events: sessionEvents('resumed answer') })
  harness.host.failFollowup = true // the write itself rejects
  const mounted = await mountRunner(context, home, harness, { sessionId: 'submit-session-f' })
  mounted.app.setDraft('hello boom')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40; round += 1) {
    await waitForRenderView(vt)
    if (!vt.getViewport().join('\n').includes('Submitting…')) break
    for (let index = 0; index < 50; index += 1) await Promise.resolve()
    await new Promise<void>(resolve => process.nextTick(resolve))
  }
  const settled = vt.getViewport().join('\n')
  assert.ok(!settled.includes('Submitting…'), `the failed submit must clear the ack row:\n${settled}`)
  assert.ok(settled.includes('submission failed'), `the failure must be surfaced:\n${settled}`)
})

test('the review repro: an older `!` run dying late NEVER clears the newer pending', async (t) => {
  // A = `!sleep 0.4` (slow run, ack armed under token A); B = `!echo done`
  // — starting B aborts A's controller, so A's killed child settles LATE
  // with a TERMINAL ack settle carrying token A. That settle must be
  // ignored: B's pending row survives until B's own authoritative event.
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-submit-hot-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const context = new Context()
  life.defer(() => disposeContext(context))
  const harness = makeHarness(home, { id: 'submit-session-h', events: sessionEvents('resumed answer') })
  const mounted = await mountRunner(context, home, harness, { sessionId: 'submit-session-h' })

  mounted.app.setDraft('!sleep 0.4')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  // B immediately: its runLocalShell aborts A's controller.
  mounted.app.setDraft('!echo done')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'the newer `!echo` submit')
  assert.equal(harness.host.followedUp.length, 1, 'only B\'s output is submitted')
  // A's child was killed and its late terminal settle (token A) fired or
  // will fire — EITHER WAY the row must still be pending for B.
  await waitForRenderView(vt)
  for (let round = 0; round < 30; round += 1) {
    for (let index = 0; index < 50; index += 1) await Promise.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  await waitForRenderView(vt)
  const during = vt.getViewport().join('\n')
  assert.ok(during.includes('Submitting…'),
    `the NEWER submission's pending row must survive the older run dying:\n${during}`)

  // B's authoritative inbox event settles the row.
  context.emit('session/event', harness.session as never, event('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    inserted: [],
  }, 100) as never)
  await waitForRenderView(vt)
  const settled = vt.getViewport().join('\n')
  assert.ok(!settled.includes('Submitting…'), `the row must clear on B's event:\n${settled}`)
})

test('a CANCELLED submit ends the ack through the onCancel sink (never stuck, no error notice)', async (t) => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-submit-hot-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 24)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  life.defer(restoreTerminal)
  const context = new Context()
  life.defer(() => disposeContext(context))
  const harness = makeHarness(home, { id: 'submit-session-g', events: sessionEvents('resumed answer') })
  harness.host.failFollowupAbort = true // the write rejects CANCELLATION-shaped
  const mounted = await mountRunner(context, home, harness, { sessionId: 'submit-session-g' })
  mounted.app.setDraft('hello cancel')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 60; round += 1) {
    await waitForRenderView(vt)
    if (!vt.getViewport().join('\n').includes('Submitting…')) break
    for (let index = 0; index < 50; index += 1) await Promise.resolve()
    await new Promise<void>(resolve => process.nextTick(resolve))
  }
  const settled = vt.getViewport().join('\n')
  assert.ok(!settled.includes('Submitting…'),
    `the cancelled submit must clear the ack row (never stuck pending):\n${settled}`)
  assert.ok(!settled.includes('submission failed'),
    'a CANCELLATION must not surface as a failure notice (runOwned routes it to onCancel only)')
  assert.equal(harness.host.followedUp.length, 0, 'nothing was written')
})
// ── Host-command arbitration (PR115-fix problem 1) ─────────────────────────
// A registered Host command (e.g. /compact) must execute through the command
// plane even while the agent is running: the busy queue/steer policy applies
// only to agent-facing prompts, never to a confirmed Host command (the
// command handler itself decides the busy outcome).

/** Poll until the submission reaches the command plane. */
async function waitForCommand(harness: ReturnType<typeof makeHarness>): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    if (harness.executed.length > 0) return
    for (let index = 0; index < 50; index += 1) await Promise.resolve()
    await new Promise<void>(resolve => process.nextTick(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.ok(harness.executed.length > 0, 'the submission must reach the command plane')
}

/** Poll until the per-skill wrapper command is registered (the mount-time
 * catalog refresh installs it asynchronously). Without the wrapper the
 * `/name args` line would be a plain prompt and the delivery assertions
 * would pass for the wrong reason. */
async function waitForSkillWrapper(harness: ReturnType<typeof makeHarness>, name: string): Promise<void> {
  for (let round = 0; round < 40; round += 1) {
    if ((harness.commands as { list(): readonly { name: string }[] }).list().some(def => def.name === name)) return
    for (let index = 0; index < 50; index += 1) await Promise.resolve()
    await new Promise<void>(resolve => process.nextTick(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.fail(`the ${name} skill wrapper must be registered`)
}

/** Boot a runner with a resumed session, optional pre-registered Host
 * commands, and a busyEnter preference. */
async function bootCommandHarness(
  t: TestContext,
  options: {
    busyEnter: 'queue' | 'steer'
    status: 'idle' | 'running'
    hostCommands?: readonly string[]
    /** Provide a skills registry (resolveSkill succeeds) and/or a tools
     * service shaped like the dsh-tool-skill loader (hostLoadsSkillBody). */
    skills?: boolean
    hostLoadsSkillBody?: boolean
    /** Extension command contributions to mount (owner metadata + the
     * plugin's own commands-service registration, like a real plugin). */
    extensionCommands?: readonly {
      id: string
      name: string
      description: string
      execution: 'local' | 'submission'
    }[]
  },
): Promise<{ harness: ReturnType<typeof makeHarness>; mounted: { dispose: () => Promise<void>; app: TuiApp } }> {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-command-arb-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const context = new Context()
  life.defer(() => disposeContext(context))
  const harness = makeHarness(home, { id: 'command-session', events: sessionEvents('resumed answer') })
  for (const name of options.hostCommands ?? []) {
    ;(harness.commands as { register(def: { name: string; handler: () => unknown }): void }).register({
      name,
      handler: () => ({ kind: 'success' }),
    })
  }
  if (options.skills === true) {
    const summary = {
      name: 'grilling',
      description: 'a skill',
      content: 'skill body',
      invocation: { userInvocable: true, modelInvocable: true },
      source: 'bundled',
      provider: 't',
    }
    context.provide('skills', {
      // The catalog read that installs the per-skill wrapper commands.
      list: async () => [summary],
      get: async () => summary,
    } as never)
  }
  if (options.hostLoadsSkillBody === true) {
    context.provide('tools', {
      get: (name: string) => name === 'skill' ? { execute: async () => {} } : undefined,
    } as never)
  }
  const doc: Record<string, unknown> = { busyEnter: options.busyEnter }
  context.provide('settings', {
    register: () => ({
      get: () => ({ ...doc }),
      replace: async (next: Record<string, unknown>) => { Object.assign(doc, next) },
    }),
  } as never)
  if (options.extensionCommands !== undefined) {
    // The extension host must be mounted BEFORE the runner reads its
    // service (the runner attaches a SurfaceHost over its ledger), and its
    // `inject` gate needs the startup service — provided here with the same
    // payload mountRunner would use. Each contribution is registered by a
    // plugin fiber, exactly like a real plugin (registerCommand is
    // fiber-bound).
    const contributions = options.extensionCommands
    context.provide(TUI_STARTUP_SERVICE, { sessionId: 'command-session', shippedPresetRoot: home })
    await context.plugin(applyExtensionHost)
    await context.plugin((pluginCtx) => {
      const service = pluginCtx.get(PI_TUI_EXTENSIONS_SERVICE) as {
        registerCommand(contribution: {
          id: string
          name: string
          description: string
          execution: 'local' | 'submission'
        }): unknown
      }
      for (const contribution of contributions) service.registerCommand(contribution)
    })
    for (const contribution of contributions) {
      // The plugin's own commands-service registration: the effective
      // completion surface (and with it the advertised claim) sees the
      // name, exactly like a real plugin's `ctx.commands.register`.
      ;(harness.commands as { register(def: { name: string; handler: () => unknown }): void }).register({
        name: contribution.name,
        handler: () => ({ kind: 'success' }),
      })
    }
  }
  const mounted = await mountRunner(context, home, harness, { sessionId: 'command-session' })
  harness.host.status = options.status
  return { harness, mounted }
}

test('idle /compact executes as a Host command: no followup, no queue, no prompt (PR115-fix problem 1)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, { busyEnter: 'queue', status: 'idle', hostCommands: ['compact'] })
  mounted.app.setDraft('/compact')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'the Host command must be executed')
  assert.equal(harness.executed[0]?.line, '/compact', 'the exact command line must reach the command plane')
  assert.equal(harness.host.followedUp.length, 0, 'no ordinary followup')
  assert.equal(harness.host.steered.length, 0, 'no steer')
})

test('running + queue: /compact executes, never enters the ordinary queue (PR115-fix problem 1)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, { busyEnter: 'queue', status: 'running', hostCommands: ['compact'] })
  mounted.app.setDraft('/compact')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'the command path must be taken while running')
  assert.equal(harness.host.followedUp.length, 0, 'no /compact may land in the ordinary inbox queue')
  assert.equal(harness.host.steered.length, 0, 'no steer')
  // The command handler owns the busy outcome (the TUI only routes to the
  // command plane — the Host decides busy/unavailable presentation).
})

test('running + steer: /compact executes, never steers into the turn (PR115-fix problem 1)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, { busyEnter: 'steer', status: 'running', hostCommands: ['compact'] })
  mounted.app.setDraft('/compact')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'the command path must be taken before the steer policy')
  assert.equal(harness.host.steered.length, 0, '/compact must never be steered as a prompt')
  assert.equal(harness.host.followedUp.length, 0, 'no followup')
})

test('running + queue: an ordinary prompt still queues (PR115-fix problem 1)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, { busyEnter: 'queue', status: 'running' })
  mounted.app.setDraft('hello world')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'queued prompt')
  assert.equal(harness.host.followedUp.length, 1, 'a plain prompt must keep the queue delivery')
  assert.equal(harness.host.steered.length, 0, 'queue preference never steers')
  assert.equal(harness.executed.length, 0, 'a plain prompt is not a command')
})

test('running + steer: an ordinary prompt still steers (PR115-fix problem 1)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, { busyEnter: 'steer', status: 'running' })
  mounted.app.setDraft('hello world')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'steered prompt')
  assert.equal(harness.host.steered.length, 1, 'a plain prompt must keep the steer delivery')
  assert.equal(harness.host.followedUp.length, 0, 'steer preference never queues')
  assert.equal(harness.executed.length, 0, 'a plain prompt is not a command')
})

test('running + steer: /skill <name> stays an agent-facing invocation (PR115-fix problem 1)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    skills: true,
    hostLoadsSkillBody: true,
  })
  mounted.app.setDraft('/skill grilling args')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'skill steer')
  // Agent-facing input, never a Host command: it STEERS (a Host command
  // would execute and never steer), through loadSkill's normalized
  // `/<name> <args>` line, and the host's pre-step listener owns the body.
  assert.equal(harness.host.steered.length, 1, 'a skill invocation must keep the agent-facing steer')
  const steered = harness.host.steered[0] as { content: { type: string; text: string }[] }
  assert.equal(steered.content[0]?.text, '/grilling args', 'the skill line must steer in its normalized /name args form')
  assert.equal(harness.host.followedUp.length, 0, 'the steer mode never queues')
  assert.equal(harness.host.injected.length, 0, 'the host loader owns the body injection')
})

test('running + queue: /skill <name> queues like a plain prompt when the host injects the body (web parity)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'running',
    skills: true,
    hostLoadsSkillBody: true,
  })
  mounted.app.setDraft('/skill grilling args')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'queued skill')
  // Web parity: a skill invocation is a plain agent-facing prompt — with
  // busyEnter=queue it QUEUES (followup), never steers into the running
  // turn. The host's dsh-tool-skill pre-step injects the body at the next
  // model request, so the queue delivery keeps the web message order.
  assert.equal(harness.host.followedUp.length, 1, 'the skill line must queue like a plain prompt')
  const followed = harness.host.followedUp[0] as { content: { type: string; text: string }[] }
  assert.equal(followed.content[0]?.text, '/grilling args', 'the queued line is the normalized /name args form')
  assert.equal(harness.host.steered.length, 0, 'queue preference must not steer the skill')
  assert.equal(harness.host.injected.length, 0, 'the host owns the body injection — no TUI fallback body')
})

test('running + queue: /skill <name> keeps the steer path when the TUI must inject the body itself (order-preserving fallback)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'running',
    skills: true,
  })
  mounted.app.setDraft('/skill grilling args')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'fallback skill steer')
  // Without the host loader the TUI injects the body into next-step: a
  // followup would let the body arrive BEFORE the user's words (the driver
  // claims next-step first), so the invocation keeps the steer path to
  // preserve the original-line-before-body order — the documented
  // exception to the queue preference.
  assert.equal(harness.host.steered.length, 1, 'the fallback keeps the order-preserving steer')
  const steered = harness.host.steered[0] as { content: { type: string; text: string }[] }
  assert.equal(steered.content[0]?.text, '/grilling args', 'the steered line is the normalized /name args form')
  assert.equal(harness.host.injected.length, 1, 'the TUI fallback injects the skill body')
  assert.equal(harness.host.followedUp.length, 0, 'no followup — the body order contract forbids it')
})

test('running + steer: the accelerated chord queues /skill <name> (delivery mode resolved once)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    skills: true,
    hostLoadsSkillBody: true,
  })
  mounted.app.setDraft('/skill grilling args')
  // The accelerated chord is the OPPOSITE of the busyEnter preference: with
  // busyEnter=steer it QUEUES. It is a property of THIS submission — the
  // skill delivery accepts the mode the submit boundary resolved and must
  // never re-derive it from the persisted preference, because a one-shot
  // gesture does not survive in settings.
  ;(mounted.app as unknown as { submitDraft(request?: string): void }).submitDraft('accelerated')
  await waitForDelivery(harness.host, 'accelerated skill')
  assert.equal(harness.host.followedUp.length, 1, 'the chord must force the queue delivery')
  const followed = harness.host.followedUp[0] as { content: { type: string; text: string }[] }
  assert.equal(followed.content[0]?.text, '/grilling args', 'the queued line is the normalized /name args form')
  assert.equal(harness.host.steered.length, 0, 'the chord must never steer')
  assert.equal(harness.host.injected.length, 0, 'the host owns the body injection — no TUI fallback body')
})

test('running + steer: the accelerated chord queues a per-skill wrapper (/grilling args)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    skills: true,
    hostLoadsSkillBody: true,
  })
  await waitForSkillWrapper(harness, 'grilling')
  mounted.app.setDraft('/grilling args')
  ;(mounted.app as unknown as { submitDraft(request?: string): void }).submitDraft('accelerated')
  await waitForDelivery(harness.host, 'accelerated skill wrapper')
  assert.equal(harness.executed.length, 1, 'the wrapper is a TUI command: it executes through the command plane')
  assert.equal(harness.executed[0]?.line, '/grilling args', 'the wrapper receives its own slash line')
  assert.equal(harness.host.followedUp.length, 1, 'the chord must force the queue delivery')
  const followed = harness.host.followedUp[0] as { content: { type: string; text: string }[] }
  assert.equal(followed.content[0]?.text, '/grilling args', 'the queued line is the original /name args line')
  assert.equal(harness.host.steered.length, 0, 'the chord must never steer')
  assert.equal(harness.host.injected.length, 0, 'the host owns the body injection — no TUI fallback body')
})

test('a dynamic Host command never enters the ordinary inbox while running (PR115-fix problem 1)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    hostCommands: ['test-host-command'],
  })
  mounted.app.setDraft('/test-host-command')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'the dynamic Host command must execute')
  assert.equal(harness.executed[0]?.line, '/test-host-command')
  assert.equal(harness.host.steered.length, 0, 'no steer — the fix is architectural, not a /compact special case')
  assert.equal(harness.host.followedUp.length, 0, 'no ordinary inbox entry')
})

// ── extension command ownership (PR115-fix problem 2) ──────────────────────
// An extension contribution declares its own `execution`: 'submission' flows
// through the session submission policy (steer/queue) like a skill
// invocation, 'local' never steers. Being advertised in the effective
// catalog does NOT make either a Host command: the busy policy (and the
// accelerated chord) must be consulted before any command plane execution.

test('running + steer: an extension submission command keeps the busy steer, never the Host claim', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    extensionCommands: [{ id: 'deploy', name: 'deploy', description: 'deploy the app', execution: 'submission' }],
  })
  mounted.app.setDraft('/deploy now')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'extension submission steer')
  assert.equal(harness.host.steered.length, 1, 'a submission command steers while the agent is running with busyEnter=steer')
  const steered = harness.host.steered[0] as { content: { type: string; text: string }[] }
  assert.equal(steered.content[0]?.text, '/deploy now', 'the raw command line travels as the agent prompt')
  assert.equal(harness.executed.length, 0, 'an advertised extension command must never be claimed as a Host command')
})

test('running + steer: the accelerated chord queues an extension submission command as a PROMPT', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    extensionCommands: [{ id: 'deploy', name: 'deploy', description: 'deploy the app', execution: 'submission' }],
  })
  mounted.app.setDraft('/deploy now')
  ;(mounted.app as unknown as { submitDraft(request?: string): void }).submitDraft('accelerated')
  await waitForDelivery(harness.host, 'queued extension submission')
  // `execution: 'submission'` means the command flows through the session
  // submission policy like a skill invocation: the resolved 'queue' mode
  // delivers its LINE (exactly like an unclaimed slash prompt), and the
  // plugin's command handler is NOT run ahead of the queue it asked to join.
  assert.equal(harness.host.followedUp.length, 1, 'the queue mode delivers the line as a queued prompt')
  const followed = harness.host.followedUp[0] as { content: { type: string; text: string }[] }
  assert.equal(followed.content[0]?.text, '/deploy now', 'the raw line is the queued prompt')
  assert.equal(harness.executed.length, 0, 'the queue mode must not execute the plugin command handler')
  assert.equal(harness.host.steered.length, 0, 'the chord must never steer')
})

test('running + queue: the DEFAULT preference makes the accelerated chord STEER (web parity)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, { busyEnter: 'queue', status: 'running' })
  mounted.app.setDraft('hello world')
  ;(mounted.app as unknown as { submitDraft(request?: string): void }).submitDraft('accelerated')
  await waitForDelivery(harness.host, 'accelerated prompt')
  // The web ComposerSubmissionPolicy (0.1.3-alpha.2) resolves the
  // accelerated gesture to the OPPOSITE of the preference: with the DEFAULT
  // busyEnter=queue it steers. A fixed "always queue" chord would get the
  // default configuration exactly backwards.
  assert.equal(harness.host.steered.length, 1, 'the accelerated chord steers under busyEnter=queue')
  const steered = harness.host.steered[0] as { content: { type: string; text: string }[] }
  assert.equal(steered.content[0]?.text, 'hello world', 'the draft rides the steer')
  assert.equal(harness.host.followedUp.length, 0, 'the chord must not queue under busyEnter=queue')
})

test('running + steer: an accelerated skill invocation queues (the opposite of the preference)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    skills: true,
    hostLoadsSkillBody: true,
  })
  mounted.app.setDraft('/skill grilling args')
  ;(mounted.app as unknown as { submitDraft(request?: string): void }).submitDraft('accelerated')
  await waitForDelivery(harness.host, 'accelerated skill')
  assert.equal(harness.host.followedUp.length, 1, 'the chord queues the skill invocation under busyEnter=steer')
  const followed = harness.host.followedUp[0] as { content: { type: string; text: string }[] }
  assert.equal(followed.content[0]?.text, '/grilling args', 'the queued line is the normalized /name args form')
  assert.equal(harness.host.steered.length, 0, 'the chord must never steer')
})

test('running + steer: a skill invocation WITHOUT the host loader still injects its body', async (t) => {
  // The stripped composition: the skills registry exists, the host's
  // dsh-tool-skill pre-step listener does not — so the TUI owns the body
  // injection (loadSkill's fallback). The steer path must therefore reach
  // loadSkill: a bare steered line would leave the model with no skill body
  // at all (the skill would silently not load).
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    skills: true,
  })
  mounted.app.setDraft('/skill grilling args')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'no-loader skill steer')
  assert.equal(harness.host.steered.length, 1, 'the invocation steers into the running turn')
  const steered = harness.host.steered[0] as { content: { type: string; text: string }[] }
  assert.equal(steered.content[0]?.text, '/grilling args', 'the steered line is the normalized /name args form')
  assert.equal(harness.host.injected.length, 1, 'the TUI fallback injects the skill body exactly once')
  const injected = harness.host.injected[0] as { content: { type: string; text: string }[] }
  assert.match(injected.content[0]?.text ?? '', /<skill_content name="grilling">/, 'the injected body is the official rendering')
})

test('running + steer: a no-loader per-skill wrapper also injects its body', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    skills: true,
  })
  await waitForSkillWrapper(harness, 'grilling')
  mounted.app.setDraft('/grilling args')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'no-loader wrapper steer')
  assert.equal(harness.executed.length, 1, 'the wrapper executes through the command plane')
  assert.equal(harness.executed[0]?.line, '/grilling args', 'the wrapper receives its own slash line')
  assert.equal(harness.host.steered.length, 1, 'the invocation steers into the running turn')
  assert.equal(harness.host.injected.length, 1, 'the TUI fallback injects the skill body exactly once')
})

test('running + steer: an extension local command still executes directly under both chords', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    extensionCommands: [{ id: 'panel', name: 'panel', description: 'toggle the panel', execution: 'local' }],
  })
  mounted.app.setDraft('/panel')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'an extension local command always executes locally')
  // The Ctrl+Enter chord cannot change a local command's ownership either.
  mounted.app.setDraft('/panel')
  ;(mounted.app as unknown as { submitDraft(request?: string): void }).submitDraft('accelerated')
  for (let round = 0; round < 20 && harness.executed.length < 2; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.equal(harness.executed.length, 2, 'the chord keeps the local execution')
  assert.equal(harness.host.steered.length, 0, 'local commands never steer')
})

test('running + steer: the Ctrl+Enter chord never turns a Host command into a queued prompt', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    hostCommands: ['compact'],
  })
  mounted.app.setDraft('/compact')
  ;(mounted.app as unknown as { submitDraft(request?: string): void }).submitDraft('accelerated')
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'a Host command owns its execution regardless of the chord')
  assert.equal(harness.host.followedUp.length, 0, 'the chord must not queue a Host command as a prompt')
  assert.equal(harness.host.steered.length, 0, 'the chord must not steer a Host command')
})
