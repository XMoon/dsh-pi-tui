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
// only the bound from the implementation).
import { displayWidth, factLineColumns } from '../src/tui/tsp/model-picker-state.ts'
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

test('native Model B2: provider scope, radio-row draft and the single explicit Apply', async (t) => {
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
  // A provider scope filters (browse state); it is never a write.
  browse(pane, 'scope:a')
  await waitUntil('scope filters', () => props(pane).scope === 'scope:a')
  assert.equal(m.writes.length, 0, 'a scope click is never a write')
  browse(pane, 'scope:all')
  await waitUntil('scope clears', () => props(pane).scope === 'scope:all')
  browse(pane, SAME_A)
  await waitUntil('provider A', () => props(pane).selected === SAME_A)
  // The effort rows dispatch `onClick` through the SDK into the SAME admission
  // point: they only change the local draft.
  click(pane, clickRow(pane, 'effort-high'))
  await waitUntil('draft effort', () =>
    props(pane).focus === 'preview'
    && layerNodes(pane).some((n) => n.id.includes('effort-high') && n.p.tone === 'accent'))
  assert.equal(m.writes.length, 0, 'an effort row click never writes')
  pane.key('\t')
  pane.key('\r')
  await waitUntil('one admitted write', () => m.writes.length === 1)
  assert.deepEqual(m.writes, [{ provider: 'a', model: 'same', reasoningEffort: 'high' }])
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
  await waitUntil('primary zone', () => sheetText(pane).includes('Enter: apply'))
  assert.equal(
    actionOf(pane, 'apply')?.label,
    '▸ Save default',
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
    pane.key('\t')
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
  // Wide -> compact: the same panel switches to the drill-down layout.
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
  action(pane, 'details')
  await waitUntil('details page', () => String(props(pane).title).startsWith('Model details'))
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
  await waitUntil('back to the list', () => String(props(pane).title).startsWith('Models'))
  // The effort page lists the real draft candidates; an arrow changes the DRAFT
  // (from the configured `High` to the provider default), Enter confirms it into
  // the Primary Action, and only there does Enter commit.
  action(pane, 'effort-page')
  await waitUntil('effort page', () => String(props(pane).title).startsWith('Reasoning Effort'))
  pane.key('\u001b[B')
  await waitUntil('draft moved', () => props(pane).selected === '\u0000provider-default')
  assert.equal(m.writes.length, 0, 'choosing a draft never writes')
  pane.key('\r')
  await waitUntil('primary zone shape cue', () => actionOf(pane, 'apply')?.label === '▸ Save default')
  pane.key('\r')
  await waitUntil('write from the compact primary action', () => m.writes.length === 1)
  assert.deepEqual(
    m.writes,
    [{ provider: 'p', model: 'm' }],
    'the provider-default draft submits WITHOUT a reasoningEffort literal',
  )
  // A refusal re-enables the panel with the chosen draft intact, and the draft
  // survives the flip back to the wide layout.
  m.settleWrite('rejected')
  await waitUntil('refusal restores the panel', () => actionOf(pane, 'apply')?.label === 'Save default')
  await resize(pane, 130)
  await waitUntil('wide again', () => props(pane).size === 'lg')
  assert.ok(
    layerNodes(pane).some((n) => n.id.includes('provider-default') && n.p.tone === 'accent'),
    'the draft chosen in the compact page is the wide layout\'s draft',
  )
})

test('native Model: browsing, effort, graphemes, modal and stale receiver fences', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  action(pane, 'unknown-action')
  browse(pane, 'scope:bad')
  browse(pane, JSON.stringify(['nope', 'nope']))
  pane.event({ ev: 'action', sf: 'retired-surface', id: picker(pane)!.id, act: 'apply' })
  await settle(30)
  assert.equal(m.writes.length, 0, 'unknown action, failure scopes, foreign surfaces and unlisted rows never write')
  const oldId = picker(pane)!.id
  const lowRow = clickRow(pane, 'effort-low')
  const approval = m.renderer.interaction.showApprovalPrompt(
    { toolName: 'bash', reason: 'modal precedence' },
    false,
  )
  await settle(30)
  action(pane, 'apply', undefined, oldId)
  click(pane, lowRow)
  await settle(30)
  assert.equal(m.writes.length, 0, 'approval masks the model write seat')
  assert.equal(layerNodes(pane).length, 0, 'the modal owns the layer')
  pane.key('\u001b')
  await approval
  await waitUntil('model resumes', () => picker(pane) !== undefined && picker(pane)!.id !== oldId)
  action(pane, 'apply', undefined, oldId)
  click(pane, lowRow)
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
    boot.pane.key('\t')
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
    boot.pane.key('\t')
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
    // Select a model the live Session does NOT use, so the write is a real
    // change and the authoritative reread has something new to report.
    browse(fixture.pane, JSON.stringify(['scripted', DIRECT_TSP_MODEL_TWO]))
    await waitFor('second model highlighted', () =>
      props(fixture.pane).selected === JSON.stringify(['scripted', DIRECT_TSP_MODEL_TWO]))
    assert.equal(records.length, 0, 'highlighting a model never writes')
    fixture.pane.key('\t')
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
    // details page (the details column carries the bounded summary).
    assert.equal(props(fixture.pane).size, 'lg', 'the wide shell is kept')
    assert.equal(props(fixture.pane).preview, 'side', 'the details column is kept')
    action(fixture.pane, 'details')
    await waitFor('details page', () => props(fixture.pane).title === 'Model details')
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
  await waitUntil('the draft is visible on the effort page', () => props(pane).selected === 'high')
  pane.key('\u001b[B')
  await waitUntil('visible draft change', () => props(pane).selected === '\u0000provider-default')
  assert.equal(m.writes.length, 0, 'changing a draft never writes')
})

