/**
 * Tests for the session-transition orchestration (src/transition.ts): the
 * ONE canonical phase order every live-session writer must follow, and its
 * failure semantics. The runner's `transitionTo` is a thin host adapter
 * over `runTransitionTo` — this suite fixes the order itself (review
 * round-3 finding: the old lock must not be released before the old agent
 * has quiesced and been finally flushed).
 * @module @xmoon76/dsh-pi-tui/transition.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DurablePublishedUnrecoverableError, runTransitionTo, type TransitionHost, type TransitionSteps } from '../src/transition.ts'

/** The handle shape the host drives (structurally the AgentHandle). */
interface Handle {
  agent: { session: { id: string; header?: { cwd?: string } } }
}

function handle(id: string): Handle {
  return { agent: { session: { id, header: { cwd: '/ws' } } } }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

interface FakeHostOptions {
  /** whenIdle of the old agent hangs until released (the agent is RUNNING). */
  quiesceHang?: Promise<void>
  quiesceError?: string
  /** The target lock is refused (another process holds it). */
  targetLockRefused?: string
  /** The target lock is unavailable (deployment cannot lock). */
  targetLockUnavailable?: boolean
  /** Whether the child is durable-published when create rejects. */
  durablePublished?: boolean
  prepareError?: string
  createError?: string
  retireError?: string
}

function fakeHost(options: FakeHostOptions = {}): {
  host: TransitionHost<Handle>
  events: string[]
  failures: string[]
} {
  const events: string[] = []
  const failures: string[] = []
  const hang = options.quiesceHang
  const host: TransitionHost<Handle> = {
    quiesceOld: async () => {
      events.push('old.whenIdle')
      if (hang !== undefined) await hang
      events.push('old.flush')
      if (options.quiesceError !== undefined) throw new Error(options.quiesceError)
    },
    acquireTargetLock: (target) => {
      events.push(`target.lock.acquire:${target.id}`)
      if (options.targetLockRefused !== undefined) return { kind: 'refused', message: options.targetLockRefused }
      if (options.targetLockUnavailable === true) return { kind: 'unavailable', reason: 'no-lock-dir' }
      return { kind: 'acquired' }
    },
    releaseLock: (sessionId) => { events.push(`target.lock.release:${sessionId}`) },
    isDurablePublished: async () => options.durablePublished === true,
    handoverLocks: () => {
      // The child lock was pre-acquired in phase 2; the COMMIT only
      // releases the old lock (review round 12: no redundant re-acquire).
      events.push('old.lock.release')
    },
    commit: () => { events.push('child.commit') },
    retire: async () => {
      events.push('old.dispose')
      if (options.retireError !== undefined) throw new Error(options.retireError)
    },
    recordFailure: (phase, error) => {
      failures.push(`${phase}:${error instanceof Error ? error.message : String(error)}`)
    },
  }
  return { host, events, failures }
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

test('the canonical order is quiesce → flush → prepare → create → lock handover → commit → dispose', async () => {
  const { host, events } = fakeHost()
  const outcome = await runTransitionTo(host, steps(events))
  assert.equal(outcome.ok, true)
  assert.deepEqual(events, [
    'old.whenIdle',            // 1. the old agent quiesces FIRST (no abort closures later)
    'old.flush',               // 2. final flush, old lock still held
    'target.lock.acquire:session-c', // 3. the TARGET lock BEFORE the create (review round 6)
    'prepare',                 // 4. caller gates
    'child.create',            // 5. create — published from here on
    'old.lock.release',        // 6. old lock released only AFTER old is idle+flushed
    'child.commit',            // 7. synchronous commit
    'old.dispose',             // 8. dispose of the now-idle old agent
  ])
})

test('review: a RUNNING old agent blocks the transition — no create, no lock release until idle', async () => {
  const release = deferred<void>()
  const { host, events } = fakeHost({ quiesceHang: release.promise })
  const pending = runTransitionTo(host, steps(events))
  await settle()
  await settle()
  // The old agent is still streaming: nothing may be created or released.
  assert.deepEqual(events, ['old.whenIdle'],
    'create/release/commit must all wait for the old agent to quiesce')
  // The old activity settles: the transition proceeds in the canonical order.
  release.resolve()
  const outcome = await pending
  assert.equal(outcome.ok, true)
  assert.deepEqual(events, [
    'old.whenIdle', 'old.flush', 'target.lock.acquire:session-c', 'prepare', 'child.create',
    'old.lock.release', 'child.commit', 'old.dispose',
  ])
})

test('a quiesce/flush failure aborts with zero child side effects', async () => {
  const { host, events, failures } = fakeHost({ quiesceError: 'flush disk full' })
  const outcome = await runTransitionTo(host, steps(events))
  assert.deepEqual(outcome, { ok: false, message: 'transition failed: flush disk full' })
  assert.deepEqual(events, ['old.whenIdle', 'old.flush'], 'nothing was created, locked or committed')
  assert.deepEqual(failures, ['quiesce:flush disk full'])
})

test('a prepare failure aborts before anything is published and releases the target lock', async () => {
  const { host, events, failures } = fakeHost()
  const outcome = await runTransitionTo(host, steps(events, { prepareError: 'lock refused' }))
  assert.equal(outcome.ok, false)
  assert.deepEqual(events, [
    'old.whenIdle', 'old.flush', 'target.lock.acquire:session-c', 'prepare',
    'target.lock.release:session-c',
  ], 'the create and the lock handover must not run; the target lock is released')
  assert.deepEqual(failures, ['prepare:lock refused'])
})

test('a create failure aborts, releases the target lock and never touches the old lock', async () => {
  const { host, events, failures } = fakeHost()
  const outcome = await runTransitionTo(host, steps(events, { createError: 'roster unavailable' }))
  assert.equal(outcome.ok, false)
  assert.deepEqual(events, [
    'old.whenIdle', 'old.flush', 'target.lock.acquire:session-c', 'prepare', 'child.create',
    'target.lock.release:session-c',
  ], 'the old lock stays held, the target lock is released, nothing is committed')
  assert.deepEqual(failures, ['create:roster unavailable'])
})

test('review round 6: a REFUSED target lock aborts BEFORE the create (zero child side effects)', async () => {
  const { host, events, failures } = fakeHost({ targetLockRefused: 'held by another process' })
  const outcome = await runTransitionTo(host, steps(events))
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /held by another process/)
  assert.deepEqual(events, ['old.whenIdle', 'old.flush', 'target.lock.acquire:session-c'],
    'the child must never be created when its lock is refused')
  assert.deepEqual(failures, ['target-lock:held by another process'])
})

test('a retire failure NEVER rolls the committed child back', async () => {
  const { host, events, failures } = fakeHost({ retireError: 'old dispose exploded' })
  const outcome = await runTransitionTo(host, steps(events))
  assert.equal(outcome.ok, true, 'the child is committed and stands despite the retire failure')
  if (outcome.ok) assert.equal(outcome.next.agent.session.id, 'session-c')
  assert.deepEqual(events, [
    'old.whenIdle', 'old.flush', 'target.lock.acquire:session-c', 'prepare', 'child.create',
    'old.lock.release', 'child.commit', 'old.dispose',
  ])
  assert.deepEqual(failures, ['retire:old dispose exploded'])
})

test('review round 7: a FRESH target with an UNAVAILABLE lock aborts BEFORE the create', async () => {
  const { host, events, failures } = fakeHost({ targetLockUnavailable: true })
  const outcome = await runTransitionTo(host, { ...steps(events), fresh: true })
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /cannot lock the fresh session/)
  assert.deepEqual(events, ['old.whenIdle', 'old.flush', 'target.lock.acquire:session-c'],
    'the child must never be created without its lock')
  assert.deepEqual(failures, ['target-lock:cannot lock the fresh session before creating it (no-lock-dir)'])
})

