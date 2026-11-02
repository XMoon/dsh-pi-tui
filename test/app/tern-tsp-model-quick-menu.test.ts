/**
 * TSP-7 PR-G: the Quiet Composer's combined Model / Reasoning Effort quick menu.
 *
 * The obligation this file owns is the ONE chain the product contract promises:
 *
 *   wire click → the production renderer's seat → the SAME registered `/model`
 *   command owner (one directory read, one writer, one pending marker) → the
 *   quick presentation → the authoritative Session projection.
 *
 * Three harnesses, each for the layer it can actually prove:
 *
 * 1. the PRODUCTION `mountTspRenderer` over the scripted Tern pane, opening the
 *    panel through the renderer's own `modelPresentation.openQuick` seam — the
 *    same call the registered command makes — and asserting on the REAL
 *    reconciled wire tree (node kinds, keys, texts, focus and reveal ops). The
 *    `ModelPickerRequest` is the command's BOUNDARY STUB: it records the payload
 *    `apply` received and settles with an outcome the test chooses. Nothing here
 *    pre-computes a decision the presenter is supposed to make.
 * 2. the official Direct composition (`createDirectTspFixture`) with the REAL
 *    registered `/model` command, the real `DirectModelCatalog` and the real
 *    durable Session writer, recorded at that port.
 * 3. the command owner itself (`createModelCommands`) to prove the quick and full
 *    presentations share one read, one writer and one request.
 *
 * No case here instantiates `TspModelQuickMenu` on its own: that would prove
 * nothing about the wiring this feature is about.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-model-quick-menu.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { createModelCommands, type ModelCommandDeps } from '../../src/tui/commands/models.ts'
import type {
  ModelApplyOutcome,
  ModelPickerHandle,
  ModelPickerRequest,
  ModelPresentation,
} from '../../src/app/command/model-presentation.ts'
import type { ModelDirectoryDto, ModelSelectionDto } from '../../src/runtime/catalog-port.ts'
import { emptyStatusSnapshot, type StatusSnapshot, type StatusSnapshotReader } from '../../src/domain/status/types.ts'
import { runOwned } from '../../src/runtime/process/tasks.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'
import { wireNodes, type WireNode } from '../support/tsp-picker-wire.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  DIRECT_TSP_MODEL_TWO,
  DIRECT_TSP_PROVIDER,
  createDirectTspFixture,
  waitFor,
} from '../support/direct-tsp-fixture.ts'
import { DirectModelCatalog } from '../../src/runtime/direct/catalog-direct.ts'

const STACK_ID = 'dock.quiet-composer.composer-controls.composer-right.composer-model-stack'
const MENU_PREFIX = `${STACK_ID}.composer-quick-menu-`
const LIVE_SUBJECT = { sessionless: false }
const SILENT_DIAG = { debug() {}, warn() {}, error() {} } as never

/* ------------------------------------------------------------------ wire reads */

function nodeKey(node: WireNode): string {
  return String(node.p['key'] ?? '')
}

function nodeById(pane: TspPane, id: string): WireNode | undefined {
  return wireNodes(pane).find(node => node.id === id)
}

function menuNodes(pane: TspPane): WireNode[] {
  return wireNodes(pane).filter(node => node.id.startsWith(MENU_PREFIX))
}

function menuMounted(pane: TspPane): boolean {
  return menuNodes(pane).length > 0
}

/**
 * One menu ACTION node by its paint token. An action key is
 * `q<serial>-r<revision>-<token>`: the revision is what makes a lagging client
 * event resolve to nothing at all (the SDK dispatches an event by the id of the
 * view it LAST rendered), so a test — like the renderer — never addresses a row
 * through an id it remembered across a repaint; it looks the CURRENT frame up
 * by token.
 */
function menuAction(pane: TspPane, token: string): WireNode {
  const suffix = `-${token}`
  const node = menuNodes(pane).find(entry => entry.p['tag'] === 'button' && nodeKey(entry).endsWith(suffix))
  assert.ok(node, `no menu action "${token}" among ${menuNodes(pane).map(nodeKey).join(', ')}`)
  return node
}

/** One panel-stable menu container node (the search field, the notice line). */
function menuNode(pane: TspPane, token: string): WireNode | undefined {
  const suffix = `-${token}`
  return menuNodes(pane).find(entry => nodeKey(entry) === token || nodeKey(entry).endsWith(suffix))
}

/** The body rows of the current page, in paint order (their token is the index). */
function menuBodyRows(pane: TspPane): WireNode[] {
  return menuNodes(pane)
    .filter(node => /-o\d+$/.test(nodeKey(node)) && node.p['tag'] === 'button')
    .sort((a, b) => Number(nodeKey(a).replace(/^.*-o/, '')) - Number(nodeKey(b).replace(/^.*-o/, '')))
}

/**
 * One node's visible text, resolved through the LIVE node set by the wire id
 * hierarchy. The wire fold keeps the `add`-time child objects on the parent and
 * a repaint updates only the indexed copy — and a child that APPEARS (the
 * trigger's effort part) never enters the old child list at all — so the
 * subtree is re-discovered from the ids, never from a stale `c` array. Leaves
 * only: a container's own text is never double counted.
 */
function nodeText(pane: TspPane, node: WireNode | undefined): string {
  if (node === undefined) return ''
  const own = node.p['text']
  if (typeof own === 'string' && own !== '') return own
  const subtree = wireNodes(pane).filter(entry => entry.id.startsWith(`${node.id}.`))
  const hasText = (entry: WireNode): boolean => typeof entry.p['text'] === 'string' && entry.p['text'] !== ''
  const leafTexts = subtree.filter(entry => hasText(entry)
    && !subtree.some(child => child.id.startsWith(`${entry.id}.`) && hasText(child)))
  return leafTexts.map(entry => String(entry.p['text'])).join(' ')
}

/** The readable text of one node, with internal whitespace runs collapsed: the
 *  view spaces label / value / chevron with CSS `gap`, never with literal text. */
function text(pane: TspPane, node: WireNode | undefined): string {
  return nodeText(pane, node).replace(/\s+/g, ' ').trim()
}

function labelOf(pane: TspPane, token: string): string {
  return text(pane, menuAction(pane, token))
}

/** The current page's body labels, in paint order. */
function bodyLabels(pane: TspPane): string[] {
  return menuBodyRows(pane).map(node => text(pane, node))
}

function attrOf(node: WireNode | undefined, name: string): string | undefined {
  // A prop the SDK removed arrives as an explicit null (the diff sends a
  // `set {attrs: null}`), which means the same absence as no attrs at all.
  const attrs = node?.p['attrs'] as Record<string, unknown> | null | undefined
  if (attrs === undefined || attrs === null) return undefined
  return attrs[name] === undefined ? undefined : String(attrs[name])
}

/** The panel serial the CURRENT frame's menu node carries. */
function panelSerialOf(pane: TspPane): number {
  const menu = menuNodes(pane).find(node => node.id.startsWith(MENU_PREFIX))
  assert.ok(menu, 'the quick menu is mounted')
  return Number(nodeKey(menu!).replace('composer-quick-menu-', ''))
}

