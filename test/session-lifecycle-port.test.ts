/**
 * Adapter contract tests for the Direct session lifecycle
 * (runtime/direct/session-lifecycle-direct.ts, migration M1.5,
 * contract-reviewed): the port is the semantic boundary — the runner
 * depends on `SessionLifecycle`, the Direct adapter owns the `ctx.agents`
 * access AND the preset composition (converting the semantic request into
 * the Direct setup callback), and a Remote adapter must satisfy the SAME
 * contract in a later milestone. These tests pin the contract with a fake
 * Host context, so the two backends cannot drift.
 * @module @xmoon76/dsh-pi-tui/session-lifecycle-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSessionLifecycle, type HostContextLike } from '../src/runtime/direct/session-lifecycle-direct.ts'
import type { CreateSessionRequest, ResumeSessionRequest } from '../src/runtime/session-lifecycle-port.ts'

function host(agents: unknown): HostContextLike {
  return { get: (name) => (name === 'agents' ? agents : undefined) }
}

function compose(presetId?: string) {
  return async () => ({ agentPreset: presetId, setup: () => {} })
}

const createRequest: CreateSessionRequest = {
  sessionId: 'session-new',
  meta: { cwd: '/ws' },
  provider: 'p',
  model: 'm',
  agentPreset: 'preset-a',
}

const resumeRequest: ResumeSessionRequest = {
  resumeSessionId: 'session-old',
  provider: 'p',
  model: 'm',
  agentPreset: 'preset-a',
}

test('create resolves the preset composition internally and delegates with the Direct shapes', async () => {
  const calls: Array<{ sessionId: unknown; meta: unknown; agentOptions: unknown; setup: unknown }> = []
  const lifecycle = new DirectSessionLifecycle(host({
    create: async (options: { sessionId: unknown; meta: unknown; agentOptions: unknown; setup: unknown }) => {
      calls.push({ sessionId: options.sessionId, meta: options.meta, agentOptions: options.agentOptions, setup: options.setup })
      return { agent: { session: { id: 'session-new' } } }
    },
    resume: async () => ({ agent: { session: { id: 'x' } } }),
  }), compose('preset-a'))
  const handle = await lifecycle.create(createRequest)
  assert.equal(handle.session.id, 'session-new')
  assert.equal(handle.directAgent !== undefined, true, 'Direct handle carries the live agent')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 'session-new')
  assert.deepEqual(calls[0].agentOptions, { provider: 'p', model: 'm' })
  assert.equal(typeof calls[0].setup, 'function', 'the setup callback is built INSIDE the adapter')
})

test('resume resolves the preset composition internally and delegates with the Direct shapes', async () => {
  const calls: Array<{ resumeSessionId: unknown; agentOptions: unknown; setup: unknown }> = []
  const lifecycle = new DirectSessionLifecycle(host({
    create: async () => ({ agent: { session: { id: 'x' } } }),
    resume: async (options: { resumeSessionId: unknown; agentOptions: unknown; setup: unknown }) => {
      calls.push({ resumeSessionId: options.resumeSessionId, agentOptions: options.agentOptions, setup: options.setup })
      return { agent: { session: { id: 'session-old' } } }
    },
  }), compose('preset-a'))
  const handle = await lifecycle.resume(resumeRequest)
  assert.equal(handle.session.id, 'session-old')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].resumeSessionId, 'session-old')
  assert.deepEqual(calls[0].agentOptions, { provider: 'p', model: 'm' })
  assert.equal(typeof calls[0].setup, 'function')
})

test('create and resume fail loudly when the agents service is absent', async () => {
  const lifecycle = new DirectSessionLifecycle(host(undefined), compose('preset-a'))
  await assert.rejects(() => lifecycle.create(createRequest), /agents service unavailable/)
  await assert.rejects(() => lifecycle.resume(resumeRequest), /agents service unavailable/)
})
