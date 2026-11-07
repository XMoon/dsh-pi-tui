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
  async edit(_request: ScheduleEditRequest): Promise<ScheduleEditResult> { throw new Error('not used') }
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
