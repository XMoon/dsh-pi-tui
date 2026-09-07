/**
 * Headless tests for the Direct owned-session retirement helper: the fixed
 * order `cancel → idle → descendants → flush → dispose` and the failure
 * containment contract (a failed phase is recorded and the NEXT phase still
 * runs — a skipped dispose would re-create a handle leak).
 * @module @xmoon76/dsh-pi-tui/direct-owned-session-retirement.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  retireDirectOwnedSession,
  type DirectOwnedSessionRetirementDeps,
} from '../src/runtime/direct/owned-session-retirement.ts'

/** A recording retirement surface; every phase can be made to fail. */
function retirementHarness(options: {
  cancelError?: unknown
  idleError?: unknown
  drainError?: unknown
  flushError?: unknown
  disposeError?: unknown
} = {}): {
  deps: DirectOwnedSessionRetirementDeps
  events: string[]
} {
  const events: string[] = []
  const fail = (error: unknown): void => {
    if (error !== undefined) throw error
  }
  return {
    deps: {
      cancel: () => {
        events.push('cancel')
        fail(options.cancelError)
      },
      whenIdle: async () => {
        events.push('idle')
        fail(options.idleError)
      },
      drainDescendants: async () => {
        events.push('descendants')
        fail(options.drainError)
      },
      flush: async () => {
        events.push('flush')
        fail(options.flushError)
      },
      disposeOwner: async () => {
        events.push('dispose')
        fail(options.disposeError)
      },
    },
    events,
  }
}

test('the fixed retirement order is cancel → idle → descendants → flush → dispose', async () => {
  const { deps, events } = retirementHarness()
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [], 'a clean retirement reports no failures')
})

test('a throwing cancel is recorded and the remaining phases still run', async () => {
  const { deps, events } = retirementHarness({ cancelError: new Error('cancel exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'cancel', error: 'cancel exploded' }])
})

test('a rejecting whenIdle is recorded and descendants/flush/dispose still run', async () => {
  const { deps, events } = retirementHarness({ idleError: new Error('idle exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'idle', error: 'idle exploded' }])
})

test('a rejecting drain is recorded and flush/dispose still run', async () => {
  const { deps, events } = retirementHarness({ drainError: new Error('drain exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'descendants', error: 'drain exploded' }])
})

test('a rejecting flush is recorded and dispose still runs (no handle leak)', async () => {
  const { deps, events } = retirementHarness({ flushError: new Error('flush exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'flush', error: 'flush exploded' }])
})

test('a rejecting dispose is recorded and the report still settles', async () => {
  const { deps, events } = retirementHarness({ disposeError: new Error('dispose exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'dispose', error: 'dispose exploded' }])
})

test('multiple phase failures are all recorded, never aggregated into a throw', async () => {
  const { deps, events } = retirementHarness({
    idleError: new Error('idle exploded'),
    drainError: new Error('drain exploded'),
    disposeError: new Error('dispose exploded'),
  })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [
    { phase: 'idle', error: 'idle exploded' },
    { phase: 'descendants', error: 'drain exploded' },
    { phase: 'dispose', error: 'dispose exploded' },
  ])
})

test('a hostile thrown value is contained by safeErrorMessage', async () => {
  const hostile = {
    toString() {
      throw new Error('stringify exploded')
    },
  }
  const { deps } = retirementHarness({ flushError: hostile })
  const report = await retireDirectOwnedSession(deps)
  assert.equal(report.failures.length, 1)
  assert.equal(report.failures[0]?.phase, 'flush')
  assert.equal(report.failures[0]?.error, '<unprintable error>')
})
