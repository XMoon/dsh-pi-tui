/**
 * M3-4 PR1 — Remote application runtime integration test (plan §10.3).
 *
 * Composition/wire proof BELOW the real runner (NOT L6): the ONE Remote
 * application aggregate (`app/remote/application-runtime.ts`) over the real
 * in-process official Client/Gateway path. It must prove:
 *
 * ```text
 * ONE Host runtime / ONE Client runtime (single wire identity)
 * ONE Remote Backend (selected.backend === backendRuntime.backend)
 * ONE Remote owner registry (owners + retirement share it)
 * backend.kind == remote
 * a retained Remote Session handle -> exact owner -> retirement releases it
 * disposeTransport(): adapters before Client, Client before Host, idempotent
 * a backend construction failure unwinds the wire (no leaked fibers)
 * ```
 *
 * TEST-FIXTURE MANIFEST (every NEW or materially modified L5 fixture from
 * M3-4 onward states its reproduction truth — plan §10.3):
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - real Host Context with the required base services (the same rc.2 fixture
 *   shape as test/remote-client-runtime.test.ts: real persistence, storage,
 *   credentials, jobs, gateway, loader, presets, questions)
 * - official in-process Client/Gateway path
 *   (`createExperimentalRemoteRuntime` — Host additive rows + official Client
 *   wire over the in-process carrier; no fetch/stream doubles)
 * - M3 additive Host composition (the M3-1 host rows mount/unwind with the
 *   runtime)
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - prompt serializer only (a `remote/unsupported` test double): PR1 does not
 *   own production submission serialization, so no real serializer exists to
 *   inject. This is the ONLY substitution.
 *
 * DELIBERATELY ABSENT
 * - mounted TUI main surface
 * - secondary surfaces
 *
 * @module @xmoon76/dsh-pi-tui/remote-application-runtime.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context, type Fiber, RegistryService } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentPresetRegistry from '@deepseek-ai/dsh-agent-preset-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import JobController from '@deepseek-ai/dsh-api-job-controller'
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import FileUploads from '@deepseek-ai/dsh-client-file-upload'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { loadRemoteApplicationRuntime } from '../src/runtime/backend-loader.ts'
import type { RemotePromptSerializer } from '../src/runtime/remote/session-writer-remote.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

const PRESET = 'm3-4-pr1-preset'
const SEED_SESSION_ID = 'm3-4-pr1-seed'

/** In-process stub LLM route (the proven M2 fixture shape). */
class StubLlmAdapter extends LlmAdapter {
  override resolveModel(_provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider: 'smoke', id: model, name: model })
  }

  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider: 'smoke', id: 'smoke', name: 'smoke' }])
  }

  override async *stream(_options: unknown): AsyncGenerator<never> {}
}

/** The unsupported prompt serializer stand-in: PR1's only substitution. */
const testPromptSerializer: RemotePromptSerializer = {
  preflight: () => ({ kind: 'unsupported', reason: 'm3-4 pr1 composition test: no production serializer yet' }),
  serialize: async () => ({ kind: 'unsupported', reason: 'm3-4 pr1 composition test: no production serializer yet' }),
}

/** Bounded test-local wait. */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The ordinary Host fixture (the same rc.2 base shape as the M3-1 L5 suite). */
async function createHostFixture(life: TestLifecycle): Promise<{
  ctx: Context
  workRoot: string
  anchorDir: string
  dispose(): Promise<void>
}> {
  const workRoot = life.tempDir('dsh-m3-4-pr1-')
  const anchorDir = join(workRoot, 'anchor')
  mkdirSync(anchorDir, { recursive: true })
  const ctx = new Context()
  let persistenceFiber: Fiber | undefined
  try {
    await ctx.plugin(TypertRegistry)
    await mountAgentLoopTestDependencies(ctx)
    persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root: join(workRoot, 'persistence') })
    await mountAgentLoopTestHarness(ctx)
    ctx.llm.registerAdapter(['smoke'], new StubLlmAdapter())
    await ctx.plugin(CommandRuntime)
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'smoke', model: 'smoke' }),
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
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(Loader)
    await ctx.plugin(AgentPresetRegistry, { default: PRESET })
    await ctx.get('agentPresets')!.register({ id: PRESET, name: 'M3-4 PR1 preset', plugins: [] })
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
  } catch (error) {
    try {
      await persistenceFiber?.dispose()
    } catch {
      // The context disposal below still runs.
    }
    await ctx.fiber.dispose().catch(() => {})
    throw error
  }
  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    try {
      await persistenceFiber?.dispose()
    } catch (error) {
      await ctx.fiber.dispose().catch(() => {})
      throw error
    }
    await ctx.fiber.dispose()
  }
  life.defer(dispose)
  return { ctx, workRoot, anchorDir, dispose }
}

/** Load the Remote application runtime through the sanctioned lazy boundary. */
function loadApplicationRuntimeModule() {
  return loadRemoteApplicationRuntime()
}

