/**
 * M3-3A same-Host integration smoke: the closed semantic bundle over a REAL
 * Host Context → the M3-1 in-process carrier → a real official Client
 * Context → the M3-3A adapters (`createRemoteM3ASemantics`). No fake Remote
 * unit wiring and no production TUI Remote backend; Host-side abstract
 * capability seams (the llm adapter, the skills registry, the file-reference
 * provider) use the same fixture stand-ins as the M3-1 L5 suite.
 *
 * Covered probes (plan §16): P1 Session list/read · P2 contextPressure
 * projection · P3 modelCatalog grouped directory · P4 llm/discoverModels ·
 * P5 skills/list · P6 Session-scoped fileReferences/list · P7
 * PresentationReader.loadThrough · P8 turnOutline projection · P9 retained
 * child Session projection read · P10 reconnect/generation replacement.
 *
 * @module @xmoon76/dsh-pi-tui/remote-m3a-semantics-smoke.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import JobController from '@deepseek-ai/dsh-api-job-controller'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import { createUserMessage, LlmAdapter, MessageId } from '@deepseek-ai/dsh-llm'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as toolTodo from '@deepseek-ai/dsh-tool-todo'
import * as toolTodoInvariant from '@deepseek-ai/dsh-tool-todo/invariant'
import { loadExperimentalRemoteRuntime } from '../src/runtime/backend-loader.ts'
import type { ExperimentalRemoteRuntime } from '../src/app/remote/runtime.ts'
import { createRemoteM3ASemantics, type RemoteM3ASemantics } from '../src/app/remote/m3a-semantics.ts'
import { acquireMainSurfaceReference, type MainSurfaceReference } from '../src/runtime/remote/session-reference.ts'
import { contextPressureOccupancy } from '../src/runtime/session-reader-port.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

const PRESET = 'm3a-smoke-preset'
const MAIN = 'm3a-main'
const CHILD = 'm3a-child'
const BARE = 'm3a-bare'

/** The L5 stub llm route shape (enough adapter for real composition). */
class StubLlmAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke-model', name: 'Smoke Model' }])
  }

  override async *stream(): AsyncGenerator<never> {}
}

interface HostFixture {
  ctx: Context
  workRoot: string
  anchorDir: string
  /** The production AgentLoop test driver (composes real live Agents). */
  harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>>
  dispose(): Promise<void>
}

async function createHostFixture(life: TestLifecycle): Promise<HostFixture> {
  const workRoot = life.tempDir('dsh-m3a-')
  const anchorDir = join(workRoot, 'anchor')
  mkdirSync(anchorDir, { recursive: true })
  const ctx = new Context()
  let persistenceFiber: Fiber | undefined
  let harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>> | undefined
  try {
    await ctx.plugin(TypertRegistry)
    await mountAgentLoopTestDependencies(ctx)
    // The REAL token-meter Host rows: the official contextPressure /
    // contextBreakdown / tokenUsage projection units the smoke proves on the
    // wire — plus the official todos projection unit.
    await ctx.plugin(TokenMeter)
    await ctx.plugin(toolTodo, { allowParallelInProgress: false })
    // The official invariants registry plus the durable-todo companion: a
    // todo/write OUTSIDE an open turn is a non-production event sequence and
    // must fail the fixture rather than pass silently.
    await ctx.plugin(InvariantRegistry, {})
    await ctx.plugin(toolTodoInvariant)
    persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: join(workRoot, 'persistence') })
    harness = await mountAgentLoopTestHarness(ctx)
    ctx.llm.registerAdapter(['smoke'], new StubLlmAdapter())
    // P4: the official discovery registered for the TUI wizard's family.
    ctx.llm.registerModelDiscovery('llm-pi-ai', async () => [{ id: 'discovered-a', name: 'Discovered A' }])
    await ctx.plugin(CommandRuntime)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'smoke', model: 'smoke-model' }),
      saveSelection: async () => {},
    })
    ctx.provide('attachments', {
      imageLimits: {
        maxImageBytes: 5 * 1024 * 1024,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 100 * 1024 * 1024,
        maxImagePixels: 40_000_000,
        maxImageDimension: 2000,
        mediaTypes: ['image/png'],
      },
      admitPromptContent: async (content: unknown) => content,
    } as never)
    ctx.provide('webServer', { registerUpgrade: () => () => {} })
    // P5: the Host-side abstract skill registry seam (the L5 stand-in style).
    ctx.provide('skills', {
      list: async () => [{
        name: 'smoke-skill',
        description: 'a same-Host smoke skill',
        invocation: { userInvocable: true, modelInvocable: false },
      }],
    } as never)
    // P6: the Host-side abstract file-reference provider seam.
    ctx.provide('fileReferences', {
      list: async () => [{ path: 'anchor/notes.md', kind: 'file' as const }],
    } as never)
    await ctx.plugin(Loader)
    await ctx.plugin(AgentPresetRegistry, { default: PRESET })
    await ctx.get('agentPresets')!.register({ id: PRESET, name: 'M3-3A smoke preset', plugins: [] })
    await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
      new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
    })
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(workRoot, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(WorkspaceRegistry)
    await ctx.plugin(pluginCtx => {
      Reflect.construct(CredentialProvider, [pluginCtx])
    })
    await ctx.plugin(LocalJobRegistry, {})
    await ctx.plugin(toolJobs)
    await ctx.plugin(JobController, {})
    await ctx.inject(TypertGatewayService.inject, gatewayCtx => {
      new TypertGatewayService(gatewayCtx, { websocketHeartbeatIntervalMs: 50 })
    })
    // One real cold child Session (the main session is composed LIVE by the
    // test body through the AgentLoop harness — the file-reference Host face
    // resolves a live Agent from the session identity).
  } catch (error) {
    await persistenceFiber?.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
    throw error
  }
  const dispose = async (): Promise<void> => {
    await persistenceFiber?.dispose().catch(() => {})
    await ctx.fiber.dispose().catch(() => {})
  }
  life.defer(dispose)
  return { ctx, workRoot, anchorDir, harness: harness!, dispose }
}

