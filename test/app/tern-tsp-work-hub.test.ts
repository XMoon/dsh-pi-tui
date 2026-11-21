/**
 * B3-A1: the internal native TSP Work Hub presenter, observed through the
 * REAL renderer mount and the SDK's reconciled pane wire.
 *
 * Only the tty boundary is scripted (`test/support/tsp-terminal-fixture.ts`);
 * the presenter, the session's ONE layer/focus/input routing and the SDK are
 * the production ones. Application facts are injected exactly like the real
 * Task Runtime commits them (or, for the source→sink case, produced by the
 * REAL `createTaskRuntime`).
 *
 * Evidence level: scripted SDK wire (not a real Tern client). A1 is internal
 * only: production `/tasks` stays unreachable while
 * `display.supportsTaskCenter === false`.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-work-hub.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect, type PickerGroup } from '@stencil-hq/tern'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import type { TaskPanelItem } from '../../src/app/surface/task-presentation.ts'
import type {
  TaskBrowserPresentationHandle,
  TaskBrowserPresentationOpen,
} from '../../src/app/surface/task-presentation-port.ts'
import { createTaskRuntime } from '../../src/app/surface/task-runtime.ts'
import type { TaskSurfaceSource } from '../../src/app/surface/task-runtime.ts'
import type { TaskBrowserJobInput } from '../../src/domain/task/browser.ts'
import type { TaskSubagentEntry } from '../../src/runtime/task-read-port.ts'
import { displaySeamStub } from '../support/display-seam-stub.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'
import { runOwned } from '../../src/runtime/process/tasks.ts'
import {
  layerNodes,
  pickerNode,
  pickerProps,
  sendAction,
  sendPickerAction,
  sendResize,
  sendActivate,
  sendSelect,
  wireNodes,
  type WireNode,
} from '../support/tsp-picker-wire.ts'

const HUB = 'work-hub-'
const HOSTILE = '\x1b]52;c;UFdORUQ=\x07echo ok\x1b[2J'

const hubProps = (pane: TspPane): Record<string, unknown> => pickerProps(pane, HUB)
const hubItems = (pane: TspPane): Array<Record<string, unknown>> =>
  (hubProps(pane).items ?? []) as Array<Record<string, unknown>>
const hubOrder = (pane: TspPane): Array<string | PickerGroup> => (hubProps(pane).order ?? []) as Array<string | PickerGroup>
const pickers = (pane: TspPane): WireNode[] => layerNodes(pane, HUB).filter(node => node.k === 'picker')
const actionIds = (pane: TspPane): string[] =>
  ((hubProps(pane).actions ?? []) as Array<Record<string, unknown>>).map(action => String(action.id).replace(/#\d+$/u, ''))

/** One wire text node's complete text (plain text and spans alike). */
function nodeText(node: WireNode): string {
  if (typeof node.p.text === 'string') return node.p.text
  const spans = node.p.spans
  if (!Array.isArray(spans)) return ''
  return spans.map(entry => {
    if (typeof entry === 'string') return entry
    const span = entry as { readonly t?: unknown }
    return typeof span.t === 'string' ? span.t : ''
  }).join('')
}

/** The mounted Inspector's visible text. */
function inspectorText(pane: TspPane): string {
  return layerNodes(pane, HUB)
    .filter(node => node.id.includes('work-hub-inspector'))
    .map(nodeText)
    .filter(text => text !== '')
    .join('\n')
}

function visibleText(pane: TspPane): string {
  return layerNodes(pane, HUB).map(nodeText).filter(text => text !== '').join('\n')
}

function focusTargets(pane: TspPane): unknown[] {
  const targets: unknown[] = []
  for (const frame of pane.frames()) {
    for (const op of frame.ops) if (op[0] === 'focus') targets.push(op[1])
  }
  return targets
}

function row(value: string, overrides: Partial<TaskPanelItem> = {}): TaskPanelItem {
  return {
    value,
    label: value,
    status: 'running',
    source: 'job',
    type: 'bash',
    active: true,
    ...overrides,
  }
}

function options(overrides: Partial<TaskBrowserPresentationOpen> = {}): TaskBrowserPresentationOpen {
  return {
    header: 'Tasks',
    mode: 'full',
    openedFrom: 'command',
    scope: 'all',
    enableSearch: true,
    expandedIds: [],
    collapsedIds: [],
    maxVisible: 18,
    loading: false,
    groupLabels: true,
    onRefresh: () => {},
    onStop: () => {},
    onViewportExpose: () => {},
    onRetired: () => {},
    ...overrides,
  }
}

interface WorkHubHarness {
  readonly pane: TspPane
  readonly renderer: TspRenderer
  readonly opens: TaskBrowserPresentationHandle[]
  readonly selects: string[]
  readonly closes: number[]
  readonly retires: string[]
  readonly refreshes: number[]
  readonly stops: string[]
  readonly exposed: string[][]
  open(items: readonly TaskPanelItem[], overrides?: Partial<TaskBrowserPresentationOpen>): TaskBrowserPresentationHandle
}

/**
 * Mount the REAL renderer over the scripted pane. The default pane advertises
 * the Session Browser's native kinds and `scroll`, which is ALSO exactly what
 * the temporary Work Details Reader needs — so the default harness is a
 * Reader-capable pane; a case that must prove the fail-closed capability
 * decides its own advertised `kinds`/`features`, or opts into `workDetails`
 * without the Session Browser.
 */
async function mount(
  t: { after(fn: () => unknown): void },
  paneOptions: { readonly workDetails?: boolean; readonly kinds?: readonly string[]; readonly features?: readonly string[] } = {},
): Promise<WorkHubHarness> {
  const pane = installTspPane({ sessionBrowser: true, ...paneOptions })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane must connect through the shipped SDK')
  const fatals: unknown[] = []
  const renderer = mountTspRenderer(session, { copyVisual: async () => false,
    requestExit() {},
    onFatal: (error) => { fatals.push(error) },
  })
  t.after(() => renderer.dispose())
  renderer.bindInput({
    exit() {},
    cancel() {},
    submit: () => assert.fail('Work Hub input must never reach the composer submit path'),
    steer() {},
    pasteMedia: () => {},
    pastedPath: () => {},
    admitPastedPathDelivery: () => true, shouldRememberInput: () => true,
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true, openTasksBrowserUi() {}, tasksBrowserUiAvailable: () => true,
  })
  const opens: TaskBrowserPresentationHandle[] = []
  const harness: WorkHubHarness = {
    pane,
    renderer,
    opens,
    selects: [],
    closes: [],
    retires: [],
    refreshes: [],
    stops: [],
    exposed: [],
    open(items, overrides = {}) {
      const handle = renderer.taskPresentation.openBrowser(
        items,
        (value) => {
          harness.selects.push(value)
          return 'close'
        },
        () => { harness.closes.push(1) },
        options({
          onRefresh: () => { harness.refreshes.push(1) },
          onStop: value => { harness.stops.push(value) },
          onViewportExpose: ids => { harness.exposed.push([...ids]) },
          onRetired: reason => { harness.retires.push(reason) },
          ...overrides,
        }),
      )
      opens.push(handle)
      return handle
    },
  }
  return harness
}

async function waitForSinglePicker(pane: TspPane): Promise<void> {
  await waitUntil('the Work Hub picker is the only mounted picker', () => pickers(pane).length === 1)
}

// ── A1-T01: stable group order and identity ────────────────────────────────

