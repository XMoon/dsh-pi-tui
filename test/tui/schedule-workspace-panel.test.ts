/**
 * The Schedule workspace panel: the responsive frame, the semantic key
 * ladder, the distinct status/execution/delivery-floor facts, the one
 * confirmation fence and the last-painted-frame mouse map.
 *
 * These cases drive the REAL panel with a structural controller snapshot; a
 * fake dispatch records exactly the intents the host would receive. They do
 * not run a Host, a screen lease or a terminal.
 *
 * @module @xmoon76/dsh-pi-tui/schedule-workspace-panel.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import {
  ScheduleWorkspacePanel,
  scheduleWorkspaceLayout,
} from '../../src/tui/schedule/workspace-panel.ts'
import type {
  ScheduleCatalogEntry,
  ScheduleIntent,
  ScheduleWorkspaceSnapshot,
} from '../../src/app/schedule/presentation.ts'
import type { ScheduleEditorDraft } from '../../src/domain/schedule/form.ts'

interface FrameSize {
  readonly columns: number
  readonly rows: number
}

interface TaskOverrides {
  readonly id: string
  readonly title: string
  readonly status?: ScheduleCatalogEntry['status']
  readonly prompt?: string
  readonly scheduledAt?: string
  readonly executionActive?: true
  readonly deliveryFloorEndsAt?: string
  readonly lastDelivery?: NonNullable<ScheduleCatalogEntry['lastDelivery']>
}

/** One official-shaped catalog row (the brand is compile-time only). */
function task(overrides: TaskOverrides): ScheduleCatalogEntry {
  return {
    kind: 'daily',
    time: '09:00:00',
    timeZone: 'Asia/Shanghai',
    scheduledAt: '2026-06-01T09:00:00.000Z',
    prompt: 'Prepare the morning report.',
    target: { kind: 'session', sessionId: 'session-target' },
    involvedSessionIds: [],
    status: 'active',
    ...overrides,
  } as unknown as ScheduleCatalogEntry
}

function workspace(overrides: Partial<ScheduleWorkspaceSnapshot> = {}): ScheduleWorkspaceSnapshot {
  return {
    status: 'ready',
    filter: 'all',
    query: '',
    rows: [],
    total: 0,
    mode: 'list',
    sessions: [],
    busy: false,
    ...overrides,
  }
}

function draft(overrides: Partial<ScheduleEditorDraft> = {}): ScheduleEditorDraft {
  return {
    mode: 'create',
    title: '',
    prompt: '',
    timing: { kind: 'daily', time: '09:00:00', timeZone: 'UTC' },
    timingEdited: false,
    target: { kind: 'new_once', cwd: '', agentPreset: '' },
    targetEdited: false,
    advanced: false,
    focused: 0,
    ...overrides,
  }
}

interface Harness {
  /** One real pointer gesture: press then release on the same cell. */
  click(x: number, y: number): void
  readonly panel: ScheduleWorkspacePanel
  readonly dispatches: ScheduleIntent[]
  readonly snapshot: () => ScheduleWorkspaceSnapshot
  readonly setSnapshot: (snapshot: ScheduleWorkspaceSnapshot) => void
  readonly closeCount: () => number
  readonly render: () => string[]
  readonly plain: () => string[]
  readonly resetDispatches: () => void
}

function harness(initial: ScheduleWorkspaceSnapshot, size: FrameSize): Harness {
  let snapshot = initial
  let closed = 0
  const dispatches: ScheduleIntent[] = []
  const panel = new ScheduleWorkspacePanel({
    snapshot: () => snapshot,
    dispatch: intent => { dispatches.push(intent) },
    requestRender: () => {},
    rows: () => size.rows,
    columns: () => size.columns,
    close: () => { closed += 1 },
  })
  return {
    click: (x: number, y: number): void => {
      panel.onCellPress(x, y)
      panel.onCellClick(x, y)
    },
    panel,
    dispatches,
    snapshot: () => snapshot,
    setSnapshot: next => {
      snapshot = next
      panel.setSnapshot(next)
    },
    closeCount: () => closed,
    render: () => panel.render(size.columns),
    plain: () => panel.render(size.columns).map(stripTerminalSequences),
    resetDispatches: () => { dispatches.length = 0 },
  }
}

const FOUR_TASKS: readonly ScheduleCatalogEntry[] = [
  task({ id: 'task-alpha', title: 'Alpha report', status: 'active' }),
  task({ id: 'task-bravo', title: 'Bravo digest', status: 'active', scheduledAt: '2026-06-01T10:00:00.000Z' }),
  task({ id: 'task-charlie', title: 'Charlie review', status: 'paused', scheduledAt: '2026-06-01T11:00:00.000Z' }),
  task({ id: 'task-delta', title: 'Delta cleanup', status: 'ended', scheduledAt: '2026-06-01T12:00:00.000Z' }),
]

const LIST = workspace({
  rows: FOUR_TASKS,
  total: FOUR_TASKS.length,
  selectedId: 'task-alpha',
})

// ── 1. responsive frame ──────────────────────────────────────────────────────

