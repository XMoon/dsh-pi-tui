/**
 * The PiTui Queue Wide Overlay panel (PR-Q): the ONE body that swaps between
 * Browse, Edit and Confirm-delete, the 88/72/64/terminal width ladder, the
 * fixed action bar and the panel-local keys/pointer intents.
 *
 * These tests drive the REAL panel over the REAL controller with a fake Host
 * projection; they assert what `render()` really returns (row budget, header,
 * action bar, selected attachment detail) and that a key and a pointer reach
 * the same controller intent.
 *
 * @module @xmoon76/dsh-pi-tui/queue-manager-panel.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth, type TUI } from '@xmoon76/pi-tui'
import { QueueManagerController } from '../../src/app/queue/manager.ts'
import { queueTextOf } from '../../src/app/surface/pending-presentation.ts'
import { QueuePanel, queueOverlayGeometry } from '../../src/tui/queue/queue-panel.ts'
import type { PendingInputItem, PendingInputReader } from '../../src/runtime/pending-input-reader-port.ts'
import type { SessionWriter, WriteOutcome } from '../../src/runtime/session-writer-port.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const SCREEN = {
  terminal: { rows: 24, columns: 100 },
  requestRender() {},
} as unknown as TUI

interface Harness {
  readonly controller: QueueManagerController
  readonly panel: QueuePanel
  readonly writes: Array<{ readonly id: string; readonly kind: 'edit' | 'remove'; readonly content?: readonly unknown[] }>
  readonly drain: () => Promise<void>
}

function item(id: string, content: readonly unknown[]): PendingInputItem {
  return { id, placement: 'queued', content }
}

function harness(
  items: readonly PendingInputItem[],
  outcome: WriteOutcome = { kind: 'committed', value: undefined },
  openInitial?: string,
): Harness {
  const writes: Array<{ readonly id: string; readonly kind: 'edit' | 'remove'; readonly content?: readonly unknown[] }> = []
  const tasks: Promise<void>[] = []
  const reader: PendingInputReader = { snapshot: () => ({ running: true, items }) }
  const writer: SessionWriter = {
    prompt: async () => ({ kind: 'committed', value: undefined }),
    updateQueue: async (_sessionId, id, action) => {
      writes.push(action.kind === 'edit'
        ? { id, kind: 'edit', content: action.content }
        : { id, kind: 'remove' })
      return outcome
    },
    cancel: async () => ({ kind: 'committed', value: undefined }),
    rename: async () => ({ kind: 'committed', value: { title: 't' } }),
    refreshTitle: async () => ({ kind: 'unsupported', reason: 'none' }),
  }
  const controller = new QueueManagerController({
    reader,
    writer,
    captureSessionId: () => 'session-a',
    captureSubject: () => ({}),
    isSubjectCurrent: () => true,
    captureScope: () => ({ sessionId: 'session-a' } as never),
    isScopeCurrent: () => true,
    isViewing: () => false,
    withWriter: async (_scope, task) => task(),
    beginClientWrite: () => () => {},
    runOwned: (_label, task) => { tasks.push(task()) },
    refreshPendingInput: () => {},
    notify: () => {},
    textOf: content => queueTextOf(content as readonly ContentBlock[]),
  })
  controller.attach({ present: () => {}, retire: () => {} })
  controller.open(openInitial === undefined ? {} : { initialItemId: openInitial })
  const panel = new QueuePanel({
    controller,
    requestRender: () => {},
    screen: () => SCREEN,
    close: () => { controller.close() },
  })
  panel.setMaxRows(26)
  return {
    controller,
    panel,
    writes,
    drain: async () => { while (tasks.length > 0) await tasks.shift() },
  }
}

/** The painted row's visible text (ANSI stripped), so a test can name a cell. */
function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/gu, '')
}

function mouse(
  y: number,
  x: number,
  width: number,
  type: 'press' | 'release' | 'click' | 'wheel',
  wheelDelta?: number,
): Parameters<QueuePanel['handleMouse']>[0] {
  return {
    type,
    button: type === 'wheel' ? 'none' : 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'wheel' ? { wheelDelta: wheelDelta ?? 1 } : {}),
  }
}

test('the geometry ladder is 88 / 72 / 64 / terminal width with min(rows-2, 28) height', () => {
  assert.deepEqual(queueOverlayGeometry(120, 40), { width: 88, maxHeight: 28, key: '120:40:88:28' })
  assert.equal(queueOverlayGeometry(80, 40).width, 72)
  assert.equal(queueOverlayGeometry(70, 40).width, 64)
  assert.equal(queueOverlayGeometry(50, 40).width, 50)
  assert.equal(queueOverlayGeometry(120, 10).maxHeight, 8)
})

