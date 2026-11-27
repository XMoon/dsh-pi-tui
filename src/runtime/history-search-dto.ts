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

/** One session-scoped recall request: exactly the addressed Session. */
export interface HistorySessionRecallRequest {
  readonly sessionId: string
}

/** One recalled occurrence: exact original text plus its official identity. */
export interface HistorySessionRecallItem {
  readonly messageId: string
  /** Optional official request correlation of the first admission. */
  readonly rpcId?: string
  /** First event seq that proved acceptance (stable Host identity/order). */
  readonly firstEventSeq: number
  readonly text: string
}

/**
 * The bounded session-scoped recall answer. There is no cursor and no query:
 * the Host returns at most the fixed recall window under the fixed serialized
 * byte budget, or one of the existing truthful non-ready states.
 */
export type HistorySessionRecallResponse =
  | {
    readonly kind: 'ready'
    readonly sessionId: string
    readonly items: readonly HistorySessionRecallItem[]
  }
  | { readonly kind: 'loading' }
  | { readonly kind: 'incomplete'; readonly reason: HistorySearchIncompleteReason }
  | { readonly kind: 'unavailable'; readonly reason: HistorySearchUnavailableReason }

/** Bounded first-cold-round progress: settled expected IDs out of the fixed roster. */
export interface HistorySearchProgress {
  /** Expected IDs currently queryable; may decrease when a source is revoked. */
  readonly settled: number
  /** The fixed expected roster sampled for this first healthy cold round. */
  readonly total: number
}

export type HistorySearchResponse =
  | {
    readonly kind: 'ready'
    readonly generation: string
    readonly items: readonly HistorySearchItem[]
    readonly nextCursor: string | null
  }
  | {
    readonly kind: 'partial'
    readonly items: readonly HistorySearchItem[]
    readonly progress: HistorySearchProgress
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

