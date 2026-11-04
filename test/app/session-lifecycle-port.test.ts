/**
 * Adapter contract tests for the Direct session lifecycle
 * (runtime/direct/session-lifecycle-direct.ts, migration M1.5/D2.3): the port
 * is the semantic boundary — the runner depends on `SessionLifecycle`, the
 * Direct adapter owns the `ctx.agents` access, the preset composition AND the
 * Direct-only activation/preset lookups (converting the semantic request into
 * the Direct setup callback), and a Remote adapter must satisfy the SAME
 * contract. These tests pin the contract with a fake Host context, so the two
 * backends cannot drift.
 *
 * WS-2 adds the Host Workspace pre-selection: create names an official
 * WorkspaceId (never a `cwd`), the Host registry is the ONLY Workspace
 * authority, and a published-but-unattachable Session keeps its identity while
 * its live owner handle is handed to the existing owner lifetime.
 * @module @xmoon76/dsh-pi-tui/session-lifecycle-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSessionLifecycle, type HostContextLike, type WorkspaceRegistryLike } from '../../src/runtime/direct/session-lifecycle-direct.ts'
import {
  LifecycleError,
  ownerHandleOf,
  requireCreated,
  requireOpened,
  WorkspaceSelectionError,
  type CreateResult,
  type CreateSessionRequest,
  type OpenSessionRequest,
} from '../../src/runtime/session-lifecycle-port.ts'

/** One fake Host Workspace row (the official `Workspace` structural subset). */
interface FakeWorkspace {
  readonly id: string
  readonly path: string
  readonly sessionIds: string[]
  attachSession(sessionId: unknown): Promise<void>
}

/** A fake official registry: `create` canonicalizes through the supplied
 *  mapping and reuses a canonical path, exactly like the real one. */
function createRegistry(options: {
  workspaces?: FakeWorkspace[]
  createFailure?: Error
  attachFailure?: Error
  canonical?: (path: string) => string
} = {}): {
  registry: WorkspaceRegistryLike
  workspaces: FakeWorkspace[]
  created: string[]
  attached: string[]
  gets: string[]
} {
  const created: string[] = []
  const attached: string[] = []
  const gets: string[] = []
  const make = (id: string, path: string): FakeWorkspace => ({
    id,
    path,
    sessionIds: [],
    attachSession: async (sessionId) => {
      attached.push(String(sessionId))
      if (options.attachFailure !== undefined) throw options.attachFailure
      const row = workspaces.find(candidate => candidate.id === id)
      row?.sessionIds.push(String(sessionId))
    },
  })
  const workspaces = options.workspaces ?? [make('ws-a', '/ws')]
  const registry: WorkspaceRegistryLike = {
    create: async (path) => {
      created.push(path)
      if (options.createFailure !== undefined) throw options.createFailure
      const canonical = options.canonical?.(path) ?? path
      const existing = workspaces.find(workspace => workspace.path === canonical)
      if (existing !== undefined) return existing
      const createdWorkspace = make(`ws-${workspaces.length + 1}`, canonical)
      workspaces.push(createdWorkspace)
      return createdWorkspace
    },
    get: (id) => {
      gets.push(id)
      return workspaces.find(workspace => workspace.id === id)
    },
    list: () => workspaces,
  }
  return { registry, workspaces, created, attached, gets }
}

function host(agents: unknown, options: {
  defaultSelection?: { provider: string; model: string }
  registry?: WorkspaceRegistryLike
  observedHeaders?: Record<string, { readonly cwd?: string } | undefined>
  observationFailure?: Error
  disposed?: string[]
} = {}): HostContextLike {
  return {
    get: (name) => {
      if (name === 'agents') return agents
      if (name === 'agentDefaultModel' && options.defaultSelection !== undefined) {
        return { currentSelection: () => options.defaultSelection }
      }
      if (name === 'workspaceRegistry') return options.registry ?? createRegistry().registry
      if (name === 'sessionQuery' && (options.observedHeaders !== undefined || options.observationFailure !== undefined)) {
        return {
          observeSession: async (sessionId: unknown) => {
            if (options.observationFailure !== undefined) throw options.observationFailure
            const header = options.observedHeaders?.[String(sessionId)]
            if (header === undefined) throw new Error(`session "${String(sessionId)}" not found`)
            return {
              header: { id: String(sessionId), ...header },
              events: [],
              projections: { values: {} },
              [Symbol.dispose]: () => { options.disposed?.push(String(sessionId)) },
            }
          },
        }
      }
      return undefined
    },
  }
}

