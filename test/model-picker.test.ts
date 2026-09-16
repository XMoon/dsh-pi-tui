/**
 * Headless tests for the `/model` inline-effort picker (src/model-picker.ts):
 * the pure directory projection, the immediate loading panel + in-place
 * hydration, the provider-grouped model list, the hidden description/id, the
 * per-model inline effort (`←`/`→`) and its submit payload, plus write
 * settlement, row budget, mouse parity and the approval/fullscreen lifecycle.
 * No second overlay is ever mounted.
 * @module @xmoon76/dsh-pi-tui/model-picker.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp } from '../src/tui-app.ts'
import {
  ModelPicker,
  modelIdentity,
  projectModelDirectory,
  type ModelApplyOutcome,
  type ModelPickerCurrent,
} from '../src/model-picker.ts'
import type { ModelDirectoryDto, ModelDirectoryModelDto, ModelSelectionDto } from '../src/runtime/catalog-port.ts'
import { runOwned, type OwnedTaskOptions } from '../src/detached.ts'
import { createDiag } from '../src/diag.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Every TuiApp started here is stopped after each test (single-live-TUI
 *  slot; see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '').replace(/\s+$/, '')
const viewOf = (vt: VirtualTerminal): string => vt.getViewport().map(stripAnsi).join('\n')
const linesOf = (vt: VirtualTerminal): string[] => vt.getViewport().map(stripAnsi)
/** Viewport lines with the overlay frame's left border stripped, so a row's
 *  own prefix (`→ `) is observable. */
const contentLinesOf = (vt: VirtualTerminal): string[] => linesOf(vt).map((line) => {
  const index = line.indexOf('│ ')
  return index === -1 ? line : line.slice(index + 2)
})
const selectedRow = (vt: VirtualTerminal): string | undefined =>
  contentLinesOf(vt).find(line => line.startsWith('→ '))
const rowLine = (vt: VirtualTerminal, label: string): string | undefined =>
  contentLinesOf(vt).find(line => line.includes(label))

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 30))
}

interface EffortShape {
  readonly id: string
  readonly name: string
  readonly description?: string
}

function model(id: string, overrides: {
  name?: string
  description?: string
  efforts?: readonly EffortShape[]
  defaultEffort?: string
} = {}): ModelDirectoryModelDto {
  return {
    id,
    name: overrides.name ?? id,
    ...(overrides.description === undefined ? {} : { description: overrides.description }),
    ...(overrides.efforts === undefined ? {} : {
      reasoning: {
        efforts: overrides.efforts.map(effort => ({ ...effort })),
        ...(overrides.defaultEffort === undefined ? {} : { defaultEffort: overrides.defaultEffort }),
      },
    }),
  }
}

function makeDirectory(input: {
  groups?: readonly { id: string; name: string; models: readonly ModelDirectoryModelDto[] }[]
  default?: ModelSelectionDto
  failures?: readonly { id: string; name: string; message: string }[]
} = {}): ModelDirectoryDto {
  return {
    default: input.default ?? { provider: 'p1', model: 'm1' },
    routableProviders: (input.groups ?? []).map(group => group.id),
    groups: input.groups ?? [],
    failures: input.failures ?? [],
  }
}

const TWO_PROVIDERS = makeDirectory({
  groups: [
    { id: 'openai', name: 'OpenAI', models: [model('shared-id', { name: 'Sol' }), model('gpt-pro', { name: 'Pro' })] },
    { id: 'anthropic', name: 'Anthropic', models: [model('shared-id', { name: 'Opus' })] },
  ],
  default: { provider: 'openai', model: 'gpt-pro' },
})

const EFFORT_DIRECTORY = makeDirectory({
  groups: [{
    id: 'p1',
    name: 'P1',
    models: [
      model('sol', { name: 'Sol', description: 'reasoning model', efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
        { id: 'xhigh', name: 'XHigh' },
      ], defaultEffort: 'medium' }),
      model('plain', { name: 'Plain' }),
    ],
  }],
  default: { provider: 'p1', model: 'sol' },
})

const EIGHT_MODELS = makeDirectory({
  groups: [{ id: 'p1', name: 'P1', models: Array.from({ length: 8 }, (_, i) => model(`m${i}`, { name: `Model ${i}` })) }],
  default: { provider: 'p1', model: 'm0' },
})

// ── pure projection ──────────────────────────────────────────────────────

test('projection flattens provider groups and keeps duplicate ids as distinct identities', () => {
  const projection = projectModelDirectory(TWO_PROVIDERS, { provider: 'openai', model: 'shared-id' }, false)
  assert.deepEqual(projection.models.map(row => modelIdentity(row.providerId, row.modelId)), [
    'openai\u0000shared-id',
    'openai\u0000gpt-pro',
    'anthropic\u0000shared-id',
  ])
  const openaiRow = projection.models.find(row => row.providerId === 'openai' && row.modelId === 'shared-id')!
  const anthropicRow = projection.models.find(row => row.providerId === 'anthropic' && row.modelId === 'shared-id')!
  assert.equal(openaiRow.isCurrent, true, 'the current full identity is marked current')
  assert.equal(anthropicRow.isCurrent, false, 'the same model id under another provider must not be current')
  assert.deepEqual(projection.models.find(row => row.modelId === 'gpt-pro')!.efforts, [])
})

test('projection marks the directory default independently of current', () => {
  const projection = projectModelDirectory(TWO_PROVIDERS, { provider: 'openai', model: 'shared-id' }, false)
  const current = projection.models.find(row => row.modelId === 'shared-id' && row.providerId === 'openai')!
  const defaultRow = projection.models.find(row => row.modelId === 'gpt-pro')!
  assert.equal(current.isCurrent, true)
  assert.equal(current.isDefault, false)
  assert.equal(defaultRow.isCurrent, false)
  assert.equal(defaultRow.isDefault, true)
})

test('projection separates the current effort (badge) from the configured effort (inline seed)', () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('m1', { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }), model('m2', { efforts: [{ id: 'low', name: 'Low' }] })] }],
    default: { provider: 'p1', model: 'm1' },
  })
  const projection = projectModelDirectory(directory, { provider: 'p1', model: 'm1', reasoningEffort: 'high' }, false)
  assert.equal(projection.models[0]!.currentEffort, 'high')
  assert.equal(projection.models[0]!.configuredEffort, 'high')
  assert.equal(projection.models[1]!.currentEffort, undefined, 'another model never takes the session effort')
  assert.equal(projection.models[1]!.configuredEffort, undefined)
})

test('a sessionless projection has a configured effort but never a current model', () => {
  const projection = projectModelDirectory(TWO_PROVIDERS, { provider: 'openai', model: 'gpt-pro' }, true)
  assert.ok(projection.models.every(row => !row.isCurrent), 'sessionless has no current')
  assert.equal(projection.models.find(row => row.modelId === 'gpt-pro')!.isDefault, true)
  assert.equal(projection.models.find(row => row.modelId === 'gpt-pro')!.configuredEffort, undefined)
})

test('projection maps provider failures to inert failure rows', () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('m1')] }],
    failures: [{ id: 'gw', name: 'Custom Gateway', message: 'connection refused' }],
  })
  const projection = projectModelDirectory(directory, undefined, false)
  assert.equal(projection.failures.length, 1)
  assert.equal(projection.failures[0]!.providerName, 'Custom Gateway')
  assert.equal(projection.failures[0]!.message, 'connection refused')
})

// ── component harness ────────────────────────────────────────────────────

interface HarnessOptions {
  directory?: ModelDirectoryDto
  current?: ModelPickerCurrent
  sessionless?: boolean
  /** Mount WITHOUT hydrating (the loading state). */
  loading?: boolean
  /** Mount the picker on the fullscreen (alt) screen — the only screen that
   *  dispatches pointer events to overlays. */
  fullscreen?: boolean
  apply?: (selection: ModelSelectionDto) => Promise<ModelApplyOutcome> | ModelApplyOutcome
  outcome?: ModelApplyOutcome
}

interface Harness {
  vt: VirtualTerminal
  app: TuiApp
  picker: ModelPicker
  applied: ModelSelectionDto[]
  closeCount: () => number
  close: () => void
  hydrate: (directory: ModelDirectoryDto, current?: ModelPickerCurrent, sessionless?: boolean) => void
}

async function openPicker(options: HarnessOptions): Promise<Harness> {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  if (options.fullscreen === true) app.setFullscreen(true)
  const applied: ModelSelectionDto[] = []
  const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })
  let closeCount = 0
  const picker = new ModelPicker({
    apply: (selection) => {
      applied.push(selection)
      return options.apply === undefined ? options.outcome ?? 'committed' : options.apply(selection)
    },
    requestRender: () => app.requestRender(),
    close: () => { closeCount += 1; closer() },
    runOwned: <T>(label: string, task: () => T | Promise<T>, ownedOptions: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => {
      runOwned(label, task, { ...ownedOptions, diag })
    },
  })
  let closer: () => void = () => {}
  closer = app.openModelPicker(picker)
  if (options.loading !== true) {
    picker.setDirectory({
      directory: options.directory ?? EFFORT_DIRECTORY,
      current: options.current,
      sessionless: options.sessionless ?? false,
    })
  }
  await vt.waitForRender()
  return {
    vt,
    app,
    picker,
    applied,
    closeCount: () => closeCount,
    close: () => closer(),
    hydrate: (directory, current, sessionless) => picker.setDirectory({ directory, current, sessionless: sessionless ?? false }),
  }
}

