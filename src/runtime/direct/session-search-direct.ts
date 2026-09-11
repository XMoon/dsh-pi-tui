/**
 * The official-parity Direct session content search (master
 * `ApiSessionList.search()` business semantics, transport-free). This module
 * is PURE: it takes a narrow structural `searchSessions` provider, the
 * authorized visible Session id set, a normalized query, and a signal, and
 * returns the bounded authorized page. It knows nothing about `ctx`, the
 * picker, or the TUI — a future Remote adapter maps the same
 * `SessionReader.search()` port method onto the official `session.search`
 * contract instead of copying this ladder.
 *
 * The Direct adapter (`session-direct.ts`) owns capability detection
 * (unmounted engine / missing `searchSessions` / `SESSION_QUERY_SEARCH_DISABLED`
 * → port `undefined`), the visible-id listing, and error mapping; this
 * module owns the provider-call loop, authorization, dedupe, cursor fill,
 * and the bounded page assembly.
 *
 * Full contract: docs/client-server-migration.md + docs/client-server-coupling.md.
 * @module @xmoon76/dsh-pi-tui/runtime/direct/session-search-direct
 */

import type { SessionContentSearchItem, SessionContentSearchPage } from '../session-reader-port.ts'

/** Public result window: at most this many authorized hits per page. */
export const SESSION_SEARCH_RESULT_LIMIT = 20
/** Official snippet cap (Unicode code points), applied to provider snippets. */
export const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240
/** Provider-call work budget for one search (master parity). */
export const SEARCH_PROVIDER_CALL_LIMIT = 100
/** Official query cap in JavaScript UTF-16 code units. */
export const SESSION_SEARCH_QUERY_MAX_CHARS = 500
/** The only event types content search may match (master parity). */
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/** One event metadata predicate of the official search request. */
export interface SessionEventMetadataFilterLike {
  readonly kind: 'type' | 'surface'
  readonly values: readonly string[]
}

/** One grouped cross-session hit (structural subset of the official
 * `SessionSearchHit` — only the fields the authorization ladder reads). */
export interface SessionSearchHitLike {
  readonly header: { readonly id: string }
  readonly bestMatch: {
    readonly sessionId: string
    readonly type: string
    readonly surface: string
    readonly snippet: string
  }
}

/** One cursor-paginated provider page (structural subset of the official
 * `SessionSearchPage`; the cursor stays opaque to the presentation). */
export interface SessionSearchPageLike {
  readonly items: readonly SessionSearchHitLike[]
  readonly nextCursor?: unknown
}

/** The narrow `searchSessions` provider surface the search loop needs. */
export interface SessionSearchProviderLike {
  searchSessions(
    request: {
      readonly query: string
      readonly eventFilters: readonly SessionEventMetadataFilterLike[]
      readonly limit: number
      readonly cursor?: unknown
    },
    exec?: { readonly signal?: AbortSignal },
  ): Promise<SessionSearchPageLike>
}

/** Read a typed query-service error code without depending on its package
 * surface (the code strings are the stable official vocabulary). */
export function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** Normalize and validate a search query exactly like the official
 * `ApiSessionList.search()`: trim, non-empty, at most 500 UTF-16 code
 * units, no NUL. A violation rejects — the caller sent an invalid query. */
export function normalizeSessionSearchQuery(query: string): string {
  const normalized = query.trim()
  if (normalized.length === 0) {
    throw new Error('session search query must not be empty')
  }
  if (normalized.length > SESSION_SEARCH_QUERY_MAX_CHARS) {
    throw new Error(`session search query must contain at most ${SESSION_SEARCH_QUERY_MAX_CHARS} UTF-16 code units`)
  }
  if (normalized.includes('\0')) {
    throw new Error('session search query must not contain NUL')
  }
  return normalized
}

/** The longest prefix containing at most `maximum` Unicode code points
 * (official `truncateUnicodeCodePoints` parity — never splits a surrogate
 * pair). */
