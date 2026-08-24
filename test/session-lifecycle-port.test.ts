/**
 * Adapter contract tests for the Direct session lifecycle
 * (runtime/direct/session-lifecycle-direct.ts, migration M1.5): the port
 * is the semantic boundary — the runner depends on `SessionLifecycle`, the
 * Direct adapter owns the `ctx.agents` access, and a Remote adapter must
 * satisfy the SAME contract in a later milestone. These tests pin the
 * contract with a fake Host context, so the two backends cannot drift.
 * @module @xmoon76/dsh-pi-tui/session-lifecycle-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSessionLifecycle, type HostContextLike } from '../src/runtime/direct/session-lifecycle-direct.ts'
import type { CreateSessionOptions, ResumeSessionOptions } from '../src/runtime/session-lifecycle-port.ts'

function host(agents: unknown): HostContextLike {
  return { get: (name) => (name === 'agents' ? agents : undefined) }
}

const createOptions: CreateSessionOptions = {
  sessionId: 'session-new' as never,
  meta: { cwd: '/ws' },
  agentOptions: { provider: 'p', model: 'm' },
  setup: () => {},
}

const resumeOptions: ResumeSessionOptions = {
  resumeSessionId: 'session-old' as never,
  agentOptions: { provider: 'p', model: 'm' },
  setup: () => {},
}

test('create delegates to the ctx.agents service with the exact options', async () => {
  const calls: CreateSessionOptions[] = []
  const lifecycle = new DirectSessionLifecycle(host({
    create: async (options: CreateSessionOptions) => {
      calls.push(options)
      return { agent: { session: { id: options.sessionId } } } as never
    },
    resume: async () => ({}) as never,
  }))
  const handle = await lifecycle.create(createOptions)
  assert.equal(calls.length, 1)
  assert.equal(calls[0], createOptions)
  assert.ok(handle !== undefined)
})

test('resume delegates to the ctx.agents service with the exact options', async () => {
  const calls: ResumeSessionOptions[] = []
  const lifecycle = new DirectSessionLifecycle(host({
    create: async () => ({}) as never,
    resume: async (options: ResumeSessionOptions) => {
      calls.push(options)
      return { agent: { session: { id: options.resumeSessionId } } } as never
    },
  }))
  const handle = await lifecycle.resume(resumeOptions)
  assert.equal(calls.length, 1)
  assert.equal(calls[0], resumeOptions)
  assert.ok(handle !== undefined)
})

test('create and resume fail loudly when the agents service is absent', async () => {
  const lifecycle = new DirectSessionLifecycle(host(undefined))
  await assert.rejects(() => lifecycle.create(createOptions), /agents service unavailable/)
  await assert.rejects(() => lifecycle.resume(resumeOptions), /agents service unavailable/)
})
