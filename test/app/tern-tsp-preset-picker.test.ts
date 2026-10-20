/** Production native /preset renderer: the mounted TSP presenter, driven through
 *  the REAL SDK pane.
 *
 * The scripted pane, the SDK connect and `mountTspRenderer` are real; only the
 * command-side `PresetPickerRequest` is a spy here, because the original
 * command/Host sinks are the subject of `tern-tsp-preset-runner.test.ts`. Every
 * assertion reads the REAL reconciled wire tree (the picker's own props, the
 * Details overlay's text, the node ids), so a renderer-local field can never
 * satisfy one.
 *
 * The page contract is the v4 TWO-page shape: the catalogue (ONE native picker
 * with the Owner-shaped THREE-button footer — the only writer) and the Details
 * page (ONE `lg` overlay: complete identity, inline official guide, the native
 * `ui.row({onClick})` Back navigation, strictly read-only). The wire array order is Owner ruling "a" (`Close`,
 * `Set default`, `Use*`); the PAINTED order is the client's own pack rule and is
 * the real-pane lane's claim, not this suite's.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-preset-picker.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer } from '../../src/tui/tsp/session.ts'
import { runOwned } from '../../src/runtime/process/tasks.ts'
import type {
  PresetApplyOutcome,
  PresetDefaultOutcome,
  PresetPickerRoster,
} from '../../src/app/command/preset-presentation.ts'
import type { ModelApplyOutcome, ModelPickerDirectory } from '../../src/app/command/model-presentation.ts'
import { BUILT_IN_GROUP_ID, CUSTOM_GROUP_ID } from '../../src/tui/tsp/preset-picker-state.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'
import {
  MODEL_LAYER_PREFIX as M,
  PRESET_LAYER_PREFIX as P,
  clickLayerNode,
  layerNodes,
  pickerActionByBase,
  pickerNode,
  pickerProps,
  scrollOps,
  sendActivate,
  sendAction,
  sendPickerAction,
  sendSelect,
  type WireNode,
} from '../support/tsp-picker-wire.ts'

/* --------------------------------------------------------------- wire reads */

const props = (pane: TspPane): Record<string, unknown> => pickerProps(pane, P)
const picker = (pane: TspPane): WireNode | undefined => pickerNode(pane, P)
const items = (pane: TspPane): Array<Record<string, unknown>> =>
  (props(pane).items ?? []) as Array<Record<string, unknown>>
const item = (pane: TspPane, id: string): Record<string, unknown> | undefined =>
  items(pane).find((entry) => entry.id === `preset:${id}`)
const action = (pane: TspPane, base: string): Record<string, unknown> | undefined =>
  pickerActionByBase(pane, base, P)
const actionIds = (pane: TspPane): string[] =>
  ((props(pane).actions ?? []) as Array<Record<string, unknown>>).map((entry) => String(entry.id))
const layer = (pane: TspPane): WireNode[] => layerNodes(pane, P)

/** One node's own visible text (properties only — never renderer state). */
function nodeText(entry: WireNode): string {
  if (typeof entry.p.text === 'string') return entry.p.text
  const spans = entry.p.spans
  if (!Array.isArray(spans)) return ''
  return spans.map((part) => typeof part === 'string'
    ? part
    : String((part as { t?: unknown }).t ?? '')).join('')
}

/** One node's own text by the key it was built from. */
function textOf(pane: TspPane, key: string): string | undefined {
  const entry = layer(pane).find((node) => node.k === 'text' && node.id.endsWith(`.${key}`))
  return entry === undefined ? undefined : nodeText(entry)
}

/** The Details overlay, or `undefined` while the catalogue shows. The page
 *  REPLACES the picker, so both can never be mounted together. */
const detailsNode = (pane: TspPane): WireNode | undefined =>
  layer(pane).find((node) => node.k === 'overlay' && node.id.includes('preset-details-'))
const inDetails = (pane: TspPane): boolean => detailsNode(pane) !== undefined
/** The reading body: ONE identity per reading, the node `scroll` ops address. */
const readingBody = (pane: TspPane): WireNode | undefined =>
  layer(pane).find((node) => node.k === 'col' && node.id.includes('preset-reading-body-'))
/** The Details page's ONE interactive node: the native Back navigation row. */
const backButton = (pane: TspPane): WireNode | undefined =>
  layer(pane).find((node) => node.k === 'row' && node.id.includes('preset-details-back-'))

/** The Back row's own visible label (the row's text descendants joined). */
const backLabel = (pane: TspPane): string => {
  const row = backButton(pane)
  if (row === undefined) return ''
  const prefix = `${row.id}.`
  return layer(pane)
    .filter((node) => node.k === 'text' && node.id.startsWith(prefix))
    .map(nodeText)
    .join('')
}
const guideMarkdown = (pane: TspPane): string | undefined => {
  const entry = layer(pane).find((node) => node.k === 'md')
  return entry === undefined ? undefined : nodeText(entry)
}

/** The catalogue footer entry that carries the `Verb [Enter]` cue right now. */
function catalogueFocus(pane: TspPane): string | undefined {
  for (const base of ['use', 'retry', 'set-default', 'close']) {
    const entry = action(pane, base)
    if (entry !== undefined && String(entry.label).includes('[Enter]')) return base
  }
  return undefined
}

/** The ONE keyboard hint rides the picker's native tooltip slot (Owner ruling "a":
 *  the ready-phase picker paints no status row). */
const hint = (pane: TspPane): string => String(props(pane).subtitle ?? '')

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
    applies,
    defaults,
    retries: () => retries,
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

/* ------------------------------------------------------------- interaction */

const browse = (pane: TspPane, id: string): void => sendSelect(pane, `preset:${id}`, picker(pane)!.id)

/** Open the highlighted preset's Details page from the keyboard (the card's Enter). */
async function enterDetails(pane: TspPane): Promise<void> {
  pane.key('\r')
  await waitUntil('the Details page replaced the picker', () => inDetails(pane))
}

