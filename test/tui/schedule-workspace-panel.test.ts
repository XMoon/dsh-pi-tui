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
import {
  SCHEDULE_COPY,
  type ScheduleCatalogEntry,
  type ScheduleIntent,
  type ScheduleWorkspaceSnapshot,
} from '../../src/app/schedule/presentation.ts'
import { editorFields } from '../../src/domain/schedule/form.ts'
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
  readonly timeZone?: string
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
  const statusCounts = { active: 0, paused: 0, ended: 0 }
  for (const row of overrides.rows ?? []) statusCounts[row.status] += 1
  return {
    status: 'ready',
    filter: 'all',
    query: '',
    rows: [],
    total: 0,
    statusCounts,
    mode: 'list',
    sessions: [],
    busy: false,
    pageEpoch: 0,
    ...overrides,
  }
}

function draft(overrides: Partial<ScheduleEditorDraft> = {}): ScheduleEditorDraft {
  return {
    mode: 'create',
    title: '',
    prompt: '',
    timing: { kind: 'after', afterSeconds: '3600', quantityUnit: 'hours' },
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

test('the responsive panel matrix paints width-safe frames and switches layout at 120×30', () => {
  const sizes: readonly FrameSize[] = [
    { columns: 160, rows: 50 },
    { columns: 120, rows: 30 },
    { columns: 100, rows: 30 },
    { columns: 80, rows: 24 },
    { columns: 72, rows: 24 },
    { columns: 60, rows: 12 },
    { columns: 44, rows: 20 },
    { columns: 80, rows: 10 },
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

test('the 60×12 minimum keeps three complete task title and occurrence pairs visible', () => {
  const lines = harness(LIST, { columns: 60, rows: 12 }).plain()
  for (const title of ['Alpha report', 'Bravo digest', 'Charlie review']) {
    const row = lines.findIndex(line => line.includes(title))
    assert.ok(row >= 0, `${title} is visible`)
    assert.match(lines[row + 1] ?? '', /(?:Next|Paused · Scheduled|Ended · Final).*Asia\/Shanghai/u,
      `${title} keeps its matching occurrence on the next physical row`)
  }
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

test('search is local to the panel and Tab exits without changing the filter', () => {
  const view = harness(LIST, { columns: 100, rows: 30 })
  view.panel.handleInput('/')
  assert.deepEqual(view.dispatches, [], 'focusing search is panel-local')
  for (const letter of ['a', 'p', 'e', 'l']) view.panel.handleInput(letter)
  assert.deepEqual(view.dispatches, [
    { kind: 'set-query', query: 'a' },
    { kind: 'set-query', query: 'ap' },
    { kind: 'set-query', query: 'ape' },
    { kind: 'set-query', query: 'apel' },
  ])
  view.resetDispatches()
  view.panel.handleInput('\t')
  assert.deepEqual(view.dispatches, [], 'Tab only exits Search')
  view.panel.handleInput('a')
  assert.deepEqual(view.dispatches, [{ kind: 'set-filter', filter: 'active' }], 'the next list key changes the filter')
  assert.equal(view.closeCount(), 0)

  const reverse = harness(LIST, { columns: 44, rows: 20 })
  reverse.panel.handleInput('/')
  reverse.panel.handleInput('search query')
  reverse.resetDispatches()
  reverse.panel.handleInput('\x1b[Z')
  assert.deepEqual(reverse.dispatches, [], 'Shift+Tab also only exits Search')

  const escape = harness(LIST, { columns: 100, rows: 30 })
  escape.panel.handleInput('/')
  escape.panel.handleInput('\x1b')
  assert.deepEqual(escape.dispatches, [], 'Esc exits Search without closing the workspace')
  assert.equal(escape.closeCount(), 0)
})

test('Tab cycles the same local filters in both directions at every terminal width', () => {
  const sizes: readonly FrameSize[] = [
    { columns: 44, rows: 20 },
    { columns: 60, rows: 12 },
    { columns: 80, rows: 24 },
    { columns: 160, rows: 50 },
  ]
  for (const size of sizes) {
    const view = harness(LIST, size)
    let snapshot = LIST
    for (const filter of ['active', 'paused', 'ended', 'all', 'active'] as const) {
      view.setSnapshot(snapshot)
      view.resetDispatches()
      view.panel.handleInput('\t')
      assert.deepEqual(view.dispatches, [{ kind: 'set-filter', filter }], `${size.columns} columns, forward to ${filter}`)
      snapshot = { ...snapshot, filter }
    }
    for (const filter of ['all', 'ended', 'paused', 'active', 'all'] as const) {
      view.setSnapshot(snapshot)
      view.resetDispatches()
      view.panel.handleInput('\x1b[Z')
      assert.deepEqual(view.dispatches, [{ kind: 'set-filter', filter }], `${size.columns} columns, reverse to ${filter}`)
      snapshot = { ...snapshot, filter }
    }
  }
})

test('filter labels show full-catalog counts and preserve the Tab hint by measured width', () => {
  const narrow = harness(LIST, { columns: 44, rows: 20 }).plain()
  const narrowFilters = narrow[1]!
  for (const label of ['Enabled 2', 'Paused 1', 'Ended 1', '[All 4]']) assert.ok(narrowFilters.includes(label))
  assert.ok(narrowFilters.indexOf('Enabled 2') < narrowFilters.indexOf('Paused 1'))
  assert.ok(narrowFilters.indexOf('Paused 1') < narrowFilters.indexOf('Ended 1'))
  assert.ok(narrowFilters.indexOf('Ended 1') < narrowFilters.indexOf('[All 4]'))
  const narrowBar = narrow.at(-1) ?? ''
  assert.match(narrowBar, /\bTab\b/u, 'the compressed action bar still advertises filter navigation')
  assert.ok(narrowBar.trimEnd().endsWith('Esc close'), 'Esc remains the physical last action')

  const mediumFilters = harness(LIST, { columns: 60, rows: 12 }).plain()[1]!
  assert.ok(mediumFilters.includes('Tab filters'))
  const wideFilters = harness(LIST, { columns: 80, rows: 24 }).plain()[1]!
  assert.ok(wideFilters.includes('Tab/Shift+Tab filters'))

  const loading = harness(workspace({ status: 'loading' }), { columns: 80, rows: 24 }).plain()[1]!
  assert.ok(loading.includes('Enabled —'))
  assert.ok(!loading.includes('Enabled 0'))
  const failed = harness(workspace({ status: 'error' }), { columns: 80, rows: 24 }).plain()
  assert.ok(failed[1]?.includes('Enabled —'))
  assert.ok(failed.some(line => line.includes('Schedule unavailable')))
  const stale = harness(workspace({ status: 'stale', rows: FOUR_TASKS, total: 4 }), { columns: 80, rows: 24 }).plain()
  assert.ok(stale.some(line => line.includes('Enabled 2')))
  assert.ok(stale.some(line => line.includes('Showing the last read catalog')))
})

test('an unknown filter count stays unknown even in a very narrow compact row', () => {
  const view = harness(workspace({ status: 'loading' }), { columns: 20, rows: 8 })
  const row = view.plain()[1]!
  assert.ok(row.includes('[All —]'))
  assert.ok(!row.includes('999+'))
  view.panel.handleInput('\t')
  assert.deepEqual(view.dispatches, [{ kind: 'set-filter', filter: 'active' }])
})

test('an extreme count compacts to 999+ while the next-filter chip remains clickable', () => {
  const huge = workspace({
    total: 1e20,
    statusCounts: { active: 1e20, paused: 0, ended: 0 },
  })
  const view = harness(huge, { columns: 44, rows: 20 })
  const lines = view.plain()
  const row = lines[1]!
  assert.ok(row.includes('[All 999+]'))
  assert.ok(row.includes('Next filter [Tab]'))
  view.click(row.indexOf('Next filter') + 1, 1)
  assert.deepEqual(view.dispatches, [{ kind: 'set-filter', filter: 'active' }])
})

test('detail, history, help and confirmation Tab keys never dispatch a list filter', () => {
  const modes = [
    workspace({ mode: 'detail' }),
    workspace({ mode: 'history' }),
    workspace({ mode: 'help' }),
    workspace({ confirm: { kind: 'clear-ended', token: 2 } }),
  ]
  for (const snapshot of modes) {
    const view = harness(snapshot, { columns: 160, rows: 50 })
    view.panel.handleInput('\t')
    view.panel.handleInput('\x1b[Z')
    assert.deepEqual(view.dispatches, [], `${snapshot.mode} does not switch the list filter`)
  }
  const chooser = harness(workspace({ mode: 'editor', editor: draft({ focused: 2 }) }), { columns: 100, rows: 30 })
  chooser.panel.handleInput('\r')
  chooser.panel.handleInput('\t')
  chooser.panel.handleInput('\x1b[Z')
  assert.deepEqual(chooser.dispatches, [
    { kind: 'next-field', delta: 1 },
    { kind: 'next-field', delta: -1 },
  ], 'the editor chooser closes and moves between logical fields')
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
  const fields = draft({ focused: 5 })
  const view = harness(workspace({ mode: 'editor', editor: fields }), { columns: 100, rows: 30 })
  view.panel.handleInput('\t')
  assert.deepEqual(view.dispatches, [{ kind: 'focus-field', index: 0 }])
  view.resetDispatches()
  const first = harness(workspace({ mode: 'editor', editor: draft({ focused: 0 }) }), { columns: 100, rows: 30 })
  first.panel.handleInput('\x1b[Z')
  assert.deepEqual(first.dispatches, [{ kind: 'focus-field', index: 5 }])
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

test('a task occurrence is a second clickable row with the official time and zone before repeat text', () => {
  const longTitle = task({
    id: 'task-long-title',
    title: '汉'.repeat(40),
    timeZone: 'America/Argentina/ComodRivadavia',
  })
  const view = harness(workspace({ rows: [longTitle], total: 1, selectedId: longTitle.id }), { columns: 60, rows: 12 })
  const lines = view.plain()
  const titleRow = lines.findIndex(line => line.includes('汉'))
  assert.ok(titleRow >= 0)
  assert.ok(lines[titleRow]!.trimEnd().endsWith('…'), 'the title uses the first row before any secondary metadata')
  const occurrence = lines[titleRow + 1]!
  assert.ok(occurrence.includes('Next 2026-06-01 06:00'))
  assert.ok(occurrence.includes('America/Argentina/ComodRivadavia'))
  assert.ok(!occurrence.includes('session-target'), 'the target is not repeated in the task list')
  assert.ok(visibleWidth(lines[titleRow]!) <= 60 && visibleWidth(occurrence) <= 60)
  view.click(4, titleRow + 1)
  assert.deepEqual(view.dispatches, [{ kind: 'open-detail', id: 'task-long-title' }])
})

test('rendering hundreds of rows constructs one date formatter per official zone', () => {
  const rows = Array.from({ length: 500 }, (_, index) => task({
    id: `task-${index}`,
    title: `Task ${index}`,
    timeZone: 'Pacific/Chatham',
  }))
  const descriptor = Object.getOwnPropertyDescriptor(Intl, 'DateTimeFormat')!
  let constructions = 0
  const tracked = new Proxy(descriptor.value as typeof Intl.DateTimeFormat, {
    construct(target, args, newTarget) {
      constructions += 1
      return Reflect.construct(target, args, newTarget)
    },
  })
  Object.defineProperty(Intl, 'DateTimeFormat', { ...descriptor, value: tracked })
  try {
    const view = harness(workspace({ rows, total: rows.length, selectedId: 'task-0' }), { columns: 120, rows: 40 })
    const lines = view.plain()
    assert.ok(lines.some(line => line.includes('Task 0')))
    assert.equal(constructions, 1, 'the list reuses one formatter for all rows in the same official zone')
  } finally {
    Object.defineProperty(Intl, 'DateTimeFormat', descriptor)
  }
})

test('the selected two-line task group stays together when the list scrolls to it', () => {
  const many = Array.from({ length: 20 }, (_, index) => task({
    id: `task-${index}`,
    title: `Task ${index}`,
  }))
  const selected = 'task-12'
  const view = harness(workspace({ rows: many, total: many.length, selectedId: selected }), { columns: 60, rows: 12 })
  const lines = view.plain()
  const titleRow = lines.findIndex(line => line.includes('Task 12'))
  assert.ok(titleRow >= 0)
  assert.ok(lines[titleRow + 1]?.includes('Next 2026-06-01 17:00 Asia/Shanghai'),
    'selection reveal keeps the task occurrence visible beside its title')
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
  const filterRow = lines.findIndex(line => line.includes('Paused 1'))
  assert.ok(filterRow >= 0)
  view.click(lines[filterRow]!.indexOf('Paused 1') + 1, filterRow)
  assert.deepEqual(view.dispatches, [{ kind: 'set-filter', filter: 'paused' }])
})

test('clicking a filter while Search is focused exits Search before dispatching the filter', () => {
  const view = harness(LIST, { columns: 100, rows: 30 })
  let lines = view.plain()
  const searchRow = lines.findIndex(line => line.includes('Search /'))
  assert.ok(searchRow >= 0)
  view.click(2, searchRow)
  lines = view.plain()
  const filterRow = lines.findIndex(line => line.includes('Paused 1'))
  assert.ok(filterRow >= 0)
  view.click(lines[filterRow]!.indexOf('Paused 1') + 1, filterRow)
  assert.deepEqual(view.dispatches, [{ kind: 'set-filter', filter: 'paused' }])
  view.resetDispatches()
  view.panel.handleInput('x')
  assert.deepEqual(view.dispatches, [{ kind: 'ask-clear-ended' }], 'the next key no longer belongs to Search')
})

test('clicking a painted editor field focuses that stable field identity', () => {
  const view = harness(workspace({ mode: 'editor', editor: draft() }), { columns: 100, rows: 30 })
  const lines = view.plain()
  const fieldRow = lines.findIndex(line => line.includes('Title'))
  assert.ok(fieldRow >= 0)
  view.click(30, fieldRow)
  assert.deepEqual(view.dispatches, [{ kind: 'focus-field', index: 0 }])
})

test('list-only chrome and mode-specific titles disappear outside the list root', () => {
  const selected = FOUR_TASKS[0]!
  const pages: readonly [ScheduleWorkspaceSnapshot, string][] = [
    [workspace({ mode: 'detail', detail: selected, rows: [selected], total: 1, selectedId: selected.id }), 'Schedule · Details'],
    [workspace({ mode: 'history' }), 'Schedule · History'],
    [workspace({ mode: 'editor', editor: draft() }), 'Schedule · Editor'],
    [workspace({ mode: 'help' }), 'Schedule · Help'],
    [workspace({ confirm: { kind: 'clear-ended', token: 15 } }), 'Schedule · Confirm'],
  ]
  for (const [snapshot, title] of pages) {
    const lines = harness(snapshot, { columns: 100, rows: 30 }).plain()
    assert.ok(lines[0]?.includes(title), `${snapshot.mode} identity: ${lines[0]}`)
    assert.equal(lines.some(line => line.includes('Search /')), false)
    assert.equal(lines.some(line => line.includes('Enabled 2') || line.includes('[All 4]')), false)
    assert.equal(lines.some(line => line.includes('New [N]')), false)
  }
})

test('Help describes list and search Tab behavior without the retired pane rotation', () => {
  const help = harness(workspace({ mode: 'help' }), { columns: 120, rows: 40 }).plain().join('\n')
  assert.ok(help.includes('Cycle Enabled, Paused, Ended, All filters'))
  assert.ok(help.includes('Return to the task list without changing the filter'))
  assert.ok(help.includes('Filter Enabled / Paused / Ended / All'))
  assert.ok(!help.includes('Rotate focus'))
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

test('editor choice fields open in-panel choosers and dispatch preset or destination IDs', () => {
  const timing = harness(workspace({ mode: 'editor', editor: draft({ focused: 2 }) }), { columns: 100, rows: 30 })
  timing.panel.handleInput('\r')
  const timingLines = timing.plain().join('\n')
  const presetLabels = [
    'Once · after delay',
    'Once · at date/time',
    'Every · minutes',
    'Every · hours',
    'Every · exact seconds (advanced)',
    'Daily',
    'Weekly',
    'Custom · Cron',
    'Custom · RRULE',
  ]
  let previousIndex = -1
  for (const label of presetLabels) {
    const index = timingLines.indexOf(label)
    assert.ok(index > previousIndex, `${label} follows the previous frozen preset`)
    previousIndex = index
  }
  for (let index = 0; index < 5; index += 1) timing.panel.handleInput('\x1b[B')
  timing.panel.handleInput('\r')
  assert.deepEqual(timing.dispatches, [{ kind: 'select-timing-preset', preset: 'daily' }])

  const target = harness(workspace({ mode: 'editor', editor: draft({ focused: 4 }) }), { columns: 100, rows: 30 })
  target.panel.handleInput('\r')
  const targetChoices = target.plain().join('\n')
  const targetLabels = ['Existing conversation', 'Create and reuse conversation', 'New conversation each run']
  const chooserStart = targetChoices.indexOf('Choose destination')
  assert.ok(chooserStart >= 0)
  let previousTarget = chooserStart
  for (const label of targetLabels) {
    const index = targetChoices.indexOf(label, chooserStart)
    assert.ok(index > previousTarget, `${label} follows the previous destination`)
    previousTarget = index
  }
  target.panel.handleInput('\r')
  assert.deepEqual(target.dispatches, [{ kind: 'select-target-kind', target: 'session' }])

  const existing = harness(workspace({ mode: 'editor', editor: draft({
    target: { kind: 'session', sessionId: 'session-a' },
    focused: 5,
  }), sessions: [{ id: 'session-a', title: 'Alpha' }] }), { columns: 100, rows: 30 })
  existing.panel.handleInput('\r')
  existing.panel.handleInput('\r')
  assert.deepEqual(existing.dispatches, [{ kind: 'select-target-session', sessionId: 'session-a' }])
})

test('editor recovery keys dispatch only their admitted intents', () => {
  const conflictSnapshot = workspace({
    mode: 'editor',
    editor: draft({ mode: 'edit', id: 'schedule-1' }),
    editorDirty: true,
    editorRecovery: 'conflict',
  })
  const conflict = harness(conflictSnapshot, { columns: 100, rows: 30 })
  const bar = conflict.plain().at(-1) ?? ''
  assert.ok(bar.includes('Ctrl+G review'))
  assert.ok(bar.includes('Ctrl+R reload'))
  assert.ok(!bar.includes('Ctrl+S save'))
  conflict.panel.handleInput('\x13')
  conflict.panel.handleInput('\x07')
  conflict.panel.handleInput('\x12')
  assert.deepEqual(conflict.dispatches, [
    { kind: 'save' },
    { kind: 'review-with-my-edits' },
    { kind: 'reload-latest' },
  ])

  const cleanEdit = harness(workspace({
    mode: 'editor',
    editor: draft({ mode: 'edit', id: 'schedule-1' }),
    editorDirty: false,
  }), { columns: 100, rows: 30 })
  const cleanEditBar = cleanEdit.plain().at(-1) ?? ''
  assert.ok(!cleanEditBar.includes('Ctrl+S save'))
  assert.ok(cleanEditBar.includes('Ctrl+R reload'))

  const missing = harness({ ...conflictSnapshot, editorRecovery: 'missing' }, { columns: 100, rows: 30 })
  missing.panel.handleInput('\x07')
  missing.panel.handleInput('\x12')
  assert.deepEqual(missing.dispatches, [])

  const unknownCreate = harness(workspace({
    mode: 'editor',
    editor: draft({ title: 'Maybe created', prompt: 'Maybe delivered' }),
    editorRecovery: 'unknown',
    editorDirty: true,
  }), { columns: 100, rows: 30 })
  const unknownCreateBar = unknownCreate.plain().at(-1) ?? ''
  assert.ok(!unknownCreateBar.includes('Ctrl+S save'))
  assert.ok(!unknownCreateBar.includes('Ctrl+G'))
  assert.ok(!unknownCreateBar.includes('Ctrl+R'))
  unknownCreate.panel.handleInput('\x07')
  unknownCreate.panel.handleInput('\x12')
  assert.deepEqual(unknownCreate.dispatches, [], 'an unknown Create has no retry or Edit review path')

  const create = harness(workspace({ mode: 'editor', editor: draft() }), { columns: 100, rows: 30 })
  assert.ok(!create.plain().at(-1)?.includes('Ctrl+R'))
  create.panel.handleInput('\x12')
  assert.deepEqual(create.dispatches, [])
})

test('a narrow Editor keeps focused fields and recovery status inside the painted viewport', () => {
  for (const size of [{ columns: 44, rows: 20 }, { columns: 80, rows: 10 }]) {
    for (const focused of [0, 2, 3, 4, 5]) {
      const snapshot = workspace({
        mode: 'editor',
        editor: draft({ focused }),
        editorRecovery: focused === 2 ? 'conflict' : undefined,
        editorDirty: true,
        notice: focused === 2 ? { text: 'Task changed. Save is blocked.', kind: 'error' } : undefined,
      })
      const lines = harness(snapshot, size).plain()
      assert.ok(lines.length <= size.rows, `${size.columns}×${size.rows} stays inside height`)
      assert.ok(lines.every(line => visibleWidth(line) <= size.columns), `${size.columns} columns stay width-safe`)
      assert.ok(lines[0]?.includes('Schedule · Editor'))
      assert.ok(lines.at(-1)?.includes('Esc back'), `${size.columns}×${size.rows} keeps Esc last`)
      if (focused === 2) assert.ok(lines.some(line => line.includes('Task changed.')))
      const fields = editorFields(snapshot.editor!)
      const label = fields[focused]?.label
      assert.ok(label !== undefined && lines.some(line => line.includes(label.slice(0, 12))),
        `${size.columns}×${size.rows} keeps focused field ${String(label)} reachable`)
    }
  }
})
test('the 44×20 Editor wraps HostMatches and overlapping groups without offering Save', () => {
  const notice = SCHEDULE_COPY.hostMatchesWithOverlap('Title')
  const snapshot = workspace({
    mode: 'editor',
    editor: draft({ mode: 'edit', id: 'schedule-1', title: 'Merged title' }),
    editorDirty: false,
    notice: { text: notice, kind: 'info' },
  })
  const view = harness(snapshot, { columns: 44, rows: 20 })
  const lines = view.plain()
  const visible = lines.slice(0, -1).map(line => line.trim()).join(' ')
  const actionBar = lines.at(-1) ?? ''

  assert.ok(visible.includes(SCHEDULE_COPY.hostMatches), `${visible}`)
  assert.ok(visible.includes('Both changed: Title.'), `${visible}`)
  assert.ok(!actionBar.includes('Ctrl+S save'), actionBar)
  assert.ok(actionBar.includes('Ctrl+R reload'), actionBar)
  assert.ok(actionBar.trimEnd().endsWith('Esc back'), actionBar)
  assert.ok(lines.every(line => visibleWidth(line) <= 44))
})

test('an unbounded Editor notice cannot push the 80×10 action bar out of the frame', () => {
  const view = harness(workspace({
    mode: 'editor',
    editor: draft({ mode: 'edit', id: 'schedule-1', title: 'Local title' }),
    editorDirty: true,
    editorRecovery: 'unknown',
    notice: { text: `Remote failure: ${'details '.repeat(120)}`, kind: 'error' },
  }), { columns: 80, rows: 10 })
  const lines = view.plain()
  assert.equal(lines.length, 10)
  assert.ok(lines.at(-1)?.trimEnd().endsWith('Esc back'), `${lines.join('\n')}`)
  assert.ok(lines.slice(0, -1).some(line => line.trimEnd().endsWith('…')),
    'a longer failure message indicates omitted text instead of consuming the action row')
  assert.ok(lines.every(line => visibleWidth(line) <= 80))
})

test('the weekly editor has one logical field and its chooser keeps toggles across Esc', () => {
  const weekly = draft({
    timing: { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [1] },
    focused: 5,
  })
  const weekday = harness(workspace({ mode: 'editor', editor: weekly }), { columns: 100, rows: 30 })
  assert.equal(weekday.plain().filter(line => /Weekdays/.test(line)).length, 1)
  const fieldRow = weekday.plain().findIndex(line => line.includes('Weekdays'))
  assert.ok(fieldRow >= 0)
  weekday.panel.onCellPress(2, fieldRow)
  weekday.panel.handleInput('\r')
  weekday.panel.onCellClick(2, fieldRow)
  assert.deepEqual(weekday.dispatches, [], 'a pre-chooser field press cannot commit after the chooser takes input')
  const chooser = weekday.plain().join('\n')
  assert.match(chooser, /Space\/Enter toggle/u)
  assert.match(chooser, /Mon \[current\]/u)
  weekday.panel.handleInput(' ')
  weekday.panel.handleInput('\x1b[B')
  weekday.panel.handleInput('\r')
  weekday.panel.handleInput('\x1b')
  weekday.panel.handleInput('\t')
  assert.deepEqual(weekday.dispatches, [
    { kind: 'toggle-weekday', weekday: 1 },
    { kind: 'toggle-weekday', weekday: 2 },
    { kind: 'next-field', delta: 1 },
  ], 'Esc closes without undo; Tab closes and leaves the composite field')

  const advanced = harness(workspace({ mode: 'editor', editor: draft({ focused: 5 }) }), { columns: 100, rows: 30 })
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
  assert.ok(after.some(line => line.includes('Task 3')))
  assert.deepEqual(view.dispatches, [], 'wheel scrolling never dispatches')
})

test('wide list wheel coordinates scroll only the matching pane, while narrow wheel keeps the list owner', () => {
  const many = Array.from({ length: 30 }, (_, index) => task({
    id: `task-${index}`,
    title: `Task ${index}`,
    status: 'active',
    ...(index === 0 ? { prompt: Array.from({ length: 80 }, (_, line) => `Prompt line ${line}`).join('\n') } : {}),
  }))
  const view = harness(workspace({ rows: many, total: many.length, selectedId: 'task-0' }), { columns: 160, rows: 50 })
  const wheel = (x: number, width: number, height: number): void => {
    const result = view.panel.handleMouse({
      type: 'wheel',
      button: 'none',
      x,
      y: 10,
      screenX: x,
      screenY: 10,
      width,
      height,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: 1,
    })
    assert.deepEqual(result, { handled: true, render: true })
  }

  const before = view.plain()
  assert.ok(before.some(line => line.includes('Task 0')))
  assert.ok(before.some(line => line.includes('Details')))
  wheel(120, 160, 50)
  const rightScrolled = view.plain()
  assert.ok(rightScrolled.some(line => line.includes('Task 0')), 'right wheel leaves the list column in place')
  assert.ok(!rightScrolled.some(line => line.includes('Details')), 'right wheel advances the detail preview')

  wheel(1, 160, 50)
  const leftScrolled = view.plain()
  assert.ok(leftScrolled.every(line => !line.slice(0, 63).includes('Task 0')),
    'left wheel advances the list independently of the right Detail preview')
  assert.deepEqual(view.dispatches, [], 'pane scrolling never sends a Controller intent')

  const narrow = harness(workspace({ rows: many, total: many.length, selectedId: 'task-0' }), { columns: 80, rows: 24 })
  narrow.plain()
  narrow.panel.handleMouse({
    type: 'wheel',
    button: 'none',
    x: 70,
    y: 10,
    screenX: 70,
    screenY: 10,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: 1,
  })
  assert.ok(!narrow.plain().some(line => line.includes('Task 0')), 'all narrow-screen wheel positions scroll the list')
  assert.deepEqual(narrow.dispatches, [])
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

test('a modal confirmation owns the screen without list filter or search chrome', () => {
  const view = harness(workspace({
    rows: FOUR_TASKS,
    total: FOUR_TASKS.length,
    selectedId: 'task-alpha',
    confirm: { kind: 'clear-ended', token: 11 },
  }), { columns: 100, rows: 30 })
  const lines = view.plain()
  assert.equal(lines.some(line => line.includes('[Paused 1]')), false)
  assert.equal(lines.some(line => line.includes('Search /')), false)
  view.panel.handleInput('\t')
  assert.deepEqual(view.dispatches, [], 'confirmation input never reaches the list filter')
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
    { columns: 200, rows: 50 },
    { columns: 160, rows: 50 },
    { columns: 120, rows: 40 },
    { columns: 120, rows: 30 },
    { columns: 100, rows: 40 },
    { columns: 100, rows: 30 },
    { columns: 80, rows: 24 },
    { columns: 80, rows: 10 },
    { columns: 72, rows: 24 },
    { columns: 60, rows: 12 },
    { columns: 44, rows: 20 },
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

test('canceling Editor discard confirmation preserves plain and RAW input cursors', () => {
  const plain = harness(workspace({
    mode: 'editor',
    pageEpoch: 1,
    editorEpoch: 7,
    editor: draft({ mode: 'edit', id: 'schedule-1', title: 'A', focused: 0 }),
  }), { columns: 100, rows: 30 })
  plain.panel.focused = true
  plain.render()
  plain.panel.handleInput('X')
  plain.setSnapshot({
    ...plain.snapshot(),
    editor: { ...plain.snapshot().editor!, title: 'AX' },
    editorDirty: true,
  })
  plain.panel.handleInput('\x1b[D')
  plain.setSnapshot({
    ...plain.snapshot(),
    pageEpoch: 2,
    confirm: { kind: 'discard', token: 1 },
  })
  plain.panel.handleInput('n')
  plain.setSnapshot({ ...plain.snapshot(), pageEpoch: 3, confirm: undefined })
  plain.resetDispatches()
  plain.panel.handleInput('Y')
  assert.deepEqual(plain.dispatches, [{ kind: 'set-field', fieldId: 'title', value: 'AYX' }],
    'plain Input keeps its middle caret when the confirmation is canceled')

  const raw = harness(workspace({
    mode: 'editor',
    pageEpoch: 1,
    editorEpoch: 9,
    editor: draft({ mode: 'edit', id: 'schedule-2', prompt: 'Alpha\nBeta', focused: 1 }),
  }), { columns: 100, rows: 30 })
  raw.panel.focused = true
  raw.render()
  raw.panel.handleInput('\x1b[D')
  raw.setSnapshot({
    ...raw.snapshot(),
    pageEpoch: 2,
    editorDirty: true,
    confirm: { kind: 'discard', token: 2 },
  })
  raw.panel.handleInput('n')
  raw.setSnapshot({ ...raw.snapshot(), pageEpoch: 3, confirm: undefined })
  raw.resetDispatches()
  raw.panel.handleInput('X')
  assert.deepEqual(raw.dispatches, [{ kind: 'set-field', fieldId: 'prompt', value: 'Alpha\nBetXa' }],
    'RAW Prompt keeps its code-point caret when the confirmation is canceled')
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
