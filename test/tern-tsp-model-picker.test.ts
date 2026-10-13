/** Production native /model renderer, original command and write paths.
 *
 * Scripted tty/Host fixtures are named explicitly; only the final Direct cases
 * mount official live Agents. No decision or committed selection is injected.
 * The assertions read the REAL reconciled wire tree: the picker's own props
 * (title/preview/scopes/focus/actions), its rendered cards/rows and the SDK
 * action dispatch, so a renderer-local field can never satisfy them.
 *
 * The UX contract exercised here is the Models -> Overview -> Full details one:
 * the wide list edits a model in place, every other layout opens THAT model's
 * Overview, the Full details page is read-only, and exactly one explicitly
 * labelled action writes.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'
import {
  FAILURE_RETRY_ID,
  OVERVIEW_DETAILS_ID,
  OVERVIEW_EFFORT_ID,
  OVERVIEW_MODEL_ID,
  effortItemId,
  wideCatalog,
} from '../src/tui/tsp/model-picker-state.ts'
import { runOwned } from '../src/runtime/process/tasks.ts'
import type {
  ModelApplyOutcome,
  ModelPickerDirectory,
} from '../src/app/command/model-presentation.ts'
import { DirectModelCatalog } from '../src/runtime/direct/catalog-direct.ts'
import { installTspPane, type TspPane } from './support/tsp-terminal-fixture.ts'
import { ownTspBoot, waitUntil, settle } from './support/tsp-runner-harness.ts'
import {
  DIRECT_TSP_MODEL_TWO,
  createDirectTspFixture,
  waitFor,
} from './support/direct-tsp-fixture.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

test('production /model: an older pane without native kinds still refuses before the handler', async t => {
  const life = testLifecycle(t), home = life.tempDir('dsh-tsp-model-legacy-')
  let saves = 0
  const boot = await ownTspBoot({ life, home, logFile: home + '/diag.log',
    saveDefault: async () => { saves++ } })
  try {
    await waitUntil('renderer ready', () => boot.pane.output.text().includes('dock.composer'))
    boot.pane.key('/model\r')
    await waitUntil('capability refusal', () => boot.pane.output.text().includes("This command's UI is not available in TSP yet"))
    assert.equal(picker(boot.pane), undefined)
    assert.equal(saves, 0)
    assert.equal(boot.harness.createdSessions.length, 0)
  } finally { await boot.settle() }
})

test('production /model: a pane with the picker but without the Reader kinds still refuses', async t => {
  const pane = installTspPane({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'picker'] })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, { requestExit() {}, onFatal: (e) => assert.fail(String(e)) })
  t.after(() => renderer.dispose())
  renderer.bindInput({ exit() {}, cancel() {}, submit() {}, steer() {}, noteUserInput() {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false })
  assert.equal(renderer.modelPresentation, undefined, 'the native model UI fails closed')
  assert.equal(picker(pane), undefined)
})

/** Send a resize and wait for the picker's NEXT frame. The panel revision moves
 *  immediately, but a credit-gated frame may still be in flight and an event read
 *  from the previous frame is (by design) refused as a stale receiver. */
async function resize(pane: TspPane, cols: number): Promise<void> {
  // One frame per resize is the evidence: a picker page's node id moves with the
  // revision, but the read-only Reader's ids are stable, so the frame count is
  // what proves the resized layout was really committed.
  const before = pane.frameCount()
  sendResize(pane, cols)
  await waitUntil('the resized frame is committed', () => pane.frameCount() > before)
}

// The wire observation helpers: the REAL reconciled node tree of the frames.
import {
  clickNode as click,
  clickNodeById,
  layerNodes,
  pickerAction as actionOf,
  pickerNode as picker,
  pickerProps as props,
  sendAction as action,
  sendActivate,
  sendResize,
  sendSelect as browse,
  readerBackNode,
  readerBodyNode,
  readerNode,
  readerValue,
  scrollOps,
  sheetText,
  wireNodes as nodes,
} from './support/tsp-picker-wire.ts'

/** The picker's own main-list row ids, in wire order. */
function rowIds(pane: TspPane): string[] {
  return ((props(pane).items ?? []) as Array<Record<string, unknown>>).map((item) => String(item.id))
}

/** The action-bar ids of the mounted picker, in wire order. */
function actionIds(pane: TspPane): string[] {
  return ((props(pane).actions ?? []) as Array<Record<string, unknown>>).map((entry) => String(entry.id))
}

/** The bar's visible labels, in wire order. */
function actionLabels(pane: TspPane): Array<string | undefined> {
  return ((props(pane).actions ?? []) as Array<Record<string, unknown>>)
    .map((entry) => entry.label as string | undefined)
}

/** One main-list row's `detail` by exact id. */
function detailOf(pane: TspPane, id: string): string | undefined {
  return ((props(pane).items ?? []) as Array<Record<string, unknown>>)
    .find((item) => String(item.id) === id)?.detail as string | undefined
}

/** The `●`/`○` mark of one Overview candidate row, read from the wire. */
function candidateMark(pane: TspPane, id: string): string | undefined {
  return (((props(pane).items ?? []) as Array<Record<string, unknown>>)
    .find((item) => String(item.id) === id)?.mark as { text?: string } | undefined)?.text
}

/** Walk the native main-list cursor with real ArrowDown keys until the picker's
 *  selected row is `id`. Bounded, so a stuck cursor fails instead of hanging. */
async function walkList(pane: TspPane, id: string): Promise<void> {
  for (let step = 0; step < 64; step += 1) {
    if (props(pane).selected === id) return
    const before = picker(pane)?.id
    pane.key('\u001b[B')
    await waitUntil(`the cursor moves toward ${id}`, () => picker(pane)?.id !== before)
  }
  assert.equal(props(pane).selected, id, `the cursor reached ${id}`)
}

/** Wait for the picker's NEXT committed frame. The panel revision moves
 *  synchronously with every mutation, but the credit-gated frame may still be in
 *  flight — and a wire event addressed to the PREVIOUS frame's node id is refused
 *  as a stale receiver BY DESIGN, so a test that wants to deliver one must first
 *  observe the new frame. */
async function nextPickerFrame(pane: TspPane): Promise<void> {
  const before = picker(pane)?.id
  await waitUntil('the next picker frame is committed', () => picker(pane)?.id !== before)
}

/** Whether the mounted picker page is the CATALOGUE (its title states what the
 *  one write does, so it is the page's own name at every width). */
function onCatalogue(pane: TspPane): boolean {
  const title = String(props(pane).title ?? '')
  return title === 'Switch model' || title === 'Choose default model'
}

/** Whether the mounted picker page is one model's Overview. */
function onOverview(pane: TspPane): boolean {
  return String(props(pane).title ?? '').startsWith('Model overview')
}

/** A catalogue row activation opens the highlighted model's Overview with
 *  Enter — never a write. */
async function enterOverview(pane: TspPane): Promise<void> {
  pane.key('\r')
  await waitUntil('the model Overview', () => onOverview(pane))
}

/**
 * The suite's WIDE pane: 160 terminal columns at the fixture's 8px cell = 1280px,
 * the pane class that paints the `lg` catalogue sheet and its compact read-only
 * summary. The fixture's own 120-column pane (960px) is the narrow one, where the
 * same catalogue renders `md` with no summary — the interaction contract is
 * IDENTICAL at both, which is exactly what the shared cases below prove.
 */
const SUMMARY_COLS = 160

/** Whether the read-only Reader is the mounted page (it REPLACES the picker, so
 *  the page is read from the wire, never from picker props). */
function inDetails(pane: TspPane): boolean {
  return readerNode(pane) !== undefined
}

/** Open the read-only Reader the ONE way the list-first shell offers it: enter the
 *  highlighted model's Overview, then its own details entry. */
async function openDetails(pane: TspPane): Promise<void> {
  if (inDetails(pane)) return
  if (props(pane).title !== undefined && String(props(pane).title).startsWith('Model overview') === false) {
    await enterOverview(pane)
  }
  if (String(props(pane).title).startsWith('Model overview')) {
    await walkList(pane, OVERVIEW_DETAILS_ID)
    pane.key('\r')
  }
  await waitUntil('the read-only Reader', () => inDetails(pane))
}

/** Leave the Reader the way the page really offers: its visible `Back` row. */
async function backFromDetails(pane: TspPane): Promise<void> {
  click(pane, readerBackNode(pane))
  await waitUntil('the Reader closed', () => !inDetails(pane))
}

/** Leave the Reader AND the Overview it was entered from, the way each page
 *  really offers: the Reader's own `Back` row, then the Overview's `Back`. */
async function backToCatalogue(pane: TspPane): Promise<void> {
  if (inDetails(pane)) {
    await backFromDetails(pane)
    await waitUntil('back on the Overview', () => onOverview(pane))
  }
  if (onOverview(pane)) {
    action(pane, 'back')
    await waitUntil('back on the catalogue', () => onCatalogue(pane))
  }
}

/** Send an action AT whatever node the layer mounts — the picker, or the Reader
 *  that replaces it on the details page (a forged receiver must be addressable
 *  there too). */
function forge(pane: TspPane, act: string, value?: string): void {
  const id = picker(pane)?.id ?? readerNode(pane)?.id
  assert.ok(id, 'a model layer node must be mounted')
  action(pane, act, value, id)
}

/** Every fact VALUE the mounted Reader carries, keyed by the stable key the view
 *  built it from (`reader-model`, `reader-fact-current`, …). */
function readerFacts(pane: TspPane): Map<string, string> {
  const out = new Map<string, string>()
  for (const node of nodes(pane)) {
    if (node.k !== 'text') continue
    const at = String(node.id).lastIndexOf('.reader-')
    if (at < 0) continue
    out.set(String(node.id).slice(at + 1), String(node.p.text ?? ''))
  }
  return out
}

/** The `▸` focus cue of one action bar entry, per pane. */
function focusCue(pane: TspPane, id: string): boolean {
  return String(actionOf(pane, id)?.label).startsWith('▸')
}

/** Leave whatever content page is open until the catalogue is the page again. */
async function backToModels(pane: TspPane): Promise<void> {
  for (let step = 0; step < 3 && !onCatalogue(pane); step += 1) {
    action(pane, 'back')
    await settle(20)
  }
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
}

const directory: ModelPickerDirectory = {
  current: { provider: 'a', model: 'same', reasoningEffort: 'high' },
  directory: {
    default: { provider: 'a', model: 'same', reasoningEffort: 'high' },
    routableProviders: ['a', 'b'],
    groups: [
      {
        id: 'a',
        name: 'A',
        models: [
          {
            id: 'same',
            name: 'Twin',
            reasoning: {
              efforts: [
                { id: 'low', name: 'Low' },
                { id: 'high', name: 'High' },
              ],
            },
          },
        ],
      },
      { id: 'b', name: 'B', models: [{ id: 'same', name: 'Twin' }] },
    ],
    failures: [{ id: 'bad', name: 'Bad', message: 'Provider unavailable' }],
  },
}
const SAME_A = JSON.stringify(['a', 'same'])
const SAME_B = JSON.stringify(['b', 'same'])

