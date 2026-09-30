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
 * - prompt serializer (a `remote/unsupported` test double): PR1 does not
 *   own production submission serialization, so no real serializer exists to
 *   inject — the plan's single sanctioned substitution.
 * - `StubLlmAdapter` (a `smoke` route, no streamed turn), plus hand-provided
 *   `agentDefaultModel` / `attachments` / `webServer` values: the minimal
 *   readiness inputs the composition requires, identical to the proven
 *   M3-1 L5 fixture shape. Precision: the LLM adapter is registered on the
 *   required Host `llm` service (part of the composed graph), but no proof
 *   in this suite (composition identity, disposal ordering, failure unwind)
 *   ever invokes it — no model turn runs; the other values carry no
 *   Remote-wire state and are never read through the Client connection.
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
import { SessionId } from '@deepseek-ai/dsh-session'
import { loadRemoteApplicationRuntime } from '../src/runtime/backend-loader.ts'
import {
  createRemoteApplicationHostFixture,
  testLifecycle,
  testPromptSerializer,
  waitFor,
} from './support/remote-application-fixture.ts'

const PRESET = 'm3-4-pr1-preset'
const SEED_SESSION_ID = 'm3-4-pr1-seed'

/** The ordinary Host fixture (shared with the selection suite). */
function createHostFixture(life: import('./support/temp-lifecycle.ts').TestLifecycle) {
  return createRemoteApplicationHostFixture(life, PRESET)
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

  // The disposal-ORDER proof observes each step's ACTUAL lifetime event:
  // - adapter disposal: a probe on the semantic bundle's own dispose step
  //   (the backend adapter caches/subscriptions drop);
  // - Client disposal: an effect disposer registered ON the Client Context
  //   (Cordis runs it during `wire.client.dispose()`), which SAMPLES the M3
  //   Host row presence at that instant;
  // - Host disposal: the M3 additive Host rows' removal (the K-suite's
  //   observable), sampled inside the Client disposer (must STILL be present
  //   — Client disposes before the Host fibers) and after the whole
  //   transport disposal (must be gone — the Host unwound last).
  const order: string[] = []
  let hostRowAtClientDispose: boolean | undefined
  const semantics = runtime.backendRuntime.semantics as unknown as { dispose(): void }
  const originalSemanticsDispose = semantics.dispose.bind(semantics)
  semantics.dispose = () => { order.push('adapters'); originalSemanticsDispose() }
  runtime.wire.client.context.effect(() => () => {
    order.push('client')
    hostRowAtClientDispose = host.ctx.reflect.get('connection') !== undefined
  })

  await runtime.selected.disposeTransport()
  await runtime.selected.disposeTransport() // idempotent: a second call is a contained no-op

  // The MEASURED order: adapters -> Client -> Host additive fibers.
  assert.deepEqual(order, ['adapters', 'client'],
    'the adapter disposal must fire before the Client Context disposal, exactly once each (idempotence)')
  assert.equal(hostRowAtClientDispose, true,
    'at Client disposal the M3 Host rows must STILL be present — the Client disposes before the Host additive fibers')
  assert.equal(host.ctx.reflect.get('connection'), undefined,
    'the M3 Host connection row is removed after the whole transport disposal (Host unwound last)')

  // The M3 additive Host rows are removed (Client + Host fibers unwound in
  // order) and the ordinary Host survives.
  assert.equal(host.ctx.reflect.get('fileUploads'), undefined, 'the M3 fileUploads row is removed')
  assert.equal(host.ctx.reflect.get('sessionController'), undefined, 'the M3 session controller row is removed')
  assert.ok(host.ctx.sessions.list().some(session => String(session.id) === SEED_SESSION_ID),
    'the ordinary Host Session store must remain servable')
})