test('browse paints the header, the queued count, one cursor and a whole action bar', () => {
  const h = harness([
    item('occ-1', [{ type: 'text', text: 'check the API compatibility' }]),
    item('occ-2', [{ type: 'text', text: 'run the whole test suite' }]),
  ])
  for (const width of [84, 68, 60, 46]) {
    const lines = h.panel.render(width)
    assert.ok(lines.every(line => visibleWidth(line) <= width), `every row fits ${width} cells:\n${lines.join('\n')}`)
    assert.ok(lines[0]!.includes('Queue'), `the header is the first row at ${width}:\n${lines.join('\n')}`)
    assert.ok(lines[0]!.includes('2 queued'), `the count is right-aligned at ${width}:\n${lines.join('\n')}`)
    const bar = lines[lines.length - 1]!
    // `Esc close` shortens to the whole `Esc` floor when the full bar cannot
    // fit (46 columns); the token itself is never dropped or partially painted.
    assert.ok(bar.includes('Esc'), `Esc is never dropped at ${width}:\n${lines.join('\n')}`)
    assert.ok(bar.includes('Delete [D]'), `Delete is a real action at ${width}:\n${lines.join('\n')}`)
    const cursors = lines.filter(line => line.startsWith('> ') || line.startsWith('❯') || line.trimStart().startsWith('> '))
    assert.equal(cursors.length <= 1, true, `at most one active cursor at ${width}:\n${lines.join('\n')}`)
  }
})

test('semantic Up/Down spellings (CSI, SS3) move the browse selection', () => {
  const h = harness([
    item('occ-a', [{ type: 'text', text: 'first' }]),
    item('occ-b', [{ type: 'text', text: 'second' }]),
  ])
  h.panel.render(84)
  assert.equal(h.controller.view().selectedId, 'occ-a')
  // SS3 Down (application cursor keys) is a real semantic Down.
  h.panel.handleInput('\x1bOB')
  assert.equal(h.controller.view().selectedId, 'occ-b')
  // CSI Up is the other common spelling.
  h.panel.handleInput('\x1b[A')
  assert.equal(h.controller.view().selectedId, 'occ-a')
})

test('a selected attachment item shows its summary and the editing-unavailable reason', () => {
  const h = harness([
    item('occ-file', [
      { type: 'text', text: 'analyze' },
      { type: 'file', attachment: { attachmentId: 'a1', name: 'report.pdf', bytes: 128 * 1024 } },
    ]),
  ])
  const lines = h.panel.render(84)
  const text = lines.join('\n')
  assert.ok(text.includes('report.pdf'), `the attachment summary is visible:\n${text}`)
  assert.ok(text.includes('Contains attachments · Editing unavailable'), `the reason is visible:\n${text}`)
  const bar = lines[lines.length - 1]!
  assert.ok(!bar.includes('Edit [Enter]'), `a file item advertises no Edit action:\n${text}`)
  assert.ok(bar.includes('Delete [D]'), `a file item stays deletable:\n${text}`)
})

test('Enter opens Edit, typing updates the controller draft, Enter inserts a newline and Ctrl+S saves', async () => {
  const h = harness([item('occ-1', [{ type: 'text', text: 'hello' }])])
  h.panel.handleInput('\r')
  assert.equal(h.controller.view().mode, 'edit')
  const editLines = h.panel.render(84)
  assert.ok(editLines[0]!.includes('Edit queued message'), `edit header missing:\n${editLines.join('\n')}`)
  assert.ok(editLines.join('\n').includes('Ctrl+S save'), `save affordance missing:\n${editLines.join('\n')}`)
  h.panel.handleInput('x')
  assert.ok(h.controller.view().draft?.endsWith('x'), 'the typed text reaches the controller draft')
  h.panel.handleInput('\r')
  assert.ok(h.controller.view().draft?.includes('x\n'), 'Enter inserts a newline instead of saving')
  h.panel.handleInput('\x13')
  await h.drain()
  assert.deepEqual(h.writes, [{ id: 'occ-1', kind: 'edit', content: [{ type: 'text', text: 'hellox\n' }] }])
  assert.equal(h.controller.view().mode, 'browse')
})

test('Ctrl+D inside the panel does not trigger the global exit and Esc backs out one level', () => {
  const h = harness([item('occ-1', [{ type: 'text', text: 'hello' }])])
  h.panel.handleInput('\r')
  h.panel.handleInput('\x04')
  assert.equal(h.controller.view().mode, 'edit', 'Ctrl+D is not the composer exit inside the sheet')
  h.panel.handleInput('\x1b')
  assert.equal(h.controller.view().mode, 'browse')
  h.panel.handleInput('\x1b')
  assert.equal(h.controller.view().mode, 'closed')
})

