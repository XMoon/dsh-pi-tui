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
import type {
  SessionInspectorData,
  SessionInspectorReadResult,
  SessionInspectorSource,
  SessionWorkspaceFactsPort,
} from '../../src/runtime/session-workspace-facts-port.ts'
import { inertActivityObservation } from '../support/session-workspace-facts-fake.ts'
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
    readonly sessionWorkspaceFacts?: SessionWorkspaceFactsPort
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
    ...(options.sessionWorkspaceFacts === undefined ? {} : { sessionWorkspaceFacts: options.sessionWorkspaceFacts }),
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

test('typed direct resume matches a unique main-session prefix only', async (t) => {
  const presentation = new PresentationProbe()
  const intents: SessionBrowserResumeIntent[] = []
  let listCalls = 0
  const { owner, diag } = ownerFor(presentation, reader({
    list: async () => {
      listCalls += 1
      return [
        row('session-subagent-first', { origin: 'subagent' }),
        row('session-main-second'),
      ]
    },
  }), { onResumeIntent: (intent) => intents.push(intent) })
  t.after(() => { owner.dispose(); diag.dispose() })
  const handle = owner.open({ directMatch: { query: 'session-main-sec', find: findSessionMatch } })

  assert.deepEqual(await handle.settlement, { kind: 'matched', sessionId: 'session-main-second' })
  assert.deepEqual(intents, [{
    sessionId: 'session-main-second',
    currentSessionId: 'session-current',
    source: 'direct',
  }], 'after excluding subagents, the unique main-session prefix starts the one direct switch')
  assert.deepEqual(presentation.latest()?.rows.map((entry) => entry.id), ['session-main-second'],
    'the Browser presentation still excludes every subagent row')
  assert.equal(presentation.closed[0], true, 'a direct match closes after the existing switch handoff starts')
  assert.equal(listCalls, 1, 'the typed match still uses the panel\'s ONE official list read')
})

test('an empty session- prefix never auto-resumes and seeds the global search', async (t) => {
  const presentation = new PresentationProbe()
  const intents: SessionBrowserResumeIntent[] = []
  const { owner, diag } = ownerFor(presentation, reader({
    list: async () => [row('session-subagent-first', { origin: 'subagent' }), row('session-main-second')],
  }), { onResumeIntent: (intent) => intents.push(intent) })
  t.after(() => { owner.dispose(); diag.dispose() })
  const handle = owner.open({ directMatch: { query: 'session-', find: findSessionMatch } })

  assert.deepEqual(await handle.settlement, { kind: 'ready' })
  assert.deepEqual(intents, [], 'an empty prefix never resolves a main row and never starts a switch')
  assert.equal(presentation.closed[0], false, 'the Browser stays open on the shared search')
  assert.deepEqual(presentation.initialQueries.filter((query) => query !== undefined), ['session-'],
    'the same original text seeds the global search once')
  assert.equal(presentation.latest()?.query, 'session-')
})

test('typed direct resume lets a full exact id win over an earlier main prefix candidate', async (t) => {
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

  assert.deepEqual(await handle.settlement, { kind: 'matched', sessionId: 'session-alpha' })
  assert.deepEqual(intents, [{
    sessionId: 'session-alpha',
    currentSessionId: 'session-current',
    source: 'direct',
  }], 'the full exact id wins ahead of an earlier listed main prefix candidate')
  assert.deepEqual(presentation.latest()?.rows.map((entry) => entry.id), [
    'session-alpha-first-main',
    'session-alpha',
    'session-alpha-second-main',
  ], 'the excluded subagent does not disturb the ordered main candidate corpus')
  assert.equal(presentation.closed[0], true)
})

