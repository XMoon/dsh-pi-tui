/**
 * Tests for the subagent model-selection allowlist picker
 * (subagent-model-menu.ts): the official-setting write-through, the
 * provider-grouped flat + searchable UX over the OFFICIAL model directory
 * (`loadDirectory`), per-provider failure isolation inside the directory, a
 * whole-directory failure, route identity, saved-but-absent routes, the
 * marker bookkeeping, and the official "enabled requires at least one route"
 * client-side guard.
 * @module @xmoon76/dsh-pi-tui/subagent-model-menu.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import {
  SubagentModelAllowlistPicker,
  allowlistRouteKey,
  allowlistSummary,
  lastRouteWhileEnabled,
  projectSubagentAllowlist,
  type AllowlistCatalogState,
  type SubagentAllowlistPickerDeps,
} from '../src/tui/pickers/subagent-model-menu.ts'
import type { ModelDirectoryDto } from '../src/runtime/catalog-port.ts'
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

/** One provider group spec for the rig's directory. */
interface GroupSpec {
  readonly id: string
  readonly name?: string
  readonly models: readonly { readonly id: string; readonly name?: string }[]
}

/** Build the official directory DTO shape the picker consumes. */
function directoryOf(options: {
  groups?: readonly GroupSpec[]
  failures?: readonly { id: string; name: string; message: string }[]
}): ModelDirectoryDto {
  return {
    default: { provider: 'dflt', model: 'dflt' },
    routableProviders: (options.groups ?? []).map(group => group.id),
    groups: (options.groups ?? []).map(group => ({
      id: group.id,
      name: group.name ?? group.id,
      models: group.models.map(model => ({
        id: model.id,
        name: model.name ?? model.id,
        ...model.name === undefined ? {} : { description: `${model.id} description` },
      })),
    })),
    failures: options.failures ?? [],
  }
}

interface RigOptions {
  /** The directory `loadDirectory` resolves with (default: one group `p` with m1/m2). */
  directory?: ModelDirectoryDto
  /** Hold the directory load pending until `resolveDirectory`/`rejectDirectory`. */
  defer?: boolean
}

interface DepsRig {
  deps: SubagentAllowlistPickerDeps
  store: ReturnType<typeof selectionStore>
  notices: Array<{ message: string; kind: 'info' | 'error' }>
  renders: () => number
  dones: Array<string | undefined>
  /** Post-close convergence values (the fork rejects `done` once the submenu
   * closed, so the committed summary arrives through this seam). */
  summaries: string[]
  settled: Promise<void>[]
  /** How many times loadDirectory was called (the ONE official catalog read). */
  directoryReads: () => number
  resolveDirectory: (directory: ModelDirectoryDto) => void
  rejectDirectory: (error: Error) => void
}

function rig(initial: { enabled: boolean; allowedModels: readonly SubagentAllowedModelRoute[] }, options: RigOptions = {}): DepsRig {
  const store = selectionStore(initial)
  const notices: DepsRig['notices'] = []
  const dones: DepsRig['dones'] = []
  const summaries: string[] = []
  const settled: Promise<void>[] = []
  let renders = 0
  let directoryReads = 0
  const directory = options.directory ?? directoryOf({ groups: [{ id: 'p', name: 'Provider P', models: [{ id: 'm1' }, { id: 'm2' }] }] })
  let pending: { resolve: (value: ModelDirectoryDto) => void; reject: (error: Error) => void } | undefined
  const deps: SubagentAllowlistPickerDeps = {
    selection: store.config,
    catalog: {
      loadDirectory: () => {
        directoryReads += 1
        if (options.defer === true) {
          return new Promise<ModelDirectoryDto>((resolve, reject) => {
            pending = { resolve, reject }
          })
        }
        return Promise.resolve(directory)
      },
    },
    notify: (message, kind) => { notices.push({ message, kind }) },
    requestRender: () => { renders += 1 },
    done: (selected?: string) => { dones.push(selected) },
    summarize: (value) => { summaries.push(value) },
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
    directoryReads: () => directoryReads,
    resolveDirectory: next => { pending?.resolve(next) },
    rejectDirectory: error => { pending?.reject(error) },
  }
}

