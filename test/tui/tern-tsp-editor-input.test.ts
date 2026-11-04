/**
 * PR3-B B1 editor-input contract tests.
 *
 * Two layers over the SAME production code:
 *
 * 1. the composer reducer (`src/tui/tsp/editor.ts`) — grapheme/UTF-16
 *    cursor safety, gesture classification, paste atomicity, port members,
 *    and the ↑/↓ recall of the mount's history scope;
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
import { createTspComposer, type TspComposer } from '../../src/tui/tsp/editor.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import type { PastedPathReceipt } from '../../src/app/surface/pasted-image-intake.ts'

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

/** The recall port a reducer-layer composer reads: the scope snapshot is
 *  newest-first and the admission is the application's paste/plain-history
 *  policy. Both are the mount's, never a second history store. */
interface ComposerRecallOptions {
  readonly entries?: readonly string[]
  readonly admitDraft?: (text: string) => boolean
}

/** A composer with recording sinks (the reducer layer's observer). */
function composerWithSinks(options: ComposerRecallOptions = {}): {
  composer: TspComposer
  pending: Array<string | undefined>
  notices: string[]
  changes: () => number
  /** Every draft the reducer asked the application to admit for recall. */
  admissions: () => readonly string[]
  /** Replace the newest-first scope snapshot the composer reads. */
  setEntries(entries: readonly string[]): void
} {
  const pending: Array<string | undefined> = []
  const notices: string[] = []
  const admitted: string[] = []
  let changeCount = 0
  let entries: readonly string[] = options.entries ?? []
  const composer = createTspComposer({
    onChanged: () => { changeCount += 1 },
    setSubmitPending: detail => { pending.push(detail) },
    notify: text => { notices.push(text) },
  }, {
    entries: () => entries,
    admitDraft: (text) => {
      admitted.push(text)
      return options.admitDraft === undefined ? true : options.admitDraft(text)
    },
  })
  return {
    composer,
    pending,
    notices,
    changes: () => changeCount,
    admissions: () => admitted,
    setEntries: (next) => { entries = next },
  }
}

/** Every legal caret position of `text` (each grapheme cluster start plus the
 *  text end) — the boundary set a cursor must always land on. */
function caretBoundaries(text: string): number[] {
  const seen = new Set<number>([0, text.length])
  for (const { index } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)) seen.add(index)
  return [...seen].sort((left, right) => left - right)
}

// ── Layer 1: the reducer (pure composer semantics) ──────────────────────────

test('printable keys insert at the caret; CJK and emoji are single edits', () => {
  const { composer } = composerWithSinks()
  composer.applyKey(key('a', { text: 'a' }))
  composer.applyKey(key('b', { text: 'b' }))
  assert.deepEqual(composer.state(), { text: 'ab', cursor: 2, focused: false })
  composer.applyKey(key('好', { text: '好' }))
  composer.applyKey(key('👍', { text: '👍' }))
  assert.deepEqual(composer.state(), { text: 'ab好👍', cursor: 5, focused: false },
    'CJK (1 UTF-16 unit) and emoji (surrogate pair) insert atomically')
})

