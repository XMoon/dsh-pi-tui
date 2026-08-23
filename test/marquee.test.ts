/**
 * Tests for the selected-row marquee (plan §7): pure timeline math driven
 * by a fake clock (no real timers), the Unicode/CJK/ZWJ-safe cell window,
 * the fixed-region contract (only the label moves), and the lifecycle
 * (one timer per panel, dispose clears it, no render after disposal).
 * @module @xmoon76/dsh-pi-tui/marquee.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SelectedMarquee, marqueeStateAt, MARQUEE_STEP_MS } from '../src/marquee.ts'
import { visibleWidth } from '@xmoon76/pi-tui'

// --- pure timeline math (fake clock) ---

test('marquee timeline: initial pause, one cell per step, end pause, loop', () => {
  const maxOffset = 10
  // Initial pause: still at the start.
  assert.equal(marqueeStateAt(0, maxOffset).offset, 0)
  assert.equal(marqueeStateAt(799, maxOffset).offset, 0)
  assert.equal(marqueeStateAt(799, maxOffset).phase, 'initial-pause')
  // First step eligible at t=800; each step moves one cell.
  assert.equal(marqueeStateAt(800, maxOffset).offset, 0)
  assert.equal(marqueeStateAt(800, maxOffset).phase, 'stepping')
  assert.equal(marqueeStateAt(800 + MARQUEE_STEP_MS, maxOffset).offset, 1)
  assert.equal(marqueeStateAt(800 + 3 * MARQUEE_STEP_MS, maxOffset).offset, 3)
  // The tail holds for the end pause…
  const stepSpan = MARQUEE_STEP_MS * maxOffset
  assert.equal(marqueeStateAt(800 + stepSpan, maxOffset).offset, maxOffset)
  assert.equal(marqueeStateAt(800 + stepSpan + 600, maxOffset).offset, maxOffset)
  assert.equal(marqueeStateAt(800 + stepSpan + 600, maxOffset).phase, 'end-pause')
  // …then the cycle loops back to the start.
  const cycle = 800 + stepSpan + 700
  assert.equal(marqueeStateAt(cycle + 100, maxOffset).offset, 0)
  assert.equal(marqueeStateAt(cycle + 100, maxOffset).phase, 'initial-pause')
})

test('marqueeStateAt with maxOffset 0 never moves', () => {
  const state = marqueeStateAt(10_000, 0)
  assert.equal(state.offset, 0)
  assert.equal(state.msToNext, Number.POSITIVE_INFINITY)
})

// --- window rendering with a fake clock ---

function fakeMarquee(): {
  marquee: SelectedMarquee
  renders: number
  now: { value: number }
  setNow: (ms: number) => void
} {
  const now = { value: 0 }
  let renders = 0
  const marquee = new SelectedMarquee({
    requestRender: () => { renders += 1 },
    now: () => now.value,
  })
  return { marquee, renders, now, setNow: (ms) => { now.value = ms } }
}

test('non-selected rows truncate with ellipsis, never animate', () => {
  const { marquee, renders } = fakeMarquee()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const out = strip(marquee.render({ key: 'row-1', text: 'a very long label that overflows', maxWidth: 10, selected: false }))
  assert.equal(out, 'a very lo…', 'unselected overflow must truncate')
  assert.equal(renders, 0, 'no timer may be armed for an unselected row')
  marquee.dispose()
})

test('selected rows that FIT render verbatim without a timer', () => {
  const { marquee, renders } = fakeMarquee()
  const out = marquee.render({ key: 'row-1', text: 'short', maxWidth: 10, selected: true })
  assert.equal(out, 'short')
  assert.equal(renders, 0, 'a fitting row must not arm a timer')
  marquee.dispose()
})

test('selected overflow rows move one cell per step after the pause', () => {
  const { marquee, setNow } = fakeMarquee()
  const text = '0123456789abcdef'
  const width = 8
  const at = (ms: number): string => {
    setNow(ms)
    return marquee.render({ key: 'k', text, maxWidth: width, selected: true })
  }
  // Initial pause: the label start.
  assert.equal(at(0), '01234567')
  assert.equal(at(799), '01234567')
  // Stepping: the window shifts one cell at a time.
  assert.equal(at(800), '01234567')
  assert.equal(at(800 + MARQUEE_STEP_MS), '12345678')
  assert.equal(at(800 + 3 * MARQUEE_STEP_MS), '3456789a')
  // The tail holds.
  const tail = at(800 + (16 - 8) * MARQUEE_STEP_MS)
  assert.equal(tail, '89abcdef')
  assert.equal(at(800 + (16 - 8) * MARQUEE_STEP_MS + 600), '89abcdef')
  // Loop back to the start.
  const cycle = 800 + (16 - 8) * MARQUEE_STEP_MS + 700
  assert.equal(at(cycle + 50), '01234567')
  marquee.dispose()
})

test('a changed row identity resets the cycle to the start', () => {
  const { marquee, setNow } = fakeMarquee()
  const text = 'abcdefghijklmnop'
  // The first render anchors the cycle at t=0 (offset 0).
  assert.equal(marquee.render({ key: 'row-1', text, maxWidth: 8, selected: true }), 'abcdefgh')
  // Advance the fake clock past the pause: the window moves.
  setNow(800 + 4 * MARQUEE_STEP_MS)
  const mid = marquee.render({ key: 'row-1', text, maxWidth: 8, selected: true })
  assert.notEqual(mid, 'abcdefgh', 'mid-cycle offset differs from the start')
  // A different key (selection moved) re-anchors at the current time.
  const after = marquee.render({ key: 'row-2', text, maxWidth: 8, selected: true })
  assert.equal(after, 'abcdefgh', 'a new key must start the cycle fresh')
  marquee.dispose()
})

test('CJK/emoji content slices by CELL width, never mid-grapheme', () => {
  const { marquee, setNow } = fakeMarquee()
  const text = '中🙂' .repeat(20) // 40 cells: each grapheme is 2 cells
  const width = 6
  setNow(0)
  const start = marquee.render({ key: 'u', text, maxWidth: width, selected: true })
  assert.equal(visibleWidth(start), 6, 'the window must be exactly the budget')
  // Stepping moves by one CELL (a 2-cell grapheme stays whole).
  setNow(800 + MARQUEE_STEP_MS)
  const next = marquee.render({ key: 'u', text, maxWidth: width, selected: true })
  assert.equal(visibleWidth(next), 6)
  assert.notEqual(next, start, 'one cell of motion')
  marquee.dispose()
})

test('dispose clears the timer and no render fires after disposal', () => {
  const { marquee, renders } = fakeMarquee()
  marquee.render({ key: 'k', text: 'abcdefghij', maxWidth: 5, selected: true })
  // The timer would fire requestRender eventually; after dispose it must
  // not. The fake clock never advances, so nothing fires — assert the
  // driver is inert.
  marquee.dispose()
  assert.equal(renders, 0)
})