test('the Delete action bar click opens the confirmation and Enter confirms exactly one remove', async () => {
  const h = harness([item('occ-1', [{ type: 'text', text: 'hello' }])])
  const width = 84
  const lines = h.panel.render(width)
  const barIndex = lines.length - 1
  const x = plain(lines[barIndex]!).indexOf('Delete [D]')
  assert.ok(x > 0, `Delete is painted:\n${lines.join('\n')}`)
  h.panel.handleMouse(mouse(barIndex, x, width, 'press'))
  h.panel.handleMouse(mouse(barIndex, x, width, 'release'))
  h.panel.handleMouse(mouse(barIndex, x, width, 'click'))
  assert.equal(h.controller.view().mode, 'confirm-delete')
  const confirmLines = h.panel.render(width)
  assert.ok(confirmLines.join('\n').includes('This queued message cannot be restored after deletion.'),
    `the irreversible warning is visible:\n${confirmLines.join('\n')}`)
  h.panel.handleInput('\r')
  await h.drain()
  assert.deepEqual(h.writes, [{ id: 'occ-1', kind: 'remove' }])
  assert.equal(h.controller.view().mode, 'browse')
})

test('the painted navigation fact is inert: clicking it never closes the panel', () => {
  const h = harness([item('occ-1', [{ type: 'text', text: 'hello' }])])
  const width = 84
  const lines = h.panel.render(width)
  const barIndex = lines.length - 1
  const x = plain(lines[barIndex]!).indexOf('↑↓ navigate')
  assert.ok(x > 0)
  h.panel.handleMouse(mouse(barIndex, x, width, 'press'))
  h.panel.handleMouse(mouse(barIndex, x, width, 'release'))
  h.panel.handleMouse(mouse(barIndex, x, width, 'click'))
  assert.equal(h.controller.view().mode, 'browse')
})

test('a real Enter after a lost Dock preselection never edits the first live row', () => {
  const h = harness([item('occ-live', [{ type: 'text', text: 'still queued' }])], undefined, 'occ-gone')
  const lines = h.panel.render(84)
  assert.ok(lines[0]!.includes('Queue'), 'Browse stays visible')
  assert.equal(h.controller.view().selectedId, undefined)
  // The picker paints NO active cursor row either: the first live occurrence
  // must not look like the current edit/delete target.
  assert.equal(lines.some(line => plain(line).startsWith('> ')), false,
    `no row may paint the active cursor:\n${lines.join('\n')}`)
  h.panel.handleInput('\r')
  assert.equal(h.controller.view().mode, 'browse', 'Enter opened no Edit page')
  assert.equal(h.controller.view().notice?.text, 'Select a queued message')
  assert.deepEqual(h.writes, [])
  // The action-bar Edit segment is absent with no selection.
  const bar = lines[lines.length - 1]!
  assert.ok(!bar.includes('Edit ['), 'no Edit action is advertised for an unselected list')
})

test('a stale-width pointer event never acts on the last painted action bar', () => {
  const h = harness([item('occ-1', [{ type: 'text', text: 'hello' }])])
  const lines = h.panel.render(84)
  const barIndex = lines.length - 1
  assert.equal(h.panel.handleMouse(mouse(barIndex, 0, 100, 'click')), undefined)
  assert.equal(h.controller.view().mode, 'browse')
})

test('short grants keep the header and the action bar, degrading the list first', () => {
  const h = harness([
    item('occ-1', [{ type: 'text', text: 'one' }]),
    item('occ-2', [{ type: 'text', text: 'two' }]),
    item('occ-3', [{ type: 'text', text: 'three' }]),
  ])
  h.panel.setMaxRows(5)
  const lines = h.panel.render(68)
  assert.ok(lines.length <= 5, `the row grant is respected:\n${lines.join('\n')}`)
  assert.ok(lines[0]!.includes('Queue'), `the header survives:\n${lines.join('\n')}`)
  assert.ok(lines[lines.length - 1]!.includes('Esc'), `the action bar survives:\n${lines.join('\n')}`)
})


test('the real press → release → click sequence reaches the action bar exactly once', async () => {
  const h = harness([item('occ-1', [{ type: 'text', text: 'hello' }])])
  const width = 84
  const lines = h.panel.render(width)
  const barIndex = lines.length - 1
  const x = plain(lines[barIndex]!).indexOf('Delete [D]')
  h.panel.handleMouse(mouse(barIndex, x, width, 'press'))
  assert.equal(h.controller.view().mode, 'browse', 'press alone never activates')
  h.panel.handleMouse(mouse(barIndex, x, width, 'release'))
  assert.equal(h.controller.view().mode, 'browse', 'release must not consume the press identity')
  h.panel.handleMouse(mouse(barIndex, x, width, 'click'))
  assert.equal(h.controller.view().mode, 'confirm-delete', 'the synthesized click opens the confirmation')
})