test('an ambiguous main-session prefix keeps the Browser open on the same global search', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => t.mock.timers.reset())
  const presentation = new PresentationProbe()
  const intents: SessionBrowserResumeIntent[] = []
  const searchQueries: string[] = []
  let listCalls = 0
  const { owner, diag } = ownerFor(presentation, reader({
    list: async () => {
      listCalls += 1
      return [row('session-alpha-first-main'), row('session-alpha-second-main')]
    },
    search: async (query) => {
      searchQueries.push(query)
      return { items: [], hasMore: false }
    },
  }), { onResumeIntent: (intent) => intents.push(intent) })
  t.after(() => { owner.dispose(); diag.dispose() })
  const handle = owner.open({ directMatch: { query: 'session-al', find: findSessionMatch } })

  assert.deepEqual(await handle.settlement, { kind: 'ready' })
  assert.deepEqual(intents, [], 'two main rows share the prefix: nothing is resumed')
  assert.equal(presentation.closed[0], false, 'the same Browser stays open on the ambiguous query')
  assert.deepEqual(presentation.initialQueries.filter((query) => query !== undefined), ['session-al'])
  assert.equal(presentation.latest()?.query, 'session-al', 'the original text is the search query')
  t.mock.timers.tick(249)
  assert.deepEqual(searchQueries, [], 'the Host content search still waits for its debounce')
  t.mock.timers.tick(1)
  assert.deepEqual(searchQueries, ['session-al'], 'one debounced Host search carries the same original text')
  assert.equal(listCalls, 1, 'the ambiguous fallback never starts a second list read')
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

test('an explicit refresh re-opens the ONE Activity observation so unfinished discovery is retried', async (t) => {
  const observations: Array<{ disposed: number }> = []
  const facts: SessionWorkspaceFactsPort = {
    readActivity: async () => [],
    observeActivity: () => {
      const record = { disposed: 0 }
      observations.push(record)
      return {
        setRoster() {},
        setPriorityIds() {},
        getSnapshot: () => ({ rosterRevision: 0, revision: 0, facts: [] }),
        subscribe: () => () => {},
        dispose: () => { record.disposed += 1 },
      }
    },
    followWorkspaces: () => ({
      dispose() {},
      isCurrent: () => true,
      async *[Symbol.asyncIterator]() { /* no frames in this read-only case */ },
    }),
  }
  const presentation = new PresentationProbe()
  const owner = createSessionBrowserReadOwner({
    reader: reader(),
    presentation,
    captureSubject: () => captured(),
    diag: DIAG(),
    sessionWorkspaceFacts: facts,
  })
  t.after(() => { owner.dispose() })
  owner.open()
  assert.equal(observations.length, 1, 'opening starts exactly ONE observation')
  owner.refresh()
  assert.equal(observations[0]!.disposed, 1, 'the explicit refresh disposes the unfinished observation')
  assert.equal(observations.length, 2, 'the refresh re-opens exactly ONE observation so failed discovery retries')
})

test('R17 an explicit refresh owns exactly ONE projection chain and an older chain cannot overwrite it', async (t) => {
  const presentation = new PresentationProbe()
  const listed = Array.from({ length: 45 }, (_, index) => row(`session-row-${String(index).padStart(2, '0')}`, { updatedAt: 1_000 - index }))
  let listRows = listed
  const calls: string[][] = []
  const held: Array<() => void> = []
  let holdNext = false
  const read = reader({
    list: async () => listRows,
    projectionBatch: async (batch) => {
      calls.push(batch.map(item => item.id))
      const stale = holdNext
      if (holdNext) {
        holdNext = false
        await new Promise<void>((resolve) => { held.push(resolve) })
      }
      return new Map(batch.map(item => [item.id, {
        title: stale ? `STALE ${item.id}` : `Fresh ${item.id}`,
      }]))
    },
  })
  const { owner, diag } = ownerFor(presentation, read)
  t.after(() => { owner.dispose(); diag.dispose() })
  owner.open()
  await waitUntil('the initial one-chain enrichment settles', () => calls.length === 2
    && presentation.latest()?.rows[0]?.title === `Fresh ${listed[0]!.id}`)
  calls.length = 0
  // An UNCHANGED explicit refresh still re-reads metadata, with exactly ONE
  // chain (a second simultaneous chain would double these calls).
  owner.refresh()
  await waitUntil('the unchanged refresh chain settles', () => calls.length === 2
    && presentation.latest()?.rows[0]?.title === `Fresh ${listed[0]!.id}`)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(calls.length, 2, 'an unchanged refresh runs exactly ONE projection chain')
  calls.length = 0
  // A changed refresh also runs exactly ONE chain (never one beside it).
  listRows = [...listed, row('session-new', { updatedAt: 2_000 })]
  owner.refresh()
  await waitUntil('the changed refresh chain settles', () => calls.length === 2
    && presentation.latest()?.rows.some(entry => entry.id === 'session-new' && entry.title === 'Fresh session-new') === true)
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(calls.length, 2, 'a changed refresh runs exactly ONE projection chain')
  calls.length = 0
  // A held older chain is retired: its late result can never overwrite the
  // newer accepted enrichment, and exactly one new chain starts.
  holdNext = true
  owner.refresh()
  await waitUntil('the held refresh chain starts', () => calls.length === 1)
  owner.refresh()
  // The newer chain must DISPATCH its own batch (not merely inherit the title
  // the previous refresh already proved).
  await waitUntil('the newer refresh chain dispatches', () => calls.length >= 2)
  await waitUntil('the newer refresh chain settles', () => presentation.latest()?.rows[0]?.title === `Fresh ${listed[0]!.id}`)
  held.splice(0).forEach(release => { release() })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.ok(!presentation.latest()?.rows.some(entry => entry.title?.startsWith('STALE ') === true),
    'a retired chain never writes its stale projection into the accepted roster')
})

