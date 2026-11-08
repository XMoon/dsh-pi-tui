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
  { columns: 60, rows: 12 },
  { columns: 72, rows: 24 },
  { columns: 80, rows: 10 },
  { columns: 80, rows: 24 },
  { columns: 100, rows: 40 },
  { columns: 120, rows: 40 },
  { columns: 200, rows: 50 },
]

/** One official-shaped catalog row (the brand is compile-time only). */
function task(overrides: {
  readonly id: string
  readonly title: string
  readonly status?: ScheduleCatalogEntry['status']
  readonly scheduledAt?: string
  readonly prompt?: string
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
    updatedAt: '2026-06-01T08:00:00.000Z',
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
  { name: 'Editor', snapshot: EDITOR, heading: 'Create task', hints: ['save', 'Esc back'] },
  { name: 'Confirm', snapshot: CONFIRM, heading: 'Confirm', hints: ['Confirm [Y]'] },
]

test('real VirtualTerminal keeps guided Editor, RAW RRULE, conflict and Weekdays reachable across sizes', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  started.add(app)
  const dispatches: ScheduleIntent[] = []
  let current = workspace({
    mode: 'editor',
    pageEpoch: 1,
    editor: draft({ focused: 0 }),
  })
  const handle = app.openScheduleWorkspace({
    snapshot: () => current,
    dispatch: intent => { dispatches.push(intent) },
    onClose: () => {},
  })
  try {
    await vt.waitForRender()
    for (const size of SIZES) {
      vt.resize(size.columns, size.rows)
      await vt.waitForRender()

      current = workspace({ mode: 'editor', pageEpoch: 10, editor: draft({ focused: 0 }) })
      handle.update(current)
      await vt.waitForRender()
      let frame = vt.getViewport().map(stripTerminalSequences).join('\n')
      assert.ok(frame.includes('Create task'), `${size.columns}×${size.rows}: Create identity\n${frame}`)
      assert.ok(frame.includes('Delay (hours)'), `${size.columns}×${size.rows}: one-hour default\n${frame}`)
      assert.ok(frame.includes('Destination'), `${size.columns}×${size.rows}: destination field\n${frame}`)

      current = workspace({
        mode: 'editor',
        pageEpoch: 11,
        editor: draft({
          timing: { kind: 'rrule', rrule: 'DTSTART:20261201T090000Z\nRRULE:FREQ=DAILY' },
          focused: 3,
        }),
      })
      handle.update(current)
      await vt.waitForRender()
      frame = vt.getViewport().map(stripTerminalSequences).join('\n')
      assert.ok(frame.includes('RRULE'), `${size.columns}×${size.rows}: custom RAW editor field\n${frame}`)

      current = workspace({
        mode: 'editor',
        pageEpoch: 12,
        editor: draft({ mode: 'edit', id: 'task-a', title: 'Local title' }),
        editorDirty: true,
        editorRecovery: 'conflict',
        notice: { text: 'Host changed. Edits kept; Save is blocked.', kind: 'error' },
      })
      handle.update(current)
      await vt.waitForRender()
      frame = vt.getViewport().map(stripTerminalSequences).join('\n')
      const actionBar = frame.split('\n').at(-1) ?? ''
      assert.ok(frame.includes('Save is blocked'), `${size.columns}×${size.rows}: pinned conflict status\n${frame}`)
      assert.ok(actionBar.includes('Ctrl+G review'), `${size.columns}×${size.rows}: Review remains visible\n${actionBar}`)
      assert.ok(actionBar.includes('Ctrl+R reload'), `${size.columns}×${size.rows}: Reload remains visible\n${actionBar}`)
      assert.ok(actionBar.trimEnd().endsWith('Esc back'), `${size.columns}×${size.rows}: Esc stays last\n${actionBar}`)
      vt.sendInput('\x07')
      await vt.waitForRender()
      assert.equal(dispatches.at(-1)?.kind, 'review-with-my-edits', `${size.columns}×${size.rows}: real Ctrl+G route`)

      current = workspace({
        mode: 'editor',
        pageEpoch: 13,
        editor: draft({
          timing: { kind: 'weekly', time: '09:00:00', timeZone: 'UTC', weekdays: [1, 2, 3, 4, 5] },
          focused: 5,
        }),
      })
      handle.update(current)
      await vt.waitForRender()
      vt.sendInput('\r')
      await vt.waitForRender()
      frame = vt.getViewport().map(stripTerminalSequences).join('\n')
      assert.ok(frame.includes('Space/Enter toggle'), `${size.columns}×${size.rows}: composite chooser action\n${frame}`)
      for (let day = 0; day < 6; day += 1) {
        vt.sendInput('\x1b[B')
        await vt.waitForRender()
      }
      frame = vt.getViewport().map(stripTerminalSequences).join('\n')
      assert.ok(frame.includes('> Sun'), `${size.columns}×${size.rows}: Weekdays chooser scrolls to Sunday\n${frame}`)
      vt.sendInput('\x1b')
      await vt.waitForRender()
    }
  } finally {
    app.dispose()
  }
})

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

