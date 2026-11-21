/**
 * Production Remote prompt serializer coverage (M3-4 PR3 Step 7 + M6 F4, L1):
 * the PreparedPrompt → official PromptContentPart mapping, the two-phase
 * preflight/serialize contract, the official file receipt path, the official
 * imageLimits recheck, and the recalled-durable-image authorized byte read.
 *
 * @module @xmoon76/dsh-pi-tui/remote-prompt-serializer.test
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { preparePrompt, type PreparedImageSource } from '../../src/app/submission/prepared-prompt.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { probeAttachment } from '../../src/client/media/attachment/intake.ts'
import type { RemoteFileReceiptUploader, UploadedPromptFile } from '../../src/runtime/remote/file-upload-remote.ts'
import {
  detachedImageLimits,
  RemotePromptSerializerProduction,
  type RemoteSerializerSessionsSource,
} from '../../src/runtime/remote/prompt-serializer-remote.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const abort = new AbortController().signal

/** A stage-two uploader double that reads the SAME Client-local stream. */
function streamUploader(onUpload: (bytes: Uint8Array) => void, metadata: {
  readonly receiptId: string
  readonly attachmentId: string
  readonly name: string
}): RemoteFileReceiptUploader {
  return {
    async upload(_sessionId, prepared, signal): Promise<UploadedPromptFile> {
      if (prepared.source.kind !== 'client-stream') throw new Error('recalled files must never reach the uploader')
      const chunks: Uint8Array[] = []
      for await (const chunk of prepared.source.open(signal)) chunks.push(chunk)
      const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)))
      onUpload(new Uint8Array(bytes))
      return {
        receiptId: metadata.receiptId,
        file: { attachmentId: metadata.attachmentId, name: metadata.name, bytes: bytes.byteLength },
      }
    },
  }
}

/** A minimal staged-image source for the snapshot builder. */
function stagedImage(overrides: Partial<PreparedImageSource> = {}): PreparedImageSource {
  return {
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png',
    width: 2,
    height: 2,
    byteLength: 3,
    placeholder: '[image #1 (2×2)]',
    ...overrides,
  }
}

/** A stand-in image store handing the snapshot builder exact drafts. */
function storeOf(images: readonly PreparedImageSource[]): { values(): readonly PreparedImageSource[] } {
  return { values: () => images }
}

function textOf(content: readonly unknown[]): string {
  return JSON.stringify(content)
}

test('plain text preflights supported with the canonical text and zero attachments', async () => {
  const serializer = new RemotePromptSerializerProduction()
  const prompt = preparePrompt('session-a', 'plain hello', { images: storeOf([]) }, 'req-1')
  const preflight = serializer.preflight(prompt)
  assert.equal(preflight.kind, 'ok')
  assert.ok(preflight.kind === 'ok')
  assert.equal(preflight.echo.text, 'plain hello')
  assert.deepEqual(preflight.echo.attachments, [])
  assert.equal(preflight.needsFileUploads, false, 'a text-only prompt takes the established no-upload path')
  const serialized = await serializer.serialize(prompt, abort)
  assert.ok(serialized.kind === 'ok')
  assert.deepEqual(serialized.content, [{ type: 'text', text: 'plain hello' }])
  assert.deepEqual(serialized.echo, { text: 'plain hello', attachments: [] })
  assert.equal(textOf(serialized.content).includes('req-1'), false,
    'the wire content never carries the local echo correlation id')
})

test('a fresh staged image serializes its OWN bytes as an official image part', async () => {
  const serializer = new RemotePromptSerializerProduction()
  const image = stagedImage({ name: 'shot.png', bytes: new Uint8Array([10, 20, 30, 40]), byteLength: 4 })
  const prompt = preparePrompt(
    'session-a',
    'look [image #1 (2×2)] now',
    { images: storeOf([image]) },
  )
  const preflight = serializer.preflight(prompt)
  assert.ok(preflight.kind === 'ok', JSON.stringify(preflight))
  assert.ok(preflight.kind === 'ok')
  assert.equal(preflight.echo.attachments.length, 1)
  const serialized = await serializer.serialize(prompt, abort)
  assert.ok(serialized.kind === 'ok')
  assert.ok(serialized.kind === 'ok')
  const imagePart = serialized.content.find(part => (part as { type: string }).type === 'image') as
    { type: 'image'; mediaType: string; data: string; name?: string }
  assert.equal(imagePart.mediaType, 'image/png')
  assert.equal(imagePart.name, 'shot.png')
  assert.equal(imagePart.data, Buffer.from(new Uint8Array([10, 20, 30, 40])).toString('base64'))
})

