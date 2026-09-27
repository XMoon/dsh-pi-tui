/**
 * M3-1 L5 composition acceptance: the real dependency-closed experimental
 * Remote runtime (`docs/m3-entry-contract.md` §11 M3-1, plan §20–§22) over the
 * pinned official DSH packages. One ordinary Host Context composes the
 * production `createExperimentalRemoteRuntime` (Host additive rows + Client
 * wire) with no `fileUploads`/`fileUpload` test doubles, and every case below
 * drives the official carriers — never a mock and never the Direct backend.
 *
 * Covered cases (plan §22):
 * A host prerequisite barrier · B scoped loader exactness · C no
 * browser/global carrier dependency · D real connect + Session list
 * readiness · E real FileUpload dependency · F sessionStats + turnOutline
 * projections · G same-binding identity · H job roster · I
 * reconnect/generation reset · J archive route · K reverse disposal/no leaks
 * · L partial construction failure.
 *
 * @module @xmoon76/dsh-pi-tui/remote-client-runtime.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { SESSION_LOG_EXPORT_PATH } from '@deepseek-ai/dsh-session-log-export'
import { SqliteSessionQueryEngine } from '@deepseek-ai/dsh-session-query-sqlite'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { JobId } from '@deepseek-ai/dsh-jobs'
import * as toolJobs from '@deepseek-ai/dsh-tool-jobs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { loadExperimentalRemoteRuntime } from '../src/runtime/backend-loader.ts'
import {
  createRemoteClientRuntime,
  createScopedClientModuleLoader,
  loadOfficialClientModulesOnce,
  type RemoteClientRuntime,
} from '../src/app/remote/client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from '../src/app/remote/host-runtime.ts'
import type { ExperimentalRemoteRuntime } from '../src/app/remote/runtime.ts'

const SEED_SESSION_ID = 'm3-l5-seed'
const PRESET = 'm3-l5-preset'

/**
 * In-process stub LLM route (the proven M2 fixture shape): enough adapter for
 * real Agent composition; no turn runs in this suite.
 */
class StubLlmAdapter extends LlmAdapter {
  override resolveModel(_provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider: 'smoke', id: model, name: model })
  }

  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke', name: 'smoke' }])
  }

  override async *stream(_options: unknown): AsyncGenerator<never> {}
}
const EXPECTED_REGISTRATION_IDS = [
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-api-gateway',
  '@deepseek-ai/dsh-client-file-upload',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-api-job-controller',
]

/** Bounded test-local wait; production code carries no baked-in timeout. */
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The ordinary Host fixture: real rc.2 services, no M3 rows, no Remote composition. */
interface HostFixture {
  ctx: Context
  workRoot: string
  anchorDir: string
  /** The production AgentLoop test driver (real Agents for job-owner fixtures). */
  harness: Awaited<ReturnType<typeof mountAgentLoopTestHarness>>
  dispose(): Promise<void>
}