/** One mounted renderer over the scripted pane, with a write/retry spy. */
async function mounted(t: { after(fn: () => unknown): void }, subject = { sessionless: true }) {
  const pane = installTspPane({ modelPicker: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, {
    requestExit() {},
    onFatal: (e) => assert.fail(String(e)),
  })
  t.after(() => renderer.dispose())
  renderer.bindInput({
    exit() {},
    cancel() {},
    submit: () => assert.fail('picker must capture Enter'),
    steer() {},
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
  })
  assert.ok(renderer.modelPresentation)
  const writes: unknown[] = []
  let resolve!: (outcome: ModelApplyOutcome) => void
  let retries = 0
  const handle = renderer.modelPresentation.open({
    subject,
    isCurrent: () => true,
    retry: () => {
      retries += 1
    },
    apply: (selection: unknown) =>
      new Promise<ModelApplyOutcome>((r) => {
        writes.push(selection)
        resolve = r
      }),
    runOwned: (label, task, options) =>
      runOwned(label, task, { ...options, diag: { debug() {}, warn() {}, error() {} } as never }),
  })
  // Every case starts on the suite's NARROW pane (100 columns = 800px, below the
  // measured summary threshold): the interaction contract is the SAME at every
  // width, and a case that exercises the wide summary resizes up explicitly.
  const firstFrame = picker(pane)?.id
  sendResize(pane, 100)
  await waitUntil('the narrow pane is committed', () => picker(pane)?.id !== firstFrame)
  return {
    pane,
    renderer,
    handle,
    writes,
    retries: () => retries,
    settleWrite: (outcome: ModelApplyOutcome) => resolve(outcome),
    ready: async (d: ModelPickerDirectory = directory) => {
      handle.setLoading()
      handle.setDirectory(d)
      await waitUntil('native picker ready', () => props(pane).state === 'ready')
    },
  }
}

/** One fixture whose wide column provably cannot hold everything: long effort
 *  labels, a very long provider name, or a critical number of short efforts. */
function budgetDirectory(options: {
  readonly providerName?: string
  readonly modelId?: string
  readonly effortNames?: readonly string[]
  readonly description?: string
  readonly omitDefaultEffort?: boolean
  /** The advertised effort the CONFIGURED selection carries, when any. */
  readonly configuredEffort?: string
}): ModelPickerDirectory {
  const model = options.modelId ?? 'budget'
  return {
    current: { provider: 'p', model, ...(options.configuredEffort === undefined ? {} : { reasoningEffort: options.configuredEffort }) },
    directory: {
      default: { provider: 'p', model, ...(options.configuredEffort === undefined ? {} : { reasoningEffort: options.configuredEffort }) },
      routableProviders: ['p'],
      groups: [
        {
          id: 'p',
          name: options.providerName ?? 'provider p',
          models: [
            {
              id: model,
              name: 'Budget Model',
              ...(options.description === undefined ? {} : { description: options.description }),
              ...(options.effortNames === undefined
                ? {}
                : {
                    reasoning: {
                      ...(options.omitDefaultEffort === true ? {} : { defaultEffort: 'high' }),
                      // Unique ids even when the labels are identical, so a
                      // last-candidate walk is a real walk.
                      efforts: options.effortNames.map((name, index) => ({
                        id: `e${index + 1}`,
                        name,
                      })),
                    },
                  }),
            },
          ],
        },
      ],
      failures: [],
    },
  }
}

/* ------------------------------------------------------- Models (list-first) */

test('native Model: the list-first catalogue browses, drafts in the Overview and writes once', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // The narrow catalogue is the SAME picker as the wide one: no provider sidebar,
  // no preview region, and the ONE write named for what it really does.
  assert.equal(props(pane).title, 'Choose default model')
  assert.equal(props(pane).subtitle, 'Enter: effort & details', 'the panel carries exactly ONE short hint')
  assert.equal(props(pane).size, 'md')
  assert.equal(props(pane).preview, 'none', 'a narrow pane paints no preview region')
  assert.equal(props(pane).focus, 'list')
  assert.equal(props(pane).scopes, undefined, 'the list-first catalogue has no provider sidebar')
  assert.deepEqual(props(pane).current, [], 'sessionless never fabricates a current badge')
  assert.equal(actionOf(pane, 'apply')?.label, 'Save default')
  // ONE row per model: the model name is the main information, the provider is a
  // deterministic MARK, and the row carries its complete id.
  const rows = (props(pane).items ?? []) as Array<Record<string, unknown>>
  const rowOf = (id: string): Record<string, unknown> | undefined =>
    rows.find((item) => String(item.id) === id)
  assert.deepEqual(rows.map((item) => String(item.id)).slice(0, 2), [SAME_A, SAME_B])
  assert.equal(rowOf(SAME_A)?.label, 'Twin')
  assert.deepEqual(rowOf(SAME_A)?.mark, { text: 'A', seed: 'a' })
  assert.equal(rowOf(SAME_A)?.title, 'same')
  assert.deepEqual(rowOf(SAME_A)?.badges, [{ text: 'Default' }], 'the directory fact, never the highlight')
  // The ONE optional fact column makes the drafted effort visible at the FIRST
  // level (changing it stays the Overview's job), and a model that advertises no
  // effort carries no fact at all.
  assert.deepEqual(props(pane).columns, [
    { id: 'effort', head: 'Effort', format: 'text', priority: 1, min: 6 },
  ])
  assert.deepEqual(rowOf(SAME_A)?.facts, { effort: 'High' }, 'the seeded draft is stated on its own row')
  assert.equal(rowOf(SAME_B)?.facts, undefined, 'a model without efforts states no fact')
  // The order pins the REAL configured rows first (each model exactly once), then
  // groups the rest by provider, and ends with the partial-failure context.
  assert.deepEqual(props(pane).order, [
    { group: '\u0000current-default', label: 'Current / Default', count: 1 },
    SAME_A,
    { group: 'b', label: 'B', count: 1 },
    SAME_B,
    { group: '\u0000unavailable', label: 'Unavailable providers', count: 2 },
    'failure:bad',
    FAILURE_RETRY_ID,
  ])
  // A SELECT only MOVES the highlight: it never pages and never writes.
  browse(pane, SAME_B)
  await waitUntil('the highlight moved to B', () => props(pane).selected === SAME_B)
  assert.equal(onCatalogue(pane), true, 'a select never leaves the catalogue')
  assert.equal(m.writes.length, 0)
  // Enter (the keyboard's own activate) enters the HIGHLIGHTED model's Overview,
  // which leads with every advertised effort candidate.
  await walkList(pane, SAME_A)
  await enterOverview(pane)
  assert.deepEqual(rowIds(pane), [
    OVERVIEW_MODEL_ID,
    OVERVIEW_EFFORT_ID,
    effortItemId('\u0000provider-default'),
    effortItemId('low'),
    effortItemId('high'),
    OVERVIEW_DETAILS_ID,
  ])
  assert.equal(props(pane).subtitle, 'A · Default', 'the Overview names the provider and the real state')
  // Drafting an effort row changes the LOCAL draft only.
  await walkList(pane, effortItemId('low'))
  pane.key('\r')
  await waitUntil('the effort row drafted Low', () => candidateMark(pane, effortItemId('low')) === '●')
  assert.equal(m.writes.length, 0, 'choosing a draft never writes')
  // Tab reaches the explicit Primary Action; Enter then commits exactly once.
  pane.key('\t')
  await waitUntil('primary focused', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\r')
  await waitUntil('one admitted write', () => m.writes.length === 1)
  assert.deepEqual(m.writes, [{ provider: 'a', model: 'same', reasoningEffort: 'low' }])
})

test('native Model: the wide catalogue paints only a READ-ONLY summary, never a required action', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await resize(pane, SUMMARY_COLS)
  await waitUntil('the wide catalogue', () => props(pane).size === 'lg' && props(pane).preview === 'below')
  // The summary carries the highlighted model's REAL facts in the picker's own
  // below-list region: no handler, no candidate, no write.
  const summary = layerNodes(pane).find((node) => node.k === 'kv')
  assert.ok(summary, 'the wide catalogue paints its selected-model summary')
  const items = (summary.p.items ?? []) as Array<{ k?: string; v?: string }>
  assert.deepEqual(items.map((item) => item.k), ['Provider', 'Draft effort', 'Selection'])
  assert.deepEqual(items.map((item) => item.v), ['A', 'High', 'default'])
  assert.equal(summary.p.actions, undefined, 'the summary is not an action owner')
  // Narrowing removes INFORMATION and nothing else: the same rows, the same ONE
  // write, the same page.
  await resize(pane, 100)
  await waitUntil('the narrow catalogue', () => props(pane).size === 'md' && props(pane).preview === 'none')
  assert.equal(layerNodes(pane).some((node) => node.k === 'kv'), false, 'the narrow pane paints no summary')
  assert.equal(actionOf(pane, 'apply')?.label, 'Save default')
  assert.equal(actionOf(pane, 'apply')?.disabled, undefined, 'the write was never a preview entry')
  assert.deepEqual(actionIds(pane), ['close', 'apply'])
})

test('native Model: a row select only highlights, and only a real row can act', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Every wire shape the list-first shell does NOT have anymore fails closed: a
  // scope action, a scope-shaped row id, a failure row and an unknown id.
  const frame = picker(pane)!.id
  for (const act of ['scope', 'details', 'effort-page', 'more:apply']) action(pane, act, 'scope:a')
  browse(pane, 'scope:b')
  browse(pane, 'failure:bad')
  browse(pane, 'not-a-row')
  sendActivate(pane, 'not-a-row')
  await settle(30)
  assert.equal(props(pane).scope, undefined, 'no wire shape can filter a catalogue that has no sidebar')
  assert.equal(onCatalogue(pane), true, 'nor navigate it')
  assert.equal(m.writes.length, 0, 'and none of them can write')
  assert.equal(picker(pane)!.id, frame, 'a refused shape does not even re-render')
  assert.equal(m.retries(), 0, 'an inert failure row never starts a read')
  // The POSITIVE control behind those negatives: the ONE retry row the partial
  // failure adds routes to the command's existing read owner — never the writer.
  browse(pane, FAILURE_RETRY_ID)
  await waitUntil('the retry row asked the read owner', () => m.retries() === 1)
  assert.equal(m.writes.length, 0, 'the retry row is a read, not a write')
  await m.ready()
  // ...and it is part of the app's OWN cursor walk (measured: the client moves no
  // list cursor by itself), so a keyboard user reaches it too — Enter runs the
  // same read-only re-read, and no model is the write target while it is on.
  for (let step = 0; step < 8 && props(pane).selected !== FAILURE_RETRY_ID; step += 1) {
    pane.key('\u001b[B')
    await settle(10)
  }
  assert.equal(props(pane).selected, FAILURE_RETRY_ID, 'the cursor really reaches the retry row')
  assert.equal(actionOf(pane, 'apply')?.disabled, true, 'no highlighted model means no write target')
  pane.key('\r')
  await waitUntil('Enter ran the retry row', () => m.retries() === 2)
  assert.equal(m.writes.length, 0, 'the keyboard retry is a read too')
  await m.ready()
  // A candidate id belongs to the Overview's own namespace: a catalogue select
  // carrying it resolves nowhere.
  browse(pane, effortItemId('low'))
  await settle(30)
  assert.equal(onCatalogue(pane), true)
  assert.equal(m.writes.length, 0)
  // A RETIRED frame's receiver is absent from the current one, so a row event
  // addressed to it can neither re-target the highlight nor the page.
  const staleFrame = picker(pane)!.id
  browse(pane, SAME_A)
  await nextPickerFrame(pane)
  sendActivate(pane, SAME_B, staleFrame)
  browse(pane, SAME_B, staleFrame)
  await settle(30)
  assert.equal(onCatalogue(pane), true, 'a retired receiver cannot navigate')
  assert.equal(props(pane).selected, SAME_A, 'and it cannot re-target the highlight either')
  assert.equal(m.writes.length, 0)
})

test('native Model K2: Enter never writes from the list; the write is the focused Primary Action', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Enter on the catalogue ENTERS the highlighted model (it never writes and never
  // reaches the bar), and Esc returns.
  pane.key('\r')
  await waitUntil('the Overview', () => onOverview(pane))
  assert.equal(m.writes.length, 0, 'Enter on the catalogue is not a write')
  pane.key('\u001b')
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
  // The bar is the only region that can commit: Tab reaches it and the focused
  // Primary Action carries the app-rendered shape cue.
  pane.key('\t')
  await waitUntil('primary focused', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  assert.equal(actionOf(pane, 'apply')?.label, '▸ Save default')
  pane.key('\r')
  await waitUntil('write from the primary action', () => m.writes.length === 1)
  // A pending seat refuses every further mutation and every further write.
  action(pane, 'apply')
  pane.key('\r')
  await settle(30)
  assert.equal(m.writes.length, 1, 'pending refuses a repeated apply')
  assert.equal(actionOf(pane, 'apply')?.label, 'Selecting…')
  assert.equal(actionOf(pane, 'apply')?.disabled, true)
})

test('native Model: the action bar per page and phase offers only what it can run', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // The catalogue at EVERY width: the ONE write plus its way out. A partial
  // failure does NOT add a footer button — its context and its one read-only
  // Retry row live at the end of the list.
  assert.equal(props(pane).size, 'md', 'the fixture pane is the narrow catalogue')
  assert.deepEqual(actionIds(pane), ['close', 'apply'])
  assert.deepEqual(actionLabels(pane), ['Cancel', 'Save default'])
  assert.equal(
    ((props(pane).items ?? []) as Array<Record<string, unknown>>).some((item) => item.id === FAILURE_RETRY_ID),
    true,
    'the partial failure is a real row of the list, not a third button',
  )
  await resize(pane, SUMMARY_COLS)
  await waitUntil('the wide catalogue', () => props(pane).size === 'lg')
  assert.deepEqual(actionIds(pane), ['close', 'apply'], 'the SAME bar at the wide pane')
  await resize(pane, 100)
  await waitUntil('the narrow catalogue again', () => props(pane).size === 'md')
  // The Overview is the model's own actionable page: `Back` + the ONE write — no
  // `Cancel` (a user leaves with Back/Esc and cancels from the catalogue).
  await enterOverview(pane)
  assert.deepEqual(actionIds(pane), ['back', 'apply'])
  assert.deepEqual(actionLabels(pane), ['Back', 'Save default'])
  assert.equal(actionOf(pane, 'close'), undefined, 'the Overview footer carries no Cancel')
  // The read-only Full details page is the native Reader: no picker, therefore no
  // action bar at all — no cancel entry, no write and no selectable row.
  await walkList(pane, OVERVIEW_DETAILS_ID)
  pane.key('\r')
  await waitUntil('details page', () => inDetails(pane))
  assert.equal(picker(pane), undefined, 'the Reader replaces the picker instead of carrying its bar')
  // Read the Reader's OWN subtree from the wire: a picker-prop read would be
  // vacuous here, because the helpers return `{}` while no picker is mounted.
  const readerSubtree = layerNodes(pane)
  assert.equal(readerSubtree.some((node) => node.k === 'picker'), false, 'the Reader subtree carries no picker')
  assert.equal(readerSubtree.some((node) => Array.isArray(node.p.actions)), false, 'nor any action bar')
  assert.deepEqual(
    readerSubtree.filter((node) => node.p.actions !== undefined).map((node) => node.id),
    [readerBackNode(pane).id],
    'its ONE interactive node is the visible Back row',
  )
  // The panel's own dismissal authority stays ADMITTED there (the client's
  // backdrop gesture is the same intent Esc uses), it is just not a button.
  forge(pane, 'close')
  await waitUntil('a backdrop-style close still dismisses the panel', () => readerNode(pane) === undefined)
  m.handle.close()
  // A LIVE subject names the same action differently: it switches the Session.
  const live = await mounted(t, { sessionless: false })
  await live.ready()
  assert.equal(actionOf(live.pane, 'apply')?.label, 'Switch')
  assert.equal(actionOf(live.pane, 'apply')?.primary, true)
  live.handle.close()
})

