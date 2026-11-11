/**
 * The native TSP Queue manager sheet (PR-Q) over the REAL reconciled wire tree.
 *
 * The sheet is driven through the production composition the application uses:
 * `installTspPane({ queueManager: true })` negotiates the kinds the sheet really
 * paints, `mountTspRenderer` mounts the production renderer, `bindQueueManager`
 * installs the application-level `QueueManagerController` and the ONE
 * `QueuePresentation` is attached exactly as the composition root attaches it.
 * Only the tty boundary, the Host pending-input projection and the semantic
 * writer are fakes; every assertion reads the SDK's folded node tree (the
 * picker's own props, the overlay/editor/button nodes and their wire ids), so a
 * renderer-local field can never satisfy them.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-queue-manager.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

import { QueueManagerController } from '../../src/app/queue/manager.ts'
import { queueTextOf } from '../../src/app/surface/pending-presentation.ts'
import type { PendingInputItem, PendingInputReader } from '../../src/runtime/pending-input-reader-port.ts'
import type { SessionWriter } from '../../src/runtime/session-writer-port.ts'
import type { TspRenderer } from '../../src/tui/tsp/session.ts'
import { mountTspRenderer } from '../../src/tui/tsp/session.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'
import {
  clickNodeById,
  layerNodes,
  pickerActionByBase,
  pickerNode,
  pickerProps,
  sendAction,
  sendActivate,
  sendSelect,
  wireNodes,
  type WireNode,
} from '../support/tsp-picker-wire.ts'

/**
 * The queue sheet's root IS the base surface's `layer` region: the presenter
 * returns the picker/overlay node itself (its `key` carries the panel serial),
 * so the wire id of the sheet root is `layer` and its children are `layer.*`.
 * Reading that region therefore addresses exactly the mounted sheet.
 */
const SHEET = 'layer'

/** The wire nodes of the mounted queue sheet, in node order. */
function sheetNodes(pane: TspPane): WireNode[] {
  return layerNodes(pane, SHEET)
}

/** The mounted Browse picker, or undefined while another page/closed. */
function sheetPicker(pane: TspPane): WireNode | undefined {
  return pickerNode(pane, SHEET)
}

/** The Browse picker's props (`{}` while no picker is mounted). */
function sheetProps(pane: TspPane): Record<string, unknown> {
  return pickerProps(pane, SHEET)
}

/** The Browse picker's OWN item ids, in wire order. */
function itemIds(pane: TspPane): string[] {
  return ((sheetProps(pane).items ?? []) as Array<Record<string, unknown>>)
    .map(item => String(item.id))
}

/** One action-bar entry by the BASE id it really does (its id carries a frame token). */
function sheetAction(pane: TspPane, base: string): Record<string, unknown> | undefined {
  return pickerActionByBase(pane, base, SHEET)
}

/** The action BASES the wire carries, i.e. what each entry really does. */
function actionBases(pane: TspPane): string[] {
  return ((sheetProps(pane).actions ?? []) as Array<Record<string, unknown>>)
    .map(entry => String(entry.id).split('#')[0]!)
}

/** Send one Browse action through the id the wire REALLY painted. */
function clickAction(pane: TspPane, base: string): void {
  const entry = sheetAction(pane, base)
  const picker = sheetPicker(pane)
  assert.ok(entry !== undefined, `no ${base} action on the sheet: ${JSON.stringify(sheetProps(pane).actions)}`)
  assert.ok(picker !== undefined, 'the Browse picker must be mounted')
  sendAction(pane, String(entry.id), undefined, picker.id)
}

/** One sheet node of a kind (overlay/editor/button), in wire order. */
function sheetNode(pane: TspPane, kind: string): WireNode | undefined {
  return sheetNodes(pane).find(node => node.k === kind)
}

/** One button of the sheet by the key it was built from. */
function sheetButton(pane: TspPane, fragment: string): WireNode {
  const node = sheetNodes(pane).find(entry => entry.k === 'button' && entry.id.includes(fragment))
  assert.ok(node !== undefined, `no ${fragment} button on the sheet: ${sheetNodes(pane).map(entry => `${entry.k}:${entry.id}`).join(', ')}`)
  return node
}