async function createHostFixture(): Promise<HostFixture> {
  const workRoot = mkdtempSync(join(tmpdir(), 'dsh-m3-l5-'))
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
    await ctx.plugin(Loader)
    await ctx.plugin(AgentPresetRegistry, { default: PRESET })
    await ctx.get('agentPresets')!.register({ id: PRESET, name: 'M3 L5 preset', plugins: [] })
    await ctx.inject(SqliteSessionQueryEngine.inject, queryCtx => {
      new SqliteSessionQueryEngine(queryCtx, { path: ':memory:', openAt: 'first-search' })
    })
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(workRoot, 'storages') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(WorkspaceRegistry)
    // The rc.2 credentials service ships one concrete provider whose
    // declaration is `abstract`; construct it inside the plugin fiber the way
    // the dsh base layer mounts it.
    await ctx.plugin(pluginCtx => {
      Reflect.construct(CredentialProvider, [pluginCtx])
    })
    await ctx.plugin(LocalJobRegistry, {})
    // The official agent-plane row that attaches the job controller serving
    // background-job starts (the registry refuses starts without one).
    await ctx.plugin(toolJobs)
    await ctx.plugin(JobController, {})
    await ctx.inject(TypertGatewayService.inject, gatewayCtx => {
      new TypertGatewayService(gatewayCtx, { websocketHeartbeatIntervalMs: 50 })
    })
  } catch (error) {
    await persistenceFiber?.dispose()
    await ctx.fiber.dispose()
    rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    throw error
  }
  return {
    ctx,
    workRoot,
    anchorDir,
    harness: harness!,
    async dispose(): Promise<void> {
      await persistenceFiber?.dispose()
      await ctx.fiber.dispose()
      rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}

/** Seed one real Host Session through the Host Session store, before composition. */
function seedHostSession(host: HostFixture): void {
  host.ctx.sessions.create(SessionId(SEED_SESSION_ID), { meta: { cwd: host.anchorDir } })
}

/** Load the Remote composition through the sanctioned lazy boundary. */
function loadRuntimeModule(): Promise<typeof import('../src/app/remote/runtime.ts')> {
  return loadExperimentalRemoteRuntime()
}

// ---------------------------------------------------------------------------
// Shared main fixture: one Host + one composed runtime for the behavior axis.
// ---------------------------------------------------------------------------

interface SharedRuntime {
  host: HostFixture
  runtime: ExperimentalRemoteRuntime
  client: RemoteClientRuntime
  hostRuntime: RemoteHostRuntime
}

let shared: SharedRuntime | undefined

async function getSharedRuntime(): Promise<SharedRuntime> {
  if (shared !== undefined) return shared
  const host = await createHostFixture()
  await seedHostSession(host)
  const runtime = (await loadRuntimeModule()).createExperimentalRemoteRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
  })
  const composed = await runtime
  shared = { host, runtime: composed, client: composed.client, hostRuntime: composed.host }
  return shared
}

// ---------------------------------------------------------------------------
// A — host prerequisite barrier
// ---------------------------------------------------------------------------