const ENTER = '\r'
const RIGHT = '\x1b[C'
const LEFT = '\x1b[D'
const DOWN = '\x1b[B'
const UP = '\x1b[A'

// ── loading + hydration ──────────────────────────────────────────────────

test('the picker opens immediately in a Loading state, before the directory settles', async () => {
  const h = await openPicker({ loading: true })
  const view = viewOf(h.vt)
  assert.ok(view.includes('Models'), `the panel must mount immediately:\n${view}`)
  assert.ok(view.includes('Loading models…'), `the loading empty state must render:\n${view}`)
  assert.equal(h.applied.length, 0)
  h.app.stop()
})

test('hydration keeps a query typed while loading, in the SAME overlay', async () => {
  const h = await openPicker({ loading: true })
  h.vt.sendInput('plain') // type while the directory is still loading
  await h.vt.waitForRender()
  h.hydrate(EFFORT_DIRECTORY, { provider: 'p1', model: 'sol' })
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(view.includes('Plain'), `the query must filter the hydrated list:\n${view}`)
  assert.ok(!view.includes('Sol'), `the query must survive hydration:\n${view}`)
  assert.ok(!view.includes('Loading models…'), 'the loading state must be replaced')
  h.app.stop()
})

test('loading: Enter and effort keys are inert (no write) and Esc closes', async () => {
  const h = await openPicker({ loading: true })
  h.vt.sendInput(ENTER)
  h.vt.sendInput(RIGHT)
  h.vt.sendInput(LEFT)
  await settle()
  assert.deepEqual(h.applied, [], 'no write may be dispatched before hydration')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.equal(h.closeCount(), 1, 'Esc closes the loading panel')
  h.vt.sendInput(ENTER)
  await settle()
  assert.deepEqual(h.applied, [], 'a closed loading panel must stay inert')
  h.app.stop()
})

test('a failed directory read becomes an in-panel error state, not a second overlay', async () => {
  const h = await openPicker({ loading: true })
  h.picker.setLoadError('connection refused')
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(view.includes('Model catalog unavailable'), `the error state must render in the same panel:\n${view}`)
  assert.ok(view.includes('connection refused'), `the failure detail must render:\n${view}`)
  h.vt.sendInput(ENTER)
  await settle()
  assert.deepEqual(h.applied, [], 'Enter on the error state must be inert')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.equal(h.closeCount(), 1)
  h.app.stop()
})

test('a settled empty catalog says No models available', async () => {
  const h = await openPicker({ loading: true })
  h.hydrate(makeDirectory({ groups: [], failures: [], default: { provider: 'p', model: 'm' } }))
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('No models available'), `empty catalog message:\n${viewOf(h.vt)}`)
  h.app.stop()
})

// ── Models view ──────────────────────────────────────────────────────────

test('opens directly on the grouped model list with no provider navigation step', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'openai', model: 'shared-id' } })
  const view = viewOf(h.vt)
  assert.ok(view.includes('OpenAI') && view.includes('Anthropic'), `both provider groups must render:\n${view}`)
  assert.ok(view.includes('Sol') && view.includes('Opus'), `models must be visible without Entering a provider:\n${view}`)
  h.app.stop()
})

test('the initial selection is the full current identity, not a same-id other provider', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'anthropic', model: 'shared-id' } })
  const selected = selectedRow(h.vt)
  assert.ok(selected?.includes('Opus'), `the Anthropic row must be selected, got: ${selected}`)
  h.app.stop()
})

test('current and default badges are independent, using the full identity', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'openai', model: 'shared-id' } })
  assert.ok(rowLine(h.vt, 'Sol')?.includes('current'), viewOf(h.vt))
  assert.ok(rowLine(h.vt, 'Pro')?.includes('default'), viewOf(h.vt))
  assert.ok(!rowLine(h.vt, 'Opus')?.includes('current'), 'the duplicate-id row must not be current')
  h.app.stop()
})

test('model description and id detail are NOT rendered, but the id stays searchable', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('gpt-5.6-sol', { name: 'Sol', description: 'a hidden reasoning model description' })] }],
    default: { provider: 'p1', model: 'gpt-5.6-sol' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'gpt-5.6-sol' } })
  const view = viewOf(h.vt)
  assert.ok(view.includes('Sol'), view)
  assert.ok(!view.includes('a hidden reasoning model description'), `the model description must be hidden:\n${view}`)
  assert.ok(!view.includes('gpt-5.6-sol'), `the model id must not render as a detail:\n${view}`)
  h.vt.sendInput('gpt-5.6-sol')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Sol'), `the id must still be searchable:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('the frame height is constant as the cursor moves across different models', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [
      model('a', { name: 'Alpha', description: 'a very long description that would otherwise wrap and grow the row significantly' }),
      model('b', { name: 'Beta', description: 'short' }),
    ] }],
    default: { provider: 'p1', model: 'a' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'a' } })
  const before = linesOf(h.vt).length
  h.vt.sendInput(DOWN)
  await h.vt.waitForRender()
  assert.equal(linesOf(h.vt).length, before, `the frame height must not change with the selection:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('search covers model name/id and provider name/id', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'openai', model: 'shared-id' } })
  h.vt.sendInput('opus')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Opus') && !viewOf(h.vt).includes('Sol'), `name search:\n${viewOf(h.vt)}`)
  for (let i = 0; i < 4; i += 1) h.vt.sendInput('\x7f')
  h.vt.sendInput('gpt-pro')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Pro') && !viewOf(h.vt).includes('Opus'), `id search:\n${viewOf(h.vt)}`)
  for (let i = 0; i < 7; i += 1) h.vt.sendInput('\x7f')
  h.vt.sendInput('anthropic')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Opus') && !viewOf(h.vt).includes('Sol'), `provider search:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('zero-result navigation is a no-op and the no-match state renders', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'openai', model: 'shared-id' } })
  h.vt.sendInput('zzzz')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('No matching models'), viewOf(h.vt))
  h.vt.sendInput(DOWN)
  h.vt.sendInput(UP)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('No matching models'))
  h.app.stop()
})

test('provider failure rows are searchable, inert and show their message on selection', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('m1', { name: 'Sol' })] }],
    failures: [{ id: 'gw', name: 'Custom Gateway', message: 'connection refused' }],
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'm1' } })
  assert.ok(viewOf(h.vt).includes('Custom Gateway'), viewOf(h.vt))
  h.vt.sendInput(DOWN)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('connection refused'), `failure detail:\n${viewOf(h.vt)}`)
  h.vt.sendInput(ENTER)
  await settle()
  assert.deepEqual(h.applied, [], 'a failure row must never submit')
  h.app.stop()
})

test('multiple provider failures collapse into one Unavailable section', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('m1', { name: 'Sol' })] }],
    failures: [
      { id: 'ga', name: 'Gateway A', message: 'a down' },
      { id: 'gb', name: 'Gateway B', message: 'b down' },
    ],
    default: { provider: 'p1', model: 'm1' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'm1' } })
  const lines = contentLinesOf(h.vt)
  assert.equal(lines.filter(line => line.includes('Unavailable · 2')).length, 1, viewOf(h.vt))
  h.app.stop()
})

// ── inline effort ────────────────────────────────────────────────────────

test('the inline effort seeds from the configured/current explicit effort', async () => {
  const h = await openPicker({
    directory: EFFORT_DIRECTORY,
    current: { provider: 'p1', model: 'sol', reasoningEffort: 'high' },
  })
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹High›'), `Sol must show the configured effort:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('a sessionless inline effort seeds from the global default, with no current badge', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('sol', { name: 'Sol', efforts: [
      { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' },
    ], defaultEffort: 'medium' })] }],
    default: { provider: 'p1', model: 'sol', reasoningEffort: 'high' },
  })
  const h = await openPicker({
    directory,
    current: { provider: 'p1', model: 'sol', reasoningEffort: 'high' },
    sessionless: true,
  })
  const sol = rowLine(h.vt, 'Sol')!
  assert.ok(!sol.includes('current'), `sessionless must not show a current badge: ${sol}`)
  assert.ok(sol.includes('effort ‹High›'), `the global default effort must seed the inline value: ${sol}`)
  h.app.stop()
})

test('a non-current model seeds its own default effort, never the Session effort', async () => {
  const h = await openPicker({
    directory: EFFORT_DIRECTORY,
    current: { provider: 'p1', model: 'plain' },
  })
  const sol = rowLine(h.vt, 'Sol')!
  assert.ok(sol.includes('effort ‹Medium›'), `Sol must use its own default (medium): ${sol}`)
  assert.ok(!sol.includes('current'), `a non-current model must not be current: ${sol}`)
  const plain = rowLine(h.vt, 'Plain')!
  assert.ok(!plain.includes('effort ‹'), `a no-effort model must not show an effort token: ${plain}`)
  h.app.stop()
})

test('a model without a concrete default shows provider default', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('nodefault', { name: 'No Default', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] })] }],
    default: { provider: 'p1', model: 'nodefault' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'nodefault' } })
  assert.ok(rowLine(h.vt, 'No Default')?.includes('effort ‹provider default›'), viewOf(h.vt))
  h.vt.sendInput(ENTER) // focus: provider default is a real candidate
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, [], 'focusing must not write')
  assert.ok(rowLine(h.vt, 'No Default')?.includes('effort [ provider default ]'), viewOf(h.vt))
  h.vt.sendInput(ENTER) // commit
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'nodefault' }], 'provider default must omit reasoningEffort')
  h.app.stop()
})