function click(pane: TspPane, node: WireNode): void {
  pane.event({ ev: 'action', sf: pane.frames().at(-1)!.sf, id: node.id, act: 'click' })
}

function clickTrigger(pane: TspPane): void {
  const trigger = wireNodes(pane).find(node => nodeKey(node).startsWith('composer-model-quick'))
  assert.ok(trigger, 'the combined Model·Effort trigger is on the wire')
  click(pane, trigger!)
}

/** Every focus/reveal op the SDK really sent, in order (the wire is the oracle;
 *  a renderer-local call is not the client's caret or viewport). */
function frameOps(pane: TspPane, kind: 'focus' | 'reveal'): string[] {
  const out: string[] = []
  for (const frame of pane.frames()) {
    for (const op of frame.ops) {
      if (op[0] !== kind) continue
      out.push(op[1] === null || op[1] === undefined ? 'null' : String(op[1]))
    }
  }
  return out
}

/** The composer editor's controlled text/caret as the committed frame carries it:
 *  the observable fact behind the "the draft and caret never moved" contract. */
function editorState(pane: TspPane): { text: string; cursor: number } {
  const editor = nodeById(pane, 'dock.quiet-composer.composer')
  assert.ok(editor, 'the controlled composer editor is mounted')
  return { text: String(editor!.p['text'] ?? ''), cursor: Number(editor!.p['cursor'] ?? 0) }
}

/* ----------------------------------------------------------------- the fixture */

/** A directory with everything the quick menu must respect: two providers, the
 *  SAME model id under both, one model with a declared default effort, one with
 *  candidates but NO declared default (the provider-default sentinel), one with
 *  no reasoning metadata at all, and one provider whose read failed. */
function quickDirectory(current: ModelSelectionDto): ModelDirectoryDto {
  return {
    default: { provider: 'alpha', model: 'a-one' },
    routableProviders: ['alpha', 'beta'],
    groups: [
      {
        id: 'alpha',
        name: 'Alpha AI',
        models: [
          { id: 'a-one', name: 'Alpha One', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' } },
          { id: 'same', name: 'Twin' },
          { id: 'a-two', name: 'Alpha Two', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }] } },
        ],
      },
      { id: 'beta', name: 'Beta', models: [{ id: 'same', name: 'Twin (Beta)' }] },
    ],
    failures: [{ id: 'gamma', name: 'Gamma', message: 'provider gamma is unreachable' }],
  }
}

function snapshotWithModel(displayName: string, reasoningEffort?: string): StatusSnapshot {
  const base = emptyStatusSnapshot()
  return {
    ...base,
    composition: {
      model: {
        displayName,
        id: displayName,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
    },
    access: { permissionPreset: { id: 'workspace-write', label: 'Workspace Write', matched: true } },
  } as StatusSnapshot
}

interface QuickHarness {
  readonly pane: TspPane
  readonly renderer: TspRenderer
  /** What the command-side boundary stub was handed. */
  readonly applied: ModelSelectionDto[]
  readonly owned: string[]
  readonly entries: { full: Array<'models' | 'effort'>; quick: number }
  readonly counts: { retries: number; cancels: number; submits: number }
  /** The handle of the panel the last open minted (the command's read owner). */
  handle(): ModelPickerHandle
  panelSerial(): number
  open(): void
  openAndHydrate(current: ModelSelectionDto): Promise<number>
  /** Settle the in-flight quick write with a real outcome kind. */
  settle(outcome: ModelApplyOutcome): void
  dispose(): Promise<void>
}

async function mountedQuick(options: {
  readonly pane?: Parameters<typeof installTspPane>[0]
  readonly status?: StatusSnapshot
} = {}): Promise<QuickHarness> {
  const pane = installTspPane(options.pane ?? {
    modelPicker: true,
    composerActions: true,
    modelQuick: true,
  })
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, {
    copyVisual: async () => false,
    requestExit() {},
    onFatal: (error) => assert.fail(String(error)),
  })
  const applied: ModelSelectionDto[] = []
  const owned: string[] = []
  const entries = { full: [] as Array<'models' | 'effort'>, quick: 0 }
  const counts = { retries: 0, cancels: 0, submits: 0 }
  let settleWrite: ((outcome: ModelApplyOutcome) => void) | undefined
  let handle!: ModelPickerHandle
  let current = options.status ?? snapshotWithModel('Alpha One', 'high')
  const reader: StatusSnapshotReader = { snapshot: () => current }
  renderer.bindStatusReader(reader)
  const presentation = renderer.modelPresentation
  assert.ok(presentation, 'the pane negotiated the native model presentation')
  assert.ok(presentation.openQuick, 'the TSP presenter offers the quick presentation variant')
  // The request the registered `/model` command builds. `apply` is the command's
  // ONE writer seam: this boundary stub records the payload and returns a promise
  // the test settles with a real outcome kind, exactly as the command resolves a
  // semantic settlement for the presenter.
  const buildRequest = (): ModelPickerRequest => ({
    subject: LIVE_SUBJECT,
    entry: 'models',
    isCurrent: () => true,
    retry: () => { counts.retries += 1 },
    apply: (selection) => new Promise<ModelApplyOutcome>((resolve) => {
      applied.push(selection)
      settleWrite = resolve
    }),
    runOwned: (label, task, ownedOptions) => {
      owned.push(label)
      runOwned(label, task, { ...ownedOptions, diag: SILENT_DIAG })
    },
  })
  renderer.bindInput({
    exit() {},
    cancel: () => { counts.cancels += 1 },
    submit: () => { counts.submits += 1 },
    steer() {},
    pasteMedia() {},
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker: entry => { entries.full.push(entry) },
    openModelQuick: () => {
      entries.quick += 1
      handle = presentation.openQuick!(buildRequest())
    },
    modelPickerAvailable: () => true,
    permissionOptions: () => ['read-only', 'workspace-write', 'danger-full-access'],
    selectPermission: () => {},
  })
  renderer.display.commitDisplaySubject({}, {}, undefined)
  await settle(60)
  return {
    pane,
    renderer,
    applied,
    owned,
    entries,
    counts,
    handle: () => handle,
    panelSerial: () => panelSerialOf(pane),
    open: () => { clickTrigger(pane) },
    async openAndHydrate(selection) {
      clickTrigger(pane)
      await waitUntil('the menu mounted', () => menuMounted(pane))
      handle.setDirectory({ directory: quickDirectory(selection), current: selection })
      await waitUntil('the menu hydrated', () => menuNodes(pane).some(node => nodeKey(node).endsWith('-full'))
        && menuBodyRows(pane).length >= 1)
      await settle(30)
      return panelSerialOf(pane)
    },
    settle: (outcome) => {
      const resolve = settleWrite
      settleWrite = undefined
      assert.ok(resolve, 'a quick write is in flight')
      resolve(outcome)
    },
    dispose: () => renderer.dispose(),
  }
}

/* ========================================== Q01/Q02: the trigger and the seat */

