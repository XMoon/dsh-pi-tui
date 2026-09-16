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
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹high›'), `Sol must show the configured effort:\n${viewOf(h.vt)}`)
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
  assert.ok(sol.includes('effort ‹high›'), `the global default effort must seed the inline value: ${sol}`)
  h.app.stop()
})

test('a non-current model seeds its own default effort, never the Session effort', async () => {
  const h = await openPicker({
    directory: EFFORT_DIRECTORY,
    current: { provider: 'p1', model: 'plain' },
  })
  const sol = rowLine(h.vt, 'Sol')!
  assert.ok(sol.includes('effort ‹medium›'), `Sol must use its own default (medium): ${sol}`)
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
  h.vt.sendInput(ENTER)
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'nodefault' }], 'provider default must omit reasoningEffort')
  h.app.stop()
})

test('Right cycles the effort forward and Left backward, wrapping', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹medium›'), viewOf(h.vt))
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹high›'), `Right -> High:\n${viewOf(h.vt)}`)
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹xhigh›'), `Right -> XHigh:\n${viewOf(h.vt)}`)
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹low›'), `Right wraps to Low:\n${viewOf(h.vt)}`)
  h.vt.sendInput(LEFT)
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹xhigh›'), `Left wraps back to XHigh:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('Right never opens a sub-view: the header stays "Models" and Esc closes', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(RIGHT)
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(!view.includes('Models ›'), `there must be no Efforts view header:\n${view}`)
  assert.ok(view.includes('Models'), view)
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.equal(h.closeCount(), 1, 'Esc closes from the single view')
  h.app.stop()
})

test('per-model inline effort state is retained across model moves', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(RIGHT) // Sol: medium -> high
  await h.vt.waitForRender()
  h.vt.sendInput(DOWN) // move to Plain
  await h.vt.waitForRender()
  h.vt.sendInput(UP) // back to Sol
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹high›'), `Sol's picker-local effort must persist:\n${viewOf(h.vt)}`)
  // A model with no effort metadata never receives another model's effort.
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
  h.vt.sendInput(RIGHT) // p1 -> high
  await h.vt.waitForRender()
  assert.ok(rowLine(h.vt, 'P1 Model')?.includes('effort ‹high›'), viewOf(h.vt))
  assert.ok(rowLine(h.vt, 'P2 Model')?.includes('effort ‹low›'), `the same-id other provider keeps its own value:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('Enter submits the model with its currently displayed effort', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(RIGHT) // medium -> high
  await h.vt.waitForRender()
  h.vt.sendInput(ENTER)
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'sol', reasoningEffort: 'high' }])
  h.app.stop()
})

test('Enter on a no-effort model omits reasoningEffort', async () => {
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
  h.vt.sendInput(RIGHT) // Sol: medium -> high
  await h.vt.waitForRender()
  assert.ok(!viewOf(h.vt).includes('Plain'), `the query must filter before the swap:\n${viewOf(h.vt)}`)
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
  await settle()
  const view = viewOf(h.vt)
  assert.ok(view.includes('Models'), `the picker must survive the swap:\n${view}`)
  assert.ok(rowLine(h.vt, 'Sol')?.includes('effort ‹high›'), `the inline effort must survive:\n${view}`)
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

test('loading: Left/Right do not move the search cursor (typing stays append-only)', async () => {
  const h = await openPicker({ loading: true })
  h.vt.sendInput('abc')
  await h.vt.waitForRender()
  h.vt.sendInput(RIGHT)
  h.vt.sendInput(LEFT)
  h.vt.sendInput('d')
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(view.includes('abcd'), `typing must append while loading:\n${view}`)
  assert.ok(!view.includes('abdc'), `Left must not move the search cursor:\n${view}`)
  h.app.stop()
})

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
  assert.ok(rowLine(h.vt, 'Sol')?.includes('current · default · effort ‹medium›'),
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

test('Left/Right on a model without effort metadata is a true no-op', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput(DOWN) // move to Plain (no reasoning metadata)
  await h.vt.waitForRender()
  assert.ok(!rowLine(h.vt, 'Plain')?.includes('effort ‹'), `Plain starts effort-free:\n${viewOf(h.vt)}`)
  h.vt.sendInput(RIGHT)
  h.vt.sendInput(LEFT)
  await h.vt.waitForRender()
  assert.ok(!rowLine(h.vt, 'Plain')?.includes('effort ‹'),
    `Left/Right must not invent a provider-default token on a no-effort model:\n${viewOf(h.vt)}`)
  h.vt.sendInput(ENTER)
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'plain' }], 'the payload must still omit reasoningEffort')
  h.app.stop()
})