test('Enter focuses the inline effort; ←/→ cycles it and wraps', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹Medium›'), viewOf(h.vt))
  h.vt.sendInput(ENTER) // first Enter: focus the effort, NO write
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, [], 'the first Enter must not write')
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ Medium ]'), `focused token: ${viewOf(h.vt)}`)
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ High ]'), `→ High:
${viewOf(h.vt)}`)
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ XHigh ]'), `→ XHigh:
${viewOf(h.vt)}`)
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ Low ]'), `→ wraps to Low:
${viewOf(h.vt)}`)
  h.vt.sendInput(LEFT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ XHigh ]'), `← wraps back to XHigh:
${viewOf(h.vt)}`)
  h.app.stop()
})

test('the effort focus is the SAME single view; Esc backs out, a second Esc closes', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(!view.includes('Models ›'), `there must be no Efforts view header:
${view}`)
  assert.ok(view.includes('Models'), view)
  assert.equal(h.closeCount(), 0, 'no write, no close on focus')
  h.vt.sendInput('\x1b') // Esc: back to model mode
  await h.vt.waitForRender()
  assert.equal(h.closeCount(), 0, 'Esc from effort focus must not close')
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹Medium›'), `back to the inactive token:
${viewOf(h.vt)}`)
  h.vt.sendInput('\x1b') // Esc: close
  await h.vt.waitForRender()
  assert.equal(h.closeCount(), 1, 'the second Esc closes')
  h.app.stop()
})

test('per-model inline effort state is retained across model moves', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(ENTER) // focus Sol
  h.vt.sendInput(RIGHT) // medium -> high
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b') // back to model mode
  await h.vt.waitForRender()
  h.vt.sendInput(DOWN) // move to Plain
  await h.vt.waitForRender()
  h.vt.sendInput(UP) // back to Sol
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹High›'), `Sol's picker-local effort must persist:\n${viewOf(h.vt)}`)
  const plain = rowLine(h.vt, 'Plain')!
  assert.ok(!plain.includes('effort ‹'), plain)
  h.app.stop()
})

