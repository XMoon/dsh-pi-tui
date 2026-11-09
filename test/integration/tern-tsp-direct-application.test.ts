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

// ── Canonical Full/Compact: the REAL configured preset reaches the TSP frame ──

/** Fold the pane's SDK frames into the live node set (retired nodes are gone). */
function liveNodes(wire: string): Array<{ id: string; k: string; p: Record<string, unknown>; c?: unknown[] }> {
  const nodes = new Map<string, { id: string; k: string; p: Record<string, unknown>; c?: unknown[] }>()
  const drop = (id: string): void => {
    for (const key of [...nodes.keys()]) if (key === id || key.startsWith(`${id}.`)) nodes.delete(key)
  }
  const visit = (node: { id: string; k: string; p: Record<string, unknown>; c?: unknown[] }): void => {
    nodes.set(node.id, node)
    for (const child of node.c ?? []) visit(child as never)
  }
  for (const match of wire.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    const frame = JSON.parse(match[1]!) as { ops: unknown[][] }
    for (const op of frame.ops) {
      if (op[0] === 'add') visit(op[4] as never)
      else if (op[0] === 'del') drop(String(op[1]))
      else if (op[0] === 'set' && typeof op[1] === 'string') {
        const node = nodes.get(op[1])
        if (node !== undefined) node.p = { ...node.p, ...(op[2] as Record<string, unknown>) }
      } else if (op[0] === 'text' && typeof op[1] === 'string') {
        const node = nodes.get(op[1])
        if (node !== undefined) {
          node.p['text'] = op[2] === 'append'
            ? `${String(node.p['text'] ?? '')}${String(op[3] ?? '')}`
            : String(op[3] ?? '')
        }
      }
    }
  }
  return [...nodes.values()]
}

const nodeText = (node: { p: Record<string, unknown>; c?: unknown[] }): string => {
  const parts: string[] = []
  const visit = (current: { p: Record<string, unknown>; c?: unknown[] }): void => {
    if (typeof current.p['text'] === 'string') parts.push(current.p['text'])
    for (const child of current.c ?? []) visit(child as never)
  }
  visit(node)
  return parts.join(' ')
}

/**
 * The configured DisplayPreset must travel the WHOLE production chain:
 * `tuiConfig.displayPreset` → the real Runner ConfigPort → `resolveDisplayPreset`
 * → the ONE `displayState` → `productionTspConnector` → the mounted renderer →
 * the SDK frame. A real Composer Enter drives a real Agent turn whose scripted
 * model requests the REAL registered `job_list` tool, so the Compact frame has
 * a genuine Process Work span to disclose.
 */
