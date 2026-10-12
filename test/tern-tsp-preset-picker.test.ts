/** Production native /preset renderer: the mounted TSP presenter, driven through
 *  the REAL SDK pane.
 *
 * The scripted pane, the SDK connect and `mountTspRenderer` are real; only the
 * command-side `PresetPickerRequest` is a spy here, because the original
 * command/Host sinks are the subject of `tern-tsp-preset-runner.test.ts`. Every
 * assertion reads the REAL reconciled wire tree (the picker's own props, the
 * action bar, the node ids), so a renderer-local field can never satisfy one.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-preset-picker.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'
import { runOwned } from '../src/runtime/process/tasks.ts'
import type {
  PresetApplyOutcome,
  PresetDefaultOutcome,
  PresetPickerRoster,
} from '../src/app/command/preset-presentation.ts'
import type { ModelApplyOutcome, ModelPickerDirectory } from '../src/app/command/model-presentation.ts'
import { displayWidth, factLineColumns } from '../src/tui/tsp/picker-text.ts'
import { installTspPane, type TspPane } from './support/tsp-terminal-fixture.ts'
import { settle, waitUntil } from './support/tsp-runner-harness.ts'
import {
  MODEL_LAYER_PREFIX as M,
  PRESET_LAYER_PREFIX as P,
  layerNodes,
  pickerAction,
  pickerNode,
  pickerProps,
  sendAction,
  sendSelect,
  wireNodes,
  type WireNode,
} from './support/tsp-picker-wire.ts'

/* --------------------------------------------------------------- wire reads */

const props = (pane: TspPane): Record<string, unknown> => pickerProps(pane, P)
const node = (pane: TspPane): WireNode | undefined => pickerNode(pane, P)
const action = (pane: TspPane, id: string): Record<string, unknown> | undefined => pickerAction(pane, id, P)
const items = (pane: TspPane): Array<Record<string, unknown>> =>
  (props(pane).items ?? []) as Array<Record<string, unknown>>
const item = (pane: TspPane, id: string): Record<string, unknown> | undefined =>
  items(pane).find((entry) => entry.id === `preset:${id}`)
const actionIds = (pane: TspPane): string[] =>
  ((props(pane).actions ?? []) as Array<Record<string, unknown>>).map((entry) => String(entry.id))

/** One node's own visible text (properties only — never renderer state). */
function nodeText(entry: WireNode): string {
  if (typeof entry.p.text === 'string') return entry.p.text
  const spans = entry.p.spans
  if (!Array.isArray(spans)) return ''
  return spans.map((part) => typeof part === 'string'
    ? part
    : String((part as { t?: unknown }).t ?? '')).join('')
}

/** The preset layer's own `ui.text` lines, in RENDER order: the status facts,
 *  then the hint. The wire node map is keyed by id, so the order is re-derived
 *  from each line's own key instead of relying on the fold's insertion order. */
function textLines(pane: TspPane): string[] {
  const rank = (entry: WireNode): number => {
    const fact = /^preset-fact-(\d+)-/.exec(String(entry.p.key))
    return fact === null ? 1000 : Number(fact[1])
  }
  return layerNodes(pane, P)
    .filter((entry) => entry.k === 'text')
    .sort((left, right) => rank(left) - rank(right))
    .map(nodeText)
}

/** The one status line carrying a label, or `undefined`. */
function statusFact(pane: TspPane, label: string): string | undefined {
  return textLines(pane).find((line) => line.startsWith(`${label}:`))
}

const hint = (pane: TspPane): string | undefined => textLines(pane).at(-1)

/** One Details fact's COMPLETE value, read row by row: the row renderer
 *  ellipsizes what one row cannot show, so a fact is proven complete by
 *  concatenating its own rows (whitespace is a layout artifact of the wrap). */
function readableValue(pane: TspPane, key: string): string {
  return items(pane)
    .filter((entry) => String(entry.id) === `fact-${key}` || String(entry.id).startsWith(`fact-${key}-`))
    .map((entry) => String(entry.detail)).join('').replace(/\s+/g, '')
}

const select = (pane: TspPane, id: string): void => sendSelect(pane, `preset:${id}`, node(pane)!.id)
const send = (pane: TspPane, act: string): void => sendAction(pane, act, undefined, node(pane)!.id)

/* ------------------------------------------------------------------ fixtures */

/** One authoritative roster read plus its display facts. */
function roster(over: Partial<PresetPickerRoster> = {}): PresetPickerRoster {
  return {
    roster: {
      presets: [
        { id: 'standard' },
        { id: 'ptc' },
        { id: 'reviewer', name: 'My reviewer', description: 'Reviews diffs before merge.' },
        { id: 'legacy', name: 'Legacy preset', broken: 'plugin "legacy-tools" is not installed' },
      ],
      defaultId: 'ptc',
    },
    currentId: undefined,
    pendingId: undefined,
    defaultId: 'ptc',
    canSetDefault: true,
    ...over,
  }
}

