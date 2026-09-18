/**
 * Contract tests for the Remote SessionLifecycle adapter under the alpha2
 * explicit-reference Client contract: ordinary create, explicit-preset raw
 * create + public refresh, open-as-retain, and publication-only fork.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteSessionLifecycle,
  type RemoteLifecycleSessionRemotes,
  type RemoteLifecycleSessions,
} from '../src/runtime/remote/session-lifecycle-remote.ts'
import type { RemoteSessionReferenceLike, TuiSessionReferenceSource } from '../src/runtime/remote/session-reference.ts'
import { clientOwnerOf, directAgentOf, ownerHandleOf } from '../src/runtime/session-lifecycle-port.ts'

interface RetainCall {
  readonly target: string
  readonly source: TuiSessionReferenceSource
}

/** A faithful model of the alpha2 Client reference lifetime: a binding
 * generation exists only while at least one reference is retained, and a
 * same-id re-retain after full release yields a NEW binding object. */
function harness() {
  const calls = {
    creates: [] as unknown[],
    remoteCreates: [] as unknown[],
    forks: [] as unknown[],
    retains: [] as RetainCall[],
    releases: [] as string[],
    refreshes: 0,
  }
  const catalogued = new Set<string>()
  const generations = new Map<string, { readonly id: string }>()
  const counts = new Map<string, number>()
  let generation: { id: number } | undefined = { id: 1 }
  let forkResult = 'session-child'
  let forkError: unknown
  let forkHook: (() => void) | undefined
  let retainError: unknown
  let refreshError: unknown
  let retainHook: (() => void) | undefined
  const sessions: RemoteLifecycleSessions = {
    create: async options => {
      calls.creates.push(options)
      const id = String(options.sessionId)
      catalogued.add(id)
      return id
    },
    fork: async options => {
      calls.forks.push(options)
      forkHook?.()
      if (forkError !== undefined) throw forkError
      catalogued.add(forkResult)
      return forkResult
    },
    refresh: async () => {
      calls.refreshes += 1
      if (refreshError !== undefined) throw refreshError
      reconcile()
    },
    retain: (target, options) => {
      calls.retains.push({ target, source: options.source })
      retainHook?.()
      options.signal?.throwIfAborted()
      if (retainError !== undefined) throw retainError
      if (!catalogued.has(target)) throw new Error(`sessions.retain: unknown session ${target}`)
      counts.set(target, (counts.get(target) ?? 0) + 1)
      if (!generations.has(target)) generations.set(target, { id: target })
      let live = true
      const reference: RemoteSessionReferenceLike = {
        sessionId: target,
        get binding() {
          if (!live) throw new Error(`Session reference "${target}" is released`)
          return generations.get(target)
        },
        // Deliberately never resolves: no caller may treat `ready` as a gate.
        ready: new Promise(() => {}),
        release: () => {
          if (!live) return
          live = false
          calls.releases.push(target)
          const next = (counts.get(target) ?? 1) - 1
          if (next <= 0) {
            counts.delete(target)
            generations.delete(target)
          } else counts.set(target, next)
        },
      }
      return reference
    },
  }
  let remoteResult: { ok: true; value: { sessionId: string; agentPreset?: string } } | { ok: false; error: unknown } = {
    ok: true,
    value: { sessionId: 'session-remote' },
  }
  let remoteCreateHook: (() => void) | undefined
  const remote: RemoteLifecycleSessionRemotes = {
    create: async request => {
      calls.remoteCreates.push(request)
      remoteCreateHook?.()
      return remoteResult
    },
  }
  /** The Host list reconciliation `refresh()` performs: every id the Host
   * published becomes addressable, whether or not the Client recorded it. */
  const reconcile = (): void => {
    if (remoteResult.ok) catalogued.add(remoteResult.value.sessionId)
  }
  const lifecycle = new RemoteSessionLifecycle(sessions, remote, {
    getSnapshot: () => generation,
    subscribe: () => () => {},
  })
  return {
    lifecycle,
    calls,
    sessions,
    bindingOf: (id: string) => generations.get(id),
    setGeneration: (id: number | undefined) => { generation = id === undefined ? undefined : { id } },
    setForkResult: (id: string) => { forkResult = id },
    setForkError: (error: unknown) => { forkError = error },
    setForkHook: (hook: () => void) => { forkHook = hook },
    setRetainError: (error: unknown) => { retainError = error },
    setRefreshError: (error: unknown) => { refreshError = error },
    setRetainHook: (hook: () => void) => { retainHook = hook },
    setRemoteCreateHook: (hook: () => void) => { remoteCreateHook = hook },
    setRemoteResult: (result: typeof remoteResult) => { remoteResult = result },
    setCatalogued: (id: string, present: boolean) => {
      if (present) catalogued.add(id)
      else catalogued.delete(id)
    },
  }
}

