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
import { ownerHandleOf, type CreateSessionRequest, type ResumeSessionRequest } from '../src/runtime/session-lifecycle-port.ts'

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
      return { agent: { session: { id: 'session-new' } }, dispose: async () => {} }
    },
    resume: async () => ({ agent: { session: { id: 'x' } }, dispose: async () => {} }),
  }), compose('preset-a'))
  const handle = await lifecycle.create(createRequest)
  assert.equal(handle.session.id, 'session-new')
  assert.equal(handle.direct !== undefined, true, 'Direct handle carries the ownership escape')
  assert.ok(handle.direct && typeof handle.direct.agent === 'object', 'carries the live agent')
  assert.ok(handle.direct && typeof handle.direct.ownerHandle === 'object' && typeof (handle.direct.ownerHandle as { dispose?: unknown }).dispose === 'function', 'carries the real owner handle with dispose()')
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
      return { agent: { session: { id: 'session-old' } }, dispose: async () => {} }
    },
  }), compose('preset-a'))
  const handle = await lifecycle.resume(resumeRequest)
  assert.equal(handle.session.id, 'session-old')
  assert.equal(handle.direct !== undefined, true)
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

test('P1 regression: the ownership escape preserves the real AgentHandle so the runner can dispose it on retirement', async () => {
  // The runner stores liveHandle = handle.direct.ownerHandle and calls
  // dispose() when transitioning AWAY from the session. A lost handle
  // previously pinned the old lease (review finding). This pins the
  // create → SessionHandle → dispose chain.
  let disposed = 0
  const lifecycle = new DirectSessionLifecycle(host({
    create: async () => ({
      agent: { session: { id: 'session-a' } },
      dispose: async () => { disposed += 1 },
    }),
    resume: async () => ({ agent: { session: { id: 'session-a' } }, dispose: async () => {} }),
  }), compose('preset-a'))
  const handle = await lifecycle.create(createRequest)
  // The runner's retirement path:
  const liveHandle = handle.direct?.ownerHandle as { dispose(): Promise<void> } | undefined
  assert.ok(liveHandle !== undefined, 'the runner receives the real owner handle')
  await liveHandle.dispose()
  assert.equal(disposed, 1, 'the original AgentHandle.dispose() is called exactly once')
  // The live agent is the same object the runner drives:
  assert.equal((handle.direct!.agent as { session: { id: string } }).session.id, 'session-a')
})

test('P1 regression (round 3): transition commit stores the OWNER HANDLE, and a SECOND transition disposes the FIRST exactly once', async () => {
  // The exact chain that broke: transition A→B stores liveHandle from the
  // SessionHandle, then transition B→C disposes the OLD liveHandle. If the
  // commit had stored the SessionHandle (or the agent) instead of the real
  // ownerHandle, dispose() would be missing and B would PIN — never
  // cooling. This pins ownerHandleOf + the double-transition dispose.
  const disposed: string[] = []
  let sequence = 0
  const lifecycle = new DirectSessionLifecycle(host({
    create: async (request: { sessionId: string }) => {
      const id = request.sessionId
      return {
        agent: { session: { id } },
        dispose: async () => { disposed.push(id) },
      }
    },
    resume: async () => ({ agent: { session: { id: 'x' } }, dispose: async () => {} }),
  }), compose('preset-a'))

  // Transition A -> B: create B's SessionHandle.
  const handleB = await lifecycle.create({ sessionId: 'session-b', meta: {} })
  // The commit stores the OWNER HANDLE (exactly what the runner does):
  let liveHandle = ownerHandleOf(handleB) as { dispose(): Promise<void> }
  assert.ok(liveHandle !== undefined, 'the commit stores the real owner handle, never the SessionHandle')

  // Transition B -> C: the OLD live handle (B) is disposed exactly once.
  sequence += 1
  await liveHandle.dispose()
  assert.deepEqual(disposed, ['session-b'], 'transition B→C disposes B\x27s original AgentHandle exactly once')

  // And a third transition disposes C exactly once:
  const handleC = await lifecycle.create({ sessionId: 'session-c', meta: {} })
  liveHandle = ownerHandleOf(handleC) as { dispose(): Promise<void> }
  await liveHandle.dispose()
  assert.deepEqual(disposed, ['session-b', 'session-c'], 'each retired session disposes exactly once, in order')
})