test('A. the runtime cannot compose or become ready ahead of the Host prerequisites', async () => {
  const host = await createHostFixture()
  try {
    let resolvePrerequisites: (() => void) | undefined
    const pending = (await loadRuntimeModule()).createExperimentalRemoteRuntime({
      hostContext: host.ctx,
      waitForHostPrerequisites: () => new Promise<void>(resolve => { resolvePrerequisites = resolve }),
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    // No M3 Host connection service before the gate resolves.
    assert.equal(host.ctx.reflect.get('connection'), undefined, 'no M3 Host row may mount before the prerequisite gate')
    assert.ok(resolvePrerequisites !== undefined, 'the runtime must be waiting on the prerequisite barrier')
    resolvePrerequisites()
    const runtime = await pending
    assert.notEqual(host.ctx.reflect.get('connection'), undefined, 'the M3 Host rows mount after the gate resolves')
    assert.notEqual(runtime.client.connection.generation.getSnapshot(), undefined)
    await runtime.dispose()
    assert.equal(host.ctx.reflect.get('connection'), undefined, 'the M3 rows unwind with the runtime')
  } finally {
    await host.dispose()
  }
})

// ---------------------------------------------------------------------------
// B — scoped loader exactness
// ---------------------------------------------------------------------------

test('B. the scoped loader capture is exact, single-flight, and restores the process globals', async () => {
  // The capture runs on first use and is reused for every later runtime.
  const first = await loadOfficialClientModulesOnce()
  const second = await loadOfficialClientModulesOnce()
  assert.ok(Object.is(first, second), 'the single-flight cache must return the identical module-export table')
  assert.ok(Object.isFrozen(first), 'the captured module exports must be frozen')
  for (const key of ['typert', 'connection', 'gateway', 'fileUpload', 'session', 'jobs'] as const) {
    assert.equal(typeof first[key].apply, 'function', `captured ${key} module must expose the plugin apply`)
    assert.ok(Array.isArray(first[key].inject), `captured ${key} module must expose the plugin inject`)
  }
  assert.equal(typeof first.connection.installConnection, 'function')

  // Loader admission rules: unknown id, duplicate id, non-function factory,
  // and a /client dependency requested before its capture are all rejected;
  // a missing expected id fails the completeness check.
  const loader = createScopedClientModuleLoader([
    '@deepseek-ai/dsh-typert-registry',
    '@deepseek-ai/dsh-api-gateway',
  ])
  assert.throws(
    () => loader.load({ id: '@deepseek-ai/dsh-not-allowed', factory: () => ({}) }),
    /unexpected registration id/,
    'an unknown registration id must be rejected',
  )
  const factory = () => ({ apply: () => {}, inject: [] })
  loader.load({ id: '@deepseek-ai/dsh-typert-registry', factory })
  assert.throws(
    () => loader.load({ id: '@deepseek-ai/dsh-typert-registry', factory }),
    /registered twice/,
    'a duplicate registration id must be rejected',
  )
  const freshLoader = createScopedClientModuleLoader(['@deepseek-ai/dsh-typert-registry'])
  assert.throws(
    () => freshLoader.load({ id: '@deepseek-ai/dsh-typert-registry', factory: undefined as never }),
    /non-function factory/,
    'a non-function factory must be rejected',
  )
  assert.throws(
    () => loader.requireModule('@deepseek-ai/dsh-api-gateway/client'),
    /before @deepseek-ai\/dsh-api-gateway was captured/,
    'a /client dependency requested before capture must be rejected',
  )
  assert.throws(
    () => loader.assertComplete(),
    /@deepseek-ai\/dsh-api-gateway never registered through __ModuleLoader__/,
    'a missing expected registration id must be rejected',
  )
  assert.deepEqual(loader.registeredIds(), ['@deepseek-ai/dsh-typert-registry'])
  const completeLoader = createScopedClientModuleLoader(EXPECTED_REGISTRATION_IDS)
  for (const id of EXPECTED_REGISTRATION_IDS) completeLoader.load({ id, factory })
  assert.deepEqual(completeLoader.registeredIds(), EXPECTED_REGISTRATION_IDS)
  assert.doesNotThrow(() => completeLoader.assertComplete(), 'the exact six ids must pass the completeness check')

  // The capture shim is gone after the capture.
  assert.equal('window' in globalThis, false, 'the temporary window global must be restored')
  assert.equal('__ModuleLoader__' in globalThis, false)
})

// ---------------------------------------------------------------------------
// C — no browser/global carrier dependency
// ---------------------------------------------------------------------------

test('C. compose/connect/list run with every browser global trapped or absent', async () => {
  const globalScope = globalThis as Record<string, unknown>
  const trapped = ['fetch', 'WebSocket', 'Worker', 'document', 'navigator', 'location']
  const previous = new Map<string, PropertyDescriptor | undefined>()
  for (const name of trapped) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalScope, name))
    Object.defineProperty(globalScope, name, {
      configurable: true,
      get() {
        throw new Error(`browser global "${name}" must not be reached by the Remote runtime`)
      },
    })
  }
  let host: HostFixture | undefined
  try {
    host = await createHostFixture()
    await seedHostSession(host)
    const runtime = await (await loadRuntimeModule()).createExperimentalRemoteRuntime({
      hostContext: host.ctx,
      waitForHostPrerequisites: async () => {},
    })
    await waitFor('client readiness under trapped globals', () =>
      runtime.client.sessions.list.getSnapshot().phase === 'ready')
    assert.ok(runtime.client.sessions.list.getSnapshot().ids.map(String).includes(SEED_SESSION_ID))
    await runtime.dispose()
  } finally {
    await host?.dispose()
    for (const [name, descriptor] of previous) {
      if (descriptor === undefined) delete globalScope[name]
      else Object.defineProperty(globalScope, name, descriptor)
    }
  }
})

