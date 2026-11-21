/**
 * L3 contract tests for the Remote durable-image read capability (M3-5 PR2
 * Step 9, plan §5 Must 20, §6 Must-not 10-12, §13 Images).
 *
 * `createRemotePresentationSource` assembles `attachments.readDurableImage`
 * over the ONE Remote graph. The read must borrow the EXACT retained binding,
 * capture the Connection generation + binding identity, read through that
 * Session's own `readAttachment`, and re-check BOTH before the bytes become a
 * current result. No cold `retain()`, no Host attachment service.
 *
 * S2-PR2: the read carries the COMPLETE durable `ImageAttachmentRef` the
 * transcript/queue holds (never a bare attachment id), so the official Host
 * can re-verify id/mediaType/bytes/width/height and the neutral ref keeps the
 * optional `name`/`originalDimensions` metadata intact.
 * @module @xmoon76/dsh-pi-tui/remote-attachment-read.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { RemoteAttachmentSource, RemoteTransportLifetime } from '../../src/app/application-runtime.ts'
import type { RemoteAttachmentReadResult } from '../../src/app/remote/child-view.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'
import { createRemotePresentationSource } from '../../src/app/remote/presentation-source.ts'
import type { RemoteBackendRuntime } from '../../src/app/remote/runtime.ts'
import type { ExperimentalRemoteRuntime } from '../support/m3-inprocess/runtime.ts'
import type { RemoteSessionReferenceLike } from '../../src/runtime/remote/session-reference.ts'

/** One real durable image reference: exactly the shape a persisted
 * `user/message` image block carries, including the optional metadata that a
 * bare attachment id used to drop. */
const ATTACHMENT: ImageAttachmentRefLike = {
  attachmentId: 'attach-7',
  mediaType: 'image/png',
  bytes: 8,
  width: 64,
  height: 48,
  name: 'photo.png',
  originalDimensions: { width: 128, height: 96 },
}

interface AttachmentBinding {
  readonly session: {
    getSnapshot(): { readonly running: boolean }
    readAttachment(attachment: ImageAttachmentRefLike): Promise<RemoteAttachmentReadResult>
  }
}

interface AttachmentHarness {
  readonly attachments: RemoteAttachmentSource
  /** The capture of the CURRENT transport lifetime (generation + exact binding). */
  lifetime(): RemoteTransportLifetime
  /** The complete references the CURRENT binding's `readAttachment` was asked
   * for — the OBJECT, so a bare id regression fails loudly. */
  readonly reads: ImageAttachmentRefLike[]
  /** Every `sessions.retain` call; a durable image read must never make one. */
  readonly retains: unknown[]
  setBinding(binding: AttachmentBinding | undefined): void
  /** A DISTINCT binding object over the same read behavior (a rollover). */
  newBinding(): AttachmentBinding
  setGeneration(generation: object | undefined): void
}

interface AttachmentHarnessOptions {
  readAttachment?: (attachment: ImageAttachmentRefLike) => Promise<RemoteAttachmentReadResult>
}

/**
 * Build the REAL Remote presentation bundle over a borrow-only sessions face.
 * `retain` throws by construction: the image read is a borrow-only capability,
 * so any retain on this path is a loud failure rather than a silent cold-open.
 */
function attachmentHarness(options: AttachmentHarnessOptions = {}): AttachmentHarness {
  const reads: ImageAttachmentRefLike[] = []
  const retains: unknown[] = []
  const run = options.readAttachment ?? (async (attachment: ImageAttachmentRefLike): Promise<RemoteAttachmentReadResult> => ({
    ok: true,
    value: { attachment, data: new Uint8Array([attachment.bytes]) },
  }))
  const makeBinding = (): AttachmentBinding => ({
    session: {
      getSnapshot: () => ({ running: true }),
      readAttachment: async attachment => {
        reads.push(attachment)
        return await run(attachment)
      },
    },
  })
  let binding: AttachmentBinding | undefined = makeBinding()
  let generation: object | undefined = { id: 'generation-1' }

  const sessions = {
    binding: (id: string): AttachmentBinding | undefined => id === 'session-1' ? binding : undefined,
    retain: (target: unknown, options2: unknown): RemoteSessionReferenceLike => {
      retains.push({ target, options: options2 })
      throw new Error('a durable image read must never cold-retain a Session')
    },
    list: { subscribe: () => () => {} },
  }
  const wire = {
    client: {
      sessions,
      connection: { generation: { getSnapshot: () => generation, subscribe: () => () => {} } },
      jobs: { state: { getSnapshot: () => ({ rows: {} }), subscribe: () => () => {} } },
      remote: {
        commands: { list: async () => ({ ok: true, value: [] }) },
        skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
      },
    },
  } as unknown as ExperimentalRemoteRuntime
  const backendRuntime = {
    semantics: {
      sessionReader: { sessionStatus: () => undefined },
      presentationReader: {
        read: async () => undefined,
        loadOlder: async () => undefined,
        loadThrough: async () => undefined,
      },
    },
  } as unknown as RemoteBackendRuntime

  const source = createRemotePresentationSource(wire.client, backendRuntime)
  return {
    attachments: source.attachments,
    lifetime: () => source.sessionFacts.captureTransportToken('session-1') as RemoteTransportLifetime,
    reads,
    retains,
    setBinding(next) { binding = next },
    newBinding: makeBinding,
    setGeneration(next) { generation = next },
  }
}

