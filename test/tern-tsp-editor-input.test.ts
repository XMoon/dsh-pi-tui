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
function composerWithSinks(): { composer: TspComposer; pending: Array<string | undefined>; notices: string[]; changes: () => number } {
  const pending: Array<string | undefined> = []
  const notices: string[] = []
  let changeCount = 0
  const composer = createTspComposer({
    onChanged: () => { changeCount += 1 },
    setSubmitPending: detail => { pending.push(detail) },
    notify: text => { notices.push(text) },
  })
  return { composer, pending, notices, changes: () => changeCount }
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

// ── F1: the cursor-boundary invariant (real-SDK reachable shapes) ────────────

test('B1/F1: paste a combining mark, Home, type a letter — the merged cluster never strands its mark', () => {
  // The reviewer's REAL-SDK probe shape: bracketed-paste U+0301 (combining
  // acute), Home, then 'a' merges into ONE grapheme 'á'. The caret must land
  // at the merged cluster's END and backspace consumes the WHOLE cluster.
  const { composer } = composerWithSinks()
  composer.applyKey(key('paste', { text: '\u0301' }))
  composer.applyKey(key('home'))
  composer.applyKey(key('a', { text: 'a' }))
  // 'a' + U+0301 is ONE grapheme; the caret sits at its end (2), not inside.
  assert.equal(composer.state().text, 'a\u0301')
  assert.equal(composer.state().cursor, 2, 'the caret normalized to the merged cluster end')
  // Backspace consumes the WHOLE cluster — no lone combining mark remains.
  composer.applyKey(key('backspace'))
  assert.deepEqual(composer.state(), { text: '', cursor: 0, focused: false })
})

test('B1/F1: setEditorText with a shorter surrogate text keeps the caret boundary-aligned', () => {
  // The reviewer's second REAL shape: type 'x' (caret 1), then
  // setEditorText('👍') — the numeric clamp would keep 1, INSIDE the pair.
  const { composer } = composerWithSinks()
  composer.applyKey(key('x', { text: 'x' }))
  composer.setEditorText('👍')
  assert.equal(composer.state().cursor, 2, 'the clamp normalized forward to the cluster end')
  composer.applyKey(key('backspace'))
  assert.deepEqual(composer.state(), { text: '', cursor: 0, focused: false },
    'backspace consumed the whole surrogate pair — no lone \\udc4d remains')
})

test('B1/F1: insertIntoEditor merging with a following combining cluster keeps the caret aligned', () => {
  // Insertion may MERGE with the following cluster (a ZWJ/combining suffix):
  // the caret must end at the merged cluster's end, never inside it.
  const { composer } = composerWithSinks()
  composer.setDraft('\u0301') // a lone combining mark (paste shape)
  composer.applyKey(key('home'))
  composer.insertIntoEditor('a')
  assert.equal(composer.state().text, 'a\u0301')
  assert.equal(composer.state().cursor, 2, 'the inserted letter merged with the mark; caret at the cluster end')
  composer.applyKey(key('backspace'))
  assert.deepEqual(composer.state(), { text: '', cursor: 0, focused: false })
})

test('B1/F1: deleting a separator that FUSES two clusters keeps the caret boundary-aligned', () => {
  // The round-2 probe shape: '🇦x🇧' (two flag halves separated by 'x').
  // Deleting the separator merges the regional indicators into ONE flag
  // cluster; the caret must normalize onto the fused boundary so a
  // following backspace consumes the WHOLE flag, never a partial one.
  const { composer } = composerWithSinks()
  for (const ch of ['🇦', 'x', '🇧']) composer.applyKey(key(ch, { text: ch }))
  assert.equal(composer.state().text, '🇦x🇧')
  // Delete at the caret (end, cursor 4) removes nothing ahead; use Delete at
  // cursor 2 (after 🇦, before x) — removes 'x' and fuses 🇦+🇧.
  composer.applyKey(key('home'))                    // cursor 0
  composer.applyKey(key('right'))                   // cursor 2 (after 🇦)
  const edit = composer.applyKey(key('delete'))     // removes 'x'; 🇦🇧 fuse
  assert.deepEqual(edit, { kind: 'edited' })
  const fused = composer.state()
  assert.equal(fused.text, '🇦🇧', 'the separator removal fused the indicators')
  assert.ok(fused.cursor === 0 || fused.cursor === 4,
    `the caret normalized onto a fused-cluster boundary (got ${fused.cursor})`)
  // Whatever the boundary, a following backspace consumes a WHOLE cluster —
  // never a lone surrogate half.
  if (fused.cursor > 0) composer.applyKey(key('backspace'))
  const after = composer.state()
  assert.ok(!/\uD83C|\uD83E|\uDDE6|\uDDE7/.test(after.text) || after.text === '',
    'no partial flag remains after the backspace')
})

// ── F2: every port mutator commits an authoritative render ───────────────────

test('B1/F2: setDraft/setEditorText/insertIntoEditor each notify exactly one render', () => {
  const { composer, changes } = composerWithSinks()
  const before = changes()
  composer.setDraft('one')
  const afterSet = changes()
  assert.equal(afterSet - before, 1, 'setDraft rendered once')
  composer.setEditorText('two')
  assert.equal(changes() - afterSet, 1, 'setEditorText rendered once')
  const afterReplace = changes()
  composer.insertIntoEditor('!')
  assert.equal(changes() - afterReplace, 1, 'insertIntoEditor rendered once')
  // Reads never render.
  const afterInsert = changes()
  composer.getDraft()
  composer.state()
  assert.equal(changes(), afterInsert, 'reads do not render')
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
  userInputs(): number
  dispose(): Promise<void>
}

async function mountPane(options: { withHandshake?: string; bind?: boolean } = {}): Promise<PaneHarness> {
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
  let userInputs = 0
  const renderer = mountTspRenderer(session, {
    requestExit: () => { exitCount += 1 },
  })
  // The SurfaceRuntime.start commit point binds the input projection (the
  // default mirrors production); the F4 tests opt out to drive the window.
  if (options.bind !== false) {
    renderer.bindInput({
      exit: () => { exitCount += 1 },
      noteUserInput: () => { userInputs += 1 },
    })
  }
  await settle()
  return {
    renderer,
    tern,
    session,
    exitCount: () => exitCount,
    userInputs: () => userInputs,
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

test('B1/L2/F2: the composer-port mutators reach the wire through the real SDK chain', async () => {
  const harness = await mountPane()
  try {
    harness.tern.input.type('old')
    await settle()
    assert.equal(lastEditorProps(harness.frames())?.text, 'old')
    const framesBefore = harness.frames().length
    // The F2 regression: a programmatic port mutation MUST commit a new
    // controlled frame — not only getDraft() (the B2 draft-restore path
    // depends on this being visible). No notice/pending side effects.
    harness.renderer.composer.setEditorText('restored draft')
    await settle()
    const frames = harness.frames()
    assert.ok(frames.length > framesBefore, 'the port mutation committed a new frame')
    assert.equal(lastEditorProps(frames)?.text, 'restored draft', 'the wire carries the restored text')
    // setDraft and insertIntoEditor share the same sink.
    harness.renderer.composer.setDraft('two')
    await settle()
    assert.equal(lastEditorProps(harness.frames())?.text, 'two')
    harness.renderer.composer.insertIntoEditor('!')
    await settle()
    assert.equal(lastEditorProps(harness.frames())?.text, 'two!')
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

// ── F4: the editor-local/lifecycle binding and the held pre-bind window ─────

test('B1/L2/F4: keys before the bind are HELD, then consumed exactly once at the bind', async () => {
  // No bind yet (bind: false mirrors a connect that outlived the startup
  // commit): the typed keys must NOT reach the editor — they wait.
  const harness = await mountPane({ bind: false })
  try {
    harness.tern.input.type('held')
    await settle()
    assert.equal(lastEditorProps(harness.frames())?.text, '', 'a pre-bind key never edits the composer')
    assert.equal(harness.userInputs(), 0, 'no user activity is observed before the bind')
    // The bind consumes the held keys ONCE, in arrival order.
    harness.renderer.bindInput({ exit: () => {}, noteUserInput: () => {} })
    await settle()
    assert.equal(lastEditorProps(harness.frames())?.text, 'held', 'the bind consumed the held keys')
    // A second bind is refused — exactly ONE input owner.
    assert.throws(() => harness.renderer.bindInput({ exit: () => {}, noteUserInput: () => {} }),
      /already bound/, 'a second bind throws')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('B1/L2/F4: a dispose before the bind discards the held keys unconsumed', async () => {
  const harness = await mountPane({ bind: false })
  harness.tern.input.type('doomed')
  await harness.dispose()
  await harness.session.close()
  const framesBefore = harness.frames().length
  // A late bind after dispose is refused; the held keys died with the renderer.
  assert.throws(() => harness.renderer.bindInput({ exit: () => {}, noteUserInput: () => {} }), /disposed/)
  harness.tern.input.type('late')
  await settle()
  assert.equal(harness.frames().length, framesBefore, 'nothing renders after dispose — the queue was discarded')
})

test('B1/L2/F4: the bound exit handler routes the composer exit gesture', async () => {
  const tern = new ScriptedTern()
  const session = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null)
  // SEPARATE counters: the renderer's injected requestExit and the BOUND
  // exit handler are different observers — a shared counter would green
  // even if the bound handler were never called (the round-2 review's
  // false-green finding).
  let rendererExits = 0
  let boundExits = 0
  const renderer = mountTspRenderer(session, { requestExit: () => { rendererExits += 1 } })
  renderer.bindInput({ exit: () => { boundExits += 1 }, noteUserInput: () => {} })
  await settle()
  try {
    tern.input.type('a')
    await settle()
    tern.input.type('\x03') // Ctrl+C: the exit intent
    await settle()
    assert.equal(boundExits, 1, 'the BOUND exit handler observed the exit gesture')
    assert.equal(rendererExits, 0, 'the bound path does NOT also fire the injected requestExit')
  } finally {
    await renderer.dispose()
    await session.close()
  }
})

test('B1/L2/F4: real user input is observed only through the bound projection', async () => {
  const harness = await mountPane()
  try {
    harness.tern.input.type('a')
    await settle()
    assert.ok(harness.userInputs() >= 1, 'an editable key observed as user activity')
    const before = harness.userInputs()
    // Pure unknown CONTROL sequences (no printable text): no activity.
    harness.tern.input.type('\x1b\x1b[Z')
    await settle()
    assert.equal(harness.userInputs(), before, 'unknown control keys are not user activity')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('B1/L2/F4: a held key orders the pre-bind Ctrl+D — no exit before the bind replays it', async () => {
  // The round-2 ordered-semantics finding: a held 'a' (not yet applied) plus
  // Ctrl+D must NOT pre-bind-exit on the empty live draft — the gesture's
  // emptiness depends on the held edits and re-decides IN ARRIVAL ORDER at
  // the bind.
  const harness = await mountPane({ bind: false })
  try {
    harness.tern.input.type('a')
    await settle()
    harness.tern.input.type('\x04') // Ctrl+D with a held non-empty draft pending
    await settle()
    assert.equal(harness.exitCount(), 0, 'no pre-bind exit while the held key makes the draft non-empty')
    // The bind replays 'a' then Ctrl+D in order: 'a' applies, Ctrl+D meets a
    // NON-empty draft and is an editor no-op — still no exit.
    harness.renderer.bindInput({ exit: () => {}, noteUserInput: () => {} })
    await settle()
    assert.equal(harness.exitCount(), 0, 'the replayed Ctrl+D saw the applied draft and did not exit')
    const editor = lastEditorProps(harness.frames())
    assert.equal(editor?.text, 'a', 'the held key applied at the bind, in order')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('B1/L2: the empty-draft Ctrl+D exit shape (the real-pane v4 tail) through the bound loop', async () => {
  // The exact shape the real-pane smoke's tail exercised: type two chars,
  // clear them with backspaces, then \x04 — ONE exit, after the draft is
  // truly empty. (The real pane's Control+d chord delivers no byte — the
  // PR1 tool limitation — so this scripted lane is the exit-path proof.)
  const harness = await mountPane()
  try {
    harness.tern.input.type('ab')
    await settle()
    harness.tern.input.type('\x7f\x7f')
    await settle()
    assert.equal(lastEditorProps(harness.frames())?.text, '', 'the draft cleared')
    harness.tern.input.type('\x04')
    await settle()
    assert.equal(harness.exitCount(), 1, 'the empty-draft Ctrl+D routed exactly one exit')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('B1/L2/F4: a pre-bind input flood fails loud ONCE and still replays the held prefix', async () => {
  const harness = await mountPane({ bind: false })
  try {
    // Over 128 held keys: the 129th trips the ONE observable overflow notice.
    harness.tern.input.type('a'.repeat(200))
    await settle()
    const wire = harness.tern.output.text()
    assert.ok(wire.includes('were dropped'), 'the overflow is observable (fail loud), not a silent drop')
    harness.renderer.bindInput({ exit: () => {}, noteUserInput: () => {} })
    await settle()
    const editor = lastEditorProps(harness.frames())
    assert.equal(editor?.text, 'a'.repeat(128), 'the held PREFIX (the bounded queue) still replayed at the bind')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})
