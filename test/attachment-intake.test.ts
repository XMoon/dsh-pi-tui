import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { DraftFileStore } from '../src/attachment/file-draft.ts'
import { admitDraftFiles, FILE_STREAM_CHUNK_BYTES } from '../src/attachment/file-admission.ts'
import { FileInputError, probeAttachment } from '../src/attachment/intake.ts'
import { expandAttachmentPlaceholders } from '../src/attachment/placeholder.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'

const execFileAsync = promisify(execFile)

test('probeAttachment classifies generic files from metadata and a bounded prefix', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-attachment-')
  const path = join(root, 'report.pdf')
  await writeFile(path, Buffer.from('%PDF-1.7\nbody'))
  const result = await probeAttachment('./report.pdf', root)
  assert.equal(result.kind, 'file')
  if (result.kind === 'file') {
    assert.equal(result.name, 'report.pdf')
    assert.equal(result.byteLength, 13)
    assert.equal(result.path, path)
    assert.equal(result.fingerprint.size, 13n)
  }
})

test('a supported raster signature stays on the image path', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-attachment-')
  const path = join(root, 'broken.png')
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  const result = await probeAttachment('broken.png', root)
  assert.deepEqual(result, { kind: 'image', path, mediaType: 'image/png' })
})

test('probeAttachment rejects a FIFO without opening a blocking reader', async (t) => {
  if (process.platform === 'win32') {
    t.skip('mkfifo is POSIX-only')
    return
  }
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-attachment-')
  const path = join(root, 'pipe')
  await execFileAsync('mkfifo', [path])
  await assert.rejects(
    probeAttachment(path, root),
    (error: unknown) => error instanceof FileInputError && error.message === 'Not a regular file: pipe',
  )
})

test('generic drafts use exact mixed placeholders without retaining file bytes', () => {
  const images = new DraftImageStore()
  const image = images.add({
    bytes: new Uint8Array([1]),
    mediaType: 'image/png',
    width: 1,
    height: 1,
  })
  const files = new DraftFileStore()
  const file = files.add({
    name: 'a @ private report.pdf',
    byteLength: 12_345,
    source: {
      type: 'path',
      path: '/tmp/report.pdf',
      fingerprint: { dev: 1n, ino: 2n, size: 12_345n, mtimeNs: 3n },
    },
  })
  assert.equal(file.placeholder, '[file #1 (12.1 KiB)]')
  assert.equal('bytes' in file, false)
  const segments = expandAttachmentPlaceholders(`left ${file.placeholder} ${image.placeholder} right`, images, files)
  assert.deepEqual(segments.map(segment => segment.type), ['text', 'file', 'text', 'image', 'text'])
  const stale = expandAttachmentPlaceholders(`[file #1 (99 B)]`, images, files)
  assert.deepEqual(stale, [{ type: 'text', text: '[file #1 (99 B)]' }])
})

test('generic admission streams bounded chunks and reuses recalled refs', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-attachment-')
  const path = join(root, 'large.bin')
  const source = Buffer.alloc(FILE_STREAM_CHUNK_BYTES * 2 + 17, 7)
  await writeFile(path, source)
  const files = new DraftFileStore()
  const probe = await probeAttachment(path, root)
  assert.equal(probe.kind, 'file')
  if (probe.kind !== 'file') return
  const draft = files.add({
    name: probe.name,
    byteLength: probe.byteLength,
    source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
  })
  const chunks: Uint8Array[] = []
  const refs = await admitDraftFiles([draft], {
    saveFileStream: async ({ data }) => {
      for await (const chunk of data) {
        assert.ok(chunk.byteLength <= FILE_STREAM_CHUNK_BYTES)
        chunks.push(chunk)
      }
      return { attachmentId: 'sha256:test', name: draft.name, bytes: source.byteLength }
    },
  })
  assert.equal(refs[0]?.bytes, source.byteLength)
  assert.deepEqual(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))), source)

  const recalled = files.add({
    name: 'old.bin',
    byteLength: 3,
    source: { type: 'recalled', ref: { attachmentId: 'sha256:old', name: 'old.bin', bytes: 3 } },
  })
  let saves = 0
  const recalledRefs = await admitDraftFiles([recalled], {
    saveFileStream: async () => {
      saves += 1
      return { attachmentId: 'unexpected', name: 'old.bin', bytes: 3 }
    },
  })
  assert.equal(saves, 0)
  assert.deepEqual(recalledRefs[0], { attachmentId: 'sha256:old', name: 'old.bin', bytes: 3 })
})