test('the four product sizes paint width-safe frames and switch layout at 120×30', () => {
  const sizes: readonly FrameSize[] = [
    { columns: 160, rows: 50 },
    { columns: 100, rows: 30 },
    { columns: 80, rows: 24 },
    { columns: 60, rows: 12 },
  ]
  for (const size of sizes) {
    const view = harness(LIST, size)
    const lines = view.render()
    assert.ok(lines.length > 0, `${size.columns}×${size.rows} painted nothing`)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= size.columns, `${size.columns}×${size.rows} row exceeds the width: ${JSON.stringify(line)}`)
    }
    assert.equal(
      scheduleWorkspaceLayout(size.columns, size.rows),
      size.columns >= 120 && size.rows >= 30 ? 'wide' : 'single',
      `${size.columns}×${size.rows} layout`,
    )
  }
  assert.equal(scheduleWorkspaceLayout(120, 30), 'wide')
  assert.equal(scheduleWorkspaceLayout(119, 30), 'single')
  assert.equal(scheduleWorkspaceLayout(120, 29), 'single')
})

test('the wide frame paints the detail column beside the task catalog', () => {
  const view = harness(LIST, { columns: 160, rows: 50 })
  const lines = view.plain()
  const wideLine = lines.find(line => line.includes('Details'))
  assert.ok(wideLine !== undefined, 'the wide frame must paint the detail column')
  assert.ok(wideLine.includes('Alpha report'), 'the task row must stay in the left column')
  assert.ok(
    wideLine.indexOf('Details') > wideLine.indexOf('Alpha report'),
    'the detail heading must be painted to the right of the catalog row',
  )
  assert.ok(wideLine.indexOf('Details') >= Math.floor((160 - 2) * 0.4))
})

test('the single-column frames do not paint the wide detail column', () => {
  for (const size of [{ columns: 100, rows: 30 }, { columns: 80, rows: 24 }, { columns: 60, rows: 12 }]) {
    const lines = harness(LIST, size).plain()
    assert.ok(!lines.some(line => line.includes('Details')), `${size.columns}×${size.rows} painted a second column`)
  }
})

test('the 60×12 minimum keeps at least three task rows on screen', () => {
  const lines = harness(LIST, { columns: 60, rows: 12 }).plain()
  const painted = ['Alpha report', 'Bravo digest', 'Charlie review'].filter(title => lines.some(line => line.includes(title)))
  assert.equal(painted.length, 3)
})

test('the narrow action bar keeps the essential keys and puts Esc last (D8)', () => {
  const lines = harness(LIST, { columns: 60, rows: 12 }).plain()
  const bar = lines[lines.length - 1]
  assert.ok(bar !== undefined, 'the narrow frame paints an action bar')
  for (const token of ['Enter', 'n', '/', 'Esc close']) {
    assert.ok(bar.includes(token), `the narrow bar keeps \"${token}\": ${JSON.stringify(bar)}`)
  }
  assert.match(bar, /\bEnter\b/u, `the Enter affordance survives narrow truncation: ${JSON.stringify(bar)}`)
  const escAt = bar.indexOf('Esc')
  assert.ok(escAt > 0 && bar.trimEnd().endsWith('close'), `Esc is the LAST segment: ${JSON.stringify(bar)}`)
})

// ── 2. no minimum-size refusal gate (design-language §8) ─────────────────────

for (const size of [{ columns: 44, rows: 20 }, { columns: 80, rows: 10 }, { columns: 59, rows: 11 }]) {
  test(`${size.columns}×${size.rows} stays fully interactive instead of refusing`, () => {
    const view = harness(LIST, size)
    const lines = view.plain()
    assert.ok(lines.some(line => line.includes('Alpha report')), 'the narrow/short frame still paints the task list')
    assert.ok(lines.every(line => line.length <= size.columns), 'no line exceeds the granted width')
    view.panel.handleInput('j')
    view.panel.handleInput('\r')
    assert.deepEqual(view.dispatches, [{ kind: 'move', delta: 1 }, { kind: 'open-detail' }])
    view.panel.handleInput('\x1b')
    assert.equal(view.closeCount(), 1, 'Esc still closes the workspace at the list root')
  })
}

// ── 3. status truth ──────────────────────────────────────────────────────────

test('an ended task renders status, execution activity and the delivery floor as separate facts', () => {
  const ended = task({
    id: 'task-ended',
    title: 'Ended run',
    status: 'ended',
    executionActive: true,
    deliveryFloorEndsAt: '2026-06-02T12:00:00.000Z',
    scheduledAt: '2026-06-01T09:00:00.000Z',
  })
  const snapshot = workspace({
    mode: 'detail',
    detail: ended,
    rows: [ended],
    total: 1,
    selectedId: ended.id,
  })
  const lines = harness(snapshot, { columns: 100, rows: 30 }).plain()
  const statusLine = lines.find(line => line.includes('Status'))
  const executionLine = lines.find(line => line.includes('Execution'))
  const floorLine = lines.find(line => line.includes('Delivery floor'))
  assert.ok(statusLine !== undefined && statusLine.includes('Ended'),
    'the Detail status fact uses the Title Case word (the marker belongs to the list status column)')
  assert.equal(statusLine.includes('‣'), false, 'D14.3: no repeated marker in an inline fact')
  assert.ok(executionLine !== undefined && executionLine.includes('in progress'), 'execution activity is its own fact')
  assert.ok(floorLine !== undefined && floorLine.includes('until '), 'the delivery floor is its own fact')
  assert.notEqual(statusLine, floorLine)
  assert.ok(!statusLine.includes('until '), 'the delivery floor is never painted as the task status')
  assert.ok(!floorLine.includes('Ended'), 'the delivery floor is never painted as a task status')
  assert.ok(!executionLine.includes('Ended'), 'execution activity is never painted as a task status')
})

// ── 4. list keys ─────────────────────────────────────────────────────────────

