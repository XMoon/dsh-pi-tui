/**
 * Contract tests for the D2.3 Remote model catalog: the official
 * `session.modelCatalog` directory read, the official `session.selectModel`
 * write with operation-specific settlement, and the Connection generation
 * fence. No Direct model owner and no second global-default write.
 * @module @xmoon76/dsh-pi-tui/remote-model-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteModelCatalog,
  classifyRemoteModelFailure,
  type RemoteModelBinding,
  type RemoteModelRemotes,
  type RemoteModelSessionsSource,
} from '../src/runtime/remote/model-remote.ts'
import type { RemoteConnectionGeneration, RemoteConnectionGenerationSource } from '../src/runtime/remote/session-reader-remote.ts'

/** A structural official Remote failure (code is the only discriminator). */
function failure(code: string, message: string, details: Record<string, unknown> = {}): unknown {
  return { code, message, details }
}

interface GenerationHarness {
  readonly source: RemoteConnectionGenerationSource
  set(value: RemoteConnectionGeneration | undefined): void
}

function generationHarness(): GenerationHarness {
  let current: RemoteConnectionGeneration | undefined = { id: 1 }
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => current,
      subscribe: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(value) {
      current = value
      for (const listener of [...listeners]) listener()
    },
  }
}

const DIRECTORY = {
  default: { provider: 'p', model: 'm-default' },
  routableProviders: ['p'],
  groups: [{
    id: 'p',
    name: 'Provider P',
    models: [{ id: 'm1', name: 'M1', reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }],
  }],
  failures: [{ id: 'bad', name: 'Bad', message: 'route unavailable' }],
}

interface ModelHarness {
  readonly catalog: RemoteModelCatalog
  readonly generation: GenerationHarness
  readonly calls: { catalog: number; selections: unknown[]; bindings: string[] }
  setCatalogResult(result: { ok: true; value: typeof DIRECTORY } | { ok: false; error: unknown }): void
  setSelectionResult(result: { ok: true; value: { selected: { provider: string; model: string; reasoningEffort?: string } } } | { ok: false; error: unknown }): void
  setProjection(value: unknown): void
  setBinding(sessionId: string, present: boolean): void
  /** Run inside the Host selectModel call before it resolves. */
  setSelectionHook(hook: () => void): void
  /** Gate the Host selectModel result (for overlapping-call tests). */
  setSelectionGate(gate: () => Promise<void>): void
  /** Queue distinct per-call selection results (consumed in order). */
  queueSelectionResults(...results: Array<{ ok: true; value: { selected: { provider: string; model: string; reasoningEffort?: string } } } | { ok: false; error: unknown }>): void
  setCatalogHook(hook: () => void | Promise<void>): void
  /** Queue distinct per-call catalog results (consumed in order). */
  queueCatalogResults(...results: Array<{ ok: true; value: typeof DIRECTORY } | { ok: false; error: unknown }>): void
}

function modelHarness(): ModelHarness {
  const calls = { catalog: 0, selections: [] as unknown[], bindings: [] as string[] }
  let catalogResult: { ok: true; value: typeof DIRECTORY } | { ok: false; error: unknown } = { ok: true, value: DIRECTORY }
  let selectionResult: { ok: true; value: { selected: { provider: string; model: string; reasoningEffort?: string } } } | { ok: false; error: unknown } = {
    ok: true,
    value: { selected: { provider: 'p', model: 'm1' } },
  }
  let projection: unknown = { lastUsed: null, next: null }
  let selectionHook: (() => void) | undefined
  let selectionGate: (() => Promise<void>) | undefined
  let catalogHook: (() => void | Promise<void>) | undefined
  const catalogQueue: Array<{ ok: true; value: typeof DIRECTORY } | { ok: false; error: unknown }> = []
  const selectionQueue: Array<{ ok: true; value: { selected: { provider: string; model: string; reasoningEffort?: string } } } | { ok: false; error: unknown }> = []
  const bound = new Set<string>(['session-a'])
  const session: RemoteModelRemotes = {
    modelCatalog: async () => {
      calls.catalog += 1
      // Bind the per-call result BEFORE the gate so out-of-order resolutions
      // still carry their own result.
      const result = catalogQueue.length > 0 ? catalogQueue.shift()! : catalogResult
      if (catalogHook !== undefined) await catalogHook()
      return result
    },
    selectModel: async (request) => {
      calls.selections.push(request)
      const result = selectionQueue.length > 0 ? selectionQueue.shift()! : selectionResult
      selectionHook?.()
      if (selectionGate !== undefined) await selectionGate()
      return result
    },
  }
  const sessions: RemoteModelSessionsSource = {
    binding: (sessionId): RemoteModelBinding | undefined => {
      calls.bindings.push(sessionId)
      if (!bound.has(sessionId)) return undefined
      return {
        session: {
          projections: {
            faceOf: () => ({ getSnapshot: () => projection }),
          },
        },
      }
    },
  }
  const generation = generationHarness()
  return {
    catalog: new RemoteModelCatalog(session, sessions, generation.source),
    generation,
    calls,
    setCatalogResult: (result) => { catalogResult = result },
    setSelectionResult: (result) => { selectionResult = result },
    setProjection: (value) => { projection = value },
    setBinding: (sessionId, present) => { if (present) bound.add(sessionId); else bound.delete(sessionId) },
    setSelectionHook: (hook) => { selectionHook = hook },
    setSelectionGate: (gate) => { selectionGate = gate },
    queueSelectionResults: (...results) => { selectionQueue.push(...results) },
    setCatalogHook: (hook) => { catalogHook = hook },
    queueCatalogResults: (...results) => { catalogQueue.push(...results) },
  }
}

