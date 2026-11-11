/**
 * PR-Q real-pane subject: the production TSP Queue manager sheet.
 *
 * Mounts the production `mountTspRenderer` over a real Tern pane and wires the
 * real application-level `QueueManagerController` to a scripted pending-input
 * projection + semantic writer. The subject appends the controller's live view
 * and every writer settlement to `events.jsonl`, so the flow reads the SAME
 * facts the sheet shows and the ONE write path it drives.
 */
import { appendFileSync } from 'node:fs'
import { connect } from '@stencil-hq/tern'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'
import { QueueManagerController } from '../src/app/queue/manager.ts'
import { queueTextOf } from '../src/app/surface/pending-presentation.ts'
import type { PendingInputItem, PendingInputReader } from '../src/runtime/pending-input-reader-port.ts'
import type { SessionWriter } from '../src/runtime/session-writer-port.ts'

const dir = process.env.TERN_PANE_DIR ?? '.'
const note = (value: unknown): void => appendFileSync(`${dir}/events.jsonl`, `${JSON.stringify(value)}\n`)

const session = await connect({ app: 'queue-manager', timeout: 2000 })
if (!session) throw new Error('this subject must run inside a real Tern pane')
note({ caps: session.caps })
const originalIterator = session[Symbol.asyncIterator].bind(session)
Object.defineProperty(session, Symbol.asyncIterator, {
  value: async function* () {
    for await (const item of originalIterator()) {
      if (item.type === 'key') note({ key: item.key })
      yield item
    }
  },
})
const items: PendingInputItem[] = [
  { id: 'occ-1', placement: 'queued', content: [{ type: 'text', text: 'first queued' }] },
  { id: 'occ-2', placement: 'queued', content: [{ type: 'text', text: 'second queued' }] },
]
const reader: PendingInputReader = { snapshot: () => ({ running: true, items }) }
const writer: SessionWriter = {
  prompt: async () => ({ kind: 'committed', value: undefined }),
  updateQueue: async (sessionId, itemId, action) => {
    note({ write: action.kind, sessionId, itemId, ...(action.kind === 'edit' ? { content: action.content } : {}) })
    return { kind: 'committed', value: undefined }
  },
  cancel: async () => ({ kind: 'committed', value: undefined }),
  rename: async () => ({ kind: 'committed', value: { title: 'queue' } }),
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
  runOwned: (_label, task) => { void task() },
  refreshPendingInput: () => {},
  notify: (message, kind) => { note({ notify: message, kind }) },
  textOf: content => queueTextOf(content as readonly ContentBlock[]),
})

const renderer = mountTspRenderer(session, {
  copyVisual: async () => false,
  requestExit() {},
  onFatal(error) { note({ fatal: String(error) }) },
  queueOpenKeys: () => ['alt+i'],
})
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
renderer.bindQueueManager(controller)
note({ queuePresentation: renderer.queuePresentation !== undefined })
controller.attach(renderer.queuePresentation!)
renderer.display.setPendingInputPresentation({
  queued: items.map(item => ({
    id: item.id,
    text: queueTextOf(item.content as readonly ContentBlock[]),
    mode: 'followup' as const,
  })),
  tail: [],
  running: true,
})
renderer.display.commitStatusFacts({ sessionTitle: 'queue-manager ready' })
note({ ready: true })

// The flow reads the live panel state from this file (the sheet itself only
// paints that state on the wire).
setInterval(() => {
  const view = controller.view()
  note({ view: { mode: view.mode, selectedId: view.selectedId, draft: view.draft, count: view.count } })
}, 100)

await new Promise<void>((resolve) => {
  process.once('SIGTERM', () => resolve())
  process.once('SIGINT', () => resolve())
})
await renderer.dispose()