/** The painted row and x of one action-bar segment in the last render. */
function barCells(
  panel: QueuePanel,
  width: number,
  label: string,
): { readonly barIndex: number; readonly x: number; readonly lines: string[] } {
  const lines = panel.render(width)
  const barIndex = lines.length - 1
  const x = plain(lines[barIndex]!).indexOf(label)
  assert.ok(x >= 0, `${label} must be painted:\n${lines.join('\n')}`)
  return { barIndex, x, lines }
}

test('a bar press is retired by an effective wheel before the click, and a fresh press uses the new selection', () => {
  const h = harness([
    item('occ-a', [{ type: 'text', text: 'queued alpha' }]),
    item('occ-b', [{ type: 'text', text: 'queued bravo' }]),
  ])
  const width = 84
  const { barIndex, x, lines } = barCells(h.panel, width, 'Delete [D]')
  const pickerRow = lines.findIndex(line => plain(line).includes('queued alpha'))
  assert.ok(pickerRow >= 0, `the first queued row must be painted:\n${lines.join('\n')}`)
  assert.equal(h.controller.view().selectedId, 'occ-a')

  h.panel.handleMouse(mouse(barIndex, x, width, 'press'))
  // A real item wheel navigates A → B (wrapping to the last row); the wheel
  // event's button is `none`, never `left`.
  h.panel.handleMouse(mouse(pickerRow, 5, width, 'wheel', -1))
  assert.equal(h.controller.view().selectedId, 'occ-b', 'the wheel moved the queue selection')
  h.panel.handleMouse(mouse(barIndex, x, width, 'release'))
  h.panel.handleMouse(mouse(barIndex, x, width, 'click'))
  assert.equal(h.controller.view().mode, 'browse', 'the old bar click must not open B confirmation')
  assert.deepEqual(h.writes, [])

  // The freshly painted bar for the NEW selection is a valid new gesture.
  h.panel.render(width)
  const fresh = barCells(h.panel, width, 'Delete [D]')
  h.panel.handleMouse(mouse(fresh.barIndex, fresh.x, width, 'press'))
  h.panel.handleMouse(mouse(fresh.barIndex, fresh.x, width, 'release'))
  h.panel.handleMouse(mouse(fresh.barIndex, fresh.x, width, 'click'))
  assert.equal(h.controller.view().mode, 'confirm-delete')
  assert.equal(h.controller.view().selectedId, 'occ-b', 'the fresh press targeted the wheel-selected occurrence')
  assert.deepEqual(h.writes, [], 'opening the confirmation is not a Host write')
})

test('keyboard input, another press and a changed selection all retire the old bar click', () => {
  const h = harness([
    item('occ-a', [{ type: 'text', text: 'queued alpha' }]),
    item('occ-b', [{ type: 'text', text: 'queued bravo' }]),
  ])
  const width = 84
  const first = barCells(h.panel, width, 'Delete [D]')
  const pickerRow = first.lines.findIndex(line => plain(line).includes('queued alpha'))

  // Any keyboard input is a fresh gesture boundary.
  h.panel.handleMouse(mouse(first.barIndex, first.x, width, 'press'))
  h.panel.handleInput('\x1b[B')
  h.panel.render(width)
  h.panel.handleMouse(mouse(first.barIndex, first.x, width, 'release'))
  h.panel.handleMouse(mouse(first.barIndex, first.x, width, 'click'))
  assert.equal(h.controller.view().mode, 'browse', 'a keyboard-moved selection must not inherit the old press')

  // Another left press replaces the unfinished gesture (even on a picker row).
  const second = barCells(h.panel, width, 'Delete [D]')
  h.panel.handleMouse(mouse(second.barIndex, second.x, width, 'press'))
  h.panel.handleMouse(mouse(pickerRow >= 0 ? pickerRow : 2, 1, width, 'press'))
  h.panel.render(width)
  h.panel.handleMouse(mouse(second.barIndex, second.x, width, 'release'))
  h.panel.handleMouse(mouse(second.barIndex, second.x, width, 'click'))
  assert.equal(h.controller.view().mode, 'browse', 'a later press must replace the old bar press')

  // A selection changed by the authoritative row click is rejected at click.
  const third = barCells(h.panel, width, 'Delete [D]')
  h.panel.handleMouse(mouse(third.barIndex, third.x, width, 'press'))
  const selectedBefore = h.controller.view().selectedId
  h.controller.select(selectedBefore === 'occ-a' ? 'occ-b' : 'occ-a')
  h.panel.render(width)
  h.panel.handleMouse(mouse(third.barIndex, third.x, width, 'release'))
  h.panel.handleMouse(mouse(third.barIndex, third.x, width, 'click'))
  assert.equal(h.controller.view().mode, 'browse', 'a different selected occurrence must reject the old click')
})

