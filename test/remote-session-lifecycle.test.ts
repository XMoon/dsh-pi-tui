/**
 * Contract tests for the D2.3 Remote session lifecycle: ordinary create maps
 * to the official `ClientSessions.create()`, an explicit-preset fresh create
 * uses the generated official `session.create` plus Client-state
 * reconciliation, open maps to `ClientSessions.open()/binding()`, seeded
 * creates fail closed, and no failure is auto-retried.
 * @module @xmoon76/dsh-pi-tui/remote-session-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteCreateError,
  RemoteSessionLifecycle,
  type RemoteLifecycleSessionRemotes,
  type RemoteLifecycleSessionSummary,
  type RemoteLifecycleSessions,
} from '../src/runtime/remote/session-lifecycle-remote.ts'

interface LifecycleHarness {
  readonly lifecycle: RemoteSessionLifecycle
  readonly calls: {
    clientCreates: unknown[]
    remoteCreates: unknown[]
    opens: string[]
    added: RemoteLifecycleSessionSummary[]
  }
  readonly sessions: RemoteLifecycleSessions
  setClientCreateError(error: unknown): void
  setRemoteCreateResult(result: { ok: true; value: { sessionId: string; agentPreset?: string } } | { ok: false; error: unknown }): void
  setAddressable(sessionId: string, addressable: boolean): void
  setFailReconcile(fail: boolean): void
  /** Replace the Connection generation (undefined = disconnected). */
  setGeneration(id: number | undefined): void
  /** Run inside the Host RPC before it resolves (a mid-RPC reconnect). */
  setRemoteCreateHook(hook: () => void): void
  setClientCreateHook(hook: () => void): void
  /** Make the Client list reconciliation throw after publication. */
  setHandleAddedThrows(throws: boolean): void
  /** Run inside the synchronous reconciliation (e.g. to abort the signal). */
  setHandleAddedHook(hook: () => void): void
  /** Run inside the Client-local open (e.g. to change generation). */
  setOpenHook(hook: () => void): void
}

function lifecycleHarness(): LifecycleHarness {
  const calls = {
    clientCreates: [] as unknown[],
    remoteCreates: [] as unknown[],
    opens: [] as string[],
    added: [] as RemoteLifecycleSessionSummary[],
  }
  const addressable = new Set<string>()
  let clientCreateError: unknown
  let remoteCreateResult: { ok: true; value: { sessionId: string; agentPreset?: string } } | { ok: false; error: unknown } = {
    ok: true,
    value: { sessionId: 'session-a' },
  }
  let failReconcile = false
  let handleAddedThrows = false
  let handleAddedHook: (() => void) | undefined
  let openHook: (() => void) | undefined
  let generation: { id: number } | undefined = { id: 1 }
  let remoteCreateHook: (() => void) | undefined
  let clientCreateHook: (() => void) | undefined
  const sessions: RemoteLifecycleSessions = {
    create: async (opts) => {
      calls.clientCreates.push(opts)
      clientCreateHook?.()
      if (clientCreateError !== undefined) throw clientCreateError
      const id = String(opts.sessionId)
      addressable.add(id)
      return id
    },
    open: (id) => { calls.opens.push(id); openHook?.() },
    binding: (id) => addressable.has(id) ? { sessionId: id } : undefined,
    handleSessionAdded: (summary) => {
      calls.added.push(summary)
      handleAddedHook?.()
      if (handleAddedThrows) throw new Error('client reconciliation exploded')
      if (!failReconcile) addressable.add(summary.sessionId)
    },
  }
  const session: RemoteLifecycleSessionRemotes = {
    create: async (request) => {
      calls.remoteCreates.push(request)
      remoteCreateHook?.()
      return remoteCreateResult
    },
  }
  return {
    lifecycle: new RemoteSessionLifecycle(sessions, session, { getSnapshot: () => generation, subscribe: () => () => {} }),
    calls,
    sessions,
    setClientCreateError: (error) => { clientCreateError = error },
    setRemoteCreateResult: (result) => { remoteCreateResult = result },
    setAddressable: (sessionId, present) => { if (present) addressable.add(sessionId); else addressable.delete(sessionId) },
    setFailReconcile: (fail) => { failReconcile = fail },
    setGeneration: (id) => { generation = id === undefined ? undefined : { id } },
    setRemoteCreateHook: (hook) => { remoteCreateHook = hook },
    setClientCreateHook: (hook) => { clientCreateHook = hook },
    setHandleAddedThrows: (throws) => { handleAddedThrows = throws },
    setHandleAddedHook: (hook) => { handleAddedHook = hook },
    setOpenHook: (hook) => { openHook = hook },
  }
}