test('rows keep the attention → subagent pre-order → active-Jobs order with stable IDs, while retained Jobs stay hidden', async (t) => {
  const h = await mount(t)
  const items: TaskPanelItem[] = [
    row('question:sess-a:call-a', { label: 'Choose deployment region', status: 'awaiting answer', source: 'question', group: 'Needs attention', canStop: false, active: false }),
    row('agent:child-1', { label: 'subagent · inspect pool', status: 'inactive', source: 'subagent', type: 'subagent', mode: 'one-shot', suffix: 'one-shot', depth: 1, active: false }),
    row('agent:child-2', { label: 'subagent · check saturation', status: 'running', source: 'subagent', type: 'subagent', mode: 'one-shot', suffix: 'one-shot', parentId: 'agent:child-1', depth: 2 }),
    row('agent:child-3', { label: 'subagent · verify depth', status: 'inactive', source: 'subagent', type: 'subagent', mode: 'one-shot', suffix: 'one-shot', parentId: 'agent:child-2', depth: 3, treePrefix: '  │ └ ', active: false }),
    row('agent:external-1', { label: 'external · remote run', status: 'External', source: 'subagent', type: 'subagent', mode: 'external', suffix: 'external', depth: 1, active: false }),
    row('job:j1', { label: 'build', status: 'running' }),
    row('job:j2', { label: 'test', status: 'failed', active: false, attention: true }),
  ]
  h.open(items)
  await waitForSinglePicker(h.pane)
  assert.deepEqual(hubOrder(h.pane), [
    { group: 'work-attention', label: 'Needs attention', count: 1 },
    'question:sess-a:call-a',
    { group: 'work-subagents', label: 'Work · Subagents', count: 4 },
    'agent:child-1',
    'agent:child-2',
    'agent:child-3',
    'agent:external-1',
    { group: 'work-jobs', label: 'Work · Jobs', count: 1 },
    'job:j1',
  ], 'the default view keeps every non-Job row and only active Jobs, in input order')
  assert.deepEqual(hubItems(h.pane).map(item => item.id),
    ['question:sess-a:call-a', 'agent:child-1', 'agent:child-2', 'agent:child-3', 'agent:external-1', 'job:j1'],
    'the collapsed history is absent from items, not merely hidden by CSS')
  assert.equal(new Set(hubItems(h.pane).map(item => item.id)).size, 6, 'IDs are unique')
  assert.equal(hubProps(h.pane).selected, 'question:sess-a:call-a', 'the attention-first initial selection')
  assert.equal(hubProps(h.pane).subtitle, '1 attention · 2 running · 1 failed · 1 retained Jobs hidden',
    'the status facts come from the FULL roster, including the folded failure')
  assert.deepEqual((hubProps(h.pane).actions as Array<Record<string, unknown>>).map(action => String(action.id).replace(/#\d+$/u, '')),
    ['close', 'jobs-history', 'details'], 'the native action bar offers Close, Show and View details')
})

// ── A1-T02: the empty state still carries a working Close ──────────────────

test('an empty catalog paints the truthful empty text and keeps Close executable', async (t) => {
  const h = await mount(t)
  h.open([])
  await waitForSinglePicker(h.pane)
  assert.equal(hubProps(h.pane).empty, 'No tasks are available for this session.')
  assert.equal(hubProps(h.pane).total, 0)
  assert.equal('selected' in hubProps(h.pane), false, 'no row is selected')
  assert.equal(hubItems(h.pane).length, 0)
  sendPickerAction(h.pane, 'close', HUB)
  await waitUntil('the empty hub closes from its native action', () => h.closes.length === 1)
})

test('a loading Hub publishes an EMPTY roster with state loading, so an empty items list proves nothing until ready', async (t) => {
  // The readiness contract this repository's consumers rely on: `PickerProps.
  // state` is the presenter's own projection of the read it owns, and a
  // `loading` frame carries `items: []`. A consumer that reads `items` without
  // gating on `state` therefore sees the same empty array for "the read settled
  // and found nothing" and "the read has not committed yet".
  const h = await mount(t)
  const handle = h.open([], { loading: true })
  await waitUntil('the loading Hub picker is mounted', () => hubProps(h.pane).state === 'loading')
  assert.deepEqual(hubItems(h.pane), [], 'the loading frame carries no row')
  assert.equal(hubProps(h.pane).total, 0, 'and claims no total')
  // The coordinator's commit is the ONLY transition to a settled roster.
  handle.setRefreshState('ready')
  await waitUntil('the Hub settled ready', () => hubProps(h.pane).state === 'ready')
  assert.deepEqual(hubItems(h.pane), [], 'the settled roster is genuinely empty')
  assert.equal(hubProps(h.pane).empty, 'No tasks are available for this session.')
})

// ── A1-T03/T04/T05: the frozen attention-first selection ladder ─────────────

test('initial selection is attention-first, then visible failed work, then the first work row', async (t) => {
  const h = await mount(t)
  h.open([
    row('agent:child-1', { label: 'subagent · idle', status: 'inactive', source: 'subagent', mode: 'one-shot', suffix: 'one-shot', active: false }),
    row('question:sess-a:call-a', { label: 'Choose a region', status: 'awaiting answer', source: 'question', active: false }),
  ])
  await waitUntil('the first Question wins', () => hubProps(h.pane).selected === 'question:sess-a:call-a')

  h.open([
    row('job:j1', { label: 'build', status: 'running' }),
    row('job:j2', { label: 'test', status: 'failed', active: false, attention: true }),
    row('agent:child-1', { label: 'subagent · later', status: 'running', source: 'subagent', mode: 'continuable', suffix: 'continuable' }),
    row('agent:failed', { label: 'subagent · failed review', status: 'failed', source: 'subagent', mode: 'one-shot', suffix: 'one-shot', active: false }),
  ])
  await waitUntil('no Question: a visible failed work row wins over the hidden failed Job',
    () => hubProps(h.pane).selected === 'agent:failed')
  assert.ok(!hubItems(h.pane).some(item => item.id === 'job:j2'), 'the failed Job is not a visible initial selection')

  h.open([row('job:j1', { label: 'build', status: 'running' })])
  await waitUntil('no attention: the first work row wins', () => hubProps(h.pane).selected === 'job:j1')
})

// ── A1-T06/T07/T08: local selection and stable refresh ─────────────────────

test('a native select changes only the local selection and the Inspector', async (t) => {
  const h = await mount(t)
  h.open([
    row('job:j1', { label: 'build' }),
    row('job:j2', { label: 'test', status: 'failed', active: false, attention: true }),
  ])
  await waitUntil('the first active Job is initially selected', () => hubProps(h.pane).selected === 'job:j1')
  sendPickerAction(h.pane, 'jobs-history', HUB)
  await waitUntil('the retained Job is revealed by the native action', () => hubItems(h.pane).some(item => item.id === 'job:j2'))
  sendSelect(h.pane, 'job:j2', pickerNode(h.pane, HUB)!.id)
  await waitUntil('the select updates the local selection', () => hubProps(h.pane).selected === 'job:j2')
  assert.ok(inspectorText(h.pane).includes('test'), `the Inspector follows the selection:\n${inspectorText(h.pane)}`)
  assert.deepEqual(h.selects, [], 'a native select never runs the business selection router')
  assert.equal(h.closes.length, 0)
})

test('an active Job turning terminal while collapsed leaves the visible set without a phantom selection', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1', { label: 'build', status: 'running' })])
  await waitForSinglePicker(h.pane)
  const before = pickerNode(h.pane, HUB)!.id
  assert.equal(hubProps(h.pane).selected, 'job:j1')
  h.opens[0]!.setItems([row('job:j1', { label: 'build', status: 'inactive', active: false })])
  await waitUntil('the collapsed history hides the terminal Job', () => hubItems(h.pane).length === 0)
  assert.equal(pickerNode(h.pane, HUB)!.id, before, 'the panel/picker identity is stable')
  assert.equal(hubProps(h.pane).selected ?? undefined, undefined, 'no invisible row stays selected')
  assert.equal(hubProps(h.pane).empty, 'No active Jobs in this view.', 'the frame states the real active-empty view')
  assert.deepEqual((hubProps(h.pane).actions as Array<Record<string, unknown>>).map(action => String(action.id).replace(/#\d+$/u, '')),
    ['close', 'jobs-history'], 'Show is the only real browse action left')
  assert.equal((hubProps(h.pane).actions as Array<Record<string, unknown>>)[1]!.primary, true,
    'without a readable row the history action is the primary action')
})

test('a status tick keeps an expanded history panel identity and selection', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1', { label: 'build', status: 'running' }), row('job:j2', { label: 'old', status: 'completed', active: false })])
  await waitForSinglePicker(h.pane)
  sendPickerAction(h.pane, 'jobs-history', HUB)
  await waitUntil('the history is expanded and its first row selected', () => hubProps(h.pane).selected === 'job:j2')
  const before = pickerNode(h.pane, HUB)!.id
  h.opens[0]!.setItems([row('job:j1', { label: 'build', status: 'inactive', active: false }), row('job:j2', { label: 'old', status: 'completed', active: false })])
  await waitUntil('the visible status words update', () => JSON.stringify(hubItems(h.pane)).includes('inactive'))
  assert.equal(pickerNode(h.pane, HUB)!.id, before, 'the panel/picker identity is stable')
  assert.equal(hubProps(h.pane).selected, 'job:j2', 'an expanded terminal selection is retained across the refresh')
  assert.deepEqual(hubItems(h.pane).map(item => item.id), ['job:j1', 'job:j2'], 'the expanded history keeps both rows visible')
})

test('a removed selected row falls to its successor, then to its predecessor', async (t) => {
  const h = await mount(t)
  h.open([row('job:a'), row('job:b'), row('job:c')])
  await waitUntil('the first job is selected', () => hubProps(h.pane).selected === 'job:a')
  h.opens[0]!.setItems([row('job:b'), row('job:c')])
  await waitUntil('the successor takes over', () => hubProps(h.pane).selected === 'job:b')
  assert.ok(!inspectorText(h.pane).includes('Stable ID job:a'), 'the vanished ID is not a target')
  h.opens[0]!.setItems([row('job:b')])
  assert.equal(hubProps(h.pane).selected, 'job:b', 'a surviving selection is kept')
  h.opens[0]!.setItems([])
  await waitUntil('no rows: no selection', () => hubProps(h.pane).selected === undefined || hubProps(h.pane).selected === null)
})

// ── A1-T09/T10: local query and terminal-text safety ───────────────────────

test('the query filters only the local rows, keeps order and never re-lists', async (t) => {
  const h = await mount(t)
  h.open([
    row('job:j1', { label: '构建 deployment' }),
    row('job:j2', { label: 'review report' }),
    row('job:j3', { label: '构建 verification' }),
  ])
  await waitUntil('the first row is selected', () => hubProps(h.pane).selected === 'job:j1')
  h.pane.key('构')
  await waitUntil('the CJK query filters the rows', () => hubProps(h.pane).query === '构')
  assert.deepEqual(hubItems(h.pane).map(item => item.id), ['job:j1', 'job:j3'],
    'the filter keeps the input order and only matches real fields')
  h.pane.key('\x7f')
  await waitUntil('clearing the query restores every row', () => hubItems(h.pane).length === 3)
  assert.equal(hubProps(h.pane).selected, 'job:j1', 'a valid selection is not stolen by clearing')
})

test('hostile label bytes are sanitized on the wire while the stable ID is untouched', async (t) => {
  const h = await mount(t)
  h.open([row('job:hostile', { label: `bash · ${HOSTILE}` })])
  await waitForSinglePicker(h.pane)
  const wire = JSON.stringify(hubItems(h.pane))
  assert.ok(!wire.includes('UFdORUQ='), 'no OSC 52 payload reaches the wire')
  assert.ok(!wire.includes('\\u001b]52'), 'no raw control introducer reaches the wire')
  assert.ok(wire.includes('echo ok'), 'the readable label content survives')
  assert.equal(hubItems(h.pane)[0]!.id, 'job:hostile', 'the row ID is never display-sanitized')
})

// ── PR3: retained-Job disclosure (the native Work Hub contract) ─────────────

test('a Job whose type is subagent still hides when terminal, while a real failed subagent stays visible', async (t) => {
  const h = await mount(t)
  h.open([
    row('job:sub', { label: 'job that reports a subagent type', status: 'completed', type: 'subagent', active: false }),
    row('agent:failed', { label: 'real failed subagent', status: 'failed', source: 'subagent', mode: 'one-shot', suffix: 'one-shot', active: false }),
  ])
  await waitForSinglePicker(h.pane)
  assert.deepEqual(hubItems(h.pane).map(item => item.id), ['agent:failed'],
    'the job is classified by source (not its type), and a non-Job failure is never hidden')
  assert.deepEqual(actionIds(h.pane), ['close', 'jobs-history', 'details'],
    'the hidden terminal Job still contributes the disclosure action')
})

test('a history-only roster paints no Jobs group and no phantom row, with an honest empty and Show as the primary action', async (t) => {
  const h = await mount(t)
  h.open([
    row('job:old', { label: 'old lint', status: 'completed', active: false }),
    row('job:bad', { label: 'old deploy', status: 'failed', active: false, attention: true }),
  ])
  await waitForSinglePicker(h.pane)
  assert.equal(hubProps(h.pane).total, 0)
  assert.deepEqual(hubItems(h.pane), [])
  assert.deepEqual(hubOrder(h.pane), [])
  assert.equal(hubProps(h.pane).empty, 'No active Jobs in this view.')
  assert.equal(hubProps(h.pane).subtitle, '1 failed · 2 retained Jobs hidden')
  assert.deepEqual(actionIds(h.pane), ['close', 'jobs-history'])
  assert.equal((hubProps(h.pane).actions as Array<Record<string, unknown>>)[1]!.primary, true,
    'the only real browse action is primary when nothing is readable')
  assert.deepEqual(h.exposed, [], 'opening the hub already acknowledges nothing')

  sendPickerAction(h.pane, 'jobs-history', HUB)
  await waitUntil('the retained Jobs become the only visible rows', () => hubItems(h.pane).length === 2)
  assert.deepEqual(hubItems(h.pane).map(item => item.id), ['job:old', 'job:bad'])
  assert.deepEqual(hubOrder(h.pane), [
    { group: 'work-jobs', label: 'Work · Jobs', count: 2 },
    'job:old',
    'job:bad',
  ], 'the Jobs group is created only from real visible rows')
  assert.equal(hubProps(h.pane).selected, 'job:old', 'the first history row becomes the real selection')
  assert.deepEqual(actionIds(h.pane), ['close', 'jobs-history', 'details'])
  assert.equal((hubProps(h.pane).actions as Array<Record<string, unknown>>)[2]!.primary, true,
    'View details is primary again once a row can be read')
  assert.deepEqual(h.exposed, [], 'the disclosure never fakes a viewport acknowledgement')
})

test('plain j is always query text, and the search reaches a retained failed Job without changing the manual disclosure', async (t) => {
  const h = await mount(t)
  h.open([
    row('job:j1', { label: 'build', status: 'running' }),
    row('job:j2', { label: 'old lint', status: 'completed', active: false }),
    row('job:j3', { label: 'deploy', status: 'failed', active: false }),
  ])
  await waitUntil('the active Job is initially selected', () => hubProps(h.pane).selected === 'job:j1')
  h.pane.key('failed')
  await waitUntil('the query reaches the hidden failed Job', () => JSON.stringify(hubItems(h.pane)).includes('job:j3') && hubProps(h.pane).query === 'failed')
  assert.deepEqual(hubItems(h.pane).map(item => item.id), ['job:j3'], 'the search corpus is the full roster')
  assert.deepEqual(actionIds(h.pane), ['close', 'details'], 'a non-empty query paints no history action')
  h.pane.key('\x7f'.repeat(6))
  await waitUntil('the query is cleared', () => hubProps(h.pane).query === '')
  assert.deepEqual(hubItems(h.pane).map(item => item.id), ['job:j1'],
    'clearing the query restores the manual collapsed view')
  assert.equal(hubProps(h.pane).selected ?? undefined, undefined,
    'a selection that only existed under the query is cleared rather than kept as a hidden target')
  assert.deepEqual(actionIds(h.pane), ['close', 'jobs-history'])
  h.pane.key('\u001b[B')
  await waitUntil('the user can select the real visible row again', () => hubProps(h.pane).selected === 'job:j1')
  assert.deepEqual(actionIds(h.pane), ['close', 'jobs-history', 'details'])
})

test('Alt+J and the native action share one local toggle, while a modless j remains query text', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1', { label: 'build', status: 'running' }), row('job:j2', { label: 'old lint', status: 'completed', active: false })])
  await waitUntil('the active Job is selected', () => hubProps(h.pane).selected === 'job:j1')
  h.pane.key('j')
  await waitUntil('a plain j edits the query', () => hubProps(h.pane).query === 'j')
  assert.deepEqual(hubItems(h.pane).map(item => item.id), ['job:j1', 'job:j2'],
    'the query matched the stable ids without expanding the manual history')
  h.pane.key('\x7f')
  await waitUntil('the query is cleared', () => hubProps(h.pane).query === '')
  h.pane.key('\x1bj')
  await waitUntil('Alt+J expands the history', () => hubProps(h.pane).selected === 'job:j2' && hubItems(h.pane).length === 2)
  assert.equal(hubProps(h.pane).query, '', 'Alt+J never writes query text')
  h.pane.key('\x1bj')
  await waitUntil('Alt+J hides the history again', () => hubProps(h.pane).selected === 'job:j1' && hubItems(h.pane).length === 1)
  assert.deepEqual(h.selects, [], 'the local toggle never runs the business selection router')
  assert.deepEqual(h.stops, [])
})

test('the action zone ring follows the real action list across Close, history and details', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1', { label: 'build', status: 'running' }), row('job:j2', { label: 'old lint', status: 'completed', active: false })])
  await waitUntil('the active Job is selected', () => hubProps(h.pane).selected === 'job:j1')
  h.pane.key('\t')
  await waitUntil('Tab focuses the readable primary action', () => JSON.stringify(hubProps(h.pane).actions).includes('View details [Enter]'))
  h.pane.key('\u001b[D')
  await waitUntil('left moves to the history action', () => JSON.stringify(hubProps(h.pane).actions).includes('Show 1 past jobs [Enter]'))
  h.pane.key('\u001b[D')
  await waitUntil('left again reaches Close', () => JSON.stringify(hubProps(h.pane).actions).includes('Close [Enter]'))
  h.pane.key('\u001b[C')
  h.pane.key('\u001b[C')
  await waitUntil('right returns to View details through the history action', () => JSON.stringify(hubProps(h.pane).actions).includes('View details [Enter]'))
  h.pane.key('\u001b[D')
  h.pane.key('\r')
  await waitUntil('Enter on the focused history action toggles the disclosure', () => hubItems(h.pane).length === 2 && hubProps(h.pane).selected === 'job:j2')
  assert.deepEqual(h.selects, [], 'an action-zone Enter is the local disclosure, never a business select')
})

