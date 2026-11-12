/** UI-neutral Session Browser query, workspace and lineage projections. */
import { normalize } from 'node:path'

/** The official search-query cap in JavaScript UTF-16 code units. */
export const SESSION_SEARCH_QUERY_MAX_CHARS = 500

/** Strip the `session-`/`session_` prefix and keep the first 8 characters, like
 * the kimicode card's short id. */
export function shortSessionId(id: string): string {
  return id.replace(/^session[-_]/i, '').slice(0, 8)
}

/** The identity shape the shared matcher needs (a listed row or any object
 * carrying the full Session id). `origin` lets the CLI's automatic selection
 * exclude subagent children without re-filtering the Browser's own rows. */
export interface SessionMatchRow {
  readonly id: string
  readonly origin?: 'subagent'
}

/** A canonical full Session id: the `session-`/`session_` prefix plus 32 hex
 * characters, optionally written as a hyphenated canonical UUID. A BARE UUID
 * is NOT a canonical Session id — it must match an official listed row. */
const CANONICAL_SESSION_ID = /^session[-_](?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** The CLI automatic-prefix rule: at least four ASCII hex digits after the
 * optional `session-`/`session_` prefix. Deliberately stricter than the
 * `/resume` matcher; the CLI must not auto-resume a word-like query. */
const CLI_PREFIX = /^[0-9a-f]{4,}$/i

/** Whether `query` is a canonical full Session id that may be opened WITHOUT
 * a roster read (the explicit full-id launch contract). */
export function canonicalFullSessionId(query: string): boolean {
  return CANONICAL_SESSION_ID.test(query)
}

/** The legal automatic prefix `query` carries, or undefined. The returned
 * value is the bare hex prefix (the leading Session prefix stripped). */
export function cliAutoPrefix(query: string): string | undefined {
  const bare = query.replace(/^session[-_]/i, '')
  return CLI_PREFIX.test(bare) ? bare : undefined
}

/**
 * Resolve one session row for a typed resume query. A full id wins over the
 * row order; otherwise only a UNIQUE non-empty prefix (the `session-` form or
 * the short id) is resolved. An ambiguous or missing prefix returns undefined
 * so the read owner seeds the same global Browser search instead of guessing.
 * @param rows - the listed main-session rows (never re-filtered here).
 * @param query - the resume query.
 * @returns the matching row, or undefined.
 */
export function findSessionMatch<T extends SessionMatchRow>(rows: readonly T[], query: string): T | undefined {
  const exact = rows.find(row => row.id === query)
  if (exact !== undefined) return exact

  // Strip an optional session- prefix before prefix matching so both
  // `session-aaaaaaaa-bbbb` and `aaaaaaaa-bbbb` resolve. An empty bare
  // query must never match every listed row.
  const bare = query.replace(/^session[-_]/i, '')
  if (bare === '') return undefined

  let candidate: T | undefined
  for (const row of rows) {
    // Strip the SAME optional prefix from the row id before comparing. The
    // `session-`-only form could not match a long `session_` prefix because
    // `shortSessionId` truncates at eight characters; the CLI accepts any
    // legal hex prefix length, and `/resume` shares this matcher.
    const bareId = row.id.replace(/^session[-_]/i, '')
    if (!bareId.startsWith(bare) && !shortSessionId(row.id).startsWith(bare)) continue
    // A row can satisfy both prefix forms; count it once. A second candidate
    // means the query is ambiguous and the Browser search owns the choice.
    if (candidate !== undefined) return undefined
    candidate = row
  }
  return candidate
}

/**
 * Resolve one CLI `--session` value before the Browser mounts: an exact
 * official row id first (including historical non-standard ids), then — only
 * for a legal CLI automatic prefix — the SAME unique-prefix primitive
 * `/resume` uses. An ambiguous, missing or word-like query returns undefined
 * so the startup Browser keeps it as one global search instead of guessing.
 * A subagent child is never an automatic main-Session selection.
 */
export function chooseListedSession<T extends SessionMatchRow>(rows: readonly T[], query: string): T | undefined {
  // A blank query or the bare Session prefix carries no identity: it always
  // searches, even if a malformed listed row happens to carry that exact text.
  if (query === '' || /^session[-_]$/i.test(query)) return undefined
  const exact = rows.find(row => row.id === query)
  if (exact !== undefined) return exact
  if (cliAutoPrefix(query) === undefined) return undefined
  return findSessionMatch(rows.filter(row => row.origin !== 'subagent'), query)
}

/** Canonicalize one user query for both metadata matching and Host search. */
export function sanitizeSessionSearchInput(value: string): string {
  const trimmed = value.replace(/\0/g, '').trim()
  if (trimmed.length <= SESSION_SEARCH_QUERY_MAX_CHARS) return trimmed
  const truncated = trimmed.slice(0, SESSION_SEARCH_QUERY_MAX_CHARS)
  const last = truncated.charCodeAt(SESSION_SEARCH_QUERY_MAX_CHARS - 1)
  return last >= 0xD800 && last <= 0xDBFF
    ? truncated.slice(0, SESSION_SEARCH_QUERY_MAX_CHARS - 1)
    : truncated
}

/** Metadata-only membership; content membership belongs to SessionReader.search(). */
export function sessionRowMatchesQuery(row: {
  readonly id: string
  readonly title?: string
  readonly cwd?: string
  readonly preset?: string
  readonly workspace?: { readonly title: string; readonly path: string }
}, query: string): boolean {
  const needle = query.toLowerCase()
  return row.id.toLowerCase().includes(needle)
    || (row.title ?? '').toLowerCase().includes(needle)
    || (row.cwd ?? '').toLowerCase().includes(needle)
    || (row.preset ?? '').toLowerCase().includes(needle)
    || (row.workspace?.title ?? '').toLowerCase().includes(needle)
    || (row.workspace?.path ?? '').toLowerCase().includes(needle)
}

/** Lexical workspace equality; absent and empty roots match nothing. */
export function sameWorkspace(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a === '' || b === '') return false
  const strip = (path: string): string => {
    let end = path.length
    while (end > 1 && (path[end - 1] === '/' || path[end - 1] === '\\')) end -= 1
    return path.slice(0, end)
  }
  return normalize(strip(a)) === normalize(strip(b))
}

/** Subagent-first lineage, preserving newest-first order at every level.
 *
 * Only a REAL Host subagent origin owns a displayed parent edge: an ordinary
 * `/fork` child is an independent Session with no `parentSession` metadata,
 * and legacy ordinary-fork metadata must not fabricate a tree edge. */
export function buildSessionTree<T extends {
  readonly id: string
  readonly parentSession?: string
  readonly origin?: 'subagent'
}>(
  rows: readonly T[],
): { readonly row: T; readonly depth: number }[] {
  const known = new Set(rows.map(row => row.id))
  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const row of rows) {
    if (row.origin === 'subagent' && row.parentSession !== undefined && known.has(row.parentSession)) {
      const list = children.get(row.parentSession)
      if (list === undefined) children.set(row.parentSession, [row])
      else list.push(row)
    } else {
      roots.push(row)
    }
  }
  const result: { row: T; depth: number }[] = []
  const placed = new Set<string>()
  const place = (row: T, depth: number): void => {
    if (placed.has(row.id)) return
    placed.add(row.id)
    result.push({ row, depth })
    for (const child of children.get(row.id) ?? []) place(child, depth + 1)
  }
  for (const root of roots) place(root, 0)
  for (const row of rows) if (!placed.has(row.id)) place(row, 0)
  return result
}