/** One mounted renderer over the scripted pane, with command-side spies. */
async function mounted(
  t: { after(fn: () => unknown): void },
  options: {
    readonly subject?: { readonly sessionless: boolean }
    readonly withModel?: boolean
  } = {},
) {
  const subject = options.subject ?? { sessionless: true }
  const pane = installTspPane({ presetPicker: true, ...(options.withModel === true ? { modelPicker: true } : {}) })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, {
    requestExit() {},
    onFatal: (error) => assert.fail(String(error)),
  })
  t.after(() => renderer.dispose())
  renderer.bindInput({
    exit() {},
    cancel() {},
    submit: () => assert.fail('the picker must capture Enter'),
    steer() {},
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
  })
  const applies: string[] = []
  const defaults: string[] = []
  let resolveApply!: (outcome: PresetApplyOutcome) => void
  let resolveDefault!: (outcome: PresetDefaultOutcome) => void
  let retries = 0
  /** The captured-subject fence: a test can move the subject under the panel. */
  let subjectCurrent = true
  /** Open one more preset panel for the SAME request shape (a newer invocation). */
  const open = () => {
    assert.ok(renderer.presetPresentation)
    return renderer.presetPresentation.open({
      subject,
      isCurrent: () => subjectCurrent,
      retry: () => { retries += 1 },
      apply: (id: string) => new Promise<PresetApplyOutcome>((resolve) => {
        applies.push(id)
        resolveApply = resolve
      }),
      setDefault: (id: string) => new Promise<PresetDefaultOutcome>((resolve) => {
        defaults.push(id)
        resolveDefault = resolve
      }),
      runOwned: (label, task, runOptions) =>
        runOwned(label, task, { ...runOptions, diag: { debug() {}, warn() {}, error() {} } as never }),
    })
  }
  const handle = open()
  return {
    pane,
    renderer,
    subject,
    handle,
    applySpy: (id: string): Promise<PresetApplyOutcome> => new Promise((resolve) => {
      applies.push(id)
      resolveApply = resolve
    }),
    applies,
    defaults,
    retries: () => retries,
    reopens: () => retries,
    /** Move the subject: the panel's captured scope is no longer current. */
    moveSubject: () => { subjectCurrent = false },
    settleApply: (outcome: PresetApplyOutcome) => resolveApply(outcome),
    settleDefault: (outcome: PresetDefaultOutcome) => resolveDefault(outcome),
    open,
    ready: async (view: PresetPickerRoster = roster(), target = handle) => {
      target.setLoading()
      target.setRoster(view)
      await waitUntil('preset picker ready', () => props(pane).state === 'ready')
    },
  }
}

/** Focus `Use` through the keyboard and press Enter (the one write path). */
function writeUse(pane: TspPane): void {
  assert.ok(String(props(pane).selected).startsWith('preset:'), 'a preset row must be browsed')
  pane.key('\t')
  pane.key('\r')
}

/** Focus `Set new-session default` through the keyboard and press Enter. */
function writeDefault(pane: TspPane): void {
  pane.key('\t')
  pane.key('\u001b[C')
  pane.key('\r')
}

/* ------------------------------------------------------------ classification */

test('native Preset: Built-in and Custom come from the shipped classification', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // ONE compact native picker: the frozen size, no preview column, no scopes.
  assert.equal(props(pane).size, 'md')
  assert.equal(props(pane).preview, 'none')
  assert.equal(props(pane).title, 'Agent presets')
  assert.equal(props(pane).scopes, undefined)
  // Built-in first, then Custom; each group keeps the roster's own order.
  assert.deepEqual(items(pane).map((entry) => entry.id), [
    'preset:standard',
    'preset:ptc',
    'preset:reviewer',
    'preset:legacy',
  ])
  assert.equal(item(pane, 'standard')?.label, 'Standard mode')
  assert.match(String(item(pane, 'standard')?.detail), /^Built-in · Full coding agent/)
  assert.equal(item(pane, 'reviewer')?.label, 'My reviewer')
  assert.equal(item(pane, 'reviewer')?.detail, 'Custom · Reviews diffs before merge.')
  // A broken row keeps its reason readable and is marked, but stays browsable.
  assert.equal(item(pane, 'legacy')?.detail, 'Custom · Failed to load: plugin "legacy-tools" is not installed')
  assert.equal(item(pane, 'legacy')?.dot, 'error')
  assert.deepEqual(item(pane, 'legacy')?.badges, [{ text: 'Failed to load', tone: 'error' }])
  assert.equal(item(pane, 'legacy')?.disabled, undefined)
  // The committed facts are badges on the ROW, never a rewritten label.
  assert.deepEqual(item(pane, 'ptc')?.badges, [{ text: 'Default' }])
})