// ── Session Workspace PR2: the ONE owner-side selected Inspector lifecycle ───

const INS_A = 'session-a'
const INS_B = 'session-b'
const INS_C = 'session-c'
const INS_DEBOUNCE_MS = 150

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

interface DeferredRead {
  readonly promise: Promise<SessionInspectorReadResult>
  readonly resolve: (result: SessionInspectorReadResult) => void
}

interface ProbeInspectorSource extends SessionInspectorSource {
  readonly sessionId: string
  readonly reads: number
  readonly active: number
  readonly disposed: number
}

interface ProbeSourceState {
  readonly probe: ProbeInspectorSource
  readonly invalidate: (reason: 'changed' | 'source-replaced') => void
  resolveNext(result: SessionInspectorReadResult): void
}

/** A caller-controlled Inspector source probe. A read stays pending until the
 *  case resolves it, which is what lets the owner's abort/fence semantics be
 *  observed without weakening them. */
class InspectorProbe {
  readonly states: ProbeSourceState[] = []
  maxActive = 0
  private active = 0

  open(sessionId: string, onInvalidated: (reason: 'changed' | 'source-replaced') => void): SessionInspectorSource {
    const pending: DeferredRead[] = []
    let reads = 0
    let disposed = 0
    const state: ProbeSourceState = {
      probe: {
        sessionId,
        get reads() { return reads },
        get active() { return pending.length },
        get disposed() { return disposed },
        read: (signal: AbortSignal) => {
          if (disposed > 0) return Promise.reject(new Error('the disposed probe source was read'))
          if (signal.aborted) return Promise.reject(new Error('the probe source was read with an aborted signal'))
          reads += 1
          this.active += 1
          this.maxActive = Math.max(this.maxActive, this.active)
          let resolve!: (result: SessionInspectorReadResult) => void
          const promise = new Promise<SessionInspectorReadResult>((done) => { resolve = done })
          pending.push({ promise, resolve })
          return promise.finally(() => { this.active -= 1 })
        },
        dispose: () => { disposed += 1 },
      },
      invalidate: (reason) => {
        if (disposed > 0) return
        onInvalidated(reason)
      },
      resolveNext: (result) => {
        const entry = pending.shift()
        assert.ok(entry !== undefined, `the ${sessionId} source has no pending read to resolve`)
        entry.resolve(result)
      },
    }
    this.states.push(state)
    return state.probe
  }

  sourcesOf(sessionId: string): ProbeInspectorSource[] {
    return this.states.filter(state => state.probe.sessionId === sessionId).map(state => state.probe)
  }
}

function inspectorFactsOf(probe: InspectorProbe): SessionWorkspaceFactsPort {
  return {
    readActivity: async () => [],
    observeActivity: () => inertActivityObservation(),
    followWorkspaces: () => ({
      isCurrent: () => true,
      dispose: () => {},
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<never> {
        await new Promise<void>(() => {})
      },
    }),
    openInspector: (sessionId, onInvalidated) => probe.open(sessionId, onInvalidated),
  }
}

function inspectorData(sessionId: string, turns: number, asOfSeq = turns): SessionInspectorData {
  return {
    sessionId,
    asOfSeq,
    stats: {
      turns,
      steps: turns,
      llmMs: 10,
      toolMs: 0,
    },
  }
}

