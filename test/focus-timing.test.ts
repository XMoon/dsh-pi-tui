/**
 * The live Focus timer: user-blocked waits (approval/question) are excluded
 * from the active duration, every other phase keeps accumulating, and a
 * completed turn freezes its live value.
 * @module @xmoon76/dsh-pi-tui/focus-timing.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { FocusTimingStore, focusTimerPaused } from '../src/focus-timing.ts'
import type { TurnActivity } from '../src/transcript.ts'

/** A minimal mutable activity; the timer only reads start/end/completed. The
 * cast is identity-preserving, so the store's WeakMap sees ONE object. */
interface FakeActivity {
  startedAt?: number
  endedAt?: number
  completed: boolean
}

function make(startedAt?: number): FakeActivity {
  return { startedAt, completed: false }
}

function asActivity(activity: FakeActivity): TurnActivity {
  return activity as unknown as TurnActivity
}

test('focusTimerPaused is exactly the user-blocked phases', () => {
  assert.equal(focusTimerPaused('waiting-approval'), true)
  assert.equal(focusTimerPaused('waiting-question'), true)
  for (const phase of ['working', 'compacting', 'applying-compaction', 'idle'] as const) {
    assert.equal(focusTimerPaused(phase), false, phase)
  }
})

test('the plan timeline: an approval wait freezes the timer and resume continues', () => {
  // t=0 working, t=10 waiting-approval, t=40 working, t=50 completed.
  const store = new FocusTimingStore()
  const activity = make(0)
  assert.equal(store.activeMillis(asActivity(activity), 'working', 9_000), 9_000, 't=9 → Working 9s')
  // The app observes the transition when the approval opens (no render).
  store.observe(asActivity(activity), 'waiting-approval', 10_000)
  assert.equal(store.activeMillis(asActivity(activity), 'waiting-approval', 20_000), 10_000, 't=20 → Waiting for approval · 10s')
  assert.equal(store.activeMillis(asActivity(activity), 'waiting-approval', 39_000), 10_000, 't=39 → still 10s')
  store.observe(asActivity(activity), 'working', 40_000)
  assert.equal(store.activeMillis(asActivity(activity), 'working', 45_000), 15_000, 't=45 → Working 15s')
  activity.completed = true
  activity.endedAt = 50_000
  assert.equal(store.activeMillis(asActivity(activity), 'idle', 60_000), 20_000, 'finish → Completed 20s')
})

test('a question wait freezes the timer exactly like approval', () => {
  const store = new FocusTimingStore()
  const activity = make(1_000)
  store.observe(asActivity(activity), 'working', 4_000)
  store.observe(asActivity(activity), 'waiting-question', 4_000)
  assert.equal(store.activeMillis(asActivity(activity), 'waiting-question', 34_000), 3_000, 'the 30s question wait must not count')
  store.observe(asActivity(activity), 'working', 34_000)
  assert.equal(store.activeMillis(asActivity(activity), 'working', 40_000), 9_000, 'resume continues from the frozen value')
})

test('repeated waiting phases accumulate only the active spans', () => {
  const store = new FocusTimingStore()
  const activity = make(0)
  store.observe(asActivity(activity), 'working', 5_000)
  store.observe(asActivity(activity), 'waiting-approval', 5_000)
  store.observe(asActivity(activity), 'working', 8_000) // +3s
  store.observe(asActivity(activity), 'waiting-question', 12_000) // freeze at 8 + 4 = 12s
  store.observe(asActivity(activity), 'working', 20_000)
  assert.equal(store.activeMillis(asActivity(activity), 'working', 22_000), 11_000, '0-5 + 8-12 + 20-22 = 11s')
})

test('idle gaps and compaction phases keep accumulating (only user waits freeze)', () => {
  const store = new FocusTimingStore()
  const activity = make(0)
  store.observe(asActivity(activity), 'working', 5_000)
  store.observe(asActivity(activity), 'idle', 7_000)
  store.observe(asActivity(activity), 'compacting', 9_000)
  store.observe(asActivity(activity), 'applying-compaction', 11_000)
  assert.equal(store.activeMillis(asActivity(activity), 'idle', 20_000), 20_000, 'non-user gaps still count')
})

test('a completed turn freezes its live value instead of the wall elapsed', () => {
  const store = new FocusTimingStore()
  const activity = make(0)
  store.observe(asActivity(activity), 'working', 10_000)
  store.observe(asActivity(activity), 'waiting-approval', 10_000)
  // The turn finishes while the approval is open: the 30s wait is excluded.
  activity.completed = true
  activity.endedAt = 40_000
  assert.equal(store.activeMillis(asActivity(activity), 'idle', 100_000), 10_000)
})

test('a completed historical turn without live state uses the event elapsed fallback', () => {
  const store = new FocusTimingStore()
  const historical = { startedAt: 1_000, endedAt: 35_000, completed: true }
  assert.equal(store.activeMillis(asActivity(historical), 'idle', 999_999), 34_000)
})

test('a new turn never inherits the previous turn pause', () => {
  const store = new FocusTimingStore()
  const first = make(0)
  store.observe(asActivity(first), 'working', 5_000)
  store.observe(asActivity(first), 'waiting-approval', 5_000)
  // The first turn's wait resolves; the second turn starts much later.
  store.observe(asActivity(first), 'working', 6_000)
  const second = make(40_000)
  assert.equal(store.activeMillis(asActivity(second), 'working', 45_000), 5_000, 'the new turn counts its own active span from its start')
})