/** Move the catalogue's keyboard onto one footer entry through real Tab presses. */
async function tabToCatalogueAction(pane: TspPane, base: string): Promise<void> {
  // ONE Tab moves the keyboard from the list into the footer; the ring itself is
  // walked with the arrows (K2: arrows move WITHIN the action zone — Tab only
  // toggles the two zones).
  pane.key('\t')
  await waitUntil('the footer took the keyboard', () => catalogueFocus(pane) !== undefined)
  for (let attempt = 0; attempt < 6 && catalogueFocus(pane) !== base; attempt += 1) {
    const before = catalogueFocus(pane)
    const frames = pane.frameCount()
    pane.key('\u001b[C')   // ArrowRight: next entry in the ring
    await waitUntil(`the ring moved off ${String(before)} (attempt ${attempt})`, () =>
      pane.frameCount() > frames && catalogueFocus(pane) !== before)
  }
  assert.equal(catalogueFocus(pane), base, 'the requested footer entry owns Enter')
}

/* ------------------------------------------------------------ catalog shape */

test('native Preset: the catalogue is ONE native cards picker grouped Built-in then Custom', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // The client's own card layout, the frozen `md` sheet, no preview region and no
  // scopes column: one column at EVERY pane width.
  assert.equal(props(pane).layout, 'cards')
  assert.equal(props(pane).size, 'md')
  assert.equal(props(pane).preview, 'none')
  assert.equal(props(pane).title, 'Agent presets')
  assert.equal(props(pane).scopes, undefined)
  assert.equal(props(pane).columns, undefined)
  // Built-in first, then Custom; each group's count is the number of cards below it,
  // and the group ids live in the module's reserved namespace.
  assert.deepEqual(props(pane).order, [
    { group: BUILT_IN_GROUP_ID, label: 'Built-in', count: 2 },
    'preset:standard',
    'preset:ptc',
    { group: CUSTOM_GROUP_ID, label: 'Custom', count: 2 },
    'preset:reviewer',
    'preset:legacy',
  ])
  assert.equal(props(pane).total, 4)
  assert.deepEqual(items(pane).map((entry) => entry.id), [
    'preset:standard',
    'preset:ptc',
    'preset:reviewer',
    'preset:legacy',
  ])
  assert.equal(item(pane, 'standard')?.label, 'Standard mode')
  assert.match(String(item(pane, 'standard')?.detail), /^Built-in · Full coding agent/)
  assert.equal(item(pane, 'standard')?.title, 'standard')
  assert.equal(item(pane, 'reviewer')?.label, 'My reviewer')
  assert.equal(item(pane, 'reviewer')?.detail, 'Custom · Reviews diffs before merge.')
  // A broken card keeps its reason readable and is marked, but stays browsable.
  assert.equal(item(pane, 'legacy')?.detail, 'Custom · Failed to load: plugin "legacy-tools" is not installed')
  assert.equal(item(pane, 'legacy')?.dot, 'error')
  assert.deepEqual(item(pane, 'legacy')?.badges, [{ text: 'Failed to load', tone: 'error' }])
  assert.equal(item(pane, 'legacy')?.disabled, undefined)
  // The committed facts are badges on the CARD, never a rewritten label, and the live
  // Session's own marker rides the picker's native `current` slot.
  assert.deepEqual(item(pane, 'ptc')?.badges, [{ text: 'Default' }])
  assert.deepEqual(props(pane).current, [])
})

