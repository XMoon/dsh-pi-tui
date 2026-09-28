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
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { loadExperimentalRemoteRuntime } from '../src/runtime/backend-loader.ts'
import type { ExperimentalRemoteRuntime } from '../src/app/remote/runtime.ts'
import { createRemoteM3ASemantics, type RemoteM3ASemantics } from '../src/app/remote/m3a-semantics.ts'
import { acquireMainSurfaceReference, type MainSurfaceReference } from '../src/runtime/remote/session-reference.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

const PRESET = 'm3a-smoke-preset'
const MAIN = 'm3a-main'
const CHILD = 'm3a-child'

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
    // resolves the live Agent from the exact session identity); the child
    // stays a cold persisted Session for the retained-read probe.
    await host.harness.create(SessionId(MAIN), undefined, { cwd: host.anchorDir })
    await host.harness.create(SessionId(CHILD), undefined, { cwd: join(host.anchorDir, 'child') })

    // P1 — Session list/read through the official Client list face.
    const rows = await semantics.sessionReader.list(undefined)
    assert.ok(rows !== undefined, 'the list capability is available')
    const ids = rows!.map(row => row.id)
    assert.ok(ids.includes(MAIN), `the seeded main session is listed: ${JSON.stringify(ids)}`)
    assert.ok(rows!.find(row => row.id === MAIN)!.cwd === host.anchorDir,
      `the official cwd fact rides the row: ${JSON.stringify(rows!.find(row => row.id === MAIN))}`)

    // Retain BOTH sessions the way the TUI's surfaces would.
    const mainRef: MainSurfaceReference = acquireMainSurfaceReference(runtime.client.sessions, SessionId(MAIN))
    const childRef: MainSurfaceReference = acquireMainSurfaceReference(runtime.client.sessions, SessionId(CHILD))

    // P2 — the contextPressure projection face (unmeasured until usage: the
    // truthful official value, never an invented number).
    assert.equal(semantics.sessionReader.measureContext(MAIN), undefined,
      'no provider usage yet — the official pressure projection reads unmeasured')

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

    // P8 — the turnOutline projection (no turns yet: the official empty
    // outline, still a projection read — never a history fold).
    assert.deepEqual(semantics.sessionReader.turnOutline(MAIN), [])

    // P9 — the retained CHILD Session reads its own projection facts.
    const childStatus = semantics.sessionReader.sessionStatus(CHILD)
    assert.deepEqual(childStatus, {
      sessionId: CHILD,
      cwd: join(host.anchorDir, 'child'),
    }, 'the child reads its own cwd fact only — no parent fallback, no invented values')
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