test('list navigation forwards one move intent per key', () => {
  const view = harness(LIST, { columns: 100, rows: 30 })
  view.panel.handleInput('\x1b[A')
  view.panel.handleInput('\x1b[B')
  view.panel.handleInput('j')
  view.panel.handleInput('k')
  assert.deepEqual(view.dispatches, [
    { kind: 'move', delta: -1 },
    { kind: 'move', delta: 1 },
    { kind: 'move', delta: 1 },
    { kind: 'move', delta: -1 },
  ])
})

test('search is local to the panel and set-query is dispatched per keystroke', () => {
  const view = harness(LIST, { columns: 100, rows: 30 })
  view.panel.handleInput('/')
  assert.deepEqual(view.dispatches, [], 'focusing search is panel-local')
  view.panel.handleInput('a')
  view.panel.handleInput('b')
  view.panel.handleInput('c')
  assert.deepEqual(view.dispatches, [
    { kind: 'set-query', query: 'a' },
    { kind: 'set-query', query: 'ab' },
    { kind: 'set-query', query: 'abc' },
  ])
  view.resetDispatches()
  view.panel.handleInput('\x1b')
  assert.deepEqual(view.dispatches, [], 'Esc leaves search without a Host action or a close')
  assert.equal(view.closeCount(), 0)
})

test('filter, refresh, create, clear, help, detail and root Esc dispatch their intents', () => {
  const view = harness(LIST, { columns: 100, rows: 30 })
  view.panel.handleInput('A')
  view.panel.handleInput('P')
  view.panel.handleInput('E')
  view.panel.handleInput('L')
  view.panel.handleInput('R')
  view.panel.handleInput('N')
  view.panel.handleInput('X')
  view.panel.handleInput('?')
  view.panel.handleInput('\r')
  assert.deepEqual(view.dispatches, [
    { kind: 'set-filter', filter: 'active' },
    { kind: 'set-filter', filter: 'paused' },
    { kind: 'set-filter', filter: 'ended' },
    { kind: 'set-filter', filter: 'all' },
    { kind: 'refresh' },
    { kind: 'open-create' },
    { kind: 'ask-clear-ended' },
    { kind: 'open-help' },
    { kind: 'open-detail' },
  ])
  const root = harness(LIST, { columns: 100, rows: 30 })
  root.panel.handleInput('\x1b')
  assert.deepEqual(root.dispatches, [])
  assert.equal(root.closeCount(), 1, 'the list root Esc closes the workspace')
})

// ── 5. detail / history / editor ─────────────────────────────────────────────

test('detail keys dispatch history, edit, toggle, run and delete', () => {
  const selected = task({ id: 'task-alpha', title: 'Alpha report', status: 'active' })
  const detail = workspace({ mode: 'detail', detail: selected, rows: [selected], total: 1, selectedId: selected.id })
  const view = harness(detail, { columns: 100, rows: 30 })
  view.panel.handleInput('H')
  view.panel.handleInput('E')
  view.panel.handleInput(' ')
  view.panel.handleInput('U')
  view.panel.handleInput('D')
  assert.deepEqual(view.dispatches, [
    { kind: 'open-history' },
    { kind: 'open-edit' },
    { kind: 'toggle-active' },
    { kind: 'ask-run' },
    { kind: 'ask-delete' },
  ])
  view.resetDispatches()
  view.panel.handleInput('\x1b')
  assert.deepEqual(view.dispatches, [{ kind: 'back' }])
})

test('history More is dispatched only while the Host reports a next cursor', () => {
  const withCursor = workspace({
    mode: 'history',
    history: {
      status: 'ready',
      records: [],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
      nextBefore: 'message-before',
    },
  })
  const more = harness(withCursor, { columns: 100, rows: 30 })
  more.panel.handleInput('\r')
  assert.deepEqual(more.dispatches, [{ kind: 'history-more' }])
  more.resetDispatches()
  more.panel.handleInput('\x1b')
  assert.deepEqual(more.dispatches, [{ kind: 'back' }])

  const exhausted = workspace({
    mode: 'history',
    history: {
      status: 'ready',
      records: [],
      earlierRecordsUnavailable: false,
      earlierRecordsPruned: false,
    },
  })
  const lastPage = harness(exhausted, { columns: 100, rows: 30 })
  lastPage.panel.handleInput('\r')
  assert.deepEqual(lastPage.dispatches, [], 'no cursor means no More action')
})

test('editor Ctrl+S saves, Tab steps fields and Esc backs out', () => {
  const save = harness(workspace({ mode: 'editor', editor: draft() }), { columns: 100, rows: 30 })
  save.panel.handleInput('\x13')
  assert.deepEqual(save.dispatches, [{ kind: 'save' }])

  const tab = harness(workspace({ mode: 'editor', editor: draft() }), { columns: 100, rows: 30 })
  tab.panel.handleInput('\t')
  assert.deepEqual(tab.dispatches, [{ kind: 'next-field', delta: 1 }])

  const backTab = harness(workspace({ mode: 'editor', editor: draft({ focused: 1 }) }), { columns: 100, rows: 30 })
  backTab.panel.handleInput('\x1b[Z')
  assert.deepEqual(backTab.dispatches, [{ kind: 'next-field', delta: -1 }])

  const back = harness(workspace({ mode: 'editor', editor: draft() }), { columns: 100, rows: 30 })
  back.panel.handleInput('\x1b')
  assert.deepEqual(back.dispatches, [{ kind: 'back' }])
})