test('Q01 the composer carries exactly ONE combined Model·Effort trigger', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  const trigger = wireNodes(pane).find(node => nodeKey(node).startsWith('composer-model-quick'))
  assert.ok(trigger, 'the combined trigger is mounted')
  assert.equal(wireNodes(pane).filter(node => /composer-effort/.test(nodeKey(node))).length, 0,
    'the retired Effort-only control does not survive, not even hidden')
  assert.ok(nodeById(pane, STACK_ID), 'the trigger owns its own anchoring container')
  assert.equal(trigger!.id.startsWith(`${STACK_ID}.`), true, 'the trigger lives inside that container')
  // BOTH committed facts on one control; the title carries the complete values.
  assert.equal(text(pane, trigger).includes('Alpha One'), true)
  assert.equal(text(pane, trigger).includes('high'), true)
  assert.equal(String(trigger!.p['title']), 'Alpha One · high — model and reasoning effort')
  assert.equal(attrOf(trigger, 'aria-disabled'), undefined, 'the real business entry keeps it operable')
  // Permission and Send keep their own nodes and places.
  for (const key of ['composer-permission-s', 'composer-send-s']) {
    assert.ok(wireNodes(pane).some(node => nodeKey(node).startsWith(key)), `${key} is still mounted`)
  }
})

test('Q01 an absent effort fact paints no effort slot and invents no value', async (t) => {
  const m = await mountedQuick({ status: snapshotWithModel('Alpha One') })
  t.after(() => { void m.dispose() })
  const parts = wireNodes(m.pane)
    .filter(node => /^model-(name|effort|chevron)$/.test(nodeKey(node)))
    .map(node => nodeKey(node))
  assert.deepEqual(parts, ['model-name', 'model-chevron'],
    'no empty effort slot is reserved when the Session declares no effort')
})

test('Q02 the trigger opens the anchored menu and takes no Composer height', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  const shellChildrenBefore = ((nodeById(pane, 'dock.quiet-composer')?.c ?? []) as unknown as WireNode[]).length
  const editorBefore = editorState(pane)
  m.open()
  // The FIRST frame is the loading state: the menu exists before any read does.
  await waitUntil('the loading menu frame committed', () => menuMounted(pane))
  assert.equal(m.entries.quick, 1, 'the registered quick entry ran exactly once')
  assert.deepEqual(m.entries.full, [], 'the full panel never opened')
  const serial = m.panelSerial()
  assert.equal(text(pane, menuNode(pane, 'notice')), 'Loading models…',
    'the first frame states the read it is waiting for')
  assert.deepEqual(bodyLabels(pane), ['Model ›'],
    'the root is navigable while the read runs, and no directory-derived value is invented')
  assert.equal(attrOf(menuAction(pane, 'o0'), 'data-selected'), undefined,
    'no current model is claimed before the read settles')
  assert.ok(nodeById(pane, `${MENU_PREFIX}${serial}`), 'the menu is a child of the trigger container')
  assert.equal(((nodeById(pane, 'dock.quiet-composer')?.c ?? []) as unknown as WireNode[]).length, shellChildrenBefore,
    'the menu adds no row to the Composer shell')
  assert.deepEqual(editorState(pane), editorBefore, 'the covered editor keeps its exact text and caret')
  assert.equal(text(pane, nodeById(pane, `${STACK_ID}.composer-model-quick-s0.model-chevron`)), '▴',
    'the chevron states the open seat')
  // A second click on the same trigger closes it: a local dismissal, no write.
  m.open()
  await waitUntil('the toggle dismissed the menu', () => !menuMounted(pane))
  assert.deepEqual(m.applied, [])
})

test('Q02/Q04 the hydrated root is Model, then Effort, then the fixed Full footer', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  assert.deepEqual(bodyLabels(pane), ['Model Alpha One ›', 'Reasoning Effort High ›'],
    'the root order is frozen and its values come from the directory read')
  assert.equal(labelOf(pane, 'full'), 'All models & details…', 'the Full entry is fixed')
  assert.equal(attrOf(menuAction(pane, 'full'), 'data-highlight'), undefined,
    'the keyboard starts on the first root row, not the footer')
  assert.equal(attrOf(menuAction(pane, 'o0'), 'data-highlight'), 'true')
  assert.deepEqual(m.applied, [], 'reading the root writes nothing')
  assert.ok(menuNodes(pane).some(node => nodeKey(node).endsWith('-footer')),
    'the Full entry lives in its own fixed footer container')

  // A current model with NO reasoning metadata offers no Effort row at all.
  const other = await mountedQuick()
  t.after(() => { void other.dispose() })
  await other.openAndHydrate({ provider: 'alpha', model: 'same' })
  assert.deepEqual(bodyLabels(other.pane), ['Model Twin ›'],
    'no metadata means no Effort row, never an invented cycle')
})

/* ==================================== Q03: the model page, search, group order */

test('Q03 the Model page searches through a real native field, never the draft', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  pane.key('draft keep me')
  await settle(60)
  const before = editorState(pane)
  assert.equal(before.text, 'draft keep me', 'the draft is live before the open')
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the model page mounted', () => menuNode(pane, 'search') !== undefined)
  const search = menuNode(pane, 'search')
  assert.equal(search!.k === 'input', true, 'the search field is the SDK input kind, not a painted fake')
  assert.deepEqual({ text: String(search!.p['text'] ?? ''), cursor: Number(search!.p['cursor'] ?? -1) },
    { text: '', cursor: 0 })
  await waitUntil('the field owns the caret', () => frameOps(pane, 'focus').at(-1) === search!.id)
  // Keys edit the LOCAL query only.
  pane.key('tw')
  await waitUntil('the query filtered the list', () => String(menuNode(pane, 'search')?.p['text'] ?? '') === 'tw')
  assert.deepEqual(editorState(pane), before, 'the Composer draft and its UTF-16 caret are byte-identical')
  assert.deepEqual(bodyLabels(pane), ['Twin', 'Alpha Two', 'Twin (Beta)'],
    'the filter keeps the directory order across the provider groups')
  assert.equal(labelOf(pane, 'back'), '‹ Model & Effort', 'the fixed Back header is painted')
  assert.equal(labelOf(pane, 'full'), 'All models & details…', 'the fixed footer stays')
  assert.ok(menuNodes(pane).some(node => text(pane, node) === 'Alpha AI'),
    'the provider head is painted from the directory, not invented')
  assert.deepEqual(m.applied, [], 'browsing and filtering never write')
})

test('Q03 one model id under two providers stays two rows with two identities', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'beta', model: 'same' })
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the model page mounted', () => menuNode(pane, 'search') !== undefined)
  const rows = menuBodyRows(pane)
  assert.deepEqual(rows.map(node => text(pane, node)),
    ['Alpha One', 'Twin', 'Alpha Two', 'Twin (Beta) ✓'],
    'both providers list their own row for the same model id')
  const alphaTwin = rows[1]!
  const betaTwin = rows[3]!
  assert.notEqual(alphaTwin.id, betaTwin.id)
  assert.equal(attrOf(betaTwin, 'data-selected'), 'true',
    'the full (provider,model) pair decides the ✓, not the model id alone')
  assert.equal(attrOf(alphaTwin, 'data-selected'), undefined)
  click(pane, alphaTwin)
  await waitUntil('the write reached the owner', () => m.applied.length === 1)
  assert.deepEqual(m.applied[0], { provider: 'alpha', model: 'same' },
    'the write carries the row the click named, never the other provider')
})

