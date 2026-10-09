/**
 * PR3-B B1 editor-input contract tests.
 *
 * Two layers over the SAME production code:
 *
 * 1. the composer reducer (`src/tui/tsp/editor.ts`) — grapheme/UTF-16
 *    cursor safety, gesture classification, paste atomicity, port members;
 * 2. the REAL SDK loop (`mountTspRenderer` over the scripted pane, the same
 *    fixture family as the live-mount suite) — decoded key/paste bytes →
 *    the reducer → the controlled `ui.editor` text/cursor on the wire →
 *    focus after the first dock render → the B1 submit refusal keeps the
 *    draft → teardown fences the loop.
 *
 * STANDS-IN: the pane is a scripted tty (not a real Tern terminal); the
 * application graph above the renderer is the PR3-A harness shape (no
 * submission wiring — B1 explicitly refuses submit gestures).
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-editor-input.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { connect as sdkConnect, concatBytes, ui } from '@stencil-hq/tern'
import type { Op, Session, TermInput, TermOutput } from '@stencil-hq/tern'
import { createTspComposer, type TspComposer } from '../src/tui/tsp/editor.ts'
import { mountTspRenderer, type TspRenderer } from '../src/tui/tsp/session.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

/** One decoded key as the SDK would deliver it. */
function key(name: string, modifiers: { ctrl?: boolean; shift?: boolean; alt?: boolean; text?: string } = {}): {
  readonly name: string
  readonly text?: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly meta: boolean
} {
  return {
    name,
    ...(modifiers.text === undefined ? {} : { text: modifiers.text }),
    ctrl: modifiers.ctrl === true,
    alt: modifiers.alt === true,
    shift: modifiers.shift === true,
    meta: false,
  }
}

/** A composer with recording sinks (the reducer layer's observer). */
function composerWithSinks(): { composer: TspComposer; pending: Array<string | undefined>; notices: string[] } {
  const pending: Array<string | undefined> = []
  const notices: string[] = []
  const composer = createTspComposer({
    setSubmitPending: detail => { pending.push(detail) },
    notify: text => { notices.push(text) },
  })
  return { composer, pending, notices }
}

// ── Layer 1: the reducer (pure composer semantics) ──────────────────────────

test('B1: printable keys insert at the caret; CJK and emoji are single edits', () => {
  const { composer } = composerWithSinks()
  composer.applyKey(key('a', { text: 'a' }))
  composer.applyKey(key('b', { text: 'b' }))
  assert.deepEqual(composer.state(), { text: 'ab', cursor: 2, focused: false })
  composer.applyKey(key('好', { text: '好' }))
  composer.applyKey(key('👍', { text: '👍' }))
  assert.deepEqual(composer.state(), { text: 'ab好👍', cursor: 5, focused: false },
    'CJK (1 UTF-16 unit) and emoji (surrogate pair) insert atomically')
})

test('B1: backspace/delete never split a surrogate pair or a ZWJ sequence', () => {
  const { composer } = composerWithSinks()
  // Type the content so the caret sits at the END: 'a' + family emoji (8
  // UTF-16 units, ONE grapheme) + 'b'.
  for (const ch of ['a', '👨‍👩‍👧', 'b']) composer.applyKey(key(ch, { text: ch }))
  assert.equal(composer.state().cursor, 10, 'the typed caret sits at the end')
  // First backspace consumes 'b'.
  composer.applyKey(key('backspace'))
  assert.deepEqual(composer.state(), { text: 'a👨‍👩‍👧', cursor: 9, focused: false })
  // The SECOND backspace consumes the WHOLE family cluster (8 UTF-16 units)
  // in ONE edit — never a lone surrogate half.
  composer.applyKey(key('backspace'))
  assert.deepEqual(composer.state(), { text: 'a', cursor: 1, focused: false },
    'the 8-unit ZWJ cluster left as one edit')
  // Delete at the END has nothing ahead of the caret (a no-op, never an
  // underflow); a caret mid-text consumes the whole following cluster.
  composer.applyKey(key('delete'))
  assert.deepEqual(composer.state(), { text: 'a', cursor: 1, focused: false })
  composer.applyKey(key('left'))
  composer.applyKey(key('delete'))
  assert.deepEqual(composer.state(), { text: '', cursor: 0, focused: false })
})