test('ordinary create (no explicit preset) uses the official ClientSessions.create', async () => {
  const harness = lifecycleHarness()
  const handle = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } })
  assert.deepEqual(handle, { session: { id: 'session-a' } })
  assert.deepEqual(harness.calls.clientCreates, [{ sessionId: 'session-a', cwd: '/ws' }])
  assert.deepEqual(harness.calls.remoteCreates, [], 'no generated session.create on the ordinary path')
})

test('explicit-preset create uses ONE official session.create and reconciles Client state', async () => {
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', false)
  const handle = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' })
  assert.deepEqual(handle, { session: { id: 'session-a' } })
  assert.deepEqual(harness.calls.remoteCreates, [{ sessionId: 'session-a', cwd: '/ws', agentPreset: 'minimal' }])
  assert.deepEqual(harness.calls.clientCreates, [], 'never create() then agentPresets.select()')
  assert.equal(harness.calls.added.length, 1, 'the Client object layer is reconciled')
  assert.equal(harness.sessions.binding('session-a') !== undefined, true, 'binding resolves after reconciliation')
})

test('explicit-preset create uses the Host-returned Session identity', async () => {
  const harness = lifecycleHarness()
  harness.setRemoteCreateResult({ ok: true, value: { sessionId: 'session-host-chosen', agentPreset: 'minimal' } })
  const handle = await harness.lifecycle.create({ sessionId: 'session-requested', meta: { cwd: '/ws' }, agentPreset: 'minimal' })
  assert.deepEqual(handle, { session: { id: 'session-host-chosen' } }, 'the returned identity is authoritative')
  assert.deepEqual(harness.calls.added.map(summary => summary.sessionId), ['session-host-chosen'])
})

test('explicit-preset create fails closed when reconciliation leaves no binding', async () => {
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', false)
  harness.setFailReconcile(true)
  await assert.rejects(
    harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' }),
    (error: unknown) => error instanceof RemoteCreateError
      && error.code === 'session/created-not-addressable'
      && error.publishedSessionId === 'session-a',
  )
})

test('a reconnect during the explicit-preset create is indeterminate and reconciles nothing', async () => {
  const harness = lifecycleHarness()
  harness.setRemoteCreateHook(() => harness.setGeneration(2))
  await assert.rejects(
    harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' }),
    (error: unknown) => error instanceof RemoteCreateError
      && error.code === 'session/create-indeterminate'
      && error.publishedSessionId === 'session-a',
  )
  assert.deepEqual(harness.calls.added, [], 'no old-Host result is applied to the replacement Client')
  assert.equal(harness.calls.remoteCreates.length, 1, 'exactly one Host dispatch, never a retry')
})

test('a reconnect during the ordinary create is indeterminate', async () => {
  const harness = lifecycleHarness()
  harness.setClientCreateHook(() => harness.setGeneration(2))
  await assert.rejects(
    harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } }),
    (error: unknown) => error instanceof RemoteCreateError && error.code === 'session/create-indeterminate',
  )
  assert.equal(harness.calls.clientCreates.length, 1, 'exactly one Host dispatch, never a retry')
})

test('a seeded/fork create fails closed without dispatching', async () => {
  const harness = lifecycleHarness()
  await assert.rejects(
    harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws', isSeeded: true }, seed: [] }),
    /cannot create a seeded\/forked Session/,
  )
  await assert.rejects(
    harness.lifecycle.create({ sessionId: 'session-b', meta: { cwd: '/ws' }, seed: [] }),
    /cannot create a seeded\/forked Session/,
  )
  assert.deepEqual(harness.calls.remoteCreates, [])
  assert.deepEqual(harness.calls.clientCreates, [])
})

test('a post-publication create error preserves the published Session identity', async () => {
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', false)
  harness.setRemoteCreateResult({
    ok: false,
    error: { code: 'session/workspace-attach-failed', message: 'attach failed', details: { sessionId: 'session-a' } },
  })
  await assert.rejects(
    harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' }),
    /may already have been published/,
  )
  assert.equal(harness.calls.remoteCreates.length, 1, 'exactly one Host dispatch, never a retry')
})