test('Q05 choosing the committed model or effort closes without touching the writer', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the model page mounted', () => menuNode(pane, 'search') !== undefined)
  const currentRow = menuBodyRows(pane).find(node => attrOf(node, 'data-selected') === 'true')
  assert.ok(currentRow, 'the committed model is marked')
  click(pane, currentRow!)
  await waitUntil('the menu dismissed', () => !menuMounted(pane))
  assert.deepEqual(m.applied, [], 'a restated current model is never a write')
  assert.deepEqual(m.owned, [])

  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  click(pane, menuAction(pane, 'o1'))
  await waitUntil('the effort page mounted', () => bodyLabels(pane).includes('High ✓'))
  click(pane, menuAction(pane, 'o1'))
  await waitUntil('the effort menu dismissed', () => !menuMounted(pane))
  assert.deepEqual(m.applied, [], 'a restated current effort is never a write either')
})

/* =============================== Q06/Q07: the one write, from real metadata */

test('Q06 a different model writes once with its OWN effort decision', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  // The committed selection carries `high`; the target model has no metadata.
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the model page mounted', () => menuNode(pane, 'search') !== undefined)
  const target = menuBodyRows(pane)[1]!
  click(pane, target)
  await waitUntil('the owner received one write', () => m.applied.length === 1)
  assert.deepEqual(m.applied[0], { provider: 'alpha', model: 'same' },
    "the previous model's effort never follows a model that advertises none")
  assert.deepEqual(m.owned, ['model quick selection'], 'the write runs under the command-owned task')
  // The pending frame is VISIBLE and offers no second operation.
  assert.equal(text(pane, menuNode(pane, 'notice')), 'Selecting…')
  click(pane, target)
  await settle(60)
  assert.equal(m.applied.length, 1, 'a click under an admitted write never dispatches a second one')
  pane.key('\r')
  await settle(60)
  assert.equal(m.applied.length, 1, 'and neither does Enter')
  m.settle('committed')
  await waitUntil('committed dismisses the menu', () => !menuMounted(pane))
  assert.equal(m.applied.length, 1)
})

test('Q06 a model that declares a default effort is written WITH that default', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'beta', model: 'same' })
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the model page mounted', () => menuNode(pane, 'search') !== undefined)
  const row = menuBodyRows(pane).find(node => text(pane, node).startsWith('Alpha One'))
  assert.ok(row)
  click(pane, row!)
  await waitUntil('the write reached the owner', () => m.applied.length === 1)
  assert.deepEqual(m.applied[0], { provider: 'alpha', model: 'a-one', reasoningEffort: 'high' },
    "the target model's own advertised default is what the Host receives")
})

test('Q07 the Effort page writes real advertised ids and omits the sentinel', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  // alpha/a-two declares efforts WITHOUT a default: the provider-default
  // sentinel joins the candidates, in the shared projection's own order.
  await m.openAndHydrate({ provider: 'alpha', model: 'a-two', reasoningEffort: 'low' })
  click(pane, menuAction(pane, 'o1'))
  await waitUntil('the effort page mounted', () => bodyLabels(pane).includes('Max'))
  assert.deepEqual(bodyLabels(pane), ['Default', 'Low ✓', 'Max'],
    'the candidates are this model DTO, the committed one marked ✓ in words')
  click(pane, menuAction(pane, 'o2'))
  await waitUntil('the effort write reached the owner', () => m.applied.length === 1)
  assert.deepEqual(m.applied[0], { provider: 'alpha', model: 'a-two', reasoningEffort: 'max' })
  m.settle('committed')
  await waitUntil('committed dismisses', () => !menuMounted(pane))

  await m.openAndHydrate({ provider: 'alpha', model: 'a-two', reasoningEffort: 'low' })
  click(pane, menuAction(pane, 'o1'))
  await waitUntil('the effort page remounted', () => bodyLabels(pane).includes('Default'))
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the provider-default write reached the owner', () => m.applied.length === 2)
  assert.equal('reasoningEffort' in m.applied[1]!, false,
    'the provider-default sentinel is an ABSENT field, never a sentinel string on the wire')
  assert.deepEqual(m.applied[1], { provider: 'alpha', model: 'a-two' })
})

/* ================================ Q09/Q10/Q12: outcomes, handoff, staleness */

test('Q09 every settlement kind behaves as the frozen table says', async (t) => {
  const cases: Array<{ readonly outcome: ModelApplyOutcome; readonly closes: boolean }> = [
    { outcome: 'committed', closes: true },
    { outcome: 'indeterminate', closes: true },
    { outcome: 'superseded', closes: true },
    { outcome: 'rejected', closes: false },
    { outcome: 'cancelled', closes: false },
    { outcome: 'unsupported', closes: false },
  ]
  for (const testCase of cases) {
    const m = await mountedQuick()
    t.after(() => { void m.dispose() })
    const { pane } = m
    await m.openAndHydrate({ provider: 'alpha', model: 'a-two', reasoningEffort: 'low' })
    click(pane, menuAction(pane, 'o1'))
    await waitUntil('the effort page mounted', () => bodyLabels(pane).includes('Max'))
    const maxRow = menuAction(pane, 'o2')
    click(pane, maxRow)
    await waitUntil('the write started', () => m.applied.length === 1)
    m.settle(testCase.outcome)
    await settle(80)
    assert.equal(!menuMounted(pane), testCase.closes,
      `${testCase.outcome} => dismissed=${testCase.closes}`)
    if (testCase.closes) {
      // A dismissal owns nothing further: an old click reopens nothing and
      // dispatches no second write.
      click(pane, maxRow)
      await settle(60)
      assert.equal(menuMounted(pane), false, `${testCase.outcome} does not reopen the panel`)
      assert.equal(m.applied.length, 1, `${testCase.outcome} dispatched no further write`)
      continue
    }
    assert.equal(m.applied.length, 1, `${testCase.outcome} never retries by itself`)
    assert.deepEqual(bodyLabels(pane), ['Default', 'Low ✓', 'Max'],
      `${testCase.outcome} keeps the page the user was on`)
    click(pane, menuAction(pane, 'o0'))
    await settle(60)
    assert.equal(m.applied.length, 2, `${testCase.outcome} restores the page for another operation`)
  }
})

test('Q10 the Full handoff revokes the quick identity before the panel opens', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  const staleRow = menuAction(pane, 'o0')
  click(pane, menuAction(pane, 'full'))
  await waitUntil('the registered full entry ran', () => m.entries.full.length === 1)
  assert.deepEqual(m.entries.full, ['models'],
    'Full goes through the registered /model UI entry, never a string typed into the Composer')
  assert.equal(menuMounted(pane), false, 'no quick frame stays operable behind the catalogue')
  click(pane, staleRow)
  await settle(80)
  assert.equal(menuMounted(pane), false, 'a retired frame raises no quick menu again')
  assert.deepEqual(m.applied, [], 'and never reaches the writer')
})

