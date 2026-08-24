/**
 * Adapter contract tests for the Direct interaction port
 * (runtime/direct/interaction-direct.ts, migration M1.6): the port is the
 * semantic boundary — the runner depends on `InteractionPort`, the Direct
 * adapter owns the `ctx` access (userQuestions / approval services, the
 * approval/request event), and a Remote adapter must satisfy the SAME
 * contract in a later milestone. These tests pin the contract with a fake
 * Host context, so the two backends cannot drift.
 * @module @xmoon76/dsh-pi-tui/interaction-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectInteractionPort, type HostContextLike } from '../src/runtime/direct/interaction-direct.ts'
import type { UserQuestionProvider } from '@deepseek-ai/dsh-user-questions'

function host(services: Record<string, unknown>, events: string[] = []): HostContextLike {
  return {
    get: (name) => services[name],
    on: (event, listener) => {
      events.push(event)
      return listener
    },
  }
}

const provider: UserQuestionProvider = {
  ask: async () => ({ answers: [] }),
}

test('registerQuestionProvider registers through the userQuestions service', () => {
  const registered: unknown[] = []
  const port = new DirectInteractionPort(host({
    userQuestions: { registerProvider: (p: unknown) => { registered.push(p) } },
  }))
  assert.equal(port.registerQuestionProvider(provider), true)
  assert.deepEqual(registered, [provider])
})

test('registerQuestionProvider reports absent service', () => {
  const port = new DirectInteractionPort(host({}))
  assert.equal(port.registerQuestionProvider(provider), false)
})

test('onApprovalRequest subscribes to the approval/request event', () => {
  const events: string[] = []
  const port = new DirectInteractionPort(host({}, events))
  const listener = () => 'ok'
  port.onApprovalRequest(listener)
  assert.deepEqual(events, ['approval/request'])
})

test('setApprovalPolicy delegates to the approval service', () => {
  const calls: Array<{ agent: unknown; policy: unknown }> = []
  const port = new DirectInteractionPort(host({
    approval: { setPolicy: (agent: unknown, policy: string) => { calls.push({ agent, policy }) } },
  }))
  const agent = { session: { id: 'session-a' } }
  assert.equal(port.setApprovalPolicy(agent, 'ask'), true)
  assert.deepEqual(calls, [{ agent, policy: 'ask' }])
})

test('setApprovalPolicy reports unavailable service', () => {
  const port = new DirectInteractionPort(host({}))
  assert.equal(port.setApprovalPolicy({ session: { id: 'x' } }, 'never'), false)
})