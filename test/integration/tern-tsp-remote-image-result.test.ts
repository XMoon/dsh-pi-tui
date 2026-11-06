/**
 * The Remote positive authorization proof for a tool-result image: a genuine
 * Host attachment enters a real tool/result log, the retained official Client
 * Session binding authorizes the production Remote read, and the official Tern
 * SDK sends its bytes as a blob referenced by a native image frame.
 *
 * The model and terminal are scripted boundaries; the Host store, Remote
 * binding/read, ImageLoader, renderer and `@stencil-hq/tern` SDK are production.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountRemotePresentationHost, mountRemoteRunner } from '../app/runner-remote-presentation.test.ts'
import { waitFor } from '../support/remote-application-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { readTspBlobMessages } from '../support/tsp-blob-wire.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'

const SESSION_ID = 'prc-remote-image-session'

async function realPng(): Promise<Uint8Array> {
  const require = createRequire(import.meta.url)
  const storeDir = dirname(require.resolve('@deepseek-ai/dsh-attachment-local/package.json'))
  const sharp = require(require.resolve('sharp', { paths: [storeDir] })) as (
    input: unknown,
  ) => { png(): { toBuffer(): Promise<Buffer> } }
  return new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 3, background: '#c0ffee' } }).png().toBuffer())
}

interface AttachmentStore {
  saveImages(inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]): Promise<readonly ImageAttachmentRefLike[]>
  readImage(ref: ImageAttachmentRefLike, signal?: AbortSignal): Promise<{ readonly ref: ImageAttachmentRefLike; readonly data: Uint8Array }>
}
interface HostSession {
  append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  snapshotEvents(): readonly unknown[]
}

function drewImage(wire: string, blobId: string): boolean {
  const imageIds = new Set<string>()
  const walk = (node: { k?: string; id?: string; c?: unknown[] } | undefined): void => {
    if (node === undefined) return
    if (node.k === 'image' && typeof node.id === 'string') imageIds.add(node.id)
    for (const child of node.c ?? []) walk(child as never)
  }
  for (const match of wire.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    const frame = JSON.parse(match[1]!) as { ops: unknown[][] }
    for (const op of frame.ops) {
      if (op[0] === 'add') walk(op[4] as never)
      if (op[0] === 'set' && imageIds.has(op[1] as string)
        && (op[2] as { blob?: string }).blob === blobId) return true
    }
  }
  return false
}

test('a Remote lifetime that retires while the read is open refuses the bytes, and the TSP sends no blob for them', async t => {
  const life = testLifecycle(t)
  const host = await mountRemotePresentationHost(life, 'prc-remote-image-preset')
  await host.harness.create(SessionId(SESSION_ID), { provider: 'smoke', model: 'smoke' } as never, { cwd: host.anchorDir })
  const session = host.ctx.sessions.get(SessionId(SESSION_ID)) as unknown as HostSession
  const fixture = await mountRemoteRunner(life, {
    presetId: 'prc-remote-image-preset', resumeSessionId: SESSION_ID, host,
    renderer: 'tsp', nativeImages: true,
  })
  try {
    const pane = fixture.pane
    assert.ok(pane, 'the remote runner uses the scripted TSP pane')
    const attachments = host.ctx.get('attachments') as unknown as AttachmentStore
    const png = await realPng()
    const image = (await attachments.saveImages([{ data: png, mediaType: 'image/png', name: 'shot.png' }]))[0]!
    const expectedBlobId = createHash('sha256').update(png).digest('hex')

    // The REAL retained binding's read is gated, so the lifetime can retire
    // WHILE the read is open. The gate is a test-side seam on the client's
    // read method: the read itself still traverses the real Host.
    const clientSessions = fixture.aggregate.wire.client.sessions as unknown as {
      binding(id: unknown): { session: { readAttachment(attachment: ImageAttachmentRefLike): Promise<unknown> } } | undefined
    }
    const retained = clientSessions.binding(SessionId(SESSION_ID))
    assert.ok(retained, 'the resumed Remote Session is retained by the real Client')
    let releaseRead!: () => void
    const gate = new Promise<void>(resolve => { releaseRead = resolve })
    let readStarted = false
    const originalRead = retained.session.readAttachment
    retained.session.readAttachment = async (attachment: ImageAttachmentRefLike) => {
      readStarted = true
      await gate
      return originalRead.call(retained.session, attachment)
    }

    // The PRODUCTION Remote read seam is observed one-to-one: the unbound
    // original is called through `original.call`, and the outcome is recorded.
    const presentation = fixture.aggregate.presentation as unknown as {
      attachments: {
        readDurableImage(sessionId: string, attachment: ImageAttachmentRefLike, lifetime: unknown): Promise<unknown>
      }
    }
    const outcomes: { readonly rejected?: string }[] = []
    const originalDurable = presentation.attachments.readDurableImage
    presentation.attachments.readDurableImage = function patched(this: unknown, ...args: unknown[]) {
      return originalDurable.apply(this, args as never).then(
        (value: unknown) => { outcomes.push({}); return value },
        (error: unknown) => { outcomes.push({ rejected: String(error) }); throw error },
      )
    }
    try {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 0 })
      session.append('tool/call', {
        turn: 1, step: 0, callId: ToolCallId('remote-image-retired'), name: 'read_image', arguments: '{}',
      })
      session.append('tool/result', {
        turn: 1, step: 0,
        message: {
          id: MessageId('remote-image-retired-result'), role: 'tool', toolCallId: ToolCallId('remote-image-retired'),
          content: [{ type: 'text', text: 'Remote screenshot' }, { type: 'image', attachment: image }],
          source: { kind: 'tool', callId: ToolCallId('remote-image-retired') },
        },
      }, { surfaceOp: 'append' })

      await waitFor('the REAL attachment read to start', () => readStarted, 20_000)

      // The REAL Connection generation rolls over while the read is open: the
      // presentation's transport lifetime is retired under the read.
      const connection = fixture.aggregate.wire.client.connection as unknown as {
        generation: { getSnapshot(): { readonly id: number } | undefined }
        reconnect(): void
      }
      const generationBefore = connection.generation.getSnapshot()?.id
      connection.reconnect()
      await waitFor('a NEW Connection generation to be established', () => {
        const current = connection.generation.getSnapshot()
        return current !== undefined && current.id !== generationBefore
      }, 20_000)

      releaseRead()
      await waitFor('the refused read to settle', () => outcomes.length > 0, 20_000)

      assert.equal(outcomes[0]?.rejected !== undefined, true,
        'the production Remote read REFUSED the bytes')
      assert.match(String(outcomes[0]?.rejected), /changed while the attachment was read|is retired/u,
        'the refusal is the production lifetime fence')
      // The refused bytes never reach the wire: no blob, and no frame that
      // references the attachment.
      assert.equal(pane.blobIds().includes(expectedBlobId), false,
        'the refused attachment sent NO blob')
      assert.equal(JSON.stringify(pane.frames()).includes(expectedBlobId), false,
        'no frame references the refused attachment')
      await waitFor('the row to state the read failure', () =>
        pane.output.text().includes('Image read failed'), 20_000)
    } finally {
      presentation.attachments.readDurableImage = originalDurable
      retained.session.readAttachment = originalRead
    }
  } finally {
    await fixture.dispose()
  }
})

test('a Remote tool-result image is authorized by its retained Session and reaches the Tern blob frame', async t => {
  const life = testLifecycle(t)
  const host = await mountRemotePresentationHost(life, 'prc-remote-image-preset')
  await host.harness.create(SessionId(SESSION_ID), { provider: 'smoke', model: 'smoke' } as never, { cwd: host.anchorDir })
  const session = host.ctx.sessions.get(SessionId(SESSION_ID)) as unknown as HostSession
  const fixture = await mountRemoteRunner(life, {
    presetId: 'prc-remote-image-preset', resumeSessionId: SESSION_ID, host,
    renderer: 'tsp', nativeImages: true,
  })
  try {
    assert.ok(fixture.pane, 'the remote runner uses the scripted TSP pane')
    const attachments = host.ctx.get('attachments') as unknown as AttachmentStore
    const png = await realPng()
    const image = (await attachments.saveImages([{ data: png, mediaType: 'image/png', name: 'shot.png' }]))[0]!
    const expectedBlobId = createHash('sha256').update(png).digest('hex')

    const clientSessions = fixture.aggregate.wire.client.sessions as unknown as {
      binding(id: unknown): { session: { readAttachment(attachment: ImageAttachmentRefLike): Promise<unknown> } } | undefined
    }
    const retained = clientSessions.binding(SessionId(SESSION_ID))
    assert.ok(retained, 'the resumed Remote Session is retained by the real Client')
    assert.equal(typeof retained.session.readAttachment, 'function', 'the retained official Session owns attachment reads')

    // The PRODUCTION Remote read is in the path: the production presentation
    // object is wrapped with a ONE-TO-ONE recorder (the unbound original is
    // saved and called through `original.call`, never `.bind`), so the proof
    // names the exact production seam instead of "some read happened".
    const presentation = fixture.aggregate.presentation as unknown as {
      attachments: {
        readDurableImage(sessionId: string, attachment: ImageAttachmentRefLike, lifetime: unknown): Promise<unknown>
      }
    }
    const durableReads: { sessionId: string; attachmentId: string; hasLifetime: boolean }[] = []
    const originalRead = presentation.attachments.readDurableImage
    presentation.attachments.readDurableImage = function patched(
      this: unknown, sessionId: string, attachment: ImageAttachmentRefLike, lifetime: unknown,
    ) {
      durableReads.push({ sessionId, attachmentId: attachment.attachmentId, hasLifetime: lifetime !== undefined })
      return originalRead.call(this, sessionId, attachment, lifetime)
    }
    try {
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 0 })
      session.append('tool/call', {
        turn: 1, step: 0, callId: ToolCallId('remote-image-call'), name: 'read_image', arguments: '{}',
      })
      session.append('tool/result', {
        turn: 1, step: 0,
        message: {
          id: MessageId('remote-image-result'), role: 'tool', toolCallId: ToolCallId('remote-image-call'),
          content: [{ type: 'text', text: 'Remote screenshot' }, { type: 'image', attachment: image }],
          source: { kind: 'tool', callId: ToolCallId('remote-image-call') },
        },
      }, { surfaceOp: 'append' })

      // The `b` write is not the end of the chain: the `f` that references the
      // blob leaves the SDK later (frame credit), so the wait observes the frame
      // the assertions below read.
      await waitFor('the SDK emitted the admitted image blob and the frame that references it', () => {
        const sent = fixture.pane!.output.text()
        return fixture.pane!.blobIds().includes(expectedBlobId) && drewImage(sent, expectedBlobId)
      }, 15_000)
      const wire = fixture.pane.output.text()
      assert.equal(wire.includes('[IMAGE] shot.png'), true, 'the image identity row names the admitted attachment')
      assert.equal(drewImage(wire, expectedBlobId), true, 'an official SDK frame references the image blob id')
      const sent = readTspBlobMessages(wire).find(blob => blob.id === expectedBlobId)
      assert.ok(sent !== undefined, 'the official SDK blob message carries a body')
      assert.deepEqual(sent.bytes, png, 'wire bytes equal the exact admitted PNG')
      const events = fixture.pane.wireEvents()
      const blobIndex = events.findIndex(event => event.kind === 'blob' && event.id === expectedBlobId)
      const referenceIndex = events.findIndex((event, index) => index > blobIndex
        && event.kind === 'frame' && event.frame?.ops.some(op => JSON.stringify(op).includes(expectedBlobId)))
      assert.ok(blobIndex >= 0 && referenceIndex > blobIndex, 'the b blob precedes the f frame that references it')
      assert.equal(durableReads.length > 0, true, 'the production Remote read seam was the one that served the bytes')
      assert.equal(durableReads.every(read => read.sessionId === SESSION_ID), true,
        'the read addressed the OWNING Session')
      assert.equal(durableReads.every(read => read.attachmentId === image.attachmentId), true,
        'the read addressed the exact attachment')
      assert.equal(durableReads.every(read => read.hasLifetime), true,
        'the read carried the exact retained binding lifetime')
    } finally {
      presentation.attachments.readDurableImage = originalRead
    }
  } finally {
    await fixture.dispose()
  }
})

test('a Remote USER body image is authorized by its retained Session and painted as a native blob', async t => {
  const life = testLifecycle(t)
  const host = await mountRemotePresentationHost(life, 'prc-remote-body-preset')
  const BODY_SESSION_ID = 'prc-remote-body-session'
  await host.harness.create(SessionId(BODY_SESSION_ID), { provider: 'smoke', model: 'smoke' } as never, { cwd: host.anchorDir })
  const session = host.ctx.sessions.get(SessionId(BODY_SESSION_ID)) as unknown as HostSession
  const fixture = await mountRemoteRunner(life, {
    presetId: 'prc-remote-body-preset', resumeSessionId: BODY_SESSION_ID, host,
    renderer: 'tsp', nativeImages: true,
  })
  try {
    const attachments = host.ctx.get('attachments') as unknown as AttachmentStore
    const png = await realPng()
    const [image] = await attachments.saveImages([{ data: png, mediaType: 'image/png', name: 'body-shot.png' }])
    const expectedBlobId = createHash('sha256').update(png).digest('hex')

    // The PRODUCTION Remote read seam is observed one-to-one (the unbound
    // original is saved and called through `original.call`, never `.bind`).
    const presentation = fixture.aggregate.presentation as unknown as {
      attachments: {
        readDurableImage(sessionId: string, attachment: ImageAttachmentRefLike, lifetime: unknown): Promise<unknown>
      }
    }
    const durableReads: { sessionId: string; attachmentId: string; hasLifetime: boolean }[] = []
    const originalRead = presentation.attachments.readDurableImage
    presentation.attachments.readDurableImage = function patched(
      this: unknown, sessionId: string, attachment: ImageAttachmentRefLike, lifetime: unknown,
    ) {
      durableReads.push({ sessionId, attachmentId: attachment.attachmentId, hasLifetime: lifetime !== undefined })
      return originalRead.call(this, sessionId, attachment, lifetime)
    }
    try {
      // A REAL durable USER message whose content carries the image block.
      session.append('user/message', {
        id: MessageId('remote-body-user'),
        role: 'user',
        content: [{ type: 'text', text: 'Remote body screenshot' }, { type: 'image', attachment: image! }],
        source: { kind: 'user' },
        turn: 1,
      }, { surfaceOp: 'append' })

      await waitFor('the SDK emitted the USER body image blob and the frame that references it', () => {
        const sent = fixture.pane!.output.text()
        return fixture.pane!.blobIds().includes(expectedBlobId) && drewImage(sent, expectedBlobId)
      }, 20_000)
      const wire = fixture.pane!.output.text()
      assert.equal(wire.includes('[IMAGE] body-shot.png'), true,
        'the USER body identity row names the admitted attachment')
      assert.equal(drewImage(wire, expectedBlobId), true,
        'an official SDK frame references the USER body image blob')
      assert.equal(durableReads.length > 0, true, 'the production Remote read seam served the bytes')
      assert.equal(durableReads.every(read => read.sessionId === BODY_SESSION_ID), true,
        'the read addressed the OWNING Session')
      assert.equal(durableReads.every(read => read.attachmentId === image!.attachmentId), true,
        'the read addressed the exact attachment')
      assert.equal(durableReads.every(read => read.hasLifetime), true,
        'the read carried the exact retained binding lifetime')
    } finally {
      presentation.attachments.readDurableImage = originalRead
    }
  } finally {
    await fixture.dispose()
  }
})

test('a Remote USER body image whose read is refused after a generation rollover draws no blob', async t => {
  const life = testLifecycle(t)
  const host = await mountRemotePresentationHost(life, 'prc-remote-body-preset')
  const BODY_SESSION_ID = 'prc-remote-body-stale-session'
  await host.harness.create(SessionId(BODY_SESSION_ID), { provider: 'smoke', model: 'smoke' } as never, { cwd: host.anchorDir })
  const session = host.ctx.sessions.get(SessionId(BODY_SESSION_ID)) as unknown as HostSession
  const fixture = await mountRemoteRunner(life, {
    presetId: 'prc-remote-body-preset', resumeSessionId: BODY_SESSION_ID, host,
    renderer: 'tsp', nativeImages: true,
  })
  try {
    const attachments = host.ctx.get('attachments') as unknown as AttachmentStore
    const png = await realPng()
    const [image] = await attachments.saveImages([{ data: png, mediaType: 'image/png', name: 'stale-shot.png' }])
    const expectedBlobId = createHash('sha256').update(png).digest('hex')

    // Gate the REAL retained binding's read so the transport lifetime can
    // retire WHILE the read is open.
    const clientSessions = fixture.aggregate.wire.client.sessions as unknown as {
      binding(id: unknown): { session: { readAttachment(attachment: ImageAttachmentRefLike): Promise<unknown> } } | undefined
    }
    const retained = clientSessions.binding(SessionId(BODY_SESSION_ID))
    assert.ok(retained, 'the resumed Remote Session is retained by the real Client')
    let releaseRead!: () => void
    const gate = new Promise<void>(resolve => { releaseRead = resolve })
    let readStarted = false
    const originalRead = retained.session.readAttachment
    retained.session.readAttachment = async (attachment: ImageAttachmentRefLike) => {
      readStarted = true
      await gate
      return originalRead.call(retained.session, attachment)
    }
    try {
      session.append('user/message', {
        id: MessageId('remote-body-stale'),
        role: 'user',
        content: [{ type: 'text', text: 'stale screenshot' }, { type: 'image', attachment: image! }],
        source: { kind: 'user' },
        turn: 1,
      }, { surfaceOp: 'append' })
      await waitFor('the REAL attachment read to start', () => readStarted, 20_000)

      const connection = fixture.aggregate.wire.client.connection as unknown as {
        generation: { getSnapshot(): { readonly id: number } | undefined }
        reconnect(): void
      }
      const generationBefore = connection.generation.getSnapshot()?.id
      connection.reconnect()
      await waitFor('a NEW Connection generation', () => {
        const current = connection.generation.getSnapshot()
        return current !== undefined && current.id !== generationBefore
      }, 20_000)

      releaseRead()
      await waitFor('the refused USER body read to settle', () =>
        fixture.pane!.output.text().includes('Image read failed'), 20_000)

      assert.equal(fixture.pane!.blobIds().includes(expectedBlobId), false,
        'the refused USER body sent NO blob')
      assert.equal(JSON.stringify(fixture.pane!.frames()).includes(expectedBlobId), false,
        'no frame references the refused USER body attachment')
    } finally {
      retained.session.readAttachment = originalRead
    }
  } finally {
    await fixture.dispose()
  }
})

// ── S3-03 A: cross-Session attachment access and its authorization boundary ──

/** The REAL Host attachment service behind Cordis' traceable service proxy. */
function attachmentStoreOf(ctx: Context): AttachmentStore {
  const traced = ctx.get('attachments') as unknown as AttachmentStore
  const original = (traced as unknown as Record<PropertyKey, unknown>)[symbols.original]
  return (original ?? traced) as AttachmentStore
}

