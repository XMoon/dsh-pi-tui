/**
 * PR3-B B2 submission-path tests.
 *
 * These run the REAL TSP renderer over the scripted pane (shipped SDK connect)
 * so the submit gesture, its ordering and the rollback are exercised through
 * the renderer's own composer and the real `mountTspRenderer` wiring — not
 * through a hand-built state machine. The application side of the submit path
 * (the ONE `SubmissionController`) is covered by the runner-interactive suite;
 * here the interest is the RENDERER half of the contract:
 *
 *   1. the §3.4 ordering: snapshot → clear → callback, never a stale restore;
 *   2. rollback: a refusal that merges the draft back shows up as live draft
 *      content again, and the next submit re-sends the merged text;
 *   3. no double-send: an accepted submit leaves an empty composer, so a
 *      second Enter in the same gesture window submits nothing new.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-submission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { connect as sdkConnect, concatBytes, type TermInput, type TermOutput } from '@stencil-hq/tern'
import { mountTspRenderer, type TspRenderer } from '../src/tui/tsp/session.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

class FakeInput extends EventEmitter implements TermInput {
  readonly isTTY = true
  isRaw = false
  setRawMode(mode: boolean): void { this.isRaw = mode }
  type(text: string): void { this.emit('data', ENCODER.encode(text)) }
}

class FakeOutput implements TermOutput {
  readonly isTTY = true
  readonly columns = 100
  readonly chunks: Uint8Array[] = []
  write(data: Uint8Array | string): boolean {
    this.chunks.push(typeof data === 'string' ? ENCODER.encode(data) : data)
    return true
  }
  text(): string { return DECODER.decode(concatBytes(this.chunks)) }
}

const HELLO = {
  r: 'hello', v: 1, term: 'tern', ver: '0.6.2',
  kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'editor', 'input', 'text'],
  features: ['flow', 'styles', 'paste'],
  apc: 65536, credits: 2, cols: 120, cell: { w: 8, h: 17 },
  dark: true, reduceMotion: false, hour12: false,
}

/** The controlled editor text the wire last committed for `dock.composer`. */
function lastComposerText(wire: string): string | undefined {
  let text: string | undefined
  for (const match of wire.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    const frame = JSON.parse(match[1]!) as { ops: unknown[][] }
    for (const op of frame.ops) {
      if (op[0] === 'add') {
        const node = op[4] as { c?: Array<{ id?: string; p?: { text?: string } }> } | undefined
        const editor = node?.c?.find(child => child.id === 'dock.composer')
        if (editor?.p?.text !== undefined) text = editor.p.text
      } else if (op[0] === 'set' && op[1] === 'dock.composer') {
        const props = op[2] as { text?: string }
        if (props.text !== undefined) text = props.text
      } else if (op[0] === 'text' && op[1] === 'dock.composer') {
        const action = op[2]
        const value = op[3] as string
        text = action === 'append' ? (text ?? '') + value : value
      }
    }
  }
  return text
}

interface Harness {
  readonly renderer: TspRenderer
  readonly input: FakeInput
  readonly output: FakeOutput
  readonly session: Awaited<ReturnType<typeof sdkConnect>>
  dispose(): Promise<void>
}