test('native Preset: a user preset reusing a shipped id stays Custom and keeps its own copy', async (t) => {
  const m = await mounted(t)
  await m.ready({
    roster: { presets: [{ id: 'minimal', name: 'My minimal', description: 'mine' }], defaultId: 'minimal' },
    currentId: undefined,
    pendingId: undefined,
    defaultId: 'minimal',
    canSetDefault: true,
  })
  const { pane } = m
  assert.equal(item(pane, 'minimal')?.label, 'My minimal')
  assert.equal(item(pane, 'minimal')?.detail, 'Custom · mine')
  assert.deepEqual(item(pane, 'minimal')?.badges, [{ text: 'Default' }])
})

/* --------------------------------------------------------- independent facts */

test('native Preset: Current, Next session, New-session default and Draft are independent', async (t) => {
  const sessionless = await mounted(t)
  await sessionless.ready(roster({ pendingId: 'reviewer' }))
  const pane = sessionless.pane
  assert.equal(statusFact(pane, 'Next session'), 'Next session: reviewer')
  assert.equal(statusFact(pane, 'New-session default'), 'New-session default: ptc')
  assert.equal(statusFact(pane, 'Current session'), undefined, 'no Session never fabricates a Current')
  assert.deepEqual(props(pane).current, [], 'a sessionless panel paints no current marker')
  // The browse target starts on the real committed fact and needs no Draft marker.
  assert.equal(props(pane).selected, 'preset:reviewer')
  assert.equal(statusFact(pane, 'Draft'), undefined)
  assert.deepEqual(item(pane, 'reviewer')?.badges, [{ text: 'Next session' }])
  // Browsing elsewhere states the uncommitted target as its OWN marker.
  select(pane, 'standard')
  await waitUntil('browse target', () => props(pane).selected === 'preset:standard')
  assert.equal(statusFact(pane, 'Draft'), 'Draft: standard')
  assert.deepEqual(item(pane, 'standard')?.badges, [{ text: 'Draft' }])
  assert.equal(sessionless.applies.length, 0, 'browsing is never a write')

  const live = await mounted(t, { subject: { sessionless: false } })
  await live.ready(roster({ currentId: 'standard' }))
  assert.equal(statusFact(live.pane, 'Current session'), 'Current session: standard')
  assert.equal(statusFact(live.pane, 'Next session'), undefined, 'a live panel invents no Next session')
  assert.equal(props(live.pane).selected, 'preset:standard')
  assert.deepEqual(props(live.pane).current, ['preset:standard'])
  assert.deepEqual(item(live.pane, 'standard')?.badges, [{ text: 'Current' }])
  assert.deepEqual(item(live.pane, 'ptc')?.badges, [{ text: 'Default' }])
})

/* ------------------------------------------------------------------------ K2 */

test('native Preset K2: the list only browses; ONE focused action writes once', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  select(pane, 'reviewer')
  await waitUntil('browse', () => props(pane).selected === 'preset:reviewer')
  assert.equal(m.applies.length, 0)
  assert.equal(m.defaults.length, 0)
  // Enter on the list never writes.
  pane.key('\r')
  await waitUntil('Enter is browse-only', () => hint(pane) === 'Tab: actions')
  assert.equal(m.applies.length, 0, 'Enter on the list is not a write')
  // Tab reaches the action bar, whose first AVAILABLE write takes the cue.
  pane.key('\t')
  await waitUntil('action zone', () => String(action(pane, 'use')?.label).startsWith('▸'))
  assert.equal(action(pane, 'use')?.label, '▸ Use for next session')
  assert.equal(hint(pane), '←→ · Enter')
  assert.equal(m.applies.length, 0, 'focusing an action is not a write')
  // Only Enter on the focused action commits, exactly once.
  pane.key('\r')
  await waitUntil('one admitted write', () => m.applies.length === 1)
  assert.deepEqual(m.applies, ['reviewer'])
  // The pending seat refuses every further mutation and every further write.
  send(pane, 'use')
  select(pane, 'legacy')
  pane.key('\r')
  await waitUntil('pending is visible', () => action(pane, 'use')?.label === 'Applying preset…')
  assert.equal(action(pane, 'use')?.disabled, true)
  assert.equal(m.applies.length, 1, 'an admitted write is never re-entered')
  await waitUntil('no cue while pending', () => !String(action(pane, 'close')?.label).startsWith('▸'))
  pane.key('\u001b')
  await waitUntil('Esc closes an admitted write', () => node(pane) === undefined)
})