test('an editor Tab past the last field uses focus-field instead of an out-of-range next-field', () => {
  const fields = draft({ focused: 6 })
  const view = harness(workspace({ mode: 'editor', editor: fields }), { columns: 100, rows: 30 })
  view.panel.handleInput('\t')
  assert.deepEqual(view.dispatches, [{ kind: 'focus-field', index: 0 }])
  view.resetDispatches()
  const first = harness(workspace({ mode: 'editor', editor: draft({ focused: 0 }) }), { columns: 100, rows: 30 })
  first.panel.handleInput('\x1b[Z')
  assert.deepEqual(first.dispatches, [{ kind: 'focus-field', index: 6 }])
})

test('typing into an editor text field dispatches set-field for the focused field', () => {
  const view = harness(workspace({ mode: 'editor', editor: draft({ title: '' }) }), { columns: 100, rows: 30 })
  view.panel.handleInput('N')
  view.panel.handleInput('e')
  view.panel.handleInput('w')
  assert.deepEqual(view.dispatches, [
    { kind: 'set-field', fieldId: 'title', value: 'N' },
    { kind: 'set-field', fieldId: 'title', value: 'Ne' },
    { kind: 'set-field', fieldId: 'title', value: 'New' },
  ])
})

// ── 6. confirmation fence ────────────────────────────────────────────────────

test('y confirms, n and Esc cancel the painted confirmation', () => {
  const confirm = workspace({ rows: [FOUR_TASKS[0]!], total: 1, confirm: { kind: 'delete', token: 3, id: 'task-alpha', title: 'Alpha report', shortId: 'task-alpha', expectedUpdatedAt: null } })
  const view = harness(confirm, { columns: 100, rows: 30 })
  view.render()
  view.panel.handleInput('y')
  assert.deepEqual(view.dispatches, [{ kind: 'confirm' }])
  view.resetDispatches()
  view.panel.handleInput('n')
  assert.deepEqual(view.dispatches, [{ kind: 'cancel' }])
  view.resetDispatches()
  view.panel.handleInput('\x1b')
  assert.deepEqual(view.dispatches, [{ kind: 'cancel' }])
})

test('a stale y cannot confirm a newer painted confirmation identity', () => {
  const older = workspace({ confirm: { kind: 'delete', token: 4, id: 'task-alpha', title: 'Alpha report', shortId: 'task-alpha', expectedUpdatedAt: null } })
  const view = harness(older, { columns: 100, rows: 30 })
  view.render()
  view.setSnapshot(workspace({ confirm: { kind: 'clear-ended', token: 5 } }))
  view.panel.handleInput('y')
  assert.deepEqual(view.dispatches, [], 'a y for the previous confirm kind/token must not commit the newer one')
  view.render()
  view.panel.handleInput('y')
  assert.deepEqual(view.dispatches, [{ kind: 'confirm' }])
})

test('clicking the painted y/n confirmation acts on that painted question', () => {
  const confirm = workspace({ confirm: { kind: 'run', token: 9, id: 'task-alpha', title: 'Alpha report' } })
  const view = harness(confirm, { columns: 100, rows: 30 })
  const lines = view.plain()
  const confirmRow = lines.findIndex(line => line.includes('Confirm [Y]'))
  assert.ok(confirmRow >= 0)
  const line = lines[confirmRow]!
  view.click(line.indexOf('Confirm [Y]') + 1, confirmRow)
  assert.deepEqual(view.dispatches, [{ kind: 'confirm' }])
  view.resetDispatches()
  view.click(line.indexOf('Cancel [N]') + 1, confirmRow)
  assert.deepEqual(view.dispatches, [{ kind: 'cancel' }])
})

// ── 7. mouse hit map ─────────────────────────────────────────────────────────

test('clicking a painted task row dispatches open-detail with that stable id', () => {
  const view = harness(LIST, { columns: 100, rows: 30 })
  const lines = view.plain()
  const row = lines.findIndex(line => line.includes('Alpha report'))
  assert.ok(row >= 0)
  view.click(2, row)
  assert.deepEqual(view.dispatches, [{ kind: 'open-detail', id: 'task-alpha' }])
})

test('a click after setSnapshot removed the painted row does nothing', () => {
  const view = harness(LIST, { columns: 100, rows: 30 })
  const lines = view.plain()
  const row = lines.findIndex(line => line.includes('Alpha report'))
  assert.ok(row >= 0)
  view.setSnapshot(workspace({
    rows: FOUR_TASKS.slice(1),
    total: FOUR_TASKS.length - 1,
    selectedId: 'task-bravo',
  }))
  view.click(2, row)
  assert.deepEqual(view.dispatches, [], 'the painted id left the latest snapshot, so the stale cell is inert')
})

test('clicking the painted New action dispatches open-create', () => {
  const view = harness(LIST, { columns: 100, rows: 30 })
  const lines = view.plain()
  const title = lines[0]!
  const column = title.indexOf('New')
  assert.ok(column >= 0, JSON.stringify(title))
  view.click(column, 0)
  assert.deepEqual(view.dispatches, [{ kind: 'open-create' }])
})

test('clicking a painted filter chip dispatches set-filter', () => {
  const view = harness(LIST, { columns: 100, rows: 30 })
  const lines = view.plain()
  const filterRow = lines.findIndex(line => line.includes('[Paused]'))
  assert.ok(filterRow >= 0)
  view.click(lines[filterRow]!.indexOf('[Paused]') + 1, filterRow)
  assert.deepEqual(view.dispatches, [{ kind: 'set-filter', filter: 'paused' }])
})