test('C2. disposeTransport preserves errors from every step and never truncates the backend-internal cleanup', async (t) => {
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  host.ctx.sessions.create(SessionId(SEED_SESSION_ID), { meta: { cwd: host.anchorDir } })
  const runtime = await (await loadApplicationRuntimeModule()).createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    promptSerializer: testPromptSerializer,
  })
  t.after(() => host.dispose())

  // The backend runtime's disposal ledger runs its parts in REVERSE
  // construction order: config mirror FIRST, then the semantics bundle (both
  // adapters, still strictly before the Client/Host wire). To prove the loop
  // CONTINUES past a throwing step (not merely that an earlier step ran), the
  // failure is injected into the FIRST step (config) and the SECOND step
  // (semantics) is asserted to have still executed afterwards.
  const semantics = runtime.backendRuntime.semantics as unknown as { dispose(): void }
  const configMirror = runtime.selected.backend.config as unknown as { dispose(): void }
  const induced = new Error('induced adapter disposal failure')
  let semanticsDisposed = false
  const originalSemanticsDispose = semantics.dispose.bind(semantics)
  const originalConfigDispose = configMirror.dispose.bind(configMirror)
  configMirror.dispose = () => {
    originalConfigDispose()
    throw induced
  }
  semantics.dispose = () => {
    semanticsDisposed = true
    originalSemanticsDispose()
  }
  await assert.rejects(() => runtime.selected.disposeTransport(), (error: unknown) => {
    assert.equal(error, induced, 'the adapter disposal failure surfaces as the primary error')
    return true
  })
  // The ledger did NOT truncate at the throwing config step: the semantics
  // disposal (which the reverse order runs AFTER config) still executed.
  assert.ok(semanticsDisposed,
    'the semantics disposal must still run after a throwing config dispose — the ledger continues past a failure')
  // The wire still unwound despite the adapter failure (error-isolated steps).
  assert.equal(host.ctx.reflect.get('connection'), undefined, 'the wire disposal still ran after the adapter failure')
  // Idempotent even on the failure path.
  await assert.doesNotReject(() => runtime.selected.disposeTransport())
})

test('D1. a Host-side wire construction failure unwinds the mounted M3 fibers and leaves the ordinary Host intact', async (t) => {
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  // A foreign fileUploads double makes the REAL Host row fail loudly inside
  // the wire construction (createExperimentalRemoteRuntime's Host stage) —
  // the aggregate must surface the error with no surviving M3 fibers (plan
  // §12 fail-closed; the Client never existed on this path).
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

test('D2. a post-wire application composition failure (Client exists) unwinds the wire and surfaces the original error', async (t) => {
  const life = testLifecycle(t)
  const host = await createHostFixture(life)
  host.ctx.sessions.create(SessionId(SEED_SESSION_ID), { meta: { cwd: host.anchorDir } })
  const induced = new Error('induced post-wire composition failure')
  let clientRowsMountedAtInjection = false
  // The injection point is the aggregate's own application-composition input:
  // a throwing getter for promptSerializer, evaluated INSIDE the aggregate's
  // post-wire stage (createRemoteBackendRuntime's options read) — after the
  // Client exists, before any backend adapter state is retained.
  const options = {
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    get promptSerializer(): never {
      clientRowsMountedAtInjection = host.ctx.reflect.get('connection') !== undefined
      throw induced
    },
  }
  await assert.rejects(
    (await loadApplicationRuntimeModule()).createRemoteApplicationRuntime(options as never),
    (error: unknown) => {
      assert.equal(error, induced, 'the original composition error surfaces (never masked by unwind failures)')
      return true
    },
  )
  assert.ok(clientRowsMountedAtInjection, 'the failure was induced while the M3 Host rows (mounted with the Client) existed')
  // The Client-existence ordering is source-locked: the getter is read only
  // in the post-wire stage, after `await createExperimentalRemoteRuntime`.
  const aggregateSource = await import('node:fs').then(fs =>
    fs.readFileSync(new URL('../src/app/remote/application-runtime.ts', import.meta.url), 'utf8'))
  const wireAwait = aggregateSource.indexOf('const wire = await createExperimentalRemoteRuntime(')
  const optionsRead = aggregateSource.indexOf('options.promptSerializer')
  assert.ok(wireAwait >= 0 && optionsRead > wireAwait,
    'the promptSerializer read must come after the awaited wire construction (post-wire injection)')
  assert.equal(host.ctx.reflect.get('connection'), undefined, 'the M3 Host rows unwound with the wire')
  assert.equal(host.ctx.reflect.get('fileUploads'), undefined, 'the M3 fileUploads row unwound with the wire')
  assert.equal(host.ctx.reflect.get('sessionController'), undefined, 'the M3 session controller unwound with the wire')
  assert.ok(host.ctx.sessions.list().some(session => String(session.id) === SEED_SESSION_ID),
    'the ordinary Host survives the failed composition')
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
