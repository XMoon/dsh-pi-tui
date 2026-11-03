/**
 * Paste-range leases: the ONLY identity an asynchronous image read may
 * replace. The identity comes from EXACT editor splices (and the PiTui
 * caret-anchored proof), never from a common-prefix/suffix guess — two
 * different edits can produce the same text.
 * @module @xmoon76/dsh-pi-tui/pasted-path-range.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PasteRangeTracker,
  pastedBodySpan,
  proveCaretEdit,
} from '../../src/tui/interaction/pasted-path-range.ts'

const PATH = '/tmp/shot.png'

/** A tracker seeded with the document a paste just produced. */
function trackerWithPaste(raw: string, start: number): { tracker: PasteRangeTracker; id: number } {
  const tracker = new PasteRangeTracker()
  if (raw !== '') tracker.applyEdit({ start: 0, oldEnd: 0, newEnd: raw.length }, raw)
  const id = tracker.add({ start, end: start + PATH.length, expected: PATH })
  assert.ok(id !== undefined, 'the pasted span must register against the live document')
  return { tracker, id }
}

test('the fork may prepend one readability space; the path span excludes it and the separator space', () => {
  const before = 'look'
  const after = 'look /tmp/shot.png '
  assert.deepEqual(
    pastedBodySpan(before, before.length, after, after.length, '/tmp/shot.png '),
    { start: 5, end: 5 + PATH.length, expected: PATH },
  )
})

test('the TSP composer inserts verbatim at the caret', () => {
  const before = 'hi  tail'
  const after = `hi ${PATH}  tail`
  assert.deepEqual(
    pastedBodySpan(before, 3, after, 3 + PATH.length + 1, `${PATH} `),
    { start: 3, end: 3 + PATH.length, expected: PATH },
  )
})

test('a non-candidate paste body never proves a span (no lease for plain text)', () => {
  const before = ''
  for (const body of ['hello world ', '/tmp/notes.txt ', 'see /tmp/a.png ', 'two\nlines']) {
    const after = body
    assert.equal(pastedBodySpan(before, 0, after, after.length, body), undefined, JSON.stringify(body))
  }
})

test('a paste body beyond the candidate bound proves no span (no unbounded tracking)', () => {
  const body = `/tmp/${'a'.repeat(1000)}.png `
  assert.ok(body.length > 1000)
  assert.equal(pastedBodySpan('', 0, body, body.length, body), undefined)
})

test('a transformed insertion (large-paste marker / control filtering) proves no span', () => {
  const before = ''
  const after = '[paste #1 1234 chars]'
  assert.equal(pastedBodySpan(before, 0, after, after.length, '/tmp/a.png '), undefined)
})

test('proveCaretEdit: a plain insertion is proven at the real caret', () => {
  const before = `${PATH} `
  const after = `${PATH} 这是啥`
  assert.deepEqual(proveCaretEdit(before, before.length, after), {
    start: before.length,
    oldEnd: before.length,
    newEnd: after.length,
  })
})

test('proveCaretEdit: the attack insertion INSIDE the path is proven at its real position', () => {
  // Caret moved before `png` (offset 7), then `png` pasted: the text alone is
  // also explainable as an insertion after the separator, but the REAL caret
  // proves the inside edit, so the lease must die.
  const before = `${PATH} `
  const after = `${PATH}png `
  const edit = proveCaretEdit(before, PATH.length - 3, after) // before the final "png"
  assert.deepEqual(edit, { start: PATH.length - 3, oldEnd: PATH.length - 3, newEnd: PATH.length })
  const { tracker, id } = trackerWithPaste(before, 0)
  tracker.applyEdit(edit!, after)
  assert.equal(tracker.live(id), undefined, 'an edit inside the pasted path retires the lease')
})

test('proveCaretEdit: backspace before and delete after the caret are proven exactly', () => {
  const before = `abc ${PATH}`
  const cursor = 4 // right after "abc "
  // Backspace removes the space at index 3.
  assert.deepEqual(proveCaretEdit(before, cursor, `abc${PATH}`), { start: 3, oldEnd: 4, newEnd: 3 })
  // Delete removes the `/` at index 4.
  assert.deepEqual(proveCaretEdit(before, cursor, `abc ${PATH.slice(1)}`), { start: 4, oldEnd: 5, newEnd: 4 })
})

test('proveCaretEdit: a same-length caret replacement is proven; a multi-splice change is not', () => {
  assert.deepEqual(proveCaretEdit('abcXYZ', 3, 'abcQRS'), { start: 3, oldEnd: 6, newEnd: 6 })
  assert.equal(proveCaretEdit('abc def', 3, 'Xbc Yef'), undefined, 'two splices have no single proof')
  assert.equal(proveCaretEdit('abc', 1, 'abc'), undefined, 'an unchanged document is not an edit')
})