test('clicking a painted editor field focuses that stable field identity', () => {
  const view = harness(workspace({ mode: 'editor', editor: draft() }), { columns: 100, rows: 30 })
  const lines = view.plain()
  const fieldRow = lines.findIndex(line => line.includes('Title'))
  assert.ok(fieldRow >= 0)
  view.click(30, fieldRow)
  assert.deepEqual(view.dispatches, [{ kind: 'focus-field', index: 0 }])
})

test('a pointer event outside the painted frame dispatches nothing', () => {
  const view = harness(LIST, { columns: 100, rows: 30 })
  view.render()
  view.click(500, 0)
  view.click(0, 500)
  assert.deepEqual(view.dispatches, [])
})

// ── 8. render purity ────────────────────────────────────────────────────────

test('render alone dispatches nothing and never closes the workspace', () => {
  for (const snapshot of [
    LIST,
    workspace({ mode: 'detail', detail: FOUR_TASKS[0], rows: [FOUR_TASKS[0]!], total: 1 }),
    workspace({ mode: 'history', history: { status: 'ready', records: [], earlierRecordsUnavailable: true, earlierRecordsPruned: true, nextBefore: 'cursor' } }),
    workspace({ mode: 'editor', editor: draft() }),
    workspace({ mode: 'help' }),
    workspace({ confirm: { kind: 'clear-ended', token: 1 } }),
  ]) {
    const view = harness(snapshot, { columns: 160, rows: 50 })
    view.render()
    assert.deepEqual(view.dispatches, [], 'render must not dispatch')
    assert.equal(view.closeCount(), 0, 'render must not close')
  }
})

// ── editor choosers and toggles ──────────────────────────────────────────────

test('editor choice fields open a chooser and dispatch the chosen official value', () => {
  const timing = harness(workspace({ mode: 'editor', editor: draft({ focused: 2 }) }), { columns: 100, rows: 30 })
  timing.panel.handleInput('\r')
  assert.deepEqual(timing.dispatches, [], 'opening the chooser is panel-local')
  timing.panel.handleInput('\x1b[B')
  timing.panel.handleInput('\x1b[B')
  timing.panel.handleInput('\x1b[B')
  timing.panel.handleInput('\r')
  assert.deepEqual(timing.dispatches, [{ kind: 'select-timing-kind', timing: 'daily' }])

  const target = harness(workspace({ mode: 'editor', editor: draft({ focused: 5 }) }), { columns: 100, rows: 30 })
  target.panel.handleInput('\r')
  target.panel.handleInput('\r')
  assert.deepEqual(target.dispatches, [{ kind: 'select-target-kind', target: 'session' }])
})

test('editor weekday and advanced fields toggle in place', () => {
  const weekly = draft({
    timing: { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [1] },
    focused: 5,
  })
  const weekday = harness(workspace({ mode: 'editor', editor: weekly }), { columns: 100, rows: 30 })
  weekday.panel.handleInput('\r')
  assert.deepEqual(weekday.dispatches, [{ kind: 'toggle-weekday', weekday: 1 }])

  const advanced = harness(workspace({ mode: 'editor', editor: draft({ focused: 6 }) }), { columns: 100, rows: 30 })
  advanced.panel.handleInput('\r')
  assert.deepEqual(advanced.dispatches, [{ kind: 'toggle-advanced' }])
})

// ── wheel and help click ─────────────────────────────────────────────────────

test('the wheel scrolls the panel-local list viewport without a Host intent', () => {
  const many = Array.from({ length: 16 }, (_, index) => task({
    id: `task-${index}`,
    title: `Task ${index}`,
    status: 'active',
  }))
  const view = harness(workspace({ rows: many, total: many.length, selectedId: 'task-0' }), { columns: 60, rows: 12 })
  const before = view.plain()
  assert.ok(before.some(line => line.includes('Task 0')))
  const consumed = view.panel.handleMouse({
    type: 'wheel',
    button: 'none',
    x: 1,
    y: 5,
    screenX: 1,
    screenY: 5,
    width: 60,
    height: 12,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: 1,
  })
  assert.deepEqual(consumed, { handled: true, render: true })
  const after = view.plain()
  assert.ok(!after.some(line => line.includes('Task 0')), 'the first painted row scrolled away')
  assert.ok(after.some(line => line.includes('Task 8')))
  assert.deepEqual(view.dispatches, [], 'wheel scrolling never dispatches')
})

test('a non-wheel pointer event is not consumed', () => {
  const view = harness(LIST, { columns: 100, rows: 30 })
  view.render()
  const result = view.panel.handleMouse({
    type: 'press',
    button: 'left',
    x: 1,
    y: 4,
    screenX: 1,
    screenY: 4,
    width: 100,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
  })
  assert.equal(result, undefined)
})

test('clicking the painted help Esc action closes help with the same intent as the key', () => {
  const view = harness(workspace({ mode: 'help' }), { columns: 100, rows: 30 })
  const lines = view.plain()
  const bar = lines[lines.length - 1]!
  const column = bar.indexOf('Esc close help')
  assert.ok(column >= 0, JSON.stringify(bar))
  view.click(column, lines.length - 1)
  assert.deepEqual(view.dispatches, [{ kind: 'close-help' }])
})

test('a modal confirmation leaves the painted filter and search chrome inert', () => {
  const view = harness(workspace({
    rows: FOUR_TASKS,
    total: FOUR_TASKS.length,
    selectedId: 'task-alpha',
    confirm: { kind: 'clear-ended', token: 11 },
  }), { columns: 100, rows: 30 })
  const lines = view.plain()
  const filterRow = lines.findIndex(line => line.includes('[Paused]'))
  const searchRow = lines.findIndex(line => line.includes('Search /'))
  assert.ok(filterRow >= 0 && searchRow >= 0)
  view.click(lines[filterRow]!.indexOf('[Paused]') + 1, filterRow)
  view.click(2, searchRow)
  assert.deepEqual(view.dispatches, [], 'the confirmation blocks every background click')
})

