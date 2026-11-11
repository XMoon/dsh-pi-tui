/**
 * Alt+Up queue pull-back at the durable generic-FILE boundary: a durable Host
 * file has no official receipt-restage carrier on EITHER backend, so the
 * gesture must refuse the WHOLE queue BEFORE staging any recalled draft or
 * removing any occurrence. Images keep their recalled-ref path.
 *
 * The refusal is one shared semantic (no transport switch): a mixed queue is
 * rejected as a whole, never partially recalled.
 *
 * @module @xmoon76/dsh-pi-tui/queue-pullback-file-refusal.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { pullBackQueue, type PullBackQueueDeps } from '../../src/app/submission/runtime.ts'

const DIAG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

/** One pull-back harness over a fixed queue; every side effect is recorded. */
function harness(content: readonly unknown[]): {
  readonly deps: PullBackQueueDeps
  readonly removed: string[]
  readonly notices: string[]
  readonly staged: ('image' | 'file')[]
  drafts(): string
} {
  const removed: string[] = []
  const notices: string[] = []
  const staged: ('image' | 'file')[] = []
  let draft = ''
  const deps: PullBackQueueDeps = {
    isDisposed: () => false,
    isViewing: () => false,
    currentAgent: () => ({ session: { id: 'session-a' } }),
    captureOwnerToken: () => ({}),
    isOwnerTokenCurrent: () => true,
    requireLiveScope: () => ({ sessionId: 'session-a' } as never),
    readPullableQueue: () => [{ id: 'queued-file', content }],
    isTransitionPending: () => false,
    withWriter: async (_scope, task) => task(),
    updateQueue: async (_sessionId, messageId) => {
      removed.push(messageId)
      return { kind: 'committed', value: undefined }
    },
    deferQueueRecall: () => {},
    stageRecalledImage: () => {
      staged.push('image')
      return { id: 1, placeholder: '[image #1 (1×1)]' }
    },
    discardStagedDraft: () => {},
    pinRecalledDrafts: () => () => {},
    readDraft: () => draft,
    writeDraft: text => { draft = text },
    notify: (message, kind) => { notices.push(`${kind}:${message}`) },
    refreshPendingInput: () => {},
    diag: DIAG,
    beginClientWrite: () => () => {},
  }
  return { deps, removed, notices, staged, drafts: () => draft }
}

const FILE = { type: 'file', attachment: { attachmentId: 'host-file-a', name: 'old.bin', bytes: 3 } }

test('a queue pull-back refuses a durable file before any recall or queue removal', () => {
  const harnessed = harness([
    { type: 'text', text: 'please read' },
    FILE,
  ])
  pullBackQueue(harnessed.deps)
  assert.deepEqual(harnessed.removed, [], 'the Host queue occurrence was never removed')
  assert.deepEqual(harnessed.staged, [], 'no recalled draft was staged for an unsupported file')
  assert.equal(harnessed.drafts(), '', 'the editor was not mutated')
  assert.equal(harnessed.notices.length, 1)
  assert.equal(
    harnessed.notices[0],
    'error:Cannot recall queued messages containing files. Use /queue to remove the file-bearing message, then press Alt+Up again.',
  )
})

test('a mixed IMAGE + text + FILE queue is refused as a whole, never partially recalled', () => {
  const harnessed = harness([
    { type: 'text', text: 'first' },
    { type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png' } },
    { type: 'text', text: 'and the file' },
    FILE,
  ])
  pullBackQueue(harnessed.deps)
  assert.deepEqual(harnessed.staged, [], 'the image before the file was not staged either')
  assert.deepEqual(harnessed.removed, [], 'no occurrence was removed')
  assert.equal(harnessed.drafts(), '')
  assert.equal(harnessed.notices.length, 1)
})

test('an image-only queue pull-back keeps its existing recall path', async () => {
  const harnessed = harness([{ type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png' } }])
  pullBackQueue(harnessed.deps)
  for (let index = 0; index < 50 && harnessed.drafts() === ''; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(harnessed.staged, ['image'], 'recalled images keep their existing pull-back path')
  assert.deepEqual(harnessed.removed, ['queued-file'], 'the image-only occurrence is recalled normally')
  assert.match(harnessed.drafts(), /\[image #1 \(1×1\)\]/u, 'the recalled image reaches the editor')
})

test('a text-only queue pull-back is unchanged', async () => {
  const harnessed = harness([{ type: 'text', text: 'plain queued message' }])
  pullBackQueue(harnessed.deps)
  for (let index = 0; index < 50 && harnessed.drafts() === ''; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(harnessed.staged, [])
  assert.deepEqual(harnessed.removed, ['queued-file'])
  assert.equal(harnessed.drafts(), 'plain queued message')
})
