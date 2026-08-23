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
import { SessionTransitionGate } from '../src/transition-gate.ts'

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