test('mixed text/file/image ordering and whitespace survive two file receipts in place', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-f4-mixed-')
  const files = new DraftFileStore()
  const drafts = [] as ReturnType<DraftFileStore['add']>[]
  for (const [name, seed] of [['a.bin', 1], ['b.bin', 2]] as const) {
    const path = join(root, name)
    writeFileSync(path, Buffer.from([seed, seed + 1, seed + 2]))
    const probe = await probeAttachment(path, root)
    assert.equal(probe.kind, 'file')
    if (probe.kind !== 'file') return
    drafts.push(files.add({
      name: probe.name,
      byteLength: probe.byteLength,
      source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
    }))
  }
  const receipts: string[] = []
  const serializer = new RemotePromptSerializerProduction(undefined, {
    async upload(_sessionId, prepared) {
      receipts.push(prepared.name)
      return {
        receiptId: `receipt-${prepared.name}`,
        file: { attachmentId: `file-${prepared.name}`, name: prepared.name, bytes: prepared.byteLength },
      }
    },
  })
  const text = ` lead ${drafts[0]!.placeholder} mid [image #1 (2×2)] ${drafts[1]!.placeholder} tail `
  const prompt = preparePrompt('session-a', text, {
    images: storeOf([stagedImage({ name: 'inline.png' })]),
    files,
  })
  const serialized = await serializer.serialize(prompt, abort)
  assert.ok(serialized.kind === 'ok', JSON.stringify(serialized))
  assert.deepEqual(serialized.content.map(part => part.type),
    ['text', 'file', 'text', 'image', 'text', 'file', 'text'],
    'the frozen segment order is preserved across two uploads and one image')
  assert.deepEqual(receipts, ['a.bin', 'b.bin'], 'each file occurrence uploads in prompt order')
  assert.equal((serialized.content[0] as { text: string }).text, ' lead ')
  assert.equal((serialized.content[2] as { text: string }).text, ' mid ')
  assert.equal((serialized.content[4] as { text: string }).text, ' ')
  assert.equal((serialized.content[6] as { text: string }).text, ' tail ')
  assert.equal((serialized.content[1] as { receiptId: string }).receiptId, 'receipt-a.bin')
  assert.equal((serialized.content[5] as { receiptId: string }).receiptId, 'receipt-b.bin')
  assert.deepEqual(serialized.echo.attachments.map(attachment => attachment.type), ['file', 'image', 'file'],
    'echo attachments follow the source attachment order, using Host-issued file metadata')
  assert.equal(serialized.echo.text, ' lead  mid   tail ',
    'file placeholders are never part of the model-facing text')
})

test('a repeated file placeholder uploads once per occurrence, in order', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-f4-repeat-')
  const path = join(root, 'repeat.bin')
  writeFileSync(path, Buffer.from([9, 8, 7]))
  const probe = await probeAttachment(path, root)
  assert.equal(probe.kind, 'file')
  if (probe.kind !== 'file') return
  const files = new DraftFileStore()
  const draft = files.add({
    name: probe.name,
    byteLength: probe.byteLength,
    source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
  })
  const receipts: string[] = []
  const serializer = new RemotePromptSerializerProduction(undefined, {
    async upload(_sessionId, prepared) {
      receipts.push(prepared.name)
      const id = `receipt-${receipts.length}`
      return { receiptId: id, file: { attachmentId: `file-${receipts.length}`, name: prepared.name, bytes: 3 } }
    },
  })
  const prompt = preparePrompt('session-a', `${draft.placeholder} and ${draft.placeholder}`, {
    images: storeOf([]),
    files,
  })
  const serialized = await serializer.serialize(prompt, abort)
  assert.ok(serialized.kind === 'ok')
  assert.deepEqual(receipts, ['repeat.bin', 'repeat.bin'], 'each occurrence uploads its own receipt')
  assert.deepEqual(serialized.content.map(part => part.type), ['file', 'text', 'file'])
  assert.equal((serialized.content[0] as { receiptId: string }).receiptId, 'receipt-1')
  assert.equal((serialized.content[2] as { receiptId: string }).receiptId, 'receipt-2')
})

test('an attachment-only file prompt has no model-facing text but keeps its receipt part', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-f4-only-')
  const path = join(root, 'only.bin')
  writeFileSync(path, Buffer.from([1]))
  const probe = await probeAttachment(path, root)
  assert.equal(probe.kind, 'file')
  if (probe.kind !== 'file') return
  const files = new DraftFileStore()
  const draft = files.add({
    name: probe.name,
    byteLength: probe.byteLength,
    source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
  })
  const serializer = new RemotePromptSerializerProduction(undefined, {
    async upload() {
      return { receiptId: 'only-receipt', file: { attachmentId: 'only-file', name: 'only.bin', bytes: 1 } }
    },
  })
  const prompt = preparePrompt('session-a', draft.placeholder, { images: storeOf([]), files })
  const serialized = await serializer.serialize(prompt, abort)
  assert.ok(serialized.kind === 'ok')
  assert.deepEqual(serialized.content, [{ type: 'file', receiptId: 'only-receipt' }],
    'the attachment-only prompt is exactly one file part')
  assert.equal(serialized.echo.text, '', 'no placeholder text is fabricated into the model-facing text')
})