for (const preset of ['compact', 'full', 'focus'] as const) {
  test(`a real configured displayPreset '${preset}' reaches the TSP Main frame after a real Agent tool turn`, async (t) => {
    const { testLifecycle } = await import('../support/temp-lifecycle.ts')
    const life = testLifecycle(t)
    const fixture = await createDirectTspFixture(life, {
      tuiConfig: { displayPreset: preset },
      deltas: ['MODE-', 'DIRECT-', 'OK'],
      scriptedToolCall: { callId: 'call-mode-jobs', name: 'job_list', arguments: '{}' },
    })
    const recorder = fixture.recordPrompts(() => {})
    try {
      await waitForInputDelivery(fixture.pane)
      fixture.pane.input.type('list the background jobs')
      await waitFor('the composer to hold the typed draft', () =>
        latestComposerText(fixture.pane.output.text()) === 'list the background jobs', 25_000)
      // NEGATIVE CONTROL: neither the scripted reply nor the tool row exists
      // before the gesture, so the later frame is caused by the real submit.
      assert.ok(!fixture.pane.output.text().includes('MODE-DIRECT-OK'), 'no assistant text before the submit')
      assert.equal(recorder.calls(), 0, 'no prompt write before the submit')
      assert.equal(liveNodes(fixture.pane.output.text()).filter(node => node.k === 'section' && node.p['collapsible'] === true).length, 0,
        'no Activity section before the submit')

      fixture.pane.input.type('\r')
      await waitFor('the committed prompt write to settle', () => recorder.calls() === 1, 30_000)
      // The REAL registered tool executed and the loop's next step streamed the
      // scripted reply: both are wire facts, not the adapter's request counter.
      // The mode-specific container is the preset's own frame evidence.
      const modeFrame = (): boolean => {
        const wire = fixture.pane.output.text()
        return wire.includes('MODE-DIRECT-OK')
          && (preset === 'compact'
            ? wire.includes('s1-work-msg-')
            : preset === 'focus' ? wire.includes('s1-focus-msg-') : wire.includes('"k":"tool"'))
      }
      await waitFor('the real Agent tool turn and scripted reply', modeFrame, 30_000)
      await directSettle(1_500)

      const nodes = liveNodes(fixture.pane.output.text())
      const activities = nodes.filter(node => node.k === 'section' && node.p['collapsible'] === true)
      const tools = nodes.filter(node => node.k === 'tool')
      assert.ok(nodes.some(node => nodeText(node).includes('MODE-DIRECT-OK')), 'the scripted assistant reply reached Main')
      assert.ok(nodes.some(node => nodeText(node).includes('list the background jobs')), 'the real user row reached Main')
      if (preset === 'compact') {
        assert.ok(activities.length >= 1, 'the configured Compact preset produced a native collapsible Activity')
        assert.ok(activities.every(node => node.p['collapsed'] === true), 'the Activity defaults collapsed')
        assert.ok(activities.some(node => node.id.includes('-work-')), 'the Activity key carries the canonical Work owner')
        assert.equal(tools.length, 0, 'a collapsed Activity builds no hidden Tool node')
      } else if (preset === 'focus') {
        const roots = activities.filter(node => node.id.includes('-focus-'))
        assert.equal(roots.length, 1, 'the configured Focus preset produced one native Turn root')
        assert.equal(roots[0]!.p['collapsed'], true, 'the Focus root defaults collapsed')
        assert.equal(tools.length, 0, 'a collapsed Focus root builds no hidden Tool node')
        const finalCards = nodes.filter(node => node.k === 'card' && nodeText(node).includes('MODE-DIRECT-OK'))
        assert.equal(finalCards.length, 1, 'the official final appears exactly once as an independent Assistant card')
        assert.ok(!finalCards[0]!.id.startsWith(`${roots[0]!.id}.`), 'the official final remains outside the Focus root')
      } else {
        assert.equal(activities.length, 0, 'the configured Full preset paints no Work/Activity container')
        assert.ok(tools.length >= 1, 'Full keeps the real Tool row flat in the reading flow')
        assert.ok(tools.some(node => nodeText(node).includes('job_list') || node.id.includes('-msg-')),
          'the real tool row is a top-level scoped node')
      }
    } finally {
      recorder.detach()
      await fixture.settle()
    }
  })
}

