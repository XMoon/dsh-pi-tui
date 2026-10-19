/** UI-neutral Session Browser query, workspace and lineage projections. */
import { normalize } from 'node:path'

/** The official search-query cap in JavaScript UTF-16 code units. */
export const SESSION_SEARCH_QUERY_MAX_CHARS = 500

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
}, query: string): boolean {
  const needle = query.toLowerCase()
  return row.id.toLowerCase().includes(needle)
    || (row.title ?? '').toLowerCase().includes(needle)
    || (row.cwd ?? '').toLowerCase().includes(needle)
    || (row.preset ?? '').toLowerCase().includes(needle)
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

/** Parent-first lineage, preserving newest-first order at every level. */
export function buildSessionTree<T extends { readonly id: string; readonly parentSession?: string }>(
  rows: readonly T[],
): { readonly row: T; readonly depth: number }[] {
  const known = new Set(rows.map(row => row.id))
  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const row of rows) {
    if (row.parentSession !== undefined && known.has(row.parentSession)) {
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
