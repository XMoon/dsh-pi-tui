/**
 * Session-picker support for `/sessions`: pure row assembly and
 * presentation. The row model mirrors the kimicode web session rail — a
 * short id, a relative age, an optional title, and a workspace group —
 * rendered as one line per session in the TUI picker.
 *
 * This module is PURE presentation: it never touches `$DSH_HOME`, never
 * stats or reads session logs, and never folds a title — Host-owned session
 * derived state (titles, presets) arrives through the `SessionReader`
 * projection port (`src/runtime/session-reader-port.ts`); the Direct
 * adapter in `src/runtime/direct/` owns the official DSH projection,
 * cache, and observation semantics.
 * @module @xmoon76/dsh-pi-tui/sessions
 */

import { normalize } from 'node:path'
import type { SessionHeader } from '@deepseek-ai/dsh-session'

/**
 * Legacy exported window size: how many most-recent sessions the picker's
 * FIRST title batch used to be capped to, historically. It no longer caps
 * any read — the picker enriches every MAIN row it can display (see
 * commands.ts `openSessionPicker`), so a session beyond this window still
 * gets its projection. Kept exported (and pinned by a test) as a documented
 * legacy value; do not reintroduce it as a read cap.
 */
export const MAX_PICKER_SESSIONS = 200
/** First-batch size for the progressive projection loader: the visible
 * picker window fills immediately, then the remaining rows load behind it. */
export const PROJECTION_FIRST_BATCH = 20
/** Batch size for the remaining projection loads after the first batch. */
export const PROJECTION_BATCH_SIZE = 50

/**
 * Session persistence refuses logs containing a format/event vocabulary this
 * runtime cannot faithfully interpret. Keep that refusal visible at every UI
 * read boundary; turning it into an untitled or missing search row would make
 * durable data loss look like an ordinary absent value.
 */
export function isUnsupportedSessionFormatError(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false
  const value = reason as { name?: unknown; code?: unknown }
  return value.name === 'SessionFormatUnsupportedError'
    || value.code === 'SESSION_FORMAT_UNSUPPORTED'
}

/** Strip the `session-` prefix and keep the first 8 characters, like the
 * kimicode card's short id. */
export function shortSessionId(id: string): string {
  return id.replace(/^session[-_]/i, '').slice(0, 8)
}

/** kimicode-style workspace key: the last two path segments, or a placeholder. */
export function workspaceKey(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return '(no workspace)'
  return cwd.split('/').slice(-2).join('/')
}

/** Whether two cwd values denote the same workspace: lexical path
 * normalization (`/a/b/` ≡ `/a/b` — node's normalize KEEPS one trailing
 * separator, so it is stripped first — and `.`/`..` segments collapse);
 * never a symlink/realpath resolution. An absent/empty cwd matches
 * NOTHING (an unrooted session never scopes into the Current directory
 * category). */
export function sameWorkspace(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a === '' || b === '') return false
  const strip = (path: string): string => {
    let end = path.length
    while (end > 1 && (path[end - 1] === '/' || path[end - 1] === '\\')) end -= 1
    return path.slice(0, end)
  }
  return normalize(strip(a)) === normalize(strip(b))
}