test('a code-less/attach-code ClientSessions.create failure does not fabricate a published identity', async () => {
  const harness = lifecycleHarness()
  // The code text appears in the message, but there is NO details.sessionId:
  // §0.7.3 requires details.sessionId from session/workspace-attach-failed as
  // the ONLY publication proof, so this must NOT claim publication.
  harness.setClientCreateError(new Error('session create failed: session/workspace-attach-failed: attach failed'))
  const error = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  assert.ok(error instanceof RemoteCreateError)
  assert.equal(error.publishedSessionId, undefined, 'no details.sessionId means no published-identity evidence')
  assert.ok(!/may already have been published/.test(error.message),
    'a code without publication details must not claim the Session was published')
  assert.equal(harness.calls.clientCreates.length, 1, 'exactly one Host dispatch, never a retry')
})

test('open uses ClientSessions.open/binding and issues no resume RPC', async () => {
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', true)
  const handle = await harness.lifecycle.open({ sessionId: 'session-a' })
  assert.deepEqual(handle, { session: { id: 'session-a' } })
  assert.deepEqual(harness.calls.opens, ['session-a'])
  assert.deepEqual(harness.calls.remoteCreates, [], 'open never invokes a Host resume/create RPC')
})

test('open fails closed for an unaddressable Client Session without mutating the selection', async () => {
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', false)
  await assert.rejects(harness.lifecycle.open({ sessionId: 'session-a' }), /not available in Client state/)
  assert.deepEqual(harness.calls.opens, [], 'no Client selection change for an unknown Session')
})

test('an already-aborted signal refuses before any Host dispatch', async () => {
  const harness = lifecycleHarness()
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, signal: controller.signal }), /abort/i)
  await assert.rejects(harness.lifecycle.open({ sessionId: 'session-a', signal: controller.signal }), /abort/i)
  assert.deepEqual(harness.calls.clientCreates, [])
  assert.deepEqual(harness.calls.opens, [])
})

test('a disconnected Remote lifecycle refuses both create paths before dispatch', async () => {
  const harness = lifecycleHarness()
  harness.setGeneration(undefined)
  await assert.rejects(
    harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } }),
    (error: unknown) => error instanceof RemoteCreateError && error.code === 'session/create-unavailable',
  )
  await assert.rejects(
    harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' }),
    (error: unknown) => error instanceof RemoteCreateError && error.code === 'session/create-unavailable',
  )
  assert.deepEqual(harness.calls.clientCreates, [])
  assert.deepEqual(harness.calls.remoteCreates, [])
})

test('a mid-flight abort during the ordinary create is ambiguous, never success', async () => {
  const harness = lifecycleHarness()
  const controller = new AbortController()
  harness.setClientCreateHook(() => controller.abort())
  await assert.rejects(
    harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, signal: controller.signal }),
    (error: unknown) => error instanceof RemoteCreateError
      && error.code === 'session/create-aborted-after-dispatch'
      && error.publishedSessionId === 'session-a',
  )
  assert.equal(harness.calls.clientCreates.length, 1, 'exactly one Host dispatch, never a retry')
})

test('a mid-flight abort during the explicit-preset create reconciles nothing', async () => {
  const harness = lifecycleHarness()
  const controller = new AbortController()
  harness.setRemoteCreateHook(() => controller.abort())
  await assert.rejects(
    harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal', signal: controller.signal }),
    (error: unknown) => error instanceof RemoteCreateError
      && error.code === 'session/create-aborted-after-dispatch'
      && error.publishedSessionId === 'session-a',
  )
  assert.deepEqual(harness.calls.added, [], 'no Client state is applied after the abort')
})

test('a generic/conflict create failure never claims a published identity', async () => {
  const harness = lifecycleHarness()
  harness.setClientCreateError({
    code: 'session/conflict',
    message: 'cwd conflict',
    details: { sessionId: 'session-other' },
    requestedSessionId: 'session-a',
  })
  const error = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  assert.ok(error instanceof RemoteCreateError)
  assert.equal(error.publishedSessionId, undefined, 'a requested/conflicting id is not a publication proof')
  assert.ok(!/may already have been published/.test(error.message))
})

test('a proven post-publication attach failure DOES expose the published identity', async () => {
  const harness = lifecycleHarness()
  harness.setRemoteCreateResult({
    ok: false,
    error: { code: 'session/workspace-attach-failed', message: 'attach failed', details: { sessionId: 'session-published' } },
  })
  const error = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  assert.ok(error instanceof RemoteCreateError)
  assert.equal(error.publishedSessionId, 'session-published')
  assert.match(error.message, /may already have been published/)
})