interface ClientAttachmentOutcome {
  readonly ok: boolean
  readonly value?: { readonly attachment: ImageAttachmentRefLike; readonly data: Uint8Array }
  readonly error?: { readonly code?: string; readonly details?: { readonly reason?: string } }
}

interface ClientSessionBinding {
  readonly session: { readAttachment(attachment: ImageAttachmentRefLike): Promise<ClientAttachmentOutcome> }
}

function retainedBinding(
  fixture: { readonly aggregate: { readonly wire: { readonly client: { readonly sessions: unknown } } } },
  sessionId: string,
): ClientSessionBinding {
  const sessions = fixture.aggregate.wire.client.sessions as {
    binding(id: unknown): ClientSessionBinding | undefined
  }
  const binding = sessions.binding(SessionId(sessionId))
  assert.ok(binding, `the resumed Remote Session ${sessionId} is retained by the real Client`)
  return binding
}

/** Seed the ONLY test-owned image in Session A's history; Session B never
 *  references it. Both Sessions live on the same Host/AttachmentStore. */
async function seedCrossSessionImage(
  host: Awaited<ReturnType<typeof mountRemotePresentationHost>>,
  sessionA: string,
  sessionB: string,
): Promise<{ readonly png: Uint8Array; readonly image: ImageAttachmentRefLike; readonly store: AttachmentStore }> {
  await host.harness.create(SessionId(sessionA), { provider: 'smoke', model: 'smoke' } as never, { cwd: host.anchorDir })
  await host.harness.create(SessionId(sessionB), { provider: 'smoke', model: 'smoke' } as never, { cwd: host.anchorDir })
  const store = attachmentStoreOf(host.ctx)
  const png = await realPng()
  const image = (await store.saveImages([{ data: png, mediaType: 'image/png', name: 'cross-session.png' }]))[0]!
  const owner = host.ctx.sessions.get(SessionId(sessionA)) as unknown as HostSession
  owner.append('user/message', {
    id: MessageId(`s3-cross-owner-${sessionA}`),
    role: 'user',
    content: [{ type: 'text', text: 'Session A owns the image' }, { type: 'image', attachment: image }],
    source: { kind: 'user' },
    turn: 1,
  }, { surfaceOp: 'append' })
  return { png, image, store }
}

