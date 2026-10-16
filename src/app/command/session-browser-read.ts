/** Read-owner orchestration for the internal, read-only Session Browser. */
import { scheduler } from 'node:timers/promises'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { runOwned } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type {
  SessionContentSearchPage,
  SessionProjectionSummary,
  SessionReader,
} from '../../runtime/session-reader-port.ts'
import { sanitizeSessionSearchInput, sessionRowMatchesQuery } from '../../domain/session/browser.ts'
import type {
  CaptureSessionBrowserSubject,
  SessionBrowserListState,
  SessionBrowserPanelHandle,
  SessionBrowserReadSnapshot,
  SessionBrowserResumeIntent,
  SessionBrowserRow,
  SessionBrowserSearchResult,
  SessionBrowserSearchState,
  SessionBrowserPresentation,
} from './session-browser-presentation.ts'

const FIRST_PROJECTION_BATCH = 20
const PROJECTION_BATCH_SIZE = 50
const CONTENT_SEARCH_DEBOUNCE_MS = 250

interface ActiveRead {
  readonly subject: ReturnType<CaptureSessionBrowserSubject>
  readonly controller: AbortController
  handle: SessionBrowserPanelHandle | undefined
  disposed: boolean
  rows: SessionBrowserRow[]
  listState: SessionBrowserListState
  listError: string | undefined
  projectionError: string | undefined
  query: string
  queryGeneration: number
  queryController: AbortController | undefined
  queryTimer: ReturnType<typeof setTimeout> | undefined
  searchState: SessionBrowserSearchState
  searchResults: SessionBrowserSearchResult[]
  searchPage: SessionContentSearchPage | undefined
  searchError: string | undefined
  hasMore: boolean
}

export interface SessionBrowserReadHandle {
  close(): void
}

export interface SessionBrowserReadOwner {
  open(): SessionBrowserReadHandle
  dispose(): void
}

export interface SessionBrowserReadOwnerOptions {
  readonly reader: SessionReader
  readonly presentation: SessionBrowserPresentation
  readonly captureSubject: CaptureSessionBrowserSubject
  readonly diag: Diag
  readonly sessionId?: () => string | undefined
  /** Test-only B1-A observation / B1-B handoff; never a writer in this owner. */
  readonly onResumeIntent?: (intent: SessionBrowserResumeIntent) => void
}