test('inline effort state uses the full (provider, model) identity', async () => {
  const directory = makeDirectory({
    groups: [
      { id: 'p1', name: 'One', models: [model('m', { name: 'P1 Model', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' })] },
      { id: 'p2', name: 'Two', models: [model('m', { name: 'P2 Model', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' })] },
    ],
    default: { provider: 'p1', model: 'm' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'm' } })
  h.vt.sendInput(ENTER) // focus p1
  h.vt.sendInput(RIGHT) // p1 -> high
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'P1 Model')?.includes('effort [ High ]'), viewOf(h.vt))
  assert.ok(rowLine(h.vt, 'P2 Model')?.includes('effort ‹Low›'), `the same-id other provider keeps its own value:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('the second Enter commits the model with its currently displayed effort', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(ENTER) // focus
  h.vt.sendInput(RIGHT) // medium -> high
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, [], 'focusing/cycling must not write')
  h.vt.sendInput(ENTER) // commit
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'sol', reasoningEffort: 'high' }])
  h.app.stop()
})

test('Enter on a no-effort model commits immediately in ONE step', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'plain' } })
  h.vt.sendInput(ENTER)
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'plain' }])
  h.app.stop()
})


// ── settlement / lifecycle ───────────────────────────────────────────────

for (const outcome of ['rejected', 'cancelled', 'unsupported'] as const) {
  test(`a ${outcome} write keeps the picker usable`, async () => {
    const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'plain' }, outcome })
    h.vt.sendInput(ENTER)
    await settle()
    await h.vt.waitForRender()
    assert.deepEqual(h.applied, [{ provider: 'p1', model: 'plain' }])
    assert.equal(h.closeCount(), 0, `a ${outcome} write must not dismiss the overlay`)
    assert.ok(!viewOf(h.vt).includes('Selecting'), `the selecting state must clear:\n${viewOf(h.vt)}`)
    h.app.stop()
  })
}

// The failure kind that arrives AFTER the `Selecting…` frame has painted must
// still repaint the list (a delayed settle must not leave Selecting… stuck).
for (const outcome of ['rejected', 'cancelled', 'unsupported'] as const) {
  test(`a delayed ${outcome} settlement repaints the list after Selecting…`, async () => {
    let resolveOutcome!: (value: ModelApplyOutcome) => void
    const deferredOutcome = new Promise<ModelApplyOutcome>((resolve) => { resolveOutcome = resolve })
    const h = await openPicker({
      directory: EIGHT_MODELS,
      current: { provider: 'p1', model: 'm0' },
      apply: () => deferredOutcome,
    })
    h.vt.sendInput(ENTER)
    await h.vt.waitForRender()
    assert.ok(viewOf(h.vt).includes('Selecting'), `Selecting must be painted first:\n${viewOf(h.vt)}`)
    resolveOutcome(outcome)
    await settle()
    await h.vt.waitForRender()
    assert.ok(!viewOf(h.vt).includes('Selecting'), `the failure must not leave Selecting… painted:\n${viewOf(h.vt)}`)
    assert.ok(viewOf(h.vt).includes('Models'), `the list must be restored:\n${viewOf(h.vt)}`)
    assert.equal(h.closeCount(), 0)
    h.app.stop()
  })
}

test('an indeterminate write dismisses the overlay', async () => {
  const h = await openPicker({ directory: EIGHT_MODELS, current: { provider: 'p1', model: 'm0' }, outcome: 'indeterminate' })
  h.vt.sendInput(ENTER)
  await settle()
  await h.vt.waitForRender()
  assert.equal(h.closeCount(), 1)
  h.app.stop()
})

test('a superseded write makes no close/open decision and repaints nothing', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'plain' }, outcome: 'superseded' })
  h.vt.sendInput(ENTER)
  await settle()
  await h.vt.waitForRender()
  assert.equal(h.closeCount(), 0)
  assert.ok(viewOf(h.vt).includes('Selecting'), `a superseded op must not repaint:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('a second Enter while selecting does not dispatch a duplicate write', async () => {
  let resolveOutcome!: (outcome: ModelApplyOutcome) => void
  const deferredOutcome = new Promise<ModelApplyOutcome>((resolve) => { resolveOutcome = resolve })
  const h = await openPicker({ directory: EIGHT_MODELS, current: { provider: 'p1', model: 'm0' }, apply: () => deferredOutcome })
  h.vt.sendInput(ENTER)
  await settle()
  h.vt.sendInput(ENTER)
  await settle()
  assert.equal(h.applied.length, 1)
  resolveOutcome('committed')
  await settle()
  h.app.stop()
})

test('externally disposing the picker fences a late settlement from acting', async () => {
  let resolveOutcome!: (outcome: ModelApplyOutcome) => void
  const deferredOutcome = new Promise<ModelApplyOutcome>((resolve) => { resolveOutcome = resolve })
  const h = await openPicker({ directory: EIGHT_MODELS, current: { provider: 'p1', model: 'm0' }, apply: () => deferredOutcome })
  h.vt.sendInput(ENTER)
  await settle()
  h.picker.dispose()
  resolveOutcome('committed')
  await settle()
  assert.equal(h.closeCount(), 0, 'teardown is not a user choice')
  h.app.stop()
})

test('a late hydration on a disposed picker is a no-op', async () => {
  const h = await openPicker({ loading: true })
  h.picker.dispose()
  h.hydrate(EFFORT_DIRECTORY, { provider: 'p1', model: 'sol' })
  await h.vt.waitForRender()
  assert.ok(!viewOf(h.vt).includes('Sol'), `a disposed picker must not hydrate:\n${viewOf(h.vt)}`)
  h.app.stop()
})

// ── budget / mouse / overlay lifecycle ───────────────────────────────────

test('the picker reflows to a short terminal without losing the selected model', async () => {
  const h = await openPicker({ directory: EIGHT_MODELS, current: { provider: 'p1', model: 'm7' } })
  h.vt.resize(80, 8)
  await settle()
  await h.vt.waitForRender()
  const lines = linesOf(h.vt)
  assert.ok(lines.length <= 8, `frame must fit the terminal, got ${lines.length}`)
  assert.ok(lines.some(line => line.includes('Model 7')), `selected model must stay visible:\n${viewOf(h.vt)}`)
  h.app.stop()
})

function mouse(type: 'press' | 'click', x: number, y: number, width = 80, height = 24): import('@xmoon76/pi-tui').TuiMouseEvent {
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

test('a mouse click submits the model with its inline effort (mouse parity)', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.picker.render(72)
  const row = h.picker.render(72).map(stripAnsi).findIndex(line => line.includes('Plain'))
  assert.ok(row >= 0)
  h.picker.handleMouse(mouse('press', 5, row, 72, 24))
  h.picker.handleMouse(mouse('click', 5, row, 72, 24))
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'plain' }])
  h.app.stop()
})

test('an approval over the picker restores the picker and its physical focus', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput('sol')
  await h.vt.waitForRender()
  void h.app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Approve bash?'), viewOf(h.vt))
  h.vt.sendInput('y')
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Models'), `the picker must be restored:\n${viewOf(h.vt)}`)
  assert.notEqual(h.app.focusedComponentForTest(), h.app.seatEditorForTest().component,
    'the restored picker must hold PHYSICAL focus')
  h.app.stop()
})

test('a Save Location prompt suspends the picker and restores it on settle', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  const pending = h.app.askSaveLocation(
    { title: 'Save session archive', filename: 'archive.tar', initialDirectory: './' },
    { resolveDirectory: input => input, isDirectory: () => true, targetExists: () => false, complete: async () => [] },
  )
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Save session archive'), viewOf(h.vt))
  assert.ok(!viewOf(h.vt).includes('Models'), `the picker must be suspended:\n${viewOf(h.vt)}`)
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  await settle()
  assert.deepEqual(await pending, { kind: 'cancelled' })
  assert.ok(viewOf(h.vt).includes('Models'), `the picker must be restored:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('a fullscreen swap remounts the SAME picker with its query and inline effort intact', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' }, fullscreen: true })
  h.vt.sendInput('sol') // filter the list to Sol
  await h.vt.waitForRender()
  h.vt.sendInput(ENTER) // focus Sol's effort
  h.vt.sendInput(RIGHT) // medium -> high
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b') // back to model mode
  await h.vt.waitForRender()
  assert.ok(!viewOf(h.vt).includes('Plain'), `the query must filter before the swap:\n${viewOf(h.vt)}`)
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
  await settle()
  const view = viewOf(h.vt)
  assert.ok(view.includes('Models'), `the picker must survive the swap:\n${view}`)
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹High›'), `the inline effort must survive:\n${view}`)
  assert.ok(!view.includes('Plain'), `the query must survive the swap:\n${view}`)
  assert.notEqual(h.app.focusedComponentForTest(), h.app.seatEditorForTest().component,
    'the remounted picker must hold PHYSICAL focus')
  h.app.stop()
})

test('a query typed while loading survives a fullscreen migration and hydration', async () => {
  const h = await openPicker({ loading: true, fullscreen: true })
  h.vt.sendInput('plain') // type while the directory is still loading
  await h.vt.waitForRender()
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
  await settle()
  h.hydrate(EFFORT_DIRECTORY, { provider: 'p1', model: 'sol' })
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(view.includes('Plain'), `the loading query must survive migration + hydration:\n${view}`)
  assert.ok(!view.includes('Sol'), `the migrated query must still filter:\n${view}`)
  h.app.stop()
})

test('a fullscreen swap while LOADING hydrates the migrated picker in place', async () => {
  const h = await openPicker({ loading: true, fullscreen: true })
  assert.ok(viewOf(h.vt).includes('Loading models…'), viewOf(h.vt))
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
  await settle()
  h.hydrate(EFFORT_DIRECTORY, { provider: 'p1', model: 'sol' })
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Sol'), `the migrated picker must hydrate:\n${viewOf(h.vt)}`)
  assert.ok(!viewOf(h.vt).includes('Loading models…'), viewOf(h.vt))
  h.app.stop()
})

test('mounting a new picker supersedes the previous one (no lingering overlay)', async () => {
  const h = await openPicker({ loading: true })
  const second = new ModelPicker({
    apply: () => 'committed',
    requestRender: () => h.app.requestRender(),
    close: () => {},
    runOwned: <T>(_label: string, task: () => T | Promise<T>, _options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>) => { void task() },
  })
  h.app.openModelPicker(second)
  second.setDirectory({ directory: TWO_PROVIDERS, current: { provider: 'openai', model: 'shared-id' }, sessionless: false })
  await h.vt.waitForRender()
  assert.equal(h.picker.isDisposed(), true, 'the previous picker must be disposed on supersession')
  assert.ok(viewOf(h.vt).includes('Sol'), `the new picker must own the surface:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('a hidden model description is NOT searchable', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('a', { name: 'Alpha', description: 'zebra-unique-token' }), model('b', { name: 'Beta' })] }],
    default: { provider: 'p1', model: 'a' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'a' } })
  h.vt.sendInput('zebra-unique-token')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('No matching models'),
    `a hidden description must not be searchable:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('an approval over a LOADING picker hydrates and restores it', async () => {
  const h = await openPicker({ loading: true })
  void h.app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Approve bash?'), viewOf(h.vt))
  assert.ok(!viewOf(h.vt).includes('Models'), `the loading picker must be suspended:\n${viewOf(h.vt)}`)
  // The directory settles WHILE the approval covers the picker.
  h.hydrate(EFFORT_DIRECTORY, { provider: 'p1', model: 'sol' })
  h.vt.sendInput('y') // settle the approval
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Sol'), `the restored picker must show the loaded models:\n${viewOf(h.vt)}`)
  assert.ok(!viewOf(h.vt).includes('Loading models…'), viewOf(h.vt))
  h.app.stop()
})

test('loading: Enter and effort keys are inert (there is no effort to focus)', async () => {
  const h = await openPicker({ loading: true })
  h.vt.sendInput(ENTER)
  h.vt.sendInput(RIGHT)
  h.vt.sendInput(LEFT)
  await settle()
  assert.deepEqual(h.applied, [], 'a loading picker must not write')
  assert.ok(viewOf(h.vt).includes('Loading models…'), viewOf(h.vt))
  h.app.stop()
})

test('plain Left/Right move the search cursor (loaded)', async () => {
  // §5: the picker must not steal the text-cursor keys from the Input.
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput('abcd')
  await h.vt.waitForRender()
  h.vt.sendInput(LEFT)
  h.vt.sendInput(LEFT)
  h.vt.sendInput('X')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('abXcd'), `Left must move the search cursor:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('plain Left/Right never change the effort', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹Medium›'), viewOf(h.vt))
  h.vt.sendInput(RIGHT)
  h.vt.sendInput(LEFT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹Medium›'), `Left/Right must not change the effort:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('plain Left/Right move the search cursor while loading', async () => {
  const h = await openPicker({ loading: true })
  h.vt.sendInput('abcd')
  await h.vt.waitForRender()
  h.vt.sendInput(LEFT)
  h.vt.sendInput(LEFT)
  h.vt.sendInput('X')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('abXcd'), `Left must edit while loading too:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('a delayed thrown write repaints the list after Selecting…', async () => {
  let rejectOutcome!: (error: unknown) => void
  const deferredOutcome = new Promise<ModelApplyOutcome>((_resolve, reject) => { rejectOutcome = reject })
  const h = await openPicker({
    directory: EIGHT_MODELS,
    current: { provider: 'p1', model: 'm0' },
    apply: () => deferredOutcome,
  })
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Selecting'), `Selecting must be painted first:\n${viewOf(h.vt)}`)
  rejectOutcome(new Error('transport exploded'))
  await settle()
  await h.vt.waitForRender()
  assert.ok(!viewOf(h.vt).includes('Selecting'), `the error must clear Selecting…:\n${viewOf(h.vt)}`)
  assert.ok(viewOf(h.vt).includes('Models'), `the list must be restored:\n${viewOf(h.vt)}`)
  h.app.stop()
})

// ── preserved mouse stale-geometry + tiny-grant contracts (round-1 → round-2)

test('an 80x6 terminal still shows the selected model primary row and its arrow', async () => {
  const h = await openPicker({ directory: EIGHT_MODELS, current: { provider: 'p1', model: 'm0' } })
  h.vt.resize(80, 6)
  await settle()
  await h.vt.waitForRender()
  assert.ok(linesOf(h.vt).length <= 6, `frame must fit the terminal:\n${viewOf(h.vt)}`)
  assert.ok(contentLinesOf(h.vt).some(line => line.startsWith('→ ') && line.includes('Model 0')),
    `the selected primary row/arrow must survive the tiny grant:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('a mouse click before the post-resize repaint is rejected by the geometry fence', async () => {
  const h = await openPicker({ directory: EIGHT_MODELS, current: { provider: 'p1', model: 'm0' }, fullscreen: true })
  const row = linesOf(h.vt).findIndex(line => line.includes('Model 3'))
  assert.ok(row >= 0, `Model 3 must be painted before the resize:\n${viewOf(h.vt)}`)
  h.vt.resize(60, 24)
  // Send the press+click IMMEDIATELY (no waitForRender): the frame geometry
  // changed since the last paint, so the stale hit map must reject it.
  h.vt.sendInput(`\x1b[<0;5;${row + 1}M`)
  h.vt.sendInput(`\x1b[<0;5;${row + 1}m`)
  await settle()
  assert.deepEqual(h.applied, [], `a stale-geometry click must be rejected:\n${viewOf(h.vt)}`)
  await h.vt.waitForRender()
  const repaintedRow = linesOf(h.vt).findIndex(line => line.includes('Model 3'))
  assert.ok(repaintedRow >= 0)
  h.vt.sendInput(`\x1b[<0;5;${repaintedRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;5;${repaintedRow + 1}m`)
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'm3' }],
    `a fresh post-resize click must apply:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('a resize that does not change the clamped overlay geometry still fences stale mouse', async () => {
  // 80 -> 90 keeps the /model overlay clamped at width 72 / maxHeight 24, so
  // only the raw terminal dimensions distinguish the geometry.
  const h = await openPicker({ directory: EIGHT_MODELS, current: { provider: 'p1', model: 'm0' }, fullscreen: true })
  const row = linesOf(h.vt).findIndex(line => line.includes('Model 3'))
  assert.ok(row >= 0)
  h.vt.resize(90, 24)
  h.vt.sendInput(`\x1b[<0;20;${row + 1}M`)
  h.vt.sendInput(`\x1b[<0;20;${row + 1}m`)
  await settle()
  assert.deepEqual(h.applied, [], `a capped-geometry stale click must be rejected:\n${viewOf(h.vt)}`)
  await h.vt.waitForRender()
  const repaintedRow = linesOf(h.vt).findIndex(line => line.includes('Model 3'))
  assert.ok(repaintedRow >= 0)
  h.vt.sendInput(`\x1b[<0;20;${repaintedRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;20;${repaintedRow + 1}m`)
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'm3' }],
    `a fresh click after the capped resize must apply:\n${viewOf(h.vt)}`)
  h.app.stop()
})

// ── preserved presentation/coverage contracts (round-1 → round-2) ────────

test('an unlisted current model selects nothing wrongly and never fakes a catalog row', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'ghost', model: 'shared-id' } })
  assert.ok(!viewOf(h.vt).includes('ghost'), `no fabricated current row:\n${viewOf(h.vt)}`)
  const selected = selectedRow(h.vt)
  assert.ok(selected?.includes('Sol'), `the first catalog row wins: ${selected}`)
  assert.ok(!selected!.includes('current'), 'an unmatched current must not badge a catalog row as current')
  h.app.stop()
})

test('clearing the query restores the full list', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'openai', model: 'shared-id' } })
  h.vt.sendInput('opus')
  await h.vt.waitForRender()
  assert.ok(!viewOf(h.vt).includes('Sol'))
  for (let i = 0; i < 4; i += 1) h.vt.sendInput('\x7f')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Sol') && viewOf(h.vt).includes('Opus'), `clear must restore:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('search matches a provider display name and a provider id independently', async () => {
  const directory = makeDirectory({
    groups: [
      { id: 'gw-42', name: 'Custom Gateway', models: [model('m1', { name: 'Sol' })] },
      { id: 'anthropic', name: 'Anthropic', models: [model('m2', { name: 'Opus' })] },
    ],
    default: { provider: 'gw-42', model: 'm1' },
  })
  const h = await openPicker({ directory, current: { provider: 'gw-42', model: 'm1' } })
  h.vt.sendInput('custom') // display name only (the id is `gw-42`)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Sol') && !viewOf(h.vt).includes('Opus'), `display-name search:\n${viewOf(h.vt)}`)
  for (let i = 0; i < 6; i += 1) h.vt.sendInput('\x7f')
  h.vt.sendInput('gw-42') // provider id only (the name is `Custom Gateway`)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Sol') && !viewOf(h.vt).includes('Opus'), `provider-id search:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('a current model that is also the default composes current · default · effort', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('sol', { name: 'Sol', efforts: [
      { id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }, { id: 'high', name: 'High' },
    ], defaultEffort: 'medium' })] }],
    default: { provider: 'p1', model: 'sol' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'sol', reasoningEffort: 'medium' } })
  assert.ok(rowLine(h.vt, 'Sol')?.includes('current · default · effort ‹Medium›'),
    `the factual badges and the inline effort must compose:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('a click on a failure diagnostic detail row is inert', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('m1', { name: 'Sol' })] }],
    failures: [{ id: 'gw', name: 'Custom Gateway', message: 'connection refused' }],
    default: { provider: 'p1', model: 'm1' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'm1' } })
  h.vt.sendInput(DOWN) // highlight the failure row so its diagnostic detail expands
  await h.vt.waitForRender()
  const rendered = h.picker.render(72).map(stripAnsi)
  const detail = rendered.findIndex(line => line.includes('connection refused'))
  assert.ok(detail >= 0, `failure detail missing:\n${rendered.join('\n')}`)
  assert.equal(h.picker.handleMouse(mouse('press', 5, detail, 72, 24)), undefined,
    'a press on the inert failure detail row must be rejected')
  h.app.stop()
})

test('focus reaches the active search Input (CURSOR_MARKER)', async () => {
  const { CURSOR_MARKER } = await import('@xmoon76/pi-tui')
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.picker.focused = true
  assert.ok(h.picker.render(72).join('\n').includes(CURSOR_MARKER),
    'the focused picker must emit the hardware cursor marker')
  h.app.stop()
})

// ── restored baseline lifecycle/identity regressions (§38) ───────────────

test('closing the picker while suspended does not resurrect it when the prompt settles', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  const pending = h.app.askSaveLocation(
    { title: 'Save session archive', filename: 'archive.tar', initialDirectory: './' },
    { resolveDirectory: input => input, isDirectory: () => true, targetExists: () => false, complete: async () => [] },
  )
  await h.vt.waitForRender()
  await settle()
  assert.ok(!viewOf(h.vt).includes('Models'), `the picker must be suspended:\n${viewOf(h.vt)}`)
  h.close() // programmatic close of the suspended overlay
  h.vt.sendInput('\x1b') // cancel the save-location prompt
  await h.vt.waitForRender()
  await settle()
  assert.deepEqual(await pending, { kind: 'cancelled' })
  assert.ok(!viewOf(h.vt).includes('Models'), `a closed picker must not be resurrected:\n${viewOf(h.vt)}`)
  assert.equal(h.closeCount(), 0, 'the programmatic app-level close is not the picker user-close path')
  h.app.stop()
})

test('an approval over the picker survives fullscreen migration in the same stack order', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' }, fullscreen: true })
  h.vt.sendInput('sol')
  await h.vt.waitForRender()
  void h.app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Approve bash?'), `approval must be visible:\n${viewOf(h.vt)}`)
  assert.ok(!viewOf(h.vt).includes('Models'), `the picker must be suspended beneath:\n${viewOf(h.vt)}`)
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Approve bash?'), `the approval must survive the swap:\n${viewOf(h.vt)}`)
  assert.ok(!viewOf(h.vt).includes('Models'), `the picker must stay suspended after the swap:\n${viewOf(h.vt)}`)
  h.vt.sendInput('y') // settle the approval
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Models'), `the migrated picker must be restored:\n${viewOf(h.vt)}`)
  assert.ok(!viewOf(h.vt).includes('Approve bash?'), 'the approval must be gone')
  h.app.stop()
})

test('the migratable picker is disposed exactly once on close', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'openai', model: 'shared-id' }, fullscreen: true })
  let disposals = 0
  const original = h.picker.dispose.bind(h.picker)
  h.picker.dispose = () => { disposals += 1; original() }
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
  await settle()
  assert.equal(disposals, 0, 'a screen swap must not dispose the retained picker')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.equal(disposals, 1, 'the final close disposes exactly once')
  h.app.stop()
})

test('providers sharing a display name keep separate sections, and a provider named Unavailable is isolated', async () => {
  const directory = makeDirectory({
    groups: [
      { id: 'p1', name: 'Same', models: [model('m', { name: 'One' })] },
      { id: 'p2', name: 'Same', models: [model('m', { name: 'Two' })] },
      { id: 'p3', name: 'Unavailable', models: [model('x', { name: 'Real' })] },
    ],
    failures: [{ id: 'gw', name: 'Unavailable', message: 'connection refused' }],
    default: { provider: 'p1', model: 'm' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'm' } })
  const lines = contentLinesOf(h.vt)
  assert.equal(lines.filter(line => line.includes('Same · 1')).length, 2,
    `two providers named "Same" must keep two sections:\n${viewOf(h.vt)}`)
  assert.equal(lines.filter(line => line.includes('Unavailable · 1')).length, 2,
    `a provider named "Unavailable" must not merge with the failure section:\n${viewOf(h.vt)}`)
  assert.ok(lines.some(line => line.includes('One')) && lines.some(line => line.includes('Two')),
    `both same-name providers' models must render:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('a no-effort model has no effort focus and commits in one Enter', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(DOWN) // move to Plain (no reasoning metadata)
  await h.vt.waitForRender()
  assert.ok(!rowLine(h.vt, 'Plain')?.includes('effort ‹'), `Plain starts effort-free:\n${viewOf(h.vt)}`)
  h.vt.sendInput(RIGHT)
  h.vt.sendInput(LEFT)
  await h.vt.waitForRender()
  assert.ok(!rowLine(h.vt, 'Plain')?.includes('effort ‹'),
    `←/→ must not invent an effort token on a no-effort model:\n${viewOf(h.vt)}`)
  h.vt.sendInput(ENTER)
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'plain' }], 'one Enter commits, omitting reasoningEffort')
  h.app.stop()
})

