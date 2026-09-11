import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteSessionReader,
  type RemoteConnectionGeneration,
  type RemoteConnectionGenerationSource,
  type RemoteProjectionValues,
  type RemoteReadResult,
  type RemoteSessionBinding,
  type RemoteSessionListRow,
  type RemoteSessionListState,
  type RemoteSessionsReadSource,
} from '../src/runtime/remote/session-reader-remote.ts'
import type { SessionContentSearchPage, SessionSummary } from '../src/runtime/session-reader-port.ts'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'

function constructOfficialReader(sessions: ISessions, generation: ConnectionGenerationState): RemoteSessionReader {
  return new RemoteSessionReader(sessions, generation)
}

interface GenerationHarness {
  readonly source: RemoteConnectionGenerationSource
  set(value: RemoteConnectionGeneration | undefined): void
}

function generationHarness(): GenerationHarness {
  let current: RemoteConnectionGeneration | undefined = { id: 1 }
  const listeners = new Set<() => void>()
  return {
    source: {
      getSnapshot: () => current,
      subscribe: listener => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set(value) {
      current = value
      for (const listener of [...listeners]) listener()
    },
  }
}

function listRow(
  id: string,
  updatedAt: number,
  extra: Partial<RemoteSessionListRow> = {},
): RemoteSessionListRow {
  return { id, updatedAt, running: false, ...extra }
}

function state(
  ids: readonly string[],
  byId: Readonly<Record<string, RemoteSessionListRow>>,
  phase: RemoteSessionListState['phase'] = 'ready',
): RemoteSessionListState {
  return { ids, byId, phase }
}

function binding(values: RemoteProjectionValues): RemoteSessionBinding {
  return {
    session: {
      projections: {
        faceOf: (key: string) => ({
          getSnapshot: () => key === 'title' ? values.title : values.agentPreset,
        }),
      },
    },
  }
}

function remoteSource(options: {
  state: RemoteSessionListState
  refresh?: () => Promise<void>
  search?: (query: string, signal: AbortSignal) => Promise<RemoteReadResult<{
    readonly items: readonly { readonly sessionId: string; readonly snippet: string }[]
    readonly hasMore: boolean
  }>>
  bindings?: Readonly<Record<string, RemoteSessionBinding>>
}): RemoteSessionsReadSource & { refreshCalls: number; searchCalls: string[] } {
  let refreshCalls = 0
  const searchCalls: string[] = []
  return {
    list: {
      getSnapshot: () => options.state,
      subscribe: () => () => {},
    },
    refresh: async () => {
      refreshCalls += 1
      await options.refresh?.()
    },
    search: async (query, signal) => {
      searchCalls.push(query)
      if (options.search !== undefined) return options.search(query, signal)
      return { ok: true, value: { items: [], hasMore: false } }
    },
    binding: id => options.bindings?.[id],
    get refreshCalls() { return refreshCalls },
    searchCalls,
  }
}

function directRow(id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, updatedAt, createdAt: updatedAt, live: false, ...extra }
}

const emptyPage = (): SessionContentSearchPage => ({ items: [], hasMore: false })

test('official Client Session and Connection faces satisfy the adapter boundary', () => {
  assert.equal(typeof constructOfficialReader, 'function')
})

test('list maps official ids/order/activity and never treats running as Direct live', async () => {
  const generations = generationHarness()
  const source = remoteSource({
    state: state(
      ['session-b', 'session-a'],
      {
        'session-a': listRow('row-a', 10, { cwd: '/a', running: true }),
        'session-b': listRow('session-b', 20, { cwd: '/b', parentId: 'session-root', origin: 'subagent' }),
        // Addressed children can be present in byId but are not list rows.
        'session-addressed-child': listRow('session-addressed-child', 30, { cwd: '/child', running: true }),
      },
    ),
  })
  const reader = new RemoteSessionReader(source, generations.source)

  const rows = await reader.list('session-a')
  assert.deepEqual(rows, [
    { id: 'session-b', updatedAt: 20, cwd: '/b', parentSession: 'session-root', origin: 'subagent', live: false },
    { id: 'session-a', updatedAt: 10, cwd: '/a', live: false },
  ])
  assert.equal(source.refreshCalls, 1)
})