/** Flush the picker's directory load and serialized write chain. */
async function settle(harness: DepsRig, expectedWrites: number): Promise<void> {
  for (let i = 0; i < 16 && harness.store.setPromises.length < expectedWrites; i += 1) {
    await Promise.resolve()
  }
  await Promise.allSettled([...harness.settled, ...harness.store.setPromises])
}

/** Bounded microtask flush WITHOUT awaiting a still-pending deferred
 * directory load (used by the late-settlement tests). */
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

test('projection flattens directory groups in catalog order with full-identity allowed markers', () => {
  const projection = projectSubagentAllowlist({
    catalog: { state: 'ready', directory: directoryOf({
      groups: [
        { id: 'p1', name: 'One', models: [{ id: 'shared' }] },
        { id: 'p2', name: 'Two', models: [{ id: 'shared' }] },
      ],
    }) },
    allowed: [{ provider: 'p2', model: 'shared' }],
  })
  assert.deepEqual(projection.models.map(row => allowlistRouteKey(row.providerId, row.modelId)), [
    'p1\u0000shared', 'p2\u0000shared',
  ])
  assert.equal(projection.models[0]!.allowed, false, 'a same-id model under another provider is not allowed')
  assert.equal(projection.models[1]!.allowed, true)
})

test('projection keeps a failed provider as an inert failure row beside the loaded groups', () => {
  const projection = projectSubagentAllowlist({
    catalog: { state: 'ready', directory: directoryOf({
      groups: [{ id: 'a', models: [{ id: 'm' }] }],
      failures: [{ id: 'b', name: 'Bad', message: 'boom' }],
    }) },
    allowed: [],
  })
  assert.deepEqual(projection.models.map(row => row.providerId), ['a'])
  assert.deepEqual(projection.failures, [{ providerId: 'b', providerName: 'Bad', message: 'boom' }])
})

test('only a READY directory can claim a saved route absent', () => {
  const ready: AllowlistCatalogState = {
    state: 'ready',
    directory: directoryOf({ groups: [{ id: 'p', name: 'P', models: [{ id: 'm1' }] }] }),
  }
  const allowed = [{ provider: 'p', model: 'm1' }, { provider: 'gone', model: 'old-model' }] as const
  const projection = projectSubagentAllowlist({ catalog: ready, allowed })
  assert.deepEqual(projection.models.map(row => allowlistRouteKey(row.providerId, row.modelId)), [
    'p\u0000m1',
    'gone\u0000old-model',
  ])
  assert.equal(projection.models[0]!.savedRoute, undefined, 'a listed route is a normal row')
  assert.equal(projection.models[1]!.savedRoute, 'absent', 'the ready directory provably omits it')
  assert.equal(projection.models[1]!.allowed, true)
})

test('a loading catalog never claims absence — saved routes stay saved, unverified', () => {
  const projection = projectSubagentAllowlist({
    catalog: { state: 'loading' },
    allowed: [{ provider: 'gone', model: 'old-model' }],
  })
  assert.equal(projection.models.length, 1, 'the saved route stays representable and removable')
  assert.equal(projection.models[0]!.savedRoute, 'catalog-loading', 'absence is never claimed while loading')
  assert.deepEqual(projection.failures, [])
})

test('a failed whole-directory read never claims absence', () => {
  const projection = projectSubagentAllowlist({
    catalog: { state: 'failed', reason: 'remote connection is not connected' },
    allowed: [{ provider: 'p', model: 'm1' }],
  })
  assert.equal(projection.models[0]!.savedRoute, 'catalog-unavailable')
  assert.deepEqual(projection.failures, [{
    providerId: 'model-directory',
    providerName: 'Model directory',
    message: 'remote connection is not connected',
  }])
})

