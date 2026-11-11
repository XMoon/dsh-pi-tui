/**
 * The Queue manager controller contract (PR-Q): the ONE application-level owner
 * of the per-occurrence queue panel.
 *
 * These tests drive the REAL controller over a fake Host projection and a fake
 * semantic writer: the raw content admission (never the display summary), the
 * exact occurrence id write target, the owner/scope fences, the settlement
 * vocabulary (committed/rejected/indeterminate/cancelled) and the local panel
 * state machine. The UI is covered separately by the panel/Dock/TSP suites.
 *
 * @module @xmoon76/dsh-pi-tui/queue-manager.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { QueueManagerController, type QueueManagerPresentation } from '../../src/app/queue/manager.ts'
import { queueTextOf } from '../../src/app/surface/pending-presentation.ts'
import type { PendingInputItem, PendingInputReader, PendingInputSnapshot } from '../../src/runtime/pending-input-reader-port.ts'
import type { SessionWriter, WriteOutcome } from '../../src/runtime/session-writer-port.ts'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

const DIAG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

interface HarnessOptions {
  readonly items?: readonly PendingInputItem[]
  readonly unavailable?: boolean
  readonly sessionId?: string | undefined
  readonly viewing?: boolean
}

interface WriteRecord {
  readonly sessionId: string
  readonly id: string
  readonly kind: 'edit' | 'remove'
  readonly content?: readonly unknown[]
}

function item(id: string, content: readonly unknown[], placement: 'queued' | 'steering' | 'context' = 'queued'): PendingInputItem {
  return { id, placement, content }
}

function harness(options: HarnessOptions = {}) {
  let items = options.items ?? []
  let sessionId: string | undefined = 'sessionId' in options ? options.sessionId : 'session-a'
  let unavailable = options.unavailable === true
  const writes: WriteRecord[] = []
  const notices: string[] = []
  let refreshes = 0
  const presents: number[] = []
  const tasks: Promise<void>[] = []
  let outcome: WriteOutcome = { kind: 'committed', value: undefined }
  let writeGate: { readonly promise: Promise<void>; readonly release: () => void } | undefined
  const reader: PendingInputReader = {
    snapshot(id: string): PendingInputSnapshot | undefined {
      if (unavailable) return undefined
      assert.equal(id, sessionId)
      return { running: true, items }
    },
  }
  const writer: SessionWriter = {
    prompt: async () => ({ kind: 'committed', value: undefined }),
    updateQueue: async (id, itemId, action) => {
      writes.push(action.kind === 'edit'
        ? { sessionId: id, id: itemId, kind: 'edit', content: action.content }
        : { sessionId: id, id: itemId, kind: 'remove' })
      if (writeGate !== undefined) await writeGate.promise
      return outcome
    },
    cancel: async () => ({ kind: 'committed', value: undefined }),
    rename: async () => ({ kind: 'committed', value: { title: 't' } }),
    refreshTitle: async () => ({ kind: 'unsupported', reason: 'none' }),
  }
  const controller = new QueueManagerController({
    reader,
    writer,
    captureSessionId: () => sessionId,
    captureSubject: () => ({ owner: sessionId }),
    isSubjectCurrent: (token) => (token as { owner?: string } | undefined)?.owner === sessionId,
    captureScope: () => (sessionId === undefined ? undefined : ({ sessionId } as never)),
    isScopeCurrent: () => true,
    isViewing: () => options.viewing === true,
    withWriter: async (_scope, task) => task(),
    beginClientWrite: () => () => {},
    runOwned: (_label, task) => { tasks.push(task()) },
    refreshPendingInput: () => { refreshes += 1 },
    notify: (message) => { notices.push(message) },
    textOf: content => queueTextOf(content as readonly ContentBlock[]),
  })
  const presentation: QueueManagerPresentation = {
    present: () => { presents.push(controller.view().mode === 'closed' ? 0 : 1) },
    retire: () => {},
  }
  controller.attach(presentation)
  const drain = async (): Promise<void> => {
    while (tasks.length > 0) await tasks.shift()
  }
  return {
    controller,
    writes,
    notices,
    presents,
    drain,
    setItems(next: readonly PendingInputItem[]) { items = next },
    setUnavailable(next: boolean) { unavailable = next },
    switchSession(next: string | undefined) { sessionId = next },
    setOutcome(next: WriteOutcome) { outcome = next },
    diag: DIAG,
    refreshes: () => refreshes,
    holdWrites(): () => void {
      let release!: () => void
      const promise = new Promise<void>(resolve => { release = resolve })
      writeGate = { promise, release }
      return () => {
        writeGate = undefined
        release()
      }
    },
  }
}

test('a text-only occurrence opens Edit with the official textOf projection and writes one official edit', async () => {
  const h = harness({
    items: [
      item('occ-1', [{ type: 'text', text: 'first ' }, { type: 'text', text: ' second' }]),
      item('occ-2', [{ type: 'text', text: 'other' }]),
    ],
  })
  assert.deepEqual(h.controller.open(), { opened: true })
  const view = h.controller.view()
  assert.equal(view.mode, 'browse')
  assert.equal(view.count, 2)
  assert.equal(view.selectedId, 'occ-1')
  assert.equal(view.selected?.text, 'first   second')
  assert.equal(view.selected?.textOnly, true)

  h.controller.startEdit()
  assert.equal(h.controller.view().mode, 'edit')
  assert.equal(h.controller.view().draft, 'first  second')
  h.controller.setDraft('edited text')
  h.controller.save()
  await h.drain()

  assert.deepEqual(h.writes, [{
    sessionId: 'session-a',
    id: 'occ-1',
    kind: 'edit',
    content: [{ type: 'text', text: 'edited text' }],
  }])
  assert.equal(h.controller.view().mode, 'browse')
  assert.equal(h.controller.view().selectedId, 'occ-1')
})

test('an attachment-bearing occurrence cannot be edited (raw content, not the display summary)', () => {
  const h = harness({
    items: [item('occ-file', [
      { type: 'text', text: '📄 not a real file block' },
      { type: 'file', attachment: { attachmentId: 'a1', name: 'report.pdf', bytes: 128 * 1024 } },
    ])],
  })
  h.controller.open()
  assert.equal(h.controller.view().rows[0]?.textOnly, false)
  h.controller.startEdit()
  assert.equal(h.controller.view().mode, 'browse', 'the edit page must not open')
  assert.equal(h.controller.view().notice?.text, 'Contains attachments · Editing unavailable')
  assert.deepEqual(h.writes, [])
})

test('a file-bearing occurrence is still deletable with exactly one remove', async () => {
  const h = harness({
    items: [item('occ-file', [{ type: 'file', attachment: { attachmentId: 'a1', name: 'report.pdf', bytes: 1 } }])],
  })
  h.controller.open()
  h.controller.startDelete()
  assert.equal(h.controller.view().mode, 'confirm-delete')
  h.controller.confirmDelete()
  await h.drain()
  assert.deepEqual(h.writes, [{ sessionId: 'session-a', id: 'occ-file', kind: 'remove' }])
  assert.equal(h.controller.view().mode, 'browse')
})

test('only queued occurrences are addressable: steering and context never enter the panel', () => {
  const h = harness({
    items: [
      item('q', [{ type: 'text', text: 'queued' }]),
      item('s', [{ type: 'text', text: 'steer' }], 'steering'),
      item('c', [{ type: 'text', text: 'context' }], 'context'),
    ],
  })
  h.controller.open()
  assert.deepEqual(h.controller.view().rows.map(row => row.id), ['q'])
  assert.equal(h.controller.view().count, 1)
})

test('an empty queue and an unavailable projection are different states', () => {
  const empty = harness({ items: [] })
  empty.controller.open()
  assert.equal(empty.controller.view().list, 'ready')
  assert.equal(empty.controller.view().count, 0)
  assert.equal(empty.controller.view().mode, 'browse')

  const unavailable = harness({ unavailable: true })
  unavailable.controller.open()
  assert.equal(unavailable.controller.view().list, 'unavailable')
  assert.equal(unavailable.controller.view().count, 0)
})

test('a sessionless open states No active session and never creates a session', () => {
  const h = harness({ sessionId: undefined, items: [] })
  assert.deepEqual(h.controller.open(), { opened: true })
  assert.equal(h.controller.view().list, 'no-session')
  assert.equal(h.controller.view().mode, 'browse')
  assert.deepEqual(h.writes, [])
})

test('a blank draft is refused before any Host write', async () => {
  const h = harness({ items: [item('occ-1', [{ type: 'text', text: 'hello' }])] })
  h.controller.open()
  h.controller.startEdit()
  h.controller.setDraft('   \n ')
  h.controller.save()
  await h.drain()
  assert.deepEqual(h.writes, [])
  assert.equal(h.controller.view().mode, 'edit', 'the local draft stays editable')
  assert.match(h.controller.view().notice?.text ?? '', /non-whitespace/u)
})

test('a cross-client edit between open and save is refused instead of overwriting the newer text', async () => {
  const h = harness({ items: [item('occ-1', [{ type: 'text', text: 'version A' }])] })
  h.controller.open()
  h.controller.startEdit()
  h.controller.setDraft('my local edit')
  h.setItems([item('occ-1', [{ type: 'text', text: 'version B' }])])
  h.controller.save()
  await h.drain()
  assert.deepEqual(h.writes, [], 'the stale draft never reaches the Host')
  assert.equal(h.controller.view().mode, 'edit')
  assert.match(h.controller.view().notice?.text ?? '', /changed/u)
})

test('a rejected edit keeps the draft and the edit page open', async () => {
  const h = harness({ items: [item('occ-1', [{ type: 'text', text: 'hello' }])] })
  h.setOutcome({ kind: 'rejected', error: { code: 'gateway/bad-request', message: 'nope' } })
  h.controller.open()
  h.controller.startEdit()
  h.controller.setDraft('new text')
  h.controller.save()
  await h.drain()
  assert.equal(h.controller.view().mode, 'edit')
  assert.equal(h.controller.view().draft, 'new text')
  assert.match(h.controller.view().notice?.text ?? '', /Could not update/u)
  assert.match(h.controller.view().notice?.text ?? '', /nope/u)
})

test('an indeterminate settlement says unknown and never retries automatically', async () => {
  const h = harness({ items: [item('occ-1', [{ type: 'text', text: 'hello' }])] })
  h.setOutcome({ kind: 'indeterminate', error: { code: 'gateway/unknown', message: 'unknown' } })
  h.controller.open()
  h.controller.startEdit()
  h.controller.setDraft('new text')
  h.controller.save()
  await h.drain()
  assert.equal(h.writes.length, 1, 'exactly one attempt — no automatic replay')
  assert.equal(h.controller.view().mode, 'edit')
  assert.match(h.controller.view().notice?.text ?? '', /unknown/u)
})

test('a cancelled write is stated as cancelled and keeps the draft', async () => {
  const h = harness({ items: [item('occ-1', [{ type: 'text', text: 'hello' }])] })
  h.setOutcome({ kind: 'cancelled' })
  h.controller.open()
  h.controller.startEdit()
  h.controller.setDraft('new text')
  h.controller.save()
  await h.drain()
  assert.equal(h.controller.view().mode, 'edit')
  assert.match(h.controller.view().notice?.text ?? '', /cancelled/u)
})

test('a second intent while a write is in flight is refused (one writer call)', async () => {
  const h = harness({ items: [item('occ-1', [{ type: 'text', text: 'hello' }])] })
  h.setOutcome({ kind: 'committed', value: undefined })
  h.controller.open()
  h.controller.startEdit()
  h.controller.setDraft('one')
  h.controller.save()
  h.controller.save()
  await h.drain()
  assert.equal(h.writes.length, 1)
})

test('cross-client deletion before confirmation reports no-longer-queued and never removes another row', async () => {
  const h = harness({ items: [item('occ-1', [{ type: 'text', text: 'one' }])] })
  h.controller.open()
  h.controller.startDelete()
  h.setItems([item('occ-2', [{ type: 'text', text: 'two' }])])
  h.controller.confirmDelete()
  await h.drain()
  assert.deepEqual(h.writes, [], 'the stale occurrence id is never re-pointed at the new row')
  assert.equal(h.controller.view().mode, 'browse')
  assert.equal(h.controller.view().notice?.text, 'This message is no longer queued')
})

test('a session-owner change retires the panel and a stale result never notifies the new subject', async () => {
  const h = harness({ items: [item('occ-1', [{ type: 'text', text: 'hello' }])] })
  h.controller.open()
  h.controller.startEdit()
  h.controller.setDraft('edited')
  h.switchSession('session-b')
  assert.equal(h.controller.view().mode, 'closed')
  // A save from the now-retired page cannot write to the replacement Session.
  h.controller.save()
  await h.drain()
  assert.deepEqual(h.writes, [])
})

test('a vanished Dock row while Browse is open drops the prior highlight', () => {
  const h = harness({
    items: [item('a', [{ type: 'text', text: 'a' }]), item('b', [{ type: 'text', text: 'b' }])],
  })
  h.controller.open()
  assert.equal(h.controller.view().selectedId, 'a')
  h.controller.open({ initialItemId: 'gone' })
  assert.equal(h.controller.view().mode, 'browse')
  assert.equal(h.controller.view().selectedId, undefined, 'the previous highlight is not reused')
  assert.equal(h.controller.view().notice?.text, 'This message is no longer queued')
  h.controller.startEdit()
  assert.equal(h.controller.view().mode, 'browse', 'Enter cannot edit the old selection')
  assert.equal(h.controller.view().notice?.text, 'Select a queued message')
  assert.deepEqual(h.writes, [])
})

test('the Dock preselection uses the exact Host id and a vanished id opens Browse with a notice', () => {
  const h = harness({
    items: [item('a', [{ type: 'text', text: 'a' }]), item('b', [{ type: 'text', text: 'b' }])],
  })
  h.controller.open({ initialItemId: 'b' })
  assert.equal(h.controller.view().selectedId, 'b')
  assert.equal(h.controller.view().notice, undefined)
  h.controller.close()

  h.controller.open({ initialItemId: 'gone' })
  assert.equal(h.controller.view().mode, 'browse')
  assert.equal(h.controller.view().selectedId, undefined, 'a stale click never falls back to the first live row')
  assert.equal(h.controller.view().notice?.text, 'This message is no longer queued')
  // Enter/D with no selection perform no target operation at all.
  h.controller.startEdit()
  assert.equal(h.controller.view().mode, 'browse')
  assert.equal(h.controller.view().notice?.text, 'Select a queued message')
  h.controller.startDelete()
  assert.equal(h.controller.view().mode, 'browse')
  assert.deepEqual(h.writes, [])
  // The user's explicit selection re-enables the normal browse fallbacks.
  h.controller.select('a')
  assert.equal(h.controller.view().selectedId, 'a')
})

test('a write settling after the panel was closed never repaints or reopens it', async () => {
  const h = harness({ items: [item('occ-1', [{ type: 'text', text: 'hello' }])] })
  const release = h.holdWrites()
  h.controller.open()
  h.controller.startEdit()
  h.controller.setDraft('edited')
  h.controller.save()
  h.controller.close()
  const presentsAfterClose = [...h.presents]
  assert.equal(h.controller.view().mode, 'closed')
  release()
  await h.drain()
  assert.equal(h.controller.view().mode, 'closed', 'the closed panel stays closed after the Host write settles')
  assert.deepEqual(h.presents, presentsAfterClose, 'no presentation is re-emitted for the retired panel')
  assert.equal(h.refreshes(), 1, 'the shared Host projection is still refreshed after a committed retired write')
  assert.equal(h.writes.length, 1)
})

test('a Dock row preselection moves the open Browse selection instead of closing it', () => {
  const h = harness({
    items: [item('a', [{ type: 'text', text: 'a' }]), item('b', [{ type: 'text', text: 'b' }])],
  })
  h.controller.open()
  h.controller.open({ initialItemId: 'b' })
  assert.equal(h.controller.view().mode, 'browse')
  assert.equal(h.controller.view().selectedId, 'b')
  h.controller.startEdit()
  assert.equal(h.controller.view().mode, 'edit')
  // A row click while an edit page is open never discards the local draft.
  h.controller.open({ initialItemId: 'a' })
  assert.equal(h.controller.view().mode, 'edit')
  assert.equal(h.controller.view().selectedId, 'b')
})

test('a repeated open toggles the panel closed and Esc backs out one level', () => {
  const h = harness({ items: [item('occ-1', [{ type: 'text', text: 'hello' }])] })
  h.controller.open()
  h.controller.open()
  assert.equal(h.controller.view().mode, 'closed')
  h.controller.open()
  h.controller.startEdit()
  h.controller.cancelBack()
  assert.equal(h.controller.view().mode, 'browse')
  h.controller.cancelBack()
  assert.equal(h.controller.view().mode, 'closed')
})

test('a viewer refuses to open the manager and notifies instead', () => {
  const h = harness({ viewing: true, items: [item('occ-1', [{ type: 'text', text: 'hello' }])] })
  const result = h.controller.open()
  assert.equal(result.opened, false)
  assert.match(result.message ?? '', /subagent viewer/u)
  assert.equal(h.controller.view().mode, 'closed')
  assert.deepEqual(h.notices, ['Queue management is unavailable in a subagent viewer'])
})
