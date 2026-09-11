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
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ProcessTerminal } from '@xmoon76/pi-tui'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
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
  // DSH 0.1.5-rc.1 requires the top-level `surfaceOp` marker on surface-eligible
  // (message-producing) events — exactly user/message, assistant/message and
  // tool/result — and REJECTS the marker on log-only events
  // (packages/core/session/src/surface.ts). request/context is log-only.
  const surfaceOp = type === 'user/message' || type === 'assistant/message' || type === 'tool/result'
    ? { surfaceOp: 'append' as const }
    : {}
  return { type, seq: SessionSeq(seq), time: 1_700_000_000_000 + seq * 1000, data, ...surfaceOp } as SessionEvent
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

/** The current Session shape: the backing log is private; production code
 * sees only the snapshot reads (compatibility-plan B4). */
interface LiveSession {
  id: string
  header: { id: string; cwd: string; createdAt: number; version: number }
  readonly seq: number
  eventAt(seq: number): SessionEvent | undefined
  snapshotEvents(): readonly SessionEvent[]
}

/** Build the current Session mock over a private backing log. */
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
  /** Every `commands.execute` call, in order (the command plane), with the
   * submitted attachments the client handed over. */
  executed: { line: string; attachments: readonly unknown[]; outcome: 'executed' | 'rejected' }[]
  readonly session: LiveSession | undefined
  /** The session ids `agents.create` produced (the deferred-start gate). */
  createdSessionIds: string[]
  /** Register a hook that runs as each session is created. */
  /** Register a hook that runs as each session is created. The harness
   * AWAITS it, so an async hook (e.g. registering a late contribution) is
   * deterministic and a rejection fails the creation loudly — never a bare
   * fire-and-forget promise. */
  onCreateSession(hook: (sessionId: string) => void | Promise<void>): void
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
    // DSH 0.1.5-rc.1 preset resolution materializes `meta` through the real
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
  const createdSessionIds: string[] = []
  /** Test hook: invoked with each CREATED session id, before the handle is
   * returned — the place a session-scoped host catalog can appear. */
  let onCreateSession: ((sessionId: string) => void | Promise<void>) | undefined
  const agents = {
    create: async ({ sessionId }: { sessionId: string }) => {
      createdSessionIds.push(String(sessionId))
      await onCreateSession?.(String(sessionId))
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
  const definitions = new Map<string, {
    name: string
    description?: string
    input?: { hint: string; attachments?: boolean }
    handler: (...args: never[]) => unknown
  }>()
  const executed: { line: string; attachments: readonly unknown[]; outcome: 'executed' | 'rejected' }[] = []
  const commands = {
    register: (definition: {
      name: string
      handler: (...args: never[]) => unknown
      description?: string
      input?: { hint: string; attachments?: boolean }
    }): (() => void) => {
      definitions.set(definition.name, definition)
      return () => {
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
      }
    },
    // The effective catalog mirrors the registry EXACTLY, the descriptor's
    // input kind included: `input` is the DSH distinction between a
    // `leadingInput` command (`/goal <objective>`) and an execute-kind one
    // (`/compact`). Fabricating an `input` for every row would erase the
    // command KIND and let a name-level routing bug pass.
    list: () => [...definitions.values()].map(({ name, description, input }) => ({
      name,
      description: description ?? '',
      ...(input === undefined ? {} : { input }),
    })),
    // The real commands service resolves a definition by name for the
    // global layer too (`find(undefined, name)`); the harness mirrors it so
    // a TUI-owned sessionless command runs LOCALLY in a deferred start
    // instead of falling through to the session dispatch.
    find: (_agent: unknown, name: string) => definitions.get(name),
    // A REGISTERED command executes through the command plane (the Host
    // command semantics): the handler runs with a CommandRuntime-shaped
    // invocation, so a real handler (e.g. /skill → loadSkill) delivers
    // like production. A plain prompt is NOT a command: undefined falls
    // back to the follow-up delivery (the runner's real semantics). Only
    // ACTUAL executions are recorded — an attempted miss is not a command.
    execute: async (agent: unknown, line: string, attachments: readonly unknown[] = []) => {
      const name = line.trim().replace(/^\//, '').split(/\s+/)[0] ?? ''
      const def = definitions.get(name)
      // A name that does not resolve is NOT a command-plane call (the submit
      // falls back to the ordinary delivery). A RESOLVED invocation is
      // recorded WITH its settled outcome: the real host executor appends its
      // lifecycle pair even when admission refuses it — the handler just
      // never runs — so a refusal must stay visible as a refusal, never
      // counted as an execution. The REAL executor enforces the descriptor
      // declaration at admission: attachments sent to a command that does not
      // declare `input.attachments` settle as an error result BEFORE the
      // handler runs (dsh-commands `execute`). The fake mirrors it, so an
      // integration test cannot pass by handing the host a payload it would
      // refuse.
      if (def === undefined) return undefined
      if (attachments.length > 0 && def.input?.attachments !== true) {
        executed.push({ line, attachments: [...attachments], outcome: 'rejected' })
        return { result: { kind: 'error', text: `/${name} does not accept attachments` } }
      }
      executed.push({ line, attachments: [...attachments], outcome: 'executed' })
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
    createdSessionIds,
    onCreateSession: (hook: (sessionId: string) => void | Promise<void>) => { onCreateSession = hook },
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

/** Drain microtasks + nextTick + the poll phase until `ready` or a bounded
 * deadline. Load-tolerant on purpose: the FULL product suite mounts many
 * surfaces in parallel, so a pure iteration budget is not enough for work
 * that depends on real fs/timer scheduling (the attachment intake), and a
 * fixed sleep is not allowed. Returns the final readiness. */
async function drainUntil(ready: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (ready()) return true
    if (Date.now() >= deadline) return false
    for (let index = 0; index < 50; index += 1) await Promise.resolve()
    await new Promise<void>(resolve => process.nextTick(resolve))
    await new Promise<void>(resolve => setImmediate(resolve))
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

/** The surface-eligible event types under DSH 0.1.5-rc.1 (the exact set in
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
    /** Pre-registered Host commands. A bare NAME registers the execute-kind
     * shape (DSH `CommandDescriptor` without `input`: `/compact`), which
     * claims its BARE token only; the object form registers the exact
     * descriptor, so a `leadingInput` command (`/goal <objective>`) can claim
     * its argued line. */
    hostCommands?: readonly (string | { name: string; input: { hint: string; attachments?: boolean } })[]
    /** Provide a skills registry (resolveSkill succeeds) and/or a tools
     * service shaped like the dsh-tool-skill loader (hostLoadsSkillBody). */
    skills?: boolean
    hostLoadsSkillBody?: boolean
    /** Mount WITHOUT a resumed session (the deferred-start gate). */
    deferredStart?: boolean
    /** Provide a recording fake `ctx.attachments` (image admission
     * observability: `imageSaves` records each `saveImages` batch). */
    attachments?: boolean
    /** Extension command contributions to mount (owner metadata + the
     * plugin's own commands-service registration, like a real plugin). */
    extensionCommands?: readonly {
      id: string
      name: string
      description: string
      /** The contribution's client behavior (the bridge handler). */
      bridgeHandler: () => { kind: 'success' | 'error'; text?: string } | Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
      sessionless?: boolean
      /** Whether the plugin ALSO registers a commands-service definition for
       * the same name (a HOST-command collision: the host claim wins and the
       * candidate synthesis fails loud). Default false — a client command is
       * bridge-only, exactly like the vim fixture. */
      registerDefinition?: boolean
      /** The descriptor of that host definition: a `leadingInput` command
       * (the DSH `/goal` shape) claims its argued line; absent = the
       * execute-kind shape (`/compact`), which claims the bare token only. */
      hostInput?: { hint: string; attachments?: boolean }
    }[]
  },
): Promise<{
  harness: ReturnType<typeof makeHarness>
  mounted: { dispose: () => Promise<void>; app: TuiApp }
  /** Register a contribution AFTER the mount (a late/HMR plugin). */
  registerContribution(contribution: {
    id: string
    name: string
    description: string
    sessionless?: boolean
    bridgeHandler: () => { kind: 'success' | 'error'; text?: string }
  }): Promise<void>
  /** The recorded image-admission batches (only with `attachments: true`). */
  imageSaves: readonly (readonly { mediaType: string; byteLength: number }[])[]
  /** The recorded FILE admissions (only with `attachments: true`). */
  fileSaves: readonly { name: string | undefined; byteLength: number }[]
  /** Dispose one pre-registered `hostCommands` definition (a catalog name that
   * disappears — e.g. while a deferred session is being created). */
  disposeHostCommand(name: string): void
  /** The mounted extension service (health assertions). */
  extensionService: {
    _ledger(): {
      healthSnapshot(): readonly { id: string; owner: string; extensionPoint: string; state: string; lastError?: string }[]
    }
  }
}> {
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
  const imageSaves: { mediaType: string; byteLength: number }[][] = []
  const fileSaves: { name: string | undefined; byteLength: number }[] = []
  if (options.attachments === true) {
    context.provide('attachments', {
      imageLimits: {
        maxImageBytes: 20 * 1024 * 1024,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 200 * 1024 * 1024,
        maxImagePixels: 64_000_000,
        maxImageDimension: 8192,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      saveImages: async (inputs: readonly { mediaType: string; data: Uint8Array }[]) => {
        imageSaves.push(inputs.map(input => ({ mediaType: input.mediaType, byteLength: input.data.byteLength })))
        return inputs.map((input, index) => ({
          attachmentId: `att-${imageSaves.length}-${index}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 1,
          height: 1,
        }))
      },
      // The streamed file-admission seam (a plain prompt or an argued
      // command-name line carries its FILE drafts through the model path): the
      // fake drains the stream and records the bytes it actually received.
      saveFileStream: async (input: { data: AsyncIterable<Uint8Array>; name?: string }) => {
        let bytes = 0
        for await (const chunk of input.data) bytes += chunk.byteLength
        fileSaves.push({ name: input.name, byteLength: bytes })
        return { attachmentId: `file-${fileSaves.length}`, name: input.name ?? 'file', bytes }
      },
    } as never)
  }
  const harness = makeHarness(home, { id: 'command-session', events: sessionEvents('resumed answer') })
  const hostCommandDisposers = new Map<string, () => void>()
  for (const entry of options.hostCommands ?? []) {
    const command: { name: string; input?: { hint: string; attachments?: boolean } } =
      typeof entry === 'string' ? { name: entry } : entry
    const dispose = (harness.commands as {
      register(def: { name: string; handler: () => unknown; input?: { hint: string; attachments?: boolean } }): () => void
    }).register({
      name: command.name,
      handler: () => ({ kind: 'success' }),
      ...(command.input === undefined ? {} : { input: command.input }),
    })
    hostCommandDisposers.set(command.name, dispose)
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
  let extensionService: unknown
  const registerContribution = async (contribution: {
    id: string
    name: string
    description: string
    sessionless?: boolean
    bridgeHandler: () => { kind: 'success' | 'error'; text?: string } | Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
  }): Promise<void> => {
    const { bridgeHandler, ...spec } = contribution
    await context.plugin((pluginCtx) => {
      const service = pluginCtx.get(PI_TUI_EXTENSIONS_SERVICE) as {
        registerCommand(contribution: {
          id: string; name: string; description: string; sessionless?: boolean
          handler: () => { kind: 'success' | 'error'; text?: string } | Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
        }): unknown
      }
      service.registerCommand({ ...spec, handler: bridgeHandler })
    })
    // The service batcher flushes the invalidation into the surface's
    // completion refresh on a later tick.
    for (let round = 0; round < 20; round += 1) await new Promise<void>(resolve => setImmediate(resolve))
  }
  if (options.extensionCommands !== undefined) {
    // The extension host must be mounted BEFORE the runner reads its
    // service (the runner attaches a SurfaceHost over its ledger), and its
    // `inject` gate needs the startup service — provided here with the same
    // payload mountRunner would use. Each contribution is registered by a
    // plugin fiber, exactly like a real plugin (registerCommand is
    // fiber-bound).
    const contributions = options.extensionCommands
    context.provide(TUI_STARTUP_SERVICE, { ...options.deferredStart === true ? {} : { sessionId: 'command-session' }, shippedPresetRoot: home })
    await context.plugin(applyExtensionHost)
    extensionService = context.get(PI_TUI_EXTENSIONS_SERVICE)
    await context.plugin((pluginCtx) => {
      const service = pluginCtx.get(PI_TUI_EXTENSIONS_SERVICE) as {
        registerCommand(contribution: {
          id: string
          name: string
          description: string
          sessionless?: boolean
          handler: () => { kind: 'success' | 'error'; text?: string } | Promise<{ kind: 'success'; text?: string } | { kind: 'error'; text: string }>
        }): unknown
      }
      for (const contribution of contributions) {
        const { bridgeHandler, registerDefinition: _registerDefinition, ...spec } = contribution
        service.registerCommand({ ...spec, handler: bridgeHandler })
      }
    })
    for (const contribution of contributions) {
      // Bridge-only by default (the client-command pattern); a test that
      // wants the HOST-command collision opts in explicitly.
      if (contribution.registerDefinition !== true) continue
      // The plugin's own commands-service registration: the effective
      // completion surface (and with it the advertised claim) sees the
      // name, exactly like a real plugin's `ctx.commands.register`.
      ;(harness.commands as {
        register(def: { name: string; handler: () => unknown; input?: { hint: string; attachments?: boolean } }): void
      }).register({
        name: contribution.name,
        handler: () => ({ kind: 'success' }),
        ...(contribution.hostInput === undefined ? {} : { input: contribution.hostInput }),
      })
    }
  }
  const mounted = await mountRunner(context, home, harness,
    options.deferredStart === true ? {} : { sessionId: 'command-session' })
  harness.host.status = options.status
  return {
    harness,
    mounted,
    registerContribution,
    imageSaves,
    fileSaves,
    disposeHostCommand: (name: string) => { hostCommandDisposers.get(name)?.() },
    extensionService: extensionService as {
      _ledger(): {
        healthSnapshot(): readonly { id: string; owner: string; extensionPoint: string; state: string; lastError?: string }[]
      }
    },
  }
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

// The claim belongs to the LINE, not to the name (DSH `CommandDescriptor.input`
// + `CommandUiRuntime.matchEnter`): an execute-kind command (`/compact`, no
// `input`) claims its BARE token only, so its argued line is an ordinary
// submission and follows the busy policy like any other prompt.

test('running + queue: an argued execute-kind line queues as an ordinary followup', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, { busyEnter: 'queue', status: 'running', hostCommands: ['compact'] })
  mounted.app.setDraft('/compact extra')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'argued execute-kind line')
  assert.equal(harness.executed.length, 0, 'an argued execute-kind line is not a command invocation')
  assert.equal(harness.host.followedUp.length, 1, 'it takes the ordinary queue delivery')
  assert.equal(harness.host.steered.length, 0, 'the queue preference never steers')
})

test('running + steer: an argued execute-kind line steers as an ordinary prompt', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, { busyEnter: 'steer', status: 'running', hostCommands: ['compact'] })
  mounted.app.setDraft('/compact extra')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'argued execute-kind line')
  assert.equal(harness.executed.length, 0, 'an argued execute-kind line is not a command invocation')
  assert.equal(harness.host.steered.length, 1, 'it takes the ordinary steer delivery')
  assert.equal(harness.host.followedUp.length, 0, 'the steer preference never queues')
})

test('running + accelerated chord: an argued execute-kind line takes the OPPOSITE policy', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, { busyEnter: 'queue', status: 'running', hostCommands: ['compact'] })
  mounted.app.setDraft('/compact extra')
  ;(mounted.app as unknown as { submitDraft(request?: string): void }).submitDraft('accelerated')
  await waitForDelivery(harness.host, 'accelerated argued execute-kind line')
  assert.equal(harness.executed.length, 0, 'the chord cannot turn the line into a command either')
  assert.equal(harness.host.steered.length, 1, 'the accelerated chord takes the opposite of the queue preference')
  assert.equal(harness.host.followedUp.length, 0, 'the chord must not queue')
})

test('a leadingInput host command claims its argued line under the busy policy (/goal <objective>)', async (t) => {
  // The other half of the line-level rule: a descriptor WITH `input` claims
  // its argued line, so the busy queue/steer policy never applies to it.
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    hostCommands: [{ name: 'goal', input: { hint: '<objective>' } }],
  })
  mounted.app.setDraft('/goal ship it')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'a leadingInput invocation executes through the command plane')
  assert.equal(harness.executed[0]?.line, '/goal ship it', 'the host receives the raw argued line')
  assert.equal(harness.executed[0]?.outcome, 'executed', 'the handler runs')
  assert.equal(harness.host.steered.length, 0, 'a claimed command is never steered')
  assert.equal(harness.host.followedUp.length, 0, 'a claimed command never queues')
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
// The DSH client command contribution model: a contribution is a CLIENT-OWNED
// command (menu row + client handler). A name that is also a host command is a
// COLLISION: the host claim wins and the candidate synthesis fails loud —
// never a silent shadow, never a downgrade to a model prompt.

test('a client command colliding with a host command never shadows it: the host runs, the client handler does not', async (t) => {
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    extensionCommands: [{
      id: 'deploy', name: 'deploy', description: 'deploy the app',
      bridgeHandler: () => { calls.push('deploy'); return { kind: 'success' } },
      // The plugin ALSO registers a commands-service definition: the host
      // catalog resolves /deploy, so the client contribution collides.
      registerDefinition: true,
      // The `leadingInput` shape (`/goal <objective>`): the host claims the
      // argued line, which is the line this test submits.
      hostInput: { hint: '<target>' },
    }],
  })
  mounted.app.setDraft('/deploy now')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'the HOST command keeps its claim and executes through the plane')
  assert.equal(harness.executed[0]?.line, '/deploy now', 'the host command receives the raw line')
  assert.deepEqual(calls, [], 'the client handler must not run for a host-claimed line')
  assert.equal(harness.host.steered.length, 0, 'a host command is never steered')
  assert.equal(harness.host.followedUp.length, 0, 'a host command is never downgraded to a model prompt')
})

test('a name the host catalog resolves with an UNCLAIMED line never runs the colliding client handler', async (t) => {
  // The collision state (the candidate synthesis failed and withdrew the
  // source, but the bridge contribution is still live) with an EXECUTE-KIND
  // host command: the host catalog resolves /compact, and `/compact extra` is
  // not an invocation. The line is an ordinary submission — upstream
  // `matchEnter` returns undefined before any contribution route — so the
  // same-named client handler must not run and the model receives the line.
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    extensionCommands: [{
      id: 'compact-cmd', name: 'compact', description: 'client compact',
      bridgeHandler: () => { calls.push('compact'); return { kind: 'success' } },
      // The plugin ALSO registers the commands-service definition, so the
      // host catalog resolves /compact and the synthesis fails loud.
      registerDefinition: true,
    }],
  })
  const rows = mounted.app.commandCompletionsForTest()
  assert.equal(rows.some(row => row.name === 'compact'), false,
    'the failed source offers no rows (the collision is live)')
  mounted.app.setDraft('/compact extra')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'unclaimed line of a host-resolved name')
  assert.deepEqual(calls, [], 'the colliding client handler must not run for a line the host catalog did not claim')
  assert.equal(harness.executed.length, 0, 'the command plane is never asked to run it either')
  assert.equal(harness.host.steered.length, 1, 'the busy policy applies: it is an ordinary submission')
  assert.equal(harness.host.followedUp.length, 0, 'the steer preference never queues')
  const steered = harness.host.steered[0] as { content: readonly { type: string; text?: string }[] }
  assert.deepEqual(steered.content.map(block => block.text), ['/compact extra'],
    'the MODEL receives the raw line')
})

test('an unclaimed line of a host-resolved name keeps its attachment: ordinary multimodal submission', async (t) => {
  // The same collision state with a staged image: the attachment gate must not
  // classify the line as a local client command (the host catalog resolves the
  // name, so the contribution is not the owner), the image rides the ordinary
  // submission, and no command refusal is surfaced.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-unclaimed-host-line-')
  const path = join(root, 'shot.png')
  await writeFile(path, pngHeader(2, 2))
  const calls: string[] = []
  const { harness, mounted, imageSaves } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    attachments: true,
    extensionCommands: [{
      id: 'compact-cmd', name: 'compact', description: 'client compact',
      bridgeHandler: () => { calls.push('compact'); return { kind: 'success' } },
      registerDefinition: true,
    }],
  })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  assert.match(staged, /\[image #1/, `the image is staged: ${JSON.stringify(staged)}`)
  mounted.app.setDraft(`/compact ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'unclaimed image line')
  assert.equal(mounted.app.notifyTextForTest(), '', 'no local-command refusal is surfaced')
  assert.deepEqual(calls, [], 'the colliding client handler never runs')
  assert.ok(!harness.executed.some(entry => entry.line.startsWith('/compact')),
    `never the command plane: ${JSON.stringify(harness.executed)}`)
  assert.equal(imageSaves.length, 1, 'the image is admitted through the ordinary model path')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string }[] }
  assert.deepEqual(delivered.content.map(block => block.type), ['text', 'image'],
    'the model receives the multimodal prompt')
})

test('a host/client name collision fails the candidate synthesis loud (never a partial menu)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    extensionCommands: [{
      id: 'deploy', name: 'deploy', description: 'deploy the app',
      bridgeHandler: () => ({ kind: 'success' }),
      registerDefinition: true,
      hostInput: { hint: '<target>' },
    }],
  })
  // The synthesis pass throws; the containment seam marks the command SOURCE
  // failed (upstream `source-failed` parity: the source's whole group is
  // removed) — no command row is offered until a synthesis succeeds again.
  const rows = mounted.app.commandCompletionsForTest()
  assert.equal(rows.some(entry => entry.name === 'deploy'), false,
    'the failed source offers no command rows (client or host)')
  // The HOST CLAIM was refreshed before the merge, so the input authority is
  // untouched even while the menu is empty.
  mounted.app.setDraft('/deploy prod')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'the host command keeps its claim and executes')
  assert.equal(harness.host.followedUp.length, 0, 'never a model prompt')
})

test('running + queue: the DEFAULT preference makes the accelerated chord STEER (web parity)', async (t) => {
  const { harness, mounted } = await bootCommandHarness(t, { busyEnter: 'queue', status: 'running' })
  mounted.app.setDraft('hello world')
  ;(mounted.app as unknown as { submitDraft(request?: string): void }).submitDraft('accelerated')
  await waitForDelivery(harness.host, 'accelerated prompt')
  // The web ComposerSubmissionPolicy (DSH 0.1.5-rc.1) resolves the
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

test('a live LOCAL command runs its bridge handler — never the model', async (t) => {
  // A bridge-only local contribution (no commands-service definition) is a
  // real plugin pattern (e.g. the vim fixture): with a LIVE session the line
  // used to fall through to the command plane, miss, and be delivered to the
  // MODEL as a prompt — the plugin's handler never ran. A local command is
  // in-process by contract.
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'running',
    extensionCommands: [{
      id: 'vimmode', name: 'vimmode', description: 'toggle vim mode',
      bridgeHandler: () => { calls.push('vimmode'); return { kind: 'success' } },
    }],
  })
  mounted.app.setDraft('/vimmode')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && calls.length === 0; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.deepEqual(calls, ['vimmode'], 'the live local command must run its bridge handler')
  assert.equal(harness.host.followedUp.length, 0, 'a local command must never reach the model')
  assert.equal(harness.host.steered.length, 0, 'a local command never steers')
  assert.equal(harness.executed.length, 0, 'a bridge-only contribution has no command-plane definition')
})

test('a live LOCAL command prefers its bridge handler over the commands definition', async (t) => {
  // When BOTH exist the bridge handler is the implementation (public-types:
  // "absent = the commands service handler runs") — the commands plane is
  // the fallback, not the first choice.
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'running',
    extensionCommands: [{
      id: 'panel', name: 'panel', description: 'toggle the panel',
      bridgeHandler: () => { calls.push('panel'); return { kind: 'success' } },
    }],
  })
  mounted.app.setDraft('/panel')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && calls.length === 0; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.deepEqual(calls, ['panel'], 'the bridge handler must run')
  assert.equal(harness.executed.length, 0, 'the commands definition is only the fallback')
  assert.equal(harness.host.followedUp.length, 0, 'a local command must never reach the model')
})