/** Whether the wire paints `text` as one text node (the confirmation warning). */
function carriesText(pane: TspPane, text: string): boolean {
  return sheetNodes(pane).some(node => node.k === 'text' && String(node.p.text ?? '').includes(text))
}

interface WriteRecord {
  readonly sessionId: string
  readonly id: string
  readonly kind: 'edit' | 'remove'
  readonly content?: readonly unknown[]
}

interface Mounted {
  readonly pane: TspPane
  readonly renderer: TspRenderer
  readonly controller: QueueManagerController
  readonly writes: WriteRecord[]
  /** Admit the next queued `runOwned` task (the owner's write). */
  readonly tasks: () => number
  readonly drain: () => Promise<void>
}

/** One queued Host occurrence. */
function queued(id: string, content: readonly unknown[]): PendingInputItem {
  return { id, placement: 'queued', content }
}

const TEXT_ONE = queued('occ-1', [{ type: 'text', text: 'first queued' }])
const TEXT_TWO = queued('occ-2', [{ type: 'text', text: 'second queued' }])
const FILE_ROW = queued('occ-file', [
  { type: 'text', text: 'please read' },
  { type: 'file', attachment: { attachmentId: 'host-file-a', name: 'old.bin', bytes: 3 } },
])

/**
 * Mount the production TSP renderer over ONE scripted pane and wire the REAL
 * application-level queue controller to it. The pending-input presentation is
 * committed exactly as the display owner commits it, so the Dock queue lane is
 * painted from the same facts the sheet reads.
 */
async function mounted(
  t: { after(fn: () => unknown): void },
  items: readonly PendingInputItem[],
  queueOpenKeys: readonly string[] = ['alt+i'],
): Promise<Mounted> {
  const pane = installTspPane({ queueManager: true })
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, {
    copyVisual: async () => false,
    requestExit() {},
    onFatal: (error) => assert.fail(String(error)),
    queueOpenKeys: () => queueOpenKeys,
  })
  t.after(() => renderer.dispose())
  renderer.bindInput({
    exit() {},
    cancel() {},
    submit() {},
    steer() {},
    pasteMedia() {},
    pastedPath: () => {},
    admitPastedPathDelivery: () => true,
    shouldRememberInput: () => true,
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker() {},
    openModelQuick() {},
    openSessionBrowser() {},
    sessionBrowserAvailable: () => true,
  })

  const writes: WriteRecord[] = []
  const tasks: Promise<void>[] = []
  const reader: PendingInputReader = { snapshot: () => ({ running: true, items }) }
  const writer: SessionWriter = {
    prompt: async () => ({ kind: 'committed', value: undefined }),
    updateQueue: async (sessionId, itemId, action) => {
      writes.push(action.kind === 'edit'
        ? { sessionId, id: itemId, kind: 'edit', content: action.content }
        : { sessionId, id: itemId, kind: 'remove' })
      return { kind: 'committed', value: undefined }
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
  const bind = renderer.bindQueueManager
  assert.ok(bind !== undefined, 'the mounted renderer exposes the queue controller bind')
  bind(controller)
  const presentation = renderer.queuePresentation
  assert.ok(presentation !== undefined, 'the pane negotiated every kind the sheet paints')
  controller.attach(presentation)
  renderer.display.setPendingInputPresentation({
    queued: items.map(item => ({
      id: item.id,
      text: queueTextOf(item.content as readonly ContentBlock[]),
      mode: 'followup' as const,
    })),
    tail: [],
    running: true,
  })
  await waitUntil('the Dock Queue header', () => wireNodes(pane).some(node => node.id === 'dock.queue-header'))
  return {
    pane,
    renderer,
    controller,
    writes,
    tasks: () => tasks.length,
    drain: async () => {
      for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) await task
    },
  }
}