// ── round-3: narrow layout / wrap / effort name / width safety ────────────

const LAYOUT_DIRECTORY = makeDirectory({
  groups: [{
    id: 'p1',
    name: 'OpenAI',
    models: [
      model('sol', { name: 'GPT-5.6 Sol', efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }),
      model('plain', { name: 'Plain Model' }),
    ],
  }],
  default: { provider: 'p1', model: 'sol' },
})

const renderAt = (h: Harness, width: number): string[] => h.picker.render(width).map(stripAnsi)

test('a normal-width badge row stays on one line', async () => {
  const h = await openPicker({ directory: LAYOUT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  const lines = renderAt(h, 72)
  assert.ok(lines.some(line => line.includes('GPT-5.6 Sol') && line.includes('current · default · effort ‹High›')),
    `must stay single-line at 72:\n${lines.join('\n')}`)
  h.app.stop()
})

test('the badge wraps exactly when label + badge no longer fit (no width threshold)', async () => {
  const h = await openPicker({ directory: LAYOUT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  const badge = 'current · default · effort ‹High›'
  // The wrap is measured from the WIDEST form (the active `[ High ]`), so the
  // single/two-line boundary is that width, not the inactive rendering.
  const measure = 'current · default · effort [ High ]'
  const exact = 2 + visibleWidth('GPT-5.6 Sol') + 2 + visibleWidth(measure)
  const fits = renderAt(h, exact)
  assert.ok(fits.some(line => line.includes('GPT-5.6 Sol') && line.includes(badge)),
    `width ${exact} must be single-line:\n${fits.join('\n')}`)
  const wrapped = renderAt(h, exact - 1)
  assert.ok(wrapped.some(line => line.includes('GPT-5.6 Sol')), `identity must survive:\n${wrapped.join('\n')}`)
  assert.ok(!wrapped.some(line => line.includes('GPT-5.6 Sol') && line.includes('current')),
    `width ${exact - 1} must wrap the badge:\n${wrapped.join('\n')}`)
  assert.ok(wrapped.some(line => line.includes('current')), `the badge must still render:\n${wrapped.join('\n')}`)
  h.app.stop()
})

test('an ultra-narrow row keeps the model identity before the badge', async () => {
  const h = await openPicker({ directory: LAYOUT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  const lines = renderAt(h, 26)
  assert.ok(lines.some(line => line.includes('GPT-5.6 Sol')), `identity must never disappear:\n${lines.join('\n')}`)
  // §15: at ultra-narrow width the factual prefixes may be dropped, but the
  // effort token (the value being chosen) must survive.
  assert.ok(lines.some(line => line.includes('‹High›')), `the effort token must survive:\n${lines.join('\n')}`)
  assert.ok(!lines.some(line => line.includes('GPT-5.6 Sol') && line.includes('‹High›')),
    `identity and badge must not share the truncated row:\n${lines.join('\n')}`)
  h.app.stop()
})

test('a row without a badge stays on one line even when narrow', async () => {
  const h = await openPicker({ directory: LAYOUT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  const lines = renderAt(h, 26)
  const plain = lines.findIndex(line => line.includes('Plain Model'))
  assert.ok(plain >= 0, lines.join('\n'))
  assert.ok(!(lines[plain + 1] ?? '').includes('effort'), `no phantom badge row:\n${lines.join('\n')}`)
  h.app.stop()
})

test('effort cycling never toggles a row between one and two lines', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('sol', { name: 'Sol', efforts: [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'Extraordinarily Long Effort Name' },
    ], defaultEffort: 'a' })] }],
    default: { provider: 'p1', model: 'sol' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'sol', reasoningEffort: 'a' } })
  // The SHORT badge would fit here, but the LONGEST candidate does not, so the
  // stable measurement must wrap from the start.
  const short = 'current · default · effort ‹A›'
  const width = 2 + visibleWidth('Sol') + 2 + visibleWidth(short)
  const before = renderAt(h, width)
  assert.ok(!before.some(line => line.includes('Sol') && line.includes('effort ‹A›')),
    `the wrap must be decided by the widest candidate:\n${before.join('\n')}`)
  const heightBefore = before.length
  h.vt.sendInput(ENTER) // focus the effort, then cycle to the long label
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  const after = renderAt(h, width)
  assert.equal(after.length, heightBefore, `cycling must not change the frame height:\n${after.join('\n')}`)
  assert.ok(after.some(line => line.includes('Sol')), after.join('\n'))
  h.app.stop()
})

test('a narrow wrapped row still renders under an active search', async () => {
  const h = await openPicker({ directory: LAYOUT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput('sol')
  await h.vt.waitForRender()
  const lines = renderAt(h, 26)
  assert.ok(lines.some(line => line.includes('GPT-5.6 Sol')), lines.join('\n'))
  assert.ok(!lines.some(line => line.includes('Plain')), lines.join('\n'))
  h.app.stop()
})

test('Enter focuses the effort even with an active query, and the query survives', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput('sol')
  await h.vt.waitForRender()
  h.vt.sendInput(ENTER)
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ High ]'), viewOf(h.vt))
  assert.ok(viewOf(h.vt).includes('> sol'), `the query must not change:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('the effort row shows the human name while the payload carries the protocol id', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('m', { name: 'Zed', efforts: [
      { id: 'xhigh', name: 'Extra High' },
    ], defaultEffort: 'xhigh' })] }],
    default: { provider: 'p1', model: 'm' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'm' } })
  assert.ok(rowLine(h.vt, 'Zed')?.includes('effort ‹Extra High›'), viewOf(h.vt))
  assert.ok(!rowLine(h.vt, 'Zed')?.includes('effort ‹xhigh›'), `the protocol id must not render:\n${viewOf(h.vt)}`)
  h.vt.sendInput(ENTER) // focus
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Zed')?.includes('effort [ Extra High ]'), `active token:\n${viewOf(h.vt)}`)
  assert.deepEqual(h.applied, [], 'focusing must not write')
  h.vt.sendInput(ENTER) // commit
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'm', reasoningEffort: 'xhigh' }])
  h.app.stop()
})

test('provider default cycles to the first and last advertised effort', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('m', { name: 'Zed', efforts: [
      { id: 'low', name: 'Low' },
      { id: 'high', name: 'High' },
    ] })] }],
    default: { provider: 'p1', model: 'm' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'm' } })
  assert.ok(rowLine(h.vt, 'Zed')?.includes('effort ‹provider default›'), viewOf(h.vt))
  h.vt.sendInput(ENTER) // focus
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Zed')?.includes('effort [ provider default ]'), viewOf(h.vt))
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Zed')?.includes('effort [ Low ]'), `→ first effort:\n${viewOf(h.vt)}`)
  h.vt.sendInput(LEFT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Zed')?.includes('effort [ provider default ]'), `← provider default:\n${viewOf(h.vt)}`)
  h.vt.sendInput(LEFT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Zed')?.includes('effort [ High ]'), `← wraps to the last effort:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('Enter is inert on a zero-result list', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput('zzzz')
  await h.vt.waitForRender()
  h.vt.sendInput(ENTER)
  h.vt.sendInput(RIGHT)
  h.vt.sendInput(LEFT)
  await settle()
  assert.deepEqual(h.applied, [])
  assert.ok(viewOf(h.vt).includes('No matching models'), viewOf(h.vt))
  h.app.stop()
})

test('Enter is inert on a failure row', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('m', { name: 'Sol' })] }],
    failures: [{ id: 'gw', name: 'Custom Gateway', message: 'refused' }],
    default: { provider: 'p1', model: 'm' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'm' } })
  h.vt.sendInput(DOWN)
  await h.vt.waitForRender()
  h.vt.sendInput(ENTER)
  h.vt.sendInput(RIGHT)
  h.vt.sendInput(LEFT)
  await settle()
  assert.deepEqual(h.applied, [])
  assert.ok(viewOf(h.vt).includes('Custom Gateway'), viewOf(h.vt))
  h.app.stop()
})

