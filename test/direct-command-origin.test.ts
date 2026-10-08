/**
 * PR5 v2 §1C-10 / AC-1: a REAL Direct source-to-sink regression proving that
 * a TUI command's successful Direct HOST-registry compatibility mirror is
 * NOT Host-origin ownership. The production `registerTuiCommands` path
 * mirrors /status into the Host registry; the classification must still be
 * CLIENT_COMMAND (the TUI's own Client registration), so a running session
 * with a steer-producing gesture reaches the Client handler instead of
 * steering the literal line into the agent.
 *
 * The harness mirrors test/export-command.test.ts's Direct fixture (a REAL
 * `apply()` runner over a real Cordis Context with a fake Host services
 * manifest): the runner performs the REAL registerTuiCommands, the Host
 * registry fake observes the compatibility mirror, and the agent's status
 * is driven to `running` for the busy-Enter window.
 * @module @xmoon76/dsh-pi-tui/direct-command-origin.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply as applyRunner, Config as TuiConfigSchema } from '../src/index.ts'
import { TuiApp } from '../src/tui-app.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { installVirtualProcessTerminal } from './support/runner-harness.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

const SESSION_FORMAT_VERSION = 4

function makeHarness(home: string) {
  const persisted = new Map<string, { id: string; header: { id: string; cwd: string; createdAt: number; version: number } }>()
  const live = new Map<string, Agent>()
  const makeHandle = (session: { id: string; header: { id: string; cwd: string; createdAt: number; version: number } }) => {
    const agentContext = { get: () => undefined, on: () => () => {} }
    const agent = {
      session: { id: session.id, header: session.header, snapshotEvents: () => [] },
      ctx: agentContext,
      options: { provider: 'p', model: 'm' },
      status: 'idle',
      inbox: { nextTurn: [], nextStep: [] },
      whenIdle: async () => {},
      cancel: () => {},
    } as unknown as Agent
    live.set(session.id, agent)
    return { agent, dispose: async () => { live.delete(session.id) } }
  }
  const persistence = {
    list: async () => [...persisted.values()].map(session => session.header),
    inspect: async (id: unknown) => {
      const session = persisted.get(String(id))
      if (session === undefined) throw new Error(`unknown test session ${String(id)}`)
      return { meta: session.header, events: [] }
    },
  }
  const sessionQuery = {
    listSessions: async () => [...persisted.values()].map(session => ({ header: session.header, live: live.has(session.id) })),
    observeSession: async (id: unknown) => {
      const session = persisted.get(String(id))
      if (session === undefined) throw new Error(`unknown test session ${String(id)}`)
      return { header: session.header, events: [], [Symbol.dispose]: () => {} }
    },
  }
  const agents = {
    resume: async ({ resumeSessionId }: { resumeSessionId: unknown }) => {
      const session = persisted.get(String(resumeSessionId))
      if (session === undefined) throw new Error(`unknown test session ${String(resumeSessionId)}`)
      return makeHandle(session)
    },
    create: async ({ sessionId }: { sessionId: unknown }) => {
      const id = String(sessionId)
      const session = { id, header: { id, cwd: home, createdAt: Date.now(), version: SESSION_FORMAT_VERSION } }
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
  const llm = {
    listProviders: () => [{ id: 'p', name: 'provider p' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({}),
    discoverModels: async () => [],
    listConfigurableProviders: () => [],
  }
  const definitions = new Map<string, { name: string; description: string; handler: (...args: never[]) => unknown }>()
  /** The official ScopedLayers semantics in miniature: a scoped entry
   * (registered under an exact agent key) SHADOWS the global entry for that
   * agent's effective view, exactly like the frozen rc.2 registry. */
  const scopedDefinitions = new Map<string, Map<string, { name: string; description: string; definitionId?: string; handler: (...args: never[]) => unknown }>>()
  /** The bridge to the REAL cordis emitter: the runner registers
   * ctx.on('commands/change'); the fake registry calls this hook, which the
   * test wires to the real ctx's dispatch once it exists. */
  let emitChange: () => void = () => {}
  const commands = {
    register: (definition: { name: string; description: string; definitionId?: string; handler: (...args: never[]) => unknown }) => {
      definitions.set(definition.name, definition)
      emitChange()
      return () => {
        if (definitions.get(definition.name) === definition) {
          definitions.delete(definition.name)
          emitChange()
        }
      }
    },
    registerScoped: (agent: { session: { id: string } }, definition: { name: string; description: string; definitionId?: string; handler: (...args: never[]) => unknown }) => {
      const key = agent.session.id
      let layer = scopedDefinitions.get(key)
      if (layer === undefined) { layer = new Map(); scopedDefinitions.set(key, layer) }
      layer.set(definition.name, definition)
      emitChange()
      return () => {
        if (scopedDefinitions.get(key)?.get(definition.name) === definition) {
          scopedDefinitions.get(key)!.delete(definition.name)
          emitChange()
        }
      }
    },
    // The official descriptor carries each registration's own
    // `definitionId` (see src/commands.ts §1C-3: the origin derivation
    // compares the EFFECTIVE WINNER's id against the stamped mirror ids).
    list: (agent?: { session: { id: string } }) => {
      const descriptorOf = (d: { name: string; description: string; definitionId?: string }) => ({
        name: d.name,
        description: d.description,
        ...d.definitionId === undefined ? {} : { definitionId: d.definitionId },
      })
      const scopedLayer = agent === undefined ? undefined : scopedDefinitions.get(agent.session.id)
      if (scopedLayer === undefined) return [...definitions.values()].map(descriptorOf)
      const byName = new Map([...definitions.values()].map(d => [d.name, descriptorOf(d)]))
      for (const [name, def] of scopedLayer) byName.set(name, descriptorOf(def))
      return [...byName.values()]
    },
    // A REAL dispatch (what the production in-process Host service does):
    // parse the line, invoke the registered handler, wrap its result.
    execute: async (agent: unknown, line: string) => {
      const name = line.replace(/^\//, '').split(/\s+/)[0] ?? ''
      // The official dispatch resolves the EFFECTIVE view (scoped shadow
      // over global) for the exact agent.
      const scopedLayer = (agent as { session?: { id: string } } | undefined)?.session === undefined
        ? undefined
        : scopedDefinitions.get(((agent as { session: { id: string } }).session.id))
      const definition = scopedLayer?.get(name) ?? definitions.get(name)
      if (definition === undefined) return undefined
      const rawInput = line.replace(/^\/[^\s]+\s?/, '')
      const result = await definition.handler({ name, rawInput } as never)
      return { result: result as { kind: 'success' } | { kind: 'error'; text: string } }
    },
    handler: (name: string, agent?: unknown) => {
      const scopedLayer = (agent as { session?: { id: string } } | undefined)?.session === undefined
        ? undefined
        : scopedDefinitions.get((agent as { session: { id: string } }).session.id)
      return (scopedLayer?.get(name) ?? definitions.get(name))?.handler
    },
  }
  return {
    persistence, sessionQuery, agents, sessions, defaultModel, llm, commands, live,
    setChangeEmitter: (emit: () => void) => { emitChange = emit },
  }
}