test('a stale or bare history action never toggles the current panel; the current revision does', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1', { label: 'build', status: 'running' }), row('job:j2', { label: 'old lint', status: 'completed', active: false })])
  await waitUntil('the active Job is selected', () => hubProps(h.pane).selected === 'job:j1')
  const pickerId = pickerNode(h.pane, HUB)!.id
  const historyAction = (hubProps(h.pane).actions as Array<Record<string, unknown>>).find(action => String(action.id).startsWith('jobs-history#'))!
  const currentId = String(historyAction.id)
  sendAction(h.pane, currentId.replace(/\d+$/u, '0'), undefined, pickerId)
  sendAction(h.pane, 'jobs-history', undefined, pickerId)
  await waitUntil('the stale and bare ids change nothing', () => hubItems(h.pane).length === 1)
  assert.equal(hubProps(h.pane).selected, 'job:j1')
  sendAction(h.pane, currentId, undefined, pickerId)
  await waitUntil('the exact current token toggles', () => hubItems(h.pane).length === 2)
  assert.deepEqual(h.selects, [], 'no history token reaches the business router')
})

test('the manual disclosure survives candidate refreshes, resets when the last terminal Job disappears, and never crosses a new panel', async (t) => {
  const h = await mount(t)
  const handle = h.open([row('job:j1', { label: 'build', status: 'running' }), row('job:j2', { label: 'old lint', status: 'completed', active: false })])
  await waitUntil('the active Job is selected', () => hubProps(h.pane).selected === 'job:j1')
  sendPickerAction(h.pane, 'jobs-history', HUB)
  await waitUntil('the history is expanded', () => hubItems(h.pane).length === 2)
  handle.setItems([
    row('job:j1', { label: 'build', status: 'running' }),
    row('job:j2', { label: 'old lint', status: 'completed', active: false }),
    row('job:j3', { label: 'older deploy', status: 'failed', active: false }),
  ])
  await waitUntil('a refreshed candidate set keeps the manual expansion', () => hubItems(h.pane).length === 3 && hubProps(h.pane).selected === 'job:j2')
  assert.deepEqual(actionIds(h.pane), ['close', 'jobs-history', 'details'])
  handle.setItems([row('job:j1', { label: 'build', status: 'running' })])
  await waitUntil('the last terminal Job resets the expansion', () => hubItems(h.pane).length === 1)
  assert.equal(hubProps(h.pane).selected, 'job:j1')
  assert.deepEqual(actionIds(h.pane), ['close', 'details'], 'with no candidate the disclosure action disappears')
  h.open([row('job:j1', { label: 'build', status: 'running' }), row('job:j2', { label: 'old lint', status: 'completed', active: false })])
  await waitUntil('a new panel starts collapsed with its own history candidate',
    () => hubItems(h.pane).length === 1 && actionIds(h.pane).includes('jobs-history'))
  assert.deepEqual(hubItems(h.pane).map(item => item.id), ['job:j1'], 'the new panel resets the manual expansion')
})