test('native Preset K2: arrows cycle only the ENABLED actions and never park on a dead one', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  select(pane, 'reviewer')
  await waitUntil('browse', () => props(pane).selected === 'preset:reviewer')
  // Entering the bar lands on the first AVAILABLE write; the arrows then cycle
  // in RENDER order (Details, Use, Set default, Close), skipping disabled ones.
  pane.key('\t')
  await waitUntil('use focused', () => String(action(pane, 'use')?.label).startsWith('▸'))
  pane.key('\u001b[C')
  await waitUntil('default focused', () => String(action(pane, 'set-default')?.label).startsWith('▸'))
  assert.equal(action(pane, 'use')?.label, 'Use for next session')
  pane.key('\u001b[C')
  await waitUntil('close focused', () => String(action(pane, 'close')?.label).startsWith('▸'))
  pane.key('\u001b[C')
  await waitUntil('details focused', () => String(action(pane, 'details')?.label).startsWith('▸'))
  pane.key('\u001b[C')
  await waitUntil('wraps to use', () => String(action(pane, 'use')?.label).startsWith('▸'))
  // The row that IS the recorded default cannot set it again: the cycle skips it.
  select(pane, 'ptc')
  await waitUntil('default row', () => props(pane).selected === 'preset:ptc')
  assert.equal(action(pane, 'set-default')?.disabled, true)
  pane.key('\u001b[C')
  await waitUntil('focus skips the disabled write', () => String(action(pane, 'close')?.label).startsWith('▸'))
  pane.key('\u001b[C')
  await waitUntil('skips to details', () => String(action(pane, 'details')?.label).startsWith('▸'))
  // A broken row: neither write is available, so focus falls back to Details.
  select(pane, 'legacy')
  await waitUntil('broken row', () => props(pane).selected === 'preset:legacy')
  assert.equal(action(pane, 'use')?.disabled, true)
  assert.equal(action(pane, 'set-default')?.disabled, true)
  pane.key('\t')
  pane.key('\t')
  await waitUntil('fallback focus', () => String(action(pane, 'details')?.label).startsWith('▸'))
  assert.notEqual(action(pane, 'use')?.label, '▸ Use for next session', 'a disabled action never carries the cue')
})

test('native Preset: a broken row is readable but can never be written', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  select(pane, 'legacy')
  await waitUntil('broken row', () => props(pane).selected === 'preset:legacy')
  send(pane, 'use')
  send(pane, 'set-default')
  await waitUntil('still ready', () => props(pane).state === 'ready')
  assert.equal(m.applies.length, 0, 'a broken row is never written')
  assert.equal(m.defaults.length, 0)
  // The reason is complete on the Details page.
  send(pane, 'details')
  await waitUntil('details page', () => props(pane).title === 'Preset details')
  const facts = items(pane)
  assert.ok(facts.some((entry) => entry.label === 'Failed to load'), 'the reason has its own labelled fact')
  assert.match(readableValue(pane, 'broken'), /legacy-tools/, 'the reason is readable in full')
  assert.ok(facts.some((entry) => entry.label === 'Type' && entry.detail === 'Custom'))
})

/* ------------------------------------------------------------- details page */

test('native Preset: the Details page is read-only, complete and keyboard-scrollable', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  select(pane, 'reviewer')
  await waitUntil('browse', () => props(pane).selected === 'preset:reviewer')
  // The page is the action bar's OWN Details action (its keyboard reachability
  // is proven by the arrow-cycle test above this one).
  send(pane, 'details')
  await waitUntil('details page', () => props(pane).title === 'Preset details')
  const facts = items(pane)
  assert.deepEqual(facts.slice(0, 3).map((entry) => entry.label), ['Name', 'ID', 'Type'])
  assert.equal(readableValue(pane, 'description'), 'Reviewsdiffsbeforemerge.')
  // Enter never writes here; the arrows only move the reading cursor.
  const before = props(pane).selected
  pane.key('\r')
  pane.key('\u001b[B')
  await waitUntil('fact cursor moved', () => props(pane).selected !== before)
  assert.equal(m.applies.length, 0, 'the Details page never writes')
  // Back returns to the list and keeps the browse target.
  send(pane, 'back')
  await waitUntil('back to the list', () => props(pane).title === 'Agent presets')
  assert.equal(props(pane).selected, 'preset:reviewer')
  // Esc from the details page does the same; Esc on the list closes.
  send(pane, 'details')
  await waitUntil('details again', () => props(pane).title === 'Preset details')
  pane.key('\u001b')
  await waitUntil('Esc leaves the page', () => props(pane).title === 'Agent presets')
  pane.key('\u001b')
  await waitUntil('Esc closes', () => node(pane) === undefined)
})

