/**
 * Unit tests for the pure `DefaultWriteBarrier` (`src/default-write-barrier.ts`)
 * — the admission barrier a fresh create uses to wait for EVERY in-flight
 * sessionless `/model` default write (including a stale older one that is still
 * re-asserting the newest committed value).
 * @module @xmoon76/dsh-pi-tui/default-write-barrier.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultWriteBarrier } from '../src/default-write-barrier.ts'

test('wait awaits an OLDER write still settling after a NEWER one resolved', async () => {
  const barrier = new DefaultWriteBarrier()
  const order: string[] = []
  let releaseOld!: () => void
  const oldWrite = new Promise<void>((resolve) => { releaseOld = resolve })
  // The newer write settles first; the older one is still in flight (and would
  // re-assert the newest committed value through its own correction).
  barrier.track(Promise.resolve().then(() => { order.push('new') }))
  barrier.track(oldWrite.then(() => { order.push('old') }))
  let waited = false
  const waiting = barrier.wait().then(() => { waited = true })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(waited, false, 'the barrier must not resolve while the older write is in flight')
  releaseOld()
  await waiting
  assert.deepEqual(order, ['new', 'old'])
  assert.equal(barrier.size, 0, 'settled writes prune themselves')
})

test('wait loops while a newer write starts during the wait', async () => {
  const barrier = new DefaultWriteBarrier()
  let releaseFirst!: () => void
  const first = new Promise<void>((resolve) => { releaseFirst = resolve })
  barrier.track(first)
  const waiting = barrier.wait()
  // A newer write starts AFTER the wait's first snapshot.
  let releaseSecond!: () => void
  const second = new Promise<void>((resolve) => { releaseSecond = resolve })
  barrier.track(second)
  let done = false
  const observer = waiting.then(() => { done = true })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(done, false)
  releaseFirst()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(done, false, 'the newer write is still in flight')
  releaseSecond()
  await observer
  assert.equal(done, true)
})

test('wait resolves immediately with no in-flight writes', async () => {
  const barrier = new DefaultWriteBarrier()
  await barrier.wait()
  assert.equal(barrier.size, 0)
})

test('wait aborts on the lifetime signal without waiting for a hung write', async () => {
  const barrier = new DefaultWriteBarrier()
  barrier.track(new Promise<void>(() => {})) // never settles
  const controller = new AbortController()
  const waiting = barrier.wait(controller.signal)
  controller.abort()
  await assert.rejects(waiting, /aborted while waiting/)
})

test('wait throws immediately when the signal is already aborted', async () => {
  const barrier = new DefaultWriteBarrier()
  barrier.track(new Promise<void>(() => {}))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(barrier.wait(controller.signal), /abort/i)
})

test('wait throws for an already-aborted signal even with NO in-flight write', async () => {
  const barrier = new DefaultWriteBarrier()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(barrier.wait(controller.signal), /abort/i)
})