test('native Model: `select` only highlights and `activate` enters THAT row Overview atomically', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Arrow keys only move the highlight: they must never page the surface.
  pane.key('\u001b[B')
  await waitUntil('the highlight moved', () => props(pane).selected !== SAME_A)
  assert.equal(onCatalogue(pane), true, 'an arrow never opens a page')
  assert.equal(m.writes.length, 0)
  // A row SELECT moves the highlight onto the row it really names — and nothing
  // else, at every width.
  browse(pane, SAME_B)
  await waitUntil('the highlight is B', () => props(pane).selected === SAME_B)
  assert.equal(onCatalogue(pane), true, 'a select never pages the surface away')
  assert.equal(m.writes.length, 0, 'a select never writes')
  // `activate` (a click on the already-highlighted row, or Enter) enters THAT
  // model's Overview. The event addresses the CURRENT frame's picker.
  await nextPickerFrame(pane)
  sendActivate(pane, SAME_B)
  await waitUntil('activate opens the Overview of B', () =>
    onOverview(pane) && rowIds(pane)[0] === OVERVIEW_MODEL_ID)
  assert.equal(m.writes.length, 0, 'opening the Overview never writes')
  action(pane, 'back')
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
  // A whole-model switch needs no Overview: the catalogue's own Primary Action
  // commits the HIGHLIGHTED model with its already-seeded draft.
  const frame = picker(pane)!.id
  pane.key('\u001b[Z')
  await waitUntil('primary focused', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\r')
  await waitUntil('one write from the catalogue', () => m.writes.length === 1)
  assert.deepEqual(m.writes, [{ provider: 'b', model: 'same' }], 'the highlighted model, its own draft')
  m.settleWrite('rejected')
  await waitUntil('the refusal restores the catalogue', () => picker(pane) !== undefined && picker(pane)!.id !== frame)
})

test('native Model: the Overview leads with every advertised candidate and the details entry', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await resize(pane, 100)
  await waitUntil('the narrow catalogue', () => props(pane).size === 'md')
  await enterOverview(pane)
  // The page's MAIN LIST rows, in the frozen priority order: the model's OWN
  // identity row (its name, with the complete id as the row's `title`), then the
  // effort section (its head plus every advertised candidate), then the single
  // operation row. The identity is a ROW because the page's caption cannot carry it
  // on a narrow pane (a title is ellipsized and no subtitle is painted at
  // 400/560px, both measured). The configured Current/Default facts stay OUT of the
  // list — the subtitle and the Reader carry those — which is what keeps every
  // effort candidate on the first screen.
  assert.deepEqual(rowIds(pane), [
    OVERVIEW_MODEL_ID,
    OVERVIEW_EFFORT_ID,
    effortItemId('\u0000provider-default'),
    effortItemId('low'),
    effortItemId('high'),
    OVERVIEW_DETAILS_ID,
  ])
  assert.equal(String(props(pane).title), 'Model overview')
  assert.equal(props(pane).subtitle, 'A · Default')
  // The page's FIRST row is its own identity: the client ellipsizes a caption and
  // paints no subtitle at 400/560px, so the model being configured must be a row.
  const modelRow = ((props(pane).items ?? []) as Array<Record<string, unknown>>)
    .find((item) => String(item.id) === OVERVIEW_MODEL_ID)
  assert.equal(modelRow?.label, 'Twin', 'the identity row names the model')
  assert.equal(modelRow?.title, 'same', 'and carries its complete id')
  assert.equal(detailOf(pane, OVERVIEW_EFFORT_ID), undefined, 'the section head is a label, not a value')
  assert.equal(candidateMark(pane, effortItemId('high')), '●', 'the configured draft is marked')
  assert.equal(candidateMark(pane, effortItemId('low')), '○')
  // The keyboard walks EVERY row, and Enter on the identity row and on the section
  // head is inert.
  assert.equal(props(pane).selected, OVERVIEW_MODEL_ID, 'the cursor starts on the identity row')
  pane.key('\r')
  await settle(30)
  assert.equal(onOverview(pane), true, 'Enter on the identity row is inert')
  pane.key('\u001b[B')
  await waitUntil('the cursor moved to the section head', () => props(pane).selected === OVERVIEW_EFFORT_ID)
  pane.key('\r')
  await settle(30)
  assert.equal(onOverview(pane), true, 'Enter on the section head is inert')
  assert.equal(m.writes.length, 0)
  // An effort row drafts and nothing else, by key and by pointer.
  await walkList(pane, effortItemId('low'))
  pane.key('\r')
  await waitUntil('the effort row drafted Low', () => candidateMark(pane, effortItemId('low')) === '●')
  assert.equal(m.writes.length, 0, 'an effort row never writes')
  assert.equal(onOverview(pane), true, 'a candidate row never leaves the page')
  // The details entry opens the read-only Reader.
  await walkList(pane, OVERVIEW_DETAILS_ID)
  pane.key('\r')
  await waitUntil('details from the Overview', () => inDetails(pane))
  // A pointer activation on the same rows resolves the same way.
  await backFromDetails(pane)
  await waitUntil('back on the Overview', () => onOverview(pane))
  browse(pane, effortItemId('high'))
  await waitUntil('the pointer row drafted High', () => candidateMark(pane, effortItemId('high')) === '●')
  assert.equal(m.writes.length, 0)
})

test('native Model: the Overview commits the model and its drafted effort exactly once', async (t) => {
  const m = await mounted(t, { sessionless: false })
  await m.ready()
  const { pane } = m
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  await enterOverview(pane)
  await walkList(pane, effortItemId('low'))
  pane.key('\r')
  await waitUntil('the effort row drafted Low', () => candidateMark(pane, effortItemId('low')) === '●')
  assert.equal(m.writes.length, 0, 'choosing a draft never writes')
  // The ring is list <-> bar on a content page: one Tab reaches the write.
  pane.key('\t')
  await waitUntil('the Overview primary is focused', () => actionOf(pane, 'apply')?.label === '▸ Switch')
  pane.key('\r')
  await waitUntil('one admitted write', () => m.writes.length === 1)
  assert.deepEqual(m.writes, [{ provider: 'a', model: 'same', reasoningEffort: 'low' }])
})

test('native Model: the Reader is entered from the Overview and Back returns to it', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Prepare browse state that must survive the round trip.
  browse(pane, SAME_B)
  await waitUntil('the highlight is B', () => props(pane).selected === SAME_B)
  await openDetails(pane)
  assert.equal(picker(pane), undefined, 'the Reader is not a picker: no preview region and no action bar')
  assert.equal(readerBodyNode(pane) !== undefined, true, 'the Reader carries its scrollable body')
  assert.equal(readerBackNode(pane).p.actions !== undefined, true, 'its Back row is a real pointer target')
  // A forged apply from this page is refused on the wire.
  forge(pane, 'apply')
  await settle(30)
  assert.equal(m.writes.length, 0, 'a forged apply on the read-only page is refused')
  assert.equal(inDetails(pane), true, 'and it cannot navigate either')
  await backFromDetails(pane)
  await waitUntil('back on the Overview it came from', () => onOverview(pane))
  assert.equal(props(pane).subtitle, 'B', 'the Overview still describes the model it was entered for')
  // The keyboard path is the same page: Esc is the visible Back row's own intent.
  pane.key('\r')
  await waitUntil('details from the keyboard', () => inDetails(pane))
  pane.key('\u001b')
  await waitUntil('Esc returns to the Overview', () => onOverview(pane))
  action(pane, 'back')
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
  assert.equal(props(pane).focus, 'list')
})

test('native Model: the Reader paints no action bar and no write can be forged from it', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // The catalogue DOES own the one write at every width; it is the Reader that
  // carries no picker at all.
  assert.ok(actionOf(pane, 'apply'), 'the catalogue owns the one write')
  await openDetails(pane)
  assert.equal(picker(pane), undefined, 'the Reader carries no picker, so no action bar and no write')
  const detailsNode = readerNode(pane)?.id
  forge(pane, 'apply')
  await settle(30)
  assert.equal(m.writes.length, 0, 'a forged apply on the details page is refused')
  assert.equal(readerNode(pane)?.id, detailsNode, 'and it cannot navigate or even re-render either')
  // Only the Overview carries the write back, and it is the same one writer.
  await backFromDetails(pane)
  await waitUntil('back on the Overview', () => onOverview(pane))
  assert.ok(actionOf(pane, 'apply'), 'the Overview owns the one write')
})

/* ----------------------------------------------------------- writes/lifecycle */

