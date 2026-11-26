/**
 * TSP Ctrl+R over the Remote accepted-history owner.
 *
 * The TSP seat consumes the SAME `createRemoteHistorySeat` the PiTui panel
 * consumes. This suite drives the seat's public intents (keys, pointer intents
 * and the native node handlers the card projects) against a structural
 * `HistorySearchReadPort` and a structural `RemoteHistoryOpenScope`, and reads
 * the committed card projection the `historySearchView` really paints: the
 * shared owner owns query/page/body/currentness, while the TSP seat keeps only
 * the query caret, scroll/reveal, selection identity and presentation.
 *
 * EVIDENCE LEVEL: seat + card projection. The real wire mount, the official
 * SDK and the native click dispatch are `test/tui/tern-tsp-history-search.test.ts`
 * and the application composition lane; this file owns the Remote-only state
 * contract (default scope, Down-at-tail More, failure Retry, exact-body gating,
 * stale-frame refusal and owner disposal).
 * @module @xmoon76/dsh-pi-tui/tern-tsp-history-remote.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import type { Key, KeyName, Node } from '@stencil-hq/tern'
import type {
  HistoryReadTextRequest,
  HistoryReadTextResponse,
  HistorySearchItem,
  HistorySearchRequest,
  HistorySearchResponse,
} from '../../src/runtime/remote/pi-tui-history-search-contract.ts'
import type { HistorySearchReadPort } from '../../src/runtime/history-search-read-port.ts'
import type { RemoteHistoryOpenScope } from '../../src/client/history/remote-scope.ts'
import {
  RemoteHistorySearchDeniedError,
  RemoteHistorySearchFailedError,
} from '../../src/runtime/remote/history-search-remote.ts'
import { createTspHistorySearch, type TspHistorySearchIntent, type TspHistorySearchSeat } from '../../src/tui/tsp/history-search.ts'
import { createRemoteHistorySeat } from '../../src/runtime/history-search-seat.ts'
import {
  historySearchView,
  HISTORY_SEARCH_ROLES,
} from '../../src/tui/tsp/history-search-view.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

interface ScriptedPort {
  readonly port: HistorySearchReadPort
  readonly searchRequests: HistorySearchRequest[]
  readonly readRequests: HistoryReadTextRequest[]
  pendingSearches(): number
  pendingReads(): number
  lastSearchRequest(): HistorySearchRequest
  lastReadRequest(): HistoryReadTextRequest
  answerSearch(response: HistorySearchResponse): void
  failSearch(error: unknown): void
  answerRead(response: HistoryReadTextResponse): void
  failRead(error: unknown): void
}

type Pending<T, R> = Deferred<T> & { readonly request: R }

function createScriptedPort(): ScriptedPort {
  const searchRequests: HistorySearchRequest[] = []
  const readRequests: HistoryReadTextRequest[] = []
  const searches: Array<Pending<HistorySearchResponse, HistorySearchRequest>> = []
  const reads: Array<Pending<HistoryReadTextResponse, HistoryReadTextRequest>> = []

  const enqueue = <T, R>(queue: Array<Pending<T, R>>, request: R, signal: AbortSignal): Promise<T> => {
    const entry = { ...deferred<T>(), request }
    queue.push(entry)
    const remove = (): void => {
      const at = queue.indexOf(entry)
      if (at >= 0) queue.splice(at, 1)
    }
    signal.addEventListener('abort', () => {
      remove()
      entry.reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
    if (signal.aborted) remove()
    return entry.promise
  }

  const take = <T, R>(queue: Array<Pending<T, R>>): Pending<T, R> => {
    const entry = queue.pop()
    assert.ok(entry, 'the seat issued the expected read')
    return entry
  }

  return {
    port: {
      search(request, signal) {
        searchRequests.push(request)
        return enqueue(searches, request, signal)
      },
      readText(request, signal) {
        readRequests.push(request)
        return enqueue(reads, request, signal)
      },
    },
    searchRequests,
    readRequests,
    pendingSearches: () => searches.length,
    pendingReads: () => reads.length,
    lastSearchRequest: () => {
      const request = searchRequests.at(-1)
      assert.ok(request, 'a search request exists')
      return request
    },
    lastReadRequest: () => {
      const request = readRequests.at(-1)
      assert.ok(request, 'a read request exists')
      return request
    },
    answerSearch: (response) => { take(searches).resolve(response) },
    failSearch: (error) => { take(searches).reject(error) },
    answerRead: (response) => { take(reads).resolve(response) },
    failRead: (error) => { take(reads).reject(error) },
  }
}

interface TestScope {
  readonly face: RemoteHistoryOpenScope
  readonly sessionId: string | undefined
  disposeCount(): number
  subscribeCount(): number
  invalidate(): void
  setDirectory(next: { readonly available: boolean; readonly cwd?: string; readonly reason?: string }): void
}

function createScope(sessionId: string | undefined, initialDirectory?: { readonly available: boolean; readonly cwd?: string; readonly reason?: string }): TestScope {
  let disposed = 0
  let subscriptions = 0
  let invalidated = false
  let directory: { readonly available: boolean; readonly cwd?: string; readonly reason?: string } = initialDirectory ?? {
    available: true,
    cwd: '/host/dir',
  }
  const listeners = new Set<() => void>()
  const face: RemoteHistoryOpenScope = {
    initialScope: sessionId === undefined ? 'all' : 'session',
    directory: () => directory,
    isCurrent: () => !invalidated && disposed === 0,
    subscribe(listener) {
      subscriptions += 1
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      disposed += 1
      listeners.clear()
    },
  }
  return {
    face,
    sessionId,
    disposeCount: () => disposed,
    subscribeCount: () => subscriptions,
    invalidate() {
      invalidated = true
      for (const listener of [...listeners]) listener()
    },
    setDirectory(next) {
      directory = next
      for (const listener of [...listeners]) listener()
    },
  }
}

interface SeatOptions {
  /** `null` = a sessionless Remote open. */
  readonly sessionId?: string | null
  readonly composerWritable?: boolean
  readonly directory?: { readonly available: boolean; readonly cwd?: string; readonly reason?: string }
}

