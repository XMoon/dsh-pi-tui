/**
 * Headless tests for the Direct owned-session retirement helper: the fixed
 * mode orders — transition `cancel → idle → descendants → flush → dispose`,
 * shutdown `cancel → idle → descendants → dispose` — and the failure
 * containment contract (a failed phase is recorded and the NEXT phase still
 * runs — a skipped dispose would re-create a handle leak).
 * @module @xmoon76/dsh-pi-tui/direct-owned-session-retirement.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  retireDirectOwnedSession,
  type DirectOwnedSessionRetirementDeps,
} from '../../../src/runtime/direct/owned-session-retirement.ts'

/** A recording retirement surface; every phase can be made to fail. */
function retirementHarness(options: {
  mode?: 'transition' | 'shutdown'
  /** The transition's live-Host regime has ENDED before the flush phase
   *  (an exit began during the idle/descendants awaits). */
  regimeEnded?: boolean
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
  const common = {
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
    disposeOwner: async () => {
      events.push('dispose')
      fail(options.disposeError)
    },
  }
  const deps = options.mode === 'shutdown'
    ? { mode: 'shutdown' as const, ...common }
    : {
        mode: 'transition' as const,
        ...common,
        // The live-Host regime is the DEFAULT for the transition harness; the
        // dedicated cases below flip it to model an exit beginning mid-flight.
        isLiveHost: () => !options.regimeEnded,
        flush: async () => {
          events.push('flush')
          fail(options.flushError)
        },
      }
  return { deps, events }
}

test('the transition retirement order is cancel → idle → descendants → flush → dispose', async () => {
  const { deps, events } = retirementHarness()
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [], 'a clean retirement reports no failures')
})

test('the shutdown retirement order is cancel → idle → descendants → dispose (no flush)', async () => {
  const { deps, events } = retirementHarness({ mode: 'shutdown' })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'dispose'],
    'shutdown must NOT run an explicit flush phase')
  assert.deepEqual(report.failures, [], 'a clean retirement reports no failures')
})