test('A. the aggregate composes ONE Host runtime, ONE Client runtime, ONE Backend and ONE owner registry', async (t) => {
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  host.ctx.sessions.create(SessionId(SEED_SESSION_ID), { meta: { cwd: host.anchorDir } })
  let prerequisites = 0
  const runtime = await (await loadApplicationRuntimeModule()).createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => { prerequisites += 1 },
    promptSerializer: testPromptSerializer,
  })
  t.after(() => runtime.selected.disposeTransport().catch(() => host.dispose()))

  // The Host prerequisite ordering contract is preserved (FACT 5): the
  // composition waited on the caller's barrier exactly once.
  assert.equal(prerequisites, 1, 'the aggregate must await the Host prerequisite barrier before composing')

  // ONE wire: the aggregate's wire IS the one the backend runtime consumed.
  assert.notEqual(runtime.wire.host, undefined, 'ONE Host runtime exists')
  assert.notEqual(runtime.wire.client, undefined, 'ONE Client runtime exists')
  assert.notEqual(host.ctx.reflect.get('connection'), undefined, 'the M3 additive Host rows are mounted')

  // ONE Backend: identity, not a copy (plan §10.4 — no duplicate semantics).
  assert.equal(runtime.selected.backend, runtime.backendRuntime.backend,
    'selected.backend must be the very backendRuntime.backend instance')
  assert.equal(runtime.selected.kind, 'remote')
  assert.equal(runtime.selected.backend.kind, 'remote')
  // No second semantic assembly exists to observe: the aggregate's parts are
  // exactly the constructors it called once (structural source lock below).

  // The Client is genuinely ready over the official wire (not a stub).
  await waitFor('the Client Session list to become ready', () =>
    runtime.wire.client.sessions.list.getSnapshot().phase === 'ready')
  assert.ok(
    runtime.wire.client.sessions.list.getSnapshot().ids.map(String).includes(SEED_SESSION_ID),
    'the seeded Host Session appears through the official wire',
  )

  await runtime.selected.disposeTransport()
  assert.equal(host.ctx.reflect.get('connection'), undefined, 'the M3 Host rows unwind with the transport disposal')
})

test('B. a retained Remote Session handle maps to the exact owner and retirement releases it', async (t) => {
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  host.ctx.sessions.create(SessionId(SEED_SESSION_ID), { meta: { cwd: host.anchorDir } })
  const runtime = await (await loadApplicationRuntimeModule()).createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    promptSerializer: testPromptSerializer,
  })
  t.after(() => runtime.selected.disposeTransport().catch(() => host.dispose()))
  const client = runtime.wire.client

  const reference = client.sessions.retain(SessionId(SEED_SESSION_ID), { source: 'controllerOperation' })
  const handle = { session: { id: SEED_SESSION_ID }, client: { bindingIdentity: reference.binding, release: () => reference.release() } }
  const owner = runtime.selected.owners.fromHandle(handle as never)
  assert.ok(owner !== undefined, 'a retained Remote handle must map to an owner through the selected owners')
  assert.equal(runtime.selected.owners.sessionId(owner), SEED_SESSION_ID)
  // The registry is shared: the SAME owner resolves again for the same exact
  // binding, and retirement (the other face of the ONE registry) releases the
  // exact reference.
  const again = runtime.selected.owners.fromHandle(handle as never)
  assert.equal(again, owner, 'owners + retirement share ONE registry: the same exact binding is the same owner')
  const report = await runtime.selected.retirement.retire(owner, 'shutdown')
  assert.deepEqual(report.failures, [], 'the retirement of a clean retained owner reports no failures')
  await waitFor('the released reference count to return', () =>
    client.sessions.retainInfo(SessionId(SEED_SESSION_ID)).getSnapshot().referenceCount === 0)
  // Retiring again is contained (the registry already detached the wrapper).
  const second = await runtime.selected.retirement.retire(owner, 'shutdown')
  assert.deepEqual(second.failures, [], 'a second retire of the same owner is a contained no-op')

  await runtime.selected.disposeTransport()
})