// ── A2: the local Read intent, never a fabricated lifecycle verb ───────────

test('a current row with the negotiated Reader capabilities exposes Close plus the primary View details action', async (t) => {
  const h = await mount(t)
  h.open([
    row('agent:child-1', { label: 'subagent · audit', status: 'inactive', source: 'subagent', mode: 'one-shot', suffix: 'one-shot', depth: 1, active: false }),
    row('agent:ext-1', { label: 'external · remote', status: 'External', source: 'subagent', mode: 'external', suffix: 'external', depth: 1, active: false }),
  ])
  await waitForSinglePicker(h.pane)
  const details = hubItems(h.pane).map(item => String(item.detail ?? ''))
  assert.ok(details.some(detail => detail.includes('inactive') && detail.includes('one-shot')),
    `the inactive child is never relabelled completed: ${details.join(' | ')}`)
  assert.ok(details.some(detail => detail.includes('External')), `the external leaf is named External: ${details.join(' | ')}`)
  const actions = (hubProps(h.pane).actions ?? []) as Array<Record<string, unknown>>
  // The native footer is dismissal plus the ONE local read action, and the
  // read action carries the revision of the frame that painted it.
  assert.deepEqual(actions.map(action => String(action.id)).map(id => id.replace(/#\d+$/u, '')),
    ['close', 'details'], 'the footer is Close plus View details')
  assert.equal(actions[1]!.primary, true, 'View details is the primary action')
  const body = JSON.stringify({ ...hubProps(h.pane), actions: [] })
  assert.ok(!body.includes('Stop') && !body.includes('Interrupt') && !body.includes('Answer'),
    'the Hub fabricates no lifecycle verb')
  assert.equal(hubProps(h.pane).message, undefined, 'a capable pane states no unavailability')
})

test('the current `View details` action opens the current target, and a stale revision does nothing', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1', { label: 'build' }), row('job:j2', { label: 'test' })])
  await waitUntil('the failed-free first row is selected', () => hubProps(h.pane).selected === 'job:j1')
  const actions = (hubProps(h.pane).actions ?? []) as Array<Record<string, unknown>>
  const currentId = String(actions[1]!.id)
  // The token is the revision that painted this frame, so an OLDER revision
  // (and the bare intent id) can never act on a newer frame.
  assert.equal(/^details#\d+$/u.test(currentId), true, `the read action is revision-tokened: ${currentId}`)
  const pickerId = pickerNode(h.pane, HUB)!.id
  const screens = (): number => h.pane.openSurfaces().filter(entry => entry.mode === 'screen').length
  sendAction(h.pane, currentId.replace(/\d+$/u, '0'), undefined, pickerId)
  sendAction(h.pane, 'details', undefined, pickerId)
  await waitUntil('the stale tokens are settled as no-ops', () => screens() === 0)
  assert.equal(screens(), 0, 'neither an older revision nor the bare intent id opens a Screen')
  assert.deepEqual(h.selects, [], 'an ignored read action runs no business router')

  sendAction(h.pane, currentId, undefined, pickerId)
  await waitUntil('the current action opens the Reader', () => screens() === 1)
  assert.equal(screens(), 1, 'the current registered action opens exactly one Screen')
  assert.deepEqual(h.selects, [], 'the read action never runs the business row router')
})

test('the footer action set follows the CURRENT selection, and a vanished target offers no read action', async (t) => {
  const h = await mount(t)
  const handle = h.open([row('job:j1', { label: 'build' }), row('job:j2', { label: 'test' })])
  await waitUntil('the first row is selected', () => hubProps(h.pane).selected === 'job:j1')
  sendSelect(h.pane, 'job:j2', pickerNode(h.pane, HUB)!.id)
  await waitUntil('the second row is selected', () => hubProps(h.pane).selected === 'job:j2')
  const ids = (): string[] => ((hubProps(h.pane).actions ?? []) as Array<Record<string, unknown>>)
    .map(action => String(action.id).replace(/#\d+$/u, ''))
  assert.deepEqual(ids(), ['close', 'details'], 'a current selection keeps the read action')

  // An EMPTY dataset is the real "no target" state: dismissal stays, the read
  // action does not (a dead button is not a read intent).
  handle.setItems([])
  await waitUntil('the empty dataset repaints the footer', () => ids().length === 1)
  assert.deepEqual(ids(), ['close'], 'with no current row only Close remains')
  assert.equal(h.pane.openSurfaces().filter(entry => entry.mode === 'screen').length, 0,
    'no Screen was opened by the empty repaint')
  assert.deepEqual(h.selects, [], 'the empty repaint is not a business selection')
})

test('a pane that negotiated no Reader kinds shows only Close plus the truthful unavailability line', async (t) => {
  // The fail-closed negative: no `row`/`text` kinds, so no Screen can be built
  // and NO action may be offered (a no-op button is not an unavailable state).
  const h = await mount(t, { kinds: ['col', 'picker', 'overlay'], features: ['flow'] })
  h.open([row('job:j1', { label: 'build' })])
  await waitForSinglePicker(h.pane)
  const actions = (hubProps(h.pane).actions ?? []) as Array<Record<string, unknown>>
  assert.deepEqual(actions.map(action => action.id), ['close'],
    'a pane without the Reader capabilities exposes ONLY the native Close action')
  assert.equal(String(hubProps(h.pane).message), 'Work details unavailable in this pane.',
    'the missing capability is stated truthfully instead of faking an action')
  assert.ok(!JSON.stringify(hubProps(h.pane)).includes('View details'), 'no placeholder details action exists')
  // Enter remains a consumed no-op: it neither opens anything nor touches the
  // business router.
  h.pane.key('\r')
  h.pane.key('\t')
  await waitUntil('the action zone is reached', () => JSON.stringify(hubProps(h.pane).actions).includes('Close [Enter]'))
  assert.deepEqual(h.selects, [], 'a missing capability never falls back to the business router')
  assert.equal(h.renderer.display.supportsTaskCenter, false, 'the capability never flips the seam')
})

// ── A1/A2-T12/T13/T14: activate/close/Esc admission ────────────────────────

test('an activate of a row that is not the current selection opens nothing', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1', { label: 'build' }), row('job:j2', { label: 'test' })])
  await waitUntil('the first job is selected', () => hubProps(h.pane).selected === 'job:j1')
  const screensBefore = h.pane.frames().filter(frame => frame.sf !== 's1').length
  sendActivate(h.pane, 'job:j2', pickerNode(h.pane, HUB)!.id)
  h.pane.key('\t')
  await waitUntil('the Tab cue lands', () => JSON.stringify(hubProps(h.pane).actions).includes('[Enter]'))
  assert.equal(hubProps(h.pane).selected, 'job:j1', 'a non-current activate never switches and opens')
  assert.equal(h.pane.frames().filter(frame => frame.sf !== 's1').length, screensBefore,
    'a non-current activate opens no temporary Screen')
  assert.deepEqual(h.selects, [], 'activate never runs the business router')
  assert.deepEqual(h.stops, [], 'activate never stops a Job')
  assert.deepEqual(h.refreshes, [], 'activate never refreshes')
  assert.deepEqual(h.exposed, [], 'activate never fakes a viewport acknowledgement')
})

test('the native Close action retires the panel once and returns focus to the composer', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1')])
  await waitForSinglePicker(h.pane)
  sendPickerAction(h.pane, 'close', HUB)
  await waitUntil('the native Close retires the panel', () => h.closes.length === 1 && pickers(h.pane).length === 0)
  await waitUntil('focus returns to the composer', () => focusTargets(h.pane).at(-1) === 'dock.composer')
  assert.deepEqual(h.retires, ['cancel'], 'the user close notifies the owner once')
  assert.deepEqual(h.selects, [], 'Close is not a business selection')
})

test('Esc closes the hub even with a non-empty query instead of clearing it', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1', { label: 'build' })])
  await waitForSinglePicker(h.pane)
  h.pane.key('b')
  await waitUntil('the query is live', () => hubProps(h.pane).query === 'b')
  h.pane.key('\u001b')
  await waitUntil('Esc closes the hub', () => h.closes.length === 1 && pickers(h.pane).length === 0)
  assert.deepEqual(h.retires, ['cancel'])
})

// ── A1-T15: modal-first suspension preserves local state ───────────────────

test('a modal owns the keyboard and the Hub resumes with its selection and query', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1', { label: 'build' }), row('job:j2', { label: 'test' })])
  await waitUntil('the first job is selected', () => hubProps(h.pane).selected === 'job:j1')
  h.pane.key('\u001b[B')
  await waitUntil('the second job is selected', () => hubProps(h.pane).selected === 'job:j2')
  h.pane.key('b')
  await waitUntil('the query is live', () => hubProps(h.pane).query === 'b')
  const pending = h.renderer.interaction.showApprovalPrompt({ toolName: 'bash', reason: 'needs a shell', arguments: '{}' }, true)
  await waitUntil('the approval overlay replaces the Hub layer', () => pickers(h.pane).length === 0)
  h.pane.key('\u001b[B')
  h.pane.key('\u001b[B')
  h.pane.key('n')
  assert.equal(await pending, 'rejected')
  await waitForSinglePicker(h.pane)
  await waitUntil('the hub resumes with the same selection and query', () =>
    hubProps(h.pane).selected === 'job:j2' && hubProps(h.pane).query === 'b')
})