test('reads through the EXACT retained binding with the COMPLETE durable ref and no cold retain', async () => {
  const harness = attachmentHarness()
  const result = await harness.attachments.readDurableImage(
    'session-1', ATTACHMENT, harness.lifetime())

  assert.equal(harness.reads.length, 1, 'exactly one official read is made')
  assert.equal(harness.reads[0], ATTACHMENT,
    'the ORIGINAL full reference object reaches the retained Session (never a bare id)')
  assert.deepEqual(harness.retains, [], 'a durable image read never calls sessions.retain')
  assert.equal(result.ref, ATTACHMENT, 'the official verified reference is returned unwrapped')
  assert.deepEqual(result.data, new Uint8Array([ATTACHMENT.bytes]), 'the exact bytes are returned')
})

test('an unwrapped RemoteResult failure rejects (a visible load failure, never empty bytes)', async () => {
  const denied = new Error('attachment denied by the Host')
  const harness = attachmentHarness({ readAttachment: async () => ({ ok: false, error: denied }) })

  await assert.rejects(
    harness.attachments.readDurableImage('session-1', ATTACHMENT, harness.lifetime()),
    error => error === denied,
    'the official failure error is surfaced by identity',
  )
  assert.deepEqual(harness.reads, [ATTACHMENT], 'the full ref is still the only read input')
  assert.deepEqual(harness.retains, [], 'a rejected read still never cold-retains')
})

test('a binding replaced while the read is in flight is refused, not committed as current bytes', async () => {
  let releaseRead!: () => void
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  const harness = attachmentHarness({
    readAttachment: async (attachment) => {
      await gate
      return { ok: true, value: { attachment, data: new Uint8Array([9]) } }
    },
  })

  const pending = harness.attachments.readDurableImage(
    'session-1', ATTACHMENT, harness.lifetime())
  await Promise.resolve()
  assert.deepEqual(harness.reads, [ATTACHMENT], 'the read is in flight against the original binding')
  harness.setBinding(harness.newBinding())
  releaseRead()

  await assert.rejects(pending, /the Session binding for session-1 changed while the attachment was read/)
  assert.deepEqual(harness.retains, [], 'the refused read never cold-retains')
})

test('a Connection generation replacement while the read is in flight is refused', async () => {
  let releaseRead!: () => void
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  const harness = attachmentHarness({ readAttachment: async (attachment) => { await gate; return { ok: true, value: { attachment, data: new Uint8Array([1]) } } } })

  const pending = harness.attachments.readDurableImage(
    'session-1', ATTACHMENT, harness.lifetime())
  await Promise.resolve()
  harness.setGeneration({ id: 'generation-2' })
  releaseRead()

  await assert.rejects(pending, /changed while the attachment was read/)
})

test('an unretained session rejects and never cold-retains one', async () => {
  const harness = attachmentHarness()
  harness.setBinding(undefined)

  await assert.rejects(
    harness.attachments.readDurableImage('session-1', ATTACHMENT, harness.lifetime()),
    /no retained Session binding for session-1/,
  )
  assert.deepEqual(harness.reads, [], 'no binding means no read at all')
  assert.deepEqual(harness.retains, [], 'and no cold retain to manufacture one')
})

test('a missing Connection generation rejects as a not-ready transport, not an empty read', async () => {
  const harness = attachmentHarness()
  harness.setGeneration(undefined)

  await assert.rejects(
    harness.attachments.readDurableImage('session-1', ATTACHMENT, harness.lifetime()),
    /the Remote connection is not ready to read an attachment of session-1/,
  )
  assert.deepEqual(harness.reads, [], 'a disconnected transport reads nothing')
  assert.deepEqual(harness.retains, [], 'and cold-retains nothing')
})

test('a same-binding Connection generation rollover is ADOPTED (a fresh read still succeeds)', async () => {
  // The official RemoteLiveIngress guarantees that a Connection generation
  // rollover does NOT retire the handle: the retained binding is unchanged and the
  // handle adopts the new generation. A presentation captured before the reconnect
  // must therefore still be able to read its images.
  const harness = attachmentHarness()
  const lifetime = harness.lifetime()
  harness.setGeneration({ id: 'generation-2' })

  const result = await harness.attachments.readDurableImage('session-1', ATTACHMENT, lifetime)

  assert.deepEqual(harness.reads, [ATTACHMENT], 'the adopted generation still reads through the same binding')
  assert.deepEqual(result.data, new Uint8Array([ATTACHMENT.bytes]), 'the bytes come back through the adopted binding')
})

test('a DIFFERENT binding retires the captured lifetime and is refused before any Session call', async () => {
  const harness = attachmentHarness()
  const lifetime = harness.lifetime()
  // The presentation's binding is gone (viewer exit / same-id reopen): the
  // successor binding must never be borrowed for it.
  harness.setBinding(harness.newBinding())

  await assert.rejects(
    harness.attachments.readDurableImage('session-1', ATTACHMENT, lifetime),
    /the presentation's Session binding for session-1 is retired/,
  )
  assert.deepEqual(harness.reads, [], 'a retired presentation never touches the successor binding')
  assert.deepEqual(harness.retains, [], 'and never cold-retains one')
})

test('a missing or malformed lifetime is refused before any Session call', async () => {
  const harness = attachmentHarness()
  for (const malformed of [undefined, {}]) {
    await assert.rejects(
      harness.attachments.readDurableImage('session-1', ATTACHMENT, malformed as never),
      /is retired|carries no presentation lifetime/,
      'a read with no usable owning-presentation lifetime must fail closed',
    )
  }
  assert.deepEqual(harness.reads, [], 'no malformed lifetime ever reaches the Session face')
})