test('read operations never touch a write-capable source surface', async () => {
  const generations = generationHarness()
  const writes: string[] = []
  const source = remoteSource({ state: state(['session-a'], { 'session-a': listRow('session-a', 1) }) })
  const guarded = new Proxy(source, {
    get(target, property, receiver) {
      if (['create', 'fork', 'prompt', 'rename', 'cancel', 'updateQueue'].includes(String(property))) {
        writes.push(String(property))
        throw new Error(`unexpected Remote write: ${String(property)}`)
      }
      return Reflect.get(target, property, receiver)
    },
  })
  const reader = new RemoteSessionReader(guarded, generations.source)
  const rows = await reader.list(undefined)
  await reader.projectionBatch(rows ?? [])
  await reader.search('fixture')
  assert.deepEqual(writes, [])
})

test('list distinguishes pending/disconnected from an established empty list', async () => {
  const generations = generationHarness()
  const pendingSource = remoteSource({ state: state([], {}, 'pending') })
  const pendingReader = new RemoteSessionReader(pendingSource, generations.source)
  assert.equal(await pendingReader.list(undefined), undefined)
  assert.equal(pendingSource.refreshCalls, 1)

  const emptySource = remoteSource({ state: state([], {}) })
  const emptyReader = new RemoteSessionReader(emptySource, generations.source)
  assert.deepEqual(await emptyReader.list(undefined), [])

  generations.set(undefined)
  assert.equal(await emptyReader.list(undefined), undefined)
  assert.equal(emptySource.refreshCalls, 1, 'disconnected reads do not refresh')
})

test('a resolved refresh does not invent a fresh list baseline', async () => {
  const generations = generationHarness()
  const source = remoteSource({ state: state([], {}), refresh: async () => {} })
  const reader = new RemoteSessionReader(source, generations.source)

  assert.deepEqual(await reader.list(undefined), [])
  assert.deepEqual(await reader.list(undefined), [])
  assert.equal(source.refreshCalls, 2)
})

test('list rejects when its caller aborts during the official refresh', async () => {
  const generations = generationHarness()
  const refresh = Promise.withResolvers<void>()
  const source = remoteSource({ state: state([], {}), refresh: async () => refresh.promise })
  const reader = new RemoteSessionReader(source, generations.source)
  const controller = new AbortController()
  const pending = reader.list(undefined, controller.signal)
  controller.abort()
  refresh.resolve()
  await assert.rejects(pending, /abort/i)
})

test('projectionBatch prefers list projection values and falls back to bound Client faces', async () => {
  const generations = generationHarness()
  const bindCalls: string[] = []
  const source = remoteSource({
    state: state(['session-listed', 'session-bound', 'session-missing'], {
      'session-listed': listRow('session-listed', 10, {
        projectionValues: { title: 'listed title', agentPreset: 'listed-preset' },
      }),
      'session-bound': listRow('session-bound', 9),
      'session-missing': listRow('session-missing', 8),
    }),
    bindings: {
      'session-bound': binding({ title: 'bound title', agentPreset: 'bound-preset' }),
      'session-missing': binding({}),
    },
  })
  const originalBinding = source.binding
  source.binding = id => {
    bindCalls.push(id)
    return originalBinding(id)
  }
  const reader = new RemoteSessionReader(source, generations.source)

  const result = await reader.projectionBatch([
    directRow('session-listed', 10),
    directRow('session-bound', 9),
    directRow('session-missing', 8),
  ])
  assert.deepEqual([...result], [
    ['session-listed', { title: 'listed title', preset: 'listed-preset' }],
    ['session-bound', { title: 'bound title', preset: 'bound-preset' }],
  ])
  assert.deepEqual(bindCalls, ['session-bound', 'session-missing'])
})

test('projectionBatch rejects pre-aborted calls and returns no values while disconnected', async () => {
  const generations = generationHarness()
  const source = remoteSource({ state: state([], {}) })
  const reader = new RemoteSessionReader(source, generations.source)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(reader.projectionBatch([], controller.signal), /abort/i)

  generations.set(undefined)
  assert.deepEqual(await reader.projectionBatch([directRow('missing', 1)]), new Map())
})

test('search maps successful pages, including an established empty page', async () => {
  const generations = generationHarness()
  let receivedSignal: AbortSignal | undefined
  const source = remoteSource({
    state: state([], {}),
    search: async (_query, signal) => {
      receivedSignal = signal
      return {
        ok: true,
        value: {
          items: [{ sessionId: 'session-a', snippet: 'answer' }],
          hasMore: false,
        },
      }
    },
  })
  const reader = new RemoteSessionReader(source, generations.source)
  assert.deepEqual(await reader.search('needle'), {
    items: [{ sessionId: 'session-a', snippet: 'answer' }],
    hasMore: false,
  })
  assert.ok(receivedSignal !== undefined)
  assert.deepEqual(await new RemoteSessionReader(remoteSource({ state: state([], {}) }), generations.source).search('empty'), emptyPage())
})

