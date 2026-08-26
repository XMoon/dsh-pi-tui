/**
 * Session-picker support for `/sessions`: pure row assembly and title
 * loading. The row model mirrors the kimicode web session rail — a short id,
 * a relative age, an optional title, and a workspace group — rendered as one
 * line per session in the TUI picker.
 * @module @xmoon76/dsh-pi-tui/sessions
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { safeErrorMessage } from './error-boundary.ts'

/**
 * Legacy exported window size: how many most-recent sessions the picker's
 * FIRST title batch used to be capped to, historically. It no longer caps
 * the title reads — the picker loads titles for every MAIN row it can
 * display (see commands.ts `openSessionPicker`), so a session beyond this
 * window still gets its title. Kept exported (and pinned by a test) as a
 * documented legacy value; do not reintroduce it as a read cap.
 */
export const MAX_PICKER_SESSIONS = 200
/** First-batch size for the progressive session-title loader: the visible
 * picker window fills immediately, then the remaining rows load behind it. */
export const TITLE_FIRST_BATCH = 20
/** Batch size for the remaining title loads after the first batch. */
export const TITLE_BATCH_SIZE = 50

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

/** The optional diagnostics sink the title loader reports rejected engine
 * reads through (a structural subset of the runner's Diag channel — the
 * pure helper never imports the runner). */
export interface TitleDiagLike {
  info(message: string, fields?: Record<string, unknown>): void
}

/** The engine's rejection `code` when the reason carries one (a
 * `SessionQueryError`-shaped object), else `UNKNOWN`. */
function errorCodeOf(reason: unknown): string {
  if (typeof reason === 'object' && reason !== null) {
    const code = (reason as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') return code
  }
  return 'UNKNOWN'
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
    preset: header.agentPreset,
    parentSession: header.parentSession,
    origin: header.origin,
    live,
  }
}

/**
 * Load the latest titles for a batch of sessions, newest-first order
 * preserved. Prefers the session-query engine's batch observation (one
 * cancellable corpus read, failures isolated per session — a rejected
 * session's id lands an info diagnostic with the engine's code and
 * reason, never a silent drop and never a behind-the-engine retry);
 * falls back to bounded sequential persistence inspections folded with
 * `foldSessionTitle` when the engine is absent. Never throws for
 * per-session failures.
 * @param query - the mounted session-query engine, when present.
 * @param persistence - the persistence backend for the fallback path.
 * @param ids - session ids to title, in display order.
 * @param signal - optional cancellation for the whole batch.
 * @param diag - optional diagnostics sink for rejected engine reads.
 * @returns title text by session id; absent ids simply have no entry.
 */
export async function loadSessionTitles(
  query: SessionQueryLike | undefined,
  persistence: SessionPickerPersistence | undefined,
  ids: readonly string[],
  signal?: AbortSignal,
  diag?: TitleDiagLike,
): Promise<Map<string, string>> {
  return loadSessionTitleBatch(query, persistence, undefined, ids.map(id => ({ id })), signal, diag)
}

/**
 * Load titles for ONE batch of sessions (the progressive picker loader),
 * consulting and refreshing the LOCAL title cache under `$DSH_HOME`:
 * a cached title whose log file size+mtime still match is used WITHOUT
 * touching the engine or persistence (the expensive full-log reads); every
 * other id goes through the normal read path and is written back. A
 * session whose log facts cannot be derived (unknown layout, absent file)
 * simply skips the cache and reads directly. `home === undefined` disables
 * the cache entirely (plain `loadSessionTitles` semantics).
 *
 * The engine batch isolates failures PER SESSION: a fulfilled result with
 * a title is final, a fulfilled result WITHOUT a title means the session
 * genuinely has none, and a REJECTED result is a real per-session read
 * failure. Rejected reads are NEVER retried behind the engine's back and
 * NEVER silently dropped: the engine's cold path already performs the
 * same persistence inspection, so re-running it reproduces the identical
 * failure for `SESSION_QUERY_PERSISTENCE_FAILED` / `CORRUPT_SESSION` and
 * would BYPASS the engine's header-identity guard for
 * `SESSION_QUERY_SOURCE_CONFLICT` (folding a title from a mismatched
 * header). The engine-present path used to drop rejects silently, leaving
 * the picker on a bare short id with no explanation; now every rejected
 * read lands an info diagnostic carrying the engine's original code and
 * reason, so the failure is visible in the default log file.
 * @param query - the mounted session-query engine, when present.
 * @param persistence - the persistence backend for the fallback path
 *   (used ONLY when no engine is mounted).
 * @param home - `$DSH_HOME` (cache root); undefined disables the cache.
 * @param rows - sessions to title (id + cwd for the log-path derivation),
 *   in display order.
 * @param signal - optional cancellation for the whole batch.
 * @param diag - optional diagnostics sink for rejected engine reads.
 * @returns title text by session id; absent ids simply have no entry.
 */
