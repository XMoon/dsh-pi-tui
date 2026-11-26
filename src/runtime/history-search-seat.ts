/**
 * The neutral Remote accepted-history seat contract shared by the application
 * owner and both renderers.
 *
 * The concrete seat lives in the Remote composition layer; terminal
 * presentation consumes only these types, so it never imports the experimental
 * Remote composition or a Host transport.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/history-search-seat
 */

import { createHash } from 'node:crypto'
import {
  HISTORY_SEARCH_LIMIT_MAX,
  HISTORY_SEARCH_QUERY_MAX_CHARS,
  HISTORY_SEARCH_READ_TEXT_LIMIT_MAX,
} from './history-search-limits.ts'
import type {
  HistoryReadTextRequest,
  HistorySearchItem,
  HistorySearchRequest,
  HistorySearchResponse,
} from './history-search-dto.ts'
import {
  RemoteHistorySearchDeniedError,
  RemoteHistorySearchFailedError,
  RemoteHistorySearchSupersededError,
} from './remote/history-search-remote.ts'
import type { HistorySearchReadPort } from './history-search-read-port.ts'
import type {
  HistoryScope,
  RemoteHistoryBodyView,
  RemoteHistoryDirectoryState,
  RemoteHistoryOpenScopeLike,
  RemoteHistoryProgress,
  RemoteHistoryRow,
  RemoteHistorySeat,
  RemoteHistorySeatStatus,
  RemoteHistorySeatView,
} from './history-search-seat-contract.ts'
import type { Diag } from './process/diagnostics.ts'
import { runDetached } from './process/tasks.ts'


export interface RemoteHistorySeatOptions {
  readonly read: HistorySearchReadPort
  /** The composition diagnostics channel for detached reads. */
  readonly diag: Diag
  /** The exact Session captured at open, or undefined for a sessionless seat. */
  readonly sessionId: string | undefined
  /** The per-open application-owned Host scope capture. */
  readonly scope: RemoteHistoryOpenScopeLike
  /** Called when the captured scope stops being current; the host closes the seat. */
  readonly onRetire: () => void
  readonly debounceMs?: number
  /** The settled→next first-page refresh delay (tests inject a short clock). */
  readonly refreshMs?: number
}

export type {
  HistoryScope,
  RemoteHistoryBodyView,
  RemoteHistoryDirectoryState,
  RemoteHistoryOpenScopeLike,
  RemoteHistoryProgress,
  RemoteHistoryRow,
  RemoteHistorySeat,
  RemoteHistorySeatStatus,
  RemoteHistorySeatView,
} from './history-search-seat-contract.ts'

const DEFAULT_DEBOUNCE_MS = 75

/** The one settled→next first-page refresh interval for a warmup seat. */
export const HISTORY_SEARCH_REFRESH_MS = 1000

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