test('file mutation before or during streaming rejects and never completes admission', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-attachment-')
  const path = join(root, 'mutable.bin')
  await writeFile(path, Buffer.alloc(FILE_STREAM_CHUNK_BYTES * 2, 1))
  const probe = await probeAttachment(path, root)
  assert.equal(probe.kind, 'file')
  if (probe.kind !== 'file') return
  const files = new DraftFileStore()
  const draft = files.add({
    name: probe.name,
    byteLength: probe.byteLength,
    source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
  })
  await writeFile(path, Buffer.alloc(3, 2))
  await assert.rejects(
    admitDraftFiles([draft], { saveFileStream: async ({ data }) => {
      for await (const _chunk of data) { /* consume */ }
      return { attachmentId: 'sha256:changed', name: draft.name, bytes: 3 }
    } }),
    (error: unknown) => error instanceof FileInputError && error.message.includes('changed since it was attached'),
  )

  await writeFile(path, Buffer.alloc(FILE_STREAM_CHUNK_BYTES * 2, 1))
  const secondProbe = await probeAttachment(path, root)
  assert.equal(secondProbe.kind, 'file')
  if (secondProbe.kind !== 'file') return
  const second = files.add({
    name: secondProbe.name,
    byteLength: secondProbe.byteLength,
    source: { type: 'path', path: secondProbe.path, fingerprint: secondProbe.fingerprint },
  })
  await assert.rejects(
    admitDraftFiles([second], { saveFileStream: async ({ data }) => {
      let first = true
      for await (const _chunk of data) {
        if (first) {
          first = false
          await truncate(path, 1)
        }
      }
      return { attachmentId: 'sha256:changed', name: second.name, bytes: 1 }
    } }),
    (error: unknown) => error instanceof FileInputError && error.message.includes('changed since it was attached'),
  )
})

test('stream admission rejects a path replaced with a FIFO before opening it', async (t) => {
  if (process.platform === 'win32') {
    t.skip('mkfifo is POSIX-only')
    return
  }
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-attachment-')
  const path = join(root, 'mutable.bin')
  await writeFile(path, Buffer.from('original'))
  const probe = await probeAttachment(path, root)
  assert.equal(probe.kind, 'file')
  if (probe.kind !== 'file') return
  const files = new DraftFileStore()
  const draft = files.add({
    name: probe.name,
    byteLength: probe.byteLength,
    source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
  })
  await rm(path)
  await execFileAsync('mkfifo', [path])
  await assert.rejects(
    admitDraftFiles([draft], {
      saveFileStream: async ({ data }) => {
        for await (const _chunk of data) { /* consume */ }
        return { attachmentId: 'sha256:unexpected', name: draft.name, bytes: draft.byteLength }
      },
    }),
    (error: unknown) => error instanceof FileInputError && error.message.includes('changed since it was attached'),
  )
})

test('a sparse generic file larger than the image resident cap is admitted as metadata', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-attachment-')
  const path = join(root, 'sparse.tar')
  const size = 64 * 1024 * 1024 + 1
  await writeFile(path, new Uint8Array())
  await truncate(path, size)
  const result = await probeAttachment(path, root)
  assert.equal(result.kind, 'file')
  if (result.kind === 'file') assert.equal(result.byteLength, size)
})