test('native Queue: the Dock queue lane and Manage open the Browse sheet', async (t) => {
  const m = await mounted(t, [TEXT_ONE, TEXT_TWO])
  const ids = wireNodes(m.pane).map(node => node.id)
  // The Dock lane is painted from the SAME presentation the sheet reads.
  assert.equal(ids.includes('dock.queue-header'), true, `the queue header row: ${JSON.stringify(ids)}`)
  assert.equal(ids.includes('dock.queue-header.queue-manage'), true, 'the Manage click target')
  assert.equal(ids.includes('dock.queue-occ-1'), true, 'one clickable row per Host occurrence')
  assert.equal(ids.includes('dock.queue-occ-2'), true)
  const label = wireNodes(m.pane).find(node => node.id === 'dock.queue-header.queue-manage.queue-manage-label')
  assert.equal(label?.p.text, 'Manage [Alt+I]', 'the Dock label names the LIVE injected queue-open chord')
  assert.equal(sheetPicker(m.pane), undefined, 'the sheet starts closed')

  // The Manage entry is a REAL node click: the SDK dispatches its own onClick.
  clickNodeById(m.pane, 'dock.queue-header.queue-manage')
  await waitUntil('the Browse sheet', () => sheetPicker(m.pane) !== undefined)
  // The real client paints a `layer` only through its verified region-root
  // shape: the sheet root MUST be a `ui.col` (a bare picker as the region root
  // was silently ignored by the real Tern client, found by the real-pane lane).
  const layerRoot = wireNodes(m.pane).find(node => node.id === 'layer')
  assert.equal(layerRoot?.k, 'col', `the sheet layer root is a col: ${JSON.stringify(layerRoot)}`)
  assert.equal(sheetProps(m.pane).title, 'Queue')
  assert.equal(sheetProps(m.pane).subtitle, '2 queued')
  assert.deepEqual(itemIds(m.pane), ['occ-1', 'occ-2'], 'the picker rows are the Host occurrences')
  assert.deepEqual(actionBases(m.pane), ['edit', 'delete', 'close'])
  assert.match(String(sheetAction(m.pane, 'edit')?.id), /^edit#\d+$/, 'the bar carries the frame revision')
  assert.equal(sheetAction(m.pane, 'edit')?.disabled, undefined, 'a text-only row is editable')
  assert.equal(sheetAction(m.pane, 'delete')?.label, 'Delete')
  assert.equal(m.controller.isOpen(), true)

  // Close through the sheet's own action, then open the SAME sheet from a Dock row.
  clickAction(m.pane, 'close')
  await waitUntil('the sheet closed', () => sheetPicker(m.pane) === undefined)
  clickNodeById(m.pane, 'dock.queue-occ-2')
  await waitUntil('a Dock row reopened Browse', () => sheetPicker(m.pane) !== undefined)
  assert.equal(sheetProps(m.pane).selected, 'occ-2', 'the clicked occurrence is the preselection')
  assert.equal(m.controller.view().selectedId, 'occ-2')
})

test('native Queue: the raw Alt+I chord opens and closes the sheet', async (t) => {
  const m = await mounted(t, [TEXT_ONE, TEXT_TWO])
  m.pane.key('\u001bi')
  await waitUntil('Alt+I opened the sheet', () => sheetPicker(m.pane) !== undefined)
  // The real client paints a `layer` only through its verified region-root
  // shape: the sheet root MUST be a `ui.col` (a bare picker as the region root
  // was silently ignored by the real Tern client, found by the real-pane lane).
  const layerRoot = wireNodes(m.pane).find(node => node.id === 'layer')
  assert.equal(layerRoot?.k, 'col', `the sheet layer root is a col: ${JSON.stringify(layerRoot)}`)
  assert.equal(sheetProps(m.pane).title, 'Queue')
  // The SAME injected `app.queue.open` binding is the toggle-close of the one
  // entry: a repeated open on a live panel closes it in every renderer.
  m.pane.key('\u001bi')
  await settle(50)
  assert.equal(m.controller.isOpen(), false,
    `a repeated Alt+I must toggle the sheet closed (layer wire: ${JSON.stringify(sheetNodes(m.pane).map(node => `${node.k}:${node.id}`))})`)
  assert.equal(sheetPicker(m.pane), undefined, 'and the sheet must leave the wire')
})

test('native Queue: Edit types into the controlled editor and Ctrl+S writes one edit', async (t) => {
  const m = await mounted(t, [TEXT_ONE, TEXT_TWO])
  m.controller.open()
  await waitUntil('the Browse sheet', () => sheetPicker(m.pane) !== undefined)

  clickAction(m.pane, 'edit')
  await waitUntil('the Edit page', () => sheetNode(m.pane, 'overlay') !== undefined)
  assert.equal(sheetNode(m.pane, 'overlay')?.p.head, 'Edit queued message')
  const editor = (): WireNode | undefined => sheetNode(m.pane, 'editor')
  assert.equal(editor()?.p.text, 'first queued', 'the editor holds the occurrence text')
  assert.equal(m.controller.view().draft, 'first queued')

  // Raw key events reach the app presenter: a typed character edits the
  // controller's draft (never a Host write) and one Enter inserts a newline.
  m.pane.key('XY')
  await waitUntil('the typed draft', () => m.controller.view().draft === 'first queuedXY')
  await waitUntil('the wire editor paints the typed text', () => editor()?.p.text === 'first queuedXY')
  m.pane.key('\r')
  await waitUntil('Enter inserts a newline', () => m.controller.view().draft === 'first queuedXY\n')
  await waitUntil('the wire editor carries the newline', () => editor()?.p.text === 'first queuedXY\n')
  assert.deepEqual(m.writes, [], 'typing and Enter never write')

  m.pane.key('\u0013')
  await waitUntil('the edit write admitted', () => m.tasks() === 1)
  await m.drain()
  await waitUntil('the sheet returned to Browse', () => sheetPicker(m.pane) !== undefined
    && m.controller.view().mode === 'browse')
  assert.deepEqual(m.writes, [{
    sessionId: 'session-a',
    id: 'occ-1',
    kind: 'edit',
    content: [{ type: 'text', text: 'first queuedXY\n' }],
  }], 'Ctrl+S commits exactly ONE official edit with the controlled draft')
})

test('native Queue: Delete confirms once through the writer and returns to Browse', async (t) => {
  const m = await mounted(t, [TEXT_ONE, TEXT_TWO])
  m.controller.open()
  await waitUntil('the Browse sheet', () => sheetPicker(m.pane) !== undefined)

  clickAction(m.pane, 'delete')
  await waitUntil('the Delete confirmation', () => sheetNode(m.pane, 'overlay') !== undefined)
  assert.equal(sheetNode(m.pane, 'overlay')?.p.head, 'Delete queued message')
  assert.equal(carriesText(m.pane, 'This queued message cannot be restored after deletion.'), true,
    'the confirmation states the consequence in words')
  assert.equal(carriesText(m.pane, 'first queued'), true, 'and names the occurrence it removes')
  assert.deepEqual(m.writes, [], 'opening the confirmation never writes')

  const confirm = sheetButton(m.pane, 'queue-delete-confirm')
  assert.equal(confirm.p.text, 'Confirm')
  clickNodeById(m.pane, confirm.id)
  await waitUntil('the remove admitted', () => m.tasks() === 1)
  await m.drain()
  await waitUntil('the sheet returned to Browse', () => sheetPicker(m.pane) !== undefined
    && m.controller.view().mode === 'browse')
  assert.deepEqual(m.writes, [{ sessionId: 'session-a', id: 'occ-1', kind: 'remove' }],
    'Confirm sends exactly ONE remove for the selected occurrence')
})

test('native Queue: an action whose frame token is stale is refused', async (t) => {
  const m = await mounted(t, [TEXT_ONE, TEXT_TWO])
  m.controller.open()
  await waitUntil('the Browse sheet', () => sheetPicker(m.pane) !== undefined)
  const first = sheetAction(m.pane, 'edit')
  const token = Number(String(first?.id).split('#')[1])
  assert.ok(token > 0, `the bar's token is the frame revision: ${JSON.stringify(first)}`)

  // A REAL row select is one admitted intent: the next frame carries a NEW token.
  const pickerId = sheetPicker(m.pane)!.id
  sendSelect(m.pane, 'occ-2', pickerId)
  await waitUntil('the highlight moved', () => sheetProps(m.pane).selected === 'occ-2')
  const current = sheetAction(m.pane, 'edit')
  assert.notEqual(current?.id, first?.id, "the fresh frame's bar is re-tokenized")
  assert.equal(String(current?.id), `edit#${token + 1}`)

  // The PREVIOUS frame's token names no admitted intent: no Edit page exists.
  sendAction(m.pane, `edit#${token}`, undefined, sheetPicker(m.pane)!.id)
  await settle(50)
  assert.equal(sheetNode(m.pane, 'overlay'), undefined, 'a stale token opens no page')
  assert.equal(sheetNode(m.pane, 'editor'), undefined)
  assert.equal(sheetPicker(m.pane) !== undefined, true, 'and Browse stays mounted')
  assert.deepEqual(m.writes, [], 'a stale token never writes')

  // The CURRENT frame's own id is the positive control.
  clickAction(m.pane, 'edit')
  await waitUntil('the current token opens Edit', () => sheetNode(m.pane, 'editor') !== undefined)
  assert.equal(m.controller.view().selectedId, 'occ-2')
})

test('native Queue: a file-bearing occurrence refuses Edit and still deletes', async (t) => {
  const m = await mounted(t, [TEXT_ONE, FILE_ROW])
  m.controller.open()
  await waitUntil('the Browse sheet', () => sheetPicker(m.pane) !== undefined)

  // Reach the file row the sheet's OWN keyboard walk uses (a disabled row is
  // still addressable so Delete remains reachable — the reason is a word, not a
  // dead end).
  m.pane.key('\u001b[B')
  await waitUntil('the file occurrence is selected', () => m.controller.view().selectedId === 'occ-file')
  assert.equal(sheetProps(m.pane).selected, 'occ-file')
  assert.equal(sheetAction(m.pane, 'edit')?.disabled, 'Contains attachments · Editing unavailable',
    'the Edit entry states why it is inert')
  assert.equal(sheetAction(m.pane, 'delete')?.disabled, undefined, 'Delete stays available')

  // Both activation shapes hit the SAME raw-content admission: no Edit page.
  sendActivate(m.pane, 'occ-file', sheetPicker(m.pane)!.id)
  await settle(50)
  assert.equal(sheetNode(m.pane, 'overlay'), undefined, 'activating a file row opens nothing')
  sendAction(m.pane, String(sheetAction(m.pane, 'edit')!.id), undefined, sheetPicker(m.pane)!.id)
  await settle(50)
  assert.equal(sheetNode(m.pane, 'overlay'), undefined, 'the Edit action is refused too')
  assert.equal(sheetProps(m.pane).message, 'Contains attachments · Editing unavailable',
    'Browse states the refusal on the wire')
  assert.deepEqual(m.writes, [], 'no edit write for a non-text occurrence')

  // Delete still works: the confirmation names the attachment and removes once.
  clickAction(m.pane, 'delete')
  await waitUntil('the Delete confirmation', () => sheetNode(m.pane, 'overlay') !== undefined)
  assert.equal(carriesText(m.pane, 'old.bin'), true, 'the confirmation lists the occurrence attachments')
  clickNodeById(m.pane, sheetButton(m.pane, 'queue-delete-confirm').id)
  await waitUntil('the remove admitted', () => m.tasks() === 1)
  await m.drain()
  await waitUntil('the sheet returned to Browse', () => sheetPicker(m.pane) !== undefined
    && m.controller.view().mode === 'browse')
  assert.deepEqual(m.writes, [{ sessionId: 'session-a', id: 'occ-file', kind: 'remove' }],
    'a file-bearing occurrence deletes with ONE remove')
})


test('native Queue: a disabled/leader-only queue-open binding paints Manage with no dead key', async (t) => {
  const m = await mounted(t, [TEXT_ONE], [])
  const label = wireNodes(m.pane).find(node => node.id === 'dock.queue-header.queue-manage.queue-manage-label')
  assert.equal(label?.p.text, 'Manage', 'no shortcut is advertised when the effective action has no direct key')
  m.pane.key('\u001bi')
  await settle(50)
  assert.equal(m.controller.isOpen(), false, 'the unbound raw chord never opens the sheet')
  assert.equal(sheetPicker(m.pane), undefined)
})


test('a pane without the sheet kinds mounts no presenter, no Manage and no raw entry', async (t) => {
  // The base HELLO set has no picker/overlay/editor/button/row/el: the sheet
  // cannot paint, so NOTHING may advertise or accept the queue entry.
  const pane = installTspPane()
  t.after(() => pane.restore())
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session)
  const renderer = mountTspRenderer(session, {
    copyVisual: async () => false,
    requestExit() {},
    onFatal: (error) => assert.fail(String(error)),
    queueOpenKeys: () => ['alt+i'],
  })
  t.after(() => renderer.dispose())
  renderer.bindInput({
    exit() {},
    cancel() {},
    submit() {},
    steer() {},
    pasteMedia() {},
    pastedPath: () => {},
    admitPastedPathDelivery: () => true,
    shouldRememberInput: () => true,
    noteUserInput() {},
    listContinuedQuestions: () => [],
    reopenContinuedQuestion: () => false,
    openModelPicker() {},
    openModelQuick() {},
    openSessionBrowser() {},
    sessionBrowserAvailable: () => true,
  } as never)
  const controller = new QueueManagerController({
    reader: { snapshot: () => ({ running: true, items: [TEXT_ONE] }) },
    writer: {
      prompt: async () => ({ kind: 'committed', value: undefined }),
      updateQueue: async () => ({ kind: 'committed', value: undefined }),
      cancel: async () => ({ kind: 'committed', value: undefined }),
      rename: async () => ({ kind: 'committed', value: { title: 't' } }),
      refreshTitle: async () => ({ kind: 'unsupported', reason: 'none' }),
    },
    captureSessionId: () => 'session-a',
    captureSubject: () => ({}),
    isSubjectCurrent: () => true,
    captureScope: () => ({ sessionId: 'session-a' } as never),
    isScopeCurrent: () => true,
    isViewing: () => false,
    withWriter: async (_scope, task) => task(),
    beginClientWrite: () => () => {},
    runOwned: () => {},
    refreshPendingInput: () => {},
    notify: () => {},
    textOf: content => queueTextOf(content as readonly ContentBlock[]),
  })
  renderer.bindQueueManager?.(controller)
  assert.equal(renderer.queuePresentation, undefined, 'no sheet presentation is exposed without its kinds')
  // The controller cannot be attached to a presentation that does not exist.
  assert.deepEqual(controller.open(), { opened: false, message: 'Queue management is unavailable on this renderer' })

  renderer.display.setPendingInputPresentation({
    queued: [{ id: 'occ-1', text: 'first queued', mode: 'followup' }],
    tail: [],
    running: true,
  })
  await waitUntil('the legacy Dock row', () => wireNodes(pane).some(node => node.id === 'dock.queue-occ-1'))
  const nodes = wireNodes(pane)
  assert.equal(nodes.some(node => node.id.includes('queue-header')), false, 'no Queue header is advertised')
  assert.equal(nodes.some(node => node.id.includes('queue-manage')), false, 'no Manage control is advertised')
  assert.equal(nodes.some(node => node.k === 'el' || node.k === 'button'), false,
    'the renderer sends no control kind the pane did not negotiate')
  assert.equal(nodes.filter(node => node.k === 'text').some(node => String(node.p.text).includes('queued (followup): first queued')), true,
    'the historical plain queue lane is preserved')

  pane.key('\u001bi')
  await settle(50)
  assert.equal(controller.isOpen(), false, 'the raw queue chord cannot open a sheet that is not mounted')
  assert.equal(controller.view().mode, 'closed')
})
