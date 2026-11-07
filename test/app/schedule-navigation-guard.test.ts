/**
 * S5-PR4 L6: a real Panel row click into the real Controller while a dirty
 * Editor draft is open.
 *
 * The navigation entry must never discard unsaved work: a click on another
 * task asks to discard first, remembers the target, and only a confirmed `y`
 * moves there; cancel keeps the exact draft. A row hit left over from the
 * previous frame can never bypass an open confirmation.
 *
 * @module @xmoon76/dsh-pi-tui/schedule-navigation-guard.test
 */

import assert from 'node:assert/strict'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import test from 'node:test'
import { ScheduleWorkspaceController } from '../../src/app/schedule/workspace-controller.ts'
import { ScheduleWorkspacePanel } from '../../src/tui/schedule/workspace-panel.ts'
import type {
  ScheduleCatalogEntry,
  ScheduleDeliveryHistoryRequest,
  ScheduleDeliveryHistoryResult,
  ScheduleEditRequest,
  ScheduleEditResult,
  ScheduleListRequest,
  ScheduleListResult,
  SchedulePort,
  ScheduleRunRequest,
  ScheduleRunResult,
  ScheduleViewRequest,
  ScheduleViewResult,
} from '../../src/runtime/schedule-port.ts'
import type { SessionReader } from '../../src/runtime/session-reader-port.ts'

function entry(id: string, title: string): ScheduleCatalogEntry {
  return {
    id: id as never,
    kind: 'daily',
    title,
    prompt: `${title} prompt`,
    time: '09:00:00',
    timeZone: 'UTC',
    scheduledAt: '2026-06-01T09:00:00.000Z',
    target: { kind: 'new_once', sessionId: 'reserved' as never, create: {} },
    involvedSessionIds: [],
    status: 'active',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

class StubPort implements SchedulePort {
  readonly entries = [entry('task-a', 'Task A'), entry('task-b', 'Task B')]
  editResult: ((request: ScheduleEditRequest) => Promise<ScheduleEditResult>) | undefined
  async catalog(): Promise<readonly ScheduleCatalogEntry[]> { return this.entries }
  async list(_request: ScheduleListRequest): Promise<ScheduleListResult> {
    return { items: [...this.entries], shown: this.entries.length, total: this.entries.length, limit: 100, offset: 0 }
  }
  async view(request: ScheduleViewRequest): Promise<ScheduleViewResult> {
    return this.entries.find(candidate => candidate.id === request.id) ?? { id: request.id, code: 'schedule_not_found' }
  }
  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    return { id: request.id, code: 'schedule_not_found' }
  }
  async deliveryLimits(): Promise<{ readonly newSessionIntervalSeconds: number }> {
    return { newSessionIntervalSeconds: 60 }
  }
  async create(): Promise<ScheduleCatalogEntry> { throw new Error('not used') }
  async edit(request: ScheduleEditRequest): Promise<ScheduleEditResult> {
    if (this.editResult === undefined) throw new Error('the fixture never edits')
    return this.editResult(request)
  }
  async run(_request: ScheduleRunRequest): Promise<ScheduleRunResult> { throw new Error('not used') }
  async deleteInactive(): Promise<{ deleted: number }> { return { deleted: 0 } }
  onChanged(): () => void { return () => {} }
}

const sessionReader: SessionReader = {
  list: async () => [],
  projectionBatch: async () => new Map(),
  search: async () => undefined,
  blank: () => undefined,
  measureContext: () => undefined,
  turnOutline: () => undefined,
  sessionStatus: () => undefined,
}


/** ANSI-stripped lines of one painted frame (index math must use plain text). */
const plainLines = (lines: readonly string[]): readonly string[] => lines.map(line => stripTerminalSequences(line))

function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

test('a real panel row click cannot discard a dirty editor without confirmation', async () => {
  const controller = new ScheduleWorkspaceController({
    port: new StubPort(),
    sessionReader,
    runOwned: (_label, task) => { void task() },
  })
  const panel = new ScheduleWorkspacePanel({
    snapshot: () => controller.snapshot(),
    dispatch: intent => controller.dispatch(intent),
    requestRender: () => {},
    rows: () => 40,
    columns: () => 120,
    close: () => {},
  })
  try {
    controller.open()
    await flush()
    controller.dispatch({ kind: 'open-detail', id: 'task-a' })
    await flush()
    controller.dispatch({ kind: 'open-edit' })
    await flush()
    controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'unsaved edit of A' })
    assert.equal(controller.snapshot().mode, 'editor')

    const paint = (): { readonly lines: readonly string[]; readonly row: number } => {
      panel.setSnapshot(controller.snapshot())
      const lines = panel.render(120)
      const row = lines.findIndex(line => line.includes('Task B'))
      assert.ok(row >= 0, `the wide list paints Task B:\n${lines.join('\n')}`)
      return { lines, row }
    }

    // The click reaches the REAL controller through the panel: it must ask to
    // discard, not silently navigate.
    const first = paint()
    panel.onCellClick(3, first.row)
    assert.equal(controller.snapshot().confirm?.kind, 'discard')
    assert.equal(controller.snapshot().mode, 'editor', 'the editor is still the visible page')
    assert.equal(controller.snapshot().editor?.prompt, 'unsaved edit of A', 'the draft is intact')
    assert.equal(controller.snapshot().selectedId, 'task-a', 'the selection did not move behind the question')

    // The SAME coordinates from the PREVIOUS frame are still live (the panel has
    // not painted the confirmation yet): this stale hit must not bypass it.
    panel.setSnapshot(controller.snapshot())
    panel.onCellClick(3, first.row)
    assert.equal(controller.snapshot().confirm?.kind, 'discard', 'the same question stays open')
    assert.equal(controller.snapshot().selectedId, 'task-a')

    // Cancel keeps the exact draft; a second click + confirm navigates.
    panel.handleInput('n')
    assert.equal(controller.snapshot().confirm, undefined)
    assert.equal(controller.snapshot().mode, 'editor')
    assert.equal(controller.snapshot().editor?.prompt, 'unsaved edit of A')

    const second = paint()
    panel.onCellClick(3, second.row)
    assert.equal(controller.snapshot().confirm?.kind, 'discard')
    panel.setSnapshot(controller.snapshot())
    // `y` commits the PAINTED question: paint the confirmation frame first.
    panel.render(120)
    panel.handleInput('y')
    await flush()
    assert.equal(controller.snapshot().mode, 'detail')
    assert.equal(controller.snapshot().selectedId, 'task-b')
    assert.equal(controller.snapshot().editor, undefined)
  } finally {
    controller.dispose()
  }
})

