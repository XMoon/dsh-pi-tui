/** Production native /model renderer, original command and write paths.
 *
 * Scripted tty/Host fixtures are named explicitly; only the final Direct cases
 * mount official live Agents. No decision or committed selection is injected.
 * The assertions read the REAL reconciled wire tree: the picker's own props
 * (title/preview/scopes/focus/actions), its rendered cards/rows and the SDK
 * action dispatch, so a renderer-local field can never satisfy them.
 *
 * The UX contract exercised here is the TWO-page one: the catalogue (which carries
 * the ONE Reasoning Effort strip and the ONE write) and the read-only Full details
 * page every row activation opens directly.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer } from '../../src/tui/tsp/session.ts'
import {
  FAILURE_RETRY_ID,
  stripItemId,
  stripItemParts,
  stripLabelColumns,
} from '../../src/tui/tsp/model-picker-state.ts'
import { displayWidth } from '../../src/tui/tsp/picker-text.ts'
import { runOwned } from '../../src/runtime/process/tasks.ts'
import type {
  ModelApplyOutcome,
  ModelPickerDirectory,
} from '../../src/app/command/model-presentation.ts'
import { DirectModelCatalog } from '../../src/runtime/direct/catalog-direct.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { ownTspBoot, waitUntil, settle } from '../support/tsp-runner-harness.ts'
import {
  DIRECT_TSP_MODEL_TWO,
  createDirectTspFixture,
  waitFor,
} from '../support/direct-tsp-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

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
  // A resize is NOT evidence of a wire frame: the sheet is the client's `md` dialog at
  // every width and the pane width only prices the strip's chip labels, so a resize of a
  // short catalogue legitimately changes nothing on the wire. The evidence the presenter
  // really processed it is the input loop's own tick.
  sendResize(pane, cols)
  await settle(20)
}

// The wire observation helpers: the REAL reconciled node tree of the frames.
import {
  clickNode as click,
  clickNodeById,
  layerNodes,
  pickerAction as rawActionOf,
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
} from '../support/tsp-picker-wire.ts'

/** The picker's own main-list row ids, in wire order. */
function rowIds(pane: TspPane): string[] {
  return ((props(pane).items ?? []) as Array<Record<string, unknown>>).map((item) => String(item.id))
}

/** The action-bar ids of the mounted picker, in wire order. */
/** One action entry by the BASE it really does: the bar's ids carry a frame token. */
function actionOf(pane: TspPane, base: string): Record<string, unknown> | undefined {
  const entry = rawActionOf(pane, base)
  if (entry !== undefined) return entry
  const actions = (props(pane).actions ?? []) as Array<Record<string, unknown>>
  return actions.find((action) => String(action.id).split('#')[0] === base)
}

/** The model and value one strip id names, or `undefined` for a foreign id. */
function stripValueOf(id: string): string | undefined {
  return stripItemParts(id)?.value
}
/** The candidate VALUES the wire's strip currently offers (its ids name the model too). */
function stripValues(pane: TspPane): Array<string | undefined> {
  return stripItemIds(pane).map(stripValueOf)
}
/** The strip ids the wire really carries, in order. */
function stripItemIds(pane: TspPane): string[] {
  return ((props(pane).strip as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])
    .map((item) => String(item.id))
}
/** The id the wire carries for one candidate value of the highlighted model. */
function stripId(pane: TspPane, value: string): string {
  return stripItemIds(pane).find((id) => stripValueOf(id) === value) ?? ''
}
/** The VALUE of the strip item the client paints as `on` (the local draft). */
function stripOn(pane: TspPane): string | undefined {
  return stripValueOf(String(((props(pane).strip as { items?: Array<Record<string, unknown>> } | undefined)
    ?.items ?? []).find((item) => item.on === true)?.id ?? ''))
}