test('loadDirectory maps the official session.modelCatalog value', async () => {
  const harness = modelHarness()
  const directory = await harness.catalog.loadDirectory()
  assert.deepEqual(directory, DIRECTORY)
  assert.deepEqual(harness.catalog.defaultSelection(), { provider: 'p', model: 'm-default' })
  assert.deepEqual(harness.catalog.listProviders(), [{ id: 'p', name: 'Provider P' }])
  assert.deepEqual(await harness.catalog.listModels('p'), [{ id: 'm1' }])
})

test('loadDirectory detaches the returned value from the Host object', async () => {
  const harness = modelHarness()
  const directory = await harness.catalog.loadDirectory()
  ;(directory.groups as unknown as Array<{ models: Array<{ id: string }> }>)[0]!.models[0]!.id = 'MUTATED'
  assert.equal(DIRECTORY.groups[0]!.models[0]!.id, 'm1', 'the Host catalog is never aliased')
})

test('loadDirectory fails closed on a refused Host catalog read', async () => {
  const harness = modelHarness()
  harness.setCatalogResult({ ok: false, error: failure('gateway/internal', 'catalog exploded') })
  await assert.rejects(harness.catalog.loadDirectory(), /catalog exploded/)
})

test('selectSessionModel sends the exact official request fields', async () => {
  const harness = modelHarness()
  const { outcome } = await harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm1', reasoningEffort: 'low' })
  assert.deepEqual(outcome, { kind: 'committed', value: { provider: 'p', model: 'm1' } })
  assert.deepEqual(harness.calls.selections, [{ sessionId: 'session-a', provider: 'p', model: 'm1', reasoningEffort: 'low' }])
})

test('selectSessionModel returns the Host-normalized accepted selection', async () => {
  const harness = modelHarness()
  harness.setSelectionResult({ ok: true, value: { selected: { provider: 'p', model: 'm1', reasoningEffort: 'max' } } })
  const { outcome } = await harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm1', reasoningEffort: 'low' })
  assert.deepEqual(outcome, { kind: 'committed', value: { provider: 'p', model: 'm1', reasoningEffort: 'max' } })
})

test('selectSessionModel rejects an unaddressable Session before dispatch', async () => {
  const harness = modelHarness()
  harness.setBinding('session-a', false)
  const { outcome } = await harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm1' })
  assert.equal(outcome.kind, 'rejected')
  assert.deepEqual(harness.calls.selections, [], 'no Host dispatch for an unaddressable Session')
})

test('a generation replaced DURING a SUCCESSFUL model dispatch keeps the real commit but loses local ownership', async () => {
  const harness = modelHarness()
  harness.setSelectionHook(() => harness.generation.set({ id: 2 }))
  const result = await harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm1' })
  assert.equal(result.outcome.kind, 'committed', 'the Host commit is real; a later reconnect does not undo it')
  assert.equal(result.ownership, 'superseded', 'but this result no longer owns the local surface')
})

