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

/** Detached state produced only by SessionReader.list/projectionBatch/search. */
export interface SessionBrowserReadSnapshot {
  readonly listState: SessionBrowserListState
  readonly rows: readonly SessionBrowserRow[]
  readonly query: string
  readonly resumePending: boolean
  readonly searchState: SessionBrowserSearchState
  readonly searchResults: readonly SessionBrowserSearchResult[]
  readonly hasMore: boolean
  readonly listError?: string
  readonly projectionError?: string
  readonly searchError?: string
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
  readonly onQueryChange: (query: string) => void
  readonly onResumeIntent: (intent: SessionBrowserResumeIntent) => void
  readonly onClose: () => void
}

export interface SessionBrowserPanelHandle {
  isDisposed(): boolean
  setSnapshot(snapshot: SessionBrowserReadSnapshot): void
  close(): void
}

/** Internal, renderer-neutral presenter seam. Never exposed through extensions. */
export interface SessionBrowserPresentation {
  open(request: SessionBrowserPanelRequest): SessionBrowserPanelHandle
  notify(message: string, kind?: 'info' | 'error'): void
}