// ---------------------------------------------------------------------------
// D–J — the shared-runtime behavior axis
// ---------------------------------------------------------------------------

test('D. real connect reaches a defined generation and the ready Session list carries the seeded Session', async () => {
  const { client } = await getSharedRuntime()
  assert.notEqual(client.connection.generation.getSnapshot(), undefined)
  const list = client.sessions.list.getSnapshot()
  assert.equal(list.phase, 'ready')
  assert.ok(list.ids.map(String).includes(SEED_SESSION_ID), 'the seeded Host Session must appear in the Client list')
})

test('E. the Client composes the real official fileUpload service before Sessions', async () => {
  const { client } = await getSharedRuntime()
  assert.notEqual(client.context.reflect.get('fileUpload'), undefined, 'the official Client fileUpload service must be live')
  assert.notEqual(client.context.reflect.get('sessions'), undefined, 'the Session Client started with fileUpload present')
})

test('F. the official retained Session carries the sessionStats and turnOutline projection surface', async () => {
  const { client } = await getSharedRuntime()
  const reference = client.sessions.retain(SessionId(SEED_SESSION_ID), { source: 'controllerOperation' })
  try {
    await reference.ready
    await waitFor('the retained Session history window to open', () =>
      reference.binding.session.getSnapshot().openState === 'open')
    const statsFace = reference.binding.session.projections.faceOf('sessionStats')
    const outlineFace = reference.binding.session.projections.faceOf('turnOutline')
    await waitFor('the whole-log projections to publish', () =>
      statsFace.getSnapshot() !== undefined && outlineFace.getSnapshot() !== undefined)
    // Presence/authority is the M3-1 proof: an empty Session legitimately
    // carries an empty outline.
    assert.ok(Array.isArray(outlineFace.getSnapshot()), 'turnOutline must publish an array surface')
  } finally {
    reference.release()
  }
  await waitFor('the reference count to return', () =>
    client.sessions.retainInfo(SessionId(SEED_SESSION_ID)).getSnapshot().referenceCount === 0)
})

test('G. two retained references of one materialized generation share the exact binding identity', async () => {
  const { client } = await getSharedRuntime()
  const first = client.sessions.retain(SessionId(SEED_SESSION_ID), { source: 'controllerOperation' })
  const second = client.sessions.retain(SessionId(SEED_SESSION_ID), { source: 'controllerOperation' })
  try {
    await first.ready
    await second.ready
    assert.ok(Object.is(first.binding, second.binding), 'same-generation retains must share one SessionBinding')
    assert.equal(
      client.sessions.retainInfo(SessionId(SEED_SESSION_ID)).getSnapshot().referenceCount,
      2,
      'both references must be counted',
    )
  } finally {
    first.release()
    second.release()
  }
})

test('H. the Job Client mirrors a real Host job roster', async () => {
  const { host, client } = await getSharedRuntime()
  const jobs = host.ctx.jobs as LocalJobRegistry
  // A background job's owner must have a live Agent: compose a real
  // production Agent (and its Session) through the AgentLoop harness, then
  // start one real owned job for that session.
  const ownerId = SessionId('m3-l5-job-owner')
  await host.harness.create(ownerId)
  const releaseWatch = client.jobs.watchRows(ownerId)
  let jobId: JobId | undefined
  try {
    // The producer settles on cancellation, so the fixture leaves no
    // never-settling registry record behind.
    let settle!: (outcome: { status: 'completed' | 'killed' | 'failed' }) => void
    const done = new Promise<{ status: 'completed' | 'killed' | 'failed' }>(resolve => { settle = resolve })
    jobId = jobs.start({
      kind: 'bash',
      label: 'm3-l5 fixture job',
      owner: ownerId,
      run: () => ({
        cancel: () => settle({ status: 'killed' }),
        done,
      }),
    })
    await waitFor('the known job to appear in the Client roster', () => {
      const rows = client.jobs.state.getSnapshot().rows[ownerId] ?? []
      return rows.some(row => String(row.id) === String(jobId))
    })
  } finally {
    releaseWatch()
    if (jobId !== undefined) jobs.kill(jobId, ownerId)
  }
})