test('a rejected session/model-unavailable is a proven rejection', async () => {
  const harness = modelHarness()
  harness.setSelectionResult({ ok: false, error: failure('session/model-unavailable', 'no such route') })
  const { outcome } = await harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'nope' })
  assert.equal(outcome.kind, 'rejected')
  if (outcome.kind === 'rejected') assert.equal(outcome.error.code, 'session/model-unavailable')
})

test('an internal/codeless failure after dispatch stays indeterminate (no blind rejection)', () => {
  assert.deepEqual(classifyRemoteModelFailure(failure('gateway/internal', 'carrier lost')), {
    kind: 'indeterminate',
    error: { code: 'gateway/internal', message: 'carrier lost' },
  })
  assert.equal(classifyRemoteModelFailure(new Error('no code')).kind, 'indeterminate')
})

test('a pre-invocation Gateway code is a proven rejection', () => {
  assert.equal(classifyRemoteModelFailure(failure('gateway/arguments-invalid', 'bad args')).kind, 'rejected')
  // gateway/cancelled is only ever seen AFTER dispatch, so it must stay
  // indeterminate (v2 §0.2.4/§0.7.1); pre-dispatch cancellation is cancelled.
  assert.equal(classifyRemoteModelFailure(failure('gateway/cancelled', 'cancelled')).kind, 'indeterminate')
})

test('sessionSelection follows the durable projection and falls back to the Host default', async () => {
  const harness = modelHarness()
  await harness.catalog.loadDirectory()
  harness.setProjection({ lastUsed: { provider: 'p', model: 'm-last' }, next: { provider: 'p', model: 'm2', reasoningEffort: 'high' } })
  assert.deepEqual(harness.catalog.sessionSelection('session-a'), { provider: 'p', model: 'm2', reasoningEffort: 'high' })
  harness.setProjection({ lastUsed: null, next: null })
  assert.deepEqual(harness.catalog.sessionSelection('session-a'), { provider: 'p', model: 'm-default' })
  assert.equal(harness.catalog.sessionSelection('session-missing'), undefined)
})

test('the Remote adapter never performs a second global-default write', async () => {
  const harness = modelHarness()
  const outcome = await harness.catalog.saveDefaultSelection({ provider: 'p', model: 'm1' })
  assert.equal(outcome.kind, 'unsupported')
  if (outcome.kind === 'unsupported') assert.match(outcome.reason, /no global-default model write/)
})

test('a reconnect invalidates the cached directory projection', async () => {
  const harness = modelHarness()
  await harness.catalog.loadDirectory()
  assert.deepEqual(harness.catalog.defaultSelection(), { provider: 'p', model: 'm-default' })
  harness.generation.set({ id: 2 })
  assert.equal(harness.catalog.defaultSelection(), undefined,
    'a stale Host default must never become a Session fallback after reconnect')
  assert.deepEqual(harness.catalog.listProviders(), [])
})

test('an unknown session/model-* code stays indeterminate, never a blind rejection', () => {
  assert.equal(classifyRemoteModelFailure(failure('session/model-post-commit-failed', 'x')).kind, 'indeterminate')
  assert.equal(classifyRemoteModelFailure(failure('session/model-unavailable', 'x')).kind, 'rejected')
})

test('a disconnected generation hides the session-selection projection', async () => {
  const harness = modelHarness()
  await harness.catalog.loadDirectory()
  harness.setProjection({ next: { provider: 'p', model: 'm2' } })
  assert.deepEqual(harness.catalog.sessionSelection('session-a'), { provider: 'p', model: 'm2' })
  harness.generation.set(undefined)
  assert.equal(harness.catalog.sessionSelection('session-a'), undefined,
    'a disconnected generation must not expose the previous Host projection')
})

test('a replaced generation hides the session-selection projection loaded from the old Host', async () => {
  const harness = modelHarness()
  await harness.catalog.loadDirectory()
  harness.setProjection({ next: { provider: 'p', model: 'm2' } })
  harness.generation.set({ id: 2 })
  assert.equal(harness.catalog.sessionSelection('session-a'), undefined)
})

test('session/agent-busy is a proven pre-dispatch rejection', () => {
  assert.equal(classifyRemoteModelFailure(failure('session/agent-busy', 'busy')).kind, 'rejected')
})