test('native Preset: the footer is the THREE Owner entries in the Owner array order with the frame token on the writes', async (t) => {
  const m = await mounted(t)
  await m.ready()
  // The boot browse target is the COMMITTED default (`ptc`), so the fixture's own
  // disabled shape is visible right here — asserted too (Owner ruling "a").
  const { pane } = m
  assert.equal(action(pane, 'set-default')?.disabled, 'Already the default',
    'the boot target IS the recorded default: the reason rides the entry')
  // Browsing off the default row enables BOTH writes with no reason key.
  browse(pane, 'reviewer')
  await waitUntil('browse off the default', () => props(pane).selected === 'preset:reviewer')
  // Owner ruling "a" + the Owner visual shape: `Close` unmarked, BOTH writes
  // `primary` (the client packs primary entries right, Close left).
  assert.deepEqual(actionIds(pane).map((id) => id.split('#')[0]), ['close', 'set-default', 'use'])
  assert.equal(action(pane, 'close')?.id, 'close', 'the dismissal authority carries no frame token')
  assert.match(String(action(pane, 'set-default')?.id), /^set-default#\d+$/u)
  assert.match(String(action(pane, 'use')?.id), /^use#\d+$/u)
  assert.equal(action(pane, 'close')?.primary, undefined)
  assert.equal(action(pane, 'set-default')?.primary, true)
  assert.equal(action(pane, 'use')?.primary, true)
  const setDefaultDisabled = action(pane, 'set-default')?.disabled
  assert.equal(setDefaultDisabled === undefined || setDefaultDisabled === false, true,
    'an enabled healthy write states no reason')
  // The hint (the write scopes live on the Details page; Owner ruling "a").
  assert.equal(hint(pane), 'Tab actions')
})

test('native Preset: a user preset reusing a shipped id stays Custom and gets no guide', async (t) => {
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
  // The classification is the official one: an id alone must never borrow the shipped
  // copy or the shipped guide.
  await enterDetails(pane)
  assert.equal(guideMarkdown(pane), undefined, 'a Custom declaration has no guide on its Details page')
  assert.equal(textOf(pane, 'details-type'), 'Custom')
})

/* --------------------------------------------------------- independent facts */

test('native Preset: Current, Next session, New-session default and Draft are independent', async (t) => {
  const sessionless = await mounted(t)
  await sessionless.ready(roster({ pendingId: 'reviewer' }))
  const pane = sessionless.pane
  assert.equal(hint(pane), 'Tab actions', 'the ONE hint rides the native tooltip slot')
  assert.equal(props(pane).message, undefined, 'the ready phase paints no message copy')
  assert.deepEqual(props(pane).current, [], 'a sessionless panel paints no current marker')
  // The browse target starts on the real committed fact and needs no Draft marker.
  assert.equal(props(pane).selected, 'preset:reviewer')
  assert.deepEqual(item(pane, 'reviewer')?.badges, [{ text: 'Next session' }])
  // Browsing elsewhere states the uncommitted target as its OWN marker.
  browse(pane, 'standard')
  await waitUntil('browse target', () => props(pane).selected === 'preset:standard')
  assert.deepEqual(item(pane, 'standard')?.badges, [{ text: 'Draft' }])
  assert.equal(sessionless.applies.length, 0, 'browsing is never a write')

  const live = await mounted(t, { subject: { sessionless: false } })
  await live.ready(roster({ currentId: 'standard' }))
  assert.deepEqual(props(live.pane).current, ['preset:standard'])
  assert.deepEqual(item(live.pane, 'standard')?.badges, [{ text: 'Current' }])
  assert.deepEqual(item(live.pane, 'ptc')?.badges, [{ text: 'Default' }])
  const standardBadges = (item(live.pane, 'standard')?.badges ?? []) as Array<{ text: string }>
  assert.equal(standardBadges.some((badge) => badge.text === 'Next session'), false,
    'a live panel invents no Next session')
})

/* ------------------------------------------------------- select / activate */

test('native Preset: select only browses, activate opens the EVENT row, Enter opens the highlighted one', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  browse(pane, 'reviewer')
  await waitUntil('select browses', () => props(pane).selected === 'preset:reviewer')
  assert.equal(inDetails(pane), false, 'a selection never changes the page')
  assert.equal(m.applies.length, 0)
  assert.equal(m.defaults.length, 0)
  // The client's ACTIVATE (a click on the already-selected card) opens that preset's
  // Details page — and the event's OWN row is the routing authority, so activating a
  // card the user never highlighted still opens THAT card.
  sendActivate(pane, 'preset:legacy', picker(pane)!.id)
  await waitUntil('activate opens the event row', () => inDetails(pane))
  assert.equal(detailsNode(pane)?.p.head, 'Legacy preset')
  assert.equal(m.applies.length, 0, 'opening the reading page is never a write')
  assert.equal(m.defaults.length, 0)
  // Back returns to the catalogue and keeps the browse target the activation set.
  clickLayerNode(pane, 'preset-details-back-', P)
  await waitUntil('Back returns to the catalogue', () => picker(pane) !== undefined)
  assert.equal(props(pane).selected, 'preset:legacy')
  // Enter on the catalogue is the highlighted card's own Details page — never a write.
  pane.key('\r')
  await waitUntil('Enter opens the Details page', () => inDetails(pane))
  assert.equal(detailsNode(pane)?.p.head, 'Legacy preset')
  assert.equal(m.applies.length, 0, 'Enter on the catalogue never writes')
})

test('native Preset: a mouse select after footer focus moves the keyboard back to the list (P2 review round 7)', async (t) => {
  // THE REVIEW FINDING: with the footer focused, a pointer `select` on another card
  // moved only `selected` and left `zone: actions` live — Enter then ran the STALE
  // footer focus (`Use`/`Set default`) instead of opening the highlighted card's
  // Details. Regression: after ANY mouse select, Enter may only open Details, for
  // BOTH stale foci.
  for (const staleFocus of ['use', 'set-default'] as const) {
    const m = await mounted(t)
    await m.ready()
    const { pane } = m
    // Arm the stale focus on a row where BOTH writes are ENABLED: the boot browse
    // target is the recorded default (`ptc`, so its `Set default` is disabled and
    // the ring cannot reach it); browsing to `reviewer` first makes the whole ring
    // walkable.
    browse(pane, 'reviewer')
    await waitUntil('browse to the enabled row', () => props(pane).selected === 'preset:reviewer')
    await tabToCatalogueAction(pane, staleFocus)
    assert.equal(catalogueFocus(pane), staleFocus, 'the stale footer focus is armed')
    const appliesBefore = m.applies.length
    const defaultsBefore = m.defaults.length
    browse(pane, 'standard')
    await waitUntil('the pointer select moved the highlight', () => props(pane).selected === 'preset:standard')
    // The keyboard followed the mouse onto the list: Enter OPENS, never writes.
    pane.key('\r')
    await waitUntil('Enter after mouse select opens Details', () => inDetails(pane))
    assert.equal(detailsNode(pane)?.p.head, 'Standard mode', 'Enter opened the card the mouse selected')
    assert.equal(m.applies.length, appliesBefore, `stale ${staleFocus} focus wrote no session preset`)
    assert.equal(m.defaults.length, defaultsBefore, `stale ${staleFocus} focus wrote no default`)
    // And the pointer path stayed a pointer path: no synthetic click needed.
    pane.key('\u001b')
    await waitUntil('back on the catalogue', () => picker(pane) !== undefined)
  }
})

/* ------------------------------------------------------ the catalogue write */

test('native Preset: the footer writes once, and an admitted write offers only Close', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  browse(pane, 'reviewer')
  await waitUntil('browse', () => props(pane).selected === 'preset:reviewer')
  await tabToCatalogueAction(pane, 'use')
  assert.equal(action(pane, 'use')?.label, 'Use next [Enter]')
  assert.equal(hint(pane), 'Tab list')
  assert.equal(m.applies.length, 0, 'focusing an entry is not a write')
  pane.key('\r')
  await waitUntil('one admitted write', () => m.applies.length === 1)
  assert.deepEqual(m.applies, ['reviewer'])
  // The pending phase states itself and offers ONLY the dismissal.
  await waitUntil('the pending frame is committed', () => props(pane).message === 'Applying preset…')
  assert.deepEqual(actionIds(pane), ['close'])
  assert.equal(hint(pane), '', 'an admitted write promises no key')
  // Neither a stale footer token nor another card may reach the write again.
  sendAction(pane, 'use#1', undefined, picker(pane)!.id)
  browse(pane, 'legacy')
  await settle(200)
  assert.equal(props(pane).message, 'Applying preset…', 'the pending frame survives a stale token and a browse')
  assert.equal(props(pane).selected, 'preset:reviewer', 'browsing is refused under an admitted write')
  assert.equal(m.applies.length, 1, 'an admitted write is never re-entered')
  pane.key('\u001b')
  await waitUntil('Esc closes an admitted write', () => picker(pane) === undefined)
})

/* ------------------------------------------------------- the Details page */

