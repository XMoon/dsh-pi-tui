/**
 * The ONE Client-local Remote accepted-history seat owner.
 *
 * It owns the per-open query/page/body chain that both renderers share:
 * - the exact open serial and query revision, so a late answer never commits;
 * - one Host search page at a time (25 rows) plus an explicit More;
 * - one lazy exact-text body read, hash/length/offset verified in bounded
 *   chunks;
 * - the one automatic fresh-first-page recovery after a stale continuation;
 * - the captured Host scope's currentness at every commit and admission.
 *
 * It never renders, never reads the clipboard, never writes the draft and never
 * owns the selected visual row/caret: PiTui and TSP keep those, and both consume
 * this one committed view instead of reimplementing the Remote protocol.
 *
 * @module @xmoon76/dsh-pi-tui/client/history/remote-search-seat
 */

import { createHash } from 'node:crypto'
import {
  HISTORY_SEARCH_LIMIT_MAX,
  HISTORY_SEARCH_QUERY_MAX_CHARS,
  HISTORY_SEARCH_READ_TEXT_LIMIT_MAX,
  type HistoryReadTextRequest,
  type HistorySearchItem,
  type HistorySearchRequest,
  type HistorySearchResponse,
} from '../../runtime/remote/pi-tui-history-search-contract.ts'
import {
  RemoteHistorySearchDeniedError,
  RemoteHistorySearchFailedError,
  RemoteHistorySearchSupersededError,
} from '../../runtime/remote/history-search-remote.ts'
import type { HistorySearchReadPort } from '../../runtime/history-search-read-port.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { runDetached } from '../../runtime/process/tasks.ts'
import type { HistoryScope } from './search.ts'
import type { RemoteHistoryDirectoryState, RemoteHistoryOpenScope } from './remote-scope.ts'

/** One committed result row. `preview` is bounded; `text` only lives in a body. */
export interface RemoteHistoryRow {
  readonly id: string
  readonly sessionId: string
  readonly messageId: string
  readonly firstEventSeq: number
  readonly acceptedAt: number
  readonly effectiveCwd: string | null
  readonly preview: string
  readonly contentLength: number
  readonly contentSha256: string
  readonly hasNonText: boolean
}

export type RemoteHistoryBodyView =
  | { readonly kind: 'none' }
  | { readonly kind: 'preview'; readonly row: RemoteHistoryRow }
  | { readonly kind: 'loading'; readonly row: RemoteHistoryRow; readonly preview: string }
  | { readonly kind: 'ready'; readonly row: RemoteHistoryRow; readonly text: string; readonly hasNonText: boolean }
  | { readonly kind: 'failed'; readonly row: RemoteHistoryRow; readonly preview: string; readonly message: string }

export type RemoteHistorySeatStatus =
  | 'idle'
  | 'searching'
  | 'loading-host'
  | 'incomplete'
  | 'unavailable'
  | 'denied'
  | 'failed'
  | 'stale'
  | 'too-long'
  | 'ready'

export interface RemoteHistorySeatView {
  readonly serial: number
  readonly queryRevision: number
  readonly scope: HistoryScope
  readonly query: string
  readonly status: RemoteHistorySeatStatus
  /** Safe status text; never a Host error detail or a content byte. */
  readonly message: string
  readonly rows: readonly RemoteHistoryRow[]
  readonly selectedId: string | undefined
  readonly hasMore: boolean
  readonly moreLoading: boolean
  readonly directory: RemoteHistoryDirectoryState
  readonly body: RemoteHistoryBodyView
}

export interface RemoteHistorySeatOptions {
  readonly read: HistorySearchReadPort
  /** The composition diagnostics channel for detached reads. */
  readonly diag: Diag
  /** The exact Session captured at open, or undefined for a sessionless seat. */
  readonly sessionId: string | undefined
  /** The per-open application-owned Host scope capture. */
  readonly scope: RemoteHistoryOpenScope
  /** Called when the captured scope stops being current; the host closes the seat. */
  readonly onRetire: () => void
  readonly debounceMs?: number
}

export interface RemoteHistorySeat {
  open(scope: HistoryScope, query: string): void
  setQuery(query: string): void
  setScope(scope: HistoryScope): void
  select(id: string): void
  more(): void
  retry(): void
  close(): void
  view(): RemoteHistorySeatView
  subscribe(listener: () => void): () => void
}