test('a stale list-frame action cannot open a new editor over a dirty draft', async () => {
  const controller = new ScheduleWorkspaceController({
    port: new StubPort(),
    sessionReader,
    runOwned: (_label, task) => { void task() },
  })
  const panel = new ScheduleWorkspacePanel({
    snapshot: () => controller.snapshot(),
    dispatch: intent => controller.dispatch(intent),
    requestRender: () => {},
    rows: () => 40,
    columns: () => 120,
    close: () => {},
  })
  try {
    controller.open()
    await flush()
    // Paint the LIST frame: it carries the clickable New [N] and the rows.
    panel.setSnapshot(controller.snapshot())
    const listLines = panel.render(120)
    const newRow = listLines.findIndex(line => line.includes('New [N]'))
    assert.ok(newRow >= 0, `the list frame paints New [N]:\n${listLines.join('\n')}`)
    const newColumn = listLines[newRow]!.indexOf('New [N]') + 2
    const taskBRow = listLines.findIndex(line => line.includes('Task B'))
    assert.ok(taskBRow >= 0)

    // A real dirty editor is now the current page, but the panel still holds the
    // LIST frame (the next paint has not happened yet).
    controller.dispatch({ kind: 'open-detail', id: 'task-a' })
    await flush()
    controller.dispatch({ kind: 'open-edit' })
    await flush()
    controller.dispatch({ kind: 'set-field', fieldId: 'prompt', value: 'dirty draft' })
    panel.setSnapshot(controller.snapshot())

    panel.onCellClick(newColumn, newRow)
    panel.onCellClick(3, taskBRow)
    assert.equal(controller.snapshot().mode, 'editor', 'stale LIST actions do not leave the dirty editor')
    assert.equal(controller.snapshot().editor?.prompt, 'dirty draft')
    assert.equal(controller.snapshot().confirm, undefined, 'no confirmation was bypassed or invented')
  } finally {
    controller.dispose()
  }
})

