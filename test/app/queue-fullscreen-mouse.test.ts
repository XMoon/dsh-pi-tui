/**
 * PR-1 — Queue Fullscreen pointer journeys on the REAL mounted path.
 *
 * The composition below is the production one for the Queue surface: a real
 * `TuiApp` owns the fullscreen `TuiAltScreen`, the application attaches the
 * real `QueueManagerController` through `attachQueueManager`, the controller's
 * presentation mounts the real Wide Overlay (`ResponsiveOverlayFrame` +
 * `QueuePanel`), and the app's own `onOpenQueue` entry (the `app.queue.open`
 * action and the Dock's opener) opens it. Only the Host read/write ports are
 * stand-ins (an in-memory `PendingInputReader` and a recording
 * `SessionWriter`).
 *
 * Every pointer step is a REAL SGR press/release/wheel sequence delivered to
 * the mounted VirtualTerminal; the assertion coordinates come from the last
 * painted viewport, so this is the L6 application-composition pointer path,
 * not a direct `QueuePanel.handleMouse` call.
 *
 * @module @xmoon76/dsh-pi-tui/app/queue-fullscreen-mouse.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { TuiApp } from '../../src/tui-app.ts'
import { QueueManagerController } from '../../src/app/queue/manager.ts'
import { queueTextOf } from '../../src/app/surface/pending-presentation.ts'
import type { PendingInputItem, PendingInputReader } from '../../src/runtime/pending-input-reader-port.ts'
import type { SessionWriter } from '../../src/runtime/session-writer-port.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

/** One Host write the fake SessionWriter observed. */
type ObservedWrite =
  | { readonly kind: 'edit'; readonly id: string; readonly content: readonly unknown[] }
  | { readonly kind: 'remove'; readonly id: string }

interface QueueHarness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly controller: QueueManagerController
  readonly writes: ObservedWrite[]
  /** The Host pending projection the reader answers (mutable between events). */
  readonly items: PendingInputItem[]
  /** The live Session owner id the controller captured at open. */
  readonly session: { id: string | undefined }
  /** The real owner-token currency (`isSubjectCurrent`). */
  readonly subjectCurrent: { value: boolean }
  /** Await the controller's owned async tasks (save/delete settlement). */
  readonly drain: () => Promise<void>
  readonly open: () => Promise<void>
  readonly rows: () => string[]
  readonly cell: (needle: string) => { readonly row: number; readonly x: number }
}

function item(id: string, text: string): PendingInputItem {
  return { id, placement: 'queued', content: [{ type: 'text', text }] }
}