async function mountPane(onSubmit: (text: string, request: string) => void): Promise<Harness> {
  const input = new FakeInput()
  const output = new FakeOutput()
  // ONE pass-through wrapper: the original write keeps capturing the wire
  // (output.text() below reads it), the wrapper additionally answers the DA1
  // probe and acks every frame — only the tty boundary is simulated.
  const originalWrite = output.write.bind(output)
  output.write = (data): boolean => {
    originalWrite(data)
    const bytes = typeof data === 'string' ? ENCODER.encode(data) : data
    const text = DECODER.decode(bytes)
    if (text.includes('\u001b[c')) {
      setTimeout(() => input.type(`\u001b_tsp;r;${JSON.stringify(HELLO)}\u001b\\\u001b[?62;52;c`), 1)
      return true
    }
    for (const match of text.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
      const frame = JSON.parse(match[1]!) as { sf: string; s: number }
      setTimeout(() => input.type(
        `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
      ), 0)
    }
    return true
  }
  const session = await sdkConnect({ env: {}, input, output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  const renderer = mountTspRenderer(session, { requestExit: () => {} })
  renderer.bindInput({
    exit: () => {},
    cancel: () => {},
    submit: (text, request) => onSubmit(text, request),
    steer: () => {},
    noteUserInput: () => {},
  })
  return {
    renderer,
    input,
    output,
    session,
    dispose: async () => { await renderer.dispose(); await session.close() },
  }
}

async function settle(millis = 300): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, millis))
}

test('B2: the submit callback observes an EMPTY composer (clear-before-callback ordering)', async () => {
  const seen: Array<{ text: string; draftAtCallback: string }> = []
  const harness = await mountPane((text) => {
    seen.push({ text, draftAtCallback: harness.renderer.composer.getDraft() })
  })
  try {
    harness.input.type('ordered text')
    await settle()
    harness.input.type('\r')
    await settle()
    assert.deepEqual(seen, [{ text: 'ordered text', draftAtCallback: '' }],
      'one submit; the composer was already cleared when the callback ran')
    assert.equal(harness.renderer.composer.getDraft(), '')
  } finally {
    await harness.dispose()
  }
})

test('B2: a refusal that merges the draft back becomes live content and is re-submittable', async () => {
  // The refusal path the real controller uses for an unsupported builtin or a
  // `!` line: merge the submitted text into the live draft and notify. The
  // renderer must show that merged draft again (no stale pre-callback
  // snapshot winning over it) and the next Enter must re-send the merged text.
  const submissions: string[] = []
  let refuseOnce = true
  const harness = await mountPane((text) => {
    submissions.push(text)
    if (refuseOnce) {
      refuseOnce = false
      // Exactly what the controller's refusal does: merge back into the LIVE
      // composer (read → merge → write), never restore a snapshot.
      harness.renderer.composer.setDraft(`${harness.renderer.composer.getDraft()}${text}`)
    }
  })
  try {
    harness.input.type('!echo hi')
    await settle()
    harness.input.type('\r')
    await settle()
    assert.deepEqual(submissions, ['!echo hi'], 'the refused line reached the submit path once')
    assert.equal(harness.renderer.composer.getDraft(), '!echo hi',
      'the refusal merged the line back into the live composer')
    assert.equal(lastComposerText(harness.output.text()), '!echo hi',
      'the merged draft is on the wire again (the renderer never re-applied a stale snapshot)')
    harness.input.type('\r')
    await settle()
    assert.deepEqual(submissions, ['!echo hi', '!echo hi'],
      'the next Enter re-sends the restored text (a real second submission, not a replay of the first)')
  } finally {
    await harness.dispose()
  }
})

test('B2: an accepted submit leaves an empty composer, so a second Enter cannot double-send', async () => {
  // The receiver mirrors the existing application admission: an EMPTY
  // serialized draft is a silent no-op (`dispatchUserInput`'s guard), so a
  // second Enter on the already-cleared composer can never produce a second
  // send. The renderer's job is only to hand over the (empty) draft.
  const delivered: string[] = []
  const harness = await mountPane((text) => { if (text.trim() !== '') delivered.push(text) })
  try {
    harness.input.type('once')
    await settle()
    harness.input.type('\r')
    await settle()
    assert.deepEqual(delivered, ['once'], 'the first Enter delivered the draft exactly once')
    assert.equal(harness.renderer.composer.getDraft(), '')
    harness.input.type('\r')
    await settle()
    assert.deepEqual(delivered, ['once'],
      'the second Enter handed over an EMPTY draft (the application no-ops it) — no duplicate send')
  } finally {
    await harness.dispose()
  }
})

// ── The session/hydration input fence (§3.4 row 1) ──────────────────────────

test('B2: the hydration window accepts NO composer key and never submits', async () => {
  const submissions: string[] = []
  const harness = await mountPane((text) => { submissions.push(text) })
  try {
    harness.input.type('draft before the switch')
    await settle()
    assert.equal(harness.renderer.composer.getDraft(), 'draft before the switch')
    // A generation bump: the surface reports the hydration window (the new
    // subject's frame has not committed yet).
    harness.renderer.display.beginSessionHydration()
    await settle()
    harness.input.type('more')
    await settle()
    assert.equal(harness.renderer.composer.getDraft(), 'draft before the switch',
      'the fence preserves the outgoing draft and accepts no edit')
    harness.input.type('\r')
    await settle()
    assert.deepEqual(submissions, [], 'no submit can cross the hydration fence')
  } finally {
    await harness.dispose()
  }
})

test('B2: the fence lifts when the new subject commits, and the composer works again', async () => {
  const submissions: string[] = []
  const harness = await mountPane((text) => { submissions.push(text) })
  try {
    harness.renderer.display.beginSessionHydration()
    await settle()
    harness.input.type('typed during the switch')
    await settle()
    assert.equal(harness.renderer.composer.getDraft(), '', 'still fenced')
    // The new subject commits a projection: the fence lifts.
    harness.renderer.display.setTranscript([], undefined, undefined, undefined, undefined, { subject: 'new' })
    await settle()
    harness.input.type('after the switch')
    await settle()
    assert.equal(harness.renderer.composer.getDraft(), 'after the switch',
      'input is accepted again once the new subject committed')
    harness.input.type('\r')
    await settle()
    assert.deepEqual(submissions, ['after the switch'],
      'a submit after the fence lift reaches the application normally')
  } finally {
    await harness.dispose()
  }
})
