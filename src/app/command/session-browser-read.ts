/** Read-owner orchestration for the internal, read-only Session Browser. */
import { scheduler } from 'node:timers/promises'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { cancellationError, runOwned } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type {
  SessionContentSearchPage,
  SessionProjectionSummary,
  SessionReader,
} from '../../runtime/session-reader-port.ts'
import { sanitizeSessionSearchInput, sessionRowMatchesQuery } from '../../domain/session/browser.ts'
import type {
  SessionBrowserListState,
  SessionBrowserPanelHandle,
  SessionBrowserReadSnapshot,
  SessionBrowserResumeIntent,
  SessionBrowserRow,
  SessionBrowserSearchResult,
  SessionBrowserSearchState,
  SessionBrowserPresentation,
  SessionBrowserSubject,
} from './session-browser-presentation.ts'
import type { SessionScope } from '../session/scope.ts'

const FIRST_PROJECTION_BATCH = 20
const PROJECTION_BATCH_SIZE = 50
const CONTENT_SEARCH_DEBOUNCE_MS = 250

interface CapturedSessionBrowserSubject {
  readonly subject: SessionBrowserSubject
  readonly scope: SessionScope
}

export type SessionBrowserReadSettlement =
  | { readonly kind: 'ready' }
  | { readonly kind: 'matched'; readonly sessionId: string }
  | { readonly kind: 'refused'; readonly text: string }
  | { readonly kind: 'cancelled' }

/** The FINAL outcome of an accepted resume intent, owned by the command
 * operation that runs the real switch. The read owner only accepts the
 * request (`matched`); it never treats acceptance as a committed switch. */
export type SessionBrowserResumeSettlement =
  | { readonly kind: 'switched'; readonly sessionId: string }
  | { readonly kind: 'failed'; readonly text: string }
  | { readonly kind: 'indeterminate'; readonly text: string }
  | { readonly kind: 'cancelled' }

export interface SessionBrowserOpenOptions {
  readonly initialQuery?: string
  readonly directMatch?: {
    readonly query: string
    readonly find: (rows: readonly SessionBrowserRow[], query: string) => Pick<SessionBrowserRow, 'id'> | undefined
  }
}

interface ActiveRead {
  readonly subject: SessionBrowserSubject
  readonly scope: SessionScope
  readonly controller: AbortController
  readonly openOptions: SessionBrowserOpenOptions
  readonly settlement: Promise<SessionBrowserReadSettlement>
  readonly settle: (result: SessionBrowserReadSettlement) => void
  handle: SessionBrowserPanelHandle | undefined
  disposed: boolean
  rows: SessionBrowserRow[]
  listState: SessionBrowserListState
  listError: string | undefined
  /** The last accepted roster revision (see `SessionBrowserReadSnapshot`). */
  listRevision: number
  /** The accepted roster GENERATION of the projection batches: a refresh that
   *  accepts a new roster invalidates every in-flight batch of the old one. */
  projectionGeneration: number
  refreshError: string | undefined
  /** The ONE single-re-arm roster refresh timer; undefined while idle/other. */
  refreshTimer: ReturnType<typeof setTimeout> | undefined
  /** Whether a roster refresh read is in flight (never two in parallel). */
  refreshing: boolean
  projectionError: string | undefined
  query: string
  userQueryChanged: boolean
  queryGeneration: number
  /** Fences the ONE content search of a query generation: a search started by
   *  a roster refresh must not lose to an older in-flight search result. */
  searchRun: number
  queryController: AbortController | undefined
  queryTimer: ReturnType<typeof setTimeout> | undefined
  searchState: SessionBrowserSearchState
  searchResults: SessionBrowserSearchResult[]
  searchPage: SessionContentSearchPage | undefined
  searchError: string | undefined
  hasMore: boolean
  resumePending: boolean
  readonly resumeSettlement: Promise<SessionBrowserResumeSettlement>
  readonly resolveResume: (outcome: SessionBrowserResumeSettlement) => void
  resumeRequested: boolean
  resumeAttempt: number
  resumeSettledAttempt: number
  resumeHandleSettled: boolean
}

export interface SessionBrowserReadHandle {
  readonly settlement: Promise<SessionBrowserReadSettlement>
  /** The command-owned FINAL switch result for an accepted resume intent;
   * resolves `cancelled` when no resume was requested. */
  readonly resumeSettlement: Promise<SessionBrowserResumeSettlement>
  close(): void
}

