/**
 * Headless tests for the canonical session transition (the convergence
 * plan flow): quiesce → preflight → target lease → DSH boundary (touched)
 * → create / at most one same-id recovery → synchronous COMMIT (no lock
 * changes) → retire (dispose + cooling handover).
 * @module @xmoon76/dsh-pi-tui/transition.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createWithPublicationRecovery,
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

test('a create rejection WITHOUT recovery PINNS the target (lock kept, old stays current)', async () => {
  const { host, events, failures, pins } = fakeHost()
  const outcome = await runTransitionTo(host, steps(events, { createError: 'DSH publication failed' }))
  assert.equal(outcome.ok, false)
  assert.deepEqual(events, [
    'old.flush', 'prepare', 'target.lock.acquire:session-c', 'target.touched:session-c', 'child.create',
    'target.pinned:session-c',
  ], 'no second fresh create, no unlock — the target is pinned')
  assert.equal(pins.length, 1)
  assert.match(pins[0]!, /DSH create\/resume failed: DSH publication failed/)
  assert.deepEqual(failures, ['create:DSH publication failed'])
})

test('a rejected create RECOVERS with the same id and commits', async () => {
  const { host, events, failures, pins } = fakeHost()
  const recovered = steps(events, { createError: 'post-publication listener threw' })
  recovered.recover = async () => { events.push('recover'); return handle('session-c') }
  const outcome = await runTransitionTo(host, recovered)
  assert.equal(outcome.ok, true)
  assert.deepEqual(events, [
    'old.flush', 'prepare', 'target.lock.acquire:session-c', 'target.touched:session-c',
    'child.create', 'recover', 'child.commit', 'old.dispose',
  ])
  assert.deepEqual(pins, [], 'a successful same-id recovery is not a pin')
  assert.deepEqual(failures, [])
})

test('a create rejection whose SAME-ID recovery also fails PINNS the target', async () => {
  const { host, events, pins } = fakeHost()
  const failing = steps(events, { createError: 'post-publication listener threw' })
  failing.recover = async () => { events.push('recover'); throw new Error('resume repair failed') }
  const outcome = await runTransitionTo(host, failing)
  assert.equal(outcome.ok, false)
  assert.deepEqual(events, [
    'old.flush', 'prepare', 'target.lock.acquire:session-c', 'target.touched:session-c',
    'child.create', 'recover', 'target.pinned:session-c',
  ], 'at most ONE same-id recovery; failure pins the target')
  assert.match(pins[0]!, /same-ID recovery: resume repair failed/)
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
    acquire: (target) => { acquired.push(target.id); return { result: { kind: 'acquired' } } },
    release: (id) => { released.push(id) },
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

// ── the standalone helper: same-ID recovery, never a release ───────────────

test('the standalone helper retries the SAME id once and throws (the caller pins)', async () => {
  let creates = 0
  let resumes = 0
  await assert.rejects(
    createWithPublicationRecovery({
      targetId: 'session-c',
      create: async () => { creates += 1; throw new Error('post-publication listener threw') },
      resume: async () => { resumes += 1; throw new Error('resume repair failed') },
    }),
    /stays pinned/,
  )
  assert.equal(creates, 1, 'exactly one create attempt — no second fresh fallback')
  assert.equal(resumes, 1, 'exactly one same-id recovery')
})

test('the helper: a successful same-id recovery returns the recovered handle', async () => {
  const recovered = await createWithPublicationRecovery({
    targetId: 'session-c',
    create: async () => { throw new Error('publication failed') },
    resume: async () => handle('session-c'),
  })
  assert.equal(recovered.agent.session.id, 'session-c')
})