const DEFAULT_DEBOUNCE_MS = 75

const INCOMPLETE_LABEL = {
  'source-uncertain': 'source uncertain',
  'reconciling': 'reconciling',
  'resource-limit': 'resource limit',
  'source-read-failed': 'source read failed',
} as const

function rowOf(item: HistorySearchItem): RemoteHistoryRow {
  return {
    id: `${item.sessionId}\u0000${item.messageId}`,
    sessionId: item.sessionId,
    messageId: item.messageId,
    firstEventSeq: item.firstEventSeq,
    acceptedAt: item.acceptedAt,
    effectiveCwd: item.effectiveCwd,
    preview: item.preview,
    contentLength: item.contentLength,
    contentSha256: item.contentSha256,
    hasNonText: item.hasNonText,
  }
}

function isAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && (error as { readonly name?: unknown }).name === 'AbortError'
}

/** The closed, safe body-failure reasons (never a raw Host error message). */
const BODY_FAILURE_LABEL: Readonly<Record<string, string>> = {
  'body-loading': 'the Host is still indexing',
  'body-incomplete': 'the Host source is incomplete',
  'body-unavailable': 'the Host body is unavailable',
  'body-length-mismatch': 'the Host content length changed',
  'body-offset-mismatch': 'the Host text offsets are not contiguous',
  'body-truncated': 'the Host text did not terminate',
  'body-hash-mismatch': 'the content hash does not match',
}