test('a throwing cancel is recorded and the remaining phases still run (transition)', async () => {
  const { deps, events } = retirementHarness({ cancelError: new Error('cancel exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'cancel', error: 'cancel exploded' }])
})

test('a throwing cancel is recorded and the remaining phases still run (shutdown)', async () => {
  const { deps, events } = retirementHarness({ mode: 'shutdown', cancelError: new Error('cancel exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'cancel', error: 'cancel exploded' }])
})

test('a rejecting whenIdle is recorded and the remaining phases still run (both modes)', async () => {
  for (const mode of ['transition', 'shutdown'] as const) {
    const { deps, events } = retirementHarness({ mode, idleError: new Error('idle exploded') })
    const report = await retireDirectOwnedSession(deps)
    const expected = mode === 'transition'
      ? ['cancel', 'idle', 'descendants', 'flush', 'dispose']
      : ['cancel', 'idle', 'descendants', 'dispose']
    assert.deepEqual(events, expected)
    assert.deepEqual(report.failures, [{ phase: 'idle', error: 'idle exploded' }])
  }
})

test('a rejecting drain is recorded and flush/dispose still run (transition)', async () => {
  const { deps, events } = retirementHarness({ drainError: new Error('drain exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'descendants', error: 'drain exploded' }])
})

test('a rejecting drain is recorded and dispose still runs (shutdown)', async () => {
  const { deps, events } = retirementHarness({ mode: 'shutdown', drainError: new Error('drain exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'descendants', error: 'drain exploded' }])
})

test('a rejecting flush is recorded and dispose still runs (no handle leak)', async () => {
  const { deps, events } = retirementHarness({ flushError: new Error('flush exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'flush', error: 'flush exploded' }])
  assert.equal(report.durabilityFailure?.phase, 'flush',
    'the transition durability failure is the flush failure')
})

test('a rejecting dispose is recorded and the report still settles (transition)', async () => {
  const { deps, events } = retirementHarness({ disposeError: new Error('dispose exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'dispose', error: 'dispose exploded' }])
  assert.equal(report.durabilityFailure, undefined,
    'a transition dispose failure is NOT the flush durability failure')
})

test('a rejecting dispose is the shutdown durability failure (durability unconfirmed)', async () => {
  const { deps, events } = retirementHarness({ mode: 'shutdown', disposeError: new Error('dispose exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'dispose', error: 'dispose exploded' }])
  assert.equal(report.durabilityFailure?.phase, 'dispose',
    'the shutdown durability failure is the dispose failure')
})

test('shutdown with idle+descendants+dispose failures: every phase runs, failures keep order and identity', async () => {
  const { deps, events } = retirementHarness({
    mode: 'shutdown',
    idleError: new Error('idle exploded'),
    drainError: new Error('drain exploded'),
    disposeError: new Error('dispose exploded'),
  })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'dispose'])
  assert.deepEqual(report.failures, [
    { phase: 'idle', error: 'idle exploded' },
    { phase: 'descendants', error: 'drain exploded' },
    { phase: 'dispose', error: 'dispose exploded' },
  ])
  assert.equal(report.durabilityFailure?.phase, 'dispose',
    'the durability failure points at dispose, not the earlier phases')
})

test('shutdown idle/drain failures with a successful dispose report NO durability failure', async () => {
  const { deps } = retirementHarness({
    mode: 'shutdown',
    idleError: new Error('idle exploded'),
    drainError: new Error('drain exploded'),
  })
  const report = await retireDirectOwnedSession(deps)
  assert.equal(report.durabilityFailure, undefined,
    'a successful dispose confirmed the durable close; earlier phase failures stay listed')
  assert.equal(report.failures.length, 2)
})

test('transition with idle+drain+flush+dispose failures all recorded, never aggregated into a throw', async () => {
  const { deps, events } = retirementHarness({
    idleError: new Error('idle exploded'),
    drainError: new Error('drain exploded'),
    flushError: new Error('flush exploded'),
    disposeError: new Error('dispose exploded'),
  })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [
    { phase: 'idle', error: 'idle exploded' },
    { phase: 'descendants', error: 'drain exploded' },
    { phase: 'flush', error: 'flush exploded' },
    { phase: 'dispose', error: 'dispose exploded' },
  ])
  assert.equal(report.durabilityFailure?.phase, 'flush',
    'the transition durability failure stays the flush failure')
})

test('a transition whose live-Host regime ENDED before the flush phase runs NO flush and maps durability to dispose', async () => {
  const { deps, events } = retirementHarness({ regimeEnded: true })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'dispose'],
    'the exit began during the retirement: DSH close owns durability, no explicit flush may run')
  assert.deepEqual(report.failures, [])
  assert.equal(report.durabilityFailure, undefined,
    'a clean dispose confirmed the durable close')
})

test('a transition whose live-Host regime ENDED reports a dispose failure as the durability failure', async () => {
  const { deps, events } = retirementHarness({ regimeEnded: true, disposeError: new Error('dispose exploded') })
  const report = await retireDirectOwnedSession(deps)
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'dispose', error: 'dispose exploded' }])
  assert.equal(report.durabilityFailure?.phase, 'dispose',
    'once the regime ended, dispose is the durability owner')
})

test('the live-Host regime is re-read at FLUSH time, not fixed at entry', async () => {
  // The harness starts LIVE and the regime ends DURING the descendants phase:
  // the helper must observe the new answer when it reaches the flush phase.
  const events: string[] = []
  let live = true
  const report = await retireDirectOwnedSession({
    mode: 'transition',
    isLiveHost: () => live,
    cancel: () => { events.push('cancel') },
    whenIdle: async () => { events.push('idle') },
    drainDescendants: async () => {
      events.push('descendants')
      live = false
    },
    flush: async () => { events.push('flush') },
    disposeOwner: async () => { events.push('dispose') },
  })
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'dispose'],
    'the flush phase must not run once the regime ended mid-retirement')
  assert.equal(report.durabilityFailure, undefined)
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

test('a flush failure that was ACTUALLY issued owns durability even after the live-Host regime ends (T1)', async () => {
  const events: string[] = []
  let live = true
  const report = await retireDirectOwnedSession({
    mode: 'transition',
    isLiveHost: () => live,
    cancel: () => { events.push('cancel') },
    whenIdle: async () => {
      events.push('idle')
      // The exit begins while the phases run; the flush below is nevertheless
      // ISSUED (the regime was still live when the phase was entered).
    },
    drainDescendants: async () => { events.push('descendants') },
    flush: async () => {
      events.push('flush')
      // The flush is ISSUED while the Host is live, then the exit begins while
      // it is in flight — the exact interleaving that used to be reclassified.
      live = false
      throw new Error('persistence listener failed: disk full')
    },
    disposeOwner: async () => { events.push('dispose') },
  })
  assert.deepEqual(events, ['cancel', 'idle', 'descendants', 'flush', 'dispose'])
  assert.deepEqual(report.failures, [{ phase: 'flush', error: 'persistence listener failed: disk full' }])
  assert.equal(report.durabilityFailure?.phase, 'flush',
    'an issued-and-failed flush must own durability even if the Host later shut down')
})

test('a flush failure and a dispose failure are BOTH kept, and durability is never washed by the abort (T2)', async () => {
  const report = await retireDirectOwnedSession({
    mode: 'transition',
    isLiveHost: () => false,
    cancel: () => {},
    whenIdle: async () => {},
    drainDescendants: async () => {},
    flush: async () => { throw new Error('flush failed: disk full') },
    disposeOwner: async () => { throw new Error('close failed: disk full') },
  })
  // The regime is already shutdown when the phases run, so the flush phase is
  // not entered at all; the dispose failure is the only durability fact.
  assert.deepEqual(report.failures, [{ phase: 'dispose', error: 'close failed: disk full' }])
  assert.equal(report.durabilityFailure?.phase, 'dispose')
})

test('a shutdown retirement keeps a dispose failure as its durability fact (T2 complement)', async () => {
  const report = await retireDirectOwnedSession({
    mode: 'shutdown',
    cancel: () => {},
    whenIdle: async () => {},
    drainDescendants: async () => {},
    disposeOwner: async () => { throw new Error('close failed') },
  })
  assert.deepEqual(report.failures, [{ phase: 'dispose', error: 'close failed' }])
  assert.equal(report.durabilityFailure?.phase, 'dispose')
})
