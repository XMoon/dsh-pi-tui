/**
 * Contract tests for the D2.3 Remote preset catalog: the official
 * `agentPresets.list` roster read and the official `agentPresets.select`
 * blank-Session write with operation-specific settlement. No local blank
 * reducer, no local recompose, no retry after ambiguous dispatch.
 * @module @xmoon76/dsh-pi-tui/remote-preset-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemotePresetCatalog,
  classifyRemotePresetFailure,
  type RemotePresetRemotes,
  type RemotePresetRoster,
} from '../src/runtime/remote/preset-remote.ts'
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
  return {
    source: { getSnapshot: () => current, subscribe: () => () => {} },
    set(value) { current = value },
  }
}

const ROSTER: RemotePresetRoster = {
  presets: [
    { id: 'standard', trust: 'system', isDefault: true, name: 'Standard' },
    { id: 'minimal', trust: 'system' },
    { id: 'local', trust: 'user', name: 'Local', broken: 'bad yaml' },
  ],
  modeSelectionEnabled: true,
}

interface PresetHarness {
  readonly catalog: RemotePresetCatalog
  readonly calls: { lists: number; selects: unknown[] }
  readonly generation: GenerationHarness
  setListResult(result: { ok: true; value: RemotePresetRoster } | { ok: false; error: unknown }): void
  setSelectResult(result: { ok: true; value: string } | { ok: false; error: unknown }): void
  setSelectHook(hook: () => void): void
  setListHook(hook: () => void | Promise<void>): void
  /** Gate the Host select result (for overlapping-call tests). */
  setSelectGate(gate: () => Promise<void>): void
  queueListResults(...results: Array<{ ok: true; value: RemotePresetRoster } | { ok: false; error: unknown }>): void
}

function presetHarness(): PresetHarness {
  const calls = { lists: 0, selects: [] as unknown[] }
  let listResult: { ok: true; value: RemotePresetRoster } | { ok: false; error: unknown } = { ok: true, value: ROSTER }
  let selectResult: { ok: true; value: string } | { ok: false; error: unknown } = { ok: true, value: 'minimal' }
  let selectHook: (() => void) | undefined
  let selectGate: (() => Promise<void>) | undefined
  let listHook: (() => void | Promise<void>) | undefined
  const listQueue: Array<{ ok: true; value: RemotePresetRoster } | { ok: false; error: unknown }> = []
  const generation = generationHarness()
  const presets: RemotePresetRemotes = {
    list: async () => {
      calls.lists += 1
      const result = listQueue.length > 0 ? listQueue.shift()! : listResult
      if (listHook !== undefined) await listHook()
      return result
    },
    select: async (sessionId, presetId) => {
      calls.selects.push({ sessionId, presetId })
      selectHook?.()
      if (selectGate !== undefined) await selectGate()
      return selectResult
    },
  }
  return {
    catalog: new RemotePresetCatalog(presets, generation.source),
    calls,
    generation,
    setListResult: (result) => { listResult = result },
    setSelectResult: (result) => { selectResult = result },
    setSelectHook: (hook) => { selectHook = hook },
    setSelectGate: (gate) => { selectGate = gate },
    setListHook: (hook) => { listHook = hook },
    queueListResults: (...results) => { listQueue.push(...results) },
  }
}

test('roster maps the official agentPresets.list value and marks the Host default', async () => {
  const harness = presetHarness()
  assert.deepEqual(await harness.catalog.roster(), {
    presets: [
      { id: 'standard', trust: 'system', name: 'Standard' },
      { id: 'minimal', trust: 'system' },
      { id: 'local', trust: 'user', name: 'Local', broken: 'bad yaml' },
    ],
    defaultId: 'standard',
    modeSelectionEnabled: true,
  })
  assert.equal(harness.catalog.defaultId(), 'standard')
})

test('roster fails closed on a refused Host roster read', async () => {
  const harness = presetHarness()
  harness.setListResult({ ok: false, error: failure('gateway/internal', 'roster exploded') })
  await assert.rejects(harness.catalog.roster(), /roster exploded/)
})

