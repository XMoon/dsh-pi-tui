/**
 * Production Remote prompt serializer coverage (M3-4 PR3 Step 7, L1):
 * the PreparedPrompt → official PromptContentPart mapping, the two-phase
 * preflight/serialize contract, the generic-file fail-closed gate, the
 * official imageLimits recheck, and the recalled-durable-image authorized
 * byte read.
 *
 * @module @xmoon76/dsh-pi-tui/remote-prompt-serializer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { preparePrompt, type PreparedImageSource } from '../src/app/submission/prepared-prompt.ts'
import {
  detachedImageLimits,
  RemotePromptSerializerProduction,
  type RemoteSerializerSessionsSource,
} from '../src/runtime/remote/prompt-serializer-remote.ts'

const abort = new AbortController().signal

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
  const serialized = await serializer.serialize(prompt, abort)
  assert.ok(serialized.kind === 'ok')
  assert.ok(serialized.kind === 'ok')
  assert.deepEqual(serialized.content, [{ type: 'text', text: 'plain hello' }])
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

test('a generic-file placeholder fails closed in preflight: zero beginSubmission, zero prompt parts', async () => {
  const serializer = new RemotePromptSerializerProduction()
  const prompt = preparePrompt('session-a', 'doc [file #1]', {
    images: storeOf([]),
    files: { values: () => [{ id: 1, kind: 'file', name: 'doc', byteLength: 5, placeholder: '[file #1]' }] as never },
  })
  const preflight = serializer.preflight(prompt)
  assert.equal(preflight.kind, 'unsupported')
  assert.ok(preflight.kind === 'unsupported')
  assert.match(preflight.reason, /generic file/i)
  const serialized = await serializer.serialize(prompt, abort)
  assert.equal(serialized.kind, 'unsupported')
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
  let readCalls = 0
  const sessions: RemoteSerializerSessionsSource = {
    binding: sessionId => ({
      session: {
        readAttachment: async (attachmentId: never) => {
          readCalls += 1
          assert.equal(sessionId, 'session-a', 'the read addresses the PreparedPrompt session')
          assert.equal(String(attachmentId), 'att-42')
          return { ok: true as const, value: { data: durableBytes } }
        },
        projections: { faceOf: () => ({ getSnapshot: () => undefined }) },
      },
    }),
  }
  const serializer = RemotePromptSerializerProduction.overSessions(sessions)
  const recalled = stagedImage({
    bytes: new Uint8Array(0),
    recalledRef: { attachmentId: 'att-42', mediaType: 'image/png', bytes: 3, width: 2, height: 2 },
  })
  const prompt = preparePrompt('session-a', 'resend [image #1 (2×2)]', { images: storeOf([recalled]) })
  const preflight = serializer.preflight(prompt)
  assert.ok(preflight.kind === 'ok', JSON.stringify(preflight))
  const serialized = await serializer.serialize(prompt, abort)
  assert.ok(serialized.kind === 'ok')
  assert.equal(readCalls, 1)
  const imagePart = serialized.content.find(part => (part as { type: string }).type === 'image') as
    { type: 'image'; data: string }
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