test('a bridge-only client command joins the `/` menu (discoverable without a host definition)', async (t) => {
  const { mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    extensionCommands: [{
      id: 'vimmode', name: 'vimmode', description: 'toggle vim mode',
      bridgeHandler: () => ({ kind: 'success' }),
    }],
  })
  const rows = mounted.app.commandCompletionsForTest()
  const row = rows.find(entry => entry.name === 'vimmode')
  assert.ok(row !== undefined, `the client command must appear in the menu: ${JSON.stringify(rows.map(r => r.name))}`)
  assert.equal(row?.description, 'toggle vim mode', 'the menu row carries the contribution description')
})

test('a client command is session-backed by default: the session resolves BEFORE the handler', async (t) => {
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    extensionCommands: [{
      id: 'deploy', name: 'deploy', description: 'deploy',
      bridgeHandler: () => { calls.push('deploy'); return { kind: 'success' } },
    }],
  })
  mounted.app.setDraft('/deploy')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && calls.length === 0; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.deepEqual(calls, ['deploy'], 'the client handler runs')
  assert.equal(harness.createdSessionIds.length, 1,
    'a session-backed client command resolves the session first (the host command surface is session-keyed)')
})

test('a host command that appears only AFTER the deferred session outranks the client contribution', async (t) => {
  // Deferred start: the standing catalog does not resolve /deploy, so the
  // submission is classified as a client command. The session-scoped host
  // catalog then provides /deploy — the live claim must win; running the
  // client handler would shadow a host command (upstream: the host catalog is
  // session-keyed and a collision never shadows it).
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    extensionCommands: [{
      id: 'deploy', name: 'deploy', description: 'deploy',
      bridgeHandler: () => { calls.push('deploy'); return { kind: 'success' } },
    }],
  })
  harness.onCreateSession(() => {
    ;(harness.commands as {
      register(def: { name: string; handler: () => unknown; input?: { hint: string; attachments?: boolean } }): void
    }).register({
      name: 'deploy',
      handler: () => ({ kind: 'success' }),
      // The `leadingInput` shape: the argued line below is a real invocation.
      input: { hint: '<target>' },
    })
  })
  mounted.app.setDraft('/deploy prod')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'the LATE host claim executes through the command plane')
  assert.equal(harness.executed[0]?.line, '/deploy prod', 'the host command receives the raw line')
  assert.deepEqual(calls, [], 'the client handler must not run once the live host catalog claims the line')
  assert.equal(harness.host.followedUp.length, 0, 'never downgraded to a model prompt')
  assert.equal(harness.host.steered.length, 0, 'never steered')
})