test('native Model: proven refusal stays usable, uncertain settlement closes, supersession stays silent', async (t) => {
  const pane = installTspPane({ modelPicker: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, { requestExit() {}, onFatal: (e) => assert.fail(String(e)) })
  t.after(() => renderer.dispose())
  renderer.bindInput({ exit() {}, cancel() {}, submit() {}, steer() {}, noteUserInput() {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false })
  assert.ok(renderer.modelPresentation)
  // The panel opens INSIDE the loop below, so the resize is delivered before any
  // handle exists. The catalogue owns the ONE write at every width.
  sendResize(pane, 100)
  await settle(30)
  for (const outcome of ['rejected', 'cancelled', 'unsupported', 'indeterminate', 'superseded'] as const) {
    let resolve!: (outcome: ModelApplyOutcome) => void
    const handle = renderer.modelPresentation.open({
      subject: { sessionless: false },
      isCurrent: () => true,
      retry: () => assert.fail('no read failure in this scenario'),
      apply: () => new Promise<ModelApplyOutcome>((r) => {
        resolve = r
      }),
      runOwned: (label, task, options) => runOwned(label, task, { ...options, diag: { debug() {}, warn() {}, error() {} } as never }),
    })
    handle.setDirectory(directory)
    await waitUntil('ready for ' + outcome, () => props(pane).state === 'ready')
    browse(pane, SAME_B)
    await waitUntil('plain model', () => props(pane).selected === SAME_B)
    // The ring is list <-> bar, so Shift+Tab wraps straight onto the Primary
    // Action.
    pane.key('\u001b[Z')
    pane.key('\r')
    await waitUntil('pending ' + outcome, () => resolve !== undefined)
    const pendingId = picker(pane)!.id
    resolve(outcome)
    if (outcome === 'indeterminate') await waitUntil('uncertain closes', () => picker(pane) === undefined)
    else if (outcome === 'superseded') {
      await settle(30)
      assert.equal(picker(pane)!.id, pendingId)
    } else {
      await waitUntil('refusal clears pending', () => picker(pane) !== undefined && picker(pane)!.id !== pendingId)
      assert.ok(!actionOf(pane, 'apply')?.disabled, 'a refusal restores the primary action')
      assert.deepEqual(props(pane).current, [SAME_A], 'a refusal never paints the requested model as current')
      assert.match(String(props(pane).message), /(Rejected|Cancelled|Unsupported)\./,
        'the refusal is reported as the panel notice')
      assert.equal(onCatalogue(pane), true, 'a refusal leaves the page the user was on usable')
    }
    handle.close()
    await waitUntil('retired', () => picker(pane) === undefined)
  }
})

test('native Model: a refusal on the Overview keeps that page and its draft', async (t) => {
  const m = await mounted(t, { sessionless: false })
  await m.ready()
  const { pane } = m
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  await enterOverview(pane)
  await walkList(pane, effortItemId('low'))
  pane.key('\r')
  await waitUntil('drafted Low', () => onOverview(pane))
  pane.key('\t')
  await waitUntil('the Overview primary is focused', () => actionOf(pane, 'apply')?.label === '▸ Switch')
  pane.key('\r')
  await waitUntil('the write is admitted', () => m.writes.length === 1)
  // An admitted write refuses every page operation, so its bar renders the way out
  // and the disabled write — never a clickable `Back` that nothing could run.
  assert.deepEqual(actionIds(pane), ['close', 'apply'], 'a pending Overview offers Close + the disabled write')
  assert.equal(actionOf(pane, 'back'), undefined, 'the visible Back is gone while the write is admitted')
  forge(pane, 'back')
  await settle(30)
  assert.equal(onOverview(pane), true, 'a forged Back cannot navigate an admitted write')
  assert.equal(actionOf(pane, 'apply')?.label, 'Selecting…', 'and it cannot cancel the admitted write either')
  m.settleWrite('rejected')
  await waitUntil('the refusal clears pending', () => props(pane).focus === 'list')
  // The Overview is still the page, and the draft it shows is the one chosen.
  assert.equal(onOverview(pane), true)
  assert.equal(props(pane).focus, 'list', 'the keyboard is back on the list, so Enter cannot repeat the write')
  assert.equal(candidateMark(pane, effortItemId('low')), '●', 'the draft the user chose is still the draft')
  // The refusal is reported by the dock notice (the native picker paints its
  // `message` only in the error state), and the panel is usable again.
  assert.ok(actionOf(pane, 'apply'), 'the write is offered again after a refusal')
})

test('native Model: a failed directory read shows ONE Retry and re-reads from the primary action', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  m.handle.setLoadError('catalog is unreachable')
  await waitUntil('error state', () => props(pane).state === 'error')
  assert.match(String(props(pane).message), /catalog is unreachable/)
  assert.equal(m.retries(), 0, 'showing the error never reads again by itself')
  assert.deepEqual(actionIds(pane), ['close', 'retry'], 'a failed read offers Cancel and the read-only Retry')
  assert.equal(actionOf(pane, 'apply'), undefined, 'a failed read offers no write')
  // K2: the Tab-reachable primary action is the read-only Retry.
  pane.key('\t')
  await waitUntil('primary zone', () => String(actionOf(pane, 'retry')?.label).startsWith('▸'))
  pane.key('\r')
  await waitUntil('retry asked the original read owner', () => m.retries() === 1)
  assert.equal(m.writes.length, 0, 'a Retry never writes')
  assert.equal(props(pane).state, 'loading', 'the retry re-enters loading')
  // The re-read hydrates the SAME panel (no second picker).
  const staleId = picker(pane)!.id
  await m.ready()
  assert.notEqual(picker(pane)!.id, staleId, 'the hydrated frame is a new revision')
  action(pane, 'apply', undefined, staleId)
  await settle(20)
  assert.equal(m.writes.length, 0, 'the loading frame receiver is retired')
  assert.equal(m.retries(), 1, 'one Retry is exactly one read')
})

test('native Model: resize keeps the panel and every page stays reachable', async (t) => {
  const m = await mounted(t)
  await m.ready(budgetDirectory({
    providerName: 'p',
    modelId: 'm',
    description: 'Note.',
    effortNames: ['Low', 'High'],
    omitDefaultEffort: true,
    // The configured selection carries an advertised effort, so one ArrowDown
    // wraps onto the provider-default sentinel.
    configuredEffort: 'e2',
  }))
  const { pane } = m
  // Narrow: the SAME catalogue, with no preview region and no sidebar.
  await resize(pane, 100)
  await waitUntil('the narrow catalogue', () => props(pane).size === 'md' && props(pane).preview === 'none')
  assert.equal(props(pane).scopes, undefined, 'the list-first catalogue has no provider sidebar')
  assert.equal(props(pane).title, 'Choose default model')
  assert.equal(
    (props(pane).items as Array<Record<string, unknown>>).some((item) => item.disabled !== undefined),
    false,
    'a directory without failed providers lists none',
  )
  // Details is the native READER replacing the picker: the complete values are
  // `ui.text` nodes the client wraps at its own real width, not pre-split rows.
  await enterOverview(pane)
  await walkList(pane, OVERVIEW_DETAILS_ID)
  pane.key('\r')
  await waitUntil('details page', () => inDetails(pane))
  assert.equal(picker(pane), undefined, 'the Reader is not a picker page')
  assert.equal(readerValue(pane, 'reader-description'), 'Note.', 'the Reader carries the real description')
  assert.equal(
    nodes(pane).some((n) => n.k === 'text' && n.p.wrap === 'word'),
    true,
    'a prose value is wrapped by the client (`word`), never pre-split by us',
  )
  // Its only interactive node is Back: Enter cannot write from the page.
  pane.key('\r')
  await settle(20)
  assert.equal(m.writes.length, 0, 'the Reader never writes')
  // Back restores the Overview; the effort candidate is chosen THERE now.
  await backFromDetails(pane)
  await waitUntil('back to the Overview', () => onOverview(pane))
  // The effort section sits ABOVE the details entry now, so the cursor walks the
  // page's real rows instead of assuming what follows the details entry.
  await walkList(pane, effortItemId('\u0000provider-default'))
  assert.equal(m.writes.length, 0, 'moving the cursor never writes')
  pane.key('\r')
  await waitUntil('the candidate took the draft', () => candidateMark(pane, effortItemId('\u0000provider-default')) === '●')
  pane.key('\t')
  await waitUntil('the Overview primary is focused', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\r')
  await waitUntil('write from the narrow primary action', () => m.writes.length === 1)
  assert.deepEqual(
    m.writes,
    [{ provider: 'p', model: 'm' }],
    'the provider-default draft submits WITHOUT a reasoningEffort literal',
  )
  // A refusal re-enables the panel with the chosen draft intact, and the draft
  // survives the flip to the wide layout (where it is readable in the summary).
  m.settleWrite('rejected')
  await waitUntil('refusal restores the panel', () => props(pane).state === 'ready')
  await resize(pane, SUMMARY_COLS)
  await waitUntil('the wide catalogue sheet', () => props(pane).size === 'lg')
  // A width flip never pages the panel on its own: the Overview the user was on
  // stays the Overview, and Back is what returns to the catalogue.
  assert.equal(onOverview(pane), true)
  action(pane, 'back')
  await waitUntil('the wide catalogue', () => onCatalogue(pane))
  const summary = layerNodes(pane).find((node) => node.k === 'kv')
  assert.deepEqual(
    ((summary?.p.items ?? []) as Array<{ k?: string; v?: string }>)
      .filter((item) => item.k === 'Draft effort').map((item) => item.v),
    ['Default'],
    'the draft chosen on the narrow page is the wide catalogue summary draft',
  )
})

test('native Model: browsing, effort, graphemes, modal and stale receiver fences', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  action(pane, 'unknown-action')
  action(pane, 'scope', 'scope:bad')
  action(pane, 'details')
  action(pane, 'effort-page')
  browse(pane, JSON.stringify(['nope', 'nope']))
  pane.event({ ev: 'action', sf: 'retired-surface', id: picker(pane)!.id, act: 'apply' })
  await settle(30)
  assert.equal(props(pane).scope, undefined, 'a disabled provider scope never filters')
  assert.equal(m.writes.length, 0, 'unknown actions, failure scopes, foreign surfaces and unlisted rows never write')
  const oldId = picker(pane)!.id
  const approval = m.renderer.interaction.showApprovalPrompt(
    { toolName: 'bash', reason: 'modal precedence' },
    false,
  )
  await settle(30)
  action(pane, 'apply', undefined, oldId)
  browse(pane, SAME_A, oldId)
  await settle(30)
  assert.equal(m.writes.length, 0, 'approval masks the model write seat')
  assert.equal(layerNodes(pane).length, 0, 'the modal owns the layer')
  pane.key('\u001b')
  await approval
  await waitUntil('model resumes', () => picker(pane) !== undefined && picker(pane)!.id !== oldId)
  action(pane, 'apply', undefined, oldId)
  browse(pane, SAME_A, oldId)
  await settle(30)
  assert.equal(m.writes.length, 0, 'a pre-modal receiver stays retired after resume')
  pane.key('👩‍💻e\u0301')
  await waitUntil('grapheme query', () => props(pane).query === '👩‍💻e\u0301')
  pane.key('\u001b[D')
  pane.key('\u007f')
  await waitUntil('grapheme delete', () => props(pane).query === 'e\u0301')
  assert.equal(props(pane).cursor, 0)
  const beforeHydration = picker(pane)!.id
  m.renderer.display.beginSessionHydration()
  await waitUntil('hydration retires panel', () => picker(pane) === undefined)
  action(pane, 'apply', undefined, beforeHydration)
  await settle(30)
  assert.equal(m.writes.length, 0)
})

test('production /model: sessionless pending save, close/reopen and settled default', async (t) => {
  const life = testLifecycle(t),
    home = life.tempDir('dsh-tsp-model-default-')
  let release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  const saved: unknown[] = []
  const boot = await ownTspBoot({
    life,
    home,
    logFile: home + '/diag.log',
    modelPicker: true,
    saveDefault: async (next) => {
      saved.push(next)
      await gate
    },
  })
  try {
    await waitUntil('renderer ready', () => boot.pane.output.text().includes('dock.composer'))
    boot.pane.key('/model\r')
    await waitUntil(
      'classified /model opens native picker',
      () => props(boot.pane).state === 'ready',
    )
    // The wide shell (and its `subtitle` slot) is the pane past the measured
    // native side-preview boundary; the fixture's own pane is compact.
    await resize(boot.pane, SUMMARY_COLS)
    assert.equal(props(boot.pane).title, 'Choose default model')
    assert.equal(actionOf(boot.pane, 'apply')?.label, 'Save default')
    assert.equal(saved.length, 0)
    assert.equal(boot.harness.createdSessions.length, 0)
    browse(boot.pane, JSON.stringify(['p', 'm2']))
    await waitUntil('m2 browse', () => props(boot.pane).selected === JSON.stringify(['p', 'm2']))
    assert.equal(saved.length, 0)
    // Shift+Tab wraps the ring straight onto the Primary Action.
    boot.pane.key('\u001b[Z')
    boot.pane.key('\r')
    await waitUntil('original default persistence sink', () => saved.length === 1)
    assert.deepEqual(saved, [{ provider: 'p', model: 'm2' }])
    assert.equal(boot.harness.createdSessions.length, 0, 'default selection must not create a session')
    await waitUntil('pending action', () => actionOf(boot.pane, 'apply')?.label === 'Selecting…')
    boot.pane.key('\u001b')
    await waitUntil('close picker', () => picker(boot.pane) === undefined)
    boot.pane.key('/model\r')
    await waitUntil('reopened old default', () => props(boot.pane).state === 'ready')
    const id = picker(boot.pane)!.id
    release()
    await settle(60)
    assert.equal(picker(boot.pane)!.id, id)
    boot.pane.key('\u001b')
    await waitUntil('close again', () => picker(boot.pane) === undefined)
    boot.pane.key('/model\r')
    await waitUntil('authoritative saved default', () => props(boot.pane).selected === JSON.stringify(['p', 'm2']))
    assert.deepEqual(props(boot.pane).current, [])
    assert.equal(saved.length, 1)
    assert.equal(boot.harness.createdSessions.length, 0)
  } finally {
    release()
    await boot.settle()
  }
})

test('production /model: failed default remains indeterminate and reconciles from Host read', async (t) => {
  const life = testLifecycle(t),
    home = life.tempDir('dsh-tsp-model-unknown-')
  let saves = 0
  const boot = await ownTspBoot({
    life,
    home,
    logFile: home + '/diag.log',
    modelPicker: true,
    saveDefault: async () => {
      saves++
      throw new Error('disk failure')
    },
  })
  try {
    await waitUntil('renderer ready', () => boot.pane.output.text().includes('dock.composer'))
    boot.pane.key('/model\r')
    await waitUntil('picker ready', () => props(boot.pane).state === 'ready')
    await resize(boot.pane, SUMMARY_COLS)
    // Shift+Tab wraps straight onto the Primary Action.
    boot.pane.key('\u001b[Z')
    boot.pane.key('\r')
    await waitUntil('original indeterminate notice', () =>
      boot.pane.output.text().includes('default may still land'),
    )
    await waitUntil('indeterminate dismisses', () => picker(boot.pane) === undefined)
    assert.equal(saves, 1)
    boot.pane.key('/model\r')
    await waitUntil('read reconciliation', () => props(boot.pane).state === 'ready')
    assert.equal(props(boot.pane).title, 'Choose default model')
    assert.deepEqual(props(boot.pane).current, [], 'sessionless never paints a current model')
    assert.equal(boot.harness.createdSessions.length, 0)
  } finally {
    await boot.settle()
  }
})

test('production /model: a failed read offers a real Retry through the original read owner', async (t) => {
  const life = testLifecycle(t), home = life.tempDir('dsh-tsp-model-retry-')
  const original = DirectModelCatalog.prototype.loadDirectory
  let reads = 0
  DirectModelCatalog.prototype.loadDirectory = async function (...args) {
    reads += 1
    if (reads === 1) throw new Error('catalog is unreachable')
    return original.apply(this, args)
  }
  const boot = await ownTspBoot({ life, home, logFile: home + '/diag.log', modelPicker: true })
  try {
    await waitUntil('renderer ready', () => boot.pane.output.text().includes('dock.composer'))
    boot.pane.key('/model\r')
    await waitUntil('read error state', () => props(boot.pane).state === 'error')
    assert.match(String(props(boot.pane).message), /catalog is unreachable/)
    boot.pane.key('\t')
    boot.pane.key('\r')
    await waitUntil('the original read owner is asked again', () => reads === 2)
    await waitUntil('hydrated by the retry', () => props(boot.pane).state === 'ready')
    await resize(boot.pane, SUMMARY_COLS)
    assert.equal(props(boot.pane).title, 'Choose default model')
    assert.equal(reads, 2, 'one Retry is exactly one additional read')
    assert.equal(boot.harness.createdSessions.length, 0)
  } finally {
    DirectModelCatalog.prototype.loadDirectory = original
    await boot.settle()
  }
})

test('official Direct Agent: native /model makes exactly one durable Session selection', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    modelPicker: true,
    deltas: ['model-live-ok'],
  })
  const original = DirectModelCatalog.prototype.selectSessionModel
  const records: Array<{ sessionId: string; outcome: string }> = []
  DirectModelCatalog.prototype.selectSessionModel = async function (...args) {
    const result = await original.apply(this, args)
    records.push({ sessionId: args[0], outcome: result.outcome.kind })
    return result
  }
  t.after(() => {
    DirectModelCatalog.prototype.selectSessionModel = original
  })
  try {
    await waitFor('booted', () => fixture.pane.output.text().includes('dock.composer'))
    fixture.pane.key('create live session\r')
    await waitFor('real Agent turn', () => fixture.pane.output.text().includes('model-live-ok'))
    fixture.pane.key('/model\r')
    await waitFor('live native directory', () => props(fixture.pane).state === 'ready')
    await resize(fixture.pane, SUMMARY_COLS)
    assert.equal(props(fixture.pane).title, 'Switch model')
    assert.equal(records.length, 0)
    // The live Session's one write entry says exactly what it does: it switches
    // the Session's model, it is not a default save.
    assert.equal(actionOf(fixture.pane, 'apply')?.label, 'Switch')
    // Select a model the live Session does NOT use, so the write is a real
    // change and the authoritative reread has something new to report.
    browse(fixture.pane, JSON.stringify(['scripted', DIRECT_TSP_MODEL_TWO]))
    await waitFor('second model highlighted', () =>
      props(fixture.pane).selected === JSON.stringify(['scripted', DIRECT_TSP_MODEL_TWO]))
    assert.equal(records.length, 0, 'highlighting a model never writes')
    // Shift+Tab wraps the ring straight onto the Primary Action.
    fixture.pane.key('\u001b[Z')
    fixture.pane.key('\r')
    await waitFor('original Direct model write settlement', () => records.length === 1)
    assert.equal(records[0]!.outcome, 'committed')
    const agent = fixture.ctx.agents.get(records[0]!.sessionId as never)
    assert.ok(agent)
    const events = agent.session.snapshotEvents().filter((e) => e.type === 'model/selection')
    assert.equal(events.length, 1, 'the real Session log contains one selection append')
    assert.deepEqual(
      events[0]!.data,
      { provider: 'scripted', model: DIRECT_TSP_MODEL_TWO },
      'the Session log records the CHANGED selection',
    )
    await waitFor('committed closes picker', () => picker(fixture.pane) === undefined)
    // The authoritative reread proves the new Current, not a repainted draft.
    fixture.pane.key('/model\r')
    await waitFor('reopened authoritative current', () => props(fixture.pane).state === 'ready')
    assert.deepEqual(
      props(fixture.pane).current,
      [JSON.stringify(['scripted', DIRECT_TSP_MODEL_TWO])],
      'the reopened panel reads the new Current from the Session',
    )
    // The catalogue stays the page, and the FULL facts stay readable through the
    // read-only details page its Overview opens.
    assert.equal(props(fixture.pane).title, 'Switch model')
    fixture.pane.key('\r')
    await waitFor('the model Overview', () => String(props(fixture.pane).title).startsWith('Model overview'))
    // Walk the page's real rows to its ONE operation row, then open the Reader.
    for (let step = 0; step < 16 && props(fixture.pane).selected !== OVERVIEW_DETAILS_ID; step += 1) {
      fixture.pane.key('\u001b[B')
      await settle(20)
    }
    fixture.pane.key('\r')
    await waitFor('details page', () => readerNode(fixture.pane) !== undefined)
    // The Reader carries the COMPLETE value, wrapped by the client; the Current
    // fact is read from the Session the picker re-opened on.
    assert.equal(
      readerValue(fixture.pane, 'reader-fact-current'),
      `scripted/${DIRECT_TSP_MODEL_TWO}`,
      'the Reader reads the new Current from the Session',
    )
    fixture.pane.key('\u001b')
    fixture.pane.key('\u001b')
    assert.equal(fixture.modelCalls(), 1, 'picking a model does not dispatch a prompt')
  } finally {
    DirectModelCatalog.prototype.selectSessionModel = original
    await fixture.settle()
  }
})