interface Copied {
  readonly raw: string
  readonly live: boolean
}

interface SeatHarness {
  readonly seat: TspHistorySearchSeat
  readonly port: ScriptedPort
  readonly scopes: TestScope[]
  scope(): TestScope
  readonly copies: Copied[]
  readonly restored: string[]
  renders(): number
  sourceCalls(): number
}

function makeSeat(t: { after(fn: () => unknown): void }, options: SeatOptions = {}): SeatHarness {
  const sessionId = options.sessionId === null ? undefined : options.sessionId ?? 'ses_a'
  const scopes: TestScope[] = []
  const port = createScriptedPort()
  const copies: Copied[] = []
  const restored: string[] = []
  let renders = 0
  let sourceCalls = 0
  const cwd = '/client/cwd'
  const diag = {
    debug(): void {},
    info(): void {},
    warn(): void {},
    error(): void {},
    dispose(): void {},
  }
  const seat = createTspHistorySearch({
    admitted: () => true,
    requestRender: () => { renders += 1 },
    setFocus: () => {},
    restoreToComposer: (raw) => { restored.push(raw) },
    composerWritable: () => options.composerWritable ?? true,
    copyRaw: (raw, live) => { copies.push({ raw, live: live() }) },
    reveal: () => {},
    scroll: () => {},
    reportFatal: (error) => { throw error },
    reportSecondaryFailure: () => {},
  }, {
    // The Remote path must never read the Direct file source; a call here is a
    // routing regression, not an empty-history fallback.
    source: {
      search: () => {
        sourceCalls += 1
        return Promise.reject(new Error('the Direct file source must not be read on a Remote open'))
      },
    },
    cwd: () => cwd,
    captureScope: () => {
      const scope = createScope(sessionId, options.directory)
      scopes.push(scope)
      return { sessionId, isCurrent: () => scope.face.isCurrent(), remote: scope.face }
    },
    read: port.port,
    createRemoteSeat: createRemoteHistorySeat,
    diag,
  }, () => true)
  t.after(() => { seat.retire() })
  return {
    seat,
    port,
    scopes,
    scope: () => {
      const scope = scopes.at(-1)
      assert.ok(scope, 'the seat captured one Host scope')
      return scope
    },
    copies,
    restored,
    renders: () => renders,
    sourceCalls: () => sourceCalls,
  }
}