test('a text-only prompt never touches the file upload boundary', async () => {
  let uploads = 0
  const serializer = new RemotePromptSerializerProduction(undefined, {
    async upload() {
      uploads += 1
      throw new Error('a text-only prompt must not upload')
    },
  })
  const prompt = preparePrompt('session-a', 'plain only', { images: storeOf([]) })
  const serialized = await serializer.serialize(prompt, abort)
  assert.ok(serialized.kind === 'ok')
  assert.deepEqual(serialized.content, [{ type: 'text', text: 'plain only' }])
  assert.equal(uploads, 0)
})

test('a fresh generic file uploads its exact Client bytes and maps the Host receipt into ordered prompt parts', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-f4-serializer-')
  const path = join(root, 'report.bin')
  const source = Buffer.from('F4_SERIALIZER_BYTES_20261111')
  writeFileSync(path, source)
  const probe = await probeAttachment(path, root)
  assert.equal(probe.kind, 'file')
  if (probe.kind !== 'file') return
  const files = new DraftFileStore()
  const draft = files.add({
    name: probe.name,
    byteLength: probe.byteLength,
    source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
  })
  const uploaded: Uint8Array[] = []
  const serializer = new RemotePromptSerializerProduction(undefined, streamUploader(
    bytes => uploaded.push(bytes),
    { receiptId: 'host-receipt-f4', attachmentId: 'host-file-f4', name: 'report.bin' },
  ))
  const prompt = preparePrompt('session-a', `before ${draft.placeholder} after`, {
    images: storeOf([]),
    files,
  })
  const preflight = serializer.preflight(prompt)
  assert.ok(preflight.kind === 'ok', JSON.stringify(preflight))
  assert.equal(preflight.needsFileUploads, true, 'the presence of a file derives the upload branch')
  const serialized = await serializer.serialize(prompt, abort)
  assert.ok(serialized.kind === 'ok', JSON.stringify(serialized))
  assert.deepEqual(serialized.content, [
    { type: 'text', text: 'before ' },
    { type: 'file', receiptId: 'host-receipt-f4' },
    { type: 'text', text: ' after' },
  ], 'text whitespace and the original segment order survive the file receipt mapping')
  assert.deepEqual(Buffer.from(uploaded[0]!).toString('hex'), source.toString('hex'),
    'the uploaded stream is the fixed Client-local file version')
  assert.deepEqual(serialized.echo, {
    text: 'before  after',
    attachments: [{ type: 'file', value: { attachmentId: 'host-file-f4', name: 'report.bin', bytes: source.byteLength } }],
  }, 'the echo cites only the Host-issued metadata, never a local name/size guess')
  assert.equal(JSON.stringify(serialized.content).includes(path), false,
    'the Client-local path never reaches the wire content')
})

test('a recalled durable generic file is refused before any upload or echo', async () => {
  let uploads = 0
  const serializer = new RemotePromptSerializerProduction(undefined, {
    async upload() {
      uploads += 1
      throw new Error('a recalled file must never be uploaded')
    },
  })
  const files = new DraftFileStore()
  const recalled = files.add({
    name: 'old.bin',
    byteLength: 3,
    source: { type: 'recalled', ref: { attachmentId: 'sha256:old', name: 'old.bin', bytes: 3 } },
  })
  const prompt = preparePrompt('session-a', `resend ${recalled.placeholder}`, { images: storeOf([]), files })
  const preflight = serializer.preflight(prompt)
  assert.equal(preflight.kind, 'unsupported')
  assert.ok(preflight.kind === 'unsupported')
  assert.match(preflight.reason, /stored files cannot be re-uploaded/i)
  const serialized = await serializer.serialize(prompt, abort)
  assert.equal(serialized.kind, 'unsupported')
  assert.equal(uploads, 0, 'no Host upload is attempted for a recalled file')
})

test('the official imageLimits projection is re-applied at preflight (count and aggregate)', () => {
  const limits = { maxImagesPerMessage: 1, maxMessageImageBytes: 8 }
  const sessions: RemoteSerializerSessionsSource = {
    binding: () => ({
      session: {
        readAttachment: async () => { throw new Error('not used') },
        projections: { faceOf: (key: string) => ({ getSnapshot: () => key === 'imageLimits' ? limits : undefined }) },
      },
    }),
  }
  const serializer = RemotePromptSerializerProduction.overSessions(sessions)
  const twoImages = preparePrompt('session-a', 'a [image #1 (2×2)] b [image #2 (2×2)]', {
    images: storeOf([stagedImage(), stagedImage({ placeholder: '[image #2 (2×2)]' })]),
  })
  const byCount = serializer.preflight(twoImages)
  assert.equal(byCount.kind, 'unsupported')
  assert.ok(byCount.kind === 'unsupported')
  assert.match(byCount.reason, /too many images: 2/)

  const bigBytes = new Uint8Array(16)
  const oversized = preparePrompt('session-a', '[image #1 (2×2)]', {
    images: storeOf([stagedImage({ bytes: bigBytes, byteLength: 16 })]),
  })
  const byBytes = serializer.preflight(oversized)
  assert.equal(byBytes.kind, 'unsupported')
  assert.ok(byBytes.kind === 'unsupported')
  assert.match(byBytes.reason, /aggregate limit/)
})