test('a wrapped badge row is mouse-inert while the model row focuses the effort', async () => {
  const h = await openPicker({ directory: LAYOUT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  const lines = renderAt(h, 26)
  const modelRow = lines.findIndex(line => line.includes('GPT-5.6 Sol'))
  const badgeRow = lines.findIndex(line => line.includes('‹High›') && !line.includes('GPT-5.6 Sol'))
  assert.ok(modelRow >= 0 && badgeRow >= 0, lines.join('\n'))
  assert.equal(h.picker.handleMouse(mouse('press', 3, badgeRow, 26, 24)), undefined,
    'a press on the inert wrapped badge row must be rejected')
  h.picker.render(26)
  h.picker.handleMouse(mouse('press', 3, modelRow, 26, 24))
  h.picker.handleMouse(mouse('click', 3, modelRow, 26, 24))
  await settle()
  assert.deepEqual(h.applied, [], 'a reasoning-model click focuses the effort, it does not commit')
  assert.ok(renderAt(h, 60).some(line => line.includes('effort [ High ]')), 'the click must focus the effort')
  h.vt.sendInput(ENTER)
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'sol', reasoningEffort: 'high' }])
  h.app.stop()
})

test('a long catalog error is clipped to the panel width', async () => {
  const h = await openPicker({ loading: true })
  h.picker.setLoadError('WebSocket closed unexpectedly because the remote host went away and the retry budget was exhausted')
  await h.vt.waitForRender()
  const lines = renderAt(h, 30)
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 30, `over-wide line: ${JSON.stringify(line)} (${visibleWidth(line)})`)
  }
  assert.ok(lines.some(line => line.includes('Model catalog unavailable')), lines.join('\n'))
  h.app.stop()
})