test('the RRULE field edits real MULTI-LINE raw text (Enter inserts a line)', () => {
  const rrule = draft({
    timing: { kind: 'rrule', rrule: 'DTSTART;TZID=UTC:20260101T090000' },
    timingEdited: true,
    focused: 3,
  })
  const view = harness(workspace({ mode: 'editor', editor: rrule }), { columns: 100, rows: 30 })
  view.panel.focused = true
  view.resetDispatches()
  view.panel.handleInput('\r')
  assert.deepEqual(view.dispatches, [{
    kind: 'set-field',
    fieldId: 'timing-rrule',
    value: 'DTSTART;TZID=UTC:20260101T090000\n',
  }], 'Enter appends a real newline instead of saving')
  view.resetDispatches()
  view.panel.handleInput('R')
  const appended = view.dispatches[0]
  assert.equal(appended?.kind, 'set-field')
  assert.equal(appended?.kind === 'set-field' ? appended.value.endsWith('R') : false, true)
  // The next snapshot carries both lines, and the frame paints each stored
  // line: the value was never flattened to a single line.
  const snapshot = workspace({
    mode: 'editor',
    editor: draft({
      timing: { kind: 'rrule', rrule: 'DTSTART;TZID=UTC:20260101T090000\nRRULE:FREQ=DAILY' },
      timingEdited: true,
      focused: 3,
    }),
  })
  view.setSnapshot(snapshot)
  const lines = view.plain()
  assert.ok(lines.some(line => line.includes('DTSTART;TZID=UTC:20260101T090000')))
  assert.ok(lines.some(line => line.includes('RRULE:FREQ=DAILY')), `the second stored line is painted as its own row:\n${lines.join('\n')}`)
  // A terminal bracketed paste inserts its payload (newlines included) verbatim.
  view.resetDispatches()
  view.setSnapshot(workspace({ mode: 'editor', editor: draft({
    timing: { kind: 'rrule', rrule: 'A' },
    timingEdited: true,
    focused: 3,
  }) }))
  view.panel.handleInput('\x1b[200~DTSTART:20260101T090000\nRRULE:FREQ=DAILY\x1b[201~')
  const pasted = view.dispatches[0]
  assert.equal(pasted?.kind, 'set-field')
  assert.equal(pasted?.kind === 'set-field' ? pasted.value : '', 'ADTSTART:20260101T090000\nRRULE:FREQ=DAILY')
})

test('? opens Help from Detail, History and the Editor, not only the list', () => {
  const detail = harness(workspace({ mode: 'detail', detail: task({ id: 'task-a', title: 'A' }), rows: [task({ id: 'task-a', title: 'A' })], total: 1, selectedId: 'task-a' }), { columns: 100, rows: 30 })
  detail.panel.handleInput('?')
  assert.deepEqual(detail.dispatches, [{ kind: 'open-help' }])

  const history = harness(workspace({ mode: 'history', history: { status: 'ready', records: [], earlierRecordsUnavailable: false, earlierRecordsPruned: false } }), { columns: 100, rows: 30 })
  history.panel.handleInput('?')
  assert.deepEqual(history.dispatches, [{ kind: 'open-help' }])

  // Inside the editor, Help is the `?` action only on a NON-text field; a text
  // field owns the printable character.
  const editorChoice = harness(workspace({ mode: 'editor', editor: draft({ focused: 2 }) }), { columns: 100, rows: 30 })
  editorChoice.panel.handleInput('?')
  assert.deepEqual(editorChoice.dispatches, [{ kind: 'open-help' }])
})

test('a text field receives a literal question mark instead of opening Help', () => {
  // Title (focused 0), Prompt (1), Cron (3) and the multi-line RRULE (3).
  const title = harness(workspace({ mode: 'editor', editor: draft({ focused: 0 }) }), { columns: 100, rows: 30 })
  title.panel.handleInput('?')
  assert.deepEqual(title.dispatches, [{ kind: 'set-field', fieldId: 'title', value: '?' }])
  assert.equal(title.dispatches.some(intent => intent.kind === 'open-help'), false)

  const prompt = harness(workspace({
    mode: 'editor',
    editor: draft({ focused: 1, prompt: 'Check' }),
  }), { columns: 100, rows: 30 })
  prompt.panel.handleInput('?')
  assert.deepEqual(prompt.dispatches, [{ kind: 'set-field', fieldId: 'prompt', value: 'Check?' }])

  const cron = harness(workspace({
    mode: 'editor',
    editor: draft({
      focused: 3,
      timing: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
    }),
  }), { columns: 100, rows: 30 })
  cron.panel.handleInput('?')
  assert.deepEqual(cron.dispatches, [{ kind: 'set-field', fieldId: 'timing-cron', value: '0 9 * * *?' }])

  const rrule = harness(workspace({
    mode: 'editor',
    editor: draft({
      focused: 3,
      timing: { kind: 'rrule', rrule: 'DTSTART;TZID=UTC:20260101T090000' },
    }),
  }), { columns: 100, rows: 30 })
  rrule.panel.handleInput('?')
  assert.deepEqual(rrule.dispatches, [{
    kind: 'set-field',
    fieldId: 'timing-rrule',
    value: 'DTSTART;TZID=UTC:20260101T090000?',
  }])
  assert.equal(rrule.dispatches.some(intent => intent.kind === 'open-help'), false)
})