test('backspace/delete never split a surrogate pair or a ZWJ sequence', () => {
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

test('left/right move by grapheme clusters, never by lone UTF-16 units', () => {
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

test('home/end operate on the containing line of a multi-line draft', () => {
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

test('Shift+Enter inserts a newline; Enter and Ctrl+Enter classify as gestures without mutating the draft', () => {
  const { composer } = composerWithSinks()
  composer.applyKey(key('enter', { shift: true }))
  assert.deepEqual(composer.state().text, '\n')
  const plain = composer.applyKey(key('enter'))
  assert.deepEqual(plain, { kind: 'submit', gesture: 'enter' })
  const accelerated = composer.applyKey(key('enter', { ctrl: true }))
  assert.deepEqual(accelerated, { kind: 'submit', gesture: 'accelerated' })
  assert.equal(composer.state().text, '\n', 'submit gestures never clear the draft themselves')
})

test('bracketed paste is ONE atomic edit; command-looking content never dispatches', () => {
  const { composer } = composerWithSinks()
  const edit = composer.applyKey(key('paste', { text: '/exit\n!echo hi\nq' }))
  assert.deepEqual(edit, { kind: 'edited' })
  assert.deepEqual(composer.state().text, '/exit\n!echo hi\nq')
})

test('Ctrl+D exits only on an empty draft; with text it is a no-op', () => {
  const { composer } = composerWithSinks()
  assert.deepEqual(composer.applyKey(key('d', { ctrl: true })), { kind: 'exit-empty' })
  composer.applyKey(key('x', { text: 'x' }))
  assert.deepEqual(composer.applyKey(key('d', { ctrl: true })), { kind: 'none' })
})

test('unknown control keys are ignored, never literal escape text', () => {
  const { composer } = composerWithSinks()
  composer.applyKey(key('f3'))
  composer.applyKey(key('escape'))
  composer.applyKey(key('tab'))
  assert.deepEqual(composer.state(), { text: '', cursor: 0, focused: false })
})

test('the port members — draft clamp, pending sink, settled no-op', () => {
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

test('paste a combining mark, Home, type a letter — the merged cluster never strands its mark', () => {
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

test('setEditorText with a shorter surrogate text keeps the caret boundary-aligned', () => {
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

test('insertIntoEditor merging with a following combining cluster keeps the caret aligned', () => {
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

test('End never lands inside a pasted CRLF cluster; backspace keeps it whole', () => {
  // The round-3 REAL-SDK probe shape: paste 'a\r\nb' (the bracketed paste
  // preserves the raw CRLF; Intl.Segmenter treats the pair as ONE grapheme).
  // End on line 1 must stop at the CR (cursor 1), never at the LF position
  // (2) — and a following backspace removes 'a' leaving the CRLF intact.
  const { composer } = composerWithSinks()
  composer.applyKey(key('paste', { text: 'a\r\nb' }))
  assert.equal(composer.state().cursor, 4, 'the pasted caret sits at the text end (a boundary)')
  composer.applyKey(key('home'))
  assert.equal(composer.state().cursor, 3, 'Home from line 2 lands at its line start (after the whole CRLF)')
  composer.applyKey(key('home'))
  assert.equal(composer.state().cursor, 3, 'Home at the line start is idempotent')
  // Walk LEFT across the CRLF as ONE cluster onto line 1, then End there.
  composer.applyKey(key('left'))
  assert.equal(composer.state().cursor, 1, 'left crossed the CRLF cluster as one unit')
  composer.applyKey(key('end'))
  assert.equal(composer.state().cursor, 1, 'End stopped BEFORE the complete CRLF cluster (at the CR)')
  composer.applyKey(key('backspace'))
  assert.deepEqual(composer.state(), { text: '\r\nb', cursor: 0, focused: false },
    'backspace removed only the line content — the CRLF cluster is intact')
  // Symmetry: right crosses the CRLF as one cluster; Home on line 2 lands
  // AFTER the whole pair; Delete at the line-1 end consumes the WHOLE pair.
  composer.setDraft('a\r\nb')
  // The previous section left the caret at 0 (line 1). Walk to the text
  // end through the CRLF so the navigation below starts from a known spot.
  composer.applyKey(key('end'))           // line-1 end (1)
  composer.applyKey(key('right'))         // crosses the CRLF → 3
  composer.applyKey(key('end'))           // line-2 end (4)
  assert.equal(composer.state().cursor, 4)
  composer.applyKey(key('home'))          // cursor 4 → line-2 start (3)
  composer.applyKey(key('left'))          // crosses the CRLF as one unit → 1
  assert.equal(composer.state().cursor, 1, 'left crossed the CRLF as one cluster')
  composer.applyKey(key('right'))         // 1 → 3, the whole pair again
  assert.equal(composer.state().cursor, 3, 'right crossed the CRLF as one cluster')
  composer.applyKey(key('home'))
  assert.equal(composer.state().cursor, 3, 'Home on line 2 stays after the complete CRLF')
  composer.applyKey(key('left'))
  composer.applyKey(key('delete'))        // at cursor 1: consumes the CRLF whole
  assert.deepEqual(composer.state(), { text: 'ab', cursor: 1, focused: false },
    'delete consumed the CRLF as one unit')
})

test('deleting a separator that FUSES two clusters keeps the caret boundary-aligned', () => {
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

test('setDraft/setEditorText/insertIntoEditor each notify exactly one render', () => {
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
// ── The ↑/↓ recall of the mount's scope snapshot ─────────────────────────────

test('the first ↑ recalls the NEWEST scope entry, a repeated ↑ walks older, ↓ walks newer', () => {
  const { composer } = composerWithSinks({ entries: ['new', 'old'] })
  composer.applyKey(key('up'))
  assert.deepEqual(composer.state(), { text: 'new', cursor: 0, focused: false },
    'the first ↑ takes index 0 of the newest-first snapshot — never the oldest row')
  composer.applyKey(key('up'))
  assert.deepEqual(composer.state(), { text: 'old', cursor: 0, focused: false })
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: 'new', cursor: 3, focused: false },
    '↓ goes newer again and lands that row\'s caret at its end')
})

test('a draft whose caret is not at the line start takes Home first, and ↓ restores that exact draft and caret', () => {
  const { composer } = composerWithSinks({ entries: ['new', 'old'] })
  composer.setDraft('draft')
  const original = composer.state()
  assert.deepEqual(original, { text: 'draft', cursor: 5, focused: false })
  assert.deepEqual(composer.applyKey(key('up')), { kind: 'edited' }, 'Home is an edit, never a submit gesture')
  assert.deepEqual(composer.state(), { text: 'draft', cursor: 0, focused: false },
    'the first ↑ only moved the caret — the draft is still the user\'s own')
  composer.applyKey(key('up'))
  assert.equal(composer.state().text, 'new', 'the second ↑ enters the recall')
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), original,
    'leaving index 0 restores the pre-browse draft with its EXACT caret')
})

test('a multi-line draft moves by logical lines before the recall boundary, keeping a grapheme column', () => {
  const { composer, admissions } = composerWithSinks({ entries: ['first', 'second'] })
  composer.setDraft('a\n👍xy')
  assert.equal(composer.state().cursor, 6)
  composer.applyKey(key('home'))
  assert.equal(composer.state().cursor, 2, 'Home landed on the second line\'s start (after the whole newline)')
  composer.applyKey(key('right'))
  assert.equal(composer.state().cursor, 4, 'the emoji cluster is one step')

  composer.applyKey(key('up'))
  assert.deepEqual(composer.state(), { text: 'a\n👍xy', cursor: 1, focused: false },
    '↑ moved to the previous logical line — the recall was never consulted')
  assert.deepEqual(admissions(), [], 'a vertical caret move runs no application policy')

  composer.applyKey(key('down'))
  assert.equal(composer.state().cursor, 4,
    'the kept column is counted in GRAPHEMES (after 👍), never in UTF-16 units (which would strand the caret inside the pair)')
  assert.deepEqual(composer.applyKey(key('up')), { kind: 'edited' })
  assert.equal(composer.state().cursor, 1)

  composer.applyKey(key('up'))
  assert.deepEqual(composer.state(), { text: 'a\n👍xy', cursor: 0, focused: false },
    'on the first line, ↑ first lands on the line start')
  assert.deepEqual(admissions(), [], 'still no recall before the boundary')
  composer.applyKey(key('up'))
  assert.deepEqual(composer.state(), { text: 'first', cursor: 0, focused: false }, 'the next ↑ at the boundary enters the recall')
  assert.deepEqual(admissions(), ['a\n👍xy'], 'the entry into the first row asked the application about the live draft')
})

test('every ↑/↓/Home/End target across CRLF, emoji, ZWJ and combining text is a grapheme boundary', () => {
  const { composer } = composerWithSinks()
  const drafts = ['one\r\ntwo', '👨‍👩‍👧\nflag', 'e\u0301g\nbas']
  for (const draft of drafts) {
    composer.setDraft(draft)
    const boundaries = caretBoundaries(draft)
    const seen: number[] = []
    for (const step of ['home', 'end', 'up', 'down', 'up', 'left', 'right', 'down', 'end'] as const) {
      composer.applyKey(key(step))
      seen.push(composer.state().cursor)
    }
    assert.equal(composer.state().text, draft, 'a pure movement never changed the draft')
    for (const cursor of seen) {
      assert.ok(boundaries.includes(cursor),
        `a movement of ${JSON.stringify(draft)} landed at ${cursor}, inside a cluster`)
    }
  }
})

test('a draft with a mid-line caret returns unchanged after walking the whole recall', () => {
  const { composer } = composerWithSinks({ entries: ['x', 'y', 'z'] })
  composer.setDraft('a👍b')
  composer.applyKey(key('left'))
  const original = composer.state()
  assert.deepEqual(original, { text: 'a👍b', cursor: 3, focused: false })
  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  assert.equal(composer.state().text, 'x')
  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  assert.equal(composer.state().text, 'z', 'walking past the oldest row is a no-op, not a wrap')
  composer.applyKey(key('down'))
  composer.applyKey(key('down'))
  assert.equal(composer.state().text, 'x', 'walking to the newest row stops there')
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), original,
    'the pre-browse draft returns byte-identical with its original caret, and the focus never flipped')
})

test('a real edit during browsing ends the browse and leaves the recalled row editable', () => {
  const { composer } = composerWithSinks({ entries: ['r1', 'r2'] })
  composer.setDraft('scratch')
  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  assert.equal(composer.state().text, 'r1')
  composer.applyKey(key('end'))
  composer.applyKey(key('X', { text: 'X' }))
  assert.deepEqual(composer.state(), { text: 'r1X', cursor: 3, focused: false })
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: 'r1X', cursor: 3, focused: false },
    '↓ cannot resurrect the superseded scratch draft')

  for (const [step, expected] of [['backspace', 'r'], ['delete', '1'], ['paste', 'Zr1']] as const) {
    composer.applyKey(key('up'))
    composer.applyKey(key('up'))
    assert.equal(composer.state().text, 'r1', `the ${step} case starts from a recalled row`)
    if (step === 'backspace') composer.applyKey(key('end'))
    composer.applyKey(step === 'paste' ? key('paste', { text: 'Z' }) : key(step))
    assert.equal(composer.state().text, expected, `the ${step} edited the recalled row`)
    composer.applyKey(key('down'))
    assert.equal(composer.state().text, expected, `a ${step} ended the browse: no stale draft returns`)
  }
})

test('Shift+Enter during browsing keeps the recalled text editable and drops the stale bookmark', () => {
  const { composer } = composerWithSinks({ entries: ['r1', 'r2'] })
  composer.setDraft('scratch')
  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  composer.applyKey(key('end'))
  composer.applyKey(key('enter', { shift: true }))
  assert.deepEqual(composer.state(), { text: 'r1\n', cursor: 3, focused: false })
  composer.applyKey(key('down'))
  assert.equal(composer.state().text, 'r1\n', 'the newline edit ended the browse; ↓ cannot restore the scratch draft')
})

test('cursor keys during browsing neither end the browse nor repaint on a no-op', () => {
  const { composer, changes } = composerWithSinks({ entries: ['aaa', 'bbb'] })
  composer.applyKey(key('up'))
  assert.deepEqual(composer.state(), { text: 'aaa', cursor: 0, focused: false })
  const painted = changes()
  assert.deepEqual(composer.applyKey(key('left')), { kind: 'none' }, 'Left at the text start is a no-op')
  assert.deepEqual(composer.applyKey(key('home')), { kind: 'none' }, 'Home at the line start is a no-op')
  assert.equal(changes(), painted, 'a no-op cursor key paints nothing')
  assert.deepEqual(composer.applyKey(key('end')), { kind: 'edited' })
  assert.equal(changes(), painted + 1, 'the real move painted exactly one frame')
  assert.deepEqual(composer.applyKey(key('right')), { kind: 'none' }, 'Right at the text end is a no-op')
  assert.equal(changes(), painted + 1, 'and that no-op painted nothing')
  composer.applyKey(key('up'))
  assert.deepEqual(composer.state(), { text: 'bbb', cursor: 0, focused: false },
    'the browse survived the cursor keys and still goes older')
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: 'aaa', cursor: 3, focused: false }, 'and ↓ from its last line goes newer again')
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: '', cursor: 0, focused: false }, 'one more returns the draft entered from')
})

test('a programmatic draft write drops the browse bookmark and keeps the end-caret rule', () => {
  const { composer, changes } = composerWithSinks({ entries: ['r1', 'r2'] })
  composer.setDraft('scratch')
  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  assert.equal(composer.state().text, 'r1')

  composer.setDraft('later')
  assert.deepEqual(composer.state(), { text: 'later', cursor: 5, focused: false }, 'a replacement still lands the caret at the end')
  composer.applyKey(key('down'))
  assert.equal(composer.state().text, 'later', 'the pre-replacement scratch draft is unreachable')
  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: 'later', cursor: 5, focused: false },
    'the new bookmark is the programmatic draft, with the caret it held when the browse began')

  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  assert.equal(composer.state().text, 'r1', 'browsing again')
  composer.insertIntoEditor('!')
  assert.equal(composer.state().text, '!r1', 'insertIntoEditor writes at the caret')
  composer.applyKey(key('down'))
  assert.equal(composer.state().text, '!r1', 'insertIntoEditor ended the browse too')

  composer.setDraft('scratch')
  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  assert.equal(composer.state().text, 'r1')
  const beforeClear = changes()
  composer.clearDraftStateOnly()
  assert.deepEqual(composer.state(), { text: '', cursor: 0, focused: false })
  assert.equal(changes(), beforeClear, 'clearDraftStateOnly stayed pure — no repaint')
  composer.applyKey(key('down'))
  assert.equal(composer.state().text, '', 'the cleared draft has no bookmark to restore')
})

test('invalidateRecallNavigation retires the browse state without touching the text or repainting', () => {
  const { composer, changes } = composerWithSinks({ entries: ['r1', 'r2'] })
  composer.setDraft('mine')
  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  assert.equal(composer.state().text, 'r1')
  const before = changes()
  composer.invalidateRecallNavigation()
  assert.deepEqual(composer.state(), { text: 'r1', cursor: 0, focused: false }, 'the recalled text and caret are untouched')
  assert.equal(changes(), before, 'the invalidation painted nothing')
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: 'r1', cursor: 2, focused: false },
    'the retired bookmark cannot restore the outgoing owner\'s draft')
})

test('a refused or reentrant admission leaves the live draft with no selection', () => {
  const refused = composerWithSinks({ entries: ['r1'], admitDraft: () => false })
  refused.composer.setDraft('staged <img 1>')
  refused.composer.applyKey(key('home'))
  const before = refused.changes()
  assert.deepEqual(refused.composer.applyKey(key('up')), { kind: 'none' })
  assert.deepEqual(refused.composer.state(), { text: 'staged <img 1>', cursor: 0, focused: false },
    'a refused admission keeps the draft and its caret exactly')
  assert.equal(refused.changes(), before, 'a refused admission repaints nothing')
  assert.deepEqual(refused.admissions(), ['staged <img 1>'], 'only the entry into the first row asked the application')
  refused.composer.applyKey(key('down'))
  assert.equal(refused.composer.state().text, 'staged <img 1>', 'a refused entry started no browse for ↓ to undo')

  let rewrote = false
  let target!: TspComposer
  const reentrant = composerWithSinks({
    entries: ['r1', 'r2'],
    admitDraft: (text) => {
      if (!rewrote) {
        rewrote = true
        target.setDraft('written by the callback')
      }
      return true
    },
  })
  target = reentrant.composer
  target.setDraft('mine')
  target.applyKey(key('home'))
  assert.deepEqual(target.applyKey(key('up')), { kind: 'none' })
  assert.deepEqual(target.state(), { text: 'written by the callback', cursor: 23, focused: false },
    'a draft the admission callback itself replaced is never overwritten by the stale gesture')

  // The dropped gesture must leave no bookmark either: the next entry records
  // and restores what the user has NOW.
  target.applyKey(key('up'))
  target.applyKey(key('up'))
  assert.equal(target.state().text, 'r1', 'the next attempt enters the recall')
  target.applyKey(key('down'))
  assert.deepEqual(target.state(), { text: 'written by the callback', cursor: 23, focused: false },
    'the discarded bookmark cannot resurrect the pre-callback draft')
})

test('a refused entry leaves no pending bookmark for the next successful entry', () => {
  let admit = false
  const { composer } = composerWithSinks({ entries: ['r1'], admitDraft: () => admit })
  composer.setDraft('staged <img 1>')
  composer.applyKey(key('home'))
  assert.deepEqual(composer.applyKey(key('up')), { kind: 'none' }, 'the refused entry moves nothing')
  assert.deepEqual(composer.state(), { text: 'staged <img 1>', cursor: 0, focused: false })

  admit = true
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: 'staged <img 1>', cursor: 14, focused: false })
  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  assert.equal(composer.state().text, 'r1', 'the next attempt does enter the recall')
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: 'staged <img 1>', cursor: 14, focused: false },
    'the entry restores the LIVE draft and caret, not the position the refusal discarded')
})