test('a missing startedAt never fabricates a 0s timer', () => {
  const store = new FocusTimingStore()
  assert.equal(store.activeMillis(asActivity(make(undefined)), 'working', 50_000), undefined)
  assert.equal(store.activeMillis(asActivity(make(undefined)), 'waiting-approval', 50_000), undefined)
})

test('a turn first observed while already waiting seeds no active span', () => {
  const store = new FocusTimingStore()
  const activity = make(0)
  store.observe(asActivity(activity), 'waiting-approval', 10_000)
  assert.equal(store.activeMillis(asActivity(activity), 'waiting-approval', 30_000), 0, 'no known active span → 0, never the fabricated wall time')
})

test('a live turn first observed during a pause counts up to the recorded pause boundary', () => {
  // The approval opens BEFORE the delayed transcript repaint publishes the
  // activity: the store has seen working → waiting-approval, so the pause
  // boundary is known even though the activity is new (review P1).
  const store = new FocusTimingStore()
  store.notePhase('working', 0)
  store.notePhase('waiting-approval', 8_000)
  const activity = make(0)
  assert.equal(store.activeMillis(asActivity(activity), 'waiting-approval', 30_000), 8_000, 'the pre-wait span survives')
})

test('the pause boundary never counts a turn that started after the pause opened', () => {
  const store = new FocusTimingStore()
  store.notePhase('working', 0)
  store.notePhase('waiting-approval', 8_000)
  const late = make(10_000)
  assert.equal(store.activeMillis(asActivity(late), 'waiting-approval', 30_000), 0)
})

test('a pause that resolves before the activity publishes is still subtracted', () => {
  // Fast prompt resolution inside the delayed-publication gap: the store
  // sees working → waiting-approval → working before the activity exists
  // (review round-2 finding). The retained pause window must still be
  // subtracted.
  const store = new FocusTimingStore()
  store.notePhase('working', 0)
  store.notePhase('waiting-approval', 10_000)
  store.notePhase('working', 20_000)
  const activity = make(0)
  assert.equal(store.activeMillis(asActivity(activity), 'working', 25_000), 15_000, '0-10 + 20-25 = 15s')
})

test('a turn that starts after a resolved pause window subtracts nothing', () => {
  const store = new FocusTimingStore()
  store.notePhase('working', 0)
  store.notePhase('waiting-approval', 10_000)
  store.notePhase('working', 20_000)
  const late = make(21_000)
  assert.equal(store.activeMillis(asActivity(late), 'working', 25_000), 4_000)
})

test('repeated pauses inside the publication gap are all subtracted', () => {
  // Multiple short waits (e.g. an already-aborted prompt resolving
  // synchronously) can open and close before the activity map publishes.
  const store = new FocusTimingStore()
  store.notePhase('working', 0)
  store.notePhase('waiting-approval', 10_000)
  store.notePhase('working', 12_000)
  store.notePhase('waiting-question', 14_000)
  store.notePhase('working', 16_000)
  const activity = make(0)
  // Active: 0-10 + 12-14 + 16-20 = 16s of the 20s wall time.
  assert.equal(store.activeMillis(asActivity(activity), 'working', 20_000), 16_000)
})

test('two activities first seen in the same pass both subtract the closed pause', () => {
  const store = new FocusTimingStore()
  store.notePhase('working', 0)
  store.notePhase('waiting-approval', 10_000)
  store.notePhase('working', 20_000)
  const first = make(0)
  const second = make(0)
  assert.equal(store.activeMillis(asActivity(first), 'working', 25_000), 15_000)
  assert.equal(store.activeMillis(asActivity(second), 'working', 25_000), 15_000, 'the second first-seen activity must share the window snapshot')
})

test('two activities first seen during the same pause both stop at the boundary', () => {
  const store = new FocusTimingStore()
  store.notePhase('working', 0)
  store.notePhase('waiting-approval', 10_000)
  const first = make(0)
  const second = make(0)
  assert.equal(store.activeMillis(asActivity(first), 'waiting-approval', 25_000), 10_000)
  assert.equal(store.activeMillis(asActivity(second), 'waiting-approval', 25_000), 10_000)
})

test('clearPauseWindows drops the retained windows after a publication pass', () => {
  const store = new FocusTimingStore()
  store.notePhase('working', 0)
  store.notePhase('waiting-approval', 10_000)
  store.notePhase('working', 20_000)
  store.clearPauseWindows()
  const late = make(0)
  assert.equal(store.activeMillis(asActivity(late), 'working', 25_000), 25_000, 'no windows retained → wall time')
})

test('observing a pause twice does not double-count', () => {
  const store = new FocusTimingStore()
  const activity = make(0)
  store.observe(asActivity(activity), 'working', 5_000)
  store.observe(asActivity(activity), 'waiting-approval', 5_000)
  store.observe(asActivity(activity), 'waiting-approval', 9_000)
  store.observe(asActivity(activity), 'waiting-approval', 30_000)
  assert.equal(store.activeMillis(asActivity(activity), 'waiting-approval', 50_000), 5_000)
})
