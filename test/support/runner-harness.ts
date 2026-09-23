import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ProcessTerminal } from '@xmoon76/pi-tui'
import { apply as applyRunner, Config as TuiConfigSchema } from '../../src/index.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import type { VirtualTerminal } from '../virtual-terminal.ts'

/** Build a minimal event envelope for tests. The type parameter is widened
 * to any string so legacy v1 `assistant/chunk` events (absent from master's
 * SessionEventMap) can be constructed; known types keep their typed data
 * surface, widened with `Record<string, unknown>` so Session v2 fields the
 * installed dsh-session may lag (e.g. `assistant/message.stream`) can be
 * supplied. */
export function event<K extends string>(
  type: K,
  data: (K extends SessionEvent['type'] ? SessionEvent<K>['data'] : Record<string, unknown>) & Record<string, unknown>,
  seq: number,
  surfaceOp?: 'append',
): SessionEvent {
  return {
    type,
    seq: SessionSeq(seq),
    time: 1_700_000_000_000 + seq * 1000,
    data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
  } as SessionEvent
}

export function sessionEvents(text: string): SessionEvent[] {
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

/** A FakeSession literal before the current log accessors are attached. */
export interface FakeSessionInit {
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

/** The current Session shape: the backing log is PRIVATE — production code
 * sees only `seq` / `eventAt` / `snapshotEvents`, so a mock can never again
 * mask old `Session.events` API drift (compatibility-plan B4). */
export interface FakeSession {
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

/** Build the current Session mock over a private backing log. */
export function fakeSession(init: FakeSessionInit): FakeSession {
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

export interface RunnerHarness {
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
  /** An optional jobs registry service (the Task Center's jobs half). */
  jobs?: unknown
  /** Retirement-phase records (`cancel:<id>` / `idle:<id>` / `drain:<id>` /
   * `flush:<id>` / `dispose:<id>`) in call order — the Direct
   * owned-session retirement assertions. */
  readonly retirementEvents: string[]
  /** The simulated official command executor's `command/run` / `command/done`
   * appends, each with whether the session still had a live owner handle at
   * that moment (the durability the `/fork` retirement seam must preserve). */
  readonly commandSettlements: { sessionId: string; phase: 'run' | 'done'; ownerLive: boolean }[]
  /** Session ids passed to the simulated `agents.resume`, in call order. */
  readonly resumeSessionIds: string[]
  /** Session ids whose simulated owner `dispose()` must throw (a leaked handle). */
  readonly disposeFailures: Set<string>
}

export function fakeAgent(session: FakeSession, whenIdleGate?: () => Promise<void>, retirementEvents?: string[]): Agent {
  // A small structural Agent context is sufficient for the Direct setup
  // callbacks.
  const agentContext = {
    get: () => undefined,
    on: () => () => {},
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
  return agent
}

/** Build Direct services whose in-memory registry behaves like the real Host. */
export function makeHarness(
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
        // A failing dispose must NOT remove the live owner: the handle is leaked.
        if (disposeFailures.has(session.id)) throw new Error(`dispose failed for ${session.id}`)
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
      return {
        header: session.header,
        events: [...session.snapshotEvents()],
        projections: { values: { agentPreset: undefined } },
        [Symbol.dispose]: () => {},
      }
    },
  }
  const agents = {
    resume: async ({ resumeSessionId, setup, signal }: { resumeSessionId: unknown; setup?: (agentCtx: unknown, agent: Agent) => unknown; signal?: AbortSignal }) => {
      resumeSignals.push(signal)
      resumeSessionIds.push(String(resumeSessionId))
      if (resumeError !== undefined) throw resumeError
      const session = persisted.get(String(resumeSessionId))
      if (session === undefined) throw new Error(`unknown test session ${String(resumeSessionId)}`)
      const handle = makeHandle(session)
      await setup?.(handle.agent.ctx, handle.agent)
      await resumeGate?.(String(resumeSessionId))
      return handle
    },
    create: async ({ sessionId, agentOptions, setup, seed, inheritedEventCount, signal }: {
      sessionId: unknown
      agentOptions?: { provider?: string; model?: string }
      setup?: (agentCtx: unknown, agent: Agent) => unknown
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
      await setup?.(handle.agent.ctx, handle.agent)
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
    // A successful save persists the value even when the test supplies its own
    // gated hook; a rejecting hook leaves the persisted default untouched
    // (exactly like the real settings write).
    saveSelection: async (next: { provider: string; model: string; reasoningEffort?: string }) => {
      const result = saveDefault === undefined ? undefined : await saveDefault(next)
      defaultSelection = { ...next }
      return result
    },
  }
  const llm = { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next,
    listProviders: () => [{ id: 'p', name: 'provider p' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({}),
    discoverModels: async () => [],
    listConfigurableProviders: () => [],
  }
  const definitions = new Map<string, { name: string; description: string; handler: (...args: never[]) => unknown }>()
  const commandSettlements: { sessionId: string; phase: 'run' | 'done'; ownerLive: boolean }[] = []
  const resumeSessionIds: string[] = []
  const disposeFailures = new Set<string>()
  let commandSeq = 0
  const commands = {
    register: (definition: { name: string; description: string; handler: (...args: never[]) => unknown }) => {
      definitions.set(definition.name, definition)
      return () => {
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
      }
    },
    list: () => [...definitions.values()].map(({ name, description }) => ({ name, description })),
    // The official CommandRuntime appends `command/run` BEFORE the handler and
    // `command/done` AFTER it settles, both to the SAME (source) Session. The
    // simulation records whether that Session still had a live owner handle at
    // each append, which is exactly the durability `/fork` must not break.
    execute: async (agent: unknown, line: string) => {
      const name = String(line).replace(/^\//u, '').split(/\s/u)[0] ?? ''
      const definition = definitions.get(name)
      if (definition === undefined) return undefined
      const commandId = `cmd-test-${++commandSeq}`
      const session = (agent as { session: FakeSession }).session
      const appendEvent = session.append as (type: string, data: unknown) => unknown
      const append = (phase: 'run' | 'done', type: string, data: unknown): void => {
        commandSettlements.push({ sessionId: session.id, phase, ownerLive: live.has(session.id) })
        appendEvent(type, data)
      }
      append('run', 'command/run', { commandId, name, source: { kind: 'user' } })
      const result = await definition.handler({
        commandId,
        agent,
        rawInput: String(line).slice(name.length + 1),
        attachments: [],
        signal: new AbortController().signal,
      } as never)
      // Test-only window between the handler settling and the executor's own
      // `command/done` append: a test installs `settlementGate` to hold the
      // append open and observe whether teardown respects the settlement.
      await commands.settlementGate?.()
      append('done', 'command/done', { commandId, kind: (result as { kind?: string } | undefined)?.kind ?? 'success' })
      return { commandId, result }
    },
    handler: (name: string) => definitions.get(name)?.handler,
    /** Set by a test to hold the post-handler `command/done` append open. */
    settlementGate: undefined as (() => Promise<void>) | undefined,
  }
  const subagentsService = typeof subagents === 'function'
    ? (subagents as (events: string[]) => unknown)(retirementEvents)
    : subagents
  return { persistence, sessionQuery, agents, sessions, defaultModel, llm, createOptions, createInheritedEventCounts, createSignals, resumeSignals, createdSessions, commands, subagents: subagentsService, retirementEvents, commandSettlements, resumeSessionIds, disposeFailures }
}

export async function settle(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await Promise.resolve()
}

/** Dispose every fiber created by the real Cordis context. */
export async function disposeContext(ctx: Context): Promise<void> {
  for (const runtime of [...ctx.registry.values()]) {
    for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
  }
}

/** Route production ProcessTerminal instances into a deterministic xterm. */
export function installVirtualProcessTerminal(vt: VirtualTerminal): () => void {
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

export async function mountRunner(
  ctx: Context,
  home: string,
  harness: RunnerHarness,
  startup: { sessionId?: string; presetId?: string },
  /** Plain plugin-config input; resolved through the exported schema so the
   * live preference fields arrive as volatile references, exactly like a
   * Loader-mounted row. `fullscreen` defaults to OFF to preserve the
   * historical degraded-mount baseline these suites were written against
   * (a settings-less mount used to resolve no document at all); tests that
   * exercise the fullscreen surface pass it explicitly. */
  config: Record<string, unknown> = {},
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
  if (harness.jobs !== undefined) ctx.provide('jobs', harness.jobs as never)
  ctx.provide('loader', { await: async () => {} } as never)
  const fiber = ctx.plugin((pluginCtx) => applyRunner(pluginCtx, TuiConfigSchema({ fullscreen: 'off', ...config } as never)))
  await fiber
  await settle()
  return fiber
}