export async function loadSessionTitleBatch(
  query: SessionQueryLike | undefined,
  persistence: SessionPickerPersistence | undefined,
  home: string | undefined,
  rows: readonly { id: string; cwd?: string }[],
  signal?: AbortSignal,
  diag?: TitleDiagLike,
): Promise<Map<string, string>> {
  const titles = new Map<string, string>()
  if (rows.length === 0) return titles
  const cache = home === undefined ? undefined : fileTitleCache(home)
  const cached = cache?.read() ?? {}
  // Ids with a STILL-VALID cache entry (log size+mtime unchanged) skip the
  // reads entirely; everything else is read and written back below.
  const toRead = rows.filter(row => {
    const entry = cached[row.id]
    if (entry === undefined) return true
    const facts = home === undefined ? undefined : logFacts(home, row)
    if (facts !== undefined && facts.size === entry.logSize && facts.mtimeMs === entry.logMtimeMs) {
      titles.set(row.id, entry.title)
      return false
    }
    return true
  })
  const found = new Map<string, string>()
  if (toRead.length > 0) {
    if (query !== undefined) {
      const results = await query.readTitleSnapshots(toRead.map(row => SessionId(row.id)), signal)
      // Cancellation propagates: the engine rethrows an aborted signal, but
      // re-checking after the await keeps the contract explicit even for a
      // non-conforming engine, and a cancelled batch must never emit
      // diagnostics or touch persistence.
      signal?.throwIfAborted()
      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.title !== undefined) found.set(result.sessionId, result.value.title.title)
          continue
        }
        // A rejected engine read is a real per-session failure: expose the
        // engine's code + reason at INFO level (visible in the default
        // diagnostics log file). Never a fallback — see the doc comment.
        diag?.info('session title unavailable', {
          session: result.sessionId,
          code: errorCodeOf(result.reason),
          reason: safeErrorMessage(result.reason),
        })
      }
    } else if (persistence !== undefined) {
      await inspectTitlesFromPersistence(persistence, toRead, found, signal)
    }
  }
  for (const [id, title] of found) titles.set(id, title)
  // Write back the freshly-read entries (only when a title was actually
  // found — a genuinely untitled session keeps re-reading, cheap).
  if (cache !== undefined && found.size > 0 && home !== undefined) {
    const writes: Record<string, TitleCacheEntry> = {}
    for (const row of toRead) {
      const title = found.get(row.id)
      if (title === undefined) continue
      const facts = logFacts(home, row)
      if (facts === undefined) continue
      writes[row.id] = { title, logSize: facts.size, logMtimeMs: facts.mtimeMs }
    }
    if (Object.keys(writes).length > 0) cache.write({ ...cached, ...writes })
  }
  return titles
}

/**
 * Bounded fallback title reads for deployments WITHOUT a session-query
 * engine: sequential 4-worker inspections; one failing session must not
 * starve the rest, so every worker catches per-session failures.
 * Cancellation propagates — the workers re-check the signal before every
 * inspection, and each inspection receives it. (Engine-present batches
 * NEVER reach this path: the engine already performs these same
 * inspections behind its consistency guards.)
 * @param persistence - the persistence backend to inspect.
 * @param rows - the sessions to inspect (the whole batch, no engine).
 * @param found - the shared title map, filled in place.
 * @param signal - optional cancellation for the whole fallback.
 */