test('the panel does not edit its local buffer while a save is pending', async () => {
  const port = new StubPort()
  const controller = new ScheduleWorkspaceController({
    port,
    sessionReader,
    runOwned: (_label, task) => { void task() },
  })
  const panel = new ScheduleWorkspacePanel({
    snapshot: () => controller.snapshot(),
    dispatch: intent => controller.dispatch(intent),
    requestRender: () => {},
    rows: () => 30,
    columns: () => 120,
    close: () => {},
  })
  // The PRODUCTION update chain: controller publish -> panel snapshot -> paint.
  const unsubscribe = controller.subscribe(() => {
    panel.setSnapshot(controller.snapshot())
  })
  try {
    controller.open()
    await flush()
    controller.dispatch({ kind: 'open-detail', id: 'task-a' })
    await flush()
    controller.dispatch({ kind: 'open-edit' })
    await flush()
    // The PRODUCTION update chain: every snapshot change reaches the panel.
    const sync = (): readonly string[] => panel.render(120)
    panel.focused = true
    sync()
    // Type 'Renamed' into Title through the REAL panel input path.
    for (const character of 'Renamed') panel.handleInput(character)
    assert.equal(controller.snapshot().editor?.title, 'Task ARenamed')
    const listFrame = ((): readonly string[] => {
      panel.setSnapshot(controller.snapshot())
      return panel.render(120)
    })()
    let resolveEdit!: (value: ScheduleEditResult) => void
    port.editResult = () => new Promise<ScheduleEditResult>(resolve => { resolveEdit = resolve })
    panel.handleInput('\x13') // Ctrl+S
    sync()
    assert.equal(controller.snapshot().busy, true)
    // The pending write freezes the VISIBLE buffer too: this key must be a no-op
    // on BOTH sides of the production snapshot chain.
    panel.handleInput('x')
    const frozen = sync()
    assert.ok(!frozen.some(line => line.includes('Renamedx')), 'the frozen buffer does not show the rejected key')
    // Neither the mouse row nor Esc may create a stale Discard question while
    // the save is pending.
    const taskBRow = frozen.findIndex(line => line.includes('Task B'))
    assert.ok(taskBRow >= 0, `the WIDE layout paints the left task rows:\n${frozen.join('\n')}`)
    panel.onCellClick(3, taskBRow)
    panel.handleInput('\x1b')
    assert.equal(controller.snapshot().confirm, undefined, 'no stale Discard question while saving')
    assert.equal(controller.snapshot().mode, 'editor')
    // A conflict keeps the controller draft; the next accepted key must append to
    // 'Renamed' only.
    resolveEdit({ id: 'task-a' as never, code: 'schedule_conflict' })
    await flush()
    await controller.whenIdle()
    sync()
    panel.handleInput('y')
    assert.equal(controller.snapshot().editor?.title, 'Task ARenamedy', 'the rejected key is not replayed')
  } finally {
    unsubscribe()
    controller.dispose()
  }
})