test('a recalled durable image reads its authorized bytes through the official attachment read — never cites the ref', async () => {
  const durableBytes = new Uint8Array([99, 98, 97])
  const recalledRef = {
    attachmentId: 'att-42',
    mediaType: 'image/png' as const,
    bytes: 3,
    width: 2,
    height: 2,
    name: 'durable.png',
    originalDimensions: { width: 4, height: 4 },
  }
  let readCalls = 0
  const sessions: RemoteSerializerSessionsSource = {
    binding: sessionId => ({
      session: {
        readAttachment: async (attachment) => {
          readCalls += 1
          assert.equal(sessionId, 'session-a', 'the read addresses the PreparedPrompt session')
          assert.equal(attachment, recalledRef,
            'the recalled draft’s ORIGINAL complete reference reaches the official read')
          return { ok: true as const, value: { data: durableBytes } }
        },
        projections: { faceOf: () => ({ getSnapshot: () => undefined }) },
      },
    }),
  }
  const serializer = RemotePromptSerializerProduction.overSessions(sessions)
  const recalled = stagedImage({
    bytes: new Uint8Array(0),
    byteLength: 0,
    name: 'durable.png',
    recalledRef,
  })
  const prompt = preparePrompt('session-a', 'resend [image #1 (2×2)]', { images: storeOf([recalled]) })
  const preflight = serializer.preflight(prompt)
  assert.ok(preflight.kind === 'ok', JSON.stringify(preflight))
  const serialized = await serializer.serialize(prompt, abort)
  assert.ok(serialized.kind === 'ok')
  assert.equal(readCalls, 1)
  const imagePart = serialized.content.find(part => (part as { type: string }).type === 'image') as
    { type: 'image'; mediaType: string; data: string; name?: string }
  assert.equal(imagePart.mediaType, 'image/png')
  assert.equal(imagePart.name, 'durable.png')
  assert.equal(imagePart.data, Buffer.from(durableBytes).toString('base64'),
    'the part carries the authorized bytes, not the Host-private reference')
  assert.equal(JSON.stringify(serialized.content).includes('att-42'), false,
    'the wire content never cites the durable reference id')
})

test('a failed authorized read fails the serialization with the read reason', async () => {
  const sessions: RemoteSerializerSessionsSource = {
    binding: () => ({
      session: {
        readAttachment: async () => ({ ok: false as const, error: new Error('attachment unavailable') }),
        projections: { faceOf: () => ({ getSnapshot: () => undefined }) },
      },
    }),
  }
  const serializer = RemotePromptSerializerProduction.overSessions(sessions)
  const recalled = stagedImage({
    bytes: new Uint8Array(0),
    recalledRef: { attachmentId: 'att-x', mediaType: 'image/png', bytes: 3, width: 2, height: 2 },
  })
  const prompt = preparePrompt('session-a', '[image #1 (2×2)]', { images: storeOf([recalled]) })
  const serialized = await serializer.serialize(prompt, abort)
  assert.equal(serialized.kind, 'unsupported')
  assert.ok(serialized.kind === 'unsupported')
  assert.match(serialized.reason, /could not be read/)
})

test('detachedImageLimits narrows only well-formed projection values', () => {
  assert.deepEqual(detachedImageLimits({ maxImagesPerMessage: 3, maxMessageImageBytes: 100 }), { maxImagesPerMessage: 3, maxMessageImageBytes: 100 })
  assert.equal(detachedImageLimits(undefined), undefined)
  assert.equal(detachedImageLimits(null), undefined)
  assert.equal(detachedImageLimits({ maxImagesPerMessage: 'x' }), undefined)
  assert.equal(detachedImageLimits({ maxImagesPerMessage: 1 }), undefined)
})

test('an image with neither local bytes nor a durable reference is refused in preflight', () => {
  const serializer = new RemotePromptSerializerProduction()
  const phantom = stagedImage({ bytes: new Uint8Array(0), byteLength: 0 })
  const prompt = preparePrompt('session-a', '[image #1 (2×2)]', { images: storeOf([phantom]) })
  const preflight = serializer.preflight(prompt)
  assert.equal(preflight.kind, 'unsupported')
})