async function inspectTitlesFromPersistence(
  persistence: SessionPickerPersistence | undefined,
  rows: readonly { id: string; cwd?: string }[],
  found: Map<string, string>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (persistence === undefined) return
  const queue = [...rows]
  const workers = Array.from({ length: 4 }, async () => {
    for (;;) {
      signal?.throwIfAborted()
      const row = queue.shift()
      if (row === undefined) return
      try {
        const inspection = await persistence.inspect(SessionId(row.id), signal)
        const title = foldSessionTitle(inspection.events)
        if (title !== undefined) found.set(row.id, title.title)
      } catch {
        // Isolated failure: the row stays untitled.
      }
    }
  })
  await Promise.all(workers)
}

/** One title-cache entry: the title plus the log file facts it was read
 * from, so a cached title is only trusted while the log is unchanged. */
export interface TitleCacheEntry {
  title: string
  logSize: number
  logMtimeMs: number
}

/** The title-cache map, keyed by session id. */
export type TitleCache = Readonly<Record<string, TitleCacheEntry>>

/** The title-cache store surface (file-backed in the runner; injectable
 * for tests). */
export interface TitleCacheStore {
  /** Read the cached entries; `{}` when absent or corrupt. */
  read(): TitleCache
  /** Persist the merged cache (best-effort; a failed write degrades to no
   * cache and must never throw). */
  write(cache: TitleCache): void
}

/** The title-cache file: `$DSH_HOME/cache/pi-tui-session-titles.json`. */
export function titleCachePath(home: string): string {
  return join(home, 'cache', 'pi-tui-session-titles.json')
}

/** File-backed {@link TitleCacheStore} under `$DSH_HOME/cache/`. Missing or
 * corrupt files degrade to an empty cache; writes are best-effort (0600). */
export function fileTitleCache(home: string): TitleCacheStore {
  const path = titleCachePath(home)
  return {
    read: () => {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
        if (typeof parsed !== 'object' || parsed === null) return {}
        const out: Record<string, TitleCacheEntry> = {}
        for (const [id, entry] of Object.entries(parsed)) {
          if (typeof entry === 'object' && entry !== null
            && typeof (entry as TitleCacheEntry).title === 'string'
            && typeof (entry as TitleCacheEntry).logSize === 'number'
            && typeof (entry as TitleCacheEntry).logMtimeMs === 'number') {
            out[id] = entry as TitleCacheEntry
          }
        }
        return out
      } catch {
        return {}
      }
    },
    write: (cache) => {
      try {
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, JSON.stringify(cache), { mode: 0o600 })
      } catch {
        // Best-effort: a failed cache write degrades to no cache.
      }
    },
  }
}

/**
 * Best-effort session log path for the JSONL persistence layout:
 * `$root/<projectKey(cwd)>/<id>/session.jsonl.zstd`. The two encodings
 * (`projectKey` + the safe path segment) mirror the upstream
 * `session-persistence-jsonl` format so the cache can verify log size/mtime;
 * a derivation mismatch (upstream layout change) only costs a cache miss —
 * the direct read path is never affected.
 */
export function sessionLogPath(root: string, cwd: string | undefined, id: string): string {
  return join(root, projectKeyOf(cwd), encodePathSegment(id), 'session.jsonl.zstd')
}

/** The log file facts for one session, or undefined when the path cannot be
 * derived or the file is absent (the cache entry is then unverifiable). */
function logFacts(home: string, row: { id: string; cwd?: string }): { size: number; mtimeMs: number } | undefined {
  try {
    const stats = statSync(sessionLogPath(join(home, 'sessions'), row.cwd, row.id))
    return { size: stats.size, mtimeMs: stats.mtimeMs }
  } catch {
    return undefined
  }
}

/** The upstream `projectKey` path encoding (see {@link sessionLogPath}). */
function projectKeyOf(cwd: string | undefined): string {
  if (cwd === undefined) return '_no-cwd'
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/** The upstream per-session path-segment encoding (see {@link sessionLogPath}). */
function encodePathSegment(raw: string): string {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}
