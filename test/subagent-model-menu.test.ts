/**
 * Tests for the subagent model-selection allowlist picker
 * (subagent-model-menu.ts): the official-setting write-through, the
 * provider-grouped flat + searchable UX, partial provider failure, route
 * identity, the marker bookkeeping, and the official "enabled requires at
 * least one route" client-side guard.
 * @module @xmoon76/dsh-pi-tui/subagent-model-menu.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SubagentModelAllowlistPicker,
  allowlistRouteKey,
  allowlistSummary,
  lastRouteWhileEnabled,
  projectSubagentAllowlist,
  type AllowlistModel,
  type AllowlistProvider,
  type SubagentAllowlistPickerDeps,
} from '../src/subagent-model-menu.ts'
import type { SubagentAllowedModelRoute, SubagentModelSelectionConfig } from '../src/runtime/config-port.ts'
import type { OwnedTaskOptions } from '../src/detached.ts'

function selectionStore(initial: { enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] }): {
  config: SubagentModelSelectionConfig
  writes: Array<{ enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] }>
  setPromises: Promise<void>[]
  failNext: () => void
} {
  let state = initial
  let fail = false
  const writes: Array<{ enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] }> = []
  const setPromises: Promise<void>[] = []
  return {
    config: {
      available: () => true,
      get: () => ({ enabled: state.enabled, allowedModels: state.allowedModels }),
      set: async value => {
        const attempt = (async () => {
          if (fail) {
            fail = false
            throw new Error('official validation rejected the section')
          }
          writes.push({ ...value, allowedModels: [...value.allowedModels] })
          state = { enabled: value.enabled, allowedModels: [...value.allowedModels] }
        })()
        setPromises.push(attempt)
        await attempt
      },
    },
    writes,
    setPromises,
    failNext: () => { fail = true },
  }
}

interface RigOptions {
  providers?: readonly AllowlistProvider[]
  /** Models per provider id (default: `{ p: [m1, m2] }`). */
  models?: Readonly<Record<string, readonly AllowlistModel[]>>
  /** Providers whose discovery rejects. */
  failing?: readonly string[]
  /** Hold every provider load pending until `resolveProvider`/`rejectProvider`. */
  defer?: boolean
}

interface DepsRig {
  deps: SubagentAllowlistPickerDeps
  store: ReturnType<typeof selectionStore>
  notices: Array<{ message: string; kind: 'info' | 'error' }>
  renders: () => number
  dones: Array<string | undefined>
  /** Post-close convergence values (the fork rejects `done` once the submenu
   *  closed, so the committed summary arrives through this seam). */
  summaries: string[]
  settled: Promise<void>[]
  resolveProvider: (providerId: string, models: readonly AllowlistModel[]) => void
  rejectProvider: (providerId: string, error: Error) => void
}

function rig(initial: { enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] }, options: RigOptions = {}): DepsRig {
  const store = selectionStore(initial)
  const notices: DepsRig['notices'] = []
  const dones: DepsRig['dones'] = []
  const summaries: string[] = []
  const settled: Promise<void>[] = []
  const providers = options.providers ?? [{ id: 'p', name: 'Provider P' }]
  const models = options.models ?? { p: [{ id: 'm1' }, { id: 'm2' }] }
  const failing = new Set(options.failing ?? [])
  const pendingLoads = new Map<string, { resolve: (value: readonly AllowlistModel[]) => void; reject: (error: Error) => void }>()
  let renders = 0
  const deps: SubagentAllowlistPickerDeps = {
    selection: store.config,
    catalog: {
      listProviders: () => providers,
      listModels: (providerId: string) => {
        if (failing.has(providerId)) return Promise.reject(new Error(`${providerId} exploded`))
        if (options.defer === true) {
          return new Promise<readonly AllowlistModel[]>((resolve, reject) => {
            pendingLoads.set(providerId, { resolve, reject })
          })
        }
        return Promise.resolve(models[providerId] ?? [])
      },
    },
    notify: (message: string, kind: 'info' | 'error') => { notices.push({ message, kind }) },
    requestRender: () => { renders += 1 },
    done: (selected?: string) => { dones.push(selected) },
    summarize: (value: string) => { summaries.push(value) },
    runOwned: <T,>(_label: string, task: () => T | Promise<T>, taskOptions: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
      settled.push((async () => {
        try {
          taskOptions.onResult?.(await task())
        } catch (error) {
          taskOptions.onError?.(error as Error)
        }
      })())
    },
  }
  return {
    deps,
    store,
    notices,
    renders: () => renders,
    dones,
    summaries,
    settled,
    resolveProvider: (providerId, next) => { pendingLoads.get(providerId)?.resolve(next) },
    rejectProvider: (providerId, error) => { pendingLoads.get(providerId)?.reject(error) },
  }
}