test('a Session B that never referenced the image reads A\'s full ref from the same Host store', async t => {
  const life = testLifecycle(t)
  const SESSION_A = 's3-cross-store-a'
  const SESSION_B = 's3-cross-store-b'
  const host = await mountRemotePresentationHost(life, 'prc-cross-store-preset')
  const { png, image, store } = await seedCrossSessionImage(host, SESSION_A, SESSION_B)
  const sessionB = host.ctx.sessions.get(SessionId(SESSION_B)) as unknown as HostSession
  assert.equal(JSON.stringify(sessionB.snapshotEvents()).includes(image.attachmentId), false,
    'Session B history carries NO reference to the image')
  const fixture = await mountRemoteRunner(life, {
    presetId: 'prc-cross-store-preset', resumeSessionId: SESSION_B, host,
    renderer: 'tsp', nativeImages: true,
  })
  const reads: string[] = []
  const originalRead = store.readImage
  store.readImage = function patched(this: unknown, ref: ImageAttachmentRefLike, signal?: AbortSignal) {
    reads.push(ref.attachmentId)
    return originalRead.call(this, ref, signal)
  }
  try {
    const binding = retainedBinding(fixture, SESSION_B)
    const outcome = await binding.session.readAttachment(image)
    assert.equal(outcome.ok, true,
      `the official client read resolves the full ref through Session B: ${JSON.stringify(outcome.error)}`)
    assert.deepEqual(Array.from(outcome.value!.data), Array.from(png),
      'the exact Host-store PNG bytes are returned')
    assert.deepEqual(Array.from(outcome.value!.attachment.name ?? ''), Array.from('cross-session.png'))
    assert.deepEqual(reads, [image.attachmentId],
      'the REAL Host AttachmentStore served the read (not a test mirror)')
  } finally {
    store.readImage = originalRead
    await fixture.dispose()
  }
})