test('Q12 a newer directory read retires the rows the older frame offered', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the model page mounted', () => menuNode(pane, 'search') !== undefined)
  const dropped = menuAction(pane, 'o2')
  // The command's ONE read owner re-reads a catalogue that dropped that row.
  const shrunk: ModelDirectoryDto = {
    ...quickDirectory({ provider: 'alpha', model: 'a-one' }),
    groups: [{ id: 'alpha', name: 'Alpha AI', models: [{ id: 'a-one', name: 'Alpha One' }] }],
    failures: [],
  }
  m.handle().setDirectory({ directory: shrunk, current: { provider: 'alpha', model: 'a-one' } })
  await settle(80)
  click(pane, dropped)
  await settle(80)
  assert.deepEqual(m.applied, [], 'a row the current read dropped cannot be written from an old frame')
  assert.equal(menuMounted(pane), true, 'the live panel is untouched by the stale click')
})

test('Q12 hydration revokes the panel; its late read and late write own nothing', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  click(pane, menuAction(pane, 'o1'))
  await waitUntil('the effort page mounted', () => bodyLabels(pane).includes('Low'))
  // The row key is a position within one panel, so a click is addressed to the
  // row the CURRENT frame paints: `low` differs from the committed `high`.
  const lowRow = menuAction(pane, 'o0')
  click(pane, lowRow)
  await waitUntil('the write started', () => m.applied.length === 1)
  assert.deepEqual(m.applied[0], { provider: 'alpha', model: 'a-one', reasoningEffort: 'low' })
  m.renderer.display.beginSessionHydration()
  await settle(60)
  assert.equal(menuMounted(pane), false, 'the outgoing subject retires the menu')
  m.settle('committed')
  await settle(60)
  assert.equal(menuMounted(pane), false, 'the settled write does not reopen onto the new subject')
  assert.equal(m.applied.length, 1, 'and dispatches nothing further')
  // A late read of the retired panel cannot paint either.
  m.handle().setDirectory({
    directory: quickDirectory({ provider: 'alpha', model: 'same' }),
    current: { provider: 'alpha', model: 'same' },
  })
  await settle(60)
  assert.equal(menuMounted(pane), false, 'a retired handle paints no panel for the new subject')
})

test('Q12 a newer open takes a new panel serial and the old frame is off the wire', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  const first = await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  // A newer `/model` invocation (the same command owner, a newer surface token).
  m.renderer.modelPresentation!.openQuick!({
    subject: LIVE_SUBJECT,
    entry: 'models',
    isCurrent: () => true,
    retry: () => {},
    apply: () => 'committed',
    runOwned: (label, task, ownedOptions) => {
      runOwned(label, task, { ...ownedOptions, diag: SILENT_DIAG })
    },
  })
  await waitUntil('the newer panel replaced the older', () => m.panelSerial() !== first)
  const second = m.panelSerial()
  assert.notEqual(second, first)
  assert.equal(menuNodes(pane).some(node => nodeKey(node) === `composer-quick-menu-${first}`), false,
    'the retired panel is absent from the current frame entirely')
  assert.equal(menuNodes(pane).some(node => nodeKey(node) === `composer-quick-menu-${second}`), true)
})

test('Q12 a stale read settle cannot paint the current panel', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  m.open()
  await waitUntil('the menu mounted', () => menuMounted(pane))
  const stale = m.handle()
  // A newer open takes the seat, then the OLDER read settles.
  m.renderer.modelPresentation!.openQuick!({
    subject: LIVE_SUBJECT,
    entry: 'models',
    isCurrent: () => true,
    retry: () => {},
    apply: () => 'committed',
    runOwned: (label, task, ownedOptions) => {
      runOwned(label, task, { ...ownedOptions, diag: SILENT_DIAG })
    },
  })
  await waitUntil('the newer panel mounted', () => m.panelSerial() > panelSerialOf(pane) - 1 && stale.isDisposed())
  const newer = m.panelSerial()
  stale.setDirectory({ directory: quickDirectory({ provider: 'alpha', model: 'a-one' }), current: { provider: 'alpha', model: 'a-one' } })
  stale.setLoadError('a stale failure must not paint')
  await settle(60)
  assert.equal(newer, m.panelSerial(), 'the current panel keeps its own serial')
  assert.equal(text(pane, menuNode(pane, 'notice')), 'Loading models…',
    'the newer panel still states its own read, not the older one')
})

/* ==================================== Q13/Q14: the seat, keys and the draft */

test('Q13 the Permission menu and the quick menu are never both expanded', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  const permissionTrigger = wireNodes(pane).find(node => /^composer-permission-s\d+$/.test(nodeKey(node)))
  assert.ok(permissionTrigger, 'the permission trigger is mounted')
  click(pane, permissionTrigger!)
  await waitUntil('the permission menu opened', () => nodeById(pane, 'dock.quiet-composer.composer-controls.composer-permission-stack.composer-permission-menu') !== undefined)
  assert.equal(menuMounted(pane), false, 'the quick menu was revoked in the same synchronous step')
  // The other direction: opening the quick menu revokes the permission menu.
  click(pane, permissionTrigger!)
  await settle(60)
  assert.equal(nodeById(pane, 'dock.quiet-composer.composer-controls.composer-permission-stack.composer-permission-menu'), undefined,
    'the permission menu closed')
  m.open()
  await waitUntil('the quick menu reopened', () => menuMounted(pane))
  assert.equal(nodeById(pane, 'dock.quiet-composer.composer-controls.composer-permission-stack.composer-permission-menu'), undefined)
})

test('Q13 Escape never reaches the Agent cancel and Ctrl+C still does', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  pane.key('\u001b')
  await settle(60)
  assert.equal(m.counts.cancels, 0, 'the first Escape is a menu step, not a cancel')
  pane.key('\u001b')
  await waitUntil('the root Escape closed the menu', () => !menuMounted(pane))
  assert.equal(m.counts.cancels, 0, 'and closing the menu is never an Agent cancel')
  // With the menu open again, Ctrl+C revokes it and still reaches its owner.
  m.open()
  await waitUntil('the menu remounted', () => menuMounted(pane))
  pane.key('\u0003')
  await settle(60)
  assert.equal(menuMounted(pane), false, 'Ctrl+C revoked the menu interaction identity')
  assert.equal(m.counts.cancels, 1, 'and the cancel intent still reached its original owner exactly once')
})

