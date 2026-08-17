/**
 * Per-cwd input-history persistence — JSONL files under `$DSH_HOME/user-history/`,
 * one `{"content": "..."}` line per submitted prompt (kimi-code's
 * input-history pattern: a dedicated data file, never the settings
 * document). Append-only writes make concurrent windows in one directory
 * safe (O_APPEND lines cannot clobber each other), which whole-file settings
 * replaces could not guarantee.
 *
 * Semantics:
 * - File order is submission order (oldest first); the editor seeds
 *   oldest→newest so its recall list is newest-first.
 * - Empty submissions and consecutive repeats are skipped (shell-history
 *   behavior); non-consecutive repeats are legal history and survive.
 * - Corrupt lines are skipped on load, never fatal.
 * - The file is capped at HISTORY_LIMIT entries; the cap trims on load.
 * - `!` shell commands are stored verbatim (with the leading `!`), so ↑
 *   recall restores them as text and Enter re-runs the shell branch.
 *
 * Pure and injectable so pathing, parsing, and append rules are
 * unit-testable without touching the terminal or dsh services.
 * @module @xmoon76/dsh-pi-tui/history
 */

import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Directory name under `$DSH_HOME` holding the per-cwd history files. */
export const HISTORY_DIR_NAME = 'user-history'

/** Max entries kept per working directory (shell `HISTSIZE` analogue). */
export const HISTORY_LIMIT = 100

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
 * Parse one history file's text into entries, in file order (oldest first).
 * Blank lines and corrupt lines (unparsable JSON or a non-string `content`)
 * are skipped — a torn write or an older format must never abort recall.
 * @param text - the raw file content.
 */
export function parseHistoryLines(text: string): string[] {
  const entries: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as { content?: unknown }
      if (typeof parsed.content === 'string' && parsed.content !== '') entries.push(parsed.content)
    } catch {
      // Corrupt line: skip, keep loading.
    }
  }
  return entries
}

/**
 * Load a history file, trimming it to the last HISTORY_LIMIT entries when it
 * outgrew the cap (the trim rewrites the file best-effort so it stops
 * growing). Never throws: an unreadable or absent file is empty history.
 * @param file - the JSONL history file path.
 * @returns entries in file order (oldest first).
 */
export function loadHistoryFile(file: string): string[] {
  try {
    if (!existsSync(file)) return []
    const entries = parseHistoryLines(readFileSync(file, 'utf8'))
    if (entries.length <= HISTORY_LIMIT) return entries
    const kept = entries.slice(-HISTORY_LIMIT)
    try {
      // Temp + rename: a concurrent append from another window between the
      // read and this rewrite must never be lost (a direct writeFileSync
      // would clobber it). The rename commits atomically.
      const temp = `${file}.tmp`
      writeFileSync(temp, kept.map(entry => JSON.stringify({ content: entry })).join('\n') + '\n', { mode: 0o600 })
      renameSync(temp, file)
    } catch {
      // Best-effort trim; the in-memory recall still serves the kept set.
    }
    return kept
  } catch {
    return []
  }
}

/**
 * Append one submitted line to the history file. Empty lines and a repeat of
 * `lastContent` (the newest known entry) are skipped, like shell history.
 * Multi-line submissions are stored as one JSON line (newlines escaped), so
 * the JSONL layout survives pastes.
 *
 * Throws on I/O failure (the caller decides how to surface it); the
 * skip verdicts return false without touching the file.
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