/**
 * L1 contract of the shared terminal-progress interval fold (plan §5.1/§5.2,
 * §9 row L1): the ONE classifier every authority (Direct surface routing,
 * Remote Host plugin) instantiates.
 *
 * These tests are deliberately PURE: they drive the fold directly, so they
 * pin the semantics (which outcome a given edge sequence can PROVE) without
 * borrowing any transport, terminal or session fixture. The real event order
 * of the installed rc.2 AgentLoop is proven separately by
 * `terminal-progress-event-order.test.ts`; the mounted-surface behaviour by
 * `terminal-progress-lifecycle.test.ts`.
 *
 * @module @xmoon76/dsh-pi-tui/terminal-progress-interval.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTerminalProgressInterval } from '../src/domain/terminal-progress/interval.ts'

test('every official turn-end reason classifies to the fixed outcome', () => {
  const cases: ReadonlyArray<readonly [string, 'idle' | 'done' | 'error']> = [
    ['completed', 'done'],
    ['error', 'error'],
    ['max-tokens', 'error'],
    ['aborted', 'idle'],
    ['blocked', 'idle'],
    ['interrupted', 'idle'],
    ['forked', 'idle'],
  ]
  for (const [kind, expected] of cases) {
    const interval = createTerminalProgressInterval()
    assert.equal(interval.status(true)?.active, true, `${kind}: the running edge opens the interval`)
    interval.turnStart(7)
    interval.turnEnd(7, kind)
    assert.equal(interval.status(false)?.outcome, expected, `${kind} must settle ${expected}`)
  }
})

test('an unknown upstream turn-end reason is reported, not guessed', () => {
  const reported: string[] = []
  const interval = createTerminalProgressInterval(kind => reported.push(kind))
  interval.status(true)
  interval.turnStart(3)
  interval.turnEnd(3, 'brand-new-kind')
  assert.deepEqual(reported, ['brand-new-kind'], 'the unknown kind reaches the injected reporter exactly once')
  assert.equal(interval.status(false)?.outcome, 'idle', 'an unknown kind can never prove done/error')
  assert.equal(interval.snapshot().outcome, 'idle')
})

test('only a turn/end that closes the open turn can prove an outcome', () => {
  // 1. end without any start (a replay / foreign turn) is ignored.
  const unmatched = createTerminalProgressInterval()
  unmatched.status(true)
  unmatched.turnEnd(4, 'completed')
  assert.equal(unmatched.status(false)?.outcome, 'idle', 'an unmatched end never proves a completion')

  // 2. an OPEN turn at the falling edge has no evidence at all.
  const open = createTerminalProgressInterval()
  open.status(true)
  open.turnStart(5)
  assert.equal(open.status(false)?.outcome, 'idle', 'an unclosed turn settles idle')

  // 3. a same-number end arriving OUTSIDE the interval is inert.
  const outside = createTerminalProgressInterval()
  outside.turnStart(6)
  outside.turnEnd(6, 'completed')
  outside.status(true)
  outside.status(false)
  outside.turnEnd(6, 'error')
  assert.equal(outside.snapshot().outcome, 'idle', 'an end recorded outside the interval never revives a result')
})

test('a newer turn invalidates the older closed candidate', () => {
  const interval = createTerminalProgressInterval()
  interval.status(true)
  interval.turnStart(1)
  interval.turnEnd(1, 'completed')
  // The interval already holds a proven `done`, but turn 2 opened and FAILED:
  // the LAST valid closed turn decides, never the first.
  interval.turnStart(2)
  interval.turnEnd(2, 'error')
  assert.equal(interval.status(false)?.outcome, 'error', 'the newest closed turn decides the interval')
})

test('a repeated status is inert in both directions', () => {
  const interval = createTerminalProgressInterval()
  assert.equal(interval.status(true)?.active, true)
  assert.equal(interval.status(true), undefined, 'a repeated running edge never re-opens the interval')
  interval.turnStart(1)
  interval.turnEnd(1, 'completed')
  assert.equal(interval.status(false)?.outcome, 'done')
  assert.equal(interval.status(false), undefined, 'a repeated idle never re-settles')
  assert.equal(interval.snapshot().outcome, 'done', 'the proven outcome survives a repeated idle')
})

test('retire keeps a proven outcome and retires a live interval to idle', () => {
  const proven = createTerminalProgressInterval()
  proven.status(true)
  proven.turnStart(1)
  proven.turnEnd(1, 'completed')
  proven.status(false)
  assert.deepEqual(proven.retire(), { active: false, outcome: 'done' }, 'a settled done/error is retained')
  // Logically idempotent: a repeat publishes the SAME state (`undefined` is
  // reserved for "already idle, nothing to commit"), and the mounted app's
  // equal-write dedupe keeps the repeat physically inert — exactly the
  // #255 retention contract this extraction must not change.
  assert.deepEqual(proven.retire(), { active: false, outcome: 'done' }, 'a repeat never changes the retained state')

  const live = createTerminalProgressInterval()
  live.status(true)
  assert.deepEqual(live.retire(), { active: false, outcome: 'idle' }, 'a still-live interval retires to idle')
  assert.equal(live.retire(), undefined)

  const untouched = createTerminalProgressInterval()
  assert.equal(untouched.retire(), undefined, 'an already idle interval commits nothing')
})

test('reset discards the previous owner result', () => {
  const interval = createTerminalProgressInterval()
  interval.status(true)
  interval.turnStart(1)
  interval.turnEnd(1, 'error')
  interval.status(false)
  assert.deepEqual(interval.reset(), { active: false, outcome: 'idle' }, 'a rebind always commits idle')
  assert.deepEqual(interval.snapshot(), { active: false, outcome: 'idle' })
  // `turnEnd` returns void: the effective witness is the interval's state, not
  // its return value.
  interval.turnEnd(1, 'completed')
  assert.equal(interval.snapshot().outcome, 'idle', 'the previous owner evidence cannot settle the new owner')
  assert.equal(interval.status(true)?.outcome, 'idle', 'the new owner starts from a fresh interval')
  assert.equal(interval.status(false)?.outcome, 'idle', 'the new owner must prove its OWN turn evidence')
})

test('apply adopts an already-classified fact and drops the local turn evidence', () => {
  const interval = createTerminalProgressInterval()
  interval.status(true)
  interval.turnStart(1)
  // The Remote Host owner classified the settle for its own interval: the
  // applied fact IS the state, and the local candidate cannot survive it.
  assert.deepEqual(interval.apply({ active: false, outcome: 'done' }), { active: false, outcome: 'done' })
  assert.deepEqual(interval.snapshot(), { active: false, outcome: 'done' })
  interval.apply({ active: true, outcome: 'idle' })
  assert.deepEqual(interval.snapshot(), { active: true, outcome: 'idle' })
  // The discarded local candidate can never re-settle the adopted interval.
  interval.turnEnd(1, 'completed')
  assert.deepEqual(interval.snapshot(), { active: true, outcome: 'idle' })
  assert.deepEqual(interval.apply({ active: false, outcome: 'error' }), { active: false, outcome: 'error' })
  assert.deepEqual(interval.retire(), { active: false, outcome: 'error' }, 'retire republishes the retained state')
  assert.deepEqual(interval.snapshot(), { active: false, outcome: 'error' }, 'the applied result survives retire')
})

test('the fold latches before the reporter re-enters it', () => {
  // The reporter runs synchronously from inside `turnEnd`; the real caller
  // commits physically right after each command returns (TuiApp may re-enter
  // the fold through a synchronous callback). The fold must therefore expose
  // the post-command state, never the pre-command one.
  const seen: Array<{ active: boolean; outcome: string }> = []
  let interval: ReturnType<typeof createTerminalProgressInterval>
  interval = createTerminalProgressInterval(() => {
    seen.push(interval.snapshot())
    // A re-entrant status must not corrupt the in-flight turn/end.
    assert.equal(interval.status(true), undefined, 'a re-entrant running status is inert')
  })
  interval.status(true)
  interval.turnStart(9)
  interval.turnEnd(9, 'unknown-kind')
  assert.deepEqual(seen, [{ active: true, outcome: 'idle' }], 'the reporter sees the latching interval, still idle')
  assert.deepEqual(interval.snapshot(), { active: true, outcome: 'idle' })
  assert.equal(interval.status(false)?.outcome, 'idle', 'the interval still settles honestly after the re-entry')
})
