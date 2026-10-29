/**
 * PR-D startup-resume reachability evidence (T12).
 *
 * The lifecycle plan asks whether a REAL startup resume can materialize a busy
 * owner and block the interactive TUI behind `Preparing conversation…`. This
 * file answers the Direct half with the REAL production topology: the official
 * AgentLoop, the official JSONL persistence, the real Session/session-query
 * services and the real runner. The only stand-ins are the peripheral
 * registries the runner injects (command registry, loader, default model).
 *
 * The seeded log ends in an OPEN turn (the crash shape a previous process can
 * leave behind). The official `agents.resume()` crash-recovery contract appends
 * `interrupted` closers and publishes an idle owner, so the pre-mount quiesce
 * has nothing to wait for. No synthetic `whenIdle` promise is involved here:
 * that shape is a failure-control fixture, never a production reachability
 * claim.
 *
 * PRODUCTION PREREQUISITES REPRODUCED:
 *   real installed-rc.4 AgentLoop + AgentRegistry, real JSONL persistence, real
 *   Session query engine, real runner composition, real `agents.resume`.
 * TEST STAND-INS / SUBSTITUTIONS:
 *   the peripheral command/default-model/loader registries only; the Direct case
 *   never calls a model.
 * DELIBERATELY ABSENT:
 *   a real paid provider, a physical terminal, and a Remote transport (the
 *   Remote half is qualified separately through the official Client binding).
 *
 * @module @xmoon76/dsh-pi-tui/startup-resume-reachability.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmAdapter, MessageId, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { RemoteSessionLifecycle } from '../../src/runtime/remote/session-lifecycle-remote.ts'
import { loadExperimentalRemoteRuntime } from '../../src/runtime/backend-loader.ts'
import { createRemoteSessionOwnerServices } from '../../src/app/remote/session-owners.ts'
import { apply as applyRunner, Config as TuiConfigSchema } from '../../src/index.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import {
  disposeContext,
  event,
  installVirtualProcessTerminal,
  makeHarness,
  settle,
} from '../support/runner-harness.ts'
import { installProbe } from '../support/runner-session-fixtures.ts'
import { createRemoteApplicationHostFixture, waitFor } from '../support/remote-application-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

/** Bounded wait on a real state, never a blind sleep. */
async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 15_000, stepMs = 10): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`${label}: waitUntil timed out after ${timeoutMs}ms`)
    await new Promise<void>(resolve => setTimeout(resolve, stepMs))
  }
}

/** The exact crash shape: a durable turn whose `turn/end` never landed. */
function openTurnEvents(): SessionEvent[] {
  return [
    event('turn/start', { turn: 1 }, 0),
    event('step/start', { turn: 1, step: 1 }, 1),
    event('user/message', {
      id: MessageId('startup-resume-user'),
      role: 'user',
      content: [{ type: 'text', text: 'the interrupted prompt' }],
      source: { kind: 'user' },
    }, 2, 'append'),
    // The keepInbox crash shape: a durable pending prompt stays parked. A
    // resume must NOT auto-wake it into a fresh turn during startup.
    event('agent/inbox/spliced', {
      target: 'next-turn',
      start: 0,
      inserted: [{
        id: MessageId('startup-resume-parked'),
        role: 'user',
        content: [{ type: 'text', text: 'the parked prompt' }],
        source: { kind: 'user' },
      }],
    }, 3),
  ]
}