/** The RAW action ids the bar renders: the frame token is part of them on purpose. */
function rawActionIds(pane: TspPane): string[] {
  return ((props(pane).actions ?? []) as Array<Record<string, unknown>>).map((entry) => String(entry.id))
}
/** The action BASES the bar renders, i.e. what each entry really does. */
function actionIds(pane: TspPane): string[] {
  return rawActionIds(pane).map((id) => id.split('#')[0]!)
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

/** The wire `mark` text of one catalogue row (the retry/failure rows carry none). */
function candidateMark(pane: TspPane, id: string): string | undefined {
  return (((props(pane).items ?? []) as Array<Record<string, unknown>>)
    .find((item) => String(item.id) === id)?.mark as { text?: string } | undefined)?.text
}

/** Walk the native main-list cursor with real ArrowDown keys until the picker's
 *  selected row is `id`. Bounded, so a stuck cursor fails instead of hanging. */
async function walkList(pane: TspPane, id: string): Promise<void> {
  for (let step = 0; step < 64; step += 1) {
    if (props(pane).selected === id) return
    const before = pane.frameCount()
    pane.key('\u001b[B')
    await waitUntil(`the cursor moves toward ${id}`, () => pane.frameCount() > before)
  }
  assert.equal(props(pane).selected, id, `the cursor reached ${id}`)
}

/** Wait for the picker's NEXT committed frame. The panel revision moves
 *  synchronously with every mutation, but the credit-gated frame may still be in
 *  flight — and a wire event addressed to the PREVIOUS frame's node id is refused
 *  as a stale receiver BY DESIGN, so a test that wants to deliver one must first
 *  observe the new frame. */
async function nextPickerFrame(pane: TspPane): Promise<void> {
  // The picker's node id is deliberately long-lived (a per-frame id made the client
  // REMOUNT the list, which moved it under a click), so a committed frame is observed
  // by the frame counter the fixture itself keeps.
  const before = pane.frameCount()
  await waitUntil('the next picker frame is committed', () => pane.frameCount() > before)
}

/** Whether the mounted picker page is the CATALOGUE (its title states what the
 *  one write does, so it is the page's own name at every width). */
/** The bytes a Reader `text` node really paints: they may live in the node's own
 *  `text` prop or in a span child (the notice carries its own role ink). */
function nodeText(node: ReturnType<typeof nodes>[number]): string {
  if (typeof node.p.text === 'string') return node.p.text
  const spans = node.p.spans
  if (!Array.isArray(spans)) return ''
  return spans
    .map((part) => (typeof part === 'string' ? part : String((part as { t?: unknown }).t ?? '')))
    .join('')
}

/** Whether the wire carries `value` as the complete text of one painted node. */
function carriesText(pane: TspPane, value: string): boolean {
  return nodes(pane).some((node) => node.k === 'text' && nodeText(node) === value)
}

/** The role ink of the painted span that carries `value` (`t`/`s` is the SDK's own
 *  span shape), or undefined when no painted span carries that text. */
function noticeTone(pane: TspPane, value: string): string | undefined {
  for (const node of nodes(pane)) {
    if (node.k !== 'text') continue
    const spans = node.p.spans
    if (!Array.isArray(spans)) continue
    for (const part of spans) {
      if (typeof part === 'object' && part !== null && String((part as { t?: unknown }).t ?? '') === value) {
        return String((part as { s?: unknown }).s ?? '')
      }
    }
  }
  return undefined
}

function onCatalogue(pane: TspPane): boolean {
  const title = String(props(pane).title ?? '')
  return title === 'Switch model' || title === 'Choose default model'
}

/**
 * The suite's WIDE pane: 160 terminal columns at the fixture's 8px cell = 1280px,
 * the pane class that paints the catalogue's `lg` SHEET. The fixture's own
 * 120-column pane (960px) is the narrow one, where the same catalogue renders `md`
 * — the interaction contract is IDENTICAL at both, which is exactly what the shared
 * cases below prove.
 */
const WIDE_COLS = 160

/** Whether the read-only Reader is the mounted page (it REPLACES the picker, so
 *  the page is read from the wire, never from picker props). */
function inDetails(pane: TspPane): boolean {
  return readerNode(pane) !== undefined
}

/**
 * Open the read-only Reader the ONE way the shell offers it: a real activation of
 * the highlighted catalogue row (`Enter`, or a click on the already-highlighted
 * row). There is no intermediate page.
 */
async function openDetails(pane: TspPane): Promise<void> {
  if (inDetails(pane)) return
  await enterDetails(pane)
}

/** A catalogue row activation opens the model's read-only Full details DIRECTLY
 *  with `Enter` — never a write, and never an intermediate page. */
async function enterDetails(pane: TspPane): Promise<void> {
  pane.key('\r')
  await waitUntil('the read-only Reader', () => inDetails(pane))
}

/** Leave the Reader the way the page really offers: its visible `Back` row. */
async function backFromDetails(pane: TspPane): Promise<void> {
  click(pane, readerBackNode(pane))
  await waitUntil('the Reader closed', () => !inDetails(pane))
}

/** Leave the Reader the way the page really offers: its visible `Back` row, which
 *  returns to the catalogue — the only page it is entered from. */
async function backToCatalogue(pane: TspPane): Promise<void> {
  if (inDetails(pane)) {
    await backFromDetails(pane)
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

/** The `[Enter]` key badge of one action bar entry, per pane. */
function focusCue(pane: TspPane, id: string): boolean {
  // The focused action is the one carrying the `[Enter]` key badge (the design
  // language's `Verb [Key]` affordance form).
  return String(actionOf(pane, id)?.label).endsWith('[Enter]')
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

/** TWO models that advertise the SAME candidate value: the reviewer's fixtures for a
 *  delayed strip click crossing a selection change, and for the keyboard zone a row click
 *  has to reclaim. */
const twinEffortDirectory: ModelPickerDirectory = {
  current: { provider: 'a', model: 'same', reasoningEffort: 'high' },
  directory: {
    default: { provider: 'a', model: 'same', reasoningEffort: 'high' },
    routableProviders: ['a', 'b'],
    groups: [
      {
        id: 'a',
        name: 'A',
        models: [{
          id: 'same',
          name: 'Twin A',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        }],
      },
      {
        id: 'b',
        name: 'B',
        models: [{
          id: 'same',
          name: 'Twin B',
          reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
        }],
      },
    ],
    failures: [],
  },
}

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
  let reject!: (reason: unknown) => void
  let retries = 0
  const handle = renderer.modelPresentation.open({
    subject,
    isCurrent: () => true,
    retry: () => {
      retries += 1
    },
    apply: (selection: unknown) =>
      new Promise<ModelApplyOutcome>((r, j) => {
        writes.push(selection)
        resolve = r
        reject = j
      }),
    runOwned: (label, task, options) =>
      runOwned(label, task, { ...options, diag: { debug() {}, warn() {}, error() {} } as never }),
  })
  // Every case starts on the suite's NARROW pane (100 columns = 800px). The sheet is
  // the same `md` dialog at every width (the retired wide summary had a threshold;
  // nothing has one now), and a case that needs a wider pane resizes up explicitly.
  sendResize(pane, 100)
  await settle(20)
  return {
    pane,
    renderer,
    handle,
    writes,
    retries: () => retries,
    settleWrite: (outcome: ModelApplyOutcome) => resolve(outcome),
    failWrite: () => reject(new Error('the model writer threw')),
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

test('native Model: the catalogue browses, drafts in its own strip and writes once', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // The narrow catalogue is the SAME picker as the wide one: no provider sidebar,
  // no preview region, and the ONE write named for what it really does.
  assert.equal(props(pane).title, 'Choose default model')
  assert.equal(props(pane).subtitle, 'Tab effort', 'the panel carries exactly ONE short hint, naming the strip Tab reaches')
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
  assert.deepEqual(rowOf(SAME_A)?.badges, [{ text: 'default' }], 'the directory fact, never the highlight')
  // The rows carry NO per-row effort fact any more: the effort lives in the
  // page's own strip below the list (see the strip suite), and neither the retired
  // fact column nor a per-row `facts` record may come back.
  assert.equal(props(pane).columns, undefined, 'the catalogue declares no fact column')
  assert.equal(rowOf(SAME_A)?.facts, undefined, 'and no row states a fact')
  // The order pins the REAL configured rows first (each model exactly once), then
  // groups the rest by provider, and ends with the partial-failure context.
  assert.deepEqual(props(pane).order, [
    { group: '\u0000current-default', label: 'Current · Default', count: 1 },
    SAME_A,
    { group: 'b', label: 'B', count: 1 },
    SAME_B,
    { group: '\u0000unavailable', label: 'Unavailable providers', count: 2 },
    'failure:bad',
    FAILURE_RETRY_ID,
  ])
  // A disabled row states its state in WORDS, never by colour alone: the design
  // language's overlay rules require the reason word next to a dim row.
  assert.equal(rowOf('failure:bad')?.label, 'Bad · unavailable', 'the failed provider states why it is inert')
  // A SELECT only MOVES the highlight: it never pages and never writes.
  browse(pane, SAME_B)
  await waitUntil('the highlight moved to B', () => props(pane).selected === SAME_B)
  assert.equal(onCatalogue(pane), true, 'a select never leaves the catalogue')
  assert.equal(m.writes.length, 0)
  // Enter (the keyboard's own activate) opens the HIGHLIGHTED model's read-only
  // Full details DIRECTLY: there is no intermediate page between them.
  await walkList(pane, SAME_A)
  await enterDetails(pane)
  assert.equal(picker(pane), undefined, 'the Reader replaces the picker — no page in between')
  assert.equal(readerValue(pane, 'reader-model'), 'Twin', 'and it describes the highlighted model')
  assert.equal(m.writes.length, 0, 'opening the Reader never writes')
  await backFromDetails(pane)
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
  // The catalogue's OWN strip is the ONE effort editor: a strip click changes the
  // local draft and nothing else.
  action(pane, 'strip', stripId(pane, 'low'))
  await waitUntil('the strip drafted Low', () => {
    const items = (props(pane).strip as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? []
    return items.find((item) => item.on === true)?.id === stripId(pane, 'low')
  })
  assert.equal(m.writes.length, 0, 'a strip click never writes')
  // The strip click made the strip the keyboard zone, so one forward Tab reaches
  // the explicit Primary Action; Enter then commits exactly once.
  pane.key('\t')
  await waitUntil('primary focused', () => String(actionOf(pane, 'apply')?.label).endsWith('[Enter]'))
  pane.key('\r')
  await waitUntil('one admitted write', () => m.writes.length === 1)
  assert.deepEqual(m.writes, [{ provider: 'a', model: 'same', reasoningEffort: 'low' }])
})

test('native Model: the catalogue is the SAME `md` dialog at every pane width', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // `lg` grows to the pane — measured 1120x698 in a 1280x800 pane, 87% of BOTH axes
  // — and a catalogue has no informational chrome that needs the room, so the sheet
  // is always the client's `md` dialog, exactly like the official product's own
  // pickers. The client shrinks that sheet by itself when the pane is narrower than
  // its cap, so a narrow pane is unchanged.
  assert.equal(props(pane).size, 'md', 'the mounted pane asks for the md dialog')
  assert.equal(props(pane).preview, 'none', 'and for NO preview region: the client reserves a fixed ~36% of the sheet body for `preview: below`')
  assert.equal(layerNodes(pane).some((node) => node.k === 'kv'), false, 'and paints no summary')
  assert.deepEqual(actionIds(pane), ['close', 'apply'], 'with the ONE write as its only operation')
  await resize(pane, WIDE_COLS)
  assert.equal(props(pane).size, 'md', 'a 1280px pane gets the SAME md dialog, never the fullscreen lg sheet')
  assert.equal(props(pane).preview, 'none', 'and the same absent preview region')
  assert.equal(layerNodes(pane).some((node) => node.k === 'kv'), false, 'and still no summary')
  assert.deepEqual(actionIds(pane), ['close', 'apply'], 'and the same ONE write')
  assert.equal(actionOf(pane, 'apply')?.label, 'Save default')
  assert.equal(actionOf(pane, 'apply')?.disabled, undefined, 'the write was never a preview entry')
  await resize(pane, 100)
  assert.equal(props(pane).size, 'md', 'and the narrow pane is unchanged')
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
  // A candidate id belongs to the strip's own namespace: a catalogue select
  // carrying it resolves nowhere.
  browse(pane, stripId(pane, 'low'))
  await settle(30)
  assert.equal(onCatalogue(pane), true)
  assert.equal(m.writes.length, 0)
  // A row event only acts when the FRAME is one this pane really built AND the payload
  // names a row the panel offers right now: the picker's node id is deliberately
  // long-lived (one identity per panel), so a foreign node id is what `targets` refuses
  // and a foreign ROW id is what the payload check refuses.
  sendActivate(pane, SAME_B, 'layer.model-999')
  browse(pane, SAME_B, 'layer.model-999')
  await settle(30)
  assert.equal(onCatalogue(pane), true, 'a node this pane never built cannot navigate')
  assert.equal(props(pane).selected, SAME_A, 'and it cannot re-target the highlight either')
  assert.equal(m.writes.length, 0)
  // The frame id is REAL here and the row id is not one this page carries: a candidate
  // id belongs to the strip's namespace, so an activate carrying it resolves nowhere.
  sendActivate(pane, stripId(pane, 'low'), picker(pane)!.id)
  await settle(30)
  assert.equal(onCatalogue(pane), true, 'a candidate id cannot navigate the catalogue')
  assert.equal(props(pane).selected, SAME_A, 'and it cannot re-target the highlight')
  assert.equal(m.writes.length, 0)
})

test('native Model: an action from an earlier revision is refused by its own token', async (t) => {
  // One long-lived picker node means the node id can no longer tell a stale event from a
  // current one, so the BAR carries the revision itself: the actions are rebuilt every
  // frame with the frame's token, and an `act` naming any other revision is refused at
  // admission exactly like an id that was never rendered. `close` is deliberately the one
  // untokened action (Esc and the client's backdrop send it from any frame).
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  const ids = rawActionIds(pane)
  assert.equal(ids.includes('close'), true, 'the dismissal keeps its frame-free id')
  const apply = ids.find((id) => id.startsWith('apply#'))
  assert.ok(apply !== undefined, `the write carries a frame token: ${JSON.stringify(ids)}`)
  assert.match(apply!, /^apply#\d+$/, 'and the token is the frame revision')
  const token = Number(apply!.split('#')[1])
  // A token from an earlier frame, and a base that was never rendered, are both refused.
  action(pane, `apply#${Math.max(token - 1, 0)}`)
  action(pane, 'apply#999999')
  action(pane, 'back#0')
  await settle(30)
  assert.equal(m.writes.length, 0, 'a stale or never-rendered action cannot write')
  assert.equal(onCatalogue(pane), true, 'and none of them pages the surface away')
  assert.equal(m.retries(), 0, 'and none of them starts a read')
  // The CURRENT frame's own token still works, so the negatives above are not vacuous.
  action(pane, apply!)
  await waitUntil('the current token writes', () => m.writes.length === 1)
  m.handle.close()
})

test('native Model: the catalogue owns its Reasoning Effort strip and it only drafts', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  const strip = (): { label?: string; items?: Array<Record<string, unknown>> } | undefined =>
    props(pane).strip as { label?: string; items?: Array<Record<string, unknown>> } | undefined
  const onId = (): string | undefined =>
    (strip()?.items ?? []).find((item) => item.on === true)?.id as string | undefined
  // The strip edits the HIGHLIGHTED model's candidates at the first level: the
  // native Picker `strip` between the list and the action bar.
  assert.equal(strip()?.label, 'Reasoning Effort')
  assert.deepEqual(stripValues(pane), ['\u0000provider-default', 'low', 'high'])
  assert.equal(onId(), stripId(pane, 'high'), 'the seeded draft is marked `on`')
  // A REAL strip click (the client's own `act:"strip"` channel) changes the local
  // draft only.
  action(pane, 'strip', stripId(pane, 'low'))
  await waitUntil('the strip click drafted Low', () => onId() === stripId(pane, 'low'))
  assert.equal(m.writes.length, 0, 'a strip click never writes')
  // A STALE or FORGED strip value is refused: a candidate this model does not
  // advertise, a candidate value on another namespace, and a missing value.
  const frame = picker(pane)!.id
  for (const value of [stripItemId(SAME_A, 'nope'), 'effort:nope', 'not-an-effort', undefined]) {
    action(pane, 'strip', value)
  }
  await settle(30)
  assert.equal(onId(), stripId(pane, 'low'), 'no forged strip value moves the draft')
  assert.equal(m.writes.length, 0)
  assert.equal(picker(pane)!.id, frame, 'and none of them re-renders the page')
  // The draft the strip chose is what the ONE write commits. The click made the
  // strip the keyboard zone, so one forward Tab reaches the bar from there.
  pane.key('\t')
  await waitUntil('primary focused', () => String(actionOf(pane, 'apply')?.label).endsWith('[Enter]'))
  pane.key('\r')
  await waitUntil('one write', () => m.writes.length === 1)
  assert.deepEqual(m.writes, [{ provider: 'a', model: 'same', reasoningEffort: 'low' }])
  m.settleWrite('rejected')
  await waitUntil('refusal restores the catalogue', () => props(pane).state === 'ready' && onCatalogue(pane))
  // A model that advertises NO effort paints NO strip row, and the ring skips it.
  browse(pane, SAME_B)
  await waitUntil('the no-effort model is highlighted', () => props(pane).selected === SAME_B)
  assert.equal(props(pane).strip ?? undefined, undefined, 'a model without efforts has no strip')
  pane.key('\t')
  await waitUntil('the bar is the next zone', () => String(actionOf(pane, 'apply')?.label).endsWith('[Enter]'))
  assert.equal(m.writes.length, 1, 'reaching the bar wrote nothing')
  // The read-only Reader paints no picker at all, therefore no strip either.
  // (The ring key and the next key are separated by a real observation: two raw keys
  // in the same flush would decode as one sequence.) `Esc` no longer returns anywhere —
  // it clears a filter or closes — so the bar is left with the ring itself.
  pane.key('\t')
  await waitUntil('the ring released the bar', () => !String(actionOf(pane, 'apply')?.label).endsWith('[Enter]'))
  await enterDetails(pane)
  assert.equal(props(pane).strip ?? undefined, undefined, 'the read-only Reader carries no strip of its own')
  assert.equal(m.writes.length, 1)
  m.handle.close()
})

test('native Model: a strip chip label is clamped to the pane\'s own strip capacity', async (t) => {
  // The client wraps the chips onto further rows but can neither shrink nor wrap ONE
  // chip, so a label wider than the strip's chip container is cut at the sheet's edge
  // (measured in a 400x600 pane: the container is 193.27px while the widest chip is
  // 308.59px). The presenter therefore clamps each chip label to the pane's own
  // capacity. The clamp keeps BOTH ends, because an effort name is free-form and two
  // candidates can differ only in their tail — a head-only clamp would render the
  // same label for two different candidates, and a strip item carries no title.
  assert.equal(stripLabelColumns(400), 15, 'a 400px pane affords 15 display columns')
  assert.equal(stripLabelColumns(1280), 42,
    'a 1280px pane affords no more than the client 680px sheet cap allows')
  assert.equal(stripLabelColumns(992), 42, 'and neither does any wider pane')
  assert.equal(stripLabelColumns(100), 4, 'and the budget never collapses below 4 columns')
  const low = 'Extended thinking (low)'
  const high = 'Extended thinking (high)'
  const m = await mounted(t)
  await m.ready(budgetDirectory({ effortNames: [low, high, 'Low'], omitDefaultEffort: true }))
  await resize(m.pane, 50)
  const labels = ((props(m.pane).strip as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])
    .map((item) => String(item.label))
  assert.deepEqual(labels.length, 4, 'the provider-default sentinel plus all three advertised efforts')
  assert.equal(labels[0], 'Default', 'a label that already fits is untouched')
  assert.equal(labels[3], 'Low', 'and so is a short one')
  assert.ok(labels[1]!.includes('…') && labels[2]!.includes('…'),
    `the over-wide labels are marked as truncated: ${labels[1]} / ${labels[2]}`)
  assert.notEqual(labels[1], labels[2],
    'two candidates that differ only in their tail keep DIFFERENT labels')
  assert.ok(labels[1]!.endsWith('(low)') && labels[2]!.endsWith('(high)'),
    `the tail that tells them apart survives: ${labels[1]} / ${labels[2]}`)
  for (const label of [labels[1]!, labels[2]!]) {
    assert.ok(displayWidth(label) <= stripLabelColumns(400), `${label} fits the pane's strip capacity`)
  }
  m.handle.close()
})

test('native Model: a row click hands the keyboard back to the list', async (t) => {
  const m = await mounted(t)
  await m.ready(twinEffortDirectory)
  const { pane } = m
  // Enter the strip the way a user does — a real click on a candidate — and then select the
  // OTHER model with the mouse. The keys must follow the last interaction: leaving the zone
  // in the strip would make the next ↑/↓ draft the PREVIOUS model's effort while the
  // highlight silently sits on the clicked one.
  action(pane, 'strip', stripId(pane, 'low'))
  await waitUntil('the strip owns the keyboard', () => props(pane).focus === 'strip')
  const onBefore = stripOn(pane)
  browse(pane, SAME_B)
  await waitUntil('the click highlighted B', () => props(pane).selected === SAME_B)
  assert.equal(props(pane).focus, 'list', 'the keyboard follows the click back to the list')
  pane.key('\u001b[B')
  await waitUntil('the cursor moved on the LIST', () => props(pane).selected !== SAME_B)
  assert.equal(stripOn(pane), onBefore, 'and the arrows never draft a model in the background')
  assert.equal(m.writes.length, 0)
  m.handle.close()
})

test('native Model: a delayed strip click from another model cannot draft into the new one', async (t) => {
  const m = await mounted(t)
  await m.ready(twinEffortDirectory)
  const { pane } = m
  // The id A's strip built while A was the highlighted model.
  const staleItem = stripId(pane, 'low')
  assert.notEqual(staleItem, '', 'A advertises `low`')
  // The user clicks model B — which advertises the SAME `low`, so a value-only membership
  // check would pass — and only then does the previous frame's strip event arrive.
  browse(pane, SAME_B)
  await waitUntil('the click highlighted B', () => props(pane).selected === SAME_B)
  const freshItem = stripId(pane, 'low')
  assert.notEqual(freshItem, staleItem, 'the new strip builds its ids for ITS model')
  const onBefore = stripOn(pane)
  action(pane, 'strip', staleItem)
  await settle(30)
  assert.equal(props(pane).selected, SAME_B, 'B is still the highlighted model')
  assert.equal(stripOn(pane), onBefore, "and A's click never drafts into B")
  assert.equal(m.writes.length, 0)
  // The CURRENT model's own item still drafts, so the refusal above is not vacuous.
  action(pane, 'strip', freshItem)
  await waitUntil('the current model drafts', () => stripOn(pane) === 'low')
  m.handle.close()
})

test('native Model: the strip is painted only while the phase can really draft', async (t) => {
  // The client paints no DISABLED strip item, so a strip that stayed on screen during
  // a phase that refuses every draft change would be a promise the panel cannot keep
  // — and the click would be dropped later, by a guard the user never sees. Display
  // and admission are therefore the same fact: `stripOffered` is false unless the
  // phase is ready.
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  assert.ok(props(pane).strip, 'a ready catalogue paints the strip')
  m.handle.setLoading()
  await settle(30)
  assert.equal(props(pane).state, 'loading')
  assert.equal(props(pane).strip ?? undefined, undefined, 'a running re-read paints no strip')
  action(pane, 'strip', stripId(pane, 'high'))
  await settle(30)
  assert.equal(m.writes.length, 0, 'and a strip click is refused at admission, not by a later guard')
  m.handle.setLoadError('catalog is unreachable')
  await settle(30)
  assert.equal(props(pane).state, 'error')
  assert.equal(props(pane).strip ?? undefined, undefined, 'a failed read keeps no strip either')
  action(pane, 'strip', stripId(pane, 'high'))
  await settle(30)
  assert.equal(m.writes.length, 0, 'and still admits nothing')
  m.handle.close()
})

test('native Model K2: Enter never writes from the list; the write is the focused Primary Action', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Enter on the catalogue opens the highlighted model's Reader (it never writes
  // and never reaches the bar), and Esc returns.
  pane.key('\r')
  await waitUntil('the Reader', () => inDetails(pane))
  assert.equal(m.writes.length, 0, 'Enter on the catalogue is not a write')
  pane.key('\u001b')
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
  // The catalogue paints its own effort strip between the list and the bar, so the
  // ring is list -> strip -> bar; the bar is the only region that can commit and the
  // focused Primary Action carries the app-rendered shape cue.
  pane.key('\t')
  // Inside the strip an arrow changes the DRAFT (its `on` item moves) and writes
  // nothing — that is how the zone is observed on the wire.
  const onId = (): string | undefined => (((props(pane).strip as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])
    .find((item) => item.on === true)?.id as string | undefined)
  assert.equal(onId(), stripId(pane, 'high'), 'the seeded draft is the strip-on item')
  pane.key('\u001b[D')
  await waitUntil('the strip arrow moved the draft', () => onId() === stripId(pane, 'low'))
  assert.equal(m.writes.length, 0, 'a strip arrow never writes')
  pane.key('\t')
  await waitUntil('primary focused', () => String(actionOf(pane, 'apply')?.label).endsWith('[Enter]'))
  assert.equal(actionOf(pane, 'apply')?.label, 'Save default [Enter]')
  pane.key('\r')
  await waitUntil('write from the primary action', () => m.writes.length === 1)
  assert.deepEqual(m.writes, [{ provider: 'a', model: 'same', reasoningEffort: 'low' }],
    'the ONE write carries the draft the STRIP chose')
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
  await resize(pane, WIDE_COLS)
  assert.equal(props(pane).size, 'md', 'the wide pane gets the same md dialog')
  assert.deepEqual(actionIds(pane), ['close', 'apply'], 'the SAME bar at the wide pane')
  await resize(pane, 100)
  // The catalogue is the model's own actionable page: `Cancel` + the ONE write.
  // The read-only Full details page is the native Reader: no picker, therefore no
  // action bar at all — no cancel entry, no write and no selectable row.
  await enterDetails(pane)
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

test('native Model: `select` only highlights and `activate` opens the Reader of THAT row', async (t) => {
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
  // `activate` (a click on the already-highlighted row, a double click, or Enter)
  // opens THAT model's read-only Full details directly. The event addresses the
  // CURRENT frame's picker.
  await nextPickerFrame(pane)
  sendActivate(pane, SAME_B)
  await waitUntil('activate opens the Reader of B', () =>
    inDetails(pane) && readerValue(pane, 'reader-model') === 'Twin')
  assert.equal(m.writes.length, 0, 'opening the Reader never writes')
  await backFromDetails(pane)
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
  // A whole-model switch needs no second page at all: the catalogue's own Primary
  // Action commits the HIGHLIGHTED model with its already-seeded draft.
  const frame = picker(pane)!.id
  pane.key('\u001b[Z')
  await waitUntil('primary focused', () => String(actionOf(pane, 'apply')?.label).endsWith('[Enter]'))
  pane.key('\r')
  await waitUntil('one write from the catalogue', () => m.writes.length === 1)
  assert.deepEqual(m.writes, [{ provider: 'b', model: 'same' }], 'the highlighted model, its own draft')
  m.settleWrite('rejected')
  await waitUntil('the refusal restores the catalogue', () => picker(pane) !== undefined && props(pane).state === 'ready' && onCatalogue(pane))
})

test('native Model: the Reader is entered from the catalogue and Back returns to it', async (t) => {
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
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
  assert.equal(props(pane).selected, SAME_B, 'the highlight survived the round trip')
  // The keyboard path is the same page: Esc is the visible Back row's own intent.
  pane.key('\r')
  await waitUntil('details from the keyboard', () => inDetails(pane))
  pane.key('\u001b')
  await waitUntil('Esc returns to the catalogue', () => onCatalogue(pane))
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
  // Returning to the catalogue brings the SAME one writer back.
  await backFromDetails(pane)
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
  assert.ok(actionOf(pane, 'apply'), 'the catalogue owns the one write')
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
      await waitUntil('refusal clears pending', () => picker(pane) !== undefined && props(pane).state === 'ready')
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

test('native Model: a refusal keeps the catalogue and the draft the strip chose', async (t) => {
  const m = await mounted(t, { sessionless: false })
  await m.ready()
  const { pane } = m
  const onId = (): string | undefined => ((props(pane).strip as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])
    .find((item) => item.on === true)?.id as string | undefined
  action(pane, 'strip', stripId(pane, 'low'))
  await waitUntil('the strip drafted Low', () => onId() === stripId(pane, 'low'))
  pane.key('\t')
  await waitUntil('the catalogue primary is focused', () => actionOf(pane, 'apply')?.label === 'Switch [Enter]')
  pane.key('\r')
  await waitUntil('the write is admitted', () => m.writes.length === 1)
  // An admitted write refuses every page operation, so its bar renders the way out
  // and the disabled write — never an entry that nothing could run.
  assert.deepEqual(actionIds(pane), ['close', 'apply'], 'a pending catalogue offers Close + the disabled write')
  assert.equal(props(pane).strip ?? undefined, undefined, 'and it paints no strip at all while the write is admitted')
  forge(pane, 'strip', stripId(pane, 'high'))
  await settle(30)
  assert.equal(m.writes.length, 1, 'a forged strip value cannot admit a second write')
  assert.equal(actionOf(pane, 'apply')?.label, 'Selecting…', 'and nothing can cancel the admitted write')
  m.settleWrite('rejected')
  await waitUntil('the refusal clears pending', () => props(pane).focus === 'list')
  // The catalogue is still the page, with the draft the strip chose.
  assert.equal(onCatalogue(pane), true, 'the refusal keeps the page the user was on')
  assert.equal(onId(), stripId(pane, 'low'), 'and the draft they chose')
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
  await waitUntil('primary zone', () => String(actionOf(pane, 'retry')?.label).endsWith('[Enter]'))
  pane.key('\r')
  await waitUntil('retry asked the original read owner', () => m.retries() === 1)
  assert.equal(m.writes.length, 0, 'a Retry never writes')
  assert.equal(props(pane).state, 'loading', 'the retry re-enters loading')
  // The re-read hydrates the SAME panel AND the same node: one identity per panel is
  // what keeps the client from remounting the list (measured: a per-frame id moved the
  // whole viewport under a click).
  const nodeId = picker(pane)!.id
  await m.ready()
  assert.equal(picker(pane)!.id, nodeId, 'the re-read hydrates the SAME picker node')
  action(pane, 'apply', undefined, nodeId)
  await settle(20)
  assert.equal(m.writes.length, 0, 'the re-read phase admits no write')
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
  assert.equal(props(pane).preview, 'none', 'and it asks for no preview region')
  assert.equal(props(pane).scopes, undefined, 'the list-first catalogue has no provider sidebar')
  assert.equal(props(pane).title, 'Choose default model')
  assert.equal(
    (props(pane).items as Array<Record<string, unknown>>).some((item) => item.disabled !== undefined),
    false,
    'a directory without failed providers lists none',
  )
  // Details is the native READER replacing the picker: the complete values are
  // `ui.text` nodes the client wraps at its own real width, not pre-split rows.
  await enterDetails(pane)
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
  // Back restores the catalogue; the effort is chosen in its own strip now.
  await backFromDetails(pane)
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
  const onId = (): string | undefined => ((props(pane).strip as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])
    .find((item) => item.on === true)?.id as string | undefined
  action(pane, 'strip', stripId(pane, '\u0000provider-default'))
  await waitUntil('the candidate took the draft', () => onId() === stripId(pane, '\u0000provider-default'))
  assert.equal(m.writes.length, 0, 'a strip click never writes')
  pane.key('\t')
  await waitUntil('the catalogue primary is focused', () => String(actionOf(pane, 'apply')?.label).endsWith('[Enter]'))
  pane.key('\r')
  await waitUntil('write from the narrow primary action', () => m.writes.length === 1)
  assert.deepEqual(
    m.writes,
    [{ provider: 'p', model: 'm' }],
    'the provider-default draft submits WITHOUT a reasoningEffort literal',
  )
  // A refusal re-enables the panel with the chosen draft intact, and the draft
  // survives the flip to a wider pane (where the strip still shows it).
  m.settleWrite('rejected')
  await waitUntil('refusal restores the panel', () => props(pane).state === 'ready')
  await resize(pane, WIDE_COLS)
  // A width flip never pages the panel on its own: the catalogue the user was on
  // stays the catalogue (now the same `md` dialog), and its strip keeps the draft
  // chosen on the narrow pane.
  assert.equal(onCatalogue(pane), true, 'the width flip kept the page')
  assert.equal(props(pane).size, 'md', 'and the sheet is the same md dialog')
  assert.deepEqual(props(pane).preview, 'none', 'and it paints no preview region either')
  const stripOn = ((props(pane).strip as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])
    .find((item) => item.on === true)?.id
  assert.equal(stripOn, stripId(pane, '\u0000provider-default'),
    'the draft chosen on the narrow pane is the wide catalogue strip draft')
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
  await waitUntil('model resumes', () => picker(pane) !== undefined && picker(pane)!.id === oldId && props(pane).title !== undefined)
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
    await resize(boot.pane, WIDE_COLS)
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
    const firstPanel = picker(boot.pane)!.id
    boot.pane.key('\u001b')
    await waitUntil('close picker', () => picker(boot.pane) === undefined)
    boot.pane.key('/model\r')
    await waitUntil('reopened old default', () => props(boot.pane).state === 'ready')
    const id = picker(boot.pane)!.id
    // One identity per PANEL, never across panels: a node id from the panel that closed
    // must not be able to act on the one that replaced it (the SDK routes by id, and the
    // id is the only thing an event carries besides its payload).
    assert.notEqual(id, firstPanel, 'a reopened panel gets its own node identity')
    browse(boot.pane, JSON.stringify(['p', 'm2']), firstPanel)
    await settle(20)
    assert.equal(picker(boot.pane)!.id, id, "the retired panel's id cannot act on the new one")
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
    await resize(boot.pane, WIDE_COLS)
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
    await resize(boot.pane, WIDE_COLS)
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
    await resize(fixture.pane, WIDE_COLS)
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
    // read-only Reader a row activation opens directly.
    assert.equal(props(fixture.pane).title, 'Switch model')
    fixture.pane.key('\r')
    await waitFor('details page', () => readerNode(fixture.pane) !== undefined)
    // The Reader carries the COMPLETE value, wrapped by the client; the Current
    // fact is read from the Session the picker re-opened on.
    assert.equal(
      readerValue(fixture.pane, 'reader-fact-current'),
      `scripted · ${DIRECT_TSP_MODEL_TWO}`,
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

test('native Model: Esc clears the search filter first, then closes', async (t) => {
  // The Owner's ladder, and it holds in EVERY catalogue zone: a typed filter is what `Esc`
  // clears, and only a second `Esc` (with nothing left to clear) dismisses the panel. The zone
  // ring — `Tab`/`Shift+Tab` — is how the keyboard moves between the list, the strip and the
  // bar, so `Esc` never has to return anywhere. This is the reviewer's directed case for the
  // frozen K2 table: from the STRIP, `Esc` with a filter clears it and leaves the panel open.
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // A filter that still matches: with an EMPTY list there is no highlighted model, so the
  // strip would not be offered and the keyboard could not reach it.
  pane.key('win')
  await waitUntil('the filter is typed', () => props(pane).query === 'win')
  pane.key('\t')
  await waitUntil('the strip owns the keyboard', () => props(pane).focus === 'strip')
  pane.key('\u001b')
  await waitUntil('Esc cleared the filter from the strip', () => props(pane).query === '')
  assert.equal(picker(pane) !== undefined, true, 'the panel is still open')
  assert.equal(props(pane).focus, 'strip', 'with the keyboard where it was')
  // Nothing left to clear: the next Esc closes, from whatever zone it is pressed in.
  pane.key('\u001b')
  await waitUntil('the second Esc closes the panel', () => picker(pane) === undefined)
  assert.equal(m.writes.length, 0, 'and no key on that path ever wrote')
  // (The Reader's own `Esc` = its visible `Back` row is unchanged and covered by its own
  // tests: it has no filter to clear, and closing the panel there would drop the page
  // context its origin can restore.)
})

test('native Model: a fully failed read leaves ONE Retry, and it is the bar’s', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // The PARTIAL read paints its one read-only retry row, and the keyboard can run it while the
  // catalogue is really showing its content.
  assert.equal(rowIds(pane).includes(FAILURE_RETRY_ID), true,
    `the partial read offers its retry row: ${JSON.stringify(rowIds(pane))}`)
  for (let step = 0; step < 8 && props(pane).selected !== FAILURE_RETRY_ID; step += 1) {
    pane.key('\u001b[B')
    await settle(10)
  }
  assert.equal(props(pane).selected, FAILURE_RETRY_ID, 'the cursor really reaches it')
  pane.key('\r')
  await waitUntil('the row ran the read owner', () => m.retries() === 1)
  await m.ready()
  // Now the read fails as a WHOLE. The action bar is the only operable region, so the row must
  // be gone: leaving it painted, and its event admissible, would offer a SECOND Retry beside
  // the footer's — reachable with the mouse while the keyboard is refused.
  m.handle.setLoadError('catalog is unreachable')
  await waitUntil('the whole read failed', () => props(pane).state === 'error')
  assert.equal(rowIds(pane).includes(FAILURE_RETRY_ID), false,
    `no retry row in a failed read: ${JSON.stringify(rowIds(pane))}`)
  assert.equal(actionIds(pane).includes('retry'), true, 'the bar keeps the ONE Retry')
  // A stale row event (the id the ready frame used to carry) is inert: it is not part of this
  // frame, and the panel no longer offers that row.
  const before = m.retries()
  sendActivate(pane, FAILURE_RETRY_ID, picker(pane)!.id)
  browse(pane, FAILURE_RETRY_ID, picker(pane)!.id)
  await settle(30)
  assert.equal(m.retries(), before, 'the retired row id cannot start a read')
  assert.equal(m.writes.length, 0)
  // The bar's own Retry still works, so the negation above is not vacuous.
  action(pane, String(actionOf(pane, 'retry')?.id))
  await waitUntil('the bar ran the read owner', () => m.retries() === before + 1)
  m.handle.close()
})

test('native Model: Esc clears the filter in a FAILED read too, and never reopens the search box', async (t) => {
  // The reviewer's production path: a read that RUNS keeps the search editable, so a filter can
  // be typed before it fails; the failure keeps that filter on screen, and `Esc` must still be
  // the ladder's clear rather than a swallowed key. What it must NOT do is re-open the search
  // box: in this phase an ordinary character is refused.
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  m.handle.setLoading()
  await waitUntil('the read runs', () => props(pane).state === 'loading')
  pane.key('a')
  pane.key('b')
  pane.key('c')
  await waitUntil('the filter is typed while the read runs', () => props(pane).query === 'abc')
  m.handle.setLoadError('catalog is unreachable')
  await waitUntil('the read failed with the filter kept',
    () => props(pane).state === 'error' && props(pane).query === 'abc')
  pane.key('\u001b')
  await waitUntil('Esc cleared the filter in the failed read', () => props(pane).query === '')
  assert.equal(picker(pane) !== undefined, true, 'and the panel is still open')
  // An ordinary key is still refused here: the phase admits the CLEAR, not the editor.
  pane.key('x')
  await settle(30)
  assert.equal(props(pane).query, '', 'a failed read admits no search editing')
  // Nothing left to clear, so the next Esc closes.
  pane.key('\u001b')
  await waitUntil('the second Esc closes the failed panel', () => picker(pane) === undefined)
  assert.equal(m.writes.length, 0, 'and no key on that path ever wrote')
})

test('native Model: the failure group count and the total follow the retry row', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  const unavailable = (): Record<string, unknown> | undefined =>
    ((props(pane).order ?? []) as Array<Record<string, unknown> | string>)
      .find((entry) => typeof entry === 'object' && entry !== null
        && (entry as { label?: string }).label === 'Unavailable providers') as Record<string, unknown> | undefined
  // The fixture has two models and one failed provider: while the catalogue is ready the group
  // counts its provider AND the retry row, and the total counts everything the list carries.
  assert.equal(unavailable()?.count, 2, 'ready: the failed provider + the retry row')
  assert.equal(props(pane).total, 4, 'ready: two models + one failure + the retry row')
  m.handle.setLoadError('catalog is unreachable')
  await waitUntil('the whole read failed', () => props(pane).state === 'error')
  assert.equal(unavailable()?.count, 1, 'error: the retry row is gone, so the group counts one row')
  assert.equal(props(pane).total, 3, 'error: and the total follows it')
  assert.equal(rowIds(pane).includes(FAILURE_RETRY_ID), false, 'no retry row in the list either')
  m.handle.close()
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
  // The second page is the read-only Reader: it carries NO action bar at all, and
  // its ONE visible Back row is the page's only operation.
  const second = await mounted(t)
  await second.ready(clean)
  const sp = second.pane
  await enterDetails(sp)
  assert.equal(picker(sp), undefined, 'the Reader carries no action bar to reach')
  assert.equal(second.writes.length, 0, 'no bar action ever wrote here')
  const readerBefore = readerNode(sp)?.id
  sp.key('\t')
  await settle(20)
  assert.equal(readerNode(sp)?.id, readerBefore, 'Tab cannot move the keyboard anywhere on the Reader')
  await backFromDetails(sp)
  await waitUntil('the Back row returned to the catalogue', () => onCatalogue(sp))
  second.handle.close()
})

test('native Model: a phase whose bar no key can run carries no Enter cue', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  await m.ready()
  const focused = (id: string) => String(actionOf(pane, id)?.label).endsWith('[Enter]')
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
  await waitUntil('bar focused on the retry', () => String(actionOf(l.pane, 'retry')?.label).endsWith('[Enter]'))
  assert.equal(actionOf(l.pane, 'retry')?.label, 'Retry [Enter]')
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
  // The catalogue's own line names the ONE zone `Tab` reaches next on this page
  // state — and it is the panel's ONLY hint.
  assert.equal(props(pane).subtitle, 'Tab effort', 'the ONE hint lives in the subtitle slot')
  assert.ok(!sheetText(pane).includes('Tab effort'), 'and it is not duplicated into the body')
  // The bar is not described by a hint of its own: its `[Enter]` badge names the action
  // Enter would run.
  pane.key('\u001b[Z')
  await waitUntil('bar focused on the primary', () => focusCue(pane, 'apply'))
  assert.equal(props(pane).subtitle, 'Tab list',
    'from the bar the ONE hint names the list it wraps to, and the badge names the focused action')
  pane.key('\t')
  await waitUntil('the ring wraps back to the list zone', () => props(pane).focus === 'list')
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
    () => String(actionOf(m.pane, 'close')?.label).endsWith('[Enter]'))
  assert.ok(
    !String(actionOf(m.pane, 'apply')?.label).endsWith('[Enter]'),
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
    () => String(actionOf(empty.pane, 'close')?.label).endsWith('[Enter]'))
  assert.ok(
    !String(actionOf(empty.pane, 'apply')?.label).endsWith('[Enter]'),
    'the empty-directory bar never cues the disabled Primary',
  )
  empty.pane.key('\r')
  await waitUntil('empty directory: Enter closes', () => picker(empty.pane) === undefined)
})

test('native Model: a failed read keeps the keyboard in the one bar it can operate', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  const focused = (id: string) => String(actionOf(pane, id)?.label).endsWith('[Enter]')
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
  // A Tab that keeps the SAME bar focus legitimately changes nothing on the wire (one
  // long-lived node, and the cue is what carries the focus), so each step is asserted on
  // the state it produced rather than on a frame that need not exist.
  for (const [name, key] of [['Tab', '\t'], ['Shift+Tab', '\u001b[Z']] as const) {
    pane.key(key)
    await settle(20)
    assert.ok(focused('retry') || focused('close'),
      `${name} must not drop the cue into the inert list`)
  }
  // ←→ still move across Retry/Cancel in that zone (each step its own frame).
  const barFrame = picker(pane)?.id
  pane.key('\u001b[D')
  await waitUntil('Cancel focused', () => focused('close'))
  const closeFrame = picker(pane)?.id
  pane.key('\u001b[C')
  await waitUntil('Retry focused again', () => focused('retry'))
  // Esc is never swallowed: the failed read has no operable zone to return to, so
  // it closes instead of parking the keyboard in the inert list.
  pane.key('\u001b')
  await waitUntil('Esc closes a failed read', () => picker(pane) === undefined)
  // The symmetric page path: a details page under a failed read. The Reader is the
  // one page whose own view keys are EXEMPT from the phase gates, so here `Esc` is
  // its visible `Back` row: it returns to the catalogue it was entered from (never
  // closing the panel out from under the page's own context), and the failure stays
  // reported there.
  const details = await mounted(t)
  await details.ready()
  await openDetails(details.pane)
  const readerFrames = details.pane.frameCount()
  details.handle.setLoadError('catalog is unreachable')
  // A failed (re-)read under the Reader has no picker bar to operate: the page
  // keeps its content and reports the failure as its own leading notice.
  await waitUntil('the failure is reported on the Reader', () =>
    carriesText(details.pane, 'catalog is unreachable'))
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
  await waitUntil('Esc returns to the catalogue the Reader came from',
    () => onCatalogue(details.pane) && props(details.pane).state === 'error')
  // In that phase the catalogue's bar is the only operable region, so its own way
  // out is the Esc the bar always admits — closing the panel, never a lost page.
  details.pane.key('\u001b')
  await waitUntil('Esc closes the failed panel from its bar', () => picker(details.pane) === undefined)
  details.handle.close()
})

test('native Model: Loading keeps the search editable, and Esc clears that filter first', async (t) => {
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
  await waitUntil('Esc clears the filter while the read runs',
    () => props(pane).query === '' && picker(pane) !== undefined)
  pane.key('\u001b')
  await waitUntil('and the next Esc closes the loading panel', () => picker(pane) === undefined)
})

test('native Model: the title states the ONE intent and carries no other global surface', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // ONE short title per page: the catalogue names what its ONE write really does,
  // so there is no separate subject slot to keep in sync and nothing to truncate.
  assert.equal(props(pane).title, 'Choose default model')
  await resize(pane, 100)
  assert.equal(props(pane).title, 'Choose default model', 'the SAME title at both widths')
  // The catalogue's ONE strip is its Reasoning Effort editor — never a global
  // action strip: its items carry effort candidates, and the page's operations stay
  // in the footer.
  const strip = props(pane).strip as { label?: string; items?: Array<Record<string, unknown>> } | undefined
  assert.equal(strip?.label, 'Reasoning Effort', 'the strip names the effort it edits')
  assert.deepEqual(
    (strip?.items ?? []).map((item) => stripValueOf(String(item.id))),
    ['\u0000provider-default', 'low', 'high'],
    'and every one of its items is a candidate of the MODEL the strip currently shows',
  )
  assert.equal(
    (strip?.items ?? []).every((item) => stripItemParts(String(item.id))?.rowId === SAME_A),
    true,
    'each item id also names that model, so a delayed click cannot draft into another one',
  )
  assert.equal((strip?.items ?? []).some((item) => item.disabled !== undefined), false, 'and none of them is an action')
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
  // The catalogue and the details page are the ONLY pages, and neither of them is
  // a global operations menu.
  const titles = new Set<string>([String(props(pane).title)])
  await resize(pane, 100)
  titles.add(String(props(pane).title))
  await enterDetails(pane)
  titles.add(String(readerNode(pane)?.p.head))
  assert.deepEqual([...titles].sort(), ['Choose default model', 'Twin'],
    'the catalogue and the Reader are the ONLY two pages')
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

test('native Model: every advertised effort is reachable in the catalogue strip at every width', async (t) => {
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
    for (const cols of [WIDE_COLS, 100]) {
      const m = await mounted(t)
      await resize(m.pane, cols)
      await m.ready(scenario.d)
      const where = `${scenario.name} at ${cols} columns`
      const reasoning = scenario.d.directory.groups[0]!.models[0]!.reasoning
      const advertised = reasoning === undefined
        ? 0
        : reasoning.defaultEffort === undefined ? reasoning.efforts.length + 1 : reasoning.efforts.length
      // The CATALOGUE itself carries every candidate as its own strip item: that is
      // the ONE effort editor, and there is no second page listing them (the strip
      // wraps instead of scrolling — measured by the strip probe).
      const stripItemsOf = ((props(m.pane).strip as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])
      assert.equal(
        stripItemsOf.length,
        advertised,
        `${where}: the catalogue's own strip offers every advertised candidate`,
      )
      assert.equal(
        (props(m.pane).strip as { label?: string } | undefined)?.label,
        'Reasoning Effort',
        `${where}: and it says what it edits`,
      )
      // A row activation opens the Reader DIRECTLY (no intermediate page), and the
      // strip is the ONE effort editor for the highlighted model.
      await enterDetails(m.pane)
      assert.equal(picker(m.pane), undefined, `${where}: a row activation opens the Reader directly`)
      await backFromDetails(m.pane)
      await waitUntil(`${where}: back on the catalogue`, () => onCatalogue(m.pane))
      const last = reasoning?.efforts.at(-1)?.id
      assert.ok(last, `${where}: the fixture advertises at least one concrete effort`)
      action(m.pane, 'strip', stripId(m.pane, last))
      await waitUntil(`${where}: the last candidate drafted`, () => {
        const items = (props(m.pane).strip as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? []
        return items.find((item) => item.on === true)?.id === stripId(m.pane, last)
      })
      m.pane.key('\t')
      await waitUntil(`${where}: the Primary Action`, () => String(actionOf(m.pane, 'apply')?.label).endsWith('[Enter]'))
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
  await resize(m.pane, WIDE_COLS)
  await m.ready(crlf)
  // The catalogue's rows are ONE line each: no description text, no raw break and
  // no `…` clamping of ours anywhere on the page.
  assert.equal(
    layerNodes(m.pane).some((node) => JSON.stringify(node.p).includes(blank)),
    false, 'the description never becomes a catalogue row (it is a Reader fact)')
  assert.ok(!/[\n\r\v\f\u2028\u2029]/u.test(sheetText(m.pane)), 'no catalogue row carries a raw line break')
  // The complete description reaches the Reader: the explicit blank lines are
  // the client's to render, never a budget of ours to fold. The untrusted-text
  // projection normalizes the fixture's CRLF to LF (it removes no content).
  await openDetails(m.pane)
  assert.equal(readerValue(m.pane, 'reader-description'), blank.replace(/\r\n/g, '\n'),
    'the blank lines reach the Reader, with CRLF normalized to LF')
  // A READ ERROR is reported as the Reader's own leading line, COMPLETE: a long
  // message is never clamped into a one-line row.
  const long = `catalog is unreachable ${'x'.repeat(400)}`
  m.handle.setLoadError(long)
  await settle(30)
  assert.equal(readerValue(m.pane, 'reader-description'), blank.replace(/\r\n/g, '\n'),
    'the page keeps its content through the failure')
  assert.equal(carriesText(m.pane, long), true, 'the reader carries the complete notice as its own value')
  m.handle.close()
})

test('native Model: every Details fact reaches the Reader COMPLETE and wraps by kind', async (t) => {
  const m = await mounted(t, { sessionless: false })
  const longProvider = 'Advertised provider name '.repeat(20)
  const modelId = 'anthropic/claude-3.7-sonnet:thinking'
  const description = 'Long description '.repeat(35)
  await resize(m.pane, WIDE_COLS)
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
  assert.equal(facts.get('reader-fact-current'), `p · ${modelId} · high`, 'the live Current value')
  assert.equal(facts.get('reader-fact-default'), `p · ${modelId} · high`, 'the persisted Default value')
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
  await waitUntil('back on the catalogue', () => onCatalogue(m.pane))
  action(m.pane, 'back')
  await waitUntil('back on the catalogue', () => onCatalogue(m.pane))
  m.pane.key('\u001b[Z')
  await waitUntil('primary action focused', () => String(actionOf(m.pane, 'apply')?.label).endsWith('[Enter]'))
  m.pane.key('\r')
  await waitUntil('pending', () => actionOf(m.pane, 'apply')?.label === 'Selecting…')
  m.settleWrite('rejected')
  await waitUntil('rejected and ready', () => props(m.pane).state === 'ready' && onCatalogue(m.pane))
  await openDetails(m.pane)
  assert.equal(carriesText(m.pane, 'Rejected.'), true, 'the full write notice is readable')
  // A refused write is a FAILURE, not information: the tone follows the notice, not
  // the phase — the panel is `ready` again by the time the Reader paints it.
  assert.equal(noticeTone(m.pane, 'Rejected.'), 'error',
    'a refusal is painted with the error role even though the panel is ready again')
  // A CANCELLATION is information: the same page inks it muted.
  await backFromDetails(m.pane)
  await waitUntil('back on the catalogue', () => onCatalogue(m.pane))
  m.pane.key('\u001b[Z')
  await waitUntil('primary focused again', () => String(actionOf(m.pane, 'apply')?.label).endsWith('[Enter]'))
  m.pane.key('\r')
  await waitUntil('pending again', () => actionOf(m.pane, 'apply')?.label === 'Selecting…')
  m.settleWrite('cancelled')
  await waitUntil('cancelled and ready', () => props(m.pane).state === 'ready')
  await openDetails(m.pane)
  assert.equal(noticeTone(m.pane, 'Cancelled.'), 'muted', 'a cancelled write is information, never a failure')
  m.handle.close()
})

test('native Model: a write that THROWS reaches the Reader as a failure too', async (t) => {
  // The third way a write can fail: the writer itself throws. It shares the refusal's
  // role ink (`error`) and must never be mistaken for the informational cancellation.
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  pane.key('\u001b[Z')
  await waitUntil('primary focused', () => String(actionOf(pane, 'apply')?.label).endsWith('[Enter]'))
  pane.key('\r')
  await waitUntil('pending', () => actionOf(pane, 'apply')?.label === 'Selecting…')
  m.failWrite()
  await waitUntil('the failure restores the catalogue', () => onCatalogue(pane) && props(pane).state === 'ready')
  assert.equal(props(pane).message, 'Failed.', 'the catalogue offers the failure in its message slot')
  await openDetails(pane)
  assert.equal(carriesText(pane, 'Failed.'), true, 'the Reader states the failure')
  assert.equal(noticeTone(pane, 'Failed.'), 'error', 'and inks it as a failure')
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
  // The projection normalizes CRLF to LF: the client still renders the same
  // explicit blank lines, only the raw CR byte is gone.
  const projected = blank.replace(/\r\n/g, '\n')
  const five = budgetDirectory({
    providerName: 'p',
    modelId: 'm',
    description: blank,
    effortNames: ['e1', 'e2', 'e3', 'e4', 'e5'],
  })
  await resize(m.pane, WIDE_COLS)
  await m.ready(five)
  // The complete description stays readable through the Reader, RAW: its explicit
  // blank lines are the client's to render, never a budget of ours.
  await openDetails(m.pane)
  assert.equal(
    readerValue(m.pane, 'reader-description'),
    projected,
    'the blank lines and the visible text all reach the Reader, CRLF normalized',
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
  await waitUntil('back on the catalogue', () => onCatalogue(m.pane))
  // The CJK model's own Reader, opened by activating its row.
  sendActivate(m.pane, SAME_B)
  await waitUntil('the CJK model Reader', () =>
    inDetails(m.pane) && readerValue(m.pane, 'reader-model') === 'Twin')
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
  // The catalogue carries the short identity; the FULL facts live in the read-only
  // Reader a row activation opens.
  assert.equal(props(live.pane).title, 'Switch model')
  const liveFacts = async (): Promise<Map<string, string>> => {
    await openDetails(live.pane)
    const facts = readerFacts(live.pane)
    await backToCatalogue(live.pane)
    return facts
  }
  const facts = await liveFacts()
  assert.equal(facts.get('reader-fact-current'), 'a · same · high', `live Current fact: ${JSON.stringify([...facts])}`)
  assert.equal(facts.get('reader-fact-default'), 'b · same · low', 'the persisted default keeps its own effort')
  live.handle.close()
  const sessionless = await mounted(t)
  await sessionless.ready()
  await openDetails(sessionless.pane)
  const plainFacts = readerFacts(sessionless.pane)
  assert.equal(plainFacts.has('reader-fact-current'), false, 'a sessionless panel never paints a Current fact')
  assert.equal(plainFacts.get('reader-fact-default'), 'a · same · high')
})

test('native Model: a model without efforts paints no strip and invents no candidate', async (t) => {
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
  // The absence is stated by the ABSENT strip: no invented `Not available` row and
  // no candidate anywhere, and `Tab` therefore reaches the bar directly.
  assert.equal(props(pane).strip ?? undefined, undefined, 'a model without efforts paints no strip')
  assert.equal(
    layerNodes(pane).some((node) => node.id.includes('effort:')),
    false,
    'and no page invents a candidate for it',
  )
  pane.key('\t')
  await waitUntil('the bar is the next zone', () => String(actionOf(pane, 'apply')?.label).endsWith('[Enter]'))
  pane.key('\t')
  await waitUntil('the ring released the bar', () => !String(actionOf(pane, 'apply')?.label).endsWith('[Enter]'))
  await enterDetails(pane)
  assert.equal(readerValue(pane, 'reader-model'), 'Twin', 'the Reader still describes that model')
  assert.equal(m.writes.length, 0, 'and nothing wrote')
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
    { group: '\u0000current-default', label: 'Current · Default', count: 1 },
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
  // The selection was already the configured row, so the wait is on the FRAME the
  // click produced: a wire event addressed to the previous frame is refused by
  // design.
  await nextPickerFrame(pane)
  assert.equal(props(pane).selected, JSON.stringify(['all', 'm']), 'the effort-bearing model is highlighted')
  // The catalogue's OWN strip carries those scope-shaped candidates on the shared
  // `effort:` namespace, so each one really takes the draft.
  const onId = (): string | undefined => ((props(pane).strip as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? [])
    .find((item) => item.on === true)?.id as string | undefined
  for (const value of ['scope-all', 'scope:other', 'scope:复杂🚀']) {
    action(pane, 'strip', stripId(pane, value))
    await waitUntil(`the candidate ${value} takes the draft`, () => onId() === stripId(pane, value))
  }
  assert.equal(m.writes.length, 0, 'a strip click is never a write')
  // A scope-shaped value that is NOT one of the highlighted model's candidates
  // resolves nowhere.
  const stripFrame = picker(pane)!.id
  action(pane, 'strip', 'scope:all')
  action(pane, 'strip', 'effort:nope')
  action(pane, 'strip', 'not-an-effort')
  await settle(30)
  assert.equal(picker(pane)!.id, stripFrame, 'a foreign strip value never acts')
  assert.equal(onId(), stripId(pane, 'scope:复杂🚀'), 'and never moves the draft')
  assert.equal(m.writes.length, 0)
  // ...and the ONE write carries the non-ASCII effort id VERBATIM.
  pane.key('\t')
  await waitUntil('the one write entry is focused',
    () => String(actionOf(pane, 'apply')?.label).endsWith('[Enter]'))
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

test('native Model: no pane width changes the sheet form any more', async (t) => {
  // The presenter used to pick `lg` from a reconstructed 900px width. That sheet is
  // not a dialog: measured in the real client with a twelve-row fixture it filled
  // 1120x698 of a 1280x800 pane (87% of BOTH axes), while the same fixture at `md`
  // is a centred 680x540. The official product's own pickers are always `md` too, so
  // the form is now constant and NOTHING in the presenter reads the pane width for
  // it (the strip's chip clamp is the only width-derived value left).
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  for (const cols of [50, 100, 112, 113, 160]) {
    await resize(pane, cols)
    assert.equal(props(pane).size, 'md', `a ${cols * 8}px pane paints the md dialog`)
    assert.equal(props(pane).preview, 'none', `and no preview region at ${cols * 8}px`)
    assert.deepEqual(actionIds(pane), ['close', 'apply'], `and the ONE write at ${cols * 8}px`)
    assert.deepEqual(
      rowIds(pane).filter((id) => !id.startsWith('failure:') && id !== FAILURE_RETRY_ID),
      [SAME_A, SAME_B],
      `and the same rows at ${cols * 8}px`,
    )
  }
  assert.equal(m.writes.length, 0, 'no width flip ever wrote')
  m.handle.close()
})

test('native Model: a scroll queued behind a stalled frame credit stays a REAL Reader body', async (t) => {
  // The SDK owns the frame/credit queue: `Surface.scroll()` appends to the SDK's own
  // `#queue` when no frame credit is free, and `#flush()` sends the newest pending View
  // followed by that queue UNFILTERED (the documented F3-001 boundary — see the
  // runtime-gap record). That queue used to trip F3-004 here because a Reader body id
  // was frame-scoped: a scroll queued for one revision and delivered after a LATER
  // revision replaced the pending View addressed a node the client never saw. The Reader
  // now keeps ONE identity per panel, so this test drives the same stall and asserts the
  // opposite, stronger fact: the op the client finally receives names the body the
  // client already HAS.
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await openDetails(pane)
  const sentBefore = pane.frameCount()
  // Hold the acks, then force more repaints than the pane has credits (2): the first
  // two frames are really SENT, the rest are coalesced into the pending View.
  // A held gate must always carry a fallback release: a failure anywhere below would
  // otherwise leave the fixture stalled.
  t.after(() => pane.releaseAcks())
  pane.holdAcks()
  // Force more repaints than the pane has credits (2) through props that really change
  // the Reader's frame — a resize no longer does (the sheet is width-independent, and one
  // long-lived node means an unchanged View sends no op at all).
  for (const notice of ['stall-1', 'stall-2', 'stall-3', 'stall-4']) {
    m.handle.setLoadError(notice)
    await settle(40)
  }
  const sentWhileStalled = pane.frameCount()
  // A real `End` on the Reader: the presenter asks the Surface to scroll the body of
  // the frame it currently holds — one of the frames the credit never sent.
  pane.key('\u001b[F')
  await settle(30)
  // One more repaint replaces the pending View BEFORE the credit is released.
  m.handle.setLoadError('stall-5')
  await settle(40)
  pane.releaseAcks()
  await settle(80)
  const frames = pane.frames()
  // A wire `add` carries a whole SUBTREE (the node's `id` plus its nested `c`
  // children), so every delivered id is collected by walking it.
  const delivered = new Set<string>()
  const collect = (node: { id?: unknown; c?: unknown }): void => {
    if (typeof node.id === 'string') delivered.add(node.id)
    if (Array.isArray(node.c)) for (const child of node.c) collect(child as { id?: unknown; c?: unknown })
  }
  for (const frame of frames) {
    for (const op of frame.ops) if (op[0] === 'add') collect(op[4] as { id?: unknown; c?: unknown })
  }
  const queued = scrollOps(pane)
  const stale = queued.filter((entry) => !delivered.has(entry.id))
  const deliveredBodies = [...delivered].filter((id) => id.includes('model-details-body'))
  t.diagnostic(`credit stall: ${sentBefore} frames sent before the hold, ${sentWhileStalled - sentBefore} spent credits, `
    + `${pane.frameCount()} sent after the release; delivered bodies ${JSON.stringify(deliveredBodies)}; `
    + `queued scroll ${JSON.stringify(queued[0])}`)
  // The prefix of the stall: the pane's two credits are spent, then nothing more is
  // sent until the acks are released and the coalesced frame goes out.
  assert.equal(sentWhileStalled, sentBefore + 2, `exactly the pane's two credits were spent before the stall (${sentBefore} -> ${sentWhileStalled})`)
  assert.ok(pane.frameCount() > sentWhileStalled, `releasing the acks really sent the coalesced frame (${sentWhileStalled} -> ${pane.frameCount()})`)
  assert.equal(queued.length, 1, `the Reader key really queued exactly one scroll op: ${JSON.stringify(queued)}`)
  assert.ok(deliveredBodies.length >= 1, `the bodies of the revisions the client really received are on the wire: ${JSON.stringify(deliveredBodies)}`)
  // The identity fix, asserted positively: the scrolled body is one the client really
  // received (its id is long-lived, so a coalesced View cannot retire it), and every
  // delivered scroll op names such a body.
  assert.equal(deliveredBodies.includes(queued[0]!.id), true,
    `the scrolled body IS one the client received: ${queued[0]!.id} vs ${JSON.stringify(deliveredBodies)}`)
  assert.equal(stale.length, 0, `every scroll op names a body the client received: ${JSON.stringify(queued)} vs ${delivered.size} delivered node id(s)`)
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
  // Entered from the narrow catalogue, then resized INTO a wide pane while the
  // Reader is open: the page must survive and still return to the catalogue.
  await resize(pane, 100)
  await enterDetails(pane)
  const facts = readerFacts(pane)
  const model = facts.get('reader-model')
  await resize(pane, WIDE_COLS)
  await waitUntil('the Reader survives the resize', () =>
    inDetails(pane) && props(pane).title === undefined)
  assert.deepEqual(readerFacts(pane), facts, 'the Reader shows the same facts at the new width')
  await backFromDetails(pane)
  await waitUntil('Back returns to the catalogue it came from', () => onCatalogue(pane))
  // And the wide card path returns to the model list.
  action(pane, 'back')
  await waitUntil('back on the list', () => onCatalogue(pane))
  await openDetails(pane)
  assert.equal(readerValue(pane, 'reader-model'), model, 'the same model is still described')
  await backToCatalogue(pane)
  m.handle.close()
})

test('native Model: one reading keeps its Reader identity, and a foreign frame cannot act', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await openDetails(pane)
  const readerBack = readerBackNode(pane).id
  const readerBody = readerBodyNode(pane)?.id
  // A re-render WITHIN one reading must not move the Reader's ids: a per-frame key made the
  // client remount the container, which lost its scroll position and retired the app's own
  // scroll target (the runtime-gap record's F3-004).
  m.handle.setLoadError('a repaint inside the same reading')
  await settle(30)
  assert.equal(readerBackNode(pane).id, readerBack, 'a re-render keeps the reading identity')
  assert.equal(readerBodyNode(pane)?.id, readerBody, 'and its scroll-container identity')
  // The fence that replaced the per-frame ids, on the page that has no action bar: an
  // event addressed to a frame this pane never built is simply not in `targets`.
  sendActivate(pane, 'row-that-does-not-exist', 'layer.model-999')
  clickNodeById(pane, 'layer.model-999')
  await settle(30)
  assert.equal(inDetails(pane), true, 'a foreign frame cannot navigate the Reader')
  assert.equal(picker(pane), undefined, 'and it cannot page the surface away either')
  // The CURRENT frame's Back row still works, so the negatives above are not vacuous.
  await backToCatalogue(pane)
  m.handle.close()
})

test('native Model: a scroll queued by a CLOSED Reader cannot address the next reading', async (t) => {
  // The reviewer's cross-reading boundary: the SDK queues a `Surface.scroll()` op while the
  // frame credit is blocked, so an op queued by one Reader can be delivered after the app has
  // left it and opened the NEXT one. Both readings are the same page of the same panel, so
  // nothing about the page tells them apart — the IDENTITY has to, which is what the Reader's
  // own epoch is for. (The scripted pane cannot show the client rejecting an unknown id; this
  // asserts the wire fact that makes the rejection possible.)
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await openDetails(pane)
  const firstBody = readerBodyNode(pane)?.id
  assert.equal(typeof firstBody, 'string', 'the first reading has a scroll container')
  // A held gate must always carry a fallback release.
  t.after(() => pane.releaseAcks())
  pane.holdAcks()
  // Holding the acks does NOT by itself spend the pane's credits: drive more repaints than
  // the pane has credits (2) through props that really change the Reader's frame, so the
  // first two are SENT and everything after them is coalesced into the pending View. Without
  // this the Scroll below would simply go out and the test would prove nothing about the
  // queue.
  const sentBefore = pane.frameCount()
  // Two catalogues alternate, so every step really changes the Reader's frame and the phase
  // stays `ready` (a failed read would make the catalogue refuse the Enter below for reasons
  // that have nothing to do with the queue).
  for (const next of [twinEffortDirectory, directory, twinEffortDirectory]) {
    m.handle.setDirectory(next)
    await settle(40)
  }
  const sentWhileStalled = pane.frameCount()
  assert.equal(sentWhileStalled, sentBefore + 2,
    `exactly the pane's two credits were spent before the stall (${sentBefore} -> ${sentWhileStalled})`)
  // The stall is REAL now: `End` on the first reading can only be queued, and nothing more is
  // sent until the acks are released.
  pane.key('\u001b[F')
  await settle(30)
  assert.equal(pane.frameCount(), sentWhileStalled,
    `the Reader key cannot be sent while the credit is blocked (${sentWhileStalled} -> ${pane.frameCount()})`)
  // Leave the Reader and open a NEW one while the acks are still held, so the queued op can
  // only flush together with the next reading's first View.
  pane.key('\u001b')
  await settle(30)
  pane.key('\r')
  await settle(30)
  assert.equal(pane.frameCount(), sentWhileStalled, 'and the Reader switch is coalesced too')
  pane.releaseAcks()
  await settle(80)
  assert.ok(pane.frameCount() > sentWhileStalled, 'releasing the acks really sent the pending View')
  assert.equal(inDetails(pane), true, 'the next reading is the page after the flush')
  const secondBody = readerBodyNode(pane)?.id
  assert.equal(typeof secondBody, 'string', 'and it has a scroll container of its own')
  assert.notEqual(secondBody, firstBody, 'a NEW reading takes a NEW identity')
  const queued = scrollOps(pane)
  assert.equal(queued.some((entry) => entry.id === secondBody), false,
    `no op queued by the closed reading addresses this one: ${JSON.stringify(queued)} vs ${JSON.stringify(secondBody)}`)
  // Positive control: this reading's own keys still scroll its own body.
  const before = scrollOps(pane).length
  pane.key('\u001b[F')
  await waitUntil('the current reading scrolls', () => scrollOps(pane).length > before)
  assert.equal(scrollOps(pane).at(-1)?.id, secondBody, 'and they address THIS reading')
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
  await waitUntil('the failure is on the Reader', () => carriesText(pane, 'catalog is unreachable'))
  const failedQuiet = scrollOps(pane).length
  pane.key('\u001b[F')
  await waitUntil('the Reader still scrolls under a failed read',
    () => scrollOps(pane).length === failedQuiet + 1)
  await backFromDetails(pane)
  await waitUntil('back on the catalogue', () => onCatalogue(pane))
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
    onCatalogue(pane) && props(pane).state === 'loading')
  // The other phase admission is unchanged: a running read still refuses every
  // browse and every write.
  assert.equal(props(pane).query, '', 'and it did not turn the key into a search edit')
  m.handle.close()
})