function compose(presetId?: string) {
  return async () => ({ agentPreset: presetId, setup: () => {} })
}

const createRequest: CreateSessionRequest = {
  sessionId: 'session-new',
  workspaceId: 'ws-a',
  agentPreset: 'preset-a',
}

const openRequest: OpenSessionRequest = {
  sessionId: 'session-old',
}

function agents(created: Array<{ sessionId: unknown; meta: unknown; agentOptions: unknown; setup: unknown }> = [], dispose?: () => Promise<void>) {
  return {
    create: async (options: { sessionId: unknown; meta: unknown; agentOptions: unknown; setup: unknown }) => {
      created.push({ sessionId: options.sessionId, meta: options.meta, agentOptions: options.agentOptions, setup: options.setup })
      return { agent: { session: { id: 'session-new' } }, dispose: dispose ?? (async () => {}) }
    },
    resume: async () => ({ agent: { session: { id: 'x' } }, dispose: async () => {} }),
  }
}

test('create resolves the preset composition internally and delegates with the Direct shapes', async () => {
  const calls: Array<{ sessionId: unknown; meta: unknown; agentOptions: unknown; setup: unknown }> = []
  const lifecycle = new DirectSessionLifecycle(host(agents(calls), {
    defaultSelection: { provider: 'p', model: 'm' },
  }), compose('preset-a'))
  const handle = requireCreated(await lifecycle.create(createRequest))
  assert.equal(handle.session.id, 'session-new')
  assert.equal(handle.direct !== undefined, true, 'Direct handle carries the ownership escape')
  assert.ok(handle.direct && typeof handle.direct.agent === 'object', 'carries the live agent')
  assert.ok(handle.direct && typeof handle.direct.ownerHandle === 'object' && typeof (handle.direct.ownerHandle as { dispose?: unknown }).dispose === 'function', 'carries the real owner handle with dispose()')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].sessionId, 'session-new')
  // The activation fallback is the Host default, never a cross-backend request
  // input (D2.3 convergence).
  assert.deepEqual(calls[0].agentOptions, { provider: 'p', model: 'm' })
  // WS-2: the durable Session cwd is the Host registry's canonical Workspace
  // path, never a request-supplied directory.
  assert.deepEqual(calls[0].meta, { cwd: '/ws', agentPreset: 'preset-a' },
    'the Host registry path is recorded in the durable session header from the semantic intent')
  assert.equal(typeof calls[0].setup, 'function', 'the setup callback is built INSIDE the adapter')
})

test('the semantic agentPreset is the SINGLE preset authority for the durable header', async () => {
  const calls: Array<{ meta: unknown }> = []
  const lifecycle = new DirectSessionLifecycle(host({
    create: async (options: { meta: unknown }) => {
      calls.push({ meta: options.meta })
      return { agent: { session: { id: 'session-new' } }, dispose: async () => {} }
    },
    resume: async () => ({ agent: { session: { id: 'x' } }, dispose: async () => {} }),
  }), compose('preset-a'))
  await requireCreated(await lifecycle.create({ sessionId: 'session-new', workspaceId: 'ws-a', agentPreset: 'preset-a' }))
  assert.deepEqual(calls[0].meta, { cwd: '/ws', agentPreset: 'preset-a' })
})

test('create omits agentOptions when no Host default selection exists', async () => {
  const calls: unknown[] = []
  const lifecycle = new DirectSessionLifecycle(host({
    create: async (options: { agentOptions: unknown }) => {
      calls.push(options.agentOptions)
      return { agent: { session: { id: 'session-new' } }, dispose: async () => {} }
    },
    resume: async () => ({ agent: { session: { id: 'x' } }, dispose: async () => {} }),
  }), compose('preset-a'))
  await lifecycle.create(createRequest)
  assert.deepEqual(calls, [{}])
})

