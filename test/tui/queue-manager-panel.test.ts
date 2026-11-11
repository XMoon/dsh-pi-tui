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
  readonly writes: Array<{ readonly id: string; readonly kind: 'edit' | 'remove' }>
  readonly drain: () => Promise<void>
}

function item(id: string, content: readonly unknown[]): PendingInputItem {
  return { id, placement: 'queued', content }
}

function harness(items: readonly PendingInputItem[], outcome: WriteOutcome = { kind: 'committed', value: undefined }): Harness {
  const writes: Array<{ readonly id: string; readonly kind: 'edit' | 'remove' }> = []
  const tasks: Promise<void>[] = []
  const reader: PendingInputReader = { snapshot: () => ({ running: true, items }) }
  const writer: SessionWriter = {
    prompt: async () => ({ kind: 'committed', value: undefined }),
    updateQueue: async (_sessionId, id, action) => {
      writes.push({ id, kind: action.kind === 'edit' ? 'edit' : 'remove' })
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
  controller.open()
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

function mouse(y: number, x: number, width: number, type: 'press' | 'click'): Parameters<QueuePanel['handleMouse']>[0] {
  return {
    type,
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
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
    assert.ok(bar.includes('Esc close'), `Esc is never dropped at ${width}:\n${lines.join('\n')}`)
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
  assert.deepEqual(h.writes, [{ id: 'occ-1', kind: 'edit' }])
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
  h.panel.handleMouse(mouse(barIndex, x, width, 'click'))
  assert.equal(h.controller.view().mode, 'browse')
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