/* ---------------------------------------------------------------- K2/zone map */

test('native Model: Esc returns to the zone and page it came from', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // models -> Primary (Shift+Tab) -> Esc must not invent the effort zone.
  pane.key('\u001b[Z')
  await waitUntil('primary from the model list', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\u001b')
  await waitUntil('back in the list zone', () => props(pane).focus === 'list')
  assert.equal(props(pane).focus, 'list')
  assert.equal(m.writes.length, 0)
  // The Overview: its bar's Esc returns to the Overview's own list, and the
  // page's Esc then returns to the catalogue.
  await enterOverview(pane)
  pane.key('\t')
  await waitUntil('Overview primary', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\u001b')
  await settle(30)
  await waitUntil('still on the Overview', () => onOverview(pane))
  pane.key('\u001b')
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
  // The read-only details page returns to the page it was entered from.
  await enterOverview(pane)
  await walkList(pane, OVERVIEW_DETAILS_ID)
  pane.key('\r')
  await waitUntil('details page', () => inDetails(pane))
  pane.key('\u001b')
  await waitUntil('Esc returns to the Overview', () => onOverview(pane))
  pane.key('\u001b')
  await waitUntil('and on to the catalogue', () => onCatalogue(pane))
})

test('native Model: every visible action is keyboard reachable and never a no-op', async (t) => {
  const clean: ModelPickerDirectory = {
    current: undefined,
    directory: {
      default: { provider: 'a', model: 'same' },
      routableProviders: ['a'],
      groups: [{ id: 'a', name: 'A', models: [{ id: 'same', name: 'Twin' }] }],
      failures: [],
    },
  }
  const m = await mounted(t)
  await m.ready(clean)
  const { pane } = m
  // The catalogue: the ONE write plus its way out, and nothing else.
  assert.deepEqual(actionIds(pane), ['close', 'apply'])
  assert.deepEqual(actionLabels(pane), ['Cancel', 'Save default'])
  pane.key('\u001b[Z')
  await waitUntil('the catalogue bar owns the keyboard', () => focusCue(pane, 'apply'))
  pane.key('\u001b[D')
  await waitUntil('Cancel takes the bar focus', () => focusCue(pane, 'close'))
  pane.key('\r')
  await waitUntil('Enter ran the focused Cancel', () => picker(pane) === undefined)
  // The Overview: Back and the one write, both keyboard reachable, and Enter on
  // the focused Back really returns.
  const second = await mounted(t)
  await second.ready(clean)
  const sp = second.pane
  await enterOverview(sp)
  assert.deepEqual(actionIds(sp), ['back', 'apply'], 'the Overview footer is Back + the one write')
  sp.key('\t')
  await waitUntil('the Overview primary is focused', () => focusCue(sp, 'apply'))
  sp.key('\u001b[D')
  await waitUntil('Back takes the bar focus', () => focusCue(sp, 'back'))
  sp.key('\r')
  await waitUntil('Enter ran the focused Back', () => onCatalogue(sp))
  assert.equal(second.writes.length, 0, 'no bar action ever wrote here')
  // The read-only Reader: its ONE visible Back row is the page's only operation,
  // and Tab is a consumed no-op because the page paints no second region.
  await openDetails(sp)
  assert.equal(picker(sp), undefined, 'the Reader carries no action bar to reach')
  const readerBefore = readerNode(sp)?.id
  sp.key('\t')
  await settle(20)
  assert.equal(readerNode(sp)?.id, readerBefore, 'Tab cannot move the keyboard anywhere on the Reader')
  await backFromDetails(sp)
  await waitUntil('the Back row returned to the Overview', () => onOverview(sp))
  second.handle.close()
})

test('native Model: a phase whose bar no key can run carries no Enter cue', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  await m.ready()
  const focused = (id: string) => String(actionOf(pane, id)?.label).startsWith('▸')
  // PENDING: the admitted write refuses every key but Esc, so the enabled fallback
  // must NOT mark `Close` — the cue is a promise about Enter, and Enter here runs
  // nothing at all. The catalogue's own `Enter:` hint must go with it.
  pane.key('\u001b[Z')
  await waitUntil('bar focused on the primary', () => focused('apply'))
  pane.key('\r')
  await waitUntil('pending', () => actionOf(pane, 'apply')?.label === 'Selecting…')
  // While the write is admitted, closing the panel cannot cancel the operation
  // that is already with the Host, so that phase labels the action `Close`
  // instead of a `Cancel` a user would read as "undo the write".
  assert.equal(actionOf(pane, 'close')?.label, 'Close', 'an admitted write marks no action: no key can run one')
  assert.ok(!focused('apply'), 'the disabled Selecting… entry never carries the cue')
  assert.equal(props(pane).subtitle, '', 'a phase that refuses Enter promises no Enter')
  pane.key('\u001b[D')
  pane.key('\r')
  await settle(30)
  assert.ok(picker(pane), 'Enter ran nothing: the panel is still open')
  assert.equal(m.writes.length, 1, 'a cued Enter must never become a second write')
  pane.key('\u001b')
  await waitUntil('Esc still closes an admitted write', () => picker(pane) === undefined)
  // LOADING: the re-read's bar can run nothing either, and no hint may promise a
  // key this phase refuses.
  const l = await mounted(t)
  await l.ready()
  l.handle.setLoadError('catalog is unreachable')
  await waitUntil('the read failed', () => props(l.pane).state === 'error')
  l.pane.key('\u001b[Z')
  await waitUntil('bar focused on the retry', () => String(actionOf(l.pane, 'retry')?.label).startsWith('▸'))
  assert.equal(actionOf(l.pane, 'retry')?.label, '▸ Retry')
  l.pane.key('\r')
  await waitUntil('the re-read runs', () => props(l.pane).state === 'loading')
  assert.equal(l.retries(), 1)
  assert.equal(actionOf(l.pane, 'close')?.label, 'Cancel', 'a running re-read marks no action either')
  assert.equal(props(l.pane).subtitle, '', 'a running re-read promises no key it refuses')
  l.pane.key('\r')
  await settle(30)
  assert.ok(picker(l.pane), 'Enter ran nothing while the read runs')
  assert.equal(l.retries(), 1, 'no refused key can re-read twice')
  l.pane.key('\u001b')
  await waitUntil('Esc still closes a running re-read', () => picker(l.pane) === undefined)
})

test('native Model: the catalogue carries ONE short hint and the other pages carry none', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  await m.ready()
  // The catalogue's own line states the ONE thing Enter does there (enter the
  // highlighted model's Overview) — and it is the panel's ONLY hint.
  assert.equal(props(pane).subtitle, 'Enter: effort & details', 'the ONE hint lives in the subtitle slot')
  assert.ok(!sheetText(pane).includes('Enter: effort & details'), 'and it is not duplicated into the body')
  // The bar is not described by a hint at all: its own `▸` cue names the action
  // Enter would run.
  pane.key('\u001b[Z')
  await waitUntil('bar focused on the primary', () => focusCue(pane, 'apply'))
  assert.equal(props(pane).subtitle, 'Enter: effort & details', 'no second hint is added in the bar')
  pane.key('\u001b')
  await waitUntil('back in the list zone', () => props(pane).focus === 'list')
  // The Overview names the model and its real state instead of repeating the hint.
  await enterOverview(pane)
  assert.equal(props(pane).subtitle, 'A · Default')
  assert.notEqual(props(pane).subtitle, 'Enter: effort & details', 'no hint leaks onto the Overview')
  action(pane, 'back')
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
  // The Reader paints ONE region, so `Tab` is consumed as a no-op instead of
  // promising a second zone; the visible `Back` row is the page's own way out.
  const detailsPane = await mounted(t)
  await detailsPane.ready()
  await openDetails(detailsPane.pane)
  assert.equal(picker(detailsPane.pane), undefined, 'the Reader is not a picker page')
  assert.equal(String(props(detailsPane.pane).subtitle ?? ''), '', 'the Reader carries no hint')
  const readerBefore = readerNode(detailsPane.pane)?.id
  detailsPane.pane.key('\t')
  await settle(20)
  assert.equal(readerNode(detailsPane.pane)?.id, readerBefore, 'Tab cannot leave the Reader')
  await backFromDetails(detailsPane.pane)
  detailsPane.handle.close()
})

test('native Model: the bar never parks its focus on a disabled action', async (t) => {
  // A search with NO match disables the Primary Action: the bar must fall back to an
  // action that can really act (`Cancel` in a clean catalogue), never to the disabled
  // Primary, which owns no Enter and shows no cue.
  const clean: ModelPickerDirectory = {
    current: undefined,
    directory: {
      default: { provider: 'a', model: 'same' },
      routableProviders: ['a'],
      groups: [{ id: 'a', name: 'A', models: [{ id: 'same', name: 'Twin' }] }],
      failures: [],
    },
  }
  const m = await mounted(t)
  await resize(m.pane, 1280)
  await m.ready(clean)
  for (const char of 'zzzz') {
    m.pane.key(char)
    await settle(10)
  }
  await waitUntil('no match', () => (props(m.pane).items as unknown[]).length === 0)
  assert.equal(actionOf(m.pane, 'apply')?.disabled, true, 'the Primary Action is disabled')
  // With no model there is no details card to Tab onto either: the ring is list
  // and bar only.
  m.pane.key('\u001b[Z')
  await waitUntil('bar focused on an action that can act',
    () => String(actionOf(m.pane, 'close')?.label).startsWith('▸'))
  assert.ok(
    !String(actionOf(m.pane, 'apply')?.label).startsWith('▸'),
    'a disabled action never carries the focus cue',
  )
  m.pane.key('\r')
  await waitUntil('Enter ran that available Cancel', () => picker(m.pane) === undefined)
  // An EMPTY directory is the same boundary: nothing selectable, so the bar's focus is
  // an action that can act.
  const empty = await mounted(t)
  await resize(empty.pane, 1280)
  await empty.ready({
    current: undefined,
    directory: {
      default: { provider: 'a', model: 'same' },
      routableProviders: ['a'],
      groups: [],
      failures: [],
    },
  })
  assert.equal(actionOf(empty.pane, 'apply')?.disabled, true, 'no directory means no write')
  empty.pane.key('\u001b[Z')
  await waitUntil('empty directory: the bar focused a live action',
    () => String(actionOf(empty.pane, 'close')?.label).startsWith('▸'))
  assert.ok(
    !String(actionOf(empty.pane, 'apply')?.label).startsWith('▸'),
    'the empty-directory bar never cues the disabled Primary',
  )
  empty.pane.key('\r')
  await waitUntil('empty directory: Enter closes', () => picker(empty.pane) === undefined)
})