test('create attaches the published Session to the resolved Host Workspace', async () => {
  const registry = createRegistry()
  const lifecycle = new DirectSessionLifecycle(host(agents(), { registry: registry.registry }), compose('preset-a'))
  const result = await lifecycle.create(createRequest)
  assert.equal(result.outcome.kind, 'created')
  assert.deepEqual(registry.attached, ['session-new'], 'membership is written only after the Host published the Session')
  assert.deepEqual(registry.workspaces[0].sessionIds, ['session-new'])
})

test('create refuses an unknown WorkspaceId BEFORE dispatching any Agent create', async () => {
  const created: unknown[] = []
  const registry = createRegistry()
  const lifecycle = new DirectSessionLifecycle(host({
    create: async (options: unknown) => { created.push(options); return { agent: { session: { id: 'x' } } } },
    resume: async () => ({ agent: { session: { id: 'x' } }, dispose: async () => {} }),
  }, { registry: registry.registry }), compose('preset-a'))
  const result = await lifecycle.create({ ...createRequest, workspaceId: 'ws-missing' })
  assert.deepEqual(result, {
    ownership: 'current',
    outcome: { kind: 'rejected', error: { code: 'workspace/not-found', message: 'workspace "ws-missing" is not registered on the Host' } },
  })
  assert.deepEqual(created, [], 'an unknown Workspace never reaches agents.create')
  assert.deepEqual(registry.attached, [])
})

test('resolveWorkspace(host-path) adopts the Host canonical directory and reuses the same Workspace', async () => {
  const registry = createRegistry({ canonical: (path) => path.replace(/\/+$/, '') })
  const lifecycle = new DirectSessionLifecycle(host(agents(), { registry: registry.registry }), compose('preset-a'))
  const first = await lifecycle.resolveWorkspace({ kind: 'host-path', path: '/project/a/' })
  assert.deepEqual(first, { workspaceId: 'ws-2', path: '/project/a' }, 'the adapter returns the HOST canonical path, not the proposal')
  const again = await lifecycle.resolveWorkspace({ kind: 'host-path', path: '/project/a' })
  assert.deepEqual(again, first, 'the same canonical path reuses the same Workspace identity')
})

test('resolveWorkspace refuses a Host path the registry rejects and publishes no Session', async () => {
  const registry = createRegistry({ createFailure: new Error('ENOENT: no such file or directory') })
  const lifecycle = new DirectSessionLifecycle(host(agents(), { registry: registry.registry }), compose('preset-a'))
  const error = await lifecycle.resolveWorkspace({ kind: 'host-path', path: '/missing' }).then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(error instanceof WorkspaceSelectionError)
  assert.equal(error.kind, 'refused')
  assert.equal(error.code, 'workspace/invalid-path')
  assert.match(error.message, /refused workspace path "\/missing"/)
})

test('a signal aborted after the durable Workspace create is superseded and never deletes the Workspace', async () => {
  const controller = new AbortController()
  const registry = createRegistry()
  const registryLike = registry.registry
  const abortingRegistry: WorkspaceRegistryLike = {
    create: async (path) => {
      const workspace = await registryLike.create(path)
      controller.abort()
      return workspace
    },
    get: (id) => registryLike.get(id),
    list: () => registryLike.list(),
  }
  const lifecycle = new DirectSessionLifecycle(host(agents(), { registry: abortingRegistry }), compose('preset-a'))
  const error = await lifecycle.resolveWorkspace({ kind: 'host-path', path: '/ws' }, controller.signal)
    .then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(error instanceof WorkspaceSelectionError)
  assert.equal(error.kind, 'superseded')
  assert.deepEqual(registry.workspaces.map(workspace => workspace.id), ['ws-a'], 'the durable Workspace is never rolled back')
})