test('a wide-to-narrow wrap transition fences the stale single-line hit map', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [
      model('sol', { name: 'GPT-5.6 Sol Long Name', efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }),
      model('m2', { name: 'Second' }),
    ] }],
    default: { provider: 'p1', model: 'sol' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'sol' }, fullscreen: true })
  const wideRow = linesOf(h.vt).findIndex(line => line.includes('Second'))
  assert.ok(wideRow >= 0, viewOf(h.vt))
  h.vt.resize(50, 24)
  // BEFORE the repaint: the stale single-line geometry must reject the click
  // (the row above now wraps onto two physical lines).
  h.vt.sendInput(`\x1b[<0;20;${wideRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;20;${wideRow + 1}m`)
  await settle()
  assert.deepEqual(h.applied, [], `a stale wrap-transition click must be rejected:\n${viewOf(h.vt)}`)
  await h.vt.waitForRender()
  const narrowRow = linesOf(h.vt).findIndex(line => line.includes('Second'))
  assert.ok(narrowRow >= 0, viewOf(h.vt))
  h.vt.sendInput(`\x1b[<0;20;${narrowRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;20;${narrowRow + 1}m`)
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'm2' }], `a fresh click must apply:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('the badge is right-aligned against the row edge', async () => {
  const h = await openPicker({ directory: LAYOUT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  const wide = renderAt(h, 72)
    .find(line => line.includes('GPT-5.6 Sol'))!
  assert.equal(visibleWidth(wide), 72, `a single-line badge row must sit flush right:\n${wide}`)
  assert.ok(wide.trimEnd().endsWith('›'), `the badge must be the last thing on the row:\n${wide}`)
  const narrow = renderAt(h, 34)
    .find(line => line.includes('current'))!
  assert.equal(visibleWidth(narrow), 34, `the wrapped badge line must sit flush right:\n${narrow}`)
  h.app.stop()
})

test('a narrow-to-wide unwrap transition fences the stale two-line hit map', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [
      model('sol', { name: 'GPT-5.6 Sol Long Name', efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }),
      model('m2', { name: 'Second' }),
    ] }],
    default: { provider: 'p1', model: 'sol' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'sol' }, fullscreen: true })
  // Narrow first: the long-named model wraps onto two lines.
  h.vt.resize(50, 24)
  await h.vt.waitForRender()
  await settle()
  assert.ok(linesOf(h.vt).some(line => line.includes('Second')), viewOf(h.vt))
  const narrowRow = linesOf(h.vt).findIndex(line => line.includes('Second'))
  // Back to wide: the row above loses its wrapped line, so the stale two-line
  // geometry must not resolve the click (the frame's last-painted map is still
  // the narrow one until the resize repaint lands).
  h.vt.resize(80, 24)
  h.vt.sendInput(`\x1b[<0;5;${narrowRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;5;${narrowRow + 1}m`)
  await settle()
  assert.deepEqual(h.applied, [], `a stale unwrap-transition click must be rejected:\n${viewOf(h.vt)}`)
  await h.vt.waitForRender()
  // The widened row renders on one line again...
  const wide = renderAt(h, 72)
  const modelLine = wide.findIndex(line => line.includes('GPT-5.6 Sol Long Name'))
  assert.ok(modelLine >= 0, wide.join('\n'))
  assert.ok(wide[modelLine]!.includes('effort ‹High›'), `single line restored:\n${wide.join('\n')}`)
  // ...and the FRESH geometry (not the stale two-line one) resolves the click.
  const second = wide.findIndex(line => line.includes('Second'))
  assert.ok(second >= 0, wide.join('\n'))
  h.picker.render(72)
  h.picker.handleMouse(mouse('press', 3, second, 72, 24))
  h.picker.handleMouse(mouse('click', 3, second, 72, 24))
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'm2' }], `a fresh wide click must apply:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('mixed wrapped/unwrapped rows keep a stable height as the cursor moves', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [
      model('a', { name: 'A Long Wrapping Model Name', efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }),
      model('b', { name: 'Plain' }),
      model('c', { name: 'Another Long Wrapping Name', efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' }),
    ] }],
    default: { provider: 'p1', model: 'a' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'a' } })
  const width = 34
  const before = renderAt(h, width)
  const heightBefore = before.length
  assert.ok(before.some(line => line.includes('Plain')), before.join('\n'))
  h.vt.sendInput(DOWN) // wrapped -> plain
  await h.vt.waitForRender()
  const mid = renderAt(h, width)
  assert.equal(mid.length, heightBefore, `selection move must not change the height:\n${mid.join('\n')}`)
  h.vt.sendInput(DOWN) // plain -> wrapped
  await h.vt.waitForRender()
  const after = renderAt(h, width)
  assert.equal(after.length, heightBefore, `selection move must not change the height:\n${after.join('\n')}`)
  assert.ok(after.some(line => line.startsWith('→ ') && line.includes('Another Long')),
    `the selected identity must stay visible:\n${after.join('\n')}`)
  h.app.stop()
})

test('a wrapped badge under a tight row grant stays in budget and keeps the selected identity', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [
      model('a', { name: 'A Long Wrapping Model Name', efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }),
      model('b', { name: 'Second Long Wrapping Name', efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' }),
    ] }],
    default: { provider: 'p1', model: 'a' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'a' } })
  const width = 30
  const grant = 8
  h.picker.setMaxRows(grant)
  const lines = renderAt(h, width)
  assert.ok(lines.length <= grant, `render must respect the grant ${grant}:\n${lines.join('\n')}`)
  assert.ok(lines.some(line => line.startsWith('→ ') && line.includes('A Long')),
    `the selected primary identity must survive:\n${lines.join('\n')}`)
  const badgeRow = lines.findIndex(line => line.includes('effort') && !line.startsWith('→ '))
  if (badgeRow >= 0) {
    assert.equal(h.picker.handleMouse(mouse('press', 3, badgeRow, width, 24)), undefined,
      'a wrapped badge row must stay inert under the tight grant')
  }
  h.app.stop()
})

test('effort edit mode consumes ↑/↓ and printable keys (no model move, no query/effort change)', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  assert.ok(rowLine(h.vt, 'Plain') !== undefined, `Plain must be a neighbour model:\n${viewOf(h.vt)}`)
  h.vt.sendInput(ENTER) // focus the inline effort
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ Medium ]'), viewOf(h.vt))
  const searchBefore = contentLinesOf(h.vt).find(line => line.trimStart().startsWith('>'))!
  h.vt.sendInput(DOWN) // would move Sol -> Plain in model mode
  h.vt.sendInput(UP)
  h.vt.sendInput('x')
  h.vt.sendInput('9')
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ Medium ]'), `the effort must not change:\n${view}`)
  assert.ok(!contentLinesOf(h.vt).some(line => line.startsWith('→ ') && line.includes('Plain')),
    `↑/↓ must not move the selected model:\n${view}`)
  const searchAfter = contentLinesOf(h.vt).find(line => line.trimStart().startsWith('>'))!
  assert.equal(searchAfter, searchBefore, `printable keys must not edit the query:\n${view}`)
  assert.deepEqual(h.applied, [], 'no write')
  h.app.stop()
})

test('entering and leaving effort edit preserves the query and the selected model', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput('so') // a query that keeps Sol in the filtered list
  await h.vt.waitForRender()
  const searchBefore = contentLinesOf(h.vt).find(line => line.trimStart().startsWith('>'))!
  h.vt.sendInput(ENTER) // focus the effort
  h.vt.sendInput(RIGHT) // medium -> high
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ High ]'), viewOf(h.vt))
  h.vt.sendInput('\x1b') // back to model mode
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹High›'), `the effort must persist:\n${view}`)
  assert.ok(contentLinesOf(h.vt).some(line => line.startsWith('→ ') && line.includes('Sol')),
    `the selected model must persist:\n${view}`)
  const searchAfter = contentLinesOf(h.vt).find(line => line.trimStart().startsWith('>'))!
  assert.equal(searchAfter, searchBefore, `the query (and cursor) must survive the round trip:\n${view}`)
  h.app.stop()
})

test('an ultra-narrow wrapped badge keeps the effort token (inactive and active)', async () => {
  const h = await openPicker({ directory: LAYOUT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  const inactive = renderAt(h, 26)
  assert.ok(inactive.some(line => line.includes('‹High›')),
    `the inactive effort token must survive the truncation:\n${inactive.join('\n')}`)
  h.vt.sendInput(ENTER) // focus the inline effort
  await h.vt.waitForRender()
  const active = renderAt(h, 26)
  assert.ok(active.some(line => line.includes('[ High ]')),
    `the active effort token must survive the truncation:\n${active.join('\n')}`)
  h.app.stop()
})

// Active Effort-mode settlement: the refusal must release the focus, preserve
// the model/local effort/query, and allow re-entry (§22/§53).
for (const outcome of ['rejected', 'cancelled', 'unsupported'] as const) {
  test(`an active effort-mode ${outcome} returns to Model mode and preserves the selection`, async () => {
    const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' }, outcome })
    h.vt.sendInput('sol') // a query to prove preservation
    await h.vt.waitForRender()
    h.vt.sendInput(ENTER) // focus the effort
    h.vt.sendInput(RIGHT) // medium -> high
    await h.vt.waitForRender()
    assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ High ]'), viewOf(h.vt))
    h.vt.sendInput(ENTER) // commit -> refused
    await settle()
    await h.vt.waitForRender()
    const view = viewOf(h.vt)
    assert.deepEqual(h.applied, [{ provider: 'p1', model: 'sol', reasoningEffort: 'high' }])
    assert.equal(h.closeCount(), 0, `a ${outcome} commit must not dismiss the overlay`)
    assert.ok(!view.includes('Selecting'), `the selecting state must clear:\n${view}`)
    assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹High›'), `must return to Model mode:\n${view}`)
    assert.ok(!view.includes('[ High ]'), `the effort focus must be released:\n${view}`)
    assert.ok(view.includes('> sol'), `the query must be preserved:\n${view}`)
    h.vt.sendInput(ENTER) // re-entry
    await h.vt.waitForRender()
    assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ High ]'), `re-entry must work:\n${viewOf(h.vt)}`)
    h.app.stop()
  })
}