test('native Model: every visible action is keyboard reachable and never a no-op', async (t) => {
  const m = await mounted(t)
  await m.ready()
  const { pane } = m
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  // Shift+Tab reaches the bar from the model list (the frozen reverse cycle);
  // ←→ moves the focused action and the cue names what Enter would run.
  const focused = (id: string) => String(actionOf(pane, id)?.label).startsWith('▸')
  pane.key('\u001b[Z')
  await waitUntil('bar focused on the primary', () => focused('apply'))
  pane.key('\u001b[D')
  await waitUntil('retry focused', () => focused('retry'))
  pane.key('\u001b[D')
  await waitUntil('effort entry focused', () => focused('effort-page'))
  pane.key('\u001b[D')
  await waitUntil('details focused', () => focused('details'))
  assert.equal(props(pane).title, 'Models', 'moving the bar focus never changes the page')
  pane.key('\r')
  await waitUntil('keyboard opened Details', () => props(pane).title === 'Model details')
  // The details page's own bar: ← from the primary walks back to Back.
  pane.key('\u001b[Z')
  await waitUntil('details bar focused', () => focused('apply'))
  pane.key('\u001b[D')
  await waitUntil('details retry focused', () => focused('retry'))
  pane.key('\u001b[D')
  await waitUntil('details effort focused', () => focused('effort-page'))
  pane.key('\u001b[D')
  await waitUntil('details back focused', () => focused('back'))
  pane.key('\r')
  await waitUntil('keyboard returned to the list', () => props(pane).title === 'Models')
  // The partial-failure Retry is keyboard reachable and re-reads, never writes.
  // Entering the models page reset the zone to the list, so Shift+Tab re-enters
  // the bar (the frozen reverse cycle) before the Retry can be focused.
  const before = m.retries()
  pane.key('\u001b[Z')
  await waitUntil('bar focused again', () => focused('apply'))
  pane.key('\u001b[D')
  await waitUntil('retry focused again', () => focused('retry'))
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
  action(pane, 'effort-page')
  await waitUntil('effort page', () => props(pane).title === 'Reasoning Effort')
  assert.equal(
    actionOf(pane, 'effort-page'),
    undefined,
    'the effort page offers no second, contradictory selector entry',
  )
  action(pane, 'back')
  await waitUntil('back to the models page', () => props(pane).title === 'Models')
  await waitUntil('and back to the models zone', () => sheetText(pane).includes('↑↓ browse')
    || String(actionOf(pane, 'apply')?.label) === 'Save default')
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
  assert.equal(props(pane).strip, undefined)
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
  action(m.pane, 'details')
  await settle(50)
  await waitUntil('details page', () => props(m.pane).title === 'Model details')
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
  await waitUntil('back on the model list', () => sheetText(pane).includes('Tab: actions'))
  assert.equal(props(pane).focus, 'list')
  assert.equal(m.writes.length, 0)
  // details -> Primary -> Esc stays on the details page.
  await resize(pane, 100)
  await waitUntil('compact', () => props(pane).size === 'md')
  action(pane, 'details')
  await waitUntil('details page', () => props(pane).title === 'Model details')
  pane.key('\t')
  await waitUntil('details primary', () => String(actionOf(pane, 'apply')?.label).startsWith('▸'))
  pane.key('\u001b')
  await waitUntil('still on the details page', () => props(pane).title === 'Model details')
  // details -> Choose effort -> Esc returns to the DETAILS page (not the list).
  action(pane, 'effort-page')
  await waitUntil('effort page', () => props(pane).title === 'Reasoning Effort')
  // Its visible Back must agree with Esc: both return to the DETAILS page.
  action(pane, 'back')
  await waitUntil('Back returned to the details page', () => props(pane).title === 'Model details')
  action(pane, 'effort-page')
  await waitUntil('effort page again', () => props(pane).title === 'Reasoning Effort')
  pane.key('\u001b')
  await waitUntil('Esc returns to the details page', () => props(pane).title === 'Model details')
  pane.key('\u001b')
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
    action(live.pane, 'details')
    await waitUntil('details page', () => props(live.pane).title === 'Model details')
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
    action(sessionless.pane, 'details')
    await waitUntil('details page', () => props(sessionless.pane).title === 'Model details')
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
  action(m.pane, 'effort-page')
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
  action(m.pane, 'details')
  await waitUntil('details page', () => props(m.pane).title === 'Model details')
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
  action(m.pane, 'details')
  await waitUntil('CJK details page', () => props(m.pane).title === 'Model details')
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
  // PENDING: the same, with the honest Selecting… label.
  await m.ready()
  m.pane.key('\t')
  await waitUntil('effort zone', () => props(m.pane).focus === 'list'
    && props(m.pane).title === 'Reasoning Effort')
  m.pane.key('\t')
  await waitUntil('primary action focused', () => String(actionOf(m.pane, 'apply')?.label).startsWith('▸'))
  m.pane.key('\r')
  await waitUntil('pending', () => actionOf(m.pane, 'apply')?.label === 'Selecting…')
  for (const id of ['details', 'back', 'effort-page', 'retry']) {
    assert.equal(actionOf(m.pane, id), undefined, `${id} is not offered while pending`)
  }
  m.settleWrite('rejected')
  await waitUntil('ready again', () => actionOf(m.pane, 'apply')?.label === 'Save default')
  assert.ok(actionOf(m.pane, 'details'), 'the browse actions return with ready')
  // READ ERROR: only Close and the read-only Retry stay reachable.
  m.handle.setLoadError('catalog is unreachable')
  await waitUntil('error', () => props(m.pane).state === 'error')
  for (const id of ['details', 'back', 'effort-page', 'retry']) {
    assert.equal(actionOf(m.pane, id), undefined, `${id} is not offered in the error state`)
  }
  assert.equal(actionOf(m.pane, 'apply')?.label, 'Retry')
  assert.ok(actionOf(m.pane, 'close'))
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
    // The inline signal is the EFFORT CARD itself: the `Choose effort` entry is
    // offered in every layout (the drill-down path), so its absence no longer
    // says anything about the column.
    const inline = hasEffortCard(m.pane)
    assert.ok(actionOf(m.pane, 'effort-page'),
      `${scenario.name}: the drill-down entry stays offered at every width`)
    assert.ok(
      inline
        || (text.includes('Provider:') && text.includes('ID:') && text.includes('Tab: actions')),
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
      action(m.pane, 'effort-page')
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
  action(m.pane, 'details')
  await waitUntil('details page', () => props(m.pane).title === 'Model details')
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
  m.pane.key('\t')
  m.pane.key('\t')
  await waitUntil('primary action focused', () => String(actionOf(m.pane, 'apply')?.label).startsWith('▸'))
  m.pane.key('\r')
  await waitUntil('pending', () => actionOf(m.pane, 'apply')?.label === 'Selecting…')
  m.settleWrite('rejected')
  await waitUntil('rejected and ready', () => props(m.pane).state === 'ready' && props(m.pane).title === 'Models')
  action(m.pane, 'details')
  await waitUntil('details again', () => props(m.pane).title === 'Model details')
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
  action(m.pane, 'details')
  await waitUntil('details page', () => props(m.pane).title === 'Model details')
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
  // ...and the complete list stays one action away, in the SAME picker list, with
  // the same draft and the same K2 confirmation. This is the path that keeps
  // every candidate reachable when the environment's font or zoom makes the
  // column's own fit unsure.
  assert.ok(actionOf(m.pane, 'effort-page'), 'the drill-down entry is offered while the rows are inline')
  action(m.pane, 'effort-page')
  await waitUntil('effort page', () => props(m.pane).title === 'Reasoning Effort')
  assert.deepEqual(
    (props(m.pane).items as Array<Record<string, unknown>>).map((item) => String(item.id)),
    ['e1', 'e2', 'e3'],
    'every advertised candidate is listed',
  )
  assert.equal(props(m.pane).selected, 'e1', 'the page shows the same draft the column shows')
  // Returnable: Esc puts the model list (and its inline rows) back.
  m.pane.key('\u001b')
  await waitUntil('back on the model list', () => props(m.pane).title === 'Models')
  assert.ok(hasEffortCard(m.pane), 'the inline column is intact after returning')
  // Selectable with the same contract: arrows step the draft, Enter confirms it
  // onto the Primary Action, and only that action writes.
  action(m.pane, 'effort-page')
  await waitUntil('effort page again', () => props(m.pane).title === 'Reasoning Effort')
  m.pane.key('\u001b[B')
  await waitUntil('draft stepped', () => props(m.pane).selected === 'e2')
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
  // wide + INLINE: the column keeps its radio rows, and the drill-down entry is
  // still offered (the Owner's always-available page).
  assert.ok(hasEffortCard(pane), 'the wide column keeps the inline rows')
  pane.key('\t')
  await waitUntil('inline effort zone', () => props(pane).focus === 'preview')
  pane.key('\t')
  await waitUntil('primary action focused', () => focused('apply'))
  pane.key('\u001b[D')
  pane.key('\u001b[D')
  await waitUntil('the drill-down entry is focused', () => focused('effort-page'))
  pane.key('\r')
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
  // no efforts, so it has no drill-down entry at all.)
  pane.key('\u001b[A')
  await waitUntil('back on the effort-bearing row', () => props(pane).selected === before)
  action(pane, 'effort-page')
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
  assert.ok(actionOf(m.pane, 'effort-page'), 'the radio rows do not fit inline')
  assert.equal(hasEffortCard(m.pane), false, 'no inline effort card while paged')
  const text = sheetText(m.pane)
  assert.ok(text.includes('Provider:'), `the bounded column keeps the identity: ${text.slice(0, 200)}`)
  assert.ok(text.includes('ID:'), text.slice(0, 200))
  assert.ok(text.includes('Tab: actions'), 'the bounded column keeps the keyboard hint')
  // The configured facts follow the identity (the rest stays on the Details
  // page, which the action bar offers) and a truncated tail is marked.
  assert.ok(text.includes('Current:'), `the configured facts follow the identity: ${text.slice(0, 200)}`)
  assert.ok(text.includes('…'), 'a capped fact line is marked as truncated')
  assert.ok(actionOf(m.pane, 'details'), 'the complete values stay one action away')
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
  // The wide action bar has no page entries: the effort selector IS the preview.
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
  action(m.pane, 'details')
  await waitUntil('details page', () => props(m.pane).title === 'Model details')
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
  assert.equal(actionOf(m.pane, 'effort-page'), undefined, 'no empty effort selector')
  assert.equal(hasEffortCard(m.pane), false, 'no effort selector is drawn')
  action(m.pane, 'details')
  await waitUntil('details page', () => props(m.pane).title === 'Model details')
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
