/** Contract tests for the Remote SessionLifecycle adapter, including Host-owned fork. */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteSessionLifecycle,
  type RemoteLifecycleSessionRemotes,
  type RemoteLifecycleSessionSummary,
  type RemoteLifecycleSessions,
} from '../src/runtime/remote/session-lifecycle-remote.ts'

function harness() {
  const calls = { creates: [] as unknown[], remoteCreates: [] as unknown[], forks: [] as unknown[], opens: [] as string[], added: [] as RemoteLifecycleSessionSummary[] }
  const addressable = new Set<string>()
  let generation: { id: number } | undefined = { id: 1 }
  let forkResult = 'session-child'
  let forkAddsAddressable = true
  let forkError: unknown
  let forkHook: (() => void) | undefined
  const sessions: RemoteLifecycleSessions = {
    create: async options => {
      calls.creates.push(options)
      const id = String(options.sessionId)
      addressable.add(id)
      return id
    },
    fork: async options => {
      calls.forks.push(options)
      forkHook?.()
      if (forkError !== undefined) throw forkError
      if (forkAddsAddressable) addressable.add(forkResult)
      return forkResult
    },
    open: id => { calls.opens.push(id) },
    binding: id => addressable.has(id) ? { sessionId: id } : undefined,
    handleSessionAdded: summary => { calls.added.push(summary); addressable.add(summary.sessionId) },
  }
  let remoteResult: { ok: true; value: { sessionId: string; agentPreset?: string } } | { ok: false; error: unknown } = {
    ok: true,
    value: { sessionId: 'session-remote' },
  }
  const remote: RemoteLifecycleSessionRemotes = {
    create: async request => {
      calls.remoteCreates.push(request)
      return remoteResult
    },
  }
  const lifecycle = new RemoteSessionLifecycle(sessions, remote, {
    getSnapshot: () => generation,
    subscribe: () => () => {},
  })
  return {
    lifecycle,
    calls,
    setGeneration: (id: number | undefined) => { generation = id === undefined ? undefined : { id } },
    setForkResult: (id: string) => { forkResult = id },
     setForkAddsAddressable: (value: boolean) => { forkAddsAddressable = value },
    setForkError: (error: unknown) => { forkError = error },
    setForkHook: (hook: () => void) => { forkHook = hook },
    setRemoteResult: (result: typeof remoteResult) => { remoteResult = result },
    setAddressable: (id: string, present: boolean) => { if (present) addressable.add(id); else addressable.delete(id) },
  }
}

test('ordinary create maps explicit cwd to ClientSessions.create', async () => {
  const h = harness()
  const result = await h.lifecycle.create({ sessionId: 'session-a', cwd: '/ws' })
  assert.equal(result.outcome.kind, 'created')
  assert.deepEqual(h.calls.creates, [{ sessionId: 'session-a', cwd: '/ws' }])
  assert.deepEqual(h.calls.remoteCreates, [])
})

test('explicit preset create uses generated session.create exactly once', async () => {
  const h = harness()
  const result = await h.lifecycle.create({ sessionId: 'session-a', cwd: '/ws', agentPreset: 'minimal' })
  assert.equal(result.outcome.kind, 'created')
  assert.deepEqual(h.calls.remoteCreates, [{ sessionId: 'session-a', cwd: '/ws', agentPreset: 'minimal' }])
  assert.deepEqual(h.calls.creates, [])
})

test('fork maps only source session and optional official anchor, without ordinary create', async () => {
  const h = harness()
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 42 })
  assert.equal(result.ownership, 'current')
  assert.equal(result.outcome.kind, 'forked')
  assert.deepEqual(h.calls.forks, [{ sessionId: 'session-source', atSeq: 42 }])
  assert.deepEqual(h.calls.creates, [])
  assert.deepEqual(h.calls.remoteCreates, [])
})

test('fork omits atSeq rather than encoding an empty prefix', async () => {
  const h = harness()
  await h.lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.deepEqual(h.calls.forks, [{ sessionId: 'session-source' }])
})

test('non-canonical fork anchors are rejected before Client dispatch', async () => {
  const h = harness()
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 0.5 })
  assert.equal(result.outcome.kind, 'rejected')
  assert.deepEqual(h.calls.forks, [])
})

test('official fork refusal is rejected and never retried', async () => {
  const h = harness()
  h.setForkError({ rpcError: { code: 'session/fork-unavailable', message: 'no completed turn' } })
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.outcome.kind, 'rejected')
  assert.equal(h.calls.forks.length, 1)
})

test('unknown fork failure is indeterminate and never retried', async () => {
  const h = harness()
  h.setForkError({ rpcError: { code: 'gateway/internal', message: 'connection lost' } })
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.outcome.kind, 'indeterminate')
  assert.equal(h.calls.forks.length, 1)
})

test('published-with-error preserves the authoritative child id', async () => {
  const h = harness()
  h.setForkError({ rpcError: { code: 'session/workspace-attach-failed', message: 'attach failed', details: { sessionId: 'session-published' } } })
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') assert.equal(result.outcome.sessionId, 'session-published')
})

test('successful fork after a generation change remains real but is locally superseded', async () => {
  const h = harness()
  h.setForkHook(() => h.setGeneration(2))
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.ownership, 'superseded')
  assert.equal(result.outcome.kind, 'forked')
})

test('a resolved fork trusts the official Client addressability guarantee', async () => {
  const h = harness()
  h.setForkResult('session-reconciled')
  // Official ClientSessions.fork() reconciles the child before it resolves, so
  // binding() must not be re-checked here: an absent local binding would mean
  // the Client contract itself broke, not a fork business outcome.
  h.setForkAddsAddressable(false)
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.ownership, 'current')
  assert.deepEqual(result.outcome, { kind: 'forked', handle: { session: { id: 'session-reconciled' } } })
  assert.equal(h.calls.forks.length, 1)
})

test('open is Client-local selection and never invokes a Host create/fork', async () => {
  const h = harness()
  h.setAddressable('session-a', true)
  const result = await h.lifecycle.open({ sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'opened')
  assert.deepEqual(h.calls.opens, ['session-a'])
  assert.deepEqual(h.calls.forks, [])
})

test('disconnected fork is a client-local pre-dispatch refusal, never a Host outcome', async () => {
  const h = harness()
  h.setGeneration(undefined)
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.deepEqual(result, {
    ownership: 'current',
    outcome: { kind: 'unavailable', message: 'the remote connection is not connected' },
  })
  assert.deepEqual(h.calls.forks, [])
})