test('native Model: a failed read keeps the keyboard in the one bar it can operate', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  const focused = (id: string) => String(actionOf(pane, id)?.label).startsWith('▸')
  await m.ready()
  // Take the panel into the failed-read state: its bar carries the read-only Retry.
  m.handle.setLoadError('catalog is unreachable')
  await waitUntil('the read failed', () => props(pane).state === 'error')
  // Enter that bar and run its Retry; the re-read then FAILS while the keyboard is
  // still in the bar. The stale rows stay on screen for context, but the phase
  // browses neither the list nor the search box and refuses Enter: the list is inert.
  pane.key('\u001b[Z')
  await waitUntil('bar focused', () => focused('retry'))
  pane.key('\r')
  await waitUntil('the re-read runs', () => props(pane).state === 'loading')
  m.handle.setLoadError('catalog is unreachable')
  await waitUntil('the re-read failed', () => props(pane).state === 'error')
  assert.equal(m.retries(), 1)
  // Tab AND Shift+Tab keep the cue on the operable bar instead of walking the
  // keyboard into the inert list, where no key acts and the cue disappears. Each
  // step waits for ITS OWN committed frame: a predicate can still read the
  // pre-Tab frame and pass on the wrong state.
  for (const [name, key] of [['Tab', '\t'], ['Shift+Tab', '\u001b[Z']] as const) {
    const before = picker(pane)?.id
    pane.key(key)
    await waitUntil(`${name} commits its own frame`, () => picker(pane)?.id !== before)
    assert.ok(focused('retry') || focused('close'),
      `${name} must not drop the cue into the inert list`)
  }
  // ←→ still move across Retry/Cancel in that zone (each step its own frame).
  const barFrame = picker(pane)?.id
  pane.key('\u001b[D')
  await waitUntil('Cancel focused', () => picker(pane)?.id !== barFrame && focused('close'))
  const closeFrame = picker(pane)?.id
  pane.key('\u001b[C')
  await waitUntil('Retry focused again', () => picker(pane)?.id !== closeFrame && focused('retry'))
  // Esc is never swallowed: the failed read has no operable zone to return to, so
  // it closes instead of parking the keyboard in the inert list.
  pane.key('\u001b')
  await waitUntil('Esc closes a failed read', () => picker(pane) === undefined)
  // The symmetric page path: a details page under a failed read. The Reader is the
  // one page whose own view keys are EXEMPT from the phase gates, so here `Esc` is
  // its visible `Back` row: it returns to the Overview the Reader was entered from
  // (never closing the panel out from under the page's own context), and the
  // failure stays reported there.
  const details = await mounted(t)
  await details.ready()
  await openDetails(details.pane)
  const readerFrames = details.pane.frameCount()
  details.handle.setLoadError('catalog is unreachable')
  // A failed (re-)read under the Reader has no picker bar to operate: the page
  // keeps its content and reports the failure as its own leading notice.
  await waitUntil('the failure is reported on the Reader', () =>
    nodes(details.pane).some((node) => node.k === 'text' && node.p.text === 'catalog is unreachable'))
  assert.equal(picker(details.pane), undefined, 'a failed read under the Reader offers no bar at all')
  // The Reader is not a picker: a stale or forged page operation addressed to it
  // must not start a read, navigate or write from a page that offers none.
  assert.equal(details.retries(), 0, 'the failed phase was reported, not re-read')
  forge(details.pane, 'retry')
  forge(details.pane, 'back')
  forge(details.pane, 'apply')
  await settle(30)
  assert.equal(details.retries(), 0, 'a forged Retry on the Reader never re-reads')
  assert.equal(details.writes.length, 0, 'a forged apply on the Reader never writes')
  assert.equal(inDetails(details.pane), true, 'a forged Back cannot navigate the Reader either')
  assert.ok(details.pane.frameCount() > readerFrames, 'the Reader really repainted for it')
  // `Tab` still has nowhere to go, and the Reader's own Back/Esc return to the
  // page it came from: the failure is a fact ON that page, so the visible row must
  // never be a dead control and `Esc` must not close the panel out from under it.
  details.pane.key('\t')
  await settle(20)
  details.pane.key('\u001b')
  await waitUntil('Esc returns to the Overview the Reader came from',
    () => onOverview(details.pane) && props(details.pane).state === 'error')
  // In that phase the Overview's bar is the only operable region, so its own way
  // out is the Esc the bar always admits — closing the panel, never a lost page.
  details.pane.key('\u001b')
  await waitUntil('Esc closes the failed panel from its bar', () => picker(details.pane) === undefined)
  details.handle.close()
})

test('native Model: Loading keeps the search editable, closes on Esc and looks disabled', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  await m.ready()
  // A retry re-enters loading with the previous rows still present.
  m.handle.setLoading()
  await waitUntil('loading state', () => props(pane).state === 'loading')
  assert.equal(actionOf(pane, 'apply')?.disabled, true, 'a loading write entry looks unavailable')
  pane.key('a')
  pane.key('b')
  await waitUntil('the query stays editable while loading', () => props(pane).query === 'ab')
  pane.key('\u001b')
  await waitUntil('Esc always closes a loading panel', () => picker(pane) === undefined)
})

test('native Model: the title states the ONE intent and carries no other global surface', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // ONE short title per page: the catalogue names what its ONE write really does,
  // so there is no separate subject slot to keep in sync and nothing to truncate.
  assert.equal(props(pane).title, 'Choose default model')
  assert.equal((props(pane).strip as { label?: string } | undefined)?.label, undefined, 'no strip line')
  assert.deepEqual((props(pane).strip as { items?: unknown[] } | undefined)?.items ?? [], [])
  await resize(pane, 100)
  await waitUntil('the narrow catalogue', () => props(pane).size === 'md')
  assert.equal(props(pane).title, 'Choose default model', 'the SAME title at both widths')
  assert.ok(!props(pane).strip, 'no page carries a global action strip')
  const live = await mounted(t, { sessionless: false })
  await live.ready()
  assert.equal(props(live.pane).title, 'Switch model', 'a live subject names the real operation')
  live.handle.close()
})

test('native Model: no page renders the removed global action surface', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  const text = (): string => sheetText(pane)
  assert.ok(!text().includes('More actions'), 'no More actions menu exists')
  assert.ok(!text().includes('Action:'), 'no global Action: strip exists')
  assert.equal(actionOf(pane, 'details'), undefined, 'no global details action exists')
  assert.equal(actionOf(pane, 'effort-page'), undefined, 'no global effort-page action exists')
  assert.equal(props(pane).focus === 'strip', false, 'no strip zone exists')
  // The catalogue, the Overview and the details page are the ONLY pages, and
  // none of them is a global operations menu.
  const titles = new Set<string>([String(props(pane).title)])
  await resize(pane, 100)
  await waitUntil('the narrow catalogue', () => props(pane).size === 'md')
  titles.add(String(props(pane).title))
  await enterOverview(pane)
  titles.add(String(props(pane).title))
  await walkList(pane, OVERVIEW_DETAILS_ID)
  pane.key('\r')
  await waitUntil('details', () => inDetails(pane))
  titles.add(String(readerNode(pane)?.p.head))
  assert.deepEqual([...titles].sort(), ['Choose default model', 'Model overview', 'Twin'])
  // The removed wire shapes are refused even when forged.
  const readerFrame = readerNode(pane)!.id
  forge(pane, 'details')
  forge(pane, 'effort-page')
  forge(pane, 'strip', 'strip-more')
  browse(pane, 'more:details', readerFrame)
  await settle(30)
  assert.equal(readerNode(pane)!.id, readerFrame, 'the removed surface cannot even re-render a page')
  assert.equal(m.writes.length, 0)
})

/* ---------------------------------------- candidate reachability / readability */

test('native Model: every advertised effort is reachable on the Overview at every width', async (t) => {
  const seven = Array.from({ length: 7 }, (_, index) => `Effort ${index + 1}: ${'Long advertised effort label '.repeat(8)}`)
  const eleven = Array.from({ length: 11 }, (_, index) => `Effort ${index + 1}`)
  const wideGlyphs = Array.from({ length: 8 }, () => 'W'.repeat(34))
  const cases: ReadonlyArray<{ readonly name: string; readonly d: ModelPickerDirectory }> = [
    { name: 'one advertised effort', d: budgetDirectory({ effortNames: ['Only'] }) },
    { name: 'seven long effort labels', d: budgetDirectory({ effortNames: seven }) },
    {
      name: 'a very long provider name',
      d: budgetDirectory({
        providerName: 'Advertised provider name '.repeat(20),
        effortNames: ['Minimal', 'Low', 'Medium', 'High', 'Max', 'Ultra', 'Ultra2'],
      }),
    },
    { name: 'eleven short efforts', d: budgetDirectory({ effortNames: eleven }) },
    { name: 'eight widest-glyph labels', d: budgetDirectory({ effortNames: wideGlyphs }) },
  ]
  for (const scenario of cases) {
    for (const cols of [SUMMARY_COLS, 100]) {
      const m = await mounted(t)
      await resize(m.pane, cols)
      await m.ready(scenario.d)
      const where = `${scenario.name} at ${cols} columns`
      const reasoning = scenario.d.directory.groups[0]!.models[0]!.reasoning
      const advertised = reasoning === undefined
        ? 0
        : reasoning.defaultEffort === undefined ? reasoning.efforts.length + 1 : reasoning.efforts.length
      // The catalogue itself lists NO candidate: the selector is the model's own
      // Overview at every width, so no candidate can be painted outside the region
      // a user can reach.
      assert.equal(
        layerNodes(m.pane).some((node) => node.id.includes('.effort-')),
        false,
        `${where}: the catalogue renders no candidate row of its own`,
      )
      await enterOverview(m.pane)
      const candidates = rowIds(m.pane).filter((id) => id.startsWith('effort:'))
      assert.equal(candidates.length, advertised, `${where}: the Overview lists every advertised candidate`)
      assert.equal(rowIds(m.pane).at(-1), OVERVIEW_DETAILS_ID, `${where}: the details entry is the last row`)
      // The LAST candidate is reachable by key and commits through the ONE action.
      const last = reasoning?.efforts.at(-1)?.id
      assert.ok(last, `${where}: the fixture advertises at least one concrete effort`)
      await walkList(m.pane, effortItemId(last))
      m.pane.key('\r')
      await waitUntil(`${where}: the last candidate drafted`, () => candidateMark(m.pane, effortItemId(last)) === '●')
      m.pane.key('\t')
      await waitUntil(`${where}: the Primary Action`, () => String(actionOf(m.pane, 'apply')?.label).startsWith('▸'))
      m.pane.key('\r')
      await waitUntil(`${where}: the last candidate commits`, () => m.writes.length === 1)
      assert.equal(
        (m.writes[0] as { reasoningEffort?: string }).reasoningEffort,
        last,
        `${where}: the drafted candidate is what was written`,
      )
      m.handle.close()
      await waitUntil(`${where}: closed`, () => picker(m.pane) === undefined)
    }
  }
})

test('native Model: a description is never spent on a catalogue row, and the Reader keeps it raw', async (t) => {
  const m = await mounted(t)
  const blank = 'A\r\n\r\nB'
  const crlf = budgetDirectory({
    providerName: 'p',
    modelId: 'm',
    description: blank,
    effortNames: ['e1', 'e2', 'e3', 'e4', 'e5'],
  })
  await resize(m.pane, SUMMARY_COLS)
  await m.ready(crlf)
  // The catalogue's rows are ONE line each: no description text, no raw break and
  // no `…` clamping of ours anywhere on the page.
  assert.equal(
    layerNodes(m.pane).some((node) => JSON.stringify(node.p).includes(blank)),
    false, 'the description never becomes a catalogue row (it is a Reader fact)')
  assert.ok(!/[\n\r\v\f\u2028\u2029]/u.test(sheetText(m.pane)), 'no catalogue row carries a raw line break')
  // The complete description reaches the Reader RAW: the explicit blank lines are
  // the client's to render, never a budget of ours to fold.
  await openDetails(m.pane)
  assert.equal(readerValue(m.pane, 'reader-description'), blank, 'the breaks reach the Reader untouched')
  // A READ ERROR is reported as the Reader's own leading line, COMPLETE: a long
  // message is never clamped into a one-line row.
  const long = `catalog is unreachable ${'x'.repeat(400)}`
  m.handle.setLoadError(long)
  await settle(30)
  assert.equal(readerValue(m.pane, 'reader-description'), blank, 'the page keeps its content through the failure')
  assert.equal(
    nodes(m.pane).some((node) => node.k === 'text' && node.p.text === long),
    true,
    'the reader carries the complete notice as its own value',
  )
  m.handle.close()
})

test('native Model: every Details fact reaches the Reader COMPLETE and wraps by kind', async (t) => {
  const m = await mounted(t, { sessionless: false })
  const longProvider = 'Advertised provider name '.repeat(20)
  const modelId = 'anthropic/claude-3.7-sonnet:thinking'
  const description = 'Long description '.repeat(35)
  await resize(m.pane, SUMMARY_COLS)
  await m.ready(budgetDirectory({
    providerName: longProvider,
    modelId,
    description,
    effortNames: ['Minimal', 'Low', 'Medium', 'High', 'Max'],
    configuredEffort: 'high',
  }))
  await openDetails(m.pane)
  const facts = readerFacts(m.pane)
  // The Reader carries the directory's own value VERBATIM: nothing is
  // ellipsized, re-flowed or re-derived, and a value with no break opportunity is
  // wrapped by the CLIENT (`char`) instead of being pre-split by the presenter.
  // The model's NAME is the page's own title (the client ellipsizes a long one),
  // so the Identity group carries the complete name as its first fact.
  assert.equal(readerNode(m.pane)?.p.head, 'Budget Model', 'the page title is the model name')
  assert.equal(facts.get('reader-model'), 'Budget Model', 'the model name')
  assert.equal(facts.get('reader-provider'), `${longProvider} (p)`, 'provider and provider id')
  assert.equal(facts.get('reader-id'), modelId, 'the model id')
  assert.equal(facts.get('reader-fact-current'), `p/${modelId}/high`, 'the live Current value')
  assert.equal(facts.get('reader-fact-default'), `p/${modelId}/high`, 'the persisted Default value')
  assert.equal(facts.get('reader-description'), description, 'the description')
  // The fixture's declared default id (`high`) is not one of its advertised ids,
  // so the draft seeds from the first advertised choice.
  assert.equal(facts.get('reader-draft'), 'Minimal', 'the draft effort')
  // The groups are the page's structure: Identity / Configuration / Description,
  // separated by a real rule and a spacer (a bare `section` head measured a
  // SMALLER gap between groups than inside one on the real client).
  const headTexts = (pane: TspPane): string[] => layerNodes(pane)
    .filter((node) => node.k === 'text' && Array.isArray(node.p.spans))
    .flatMap((node) => (node.p.spans as Array<{ t?: string }>).map((entry) => String(entry.t ?? '')))
    .filter((text) => ['Identity', 'Configuration', 'Description'].includes(text))
  assert.deepEqual(
    headTexts(m.pane),
    ['Identity', 'Configuration', 'Description'],
    'the Reader groups its facts instead of stacking properties',
  )
  assert.deepEqual(
    layerNodes(m.pane).filter((node) => node.k === 'rule').length,
    layerNodes(m.pane).filter((node) => node.k === 'spacer').length,
    'every group boundary is one rule plus one spacer',
  )
  // The kind decides how a value with no break opportunity behaves: identifiers
  // may break anywhere, prose must not break inside a word.
  for (const key of ['reader-provider', 'reader-id', 'reader-fact-current', 'reader-fact-default', 'reader-draft']) {
    assert.equal(nodes(m.pane).find((node) => node.id.endsWith(`.${key}`))?.p.wrap, 'char', `${key} wraps by char`)
  }
  assert.equal(nodes(m.pane).find((node) => node.id.endsWith('.reader-description'))?.p.wrap, 'word', 'prose wraps by word')
  // The write outcome is the Reader's own leading notice, complete there too.
  await backFromDetails(m.pane)
  await waitUntil('back on the Overview', () => onOverview(m.pane))
  action(m.pane, 'back')
  await waitUntil('back on the catalogue', () => onCatalogue(m.pane))
  m.pane.key('\u001b[Z')
  await waitUntil('primary action focused', () => String(actionOf(m.pane, 'apply')?.label).startsWith('▸'))
  m.pane.key('\r')
  await waitUntil('pending', () => actionOf(m.pane, 'apply')?.label === 'Selecting…')
  m.settleWrite('rejected')
  await waitUntil('rejected and ready', () => props(m.pane).state === 'ready' && onCatalogue(m.pane))
  await openDetails(m.pane)
  assert.equal(
    nodes(m.pane).some((node) => node.k === 'text' && node.p.text === 'Rejected.'),
    true,
    'the full write notice is readable',
  )
  m.handle.close()
})

