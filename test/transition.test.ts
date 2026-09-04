/**
 * Headless tests for the canonical session transition: quiesce → preflight
 * → create (a rejection is NEVER retried — the old session stays current)
 * → synchronous COMMIT → retire (dispose + best-effort child surface
 * work). The DSH SessionWriteLease (kernel flock) is the only
 * cross-process writer authority, so the transaction performs no TUI-side
 * lock bookkeeping (the physical owner.lock / lease / cooling stack is
 * removed legacy).
 * @module @xmoon76/dsh-pi-tui/transition.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runTransitionTo,
  type TransitionHost,
  type TransitionSteps,
} from '../src/transition.ts'

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
}

function fakeHost(options: FakeHostOptions = {}): {
  host: TransitionHost<Handle>
  events: string[]
  failures: string[]
} {
  const events: string[] = []
  const failures: string[] = []
  const host: TransitionHost<Handle> = {
    quiesceOld: async () => {
      events.push('old.flush')
      if (options.quiesceError !== undefined) throw new Error(options.quiesceError)
    },
    commit: () => { events.push('child.commit') },
    retireOld: async () => {
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

test('the canonical order is flush → prepare → create → commit → dispose', async () => {
  const { host, events } = fakeHost()
  const outcome = await runTransitionTo(host, steps(events))
  assert.equal(outcome.ok, true)
  assert.deepEqual(events, [
    'old.flush',        // 1. old quiesce + final flush
    'prepare',          // 2. ALL preflight BEFORE the DSH boundary
    'child.create',     // 3. create — published from here on
    'child.commit',     // 4. synchronous COMMIT
    'old.dispose',      // 5. old handle disposed
  ])
})

test('a quiesce/flush failure aborts with zero child side effects', async () => {
  const { host, events, failures } = fakeHost({ quiesceError: 'flush disk full' })
  const outcome = await runTransitionTo(host, steps(events))
  assert.deepEqual(outcome, { ok: false, message: 'transition failed: flush disk full' })
  assert.deepEqual(events, ['old.flush'], 'nothing was prepared or created')
  assert.deepEqual(failures, ['quiesce:flush disk full'])
})

test('a PREFLIGHT failure aborts BEFORE the create', async () => {
  const { host, events, failures } = fakeHost()
  const outcome = await runTransitionTo(host, steps(events, { prepareError: 'roster unavailable' }))
  assert.equal(outcome.ok, false)
  assert.deepEqual(events, ['old.flush', 'prepare'],
    'the create never runs — zero side effects')
  assert.deepEqual(failures, ['prepare:roster unavailable'])
})

test('a create rejection leaves the old session current — no pin, no retry', async () => {
  const { host, events, failures } = fakeHost()
  const outcome = await runTransitionTo(host, steps(events, { createError: 'DSH publication failed' }))
  assert.equal(outcome.ok, false)
  assert.deepEqual(events, [
    'old.flush', 'prepare', 'child.create',
  ], 'no same-id recovery, no second fresh create — the old session stays current')
  assert.deepEqual(outcome, { ok: false, message: 'transition failed: DSH publication failed' })
  assert.deepEqual(failures, ['create:DSH publication failed'])
})

test('a retire failure NEVER rolls the committed child back', async () => {
  const { host, events, failures } = fakeHost({ retireError: 'old dispose exploded' })
  const outcome = await runTransitionTo(host, steps(events))
  assert.equal(outcome.ok, true, 'the child is committed and stands despite the retire failure')
  if (outcome.ok) assert.equal(outcome.next.agent.session.id, 'session-c')
  assert.deepEqual(events, [
    'old.flush', 'prepare', 'child.create', 'child.commit', 'old.dispose',
  ])
  assert.deepEqual(failures, ['retire:old dispose exploded'])
})