test('native Preset: the Details facts stay complete for CJK, emoji, newlines and no-space ids', async (t) => {
  const m = await mounted(t, { subject: { sessionless: false } })
  const long = `${'字'.repeat(80)}\n${'e\u0301moji 🧪 '.repeat(40)}`
  const id = `no-space-${'x'.repeat(120)}:fact-1`
  const name = `名前 ${'🎛'.repeat(40)}`
  await m.ready({
    roster: {
      presets: [{ id: 'standard' }, { id, name, description: long }],
      defaultId: 'standard',
    },
    currentId: 'standard',
    pendingId: undefined,
    defaultId: 'standard',
    canSetDefault: true,
  })
  const { pane } = m
  select(pane, id)
  await waitUntil('special row', () => props(pane).selected === `preset:${id}`)
  send(pane, 'details')
  await waitUntil('details page', () => props(pane).title === 'Preset details')
  const facts = items(pane)
  // The unbroken id, the emoji/CJK name and the long description all survive in
  // full: joining each fact's own rows reproduces its whole value.
  assert.equal(readableValue(pane, 'id'), id.replace(/\s+/g, ''))
  assert.equal(readableValue(pane, 'name'), name.replace(/\s+/g, ''))
  assert.equal(readableValue(pane, 'description'), long.replace(/\s+/g, ''))
  const description = facts.filter((entry) => String(entry.id).startsWith('fact-description'))
  assert.ok(description.length > 4, 'a long description becomes several readable rows')
  assert.match(String(description[0]!.detail), /^字/, 'the CJK head is the first row')
  // Every fragment fits its own measured one-line slot: nothing is ellipsized.
  for (const entry of facts) {
    assert.ok(displayWidth(String(entry.detail)) <= factLineColumns(false, String(entry.label)),
      `every fact row fits its one-line slot: ${String(entry.id)} :: ${String(entry.detail)}`)
  }
  // The keyboard reaches the LAST fact row.
  const last = facts.at(-1)!
  // The cursor starts on the first row, so the tail is `length - 1` steps away.
  for (let index = 1; index < facts.length; index += 1) pane.key('\u001b[B')
  await waitUntil('cursor reaches the tail', () => props(pane).selected === last.id)
})

/* ------------------------------------------------------------ load / error */

test('native Preset: Loading keeps the search editable, looks inert and Esc closes', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  await waitUntil('loading frame', () => props(pane).state === 'loading')
  assert.deepEqual(actionIds(pane), ['close'], 'a loading bar offers no write')
  assert.equal(hint(pane), 'Loading agent presets…')
  pane.key('rev')
  await waitUntil('query typed', () => props(pane).query === 'rev')
  pane.key('\r')
  await waitUntil('Enter does not write', () => m.applies.length === 0)
  pane.key('\u001b')
  await waitUntil('Esc closes a loading panel', () => node(pane) === undefined)
})

test('native Preset: a failed read offers ONE Retry, keeps Tab in its bar and re-reads', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  m.handle.setLoadError('agent presets unavailable in this deployment')
  await waitUntil('error frame', () => props(pane).state === 'error')
  assert.equal(props(pane).message, 'agent presets unavailable in this deployment')
  assert.deepEqual(actionIds(pane), ['retry', 'close'])
  assert.equal(hint(pane), 'Retry first')
  pane.key('\t')
  await waitUntil('retry focused', () => String(action(pane, 'retry')?.label).startsWith('▸'))
  pane.key('\u001b[Z')
  await waitUntil('Shift+Tab stays in the bar', () => String(action(pane, 'retry')?.label).startsWith('▸'))
  pane.key('\r')
  await waitUntil('retry re-enters loading', () => props(pane).state === 'loading')
  assert.equal(m.retries(), 1, 'the ORIGINAL read owner is asked exactly once')
  assert.equal(m.applies.length, 0)
  // A second Enter while the read runs cannot admit another read.
  pane.key('\r')
  await waitUntil('no second read', () => m.retries() === 1)
  assert.equal(m.retries(), 1)
})

/* ------------------------------------------------------------- settlements */

test('native Preset: a staged, committed or indeterminate write dismisses the picker', async (t) => {
  for (const outcome of [
    { kind: 'pending' as const, preset: 'reviewer' },
    { kind: 'switched' as const, preset: 'reviewer' },
  ]) {
    const m = await mounted(t)
    await m.ready()
    select(m.pane, 'reviewer')
    await waitUntil('browse', () => props(m.pane).selected === 'preset:reviewer')
    writeUse(m.pane)
    await waitUntil('write admitted', () => m.applies.length === 1)
    m.settleApply(outcome)
    await waitUntil(`${outcome.kind} dismisses`, () => node(m.pane) === undefined)
  }
  const m = await mounted(t)
  await m.ready()
  writeUse(m.pane)
  await waitUntil('write admitted', () => m.applies.length === 1)
  m.settleApply({ kind: 'indeterminate', message: 'the switch was dispatched' })
  await waitUntil('indeterminate dismisses', () => node(m.pane) === undefined)
})