test('native Preset Details: the complete identity, the scope facts and the inline shipped guide', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  browse(pane, 'standard')
  await waitUntil('browse', () => props(pane).selected === 'preset:standard')
  await enterDetails(pane)
  assert.equal(textOf(pane, 'details-name'), 'Standard mode')
  assert.equal(textOf(pane, 'details-id'), 'standard')
  assert.equal(textOf(pane, 'details-type'), 'Built-in')
  // The §2.1 scope sentence rides the Details page (Owner ruling "a": the catalogue
  // has no paintable status slot).
  assert.equal(textOf(pane, 'details-scope'), 'Use: next session only · Default: future new sessions')
  assert.equal(textOf(pane, 'details-description')?.startsWith('Full coding agent'), true)
  // A row that is none of the committed facts states NO relationship.
  assert.equal(layer(pane).some((node) => node.id.includes('.relation-')), false)
  // The pinned official guide is INLINE — one page, one scroll, no third layer.
  const md = guideMarkdown(pane)
  assert.ok(md !== undefined, 'the shipped guide is native Markdown on the SAME page')
  for (const fragment of [
    '## Mode details',
    'Choose Standard mode when starting a new task.',
    '### How it works',
    '## How to use',
    '### Fix a bug',
    'Expected output: a summary with references that you can check against the original notes.',
  ]) {
    assert.ok(md.includes(fragment), `the official guide keeps ${JSON.stringify(fragment)}`)
  }
  // The page is READ-ONLY: no footer actions on the overlay, no write anywhere; ONE
  // interactive node — the Back navigation row (Owner A4 amendment's final form).
  assert.equal(props(pane).actions, undefined, 'the Details page paints no footer')
  const back = backButton(pane)
  assert.ok(back, 'the Back control is a native row node')
  assert.equal(back.p.onClick !== undefined || back.p.actions !== undefined, true, 'Back is a real pointer target')
  // Owner A4 amendment: the way back reads as NAVIGATION (arrow + destination +
  // the Esc hint), never as a business write, and no el/html.button exists.
  const label = backLabel(pane)
  assert.ok(label.includes('← Back to presets'), `the row states the destination: ${JSON.stringify(label)}`)
  assert.ok(label.includes('Esc'), 'the row names its keyboard twin')
  assert.equal(layer(pane).some((node) => node.k === 'el'), false, 'no el node anywhere on the layer')
  // Enter on the page means the way back (the page has no footer ring).
  pane.key('\r')
  await waitUntil('Enter returns to the catalogue', () => picker(pane) !== undefined)
  assert.equal(m.applies.length, 0, 'Enter on the Details page never writes')
})

test('native Preset Details: a disabled write states its reason on the footer entry and the page', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Already the default: the reason rides the entry (tooltip on the wire) — Owner
  // ruling "a"; the full statement is the Details page's relationship fact.
  browse(pane, 'ptc')
  await waitUntil('the recorded default', () => props(pane).selected === 'preset:ptc')
  assert.equal(action(pane, 'set-default')?.disabled, 'Already the default')
  await enterDetails(pane)
  assert.equal(layer(pane).some((node) => node.id.endsWith('.relation-default')), true, 'the Details page states the default')
  pane.key('\u001b')
  await waitUntil('back on the catalogue', () => picker(pane) !== undefined)
  // A broken row: BOTH writes refuse, the reason names the failure, and the Details
  // page carries the complete reason text.
  browse(pane, 'legacy')
  await waitUntil('the broken card', () => props(pane).selected === 'preset:legacy')
  assert.equal(action(pane, 'use')?.disabled, 'Preset failed to load')
  assert.equal(action(pane, 'set-default')?.disabled, 'Preset failed to load')
  // A forged pointer action at the DISABLED entry is refused at admission too.
  sendPickerAction(pane, 'set-default', P)
  await settle(200)
  assert.equal(m.defaults.length, 0, 'a disabled entry never writes')
  await enterDetails(pane)
  assert.equal(textOf(pane, 'details-broken'), 'plugin "legacy-tools" is not installed')

  const noSettings = await mounted(t)
  await noSettings.ready(roster({ canSetDefault: false }))
  assert.equal(action(noSettings.pane, 'set-default')?.disabled, 'Settings unavailable')
  sendPickerAction(noSettings.pane, 'set-default', P)
  await settle(200)
  assert.equal(noSettings.defaults.length, 0, 'the disabled default registers no write at all')
})

test('native Preset Details: every long value is complete and one native scroll body', async (t) => {
  const m = await mounted(t)
  const long = `${'字'.repeat(120)}\r\nsecond line\r\n${'e\u0301moji 🧪 '.repeat(40)}`
  const id = `no-space-${'x'.repeat(180)}:%:🧪`
  const name = `名前 ${'🎛'.repeat(40)}`
  const broken = `plugin "legacy-tools" is not installed: ${'y'.repeat(200)}`
  await m.ready({
    roster: {
      presets: [
        { id: 'standard' },
        { id, name, description: long },
        { id: 'broken-one', name: 'Broken one', broken },
      ],
      defaultId: 'standard',
    },
    currentId: undefined,
    pendingId: undefined,
    defaultId: 'standard',
    canSetDefault: true,
  })
  const { pane } = m
  browse(pane, id)
  await waitUntil('the special card', () => props(pane).selected === `preset:${id}`)
  await enterDetails(pane)
  // Nothing is truncated, re-flowed or pre-split: each value is the roster's own string.
  assert.equal(textOf(pane, 'details-name'), name)
  assert.equal(textOf(pane, 'details-id'), id)
  assert.equal(textOf(pane, 'details-type'), 'Custom')
  // The untrusted-text projection normalizes the roster string's CRLF to LF;
  // no content is dropped and the client renders the same lines.
  assert.equal(textOf(pane, 'details-description'), long.replace(/\r\n/g, '\n'))
  assert.equal(layer(pane).find((entry) => entry.id.endsWith('.details-id'))?.p.wrap, 'char')
  assert.equal(layer(pane).find((entry) => entry.id.endsWith('.details-description'))?.p.wrap, 'word')
  // The full description lives in the page's ONE scrolling body, which is also the node
  // the app's own `scroll` op addresses.
  const body = readingBody(pane)
  assert.ok(body, 'the Details page carries its own scrollable body')
  assert.ok(
    layer(pane).some((entry) => entry.id.endsWith('.details-description') && entry.id.startsWith(`${body.id}.`)),
    'the description really sits inside that body',
  )
  // The keyboard reads the body: every scroll op names the CURRENT frame's own body.
  const before = scrollOps(pane).length
  pane.key('\u001b[B')
  await waitUntil('a body scroll reached the wire', () => scrollOps(pane).length === before + 1)
  assert.equal(scrollOps(pane).at(-1)?.id, readingBody(pane)!.id)
  assert.equal(scrollOps(pane).at(-1)?.to, 'line-down')
  pane.key('\u001b[6~')
  await waitUntil('page-down reached the same body', () => scrollOps(pane).length === before + 2)
  assert.equal(scrollOps(pane).at(-1)?.to, 'page-down')
  // A broken preset states its complete reason on the same page.
  pane.key('\u001b')
  await waitUntil('back on the catalogue again', () => picker(pane) !== undefined)
  browse(pane, 'broken-one')
  await waitUntil('the broken card', () => props(pane).selected === 'preset:broken-one')
  await enterDetails(pane)
  assert.equal(textOf(pane, 'details-broken'), broken)
})