/** Flush the picker's provider loads and serialized write chain. */
async function settle(harness: DepsRig, expectedWrites: number): Promise<void> {
  for (let i = 0; i < 16 && harness.store.setPromises.length < expectedWrites; i += 1) {
    await Promise.resolve()
  }
  await Promise.allSettled([...harness.settled, ...harness.store.setPromises])
}

/** Bounded microtask flush WITHOUT awaiting still-pending deferred provider
 *  loads (used by the progressive-settlement tests). */
async function flush(turns = 16): Promise<void> {
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
}

const ENTER = '\r'
const ESC = '\x1b'

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
const labelRow = (menu: SubagentModelAllowlistPicker, width: number, label: string): number =>
  menu.render(width).map(strip).findIndex(line => line.includes(label))
const selectedLine = (menu: SubagentModelAllowlistPicker, width: number): string | undefined =>
  menu.render(width).map(strip).find(line => line.startsWith('→ '))

test('allowlistSummary and lastRouteWhileEnabled are pure', () => {
  assert.equal(allowlistSummary([]), '0 routes')
  assert.equal(allowlistSummary([{ provider: 'p', model: 'm' }]), '1 route')
  assert.equal(allowlistSummary([{ provider: 'p', model: 'm' }, { provider: 'q', model: 'n' }]), '2 routes')
  const only: readonly SubagentAllowedModelRoute[] = [{ provider: 'p', model: 'm' }]
  assert.equal(lastRouteWhileEnabled(true, only, { provider: 'p', model: 'm' }), true)
  assert.equal(lastRouteWhileEnabled(false, only, { provider: 'p', model: 'm' }), false)
  assert.equal(lastRouteWhileEnabled(true, [...only, { provider: 'q', model: 'n' }], { provider: 'p', model: 'm' }), false)
})

test('projection flattens providers in catalog order with full-identity allowed markers', () => {
  const projection = projectSubagentAllowlist({
    providers: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    models: new Map([['p1', [{ id: 'shared' }]], ['p2', [{ id: 'shared' }]]]),
    failures: new Map(),
    allowed: [{ provider: 'p2', model: 'shared' }],
  })
  assert.deepEqual(projection.models.map(row => allowlistRouteKey(row.providerId, row.modelId)), [
    'p1\u0000shared', 'p2\u0000shared',
  ])
  assert.equal(projection.models[0]!.allowed, false, 'a same-id model under another provider is not allowed')
  assert.equal(projection.models[1]!.allowed, true)
})

test('projection keeps a failed provider as an inert failure row and skips still-loading providers', () => {
  const projection = projectSubagentAllowlist({
    providers: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    models: new Map([['a', [{ id: 'm' }]]]),
    failures: new Map([['b', 'boom']]),
    allowed: [],
  })
  assert.deepEqual(projection.models.map(row => row.providerId), ['a'])
  assert.deepEqual(projection.failures, [{ providerId: 'b', providerName: 'b', message: 'boom' }])
})

