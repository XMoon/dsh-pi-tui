/**
 * Headless tests for the cooling verifier: durable parity, stable samples,
 * delayed persistence, late writers, empty-session fast path, the
 * fail-closed pins, and the EPOCH rules (a reactivated or re-cooled
 * session makes every older verifier a silent stale no-op).
 * @module @xmoon76/dsh-pi-tui/session-lease-cooling.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SessionLeaseCoolingCoordinator,
  snapshotSession,
  tailFingerprintOf,
  type CoolingPersistenceLike,
} from '../src/session-lease-cooling.ts'
import { ProcessSessionLeaseManager } from '../src/session-lease-manager.ts'

type Ev = { seq: number; type: string; time: number; data: unknown }
type Step = { events?: Ev[]; error?: Error } | 'not-found'

function events(count: number): Ev[] {
  const out: Ev[] = []
  for (let i = 0; i < count; i += 1) {
    out.push({ seq: i, type: i % 2 === 0 ? 'user' : 'assistant', time: 1700000000000 + i, data: { text: `m${i}` } })
  }
  return out
}

interface Rig {
  manager: ProcessSessionLeaseManager
  released: string[]
  coordinator: SessionLeaseCoolingCoordinator
  /** The retirement epoch of the last startCooling call. */
  epoch: number
}

function makeRig(script: Step[], missingInspect = false): Rig {
  const released: string[] = []
  const manager = new ProcessSessionLeaseManager({
    acquire: (target) => ({ result: { kind: 'acquired' }, release: () => { released.push(target.id) } }),
  })
  let cursor = 0
  const persistence = (): CoolingPersistenceLike | undefined => {
    if (missingInspect) return {}
    return {
      inspect: async (id: string) => {
        const step = script[Math.min(cursor, script.length - 1)]
        cursor += 1
        if (step === 'not-found') throw new Error(`session "${id}" not found`)
        if (step?.error !== undefined) throw step.error
        return { events: step?.events ?? [] }
      },
    }
  }
  const coordinator = new SessionLeaseCoolingCoordinator({
    leaseManager: manager,
    persistence,
    diag: { info: () => {}, warn: () => {}, error: () => {} },
    params: { quietMs: 5, intervalMs: 5, requiredStable: 3, maxMs: 150 },
  })
  return { manager, released, coordinator, epoch: 0 }
}

function startCooling(rig: Rig, id: string, seed: Ev[]): void {
  const snapshot = snapshotSession({ id, events: seed })
  rig.manager.reserve({ id })
  rig.manager.markTouched(id)
  rig.manager.markActive(id)
  rig.epoch = rig.manager.beginCooling(id, snapshot)!
  rig.coordinator.start(id, snapshot, rig.epoch)
}

async function settle(ms = 60): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

test('cooling: 3 stable identical samples release the lease', async () => {
  const seed = events(100)
  const rig = makeRig([{ events: seed }, { events: seed }, { events: seed }])
  startCooling(rig, 'session-a', seed)
  await settle()
  assert.deepEqual(rig.released, ['session-a'])
  assert.equal(rig.manager.state('session-a')?.state, 'released')
})

test('cooling: delayed persistence catches up within the window and releases', async () => {
  const seed = events(100)
  const behind = events(99)
  const rig = makeRig([{ events: behind }, { events: seed }, { events: seed }, { events: seed }])
  startCooling(rig, 'session-a', seed)
  await settle()
  assert.deepEqual(rig.released, ['session-a'], 'a delayed persistence that catches up still releases')
})

test('cooling: a late writer that never settles pins (no release on growth)', async () => {
  const seed = events(100)
  const grown = events(101)
  const rig = makeRig([{ events: seed }, { events: grown }, { events: grown }, { events: grown }, { events: grown }])
  startCooling(rig, 'session-a', seed)
  await settle(250)
  assert.deepEqual(rig.released, [])
  assert.equal(rig.manager.state('session-a')?.state, 'pinned', 'durable growth that never matches the snapshot pins')
})

