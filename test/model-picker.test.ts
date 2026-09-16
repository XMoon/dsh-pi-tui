/**
 * Headless tests for the `/model` picker (src/model-picker.ts): the pure
 * directory projection (provider groups, full identity, current/default/
 * effort badges) plus the single-overlay component — model list, search,
 * selected-only detail, Enter selection, Right→Effort view swap, Esc/Left
 * back, effort cursor/badges, write settlement, row budget, mouse parity and
 * the approval/fullscreen lifecycle. No second overlay is ever mounted.
 * @module @xmoon76/dsh-pi-tui/model-picker.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { CURSOR_MARKER } from '@xmoon76/pi-tui'
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
  // A model without reasoning metadata exposes no effort choices.
  assert.deepEqual(projection.models.find(row => row.modelId === 'gpt-pro')!.efforts, [])
  assert.equal(projection.models.find(row => row.modelId === 'gpt-pro')!.defaultEffort, undefined)
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

test('projection carries an explicit current effort only for the current model', () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('m1', { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' }), model('m2', { efforts: [{ id: 'low', name: 'Low' }] })] }],
    default: { provider: 'p1', model: 'm1' },
  })
  const projection = projectModelDirectory(directory, { provider: 'p1', model: 'm1', reasoningEffort: 'high' }, false)
  assert.equal(projection.models[0]!.currentEffort, 'high')
  assert.equal(projection.models[1]!.currentEffort, undefined, 'another model never takes the session effort')
  assert.deepEqual(projection.models[0]!.efforts, [{ id: 'high', name: 'High' }])
  assert.equal(projection.models[0]!.defaultEffort, 'high')
})

test('a sessionless projection never fabricates a current model', () => {
  const projection = projectModelDirectory(TWO_PROVIDERS, { provider: 'openai', model: 'gpt-pro' }, true)
  assert.ok(projection.models.every(row => !row.isCurrent), 'sessionless has no current')
  assert.equal(projection.models.find(row => row.modelId === 'gpt-pro')!.isDefault, true)
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
  directory: ModelDirectoryDto
  current?: ModelPickerCurrent
  sessionless?: boolean
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
    directory: options.directory,
    current: options.current,
    sessionless: options.sessionless ?? false,
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
  await vt.waitForRender()
  return { vt, app, picker, applied, closeCount: () => closeCount, close: () => closer() }
}

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

// ── Models view ──────────────────────────────────────────────────────────

test('opens directly on the grouped model list with no provider navigation step', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'openai', model: 'shared-id' } })
  const view = viewOf(h.vt)
  assert.ok(view.includes('Models'), `header missing:\n${view}`)
  assert.ok(view.includes('OpenAI') && view.includes('Anthropic'), `both provider groups must render:\n${view}`)
  assert.ok(view.includes('Sol') && view.includes('Opus'), `models must be visible without Entering a provider:\n${view}`)
  h.app.stop()
})

test('the initial selection is the full current identity, not a same-id other provider', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'anthropic', model: 'shared-id' } })
  const selected = selectedRow(h.vt)
  assert.ok(selected !== undefined, 'a row must be selected')
  assert.ok(selected.includes('Opus'), `the Anthropic row must be selected, got: ${selected}`)
  h.app.stop()
})

test('an unlisted current model selects nothing wrongly and never fakes a catalog row', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'ghost', model: 'shared-id' } })
  const lines = linesOf(h.vt)
  assert.ok(!lines.some(line => line.includes('ghost')), `no fabricated current row:\n${viewOf(h.vt)}`)
  const selected = selectedRow(h.vt)
  // No wrong-provider match: the first catalog row wins, never a same-id
  // row marked current.
  assert.ok(selected !== undefined && selected.includes('Sol'), `first row selected: ${selected}`)
  assert.ok(!selected!.includes('current'), 'an unmatched current must not badge a catalog row as current')
  h.app.stop()
})

test('current and default badges are independent, using the full identity', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'openai', model: 'shared-id' } })
  const lines = linesOf(h.vt)
  const sol = lines.find(line => line.includes('Sol'))
  const pro = lines.find(line => line.includes('Pro'))
  assert.ok(sol?.includes('current'), `current badge missing: ${sol}`)
  assert.ok(pro?.includes('default'), `default badge missing: ${pro}`)
  // The duplicate-id Anthropic row must not carry the current badge.
  const opus = lines.find(line => line.includes('Opus'))
  assert.ok(opus !== undefined && !opus.includes('current'), `duplicate id mislabeled current: ${opus}`)
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
  const lines = linesOf(h.vt)
  assert.equal(lines.filter(line => line.includes('Same · 1')).length, 2,
    `two providers named "Same" must keep two sections:\n${viewOf(h.vt)}`)
  assert.equal(lines.filter(line => line.includes('Unavailable · 1')).length, 2,
    `a provider named "Unavailable" must not merge with the failure section:\n${viewOf(h.vt)}`)
  assert.ok(lines.some(line => line.includes('One')) && lines.some(line => line.includes('Two')),
    `both same-name providers' models must render:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('the model detail renders only under the selected row and moves with the selection', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [
      model('id-sol', { name: 'Sol', description: 'detail-sol' }),
      model('id-pro', { name: 'Pro', description: 'detail-pro' }),
    ] }],
    default: { provider: 'p1', model: 'id-sol' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'id-sol' } })
  let view = viewOf(h.vt)
  assert.ok(view.includes('id-sol') && view.includes('detail-sol'), `selected detail missing:\n${view}`)
  assert.ok(!view.includes('detail-pro'), `unselected detail must not render:\n${view}`)
  h.vt.sendInput('\x1b[B') // down to Pro
  await h.vt.waitForRender()
  view = viewOf(h.vt)
  assert.ok(view.includes('id-pro') && view.includes('detail-pro'), `new selected detail missing:\n${view}`)
  assert.ok(!view.includes('detail-sol'), `old detail must disappear:\n${view}`)
  h.app.stop()
})

test('a name identical to the id is not repeated in the detail', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('deepseek-v4.1', { description: 'fast model' })] }],
    default: { provider: 'p1', model: 'deepseek-v4.1' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'deepseek-v4.1' } })
  const view = viewOf(h.vt)
  assert.ok(view.includes('deepseek-v4.1'), `the id must render as the label:\n${view}`)
  assert.ok(view.includes('fast model'), `the description must render as the detail:\n${view}`)
  assert.ok(!view.includes('deepseek-v4.1 · deepseek-v4.1'), `id must not be repeated:\n${view}`)
  h.app.stop()
})

test('search covers model name and model id', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'openai', model: 'shared-id' } })
  // model name
  h.vt.sendInput('opus')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Opus') && !viewOf(h.vt).includes('Sol'), `name search failed:\n${viewOf(h.vt)}`)
  for (let i = 0; i < 4; i += 1) h.vt.sendInput('\x7f') // backspace
  // model id
  h.vt.sendInput('gpt-pro')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Pro') && !viewOf(h.vt).includes('Opus'), `id search failed:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('search matches a provider display name and a provider id independently', async () => {
  // The id and the display name must NOT share a substring, so each query can
  // only be satisfied by its own field.
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
  assert.ok(viewOf(h.vt).includes('Sol') && !viewOf(h.vt).includes('Opus'), `display-name search failed:\n${viewOf(h.vt)}`)
  for (let i = 0; i < 6; i += 1) h.vt.sendInput('\x7f')
  h.vt.sendInput('gw-42') // provider id only (the name is `Custom Gateway`)
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Sol') && !viewOf(h.vt).includes('Opus'), `provider-id search failed:\n${viewOf(h.vt)}`)
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

test('zero-result navigation is a no-op and the no-match state renders', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'openai', model: 'shared-id' } })
  h.vt.sendInput('zzzz')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('No matching models'), viewOf(h.vt))
  h.vt.sendInput('\x1b[B')
  h.vt.sendInput('\x1b[A')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('No matching models'), 'navigation must not break the no-match state')
  h.app.stop()
})

test('provider failure rows are searchable, inert and show their message on selection', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [model('m1', { name: 'Sol' })] }],
    failures: [{ id: 'gw', name: 'Custom Gateway', message: 'connection refused' }],
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'm1' } })
  assert.ok(viewOf(h.vt).includes('Custom Gateway'), `failure row missing:\n${viewOf(h.vt)}`)
  h.vt.sendInput('\x1b[B') // down to the failure row
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('connection refused'), `failure detail missing:\n${viewOf(h.vt)}`)
  h.vt.sendInput('\r') // Enter on a failure row is inert
  await settle()
  assert.deepEqual(h.applied, [], 'a failure row must never submit a model')
  assert.equal(h.closeCount(), 0, 'a failure row must not close the overlay')
  // Searchable by provider name.
  h.vt.sendInput('gateway')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Custom Gateway') && !viewOf(h.vt).includes('Sol'), `provider search on a failure row:\n${viewOf(h.vt)}`)
  h.app.stop()
})

// ── Enter selection ──────────────────────────────────────────────────────

test('Enter applies the model directly with no synthesized effort', async () => {
  // The current model is Plain (no efforts), so it is selected on open.
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'plain' } })
  h.vt.sendInput('\r')
  await settle()
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'plain' }], 'Enter must submit provider/model only')
  assert.equal(h.closeCount(), 1, 'a committed write dismisses the overlay')
  assert.ok(!viewOf(h.vt).includes('Models'), `overlay must be closed:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('a second Enter while selecting does not dispatch a duplicate write', async () => {
  let resolveOutcome!: (outcome: ModelApplyOutcome) => void
  const deferredOutcome = new Promise<ModelApplyOutcome>((resolve) => { resolveOutcome = resolve })
  const h = await openPicker({
    directory: EIGHT_MODELS,
    current: { provider: 'p1', model: 'm0' },
    apply: () => deferredOutcome,
  })
  h.vt.sendInput('\r')
  await settle()
  h.vt.sendInput('\r')
  await settle()
  assert.equal(h.applied.length, 1, 'a selecting picker must ignore a second Enter')
  resolveOutcome('committed')
  await settle()
  h.app.stop()
})

const EIGHT_MODELS = makeDirectory({
  groups: [{ id: 'p1', name: 'P1', models: Array.from({ length: 8 }, (_, i) => model(`m${i}`, { name: `Model ${i}` })) }],
  default: { provider: 'p1', model: 'm0' },
})

for (const outcome of ['rejected', 'cancelled', 'unsupported'] as const) {
  test(`a ${outcome} write returns to the model view and keeps the picker usable`, async () => {
    const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' }, outcome })
    h.vt.sendInput('\r') // Enter applies sol directly
    await settle()
    await h.vt.waitForRender()
    assert.deepEqual(h.applied, [{ provider: 'p1', model: 'sol' }])
    assert.equal(h.closeCount(), 0, `a ${outcome} write must not dismiss the overlay`)
    assert.ok(viewOf(h.vt).includes('Models'), `picker must stay usable:\n${viewOf(h.vt)}`)
    h.app.stop()
  })
}

// The failure kind that arrives AFTER the `Selecting…` frame has painted must
// still repaint the model view (clearing the latch alone leaves it stuck).
for (const outcome of ['rejected', 'cancelled', 'unsupported'] as const) {
  test(`a delayed ${outcome} settlement repaints the model view after Selecting…`, async () => {
    let resolveOutcome!: (value: ModelApplyOutcome) => void
    const deferredOutcome = new Promise<ModelApplyOutcome>((resolve) => { resolveOutcome = resolve })
    const h = await openPicker({
      directory: EIGHT_MODELS,
      current: { provider: 'p1', model: 'm0' },
      apply: () => deferredOutcome,
    })
    h.vt.sendInput('\r')
    await h.vt.waitForRender()
    assert.ok(viewOf(h.vt).includes('Selecting'), `Selecting must be painted first:\n${viewOf(h.vt)}`)
    resolveOutcome(outcome)
    await settle()
    await h.vt.waitForRender()
    assert.ok(!viewOf(h.vt).includes('Selecting'), `the failure must not leave Selecting… painted:\n${viewOf(h.vt)}`)
    assert.ok(viewOf(h.vt).includes('Models'), `the model view must be restored:\n${viewOf(h.vt)}`)
    assert.equal(h.closeCount(), 0)
    h.app.stop()
  })
}

test('a delayed thrown write repaints the model view after Selecting…', async () => {
  let rejectOutcome!: (error: unknown) => void
  const deferredOutcome = new Promise<ModelApplyOutcome>((_resolve, reject) => { rejectOutcome = reject })
  const h = await openPicker({
    directory: EIGHT_MODELS,
    current: { provider: 'p1', model: 'm0' },
    apply: () => deferredOutcome,
  })
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Selecting'), `Selecting must be painted first:\n${viewOf(h.vt)}`)
  rejectOutcome(new Error('transport exploded'))
  await settle()
  await h.vt.waitForRender()
  assert.ok(!viewOf(h.vt).includes('Selecting'), `the error must not leave Selecting… painted:\n${viewOf(h.vt)}`)
  assert.ok(viewOf(h.vt).includes('Models'), `the model view must be restored:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('an indeterminate write dismisses the overlay (host reconciles)', async () => {
  const h = await openPicker({ directory: EIGHT_MODELS, current: { provider: 'p1', model: 'm0' }, outcome: 'indeterminate' })
  h.vt.sendInput('\r')
  await settle()
  await h.vt.waitForRender()
  assert.equal(h.closeCount(), 1, 'an indeterminate settle dismisses')
  h.app.stop()
})

test('a superseded write makes no close/open decision', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' }, outcome: 'superseded' })
  h.vt.sendInput('\r')
  await settle()
  await h.vt.waitForRender()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'sol' }])
  assert.equal(h.closeCount(), 0, 'a superseded operation must not close the surface')
  assert.ok(viewOf(h.vt).includes('Selecting'), `a superseded operation must repaint nothing:\n${viewOf(h.vt)}`)
  h.app.stop()
})

// ── Effort view ──────────────────────────────────────────────────────────

test('Right opens the effort view only when the model has effort choices', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput('\x1b[B') // down to Plain (no efforts)
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[C') // Right: no-op for a model without efforts
  await h.vt.waitForRender()
  assert.ok(!viewOf(h.vt).includes('Provider default'), `no empty effort panel:\n${viewOf(h.vt)}`)
  assert.ok(viewOf(h.vt).includes('Models'), 'must stay on the model view')
  h.vt.sendInput('\x1b[A') // back to Sol
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[C') // Right: Sol has efforts
  await h.vt.waitForRender()
  const view = viewOf(h.vt)
  assert.ok(view.includes('Low') && view.includes('High'), `effort list missing:\n${view}`)
  assert.ok(view.includes('Models › Sol'), `effort header missing:\n${view}`)
  h.app.stop()
})

test('the current model effort view marks current/default and starts on the current effort', async () => {
  const h = await openPicker({
    directory: EFFORT_DIRECTORY,
    current: { provider: 'p1', model: 'sol', reasoningEffort: 'high' },
  })
  h.vt.sendInput('\x1b[C')
  await h.vt.waitForRender()
  const lines = linesOf(h.vt)
  const medium = lines.find(line => line.includes('Medium'))
  const high = lines.find(line => line.includes('High'))
  assert.ok(medium?.includes('default'), `default badge missing: ${medium}`)
  assert.ok(high?.includes('current'), `current badge missing: ${high}`)
  assert.ok(!high!.includes('default'), 'high is not the default here')
  const selected = selectedRow(h.vt)
  assert.ok(selected?.includes('High'), `cursor must start on the current effort, got: ${selected}`)
  assert.ok(!lines.some(line => line.includes('Provider default')), 'a concrete default must not add a synthetic row')
  h.app.stop()
})

test('when current effort equals the model default one row carries current · default', async () => {
  const h = await openPicker({
    directory: EFFORT_DIRECTORY,
    current: { provider: 'p1', model: 'sol', reasoningEffort: 'medium' },
  })
  h.vt.sendInput('\x1b[C')
  await h.vt.waitForRender()
  const medium = linesOf(h.vt).find(line => line.includes('Medium'))
  assert.ok(medium?.includes('current · default'), `combined badge missing: ${medium}`)
  h.app.stop()
})

test('a non-current model effort view never marks the session effort current and starts on the model default', async () => {
  const h = await openPicker({
    directory: EFFORT_DIRECTORY,
    current: { provider: 'p1', model: 'plain' }, // session current is Plain
  })
  h.vt.sendInput('\x1b[A') // Plain is selected; move up to Sol
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[C') // Right into Sol's efforts
  await h.vt.waitForRender()
  const lines = linesOf(h.vt)
  assert.ok(!lines.some(line => line.includes('current')), `no current badge for a non-current model:\n${viewOf(h.vt)}`)
  const selected = selectedRow(h.vt)
  assert.ok(selected?.includes('Medium'), `cursor must be the model default, got: ${selected}`)
  h.app.stop()
})

test('a model without a default effort shows Provider default and starts there for a non-current model', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [
      model('plain', { name: 'Plain' }),
      model('nodefault', { name: 'No Default', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }),
    ] }],
    default: { provider: 'p1', model: 'plain' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'plain' } })
  h.vt.sendInput('\x1b[B') // down to No Default
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[C')
  await h.vt.waitForRender()
  const lines = linesOf(h.vt)
  assert.ok(lines.some(line => line.includes('Provider default')), `Provider default row missing:\n${viewOf(h.vt)}`)
  const selected = selectedRow(h.vt)
  assert.ok(selected?.includes('Provider default'), `cursor must start on Provider default, got: ${selected}`)
  h.vt.sendInput('\r')
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'nodefault' }], 'Provider default submits without an effort')
  h.app.stop()
})

test('selecting a concrete effort submits the full provider/model/effort selection', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'plain' } })
  h.vt.sendInput('\x1b[A') // Plain is selected; move up to Sol
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[C') // Right into Sol's efforts
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[A') // up from Medium to Low
  h.vt.sendInput('\r')
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'sol', reasoningEffort: 'low' }])
  h.app.stop()
})

test('Left and Esc return to the model view with query, selection and mode preserved', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput('sol') // filter
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[C') // Right into efforts
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Models › Sol'))
  h.vt.sendInput('\x1b[D') // Left back
  await h.vt.waitForRender()
  let lines = linesOf(h.vt)
  assert.ok(lines.some(line => line.includes('Models')), `back on the model view:\n${viewOf(h.vt)}`)
  assert.ok(!viewOf(h.vt).includes('XHigh'), 'effort view must be gone')
  const selected = selectedRow(h.vt)
  assert.ok(selected?.includes('Sol'), `selection preserved, got: ${selected}`)
  h.vt.sendInput('\x1b[C') // re-enter
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b') // Esc from effort
  await h.vt.waitForRender()
  lines = linesOf(h.vt)
  assert.ok(lines.some(line => line.includes('Models')), `Esc from effort returns to the model view:\n${viewOf(h.vt)}`)
  assert.equal(h.closeCount(), 0, 'Esc from the effort view must not close the whole overlay')
  h.app.stop()
})

test('Esc from the model view closes the overlay', async () => {
  const h = await openPicker({ directory: TWO_PROVIDERS, current: { provider: 'openai', model: 'shared-id' } })
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.equal(h.closeCount(), 1)
  assert.ok(!viewOf(h.vt).includes('Models'), `overlay must close:\n${viewOf(h.vt)}`)
  h.app.stop()
})

// ── budget / mouse / lifecycle ───────────────────────────────────────────

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

test('a resize that does not change the clamped overlay geometry still fences stale mouse', async () => {
  // 80 -> 90 keeps the /model overlay clamped at width 72 / maxHeight 24, so
  // only the raw terminal dimensions distinguish the geometry. The fence must
  // still reject a click before the repaint (and accept it after).
  const h = await openPicker({ directory: EIGHT_MODELS, current: { provider: 'p1', model: 'm0' }, fullscreen: true })
  const row = linesOf(h.vt).findIndex(line => line.includes('Model 3'))
  assert.ok(row >= 0, `Model 3 must be painted before the resize:\n${viewOf(h.vt)}`)
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
  // Only the fullscreen (alt) screen dispatches pointer events to overlays.
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
  // After the repaint adopts the new geometry, the same interaction applies.
  await h.vt.waitForRender()
  const repaintedRow = linesOf(h.vt).findIndex(line => line.includes('Model 3'))
  assert.ok(repaintedRow >= 0)
  h.vt.sendInput(`\x1b[<0;5;${repaintedRow + 1}M`)
  h.vt.sendInput(`\x1b[<0;5;${repaintedRow + 1}m`)
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'm3' }],
    `a fresh post-resize click must apply the clicked model:\n${viewOf(h.vt)}`)
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

test('a click on a model row moves the selection and applies that exact model', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  const width = 72
  const rendered = h.picker.render(width).map(stripAnsi)
  const row = rendered.findIndex(line => line.includes('Plain'))
  assert.ok(row >= 0, `Plain row missing:\n${rendered.join('\n')}`)
  const press = h.picker.handleMouse(mouse('press', 5, row, width, 24))
  assert.ok(press !== undefined && press.handled === true, 'a press on a model row must be handled')
  h.picker.handleMouse(mouse('click', 5, row, width, 24))
  await settle()
  assert.deepEqual(h.applied, [{ provider: 'p1', model: 'plain' }], 'the clicked model must apply')
  h.app.stop()
})

test('a click on the selected detail row is inert (never activates a neighbour)', async () => {
  const directory = makeDirectory({
    groups: [{ id: 'p1', name: 'P1', models: [
      model('id-sol', { name: 'Sol', description: 'detail-sol' }),
      model('id-pro', { name: 'Pro', description: 'detail-pro' }),
    ] }],
    default: { provider: 'p1', model: 'id-sol' },
  })
  const h = await openPicker({ directory, current: { provider: 'p1', model: 'id-sol' } })
  const width = 72
  const rendered = h.picker.render(width).map(stripAnsi)
  const solRow = rendered.findIndex(line => line.includes('Sol'))
  const detailRow = rendered.findIndex(line => line.includes('detail-sol'))
  assert.ok(detailRow >= 0, `detail row missing:\n${rendered.join('\n')}`)
  assert.equal(detailRow, solRow + 1, 'the detail must be the physical row under the selected model')
  // Direct component-level mouse dispatch against last-painted geometry: the
  // detail row must be inert, so the press is rejected.
  const result = h.picker.handleMouse(mouse('press', 5, detailRow, width, 24))
  assert.equal(result, undefined, 'a press on the inert detail row must be rejected')
  assert.deepEqual(h.applied, [])
  h.app.stop()
})

test('an approval over the model picker restores the picker and its physical focus', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.vt.sendInput('sol')
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Models'), viewOf(h.vt))

  void h.app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command' })
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Approve bash?'), `approval must be visible:\n${viewOf(h.vt)}`)

  h.vt.sendInput('y')
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Models'), `picker must be restored:\n${viewOf(h.vt)}`)
  assert.notEqual(h.app.focusedComponentForTest(), h.app.seatEditorForTest().component,
    'the restored picker must hold PHYSICAL focus, not the editor')
  h.vt.sendInput('X')
  await h.vt.waitForRender()
  assert.equal(h.app.seatTextForTest(), '', 'the restored picker must own input (no editor leak)')
  h.app.stop()
})

test('a Save Location prompt suspends the picker and restores it on settle', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  const pending = h.app.askSaveLocation(
    { title: 'Save session archive', filename: 'archive.tar', initialDirectory: './' },
    {
      resolveDirectory: input => input,
      isDirectory: () => true,
      targetExists: () => false,
      complete: async () => [],
    },
  )
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Save session archive'), `save location must be visible:\n${viewOf(h.vt)}`)
  assert.ok(!viewOf(h.vt).includes('Models'), `the picker must be suspended beneath the prompt:\n${viewOf(h.vt)}`)

  h.vt.sendInput('\x1b') // cancel the prompt: the suspended picker must come back
  await h.vt.waitForRender()
  await settle()
  assert.deepEqual(await pending, { kind: 'cancelled' })
  assert.ok(viewOf(h.vt).includes('Models'), `the picker must be restored:\n${viewOf(h.vt)}`)
  h.app.stop()
})

test('closing the picker while suspended does not resurrect it when the prompt settles', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  const pending = h.app.askSaveLocation(
    { title: 'Save session archive', filename: 'archive.tar', initialDirectory: './' },
    {
      resolveDirectory: input => input,
      isDirectory: () => true,
      targetExists: () => false,
      complete: async () => [],
    },
  )
  await h.vt.waitForRender()
  await settle()
  assert.ok(!viewOf(h.vt).includes('Models'))
  h.close() // programmatic close of the suspended overlay
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  await settle()
  assert.deepEqual(await pending, { kind: 'cancelled' })
  assert.ok(!viewOf(h.vt).includes('Models'), `a closed picker must not be resurrected:\n${viewOf(h.vt)}`)
  assert.equal(h.closeCount(), 0, 'the programmatic app-level close is not the picker user-close path')
  h.app.stop()
})

test('a fullscreen swap remounts the picker with view, selection and effort cursor intact', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'plain' }, fullscreen: true })
  h.vt.sendInput('\x1b[A') // Plain -> Sol
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[C') // Right into Sol's efforts
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Models › Sol'), `effort view must be open:\n${viewOf(h.vt)}`)
  h.vt.sendInput('\x1b[B') // effort cursor Medium -> High
  await h.vt.waitForRender()
  assert.ok(selectedRow(h.vt)?.includes('High'), `effort cursor must move to High:\n${viewOf(h.vt)}`)

  h.app.setFullscreen(false) // alt -> main
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Models › Sol'), `effort view must survive the screen swap:\n${viewOf(h.vt)}`)
  assert.ok(selectedRow(h.vt)?.includes('High'), `effort cursor must survive:\n${viewOf(h.vt)}`)
  assert.deepEqual(h.applied, [], 'a screen swap must not apply anything')
  assert.notEqual(h.app.focusedComponentForTest(), h.app.seatEditorForTest().component,
    'the remounted picker must hold PHYSICAL focus, not the editor')

  h.app.setFullscreen(true) // main -> alt
  await h.vt.waitForRender()
  await settle()
  assert.ok(viewOf(h.vt).includes('Models › Sol'), `effort view must survive the reverse swap:\n${viewOf(h.vt)}`)
  assert.ok(selectedRow(h.vt)?.includes('High'), `effort cursor must survive the reverse swap:\n${viewOf(h.vt)}`)
  assert.deepEqual(h.applied, [], 'no duplicate apply across the reverse swap')
  h.app.stop()
})

test('a fullscreen swap preserves the models search query and filtered selection', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'plain' }, fullscreen: true })
  h.vt.sendInput('sol') // filters Plain out
  await h.vt.waitForRender()
  assert.ok(viewOf(h.vt).includes('Sol') && !viewOf(h.vt).includes('Plain'))
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
  await settle()
  const view = viewOf(h.vt)
  assert.ok(view.includes('Sol'), `the filtered result must survive:\n${view}`)
  assert.ok(!view.includes('Plain'), `the query must survive (Plain still filtered):\n${view}`)
  h.vt.sendInput('\x1b') // Esc still closes the migrated picker
  await h.vt.waitForRender()
  assert.ok(!viewOf(h.vt).includes('Models'), `the migrated picker must close on Esc:\n${viewOf(h.vt)}`)
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

test('the migrated picker is disposed exactly once on close', async () => {
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

test('externally disposing the picker fences a late settlement from acting', async () => {
  let resolveOutcome!: (outcome: ModelApplyOutcome) => void
  const deferredOutcome = new Promise<ModelApplyOutcome>((resolve) => { resolveOutcome = resolve })
  const h = await openPicker({
    directory: EIGHT_MODELS,
    current: { provider: 'p1', model: 'm0' },
    apply: () => deferredOutcome,
  })
  h.vt.sendInput('\r') // dispatch the write
  await settle()
  h.picker.dispose() // external ownership teardown
  resolveOutcome('committed')
  await settle()
  assert.equal(h.closeCount(), 0, 'teardown is not a user choice and must not close an owned overlay')
  h.app.stop()
})

test('focus reaches the active search Input and is re-applied across the view swap', async () => {
  const h = await openPicker({ directory: EFFORT_DIRECTORY, current: { provider: 'p1', model: 'sol' } })
  h.picker.focused = true
  assert.ok(h.picker.render(72).join('\n').includes(CURSOR_MARKER), 'the models search Input must emit the cursor marker')
  h.picker.handleInput('\x1b[C') // into the effort view (no search input)
  assert.ok(!h.picker.render(72).join('\n').includes(CURSOR_MARKER), 'the effort view has no search Input')
  h.picker.handleInput('\x1b[D') // back to the models view
  assert.ok(h.picker.render(72).join('\n').includes(CURSOR_MARKER),
    'focus must be re-applied to the search Input after the view swap')
  h.app.stop()
})
