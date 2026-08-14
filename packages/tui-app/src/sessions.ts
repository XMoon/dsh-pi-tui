/**
 * Session-picker support for `/sessions`: pure row assembly and title
 * loading. The row model mirrors the kimicode web session rail — a short id,
 * a relative age, an optional title, and a workspace group — rendered as one
 * line per session in the TUI picker.
 * @module @xmoon76/tui-app/sessions
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'

/** How many most-recent sessions the picker shows at once (older rows still
 * appear, but only this many get background title reads). */
export const MAX_PICKER_SESSIONS = 200

/**
 * The narrow session-query surface the picker uses. Declared structurally
 * instead of imported from `@deepseek-ai/dsh-session-query`: the dev-loop
 * symlink for that package resolves from the dsh install's own node_modules,
 * and pulling its type graph into the program introduces a second physical
 * copy of `dsh-session` that shadows the `session/title` event-map
 * augmentation. The service itself is read off the live context at runtime,
 * so no import is needed for types either.
 */
export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<Array<{ header: SessionHeader; live: boolean }>>
  readTitleSnapshots(
    ids: readonly SessionId[],
    signal?: AbortSignal,
  ): Promise<Array<SessionTitleObservationResultLike>>
}

/** One per-session result of a batch title observation (discriminated on
 * `status`, mirroring the real engine's result union). */
export type SessionTitleObservationResultLike =
  | { sessionId: string; status: 'fulfilled'; value: { session?: unknown; title?: { title: string } } }
  | { sessionId: string; status: 'rejected'; reason?: unknown }

/** The persistence surface the fallback title path needs. */
export interface SessionPickerPersistence {
  inspect(id: SessionId, signal?: AbortSignal): Promise<{ events: readonly SessionEvent[] }>
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
  /** Agent preset id the session runs on, when the deployment composes one. */
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

/** Assemble one session row for the picker, marking the current session. */
export function sessionPickerItem(row: SessionPickerRow, currentId: string): SessionPickerItem {
  const marker = row.id === currentId ? '● ' : ''
  const meta: string[] = [shortSessionId(row.id), formatSessionAge(row.createdAt)]
  if (row.origin === 'subagent') meta.push('sub')
  if (row.parentSession !== undefined) meta.push('fork')
  if (row.preset !== undefined) meta.push(`preset:${row.preset}`)
  if (row.live) meta.push('live')
  return {
    value: row.id,
    label: `${marker}${row.title ?? shortSessionId(row.id)}`,
    description: meta.join(' · '),
    group: workspaceKey(row.cwd),
  }
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
    preset: header.agentPreset,
    parentSession: header.parentSession,
    origin: header.origin,
    live,
  }
}

/**
 * Load the latest titles for a batch of sessions, newest-first order
 * preserved. Prefers the session-query engine's batch observation (one
 * cancellable corpus read, failures isolated per session); falls back to
 * bounded sequential persistence inspections folded with `foldSessionTitle`
 * when the engine is absent. Never throws for per-session failures.
 * @param query - the mounted session-query engine, when present.
 * @param persistence - the persistence backend for the fallback path.
 * @param ids - session ids to title, in display order.
 * @param signal - optional cancellation for the whole batch.
 * @returns title text by session id; absent ids simply have no entry.
 */
export async function loadSessionTitles(
  query: SessionQueryLike | undefined,
  persistence: SessionPickerPersistence | undefined,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (query !== undefined) {
    const results = await query.readTitleSnapshots(ids.map(id => SessionId(id)), signal)
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.title !== undefined) {
        titles.set(result.sessionId, result.value.title.title)
      }
    }
    return titles
  }
  if (persistence === undefined) return titles
  // Fallback: sequential bounded inspections; one failing session must not
  // starve the rest, so every worker catches per-session failures.
  const queue = [...ids]
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      const id = queue.shift()
      if (id === undefined) return
      try {
        const inspection = await persistence.inspect(SessionId(id), signal)
        const title = foldSessionTitle(inspection.events)
        if (title !== undefined) titles.set(id, title.title)
      } catch {
        // Isolated failure: the row stays untitled.
      }
    }
  })
  await Promise.all(workers)
  return titles
}