test('open fails closed while disconnected (v2 §0.5: a valid Client generation is required)', async () => {
  // Open is a Client-local selection, but v2 §0.5 still requires a valid
  // current Client generation; a disconnected Client cannot select.
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', true)
  harness.setGeneration(undefined)
  await assert.rejects(harness.lifecycle.open({ sessionId: 'session-a' }), /not connected/)
  assert.deepEqual(harness.calls.opens, [], 'no selection change while disconnected')
})

test('open fails closed for an unaddressable Session while disconnected', async () => {
  const harness = lifecycleHarness()
  harness.setGeneration(undefined)
  await assert.rejects(harness.lifecycle.open({ sessionId: 'session-x' }), /not connected/)
  assert.deepEqual(harness.calls.opens, [])
})

test('a generation replaced during the local open supersedes the result', async () => {
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', true)
  harness.setOpenHook(() => harness.setGeneration(2))
  await assert.rejects(harness.lifecycle.open({ sessionId: 'session-a' }), /superseded by a connection change/)
  assert.deepEqual(harness.calls.opens, ['session-a'], 'the local selection happened, but its result is not owned')
})

test('a Host refusal after a reconnect is indeterminate, never a pre-publication refusal', async () => {
  const harness = lifecycleHarness()
  harness.setRemoteCreateResult({ ok: false, error: { code: 'agent-preset/not-found', message: 'gone' } })
  harness.setRemoteCreateHook(() => harness.setGeneration(2))
  const error = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  assert.ok(error instanceof RemoteCreateError)
  assert.equal(error.code, 'session/create-indeterminate',
    'a reconnect during a failing create makes the refusal unprovable')
})

test('a throwing ordinary create after a reconnect is indeterminate', async () => {
  const harness = lifecycleHarness()
  harness.setClientCreateError(new Error('session create failed: gateway/bad-request: bad'))
  harness.setClientCreateHook(() => harness.setGeneration(2))
  const error = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  assert.ok(error instanceof RemoteCreateError)
  assert.equal(error.code, 'session/create-indeterminate')
})

test('a reconciliation throw after publication preserves the published identity', async () => {
  const harness = lifecycleHarness()
  harness.setHandleAddedThrows(true)
  const error = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  assert.ok(error instanceof RemoteCreateError)
  assert.equal(error.code, 'session/reconcile-failed')
  assert.equal(error.publishedSessionId, 'session-a',
    'a post-publication reconciliation failure must preserve the published identity')
  assert.match(error.message, /may already have been published/)
})

test('an ambiguous failing explicit create preserves a post-publication identity from the error', async () => {
  const harness = lifecycleHarness()
  harness.setRemoteCreateResult({
    ok: false,
    error: { code: 'session/workspace-attach-failed', message: 'attach failed', details: { sessionId: 'session-published' } },
  })
  harness.setRemoteCreateHook(() => harness.setGeneration(2))
  const error = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  assert.ok(error instanceof RemoteCreateError)
  assert.equal(error.code, 'session/create-indeterminate')
  assert.equal(error.publishedSessionId, 'session-published')
})

test('an ambiguous throwing ordinary create preserves a post-publication identity from the error', async () => {
  const harness = lifecycleHarness()
  harness.setClientCreateError({ code: 'session/workspace-attach-failed', message: 'attach failed', details: { sessionId: 'session-published' } })
  harness.setClientCreateHook(() => harness.setGeneration(2))
  const error = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  )
  assert.ok(error instanceof RemoteCreateError)
  assert.equal(error.code, 'session/create-indeterminate')
  assert.equal(error.publishedSessionId, 'session-published')
})

test('a synchronous reconciliation abort does not retroactively fail the create', async () => {
  const harness = lifecycleHarness()
  const controller = new AbortController()
  harness.setHandleAddedHook(() => controller.abort())
  const handle = await harness.lifecycle.create({
    sessionId: 'session-a',
    meta: { cwd: '/ws' },
    agentPreset: 'minimal',
    signal: controller.signal,
  })
  assert.deepEqual(handle, { session: { id: 'session-a' } },
    'the Host create and the synchronous local reconciliation already committed; an abort cannot un-publish them')
})
