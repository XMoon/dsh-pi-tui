/** SessionReader-to-read-owner contract for the internal TSP Session Browser path. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { createSessionBrowserReadOwner } from '../../src/app/command/session-browser-read.ts'
import { findSessionMatch } from '../../src/tui/pickers/sessions.ts'
import type {
  SessionBrowserPanelHandle,
  SessionBrowserPanelRequest,
  SessionBrowserPresentation,
  SessionBrowserReadSnapshot,
  SessionBrowserResumeIntent,
} from '../../src/app/command/session-browser-presentation.ts'
import type { SessionProjectionSummary, SessionReader, SessionSummary } from '../../src/runtime/session-reader-port.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'
import type { SessionScope } from '../../src/app/session/scope.ts'

const DIAG = () => createDiag({ stderrLevel: 'off' })
const row = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  updatedAt: 100,
  createdAt: 10,
  cwd: '/workspace/project',
  live: false,
  ...overrides,
})

function reader(overrides: Partial<SessionReader> = {}): SessionReader {
  return {
    list: async () => [],
    projectionBatch: async () => new Map(),
    search: async () => undefined,
    blank: () => undefined,
    measureContext: () => undefined,
    turnOutline: () => undefined,
    sessionStatus: () => undefined,
    ...overrides,
  }
}

class PresentationProbe implements SessionBrowserPresentation {
  readonly requests: SessionBrowserPanelRequest[] = []
  readonly snapshots: SessionBrowserReadSnapshot[][] = []
  readonly initialQueries: Array<string | undefined> = []
  readonly closed: boolean[] = []
  readonly notifications: string[] = []

  open(request: SessionBrowserPanelRequest): SessionBrowserPanelHandle {
    this.requests.push(request)
    const snapshots: SessionBrowserReadSnapshot[] = []
    this.snapshots.push(snapshots)
    const index = this.closed.length
    this.closed.push(false)
    let disposed = false
    return {
      isDisposed: () => disposed,
      setSnapshot: (snapshot, options) => {
        if (disposed) return
        snapshots.push(snapshot)
        this.initialQueries.push(options?.initialQuery)
      },
      close: () => { disposed = true; this.closed[index] = true },
    }
  }

  notify(message: string): void {
    this.notifications.push(message)
  }

  latest(index = this.snapshots.length - 1): SessionBrowserReadSnapshot | undefined {
    return this.snapshots[index]?.at(-1)
  }
}

const subject = (isCurrent: () => boolean = () => true) => ({
  currentSessionId: 'session-current',
  currentCwd: '/workspace/project',
  isCurrent,
})
const captured = (isCurrent?: () => boolean) => ({
  subject: subject(isCurrent),
  scope: { sessionId: 'session-current' } as SessionScope,
})

function ownerFor(
  presentation: PresentationProbe,
  value: SessionReader,
  options: {
    readonly isCurrent?: () => boolean
    readonly onResumeIntent?: (intent: SessionBrowserResumeIntent, scope: SessionScope, settle: (outcome: import('../../src/app/command/session-browser-read.ts').SessionBrowserResumeSettlement) => void) => void
  } = {},
) {
  const diag = DIAG()
  const owner = createSessionBrowserReadOwner({
    reader: value,
    presentation,
    captureSubject: () => captured(options.isCurrent),
    diag,
    sessionId: () => 'session-current',
    ...(options.onResumeIntent === undefined ? {} : { onResumeIntent: options.onResumeIntent }),
  })
  return { owner, diag }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

test('synchronous presentation retirement closes the returned handle before any read starts', (t) => {
  const diag = DIAG()
  let closed = false
  let listCalls = 0
  const owner = createSessionBrowserReadOwner({
    reader: reader({ list: async () => { listCalls++; return [] } }),
    presentation: {
      open: (request) => {
        request.onClose()
        return {
          isDisposed: () => false,
          setSnapshot() {},
          close: () => { closed = true },
        }
      },
      notify() {},
    },
    captureSubject: () => captured(),
    diag,
  })
  t.after(() => { owner.dispose(); diag.dispose() })
  owner.open()
  assert.equal(closed, true)
  assert.equal(listCalls, 0)
})

test('listing unavailable, empty, and list failure remain distinct', async (t) => {
  let unavailableSearches = 0
  const unavailable = new PresentationProbe()
  const unavailableOwner = ownerFor(unavailable, reader({
    list: async () => undefined,
    search: async () => { unavailableSearches++; return undefined },
  }))
  t.after(() => { unavailableOwner.owner.dispose(); unavailableOwner.diag.dispose() })
  unavailableOwner.owner.open()
  await waitUntil('unavailable listing state', () => unavailable.latest()?.listState === 'unavailable')
  assert.equal(unavailable.latest()?.rows.length, 0)
  unavailable.requests[0]!.onQueryChange('content')
  assert.equal(unavailable.latest()?.searchState, 'idle', 'a query cannot leave content search loading without a list')
  assert.equal(unavailableSearches, 0, 'the unavailable listing has no authorized row corpus to search')

  const empty = new PresentationProbe()
  const emptyOwner = ownerFor(empty, reader({
    list: async () => [],
    search: async () => ({ items: [], hasMore: false }),
  }))
  t.after(() => { emptyOwner.owner.dispose(); emptyOwner.diag.dispose() })
  emptyOwner.owner.open()
  await waitUntil('empty listing state', () => empty.latest()?.listState === 'empty')
  assert.equal(empty.latest()?.listError, undefined)
  empty.requests[0]!.onQueryChange('content')
  await waitUntil('empty corpus content-search state', () => empty.latest()?.searchState === 'ready')
  assert.deepEqual(empty.latest()?.searchResults, [])

  const failed = new PresentationProbe()
  let failedSearches = 0
  const failedOwner = ownerFor(failed, reader({
    list: async () => { throw new Error('list failed') },
    search: async () => { failedSearches++; return undefined },
  }))
  t.after(() => { failedOwner.owner.dispose(); failedOwner.diag.dispose() })
  failedOwner.owner.open()
  await waitUntil('failed listing state', () => failed.latest()?.listState === 'error')
  assert.match(failed.latest()?.listError ?? '', /list failed/u)
  failed.requests[0]!.onQueryChange('content')
  assert.equal(failed.latest()?.searchState, 'idle', 'a failed list cannot leave content search loading')
  assert.equal(failedSearches, 0, 'content search is not attempted without an authoritative row corpus')
})

test('projection enriches listed main rows and Host search merges in authoritative order', async (t) => {
  const presentation = new PresentationProbe()
  const searchQueries: string[] = []
  const listed = [
    row('session-meta', { updatedAt: 40 }),
    row('session-both', { updatedAt: 30 }),
    row('session-content', { updatedAt: 20 }),
    row('session-other', { updatedAt: 10 }),
    row('session-agent-child', { origin: 'subagent', updatedAt: 5 }),
  ]
  const read = reader({
    list: async (currentSessionId) => {
      assert.equal(currentSessionId, 'session-current')
      return listed
    },
    projectionBatch: async (batch) => new Map(batch.map((item) => [item.id, {
      ...(item.id === 'session-meta' || item.id === 'session-both' ? { title: `Needle ${item.id}` } : { title: 'Unrelated title' }),
      preset: 'reviewer',
    }])),
    search: async (query) => {
      searchQueries.push(query)
      return {
        items: [
          { sessionId: 'session-content', snippet: 'host excerpt content' },
          { sessionId: 'session-both', snippet: 'host excerpt both' },
          { sessionId: 'session-agent-child', snippet: 'subagent must be excluded' },
          { sessionId: 'session-not-listed', snippet: 'foreign hit must be excluded' },
        ],
        hasMore: true,
      }
    },
  })
  const { owner, diag } = ownerFor(presentation, read)
  t.after(() => { owner.dispose(); diag.dispose() })
  owner.open()
  await waitUntil('projection enrichment', () => presentation.latest()?.rows.some((entry) => entry.id === 'session-meta' && entry.title === 'Needle session-meta') === true)
  assert.deepEqual(presentation.latest()?.rows.map((entry) => entry.id), [
    'session-meta', 'session-both', 'session-content', 'session-other',
  ])
  presentation.requests[0]!.onQueryChange('  NEEDLE\0 ')
  await waitUntil('merged Host search page', () => presentation.latest()?.searchState === 'ready')
  const snapshot = presentation.latest()!
  assert.equal(snapshot.query, 'NEEDLE')
  assert.deepEqual(searchQueries, ['NEEDLE'], 'one canonical query is passed to the Host search')
  assert.deepEqual(snapshot.searchResults.map((result) => [result.row.id, result.source]), [
    ['session-meta', 'Metadata'],
    ['session-both', 'Both'],
    ['session-content', 'Content'],
  ])
  assert.equal(snapshot.searchResults[1]?.snippet, 'host excerpt both')
  assert.equal(snapshot.searchResults[2]?.snippet, 'host excerpt content')
  assert.equal(snapshot.hasMore, true, 'hasMore is represented as a refine signal, not a page request')
  presentation.requests[0]!.onQueryChange('NEEDLE')
  assert.deepEqual(searchQueries, ['NEEDLE'], 'equivalent canonical queries do not restart Host search')
})

test('Host content search is canonical, debounced, and canceled with its panel', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => t.mock.timers.reset())
  const presentation = new PresentationProbe()
  const searchQueries: string[] = []
  const { owner, diag } = ownerFor(presentation, reader({
    list: async () => [row('session-needle')],
    search: async (query) => {
      searchQueries.push(query)
      return { items: [], hasMore: false }
    },
  }))
  t.after(() => { owner.dispose(); diag.dispose() })
  const handle = owner.open()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(presentation.latest()?.listState, 'ready')
  const request = presentation.requests[0]!
  request.onQueryChange(' \tNeedle\0 \t')
  assert.equal(presentation.latest()?.query, 'Needle')
  t.mock.timers.tick(249)
  assert.deepEqual(searchQueries, [], 'the Host query waits for the full debounce')
  request.onQueryChange('Needle ')
  assert.deepEqual(searchQueries, [], 'an equivalent canonical edit does not restart the timer')
  t.mock.timers.tick(1)
  assert.deepEqual(searchQueries, ['Needle'], 'the Host receives one clean canonical query')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(presentation.latest()?.searchState, 'ready')
  request.onQueryChange('later')
  handle.close()
  t.mock.timers.tick(250)
  assert.deepEqual(searchQueries, ['Needle'], 'closing cancels the pending query timer')
})

test('Resume intent stays scoped to a listed non-current row and captured subject', async (t) => {
  const presentation = new PresentationProbe()
  const intents: SessionBrowserResumeIntent[] = []
  const { owner, diag } = ownerFor(presentation, reader({
    list: async () => [row('session-current'), row('session-other')],
  }), { onResumeIntent: (intent) => intents.push(intent) })
  t.after(() => { owner.dispose(); diag.dispose() })
  owner.open()
  await waitUntil('intent rows list', () => presentation.latest()?.listState === 'ready')
  const request = presentation.requests[0]!
  request.onResumeIntent({ sessionId: 'session-current', currentSessionId: 'session-current', source: 'enter' })
  request.onResumeIntent({ sessionId: 'session-other', currentSessionId: 'different-current', source: 'activate' })
  request.onResumeIntent({ sessionId: 'session-unlisted', currentSessionId: 'session-current', source: 'activate' })
  request.onResumeIntent({ sessionId: 'session-other', currentSessionId: 'session-current', source: 'activate' })
  assert.deepEqual(intents, [{ sessionId: 'session-other', currentSessionId: 'session-current', source: 'activate' }])
})

test('typed direct resume matches main-session rows in Reader order only', async (t) => {
  const presentation = new PresentationProbe()
  const intents: SessionBrowserResumeIntent[] = []
  const { owner, diag } = ownerFor(presentation, reader({
    list: async () => [
      row('session-subagent-first', { origin: 'subagent' }),
      row('session-main-second'),
    ],
  }), { onResumeIntent: (intent) => intents.push(intent) })
  t.after(() => { owner.dispose(); diag.dispose() })
  const handle = owner.open({ directMatch: { query: 'session-', find: findSessionMatch } })

  assert.deepEqual(await handle.settlement, { kind: 'matched', sessionId: 'session-main-second' })
  assert.deepEqual(intents, [{
    sessionId: 'session-main-second',
    currentSessionId: 'session-current',
    source: 'direct',
  }], 'after excluding subagents, the first main-session match retains official Reader order')
  assert.deepEqual(presentation.latest()?.rows.map((entry) => entry.id), ['session-main-second'],
    'the Browser presentation still excludes every subagent row')
  assert.equal(presentation.closed[0], true, 'a direct match closes after the existing switch handoff starts')
})

test('typed direct resume preserves Reader order across ambiguous main prefix and exact candidates', async (t) => {
  const presentation = new PresentationProbe()
  const intents: SessionBrowserResumeIntent[] = []
  const { owner, diag } = ownerFor(presentation, reader({
    list: async () => [
      row('session-alpha-subagent', { origin: 'subagent' }),
      row('session-alpha-first-main'),
      row('session-alpha'),
      row('session-alpha-second-main'),
    ],
  }), { onResumeIntent: (intent) => intents.push(intent) })
  t.after(() => { owner.dispose(); diag.dispose() })
  const handle = owner.open({ directMatch: { query: 'session-alpha', find: findSessionMatch } })

  assert.deepEqual(await handle.settlement, { kind: 'matched', sessionId: 'session-alpha-first-main' })
  assert.deepEqual(intents, [{
    sessionId: 'session-alpha-first-main',
    currentSessionId: 'session-current',
    source: 'direct',
  }], 'the first listed main prefix candidate wins ahead of a later exact-id candidate')
  assert.deepEqual(presentation.latest()?.rows.map((entry) => entry.id), [
    'session-alpha-first-main',
    'session-alpha',
    'session-alpha-second-main',
  ], 'the excluded subagent does not disturb the ordered main candidate corpus')
  assert.equal(presentation.closed[0], true)
})

test('closing a pending direct-match read settles its request and ignores a late matching list', async (t) => {
  const presentation = new PresentationProbe()
  const listed = deferred<SessionSummary[] | undefined>()
  const intents: SessionBrowserResumeIntent[] = []
  const { owner, diag } = ownerFor(presentation, reader({ list: async () => listed.promise }), {
    onResumeIntent: (intent) => intents.push(intent),
  })
  t.after(() => { owner.dispose(); diag.dispose() })
  const handle = owner.open({ directMatch: { query: 'session-direct-target', find: findSessionMatch } })
  const beforeClose = presentation.latest()

  presentation.closed[0] = true
  presentation.requests[0]!.onClose()
  assert.deepEqual(await handle.settlement, { kind: 'cancelled' })
  assert.equal(presentation.closed[0], true)
  listed.resolve([row('session-direct-target')])
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(intents, [], 'a late matching list cannot dispatch Resume after close')
  assert.equal(presentation.latest(), beforeClose, 'a closed direct-match panel cannot publish a late list')
})

test('a manual query entered during a matching direct read suppresses typed Resume', async (t) => {
  const presentation = new PresentationProbe()
  const listed = deferred<SessionSummary[] | undefined>()
  const intents: SessionBrowserResumeIntent[] = []
  const { owner, diag } = ownerFor(presentation, reader({ list: async () => listed.promise }), {
    onResumeIntent: (intent) => intents.push(intent),
  })
  t.after(() => { owner.dispose(); diag.dispose() })
  const handle = owner.open({ directMatch: { query: 'session-target', find: findSessionMatch } })
  presentation.requests[0]!.onQueryChange('manual query')
  listed.resolve([row('session-target'), row('session-manual-query')])

  assert.deepEqual(await handle.settlement, { kind: 'ready' })
  assert.deepEqual(intents, [], 'a matching typed argument does not override a newer query edit')
  assert.equal(presentation.latest()?.query, 'manual query')
  assert.deepEqual(presentation.latest()?.rows.map((entry) => entry.id), ['session-target', 'session-manual-query'])
})

test('a no-match direct query opens the filtered Browser without overriding live user input', async (t) => {
  const presentation = new PresentationProbe()
  const listed = deferred<SessionSummary[] | undefined>()
  const { owner, diag } = ownerFor(presentation, reader({ list: async () => listed.promise }))
  t.after(() => { owner.dispose(); diag.dispose() })
  const handle = owner.open({ directMatch: { query: 'not-found', find: findSessionMatch } })
  presentation.requests[0]!.onQueryChange('manual query')
  listed.resolve([row('session-main-row')])

  assert.deepEqual(await handle.settlement, { kind: 'ready' })
  assert.equal(presentation.latest()?.query, 'manual query', 'a user edit during listing wins over the typed fallback')
  assert.equal(presentation.latest()?.rows[0]?.id, 'session-main-row')
  assert.deepEqual(presentation.initialQueries.filter((query) => query !== undefined), [],
    'a manually edited query never receives a programmatic initial-query seed')
})

test('a no-match typed Resume supplies a one-time initial-query seed', async (t) => {
  const presentation = new PresentationProbe()
  const listed = deferred<SessionSummary[] | undefined>()
  const { owner, diag } = ownerFor(presentation, reader({ list: async () => listed.promise }))
  t.after(() => { owner.dispose(); diag.dispose() })
  const handle = owner.open({ directMatch: { query: 'not-found', find: findSessionMatch } })
  listed.resolve([row('session-main-row')])

  assert.deepEqual(await handle.settlement, { kind: 'ready' })
  assert.equal(presentation.latest()?.query, 'not-found')
  assert.deepEqual(presentation.initialQueries.filter((query) => query !== undefined), ['not-found'])
})

test('metadata search re-evaluates when projection titles arrive after the Host page', async (t) => {
  const presentation = new PresentationProbe()
  const projection = deferred<Map<string, SessionProjectionSummary>>()
  const { owner, diag } = ownerFor(presentation, reader({
    list: async () => [row('session-title-arrives-late')],
    projectionBatch: async () => projection.promise,
    search: async () => ({ items: [], hasMore: false }),
  }))
  t.after(() => { owner.dispose(); diag.dispose() })
  owner.open()
  await waitUntil('unprojected list publishes', () => presentation.latest()?.listState === 'ready')
  presentation.requests[0]!.onQueryChange('needle')
  await waitUntil('empty Host page returns before projection', () => presentation.latest()?.searchState === 'ready')
  assert.deepEqual(presentation.latest()?.searchResults, [])
  projection.resolve(new Map([['session-title-arrives-late', { title: 'Needle arrives after content search' }]]))
  await waitUntil('late projection joins the metadata results', () => presentation.latest()?.searchResults[0]?.row.id === 'session-title-arrives-late')
  assert.equal(presentation.latest()?.searchResults[0]?.source, 'Metadata')
})

test('unavailable and failed content search preserve metadata results separately', async (t) => {
  for (const mode of ['unavailable', 'error'] as const) {
    const presentation = new PresentationProbe()
    const { owner, diag } = ownerFor(presentation, reader({
      list: async () => [row('session-needle')],
      search: mode === 'unavailable'
        ? async () => undefined
        : async () => { throw new Error('search failed') },
    }))
    t.after(() => { owner.dispose(); diag.dispose() })
    owner.open()
    await waitUntil(`${mode} list`, () => presentation.latest()?.listState === 'ready')
    presentation.requests[0]!.onQueryChange('needle')
    await waitUntil(`${mode} content result`, () => presentation.latest()?.searchState === mode)
    const snapshot = presentation.latest()!
    assert.equal(snapshot.searchResults[0]?.row.id, 'session-needle')
    assert.equal(snapshot.searchResults[0]?.source, 'Metadata')
    assert.equal(snapshot.hasMore, false)
    if (mode === 'unavailable') assert.equal(snapshot.searchError, undefined)
    else assert.match(snapshot.searchError ?? '', /search failed/u)
  }
})

test('aborted and stale query generations cannot publish late results', async (t) => {
  const presentation = new PresentationProbe()
  const calls: Array<{ query: string; signal: AbortSignal; result: ReturnType<typeof deferred<{ items: { sessionId: string; snippet: string }[]; hasMore: boolean }>> }> = []
  const read = reader({
    list: async () => [row('session-alpha'), row('session-beta')],
    search: (query, signal) => {
      assert.ok(signal)
      const result = deferred<{ items: { sessionId: string; snippet: string }[]; hasMore: boolean }>()
      calls.push({ query, signal, result })
      return result.promise
    },
  })
  const { owner, diag } = ownerFor(presentation, read)
  t.after(() => { owner.dispose(); diag.dispose() })
  const handle = owner.open()
  await waitUntil('initial list', () => presentation.latest()?.listState === 'ready')
  presentation.requests[0]!.onQueryChange('alpha')
  await waitUntil('first search starts', () => calls.length === 1)
  presentation.requests[0]!.onQueryChange('beta')
  assert.equal(calls[0]!.signal.aborted, true)
  await waitUntil('second search starts', () => calls.length === 2)
  calls[0]!.result.resolve({ items: [{ sessionId: 'session-alpha', snippet: 'stale' }], hasMore: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(presentation.latest()?.query, 'beta')
  assert.equal(presentation.latest()?.searchState, 'loading')
  calls[1]!.result.resolve({ items: [{ sessionId: 'session-beta', snippet: 'current' }], hasMore: false })
  await waitUntil('current search result', () => presentation.latest()?.searchState === 'ready')
  assert.deepEqual(presentation.latest()?.searchResults.map((result) => result.row.id), ['session-beta'])
  const beforeClose = presentation.latest()
  handle.close()
  assert.equal(presentation.closed[0], true)
  assert.equal(presentation.latest(), beforeClose, 'closed handles no longer receive snapshots')
})

test('closing and disposing during active Host searches abort and reject late pages', async (t) => {
  const presentation = new PresentationProbe()
  const calls: Array<{
    readonly signal: AbortSignal
    readonly result: ReturnType<typeof deferred<{ items: { sessionId: string; snippet: string }[]; hasMore: boolean }>>
  }> = []
  const { owner, diag } = ownerFor(presentation, reader({
    list: async () => [row('session-search-result')],
    search: (_query, signal) => {
      assert.ok(signal)
      const result = deferred<{ items: { sessionId: string; snippet: string }[]; hasMore: boolean }>()
      calls.push({ signal, result })
      return result.promise
    },
  }))
  t.after(() => { owner.dispose(); diag.dispose() })

  const first = owner.open()
  await waitUntil('first search panel list', () => presentation.latest(0)?.listState === 'ready')
  presentation.requests[0]!.onQueryChange('needle')
  await waitUntil('first Host search starts', () => calls.length === 1)
  const firstBeforeClose = presentation.latest(0)
  first.close()
  assert.equal(calls[0]!.signal.aborted, true)
  calls[0]!.result.resolve({ items: [{ sessionId: 'session-search-result', snippet: 'late close page' }], hasMore: false })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(presentation.latest(0), firstBeforeClose, 'a closed Reader cannot publish a late Host page')

  owner.open()
  await waitUntil('replacement search panel list', () => presentation.latest(1)?.listState === 'ready')
  presentation.requests[1]!.onQueryChange('needle')
  await waitUntil('replacement Host search starts', () => calls.length === 2)
  const secondBeforeDispose = presentation.latest(1)
  owner.dispose()
  assert.equal(calls[1]!.signal.aborted, true)
  assert.equal(presentation.closed[1], true)
  calls[1]!.result.resolve({ items: [{ sessionId: 'session-search-result', snippet: 'late dispose page' }], hasMore: false })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(presentation.latest(1), secondBeforeDispose, 'disposed owners cannot publish a late Host page')
})

test('opening a new panel cancels the prior Reader identity and ignores its late list', async (t) => {
  const presentation = new PresentationProbe()
  const first = deferred<SessionSummary[]>()
  const second = deferred<SessionSummary[]>()
  const signals: AbortSignal[] = []
  let calls = 0
  const { owner, diag } = ownerFor(presentation, reader({
    list: (_id, signal) => {
      assert.ok(signal)
      signals.push(signal)
      calls++
      return calls === 1 ? first.promise : second.promise
    },
  }))
  t.after(() => { owner.dispose(); diag.dispose() })
  owner.open()
  await waitUntil('first panel list begins', () => calls === 1)
  owner.open()
  assert.equal(presentation.closed[0], true)
  assert.equal(signals[0]?.aborted, true)
  await waitUntil('second panel list begins', () => calls === 2)
  const firstPanelBeforeLateResult = presentation.latest(0)
  first.resolve([row('session-stale-panel')])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(presentation.latest(0), firstPanelBeforeLateResult)
  second.resolve([row('session-current-panel')])
  await waitUntil('new panel owns its own list result', () => presentation.latest(1)?.rows[0]?.id === 'session-current-panel')
})

test('opening a new panel aborts a pending Host search before its late page can publish', async (t) => {
  const presentation = new PresentationProbe()
  const calls: Array<{
    readonly signal: AbortSignal
    readonly result: ReturnType<typeof deferred<{ items: { sessionId: string; snippet: string }[]; hasMore: boolean }>>
  }> = []
  const { owner, diag } = ownerFor(presentation, reader({
    list: async () => [row('session-search-result')],
    search: (_query, signal) => {
      assert.ok(signal)
      const result = deferred<{ items: { sessionId: string; snippet: string }[]; hasMore: boolean }>()
      calls.push({ signal, result })
      return result.promise
    },
  }))
  t.after(() => { owner.dispose(); diag.dispose() })

  owner.open()
  await waitUntil('old panel list', () => presentation.latest(0)?.listState === 'ready')
  presentation.requests[0]!.onQueryChange('needle')
  await waitUntil('old panel Host search starts', () => calls.length === 1)
  const oldPanelSnapshot = presentation.latest(0)
  owner.open()
  assert.equal(presentation.closed[0], true)
  assert.equal(calls[0]!.signal.aborted, true)
  await waitUntil('new panel list', () => presentation.latest(1)?.listState === 'ready')
  presentation.requests[1]!.onQueryChange('needle')
  await waitUntil('new panel Host search starts', () => calls.length === 2)
  const newPanelSnapshot = presentation.latest(1)

  calls[0]!.result.resolve({ items: [{ sessionId: 'session-search-result', snippet: 'stale panel page' }], hasMore: false })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(presentation.latest(0), oldPanelSnapshot)
  assert.equal(presentation.latest(1), newPanelSnapshot, 'the old panel cannot publish into its replacement')
  assert.deepEqual(presentation.latest(1)?.searchResults, [])

  calls[1]!.result.resolve({ items: [{ sessionId: 'session-search-result', snippet: 'current panel page' }], hasMore: false })
  await waitUntil('new panel search result', () => presentation.latest(1)?.searchState === 'ready')
  assert.equal(presentation.latest(1)?.searchResults[0]?.snippet, 'current panel page')
})

test('closed panels abort projection and reject a late enrichment result', async (t) => {
  const presentation = new PresentationProbe()
  const projection = deferred<Map<string, SessionProjectionSummary>>()
  let projectionSignal: AbortSignal | undefined
  const { owner, diag } = ownerFor(presentation, reader({
    list: async () => [row('session-projection')],
    projectionBatch: async (_batch, signal) => {
      assert.ok(signal)
      projectionSignal = signal
      return projection.promise
    },
  }))
  t.after(() => { owner.dispose(); diag.dispose() })
  const handle = owner.open()
  await waitUntil('projection batch begins', () => projectionSignal !== undefined)
  await waitUntil('baseline row publishes', () => presentation.latest()?.listState === 'ready')
  const beforeClose = presentation.latest()
  handle.close()
  assert.equal(projectionSignal?.aborted, true)
  projection.resolve(new Map([['session-projection', { title: 'late stale title' }]]))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(presentation.latest(), beforeClose, 'a late projection cannot repaint a closed panel')
})

test('captured subject retirement cancels its reader before it can publish', async (t) => {
  const presentation = new PresentationProbe()
  let current = true
  let listSignal: AbortSignal | undefined
  const { owner, diag } = ownerFor(presentation, reader({
    list: async (_id, signal) => {
      assert.ok(signal)
      listSignal = signal
      return new Promise<SessionSummary[]>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      })
    },
  }), { isCurrent: () => current })
  t.after(() => { owner.dispose(); diag.dispose() })
  owner.open()
  await waitUntil('list read begins', () => listSignal !== undefined)
  current = false
  presentation.requests[0]!.onQueryChange('stale')
  await waitUntil('captured panel retired', () => presentation.closed[0] === true)
  assert.equal(listSignal?.aborted, true)
})

test('an already-disposed presentation handle starts NO listing and leaves the owner reopenable', async (t) => {
  const diag = DIAG()
  let listCalls = 0
  // ONE owner, two sequenced presentations: the first refuses the panel with an
  // inert handle, the second admits it. That proves the owner itself went
  // inactive after the refusal instead of only proving another owner works.
  const probe = new PresentationProbe()
  const admitting: SessionBrowserPresentation = {
    open: (request) => probe.open(request),
    notify: (message) => probe.notify(message),
  }
  let refuse = true
  const refusing: SessionBrowserPresentation = {
    open: (request) => {
      if (!refuse) return admitting.open(request)
      probe.requests.push(request)
      return { isDisposed: () => true, setSnapshot() {}, close() {} }
    },
    notify: (message) => probe.notify(message),
  }
  const owner = createSessionBrowserReadOwner({
    reader: reader({ list: async () => { listCalls += 1; return [] } }),
    presentation: refusing,
    captureSubject: () => captured(),
    diag,
  })
  t.after(() => { owner.dispose(); diag.dispose() })
  const refused = owner.open()
  assert.deepEqual(await refused.settlement, { kind: 'cancelled' },
    'the refused panel settles as cancelled instead of hanging')
  // `startList` runs its reader through `runOwned`, which invokes the factory
  // synchronously, so a zero call count is already a decisive fact here: no
  // observation window is needed.
  assert.equal(listCalls, 0, 'a hidden listing must never run behind an inert presentation')
  refuse = false
  const admitted = owner.open()
  await waitUntil('the SAME owner lists after the refusal', () => probe.latest()?.listState === 'empty')
  assert.equal(listCalls, 1, 'exactly the admitted panel read the listing')
  assert.deepEqual(await admitted.settlement, { kind: 'ready' },
    'the admitted panel settles its own listing outcome')
})

test('a direct resume accepts the intent but the resume settlement carries the real switch outcome', async () => {
  const presentation = new PresentationProbe()
  let settleResume!: (outcome: import('../../src/app/command/session-browser-read.ts').SessionBrowserResumeSettlement) => void
  const { owner } = ownerFor(presentation, reader({ list: async () => [row('session-target')] }), {
    onResumeIntent: (_intent, _scope, settle) => { settleResume = settle },
  })
  const handle = owner.open({ directMatch: { query: 'target', find: findSessionMatch } })
  assert.deepEqual(await handle.settlement, { kind: 'matched', sessionId: 'session-target' },
    'the read owner accepts the matched row')
  let resolved: import('../../src/app/command/session-browser-read.ts').SessionBrowserResumeSettlement | undefined
  void handle.resumeSettlement.then(outcome => { resolved = outcome })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(resolved, undefined, 'acceptance is not a committed switch')
  settleResume({ kind: 'failed', text: 'session open failed: lease held' })
  assert.deepEqual(await handle.resumeSettlement, { kind: 'failed', text: 'session open failed: lease held' })
})

test('a failed resume attempt re-enables the panel and each intent settles independently', async () => {
  const presentation = new PresentationProbe()
  const settles: Array<(outcome: import('../../src/app/command/session-browser-read.ts').SessionBrowserResumeSettlement) => void> = []
  const { owner } = ownerFor(presentation, reader({ list: async () => [row('session-target'), row('session-other')] }), {
    onResumeIntent: (_intent, _scope, settle) => { settles.push(settle) },
  })
  const handle = owner.open()
  assert.deepEqual(await handle.settlement, { kind: 'ready' })
  const request = presentation.requests[0]!
  request.onResumeIntent({ sessionId: 'session-target', currentSessionId: 'session-current', source: 'enter' })
  await waitUntil('first resume accepted', () => presentation.latest()?.resumePending === true, 3_000)
  settles[0]!({ kind: 'failed', text: 'lease held' })
  await waitUntil('the failed attempt clears pending', () => presentation.latest()?.resumePending === false, 3_000)
  request.onResumeIntent({ sessionId: 'session-other', currentSessionId: 'session-current', source: 'enter' })
  await waitUntil('the retry is accepted', () => presentation.latest()?.resumePending === true, 3_000)
  // A LATE settle from the FIRST attempt must not clear the SECOND attempt.
  settles[0]!({ kind: 'switched', sessionId: 'session-target' })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(presentation.latest()?.resumePending, true,
    'the older attempt must not settle the newer pending intent')
  settles[1]!({ kind: 'switched', sessionId: 'session-other' })
  await waitUntil('the retry settles pending', () => presentation.latest()?.resumePending === false, 3_000)
})
