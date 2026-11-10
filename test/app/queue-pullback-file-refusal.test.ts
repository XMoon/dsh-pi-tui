/**
 * Alt+Up queue pull-back at the Remote generic-file boundary: a durable Host
 * file has no official receipt-restage carrier, so the gesture must refuse
 * BEFORE staging recalled drafts or removing any queue occurrence. Direct keeps
 * its existing recalled-ref path (the positive control).
 *
 * @module @xmoon76/dsh-pi-tui/queue-pullback-file-refusal.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { pullBackQueue, type PullBackQueueDeps } from '../../src/app/submission/runtime.ts'

const DIAG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

/** One pull-back harness over a fixed queue; every side effect is recorded. */
function harness(options: {
  readonly canPullBackRecalledFiles: boolean
  readonly content: readonly unknown[]
}): {
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
    canPullBackRecalledFiles: options.canPullBackRecalledFiles,
    isOwnerTokenCurrent: () => true,
    requireLiveScope: () => ({ sessionId: 'session-a' } as never),
    readPullableQueue: () => [{ id: 'queued-file', content: options.content }],
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
    stageRecalledFile: () => {
      staged.push('file')
      return { id: 2, placeholder: '[file #2 (3 B)]' }
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

test('a Remote queue pull-back refuses a durable file before any recall or queue removal', () => {
  const harnessed = harness({
    canPullBackRecalledFiles: false,
    content: [
      { type: 'text', text: 'please read' },
      { type: 'file', attachment: { attachmentId: 'host-file-a', name: 'old.bin', bytes: 3 } },
    ],
  })
  pullBackQueue(harnessed.deps)
  assert.deepEqual(harnessed.removed, [], 'the Host queue occurrence was never removed')
  assert.deepEqual(harnessed.staged, [], 'no recalled draft was staged for an unsupported file')
  assert.equal(harnessed.drafts(), '', 'the editor was not mutated')
  assert.equal(harnessed.notices.length, 1)
  assert.match(harnessed.notices[0]!, /^error:/u)
  assert.match(harnessed.notices[0]!, /stored file/u)
  assert.match(harnessed.notices[0]!, /queue was not modified/u)
})

test('the same pull-back shape still stages recalled files where the backend can rebind them', async () => {
  const harnessed = harness({
    canPullBackRecalledFiles: true,
    content: [
      { type: 'text', text: 'please read' },
      { type: 'file', attachment: { attachmentId: 'host-file-a', name: 'old.bin', bytes: 3 } },
    ],
  })
  pullBackQueue(harnessed.deps)
  // The direct path is asynchronous at the writer boundary; observe settlement.
  for (let index = 0; index < 100 && !harnessed.drafts().includes('[file #2'); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(harnessed.staged, ['file'], 'the positive control stages the recalled draft')
  assert.deepEqual(harnessed.removed, ['queued-file'], 'the positive control removes the occurrence')
  assert.match(harnessed.drafts(), /\[file #2 \(3 B\)\]/u, 'the recalled draft reaches the editor')
})

test('an image-only Remote queue pull-back is unchanged', async () => {
  const harnessed = harness({
    canPullBackRecalledFiles: false,
    content: [{ type: 'image', attachment: { attachmentId: 'att-1', mediaType: 'image/png' } }],
  })
  pullBackQueue(harnessed.deps)
  for (let index = 0; index < 50 && harnessed.removed.length === 0; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.deepEqual(harnessed.staged, ['image'], 'recalled images keep their existing pull-back path')
  assert.deepEqual(harnessed.removed, ['queued-file'], 'the image-only occurrence is recalled normally')
})
