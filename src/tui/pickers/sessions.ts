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
 * @module @xmoon76/dsh-pi-tui/tui/pickers/sessions
 */

import { truncateToWidth } from '@xmoon76/pi-tui'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import {
  buildSessionTree,
  findSessionMatch,
  sameWorkspace,
  sanitizeSessionSearchInput,
  sessionRowMatchesQuery,
  shortSessionId,
} from '../../domain/session/browser.ts'
export {
  buildSessionTree,
  findSessionMatch,
  sameWorkspace,
  sanitizeSessionSearchInput,
  SESSION_SEARCH_QUERY_MAX_CHARS,
  sessionRowMatchesQuery,
  shortSessionId,
} from '../../domain/session/browser.ts'

/** kimicode-style workspace key: the last two path segments, or a placeholder.
 * The cwd is a Host/persistence boundary value — the group header is
 * rendered straight to the terminal, so the output is sanitized here (the
 * single group-derivation point covers the browse AND search views). */
export function workspaceKey(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return '(no workspace)'
  return sanitizeTerminalText(cwd.split('/').slice(-2).join('/'))
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
  /** Host-authoritative activity/order timestamp. */
  updatedAt: number
  /** Source-specific creation hint; Remote rows may not provide it. */
  createdAt?: number
  /** Latest session title, absent until the background title read lands. */
  title?: string
  /** Absolute working directory, for the workspace group. */
  cwd?: string
  /** Effective agent preset id, when the row has been enriched. Initial
   * lightweight picker rows may omit it while projection replay is pending. */
  preset?: string
  /** The parent Session id: retained subagent ancestry, or historical
   * ordinary-fork metadata from before rc.1's independent-fork semantics. */
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

/** One content-search hit merged onto an already-listed picker row (the
 * Host page's bounded snippet; the row identity always comes from the
 * list, never from the search page). */
export interface SessionContentHit {
  /** Host-selected bounded plain-text excerpt. */
  readonly snippet: string
}

/** Strip terminal control characters from untrusted text before it enters
 * the picker presentation. The shared presentation projection removes every
 * complete ANSI/OSC/APC sequence (including C1 8-bit forms and unterminated
 * tails), then every remaining C0 control, DEL and C1 control, and folds the
 * result onto exactly one physical row: the picker writes descriptions
 * straight to the terminal, and a terminal decoding UTF-8 interprets C1 code
 * points as control sequences, not text. Host snippets may carry persisted
 * control bytes (message/tool output) — a raw ESC/OSC would be interpreted,
 * not displayed. */
export function sanitizeTerminalText(value: string): string {
  return sanitizedPhysicalLine(value)
}

/** Project the Session Browser's persisted error onto its shared one-row
 * status/notice text. The raw-log suffix stays in diagnostics, not on screen. */
export function sessionBrowserErrorNotice(kind: 'search' | 'projection', message: string): string {
  const safe = sanitizeTerminalText(message).replace(/\s+\(raw log: .*\)$/u, '')
  const unknownEvent = /contains event type "([^"]+)"/u.exec(safe)?.[1]
  const text = unknownEvent === undefined
    ? `${kind === 'search' ? 'Search failed' : 'Session details unavailable'}: ${safe}`
    : `unknown event ${unknownEvent}`
  return truncateToWidth(text, 40, '…')
}

/** Assemble one session row for the picker, marking the current session.
 * @param indent - tree depth for the "All" category: rows hang under their
 *   parent with a `└─` prefix so subagent lineage reads at a glance.
 * @param contentHit - optional Host content-search hit for this row: the
 *   snippet joins the description so the local filter (which matches
 *   descriptions) surfaces content-only hits.
 */
export function sessionPickerItem(row: SessionPickerRow, currentId: string, indent = 0, contentHit?: SessionContentHit): SessionPickerItem {
  const marker = row.id === currentId ? '● ' : ''
  const treePrefix = indent <= 0 ? '' : `${'  '.repeat(indent)}└─ `
  // The ID-derived display copy (never the picker `value`, which stays the raw
  // session id) is projected like every other Host-derived label.
  const meta: string[] = [sanitizeTerminalText(shortSessionId(row.id)), formatSessionAge(row.createdAt ?? row.updatedAt)]
  if (row.origin === 'subagent') meta.push('sub')
  // `fork` is HISTORICAL ordinary-fork metadata only. A real subagent never
  // gets it, and an rc.1 ordinary fork carries no parent at all.
  else if (row.parentSession !== undefined) meta.push('fork')
  if (row.preset !== undefined) meta.push(`preset:${sanitizeTerminalText(row.preset)}`)
  if (row.live) meta.push('live')
  if (contentHit !== undefined) meta.push(`…${sanitizeTerminalText(contentHit.snippet)}…`)
  return {
    value: row.id,
    label: `${treePrefix}${marker}${row.title === undefined ? sanitizeTerminalText(shortSessionId(row.id)) : sanitizeTerminalText(row.title)}`,
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
