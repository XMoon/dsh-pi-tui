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

// ── the user-navigation stop: frozen FIRST, stop SECOND, drain THIRD ───────

test('barrier: the navigation stop runs exactly once, after the freeze and BEFORE the admitted writer drains', async () => {
  const barrier = new SessionOperationBarrier()
  const order: string[] = []
  let releaseWriter!: () => void
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve })
  const writer = barrier.runWriter('session-a', async () => {
    order.push('writer-start')
    await writerGate
    order.push('writer-end')
  })
  let stopCalls = 0
  // The stop must see the ALREADY frozen barrier: that is the guarantee that no
  // new ordinary writer can enter while it is being sent.
  let frozenDuringStop = false
  const transition = barrier.runTransition(
    async () => { order.push('transition') },
    async () => {
      stopCalls += 1
      frozenDuringStop = barrier.inTransition
      order.push('navigation-stop')
    },
  )
  assert.equal(barrier.inTransition, true)
  assert.equal(barrier.activeWriters, 1)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.deepEqual(order, ['writer-start', 'navigation-stop'],
    'the stop settles while the admitted writer is still running and before the body')
  assert.equal(frozenDuringStop, true, 'the stop observes the frozen barrier')
  assert.equal(stopCalls, 1, 'the navigation stop runs exactly once')

  releaseWriter()
  await writer
  await transition
  assert.deepEqual(order, ['writer-start', 'navigation-stop', 'writer-end', 'transition'],
    'the body still waits for the admitted writer after the stop')
  assert.equal(stopCalls, 1)
})

test('barrier: a FAILED navigation stop aborts before the drain, never runs the body, and unfreezes', async () => {
  const barrier = new SessionOperationBarrier()
  const order: string[] = []
  let releaseWriter!: () => void
  const writerGate = new Promise<void>(resolve => { releaseWriter = resolve })
  const writer = barrier.runWriter('session-a', async () => {
    order.push('writer-start')
    await writerGate
    order.push('writer-end')
  })
  const transition = barrier.runTransition(
    async () => { order.push('transition') },
    async () => { order.push('navigation-stop'); throw new Error('navigation stop refused') },
  )
  await assert.rejects(transition, /navigation stop refused/)
  assert.deepEqual(order, ['writer-start', 'navigation-stop'],
    'a failed stop must not wait for the drain and must not run the body')
  assert.equal(barrier.inTransition, false, 'the aborted navigation unfreezes the barrier')
  releaseWriter()
  await writer
  assert.deepEqual(order, ['writer-start', 'navigation-stop', 'writer-end'])
  // The barrier is fully usable after the aborted navigation.
  await barrier.runTransition(async () => { order.push('next-transition') })
  assert.deepEqual(order, ['writer-start', 'navigation-stop', 'writer-end', 'next-transition'])
})

test('barrier: the navigation stop is not a writer admission (writers stay refused while frozen)', async () => {
  const barrier = new SessionOperationBarrier()
  let releaseStop!: () => void
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
  const transition = barrier.runTransition(
    async () => {},
    () => stopGate,
  )
  // While the stop is in flight the barrier is frozen: an ordinary write is
  // refused and a nested transition is refused loudly, exactly as during the
  // drain.
  await assert.rejects(
    barrier.runWriter('session-a', async () => {}),
    (error: unknown) => error instanceof TransitionInProgressError,
  )
  await assert.rejects(
    barrier.runTransition(async () => {}),
    /BUG: reentrant session transition/,
  )
  releaseStop()
  await transition
  await barrier.runWriter('session-a', async () => {})
})