// ── A1-T16/T17/T18: retirement, stale targets and frame identity ───────────

test('session hydration retires the open Hub and an old frame event cannot reach a new panel', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1')])
  await waitForSinglePicker(h.pane)
  const oldPickerId = pickerNode(h.pane, HUB)!.id
  const sf = h.pane.frames().at(-1)!.sf
  h.renderer.display.beginSessionHydration()
  await waitUntil('hydration retires the Hub', () => h.retires.includes('external') && pickers(h.pane).length === 0)
  h.open([row('job:j2')])
  await waitForSinglePicker(h.pane)
  h.pane.event({ ev: 'select', sf, id: oldPickerId, item: 'job:j1' })
  await waitUntil('the new panel is selected', () => hubProps(h.pane).selected === 'job:j2')
  assert.equal(hubProps(h.pane).selected, 'job:j2', 'a retired frame target never changes the new panel')
})

test('a newer panel survives the older panel\'s late event and handle close', async (t) => {
  const h = await mount(t)
  h.open([row('job:old-a', { label: 'old' })])
  await waitForSinglePicker(h.pane)
  const first = h.opens[0]!
  const firstPickerId = pickerNode(h.pane, HUB)!.id
  const sf = h.pane.frames().at(-1)!.sf
  h.open([row('job:new-a', { label: 'new' })])
  await waitUntil('the second panel is mounted', () => hubProps(h.pane).selected === 'job:new-a')
  h.pane.event({ ev: 'select', sf, id: firstPickerId, item: 'job:old-a' })
  first.close()
  await waitUntil('the newer panel is unaffected', () => hubProps(h.pane).selected === 'job:new-a' && pickers(h.pane).length === 1)
  assert.equal(h.closes.length, 0, 'a programmatic handle close never fakes a user close')
})

