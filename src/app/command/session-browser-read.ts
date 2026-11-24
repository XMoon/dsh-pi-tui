/** Read-owner orchestration for the internal, read-only Session Browser. */
import { scheduler } from 'node:timers/promises'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import { cancellationError, runOwned } from '../../runtime/process/tasks.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import type {
  SessionContentSearchPage,
  SessionProjectionSummary,
  SessionReader,
  SessionReaderListSnapshot,
  SessionReaderObservableList,
} from '../../runtime/session-reader-port.ts'
import { sanitizeSessionSearchInput, sessionRowMatchesQuery } from '../../domain/session/browser.ts'
import type {
  SessionBrowserAnswerEligibility,
  SessionBrowserListState,
  SessionBrowserPanelHandle,
  SessionBrowserReadSnapshot,
  SessionBrowserResumeIntent,
  SessionBrowserRow,
  SessionBrowserSearchResult,
  SessionBrowserSearchState,
  SessionBrowserPresentation,
  SessionBrowserSubject,
  SessionBrowserWorkspaceSnapshot,
  SessionInspectorSnapshot,
} from './session-browser-presentation.ts'
import type {
  ActivityObservation,
  ActivityObservationSnapshot,
  InspectorInvalidation,
  SessionInspectorReadResult,
  SessionInspectorSource,
  SessionWorkspaceFact,
  SessionWorkspaceFactsPort,
  WorkspaceFactsFrame,
  WorkspaceFactsHandle,
} from '../../runtime/session-workspace-facts-port.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'
import type { SessionScope } from '../session/scope.ts'

const FIRST_PROJECTION_BATCH = 20
const PROJECTION_BATCH_SIZE = 50
const CONTENT_SEARCH_DEBOUNCE_MS = 250
/** The fixed selected-Session Inspector debounce: a settled typed selection
 *  must reach exactly ONE exact read after this window. */