test('a provider-side failure never claims that provider\'s saved routes absent', () => {
  const projection = projectSubagentAllowlist({
    catalog: { state: 'ready', directory: directoryOf({
      groups: [{ id: 'ok', name: 'Ok', models: [{ id: 'm' }] }],
      failures: [{ id: 'anthropic', name: 'Anthropic', message: 'lookup failed' }],
    }) },
    allowed: [
      { provider: 'anthropic', model: 'claude-x' },
      { provider: 'ok', model: 'really-gone' },
    ],
  })
  const anthropic = projection.models.find(row => row.providerId === 'anthropic')!
  const okGone = projection.models.find(row => row.providerId === 'ok' && row.modelId === 'really-gone')!
  assert.equal(anthropic.savedRoute, 'provider-unavailable',
    'the failed provider\'s catalog could not answer — absence is not a fact')
  assert.equal(okGone.savedRoute, 'absent',
    'the loaded provider\'s omission IS provable')
})

test('toggling a model writes the WHOLE official section and Esc returns to /settings once', async () => {
  const harness = rig({ enabled: false, allowedModels: [] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  assert.equal(harness.directoryReads(), 1, 'exactly ONE official directory read')
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
    directory: directoryOf({
      groups: [
        { id: 'p1', name: 'One', models: [{ id: 'm1', name: 'Model One' }] },
        { id: 'p2', name: 'Two', models: [{ id: 'm2', name: 'Model Two' }] },
      ],
    }),
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
    directory: directoryOf({
      groups: [{ id: 'p', name: 'P', models: [{ id: 'gpt-5.6-sol', name: 'Sol' }, { id: 'pro', name: 'Pro' }] }],
    }),
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

test('a failed provider group isolates the failure and keeps the loaded groups editable', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, {
    directory: directoryOf({
      groups: [{ id: 'good', name: 'Good', models: [{ id: 'm1' }] }],
      failures: [{ id: 'bad', name: 'Bad', message: 'bad exploded' }],
    }),
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

test('a whole-directory failure renders one inert failure and keeps saved routes removable', async () => {
  const harness = rig({ enabled: true, allowedModels: [{ provider: 'p', model: 'm1' }] }, { defer: true })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  menu.render(60) // Loading models…
  harness.rejectDirectory(new Error('remote connection is not connected'))
  await settle(harness, 0)
  let view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('Model directory'), `the directory failure row must render:\n${view}`)
  assert.ok(view.includes('m1'), `the saved route must stay visible:\n${view}`)
  assert.ok(!view.includes('not in the current catalog'),
    `a failed catalog read must never claim absence:\n${view}`)
  // Filter to the saved route: its note says the catalog is unavailable —
  // absence is NOT claimed from a failed read.
  menu.handleInput('m1')
  await flush()
  view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('saved route (catalog unavailable)'),
    `the saved route carries the truthful unverified note:\n${view}`)
  for (let i = 0; i < 2; i += 1) menu.handleInput('\x7f')
  // Filter to the failure row: its reason renders as the selected detail and
  // Enter stays inert.
  menu.handleInput('directory')
  await flush()
  view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('remote connection is not connected'), `the directory failure reason must render:\n${view}`)
  menu.handleInput(ENTER)
  await flush()
  assert.deepEqual(harness.store.writes, [], 'Enter on the directory-failure row must not write')
  // The saved route stays removable in principle: the enabled+last-route
  // rule still guards the removal (disable first, then remove).
  for (let i = 0; i < 9; i += 1) menu.handleInput('\x7f')
  menu.handleInput('m1')
  await flush()
  menu.handleInput(ENTER) // cursor on the saved route -> refused while enabled
  await settle(harness, 0)
  assert.deepEqual(harness.store.writes, [], 'the last-route rule still applies on a failed directory')
})

test('a loading catalog shows saved routes WITHOUT the absence claim', async () => {
  const harness = rig({ enabled: true, allowedModels: [{ provider: 'p', model: 'm1' }] }, { defer: true })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  const view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('m1'), `the saved route stays visible while loading:\n${view}`)
  assert.ok(!view.includes('not in the current catalog'),
    `a still-loading catalog must never claim absence:\n${view}`)
  assert.ok(view.includes('catalog still loading'),
    `the saved route carries the truthful loading note:\n${view}`)
  harness.resolveDirectory(directoryOf({ groups: [{ id: 'p', name: 'P', models: [{ id: 'm1' }] }] }))
  await flush()
  // Once the directory arrives and lists the route, the saved-note disappears.
  const settled = menu.render(60).map(strip).join('\n')
  assert.ok(!settled.includes('Saved routes'), `a listed route is a normal row:\n${settled}`)
})

test('a provider-side failure keeps that provider\'s saved route unverified — never absent', async () => {
  const harness = rig({ enabled: true, allowedModels: [{ provider: 'bad', model: 'b1' }, { provider: 'ok', model: 'gone' }] }, {
    directory: directoryOf({
      groups: [{ id: 'ok', name: 'Ok', models: [{ id: 'here' }] }],
      failures: [{ id: 'bad', name: 'Bad', message: 'bad exploded' }],
    }),
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  const view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('Unavailable'), `the provider failure row must render:\n${view}`)
  // Both saved routes render under Saved routes with their own provable facts:
  // 'gone' IS absent (ok loaded and omits it); 'b1' is NOT claimed absent.
  menu.handleInput('b1')
  await flush()
  let filtered = menu.render(60).map(strip).join('\n')
  assert.ok(filtered.includes('provider catalog unavailable'),
    `the failed provider\'s saved route stays unverified:\n${filtered}`)
  assert.ok(!filtered.includes('not in the current catalog'),
    `the failed provider\'s saved route is never claimed absent:\n${filtered}`)
  for (let i = 0; i < 2; i += 1) menu.handleInput('\x7f')
  menu.handleInput('gone')
  await flush()
  filtered = menu.render(60).map(strip).join('\n')
  assert.ok(filtered.includes('not in the current catalog'),
    `the loaded provider\'s omission IS provable:\n${filtered}`)
})

test('search covers model name/id and provider name/id without changing allowed state', async () => {
  const harness = rig({ enabled: true, allowedModels: [{ provider: 'gw-42', model: 'm1' }] }, {
    directory: directoryOf({
      groups: [
        { id: 'gw-42', name: 'Custom Gateway', models: [{ id: 'm1', name: 'Sol' }] },
        { id: 'anthropic', name: 'Anthropic', models: [{ id: 'm2', name: 'Opus' }] },
      ],
    }),
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
    directory: directoryOf({
      groups: [
        { id: 'p1', name: 'One', models: [{ id: 'm', name: 'P1 Model' }] },
        { id: 'p2', name: 'Two', models: [{ id: 'm', name: 'P2 Model' }] },
      ],
    }),
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  assert.ok(selectedLine(menu, 60)?.includes('P2 Model'), `cursor must start on the allowed route:\n${menu.render(60).map(strip).join('\n')}`)
})

test('the initial cursor prefers an allowed catalog route over a saved-but-absent route', async () => {
  const harness = rig({ enabled: true, allowedModels: [{ provider: 'p', model: 'm1' }, { provider: 'gone', model: 'old' }] }, {
    directory: directoryOf({ groups: [{ id: 'p', name: 'P', models: [{ id: 'm1', name: 'Fresh' }] }] }),
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  assert.ok(selectedLine(menu, 60)?.includes('Fresh'), `a listed allowed route wins over the absent saved route:\n${menu.render(60).map(strip).join('\n')}`)
})

test('a saved-but-absent route renders as a removable trailing row', async () => {
  const harness = rig({ enabled: false, allowedModels: [{ provider: 'p', model: 'm1' }, { provider: 'gone', model: 'old' }] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  const view = menu.render(60).map(strip).join('\n')
  assert.ok(view.includes('Saved routes'), `the absent-route section must render:\n${view}`)
  assert.ok(view.includes('old'), `the absent saved route must render as a row:\n${view}`)
  // Filter to the absent route: its hint renders as the selected detail and
  // Enter removes it.
  menu.handleInput('old')
  await flush()
  assert.ok(menu.render(60).map(strip).join('\n').includes('saved route not in the current catalog'),
    `the absent-route hint must render for the selected row:\n${menu.render(60).map(strip).join('\n')}`)
  menu.handleInput(ENTER)
  await settle(harness, 1)
  assert.deepEqual(harness.store.writes[0]?.allowedModels, [{ provider: 'p', model: 'm1' }],
    'the absent saved route is removable')
})

test('duplicate model ids across providers keep distinct route identity', async () => {
  const harness = rig({ enabled: false, allowedModels: [{ provider: 'p2', model: 'm' }] }, {
    directory: directoryOf({
      groups: [
        { id: 'p1', name: 'One', models: [{ id: 'm', name: 'P1 Model' }] },
        { id: 'p2', name: 'Two', models: [{ id: 'm', name: 'P2 Model' }] },
      ],
    }),
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
    directory: directoryOf({
      groups: [{ id: 'p', name: 'P', models: Array.from({ length: 12 }, (_, index) => ({ id: `m${index}` })) }],
    }),
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
    directory: directoryOf({
      groups: [{ id: 'p', name: 'P', models: [{ id: 'id-a', name: 'Alpha' }, { id: 'id-b', name: 'Bravo' }] }],
    }),
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  const lines = menu.render(60).map(strip)
  const detail = lines.findIndex(line => line.includes('id-a'))
  assert.ok(detail >= 0, `detail row missing:\n${lines.join('\n')}`)
  assert.equal(menu.handleMouse(mouse('press', 5, detail, 60, 10)), undefined, 'the detail row must be inert')
  assert.deepEqual(harness.store.writes, [], 'an inert detail click must not write')
})

test('a click before the directory settles is inert (no stale toggle)', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, { defer: true })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  menu.render(60) // Loading models… painted
  menu.handleMouse(mouse('press', 5, 0, 60, 10))
  menu.handleMouse(mouse('click', 5, 0, 60, 10))
  await flush()
  assert.deepEqual(harness.store.writes, [], 'a click on the unpainted loading state must not write')
})

test('a failed provider never becomes the initial selectable row', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, {
    directory: directoryOf({
      groups: [{ id: 'good', name: 'Good', models: [{ id: 'm1' }] }],
      failures: [{ id: 'bad', name: 'Bad', message: 'bad exploded' }],
    }),
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

test('closing before the directory settles never rebuilds, repaints, or notifies', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, { defer: true })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  menu.render(60) // Loading models…
  const rendersBefore = harness.renders()
  menu.handleInput(ESC) // close while the directory load is still pending
  assert.deepEqual(harness.dones, ['0 routes'], 'the close reports the current summary once')
  harness.resolveDirectory(directoryOf({ groups: [{ id: 'p1', name: 'One', models: [{ id: 'm1' }] }] })) // late success
  await settle(harness, 0)
  assert.equal(harness.renders(), rendersBefore, 'a settle after close must not request a repaint')
  assert.deepEqual(harness.dones, ['0 routes'], 'no second close/summary via done')
  assert.equal(harness.notices.length, 0, 'no late toast after close')
  assert.ok(!menu.render(60).map(strip).join('\n').includes('m1'), 'no rows may be built after close')
})

test('a late directory settle cannot move the cursor after the user interacted', async () => {
  // While the directory loads, only the SAVED absent route (m0) renders and
  // the picker auto-selects it. Without interaction, the post-settle
  // placement would jump the cursor to the first allowed CATALOG row (m1).
  // The user typing a filter mid-load is a real interaction, so the value-
  // preserving refresh must keep the cursor on m0 instead.
  const directory = directoryOf({
    groups: [
      { id: 'p1', name: 'One', models: [{ id: 'm1' }] },
      { id: 'p2', name: 'Two', models: [{ id: 'm0' }] },
    ],
  })
  const harness = rig({
    enabled: true,
    allowedModels: [{ provider: 'p2', model: 'm0' }, { provider: 'p1', model: 'm1' }],
  }, { directory, defer: true })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  assert.ok(selectedLine(menu, 60)?.includes('m0'), 'the loading state auto-selects the saved absent route')
  menu.handleInput('m') // a filter edit is a real interaction pre-settle
  harness.resolveDirectory(directory)
  await flush()
  assert.ok(selectedLine(menu, 60)?.includes('m0'),
    `a late settle must not move the cursor to the allowed catalog route after the user interacted:\n${menu.render(60).map(strip).join('\n')}`)
})

test('a mouse press during loading latches against the late settle', async () => {
  // The press targets the only row that exists mid-load (the saved absent
  // route m0) and changes nothing, so onSelectionChange never fires; the
  // pointer gesture itself must still cancel the one-shot placement so the
  // late settle cannot jump the cursor to the allowed catalog route (m1).
  const directory = directoryOf({
    groups: [
      { id: 'p1', name: 'One', models: [{ id: 'm1' }] },
      { id: 'p2', name: 'Two', models: [{ id: 'm0' }] },
    ],
  })
  const harness = rig({
    enabled: true,
    allowedModels: [{ provider: 'p2', model: 'm0' }, { provider: 'p1', model: 'm1' }],
  }, { directory, defer: true })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  const row = labelRow(menu, 60, 'm0')
  assert.ok(row >= 0, 'the saved absent route renders mid-load')
  menu.handleMouse(mouse('press', 5, row, 60, 10))
  harness.resolveDirectory(directory)
  await flush()
  assert.ok(selectedLine(menu, 60)?.includes('m0'),
    `the press must latch against the late settle:\n${menu.render(60).map(strip).join('\n')}`)
})

test('the allowlist empty state separates loading, a settled empty directory, and a zero-match search', async () => {
  // Still loading.
  const pending = rig({ enabled: false, allowedModels: [] }, { defer: true })
  const pendingMenu = new SubagentModelAllowlistPicker(pending.deps)
  assert.ok(pendingMenu.render(60).map(strip).join('\n').includes('Loading models…'),
    `a pending load must say Loading:\n${pendingMenu.render(60).map(strip).join('\n')}`)
  pending.resolveDirectory(directoryOf({ groups: [] })) // settles with an EMPTY directory
  await flush()
  assert.ok(pendingMenu.render(60).map(strip).join('\n').includes('no models available'),
    `a settled empty directory must not keep saying Loading:\n${pendingMenu.render(60).map(strip).join('\n')}`)
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
    directory: directoryOf({
      failures: [
        { id: 'ga', name: 'Gateway A', message: 'ga down' },
        { id: 'gb', name: 'Gateway B', message: 'gb down' },
      ],
    }),
  })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  const lines = menu.render(60).map(strip)
  assert.equal(lines.filter(line => line.includes('Unavailable · 2')).length, 1,
    `two failures must form ONE section:\n${lines.join('\n')}`)
})

test('an allowlist over an empty directory says no models', async () => {
  const harness = rig({ enabled: false, allowedModels: [] }, { directory: directoryOf({ groups: [] }) })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  assert.ok(menu.render(60).map(strip).join('\n').includes('no models available'),
    `an empty directory must say no models available:\n${menu.render(60).map(strip).join('\n')}`)
})

test('the allowlist keeps the default TRAILING badge layout (not right-aligned)', async () => {
  const harness = rig({ enabled: true, allowedModels: [{ provider: 'p', model: 'm1' }] })
  const menu = new SubagentModelAllowlistPicker(harness.deps)
  await settle(harness, 0)
  const lines = menu.render(60).map(strip)
  const row = lines.find(line => line.includes('m1') && line.includes('allowed'))
  assert.ok(row !== undefined, lines.join('\n'))
  assert.ok(row.includes('m1  allowed'), `the badge must trail the label:\n${row}`)
  assert.ok(visibleWidth(row) < 60, `the default layout must not pad to the row edge:\n${JSON.stringify(row)}`)
})