test('an empty scope leaves no pending bookmark behind for the moment rows arrive', () => {
  const { composer, setEntries } = composerWithSinks()
  composer.setDraft('mine')
  composer.applyKey(key('home'))
  assert.deepEqual(composer.applyKey(key('up')), { kind: 'none' }, 'no candidate means no browse')

  setEntries(['r1'])
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: 'mine', cursor: 4, focused: false })
  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  assert.equal(composer.state().text, 'r1')
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: 'mine', cursor: 4, focused: false },
    'the empty-scope walk left no bookmark that could outlive the caret it recorded')
})

test('an empty scope and an out-of-range walk are silent no-ops', () => {
  const { composer, changes, admissions } = composerWithSinks()
  const before = changes()
  assert.deepEqual(composer.applyKey(key('up')), { kind: 'none' })
  assert.deepEqual(composer.applyKey(key('down')), { kind: 'none' })
  assert.equal(changes(), before, 'no entries means no render')
  assert.deepEqual(admissions(), [], 'an empty scope runs no application policy at all')

  const two = composerWithSinks({ entries: ['a', 'b'] })
  two.composer.applyKey(key('up'))
  two.composer.applyKey(key('up'))
  const atOldest = two.changes()
  assert.deepEqual(two.composer.state(), { text: 'b', cursor: 0, focused: false })
  two.composer.applyKey(key('up'))
  assert.deepEqual(two.composer.state(), { text: 'b', cursor: 0, focused: false }, 'past the oldest row nothing changes')
  assert.equal(two.changes(), atOldest, 'and the no-op painted nothing')
  two.composer.applyKey(key('down'))
  assert.deepEqual(two.composer.state(), { text: 'a', cursor: 1, focused: false }, 'back to the newest row')
  two.composer.applyKey(key('down'))
  assert.deepEqual(two.composer.state(), { text: '', cursor: 0, focused: false }, 'and one more restores the entered draft')
  const afterRestore = two.changes()
  two.composer.applyKey(key('down'))
  assert.deepEqual(two.composer.state(), { text: '', cursor: 0, focused: false }, 'below the draft there is nothing newer')
  assert.equal(two.changes(), afterRestore, 'and that no-op painted nothing')
})

test('a multi-line history row moves its caret by line before it changes row', () => {
  const { composer } = composerWithSinks({ entries: ['a\nb', 'x'] })
  composer.applyKey(key('up'))
  assert.deepEqual(composer.state(), { text: 'a\nb', cursor: 0, focused: false })
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: 'a\nb', cursor: 2, focused: false },
    '↓ first moved to the row\'s own second line, still on the same entry')
  composer.applyKey(key('up'))
  assert.equal(composer.state().cursor, 0, '↑ moved back to its first line')
  composer.applyKey(key('up'))
  assert.deepEqual(composer.state(), { text: 'x', cursor: 0, focused: false }, 'at that boundary ↑ went to the OLDER row')
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: 'a\nb', cursor: 3, focused: false }, 'a newer row lands the caret at its end')
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: '', cursor: 0, focused: false }, 'and leaving index 0 restores the pre-browse draft')
})

test('a modified arrow keeps its existing meaning and never routes the recall', () => {
  const { composer, changes, admissions } = composerWithSinks({ entries: ['r1'] })
  const before = changes()
  for (const modifiers of [{ ctrl: true }, { alt: true }, { shift: true }, { ctrl: true, alt: true }]) {
    assert.deepEqual(composer.applyKey(key('up', modifiers)), { kind: 'none' })
    assert.deepEqual(composer.applyKey(key('down', modifiers)), { kind: 'none' })
  }
  assert.equal(changes(), before, 'no modified arrow painted anything')
  assert.deepEqual(admissions(), [], 'no modified arrow consulted the application')
  assert.deepEqual(composer.state(), { text: '', cursor: 0, focused: false })
})