/** The complete visible row identity used to keep a selection across a refresh. */
function sameRowIdentity(left: RemoteHistoryRow, right: RemoteHistoryRow): boolean {
  return left.id === right.id
    && left.firstEventSeq === right.firstEventSeq
    && left.acceptedAt === right.acceptedAt
    && left.effectiveCwd === right.effectiveCwd
    && left.contentLength === right.contentLength
    && left.contentSha256 === right.contentSha256
    && left.hasNonText === right.hasNonText
    && left.preview === right.preview
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
  const refreshMs = options.refreshMs ?? HISTORY_SEARCH_REFRESH_MS
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
  let progress: RemoteHistoryProgress | undefined
  let pageRevision = 0
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
      progress = undefined
      cancelBody()
      body = { kind: 'none' }
    } else if (scope === 'current' && directory.available && status === 'unavailable') {
      // The baseline can confirm after a sessionless open already reported
      // Directory unavailable. A later confirmation is a real source fact:
      // restart the current page instead of leaving a dead Retry.
      startFresh()
      return
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
    progress = undefined
    moreLoading = false
    cancelBody()
    body = { kind: 'none' }
    publish()
  }

  type Round = { readonly serial: number; readonly revision: number }

  const selectForPage = (
    previousRows: readonly RemoteHistoryRow[],
    incoming: readonly RemoteHistoryRow[],
    preserveSelection: boolean,
  ): RemoteHistoryRow | undefined => {
    const previous = preserveSelection && selectedId !== undefined
      ? previousRows.find(row => row.id === selectedId)
      : undefined
    const kept = previous === undefined
      ? undefined
      : incoming.find(row => sameRowIdentity(row, previous))
    return kept ?? incoming[0]
  }

  /**
   * Keep the exact body/read state only for the SAME complete row identity.
   * A progress-only publish therefore never re-reads the body or drops a ready
   * text; a changed hash/rank/missing row starts exactly one new body read.
   */
  const keepOrStartBody = (next: RemoteHistoryRow, preserveSelection: boolean): void => {
    const existing = body
    if (preserveSelection && existing.kind !== 'none' && sameRowIdentity(existing.row, next)) {
      if (existing.kind === 'ready' || existing.kind === 'loading' || existing.kind === 'failed') {
        body = { ...existing, row: next }
        return
      }
    }
    startBody(next, serial, queryRevision)
  }

  const sameRowList = (left: readonly RemoteHistoryRow[], right: readonly RemoteHistoryRow[]): boolean => {
    if (left.length !== right.length) return false
    return left.every((row, index) => {
      const other = right[index]
      return other !== undefined && sameRowIdentity(row, other)
    })
  }

  const commitPage = (page: {
    readonly rows: readonly RemoteHistoryRow[]
    readonly status: RemoteHistorySeatStatus
    readonly message: string
    readonly nextCursor: string | null
    readonly generation: string | undefined
    readonly progress: RemoteHistoryProgress | undefined
    readonly refresh: boolean
  }, round: Round, preserveSelection: boolean): void => {
    if (closed || round.serial !== serial || round.revision !== queryRevision) return
    if (!options.scope.isCurrent()) {
      retire()
      return
    }
    const previousRows = rows
    if (!sameRowList(previousRows, page.rows)) pageRevision += 1
    rows = [...page.rows]
    status = page.status
    message = page.message
    nextCursor = page.nextCursor
    generation = page.generation
    progress = page.progress
    moreLoading = false
    const selected = selectForPage(previousRows, rows, preserveSelection)
    if (selected === undefined) {
      selectedId = undefined
      cancelBody()
      body = { kind: 'none' }
    } else {
      selectedId = selected.id
      keepOrStartBody(selected, preserveSelection)
    }
    publish()
    if (page.refresh) scheduleRefresh(round)
  }

  const commitFirstPage = (
    response: Extract<HistorySearchResponse, { kind: 'ready' }>,
    round: Round,
    refresh: boolean,
  ): void => {
    const incoming = response.items.map(rowOf)
    commitPage({
      rows: incoming,
      status: 'ready',
      message: incoming.length === 0 ? 'No matches' : `Results · ${String(incoming.length)} shown`,
      nextCursor: response.nextCursor,
      generation: response.generation,
      progress: undefined,
      refresh: false,
    }, round, refresh)
  }

  const commitPartial = (
    response: Extract<HistorySearchResponse, { kind: 'partial' }>,
    round: Round,
    refresh: boolean,
  ): void => {
    const incoming = response.items.map(rowOf)
    const { settled, total } = response.progress
    const percent = Math.floor((settled * 100) / total)
    commitPage({
      rows: incoming,
      status: 'partial',
      message: incoming.length === 0
        ? 'No matches yet — indexing…'
        : `Results · ${String(incoming.length)} shown · Indexing ${String(settled)}/${String(total)} (${String(percent)}%)`,
      nextCursor: null,
      generation: undefined,
      progress: { settled, total },
      refresh: true,
    }, round, refresh)
  }

  const runSearch = (round: Round, cursor: string | undefined, append: boolean, refresh = false): void => {
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
        await commitResponse(response, round, append, cursor, refresh)
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

  /**
   * One settled→next first-page refresh. The timer is the seat's existing owner
   * (the debounce slot), never a second interval: any new user query/scope,
   * Retry, close or teardown clears it through cancelSearch().
   */
  const scheduleRefresh = (round: Round): void => {
    if (closed || timer !== undefined) return
    if (status !== 'partial' && status !== 'loading-host') return
    if (round.serial !== serial || round.revision !== queryRevision) return
    timer = setTimeout(() => {
      timer = undefined
      if (closed || round.serial !== serial || round.revision !== queryRevision) return
      if (status !== 'partial' && status !== 'loading-host') return
      if (searchAbort !== undefined) return
      runSearch({ serial, revision: queryRevision }, undefined, false, true)
    }, refreshMs)
    ;(timer as { unref?: () => void }).unref?.()
  }

  const commitResponse = async (
    response: HistorySearchResponse,
    round: Round,
    append: boolean,
    cursor: string | undefined,
    refresh: boolean,
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
      commitFirstPage(response, round, refresh)
      return
    }
    if (append) {
      moreLoading = false
      if (response.kind === 'stale' || response.kind === 'partial') {
        // A continuation never carries a partial page; treat it like a lost
        // cursor and recover the first page once.
        await recoverStaleMore(round)
        return
      }
      // A non-ready append has no operable continuation: drop the old chain
      // uniformly so no prior rows/next cursor can be acted on.
      rows = []
      selectedId = undefined
      nextCursor = null
      generation = undefined
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
    if (response.kind === 'partial') {
      commitPartial(response, round, refresh)
      return
    }
    if (response.kind === 'loading') {
      finishWithStatus('loading-host', 'Loading history…')
      scheduleRefresh(round)
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
      queryRevision += 1
      status = 'searching'
      message = 'Refreshing history…'
      publish()
      runSearch({ serial: round.serial, revision: queryRevision }, undefined, false)
      return
    }
    moreLoading = false
    finishWithStatus('stale', 'History changed — Retry')
  }

  const resetChain = (): void => {
    cancelSearch()
    cancelBody()
    queryRevision += 1
    moreLoading = false
    staleAutoUsed = false
    rows = []
    selectedId = undefined
    nextCursor = null
    generation = undefined
    progress = undefined
    body = { kind: 'none' }
  }

  const startFresh = (): void => {
    resetChain()
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
    resetChain()
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
      if (closed || (status !== 'ready' && status !== 'partial') || moreLoading) return
      const row = rows.find(candidate => candidate.id === id)
      if (row === undefined) return
      userChanged = true
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
      if (closed || moreLoading) return
      staleAutoUsed = false
      startFresh()
    },
    close(closeOptions) {
      if (closed) return
      closed = true
      cancelSearch()
      cancelBody()
      scopeSub?.()
      scopeSub = undefined
      if (closeOptions?.preserveScope !== true) options.scope.dispose()
      listeners.clear()
    },
    view() {
      return {
        serial,
        queryRevision,
        pageRevision,
        scope,
        query,
        status,
        message,
        progress,
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
