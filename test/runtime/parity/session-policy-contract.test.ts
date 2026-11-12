/**
 * PARITY: the Direct and Remote `SessionPolicyPort` implementations serve
 * the SAME semantic contract — the same detached DTO vocabulary, the same
 * per-side independence, the same refusal/unconfirmed classification and
 * the no-retry rule. The transports differ; the consumer sees one contract.
 *
 * @module @xmoon76/dsh-pi-tui/session-policy-contract.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSessionPolicyPort } from '../../../src/runtime/direct/session-policy-direct.ts'
import { RemoteSessionPolicyPort } from '../../../src/runtime/remote/session-policy-remote.ts'
import { RemoteConfigWriteLifetime } from '../../../src/runtime/remote/config-write-lifetime.ts'
import type { SessionPolicyPort, SessionPolicyRead } from '../../../src/runtime/session-policy-port.ts'
import type { PiTuiSessionPolicyNamespace, PiTuiSessionPolicySetApprovalCall } from '../../../src/runtime/remote/pi-tui-session-policy-contract.ts'

const SESSION = 'session-a'
const LIVE_SESSION = { id: SESSION }
const LIVE_AGENT = { session: LIVE_SESSION }

/** The Direct port over structural official faces (the same shape its real
 *  assembly hands it). */
function directPort(options: { setThrows?: boolean } = {}): SessionPolicyPort {
  return new DirectSessionPolicyPort(
    {
      get: (name: string) => name === 'approval'
        ? {
          overrideOf: () => 'never' as const,
          setPolicy: () => { if (options.setThrows === true) throw new Error('setter boom') },
          config: { policy: 'ask' as const },
        }
        : name === 'sandboxPolicy'
          ? { overrideOf: () => 'read-only' as const, resolve: () => ({ mode: 'read-only' as const }) }
          : undefined,
    } as never,
    id => (id === SESSION ? LIVE_AGENT : undefined),
  )
}

function remotePort(options: { setError?: { code: string; message: string } } = {}): SessionPolicyPort {
  // A STABLE generation object: the fence compares identity, so a per-call
  // fresh object would (correctly) read as a replaced connection.
  const generation = { getSnapshot: () => stableGeneration }
  const stableGeneration = { boot: 'f8-parity' }
  const namespace: PiTuiSessionPolicyNamespace = {
    read: async sessionId => ({
      ok: true,
      value: sessionId === SESSION
        ? {
          kind: 'ready',
          sessionId,
          approval: { state: 'ready', effective: 'never', override: 'never' },
          sandbox: { state: 'ready', effective: 'read-only', override: 'read-only' },
        }
        : { kind: 'unavailable', sessionId, reason: 'session-not-live' },
    }),
    setApproval: async (sessionId): Promise<PiTuiSessionPolicySetApprovalCall> => (options.setError !== undefined
      ? { ok: false as const, error: options.setError as never }
      : { ok: true as const, value: { kind: 'applied' as const, sessionId } }),
  }
  return new RemoteSessionPolicyPort(namespace, generation as never, new RemoteConfigWriteLifetime())
}

test('PARITY: both ports return the same detached DTO shape for a ready read', async () => {
  for (const [label, port] of [['direct', directPort()], ['remote', remotePort()]] as const) {
    const read = await port.read(SESSION)
    assert.equal(read.kind, 'ready', label)
    assert.ok(read.kind === 'ready')
    assert.equal(read.sessionId, SESSION, label)
    assert.equal(read.approval.state, 'ready', label)
    assert.equal(read.approval.effective, 'never', label)
    assert.equal(read.sandbox.state, 'ready', label)
    assert.equal(read.sandbox.effective, 'read-only', label)
    // The frame vocabulary is identical: no Host object ever rides it.
    assert.equal(Object.values(read as object).some(value => typeof value === 'object' && value !== null && 'session' in (value as object)), false, label)
  }
})

test('PARITY: both ports report a missing session with the same unavailable DTO', async () => {
  for (const [label, port] of [['direct', directPort()], ['remote', remotePort()]] as const) {
    const read: SessionPolicyRead = await port.read('f8-ghost')
    assert.deepEqual(read, { kind: 'unavailable', sessionId: 'f8-ghost', reason: 'session-not-live' }, label)
  }
})

test('PARITY: both ports apply the same exact-session approval write outcome', async () => {
  for (const [label, port] of [['direct', directPort()], ['remote', remotePort()]] as const) {
    assert.deepEqual(await port.setApproval(SESSION, 'never'), { kind: 'applied', sessionId: SESSION }, label)
  }
})

test('PARITY: a proven pre-invocation refusal and a post-dispatch unknown are DIFFERENT kinds on both ports', async () => {
  // Direct: a missing service is a definite refusal; a setter throw after
  // admission is unconfirmed.
  const refused = new DirectSessionPolicyPort(
    { get: () => undefined } as never,
    () => LIVE_AGENT,
  )
  assert.equal((await refused.setApproval(SESSION, 'never')).kind, 'refused')
  assert.equal((await directPort({ setThrows: true }).setApproval(SESSION, 'never')).kind, 'unconfirmed')
  // Remote: the gateway's pre-invocation refusal is refused; any other
  // failure is unconfirmed.
  assert.equal((await remotePort({ setError: { code: 'gateway/bad-request', message: 'arg' } }).setApproval(SESSION, 'never')).kind, 'refused')
  assert.equal((await remotePort({ setError: { code: 'gateway/internal', message: 'boom' } }).setApproval(SESSION, 'never')).kind, 'unconfirmed')
})