test('the bar click is fenced by the press frame grant and by a stale repaint', () => {
  const h = harness([item('occ-a', [{ type: 'text', text: 'queued alpha' }])])
  const width = 84
  const { barIndex, x } = barCells(h.panel, width, 'Delete [D]')

  // The height grant changed between press and click (a resize/remount).
  h.panel.handleMouse(mouse(barIndex, x, width, 'press'))
  h.panel.handleMouse({ ...mouse(barIndex, x, width, 'click'), height: 31 })
  assert.equal(h.controller.view().mode, 'browse', 'a different frame grant must reject the old press')

  // Width changed before the click: the stale-width guard already rejects, and
  // the captured grant stays authoritative.
  h.panel.handleMouse(mouse(barIndex, x, width, 'press'))
  h.panel.render(60)
  h.panel.handleMouse(mouse(barIndex, x, 60, 'click'))
  assert.equal(h.controller.view().mode, 'browse', 'a stale-width click must not act on the last-painted bar')
})

test('a zero-delta wheel is not a navigation and introduces no side effect on the press', () => {
  const h = harness([
    item('occ-a', [{ type: 'text', text: 'queued alpha' }]),
    item('occ-b', [{ type: 'text', text: 'queued bravo' }]),
  ])
  const width = 84
  const { barIndex, x, lines } = barCells(h.panel, width, 'Delete [D]')
  const pickerRow = lines.findIndex(line => plain(line).includes('queued alpha'))
  h.panel.handleMouse(mouse(barIndex, x, width, 'press'))
  h.panel.handleMouse(mouse(pickerRow, 5, width, 'wheel', 0))
  assert.equal(h.controller.view().selectedId, 'occ-a', 'a zero-delta wheel must not move the selection')
  h.panel.handleMouse(mouse(barIndex, x, width, 'release'))
  h.panel.handleMouse(mouse(barIndex, x, width, 'click'))
  assert.equal(h.controller.view().mode, 'confirm-delete', 'the unchanged press still completes')
})

test('the Edit bar follows the same currentness fence when a wheel changes the target', () => {
  const h = harness([
    item('occ-a', [{ type: 'text', text: 'queued alpha' }]),
    item('occ-b', [{ type: 'text', text: 'queued bravo' }]),
  ])
  const width = 84
  const { barIndex, x, lines } = barCells(h.panel, width, 'Edit [')
  const pickerRow = lines.findIndex(line => plain(line).includes('queued alpha'))
  h.panel.handleMouse(mouse(barIndex, x, width, 'press'))
  h.panel.handleMouse(mouse(pickerRow, 5, width, 'wheel', -1))
  assert.equal(h.controller.view().selectedId, 'occ-b')
  h.panel.handleMouse(mouse(barIndex, x, width, 'release'))
  h.panel.handleMouse(mouse(barIndex, x, width, 'click'))
  assert.equal(h.controller.view().mode, 'browse', 'the old Edit press must not open A/B Edit')
  assert.deepEqual(h.writes, [])

  h.panel.render(width)
  const fresh = barCells(h.panel, width, 'Edit [')
  h.panel.handleMouse(mouse(fresh.barIndex, fresh.x, width, 'press'))
  h.panel.handleMouse(mouse(fresh.barIndex, fresh.x, width, 'release'))
  h.panel.handleMouse(mouse(fresh.barIndex, fresh.x, width, 'click'))
  assert.equal(h.controller.view().mode, 'edit', 'a fresh Edit press opens the wheel-selected occurrence')
  assert.equal(h.controller.view().selectedId, 'occ-b')
  assert.equal(h.controller.view().draft, 'queued bravo')
})

test('narrow action bars publish only complete spans and never a partial token', () => {
  const h = harness([item('occ-1', [{ type: 'text', text: 'hello' }])])
  // 8 columns: only the whole `Esc` segment survives.
  const narrow = h.panel.render(8)
  assert.equal(plain(narrow[narrow.length - 1]!).trim(), 'Esc', `only the whole Esc segment may survive:\n${narrow.join('\n')}`)
  const escX = plain(narrow[narrow.length - 1]!).indexOf('Esc')
  // A cell in the empty tail is not a button.
  h.panel.handleMouse(mouse(narrow.length - 1, 6, 8, 'press'))
  h.panel.handleMouse(mouse(narrow.length - 1, 6, 8, 'release'))
  h.panel.handleMouse(mouse(narrow.length - 1, 6, 8, 'click'))
  assert.equal(h.controller.view().mode, 'browse', 'empty bar cells are inert')
  // The whole Esc is clickable and uses the original keyboard path.
  h.panel.handleMouse(mouse(narrow.length - 1, escX, 8, 'press'))
  h.panel.handleMouse(mouse(narrow.length - 1, escX, 8, 'release'))
  h.panel.handleMouse(mouse(narrow.length - 1, escX, 8, 'click'))
  assert.equal(h.controller.view().mode, 'closed', 'the whole Esc remains clickable')

  // Width 2 cannot paint even `Esc`: the bar is blank and no cell acts.
  const tiny = harness([item('occ-1', [{ type: 'text', text: 'hello' }])])
  const tinyLines = tiny.panel.render(2)
  assert.equal(plain(tinyLines[tinyLines.length - 1]!).trim(), '', 'a bar that cannot hold Esc paints nothing')
  for (const cell of [0, 1]) {
    tiny.panel.handleMouse(mouse(tinyLines.length - 1, cell, 2, 'press'))
    tiny.panel.handleMouse(mouse(tinyLines.length - 1, cell, 2, 'release'))
    tiny.panel.handleMouse(mouse(tinyLines.length - 1, cell, 2, 'click'))
    assert.equal(tiny.controller.view().mode, 'browse', 'no partial Esc cell may activate')
  }
  // Keyboard Esc remains the recovery.
  tiny.panel.handleInput('\x1b')
  assert.equal(tiny.controller.view().mode, 'closed', 'the keyboard Esc route is never degraded')
})