test('B1: left/right move by grapheme clusters, never by lone UTF-16 units', () => {
  const { composer } = composerWithSinks()
  for (const ch of ['a', '👍', 'b']) composer.applyKey(key(ch, { text: ch }))
  assert.equal(composer.state().cursor, 4)
  composer.applyKey(key('left'))
  assert.equal(composer.state().cursor, 3, 'left from the end lands before the ascii char b... wait: before b is index 3')
  composer.applyKey(key('left'))
  assert.equal(composer.state().cursor, 1, 'left again crosses the whole surrogate pair')
  composer.applyKey(key('right'))
  assert.equal(composer.state().cursor, 3, 'right crosses the whole surrogate pair again')
  composer.applyKey(key('right'))
  assert.equal(composer.state().cursor, 4)
})

test('B1: home/end operate on the containing line of a multi-line draft', () => {
  const { composer } = composerWithSinks()
  // Type 'one', newline (Shift+Enter), 'tw' so the caret is inside line 2.
  for (const ch of ['o', 'n', 'e']) composer.applyKey(key(ch, { text: ch }))
  composer.applyKey(key('enter', { shift: true }))
  for (const ch of ['t', 'w']) composer.applyKey(key(ch, { text: ch }))
  assert.equal(composer.state().text, 'one\ntw')
  assert.equal(composer.state().cursor, 6)
  composer.applyKey(key('home'))
  assert.equal(composer.state().cursor, 4, 'home lands after the newline (line 2 start)')
  composer.applyKey(key('end'))
  assert.equal(composer.state().cursor, 6, 'end lands at the line 2 tail')
  composer.applyKey(key('home'))
  composer.applyKey(key('home'))
  assert.equal(composer.state().cursor, 4, 'home at the line start is idempotent')
})

test('B1: Shift+Enter inserts a newline; Enter and Ctrl+Enter classify as gestures without mutating the draft', () => {
  const { composer } = composerWithSinks()
  composer.applyKey(key('enter', { shift: true }))
  assert.deepEqual(composer.state().text, '\n')
  const plain = composer.applyKey(key('enter'))
  assert.deepEqual(plain, { kind: 'submit', gesture: 'enter' })
  const accelerated = composer.applyKey(key('enter', { ctrl: true }))
  assert.deepEqual(accelerated, { kind: 'submit', gesture: 'accelerated' })
  assert.equal(composer.state().text, '\n', 'submit gestures never clear the draft themselves')
})

test('B1: bracketed paste is ONE atomic edit; command-looking content never dispatches', () => {
  const { composer } = composerWithSinks()
  const edit = composer.applyKey(key('paste', { text: '/exit\n!echo hi\nq' }))
  assert.deepEqual(edit, { kind: 'edited' })
  assert.deepEqual(composer.state().text, '/exit\n!echo hi\nq')
})

test('B1: Ctrl+D exits only on an empty draft; with text it is a no-op', () => {
  const { composer } = composerWithSinks()
  assert.deepEqual(composer.applyKey(key('d', { ctrl: true })), { kind: 'exit-empty' })
  composer.applyKey(key('x', { text: 'x' }))
  assert.deepEqual(composer.applyKey(key('d', { ctrl: true })), { kind: 'none' })
})

test('B1: unknown control keys are ignored, never literal escape text', () => {
  const { composer } = composerWithSinks()
  composer.applyKey(key('f3'))
  composer.applyKey(key('escape'))
  composer.applyKey(key('tab'))
  assert.deepEqual(composer.state(), { text: '', cursor: 0, focused: false })
})

test('B1: the port members — draft clamp, pending sink, settled no-op', () => {
  const { composer, pending, notices } = composerWithSinks()
  composer.setDraft('hello')
  assert.equal(composer.getDraft(), 'hello')
  // A LONGER replacement clamps the stale cursor into range.
  composer.setDraft('hi')
  assert.ok(composer.state().cursor <= 2)
  composer.setSubmitPending('submit')
  composer.setSubmitPending(undefined)
  assert.deepEqual(pending, ['submit', undefined])
  composer.notify('a notice')
  assert.deepEqual(notices, ['a notice'])
  // The B1 no-op (deliberate; the B0 P3-1 ruling): must not clear notices.
  composer.clearSettledLocalMessages()
  assert.deepEqual(notices, ['a notice'])
})