test('native Preset: a refused write keeps the picker usable and states why', async (t) => {
  const rejected = await mounted(t)
  await rejected.ready()
  writeUse(rejected.pane)
  await waitUntil('write admitted', () => rejected.applies.length === 1)
  rejected.settleApply({ kind: 'rejected', message: 'preset "reviewer" does not resolve' })
  await waitUntil('refusal stays usable', () => props(rejected.pane).state === 'ready')
  assert.equal(props(rejected.pane).message, 'preset "reviewer" does not resolve')
  assert.equal(props(rejected.pane).title, 'Agent presets')
  assert.ok(item(rejected.pane, 'reviewer'), 'the rows survive a refused write')

  const locked = await mounted(t, { subject: { sessionless: false } })
  await locked.ready(roster({ currentId: 'standard' }))
  writeUse(locked.pane)
  await waitUntil('write admitted', () => locked.applies.length === 1)
  locked.settleApply({ kind: 'locked', sessionId: 'session-1' })
  await waitUntil('locked stays usable', () => props(locked.pane).state === 'ready')
  assert.equal(props(locked.pane).message, 'Locked: this session has already started.')
})

test('native Preset: the default write is explicit, scoped and dismisses', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  select(pane, 'reviewer')
  await waitUntil('browse', () => props(pane).selected === 'preset:reviewer')
  writeDefault(pane)
  await waitUntil('default write admitted', () => m.defaults.length === 1)
  assert.deepEqual(m.defaults, ['reviewer'])
  await waitUntil('pending default is visible', () => action(pane, 'set-default')?.label === 'Saving default…')
  m.settleDefault({ kind: 'saved', preset: 'reviewer' })
  await waitUntil('saved dismisses', () => node(pane) === undefined)
  // An UNCONFIRMED settings write dismisses too: a raise proves no rollback, so
  // the next read — never this panel's snapshot — is authoritative.
  const second = await mounted(t)
  await second.ready()
  select(second.pane, 'reviewer')
  await waitUntil('browse', () => props(second.pane).selected === 'preset:reviewer')
  writeDefault(second.pane)
  await waitUntil('default write admitted', () => second.defaults.length === 1)
  second.settleDefault({ kind: 'unconfirmed', message: 'settings write failed' })
  await waitUntil('unconfirmed dismisses', () => node(second.pane) === undefined)
})

/* ------------------------------------------------------------------- empty */

test('native Preset: an empty roster is a readable state with no dead focus', async (t) => {
  const m = await mounted(t)
  await m.ready(roster({ roster: { presets: [], defaultId: undefined }, defaultId: undefined }))
  const { pane } = m
  assert.equal(props(pane).empty, 'No agent presets configured.')
  assert.deepEqual(items(pane), [])
  assert.equal(action(pane, 'use')?.disabled, true)
  assert.equal(action(pane, 'set-default')?.disabled, true)
  assert.equal(action(pane, 'details')?.disabled, true)
  // No dead focus: the cue lands on the one action that can act.
  pane.key('\t')
  await waitUntil('close focused', () => String(action(pane, 'close')?.label).startsWith('▸'))
  pane.key('\r')
  await waitUntil('Close works', () => node(pane) === undefined)
  assert.equal(m.applies.length, 0)
})

/* --------------------------------------------------- ids and search safety */

test('native Preset: special ids and the search never collide with a control', async (t) => {
  const m = await mounted(t)
  const ids = ['scope-all', 'effort:high', 'fact:name', 'close', '详情', 'a:b:c']
  await m.ready({
    roster: { presets: ids.map((id) => ({ id, name: `Row ${id}` })), defaultId: ids[0] },
    currentId: undefined,
    pendingId: undefined,
    defaultId: ids[0],
    canSetDefault: true,
  })
  const { pane } = m
  assert.ok(items(pane).every((entry) => ids.includes(String(entry.id).slice('preset:'.length))))
  // A row whose id equals an ACTION id still browses, never acts.
  select(pane, 'close')
  await waitUntil('action-named row browses', () => props(pane).selected === 'preset:close')
  assert.ok(node(pane), 'the panel is still open')
  assert.equal(m.applies.length, 0)
  // A row whose id looks like another namespace still browses.
  select(pane, 'fact:name')
  await waitUntil('fact-named row browses', () => props(pane).selected === 'preset:fact:name')
  // The search filters by name/id, and Enter still writes nothing.
  pane.key('详情')
  await waitUntil('unicode query', () => props(pane).query === '详情')
  assert.deepEqual(items(pane).map((entry) => entry.id), ['preset:详情'])
  pane.key('\r')
  await waitUntil('search Enter writes nothing', () => m.applies.length === 0)
  // A Details fact-row id is inert on the list page.
  sendSelect(pane, 'fact-name', node(pane)!.id)
  await waitUntil('fact row is inert', () => props(pane).selected === 'preset:详情')
})