/** Open Edit through the painted bar and return the first Edit frame. */
function openEdit(h: Harness, width = 84): string[] {
  const lines = h.panel.render(width)
  const barIndex = lines.length - 1
  const x = plain(lines[barIndex]!).indexOf('Edit [')
  assert.ok(x >= 0, `the Edit action must be painted:\n${lines.join('\n')}`)
  h.panel.handleMouse(mouse(barIndex, x, width, 'press'))
  h.panel.handleMouse(mouse(barIndex, x, width, 'release'))
  h.panel.handleMouse(mouse(barIndex, x, width, 'click'))
  assert.equal(h.controller.view().mode, 'edit')
  return h.panel.render(width)
}

/** The physical row and column of one painted piece of editor text. */
function editorCell(lines: readonly string[], needle: string, column: number): { readonly row: number; readonly x: number } {
  const row = lines.findIndex(line => plain(line).includes(needle))
  assert.ok(row >= 0, `the editor row ${needle} must be painted:\n${lines.join('\n')}`)
  return { row, x: plain(lines[row]!).indexOf(needle) + column }
}

test('a click on a painted editor line positions the real cursor and typing inserts there exactly', async () => {
  const h = harness([item('occ-1', [{ type: 'text', text: 'abc\ndef' }])])
  const width = 84
  const lines = openEdit(h, width)
  // Click the `b` cell of the FIRST line: the cursor lands before `b`.
  const first = editorCell(lines, 'abc', 1)
  assert.equal(h.panel.handleMouse(mouse(first.row, first.x, width, 'press'))?.handled, true)
  assert.equal(h.panel.handleMouse(mouse(first.row, first.x, width, 'release')), undefined)
  assert.equal(h.panel.handleMouse(mouse(first.row, first.x, width, 'click'))?.handled, true)
  assert.deepEqual(h.writes, [], 'positioning the cursor never writes the Host')
  h.panel.handleInput('X')
  assert.equal(h.controller.view().draft, 'aXbc\ndef', 'typing inserts at the clicked grapheme position')

  // Click the `f` cell of the SECOND line: the cursor lands before `f`.
  h.panel.render(width)
  const second = editorCell(h.panel.render(width), 'def', 2)
  h.panel.handleMouse(mouse(second.row, second.x, width, 'press'))
  h.panel.handleMouse(mouse(second.row, second.x, width, 'release'))
  h.panel.handleMouse(mouse(second.row, second.x, width, 'click'))
  h.panel.handleInput('Y')
  assert.equal(h.controller.view().draft, 'aXbc\ndeYf', 'the second painted line maps to the right logical line')
  assert.deepEqual(h.writes, [], 'only an explicit Save may write')

  // The Save gesture is the original controller intent and writes once.
  const saved = h.panel.render(width)
  const barIndex = saved.length - 1
  const saveX = plain(saved[barIndex]!).indexOf('Ctrl+S save')
  assert.ok(saveX >= 0, `the Save action must be painted:\n${saved.join('\n')}`)
  h.panel.handleMouse(mouse(barIndex, saveX, width, 'press'))
  h.panel.handleMouse(mouse(barIndex, saveX, width, 'release'))
  h.panel.handleMouse(mouse(barIndex, saveX, width, 'click'))
  await h.drain()
  assert.deepEqual(h.writes, [{
    id: 'occ-1',
    kind: 'edit',
    content: [{ type: 'text', text: 'aXbc\ndeYf' }],
  }])
  assert.equal(h.controller.view().mode, 'browse', 'a committed save returns to Browse')
})

