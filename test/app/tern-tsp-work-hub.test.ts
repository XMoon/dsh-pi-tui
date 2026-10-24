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

async function mount(t: { after(fn: () => unknown): void }): Promise<WorkHubHarness> {
  const pane = installTspPane({ sessionBrowser: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane must connect through the shipped SDK')
  const fatals: unknown[] = []
  const renderer = mountTspRenderer(session, {
    requestExit() {},
    onFatal: (error) => { fatals.push(error) },
  })
  t.after(() => renderer.dispose())
  renderer.bindInput({
    exit() {},
    cancel() {},
    submit: () => assert.fail('Work Hub input must never reach the composer submit path'),
    steer() {},
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
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

test('rows keep the attention → subagent pre-order → flat jobs order with stable IDs', async (t) => {
  const h = await mount(t)
  const items: TaskPanelItem[] = [
    row('question:sess-a:call-a', { label: 'Choose deployment region', status: 'awaiting answer', source: 'question', group: 'Needs attention', canStop: false, active: false }),
    row('agent:child-1', { label: 'subagent · inspect pool', status: 'inactive', source: 'subagent', type: 'subagent', mode: 'one-shot', suffix: 'one-shot', depth: 1, active: false }),
    row('agent:child-2', { label: 'subagent · check saturation', status: 'running', source: 'subagent', type: 'subagent', mode: 'one-shot', suffix: 'one-shot', parentId: 'agent:child-1', depth: 2 }),
    row('agent:external-1', { label: 'external · remote run', status: 'External', source: 'subagent', type: 'subagent', mode: 'external', suffix: 'external', depth: 1, active: false }),
    row('job:j1', { label: 'build', status: 'running' }),
    row('job:j2', { label: 'test', status: 'failed', active: false, attention: true }),
  ]
  h.open(items)
  await waitForSinglePicker(h.pane)
  const order = hubOrder(h.pane)
  assert.deepEqual(order, [
    { group: 'work-attention', label: 'Needs attention', count: 1 },
    'question:sess-a:call-a',
    { group: 'work-subagents', label: 'Work · Subagents', count: 3 },
    'agent:child-1',
    'agent:child-2',
    'agent:external-1',
    { group: 'work-jobs', label: 'Work · Jobs', count: 2 },
    'job:j1',
    'job:j2',
  ], 'the groups and the input order are preserved verbatim')
  assert.deepEqual(hubItems(h.pane).map(item => item.id), items.map(item => item.value),
    'every row keeps its stable identity in input order')
  assert.equal(new Set(hubItems(h.pane).map(item => item.id)).size, items.length, 'IDs are unique')
  assert.equal(hubProps(h.pane).selected, 'question:sess-a:call-a', 'the attention-first initial selection')
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

// ── A1-T03/T04/T05: the frozen attention-first selection ladder ─────────────

test('initial selection is attention-first, then failed work, then the first work row', async (t) => {
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
  ])
  await waitUntil('no Question: the attention work row wins', () => hubProps(h.pane).selected === 'job:j2')

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
  await waitUntil('the failed work row is initially selected', () => hubProps(h.pane).selected === 'job:j2')
  sendSelect(h.pane, 'job:j1', pickerNode(h.pane, HUB)!.id)
  await waitUntil('the select updates the local selection', () => hubProps(h.pane).selected === 'job:j1')
  assert.ok(inspectorText(h.pane).includes('build'), `the Inspector follows the selection:\n${inspectorText(h.pane)}`)
  assert.deepEqual(h.selects, [], 'a native select never runs the business selection router')
  assert.equal(h.closes.length, 0)
})

test('a status tick keeps the panel serial and selection while updating the row', async (t) => {
  const h = await mount(t)
  const items = [row('job:j1', { label: 'build', status: 'running' })]
  h.open(items)
  await waitForSinglePicker(h.pane)
  const before = pickerNode(h.pane, HUB)!.id
  assert.equal(hubProps(h.pane).selected, 'job:j1')
  h.opens[0]!.setItems([row('job:j1', { label: 'build', status: 'inactive', active: false })])
  await waitUntil('the status word updates', () => String(hubItems(h.pane)[0]?.detail ?? '').includes('inactive'))
  assert.equal(pickerNode(h.pane, HUB)!.id, before, 'the panel/picker identity is stable')
  assert.equal(hubProps(h.pane).selected, 'job:j1', 'a status tick never steals the selection')
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

// ── A1-T11: no fabricated lifecycle verbs ─────────────────────────────────

test('inactive one-shot and external rows stay truthful and expose no fake actions', async (t) => {
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
  assert.deepEqual(actions.map(action => action.id), ['close'], 'A1 exposes ONLY the native Close action')
  assert.ok(!JSON.stringify(hubProps(h.pane)).includes('View details'), 'no placeholder details action exists')
})

// ── A1-T12/T13/T14: activate/close/Esc admission ───────────────────────────

test('activate and Enter are consumed without a business action or panel change', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1', { label: 'build' }), row('job:j2', { label: 'test' })])
  await waitUntil('the first job is selected', () => hubProps(h.pane).selected === 'job:j1')
  sendActivate(h.pane, 'job:j2', pickerNode(h.pane, HUB)!.id)
  h.pane.key('\r')
  // A subsequent Tab forces a committed frame: the ordered input loop has
  // therefore consumed the activate/Enter before this observation.
  h.pane.key('\t')
  await waitUntil('the Tab cue lands', () => JSON.stringify(hubProps(h.pane).actions).includes('Close [Enter]'))
  assert.equal(hubProps(h.pane).selected, 'job:j1', 'activate/Enter never changes the panel selection')
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

test('Tab and Shift+Tab switch only the list/actions zone and never close', async (t) => {
  const h = await mount(t)
  h.open([row('job:j1')])
  await waitForSinglePicker(h.pane)
  h.pane.key('\t')
  await waitUntil('Tab focuses the Close action', () => JSON.stringify(hubProps(h.pane).actions).includes('Close [Enter]'))
  assert.equal(h.closes.length, 0, 'Tab never closes')
  assert.equal(hubProps(h.pane).query, '', 'Tab is not query text')
  h.pane.key('\u001b[Z')
  await waitUntil('Shift+Tab returns to the list', () => !JSON.stringify(hubProps(h.pane).actions).includes('Close [Enter]'))
  assert.equal(h.closes.length, 0, 'Shift+Tab never closes either')
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
  })
  t.after(() => tasks.resetTasks())
  tasks.attachTasks(source, { diag: createDiag({ filePath: undefined, stderrLevel: 'off' }), isCleanedUp: () => false })
  for (let index = 0; index < 12; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
  tasks.openTasksBrowser('full')
  await waitUntil('the real Task Runtime rows reach the wire', () =>
    hubItems(h.pane).some(item => item.id === 'agent:child-1') && hubItems(h.pane).some(item => item.id === 'job:j1'))
  assert.deepEqual(hubItems(h.pane).map(item => item.id), ['agent:child-1', 'job:j1'],
    'the presenter shows the exact Task Runtime projection, in its order')
  assert.equal(h.renderer.display.supportsTaskCenter, false,
    'the real TSP display seam still declares no production Task Center (A1)')
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
  await waitUntil('Tab still drives the Work Hub', () => JSON.stringify(hubProps(h.pane).actions).includes('Close [Enter]'))
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