test('an EXISTING target with an unavailable lock may proceed (guard backstop)', async () => {
  const { host, events } = fakeHost({ targetLockUnavailable: true })
  const outcome = await runTransitionTo(host, { ...steps(events), fresh: false })
  assert.equal(outcome.ok, true, 'an existing target tolerates an unavailable lock')
  assert.deepEqual(events, [
    'old.whenIdle', 'old.flush', 'target.lock.acquire:session-c', 'prepare', 'child.create',
    'old.lock.release', 'child.commit', 'old.dispose',
  ])
})

// ── review round 8: a rejected create may still have published durably ─────

test('a create rejection BEFORE publication releases the target lock and aborts', async () => {
  const { host, events, failures } = fakeHost()
  const outcome = await runTransitionTo(host, steps(events, { createError: 'pre-publication' }))
  assert.equal(outcome.ok, false)
  assert.deepEqual(events, [
    'old.whenIdle', 'old.flush', 'target.lock.acquire:session-c', 'prepare', 'child.create',
    'target.lock.release:session-c',
  ], 'a genuine pre-publication failure releases the lock and leaves the old session untouched')
  assert.deepEqual(failures, ['create:pre-publication'])
})

test('a rejected create AFTER durable publication is RECOVERED and committed (never a ghost)', async () => {
  const { host, events, failures } = fakeHost({ durablePublished: true })
  const recovered = steps(events, { createError: 'post-publication listener threw' })
  recovered.recover = async () => { events.push('child.recover'); return handle('session-c') }
  const outcome = await runTransitionTo(host, recovered)
  assert.equal(outcome.ok, true, 'the recovered child commits as the transition result')
  if (outcome.ok) assert.equal(outcome.next.agent.session.id, 'session-c')
  assert.deepEqual(events, [
    'old.whenIdle', 'old.flush', 'target.lock.acquire:session-c', 'prepare', 'child.create',
    'child.recover', 'old.lock.release', 'child.commit', 'old.dispose',
  ], 'the target lock is NEVER released — the recovered child is committed, the old lock is released at COMMIT')
  assert.deepEqual(failures, [], 'a successful recovery is not a failure')
})

