/**
 * The transport-neutral accepted-history DTOs.
 *
 * The private Typert contribution imports these types; public declaration
 * consumers must never pull the private contribution itself.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/history-search-dto
 */

export type HistorySearchScope = 'all' | 'session' | 'directory'

export type HistorySearchIncompleteReason =
  | 'source-uncertain'
  | 'reconciling'
  | 'resource-limit'
  | 'source-read-failed'

export type HistorySearchUnavailableReason = 'index-unavailable' | 'service-missing'

export type HistoryReadTextUnavailableReason =
  | 'not-found'
  | 'stale-content'
  | 'index-unavailable'
  | 'service-missing'

/** One search request; the scope discriminates the exact key set. */
export type HistorySearchRequest =
  | { readonly scope: 'all'; readonly query: string; readonly limit: number; readonly cursor?: string }
  | { readonly scope: 'session'; readonly sessionId: string; readonly query: string; readonly limit: number; readonly cursor?: string }
  | { readonly scope: 'directory'; readonly cwd: string; readonly query: string; readonly limit: number; readonly cursor?: string }

/** One ready search row: a bounded preview plus the immutable content identity. */
export interface HistorySearchItem {
  readonly sessionId: string
  readonly messageId: string
  readonly firstEventSeq: number
  /** Host first-admission event time (Unix epoch milliseconds). */
  readonly acceptedAt: number
  /** Effective event-time cwd, or `null` when the Session never proved one. */
  readonly effectiveCwd: string | null
  /** At most {@link HISTORY_SEARCH_PREVIEW_MAX_CHARS} UTF-16 code units. */
  readonly preview: string
  /** Full original text length in UTF-16 code units. */
  readonly contentLength: number
  readonly contentSha256: string
  readonly hasNonText: boolean
}

/** One exact-text read request. */
export interface HistoryReadTextRequest {
  readonly sessionId: string
  readonly messageId: string
  readonly contentSha256: string
  readonly offset: number
  readonly limit: number
}

export type HistorySearchResponse =
  | {
    readonly kind: 'ready'
    readonly generation: string
    readonly items: readonly HistorySearchItem[]
    readonly nextCursor: string | null
  }
  | { readonly kind: 'loading' }
  | { readonly kind: 'incomplete'; readonly reason: HistorySearchIncompleteReason }
  | { readonly kind: 'unavailable'; readonly reason: HistorySearchUnavailableReason }
  | { readonly kind: 'stale'; readonly reason: 'cursor-stale' }

export type HistoryReadTextResponse =
  | {
    readonly kind: 'ready'
    readonly chunk: string
    readonly nextOffset: number | null
    readonly contentLength: number
  }
  | { readonly kind: 'loading' }
  | { readonly kind: 'incomplete'; readonly reason: HistorySearchIncompleteReason }
  | { readonly kind: 'unavailable'; readonly reason: HistoryReadTextUnavailableReason }