const INSPECTOR_DEBOUNCE_MS = 150

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
  readonly initialDirectoryChooser?: boolean
  readonly initialDirectoryEntry?: boolean
  readonly initialDirectoryPath?: string
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
  rosterRows: SessionBrowserRow[]
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
  workspaceHandle: WorkspaceFactsHandle | undefined
  workspaceById: Map<string, SessionWorkspaceFact>
  workspaceOrder: string[]
  workspaceBaselineProven: boolean
  workspaceState: 'loading' | 'ready' | 'unavailable'
  workspaceRevision: number
  workspaceError: string | undefined
  /** Whether the ONE Workspace follow ended terminally for this generation: a
   *  NEW Connection generation may open ONE new logical handle. */
  workspaceTerminal: boolean
  /** How many Connection generation changes this open observed. A change that
   *  landed BEFORE a terminal failure is still the legal rebind trigger. */
  /** The attempt identity of the last terminal Workspace failure: only a live
   *  generation different from THIS identity may open one new logical handle. */
  workspaceFailedGeneration: unknown
  workspaceGenerationOff: (() => void) | undefined
  /** The accepted roster's painted semantics: the ONE input of the roster
   *  delta, so an unchanged official list never bumps the revision or restarts
   *  projections/search. */
  rosterSemantics: string
  /** The ONE per-open incremental activity observation. */
  activityHandle: ActivityObservation | undefined
  activityUnsubscribe: (() => void) | undefined
  activitySnapshot: ActivityObservationSnapshot | undefined
  /** The push-driven official list subscription (Remote only). */
  listSubscription: (() => void) | undefined
  answerEligibility: readonly SessionBrowserAnswerEligibility[] | undefined
  eligibilitySubscription: (() => void) | undefined
  resumePending: boolean
  readonly resumeSettlement: Promise<SessionBrowserResumeSettlement>
  readonly resolveResume: (outcome: SessionBrowserResumeSettlement) => void
  resumeRequested: boolean
  resumeAttempt: number
  resumeSettledAttempt: number
  resumeHandleSettled: boolean
  /** The ONE selected-Session Inspector lifecycle of this panel. */
  inspectorId: string | undefined
  inspectorSource: SessionInspectorSource | undefined
  inspectorSnapshot: SessionInspectorSnapshot | undefined
  /** Bumped on selection change AND `source-replaced`; a read/invalidation
   *  captured under an older epoch is inert. */
  inspectorSourceEpoch: number
  /** Request identity of the one in-flight Inspector read. */
  inspectorRequestEpoch: number
  inspectorRequestController: AbortController | undefined
  inspectorTimer: ReturnType<typeof setTimeout> | undefined
  /** A real same-source relevant change arrived and a trailing exact read is due. */
  inspectorDirty: boolean
  /** The debounce expired while the one physical read was still unsettled. */
  inspectorDue: boolean
  /** At most ONE coalesced deferred publication is queued. */
  inspectorPublishScheduled: boolean
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
  readonly sessionWorkspaceFacts?: SessionWorkspaceFactsPort
  readonly forwardedAnswerEligibility?: () => readonly SessionBrowserAnswerEligibility[]
  readonly subscribeForwardedAnswerEligibility?: (listener: () => void) => () => void
  readonly onUseDirectory?: (workspaceId: string, canonicalPath: string) => void
  readonly onWorkspaceNewSession?: (workspaceId: string, closeAfterCommit: () => void, settle?: (outcome: import('./session-browser-presentation.ts').SessionBrowserNewSessionSettlement) => void) => void
  readonly onAddDirectory?: (path: string, settle: (outcome: import('./session-browser-presentation.ts').SessionBrowserDirectorySettlement) => void) => void
  /** Session Workspace PR3: the ONE read-only Host directory browse seam,
   *  forwarded VERBATIM to the presentation. The read owner never calls or
   *  caches a directory query itself — the inline editor owns that lifetime. */
  readonly onListDirectory?: import('../../runtime/host-directory-browse-port.ts').HostDirectoryBrowsePort['list']
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
  /** The ONE physical selected-Session Inspector read of this owner. It is
   *  released only when the actual promise settles, so a retire/reopen never
   *  treats an aborted-but-pending read as free capacity. */
  let inspectorInFlight = false

  /** The accepted Activity observation's provenance. A snapshot measured on an
   *  OLDER roster is inert: its facts and revision can never be relabeled as the
   *  current roster. The revision and the roster revision travel SEPARATELY. */
  const activityProvenanceOf = (panel: ActiveRead): {
    readonly activityRevision?: number
    readonly activityRosterRevision?: number
    readonly activity?: ActivityObservationSnapshot['facts']
    readonly activityError?: string
  } => {
    const snapshot = panel.activitySnapshot
    if (snapshot === undefined || snapshot.rosterRevision !== panel.listRevision) return {}
    return {
      activityRevision: snapshot.revision,
      activityRosterRevision: snapshot.rosterRevision,
      activity: snapshot.facts,
      ...(snapshot.error === undefined ? {} : { activityError: snapshot.error }),
    }
  }

  const workspaceSnapshotOf = (panel: ActiveRead): SessionBrowserWorkspaceSnapshot | undefined => {
    if (options.sessionWorkspaceFacts === undefined) return undefined
    return {
      revision: panel.workspaceRevision,
      state: panel.workspaceState,
      facts: panel.workspaceOrder.flatMap(id => {
        const fact = panel.workspaceById.get(id)
        return fact === undefined ? [] : [fact]
      }),
      baselineProven: panel.workspaceBaselineProven,
      ...activityProvenanceOf(panel),
      answerEligibility: panel.answerEligibility,
      ...(panel.workspaceError === undefined ? {} : { error: panel.workspaceError }),
    }
  }

  const snapshotOf = (panel: ActiveRead): SessionBrowserReadSnapshot => ({
    listState: panel.listState,
    rows: panel.rows,
    query: panel.query,
    resumePending: panel.resumePending,
    searchState: panel.searchState,
    searchResults: panel.searchResults,
    hasMore: panel.hasMore,
    listRevision: panel.listRevision,
    ...(panel.inspectorSnapshot === undefined ? {} : { inspector: panel.inspectorSnapshot }),
    ...(workspaceSnapshotOf(panel) === undefined ? {} : { workspace: workspaceSnapshotOf(panel)! }),
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

  // ── Selected-Session Inspector lifecycle ──────────────────────────────────
  // ONE read per settled selection, at most ONE physical flight per owner and
  // no timer/queue per id. The renderer reports its own painted typed selection;
  // this owner never guesses a target and never publishes from the render call.

  /** At most ONE deferred publication for selection/refresh/clear state: the
   *  presenter's committed frame callback must never synchronously re-enter
   *  `setSnapshot`/render/Host reads. */
  const scheduleInspectorPublish = (panel: ActiveRead): void => {
    if (panel.inspectorPublishScheduled || panel.disposed) return
    panel.inspectorPublishScheduled = true
    queueMicrotask(() => {
      panel.inspectorPublishScheduled = false
      if (!isActive(panel)) return
      publish(panel)
    })
  }

  /** Release the panel's ONE selected source and fence its in-flight request. */
  const stopInspectorSource = (panel: ActiveRead): void => {
    const source = panel.inspectorSource
    panel.inspectorSource = undefined
    source?.dispose()
    panel.inspectorRequestController?.abort()
    panel.inspectorRequestController = undefined
  }

  /** Drop this panel's selection/read state. The owner-level physical read slot
   *  is NOT touched here: an aborted promise may still be settling. */
  const clearInspector = (panel: ActiveRead, publishAfter: boolean): void => {
    panel.inspectorId = undefined
    panel.inspectorSnapshot = undefined
    panel.inspectorSourceEpoch += 1
    panel.inspectorDirty = false
    panel.inspectorDue = false
    if (panel.inspectorTimer !== undefined) {
      clearTimeout(panel.inspectorTimer)
      panel.inspectorTimer = undefined
    }
    stopInspectorSource(panel)
    if (publishAfter) scheduleInspectorPublish(panel)
  }

  const commitInspectorResult = (
    panel: ActiveRead,
    sessionId: string,
    result: SessionInspectorReadResult,
  ): void => {
    if (result.kind === 'ready') {
      panel.inspectorSnapshot = {
        sessionId,
        state: 'ready',
        data: result.data,
        refreshing: panel.inspectorDirty,
      }
      return
    }
    panel.inspectorSnapshot = { sessionId, state: result.kind, message: result.message }
  }

  const startInspectorRead = (panel: ActiveRead): void => {
    if (!isActive(panel)) return
    // A newer intent is recorded, not queued as a second physical read.
    if (inspectorInFlight) {
      panel.inspectorDue = true
      return
    }
    const sessionId = panel.inspectorId
    const source = panel.inspectorSource
    const sourceEpoch = panel.inspectorSourceEpoch
    if (sessionId === undefined || source === undefined) return
    // Re-prove the accepted roster at admission: a removed target never reads.
    if (!panel.rosterRows.some(row => row.id === sessionId)) {
      clearInspector(panel, true)
      return
    }
    const controller = new AbortController()
    const requestEpoch = ++panel.inspectorRequestEpoch
    panel.inspectorRequestController = controller
    panel.inspectorDirty = false
    panel.inspectorDue = false
    inspectorInFlight = true
    const isCurrentAttempt = (): boolean => isActive(panel)
      && panel.inspectorId === sessionId
      && panel.inspectorSource === source
      && panel.inspectorSourceEpoch === sourceEpoch
      && panel.inspectorRequestEpoch === requestEpoch
    runOwned('session inspector read', () => source.read(controller.signal), {
      diag: options.diag,
      sessionId: options.sessionId,
      isCancellation: error => error instanceof SupersededReadError
        || controller.signal.aborted
        || cancellation(panel)
        || !isCurrentAttempt(),
      onResult: (result: SessionInspectorReadResult) => {
        inspectorInFlight = false
        if (panel.inspectorRequestController === controller) panel.inspectorRequestController = undefined
        if (!isCurrentAttempt()) {
          startDueInspectorRead()
          return
        }
        // Commit BEFORE publishing; the publication may synchronously repaint.
        commitInspectorResult(panel, sessionId, result)
        publish(panel)
        startDueInspectorRead()
      },
      onError: (error) => {
        inspectorInFlight = false
        if (panel.inspectorRequestController === controller) panel.inspectorRequestController = undefined
        if (!isCurrentAttempt()) {
          startDueInspectorRead()
          return
        }
        panel.inspectorSnapshot = { sessionId, state: 'error', message: safeErrorMessage(error) }
        publish(panel)
        startDueInspectorRead()
      },
      onCancel: () => {
        inspectorInFlight = false
        if (panel.inspectorRequestController === controller) panel.inspectorRequestController = undefined
        startDueInspectorRead()
      },
    })
  }

  /** The one physical read settled: start the latest due intent, if any. */
  const startDueInspectorRead = (): void => {
    const panel = active
    if (panel === undefined || !panel.inspectorDue || !isActive(panel)) return
    panel.inspectorDue = false
    startInspectorRead(panel)
  }

  const scheduleInspectorRead = (panel: ActiveRead): void => {
    if (!isActive(panel) || panel.inspectorId === undefined || panel.inspectorSource === undefined) return
    if (panel.inspectorTimer !== undefined) clearTimeout(panel.inspectorTimer)
    panel.inspectorTimer = setTimeout(() => {
      panel.inspectorTimer = undefined
      if (!isActive(panel)) return
      if (inspectorInFlight) {
        panel.inspectorDue = true
        return
      }
      startInspectorRead(panel)
    }, INSPECTOR_DEBOUNCE_MS)
  }

  const onInspectorInvalidated = (
    panel: ActiveRead,
    sourceEpoch: number,
    reason: InspectorInvalidation,
  ): void => {
    if (!isActive(panel) || panel.inspectorSourceEpoch !== sourceEpoch || panel.inspectorId === undefined) return
    if (reason === 'source-replaced') {
      // Revoke the old exact cut and fence the in-flight read by epoch; the same
      // source stays responsible for the fresh identity.
      panel.inspectorSourceEpoch += 1
      panel.inspectorSnapshot = { sessionId: panel.inspectorId, state: 'loading' }
      panel.inspectorDirty = false
      panel.inspectorDue = false
      panel.inspectorRequestController?.abort()
      panel.inspectorRequestController = undefined
      scheduleInspectorRead(panel)
    } else {
      // Same identity: keep the known cut, mark it refreshing, and coalesce ONE
      // trailing exact read; never abort a legitimate same-source read.
      panel.inspectorDirty = true
      if (panel.inspectorSnapshot?.state === 'ready') {
        panel.inspectorSnapshot = { ...panel.inspectorSnapshot, refreshing: true }
      }
      scheduleInspectorRead(panel)
    }
    scheduleInspectorPublish(panel)
  }

  /** The renderer's ONE committed-frame typed selection report. Repeated ids
   *  and pre-handle renders are inert; an unauthorized/undefined id clears. */
  const reportInspectorSelection = (panel: ActiveRead, sessionId: string | undefined): void => {
    if (!isActive(panel) || panel.handle === undefined) return
    if (sessionId === undefined || !panel.rosterRows.some(row => row.id === sessionId)) {
      if (panel.inspectorId !== undefined || panel.inspectorSnapshot !== undefined) clearInspector(panel, true)
      return
    }
    // A repeated same-id frame never recreates the source or restarts the timer.
    if (panel.inspectorId === sessionId) return
    // Commit the new selection identity BEFORE releasing the old source/read.
    panel.inspectorId = sessionId
    panel.inspectorSourceEpoch += 1
    const sourceEpoch = panel.inspectorSourceEpoch
    if (panel.inspectorTimer !== undefined) {
      clearTimeout(panel.inspectorTimer)
      panel.inspectorTimer = undefined
    }
    panel.inspectorDirty = false
    panel.inspectorDue = false
    stopInspectorSource(panel)
    panel.inspectorSnapshot = { sessionId, state: 'loading' }
    const facts = options.sessionWorkspaceFacts
    const openInspector = facts?.openInspector
    if (openInspector === undefined) {
      panel.inspectorSnapshot = { sessionId, state: 'unavailable', message: 'Session statistics unavailable' }
      scheduleInspectorPublish(panel)
      return
    }
    let source: SessionInspectorSource | undefined
    try {
      source = openInspector.call(facts, sessionId, (reason) => {
        if (source === undefined || panel.inspectorSource !== source) return
        onInspectorInvalidated(panel, sourceEpoch, reason)
      })
    } catch (error) {
      options.diag.error('session inspector source', { error: safeErrorMessage(error) })
      panel.inspectorSnapshot = { sessionId, state: 'error', message: safeErrorMessage(error) }
      scheduleInspectorPublish(panel)
      return
    }
    if (source === undefined) return
    panel.inspectorSource = source
    scheduleInspectorRead(panel)
    scheduleInspectorPublish(panel)
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
    // The selected Inspector read belongs to THIS panel: clear its selection,
    // timer and subscription and fence its request before the panel data is
    // dropped. The owner-level physical slot stays until the promise settles.
    clearInspector(panel, false)
    const activityUnsubscribe = panel.activityUnsubscribe
    panel.activityUnsubscribe = undefined
    activityUnsubscribe?.()
    const activityHandle = panel.activityHandle
    panel.activityHandle = undefined
    panel.activitySnapshot = undefined
    activityHandle?.dispose()
    const listSubscription = panel.listSubscription
    panel.listSubscription = undefined
    listSubscription?.()
    const workspaceHandle = panel.workspaceHandle
    panel.workspaceHandle = undefined
    workspaceHandle?.dispose()
    const workspaceGenerationOff = panel.workspaceGenerationOff
    panel.workspaceGenerationOff = undefined
    workspaceGenerationOff?.()
    const unsubscribeEligibility = panel.eligibilitySubscription
    panel.eligibilitySubscription = undefined
    unsubscribeEligibility?.()
    panel.rosterRows = []
    panel.rows = []
    panel.searchResults = []
    panel.searchPage = undefined
    panel.hasMore = false
    if (active === panel) active = undefined
    if (closePresenter) panel.handle?.close()
  }

  const cancellation = (panel: ActiveRead): boolean =>
    panel.controller.signal.aborted || !isActive(panel)

  const workspaceMetadataOf = (panel: ActiveRead, sessionId: string) => {
    if (!panel.workspaceBaselineProven) return undefined
    let found: SessionWorkspaceFact | undefined
    for (const workspaceId of panel.workspaceOrder) {
      const workspace = panel.workspaceById.get(workspaceId)
      if (workspace === undefined || !workspace.sessionIds.includes(sessionId)) continue
      if (found !== undefined) return undefined
      found = workspace
    }
    return found === undefined
      ? undefined
      : { workspaceId: found.workspaceId, title: found.title, path: found.path }
  }

  const rowsWithWorkspaceMetadata = (
    panel: ActiveRead,
    rows: readonly SessionBrowserRow[],
  ): SessionBrowserRow[] => rows.map((row) => {
    const workspace = workspaceMetadataOf(panel, row.id)
    return workspace === undefined ? row : { ...row, workspace }
  })

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

  const applyWorkspaceFrame = (panel: ActiveRead, frame: WorkspaceFactsFrame): void => {
    switch (frame.type) {
      case 'baseline':
      case 'replace':
        panel.workspaceById.clear()
        panel.workspaceOrder = []
        for (const workspace of frame.items) {
          if (!panel.workspaceById.has(workspace.workspaceId)) panel.workspaceOrder.push(workspace.workspaceId)
          panel.workspaceById.set(workspace.workspaceId, workspace)
        }
        panel.workspaceBaselineProven = true
        break
      case 'upsert':
        if (!panel.workspaceById.has(frame.workspace.workspaceId)) panel.workspaceOrder.push(frame.workspace.workspaceId)
        panel.workspaceById.set(frame.workspace.workspaceId, frame.workspace)
        break
      case 'remove':
        panel.workspaceById.delete(frame.workspaceId)
        panel.workspaceOrder = panel.workspaceOrder.filter(id => id !== frame.workspaceId)
        break
      case 'order': {
        const known = frame.workspaceIds.filter(id => panel.workspaceById.has(id))
        const listed = new Set(known)
        panel.workspaceOrder = [...known, ...panel.workspaceOrder.filter(id => !listed.has(id))]
        break
      }
      case 'invalidated':
        // The current generation's membership is no longer proven. The panel
        // keeps its ONE handle and falls back to the flat roster until the
        // official stream delivers a fresh baseline.
        clearWorkspaceFacts(panel, 'Workspace membership unavailable')
        return
    }
    panel.workspaceState = 'ready'
    panel.workspaceError = undefined
    panel.workspaceRevision += 1
    panel.rows = rowsWithWorkspaceMetadata(panel, panel.rosterRows)
    if (panel.query !== '') {
      panel.searchResults = panel.searchState === 'ready' && panel.searchPage !== undefined
        ? mergeSearchPage(panel.rows, panel.query, panel.searchPage)
        : localResults(panel)
    }
    publish(panel)
  }

  const clearWorkspaceFacts = (panel: ActiveRead, message: string): void => {
    panel.workspaceById.clear()
    panel.workspaceOrder = []
    panel.workspaceBaselineProven = false
    panel.workspaceState = 'unavailable'
    panel.workspaceError = message
    panel.workspaceRevision += 1
    panel.rows = rowsWithWorkspaceMetadata(panel, panel.rosterRows)
    if (panel.query !== '') {
      panel.searchResults = panel.searchState === 'ready' && panel.searchPage !== undefined
        ? mergeSearchPage(panel.rows, panel.query, panel.searchPage)
        : localResults(panel)
    }
    publish(panel)
  }

  const startProjectionBatch = (
    panel: ActiveRead,
    offset: number,
    limit: number,
    generation: number = panel.projectionGeneration,
  ): void => {
    const batch = panel.rosterRows.slice(offset, offset + limit)
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
        const enriched = panel.rosterRows.map((row) => {
          const projection = projections.get(row.id)
          if (projection === undefined) return row
          return {
            ...row,
            ...(projection.title === undefined ? {} : { title: projection.title }),
            ...(projection.preset === undefined ? {} : { preset: projection.preset }),
          }
        })
        panel.rosterRows = enriched
        // The ACCEPTED roster is the enriched one: a later raw push merged with
        // the same enrichment is a semantic no-op (no revision, no re-batch).
        panel.rosterSemantics = rosterSemanticsOf(enriched)
        panel.rows = rowsWithWorkspaceMetadata(panel, panel.rosterRows)
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

  /** The PAINTED roster semantics a list publication must actually change.
   *  Activity (running/pending) is NOT part of it: it travels the incremental
   *  observation channel, so a status update never bumps the roster revision,
   *  restarts projections or re-runs a content search. */
  const rosterSemanticsOf = (rows: readonly SessionBrowserRow[]): string => rows
    .filter((row) => row.origin !== 'subagent')
    .map((row) => [
      row.id, row.updatedAt, row.title ?? '', row.preset ?? '', row.presetKnown === true ? '1' : '0', row.cwd ?? '',
      row.formatStatus ?? '', row.parentSession ?? '', row.origin ?? '',
    ].join('\u0000'))
    .join('\u0001')

  /** Accept ONE official roster as this panel's ONLY listing: the subagent
   *  children never enter it and a SEMANTIC change advances the revision.
   *  `changed` tells the caller whether anything painted actually moved, so an
   *  unchanged official notification never restarts projections or search. */
  const acceptRoster = (
    panel: ActiveRead,
    listed: readonly SessionBrowserRow[],
  ): { readonly listedRows: readonly SessionBrowserRow[]; readonly changed: boolean } => {
    // The official push row carries identity/running/cwd, but its projection
    // enrichment may be absent. Keep the accepted enriched title/preset for an
    // unchanged id: a status-only notification must never erase a label the
    // projection batch already proved.
    const accepted = new Map(panel.rosterRows.map((row) => [row.id, row]))
    const listedRows = listed.map((row): SessionBrowserRow => {
      const kept = accepted.get(row.id)
      if (kept === undefined) return { ...row }
      return {
        ...row,
        ...(row.title === undefined && kept.title !== undefined ? { title: kept.title } : {}),
        // A raw row with a READABLE preset projection is authoritative even when
        // it omits the value (a known "none"); only an unmeasured row inherits
        // the accepted enrichment.
        ...(row.preset === undefined && row.presetKnown !== true && kept.preset !== undefined
          ? { preset: kept.preset }
          : {}),
      }
    })
    const semantics = rosterSemanticsOf(listedRows)
    // The FIRST accepted roster is always a real revision, including a truly
    // empty one (which must reach the distinct `empty` list state).
    const changed = panel.listRevision === 0 || semantics !== panel.rosterSemantics
    panel.rosterSemantics = semantics
    panel.rosterRows = listedRows.filter((row) => row.origin !== 'subagent')
    panel.rows = rowsWithWorkspaceMetadata(panel, panel.rosterRows)
    panel.listState = panel.rows.length === 0 ? 'empty' : 'ready'
    panel.listError = undefined
    panel.refreshError = undefined
    if (!changed) return { listedRows, changed }
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
    // Commit the new roster identity/epochs on the ONE Activity observation
    // BEFORE the presenter is notified; the observation publishes its
    // provisional running facts synchronously inside this call.
    panel.activityHandle?.setRoster(panel.rosterRows, panel.listRevision, panel.subject.currentSessionId)
    // A removed target can never keep a selected exact read alive. Clear it at
    // THIS acceptance boundary (the caller publishes this exact state), never
    // waiting for the presenter's next frame.
    if (panel.inspectorId !== undefined && !panel.rosterRows.some(row => row.id === panel.inspectorId)) {
      clearInspector(panel, false)
    }
    return { listedRows, changed }
  }

  /** Re-arm the ONE pull-refresh timer. Only a COMPLETED read re-arms it, so
   *  two roster reads never overlap; a retired panel never re-arms.
   *
   *  The cadence is PULL-ONLY: a reader with the observable list face is pushed
   *  by the official Client list and must never poll (no renderer network
   *  branch chooses this — the capability does). */
  const scheduleRefresh = (panel: ActiveRead): void => {
    if (options.autoRefreshMs === undefined || options.reader.observableList !== undefined) return
    if (panel.disposed || panel.controller.signal.aborted) return
    if (panel.refreshTimer !== undefined) return
    panel.refreshTimer = setTimeout(() => {
      panel.refreshTimer = undefined
      startRefresh(panel)
    }, options.autoRefreshMs)
  }

  /** ONE explicit background roster refresh through the SAME reader/owner
   *  (the pull cadence and the explicit `refresh()` request). It never re-runs
   *  the direct match, never resolves a settlement, never rewrites the user's
   *  editor text and never resumes a Session. */
  const startRefresh = (panel: ActiveRead): void => {
    if (!isActive(panel) || panel.refreshing || panel.listState === 'loading') return
    panel.refreshing = true
    const revisionAtStart = panel.listRevision
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
        const { changed } = acceptRoster(panel, listed as readonly SessionBrowserRow[])
        publish(panel)
        if (!isActive(panel)) return
        if (changed) {
          // A real roster delta owns its ONE enrichment chain (and its existing
          // search policy): never start a second chain beside it.
          applyRosterChange(panel, true)
        } else if (panel.listRevision === revisionAtStart) {
          // An unchanged explicit/pull refresh still re-reads the accepted
          // metadata: the raw list can be unchanged while a projection (a
          // preset selected by another Client) moved. It retires any unfinished
          // older chain first, so exactly ONE writer owns this generation. When
          // a pushed semantic acceptance already enriched this window, the
          // refresh completion does not restart an identical chain.
          panel.projectionGeneration += 1
          startProjectionBatch(panel, 0, FIRST_PROJECTION_BATCH)
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

  /** The ONE post-accept work a SEMANTIC roster change triggers: enriched
   *  labels and the content search of the current query generation. An
   *  unchanged official roster does none of it. */
  const applyRosterChange = (panel: ActiveRead, changed: boolean): void => {
    if (!changed || !isActive(panel)) return
    startProjectionBatch(panel, 0, FIRST_PROJECTION_BATCH)
    if (panel.query !== '' && panel.queryController !== undefined && panel.searchState === 'ready') {
      startSearch(panel, panel.queryGeneration)
    }
  }

  /** Start the ONE per-open incremental Activity observation. It is created at
   *  open (before the first roster) so the observation subscribes to its
   *  official sources exactly once; every accepted roster is committed through
   *  `setRoster` and each measured row arrives as its own publication. */
  const startActivityObservation = (panel: ActiveRead): void => {
    const facts = options.sessionWorkspaceFacts
    if (facts === undefined || panel.activityHandle !== undefined) return
    const handle = facts.observeActivity(panel.controller.signal)
    panel.activityHandle = handle
    panel.activityUnsubscribe = handle.subscribe(() => { onActivityChanged(panel) })
    handle.setPriorityIds(eligibleIdsOf(panel))
    if (panel.listRevision > 0) {
      handle.setRoster(panel.rosterRows, panel.listRevision, panel.subject.currentSessionId)
    }
  }

  /** ONE explicit refresh re-opens the observation: rows whose discovery never
   *  completed (denied/unavailable/cancelled) are retried, while the adapter's
   *  successful receipts still answer an unchanged source without a read. */
  const restartActivityObservation = (panel: ActiveRead): void => {
    if (!isActive(panel) || panel.activityHandle === undefined) return
    panel.activityUnsubscribe?.()
    panel.activityUnsubscribe = undefined
    const previous = panel.activityHandle
    panel.activityHandle = undefined
    previous.dispose()
    startActivityObservation(panel)
  }

  /** One Activity publication from the observation: accepted only while it was
   *  measured on THIS panel's accepted roster. The presenter sees the
   *  observation's OWN revision, never a relabelled roster revision. */
  const onActivityChanged = (panel: ActiveRead): void => {
    if (!isActive(panel)) return
    const snapshot = panel.activityHandle?.getSnapshot()
    if (snapshot === undefined || snapshot.rosterRevision !== panel.listRevision) return
    panel.activitySnapshot = snapshot
    publish(panel)
  }

  const eligibleIdsOf = (panel: ActiveRead): ReadonlySet<string> =>
    new Set((panel.answerEligibility ?? []).map(entry => entry.sessionId))

  /** Release the ONE Workspace handle of this panel (exactly once). */
  const disposeWorkspaceHandle = (panel: ActiveRead): void => {
    const handle = panel.workspaceHandle
    panel.workspaceHandle = undefined
    handle?.dispose()
  }

  /** Install the ONE per-open Connection-generation observation. It is
   *  installed even when the first follow cannot open, because the ONLY
   *  recovery trigger for that open is the arrival of a real generation. */
  const installWorkspaceGenerationObservation = (panel: ActiveRead): void => {
    const facts = options.sessionWorkspaceFacts
    if (panel.workspaceGenerationOff !== undefined || facts?.observeConnectionGeneration === undefined) return
    panel.workspaceGenerationOff = facts.observeConnectionGeneration(() => {
      if (!isActive(panel) || !panel.workspaceTerminal) return
      const live = facts.connectionGeneration?.()
      if (live === undefined) return
      if (panel.workspaceFailedGeneration !== undefined
        && Object.is(live, panel.workspaceFailedGeneration)) return
      startWorkspaceFollow(panel)
    })
  }

  /** Open the ONE per-open Workspace follow in the OFFICIAL recovering mode:
   *  a lost physical carrier invalidates the membership and the official
   *  Gateway stream restores a fresh baseline in the SAME handle. A terminal
   *  failure marks the handle ended; a NEW Connection generation may open ONE
   *  new logical handle (never a same-generation retry). */
  const startWorkspaceFollow = (panel: ActiveRead): void => {
    const facts = options.sessionWorkspaceFacts
    if (facts === undefined || panel.disposed || panel.workspaceHandle !== undefined) return
    // The ONE per-open generation observation exists from this open onward,
    // even when no usable Connection exists yet: a follow that cannot open on a
    // disconnected Client must still rebind when a real generation arrives.
    installWorkspaceGenerationObservation(panel)
    let handle: WorkspaceFactsHandle
    try {
      handle = facts.followWorkspaces(panel.controller.signal, 'recovering')
    } catch (error) {
      options.diag.error('session workspace follow failed', { error: safeErrorMessage(error) })
      panel.workspaceTerminal = true
      clearWorkspaceFacts(panel, 'Workspace membership unavailable')
      return
    }
    panel.workspaceTerminal = false
    panel.workspaceFailedGeneration = undefined
    panel.workspaceHandle = handle
    // The handle IDENTITY is this observation's generation. A rebind after a
    // terminal failure replaces `panel.workspaceHandle`, so a late frame or a
    // late completion from the OLD handle must never paint into, or clear, the
    // newer membership.
    const ownsHandle = (): boolean => !panel.disposed && panel.workspaceHandle === handle
    /** One terminal failure may rebind exactly once. The committed failed
     *  attempt identity is the SOLE decision input (never the disposed handle):
     *  only a DEFINED live generation different from it opens a new logical
     *  handle; an unknown identity never guesses. */
    const rebindAfterTerminal = (): void => {
      if (!isActive(panel) || panel.workspaceHandle !== undefined) return
      const liveGeneration = options.sessionWorkspaceFacts?.connectionGeneration?.()
      if (liveGeneration === undefined) return
      const failedAttempt = panel.workspaceFailedGeneration
      if (failedAttempt !== undefined && Object.is(failedAttempt, liveGeneration)) return
      startWorkspaceFollow(panel)
    }
    runOwned('session workspace follow', async () => {
      for await (const frame of handle) {
        if (cancellation(panel) || !ownsHandle()) return
        applyWorkspaceFrame(panel, frame)
      }
      if (!cancellation(panel) && ownsHandle()) clearWorkspaceFacts(panel, 'Workspace membership unavailable')
    }, {
      diag: options.diag,
      sessionId: options.sessionId,
      isCancellation: () => cancellation(panel),
      onResult: () => {
        if (!isActive(panel) || !ownsHandle()) return
        // Commit terminal state AND the attempt identity before publishing the
        // unavailable frame: the recovery decision must never read a disposed
        // handle's identity.
        panel.workspaceFailedGeneration = handle.attemptedGeneration?.()
        panel.workspaceTerminal = true
        disposeWorkspaceHandle(panel)
        clearWorkspaceFacts(panel, 'Workspace membership unavailable')
        rebindAfterTerminal()
      },
      onError: () => {
        if (!isActive(panel) || !ownsHandle()) return
        panel.workspaceFailedGeneration = handle.attemptedGeneration?.()
        panel.workspaceTerminal = true
        disposeWorkspaceHandle(panel)
        clearWorkspaceFacts(panel, 'Workspace membership unavailable')
        rebindAfterTerminal()
      },
    })
  }

  const refreshAnswerEligibility = (panel: ActiveRead): void => {
    if (!isActive(panel)) return
    const read = options.forwardedAnswerEligibility
    panel.answerEligibility = read === undefined ? undefined : [...read()]
    // The answer gate repaints in THIS frame (the classification is a fact, not
    // a deferred animation) and the observation re-reads ONLY the affected ids:
    // an eligibility change never triggers a roster read.
    panel.activityHandle?.setPriorityIds(eligibleIdsOf(panel))
    publish(panel)
  }

  /** One ready official roster from either list path. `initial` is the open's
   *  ONE one-shot pass (CLI direct match / fallback query / settlement); later
   *  push or pull publications only apply the incremental work. */
  const acceptReadyRoster = (
    panel: ActiveRead,
    listed: readonly SessionBrowserRow[],
  ): void => {
    // The FIRST ready acceptance — from the initial read OR a push — owns the
    // one-shot direct match, settlement and the initial projection chain. A
    // later arrival of the same snapshot (the initial read settling after a
    // ready notification arrived first) only re-accepts enrichment.
    const firstAcceptance = panel.listRevision === 0
    const { listedRows, changed } = acceptRoster(panel, listed)
    if (!firstAcceptance) {
      publish(panel)
      if (!isActive(panel)) return
      applyRosterChange(panel, changed)
      return
    }
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
  }

  /** The push-driven list path: subscribe FIRST, then read the synchronous
   *  official snapshot (after the shared input-first turn) so an arrival
   *  between the two can never be lost. No official refresh request is issued:
   *  the Client Session Manager owns list arrival. */
  const startObservableList = (panel: ActiveRead, observable: SessionReaderObservableList): void => {
    // Input-first acceptance: a subscription notification before the initial
    // event-loop turn is not applied (the latest snapshot is taken after the
    // turn instead), so the loading frame and focus boundary are painted
    // before any typed direct match/Resume or roster paint can run.
    let inputTurnPassed = false
    panel.listSubscription = observable.subscribe(() => {
      if (!inputTurnPassed) return
      applyObservableList(panel, observable.getSnapshot(), false)
    })
    runOwned('session browser list', async () => {
      // The presented panel gets one REAL event-loop turn (not a microtask):
      // its loading frame must be painted and focused before any Host read can
      // settle into it (the shared input-first ordering for both renderers).
      await scheduler.yield()
      if (cancellation(panel)) throw cancellationError('session browser list cancelled')
      // Commit the gate and take/apply the LATEST official snapshot in this
      // same owner continuation: no captured DTO can be overtaken by a newer
      // publication between an async resolution and an onResult callback.
      inputTurnPassed = true
      applyObservableList(panel, observable.getSnapshot(), true)
    }, {
      diag: options.diag,
      sessionId: options.sessionId,
      isCancellation: () => cancellation(panel),
      onResult: () => {},
      onError: (error) => { applyListError(panel, error) },
    })
  }

  /** Apply ONE observable list snapshot. `loading` keeps the loading frame (the
   *  official arrival is already subscribed); `unavailable` keeps a last-known
   *  roster as metadata and never claims an empty Session universe. */
  const applyObservableList = (
    panel: ActiveRead,
    snapshot: SessionReaderListSnapshot,
    initial: boolean,
  ): void => {
    if (!isActive(panel)) return
    if (snapshot.availability === 'loading') return
    if (snapshot.availability === 'unavailable') {
      if (panel.listRevision === 0) {
        panel.listState = 'unavailable'
        panel.rows = []
        panel.searchState = 'idle'
        panel.searchResults = []
        panel.searchPage = undefined
        panel.searchError = undefined
        clearInspector(panel, false)
        publish(panel)
        if (initial) panel.settle({ kind: 'refused', text: 'session persistence unavailable' })
        return
      }
      // The last accepted roster stays listed as latest-known metadata; the
      // nonfatal freshness fact is painted beside it.
      panel.refreshError = 'session persistence unavailable'
      publish(panel)
      return
    }
    acceptReadyRoster(panel, snapshot.rows as readonly SessionBrowserRow[])
  }

  const applyListError = (panel: ActiveRead, error: unknown): void => {
    if (!isActive(panel)) return
    const message = safeErrorMessage(error)
    panel.listState = 'error'
    panel.listError = message
    panel.rows = []
    panel.searchState = 'idle'
    panel.searchResults = []
    clearInspector(panel, false)
    publish(panel)
    panel.settle({ kind: 'refused', text: message })
    scheduleRefresh(panel)
  }

  /** The pull-only list path (Direct): the reader's own local listing, on the
   *  existing cadence. */
  const startPullList = (panel: ActiveRead): void => {
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
          clearInspector(panel, false)
          publish(panel)
          panel.settle({ kind: 'refused', text: 'session persistence unavailable' })
          // The fullscreen Workspace stays mounted on a refused first read: the
          // ONE refresh generation keeps trying instead of freezing the panel
          // on a transient Host outage.
          scheduleRefresh(panel)
          return
        }
        acceptReadyRoster(panel, listed as readonly SessionBrowserRow[])
      },
      onError: (error) => { applyListError(panel, error) },
    })
  }

  const startList = (panel: ActiveRead): void => {
    if (!isActive(panel)) return
    const observable = options.reader.observableList
    if (observable === undefined) startPullList(panel)
    else startObservableList(panel, observable)
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
        rosterRows: [],
        rows: [],
        workspaceHandle: undefined,
        workspaceById: new Map(),
        workspaceOrder: [],
        workspaceBaselineProven: false,
        workspaceState: 'loading',
        workspaceRevision: 0,
        workspaceError: undefined,
        workspaceTerminal: false,
        workspaceFailedGeneration: undefined,
        workspaceGenerationOff: undefined,
        rosterSemantics: '',
        activityHandle: undefined,
        activityUnsubscribe: undefined,
        activitySnapshot: undefined,
        listSubscription: undefined,
        answerEligibility: undefined,
        eligibilitySubscription: undefined,
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
        inspectorId: undefined,
        inspectorSource: undefined,
        inspectorSnapshot: undefined,
        inspectorSourceEpoch: 0,
        inspectorRequestEpoch: 0,
        inspectorRequestController: undefined,
        inspectorTimer: undefined,
        inspectorDirty: false,
        inspectorDue: false,
        inspectorPublishScheduled: false,
      }
      active = panel
      let presentationHandle: SessionBrowserPanelHandle
      try {
        presentationHandle = options.presentation.open({
          subject: panel.subject,
          ...(openOptions.initialDirectoryChooser ? { initialDirectoryChooser: true } : {}),
          ...(openOptions.initialDirectoryEntry ? { initialDirectoryEntry: true } : {}),
          ...(openOptions.initialDirectoryPath === undefined ? {} : { initialDirectoryPath: openOptions.initialDirectoryPath }),
          onQueryChange: (query) => changeQuery(panel, query),
          onUseDirectory: options.onUseDirectory,
          onNewSession: options.onWorkspaceNewSession === undefined
            ? undefined
            : (workspaceId, settle) => options.onWorkspaceNewSession?.(workspaceId, () => retire(panel, true), settle),
          // The capability crosses the seam only when the composing owner really
          // has one: an always-present closure would make an unsupported Add
          // action look enabled.
          onAddDirectory: options.onAddDirectory === undefined
            ? undefined
            : (path, settle) => options.onAddDirectory?.(path, settle),
          // The Host browse capability keeps its optionality: the presentation
          // receives the SAME function only when this composition has one.
          ...(options.onListDirectory === undefined ? {} : { onListDirectory: options.onListDirectory }),
          onResumeIntent: (intent) => {
            if (intent.source === 'direct') return
            requestResume(panel, intent, panel.rows)
          },
          onInspectorSelection: (sessionId) => { reportInspectorSelection(panel, sessionId) },
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
      // An explicit initial query is the OPENING input, not a list-settlement
      // effect: the search editor must be live (and editable) before any Host
      // roster read settles. The one-shot seed is still skipped after a real
      // user edit, and the list-settled fallback remains the direct-match path.
      if (openOptions.initialQuery !== undefined && openOptions.initialQuery !== '') {
        publish(panel, openOptions.initialQuery)
      }
      startWorkspaceFollow(panel)
      panel.answerEligibility = options.forwardedAnswerEligibility === undefined
        ? undefined
        : [...options.forwardedAnswerEligibility()]
      // The ONE incremental Activity observation exists for the whole panel
      // lifetime; the first roster commit follows in the list path.
      startActivityObservation(panel)
      const subscribeEligibility = options.subscribeForwardedAnswerEligibility
      if (subscribeEligibility !== undefined) {
        panel.eligibilitySubscription = subscribeEligibility(() => refreshAnswerEligibility(panel))
      }
      startList(panel)
      return handle
    },
    refresh() {
      if (active === undefined || !isActive(active)) return
      if (active.refreshTimer !== undefined) {
        clearTimeout(active.refreshTimer)
        active.refreshTimer = undefined
      }
      restartActivityObservation(active)
      startRefresh(active)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (active !== undefined) retire(active, true)
    },
  }
}