test('ordinary create maps explicit cwd to ClientSessions.create', async () => {
  const h = harness()
  const result = await h.lifecycle.create({ sessionId: 'session-a', cwd: '/ws' })
  assert.equal(result.outcome.kind, 'created')
  assert.deepEqual(h.calls.creates, [{ sessionId: 'session-a', cwd: '/ws' }])
  assert.deepEqual(h.calls.remoteCreates, [])
})

test('a current create retains the published Session exactly once for the visible main surface', async () => {
  const h = harness()
  const result = await h.lifecycle.create({ sessionId: 'session-a' })
  assert.equal(result.ownership, 'current')
  assert.equal(result.outcome.kind, 'created')
  assert.deepEqual(h.calls.retains, [{ target: 'session-a', source: 'tuiMainView' }])
  if (result.outcome.kind !== 'created') throw new Error('unreachable')
  const owner = result.outcome.handle.client
  assert.ok(owner !== undefined, 'a Remote create handle must carry its Client generation owner')
  // The token is the exact live binding generation, not a copy or a lookup key.
  assert.equal(owner.bindingIdentity, h.bindingOf('session-a'))
})

test('create does not await the reference ready promise', async () => {
  const h = harness()
  // The harness ready promise never settles; a resolved create proves no gate.
  const result = await h.lifecycle.create({ sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'created')
})

test('create success superseded by a reconnect is a real child without Client ownership', async () => {
  const h = harness()
  h.setGeneration(1)
  const original = h.sessions.create
  h.sessions.create = async options => {
    h.setGeneration(2)
    return original(options)
  }
  const result = await h.lifecycle.create({ sessionId: 'session-a' })
  assert.equal(result.ownership, 'superseded')
  assert.equal(result.outcome.kind, 'created')
  assert.equal(h.calls.retains.length, 0, 'a superseded create must not retain the child')
})

test('create retain failure is published-with-error and never retries creation', async () => {
  const h = harness()
  h.setRetainError(new Error('controller disposed'))
  const result = await h.lifecycle.create({ sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') {
    assert.equal(result.outcome.sessionId, 'session-a')
    assert.equal(result.outcome.error.code, 'session/reconcile-failed')
  }
  assert.equal(h.calls.creates.length, 1, 'a post-publication failure must not re-create')
})

test('same-id release and re-retain yields a different binding generation', async () => {
  const h = harness()
  const first = await h.lifecycle.create({ sessionId: 'session-a' })
  if (first.outcome.kind !== 'created') throw new Error('unreachable')
  const firstOwner = first.outcome.handle.client
  assert.ok(firstOwner !== undefined)
  const firstBinding = h.bindingOf('session-a')
  firstOwner.release()
  const second = await h.lifecycle.open({ sessionId: 'session-a' })
  if (second.outcome.kind !== 'opened') throw new Error('unreachable')
  const secondOwner = second.outcome.handle.client
  assert.ok(secondOwner !== undefined)
  assert.notEqual(h.bindingOf('session-a'), firstBinding,
    'a re-retained same id must be a NEW Client generation')
  assert.notEqual(secondOwner.bindingIdentity, firstOwner.bindingIdentity)
})

test('explicit preset create uses generated session.create, then refresh, then retain', async () => {
  const h = harness()
  h.setRemoteResult({ ok: true, value: { sessionId: 'session-remote' } })
  const result = await h.lifecycle.create({ sessionId: 'session-a', cwd: '/ws', agentPreset: 'minimal' })
  assert.equal(result.outcome.kind, 'created')
  assert.deepEqual(h.calls.remoteCreates, [{ sessionId: 'session-a', cwd: '/ws', agentPreset: 'minimal' }])
  assert.deepEqual(h.calls.creates, [], 'the explicit-preset path must not use ordinary ClientSessions.create')
  assert.equal(h.calls.refreshes, 1, 'the raw create must be reconciled through the public refresh')
  assert.deepEqual(h.calls.retains, [{ target: 'session-remote', source: 'tuiMainView' }],
    'the PUBLISHED id, not the requested id, is retained')
})

test('explicit preset refresh failure preserves the published identity', async () => {
  const h = harness()
  h.setRemoteResult({ ok: true, value: { sessionId: 'session-remote' } })
  h.setRefreshError(new Error('list unavailable'))
  const result = await h.lifecycle.create({ sessionId: 'session-a', agentPreset: 'minimal' })
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') assert.equal(result.outcome.sessionId, 'session-remote')
  assert.equal(h.calls.remoteCreates.length, 1, 'a reconcile failure must not duplicate the Host create')
  assert.deepEqual(h.calls.retains, [])
})

test('explicit preset retain failure preserves the published identity', async () => {
  const h = harness()
  h.setRemoteResult({ ok: true, value: { sessionId: 'session-remote' } })
  h.setRetainError(new Error('unknown session'))
  const result = await h.lifecycle.create({ sessionId: 'session-a', agentPreset: 'minimal' })
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') assert.equal(result.outcome.sessionId, 'session-remote')
  assert.deepEqual(h.calls.retains, [{ target: 'session-remote', source: 'tuiMainView' }])
})

test('explicit preset create superseded before adoption neither refreshes nor retains', async () => {
  const h = harness()
  h.setRemoteResult({ ok: true, value: { sessionId: 'session-remote' } })
  h.setRemoteCreateHook(() => h.setGeneration(2))
  const result = await h.lifecycle.create({ sessionId: 'session-a', agentPreset: 'minimal' })
  assert.equal(result.ownership, 'superseded')
  assert.equal(result.outcome.kind, 'created')
  assert.equal(h.calls.refreshes, 0, 'a superseded create must not reconcile Client state')
  assert.deepEqual(h.calls.retains, [], 'a superseded create must not retain the child')
})

test('explicit preset create reports indeterminate for a malformed success payload', async () => {
  const h = harness()
  h.setRemoteResult({ ok: true, value: { sessionId: '' } })
  const result = await h.lifecycle.create({ sessionId: 'session-a', agentPreset: 'minimal' })
  assert.equal(result.outcome.kind, 'indeterminate')
  if (result.outcome.kind === 'indeterminate') assert.equal(result.outcome.requestedSessionId, 'session-a')
})

test('open acquires the Session through retain and never through a selection verb', async () => {
  const h = harness()
  h.setCatalogued('session-a', true)
  const result = await h.lifecycle.open({ sessionId: 'session-a' })
  assert.equal(result.ownership, 'current')
  assert.equal(result.outcome.kind, 'opened')
  assert.deepEqual(h.calls.retains, [{ target: 'session-a', source: 'tuiMainView' }])
  assert.deepEqual(h.calls.forks, [])
  if (result.outcome.kind !== 'opened') throw new Error('unreachable')
  assert.ok(result.outcome.handle.client !== undefined, 'open must return a client-owned handle')
})

test('open is cancelled before dispatch when the signal is already aborted', async () => {
  const h = harness()
  const controller = new AbortController()
  controller.abort()
  const result = await h.lifecycle.open({ sessionId: 'session-a', signal: controller.signal })
  assert.deepEqual(result, { ownership: 'current', outcome: { kind: 'cancelled' } })
  assert.deepEqual(h.calls.retains, [])
})

test('open reports an unknown identity as unavailable, never as a created Session', async () => {
  const h = harness()
  const result = await h.lifecycle.open({ sessionId: 'session-missing' })
  assert.equal(result.outcome.kind, 'unavailable')
  assert.deepEqual(h.calls.creates, [])
  assert.deepEqual(h.calls.remoteCreates, [])
  // `retain` refuses an unknown identity before any reference exists, so there
  // is nothing to release.
  assert.deepEqual(h.calls.releases, [])
})

test('open on a disconnected client is unavailable without acquisition', async () => {
  const h = harness()
  h.setGeneration(undefined)
  const result = await h.lifecycle.open({ sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'unavailable')
  assert.deepEqual(h.calls.retains, [])
})

test('open releases the new reference when a synchronous subscriber supersedes it', async () => {
  const h = harness()
  h.setCatalogued('session-a', true)
  // `retain` publishes reference counts and may synchronously notify
  // subscribers; a navigation cancelled from that notification is real.
  h.setRetainHook(() => h.setGeneration(2))
  const result = await h.lifecycle.open({ sessionId: 'session-a' })
  assert.deepEqual(result, { ownership: 'superseded', outcome: { kind: 'cancelled' } })
  assert.equal(h.calls.releases.length, 1, 'the superseded acquisition must not leak its reference')
  assert.equal(h.bindingOf('session-a'), undefined, 'no generation may stay live for a superseded open')
})

test('open does not await the reference ready promise', async () => {
  const h = harness()
  h.setCatalogued('session-a', true)
  const result = await h.lifecycle.open({ sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'opened')
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

test('a resolved fork is publication only: no binding is required and none is retained', async () => {
  const h = harness()
  h.setForkResult('session-reconciled')
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.ownership, 'current')
  assert.deepEqual(result.outcome, { kind: 'forked', handle: { session: { id: 'session-reconciled' } } })
  assert.equal(h.calls.forks.length, 1)
  assert.deepEqual(h.calls.retains, [], 'fork publication must never retain the child')
  assert.equal(h.bindingOf('session-reconciled'), undefined,
    'alpha2 does not guarantee a binding for a catalogued fork child')
})

test('a superseded fork child stays real but is never adopted', async () => {
  const h = harness()
  h.setForkHook(() => h.setGeneration(2))
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.ownership, 'superseded')
  assert.equal(result.outcome.kind, 'forked')
  assert.deepEqual(h.calls.retains, [])
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

test('a Remote handle exposes its Client generation owner and no Direct owner', async () => {
  const h = harness()
  const result = await h.lifecycle.create({ sessionId: 'session-a' })
  if (result.outcome.kind !== 'created') throw new Error('unreachable')
  const owner = clientOwnerOf(result.outcome.handle)
  assert.ok(owner !== undefined, 'a Remote handle must expose its Client generation owner')
  assert.equal(owner.bindingIdentity, h.bindingOf('session-a'))
  // The Direct escapes stay undefined so transition code cannot mistake a
  // Remote handle for a live in-process Agent.
  assert.equal(directAgentOf(result.outcome.handle), undefined)
  assert.equal(ownerHandleOf(result.outcome.handle), undefined)
})

test('adopting a fork child whose retain fails does not duplicate the fork', async () => {
  const h = harness()
  const forkResult = await h.lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(forkResult.outcome.kind, 'forked')
  const childId = forkResult.outcome.kind === 'forked' ? forkResult.outcome.handle.session.id : undefined
  assert.ok(childId !== undefined)
  // The child is catalogued but the Client generation cannot be acquired.
  h.setRetainError(new Error('unknown session'))
  const adopted = await h.lifecycle.open({ sessionId: childId })
  assert.equal(adopted.outcome.kind, 'unavailable')
  assert.equal(h.calls.forks.length, 1, 'a failed adoption must never re-dispatch the Host fork')
  assert.equal(h.calls.retains.length, 1, 'only the adoption attempted a retain')
})

test('a create superseded by a synchronous retain subscriber releases the new owner', async () => {
  const h = harness()
  // `retain` can synchronously notify a subscriber that supersedes navigation.
  h.setRetainHook(() => h.setGeneration(2))
  const result = await h.lifecycle.create({ sessionId: 'session-a' })
  assert.equal(result.ownership, 'superseded')
  assert.equal(result.outcome.kind, 'created')
  if (result.outcome.kind !== 'created') throw new Error('unreachable')
  assert.equal(result.outcome.handle.client, undefined, 'a superseded create must not hand back a Client owner')
  assert.deepEqual(h.calls.releases, ['session-a'], 'the superseded acquisition releases exactly once')
  assert.equal(h.bindingOf('session-a'), undefined, 'no generation may stay live for a superseded create')
})

test('an explicit-preset create superseded by a synchronous retain subscriber releases the new owner', async () => {
  const h = harness()
  h.setRemoteResult({ ok: true, value: { sessionId: 'session-remote' } })
  h.setRetainHook(() => h.setGeneration(2))
  const result = await h.lifecycle.create({ sessionId: 'session-a', agentPreset: 'minimal' })
  assert.equal(result.ownership, 'superseded')
  assert.equal(result.outcome.kind, 'created')
  if (result.outcome.kind !== 'created') throw new Error('unreachable')
  assert.equal(result.outcome.handle.client, undefined)
  assert.deepEqual(h.calls.releases, ['session-remote'], 'the superseded acquisition releases exactly once')
})

test('a retain refused after a supersession reports published-with-error + superseded', async () => {
  const h = harness()
  h.setRetainHook(() => h.setGeneration(2))
  h.setRetainError(new Error('controller disposed'))
  const result = await h.lifecycle.create({ sessionId: 'session-a' })
  assert.equal(result.ownership, 'superseded', 'a post-publication failure is never labelled current once superseded')
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') assert.equal(result.outcome.sessionId, 'session-a')
  assert.deepEqual(h.calls.releases, [], 'a refused retain created no reference to release')
})

test('a retain refused by a synchronous abort is superseded, never current', async () => {
  const h = harness()
  const controller = new AbortController()
  h.setRetainHook(() => controller.abort())
  const result = await h.lifecycle.create({ sessionId: 'session-a', signal: controller.signal })
  assert.equal(result.ownership, 'superseded')
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') assert.equal(result.outcome.sessionId, 'session-a')
  assert.deepEqual(h.calls.releases, [])
})
