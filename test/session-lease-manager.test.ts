/**
 * Headless tests for the process session lease manager: the ownership
 * state machine (reserved/touched/active/cooling/released/pinned),
 * the lifecycle-epoch reactivation rules (a cooling verifier of an old
 * epoch can never release or pin a later lifecycle), the touched-release
 * hard assertion, the released-tombstone re-acquire rule, and the HMR
 * process-global singleton.
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
      return { result: { kind: 'acquired' }, release: () => { released.push(target.id) } }
    },
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

/** Drive a session to COOLING and return the retirement epoch. */
function cool(manager: ProcessSessionLeaseManager, id: string): number {
  manager.reserve({ id })
  manager.markTouched(id)
  manager.markActive(id)
  return manager.beginCooling(id, snapshot(id))!
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

test('lease: ACTIVE → COOLING carries the final snapshot and a NEW epoch', () => {
  const { manager } = deps()
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.markActive('session-a')
  assert.equal(manager.state('session-a')?.state, 'active')
  const epoch = manager.beginCooling('session-a', snapshot('session-a'))
  assert.equal(epoch, 2, 'lifecycleEpoch 1 → retirement bumps to 2')
  assert.equal(manager.state('session-a')?.state, 'cooling')
  assert.equal(manager.state('session-a')?.coolingEpoch, epoch)
  assert.equal(manager.state('session-a')?.snapshot?.eventCount, 0)
  assert.ok(manager.state('session-a')?.coolingStartedAt !== undefined)
})

test('lease: COOLING → RELEASED keeps a tombstone', () => {
  const { manager, released } = deps()
  const epoch = cool(manager, 'session-a')
  assert.equal(manager.releaseAfterVerifiedCooling('session-a', epoch), 'released')
  assert.deepEqual(released, ['session-a'])
  const record = manager.state('session-a')
  assert.equal(record?.state, 'released')
  assert.equal(record?.physicalLockHeld, false)
  assert.equal(record?.coolingEpoch, undefined, 'the release clears the cooling epoch')
  assert.ok(record?.releasedAt !== undefined, 'the tombstone records the release time')
  assert.equal(manager.requiresReacquire('session-a'), true)
  assert.equal(manager.canReuseLocally('session-a'), false)
})

test('lease: COOLING → PINNED keeps the physical lock', () => {
  const { manager, released } = deps()
  const epoch = cool(manager, 'session-a')
  assert.equal(manager.pinCooling('session-a', epoch, 'durable parity never stabilized'), 'pinned')
  assert.deepEqual(released, [], 'the physical lock stays')
  const record = manager.state('session-a')
  assert.equal(record?.state, 'pinned')
  assert.equal(record?.pinReason, 'durable parity never stabilized')
  assert.equal(record?.physicalLockHeld, true)
})

test('lease: RELEASED reuse MUST re-acquire the physical lock', () => {
  const { manager, acquired } = deps()
  const epoch = cool(manager, 'session-a')
  manager.releaseAfterVerifiedCooling('session-a', epoch)
  const before = acquired.length
  // The same process wants the session again: a fresh physical acquire.
  assert.deepEqual(manager.reserveForActivation({ id: 'session-a' }), { kind: 'acquired' })
  assert.equal(acquired.length, before + 1, 'released sessions MUST be re-acquired')
  assert.equal(manager.state('session-a')?.state, 'reserved')
})

test('lease: PINNED sessions never lose their physical lock', () => {
  const { manager, released } = deps()
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.pin('session-a', 'inspect unreadable')
  manager.releaseAfterVerifiedCooling('session-a', 999)
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
    acquire: () => ({ result: { kind: 'acquired' }, release: () => {} }),
  })
  first.manager.reserve({ id: 'session-hmr' })
  const second = acquireProcessLeaseManager({
    acquire: () => ({ result: { kind: 'acquired' }, release: () => {} }),
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
  })
  first.manager.reserve({ id: 'session-a' })
  first.manager.markTouched('session-a')
  first.manager.markActive('session-a')
  const second = acquireProcessLeaseManager({
    acquire: (target) => {
      newAcquires += 1
      void target
      return { result: { kind: 'acquired' }, release: () => {} }
    },
  })
  assert.equal(second.manager, first.manager, 'the SAME manager is reused')
  // NEW acquires route through the remount's deps.
  second.manager.reserve({ id: 'session-b' })
  assert.equal(newAcquires, 1, 'a new acquisition uses the current mount deps')
  // Releases of pre-remount leases keep their ORIGINAL binding.
  const epoch = second.manager.beginCooling('session-a', {
    sessionId: 'session-a', eventCount: 0, tailFingerprint: '', empty: true, capturedAt: 0,
  })!
  assert.equal(second.manager.releaseAfterVerifiedCooling('session-a', epoch), 'released')
  assert.equal(oldReleases, 1, 'the original per-lease binding released the lock')
  second.release()
  first.release()
})

test('lease: beginCooling never downgrades a PINNED lease (round 37)', () => {
  const { manager } = deps()
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.pin('session-a', 'dispose failed')
  const epoch = manager.beginCooling('session-a', {
    sessionId: 'session-a', eventCount: 0, tailFingerprint: '', empty: true, capturedAt: 0,
  })
  assert.equal(epoch, undefined, 'a pinned lease never starts a new cooling epoch')
  assert.equal(manager.state('session-a')?.state, 'pinned', 'a pinned lease stays pinned')
  // The cooling verifier cannot release it either.
  assert.equal(manager.releaseAfterVerifiedCooling('session-a', 1), 'pinned')
  assert.equal(manager.state('session-a')?.physicalLockHeld, true)
})

