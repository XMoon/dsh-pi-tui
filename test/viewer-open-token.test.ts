/**
 * Regression tests for the async viewer-OPEN invalidation token
 * (createViewerOpenToken, src/index.ts): a slow transcript inspection
 * must never commit an obsolete child over the current surface. The
 * runner closure is not headless-drivable, so the lifecycle rule is
 * pinned through the token semantics — every viewer session change
 * (opening another child, Esc while NO viewer is mounted, a session
 * swap routing through exitView) invalidates every in-flight open.
 * @module @xmoon76/dsh-pi-tui/viewer-open-token.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createViewerOpenToken, teardownViewerForSessionSwap } from '../src/index.ts'

test('an open request stays current until ANY viewer session change', () => {
  const token = createViewerOpenToken()
  const request = token.open()
  assert.equal(token.isCurrent(request), true, 'a fresh open may commit')
  // Another open (a second child chosen while the first inspection is in
  // flight) supersedes the first.
  const second = token.open()
  assert.equal(token.isCurrent(request), false, 'the first open must be stale once a newer open started')
  assert.equal(token.isCurrent(second), true, 'the newer open must stay current')
})

test('an Esc with NO mounted viewer invalidates an in-flight open (round-5 repro)', () => {
  // exitView invalidates UNCONDITIONALLY — even when viewing is undefined
  // (the open is still in flight, so there is nothing to exit): the Esc
  // must prevent the pending inspection from mounting the child later.
  const token = createViewerOpenToken()
  const request = token.open()
  token.invalidate() // the exitView path with viewing === undefined
  assert.equal(token.isCurrent(request), false, 'the Esc must cancel the pending open')
})

test('a session swap cancels an in-flight open even when NO viewer is mounted (round-6 repro)', () => {
  // The open is still loading (nothing mounted yet): the swap must STILL
  // invalidate it — a stale inspection must never mount the old child
  // over the new session. (This models bumpSessionGeneration's
  // teardownViewerForSessionSwap with mounted=false; the old conditional
  // `if (viewing !== undefined)` skipped the teardown entirely here.)
  const token = createViewerOpenToken()
  const request = token.open()
  let closes = 0
  const closed = teardownViewerForSessionSwap(token, false, () => { closes += 1 })
  assert.equal(closed, false, 'nothing was mounted to close')
  assert.equal(closes, 0)
  assert.equal(token.isCurrent(request), false, 'the swap must cancel the pending open')
})

test('a session swap closes a MOUNTED viewer and invalidates in-flight opens', () => {
  const token = createViewerOpenToken()
  const request = token.open()
  let closes = 0
  const closed = teardownViewerForSessionSwap(token, true, () => { closes += 1 })
  assert.equal(closed, true)
  assert.equal(closes, 1, 'the mounted viewer must be closed')
  assert.equal(token.isCurrent(request), false, 'the pending open must be cancelled too')
})

test('invalidate is safe to repeat and never re-arms a stale request', () => {
  const token = createViewerOpenToken()
  const request = token.open()
  token.invalidate()
  token.invalidate()
  token.invalidate()
  assert.equal(token.isCurrent(request), false)
  // A NEW open starts a fresh generation: the old request stays stale.
  const next = token.open()
  assert.equal(token.isCurrent(request), false)
  assert.equal(token.isCurrent(next), true)
})