test('a deferred session that resolves an execute-kind host command does not run its argued line', async (t) => {
  // A deferred start whose standing catalog does not resolve /compact: the
  // command plane is initially the decider. The session then commits an
  // EXECUTE-KIND /compact, so `/compact extra` is NOT an invocation
  // (upstream `matchEnter`: `if (!bare) return undefined`) — the plane's final
  // ownership must be re-asked after ensureSession(), or the host registry
  // resolves the NAME and runs the command anyway.
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    extensionCommands: [{ id: 'stub-cmd', name: 'stub', description: 'stub', bridgeHandler: () => ({ kind: 'success' }) }],
  })
  harness.onCreateSession(() => {
    // No `input`: the execute-kind shape.
    ;(harness.commands as { register(def: { name: string; handler: () => unknown }): void })
      .register({ name: 'compact', handler: () => ({ kind: 'success' }) })
  })
  mounted.app.setDraft('/compact extra')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'late execute-kind argued line')
  assert.ok(!harness.executed.some(entry => entry.line.startsWith('/compact')),
    `the late execute-kind command never runs its argued line: ${JSON.stringify(harness.executed)}`)
  assert.equal(harness.host.followedUp.length, 1, 'the line is an ordinary submission')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string; text?: string }[] }
  assert.deepEqual(delivered.content.map(block => block.text), ['/compact extra'],
    'the MODEL receives the raw line')
  assert.doesNotMatch(mounted.app.notifyTextForTest(), /not available in the created session/,
    'an ordinary submission is never consumed as an advertised command miss')
})

test('a contribution that appears DURING the deferred window never turns an ordinary image line into a local command', async (t) => {
  // The line is a generic ordinary submission when it is made: no host command
  // resolves /deploy and no client contribution exists, so its route is the
  // model (upstream `matchEnter` checks the contribution ONCE, before the
  // session work). A bridge contribution registered while the session is being
  // created must not reclassify the line as a UI control under the final
  // authority — the routing already decided, the new handler never runs, and
  // the image is an ordinary multimodal submission.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-late-contribution-')
  const path = join(root, 'shot.png')
  await writeFile(path, pngHeader(3, 3))
  const calls: string[] = []
  const { harness, mounted, imageSaves, registerContribution } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    attachments: true,
    // Mount the extension host with an unrelated contribution so
    // `registerContribution` has a live service to register into; /deploy
    // itself is registered later, during the deferred window.
    extensionCommands: [{ id: 'stub-cmd', name: 'stub', description: 'stub', bridgeHandler: () => ({ kind: 'success' }) }],
  })
  // The harness AWAITS this hook: the contribution is provably live before the
  // session resolves (so the dispatch really classifies against it), and a
  // registration failure fails the creation loudly instead of becoming an
  // invisible unhandled rejection.
  harness.onCreateSession(async () => {
    await registerContribution({
      id: 'late-cmd', name: 'deploy', description: 'late deploy',
      bridgeHandler: () => { calls.push('deploy'); return { kind: 'success' } },
    })
  })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  assert.match(staged, /\[image #1/, `the image is staged: ${JSON.stringify(staged)}`)
  mounted.app.setDraft(`/deploy ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'late contribution with an image')
  assert.equal(mounted.app.notifyTextForTest(), '', 'no local-command refusal is surfaced')
  assert.deepEqual(calls, [], 'the late contribution never runs for a line it did not own')
  assert.ok(!harness.executed.some(entry => entry.line.startsWith('/deploy')),
    `never the command plane: ${JSON.stringify(harness.executed)}`)
  assert.equal(imageSaves.length, 1, 'the image is admitted through the ordinary model path')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string }[] }
  assert.deepEqual(delivered.content.map(block => block.type), ['text', 'image'],
    'the model receives the multimodal prompt')
})

test('a DISAPPEARED host name never turns an attachment-bearing line into a local command', async (t) => {
  // The execute-kind -> unresolved mutation with a staged IMAGE and a
  // same-named bridge contribution: the host catalog resolved /deploy (a known
  // non-invocation) when the line was submitted, so the contribution never
  // owned it. When the name then disappears from the session's catalog, the
  // late attachment classification must not fall back to the contribution and
  // refuse the line as a local command — it is an ordinary multimodal
  // submission.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-vanished-host-attachment-')
  const path = join(root, 'shot.png')
  await writeFile(path, pngHeader(2, 2))
  const calls: string[] = []
  const { harness, mounted, imageSaves, disposeHostCommand } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    attachments: true,
    // Execute-kind at submit time; a bridge contribution shares the name.
    hostCommands: ['deploy'],
    extensionCommands: [{
      id: 'deploy-cmd', name: 'deploy', description: 'client deploy',
      bridgeHandler: () => { calls.push('deploy'); return { kind: 'success' } },
    }],
  })
  harness.onCreateSession(() => { disposeHostCommand('deploy') })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  assert.match(staged, /\[image #1/, `the image is staged: ${JSON.stringify(staged)}`)
  mounted.app.setDraft(`/deploy ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'vanished host name with an image')
  assert.equal(mounted.app.notifyTextForTest(), '', 'no local-command refusal is surfaced')
  assert.deepEqual(calls, [], 'the colliding client handler never runs')
  assert.ok(!harness.executed.some(entry => entry.line.startsWith('/deploy')),
    `never the command plane: ${JSON.stringify(harness.executed)}`)
  assert.equal(imageSaves.length, 1, 'the image is admitted through the ordinary model path')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string }[] }
  assert.deepEqual(delivered.content.map(block => block.type), ['text', 'image'],
    'the model receives the multimodal prompt')
})

test('a deferred session where the host name DISAPPEARS keeps the argued line an ordinary submission', async (t) => {
  // The execute-kind -> unresolved mutation. The standing catalog resolves
  // /deploy as EXECUTE-KIND, so `/deploy prod` is a known NON-invocation when
  // submitted; the name then vanishes from the session's catalog. An
  // unresolved name normally leaves the decision to the plane (a
  // session-scoped command the standing view cannot see), but no
  // disappearance turns a line that was already not an invocation into one —
  // and the submit-time advertised claim must not consume it as a miss either.
  const { harness, mounted, disposeHostCommand } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    // Execute-kind at submit time (no `input`).
    hostCommands: ['deploy'],
  })
  harness.onCreateSession(() => { disposeHostCommand('deploy') })
  mounted.app.setDraft('/deploy prod')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'disappeared host name')
  assert.ok(!harness.executed.some(entry => entry.line.startsWith('/deploy')),
    `the vanished command is never asked to run the argued line: ${JSON.stringify(harness.executed)}`)
  assert.equal(harness.host.followedUp.length, 1, 'the line is an ordinary submission')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string; text?: string }[] }
  assert.deepEqual(delivered.content.map(block => block.text), ['/deploy prod'],
    'the MODEL receives the raw line')
  assert.doesNotMatch(mounted.app.notifyTextForTest(), /not available in the created session/,
    'a known non-invocation is never consumed as an advertised command miss, even when the name disappears')
})

test('a deferred session that resolves a leadingInput host command executes its argued line', async (t) => {
  // The reverse descriptor mutation: the standing catalog resolves /deploy as
  // EXECUTE-KIND, so `/deploy prod` is not an invocation when submitted. The
  // session then commits a `leadingInput` /deploy — the argued line IS an
  // invocation for the FINAL catalog, so the plane must run it.
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    // Execute-kind at submit time (no `input`).
    hostCommands: ['deploy'],
  })
  harness.onCreateSession(() => {
    ;(harness.commands as {
      register(def: { name: string; handler: () => unknown; input?: { hint: string } }): void
    }).register({ name: 'deploy', handler: () => ({ kind: 'success' }), input: { hint: '<target>' } })
  })
  mounted.app.setDraft('/deploy prod')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'the final leadingInput claim owns the argued line')
  assert.equal(harness.executed[0]?.line, '/deploy prod', 'the host command receives the raw line')
  assert.equal(harness.host.followedUp.length, 0, 'never downgraded to a model prompt')
})

