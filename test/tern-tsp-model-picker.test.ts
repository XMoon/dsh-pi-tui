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
// The fact-row readability rule (the assertion reads the wire's own values and
// only the bound from the shared implementation).
import { displayWidth, factLineColumns } from '../src/tui/tsp/picker-text.ts'
import {
  ALL_SCOPES_ID,
  OVERVIEW_DETAILS_ID,
  OVERVIEW_NO_EFFORT_ID,
  effortItemId,
  scopeId,
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

test('production /model: a pane with the picker but without native Rows/Cards still refuses', async t => {
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
  const before = picker(pane)?.id
  sendResize(pane, cols)
  await waitUntil('the resized frame is committed', () => picker(pane)?.id !== before)
}

// The wire observation helpers: the REAL reconciled node tree of the frames.
import {
  cardNode,
  clickNode as click,
  layerNodes,
  pickerAction as actionOf,
  pickerNode as picker,
  pickerProps as props,
  rowNode as clickRow,
  sendAction as action,
  sendActivate,
  sendResize,
  sendSelect as browse,
  hasEffortCard,
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

/** Every `detail` of the rows carrying one id prefix, joined without whitespace
 *  (the fact-row contract: the COMPLETE value is what must be readable). */
function joinedDetail(pane: TspPane, prefix: string): string {
  return ((props(pane).items ?? []) as Array<Record<string, unknown>>)
    .filter((item) => String(item.id).startsWith(prefix))
    .map((item) => String(item.detail))
    .join('')
    .replace(/\s+/g, '')
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

/** A compact model list (or a bounded wide column) opens the highlighted model's
 *  Overview with Enter / its card click — never a write. */
async function enterOverview(pane: TspPane): Promise<void> {
  pane.key('\r')
  await waitUntil('the model Overview', () => props(pane).title === 'Model overview')
}

/** Open the read-only Full details page however the CURRENT layout offers it:
 *  the full wide card, or the Overview's own details row (compact, and the wide
 *  bounded column that enters the Overview first). */
async function openDetails(pane: TspPane): Promise<void> {
  if (props(pane).title !== 'Model overview') {
    if (props(pane).size === 'lg') {
      click(pane, cardNode(pane, 'model-details'))
      await waitUntil('a page opened from the card', () => props(pane).title !== 'Models')
    } else {
      await enterOverview(pane)
    }
  }
  if (props(pane).title === 'Model overview') {
    await walkList(pane, OVERVIEW_DETAILS_ID)
    pane.key('\r')
  }
  await waitUntil('the read-only Full details page', () => props(pane).title === 'Full model details')
}

/** The `▸` focus cue of one action bar entry, per pane. */
function focusCue(pane: TspPane, id: string): boolean {
  return String(actionOf(pane, id)?.label).startsWith('▸')
}

/** Leave whatever content page is open until the model list is the page again. */
async function backToModels(pane: TspPane): Promise<void> {
  for (let step = 0; step < 3 && props(pane).title !== 'Models'; step += 1) {
    action(pane, 'back')
    await settle(20)
  }
  await waitUntil('back on the model list', () => props(pane).title === 'Models')
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

/* --------------------------------------------------------------- Models (lg) */

test('native Model: the wide shell browses, drafts inline and writes once from the explicit action', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Open-time subject: the title stays short, the subject owns its own slot, and
  // a sessionless subject never paints a current row.
  assert.equal(props(pane).title, 'Models')
  assert.equal(props(pane).subtitle, 'Default model')
  assert.deepEqual(props(pane).current, [], 'sessionless never fabricates a current badge')
  // Wide: the native side preview + provider scopes are requested, and the ONE
  // write names what it really does.
  assert.equal(props(pane).size, 'lg')
  assert.equal(props(pane).preview, 'side')
  assert.equal(props(pane).focus, 'list')
  assert.ok(Array.isArray(props(pane).scopes))
  const badScope = (props(pane).scopes as Array<Record<string, unknown>>)
    .find((entry) => entry.id === 'scope:bad')
  assert.equal(badScope?.dot, 'error')
  assert.equal(badScope?.disabled, 'Provider unavailable')
  assert.equal(actionOf(pane, 'apply')?.label, 'Save default', 'the button names the real operation')
  // Browsing a row changes the browse object only.
  browse(pane, SAME_B)
  await waitUntil('provider B', () => props(pane).selected === SAME_B)
  assert.equal(m.writes.length, 0, 'row activation is browsing only at the wide list')
  // A provider scope filters (browse state); it is never a write. The SDK
  // delivers a scope-column click as an ACTION (`act:'scope'`), never as a row
  // select — see the dedicated protocol-shape regression below.
  action(pane, 'scope', 'scope:a')
  await waitUntil('scope filters', () => props(pane).scope === 'scope:a')
  assert.equal(m.writes.length, 0, 'a scope click is never a write')
  action(pane, 'scope', ALL_SCOPES_ID)
  await waitUntil('scope clears', () => props(pane).scope === ALL_SCOPES_ID)
  browse(pane, SAME_A)
  await waitUntil('provider A', () => props(pane).selected === SAME_A)
  // The wide column's inline radio rows ARE the effort selector: a click only
  // changes the local draft.
  assert.ok(hasEffortCard(pane), 'the wide column keeps its inline radio rows')
  assert.equal(clickRow(pane, 'effort-high').p.mark, 'pick', 'the configured draft is marked')
  click(pane, clickRow(pane, 'effort-low'))
  await waitUntil('the click drafted Low', () => clickRow(pane, 'effort-low').p.mark === 'pick')
  assert.equal(detailOf(pane, SAME_A), 'A · Low', 'the highlighted row states the NEW draft')
  assert.equal(m.writes.length, 0, 'a radio row never writes')
  // Tab reaches the explicit Primary Action; Enter then commits exactly once.
  pane.key('\t')
  await waitUntil('primary focused', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\r')
  await waitUntil('one admitted write', () => m.writes.length === 1)
  assert.deepEqual(m.writes, [{ provider: 'a', model: 'same', reasoningEffort: 'low' }])
})

test('native Model: a REAL scope action filters, and a scope-shaped row select never does', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  const itemIds = (): string[] => rowIds(pane)
  // S01: the SDK delivers a scope-column click on the ACTION channel as
  // `action { act:'scope', value:<scope id> }`. The positive control runs first,
  // so every negative below refuses an event the harness really dispatched.
  assert.deepEqual(itemIds(), [SAME_A, SAME_B], 'both providers are listed')
  assert.ok(
    (props(pane).scopes as Array<Record<string, unknown>>)
      .some((entry) => entry.id === 'scope:a' && entry.count === 1),
    'the wide picker really advertises the provider scopes',
  )
  action(pane, 'scope', 'scope:a')
  await waitUntil('the provider scope filters', () => props(pane).scope === 'scope:a')
  assert.deepEqual(itemIds(), [SAME_A], 'only the provider A row survives the filter')
  assert.equal(m.writes.length, 0, 'choosing a provider scope is never a write')
  action(pane, 'scope', ALL_SCOPES_ID)
  await waitUntil('every provider comes back', () => props(pane).scope === ALL_SCOPES_ID)
  assert.deepEqual(itemIds(), [SAME_A, SAME_B], 'clearing the filter restores every provider')
  assert.equal(m.writes.length, 0)
  // S02: a row `select` carrying a scope-shaped id is NOT a scope click. The
  // scope column owns its own channel; keeping the old shape alive would leave a
  // second, unfrozen entry point into the filter next to the official one.
  browse(pane, 'scope:b')
  await settle(30)
  assert.equal(props(pane).scope, ALL_SCOPES_ID, 'a scope-looking row select never filters')
  assert.equal(m.writes.length, 0)
  // S03: a scope action that names nothing real fails closed — an unknown
  // provider, a provider whose read FAILED (its scope is disabled), a value that
  // is not a scope id at all, and a missing value.
  for (const value of ['scope:bad', 'scope:nope', 'not-a-scope', undefined]) {
    action(pane, 'scope', value)
  }
  await settle(30)
  assert.equal(props(pane).scope, ALL_SCOPES_ID, 'unknown, disabled and valueless scopes never filter')
  assert.equal(m.writes.length, 0)
  // The CONTENT pages carry NO scope column, so only a stale or hostile receiver
  // can send one there: it must not filter either.
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  await enterOverview(pane)
  assert.equal(props(pane).preview, 'none', 'the Overview is a content page with no preview')
  assert.equal(props(pane).scopes, undefined, 'the Overview advertises no scope column')
  action(pane, 'scope', 'scope:a')
  await settle(30)
  await walkList(pane, OVERVIEW_DETAILS_ID)
  pane.key('\r')
  await waitUntil('the read-only details page', () => props(pane).title === 'Full model details')
  assert.equal(props(pane).scopes, undefined, 'the details page advertises no scope column either')
  action(pane, 'scope', 'scope:b')
  await settle(30)
  pane.key('\u001b')
  await waitUntil('Esc returns to the Overview it came from', () => props(pane).title === 'Model overview')
  action(pane, 'back')
  await waitUntil('back on the model list', () => props(pane).title === 'Models')
  assert.equal(props(pane).scope, undefined, 'the compact list renders no scope column at all')
  await resize(pane, 130)
  await waitUntil('wide again', () => props(pane).size === 'lg')
  assert.equal(props(pane).scope, ALL_SCOPES_ID, 'a scope action from a content page never filtered')
  assert.equal(m.writes.length, 0)
  // The PHASE fence: neither a running (re-)read nor a failed read admits a
  // browse mutation, so a scope action there changes nothing.
  m.handle.setLoading()
  await waitUntil('the re-read runs', () => props(pane).state === 'loading')
  action(pane, 'scope', 'scope:a')
  await settle(30)
  assert.equal(props(pane).scope, ALL_SCOPES_ID, 'a loading panel admits no scope filter')
  await m.ready()
  m.handle.setLoadError('catalog is unreachable')
  await waitUntil('the read failed', () => props(pane).state === 'error')
  action(pane, 'scope', 'scope:b')
  await settle(30)
  assert.equal(props(pane).scope, ALL_SCOPES_ID, 'a failed read admits no scope filter')
  assert.equal(m.writes.length, 0)
  m.handle.close()
  // An ADMITTED write owns the panel: a scope action while it settles changes
  // nothing either.
  const writing = await mounted(t)
  await writing.ready()
  const wp = writing.pane
  // Shift+Tab wraps the ring straight to the Primary Action while the page stays
  // the model list, so the scope props are still on screen for the fence below.
  wp.key('\u001b[Z')
  await waitUntil('primary action focused', () => String(actionOf(wp, 'apply')?.label).startsWith('▸'))
  wp.key('\r')
  await waitUntil('the write is admitted', () => actionOf(wp, 'apply')?.label === 'Selecting…')
  action(wp, 'scope', 'scope:a')
  await settle(30)
  assert.equal(actionOf(wp, 'apply')?.label, 'Selecting…', 'the admitted write still owns the panel')
  assert.equal(props(wp).scope, ALL_SCOPES_ID, 'a pending panel admits no scope filter')
  assert.equal(writing.writes.length, 1, 'a scope action during a write never becomes a second write')
  writing.settleWrite('rejected')
  await settle(30)
  writing.handle.close()
})

test('native Model K2: Enter writes ONLY from the focused Primary Action', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Zone `models`: Enter focuses the wide Model Details card — it never writes.
  pane.key('\r')
  await waitUntil('details card zone', () =>
    props(pane).focus === 'preview' && props(pane).title === 'Models')
  assert.equal(m.writes.length, 0, 'Enter on the model list is not a write')
  // Zone `detail-card`: Tab reaches the inline effort selector, then the bar.
  pane.key('\t')
  await waitUntil('inline effort zone', () => props(pane).focus === 'preview')
  const lowBeforeWrite = clickRow(pane, 'effort-low')
  pane.key('\t')
  await waitUntil('primary zone', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  assert.equal(
    actionOf(pane, 'apply')?.label,
    '▸ Save default',
    'the focused Primary Action changes shape (visible, color-free focus)',
  )
  pane.key('\r')
  await waitUntil('write from the primary action', () => m.writes.length === 1)
  // A pending seat refuses every further mutation and every further write.
  action(pane, 'apply')
  click(pane, lowBeforeWrite)
  pane.key('\t')
  pane.key('\r')
  await settle(30)
  assert.equal(m.writes.length, 1, 'pending refuses a repeated apply and draft edits')
  assert.equal(actionOf(pane, 'apply')?.label, 'Selecting…')
  assert.equal(actionOf(pane, 'apply')?.disabled, true)
})

test('native Model: the action bar per page and phase offers only what it can run', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  assert.equal(props(pane).size, 'lg', 'the default pane is wide')
  // The wide model list: the ONE write plus its way out plus the partial-failure
  // Retry (this fixture has one failed provider). The write is NEVER a vague
  // `Confirm` and never a multi-entry menu.
  assert.deepEqual(actionIds(pane), ['close', 'retry', 'apply'])
  assert.deepEqual(actionLabels(pane), ['Cancel', 'Retry', 'Save default'])
  // The Overview is the model's own actionable page: the frozen footer cap is
  // `Back` + the ONE write — no `Cancel` (a user leaves with Back/Esc and
  // cancels from the model list).
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  assert.deepEqual(actionIds(pane), ['close', 'retry'], 'the compact model list commits nothing')
  await enterOverview(pane)
  assert.deepEqual(actionIds(pane), ['back', 'apply'])
  assert.deepEqual(actionLabels(pane), ['Back', 'Save default'])
  assert.equal(actionOf(pane, 'close'), undefined, 'the Overview footer carries no Cancel')
  // The read-only Full details page is Back ALONE: no cancel entry, no write.
  await walkList(pane, OVERVIEW_DETAILS_ID)
  pane.key('\r')
  await waitUntil('details page', () => props(pane).title === 'Full model details')
  assert.deepEqual(actionIds(pane), ['back'])
  assert.deepEqual(actionLabels(pane), ['Back'])
  assert.equal(actionOf(pane, 'close'), undefined, 'the read-only page footer carries no Cancel')
  assert.equal(actionOf(pane, 'apply'), undefined, 'the read-only page carries no write')
  // The panel's own dismissal authority stays ADMITTED there (the client's
  // backdrop gesture is the same intent Esc uses), it is just not a button.
  action(pane, 'close')
  await waitUntil('a backdrop-style close still dismisses the panel', () => picker(pane) === undefined)
  m.handle.close()
  // A LIVE subject names the same action differently: it switches the Session.
  const live = await mounted(t, { sessionless: false })
  await live.ready()
  assert.equal(actionOf(live.pane, 'apply')?.label, 'Switch')
  assert.equal(actionOf(live.pane, 'apply')?.primary, true)
  live.handle.close()
})

test('native Model: a compact model-list row opens THAT row Overview atomically', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  assert.equal(props(pane).preview, 'none', 'the compact list never depends on the preview region')
  // Arrow keys only move the highlight: they must never page the surface.
  pane.key('\u001b[B')
  await waitUntil('the highlight moved', () => props(pane).selected !== SAME_A)
  assert.equal(props(pane).title, 'Models', 'an arrow never opens a page')
  assert.equal(m.writes.length, 0)
  // A row SELECT enters the Overview of the row it really names — the click on
  // an ALREADY selected row (`activate`) resolves the same way.
  browse(pane, SAME_B)
  await waitUntil('the Overview of B', () =>
    props(pane).title === 'Model overview' && joinedDetail(pane, 'overview-provider') === 'B(b)')
  assert.equal(m.writes.length, 0, 'opening the Overview never writes')
  action(pane, 'back')
  await waitUntil('back on the model list', () => props(pane).title === 'Models')
  const staleFrame = picker(pane)!.id
  sendActivate(pane, SAME_A)
  await waitUntil('activate opens the Overview of A', () =>
    props(pane).title === 'Model overview' && joinedDetail(pane, 'overview-provider') === 'A(a)')
  // A frame that is already retired can never re-open or re-target a page.
  const before = picker(pane)!.id
  browse(pane, SAME_B, staleFrame)
  await settle(30)
  assert.equal(picker(pane)!.id, before, 'the retired receiver is never routed')
  assert.equal(joinedDetail(pane, 'overview-provider'), 'A(a)', 'the page still describes the row it opened')
})

test('native Model: the Overview lists the identity, the details entry and every candidate', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  await enterOverview(pane)
  // The page's MAIN LIST rows: the complete identity facts, the single operation
  // row, then the model's own candidates (the configured draft marked). A detail
  // longer than the row's one-line slot continues on its own row.
  assert.deepEqual(rowIds(pane), [
    'overview-model',
    'overview-provider',
    'overview-id',
    'fact-default',
    'fact-default-2',
    OVERVIEW_DETAILS_ID,
    effortItemId('\u0000provider-default'),
    effortItemId('low'),
    effortItemId('high'),
  ])
  assert.equal(joinedDetail(pane, 'overview-model'), 'Twin')
  assert.equal(joinedDetail(pane, 'overview-provider'), 'A(a)')
  assert.equal(joinedDetail(pane, 'overview-id'), 'same')
  const candidate = (id: string): Record<string, unknown> | undefined =>
    ((props(pane).items ?? []) as Array<Record<string, unknown>>).find((item) => String(item.id) === id)
  assert.equal((candidate(effortItemId('high'))?.mark as { text?: string } | undefined)?.text, '●')
  assert.equal((candidate(effortItemId('low'))?.mark as { text?: string } | undefined)?.text, '○')
  // The keyboard walks EVERY row — the long identity lines are readable, not
  // skipped in favour of the draft.
  assert.equal(props(pane).selected, 'overview-model', 'the cursor starts on the first row')
  pane.key('\r')
  await settle(30)
  assert.equal(props(pane).title, 'Model overview', 'Enter on a static fact row is inert')
  assert.equal(m.writes.length, 0)
  // An effort row drafts and nothing else.
  await walkList(pane, effortItemId('low'))
  pane.key('\r')
  await waitUntil('the effort row drafted Low', () =>
    (candidate(effortItemId('low'))?.mark as { text?: string } | undefined)?.text === '●')
  assert.equal(m.writes.length, 0, 'an effort row never writes')
  assert.equal(props(pane).title, 'Model overview', 'a candidate row never leaves the page')
  // The details entry opens the read-only page.
  await walkList(pane, OVERVIEW_DETAILS_ID)
  pane.key('\r')
  await waitUntil('details from the Overview', () => props(pane).title === 'Full model details')
  // A pointer activation on the same rows resolves the same way.
  action(pane, 'back')
  await waitUntil('back on the Overview', () => props(pane).title === 'Model overview')
  browse(pane, effortItemId('high'))
  await waitUntil('the pointer row drafted High', () =>
    (candidate(effortItemId('high'))?.mark as { text?: string } | undefined)?.text === '●')
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
  await waitUntil('the effort row drafted Low', () =>
    ((props(pane).items ?? []) as Array<Record<string, unknown>>)
      .some((item) => String(item.id) === effortItemId('low')
        && (item.mark as { text?: string } | undefined)?.text === '●'))
  assert.equal(m.writes.length, 0, 'choosing a draft never writes')
  // The ring is list <-> bar on a content page: one Tab reaches the write.
  pane.key('\t')
  await waitUntil('the Overview primary is focused', () => actionOf(pane, 'apply')?.label === '▸ Switch')
  pane.key('\r')
  await waitUntil('one admitted write', () => m.writes.length === 1)
  assert.deepEqual(m.writes, [{ provider: 'a', model: 'same', reasoningEffort: 'low' }])
})

test('native Model: the wide details card opens the read-only page and Back returns', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Prepare browse state that must survive the round trip.
  action(pane, 'scope', 'scope:a')
  await waitUntil('scope A', () => props(pane).scope === 'scope:a')
  const rowDetailBefore = detailOf(pane, SAME_A)
  // The card is a real pointer target with its own handler; its head carries the
  // `›` affordance.
  assert.equal(cardNode(pane, 'model-details').p.head, 'Twin ›')
  click(pane, cardNode(pane, 'model-details'))
  await waitUntil('the read-only details page', () => props(pane).title === 'Full model details')
  assert.equal(props(pane).preview, 'none', 'a content page has no side preview')
  assert.equal(props(pane).scopes, undefined, 'a content page has no scope column')
  assert.equal(actionOf(pane, 'apply'), undefined, 'the read-only page has no write')
  // A forged apply from this page is refused on the wire.
  action(pane, 'apply')
  await settle(30)
  assert.equal(m.writes.length, 0, 'a forged apply on the read-only page is refused')
  assert.equal(props(pane).title, 'Full model details', 'and it cannot navigate either')
  action(pane, 'back')
  await waitUntil('back on the model list', () => props(pane).title === 'Models')
  assert.equal(props(pane).scope, 'scope:a', 'the scope survived the round trip')
  assert.equal(props(pane).selected, SAME_A, 'the highlight survived too')
  assert.equal(detailOf(pane, SAME_A), rowDetailBefore, 'and so did the drafted effort')
  // The keyboard path is the same page: Tab reaches the details-card zone and
  // Enter opens it; Esc returns to the model list.
  pane.key('\t')
  await waitUntil('the details card zone', () => props(pane).focus === 'preview')
  pane.key('\r')
  await waitUntil('details from the keyboard', () => props(pane).title === 'Full model details')
  pane.key('\u001b')
  await waitUntil('Esc returns to the model list', () => props(pane).title === 'Models')
  assert.equal(props(pane).focus, 'list')
})

