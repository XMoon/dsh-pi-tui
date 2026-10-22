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
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountRemotePresentationHost, mountRemoteRunner } from '../app/runner-remote-presentation.test.ts'
import { waitFor } from '../support/remote-application-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

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
  saveImages(inputs: readonly { data: Uint8Array; mediaType: string; name?: string }[]): Promise<readonly {
    attachmentId: string; mediaType: string; bytes: number; width: number; height: number; name?: string
  }[]>
}
interface HostSession { append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void }

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
      binding(id: unknown): { session: { readAttachment(id: unknown): Promise<unknown> } } | undefined
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
        readDurableImage(sessionId: string, attachmentId: string, lifetime: unknown): Promise<unknown>
      }
    }
    const durableReads: { sessionId: string; attachmentId: string; hasLifetime: boolean }[] = []
    const originalRead = presentation.attachments.readDurableImage
    presentation.attachments.readDurableImage = function patched(
      this: unknown, sessionId: string, attachmentId: string, lifetime: unknown,
    ) {
      durableReads.push({ sessionId, attachmentId, hasLifetime: lifetime !== undefined })
      return originalRead.call(this, sessionId, attachmentId, lifetime)
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

      await waitFor('the SDK emitted the admitted image blob', () => fixture.pane!.blobIds().includes(expectedBlobId), 15_000)
      const wire = fixture.pane.output.text()
      assert.equal(wire.includes('[IMAGE] shot.png'), true, 'the image identity row names the admitted attachment')
      assert.equal(drewImage(wire, expectedBlobId), true, 'an official SDK frame references the image blob id')
      const base64 = wire.match(new RegExp(`\\u001b_tsp;b;id=${expectedBlobId};[^;]*;([A-Za-z0-9+/=]+)`))?.[1]
      assert.ok(base64 !== undefined, 'the official SDK blob message carries a body')
      assert.deepEqual(new Uint8Array(Buffer.from(base64, 'base64')), png, 'wire bytes equal the exact admitted PNG')
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
