#!/usr/bin/env node
/**
 * The narrow teardown contract the two Tern drivers depend on: a stop request
 * is NOT a termination, and a shutdown must not resolve until EVERY direct
 * child has reached `close`.
 *
 * The children here are EventEmitters, not processes. This file owns the
 * ORDERING seam — when `close` arrives — because a real SIGKILL cannot be
 * delayed and the defect this guards (a teardown that resolves right after
 * `kill()`) is invisible against a process that dies in microseconds. The
 * end-to-end signal paths are covered in `tern-gui-drive.test.mjs` and
 * `tern-pane-drive.test.mjs`.
 *
 * @module test/tooling/owned-child-shutdown.test
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { ownChild, stopOwnedChildren } from '../../scripts/lib/owned-child-shutdown.mjs'

/** A ChildProcess-shaped child whose `close` this test delivers by hand. */
function fakeChild(pid) {
  const child = new EventEmitter()
  child.pid = pid
  child.kills = []
  child.kill = (signal) => {
    child.kills.push(signal)
    return true
  }
  return child
}

/** Let the shutdown's promise chain run one turn without advancing a clock. */
const tick = () => new Promise((resolve) => setImmediate(resolve))

/**
 * Run one shutdown over two owned children and assert it waits for BOTH.
 *
 * `order` fixes which child closes first, so the "one child closed, the other
 * still open" state is exercised in both directions: a shutdown that resolved
 * on the FIRST close would report the other child as gone without evidence.
 */
async function assertWaitsForBoth(order) {
  const windowChild = fakeChild(101)
  const daemonChild = fakeChild(102)
  const handles = [ownChild(windowChild, { kind: 'window' }), ownChild(daemonChild, { kind: 'daemon' })]
  const children = { window: windowChild, daemon: daemonChild }
  let report
  let done = false
  const pending = stopOwnedChildren(handles).then((result) => {
    done = true
    report = result
  })

  await tick()
  assert.deepEqual(windowChild.kills, ['SIGKILL'], 'the window gets one stop request')
  assert.deepEqual(daemonChild.kills, ['SIGKILL'], 'the daemon gets one stop request')
  assert.equal(done, false, 'a stop request alone must not resolve the shutdown')

  const [first, second] = order
  children[first].emit('close', null, 'SIGKILL')
  await tick()
  assert.equal(done, false, `the shutdown must not resolve while the ${second} is still open`)

  children[second].emit('close', null, 'SIGKILL')
  await pending
  assert.equal(report.timedOut, false)
  assert.deepEqual(report.survivors, [])
  assert.deepEqual(report.settled.map((handle) => handle.kind).sort(), ['daemon', 'window'])
}

test('the shutdown waits for both direct children before it resolves', async () => {
  await assertWaitsForBoth(['window', 'daemon'])
  await assertWaitsForBoth(['daemon', 'window'])
})

test('a child that never closes is reported as a survivor, not as a finished teardown', async () => {
  const stubborn = fakeChild(201)
  // reason: the deadline IS the behaviour under test here — a child that never
  // closes must produce a bounded failure that names it, not a hang.
  const outcome = await stopOwnedChildren([ownChild(stubborn, { kind: 'window' })], { deadlineMs: 40 })
  assert.equal(outcome.timedOut, true)
  assert.deepEqual(outcome.settled, [])
  assert.deepEqual(outcome.survivors.map((handle) => `${handle.kind}:${handle.pid}`), ['window:201'])
})

test('a child that never spawned settles on its spawn error without a close event', async () => {
  // A failed spawn has no PID and therefore no later OS state: the error IS
  // the child's terminal state, and waiting for a `close` that may never come
  // would turn every broken TERN_BIN into a five-second stall.
  const doomed = fakeChild(undefined)
  const pending = stopOwnedChildren([ownChild(doomed, { kind: 'daemon' })])
  doomed.emit('error', Object.assign(new Error('spawn tern ENOENT'), { code: 'ENOENT' }))
  const outcome = await pending
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.settled[0].error.code, 'ENOENT')
})

test('an error on a running child is not its termination; only close settles it', async () => {
  const child = fakeChild(301)
  const handle = ownChild(child, { kind: 'window' })
  let done = false
  const pending = stopOwnedChildren([handle], { deadlineMs: 1_000 }).then((result) => {
    done = true
    return result
  })

  await tick()
  // `error` is ALSO emitted when a kill request fails; that proves nothing
  // about whether the process is still running.
  child.emit('error', new Error('kill EPERM'))
  await tick()
  assert.equal(done, false, 'a failed kill request must not be read as termination')
  assert.equal(handle.error.message, 'kill EPERM')

  child.emit('close', 0, null)
  const outcome = await pending
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.settled[0].exitCode, 0)
})

test('repeated teardown entries send the stop request exactly once', () => {
  const child = fakeChild(401)
  const handle = ownChild(child, { kind: 'window' })
  assert.equal(handle.stop(), true, 'the first entry delivers the signal')
  assert.equal(handle.stop(), false, 'a second entry must not send it again')
  child.emit('close', null, 'SIGKILL')
  assert.equal(handle.stop(), false, 'a closed child is never signalled again')
  assert.deepEqual(child.kills, ['SIGKILL'])
})

test('a child that closed before the shutdown started is already settled and not signalled', async () => {
  const child = fakeChild(501)
  const handle = ownChild(child, { kind: 'daemon' })
  child.emit('close', null, 'SIGKILL')
  const outcome = await stopOwnedChildren([handle])
  assert.equal(outcome.timedOut, false)
  assert.deepEqual(outcome.settled.map((handle) => handle.kind), ['daemon'])
  assert.deepEqual(child.kills, [], 'a child that already exited is not sent another signal')
})
