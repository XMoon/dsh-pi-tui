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
/** One session-scoped recall answer never carries more candidate occurrences. */
export const HISTORY_SESSION_RECALL_LIMIT = 100
/** The fixed serialized UTF-8 byte budget of one session-recall answer. */
export const HISTORY_SESSION_RECALL_MAX_BYTES = 64 * 1024
/**
 * The conservative per-row raw UTF-16 prefilter. This is ONE candidate window
 * beyond which a single row cannot possibly fit the serialized 64 KiB answer
 * (the envelope alone consumes bytes); it is NOT a claim that every row below
 * it fits. The actual fit is decided on the real serialized envelope, so a long
 * ASCII row can be recalled whole while an escaping-heavy CJK/control row is
 * skipped whole.
 */
export const HISTORY_SESSION_RECALL_MAX_TEXT_CHARS = 64 * 1024