test('native Model: an unbroken value reaches the Reader whole, to be wrapped by the client', async (t) => {
  const m = await mounted(t, { sessionless: false })
  // The reviewer's counterexample: a picker row renders its `detail` on ONE
  // measured line and cannot break an unbroken run, so pre-split rows had to guess
  // a per-row column bound. The Reader carries the run ONCE, with the client's own
  // `char` wrapping, so no bound can clip it.
  const providerName = `${'W'.repeat(240)} tail`
  await resize(m.pane, 100)
  await waitUntil('the narrow catalogue', () => props(m.pane).size === 'md')
  await m.ready(budgetDirectory({
    providerName,
    modelId: 'm',
    effortNames: ['Minimal', 'Low'],
  }))
  await openDetails(m.pane)
  assert.equal(readerValue(m.pane, 'reader-provider'), `${providerName} (p)`, 'the unbroken run is complete')
  const nodesOfProvider = nodes(m.pane).filter((node) => node.id.endsWith('.reader-provider'))
  assert.equal(nodesOfProvider.length, 1, 'and it is ONE node, never a stack of continuation rows')
  assert.equal(nodesOfProvider[0]?.p.wrap, 'char', 'the client is told it may break the run')
  m.handle.close()
})

test('native Model: a description of explicit blank lines reaches the Reader raw', async (t) => {
  const m = await mounted(t)
  // The renderer preserves explicit newlines, so THREE visible characters plus
  // five LF and five CRLF breaks CAN occupy eleven native lines: no budget of ours
  // may fold, trim or re-split them, and the client's own line rendering is
  // measured in the real pane (LF + CRLF + a blank line = four lines at a 16px
  // line, on the shipped presenter).
  const blank = `x\n${'\n'.repeat(4)}x\r\n${'\r\n'.repeat(4)}y`
  const five = budgetDirectory({
    providerName: 'p',
    modelId: 'm',
    description: blank,
    effortNames: ['e1', 'e2', 'e3', 'e4', 'e5'],
  })
  await resize(m.pane, SUMMARY_COLS)
  await m.ready(five)
  // The complete description stays readable through the Reader, RAW: its explicit
  // blank lines are the client's to render, never a budget of ours.
  await openDetails(m.pane)
  assert.equal(
    readerValue(m.pane, 'reader-description'),
    blank,
    'the blank lines and the visible text all reach the Reader untouched',
  )
  m.handle.close()
})

/* -------------------------------------------------- content/readability paths */

test('native Model: a long description reaches the Reader as ONE complete value', async (t) => {
  const m = await mounted(t)
  const long = 'A deliberately long description that must be readable in full, 中文描述也需要完整可读，并且带上 emoji 🚀 结尾。'
  await m.ready({
    ...directory,
    directory: {
      ...directory.directory,
      groups: directory.directory.groups.map((group) => group.id !== 'a' ? group : {
        ...group,
        models: group.models.map((model) => ({ ...model, description: long })),
      }),
    },
  })
  await resize(m.pane, 100)
  await waitUntil('compact', () => props(m.pane).size === 'md')
  await openDetails(m.pane)
  // The COMPLETE value lives in ONE node the client wraps at the width the layout
  // really has; the presenter never pre-splits it into rows again.
  assert.equal(
    readerValue(m.pane, 'reader-description'),
    long,
    'the Reader carries every character of the description',
  )
  const valueNodes = nodes(m.pane).filter((node) => node.id.endsWith('.reader-description'))
  assert.equal(valueNodes.length, 1, 'the value is ONE node, never a stack of pre-split rows')
  assert.equal(valueNodes[0]?.p.wrap, 'word', 'prose is wrapped by the client, not clamped by us')
})

test('native Model: description wrapping never splits a grapheme or a column', async (t) => {
  const m = await mounted(t)
  const tricky = `${'a'.repeat(39)}🚀z`
  const cjk = '中文描述完整可读'.repeat(4)
  await m.ready({
    ...directory,
    directory: {
      ...directory.directory,
      groups: directory.directory.groups.map((group) => ({
        ...group,
        models: group.models.map((model) => ({
          ...model,
          description: group.id === 'a' ? tricky : cjk,
        })),
      })),
    },
  })
  await resize(m.pane, 100)
  await waitUntil('compact', () => props(m.pane).size === 'md')
  await openDetails(m.pane)
  // The unbroken run and its trailing grapheme reach the client EXACTLY as the
  // directory published them: wrapping (and never splitting a grapheme) is the
  // client's job at the layout width, so the presenter must not pre-chop them.
  assert.equal(readerValue(m.pane, 'reader-description'), tricky, 'the unbroken run arrives intact')
  assert.equal(
    nodes(m.pane).filter((node) => node.id.endsWith('.reader-description')).length,
    1,
    'one complete value node, never a stack of pre-split rows',
  )
  await backFromDetails(m.pane)
  await waitUntil('back on the Overview', () => onOverview(m.pane))
  action(m.pane, 'back')
  await waitUntil('back on the catalogue', () => onCatalogue(m.pane))
  sendActivate(m.pane, SAME_B)
  await waitUntil('the CJK model Overview', () =>
    onOverview(m.pane) && props(m.pane).subtitle === 'B')
  await walkList(m.pane, OVERVIEW_DETAILS_ID)
  m.pane.key('\r')
  await waitUntil('CJK details page', () => inDetails(m.pane))
  assert.equal(readerValue(m.pane, 'reader-description'), cjk, 'the CJK description is reproduced exactly')
})

test('native Model: Current and Default facts come from the directory, not the row', async (t) => {
  const live = await mounted(t, { sessionless: false })
  await live.ready({
    current: { provider: 'a', model: 'same', reasoningEffort: 'high' },
    directory: {
      ...directory.directory,
      default: { provider: 'b', model: 'same', reasoningEffort: 'low' },
    },
  })
  // The catalogue carries the short identity; the FULL facts live in the
  // read-only Reader its Overview opens.
  assert.equal(props(live.pane).title, 'Switch model')
  const liveFacts = async (): Promise<Map<string, string>> => {
    await openDetails(live.pane)
    const facts = readerFacts(live.pane)
    await backToCatalogue(live.pane)
    return facts
  }
  const facts = await liveFacts()
  assert.equal(facts.get('reader-fact-current'), 'a/same/high', `live Current fact: ${JSON.stringify([...facts])}`)
  assert.equal(facts.get('reader-fact-default'), 'b/same/low', 'the persisted default keeps its own effort')
  live.handle.close()
  const sessionless = await mounted(t)
  await sessionless.ready()
  await openDetails(sessionless.pane)
  const plainFacts = readerFacts(sessionless.pane)
  assert.equal(plainFacts.has('reader-fact-current'), false, 'a sessionless panel never paints a Current fact')
  assert.equal(plainFacts.get('reader-fact-default'), 'a/same/high')
})

test('native Model: a model without efforts has no selector and says so on the Overview', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // The no-effort model draws NO candidate of its own: the catalogue lists the
  // model, and one Tab reaches the bar (there is no hidden effort region).
  browse(pane, SAME_B)
  await waitUntil('provider B highlighted', () => props(pane).selected === SAME_B)
  pane.key('\t')
  await waitUntil('the bar, not an invisible effort zone', () => focusCue(pane, 'apply'))
  pane.key('\t')
  await waitUntil('the ring comes back to the list', () => props(pane).focus === 'list')
  // A re-read that drops the highlighted model's reasoning metadata leaves the
  // panel on the visible list.
  await m.ready({
    ...directory,
    directory: {
      ...directory.directory,
      groups: directory.directory.groups.map((group) => ({
        ...group,
        models: group.models.map(({ reasoning: _reasoning, ...model }) => model),
      })),
    },
  })
  assert.equal(props(pane).focus, 'list', 'the keyboard sits on the visible list')
  browse(pane, SAME_A)
  await waitUntil('the effort-bearing model is highlighted again', () => props(pane).selected === SAME_A)
  assert.equal(m.writes.length, 0)
  // The Overview states the absence instead of silently omitting it.
  await enterOverview(pane)
  assert.equal(rowIds(pane).includes(OVERVIEW_EFFORT_ID), true, 'the absence is stated')
  const inert = ((props(pane).items ?? []) as Array<Record<string, unknown>>)
    .find((item) => String(item.id) === OVERVIEW_EFFORT_ID)
  assert.equal(inert?.label, 'Reasoning effort')
  assert.equal(inert?.detail, 'Not available', 'the page INVENTS no candidate')
  assert.deepEqual(rowIds(pane), [OVERVIEW_MODEL_ID, OVERVIEW_EFFORT_ID, OVERVIEW_DETAILS_ID],
    'the identity row, the absence statement and the details entry — no fake radio row')
  await walkList(pane, OVERVIEW_EFFORT_ID)
  pane.key('\r')
  await settle(30)
  assert.equal(onOverview(pane), true, 'the inert effort row never leaves the page')
  assert.equal(m.writes.length, 0, 'and it never writes')
})

test('native Model: a provider called `all` and a scope-shaped effort id stay unambiguous', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  // A catalogue may advertise a provider whose ID is literally `all`, a provider
  // whose ID carries a colon AND non-ASCII text, and one model id repeated under
  // every provider; an effort id may itself look like a scope id or be non-ASCII.
  const tricky: ModelPickerDirectory = {
    current: { provider: 'all', model: 'm' },
    directory: {
      default: { provider: 'all', model: 'm' },
      routableProviders: ['all', 'z', 'vendor:供应商'],
      groups: [
        {
          id: 'all',
          name: 'Provider all',
          models: [
            {
              id: 'm',
              name: 'M',
              reasoning: {
                efforts: [
                  { id: 'scope-all', name: 'Scope-shaped' },
                  { id: 'scope:other', name: 'Prefixed' },
                  { id: 'scope:复杂🚀', name: 'Unicode effort' },
                ],
              },
            },
          ],
        },
        { id: 'z', name: 'Z', models: [{ id: 'm', name: 'M' }] },
        { id: 'vendor:供应商', name: 'Vendor 供应商', models: [{ id: 'm', name: 'Vendor M' }] },
      ],
      failures: [],
    },
  }
  await m.ready(tricky)
  // One row per (provider, model): the SAME model id under three providers is
  // three independently addressable rows, and the pinned group lists only the real
  // configured one.
  const ids = rowIds(pane)
  assert.equal(ids.length, 3, `every provider has its own row: ${JSON.stringify(ids)}`)
  assert.equal(new Set(ids).size, 3, 'and no two providers share a row id')
  assert.deepEqual(props(pane).order, [
    { group: '\u0000current-default', label: 'Current / Default', count: 1 },
    JSON.stringify(['all', 'm']),
    { group: 'z', label: 'Z', count: 1 },
    JSON.stringify(['z', 'm']),
    { group: 'vendor:供应商', label: 'Vendor 供应商', count: 1 },
    JSON.stringify(['vendor:供应商', 'm']),
  ])
  const marks = ((props(pane).items ?? []) as Array<Record<string, unknown>>)
    .map((item) => (item.mark as { text?: string } | undefined)?.text)
  assert.deepEqual(marks, ['PA', 'Z', 'V供'], 'each row carries its OWN provider mark')
  // There is no scope channel at all anymore: neither a forged scope action nor a
  // scope-shaped row id can filter or navigate anything.
  assert.equal(props(pane).scopes, undefined, 'the catalogue advertises no scope column')
  const frame = picker(pane)!.id
  for (const value of ['scope-all', 'scope:all', 'scope:vendor:供应商', undefined]) action(pane, 'scope', value)
  browse(pane, 'scope:all')
  browse(pane, 'scope-all')
  await settle(30)
  assert.equal(props(pane).scope, undefined, 'no scope shape can filter')
  assert.equal(picker(pane)!.id, frame, 'and none of them re-renders the page')
  assert.equal(m.writes.length, 0)
  // The model whose efforts ARE scope-shaped: its OWN rows carry their own
  // namespace, so each candidate really takes the draft.
  browse(pane, JSON.stringify(['all', 'm']))
  await waitUntil('the effort-bearing model is highlighted', () => props(pane).selected === JSON.stringify(['all', 'm']))
  await enterOverview(pane)
  assert.equal(props(pane).subtitle, 'Provider all · Default')
  for (const value of ['scope-all', 'scope:other', 'scope:复杂🚀']) {
    browse(pane, effortItemId(value))
    await waitUntil(`the candidate ${value} takes the draft`, () => candidateMark(pane, effortItemId(value)) === '●')
  }
  assert.equal(m.writes.length, 0, 'a candidate row is never a write')
  // A scope-shaped row id that is NOT a candidate of this page resolves nowhere.
  const overviewFrame = picker(pane)!.id
  browse(pane, 'scope:all')
  browse(pane, 'scope-all')
  await settle(30)
  assert.equal(picker(pane)!.id, overviewFrame, 'a scope-shaped Overview row never acts')
  assert.equal(m.writes.length, 0)
  // ...and the ONE write carries the non-ASCII effort id VERBATIM.
  pane.key('\t')
  await waitUntil('the one write entry is focused',
    () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\r')
  await waitUntil('the Unicode draft commits once', () => m.writes.length === 1)
  assert.deepEqual(
    m.writes,
    [{ provider: 'all', model: 'm', reasoningEffort: 'scope:复杂🚀' }],
    'the non-ASCII effort id reaches the Primary payload verbatim',
  )
  m.settleWrite('rejected')
  await settle(30)
  m.handle.close()
})

