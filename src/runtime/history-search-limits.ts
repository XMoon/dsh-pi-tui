/**
 * The public-safe numeric bounds of the accepted-history protocol.
 *
 * Kept outside the private Typert contribution so a value import of a limit
 * never pulls the wire contract into a published declaration graph.
 *
 * @module @xmoon76/dsh-pi-tui/runtime/history-search-limits
 */

/** Maximum accepted query length in UTF-16 code units. */
export const HISTORY_SEARCH_QUERY_MAX_CHARS = 256
/** One Host page never exceeds this many rows. */
export const HISTORY_SEARCH_LIMIT_MAX = 25
/** One exact-text chunk never exceeds this many UTF-16 code units. */
export const HISTORY_SEARCH_READ_TEXT_LIMIT_MAX = 16_384