/* --------------------------------------------------- page navigation ladder */

test('native Preset: Back, Esc and the search-clear ladder never cross a page or a write', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  browse(pane, 'ptc')
  await waitUntil('browse', () => props(pane).selected === 'preset:ptc')
  pane.key('ptc')
  await waitUntil('query typed', () => props(pane).query === 'ptc')
  await enterDetails(pane)
  // Details Esc returns to the catalogue and keeps query AND selection.
  pane.key('\u001b')
  await waitUntil('Details Esc returns', () => picker(pane) !== undefined)
  assert.equal(props(pane).query, 'ptc')
  assert.equal(props(pane).selected, 'preset:ptc')
  // One Back (pointer shape) is the same intent: the catalogue, nothing else.
  await enterDetails(pane)
  clickLayerNode(pane, 'preset-details-back-', P)
  await waitUntil('the Back row returns', () => picker(pane) !== undefined)
  // The catalogue ladder: the first Esc clears the search, the second closes.
  pane.key('\u001b')
  await waitUntil('the search is cleared', () => props(pane).query === '')
  assert.ok(picker(pane), 'clearing the search never closes the panel')
  pane.key('\u001b')
  await waitUntil('the second Esc closes', () => picker(pane) === undefined)
  assert.equal(m.applies.length, 0)
})

/* ------------------------------------------------------ identity and scroll */

test('native Preset: the picker keeps one identity per panel while every reading takes its own', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  const panel = picker(pane)!.id
  assert.match(panel, /\.preset-\d+$/u, 'the footer picker id carries the panel serial only')
  browse(pane, 'reviewer')
  await waitUntil('browse', () => props(pane).selected === 'preset:reviewer')
  assert.equal(picker(pane)?.id, panel, 'a highlight change never remounts the picker')
  // A notice/revision change must not remount it either.
  sendPickerAction(pane, 'use', P)
  await waitUntil('the write was admitted', () => m.applies.length === 1)
  m.settleApply({ kind: 'rejected', message: 'nope' })
  await waitUntil('the refusal is visible', () => props(pane).message === 'nope')
  assert.equal(picker(pane)?.id, panel, 'a repaint never remounts the picker')
  // Each entry into the Details page is a new reading: a fresh body/Back identity.
  await enterDetails(pane)
  const first = readingBody(pane)!.id
  const firstBack = backButton(pane)!.id
  assert.match(first, /preset-reading-body-\d+-\d+$/u)
  pane.key('\u001b')
  await waitUntil('back on the catalogue', () => picker(pane) !== undefined)
  await enterDetails(pane)
  assert.notEqual(readingBody(pane)!.id, first, 'a re-entry is a NEW reading')
  assert.notEqual(backButton(pane)!.id, firstBack)
  // A scroll asked for after the reading is gone addresses nothing.
  pane.key('\u001b')
  await waitUntil('catalogue again', () => picker(pane) !== undefined)
  const queued = scrollOps(pane).length
  pane.key('\u001b[B')
  await settle(150)
  assert.equal(scrollOps(pane).length, queued, 'no reading, no scroll target')
  assert.equal(m.applies.length, 1, 'reading never writes')
})

/* ------------------------------------------------------ loading and failure */

test('native Preset: Loading keeps the search editable, looks inert and Esc closes', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  await waitUntil('loading frame', () => props(pane).state === 'loading')
  assert.deepEqual(actionIds(pane), ['close'], 'a loading footer offers no write')
  assert.equal(hint(pane), 'Loading agent presets…')
  pane.key('rev')
  await waitUntil('query typed', () => props(pane).query === 'rev')
  pane.key('\r')
  await waitUntil('Enter does not write', () => m.applies.length === 0)
  pane.key('\t')
  await settle(120)
  assert.equal(action(pane, 'close')?.label, 'Close', 'no key can run the footer while the read runs')
  pane.key('\u001b')
  await waitUntil('Esc clears the search first', () => props(pane).query === '')
  pane.key('\u001b')
  await waitUntil('Esc closes a loading panel', () => picker(pane) === undefined)
})

