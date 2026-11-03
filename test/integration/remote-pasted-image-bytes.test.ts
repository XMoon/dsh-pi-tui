/**
 * Cross-owner proof for a terminal pasted image path: the Client-local intake
 * stages the file's REAL bytes in the existing draft store, and BOTH transport
 * preparations consume those bytes — never the pasted absolute path string.
 *
 * The Remote half runs the production serializer used by the Remote prompt
 * route; the Direct half runs the production Direct message preparation. The
 * file itself is read from the test's own isolated Client directory.
 * @module @xmoon76/dsh-pi-tui/remote-pasted-image-bytes.test
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { afterEach } from 'node:test'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { setImageReadForTest } from '../../src/client/media/image/intake.ts'
import { createPastedImageIntakeOwner } from '../../src/app/surface/pasted-image-intake.ts'
import type { SubmissionComposerPort } from '../../src/app/submission/composer-port.ts'
import { prepareUserMessage } from '../../src/app/submission/direct-message-preparation.ts'
import { preparePrompt } from '../../src/app/submission/prepared-prompt.ts'
import { RemotePromptSerializerProduction } from '../../src/runtime/remote/prompt-serializer-remote.ts'
import { PasteRangeTracker, pastedBodySpan } from '../../src/tui/interaction/pasted-path-range.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

afterEach(() => { setImageReadForTest(undefined) })

const abort = new AbortController().signal

function pngBytes(width = 64, height = 48): Uint8Array {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const set32 = (offset: number, value: number): void => {
    bytes[offset] = (value >>> 24) & 0xff
    bytes[offset + 1] = (value >>> 16) & 0xff
    bytes[offset + 2] = (value >>> 8) & 0xff
    bytes[offset + 3] = value & 0xff
  }
  set32(16, width)
  set32(20, height)
  return bytes
}

/** A composer port over one text buffer. */
class Composer implements SubmissionComposerPort {
  text = ''
  getDraft(): string { return this.text }
  setDraft(text: string): void { this.text = text }
  setEditorText(text: string): void { this.text = text }
  insertIntoEditor(text: string): void { this.text += text }
  notify(): void {}
  setSubmitPending(): void {}
  clearSettledLocalMessages(): void {}
}

/** Run ONE real pasted-image intake and return the live draft store. */
async function stagedPaste(t: Parameters<typeof testLifecycle>[0]): Promise<{
  readonly images: DraftImageStore
  readonly text: string
  readonly placeholder: string
}> {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pasted-image-transport-')
  const path = join(root, 'shot.png')
  const bytes = pngBytes()
  writeFileSync(path, bytes)
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const composer = new Composer()
  const tracker = new PasteRangeTracker()
  composer.text = `${path} `
  tracker.applyEdit({ start: 0, oldEnd: 0, newEnd: composer.text.length }, composer.text)
  const span = pastedBodySpan('', 0, composer.text, composer.text.length, `${path} `)
  assert.ok(span !== undefined)
  const id = tracker.add(span)
  assert.ok(id !== undefined)
  const owner = createPastedImageIntakeOwner({
    drafts: { images, files },
    composer: () => composer,
    clientCwd: () => root,
    imageLimits: () => undefined,
    lifecycle: {
      generation: () => 1,
      currentSessionId: () => 'session-a',
      isCleanedUp: () => false,
      runOwned: (_label, task, options) => {
        void task().catch((error: unknown) => { options.onError(error) })
      },
    },
  })
  owner.accept({
    text: `${path} `,
    seatCurrent: () => true,
    hasLivePath: (expected) => tracker.live(id)?.expected === expected,
    replacePastedPath: (expected, placeholder) => {
      const live = tracker.live(id)
      if (live === undefined || live.expected !== expected) return false
      const next = composer.text.slice(0, live.start) + placeholder + composer.text.slice(live.end)
      tracker.applyEdit({ start: live.start, oldEnd: live.end, newEnd: live.start + placeholder.length }, next)
      tracker.retire(id)
      composer.text = next
      return true
    },
  })
  for (let attempt = 0; attempt < 200 && images.size() === 0; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 2))
  }
  assert.equal(images.size(), 1, 'the real intake staged the file')
  const staged = images.values()[0]!
  assert.deepEqual([...staged.bytes], [...bytes], 'the store holds the REAL file bytes')
  return { images, text: composer.text, placeholder: staged.placeholder }
}

test('the Remote serializer uploads the pasted file BYTES, never the Client path string', async (t) => {
  const { images, text, placeholder } = await stagedPaste(t)
  const serializer = new RemotePromptSerializerProduction()
  const prompt = preparePrompt('session-a', text, { images }, 'req-pasted')
  const preflight = serializer.preflight(prompt)
  assert.ok(preflight.kind === 'ok', JSON.stringify(preflight))
  const serialized = await serializer.serialize(prompt, abort)
  assert.ok(serialized.kind === 'ok')
  const imagePart = serialized.content.find(part => (part as { type: string }).type === 'image') as
    { type: 'image'; mediaType: string; data: string; name?: string }
  assert.equal(imagePart.mediaType, 'image/png')
  assert.equal(imagePart.data, Buffer.from(pngBytes()).toString('base64'),
    'the official image part carries the file bytes')
  assert.equal(JSON.stringify(serialized.content).includes('/shot.png'), false,
    'the Client-local absolute path never reaches the wire content')
  assert.ok(text.startsWith(placeholder), 'the submitted text carries the canonical token')
})

test('the Direct preparation uploads the pasted file BYTES through the same draft', async (t) => {
  const { images, text } = await stagedPaste(t)
  let saved: readonly Uint8Array[] = []
  const message = await prepareUserMessage(text, images, {
    attachments: {
      imageLimits: {
        maxImageBytes: 20 * 1024 * 1024,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 200 * 1024 * 1024,
        maxImagePixels: 64_000_000,
        maxImageDimension: 8192,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      },
      async saveImages(inputs) {
        saved = inputs.map(input => input.data)
        return inputs.map((input, index) => ({
          attachmentId: `att-${index + 1}`,
          mediaType: input.mediaType,
          bytes: input.data.byteLength,
          width: 64,
          height: 48,
          name: input.name,
        }))
      },
    },
    llm: { async resolveModelInfo() { return { inputModalities: ['text', 'image'] } } } as never,
    currentModel: () => ({ provider: 'provider', model: 'model' }),
    canonicalizeMentions: async (draft) => draft,
  })
  assert.equal(saved.length, 1)
  assert.deepEqual([...saved[0]!], [...pngBytes()], 'the Direct admission received the REAL file bytes')
  assert.ok(message.content.some(block => block.type === 'image'), 'the draft image becomes a real block')
  assert.equal(JSON.stringify(message.content).includes('/shot.png'), false,
    'the Client-local absolute path never reaches the Direct message')
})
