/**
 * Headless tests for the process session lease manager: the ownership
 * state machine (reserved/touched/active/cooling/released/pinned),
 * the touched-release hard assertion, the released-tombstone re-acquire
 * rule, and the HMR process-global singleton.
 * @module @xmoon76/dsh-pi-tui/session-lease-manager.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acquireProcessLeaseManager,
  ProcessSessionLeaseManager,
  resetProcessLeaseRegistryForTests,
  type RetiredSessionSnapshot,
} from '../src/session-lease-manager.ts'

test.after(() => {
  resetProcessLeaseRegistryForTests()
})

function deps(): {
  manager: ProcessSessionLeaseManager
  acquired: string[]
  released: string[]
} {
  const acquired: string[] = []
  const released: string[] = []
  const manager = new ProcessSessionLeaseManager({
    acquire: (target) => {
      acquired.push(target.id)
      return { result: { kind: 'acquired' } }
    },
    release: (id) => { released.push(id) },
  })
  return { manager, acquired, released }
}

function snapshot(id: string, eventCount = 0, empty = true): RetiredSessionSnapshot {
  return {
    sessionId: id,
    eventCount,
    tailFingerprint: empty ? '' : `hash-${eventCount}`,
    empty,
    capturedAt: Date.now(),
  }
}

test('lease: an untouched RESERVED lease may be released', () => {
  const { manager, released } = deps()
  assert.deepEqual(manager.reserve({ id: 'session-a' }), { kind: 'acquired' })
  assert.equal(manager.canReuseLocally('session-a'), true)
  manager.releaseUntouched('session-a')
  assert.deepEqual(released, ['session-a'])
  assert.equal(manager.state('session-a'), undefined, 'UNOWNED leaves no record')
})

test('lease: releasing a TOUCHED lease throws (the DSH boundary hard rule)', () => {
  const { manager, released } = deps()
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  assert.throws(
    () => manager.releaseUntouched('session-a'),
    /BUG: attempted to release a session lease after the DSH boundary/,
  )
  assert.deepEqual(released, [], 'the physical lock is never released')
  assert.equal(manager.canReuseLocally('session-a'), true)
})

test('lease: ACTIVE → COOLING carries the final snapshot', () => {
  const { manager } = deps()
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.markActive('session-a')
  assert.equal(manager.state('session-a')?.state, 'active')
  manager.beginCooling('session-a', snapshot('session-a'))
  assert.equal(manager.state('session-a')?.state, 'cooling')
  assert.equal(manager.state('session-a')?.snapshot?.eventCount, 0)
  assert.ok(manager.state('session-a')?.coolingStartedAt !== undefined)
})

test('lease: COOLING → RELEASED keeps a tombstone', () => {
  const { manager, released } = deps()
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.markActive('session-a')
  manager.beginCooling('session-a', snapshot('session-a'))
  manager.releaseAfterVerifiedCooling('session-a')
  assert.deepEqual(released, ['session-a'])
  const record = manager.state('session-a')
  assert.equal(record?.state, 'released')
  assert.equal(record?.physicalLockHeld, false)
  assert.ok(record?.releasedAt !== undefined, 'the tombstone records the release time')
  assert.equal(manager.requiresReacquire('session-a'), true)
  assert.equal(manager.canReuseLocally('session-a'), false)
})

test('lease: COOLING → PINNED keeps the physical lock', () => {
  const { manager, released } = deps()
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.markActive('session-a')
  manager.beginCooling('session-a', snapshot('session-a'))
  manager.pin('session-a', 'durable parity never stabilized')
  assert.deepEqual(released, [], 'the physical lock stays')
  const record = manager.state('session-a')
  assert.equal(record?.state, 'pinned')
  assert.equal(record?.pinReason, 'durable parity never stabilized')
  assert.equal(record?.physicalLockHeld, true)
})

test('lease: RELEASED reuse MUST re-acquire the physical lock', () => {
  const { manager, acquired } = deps()
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.markActive('session-a')
  manager.beginCooling('session-a', snapshot('session-a'))
  manager.releaseAfterVerifiedCooling('session-a')
  const before = acquired.length
  // The same process wants the session again: a fresh physical acquire.
  assert.deepEqual(manager.reserve({ id: 'session-a' }), { kind: 'acquired' })
  assert.equal(acquired.length, before + 1, 'released sessions MUST be re-acquired')
  assert.equal(manager.state('session-a')?.state, 'reserved')
})

test('lease: PINNED sessions never lose their physical lock', () => {
  const { manager, released } = deps()
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.pin('session-a', 'inspect unreadable')
  manager.releaseAfterVerifiedCooling('session-a')
  assert.deepEqual(released, [], 'a pinned session is never released by the cooling path')
  assert.equal(manager.state('session-a')?.physicalLockHeld, true)
})

test('lease: held-lease reserve is an idempotent no-op', () => {
  const { manager, acquired } = deps()
  manager.reserve({ id: 'session-a' })
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.reserve({ id: 'session-a' })
  assert.deepEqual(acquired, ['session-a'], 'exactly one physical acquire')
  assert.equal(manager.canReuseLocally('session-a'), true)
})

test('lease: multiple session leases coexist (the transition holds old+new)', () => {
  const { manager, acquired } = deps()
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.markActive('session-a')
  manager.reserve({ id: 'session-b' })
  manager.markTouched('session-b')
  manager.markActive('session-b')
  manager.beginCooling('session-a', snapshot('session-a'))
  assert.deepEqual(acquired, ['session-a', 'session-b'])
  assert.equal(manager.snapshot().length, 2)
  assert.equal(manager.canReuseLocally('session-a'), true, 'old+new held at once')
  assert.equal(manager.canReuseLocally('session-b'), true)
})

test('lease: the process-global registry reuses the manager across remounts (HMR)', () => {
  const first = acquireProcessLeaseManager({
    acquire: () => ({ result: { kind: 'acquired' } }),
    release: () => {},
  })
  first.manager.reserve({ id: 'session-hmr' })
  const second = acquireProcessLeaseManager({
    acquire: () => ({ result: { kind: 'acquired' } }),
    release: () => {},
  })
  assert.equal(second.manager, first.manager, 'a remount reuses the SAME manager')
  assert.equal(second.manager.canReuseLocally('session-hmr'), true, 'physical ownership survives the remount')
  second.release()
  first.release()
})

test('lease: a remount swaps the physical deps for NEW acquires; releases keep their original binding', () => {
  let oldReleases = 0
  let newAcquires = 0
  const first = acquireProcessLeaseManager({
    acquire: (target) => {
      void target
      return { result: { kind: 'acquired' }, release: () => { oldReleases += 1 } }
    },
    release: () => {},
  })
  first.manager.reserve({ id: 'session-a' })
  first.manager.markTouched('session-a')
  first.manager.markActive('session-a')
  const second = acquireProcessLeaseManager({
    acquire: (target) => {
      newAcquires += 1
      void target
      return { result: { kind: 'acquired' } }
    },
    release: () => {},
  })
  assert.equal(second.manager, first.manager, 'the SAME manager is reused')
  // NEW acquires route through the remount's deps.
  second.manager.reserve({ id: 'session-b' })
  assert.equal(newAcquires, 1, 'a new acquisition uses the current mount deps')
  // Releases of pre-remount leases keep their ORIGINAL binding.
  second.manager.beginCooling('session-a', {
    sessionId: 'session-a', eventCount: 0, tailFingerprint: '', empty: true, capturedAt: 0,
  })
  second.manager.releaseAfterVerifiedCooling('session-a')
  assert.equal(oldReleases, 1, 'the original per-lease binding released the lock')
  second.release()
  first.release()
})
