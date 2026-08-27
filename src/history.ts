/**
 * Per-cwd input-history persistence — JSONL files under `$DSH_HOME/user-history/`,
 * one `{"content":"..."}` line per submitted prompt (kimi-code's input-history pattern: a dedicated
 * data file, never the settings document). Append-only writes make concurrent windows in one
 * directory safe (O_APPEND lines cannot clobber each other), which whole-file settings
 * replaces could not guarantee.
 *
 * Semantics:
 * - File order is submission order (oldest first); the editor seeds oldest→newest so its
 *   recall list is newest-first.
 * - Empty submissions and consecutive repeats are skipped (shell-history
 *   behavior); non-consecutive repeats are legal history and survive.
 * - Corrupt lines are skipped on load, never fatal.
 * - The canonical file is NEVER truncated or rewritten on read — recall
 *   caps at HISTORY_RECALL_LIMIT in memory, the file keeps every row.
 * - `!` shell commands are stored verbatim (with the leading `!`), so ↑
 *   recall restores them as text and Enter re-runs the shell branch.
 *
 * Recall vs. persistence (decoupled):
 * - `↑` editor recall is seeded from the latest HISTORY_RECALL_LIMIT entries only
 *   (loadRecallHistory); the canonical JSONL file itself is NEVER truncated.
 * - Auto-compaction is a planned maintenance milestone (M2,
 *   HISTORY_FILE_MAX_ENTRIES), not part of the read/append contract.
 *
 * Pure and injectable so pathing, parsing, and append rules are unit-testable
 * without touching the terminal or dsh services.
 * @module @xmoon76/dsh-pi-tui/history
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Directory name under `$DSH_HOME` holding the per-cwd history files. */
export const HISTORY_DIR_NAME = 'user-history'

/** Max entries `↑`/`↓` recall seeds from a history file (shell `HISTSIZE`
 * analogue). Capped here (in-memory editor recall only) — the canonical
 * file itself keeps every row; only the seeded recall is limited. */
export const HISTORY_RECALL_LIMIT = 100

/**
 * Planned per-file retention cap for maintenance compaction (M2): when the
 * canonical file outgrows this, a guarded maintenance pass may compact it down
 * to this many entries. NOT enforced today — the read path never rewrites
 * and the append path is append-only; auto-compaction lands in a later milestone
 * together with its lock protocol.
 */
export const HISTORY_FILE_MAX_ENTRIES = 5000

/** The canonical (v2) history row written by dsh-pi-tui. */
export interface HistoryRecordV2 {
  v: 2
  content: string
  cwd: string
  ts: number
  sessionId?: string
}

/** One parsed history row, v1 or v2, with metadata normalized. */
export interface ParsedHistoryRecord {
  content: string
  /** The working directory this prompt was submitted from (v2 rows carry
   * it; v1 rows have none — never fabricated). */
  cwd: string | null
  /** Submission epoch-ms (v2 rows carry it; v1 rows have none — never
   * fabricated). */
  ts: number | null
  sessionId?: string
  version: 1 | 2
}

/**
 * The history file for one working directory: `$DSH_HOME/user-history/<md5(cwd)>.jsonl`.
 * The cwd hash keeps the file list flat and free of path separators; the
 * hash is an identity, never shown to the user.
 * @param home - the dsh home directory (`$DSH_HOME`, default `~/.dsh`).
 * @param cwd - the working directory whose submissions the file records.
 */
export function historyFilePath(home: string, cwd: string): string {
  const hash = createHash('md5').update(cwd, 'utf-8').digest('hex')
  return join(home, HISTORY_DIR_NAME, `${hash}.jsonl`)
}

/**
 * The path of a history file by hash (the inverse of {@link historyFilePath})
 * — used by the all-directories search to recover which cwd a legacy file belonged to.
 * @param home - the dsh home directory (`$DSH_HOME`).
 * @param hash - the hex md5 of the cwd.
 */
export function historyFilePathFromHash(home: string, hash: string): string {
  return join(home, HISTORY_DIR_NAME, `${hash}.jsonl`)
}

/**
 * Parse one history file's text into v1 content strings, in file order
 * (oldest first). Blank lines and corrupt lines (unparsable JSON or a
 * non-string `content`) are skipped — a torn write or an older format must
 * never abort recall.
 * @param text - the raw file content.
 */
export function parseHistoryLines(text: string): string[] {
  return parseHistoryRecords(text).map(record => record.content)
}

/**
 * Parse ONE history line into a normalized record, or NULL when the line
 * carries no record (blank, unparsable JSON, non-string/empty content,
 * unsupported version). Shared by the forward whole-file parser
 * ({@link parseHistoryRecords}) and the reverse bounded search reader
 * (history-search.ts) so v1/v2 parsing semantics can never drift between
 * the two read paths.
 * @param line - one physical JSONL line (may be blank).
 */
export function parseHistoryRecordLine(line: string): ParsedHistoryRecord | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // Corrupt line: skip, keep loading.
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const row = parsed as Record<string, unknown>
  if (typeof row.content !== 'string' || row.content === '') return null
  if (row.v === 2) {
    const cwd = typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null
    const ts = typeof row.ts === 'number' && Number.isFinite(row.ts) ? row.ts : null
    const record: ParsedHistoryRecord = { content: row.content, cwd, ts, version: 2 }
    if (typeof row.sessionId === 'string' && row.sessionId !== '') record.sessionId = row.sessionId
    return record
  }
  // v1 (or unknown): legacy `{}`-only rows keep working.
  return { content: row.content, cwd: null, ts: null, version: 1 }
}

