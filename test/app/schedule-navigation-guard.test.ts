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
  ScheduleEditResult,
  ScheduleDeliveryHistoryRequest,
  ScheduleDeliveryHistoryResult,
  ScheduleEditRequest,

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
  entries = [entry('task-a', 'Task A'), entry('task-b', 'Task B')]
  readonly historyResults = new Map<string, ScheduleDeliveryHistoryResult>()
  historyReads = 0
  private readonly invalidators = new Set<() => void>()
  editResult: ((request: ScheduleEditRequest) => Promise<ScheduleEditResult>) | undefined
  async catalog(): Promise<readonly ScheduleCatalogEntry[]> { return this.entries }
  async list(_request: ScheduleListRequest): Promise<ScheduleListResult> {
    return { items: [...this.entries], shown: this.entries.length, total: this.entries.length, limit: 100, offset: 0 }
  }
  async view(request: ScheduleViewRequest): Promise<ScheduleViewResult> {
    return this.entries.find(candidate => candidate.id === request.id) ?? { id: request.id, code: 'schedule_not_found' }
  }
  async history(request: ScheduleDeliveryHistoryRequest): Promise<ScheduleDeliveryHistoryResult> {
    this.historyReads += 1
    const page = this.historyResults.get(String(request.before ?? 'first'))
    if (page !== undefined) return page
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
  onChanged(listener: () => void): () => void {
    this.invalidators.add(listener)
    return () => { this.invalidators.delete(listener) }
  }

  invalidate(): void {
    for (const listener of this.invalidators) listener()
  }
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

/** One shared real Panel→Controller life for the gesture matrix. */
interface Life {
  readonly controller: ScheduleWorkspaceController
  readonly panel: ScheduleWorkspacePanel
  readonly port: StubPort
  readonly edits: ScheduleEditRequest[]
  settleEdit(value: ScheduleEditResult): void
}

async function gestureLife(): Promise<Life> {
  const port = new StubPort()
  const edits: ScheduleEditRequest[] = []
  port.editResult = async request => {
    edits.push(request)
    return port.entries.find(e => e.id === request.id) as never
  }
  const controller = new ScheduleWorkspaceController({ port, sessionReader, runOwned: (_l, t) => { void t() } })
  const panel = new ScheduleWorkspacePanel({
    snapshot: () => controller.snapshot(),
    dispatch: intent => controller.dispatch(intent),
    requestRender: () => {},
    rows: () => 30,
    columns: () => 120,
    close: () => {},
  })
  controller.open()
  await flush()
  return {
    controller,
    panel,
    port,
    edits,
    settleEdit: value => { port.editResult = () => Promise.resolve(value) },
  }
}

function pointOf(panel: ScheduleWorkspacePanel, needle: string): { readonly column: number; readonly row: number } {
  const lines = plainLines(panel.render(120))
  const row = lines.findIndex(line => line.includes(needle))
  if (row < 0) throw new Error(`no painted row with ${needle}:\n${lines.join('\n')}`)
  return { column: lines[row]!.indexOf(needle) + 2, row }
}

function at(life: Life, needle: string): { readonly column: number; readonly row: number } {
  life.panel.setSnapshot(life.controller.snapshot())
  return pointOf(life.panel, needle)
}

function gesture(life: Life, column: number, row: number, options: { readonly pressOnly?: boolean; readonly releaseOnly?: boolean } = {}): void {
  life.panel.setSnapshot(life.controller.snapshot())
  life.panel.render(120)
  if (options.releaseOnly !== true) life.panel.onCellPress(column, row)
  if (options.pressOnly !== true) life.panel.onCellClick(column, row)
}

function blankAt(life: Life): { readonly column: number; readonly row: number } {
  life.panel.setSnapshot(life.controller.snapshot())
  const lines = plainLines(life.panel.render(120))
  const row = lines.findIndex(line => line.trim() === '')
  if (row < 0) throw new Error('no blank row painted')
  return { column: 3, row }
}



/**
 * ONE table-driven gesture-identity matrix (v2 §4.2 G1/G2/G3/G4): press on a
 * painted identity, mutate the observed world, repaint, release — and assert
 * the FINAL Host-write/navigation outcome. The per-phenomenon duplicates were
 * retired into this table.
 */
test('a gesture commits only on the identity it was pressed on', async () => {
  type Point = { readonly column: number; readonly row: number }
  type Scene = {
    readonly name: string
    readonly setup: (life: Life) => Promise<void>
    readonly press: (life: Life) => Point
    readonly mutate: (life: Life) => Promise<void>
    readonly release: (life: Life) => Point
    readonly assertOutcome: (life: Life) => void | Promise<void>
  }
  const scenes: readonly Scene[] = [
    {
      name: 'G2 cross-task press/release (repainted frame, same action)',
      setup: async life => {
        life.controller.dispatch({ kind: 'open-detail', id: 'task-a' })
        await flush()
      },
      press: life => at(life, 'Space pause/resume'),
      mutate: async life => {
        life.controller.dispatch({ kind: 'open-detail', id: 'task-b' })
        await flush()
      },
      release: life => at(life, 'Space pause/resume'),
      assertOutcome: life => {
        assert.equal(life.edits.length, 0, 'G2: zero Host writes')
        assert.equal(life.controller.snapshot().selectedId, 'task-b')
      },
    },
    {
      name: 'G3 editor Esc press → settled Detail back release (same task, same action)',
      setup: async life => {
        life.controller.dispatch({ kind: 'open-detail', id: 'task-a' })
        await flush()
        life.controller.dispatch({ kind: 'open-edit' })
        await flush()
        life.controller.dispatch({ kind: 'set-field', fieldId: 'title', value: 'Draft' })
      },
      press: life => at(life, 'Esc discard'),
      mutate: async life => {
        life.settleEdit(life.port.entries[0] as never)
        life.controller.dispatch({ kind: 'save' })
        await flush()
        await life.controller.whenIdle()
      },
      release: life => at(life, 'Esc back'),
      assertOutcome: life => {
        assert.equal(life.controller.snapshot().mode, 'detail', 'G3: the Detail page is not closed')
      },
    },
    {
      name: 'G1 pressless release / blank-cell press over a button',
      setup: async life => {
        life.controller.dispatch({ kind: 'open-detail', id: 'task-b' })
        await flush()
      },
      press: life => blankAt(life),
      mutate: async () => {},
      release: life => at(life, 'Space pause/resume'),
      assertOutcome: life => {
        assert.equal(life.edits.length, 0, 'G1: zero Host writes')
      },
    },
    {
      // G6: page-instance ABA — press the editor's Esc, leave via KEYBOARD,
      // reopen the SAME task's editor, release: the closed instance's gesture
      // must not act on the reopen.
      name: 'detail leave → reopen same task (ownership ABA)',
      setup: async life => {
        life.controller.dispatch({ kind: 'open-detail', id: 'task-a' })
        await flush()
      },
      press: life => at(life, 'Space pause/resume'),
      mutate: async life => {
        life.controller.dispatch({ kind: 'back' })
        life.controller.dispatch({ kind: 'open-detail', id: 'task-a' })
        await flush()
      },
      release: life => at(life, 'Space pause/resume'),
      assertOutcome: life => {
        assert.equal(life.edits.length, 0, 'ABA(detail): zero Host writes across the reopen')
      },
    },
    {
      name: 'background schedule/changed with unchanged facts keeps the gesture',
      setup: async life => {
        life.controller.dispatch({ kind: 'open-detail', id: 'task-a' })
        await flush()
      },
      press: life => at(life, 'Space pause/resume'),
      mutate: async life => {
        // A Host notification for ANOTHER task: the controller re-reads the
        // current Detail in place; A's status/revision are unchanged.
        life.port.invalidate()
        await flush()
        life.controller.dispatch({ kind: 'refresh' })
        await flush()
      },
      release: life => at(life, 'Space pause/resume'),
      assertOutcome: life => {
        assert.equal(life.edits.length, 1, 'the unchanged background refresh does NOT kill the gesture')
        assert.equal(life.edits[0]?.id, 'task-a')
      },
    },
    {
      name: 'modal takeover → cancel → stale release',
      setup: async life => {
        life.controller.dispatch({ kind: 'open-detail', id: 'task-a' })
        await flush()
      },
      press: life => at(life, 'Space pause/resume'),
      mutate: async life => {
        life.controller.dispatch({ kind: 'ask-run' })
        life.controller.dispatch({ kind: 'cancel' })
        await flush()
      },
      release: life => at(life, 'Space pause/resume'),
      assertOutcome: life => {
        assert.equal(life.edits.length, 0, 'modal takeover: the pre-modal gesture is dead')
      },
    },
    {
      name: 'G6 editor Esc press → reopen → release (page-instance ABA)',
      setup: async life => {
        life.controller.dispatch({ kind: 'open-detail', id: 'task-a' })
        await flush()
        life.controller.dispatch({ kind: 'open-edit' })
        await flush()
      },
      press: life => at(life, 'Esc discard'),
      mutate: async life => {
        life.controller.dispatch({ kind: 'back' }) // clean draft leaves directly
        life.controller.dispatch({ kind: 'confirm' }) // in case it was dirty
        life.controller.dispatch({ kind: 'open-edit' })
        await flush()
      },
      release: life => at(life, 'Esc discard'),
      assertOutcome: life => {
        assert.equal(life.controller.snapshot().mode, 'editor', 'G6: the reopened editor is not exited by the stale release')
      },
    },
    {
      // G6 (History): press History's Esc back, leave, open ANOTHER task's
      // History, release: the old gesture must not close it.
      name: 'G6 history Esc press → another task history → release',
      setup: async life => {
        life.controller.dispatch({ kind: 'open-detail', id: 'task-a' })
        await flush()
        life.port.historyResults.set('first', {
          id: 'task-a' as never,
          records: [],
          earlierRecordsUnavailable: false,
          earlierRecordsPruned: false,
          retention: { days: 30, records: 200 },
        })
        life.controller.dispatch({ kind: 'open-history' })
        await flush()
      },
      press: life => at(life, 'Esc back'),
      mutate: async life => {
        life.controller.dispatch({ kind: 'back' })
        life.controller.dispatch({ kind: 'open-detail', id: 'task-b' })
        await flush()
        life.controller.dispatch({ kind: 'open-history' })
        await flush()
      },
      release: life => at(life, 'Esc back'),
      assertOutcome: life => {
        assert.equal(life.controller.snapshot().mode, 'history', 'G6: the reopened History is not closed by the stale release')
      },
    },
    {
      name: 'G4 observed Active→Paused change of the same task',
      setup: async life => {
        life.controller.dispatch({ kind: 'open-detail', id: 'task-a' })
        await flush()
      },
      press: life => at(life, 'Space pause/resume'),
      mutate: async life => {
        life.port.entries = life.port.entries.map(e => e.id === 'task-a'
          ? { ...e, status: 'paused' as never, updatedAt: '2026-01-02T00:00:00.000Z' }
          : e)
        life.port.invalidate()
        await flush()
      },
      release: life => at(life, 'Space pause/resume'),
      assertOutcome: life => {
        assert.equal(life.edits.length, 0, 'G4: the pressed pause is not reinterpreted as a resume')
      },
    },
  ]
  for (const scene of scenes) {
    const life = await gestureLife()
    try {
      await scene.setup(life)
      const pressed = scene.press(life)
      gesture(life, pressed.column, pressed.row, { pressOnly: true })
      await scene.mutate(life)
      const released = scene.release(life)
      gesture(life, released.column, released.row, { releaseOnly: true })
      await flush()
      await life.controller.whenIdle()
      await scene.assertOutcome(life)
    } finally {
      life.controller.dispose()
    }
  }
})

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
      const lines = plainLines(panel.render(120))
      const row = lines.findIndex(line => line.includes('Task B'))
      assert.ok(row >= 0, `the wide list paints Task B:\n${lines.join('\n')}`)
      return { lines, row }
    }
    const clickTaskB = (painting: { readonly row: number }): void => {
      panel.onCellPress(3, painting.row)
      panel.onCellClick(3, painting.row)
    }

    // The click reaches the REAL controller through the panel: it must ask to
    // discard, not silently navigate.
    const first = paint()
    clickTaskB(first)
    assert.equal(controller.snapshot().confirm?.kind, 'discard')
    assert.equal(controller.snapshot().mode, 'editor', 'the editor is still the visible page')
    assert.equal(controller.snapshot().editor?.prompt, 'unsaved edit of A', 'the draft is intact')
    assert.equal(controller.snapshot().selectedId, 'task-a', 'the selection did not move behind the question')

    // The SAME coordinates from the PREVIOUS frame are still live (the panel has
    // not painted the confirmation yet): this stale hit must not bypass it.
    panel.setSnapshot(controller.snapshot())
    panel.onCellPress(3, first.row)
    panel.onCellClick(3, first.row)
    assert.equal(controller.snapshot().confirm?.kind, 'discard', 'the same question stays open')
    assert.equal(controller.snapshot().selectedId, 'task-a')

    // Cancel keeps the exact draft; a second click + confirm navigates.
    panel.handleInput('n')
    assert.equal(controller.snapshot().confirm, undefined)
    assert.equal(controller.snapshot().mode, 'editor')
    assert.equal(controller.snapshot().editor?.prompt, 'unsaved edit of A')

    const second = paint()
    clickTaskB(second)
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






