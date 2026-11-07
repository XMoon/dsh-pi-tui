/**
 * A12 — the Schedule workspace through the REAL `TuiApp` alt-screen and the
 * REAL `VirtualTerminal` input/render pipeline (not the panel's `render()`
 * alone).
 *
 * Every page (List/Detail/History/Editor/Confirm) is painted at the product
 * size matrix (44×20, 80×10, 80×24, 120×40, 200×50) from the terminal's own
 * viewport, so the evidence is the frame the terminal really holds: no row
 * wider than the granted columns, no embedded newline, and a reachable action
 * hint on every page. The list-root keys (`Esc`, `n`, `?`) are real
 * `VirtualTerminal` input routed through `TuiApp` into the schedule panel, and
 * the recorded dispatch proves the route.
 *
 * Physical TTY (tmux) remains a separate qualification; this file is the
 * virtual-terminal screen-pipeline evidence only.
 *
 * @module @xmoon76/dsh-pi-tui/schedule-virtual-terminal.test
 */

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import type {
  ScheduleCatalogEntry,
  ScheduleIntent,
  ScheduleWorkspaceSnapshot,
} from '../../src/app/schedule/presentation.ts'
import type { ScheduleEditorDraft } from '../../src/domain/schedule/form.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started, disposeAll } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeAll()
})

interface Size {
  readonly columns: number
  readonly rows: number
}

/** The frozen product size matrix (also the short/narrow extremes). */
const SIZES: readonly Size[] = [
  { columns: 44, rows: 20 },
  { columns: 80, rows: 10 },
  { columns: 80, rows: 24 },
  { columns: 120, rows: 40 },
  { columns: 200, rows: 50 },
]

/** One official-shaped catalog row (the brand is compile-time only). */
function task(overrides: {
  readonly id: string
  readonly title: string
  readonly status?: ScheduleCatalogEntry['status']
  readonly scheduledAt?: string
}): ScheduleCatalogEntry {
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

const TASKS: readonly ScheduleCatalogEntry[] = [
  task({ id: 'task-alpha', title: 'Alpha report', status: 'active' }),
  task({ id: 'task-bravo', title: 'Bravo digest', status: 'active', scheduledAt: '2026-06-01T10:00:00.000Z' }),
  task({ id: 'task-charlie', title: 'Charlie review', status: 'paused', scheduledAt: '2026-06-01T11:00:00.000Z' }),
]

const LIST = workspace({ rows: TASKS, total: TASKS.length, selectedId: 'task-alpha' })

const DETAIL = workspace({
  mode: 'detail',
  detail: TASKS[0],
  rows: [TASKS[0]!],
  total: 1,
  selectedId: TASKS[0]!.id,
})

const HISTORY = workspace({
  mode: 'history',
  rows: [TASKS[0]!],
  total: 1,
  selectedId: TASKS[0]!.id,
  history: {
    status: 'ready',
    records: [
      {
        scheduledAt: '2026-06-01T09:00:00.000Z',
        deliveredAt: '2026-06-01T09:00:01.000Z',
        messageId: 'message-delivered',
        prompt: 'Prepare the morning report.',
      },
    ],
    earlierRecordsUnavailable: false,
    earlierRecordsPruned: false,
    nextBefore: 'message-before',
  },
})

const EDITOR = workspace({ mode: 'editor', rows: [TASKS[0]!], total: 1, editor: draft() })

const CONFIRM = workspace({
  rows: [TASKS[0]!],
  total: 1,
  selectedId: TASKS[0]!.id,
  confirm: {
    kind: 'delete',
    token: 3,
    id: TASKS[0]!.id,
    title: TASKS[0]!.title,
    shortId: 'task-alpha',
    expectedUpdatedAt: null,
  },
})

interface Page {
  readonly name: string
  readonly snapshot: ScheduleWorkspaceSnapshot
  /** Distinct identity of the page that must be painted on the real screen. */
  readonly heading: string
  /** At least ONE of these action hints must reach the real screen. */
  readonly hints: readonly string[]
}

const PAGES: readonly Page[] = [
  { name: 'List', snapshot: LIST, heading: 'Alpha report', hints: ['Esc close', 'Enter details'] },
  { name: 'Detail', snapshot: DETAIL, heading: 'Details', hints: ['Esc back'] },
  { name: 'History', snapshot: HISTORY, heading: 'Delivery history', hints: ['Esc back', 'Enter more'] },
  { name: 'Editor', snapshot: EDITOR, heading: 'Schedule editor', hints: ['save', 'Esc discard'] },
  { name: 'Confirm', snapshot: CONFIRM, heading: 'Confirm', hints: ['Confirm [Y]'] },
]

test('the real TuiApp alt-screen paints List/Detail/History/Editor/Confirm within every product size', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  started.add(app)

  const dispatches: ScheduleIntent[] = []
  let closes = 0
  let current = LIST
  const handle = app.openScheduleWorkspace({
    snapshot: () => current,
    dispatch: intent => { dispatches.push(intent) },
    onClose: () => { closes += 1 },
  })
  await vt.waitForRender()

  for (const size of SIZES) {
    vt.resize(size.columns, size.rows)
    app.requestRender()
    await vt.waitForRender()
    for (const page of PAGES) {
      current = page.snapshot
      handle.update(current)
      await vt.waitForRender()

      const screen = vt.getViewport()
      const tag = `${size.columns}x${size.rows} ${page.name}`
      assert.ok(screen.length <= size.rows, `${tag}: the terminal viewport exceeds the row budget (${screen.length} > ${size.rows})`)
      const plain = screen.map(line => stripTerminalSequences(line))
      for (const [rowIndex, line] of plain.entries()) {
        assert.ok(!/[\r\n]/u.test(line), `${tag}: row ${rowIndex} carries an embedded newline: ${JSON.stringify(line)}`)
        assert.ok(visibleWidth(line) <= size.columns, `${tag}: row ${rowIndex} exceeds the width: ${JSON.stringify(line)}`)
      }
      const painted = plain.join('\n')
      assert.ok(painted.includes(page.heading), `${tag}: the page identity "${page.heading}" was not painted:\n${painted}`)
      assert.ok(page.hints.some(hint => painted.includes(hint)),
        `${tag}: no reachable action hint (${page.hints.join(' / ')}):\n${painted}`)
    }
  }
})

test('the list-root keys are real VirtualTerminal input routed by TuiApp into the schedule panel', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  started.add(app)

  const dispatches: ScheduleIntent[] = []
  let closes = 0
  let current: ScheduleWorkspaceSnapshot = LIST
  const handle = app.openScheduleWorkspace({
    snapshot: () => current,
    dispatch: intent => { dispatches.push(intent) },
    onClose: () => { closes += 1 },
  })
  await vt.waitForRender()

  vt.sendInput('n')
  await vt.waitForRender()
  assert.ok(dispatches.some(intent => intent.kind === 'open-create'),
    `the "n" key must reach the panel as open-create: ${JSON.stringify(dispatches)}`)

  vt.sendInput('?')
  await vt.waitForRender()
  assert.ok(dispatches.some(intent => intent.kind === 'open-help'),
    `the "?" key must reach the panel as open-help: ${JSON.stringify(dispatches)}`)

  assert.equal(closes, 0, 'no key before Esc may close the workspace')

  current = LIST
  handle.update(current)
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(closes, 1, 'the list-root Esc must close the workspace through TuiApp')
})