test('native Preset: a failed read offers Retry + Close and — F1 — still clears a non-empty query with Esc', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  m.handle.setLoadError('agent presets unavailable in this deployment')
  await waitUntil('error frame', () => props(pane).state === 'error')
  assert.equal(props(pane).message, 'agent presets unavailable in this deployment')
  assert.deepEqual(actionIds(pane).map((id) => id.split('#')[0]), ['close', 'retry'], 'the Owner order holds in the error phase too')
  assert.match(String(action(pane, 'retry')?.id), /^retry#\d+$/u)
  assert.equal(action(pane, 'retry')?.primary, true, 'Retry is the error phase\'s primary (rightmost)')
  assert.equal(hint(pane), 'Retry first')
  await tabToCatalogueAction(pane, 'retry')
  pane.key('\u001b[Z')
  await waitUntil('Shift+Tab stays in the footer', () => catalogueFocus(pane) === 'retry')
  // F1 (review round 1): the error phase must clear a NON-EMPTY query with Esc
  // before it can close — the ladder is never swallowed by the failure.
  pane.key('zz')
  await waitUntil('query typed under the failure', () => props(pane).query === 'zz')
  pane.key('\u001b')
  await waitUntil('the error-phase Esc clears the query', () => props(pane).query === '')
  assert.ok(picker(pane), 'clearing never closes the failed panel')
  pane.key('\u001b')
  await waitUntil('the next Esc closes it', () => picker(pane) === undefined)

  // And the plain path: one Retry re-reads through the ONE read owner.
  const m2 = await mounted(t)
  m2.handle.setLoadError('agent presets unavailable in this deployment')
  await waitUntil('error frame', () => props(m2.pane).state === 'error')
  await tabToCatalogueAction(m2.pane, 'retry')
  m2.pane.key('\r')
  await waitUntil('retry re-enters loading', () => props(m2.pane).state === 'loading')
  assert.equal(m2.retries(), 1, 'the ORIGINAL read owner is asked exactly once')
  assert.equal(m2.applies.length, 0)
  // A second Enter while the read runs cannot admit another read.
  m2.pane.key('\r')
  await settle(150)
  assert.equal(m2.retries(), 1)
})

test('native Preset: an empty roster and a search with no match stay readable and escapable', async (t) => {
  const m = await mounted(t)
  await m.ready(roster({ roster: { presets: [], defaultId: undefined }, defaultId: undefined }))
  const { pane } = m
  assert.equal(props(pane).empty, 'No agent presets configured.')
  assert.deepEqual(items(pane), [])
  assert.equal(action(pane, 'use')?.disabled, 'No preset selected')
  assert.equal(action(pane, 'set-default')?.disabled, 'No preset selected')
  assert.deepEqual(props(pane).order, [], 'an empty roster paints no empty group')
  // No dead focus: the cue lands on the one entry that can act.
  await tabToCatalogueAction(pane, 'close')
  pane.key('\r')
  await waitUntil('Close works', () => picker(pane) === undefined)
  assert.equal(m.applies.length, 0)

  const filtered = await mounted(t)
  await filtered.ready()
  filtered.pane.key('zzz')
  await waitUntil('no match', () => items(filtered.pane).length === 0)
  assert.deepEqual(props(filtered.pane).order, [], 'a no-match search paints no group head')
  assert.equal(action(filtered.pane, 'use')?.disabled, 'No preset selected')
  filtered.pane.key('\r')
  await settle(150)
  assert.equal(filtered.applies.length, 0)
  filtered.pane.key('\u001b')
  await waitUntil('Esc clears the no-match search', () => props(filtered.pane).query === '')
  assert.equal(items(filtered.pane).length, 4, 'and the cards come back')
})

/* ------------------------------------------------------------- settlements */

test('native Preset: a staged, committed or indeterminate write dismisses the picker', async (t) => {
  for (const outcome of [
    { kind: 'pending' as const, preset: 'reviewer' },
    { kind: 'switched' as const, preset: 'reviewer' },
  ]) {
    const m = await mounted(t)
    await m.ready()
    browse(m.pane, 'reviewer')
    await waitUntil('browse', () => props(m.pane).selected === 'preset:reviewer')
    await tabToCatalogueAction(m.pane, 'use')
    m.pane.key('\r')
    await waitUntil('write admitted', () => m.applies.length === 1)
    m.settleApply(outcome)
    await waitUntil(`${outcome.kind} dismisses`, () => picker(m.pane) === undefined)
  }
  const m = await mounted(t)
  await m.ready()
  await tabToCatalogueAction(m.pane, 'use')
  m.pane.key('\r')
  await waitUntil('write admitted', () => m.applies.length === 1)
  m.settleApply({ kind: 'indeterminate', message: 'the switch was dispatched' })
  await waitUntil('indeterminate dismisses', () => picker(m.pane) === undefined)
})

test('native Preset: a refused write keeps its ORIGIN page usable and states why', async (t) => {
  const rejected = await mounted(t)
  await rejected.ready()
  browse(rejected.pane, 'reviewer')
  await waitUntil('browse', () => props(rejected.pane).selected === 'preset:reviewer')
  await tabToCatalogueAction(rejected.pane, 'use')
  rejected.pane.key('\r')
  await waitUntil('write admitted', () => rejected.applies.length === 1)
  rejected.settleApply({ kind: 'rejected', message: 'preset "reviewer" does not resolve' })
  await waitUntil('refusal stays usable', () => props(rejected.pane).state === 'ready')
  assert.equal(props(rejected.pane).message, 'preset "reviewer" does not resolve')
  assert.equal(picker(rejected.pane) !== undefined, true, 'the refusal stayed on the catalogue')
  assert.ok(item(rejected.pane, 'reviewer'), 'the cards survive a refused write')

  const locked = await mounted(t, { subject: { sessionless: false } })
  await locked.ready(roster({ currentId: 'standard' }))
  browse(locked.pane, 'reviewer')
  await waitUntil('browse', () => props(locked.pane).selected === 'preset:reviewer')
  await tabToCatalogueAction(locked.pane, 'use')
  locked.pane.key('\r')
  await waitUntil('write admitted', () => locked.applies.length === 1)
  locked.settleApply({ kind: 'locked', sessionId: 'session-1' })
  await waitUntil('locked stays usable', () => props(locked.pane).state === 'ready')
  assert.equal(props(locked.pane).message, 'Locked: this session has already started.')
})

