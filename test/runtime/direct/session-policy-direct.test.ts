/**
 * UNIT + L2: the Direct `SessionPolicyPort` over structural official service
 * faces — the outcome classification, the per-side independence, the
 * exact-identity refusals and the post-throw unconfirmed classification.
 *
 * The REAL-service proof (official approval/sandbox services through the
 * Gateway) lives in `pi-tui-session-policy-host.test.ts`; the real wire in
 * `pi-tui-session-policy-wire.test.ts`.
 *
 * @module @xmoon76/dsh-pi-tui/session-policy-direct.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSessionPolicyPort } from '../../../src/runtime/direct/session-policy-direct.ts'

function fixture(options: {
  approval?: { overrideOf?: (session: unknown) => 'ask' | 'never' | undefined; setPolicy?: (agent: unknown, policy: 'ask' | 'never') => void; configPolicy?: string } | null
  sandbox?: { overrideOf?: (session: unknown) => string | undefined; resolveMode?: string } | null
  sessionLive?: boolean
  agentLive?: boolean
} = {}): DirectSessionPolicyPort {
  const session = { id: 'session-a' }
  const agent = { session }
  return new DirectSessionPolicyPort(
    {
      get: (name: string) => {
        if (name === 'approval' && options.approval !== null) {
          return {
            overrideOf: options.approval?.overrideOf ?? (() => undefined),
            setPolicy: options.approval?.setPolicy,
            config: { policy: options.approval?.configPolicy },
          }
        }
        if (name === 'sandboxPolicy' && options.sandbox !== null) {
          return {
            overrideOf: options.sandbox?.overrideOf ?? (() => undefined),
            resolve: () => ({ mode: options.sandbox?.resolveMode ?? 'read-only' }),
          }
        }
        return undefined
      },
    } as never,
    () => (options.sessionLive === false || options.agentLive === false ? undefined : agent),
  )
}

test('read: both sides ready with independent override/effective facts', async () => {
  const port = fixture({
    approval: { overrideOf: () => 'never' },
    sandbox: { overrideOf: () => 'workspace-write', resolveMode: 'workspace-write' },
  })
  assert.deepEqual(await port.read('session-a'), {
    kind: 'ready',
    sessionId: 'session-a',
    approval: { state: 'ready', effective: 'never', override: 'never' },
    sandbox: { state: 'ready', effective: 'workspace-write', override: 'workspace-write' },
  })
})

test('read: no override falls back to the official config policy, then ask — and override stays absent', async () => {
  const configured = fixture({ approval: { configPolicy: 'never' } })
  const readConfigured = await configured.read('session-a')
  assert.ok(readConfigured.kind === 'ready' && readConfigured.approval.state === 'ready')
  assert.equal(readConfigured.approval.effective, 'never')
  assert.equal('override' in readConfigured.approval, false)
  const unconfigured = fixture({})
  const read = await unconfigured.read('session-a')
  assert.ok(read.kind === 'ready' && read.approval.state === 'ready')
  assert.equal(read.approval.effective, 'ask', 'the documented ask default applies when the config omits a policy')
  assert.equal('override' in read.approval, false)
})

test('read: a missing service is that side only; a ghost session is unavailable; a throwing read fails whole', async () => {
  const missingApproval = fixture({ approval: null, sandbox: { resolveMode: 'read-only' } })
  const read = await missingApproval.read('session-a')
  assert.ok(read.kind === 'ready')
  assert.deepEqual(read.approval, { state: 'unavailable', reason: 'service-not-installed' })
  assert.ok(read.sandbox.state === 'ready', 'the sandbox side keeps its own proven fact')
  const ghost = fixture({ sessionLive: false })
  assert.deepEqual(await ghost.read('session-a'), { kind: 'unavailable', sessionId: 'session-a', reason: 'session-not-live' })
  const throwing = fixture({ approval: { overrideOf: () => { throw new Error('boom') } } })
  await assert.rejects(() => throwing.read('session-a'), /boom/u, 'a throwing official read never degrades to "no override"')
})

test('read: an unknown configured approval default fails the read, never a ready effective', async () => {
  const port = fixture({ approval: { configPolicy: 'sometimes' } })
  await assert.rejects(() => port.read('session-a'), /unknown policy/u)
})

test('setApproval: exact identity refusals precede the single official call', async () => {
  const calls: Array<{ agent: unknown; policy: string }> = []
  const port = fixture({ approval: { setPolicy: (agent, policy) => { calls.push({ agent, policy }) } } })
  assert.deepEqual(await port.setApproval('session-a', 'never'), { kind: 'applied', sessionId: 'session-a' })
  assert.deepEqual(calls, [{ agent: { session: { id: 'session-a' } }, policy: 'never' }])
  const ghostSession = fixture({ sessionLive: false })
  assert.deepEqual(await ghostSession.setApproval('session-a', 'never'), { kind: 'refused', reason: 'session-not-live' })
  const noLiveAgent = fixture({ agentLive: false })
  assert.deepEqual(await noLiveAgent.setApproval('session-a', 'never'), { kind: 'refused', reason: 'session-not-live' },
    'no live Agent for the id is no live Session either')
  const noService = fixture({ approval: null })
  assert.deepEqual(await noService.setApproval('session-a', 'never'), { kind: 'refused', reason: 'approval-unavailable' })
  assert.equal(calls.length, 1, 'refused paths made zero official calls')
})

test('setApproval: an official setter throw after admission is unconfirmed, never refused', async () => {
  const port = fixture({ approval: { setPolicy: () => { throw new Error('setter boom') } } })
  assert.deepEqual(await port.setApproval('session-a', 'ask'), { kind: 'unconfirmed', reason: 'setter boom' })
})

test('setApproval: an aborted signal refuses before the dispatch', async () => {
  const calls: unknown[] = []
  const port = fixture({ approval: { setPolicy: (agent) => { calls.push(agent) } } })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => port.setApproval('session-a', 'ask', controller.signal))
  assert.equal(calls.length, 0)
})
