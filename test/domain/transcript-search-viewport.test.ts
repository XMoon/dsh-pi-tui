/**
 * The one screen-rect placement solver for one transcript search jump: a
 * target that is inside the scroll viewport but under the Search box is not
 * readable, while the same row left of the box is. These cases pin the exact
 * chosen `scrollTop` (not merely "something scrolled"), the readable segment
 * count and the honest fully-readable flag.
 * @module @xmoon76/dsh-pi-tui/transcript-search-viewport.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  chooseSearchViewportTop,
  type PaintedTargetSegment,
  type PhysicalRect,
} from '../../src/tui/components/transcript/search-viewport.ts'

const VIEWPORT: PhysicalRect = { x: 0, y: 0, width: 80, height: 20 }
const OVERLAY: PhysicalRect = { x: 48, y: 1, width: 32, height: 4 }

function segment(documentRow: number, startCol = 0, endCol = 6): PaintedTargetSegment {
  return { documentRow, startCol, endCol }
}

test('search viewport: a target outside the overlay rectangle keeps the current position', () => {
  const choice = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: OVERLAY,
    currentScrollTop: 0,
    maxScrollTop: 100,
    targetRows: { start: 10, end: 10 },
    segments: [segment(10)],
  })
  assert.deepEqual(choice, { scrollTop: 0, visibleSegments: 1, fullyReadable: true })
})

test('search viewport: two-dimensional intersection moves a right-side hit out of the box', () => {
  const choice = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: OVERLAY,
    currentScrollTop: 0,
    maxScrollTop: 100,
    targetRows: { start: 2, end: 2 },
    segments: [segment(2, 50, 56)],
  })
  // Row 2 is under the box; the same row at the viewport top is not.
  assert.deepEqual(choice, { scrollTop: 2, visibleSegments: 1, fullyReadable: true })
})

test('search viewport: a same-row hit LEFT of the box is readable and does not scroll', () => {
  const choice = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: OVERLAY,
    currentScrollTop: 0,
    maxScrollTop: 100,
    targetRows: { start: 2, end: 2 },
    segments: [segment(2, 10, 16)],
  })
  // Row overlap alone is never occlusion: the columns do not intersect.
  assert.deepEqual(choice, { scrollTop: 0, visibleSegments: 1, fullyReadable: true })
})

test('search viewport: a taller box covers one more row and forces the move', () => {
  const targetRows = { start: 4, end: 4 }
  const segments = [segment(4, 50, 56)]
  const covered = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: { ...OVERLAY, height: 4 },
    currentScrollTop: 0,
    maxScrollTop: 100,
    targetRows,
    segments,
  })
  assert.deepEqual(covered, { scrollTop: 4, visibleSegments: 1, fullyReadable: true })
  const uncovered = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: { ...OVERLAY, height: 3 },
    currentScrollTop: 0,
    maxScrollTop: 100,
    targetRows,
    segments,
  })
  assert.deepEqual(uncovered, { scrollTop: 0, visibleSegments: 1, fullyReadable: true })
})

test('search viewport: a wrapped occurrence split by the viewport bottom is completed', () => {
  const choice = chooseSearchViewportTop({
    viewport: VIEWPORT,
    currentScrollTop: 0,
    maxScrollTop: 100,
    targetRows: { start: 19, end: 20 },
    segments: [segment(19, 0, 5), segment(20, 0, 5)],
  })
  assert.deepEqual(choice, { scrollTop: 1, visibleSegments: 2, fullyReadable: true })
})

test('search viewport: a target above the viewport returns to the document top', () => {
  const choice = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: OVERLAY,
    currentScrollTop: 5,
    maxScrollTop: 100,
    targetRows: { start: 0, end: 0 },
    segments: [segment(0)],
  })
  assert.deepEqual(choice, { scrollTop: 0, visibleSegments: 1, fullyReadable: true })
})

test('search viewport: a target spanning the box band degrades to the best partial read', () => {
  const choice = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: OVERLAY,
    currentScrollTop: 0,
    maxScrollTop: 100,
    targetRows: { start: 2, end: 3 },
    segments: [segment(2, 50, 56), segment(3, 50, 56)],
  })
  // No candidate can uncover both rows, so it never claims full readability.
  assert.deepEqual(choice, { scrollTop: 2, visibleSegments: 1, fullyReadable: false })
})

test('search viewport: an overlay outside the viewport never blocks the target', () => {
  const choice = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: { x: 0, y: 100, width: 80, height: 3 },
    currentScrollTop: 0,
    maxScrollTop: 100,
    targetRows: { start: 2, end: 2 },
    segments: [segment(2, 50, 56)],
  })
  assert.deepEqual(choice, { scrollTop: 0, visibleSegments: 1, fullyReadable: true })
})

test('search viewport: no overlay keeps the historical placement authority', () => {
  const choice = chooseSearchViewportTop({
    viewport: VIEWPORT,
    currentScrollTop: 0,
    maxScrollTop: 100,
    targetRows: { start: 25, end: 25 },
    segments: [segment(25)],
  })
  // The nearest candidate that shows the target is the viewport bottom, not a
  // re-centred third position.
  assert.deepEqual(choice, { scrollTop: 6, visibleSegments: 1, fullyReadable: true })
})

test('search viewport: maxScrollTop zero keeps the only legal position', () => {
  const choice = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: OVERLAY,
    currentScrollTop: 5,
    maxScrollTop: 0,
    targetRows: { start: 0, end: 0 },
    segments: [segment(0)],
  })
  assert.deepEqual(choice, { scrollTop: 0, visibleSegments: 1, fullyReadable: true })
})

test('search viewport: nothing can be brought into view falls back to the one-third placement', () => {
  const choice = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: OVERLAY,
    currentScrollTop: 10,
    maxScrollTop: 100,
    targetRows: { start: 1000, end: 1000 },
    segments: [segment(1000)],
  })
  assert.deepEqual(choice, { scrollTop: 100, visibleSegments: 0, fullyReadable: false })
})

test('search viewport: an unusable viewport rect does not guess', () => {
  const choice = chooseSearchViewportTop({
    viewport: { x: 0, y: 0, width: 0, height: 20 },
    overlay: OVERLAY,
    currentScrollTop: 7,
    maxScrollTop: 100,
    targetRows: { start: 2, end: 2 },
    segments: [segment(2, 50, 56)],
  })
  assert.deepEqual(choice, { scrollTop: 7, visibleSegments: 0, fullyReadable: false })
})

test('search viewport: an anchor-only target uses conservative full-width rows', () => {
  const choice = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: OVERLAY,
    currentScrollTop: 0,
    maxScrollTop: 100,
    targetRows: { start: 2, end: 2 },
    segments: [],
  })
  // The whole painted row intersects the box, so the anchor may not be claimed
  // readable from a same-named cell outside the proven span.
  assert.deepEqual(choice, { scrollTop: 2, visibleSegments: 1, fullyReadable: true })
})

test('search viewport: re-running on its own result is idempotent', () => {
  const first = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: OVERLAY,
    currentScrollTop: 0,
    maxScrollTop: 100,
    targetRows: { start: 2, end: 2 },
    segments: [segment(2, 50, 56)],
  })
  const second = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: OVERLAY,
    currentScrollTop: first.scrollTop,
    maxScrollTop: 100,
    targetRows: { start: 2, end: 2 },
    segments: [segment(2, 50, 56)],
  })
  assert.equal(second.scrollTop, first.scrollTop, 'a second solve must not oscillate')
  assert.equal(second.fullyReadable, true)
})

test('search viewport: a fully covered viewport reports an honest partial result', () => {
  const choice = chooseSearchViewportTop({
    viewport: VIEWPORT,
    overlay: { x: 0, y: 0, width: 80, height: 20 },
    currentScrollTop: 0,
    maxScrollTop: 100,
    targetRows: { start: 5, end: 5 },
    segments: [segment(5, 10, 16)],
  })
  assert.deepEqual(choice, { scrollTop: 0, visibleSegments: 0, fullyReadable: false })
})

test('search viewport: narrow and short viewports stay inside their real bounds', () => {
  const small: PhysicalRect = { x: 3, y: 2, width: 44, height: 8 }
  const box: PhysicalRect = { x: 20, y: 3, width: 27, height: 4 }
  const choice = chooseSearchViewportTop({
    viewport: small,
    overlay: box,
    currentScrollTop: 0,
    maxScrollTop: 6,
    targetRows: { start: 4, end: 4 },
    segments: [segment(4, 0, 5)],
  })
  // Physical row = y + documentRow - scrollTop, and columns are viewport
  // relative: the left-side hit under the box row is still readable.
  assert.deepEqual(choice, { scrollTop: 0, visibleSegments: 1, fullyReadable: true })
})