/**
 * Parse one history file's text into normalized records, in file order
 * (oldest first). v1 rows are `{"content"}`; v2 rows keep their
 * metadata. Corrupt lines (unparsable JSON, non-string content, unsupported
 * version) are skipped; v2 rows with invalid metadata (missing
 * string cwd, non-number ts) degrade the field to null instead of dropping
 * the row — their content stays searchable, their metadata is simply
 * not trusted.
 * @param text - the raw file content.
 */
export function parseHistoryRecords(text: string): ParsedHistoryRecord[] {
  const records: ParsedHistoryRecord[] = []
  for (const line of text.split('\n')) {
    const record = parseHistoryRecordLine(line)
    if (record !== null) records.push(record)
  }
  return records
}

/**
 * Read a history file's records in file order (oldest first). READ-ONLY:
 * the canonical file is never truncated or rewritten here, so a concurrent
 * append from another window can never be lost to a read-then-replace.
 * Never throws: an unreadable or absent file is empty history.
 * @param file - the JSONL history file path.
 */
export function loadHistoryRecords(file: string): ParsedHistoryRecord[] {
  try {
    if (!existsSync(file)) return []
    return parseHistoryRecords(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

/**
 * Load the RECALL view of a history file: the content strings of the latest
 * {@link HISTORY_RECALL_LIMIT} rows, in file order (oldest first) so the editor
 * can seed newest-first. READ-ONLY — the canonical file keeps every
 * row; only the seeded recall is capped.
 * @param file - the JSONL history file path.
 * @param limit - the recall cap (defaults to {@link HISTORY_RECALL_LIMIT}).
 * @returns the latest `limit` content strings, oldest first.
 */
export function loadRecallHistory(file: string, limit = HISTORY_RECALL_LIMIT): string[] {
  const records = loadHistoryRecords(file)
  return records.slice(-limit).map(record => record.content)
}

/**
 * Back-compat wrapper for `loadHistoryFile`: the recall view — the latest
 * {@link HISTORY_RECALL_LIMIT} contents. Differs from the historical
 * behavior in ONE deliberate way: it no longer rewrites/trims the canonical
 * file on read (see {@link loadRecallHistory}).
 * @param file - the JSONL history file path.
 * @returns the latest `HISTORY_RECALL_LIMIT` content strings, oldest first.
 */
export function loadHistoryFile(file: string): string[] {
  return loadRecallHistory(file)
}

/**
 * Project the editor ↑/↓ recall for ONE session identity (session-scoped
 * history, the recall-scope contract in docs/input-history.md):
 *
 * - `sessionId === undefined` (fresh / deferred start, no live session):
 *   the ENTIRE cwd file is the recall pool (the historical behavior — v1
 *   legacy rows and every session's rows all participate).
 * - a live session id: ONLY the rows that carry exactly that sessionId.
 *   v1 legacy rows (no sessionId) are NEVER guessed into a session — they
 *   stay reachable through Ctrl+R (`Current directory` / `All
 *   directories`), exactly like rows of other sessions.
 *
 * The canonical CWD file and its last row are unchanged (persistence
 * dedupe stays cwd-scoped, {@link appendHistoryRecord}); this function
 * only projects the editor's recall.
 *
 * @param records - the parsed canonical records, file order (oldest first).
 * @param sessionId - the live session id, or undefined for no-session cwd recall.
 * @param limit - the recall cap (defaults to {@link HISTORY_RECALL_LIMIT}).
 * @returns the matching contents of the latest `limit` rows, oldest first
 *   (callers seed the editor newest-first with `.reverse()`).
 */
export function recallHistoryForSession(
  records: readonly ParsedHistoryRecord[],
  sessionId: string | undefined,
  limit = HISTORY_RECALL_LIMIT,
): string[] {
  const scoped = sessionId === undefined
    ? records
    : records.filter(record => record.sessionId === sessionId)
  return scoped.slice(-limit).map(record => record.content)
}

/**
 * Append one canonical (v2) history record to a history file. An empty
 * content and a repeat of `lastContent` (the newest known row) are skipped,
 * like shell history. Multi-line submissions are stored as one JSON line
 * (newlines escaped), so the JSONL layout survives pastes.
 *
 * Throws on I/O failure (the caller decides how to surface it); the
 * skip verdicts return false without touching the file.
 * @param file - the JSONL history file path.
 * @param record - the v2 record to persist.
 * @param lastContent - the newest content known to the caller, or undefined.
 * @returns whether an entry was written.
 */
export function appendHistoryRecord(
  file: string,
  record: HistoryRecordV2,
  lastContent: string | undefined,
): boolean {
  const content = record.content.trim()
  if (content === '' || content === lastContent) return false
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  appendFileSync(file, JSON.stringify({ ...record, content }) + '\n', { encoding: 'utf8', mode: 0o600 })
  return true
}

/**
 * Back-compat wrapper for the historical string-only append (kimi v1
 * layout). New write paths should use {@link appendHistoryRecord} so the canonical
 * store gains cwd/ts metadata.
 * @param file - the JSONL history file path.
 * @param text - the submitted input.
 * @param lastContent - the newest entry known to the caller, or undefined.
 * @returns whether an entry was written.
 */
export function appendHistoryLine(file: string, text: string, lastContent: string | undefined): boolean {
  const content = text.trim()
  if (content === '' || content === lastContent) return false
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  appendFileSync(file, JSON.stringify({ content }) + '\n', { encoding: 'utf8', mode: 0o600 })
  return true
}