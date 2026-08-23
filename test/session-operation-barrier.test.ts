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
} from '../src/session-operation-barrier.ts'

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