test('a multi-line Prompt is edited raw and painted line by line', () => {
  const raw = draft({ focused: 1, prompt: 'first line\nsecond line' })
  const view = harness(workspace({ mode: 'editor', editor: raw }), { columns: 100, rows: 30 })
  view.panel.focused = true
  view.resetDispatches()
  view.panel.handleInput('X')
  const edit = view.dispatches[0]
  assert.equal(edit?.kind, 'set-field')
  assert.equal(edit?.kind === 'set-field' ? edit.value : '', 'first line\nsecond lineX',
    'the stored newline is preserved and the typed character is appended')

  const stored = task({ id: 'task-multi', title: 'Multi', prompt: 'first line\nsecond line' })
  const detail = harness(workspace({ mode: 'detail', detail: stored, rows: [stored], total: 1, selectedId: stored.id }), { columns: 100, rows: 30 })
  const lines = detail.plain()
  assert.ok(lines.some(line => line.includes('first line')), 'the first stored line is painted')
  assert.ok(lines.some(line => line.includes('second line')), 'the second stored line is painted separately')
})

test('a paused task paints a neutral scheduled occurrence, never "final"', () => {
  const paused = task({ id: 'task-paused', title: 'Paused', status: 'paused' })
  const view = harness(workspace({
    mode: 'detail',
    detail: paused,
    rows: [paused],
    total: 1,
    selectedId: paused.id,
  }), { columns: 120, rows: 30 })
  const lines = view.plain()
  const occurrence = lines.find(line => line.includes('Occurrence'))
  assert.ok(occurrence !== undefined && occurrence.includes('scheduled '), `paused occurrence: ${JSON.stringify(occurrence)}`)
  assert.ok(!occurrence.includes('final '), 'a paused task has no final occurrence')
})

test('every page stays inside the design-language size matrix', () => {
  const sizes: readonly { readonly columns: number; readonly rows: number }[] = [
    { columns: 44, rows: 20 },
    { columns: 80, rows: 10 },
    { columns: 80, rows: 24 },
    { columns: 120, rows: 40 },
    { columns: 200, rows: 50 },
  ]
  const selected = task({ id: 'task-matrix', title: 'Matrix task' })
  const pages: readonly { readonly label: string; readonly snapshot: ScheduleWorkspaceSnapshot }[] = [
    { label: 'list', snapshot: workspace({ rows: FOUR_TASKS, total: FOUR_TASKS.length, selectedId: FOUR_TASKS[0]!.id }) },
    { label: 'detail', snapshot: workspace({ mode: 'detail', detail: selected, rows: [selected], total: 1, selectedId: selected.id }) },
    {
      label: 'history',
      snapshot: workspace({
        mode: 'history',
        rows: [selected],
        total: 1,
        selectedId: selected.id,
        history: {
          status: 'ready',
          records: [{ scheduledAt: '2026-06-01T09:00:00.000Z', deliveredAt: '2026-06-01T09:00:00.100Z', messageId: 'm1' }],
          earlierRecordsUnavailable: false,
          earlierRecordsPruned: false,
        },
      }),
    },
    { label: 'editor', snapshot: workspace({ mode: 'editor', editor: draft() }) },
    {
      label: 'confirm',
      snapshot: workspace({ confirm: { kind: 'clear-ended', token: 12 } }),
    },
  ]
  for (const size of sizes) {
    for (const page of pages) {
      const lines = harness(page.snapshot, size).plain()
      assert.ok(lines.length <= size.rows, `${page.label} ${size.columns}×${size.rows}: too many rows`)
      for (const line of lines) {
        assert.ok(!line.includes('\n'), `${page.label} ${size.columns}×${size.rows}: embedded newline`)
      }
      assert.ok(lines.some(line => /Esc|Confirm \[Y\]|Save/.test(line)),
        `${page.label} ${size.columns}×${size.rows} keeps an actionable Esc/Save hint`)
    }
  }
})

test('the raw Prompt accepts Unicode input and edits at the caret', () => {
  // Empty prompt: a CJK character is text, not a protocol byte.
  const empty = harness(workspace({
    mode: 'editor',
    editor: draft({ focused: 1, prompt: '' }),
  }), { columns: 100, rows: 30 })
  empty.panel.focused = true
  empty.resetDispatches()
  empty.panel.handleInput('检')
  assert.deepEqual(empty.dispatches, [{ kind: 'set-field', fieldId: 'prompt', value: '检' }])
  empty.resetDispatches()
  empty.panel.handleInput('查')
  assert.deepEqual(empty.dispatches, [{ kind: 'set-field', fieldId: 'prompt', value: '检查' }])

  // Existing two-line CJK prompt: Home/Up/End/Left put the caret in the MIDDLE
  // of the first line, and a CJK character is inserted there.
  const stored = '检查服务器状态\n发现异常后汇报'
  const view = harness(workspace({
    mode: 'editor',
    editor: draft({ focused: 1, prompt: stored }),
  }), { columns: 100, rows: 30 })
  view.panel.focused = true
  view.render()
  view.resetDispatches()
  view.panel.handleInput('\x1b[H') // Home: start of the last line
  view.panel.handleInput('\x1b[A') // Up: same column (0) on the previous line
  view.panel.handleInput('\x1b[F') // End: end of the first line
  view.panel.handleInput('\x1b[D') // Left: before the last character
  view.panel.handleInput('中')
  assert.deepEqual(view.dispatches, [{
    kind: 'set-field',
    fieldId: 'prompt',
    value: '检查服务器状中态\n发现异常后汇报',
  }])
  // Backspace removes the caret-previous character; Delete removes the one after.
  view.resetDispatches()
  view.panel.handleInput('\x7f')
  assert.equal((view.dispatches[0] as { value?: string } | undefined)?.value, '检查服务器状态\n发现异常后汇报')
})