test('a REAL Direct resume of an interrupted-turn session mounts without waiting on a busy owner', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-prd-real-resume-root-')
  const home = life.tempDir('dsh-prd-real-resume-home-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  const vt = new VirtualTerminal(100, 30)
  life.defer(installVirtualProcessTerminal(vt))
  const probe = installProbe()
  life.defer(probe.restore)

  // Boot 1: the PREVIOUS process leaves a real durable log whose tail turn is
  // open (the crash shape). The seeding context is disposed before the resume,
  // exactly as a process restart separates the two.
  const seedContext = new Context()
  life.defer(() => disposeContext(seedContext))
  await mountAgentLoopTestDependencies(seedContext, { workingDirectory: true })
  await seedContext.plugin(JsonlSessionPersistence, { root })
  const sessionId = SessionId('prd-real-resume-interrupted')
  const persistence = seedContext.get('sessionPersistence') as unknown as {
    create(init: {
      readonly id: ReturnType<typeof SessionId>
      readonly createdAt: number
      readonly version: number
      readonly cwd: string
      readonly isSeeded: boolean
      readonly delegationDepth: number
    }): Promise<{
      append(events: readonly SessionEvent[], options?: unknown): Promise<void>
      flush(): Promise<void>
      close(): Promise<void>
    }>
  }
  const handle = await persistence.create({
    id: sessionId,
    createdAt: 1_700_000_000_000,
    version: SESSION_FORMAT_VERSION,
    cwd: '/work',
    isSeeded: false,
    delegationDepth: 0,
  })
  await handle.append(openTurnEvents())
  await handle.flush()
  await handle.close()
  await disposeContext(seedContext)

  // Boot 2: the REAL production topology resumes that stored Session.
  const context = new Context()
  life.defer(() => disposeContext(context))
  await mountAgentLoopTestDependencies(context, { workingDirectory: true })
  await context.plugin(JsonlSessionPersistence, { root })
  await context.inject(SqliteSessionQueryEngine.inject, queryCtx => {
    new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
  })
  context.provide('appExit', () => {})
  context.provide(TUI_STARTUP_SERVICE, { sessionId: String(sessionId), shippedPresetRoot: home })
  await context.plugin(CommandRuntime)
  const peripherals = makeHarness(home, [], { provider: 'p', model: 'm' })
  context.provide('agentDefaultModel', peripherals.defaultModel as never)
  context.provide('loader', { await: async () => {} } as never)
  await mountAgentLoopTestHarness(context)

  const fiber = await context.plugin(pluginCtx => {
    applyRunner(pluginCtx, TuiConfigSchema({ fullscreen: 'off', sessionId: String(sessionId) } as never))
  })
  life.defer(() => fiber.dispose())

  // The pre-mount quiesce resolved: the real runner painted its first frame.
  await waitUntil(() => vt.getViewport().join('\n').includes('dsh-pi-tui'), 'the real runner first frame')
  assert.equal(probe.apps.length, 1, 'the real Direct resume mounted exactly one TuiApp')

  const agents = context.get('agents') as unknown as {
    get(id: ReturnType<typeof SessionId>): {
      readonly status: string
      readonly inbox: { readonly nextTurn: readonly unknown[] }
      whenIdle(): Promise<void>
    } | undefined
  }
  const agent = agents.get(sessionId)
  assert.ok(agent !== undefined, 'the official resume published a live Agent')
  assert.equal(agent.status, 'idle', 'the crash-recovered resume publishes an IDLE owner (not a busy turn)')
  assert.equal(agent.inbox.nextTurn.length, 1,
    'the durable parked prompt remains in the recovered inbox instead of auto-waking a startup turn')

  // The official recovery fact: the open turn is closed with an `interrupted`
  // reason at resume time, which is exactly why whenIdle has no work to await.
  const live = context.sessions.get(sessionId) as unknown as {
    snapshotEvents(): readonly SessionEvent[]
  }
  const lastTurnEnd = live.snapshotEvents().filter(candidate => candidate.type === 'turn/end').at(-1)
  assert.ok(lastTurnEnd !== undefined, 'the resumed log gained a terminal turn event')
  assert.deepEqual((lastTurnEnd.data as { reason?: unknown }).reason, { kind: 'interrupted' },
    'the synthetic closer records the crash-recovery reason, never a claimed completion')

  // The pre-mount wait must not own or consume the resumed owner's input seat:
  // Esc on an idle resumed session is a normal no-op, and the surface stays up.
  vt.sendInput('\x1b')
  await settle() // bounded microtask drain, not a wall-clock wait
  await vt.waitForRender()
  assert.equal(probe.apps.length, 1, 'Esc never tears down the mounted startup surface')
  assert.equal(agent.status, 'idle', 'Esc on an idle resumed owner does not fabricate activity')

  // HMR/exit retires the exact resumed owner once the surface is live.
  await fiber.dispose()
  await waitUntil(() => agents.get(sessionId) === undefined, 'the resumed owner retirement')
})