test('search maps disabled capability to unavailable but preserves business failures', async () => {
  const generations = generationHarness()
  const disabled = remoteSource({
    state: state([], {}),
    search: async () => ({ ok: false, error: { code: 'SESSION_QUERY_SEARCH_DISABLED' } }),
  })
  assert.equal(await new RemoteSessionReader(disabled, generations.source).search('needle'), undefined)

  const failure = { code: 'session/backend-failed', message: 'not empty' }
  const failed = remoteSource({
    state: state([], {}),
    search: async () => ({ ok: false, error: failure }),
  })
  await assert.rejects(
    new RemoteSessionReader(failed, generations.source).search('needle'),
    error => error === failure,
  )

  const internalFailure = { code: 'gateway/internal', message: 'session search failed unexpectedly' }
  const internalFailed = remoteSource({
    state: state([], {}),
    search: async () => ({ ok: false, error: internalFailure }),
  })
  await assert.rejects(
    new RemoteSessionReader(internalFailed, generations.source).search('needle'),
    error => error === internalFailure,
  )
})

test('maps the official rc1 unmounted session-query error shape to unavailable', async () => {
  const generations = generationHarness()
  // ApiSessionList in rc1 uses this exact generic RemoteError because the
  // deployment capability is absent; generic gateway/internal failures must
  // still propagate (covered above).
  const officialError = new RemoteError(
    'gateway/internal',
    'session search is unavailable: this deployment does not mount @deepseek-ai/dsh-session-query',
    {},
  )
  const source = remoteSource({
    state: state([], {}),
    search: async () => ({ ok: false, error: officialError }),
  })

  assert.equal(await new RemoteSessionReader(source, generations.source).search('needle'), undefined)
})

test('maps the official rc1 disabled-search wrapper to unavailable', async () => {
  const generations = generationHarness()
  const queryError = new SessionQueryError(
    'session search is disabled: this deployment configures the session-query index with openAt "never"',
    'SESSION_QUERY_SEARCH_DISABLED',
  )
  const officialError = new RemoteError(
    'gateway/internal',
    `session search failed: ${String(queryError)}`,
    {},
  )
  assert.equal(
    officialError.message,
    'session search failed: SessionQueryError: session search is disabled: '
      + 'this deployment configures the session-query index with openAt "never"',
  )
  const source = remoteSource({
    state: state([], {}),
    search: async () => ({ ok: false, error: officialError }),
  })

  assert.equal(await new RemoteSessionReader(source, generations.source).search('needle'), undefined)
})

test('search preserves abort semantics and does not turn cancellation into empty results', async () => {
  const generations = generationHarness()
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const source = remoteSource({
    state: state([], {}),
    search: async () => {
      calls += 1
      return { ok: true, value: { items: [], hasMore: false } }
    },
  })
  const reader = new RemoteSessionReader(source, generations.source)
  await assert.rejects(reader.search('needle', controller.signal), /abort/i)
  assert.equal(calls, 0)

  const cancelled = remoteSource({
    state: state([], {}),
    search: async () => ({ ok: false, error: { code: 'gateway/cancelled' } }),
  })
  await assert.rejects(new RemoteSessionReader(cancelled, generations.source).search('needle'), /abort/i)

  const duringController = new AbortController()
  const during = remoteSource({
    state: state([], {}),
    search: async (_query, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { reject({ code: 'gateway/cancelled' }) }, { once: true })
    }),
  })
  const pending = new RemoteSessionReader(during, generations.source).search('needle', duringController.signal)
  duringController.abort()
  await assert.rejects(pending, /abort/i)
})

test('search discards a result whose Connection generation changed while it was in flight', async () => {
  const generations = generationHarness()
  const deferred = Promise.withResolvers<RemoteReadResult<{ readonly items: readonly []; readonly hasMore: false }>>()
  const source = remoteSource({
    state: state([], {}),
    search: async () => deferred.promise,
  })
  const reader = new RemoteSessionReader(source, generations.source)
  const pending = reader.search('needle')
  generations.set({ id: 2 })
  deferred.resolve({ ok: true, value: { items: [], hasMore: false } })
  assert.equal(await pending, undefined)
})

test('measureContext is explicitly unavailable because the Client read face has no equivalent', () => {
  const generations = generationHarness()
  const reader = new RemoteSessionReader(remoteSource({ state: state([], {}) }), generations.source)
  assert.equal(reader.measureContext('session-a'), undefined)
})
