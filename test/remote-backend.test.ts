/**
 * Assembly tests for the experimental Remote `Backend` (M3-3B): `kind` is
 * `'remote'`, the capability set is EXACT (a capability exists only when its
 * port genuinely serves the semantic contract), every part is the very
 * instance handed in, and `BackendKind` accepts `'remote'` without changing
 * the Direct production default.
 * @module @xmoon76/dsh-pi-tui/remote-backend.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CAPABILITIES, DIRECT_IMPLEMENTED_CAPABILITIES, REMOTE_IMPLEMENTED_CAPABILITIES } from '../src/runtime/capability.ts'
import { createRemoteBackend, type RemoteBackendParts } from '../src/runtime/remote/backend-remote.ts'
import { createRemoteBackendRuntime } from '../src/app/remote/runtime.ts'
import type { BackendKind } from '../src/runtime/backend.ts'

test('the Remote backend advertises exactly its implemented capabilities', () => {
  const parts = {
    subagent: {}, sessionReader: {}, pendingInputReader: {}, sessionWriter: {},
    sessionLifecycle: {}, interaction: {}, catalog: {}, config: {}, hostFile: {},
    sessionArchive: {}, hostCommand: {}, pluginManager: {}, jobObservation: {},
  } as unknown as RemoteBackendParts
  const backend = createRemoteBackend(parts)
  assert.equal(backend.kind, 'remote')
  assert.deepEqual([...backend.capabilities].sort(), [...REMOTE_IMPLEMENTED_CAPABILITIES].sort())
  // Every advertised capability must be a real vocabulary entry, and the set
  // must be exactly the vocabulary (every M3-3B port is served).
  assert.deepEqual([...REMOTE_IMPLEMENTED_CAPABILITIES].sort(), [...CAPABILITIES].sort())
  // Identity: each adapter instance is the backend's provider (no wrapper).
  assert.equal(backend.config, parts.config)
  assert.equal(backend.interaction, parts.interaction)
  assert.equal(backend.sessionArchive, parts.sessionArchive)
})

test('BackendKind accepts remote while Direct stays the production default', () => {
  const kind: BackendKind = 'remote'
  assert.equal(kind, 'remote')
  assert.deepEqual([...DIRECT_IMPLEMENTED_CAPABILITIES].sort(), [...CAPABILITIES].sort())
})

/** A minimal structural runtime for the assembly wiring/barrier proof: every
 *  adapter is constructed (its behavior is covered by its own suite), and the
 *  settings read is the observable fact this test needs. */
function fakeRuntime(settingsDescribe: () => Promise<unknown>): {
  runtime: never
  describeCalls: () => number
} {
  let describeCalls = 0
  // A STABLE generation object: the fence compares identity, so a fresh
  // object per read would (correctly) never commit.
  const generationIdentity = { id: 'gen-1' }
  const generation = { getSnapshot: () => generationIdentity, subscribe: () => () => {} }
  const projections = { faceOf: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) }
  const runtime = {
    sessions: {
      list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }), subscribe: () => () => {} },
      refresh: async () => {},
      search: async () => ({ ok: true, value: { items: [], hasMore: false } }),
      binding: () => ({ session: { projections } }),
      scopeOf: () => undefined,
      retain: () => { throw new Error('not needed') },
      create: async () => ({ ok: true, value: { sessionId: 's' } }),
      fork: async () => ({ ok: true, value: { sessionId: 'f' } }),
    },
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: { default: { provider: 'p', model: 'm' }, routableProviders: [], groups: [], failures: [] } }), selectModel: async () => ({ ok: true, value: { selected: { provider: 'p', model: 'm' } } }), create: async () => ({ ok: true, value: { sessionId: 's' } }) },
      llm: { discoverModels: async () => ({ ok: true, value: [] }), listConfigurableProviders: async () => ({ ok: true, value: [] }) },
      agentPresets: { list: async () => ({ ok: true, value: { presets: [] } }), select: async () => ({ ok: true, value: 'preset' }) },
      skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
      fileReferences: { list: async () => ({ ok: true, value: [] }) },
      commands: { execute: async () => ({ ok: true, value: undefined }) },
      subagents: { prompt: async () => ({ ok: true, value: { messageId: 'm' } }), interruptByParent: async () => ({ ok: true, value: {} }) },
      userQuestions: { attachWait: () => Object.assign((async function* () {})(), { dispose: () => {} }), answer: async () => ({ ok: true, value: true }) },
      pluginManager: {},
      settings: {
        describe: async () => { describeCalls += 1; return settingsDescribe() },
        update: async () => ({ ok: true, value: {} }),
        replace: async () => ({ ok: true, value: {} }),
        mutate: async () => ({ ok: true, value: {} }),
      },
      credentials: { describe: async () => ({ ok: true, value: {} }), set: async () => ({ ok: true, value: undefined }), unset: async () => ({ ok: true, value: undefined }) },
      permissionPresets: { catalog: async () => ({ ok: true, value: { options: [] } }) },
      $on: () => () => {},
    },
    jobs: { state: { getSnapshot: () => ({ rows: {}, observed: {} }), subscribe: () => () => {} }, watchRows: () => () => {}, observe: () => () => {} },
    connection: { generation },
  }
  return { runtime: runtime as never, describeCalls: () => describeCalls }
}

test('the assembly performs the config FIRST mirror read as its readiness barrier', async () => {
  const fake = fakeRuntime(async () => ({
    ok: true,
    value: { writable: true, hasDocument: true, namespaces: [{ ns: 'tui-app', value: { theme: 'auto' }, revision: 1, applies: 'live', secrets: [], autoGenerate: false, schema: {} }] },
  }))
  const runtime = await createRemoteBackendRuntime({
    runtime: fake.runtime,
    promptSerializer: { preflight: () => ({ kind: 'unsupported', reason: 'test' }), serialize: async () => ({ kind: 'unsupported', reason: 'test' }) },
    fetch: async () => new Response(null, { status: 404 }),
  })
  assert.equal(fake.describeCalls(), 1, 'the initial read happened exactly once during construction')
  assert.equal(runtime.backend.kind, 'remote')
  const config = runtime.backend.config as unknown as { readiness(): string; lastRefreshFailure(): unknown; tuiSettings?: unknown }
  assert.equal(config.readiness(), 'ready')
  assert.equal(config.lastRefreshFailure(), undefined)
  assert.ok(config.tuiSettings !== undefined, 'the tui-app namespace is readable right after construction')
  runtime.dispose()
})

test('a failing config first read is recorded and still yields a backend (never fabricated values)', async () => {
  const fake = fakeRuntime(async () => ({ ok: false, error: { code: 'gateway/unavailable', message: 'no host' } }))
  const runtime = await createRemoteBackendRuntime({
    runtime: fake.runtime,
    promptSerializer: { preflight: () => ({ kind: 'unsupported', reason: 'test' }), serialize: async () => ({ kind: 'unsupported', reason: 'test' }) },
    fetch: async () => new Response(null, { status: 404 }),
  })
  const config = runtime.backend.config as unknown as { readiness(): string; lastRefreshFailure(): unknown; tuiSettings?: unknown }
  assert.equal(config.readiness(), 'unavailable', 'no committed read: nothing authoritative to present, never "ready"')
  assert.ok(config.lastRefreshFailure() !== undefined, 'the failure is recorded, not swallowed')
  assert.equal(config.tuiSettings, undefined, 'no fabricated namespace is served')
  runtime.dispose()
})
