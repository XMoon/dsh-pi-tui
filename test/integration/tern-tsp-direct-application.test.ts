/**
 * PR3-B B2: the OFFICIAL Direct application chain over the TSP pane.
 *
 * Unlike the scripted-pane suites (which run the real runner against stand-in
 * services), this suite mounts the rc.2 Host composition for real — REAL live
 * Agents from `mountAgentLoopTestHarness`, the real Direct SessionWriter, the
 * real SubmissionController and the real TSP renderer — with only the MODEL
 * scripted (a streaming `LlmAdapter`). The proof chain is therefore:
 *
 *     SDK key bytes → the TSP input loop → the composer → handlers.submit →
 *     ApplicationEvents.onSubmit → the REAL SubmissionController → the REAL
 *     Direct writer → a REAL Agent turn → the official assistant stream →
 *     the canonical fold → SDK frames
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-direct-application.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createDirectTspFixture, directSettle, waitFor, waitForInputDelivery } from '../support/direct-tsp-fixture.ts'

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

test('a TSP Enter drives a REAL Agent turn and the streamed reply reaches the pane', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, { deltas: ['DIRECT', '-L6', '-OK'] })
  // The exact-once witness: a ONE-TO-ONE recorder on the PRODUCTION-created
  // Direct session writer (the unbound prototype original; every call goes
  // through `original.call(this)` and the recorded outcome is the original's).
  const promptCalls: Array<{ readonly sessionId: string; readonly mode: 'queue' | 'steer'; readonly message: unknown; readonly agentStatus: string; readonly outcome: { readonly kind: string } }> = []
  const recorder = fixture.recordPrompts(call => { promptCalls.push(call) })
  try {
    // The tty becoming DELIVERABLE is the runner's readiness signal — the
    // renderer HOLDS the keys that arrive before its bind and replays them in
    // arrival order, so a key sent after this wait is never lost. The fixed
    // startup sleeps only guessed how long that took.
    await waitForInputDelivery(fixture.pane)
    fixture.pane.input.type('hello official direct')
    // The composer HOLDING the text is the completion signal: the renderer
    // holds the key until its bind and replays it, so the draft appears when
    // the input was actually applied — a fixed settle only guessed how long
    // that takes, and a slow bind would make the case read the old frame.
    await waitFor('the composer to hold the typed draft', () =>
      latestComposerText(fixture.pane.output.text()) === 'hello official direct', 25_000)
    assert.equal(latestComposerText(fixture.pane.output.text()), 'hello official direct',
      'the draft is on the wire before the gesture')
    // NEGATIVE CONTROL: the scripted model's text is NOT on the wire before the
    // submit — so its later appearance is caused by the Enter, not by a
    // pre-seeded frame or a fixture that renders the script eagerly.
    assert.ok(!fixture.pane.output.text().includes('DIRECT-L6-OK'),
      'the assistant text is absent until the gesture is submitted')
    // NEGATIVE CONTROL (writer): no prompt was written before the gesture, so
    // the later `calls === 1` is caused by the Enter — never by a boot-time or
    // eager write. The mutation the review ran (ignore Enter at the input
    // boundary) leaves this array empty and FAILS the assertions below.
    assert.equal(recorder.calls(), 0, 'no prompt write happened before the gesture')
    fixture.pane.input.type('\r')
    // The submission's own PRODUCER facts — not a wire substring the composer
    // draft could already satisfy: wait for the write's SETTLED record (the
    // recorder counts settled writes only, so `calls() === 1` implies the
    // record exists), then assert on THAT record.
    await waitFor('the committed prompt write to SETTLE',
      () => recorder.calls() === 1 && promptCalls.length === 1, 30_000)
    const call = promptCalls[0]!
    assert.ok(JSON.stringify(call.message).includes('hello official direct'),
      'the settled record carries the submitted prepared message')
    assert.equal(call.outcome.kind, 'committed', 'the one write settled committed')
    assert.equal(call.mode, 'queue', 'an idle-start submission queues')
    assert.equal(call.agentStatus, 'running',
      'the write addressed the REAL live Agent (resolved through the production agentFor)')
    // The REAL Agent turn ran: the scripted model served exactly one request.
    await waitFor('the streamed assistant reply', () => fixture.pane.output.text().includes('DIRECT-L6-OK'), 30_000)
    assert.equal(fixture.modelCalls(), 1, 'exactly ONE real Agent turn ran')
    const wire = fixture.pane.output.text()
    assert.ok(wire.includes('DIRECT-L6-OK'),
      'the scripted model stream reached the canonical fold and the SDK pane')
    // Post-turn stability: no second write ever SETTLES (the exact-once fact
    // is a terminal state, not a race snapshot).
    await directSettle(2_000)
    assert.equal(recorder.calls(), 1, 'no further prompt write settled after the turn')
    assert.equal(promptCalls.length, 1, 'the settled-record array agrees (exactly one)')
    assert.equal(fixture.modelCalls(), 1, 'no further model turn happened either')
    recorder.detach()
  } finally {
    recorder.detach()
    await fixture.settle()
  }
})

// ── PR4: the L6 Ctrl+V → composer token → durable image block main chain ────

/**
 * The L6 main chain, end to end on the REAL Direct composition:
 *
 *     a clipboard helper on $PATH (the production `readClipboardImage` probe,
 *     spawned through the production runner, plus the ONE application FIFO)
 *       → the SDK's real Ctrl+V key → `dispatchKey` → `pasteMedia`
 *       → `ApplicationEvents.onClipboardPaste` → the REAL `DraftImageStore`
 *       → the live TSP composer token
 *       → Enter → the REAL `SubmissionController` → `prepareUserMessage`
 *       → the REAL Direct writer, whose prepared message carries an image block
 *
 * PRODUCTION PREREQUISITES REPRODUCED: the real Host service composition, the
 * real runner, the real submission controller and Direct writer, the real TSP
 * renderer, the real clipboard probe (it spawns the helper exactly as it does
 * on a desktop), the real draft store, the real image limits.
 *
 * TEST STAND-INS: the model (the scripted streaming adapter) and the clipboard
 * CONTENT (a scripted `xclip` that answers the two questions the real probe
 * asks). DELIBERATELY ABSENT: a physical OS clipboard and a physical Tern GUI.
 */
