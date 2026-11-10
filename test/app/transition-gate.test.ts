/**
 * Tests for the process-local session-transition gate: the single-writer
 * FIFO queue every live-session-mutating path (/new, /fork, rewind,
 * switch/resume, first-session creation) runs through. A transition can
 * never interleave with another — the review P1 pair (durable ghost
 * children, stale-check TOCTOU across the swap's dispose await) is
 * prevented by holding the gate from BEFORE the child create to the swap
 * commit.
 * @module @xmoon76/dsh-pi-tui/transition-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionTransitionGate } from '../../src/app/session/transition-gate.ts'

/** A promise the test resolves manually, to stage in-flight races. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Drain the microtask queue so queued gate tasks settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

test('transitions run strictly one at a time in FIFO order', async () => {
  const gate = new SessionTransitionGate()
  const order: string[] = []
  const block = deferred<void>()
  const first = gate.run(async () => {
    order.push('first-start')
    await block.promise
    order.push('first-end')
  })
  await settle()
  const second = gate.run(async () => { order.push('second') })
  await settle()
  assert.deepEqual(order, ['first-start'], 'the second transition must not start while the first holds the gate')
  block.resolve()
  await first
  await second
  assert.deepEqual(order, ['first-start', 'first-end', 'second'], 'the second transition runs only after the first commits')
})

test('a rejected transition never blocks the queued ones', async () => {
  const gate = new SessionTransitionGate()
  const order: string[] = []
  const first = gate.run(async () => {
    order.push('first')
    throw new Error('flush failed')
  })
  const second = gate.run(async () => {
    order.push('second')
  })
  await assert.rejects(first, /flush failed/)
  await second
  assert.deepEqual(order, ['first', 'second'])
})

test('re-entering the gate from inside a transition is refused loudly', async () => {
  const gate = new SessionTransitionGate()
  const nested = gate.run(async () => {
    await settle()
    // A transition must never start another transition inside itself —
    // the FIFO queue would deadlock waiting for itself.
    gate.run(async () => {})
  })
  await assert.rejects(nested, /re-entered/)
})

test('busy reports whether a transition is in flight (across awaits)', async () => {
  const gate = new SessionTransitionGate()
  assert.equal(gate.busy, false)
  const block = deferred<void>()
  const task = gate.run(async () => {
    assert.equal(gate.busy, true, 'busy must be visible inside the task')
    await block.promise
    assert.equal(gate.busy, true, 'busy must survive awaits (AsyncLocalStorage)')
  })
  await settle()
  assert.equal(gate.busy, true, 'busy must be visible outside while the task runs')
  block.resolve()
  await task
  assert.equal(gate.busy, false, 'busy clears once the task settles')
})

test('results propagate to the caller unchanged', async () => {
  const gate = new SessionTransitionGate()
  const result = await gate.run(async () => ({ rewound: true, sessionId: 'session-c' }))
  assert.deepEqual(result, { rewound: true, sessionId: 'session-c' })
})

// ── review round 4: the gate doubles as the transition write fence ─────────

test('a transition in flight is visible to concurrent submissions (write fence)', async () => {
  const gate = new SessionTransitionGate()
  const block = deferred<void>()
  const pending = gate.run(async () => { await block.promise })
  await settle()
  // While the transition is in flight (quiesce → commit), the gate reports
  // busy — the submission paths refuse writes on exactly this signal.
  assert.equal(gate.busy, true, 'submissions must see the transition in flight')
  block.resolve()
  await pending
  assert.equal(gate.busy, false, 'the fence lifts once the transition settles')
})

test('whenSettled waits for the executing transition AND the ones queued behind it', async () => {
  const gate = new SessionTransitionGate()
  const block = deferred<void>()
  const order: string[] = []
  const running = gate.run(async () => {
    order.push('running-start')
    await block.promise
    order.push('running-end')
  })
  await settle() // reason: let the running transition start before observing
  const queued = gate.run(async () => { order.push('queued') })
  let settled = false
  const waiting = gate.whenSettled().then(() => { settled = true })
  await settle() // reason: drain the waiter's first check while both are pending
  assert.equal(settled, false, 'the waiter must not settle while a transition is executing/queued')
  block.resolve()
  await running
  await queued
  await waiting
  assert.deepEqual(order, ['running-start', 'running-end', 'queued'],
    'the waiter resolves only after the whole FIFO drained')
  assert.equal(settled, true)
})

test('whenSettled resolves immediately on an idle gate and after a REJECTED transition', async () => {
  const gate = new SessionTransitionGate()
  await gate.whenSettled()
  const rejected = gate.run(async () => { throw new Error('flush failed') })
  const waiting = gate.whenSettled()
  await assert.rejects(rejected, /flush failed/)
  await waiting
  await gate.whenSettled()
})

test('a navigation intent keeps pending/whenSettled open WITHOUT occupying the FIFO', async () => {
  const gate = new SessionTransitionGate()
  const release = gate.beginIntent()
  assert.equal(gate.pending, true, 'an accepted pre-gate navigation is pending')
  assert.equal(gate.busy, false, 'an intent executes no transition')
  let settled = false
  const waiting = gate.whenSettled().then(() => { settled = true })
  await settle() // reason: drain the waiter's first check
  assert.equal(settled, false, 'whenSettled must wait for the pre-gate intent')
  // A transition queued behind the intent still runs: the intent is an
  // OBSERVATION window, never a FIFO slot.
  const order: string[] = []
  const transition = gate.run(async () => { order.push('transition') })
  await transition
  assert.deepEqual(order, ['transition'], 'the intent must not block the transition FIFO')
  await settle() // reason: drain the waiter's post-transition re-check
  assert.equal(settled, false, 'the intent itself still keeps whenSettled waiting')
  release()
  await waiting
  assert.equal(settled, true)
  assert.equal(gate.pending, false, 'releasing the last intent clears pending')
  release() // idempotent by contract
})

// ── exit retirement: pending covers the queued-but-not-started window ──────

test('pending reports a QUEUED transition before it starts (the exit pre-cancel window)', async () => {
  const gate = new SessionTransitionGate()
  const block = deferred<void>()
  // Immediately after run() returns, the task is QUEUED but not started:
  // busy is false, pending is true — the exact window the exit pre-cancel
  // must cover (a transition about to quiesce the old agent, whose
  // whenIdle does not observe the lifecycle signal).
  const first = gate.run(async () => { await block.promise })
  assert.equal(gate.busy, false, 'the queued transition has not started yet')
  assert.equal(gate.pending, true, 'the queued transition is pending before it starts')
  await settle()
  assert.equal(gate.busy, true, 'the running transition is busy')
  assert.equal(gate.pending, true, 'the running transition is pending')
  // A second transition queues behind the first: busy stays true (the
  // first still runs) and pending stays true.
  const second = gate.run(async () => {})
  await settle()
  assert.equal(gate.busy, true, 'the first transition still runs')
  assert.equal(gate.pending, true, 'the queued transition keeps pending true')
  block.resolve()
  await first
  await second
  assert.equal(gate.busy, false, 'no transition runs after both settle')
  assert.equal(gate.pending, false, 'no transition is queued after both settle')
})
