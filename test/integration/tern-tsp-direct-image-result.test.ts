/**
 * PR-C: the DIRECT real-authorization positive case for a tool-result image.
 *
 * The chain under test is the PRODUCTION one, end to end:
 *
 *     the REAL rc.2 Host composition (the real `LocalAttachmentStore`)
 *       -> a real durable image saved into the isolated store
 *       -> a real `tool/result` session event carrying the image block
 *       -> the REAL Direct runner + the REAL TSP renderer
 *       -> the REAL production `readImage` composition (`ctx.attachments.readImage`)
 *       -> the REAL `ImageLoader` -> the REAL `session.blob()`
 *       -> the scripted pane's wire: a `b` blob and the `f` that references it
 *
 * STANDING-IN (never claimed as production): the MODEL is the fixture's
 * scripted streaming adapter and the PANE is a scripted tty (not a real Tern
 * client). The AUTHORIZATION under test is the real one: the real attachment
 * store admits the bytes, the real session reference authorizes the read, and
 * the real composition performs it. Nothing here injects a permission
 * boolean.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-direct-image-result.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createDirectTspFixture, waitFor } from '../support/direct-tsp-fixture.ts'

const SESSION_ID = 'prc-direct-image-session'

/** One REAL PNG's exact bytes, produced through the attachment backend's own
 *  dependency (the store verifies the format and the CRC strictly). */
async function realPng(background: string, size: number): Promise<Uint8Array> {
  const require = createRequire(import.meta.url)
  const storeDir = dirname(require.resolve('@deepseek-ai/dsh-attachment-local/package.json'))
  const sharp = require(require.resolve('sharp', { paths: [storeDir] })) as (
    input: unknown,
  ) => { png(): { toBuffer(): Promise<Buffer> } }
  return new Uint8Array(await sharp({ create: { width: size, height: size, channels: 3, background } }).png().toBuffer())
}

/** The real Host attachment service face used to admit a fixture image. */
interface FixtureAttachments {
  saveImages(inputs: readonly { readonly data: Uint8Array; readonly mediaType: string; readonly name?: string }[]):
    Promise<readonly {
      readonly attachmentId: string
      readonly mediaType: string
      readonly bytes: number
      readonly width: number
      readonly height: number
      readonly name?: string
    }[]>
}

/**
 * The REAL session of the fixture, once the runner has resumed it. The
 * startup resumes the persisted session asynchronously, so the test waits for
 * the session to EXIST instead of assuming it.
 */
async function sessionOf(fixture: { readonly ctx: { sessions: { get(id: unknown): unknown } } }): Promise<{
  append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
}> {
  let session: { append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void } | undefined
  await waitFor('the runner to resume the session', () => {
    session = fixture.ctx.sessions.get(SessionId(SESSION_ID)) as never
    return session !== undefined
  }, 30_000)
  return session!
}

/** The blob ids the pane actually received, in order. */
function blobIds(wire: string): string[] {
  return [...wire.matchAll(/_tsp;b;id=([0-9a-f]*);/g)].map(match => match[1]!)
}

/** Whether the pane drew a native image node carrying the blob id. The SDK
 *  ADDS the image node with the pending placeholder and later SETS its real
 *  blob id, so both op kinds are observed. */
function drewImage(wire: string, blobId: string): boolean {
  const imageIds = new Set<string>()
  const walk = (node: { k?: string; id?: string; c?: unknown[] } | undefined): void => {
    if (node === undefined) return
    if (node.k === 'image' && typeof node.id === 'string') imageIds.add(node.id)
    for (const child of node.c ?? []) walk(child as never)
  }
  for (const match of wire.matchAll(/_tsp;f;([\s\S]*?)\\/g)) {
    const frame = JSON.parse(match[1]!) as { ops: unknown[][] }
    for (const op of frame.ops) {
      if (op[0] === 'add') walk(op[4] as never)
      if (op[0] === 'set' && imageIds.has(op[1] as string)
        && (op[2] as { blob?: string }).blob === blobId) return true
    }
  }
  return false
}