test('cooling: an inspect read error pins immediately', async () => {
  const seed = events(100)
  const rig = makeRig([{ error: Object.assign(new Error('EIO'), { code: 'EIO' }) }])
  startCooling(rig, 'session-a', seed)
  await settle()
  assert.deepEqual(rig.released, [])
  assert.equal(rig.manager.state('session-a')?.state, 'pinned')
  assert.match(rig.manager.state('session-a')?.pinReason ?? '', /EIO/)
})

test('cooling: a missing inspect() pins (no reliable durable read)', async () => {
  const seed = events(100)
  const rig = makeRig([], true)
  startCooling(rig, 'session-a', seed)
  await settle()
  assert.deepEqual(rig.released, [])
  assert.equal(rig.manager.state('session-a')?.state, 'pinned')
})

test('cooling: an empty session releases after repeated authoritative not-found', async () => {
  const rig = makeRig(['not-found', 'not-found', 'not-found'])
  startCooling(rig, 'session-a', [])
  await settle()
  assert.deepEqual(rig.released, ['session-a'], 'the empty-session fast path releases')
  assert.equal(rig.manager.state('session-a')?.state, 'released')
})

test('cooling: an empty session that becomes MATERIALIZED pins', async () => {
  const rig = makeRig([{ events: events(1) }])
  startCooling(rig, 'session-a', [])
  await settle()
  assert.deepEqual(rig.released, [])
  assert.equal(rig.manager.state('session-a')?.state, 'pinned')
  assert.match(rig.manager.state('session-a')?.pinReason ?? '', /materialized/)
})

test('cooling: a durable artifact that DISAPPEARS pins', async () => {
  const seed = events(100)
  const rig = makeRig([{ events: seed }, 'not-found'])
  startCooling(rig, 'session-a', seed)
  await settle()
  assert.equal(rig.manager.state('session-a')?.state, 'pinned')
  assert.match(rig.manager.state('session-a')?.pinReason ?? '', /disappeared/)
})

test('cooling: the DSH_PI_TUI_SESSION_COOLING_RELEASE=0 emergency fallback pins', async () => {
  const previous = process.env.DSH_PI_TUI_SESSION_COOLING_RELEASE
  process.env.DSH_PI_TUI_SESSION_COOLING_RELEASE = '0'
  try {
    const seed = events(100)
    const rig = makeRig([{ events: seed }, { events: seed }, { events: seed }])
    startCooling(rig, 'session-a', seed)
    await settle()
    assert.deepEqual(rig.released, [])
    assert.equal(rig.manager.state('session-a')?.state, 'pinned')
  } finally {
    if (previous === undefined) delete process.env.DSH_PI_TUI_SESSION_COOLING_RELEASE
    else process.env.DSH_PI_TUI_SESSION_COOLING_RELEASE = previous
  }
})

test('cooling: a truncated history with the SAME tail fingerprint pins (event count + last seq matter)', async () => {
  // A truncated durable history whose LAST 16 events are identical to the
  // final snapshot's tail has the same tail fingerprint — only the full
  // parity triple (event count, last seq, fingerprint) catches it.
  const full = events(100)
  const truncated = full.slice(84)
  assert.equal(tailFingerprintOf(full), tailFingerprintOf(truncated), 'the tail is byte-identical')
  const rig = makeRig([{ events: truncated }, { events: truncated }, { events: truncated }, { events: truncated }])
  startCooling(rig, 'session-a', full)
  await settle(250)
  assert.deepEqual(rig.released, [])
  assert.equal(rig.manager.state('session-a')?.state, 'pinned', 'a shortened history never matches the full snapshot')
})

// ── epoch rules (spec §21): a stale verifier is a silent no-op ──────────

/** A gated inspect rig: every inspect awaits a deferred the test resolves
 *  manually, so the test can reactivate BETWEEN the verifier's samples. */
interface GatedRig extends Rig {
  inspectCalls: number
  pending: Array<(value: { events: Ev[] } | { error: Error }) => void>
  /** Resolve the OLDEST pending inspect with events (or an error). */
  succeedNext: (value: { events: Ev[] } | { error: Error }) => void
}

