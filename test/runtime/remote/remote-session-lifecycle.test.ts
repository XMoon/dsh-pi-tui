/**
 * Contract tests for the Remote SessionLifecycle adapter under the rc.2
 * explicit-reference Client contract: ONE official Client create for ordinary
 * and preset creates alike, open-as-retain, and publication-only fork that
 * passes `allowMigration:false` (never an implicit migration).
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteSessionLifecycle,
  type RemoteLifecycleSessions,
  type RemoteWorkspaceNamespaceLike,
  type RemoteWorkspaceViewLike,
} from '../../../src/runtime/remote/session-lifecycle-remote.ts'
import type { RemoteReadResult } from '../../../src/runtime/remote/session-reader-remote.ts'
import type { RemoteSessionReferenceLike, TuiSessionReferenceSource } from '../../../src/runtime/remote/session-reference.ts'
import { clientOwnerOf, directAgentOf, ownerHandleOf, WorkspaceSelectionError } from '../../../src/runtime/session-lifecycle-port.ts'

interface RetainCall {
  readonly target: string
  readonly source: TuiSessionReferenceSource
}

/** A faithful model of the rc.2 Client reference lifetime: a binding
 * generation exists only while at least one reference is retained, and a
 * same-id re-retain after full release yields a NEW binding object. */