// ── lifecycle-epoch reactivation rules (spec §20) ────────────────────────

test('lease: COOLING → reserveForActivation bumps the epoch, keeps the lock, no re-acquire', () => {
  const { manager, acquired } = deps()
  const epoch1 = cool(manager, 'session-a')
  assert.equal(epoch1, 2)
  const before = acquired.length
  // Same-process reopen while COOLING: the physical lock is still held.
  assert.deepEqual(manager.reserveForActivation({ id: 'session-a' }), { kind: 'acquired' })
  const record = manager.state('session-a')!
  assert.equal(record.lifecycleEpoch, 3, 'the lifecycle epoch is bumped synchronously')
  assert.equal(record.coolingEpoch, undefined, 'the old cooling epoch is gone')
  assert.equal(record.snapshot, undefined)
  assert.equal(record.state, 'reserved')
  assert.equal(record.touchedByDsh, false, 'a new lifecycle starts untouched')
  assert.equal(record.physicalLockHeld, true)
  assert.equal(acquired.length, before, 'NO physical re-acquire for a held lease')
})

test('COOLING epoch1 → reactivate: releaseAfterVerifiedCooling(epoch1) is stale and never releases', () => {
  const { manager, released } = deps()
  const epoch1 = cool(manager, 'session-a')
  manager.reserveForActivation({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.markActive('session-a')
  // The OLD verifier wakes up late with its own epoch.
  assert.equal(manager.releaseAfterVerifiedCooling('session-a', epoch1), 'stale')
  assert.deepEqual(released, [], 'the lock is NOT released')
  assert.equal(manager.state('session-a')?.state, 'active')
  assert.equal(manager.state('session-a')?.physicalLockHeld, true)
})

test('COOL epoch1 → reactivate → ACTIVE: pinCooling(epoch1) is stale and never pins', () => {
  const { manager } = deps()
  const epoch1 = cool(manager, 'session-a')
  manager.reserveForActivation({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.markActive('session-a')
  // The OLD verifier hits EIO after the reactivation.
  assert.equal(manager.pinCooling('session-a', epoch1, 'late EIO'), 'stale')
  assert.equal(manager.state('session-a')?.state, 'active', 'the active lease is NOT pinned')
  assert.equal(manager.state('session-a')?.pinReason, undefined)
})

test('ABA: cooling#1 → reactivate → cooling#2 — epoch1 can never mutate epoch2', () => {
  const { manager, released } = deps()
  const epoch1 = cool(manager, 'session-a')
  // Reactivate, then switch away AGAIN (cooling #2).
  manager.reserveForActivation({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.markActive('session-a')
  const epoch2 = manager.beginCooling('session-a', snapshot('session-a', 0))!
  assert.notEqual(epoch2, epoch1, 'each retirement mints its own epoch')
  assert.equal(manager.state('session-a')?.coolingEpoch, epoch2)
  // The old verifier #1 wakes up and tries to release / pin epoch2.
  assert.equal(manager.releaseAfterVerifiedCooling('session-a', epoch1), 'stale')
  assert.equal(manager.pinCooling('session-a', epoch1, 'late failure'), 'stale')
  assert.deepEqual(released, [], 'epoch1 releases nothing')
  assert.equal(manager.state('session-a')?.state, 'cooling', 'epoch2 cooling is untouched')
  // The CURRENT verifier (epoch2) releases normally.
  assert.equal(manager.releaseAfterVerifiedCooling('session-a', epoch2), 'released')
  assert.deepEqual(released, ['session-a'])
  assert.equal(manager.state('session-a')?.state, 'released')
})

test('RELEASED → activate: a REAL physical reacquire happens', () => {
  const { manager, acquired, released } = deps()
  const epoch = cool(manager, 'session-a')
  manager.releaseAfterVerifiedCooling('session-a', epoch)
  const before = acquired.length
  assert.deepEqual(manager.reserveForActivation({ id: 'session-a' }), { kind: 'acquired' })
  assert.equal(acquired.length, before + 1, 'a released tombstone MUST be re-acquired physically')
  assert.equal(manager.state('session-a')?.state, 'reserved')
  assert.equal(manager.state('session-a')?.physicalLockHeld, true)
  // The re-acquired lease has a NEW lifecycle epoch (the old cooling
  // tokens cannot touch it).
  assert.equal(released.length, 1)
})

test('PINNED → local reactivate: the lock stays, old cooling tokens are invalid', () => {
  const { manager, released } = deps()
  const epoch1 = cool(manager, 'session-a')
  manager.pinCooling('session-a', epoch1, 'durable mismatch')
  assert.equal(manager.state('session-a')?.state, 'pinned')
  // Local re-entry into a PINNED session: allowed, lock NEVER leaves.
  assert.deepEqual(manager.reserveForActivation({ id: 'session-a' }), { kind: 'acquired' })
  const record = manager.state('session-a')!
  assert.equal(record.physicalLockHeld, true, 'reactivation never releases a pinned lock')
  assert.equal(record.state, 'reserved')
  assert.equal(record.lifecycleEpoch, epoch1 + 1)
  // Old cooling tokens are invalid after the reactivation.
  assert.equal(manager.releaseAfterVerifiedCooling('session-a', epoch1), 'stale')
  assert.equal(manager.pinCooling('session-a', epoch1, 'late'), 'stale')
  assert.deepEqual(released, [])
  // A normal new lifecycle works from the reactivated state.
  manager.markTouched('session-a')
  manager.markActive('session-a')
  assert.equal(manager.state('session-a')?.state, 'active')
})
