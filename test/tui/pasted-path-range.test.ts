/**
 * The paste-range leases: the ONLY identity an asynchronous image read may
 * replace. These cases pin the single-splice shift/invalidate rules and the
 * before/after span proof both renderers use.
 * @module @xmoon76/dsh-pi-tui/pasted-path-range.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PasteRangeTracker, pastedBodySpan } from '../../src/tui/interaction/pasted-path-range.ts'

const PATH = '/tmp/shot.png'

/** A tracker seeded with the document a paste just produced. */
function trackerWithPaste(raw: string, start: number): { tracker: PasteRangeTracker; id: number } {
  const tracker = new PasteRangeTracker()
  tracker.observe(raw)
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

test('a transformed insertion (large-paste marker / control filtering) proves no span', () => {
  const before = ''
  const after = '[paste #1 1234 chars]'
  assert.equal(pastedBodySpan(before, 0, after, after.length, '/very long body'), undefined)
})

test('typing before the paste shifts the span; typing after it leaves the span alone', () => {
  const { tracker, id } = trackerWithPaste(`hello ${PATH} world`, 6)
  tracker.observe(`Xhello ${PATH} world`)
  assert.deepEqual(tracker.live(id), { start: 7, end: 7 + PATH.length, expected: PATH })
  tracker.observe(`Xhello ${PATH} world!`)
  assert.deepEqual(tracker.live(id), { start: 7, end: 7 + PATH.length, expected: PATH })
})

test('typing at the LEFT boundary moves the span right; typing at the RIGHT boundary keeps it', () => {
  const { tracker, id } = trackerWithPaste(PATH, 0)
  tracker.observe(`a${PATH}`)
  assert.deepEqual(tracker.live(id), { start: 1, end: 1 + PATH.length, expected: PATH })
  tracker.observe(`a${PATH}b`)
  assert.deepEqual(tracker.live(id), { start: 1, end: 1 + PATH.length, expected: PATH })
})

test('typing INSIDE the pasted path invalidates the lease', () => {
  const { tracker, id } = trackerWithPaste(PATH, 0)
  tracker.observe(`/tmp/shotX.png`)
  assert.equal(tracker.live(id), undefined)
})

test('backspacing over the pasted path invalidates the lease', () => {
  const { tracker, id } = trackerWithPaste(PATH, 0)
  tracker.observe('/tmp/shot.pn')
  assert.equal(tracker.live(id), undefined)
})

test('deleting text before the paste shifts the span back', () => {
  const text = `before ${PATH}`
  const { tracker, id } = trackerWithPaste(text, 7)
  tracker.observe(PATH)
  assert.deepEqual(tracker.live(id), { start: 0, end: PATH.length, expected: PATH })
})

test('deleting the trailing separator space keeps the path alive', () => {
  const { tracker, id } = trackerWithPaste(`${PATH} rest`, 0)
  tracker.observe(`${PATH}rest`)
  assert.deepEqual(tracker.live(id), { start: 0, end: PATH.length, expected: PATH })
})

test('a restored document that happens to hold the same bytes is NOT the original paste', () => {
  const { tracker, id } = trackerWithPaste(PATH, 0)
  tracker.observe('something else entirely')
  tracker.observe(PATH)
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
  tracker.observe(raw)
  const first = tracker.add({ start: 0, end: PATH.length, expected: PATH })
  const second = tracker.add({ start: PATH.length + 3, end: PATH.length + 3 + PATH.length, expected: PATH })
  assert.ok(first !== undefined && second !== undefined && first !== second)
  // Editing the FIRST occurrence retires only that lease.
  tracker.observe(`/tmp/Xhot.png / ${PATH}`)
  assert.equal(tracker.live(first!), undefined)
  assert.deepEqual(tracker.live(second!), {
    start: PATH.length + 3,
    end: PATH.length + 3 + PATH.length,
    expected: PATH,
  })
})

test('a span whose slice does not match the expected bytes never registers', () => {
  const tracker = new PasteRangeTracker()
  tracker.observe(PATH)
  assert.equal(tracker.add({ start: 0, end: PATH.length, expected: '/tmp/other.png' }), undefined)
  assert.equal(tracker.add({ start: -1, end: 3, expected: 'abc' }), undefined)
})