test('native Preset: the default write is explicit, scoped and dismisses (saved and unconfirmed)', async (t) => {
  const saved = await mounted(t)
  await saved.ready()
  browse(saved.pane, 'reviewer')
  await waitUntil('browse', () => props(saved.pane).selected === 'preset:reviewer')
  await tabToCatalogueAction(saved.pane, 'set-default')
  saved.pane.key('\r')
  await waitUntil('default write admitted', () => saved.defaults.length === 1)
  assert.deepEqual(saved.defaults, ['reviewer'])
  await waitUntil('the pending default copy', () => props(saved.pane).message === 'Saving default…')
  saved.settleDefault({ kind: 'saved', preset: 'reviewer' })
  await waitUntil('saved dismisses', () => picker(saved.pane) === undefined)
  // An UNCONFIRMED settings write dismisses too: a raise proves no rollback, so the
  // next read — never this panel's snapshot — is authoritative.
  const second = await mounted(t)
  await second.ready()
  browse(second.pane, 'reviewer')
  await waitUntil('browse', () => props(second.pane).selected === 'preset:reviewer')
  await tabToCatalogueAction(second.pane, 'set-default')
  second.pane.key('\r')
  await waitUntil('default write admitted', () => second.defaults.length === 1)
  second.settleDefault({ kind: 'unconfirmed', message: 'settings write failed' })
  await waitUntil('unconfirmed dismisses', () => picker(second.pane) === undefined)
  assert.equal(second.applies.length, 0)
})

/* --------------------------------------------------- ids and search safety */

test('native Preset: special ids and the search never collide with a control', async (t) => {
  const m = await mounted(t)
  const ids = ['scope-all', 'effort:high', 'fact:name', 'close', 'use#3', '详情', 'a:b:c']
  await m.ready({
    roster: { presets: ids.map((id) => ({ id, name: `Row ${id}` })), defaultId: ids[0] },
    currentId: undefined,
    pendingId: undefined,
    defaultId: ids[0],
    canSetDefault: true,
  })
  const { pane } = m
  assert.ok(items(pane).every((entry) => ids.includes(String(entry.id).slice('preset:'.length))))
  // A card whose id reads like a footer action still browses, never acts.
  browse(pane, 'close')
  await waitUntil('action-named card browses', () => props(pane).selected === 'preset:close')
  assert.ok(picker(pane), 'the panel is still open')
  assert.equal(m.applies.length, 0)
  browse(pane, 'use#3')
  await waitUntil('token-shaped card browses', () => props(pane).selected === 'preset:use#3')
  // Its Details page still opens THAT preset, never a control.
  await enterDetails(pane)
  assert.equal(textOf(pane, 'details-id'), 'use#3')
  pane.key('\u001b')
  await waitUntil('back', () => picker(pane) !== undefined)
  // The search filters by name/id, and Enter still writes nothing.
  pane.key('详情')
  await waitUntil('unicode query', () => props(pane).query === '详情')
  assert.deepEqual(items(pane).map((entry) => entry.id), ['preset:详情'])
  pane.key('\r')
  await waitUntil('search Enter opens the Details page', () => inDetails(pane))
  assert.equal(m.applies.length, 0, 'opening the Details page writes nothing')
})

test('native Preset: a retired frame id or a foreign surface never reaches the panel', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  const staleId = picker(pane)!.id
  browse(pane, 'reviewer')
  await waitUntil('a new revision', () => String(action(pane, 'use')?.id) !== 'use#0')
  const frame = pane.frames().at(-1)!.sf
  pane.event({ ev: 'select', sf: 'retired-surface', id: staleId, item: 'preset:legacy' })
  pane.event({ ev: 'action', sf: frame, id: staleId, act: 'use#0' })
  pane.event({ ev: 'action', sf: frame, id: picker(pane)!.id, act: 'use#0' })
  pane.event({ ev: 'action', sf: frame, id: 'preset-999', act: 'use#999' })
  await settle(250)
  assert.equal(props(pane).selected, 'preset:reviewer')
  assert.equal(m.applies.length, 0, 'no stale or forged receiver reaches the writer')
  assert.ok(picker(pane), 'and none of them dismisses the panel')
})

/* -------------------------------------------------- layer ownership / modal */

test('native Preset: one layer carries exactly ONE page and nothing beside it', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  assert.equal(layer(pane).filter((entry) => entry.k === 'picker').length, 1)
  // The status facts and the hint ride the picker's OWN props: a sibling text line would
  // collapse the layer column and the modal sheet would be painted over it (measured in
  // the real Tern pane), so the layer must carry NOTHING but its one page node.
  const pickerPrefix = `${picker(pane)!.id}.`
  const siblings = layer(pane).filter((entry) => entry.id !== picker(pane)!.id && !entry.id.startsWith(pickerPrefix))
  assert.deepEqual(siblings.map((entry) => `${entry.k}:${entry.id}`), [], 'the layer is ONE page node and nothing else')
  await enterDetails(pane)
  assert.equal(layer(pane).filter((entry) => entry.k === 'picker').length, 0, 'no picker behind a reading page')
  assert.equal(layer(pane).filter((entry) => entry.k === 'overlay').length, 1)
  assert.equal(layer(pane).filter((entry) => entry.k === 'row').length, 1, 'ONE Back navigation row, nothing else interactive')
  assert.equal(textOf(pane, 'details-id'), 'ptc')
})

test('native Preset: opening Model and Preset alternates one layer, never two', async (t) => {
  const m = await mounted(t, { withModel: true })
  await m.ready()
  const { pane, renderer } = m
  assert.ok(renderer.modelPresentation, 'this pane advertises both native layers')
  assert.equal(pickerNode(pane, M), undefined)
  const model = renderer.modelPresentation.open({
    subject: { sessionless: true },
    isCurrent: () => true,
    retry() {},
    apply: () => 'superseded' as ModelApplyOutcome,
    runOwned: (label, task, runOptions) =>
      runOwned(label, task, { ...runOptions, diag: { debug() {}, warn() {}, error() {} } as never }),
  })
  await waitUntil('Model replaced the Preset layer', () => pickerNode(pane, M) !== undefined && picker(pane) === undefined)
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
  const again = m.open()
  again.setRoster(roster())
  await waitUntil('Preset replaced the Model layer', () =>
    picker(pane) !== undefined && pickerNode(pane, M) === undefined)
  assert.equal(layerNodes(pane, M).filter((entry) => entry.k === 'picker').length, 0)
})