export interface SessionBrowserReadOwner {
  open(options?: SessionBrowserOpenOptions): SessionBrowserReadHandle
  /** Ask the CURRENT panel to re-read its ONE roster now, through the SAME
   *  single refresh generation the timer uses. Inert with no active panel, a
   *  still-loading first read or a refresh already in flight. */
  refresh(): void
  dispose(): void
}

export interface SessionBrowserReadOwnerOptions {
  readonly reader: SessionReader
  readonly presentation: SessionBrowserPresentation
  readonly captureSubject: () => CapturedSessionBrowserSubject
  readonly diag: Diag
  readonly sessionId?: () => string | undefined
  /** PiTUI only: re-read the ONE roster on a single re-armed timer so the
   *  fullscreen Workspace does not paint a stale Session list. TSP leaves it
   *  undefined and keeps its historical single read. */
  readonly autoRefreshMs?: number
  /** App-owned handoff to the one existing SessionRuntime switch entry. The
   * callback MUST call `settle` with the REAL final outcome; an accepted
   * request is not a committed switch. `isCurrent` identifies the exact panel
   * operation so a late failure can never notify a newer Browser context. */
  readonly onResumeIntent?: (
    intent: SessionBrowserResumeIntent,
    scope: SessionScope,
    settle: (outcome: SessionBrowserResumeSettlement) => void,
    isCurrent: () => boolean,
  ) => void
}