/** Compact relative age of a session ("now", "2m", "3h", "5d", "3mo", "1y"). */
export function formatSessionAge(createdAt: number, now: number = Date.now()): string {
  const diff = now - createdAt
  if (diff < 0) return 'now'
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

/** One session as the picker renders it. */
export interface SessionPickerRow {
  /** Full session id (the picker's value). */
  id: string
  /** Creation epoch-ms, for the relative age. */
  createdAt: number
  /** Latest session title, absent until the background title read lands. */
  title?: string
  /** Absolute working directory, for the workspace group. */
  cwd?: string
  /** Effective agent preset id, when the row has been enriched. Initial
   * lightweight picker rows may omit it while projection replay is pending. */
  preset?: string
  /** The session this one was forked from, when it has lineage. */
  parentSession?: string
  /** Subagent children carry the `sub` marker. */
  origin?: 'subagent'
  /** Whether the session is currently loaded in the session store. */
  live: boolean
}

/** One picker row: value is the session id, group drives the workspace headers. */
export interface SessionPickerItem {
  value: string
  label: string
  description: string
  group: string
}

/** Assemble one session row for the picker, marking the current session.
 * @param indent - tree depth for the "All" category: rows hang under their
 *   parent with a `└─` prefix so subagent lineage reads at a glance.
 */
export function sessionPickerItem(row: SessionPickerRow, currentId: string, indent = 0): SessionPickerItem {
  const marker = row.id === currentId ? '● ' : ''
  const treePrefix = indent <= 0 ? '' : `${'  '.repeat(indent)}└─ `
  const meta: string[] = [shortSessionId(row.id), formatSessionAge(row.createdAt)]
  if (row.origin === 'subagent') meta.push('sub')
  if (row.parentSession !== undefined) meta.push('fork')
  if (row.preset !== undefined) meta.push(`preset:${row.preset}`)
  if (row.live) meta.push('live')
  return {
    value: row.id,
    label: `${treePrefix}${marker}${row.title ?? shortSessionId(row.id)}`,
    description: meta.join(' · '),
    group: workspaceKey(row.cwd),
  }
}

/**
 * Split a session picker label into its FIXED presentation prefix (tree
 * connector + current-session marker) and the marqueeable title (plan
 * §7.7): the selected-row marquee scrolls only the title — the lineage
 * prefix and the `●` marker are layout regions that never move. The
 * derivation mirrors {@link sessionPickerItem}'s construction (never
 * guesses arbitrary prefixes).
 */
export function sessionLabelParts(label: string): { prefix: string; title: string } {
  const treeMatch = /^((?:  )+└─ )/.exec(label)
  const tree = treeMatch?.[1] ?? ''
  const rest = label.slice(tree.length)
  const marker = rest.startsWith('● ') ? '● ' : ''
  return { prefix: tree + marker, title: rest.slice(marker.length) }
}

/**
 * Build the session tree for the picker's "All" category: rows WITHOUT a
 * parentSession are roots (depth 0), and every row WITH a parentSession —
 * fork children, rewind branches AND subagents alike (plan §20: `origin`
 * only decides the badge, `parentSession` decides the hierarchy) — hangs
 * under its parent chain (depth = distance to the nearest root). Orphans —
 * a parent outside the shown window, or a missing parent id — sit at
 * depth 1. The input order (newest first) is preserved per level; a
 * `placed` set guards against parent cycles in corrupt data.
 * @param rows - the picker rows, newest first.
 * @returns rows in display order with their tree depth.
 */
export function buildSessionTree(rows: readonly SessionPickerRow[]): { row: SessionPickerRow; depth: number }[] {
  const children = new Map<string, SessionPickerRow[]>()
  for (const row of rows) {
    if (row.parentSession !== undefined) {
      const list = children.get(row.parentSession)
      if (list === undefined) children.set(row.parentSession, [row])
      else list.push(row)
    }
  }
  const result: { row: SessionPickerRow; depth: number }[] = []
  const placed = new Set<string>()
  const place = (row: SessionPickerRow, depth: number): void => {
    if (placed.has(row.id)) return
    placed.add(row.id)
    result.push({ row, depth })
    for (const child of children.get(row.id) ?? []) place(child, depth + 1)
  }
  for (const row of rows) {
    if (row.parentSession === undefined) place(row, 0)
  }
  for (const row of rows) {
    if (row.parentSession !== undefined) place(row, 1)
  }
  return result
}

/**
 * Resolve one session row for a resume query: an exact id, a
 * `session-`-prefixed prefix, or a short-id prefix. Rows are newest-first,
 * so the first match is the most recent candidate.
 * @param rows - the picker rows, newest first.
 * @param query - the resume query (trimmed).
 * @returns the matching row, or undefined.
 */
export function findSessionMatch(rows: readonly SessionPickerRow[], query: string): SessionPickerRow | undefined {
  // Strip an optional session- prefix before prefix matching so both
  // `session-aaaaaaaa-bbbb` and `aaaaaaaa-bbbb` resolve.
  const bare = query.replace(/^session[-_]/i, '')
  return rows.find(row =>
    row.id === query
    || row.id.startsWith(`session-${bare}`)
    || shortSessionId(row.id).startsWith(bare))
}

/** Map a persistence header onto the picker row shape. */
export function headerToPickerRow(header: SessionHeader, live: boolean): SessionPickerRow {
  return {
    id: header.id,
    createdAt: header.createdAt,
    cwd: header.cwd,
    // This pure mapper has no roster to disambiguate the legal custom `code`
    // id from old pi-tui data. Preserve the durable value; the Direct reader
    // resolves effective preset state through the DSH projection before it
    // exposes an enriched row.
    ...header.agentPreset === undefined ? {} : { preset: header.agentPreset },
    parentSession: header.parentSession,
    origin: header.origin,
    live,
  }
}