test('native Model: the Overview runs only the rows it really offers', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  await enterOverview(pane)
  const frame = picker(pane)!.id
  // A row this page does NOT offer must not resolve to its action: `apply` is not
  // a row, `overview-details` is the only operation row, and an unadvertised
  // effort must never draft.
  browse(pane, 'overview-nope')
  browse(pane, 'effort:nope')
  browse(pane, 'apply')
  await settle(30)
  assert.equal(picker(pane)!.id, frame, 'an unoffered Overview row never acts')
  assert.equal(m.writes.length, 0, 'and it can never write')
  assert.equal(onOverview(pane), true, 'and the page stays where it was')
  // The rows it DOES offer really run.
  browse(pane, OVERVIEW_DETAILS_ID)
  await waitUntil('the offered details row runs', () => inDetails(pane))
  await backFromDetails(pane)
  await waitUntil('back on the Overview', () => onOverview(pane))
  // Boundary: a search that matches NOTHING has no highlighted model, so no
  // content page can be opened and no write can be offered.
  action(pane, 'back')
  await waitUntil('back on the model list', () => onCatalogue(pane))
  for (const char of 'zzzz') {
    pane.key(char)
    await settle(10)
  }
  await waitUntil('no model matches', () =>
    rowIds(pane).every((id) => id.startsWith('failure:') || id === FAILURE_RETRY_ID))
  assert.equal(props(pane).selected, undefined, 'nothing is highlighted with no match')
  pane.key('\r')
  await settle(30)
  assert.equal(onCatalogue(pane), true, 'Enter cannot open a page with no model')
  await resize(pane, 130)
  await waitUntil('wide again', () => props(pane).size === 'lg')
  assert.equal(actionOf(pane, 'apply')?.disabled, true, 'no match means no write')
  assert.deepEqual(
    rowIds(pane).filter((id) => !id.startsWith('failure:') && id !== FAILURE_RETRY_ID),
    [],
    'a wide no-match list carries no model row',
  )
  m.handle.close()
})

test('official Host same-name /model keeps the original Host route even with native UI enabled', async (t) => {
  const life = testLifecycle(t),
    calls: string[] = []
  const fixture = await createDirectTspFixture(life, {
    modelPicker: true,
    hostCommands: [
      {
        name: 'model',
        description: 'Host owns model',
        handler: (i) => {
          calls.push(i.rawInput)
          return undefined
        },
      },
    ],
  })
  try {
    await waitFor('booted', () => fixture.pane.output.text().includes('dock.composer'))
    fixture.pane.key('/model\r')
    await waitFor('original Host sink', () => calls.length === 1)
    assert.deepEqual(calls, [''], 'the Host receives the original parsed argument string')
    assert.equal(picker(fixture.pane), undefined)
  } finally {
    await fixture.settle()
  }
})

/* ------------------------------------------- measured layout / Reader contract */

test('native Model: the ONE layout threshold only adds the read-only summary', async (t) => {
  // The pure rule first: the presenter reconstructs the pane width from the only
  // geometry the SDK reports (`cols` * the cell width) and compares it against the
  // MEASURED summary threshold.
  assert.equal(wideCatalog(112, 8), false, '896px is below the threshold')
  assert.equal(wideCatalog(113, 8), true, '904px reaches it')
  assert.equal(wideCatalog(90, 10), true, 'the cell width is what makes the width, not the column count')
  assert.equal(wideCatalog(89, 10), false, 'one cell short of it is still a narrow pane')
  assert.equal(wideCatalog(160, 4), false, 'a narrow cell at many columns is still a narrow pane')
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Just below the threshold: the same catalogue, no preview region at all.
  await resize(pane, 112)
  await waitUntil('below the threshold', () => props(pane).size === 'md')
  assert.equal(props(pane).preview, 'none', 'the narrow pane asks for no preview region')
  assert.deepEqual(actionIds(pane), ['close', 'apply'], 'and it still owns the ONE write')
  assert.deepEqual(rowIds(pane).filter((id) => !id.startsWith('failure:') && id !== FAILURE_RETRY_ID), [SAME_A, SAME_B])
  assert.equal(layerNodes(pane).some((node) => node.k === 'kv'), false, 'and paints no summary')
  // At the threshold: the wide sheet and its read-only summary — the SAME rows and
  // the SAME one write.
  await resize(pane, 113)
  await waitUntil('at the threshold', () => props(pane).size === 'lg' && props(pane).preview === 'below')
  assert.deepEqual(actionIds(pane), ['close', 'apply'], 'the wide catalogue owns the same one write')
  assert.deepEqual(rowIds(pane).filter((id) => !id.startsWith('failure:') && id !== FAILURE_RETRY_ID), [SAME_A, SAME_B])
  assert.ok(layerNodes(pane).find((node) => node.k === 'kv'), 'and paints its read-only summary')
  assert.equal(m.writes.length, 0)
  m.handle.close()
})

test('native Model: the Reader owns the native scroll op and only the Reader does', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await openDetails(pane)
  const body = readerBodyNode(pane)
  assert.ok(body, 'the Reader mounts its scrollable body')
  const before = scrollOps(pane).length
  // REAL key bytes, decoded by the shipped SDK: PageDown/PageUp/Home/End/arrows.
  const steps: ReadonlyArray<readonly [string, string]> = [
    ['\u001b[6~', 'page-down'],
    ['\u001b[5~', 'page-up'],
    ['\u001b[H', 'start'],
    ['\u001b[F', 'end'],
    ['\u001b[B', 'line-down'],
    ['\u001b[A', 'line-up'],
  ]
  for (const [bytes, expected] of steps) {
    pane.key(bytes)
    await waitUntil(`the Reader asked to scroll ${expected}`,
      () => scrollOps(pane).at(-1)?.to === expected)
    assert.equal(scrollOps(pane).at(-1)?.id, body.id,
      `${expected} addresses the Reader body the SDK really assigned`)
  }
  assert.equal(scrollOps(pane).length, before + steps.length, 'each key is exactly one op')
  assert.equal(m.writes.length, 0, 'scrolling the Reader never writes')
  // The NEGATIVE control: away from the Reader the same keys must not move any
  // scroll container (there is no reader body in the frame to address).
  await backToCatalogue(pane)
  const quiet = scrollOps(pane).length
  for (const bytes of ['\u001b[6~', '\u001b[F', '\u001b[B']) pane.key(bytes)
  await settle(30)
  assert.equal(scrollOps(pane).length, quiet, 'no Reader, no scroll op')
  m.handle.close()
})

test('native Model: the Reader survives a resize and Back returns to its real origin', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Entered from the Overview (the compact path), then resized INTO the wide
  // shell while the Reader is open: the page must survive and return to the
  // Overview it was entered from, not to the list the layout would now offer.
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  await enterOverview(pane)
  await walkList(pane, OVERVIEW_DETAILS_ID)
  pane.key('\r')
  await waitUntil('the Reader from the Overview', () => inDetails(pane))
  const facts = readerFacts(pane)
  const model = facts.get('reader-model')
  await resize(pane, SUMMARY_COLS)
  await waitUntil('the Reader survives the resize', () =>
    inDetails(pane) && props(pane).title === undefined)
  assert.deepEqual(readerFacts(pane), facts, 'the Reader shows the same facts at the new width')
  await backFromDetails(pane)
  await waitUntil('Back returns to the Overview it came from', () => onOverview(pane))
  // And the wide card path returns to the model list.
  action(pane, 'back')
  await waitUntil('back on the list', () => onCatalogue(pane))
  await openDetails(pane)
  assert.equal(readerValue(pane, 'reader-model'), model, 'the same model is still described')
  await backToCatalogue(pane)
  m.handle.close()
})

test('native Model: the Overview lists every advertised candidate and invents none', async (t) => {
  const none = await mounted(t)
  await none.ready({
    ...directory,
    directory: {
      ...directory.directory,
      groups: directory.directory.groups.map((group) => ({
        ...group,
        models: group.models.map(({ reasoning: _reasoning, ...model }) => model),
      })),
    },
  })
  await resize(none.pane, 100)
  await waitUntil('compact', () => props(none.pane).size === 'md')
  await enterOverview(none.pane)
  // NEGATIVE control: a model that advertises nothing gets the explicit
  // `Not available` statement and NOT a single phantom candidate.
  assert.equal(rowIds(none.pane).filter((id) => id.startsWith('effort:')).length, 0, 'no phantom effort')
  assert.equal(detailOf(none.pane, OVERVIEW_EFFORT_ID), 'Not available')
  none.handle.close()
  // POSITIVE control: seven advertised candidates are all listed, and choosing
  // the last one drafts it — no candidate is dropped or synthesised.
  const seven = await mounted(t)
  const names = Array.from({ length: 7 }, (_, index) => `Effort ${index + 1}`)
  await seven.ready(budgetDirectory({ modelId: 'm', effortNames: names }))
  await resize(seven.pane, 100)
  await waitUntil('compact', () => props(seven.pane).size === 'md')
  await enterOverview(seven.pane)
  const listed = rowIds(seven.pane).filter((id) => id.startsWith('effort:'))
  assert.equal(listed.length, 7, 'exactly the seven advertised efforts (this model declares a default)')
  await walkList(seven.pane, effortItemId('e7'))
  seven.pane.key('\r')
  await waitUntil('the last candidate drafts', () => {
    const items = (props(seven.pane).items ?? []) as Array<Record<string, unknown>>
    return (items.find((item) => String(item.id) === effortItemId('e7'))?.mark as { text?: string } | undefined)?.text === '●'
  })
  assert.equal(seven.writes.length, 0, 'drafting the last candidate never writes')
  seven.handle.close()
})

test('native Model: a retired Reader frame can never act on a later one', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await openDetails(pane)
  const staleBack = readerBackNode(pane).id
  const staleBody = readerBodyNode(pane)?.id
  await backToCatalogue(pane)
  await openDetails(pane)
  const freshBack = readerBackNode(pane).id
  const freshBody = readerBodyNode(pane)?.id
  // The layer region's root id is the fixed region name and the root's own key
  // never reaches its children, so a CONSTANT child key would make the Reader's
  // ids stable across revisions and panels. They must be frame-scoped instead.
  assert.notEqual(freshBack, staleBack, "the Reader never reuses a retired frame's Back id")
  assert.notEqual(freshBody, staleBody, 'and never reuses its scroll container id either')
  // A retired receiver is refused ON THE WIRE: its id is simply absent from the
  // current frame, so neither the SDK's own dispatch nor the presenter routes it.
  clickNodeById(pane, staleBack)
  await settle(30)
  assert.equal(inDetails(pane), true, 'the retired Back click cannot navigate the new Reader')
  assert.equal(picker(pane), undefined, 'and it cannot page the surface away either')
  // The CURRENT frame's Back row still works, so the negative above is not a
  // vacuous "nothing works".
  await backToCatalogue(pane)
  m.handle.close()
})

test('native Model: the Reader keeps its own view keys through a running or failed read', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await openDetails(pane)
  // A FAILED re-read: the page keeps its content, reports the failure as its own
  // leading notice, and its visible Back row must still return to its origin.
  m.handle.setLoadError('catalog is unreachable')
  await waitUntil('the failure is on the Reader', () =>
    nodes(pane).some((node) => node.k === 'text' && node.p.text === 'catalog is unreachable'))
  const failedQuiet = scrollOps(pane).length
  pane.key('\u001b[F')
  await waitUntil('the Reader still scrolls under a failed read',
    () => scrollOps(pane).length === failedQuiet + 1)
  await backFromDetails(pane)
  await waitUntil('back on the Overview the Reader came from', () => onOverview(pane))
  assert.equal(props(pane).state, 'error', 'the failure is still reported on that page')
  // A RUNNING re-read: the same rule, and `Esc` is the visible row's own intent —
  // the panel must survive it (closing would drop the page context).
  await m.ready()
  await openDetails(pane)
  // The phase itself is renderer-local and the Reader paints no picker, so the
  // loading state is proved by WHERE the keys land afterwards: the model list
  // reports it, and a closed panel would report nothing at all.
  m.handle.setLoading()
  await settle(30)
  const runningQuiet = scrollOps(pane).length
  pane.key('\u001b[F')
  await waitUntil('the Reader still scrolls while the read runs',
    () => scrollOps(pane).length === runningQuiet + 1)
  pane.key('\u001b')
  await waitUntil('Esc returned to the page it came from instead of closing the panel', () =>
    onOverview(pane) && props(pane).state === 'loading')
  // The other phase admission is unchanged: a running read still refuses every
  // browse and every write.
  assert.equal(props(pane).query, '', 'and it did not turn the key into a search edit')
  m.handle.close()
})