/** Build one read owner. It owns every list, projection and search generation for its panel. */
export function createSessionBrowserReadOwner(options: SessionBrowserReadOwnerOptions): SessionBrowserReadOwner {
  let active: ActiveRead | undefined
  let disposed = false

  const snapshotOf = (panel: ActiveRead): SessionBrowserReadSnapshot => ({
    listState: panel.listState,
    rows: panel.rows,
    query: panel.query,
    resumePending: panel.resumePending,
    searchState: panel.searchState,
    searchResults: panel.searchResults,
    hasMore: panel.hasMore,
    listRevision: panel.listRevision,
    ...(panel.listError === undefined ? {} : { listError: panel.listError }),
    ...(panel.projectionError === undefined ? {} : { projectionError: panel.projectionError }),
    ...(panel.searchError === undefined ? {} : { searchError: panel.searchError }),
    ...(panel.refreshError === undefined ? {} : { refreshError: panel.refreshError }),
  })

  const isActive = (panel: ActiveRead): boolean => {
    if (active !== panel || panel.disposed || panel.controller.signal.aborted) return false
    if (!panel.subject.isCurrent()) {
      retire(panel, true)
      return false
    }
    return true
  }

  const publish = (panel: ActiveRead, initialQuery?: string): void => {
    if (!isActive(panel)) return
    const options = initialQuery === undefined ? undefined : { initialQuery }
    panel.handle?.setSnapshot(snapshotOf(panel), options)
  }

  const retire = (panel: ActiveRead, closePresenter: boolean): void => {
    if (panel.disposed) return
    panel.disposed = true
    panel.settle({ kind: 'cancelled' })
    // An accepted resume is owned by the command operation and must settle
    // with the REAL switch outcome; only a panel that never requested a resume
    // is cancelled here.
    if (!panel.resumeRequested && !panel.resumeHandleSettled) {
      panel.resumeHandleSettled = true
      panel.resolveResume({ kind: 'cancelled' })
    }
    if (panel.queryTimer !== undefined) clearTimeout(panel.queryTimer)
    panel.queryTimer = undefined
    if (panel.refreshTimer !== undefined) clearTimeout(panel.refreshTimer)
    panel.refreshTimer = undefined
    panel.refreshing = false
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

  const startProjectionBatch = (
    panel: ActiveRead,
    offset: number,
    limit: number,
    generation: number = panel.projectionGeneration,
  ): void => {
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
        // A batch read from an older accepted roster must never enrich (or
        // continue against) a newer one: its ids/titles may already be stale.
        if (!isActive(panel) || panel.projectionGeneration !== generation) return
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
          startProjectionBatch(panel, offset + batch.length, PROJECTION_BATCH_SIZE, generation)
        }
      },
      onError: (error) => {
        if (!isActive(panel) || panel.projectionGeneration !== generation) return
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
    const run = ++panel.searchRun
    const signal = AbortSignal.any([panel.controller.signal, queryController.signal])
    runOwned('session browser content search', () => options.reader.search(query, signal), {
      diag: options.diag,
      sessionId: options.sessionId,
      isCancellation: () => cancellation(panel)
        || queryController.signal.aborted
        || panel.queryGeneration !== expectedGeneration
        || panel.searchRun !== run,
      onResult: (page) => {
        if (!isActive(panel) || panel.queryGeneration !== expectedGeneration || panel.searchRun !== run) return
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
        if (!isActive(panel) || panel.queryGeneration !== expectedGeneration || panel.searchRun !== run) return
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

  const changeQuery = (panel: ActiveRead, rawQuery: string, userInitiated = true): void => {
    if (!isActive(panel)) return
    if (userInitiated) panel.userQueryChanged = true
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
    publish(panel, userInitiated ? undefined : query)
    if (!isActive(panel) || query === '') return
    scheduleSearch(panel)
  }

  const requestResume = (
    panel: ActiveRead,
    intent: SessionBrowserResumeIntent,
    permittedRows: readonly SessionBrowserRow[],
  ): boolean => {
    if (!isActive(panel)
      || intent.currentSessionId !== panel.subject.currentSessionId
      || intent.sessionId === panel.subject.currentSessionId
      || !permittedRows.some((row) => row.id === intent.sessionId)
      || panel.resumePending) return false
    if (options.onResumeIntent === undefined) {
      options.presentation.notify('Session switching is deferred to B1-B.', 'info')
      return false
    }
    panel.resumePending = true
    panel.resumeRequested = true
    // Each accepted intent is its own operation: a failed attempt must clear
    // its pending state and allow a retry; a late older attempt must not settle
    // the newer one.
    const attempt = ++panel.resumeAttempt
    const settle = (outcome: SessionBrowserResumeSettlement): void => {
      if (panel.resumeAttempt !== attempt || panel.resumeSettledAttempt === attempt) return
      panel.resumeSettledAttempt = attempt
      if (!panel.resumeHandleSettled) {
        panel.resumeHandleSettled = true
        panel.resolveResume(outcome)
      }
      if (!panel.disposed) {
        panel.resumePending = false
        publish(panel)
      }
    }
    publish(panel)
    if (!isActive(panel)) return false
    try {
      options.onResumeIntent(intent, panel.scope, settle, () => isActive(panel))
    } catch (error) {
      settle({ kind: 'failed', text: safeErrorMessage(error) })
    }
    return true
  }

  /** Accept ONE official roster as this panel's ONLY listing: the subagent
   *  children never enter it and the accepted revision advances. */
  const acceptRoster = (panel: ActiveRead, listed: readonly SessionBrowserRow[]): readonly SessionBrowserRow[] => {
    const listedRows = listed.map((row): SessionBrowserRow => ({ ...row }))
    panel.rows = listedRows.filter((row) => row.origin !== 'subagent')
    panel.listState = panel.rows.length === 0 ? 'empty' : 'ready'
    panel.listError = undefined
    panel.refreshError = undefined
    panel.listRevision += 1
    panel.projectionGeneration += 1
    // A presented search RESULT is a claim about one roster row: when the
    // accepted roster no longer lists that Session, the result must disappear
    // in the SAME publication. Waiting for the refreshed Host search (or a
    // projection batch, or a search that never re-runs after an unavailable/
    // error state) would leave a removed Session selectable and peekable.
    if (panel.searchResults.length > 0) {
      const live = new Set(panel.rows.map((row) => row.id))
      panel.searchResults = panel.searchResults.filter((result) => live.has(result.row.id))
    }
    return listedRows
  }

  /** Re-arm the ONE refresh timer. Only a COMPLETED read re-arms it, so two
   *  roster reads never overlap; a retired panel never re-arms. */
  const scheduleRefresh = (panel: ActiveRead): void => {
    if (options.autoRefreshMs === undefined || panel.disposed || panel.controller.signal.aborted) return
    if (panel.refreshTimer !== undefined) return
    panel.refreshTimer = setTimeout(() => {
      panel.refreshTimer = undefined
      startRefresh(panel)
    }, options.autoRefreshMs)
  }

  /** ONE background roster refresh through the SAME reader/owner. It never
   *  re-runs the direct match, never resolves a settlement, never rewrites the
   *  user's editor text and never resumes a Session. */
  const startRefresh = (panel: ActiveRead): void => {
    if (!isActive(panel) || panel.refreshing || panel.listState === 'loading') return
    panel.refreshing = true
    runOwned('session browser list refresh', () => options.reader.list(panel.subject.currentSessionId, panel.controller.signal), {
      diag: options.diag,
      sessionId: options.sessionId,
      isCancellation: () => cancellation(panel),
      onResult: (listed) => {
        panel.refreshing = false
        if (!isActive(panel)) return
        if (listed === undefined) {
          // A failed refresh NEVER empties the roster it already proved. The
          // nonfatal freshness fact is painted beside the last good list.
          panel.refreshError = 'session persistence unavailable'
          publish(panel)
          scheduleRefresh(panel)
          return
        }
        acceptRoster(panel, listed as readonly SessionBrowserRow[])
        publish(panel)
        if (!isActive(panel)) return
        startProjectionBatch(panel, 0, FIRST_PROJECTION_BATCH)
        // Re-run the ONE content search of the CURRENT query generation against
        // the refreshed roster. No second timer, no second generation.
        if (panel.query !== '' && panel.queryController !== undefined && panel.searchState === 'ready') {
          startSearch(panel, panel.queryGeneration)
        }
        scheduleRefresh(panel)
      },
      onError: (error) => {
        panel.refreshing = false
        if (!isActive(panel)) return
        panel.refreshError = safeErrorMessage(error)
        publish(panel)
        scheduleRefresh(panel)
      },
    })
  }

  const startList = (panel: ActiveRead): void => {
    if (!isActive(panel)) return
    runOwned('session browser list', async () => {
      // The presented panel gets one REAL event-loop turn (not a microtask):
      // its loading frame must be painted and focused before any Host read can
      // settle into it (the shared input-first ordering for both renderers).
      await scheduler.yield()
      if (cancellation(panel)) throw cancellationError('session browser list cancelled')
      return options.reader.list(panel.subject.currentSessionId, panel.controller.signal)
    }, {
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
          panel.settle({ kind: 'refused', text: 'session persistence unavailable' })
          // The fullscreen Workspace stays mounted on a refused first read: the
          // ONE refresh generation keeps trying instead of freezing the panel
          // on a transient Host outage.
          scheduleRefresh(panel)
          return
        }
        const listedRows = acceptRoster(panel, listed as readonly SessionBrowserRow[])
        const directMatch = panel.openOptions.directMatch
        if (directMatch !== undefined && listedRows.length === 0) {
          // An EMPTY roster only proves "no readable sessions": the official
          // listing publishes a Session from its header only, so a store whose
          // logs the reader refuses is indistinguishable here. Never claim
          // there are no persisted Sessions (the S2 limited contract).
          publish(panel)
          panel.settle({ kind: 'refused', text: 'No readable sessions' })
          return
        }
        // Native TSP direct matching is limited to visible main-session rows,
        // and an explicit Browser query edit supersedes the typed argument.
        const match = directMatch === undefined || panel.userQueryChanged
          ? undefined
          : directMatch.find(panel.rows, directMatch.query)
        if (match !== undefined) {
          if (match.id === panel.subject.currentSessionId) {
            panel.settle({ kind: 'refused', text: 'already on this session' })
            retire(panel, true)
            return
          }
          const accepted = requestResume(panel, {
            sessionId: match.id,
            currentSessionId: panel.subject.currentSessionId,
            source: 'direct',
          }, panel.rows)
          if (accepted) {
            panel.settle({ kind: 'matched', sessionId: match.id })
            retire(panel, true)
          } else {
            panel.settle({ kind: 'cancelled' })
          }
          return
        }
        const fallbackQuery = directMatch?.query ?? panel.openOptions.initialQuery
        if (fallbackQuery !== undefined && !panel.userQueryChanged) {
          const previousQuery = panel.query
          changeQuery(panel, fallbackQuery, false)
          if (panel.query === previousQuery) {
            publish(panel, sanitizeSessionSearchInput(fallbackQuery))
          }
        } else {
          publish(panel)
          if (panel.query !== '') scheduleSearch(panel)
        }
        panel.settle({ kind: 'ready' })
        if (!isActive(panel)) return
        startProjectionBatch(panel, 0, FIRST_PROJECTION_BATCH)
        scheduleRefresh(panel)
      },
      onError: (error) => {
        if (!isActive(panel)) return
        const message = safeErrorMessage(error)
        panel.listState = 'error'
        panel.listError = message
        panel.rows = []
        panel.searchState = 'idle'
        panel.searchResults = []
        publish(panel)
        panel.settle({ kind: 'refused', text: message })
        scheduleRefresh(panel)
      },
    })
  }

  return {
    open(openOptions = {}) {
      if (disposed) throw new Error('the Session Browser read owner is disposed')
      if (active !== undefined) retire(active, true)
      const captured = options.captureSubject()
      let resolveSettlement!: (result: SessionBrowserReadSettlement) => void
      let settlementResolved = false
      const settlement = new Promise<SessionBrowserReadSettlement>((resolve) => { resolveSettlement = resolve })
      let resolveResume!: (outcome: SessionBrowserResumeSettlement) => void
      const resumeSettlement = new Promise<SessionBrowserResumeSettlement>((resolve) => { resolveResume = resolve })
      const settle = (result: SessionBrowserReadSettlement): void => {
        if (settlementResolved) return
        settlementResolved = true
        resolveSettlement(result)
      }
      const panel: ActiveRead = {
        subject: captured.subject,
        scope: captured.scope,
        controller: new AbortController(),
        openOptions,
        settlement,
        settle,
        handle: undefined,
        disposed: false,
        rows: [],
        listState: 'loading',
        listError: undefined,
        listRevision: 0,
        projectionGeneration: 0,
        refreshError: undefined,
        refreshTimer: undefined,
        refreshing: false,
        projectionError: undefined,
        query: '',
        userQueryChanged: false,
        queryGeneration: 0,
        searchRun: 0,
        queryController: undefined,
        queryTimer: undefined,
        searchState: 'idle',
        searchResults: [],
        searchPage: undefined,
        searchError: undefined,
        hasMore: false,
        resumePending: false,
        resumeSettlement,
        resolveResume,
        resumeRequested: false,
        resumeAttempt: 0,
        resumeSettledAttempt: 0,
        resumeHandleSettled: false,
      }
      active = panel
      let presentationHandle: SessionBrowserPanelHandle
      try {
        presentationHandle = options.presentation.open({
          subject: panel.subject,
          onQueryChange: (query) => changeQuery(panel, query),
          onResumeIntent: (intent) => {
            if (intent.source === 'direct') return
            requestResume(panel, intent, panel.rows)
          },
          onClose: () => retire(panel, false),
        })
      } catch (error) {
        // A presenter that refuses to open (the PiTUI fullscreen lease is held
        // by a blocking modal, another workspace or a transition freeze) must
        // not leave a hidden, still-active read generation behind. Retire this
        // panel WITHOUT closing a presenter that never opened, start no list
        // and re-throw the real refusal to the command that owns the result.
        retire(panel, false)
        throw error
      }
      panel.handle = presentationHandle
      const handle: SessionBrowserReadHandle = { settlement, resumeSettlement, close: () => retire(panel, true) }
      if (!isActive(panel)) {
        if (!presentationHandle.isDisposed()) presentationHandle.close()
        return handle
      }
      // A presenter may legitimately REFUSE this panel: the renderer's own
      // four-way presenter exclusivity returns an inert, already-disposed
      // handle when a newer presenter won a reentrant open. This owner must
      // then retire ITS panel and start NO read — a hidden listing behind an
      // inert presentation is a read for a surface nobody can see.
      if (presentationHandle.isDisposed()) {
        retire(panel, false)
        return handle
      }
      panel.handle.setSnapshot(snapshotOf(panel))
      if (!isActive(panel)) return handle
      startList(panel)
      return handle
    },
    refresh() {
      if (active === undefined || !isActive(active)) return
      if (active.refreshTimer !== undefined) {
        clearTimeout(active.refreshTimer)
        active.refreshTimer = undefined
      }
      startRefresh(active)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (active !== undefined) retire(active, true)
    },
  }
}
