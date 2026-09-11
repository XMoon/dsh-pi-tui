import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RemoteSessionReadShadow,
  type SessionReadShadowOutcome,
} from '../src/runtime/remote/session-read-shadow.ts'
import type {
  SessionContentSearchPage,
  SessionProjectionSummary,
  SessionReader,
  SessionSummary,
} from '../src/runtime/session-reader-port.ts'
import type {
  RemoteConnectionGeneration,
  RemoteConnectionGenerationSource,
} from '../src/runtime/remote/session-reader-remote.ts'

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

function row(id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, updatedAt, createdAt: updatedAt, live: false, ...extra }
}

function reader(options: {
  list?: (signal?: AbortSignal) => Promise<SessionSummary[] | undefined>
  projections?: (rows: readonly SessionSummary[], signal?: AbortSignal) => Promise<Map<string, SessionProjectionSummary>>
  search?: (query: string, signal?: AbortSignal) => Promise<SessionContentSearchPage | undefined>
}): SessionReader {
  return {
    list: async (_current, signal) => options.list?.(signal) ?? [row('session-a', 10, { cwd: '/ws' })],
    projectionBatch: async (rows, signal) => options.projections?.(rows, signal) ?? new Map(),
    search: async (query, signal) => options.search?.(query, signal) ?? { items: [], hasMore: false },
    measureContext: () => undefined,
  }
}

function outcomeReport(outcome: SessionReadShadowOutcome) {
  if (outcome.status !== 'compared') throw new Error(`expected compared, got ${outcome.status}`)
  return outcome.report
}

test('reports comparable list/projection/search fields and explicit non-comparable fields', async () => {
  const generations = generationHarness()
  const direct = reader({
    projections: async () => new Map([['session-a', { title: 'title', preset: 'ptc' }]]),
    search: async () => ({ items: [{ sessionId: 'session-a', snippet: 'needle' }], hasMore: false }),
  })
  const remote = reader({
    projections: async () => new Map([['session-a', { title: 'title', preset: 'ptc' }]]),
    search: async () => ({ items: [{ sessionId: 'session-a', snippet: 'needle' }], hasMore: false }),
  })
  const shadow = new RemoteSessionReadShadow(direct, remote, generations.source)

  const report = outcomeReport(await shadow.compare({ searchQuery: 'needle' }))
  assert.equal(report.generation, '1')
  assert.equal(report.comparable, true)
  assert.deepEqual(report.mismatches, [])
  assert.deepEqual(report.skipped.map(field => field.field), ['createdAt', 'live', 'measureContext'])
  shadow.dispose()
})

test('reports membership/order, row, projection, and search mismatches without changing Direct authority', async () => {
  const generations = generationHarness()
  const direct = reader({
    list: async () => [
      row('session-a', 10, { cwd: '/a', parentSession: 'session-parent', origin: 'subagent' }),
      row('session-b', 9, { cwd: '/b' }),
    ],
    projections: async () => new Map([['session-a', { title: 'direct title', preset: 'direct-preset' }]]),
    search: async () => ({ items: [{ sessionId: 'session-a', snippet: 'direct snippet' }], hasMore: false }),
  })
  const remote = reader({
    list: async () => [
      row('session-b', 9, { cwd: '/b' }),
      row('session-a', 11, { cwd: '/remote', parentSession: 'session-other' }),
    ],
    projections: async () => new Map([['session-a', { title: 'remote title', preset: 'remote-preset' }]]),
    search: async () => ({ items: [{ sessionId: 'session-other', snippet: 'remote snippet' }], hasMore: true }),
  })
  const shadow = new RemoteSessionReadShadow(direct, remote, generations.source)

  const report = outcomeReport(await shadow.compare({ searchQuery: 'needle' }))
  assert.equal(report.comparable, false)
  assert.deepEqual(report.mismatches.map(mismatch => mismatch.field), [
    'order',
    'updatedAt',
    'cwd',
    'parentSession',
    'origin',
    'projection.title',
    'projection.agentPreset',
    'search.ids',
    'search.snippets',
    'search.hasMore',
  ])
  shadow.dispose()
})

test('bounds large parity diagnostics and never returns raw read objects', async () => {
  const generations = generationHarness()
  const directRows = Array.from({ length: 300 }, (_, index) => row(`session-${index}`, index, { cwd: `/${'x'.repeat(600)}` }))
  const remoteRows = directRows.map(value => ({ ...value, updatedAt: value.updatedAt + 1 }))
  remoteRows.push(row('session-extra', 1))
  const shadow = new RemoteSessionReadShadow(
    reader({ list: async () => directRows }),
    reader({ list: async () => remoteRows }),
    generations.source,
  )

  const report = outcomeReport(await shadow.compare())
  assert.equal(report.mismatches.length, 256)
  const idsMismatch = report.mismatches[0]
  assert.equal(idsMismatch?.field, 'ids')
  assert.equal((idsMismatch?.expected as { total?: number }).total, 300)
  assert.equal((idsMismatch?.actual as { total?: number }).total, 301)
  assert.ok(JSON.stringify(report).length < 100_000)
  shadow.dispose()
})