function makeGatedRig(): GatedRig {
  const base = makeRig([])
  const pending: Array<(value: { events: Ev[] } | { error: Error }) => void> = []
  let inspectCalls = 0
  const manager = base.manager
  const coordinator = new SessionLeaseCoolingCoordinator({
    leaseManager: manager,
    persistence: () => ({
      inspect: async () => {
        inspectCalls += 1
        return new Promise<{ events: Ev[] }>((resolve, reject) => {
          pending.push(value => {
            if ('error' in value) reject(value.error)
            else resolve(value)
          })
        })
      },
    }),
    diag: { info: () => {}, warn: () => {}, error: () => {} },
    params: { quietMs: 5, intervalMs: 5, requiredStable: 3, maxMs: 500 },
  })
  return {
    manager,
    released: base.released,
    coordinator,
    epoch: 0,
    // GETTER: the object literal must not snapshot the counter by value
    // (the AGENTS.md mutable-counter trap).
    get inspectCalls() { return inspectCalls },
    pending,
    succeedNext: (value) => { pending.shift()?.(value) },
  }
}

/** Wait until the gated rig's inspect has been called N times. */
async function waitForInspections(rig: GatedRig, count: number): Promise<void> {
  const deadline = Date.now() + 1000
  while (rig.inspectCalls < count) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a gated inspect')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('Case A: an old verifier finishing after a reactivation never releases', async () => {
  const seed = events(100)
  const rig = makeGatedRig()
  startCooling(rig, 'session-a', seed)
  // Sample 1 (stable): the verifier is suspended inside the inspect.
  await waitForInspections(rig, 1)
  rig.succeedNext({ events: seed })
  // Sample 2 (stable).
  await waitForInspections(rig, 2)
  rig.succeedNext({ events: seed })
  // Sample 3 is now suspended mid-flight; REACTIVATE the session
  // in-process while the old verifier hangs in its durable read.
  await waitForInspections(rig, 3)
  rig.manager.reserveForActivation({ id: 'session-a' })
  rig.manager.markTouched('session-a')
  rig.manager.markActive('session-a')
  // The old verifier's final stable sample lands AFTER the reactivation.
  rig.succeedNext({ events: seed })
  await settle(80)
  assert.deepEqual(rig.released, [], 'the stale verifier must NOT release the reactivated session')
  assert.equal(rig.manager.state('session-a')?.state, 'active')
  assert.equal(rig.manager.state('session-a')?.physicalLockHeld, true)
})

test('Case B: a stale verifier failure never pins the reactivated session', async () => {
  const seed = events(100)
  const rig = makeGatedRig()
  startCooling(rig, 'session-a', seed)
  // The verifier is suspended inside its first inspect.
  await waitForInspections(rig, 1)
  rig.manager.reserveForActivation({ id: 'session-a' })
  rig.manager.markTouched('session-a')
  rig.manager.markActive('session-a')
  // The stale inspect now rejects with EIO.
  rig.succeedNext({ error: Object.assign(new Error('EIO'), { code: 'EIO' }) })
  await settle(80)
  assert.equal(rig.manager.state('session-a')?.state, 'active', 'the current lease is NOT pinned')
  assert.equal(rig.manager.state('session-a')?.pinReason, undefined)
})

test('Case C: ABA — a stale verifier can neither release nor pin cooling#2', async () => {
  const seed = events(100)
  const rig = makeGatedRig()
  startCooling(rig, 'session-a', seed) // cooling #1 (epoch 2)
  // The epoch-1 verifier is suspended in its first inspect.
  await waitForInspections(rig, 1)
  // Reactivate, then switch away AGAIN: cooling #2 gets a NEW epoch.
  rig.manager.reserveForActivation({ id: 'session-a' })
  rig.manager.markTouched('session-a')
  rig.manager.markActive('session-a')
  const snapshot2 = snapshotSession({ id: 'session-a', events: seed })
  const epoch2 = rig.manager.beginCooling('session-a', snapshot2)!
  assert.notEqual(epoch2, rig.epoch, 'cooling #2 has a different epoch')
  // A NEW verifier task starts for epoch2 while epoch1 still runs.
  rig.coordinator.start('session-a', snapshot2, epoch2)
  // Epoch1's suspended inspect now fails — it must be a stale no-op.
  rig.succeedNext({ error: Object.assign(new Error('EIO'), { code: 'EIO' }) })
  await settle(40)
  assert.equal(rig.manager.state('session-a')?.state, 'cooling', 'epoch2 cooling is untouched')
  assert.equal(rig.manager.state('session-a')?.coolingEpoch, epoch2)
  // Epoch2 completes normally: 3 stable samples → release.
  await waitForInspections(rig, 2)
  rig.succeedNext({ events: seed })
  await waitForInspections(rig, 3)
  rig.succeedNext({ events: seed })
  await waitForInspections(rig, 4)
  rig.succeedNext({ events: seed })
  await settle(80)
  assert.deepEqual(rig.released, ['session-a'], 'only the CURRENT epoch releases')
  assert.equal(rig.manager.state('session-a')?.state, 'released')
})