test('resolveWorkspace(workspace-id) requires an existing official Host identity', async () => {
  const registry = createRegistry()
  const lifecycle = new DirectSessionLifecycle(host(agents(), { registry: registry.registry }), compose('preset-a'))
  assert.deepEqual(await lifecycle.resolveWorkspace({ kind: 'workspace-id', workspaceId: 'ws-a' }), { workspaceId: 'ws-a', path: '/ws' })
  const error = await lifecycle.resolveWorkspace({ kind: 'workspace-id', workspaceId: 'ws-gone' }).then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(error instanceof WorkspaceSelectionError)
  assert.equal(error.kind, 'refused')
  assert.equal(error.code, 'workspace/not-found')
})

test('resolveWorkspace(source-session) uses official membership FIRST, never an effective cwd', async () => {
  const registry = createRegistry({ workspaces: [] })
  const session = { id: 'ws-source', path: '/source', sessionIds: ['session-a'], attachSession: async () => {} }
  registry.workspaces.push(session)
  const lifecycle = new DirectSessionLifecycle(host(agents(), {
    registry: registry.registry,
    // A header directory that differs from the membership: membership wins.
    observedHeaders: { 'session-a': { cwd: '/elsewhere' } },
  }), compose('preset-a'))
  assert.deepEqual(await lifecycle.resolveWorkspace({ kind: 'source-session', sessionId: 'session-a' }), { workspaceId: 'ws-source', path: '/source' })
  assert.deepEqual(registry.created, [], 'membership-first selection never re-creates a Workspace')
})

test('resolveWorkspace(source-session) falls back to the persisted immutable header directory', async () => {
  const registry = createRegistry({ workspaces: [] })
  const disposed: string[] = []
  const lifecycle = new DirectSessionLifecycle(host(agents(), {
    registry: registry.registry,
    observedHeaders: { 'session-a': { cwd: '/old-project' } },
    disposed,
  }), compose('preset-a'))
  const resolved = await lifecycle.resolveWorkspace({ kind: 'source-session', sessionId: 'session-a' })
  assert.deepEqual(resolved, { workspaceId: 'ws-1', path: '/old-project' })
  assert.deepEqual(registry.created, ['/old-project'], 'the header directory is only a Host path proposal')
  assert.deepEqual(disposed, ['session-a'], 'the observation is disposed exactly once')
  assert.deepEqual(registry.workspaces[0].sessionIds, [], 'the historical Session is never silently attached')
})

test('resolveWorkspace(source-session) without a readable header cwd is unavailable and dispatches nothing', async () => {
  const registry = createRegistry({ workspaces: [] })
  const missing = new DirectSessionLifecycle(host(agents(), {
    registry: registry.registry,
    observedHeaders: { 'session-a': {} },
  }), compose('preset-a'))
  const unavailable = await missing.resolveWorkspace({ kind: 'source-session', sessionId: 'session-a' }).then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(unavailable instanceof WorkspaceSelectionError)
  assert.equal(unavailable.kind, 'unavailable')

  const unreadable = new DirectSessionLifecycle(host(agents(), {
    registry: registry.registry,
    observationFailure: new Error('SESSION_QUERY_SESSION_NOT_FOUND'),
  }), compose('preset-a'))
  const notFound = await unreadable.resolveWorkspace({ kind: 'source-session', sessionId: 'session-x' }).then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(notFound instanceof WorkspaceSelectionError)
  assert.equal(notFound.kind, 'unavailable')
  assert.deepEqual(registry.created, [], 'no Workspace is created from an unreadable/missing header')
})

test('resolveWorkspace is unavailable when the Host Workspace registry is absent', async () => {
  const lifecycle = new DirectSessionLifecycle({ get: () => undefined }, compose('preset-a'))
  const error = await lifecycle.resolveWorkspace({ kind: 'workspace-id', workspaceId: 'ws-a' }).then(() => undefined, (thrown: unknown) => thrown)
  assert.ok(error instanceof WorkspaceSelectionError)
  assert.equal(error.kind, 'unavailable')
})