test('a real Ctrl+V with an image clipboard lands a composer token and submits a durable image block', async (t) => {
  const { chmodSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['L6', '-IMAGE', '-OK'],
    nativeImages: true,
  })
  const previousPath = process.env.PATH
  const previousDisplay = process.env.DISPLAY
  // The write recorder is attached BEFORE any input: the submission it observes
  // is the one this gesture causes, not a warm-up.
  const prepared: unknown[] = []
  const recorder = fixture.recordPrompts(call => { prepared.push(call.message) })
  try {
    // One REAL PNG, produced by the attachment backend's own dependency (the
    // probe validates the format strictly).
    const { createRequire } = await import('node:module')
    const { dirname } = await import('node:path')
    const require = createRequire(import.meta.url)
    const storeDir = dirname(require.resolve('@deepseek-ai/dsh-attachment-local/package.json'))
    const sharp = require(require.resolve('sharp', { paths: [storeDir] })) as (
      input: unknown,
    ) => { png(): { toBuffer(): Promise<Buffer> } }
    const png = new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 3, background: '#abcdef' } }).png().toBuffer())
    const expectedBlobId = createHash('sha256').update(png).digest('hex')

    // A REAL clipboard helper on $PATH. The production X11 probe asks for
    // `-t TARGETS -o`, then for the advertised raster type's bytes.
    const binDir = join(fixture.workRoot, 'bin')
    mkdirSync(binDir, { recursive: true })
    const pngFile = join(fixture.workRoot, 'clipboard.png')
    writeFileSync(pngFile, png)
    const helper = join(binDir, 'xclip')
    writeFileSync(helper, [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  if [ "$arg" = "TARGETS" ]; then printf "image/png\\n"; exit 0; fi',
      `  if [ "$arg" = "image/png" ]; then cat ${JSON.stringify(pngFile)}; exit 0; fi`,
      'done',
      'exit 0',
      '',
    ].join('\n'))
    chmodSync(helper, 0o755)
    process.env.PATH = `${binDir}:${previousPath ?? ''}`
    process.env.DISPLAY = ':0'

    await waitForInputDelivery(fixture.pane)
    // The REAL Ctrl+V byte: the SDK decodes it into the formal Key fields the
    // production `dispatchKey` branch reads.
    fixture.pane.input.type('\x16')
    await waitFor('the composer to hold the canonical image token', () =>
      /\[image #\d+ \(8×8\)\]/u.test(latestComposerText(fixture.pane.output.text()) ?? ''), 25_000)

    const draft = latestComposerText(fixture.pane.output.text()) ?? ''
    assert.match(draft, /\[image #\d+ \(8×8\)\]/u,
      'the live composer carries the canonical draft-image token')
    // The dock preview is a native node over the SAME staged bytes, so this also
    // proves the blob channel ran for the draft.
    assert.equal(fixture.pane.blobIds().includes(expectedBlobId), true,
      'the staged bytes reached the ONE SDK blob sender through the production path')

    // Submit through the REAL submission controller.
    fixture.pane.input.type('\r')
    await waitFor('the settled prompt write', () => recorder.calls() >= 1, 30_000)

    const wire = JSON.stringify(prepared[0])
    assert.ok(wire.includes('"type":"image"'),
      `the prepared message carries a real image block (got ${wire.slice(0, 240)})`)
    assert.equal(wire.includes('[image #'), false,
      'the canonical draft token was expanded, never sent as literal text')
    // The image half of the prepared message is the STAGED PNG's own bytes. The
    // real attachment service stored them content-addressed and the prepared
    // block names that durable ref, so the chain is closed by READING THEM BACK
    // through the service rather than by trusting the identifier.
    const ref = (prepared[0] as { content: { type: string; attachment?: { attachmentId: string; bytes: number } }[] })
      .content.find(block => block.type === 'image')!.attachment!
    assert.equal(ref.bytes, png.byteLength, 'the durable ref records the staged byte length')
    const attachments = fixture.ctx.get('attachments') as unknown as {
      readImage(ref: unknown): Promise<{ data: Uint8Array }>
    }
    const stored = await attachments.readImage(ref)
    assert.deepEqual(new Uint8Array(stored.data), png,
      'the durable image block carries the exact staged bytes')
    // The text half survives beside the image block.
    assert.equal(wire.includes('"type":"text"'), true, 'the message still carries its text block')
  } finally {
    recorder.detach()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousDisplay === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = previousDisplay
    // The fixture's settle disposes the app, the pane and the Host context
    // before the next case starts: a bounded teardown, not a blind sleep.
    await fixture.settle()
  }
})

