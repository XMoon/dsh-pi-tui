/** Production native /model renderer, original command and write paths.
 *
 * Scripted tty/Host fixtures are named explicitly; only the final Direct cases
 * mount official live Agents. No decision or committed selection is injected.
 * The B2 assertions read the REAL reconciled wire tree: the picker's own props
 * (title/preview/scopes/focus/actions) and the SDK action dispatch, so a
 * renderer-local field can never satisfy them.
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
  effortItemId,
  moreRowId,
  scopeId,
} from '../src/tui/tsp/model-picker-state.ts'
import { runOwned } from '../src/runtime/process/tasks.ts'
import type {
  ModelApplyOutcome,
  ModelPickerDirectory,
  ModelPickerRequest,
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
  clickNode as click,
  layerNodes,
  pickerAction as actionOf,
  pickerNode as picker,
  pickerProps as props,
  rowNode as clickRow,
  sendAction as action,
  sendResize,
  sendSelect as browse,
  hasEffortCard,
  sheetText,
  wireNodes as nodes,
} from './support/tsp-picker-wire.ts'

/** The label of one More-page ROW (the picker's own item list). The secondary
 *  operations live there, never in the action bar, so `pickerAction` cannot see
 *  them. */
function moreRowLabel(pane: TspPane, actionId: string): string | undefined {
  return ((props(pane).items ?? []) as Array<Record<string, unknown>>)
    .find((item) => String(item.id) === moreRowId(actionId))?.label as string | undefined
}

/** Open the More page from the model list's strip chip: the model-list bar does
 *  not offer `details`/`effort-page`/`retry`, so the More page is the wire's only
 *  route to them. The settle flushes a frame still in flight so the strip click
 *  carries the current receiver. */
async function openMore(pane: TspPane): Promise<void> {
  await settle(20)
  action(pane, 'strip', 'strip-more')
  await waitUntil('the More actions page', () => props(pane).title === 'More actions')
}

/** Run one offered secondary operation from the More page. */
async function runMoreRow(pane: TspPane, actionId: string): Promise<void> {
  await openMore(pane)
  browse(pane, moreRowId(actionId))
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

test('native Model B2: provider scope, effort draft and the single explicit Apply', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Open-time subject: the title carries it, and a sessionless subject never
  // paints a current row.
  assert.equal(props(pane).subtitle, 'Default model')
  assert.equal(props(pane).title, 'Models')
  assert.deepEqual(props(pane).current, [], 'sessionless never fabricates a current badge')
  // Wide: the native side preview + provider scopes are requested.
  assert.equal(props(pane).size, 'lg')
  assert.equal(props(pane).preview, 'side')
  assert.ok(Array.isArray(props(pane).scopes))
  const badScope = (props(pane).scopes as Array<Record<string, unknown>>)
    .find((entry) => entry.id === 'scope:bad')
  assert.equal(badScope?.dot, 'error')
  assert.equal(badScope?.disabled, 'Provider unavailable')
  // Browsing a row changes the browse object only.
  browse(pane, JSON.stringify(['b', 'same']))
  await waitUntil('provider B', () => props(pane).selected === JSON.stringify(['b', 'same']))
  assert.equal(m.writes.length, 0, 'row activation is browsing only')
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
  await settle(50)
  // The effort draft is chosen on the effort page, reachable from the model
  // list's `More actions…` strip chip. A real row select only changes the local
  // draft; it never writes.
  action(pane, 'strip', 'strip-more')
  await waitUntil('more page', () => props(pane).title === 'More actions')
  browse(pane, moreRowId('effort-page'))
  await waitUntil('effort page', () => props(pane).title === 'Reasoning Effort')
  browse(pane, effortItemId('high'))
  await waitUntil('draft effort', () => props(pane).selected === effortItemId('high'))
  assert.equal(m.writes.length, 0, 'an effort row activation never writes')
  // The effort page's ring is list <-> effort <-> bar: one Tab reaches the bar.
  pane.key('\t')
  await waitUntil('primary focused', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\r')
  await waitUntil('one admitted write', () => m.writes.length === 1)
  assert.deepEqual(m.writes, [{ provider: 'a', model: 'same', reasoningEffort: 'high' }])
})

test('native Model: a REAL scope action filters, and a scope-shaped row select never does', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  const itemIds = (): string[] =>
    (props(pane).items as Array<Record<string, unknown>>).map((item) => String(item.id))
  const B_SAME = JSON.stringify(['b', 'same'])
  // S01: the SDK delivers a scope-column click on the ACTION channel as
  // `action { act:'scope', value:<scope id> }`. The positive control runs first,
  // so every negative below refuses an event the harness really dispatched.
  assert.deepEqual(itemIds(), [SAME_A, B_SAME], 'both providers are listed')
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
  assert.deepEqual(itemIds(), [SAME_A, B_SAME], 'clearing the filter restores every provider')
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
  // The drill-down pages carry NO scope column, so only a stale or hostile
  // receiver can send one there: it must not filter either. The details page is
  // reached through the More page (the model-list bar no longer offers it).
  await runMoreRow(pane, 'details')
  await waitUntil('details page', () => props(pane).title === 'Full model details')
  assert.equal(props(pane).preview, 'none', 'a drill-down page has no side preview')
  assert.equal(props(pane).scopes, undefined, 'a drill-down page advertises no scope column')
  action(pane, 'scope', 'scope:a')
  await settle(30)
  // The details page's bar offers no effort entry either, so the effort page too
  // is reached from the More page.
  action(pane, 'back')
  await waitUntil('back on the model list', () => props(pane).title === 'Models')
  await runMoreRow(pane, 'effort-page')
  await waitUntil('effort page', () => props(pane).title === 'Reasoning Effort')
  assert.equal(props(pane).scopes, undefined, 'the effort page advertises no scope column either')
  action(pane, 'scope', 'scope:b')
  await settle(30)
  // The effort page was opened from the More page, so Back returns there, then the
  // model list.
  action(pane, 'back')
  await waitUntil('back on the More page', () => props(pane).title === 'More actions')
  action(pane, 'back')
  await waitUntil('back on the model list', () => props(pane).title === 'Models')
  assert.equal(props(pane).scope, ALL_SCOPES_ID, 'a scope action from a drill-down page never filtered')
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
  // Zone `models`: Enter opens the effort selector — it never writes.
  pane.key('\r')
  await waitUntil('effort zone', () =>
    props(pane).focus === 'preview' && String(props(pane).title).startsWith('Models'))
  assert.equal(m.writes.length, 0, 'Enter on the model list is not a write')
  // Zone `effort`: Tab reaches the Primary Action; Enter then commits once.
  pane.key('\t')
  await waitUntil('primary zone', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  assert.equal(
    actionOf(pane, 'apply')?.label,
    '▸ Confirm',
    'the focused Primary Action changes shape (visible, color-free focus)',
  )
  const lowBeforeWrite = clickRow(pane, 'effort-low')
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
    browse(pane, JSON.stringify(['b', 'same']))
    await waitUntil('plain model', () => props(pane).selected === JSON.stringify(['b', 'same']))
    // A model with no advertised efforts has the ring list -> strip -> bar:
    // Shift+Tab wraps straight onto the Primary Action.
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
    }
    handle.close()
    await waitUntil('retired', () => picker(pane) === undefined)
  }
})