// ── Layer 2: the REAL SDK loop over the scripted pane ───────────────────────

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

interface WireFrame { readonly sf: string; readonly s: number; readonly ops: readonly Op[] }

function framesOf(text: string): WireFrame[] {
  const frames: WireFrame[] = []
  for (const match of text.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
    frames.push(JSON.parse(match[1]!) as WireFrame)
  }
  return frames
}

class ScriptedTern {
  readonly input = new FakeInput()
  readonly output = new FakeOutput()
  private queued = ''

  constructor() {
    this.output.chunks.length = 0
    const write = (bytes: Uint8Array): void => {
      const text = DECODER.decode(bytes)
      if (text.includes('\u001b[c')) {
        const pending = this.queued
        this.queued = ''
        setTimeout(() => this.input.type(`\u001b_tsp;r;${JSON.stringify(HELLO)}\u001b\\\u001b[?62;52;c${pending}`), 1)
        return
      }
      for (const frame of framesOf(text)) {
        setTimeout(() => this.input.type(
          `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
        ), 0)
      }
    }
    const originalWrite = this.output.write.bind(this.output)
    this.output.write = (data: Uint8Array | string): boolean => {
      originalWrite(data)
      write(typeof data === 'string' ? ENCODER.encode(data) : data)
      return true
    }
  }

  /** Bytes delivered in the SAME input chunk as the hello reply. */
  queueWithHandshake(bytes: string): void { this.queued += bytes }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await new Promise(resolve => setTimeout(resolve, 3))
}

interface PaneHarness {
  readonly renderer: TspRenderer
  readonly tern: ScriptedTern
  readonly session: Session
  exitCount(): number
  frames(): WireFrame[]
  dispose(): Promise<void>
}

async function mountPane(options: { withHandshake?: string } = {}): Promise<PaneHarness> {
  const tern = new ScriptedTern()
  const queued = options.withHandshake
  if (queued !== undefined) {
    // Deliver the key bytes in the SAME chunk as the hello reply (the
    // handshake-batch race: the SDK decodes the handshake AND the key in one
    // read; the input loop must consume the key only through the composer).
    tern.queueWithHandshake(queued)
  }
  const session = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null, 'the scripted pane is accepted by the shipped SDK')
  let exitCount = 0
  const renderer = mountTspRenderer(session, {
    requestExit: () => { exitCount += 1 },
  })
  await settle()
  return {
    renderer,
    tern,
    session,
    exitCount: () => exitCount,
    frames: () => framesOf(tern.output.text()),
    dispose: () => renderer.dispose(),
  }
}

/** The LAST committed composer props from the wire, reconstructed from the
 *  add/set/text ops the SDK emits (see the probe in the B1 evidence: add
 *  carries full props; edits are set+text op pairs). */
function lastEditorProps(frames: readonly WireFrame[]): { text?: string; cursor?: number } | undefined {
  let text: string | undefined
  let cursor: number | undefined
  let seen = false
  for (const frame of frames) {
    for (const op of frame.ops) {
      if (op[0] === 'add') {
        // ["add", parent, sf, after, node] — walk node children for the editor.
        const node = op[4] as { c?: unknown[] } | undefined
        const editor = node?.c?.find((child) => (child as { id?: string }).id === 'dock.composer')
        const props = (editor as { p?: { text?: string; cursor?: number } } | undefined)?.p
        if (props !== undefined) {
          text = props.text
          cursor = props.cursor
          seen = true
        }
      } else if (op[0] === 'set' && op[1] === 'dock.composer') {
        const props = op[2] as { text?: string; cursor?: number }
        if (props.text !== undefined) text = props.text
        if (props.cursor !== undefined) cursor = props.cursor
      } else if (op[0] === 'text' && op[1] === 'dock.composer') {
        // ["text", id, "replace"|"append", value]
        const action = op[2]
        const value = op[3] as string
        text = action === 'append' ? (text ?? '') + value : value
      }
    }
  }
  return seen ? { text, cursor } : undefined
}

/** Whether the wire carried the focus op for the composer node. */
function focusSeen(wireText: string): boolean {
  return /"focus","dock\.composer"/.test(wireText)
}

test('B1/L2: the dock renders the controlled editor and focuses it after the first frame', async () => {
  const harness = await mountPane()
  try {
    const wire = harness.tern.output.text()
    assert.ok(wire.length > 0, 'the first frame reached the wire')
    const editor = lastEditorProps(harness.frames())
    assert.ok(editor !== undefined, 'an editor node with props committed')
    assert.equal(editor.text, '', 'the controlled text starts empty')
    assert.ok(focusSeen(wire), 'the focus op for dock.composer is on the wire (after its first frame)')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('B1/L2: typed bytes flow through the SDK decoder into the controlled editor', async () => {
  const harness = await mountPane()
  try {
    harness.tern.input.type('hi')
    await settle()
    const editor = lastEditorProps(harness.frames())
    assert.equal(editor?.text, 'hi', 'the typed bytes reached the controlled editor text')
    harness.tern.input.type('好')
    await settle()
    const editor2 = lastEditorProps(harness.frames())
    assert.equal(editor2?.text, 'hi好', 'CJK input commits as one edit')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('B1/L2: Enter is refused with the explicit notice and the draft is preserved', async () => {
  const harness = await mountPane()
  try {
    harness.tern.input.type('draft text')
    await settle()
    harness.tern.input.type('\r')
    await settle()
    const wire = harness.tern.output.text()
    assert.ok(wire.includes('not wired for submission yet'), 'the B1 refusal notice is observable')
    const editor = lastEditorProps(harness.frames())
    assert.equal(editor?.text, 'draft text', 'the draft survives the refused submit gesture')
    assert.equal(harness.exitCount(), 0, 'a refused submit never exits')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('B1/L2: a paste stays one edit and never dispatches commands', async () => {
  const harness = await mountPane()
  try {
    // Bracketed paste bytes exactly as a terminal sends them.
    harness.tern.input.type('\u001b[200~/exit\rq\u001b[201~')
    await settle()
    const wire = harness.tern.output.text()
    const editor = lastEditorProps(harness.frames())
    // The SDK paste decoder preserves the raw '\r' bytes; the content is ONE
    // atomic draft edit, never dispatched as commands.
    assert.equal(editor?.text, '/exit\rq', 'the pasted bytes are draft content')
    assert.ok(!wire.includes('exit requested'), 'pasted command-looking text never dispatches')
    assert.equal(harness.exitCount(), 0)
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('B1/L2: Ctrl+C routes the exit intent; a typed q does not', async () => {
  const harness = await mountPane()
  try {
    harness.tern.input.type('q')
    await settle()
    assert.equal(harness.exitCount(), 0, 'q is editor text in B1')
    const editor = lastEditorProps(harness.frames())
    assert.equal(editor?.text, 'q')
    harness.tern.input.type('\x03')
    await settle()
    assert.equal(harness.exitCount(), 1, 'Ctrl+C routes the SAME exit orchestration')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('B1/L2: input after dispose is inert', async () => {
  const harness = await mountPane()
  await harness.dispose()
  await harness.session.close()
  const framesBefore = harness.frames().length
  harness.tern.input.type('late')
  await settle()
  assert.equal(harness.frames().length, framesBefore, 'no frame after disposal')
  assert.equal(harness.exitCount(), 0, 'a late key after dispose never exits')
})

test('B1/L2: a key batched with the SDK handshake is consumed through the composer', async () => {
  // The handshake-batch race (§3.3): bytes arriving in the SAME input chunk
  // as the hello reply are decoded by the SDK and delivered to the mounted
  // input loop — they must land in the composer, never bypass it.
  const harness = await mountPane({ withHandshake: 'x' })
  try {
    const editor = lastEditorProps(harness.frames())
    assert.equal(editor?.text, 'x', 'the early key became draft content after the mount')
    assert.equal(harness.exitCount(), 0)
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('B1/L2: an early Ctrl+D in the handshake batch routes the legal exit', async () => {
  // A legal early quit during the PR3-A compatibility window still routes
  // through the same exit controller (empty draft — nothing was typed yet).
  const harness = await mountPane({ withHandshake: '\x04' })
  try {
    await settle()
    assert.equal(harness.exitCount(), 1, 'the early empty-draft Ctrl+D routed the exit intent')
  } finally {
    await harness.dispose().catch(() => {})
    await harness.session.close().catch(() => {})
  }
})