async function startQueueHarness(options: {
  readonly columns?: number
  readonly rows?: number
  readonly items: readonly PendingInputItem[]
}): Promise<QueueHarness> {
  const vt = new VirtualTerminal(options.columns ?? 100, options.rows ?? 30)
  const items = [...options.items]
  const writes: ObservedWrite[] = []
  const tasks: Promise<void>[] = []
  const session: { id: string | undefined } = { id: 'session-a' }
  const subjectCurrent = { value: true }
  const subject = {}
  let controller: QueueManagerController | undefined

  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // The production `app.queue.open` entry: bootstrap.ts routes this exact
    // callback into `QueueManagerController.open`, and the Dock entry shares
    // it. No test-side Queue owner is created here.
    onOpenQueue: (initialItemId) => {
      controller?.open(initialItemId === undefined ? {} : { initialItemId })
    },
  })
  const reader: PendingInputReader = {
    snapshot: () => ({ running: true, items }),
  }
  const writer: SessionWriter = {
    prompt: async () => ({ kind: 'committed', value: undefined }),
    updateQueue: async (_sessionId, id, action) => {
      if (action.kind === 'edit') writes.push({ kind: 'edit', id, content: action.content })
      else writes.push({ kind: 'remove', id })
      return { kind: 'committed', value: undefined }
    },
    cancel: async () => ({ kind: 'committed', value: undefined }),
    rename: async () => ({ kind: 'committed', value: { title: 't' } }),
    refreshTitle: async () => ({ kind: 'unsupported', reason: 'none' }),
  }
  controller = new QueueManagerController({
    reader,
    writer,
    captureSessionId: () => session.id,
    captureSubject: () => subject,
    isSubjectCurrent: () => subjectCurrent.value,
    captureScope: () => session.id === undefined ? undefined : ({ sessionId: session.id } as never),
    isScopeCurrent: () => true,
    isViewing: () => false,
    withWriter: async (_scope, task) => task(),
    beginClientWrite: () => () => {},
    runOwned: (_label, task) => { tasks.push(task()) },
    refreshPendingInput: () => {},
    notify: () => {},
    textOf: content => queueTextOf(content as readonly ContentBlock[]),
  })
  app.attachQueueManager(controller)
  app.start()
  startedApps.add(app)
  // The Queue pointer route is fullscreen-only (application mouse reporting is
  // enabled on the alt screen alone). This is the real TuiAltScreen.
  app.setFullscreen(true)
  await vt.waitForRender()

  const rows = (): string[] => vt.getViewport().map(stripTerminalSequences)
  const cell = (needle: string): { readonly row: number; readonly x: number } => {
    const lines = rows()
    for (let row = lines.length - 1; row >= 0; row -= 1) {
      const index = lines[row]!.indexOf(needle)
      if (index >= 0) return { row, x: index }
    }
    throw new Error(`${needle} is not painted:\n${lines.join('\n')}`)
  }
  return {
    vt,
    app,
    controller,
    writes,
    items,
    session,
    subjectCurrent,
    drain: async () => { while (tasks.length > 0) await tasks.shift() },
    open: async () => {
      // Alt+I is the effective `app.queue.open` default: the real action
      // ladder calls the app's one opener above.
      vt.sendInput('\x1bi')
      await vt.waitForRender()
    },
    rows,
    cell,
  }
}

/** SGR press and release (1-based physical cells). */
const press = (vt: VirtualTerminal, at: { row: number; x: number }): void => {
  vt.sendInput(`\x1b[<0;${at.x + 1};${at.row + 1}M`)
}
const release = (vt: VirtualTerminal, at: { row: number; x: number }): void => {
  vt.sendInput(`\x1b[<0;${at.x + 1};${at.row + 1}m`)
}
const wheelDown = (vt: VirtualTerminal, at: { row: number; x: number }): void => {
  vt.sendInput(`\x1b[<65;${at.x + 1};${at.row + 1}M`)
}

