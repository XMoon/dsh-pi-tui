/**
 * The verified session-origin ranges over one committed visual log.
 *
 * A forked Session inherits a durable event prefix from its parent; PR1 derives
 * each `sv1_…` reference from the ORIGINAL session identity, so the replay
 * authority needs to know which seqs came from which already-verified ancestor.
 * These cases pin the pure derivation: immutable ordered non-overlapping spans,
 * fail-closed gaps, the intersection used to lift an ancestor's proof into a
 * descendant window, and the seq→origin lookup.
 * @module @xmoon76/dsh-pi-tui/domain/visual-origin.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createVisualOriginReader,
  intersectVisualOriginSpans,
  mergeVisualOriginSpans,
  originSessionIdAt,
  ownVisualOriginSpans,
  type VerifiedVisualOriginSpan,
} from '../../src/domain/visual/origin.ts'

const A = 'session-a'
const B = 'session-b'
const C = 'session-c'

function span(startSeq: number, endSeqExclusive: number, sessionId: string): VerifiedVisualOriginSpan {
  return { startSeq, endSeqExclusive, sessionId }
}

// ── one owned range ────────────────────────────────────────────────────────

test('the own range is one immutable span and an empty range proves nothing', () => {
  const own = ownVisualOriginSpans(A, 4, 9)
  assert.deepEqual(own, [span(4, 9, A)])
  assert.ok(Object.isFrozen(own), 'the span array is immutable')
  assert.ok(Object.isFrozen(own[0]), 'the span itself is immutable')

  assert.deepEqual(ownVisualOriginSpans(A, 7, 7), [], 'an empty own range covers no seq')
  assert.deepEqual(ownVisualOriginSpans(A, -1, 4), [], 'a negative start is not a provable range')
  assert.deepEqual(ownVisualOriginSpans(A, 5, 4), [], 'an inverted range is not a provable range')
  assert.deepEqual(ownVisualOriginSpans(A, 0, 1.5), [], 'a fractional end is not a provable range')
})

// ── merge ──────────────────────────────────────────────────────────────────

test('ordered disjoint ranges merge and adjacent same-session ranges coalesce', () => {
  const merged = mergeVisualOriginSpans([span(9, 12, B), span(0, 5, B), span(5, 9, B)])
  assert.deepEqual(merged, [span(0, 12, B)], 'adjacent same-session ranges are one range')

  const forked = mergeVisualOriginSpans([span(9, 12, B), span(0, 9, A)])
  assert.deepEqual(forked, [span(0, 9, A), span(9, 12, B)],
    'adjacent ranges from different Sessions stay separate: the cut is a real identity change')
})

test('an overlapping or malformed range set is refused instead of guessed', () => {
  assert.equal(mergeVisualOriginSpans([span(0, 5, A), span(4, 8, B)]), undefined,
    'overlap is refused: a seq cannot have two originals')
  assert.equal(mergeVisualOriginSpans([span(0, 5, A), span(0, 5, B)]), undefined,
    'a duplicated range is refused')
  assert.equal(mergeVisualOriginSpans([span(-1, 5, A)]), undefined)
  assert.equal(mergeVisualOriginSpans([span(0, 5, '')]), undefined, 'a range without a Session id proves nothing')
  assert.deepEqual(mergeVisualOriginSpans([]), [], 'no parts is a valid empty proof')
})

// ── intersection ───────────────────────────────────────────────────────────

test('the intersection lifts an ancestor proof into a descendant window', () => {
  const ancestor = [span(0, 4, A), span(4, 10, B), span(10, 15, C)]
  assert.deepEqual(intersectVisualOriginSpans(ancestor, 2, 12), [span(2, 4, A), span(4, 10, B), span(10, 12, C)],
    'both ends are clipped and every original id survives')
  assert.deepEqual(intersectVisualOriginSpans(ancestor, 4, 10), [span(4, 10, B)])
  assert.deepEqual(intersectVisualOriginSpans(ancestor, 21, 30), [], 'a window outside the proof proves nothing')
  assert.deepEqual(intersectVisualOriginSpans([span(0, 5, A), span(3, 7, B)], 0, 9), [],
    'an invalid proof yields nothing proven')
})

// ── seq → origin ───────────────────────────────────────────────────────────

test('a covered seq resolves to its original Session and a gap stays unproven', () => {
  const spans = [span(0, 4, A), span(6, 10, B)]
  for (const seq of [0, 3]) assert.equal(originSessionIdAt(spans, seq), A)
  for (const seq of [6, 9]) assert.equal(originSessionIdAt(spans, seq), B)
  for (const seq of [-1, 4, 5, 10, 99]) {
    assert.equal(originSessionIdAt(spans, seq), undefined, `seq ${String(seq)} is not covered by any proof`)
  }
})

test('the repeated reader resolves every seq regardless of query order', () => {
  const read = createVisualOriginReader([span(10, 15, C), span(0, 4, A), span(4, 10, B)])
  const queries = [12, 0, 9, 4, 5, 14, 6, 3]
  // seq 4, 5 and 9 are all inside B's [4, 10) range; only a seq outside every
  // proven range reads undefined.
  assert.deepEqual(queries.map(read), [C, A, B, B, B, C, B, A])
})

test('a malformed reader proves nothing (fail closed, never a guessed author)', () => {
  const read = createVisualOriginReader([span(0, 5, A), span(4, 8, B)])
  for (const seq of [0, 4, 7]) assert.equal(read(seq), undefined)
})
