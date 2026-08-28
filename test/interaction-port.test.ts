/**
 * Adapter contract tests for the Direct interaction port
 * (runtime/direct/interaction-direct.ts, migration M1.6, contract round
 * 4): the port is transport-neutral — setApprovalPolicy addresses the
 * session by id (the Direct adapter resolves the live Agent internally
 * via the runner-injected resolver), and the approval listener receives
 * the Agent-free ApprovalRequestLike. A Remote adapter must satisfy the
 * SAME contract over the wire. These tests pin the contract with a fake
 * Host context.
 * @module @xmoon76/dsh-pi-tui/interaction-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectInteractionPort, type HostContextLike } from '../src/runtime/direct/interaction-direct.ts'
import type { UserQuestionProvider } from '../src/runtime/interaction-port.ts'

function host(services: Record<string, unknown>, events: Array<string | ((req: unknown, next: unknown) => unknown)> = []): HostContextLike {
  return {
    get: (name) => services[name],
    on: (event, listener) => {
      events.push(event)
      events.push(listener as (req: unknown, next: unknown) => unknown)
      return listener
    },
  }
}

function port(services: Record<string, unknown>, agentFor?: (sessionId: string) => unknown | undefined, events: Array<string | ((req: unknown, next: unknown) => unknown)> = []) {
  return new DirectInteractionPort(host(services, events), agentFor ?? (() => undefined))
}

const provider: UserQuestionProvider = async () => ({ answers: [] })

test('registerQuestionProvider registers on the DSH user-question waterfall', () => {
  const events: Array<string | ((req: unknown, next: unknown) => unknown)> = []
  const p = port({ userQuestions: {} }, undefined, events)
  assert.equal(p.registerQuestionProvider(provider), true)
  assert.equal(events[0], 'user-questions/request')
  assert.equal(events[1], provider)
})

test('registerQuestionProvider reports absent service', () => {
  const p = port({})
  assert.equal(p.registerQuestionProvider(provider), false)
})

test('onApprovalRequest subscribes to the approval/request event', () => {
  const events: string[] = []
  const p = port({}, undefined, events)
  const listener = () => 'ok'
  p.onApprovalRequest(listener)
  assert.equal(events[0], 'approval/request')
})

test('onApprovalRequest adapts the official ApprovalRequest onto the Agent-free Like shape', () => {
  const received: Array<{ signal?: AbortSignal; callId?: string; toolName: string; reason?: string }> = []
  const events: Array<string | ((req: unknown, next: unknown) => unknown)> = []
  const p = port({}, undefined, events)
  p.onApprovalRequest((req) => { received.push(req); return 'ok' })
  // events[0] is the event NAME; events[1] is the registered handler.
  const handler = events[1]! as (req: unknown, next: unknown) => unknown
  // The real dsh ApprovalRequest carries a same-process agent; the adapter
  // must strip it and pass ONLY the transport-neutral subset.
  handler({ agent: { session: { id: 'x' } }, toolName: 'bash', reason: 'r', callId: 'call-1', signal: undefined }, () => {})
  assert.deepEqual(received, [{ toolName: 'bash', reason: 'r', callId: 'call-1' }])
})

test('setApprovalPolicy resolves the session id to the live Agent internally and delegates', () => {
  const calls: Array<{ agent: unknown; policy: unknown }> = []
  const liveAgent = { session: { id: 'session-a' } }
  const p = port(
    { approval: { setPolicy: (agent: unknown, policy: string) => { calls.push({ agent, policy }) } } },
    (sessionId) => sessionId === 'session-a' ? liveAgent : undefined,
  )
  assert.equal(p.setApprovalPolicy('session-a', 'ask'), true)
  assert.deepEqual(calls, [{ agent: liveAgent, policy: 'ask' }])
})

test('setApprovalPolicy reports unavailable when the service or the session is absent', () => {
  const p = port({}, (sessionId) => sessionId === 'session-a' ? { session: { id: 'session-a' } } : undefined)
  assert.equal(p.setApprovalPolicy('session-ghost', 'never'), false, 'no live agent for the session')
  const p2 = port({})
  assert.equal(p2.setApprovalPolicy('session-a', 'never'), false, 'no approval service')
})