test('a delayed effort-mode refusal repaints back to Model mode after Selecting…', async () => {
  let resolveOutcome!: (value: ModelApplyOutcome) => void
  const deferredOutcome = new Promise<ModelApplyOutcome>((resolve) => { resolveOutcome = resolve })
  const h = await openPicker({
    directory: EFFORT_DIRECTORY,
    current: { provider: 'p1', model: 'sol' },
    apply: () => deferredOutcome,
  })
  h.vt.sendInput(ENTER) // focus
  h.vt.sendInput(RIGHT) // medium -> high
  await h.vt.waitForRender()
  h.vt.sendInput(ENTER) // commit -> pending
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Selecting'), `Selecting must be painted first:\n${viewOf(h.vt)}`)
  resolveOutcome('rejected')
  await settle()
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(!view.includes('Selecting'), `the refusal must clear Selecting…:\n${view}`)
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹High›'), `must return to Model mode:\n${view}`)
  assert.equal(h.closeCount(), 0)
  h.app.stop()
})

test('an active effort-mode indeterminate commit dismisses the overlay', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' }, outcome: 'indeterminate' })
  h.vt.sendInput(ENTER)
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  h.vt.sendInput(ENTER)
  await settle()
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'sol', reasoningEffort: 'high' }])
  assert.equal(h.closeCount(), 1)
  h.app.stop()
})

test('an active effort-mode superseded commit makes no close decision and does not repaint', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' }, outcome: 'superseded' })
  h.vt.sendInput(ENTER)
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  h.vt.sendInput(ENTER)
  await settle()
  await h.vt.waitForRender()
  assert.equal(h.closeCount(), 0)
  assert.ok(viewOf(h.vt).includes('Selecting'), `a superseded op must not repaint:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('an active effort-mode thrown write returns to Model mode', async () => {
  let rejectOutcome!: (error: unknown) => void
  const deferredOutcome = new Promise<ModelApplyOutcome>((_resolve, reject) => { rejectOutcome = reject })
  const h = await openPicker({
    directory: EFFORT_DIRECTORY,
    current: { provider: 'p1', model: 'sol' },
    apply: () => deferredOutcome,
  })
  h.vt.sendInput(ENTER)
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Selecting'), viewOf(h.vt))
  rejectOutcome(new Error('transport exploded'))
  await settle()
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(!view.includes('Selecting'), `the error must clear Selecting…:\n${view}`)
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹High›'), `must return to Model mode:\n${view}`)
  assert.equal(h.closeCount(), 0)
  h.app.stop()
})

test('a directory refresh preserves the picker-local effort for a surviving model', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(ENTER) // focus
  h.vt.sendInput(RIGHT) // medium -> high
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ High ]'), viewOf(h.vt))
  h.hydrate(EFFORT_DIRECTORY, { provider: 'p1', model: 'sol' }) // refresh, same catalog
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ High ]'), `the local effort must survive the refresh:\n${view}`)
  assert.ok(view.includes('[ High ]'), `the effort focus must survive the refresh:\n${view}`)
  h.app.stop()
})

test('a refresh that drops the local effort re-anchors to the model default', async () => {
  const narrower = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [
      model('sol', { name: 'Sol', efforts: [{ id: 'low', name: 'Low' }, { id: 'medium', name: 'Medium' }], defaultEffort: 'medium' }),
    ] }],
    default: { provider: 'p1', model: 'sol' },
  })
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(ENTER)
  h.vt.sendInput(RIGHT) // medium -> high
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ High ]'), viewOf(h.vt))
  h.hydrate(narrower, { provider: 'p1', model: 'sol' }) // 'high' is no longer advertised
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ Medium ]'), `must re-anchor to the model default:\n${view}`)
  assert.ok(!view.includes('High'), `the dropped effort must not linger:\n${view}`)
  h.app.stop()
})

test('a refresh that removes the bound model exits Effort mode without retargeting a neighbour', async () => {
  const other = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [
      model('plain', { name: 'Plain' }),
      model('other', { name: 'Other', efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' }),
    ] }],
    default: { provider: 'p1', model: 'plain' },
  })
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(ENTER) // focus Sol
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('[ '), viewOf(h.vt))
  h.hydrate(other, { provider: 'p1', model: 'plain' }) // Sol disappears
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(!view.includes('[ '), `the effort focus must be released when its model vanishes:\n${view}`)
  assert.ok(view.includes('Other'), view)
  assert.ok(view.includes('effort ‹Low›'), `a neighbour must stay INACTIVE (never retargeted):\n${view}`)
  h.app.stop()
})

test('a refresh that removes the bound model consumes the next key (no retarget)', async () => {
  const other = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [
      model('plain', { name: 'Plain' }),
      model('other', { name: 'Other', efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' }),
    ] }],
    default: { provider: 'p1', model: 'plain' },
  })
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(ENTER) // focus Sol
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('[ '), viewOf(h.vt))
  // The refresh removes Sol and selects the reasoning replacement.
  h.hydrate(other, { provider: 'p1', model: 'other' })
  await h.vt.waitForRender()
  assert.ok(!viewOf(h.vt).includes('[ '), `the refresh must release the effort focus:\n${viewOf(h.vt)}`)
  // The key that would otherwise retarget the replacement is CONSUMED.
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.ok(!viewOf(h.vt).includes('[ '), `the triggering key must not re-focus the replacement:\n${viewOf(h.vt)}`)
  assert.deepEqual(h.applied, [], 'the consumed key must not write')
  // The following key behaves normally again (focuses the reasoning row).
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('effort [ Low ]'), `the next key must behave normally:\n${viewOf(h.vt)}`)
  assert.deepEqual(h.applied, [], 'focusing must not write')
  h.app.stop()
})

test('a refresh that drops the reasoning metadata exits Effort mode to the no-effort fast path', async () => {
  const noReasoning = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('sol', { name: 'Sol' })] }],
    default: { provider: 'p1', model: 'sol' },
  })
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(ENTER) // focus the effort
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('[ '), viewOf(h.vt))
  h.hydrate(noReasoning, { provider: 'p1', model: 'sol' }) // same model, no reasoning metadata
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(!view.includes('[ '), `the focus must be released:\n${view}`)
  assert.ok(!view.includes('esc back'), `the effort-mode hint must be dropped:\n${view}`)
  assert.ok(view.includes('enter effort/select'), `the model-mode hint must return:\n${view}`)
  h.vt.sendInput(ENTER) // the no-effort fast path commits directly
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'sol' }])
  h.app.stop()
})

test('removing then re-adding the bound model does not leave a stale swallow latch', async () => {
  const without = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('plain', { name: 'Plain' })] }],
    default: { provider: 'p1', model: 'plain' },
  })
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(ENTER) // focus Sol
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('[ '), viewOf(h.vt))
  h.hydrate(without, { provider: 'p1', model: 'plain' }) // remove Sol -> latch set
  await h.vt.waitForRender()
  h.hydrate(EFFORT_DIRECTORY, { provider: 'p1', model: 'sol' }) // Sol returns BEFORE any input
  await h.vt.waitForRender()
  h.vt.sendInput(ENTER)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ Medium ]'),
    `the re-hydration must clear the latch so Enter is not swallowed:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('a removal followed by a load error does not consume the next Esc', async () => {
  const without = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('plain', { name: 'Plain' })] }],
    default: { provider: 'p1', model: 'plain' },
  })
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(ENTER) // focus Sol
  await h.vt.waitForRender()
  h.hydrate(without, { provider: 'p1', model: 'plain' }) // remove Sol -> latch set
  h.picker.setLoadError('connection refused') // must clear the latch
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b') // Esc must close, not be consumed
  await h.vt.waitForRender()
  assert.equal(h.closeCount(), 1, 'the Esc after a load error must not be swallowed')
  h.app.stop()
})

test('a refresh that moves the configured selection keeps the Effort-bound row selected', async () => {
  const two = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [
      model('sol', { name: 'Sol', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }),
      model('other', { name: 'Other', efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' }),
    ] }],
    default: { provider: 'p1', model: 'sol' },
  })
  const h = await openPicker({ directory: two, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(ENTER) // focus Sol
  h.vt.sendInput(RIGHT) // low -> high
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ High ]'), viewOf(h.vt))
  h.hydrate(two, { provider: 'p1', model: 'other' }) // the configured selection moves
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(contentLinesOf(h.vt).some(line => line.startsWith('→ ') && line.includes('Sol')),
    `the effort-bound row must stay selected:\n${view}`)
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ High ]'), `the active token must sit on the selected row:\n${view}`)
  h.vt.sendInput(LEFT) // still acts on Sol
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort [ Low ]'), `← must still act on the bound row:\n${viewOf(h.vt)}`)
  h.vt.sendInput(ENTER)
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'sol', reasoningEffort: 'low' }])
  h.app.stop()
})