test('open resolves the persisted preset internally and delegates with the Direct shapes', async () => {
  const calls: Array<{ resumeSessionId: unknown; agentOptions: unknown; setup: unknown }> = []
  const lifecycle = new DirectSessionLifecycle(host({
    create: async () => ({ agent: { session: { id: 'x' } } }),
    resume: async (options: { resumeSessionId: unknown; agentOptions: unknown; setup: unknown }) => {
      calls.push({ resumeSessionId: options.resumeSessionId, agentOptions: options.agentOptions, setup: options.setup })
      return { agent: { session: { id: 'session-old' } }, dispose: async () => {} }
    },
  }, { defaultSelection: { provider: 'p', model: 'm' } }), compose('preset-a'))
  const handle = requireOpened(await lifecycle.open(openRequest))
  assert.equal(handle.session.id, 'session-old')
  assert.equal(handle.direct !== undefined, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].resumeSessionId, 'session-old')
  assert.deepEqual(calls[0].agentOptions, { provider: 'p', model: 'm' })
  assert.equal(typeof calls[0].setup, 'function')
})

test('open composes the recorded preset resolved from the official observation seam', async () => {
  const composed: Array<string | undefined> = []
  const lifecycle = new DirectSessionLifecycle({
    get: (name) => {
      if (name === 'agents') {
        return {
          create: async () => ({ agent: { session: { id: 'x' } } }),
          resume: async () => ({ agent: { session: { id: 'session-old' } }, dispose: async () => {} }),
        }
      }
      if (name === 'sessionQuery') {
        return {
          observeSession: async () => ({
            projections: { values: { agentPreset: 'recorded' } },
            [Symbol.dispose]: () => {},
          }),
        }
      }
      return undefined
    },
  }, async (presetId) => {
    composed.push(presetId)
    return { agentPreset: presetId, setup: () => {} }
  })
  await lifecycle.open(openRequest)
  assert.deepEqual(composed, ['recorded'], 'the Direct adapter owns the persisted-preset lookup')
})

test('create and open forward the caller-owned signal unchanged and do not invent one', async () => {
  const createSignals: (AbortSignal | undefined)[] = []
  const resumeSignals: (AbortSignal | undefined)[] = []
  const lifecycle = new DirectSessionLifecycle(host({
    create: async (options: { signal?: AbortSignal }) => {
      createSignals.push(options.signal)
      return { agent: { session: { id: 'session-new' } }, dispose: async () => {} }
    },
    resume: async (options: { signal?: AbortSignal }) => {
      resumeSignals.push(options.signal)
      return { agent: { session: { id: 'session-old' } }, dispose: async () => {} }
    },
  }), compose('preset-a'))
  const createSignal = new AbortController().signal
  const resumeSignal = new AbortController().signal

  await lifecycle.create({ ...createRequest, signal: createSignal })
  await lifecycle.open({ ...openRequest, signal: resumeSignal })
  await lifecycle.create(createRequest)
  await lifecycle.open(openRequest)

  assert.equal(createSignals[0], createSignal)
  assert.equal(resumeSignals[0], resumeSignal)
  assert.equal(createSignals[1], undefined)
  assert.equal(resumeSignals[1], undefined)
})

test('create and open report unavailable when the agents service is absent', async () => {
  const lifecycle = new DirectSessionLifecycle(host(undefined), compose('preset-a'))
  const created = await lifecycle.create(createRequest)
  assert.equal(created.ownership, 'current')
  assert.equal(created.outcome.kind, 'rejected')
  if (created.outcome.kind === 'rejected') assert.match(created.outcome.error.message, /agents service unavailable/)
  const opened = await lifecycle.open(openRequest)
  assert.deepEqual(opened, { ownership: 'current', outcome: { kind: 'unavailable', message: 'agents service unavailable' } })
})

test('regression: the ownership escape preserves the real AgentHandle so the runner can dispose it on retirement', async () => {
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
  const handle = requireCreated(await lifecycle.create(createRequest))
  // The runner's retirement path:
  const liveHandle = handle.direct?.ownerHandle as { dispose(): Promise<void> } | undefined
  assert.ok(liveHandle !== undefined, 'the runner receives the real owner handle')
  await liveHandle.dispose()
  assert.equal(disposed, 1, 'the original AgentHandle.dispose() is called exactly once')
  // The live agent is the same object the runner drives:
  assert.equal((handle.direct!.agent as { session: { id: string } }).session.id, 'session-a')
})

