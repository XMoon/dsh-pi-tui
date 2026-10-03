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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { apply as applyRunner, Config as TuiConfigSchema } from '../src/index.ts'
import { TuiApp } from '../src/tui-app.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { installVirtualProcessTerminal } from './support/runner-harness.ts'

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
  const commands = {
    register: (definition: { name: string; description: string; handler: (...args: never[]) => unknown }) => {
      definitions.set(definition.name, definition)
      return () => {
        if (definitions.get(definition.name) === definition) definitions.delete(definition.name)
      }
    },
    list: () => [...definitions.values()].map(({ name, description }) => ({ name, description })),
    // A REAL dispatch (what the production in-process Host service does):
    // parse the line, invoke the registered handler, wrap its result.
    execute: async (_agent: unknown, line: string) => {
      const name = line.replace(/^\//, '').split(/\s+/)[0] ?? ''
      const definition = definitions.get(name)
      if (definition === undefined) return undefined
      const rawInput = line.replace(/^\/[^\s]+\s?/, '')
      const result = await definition.handler({ name, rawInput } as never)
      return { result: result as { kind: 'success' } | { kind: 'error'; text: string } }
    },
    handler: (name: string) => definitions.get(name)?.handler,
  }
  return { persistence, sessionQuery, agents, sessions, defaultModel, llm, commands, live }
}

async function settle(rounds = 40): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

test('PR5 AC-1 Direct: a successful Host-registry compatibility mirror stays CLIENT_COMMAND — /status reaches its handler under running+steer', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pr5-direct-origin-'))
  t.after(() => { rmSync(home, { recursive: true, force: true }) })
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

    // (2) The runner's OWN authority seam reflects mirror≠origin: a mirrored
    // name answers FALSE on the (now origin-aware) Host-name authority.
    const runnerFace = (app as unknown as {
      runnerCommands?: { hostCatalogResolves(name: string): boolean }
    }).runnerCommands
    if (runnerFace !== undefined) {
      assert.equal(runnerFace.hostCatalogResolves('status'), false,
        'the mirrored /status is NOT genuine Host origin (origin-aware name authority)')
    }

    // (3) SINK: create a session, drive its agent RUNNING, then submit
    // /status with the steer-producing accelerated gesture. The Client
    // handler must run (the settings panel opens) — never a steer of the
    // literal line, never an agent prompt.
    const submit = (app as unknown as { setDraft(text: string): void; submitDraft(request?: string): void })
    submit.setDraft('warm up the session')
    submit.submitDraft()
    await settle(200)
    const agent = harness.live.values().next().value as unknown as { status: string } | undefined
    assert.ok(agent !== undefined, 'a live Direct agent exists')
    ;(agent as unknown as { status: string }).status = 'running'
    await settle(20)

    submit.setDraft('/status')
    submit.submitDraft('accelerated') // busyEnter default queue ⇒ accelerated resolves to STEER
    await new Promise(resolve => setTimeout(resolve, 1200))
    await settle(400)

    const frame = vt.getViewport().join('\n')
    assert.ok(frame.includes('Stats'),
      'the /status settings panel OPENED — the Client handler executed under running+steer')

    // (4) The agent inbox never received the literal command (no steer): the
    // fake agent's inbox is the counterfactual authority.
    const inbox = (agent as unknown as { inbox: { nextTurn: unknown[]; nextStep: unknown[] } }).inbox
    assert.deepEqual([...inbox.nextTurn, ...inbox.nextStep].map(value => JSON.stringify(value)).filter(value => value.includes('status')), [],
      'the literal /status line was NEVER steered into the agent inbox')
  } finally {
    TuiApp.prototype.start = originalStart
    restoreTerminal()
    await fiber.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  }
})