test('native Preset: a retired frame id or a foreign surface never reaches the panel', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  const staleId = node(pane)!.id
  select(pane, 'reviewer')
  await waitUntil('new revision', () => node(pane)!.id !== staleId)
  pane.event({ ev: 'select', sf: 'retired-surface', id: node(pane)!.id, item: 'preset:legacy' })
  pane.event({ ev: 'select', sf: pane.frames().at(-1)!.sf, id: staleId, item: 'preset:legacy' })
  pane.event({ ev: 'select', sf: pane.frames().at(-1)!.sf, id: `preset-999-rev-1`, item: 'preset:legacy' })
  pane.event({ ev: 'action', sf: pane.frames().at(-1)!.sf, id: staleId, act: 'use' })
  await waitUntil('stale receivers are inert', () => props(pane).selected === 'preset:reviewer')
  assert.equal(m.applies.length, 0)
})

test('native Preset: a synthetic event naming a DISABLED action is refused at admission', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // The hydrated panel already highlights the recorded default, so its own
  // default write is disabled: an SDK `action` event naming it can never
  // re-write the value.
  assert.equal(props(pane).selected, 'preset:ptc')
  assert.equal(action(pane, 'set-default')?.disabled, true)
  const shown = node(pane)!.id
  const before = JSON.stringify(props(pane))
  send(pane, 'set-default')
  await settle(250)
  assert.equal(m.defaults.length, 0, 'a disabled action never writes')
  assert.equal(node(pane)?.id, shown, 'and it never re-renders the panel')
  assert.equal(JSON.stringify(props(pane)), before, 'the visible panel is unchanged')
  // A broken row disables BOTH writes; the same event path is refused too.
  select(pane, 'legacy')
  await waitUntil('broken row', () => props(pane).selected === 'preset:legacy')
  assert.equal(action(pane, 'use')?.disabled, true)
  assert.equal(action(pane, 'set-default')?.disabled, true)
  send(pane, 'use')
  send(pane, 'set-default')
  await settle(250)
  assert.equal(m.applies.length, 0, 'a broken row is never written through the event path')
  assert.equal(m.defaults.length, 0)
  assert.ok(node(pane), 'the panel is still mounted')
})

/* ------------------------------------------------- supersession and staleness */

test('native Preset: a settlement after the subject moved repaints nothing', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  writeUse(pane)
  await waitUntil('write admitted', () => m.applies.length === 1)
  // The pending frame must have committed before the count is read, otherwise a
  // frame still in flight would masquerade as a settlement-caused repaint.
  await waitUntil('the pending bar is visible', () => action(pane, 'use')?.label === 'Applying preset…')
  const frames = pane.frameCount()
  const admitted = node(pane)!.id
  // The captured subject moves while the admitted write is still in flight: the
  // settlement owns NO repaint and NO close decision.
  m.moveSubject()
  m.settleApply({ kind: 'pending', preset: 'ptc' })
  await settle(250)
  assert.equal(pane.frameCount(), frames, 'a stale settlement commits no frame')
  assert.equal(node(pane)?.id, admitted, 'and it never repaints the panel')
  // The fence retires the panel on its next touch, so it cannot stay reachable
  // as a live wire receiver after its subject is gone; the renderer's own
  // hydration frame is what removes the layer from the wire.
  m.handle.setRoster(roster({ pendingId: 'reviewer' }))
  assert.equal(m.handle.isDisposed(), true, 'the moved subject retired the panel')
  assert.equal(props(pane).selected, 'preset:ptc', 'the late roster never hydrated it')
  m.renderer.display.beginSessionHydration()
  await waitUntil('the renderer drops the retired layer', () => node(pane) === undefined)
  assert.equal(m.applies.length, 1, 'the settled write was never re-entered')
})

test('native Preset: a late settlement never touches the panel that replaced it', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  writeUse(pane)
  await waitUntil('the first panel admitted a write', () => m.applies.length === 1)
  // A NEWER `/preset` invocation replaces the panel while the first write is
  // still in flight (the renderer retires the old one before opening the new).
  const second = m.open()
  second.setRoster(roster({ pendingId: 'reviewer' }))
  await waitUntil('the new panel is ready', () => props(pane).state === 'ready'
    && props(pane).selected === 'preset:reviewer')
  const newPanel = node(pane)!.id
  // The retired panel's write settles: it owns no close and no repaint.
  m.settleApply({ kind: 'switched', preset: 'ptc' })
  await settle(300)
  assert.equal(node(pane)?.id, newPanel, 'the newer panel is still the mounted one')
  assert.equal(props(pane).selected, 'preset:reviewer', 'and it kept its own browse target')
  assert.equal(props(pane).state, 'ready')
})

