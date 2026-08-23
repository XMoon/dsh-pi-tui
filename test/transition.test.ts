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
import { runTransitionTo, type TransitionHost, type TransitionSteps } from '../src/transition.ts'

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
    handoverLocks: () => {
      events.push('old.lock.release')
      events.push('child.lock.acquire')
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
    'old.whenIdle',        // 1. the old agent quiesces FIRST (no abort closures later)
    'old.flush',           // 2. final flush, old lock still held
    'prepare',             // 3. caller gates
    'child.create',        // 4. create — published from here on
    'old.lock.release',    // 5. old lock released only AFTER old is idle+flushed
    'child.lock.acquire',
    'child.commit',        // 6. synchronous commit
    'old.dispose',         // 7. dispose of the now-idle old agent
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
    'old.whenIdle', 'old.flush', 'prepare', 'child.create',
    'old.lock.release', 'child.lock.acquire', 'child.commit', 'old.dispose',
  ])
})

test('a quiesce/flush failure aborts with zero child side effects', async () => {
  const { host, events, failures } = fakeHost({ quiesceError: 'flush disk full' })
  const outcome = await runTransitionTo(host, steps(events))
  assert.deepEqual(outcome, { ok: false, message: 'transition failed: flush disk full' })
  assert.deepEqual(events, ['old.whenIdle', 'old.flush'], 'nothing was created, locked or committed')
  assert.deepEqual(failures, ['quiesce:flush disk full'])
})

test('a prepare failure aborts before anything is published', async () => {
  const { host, events, failures } = fakeHost()
  const outcome = await runTransitionTo(host, steps(events, { prepareError: 'lock refused' }))
  assert.equal(outcome.ok, false)
  assert.deepEqual(events, ['old.whenIdle', 'old.flush', 'prepare'],
    'the create and the lock handover must not run')
  assert.deepEqual(failures, ['prepare:lock refused'])
})

test('a create failure aborts without releasing the old lock or committing', async () => {
  const { host, events, failures } = fakeHost()
  const outcome = await runTransitionTo(host, steps(events, { createError: 'roster unavailable' }))
  assert.equal(outcome.ok, false)
  assert.deepEqual(events, ['old.whenIdle', 'old.flush', 'prepare', 'child.create'],
    'the old lock stays held and nothing is committed')
  assert.deepEqual(failures, ['create:roster unavailable'])
})

test('a retire failure NEVER rolls the committed child back', async () => {
  const { host, events, failures } = fakeHost({ retireError: 'old dispose exploded' })
  const outcome = await runTransitionTo(host, steps(events))
  assert.equal(outcome.ok, true, 'the child is committed and stands despite the retire failure')
  if (outcome.ok) assert.equal(outcome.next.agent.session.id, 'session-c')
  assert.deepEqual(events, [
    'old.whenIdle', 'old.flush', 'prepare', 'child.create',
    'old.lock.release', 'child.lock.acquire', 'child.commit', 'old.dispose',
  ])
  assert.deepEqual(failures, ['retire:old dispose exploded'])
})