test('a PROVEN REFUSAL returned after a generation replacement stays rejected but superseded', async () => {
  const harness = modelHarness()
  harness.setSelectionResult({ ok: false, error: failure('session/model-unavailable', 'gone') })
  harness.setSelectionHook(() => harness.generation.set({ id: 2 }))
  const result = await harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm1' })
  assert.equal(result.outcome.kind, 'rejected',
    'the refusal is provable from the Host that processed it; a later reconnect does not make it indeterminate')
  assert.equal(result.ownership, 'superseded', 'it still loses the local surface')
})

test('listProviders is empty before any directory load (Remote provider discovery is load-scoped)', () => {
  const harness = modelHarness()
  assert.deepEqual(harness.catalog.listProviders(), [],
    'provider discovery is served from the last loaded Host directory; the subagent allowlist is Direct-only in D2.3')
})

test('a catalog FAILURE after a reconnect reports the stale-generation fence, not the old failure', async () => {
  const harness = modelHarness()
  harness.setCatalogResult({ ok: false, error: failure('gateway/internal', 'old catalog exploded') })
  harness.setCatalogHook(() => harness.generation.set({ id: 2 }))
  await assert.rejects(harness.catalog.loadDirectory(), /remote connection changed while loading the model catalog/)
})

test('loadDirectory returns a detached copy that cannot corrupt the adapter cache', async () => {
  const harness = modelHarness()
  const returned = await harness.catalog.loadDirectory()
  ;(returned.groups as unknown as Array<{ models: Array<{ id: string }> }>)[0]!.models[0]!.id = 'MUTATED'
  ;(returned.routableProviders as unknown as string[]).push('ghost')
  assert.deepEqual(harness.catalog.listProviders(), [{ id: 'p', name: 'Provider P' }],
    'consumer mutation must not reach the adapter cache')
  assert.deepEqual(await harness.catalog.loadDirectory(), DIRECTORY)
})

test('a committed select drops the cached Host default (best-effort save is unprovable)', async () => {
  const harness = modelHarness()
  await harness.catalog.loadDirectory()
  assert.deepEqual(harness.catalog.defaultSelection(), { provider: 'p', model: 'm-default' })
  await harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm1' })
  assert.equal(harness.catalog.defaultSelection(), undefined,
    'the Host default may have changed without a provable reply; reload before trusting it')
})

test('an out-of-order older directory read cannot overwrite the newer cache', async () => {
  const harness = modelHarness()
  const older = { ...DIRECTORY, default: { provider: 'p', model: 'm-OLD' } }
  const newer = { ...DIRECTORY, default: { provider: 'p', model: 'm-NEW' } }
  const gates: Array<() => void> = []
  let call = 0
  harness.setCatalogHook(() => new Promise<void>((resolve) => { gates[call++] = resolve }))
  harness.queueCatalogResults({ ok: true, value: older }, { ok: true, value: newer })
  const first = harness.catalog.loadDirectory()
  const second = harness.catalog.loadDirectory()
  await Promise.resolve()
  gates[1]!() // the NEWER read resolves first
  await second
  gates[0]!() // the OLDER read resolves last
  // v2 §0.2.3: a stale read is never returned as current — it serves the NEWER
  // value when one exists (and never overwrites the cache).
  const staleCaller = await first
  assert.deepEqual(staleCaller.default, { provider: 'p', model: 'm-NEW' },
    'a superseded read serves the newer generation-consistent value')
  assert.deepEqual(harness.catalog.defaultSelection(), { provider: 'p', model: 'm-NEW' },
    'the late older read must not repopulate the cache with its stale result')
})

test('a select invalidation cannot be undone by an in-flight directory read', async () => {
  const harness = modelHarness()
  let release!: () => void
  let call = 0
  harness.setCatalogHook(() => new Promise<void>((resolve) => { call += 1; release = resolve }))
  const loading = harness.catalog.loadDirectory()
  await Promise.resolve()
  assert.equal(call, 1)
  // A select invalidates the cache while the read is in flight.
  await harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm1' })
  release!() // the pre-select read now resolves
  await assert.rejects(loading, /superseded by a newer request/)
  assert.equal(harness.catalog.defaultSelection(), undefined,
    'an in-flight pre-select read must not repopulate the invalidated cache')
})

test('a pre-aborted select settles cancelled with zero dispatch', async () => {
  const harness = modelHarness()
  const controller = new AbortController()
  controller.abort()
  const result = await harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm1' }, controller.signal)
  assert.deepEqual(result, { ownership: 'current', outcome: { kind: 'cancelled' } })
  assert.deepEqual(harness.calls.selections, [], 'a pre-aborted write must not dispatch')
})