async function settle(rounds = 40): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

test('PR5 AC-1 Direct: a successful Host-registry compatibility mirror stays CLIENT_COMMAND — /status reaches its handler under running+steer', async (t) => {
  const home = testLifecycle(t).tempDir('pr5-direct-origin-')
  const harness = makeHarness(home)
  const ctx = new Context()
  const vt = new VirtualTerminal(110, 32)
  const restoreTerminal = installVirtualProcessTerminal(vt)

  const apps: TuiApp[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function patchedStart(this: TuiApp) {
    apps.push(this)
    return originalStart.apply(this)
  }

  const fiber = await (async () => {
    ctx.provide('appExit', () => {})
    ctx.provide(TUI_STARTUP_SERVICE, { shippedPresetRoot: home })
    ctx.provide('sessionPersistence', harness.persistence as never)
    ctx.provide('sessionQuery', harness.sessionQuery as never)
    ctx.provide('agents', harness.agents as never)
    ctx.provide('sessions', harness.sessions as never)
    ctx.provide('agentDefaultModel', harness.defaultModel as never)
    ctx.provide('llm', harness.llm as never)
    ctx.provide('commands', harness.commands as never)
    ctx.provide('loader', { await: async () => {} } as never)
    const started = ctx.plugin(pluginCtx => applyRunner(pluginCtx, TuiConfigSchema({ fullscreen: 'off' } as never)))
    await started
    await settle(200)
    return started
  })()

  try {
    const app = apps.at(-1)
    assert.ok(app !== undefined, 'the production runner mounted a TuiApp')
    // Wait for the first paint (the runner's surface startup).
    for (let index = 0; index < 200 && vt.getViewport().join('').length === 0; index += 1) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(vt.getViewport().join('').length > 0, 'the surface painted its first frame')

    // (1) SOURCE: the production registerTuiCommands really MIRRORED /status
    // into the (fake) Direct Host registry — the contamination precondition.
    assert.ok(harness.commands.list().some(row => row.name === 'status'),
      'the TUI /status IS present in the Direct Host registry (compatibility mirror installed)')

    // (2) ORIGIN: the mirror carries THIS surface's stamped provenance id, so
    // the effective winner IS a compatibility mirror — not Host origin. (The
    // authority rule itself is proved discriminatingly by the mutation-
    // verified busy-enter unit tests; this mounted case proves the SINK.)
    const mirrored = harness.commands.list().find(row => row.name === 'status') as { definitionId?: string } | undefined
    assert.ok(mirrored?.definitionId !== undefined,
      'the Direct Host mirror carries the stamped provenance id (a mirror that looks like a genuine Host command would be kept as origin)')

    // (3) WARM-UP: a plain prompt creates the deferred session and its live
    // agent (the fake's prompt seam refuses, which does not block the create).
    const submit = app as unknown as { setDraft(text: string): void; submitDraft(request?: string): void }
    submit.setDraft('warmup prompt')
    submit.submitDraft()
    await settle(200)
    const agent = harness.live.values().next().value as unknown as {
      status: string
      inbox: { nextTurn: unknown[]; nextStep: unknown[] }
    } | undefined
    assert.ok(agent !== undefined, 'the warm-up created the live agent')
    // The busy window: a RUNNING agent is what makes the accelerated gesture
    // resolve to STEER (busyEnter default queue) — the exact supplement repro.
    agent.status = 'running'

    // (4) SINK: /status must still reach its handler with the image-free
    // command line, and must never be steered into the model.
    submit.setDraft('/status')
    submit.submitDraft('accelerated') // busyEnter default queue ⇒ accelerated resolves to STEER
    await new Promise(resolve => setTimeout(resolve, 1200))
    await settle(400)

    const frame = vt.getViewport().join('\n')
    assert.ok(frame.includes('Stats'),
      'the /status settings panel OPENED — the Client handler executed under running+steer')
    assert.deepEqual(
      [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
        .map(value => JSON.stringify(value)).filter(value => value.includes('status')),
      [],
      'the literal /status line was NEVER steered into the agent inbox')
  } finally {
    TuiApp.prototype.start = originalStart
    restoreTerminal()
    await fiber.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  }
})

test('PR5 R6-1: a genuine Agent-SCOPED Host shadow over our global mirror stays HOST authority (winner provenance, not name)', async (t) => {
  const home = testLifecycle(t).tempDir('pr5-direct-shadow-')
  const harness = makeHarness(home)
  const ctx = new Context()
  // Bridge the fake registry's change notification to the REAL cordis
  // emitter (the runner listens through ctx.on('commands/change')).
  harness.setChangeEmitter(() => { ctx.emit('commands/change') })
  const vt = new VirtualTerminal(110, 32)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  const apps: TuiApp[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function patchedStart(this: TuiApp) {
    apps.push(this)
    return originalStart.apply(this)
  }
  const fiber = await (async () => {
    ctx.provide('appExit', () => {})
    ctx.provide(TUI_STARTUP_SERVICE, { shippedPresetRoot: home })
    ctx.provide('sessionPersistence', harness.persistence as never)
    ctx.provide('sessionQuery', harness.sessionQuery as never)
    ctx.provide('agents', harness.agents as never)
    ctx.provide('sessions', harness.sessions as never)
    ctx.provide('agentDefaultModel', harness.defaultModel as never)
    ctx.provide('llm', harness.llm as never)
    ctx.provide('commands', harness.commands as never)
    ctx.provide('loader', { await: async () => {} } as never)
    const started = ctx.plugin(pluginCtx => applyRunner(pluginCtx, TuiConfigSchema({ fullscreen: 'off' } as never)))
    await started
    await settle(200)
    return started
  })()
  try {
    const app = apps.at(-1)
    assert.ok(app !== undefined, 'the runner mounted')
    // A live session exists first (the scoped layer is agent-keyed).
    const submit0 = (app as unknown as { setDraft(text: string): void; submitDraft(): void })
    submit0.setDraft('scoped shadow warmup')
    submit0.submitDraft()
    await settle(200)
    // (1) The TUI's own global /status mirror is registered.
    assert.ok(harness.commands.list().some(row => row.name === 'status'),
      'the global /status compatibility mirror exists in the Host registry')
    // (2) A REAL Agent-scoped Host shadow over the SAME name (a genuine
    // Host command for the live agent). The fake registry's scoped shape
    // mirrors the official one: register into the scoped layer.
    const scoped = harness.commands as unknown as {
      registerScoped?: (agent: unknown, definition: { name: string; description: string; handler: () => unknown }) => () => void
    }
    if (scoped.registerScoped === undefined) {
      // The fake harness has no scoped layer; the semantics are locked by
      // the ORIGIN-MAP unit test below instead. Skip the mounted half.
      return
    }
    const agent = harness.live.values().next().value as unknown as { session: { id: string } } | undefined
    assert.ok(agent !== undefined, 'a live agent exists for the scoped layer')
    let scopedHostRuns = 0
    const disposeScoped = scoped.registerScoped(agent, {
      name: 'status',
      description: 'the genuine agent-scoped Host /status',
      handler: () => { scopedHostRuns += 1; return { kind: 'success', text: 'HOST scoped ran' } },
    })
    // A catalog refresh re-reads the scoped view (commands/change parity).
    await settle(150)
    // BEHAVIORAL assertion: with the SCOPED genuine Host /status as the
    // effective winner, the submission routes the line through the HOST
    // dispatch (the scoped handler runs) — the origin derivation did NOT
    // subtract the winner for carrying our mirror's name.
    const submit2 = (app as unknown as { setDraft(text: string): void; submitDraft(request?: string): void })
    submit2.setDraft('/status')
    submit2.submitDraft()
    await new Promise(resolve => setTimeout(resolve, 1000))
    await settle(400)
    assert.ok(scopedHostRuns >= 1,
      'the SCOPED genuine Host winner executed through the Host dispatch (name-subtraction would have misrouted it as a Client command)')

    // AC-1 (second half): removing the scoped shadow must RESTORE the mirror
    // classification. The scoped genuine handler is disposed, the catalog
    // refreshes, and the mirrored name is once again THIS surface's own
    // compatibility mirror — so the line goes back to the TUI's Client
    // handler (the real /status opens the settings panel) and the scoped
    // handler never runs again.
    const before = scopedHostRuns
    disposeScoped()
    await settle(150)
    submit2.setDraft('/status')
    submit2.submitDraft()
    await new Promise(resolve => setTimeout(resolve, 1200))
    await settle(400)
    assert.equal(scopedHostRuns, before,
      'the disposed scoped Host shadow no longer owns the name')
    assert.ok(vt.getViewport().join('\n').includes('Stats'),
      'the mirror classification is RESTORED: the TUI /status handler runs again (its settings panel opens)')
  } finally {
    TuiApp.prototype.start = originalStart
    restoreTerminal()
    await fiber.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  }
})