test('Q14 a quick-menu keystroke never reaches the Composer reducer', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  pane.key('hold this')
  await settle(60)
  const before = editorState(pane)
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  // A plain letter on the root page is consumed as a no-op, never an edit.
  pane.key('x')
  await settle(40)
  // Enter activates the highlighted ROW (the Model page), never the draft.
  pane.key('\r')
  await waitUntil('the keyboard moved into the Model page', () => menuNode(pane, 'search') !== undefined)
  pane.key('zz')
  await settle(40)
  assert.deepEqual(editorState(pane), before, 'the draft and its caret are byte-identical under the menu')
  assert.equal(m.counts.submits, 0, 'Enter activated the row, it never sent the draft')
  assert.equal(menuMounted(pane), true, 'and the stray letters did not dismiss the menu')
  // The Escape ladder: clear the query → return to root → close.
  pane.key('\u001b')
  await waitUntil('the first Escape cleared the query', () =>
    String(menuNode(pane, 'search')?.p['text'] ?? 'x') === '')
  assert.equal(menuMounted(pane), true, 'clearing the filter is not a dismissal')
  pane.key('\u001b')
  await waitUntil('the next Escape returned to the root', () => menuNode(pane, 'search') === undefined)
  assert.equal(menuMounted(pane), true)
  pane.key('\u001b')
  await waitUntil('the last Escape closed the menu', () => !menuMounted(pane))
  assert.deepEqual(editorState(pane), before, 'closing restores the exact draft and caret')
  assert.equal(m.counts.submits, 0)
  pane.key('!')
  await settle(60)
  assert.equal(editorState(pane).text, 'hold this!', 'the Composer seat is live again after the dismissal')
})

test('Q14 Tab walks Search → Options → Full and back, never into the Composer', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the model page mounted', () => menuNode(pane, 'search') !== undefined)
  const searchId = menuNode(pane, 'search')!.id
  await waitUntil('the field owns the caret', () => frameOps(pane, 'focus').at(-1) === searchId)
  pane.key('\t')
  await waitUntil('the list owns the keyboard', () => attrOf(menuAction(pane, 'o0'), 'data-highlight') === 'true')
  assert.notEqual(frameOps(pane, 'focus').at(-1), searchId, 'the caret leaves the field for the app-routed list')
  pane.key('\t')
  await waitUntil('the footer owns the keyboard', () => attrOf(menuAction(pane, 'full'), 'data-highlight') === 'true')
  pane.key('\u001b[Z')
  await waitUntil('Shift+Tab walked back to the list', () => attrOf(menuAction(pane, 'o0'), 'data-highlight') === 'true')
  pane.key('\u001b[Z')
  await waitUntil('Shift+Tab walked back to the field', () => frameOps(pane, 'focus').at(-1) === searchId)
})

test('Q15 the reveal names the row the CURRENT frame built, and only when it moved', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the model page mounted', () => menuNode(pane, 'search') !== undefined)
  pane.key('\t')
  await waitUntil('the list owns the keyboard', () => attrOf(menuAction(pane, 'o0'), 'data-highlight') === 'true')
  pane.key('\u001b[B')
  await waitUntil('the second row is highlighted', () => attrOf(menuAction(pane, 'o1'), 'data-highlight') === 'true')
  assert.equal(frameOps(pane, 'reveal').at(-1), menuAction(pane, 'o1').id,
    'the reveal op addresses the real node id of the row the cursor moved onto')
  const count = frameOps(pane, 'reveal').length
  m.renderer.display.commitDisplaySubject({}, {}, undefined)
  await settle(60)
  assert.equal(frameOps(pane, 'reveal').length, count, 'a same-highlight repaint never scrolls again')
})

/* =============================== Q15/Q16/Q17: read states, kinds, sanitization */

test('Q15 a failed read offers exactly one Retry that re-enters loading', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  m.open()
  await waitUntil('the menu mounted', () => menuMounted(pane))
  m.handle().setLoadError('provider gamma is unreachable')
  await waitUntil('the error frame painted', () => text(pane, menuNode(pane, 'notice')).includes('unreachable'))
  assert.deepEqual(bodyLabels(pane), ['Retry'], 'one Retry, and nothing else offered')
  assert.equal(labelOf(pane, 'full'), 'All models & details…', 'the Full way out stays reachable')
  assert.equal(attrOf(menuNode(pane, 'notice'), 'data-tone'), 'error',
    'a failure is inked as a failure, not as information')
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the retry re-entered loading', () => text(pane, menuNode(pane, 'notice')) === 'Loading models…')
  assert.equal(m.counts.retries, 1, 'Retry asks the command read owner exactly once')
  assert.deepEqual(m.applied, [], 'and never writes')
})

test('Q15 a partial read keeps every usable group and states the failed provider', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the model page mounted', () => menuNode(pane, 'search') !== undefined)
  const failure = menuNodes(pane).find(node => nodeKey(node).includes('failure-gamma'))
  assert.ok(failure, 'the failed provider is shown as inert context')
  assert.equal(text(pane, failure), 'Gamma · unavailable')
  assert.equal(attrOf(failure, 'data-detail'), 'provider gamma is unreachable')
  assert.equal(failure!.p['tag'], 'div', 'a failed provider line is not a selectable row')
  click(pane, menuAction(pane, 'o2'))
  await waitUntil('the write reached the owner', () => m.applied.length === 1)
  assert.deepEqual(m.applied[0], { provider: 'alpha', model: 'a-two' },
    'a model with candidates but no declared default gets the provider default, i.e. no effort field')
})

test('Q15 an empty search says so and offers no invisible row', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the model page mounted', () => menuNode(pane, 'search') !== undefined)
  pane.key('zzznope')
  await waitUntil('the empty state painted', () => menuNode(pane, 'empty') !== undefined)
  assert.equal(text(pane, menuNode(pane, 'empty')), 'No models match that search.')
  assert.deepEqual(bodyLabels(pane), [], 'no hidden row is selectable')
  assert.equal(labelOf(pane, 'back'), '‹ Model & Effort', 'the header stays')
  assert.equal(labelOf(pane, 'full'), 'All models & details…', 'the footer stays')
  pane.key('\u001b')
  await waitUntil('Escape cleared the query first', () => String(menuNode(pane, 'search')?.p['text'] ?? 'x') === '')
  assert.equal(menuMounted(pane), true, 'the clear is not a dismissal')
})

test('Q16 a pane without the native input kind keeps the full panel, never a fake menu', async (t) => {
  const m = await mountedQuick({ pane: { modelPicker: true, composerActions: true } })
  t.after(() => { void m.dispose() })
  const { pane } = m
  clickTrigger(pane)
  await waitUntil('the full entry ran', () => m.entries.full.length === 1)
  assert.deepEqual(m.entries.full, ['models'])
  assert.equal(m.entries.quick, 0, 'no quick read started on a pane that cannot present it')
  assert.equal(menuMounted(pane), false)
})