test('a synchronous re-open from a retirement callback wins over the earlier open', async (t) => {
  const h = await mount(t)
  h.open([row('job:a', { label: 'a' })], {
    onRetired: () => { h.open([row('job:c', { label: 'c' })]) },
  })
  await waitForSinglePicker(h.pane)
  const earlier = h.open([row('job:b', { label: 'b' })])
  await waitUntil('the callback-opened C panel stays displayed',
    () => hubItems(h.pane).map(item => item.id).join(',') === 'job:c')
  earlier.setItems([row('job:b2', { label: 'b2' })])
  earlier.setRefreshState('stale', 'must not paint')
  earlier.close()
  // A lockstep barrier: this frame is queued AFTER any frame the earlier
  // handle could have caused, so the observation covers its whole effect.
  const framesBefore = h.pane.frameCount()
  h.renderer.display.notify('reentrant open barrier', 'info')
  await waitUntil('the barrier frame lands', () => h.pane.frameCount() > framesBefore)
  assert.deepEqual(hubItems(h.pane).map(item => item.id), ['job:c'], 'the earlier handle is fully inert')
  assert.equal(h.closes.length, 0, 'the inert close is not a user close')
})

test('a newer open synchronously closed in a retirement callback still beats the earlier open', async (t) => {
  const h = await mount(t)
  h.open([row('job:a', { label: 'a' })], {
    onRetired: () => { h.open([row('job:c', { label: 'c' })]).close() },
  })
  await waitForSinglePicker(h.pane)
  const earlier = h.open([row('job:b', { label: 'b' })])
  await waitUntil('the callback panel opened and closed again', () => pickers(h.pane).length === 0)
  earlier.setItems([row('job:b2', { label: 'b2' })])
  earlier.setRefreshState('loading')
  earlier.close()
  const framesBefore = h.pane.frameCount()
  h.renderer.display.notify('nested close barrier', 'info')
  await waitUntil('the barrier frame lands', () => h.pane.frameCount() > framesBefore)
  assert.equal(pickers(h.pane).length, 0, 'the earlier open must not resurrect a panel')
  assert.equal(h.closes.length, 0)
})

test('only a frame-registered node can act: a fabricated target is ignored', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1')])
  await waitForSinglePicker(h.pane)
  const sf = h.pane.frames().at(-1)!.sf
  const current = pickerNode(h.pane, HUB)!
  h.pane.event({ ev: 'action', sf, id: `${current.id}.made-up`, act: 'close' })
  await waitUntil('the fabricated target changes nothing', () => h.closes.length === 0)
  h.pane.event({ ev: 'select', sf, id: `${current.id}.made-up`, item: 'job:j1' })
  assert.deepEqual(h.selects, [])
  sendPickerAction(h.pane, 'close', HUB)
  await waitUntil('the real frame target still works', () => h.closes.length === 1)
})

// ── A1-T19/T20/T21: zones, responsive width and the narrow refusal ─────────

test('Tab enters the action zone on the primary View details action and Shift+Tab returns to the list', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1')])
  await waitForSinglePicker(h.pane)
  h.pane.key('\t')
  await waitUntil('Tab focuses the primary action', () => JSON.stringify(hubProps(h.pane).actions).includes('View details [Enter]'))
  assert.equal(h.closes.length, 0, 'Tab never closes')
  assert.equal(hubProps(h.pane).query, '', 'Tab is not query text')
  h.pane.key('\u001b[Z')
  await waitUntil('Shift+Tab returns to the list', () => !JSON.stringify(hubProps(h.pane).actions).includes('[Enter]'))
  assert.equal(h.closes.length, 0, 'Shift+Tab never closes either')
})