test('a deferred session that resolves an EXECUTE-KIND host command takes the argued line back', async (t) => {
  // The exact claimed -> unclaimed mutation (the reverse of the test above): the
  // standing catalog CLAIMS `/deploy prod` (a `leadingInput` descriptor), so the
  // submission is routed to the command plane. The committed session then
  // resolves /deploy as EXECUTE-KIND, where the argued line is NOT an
  // invocation — the plane's ownership must be re-asked after ensureSession(),
  // or the old submit-time answer would run the command by NAME. The line is an
  // ordinary submission, and it is NOT consumed as an advertised miss: its name
  // WAS advertised at submit time, so the miss gate must follow the final
  // (non-plane) answer too.
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    // `leadingInput` at submit time: `/deploy prod` is a real invocation.
    hostCommands: [{ name: 'deploy', input: { hint: '<target>' } }],
  })
  harness.onCreateSession(() => {
    // The session's catalog replaces the descriptor with the execute-kind
    // shape (no `input`).
    ;(harness.commands as { register(def: { name: string; handler: () => unknown }): void })
      .register({ name: 'deploy', handler: () => ({ kind: 'success' }) })
  })
  mounted.app.setDraft('/deploy prod')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'claimed -> unclaimed argued line')
  assert.ok(!harness.executed.some(entry => entry.line.startsWith('/deploy')),
    `the final execute-kind command never runs its argued line: ${JSON.stringify(harness.executed)}`)
  assert.equal(harness.host.followedUp.length, 1, 'the line is an ordinary submission')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string; text?: string }[] }
  assert.deepEqual(delivered.content.map(block => block.text), ['/deploy prod'],
    'the MODEL receives the raw line')
  assert.doesNotMatch(mounted.app.notifyTextForTest(), /not available in the created session/,
    'the submit-time advertised claim must not consume a line the plane no longer owns')
})

/** A minimal PNG header (magic + IHDR): the intake parses headers only, so a
 * header is a complete fixture for the image attachment paths. */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const set32 = (offset: number, value: number): void => {
    bytes[offset] = (value >>> 24) & 0xff
    bytes[offset + 1] = (value >>> 16) & 0xff
    bytes[offset + 2] = (value >>> 8) & 0xff
    bytes[offset + 3] = value & 0xff
  }
  set32(16, width)
  set32(20, height)
  return bytes
}

/** Stage ONE real generic-file attachment through the REAL `/attach`
 * sessionless command: the intake inserts its placeholder into the editor,
 * which is exactly the draft text the user submits next. */
async function stageAttachmentDraft(
  harness: { commands: unknown },
  mounted: { app: TuiApp },
  path: string,
): Promise<string> {
  // The runner registers its TUI commands during mount, and the mount's
  // readiness can lag under a loaded suite (the full product run mounts many
  // surfaces in parallel): submitting before `/attach` is registered makes the
  // line fall back to the session dispatch, where the intake lands much later.
  // The readiness signal is the REGISTRATION, never the completion ROW: a
  // colliding client contribution fails the candidate synthesis as a whole
  // (upstream `source-failed`), so the row list is legitimately EMPTY in those
  // harnesses while `/attach` itself is perfectly routable.
  await drainUntil(
    () => (harness.commands as { list(): readonly { name: string }[] }).list().some(def => def.name === 'attach'),
    10_000,
  )
  mounted.app.setDraft(`/attach ${path}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  // The intake then reads the file through real fs I/O in a detached workflow.
  const staged = await drainUntil(() => /\[(file|image) #1/.test(mounted.app.getDraft()), 10_000)
  const draft = mounted.app.getDraft()
  assert.ok(staged,
    `the attachment intake staged nothing (draft=${JSON.stringify(draft)}, notice=${JSON.stringify(mounted.app.notifyTextForTest())})`)
  return draft
}

test('an attachment-bearing client command defers to a LATE declared host claim (delivered, then consumed)', async (t) => {
  // Deferred start + a session-backed client contribution + a REAL staged
  // IMAGE. The standing view classifies the line LOCAL (the contribution),
  // but the session commits a host command that DECLARES
  // `input.attachments` — it takes the line and receives the encoded image
  // (web composer parity: the leading claim's submit passes the attachments
  // through). Success then CONSUMES the draft.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-deferred-attachment-')
  const path = join(root, 'shot.png')
  await writeFile(path, pngHeader(2, 2))
  const calls: string[] = []
  const { harness, mounted, imageSaves } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    attachments: true,
    extensionCommands: [{
      id: 'deploy', name: 'deploy', description: 'deploy',
      bridgeHandler: () => { calls.push('deploy'); return { kind: 'success' } },
    }],
  })
  harness.onCreateSession(() => {
    ;(harness.commands as {
      register(def: { name: string; handler: () => unknown; input?: { hint: string; attachments?: boolean } }): void
    }).register({ name: 'deploy', handler: () => ({ kind: 'success' }), input: { hint: '', attachments: true } })
  })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  assert.match(staged, /\[image #1/, `the image is staged through the real intake: ${JSON.stringify(staged)}`)
  assert.deepEqual(harness.createdSessionIds, [], 'the sessionless intake creates no session')
  mounted.app.setDraft(`/deploy ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'the LATE declared host claim owns the line')
  assert.match(harness.executed[0]?.line ?? '', /^\/deploy /, 'the host command receives the raw line')
  assert.equal(harness.executed[0]?.outcome, 'executed', 'the declared command is admitted by the executor')
  const submitted = harness.executed[0]?.attachments[0] as { type: string; mediaType: string; data: string; name?: string }
  assert.equal(harness.executed[0]?.attachments.length, 1, 'the declared command receives the submitted image')
  assert.equal(submitted.type, 'image')
  assert.equal(submitted.mediaType, 'image/png')
  assert.equal(submitted.name, 'shot.png')
  assert.deepEqual([...Buffer.from(submitted.data, 'base64')], [...pngHeader(2, 2)],
    'the EXACT encoded bytes ride the command invocation (no re-encode, no drop)')
  assert.deepEqual(calls, [], 'the client handler never runs once the session claims the name')
  assert.equal(harness.host.followedUp.length, 0, 'never downgraded to a model prompt')
  assert.deepEqual(imageSaves, [], 'a command submission is admitted by the HOST, not saved locally')
  // CONSUME-ON-SUCCESS: the same placeholder re-submitted as a PLAIN prompt
  // is ordinary text now — a surviving draft would be admitted (saveImages).
  mounted.app.setDraft(staged.trim())
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'consumed placeholder')
  assert.deepEqual(imageSaves, [], 'the consumed attachment is not re-admitted by a later submit')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string; text?: string }[] }
  assert.deepEqual([...delivered.content], [{ type: 'text', text: staged.trim() }], 'the line stays plain text')
})

// Both agent-facing skill forms: the explicit `/skill <name> ...` invocation
// (`/skill` is itself a registered TUI command, so the policy must not treat
// it as a non-declaring HOST command) and a live skill WRAPPER (TUI-owned,
// no host declaration either). In both, the placeholder line stays on the
// delivery path and the image is admitted there — never handed to the command
// plane, whose executor rejects attachments for a command that does not
// declare them.
for (const form of [
  { label: 'explicit /skill <name>', line: (staged: string) => `/skill grilling ${staged.trim()}` },
  { label: 'skill wrapper', line: (staged: string) => `/grilling ${staged.trim()}` },
] as const) {
  test(`a skill invocation with an image stays agent-facing (${form.label})`, async (t) => {
    const life = testLifecycle(t)
    const root = life.tempDir('dsh-pi-tui-skill-attachment-')
    const path = join(root, 'shot.png')
    await writeFile(path, pngHeader(5, 5))
    const { harness, mounted, imageSaves } = await bootCommandHarness(t, {
      busyEnter: 'queue',
      status: 'idle',
      skills: true,
      hostLoadsSkillBody: true,
      attachments: true,
    })
    await waitForSkillWrapper(harness, 'grilling')
    const staged = await stageAttachmentDraft(harness, mounted, path)
    assert.match(staged, /\[image #1/, `the image is staged: ${JSON.stringify(staged)}`)
    mounted.app.setDraft(form.line(staged))
    ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
    await waitForDelivery(harness.host, `${form.label} with an image`)
    assert.equal(harness.host.followedUp.length, 1, 'the skill invocation is delivered')
    assert.ok(!mounted.app.notifyTextForTest().includes('does not accept attachments'),
      `a skill invocation is never refused as a command: ${mounted.app.notifyTextForTest()}`)
    assert.equal(imageSaves.length, 1, 'the image is admitted through the agent-facing path')
    const delivered = harness.host.followedUp[0] as { content: readonly { type: string }[] }
    assert.ok([...delivered.content].some(block => block.type === 'image'),
      `the image rides the skill prompt: ${JSON.stringify(delivered.content)}`)
    // The command plane either never saw the line (wrapper) or carried it with
    // NO attachments (`/skill`): the host executor would have rejected them,
    // and the fake mirrors that rejection as a recorded outcome.
    for (const call of harness.executed) {
      assert.equal(call.outcome, 'executed', `${call.line} must not be refused by the executor`)
      assert.equal(call.attachments.length, 0, `no command-plane payload for ${call.line}`)
    }
  })
}

test('an unknown slash line that becomes an UNDECLARED host command refuses its attachment (deferred authority)', async (t) => {
  // Deferred start with NO client contribution for the name: the standing
  // view cannot classify the line, so the composer lets the attachment
  // through. The session then commits a session-scoped host command that does
  // NOT declare `input.attachments` — the dispatch must re-apply the composer
  // policy against the FINAL catalog before the command plane runs. The host
  // executor only validates the SUBMITTED payload, so passing `[]` would let
  // the handler run with the placeholder as a raw argument and then consume
  // the draft: the attachment would be silently dropped. The command is
  // `leadingInput` (`input.hint`): its argued line IS an invocation, which is
  // exactly the line an attachment-bearing refusal has to catch.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-late-host-attachment-')
  const path = join(root, 'shot.png')
  await writeFile(path, pngHeader(6, 6))
  const { harness, mounted, imageSaves } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    attachments: true,
    extensionCommands: [{ id: 'stub-cmd', name: 'stub', description: 'stub', bridgeHandler: () => ({ kind: 'success' }) }],
  })
  harness.onCreateSession(() => {
    ;(harness.commands as {
      register(def: { name: string; handler: () => unknown; input?: { hint: string; attachments?: boolean } }): void
    }).register({ name: 'deploy', handler: () => ({ kind: 'success' }), input: { hint: '<target>' } })
  })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  assert.match(staged, /\[image #1/, `the image is staged: ${JSON.stringify(staged)}`)
  assert.deepEqual(harness.createdSessionIds, [], 'the sessionless intake creates no session')
  mounted.app.setDraft(`/deploy ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await drainUntil(() => /does not accept attachments/.test(mounted.app.notifyTextForTest()), 5000)
  assert.match(mounted.app.notifyTextForTest(), /\/deploy does not accept attachments; remove them first/)
  assert.ok(!harness.executed.some(entry => entry.line.startsWith('/deploy')),
    `the undeclared late claim never reaches the command plane: ${JSON.stringify(harness.executed)}`)
  assert.equal(harness.host.followedUp.length, 0, 'never a model prompt')
  assert.deepEqual(imageSaves, [], 'nothing is admitted either')
  assert.match(mounted.app.getDraft(), /^\/deploy /, 'the draft comes back')
  assert.match(mounted.app.getDraft(), /\[image #1/, 'with its attachment placeholder intact')
  assert.equal(harness.createdSessionIds.length, 1, 'the authority resolution ran (the session is session-keyed)')
})

test('an unknown slash line that becomes a DECLARED host command delivers and consumes its attachment', async (t) => {
  // The same deferred authority, with the command DECLARING
  // `input.attachments`: the encoded image must ride the command invocation
  // (the dispatch-side re-check must not over-refuse), and success consumes
  // the draft.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-late-host-attachment-')
  const path = join(root, 'shot.png')
  await writeFile(path, pngHeader(7, 7))
  const { harness, mounted, imageSaves } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    attachments: true,
    extensionCommands: [{ id: 'stub-cmd', name: 'stub', description: 'stub', bridgeHandler: () => ({ kind: 'success' }) }],
  })
  harness.onCreateSession(() => {
    ;(harness.commands as {
      register(def: { name: string; handler: () => unknown; input?: { hint: string; attachments?: boolean } }): void
    }).register({ name: 'deploy', handler: () => ({ kind: 'success' }), input: { hint: '', attachments: true } })
  })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  mounted.app.setDraft(`/deploy ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await drainUntil(() => harness.executed.some(entry => entry.line.startsWith('/deploy')), 5000)
  const call = harness.executed.find(entry => entry.line.startsWith('/deploy'))
  assert.equal(call?.outcome, 'executed', `the declared late claim is admitted: ${JSON.stringify(harness.executed)}`)
  assert.equal(call?.attachments.length, 1, 'the declared command receives the submitted image')
  assert.equal(harness.host.followedUp.length, 0, 'never a model prompt')
  assert.deepEqual(imageSaves, [], 'the host admits the image, not the client')
  // CONSUME-ON-SUCCESS: the same placeholder as a plain prompt is plain text.
  mounted.app.setDraft(staged.trim())
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'consumed late-host placeholder')
  assert.deepEqual(imageSaves, [], 'the consumed attachment is not re-admitted')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string; text?: string }[] }
  assert.deepEqual([...delivered.content], [{ type: 'text', text: staged.trim() }], 'the line stays plain text')
})