export function truncateUnicodeCodePoints(value: string, maximum: number): string {
  let count = 0
  let end = 0
  for (const codePoint of value) {
    if (count === maximum) return value.slice(0, end)
    count++
    end += codePoint.length
  }
  return value
}

/**
 * Run the official-parity authorized search loop over one provider:
 * page through `searchSessions` (user/assistant message, current surface,
 * `limit` pages), authorize every hit against the visible Session id set
 * (cwd-bearing corpus), dedupe by Session, fill pages past unauthorized
 * hits, and return the bounded page with `hasMore`. Mirrors master
 * `ApiSessionList.search()`: repeated cursors fail loud, stale cursors
 * restart from the first page, an invalid limit halves the page limit,
 * provider pages over the requested limit fail loud, and the provider-call
 * work budget is 100. Cancellation is honored before/after every await.
 */
export async function searchSessionContentPage(
  provider: SessionSearchProviderLike,
  visibleIds: ReadonlySet<string>,
  normalizedQuery: string,
  signal?: AbortSignal,
): Promise<SessionContentSearchPage> {
  const authorized: SessionContentSearchItem[] = []
  const acceptedIds = new Set<string>()
  const seenCursors = new Set<unknown>()
  let cursor: unknown
  let providerCalls = 0
  let pageLimit = SESSION_SEARCH_RESULT_LIMIT
  while (authorized.length <= SESSION_SEARCH_RESULT_LIMIT) {
    signal?.throwIfAborted()
    if (providerCalls >= SEARCH_PROVIDER_CALL_LIMIT) {
      throw new Error(`session search provider exceeded the ${SEARCH_PROVIDER_CALL_LIMIT}-call work budget`)
    }
    providerCalls++
    const requestedCursor = cursor
    const requestedLimit = pageLimit
    let page: SessionSearchPageLike
    try {
      page = await provider.searchSessions({
        query: normalizedQuery,
        eventFilters: [
          { kind: 'type', values: ['user/message', 'assistant/message'] },
          { kind: 'surface', values: ['current'] },
        ],
        limit: requestedLimit,
        ...(requestedCursor === undefined ? {} : { cursor: requestedCursor }),
      }, { signal })
      signal?.throwIfAborted()
    } catch (error) {
      signal?.throwIfAborted()
      if (requestedCursor === undefined
        && errorCodeOf(error) === 'SESSION_QUERY_INVALID_LIMIT'
        && requestedLimit > 1) {
        pageLimit = Math.max(1, Math.floor(requestedLimit / 2))
        continue
      }
      if (requestedCursor !== undefined
        && errorCodeOf(error) === 'SESSION_QUERY_STALE_CURSOR') {
        authorized.length = 0
        acceptedIds.clear()
        seenCursors.clear()
        cursor = undefined
        continue
      }
      throw error
    }
    if (page.items.length > requestedLimit) {
      throw new Error(`session search provider returned ${String(page.items.length)} items; maximum is ${String(requestedLimit)}`)
    }
    for (const hit of page.items) {
      if (authorized.length > SESSION_SEARCH_RESULT_LIMIT) continue
      if (!visibleIds.has(hit.header.id)
        || hit.bestMatch.sessionId !== hit.header.id
        || hit.bestMatch.surface !== 'current'
        || !MESSAGE_TYPES.has(hit.bestMatch.type)
        || acceptedIds.has(hit.header.id)) continue
      acceptedIds.add(hit.header.id)
      authorized.push({
        sessionId: hit.header.id,
        snippet: truncateUnicodeCodePoints(hit.bestMatch.snippet, SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS),
      })
    }
    if (page.nextCursor !== undefined) {
      if (seenCursors.has(page.nextCursor)) {
        throw new Error('session search provider repeated a continuation cursor')
      }
      seenCursors.add(page.nextCursor)
    }
    if (authorized.length > SESSION_SEARCH_RESULT_LIMIT || page.nextCursor === undefined) break
    cursor = page.nextCursor
  }
  return {
    items: authorized.slice(0, SESSION_SEARCH_RESULT_LIMIT),
    hasMore: authorized.length > SESSION_SEARCH_RESULT_LIMIT,
  }
}