/**
 * The plain-text half of the same gesture, on the same production chain: a
 * clipboard holding TEXT must insert at the live caret and produce no draft
 * image, no image notice and no submission. The helper answers the probe with
 * a text payload only, exactly as `wl-paste`/`xclip` do for a text clipboard.
 */
test('a real Ctrl+V with a TEXT clipboard inserts at the caret and stages no image', async (t) => {
  const { chmodSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    deltas: ['L6', '-TEXT', '-OK'],
    nativeImages: true,
  })
  const previousPath = process.env.PATH
  const previousDisplay = process.env.DISPLAY
  const prepared: unknown[] = []
  const recorder = fixture.recordPrompts(call => { prepared.push(call.message) })
  try {
    const binDir = join(fixture.workRoot, 'bin')
    mkdirSync(binDir, { recursive: true })
    const helper = join(binDir, 'xclip')
    writeFileSync(helper, [
      '#!/bin/sh',
      'for arg in "$@"; do',
      '  if [ "$arg" = "TARGETS" ]; then printf "UTF8_STRING\\n"; exit 0; fi',
      'done',
      'printf "pasted text"',
      '',
    ].join('\n'))
    chmodSync(helper, 0o755)
    process.env.PATH = `${binDir}:${previousPath ?? ''}`
    process.env.DISPLAY = ':0'

    await waitForInputDelivery(fixture.pane)
    fixture.pane.input.type('lead ')
    await waitFor('the composer to hold the typed prefix', () =>
      (latestComposerText(fixture.pane.output.text()) ?? '').includes('lead'), 25_000)

    fixture.pane.input.type('\x16')
    await waitFor('the pasted text to land after the typed prefix', () =>
      latestComposerText(fixture.pane.output.text()) === 'lead pasted text', 25_000)

    const draft = latestComposerText(fixture.pane.output.text())!
    assert.equal(draft, 'lead pasted text', 'the text landed at the live caret, after what was typed')
    assert.equal(/\[image #\d+/u.test(draft), false, 'a text paste stages NO draft image')
    assert.deepEqual(fixture.pane.blobIds(), [], 'a text paste sends no image blob')
    assert.equal(paneHasImageNotice(fixture.pane.output.text()), false,
      'a text paste never shows an image notice')
    assert.equal(recorder.calls(), 0, 'a text paste never submits')

    // The text half survives the real submission path too (one text block, no image).
    fixture.pane.input.type('\r')
    await waitFor('the settled prompt write', () => recorder.calls() >= 1, 30_000)
    const wire = JSON.stringify(prepared[0])
    assert.equal(wire.includes('pasted text'), true, 'the submitted message carries the pasted text')
    assert.equal(wire.includes('"type":"image"'), false, 'the submitted message carries no image block')
  } finally {
    recorder.detach()
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    if (previousDisplay === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = previousDisplay
    // The fixture's settle disposes the app, the pane and the Host context
    // before the next case starts: a bounded teardown, not a blind sleep.
    await fixture.settle()
  }
})

/** Whether the wire shows an image-intake notice (never for a text paste). */
function paneHasImageNotice(wire: string): boolean {
  return wire.includes('attached [image') || wire.includes('Image read failed')
}
