import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DraftFileStore } from '../src/attachment/file-draft.ts'
import type { FileAttachmentStoreLike } from '../src/attachment/file-admission.ts'
import { FileInputError, probeAttachment } from '../src/attachment/intake.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { draftHasAttachments, prepareUserMessage, type PrepareInputDeps } from '../src/image/submit.ts'
import type { AttachmentsLike, ImageAttachmentRefLike } from '../src/image/admission.ts'
import type { LlmLike } from '../src/image/capability.ts'

const imageLimits = {
  maxImageBytes: 20 * 1024 * 1024,
  maxImagesPerMessage: 4,
  maxMessageImageBytes: 200 * 1024 * 1024,
  maxImagePixels: 64_000_000,
  maxImageDimension: 8192,
  mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const,
}

function deps(attachments: AttachmentsLike | undefined): PrepareInputDeps {
  return {
    attachments,
    llm: { async resolveModelInfo() { return { inputModalities: ['text', 'image'] } } } as LlmLike,
    currentModel: () => ({ provider: 'provider', model: 'model' }),
    sessionCwd: () => '/ws',
    canonicalizeMentions: async text => text,
  }
}

test('file-only preparation streams a generic draft and skips image capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-submit-'))
  try {
    const path = join(root, 'report.pdf')
    const bytes = Buffer.from('%PDF-1.7\nreport')
    await writeFile(path, bytes)
    const probe = await probeAttachment(path, root)
    assert.equal(probe.kind, 'file')
    if (probe.kind !== 'file') return
    const files = new DraftFileStore()
    const draft = files.add({
      name: probe.name,
      byteLength: probe.byteLength,
      source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
    })
    let saved = 0
    const attachments = {
      imageLimits,
      async saveImages() { throw new Error('file-only input must not save images') },
      async saveFileStream({ data }: Parameters<FileAttachmentStoreLike['saveFileStream']>[0]) {
        saved += 1
        const chunks: Uint8Array[] = []
        for await (const chunk of data) chunks.push(chunk)
        return { attachmentId: 'sha256:file', name: draft.name, bytes: Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).byteLength }
      },
    } as unknown as AttachmentsLike
    assert.equal(draftHasAttachments(draft.placeholder, new DraftImageStore(), files), true)
    const message = await prepareUserMessage(draft.placeholder, new DraftImageStore(), {
      ...deps(attachments),
      fileStore: files,
      llm: { async resolveModelInfo() { throw new Error('file-only input must not probe image capability') } } as LlmLike,
    })
    assert.deepEqual(message.content.map(block => block.type), ['file'])
    assert.equal(saved, 1)
    assert.equal((message.content[0] as { attachment: { bytes: number } }).attachment.bytes, bytes.byteLength)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('mixed preparation preserves text/file/image order and recalled files are not re-saved', async () => {
  const images = new DraftImageStore()
  const image = images.add({ bytes: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1 })
  const files = new DraftFileStore()
  const file = files.add({
    name: 'report.pdf',
    byteLength: 4,
    source: { type: 'recalled', ref: { attachmentId: 'sha256:existing', name: 'report.pdf', bytes: 4 } },
  })
  let imageSaves = 0
  let fileSaves = 0
  const attachments = {
    imageLimits,
    async saveImages(inputs: readonly { data: Uint8Array; mediaType: 'image/png' }[]): Promise<readonly ImageAttachmentRefLike[]> {
      imageSaves += 1
      return inputs.map(input => ({ attachmentId: 'sha256:image', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 }))
    },
    async saveFileStream() {
      fileSaves += 1
      return { attachmentId: 'sha256:file', name: 'report.pdf', bytes: 4 }
    },
  } as unknown as AttachmentsLike
  const message = await prepareUserMessage(`A ${file.placeholder} B ${image.placeholder} C`, images, {
    ...deps(attachments),
    fileStore: files,
  })
  assert.deepEqual(message.content.map(block => block.type), ['text', 'file', 'text', 'image', 'text'])
  assert.equal(imageSaves, 1)
  assert.equal(fileSaves, 0)
})

test('a file draft without attachment storage fails explicitly', async () => {
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const file = files.add({
    name: 'report.pdf',
    byteLength: 4,
    source: { type: 'recalled', ref: { attachmentId: 'sha256:file', name: 'report.pdf', bytes: 4 } },
  })
  await assert.rejects(
    prepareUserMessage(file.placeholder, images, { ...deps(undefined), fileStore: files }),
    (error: unknown) => error instanceof FileInputError && error.message === 'File attachment storage is unavailable.',
  )
})