export function createRemoteHistorySeat(options: RemoteHistorySeatOptions): RemoteHistorySeat {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const listeners = new Set<() => void>()
  let serial = 0
  let queryRevision = 0
  let scope: HistoryScope = 'all'
  let query = ''
  let status: RemoteHistorySeatStatus = 'idle'
  let message = ''
  let rows: RemoteHistoryRow[] = []
  let selectedId: string | undefined
  let nextCursor: string | null = null
  let generation: string | undefined
  let moreLoading = false
  let body: RemoteHistoryBodyView = { kind: 'none' }
  let directory = options.scope.directory()
  let searchAbort: AbortController | undefined
  let bodyAbort: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let staleAutoUsed = false
  let userChanged = false
  let closed = false
  let scopeSub: (() => void) | undefined

  const publish = (): void => {
    if (closed) return
    for (const listener of [...listeners]) listener()
  }

  const cancelSearch = (): void => {
    searchAbort?.abort()
    searchAbort = undefined
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const cancelBody = (): void => {
    bodyAbort?.abort()
    bodyAbort = undefined
  }

  const retire = (): void => {
    if (closed) return
    closed = true
    cancelSearch()
    cancelBody()
    scopeSub?.()
    scopeSub = undefined
    options.scope.dispose()
    listeners.clear()
    options.onRetire()
  }

  const onScopeChanged = (): void => {
    if (closed) return
    if (!options.scope.isCurrent()) {
      retire()
      return
    }
    directory = options.scope.directory()
    // A sessionless open starts on All while the official Workspace baseline is
    // still absent. The FIRST confirmed baseline may adopt Directory once, and
    // only while the user has not changed the query/scope/selection.
    if (!userChanged && serial > 0 && scope === 'all' && options.scope.initialScope === 'all'
      && directory.available && directory.cwd !== undefined) {
      scope = 'current'
      userChanged = false
      startFresh()
      return
    }
    if (scope === 'current' && !directory.available) {
      cancelSearch()
      queryRevision += 1
      status = 'unavailable'
      message = 'That Host directory is no longer available'
      rows = []
      selectedId = undefined
      nextCursor = null
      generation = undefined
      cancelBody()
      body = { kind: 'none' }
    }
    publish()
  }
  scopeSub = options.scope.subscribe(onScopeChanged)

  const requestOf = (cursor?: string): HistorySearchRequest | undefined => {
    if (scope === 'session') {
      if (options.sessionId === undefined) return undefined
      return {
        scope: 'session',
        sessionId: options.sessionId,
        query,
        limit: HISTORY_SEARCH_LIMIT_MAX,
        ...(cursor === undefined ? {} : { cursor }),
      }
    }
    if (scope === 'current') {
      if (!directory.available || directory.cwd === undefined) return undefined
      return { scope: 'directory', cwd: directory.cwd, query, limit: HISTORY_SEARCH_LIMIT_MAX, ...(cursor === undefined ? {} : { cursor }) }
    }
    return { scope: 'all', query, limit: HISTORY_SEARCH_LIMIT_MAX, ...(cursor === undefined ? {} : { cursor }) }
  }

  const finishWithStatus = (next: RemoteHistorySeatStatus, text: string): void => {
    status = next
    message = text
    rows = []
    selectedId = undefined
    nextCursor = null
    generation = undefined
    moreLoading = false
    cancelBody()
    body = { kind: 'none' }
    publish()
  }

  const commitFirstPage = (response: Extract<HistorySearchResponse, { kind: 'ready' }>, round: Round): void => {
    if (closed || round.serial !== serial || round.revision !== queryRevision) return
    if (!options.scope.isCurrent()) {
      retire()
      return
    }
    generation = response.generation
    rows = response.items.map(rowOf)
    nextCursor = response.nextCursor
    selectedId = rows[0]?.id
    body = selectedId === undefined ? { kind: 'none' } : { kind: 'preview', row: rows[0] as RemoteHistoryRow }
    status = 'ready'
    message = rows.length === 0 ? 'No matches' : `Results · ${String(rows.length)} shown`
    moreLoading = false
    publish()
    if (selectedId !== undefined) {
      const selected = rows[0] as RemoteHistoryRow
      startBody(selected, serial, queryRevision)
    }
  }

  type Round = { readonly serial: number; readonly revision: number }

  const runSearch = (round: Round, cursor: string | undefined, append: boolean): void => {
    if (closed || round.serial !== serial || round.revision !== queryRevision) return
    const request = requestOf(cursor)
    if (request === undefined) {
      finishWithStatus('unavailable', scope === 'current'
        ? 'Directory is not available for this open'
        : 'Session history is not available for this open')
      return
    }
    const controller = new AbortController()
    searchAbort = controller
    runDetached('Remote History search', async () => {
      try {
        const response = await options.read.search(request, controller.signal)
        if (closed || round.serial !== serial || round.revision !== queryRevision || controller.signal.aborted) return
        if (!options.scope.isCurrent()) {
          retire()
          return
        }
        await commitResponse(response, round, append, cursor)
      } catch (error) {
        if (closed || round.serial !== serial || round.revision !== queryRevision || isAbort(error)) return
        if (error instanceof RemoteHistorySearchSupersededError) {
          retire()
          return
        }
        if (error instanceof RemoteHistorySearchDeniedError) {
          finishWithStatus('denied', 'History search is not permitted')
          return
        }
        if (error instanceof RemoteHistorySearchFailedError) {
          finishWithStatus('failed', `History request failed${error.code === undefined ? '' : ` (${error.code})`}`)
          return
        }
        finishWithStatus('failed', 'History request failed')
      } finally {
        if (searchAbort === controller) searchAbort = undefined
      }
    }, { diag: options.diag })
  }

  const commitResponse = async (
    response: HistorySearchResponse,
    round: Round,
    append: boolean,
    cursor: string | undefined,
  ): Promise<void> => {
    if (response.kind === 'ready') {
      if (append) {
        if (cursor === undefined || response.generation !== generation) {
          await recoverStaleMore(round)
          return
        }
        rows = [...rows, ...response.items.map(rowOf)]
        nextCursor = response.nextCursor
        moreLoading = false
        if (selectedId === undefined && rows.length > 0) {
          selectedId = rows[0]?.id
          const selected = rows[0]
          if (selected !== undefined) startBody(selected, round.serial, round.revision)
        }
        body = body.kind === 'none' && selectedId !== undefined
          ? { kind: 'preview', row: rows.find(row => row.id === selectedId) as RemoteHistoryRow }
          : body
        status = 'ready'
        message = `Results · ${String(rows.length)} shown`
        publish()
        return
      }
      commitFirstPage(response, round)
      return
    }
    if (append) {
      moreLoading = false
      if (response.kind === 'stale') {
        await recoverStaleMore(round)
        return
      }
      status = response.kind === 'loading'
        ? 'loading-host'
        : response.kind === 'incomplete' ? 'incomplete' : 'unavailable'
      message = response.kind === 'loading'
        ? 'History is loading on Host'
        : response.kind === 'incomplete'
          ? `History incomplete — ${INCOMPLETE_LABEL[response.reason]}`
          : response.reason === 'service-missing'
            ? 'History search is not available on this Host'
            : 'History index is unavailable'
      cancelBody()
      body = { kind: 'none' }
      publish()
      return
    }
    if (response.kind === 'loading') {
      finishWithStatus('loading-host', 'History is loading on Host')
      return
    }
    if (response.kind === 'incomplete') {
      finishWithStatus('incomplete', `History incomplete — ${INCOMPLETE_LABEL[response.reason]}`)
      return
    }
    if (response.kind === 'unavailable') {
      finishWithStatus('unavailable', response.reason === 'service-missing'
        ? 'History search is not available on this Host'
        : 'History index is unavailable')
      return
    }
    finishWithStatus('stale', 'History changed — Retry')
  }

  const recoverStaleMore = async (round: Round): Promise<void> => {
    cancelBody()
    rows = []
    selectedId = undefined
    nextCursor = null
    generation = undefined
    body = { kind: 'none' }
    if (!staleAutoUsed) {
      staleAutoUsed = true
      moreLoading = false
      status = 'searching'
      message = 'Refreshing history…'
      publish()
      runSearch({ serial: round.serial, revision: round.revision }, undefined, false)
      return
    }
    moreLoading = false
    finishWithStatus('stale', 'History changed — Retry')
  }

  const startFresh = (): void => {
    cancelSearch()
    cancelBody()
    queryRevision += 1
    moreLoading = false
    staleAutoUsed = false
    rows = []
    selectedId = undefined
    nextCursor = null
    generation = undefined
    body = { kind: 'none' }
    if (closed) return
    if (query.length > HISTORY_SEARCH_QUERY_MAX_CHARS) {
      status = 'too-long'
      message = `Query is too long (max ${String(HISTORY_SEARCH_QUERY_MAX_CHARS)})`
      publish()
      return
    }
    if (scope === 'session' && options.sessionId === undefined) {
      status = 'unavailable'
      message = 'Session history is not available for this open'
      publish()
      return
    }
    if (scope === 'current' && !directory.available) {
      status = 'unavailable'
      message = 'Directory is not available for this open'
      publish()
      return
    }
    const round = { serial, revision: queryRevision }
    status = 'searching'
    message = 'Searching…'
    publish()
    runSearch(round, undefined, false)
  }

  const scheduleFresh = (): void => {
    cancelSearch()
    queryRevision += 1
    if (closed) return
    if (query.length > HISTORY_SEARCH_QUERY_MAX_CHARS) {
      status = 'too-long'
      message = `Query is too long (max ${String(HISTORY_SEARCH_QUERY_MAX_CHARS)})`
      publish()
      return
    }
    status = 'searching'
    message = 'Searching…'
    publish()
    timer = setTimeout(() => {
      timer = undefined
      const round = { serial, revision: queryRevision }
      runSearch(round, undefined, false)
    }, debounceMs)
  }

  const startBody = (row: RemoteHistoryRow, expectedSerial: number, expectedRevision: number): void => {
    if (closed) return
    cancelBody()
    const controller = new AbortController()
    bodyAbort = controller
    body = { kind: 'loading', row, preview: row.preview }
    publish()
    runDetached('Remote History body', async () => {
      try {
        const text = await readBody(row, expectedSerial, expectedRevision, controller.signal)
        if (closed || controller.signal.aborted
          || expectedSerial !== serial || expectedRevision !== queryRevision
          || selectedId !== row.id) return
        if (!options.scope.isCurrent()) {
          retire()
          return
        }
        body = { kind: 'ready', row, text, hasNonText: row.hasNonText }
        publish()
      } catch (error) {
        if (closed || controller.signal.aborted || isAbort(error)
          || expectedSerial !== serial || expectedRevision !== queryRevision
          || selectedId !== row.id) return
        if (error instanceof RemoteHistorySearchSupersededError) {
          retire()
          return
        }
        const message = error instanceof RemoteHistorySearchDeniedError
          ? 'History text is not permitted'
          : error instanceof RemoteHistorySearchFailedError
            ? `History text failed${BODY_FAILURE_LABEL[error.code ?? ''] === undefined ? '' : ` — ${BODY_FAILURE_LABEL[error.code ?? '']}`}`
            : 'History text is unavailable'
        body = { kind: 'failed', row, preview: row.preview, message }
        publish()
      } finally {
        if (bodyAbort === controller) bodyAbort = undefined
      }
    }, { diag: options.diag })
  }

  const readBody = async (
    row: RemoteHistoryRow,
    expectedSerial: number,
    expectedRevision: number,
    signal: AbortSignal,
  ): Promise<string> => {
    let text = ''
    let offset = 0
    const maxChunks = Math.ceil(row.contentLength / HISTORY_SEARCH_READ_TEXT_LIMIT_MAX) + 2
    for (let chunkIndex = 0; chunkIndex < maxChunks; chunkIndex += 1) {
      if (closed || signal.aborted || expectedSerial !== serial || expectedRevision !== queryRevision) {
        throw new DOMException('aborted', 'AbortError')
      }
      const request: HistoryReadTextRequest = {
        sessionId: row.sessionId,
        messageId: row.messageId,
        contentSha256: row.contentSha256,
        offset,
        limit: HISTORY_SEARCH_READ_TEXT_LIMIT_MAX,
      }
      const response = await options.read.readText(request, signal)
      if (signal.aborted || expectedSerial !== serial || expectedRevision !== queryRevision) {
        throw new DOMException('aborted', 'AbortError')
      }
      if (response.kind !== 'ready') {
        throw new RemoteHistorySearchFailedError(response.kind === 'unavailable'
          ? 'body-unavailable'
          : response.kind === 'incomplete' ? 'body-incomplete' : 'body-loading', 'the Host did not answer a body chunk')
      }
      if (response.contentLength !== row.contentLength) {
        throw new RemoteHistorySearchFailedError('body-length-mismatch', 'the Host content length changed')
      }
      text += response.chunk
      if (response.nextOffset === null) {
        if (text.length !== row.contentLength) {
          throw new RemoteHistorySearchFailedError('body-length-mismatch', 'the Host text ended at the wrong offset')
        }
        break
      }
      if (response.nextOffset !== text.length || response.nextOffset <= offset) {
        throw new RemoteHistorySearchFailedError('body-offset-mismatch', 'the Host text offset is not contiguous')
      }
      offset = response.nextOffset
      if (chunkIndex === maxChunks - 1) {
        throw new RemoteHistorySearchFailedError('body-truncated', 'the Host text did not terminate')
      }
    }
    const hash = createHash('sha256').update(text, 'utf8').digest('hex')
    if (hash !== row.contentSha256) {
      throw new RemoteHistorySearchFailedError('body-hash-mismatch', 'the Host text does not match its content hash')
    }
    return text
  }

  const seat: RemoteHistorySeat = {
    open(nextScope, nextQuery) {
      if (closed) return
      serial += 1
      userChanged = false
      scope = nextScope
      query = nextQuery
      directory = options.scope.directory()
      startFresh()
    },
    setQuery(nextQuery) {
      if (closed) return
      userChanged = true
      query = nextQuery
      scheduleFresh()
    },
    setScope(nextScope) {
      if (closed) return
      if (nextScope === scope) return
      userChanged = true
      scope = nextScope
      startFresh()
    },
    select(id) {
      if (closed || status !== 'ready') return
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) return
      if (id === selectedId && body.kind !== 'failed') return
      selectedId = id
      startBody(row, serial, queryRevision)
    },
    more() {
      if (closed || status !== 'ready' || moreLoading || nextCursor === null) return
      moreLoading = true
      message = 'Loading more…'
      publish()
      runSearch({ serial, revision: queryRevision }, nextCursor, true)
    },
    retry() {
      if (closed) return
      staleAutoUsed = false
      startFresh()
    },
    close() {
      if (closed) return
      closed = true
      cancelSearch()
      cancelBody()
      scopeSub?.()
      scopeSub = undefined
      options.scope.dispose()
      listeners.clear()
    },
    view() {
      return {
        serial,
        queryRevision,
        scope,
        query,
        status,
        message,
        rows: [...rows],
        selectedId,
        hasMore: nextCursor !== null,
        moreLoading,
        directory,
        body,
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  return seat
}