test('Case D: a newer retirement is accepted while the old task still runs (epoch-keyed inFlight)', async () => {
  const seed = events(100)
  const rig = makeGatedRig()
  startCooling(rig, 'session-a', seed)
  await waitForInspections(rig, 1)
  // Cooling #2 starts while cooling #1 is STILL in flight.
  rig.manager.reserveForActivation({ id: 'session-a' })
  rig.manager.markTouched('session-a')
  rig.manager.markActive('session-a')
  const snapshot2 = snapshotSession({ id: 'session-a', events: seed })
  const epoch2 = rig.manager.beginCooling('session-a', snapshot2)!
  rig.coordinator.start('session-a', snapshot2, epoch2)
  // Both tasks are now awaiting inspects; the SECOND task must run to
  // completion (it was NOT suppressed by the same session id).
  await waitForInspections(rig, 2)
  rig.succeedNext({ events: seed }) // epoch1 sample — stale at its next check
  rig.succeedNext({ events: seed }) // epoch2 sample 1
  await waitForInspections(rig, 3)
  rig.succeedNext({ events: seed }) // epoch2 sample 2
  await waitForInspections(rig, 4)
  rig.succeedNext({ events: seed }) // epoch2 sample 3
  await settle(100)
  assert.deepEqual(rig.released, ['session-a'], 'epoch2 was accepted and released')
  assert.equal(rig.manager.state('session-a')?.state, 'released')
})

test('Case E: an HMR abort is neutral — COOLING stays COOLING, resumePending continues the SAME epoch', async () => {
  const seed = events(100)
  const released: string[] = []
  const manager = new ProcessSessionLeaseManager({
    acquire: (target) => ({ result: { kind: 'acquired' }, release: () => { released.push(target.id) } }),
  })
  const snapshot = snapshotSession({ id: 'session-a', events: seed })
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.markActive('session-a')
  const epoch = manager.beginCooling('session-a', snapshot)!
  // The OLD coordinator (with a lifecycle signal) starts the retirement.
  const controller = new AbortController()
  const oldCoordinator = new SessionLeaseCoolingCoordinator({
    leaseManager: manager,
    persistence: () => ({
      inspect: async () => ({ events: seed }),
    }),
    diag: { info: () => {}, warn: () => {}, error: () => {} },
    // A LONG quiet window so the abort lands INSIDE the sleep.
    params: { quietMs: 1000, intervalMs: 5, requiredStable: 3, maxMs: 5000 },
    signal: controller.signal,
  })
  oldCoordinator.start('session-a', snapshot, epoch)
  // Abort the old lifecycle while the verifier sleeps.
  controller.abort()
  await settle(60)
  assert.equal(manager.state('session-a')?.state, 'cooling', 'an HMR abort must NOT pin')
  assert.equal(manager.state('session-a')?.coolingEpoch, epoch)
  // The NEW mount's coordinator resumes the SAME cooling epoch.
  const fresh = new SessionLeaseCoolingCoordinator({
    leaseManager: manager,
    persistence: () => ({
      inspect: async () => ({ events: seed }),
    }),
    diag: { info: () => {}, warn: () => {}, error: () => {} },
    params: { quietMs: 5, intervalMs: 5, requiredStable: 3, maxMs: 500 },
  })
  fresh.resumePending()
  await settle(80)
  assert.deepEqual(released, ['session-a'], 'the resumed verifier completes the original retirement')
  assert.equal(manager.state('session-a')?.state, 'released')
})