test('a durable-published child that CANNOT be recovered keeps its lock and reports the explicit state', async () => {
  const { host, events, failures } = fakeHost({ durablePublished: true })
  const failing = steps(events, { createError: 'post-publication listener threw' })
  failing.recover = async () => { events.push('child.recover'); throw new Error('resume repair failed') }
  const outcome = await runTransitionTo(host, failing)
  assert.equal(outcome.ok, false)
  assert.match(outcome.ok === false ? outcome.message : '', /durable-published but could not be recovered/)
  assert.match(outcome.ok === false ? outcome.message : '', /stays locked/)
  assert.deepEqual(events, [
    'old.whenIdle', 'old.flush', 'target.lock.acquire:session-c', 'prepare', 'child.create',
    'child.recover',
  ], 'the target lock is NEVER released — the published child must not silently become an openable ghost')
  assert.deepEqual(failures, ['create:post-publication listener threw; the child was durable-published but could not be recovered (resume repair failed)'])
})

test('review round 17: the unrecoverable-published error is a distinct class, never a fallback trigger', () => {
  const error = new DurablePublishedUnrecoverableError('session-c', 'resume repair failed')
  assert.equal(error.name, 'DurablePublishedUnrecoverableError')
  assert.match(error.message, /durable-published but could not be recovered/)
  assert.match(error.message, /stays locked/)
  // ensureSession's preset fallback must NOT run for this class — it
  // rethrows it (the child exists and stays locked; a second fresh session
  // would be a lie about the surface state).
  assert.ok(!(new Error('preset mount failed') instanceof DurablePublishedUnrecoverableError))
})