test('attach failure after publication keeps the real identity and hands the owner handle to retirement', async () => {
  const parked: unknown[] = []
  const attached: string[] = []
  const registry = createRegistry()
  // The registry create returns a Workspace whose attach always fails.
  const failing: WorkspaceRegistryLike = {
    create: registry.registry.create,
    get: () => ({
      id: 'ws-a',
      path: '/ws',
      sessionIds: [],
      attachSession: async (sessionId) => {
        attached.push(String(sessionId))
        throw new Error('header cwd does not match the workspace')
      },
    }),
    list: registry.registry.list,
  }
  let disposed = 0
  const lifecycle = new DirectSessionLifecycle(
    host(agents([], async () => { disposed += 1 }), { registry: failing }),
    compose('preset-a'),
    { claim: () => undefined, park: (handle) => { parked.push(handle) } },
  )
  const result = await lifecycle.create(createRequest)
  assert.equal(result.ownership, 'current')
  assert.equal(result.outcome.kind, 'published-with-error')
  if (result.outcome.kind !== 'published-with-error') return
  assert.equal(result.outcome.sessionId, 'session-new', 'the PUBLISHED identity is authoritative')
  assert.equal(result.outcome.error.code, 'session/workspace-attach-failed')
  assert.deepEqual(attached, ['session-new'])
  assert.equal(parked.length, 1, 'the live AgentHandle is handed to the existing owner lifetime')
  assert.equal(disposed, 0, 'the parked handle is not disposed inline — retirement owns it')
  // A published-with-error is NOT a rejection: the caller must not retry.
  const error = (() => { try { requireCreated(result); return undefined } catch (thrown) { return thrown } })()
  assert.ok(error instanceof LifecycleError)
  assert.equal(error.settlement, 'published-with-error')
  assert.equal(error.publishedSessionId, 'session-new')
})

test('attach failure without an owner pool disposes the just-created Direct handle exactly once', async () => {
  let disposed = 0
  const registry = createRegistry()
  const failing: WorkspaceRegistryLike = {
    create: registry.registry.create,
    get: () => ({
      id: 'ws-a',
      path: '/ws',
      sessionIds: [],
      attachSession: async () => { throw new Error('attach refused') },
    }),
    list: registry.registry.list,
  }
  const lifecycle = new DirectSessionLifecycle(
    host(agents([], async () => { disposed += 1 }), { registry: failing }),
    compose('preset-a'),
  )
  const result = await lifecycle.create(createRequest)
  assert.equal(result.outcome.kind, 'published-with-error')
  assert.equal(disposed, 1, 'the owner lease is released instead of leaking')
})

test('regression (round 3): transition commit stores the OWNER HANDLE, and a SECOND transition disposes the FIRST exactly once', async () => {
  // The exact chain that broke: transition A→B stores liveHandle from the
  // SessionHandle, then transition B→C disposes the OLD liveHandle. If the
  // commit had stored the SessionHandle (or the agent) instead of the real
  // ownerHandle, dispose() would be missing and B would PIN — never
  // cooling. This pins ownerHandleOf + the double-transition dispose.
  const disposed: string[] = []
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
  const handleB = requireCreated(await lifecycle.create({ sessionId: 'session-b', workspaceId: 'ws-a' }))
  // The commit stores the OWNER HANDLE (exactly what the runner does):
  let liveHandle = ownerHandleOf(handleB) as { dispose(): Promise<void> }
  assert.ok(liveHandle !== undefined, 'the commit stores the real owner handle, never the SessionHandle')

  // Transition B -> C: the OLD live handle (B) is disposed exactly once.
  await liveHandle.dispose()
  assert.deepEqual(disposed, ['session-b'], 'transition B→C disposes B\x27s original AgentHandle exactly once')

  // And a third transition disposes C exactly once:
  const handleC = requireCreated(await lifecycle.create({ sessionId: 'session-c', workspaceId: 'ws-a' }))
  liveHandle = ownerHandleOf(handleC) as { dispose(): Promise<void> }
  await liveHandle.dispose()
  assert.deepEqual(disposed, ['session-b', 'session-c'], 'each retired session disposes exactly once, in order')
})