test('native Preset: a late default-write settlement never touches the replaced panel', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Admit a default write on the FIRST panel (a row that is not already the
  // recorded default, so its own default action is enabled), then replace that
  // panel with a newer invocation while the write is still in flight.
  select(pane, 'reviewer')
  await waitUntil('default action available', () => props(pane).selected === 'preset:reviewer'
    && action(pane, 'set-default')?.disabled !== true)
  writeDefault(pane)
  await waitUntil('the default write was admitted', () => m.defaults.length === 1)
  const second = m.open()
  second.setRoster(roster({ pendingId: 'reviewer' }))
  await waitUntil('the new panel is ready', () => props(pane).state === 'ready'
    && props(pane).selected === 'preset:reviewer')
  const newPanel = node(pane)!.id
  // The retired panel's default settlement owns no dismiss and no repaint.
  m.settleDefault({ kind: 'saved', preset: 'ptc' })
  await settle(300)
  assert.equal(node(pane)?.id, newPanel, 'the newer panel is still the mounted one')
  assert.equal(props(pane).selected, 'preset:reviewer', 'and it kept its own browse target')
  assert.equal(props(pane).state, 'ready')
})

test('native Preset: a late read never hydrates a moved subject', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  await waitUntil('loading panel', () => props(pane).state === 'loading')
  const frames = pane.frameCount()
  m.moveSubject()
  // The command's one read owner answers late: the panel belongs to the old
  // subject, so neither a roster nor a failure may reach it.
  m.handle.setRoster(roster())
  m.handle.setLoadError('late failure')
  await settle(200)
  assert.equal(pane.frameCount(), frames, 'a late read commits no frame')
  assert.equal(props(pane).state, 'loading', 'and it never hydrates the moved panel')
  assert.equal(m.handle.isDisposed(), true, 'the fence retired the panel')
})

/* -------------------------------------------------- layer ownership / modal */

test('native Preset: one layer carries exactly ONE picker and the status facts above it', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  assert.equal(layerNodes(pane, P).filter((entry) => entry.k === 'picker').length, 1)
  assert.deepEqual(textLines(pane), [
    'Next session: none',
    'New-session default: ptc',
    'Tab: actions',
  ])
  // Every read/interactive node of the frame carries the preset key, so no
  // Model node can ever satisfy a preset assertion.
  assert.equal(wireNodes(pane).filter((entry) => /preset-(fact|hint)-\d/u.test(entry.id)).length, 3)
  assert.equal(wireNodes(pane).filter((entry) => /\.preset-\d+-rev-\d+$/u.test(entry.id)).length, 1)
})

test('native Preset: opening Model and Preset alternates one layer, never two', async (t) => {
  const m = await mounted(t, { withModel: true })
  await m.ready()
  const { pane, renderer } = m
  assert.ok(renderer.modelPresentation, 'this pane advertises both native kinds')
  assert.equal(pickerNode(pane, M), undefined)
  // Opening Model retires the Preset panel.
  const model = renderer.modelPresentation.open({
    subject: { sessionless: true },
    isCurrent: () => true,
    retry() {},
    apply: () => 'superseded' as ModelApplyOutcome,
    runOwned: (label, task, runOptions) =>
      runOwned(label, task, { ...runOptions, diag: { debug() {}, warn() {}, error() {} } as never }),
  })
  await waitUntil('Model replaced the Preset layer', () => pickerNode(pane, M) !== undefined && node(pane) === undefined)
  model.setDirectory({
    directory: {
      default: { provider: 'a', model: 'm' },
      routableProviders: ['a'],
      groups: [{ id: 'a', name: 'A', models: [{ id: 'm', name: 'M' }] }],
      failures: [],
    },
    current: undefined,
  } satisfies ModelPickerDirectory)
  await waitUntil('only the model picker is mounted', () =>
    layerNodes(pane, M).filter((entry) => entry.k === 'picker').length === 1)
  // And opening Preset again retires the Model panel.
  const again = m.open()
  again.setRoster(roster())
  await waitUntil('Preset replaced the Model layer', () =>
    pickerNode(pane, P) !== undefined && pickerNode(pane, M) === undefined)
  assert.equal(layerNodes(pane, M).filter((entry) => entry.k === 'picker').length, 0)
})

test('native Preset: hydration and dispose retire the panel for good', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane, renderer } = m
  assert.ok(node(pane))
  renderer.display.beginSessionHydration()
  await waitUntil('hydration retires the panel', () => node(pane) === undefined)
  // A late command callback can never reopen a retired panel.
  m.handle.setRoster(roster({ pendingId: 'reviewer' }))
  await waitUntil('late hydrate is refused', () => node(pane) === undefined)
  await renderer.dispose()
  await renderer.dispose()
})

/* --------------------------------------------------------- capability gates */

test('native Preset: a pane without the picker kind installs no preset presenter', async (t) => {
  const pane = installTspPane({ kinds: ['col', 'card', 'text'] })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, { requestExit() {}, onFatal: () => {} })
  t.after(() => renderer.dispose())
  assert.equal(renderer.presetPresentation, undefined, 'fail closed before any handler runs')
})