test('a recall gesture is never a submission: only the Enter family classifies as submit', () => {
  const { composer } = composerWithSinks({ entries: ['r1', 'r2'] })
  for (const step of ['up', 'down', 'up', 'up', 'down', 'down'] as const) {
    assert.notEqual(composer.applyKey(key(step)).kind, 'submit', `${step} never submits`)
  }
  composer.setDraft('submit me')
  assert.deepEqual(composer.applyKey(key('enter')), { kind: 'submit', gesture: 'enter' },
    'the ordinary Enter gesture classification is unchanged by the recall')
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
  cancels(): number
  /** PR4: how many times the Ctrl+V media intent reached the application. */
  pasteMedia(): number
  /** Every real bracketed-paste receipt forwarded to the application. */
  pastedPaths(): readonly PastedPathReceipt[]
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
  let cancelCount = 0
  let pasteMediaCalls = 0
  const pastedPaths: PastedPathReceipt[] = []
  const renderer = mountTspRenderer(session, { copyVisual: async () => false,
    requestExit: () => { exitCount += 1 },
  })
  // The SurfaceRuntime.start commit point binds the input projection (the
  // default mirrors production); the F4 tests opt out to drive the window.
  if (options.bind !== false) {
    renderer.bindInput({
      exit: () => { exitCount += 1 },
      cancel: () => { cancelCount += 1 },
      submit: () => {},
      steer: () => {},
      pasteMedia: () => { pasteMediaCalls += 1 },
      pastedPath: (receipt) => { pastedPaths.push(receipt) },
      admitPastedPathDelivery: () => true, shouldRememberInput: () => true,
      noteUserInput: () => { userInputs += 1 }, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true
    })
  }
  await settle()
  return {
    renderer,
    tern,
    session,
    exitCount: () => exitCount,
    userInputs: () => userInputs,
    cancels: () => cancelCount,
    pasteMedia: () => pasteMediaCalls,
    pastedPaths: () => pastedPaths,
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

test('the dock renders the controlled editor and focuses it after the first frame', async () => {
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

test('typed bytes flow through the SDK decoder into the controlled editor', async () => {
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

test('one accepted edit calls Surface.render exactly ONCE (no double render)', async () => {
  // The round-6 review's discriminating-power ruling: a WIRE-frame count
  // cannot detect a duplicate render (the SDK's diff suppresses empty
  // updates — verified by the reviewer's probe). Observe the REAL
  // production-created Surface's render CALLS instead: wrap session.open
  // (the consumer-production path) so the surface mountTspRenderer creates
  // carries a counting render wrapper; the receiver is preserved through
  // the original function reference.
  const tern = new ScriptedTern()
  const session = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null)
  let renderCalls = 0
  const originalOpen = session.open
  session.open = function (this: typeof session, options: Parameters<typeof session.open>[0]) {
    const surface = originalOpen.call(this, options)
    const originalRender = surface.render
    surface.render = function (this: typeof surface, view: Parameters<typeof surface.render>[0]) {
      renderCalls += 1
      return originalRender.call(this, view)
    }
    return surface
  }
  const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {} })
  renderer.bindInput({ exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {}, pasteMedia: () => {}, pastedPath: () => {}, admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true })
  await settle()
  const baseline = renderCalls
  tern.input.type('h')
  await settle()
  assert.equal(renderCalls - baseline, 1, `one accepted edit = exactly one Surface.render call (got ${renderCalls - baseline})`)
  tern.input.type('i')
  await settle()
  assert.equal(renderCalls - baseline, 2, 'the second edit added exactly one more render call')
  const editor = lastEditorProps(framesOf(tern.output.text()))
  assert.equal(editor?.text, 'hi', 'the edits still landed')
  await renderer.dispose()
  await session.close()
})

test('the composer-port mutators reach the wire through the real SDK chain', async () => {
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

test('a bound Enter submits the snapshot and clears the composer BEFORE the callback', async () => {
  // §3.4 submission gesture ordering: snapshot, clear, then callback — the
  // callback observes an EMPTY composer (a synchronous restore merges into
  // it rather than being erased by a post-callback clear).
  const tern = new ScriptedTern()
  const session = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null)
  const submissions: Array<{ text: string; request: string; draftAtCallback: string }> = []
  const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {} })
  renderer.bindInput({
    exit: () => {},
    cancel: () => {},
    submit: (text, request) => { submissions.push({ text, request, draftAtCallback: renderer.composer.getDraft() }) },
    steer: () => {},
    pasteMedia: () => {},
    pastedPath: () => {},
    admitPastedPathDelivery: () => true, shouldRememberInput: () => true,
    noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true
  })
  await settle()
  try {
    tern.input.type('draft text')
    await settle()
    assert.equal(renderer.composer.getDraft(), 'draft text')
    tern.input.type('\r')
    await settle()
    assert.deepEqual(submissions, [{ text: 'draft text', request: 'enter', draftAtCallback: '' }],
      'one submit with the serialized draft; the composer was already empty at the callback')
    assert.equal(renderer.composer.getDraft(), '', 'the draft stays cleared after the submit')
    // Ctrl+Enter is the same one-submit path with the accelerated gesture.
    tern.input.type('again')
    await settle()
    tern.input.type('\u001b[13;5u') // kitty ctrl+enter (the modern encoding)
    await settle()
    assert.equal(submissions.length, 2, 'the accelerated chord submitted once')
    assert.equal(submissions[1]!.request, 'accelerated')
    assert.equal(submissions[1]!.text, 'again')
  } finally {
    await renderer.dispose()
    await session.close()
  }
})

test('a PRE-BIND Enter is held and submits at the bind, never before it', async () => {
  // Nothing may reach the application before the commit-point binding
  // exists: the pre-bind Enter waits in the held queue and is applied (as a
  // real submission) only when bindInput consumes the queue in order.
  const tern = new ScriptedTern()
  const session = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null)
  const heldSubmits: string[] = []
  const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => {} })
  try {
    tern.input.type('draft text\r')
    await settle()
    assert.deepEqual(heldSubmits, [] as string[], 'no submission before the bind')
    assert.equal(renderer.composer.getDraft(), '', 'the held keys never touched the composer')
    renderer.bindInput({
      exit: () => {}, cancel: () => {},
      submit: (text: string) => { heldSubmits.push(text) },
      steer: () => {}, pasteMedia: () => {}, pastedPath: () => {}, admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true
    })
    await settle()
    assert.deepEqual(heldSubmits, ['draft text'] as string[], 'the held keys replayed in order: the text then the submit')
  } finally {
    await renderer.dispose()
    await session.close()
  }
})

