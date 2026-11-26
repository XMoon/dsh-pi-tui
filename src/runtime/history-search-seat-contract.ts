/**
 * The neutral Remote accepted-history seat/view types shared by both renderers.
 *
 * This module deliberately has no wire-contract, transport, diagnostics or
 * implementation import: it is safe to enter the public declaration graph.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/history-search-seat-contract
 */

/** The three accepted-history scopes. */
export type HistoryScope = 'session' | 'current' | 'all'

/** The Directory availability the per-open application capture proved. */
export interface RemoteHistoryDirectoryState {
  readonly available: boolean
  /** The exact Host path captured at this open; present only when available. */
  readonly cwd?: string
  /** A safe reason shown only while Directory is not available. */
  readonly reason?: string
}

/** The narrow per-open capture the seat consumes; owned by the application. */
export interface RemoteHistoryOpenScopeLike {
  readonly initialScope: 'session' | 'all'
  directory(): RemoteHistoryDirectoryState
  isCurrent(): boolean
  subscribe(listener: () => void): () => void
  dispose(): void
}

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

/** Bounded first-cold-round progress, derived from verified safe integers. */
export interface RemoteHistoryProgress {
  readonly settled: number
  readonly total: number
}

export type RemoteHistorySeatStatus =
  | 'idle'
  | 'searching'
  | 'loading-host'
  | 'partial'
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
  /** Monotonic material-page identity (row set/order/content identity).
   *  Progress-only and body-only publishes do not advance it. */
  readonly pageRevision: number
  readonly scope: HistoryScope
  readonly query: string
  readonly status: RemoteHistorySeatStatus
  /** Safe status text; never a Host error detail or a content byte. */
  readonly message: string
  /** Present only for a partial first page; absent for ready/loading/failure. */
  readonly progress: RemoteHistoryProgress | undefined
  readonly rows: readonly RemoteHistoryRow[]
  readonly selectedId: string | undefined
  readonly hasMore: boolean
  readonly moreLoading: boolean
  readonly directory: RemoteHistoryDirectoryState
  readonly body: RemoteHistoryBodyView
}

export interface RemoteHistorySeat {
  open(scope: HistoryScope, query: string): void
  setQuery(query: string): void
  setScope(scope: HistoryScope): void
  select(id: string): void
  more(): void
  retry(): void
  close(options?: { readonly preserveScope?: boolean }): void
  view(): RemoteHistorySeatView
  subscribe(listener: () => void): () => void
}