test('returns unavailable while disconnected and does not call either reader', async () => {
  const generations = generationHarness()
  generations.set(undefined)
  let reads = 0
  const direct = reader({ list: async () => { reads += 1; return [] } })
  const remote = reader({ list: async () => { reads += 1; return [] } })
  const shadow = new RemoteSessionReadShadow(direct, remote, generations.source)

  assert.deepEqual(await shadow.compare(), { status: 'unavailable', reason: 'disconnected' })
  assert.equal(reads, 0)
  shadow.dispose()
})

test('does not turn a reader-unavailable result into an empty parity match', async () => {
  const generations = generationHarness()
  const direct = reader({ list: async () => [] })
  const remote = reader({ list: async () => undefined })
  const shadow = new RemoteSessionReadShadow(direct, remote, generations.source)

  assert.deepEqual(await shadow.compare(), {
    status: 'unavailable',
    generation: '1',
    reason: 'reader-unavailable',
  })
  shadow.dispose()
})

test('discards a stale successful result after Connection reset, then compares the new generation', async () => {
  const generations = generationHarness()
  const stale = Promise.withResolvers<SessionSummary[]>()
  let first = true
  const direct = reader({
    list: async () => {
      if (first) {
        first = false
        return stale.promise
      }
      return [row('session-a', 20, { cwd: '/ws' })]
    },
  })
  const remote = reader({ list: async () => [row('session-a', 10, { cwd: '/ws' })] })
  const shadow = new RemoteSessionReadShadow(direct, remote, generations.source)

  const pending = shadow.compare()
  generations.set({ id: 2 })
  stale.resolve([row('session-a', 10, { cwd: '/ws' })])
  assert.deepEqual(await pending, { status: 'discarded', generation: '1', reason: 'stale-generation' })

  const fresh = outcomeReport(await shadow.compare())
  assert.equal(fresh.generation, '2')
  assert.equal(fresh.comparable, false, 'the deliberate updatedAt mismatch remains visible')
  assert.equal(fresh.mismatches[0]?.field, 'updatedAt')
  shadow.dispose()
})

test('discards a stale error instead of publishing it as the current shadow failure', async () => {
  const generations = generationHarness()
  const stale = Promise.withResolvers<SessionSummary[]>()
  const direct = reader({ list: async () => stale.promise })
  const remote = reader({ list: async () => [row('session-a', 10)] })
  const shadow = new RemoteSessionReadShadow(direct, remote, generations.source)

  const pending = shadow.compare()
  generations.set({ id: 2 })
  stale.reject(new Error('old generation failed'))
  assert.deepEqual(await pending, { status: 'discarded', generation: '1', reason: 'stale-generation' })
  shadow.dispose()
})

test('supersedes an older compare and explicitly discards its late success', async () => {
  const generations = generationHarness()
  const first = Promise.withResolvers<SessionSummary[]>()
  let calls = 0
  const direct = reader({
    list: async () => {
      calls += 1
      return calls === 1 ? first.promise : [row('session-a', 10)]
    },
  })
  const remote = reader({ list: async () => [row('session-a', 10)] })
  const shadow = new RemoteSessionReadShadow(direct, remote, generations.source)

  const old = shadow.compare()
  const current = shadow.compare()
  first.resolve([row('session-a', 10)])
  assert.deepEqual(await old, { status: 'discarded', generation: '1', reason: 'superseded' })
  assert.equal((await current).status, 'compared')
  shadow.dispose()
})

test('external abort returns cancelled for the current shadow operation', async () => {
  const generations = generationHarness()
  const pending = Promise.withResolvers<SessionSummary[]>()
  const shadow = new RemoteSessionReadShadow(
    reader({ list: async () => pending.promise }),
    reader({ list: async () => [row('session-a', 10)] }),
    generations.source,
  )
  const controller = new AbortController()
  const result = shadow.compare({ signal: controller.signal })
  controller.abort()
  pending.resolve([row('session-a', 10)])
  assert.deepEqual(await result, { status: 'cancelled', generation: '1' })
  shadow.dispose()
})

test('a generation reset wins over an external abort for stale completion classification', async () => {
  const generations = generationHarness()
  const pending = Promise.withResolvers<SessionSummary[]>()
  const shadow = new RemoteSessionReadShadow(
    reader({ list: async () => pending.promise }),
    reader({ list: async () => [row('session-a', 10)] }),
    generations.source,
  )
  const controller = new AbortController()
  const result = shadow.compare({ signal: controller.signal })
  controller.abort()
  generations.set({ id: 2 })
  pending.resolve([row('session-a', 10)])
  assert.deepEqual(await result, { status: 'discarded', generation: '1', reason: 'stale-generation' })
  shadow.dispose()
})

test('dispose invalidates and cancels an in-flight compare', async () => {
  const generations = generationHarness()
  const pending = Promise.withResolvers<SessionSummary[]>()
  const shadow = new RemoteSessionReadShadow(
    reader({ list: async () => pending.promise }),
    reader({ list: async () => [row('session-a', 10)] }),
    generations.source,
  )
  const result = shadow.compare()
  shadow.dispose()
  pending.resolve([row('session-a', 10)])
  assert.deepEqual(await result, { status: 'discarded', generation: '1', reason: 'disposed' })
})
