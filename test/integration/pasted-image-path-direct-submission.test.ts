/**
 * A REAL terminal bracketed paste of a local image file path, through the REAL
 * Direct application composition (the plan's L6 application evidence: the real
 * runner, the real intake owner, the real SubmissionController and the real
 * Host attachment chain; only the model and the tty are scripted).
 * @module @xmoon76/dsh-pi-tui/pasted-image-path-direct-submission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { createDirectTspFixture, waitFor, waitForInputDelivery } from '../support/direct-tsp-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { readTspBlobMessages } from '../support/tsp-blob-wire.ts'

/** The latest controlled editor text on the wire for `dock.composer`. */
function latestComposerText(wire: string): string | undefined {
  let text: string | undefined
  let seen = false
  for (const match of wire.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    const frame = JSON.parse(match[1]!) as { ops: unknown[][] }
    for (const op of frame.ops) {
      if (op[0] === 'add') {
        const node = op[4] as { c?: Array<{ id?: string; p?: { text?: string } }> } | undefined
        const editor = node?.c?.find(child => child.id === 'dock.composer')
        if (editor?.p?.text !== undefined) text = editor.p.text
        seen = true
      } else if (op[0] === 'set' && op[1] === 'dock.composer' && (op[2] as { text?: string }).text !== undefined) {
        text = (op[2] as { text: string }).text
      } else if (op[0] === 'text' && op[1] === 'dock.composer') {
        text = op[2] === 'append' ? (text ?? '') + (op[3] as string) : (op[3] as string)
      }
    }
  }
  return seen ? text : undefined
}

test('a real bracketed paste of a local PNG path becomes a durable Direct image block', async (t) => {
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['L6', '-PASTED', '-OK'],
    nativeImages: true,
  })
  const prepared: unknown[] = []
  const recorder = fixture.recordPrompts(call => { prepared.push(call.message) })
  try {
    const require = createRequire(import.meta.url)
    const storeDir = dirname(require.resolve('@deepseek-ai/dsh-attachment-local/package.json'))
    const sharp = require(require.resolve('sharp', { paths: [storeDir] })) as (
      input: unknown,
    ) => { png(): { toBuffer(): Promise<Buffer> } }
    const png = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#abcdef' } }).png().toBuffer())
    const expectedBlobId = createHash('sha256').update(png).digest('hex')
    const pastedPath = join(fixture.workRoot, 'pasted-shot.png')
    writeFileSync(pastedPath, png)

    await waitForInputDelivery(fixture.pane)
    assert.equal(latestComposerText(fixture.pane.output.text()) ?? '', '', 'the composer starts empty')
    // The REAL terminal bytes Tern/Hedr send: bracketed paste + absolute path
    // + one trailing ASCII space.
    fixture.pane.input.type(`\u001b[200~${pastedPath} \u001b[201~`)
    await waitFor('the composer to hold the canonical image token', () =>
      /\[image #\d+ \(8×8\)\]/u.test(latestComposerText(fixture.pane.output.text()) ?? ''), 25_000)

    const draft = latestComposerText(fixture.pane.output.text()) ?? ''
    assert.match(draft, /\[image #\d+ \(8×8\)\]/u, 'the pasted path became the canonical token')
    assert.equal(draft.includes(pastedPath), false, 'the raw client path is gone from the draft')
    assert.equal(fixture.pane.blobIds().includes(expectedBlobId), true,
      'the staged bytes reached the ONE SDK blob sender through the production path')

    fixture.pane.input.type('\r')
    await waitFor('the settled prompt write', () => recorder.calls() >= 1, 30_000)

    const wire = JSON.stringify(prepared[0])
    assert.ok(wire.includes('"type":"image"'), `a real image block was prepared (got ${wire.slice(0, 240)})`)
    assert.equal(wire.includes('[image #'), false, 'no canonical token text reached the model content')
    assert.equal(wire.includes(pastedPath), false, 'the Client-local absolute path never reached the Host content')
    const ref = (prepared[0] as { content: { type: string; attachment?: { attachmentId: string; bytes: number } }[] })
      .content.find(block => block.type === 'image')!.attachment!
    assert.equal(ref.bytes, png.byteLength)
    const attachments = fixture.ctx.get('attachments') as unknown as {
      readImage(ref: unknown): Promise<{ data: Uint8Array }>
    }
    const stored = await attachments.readImage(ref)
    assert.deepEqual(new Uint8Array(stored.data), png, 'the durable block carries the exact pasted file bytes')
    assert.ok(readTspBlobMessages(fixture.pane.output.text()).length > 0, 'the preview blob channel ran')
  } finally {
    recorder.detach()
    // The fixture's own bounded teardown: wait for the real disposal instead
    // of a guessed sleep. This bounded window is the fixture's own cleanup.
    await fixture.settle()
  }
})