test('left/right move the action focus between Close and View details without running either', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1')])
  await waitForSinglePicker(h.pane)
  h.pane.key('\t')
  await waitUntil('the primary action holds the focus', () => JSON.stringify(hubProps(h.pane).actions).includes('View details [Enter]'))
  h.pane.key('\u001b[D')
  await waitUntil('left moves the focus to Close', () => JSON.stringify(hubProps(h.pane).actions).includes('Close [Enter]'))
  assert.equal(h.closes.length, 0, 'merely focusing Close never closes the Hub')
  h.pane.key('\u001b[C')
  await waitUntil('right moves the focus back to View details', () => JSON.stringify(hubProps(h.pane).actions).includes('View details [Enter]'))
  assert.equal(h.closes.length, 0)
})

test('the side Inspector is requested only at/above 1120 pane pixels', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1')])
  await waitForSinglePicker(h.pane)
  assert.equal(hubProps(h.pane).preview, 'none', '960px is a normal split pane')
  sendResize(h.pane, 160) // 160 * 8 = 1280px
  await waitUntil('1280px requests the side Inspector', () => hubProps(h.pane).preview === 'side')
  sendResize(h.pane, 112) // 112 * 8 = 896px
  await waitUntil('896px drops back to no preview', () => hubProps(h.pane).preview === 'none')
  assert.notEqual(hubProps(h.pane).preview, 'below', 'A1 never requests a below Inspector')
})

test('a 178px pane paints the unavailable line instead of a clipped actionable picker', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1')])
  await waitForSinglePicker(h.pane)
  sendResize(h.pane, 22) // 22 * 8 = 176px
  await waitUntil('the pane refuses the picker', () => pickers(h.pane).length === 0
    && visibleText(h.pane).includes('Work Hub unavailable at this pane width'))
  h.pane.key('\u001b')
  await waitUntil('Esc still closes the unavailable pane', () => h.closes.length === 1)
})

// ── A1-T22: REAL Task Runtime facts reach the TSP presenter ───────────────

test('real Task Runtime task facts commit through the TSP presentation port to the wire', async (t) => {
  const h = await mount(t)
  const jobs: TaskBrowserJobInput[] = [
    { id: 'j1', kind: 'bash', label: 'integration build', status: 'running', startedAt: 1_000 },
  ]
  const descendants: TaskSubagentEntry[] = [
    { kind: 'child', id: 'child-1', label: 'integration review', mode: 'continuable', activity: 'running', hasChildren: false, parentId: '', depth: 1 },
  ]
  const subject = {}
  const source: TaskSurfaceSource = {
    sessionId: () => 'sess-main',
    captureSubject: () => subject as never,
    subjectMatches: candidate => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async () => ({ kind: 'committed' } as never),
    rowSelectionDisposition: (_row, jobDetail) => jobDetail,
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: status => status,
    jobObservation: { open: () => () => {}, stop: async () => ({ kind: 'requested' }) },
    jobs: { list: () => jobs, subscribe: () => () => {} },
    taskRead: {
      currentKey: () => 'g1:sess-main',
      currentSessionId: () => 'sess-main',
      readTask: async () => ({ parentSessionId: 'sess-main', parentAvailable: true, descendants, jobs }),
      activityOf: () => 'running',
    },
  }
  const tasks = createTaskRuntime({
    mounted: () => { throw new Error('the TSP branch must never read a mounted PiTui app') },
    display: () => displaySeamStub({ supportsTaskCenter: true }),
    presentation: () => h.renderer.taskPresentation,
    isCleanedUp: () => false,
    attention: { rows: () => [], reconcile: () => {}, publish: () => {}, reopen: () => false },
    publishActivity: () => {},
  })
  t.after(() => tasks.resetTasks())
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  for (let index = 0; index < 12; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
  tasks.openTasksBrowser('full')
  await waitUntil('the real Task Runtime rows reach the wire', () =>
    hubItems(h.pane).some(item => item.id === 'agent:child-1') && hubItems(h.pane).some(item => item.id === 'job:j1'))
  assert.deepEqual(hubItems(h.pane).map(item => item.id), ['agent:child-1', 'job:j1'],
    'the presenter shows the exact Task Runtime projection, in its order')
  // B3-A3: this pane negotiated the Hub's `picker` AND the Reader's
  // `col`/`row`/`text` + `scroll`, so the display seam's ONE capability truth
  // is TRUE. The negative (a pane missing any of them) is the dedicated
  // capability test below; the Viewer capability never flips.
  assert.equal(h.renderer.display.supportsTaskCenter, true,
    'the negotiated pane declares the production Task Center capability')
  assert.equal(h.renderer.display.supportsViewer, false, 'the read-only Hub never adds a Viewer')
})

// ── Plan §10.2: the FOUR non-blocking presenters are mutually exclusive ─────

/** The pane's mounted layer must show exactly ONE of the four presenters. */
const mountedPickerKeys = (pane: TspPane): string[] =>
  wireNodes(pane)
    .filter(node => node.k === 'picker' || node.k === 'overlay')
    .map(node => String(node.p.key ?? ''))
    .filter(key => key !== '')

test('opening the Work Hub retires the Model, Preset and Session Browser presenters', async (t) => {
  const h = await mount(t)
  // A live Model presenter, then a Work Hub open straight through the
  // production presentation port.
  const model = h.renderer.modelPresentation
  assert.ok(model, 'the pane advertises the Model picker kinds')
  const modelHandle = model.open({
    subject: { sessionless: false },
    entry: 'models',
    isCurrent: () => true,
    retry: () => {},
    apply: () => 'committed',
    runOwned: (label, task, runOptions) =>
      runOwned(label, task, { ...runOptions, diag: { debug() {}, warn() {}, error() {} } as never }),
  })
  modelHandle.setDirectory({
    current: { provider: 'a', model: 'same' },
    directory: {
      default: { provider: 'a', model: 'same' },
      routableProviders: ['a'],
      groups: [{ id: 'a', name: 'A', models: [{ id: 'same', name: 'Twin' }] }],
      failures: [],
    },
  })
  await waitUntil('the Model presenter is mounted', () => mountedPickerKeys(h.pane).some(key => key.startsWith('model-')))
  h.open([row('job:j1', { label: 'build' })])
  await waitForSinglePicker(h.pane)
  await waitUntil('the Model picker is no longer mounted',
    () => !mountedPickerKeys(h.pane).some(key => key.startsWith('model-')))
  assert.equal(modelHandle.isDisposed(), true, 'the Model handle is retired, not merely hidden')
  // A late Model key must not reach the retired presenter: Tab now belongs to
  // the Work Hub action zone.
  h.pane.key('\t')
  await waitUntil('Tab still drives the Work Hub', () => JSON.stringify(hubProps(h.pane).actions).includes('View details [Enter]'))
  assert.deepEqual(mountedPickerKeys(h.pane), ['work-hub-picker-1'], 'exactly ONE presenter owns the layer')
})

test('opening a Session Browser retires the open Work Hub, and closing it returns to the composer', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1', { label: 'build' })])
  await waitForSinglePicker(h.pane)
  const browserPresentation = h.renderer.sessionBrowserPresentation
  assert.ok(browserPresentation, 'the pane advertises the Session Browser kinds')
  let closes = 0
  const subject = { currentSessionId: 'session-current', currentCwd: '/workspace/project', isCurrent: () => true }
  const handle = browserPresentation.open({
    subject,
    onQueryChange: () => {},
    onResumeIntent: () => {},
    onClose: () => { closes += 1 },
  })
  await waitUntil('the Session Browser replaces the Work Hub',
    () => mountedPickerKeys(h.pane).some(key => key.startsWith('session-browser-'))
      && !mountedPickerKeys(h.pane).some(key => key.startsWith('work-hub-')))
  assert.deepEqual(h.retires, ['external'], 'the Work Hub was retired by the sibling open (not a user close)')
  assert.equal(h.closes.length, 0, 'a sibling retirement never fabricates a user Close')
  // Esc closes the Browser; focus returns to the composer, NOT to the old Hub.
  h.pane.key('\u001b')
  await waitUntil('Esc closes the Session Browser', () => closes === 1)
  const framesBefore = h.pane.frameCount()
  h.renderer.display.notify('post-browser barrier', 'info')
  await waitUntil('the barrier frame lands', () => h.pane.frameCount() > framesBefore)
  assert.deepEqual(mountedPickerKeys(h.pane), [], 'the retired Work Hub does not reappear')
  assert.equal(focusTargets(h.pane).at(-1), 'dock.composer', 'focus returns to the composer')
  handle.close()
})

