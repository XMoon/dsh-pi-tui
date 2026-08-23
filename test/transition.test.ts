/**
 * Headless tests for the canonical session transition (the convergence
 * plan flow): quiesce → preflight → target lease → DSH boundary (touched)
 * → create (a rejection is NEVER retried — the target is PINNED
 * immediately) → synchronous COMMIT (no lock changes) → retire (dispose +
 * cooling handover).
 * @module @xmoon76/dsh-pi-tui/transition.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runTransitionTo,
  type TransitionHost,
  type TransitionSteps,
} from '../src/transition.ts'
import { ProcessSessionLeaseManager } from '../src/session-lease-manager.ts'

interface Handle {
  agent: { session: { id: string } }
}

function handle(sessionId: string): Handle {
  return { agent: { session: { id: sessionId } } }
}

interface FakeHostOptions {
  quiesceError?: string
  prepareError?: string
  createError?: string
  retireError?: string
  targetLockRefused?: string
  targetLockUnavailable?: boolean
  snapshot?: { sessionId: string; eventCount: number; tailFingerprint: string; empty: boolean; capturedAt: number }
}

function fakeHost(options: FakeHostOptions = {}): {
  host: TransitionHost<Handle>
  events: string[]
  failures: string[]
  pins: string[]
} {
  const events: string[] = []
  const failures: string[] = []
  const pins: string[] = []
  const host: TransitionHost<Handle> = {
    quiesceOld: async () => {
      events.push('old.flush')
      if (options.quiesceError !== undefined) throw new Error(options.quiesceError)
      return options.snapshot
    },
    acquireTargetLease: (target) => {
      events.push(`target.lock.acquire:${target.id}`)
      if (options.targetLockRefused !== undefined) return { kind: 'refused', message: options.targetLockRefused }
      if (options.targetLockUnavailable === true) return { kind: 'unavailable', reason: 'no-lock-dir' }
      return { kind: 'acquired' }
    },
    releaseUntouchedTarget: (sessionId: string) => { events.push(`target.lock.release:${sessionId}`) },
    markTargetTouched: (sessionId) => { events.push(`target.touched:${sessionId}`) },
    commit: () => { events.push('child.commit') },
    retireOld: async () => {
      events.push('old.dispose')
      if (options.retireError !== undefined) throw new Error(options.retireError)
    },
    pinTarget: (sessionId, reason) => {
      events.push(`target.pinned:${sessionId}`)
      pins.push(reason)
    },
    recordFailure: (phase, error) => {
      failures.push(`${phase}:${error instanceof Error ? error.message : String(error)}`)
    },
  }
  return { host, events, failures, pins }
}

function steps(events: string[], options: { prepareError?: string; createError?: string } = {}): TransitionSteps<Handle> {
  return {
    target: { id: 'session-c', header: { cwd: '/ws' } },
    prepare: options.prepareError === undefined
      ? async () => { events.push('prepare') }
      : async () => { events.push('prepare'); throw new Error(options.prepareError) },
    create: options.createError === undefined
      ? async () => { events.push('child.create'); return handle('session-c') }
      : async () => { events.push('child.create'); throw new Error(options.createError) },
  }
}

test('the canonical order is flush → prepare → target lease → touched → create → commit → dispose', async () => {
  const { host, events } = fakeHost({ snapshot: { sessionId: 'session-a', eventCount: 0, tailFingerprint: '', empty: true, capturedAt: 0 } })
  const outcome = await runTransitionTo(host, steps(events))
  assert.equal(outcome.ok, true)
  assert.deepEqual(events, [
    'old.flush',              // 1. old quiesce + final flush (lock held)
    'prepare',                // 2. ALL preflight BEFORE the DSH boundary
    'target.lock.acquire:session-c', // 3. target lease (old lock still held)
    'target.touched:session-c',      // 4. the DSH boundary
    'child.create',         // 5. create — published from here on
    'child.commit',           // 6. synchronous COMMIT (NO lock changes)
    'old.dispose',            // 7. old handle disposed; the old lease goes to cooling
  ], 'the old lock is NOT released anywhere in the transition')
})

test('a quiesce/flush failure aborts with zero child side effects', async () => {
  const { host, events, failures } = fakeHost({ quiesceError: 'flush disk full' })
  const outcome = await runTransitionTo(host, steps(events))
  assert.deepEqual(outcome, { ok: false, message: 'transition failed: flush disk full' })
  assert.deepEqual(events, ['old.flush'], 'nothing was locked, touched or created')
  assert.deepEqual(failures, ['quiesce:flush disk full'])
})

test('a PREFLIGHT failure aborts BEFORE the target is even locked', async () => {
  const { host, events, failures } = fakeHost()
  const outcome = await runTransitionTo(host, steps(events, { prepareError: 'roster unavailable' }))
  assert.equal(outcome.ok, false)
  assert.deepEqual(events, ['old.flush', 'prepare'],
    'the target lease is never taken — zero side effects')
  assert.deepEqual(failures, ['prepare:roster unavailable'])
})

test('a refused target lease fails closed before the DSH boundary', async () => {
  const { host, events, failures } = fakeHost({ targetLockRefused: 'held by another process' })
  const outcome = await runTransitionTo(host, steps(events))
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /held by another process/)
  assert.deepEqual(events, ['old.flush', 'prepare', 'target.lock.acquire:session-c'],
    'no create, no touched, nothing published')
  assert.deepEqual(failures, ['target-lock:held by another process'])
})

test('an UNAVAILABLE target lease fails closed for EVERY writable target', async () => {
  const { host, events } = fakeHost({ targetLockUnavailable: true })
  const outcome = await runTransitionTo(host, steps(events))
  assert.equal(outcome.ok, false, 'fresh AND existing require the physical owner lock')
  assert.match(outcome.ok === false ? outcome.message : '', /cannot lock the session/)
  assert.deepEqual(events, ['old.flush', 'prepare', 'target.lock.acquire:session-c'])
})

test('a create rejection PINNS the target (lock kept, old stays current, NEVER retried)', async () => {
  const { host, events, failures, pins } = fakeHost()
  const outcome = await runTransitionTo(host, steps(events, { createError: 'DSH publication failed' }))
  assert.equal(outcome.ok, false)
  assert.deepEqual(events, [
    'old.flush', 'prepare', 'target.lock.acquire:session-c', 'target.touched:session-c', 'child.create',
    'target.pinned:session-c',
  ], 'no same-id recovery, no second fresh create, no unlock — the target is pinned')
  assert.equal(pins.length, 1)
  assert.match(pins[0]!, /DSH create\/resume failed: DSH publication failed/)
  assert.deepEqual(failures, ['create:DSH publication failed'])
})

test('a retire failure NEVER rolls the committed child back', async () => {
  const { host, events, failures } = fakeHost({ retireError: 'old dispose exploded' })
  const outcome = await runTransitionTo(host, steps(events))
  assert.equal(outcome.ok, true, 'the child is committed and stands despite the retire failure')
  if (outcome.ok) assert.equal(outcome.next.agent.session.id, 'session-c')
  assert.deepEqual(events, [
    'old.flush', 'prepare', 'target.lock.acquire:session-c', 'target.touched:session-c',
    'child.create', 'child.commit', 'old.dispose',
  ])
  assert.deepEqual(failures, ['retire:old dispose exploded'])
})

// ── the ownership lifecycle: the old lease outlives the whole transition ───

test('the old lease survives COMMIT + dispose — the transition releases NOTHING', async () => {
  const acquired: string[] = []
  const released: string[] = []
  const manager = new ProcessSessionLeaseManager({
    acquire: (target) => { acquired.push(target.id); return { result: { kind: 'acquired' }, release: () => {} } },
  })
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.markActive('session-a')
  const events: string[] = []
  const host: TransitionHost<Handle> = {
    quiesceOld: async () => ({ sessionId: 'session-a', eventCount: 2, tailFingerprint: 'h', empty: false, capturedAt: 0 }),
    acquireTargetLease: (target) => { events.push(`acquire:${target.id}`); return manager.reserve(target) },
    releaseUntouchedTarget: () => {},
    markTargetTouched: (id) => { events.push(`touched:${id}`) },
    commit: () => { events.push('commit') },
    retireOld: async () => { events.push('dispose') },
    pinTarget: (id, reason) => { manager.pin(id, reason) },
    recordFailure: () => {},
  }
  const outcome = await runTransitionTo(host, {
    target: { id: 'session-b' },
    create: async () => { events.push('create'); return handle('session-b') },
  })
  assert.equal(outcome.ok, true)
  assert.equal(manager.canReuseLocally('session-a'), true, 'the OLD lease is still held after the whole transition')
  assert.equal(manager.canReuseLocally('session-b'), true)
  assert.deepEqual(released, [], 'NOTHING was released inside the transition')
  assert.deepEqual(events, ['acquire:session-b', 'touched:session-b', 'create', 'commit', 'dispose'])
})

test('a failed old-handle dispose pins and NEVER starts cooling (the production gate pattern)', async () => {
  // The production retireOld runs: dispose → on failure PIN (never
  // beginCooling) → the detach/cooling handover is skipped entirely.
  const released: string[] = []
  const manager = new ProcessSessionLeaseManager({
    acquire: (target) => ({ result: { kind: 'acquired' }, release: () => { released.push(target.id) } }),
  })
  manager.reserve({ id: 'session-a' })
  manager.markTouched('session-a')
  manager.markActive('session-a')
  const host: TransitionHost<Handle> = {
    quiesceOld: async () => ({ sessionId: 'session-a', eventCount: 1, tailFingerprint: 'h', empty: false, capturedAt: 0 }),
    acquireTargetLease: (target) => manager.reserve(target),
    releaseUntouchedTarget: () => {},
    markTargetTouched: (id) => { manager.markTouched(id) },
    commit: () => {},
    retireOld: async () => {
      // The production pattern: dispose FAILED → pin, and the cooling
      // handover below it is gated on disposeSucceeded (round 37).
      manager.pin('session-a', 'old handle dispose failed')
    },
    pinTarget: (id, reason) => { manager.pin(id, reason) },
    recordFailure: () => {},
  }
  const outcome = await runTransitionTo(host, {
    target: { id: 'session-b' },
    create: async () => handle('session-b'),
  })
  assert.equal(outcome.ok, true, 'the committed child stands')
  assert.equal(manager.state('session-a')?.state, 'pinned', 'a failed dispose never enters cooling')
  assert.equal(manager.state('session-a')?.physicalLockHeld, true, 'the old lock stays')
  assert.deepEqual(released, [], 'nothing was released')
})