test('I. reconnect replaces the connection generation, fires connection/reset, and recovers the Session list', async () => {
  const { client } = await getSharedRuntime()
  const generationBefore = client.connection.generation.getSnapshot()
  assert.notEqual(generationBefore, undefined)
  const reference = client.sessions.retain(SessionId(SEED_SESSION_ID), { source: 'controllerOperation' })
  await reference.ready
  const bindingBefore = reference.binding
  let resets = 0
  const unsubscribe = client.context.on('connection/reset', () => { resets += 1 })
  try {
    client.connection.reconnect()
    await waitFor('a different connection generation', () => {
      const generation = client.connection.generation.getSnapshot()
      return generation !== undefined && generation.id !== generationBefore?.id
    })
    await waitFor('the official connection/reset event to be observed', () => resets >= 1)
    await waitFor('the Session list to return to ready', () =>
      client.sessions.list.getSnapshot().phase === 'ready')
    // The retained logical Session stays usable across the reset: a fresh
    // history round-trip answers on the new generation, and the binding keeps
    // its official identity-stable object.
    assert.ok(Object.is(reference.binding, bindingBefore), 'the retained binding must stay identity-stable')
    await reference.binding.session.loadOlder()
    assert.equal(reference.binding.session.getSnapshot().openState, 'open', 'the retained Session must stay open')
  } finally {
    unsubscribe()
    reference.release()
  }
})

test('J. the archive route answers through the production Host carrier', async () => {
  const { host, client, hostRuntime } = await getSharedRuntime()
  // The exporter answers from the persisted/query layer, so the known Session
  // here is one created through the official wire (controller-owned).
  const created = await client.sessions.create({ cwd: host.anchorDir })
  const response = await hostRuntime.carrier.fetch(
    `${SESSION_LOG_EXPORT_PATH}?sessionId=${String(created)}`,
    { method: 'GET' },
  )
  assert.equal(response.status, 200, 'the session exporter route must answer, not a generic 404')
  assert.match(response.headers.get('content-type') ?? '', /application\/zip/)
  await response.arrayBuffer()
})

// ---------------------------------------------------------------------------
// K — reverse disposal / no leaks (must stay after D–J)
// ---------------------------------------------------------------------------

test('K. reverse disposal is idempotent, leaves zero owned refs/watchers, and the ordinary Host survives', async () => {
  const { host, runtime, client } = await getSharedRuntime()
  await waitFor('all test references released', () =>
    client.sessions.retainInfo(SessionId(SEED_SESSION_ID)).getSnapshot().referenceCount === 0)

  const jobControllerBefore = host.ctx.reflect.get('jobController') as { typertRemote?: unknown }
  let resetsAfterDispose = 0
  const unsubscribe = client.connection.generation.subscribe(() => { resetsAfterDispose += 1 })
  await runtime.dispose()
  await runtime.dispose() // second call must be safe

  // Let any dispose-time side effect (final generation loss publication) pass,
  // then require a quiet window with the listener still attached.
  await new Promise(resolve => setTimeout(resolve, 150))
  resetsAfterDispose = 0
  await new Promise(resolve => setTimeout(resolve, 250))
  unsubscribe()
  assert.equal(resetsAfterDispose, 0, 'no listener may fire after disposal')
  assert.equal('window' in globalThis, false, 'the temporary module-loader global stays absent')

  // M3 Host additive services are removed; the existing rows survive.
  assert.equal(host.ctx.reflect.get('connection'), undefined, 'the M3 Host connection must be removed')
  assert.equal(host.ctx.reflect.get('fileUploads'), undefined, 'the real fileUploads row must be removed')
  assert.equal(host.ctx.reflect.get('settingsController'), undefined, 'the settings controller must be removed')
  assert.equal(host.ctx.reflect.get('sessionController'), undefined, 'the M3 Session controller must be removed')
  const jobControllerAfter = host.ctx.reflect.get('jobController') as { typertRemote?: unknown }
  assert.ok(
    jobControllerAfter?.typertRemote !== undefined && jobControllerAfter.typertRemote === jobControllerBefore.typertRemote,
    'the existing jobController must survive',
  )

  // The ordinary Host Context is still alive and usable.
  assert.notEqual(host.ctx.sessions.get(SessionId(SEED_SESSION_ID)), undefined, 'the ordinary Host Session store must remain active')
  assert.ok(
    host.ctx.sessions.list().some(session => String(session.id) === SEED_SESSION_ID),
    'the ordinary Host Session store must remain servable',
  )

  await host.dispose()
})

