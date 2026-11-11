/** Internal read-only Session Browser contract shared by the app read owner and TSP presenter. */
import type { SessionSummary } from '../../runtime/session-reader-port.ts'
import type { SessionActivityFact, SessionWorkspaceFact } from '../../runtime/session-workspace-facts-port.ts'

export interface SessionBrowserWorkspaceMetadata {
  readonly workspaceId: string
  readonly title: string
  readonly path: string
}

export type SessionBrowserRow = SessionSummary & {
  readonly title?: string
  readonly workspace?: SessionBrowserWorkspaceMetadata
}

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

/** The current accepted Workspace baseline and its ONE Activity sample for the open. */
export interface SessionBrowserWorkspaceSnapshot {
  readonly revision: number
  readonly state: 'loading' | 'ready' | 'unavailable'
  readonly facts: readonly SessionWorkspaceFact[]
  readonly baselineProven: boolean
  readonly activityRevision?: number
  readonly activityRosterRevision?: number
  readonly activity?: readonly SessionActivityFact[]
  readonly answerEligibility: readonly SessionBrowserAnswerEligibility[] | undefined
  readonly error?: string
  readonly activityError?: string
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
  readonly workspace?: SessionBrowserWorkspaceSnapshot
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
  /** Host-verified next-create WorkspaceId for a truly sessionless open. */
  readonly currentWorkspaceId?: string
  readonly isCurrent: () => boolean
}

export type SessionBrowserDirectorySettlement =
  | { readonly kind: 'registered'; readonly workspaceId: string; readonly path: string }
  | { readonly kind: 'failed'; readonly message: string }

/** ONE Folder-New operation's real terminal outcome. It is supplied by the
 *  command/read-owner seam; a notice, a timer or a roster diff is never a
 *  settlement channel. */
export type SessionBrowserNewSessionSettlement =
  | { readonly kind: 'committed' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'not-committed' }
  | { readonly kind: 'cancelled' }

export interface SessionBrowserPanelRequest {
  readonly subject: SessionBrowserSubject
  readonly initialDirectoryChooser?: boolean
  readonly initialDirectoryEntry?: boolean
  readonly initialDirectoryPath?: string
  readonly onQueryChange: (query: string) => void
  readonly onResumeIntent: (intent: SessionBrowserResumeIntent) => void
  readonly onUseDirectory?: (workspaceId: string, canonicalPath: string) => void
  readonly onNewSession?: (workspaceId: string, settle?: (outcome: SessionBrowserNewSessionSettlement) => void) => void
  readonly onAddDirectory?: (path: string, settle: (outcome: SessionBrowserDirectorySettlement) => void) => void
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