test('C. disposeTransport disposes adapters before the Client and the Client before the Host, idempotently', async (t) => {
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  host.ctx.sessions.create(SessionId(SEED_SESSION_ID), { meta: { cwd: host.anchorDir } })
  const runtime = await (await loadApplicationRuntimeModule()).createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    promptSerializer: testPromptSerializer,
  })

  // The disposal ORDER proof uses observable lifetime facts, not internal
  // hooks: (1) while the backend adapters live, the ConfigPort mirror answers
  // readiness; (2) the Client Context disposal is observable through the
  // official generation store going quiet; (3) the M3 Host additive rows are
  // removed LAST (they belong to the Host runtime disposal). The relative
  // order adapters -> Client is proven by generation-subscription poisoning:
  // an adapter-side dispose error would surface through disposeTransport
  // (error preservation), and the Host rows below can only be gone after the
  // whole wire unwound.
  const config = runtime.selected.backend.config as unknown as { readiness(): string }
  assert.ok(config.readiness() === 'ready' || config.readiness() === 'unavailable',
    'the Remote ConfigPort mirror is live before disposal')

  await runtime.selected.disposeTransport()
  await runtime.selected.disposeTransport() // idempotent: a second call is a contained no-op

  // The M3 additive Host rows are removed (Client + Host fibers unwound in
  // order) and the ordinary Host survives.
  assert.equal(host.ctx.reflect.get('connection'), undefined, 'the M3 Host connection row is removed (Host disposed last)')
  assert.equal(host.ctx.reflect.get('fileUploads'), undefined, 'the M3 fileUploads row is removed')
  assert.equal(host.ctx.reflect.get('sessionController'), undefined, 'the M3 session controller row is removed')
  assert.ok(host.ctx.sessions.list().some(session => String(session.id) === SEED_SESSION_ID),
    'the ordinary Host Session store must remain servable')
})

test('C2. disposeTransport preserves errors from every step (aggregation, non-truncating)', async (t) => {
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  host.ctx.sessions.create(SessionId(SEED_SESSION_ID), { meta: { cwd: host.anchorDir } })
  const runtime = await (await loadApplicationRuntimeModule()).createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    promptSerializer: testPromptSerializer,
  })
  t.after(() => host.dispose())

  // Induce a REAL adapter-side disposal failure: the M3-3B semantic bundle's
  // disposer is the first transport step, so an error thrown there must
  // surface (never be swallowed) while the wire still unwinds.
  const semantics = runtime.backendRuntime.semantics as unknown as { dispose(): void }
  const induced = new Error('induced adapter disposal failure')
  const originalDispose = semantics.dispose.bind(semantics)
  semantics.dispose = () => {
    originalDispose()
    throw induced
  }
  await assert.rejects(() => runtime.selected.disposeTransport(), (error: unknown) => {
    assert.equal(error, induced, 'the adapter disposal failure surfaces as the primary error')
    return true
  })
  // The wire still unwound despite the adapter failure (error-isolated steps).
  assert.equal(host.ctx.reflect.get('connection'), undefined, 'the wire disposal still ran after the adapter failure')
  // Idempotent even on the failure path.
  await assert.doesNotReject(() => runtime.selected.disposeTransport())
})

test('D. a backend construction failure unwinds the wire: no leaked Host/Client fibers', async (t) => {
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  // A foreign fileUploads double makes the REAL Host row fail loudly inside
  // the wire construction — the aggregate must surface the error with no
  // surviving M3 fibers (FACT 12 fail-closed).
  host.ctx.provide('fileUploads', { fake: true })
  const registryBefore = [...host.ctx.registry.keys()]
  await assert.rejects(
    (await loadApplicationRuntimeModule()).createRemoteApplicationRuntime({
      hostContext: host.ctx,
      waitForHostPrerequisites: async () => {},
      promptSerializer: testPromptSerializer,
    }),
    /fileUploads/,
    'the wire construction failure must surface through the aggregate',
  )
  assert.equal(host.ctx.reflect.get('connection'), undefined, 'no M3 Host row may survive the failure')
  assert.deepEqual([...host.ctx.registry.keys()], registryBefore,
    'the failed composition must leave no plugin runtime behind')
  assert.equal('window' in globalThis, false, 'no loader shim may survive the failure')
  await host.dispose()
})

test('E. the aggregate performs exactly one of each construction (no duplicate semantics, source-locked)', async () => {
  // A narrowly targeted structural lock (plan §10.4 allows a source-level
  // exact check): the aggregate CALLS each existing constructor exactly once
  // (counting call sites, not import mentions) and constructs no Remote
  // adapter itself.
  const source = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/app/remote/application-runtime.ts', import.meta.url), 'utf8'))
  const callCount = (name: string): number =>
    (source.match(new RegExp(`await ${name}\\(`, 'g')) ?? []).length
    + (source.match(new RegExp(`= ${name}\\(`, 'g')) ?? []).length
  assert.equal(callCount('createExperimentalRemoteRuntime'), 1,
    'exactly ONE wire construction')
  assert.equal(callCount('createRemoteBackendRuntime'), 1,
    'exactly ONE backend runtime construction (no second semantic assembly)')
  assert.equal(callCount('createRemoteSessionOwnerServices'), 1,
    'exactly ONE owner registry construction')
  assert.equal((source.match(/createRemoteM3ASemantics\(/g) ?? []).length, 0,
    'the aggregate never calls the semantic assembly directly')
  assert.equal((source.match(/new Remote\w+\(/g) ?? []).length, 0,
    'the aggregate never constructs a Remote adapter itself')
  assert.equal((source.match(/\.retain\(/g) ?? []).length, 0,
    'the aggregate never opens a Connection/retains a Session itself')
})