async function inspectorOwner(
  t: { after(fn: () => unknown): void },
  probe: InspectorProbe,
  options: {
    readonly presentation?: PresentationProbe
    readonly rows?: readonly SessionSummary[]
    readonly facts?: SessionWorkspaceFactsPort
  } = {},
): Promise<{
  readonly presentation: PresentationProbe
  readonly owner: ReturnType<typeof createSessionBrowserReadOwner>
  readonly request: SessionBrowserPanelRequest
  setRows(rows: readonly SessionSummary[]): void
}> {
  const presentation = options.presentation ?? new PresentationProbe()
  let rows: SessionSummary[] = [...(options.rows ?? [row(INS_A), row(INS_B), row(INS_C)])]
  const { owner, diag } = ownerFor(presentation, reader({ list: async () => rows }), {
    ...(options.facts === undefined
      ? { sessionWorkspaceFacts: inspectorFactsOf(probe) }
      : { sessionWorkspaceFacts: options.facts }),
  })
  t.after(() => { owner.dispose(); diag.dispose() })
  owner.open()
  await waitUntil('the Inspector owner roster', () =>
    presentation.latest()?.rows.some(entry => entry.id === INS_A) === true)
  return {
    presentation,
    owner,
    request: presentation.requests[0]!,
    setRows: (next) => { rows = [...next] },
  }
}

test('INS-O1 a settled selection is ONE read after the debounce; rapid moves coalesce and same-id repaint is inert', async (t) => {
  const probe = new InspectorProbe()
  const h = await inspectorOwner(t, probe)
  await delay(INS_DEBOUNCE_MS + 50)
  assert.equal(probe.states.length, 0, 'no selection means zero Inspector sources and zero reads')

  h.request.onInspectorSelection!(INS_A)
  h.request.onInspectorSelection!(INS_B)
  await delay(50)
  h.request.onInspectorSelection!(INS_C)
  await waitUntil('the final selected read', () => probe.sourcesOf(INS_C)[0]?.reads === 1)
  assert.equal(probe.sourcesOf(INS_A)[0]?.reads ?? 0, 0, 'the superseded A never reads')
  assert.equal(probe.sourcesOf(INS_B)[0]?.reads ?? 0, 0, 'the superseded B never reads')
  assert.equal(probe.sourcesOf(INS_A)[0]?.disposed, 1, 'each superseded source is released once')
  assert.equal(probe.sourcesOf(INS_B)[0]?.disposed, 1)
  await waitUntil('the loading Inspector cut', () => h.presentation.latest()?.inspector?.state === 'loading')

  probe.states.find(state => state.probe.sessionId === INS_C)!.resolveNext({
    kind: 'ready',
    data: inspectorData(INS_C, 1),
  })
  await waitUntil('the exact selected Inspector cut', () =>
    h.presentation.latest()?.inspector?.state === 'ready'
    && (h.presentation.latest()?.inspector as { data?: SessionInspectorData }).data?.stats?.turns === 1)
  const reads = probe.sourcesOf(INS_C)[0]!.reads
  h.request.onInspectorSelection!(INS_C)
  await delay(INS_DEBOUNCE_MS + 50)
  assert.equal(probe.sourcesOf(INS_C)[0]!.reads, reads, 'a same-id repaint never starts a second read')
  assert.equal(probe.sourcesOf(INS_C).length, 1, 'a same-id repaint never recreates the source')

  h.request.onInspectorSelection!(undefined)
  await waitUntil('the cleared Inspector state', () => h.presentation.latest()?.inspector === undefined)
  assert.equal(probe.sourcesOf(INS_C)[0]!.disposed, 1, 'clearing the selection releases the source')
})

