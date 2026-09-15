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

// ---------------------------------------------------------------------------
// create — success settlement + both ownership axes (v2 §0.2.1/§0.7.3)
// ---------------------------------------------------------------------------

test('ordinary create (no explicit preset) uses the official ClientSessions.create', async () => {
  const harness = lifecycleHarness()
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } })
  assert.equal(result.ownership, 'current')
  assert.deepEqual(result.outcome, { kind: 'created', handle: { session: { id: 'session-a' } } })
  assert.deepEqual(harness.calls.clientCreates, [{ sessionId: 'session-a', cwd: '/ws' }])
  assert.deepEqual(harness.calls.remoteCreates, [], 'no generated session.create on the ordinary path')
})

test('explicit-preset create uses ONE official session.create and reconciles Client state', async () => {
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', false)
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' })
  assert.equal(result.ownership, 'current')
  assert.deepEqual(result.outcome, { kind: 'created', handle: { session: { id: 'session-a' } } })
  assert.deepEqual(harness.calls.remoteCreates, [{ sessionId: 'session-a', cwd: '/ws', agentPreset: 'minimal' }])
  assert.deepEqual(harness.calls.clientCreates, [], 'never create() then agentPresets.select()')
  assert.equal(harness.calls.added.length, 1, 'the Client object layer is reconciled')
  assert.equal(harness.sessions.binding('session-a') !== undefined, true, 'binding resolves after reconciliation')
})

test('explicit-preset create uses the Host-returned Session identity', async () => {
  const harness = lifecycleHarness()
  harness.setRemoteCreateResult({ ok: true, value: { sessionId: 'session-host-chosen', agentPreset: 'minimal' } })
  const result = await harness.lifecycle.create({ sessionId: 'session-requested', meta: { cwd: '/ws' }, agentPreset: 'minimal' })
  assert.deepEqual(result.outcome, { kind: 'created', handle: { session: { id: 'session-host-chosen' } } },
    'the returned identity is authoritative')
  assert.deepEqual(harness.calls.added.map(summary => summary.sessionId), ['session-host-chosen'])
})

test('explicit-preset create reports published-with-error when reconciliation leaves no binding', async () => {
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', false)
  harness.setFailReconcile(true)
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' })
  assert.equal(result.ownership, 'current')
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') {
    assert.equal(result.outcome.sessionId, 'session-a')
    assert.equal(result.outcome.error.code, 'session/created-not-addressable')
  }
})

test('a reconnect during a SUCCESSFUL explicit create is created + superseded', async () => {
  const harness = lifecycleHarness()
  harness.setRemoteCreateHook(() => harness.setGeneration(2))
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' })
  // v2 §0.2.1: the Host commit is real; only the LOCAL ownership is lost.
  assert.equal(result.outcome.kind, 'created')
  assert.equal(result.ownership, 'superseded')
  assert.deepEqual(harness.calls.added, [], 'no old-Host result is applied to the replacement Client')
  assert.equal(harness.calls.remoteCreates.length, 1, 'exactly one Host dispatch, never a retry')
})

test('a reconnect during a SUCCESSFUL ordinary create is created + superseded', async () => {
  const harness = lifecycleHarness()
  harness.setClientCreateHook(() => harness.setGeneration(2))
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } })
  assert.equal(result.outcome.kind, 'created')
  assert.equal(result.ownership, 'superseded')
  assert.equal(harness.calls.clientCreates.length, 1, 'exactly one Host dispatch, never a retry')
})

test('a seeded/fork create fails closed without dispatching', async () => {
  const harness = lifecycleHarness()
  const first = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws', isSeeded: true }, seed: [] })
  assert.equal(first.ownership, 'current')
  assert.equal(first.outcome.kind, 'rejected')
  if (first.outcome.kind === 'rejected') assert.equal(first.outcome.error.code, 'session/create-seeded-unsupported')
  const second = await harness.lifecycle.create({ sessionId: 'session-b', meta: { cwd: '/ws' }, seed: [] })
  assert.equal(second.outcome.kind, 'rejected')
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
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' })
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') {
    assert.equal(result.outcome.sessionId, 'session-a')
    assert.equal(result.outcome.error.code, 'session/workspace-attach-failed')
  }
  assert.equal(harness.calls.remoteCreates.length, 1, 'exactly one Host dispatch, never a retry')
})