test('the action bar keeps <key> <verb> while the body buttons use Verb [Key]', () => {
  const confirm = workspace({ confirm: { kind: 'clear-ended', token: 21 } })
  const lines = harness(confirm, { columns: 120, rows: 30 }).plain()
  const body = lines.find(line => line.includes('Confirm [Y]'))
  assert.ok(body !== undefined && body.includes('Cancel [N]'), 'body buttons use Verb [Key]')
  const bar = lines[lines.length - 1]!
  assert.ok(bar.includes('y confirm'), `action bar uses <key> <verb>: ${JSON.stringify(bar)}`)
  assert.ok(bar.includes('n cancel'), `action bar uses <key> <verb>: ${JSON.stringify(bar)}`)
  assert.ok(bar.trimEnd().endsWith('Esc cancel'), `Esc stays the LAST segment: ${JSON.stringify(bar)}`)
})

test('a long CJK line keeps the caret inside the visible cell budget', () => {
  const prompt = '汉'.repeat(60)
  const view = harness(workspace({
    mode: 'editor',
    editor: draft({ focused: 1, prompt }),
  }), { columns: 80, rows: 24 })
  view.panel.focused = true
  const lines = view.plain()
  const caretLine = lines.find(line => line.includes('▏'))
  assert.ok(caretLine !== undefined, `the caret is painted on a long CJK line:\n${lines.join('\n')}`)
  // The caret is inside the granted width, not truncated away by composeRow().
  assert.ok(visibleWidth(caretLine) <= 80, `the caret row fits 80 cells: ${visibleWidth(caretLine)}`)
  assert.ok(caretLine.indexOf('▏') < 80)
})

test('a 30-line Prompt scrolls so the caret line is visible in both layouts', () => {
  const prompt = Array.from({ length: 30 }, (_, index) => `line ${index + 1} of the prompt`).join('\n')
  for (const size of [{ columns: 80, rows: 24 }, { columns: 120, rows: 40 }]) {
    const view = harness(workspace({
      mode: 'editor',
      editor: draft({ focused: 1, prompt }),
    }), size)
    view.panel.focused = true
    view.render()
    const lines = view.plain()
    const caretLine = lines.find(line => line.includes('▏'))
    assert.ok(caretLine !== undefined,
      `${size.columns}×${size.rows}: the caret row is scrolled into view:\n${lines.join('\n')}`)
    assert.ok(caretLine.includes('line 30'), 'the caret starts at the end of the stored text')
    // Moving up keeps the caret visible as the anchor follows it.
    for (let step = 0; step < 3; step += 1) view.panel.handleInput('\x1b[A')
    view.render()
    const moved = view.plain().find(line => line.includes('▏'))
    assert.ok(moved !== undefined, 'the caret row stays visible after moving up')
  }
})

test('cross-line caret movement preserves the VISUAL cell column in mixed CJK/Latin text', () => {
  const view = harness(workspace({
    mode: 'editor',
    editor: draft({ focused: 1, prompt: '汉字\nabcd' }),
  }), { columns: 100, rows: 30 })
  view.panel.focused = true
  view.render()
  view.panel.handleInput('\x1b[H') // Home: start of the second line
  view.panel.handleInput('\x1b[C') // Right: after 'a'
  view.panel.handleInput('\x1b[C') // Right: after 'b' (cell column 2)
  view.resetDispatches()
  view.panel.handleInput('\x1b[A') // Up: cell column 2 on '汉字' is after '汉', not after both
  view.panel.handleInput('X')
  assert.deepEqual(view.dispatches, [{
    kind: 'set-field',
    fieldId: 'prompt',
    value: '汉X字\nabcd',
  }], 'Up lands after the wide glyph whose cell width is 2, never after 2 code points')

  // Down from the same visual column lands between 'b' and 'c'.
  const down = harness(workspace({
    mode: 'editor',
    editor: draft({ focused: 1, prompt: '汉字\nabcd' }),
  }), { columns: 100, rows: 30 })
  down.panel.focused = true
  down.render()
  down.panel.handleInput('\x1b[H')
  down.panel.handleInput('\x1b[C')
  down.panel.handleInput('\x1b[C')
  down.panel.handleInput('\x1b[A')
  down.panel.handleInput('\x1b[B')
  down.resetDispatches()
  down.panel.handleInput('Y')
  assert.deepEqual(down.dispatches, [{
    kind: 'set-field',
    fieldId: 'prompt',
    value: '汉字\nabYcd',
  }])
})

test('the Detail Status fact shows the word only, without the shared marker (D14.3)', () => {
  const selected = task({ id: 'task-status', title: 'Plain title', status: 'active' })
  const lines = harness(workspace({
    mode: 'detail',
    detail: selected,
    rows: [selected],
    total: 1,
    selectedId: selected.id,
  }), { columns: 80, rows: 30 }).plain()
  const status = lines.find(line => line.includes('Status'))
  assert.ok(status !== undefined && status.includes('Active'), `the Detail Status fact shows the word: ${JSON.stringify(status)}`)
  assert.equal(status.includes('‣'), false, 'the marker belongs to the standalone status group only')
})