test('a real SGR journey edits, saves, deletes and closes the queue without a stale click acting', async () => {
  const h = await startQueueHarness({
    items: [
      item('occ-a', 'first queued message'),
      item('occ-b', 'second queued message'),
    ],
  })
  await h.open()
  assert.ok(h.rows().join('\n').includes('2 queued'), 'the Wide Overlay Browse page is mounted')

  // ── F1: Delete(A) press → wheel to B → release must not open B's confirm.
  const deleteCell = h.cell('Delete [D]')
  const firstRow = h.cell('first queued message')
  press(h.vt, deleteCell)
  await h.vt.waitForRender()
  wheelDown(h.vt, firstRow)
  await h.vt.waitForRender()
  assert.equal(h.controller.view().selectedId, 'occ-b', 'the wheel moved the selection')
  release(h.vt, deleteCell)
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'browse', 'the stale Delete click must not open a confirmation')
  assert.deepEqual(h.writes, [])

  // The freshly painted bar for B is a valid new gesture.
  press(h.vt, h.cell('Delete [D]'))
  release(h.vt, h.cell('Delete [D]'))
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'confirm-delete')
  assert.equal(h.controller.view().selectedId, 'occ-b')
  assert.ok(h.rows().join('\n').includes('This queued message cannot be restored after deletion.'))
  // Cancel returns to Browse without a write.
  press(h.vt, h.cell('Esc cancel'))
  release(h.vt, h.cell('Esc cancel'))
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'browse')
  assert.deepEqual(h.writes, [])

  // ── F4: a real click inside the painted draft positions the cursor; the
  // marker is typed from the keyboard (physical limitation, not a mouse fake).
  press(h.vt, h.cell('Edit ['))
  release(h.vt, h.cell('Edit ['))
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'edit')
  assert.equal(h.controller.view().selectedId, 'occ-b')
  const bodyLine = h.cell('second queued message')
  const target = { row: bodyLine.row, x: bodyLine.x + 7 } // the `q` of `queued`
  press(h.vt, target)
  release(h.vt, target)
  await h.vt.waitForRender()
  h.vt.sendInput('X')
  await h.vt.waitForRender()
  assert.equal(h.controller.view().draft, 'second Xqueued message', 'the click positioned the fork Editor cursor')
  assert.deepEqual(h.writes, [], 'a cursor click never writes the Host')

  // Save is a real pointer gesture; only it reaches the writer.
  press(h.vt, h.cell('Ctrl+S save'))
  release(h.vt, h.cell('Ctrl+S save'))
  await h.drain()
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, [{
    kind: 'edit',
    id: 'occ-b',
    content: [{ type: 'text', text: 'second Xqueued message' }],
  }])
  assert.equal(h.controller.view().mode, 'browse')

  // ── Confirm-delete: the same painted bar confirms exactly one remove.
  press(h.vt, h.cell('Delete [D]'))
  release(h.vt, h.cell('Delete [D]'))
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'confirm-delete')
  press(h.vt, h.cell('Enter confirm'))
  release(h.vt, h.cell('Enter confirm'))
  await h.drain()
  await h.vt.waitForRender()
  assert.deepEqual(h.writes[1], { kind: 'remove', id: 'occ-b' })
  assert.equal(h.controller.view().mode, 'browse')

  // Close is the ordinary Browse Esc path through the painted whole segment.
  press(h.vt, h.cell('Esc close'))
  release(h.vt, h.cell('Esc close'))
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'closed')
  assert.equal(h.rows().join('\n').includes('2 queued'), false, 'the overlay is physically closed')
})

test('a picker row press followed by a wheel cannot activate the old item', async () => {
  const h = await startQueueHarness({
    items: [
      item('occ-a', 'first queued message'),
      item('occ-b', 'second queued message'),
    ],
  })
  await h.open()
  const firstRow = h.cell('first queued message')
  press(h.vt, firstRow)
  await h.vt.waitForRender()
  wheelDown(h.vt, firstRow)
  await h.vt.waitForRender()
  assert.equal(h.controller.view().selectedId, 'occ-b', 'the wheel moved the picker selection')
  release(h.vt, firstRow)
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'browse', 'the stale picker click must not open Edit')
  assert.deepEqual(h.writes, [])

  // A keyboard navigation between press and release is the same gesture
  // boundary: the delegated picker press must be retired as well.
  const keyboardRow = h.cell('first queued message')
  press(h.vt, keyboardRow)
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  assert.equal(h.controller.view().selectedId, 'occ-b')
  release(h.vt, keyboardRow)
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'browse', 'keyboard navigation must retire the picker press')

  // A wheel over the Queue's own action bar never reaches the picker; the
  // Queue owner still retires the delegated item press.
  const chromeRow = h.cell('first queued message')
  press(h.vt, chromeRow)
  await h.vt.waitForRender()
  wheelDown(h.vt, h.cell('Delete [D]'))
  await h.vt.waitForRender()
  release(h.vt, chromeRow)
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'browse', 'a wheel outside the picker rows must retire its press')

  // A geometry round-trip also retires the delegated picker press.
  const resizeRow = h.cell('first queued message')
  press(h.vt, resizeRow)
  await h.vt.waitForRender()
  h.vt.resize(44, 20)
  await h.vt.waitForRender()
  h.vt.resize(100, 30)
  await h.vt.waitForRender()
  release(h.vt, resizeRow)
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'browse', 'a restored geometry must not revive the picker press')

  // A fresh press/release on the old row is a new gesture and activates it.
  press(h.vt, h.cell('first queued message'))
  release(h.vt, h.cell('first queued message'))
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'edit')
  assert.equal(h.controller.view().selectedId, 'occ-a')
  assert.equal(h.controller.view().draft, 'first queued message')
})