// ── D2.3 two-axis lifecycle result contract ────────────────────────────────

test('requireCreated preserves settlement + ownership + published identity as a LifecycleError', () => {
  const cases: Array<{ result: CreateResult; settlement: string; ownership: string; published: string | undefined }> = [
    { result: { ownership: 'current', outcome: { kind: 'rejected', error: { code: 'x', message: 'no' } } }, settlement: 'rejected', ownership: 'current', published: undefined },
    { result: { ownership: 'superseded', outcome: { kind: 'rejected', error: { code: 'x', message: 'no' } } }, settlement: 'rejected', ownership: 'superseded', published: undefined },
    { result: { ownership: 'current', outcome: { kind: 'cancelled' } }, settlement: 'cancelled', ownership: 'current', published: undefined },
    { result: { ownership: 'superseded', outcome: { kind: 'published-with-error', sessionId: 'session-pub', error: { code: 'session/reconcile-failed', message: 'boom' } } }, settlement: 'published-with-error', ownership: 'superseded', published: 'session-pub' },
    { result: { ownership: 'current', outcome: { kind: 'indeterminate', error: { code: 'gateway/internal', message: 'lost' }, requestedSessionId: 'session-req' } }, settlement: 'indeterminate', ownership: 'current', published: undefined }, // requestedSessionId stays correlation-only
    { result: { ownership: 'superseded', outcome: { kind: 'created', handle: { session: { id: 'session-made' } } } }, settlement: 'superseded', ownership: 'superseded', published: 'session-made' },
  ]
  for (const testCase of cases) {
    const error = (() => { try { requireCreated(testCase.result); return undefined } catch (thrown) { return thrown } })()
    assert.ok(error instanceof LifecycleError, `requireCreated must throw for ${testCase.result.outcome.kind}`)
    assert.equal(error.settlement, testCase.settlement)
    assert.equal(error.ownership, testCase.ownership)
    assert.equal(error.publishedSessionId, testCase.published)
  }
})

test('requireCreated returns the handle only for a created result that still owns the surface', () => {
  const handle = requireCreated({ ownership: 'current', outcome: { kind: 'created', handle: { session: { id: 'ok' } } } })
  assert.deepEqual(handle, { session: { id: 'ok' } })
})

test('requireOpened reports unavailable/cancelled/superseded-opened as a LifecycleError', () => {
  const unavailable = (() => { try { requireOpened({ ownership: 'current', outcome: { kind: 'unavailable', message: 'gone' } }); return undefined } catch (thrown) { return thrown } })()
  assert.ok(unavailable instanceof LifecycleError)
  assert.equal(unavailable.settlement, 'unavailable')
  assert.match(unavailable.message, /gone/)

  const cancelled = (() => { try { requireOpened({ ownership: 'current', outcome: { kind: 'cancelled' } }); return undefined } catch (thrown) { return thrown } })()
  assert.ok(cancelled instanceof LifecycleError)
  assert.equal(cancelled.settlement, 'cancelled')

  const superseded = (() => { try { requireOpened({ ownership: 'superseded', outcome: { kind: 'opened', handle: { session: { id: 's' } } } }); return undefined } catch (thrown) { return thrown } })()
  assert.ok(superseded instanceof LifecycleError)
  assert.equal(superseded.settlement, 'superseded')
  assert.equal(superseded.publishedSessionId, 's')
})

test('Direct create classifies an in-process throw as a proven rejection and a pre-abort as cancelled', async () => {
  const lifecycle = new DirectSessionLifecycle(host({
    create: async () => { throw new Error('in-process create exploded') },
    resume: async () => ({ agent: { session: { id: 'x' } }, dispose: async () => {} }),
  }), compose('preset-a'))
  const rejected = await lifecycle.create(createRequest)
  assert.equal(rejected.ownership, 'current')
  assert.equal(rejected.outcome.kind, 'rejected')
  if (rejected.outcome.kind === 'rejected') assert.match(rejected.outcome.error.message, /in-process create exploded/)

  const controller = new AbortController()
  controller.abort()
  const cancelled = await lifecycle.create({ ...createRequest, signal: controller.signal })
  assert.deepEqual(cancelled, { ownership: 'current', outcome: { kind: 'cancelled' } })
})