test('a stale Detail frame from task A cannot pause task B after a same-mode switch', async () => {
  const controller = new ScheduleWorkspaceController({
    port: new StubPort(),
    sessionReader,
    runOwned: (_label, task) => { void task() },
  })
  const panel = new ScheduleWorkspacePanel({
    snapshot: () => controller.snapshot(),
    dispatch: intent => controller.dispatch(intent),
    requestRender: () => {},
    rows: () => 30,
    columns: () => 120,
    close: () => {},
  })
  const edits: ScheduleEditRequest[] = []
  ;(controller as unknown as { port: StubPort }).port.editResult = async request => {
    edits.push(request)
    return { id: request.id as never, deleted: false } as never
  }
  try {
    controller.open()
    await flush()
    controller.dispatch({ kind: 'open-detail', id: 'task-a' })
    await flush()
    // Paint the Detail frame for task A, including its action-bar Pause hit.
    panel.setSnapshot(controller.snapshot())
    const detailFrame = panel.render(120)
    const toggleRow = detailFrame.findIndex(line => line.includes('Space pause/resume'))
    assert.ok(toggleRow >= 0, `the Detail action bar paints the Pause/Resume hit:\n${detailFrame.join('\n')}`)
    const toggleColumn = detailFrame[toggleRow]!.indexOf('Space pause/resume') + 2

    // Switch to task B and resolve its Detail, but do NOT paint a new frame.
    controller.dispatch({ kind: 'open-detail', id: 'task-b' })
    await flush()
    assert.equal(controller.snapshot().selectedId, 'task-b')
    assert.equal(controller.snapshot().mode, 'detail')
    panel.setSnapshot(controller.snapshot())
    panel.onCellClick(toggleColumn, toggleRow)
    await flush()
    await controller.whenIdle()
    assert.equal(edits.length, 0, 'a click on A’s stale frame performed ZERO Host writes')
    assert.equal(controller.snapshot().selectedId, 'task-b', 'the current selection is unchanged')
  } finally {
    controller.dispose()
  }
})

test('a press on task A and a release on task B\'s newer frame commit nothing', async () => {
  const controller = new ScheduleWorkspaceController({
    port: new StubPort(),
    sessionReader,
    runOwned: (_label, task) => { void task() },
  })
  const panel = new ScheduleWorkspacePanel({
    snapshot: () => controller.snapshot(),
    dispatch: intent => controller.dispatch(intent),
    requestRender: () => {},
    rows: () => 30,
    columns: () => 120,
    close: () => {},
  })
  const edits: ScheduleEditRequest[] = []
  ;(controller as unknown as { port: StubPort }).port.editResult = async request => {
    edits.push(request)
    return { id: request.id as never, deleted: false } as never
  }
  try {
    controller.open()
    await flush()
    controller.dispatch({ kind: 'open-detail', id: 'task-a' })
    await flush()
    panel.setSnapshot(controller.snapshot())
    const frameA = plainLines(panel.render(120))
    const row = frameA.findIndex(line => line.includes('Space pause/resume'))
    assert.ok(row >= 0, `the Detail action bar paints the pause hit:\n${frameA.join('\n')}`)
    const column = frameA[row]!.indexOf('Space pause/resume') + 2

    // PRESS on A's painted frame.
    panel.onCellPress(column, row)
    // The selection moves to B and B's frame is PAINTED before the release.
    controller.dispatch({ kind: 'open-detail', id: 'task-b' })
    await flush()
    panel.setSnapshot(controller.snapshot())
    const frameB = plainLines(panel.render(120))
    assert.ok(frameB.some(line => line.includes('Space pause/resume')), 'B paints the same action')

    // RELEASE at the same coordinates: the same action on a DIFFERENT subject
    // must not commit anything.
    panel.onCellClick(column, row)
    await flush()
    await controller.whenIdle()
    assert.equal(edits.length, 0, 'press(A) + release(B) performs ZERO Host writes')
    assert.equal(controller.snapshot().selectedId, 'task-b')

    // The same-coordinate press+release on ONE task's own CURRENT frame works.
    // (Repaint the CURRENT frame so the release is evaluated against the frame
    // the press froze, exactly like the real terminal does.)
    panel.setSnapshot(controller.snapshot())
    const frameNow = plainLines(panel.render(120))
    const rowNow = frameNow.findIndex(line => line.includes('Space pause/resume'))
    const columnNow = frameNow[rowNow]!.indexOf('Space pause/resume') + 2
    panel.onCellPress(columnNow, rowNow)
    panel.onCellClick(columnNow, rowNow)
    await flush()
    await controller.whenIdle()
    assert.equal(edits.length, 1, 'a press+release on one task own frame commits')
    assert.equal(edits[0]?.id, 'task-b')
  } finally {
    controller.dispose()
  }
})