test('real Direct reasoning and Tool settlement keep Full and Compact TSP identities across live chunks', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  for (const preset of ['full', 'compact'] as const) {
    let releaseArguments!: () => void
    const heldArguments = new Promise<void>(resolve => { releaseArguments = resolve })
    let releaseLatestReasoning!: () => void
    const heldLatestReasoning = new Promise<void>(resolve => { releaseLatestReasoning = resolve })
    let latestReasoningReached = false
    const fixture = await createDirectTspFixture(life, {
      tuiConfig: { displayPreset: preset },
      deltas: [`DIRECT-${preset.toUpperCase()}-`, 'FINAL'],
      scriptedToolCalls: [{
        text: `DIRECT-${preset.toUpperCase()}-REASONING-STEP`,
        toolCall: { callId: `reasoned-${preset}`, name: 'job_list', arguments: '{}' },
      }],
      scriptedReasoningDeltas: ['checking the first row\n', 'latest reasoning line'],
      holdScriptedReasoningDelta: async (step, deltaIndex) => {
        if (step === 0 && deltaIndex === 1) {
          latestReasoningReached = true
          await heldLatestReasoning
        }
      },
      holdScriptedToolCallArguments: async step => { if (step === 0) await heldArguments },
    })
    life.defer(() => {
      releaseLatestReasoning()
      releaseArguments()
    })
    const promptRecords: Array<{
      readonly sessionId: string
      readonly sessionEvents: () => readonly { readonly type: string; readonly data?: unknown }[]
    }> = []
    const recorder = fixture.recordPrompts(call => {
      promptRecords.push({ sessionId: call.sessionId, sessionEvents: call.sessionEvents })
    })
    try {
      await waitForInputDelivery(fixture.pane)
      const wire = (): string => fixture.pane.output.text()
      const nodes = (): ReturnType<typeof liveNodes> => liveNodes(wire())
      const submit = async (text: string, ordinal: number): Promise<void> => {
        fixture.pane.input.type(text)
        await waitFor(`the production Composer holds prompt ${ordinal}`, () => latestComposerText(wire()) === text, 25_000)
        assert.equal(recorder.calls(), ordinal - 1, `prompt ${ordinal} has not been written before its Enter`)
        fixture.pane.input.type('\r')
        await waitFor(`the real Direct Session writer settles prompt ${ordinal}`, () => recorder.calls() === ordinal, 30_000)
      }
      await submit(`inspect Direct transcript in ${preset}`, 1)
      await waitFor('the production Direct Agent enters its scripted step', () => fixture.modelCalls() === 1, 30_000)
      await waitFor('the official Direct sequence is holding its second reasoning delta', () => latestReasoningReached, 10_000)
      assert.deepEqual(fixture.reasoningChunks().filter(chunk => chunk.step === 0).map(chunk => chunk.text),
        ['checking the first row\n'], 'the second reasoning source chunk remains behind its test-owned stream gate')
      assert.equal(promptRecords[0]!.sessionEvents().some(event => event.type === 'assistant/message'
        || event.type === 'tool/call'), false,
      'partial reasoning and tool-call deltas have not yet become durable Assistant or Tool events')
      await waitFor('the first real reasoning prefix materializes in the current SDK Main tree', () =>
        [...nodes().values()].some(node => node.k === 'section' && nodeText(node).includes('checking the first row')), 10_000)
      assert.equal(nodes().some(node => node.k === 'tool'), false,
        'a partial tool-call delta has no durable native Tool before official tool/call')

      const toggleCurrent = (id: string, collapsed: boolean): void => {
        const frame = JSON.parse([...wire().matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)].at(-1)![1]!) as { sf: string }
        fixture.pane.input.type(`\u001b_tsp;e;${JSON.stringify({ ev: 'toggle', sf: frame.sf, id, collapsed, raw: {} })}\u001b\\`)
      }
      let sections = nodes().filter(node => node.k === 'section')
      if (preset !== 'full') {
        const works = nodes().filter(node => node.k === 'section' && String(node.p['key']).includes('work-'))
        assert.ok(works.length > 0, `${preset} exposes its canonical Work for the live reasoning row`)
        for (const work of works) {
          if (work.p['collapsed'] === true) {
            toggleCurrent(work.id, false)
            await waitFor('the exact Compact/Focus Activity opens during live reasoning', () => nodes().some(node => node.id === work.id && node.p['collapsed'] === false))
          }
        }
      }

      sections = nodes().filter(node => node.k === 'section')
      const thought = sections.find(node => /^(?:s\d+-)?msg-\d+$/u.test(String(node.p['key']))
        && nodeText(node).includes('checking the first row'))
      assert.ok(thought !== undefined, `${preset} exposes its current Thinking prefix: ${JSON.stringify(sections.map(node => ({ id: node.id, key: node.p['key'], text: nodeText(node) })))}`)
      const stableThoughtId = thought.id
      assert.equal(thought.p['collapsed'], true,
        `the exact transient Thinking Section starts independently closed: ${JSON.stringify(thought)}`)
      toggleCurrent(stableThoughtId, false)
      await waitFor('the exact Thinking Section opens while the real Direct reasoning stream is still held', () =>
        nodes().some(node => node.id === stableThoughtId && node.p['collapsed'] === false))
      await waitFor('Thinking body materializes while the real Direct reasoning stream is still held', () =>
        nodes().some(node => node.id === `${stableThoughtId}.body`))
      let liveThinkingTree = nodes()
      let liveThinkingBody = liveThinkingTree.find(node => node.id === `${stableThoughtId}.body`)
      assert.ok(liveThinkingBody !== undefined && String(liveThinkingBody.p['text']).includes('checking the first row'))
      assert.equal(liveThinkingBody.p['stream'], true, 'the open exact Section owns the current transient reasoning prefix')
      assert.equal(liveThinkingTree.find(node => node.id === stableThoughtId)?.p['collapsed'], false)
      assert.equal(promptRecords[0]!.sessionEvents().some(event => event.type === 'assistant/message'
        || event.type === 'tool/call'), false,
      'the live partial reasoning has not become a durable Session Assistant or Tool event')

      releaseLatestReasoning()
      await waitFor('the Direct adapter emitted the released second reasoning source chunk', () =>
        fixture.reasoningChunks().filter(chunk => chunk.step === 0).length === 2, 10_000)
      assert.deepEqual(fixture.reasoningChunks().filter(chunk => chunk.step === 0).map(chunk => chunk.text),
        ['checking the first row\n', 'latest reasoning line'], 'the released official stream delivered its second source chunk')
      await waitFor('the same exact Section body advances to the second official reasoning delta', () => {
        const current = nodes()
        const body = current.find(node => node.id === `${stableThoughtId}.body`)
        return current.find(node => node.id === stableThoughtId)?.p['collapsed'] === false
          && typeof body?.p['text'] === 'string'
          && String(body.p['text']).includes('latest reasoning line')
      }, 10_000).catch(error => {
        const current = nodes()
        const frames = [...wire().matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)]
          .map(match => JSON.parse(match[1]!) as { s?: number; ops?: unknown[][] })
          .map(frame => ({ s: frame.s, ops: frame.ops?.filter(op => String(op[1]).startsWith(stableThoughtId)) }))
          .filter(frame => (frame.ops?.length ?? 0) > 0)
        throw new Error(`${error.message}; source=${JSON.stringify(fixture.reasoningChunks())}; thought=${JSON.stringify(current.find(node => node.id === stableThoughtId))}; body=${JSON.stringify(current.find(node => node.id === `${stableThoughtId}.body`))}; thinkingFrames=${JSON.stringify(frames)}`)
      })
      liveThinkingTree = nodes()
      liveThinkingBody = liveThinkingTree.find(node => node.id === `${stableThoughtId}.body`)
      assert.equal(liveThinkingTree.find(node => node.id === stableThoughtId)?.id, stableThoughtId,
        'both streamed reasoning chunks update the same stable SDK Section id')
      assert.ok(String(liveThinkingBody?.p['text']).includes('checking the first row\nlatest reasoning line'))
      assert.equal(liveThinkingBody?.p['stream'], true, 'the same open detail body remains live before official tool/final settlement')
      assert.equal(promptRecords[0]!.sessionEvents().some(event => event.type === 'assistant/message'
        || event.type === 'tool/call'), false,
      'the two reasoning chunks remain transient until the real tool-call block settles')

      releaseArguments()
      await waitFor('the official Direct Session commits reasoning and Tool call/result', () => {
        const events = promptRecords[0]!.sessionEvents()
        const serial = JSON.stringify(events)
        return events.some(event => event.type === 'assistant/message' && serial.includes('latest reasoning line'))
          && events.some(event => event.type === 'tool/call' && serial.includes(`reasoned-${preset}`))
          && events.some(event => event.type === 'tool/result' && serial.includes(`reasoned-${preset}`))
      }, 30_000)
      await waitFor('the Agent finishes its official Tool and final turn', () =>
        wire().includes(`DIRECT-${preset.toUpperCase()}-FINAL`), 30_000)
      if (preset !== 'full') {
        const currentWorks = nodes().filter(node => node.k === 'section' && String(node.p['key']).includes('work-'))
        assert.ok(currentWorks.length > 0, `${preset} keeps the current canonical Work visible after settlement`)
        for (const work of currentWorks) {
          if (work.p['collapsed'] === true) {
            toggleCurrent(work.id, false)
            await waitFor('the exact settled Work opens before its durable Tool is queried', () =>
              nodes().some(node => node.id === work.id && node.p['collapsed'] === false))
          }
        }
      }
      const settledTree = nodes()
      const settledThinkingBody = settledTree.find(node => node.id === `${stableThoughtId}.body`)
      assert.equal(settledTree.find(node => node.id === stableThoughtId)?.p['collapsed'], false,
        'the user-open Thinking preference survives the authoritative settlement')
      assert.ok(typeof settledThinkingBody?.p['text'] === 'string'
        && settledThinkingBody.p['text'].includes('latest reasoning line'))
      assert.notEqual(settledThinkingBody?.p['stream'], true, 'the official Assistant event settles the same open body')
      const tools = settledTree.filter(node => node.k === 'tool' && node.p['name'] === 'job_list')
      assert.equal(tools.length, 1, `the completed ${preset} model call has one durable Tool after its ancestors are open: ${JSON.stringify(settledTree.filter(node => node.k === 'tool'))}`)
      const tool = tools[0]!
      assert.equal(tool.p['status'], 'done')
      assert.equal(tool.p['collapsed'], true, 'ordinary Tool details keep their independent closed owner')

      const toolFrame = JSON.parse([...wire().matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)].at(-1)![1]!) as { sf: string }
      fixture.pane.input.type(`\u001b_tsp;e;${JSON.stringify({ ev: 'toggle', sf: toolFrame.sf, id: tool.id, collapsed: false, raw: {} })}\u001b\\`)
      await waitFor('the Tool body appears after its exact toggle', () => nodes().some(node => node.id === `${tool.id}.result`))
      assert.ok(promptRecords[0]!.sessionId.length > 0, 'the real Direct writer records the controlling session')
    } finally {
      releaseArguments()
      recorder.detach()
    }
  }
})