test('native Model: a failed directory read shows ONE Retry and re-reads from the primary action', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  m.handle.setLoadError('catalog is unreachable')
  await waitUntil('error state', () => props(pane).state === 'error')
  assert.match(String(props(pane).message), /catalog is unreachable/)
  assert.equal(m.retries(), 0, 'showing the error never reads again by itself')
  // K2: the Tab-reachable primary action is the read-only Retry.
  pane.key('\t')
  await waitUntil('primary zone', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
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
  // Wide -> compact: the same panel switches to the drill-down layout. The model
  // list keeps `preview: 'side'` at every width; the client renders it below the
  // list at md and beside it at lg.
  await resize(pane, 100)
  await waitUntil('compact layout', () => props(pane).size === 'md' && props(pane).preview === 'side')
  assert.ok(!props(pane).scopes, 'compact has no scope column (the SDK nulls the prop)')
  assert.equal(
    (props(pane).items as Array<Record<string, unknown>>).some((item) => item.disabled !== undefined),
    false,
    'a directory without failed providers lists none',
  )
  assert.equal((props(pane).strip as { label?: string } | undefined)?.label, 'Default model')
  // Details is a compact PAGE of the same picker, not an overlay, reached through
  // the More page (the model-list bar does not offer it).
  await runMoreRow(pane, 'details')
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
  // Back restores the model list with the same browse object.
  action(pane, 'back')
  await waitUntil('back to the list', () => props(pane).title === 'Models')
  // The effort page lists the real draft candidates; an arrow changes the DRAFT
  // (from the configured `High` to the provider default), Enter confirms it into
  // the Primary Action, and only there does Enter commit. The main bar carries no
  // effort shortcut, so the complete list is the More page's own entry.
  await runMoreRow(pane, 'effort-page')
  await waitUntil('effort page', () => props(pane).title === 'Reasoning Effort')
  pane.key('\u001b[B')
  await waitUntil('draft moved', () => props(pane).selected === effortItemId('\u0000provider-default'))
  assert.equal(m.writes.length, 0, 'choosing a draft never writes')
  pane.key('\r')
  await waitUntil('primary zone shape cue',
    () => actionOf(pane, 'apply')?.label === '▸ Confirm')
  pane.key('\r')
  await waitUntil('write from the compact primary action', () => m.writes.length === 1)
  assert.deepEqual(
    m.writes,
    [{ provider: 'p', model: 'm' }],
    'the provider-default draft submits WITHOUT a reasoningEffort literal',
  )
  // A refusal re-enables the panel with the chosen draft intact, and the draft
  // survives the flip back to the wide layout (readable again on the effort page).
  m.settleWrite('rejected')
  await waitUntil('refusal restores the panel',
    () => actionOf(pane, 'apply')?.label === 'Confirm')
  await resize(pane, 130)
  await waitUntil('wide again', () => props(pane).size === 'lg')
  action(pane, 'strip', 'strip-more')
  await waitUntil('more page after the flip', () => props(pane).title === 'More actions')
  browse(pane, moreRowId('effort-page'))
  await waitUntil('effort page after the flip', () => props(pane).title === 'Reasoning Effort')
  assert.equal(
    props(pane).selected,
    effortItemId('\u0000provider-default'),
    "the draft chosen in the compact page is the wide layout's draft",
  )
})

test('native Model: browsing, effort, graphemes, modal and stale receiver fences', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  action(pane, 'unknown-action')
  action(pane, 'scope', 'scope:bad')
  browse(pane, JSON.stringify(['nope', 'nope']))
  pane.event({ ev: 'action', sf: 'retired-surface', id: picker(pane)!.id, act: 'apply' })
  await settle(30)
  assert.equal(props(pane).scope, ALL_SCOPES_ID, 'a disabled provider scope never filters')
  assert.equal(m.writes.length, 0, 'unknown action, failure scopes, foreign surfaces and unlisted rows never write')
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
    assert.equal(saved.length, 0)
    assert.equal(boot.harness.createdSessions.length, 0)
    browse(boot.pane, JSON.stringify(['p', 'm2']))
    await waitUntil('m2 browse', () => props(boot.pane).selected === JSON.stringify(['p', 'm2']))
    assert.equal(saved.length, 0)
    // Shift+Tab wraps the ring straight onto the Primary Action (the strip chip
    // comes first going forward, so a single Tab would open the More page).
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
    // Shift+Tab wraps straight onto the Primary Action (a forward Tab now opens
    // the More page from the strip chip first).
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
    // the Session's model, it is not a default save. The button only says
    // `Confirm`; at `lg` the COMPLETE operation name lives on the strip's own line.
    assert.equal(actionOf(fixture.pane, 'apply')?.label, 'Confirm')
    assert.equal(
      (props(fixture.pane).strip as { label?: string }).label,
      'Action: Switch Model',
      'the wide strip states the real write',
    )
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
    // details page (the details column carries the bounded summary). The
    // model-list bar does not offer `details`, so the More page opens it.
    assert.equal(props(fixture.pane).size, 'lg', 'the wide shell is kept')
    assert.equal(props(fixture.pane).preview, 'side', 'the details column is kept')
    action(fixture.pane, 'strip', 'strip-more')
    await waitFor('the More page', () => props(fixture.pane).title === 'More actions')
    browse(fixture.pane, moreRowId('details'))
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

test('native Model: a resize into compact keeps the effort zone on a VISIBLE selector', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // Enter the wide effort zone (the preview pane is the selector there).
  pane.key('\r')
  await waitUntil('wide effort zone', () => props(pane).focus === 'preview')
  await resize(pane, 100)
  // The compact layout has no preview, so the SAME zone must reach the effort
  // PAGE: otherwise ↑↓ would change a draft with no visible selector.
  await waitUntil('compact effort page', () =>
    props(pane).size === 'md' && String(props(pane).title).startsWith('Reasoning Effort'))
  assert.equal((props(pane).strip as { label?: string } | undefined)?.label, 'Default model')
  await waitUntil('the draft is visible on the effort page', () => props(pane).selected === effortItemId('high'))
  pane.key('\u001b[B')
  await waitUntil('visible draft change', () => props(pane).selected === effortItemId('\u0000provider-default'))
  assert.equal(m.writes.length, 0, 'changing a draft never writes')
})

test('native Model: every visible action is keyboard reachable and never a no-op', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  // The model list's bar is exactly Cancel / Confirm: the secondary operations
  // (details, the complete effort list, the partial-failure Retry) never take
  // width from the one write action — they live on the More page.
  const focused = (id: string) => String(actionOf(pane, id)?.label).startsWith('▸')
  assert.deepEqual(
    ((props(pane).actions ?? []) as Array<Record<string, unknown>>).map((entry) => entry.id),
    ['close', 'apply'],
    'the model list bar carries only Cancel and Confirm',
  )
  // Tab reaches the strip ZONE; Enter opens the More page (never a write).
  pane.key('\t')
  await waitUntil('strip zone', () => props(pane).focus === 'strip')
  pane.key('\r')
  await waitUntil('keyboard opened More', () => props(pane).title === 'More actions')
  assert.equal(m.writes.length, 0, 'the More page is a menu, never a write')
  // The More page's own bar is Cancel / Back, and Back returns to the list.
  assert.deepEqual(
    ((props(pane).actions ?? []) as Array<Record<string, unknown>>).map((entry) => entry.id),
    ['close', 'back'],
    'the More page offers no write at all',
  )
  pane.key('\t')
  await waitUntil('more bar focused', () => focused('back'))
  pane.key('\r')
  await waitUntil('back returned to the list', () => props(pane).title === 'Models')
  // Enter on the More page's first row runs the details operation.
  pane.key('\t')
  await waitUntil('strip zone again', () => props(pane).focus === 'strip')
  pane.key('\r')
  await waitUntil('More again', () => props(pane).title === 'More actions')
  pane.key('\r')
  await waitUntil('keyboard opened Details', () => props(pane).title === 'Full model details')
  // The details page's own bar: ← from the primary walks back to Back.
  pane.key('\u001b[Z')
  await waitUntil('details bar focused', () => focused('apply'))
  pane.key('\u001b[D')
  await waitUntil('details back focused', () => focused('back'))
  pane.key('\r')
  await waitUntil('keyboard returned to the list', () => props(pane).title === 'Models')
  // The partial-failure Retry is reachable from the More page and re-reads,
  // never writes. Its row is the third secondary entry (details, effort, retry).
  const before = m.retries()
  pane.key('\t')
  await waitUntil('strip zone for the retry', () => props(pane).focus === 'strip')
  pane.key('\r')
  await waitUntil('More for the retry', () => props(pane).title === 'More actions')
  pane.key('\u001b[B')
  pane.key('\u001b[B')
  await waitUntil('the retry row is selected', () => props(pane).selected === moreRowId('retry'))
  pane.key('\r')
  await waitUntil('retry ran from the keyboard', () => m.retries() === before + 1)
  assert.equal(m.writes.length, 0, 'a keyboard Retry never writes')
})