import { ScheduleWorkspaceController } from '../../src/app/schedule/workspace-controller.ts'
import type {
  ScheduleCreateRequest,
  ScheduleEditRequest,
  ScheduleEditResult,
  SchedulePort,
} from '../../src/runtime/schedule-port.ts'
import type { SessionReader } from '../../src/runtime/session-reader-port.ts'

/** Minimal recording SchedulePort for the source-to-sink SGR proof. */
function createRecordingPort(
  rows: readonly ScheduleCatalogEntry[] = [
    task({ id: 'task-a', title: 'Alpha report', status: 'active' }),
    task({ id: 'task-b', title: 'Bravo digest', status: 'paused' }),
    task({ id: 'task-c', title: 'Charlie review', status: 'ended' }),
  ],
): SchedulePort & {
  edits: ScheduleEditRequest[]
  creates: ScheduleCreateRequest[]
  editReplies: ScheduleEditResult[]
  views: string[]
  readonly catalogCalls: number
} {
  const edits: ScheduleEditRequest[] = []
  const creates: ScheduleCreateRequest[] = []
  const editReplies: ScheduleEditResult[] = []
  const views: string[] = []
  const state = { catalogCalls: 0, created: undefined as ScheduleCatalogEntry | undefined }
  const listeners = new Set<() => void>()
  return {
    edits,
    creates,
    editReplies,
    views,
    get catalogCalls() { return state.catalogCalls },
    async catalog() {
      state.catalogCalls += 1
      return state.created === undefined ? rows : [...rows, state.created]
    },
    async list() { return { items: [...rows], shown: rows.length, total: rows.length, limit: 100, offset: 0 } },
    async view(request) {
      views.push(String(request.id))
      if (state.created?.id === request.id) return state.created
      return rows.find(row => row.id === request.id) ?? { id: request.id, code: 'schedule_not_found' }
    },
    async history(request) { return { id: request.id, code: 'schedule_not_found' } },
    async deliveryLimits() { return { newSessionIntervalSeconds: 60 } },
    async create(request) {
      creates.push(request)
      state.created = task({ id: 'task-created', title: request.title, prompt: request.prompt })
      return state.created
    },
    async edit(request) {
      edits.push(request)
      const reply = editReplies.shift()
      if (reply !== undefined) return reply
      return rows.find(row => row.id === request.id) ?? { id: request.id, code: 'schedule_not_found' }
    },
    async run() { throw new Error('not used') },
    async deleteInactive() { return { deleted: 0 } },
    onChanged(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  } as SchedulePort & {
    edits: ScheduleEditRequest[]
    creates: ScheduleCreateRequest[]
    editReplies: ScheduleEditResult[]
    views: string[]
    readonly catalogCalls: number
  }
}

function createController(port: SchedulePort, openDetail = true): ScheduleWorkspaceController {
  const sessionReader: SessionReader = {
    list: async () => [],
    projectionBatch: async () => new Map(),
    search: async () => undefined,
    blank: () => undefined,
    measureContext: () => undefined,
    turnOutline: () => undefined,
    sessionStatus: () => undefined,
  }
  const controller = new ScheduleWorkspaceController({ port, sessionReader, runOwned: (_l, t) => { void t() } })
  controller.open()
  if (openDetail) controller.dispatch({ kind: 'open-detail', id: 'task-a' })
  return controller
}

test('real Ctrl+G input reviews a Host conflict before one latest-revision edit', async () => {
  const port = createRecordingPort()
  const controller = createController(port)
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  started.add(app)
  const handle = app.openScheduleWorkspace({
    snapshot: () => controller.snapshot(),
    dispatch: intent => controller.dispatch(intent),
    onClose: () => {},
  })
  const unsubscribe = controller.subscribe(() => handle.update(controller.snapshot()))
  try {
    await vt.waitForRender()
    controller.dispatch({ kind: 'open-edit' })
    await vt.waitForRender()
    controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Local title' })
    port.editReplies.push({ id: 'task-a' as never, code: 'schedule_conflict' })

    const beforeSave = vt.getViewport().map(stripTerminalSequences).join('\n')
    assert.ok(beforeSave.includes('Edit task'))
    vt.sendInput('\x13')
    await controller.whenIdle()
    await vt.waitForRender()
    assert.equal(controller.snapshot().editorRecovery, 'conflict')
    assert.equal(port.edits.length, 1)
    const conflictFrame = vt.getViewport().map(stripTerminalSequences).join('\n')
    assert.ok(conflictFrame.includes('Ctrl+G review'))
    assert.ok(conflictFrame.includes('Save is blocked'))

    const viewsBeforeReview = port.views.length
    vt.sendInput('\x07')
    await vt.waitForRender()
    assert.equal(port.views.length, viewsBeforeReview + 1, 'the real Ctrl+G key performs the official read')
    assert.equal(controller.snapshot().editorRecovery, undefined)
    assert.equal(controller.snapshot().editor?.title, 'Local title')
    assert.equal(port.edits.length, 1, 'Review itself performs no edit')

    vt.sendInput('\x13')
    await controller.whenIdle()
    await vt.waitForRender()
    assert.equal(port.edits.length, 2)
    assert.deepEqual(port.edits[1], {
      id: 'task-a',
      action: 'update',
      patch: { title: 'Local title' },
      expectedUpdatedAt: '2026-06-01T08:00:00.000Z',
    }, 'the explicit Save sends one patch using the reviewed revision')
  } finally {
    unsubscribe()
    app.dispose()
    controller.dispose()
  }
})

test('real VirtualTerminal Weekdays multi-select reaches one Host create', async () => {
  const port = createRecordingPort()
  const controller = createController(port, false)
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  started.add(app)
  const handle = app.openScheduleWorkspace({
    snapshot: () => controller.snapshot(),
    dispatch: intent => controller.dispatch(intent),
    onClose: () => {},
  })
  const unsubscribe = controller.subscribe(() => handle.update(controller.snapshot()))
  const press = async (input: string): Promise<string> => {
    vt.sendInput(input)
    await vt.waitForRender()
    return vt.getViewport().map(stripTerminalSequences).join('\n')
  }
  try {
    await vt.waitForRender()
    await press('n')
    controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Weekly task' })
    controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'Check weekly' })
    await press('\t')
    await press('\t')
    await press('\r')
    for (let index = 0; index < 6; index += 1) await press('\x1b[B')
    await press('\r')
    assert.equal(controller.snapshot().editor?.timing.kind, 'weekly')
    await press('\t')
    await press('\t')
    await press('\t')
    const chooser = await press('\r')
    assert.ok(chooser.includes('Space/Enter toggle'))
    await press('\x1b[B')
    const toggled = await press(' ')
    assert.ok(toggled.includes('Weekdays'))
    await press('\x1b')
    const closed = await press('\t')
    assert.ok(closed.includes('Destination'))
    assert.equal(port.creates.length, 0, 'weekday toggle and chooser navigation do not write')
    await press('\x13')
    await controller.whenIdle()
    await vt.waitForRender()
    assert.equal(port.creates.length, 1)
    assert.deepEqual(port.creates[0]?.timing, {
      kind: 'weekly',
      weekly: { time: '09:00:00', time_zone: 'UTC', weekdays: [1, 3, 4, 5] },
    })
    assert.deepEqual(port.edits, [])
  } finally {
    unsubscribe()
    app.dispose()
    controller.dispose()
  }
})
test('real VirtualTerminal Tab input cycles full-catalog filters through the Controller at every planned width', async () => {
  const port = createRecordingPort()
  const controller = createController(port, false)
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  started.add(app)
  const handle = app.openScheduleWorkspace({
    snapshot: () => controller.snapshot(),
    dispatch: intent => { controller.dispatch(intent) },
    onClose: () => {},
  })
  const unsubscribe = controller.subscribe(() => handle.update(controller.snapshot()))
  try {
    await controller.whenIdle()
    handle.update(controller.snapshot())
    await vt.waitForRender()
    const catalogCalls = port.catalogCalls
    const sizes: readonly Size[] = [
      { columns: 44, rows: 20 },
      { columns: 60, rows: 12 },
      { columns: 80, rows: 24 },
      { columns: 160, rows: 50 },
    ]
    const cases = [
      ['\t', 'active', 'Enabled', 1, 'task-a'],
      ['\t', 'paused', 'Paused', 1, 'task-b'],
      ['\t', 'ended', 'Ended', 1, 'task-c'],
      ['\t', 'all', 'All', 3, 'task-c'],
      ['\x1b[Z', 'ended', 'Ended', 1, 'task-c'],
      ['\x1b[Z', 'paused', 'Paused', 1, 'task-b'],
      ['\x1b[Z', 'active', 'Enabled', 1, 'task-a'],
      ['\x1b[Z', 'all', 'All', 3, 'task-a'],
    ] as const
    for (const size of sizes) {
      vt.resize(size.columns, size.rows)
      await vt.waitForRender()
      for (const [input, filter, label, count, selectedId] of cases) {
        vt.sendInput(input)
        await vt.waitForRender()
        assert.equal(controller.snapshot().filter, filter, `${size.columns} columns`)
        const frame = vt.getViewport().map(stripTerminalSequences).join('\n')
        assert.ok(frame.includes(`[${label} ${count}]`), `${size.columns}×${size.rows} ${filter} count:\n${frame}`)
        assert.equal(controller.snapshot().selectedId, selectedId, 'filter cycling preserves the selected task when it remains visible')
        assert.equal(port.catalogCalls, catalogCalls, 'local filter intents do not reread the Host catalog')
        assert.deepEqual(port.edits, [], 'filter cycling dispatches no Host write')
      }
    }
  } finally {
    unsubscribe()
    app.dispose()
    controller.dispose()
  }
})