test('the real Direct Focus stream holds its final outside the Thought until turn/end', async (t) => {
  const { testLifecycle } = await import('../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  let releaseStream!: () => void
  const heldStream = new Promise<void>(resolve => { releaseStream = resolve })
  const fixture = await createDirectTspFixture(life, {
    tuiConfig: { displayPreset: 'focus' },
    deltas: ['FOCUS-', 'DIRECT-', 'FINAL'],
    streamHold: () => heldStream,
    scriptedToolCall: { callId: 'call-focus-jobs', name: 'job_list', arguments: '{}' },
  })
  const recorder = fixture.recordPrompts(() => {})
  try {
    await waitForInputDelivery(fixture.pane)
    fixture.pane.input.type('inspect jobs before the final')
    await waitFor('the composer to hold the Focus prompt', () =>
      latestComposerText(fixture.pane.output.text()) === 'inspect jobs before the final', 25_000)
    fixture.pane.input.type('\r')
    await waitFor('the real Direct prompt write to settle', () => recorder.calls() === 1, 30_000)
    await waitFor('the official Agent starts the held post-tool stream', () => fixture.modelCalls() === 1, 30_000)
    await waitFor('the collapsed Focus root reaches the SDK wire', () =>
      liveNodes(fixture.pane.output.text()).some(node => node.k === 'section' && node.id.includes('-focus-')), 30_000)

    const heldWire = fixture.pane.output.text()
    const heldNodes = liveNodes(heldWire)
    const root = heldNodes.find(node => node.k === 'section' && node.id.includes('-focus-'))!
    assert.equal(root.p['collapsed'], true, 'the live Focus root remains collapsed while the model stream is held')
    assert.ok(!heldWire.includes('FOCUS-DIRECT-FINAL'), 'the final text is absent before the held model stream settles')
    assert.equal(heldNodes.filter(node => node.k === 'tool').length, 0, 'the collapsed real Direct root builds no hidden Tool node')

    releaseStream()
    await waitFor('the authoritative Direct final reaches the Main frame', () =>
      fixture.pane.output.text().includes('FOCUS-DIRECT-FINAL'), 30_000)
    const settledNodes = liveNodes(fixture.pane.output.text())
    const roots = settledNodes.filter(node => node.k === 'section' && node.id.includes('-focus-'))
    const finals = settledNodes.filter(node => node.k === 'card' && nodeText(node).includes('FOCUS-DIRECT-FINAL'))
    assert.equal(roots.length, 1, 'the same Direct turn keeps one Focus root occurrence')
    assert.equal(finals.length, 1, 'the authoritative final appears exactly once')
    assert.ok(!finals[0]!.id.startsWith(`${roots[0]!.id}.`), 'the final remains outside the Thought')
  } finally {
    releaseStream()
    recorder.detach()
    await fixture.settle()
  }
})