test('Q17 hostile model facts are sanitized on the wire and untouched in the write', async (t) => {
  const m = await mountedQuick()
  t.after(() => { void m.dispose() })
  const { pane } = m
  await m.openAndHydrate({ provider: 'alpha', model: 'a-one', reasoningEffort: 'high' })
  click(pane, menuAction(pane, 'o0'))
  await waitUntil('the model page mounted', () => menuNode(pane, 'search') !== undefined)
  // A hostile provider/model identity arrives through the directory read itself.
  const hostile: ModelDirectoryDto = {
    default: { provider: 'a', model: 'plain' },
    routableProviders: ['a'],
    groups: [{
      id: 'a',
      name: 'A\u001b[2J',
      models: [
        { id: 'evil-name', name: 'Evil\u001b]0;X\u0007name' },
        { id: 'plain', name: 'Plain' },
      ],
    }],
    failures: [],
  }
  m.handle().setDirectory({ directory: hostile, current: { provider: 'a', model: 'plain' } })
  await waitUntil('the hostile row painted', () => bodyLabels(pane).some(label => label.startsWith('Evil')))
  for (const node of menuNodes(pane)) {
    const rendered = nodeText(pane, node)
    assert.equal(rendered.includes('\u001b'), false, 'no raw escape sequence reaches the wire')
    assert.equal(rendered.includes('\u0000'), false, 'no NUL reaches the wire')
    assert.equal(nodeKey(node).includes('\u0000'), false, 'no control byte enters a node key')
  }
  const target = menuBodyRows(pane).find(node => text(pane, node).startsWith('Evil'))
  assert.ok(target)
  click(pane, target!)
  await waitUntil('the write reached the owner', () => m.applied.length === 1)
  assert.deepEqual(m.applied[0], { provider: 'a', model: 'evil-name' },
    'the write keeps the DTO identity; only the DISPLAY was sanitized')
})

/* ========================== The registered command owner over the real Direct */

const triggerKey = /^composer-model-quick-s/

test('the real registered command drives one read, one writer and the authoritative relabel', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    modelPicker: true,
    composerActions: true,
    modelQuick: true,
    deltas: ['model-live-ok'],
  })
  const reads: number[] = []
  const writes: Array<{ sessionId: string; selection: unknown; outcome: string }> = []
  const originalLoad = DirectModelCatalog.prototype.loadDirectory
  const originalSelect = DirectModelCatalog.prototype.selectSessionModel
  DirectModelCatalog.prototype.loadDirectory = async function (...args) {
    reads.push(reads.length)
    return originalLoad.apply(this, args)
  }
  DirectModelCatalog.prototype.selectSessionModel = async function (...args) {
    const result = await originalSelect.apply(this, args)
    writes.push({ sessionId: args[0], selection: args[1], outcome: result.outcome.kind })
    return result
  }
  t.after(() => {
    DirectModelCatalog.prototype.loadDirectory = originalLoad
    DirectModelCatalog.prototype.selectSessionModel = originalSelect
  })
  const clickTriggerReal = async (): Promise<void> => {
    const trigger = wireNodes(fixture.pane).find(node => triggerKey.test(nodeKey(node)))
    assert.ok(trigger, 'the combined trigger is on the wire')
    fixture.pane.event({ ev: 'action', sf: fixture.pane.frames().at(-1)!.sf, id: trigger!.id, act: 'click' })
    await settle(80)
  }
  try {
    await waitFor('booted', () => fixture.pane.output.text().includes('dock.quiet-composer.composer'))
    fixture.pane.key('create live session\r')
    await waitFor('real Agent turn', () => fixture.pane.output.text().includes('model-live-ok'))
    // ── One click → the registered command → ONE real directory read → the
    //    anchored quick menu, with no full panel anywhere.
    await clickTriggerReal()
    await waitFor('the real directory hydrated the quick menu', () => menuMounted(fixture.pane)
      && menuBodyRows(fixture.pane).length >= 1)
    assert.equal(reads.length, 1, 'exactly one directory read for one open')
    assert.equal(wireNodes(fixture.pane).filter(node => node.k === 'picker').length, 0,
      'the quick presentation never opened the full catalogue')
    const rootLabels = bodyLabels(fixture.pane)
    assert.equal(rootLabels[0]?.startsWith('Model'), true, `root leads with Model: ${rootLabels.join(' | ')}`)
    assert.equal(labelOf(fixture.pane, 'full'), 'All models & details…', 'the Full entry is the fixed footer')
    // ── The Model page, then the model the Session does NOT use.
    click(fixture.pane, menuAction(fixture.pane, 'o0'))
    await waitFor('the model page mounted', () => menuNode(fixture.pane, 'search') !== undefined)
    const rows = menuBodyRows(fixture.pane)
    const labels = rows.map(node => text(fixture.pane, node))
    assert.equal(rows.length, 2, `both real advertised models are listed: ${labels.join(' | ')}`)
    assert.equal(labels.some(label => /✓/.test(label)), true,
      'the committed model carries the ✓ marker the write must not repeat')
    // The un-marked row is the model the Session does not use; the payload
    // assertion below is what proves its REAL identity, never the label.
    const target = rows.find(node => !/✓/.test(text(fixture.pane, node)))
    assert.ok(target, `the other advertised row is selectable: ${labels.join(' | ')}`)
    const targetLabel = text(fixture.pane, target!)
    click(fixture.pane, target!)
    await waitFor('the ONE durable selection write', () => writes.length === 1)
    assert.equal(reads.length, 1, 'the quick write never re-reads the directory')
    assert.deepEqual(writes[0]!.selection, { provider: DIRECT_TSP_PROVIDER, model: DIRECT_TSP_MODEL_TWO })
    assert.equal(writes[0]!.outcome, 'committed')
    await waitFor('committed dismisses the menu', () => !menuMounted(fixture.pane))
    const agent = fixture.ctx.agents.get(writes[0]!.sessionId as never)
    assert.ok(agent, 'the write targeted the REAL live session')
    const events = agent!.session.snapshotEvents().filter(e => e.type === 'model/selection')
    assert.equal(events.length, 1, 'exactly ONE durable selection append in the Session log')
    assert.deepEqual(events[0]!.data, { provider: DIRECT_TSP_PROVIDER, model: DIRECT_TSP_MODEL_TWO })
    assert.equal(fixture.modelCalls(), 1, 'the whole chain dispatched no extra prompt')
    // ── The authoritative projection: a reopen marks the NEW current, read from
    //    the Session — not from what the UI last clicked.
    await clickTriggerReal()
    await waitFor('the reopened quick menu hydrated', () => menuMounted(fixture.pane)
      && menuBodyRows(fixture.pane).length >= 1)
    assert.equal(reads.length, 2, 'the reopen is one more read by the SAME owner')
    click(fixture.pane, menuAction(fixture.pane, 'o0'))
    await waitFor('the reopened model page mounted', () => bodyLabels(fixture.pane).length === 2)
    const marked = menuBodyRows(fixture.pane).filter(node => attrOf(node, 'data-selected') === 'true')
    assert.equal(marked.length, 1, 'exactly one row carries the committed ✓')
    assert.equal(text(fixture.pane, marked[0]!), `${targetLabel} ✓`,
      'the reopened panel marks the model the Session now uses')
    assert.equal(writes.length, 1, 'and the reopen wrote nothing')
  } finally {
    await fixture.settle()
  }
})