test('list Enter and history more are bound to the selection/cursor they were pressed on', async () => {
  // G8: the List Enter action acts on the painted SELECTION; a selection move
  // between press and release must not open the newer selection.
  {
    const life = await gestureLife()
    try {
      await flush()
      const pressed = at(life, 'Enter details')
      gesture(life, pressed.column, pressed.row, { pressOnly: true })
      life.controller.dispatch({ kind: 'move', delta: 1 })
      await flush()
      const released = at(life, 'Enter details')
      const detailBefore = life.controller.snapshot().mode
      gesture(life, released.column, released.row, { releaseOnly: true })
      await flush()
      assert.equal(life.controller.snapshot().selectedId, 'task-b', 'the selection did move to B')
      if (detailBefore === 'list') {
        assert.notEqual(life.controller.snapshot().mode, 'detail',
          'G8: the Enter pressed on A does not open B')
      }
    } finally {
      life.controller.dispose()
    }
  }

  // G9: the History `more` action is bound to the painted CURSOR; a page change
  // between press and release must not page again from the new cursor.
  {
    const life = await gestureLife()
    try {
      life.controller.dispatch({ kind: 'open-detail', id: 'task-a' })
      await flush()
      life.port.historyResults.set('first', {
        id: 'task-a' as never,
        records: [],
        earlierRecordsUnavailable: false,
        earlierRecordsPruned: false,
        retention: { days: 30, records: 200 },
        nextBefore: 'm2' as never,
      })
      life.controller.dispatch({ kind: 'open-history' })
      await flush()
      // Press the painted cursor's `more`, then page with the KEYBOARD so the
      // SECOND page (which still carries a THIRD-page cursor) repaints with a
      // `more` affordance: the stale release path is genuinely exercised.
      const pressedPoint = at(life, 'Enter more')
      gesture(life, pressedPoint.column, pressedPoint.row, { pressOnly: true })
      life.port.historyResults.set('m2', {
        id: 'task-a' as never,
        records: [{ scheduledAt: '2026-01-01T09:00:00.000Z', deliveredAt: '2026-01-01T09:00:00.100Z', messageId: 'm3' as never, targetSessionId: 'session-1' as never }],
        earlierRecordsUnavailable: false,
        earlierRecordsPruned: false,
        retention: { days: 30, records: 200 },
        nextBefore: 'm4' as never,
      })
      life.controller.dispatch({ kind: 'history-more' })
      await flush()
      const readsBefore = life.port.historyReads
      const released = at(life, 'Enter more')
      gesture(life, released.column, released.row, { releaseOnly: true })
      await flush()
      assert.equal(life.port.historyReads, readsBefore,
        'G9: the stale cursor release does not page from the new cursor')
      // A genuine gesture on the CURRENT cursor pages normally.
      gesture(life, released.column, released.row)
      await flush()
      assert.ok(life.port.historyReads > readsBefore, 'a genuine gesture on the current cursor pages')
    } finally {
      life.controller.dispose()
    }
  }
})