test('a code-less/attach-code create failure does not fabricate a published identity', async () => {
  const harness = lifecycleHarness()
  // The code text appears in the message, but there is NO details.sessionId:
  // §0.7.3 requires details.sessionId from session/workspace-attach-failed as
  // the ONLY publication proof, so this must NOT claim publication.
  harness.setClientCreateError(new Error('session create failed: session/workspace-attach-failed: attach failed'))
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } })
  assert.equal(result.outcome.kind, 'indeterminate', 'no details.sessionId means no published-identity evidence')
  if (result.outcome.kind === 'indeterminate') assert.equal(result.outcome.requestedSessionId, 'session-a')
  assert.equal(harness.calls.clientCreates.length, 1, 'exactly one Host dispatch, never a retry')
})

test('a proven pre-publication refusal is rejected and never published', async () => {
  const harness = lifecycleHarness()
  harness.setClientCreateError({ code: 'session/conflict', message: 'cwd conflict', details: { sessionId: 'session-other' } })
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } })
  assert.equal(result.outcome.kind, 'rejected')
  if (result.outcome.kind === 'rejected') assert.equal(result.outcome.error.code, 'session/conflict')
})

test('an unknown/gateway-internal create failure stays indeterminate', async () => {
  const harness = lifecycleHarness()
  harness.setClientCreateError({ code: 'gateway/internal', message: 'carrier lost' })
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } })
  assert.equal(result.outcome.kind, 'indeterminate')
})

// ---------------------------------------------------------------------------
// create — pre-dispatch cancellation / abort ownership
// ---------------------------------------------------------------------------

test('an already-aborted signal settles cancelled before any Host dispatch', async () => {
  const harness = lifecycleHarness()
  const controller = new AbortController()
  controller.abort()
  const created = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, signal: controller.signal })
  assert.deepEqual(created, { ownership: 'current', outcome: { kind: 'cancelled' } })
  const opened = await harness.lifecycle.open({ sessionId: 'session-a', signal: controller.signal })
  assert.deepEqual(opened, { ownership: 'current', outcome: { kind: 'cancelled' } })
  assert.deepEqual(harness.calls.clientCreates, [])
  assert.deepEqual(harness.calls.opens, [])
})

test('a disconnected Remote lifecycle reports cancelled (create) / unavailable (open) before dispatch', async () => {
  const harness = lifecycleHarness()
  harness.setGeneration(undefined)
  const ordinary = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } })
  assert.deepEqual(ordinary, { ownership: 'current', outcome: { kind: 'cancelled' } })
  const explicit = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' })
  assert.deepEqual(explicit, { ownership: 'current', outcome: { kind: 'cancelled' } })
  assert.deepEqual(harness.calls.clientCreates, [])
  assert.deepEqual(harness.calls.remoteCreates, [])
})

test('a mid-flight abort during a SUCCESSFUL ordinary create is created + superseded', async () => {
  const harness = lifecycleHarness()
  const controller = new AbortController()
  harness.setClientCreateHook(() => controller.abort())
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, signal: controller.signal })
  // A post-dispatch abort does not prove non-commit: the settlement stays the
  // proven Host result, and only the local ownership is lost (v2 §0.2.4).
  assert.equal(result.outcome.kind, 'created')
  assert.equal(result.ownership, 'superseded')
  assert.equal(harness.calls.clientCreates.length, 1, 'exactly one Host dispatch, never a retry')
})

test('a mid-flight abort during a SUCCESSFUL explicit-preset create reconciles nothing', async () => {
  const harness = lifecycleHarness()
  const controller = new AbortController()
  harness.setRemoteCreateHook(() => controller.abort())
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal', signal: controller.signal })
  assert.equal(result.outcome.kind, 'created')
  assert.equal(result.ownership, 'superseded')
  assert.deepEqual(harness.calls.added, [], 'no Client state is applied after the abort')
})

test('a reconciliation abort does not retroactively fail the create, but drops ownership', async () => {
  const harness = lifecycleHarness()
  const controller = new AbortController()
  harness.setHandleAddedHook(() => controller.abort())
  const result = await harness.lifecycle.create({
    sessionId: 'session-a',
    meta: { cwd: '/ws' },
    agentPreset: 'minimal',
    signal: controller.signal,
  })
  assert.equal(result.outcome.kind, 'created', 'the Host create and the local reconciliation already committed')
  assert.equal(result.ownership, 'superseded', 'the abort during reconciliation loses local ownership')
})