test('typing before the paste shifts the span; typing after it leaves the span alone', () => {
  const raw = `hello ${PATH} world`
  const { tracker, id } = trackerWithPaste(raw, 6)
  const typed = `X${raw}`
  tracker.applyEdit({ start: 0, oldEnd: 0, newEnd: 1 }, typed)
  assert.deepEqual(tracker.live(id), { start: 7, end: 7 + PATH.length, expected: PATH })
  tracker.applyEdit({ start: typed.length, oldEnd: typed.length, newEnd: typed.length + 1 }, `${typed}!`)
  assert.deepEqual(tracker.live(id), { start: 7, end: 7 + PATH.length, expected: PATH })
})

test('typing at the LEFT boundary moves the span right; typing at the RIGHT boundary keeps it', () => {
  const { tracker, id } = trackerWithPaste(PATH, 0)
  tracker.applyEdit({ start: 0, oldEnd: 0, newEnd: 1 }, `a${PATH}`)
  assert.deepEqual(tracker.live(id), { start: 1, end: 1 + PATH.length, expected: PATH })
  tracker.applyEdit({ start: 1 + PATH.length, oldEnd: 1 + PATH.length, newEnd: 1 + PATH.length + 1 }, `a${PATH}b`)
  assert.deepEqual(tracker.live(id), { start: 1, end: 1 + PATH.length, expected: PATH })
})

test('an exact deletion covering the pasted path retires the lease', () => {
  const { tracker, id } = trackerWithPaste(`before ${PATH}`, 7)
  tracker.applyEdit({ start: 7, oldEnd: 7 + PATH.length, newEnd: 7 }, 'before ')
  assert.equal(tracker.live(id), undefined)
})

test('deleting text before the paste shifts the span back', () => {
  const text = `before ${PATH}`
  const { tracker, id } = trackerWithPaste(text, 7)
  tracker.applyEdit({ start: 0, oldEnd: 7, newEnd: 0 }, PATH)
  assert.deepEqual(tracker.live(id), { start: 0, end: PATH.length, expected: PATH })
})

test('deleting the trailing separator space keeps the path alive', () => {
  const { tracker, id } = trackerWithPaste(`${PATH} rest`, 0)
  tracker.applyEdit({ start: PATH.length, oldEnd: PATH.length + 1, newEnd: PATH.length }, `${PATH}rest`)
  assert.deepEqual(tracker.live(id), { start: 0, end: PATH.length, expected: PATH })
})

test('a splice that does not reproduce the next text retires every lease', () => {
  const { tracker, id } = trackerWithPaste(PATH, 0)
  tracker.applyEdit({ start: 0, oldEnd: 1, newEnd: 1 }, 'something else')
  assert.equal(tracker.live(id), undefined)
})

test('a restored document that happens to hold the same bytes is NOT the original paste', () => {
  const { tracker, id } = trackerWithPaste(PATH, 0)
  tracker.reset('something else entirely')
  tracker.applyEdit({ start: 0, oldEnd: 0, newEnd: PATH.length }, PATH)
  assert.equal(tracker.live(id), undefined, 'a lease never revives')
})

test('retireAll kills every lease at a programmatic replacement', () => {
  const { tracker, id } = trackerWithPaste(PATH, 0)
  tracker.retireAll()
  assert.equal(tracker.live(id), undefined)
})

test('two pastes of the SAME path have independent spans', () => {
  const raw = `${PATH} / ${PATH}`
  const tracker = new PasteRangeTracker()
  tracker.applyEdit({ start: 0, oldEnd: 0, newEnd: raw.length }, raw)
  const first = tracker.add({ start: 0, end: PATH.length, expected: PATH })
  const second = tracker.add({ start: PATH.length + 3, end: PATH.length + 3 + PATH.length, expected: PATH })
  assert.ok(first !== undefined && second !== undefined && first !== second)
  // Editing the FIRST occurrence retires only that lease.
  const edited = `/tmp/Xhot.png / ${PATH}`
  tracker.applyEdit({ start: 5, oldEnd: 6, newEnd: 6 }, edited)
  assert.equal(tracker.live(first!), undefined)
  assert.deepEqual(tracker.live(second!), {
    start: PATH.length + 3,
    end: PATH.length + 3 + PATH.length,
    expected: PATH,
  })
})

test('a span whose slice does not match the expected bytes never registers', () => {
  const tracker = new PasteRangeTracker()
  tracker.applyEdit({ start: 0, oldEnd: 0, newEnd: PATH.length }, PATH)
  assert.equal(tracker.add({ start: 0, end: PATH.length, expected: '/tmp/other.png' }), undefined)
  assert.equal(tracker.add({ start: -1, end: 3, expected: 'abc' }), undefined)
})
