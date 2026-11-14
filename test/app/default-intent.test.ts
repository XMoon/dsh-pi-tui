/**
 * Unit tests for the pure sessionless `/model` default-intent state machine
 * (`app/command/model-default-intent.ts`) — the REAL machine the production runner uses.
 *
 * These replace the former UI-driven overlap tests (the picker now awaits the
 * global-default save, so two overlapping picks can no longer be produced
 * through the UI) while keeping the ancestry/rollback coverage honest.
 * @module @xmoon76/dsh-pi-tui/default-intent.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DefaultIntentTracker } from '../../src/app/command/model-default-intent.ts'

const a = { provider: 'p', model: 'a' }
const b = { provider: 'p', model: 'b' }
const c = { provider: 'p', model: 'c' }

test('the newest operation owns the intent; a stale commit never clears it', () => {
  const tracker = new DefaultIntentTracker()
  tracker.set(a)
  const idA = tracker.record!.id
  tracker.set(b)
  assert.deepEqual(tracker.intent, b)
  // A older operation settling must not clear or restore over the newer one.
  tracker.settle(idA, 'committed')
  assert.deepEqual(tracker.intent, b, 'a stale completion never clears a newer pending intent')
  assert.equal(tracker.outcome, undefined)
  const idB = tracker.record!.id
  tracker.settle(idB, 'committed')
  assert.equal(tracker.intent, undefined)
  assert.equal(tracker.outcome, 'committed')
})

test('a failed newer operation restores the nearest still-pending ancestor', () => {
  const tracker = new DefaultIntentTracker()
  tracker.set(a)
  const idA = tracker.record!.id
  tracker.set(b)
  const idB = tracker.record!.id
  tracker.settle(idB, 'failed')
  assert.deepEqual(tracker.intent, a, 'the pending ancestor keeps its settle authority')
  assert.equal(tracker.outcome, undefined)
  // The restored operation settles its own ancestry (none): a late failure
  // clears the intent and reports failed.
  tracker.settle(idA, 'failed')
  assert.equal(tracker.intent, undefined)
  assert.equal(tracker.outcome, 'failed')
})

test('a restored older operation that then commits reports committed', () => {
  const tracker = new DefaultIntentTracker()
  tracker.set(a)
  const idA = tracker.record!.id
  tracker.set(b)
  const idB = tracker.record!.id
  tracker.settle(idB, 'failed')
  assert.deepEqual(tracker.intent, a)
  tracker.settle(idA, 'committed')
  assert.equal(tracker.intent, undefined)
  assert.equal(tracker.outcome, 'committed')
})

test('an already-settled older operation is never restored as pending', () => {
  const tracker = new DefaultIntentTracker()
  tracker.set(a)
  const idA = tracker.record!.id
  tracker.set(b)
  const idB = tracker.record!.id
  // A settles FAILED while B owns the intent.
  tracker.settle(idA, 'failed')
  assert.deepEqual(tracker.intent, b)
  // B fails: the ancestry walk skips the settled A and clears.
  tracker.settle(idB, 'failed')
  assert.equal(tracker.intent, undefined)
  assert.equal(tracker.outcome, 'failed')
})

test('a three-layer rollback never resurrects an already-failed operation', () => {
  const tracker = new DefaultIntentTracker()
  tracker.set(a)
  const idA = tracker.record!.id
  tracker.set(b)
  const idB = tracker.record!.id
  tracker.settle(idA, 'failed')
  tracker.set(c)
  const idC = tracker.record!.id
  tracker.settle(idC, 'failed')
  assert.deepEqual(tracker.intent, b, 'the pending middle operation is restored once')
  tracker.settle(idB, 'failed')
  assert.equal(tracker.intent, undefined, 'the already-failed A is never restored as pending')
  assert.equal(tracker.outcome, 'failed')
})

test('a three-layer rollback never resurrects an already-committed operation', () => {
  const tracker = new DefaultIntentTracker()
  tracker.set(a)
  const idA = tracker.record!.id
  tracker.set(b)
  const idB = tracker.record!.id
  tracker.settle(idA, 'committed')
  tracker.set(c)
  const idC = tracker.record!.id
  tracker.settle(idC, 'failed')
  assert.deepEqual(tracker.intent, b)
  tracker.settle(idB, 'failed')
  assert.equal(tracker.intent, undefined)
  assert.equal(tracker.outcome, 'committed', 'a committed ancestor means the persisted default carries the choice')
})

test('settling an unknown operation id is a no-op', () => {
  const tracker = new DefaultIntentTracker()
  tracker.set(a)
  tracker.settle(999, 'committed')
  assert.deepEqual(tracker.intent, a)
  assert.equal(tracker.outcome, undefined)
})

test('clearing the intent resets the outcome', () => {
  const tracker = new DefaultIntentTracker()
  tracker.set(a)
  tracker.settle(tracker.record!.id, 'committed')
  tracker.set(undefined)
  assert.equal(tracker.intent, undefined)
  assert.equal(tracker.outcome, undefined)
})

test('a failed newer operation restores the nearest UNRESOLVED ancestor (never erases it)', () => {
  const tracker = new DefaultIntentTracker()
  tracker.set(a)
  tracker.set(b)
  const idB = tracker.record!.id
  tracker.settle(idB, 'unresolved')
  assert.deepEqual(tracker.intent, b, 'an unresolved intent stays active until a Host read/reconnect')
  assert.equal(tracker.outcome, 'unresolved')
  tracker.set(c)
  const idC = tracker.record!.id
  tracker.settle(idC, 'failed')
  assert.deepEqual(tracker.intent, b, 'the nearest unresolved ancestor survives a newer failure')
  assert.equal(tracker.outcome, 'unresolved', 'a newer failure must not erase the indeterminate state')
  tracker.settle(idB, 'committed')
  assert.equal(tracker.intent, undefined)
  assert.equal(tracker.outcome, 'committed')
})

test('reconcile CONFIRMS the active unresolved intent only on a matching snapshot (never fails a mismatch)', () => {
  const tracker = new DefaultIntentTracker()
  tracker.set(a)
  const idA = tracker.record!.id
  tracker.settle(idA, 'unresolved')
  tracker.set(b)
  const idB = tracker.record!.id
  tracker.settle(idB, 'unresolved')
  // A snapshot proving an OLDER value A must NOT negate the newer unresolved B:
  // the official save is async and may still commit after this read.
  tracker.reconcile(selection => selection === a)
  assert.deepEqual(tracker.intent, b, 'a non-matching snapshot leaves the unresolved intent untouched')
  assert.equal(tracker.outcome, 'unresolved', 'a non-matching snapshot never fails the choice')
  // A snapshot proving B confirms it.
  tracker.reconcile(selection => selection === b)
  assert.equal(tracker.intent, undefined, 'the matching unresolved intent commits')
  assert.equal(tracker.outcome, 'committed')
})

test('reconcile never fails a non-matching unresolved intent (an older snapshot is not proof)', () => {
  const tracker = new DefaultIntentTracker()
  tracker.set(a)
  const id = tracker.record!.id
  tracker.settle(id, 'unresolved')
  tracker.reconcile(() => false)
  assert.deepEqual(tracker.intent, a, 'the unresolved intent survives a non-matching read')
  assert.equal(tracker.outcome, 'unresolved', 'the explicit unconfirmed state is preserved')
})