test('native Model: the effort page has no contradictory action and Back returns', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  // The main bar no longer reaches the effort page directly: the More page owns
  // the complete-effort entry, and the effort page names where it came from.
  assert.equal(actionOf(pane, 'effort-page'), undefined, 'the main bar carries no effort shortcut')
  action(pane, 'strip', 'strip-more')
  await waitUntil('more page', () => props(pane).title === 'More actions')
  assert.equal(moreRowLabel(pane, 'effort-page'), 'All reasoning effort levels…')
  assert.equal(moreRowLabel(pane, 'back'), 'Back to models')
  browse(pane, moreRowId('effort-page'))
  await waitUntil('effort page', () => props(pane).title === 'Reasoning Effort')
  assert.equal(
    actionOf(pane, 'effort-page'),
    undefined,
    'the effort page offers no second, contradictory selector entry',
  )
  assert.equal(actionOf(pane, 'back')?.label, 'Back', 'the effort page has exactly one way back')
  action(pane, 'back')
  await waitUntil('back to the More page', () => props(pane).title === 'More actions')
  action(pane, 'back')
  await waitUntil('back to the models page', () => props(pane).title === 'Models')
  await waitUntil('and back to the models zone',
    () => String(actionOf(pane, 'apply')?.label) === 'Confirm')
  // The K2 path keeps working without the More page: Enter on the model list
  // opens the effort page when the highlighted model advertises efforts.
  pane.key('\r')
  await waitUntil('Enter opened the effort page', () => props(pane).title === 'Reasoning Effort')
  assert.equal(props(pane).focus, 'list')
  assert.equal(actionOf(pane, 'back')?.label, 'Back', 'the K2 path returns to the models page')
  pane.key('\u001b')
  await waitUntil('Esc returned to the models page', () => props(pane).title === 'Models')
})