test('INS-O2 A→B→A keeps ONE physical flight; only the latest A read commits', async (t) => {
  const probe = new InspectorProbe()
  const h = await inspectorOwner(t, probe)
  h.request.onInspectorSelection!(INS_A)
  await waitUntil('the first A read', () => probe.sourcesOf(INS_A)[0]?.reads === 1)

  h.request.onInspectorSelection!(INS_B)
  await delay(20)
  h.request.onInspectorSelection!(INS_A)
  await delay(INS_DEBOUNCE_MS + 70)
  assert.equal(probe.sourcesOf(INS_A).length, 2, 'A→B→A opens a fresh A source')
  assert.equal(probe.sourcesOf(INS_B)[0]!.reads, 0, 'the B intent never becomes a read while A is unsettled')
  assert.equal(probe.sourcesOf(INS_A)[1]!.reads, 0, 'the new A read waits for the unsettled physical slot')
  assert.equal(probe.maxActive, 1, 'at most ONE physical Inspector read is ever in flight')

  // The OLD A promise settles after its source/epoch is gone: it must not paint.
  probe.states.find(state => state.probe.sessionId === INS_A)!.resolveNext({
    kind: 'ready',
    data: inspectorData(INS_A, 99),
  })
  await waitUntil('the latest A read after the old settle', () => probe.sourcesOf(INS_A)[1]!.reads === 1)
  const latest = probe.states.filter(state => state.probe.sessionId === INS_A).at(-1)!
  latest.resolveNext({ kind: 'ready', data: inspectorData(INS_A, 2) })
  await waitUntil('the latest A cut', () =>
    h.presentation.latest()?.inspector?.state === 'ready'
    && (h.presentation.latest()?.inspector as { data?: SessionInspectorData }).data?.stats?.turns === 2)
  assert.equal(probe.maxActive, 1, 'the trailing read reused the ONE physical slot')
})

test('INS-O3 same-source changes coalesce ONE trailing read and a source replacement revokes the old cut', async (t) => {
  const probe = new InspectorProbe()
  const h = await inspectorOwner(t, probe)
  h.request.onInspectorSelection!(INS_A)
  await waitUntil('the first exact read', () => probe.sourcesOf(INS_A)[0]?.reads === 1)
  probe.states[0]!.resolveNext({ kind: 'ready', data: inspectorData(INS_A, 1) })
  await waitUntil('the first exact cut', () => h.presentation.latest()?.inspector?.state === 'ready')

  const source = probe.states[0]!
  source.invalidate('changed')
  source.invalidate('changed')
  await waitUntil('the refreshing cut', () =>
    (h.presentation.latest()?.inspector as { refreshing?: boolean } | undefined)?.refreshing === true)
  await waitUntil('the ONE trailing read', () => source.probe.reads === 2)
  await delay(INS_DEBOUNCE_MS + 50)
  assert.equal(source.probe.reads, 2, 'two relevant changes coalesce into exactly one trailing read')
  source.resolveNext({ kind: 'ready', data: inspectorData(INS_A, 2) })
  await waitUntil('the fresh trailing cut', () =>
    h.presentation.latest()?.inspector?.state === 'ready'
    && (h.presentation.latest()?.inspector as { data?: SessionInspectorData }).data?.stats?.turns === 2
    && (h.presentation.latest()?.inspector as { refreshing?: boolean }).refreshing === false)

  source.invalidate('source-replaced')
  await waitUntil('the revoked exact cut', () => h.presentation.latest()?.inspector?.state === 'loading')
  await waitUntil('the replacement read', () => source.probe.reads === 3)
  source.resolveNext({ kind: 'ready', data: inspectorData(INS_A, 3) })
  await waitUntil('the re-proved cut', () =>
    h.presentation.latest()?.inspector?.state === 'ready'
    && (h.presentation.latest()?.inspector as { data?: SessionInspectorData }).data?.stats?.turns === 3)
  assert.equal(probe.states.length, 1, 'a source replacement reuses the ONE selected source')
})

test('INS-O4 a metadata-only roster revision keeps the cut; a removed target clears it and invalidates a late read', async (t) => {
  const probe = new InspectorProbe()
  const h = await inspectorOwner(t, probe)
  h.request.onInspectorSelection!(INS_A)
  await waitUntil('the ready Inspector cut', () => probe.states[0]?.probe.reads === 1)
  probe.states[0]!.resolveNext({ kind: 'ready', data: inspectorData(INS_A, 1) })
  await waitUntil('the published exact cut', () => h.presentation.latest()?.inspector?.state === 'ready')
  const accepted = h.presentation.latest()!.inspector

  h.setRows([row(INS_A, { title: 'renamed' }), row(INS_B), row(INS_C)])
  h.owner.refresh()
  await waitUntil('the metadata roster revision', () => h.presentation.latest()?.rows[0]?.title === 'renamed')
  assert.deepEqual(h.presentation.latest()!.inspector, accepted,
    'an ordinary metadata roster revision never invalidates the selected exact cut')
  assert.equal(probe.states[0]!.probe.reads, 1, 'an ordinary metadata roster revision never re-reads')

  probe.states[0]!.invalidate('changed')
  await waitUntil('a pending trailing read', () => probe.states[0]!.probe.reads === 2)
  h.setRows([row(INS_B), row(INS_C)])
  h.owner.refresh()
  await waitUntil('the removed target cleared', () => h.presentation.latest()?.inspector === undefined)
  probe.states[0]!.resolveNext({ kind: 'ready', data: inspectorData(INS_A, 9) })
  await delay(50)
  assert.equal(h.presentation.latest()?.inspector, undefined,
    'a late read of a removed target never repaints an exact Inspector cut')
  assert.equal(probe.states[0]!.probe.disposed, 1, 'the removed target source is released')
})