function key(name: KeyName, modifiers: Partial<Pick<Key, 'ctrl' | 'alt' | 'shift' | 'meta'>> = {}): Key {
  return {
    name,
    ctrl: modifiers.ctrl ?? false,
    alt: modifiers.alt ?? false,
    shift: modifiers.shift ?? false,
    meta: modifiers.meta ?? false,
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

interface RowOptions {
  readonly preview?: string
  readonly cwd?: string | null
  readonly sessionId?: string
  readonly hasNonText?: boolean
}

function row(index: number, text: string, options: RowOptions = {}): HistorySearchItem {
  return {
    sessionId: options.sessionId ?? 'ses_a',
    messageId: `m${String(index)}`,
    firstEventSeq: index,
    acceptedAt: 1_760_000_000_000 + index * 1_000,
    effectiveCwd: options.cwd === undefined ? '/host/dir' : options.cwd,
    preview: options.preview ?? text,
    contentLength: text.length,
    contentSha256: sha256(text),
    hasNonText: options.hasNonText ?? false,
  }
}

function page(items: readonly HistorySearchItem[], nextCursor: string | null = null): HistorySearchResponse {
  return { kind: 'ready', generation: 'gen-1', items, nextCursor }
}

function body(text: string): HistoryReadTextResponse {
  return { kind: 'ready', chunk: text, nextOffset: null, contentLength: text.length }
}

function nodesOf(node: Node): Node[] {
  const out: Node[] = []
  const visit = (current: Node): void => {
    out.push(current)
    for (const child of current.children) visit(child)
  }
  visit(node)
  return out
}

function cardNodes(seat: TspHistorySearchSeat, onIntent?: (intent: TspHistorySearchIntent) => void): Node[] {
  const state = seat.renderState()
  assert.ok(state, 'the card is painted')
  return nodesOf(historySearchView({ state, onIntent: onIntent ?? (() => {}), wide: true }))
}

function roleNode(seat: TspHistorySearchSeat, role: string): Node | undefined {
  return cardNodes(seat).find((node) => node.props['role'] === role)
}

function textOf(node: Node): string {
  const text = node.props['text']
  if (typeof text === 'string') return text
  const spans = node.props['spans']
  if (Array.isArray(spans)) {
    return spans.map((entry) => {
      if (typeof entry === 'string') return entry
      if (entry !== null && typeof entry === 'object' && typeof (entry as { readonly t?: unknown }).t === 'string') {
        return String((entry as { readonly t: string }).t)
      }
      return ''
    }).join('')
  }
  return node.children.map(textOf).join('')
}

function disabled(node: Node | undefined): boolean {
  assert.ok(node, 'the action node exists')
  const attrs = node.props['attrs']
  return typeof attrs === 'object' && attrs !== null
    && (attrs as Record<string, unknown>)['aria-disabled'] === 'true'
}

function click(node: Node | undefined): void {
  assert.ok(node, 'the native action node exists')
  assert.equal(node.kind, 'el', 'the action is a native HTML element')
  assert.equal(node.props['tag'], 'button', 'the action is a real native button')
  const handler = node.handlers?.onClick
  assert.ok(handler, 'the native button carries its click handler')
  handler({} as never)
}

/** The card projection routes a native click through the SAME seat intent a
 *  key produces; this is the real node handler, not a synthetic action. */
function clickRole(seat: TspHistorySearchSeat, role: string): void {
  const node = cardNodes(seat, (intent) => seat.handleIntent(intent))
    .find((candidate) => candidate.props['role'] === role)
  click(node)
}

/** Deliver a click from a PAINTED state that is no longer current: the node's
 *  own handler mints its old serial/revision/page identity. */
function clickStaleRole(
  seat: TspHistorySearchSeat,
  state: NonNullable<ReturnType<TspHistorySearchSeat['renderState']>>,
  role: string,
): void {
  const node = nodesOf(historySearchView({
    state,
    onIntent: (intent) => seat.handleIntent(intent),
    wide: true,
  })).find((candidate) => candidate.props['role'] === role)
  click(node)
}

// ── A. Open and commit ───────────────────────────────────────────────────────

test('a Remote open creates ONE shared owner, reads the Session default and commits the rows', async (t) => {
  const h = makeSeat(t)
  h.seat.open()
  await waitUntil('the first Remote search request', () => h.port.pendingSearches() === 1)
  const request = h.port.lastSearchRequest()
  assert.deepEqual(
    {
      scope: request.scope,
      sessionId: 'sessionId' in request ? request.sessionId : undefined,
      query: request.query,
      limit: request.limit,
      cwd: 'cwd' in request ? request.cwd : undefined,
    },
    { scope: 'session', sessionId: 'ses_a', query: '', limit: 25, cwd: undefined },
    'the Remote open uses the Session default scope and the Host page limit',
  )
  assert.equal(h.scopes.length, 1, 'exactly one per-open Host capture')
  assert.equal(h.scope().subscribeCount(), 1, 'the shared owner subscribes to that capture once')
  assert.equal(h.sourceCalls(), 0, 'the Direct file source is never read on Remote')

  const opening = h.seat.renderState()
  assert.equal(opening?.remote, true)
  assert.equal(opening?.status, 'searching')
  assert.equal(roleNode(h.seat, HISTORY_SEARCH_ROLES.more), undefined, 'a searching page paints no More')
  assert.equal(roleNode(h.seat, HISTORY_SEARCH_ROLES.retry), undefined, 'a searching page paints no Retry')

  h.port.answerSearch(page([row(0, 'alpha one'), row(1, 'beta two')], 'cursor-1'))
  await waitUntil('the committed Remote rows', () => h.seat.renderState()?.rows.length === 2)
  const ready = h.seat.renderState()
  assert.equal(ready?.status, 'ready')
  assert.equal(ready?.header, 'Results · 2 shown')
  assert.deepEqual(ready?.rows.map(entry => entry.summary), ['alpha one', 'beta two'])
  assert.equal(ready?.selectedId, ready?.rows[0]?.id)
  assert.equal(ready?.moreEnabled, true, 'a next cursor enables More')
  assert.equal(ready?.retryEnabled, false)
  await waitUntil('the first selected body read', () => h.port.pendingReads() === 1)
  assert.equal(h.port.lastReadRequest().messageId, 'm0', 'the selected row body loads lazily')
  assert.equal(h.sourceCalls(), 0)
})

test('the native More control runs the same one intent as the Down tail key', async (t) => {
  const h = makeSeat(t)
  h.seat.open()
  await waitUntil('the first search', () => h.port.pendingSearches() === 1)
  h.port.answerSearch(page([row(0, 'alpha')], 'cursor-1'))
  await waitUntil('the settled page', () => h.seat.renderState()?.status === 'ready')
  const before = h.port.searchRequests.length
  clickRole(h.seat, HISTORY_SEARCH_ROLES.more)
  await waitUntil('the More request', () => h.port.searchRequests.length === before + 1)
  assert.equal(h.port.lastSearchRequest().cursor, 'cursor-1')
})

// ── B. More / Retry ──────────────────────────────────────────────────────────

test('Down at the loaded tail requests More once; the in-flight and exhausted controls act zero times', async (t) => {
  const h = makeSeat(t)
  h.seat.open()
  await waitUntil('the first search', () => h.port.pendingSearches() === 1)
  h.port.answerSearch(page([row(0, 'alpha'), row(1, 'beta')], 'cursor-1'))
  await waitUntil('the settled page', () => h.seat.renderState()?.status === 'ready')
  const opening = h.seat.renderState()
  assert.ok(opening)
  h.seat.handleIntent({
    kind: 'select',
    rowId: opening.rows[1]!.id,
    serial: opening.serial,
    revision: opening.revision,
  })
  await waitUntil('the tail selected', () => h.seat.renderState()?.selectedId === opening.rows[1]!.id)
  const before = h.port.searchRequests.length
  assert.equal(h.seat.handleKey(key('down')), true, 'the tail Down is consumed by the card')
  await waitUntil('the More request', () => h.port.searchRequests.length === before + 1)
  const more = h.port.lastSearchRequest()
  assert.equal(more.cursor, 'cursor-1', 'More continues the Host cursor')
  assert.equal(more.scope, 'session')
  assert.equal(more.query, '')
  await waitUntil('the append in flight', () => h.seat.renderState()?.moreLoading === true)
  const loading = h.seat.renderState()
  assert.ok(loading)
  assert.equal(loading.moreEnabled, false, 'an in-flight append disables More')
  assert.equal(loading.header, 'Results · 2 shown · Loading more…')
  // A painted disabled control and a held Down both act ZERO times.
  clickStaleRole(h.seat, loading, HISTORY_SEARCH_ROLES.more)
  h.seat.handleIntent({ kind: 'more', page: loading.page, serial: loading.serial, revision: loading.revision })
  h.seat.handleKey(key('down'))
  await settle(60)
  assert.equal(h.port.searchRequests.length, before + 1, 'no second append was started')
  h.port.answerSearch(page([row(2, 'gamma')], null))
  await waitUntil('the appended page', () => h.seat.renderState()?.rows.length === 3)
  const exhausted = h.seat.renderState()
  assert.ok(exhausted)
  assert.equal(exhausted.moreEnabled, false)
  h.seat.handleIntent({ kind: 'more', page: exhausted.page, serial: exhausted.serial, revision: exhausted.revision })
  await settle(60)
  assert.equal(h.port.searchRequests.length, before + 1, 'the last page has no More action')
})

test('Down in a failed Remote search retries the first page exactly once and searching is not retryable', async (t) => {
  const h = makeSeat(t)
  h.seat.open()
  await waitUntil('the first search', () => h.port.pendingSearches() === 1)
  h.port.failSearch(new RemoteHistorySearchFailedError(undefined, 'a sensitive Host detail'))
  await waitUntil('the failed state', () => h.seat.renderState()?.status === 'failed')
  const failed = h.seat.renderState()
  assert.ok(failed)
  assert.equal(failed.header, 'History request failed', 'the failure carries no raw Host detail')
  assert.equal(failed.retryEnabled, true)
  assert.equal(failed.moreEnabled, false)
  const before = h.port.searchRequests.length
  assert.equal(h.seat.handleKey(key('down')), true)
  await waitUntil('the Retry request', () => h.port.searchRequests.length === before + 1)
  const retry = h.port.lastSearchRequest()
  assert.equal(retry.query, '', 'Retry restarts the SAME query from the first page')
  assert.equal(retry.scope, 'session')
  assert.equal(retry.cursor, undefined, 'Retry never continues the old cursor')
  // While the restarted round is searching, Down must not start a third read.
  h.seat.handleKey(key('down'))
  await settle(60)
  assert.equal(h.port.searchRequests.length, before + 1)
  h.port.answerSearch(page([row(0, 'alpha')], null))
  await waitUntil('the recovered page', () => h.seat.renderState()?.status === 'ready')
  assert.equal(h.seat.renderState()?.rows.length, 1)
})

// ── C. Exact body, Copy and Restore ──────────────────────────────────────────

test('the bounded preview stays honest until the exact body is ready; Copy and Restore use that text only', async (t) => {
  const h = makeSeat(t)
  h.seat.open()
  await waitUntil('the first search', () => h.port.pendingSearches() === 1)
  const previewText = 'alpha preview only'
  const exact = 'alpha exact line one\nalpha exact line two'
  h.port.answerSearch(page([row(0, exact, { preview: previewText }), row(1, 'beta')], null))
  await waitUntil('the first page', () => h.seat.renderState()?.status === 'ready')
  await waitUntil('the body request', () => h.port.pendingReads() === 1)
  const loading = h.seat.renderState()
  assert.ok(loading)
  assert.equal(loading.preview?.text, previewText, 'the bounded preview is what is shown before the exact body')
  assert.equal(loading.previewHeading, 'Preview · Loading full text…')
  assert.equal(loading.preview?.notice, undefined, 'the heading carries the one loading notice')
  assert.equal(loading.actionsEnabled, false)
  assert.equal(disabled(roleNode(h.seat, HISTORY_SEARCH_ROLES.copy)), true)
  assert.equal(disabled(roleNode(h.seat, HISTORY_SEARCH_ROLES.restore)), true)
  const selectedId = loading.selectedId
  assert.ok(selectedId)
  h.seat.handleIntent({ kind: 'copy', selectedId, serial: loading.serial, revision: loading.revision })
  h.seat.handleIntent({ kind: 'restore', selectedId, serial: loading.serial, revision: loading.revision })
  assert.equal(h.copies.length, 0, 'Copy is refused before the exact text is verified')
  assert.deepEqual(h.restored, [], 'Restore is refused before the exact text is verified')

  h.port.answerRead(body(exact))
  await waitUntil('the exact body', () => h.seat.renderState()?.actionsEnabled === true)
  const ready = h.seat.renderState()
  assert.ok(ready)
  assert.equal(ready.preview?.text, exact, 'the Preview becomes the verified exact text')
  assert.equal(ready.preview?.notice, undefined)
  assert.equal(disabled(roleNode(h.seat, HISTORY_SEARCH_ROLES.copy)), false)
  h.seat.handleIntent({ kind: 'copy', selectedId, serial: ready.serial, revision: ready.revision })
  assert.equal(h.copies.length, 1)
  assert.equal(h.copies[0]?.raw, exact, 'Copy carries the exact original text')
  assert.equal(h.copies[0]?.live, true)
  h.seat.handleIntent({ kind: 'restore', selectedId, serial: ready.serial, revision: ready.revision })
  assert.deepEqual(h.restored, [exact], 'Restore writes the same exact text')
  assert.equal(h.seat.renderState(), undefined, 'Restore closes the one card')
  assert.equal(h.scope().disposeCount(), 1)
})

test('Down on a failed exact body retries the first page instead of browsing', async (t) => {
  const h = makeSeat(t)
  h.seat.open()
  await waitUntil('the first search', () => h.port.pendingSearches() === 1)
  h.port.answerSearch(page([row(0, 'alpha full text'), row(1, 'beta text')], 'cursor-1'))
  await waitUntil('the body request', () => h.port.pendingReads() === 1)
  h.port.failRead(new RemoteHistorySearchFailedError(undefined, 'the hash did not match'))
  await waitUntil('the body failure',
    () => h.seat.renderState()?.preview?.notice === 'History text failed')
  const before = h.port.searchRequests.length
  assert.equal(h.seat.handleKey(key('down')), true)
  await waitUntil('the first-page retry', () => h.port.searchRequests.length === before + 1)
  assert.equal(h.port.lastSearchRequest().cursor, undefined)
  assert.equal(h.port.lastSearchRequest().query, '')
})

test('a failed exact body keeps the bounded preview, states the reason and Retry restarts the first page', async (t) => {
  const h = makeSeat(t)
  h.seat.open()
  await waitUntil('the first search', () => h.port.pendingSearches() === 1)
  const previewText = 'alpha preview only'
  h.port.answerSearch(page([row(0, 'alpha full text', { preview: previewText })], null))
  await waitUntil('the body request', () => h.port.pendingReads() === 1)
  h.port.failRead(new RemoteHistorySearchFailedError(undefined, 'the hash did not match'))
  await waitUntil('the body failure',
    () => h.seat.renderState()?.preview?.notice === 'History text failed')
  const failed = h.seat.renderState()
  assert.ok(failed)
  assert.equal(failed.preview?.text, previewText, 'the bounded preview survives the failed exact read')
  assert.equal(failed.preview?.notice, 'History text failed')
  assert.equal(failed.actionsEnabled, false)
  assert.equal(failed.retryEnabled, true, 'a body failure exposes Retry')
  assert.equal(disabled(roleNode(h.seat, HISTORY_SEARCH_ROLES.copy)), true)
  const before = h.port.searchRequests.length
  clickRole(h.seat, HISTORY_SEARCH_ROLES.retry)
  await waitUntil('the retried first page', () => h.port.searchRequests.length === before + 1)
  assert.equal(h.port.lastSearchRequest().cursor, undefined)
  assert.equal(h.port.lastSearchRequest().query, '')
})

// ── D. Query/scope and stale frames ──────────────────────────────────────────

test('query and scope edits start fresh Remote rounds with the query preserved and stale intents are refused', async (t) => {
  const h = makeSeat(t)
  h.seat.open()
  await waitUntil('the first search', () => h.port.pendingSearches() === 1)
  h.port.answerSearch(page([row(0, 'alpha'), row(1, 'beta about tern')], 'cursor-1'))
  await waitUntil('the first page', () => h.seat.renderState()?.rows.length === 2)
  const stale = h.seat.renderState()
  assert.ok(stale)
  assert.equal(stale.scope, 'Session')
  h.seat.handleIntent({
    kind: 'query', query: 'beta', cursor: 4, serial: stale.serial, revision: stale.revision,
  })
  await waitUntil('the debounced query round', () => h.port.searchRequests.length === 2)
  assert.equal(h.port.lastSearchRequest().query, 'beta')
  const searching = h.seat.renderState()
  assert.ok(searching)
  assert.equal(searching.status, 'searching')
  assert.equal(searching.actionsEnabled, false, 'a round in flight disables exact-body actions')
  h.seat.handleIntent({
    kind: 'copy', selectedId: searching.selectedId ?? '', serial: searching.serial, revision: searching.revision,
  })
  assert.equal(h.copies.length, 0, 'the previous body is not copyable mid-round')
  h.port.answerSearch(page([row(1, 'beta about tern')], null))
  await waitUntil('the query page', () => h.seat.renderState()?.status === 'ready')
  const queryReady = h.seat.renderState()
  assert.ok(queryReady)
  h.seat.handleIntent({
    kind: 'scope', delta: 1, serial: queryReady.serial, revision: queryReady.revision,
  })
  await waitUntil('the scope round', () => h.port.searchRequests.length === 3)
  const scoped = h.port.lastSearchRequest()
  assert.equal(scoped.scope, 'directory')
  assert.equal('cwd' in scoped ? scoped.cwd : undefined, '/host/dir')
  assert.equal(scoped.query, 'beta', 'the query survives the Scope switch')
  h.port.answerSearch(page([row(1, 'beta about tern')], null))
  await waitUntil('the scope page', () => h.seat.renderState()?.status === 'ready')
  const current = h.seat.renderState()
  assert.ok(current)
  assert.equal(current.scope, 'Directory')
  h.seat.handleIntent({ kind: 'scope', delta: 1, serial: current.serial, revision: current.revision })
  await waitUntil('the All scope round', () => h.port.searchRequests.length === 4)
  assert.equal(h.port.lastSearchRequest().scope, 'all')
  assert.equal(h.port.lastSearchRequest().query, 'beta')
  h.port.answerSearch(page([row(1, 'beta about tern')], null))
  await waitUntil('the All page', () => h.seat.renderState()?.status === 'ready')
  const all = h.seat.renderState()
  assert.ok(all)
  // Every intent minted from the FIRST frame is now stale, including the real
  // click handlers of the OLD painted card: serial+revision fences refuse them
  // before the shared owner sees a newer row.
  const before = h.port.searchRequests.length
  clickStaleRole(h.seat, stale, HISTORY_SEARCH_ROLES.copy)
  h.seat.handleIntent({ kind: 'more', page: stale.page, serial: stale.serial, revision: stale.revision })
  h.seat.handleIntent({ kind: 'retry', serial: stale.serial, revision: stale.revision })
  h.seat.handleIntent({
    kind: 'query', query: 'gamma', cursor: 5, serial: stale.serial, revision: stale.revision,
  })
  h.seat.handleIntent({
    kind: 'copy', selectedId: stale.selectedId, serial: stale.serial, revision: stale.revision,
  })
  // reason: bounded negative observation window — a stale painted intent owes no RPC.
  await settle(120)
  assert.equal(h.port.searchRequests.length, before, 'no stale frame started a round')
  assert.deepEqual(h.copies, [], 'no stale frame copied a newer row')
})

test('a sessionless Remote open starts on All and its Scope ring never offers Session', async (t) => {
  const h = makeSeat(t, { sessionId: null })
  h.seat.open()
  await waitUntil('the sessionless first search', () => h.port.pendingSearches() === 1)
  assert.equal(h.port.lastSearchRequest().scope, 'all')
  assert.equal(h.seat.renderState()?.scope, 'All')
  h.port.answerSearch(page([row(0, 'alpha')], null))
  await waitUntil('the sessionless page', () => h.seat.renderState()?.status === 'ready')
  const ready = h.seat.renderState()
  assert.ok(ready)
  h.seat.handleIntent({ kind: 'scope', delta: 1, serial: ready.serial, revision: ready.revision })
  await waitUntil('the Directory scope', () => h.port.searchRequests.length === 2)
  assert.equal(h.port.lastSearchRequest().scope, 'directory')
  h.port.answerSearch(page([row(0, 'alpha')], null))
  await waitUntil('the Directory page', () => h.seat.renderState()?.status === 'ready')
  const directory = h.seat.renderState()
  assert.ok(directory)
  h.seat.handleIntent({ kind: 'scope', delta: 1, serial: directory.serial, revision: directory.revision })
  await waitUntil('the wrapped All scope', () => h.port.searchRequests.length === 3)
  assert.equal(h.port.lastSearchRequest().scope, 'all', 'the two-scope ring wraps All → Directory → All')
  assert.equal(h.port.searchRequests.some(request => request.scope === 'session'), false,
    'a sessionless card never sends a Session request')
})

test('a sessionless open adopts the first confirmed Directory baseline', async (t) => {
  const h = makeSeat(t, { sessionId: null, directory: { available: false, reason: 'workspace-not-confirmed' } })
  h.seat.open()
  await waitUntil('the sessionless first search', () => h.port.pendingSearches() === 1)
  h.port.answerSearch(page([row(0, 'alpha')], null))
  await waitUntil('the sessionless page', () => h.seat.renderState()?.status === 'ready')
  const ready = h.seat.renderState()
  assert.ok(ready)
  assert.equal(ready.scope, 'All', 'an unconfirmed Directory keeps the sessionless card on All')
  h.scope().setDirectory({ available: true, cwd: '/host/dir' })
  await waitUntil('the adopted Directory round', () => h.seat.renderState()?.scope === 'Directory')
  assert.equal(h.port.lastSearchRequest().scope, 'directory')
  assert.equal(h.seat.renderState()?.scope, 'Directory')
})

// ── E. Typed statuses ────────────────────────────────────────────────────────

test('typed Remote states paint the shared safe message and Down retries every recoverable state', async (t) => {
  const h = makeSeat(t)
  h.seat.open()
  await waitUntil('the first search', () => h.port.pendingSearches() === 1)
  const requestCount = (): number => h.port.searchRequests.length

  h.port.answerSearch({ kind: 'loading' })
  await waitUntil('the Host loading state', () => h.seat.renderState()?.status === 'loading-host')
  assert.equal(h.seat.renderState()?.header, 'History is loading on Host')
  assert.equal(h.seat.renderState()?.retryEnabled, true)
  let before = requestCount()
  h.seat.handleKey(key('down'))
  await waitUntil('the loading retry', () => requestCount() === before + 1)

  h.port.answerSearch({ kind: 'incomplete', reason: 'reconciling' })
  await waitUntil('the incomplete state', () => h.seat.renderState()?.status === 'incomplete')
  assert.equal(h.seat.renderState()?.header, 'History incomplete — reconciling')
  before = requestCount()
  h.seat.handleKey(key('down'))
  await waitUntil('the incomplete retry', () => requestCount() === before + 1)

  h.port.answerSearch({ kind: 'unavailable', reason: 'service-missing' })
  await waitUntil('the unavailable state', () => h.seat.renderState()?.status === 'unavailable')
  assert.equal(h.seat.renderState()?.header, 'History search is not available on this Host')
  before = requestCount()
  h.seat.handleKey(key('down'))
  await waitUntil('the unavailable retry', () => requestCount() === before + 1)

  h.port.failSearch(new RemoteHistorySearchDeniedError('the peer refused the read'))
  await waitUntil('the denied state', () => h.seat.renderState()?.status === 'denied')
  assert.equal(h.seat.renderState()?.header, 'History search is not permitted')
  before = requestCount()
  h.seat.handleKey(key('down'))
  await waitUntil('the denied retry', () => requestCount() === before + 1)

  h.port.answerSearch({ kind: 'stale', reason: 'cursor-stale' })
  await waitUntil('the stale state', () => h.seat.renderState()?.status === 'stale')
  assert.equal(h.seat.renderState()?.header, 'History changed — Retry')
  before = requestCount()
  h.seat.handleKey(key('down'))
  await waitUntil('the stale retry', () => requestCount() === before + 1)
  h.port.answerSearch(page([row(0, 'alpha')], null))
  await waitUntil('the recovered page', () => h.seat.renderState()?.status === 'ready')

  const current = h.seat.renderState()
  assert.ok(current)
  before = requestCount()
  const long = 'x'.repeat(257)
  h.seat.handleIntent({
    kind: 'query', query: long, cursor: long.length, serial: current.serial, revision: current.revision,
  })
  await waitUntil('the too-long state', () => h.seat.renderState()?.status === 'too-long')
  const tooLong = h.seat.renderState()
  assert.ok(tooLong)
  assert.equal(tooLong.header, 'Query is too long (max 256)')
  assert.equal(tooLong.retryEnabled, false, 'a too-long query is edit-only')
  assert.equal(tooLong.moreEnabled, false)
  h.seat.handleKey(key('down'))
  // reason: bounded negative observation window — a too-long query never dispatches.
  await settle(120)
  assert.equal(requestCount(), before, 'Down on a too-long query starts no new read')
  assert.equal(h.seat.renderState()?.status, 'too-long')
})

// ── E. Disposal ──────────────────────────────────────────────────────────────

test('closing or losing the captured Host scope disposes the shared owner and commits nothing late', async (t) => {
  const h = makeSeat(t)
  h.seat.open()
  await waitUntil('the first search', () => h.port.pendingSearches() === 1)
  const first = h.scope()
  assert.equal(first.subscribeCount(), 1)
  h.seat.retire()
  assert.equal(first.disposeCount(), 1, 'retire disposes the ONE Host capture exactly once')
  assert.equal(h.seat.renderState(), undefined)
  assert.equal(h.seat.holdsSeat(), false)
  assert.equal(h.port.pendingSearches(), 0, 'retire aborted the owned Host read')
  const requestsAfterRetire = h.port.searchRequests.length
  h.seat.handleKey(key('down'))
  h.seat.handleIntent({ kind: 'retry', serial: 1, revision: 1 })
  await settle(60)
  assert.equal(h.port.searchRequests.length, requestsAfterRetire, 'a retired card acts on nothing')
  h.seat.retire()
  assert.equal(first.disposeCount(), 1, 'a second retire disposes nothing twice')

  h.seat.open()
  await waitUntil('the second search', () => h.port.pendingSearches() === 1)
  const second = h.scope()
  assert.notEqual(second, first, 'a new open captures a fresh Host scope')
  h.port.answerSearch(page([row(0, 'alpha')], null))
  await waitUntil('the second page', () => h.seat.renderState()?.rows.length === 1)
  await waitUntil('the body read', () => h.port.pendingReads() === 1)
  second.invalidate()
  await waitUntil('the invalidated card retired', () => h.seat.renderState() === undefined)
  assert.equal(second.disposeCount(), 1, 'the onRetire path disposes the shared owner once')
  assert.equal(h.seat.holdsSeat(), false)
  assert.equal(h.port.pendingReads(), 0, 'the invalidated owner aborted its body read')
  // reason: bounded negative observation window — a disposed owner writes nothing late.
  await settle(120)
  assert.equal(h.seat.renderState(), undefined)
  assert.deepEqual(h.copies, [])
  assert.deepEqual(h.restored, [])
  assert.equal(h.sourceCalls(), 0)
})