test('a non-owner Peer without session/attachment access is refused by the Gateway before the store', async t => {
  const life = testLifecycle(t)
  const SESSION_A = 's3-guest-a'
  const SESSION_B = 's3-guest-b'
  const host = await mountRemotePresentationHost(life, 'prc-guest-preset')
  const { png, image, store } = await seedCrossSessionImage(host, SESSION_A, SESSION_B)
  const fixture = await mountRemoteRunner(life, {
    presetId: 'prc-guest-preset', resumeSessionId: SESSION_B, host,
    renderer: 'tsp', nativeImages: true,
  })
  let storeReads = 0
  const originalRead = store.readImage
  store.readImage = function patched(this: unknown, ref: ImageAttachmentRefLike, signal?: AbortSignal) {
    storeReads += 1
    return originalRead.call(this, ref, signal)
  }
  const remoteAccess = host.ctx.get('remoteAccess') as {
    registerPolicy(kind: string, policy: { bindings(): readonly unknown[] }): () => void
  }
  // A REAL policy for an independent non-owner Peer: no grant at all.
  const disposePolicy = remoteAccess.registerPolicy('s3-guest', { bindings: () => [] })
  const gateway = host.ctx.get('typertGateway') as {
    invoke(request: unknown): Promise<unknown>
  }
  const controller = new AbortController()
  const peer = {
    id: 's3-guest-peer',
    ctx: host.ctx,
    principal: { kind: 's3-guest', guest: 's3-qualification' },
    signal: controller.signal,
    interactions: 'answer',
    dispose: async () => {},
  }
  try {
    // Positive control on the SAME ref/Host: the authorized owner Client read
    // succeeds, so the denial below is authorization, not a broken reference.
    const authorized = await retainedBinding(fixture, SESSION_B).session.readAttachment(image)
    assert.equal(authorized.ok, true, 'the authorized owner read succeeds on the same ref')
    assert.deepEqual(Array.from(authorized.value!.data), Array.from(png))
    const ownerReads = storeReads
    assert.equal(ownerReads > 0, true, 'the authorized read really reached the Host store')

    await assert.rejects(gateway.invoke({
      peer,
      namespace: 'session',
      method: 'attachment',
      args: { request: { sessionId: SESSION_B, attachment: image } },
    }), (error: unknown) => {
      const failure = error as { code?: string; details?: { reason?: string } }
      assert.equal(failure.code, 'remote-access/denied',
        `the real Gateway refusal code: ${String(failure.code)}`)
      assert.equal(failure.details?.reason, 'no-allow', 'the denial names the missing grant')
      return true
    })
    assert.equal(storeReads, ownerReads,
      'the refused non-owner call never reached the Host AttachmentStore')
  } finally {
    disposePolicy()
    store.readImage = originalRead
    await fixture.dispose()
  }
})

