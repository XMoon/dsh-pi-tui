/** Internal read-only Session Browser contract shared by the app read owner and TSP presenter. */
import type { SessionSummary } from '../../runtime/session-reader-port.ts'

export type SessionBrowserRow = SessionSummary & { readonly title?: string }

export type SessionBrowserListState = 'loading' | 'ready' | 'empty' | 'unavailable' | 'error'
export type SessionBrowserSearchState = 'idle' | 'loading' | 'ready' | 'unavailable' | 'error'

export interface SessionBrowserSearchResult {
  readonly row: SessionBrowserRow
  readonly source: 'Content' | 'Metadata' | 'Both'
  readonly snippet?: string
}

/**
 * ONE live official forwarded request THIS Client root still holds for an
 * answer (G567's transient read view). It carries identity only — never a
 * question payload, an option, an answer or a Host pending record — and it
 * vanishes the moment the official invocation settles or aborts.
 */
export interface SessionBrowserAnswerEligibility {
  readonly sessionId: string
  readonly kind: 'question' | 'approval'
  readonly live: true
}

/** Detached state produced only by SessionReader.list/projectionBatch/search. */
export interface SessionBrowserReadSnapshot {
  readonly listState: SessionBrowserListState
  readonly rows: readonly SessionBrowserRow[]
  readonly query: string
  readonly resumePending: boolean
  readonly searchState: SessionBrowserSearchState
  readonly searchResults: readonly SessionBrowserSearchResult[]
  readonly hasMore: boolean
  /** Monotonic roster acceptance revision, starting at 0 before the first
   *  accepted `list()`. Only an accepted roster increments it; a projection
   *  batch, a search update or a repaint never does. The PiTUI Session
   *  Workspace keys its ONE Activity sample on this value. */
  readonly listRevision: number
  readonly listError?: string
  readonly projectionError?: string
  readonly searchError?: string
  /** A FAILED background roster refresh. The last good roster stays listed;
   *  this is a nonfatal freshness fact, cleared by the next success. */
  readonly refreshError?: string
}

/** B1-B's narrow handoff, intentionally not connected to any writer in B1-A. */
export interface SessionBrowserResumeIntent {
  readonly sessionId: string
  readonly currentSessionId: string | undefined
  readonly source: 'enter' | 'activate' | 'footer' | 'direct'
}

/** One atomically captured subject for one panel lifetime. */
export interface SessionBrowserSubject {
  readonly currentSessionId: string | undefined
  readonly currentCwd: string
  readonly isCurrent: () => boolean
}

export interface SessionBrowserPanelRequest {
  readonly subject: SessionBrowserSubject
  /** Called only when raw editor text changes; cursor movement stays in the Presenter. */
  readonly onQueryChange: (query: string) => void
  readonly onResumeIntent: (intent: SessionBrowserResumeIntent) => void
  readonly onClose: () => void
}

export interface SessionBrowserPanelHandle {
  isDisposed(): boolean
  /** Ordinary snapshots update results; only this one-shot option may seed editor text. */
  setSnapshot(snapshot: SessionBrowserReadSnapshot, options?: { readonly initialQuery?: string }): void
  close(): void
}

/** Internal, renderer-neutral presenter seam. Never exposed through extensions. */
export interface SessionBrowserPresentation {
  open(request: SessionBrowserPanelRequest): SessionBrowserPanelHandle
  notify(message: string, kind?: 'info' | 'error'): void
}