test('soft-wrapped, CJK and combining-grapheme lines map through the painted window, never substring counting', () => {
  // An unbroken ASCII token force-breaks at the editor layout width.
  const ascii = harness([item('occ-1', [{ type: 'text', text: 'abcdefghijklmnop' }])])
  ascii.panel.handleInput('\r')
  const asciiLines = ascii.panel.render(10)
  const secondChunk = editorCell(asciiLines, 'jklmnop', 2)
  ascii.panel.handleMouse(mouse(secondChunk.row, secondChunk.x, 10, 'press'))
  ascii.panel.handleMouse(mouse(secondChunk.row, secondChunk.x, 10, 'release'))
  ascii.panel.handleMouse(mouse(secondChunk.row, secondChunk.x, 10, 'click'))
  ascii.panel.handleInput('X')
  assert.equal(ascii.controller.view().draft, 'abcdefghijkXlmnop', 'the wrapped chunk keeps its logical index')

  // CJK wide glyphs: the second painted line is `世界`, and cell 2 lands
  // between `世` and `界` in the SAME logical line.
  const cjk = harness([item('occ-1', [{ type: 'text', text: '你好世界' }])])
  cjk.panel.handleInput('\r')
  const cjkLines = cjk.panel.render(5)
  const cjkSecond = editorCell(cjkLines, '世界', 2)
  cjk.panel.handleMouse(mouse(cjkSecond.row, cjkSecond.x, 5, 'press'))
  cjk.panel.handleMouse(mouse(cjkSecond.row, cjkSecond.x, 5, 'release'))
  cjk.panel.handleMouse(mouse(cjkSecond.row, cjkSecond.x, 5, 'click'))
  cjk.panel.handleInput('X')
  assert.equal(cjk.controller.view().draft, '你好世X界', 'the wide-glyph cell maps to the right grapheme boundary')

  // A combining grapheme is one cursor stop (`a\u0301` is one cell): the `b`
  // cell is visual column 1, never the UTF-16 substring index of `bc`.
  const combining = harness([item('occ-1', [{ type: 'text', text: 'a\u0301bc' }])])
  combining.panel.handleInput('\r')
  const combiningLines = combining.panel.render(84)
  const combiningRow = combiningLines.findIndex(line => plain(line).includes('bc'))
  assert.ok(combiningRow >= 0, `the combining row must be painted:\n${combiningLines.join('\n')}`)
  combining.panel.handleMouse(mouse(combiningRow, 1, 84, 'press'))
  combining.panel.handleMouse(mouse(combiningRow, 1, 84, 'release'))
  combining.panel.handleMouse(mouse(combiningRow, 1, 84, 'click'))
  combining.panel.handleInput('X')
  assert.equal(combining.controller.view().draft, 'a\u0301Xbc', 'the combining sequence stays one grapheme stop')
})

test('only the painted tail of a scrolled editor is clickable; header and blanks never move the cursor', () => {
  const text = Array.from({ length: 10 }, (_, index) => `line${index}`).join('\n')
  const h = harness([item('occ-1', [{ type: 'text', text }])])
  h.panel.setMaxRows(6)
  h.panel.handleInput('\r')
  const width = 84
  const lines = h.panel.render(width)
  assert.equal(h.controller.view().mode, 'edit')
  // The editor keeps its own 7-row window; the queue paints the LAST 2 rows
  // of that window (`line8`, `line9`). The header and the blank rows above are
  // not cursor targets.
  const painted = editorCell(lines, 'line8', 1)
  h.panel.handleMouse(mouse(painted.row, painted.x, width, 'press'))
  h.panel.handleMouse(mouse(painted.row, painted.x, width, 'release'))
  h.panel.handleMouse(mouse(painted.row, painted.x, width, 'click'))
  // A header click and a blank-row click must not move the cursor.
  h.panel.handleMouse(mouse(0, 1, width, 'press'))
  h.panel.handleMouse(mouse(0, 1, width, 'release'))
  h.panel.handleMouse(mouse(0, 1, width, 'click'))
  const blankRow = plain(lines[1]!).trim() === '' ? 1 : 2
  h.panel.handleMouse(mouse(blankRow, 1, width, 'press'))
  h.panel.handleMouse(mouse(blankRow, 1, width, 'release'))
  h.panel.handleMouse(mouse(blankRow, 1, width, 'click'))
  h.panel.handleInput('X')
  const expected = Array.from({ length: 10 }, (_, index) => index === 8 ? 'lXine8' : `line${index}`).join('\n')
  assert.equal(h.controller.view().draft, expected, 'the hidden-window offset is translated through the editor contract')
})