test('an intrinsic full-ref mismatch is refused by the real store; display metadata is not a credential', async t => {
  const life = testLifecycle(t)
  const SESSION_A = 's3-integrity-a'
  const SESSION_B = 's3-integrity-b'
  const host = await mountRemotePresentationHost(life, 'prc-integrity-preset')
  const { png, image } = await seedCrossSessionImage(host, SESSION_A, SESSION_B)
  const fixture = await mountRemoteRunner(life, {
    presetId: 'prc-integrity-preset', resumeSessionId: SESSION_B, host,
    renderer: 'tsp', nativeImages: true,
  })
  try {
    const binding = retainedBinding(fixture, SESSION_B)
    // Same attachment identity, WRONG intrinsic byte length: the real store
    // verifies the stored bytes against the full ref and refuses.
    const corrupt = await binding.session.readAttachment({ ...image, bytes: image.bytes + 1 })
    assert.equal(corrupt.ok, false, 'a mismatched intrinsic ref never resolves to bytes')
    assert.equal(corrupt.error?.code, 'session/attachment-invalid')
    assert.equal(corrupt.error?.details?.reason, 'ATTACHMENT_CORRUPT',
      'the refusal is the real store integrity check')
    assert.equal(corrupt.value, undefined, 'no zero-byte success is fabricated for the refusal')

    // Display-only fields are preserved, not treated as intrinsic credentials.
    const renamed = await binding.session.readAttachment({ ...image, name: 'display-name-only.png' })
    assert.equal(renamed.ok, true, 'a display-field change is not an intrinsic mismatch')
    assert.deepEqual(Array.from(renamed.value!.data), Array.from(png),
      'the renamed display ref returns the exact stored bytes')
    assert.equal(renamed.value!.attachment.name, 'display-name-only.png',
      'the display name is preserved without becoming verification material')
  } finally {
    await fixture.dispose()
  }
})