test('a paste stays one edit and never dispatches commands', async () => {
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

test('a bound Ctrl+C cancels (never exits); a typed q does not', async () => {
  const harness = await mountPane()
  try {
    harness.tern.input.type('q')
    await settle()
    assert.equal(harness.exitCount(), 0, 'q is editor text in B1')
    const editor = lastEditorProps(harness.frames())
    assert.equal(editor?.text, 'q')
    // BOUND Ctrl+C is the cancel intent (PR3-B §3.4): no exit fires.
    harness.tern.input.type('\x03')
    await settle()
    assert.equal(harness.cancels(), 1, 'Ctrl+C routed the cancel intent exactly once')
    assert.equal(harness.exitCount(), 0, 'a bound Ctrl+C never exits the TUI')
    // Escape shares the cancel mapping.
    harness.tern.input.type('\x1b')
    await settle()
    assert.equal(harness.cancels(), 2, 'Escape routed the cancel intent')
    assert.equal(harness.exitCount(), 0)
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('input after dispose is inert', async () => {
  const harness = await mountPane()
  await harness.dispose()
  await harness.session.close()
  const framesBefore = harness.frames().length
  harness.tern.input.type('late')
  await settle()
  assert.equal(harness.frames().length, framesBefore, 'no frame after disposal')
  assert.equal(harness.exitCount(), 0, 'a late key after dispose never exits')
})

test('a key batched with the SDK handshake is consumed through the composer', async () => {
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

test('an early Ctrl+D in the handshake batch routes the legal exit', async () => {
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

test('keys before the bind are HELD, then consumed exactly once at the bind', async () => {
  // No bind yet (bind: false mirrors a connect that outlived the startup
  // commit): the typed keys must NOT reach the editor — they wait.
  const harness = await mountPane({ bind: false })
  try {
    harness.tern.input.type('held')
    await settle()
    assert.equal(lastEditorProps(harness.frames())?.text, '', 'a pre-bind key never edits the composer')
    assert.equal(harness.userInputs(), 0, 'no user activity is observed before the bind')
    // The bind consumes the held keys ONCE, in arrival order.
    harness.renderer.bindInput({ exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {}, pasteMedia: () => {}, pastedPath: () => {}, admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true })
    await settle()
    assert.equal(lastEditorProps(harness.frames())?.text, 'held', 'the bind consumed the held keys')
    // A second bind is refused — exactly ONE input owner.
    assert.throws(() => harness.renderer.bindInput({ exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {}, pasteMedia: () => {}, pastedPath: () => {}, admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true }),
      /already bound/, 'a second bind throws')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a dispose before the bind discards the held keys unconsumed', async () => {
  const harness = await mountPane({ bind: false })
  harness.tern.input.type('doomed')
  await harness.dispose()
  await harness.session.close()
  const framesBefore = harness.frames().length
  // A late bind after dispose is refused; the held keys died with the renderer.
  assert.throws(() => harness.renderer.bindInput({ exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {}, pasteMedia: () => {}, pastedPath: () => {}, admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true }), /disposed/)
  harness.tern.input.type('late')
  await settle()
  assert.equal(harness.frames().length, framesBefore, 'nothing renders after dispose — the queue was discarded')
})

test('the bound exit handler routes the composer exit gesture', async () => {
  const tern = new ScriptedTern()
  const session = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(session !== null)
  // SEPARATE counters: the renderer's injected requestExit and the BOUND
  // exit handler are different observers — a shared counter would green
  // even if the bound handler were never called (the round-2 review's
  // false-green finding).
  let rendererExits = 0
  let boundExits = 0
  let boundCancels = 0
  const renderer = mountTspRenderer(session, { copyVisual: async () => false, requestExit: () => { rendererExits += 1 } })
  renderer.bindInput({ exit: () => { boundExits += 1 }, cancel: () => { boundCancels += 1 }, submit: () => {}, steer: () => {}, pasteMedia: () => {}, pastedPath: () => {}, admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true })
  await settle()
  try {
    tern.input.type('a')
    await settle()
    // Ctrl+C is the CANCEL intent (PR3-B §3.4 row 3): the bound cancel
    // handler fires exactly once; NEITHER the bound exit NOR the renderer's
    // injected requestExit may fire.
    tern.input.type('\x03')
    await settle()
    assert.equal(boundCancels, 1, 'Ctrl+C routed to the BOUND cancel handler exactly once')
    assert.equal(boundExits, 0, 'Ctrl+C did NOT fire the bound exit handler')
    assert.equal(rendererExits, 0, 'Ctrl+C did NOT fire the injected requestExit')
    // Escape shares the cancel mapping.
    tern.input.type('\x1b')
    await settle()
    assert.equal(boundCancels, 2, 'Escape routed to the BOUND cancel handler')
    assert.equal(boundExits, 0)
    assert.equal(rendererExits, 0)
    // The empty-draft Ctrl+D remains the EXIT gesture.
    tern.input.type('\x7f')
    await settle()
    tern.input.type('\x04')
    await settle()
    assert.equal(boundExits, 1, 'the empty-draft Ctrl+D routed the bound exit handler')
    assert.equal(rendererExits, 0, 'the bound exit does not fire the injected requestExit')
  } finally {
    await renderer.dispose()
    await session.close()
  }
})

test('real user input is observed only through the bound projection', async () => {
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

test('a held key orders the pre-bind Ctrl+D — no exit before the bind replays it', async () => {
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
    harness.renderer.bindInput({ exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {}, pasteMedia: () => {}, pastedPath: () => {}, admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true })
    await settle()
    assert.equal(harness.exitCount(), 0, 'the replayed Ctrl+D saw the applied draft and did not exit')
    const editor = lastEditorProps(harness.frames())
    assert.equal(editor?.text, 'a', 'the held key applied at the bind, in order')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('the empty-draft Ctrl+D exit shape (the real-pane v4 tail) through the bound loop', async () => {
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

test('a pre-bind input flood fails loud ONCE and still replays the held prefix', async () => {
  const harness = await mountPane({ bind: false })
  try {
    // Over 128 held keys: the 129th trips the ONE observable overflow notice.
    harness.tern.input.type('a'.repeat(200))
    await settle()
    const wire = harness.tern.output.text()
    assert.ok(wire.includes('were dropped'), 'the overflow is observable (fail loud), not a silent drop')
    harness.renderer.bindInput({ exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {}, pasteMedia: () => {}, pastedPath: () => {}, admitPastedPathDelivery: () => true, shouldRememberInput: () => true, noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true })
    await settle()
    const editor = lastEditorProps(harness.frames())
    assert.equal(editor?.text, 'a'.repeat(128), 'the held PREFIX (the bounded queue) still replayed at the bind')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── PR4: the Ctrl+V paste-media route (real SDK key bytes → dispatchKey) ─────

test('Ctrl+V forwards the media intent exactly once and leaves the draft untouched', async () => {
  const harness = await mountPane()
  try {
    assert.equal(harness.pasteMedia(), 0, 'no paste intent before the gesture')
    harness.tern.input.type('\x16')
    // The shared render wait: it covers the SDK frame/delivery the assertion
    // reads, not a guessed readiness window.
    await settle()
    assert.equal(harness.pasteMedia(), 1, 'Ctrl+V routed the ONE application media intent')
    assert.equal(lastEditorProps(harness.frames())?.text, '',
      'the renderer owns no clipboard read: it never inserts text itself')
    assert.equal(harness.exitCount(), 0, 'the paste gesture never exits')
    assert.equal(harness.cancels(), 0, 'the paste gesture is not the cancel intent')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a bracketed paste of command-looking text never becomes a media intent', async () => {
  const harness = await mountPane()
  try {
    // The terminal's bracketed-paste bytes: the SDK decodes `name === 'paste'`,
    // which is the composer's atomic text edit — a DIFFERENT key from Ctrl+V.
    harness.tern.input.type('\u001b[200~/image shot.png\n/exit\u001b[201~')
    // The shared render wait: it covers the SDK frame/delivery the assertion
    // reads, not a guessed readiness window.
    await settle()

    assert.equal(harness.pasteMedia(), 0, 'a text paste never probes the clipboard')
    const editor = lastEditorProps(harness.frames())
    assert.equal(editor?.text, '/image shot.png\n/exit', 'the pasted bytes are draft content')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a modal seat consumes Ctrl+V without forwarding it', async () => {
  const harness = await mountPane()
  const pending = harness.renderer.interaction.askQuestions(
    [{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }, { label: 'no' }] }],
    undefined,
    undefined,
    false,
  )
  pending.catch(() => {})
  try {
    // The shared render wait: it covers the SDK frame/delivery the assertion
    // reads, not a guessed readiness window.
    await settle()
    assert.equal(harness.pasteMedia(), 0, 'opening the form forwarded no paste')
    harness.tern.input.type('\x16')
    // The shared render wait: it covers the SDK frame/delivery the assertion
    // reads, not a guessed readiness window.
    await settle()

    assert.equal(harness.pasteMedia(), 0,
      'the modal seat consumed Ctrl+V: no clipboard probe while a form owns the keys')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a Ctrl+V held before the bind is replayed ONCE at the bind', async () => {
  const harness = await mountPane({ bind: false })
  try {
    harness.tern.input.type('\x16')
    // The shared render wait: it covers the SDK frame/delivery the assertion
    // reads, not a guessed readiness window.
    await settle()
    assert.equal(harness.pasteMedia(), 0, 'a pre-bind paste probes nothing')

    let pastes = 0
    harness.renderer.bindInput({
      exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {},
      pasteMedia: () => { pastes += 1 },
      pastedPath: () => {},
      admitPastedPathDelivery: () => true, shouldRememberInput: () => true,
      noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true
    })
    // The shared render wait: it covers the SDK frame/delivery the assertion
    // reads, not a guessed readiness window.
    await settle()

    assert.equal(pastes, 1, 'the held Ctrl+V was replayed exactly once through the SAME dispatch')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a dispose before the bind discards a held Ctrl+V unconsumed', async () => {
  const harness = await mountPane({ bind: false })
  harness.tern.input.type('\x16')
    // The shared render wait: it covers the SDK frame/delivery the assertion
    // reads, not a guessed readiness window.
  await settle()
  await harness.dispose()
  await harness.session.close()

  let pastes = 0
  assert.throws(() => harness.renderer.bindInput({
    exit: () => {}, cancel: () => {}, submit: () => {}, steer: () => {},
    pasteMedia: () => { pastes += 1 },
    pastedPath: () => {},
    admitPastedPathDelivery: () => true, shouldRememberInput: () => true,
    noteUserInput: () => {}, listContinuedQuestions: () => [], reopenContinuedQuestion: () => false, openModelPicker() {}, openModelQuick() {}, openSessionBrowser() {}, sessionBrowserAvailable: () => true
  }), /disposed/)
  assert.equal(pastes, 0, 'a paste held across disposal never reaches the application')
})

test('Ctrl+C is the cancel intent, never the paste gesture', async () => {
  const harness = await mountPane()
  try {
    harness.tern.input.type('\x03')
    // The shared render wait: it covers the SDK frame/delivery the assertion
    // reads, not a guessed readiness window.
    await settle()

    assert.equal(harness.pasteMedia(), 0, 'Ctrl+C is not Ctrl+V')
    assert.equal(harness.cancels(), 1, 'Ctrl+C kept its one cancel intent')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('Ctrl+V during session hydration is dropped, not held for the new subject', async () => {
  const harness = await mountPane()
  try {
    harness.renderer.display.beginSessionHydration()
    // The shared render wait: it covers the SDK frame/delivery the assertion
    // reads, not a guessed readiness window.
    await settle()
    assert.equal(harness.pasteMedia(), 0, 'the hydration window starts with no paste')

    harness.tern.input.type('\x16')
    // The shared render wait: it covers the SDK frame/delivery the assertion
    // reads, not a guessed readiness window.
    await settle()
    assert.equal(harness.pasteMedia(), 0,
      'a paste during hydration probes nothing: the draft belongs to the outgoing subject')

    // The new subject's frame lifts the fence; the DROPPED key is not replayed.
    harness.renderer.display.setTranscript([], undefined, undefined, undefined, undefined, {})
    // The shared render wait: it covers the SDK frame/delivery the assertion
    // reads, not a guessed readiness window.
    await settle()
    harness.tern.input.type('\x16')
    // The shared render wait: it covers the SDK frame/delivery the assertion
    // reads, not a guessed readiness window.
    await settle()
    assert.equal(harness.pasteMedia(), 1, 'a paste after the fence lifts forwards exactly once')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── Real bracketed pasted image file paths (Tern/Hedr) ──────────────────────

test('a real bracketed paste of an image path forwards ONE receipt whose tracked span replaces the token', async () => {
  const path = '/home/xmoon/.cache/tern/pastes/a07fa8e58c3d1059.png'
  const harness = await mountPane()
  try {
    harness.tern.input.type(`\u001b[200~${path} \u001b[201~`)
    // The shared render wait: it covers the SDK frame/delivery the assertions
    // read, not a guessed readiness window.
    await settle()

    assert.equal(harness.pasteMedia(), 0, 'a bracketed paste is never the Ctrl+V clipboard probe')
    assert.equal(harness.pastedPaths().length, 1, 'exactly ONE application receipt per real paste')
    const receipt = harness.pastedPaths()[0]!
    assert.equal(receipt.text, `${path} `, 'the receipt carries the COMPLETE paste body')
    assert.equal(receipt.seatCurrent(), true)
    assert.equal(receipt.hasLivePath(path), true, 'the proven raw span still holds the path')
    assert.equal(receipt.hasLivePath('/tmp/other.png'), false)
    assert.equal(lastEditorProps(harness.frames())?.text, `${path} `,
      'the path stays ordinary editable text while the read is in flight')

    assert.equal(receipt.replacePastedPath(path, '[image #1 (1920×1080)]'), true)
    // The shared render wait: it covers the SDK frame the assertion reads,
    // not a guessed readiness window.
    await settle()
    assert.equal(lastEditorProps(harness.frames())?.text, '[image #1 (1920×1080)] ',
      'the controlled frame carries the canonical token; the separator space stays text')

    harness.tern.input.type(' 这是啥')
    // The shared render wait: it covers the SDK frame the assertion reads,
    // not a guessed readiness window.
    await settle()
    assert.equal(lastEditorProps(harness.frames())?.text, '[image #1 (1920×1080)]  这是啥',
      'typed text after the token is preserved')
    assert.equal(receipt.replacePastedPath(path, '[image #2 (1×1)]'), false,
      'the lease retired after its ONE replacement')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a paste during the hydration window is dropped and never forwarded', async () => {
  const harness = await mountPane()
  try {
    harness.renderer.display.beginSessionHydration()
    // The shared render wait: it covers the SDK frame the assertion reads,
    // not a guessed readiness window.
    await settle()
    harness.tern.input.type('\u001b[200~/tmp/shot.png \u001b[201~')
    // The shared render wait: it covers the SDK frame the assertion reads,
    // not a guessed readiness window.
    await settle()
    assert.equal(harness.pastedPaths().length, 0,
      'the outgoing subject never claims a pasted image path')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a paste while a modal seat owns the keys is never forwarded', async () => {
  const harness = await mountPane()
  const pending = harness.renderer.interaction.askQuestions(
    [{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }, { label: 'no' }] }],
    undefined,
    undefined,
    false,
  )
  pending.catch(() => {})
  try {
    // The shared render wait: it covers the SDK frame the assertion reads,
    // not a guessed readiness window.
    await settle()
    harness.tern.input.type('\u001b[200~/tmp/shot.png \u001b[201~')
    // The shared render wait: it covers the SDK frame the assertion reads,
    // not a guessed readiness window.
    await settle()
    assert.equal(harness.pastedPaths().length, 0, 'the modal seat consumed the paste')
    assert.equal(harness.pasteMedia(), 0)
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('a disposed renderer forwards no receipt for a late paste', async () => {
  const harness = await mountPane()
  await harness.dispose()
  harness.tern.input.type('\u001b[200~/tmp/shot.png \u001b[201~')
  // The shared render wait: it covers the SDK frame the assertion reads,
  // not a guessed readiness window.
  await settle()
  assert.equal(harness.pastedPaths().length, 0)
  await harness.session.close()
})

test('a plain-text bracketed paste forwards no pastedPath receipt and tracks nothing', async () => {
  const harness = await mountPane()
  try {
    harness.tern.input.type('\u001b[200~hello world \u001b[201~')
    harness.tern.input.type('\u001b[200~second line\u001b[201~')
    // The shared render wait: it covers the SDK frame the assertion reads,
    // not a guessed readiness window.
    await settle()
    assert.equal(harness.pastedPaths().length, 0,
      'a non-candidate paste never registers a lease')
    assert.equal(lastEditorProps(harness.frames())?.text, 'hello world second line',
      'the plain text is ordinary editable content')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

test('an edit INSIDE a pasted image path retires its tracked span', async () => {
  const path = '/home/xmoon/.cache/tern/pastes/a07fa8e58c3d1059.png'
  const harness = await mountPane()
  try {
    harness.tern.input.type(`\u001b[200~${path} \u001b[201~`)
    // The shared render wait: it covers the SDK frame the assertion reads,
    // not a guessed readiness window.
    await settle()
    assert.equal(harness.pastedPaths().length, 1)
    const receipt = harness.pastedPaths()[0]!
    assert.equal(receipt.hasLivePath(path), true)

    // Move the caret before the final "png" and paste duplicate text INSIDE
    // the path: the text alone is ambiguous, the composer's real edit is not.
    for (let step = 0; step < 4; step += 1) harness.tern.input.type('\u001b[D')
    // The shared render wait: it covers the SDK frame the assertion reads,
    // not a guessed readiness window.
    await settle()
    harness.tern.input.type('\u001b[200~png\u001b[201~')
    // The shared render wait: it covers the SDK frame the assertion reads,
    // not a guessed readiness window.
    await settle()

    assert.equal(harness.pastedPaths().length, 1,
      'the non-candidate inside paste forwards no receipt')
    assert.equal(receipt.hasLivePath(path), false, 'the inside edit retired the lease')
    assert.equal(receipt.replacePastedPath(path, '[image #9 (1×1)]'), false)
    assert.equal(lastEditorProps(harness.frames())?.text, `${path}png `,
      'the user text stays ordinary editable content')
  } finally {
    await harness.dispose()
    await harness.session.close()
  }
})

// ── The ONE conditional slash-completion write (reducer layer) ────────────────
//
// `applyCompletionEdit(expected, next)` is the only write a slash completion may
// make. Every failed check is a REJECTION that touches nothing — no text, no
// caret, no paste lease, no frame — and every accepted one replaces the command
// token, lands the caret where the Provider put it (never at the document end),
// retires the ↑/↓ browse bookmark, follows the exact splice with every other
// paste lease and commits exactly ONE `onChanged`.

test('`/ne` at caret 3 -> the draft becomes `/new `, the caret sits at 5 and exactly one frame commits', () => {
  const { composer, changes } = composerWithSinks()
  for (const ch of '/ne') composer.applyKey(key(ch, { text: ch }))
  assert.deepEqual(composer.state(), { text: '/ne', cursor: 3, focused: false }, 'the fixture draft')

  const painted = changes()
  assert.equal(composer.applyCompletionEdit({ text: '/ne', cursor: 3 }, { text: '/new ', cursor: 5 }), true)
  assert.deepEqual(composer.state(), { text: '/new ', cursor: 5, focused: false },
    'the token is replaced and the caret sits after the written name')
  assert.equal(changes() - painted, 1, 'one accepted completion commits exactly one frame')
})

test('an indented `/ne` with text after the caret -> the indentation and the tail survive and the caret sits right after `/new `', () => {
  const { composer, changes } = composerWithSinks()
  const draft = '  /ne and more'
  for (const ch of draft) composer.applyKey(key(ch, { text: ch }))
  for (let step = 0; step < draft.length - 5; step += 1) composer.applyKey(key('left'))
  assert.deepEqual(composer.state(), { text: draft, cursor: 5, focused: false },
    'the caret sits just after the indented token, with a tail behind it')

  const painted = changes()
  assert.equal(composer.applyCompletionEdit(
    { text: draft, cursor: 5 },
    { text: '  /new  and more', cursor: 7 },
  ), true)
  const after = composer.state()
  assert.equal(after.text.slice(0, 2), '  ', 'the leading indentation is untouched')
  assert.equal(after.text.slice(7), ' and more', 'the tail behind the caret is untouched')
  assert.equal(after.cursor, 7, 'the caret is exactly after `/new `, not at the document end')
  assert.equal(changes() - painted, 1, 'exactly one frame for the accepted completion')
})

test('a completion on the first line of a multi-line draft -> the caret stays inside line 1 instead of the document end', () => {
  const { composer, changes } = composerWithSinks()
  composer.setDraft('/neb\nsecond line')
  composer.applyKey(key('up'))
  const before = composer.state()
  assert.deepEqual(before, { text: '/neb\nsecond line', cursor: 4, focused: false },
    'the fixture caret is at the end of the first line')

  const next = '/new 🖼️ \nsecond line'
  const nextCursor = 8
  assert.ok(caretBoundaries(next).includes(nextCursor), 'the requested caret is a legal grapheme boundary')
  const painted = changes()
  assert.equal(composer.applyCompletionEdit({ text: before.text, cursor: before.cursor }, { text: next, cursor: nextCursor }), true)
  const after = composer.state()
  assert.deepEqual(after, { text: next, cursor: nextCursor, focused: false })
  assert.equal(after.text.slice(9), '\nsecond line', 'the second line is byte-identical')
  assert.equal(after.cursor, 8, 'the caret is where the Provider put it, right after the emoji cluster')
  assert.notEqual(after.cursor, next.length,
    'a completion never lands the caret at the document end the way setDraft would')
  assert.equal(changes() - painted, 1, 'exactly one frame')

  // The same document through the OTHER port member proves the difference this
  // contract exists for: `setDraft` puts the caret at the very end.
  composer.setDraft(next)
  assert.equal(composer.state().cursor, next.length, 'setDraft lands at the document end')
})

test('an emoji and ZWJ left context -> the clusters are copied whole, and a caret inside a cluster is refused with nothing touched', () => {
  const family = '👨‍👩‍👧'
  const { composer, changes } = composerWithSinks()
  for (const ch of [family, ' ', '/', 'n', 'e']) composer.applyKey(key(ch, { text: ch }))
  const draft = `${family} /ne`
  assert.equal(draft.length, 12, 'the ZWJ family is 8 UTF-16 units of left context')
  assert.deepEqual(composer.state(), { text: draft, cursor: draft.length, focused: false })

  const painted = changes()
  assert.equal(composer.applyCompletionEdit(
    { text: draft, cursor: draft.length },
    { text: `${family} /new `, cursor: 14 },
  ), true)
  const after = composer.state()
  assert.deepEqual(after, { text: `${family} /new `, cursor: 14, focused: false })
  assert.equal(after.text.slice(0, family.length), family,
    'the multi-byte left context is byte-identical — no surrogate or ZWJ piece of it was rewritten')
  assert.ok(caretBoundaries(after.text).includes(after.cursor), 'the new caret sits on a cluster boundary')
  assert.equal(changes() - painted, 1, 'the accepted completion painted one frame')

  // The rejection: the same document, a caret INSIDE the appended family cluster.
  const grown = `${family} /new ${family}`
  const insideCluster = family.length + 6 + 1
  assert.ok(!caretBoundaries(grown).includes(insideCluster), 'the fixture caret really is inside a cluster')
  const beforeRefusal = changes()
  assert.equal(composer.applyCompletionEdit({ text: after.text, cursor: after.cursor }, { text: grown, cursor: insideCluster }), false,
    'a completion may never leave the caret inside a grapheme cluster')
  assert.deepEqual(composer.state(), after, 'the refusal touched neither the text nor the caret')
  assert.equal(changes(), beforeRefusal, 'the refusal painted nothing')

  // Control: the IDENTICAL replacement is accepted when the caret is on the
  // boundary, so the refusal above was the caret and not the document.
  assert.equal(composer.applyCompletionEdit(
    { text: after.text, cursor: after.cursor },
    { text: grown, cursor: family.length + 6 },
  ), true, 'the same write IS accepted at a boundary caret')
  assert.deepEqual(composer.state(), { text: grown, cursor: 14, focused: false })
})

test('a change that would split a CRLF pair -> refused with the pair intact; a same-line completion in a CRLF draft -> accepted', () => {
  const { composer, changes } = composerWithSinks()
  composer.setDraft('one\r\ntwo')
  const crlfDraft = composer.state()
  assert.deepEqual(crlfDraft, { text: 'one\r\ntwo', cursor: 8, focused: false },
    'the CRLF pair is 2 UTF-16 units, so the fixture caret is at 8')

  const split = 'one\ntwo'
  assert.ok(caretBoundaries(split).includes(4), 'the requested caret is a legal boundary — the refusal is about the CRLF pair')
  const painted = changes()
  assert.equal(composer.applyCompletionEdit({ text: crlfDraft.text, cursor: crlfDraft.cursor }, { text: split, cursor: 4 }), false,
    'a change may not end between a CR and its LF')
  assert.deepEqual(composer.state(), crlfDraft, 'the CRLF document is untouched by the refusal')
  assert.equal(changes(), painted, 'and it painted no frame')
  // The same write with the caret INSIDE the changed span: only the CR/LF rule
  // can refuse it, so the refusal above was provably the split, not the caret.
  assert.equal(composer.applyCompletionEdit({ text: crlfDraft.text, cursor: crlfDraft.cursor }, { text: split, cursor: 3 }), false,
    'the CR/LF split refuses the change even when the caret is legal')
  assert.deepEqual(composer.state(), crlfDraft, 'and that refusal touched nothing either')
  assert.equal(changes(), painted, 'nor painted a frame')

  // The legitimate sibling: the completion stays inside line 2 of a CRLF draft.
  composer.setDraft('one\r\n/ne')
  const before = composer.state()
  assert.deepEqual(before, { text: 'one\r\n/ne', cursor: 8, focused: false })
  const accepted = changes()
  assert.equal(composer.applyCompletionEdit(
    { text: before.text, cursor: before.cursor },
    { text: 'one\r\n/new ', cursor: 10 },
  ), true, 'a completion on one line of a CRLF draft is accepted')
  const after = composer.state()
  assert.deepEqual(after, { text: 'one\r\n/new ', cursor: 10, focused: false })
  assert.equal(after.text.slice(3, 5), '\r\n', 'the line break kept both of its bytes')
  assert.ok(!caretBoundaries(after.text).includes(4),
    'the CR and LF are still ONE grapheme cluster — the caret can never sit between them')
  assert.equal(changes() - accepted, 1, 'exactly one frame')
})

test('a completion whose change would cross a line break -> refused and the two-line draft is untouched', () => {
  const { composer, changes } = composerWithSinks()
  composer.applyKey(key('a', { text: 'a' }))
  composer.applyKey(key('enter', { shift: true }))
  composer.applyKey(key('b', { text: 'b' }))
  const before = composer.state()
  assert.deepEqual(before, { text: 'a\nb', cursor: 3, focused: false })

  const painted = changes()
  assert.equal(composer.applyCompletionEdit({ text: 'a\nb', cursor: 3 }, { text: 'ab', cursor: 2 }), false,
    'a completion replaces a command name, never the document shape')
  assert.deepEqual(composer.state(), before, 'the second line and the caret are exactly as they were')
  assert.equal(changes(), painted, 'and the refusal painted nothing')
})

test('the draft moved after the Provider computed the replacement -> refused and the live post-edit draft stays exactly as typed', () => {
  const { composer, changes } = composerWithSinks()
  for (const ch of '/ne') composer.applyKey(key(ch, { text: ch }))
  composer.applyKey(key('x', { text: 'x' }))
  const live = composer.state()
  assert.deepEqual(live, { text: '/nex', cursor: 4, focused: false }, 'a real edit landed after the snapshot')

  const painted = changes()
  assert.equal(composer.applyCompletionEdit({ text: '/ne', cursor: 3 }, { text: '/new ', cursor: 5 }), false,
    'a stale document is a rejection, never a repair')
  assert.deepEqual(composer.state(), live, 'the live draft stays byte-identical to the post-edit state')
  assert.equal(changes(), painted, 'the stale completion painted nothing')

  // A caret-only stale snapshot is refused the same way: same bytes, moved caret.
  composer.applyKey(key('home'))
  const afterHome = changes()
  assert.equal(composer.applyCompletionEdit({ text: '/nex', cursor: 4 }, { text: '/new x', cursor: 6 }), false,
    'the moved caret alone makes the answer stale')
  assert.deepEqual(composer.state(), { text: '/nex', cursor: 0, focused: false })
  assert.equal(changes(), afterHome, 'and that refusal painted nothing either')
})

test('a completion rewrites one pasted path -> that lease dies, the other lease follows the splice, and a late replacement cannot touch it', () => {
  const pasted = '/tmp/a.png'
  const placeholder = '[image #1 (1×1)]'
  const { composer, changes } = composerWithSinks()
  // Two real bracketed pastes of the SAME path, plus the separator the user typed.
  composer.applyKey(key('paste', { text: pasted }))
  const firstId = composer.registerPastedPathSpan({ start: 0, end: pasted.length, expected: pasted })
  composer.applyKey(key(' ', { text: ' ' }))
  composer.applyKey(key('paste', { text: pasted }))
  const secondId = composer.registerPastedPathSpan({ start: pasted.length + 1, end: 2 * pasted.length + 1, expected: pasted })
  assert.ok(firstId !== undefined && secondId !== undefined, 'both leases are live')
  const draft = composer.state()
  assert.deepEqual(draft, { text: `${pasted} ${pasted}`, cursor: 2 * pasted.length + 1, focused: false })

  // The completion replaces the leading token — the bytes the FIRST lease held.
  const painted = changes()
  assert.equal(composer.applyCompletionEdit(
    { text: `${pasted} ${pasted}`, cursor: draft.cursor },
    { text: '/tmp/x.png /tmp/a.png', cursor: 6 },
  ), true)
  const afterCompletion = composer.state()
  assert.deepEqual(afterCompletion, { text: '/tmp/x.png /tmp/a.png', cursor: 6, focused: false })
  assert.equal(changes() - painted, 1, 'the completion painted exactly one frame')
  assert.equal(composer.hasLivePath(firstId!, pasted), false,
    'the lease whose bytes the completion consumed is retired')
  assert.equal(composer.hasLivePath(secondId!, pasted), true,
    'the unrelated lease is still live and still holds the path')

  // A late replacement for the retired lease fails and must not fall through to
  // the OTHER occurrence of the same path text.
  const beforeLateCall = changes()
  assert.equal(composer.replacePastedPathOccurrence(firstId!, pasted, placeholder), false,
    'a retired lease never replaces anything')
  assert.deepEqual(composer.state(), afterCompletion,
    'the failed call rewrote neither the text nor the caret — the surviving occurrence is intact')
  assert.equal(composer.state().text.slice(11, 21), pasted, 'the second occurrence stayed where the splice left it')
  assert.equal(changes(), beforeLateCall, 'and the failed call painted nothing')

  // The surviving lease still works at ITS OWN position, with the caret shifted
  // by the placeholder's length change.
  composer.applyKey(key('end'))
  const beforeReplace = changes()
  assert.equal(composer.replacePastedPathOccurrence(secondId!, pasted, placeholder), true)
  assert.deepEqual(composer.state(), { text: `/tmp/x.png ${placeholder}`, cursor: 11 + placeholder.length, focused: false },
    'the replacement landed on the second occurrence and the caret at the end shifted with it')
  assert.equal(changes() - beforeReplace, 1, 'the replacement is one atomic edit')
  assert.equal(composer.hasLivePath(secondId!, pasted), false, 'a lease never survives its own replacement')
})

test('a completion accepted during an ↑ browse -> ↓ cannot restore the draft browse replaced', () => {
  const { composer, changes } = composerWithSinks({ entries: ['/ne', 'older'] })
  composer.setDraft('mine')
  composer.applyKey(key('home'))
  composer.applyKey(key('up'))
  assert.deepEqual(composer.state(), { text: '/ne', cursor: 0, focused: false }, '↑ entered the browse on the recalled row')

  const painted = changes()
  assert.equal(composer.applyCompletionEdit({ text: '/ne', cursor: 0 }, { text: '/new ', cursor: 5 }), true)
  assert.deepEqual(composer.state(), { text: '/new ', cursor: 5, focused: false })
  assert.equal(changes() - painted, 1, 'the accepted completion painted one frame')

  assert.deepEqual(composer.applyKey(key('down')), { kind: 'none' }, '↓ has no newer row and no bookmark to give back')
  assert.deepEqual(composer.state(), { text: '/new ', cursor: 5, focused: false },
    'the recalled row is ordinary content: ↓ restores neither the pre-browse draft nor the pre-completion one')

  // The bookmark is retired, not broken: the NEXT ↑ walk records the completed
  // draft and ↓ gives exactly that back.
  composer.applyKey(key('up'))
  composer.applyKey(key('up'))
  assert.equal(composer.state().text, '/ne', 'browsing works again from the completed draft')
  composer.applyKey(key('down'))
  assert.deepEqual(composer.state(), { text: '/new ', cursor: 5, focused: false },
    'the new bookmark is the post-completion draft')
})

test('every rejection path leaves the text, the caret, the live paste lease and the frame count untouched', () => {
  const pasted = '/tmp/a.png'
  const family = '👨‍👩‍👧'
  const draft = `${pasted} /neb`
  const { composer, changes } = composerWithSinks()
  composer.setDraft(draft)
  const lease = composer.registerPastedPathSpan({ start: 0, end: pasted.length, expected: pasted })
  assert.ok(lease !== undefined, 'the lease is live before the refusals')
  const live = { text: draft, cursor: draft.length, focused: false }
  assert.deepEqual(composer.state(), live)

  const insideCluster = `${pasted} /new ${family}`
  const refusals: Array<{ label: string; next: { text: string; cursor: number } }> = [
    { label: 'a caret inside a grapheme cluster', next: { text: insideCluster, cursor: insideCluster.length - 7 } },
    // A caret is refused when it leaves the LINE the completion wrote (the
    // contract since the `/im x` defect: a caret is NOT confined to the minimal
    // diff span, because the command-name rule appends a separator that the
    // minimal span can exclude). Here it lands on a later line.
    { label: 'a caret on another line', next: { text: `${pasted} /new b\nsecond`, cursor: `${pasted} /new b\n`.length + 2 } },
    { label: 'a change that appends a line break', next: { text: `${draft}\n`, cursor: draft.length + 1 } },
    { label: 'a stale document', next: { text: `${pasted} /new`, cursor: 15 } },
  ]
  for (const refusal of refusals) {
    const expected = refusal.label === 'a stale document'
      ? { text: `${pasted} /ne`, cursor: 13 }
      : { text: live.text, cursor: live.cursor }
    const painted = changes()
    assert.equal(composer.applyCompletionEdit(expected, refusal.next), false, `${refusal.label} is refused`)
    assert.deepEqual(composer.state(), live, `${refusal.label} changed neither the text nor the caret`)
    assert.equal(changes(), painted, `${refusal.label} committed no render`)
    assert.equal(composer.hasLivePath(lease, pasted), true, `${refusal.label} retired no paste lease`)
  }
})

test('a completion that hands the draft back byte-identical still counts as an edit: the ↑ browse in flight is dropped', () => {
  // The write bumps the edit epoch, so an admission callback whose reentrant
  // completion left the SAME text and caret still invalidates that gesture.
  let target!: TspComposer
  let roundTrip = false
  const { composer, changes, admissions } = composerWithSinks({
    entries: ['r1'],
    admitDraft: () => {
      if (roundTrip) return true
      roundTrip = true
      composer.applyCompletionEdit({ text: '/ne', cursor: 0 }, { text: ' /ne', cursor: 1 })
      composer.applyCompletionEdit({ text: ' /ne', cursor: 1 }, { text: '/ne', cursor: 0 })
      return true
    },
  })
  target = composer
  target.setDraft('/ne')
  target.applyKey(key('home'))
  assert.deepEqual(target.state(), { text: '/ne', cursor: 0, focused: false })

  const painted = changes()
  assert.deepEqual(target.applyKey(key('up')), { kind: 'none' },
    'the ↑ sees an epoch that moved and drops its own gesture')
  assert.deepEqual(target.state(), { text: '/ne', cursor: 0, focused: false },
    'the draft the callback restored stands — no recalled row was written over it')
  assert.equal(changes() - painted, 2,
    'the two completion writes committed two frames; the dropped gesture added no third')
  assert.deepEqual(admissions(), ['/ne'], 'the dropped attempt still consulted the application once')

  // And it left no bookmark behind: the next walk records the LIVE draft.
  target.applyKey(key('down'))
  target.applyKey(key('up'))
  target.applyKey(key('up'))
  assert.equal(target.state().text, 'r1', 'the next ↑ enters the browse normally')
  target.applyKey(key('down'))
  assert.deepEqual(target.state(), { text: '/ne', cursor: 3, focused: false },
    '↓ gives back the draft the walk actually began from')
})