test('real SGR wheel input scrolls only the pointed wide-pane through TuiApp', async () => {
  const rows = Array.from({ length: 40 }, (_, index) => task({
    id: `task-${index}`,
    title: `Task ${index}`,
    status: index % 3 === 0 ? 'active' : index % 3 === 1 ? 'paused' : 'ended',
    ...(index === 0 ? { prompt: Array.from({ length: 100 }, (_, line) => `Preview line ${line}`).join('\n') } : {}),
  }))
  const port = createRecordingPort(rows)
  const controller = createController(port, false)
  const vt = new VirtualTerminal(160, 50)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  started.add(app)
  const handle = app.openScheduleWorkspace({
    snapshot: () => controller.snapshot(),
    dispatch: intent => { controller.dispatch(intent) },
    onClose: () => {},
  })
  const unsubscribe = controller.subscribe(() => handle.update(controller.snapshot()))
  try {
    await controller.whenIdle()
    handle.update(controller.snapshot())
    await vt.waitForRender()
    const catalogCalls = port.catalogCalls
    const leftWidth = Math.max(20, Math.floor((vt.columns - 2) * 0.4))
    const frame = (): string[] => vt.getViewport().map(stripTerminalSequences)
    const before = frame()
    assert.ok(before.some(line => line.slice(0, leftWidth).includes('Task 0')))
    assert.ok(before.some(line => line.slice(leftWidth + 2).includes('Details')))
    assert.ok(before.some(line => line.slice(leftWidth + 2).includes('Preview line 0')))

    vt.sendInput(`\x1b[<65;${leftWidth + 2 + 10 + 1};11M`)
    await vt.waitForRender()
    const rightScrolled = frame()
    assert.ok(rightScrolled.some(line => line.slice(0, leftWidth).includes('Task 0')),
      'a right-pane wheel leaves the selected task visible on the left')
    assert.ok(!rightScrolled.some(line => line.slice(leftWidth + 2).includes('Details')),
      'a right-pane wheel advances the read-only Detail preview')

    vt.sendInput('\x1b[<65;6;11M')
    await vt.waitForRender()
    const leftScrolled = frame()
    assert.ok(!leftScrolled.some(line => line.slice(0, leftWidth).includes('Task 0')),
      'a left-pane wheel advances the task catalog')
    assert.ok(!leftScrolled.some(line => line.slice(leftWidth + 2).includes('Details')),
      'left scrolling does not reset the right Detail preview position')
    assert.equal(port.catalogCalls, catalogCalls, 'pane scrolling is panel-local')
    assert.deepEqual(port.edits, [], 'wheel input dispatches no Host write')
  } finally {
    unsubscribe()
    app.dispose()
    controller.dispose()
  }
})

