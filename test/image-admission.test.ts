/**
 * M4/M5 tests: harness admission (segments → saveImages → ordered
 * ContentBlock[]) and the model image-capability gate (plan §10-§12).
 * @module @xmoon76/dsh-pi-tui/image-admission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { expandImagePlaceholders } from '../src/image/placeholder.ts'
import {
  admitDraftImages, buildContentBlocks, imageSegmentsBytes, type AttachmentsLike,
  type ImageAttachmentRefLike,
} from '../src/image/admission.ts'
import { assertModelSupportsImages, modelSupportsImages, type LlmLike } from '../src/image/capability.ts'
import { ImageAdmissionError, ModelImageUnsupportedError } from '../src/image/errors.ts'
import type { DraftSegment } from '../src/image/placeholder.ts'

const LIMITS = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 2,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
}

/** Stage two drafts (A=PNG 800×600, B=JPEG 640×480) and expand `text`
 * with A/B standing for their placeholders. */
function draftOf(text: string): { segments: readonly DraftSegment[]; store: DraftImageStore } {
  const store = new DraftImageStore()
  const a = store.add({ bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/png', width: 800, height: 600, name: 'a.png' })
  const b = store.add({ bytes: new Uint8Array([4, 5]), mediaType: 'image/jpeg', width: 640, height: 480, name: 'b.jpg' })
  const withIds = text.replaceAll('A', a.placeholder).replaceAll('B', b.placeholder)
  return { segments: expandImagePlaceholders(withIds, store), store }
}

/** A fake attachments service recording the save batch (one ref per input,
 * in order, with the draft dimensions for the ref). */
function attachmentsService(): AttachmentsService {
  let counter = 0
  const saved: { data: Uint8Array; mediaType: string; name?: string }[][] = []
  const service: AttachmentsService = {
    imageLimits: { ...LIMITS },
    saved,
    async saveImages(inputs) {
      saved.push(inputs as never)
      return inputs.map((input) => {
        counter += 1
        return {
          attachmentId: `att-${counter}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: counter === 1 ? 800 : 640,
          height: counter === 1 ? 600 : 480,
          name: input.name,
        }
      })
    },
  }
  return service
}

interface AttachmentsService extends AttachmentsLike {
  saved: readonly { data: Uint8Array; mediaType: string; name?: string }[][]
  imageLimits: {
    maxImageBytes: number
    maxImagesPerMessage: number
    maxMessageImageBytes: number
    maxImagePixels: number
    maxImageDimension: number
    mediaTypes: readonly ('image/png' | 'image/jpeg' | 'image/webp' | 'image/gif')[]
  }
}

test('a text-only draft admits to a single text block without touching the service', async () => {
  const attachments = attachmentsService()
  const admitted = await admitDraftImages([{ type: 'text', text: 'hello' }], attachments)
  assert.deepEqual(admitted.blocks, [{ type: 'text', text: 'hello' }])
  assert.deepEqual(admitted.refs, [])
  assert.equal(attachments.saved.length, 0)
})

test('mixed draft admits to ordered image/text/image blocks with index-aligned refs', async () => {
  const { segments } = draftOf('A and B')
  const attachments = attachmentsService()
  const admitted = await admitDraftImages(segments, attachments)
  assert.deepEqual(admitted.blocks.map(block => block.type), ['image', 'text', 'image'])
  assert.equal((admitted.blocks[0] as { attachment: { attachmentId: string } }).attachment.attachmentId, 'att-1')
  assert.equal((admitted.blocks[2] as { attachment: { attachmentId: string } }).attachment.attachmentId, 'att-2')
  assert.equal(admitted.refs.length, 2)
  // One batched call, input order preserved.
  assert.equal(attachments.saved.length, 1)
  assert.equal(attachments.saved[0]![0]!.name, 'a.png')
  assert.equal(attachments.saved[0]![1]!.name, 'b.jpg')
})

test('image-only drafts admit without any text block (image-only prompt)', async () => {
  const { segments } = draftOf('A')
  const admitted = await admitDraftImages(segments, attachmentsService())
  assert.deepEqual(admitted.blocks.map(block => block.type), ['image'])
})

test('count preflight rejects drafts beyond maxImagesPerMessage', async () => {
  const store = new DraftImageStore()
  const one = store.add({ bytes: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1 })
  const two = store.add({ bytes: new Uint8Array([2]), mediaType: 'image/png', width: 1, height: 1 })
  const three = store.add({ bytes: new Uint8Array([3]), mediaType: 'image/png', width: 1, height: 1 })
  const segments = expandImagePlaceholders(`${one.placeholder}${two.placeholder}${three.placeholder}`, store)
  await assert.rejects(() => admitDraftImages(segments, attachmentsService()), ImageAdmissionError)
})

test('aggregate preflight rejects oversized batches', async () => {
  const { segments } = draftOf('AB')
  const attachments = attachmentsService()
  attachments.imageLimits = { ...LIMITS, maxMessageImageBytes: 4 }
  await assert.rejects(admitDraftImages(segments, attachments), ImageAdmissionError)
})

test('buildContentBlocks throws when refs and image segments diverge', () => {
  assert.throws(() => buildContentBlocks([{ type: 'image', image: { id: 1 } as never }], []), ImageAdmissionError)
})

test('imageSegmentsBytes sums only the encoded bytes of image segments', () => {
  const { segments } = draftOf('A and B')
  assert.equal(imageSegmentsBytes(segments), 3 + 2)
  assert.equal(imageSegmentsBytes([{ type: 'text', text: 'x' }]), 0)
})

test('modelSupportsImages: explicit image passes, text-only fails, unknown passes', () => {
  assert.equal(modelSupportsImages({ inputModalities: ['text', 'image'] }), true)
  assert.equal(modelSupportsImages({ inputModalities: ['text'] }), false)
  assert.equal(modelSupportsImages({}), true)
  assert.equal(modelSupportsImages({ inputModalities: undefined }), true)
})

test('assertModelSupportsImages rejects a declared text-only model and passes unknown', async () => {
  const llm: LlmLike = {
    async resolveModelInfo() {
      return { inputModalities: ['text'] }
    },
  }
  await assert.rejects(assertModelSupportsImages(llm, 'provider', 'model'), ModelImageUnsupportedError)
  const unknown: LlmLike = {
    async resolveModelInfo() {
      return {}
    },
  }
  await assertModelSupportsImages(unknown, 'provider', 'model')
})

test('a ref-count mismatch from the service is rejected loudly', async () => {
  const { segments } = draftOf('A and B')
  const attachments = attachmentsService()
  const original = attachments.saveImages.bind(attachments)
  // Two images admitted, but the fake service returns only one ref: the
  // admission must reject instead of silently misaligning blocks/refs.
  attachments.saveImages = (async () => {
    const refs = await original([{ data: new Uint8Array([1]), mediaType: 'image/png' as const }])
    return refs.slice(0, 1)
  }) as never
  await assert.rejects(() => admitDraftImages(segments, attachments), ImageAdmissionError)
})

test('recalled images reuse their durable ref without re-uploading (dequeue recall)', async () => {
  const store = new DraftImageStore()
  const fresh = store.add({ bytes: new Uint8Array([9]), mediaType: 'image/png', width: 10, height: 10, name: 'fresh.png' })
  const recalled = store.add({
    mediaType: 'image/jpeg',
    width: 640,
    height: 480,
    source: { type: 'recalled' },
    recalledRef: { attachmentId: 'att-durable', mediaType: 'image/jpeg', bytes: 500, width: 640, height: 480, name: 'old.jpg' },
  })
  const segments = expandImagePlaceholders(`${fresh.placeholder} and ${recalled.placeholder}`, store)
  const attachments = attachmentsService()
  const admitted = await admitDraftImages(segments, attachments)
  // Only ONE save call for the fresh image; the recalled ref is reused.
  assert.equal(attachments.saved.length, 1)
  assert.equal(attachments.saved[0]!.length, 1)
  assert.equal(attachments.saved[0]![0]!.name, 'fresh.png')
  const blocks = admitted.blocks.filter(block => block.type === 'image')
  assert.equal((blocks[0] as { attachment: { attachmentId: string } }).attachment.attachmentId, 'att-1')
  assert.equal((blocks[1] as { attachment: { attachmentId: string } }).attachment.attachmentId, 'att-durable')
})