test('native Model: the compact model list and the details page never offer a write', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  assert.equal(actionOf(pane, 'apply'), undefined, 'the compact model list commits nothing')
  const listFrame = picker(pane)!.id
  action(pane, 'apply')
  await settle(30)
  assert.equal(m.writes.length, 0, 'a forged apply on the compact list is refused')
  assert.equal(picker(pane)!.id, listFrame, 'and it cannot even re-render the list')
  await openDetails(pane)
  assert.equal(actionOf(pane, 'apply'), undefined, 'the details page commits nothing')
  const detailsFrame = picker(pane)!.id
  action(pane, 'apply')
  await settle(30)
  assert.equal(m.writes.length, 0, 'a forged apply on the details page is refused')
  assert.equal(picker(pane)!.id, detailsFrame, 'and it cannot navigate either')
  // Only the Overview carries the write back, and it is the same one writer.
  action(pane, 'back')
  await waitUntil('back on the Overview', () => props(pane).title === 'Model overview')
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
    // A model with no advertised efforts has the ring list -> details card ->
    // bar: Shift+Tab wraps straight onto the Primary Action.
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
      assert.match(sheetText(pane), /(Rejected|Cancelled|Unsupported)\./)
      assert.equal(props(pane).title, 'Models', 'a refusal leaves the page the user was on usable')
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
  await waitUntil('drafted Low', () => props(pane).title === 'Model overview')
  pane.key('\t')
  await waitUntil('the Overview primary is focused', () => actionOf(pane, 'apply')?.label === '▸ Switch')
  pane.key('\r')
  await waitUntil('the write is admitted', () => m.writes.length === 1)
  m.settleWrite('rejected')
  await waitUntil('the refusal clears pending', () => props(pane).state === 'ready')
  // The Overview is still the page, and the draft it shows is the one chosen.
  assert.equal(props(pane).title, 'Model overview')
  assert.equal(props(pane).focus, 'list', 'the keyboard is back on the list, so Enter cannot repeat the write')
  assert.equal(
    ((props(pane).items ?? []) as Array<Record<string, unknown>>)
      .find((item) => String(item.id) === effortItemId('low'))?.mark !== undefined,
    true,
  )
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

test('native Model: resize keeps the panel and the compact pages stay reachable', async (t) => {
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
  // Wide -> compact: the same panel switches to the drill-down layout. The
  // compact model list is `preview: 'none'` and carries the subject on its strip.
  await resize(pane, 100)
  await waitUntil('compact layout', () => props(pane).size === 'md' && props(pane).preview === 'none')
  assert.ok(!props(pane).scopes, 'compact has no scope column (the SDK nulls the prop)')
  assert.equal(
    (props(pane).items as Array<Record<string, unknown>>).some((item) => item.disabled !== undefined),
    false,
    'a directory without failed providers lists none',
  )
  assert.equal((props(pane).strip as { label?: string } | undefined)?.label, 'Default model')
  // Details is a compact PAGE of the same picker, not an overlay.
  await enterOverview(pane)
  await walkList(pane, OVERVIEW_DETAILS_ID)
  pane.key('\r')
  await waitUntil('details page', () => props(pane).title === 'Full model details')
  assert.equal(nodes(pane).some((n) => n.k === 'overlay'), false, 'no overlay is used')
  const facts = props(pane).items as Array<Record<string, unknown>>
  assert.equal(
    facts.find((item) => item.label === 'Description')?.detail,
    'Note.',
    'the details page carries the real description',
  )
  // Its static fields are inert: Enter cannot write from them.
  pane.key('\r')
  await settle(20)
  assert.equal(m.writes.length, 0, 'static detail rows never write')
  // Back restores the Overview; the effort candidate is chosen THERE now.
  action(pane, 'back')
  await waitUntil('back to the Overview', () => props(pane).title === 'Model overview')
  pane.key('\u001b[B')
  await waitUntil('draft moved to the provider default', () =>
    props(pane).selected === effortItemId('\u0000provider-default'))
  assert.equal(m.writes.length, 0, 'choosing a draft never writes')
  pane.key('\r')
  await waitUntil('the candidate took the draft', () => props(pane).title === 'Model overview')
  pane.key('\t')
  await waitUntil('the Overview primary is focused', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\r')
  await waitUntil('write from the compact primary action', () => m.writes.length === 1)
  assert.deepEqual(
    m.writes,
    [{ provider: 'p', model: 'm' }],
    'the provider-default draft submits WITHOUT a reasoningEffort literal',
  )
  // A refusal re-enables the panel with the chosen draft intact, and the draft
  // survives the flip back to the wide layout (readable again in the inline rows).
  m.settleWrite('rejected')
  await waitUntil('refusal restores the panel', () => props(pane).state === 'ready')
  await resize(pane, 130)
  await waitUntil('wide again', () => props(pane).size === 'lg')
  // A width flip never pages the panel on its own: the Overview the user was on
  // stays the Overview, and Back is what returns to the model list.
  assert.equal(props(pane).title, 'Model overview')
  action(pane, 'back')
  await waitUntil('the wide model list', () => props(pane).title === 'Models')
  assert.equal(
    clickRow(pane, 'effort-%00provider-default').p.mark,
    'pick',
    "the draft chosen in the compact page is the wide layout's draft",
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
  assert.equal(props(pane).scope, ALL_SCOPES_ID, 'a disabled provider scope never filters')
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
    assert.equal(props(boot.pane).subtitle, 'Default model')
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
    assert.equal(props(boot.pane).subtitle, 'Default model')
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
    assert.equal(props(boot.pane).subtitle, 'Default model')
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
    assert.match(String(props(fixture.pane).subtitle), /Session model/)
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
    // The wide shell is kept, and the FULL facts stay readable through the
    // read-only details page the card opens.
    assert.equal(props(fixture.pane).size, 'lg', 'the wide shell is kept')
    assert.equal(props(fixture.pane).preview, 'side', 'the details column is kept')
    click(fixture.pane, cardNode(fixture.pane, 'model-details'))
    await waitFor('details page', () => props(fixture.pane).title === 'Full model details')
    const facts = props(fixture.pane).items as Array<{ id?: string; label?: string; detail?: string }>
    // Every fact value is wrapped into complete rows, so a value longer than the
    // row bound continues on its own rows; the FULL value is what must be read.
    const current = facts.filter((item) => String(item.id).startsWith('fact-current'))
    assert.equal(current[0]?.label, 'Current')
    assert.equal(
      current.map((item) => item.detail).join('').replace(/\s+/g, ''),
      `scripted/${DIRECT_TSP_MODEL_TWO}`,
      'the details page reads the new Current from the Session',
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
  await waitUntil('back on the model list', () => sheetText(pane).includes('Tab: details'))
  assert.equal(props(pane).focus, 'list')
  assert.equal(m.writes.length, 0)
  // models -> details card -> Esc returns to the list, not into the card's page.
  pane.key('\t')
  await waitUntil('the details card zone', () => props(pane).focus === 'preview')
  pane.key('\u001b')
  await waitUntil('back in the model list zone', () => props(pane).focus === 'list')
  assert.equal(props(pane).title, 'Models')
  // The Overview: its bar's Esc returns to the Overview's own list, and the
  // page's Esc then returns to the model list.
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  await enterOverview(pane)
  pane.key('\t')
  await waitUntil('Overview primary', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\u001b')
  await settle(30)
  await waitUntil('still on the Overview', () => props(pane).title === 'Model overview')
  pane.key('\u001b')
  await waitUntil('back on the model list', () => props(pane).title === 'Models')
  // The read-only details page returns to the page it was entered from.
  await enterOverview(pane)
  await walkList(pane, OVERVIEW_DETAILS_ID)
  pane.key('\r')
  await waitUntil('details page', () => props(pane).title === 'Full model details')
  pane.key('\u001b')
  await waitUntil('Esc returns to the Overview', () => props(pane).title === 'Model overview')
  pane.key('\u001b')
  await waitUntil('and on to the model list', () => props(pane).title === 'Models')
})

test('native Model: every visible action is keyboard reachable and never a no-op', async (t) => {
  const m = await mounted(t)
  await m.ready({
    current: undefined,
    directory: {
      default: { provider: 'a', model: 'same' },
      routableProviders: ['a'],
      groups: [{ id: 'a', name: 'A', models: [{ id: 'same', name: 'Twin' }] }],
      failures: [],
    },
  })
  const { pane } = m
  // The wide model list: the ONE write plus its way out, and nothing else.
  assert.deepEqual(actionIds(pane), ['close', 'apply'])
  assert.deepEqual(actionLabels(pane), ['Cancel', 'Save default'])
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  // The compact model list has no write at all: only its way out.
  assert.deepEqual(actionIds(pane), ['close'])
  pane.key('\t')
  await waitUntil('the compact bar owns the keyboard', () => focusCue(pane, 'close'))
  pane.key('\r')
  await waitUntil('Enter ran the focused Cancel', () => picker(pane) === undefined)
  // The Overview: Back and the one write, both keyboard reachable, and Enter on
  // the focused Back really returns.
  const second = await mounted(t)
  await second.ready({
    current: undefined,
    directory: {
      default: { provider: 'a', model: 'same' },
      routableProviders: ['a'],
      groups: [{ id: 'a', name: 'A', models: [{ id: 'same', name: 'Twin' }] }],
      failures: [],
    },
  })
  const sp = second.pane
  await resize(sp, 100)
  await waitUntil('compact again', () => props(sp).size === 'md')
  await enterOverview(sp)
  assert.deepEqual(actionIds(sp), ['back', 'apply'], 'the Overview footer is Back + the one write')
  sp.key('\t')
  await waitUntil('the Overview primary is focused', () => focusCue(sp, 'apply'))
  sp.key('\u001b[D')
  await waitUntil('Back takes the bar focus', () => focusCue(sp, 'back'))
  sp.key('\r')
  await waitUntil('Enter ran the focused Back', () => props(sp).title === 'Models')
  assert.equal(second.writes.length, 0, 'no bar action ever wrote here')
  // The read-only details page: Back alone, and Tab really reaches it.
  await openDetails(sp)
  assert.deepEqual(actionIds(sp), ['back'], 'the read-only footer is Back alone')
  sp.key('\t')
  await waitUntil('the details Back is focused', () => focusCue(sp, 'back'))
  sp.key('\r')
  await waitUntil('keyboard returned to the Overview', () => props(sp).title === 'Model overview')
  second.handle.close()
})

test('native Model: a phase whose bar no key can run carries no Enter cue', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  await m.ready()
  const focused = (id: string) => String(actionOf(pane, id)?.label).startsWith('▸')
  // PENDING: the admitted write refuses every key but Esc, so the enabled fallback
  // must NOT mark `Close` — the cue is a promise about Enter, and Enter here runs
  // nothing at all (the old fallback marked Close and then swallowed the Enter).
  pane.key('\u001b[Z')
  await waitUntil('bar focused on the primary', () => focused('apply'))
  pane.key('\r')
  await waitUntil('pending', () => actionOf(pane, 'apply')?.label === 'Selecting…')
  // While the write is admitted, closing the panel cannot cancel the operation
  // that is already with the Host, so that phase labels the action `Close`
  // instead of a `Cancel` a user would read as "undo the write".
  assert.equal(actionOf(pane, 'close')?.label, 'Close', 'an admitted write marks no action: no key can run one')
  assert.ok(!focused('apply'), 'the disabled Selecting… entry never carries the cue')
  assert.ok(!sheetText(pane).includes('←→ · Enter'), 'the hint never promises the keys the write refuses')
  pane.key('\u001b[D')
  pane.key('\r')
  await settle(30)
  assert.ok(picker(pane), 'Enter ran nothing: the panel is still open')
  assert.equal(m.writes.length, 1, 'a cued Enter must never become a second write')
  pane.key('\u001b')
  await waitUntil('Esc still closes an admitted write', () => picker(pane) === undefined)
  // LOADING: the re-read's bar can run nothing either, and the hint names the
  // read instead of promising a Tab/←→ this phase refuses.
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
  const hint = sheetText(l.pane)
  assert.ok(hint.includes('Reading…'), `the hint names the read: ${hint.slice(0, 160)}`)
  assert.ok(!hint.includes('←→ · Enter') && !hint.includes('Tab: details') && !hint.includes('Tab: effort'),
    'a running re-read promises no key it refuses')
  l.pane.key('\r')
  await settle(30)
  assert.ok(picker(l.pane), 'Enter ran nothing while the read runs')
  assert.equal(l.retries(), 1, 'no refused key can re-read twice')
  l.pane.key('\u001b')
  await waitUntil('Esc still closes a running re-read', () => picker(l.pane) === undefined)
})

test('native Model: the keyboard hint names where the keyboard goes, never a guessed action', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  await m.ready()
  // The list hint names the zone Tab reaches NEXT: the wide shell's details card.
  assert.ok(sheetText(pane).includes('Tab: details'), sheetText(pane).slice(0, 160))
  // Inside the details card the hint names what Enter opens.
  pane.key('\t')
  await waitUntil('the details card zone', () => props(pane).focus === 'preview')
  assert.ok(sheetText(pane).includes('Enter: details'), sheetText(pane).slice(0, 160))
  pane.key('\u001b')
  await waitUntil('Esc left the details card for the list', () => props(pane).focus === 'list')
  // Inside the action bar, Enter runs the action the BAR focused (the ▸ cue names
  // it): the hint must not claim it applies.
  pane.key('\u001b[Z')
  await waitUntil('bar focused on the primary', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  assert.ok(sheetText(pane).includes('←→ · Enter'), sheetText(pane).slice(0, 160))
  assert.ok(!sheetText(pane).includes('Enter: apply'), 'the hint never names a business action')
  // Focus Cancel and press Enter: the FOCUSED action runs, which is what the
  // hint promised (the bar's own cue said Cancel).
  for (let step = 0; step < 5 && !String(actionOf(pane, 'close')?.label).startsWith('▸'); step += 1) {
    pane.key('\u001b[D')
    await settle(10)
  }
  await waitUntil('Cancel takes the bar focus', () => String(actionOf(pane, 'close')?.label).startsWith('▸'))
  assert.ok(sheetText(pane).includes('←→ · Enter'), 'the hint stays true for any focused action')
  pane.key('\r')
  await waitUntil('Enter ran the focused Cancel', () => picker(pane) === undefined)
  // The details page is a CONTENT page: it renders no side column, so it carries
  // no column hint at all — and above all it must not leak the list's hint and
  // promise a Tab the page cannot honour.
  const detailsPane = await mounted(t)
  await detailsPane.ready()
  await openDetails(detailsPane.pane)
  assert.equal(props(detailsPane.pane).preview, 'none')
  const detailsText = sheetText(detailsPane.pane)
  assert.ok(!detailsText.includes('Tab: details') && !detailsText.includes('Tab: effort'),
    'the details page renders no side-column hint')
  // Its static facts still reach the keyboard's own way out: Tab lands on Back.
  detailsPane.pane.key('\t')
  await waitUntil('the details bar owns the keyboard',
    () => String(actionOf(detailsPane.pane, 'back')?.label).startsWith('▸'))
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
  // The symmetric page path: a details page under a failed read. Its page intent
  // cannot be honoured by the phase either (that would land the keyboard in the
  // inert list), so Esc closes instead of being dropped on the floor.
  const details = await mounted(t)
  await details.ready()
  await openDetails(details.pane)
  details.handle.setLoadError('catalog is unreachable')
  await waitUntil('the read failed under the details page', () => props(details.pane).state === 'error')
  assert.equal(actionOf(details.pane, 'back'), undefined, 'a failed read offers no page action')
  assert.equal(actionOf(details.pane, 'apply'), undefined, 'a failed read offers no write')
  assert.ok(actionOf(details.pane, 'retry'), 'a failed read offers the read-only Retry')
  details.pane.key('\t')
  await waitUntil('the details bar focused Retry',
    () => String(actionOf(details.pane, 'retry')?.label).startsWith('▸'))
  details.pane.key('\r')
  await waitUntil('the details page Retry ran too', () => details.retries() === 1)
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

test('native Model: the subject is complete and never the truncated title', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  assert.equal(props(pane).title, 'Models', 'the title stays short enough to never ellipsize')
  assert.equal(props(pane).subtitle, 'Default model')
  // `lg` states the subject once, in its own `subtitle` slot. No page renders a
  // global action strip any more.
  assert.equal((props(pane).strip as { label?: string } | undefined)?.label, undefined)
  assert.deepEqual((props(pane).strip as { items?: unknown[] } | undefined)?.items ?? [], [])
  await resize(pane, 100)
  await waitUntil('compact subject slot', () => props(pane).size === 'md')
  assert.equal(
    (props(pane).strip as { label?: string } | undefined)?.label,
    'Default model',
    'compact carries the subject on its own strip line',
  )
  assert.ok(!props(pane).subtitle, 'the subject is never duplicated per layout')
  assert.equal(props(pane).title, 'Models')
  const live = await mounted(t, { sessionless: false })
  await live.ready()
  assert.equal(props(live.pane).subtitle, 'Session model')
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
  // The compact model list, the Overview and the details page are the ONLY
  // pages, and none of them is a global operations menu.
  const titles = new Set<string>([String(props(pane).title)])
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  titles.add(String(props(pane).title))
  await enterOverview(pane)
  titles.add(String(props(pane).title))
  await walkList(pane, OVERVIEW_DETAILS_ID)
  pane.key('\r')
  await waitUntil('details', () => props(pane).title === 'Full model details')
  titles.add(String(props(pane).title))
  assert.deepEqual([...titles].sort(), ['Full model details', 'Model overview', 'Models'])
  // The removed wire shapes are refused even when forged.
  const frame = picker(pane)!.id
  action(pane, 'details')
  action(pane, 'effort-page')
  action(pane, 'strip', 'strip-more')
  browse(pane, 'more:details')
  await settle(30)
  assert.equal(picker(pane)!.id, frame, 'the removed surface cannot even re-render a page')
  assert.equal(m.writes.length, 0)
})

/* ------------------------------------------------------ wide preview budget */

test('native Model: the wide column keeps the shell and never pushes a candidate out', async (t) => {
  const labels = Array.from({ length: 7 }, (_, index) => `Effort ${index + 1}: ${'Long advertised effort label '.repeat(8)}`)
  const eleven = Array.from({ length: 11 }, (_, index) => `Effort ${index + 1}`)
  const wideGlyphs = Array.from({ length: 8 }, () => 'W'.repeat(34))
  const cases: ReadonlyArray<{ readonly name: string; readonly d: ModelPickerDirectory; readonly cols: number }> = [
    { name: 'seven long effort labels', d: budgetDirectory({ effortNames: labels }), cols: 1280 },
    {
      name: 'a very long provider name',
      d: budgetDirectory({
        providerName: 'Advertised provider name '.repeat(20),
        effortNames: ['Minimal', 'Low', 'Medium', 'High', 'Max', 'Ultra', 'Ultra2'],
      }),
      cols: 1280,
    },
    { name: 'eleven short efforts at 1100 columns', d: budgetDirectory({ effortNames: eleven }), cols: 1100 },
    { name: 'eight widest-glyph labels at 1100 columns', d: budgetDirectory({ effortNames: wideGlyphs }), cols: 1100 },
  ]
  for (const scenario of cases) {
    const m = await mounted(t)
    await resize(m.pane, scenario.cols)
    await m.ready(scenario.d)
    // The OWNER-FROZEN structure rule: the wide shell (provider scopes + model
    // list + details column) is KEPT; the column either shows the effort rows
    // inline or turns into the ONE entry into the model's Overview, and never
    // renders a candidate outside itself.
    assert.equal(props(m.pane).size, 'lg', `${scenario.name}: the wide shell is kept`)
    assert.equal(props(m.pane).preview, 'side', `${scenario.name}: the details column is kept`)
    const reasoning = scenario.d.directory.groups[0]!.models[0]!.reasoning
    const advertised = reasoning === undefined
      ? 0
      : reasoning.defaultEffort === undefined ? reasoning.efforts.length + 1 : reasoning.efforts.length
    const inline = hasEffortCard(m.pane)
    if (inline) {
      // Every advertised candidate is rendered as a radio row inside the column.
      const rows = layerNodes(m.pane).filter((node) => node.k === 'row' && node.id.includes('.effort-'))
      assert.equal(rows.length, advertised, `${scenario.name}: every candidate row is inline`)
      // The LAST candidate is reachable and writes through the one action.
      const last = reasoning!.efforts.at(-1)!.id
      click(m.pane, clickRow(m.pane, `effort-${last}`))
      await waitUntil(`${scenario.name}: the last candidate drafted`, () =>
        clickRow(m.pane, `effort-${last}`).p.mark === 'pick')
      m.pane.key('\t')
      await waitUntil(`${scenario.name}: the Primary Action`,
        () => String(actionOf(m.pane, 'apply')?.label).startsWith('▸'))
      m.pane.key('\r')
      await waitUntil(`${scenario.name}: the last candidate commits`, () => m.writes.length === 1)
      assert.equal(
        (m.writes[0] as { reasoningEffort?: string }).reasoningEffort,
        last,
        `${scenario.name}: the inline draft is what was written`,
      )
    } else {
      // The bounded column is ONE entry into the Overview, which lists every
      // candidate in the native main list.
      assert.equal(cardNode(m.pane, 'model-details').p.head, 'Open model & effort ›')
      click(m.pane, cardNode(m.pane, 'model-details'))
      await waitUntil(`${scenario.name}: the Overview`, () => props(m.pane).title === 'Model overview')
      const effortRows = rowIds(m.pane).filter((id) => id.startsWith('effort:'))
      assert.equal(effortRows.length, advertised, `${scenario.name}: every advertised effort is listed`)
      const lastEffort = reasoning!.efforts.at(-1)!.id
      await walkList(m.pane, effortItemId(lastEffort))
      m.pane.key('\r')
      await waitUntil(`${scenario.name}: the last candidate drafted`, () =>
        props(m.pane).title === 'Model overview')
      m.pane.key('\t')
      await waitUntil(`${scenario.name}: the Overview primary`, () =>
        String(actionOf(m.pane, 'apply')?.label).startsWith('▸'))
      m.pane.key('\r')
      await waitUntil(`${scenario.name}: the last candidate commits`, () => m.writes.length === 1)
    }
    m.handle.close()
    await waitUntil(`${scenario.name}: closed`, () => picker(m.pane) === undefined)
  }
})

test('native Model: the single summary line is exactly one line for a description or a notice', async (t) => {
  const m = await mounted(t)
  // The renderer preserves explicit line breaks, so the ONE optional summary
  // line must fold them: a three-line summary would render lines the budget
  // never priced and push the last candidate out of the column.
  const crlf = budgetDirectory({
    providerName: 'p',
    modelId: 'm',
    description: 'A\r\n\r\nB',
    effortNames: ['e1', 'e2', 'e3', 'e4', 'e5'],
  })
  await resize(m.pane, 1280)
  await m.ready(crlf)
  assert.ok(hasEffortCard(m.pane), 'the short effort set stays inline')
  const text = sheetText(m.pane)
  assert.ok(text.includes('A B'), `the explicit breaks fold into one line: ${text.slice(0, 200)}`)
  assert.ok(
    !/[\n\r\v\f\u2028\u2029]/u.test(text),
    `no rendered column text carries a raw line break: ${JSON.stringify(text.slice(0, 200))}`,
  )
  assert.equal(
    layerNodes(m.pane).filter((node) => node.k === 'row' && node.id.includes('.effort-')).length,
    5,
    'every advertised candidate stays inline',
  )
  // The notice shares the ONE-line path: a long read error used to be rendered
  // raw inside the column while the budget priced a single line.
  m.handle.setLoadError(`catalog is unreachable ${'x'.repeat(400)}`)
  await waitUntil('read error', () => props(m.pane).state === 'error')
  const notice = sheetText(m.pane)
  assert.match(notice, /catalog is/, notice.slice(0, 120))
  assert.ok(notice.includes('…'), 'the long notice is clamped, not rendered raw')
  assert.ok(!/[\n\r\v\f\u2028\u2029]/u.test(notice), JSON.stringify(notice.slice(0, 200)))
  m.handle.close()
})

test('native Model: every Details fact is complete and wrap-bounded', async (t) => {
  const m = await mounted(t, { sessionless: false })
  const longProvider = 'Advertised provider name '.repeat(20)
  const modelId = 'anthropic/claude-3.7-sonnet:thinking'
  const description = 'Long description '.repeat(35)
  await resize(m.pane, 1100)
  await m.ready(budgetDirectory({
    providerName: longProvider,
    modelId,
    description,
    effortNames: ['Minimal', 'Low', 'Medium', 'High', 'Max'],
    configuredEffort: 'high',
  }))
  await openDetails(m.pane)
  const rowsOf = (prefix: string): Array<Record<string, unknown>> =>
    (props(m.pane).items as Array<Record<string, unknown>>)
      .filter((item) => String(item.id).startsWith(prefix))
  const readable = (prefix: string): string =>
    rowsOf(prefix).map((row) => String(row.detail)).join('').replace(/\s+/g, '')
  // The row renderer ellipsizes what one row cannot show, so EVERY fact must
  // continue on its own rows until its complete value is readable.
  assert.equal(readable('fact-model'), 'BudgetModel', 'the model name')
  assert.equal(readable('fact-provider'), `${longProvider}(p)`.replace(/\s+/g, ''), 'provider and provider id')
  assert.equal(readable('fact-id'), modelId, 'the model id')
  assert.equal(readable('fact-current'), `p/${modelId}/high`, 'the live Current value')
  assert.equal(readable('fact-default'), `p/${modelId}/high`, 'the persisted Default value')
  assert.equal(readable('fact-description'), description.replace(/\s+/g, ''), 'the description')
  // The fixture's declared default id (`high`) is not one of its advertised ids,
  // so the draft seeds from the first advertised choice.
  assert.equal(readable('fact-draft'), 'Minimal', 'the draft effort')
  assert.ok(rowsOf('fact-provider').length > 1, 'a long value really continues over rows')
  const wideSlot = props(m.pane).size === 'lg'
  for (const item of props(m.pane).items as Array<Record<string, unknown>>) {
    assert.ok(
      displayWidth(String(item.detail)) <= factLineColumns(wideSlot, String(item.label)),
      `every fact row fits its own one-line slot: ${String(item.id)} :: ${String(item.detail)}`,
    )
  }
  // The write outcome is the Status fact, and it is complete there too.
  await backToModels(m.pane)
  // Shift+Tab wraps the ring straight onto the Primary Action.
  m.pane.key('\u001b[Z')
  await waitUntil('primary action focused', () => String(actionOf(m.pane, 'apply')?.label).startsWith('▸'))
  m.pane.key('\r')
  await waitUntil('pending', () => actionOf(m.pane, 'apply')?.label === 'Selecting…')
  m.settleWrite('rejected')
  await waitUntil('rejected and ready', () => props(m.pane).state === 'ready' && props(m.pane).title === 'Models')
  await openDetails(m.pane)
  assert.equal(readable('fact-notice'), 'Rejected.', 'the full write notice is readable')
  m.handle.close()
})

test('native Model: a compact fact row clips nothing, not even an unbroken glyph run', async (t) => {
  const m = await mounted(t, { sessionless: false })
  // The reviewer's compact counterexample: the SDK renders a compact fact row's
  // `detail` on ONE measured line and cannot break an unbroken run, so a bound
  // wider than the row's own slot shows an ellipsis (the old fixed 24 columns did
  // exactly that at this width).
  const providerName = `${'W'.repeat(240)} tail`
  await resize(m.pane, 100)
  await waitUntil('compact', () => props(m.pane).size === 'md')
  await m.ready(budgetDirectory({
    providerName,
    modelId: 'm',
    effortNames: ['Minimal', 'Low'],
  }))
  await openDetails(m.pane)
  const items = props(m.pane).items as Array<Record<string, unknown>>
  const provider = items.filter((item) => String(item.id).startsWith('fact-provider'))
  assert.ok(provider.length > 3, `the provider value really continues: ${provider.length}`)
  for (const item of items) {
    assert.ok(
      displayWidth(String(item.detail)) <= factLineColumns(false, String(item.label)),
      `compact fact row ${String(item.id)} fits its one-line slot: ${String(item.detail)}`,
    )
  }
  // The continuation rows are the ones the 24-column bound used to clip.
  const continuation = provider.filter((item) => String(item.label) === '')
  assert.ok(continuation.length > 2, 'the value continues on label-less rows')
  assert.ok(
    continuation.every((item) => displayWidth(String(item.detail)) <= factLineColumns(false, '')),
    'a label-less row uses the full compact row bound',
  )
  assert.equal(
    provider.map((item) => String(item.detail)).join('').replace(/\s+/g, ''),
    `${providerName} (p)`.replace(/\s+/g, ''),
    'the complete provider value is present across the rows',
  )
  m.handle.close()
})

test('native Model: the paged wide column turns into ONE Overview entry', async (t) => {
  const m = await mounted(t, { sessionless: false })
  // A long configured selection plus eight widest-glyph labels: the effort rows
  // cannot be inline, so the column becomes the bounded summary — which must
  // still be action-first (identity + hint), never a facts-only block.
  await resize(m.pane, 1100)
  await m.ready(budgetDirectory({
    providerName: 'openrouter',
    modelId: 'anthropic/claude-3.7-sonnet:thinking',
    effortNames: Array.from({ length: 8 }, () => 'W'.repeat(34)),
    configuredEffort: 'e1',
  }))
  assert.equal(props(m.pane).preview, 'side', 'the wide shell and its column are kept')
  assert.equal(hasEffortCard(m.pane), false, 'no inline effort card while the column is bounded')
  const text = sheetText(m.pane)
  assert.ok(text.includes('Provider:'), `the bounded column keeps the identity: ${text.slice(0, 200)}`)
  assert.ok(text.includes('ID:'), text.slice(0, 200))
  assert.ok(text.includes('Tab: details'), 'the bounded column keeps the keyboard hint')
  // The configured facts follow the identity (the complete values stay one page
  // away) and a truncated tail is marked.
  assert.ok(text.includes('Current:'), `the configured facts follow the identity: ${text.slice(0, 200)}`)
  assert.ok(text.includes('…'), 'a capped fact line is marked as truncated')
  // The whole card is ONE target: it opens the Overview, where every candidate
  // is listed and committed through the one explicit action.
  assert.equal(cardNode(m.pane, 'model-details').p.head, 'Open model & effort ›')
  click(m.pane, cardNode(m.pane, 'model-details'))
  await waitUntil('the bounded card opens the Overview', () => props(m.pane).title === 'Model overview')
  assert.equal(rowIds(m.pane).filter((id) => id.startsWith('effort:')).length, 8,
    'the Overview lists every advertised candidate')
  m.handle.close()
})

test('native Model: seven short-labeled candidates keep the wide preview', async (t) => {
  const m = await mounted(t)
  // Lean fields (the budget prices every character at the widest-glyph advance,
  // so a long provider/model/fact line costs lines too).
  const seven: ModelPickerDirectory = {
    current: { provider: 'p', model: 'm' },
    directory: {
      default: { provider: 'p', model: 'm' },
      routableProviders: ['p'],
      groups: [{
        id: 'p',
        name: 'p',
        models: [{
          id: 'm',
          name: 'M',
          reasoning: {
            defaultEffort: 'e1',
            efforts: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'].map((id) => ({ id, name: id })),
          },
        }],
      }],
      failures: [],
    },
  }
  await resize(m.pane, 1280)
  await m.ready(seven)
  assert.equal(props(m.pane).preview, 'side', 'short labels leave room for the wide overview')
  assert.equal(props(m.pane).size, 'lg')
  // The wide effort selector IS the inline radio column: its LAST candidate is
  // rendered and reachable without any drill-down.
  assert.ok(hasEffortCard(m.pane))
  assert.ok(sheetText(m.pane).includes('e7'), `every candidate is listed: ${sheetText(m.pane).slice(0, 200)}`)
  assert.equal(
    layerNodes(m.pane).filter((node) => node.k === 'row' && node.id.includes('.effort-')).length,
    7,
    'seven advertised candidates, seven radio rows',
  )
  m.handle.close()
})

test('native Model: an explicit blank line in a description is budgeted', async (t) => {
  const m = await mounted(t)
  // The renderer preserves explicit newlines, so a description of two visible
  // characters CAN occupy fourteen lines.
  const blank = `x\n${'\n'.repeat(12)}x`
  const five = budgetDirectory({
    providerName: 'p',
    modelId: 'm',
    description: blank,
    effortNames: ['e1', 'e2', 'e3', 'e4', 'e5'],
  })
  await resize(m.pane, 1280)
  await m.ready(five)
  assert.equal(props(m.pane).size, 'lg', 'the wide shell is kept')
  assert.equal(props(m.pane).preview, 'side', 'the details column is kept')
  assert.ok(hasEffortCard(m.pane),
    'the effort selector stays inline: a long description never decides it')
  // The complete description stays readable through the details page.
  await openDetails(m.pane)
  const rows = (props(m.pane).items as Array<Record<string, unknown>>)
    .filter((item) => String(item.id).startsWith('fact-description'))
  assert.equal(rows.length, 14, 'every rendered line is budgeted, blank ones included')
  assert.equal(
    rows.map((row) => String(row.detail)).join('\n').replace(/\s+/g, ''),
    blank.replace(/\s+/g, ''),
    'the blank lines and the visible text all reach the details page',
  )
  m.handle.close()
})

/* -------------------------------------------------- content/readability paths */

test('native Model: a long description is readable on the compact details page', async (t) => {
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
  const rows = (props(m.pane).items as Array<Record<string, unknown>>)
    .filter((item) => String(item.id).startsWith('fact-description'))
  assert.ok(rows.length > 1, 'a long description is wrapped into several complete rows')
  assert.equal(
    rows.map((row) => String(row.detail)).join('').replace(/\s+/g, ''),
    long.replace(/\s+/g, ''),
    'the wrapped rows carry every character of the description',
  )
  for (const row of rows) {
    assert.ok(String(row.detail).length <= 40, `row ${String(row.id)} fits one line`)
  }
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
  const rowsOf = (): string[] => (props(m.pane).items as Array<Record<string, unknown>>)
    .filter((item) => String(item.id).startsWith('fact-description'))
    .map((item) => String(item.detail))
  const rows = rowsOf()
  // Whitespace is the wrapper's to spend (a word wrap consumes its break
  // space), so exactness is asserted on the non-whitespace content: no
  // character may be lost, duplicated or corrupted.
  const dense = (text: string): string => text.replace(/\s+/g, '')
  assert.equal(dense(rows.join('')), dense(tricky), 'the wrapped rows reproduce every character')
  assert.ok(rows.length > 1, 'it really wrapped')
  for (const row of rows) {
    assert.doesNotMatch(row, /[\uD800-\uDBFF]$/, `row ends on a high surrogate: ${row}`)
    assert.doesNotMatch(row, /^[\uDC00-\uDFFF]/, `row starts on a low surrogate: ${row}`)
  }
  assert.ok(rows[rows.length - 1]!.endsWith('🚀z'), 'the emoji moved to a later line intact')
  // The CJK description: two display columns per grapheme, so a 40-column line
  // holds at most 20 graphemes.
  action(m.pane, 'back')
  await waitUntil('back on the Overview', () => props(m.pane).title === 'Model overview')
  action(m.pane, 'back')
  await waitUntil('back on the list', () => props(m.pane).title === 'Models')
  browse(m.pane, SAME_B)
  await waitUntil('the CJK model Overview', () =>
    props(m.pane).title === 'Model overview' && joinedDetail(m.pane, 'overview-provider') === 'B(b)')
  await walkList(m.pane, OVERVIEW_DETAILS_ID)
  m.pane.key('\r')
  await waitUntil('CJK details page', () => props(m.pane).title === 'Full model details')
  const cjkRows = rowsOf()
  assert.equal(dense(cjkRows.join('')), dense(cjk), 'the CJK description is reproduced exactly')
  for (const row of cjkRows) {
    assert.ok([...row].length <= 20, `a CJK row holds at most 20 graphemes: ${row}`)
  }
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
  // The wide column keeps the identity; the FULL facts live on the read-only
  // details page the card opens.
  assert.equal(props(live.pane).preview, 'side')
  assert.match(sheetText(live.pane), /Provider: A/, 'the identity keeps its value')
  assert.match(sheetText(live.pane), /\(a\)/)
  const liveFacts = async (): Promise<Array<[string?, string?]>> => {
    await openDetails(live.pane)
    const rows = props(live.pane).items as Array<Record<string, unknown>>
    action(live.pane, 'back')
    await waitUntil('back to the list', () => props(live.pane).title === 'Models')
    return rows
      .filter((item) => String(item.id).startsWith('fact-'))
      .map((item) => [String(item.label), String(item.detail)] as [string?, string?])
  }
  const facts = await liveFacts()
  assert.ok(facts.some(([, detail]) => detail === 'a/same/high'), `live Current fact: ${JSON.stringify(facts)}`)
  assert.ok(facts.some(([, detail]) => detail === 'b/same/low'), 'the persisted default keeps its own effort')
  live.handle.close()
  const sessionless = await mounted(t)
  await sessionless.ready()
  await openDetails(sessionless.pane)
  const plainFacts = (props(sessionless.pane).items as Array<Record<string, unknown>>)
    .filter((item) => String(item.id).startsWith('fact-'))
    .map((item) => [String(item.label), String(item.detail)] as [string?, string?])
  assert.ok(plainFacts.every(([label]) => label !== 'Current'), 'a sessionless panel never paints a Current fact')
  assert.ok(plainFacts.some(([, detail]) => detail === 'a/same/high'))
})

test('native Model: a model without efforts has no selector and says so on the Overview', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Wide: the no-effort model draws NO inline selector, so the effort zone does
  // not exist and one Tab lands on the details card.
  browse(pane, SAME_B)
  await waitUntil('provider B highlighted', () => props(pane).selected === SAME_B)
  assert.equal(hasEffortCard(pane), false, 'no empty effort selector is drawn')
  // With no inline selector the ring has exactly three stops, so two Tabs reach
  // the bar — never an invisible effort zone.
  pane.key('\t')
  await waitUntil('the details card zone', () => props(pane).focus === 'preview')
  pane.key('\t')
  await waitUntil('the bar, not an invisible effort zone', () => focusCue(pane, 'apply'))
  pane.key('\t')
  await waitUntil('the ring comes back to the list', () => props(pane).focus === 'list')
  // A re-read that drops the highlighted model's reasoning metadata leaves the
  // panel on the visible list, never in an inert effort zone.
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
  pane.key('\u001b[B')
  await waitUntil('arrows browse the model list again', () => props(pane).title === 'Models')
  assert.equal(m.writes.length, 0)
  // Compact: the Overview states the absence instead of silently omitting it.
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  await enterOverview(pane)
  assert.equal(rowIds(pane).includes(OVERVIEW_NO_EFFORT_ID), true, 'the absence is stated')
  const inert = ((props(pane).items ?? []) as Array<Record<string, unknown>>)
    .find((item) => String(item.id) === OVERVIEW_NO_EFFORT_ID)
  assert.equal(inert?.label, 'Reasoning effort')
  assert.equal(inert?.detail, 'Not available')
  await walkList(pane, OVERVIEW_NO_EFFORT_ID)
  pane.key('\r')
  await settle(30)
  assert.equal(props(pane).title, 'Model overview', 'the inert effort row never leaves the page')
  assert.equal(m.writes.length, 0, 'and it never writes')
})

test('native Model: a provider called all and a scope-shaped effort id stay unambiguous', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  // A catalogue may advertise a provider whose ID is literally `all`, a provider
  // whose ID carries a colon AND non-ASCII text, and an effort whose ID starts
  // with the scope prefix (or IS the every-provider id) or is non-ASCII itself.
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
                  { id: ALL_SCOPES_ID, name: 'Scope-shaped' },
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
  // The every-provider entry and the `all` PROVIDER are distinct wire ids, and
  // filtering by the provider `all` really filters (it is not the sentinel). A
  // scope click arrives as the SDK's own `action { act:'scope', value }`.
  const scopes = (props(pane).scopes as Array<Record<string, unknown>>).map((entry) => String(entry.id))
  assert.ok(scopes.includes(ALL_SCOPES_ID), `the every-provider entry: ${JSON.stringify(scopes)}`)
  assert.ok(scopes.includes('scope:all'), 'the provider literally called `all` has its own entry')
  assert.equal(props(pane).scope, ALL_SCOPES_ID, 'the panel starts on every provider')
  // A provider ID that itself contains the scope separator and non-ASCII text:
  // the scope id is the prefix PLUS that whole tail, so the fixed `scope:` slice
  // must keep it intact and the membership check must match the read's own
  // provider id exactly — never a prefix or a truncated tail.
  const unicodeScope = scopeId('vendor:供应商')
  assert.ok(scopes.includes(unicodeScope), `the colon/Unicode provider scope: ${JSON.stringify(scopes)}`)
  action(pane, 'scope', unicodeScope)
  await waitUntil('the colon/Unicode provider filters', () => props(pane).scope === unicodeScope)
  assert.deepEqual(rowIds(pane), [JSON.stringify(['vendor:供应商', 'm'])],
    'the colon/Unicode provider keeps exactly its own row')
  assert.equal(m.writes.length, 0, 'a scope click is never a write')
  action(pane, 'scope', ALL_SCOPES_ID)
  await waitUntil('every provider again after the colon/Unicode scope', () => props(pane).scope === ALL_SCOPES_ID)
  assert.equal(rowIds(pane).length, 3, 'every provider is listed again')
  // The scope round trip re-aligned the highlight onto the last filtered row, so
  // walk back to the EFFORT-BEARING model before the candidate cases.
  browse(pane, JSON.stringify(['all', 'm']))
  await waitUntil('the effort-bearing model is highlighted again',
    () => props(pane).selected === JSON.stringify(['all', 'm']))
  action(pane, 'scope', 'scope:all')
  await waitUntil('the `all` provider filters', () => props(pane).scope === 'scope:all')
  assert.equal(rowIds(pane).length, 1, 'the `all` provider keeps exactly its own rows')
  assert.equal(m.writes.length, 0, 'a scope click is never a write')
  action(pane, 'scope', ALL_SCOPES_ID)
  await waitUntil('every provider again', () => props(pane).scope === ALL_SCOPES_ID)
  // A candidate row carries its OWN namespace on the main list: a candidate whose
  // value looks like a scope id — even the every-provider id — takes the draft,
  // and the Overview carries no scope column that could be confused with it.
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  browse(pane, JSON.stringify(['all', 'm']))
  await waitUntil('the Overview of the effort-bearing model',
    () => props(pane).title === 'Model overview' && joinedDetail(pane, 'overview-provider') === 'Providerall(all)')
  assert.equal(props(pane).scopes, undefined, 'the Overview carries no scope column')
  browse(pane, effortItemId(ALL_SCOPES_ID))
  await waitUntil('the every-provider-shaped candidate takes the draft', () =>
    ((props(pane).items ?? []) as Array<Record<string, unknown>>)
      .some((item) => String(item.id) === effortItemId(ALL_SCOPES_ID)
        && (item.mark as { text?: string } | undefined)?.text === '●'))
  browse(pane, effortItemId('scope:other'))
  await waitUntil('the prefixed candidate takes the draft', () =>
    ((props(pane).items ?? []) as Array<Record<string, unknown>>)
      .some((item) => String(item.id) === effortItemId('scope:other')
        && (item.mark as { text?: string } | undefined)?.text === '●'))
  assert.equal(m.writes.length, 0, 'a candidate row is never a write')
  // A scope-shaped `select` on this page is not a scope click either, so the two
  // namespaces stay independent in BOTH directions.
  const overviewFrame = picker(pane)!.id
  browse(pane, 'scope:all')
  await settle(30)
  assert.equal(picker(pane)!.id, overviewFrame, 'a scope-shaped Overview row never acts')
  assert.equal(props(pane).scope, undefined, 'and it never filters either')
  // A NON-ASCII candidate value travels on the ROW channel with its own namespace:
  // it must land in the draft byte-for-byte (no truncation, no scope confusion).
  const unicodeEffort = effortItemId('scope:复杂🚀')
  browse(pane, unicodeEffort)
  await waitUntil('the Unicode candidate takes the draft', () =>
    ((props(pane).items ?? []) as Array<Record<string, unknown>>)
      .some((item) => String(item.id) === unicodeEffort
        && (item.mark as { text?: string } | undefined)?.text === '●'))
  assert.equal(m.writes.length, 0, 'a candidate row is never a write')
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
  assert.equal(props(pane).title, 'Model overview', 'and the page stays where it was')
  // The rows it DOES offer really run.
  browse(pane, OVERVIEW_DETAILS_ID)
  await waitUntil('the offered details row runs', () => props(pane).title === 'Full model details')
  action(pane, 'back')
  await waitUntil('back on the Overview', () => props(pane).title === 'Model overview')
  // Boundary: a search that matches NOTHING has no highlighted model, so no
  // content page can be opened and no write can be offered.
  action(pane, 'back')
  await waitUntil('back on the model list', () => props(pane).title === 'Models')
  for (const char of 'zzzz') {
    pane.key(char)
    await settle(10)
  }
  await waitUntil('no model matches', () => rowIds(pane).every((id) => id.startsWith('failure:')))
  assert.equal(props(pane).selected, undefined, 'nothing is highlighted with no match')
  pane.key('\r')
  await settle(30)
  assert.equal(props(pane).title, 'Models', 'Enter cannot open a page with no model')
  await resize(pane, 130)
  await waitUntil('wide again', () => props(pane).size === 'lg')
  assert.equal(actionOf(pane, 'apply')?.disabled, true, 'no match means no write')
  assert.equal((props(pane).items as unknown[]).length, 0, 'a wide no-match list is really empty')
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

test('native Model: the highlighted row states its own drafted effort', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // (a) The highlighted effort-bearing model states its seeded draft; the model
  // without advertised efforts keeps its plain provider detail.
  assert.equal(props(pane).selected, SAME_A, 'the configured default starts highlighted')
  assert.equal(detailOf(pane, SAME_A), 'A · High', 'the highlighted row carries its seeded effort label')
  assert.equal(detailOf(pane, SAME_B), 'B', 'a model with no advertised efforts keeps the plain provider detail')
  // (b) Draft another effort on the inline selector: the highlighted row follows
  // the NEW draft.
  click(pane, clickRow(pane, 'effort-low'))
  await waitUntil('the draft moved', () => detailOf(pane, SAME_A) === 'A · Low')
  assert.equal(detailOf(pane, SAME_B), 'B', 'the other row is untouched')
  // (c) ONLY the highlighted row states an effort: the effort-bearing row drops
  // the suffix as soon as another model becomes the target.
  browse(pane, SAME_B)
  await waitUntil('the plain model is highlighted', () => props(pane).selected === SAME_B)
  assert.equal(detailOf(pane, SAME_B), 'B', 'the highlighted no-effort model keeps the plain detail')
  assert.equal(detailOf(pane, SAME_A), 'A', 'an unhighlighted effort-bearing row states no effort')
  m.handle.close()
})

test('native Model: the bounded wide card enters the Overview from both pointer and keyboard', async (t) => {
  const m = await mounted(t, { sessionless: false })
  await resize(m.pane, 1100)
  await m.ready(budgetDirectory({
    providerName: 'openrouter',
    modelId: 'anthropic/claude-3.7-sonnet:thinking',
    effortNames: Array.from({ length: 8 }, () => 'W'.repeat(34)),
    configuredEffort: 'e1',
  }))
  assert.equal(hasEffortCard(m.pane), false, 'the wide column is bounded for this model')
  // The keyboard path: Tab focuses the card, and the card's OWN hint names what
  // Enter opens — the bounded card presents identity only, so it must open the
  // Overview (the page that carries every candidate), exactly like its click.
  m.pane.key('\t')
  await waitUntil('the bounded card zone', () => props(m.pane).focus === 'preview')
  assert.ok(sheetText(m.pane).includes('Enter: overview'), sheetText(m.pane).slice(0, 200))
  m.pane.key('\r')
  await waitUntil('Enter opened the Overview', () => props(m.pane).title === 'Model overview')
  assert.equal(m.writes.length, 0, 'opening the Overview never writes')
  assert.equal(rowIds(m.pane).filter((id) => id.startsWith('effort:')).length, 8,
    'the Overview the key opened really lists every candidate')
  // The pointer path on the very same card resolves the same page.
  action(m.pane, 'back')
  await waitUntil('back on the model list', () => props(m.pane).title === 'Models')
  click(m.pane, cardNode(m.pane, 'model-details'))
  await waitUntil('the click opened the Overview', () => props(m.pane).title === 'Model overview')
  assert.equal(rowIds(m.pane).filter((id) => id.startsWith('effort:')).length, 8)
  assert.equal(m.writes.length, 0)
  m.handle.close()
  // The FULL card is the opposite case: its hint and its click both say details.
  const full = await mounted(t)
  await full.ready()
  assert.ok(hasEffortCard(full.pane), 'the wide column is full for this model')
  full.pane.key('\t')
  await waitUntil('the full card zone', () => props(full.pane).focus === 'preview')
  assert.ok(sheetText(full.pane).includes('Enter: details'), sheetText(full.pane).slice(0, 200))
  full.pane.key('\r')
  await waitUntil('Enter opened the read-only details page',
    () => props(full.pane).title === 'Full model details')
  assert.equal(full.writes.length, 0)
  full.handle.close()
})

test('native Model: a resize out of a wide side zone never operates an invisible region', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  assert.ok(hasEffortCard(pane), 'the wide column starts full')
  // (a) The INLINE EFFORT zone. Its hint is its own zone marker (both side
  // zones report `focus: preview`).
  const seededMark = clickRow(pane, 'effort-high').p.mark
  pane.key('\r')
  await waitUntil('the details card zone', () => sheetText(pane).includes('Enter: details'))
  pane.key('\t')
  await waitUntil('the inline effort zone', () => sheetText(pane).includes('↑↓ draft'))
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  assert.equal(props(pane).title, 'Models', 'the resize did not page the panel on its own')
  assert.equal(props(pane).focus, 'list', 'the keyboard is back on the really visible list')
  // ↑↓ now browse the MODEL LIST: no invisible draft can be changed.
  pane.key('\u001b[B')
  await waitUntil('the arrows browse the model list', () => props(pane).selected !== SAME_A)
  pane.key('\u001b[A')
  await waitUntil('back on the effort-bearing row', () => props(pane).selected === SAME_A)
  assert.equal(m.writes.length, 0, 'the resize and the arrows wrote nothing')
  await resize(pane, 130)
  await waitUntil('wide again', () => props(pane).size === 'lg')
  assert.equal(clickRow(pane, 'effort-high').p.mark, seededMark,
    'the invisible-zone arrows never changed the draft')
  // (b) The DETAIL-CARD zone falls back the same way.
  const d = await mounted(t)
  await d.ready()
  d.pane.key('\t')
  await waitUntil('the details card zone', () => sheetText(d.pane).includes('Enter: details'))
  await resize(d.pane, 100)
  await waitUntil('compact', () => props(d.pane).size === 'md')
  assert.equal(props(d.pane).title, 'Models', 'the card zone never pages the panel either')
  assert.equal(props(d.pane).focus, 'list', 'and the keyboard lands on the visible list')
  assert.equal(d.writes.length, 0)
  d.handle.close()
  m.handle.close()
})