test('an unknown slash line that becomes a DECLARED host command still refuses a FILE (no receipt seam)', async (t) => {
  // The late-authority policy covers FILES too: a declared command receives
  // images, never a file (the host expects an upload receipt this client
  // cannot produce). Without the dispatch-side re-check the placeholder line
  // would run with an empty payload and the success path would CONSUME the
  // file draft — a silent drop of a user attachment.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-late-host-attachment-')
  const path = join(root, 'report.pdf')
  await writeFile(path, Buffer.from('%PDF-1.7\nbody'))
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    attachments: true,
    extensionCommands: [{ id: 'stub-cmd', name: 'stub', description: 'stub', bridgeHandler: () => ({ kind: 'success' }) }],
  })
  harness.onCreateSession(() => {
    ;(harness.commands as {
      register(def: { name: string; handler: () => unknown; input?: { hint: string; attachments?: boolean } }): void
    }).register({ name: 'deploy', handler: () => ({ kind: 'success' }), input: { hint: '', attachments: true } })
  })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  assert.match(staged, /\[file #1/, `the file is staged: ${JSON.stringify(staged)}`)
  mounted.app.setDraft(`/deploy ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await drainUntil(() => /cannot receive file attachments/.test(mounted.app.notifyTextForTest()), 5000)
  assert.match(mounted.app.notifyTextForTest(), /\/deploy cannot receive file attachments in this client; remove them first/)
  assert.ok(!harness.executed.some(entry => entry.line.startsWith('/deploy')),
    `the file-bearing invocation never reaches the command plane: ${JSON.stringify(harness.executed)}`)
  assert.equal(harness.host.followedUp.length, 0, 'never a model prompt')
  assert.match(mounted.app.getDraft(), /\[file #1/, 'the file draft comes back unconsumed')
})

// A `!`/`!!` shell line is a local UI control: the shell neither admits nor
// consumes drafts, so a staged attachment must be refused BEFORE the
// placeholder can become shell arguments (and before the success path could
// consume it).
for (const form of [
  { label: 'context `!`', line: (staged: string) => `!echo ${staged.trim()}` },
  { label: 'local `!!`', line: (staged: string) => `!!echo ${staged.trim()}` },
] as const) {
  test(`a shell line never carries an attachment placeholder into the shell (${form.label})`, async (t) => {
    const life = testLifecycle(t)
    const root = life.tempDir('dsh-pi-tui-shell-attachment-')
    const marker = join(root, 'shell-ran.marker')
    const image = join(root, 'shot.png')
    await writeFile(image, pngHeader(8, 8))
    const { harness, mounted } = await bootCommandHarness(t, {
      busyEnter: 'queue',
      status: 'idle',
      attachments: true,
    })
    const staged = await stageAttachmentDraft(harness, mounted, image)
    assert.match(staged, /\[image #1/, `the image is staged: ${JSON.stringify(staged)}`)
    // The shell command would create the marker if it ever ran.
    mounted.app.setDraft(form.line(staged).replace('echo ', `touch ${marker} # `))
    ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
    for (let round = 0; round < 40 && !/Attachments cannot be included/.test(mounted.app.notifyTextForTest()); round += 1) {
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    // The strongest signal first: a shell that ran would have created the
    // marker (the placeholder text is passed as shell arguments).
    assert.equal(existsSync(marker), false, 'the shell never ran with the placeholder')
    assert.match(mounted.app.notifyTextForTest(), /Attachments cannot be included in a local command\./)
    assert.equal(harness.host.followedUp.length, 0, 'nothing is posted to the session')
    assert.match(mounted.app.getDraft(), /\[image #1/, 'the draft comes back with its placeholder intact')
  })
}

test('an EXECUTE-KIND host command does not claim its argued line: the image rides the ordinary submission', async (t) => {
  // DSH `CommandDescriptor.input` decides which LINE a host command claims.
  // `/compact` is execute-kind (no `input`), so `matchEnter` claims the BARE
  // token only and `/compact <anything>` is NOT a command invocation: it is
  // an ordinary multimodal submission. Applying the command's attachment
  // policy to it would refuse a line the host never owned and drop a real
  // image prompt.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-command-attachment-')
  const path = join(root, 'shot.png')
  await writeFile(path, pngHeader(4, 4))
  const { harness, mounted, registerContribution, imageSaves } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    attachments: true,
    extensionCommands: [{ id: 'stub-cmd', name: 'stub', description: 'stub', bridgeHandler: () => ({ kind: 'success' }) }],
  })
  // /compact is an execute-kind HOST command; a registry change (any
  // extension invalidation) refreshes the effective catalog.
  ;(harness.commands as {
    register(def: { name: string; handler: () => unknown; input?: { hint: string; attachments?: boolean } }): void
  }).register({ name: 'compact', handler: () => ({ kind: 'success' }) })
  await registerContribution({ id: 'zeta-cmd', name: 'zeta', description: 'zeta', bridgeHandler: () => ({ kind: 'success' }) })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  assert.match(staged, /\[image #1/, `the image is staged through the real intake: ${JSON.stringify(staged)}`)
  mounted.app.setDraft(`/compact ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'argued execute-kind line')
  assert.ok(!harness.executed.some(entry => entry.line.startsWith('/compact')),
    `the argued line is not a command invocation: ${JSON.stringify(harness.executed)}`)
  assert.equal(mounted.app.notifyTextForTest(), '', 'no command refusal is surfaced')
  assert.match(mounted.app.getDraft(), /^$|^\/compact/, 'the submission consumed the draft')
  assert.equal(imageSaves.length, 1, 'the image is admitted through the ordinary model path')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string; text?: string }[] }
  assert.deepEqual(delivered.content.map(block => block.type), ['text', 'image'],
    'the model receives the multimodal prompt ("/compact " + the image)')
  assert.equal(harness.host.steered.length, 0, 'an idle agent queues')
})

test('an undeclared LEADING-INPUT host command refuses the attachment on its argued line (web composer parity)', async (t) => {
  // Upstream `CommandUiRuntime.matchEnter`: `/goal ship` + attachments is an
  // INVOCATION (the descriptor declares `input`) whose descriptor does not
  // declare `input.attachments` → the composer refuses before dispatch. The
  // TUI must not let the line through and then hand the host a placeholder
  // with no bytes (the attachment would be silently dropped).
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-command-attachment-')
  const path = join(root, 'shot.png')
  await writeFile(path, pngHeader(4, 4))
  const { harness, mounted, registerContribution, imageSaves } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    attachments: true,
    extensionCommands: [{ id: 'stub-cmd', name: 'stub', description: 'stub', bridgeHandler: () => ({ kind: 'success' }) }],
  })
  // A `leadingInput` host command WITHOUT the attachment declaration (the
  // upstream `/goal` fixture shape): it claims the argued line and refuses
  // the attachment.
  ;(harness.commands as {
    register(def: { name: string; handler: () => unknown; input?: { hint: string; attachments?: boolean } }): void
  }).register({ name: 'goal', handler: () => ({ kind: 'success' }), input: { hint: '<objective>' } })
  await registerContribution({ id: 'zeta-cmd', name: 'zeta', description: 'zeta', bridgeHandler: () => ({ kind: 'success' }) })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  assert.match(staged, /\[image #1/, `the image is staged through the real intake: ${JSON.stringify(staged)}`)
  mounted.app.setDraft(`/goal ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await drainUntil(() => /does not accept attachments/.test(mounted.app.notifyTextForTest()), 5000)
  assert.match(mounted.app.notifyTextForTest(), /\/goal does not accept attachments; remove them first/)
  // The COMPOSER refuses before dispatch: the host never sees the line, so
  // there is neither an execution nor an admission rejection. (A rejected
  // command-plane call would mean the gate let an undeclared invocation
  // through and the executor had to catch it.)
  assert.ok(!harness.executed.some(entry => entry.line.startsWith('/goal')),
    `the undeclared command never reaches the command plane: ${JSON.stringify(harness.executed)}`)
  assert.ok(!harness.executed.some(entry => entry.outcome === 'rejected'),
    'the refusal happened before dispatch, not at host admission')
  assert.equal(harness.host.followedUp.length, 0, 'never a model prompt')
  assert.deepEqual(imageSaves, [], 'nothing is admitted either')
  assert.match(mounted.app.getDraft(), /^\/goal /, 'the draft comes back')
  assert.match(mounted.app.getDraft(), /\[image #1/, 'with its attachment placeholder intact')
})

test('a declared HOST command still refuses a FILE attachment (no host receipt seam)', async (t) => {
  // The host contract carries files as upload RECEIPTS; this client has no
  // seam to produce one, so a declared command refuses a file rather than
  // handing over a placeholder with no payload (fail closed).
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-command-attachment-')
  const path = join(root, 'report.pdf')
  await writeFile(path, Buffer.from('%PDF-1.7\nbody'))
  const { harness, mounted, registerContribution } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    attachments: true,
    extensionCommands: [{ id: 'stub-cmd', name: 'stub', description: 'stub', bridgeHandler: () => ({ kind: 'success' }) }],
  })
  ;(harness.commands as {
    register(def: { name: string; handler: () => unknown; input?: { hint: string; attachments?: boolean } }): void
  }).register({ name: 'goal', handler: () => ({ kind: 'success' }), input: { hint: '<objective>', attachments: true } })
  await registerContribution({ id: 'zeta-cmd', name: 'zeta', description: 'zeta', bridgeHandler: () => ({ kind: 'success' }) })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  assert.match(staged, /\[file #1/)
  mounted.app.setDraft(`/goal ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && !/cannot receive file attachments/.test(mounted.app.notifyTextForTest()); round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.match(mounted.app.notifyTextForTest(), /\/goal cannot receive file attachments in this client; remove them first/)
  // Same as above: an undeliverable file is refused by the composer, never
  // handed to the host to reject.
  assert.ok(!harness.executed.some(entry => entry.line.startsWith('/goal ')),
    `the file-bearing invocation never reaches the command plane: ${JSON.stringify(harness.executed)}`)
  assert.ok(!harness.executed.some(entry => entry.outcome === 'rejected'),
    'the refusal happened before dispatch, not at host admission')
  assert.equal(harness.host.followedUp.length, 0, 'never a model prompt')
  assert.match(mounted.app.getDraft(), /\[file #1/, 'the file draft comes back')
})

test('a FAILED declared command keeps its attachment (consume only after handler success)', async (t) => {
  // Web parity: "a submission consumes its attachments only after handler
  // success; an error outcome keeps the draft and attachments" — a failed
  // command must never swallow the user's image.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-command-attachment-')
  const path = join(root, 'shot.png')
  await writeFile(path, pngHeader(3, 3))
  const { harness, mounted, registerContribution, imageSaves } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    attachments: true,
    extensionCommands: [{ id: 'stub-cmd', name: 'stub', description: 'stub', bridgeHandler: () => ({ kind: 'success' }) }],
  })
  ;(harness.commands as {
    register(def: { name: string; handler: () => unknown; input?: { hint: string; attachments?: boolean } }): void
  }).register({
    name: 'goal',
    handler: () => ({ kind: 'error', text: 'goal rejected' }),
    input: { hint: '<objective>', attachments: true },
  })
  await registerContribution({ id: 'zeta-cmd', name: 'zeta', description: 'zeta', bridgeHandler: () => ({ kind: 'success' }) })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  assert.match(staged, /\[image #1/, `the image is staged through the real intake: ${JSON.stringify(staged)}`)
  mounted.app.setDraft(`/goal ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && !harness.executed.some(entry => entry.line.startsWith('/goal ')); round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  const goalCall = harness.executed.find(entry => entry.line.startsWith('/goal '))
  assert.equal(goalCall?.outcome, 'executed', 'the declared command is admitted by the executor')
  assert.equal(goalCall?.attachments.length, 1, 'the declared command receives the image')
  for (let round = 0; round < 40 && !/^\/goal /.test(mounted.app.getDraft()); round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.match(mounted.app.getDraft(), /^\/goal /, 'the failed command restores the draft')
  assert.deepEqual(imageSaves, [], 'the failed command admits nothing locally')
  // The attachment SURVIVED: the same placeholder as a plain prompt is
  // still an image submission (admitted through the model path).
  mounted.app.setDraft(staged.trim())
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'kept attachment after a failed command')
  assert.equal(imageSaves.length, 1, 'the kept attachment is admitted on the next plain-prompt submit')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string }[] }
  assert.deepEqual(delivered.content.map(block => block.type), ['image'], 'the image reaches the model')
})

test('an argued line of a client command name is an ordinary submission (the handler never runs)', async (t) => {
  // DSH `matchEnter`: a contribution is a slash-MENU entry — it claims the BARE
  // `/name` token only (`if (!bare) return undefined`). `/deploy <args>` is an
  // ordinary submission even for a session-backed contribution on a deferred
  // start, so the client handler never runs for it, the line reaches the MODEL
  // (with its attachment), and no local-command refusal is surfaced.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-argued-contribution-')
  const path = join(root, 'shot.png')
  await writeFile(path, pngHeader(2, 2))
  const calls: string[] = []
  const { harness, mounted, imageSaves } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    attachments: true,
    extensionCommands: [{
      id: 'deploy', name: 'deploy', description: 'deploy',
      bridgeHandler: () => { calls.push('deploy'); return { kind: 'success' } },
    }],
  })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  assert.match(staged, /\[image #1/, `the image is staged: ${JSON.stringify(staged)}`)
  mounted.app.setDraft(`/deploy ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'argued contribution line')
  assert.equal(mounted.app.notifyTextForTest(), '', 'no local-command refusal is surfaced')
  assert.deepEqual(calls, [], 'the client handler never runs for an argued line')
  assert.equal(harness.executed.length, 0, 'never the command plane')
  assert.equal(imageSaves.length, 1, 'the image is admitted through the ordinary model path')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string; text?: string }[] }
  assert.deepEqual(delivered.content.map(block => block.type), ['text', 'image'],
    'the model receives the multimodal prompt')
  assert.match(delivered.content[0]?.text ?? '', /^\/deploy /, 'with the raw line (placeholder included)')
})

test('an argued line of a client command name carries a FILE as an ordinary submission', async (t) => {
  // The same row with a generic FILE draft: the argued line is not a
  // contribution invocation, so the file is admitted through the ordinary
  // model path (never a local-command refusal, and the handler stays silent).
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pi-tui-argued-contribution-file-')
  const path = join(root, 'report.pdf')
  await writeFile(path, Buffer.from('%PDF-1.7\nbody'))
  const calls: string[] = []
  const { harness, mounted, fileSaves } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    attachments: true,
    extensionCommands: [{
      id: 'deploy', name: 'deploy', description: 'deploy',
      bridgeHandler: () => { calls.push('deploy'); return { kind: 'success' } },
    }],
  })
  const staged = await stageAttachmentDraft(harness, mounted, path)
  assert.match(staged, /\[file #1/, `the file is staged: ${JSON.stringify(staged)}`)
  mounted.app.setDraft(`/deploy ${staged.trim()}`)
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'argued contribution line with a file')
  assert.equal(mounted.app.notifyTextForTest(), '', 'no local-command refusal is surfaced')
  assert.deepEqual(calls, [], 'the client handler never runs for an argued line')
  assert.equal(harness.executed.length, 0, 'never the command plane')
  assert.deepEqual(fileSaves.map(save => ({ name: save.name, byteLength: save.byteLength })),
    [{ name: 'report.pdf', byteLength: 13 }], 'the exact file bytes are admitted through the model path')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string }[] }
  assert.deepEqual(delivered.content.map(block => block.type), ['text', 'file'],
    'the model receives the file-bearing prompt')
})

test('a sessionless client command runs without creating a session', async (t) => {
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    deferredStart: true,
    extensionCommands: [{
      id: 'vimmode', name: 'vimmode', description: 'toggle vim mode', sessionless: true,
      bridgeHandler: () => { calls.push('vimmode'); return { kind: 'success' } },
    }],
  })
  mounted.app.setDraft('/vimmode')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && calls.length === 0; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.deepEqual(calls, ['vimmode'], 'the sessionless client handler runs immediately')
  assert.deepEqual(harness.createdSessionIds, [], 'a sessionless client command never creates a session')
})

test('a skill wrapper that loads AFTER a same-named client contribution outranks it', async (t) => {
  // The contribution exists first (bridge-only, so the skill wrapper can
  // still install); the skill catalog then provides /grilling. A skill
  // wrapper is TUI-owned agent-facing input: the invocation must take the
  // loadSkill route — never the client handler.
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'running',
    skills: true,
    hostLoadsSkillBody: true,
    extensionCommands: [{
      id: 'grilling-cmd', name: 'grilling', description: 'client grilling',
      bridgeHandler: () => { calls.push('grilling'); return { kind: 'success' } },
    }],
  })
  await waitForSkillWrapper(harness, 'grilling')
  mounted.app.setDraft('/grilling args')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'skill over contribution')
  assert.deepEqual(calls, [], 'the client handler must not run for a live skill wrapper')
  assert.equal(harness.host.followedUp.length, 1, 'the skill invocation queues under busyEnter=queue (loadSkill route)')
  const followed = harness.host.followedUp[0] as { content: { type: string; text: string }[] }
  assert.equal(followed.content[0]?.text, '/grilling args', 'the skill line is delivered verbatim')
  assert.equal(harness.host.injected.length, 0, 'the host loader owns the body injection')
})

test('a SESSIONLESS client command never shadows a live skill wrapper of the same name', async (t) => {
  // The namespace order decides it: a live skill wrapper is TUI-owned
  // agent-facing input and outranks any contribution — including one that
  // declares sessionless (the generic sessionless branch must not run a
  // client handler for a wrapper's name).
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'running',
    skills: true,
    hostLoadsSkillBody: true,
    extensionCommands: [{
      id: 'grilling-cmd', name: 'grilling', description: 'client grilling', sessionless: true,
      bridgeHandler: () => { calls.push('grilling'); return { kind: 'success' } },
    }],
  })
  await waitForSkillWrapper(harness, 'grilling')
  mounted.app.setDraft('/grilling args')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'sessionless skill over contribution')
  assert.deepEqual(calls, [], 'the client handler must not run for a live skill wrapper')
  assert.equal(harness.host.followedUp.length, 1, 'the skill invocation queues (loadSkill route)')
  assert.equal(harness.host.injected.length, 0, 'the host loader owns the body')
})

test('a sessionless client command runs its handler even with a LIVE session', async (t) => {
  // The namespace order decides this, not the generic sessionless branch: a
  // client command is client-owned whether or not a session exists. Routing
  // it through the command plane would miss (no definition) and deliver the
  // line to the MODEL.
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    extensionCommands: [{
      id: 'vimmode', name: 'vimmode', description: 'toggle vim mode', sessionless: true,
      bridgeHandler: () => { calls.push('vimmode'); return { kind: 'success' } },
    }],
  })
  mounted.app.setDraft('/vimmode')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && calls.length === 0; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.deepEqual(calls, ['vimmode'], 'a sessionless client command runs locally with a live session too')
  assert.equal(harness.executed.length, 0, 'never the command plane')
  assert.equal(harness.host.followedUp.length, 0, 'never the model')
})

test('a dynamic host collision fails the command source (upstream source-failed parity)', async (t) => {
  const { harness, mounted, registerContribution } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    hostCommands: ['compact'],
    extensionCommands: [
      { id: 'deploy-cmd', name: 'deploy', description: 'client deploy', bridgeHandler: () => ({ kind: 'success' }) },
      { id: 'keep-cmd', name: 'keep', description: 'client keep', bridgeHandler: () => ({ kind: 'success' }) },
    ],
  })
  // T0: the host row and both client rows are in the menu — one source.
  const t0 = mounted.app.commandCompletionsForTest().map(row => row.name)
  assert.ok(t0.includes('deploy') && t0.includes('keep'), `both client rows installed: ${t0.join(',')}`)
  assert.ok(t0.includes('compact'), `the host row shares the source: ${t0.join(',')}`)
  // T1: the host catalog gains /deploy (a `leadingInput` command — the line
  // below is argued, so only that shape claims it); a later registration
  // flushes the extension invalidation into a completion refresh.
  const disposeHost = (harness.commands as {
    register(def: { name: string; handler: () => unknown; input?: { hint: string } }): () => void
  }).register({ name: 'deploy', handler: () => ({ kind: 'success' }), input: { hint: '<target>' } })
  await registerContribution({ id: 'zeta-cmd', name: 'zeta', description: 'zeta', bridgeHandler: () => ({ kind: 'success' }) })
  const names = mounted.app.commandCompletionsForTest().map(row => row.name)
  // The command SOURCE failed: its whole group is removed (upstream
  // `source-failed`), so neither the stale client rows NOR the host rows are
  // offered — a displayed row can never execute a different command than it
  // shows.
  assert.deepEqual(names, [], `the failed source offers no rows: ${names.join(',')}`)
  // Submitting the name executes the HOST command (claims were refreshed
  // before the merge).
  mounted.app.setDraft('/deploy now')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'the host command owns the name')
  assert.equal(harness.host.followedUp.length, 0, 'never a model prompt')
  // Recovery: the host descriptor goes away and a successful synthesis
  // restores the whole menu.
  disposeHost()
  await registerContribution({ id: 'omega-cmd', name: 'omega', description: 'omega', bridgeHandler: () => ({ kind: 'success' }) })
  const recovered = mounted.app.commandCompletionsForTest().map(row => row.name)
  assert.ok(recovered.includes('deploy') && recovered.includes('keep') && recovered.includes('omega'),
    `the menu recovers after a successful synthesis: ${recovered.join(',')}`)
})

test('a SECOND colliding contribution is surfaced too (aggregated fresh-collision notice)', async (t) => {
  // A collides first and is notified; B starts colliding while A keeps
  // colliding. B must be surfaced as well — the failed pass notifies every
  // FRESH collision (one per identity and failure generation), aggregated
  // into the single transient notice slot.
  const healthOf = (id: string): { state: string } | undefined =>
    extensionServiceOf().find(entry => entry.id === id)
  const { harness, mounted, registerContribution, extensionService } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    extensionCommands: [
      { id: 'alpha-cmd', name: 'alpha', description: 'alpha', bridgeHandler: () => ({ kind: 'success' }) },
      { id: 'beta-cmd', name: 'beta', description: 'beta', bridgeHandler: () => ({ kind: 'success' }) },
    ],
  })
  const extensionServiceOf = (): readonly { id: string; state: string }[] =>
    extensionService._ledger().healthSnapshot()
  const registerHost = (name: string): (() => void) =>
    (harness.commands as { register(def: { name: string; handler: () => unknown }): () => void })
      .register({ name, handler: () => ({ kind: 'success' }) })
  // T0: /alpha becomes a host command → the first collision, notified.
  const disposeAlpha = registerHost('alpha')
  await registerContribution({ id: 'gamma-cmd', name: 'gamma', description: 'gamma', bridgeHandler: () => ({ kind: 'success' }) })
  assert.match(mounted.app.notifyTextForTest(), /\/alpha/, 'the first collision is surfaced')
  assert.equal(healthOf('alpha-cmd')?.state, 'failed')
  // T1: /beta becomes a host command while /alpha still collides.
  const disposeBeta = registerHost('beta')
  await registerContribution({ id: 'delta-cmd', name: 'delta', description: 'delta', bridgeHandler: () => ({ kind: 'success' }) })
  const notice = mounted.app.notifyTextForTest()
  assert.match(notice, /\/beta/, 'the NEWLY colliding contribution is surfaced')
  assert.match(notice, /\/alpha/, 'the still-colliding contribution is included in the aggregated notice')
  assert.equal(healthOf('beta-cmd')?.state, 'failed')
  // Recovery: both host descriptors go away; a successful synthesis clears
  // both notice keys and both health records.
  disposeAlpha()
  disposeBeta()
  await registerContribution({ id: 'epsilon-cmd', name: 'epsilon', description: 'epsilon', bridgeHandler: () => ({ kind: 'success' }) })
  assert.equal(healthOf('alpha-cmd')?.state, 'active', 'the recovered collision clears')
  assert.equal(healthOf('beta-cmd')?.state, 'active', 'the recovered collision clears')
  const names = mounted.app.commandCompletionsForTest().map(row => row.name)
  assert.ok(names.includes('alpha') && names.includes('beta'), `client rows return: ${names.join(',')}`)
})

test('a collision health record clears on recovery, while a HANDLER failure record survives an unrelated refresh', async (t) => {
  const healthOf = (service: { _ledger(): { healthSnapshot(): readonly { id: string; state: string; lastError?: string }[] } }, id: string) =>
    service._ledger().healthSnapshot().find(entry => entry.id === id)
  const { harness, mounted, registerContribution, extensionService } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    extensionCommands: [
      { id: 'boom-cmd', name: 'boom', description: 'boom', bridgeHandler: () => { throw new Error('handler boom') } },
      { id: 'deploy-cmd', name: 'deploy', description: 'client deploy', bridgeHandler: () => ({ kind: 'success' }) },
    ],
  })
  // The client handler fails: the health record carries the HANDLER error.
  mounted.app.setDraft('/boom')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && healthOf(extensionService, 'boom-cmd')?.state !== 'failed'; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.equal(healthOf(extensionService, 'boom-cmd')?.state, 'failed', 'a throwing handler marks its contribution failed')
  // A dynamic host collision on ANOTHER contribution triggers a failed
  // synthesis: it must not clear the unrelated handler-failure record.
  const disposeHost = (harness.commands as { register(def: { name: string; handler: () => unknown }): () => void })
    .register({ name: 'deploy', handler: () => ({ kind: 'success' }) })
  await registerContribution({ id: 'zeta-cmd', name: 'zeta', description: 'zeta', bridgeHandler: () => ({ kind: 'success' }) })
  assert.equal(healthOf(extensionService, 'deploy-cmd')?.state, 'failed', 'the colliding contribution is marked failed')
  assert.equal(healthOf(extensionService, 'boom-cmd')?.state, 'failed', 'the handler failure survives the synthesis')
  // Recovery: the host descriptor disappears, the contribution merges again,
  // and only the COLLISION record clears.
  disposeHost()
  await registerContribution({ id: 'omega-cmd', name: 'omega', description: 'omega', bridgeHandler: () => ({ kind: 'success' }) })
  assert.equal(healthOf(extensionService, 'deploy-cmd')?.state, 'active', 'the recovered collision clears')
  assert.equal(healthOf(extensionService, 'boom-cmd')?.state, 'failed', 'the handler failure is untouched by the recovery')
})

// ── the KNOWN diagnostic limits of the shared command health record ────────
// ONE contribution identity has THREE writers of its single extension-health
// record: the candidate synthesis (a host claim on the name), the client
// handler settlement, and the session command path reporting the HOST command
// that runs under a colliding name — while the ledger keeps one failure
// generation per record and DEDUPLICATES a repeat (the first message wins).
// The tests below CHARACTERIZE the resulting limitations; they are accepted
// and documented in `docs/surface-decisions.md`, NOT a specification of
// desired behavior: health is a lossy diagnostic, not an authoritative
// summary of every unrecovered failure. Routing, claims and the immediate
// notices are unaffected and are asserted alongside.

test('known limitation: a handler failure under a colliding name is masked, then cleared, by the collision record', async (t) => {
  const healthOf = (id: string): { state: string; lastError?: string } | undefined =>
    extensionServiceOf().find(entry => entry.id === id)
  let releaseHandler: ((error: Error) => void) | undefined
  let started = false
  const { harness, mounted, registerContribution, extensionService } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    extensionCommands: [{
      id: 'deploy-cmd', name: 'deploy', description: 'client deploy',
      bridgeHandler: () => {
        started = true
        return new Promise((_resolve, reject) => { releaseHandler = reject })
      },
    }],
  })
  const extensionServiceOf = (): readonly { id: string; state: string; lastError?: string }[] =>
    extensionService._ledger().healthSnapshot()
  const registerHost = (name: string): (() => void) =>
    (harness.commands as { register(def: { name: string; handler: () => unknown; input?: { hint: string } }): () => void })
      .register({ name, handler: () => ({ kind: 'success' }), input: { hint: '<target>' } })
  // 1. The async client handler is IN FLIGHT (no claim yet: the local route).
  mounted.app.setDraft('/deploy')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && !started; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.equal(started, true, 'the async client handler started')
  // 2. A same-named Host claim appears while the handler runs: the candidate
  // synthesis fails and records the collision on the SAME health record.
  const disposeHost = registerHost('deploy')
  await registerContribution({ id: 'zeta-cmd', name: 'zeta', description: 'zeta', bridgeHandler: () => ({ kind: 'success' }) })
  assert.equal(healthOf('deploy-cmd')?.state, 'failed', 'the collision is recorded while the handler is in flight')
  assert.match(healthOf('deploy-cmd')?.lastError ?? '', /collides with a host command/)
  // 3. The in-flight handler REJECTS: the user is told immediately, but the
  // ledger's first-message-wins dedupe keeps the collision text. (The routing
  // assertions live in the resolve/limit tests below — a host-plane
  // submission would settle this record first and change the very state
  // characterized here.)
  releaseHandler?.(new Error('handler boom'))
  for (let round = 0; round < 40 && !/handler boom/.test(mounted.app.notifyTextForTest()); round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.match(mounted.app.notifyTextForTest(), /handler boom/, 'the handler failure reaches the user immediately')
  assert.match(healthOf('deploy-cmd')?.lastError ?? '', /collides with a host command/, 'the health record still shows the collision')
  // 4. The claim goes away: the collision recovery clears the record, and the
  // UNRECOVERED handler failure is not in health any more.
  disposeHost()
  await registerContribution({ id: 'omega-cmd', name: 'omega', description: 'omega', bridgeHandler: () => ({ kind: 'success' }) })
  assert.equal(healthOf('deploy-cmd')?.state, 'active', 'the collision recovery clears the record although the handler never recovered')
})

test('known limitation: a handler success clears the still-active collision record', async (t) => {
  const healthOf = (id: string): { state: string; lastError?: string } | undefined =>
    extensionServiceOf().find(entry => entry.id === id)
  let releaseHandler: (() => void) | undefined
  let started = false
  const { harness, mounted, registerContribution, extensionService } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    extensionCommands: [{
      id: 'deploy-cmd', name: 'deploy', description: 'client deploy',
      bridgeHandler: () => {
        started = true
        return new Promise(resolve => { releaseHandler = () => resolve({ kind: 'success' }) })
      },
    }],
  })
  const extensionServiceOf = (): readonly { id: string; state: string; lastError?: string }[] =>
    extensionService._ledger().healthSnapshot()
  const registerHost = (name: string): (() => void) =>
    (harness.commands as { register(def: { name: string; handler: () => unknown; input?: { hint: string } }): () => void })
      .register({ name, handler: () => ({ kind: 'success' }), input: { hint: '<target>' } })
  // 1. The async client handler is IN FLIGHT.
  mounted.app.setDraft('/deploy')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && !started; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  // 2. The same-named Host claim appears: the collision is recorded.
  const disposeHost = registerHost('deploy')
  await registerContribution({ id: 'zeta-cmd', name: 'zeta', description: 'zeta', bridgeHandler: () => ({ kind: 'success' }) })
  assert.equal(healthOf('deploy-cmd')?.state, 'failed', 'the collision is recorded while the handler is in flight')
  // 3. The handler SETTLES SUCCESSFULLY while the collision stays active: the
  // settlement clears the collision record (a handler success is not a
  // collision recovery).
  releaseHandler?.()
  for (let round = 0; round < 40 && healthOf('deploy-cmd')?.state !== 'active'; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.equal(healthOf('deploy-cmd')?.state, 'active', 'the handler success cleared the collision record')
  // 4. The collision itself is untouched: the claim still owns the name and
  // the failed source still offers no rows.
  mounted.app.setDraft('/deploy from-host')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'the host command still owns the name')
  const names = mounted.app.commandCompletionsForTest().map(row => row.name)
  assert.deepEqual(names, [], `the failed source still offers no rows: ${names.join(',')}`)
  // 5. A successful synthesis restores the client row.
  disposeHost()
  await registerContribution({ id: 'omega-cmd', name: 'omega', description: 'omega', bridgeHandler: () => ({ kind: 'success' }) })
  const recovered = mounted.app.commandCompletionsForTest().map(row => row.name)
  assert.ok(recovered.includes('deploy'), `the client row returns: ${recovered.join(',')}`)
})

test('known limitation: a HOST command run under a colliding name settles the contribution health record', async (t) => {
  // No async handler involved: the claim owns the name, a submission executes
  // the HOST command through the session path, and that settlement is written
  // to the CONTRIBUTION's health record (its ref resolves by contribution id).
  const healthOf = (id: string): { state: string; lastError?: string } | undefined =>
    extensionServiceOf().find(entry => entry.id === id)
  const { harness, mounted, registerContribution, extensionService } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    extensionCommands: [
      { id: 'deploy-cmd', name: 'deploy', description: 'client deploy', bridgeHandler: () => ({ kind: 'success' }) },
    ],
  })
  const extensionServiceOf = (): readonly { id: string; state: string; lastError?: string }[] =>
    extensionService._ledger().healthSnapshot()
  const registerHost = (name: string): (() => void) =>
    (harness.commands as { register(def: { name: string; handler: () => unknown; input?: { hint: string } }): () => void })
      .register({ name, handler: () => ({ kind: 'success' }), input: { hint: '<target>' } })
  const disposeHost = registerHost('deploy')
  await registerContribution({ id: 'zeta-cmd', name: 'zeta', description: 'zeta', bridgeHandler: () => ({ kind: 'success' }) })
  assert.equal(healthOf('deploy-cmd')?.state, 'failed', 'the collision is recorded')
  mounted.app.setDraft('/deploy from-host')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForCommand(harness)
  assert.equal(harness.executed.length, 1, 'the host command runs')
  for (let round = 0; round < 40 && healthOf('deploy-cmd')?.state !== 'active'; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.equal(healthOf('deploy-cmd')?.state, 'active', "the HOST command's success settled the contribution health record")
  assert.equal(mounted.app.commandCompletionsForTest().length, 0, 'the claim still withdraws the whole source')
  disposeHost()
  await registerContribution({ id: 'omega-cmd', name: 'omega', description: 'omega', bridgeHandler: () => ({ kind: 'success' }) })
})

test('a client command executes locally under both chords (never the plane, never the model)', async (t) => {
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    extensionCommands: [{
      id: 'panel', name: 'panel', description: 'toggle the panel',
      bridgeHandler: () => { calls.push('panel'); return { kind: 'success' } },
    }],
  })
  mounted.app.setDraft('/panel')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && calls.length === 0; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.deepEqual(calls, ['panel'], 'a client command always runs its own handler')
  // The accelerated chord cannot change a client command's route either.
  mounted.app.setDraft('/panel')
  ;(mounted.app as unknown as { submitDraft(request?: string): void }).submitDraft('accelerated')
  for (let round = 0; round < 40 && calls.length < 2; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.deepEqual(calls, ['panel', 'panel'], 'the chord keeps the local execution')
  assert.equal(harness.host.steered.length, 0, 'a client command never steers')
  assert.equal(harness.host.followedUp.length, 0, 'a client command never reaches the model')
  assert.equal(harness.executed.length, 0, 'a client command never enters the command plane')
})

test('running + queue: an argued client-command line is an ordinary queued followup', async (t) => {
  // DSH `matchEnter`: a contribution claims the BARE token only, so its argued
  // line follows the ordinary busy policy — the handler never runs.
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'running',
    extensionCommands: [{
      id: 'deploy', name: 'deploy', description: 'deploy the app',
      bridgeHandler: () => { calls.push('deploy'); return { kind: 'success' } },
    }],
  })
  mounted.app.setDraft('/deploy explain the risk')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'argued client-command line')
  assert.deepEqual(calls, [], 'the client handler never runs for an argued line')
  assert.equal(harness.executed.length, 0, 'never the command plane')
  assert.equal(harness.host.followedUp.length, 1, 'the line takes the ordinary queue delivery')
  assert.equal(harness.host.steered.length, 0, 'the queue preference never steers')
})

test('running + steer: an argued client-command line steers as an ordinary prompt', async (t) => {
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'steer',
    status: 'running',
    extensionCommands: [{
      id: 'deploy', name: 'deploy', description: 'deploy the app',
      bridgeHandler: () => { calls.push('deploy'); return { kind: 'success' } },
    }],
  })
  mounted.app.setDraft('/deploy explain the risk')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'argued client-command line')
  assert.deepEqual(calls, [], 'the client handler never runs for an argued line')
  assert.equal(harness.executed.length, 0, 'never the command plane')
  assert.equal(harness.host.steered.length, 1, 'it takes the ordinary steer delivery')
  assert.equal(harness.host.followedUp.length, 0, 'the steer preference never queues')
})

test('running + accelerated chord: an argued client-command line takes the OPPOSITE policy', async (t) => {
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'running',
    extensionCommands: [{
      id: 'deploy', name: 'deploy', description: 'deploy the app',
      bridgeHandler: () => { calls.push('deploy'); return { kind: 'success' } },
    }],
  })
  mounted.app.setDraft('/deploy explain the risk')
  ;(mounted.app as unknown as { submitDraft(request?: string): void }).submitDraft('accelerated')
  await waitForDelivery(harness.host, 'accelerated argued client-command line')
  assert.deepEqual(calls, [], 'the chord cannot turn the line into a client command either')
  assert.equal(harness.executed.length, 0, 'never the command plane')
  assert.equal(harness.host.steered.length, 1, 'the accelerated chord takes the opposite of the queue preference')
  assert.equal(harness.host.followedUp.length, 0, 'the chord must not queue')
})

test('bare /panel runs the client handler while /panel args is an ordinary submission', async (t) => {
  // The two rows of the DSH contribution decision table, side by side.
  const calls: string[] = []
  const { harness, mounted } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    extensionCommands: [{
      id: 'panel', name: 'panel', description: 'toggle the panel',
      bridgeHandler: () => { calls.push('panel'); return { kind: 'success' } },
    }],
  })
  mounted.app.setDraft('/panel')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && calls.length === 0; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.deepEqual(calls, ['panel'], 'the BARE token runs the client handler')
  assert.equal(harness.host.followedUp.length, 0, 'a client command never reaches the model')
  // Trailing whitespace is NOT input (DSH `bare`), so the handler still runs —
  // and it receives the preserved whitespace verbatim.
  mounted.app.setDraft('/panel   ')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  for (let round = 0; round < 40 && calls.length < 2; round += 1) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  assert.deepEqual(calls, ['panel', 'panel'], 'trailing whitespace keeps the line bare')
  assert.equal(harness.host.followedUp.length, 0, 'still never the model')
  mounted.app.setDraft('/panel with args')
  ;(mounted.app as unknown as { submitDraft(): void }).submitDraft()
  await waitForDelivery(harness.host, 'argued /panel line')
  assert.deepEqual(calls, ['panel', 'panel'], 'the argued line does not run the handler')
  const delivered = harness.host.followedUp[0] as { content: readonly { type: string; text?: string }[] }
  assert.equal(delivered.content[0]?.text, '/panel with args', 'the MODEL receives the raw line')
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


test('a DISPOSED colliding contribution never suppresses its next generation notice', async (t) => {
  // The notice key is the contribution identity (id + owner) AND failure
  // generation. A disposed contribution leaves the snapshot entirely — its
  // bookkeeping must be purged with it, or a re-registration under the same
  // id/owner (a plugin reload/HMR) inherits the suppression while the health
  // record fails again: the second generation would be silent.
  const { harness, mounted, registerContribution, extensionService } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    extensionCommands: [{ id: 'stub-cmd', name: 'stub', description: 'stub', bridgeHandler: () => ({ kind: 'success' }) }],
  })
  const flush = async (): Promise<void> => {
    for (let round = 0; round < 20; round += 1) await new Promise<void>(resolve => setImmediate(resolve))
  }
  const registerHost = (name: string): (() => void) =>
    (harness.commands as { register(def: { name: string; handler: () => unknown }): () => void })
      .register({ name, handler: () => ({ kind: 'success' }) })
  const disposeDeploy = registerHost('deploy')
  const disposeCompact = registerHost('compact')
  const healthOf = (id: string): { state: string; lastError?: string } | undefined =>
    extensionService._ledger().healthSnapshot().find(entry => entry.id === id)
  // A root-context registration keeps ONE owner across the generations (the
  // identity the regression needs); a plugin-fiber helper would mint a new
  // owner per call.
  const service = extensionService as unknown as {
    registerCommand(contribution: {
      id: string; name: string; description: string; handler: () => { kind: 'success' }
    }): { dispose(): void }
  }
  // Generation 1: /deploy collides → surfaced.
  const first = service.registerCommand({
    id: 'deploy-cmd', name: 'deploy', description: 'client deploy', handler: () => ({ kind: 'success' }),
  })
  await flush()
  assert.match(mounted.app.notifyTextForTest(), /\/deploy/, 'the first collision is surfaced')
  assert.equal(healthOf('deploy-cmd')?.state, 'failed')
  // Dispose it: the snapshot is empty and the health record was untracked.
  first.dispose()
  await flush()
  // Generation 2 under the SAME id/owner, but a different colliding name, so
  // a suppressed notice is observable (a stale message instead of a new one).
  const second = service.registerCommand({
    id: 'deploy-cmd', name: 'compact', description: 'client compact', handler: () => ({ kind: 'success' }),
  })
  await flush()
  assert.equal(healthOf('deploy-cmd')?.state, 'failed', 'the second generation fails again')
  assert.match(mounted.app.notifyTextForTest(), /\/compact/,
    'the second generation is surfaced, not suppressed by the disposed predecessor')
  second.dispose()
  disposeDeploy()
  disposeCompact()
})

test('a dispose + re-register inside ONE invalidate flush is still a new collision generation', async (t) => {
  // HMR coalescing: the invalidate batcher flushes on a microtask, so a
  // dispose and a re-registration in the SAME tick reach the synthesis as
  // one pass over the NEW snapshot — the empty state is never observed, and
  // a purge keyed on "identity absent from the snapshot" cannot see the gap.
  // The notice identity must therefore follow the REGISTRATION GENERATION.
  const flush = async (): Promise<void> => {
    for (let round = 0; round < 20; round += 1) await new Promise<void>(resolve => setImmediate(resolve))
  }
  const { harness, mounted, extensionService } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    extensionCommands: [{ id: 'stub-cmd', name: 'stub', description: 'stub', bridgeHandler: () => ({ kind: 'success' }) }],
  })
  const healthOf = (id: string): { state: string; lastError?: string } | undefined =>
    extensionService._ledger().healthSnapshot().find(entry => entry.id === id)
  const registerHost = (name: string): (() => void) =>
    (harness.commands as { register(def: { name: string; handler: () => unknown }): () => void })
      .register({ name, handler: () => ({ kind: 'success' }) })
  const disposeDeploy = registerHost('deploy')
  const disposeCompact = registerHost('compact')
  const service = extensionService as unknown as {
    registerCommand(contribution: {
      id: string; name: string; description: string; handler: () => { kind: 'success' }
    }): { dispose(): void }
  }
  const spec = { id: 'deploy-cmd', description: 'client command', handler: () => ({ kind: 'success' }) as const }
  const first = service.registerCommand({ ...spec, name: 'deploy' })
  await flush()
  assert.match(mounted.app.notifyTextForTest(), /\/deploy/, 'the first generation is surfaced')
  assert.equal(healthOf('deploy-cmd')?.state, 'failed')
  // SAME tick: dispose + re-register (same id, same owner, new generation).
  first.dispose()
  const second = service.registerCommand({ ...spec, name: 'compact' })
  await flush()
  assert.equal(healthOf('deploy-cmd')?.state, 'failed', 'the new generation fails again')
  assert.match(mounted.app.notifyTextForTest(), /\/compact/,
    'the coalesced generation is surfaced, not suppressed by its predecessor')
  second.dispose()
  disposeDeploy()
  disposeCompact()
})

test('collision recovery clears only the COMMAND health record, never a same-id record in another slot', async (t) => {
  // ExtensionHealth is keyed by (slot, owner, id); ONE plugin may legally
  // reuse an id across slots (a theme and a command). The recovery lookup
  // must therefore match the extension point as well, or it can read the
  // OTHER slot's record and skip the clear this synthesis owns.
  const { harness, mounted, registerContribution, extensionService } = await bootCommandHarness(t, {
    busyEnter: 'queue',
    status: 'idle',
    extensionCommands: [{ id: 'stub-cmd', name: 'stub', description: 'stub', bridgeHandler: () => ({ kind: 'success' }) }],
  })
  const healthOf = (slot: string): { state: string; lastError?: string } | undefined =>
    extensionService._ledger().healthSnapshot().find(entry => entry.extensionPoint === slot && entry.id === 'shared-id')
  const registerHost = (name: string): (() => void) =>
    (harness.commands as { register(def: { name: string; handler: () => unknown }): () => void })
      .register({ name, handler: () => ({ kind: 'success' }) })
  // The THEME registers FIRST so its (theme, owner, shared-id) record
  // precedes the command record in the health snapshot.
  const service = extensionService as unknown as {
    registerTheme(theme: { id: string; name: string; palette: Record<string, string> }): { dispose(): void }
    registerCommand(contribution: {
      id: string; name: string; description: string; handler: () => { kind: 'success' }
    }): { dispose(): void }
  }
  const theme = service.registerTheme({ id: 'shared-id', name: 'Shared', palette: { text: '#ffffff' } })
  const disposeDeploy = registerHost('deploy')
  const command = service.registerCommand({
    id: 'shared-id', name: 'deploy', description: 'client deploy', handler: () => ({ kind: 'success' }),
  })
  await registerContribution({ id: 'zeta-cmd', name: 'zeta', description: 'zeta', bridgeHandler: () => ({ kind: 'success' }) })
  assert.equal(healthOf('command')?.state, 'failed', 'the collision marks the command record failed')
  // Recovery: the host descriptor goes away, the contribution merges again.
  disposeDeploy()
  await registerContribution({ id: 'omega-cmd', name: 'omega', description: 'omega', bridgeHandler: () => ({ kind: 'success' }) })
  assert.equal(healthOf('theme')?.state, 'active', 'the theme record is untouched')
  assert.equal(healthOf('command')?.state, 'active', 'the command record is cleared by the collision recovery')
  command.dispose()
  theme.dispose()
  void mounted
})