/** Build one read owner. It owns every list, projection and search generation for its panel. */
export function createSessionBrowserReadOwner(options: SessionBrowserReadOwnerOptions): SessionBrowserReadOwner {
  let active: ActiveRead | undefined
  let disposed = false

  const snapshotOf = (panel: ActiveRead): SessionBrowserReadSnapshot => ({
    listState: panel.listState,
    rows: panel.rows,
    query: panel.query,
    searchState: panel.searchState,
    searchResults: panel.searchResults,
    hasMore: panel.hasMore,
    ...(panel.listError === undefined ? {} : { listError: panel.listError }),
    ...(panel.projectionError === undefined ? {} : { projectionError: panel.projectionError }),
    ...(panel.searchError === undefined ? {} : { searchError: panel.searchError }),
  })

  const isActive = (panel: ActiveRead): boolean => {
    if (active !== panel || panel.disposed || panel.controller.signal.aborted) return false
    if (!panel.subject.isCurrent()) {
      retire(panel, true)
      return false
    }
    return true
  }

  const publish = (panel: ActiveRead): void => {
    if (!isActive(panel)) return
    panel.handle?.setSnapshot(snapshotOf(panel))
  }

  const retire = (panel: ActiveRead, closePresenter: boolean): void => {
    if (panel.disposed) return
    panel.disposed = true
    if (panel.queryTimer !== undefined) clearTimeout(panel.queryTimer)
    panel.queryTimer = undefined
    panel.queryController?.abort()
    panel.controller.abort()
    panel.rows = []
    panel.searchResults = []
    panel.searchPage = undefined
    panel.hasMore = false
    if (active === panel) active = undefined
    if (closePresenter) panel.handle?.close()
  }

  const cancellation = (panel: ActiveRead): boolean =>
    panel.controller.signal.aborted || !isActive(panel)

  const localResults = (panel: ActiveRead): SessionBrowserSearchResult[] =>
    panel.rows
      .filter((row) => sessionRowMatchesQuery(row, panel.query))
      .map((row) => ({ row, source: 'Metadata' }))

  const mergeSearchPage = (
    rows: readonly SessionBrowserRow[],
    query: string,
    page: SessionContentSearchPage,
  ): SessionBrowserSearchResult[] => {
    const metadataRows = rows.filter((row) => sessionRowMatchesQuery(row, query))
    const metadataIds = new Set(metadataRows.map((row) => row.id))
    const rowById = new Map(rows.map((row) => [row.id, row]))
    const contentById = new Map<string, string>()
    for (const item of page.items) {
      if (rowById.has(item.sessionId) && !contentById.has(item.sessionId)) {
        contentById.set(item.sessionId, item.snippet)
      }
    }
    const results: SessionBrowserSearchResult[] = metadataRows.map((row) => {
      const snippet = contentById.get(row.id)
      return snippet === undefined
        ? { row, source: 'Metadata' }
        : { row, source: 'Both', snippet }
    })
    for (const [id, snippet] of contentById) {
      if (metadataIds.has(id)) continue
      const row = rowById.get(id)
      if (row !== undefined) results.push({ row, source: 'Content', snippet })
    }
    return results
  }

  const startProjectionBatch = (panel: ActiveRead, offset: number, limit: number): void => {
    const batch = panel.rows.slice(offset, offset + limit)
    if (batch.length === 0 || !isActive(panel)) return
    const signal = panel.controller.signal
    runOwned('session browser projection batch', async () => {
      if (offset >= FIRST_PROJECTION_BATCH) await scheduler.yield()
      return options.reader.projectionBatch(batch, signal)
    }, {
      diag: options.diag,
      sessionId: options.sessionId,
      isCancellation: () => cancellation(panel),
      onResult: (projections: Map<string, SessionProjectionSummary>) => {
        if (!isActive(panel)) return
        const enriched = panel.rows.map((row) => {
          const projection = projections.get(row.id)
          if (projection === undefined) return row
          return {
            ...row,
            ...(projection.title === undefined ? {} : { title: projection.title }),
            ...(projection.preset === undefined ? {} : { preset: projection.preset }),
          }
        })
        panel.rows = enriched
        if (panel.query !== '') {
          panel.searchResults = panel.searchState === 'ready' && panel.searchPage !== undefined
            ? mergeSearchPage(panel.rows, panel.query, panel.searchPage)
            : localResults(panel)
        }
        publish(panel)
        if (!isActive(panel)) return
        if (offset + batch.length < panel.rows.length) {
          startProjectionBatch(panel, offset + batch.length, PROJECTION_BATCH_SIZE)
        }
      },
      onError: (error) => {
        if (!isActive(panel)) return
        panel.projectionError = safeErrorMessage(error)
        publish(panel)
      },
    })
  }

  const startSearch = (panel: ActiveRead, expectedGeneration: number): void => {
    if (!isActive(panel) || panel.query === '' || panel.queryGeneration !== expectedGeneration) return
    const queryController = panel.queryController
    if (queryController === undefined) return
    panel.queryTimer = undefined
    const query = panel.query
    const signal = AbortSignal.any([panel.controller.signal, queryController.signal])
    runOwned('session browser content search', () => options.reader.search(query, signal), {
      diag: options.diag,
      sessionId: options.sessionId,
      isCancellation: () => cancellation(panel)
        || queryController.signal.aborted
        || panel.queryGeneration !== expectedGeneration,
      onResult: (page) => {
        if (!isActive(panel) || panel.queryGeneration !== expectedGeneration) return
        panel.searchPage = page
        if (page === undefined) {
          panel.searchState = 'unavailable'
          panel.searchResults = localResults(panel)
          panel.hasMore = false
        } else {
          panel.searchState = 'ready'
          panel.searchResults = mergeSearchPage(panel.rows, query, page)
          panel.hasMore = page.hasMore
        }
        publish(panel)
      },
      onError: (error) => {
        if (!isActive(panel) || panel.queryGeneration !== expectedGeneration) return
        panel.searchState = 'error'
        panel.searchResults = localResults(panel)
        panel.searchPage = undefined
        panel.hasMore = false
        panel.searchError = safeErrorMessage(error)
        publish(panel)
      },
    })
  }

  const scheduleSearch = (panel: ActiveRead): void => {
    if (panel.query === '' || panel.listState === 'loading' || panel.listState === 'unavailable' || panel.listState === 'error') return
    const expectedGeneration = panel.queryGeneration
    panel.searchState = 'loading'
    panel.searchResults = localResults(panel)
    panel.hasMore = false
    panel.searchError = undefined
    publish(panel)
    if (!isActive(panel)) return
    panel.queryTimer = setTimeout(() => startSearch(panel, expectedGeneration), CONTENT_SEARCH_DEBOUNCE_MS)
  }

  const changeQuery = (panel: ActiveRead, rawQuery: string): void => {
    if (!isActive(panel)) return
    const query = sanitizeSessionSearchInput(rawQuery)
    if (query === panel.query) return
    if (panel.queryTimer !== undefined) clearTimeout(panel.queryTimer)
    panel.queryTimer = undefined
    panel.queryController?.abort()
    panel.queryGeneration++
    panel.queryController = query === '' ? undefined : new AbortController()
    panel.query = query
    panel.searchState = query === '' || panel.listState === 'unavailable' || panel.listState === 'error'
      ? 'idle'
      : 'loading'
    panel.searchResults = query === '' ? [] : localResults(panel)
    panel.searchPage = undefined
    panel.hasMore = false
    panel.searchError = undefined
    publish(panel)
    if (!isActive(panel) || query === '') return
    scheduleSearch(panel)
  }

  const startList = (panel: ActiveRead): void => {
    if (!isActive(panel)) return
    runOwned('session browser list', () => options.reader.list(panel.subject.currentSessionId, panel.controller.signal), {
      diag: options.diag,
      sessionId: options.sessionId,
      isCancellation: () => cancellation(panel),
      onResult: (listed) => {
        if (!isActive(panel)) return
        if (listed === undefined) {
          panel.listState = 'unavailable'
          panel.rows = []
          panel.searchState = 'idle'
          panel.searchResults = []
          panel.searchPage = undefined
          panel.searchError = undefined
          publish(panel)
          return
        }
        panel.rows = listed
          .filter((row) => row.origin !== 'subagent')
          .map((row): SessionBrowserRow => ({ ...row }))
        panel.listState = panel.rows.length === 0 ? 'empty' : 'ready'
        panel.listError = undefined
        publish(panel)
        if (!isActive(panel)) return
        startProjectionBatch(panel, 0, FIRST_PROJECTION_BATCH)
        if (panel.query !== '') scheduleSearch(panel)
      },
      onError: (error) => {
        if (!isActive(panel)) return
        panel.listState = 'error'
        panel.listError = safeErrorMessage(error)
        panel.rows = []
        panel.searchState = 'idle'
        panel.searchResults = []
        publish(panel)
      },
    })
  }

  return {
    open() {
      if (disposed) throw new Error('the Session Browser read owner is disposed')
      if (active !== undefined) retire(active, true)
      const subject = options.captureSubject()
      const panel: ActiveRead = {
        subject,
        controller: new AbortController(),
        handle: undefined,
        disposed: false,
        rows: [],
        listState: 'loading',
        listError: undefined,
        projectionError: undefined,
        query: '',
        queryGeneration: 0,
        queryController: undefined,
        queryTimer: undefined,
        searchState: 'idle',
        searchResults: [],
        searchPage: undefined,
        searchError: undefined,
        hasMore: false,
      }
      active = panel
      const presentationHandle = options.presentation.open({
        subject,
        onQueryChange: (query) => changeQuery(panel, query),
        onResumeIntent: (intent) => {
          if (!isActive(panel)
            || intent.currentSessionId !== panel.subject.currentSessionId
            || intent.sessionId === panel.subject.currentSessionId
            || !panel.rows.some((row) => row.id === intent.sessionId)) return
          if (options.onResumeIntent === undefined) {
            options.presentation.notify('Session switching is deferred to B1-B.', 'info')
            return
          }
          options.onResumeIntent(intent)
        },
        onClose: () => retire(panel, false),
      })
      panel.handle = presentationHandle
      const handle = { close: () => retire(panel, true) }
      if (!isActive(panel)) {
        if (!presentationHandle.isDisposed()) presentationHandle.close()
        return handle
      }
      panel.handle.setSnapshot(snapshotOf(panel))
      if (!isActive(panel)) return handle
      startList(panel)
      return handle
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (active !== undefined) retire(active, true)
    },
  }
}