test('a reconciliation throw after publication preserves the published identity', async () => {
  const harness = lifecycleHarness()
  harness.setHandleAddedThrows(true)
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' })
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') {
    assert.equal(result.outcome.sessionId, 'session-a')
    assert.equal(result.outcome.error.code, 'session/reconcile-failed')
  }
})

// ---------------------------------------------------------------------------
// create — failure classification AFTER the two-axis fence
// ---------------------------------------------------------------------------

test('a Host refusal after a reconnect stays rejected but loses ownership', async () => {
  const harness = lifecycleHarness()
  harness.setRemoteCreateResult({ ok: false, error: { code: 'agent-preset/not-found', message: 'gone' } })
  harness.setRemoteCreateHook(() => harness.setGeneration(2))
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' })
  assert.equal(result.outcome.kind, 'rejected',
    'the refusal is provable from the Host that processed it; a reconnect does not make it indeterminate')
  assert.equal(result.ownership, 'superseded')
})

test('a throwing ordinary create after a reconnect stays rejected but loses ownership', async () => {
  const harness = lifecycleHarness()
  harness.setClientCreateError({ code: 'gateway/bad-request', message: 'bad' })
  harness.setClientCreateHook(() => harness.setGeneration(2))
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } })
  assert.equal(result.outcome.kind, 'rejected')
  assert.equal(result.ownership, 'superseded')
})

test('an ambiguous failing explicit create preserves a post-publication identity as published-with-error + superseded', async () => {
  const harness = lifecycleHarness()
  harness.setRemoteCreateResult({
    ok: false,
    error: { code: 'session/workspace-attach-failed', message: 'attach failed', details: { sessionId: 'session-published' } },
  })
  harness.setRemoteCreateHook(() => harness.setGeneration(2))
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' }, agentPreset: 'minimal' })
  assert.equal(result.outcome.kind, 'published-with-error')
  assert.equal(result.ownership, 'superseded')
  if (result.outcome.kind === 'published-with-error') assert.equal(result.outcome.sessionId, 'session-published')
})

test('an ambiguous throwing ordinary create preserves a post-publication identity as published-with-error + superseded', async () => {
  const harness = lifecycleHarness()
  harness.setClientCreateError({ code: 'session/workspace-attach-failed', message: 'attach failed', details: { sessionId: 'session-published' } })
  harness.setClientCreateHook(() => harness.setGeneration(2))
  const result = await harness.lifecycle.create({ sessionId: 'session-a', meta: { cwd: '/ws' } })
  assert.equal(result.outcome.kind, 'published-with-error')
  assert.equal(result.ownership, 'superseded')
  if (result.outcome.kind === 'published-with-error') assert.equal(result.outcome.sessionId, 'session-published')
})

// ---------------------------------------------------------------------------
// open — Client-local selection with a machine-readable result
// ---------------------------------------------------------------------------

test('open uses ClientSessions.open/binding and issues no resume RPC', async () => {
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', true)
  const result = await harness.lifecycle.open({ sessionId: 'session-a' })
  assert.deepEqual(result, { ownership: 'current', outcome: { kind: 'opened', handle: { session: { id: 'session-a' } } } })
  assert.deepEqual(harness.calls.opens, ['session-a'])
  assert.deepEqual(harness.calls.remoteCreates, [], 'open never invokes a Host resume/create RPC')
})

test('open reports unavailable for an unaddressable Client Session without mutating the selection', async () => {
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', false)
  const result = await harness.lifecycle.open({ sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'unavailable')
  assert.deepEqual(harness.calls.opens, [], 'no Client selection change for an unknown Session')
})

test('open reports unavailable while disconnected (v2 §0.5: a valid Client generation is required)', async () => {
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', true)
  harness.setGeneration(undefined)
  const result = await harness.lifecycle.open({ sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'unavailable')
  assert.match(result.outcome.kind === 'unavailable' ? result.outcome.message : '', /not connected/)
  assert.deepEqual(harness.calls.opens, [], 'no selection change while disconnected')
})

test('a generation replaced during the local open is opened + superseded', async () => {
  const harness = lifecycleHarness()
  harness.setAddressable('session-a', true)
  harness.setOpenHook(() => harness.setGeneration(2))
  const result = await harness.lifecycle.open({ sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'opened')
  assert.equal(result.ownership, 'superseded')
  assert.deepEqual(harness.calls.opens, ['session-a'], 'the local selection happened, but its result is not owned')
})