test('INS-O5 retire/dispose clears the timer/source and ignores the late settlement', async (t) => {
  const probe = new InspectorProbe()
  const h = await inspectorOwner(t, probe)
  h.request.onInspectorSelection!(INS_A)
  await waitUntil('the pending exact read', () => probe.states[0]?.probe.reads === 1)
  const snapshots = h.presentation.snapshots.length
  h.owner.dispose()
  assert.equal(probe.states[0]!.probe.disposed, 1, 'dispose releases the selected source')
  probe.states[0]!.resolveNext({ kind: 'ready', data: inspectorData(INS_A, 1) })
  await delay(INS_DEBOUNCE_MS + 50)
  assert.equal(h.presentation.snapshots.length, snapshots, 'a late read after retire publishes nothing')
  assert.equal(probe.states[0]!.probe.reads, 1, 'retire starts no replacement read')
})

test('INS-O6 an omitted Inspector capability is a truthful unavailable state with zero reads', async (t) => {
  const presentation = new PresentationProbe()
  const { owner, diag } = ownerFor(presentation, reader({ list: async () => [row(INS_A)] }))
  t.after(() => { owner.dispose(); diag.dispose() })
  owner.open()
  await waitUntil('the roster without a facts port', () => presentation.latest()?.rows.length === 1)
  presentation.requests[0]!.onInspectorSelection!(INS_A)
  await waitUntil('the unavailable Inspector state', () =>
    presentation.latest()?.inspector?.state === 'unavailable')
  assert.equal(presentation.latest()?.inspector?.sessionId, INS_A)
})

test('INS-O7 a synchronous open-time selection is ignored until the handle and first-ready roster exist', async (t) => {
  class SyncReportingProbe extends PresentationProbe {
    override open(request: SessionBrowserPanelRequest): SessionBrowserPanelHandle {
      const handle = super.open(request)
      // A real renderer may paint during open; the read owner must not admit a
      // read before its handle is installed and its first roster accepted.
      request.onInspectorSelection?.(INS_A)
      return handle
    }
  }
  const probe = new InspectorProbe()
  const presentation = new SyncReportingProbe()
  const h = await inspectorOwner(t, probe, { presentation })
  assert.equal(probe.states.length, 0, 'the open-time report starts no source/read')
  h.request.onInspectorSelection!(INS_A)
  await waitUntil('the post-open selection source', () => probe.sourcesOf(INS_A).length === 1)
})

test('INS-O8 a typed direct resume that closes the panel starts no Inspector read', async (t) => {
  class SyncReportingProbe extends PresentationProbe {
    override open(request: SessionBrowserPanelRequest): SessionBrowserPanelHandle {
      const handle = super.open(request)
      request.onInspectorSelection?.(INS_A)
      return handle
    }
  }
  const probe = new InspectorProbe()
  const presentation = new SyncReportingProbe()
  const { owner, diag } = ownerFor(presentation, reader({ list: async () => [row(INS_A)] }), {
    sessionWorkspaceFacts: inspectorFactsOf(probe),
    onResumeIntent: () => {},
  })
  t.after(() => { owner.dispose(); diag.dispose() })
  owner.open({
    directMatch: {
      query: INS_A,
      find: rows => rows.find(entry => entry.id === INS_A),
    },
  })
  await waitUntil('the direct-match close', () => presentation.closed[0] === true)
  await delay(INS_DEBOUNCE_MS + 50)
  assert.equal(probe.states.length, 0, 'a typed direct resume that retires the panel never starts a read')
})