test('toggling a model writes the WHOLE official section and Esc returns to /settings once', async () => {
  const harness = rig({ enabled: false, allowedModels: [] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  // No provider navigation: the cursor already sits on the first model row.
  assert.ok(selectedLine(menu, 60)?.includes('m1'), `cursor must start on the first model:\n${menu.render(60).map(strip).join('\n')}`)
  menu.handleInput(ENTER) // toggle m1 on
  await settle(harness, 1)
  assert.deepEqual(harness.store.writes, [
    { enabled: false, allowedModels: [{ provider: 'p', model: 'm1' }] },
  ], 'the whole official section rides every write')
  menu.handleInput(ESC) // ONE Esc returns to /settings
  assert.deepEqual(harness.dones, ['1 route'], 'a single Esc closes and reports the fresh summary')
})

test('Enter on an already-allowed row removes the route and keeps enabled', async () => {
  const harness = rig({ enabled: true, allowedModels: [{ provider: 'p', model: 'm1' }, { provider: 'p', model: 'm2' }] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  menu.handleInput(ENTER) // cursor on the first allowed route (m1) -> remove
  await settle(harness, 1)
  assert.deepEqual(harness.store.writes, [
    { enabled: true, allowedModels: [{ provider: 'p', model: 'm2' }] },
  ])
})

test('removing the LAST route while enabled is refused with the official rule', async () => {
  const harness = rig({ enabled: true, allowedModels: [{ provider: 'p', model: 'm1' }] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  menu.handleInput(ENTER) // cursor starts on the only allowed route -> refused
  await settle(harness, 0)
  assert.deepEqual(harness.store.writes, [], 'the refused toggle never writes')
  assert.equal(harness.notices.at(-1)?.kind, 'error')
  assert.match(harness.notices.at(-1)?.message ?? '', /disable subagent model selection before removing the last route/u)
})

test('a REJECTED official write rolls the optimistic marker back to the committed section', async () => {
  const harness = rig({ enabled: false, allowedModels: [] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  menu.handleInput(ENTER) // toggle m1 on -> commits
  await settle(harness, 1)
  harness.store.failNext()
  menu.handleInput('\x1b[B') // move to m2
  menu.handleInput(ENTER) // toggle m2 on -> this write is REJECTED
  await settle(harness, 2)
  assert.equal(harness.notices.at(-1)?.kind, 'error')
  assert.match(harness.notices.at(-1)?.message ?? '', /allowlist write failed/u)
  assert.deepEqual(harness.store.config.get().allowedModels, [{ provider: 'p', model: 'm1' }],
    'the section stays at its committed state')
  const lines = menu.render(60).map(strip)
  assert.ok(lines.find(line => line.includes('m1'))?.includes('allowed'), 'the committed marker stays')
  assert.ok(!lines.find(line => line.includes('m2'))?.includes('allowed'), 'the rejected optimistic marker rolled back')
})

test('overlapping toggles serialize: a failed earlier write never corrupts a later commit or the markers', async () => {
  const harness = rig({ enabled: false, allowedModels: [] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  harness.store.failNext()
  menu.handleInput(ENTER) // toggle m1 ON — this write is REJECTED
  menu.handleInput('\x1b[B') // move to m2
  menu.handleInput(ENTER) // toggle m2 ON — commits after the failure
  await settle(harness, 2)
  assert.equal(harness.notices.at(-1)?.kind, 'error', 'the rejected write surfaces a notice')
  assert.deepEqual(harness.store.config.get().allowedModels, [
    { provider: 'p', model: 'm1' },
    { provider: 'p', model: 'm2' },
  ])
  assert.ok(menu.render(60).map(strip).some(line => line.includes('allowed')), 'the markers agree with the committed section')
  menu.handleInput(ENTER) // toggle the cursor's route OFF (the second toggle left it on m2)
  await settle(harness, 3)
  assert.deepEqual(harness.store.config.get().allowedModels, [{ provider: 'p', model: 'm1' }])
})

test('a write settling AFTER the picker closed converges the outer row and stays silent', async () => {
  const harness = rig({ enabled: false, allowedModels: [] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  harness.store.failNext()
  menu.handleInput(ENTER) // toggle m1 ON — this write will FAIL
  menu.handleInput(ESC) // ONE Esc closes (optimistic '1 route')
  assert.deepEqual(harness.dones, ['1 route'], 'the close reports the optimistic summary')
  await settle(harness, 1)
  assert.deepEqual(harness.summaries.at(-1), '0 routes',
    'the post-close settle converges the outer row through `summarize` (the fork rejects a late done)')
  assert.ok(!harness.dones.includes('0 routes'), 'a late done after close must not be used')
  assert.equal(harness.notices.length, 0, 'a failure settling after close stays silent')
})

test('the flat list is provider-grouped with no provider navigation step', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, {
    providers: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    models: { p1: [{ id: 'm1', name: 'Model One' }], p2: [{ id: 'm2', name: 'Model Two' }] },
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  const view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('One') && view.includes('Two'), `both groups must render:\n${view}`)
  assert.ok(view.includes('Model One') && view.includes('Model Two'), `models must be directly visible:\n${view}`)
  // Enter toggles the highlighted model without any provider step.
  menu.handleInput(ENTER)
  await settle(harness, 1)
  assert.deepEqual(harness.store.writes[0]?.allowedModels, [{ provider: 'p1', model: 'm1' }])
})

test('a model detail shows its id only while highlighted', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, {
    models: { p: [{ id: 'gpt-5.6-sol', name: 'Sol' }, { id: 'pro', name: 'Pro' }] },
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  let view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('gpt-5.6-sol'), `the selected row must show its id detail:\n${view}`)
  assert.ok(!view.includes('pro\n'), `an unselected row must not expand its id:\n${view}`)
  menu.handleInput('\x1b[B')
  view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('pro'), 'the new selected row shows its id')
})

test('partial provider failure isolates the failure and keeps other providers editable', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, {
    providers: [{ id: 'good', name: 'Good' }, { id: 'bad', name: 'Bad' }],
    models: { good: [{ id: 'm1' }] },
    failing: ['bad'],
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  const view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('m1'), `the good provider stays editable:\n${view}`)
  assert.ok(view.includes('Unavailable') && view.includes('unavailable'), `the failure row must render:\n${view}`)
  // The good provider's model still toggles.
  menu.handleInput(ENTER)
  await settle(harness, 1)
  assert.deepEqual(harness.store.writes[0]?.allowedModels, [{ provider: 'good', model: 'm1' }])
  // A failure row is inert: filter to it and press Enter.
  menu.handleInput('bad')
  await settle(harness, 1)
  assert.ok(menu.render(60).map(strip).join('\n').includes('bad exploded'), `failure detail missing:\n${menu.render(60).map(strip).join('\n')}`)
  menu.handleInput(ENTER)
  await settle(harness, 1)
  assert.equal(harness.store.writes.length, 1, 'Enter on a failure row must not write')
})

test('search covers model name/id and provider name/id without changing allowed state', async () => {
  const harness = rig({ enabled: true, allowedModels: [{ provider: 'gw-42', model: 'm1' }] }, {
    providers: [{ id: 'gw-42', name: 'Custom Gateway' }, { id: 'anthropic', name: 'Anthropic' }],
    models: { 'gw-42': [{ id: 'm1', name: 'Sol' }], anthropic: [{ id: 'm2', name: 'Opus' }] },
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  menu.handleInput('custom') // provider display name
  let view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('Sol') && !view.includes('Opus'), `provider-name search failed:\n${view}`)
  assert.ok(view.includes('allowed'), 'the allowed marker must survive filtering')
  for (let i = 0; i < 6; i += 1) menu.handleInput('\x7f')
  menu.handleInput('gw-42') // provider id
  view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('Sol') && !view.includes('Opus'), `provider-id search failed:\n${view}`)
  for (let i = 0; i < 5; i += 1) menu.handleInput('\x7f')
  menu.handleInput('opus') // model name
  view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('Opus') && !view.includes('Sol'), `model-name search failed:\n${view}`)
  for (let i = 0; i < 4; i += 1) menu.handleInput('\x7f')
  menu.handleInput('m2') // model id
  view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('Opus') && !view.includes('Sol'), `model-id search failed:\n${view}`)
  assert.deepEqual(harness.store.config.get().allowedModels, [{ provider: 'gw-42', model: 'm1' }], 'search never mutates the allowlist')
})

test('the initial cursor prefers the first allowed route in catalog order', async () => {
  const harness = rig({ enabled: true, allowedModels: [{ provider: 'p2', model: 'm' }] }, {
    providers: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    models: { p1: [{ id: 'm', name: 'P1 Model' }], p2: [{ id: 'm', name: 'P2 Model' }] },
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  assert.ok(selectedLine(menu, 60)?.includes('P2 Model'), `cursor must start on the allowed route:\n${menu.render(60).map(strip).join('\n')}`)
})

test('duplicate model ids across providers keep distinct route identity', async () => {
  const harness = rig({ enabled: false, allowedModels: [{ provider: 'p2', model: 'm' }] }, {
    providers: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    models: { p1: [{ id: 'm', name: 'P1 Model' }], p2: [{ id: 'm', name: 'P2 Model' }] },
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  const lines = menu.render(60).map(strip)
  const p1 = lines.find(line => line.includes('P1 Model'))
  const p2 = lines.find(line => line.includes('P2 Model'))
  assert.ok(p1 !== undefined && !p1.includes('allowed'), `the same-id non-allowed route must not be marked: ${p1}`)
  assert.ok(p2?.includes('allowed'), `the allowed route must be marked: ${p2}`)
  // Toggling the p1 route adds a DISTINCT (provider, model) entry.
  menu.handleInput('p1') // filter to the p1 route
  await settle(harness, 0)
  menu.handleInput(ENTER)
  await settle(harness, 1)
  assert.deepEqual(harness.store.writes[0]?.allowedModels, [
    { provider: 'p2', model: 'm' },
    { provider: 'p1', model: 'm' },
  ])
})

test('the picker honors the forwarded row budget', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, {
    models: { p: Array.from({ length: 12 }, (_, index) => ({ id: `m${index}` })) },
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  menu.setMaxRows(6)
  await settle(harness, 0)
  assert.ok(menu.render(60).length <= 6, `the grant must cap the frame, got ${menu.render(60).length}`)
})

/** A minimal left-button mouse event for direct component tests. */
function mouse(type: 'press' | 'click', x: number, y: number, width = 60, height = 10): import('@xmoon76/pi-tui').TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  }
}

test('a mouse click toggles the exact model route (mouse parity)', async () => {
  const harness = rig({ enabled: false, allowedModels: [] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  const row = labelRow(menu, 60, 'm2')
  assert.ok(row >= 0, `m2 row missing:\n${menu.render(60).map(strip).join('\n')}`)
  const press = menu.handleMouse(mouse('press', 5, row, 60, 10))
  assert.ok(press?.handled, 'press on a model row must be handled')
  menu.handleMouse(mouse('click', 5, row, 60, 10))
  await settle(harness, 1)
  assert.deepEqual(harness.store.writes[0]?.allowedModels, [{ provider: 'p', model: 'm2' }],
    'clicking a model row toggles the exact route')
})

test('a click on the selected-detail row is inert and cannot toggle a neighbour', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, {
    models: { p: [{ id: 'id-a', name: 'Alpha' }, { id: 'id-b', name: 'Bravo' }] },
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  const lines = menu.render(60).map(strip)
  const detail = lines.findIndex(line => line.includes('id-a'))
  assert.ok(detail >= 0, `detail row missing:\n${lines.join('\n')}`)
  assert.equal(menu.handleMouse(mouse('press', 5, detail, 60, 10)), undefined, 'the detail row must be inert')
  assert.deepEqual(harness.store.writes, [], 'an inert detail click must not write')
})

test('a click before the rows load is inert (no stale toggle)', async () => {
  const harness = rig({ enabled: false, allowedModels: [] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  menu.render(60) // Loading models… painted
  menu.handleMouse(mouse('press', 5, 0, 60, 10))
  menu.handleMouse(mouse('click', 5, 0, 60, 10))
  await settle(harness, 0)
  assert.deepEqual(harness.store.writes, [], 'a click on the unpainted loading state must not write')
})

test('a failed provider never becomes the initial selectable row', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, {
    providers: [{ id: 'bad', name: 'Bad' }, { id: 'good', name: 'Good' }],
    models: { good: [{ id: 'm1' }] },
    failing: ['bad'],
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  assert.ok(selectedLine(menu, 60)?.includes('m1'), `cursor must start on the first model row:\n${menu.render(60).map(strip).join('\n')}`)
  assert.ok(!selectedLine(menu, 60)?.includes('Bad'), 'the failure row must not be the cursor')
})

test('focus reaches the search Input (CURSOR_MARKER)', async () => {
  const { CURSOR_MARKER } = await import('@xmoon76/pi-tui')
  const harness = rig({ enabled: false, allowedModels: [] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  menu.focused = true
  await settle(harness, 0)
  assert.ok(menu.render(60).join('\n').includes(CURSOR_MARKER), 'the focused picker must emit the cursor marker')
})

test('closing before provider loads settle never rebuilds, repaints, or notifies', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, {
    providers: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    defer: true,
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  menu.render(60) // Loading models…
  const rendersBefore = harness.renders()
  menu.handleInput(ESC) // close while BOTH provider loads are still pending
  assert.deepEqual(harness.dones, ['0 routes'], 'the close reports the current summary once')
  harness.resolveProvider('p1', [{ id: 'm1' }]) // late success
  harness.rejectProvider('p2', new Error('p2 exploded')) // late failure
  await settle(harness, 0)
  assert.equal(harness.renders(), rendersBefore, 'a settle after close must not request a repaint')
  assert.deepEqual(harness.dones, ['0 routes'], 'no second close/summary via done')
  assert.equal(harness.notices.length, 0, 'no late toast after close')
  assert.ok(!menu.render(60).map(strip).join('\n').includes('m1'), 'no rows may be built after close')
})

test('a late provider load cannot move the cursor after the user toggles', async () => {
  // Controlled progressive settlement: p1 (with the allowed route) settles
  // first, the user removes it, then p2 settles. The one-shot initial-cursor
  // placement must NOT fire and move the cursor back to the first allowed row.
  const harness = rig({ enabled: false, allowedModels: [
    { provider: 'p1', model: 'm1' },
    { provider: 'p1', model: 'm0' },
  ] }, {
    providers: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    defer: true,
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  harness.resolveProvider('p1', [{ id: 'm1' }, { id: 'm0' }])
  await flush() // p1 settles; p2 is still pending
  assert.ok(selectedLine(menu, 60)?.includes('m1'), `the cursor starts on the first allowed row:\n${menu.render(60).map(strip).join('\n')}`)
  menu.handleInput(ENTER) // remove m1 (allowed -> [m0])
  await flush()
  await Promise.allSettled(harness.store.setPromises)
  await flush()
  assert.ok(selectedLine(menu, 60)?.includes('m1'), 'the toggled row keeps the cursor')
  harness.resolveProvider('p2', [{ id: 'm2' }]) // late provider keeps settling
  await flush()
  assert.ok(selectedLine(menu, 60)?.includes('m1'),
    `a late provider load must not override the user's cursor:\n${menu.render(60).map(strip).join('\n')}`)
})

test('a mouse press on the already-selected row latches against a late provider load', async () => {
  // The press changes no selection (m1 is already the cursor), so nothing
  // fires onSelectionChange; the pointer gesture itself must still cancel the
  // one-shot placement so the late p2 load cannot move the cursor to m0.
  const harness = rig({ enabled: false, allowedModels: [{ provider: 'p1', model: 'm0' }] }, {
    providers: [{ id: 'p1', name: 'One' }, { id: 'p2', name: 'Two' }],
    defer: true,
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  harness.resolveProvider('p1', [{ id: 'm1' }, { id: 'm0' }])
  await flush()
  assert.ok(selectedLine(menu, 60)?.includes('m1'), `the cursor starts on m1:\n${menu.render(60).map(strip).join('\n')}`)
  const row = labelRow(menu, 60, 'm1')
  assert.ok(row >= 0)
  menu.handleMouse(mouse('press', 5, row, 60, 10)) // press the already-selected m1
  harness.resolveProvider('p2', [{ id: 'm2' }])
  await flush()
  assert.ok(selectedLine(menu, 60)?.includes('m1'),
    `the press must latch against the late load:\n${menu.render(60).map(strip).join('\n')}`)
})

test('the allowlist empty state separates loading, a settled empty catalog, and a zero-match search', async () => {
  // Still loading.
  const pending = rig({ enabled: false, allowedModels: [] }, { providers: [{ id: 'p', name: 'P' }], defer: true })
  const pendingMenu = new SubagentModelAllowlistPicker(pending.deps)
  assert.ok(pendingMenu.render(60).map(strip).join('\n').includes('Loading models…'),
    `a pending load must say Loading:\n${pendingMenu.render(60).map(strip).join('\n')}`)
  pending.resolveProvider('p', []) // settles with an EMPTY catalog
  await flush()
  assert.ok(pendingMenu.render(60).map(strip).join('\n').includes('no models available'),
    `a settled empty catalog must not keep saying Loading:\n${pendingMenu.render(60).map(strip).join('\n')}`)
  // Settled with catalog, then a zero-match query.
  const full = rig({ enabled: false, allowedModels: [] })
  const fullMenu = new SubagentModelAllowlistPicker(full.deps)
  await settle(full, 0)
  fullMenu.handleInput('zzzz')
  await flush()
  assert.ok(fullMenu.render(60).map(strip).join('\n').includes('No matching models'),
    `a zero-match query must say No matching models:\n${fullMenu.render(60).map(strip).join('\n')}`)
})

test('multiple provider failures collapse into one Unavailable section', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, {
    providers: [{ id: 'ga', name: 'Gateway A' }, { id: 'gb', name: 'Gateway B' }],
    failing: ['ga', 'gb'],
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  const lines = menu.render(60).map(strip)
  assert.equal(lines.filter(line => line.includes('Unavailable · 2')).length, 1,
    `two failures must form ONE section:\n${lines.join('\n')}`)
})

test('an allowlist with no configured providers says so', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, { providers: [] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  assert.ok(menu.render(60).map(strip).join('\n').includes('no providers configured'),
    `a zero-provider catalog must say so:\n${menu.render(60).map(strip).join('\n')}`)
})