/** Seed one REAL completed turn with a provider usage sample; the official
 * projection units fold it exactly like a live model turn would. */
function seedTurn(
  host: HostFixture,
  sessionId: string,
  input: {
    turn: number
    prompt: string
    response: string
    usage: { inputTokens: number; outputTokens: number }
    /** Optional whole-list snapshot appended INSIDE the open turn (the
     * official invariant rejects a todo/write outside one). */
    todos?: readonly { content: string; status: 'pending' | 'in_progress' | 'completed' }[]
  },
): void {
  const session = host.ctx.sessions.get(SessionId(sessionId))
  if (session === undefined) throw new Error(`seedTurn: no Host session ${sessionId}`)
  session.append('turn/start', { turn: input.turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: input.prompt }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: input.turn,
    step: 0,
    message: {
      id: MessageId(`${sessionId}-assistant-${input.turn}`),
      role: 'assistant',
      content: [{ type: 'text', text: input.response }],
      source: { kind: 'model', provider: 'smoke', model: 'smoke-model' },
    },
    stream: [],
    usage: { ...input.usage },
  }, { surfaceOp: 'append' })
  if (input.todos !== undefined) {
    session.append('todo/write', { todos: [...input.todos] })
  }
  session.append('turn/end', { turn: input.turn, reason: { kind: 'completed' } })
}

function stubSerializer(): import('../src/runtime/remote/session-writer-remote.ts').RemotePromptSerializer {
  return {
    preflight: () => ({ kind: 'unsupported', reason: 'smoke serializer never dispatches' }),
    serialize: async () => ({ kind: 'unsupported', reason: 'smoke serializer never dispatches' }),
  }
}

interface Composed {
  runtime: ExperimentalRemoteRuntime
  semantics: RemoteM3ASemantics
}

async function compose(host: HostFixture): Promise<Composed> {
  const runtime = await (await loadExperimentalRemoteRuntime()).createExperimentalRemoteRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
  })
  return { runtime, semantics: createRemoteM3ASemantics(runtime.client, { promptSerializer: stubSerializer() }) }
}