test('pending, a stale grant and Cancel retire the editor click', async () => {
  const h = harness([item('occ-1', [{ type: 'text', text: 'abc\ndef' }])])
  const width = 84
  const lines = openEdit(h, width)
  const row = editorCell(lines, 'abc', 1).row

  // A save in flight refuses a new editor press.
  const saveX = plain(lines[lines.length - 1]!).indexOf('Ctrl+S save')
  h.panel.handleMouse(mouse(lines.length - 1, saveX, width, 'press'))
  h.panel.handleMouse(mouse(lines.length - 1, saveX, width, 'release'))
  h.panel.handleMouse(mouse(lines.length - 1, saveX, width, 'click'))
  assert.equal(h.controller.view().pending, true)
  const draftBefore = h.controller.view().draft
  assert.equal(h.panel.handleMouse(mouse(row, 1, width, 'press')), undefined, 'pending blocks the editor press')
  assert.equal(h.controller.view().draft, draftBefore)
  await h.drain()
  assert.equal(h.controller.view().mode, 'browse')

  // A width change before the click invalidates the captured visual row.
  const reopened = openEdit(h, width)
  const target = editorCell(reopened, 'abc', 1)
  h.panel.handleMouse(mouse(target.row, target.x, width, 'press'))
  h.panel.render(60)
  assert.equal(h.panel.handleMouse(mouse(target.row, target.x, 60, 'click')), undefined, 'a changed grant retires the click')

  // Cancel is a keyboard gesture boundary: the late click is inert. The stale
  // grant click above left the SAME Edit page open, so reuse its fresh paint.
  const cancelled = h.panel.render(width)
  const editRow = editorCell(cancelled, 'abc', 1).row
  h.panel.handleMouse(mouse(editRow, 1, width, 'press'))
  h.panel.handleInput('\x1b')
  assert.equal(h.controller.view().mode, 'browse')
  assert.equal(h.panel.handleMouse(mouse(editRow, 1, width, 'click')), undefined, 'a cancelled Edit page has no cursor target')
})


test('attachment counts name images, files and mixed attachments truthfully', () => {
  const image = harness([item('img', [{ type: 'image', attachment: { attachmentId: 'i1', mediaType: 'image/png', name: 'shot.png' } }])])
  const imageView = image.panel.render(84).join('\n')
  assert.ok(imageView.includes('1 image'), `an image-only row names an image:\n${imageView}`)
  assert.ok(!imageView.includes('1 file'), 'an image-only row never reads as a file')

  const file = harness([item('file', [{ type: 'file', attachment: { attachmentId: 'f1', name: 'report.pdf', bytes: 12 } }])])
  const fileView = file.panel.render(84).join('\n')
  assert.ok(fileView.includes('1 file'), `a file-only row names a file:\n${fileView}`)

  const mixed = harness([item('mixed', [
    { type: 'file', attachment: { attachmentId: 'f2', name: 'a.bin', bytes: 1 } },
    { type: 'image', attachment: { attachmentId: 'i2', mediaType: 'image/png', name: 'b.png' } },
  ])])
  const mixedView = mixed.panel.render(84).join('\n')
  assert.ok(mixedView.includes('2 attachments'), `a mixed row is generic:\n${mixedView}`)
})


test('Host control sequences are removed from list/detail/confirm display, and the raw draft survives untouched', async () => {
  const evilText = 'hello\u001b[2J world\u001b]52;c;ZXZpbA==\u0007'
  const evilFile = 'report\u001b[31m.pdf'
  const h = harness([item('occ-1', [
    { type: 'text', text: evilText },
    { type: 'file', attachment: { attachmentId: 'f1', name: evilFile, bytes: 1 } },
  ])])
  const browse = h.panel.render(84).join('\n')
  assert.equal(browse.includes('\u001b[2J'), false, 'the list never paints a CSI clear')
  assert.equal(browse.includes(']52;'), false, 'the list never paints OSC 52')
  assert.equal(browse.includes('\u001b[31m'), false, 'the attachment name never paints raw SGR')
  h.panel.handleInput('d')
  const confirm = h.panel.render(84).join('\n')
  assert.equal(confirm.includes('\u001b[2J'), false, 'the confirmation never paints the raw text')
  assert.equal(confirm.includes('\u001b[31m'), false, 'the confirmation never paints the raw file name')
  // A separate TEXT-ONLY occurrence for the editor path (a file-bearing row
  // is correctly not editable).
  const editorHarnessed = harness([item('occ-text', [{ type: 'text', text: evilText }])])
  editorHarnessed.panel.handleInput('\r')
  assert.equal(editorHarnessed.controller.view().mode, 'edit')
  const edit = editorHarnessed.panel.render(84).join('\n')
  assert.equal(edit.includes('\u001b[2J'), false, 'the editor never paints the Host CSI clear')
  assert.equal(editorHarnessed.controller.view().draft, evilText, 'the controller keeps the RAW draft')
  // An untouched save writes the ORIGINAL Host bytes, not the display copy.
  editorHarnessed.panel.handleInput('\x13')
  await editorHarnessed.drain()
  assert.equal((editorHarnessed.writes[0] as { content?: Array<{ text: string }> }).content?.[0]?.text, evilText)
})