/** A held official Host endpoint: the real AgentLoop turn stays running until
 *  the official Client cancel aborts the request. */
class HeldWireLlmAdapter extends LlmAdapter {
  calls = 0
  aborts: string[] = []
  private gate: Promise<void> | undefined

  hold(): void {
    this.gate = new Promise<void>(() => {})
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    const gate = this.gate
    if (gate === undefined) return
    await new Promise<never>((_resolve, reject) => {
      const signal = options.signal
      if (signal === undefined) return
      if (signal.aborted) { reject(new Error('cancelled')); return }
      signal.addEventListener('abort', () => {
        this.aborts.push('aborted')
        reject(new Error('cancelled'))
      }, { once: true })
    })
  }
}

test('an official Remote running binding keeps the pre-mount idle wait open until the Host turn settles', async (t) => {
  const life = testLifecycle(t)
  const llm = new HeldWireLlmAdapter()
  const host = await createRemoteApplicationHostFixture(life, 'prd-remote-startup-running', { llmAdapter: llm })
  const runtime = await (await loadExperimentalRemoteRuntime()).createExperimentalRemoteRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
  })
  life.defer(() => runtime.dispose().catch(() => {}))
  const sessions = runtime.client.sessions
  await sessions.refresh()
  const lifecycle = new RemoteSessionLifecycle(sessions, runtime.client.connection.generation)
  const id = 'prd-remote-startup-running'
  const created = await lifecycle.create({ sessionId: id, cwd: host.anchorDir })
  assert.equal(created.outcome.kind, 'created', `the official create must commit: ${created.ownership}/${created.outcome.kind}`)
  if (created.outcome.kind !== 'created') return
  const handle = created.outcome.handle
  assert.ok(handle.client !== undefined, 'the official create must carry its exact Client owner')

  const agents = host.ctx.get('agents') as unknown as {
    get(id: ReturnType<typeof SessionId>): { followup(message: unknown): void } | undefined
  }
  const agent = agents.get(SessionId(id))
  assert.ok(agent, 'the Host Agent must be live for the created Session')
  llm.hold()
  const callsBefore = llm.calls
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'hold the startup-resume turn' }],
    source: { kind: 'user' },
  }))
  await waitFor('the held model request started', () => llm.calls > callsBefore, 15_000)
  const binding = sessions.binding(SessionId(id)) as unknown as {
    readonly session: { getSnapshot(): { readonly running: boolean } }
  } | undefined
  assert.ok(binding !== undefined, 'the retained exact binding must be observable')
  await waitFor('the real Host turn running', () => binding.session.getSnapshot().running === true)

  const services = createRemoteSessionOwnerServices({
    binding: (sessionId: string) => sessions.binding(SessionId(sessionId)) as never,
  }, runtime.client.connection.generation)
  const owner = services.owners.fromHandle(handle)
  assert.ok(owner, 'the created Client owner must map to the exact Remote owner')

  // This is the EXACT `whenIdleOrAbort` the bootstrap pre-mount quiesce uses.
  // The binding's official `running` bit is true, so the wait has exactly two
  // producers of settlement: running=false or abort. The short window merely
  // gives an accidental event-loop settlement a chance to surface; it is not a
  // latency guess.
  let settled: boolean | 'unobservable' | undefined
  const idle = services.retirement.whenIdleOrAbort(owner, new AbortController().signal)
  void idle.then(result => { settled = result })
  // only running=false/abort can settle this wait; the window exposes any
  // accidental settlement, not a latency guess.
  await new Promise<void>(resolve => setTimeout(resolve, 50)) // negative observation window
  assert.equal(settled, undefined, 'a REAL running binding must keep the pre-mount wait open')

  assert.deepEqual(await services.retirement.cancel(owner), { kind: 'committed', value: undefined })
  assert.deepEqual(llm.aborts, ['aborted'], 'the official Host Agent observed the wire cancel')
  await waitFor('the Host turn idle after the wire cancel', () => binding.session.getSnapshot().running === false)
  assert.equal(await idle, false, 'the wait settles only after the exact binding reports idle')
})