test('an abort AFTER dispatch does not claim cancelled: a proven success stays committed+superseded', async () => {
  const harness = modelHarness()
  const controller = new AbortController()
  harness.setSelectionHook(() => controller.abort())
  const result = await harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm1' }, controller.signal)
  assert.equal(result.outcome.kind, 'committed', 'a post-dispatch abort does not prove non-commit')
  assert.equal(result.ownership, 'superseded')
})

test('a post-dispatch gateway/cancelled is indeterminate, never cancelled', async () => {
  const harness = modelHarness()
  harness.setSelectionResult({ ok: false, error: failure('gateway/cancelled', 'carrier cancelled') })
  const result = await harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm1' })
  assert.equal(result.outcome.kind, 'indeterminate')
})

test('overlapping same-generation selects: only the newest owns the surface', async () => {
  const harness = modelHarness()
  const gates: Array<() => void> = []
  harness.setSelectionGate(() => new Promise<void>((resolve) => { gates.push(resolve) }))
  const first = harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm1' })
  const second = harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm2' })
  await Promise.resolve()
  assert.equal(gates.length, 2, 'both selections dispatched')
  gates[0]!(); gates[1]!()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.ownership, 'superseded', 'the older same-generation selection loses ownership')
  assert.equal(b.ownership, 'current')
})

test('a reconnect while a SUCCESSFUL directory read is in flight refuses the stale result', async () => {
  const harness = modelHarness()
  harness.setCatalogHook(() => harness.generation.set({ id: 2 }))
  await assert.rejects(harness.catalog.loadDirectory(), /remote connection changed while loading the model catalog/)
})

test('loadDirectory honours a pre-aborted signal', async () => {
  const harness = modelHarness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(harness.catalog.loadDirectory(controller.signal), /abort/i)
})

test('loadDirectory aborts when the signal aborts during the read', async () => {
  const harness = modelHarness()
  const controller = new AbortController()
  harness.setCatalogHook(() => controller.abort())
  await assert.rejects(harness.catalog.loadDirectory(controller.signal), /abort/i)
})

test('an unparseable successful Host payload is indeterminate, never the requested value', async () => {
  const harness = modelHarness()
  // A malformed payload (not an object) cannot be trusted as the normalized value.
  harness.setSelectionResult({ ok: true, value: { selected: undefined } } as never)
  const result = await harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'wanted' })
  assert.equal(result.outcome.kind, 'indeterminate')
  if (result.outcome.kind === 'indeterminate') assert.equal(result.outcome.error.code, 'session/model-result-invalid')
})

test('a superseded same-generation COMMITTED select still invalidates the model cache', async () => {
  const harness = modelHarness()
  await harness.catalog.loadDirectory()
  assert.deepEqual(harness.catalog.defaultSelection(), { provider: 'p', model: 'm-default' })
  const gates: Array<() => void> = []
  harness.setSelectionGate(() => new Promise<void>((resolve) => { gates.push(resolve) }))
  harness.queueSelectionResults(
    { ok: true, value: { selected: { provider: 'p', model: 'm1' } } },
    { ok: false, error: failure('session/model-unavailable', 'no') },
  )
  const a = harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm1' })
  const b = harness.catalog.selectSessionModel('session-a', { provider: 'p', model: 'm2' })
  await Promise.resolve()
  gates[0]!(); gates[1]!()
  const [resultA, resultB] = await Promise.all([a, b])
  assert.equal(resultA.ownership, 'superseded')
  assert.equal(resultA.outcome.kind, 'committed')
  assert.equal(resultB.outcome.kind, 'rejected')
  // A committed on the SAME generation, so the Host default is unprovable even
  // though A lost local ownership; B was a refusal and invalidates nothing.
  assert.equal(harness.catalog.defaultSelection(), undefined,
    'a committed+superseded same-generation select must still invalidate the cached Host default')
})

test('an aborted directory read reports the LOCAL abort, not a stale Host failure', async () => {
  const harness = modelHarness()
  const controller = new AbortController()
  harness.setCatalogResult({ ok: false, error: failure('gateway/internal', 'host boom') })
  harness.setCatalogHook(() => controller.abort())
  await assert.rejects(harness.catalog.loadDirectory(controller.signal), /abort/i)
})