// ---------------------------------------------------------------------------
// L — partial construction failure
// ---------------------------------------------------------------------------

test('L1. a Host-side composition failure unwinds the mounted M3 fibers and leaves the ordinary Host intact', async () => {
  const host = await createHostFixture()
  await seedHostSession(host)
  try {
    // A foreign fileUploads double must make the real row fail loudly.
    host.ctx.provide('fileUploads', { fake: true })
    const jobControllerBefore = host.ctx.reflect.get('jobController') as { typertRemote?: unknown }
    await assert.rejects(
      (await loadRuntimeModule()).createExperimentalRemoteRuntime({
        hostContext: host.ctx,
        waitForHostPrerequisites: async () => {},
      }),
      /fileUploads/,
      'the real FileUploads row must fail against a pre-provided double',
    )
    // The earlier M3 fiber (Host connection) unwound with the failure.
    assert.equal(host.ctx.reflect.get('connection'), undefined, 'the earlier M3 fiber must unwind')
    assert.notEqual(host.ctx.reflect.get('fileUploads'), undefined, 'the fixture-owned double stays untouched')
    const jobControllerAfter = host.ctx.reflect.get('jobController') as { typertRemote?: unknown }
    assert.ok(
      jobControllerAfter?.typertRemote !== undefined && jobControllerAfter.typertRemote === jobControllerBefore.typertRemote,
      'the existing jobController remains',
    )
    assert.equal('window' in globalThis, false, 'no loader shim may survive the failure')
    // The ordinary Host Context remains usable.
    assert.ok(host.ctx.sessions.list().length >= 1)
  } finally {
    await host.dispose()
  }
})

test('L2. a Client-side readiness failure unwinds the partial Client cleanly', async () => {
  const host = await createHostFixture()
  try {
    const jobControllerBefore = host.ctx.reflect.get('jobController') as { typertRemote?: unknown }
    const hostRuntime = await createRemoteHostRuntime(host.ctx)
    const signal = AbortSignal.abort(new Error('induced client readiness failure'))
    await assert.rejects(
      createRemoteClientRuntime({ carrier: hostRuntime.carrier, signal }),
      /aborted/,
      'an aborted lifecycle signal must fail the Client composition',
    )
    assert.equal('window' in globalThis, false, 'no loader shim may survive the failure')
    const jobControllerAfter = host.ctx.reflect.get('jobController') as { typertRemote?: unknown }
    assert.ok(
      jobControllerAfter?.typertRemote !== undefined && jobControllerAfter.typertRemote === jobControllerBefore.typertRemote,
      'the existing jobController remains',
    )
    assert.notEqual(host.ctx.reflect.get('connection'), undefined, 'the composed Host rows stay until their own owner disposes')

    // The single-flight capture is reusable after the failure: a clean
    // composition over the same Host carrier still works, and unwinding it
    // leaves no orphan.
    const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
    await waitFor('the retry client to become ready', () =>
      client.sessions.list.getSnapshot().phase === 'ready')
    await client.dispose()
    await hostRuntime.dispose()
    assert.equal(host.ctx.reflect.get('connection'), undefined, 'the Host runtime disposal removes its rows')
  } finally {
    await host.dispose()
  }
})
