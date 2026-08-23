/**
 * Headless tests for the cooling verifier: durable parity, stable samples,
 * delayed persistence, late writers, empty-session fast path, and the
 * fail-closed pins.
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
}

function makeRig(script: Step[], missingInspect = false): Rig {
  const released: string[] = []
  const manager = new ProcessSessionLeaseManager({
    acquire: () => ({ kind: 'acquired' }),
    release: (id) => { released.push(id) },
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
  return { manager, released, coordinator }
}

function startCooling(rig: Rig, id: string, seed: Ev[]): void {
  const snapshot = snapshotSession({ id, events: seed })
  rig.manager.reserve({ id })
  rig.manager.markTouched(id)
  rig.manager.markActive(id)
  rig.manager.beginCooling(id, snapshot)
  rig.coordinator.start(id, snapshot)
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