test('resolve returns the concrete roster id and refuses an unknown one', async () => {
  const harness = presetHarness()
  assert.deepEqual(await harness.catalog.resolve('minimal'), { id: 'minimal' })
  assert.deepEqual(await harness.catalog.resolve(), { id: 'standard' }, 'an omitted id resolves the Host default')
  await assert.rejects(harness.catalog.resolve('nope'), /not found/)
})

test('selectSessionPreset sends the exact official session and preset ids', async () => {
  const harness = presetHarness()
  const { outcome } = await harness.catalog.selectSessionPreset('session-a', 'minimal')
  assert.deepEqual(outcome, { kind: 'committed', value: { preset: 'minimal' } })
  assert.deepEqual(harness.calls.selects, [{ sessionId: 'session-a', presetId: 'minimal' }])
})

test('a locked blank-session switch is a proven rejection carrying agent-preset/locked', async () => {
  const harness = presetHarness()
  harness.setSelectResult({ ok: false, error: failure('agent-preset/locked', 'session already started') })
  const { outcome } = await harness.catalog.selectSessionPreset('session-a', 'minimal')
  assert.equal(outcome.kind, 'rejected')
  if (outcome.kind === 'rejected') assert.equal(outcome.error.code, 'agent-preset/locked')
})

test('an internal/codeless preset failure stays indeterminate (no blind rejection)', () => {
  assert.equal(classifyRemotePresetFailure(failure('gateway/internal', 'carrier lost')).kind, 'indeterminate')
  assert.equal(classifyRemotePresetFailure(new Error('no code')).kind, 'indeterminate')
  assert.equal(classifyRemotePresetFailure(failure('agent-preset/not-found', 'gone')).kind, 'rejected')
  // Only ever seen after dispatch → indeterminate (v2 §0.2.4/§0.7.2).
  assert.equal(classifyRemotePresetFailure(failure('gateway/cancelled', 'cancelled')).kind, 'indeterminate')
})

test('a generation replaced DURING a SUCCESSFUL preset switch keeps the real commit but loses local ownership', async () => {
  const harness = presetHarness()
  harness.setSelectHook(() => harness.generation.set({ id: 2 }))
  const result = await harness.catalog.selectSessionPreset('session-a', 'minimal')
  assert.equal(result.outcome.kind, 'committed', 'the Host commit is real; a later reconnect does not undo it')
  assert.equal(result.ownership, 'superseded')
})

test('a reconnect invalidates the cached Host-effective default', async () => {
  const harness = presetHarness()
  await harness.catalog.roster()
  assert.equal(harness.catalog.defaultId(), 'standard')
  harness.generation.set({ id: 2 })
  assert.equal(harness.catalog.defaultId(), undefined, 'a stale Host default must not leak after reconnect')
})

test('an unknown agent-preset/* code stays indeterminate, never a blind rejection', () => {
  assert.equal(classifyRemotePresetFailure(failure('agent-preset/post-commit-failed', 'x')).kind, 'indeterminate')
  assert.equal(classifyRemotePresetFailure(failure('agent-preset/locked', 'x')).kind, 'rejected')
})

test('a session/* error from agentPresets.select stays indeterminate (v2 §0.7.2: no Client binding precondition)', () => {
  assert.equal(classifyRemotePresetFailure(failure('session/agent-busy', 'busy')).kind, 'indeterminate')
  assert.equal(classifyRemotePresetFailure(failure('session/not-found', 'gone')).kind, 'indeterminate')
})

test('a PROVEN REFUSAL returned after a generation replacement stays rejected but superseded', async () => {
  const harness = presetHarness()
  harness.setSelectResult({ ok: false, error: failure('agent-preset/locked', 'locked') })
  harness.setSelectHook(() => harness.generation.set({ id: 2 }))
  const result = await harness.catalog.selectSessionPreset('session-a', 'minimal')
  assert.equal(result.outcome.kind, 'rejected',
    'the refusal is provable from the Host that processed it; a later reconnect does not make it indeterminate')
  assert.equal(result.ownership, 'superseded')
})