test('a real SGR pointer gesture reaches the Host port through the real Controller', async () => {
  // v2 §4.4 source-to-sink: VirtualTerminal SGR → TuiApp → alt screen → panel
  // admission → REAL ScheduleWorkspaceController → SchedulePort stub. The
  // observed write is the port call, not an intent record.
  const port = createRecordingPort()
  const controller = createController(port)
  const vt = new VirtualTerminal(120, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  started.add(app)
  const handle = app.openScheduleWorkspace({
    snapshot: () => controller.snapshot(),
    dispatch: intent => controller.dispatch(intent),
    onClose: () => {},
  })
  handle.update(controller.snapshot())
  await vt.waitForRender()
  const locate = (needle: string): { readonly row: number; readonly column: number } => {
    const lines = vt.getViewport().map(line => stripTerminalSequences(line))
    const row = lines.findIndex(line => line.includes(needle))
    if (row < 0) throw new Error(`no painted row with ${needle}:\n${lines.join('\n')}`)
    return { row, column: lines[row]!.indexOf(needle) + 2 }
  }
  const press = (point: { readonly row: number; readonly column: number }): void => {
    vt.sendInput(`\x1b[<0;${point.column + 1};${point.row + 1}M`)
  }
  const release = (point: { readonly row: number; readonly column: number }): void => {
    vt.sendInput(`\x1b[<0;${point.column + 1};${point.row + 1}m`)
  }
  const pauseRow = locate('Space pause/resume')
  press(pauseRow)
  await vt.waitForRender()
  release(pauseRow)
  await vt.waitForRender()
  assert.equal(port.edits.length, 1, 'exactly one Host pause write reached the port')
  assert.equal(port.edits[0]?.id, 'task-a')
  app.dispose()
})

test('a real SGR pointer gesture through TuiApp commits, and a cross-subject one is refused', async () => {
  // G0 + G2 through the REAL fork input chain: the VirtualTerminal emits SGR
  // sequences, TuiApp routes them, the alt screen synthesizes press/click and
  // the panel's admission decides. No panel handler is called directly.
  const intents: ScheduleIntent[] = []
  let snapshot = LIST
  const vt = new VirtualTerminal(120, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  started.add(app)
  const handle = app.openScheduleWorkspace({
    snapshot: () => snapshot,
    dispatch: intent => { intents.push(intent) },
    onClose: () => {},
  })
  handle.update(snapshot)
  await vt.waitForRender()
  const locate = (needle: string): { readonly row: number; readonly column: number } => {
    const lines = vt.getViewport().map(line => stripTerminalSequences(line))
    const row = lines.findIndex(line => line.includes(needle))
    if (row < 0) throw new Error(`no painted row with ${needle}:\n${lines.join('\n')}`)
    return { row, column: lines[row]!.indexOf(needle) + 2 }
  }
  const press = (point: { readonly row: number; readonly column: number }): void => {
    vt.sendInput(`\x1b[<0;${point.column + 1};${point.row + 1}M`)
  }
  const release = (point: { readonly row: number; readonly column: number }): void => {
    vt.sendInput(`\x1b[<0;${point.column + 1};${point.row + 1}m`)
  }

  // G0: press + release on the painted New action → exactly one admitted intent.
  const target = locate('n create')
  press(target)
  await vt.waitForRender()
  release(target)
  await vt.waitForRender()
  assert.equal(intents.filter(intent => intent.kind === 'open-create').length, 1,
    'G0: the real SGR press+release commits exactly once')

  // Back to the list, then G2: press on row A, the selection moves to B and the
  // frame repaints before the release → zero navigation writes.
  snapshot = LIST
  handle.update(snapshot)
  await vt.waitForRender()
  const rowA = locate('Next 2026-06-01 17:00 Asia/Shanghai')
  press(rowA)
  snapshot = { ...LIST, selectedId: 'task-bravo' }
  handle.update(snapshot)
  await vt.waitForRender()
  const rowB = locate('Next 2026-06-01 18:00 Asia/Shanghai')
  release(rowB)
  await vt.waitForRender()
  assert.equal(intents.filter(intent => intent.kind === 'open-detail').length, 0,
    'G2: a press on A and a release on B navigates nowhere')

  // A genuine gesture on B's own frame still opens B.
  press(rowB)
  await vt.waitForRender()
  release(rowB)
  await vt.waitForRender()
  assert.equal(intents.filter(intent => intent.kind === 'open-detail').length, 1)
  app.dispose()
})