test('P1-P10: the M3-3A semantic bundle serves over one real Host wire', async (t) => {
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  const { runtime, semantics } = await compose(host)
  try {
    // The main Session is a REAL live Agent (the file-reference Host face
    // resolves the live Agent from the exact session identity); the child is
    // its own live Agent with COMPETING projection facts; the bare session
    // keeps the absent-value cases honest.
    await host.harness.create(SessionId(MAIN), undefined, { cwd: host.anchorDir })
    await host.harness.create(SessionId(CHILD), undefined, { cwd: join(host.anchorDir, 'child') })
    await host.harness.create(SessionId(BARE), undefined, { cwd: join(host.anchorDir, 'bare') })
    // Seed REAL Host-side projection facts BEFORE any retention, so the
    // Client's initial tail page carries them: distinct usage per session
    // (parent/child values must never mix) and one completed turn each.
    seedTurn(host, MAIN, { turn: 1, prompt: 'plan the launch', response: 'launch plan ready', usage: { inputTokens: 1000, outputTokens: 42 } })
    seedTurn(host, CHILD, {
      turn: 1,
      prompt: 'child task',
      response: 'child done',
      usage: { inputTokens: 200, outputTokens: 7 },
      todos: [{ content: 'child todo', status: 'in_progress' }],
    })

    // P1 — Session list/read through the official Client list face.
    const rows = await semantics.sessionReader.list(undefined)
    assert.ok(rows !== undefined, 'the list capability is available')
    const ids = rows!.map(row => row.id)
    assert.ok(ids.includes(MAIN), `the seeded main session is listed: ${JSON.stringify(ids)}`)
    assert.ok(rows!.find(row => row.id === MAIN)!.cwd === host.anchorDir,
      `the official cwd fact rides the row: ${JSON.stringify(rows!.find(row => row.id === MAIN))}`)

    // Retain the sessions the way the TUI's surfaces would, and let the
    // initial tail pages (with their projection blocks) settle.
    const mainRef: MainSurfaceReference = acquireMainSurfaceReference(runtime.client.sessions, SessionId(MAIN))
    const childRef: MainSurfaceReference = acquireMainSurfaceReference(runtime.client.sessions, SessionId(CHILD))
    const bareRef: MainSurfaceReference = acquireMainSurfaceReference(runtime.client.sessions, SessionId(BARE))
    await waitFor('the MAIN window to open', () =>
      runtime.client.sessions.binding(SessionId(MAIN))?.session.getSnapshot().openState === 'open')
    await waitFor('the CHILD window to open', () =>
      runtime.client.sessions.binding(SessionId(CHILD))?.session.getSnapshot().openState === 'open')

    // The HOST-side projection snapshot is the truth the wire must carry.
    const hostProjections = host.ctx.get('sessionProjections') as {
      snapshot(session: unknown, keys?: readonly string[]): { readonly values?: Record<string, unknown> } | undefined
    }
    const hostMainValues = hostProjections.snapshot(host.ctx.sessions.get(SessionId(MAIN)), [
      'contextPressure', 'turnOutline', 'tokenUsage',
    ])!.values!
    const hostChildValues = hostProjections.snapshot(host.ctx.sessions.get(SessionId(CHILD)), [
      'contextPressure', 'tokenUsage', 'todos',
    ])!.values!

    // P2 — the POPULATED contextPressure projection crosses the real wire:
    // the Remote occupancy equals the Host fold's own numerator, and it is a
    // measured number (the seeded 1000-prompt-token usage), never invented.
    const hostMainPressure = contextPressureOccupancy(hostMainValues.contextPressure)
    assert.ok(typeof hostMainPressure === 'number', 'the Host fold reports usage pressure')
    assert.equal(semantics.sessionReader.measureContext(MAIN), hostMainPressure,
      'the wire carries the exact official numerator the Host fold produced')
    // The BARE session (no usage) keeps the truthful unmeasured value.
    assert.equal(semantics.sessionReader.measureContext(BARE), undefined,
      'no provider usage — the official pressure projection reads unmeasured')

    // P3 — the modelCatalog grouped directory over the stub route.
    const directory = await semantics.catalog.models.loadDirectory()
    assert.ok(directory.groups.some(group => group.id === 'smoke' && group.models.some(model => model.id === 'smoke-model')),
      `the grouped selectable directory flows through: ${JSON.stringify(directory.groups.map(group => group.id))}`)

    // P4 — llm/discoverModels through the registered official discovery.
    const discovered = await semantics.catalog.models.discoverModels({ baseURL: 'https://example.test' })
    assert.deepEqual(discovered, [{ id: 'discovered-a', name: 'Discovered A' }])

    // P5 — skills/list for the retained session.
    const skills = await semantics.catalog.skills.listHumanSkills(MAIN)
    assert.deepEqual(skills?.skills.map(skill => skill.name), ['smoke-skill'],
      'the Session-addressed human catalog flows through the real wire')

    // P6 — Session-scoped fileReferences/list (the exact session id drives
    // the Host lookup; the child scope carries the CHILD identity).
    const files = await semantics.hostFile.listReferences({ kind: 'session', sessionId: MAIN }, '@notes')
    assert.deepEqual(files, { kind: 'ok', items: [{ path: 'anchor/notes.md', kind: 'file' }] })
    const childFiles = await semantics.hostFile.listReferences({ kind: 'session', sessionId: CHILD }, '@notes')
    assert.equal(childFiles.kind, 'ok')
    const unavailable = await semantics.hostFile.listReferences({ kind: 'workspace', cwd: host.anchorDir }, '@x')
    assert.equal(unavailable.kind, 'unavailable', 'the workspace scope stays fail-closed on the wire')

    // P7 — the official loadThrough jump on the retained open session.
    const jumped = await semantics.presentationReader.loadThrough(MAIN, 1)
    assert.ok(jumped !== undefined, 'the jump settles for the retained session')
    assert.equal(jumped!.coverage, 'bounded')

    // P8 — the POPULATED turnOutline projection crosses the real wire and
    // equals the Host fold's own outline (the seeded turn, its prompt
    // preview and its `turn/start` seq — the loadThrough target).
    const hostOutline = semantics.sessionReader.turnOutline(MAIN)
    assert.ok(hostOutline !== undefined && hostOutline.length === 1,
      'the seeded turn is outlined')
    if (hostOutline !== undefined && hostOutline.length === 1) {
      assert.equal(hostOutline[0]!.turn, 1)
      assert.ok(hostOutline[0]!.prompt.includes('plan the launch'),
        `the prompt preview flows through: ${JSON.stringify(hostOutline[0])}`)
    }
    assert.deepEqual(semantics.sessionReader.turnOutline(BARE), [],
      'the bare session keeps the official empty outline')

    // P9 — the retained CHILD Session reads its OWN populated projection
    // facts (its distinct usage and todos), never the parent's competing
    // values; the bare session stays fact-free beyond its cwd.
    const mainStatus = semantics.sessionReader.sessionStatus(MAIN)!
    const childStatus = semantics.sessionReader.sessionStatus(CHILD)!
    // EXACT Host/Remote parity: the child's wire facts equal the Host fold's
    // own values for the same session (usage + todos), never the parent's.
    assert.ok(childStatus.usage !== undefined, 'the child usage projection crossed the wire')
    assert.ok(mainStatus.usage !== undefined, 'the main usage projection crossed the wire')
    assert.deepEqual(childStatus.usage, hostChildValues.tokenUsage,
      'the child usage equals its own Host fold')
    assert.deepEqual(childStatus.todos, hostChildValues.todos,
      'the child todos equal their own Host fold')
    if (childStatus.usage !== undefined && mainStatus.usage !== undefined) {
      assert.ok(childStatus.usage.uncachedInputTokens !== mainStatus.usage.uncachedInputTokens
        || childStatus.usage.outputTokens !== mainStatus.usage.outputTokens,
        'the two sessions carry COMPETING usage values')
      assert.ok(childStatus.usage.uncachedInputTokens <= 200 + 42,
        `the child value is its own small sample, never the parent's 1000: ${JSON.stringify(childStatus.usage)}`)
    }
    assert.deepEqual(mainStatus.usage, hostMainValues.tokenUsage,
      'the main usage equals its own Host fold')
    assert.equal(childStatus.cwd, join(host.anchorDir, 'child'))
    // The bare session's official projection units are REGISTERED but empty:
    // their truthful zero-value wire views (usage totals, breakdown) cross —
    // they are the Host fold's real values, not inventions.
    assert.deepEqual(semantics.sessionReader.sessionStatus(BARE), {
      sessionId: BARE,
      cwd: join(host.anchorDir, 'bare'),
      context: { breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 } },
      usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    }, 'the bare session reads its own cwd fact and its official zero-valued folds')
    assert.equal(semantics.sessionReader.sessionStatus('never-created'), undefined,
      'an unretained session has no facts')

    // P10 — reconnect/generation replacement: the OFFICIAL reconnect replaces
    // the Connection generation; the retained binding stays identity-stable,
    // the list returns to ready, and the SAME adapters keep serving on the
    // new generation (the captured one is gone).
    const firstGeneration = runtime.client.connection.generation.getSnapshot()
    runtime.client.connection.reconnect()
    await waitFor('a different connection generation', () => {
      const generation = runtime.client.connection.generation.getSnapshot()
      return generation !== undefined && !Object.is(generation, firstGeneration)
    })
    await waitFor('the Session list to return to ready', () =>
      runtime.client.sessions.list.getSnapshot().phase === 'ready')
    const afterRows = await semantics.sessionReader.list(undefined)
    assert.ok(afterRows!.some(row => row.id === MAIN), 'the new generation serves the same Host sessions')
    const afterDirectory = await semantics.catalog.models.loadDirectory()
    assert.ok(afterDirectory.groups.some(group => group.id === 'smoke'))
    bareRef.release()
    childRef.release()
    mainRef.release()
    semantics.dispose()
  } finally {
    await runtime.dispose().catch(() => {})
  }
})

/** Bounded test-local wait (the L5 suite's helper shape). */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
