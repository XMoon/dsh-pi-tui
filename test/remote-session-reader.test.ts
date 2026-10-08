import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteSessionReader,
  type RemoteProjectionValues,
  type RemoteReadResult,
  type RemoteSessionBinding,
  type RemoteSessionListRow,
  type RemoteSessionListState,
  type RemoteSessionsReadSource,
} from '../src/runtime/remote/session-reader-remote.ts'
import { createObservableGenerationHarness } from './support/remote-generation.ts'
import type { SessionContentSearchPage, SessionSummary } from '../src/runtime/session-reader-port.ts'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionGenerationState } from '@deepseek-ai/dsh-client-connection/client'

function constructOfficialReader(sessions: ISessions, generation: ConnectionGenerationState): RemoteSessionReader {
  return new RemoteSessionReader(sessions, generation)
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

function binding(values: RemoteProjectionValues & Readonly<Record<string, unknown>>): RemoteSessionBinding {
  return {
    session: {
      projections: {
        faceOf: (key: string) => ({
          getSnapshot: () => key === 'title' ? values.title
            : key === 'agentPreset' ? values.agentPreset
            : values[key],
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
  const generations = createObservableGenerationHarness()
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
  const generations = createObservableGenerationHarness()
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
  const generations = createObservableGenerationHarness()
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
  const generations = createObservableGenerationHarness()
  const source = remoteSource({ state: state([], {}), refresh: async () => {} })
  const reader = new RemoteSessionReader(source, generations.source)

  assert.deepEqual(await reader.list(undefined), [])
  assert.deepEqual(await reader.list(undefined), [])
  assert.equal(source.refreshCalls, 2)
})

test('list rejects when its caller aborts during the official refresh', async () => {
  const generations = createObservableGenerationHarness()
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
  const generations = createObservableGenerationHarness()
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
  const generations = createObservableGenerationHarness()
  const source = remoteSource({ state: state([], {}) })
  const reader = new RemoteSessionReader(source, generations.source)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(reader.projectionBatch([], controller.signal), /abort/i)

  generations.set(undefined)
  assert.deepEqual(await reader.projectionBatch([directRow('missing', 1)]), new Map())
})

test('search maps successful pages, including an established empty page', async () => {
  const generations = createObservableGenerationHarness()
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
  const generations = createObservableGenerationHarness()
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
  const generations = createObservableGenerationHarness()
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
  const generations = createObservableGenerationHarness()
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
  const generations = createObservableGenerationHarness()
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
  const generations = createObservableGenerationHarness()
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
  const generations = createObservableGenerationHarness()
  const reader = new RemoteSessionReader(remoteSource({ state: state([], {}) }), generations.source)
  assert.equal(reader.measureContext('session-a'), undefined)
})

test('blank reads the official Client Session-summary blank bit (v2 §0.6)', () => {
  const generations = createObservableGenerationHarness()
  const source = remoteSource({
    state: state(
      ['session-a', 'session-b'],
      {
        'session-a': listRow('session-a', 10, { blank: true }),
        'session-b': listRow('session-b', 20, { blank: false }),
      },
    ),
  })
  const reader = new RemoteSessionReader(source, generations.source)
  assert.equal(reader.blank('session-a'), true)
  assert.equal(reader.blank('session-b'), false)
  assert.equal(reader.blank('session-missing'), undefined)
})


// ── M3-3A: official contextPressure / turnOutline / sessionStatus reads ────

function pressureBinding(pressure: unknown, extra: Readonly<Record<string, unknown>> = {}): RemoteSessionBinding {
  return binding({ contextPressure: pressure, ...extra })
}

test('R1/R2: measureContext reads projectedTokens first, then pressureTokens', () => {
  const generation = createObservableGenerationHarness()
  const projected = remoteSource({
    state: state([], {}),
    bindings: { s: pressureBinding({ pressureTokens: 100, projectedTokens: 125, contextWindow: 1000 }) },
  })
  assert.equal(new RemoteSessionReader(projected, generation.source).measureContext('s'), 125)
  const fallback = remoteSource({
    state: state([], {}),
    bindings: { s: pressureBinding({ pressureTokens: 100 }) },
  })
  assert.equal(new RemoteSessionReader(fallback, generation.source).measureContext('s'), 100)
})

test('R3: a binding without a contextPressure value reads unmeasured', () => {
  const generation = createObservableGenerationHarness()
  const source = remoteSource({
    state: state([], {}),
    bindings: { s: pressureBinding(undefined) },
  })
  assert.equal(new RemoteSessionReader(source, generation.source).measureContext('s'), undefined)
})

test('R4: no binding or no connection reads unmeasured with zero retain/open', () => {
  const generation = createObservableGenerationHarness()
  const source = remoteSource({
    state: state([], {}),
    bindings: {},
  })
  const reader = new RemoteSessionReader(source, generation.source)
  assert.equal(reader.measureContext('s'), undefined)
  assert.equal(source.refreshCalls, 0, 'a measurement never refreshes the list')
  generation.set(undefined)
  const connected = remoteSource({
    state: state([], {}),
    bindings: { s: pressureBinding({ pressureTokens: 5 }) },
  })
  assert.equal(new RemoteSessionReader(connected, generation.source).measureContext('s'), undefined,
    'a disconnected generation reads unmeasured')
})

test('R5: Direct and Remote map the SAME projection snapshot to the same occupancy', async () => {
  const { contextPressureOccupancy } = await import('../src/runtime/session-reader-port.ts')
  const pressure = { pressureTokens: 100, projectedTokens: 125, contextWindow: 1000 }
  // The Direct mapping consumes the Host snapshot's value; the Remote
  // mapping consumes the binding face's value — both feed the one shared
  // semantic numerator.
  assert.equal(contextPressureOccupancy(pressure), 125)
  const generation = createObservableGenerationHarness()
  const source = remoteSource({
    state: state([], {}),
    bindings: { s: pressureBinding(pressure) },
  })
  assert.equal(new RemoteSessionReader(source, generation.source).measureContext('s'),
    contextPressureOccupancy(pressure))
})

test('turnOutline reads the official binding projection without any history fetch', () => {
  const generation = createObservableGenerationHarness()
  const outline = [{ turn: 2, seq: 40, prompt: 'second', response: 'r2' }, { turn: 1, seq: 10, prompt: 'first', response: 'r1' }]
  const source = remoteSource({
    state: state([], {}),
    bindings: { s: binding({ turnOutline: outline }) },
  })
  assert.deepEqual(new RemoteSessionReader(source, generation.source).turnOutline('s'), outline)
  const none = remoteSource({ state: state([], {}), bindings: {} })
  assert.equal(new RemoteSessionReader(none, generation.source).turnOutline('s'), undefined)
  generation.set(undefined)
  assert.equal(new RemoteSessionReader(source, generation.source).turnOutline('s'), undefined)
})

test('sessionStatus reads the exact binding projections plus the list-row cwd fact', () => {
  const generation = createObservableGenerationHarness()
  const values = {
    modelSelection: { lastUsed: { provider: 'p', model: 'm1' }, next: { provider: 'p', model: 'm2', reasoningEffort: 'high' } },
    contextPressure: { projectedTokens: 900, contextWindow: 1000 },
    contextBreakdown: { systemTokens: 10, toolsTokens: 20, messageTokens: 870 },
    tokenUsage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
    todos: [{ content: 't', status: 'in_progress' as const }],
  }
  const source = remoteSource({
    state: state(['s'], { s: listRow('s', 1, { cwd: '/host/ws' }) }),
    bindings: { s: binding(values) },
  })
  assert.deepEqual(new RemoteSessionReader(source, generation.source).sessionStatus('s'), {
    sessionId: 's',
    cwd: '/host/ws',
    model: { provider: 'p', model: 'm2', reasoningEffort: 'high' },
    context: {
      projectedTokens: 900,
      contextWindow: 1000,
      breakdown: { systemTokens: 10, toolsTokens: 20, messageTokens: 870 },
    },
    todos: [{ content: 't', status: 'in_progress' }],
    usage: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 },
  })
})

test('sessionStatus reads only the addressed session — no parent/main fallback, no invented facts', () => {
  const generation = createObservableGenerationHarness()
  const mainValues = { contextPressure: { projectedTokens: 500 } }
  const source = remoteSource({
    state: state(['main', 'child'], {
      main: listRow('main', 2, { cwd: '/main' }),
      child: listRow('child', 1, { cwd: '/child' }),
    }),
    bindings: { main: binding(mainValues) },
  })
  const reader = new RemoteSessionReader(source, generation.source)
  // The child has no retained binding: no facts, never the main's values.
  assert.deepEqual(reader.sessionStatus('child'), undefined)
  // A cold/unretained child stays fact-free even after the main was read.
  assert.equal(reader.sessionStatus('child')?.context?.projectedTokens, undefined)
  assert.equal(reader.sessionStatus('main')?.context?.projectedTokens, 500)
  // Absent projections stay absent (no zero-fill).
  const bare = remoteSource({
    state: state(['s'], { s: listRow('s', 1) }),
    bindings: { s: binding({}) },
  })
  assert.deepEqual(new RemoteSessionReader(bare, generation.source).sessionStatus('s'), { sessionId: 's' })
})

test('T8: the Remote branch never grows the Direct compat read — an absent binding face stays unknown', () => {
  // The Direct reader now falls back to the exact Session's own durable facts
  // while the official `modelSelection` unit is unregistered. The Remote branch
  // has an OFFICIAL binding face instead, so it must stay strictly
  // binding-driven: an absent face is unknown, never a local/log-derived value.
  const generation = createObservableGenerationHarness()
  const source = remoteSource({
    state: state(['child'], { child: listRow('child', 1, { cwd: '/child' }) }),
    // The retained child binding owns OTHER facts but not `modelSelection`.
    bindings: { child: binding({ title: 'child title', contextPressure: { projectedTokens: 12 } }) },
  })
  const reader = new RemoteSessionReader(source, generation.source)
  const status = reader.sessionStatus('child')
  assert.equal(status?.model, undefined,
    'an absent Remote modelSelection face reads UNKNOWN — the Direct compat read must not reach this branch')
  assert.equal(status?.title, 'child title', 'the other binding facts are unaffected')
  assert.equal(status?.cwd, '/child')
  generation.set(undefined)
  assert.equal(new RemoteSessionReader(source, generation.source).sessionStatus('child'), undefined,
    'a lost Connection generation stays unavailable')
})

test('sessionStatus keeps the official todos null distinct from capability-absent', () => {
  const generation = createObservableGenerationHarness()
  const withNull = remoteSource({
    state: state(['s'], { s: listRow('s', 1) }),
    bindings: { s: binding({ todos: null }) },
  })
  assert.equal(new RemoteSessionReader(withNull, generation.source).sessionStatus('s')?.todos, null)
  const withoutValue = remoteSource({
    state: state(['s'], { s: listRow('s', 1) }),
    bindings: { s: binding({}) },
  })
  assert.equal(new RemoteSessionReader(withoutValue, generation.source).sessionStatus('s')?.todos, undefined)
})

test('a same-id binding replacement yields a NEW read — the stale projection never repaints', () => {
  const generation = createObservableGenerationHarness()
  const oldValues = { contextPressure: { projectedTokens: 111 } }
  const newValues = { contextPressure: { projectedTokens: 222 } }
  let current = binding(oldValues)
  const source = remoteSource({
    state: state(['s'], { s: listRow('s', 1) }),
    bindings: {
      get s() { return current },
    },
  })
  const reader = new RemoteSessionReader(source, generation.source)
  assert.equal(reader.sessionStatus('s')?.context?.projectedTokens, 111)
  current = binding(newValues)
  assert.equal(reader.sessionStatus('s')?.context?.projectedTokens, 222,
    'the read always resolves the CURRENT binding generation')
})

test('the live status projection list is EXACTLY what the status reads (no static-read/stale-UI drift)', async () => {
  const { CURRENT_STATUS_PROJECTION_KEYS } = await import('../src/runtime/remote/session-reader-remote.ts')
  // The status DTO's keys + the plan source. A new status fact MUST update this
  // list (and vice versa): the ingress subscribes to exactly these keys, so a
  // key read here but missing there would render statically and never refresh.
  assert.deepEqual(
    [...CURRENT_STATUS_PROJECTION_KEYS].sort(),
    // 'permissions' joined in M3-4 PR4 §6.1: the footer/status preset row is
    // projection-authoritative, and a successful permission write is
    // COMMITTED by the pushed projection — the live channel must carry it or
    // the row would render statically after a cycle.
    ['agentPreset', 'contextBreakdown', 'contextPressure', 'goal', 'modelSelection', 'permissions', 'plan', 'title', 'todos', 'tokenUsage'].sort(),
  )
  // Projections whose change the status does not consume stay OUT: their own
  // consumer establishes the subscription it needs.
  assert.equal(CURRENT_STATUS_PROJECTION_KEYS.includes('turnOutline'), false)
  assert.equal(CURRENT_STATUS_PROJECTION_KEYS.includes('sessionStats'), false)
})