test('a tool result image is read through the REAL Direct attachment service and painted as a native blob', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['DIRECT', '-IMAGE', '-OK'],
    startup: { sessionId: SESSION_ID },
    persistedBlankSessions: [{ id: SESSION_ID }],
    nativeImages: true,
  })
  try {
    const attachments = fixture.ctx.get('attachments') as unknown as FixtureAttachments
    const png = await realPng('#c0ffee', 4)
    const image = (await attachments.saveImages([{ data: png, mediaType: 'image/png', name: 'shot.png' }]))[0]!
    const expectedBlobId = createHash('sha256').update(png).digest('hex')

    // The REAL session log: a genuine tool call and its result, the result
    // carrying the durable image block.
    const session = await sessionOf(fixture)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 0 })
    session.append('tool/call', {
      turn: 1,
      step: 0,
      callId: ToolCallId('call-image-1'),
      name: 'read_image',
      arguments: '{"path":"shot.png"}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 0,
      message: {
        id: MessageId('result-image-1'),
        role: 'tool',
        toolCallId: ToolCallId('call-image-1'),
        content: [
          { type: 'text', text: 'Here is the screenshot.' },
          { type: 'image', attachment: image },
        ],
        source: { kind: 'tool', callId: ToolCallId('call-image-1') },
      },
    }, { surfaceOp: 'append' })

    await waitFor('the pane received the real image blob', () =>
      blobIds(fixture.pane.output.text()).includes(expectedBlobId), 8_000)
      .catch((error: unknown) => { throw error })

    const wire = fixture.pane.output.text()
    assert.equal(drewImage(wire, expectedBlobId), true,
      'the pane drew a native image node carrying the REAL blob id')
    assert.equal(wire.includes('[IMAGE] shot.png'), true,
      'the identity line named the real attachment')

    // The bytes that reached the wire are the REAL stored bytes: the blob id
    // IS the SHA-256 of the admitted PNG.
    const base64 = wire.match(new RegExp(`\u001b_tsp;b;id=${expectedBlobId};[^;]*;([A-Za-z0-9+/=]+)`))?.[1]
    assert.ok(base64 !== undefined, 'the blob message is on the wire')
    assert.deepEqual(new Uint8Array(Buffer.from(base64, 'base64')), png,
      'the wire carries the exact admitted bytes')
  } finally {
    // The fixture's teardown disposes the app, the pane and the Host
    // context before the next case starts: a bounded wait, not a sleep.
    await fixture.settle()
  }
})

test('an attachment the REAL service cannot read is refused and never painted', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['DIRECT', '-IMAGE', '-DENIED'],
    startup: { sessionId: SESSION_ID },
    persistedBlankSessions: [{ id: SESSION_ID }],
    nativeImages: true,
  })
  try {
    // A reference the REAL store never admitted: the read must fail at the
    // service, and the renderer must state the failure instead of sending
    // bytes.
    const missing = {
      attachmentId: 'att-never-admitted',
      mediaType: 'image/png',
      bytes: 95,
      width: 4,
      height: 4,
      name: 'missing.png',
    }

    const session = await sessionOf(fixture)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 0 })
    session.append('tool/call', {
      turn: 1, step: 0, callId: ToolCallId('call-image-2'), name: 'read_image', arguments: '{}',
    })
    session.append('tool/result', {
      turn: 1,
      step: 0,
      message: {
        id: MessageId('result-image-2'),
        role: 'tool',
        toolCallId: ToolCallId('call-image-2'),
        content: [
          { type: 'text', text: 'no image here' },
          { type: 'image', attachment: missing },
        ],
        source: { kind: 'tool', callId: ToolCallId('call-image-2') },
      },
    }, { surfaceOp: 'append' })

    await waitFor('the pane rendered the failed image row', () =>
      fixture.pane.output.text().includes('Image read failed'), 30_000)
    assert.deepEqual(blobIds(fixture.pane.output.text()), [],
      'no image bytes reached the wire')
    assert.equal(fixture.pane.output.text().includes('[IMAGE] missing.png'), true,
      'the identity line still names the attachment')
  } finally {
    // The fixture's teardown disposes the app, the pane and the Host
    // context before the next case starts: a bounded wait, not a sleep.
    await fixture.settle()
  }
})