test('a newer Hub opened by a sibling retirement callback beats the earlier open', async (t) => {
  const h = await mount(t)
  // The Session Browser's own close callback fires on PROGRAMMATIC retirement
  // (the read owner's release) and synchronously opens a newer Work Hub while
  // an OUTER Work Hub open is still retiring the siblings. That newer open owns
  // the seat, so the outer open must come back inert.
  const browserPresentation = h.renderer.sessionBrowserPresentation
  assert.ok(browserPresentation)
  const subject = { currentSessionId: 'session-current', currentCwd: '/workspace/project', isCurrent: () => true }
  const browserHandle = browserPresentation.open({
    subject,
    onQueryChange: () => {},
    onResumeIntent: () => {},
    onClose: () => { h.open([row('job:inner', { label: 'inner' })]) },
  })
  await waitUntil('the Session Browser is mounted',
    () => mountedPickerKeys(h.pane).some(key => key.startsWith('session-browser-')))
  const outer = h.open([row('job:outer', { label: 'outer' })])
  await waitUntil('the callback-opened inner Hub owns the layer',
    () => hubItems(h.pane).map(item => item.id).join(',') === 'job:inner')
  outer.setItems([row('job:outer2', { label: 'outer2' })])
  outer.setRefreshState('loading')
  outer.close()
  const framesBefore = h.pane.frameCount()
  h.renderer.display.notify('sibling generation barrier', 'info')
  await waitUntil('the barrier frame lands', () => h.pane.frameCount() > framesBefore)
  assert.deepEqual(hubItems(h.pane).map(item => item.id), ['job:inner'],
    'the earlier open is inert and never replaces the callback-opened panel')
  assert.equal(mountedPickerKeys(h.pane).filter(key => key.startsWith('work-hub-')).length, 1,
    'exactly ONE Hub panel is displayed')
  browserHandle.close()
})

test('the Preset presenter and the Work Hub retire each other in both directions', async (t) => {
  const h = await mount(t)
  const preset = h.renderer.presetPresentation
  assert.ok(preset, 'the pane advertises the Preset picker kinds')
  const presetHandle = preset.open({
    subject: { sessionless: true },
    isCurrent: () => true,
    retry: () => {},
    apply: async () => ({ kind: 'superseded' }),
    setDefault: async () => ({ kind: 'superseded' }),
    runOwned: (label, task, runOptions) =>
      runOwned(label, task, { ...runOptions, diag: { debug() {}, warn() {}, error() {} } as never }),
  })
  presetHandle.setRoster({
    roster: { presets: [{ id: 'standard' }], defaultId: 'standard' },
    currentId: undefined,
    pendingId: undefined,
    defaultId: 'standard',
    canSetDefault: true,
  })
  await waitUntil('the Preset presenter is mounted',
    () => mountedPickerKeys(h.pane).some(key => key.startsWith('preset-')))
  h.open([row('job:j1', { label: 'build' })])
  await waitForSinglePicker(h.pane)
  await waitUntil('the Preset presenter is retired by the Hub open',
    () => presetHandle.isDisposed() && !mountedPickerKeys(h.pane).some(key => key.startsWith('preset-')))
  // The reverse direction: a Preset open retires the displayed Hub.
  const reopened = preset.open({
    subject: { sessionless: true },
    isCurrent: () => true,
    retry: () => {},
    apply: async () => ({ kind: 'superseded' }),
    setDefault: async () => ({ kind: 'superseded' }),
    runOwned: (label, task, runOptions) =>
      runOwned(label, task, { ...runOptions, diag: { debug() {}, warn() {}, error() {} } as never }),
  })
  await waitUntil('the Preset presenter replaces the Hub',
    () => mountedPickerKeys(h.pane).some(key => key.startsWith('preset-'))
      && !mountedPickerKeys(h.pane).some(key => key.startsWith('work-hub-')))
  assert.deepEqual(h.retires, ['external'], 'the Hub was retired by the sibling open')
  assert.equal(h.closes.length, 0, 'a sibling retirement is never a user Close')
  reopened.close()
})

test('a stale sibling sweep stops when a retirement callback opens a still-to-be-retired presenter', async (t) => {
  const h = await mount(t)
  const browserPresentation = h.renderer.sessionBrowserPresentation
  const modelPresentation = h.renderer.modelPresentation
  assert.ok(browserPresentation)
  assert.ok(modelPresentation)
  const subject = { currentSessionId: 'session-current', currentCwd: '/workspace/project', isCurrent: () => true }
  let nestedHub: TaskBrowserPresentationHandle | undefined
  // The OUTER open is the Model presenter: its sibling sweep is
  // Preset -> Session Browser -> Work Hub. Retiring the Session Browser runs
  // this `onClose`, which opens the Work Hub — a presenter that is STILL LATER
  // in that stale sweep. The sweep must stop, never retire the newer Hub.
  const browserHandle = browserPresentation.open({
    subject,
    onQueryChange: () => {},
    onResumeIntent: () => {},
    onClose: () => { nestedHub = h.open([row('job:inner', { label: 'inner' })]) },
  })
  await waitUntil('the Session Browser is mounted',
    () => mountedPickerKeys(h.pane).some(key => key.startsWith('session-browser-')))
  const outer = modelPresentation.open({
    subject: { sessionless: false },
    entry: 'models',
    isCurrent: () => true,
    retry: () => {},
    apply: () => 'committed',
    runOwned: (label, task, runOptions) =>
      runOwned(label, task, { ...runOptions, diag: { debug() {}, warn() {}, error() {} } as never }),
  })
  await waitUntil('the callback-opened Hub owns the layer',
    () => hubItems(h.pane).map(item => item.id).join(',') === 'job:inner')
  assert.ok(nestedHub !== undefined, 'the Session Browser retirement opened the newer Hub')
  assert.equal(outer.isDisposed(), true, 'the superseded outer Model open returned an inert handle')
  assert.deepEqual(mountedPickerKeys(h.pane).filter(key => key.startsWith('work-hub-')).length, 1,
    'the newer Hub survives the stale sweep')
  assert.equal(mountedPickerKeys(h.pane).some(key => key.startsWith('model-')), false,
    'the superseded outer Model presenter never mounted')
  // The newer Hub's OWN handle is live: it still receives commits.
  nestedHub.setItems([row('job:inner2', { label: 'inner2' })])
  await waitUntil('the newer Hub handle still drives the panel',
    () => hubItems(h.pane).map(item => item.id).join(',') === 'job:inner2')
  browserHandle.close()
})