test('a roster FAILURE after a reconnect reports the stale-generation fence, not the old failure', async () => {
  const harness = presetHarness()
  harness.setListResult({ ok: false, error: failure('gateway/internal', 'old roster exploded') })
  harness.setListHook(() => harness.generation.set({ id: 2 }))
  await assert.rejects(harness.catalog.roster(), /remote connection changed while loading the preset roster/)
})

test('an out-of-order older roster read is refused to its caller and kept out of cache', async () => {
  const harness = presetHarness()
  const older: RemotePresetRoster = { presets: [{ id: 'standard', trust: 'system', isDefault: true }], modeSelectionEnabled: true }
  const newer: RemotePresetRoster = { presets: [{ id: 'minimal', trust: 'system', isDefault: true }], modeSelectionEnabled: true }
  const gates: Array<() => void> = []
  let call = 0
  harness.setListHook(() => new Promise<void>((resolve) => { gates[call++] = resolve }))
  harness.queueListResults({ ok: true, value: older }, { ok: true, value: newer })
  const first = harness.catalog.roster()
  const second = harness.catalog.roster()
  await Promise.resolve()
  gates[1]!() // the NEWER read resolves first
  await second
  gates[0]!() // the OLDER read resolves last
  // v2 §0.2.3: the superseded read serves the NEWER roster, never its own.
  const staleCaller = await first
  assert.equal(staleCaller.defaultId, 'minimal', 'a superseded read serves the newer value')
  assert.equal(harness.catalog.defaultId(), 'minimal', 'the late older read must not overwrite the newer default')
})

test('a pre-aborted preset select settles cancelled with zero dispatch', async () => {
  const harness = presetHarness()
  const controller = new AbortController()
  controller.abort()
  const result = await harness.catalog.selectSessionPreset('session-a', 'minimal', controller.signal)
  assert.deepEqual(result, { ownership: 'current', outcome: { kind: 'cancelled' } })
  assert.deepEqual(harness.calls.selects, [], 'a pre-aborted switch must not dispatch')
})

test('an abort AFTER dispatch does not claim cancelled: a proven success stays committed+superseded', async () => {
  const harness = presetHarness()
  const controller = new AbortController()
  harness.setSelectHook(() => controller.abort())
  const result = await harness.catalog.selectSessionPreset('session-a', 'minimal', controller.signal)
  assert.equal(result.outcome.kind, 'committed')
  assert.equal(result.ownership, 'superseded')
})

test('overlapping same-generation preset selects: only the newest owns the surface', async () => {
  const harness = presetHarness()
  const gates: Array<() => void> = []
  harness.setSelectGate(() => new Promise<void>((resolve) => { gates.push(resolve) }))
  const first = harness.catalog.selectSessionPreset('session-a', 'standard')
  const second = harness.catalog.selectSessionPreset('session-a', 'minimal')
  await Promise.resolve()
  assert.equal(gates.length, 2, 'both switches dispatched')
  gates[0]!(); gates[1]!()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.ownership, 'superseded')
  assert.equal(b.ownership, 'current')
})

test('a reconnect while a SUCCESSFUL roster read is in flight refuses the stale result', async () => {
  const harness = presetHarness()
  harness.setListHook(() => harness.generation.set({ id: 2 }))
  await assert.rejects(harness.catalog.roster(), /remote connection changed while loading the preset roster/)
})

test('roster honours a pre-aborted signal', async () => {
  const harness = presetHarness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(harness.catalog.roster(controller.signal), /abort/i)
})

test('roster aborts when the signal aborts during the read', async () => {
  const harness = presetHarness()
  const controller = new AbortController()
  harness.setListHook(() => controller.abort())
  await assert.rejects(harness.catalog.roster(controller.signal), /abort/i)
})