function harness() {
  const calls = {
    creates: [] as unknown[],
    forks: [] as unknown[],
    retains: [] as RetainCall[],
    releases: [] as string[],
    workspaceCreates: [] as string[],
    follows: 0,
    followDisposals: 0,
    sessionLists: 0,
  }
  const catalogued = new Set<string>()
  const generations = new Map<string, {
    readonly id: string
    readonly session: {
      getSnapshot(): { readonly openState: 'cold' | 'loading' | 'open' | 'error' | undefined; readonly openError: unknown }
    }
  }>()
  const counts = new Map<string, number>()
  let generation: { id: number } | undefined = { id: 1 }
  let createResult: string | undefined
  let createError: unknown
  let createHook: (() => void) | undefined
  let forkResult = 'session-child'
  let forkError: unknown
  let forkHook: (() => void) | undefined
  let retainError: unknown
  let retainHook: (() => void) | undefined
  /** The official initial-open settlement the fake reference exposes. `ready`
   *  is independent from the open state: the real Client RESOLVES ready even
   *  when `doOpen` records `openState: 'error'`. */
  let openState: 'cold' | 'loading' | 'open' | 'error' | undefined = 'open'
  let openError: unknown
  let readyMode: 'resolve' | 'hold' = 'resolve'
  let resolveReady: (() => void) | undefined
  let rejectReady: ((error: unknown) => void) | undefined
  let workspaceRows: RemoteWorkspaceViewLike[] = []
  let workspaceCreateReply: RemoteReadResult<{ readonly workspace: RemoteWorkspaceViewLike; readonly created: boolean }> | undefined
  let workspaceCreateFailure: unknown
  let workspaceCreateHook: (() => void) | undefined
  let followFrames: Array<{ readonly type: string; readonly value?: { readonly items: readonly RemoteWorkspaceViewLike[] } }> | undefined
  let followFailure: unknown
  let followHook: (() => void) | undefined
  let sessionListRows: { readonly sessionId: string; readonly cwd?: string }[] = []
  let sessionListReply: RemoteReadResult<{ readonly items: readonly { readonly sessionId: string; readonly cwd?: string }[] }> | undefined
  let sessionListFailure: unknown
  let sessionListHook: (() => void) | undefined
  const sessions: RemoteLifecycleSessions = {
    create: async (options = {}) => {
      calls.creates.push(options)
      createHook?.()
      if (createError !== undefined) throw createError
      // The Host owns the returned identity: a blank reuse returns the named
      // id, a nonblank create allocates another one.
      const id = createResult ?? String(options.sessionId)
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
    retain: (target, options) => {
      // This adapter only ever addresses plain Session ids; the structural
      // official target union also allows a durable subagent address.
      if (typeof target !== 'string') throw new Error('remote session lifecycle must address a plain Session id')
      calls.retains.push({ target, source: options.source })
      retainHook?.()
      options.signal?.throwIfAborted()
      if (retainError !== undefined) throw retainError
      if (!catalogued.has(target)) throw new Error(`sessions.retain: unknown session ${target}`)
      counts.set(target, (counts.get(target) ?? 0) + 1)
      if (!generations.has(target)) {
        generations.set(target, {
          id: target,
          session: { getSnapshot: () => ({ openState, openError }) },
        })
      }
      let live = true
      const ready = new Promise<unknown>((resolve, reject) => {
        if (readyMode === 'resolve') {
          resolve(undefined)
          return
        }
        resolveReady = () => { resolve(undefined) }
        rejectReady = reject
      })
      const abortSignal = options.signal
      if (abortSignal !== undefined) {
        if (abortSignal.aborted) {
          rejectReady?.(abortSignal.reason)
        } else {
          abortSignal.addEventListener('abort', () => { rejectReady?.(abortSignal.reason) }, { once: true })
        }
      }
      // The official reference swallows its readiness rejection itself; a
      // create that never awaits ready must not turn it into an unhandled one.
      ready.catch(() => {})
      const reference: RemoteSessionReferenceLike = {
        sessionId: target,
        get binding() {
          if (!live) throw new Error(`Session reference "${target}" is released`)
          return generations.get(target)
        },
        ready,
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
  // WS-2 Finding 1: the historical-header fallback reads the OFFICIAL Host
  // Session list DIRECTLY, so a failed pull can never fall back to a cached row
  // (the Client list store carries no pull-failure bit).
  const sessionList = {
    list: async () => {
      calls.sessionLists += 1
      sessionListHook?.()
      if (sessionListFailure !== undefined) throw sessionListFailure
      if (sessionListReply !== undefined) return sessionListReply
      return { ok: true as const, value: { items: sessionListRows } }
    },
  }
  const workspace: RemoteWorkspaceNamespaceLike = {
    create: async (request) => {
      calls.workspaceCreates.push(request.path)
      workspaceCreateHook?.()
      if (workspaceCreateFailure !== undefined) throw workspaceCreateFailure
      if (workspaceCreateReply !== undefined) return workspaceCreateReply
      const existing = workspaceRows.find(row => row.path === request.path)
      if (existing !== undefined) return { ok: true, value: { workspace: existing, created: false } }
      const created = { workspaceId: `ws-${workspaceRows.length + 1}`, path: request.path, title: request.path, sessionIds: [] }
      workspaceRows.push(created)
      return { ok: true, value: { workspace: created, created: true } }
    },
    follow: (signal) => {
      calls.follows += 1
      const frames = followFrames ?? [{ type: 'baseline', value: { items: workspaceRows } }]
      let disposed = false
      const iterator = (async function* () {
        signal?.throwIfAborted()
        for (const frame of frames) {
          followHook?.()
          yield frame
        }
        if (followFailure !== undefined) throw followFailure
      })()
      return {
        [Symbol.asyncIterator]: () => iterator,
        dispose: () => {
          if (disposed) return
          disposed = true
          calls.followDisposals += 1
        },
      }
    },
  }
  const lifecycle = new RemoteSessionLifecycle(sessions, {
    getSnapshot: () => generation,
    subscribe: () => () => {},
  }, workspace, sessionList)
  return {
    lifecycle,
    calls,
    sessions,
    bindingOf: (id: string) => generations.get(id),
    setGeneration: (id: number | undefined) => { generation = id === undefined ? undefined : { id } },
    setCreateResult: (id: string | undefined) => { createResult = id },
    setCreateError: (error: unknown) => { createError = error },
    setCreateHook: (hook: () => void) => { createHook = hook },
    setForkResult: (id: string) => { forkResult = id },
    setForkError: (error: unknown) => { forkError = error },
    setForkHook: (hook: () => void) => { forkHook = hook },
    setRetainError: (error: unknown) => { retainError = error },
    setRetainHook: (hook: () => void) => { retainHook = hook },
    /** Hold the next reference's `ready` until resolved/rejected by the test. */
    setReadyHold: () => { readyMode = 'hold' },
    resolveReady: () => { resolveReady?.() },
    rejectReadyWith: (error: unknown) => { rejectReady?.(error) },
    /** The official open settlement the retained generation reports. */
    setOpenState: (state: 'cold' | 'loading' | 'open' | 'error' | undefined, error?: unknown) => {
      openState = state
      openError = error
    },
    setCatalogued: (id: string, present: boolean) => {
      if (present) catalogued.add(id)
      else catalogued.delete(id)
    },
    setWorkspaceRows: (rows: RemoteWorkspaceViewLike[]) => { workspaceRows = rows },
    setWorkspaceCreateReply: (reply: typeof workspaceCreateReply) => { workspaceCreateReply = reply },
    setWorkspaceCreateFailure: (error: unknown) => { workspaceCreateFailure = error },
    setWorkspaceCreateHook: (hook: () => void) => { workspaceCreateHook = hook },
    setFollowFrames: (frames: typeof followFrames) => { followFrames = frames },
    setFollowFailure: (error: unknown) => { followFailure = error },
    setFollowHook: (hook: () => void) => { followHook = hook },
    setSessionListRows: (rows: { readonly sessionId: string; readonly cwd?: string }[]) => { sessionListRows = rows },
    setSessionListReply: (reply: typeof sessionListReply) => { sessionListReply = reply },
    setSessionListFailure: (error: unknown) => { sessionListFailure = error },
    setSessionListHook: (hook: () => void) => { sessionListHook = hook },
  }
}

test('ordinary create names the official WorkspaceId on the one official ClientSessions.create', async () => {
  const h = harness()
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'created')
  assert.deepEqual(h.calls.creates, [{ workspaceId: 'ws-a', sessionId: 'session-a' }])
})

test('an explicit preset rides the SAME single official ClientSessions.create call', async () => {
  const h = harness()
  h.setCreateResult('session-remote')
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a', agentPreset: 'minimal' })
  assert.equal(result.outcome.kind, 'created')
  assert.deepEqual(h.calls.creates,
    [{ workspaceId: 'ws-a', sessionId: 'session-a', agentPreset: 'minimal' }],
    'rc.2 ClientSessions.create accepts agentPreset atomically; there is no raw session.create path')
  assert.deepEqual(h.calls.retains, [{ target: 'session-remote', source: 'tuiMainView' }],
    'the PUBLISHED id, not the requested id, is retained')
})

test('create adopts the Host-returned identity, never the requested correlation id', async () => {
  const h = harness()
  h.setCreateResult('session-host-chosen')
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-requested' })
  assert.equal(result.outcome.kind, 'created')
  if (result.outcome.kind !== 'created') throw new Error('unreachable')
  assert.equal(result.outcome.handle.session.id, 'session-host-chosen')
  assert.equal(h.bindingOf('session-requested'), undefined, 'the requested id is correlation only')
  assert.ok(h.bindingOf('session-host-chosen') !== undefined, 'the returned id is the retained generation')
})

test('a blank reuse returns the reused id and still retains exactly once', async () => {
  const h = harness()
  // A blank reuse: the Host returns the named id it reused.
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-blank' })
  assert.equal(result.outcome.kind, 'created')
  assert.deepEqual(h.calls.creates, [{ workspaceId: 'ws-a', sessionId: 'session-blank' }])
  assert.deepEqual(h.calls.retains, [{ target: 'session-blank', source: 'tuiMainView' }])
})

test('a current create retains the published Session exactly once for the visible main surface', async () => {
  const h = harness()
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
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
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
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
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
  assert.equal(result.ownership, 'superseded')
  assert.equal(result.outcome.kind, 'created')
  assert.equal(h.calls.retains.length, 0, 'a superseded create must not retain the child')
})

test('create retain failure is published-with-error and never retries creation', async () => {
  const h = harness()
  h.setRetainError(new Error('controller disposed'))
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') {
    assert.equal(result.outcome.sessionId, 'session-a')
    assert.equal(result.outcome.error.code, 'session/reconcile-failed')
  }
  assert.equal(h.calls.creates.length, 1, 'a post-publication failure must not re-create')
})

test('a preset create failure is classified by the SAME proven-code policy', async () => {
  const h = harness()
  h.setCreateError({ rpcError: { code: 'agent-preset/not-found', message: 'unknown preset' } })
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a', agentPreset: 'missing' })
  assert.equal(result.outcome.kind, 'rejected')
  if (result.outcome.kind === 'rejected') assert.equal(result.outcome.error.code, 'agent-preset/not-found')
  assert.equal(h.calls.creates.length, 1, 'a proven refusal must never be resent')
})

test('a create failure with a proven published identity is published-with-error', async () => {
  const h = harness()
  h.setCreateError({
    rpcError: {
      code: 'session/workspace-attach-failed',
      message: 'attach failed',
      details: { sessionId: 'session-published' },
    },
  })
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') assert.equal(result.outcome.sessionId, 'session-published')
})

test('an unproven create failure stays indeterminate with the requested id as correlation', async () => {
  const h = harness()
  h.setCreateError(new Error('socket closed'))
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'indeterminate')
  if (result.outcome.kind === 'indeterminate') assert.equal(result.outcome.requestedSessionId, 'session-a')
  assert.equal(h.calls.creates.length, 1, 'an indeterminate create must never be retried')
})

test('same-id release and re-retain yields a different binding generation', async () => {
  const h = harness()
  const first = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
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

test('create is a pre-dispatch cancellation on a disconnected client', async () => {
  const h = harness()
  h.setGeneration(undefined)
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
  assert.deepEqual(result, { ownership: 'current', outcome: { kind: 'cancelled' } })
  assert.deepEqual(h.calls.creates, [])
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

test('open does not report opened before the initial history open settles', async () => {
  const h = harness()
  h.setCatalogued('session-a', true)
  h.setReadyHold()
  let settled = false
  const pending = h.lifecycle.open({ sessionId: 'session-a' }).then((result) => {
    settled = true
    return result
  })
  // Let the retained reference's pending readiness win any microtask race.
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(settled, false, 'retain alone is not a successful open')
  h.resolveReady()
  assert.equal((await pending).outcome.kind, 'opened')
})

test('open reports opened+superseded when the generation is lost after a real open settles', async () => {
  const h = harness()
  h.setCatalogued('session-a', true)
  h.setReadyHold()
  const pending = h.lifecycle.open({ sessionId: 'session-a' })
  h.resolveReady()
  h.setGeneration(2)
  const result = await pending
  assert.deepEqual(result, {
    ownership: 'superseded',
    outcome: { kind: 'opened', handle: { session: { id: 'session-a' } } },
  }, 'an official open that already reached open is not a proven non-execution')
  assert.equal(h.calls.releases.length, 1, 'the superseded reference is released exactly once')
  assert.equal(h.bindingOf('session-a'), undefined, 'no superseded generation leaks')
})

test('open reports an official history-open error as unavailable and releases exactly once', async () => {
  const h = harness()
  h.setCatalogued('session-a', true)
  // The real Client RESOLVES ready after `doOpen` records the error.
  h.setOpenState('error', {
    code: 'session/format-unsupported',
    message: 'the generation cannot be promoted',
  })
  const result = await h.lifecycle.open({ sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'unavailable')
  if (result.outcome.kind === 'unavailable') {
    assert.match(result.outcome.message, /failed to open/u)
    assert.match(result.outcome.message, /cannot be promoted/u,
      'the official openError is carried, not replaced by a generic message')
  }
  assert.equal(h.calls.releases.length, 1, 'the failed generation is released exactly once')
  assert.equal(h.bindingOf('session-a'), undefined, 'no leaked generation after a failed open')
})

test('a resync whose old ready wins is fail-closed, never a committed open', async () => {
  // The official `Session.configureSubagent()` address replacement calls
  // `resync()`: it invalidates the old open, sets the SAME binding to `cold`
  // and starts a new open (`loading`). The OLD reference.ready can resolve
  // first, so "not error" is not enough to commit.
  for (const state of ['cold', 'loading'] as const) {
    const h = harness()
    h.setCatalogued('session-a', true)
    h.setReadyHold()
    const pending = h.lifecycle.open({ sessionId: 'session-a' })
    h.setOpenState(state)
    h.resolveReady()
    const result = await pending
    assert.equal(result.outcome.kind, 'unavailable', `a ${state} history must not be opened`)
    if (result.outcome.kind === 'unavailable') {
      assert.match(result.outcome.message, new RegExp(`not settled \\(state: ${state}\\)`, 'u'))
    }
    assert.equal(h.calls.releases.length, 1, `the ${state} stale generation is released exactly once`)
    assert.equal(h.bindingOf('session-a'), undefined, `no ${state} generation leaks`)
  }
})

test('open fails closed when the official open state is absent', async () => {
  const h = harness()
  h.setCatalogued('session-a', true)
  h.setOpenState(undefined)
  const result = await h.lifecycle.open({ sessionId: 'session-a' })
  assert.equal(result.outcome.kind, 'unavailable',
    'a structural binding without the official state is never accepted')
  if (result.outcome.kind === 'unavailable') {
    assert.match(result.outcome.message, /open state is unavailable/u)
  }
  assert.equal(h.calls.releases.length, 1)
  assert.equal(h.bindingOf('session-a'), undefined)
})

test('open reports a rejected readiness as unavailable and releases exactly once', async () => {
  const h = harness()
  h.setCatalogued('session-a', true)
  h.setReadyHold()
  const pending = h.lifecycle.open({ sessionId: 'session-a' })
  h.rejectReadyWith(new Error('history read failed'))
  const result = await pending
  assert.equal(result.outcome.kind, 'unavailable')
  if (result.outcome.kind === 'unavailable') assert.match(result.outcome.message, /history read failed/u)
  assert.equal(h.calls.releases.length, 1)
  assert.equal(h.bindingOf('session-a'), undefined)
})

test('a Connection rollover while open waits for readiness reports opened+superseded and releases once', async () => {
  const h = harness()
  h.setCatalogued('session-a', true)
  h.setReadyHold()
  const pending = h.lifecycle.open({ sessionId: 'session-a' })
  h.setGeneration(2)
  h.resolveReady()
  assert.deepEqual(await pending, {
    ownership: 'superseded',
    outcome: { kind: 'opened', handle: { session: { id: 'session-a' } } },
  }, 'the official open may have reached open before currentness was lost')
  assert.equal(h.calls.releases.length, 1)
  assert.equal(h.bindingOf('session-a'), undefined)
})

test('an abort before the official open settles is superseded and releases once', async () => {
  const h = harness()
  h.setCatalogued('session-a', true)
  h.setOpenState('cold')
  h.setReadyHold()
  const controller = new AbortController()
  const pending = h.lifecycle.open({ sessionId: 'session-a', signal: controller.signal })
  controller.abort()
  assert.deepEqual(await pending, { ownership: 'superseded', outcome: { kind: 'cancelled' } })
  assert.equal(h.calls.releases.length, 1)
  assert.equal(h.bindingOf('session-a'), undefined)
})

test('an abort after the official open settled but before continuation is opened+superseded', async () => {
  const h = harness()
  h.setCatalogued('session-a', true)
  h.setReadyHold()
  h.setOpenState('open')
  const controller = new AbortController()
  const pending = h.lifecycle.open({ sessionId: 'session-a', signal: controller.signal })
  h.resolveReady()
  controller.abort()
  assert.deepEqual(await pending, {
    ownership: 'superseded',
    outcome: { kind: 'opened', handle: { session: { id: 'session-a' } } },
  }, 'an official open that already reached open is not a proven non-execution')
  assert.equal(h.calls.releases.length, 1, 'the aborted-opened reference is released exactly once')
  assert.equal(h.bindingOf('session-a'), undefined)
})

test('fork refuses implicit migration and maps only source session plus the optional exact event cut', async () => {
  const h = harness()
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 42 })
  assert.equal(result.ownership, 'current')
  assert.equal(result.outcome.kind, 'forked')
  assert.deepEqual(h.calls.forks, [{ sessionId: 'session-source', atSeq: 42, allowMigration: false }])
  // No local seed construction: the forwarded payload carries only the official
  // fields — the Host owns the cut, seed, repair and child identity.
  assert.deepEqual(h.calls.forks.map(payload => Object.keys(payload).sort()),
    [['allowMigration', 'atSeq', 'sessionId']])
  assert.deepEqual(h.calls.creates, [])
})

test('fork omits atSeq rather than encoding an empty prefix', async () => {
  const h = harness()
  await h.lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.deepEqual(h.calls.forks, [{ sessionId: 'session-source', allowMigration: false }])
})

test('non-canonical fork cuts are rejected before Client dispatch', async () => {
  const h = harness()
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source', atSeq: 0.5 })
  assert.equal(result.outcome.kind, 'rejected')
  assert.deepEqual(h.calls.forks, [])
})

test('an official migration-required fork refusal is rejected and never retried', async () => {
  const h = harness()
  h.setForkError({ rpcError: { code: 'session/migration-required', message: 'open the source Session first' } })
  const result = await h.lifecycle.fork({ sourceSessionId: 'session-source' })
  assert.equal(result.outcome.kind, 'rejected')
  assert.equal(h.calls.forks.length, 1)
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
    'rc.2 does not guarantee a binding for a catalogued fork child')
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
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
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
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
  assert.equal(result.ownership, 'superseded')
  assert.equal(result.outcome.kind, 'created')
  if (result.outcome.kind !== 'created') throw new Error('unreachable')
  assert.equal(result.outcome.handle.client, undefined, 'a superseded create must not hand back a Client owner')
  assert.deepEqual(h.calls.releases, ['session-a'], 'the superseded acquisition releases exactly once')
  assert.equal(h.bindingOf('session-a'), undefined, 'no generation may stay live for a superseded create')
})

test('a preset create superseded by a synchronous retain subscriber releases the new owner', async () => {
  const h = harness()
  h.setCreateResult('session-remote')
  h.setRetainHook(() => h.setGeneration(2))
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a', agentPreset: 'minimal' })
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
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
  assert.equal(result.ownership, 'superseded', 'a post-publication failure is never labelled current once superseded')
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') assert.equal(result.outcome.sessionId, 'session-a')
  assert.deepEqual(h.calls.releases, [], 'a refused retain created no reference to release')
})

test('a retain refused by a synchronous abort is superseded, never current', async () => {
  const h = harness()
  const controller = new AbortController()
  h.setRetainHook(() => controller.abort())
  const result = await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a', signal: controller.signal })
  assert.equal(result.ownership, 'superseded')
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind === 'published-with-error') assert.equal(result.outcome.sessionId, 'session-a')
  assert.deepEqual(h.calls.releases, [])
})

// ── WS-2: Host Workspace pre-selection ─────────────────────────────────────

function workspaceRow(overrides: Partial<RemoteWorkspaceViewLike> = {}): RemoteWorkspaceViewLike {
  return { workspaceId: 'ws-a', path: '/host/a', title: 'a', sessionIds: [], ...overrides }
}

test('resolveWorkspace(host-path) adopts the Host canonical directory through the official workspace.create', async () => {
  const h = harness()
  h.setWorkspaceCreateReply({
    ok: true,
    value: { workspace: workspaceRow({ workspaceId: 'ws-canonical', path: '/host/canonical' }), created: true },
  })
  const resolved = await h.lifecycle.resolveWorkspace({ kind: 'host-path', path: '/client/proposal' })
  assert.deepEqual(resolved, { workspaceId: 'ws-canonical', path: '/host/canonical' },
    'the HOST canonical path is returned, never the Client proposal')
  assert.deepEqual(h.calls.workspaceCreates, ['/client/proposal'])
  assert.deepEqual(h.calls.creates, [], 'pre-selection publishes no Session')
})

test('resolveWorkspace(host-path) refuses a Host invalid-path reply and dispatches nothing', async () => {
  const h = harness()
  h.setWorkspaceCreateReply({ ok: false, error: { code: 'workspace/invalid-path', message: 'cannot create a Workspace at "/missing": ENOENT' } })
  const error = await h.lifecycle.resolveWorkspace({ kind: 'host-path', path: '/missing' })
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(error instanceof WorkspaceSelectionError)
  assert.equal(error.kind, 'refused')
  assert.equal(error.code, 'workspace/invalid-path')
  assert.deepEqual(h.calls.creates, [])
})

test('a workspace create whose reply is lost is unavailable and dispatches no Session', async () => {
  const h = harness()
  // WS2-10: the Host may have committed the Workspace, but the Client cannot
  // prove its identity. That is `unavailable` — never a fabricated Workspace id,
  // never an empty result, and zero Session dispatch.
  h.setWorkspaceCreateFailure({ code: 'gateway/internal', message: 'carrier lost after dispatch' })
  const error = await h.lifecycle.resolveWorkspace({ kind: 'host-path', path: '/client/proposal' })
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(error instanceof WorkspaceSelectionError)
  assert.equal(error.kind, 'unavailable')
  assert.deepEqual(h.calls.creates, [], 'an unprovable Workspace never dispatches a Session')
  assert.deepEqual(h.calls.workspaceCreates, ['/client/proposal'], 'exactly one Host create was attempted, with no retry')
})

test('F2: a Host workspace-create failure never echoes the proposed path or the raw detail', async () => {
  const refused = harness()
  refused.setWorkspaceCreateReply({
    ok: false,
    error: { code: 'workspace/invalid-path', message: 'cannot create a Workspace at "/private/secret/project": EACCES' },
  })
  const refusedError = await refused.lifecycle.resolveWorkspace({ kind: 'host-path', path: '/private/secret/project' })
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(refusedError instanceof WorkspaceSelectionError)
  assert.equal(refusedError.kind, 'refused')
  assert.equal(refusedError.code, 'workspace/invalid-path', 'the official business code is preserved')
  assert.equal(refusedError.message, 'the Host refused the proposed workspace directory')
  assert.equal(refusedError.message.includes('/private/secret'), false)
  assert.equal(refusedError.message.includes('cannot create a Workspace'), false)
  assert.deepEqual(refused.calls.creates, [])

  const unavailable = harness()
  unavailable.setWorkspaceCreateReply({
    ok: false,
    error: { code: 'gateway/internal', message: 'carrier lost while reading /private/secret/project' },
  })
  const unavailableError = await unavailable.lifecycle.resolveWorkspace({ kind: 'host-path', path: '/private/secret/project' })
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(unavailableError instanceof WorkspaceSelectionError)
  assert.equal(unavailableError.kind, 'unavailable')
  assert.equal(unavailableError.code, 'gateway/internal')
  assert.equal(unavailableError.message, 'the Host Workspace state is unavailable')
  assert.equal(unavailableError.message.includes('/private/secret'), false)
})

test('resolveWorkspace(workspace-id) reads exactly one follow baseline and refuses an unknown identity', async () => {
  const h = harness()
  h.setWorkspaceRows([workspaceRow({ workspaceId: 'ws-a', path: '/host/a' })])
  assert.deepEqual(await h.lifecycle.resolveWorkspace({ kind: 'workspace-id', workspaceId: 'ws-a' }),
    { workspaceId: 'ws-a', path: '/host/a' })
  assert.equal(h.calls.follows, 1, 'each pre-selection opens its own generation')
  assert.equal(h.calls.followDisposals, 1, 'the stream handle is disposed exactly once')

  const error = await h.lifecycle.resolveWorkspace({ kind: 'workspace-id', workspaceId: 'ws-gone' })
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(error instanceof WorkspaceSelectionError)
  assert.equal(error.kind, 'refused', 'an absent Workspace is a Host refusal, not an empty list')
  assert.equal(error.code, 'workspace/not-found')
  assert.equal(h.calls.follows, 2)
  assert.equal(h.calls.followDisposals, 2)
})

test('resolveWorkspace(source-session) uses official membership FIRST, never the Host list row', async () => {
  const h = harness()
  h.setWorkspaceRows([workspaceRow({ workspaceId: 'ws-member', path: '/host/member', sessionIds: ['session-a'] })])
  h.setSessionListRows([{ sessionId: 'session-a', cwd: '/host/status-only' }])
  assert.deepEqual(await h.lifecycle.resolveWorkspace({ kind: 'source-session', sessionId: 'session-a' }),
    { workspaceId: 'ws-member', path: '/host/member' })
  assert.equal(h.calls.sessionLists, 0, 'membership-first never reads the Host Session list')
  assert.deepEqual(h.calls.workspaceCreates, [])
})

test('resolveWorkspace(source-session) falls back to the persisted immutable header directory', async () => {
  const h = harness()
  h.setWorkspaceRows([])
  h.setSessionListRows([{ sessionId: 'session-a', cwd: '/host/old-project' }])
  const resolved = await h.lifecycle.resolveWorkspace({ kind: 'source-session', sessionId: 'session-a' })
  assert.deepEqual(resolved, { workspaceId: 'ws-1', path: '/host/old-project' })
  assert.equal(h.calls.sessionLists, 1, 'exactly one official Host Session-list read')
  assert.deepEqual(h.calls.workspaceCreates, ['/host/old-project'],
    'the header directory is only a Host path proposal')
})

test('resolveWorkspace(source-session) without a listed header cwd is unavailable and adopts nothing', async () => {
  const h = harness()
  h.setWorkspaceRows([])
  h.setSessionListRows([])
  const absent = await h.lifecycle.resolveWorkspace({ kind: 'source-session', sessionId: 'session-a' })
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(absent instanceof WorkspaceSelectionError)
  assert.equal(absent.kind, 'unavailable')
  assert.deepEqual(h.calls.workspaceCreates, [], 'no Workspace is created from an absent header cwd')

  h.setSessionListRows([{ sessionId: 'session-a' }])
  const noCwd = await h.lifecycle.resolveWorkspace({ kind: 'source-session', sessionId: 'session-a' })
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(noCwd instanceof WorkspaceSelectionError)
  assert.equal(noCwd.kind, 'unavailable', 'a row without a Host header cwd is never a Client guess')
})

test('F1: a failed Host Session-list read never falls back to a cached header cwd', async () => {
  // The official Client list STORE drops the pull state, so its cached row is
  // indistinguishable from a fresh one. The pre-selection must read the Host
  // directly and refuse when that read fails: zero Workspace create, zero
  // Session create, no old-Turn stop.
  for (const failure of [
    { reply: { ok: false as const, error: { code: 'gateway/internal', message: 'session list exploded at /private/secret' } } },
    { thrown: new Error('carrier lost at /private/secret') },
  ]) {
    const h = harness()
    h.setWorkspaceRows([])
    h.setSessionListRows([{ sessionId: 'session-a', cwd: '/host/cached-old' }])
    if ('reply' in failure) h.setSessionListReply(failure.reply)
    else h.setSessionListFailure(failure.thrown)
    const error = await h.lifecycle.resolveWorkspace({ kind: 'source-session', sessionId: 'session-a' })
      .then(() => undefined, (thrown: unknown) => thrown)
    assert.ok(error instanceof WorkspaceSelectionError)
    assert.equal(error.kind, 'unavailable')
    assert.equal(error.message.includes('/private/secret'), false, 'the raw Host failure never reaches the user text')
    assert.deepEqual(h.calls.workspaceCreates, [], 'a failed Host read authorizes no Workspace')
    assert.deepEqual(h.calls.creates, [], 'a failed Host read dispatches no Session')
  }
})

test('a follow stream that never yields its baseline is unavailable, never an empty Workspace set', async () => {
  const h = harness()
  h.setFollowFrames([{ type: 'upsert' }])
  const malformed = await h.lifecycle.resolveWorkspace({ kind: 'workspace-id', workspaceId: 'ws-a' })
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(malformed instanceof WorkspaceSelectionError)
  assert.equal(malformed.kind, 'unavailable')
  assert.equal(h.calls.followDisposals, 1)

  h.setFollowFrames([])
  h.setFollowFailure({ code: 'gateway/internal', message: 'carrier lost' })
  const failed = await h.lifecycle.resolveWorkspace({ kind: 'workspace-id', workspaceId: 'ws-a' })
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(failed instanceof WorkspaceSelectionError)
  assert.equal(failed.kind, 'unavailable')
  assert.equal(h.calls.followDisposals, 2, 'the failed stream is disposed exactly once')
})

test('a Connection generation replaced during the pre-selection is superseded and creates no Session', async () => {
  const h = harness()
  h.setWorkspaceCreateHook(() => h.setGeneration(2))
  const create = await h.lifecycle.resolveWorkspace({ kind: 'host-path', path: '/client/proposal' })
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(create instanceof WorkspaceSelectionError)
  assert.equal(create.kind, 'superseded')

  const follows = harness()
  follows.setFollowHook(() => follows.setGeneration(2))
  const follow = await follows.lifecycle.resolveWorkspace({ kind: 'workspace-id', workspaceId: 'ws-a' })
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(follow instanceof WorkspaceSelectionError)
  assert.equal(follow.kind, 'superseded')
  assert.deepEqual(follows.calls.creates, [])
})

test('a pre-selection on a disconnected Client is unavailable', async () => {
  const h = harness()
  h.setGeneration(undefined)
  const error = await h.lifecycle.resolveWorkspace({ kind: 'host-path', path: '/client/proposal' })
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(error instanceof WorkspaceSelectionError)
  assert.equal(error.kind, 'unavailable')
  assert.deepEqual(h.calls.workspaceCreates, [])
})

test('the WorkspaceId is the ONLY directory argument on the create RPC', async () => {
  const h = harness()
  await h.lifecycle.create({ workspaceId: 'ws-a', sessionId: 'session-a' })
  const request = h.calls.creates[0] as Record<string, unknown>
  assert.equal(request.workspaceId, 'ws-a')
  assert.equal('cwd' in request, false, 'no cwd may ever ride a WorkspaceId create')
})