test('native Model: the action bar is Cancel / Confirm and the secondary operations live on the More page', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  assert.equal(props(pane).size, 'lg', 'the default pane is wide')
  const labels = (): Array<string | undefined> =>
    ((props(pane).actions ?? []) as Array<Record<string, unknown>>)
      .map((action) => action.label as string | undefined)
  // The main page's short bar offers exactly the ONE write plus its way out: the
  // secondary operations never enter it and can never clip it.
  assert.deepEqual(labels(), ['Cancel', 'Confirm'])
  // The More page is the menu of secondary operations; its own bar is Cancel / Back.
  action(pane, 'strip', 'strip-more')
  await waitUntil('more page', () => props(pane).title === 'More actions')
  assert.deepEqual(labels(), ['Cancel', 'Back'])
  // The details page keeps its own two-entry bar next to the write.
  browse(pane, moreRowId('details'))
  await waitUntil('details page', () => props(pane).title === 'Full model details')
  assert.deepEqual(labels(), ['Cancel', 'Back', 'Confirm'])
  // The effort page names the page it really returns to and adds no second entry.
  // The details page's bar does not offer it either, so return to the list and
  // reach it through the More page.
  action(pane, 'back')
  await waitUntil('back to the model list', () => props(pane).title === 'Models')
  await runMoreRow(pane, 'effort-page')
  await waitUntil('effort page', () => props(pane).title === 'Reasoning Effort')
  assert.deepEqual(labels(), ['Cancel', 'Back', 'Confirm'])
  m.handle.close()
  // The live subject changes the FULL operation name only (the wide strip's own
  // line); the same action id carries the same one writer and the short `Confirm`.
  const live = await mounted(t, { sessionless: false })
  await live.ready()
  assert.equal(actionOf(live.pane, 'apply')?.label, 'Confirm')
  assert.equal(actionOf(live.pane, 'apply')?.primary, true)
  assert.equal(
    (props(live.pane).strip as { label?: string }).label,
    'Action: Switch Model',
  )
  live.handle.close()
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
  // At `lg` the subject owns the `subtitle` slot, so the strip's own complete line
  // states the FULL operation name instead; the chip stays the single `More actions…`.
  assert.deepEqual(
    props(pane).strip,
    {
      label: 'Action: Choose & Save as Default',
      items: [{ id: 'strip-more', label: 'More actions…' }],
    },
    'lg states the operation name on the strip without repeating the subject',
  )
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
  await runMoreRow(m.pane, 'details')
  await settle(50)
  await waitUntil('details page', () => props(m.pane).title === 'Full model details')
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

test('native Model: Esc returns to the zone and page it came from', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  // models -> Primary (Shift+Tab) -> Esc must not invent the effort zone.
  pane.key('\u001b[Z')
  await waitUntil('primary from the model list', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\u001b')
  await waitUntil('back on the model list', () => sheetText(pane).includes('Tab: more'))
  assert.equal(props(pane).focus, 'list')
  assert.equal(m.writes.length, 0)
  // details -> Primary -> Esc stays on the details page.
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  await runMoreRow(pane, 'details')
  await waitUntil('details page', () => props(pane).title === 'Full model details')
  pane.key('\t')
  await waitUntil('details primary', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\u001b')
  await settle(30)
  await waitUntil('still on the details page', () => props(pane).title === 'Full model details')
  // The details page's bar offers no effort entry, so the effort page is reached
  // from the More page; its visible Back must agree with Esc: both return to the
  // MORE page it was opened from.
  pane.key('\u001b')
  await settle(30)
  await waitUntil('back to the model list', () => props(pane).title === 'Models')
  await runMoreRow(pane, 'effort-page')
  await waitUntil('effort page', () => props(pane).title === 'Reasoning Effort')
  action(pane, 'back')
  await settle(30)
  await waitUntil('Back returned to the More page', () => props(pane).title === 'More actions')
  browse(pane, moreRowId('effort-page'))
  await waitUntil('effort page again', () => props(pane).title === 'Reasoning Effort')
  pane.key('\u001b')
  await settle(30)
  await waitUntil('Esc returns to the More page', () => props(pane).title === 'More actions')
  pane.key('\u001b')
  await settle(30)
  await waitUntil('back on the model list', () => props(pane).title === 'Models')
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
  // The action-first column keeps the identity; the FULL facts live in the
  // always-available Details page.
  assert.equal(props(live.pane).preview, 'side')
  // The identity is pre-wrapped into provable lines, so the parts are asserted
  // individually (each line is its own text node).
  assert.match(sheetText(live.pane), /Provider: A/, 'the identity keeps its value')
  assert.match(sheetText(live.pane), /\(a\)/)
  const liveFacts = async (): Promise<Array<[string?, string?]>> => {
    await runMoreRow(live.pane, 'details')
    await waitUntil('details page', () => props(live.pane).title === 'Full model details')
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
  const plainFacts = await (async (): Promise<Array<[string?, string?]>> => {
    await runMoreRow(sessionless.pane, 'details')
    await waitUntil('details page', () => props(sessionless.pane).title === 'Full model details')
    return (props(sessionless.pane).items as Array<Record<string, unknown>>)
      .filter((item) => String(item.id).startsWith('fact-'))
      .map((item) => [String(item.label), String(item.detail)] as [string?, string?])
  })()
  assert.ok(plainFacts.every(([label]) => label !== 'Current'), 'a sessionless panel never paints a Current fact')
  assert.ok(plainFacts.some(([, detail]) => detail === 'a/same/high'))
})

test('native Model: an effort zone without advertised efforts falls back to the list', async (t) => {
  const m = await mounted(t)
  await m.ready()
  await resize(m.pane, 100)
  await waitUntil('compact', () => props(m.pane).size === 'md')
  // The model-list bar offers no effort entry, so the More page opens the page.
  await runMoreRow(m.pane, 'effort-page')
  await waitUntil('effort page', () => props(m.pane).title === 'Reasoning Effort')
  // A re-read drops the highlighted model's reasoning metadata: the effort zone
  // has no selector any more.
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
  await waitUntil('the panel leaves the empty effort page', () => props(m.pane).title === 'Models')
  assert.equal(props(m.pane).focus, 'list', 'the keyboard sits on the visible list')
  m.pane.key('\u001b[B')
  await waitUntil('arrows browse the model list again', () =>
    props(m.pane).selected === JSON.stringify(['b', 'same']))
  assert.equal(m.writes.length, 0)
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
  await runMoreRow(m.pane, 'details')
  await waitUntil('details page', () => props(m.pane).title === 'Full model details')
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
  await waitUntil('back on the list', () => props(m.pane).title === 'Models')
  browse(m.pane, JSON.stringify(['b', 'same']))
  await waitUntil('the CJK model is highlighted', () =>
    props(m.pane).selected === JSON.stringify(['b', 'same']))
  await runMoreRow(m.pane, 'details')
  await waitUntil('CJK details page', () => props(m.pane).title === 'Full model details')
  const cjkRows = rowsOf()
  assert.equal(dense(cjkRows.join('')), dense(cjk), 'the CJK description is reproduced exactly')
  for (const row of cjkRows) {
    assert.ok([...row].length <= 20, `a CJK row holds at most 20 graphemes: ${row}`)
  }
})

test('native Model: the action bar never offers an action the phase refuses', async (t) => {
  const m = await mounted(t)
  await m.ready()
  await resize(m.pane, 100)
  await waitUntil('compact', () => props(m.pane).size === 'md')
  // LOADING: only Close plus the (disabled) write entry.
  m.handle.setLoading()
  await waitUntil('loading', () => props(m.pane).state === 'loading')
  for (const id of ['details', 'back', 'effort-page', 'retry']) {
    assert.equal(actionOf(m.pane, id), undefined, `${id} is not offered while loading`)
  }
  assert.equal(actionOf(m.pane, 'apply')?.disabled, true)
  assert.ok(actionOf(m.pane, 'close'))
  // PENDING: the same, with the honest Selecting… label. Shift+Tab wraps the ring
  // straight onto the Primary Action from the model list.
  await m.ready()
  m.pane.key('\u001b[Z')
  await waitUntil('primary action focused', () => String(actionOf(m.pane, 'apply')?.label).startsWith('▸'))
  m.pane.key('\r')
  await waitUntil('pending', () => actionOf(m.pane, 'apply')?.label === 'Selecting…')
  for (const id of ['details', 'back', 'effort-page', 'retry']) {
    assert.equal(actionOf(m.pane, id), undefined, `${id} is not offered while pending`)
  }
  m.settleWrite('rejected')
  await waitUntil('ready again', () => actionOf(m.pane, 'apply')?.label === 'Confirm')
  assert.deepEqual(
    (props(m.pane).strip as { items?: Array<{ id: string }> }).items,
    [{ id: 'strip-more', label: 'More actions…' }],
    'the secondary operations return with ready',
  )
  // READ ERROR: only Close and the read-only Retry stay reachable.
  m.handle.setLoadError('catalog is unreachable')
  await waitUntil('error', () => props(m.pane).state === 'error')
  for (const id of ['details', 'back', 'effort-page', 'retry']) {
    assert.equal(actionOf(m.pane, id), undefined, `${id} is not offered in the error state`)
  }
  assert.equal(actionOf(m.pane, 'apply')?.label, 'Retry')
  assert.ok(actionOf(m.pane, 'close'))
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
  // LOADING: the failed read's bar carries the read-only Retry, so the keyboard
  // really is in the action bar when the re-read runs — the same rule, and the hint
  // names the read instead of promising a Tab/←→ this phase refuses.
  const l = await mounted(t)
  await l.ready()
  l.handle.setLoadError('catalog is unreachable')
  await waitUntil('the read failed', () => props(l.pane).state === 'error')
  l.pane.key('\u001b[Z')
  await waitUntil('bar focused on the primary', () => String(actionOf(l.pane, 'apply')?.label).startsWith('▸'))
  assert.equal(actionOf(l.pane, 'apply')?.label, '▸ Retry')
  l.pane.key('\r')
  await waitUntil('the re-read runs', () => props(l.pane).state === 'loading')
  assert.equal(l.retries(), 1)
  assert.equal(actionOf(l.pane, 'close')?.label, 'Cancel', 'a running re-read marks no action either')
  const hint = sheetText(l.pane)
  assert.ok(hint.includes('Reading…'), `the hint names the read: ${hint.slice(0, 160)}`)
  assert.ok(!hint.includes('←→ · Enter') && !hint.includes('Tab: more') && !hint.includes('Tab: effort'),
    'a running re-read promises no key it refuses')
  l.pane.key('\r')
  await settle(30)
  assert.ok(picker(l.pane), 'Enter ran nothing while the read runs')
  assert.equal(l.retries(), 1, 'no refused key can re-read twice')
  l.pane.key('\u001b')
  await waitUntil('Esc still closes a running re-read', () => picker(l.pane) === undefined)
})

/** One fixture whose wide overview provably cannot hold everything: long effort
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
    // inline or drills them down, and never renders a candidate outside itself.
    assert.equal(props(m.pane).size, 'lg', `${scenario.name}: the wide shell is kept`)
    assert.equal(props(m.pane).preview, 'side', `${scenario.name}: the details column is kept`)
    const text = sheetText(m.pane)
    // The inline signal is the EFFORT CARD itself: the main bar carries no effort
    // shortcut, so the card is the only statement the column makes about whether
    // its candidates are inline.
    const inline = hasEffortCard(m.pane)
    assert.equal(actionOf(m.pane, 'effort-page'), undefined,
      `${scenario.name}: the main bar carries no effort shortcut`)
    assert.deepEqual(
      (props(m.pane).strip as { items?: Array<{ id: string }> }).items,
      [{ id: 'strip-more', label: 'More actions…' }],
      `${scenario.name}: the complete content stays one action away`,
    )
    assert.ok(
      inline
        || (text.includes('Provider:') && text.includes('ID:') && /Tab: (effort|more|actions)/.test(text)),
      `${scenario.name}: the bounded column still carries the identity-first summary (${text.slice(0, 120)})`,
    )
    const reasoning = scenario.d.directory.groups[0]!.models[0]!.reasoning
    const advertised = reasoning === undefined
      ? 0
      : reasoning.defaultEffort === undefined ? reasoning.efforts.length + 1 : reasoning.efforts.length
    if (inline) {
      // Every advertised candidate is rendered as a radio row inside the column.
      const rows = layerNodes(m.pane).filter((node) => node.k === 'row' && node.id.includes('.effort-'))
      assert.equal(rows.length, advertised, `${scenario.name}: every candidate row is inline`)
      m.pane.key('\r')
      await waitUntil(`${scenario.name}: effort zone`, () => props(m.pane).focus === 'preview')
      for (let step = 0; step < advertised - 1; step += 1) await m.pane.key('\u001b[B')
      m.pane.key('\r')
      m.pane.key('\r')
      await waitUntil(`${scenario.name}: the last candidate commits`, () => m.writes.length === 1)
    } else {
      // The complete list is the More page's own entry, so reach it the way a user
      // does: model list -> More actions… -> All reasoning effort levels….
      action(m.pane, 'strip', 'strip-more')
      await waitUntil(`${scenario.name}: more page`, () => props(m.pane).title === 'More actions')
      browse(m.pane, moreRowId('effort-page'))
      await waitUntil(`${scenario.name}: effort page`, () => props(m.pane).title === 'Reasoning Effort')
      const ids = ((props(m.pane).items ?? []) as Array<Record<string, unknown>>).map((item) => String(item.id))
      assert.equal(ids.length, advertised, `${scenario.name}: every advertised effort is listed`)
      const walkTo = async (target: string): Promise<boolean> => {
        for (let step = 0; step <= ids.length; step += 1) {
          if (props(m.pane).selected === target) return true
          await m.pane.key('\u001b[B')
          await settle(15)
        }
        return props(m.pane).selected === target
      }
      assert.ok(await walkTo(ids[0]!), `${scenario.name}: the first candidate is the draft`)
      assert.ok(await walkTo(ids[ids.length - 1]!), `${scenario.name}: the last candidate is reachable`)
      m.pane.key('\r')
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
  await runMoreRow(m.pane, 'details')
  await waitUntil('details page', () => props(m.pane).title === 'Full model details')
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
  for (const item of props(m.pane).items as Array<Record<string, unknown>>) {
    assert.ok(
      displayWidth(String(item.detail)) <= factLineColumns(true, String(item.label)),
      `every fact row fits its own one-line slot: ${String(item.id)} :: ${String(item.detail)}`,
    )
  }
  // The write outcome is the Status fact, and it is complete there too.
  action(m.pane, 'back')
  await waitUntil('back on the list', () => props(m.pane).title === 'Models')
  // Shift+Tab wraps the ring straight onto the Primary Action from the model list.
  m.pane.key('\u001b[Z')
  await waitUntil('primary action focused', () => String(actionOf(m.pane, 'apply')?.label).startsWith('▸'))
  m.pane.key('\r')
  await waitUntil('pending', () => actionOf(m.pane, 'apply')?.label === 'Selecting…')
  m.settleWrite('rejected')
  await waitUntil('rejected and ready', () => props(m.pane).state === 'ready' && props(m.pane).title === 'Models')
  await runMoreRow(m.pane, 'details')
  await waitUntil('details again', () => props(m.pane).title === 'Full model details')
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
  await runMoreRow(m.pane, 'details')
  await waitUntil('details page', () => props(m.pane).title === 'Full model details')
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

test('native Model: the wide inline selector always keeps the full drill-down', async (t) => {
  const m = await mounted(t)
  await resize(m.pane, 1280)
  await m.ready(budgetDirectory({ providerName: 'p', modelId: 'm', effortNames: ['e1', 'e2', 'e3'] }))
  // The inline rows ARE the primary selector...
  assert.ok(hasEffortCard(m.pane), 'the wide column keeps its inline radio rows')
  // ...and the complete list stays one action away on the More page, in the SAME
  // picker list, with the same draft and the same K2 confirmation. This is the
  // path that keeps every candidate reachable when the environment's font or zoom
  // makes the column's own fit unsure.
  assert.equal(actionOf(m.pane, 'effort-page'), undefined, 'the main bar carries no effort shortcut')
  action(m.pane, 'strip', 'strip-more')
  await waitUntil('more page', () => props(m.pane).title === 'More actions')
  assert.equal(moreRowLabel(m.pane, 'effort-page'), 'All reasoning effort levels…')
  browse(m.pane, moreRowId('effort-page'))
  await waitUntil('effort page', () => props(m.pane).title === 'Reasoning Effort')
  assert.deepEqual(
    (props(m.pane).items as Array<Record<string, unknown>>).map((item) => String(item.id)),
    ['e1', 'e2', 'e3'].map(effortItemId),
    'every advertised candidate is listed',
  )
  assert.equal(props(m.pane).selected, effortItemId('e1'), 'the page shows the same draft the column shows')
  // Returnable: Esc puts back the page the list was opened FROM, then the model list.
  m.pane.key('\u001b')
  await waitUntil('back on the More page', () => props(m.pane).title === 'More actions')
  m.pane.key('\u001b')
  await waitUntil('back on the model list', () => props(m.pane).title === 'Models')
  assert.ok(hasEffortCard(m.pane), 'the inline column is intact after returning')
  // Selectable with the same contract: arrows step the draft, Enter confirms it
  // onto the Primary Action, and only that action writes.
  action(m.pane, 'strip', 'strip-more')
  await waitUntil('more page again', () => props(m.pane).title === 'More actions')
  browse(m.pane, moreRowId('effort-page'))
  await waitUntil('effort page again', () => props(m.pane).title === 'Reasoning Effort')
  m.pane.key('\u001b[B')
  await waitUntil('draft stepped', () => props(m.pane).selected === effortItemId('e2'))
  m.pane.key('\r')
  await waitUntil('primary action focused', () => String(actionOf(m.pane, 'apply')?.label).startsWith('▸'))
  m.pane.key('\r')
  await waitUntil('admitted write', () => m.writes.length === 1)
  assert.equal((m.writes[0] as { reasoningEffort?: string }).reasoningEffort, 'e2')
  m.settleWrite('committed')
  await waitUntil('committed closes the picker', () => picker(m.pane) === undefined)
})

test('native Model: the explicit effort page keeps page, zone, focus and Esc aligned', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  await resize(pane, 1280)
  await m.ready()
  const focused = (id: string) => String(actionOf(pane, id)?.label).startsWith('▸')
  // The wide column keeps its inline radio rows; the complete-effort page stays
  // reachable from the More page (the Owner's always-available page).
  assert.ok(hasEffortCard(pane), 'the wide column keeps its inline radio rows')
  pane.key('\t')
  await waitUntil('strip zone', () => props(pane).focus === 'strip')
  pane.key('\r')
  await waitUntil('more page', () => props(pane).title === 'More actions')
  browse(pane, moreRowId('effort-page'))
  await waitUntil('the explicit effort page is open', () => props(pane).title === 'Reasoning Effort')
  // The PAGE owns the list focus: the wide column beside it is not the surface
  // the keyboard is on.
  assert.equal(props(pane).focus, 'list', 'the explicit page takes the list focus')
  assert.equal(typeof props(pane).selected, 'string', 'the page shows the current draft')
  // Shift+Tab leaves the effort ZONE; the page must leave with it, so the
  // keyboard is on the model list again and its arrows really browse.
  pane.key('\u001b[Z')
  await waitUntil('the page and zone are back on the model list',
    () => props(pane).title === 'Models' && props(pane).focus === 'list')
  const before = props(pane).selected
  pane.key('\u001b[B')
  await waitUntil('the model list really browses again', () => props(pane).selected !== before)
  // The other way out: Enter on the page confirms onto the bar, and Tab from the
  // bar returns to the model list — the page must not stay painted under a model
  // zone. (Walk back to the effort-bearing row first: the other row advertises
  // no efforts, so it has no complete-effort entry at all.)
  pane.key('\u001b[A')
  await waitUntil('back on the effort-bearing row', () => props(pane).selected === before)
  pane.key('\t')
  await waitUntil('strip zone again', () => props(pane).focus === 'strip')
  pane.key('\r')
  await waitUntil('more page again', () => props(pane).title === 'More actions')
  browse(pane, moreRowId('effort-page'))
  await waitUntil('the effort page again', () => props(pane).title === 'Reasoning Effort')
  pane.key('\r')
  await waitUntil('confirmed onto the bar', () => focused('apply'))
  pane.key('\t')
  await waitUntil('Tab from the bar returns to the model list', () => props(pane).title === 'Models')
  assert.equal(props(pane).focus, 'list')
  // Esc in that settled state is the list's Esc: it closes (never a dead Back).
  pane.key('\u001b')
  await waitUntil('Esc closes from the settled list state', () => picker(pane) === undefined)
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
  assert.deepEqual(
    (props(pane).items as Array<Record<string, unknown>>).map((item) => String(item.id)),
    [JSON.stringify(['vendor:供应商', 'm'])],
    'the colon/Unicode provider keeps exactly its own row',
  )
  assert.equal(m.writes.length, 0, 'a scope click is never a write')
  action(pane, 'scope', ALL_SCOPES_ID)
  await waitUntil('every provider again after the colon/Unicode scope', () => props(pane).scope === ALL_SCOPES_ID)
  assert.deepEqual(
    (props(pane).items as Array<Record<string, unknown>>).length,
    3,
    'every provider is listed again',
  )
  // The scope round trip re-aligned the highlight onto the last filtered row, so
  // walk back to the EFFORT-BEARING model before the Effort page cases.
  browse(pane, JSON.stringify(['all', 'm']))
  await waitUntil('the effort-bearing model is highlighted again',
    () => props(pane).selected === JSON.stringify(['all', 'm']))
  action(pane, 'scope', 'scope:all')
  await waitUntil('the `all` provider filters', () => props(pane).scope === 'scope:all')
  assert.equal(
    (props(pane).items as Array<Record<string, unknown>>).length,
    1,
    'the `all` provider keeps exactly its own rows',
  )
  assert.equal(m.writes.length, 0, 'a scope click is never a write')
  action(pane, 'scope', ALL_SCOPES_ID)
  await waitUntil('every provider again', () => props(pane).scope === ALL_SCOPES_ID)
  // On the EFFORT page a candidate row carries its OWN namespace: a candidate whose
  // value looks like a scope id — even the every-provider id — takes the draft, and
  // the page carries no scope column that could be confused with it. The model-list
  // bar offers no effort entry, so the More page is the wire's route there.
  await runMoreRow(pane, 'effort-page')
  await waitUntil('effort page', () => props(pane).title === 'Reasoning Effort')
  assert.equal(props(pane).scopes, undefined, 'the effort page carries no scope column')
  browse(pane, effortItemId(ALL_SCOPES_ID))
  await waitUntil('the every-provider-shaped candidate takes the draft',
    () => props(pane).selected === effortItemId(ALL_SCOPES_ID))
  browse(pane, effortItemId('scope:other'))
  await waitUntil('the prefixed candidate takes the draft',
    () => props(pane).selected === effortItemId('scope:other'))
  assert.equal(m.writes.length, 0, 'a candidate row is never a write')
  // A scope-shaped `select` on this page is not a scope click either, so the two
  // namespaces stay independent in BOTH directions.
  browse(pane, 'scope:all')
  await settle(30)
  assert.equal(props(pane).selected, effortItemId('scope:other'), 'a scope-shaped row select never takes the draft')
  // A NON-ASCII candidate value travels on the ROW channel with its own namespace:
  // it must land in the draft byte-for-byte (no truncation, no scope confusion).
  const unicodeEffort = effortItemId('scope:复杂🚀')
  browse(pane, unicodeEffort)
  await waitUntil('the Unicode candidate takes the draft', () => props(pane).selected === unicodeEffort)
  assert.equal(props(pane).scope, undefined, 'the effort page still carries no scope prop')
  assert.equal(m.writes.length, 0, 'a candidate row is never a write')
  // Returning: the effort page was opened from the More page, so Esc returns there,
  // then the model list restores the scope column with the filter it had.
  pane.key('\u001b')
  await waitUntil('back on the More page', () => props(pane).title === 'More actions')
  pane.key('\u001b')
  await waitUntil('back on the model list', () => props(pane).title === 'Models')
  assert.equal(props(pane).scope, ALL_SCOPES_ID, 'the every-provider filter survived the round trip')
  assert.equal(props(pane).selected, JSON.stringify(['all', 'm']), 'the highlight survived too')
  // ...and the ONE write carries the non-ASCII effort id VERBATIM.
  pane.key('\u001b[Z')
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

test('native Model: the keyboard hint names where the keyboard goes, never a guessed action', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  await m.ready()
  // The list hint names the zone Tab reaches NEXT: the strip's More chip comes
  // first in the ring, so it always reads `Tab: more` on the ready model list.
  assert.ok(sheetText(pane).includes('Tab: more'), sheetText(pane).slice(0, 160))
  // Inside the action bar, Enter runs the action the BAR focused (the ▸ cue names
  // it): the hint must not claim it applies.
  pane.key('\u001b[Z')
  await waitUntil('bar focused on the primary', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  assert.ok(sheetText(pane).includes('←→ · Enter'), sheetText(pane).slice(0, 160))
  assert.ok(!sheetText(pane).includes('Enter: apply'), 'the hint never names a business action')
  // Focus Close and press Enter: the FOCUSED action runs, which is what the hint
  // promised (the bar's own cue said Close).
  for (let step = 0; step < 5 && !String(actionOf(pane, 'close')?.label).startsWith('▸'); step += 1) {
    pane.key('\u001b[D')
    await settle(10)
  }
  await waitUntil('Close takes the bar focus', () => String(actionOf(pane, 'close')?.label).startsWith('▸'))
  assert.ok(sheetText(pane).includes('←→ · Enter'), 'the hint stays true for any focused action')
  pane.key('\r')
  await waitUntil('Enter ran the focused Close', () => picker(pane) === undefined)
  // A model with NO efforts: Tab reaches the strip's More chip (the strip comes
  // first in the ring), so the hint names the More page.
  const plain = await mounted(t)
  await resize(plain.pane, 1280)
  await plain.ready({
    current: { provider: 'a', model: 'same' },
    directory: {
      default: { provider: 'a', model: 'same' },
      routableProviders: ['a'],
      groups: [{ id: 'a', name: 'A', models: [{ id: 'same', name: 'Twin' }] }],
      failures: [],
    },
  })
  assert.ok(sheetText(plain.pane).includes('Tab: more'), sheetText(plain.pane).slice(0, 160))
  plain.handle.close()
  // The details page is a CONTENT page: it renders no side column, so it carries
  // no column hint at all — and above all it must not leak the list's hint and
  // promise a Tab the page cannot honour.
  const detailsPane = await mounted(t)
  await resize(detailsPane.pane, 1280)
  await detailsPane.ready()
  await runMoreRow(detailsPane.pane, 'details')
  await waitUntil('details page', () => props(detailsPane.pane).title === 'Full model details')
  assert.equal(props(detailsPane.pane).preview, 'none')
  const detailsText = sheetText(detailsPane.pane)
  assert.ok(!detailsText.includes('Tab: effort'), 'the details page never promises an effort zone')
  assert.ok(!detailsText.includes('Tab: more') && !detailsText.includes('Tab: actions'),
    'the details page renders no side-column hint')
  // Its static facts still reach the keyboard's own way out: Tab lands in the bar.
  detailsPane.pane.key('\t')
  await waitUntil('the details bar owns the keyboard',
    () => String(actionOf(detailsPane.pane, 'apply')?.label).startsWith('▸'))
  detailsPane.handle.close()
})

test('native Model: the bar never parks its focus on a disabled action', async (t) => {
  // A search with NO match disables the Primary Action: the bar must fall back to an
  // action that can really act (`Close` in a clean catalogue), never to the disabled
  // Primary, which owns no Enter and shows no cue.
  const m = await mounted(t)
  await resize(m.pane, 1280)
  await m.ready({
    current: { provider: 'a', model: 'same' },
    directory: {
      default: { provider: 'a', model: 'same' },
      routableProviders: ['a'],
      groups: [{ id: 'a', name: 'A', models: [{ id: 'same', name: 'Twin' }] }],
      failures: [],
    },
  })
  for (const char of 'zzzz') {
    m.pane.key(char)
    await settle(10)
  }
  await waitUntil('no match', () => (props(m.pane).items as unknown[]).length === 0)
  assert.equal(actionOf(m.pane, 'apply')?.disabled, true, 'the Primary Action is disabled')
  m.pane.key('\u001b[Z')
  await waitUntil('bar focused on an action that can act',
    () => String(actionOf(m.pane, 'close')?.label).startsWith('▸'))
  assert.ok(
    !String(actionOf(m.pane, 'apply')?.label).startsWith('▸'),
    'a disabled action never carries the focus cue',
  )
  m.pane.key('\r')
  await waitUntil('Enter ran that available Close', () => picker(m.pane) === undefined)
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

test('native Model: a failed READ keeps Tab out of an inert effort zone', async (t) => {
  const m = await mounted(t)
  const { pane } = m
  // Partial success: one provider failed, the highlighted model still carries its
  // effort metadata (kept for context when the read later fails for good).
  await m.ready()
  // The model-list bar offers no Retry, so the secondary re-read is reached from
  // the More page (this fixture has one failed provider).
  await runMoreRow(pane, 'retry')
  await waitUntil('the re-read starts', () => props(pane).state === 'loading')
  m.handle.setLoadError('catalog is unreachable')
  await waitUntil('the read failed', () => props(pane).state === 'error')
  assert.equal(m.retries(), 1, 'the first Retry really re-read through the one read owner')
  // ONE Tab must reach the only operable action (Retry), never the stale effort zone;
  // the old rows are still on screen, so this is about the keyboard path, not data.
  pane.key('\t')
  await waitUntil('the barrier went straight to Retry',
    () => String(actionOf(pane, 'apply')?.label).startsWith('▸')
      && String(actionOf(pane, 'apply')?.label).includes('Retry'))
  pane.key('\r')
  await waitUntil('Enter ran that Retry again', () => m.retries() === 2)
  // The symmetric path: the details page is entered while the read is HEALTHY, then the
  // read fails under it — its bar offers only Retry/Close, and one Tab reaches them (a
  // failed read cannot open a page, so the page must be reached before the failure).
  const details = await mounted(t)
  await resize(details.pane, 1280)
  await details.ready()
  await runMoreRow(details.pane, 'details')
  await waitUntil('details page', () => props(details.pane).title === 'Full model details')
  details.handle.setLoadError('catalog is unreachable')
  await waitUntil('the read failed under the details page', () => props(details.pane).state === 'error')
  for (const id of ['details', 'effort-page', 'back']) {
    assert.equal(actionOf(details.pane, id), undefined, `${id} is not offered by a failed read`)
  }
  details.pane.key('\t')
  await waitUntil('the details bar focused Retry',
    () => String(actionOf(details.pane, 'apply')?.label).startsWith('▸'))
  details.pane.key('\r')
  await waitUntil('the details page Retry ran too', () => details.retries() === 1)
  details.handle.close()
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
  await waitUntil('bar focused', () => focused('apply'))
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
    assert.ok(focused('apply') || focused('close'),
      `${name} must not drop the cue into the inert list`)
  }
  // ←→ still move across Retry/Close in that zone (each step its own frame).
  const barFrame = picker(pane)?.id
  pane.key('\u001b[D')
  await waitUntil('Close focused', () => picker(pane)?.id !== barFrame && focused('close'))
  const closeFrame = picker(pane)?.id
  pane.key('\u001b[C')
  await waitUntil('Retry focused again', () => picker(pane)?.id !== closeFrame && focused('apply'))
  // Esc is never swallowed: the failed read has no operable zone to return to, so
  // it closes instead of parking the keyboard in the inert list.
  pane.key('\u001b')
  await waitUntil('Esc closes a failed read', () => picker(pane) === undefined)
  // The symmetric page path: a details page under a failed read. Its page intent
  // cannot be honoured by the phase either (that would land the keyboard in the
  // inert list), so Esc closes instead of being dropped on the floor.
  const details = await mounted(t)
  await resize(details.pane, 1280)
  await details.ready()
  await runMoreRow(details.pane, 'details')
  await waitUntil('details page', () => props(details.pane).title === 'Full model details')
  details.handle.setLoadError('catalog is unreachable')
  await waitUntil('the read failed under the details page', () => props(details.pane).state === 'error')
  details.pane.key('\u001b')
  await waitUntil('Esc closes the failed details page instead of being dropped',
    () => picker(details.pane) === undefined)
  details.handle.close()
})

test('native Model: the paged wide column keeps the bounded identity and the hint', async (t) => {
  const m = await mounted(t, { sessionless: false })
  // A long configured selection plus eight widest-glyph labels: the effort rows
  // cannot be inline, so the column falls back to the bounded summary — which
  // must STILL be action-first (identity + hint), never a facts-only block.
  await resize(m.pane, 1100)
  await m.ready(budgetDirectory({
    providerName: 'openrouter',
    modelId: 'anthropic/claude-3.7-sonnet:thinking',
    effortNames: Array.from({ length: 8 }, () => 'W'.repeat(34)),
    configuredEffort: 'e1',
  }))
  assert.equal(props(m.pane).preview, 'side', 'the wide shell and its column are kept')
  assert.equal(actionOf(m.pane, 'effort-page'), undefined,
    'the main footer carries no effort shortcut')
  assert.equal(hasEffortCard(m.pane), false, 'no inline effort card while paged')
  const text = sheetText(m.pane)
  assert.ok(text.includes('Provider:'), `the bounded column keeps the identity: ${text.slice(0, 200)}`)
  assert.ok(text.includes('ID:'), text.slice(0, 200))
  assert.ok(/Tab: (more|effort|actions)/.test(text), 'the bounded column keeps the keyboard hint')
  // The configured facts follow the identity (the rest stays on the Details page,
  // which the More page offers) and a truncated tail is marked.
  assert.ok(text.includes('Current:'), `the configured facts follow the identity: ${text.slice(0, 200)}`)
  assert.ok(text.includes('…'), 'a capped fact line is marked as truncated')
  assert.deepEqual(
    (props(m.pane).strip as { items?: Array<{ id: string }> }).items,
    [{ id: 'strip-more', label: 'More actions…' }],
    'the complete values stay one action away',
  )
  action(m.pane, 'strip', 'strip-more')
  await waitUntil('more page', () => props(m.pane).title === 'More actions')
  assert.equal(moreRowLabel(m.pane, 'effort-page'), 'All reasoning effort levels…',
    'the complete effort list stays reachable from the More page')
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
  // The wide main bar carries no effort entry: the effort selector IS the preview.
  m.pane.key('\r')
  await waitUntil('wide effort zone', () => props(m.pane).focus === 'preview')
  assert.ok(sheetText(m.pane).includes('e7'), `every candidate is listed: ${sheetText(m.pane).slice(0, 200)}`)
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
  await runMoreRow(m.pane, 'details')
  await waitUntil('details page', () => props(m.pane).title === 'Full model details')
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

test('native Model: a model with no effort gets the same details budget', async (t) => {
  const m = await mounted(t)
  const long = 'Long description '.repeat(35)
  const plain: ModelPickerDirectory = {
    current: { provider: 'p', model: 'm' },
    directory: {
      default: { provider: 'p', model: 'm' },
      routableProviders: ['p'],
      groups: [{ id: 'p', name: 'p', models: [{ id: 'm', name: 'M', description: long }] }],
      failures: [],
    },
  }
  await resize(m.pane, 1100)
  await m.ready(plain)
  // The wide shell is kept, but the card cannot fit: no empty effort selector,
  // and the full description stays readable in the details page.
  assert.equal(props(m.pane).size, 'lg', 'the wide shell is kept')
  assert.equal(hasEffortCard(m.pane), false, 'no effort selector is drawn')
  await runMoreRow(m.pane, 'details')
  await waitUntil('details page', () => props(m.pane).title === 'Full model details')
  assert.equal(actionOf(m.pane, 'effort-page'), undefined, 'the details page offers no empty effort list')
  const rows = (props(m.pane).items as Array<Record<string, unknown>>)
    .filter((item) => String(item.id).startsWith('fact-description'))
  assert.equal(
    rows.map((row) => String(row.detail)).join('').replace(/\s+/g, ''),
    long.replace(/\s+/g, ''),
    'the whole description is readable without any effort selector',
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

test('native Model: the More page runs only the secondary operations it really offers', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  action(pane, 'strip', 'strip-more')
  await waitUntil('the More page', () => props(pane).title === 'More actions')
  const rowIds = (): string[] =>
    (props(pane).items as Array<Record<string, unknown>>).map((item) => String(item.id))
  assert.deepEqual(
    rowIds(),
    ['details', 'effort-page', 'retry', 'back'].map(moreRowId),
    'the More page lists exactly the operations that can act now (this fixture has one failed provider)',
  )
  // A row the page does NOT offer must not resolve to its action: `more:apply`
  // would otherwise reach the ONE writer from a page whose bar carries no write,
  // and `more:close` would close a panel whose bar offers no close.
  browse(pane, 'more:apply')
  browse(pane, moreRowId('close'))
  browse(pane, moreRowId('nope'))
  await settle(30)
  assert.equal(m.writes.length, 0, 'a forged More row can never write')
  assert.ok(picker(pane), 'a forged More row can never close the panel')
  assert.equal(props(pane).title, 'More actions', 'and the page stays where it was')
  // The same root cause on the ACTION channel, not just the row channel: a real
  // `action { act:'apply' }` from a page whose bar carries no write must be
  // refused too (this is the shape a stale receiver would replay).
  const frame = picker(pane)!.id
  action(pane, 'apply')
  await settle(30)
  assert.equal(m.writes.length, 0, 'a direct apply action is refused where the bar offers no write')
  assert.ok(picker(pane), 'and it can never close the panel either')
  assert.equal(picker(pane)!.id, frame, 'and it cannot even cause a re-render')
  // The rows it DOES offer really run, through the same admission as their bar/pointer form.
  browse(pane, moreRowId('details'))
  await waitUntil('the offered details row runs', () => props(pane).title === 'Full model details')
  m.handle.close()
  // Boundary: a search that matches NOTHING has no highlighted model, so the More
  // page must not offer `Full model details…` (it would open an empty page) nor an
  // empty effort entry; Retry (this fixture has one failed provider) and Back stay
  // reachable and still act.
  const empty = await mounted(t)
  await empty.ready()
  const ep = empty.pane
  for (const char of 'zzzz') {
    ep.key(char)
    await settle(10)
  }
  await waitUntil('no match', () => (props(ep).items as unknown[]).length === 0)
  await openMore(ep)
  assert.deepEqual(
    (props(ep).items as Array<Record<string, unknown>>).map((item) => String(item.id)),
    ['retry', 'back'].map(moreRowId),
    'no highlighted model drops the details and effort entries, keeping Retry and Back',
  )
  assert.equal(moreRowLabel(ep, 'details'), undefined, 'no empty details page is offered')
  assert.equal(moreRowLabel(ep, 'effort-page'), undefined, 'no empty effort page is offered')
  assert.equal(moreRowLabel(ep, 'retry'), 'Retry failed providers (1)')
  // Even a FORGED row select for those two ids is refused: no page change, no write.
  const moreFrame = picker(ep)!.id
  browse(ep, moreRowId('details'))
  browse(ep, moreRowId('effort-page'))
  await settle(30)
  assert.equal(props(ep).title, 'More actions', 'an unoffered details/effort row never opens a page')
  assert.equal(picker(ep)!.id, moreFrame, 'and it never even re-renders the More page')
  assert.equal(empty.writes.length, 0, 'an unoffered More row can never write')
  // Back really returns to the list.
  browse(ep, moreRowId('back'))
  await waitUntil('the empty-search Back returns to the list', () => props(ep).title === 'Models')
  assert.equal(props(ep).selected, undefined, 'nothing is highlighted with no match')
  // POSITIVE CONTROL: clear the query so a model is highlighted again — the two
  // dropped rows come back, while Retry and Back keep working.
  for (let index = 0; index < 4; index += 1) ep.key('\u007f')
  await waitUntil('a model is highlighted again', () => (props(ep).items as unknown[]).length > 0)
  await openMore(ep)
  assert.ok(moreRowLabel(ep, 'details'), 'the details row returns with a highlighted model')
  assert.ok(moreRowLabel(ep, 'effort-page'), 'and with it the effort entry its efforts advertise')
  browse(ep, moreRowId('back'))
  await waitUntil('back again', () => props(ep).title === 'Models')
  await openMore(ep)
  browse(ep, moreRowId('retry'))
  await waitUntil('the empty-search Retry re-reads', () => props(ep).state === 'loading')
  assert.equal(empty.retries(), 1, 'Retry stays reachable')
  ep.key('\u001b')
  await waitUntil('Esc closes the re-read', () => picker(ep) === undefined)
  empty.handle.close()
})

test('native Model: the highlighted row states its own drafted effort', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  const B_SAME = JSON.stringify(['b', 'same'])
  const rowDetail = (id: string): string | undefined =>
    ((props(pane).items ?? []) as Array<Record<string, unknown>>)
      .find((item) => String(item.id) === id)?.detail as string | undefined
  // (a) The highlighted effort-bearing model states its seeded draft; the model
  // without advertised efforts keeps its plain provider detail.
  assert.equal(props(pane).selected, SAME_A, 'the configured default starts highlighted')
  assert.equal(rowDetail(SAME_A), 'A · High', 'the highlighted row carries its seeded effort label')
  assert.equal(rowDetail(B_SAME), 'B', 'a model with no advertised efforts keeps the plain provider detail')
  // (b) Draft another effort on the effort page and return: the highlighted row
  // follows the NEW draft.
  await runMoreRow(pane, 'effort-page')
  await waitUntil('effort page', () => props(pane).title === 'Reasoning Effort')
  browse(pane, effortItemId('low'))
  await waitUntil('the draft moved', () => props(pane).selected === effortItemId('low'))
  action(pane, 'back')
  await waitUntil('back on the More page', () => props(pane).title === 'More actions')
  action(pane, 'back')
  await waitUntil('back on the model list', () => props(pane).title === 'Models')
  assert.equal(rowDetail(SAME_A), 'A · Low', 'the highlighted row states the NEW draft')
  assert.equal(rowDetail(B_SAME), 'B', 'the other row is untouched')
  // (c) ONLY the highlighted row states an effort: the effort-bearing row drops the
  // suffix as soon as another model becomes the target.
  browse(pane, B_SAME)
  await waitUntil('the plain model is highlighted', () => props(pane).selected === B_SAME)
  assert.equal(rowDetail(B_SAME), 'B', 'the highlighted no-effort model keeps the plain detail')
  assert.equal(rowDetail(SAME_A), 'A', 'an unhighlighted effort-bearing row states no effort')
  m.handle.close()
})