test('a resize round-trip refuses the old bar and confirm gestures, including the writer', async () => {
  const h = await startQueueHarness({
    items: [
      item('occ-a', 'first queued message'),
      item('occ-b', 'second queued message'),
    ],
  })
  await h.open()
  assert.equal(h.controller.view().selectedId, 'occ-a')

  // Browse: 100×30 → 44×20 → 100×30, then release the ORIGINAL cell.
  const oldBar = h.cell('Delete [D]')
  press(h.vt, oldBar)
  await h.vt.waitForRender()
  h.vt.resize(44, 20)
  await h.vt.waitForRender()
  h.vt.resize(100, 30)
  await h.vt.waitForRender()
  release(h.vt, oldBar)
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'browse', 'the restored frame must not revive the old bar press')
  assert.deepEqual(h.writes, [])

  // A fresh press on the restored bar still works.
  press(h.vt, h.cell('Delete [D]'))
  release(h.vt, h.cell('Delete [D]'))
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'confirm-delete')
  assert.equal(h.controller.view().selectedId, 'occ-a')

  // Confirm: the same round-trip must not write the old remove.
  const oldConfirm = h.cell('Enter confirm')
  press(h.vt, oldConfirm)
  await h.vt.waitForRender()
  h.vt.resize(44, 20)
  await h.vt.waitForRender()
  h.vt.resize(100, 30)
  await h.vt.waitForRender()
  release(h.vt, oldConfirm)
  await h.drain()
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, [], 'a restored confirm frame must not reach the writer')
  assert.equal(h.controller.view().mode, 'confirm-delete')

  // The same frame identity also has to cover a terminal-only resize: at
  // 120×40 the overlay keeps the same 88-column/28-row content, so the child
  // width/grant alone cannot detect the change.
  const wideConfirm = h.cell('Enter confirm')
  press(h.vt, wideConfirm)
  await h.vt.waitForRender()
  h.vt.resize(120, 40)
  await h.vt.waitForRender()
  h.vt.resize(100, 30)
  await h.vt.waitForRender()
  release(h.vt, wideConfirm)
  await h.drain()
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, [], 'a terminal-only resize must not revive the confirm press')
  assert.equal(h.controller.view().mode, 'confirm-delete')

  // The explicitly fresh confirmation performs exactly one remove.
  press(h.vt, h.cell('Enter confirm'))
  release(h.vt, h.cell('Enter confirm'))
  await h.drain()
  await h.vt.waitForRender()
  assert.deepEqual(h.writes, [{ kind: 'remove', id: 'occ-a' }])
  assert.equal(h.controller.view().mode, 'browse')
})

test('a vanished occurrence and a retired Session owner refuse the old click', async () => {
  const h = await startQueueHarness({
    items: [
      item('occ-a', 'first queued message'),
      item('occ-b', 'second queued message'),
    ],
  })
  await h.open()
  assert.equal(h.controller.view().selectedId, 'occ-a')

  // The pressed occurrence disappears from the Host projection before the
  // click: the authoritative selection moves, and the old target must not
  // become the new first row.
  const bar = h.cell('Delete [D]')
  press(h.vt, bar)
  await h.vt.waitForRender()
  const index = h.items.findIndex(candidate => candidate.id === 'occ-a')
  assert.ok(index >= 0)
  h.items.splice(index, 1)
  release(h.vt, bar)
  await h.vt.waitForRender()
  assert.equal(h.controller.view().selectedId, 'occ-b', 'the vanished occurrence forced a new selection')
  assert.equal(h.controller.view().mode, 'browse', 'the old click must not delete the replacement')
  assert.deepEqual(h.writes, [])

  // Republish the current selection so the next press is a real last-painted
  // gesture for B, then retire the captured Session owner before the release.
  h.controller.select('occ-b')
  await h.vt.waitForRender()
  const retiredBar = h.cell('Delete [D]')
  press(h.vt, retiredBar)
  await h.vt.waitForRender()
  h.session.id = 'session-b'
  release(h.vt, retiredBar)
  await h.vt.waitForRender()
  assert.equal(h.controller.view().mode, 'closed', 'the controller retired with its captured owner')
  assert.deepEqual(h.writes, [])
})