test('Direct open classifies an in-process throw as unavailable and a pre-abort as cancelled', async () => {
  const lifecycle = new DirectSessionLifecycle(host({
    create: async () => ({ agent: { session: { id: 'x' } } }),
    resume: async () => { throw new Error('in-process resume exploded') },
  }), compose('preset-a'))
  const unavailable = await lifecycle.open(openRequest)
  assert.equal(unavailable.ownership, 'current')
  assert.equal(unavailable.outcome.kind, 'unavailable')

  const controller = new AbortController()
  controller.abort()
  const cancelled = await lifecycle.open({ ...openRequest, signal: controller.signal })
  assert.deepEqual(cancelled, { ownership: 'current', outcome: { kind: 'cancelled' } })
})

test('requireCreated keeps an indeterminate requestedSessionId as CORRELATION ONLY', () => {
  const error = (() => {
    try {
      requireCreated({ ownership: 'current', outcome: { kind: 'indeterminate', error: { code: 'gateway/internal', message: 'lost' }, requestedSessionId: 'session-req' } })
      return undefined
    } catch (thrown) { return thrown }
  })()
  assert.ok(error instanceof LifecycleError)
  assert.equal(error.publishedSessionId, undefined, 'a requested id is never publication proof')
  assert.equal(error.requestedSessionId, 'session-req')
})

test('Direct create persists the COMPOSED preset as the single ordinary-create authority', async () => {
  const metas: unknown[] = []
  const lifecycle = new DirectSessionLifecycle(host({
    create: async (options: { meta: unknown }) => {
      metas.push(options.meta)
      return { agent: { session: { id: 'session-new' } }, dispose: async () => {} }
    },
    resume: async () => ({ agent: { session: { id: 'x' } }, dispose: async () => {} }),
  }), async () => ({ agentPreset: 'composed', setup: () => {} }))
  // The semantic preset is the single authority: the durable header records the
  // actually composed preset, not a caller-supplied duplicate.
  const created = await lifecycle.create({ sessionId: 'session-new', workspaceId: 'ws-a', agentPreset: 'ignored-by-compose' })
  assert.equal(created.outcome.kind, 'created')
  assert.deepEqual(metas[0], { cwd: '/ws', agentPreset: 'composed' })

  const second = await lifecycle.create({ sessionId: 'session-forked', workspaceId: 'ws-a', agentPreset: 'x' })
  assert.equal(second.outcome.kind, 'created')
})

test('Direct create captures the Host default at ADMISSION (a later /model write must not rewrite it)', async () => {
  let selection = { provider: 'p', model: 'm-admission' }
  let releaseCompose!: () => void
  const composeGate = new Promise<void>((resolve) => { releaseCompose = resolve })
  const captured: unknown[] = []
  const registry = createRegistry()
  const lifecycle = new DirectSessionLifecycle({
    get: (name) => name === 'agents'
      ? {
          create: async (options: { agentOptions: unknown }) => {
            captured.push(options.agentOptions)
            return { agent: { session: { id: 'session-new' } }, dispose: async () => {} }
          },
          resume: async () => ({ agent: { session: { id: 'x' } }, dispose: async () => {} }),
        }
      : name === 'agentDefaultModel' ? { currentSelection: () => selection }
        : name === 'workspaceRegistry' ? registry.registry
          : undefined,
  }, async () => { await composeGate; return { setup: () => {} } })
  const pending = lifecycle.create({ sessionId: 'session-new', workspaceId: 'ws-a' })
  await Promise.resolve()
  // A later sessionless /model default write lands while compose is in flight.
  selection = { provider: 'p', model: 'm-later' }
  releaseCompose()
  const result = await pending
  assert.equal(result.outcome.kind, 'created')
  assert.deepEqual(captured[0], { provider: 'p', model: 'm-admission' },
    'the create must use the Host default captured at admission, not a later write')
})
