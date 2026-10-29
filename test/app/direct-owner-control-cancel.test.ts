/**
 * The Direct one-shot control cancel (Busy Esc / extension `cancel-activity`):
 * the request must address the EXACT captured Direct Agent (never a
 * same-session-id re-resolution), preserve the Host pending inbox
 * (`keepInbox: true`), and report the shared typed settlement. The exit
 * `preCancel` and the retirement cancel are separate operations and must not
 * be used as substitutes.
 * @module @xmoon76/dsh-pi-tui/direct-owner-control-cancel.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createDirectOwnerRegistry } from '../../src/app/direct/owner-registry.ts'
import { createDirectOwnerRetirement } from '../../src/app/direct/owner-retirement.ts'
import type { SessionOwnerRef } from '../../src/app/session/subject.ts'
import type { Diag } from '../../src/runtime/process/diagnostics.ts'
import type { SessionHandle } from '../../src/runtime/session-lifecycle-port.ts'

const fakeDiag: Diag = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {},
}

interface CancelCall {
  readonly cause: unknown
  readonly options: unknown
}

interface FakeAgent {
  readonly id: string
  readonly session: { readonly id: string }
  readonly status: string
  readonly calls: CancelCall[]
  cancel(cause: unknown, options?: unknown): void
}

function fakeAgent(sessionId: string, agentId: string): FakeAgent {
  const calls: CancelCall[] = []
  return {
    id: agentId,
    session: { id: sessionId },
    status: 'running',
    calls,
    cancel: (cause: unknown, options?: unknown): void => { calls.push({ cause, options }) },
  }
}

function fakeHandle(agent: FakeAgent, sessionId: string): SessionHandle {
  return {
    session: { id: sessionId },
    direct: { agent, ownerHandle: { dispose: () => {} } },
  } as unknown as SessionHandle
}

function harness() {
  const registry = createDirectOwnerRegistry(() => undefined)
  let aborted = false
  const retirement = createDirectOwnerRetirement({
    owners: registry,
    diag: fakeDiag,
    isLifecycleAborted: () => aborted,
    drainContinuableDescendants: async () => {},
    flushSession: async () => {},
    parkHandle: () => {},
    takeAllParkedOwners: () => [],
  })
  const ownerOf = (agent: FakeAgent, sessionId: string): SessionOwnerRef => {
    const owner = registry.fromHandle(fakeHandle(agent, sessionId))
    assert.ok(owner !== undefined, 'a Direct handle must map to an owner')
    return owner
  }
  return {
    ownerOf,
    retirement,
    setAborted: (next: boolean): void => { aborted = next },
  }
}

test('the control cancel addresses the exact Direct Agent with keepInbox', async () => {
  const h = harness()
  const agent = fakeAgent('session-a', 'agent-a')
  const owner = h.ownerOf(agent, 'session-a')
  assert.deepEqual(await h.retirement.cancel(owner), { kind: 'committed', value: undefined })
  assert.equal(agent.calls.length, 1, 'the live Agent cancel runs exactly once')
  assert.deepEqual(agent.calls[0], { cause: { kind: 'user' }, options: { keepInbox: true } },
    'the Busy Esc semantic preserves the Host pending queue')
})

test('two Agents sharing one session id are addressed by their own exact owner', async () => {
  const h = harness()
  const agentA = fakeAgent('session-a', 'agent-a')
  const agentB = fakeAgent('session-a', 'agent-b')
  const ownerA = h.ownerOf(agentA, 'session-a')
  const ownerB = h.ownerOf(agentB, 'session-a')
  assert.notEqual(ownerA, ownerB, 'owner identity is the exact Agent object, not the id')
  await h.retirement.cancel(ownerA)
  await h.retirement.cancel(ownerB)
  assert.equal(agentA.calls.length, 1)
  assert.equal(agentB.calls.length, 1)
})

test('an aborted runner settles the control cancel as cancelled without a second Agent cancel', async () => {
  const h = harness()
  const agent = fakeAgent('session-a', 'agent-a')
  const owner = h.ownerOf(agent, 'session-a')
  h.setAborted(true)
  assert.deepEqual(await h.retirement.cancel(owner), { kind: 'cancelled' },
    'the shutdown exactly-once path already owns this Agent')
  assert.equal(agent.calls.length, 0, 'no late cancel may land after the exit teardown')
})

test('an owner with no Direct attachment is a proven pre-dispatch rejection', async () => {
  const h = harness()
  const stray = {} as SessionOwnerRef
  const outcome = await h.retirement.cancel(stray)
  assert.equal(outcome.kind, 'rejected')
  assert.equal(outcome.kind === 'rejected' ? outcome.error.code : undefined, 'session/owner-unattached')
})

test('a throwing Agent cancel is indeterminate, never a false committed or rejected', async () => {
  const h = harness()
  const agent = fakeAgent('session-a', 'agent-a')
  agent.cancel = (): void => { throw new Error('cancel exploded midway') }
  const owner = h.ownerOf(agent, 'session-a')
  const outcome = await h.retirement.cancel(owner)
  assert.equal(outcome.kind, 'indeterminate')
  assert.equal(outcome.kind === 'indeterminate' ? outcome.error.code : undefined, 'session/cancel-indeterminate')
})