test('sessionless: the trigger routes to the full panel with its explicit Save default', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    modelPicker: true,
    composerActions: true,
    modelQuick: true,
  })
  const reads: number[] = []
  const originalLoad = DirectModelCatalog.prototype.loadDirectory
  DirectModelCatalog.prototype.loadDirectory = async function (...args) {
    reads.push(reads.length)
    return originalLoad.apply(this, args)
  }
  t.after(() => { DirectModelCatalog.prototype.loadDirectory = originalLoad })
  try {
    await waitFor('booted', () => fixture.pane.output.text().includes('dock.quiet-composer.composer'))
    const trigger = wireNodes(fixture.pane).find(node => triggerKey.test(nodeKey(node)))
    assert.ok(trigger, 'the combined trigger paints with no Session')
    fixture.pane.event({ ev: 'action', sf: fixture.pane.frames().at(-1)!.sf, id: trigger!.id, act: 'click' })
    await waitFor('the FULL panel opened for the sessionless subject', () => {
      const picker = wireNodes(fixture.pane).find(node => node.k === 'picker')
      return picker !== undefined && String(picker.p['title']) === 'Choose default model'
    })
    assert.equal(menuMounted(fixture.pane), false,
      'no quick selector offers an immediate global-default write before a Session exists')
    assert.equal(reads.length, 1, 'the SAME registered command read the directory once')
    assert.equal(fixture.modelCalls(), 0, 'opening the picker dispatches no prompt and creates no Session')
  } finally {
    await fixture.settle()
  }
})

/* ============================== One command owner, two presentation variants */

interface OwnerProbe {
  readonly calls: { loads: number; selects: ModelSelectionDto[]; pending: unknown[] }
  readonly opened: Array<'full' | 'quick'>
  readonly commands: ReturnType<typeof createModelCommands>
}

/** The registered `/model` command over the narrow boundary it actually uses:
 *  one catalog, one writer, one pending marker. */
function commandOwner(options: { readonly sessionless: boolean; readonly presentation: ModelPresentation }): OwnerProbe {
  const calls = { loads: 0, selects: [] as ModelSelectionDto[], pending: [] as unknown[] }
  const opened: Array<'full' | 'quick'> = []
  const directory: ModelDirectoryDto = {
    default: { provider: 'p', model: 'one' },
    routableProviders: ['p'],
    groups: [{ id: 'p', name: 'P', models: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }] }],
    failures: [],
  }
  const models = {
    available: () => true,
    loadDirectory: async () => { calls.loads += 1; return directory },
    sessionSelection: () => ({ provider: 'p', model: 'one' }),
    selectSessionModel: async (_id: string, selection: ModelSelectionDto) => {
      calls.selects.push(selection)
      return { ownership: 'owned', outcome: { kind: 'committed', value: selection } }
    },
    saveDefaultSelection: async () => ({ kind: 'committed', value: undefined }),
  }
  const runner = {
    catalog: { models },
    captureSessionScope: () => ({ sessionId: options.sessionless ? undefined : 's1', epoch: 1 }),
    captureLiveSessionScope: () => (options.sessionless ? undefined : { sessionId: 's1', epoch: 1 }),
    isSessionScopeCurrent: () => true,
    currentSessionId: options.sessionless ? undefined : 's1',
    signal: new AbortController().signal,
    diag: { debug() {}, warn() {}, error() {} },
    withWriter: async (_scope: unknown, run: () => Promise<unknown>) => await run(),
    setModelSelectionPending: (marker: unknown) => { calls.pending.push(marker) },
    refreshStatus() {},
    updateWelcomeCard() {},
    reconcileDefaultIntent() {},
    setDefaultIntent() {},
    defaultIntentRecord: undefined,
    trackDefaultWrite() {},
    settleIntent() {},
  }
  const presentation: ModelPresentation = {
    open: (request) => { opened.push('full'); return options.presentation.open(request) },
    ...(options.presentation.openQuick === undefined
      ? {}
      : { openQuick: (request: ModelPickerRequest) => {
        opened.push('quick')
        return options.presentation.openQuick!(request)
      } }),
    notify: () => {},
  }
  const commands = createModelCommands({
    runner: runner as unknown as ModelCommandDeps['runner'],
    app: {} as never,
    modelPresentation: presentation,
    registerOne: () => {},
    recordCommandDraftDisposition: () => {},
    notifyOutcome: () => {},
  })
  return { calls, opened, commands }
}

/** A presenter that records the request the command handed it. */
function recordingPresenter(): { readonly presentation: ModelPresentation; lastRequest(): ModelPickerRequest | undefined } {
  let last: ModelPickerRequest | undefined
  const handle: ModelPickerHandle = {
    setLoading: () => {},
    setDirectory: () => {},
    setLoadError: () => {},
    isDisposed: () => false,
    close: () => {},
  }
  const presentation: ModelPresentation = {
    open: (request) => { last = request; return handle },
    openQuick: (request) => { last = request; return handle },
    notify: () => {},
  }
  return { presentation, lastRequest: () => last }
}

test('one command owner: the quick presentation shares the read, the writer and the request', async () => {
  const recorder = recordingPresenter()
  const probe = commandOwner({ sessionless: false, presentation: recorder.presentation })
  const result = await probe.commands.openModelQuick()
  assert.deepEqual(result, { kind: 'success' })
  assert.deepEqual(probe.opened, ['quick'], 'a live subject gets the quick presentation')
  const request = recorder.lastRequest()
  assert.ok(request, 'the presenter received the command own request')
  assert.equal(request!.entry, 'models', 'the quick variant invents no second entry kind')
  assert.deepEqual(request!.subject, { sessionless: false })
  assert.equal(probe.calls.loads, 1, 'ONE directory read for the open')
  // The presenter writes through the command own apply: the same writer, the
  // same branded effort id path, and the same footer pending marker — set, then
  // cleared by the settlement, never a quick-menu marker of its own.
  await request!.apply({ provider: 'p', model: 'two' })
  assert.deepEqual(probe.calls.selects, [{ provider: 'p', model: 'two' }])
  assert.equal(probe.calls.pending.length, 2, 'the command owns the pending marker: set, then cleared')
  assert.deepEqual(probe.calls.pending[0], { provider: 'p', model: 'two' })
  assert.equal(probe.calls.pending[1], undefined)
})

test('a sessionless subject is routed to the FULL panel by the command itself', async () => {
  const recorder = recordingPresenter()
  const probe = commandOwner({ sessionless: true, presentation: recorder.presentation })
  await probe.commands.openModelQuick()
  assert.deepEqual(probe.opened, ['full'],
    'before a Session exists the explicit Save default panel is the contract, not a quick write')
  assert.equal(probe.calls.loads, 1)
})

test('a renderer without a quick presentation is refused, never silently substituted', async () => {
  const fullOnly: ModelPresentation = {
    open: () => ({ setLoading: () => {}, setDirectory: () => {}, setLoadError: () => {}, isDisposed: () => false, close: () => {} }),
    notify: () => {},
  }
  const probe = commandOwner({ sessionless: false, presentation: fullOnly })
  const result = await probe.commands.openModelQuick()
  assert.equal(result.kind, 'error', 'the registered command states the missing capability')
  assert.deepEqual(probe.opened, [], 'no silent fallback open, no accepted write')
  assert.equal(probe.calls.loads, 0, 'and no directory read was started')
})

test('the typed /model route never takes the quick presentation', async () => {
  const recorder = recordingPresenter()
  const probe = commandOwner({ sessionless: false, presentation: recorder.presentation })
  await probe.commands.openModel('models')
  assert.deepEqual(probe.opened, ['full'], '/model keeps the original Catalogue + Details contract')
})