test('native Preset: a modal seat suspends the panel, and hydration/dispose retire it for good', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane, renderer } = m
  browse(pane, 'reviewer')
  await waitUntil('browse', () => props(pane).selected === 'preset:reviewer')
  assert.ok(picker(pane))
  renderer.display.beginSessionHydration()
  await waitUntil('hydration retires the panel', () => picker(pane) === undefined)
  // A late command callback can never reopen a retired panel.
  m.handle.setRoster(roster({ pendingId: 'reviewer' }))
  await settle(150)
  assert.equal(picker(pane), undefined)
  await renderer.dispose()
  await renderer.dispose()
  assert.equal(m.applies.length, 0, 'no retirement path ever writes')
})

test('native Preset: a settlement after the subject moved commits no frame, and a late read never hydrates', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  browse(pane, 'reviewer')
  await waitUntil('browse', () => props(pane).selected === 'preset:reviewer')
  await tabToCatalogueAction(pane, 'use')
  pane.key('\r')
  await waitUntil('write admitted', () => m.applies.length === 1)
  await waitUntil('the pending frame is committed', () => props(pane).message === 'Applying preset…')
  const frames = pane.frameCount()
  const admitted = picker(pane)!.id
  m.moveSubject()
  m.settleApply({ kind: 'pending', preset: 'ptc' })
  await settle(250)
  assert.equal(pane.frameCount(), frames, 'a stale settlement commits no frame')
  assert.equal(picker(pane)?.id, admitted, 'and it never repaints the panel')
  m.handle.setRoster(roster({ pendingId: 'reviewer' }))
  assert.equal(m.handle.isDisposed(), true, 'the moved subject retired the panel')
  m.renderer.display.beginSessionHydration()
  await waitUntil('the renderer drops the retired layer', () => picker(pane) === undefined)
  assert.equal(m.applies.length, 1, 'the settled write was never re-entered')

  const late = await mounted(t)
  await waitUntil('loading panel', () => props(late.pane).state === 'loading')
  const lateFrames = late.pane.frameCount()
  late.moveSubject()
  late.handle.setRoster(roster())
  late.handle.setLoadError('late failure')
  await settle(200)
  assert.equal(late.pane.frameCount(), lateFrames, 'a late read commits no frame')
  assert.equal(props(late.pane).state, 'loading', 'and it never hydrates the moved panel')
  assert.equal(late.handle.isDisposed(), true)
})

test('native Preset: a late settlement never touches the panel that replaced it', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  browse(pane, 'reviewer')
  await waitUntil('browse', () => props(pane).selected === 'preset:reviewer')
  await tabToCatalogueAction(pane, 'use')
  pane.key('\r')
  await waitUntil('the first panel admitted a write', () => m.applies.length === 1)
  const second = m.open()
  second.setRoster(roster({ pendingId: 'reviewer' }))
  await waitUntil('the new panel is ready', () => props(pane).state === 'ready'
    && props(pane).selected === 'preset:reviewer')
  const newPanel = picker(pane)!.id
  m.settleApply({ kind: 'switched', preset: 'ptc' })
  await settle(300)
  assert.equal(picker(pane)?.id, newPanel, 'the newer panel is still the mounted one')
  assert.equal(props(pane).selected, 'preset:reviewer', 'and it kept its own browse target')
  assert.equal(props(pane).state, 'ready')
})

test('native Preset: a late default settlement never touches the replaced panel', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  browse(pane, 'reviewer')
  await waitUntil('browse', () => props(pane).selected === 'preset:reviewer')
  await tabToCatalogueAction(pane, 'set-default')
  pane.key('\r')
  await waitUntil('the default write was admitted', () => m.defaults.length === 1)
  const second = m.open()
  second.setRoster(roster({ pendingId: 'reviewer' }))
  await waitUntil('the new panel is ready', () => props(pane).state === 'ready'
    && props(pane).selected === 'preset:reviewer')
  const newPanel = picker(pane)!.id
  m.settleDefault({ kind: 'saved', preset: 'ptc' })
  await settle(300)
  assert.equal(picker(pane)?.id, newPanel, 'the newer panel is still the mounted one')
  assert.equal(props(pane).state, 'ready')
})

/* --------------------------------------------------------- capability gates */

test('native Preset: a pane missing ANY required kind (individually) or the scroll feature installs no preset presenter', async (t) => {
  // F3 (review round 1, re-raised round 2 with the precise mechanism): a `kinds`
  // override takes the fixture's VERBATIM branch, whose default features are
  // `HELLO.features` (no `scroll`) — so the earlier cases ALSO failed on the
  // missing feature and proved nothing about their named kind. Every case below
  // carries ALL the OTHER requirements, so it can only fail on its own missing
  // one. (The interim round-2 `styles` gate was removed with the sheet itself —
  // Owner A4 amendment — so `styles` is no longer part of the requirement.)
  const required = ['picker', 'row', 'overlay', 'text', 'md'] as const
  const full = ['flow', 'styles', 'scroll']
  const cases: ReadonlyArray<{ readonly name: string; readonly kinds: readonly string[]; readonly features: readonly string[] }> = [
    ...required.map((missing) => ({
      name: `no ${missing}`,
      kinds: required.filter((kind) => kind !== missing),
      features: full,
    })),
    {
      name: 'no scroll feature',
      kinds: [...required],
      features: ['flow', 'styles'],
    },
  ]
  for (const entry of cases) {
    const pane = installTspPane({ kinds: entry.kinds, features: entry.features })
    t.after(() => pane.restore())
    const session = await connect({ timeout: 500, exitHooks: false })
    assert.ok(session)
    const renderer = mountTspRenderer(session, { requestExit() {}, onFatal: () => {} })
    t.after(() => renderer.dispose())
    assert.equal(renderer.presetPresentation, undefined, `${entry.name}: fail closed before any handler runs`)
  }
  // The SAME pane shape WITH every requirement installs it.
  const pane = installTspPane({ presetPicker: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, { requestExit() {}, onFatal: () => {} })
  t.after(() => renderer.dispose())
  assert.ok(renderer.presetPresentation, 'a pane with every kind and the scroll feature presents the layer')
  // Owner A4 amendment: NO stylesheet is used anywhere on this layer.
  assert.equal(pane.output.text().includes('dsh-pi-tui-preset-back'), false,
    'the preset layer sends no stylesheet op at all')
})
