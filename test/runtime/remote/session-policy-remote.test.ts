/**
 * UNIT: the Remote `SessionPolicyPort` classification — generation fences,
 * the single dispatch, the reload-gate write lifetime, the definite
 * pre-invocation refusal vs the lost-ACK `unconfirmed`, and the no-retry
 * rule. Structural namespace stubs; the REAL Gateway/Client proof is the
 * L5 wire suite.
 *
 * @module @xmoon76/dsh-pi-tui/session-policy-remote.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { RemoteSessionPolicyPort } from '../../../src/runtime/remote/session-policy-remote.ts'
import { RemoteConfigWriteLifetime } from '../../../src/runtime/remote/config-write-lifetime.ts'
import { SupersededReadError } from '../../../src/runtime/read-error.ts'
import type { PiTuiSessionPolicyNamespace, PiTuiSessionPolicyReadCall, PiTuiSessionPolicySetApprovalCall } from '../../../src/runtime/remote/pi-tui-session-policy-contract.ts'
import type { SessionPolicyRead } from '../../../src/runtime/session-policy-port.ts'

interface GenerationSource {
  getSnapshot(): object | undefined
}

function generationFixture(): GenerationSource & { replace(next?: object): void } {
  let current: object | undefined = {}
  return {
    getSnapshot: () => current,
    replace: (next) => { current = next },
  }
}

type Call = { readonly sessionId: string; readonly policy?: 'ask' | 'never' }

function namespaceFixture(options: {
  readResult?: SessionPolicyRead
  readError?: { readonly code: string; readonly message: string }
  setError?: { readonly code: string; readonly message: string }
  calls?: Call[]
} = {}): PiTuiSessionPolicyNamespace {
  return {
    read: async (sessionId): Promise<PiTuiSessionPolicyReadCall> => {
      ;(options.calls ??= []).push({ sessionId })
      if (options.readError !== undefined) return { ok: false, error: options.readError as never }
      return { ok: true, value: options.readResult ?? { kind: 'unavailable', sessionId, reason: 'session-not-live' } }
    },
    setApproval: async (sessionId, policy): Promise<PiTuiSessionPolicySetApprovalCall> => {
      ;(options.calls ??= []).push({ sessionId, policy })
      if (options.setError !== undefined) return { ok: false, error: options.setError as never }
      return { ok: true, value: { kind: 'applied', sessionId } }
    },
  }
}

const READY: SessionPolicyRead = {
  kind: 'ready',
  sessionId: 'session-a',
  approval: { state: 'ready', effective: 'never', override: 'never' },
  sandbox: { state: 'ready', effective: 'read-only' },
}

test('read: success is generation-fenced — a replaced generation result is superseded', async () => {
  const generation = generationFixture()
  const calls: Call[] = []
  const port = new RemoteSessionPolicyPort(
    namespaceFixture({ readResult: READY, calls }),
    generation as never,
    new RemoteConfigWriteLifetime(),
  )
  let gate = false
  const original = generation.getSnapshot
  generation.getSnapshot = () => (gate ? undefined : original())
  const promise = port.read('session-a')
  generation.getSnapshot = () => ({ replaced: true })
  await assert.rejects(() => promise, SupersededReadError)
  assert.deepEqual(calls, [{ sessionId: 'session-a' }], 'exactly one wire read')
})

test('read: no current generation means the read was not performed; failures propagate', async () => {
  const generation = generationFixture()
  generation.replace(undefined)
  const port = new RemoteSessionPolicyPort(namespaceFixture({}), generation as never, new RemoteConfigWriteLifetime())
  await assert.rejects(() => port.read('session-a'), SupersededReadError)
  const failing = new RemoteSessionPolicyPort(
    namespaceFixture({ readError: { code: 'gateway/internal', message: 'boom' } }),
    generationFixture() as never,
    new RemoteConfigWriteLifetime(),
  )
  await assert.rejects(() => failing.read('session-a'), /piTuiSessionPolicy.read failed: boom/u)
})

test('setApproval: success returns the Host outcome and brackets the shared write lifetime exactly once', async () => {
  const generation = generationFixture()
  const calls: Call[] = []
  const lifetime = new RemoteConfigWriteLifetime()
  const port = new RemoteSessionPolicyPort(namespaceFixture({ calls }), generation as never, lifetime)
  assert.equal(lifetime.hasUnsettledWrites(), false, 'read-only construction registers nothing')
  const outcome = await port.setApproval('session-a', 'never')
  assert.deepEqual(outcome, { kind: 'applied', sessionId: 'session-a' })
  assert.deepEqual(calls, [{ sessionId: 'session-a', policy: 'never' }], 'ONE dispatch')
  assert.equal(lifetime.hasUnsettledWrites(), false, 'the accepted write released exactly once')
})

test('setApproval: a pre-invocation bad-request is refused; everything else is unconfirmed and never retried', async () => {
  const generation = generationFixture()
  const refused = new RemoteSessionPolicyPort(
    namespaceFixture({ setError: { code: 'gateway/bad-request', message: 'arg' } }),
    generation as never,
    new RemoteConfigWriteLifetime(),
  )
  assert.deepEqual(await refused.setApproval('session-a', 'ask'), { kind: 'refused', reason: 'invalid-request' })
  for (const code of ['gateway/internal', 'gateway/cancelled', 'gateway/result-invalid']) {
    const calls: Call[] = []
    const unconfirmed = new RemoteSessionPolicyPort(
      namespaceFixture({ setError: { code, message: code }, calls }),
      generationFixture() as never,
      new RemoteConfigWriteLifetime(),
    )
    assert.deepEqual(await unconfirmed.setApproval('session-a', 'ask'), { kind: 'unconfirmed', reason: code })
    assert.equal(calls.length, 1, `no retry after ${code}`)
  }
})

test('setApproval: a carrier throw after dispatch is unconfirmed (the commit state is unknown)', async () => {
  const generation = generationFixture()
  const namespace: PiTuiSessionPolicyNamespace = {
    read: async () => { throw new Error('never called') },
    setApproval: async () => { throw new Error('carrier lost') },
  }
  const port = new RemoteSessionPolicyPort(namespace, generation as never, new RemoteConfigWriteLifetime())
  assert.deepEqual(await port.setApproval('session-a', 'ask'), { kind: 'unconfirmed', reason: 'carrier lost' })
})

test('setApproval: no current generation or a missing namespace refuses before any dispatch', async () => {
  const generation = generationFixture()
  generation.replace(undefined)
  const calls: Call[] = []
  const port = new RemoteSessionPolicyPort(namespaceFixture({ calls }), generation as never, new RemoteConfigWriteLifetime())
  await assert.rejects(() => port.setApproval('session-a', 'ask'), SupersededReadError)
  const unmounted = new RemoteSessionPolicyPort(undefined, generationFixture() as never, new RemoteConfigWriteLifetime())
  await assert.rejects(() => unmounted.read('session-a'), /not mounted/u)
  assert.deepEqual(calls, [])
})

test('setApproval: a legitimate applied ACK stays applied even when the generation replaced afterwards', async () => {
  const generation = generationFixture()
  const original = generation.getSnapshot
  let dispatched = false
  generation.getSnapshot = () => (dispatched ? { replaced: true } : original())
  const namespace = namespaceFixture({})
  const port = new RemoteSessionPolicyPort(
    { ...namespace, setApproval: async (sessionId, policy) => {
      dispatched = true
      return namespace.setApproval(sessionId, policy)
    } },
    generation as never,
    new RemoteConfigWriteLifetime(),
  )
  // The Host settlement is the authority: the generation replacement only
  // ends the OLD surface's presentation ownership, never reclassifies it.
  assert.deepEqual(await port.setApproval('session-a', 'never'), { kind: 'applied', sessionId: 'session-a' })
})
