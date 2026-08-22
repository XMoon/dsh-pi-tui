/**
 * M6 tests: the draft → UserMessage preparation shared by followup, steer
 * and queue (plan §13): capability gate order, batched admission, ordered
 * blocks, image-only drafts, and the no-image fast path.
 * @module @xmoon76/dsh-pi-tui/image-submit.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { consumeDraftImages, draftHasImages, prepareUserMessage, type PrepareInputDeps } from '../src/image/submit.ts'
import { ImageAdmissionError, ModelImageUnsupportedError } from '../src/image/errors.ts'
import type { AttachmentsLike, ImageAttachmentRefLike } from '../src/image/admission.ts'
import type { LlmLike } from '../src/image/capability.ts'
import type { DraftImage } from '../src/image/types.ts'

const LIMITS = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
}

/** Fake attachments service counting batch calls. */
function fakeAttachments(): AttachmentsLike & { callCount: () => number } {
  let calls = 0
  return {
    imageLimits: { ...LIMITS },
    callCount: () => calls,
    async saveImages(inputs) {
      calls += 1
      return inputs.map((input, index): ImageAttachmentRefLike => ({
        attachmentId: `att-${index + 1}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 800,
        height: 600,
        name: input.name,
      }))
    },
  }
}

function depsOf(overrides: Partial<PrepareInputDeps> = {}): PrepareInputDeps {
  return {
    attachments: fakeAttachments(),
    llm: {
      async resolveModelInfo() {
        return { inputModalities: ['text', 'image'] }
      },
    } as LlmLike,
    currentModel: () => ({ provider: 'provider', model: 'model' }),
    ...overrides,
  }
}

/** Stage one draft and return it. */
function staged(store: DraftImageStore, name = 'shot.png'): DraftImage {
  return store.add({
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png',
    width: 800,
    height: 600,
    source: { type: 'path', path: `/ws/${name}` },
    name,
  })
}

test('a plain text draft keeps the legacy single-text-block message (no service calls)', async () => {
  const store = new DraftImageStore()
  const attachments = fakeAttachments()
  const message = await prepareUserMessage('hello world', store, depsOf({ attachments }))
  assert.equal(message.role, 'user')
  assert.equal(message.content.length, 1)
  assert.equal(message.content[0]!.type, 'text')
  assert.equal((message.content[0] as { text: string }).text, 'hello world')
  assert.equal(attachments.callCount(), 0)
})

test('mixed text/image draft yields ordered blocks through one batched save', async () => {
  const store = new DraftImageStore()
  const one = staged(store, 'a.png')
  const two = staged(store, 'b.png')
  const message = await prepareUserMessage(`see ${one.placeholder} then ${two.placeholder}`, store, depsOf())
  assert.deepEqual(message.content.map(block => block.type), ['text', 'image', 'text', 'image'])
  const imageBlocks = message.content.filter(block => block.type === 'image')
  assert.equal((imageBlocks[0] as { attachment: { attachmentId: string } }).attachment.attachmentId, 'att-1')
  assert.equal((imageBlocks[1] as { attachment: { attachmentId: string } }).attachment.attachmentId, 'att-2')
})

test('an image-only draft produces an image-only message (no text block)', async () => {
  const store = new DraftImageStore()
  const one = staged(store)
  const message = await prepareUserMessage(one.placeholder, store, depsOf())
  assert.deepEqual(message.content.map(block => block.type), ['image'])
})

test('draftHasImages reflects staged references only', () => {
  const store = new DraftImageStore()
  assert.equal(draftHasImages('plain', store), false)
  const one = staged(store)
  assert.equal(draftHasImages(one.placeholder, store), true)
  assert.equal(draftHasImages('[image #99 (1×1)]', store), false)
})

test('a declared text-only model rejects the submission before admission', async () => {
  const store = new DraftImageStore()
  const one = staged(store)
  const deps = depsOf({
    llm: { async resolveModelInfo() { return { inputModalities: ['text'] } } } as LlmLike,
  })
  await assert.rejects(() => prepareUserMessage(one.placeholder, store, deps), ModelImageUnsupportedError)
})

test('an unknown capability (no inputModalities) does not reject', async () => {
  const store = new DraftImageStore()
  const one = staged(store)
  const deps = depsOf({
    llm: { async resolveModelInfo() { return {} } } as LlmLike,
  })
  const message = await prepareUserMessage(one.placeholder, store, deps)
  assert.equal(message.content[0]!.type, 'image')
})

test('a draft referencing images without an attachment service rejects loudly', async () => {
  const store = new DraftImageStore()
  const one = staged(store)
  const deps = depsOf({ attachments: undefined })
  await assert.rejects(() => prepareUserMessage(one.placeholder, store, deps), ImageAdmissionError)
})

test('consumeDraftImages removes ONLY the referenced drafts (round-5 finding 1)', () => {
  const store = new DraftImageStore()
  const consumed = staged(store, 'consumed.png')
  const concurrent = staged(store, 'concurrent.png')
  // Submit text referencing only the first image: a concurrent intake's
  // draft must survive the consumption.
  consumeDraftImages(consumed.placeholder, store)
  assert.equal(store.get(consumed.id), undefined, 'the consumed draft is removed')
  assert.equal(store.get(concurrent.id)?.name, 'concurrent.png', 'the racing intake survives')
  // Nothing referenced → nothing removed.
  consumeDraftImages('plain text', store)
  assert.equal(store.get(concurrent.id)?.name, 'concurrent.png')
})
