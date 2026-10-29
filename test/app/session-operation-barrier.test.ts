/**
 * Headless tests for the session operation barrier: writers and
 * transitions are mutually exclusive — a transition waits for in-flight
 * writers to drain, frozen writers are refused, and a failed transition
 * unfreezes.
 * @module @xmoon76/dsh-pi-tui/session-operation-barrier.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SessionOperationBarrier,
  TransitionInProgressError,
} from '../../src/app/session/operation-barrier.ts'

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

test('barrier: a writer runs through and a later transition proceeds', async () => {
  const barrier = new SessionOperationBarrier()
  const order: string[] = []
  await barrier.runWriter('session-a', async () => {
    order.push('write-start')
    await settle()
    order.push('write-end')
  })
  assert.equal(barrier.activeWriters, 0)
  await barrier.runTransition(async () => { order.push('transition') })
  assert.deepEqual(order, ['write-start', 'write-end', 'transition'])
})

test('barrier: a transition WAITS for an in-flight async writer to drain', async () => {
  const barrier = new SessionOperationBarrier()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const writer = barrier.runWriter('session-a', async () => {
    order.push('write-start')
    await gate
    order.push('write-end')
  })
  const transition = barrier.runTransition(async () => {
    order.push('transition')
  })
  await settle()
  assert.deepEqual(order, ['write-start'], 'the writer is mid-await; the transition must wait')
  release()
  await writer
  await transition
  assert.deepEqual(order, ['write-start', 'write-end', 'transition'])
})

test('barrier: a writer that starts DURING a transition is refused', async () => {
  const barrier = new SessionOperationBarrier()
  const order: string[] = []
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const transition = barrier.runTransition(async () => {
    order.push('transition-start')
    await gate
    order.push('transition-end')
  })
  await settle()
  await assert.rejects(
    barrier.runWriter('session-a', async () => { order.push('write') }),
    (error: unknown) => error instanceof TransitionInProgressError,
  )
  assert.deepEqual(order, ['transition-start'], 'no writer entered while frozen')
  release()
  await transition
})

test('barrier: a FAILED transition unfreezes and writers work again', async () => {
  const barrier = new SessionOperationBarrier()
  await assert.rejects(
    barrier.runTransition(async () => { throw new Error('transition exploded') }),
    /transition exploded/,
  )
  assert.equal(barrier.inTransition, false)
  const value = await barrier.runWriter('session-a', async () => 'ok')
  assert.equal(value, 'ok')
})

test('barrier: a reentrant transition is refused loudly', async () => {
  const barrier = new SessionOperationBarrier()
  await assert.rejects(
    barrier.runTransition(async () => {
      await barrier.runTransition(async () => {})
    }),
    /BUG: reentrant session transition/,
  )
  assert.equal(barrier.inTransition, false, 'the outer transition still unfreezes')
})

test('barrier: multiple concurrent writers all drain before the transition', async () => {
  const barrier = new SessionOperationBarrier()
  const order: string[] = []
  let release1!: () => void
  let release2!: () => void
  const g1 = new Promise<void>(resolve => { release1 = resolve })
  const g2 = new Promise<void>(resolve => { release2 = resolve })
  const w1 = barrier.runWriter('session-a', async () => { await g1; order.push('w1') })
  const w2 = barrier.runWriter('session-a', async () => { await g2; order.push('w2') })
  const transition = barrier.runTransition(async () => { order.push('transition') })
  await settle()
  release2()
  await settle()
  assert.deepEqual(order, ['w2'], 'the transition still waits for w1')
  release1()
  await w1
  await w2
  await transition
  assert.deepEqual(order, ['w2', 'w1', 'transition'])
})

// ── the control admission: Stop reaches its owner during a frozen drain ────

test('barrier: a control cancel runs while frozen and BEFORE an admitted writer drains', async () => {
  const barrier = new SessionOperationBarrier()
  const order: string[] = []
  let releaseWriter!: () => void
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve })
  const writer = barrier.runWriter('session-a', async () => {
    order.push('writer-start')
    await writerGate
    order.push('writer-end')
  })
  // `runTransition` freezes SYNCHRONOUSLY and then parks on the admitted
  // writer; the returned promise must not be awaited yet.
  const transition = barrier.runTransition(async () => { order.push('transition') })
  assert.equal(barrier.inTransition, true)
  assert.equal(barrier.activeWriters, 1)
  await barrier.runControl(async () => {
    order.push('control-cancel')
    // The control section observes the SAME frozen barrier and the same
    // outstanding writer — it did not wait for the drain and did not become
    // a writer itself.
    assert.equal(barrier.inTransition, true)
    assert.equal(barrier.activeWriters, 1)
  })
  assert.deepEqual(order, ['writer-start', 'control-cancel'],
    'the control request settles before the writer drain and before the transition body')
  releaseWriter()
  await writer
  await transition
  assert.deepEqual(order, ['writer-start', 'control-cancel', 'writer-end', 'transition'],
    'the transition still waits for the admitted writer; the control did not shortcut the commit')
})

test('barrier: a control section never admits an ordinary writer through the freeze', async () => {
  const barrier = new SessionOperationBarrier()
  let releaseTransition!: () => void
  const gate = new Promise<void>(resolve => { releaseTransition = resolve })
  const transition = barrier.runTransition(async () => { await gate })
  await assert.rejects(
    barrier.runControl(() => barrier.runWriter('session-a', async () => {})),
    (error: unknown) => error instanceof TransitionInProgressError,
    'the control hook must never become a generic writer bypass',
  )
  releaseTransition()
  await transition
  // After the transition releases the barrier the SAME writer works again.
  await barrier.runWriter('session-a', async () => {})
})

test('barrier: a failing control request neither unfreezes nor skips the writer drain', async () => {
  const barrier = new SessionOperationBarrier()
  const order: string[] = []
  let releaseWriter!: () => void
  const gate = new Promise<void>(resolve => { releaseWriter = resolve })
  const writer = barrier.runWriter('session-a', async () => {
    order.push('writer-start')
    await gate
    order.push('writer-end')
  })
  const transition = barrier.runTransition(async () => { order.push('transition') })
  await assert.rejects(
    barrier.runControl(async () => { throw new Error('cancel refused') }),
    /cancel refused/,
  )
  assert.equal(barrier.inTransition, true, 'a failed control must not unfreeze the transition')
  assert.deepEqual(order, ['writer-start'], 'the transition body still waits for the writer')
  releaseWriter()
  await writer
  await transition
  assert.deepEqual(order, ['writer-start', 'writer-end', 'transition'])
  assert.equal(barrier.inTransition, false)
})

test('barrier: a control callback may re-enter control but cannot start a transition while frozen', async () => {
  const barrier = new SessionOperationBarrier()
  const order: string[] = []
  let releaseWriter!: () => void
  const gate = new Promise<void>(resolve => { releaseWriter = resolve })
  const writer = barrier.runWriter('session-a', async () => { await gate })
  const transition = barrier.runTransition(async () => { order.push('transition') })
  await barrier.runControl(async () => {
    // A cancel callback may synchronously run another control section (the
    // Task-Center / UI settlement path). It must not deadlock.
    await barrier.runControl(() => { order.push('nested-control') })
    // It still must not start a transition on top of the frozen one.
    await assert.rejects(
      barrier.runTransition(async () => {}),
      /BUG: reentrant session transition/,
    )
    order.push('control-done')
  })
  assert.deepEqual(order, ['nested-control', 'control-done'])
  assert.equal(barrier.inTransition, true, 'the outer transition is still the only one in flight')
  releaseWriter()
  await writer
  await transition
  assert.deepEqual(order, ['nested-control', 'control-done', 'transition'])
})

test('barrier: a transition exit while a control section is in flight leaves the barrier usable', async () => {
  const barrier = new SessionOperationBarrier()
  let releaseWriter!: () => void
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve })
  const writer = barrier.runWriter('session-a', async () => { await writerGate })
  const transition = barrier.runTransition(async () => { throw new Error('transition exploded') })
  let releaseControl!: () => void
  const controlGate = new Promise<void>(resolve => { releaseControl = resolve })
  const control = barrier.runControl(async () => { await controlGate })

  releaseWriter()
  await writer
  await assert.rejects(transition, /transition exploded/)
  assert.equal(barrier.inTransition, false, 'the failed transition unfreezes although the control is still in flight')
  releaseControl()
  await control
  assert.equal(barrier.inTransition, false)
  // The control section never held the writer slot or the freeze: a later
  // writer is admitted normally.
  await barrier.runWriter('session-a', async () => {})
})
