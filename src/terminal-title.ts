/**
 * The terminal window title policy (OSC 0): what `setTerminalTitle` writes
 * must be human-readable identity — the session title when one exists, a
 * short cwd otherwise, never the full session UUID / model / preset.
 *
 * Pure and dependency-light (the width utilities come from the vendored
 * pi-tui terminal layer — display-width aware, so CJK / emoji / ZWJ titles
 * are truncated by VISIBLE CELLS, never by code-unit `slice`).
 *
 * The composed title is SANITIZED before it is returned: session titles
 * and cwds are untrusted text (a session title event, a user rename, a
 * path), and the result is written into the `\x1b]0;…\x07` OSC sequence —
 * embedded ESC/OSC/BEL/C0 sequences must never escape the title payload
 * and emit arbitrary terminal control.
 * @module @xmoon76/dsh-pi-tui/terminal-title
 */

import { stripTerminalSequences, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import { shortCwd } from './footer/formatters.ts'

/** The title display cap (terminal cells, not code units). */
export const MAX_TERMINAL_TITLE_WIDTH = 40

/** The inputs the title policy derives from (identity only, never a live
 * object). `sessionTitle` is the session's presentation title (auto or
 * user-pinned); `cwd` the session (or launch) working directory. */
export interface TerminalTitleContext {
  sessionTitle?: string
  cwd?: string
}

/**
 * Remove every sequence and control character that could terminate or
 * escape the OSC title payload.
 *
 * `stripTerminalSequences` removes COMPLETE ANSI/OSC/APC sequences
 * (terminated by BEL/ST); an UNTERMINATED OSC (`ESC ]` … with no terminator)
 * returns null from the fork parser, so the raw payload survives the strip.
 * The C0/C1 pass then removes the leading ESC but leaves the payload text
 * (`]0;INJECTED`) visible — not a terminal escape, but snake oil in a title.
 * This sanitizer therefore ALSO consumes an unterminated OSC/APC tail: once
 * `ESC ]` / `ESC _` with no terminator is seen, everything to end-of-string
 * is dropped (there is nothing after an unterminated sequence that can be
 * legitimate title text — the sequence claims the remainder).
 *
 * C0/C1 control characters are removed too (BEL terminator, CR/LF, ESC,
 * friends). Visible text survives; the result is plain, single-line,
 * terminal-safe display text.
 */
export function sanitizeTitleText(text: string): string {
  let stripped = stripTerminalSequences(text)
  // Unterminated OSC/APC tail: `stripTerminalSequences` left `ESC ]…` /
  // `ESC _…` (its parser needs a terminator), and the C0 pass below would
  // remove just the ESC. Consume the whole claim: the sequence owns the
  // remainder of the string, so nothing after it can be a legit title.
  // eslint-disable-next-line no-control-regex -- the C0/C1 classes are the point
  stripped = stripped.replace(/\x1b[\]_][\s\S]*$/gu, '')
  return stripped.replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
}

/** Short cwd for titles: last two path segments (delegated to the footer's
 * formatter — ONE implementation, so the title identity and the footer
 * identity can never drift, including the Windows/UNC separator rules). */
export const shortPathCwd = shortCwd

/**
 * Derive the terminal window title:
 *
 * ```text
 * sessionTitle (trimmed, non-empty) → "dsh · <sessionTitle>"
 * else cwd                            → "dsh · <short cwd>"
 * else                                → "dsh"
 * ```
 * then truncated to {@link MAX_TERMINAL_TITLE_WIDTH} VISIBLE cells with a
 * `…` ellipsis (never a code-unit slice: CJK is 2 cells, emoji/ZWJ are
 * wider, surrogate pairs must not be split).
 */
export function terminalTitleOf(context: TerminalTitleContext): string {
  // SANITIZE FIRST, THEN TRIM: a whitespace-only title wrapped in ANSI
  // (`\x1b[31m   \x1b[0m`) must collapse to '' after sanitization and fall
  // back to the short cwd — trimming before sanitizing would leave the
  // ANSI wrapper as "content" and yield `dsh ·    `.
  const sessionTitle = sanitizeTitleText(context.sessionTitle ?? '').trim()
  let title: string
  if (sessionTitle !== '') {
    title = `dsh · ${sessionTitle}`
  } else if (context.cwd !== undefined && context.cwd !== '') {
    title = `dsh · ${sanitizeTitleText(shortPathCwd(context.cwd))}`
  } else {
    title = 'dsh'
  }
  return truncateToWidth(title, MAX_TERMINAL_TITLE_WIDTH, '…')
}

/** Whether a derived title fits (exposed for the headless assertions). */
export function terminalTitleFits(title: string): boolean {
  return visibleWidth(title) <= MAX_TERMINAL_TITLE_WIDTH
}
