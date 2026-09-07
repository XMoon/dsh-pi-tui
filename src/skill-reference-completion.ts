/**
 * Pure Client-local inline skill reference completion: the plain-text
 * `/skill-name` token grammar behind the editor's inline skill
 * autocomplete (the 2026-09-07 next inline multi-skill plan).
 *
 * This module is deliberately PURE: it never reads Context, Agent,
 * Session, filesystem, registry or Remote. It only classifies a cursor
 * position and computes the apply replacement for a literal `/name `
 * reference. The candidate source is the detached `HumanSkillSummary[]`
 * catalog (fed by the app), and invocation authority stays with the Host
 * `agent/pre-step` gesture — this module never loads, authorizes or
 * injects a skill body.
 *
 * Token grammar (compatible with the upstream Host gesture
 * `(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)`):
 *
 * ```text
 * name := [a-z0-9]+(?:-[a-z0-9]+)*
 * ```
 *
 * While typing, an empty or partial query is allowed (`/`, ` /e`,
 * ` /eli`, ` /html-`), but the WHOLE current token must stay inside the
 * grammar: a second `/` (`/usr/bin`), a non-name character (`/eli5。`)
 * or a non-boundary `/` (`x/eli`, `foo 5/8`) is never an inline skill
 * seat. The FIRST logical line's leading slash-command seat (line 0 with
 * only whitespace before the `/`) is deliberately NOT claimed here — the
 * existing command completion owns it.
 * @module @xmoon76/dsh-pi-tui/skill-reference-completion
 */

/** One inline skill completion seat: the `/` position and the query text
 * between the `/` and the cursor. */
export interface InlineSkillPrefix {
  /** The code-unit index of the `/` that starts the token. */
  readonly slashStart: number
  /** The text between the `/` and the cursor ('' right after the `/`). */
  readonly query: string
}

/** The token-boundary whitespace set: the same `\s` semantics as the
 * upstream Host gesture `(^|\s)\/...` and the vendored editor's
 * `isWhitespaceChar` — space, tab, newline, CR, form feed, NBSP,
 * ideographic space (`\u3000`, common in CJK text), etc. */
function isWhitespaceChar(char: string): boolean {
  return /\s/.test(char)
}

/** A valid COMPLETE skill name (the upstream Host gesture grammar
 * `[a-z0-9]+(?:-[a-z0-9]+)*` — the registry rejects anything else at
 * registration, so a catalog name is always Host-recognizable). */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** A valid IN-PROGRESS skill token: empty (just typed `/`), a complete
 * name, or a name prefix with ONE trailing hyphen (`/html-`). Anything
 * else (`/-`, `/a--`, `/--a`, a second `/`, a non-name char) can never
 * become a Host-recognizable name and is not a skill seat. */
const SKILL_TOKEN = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*(?:-)?)?$/

/**
 * Classify the cursor position as an inline skill reference seat.
 *
 * Rules (plan §5 Cut A):
 * - the current token (bounded by whitespace / line start) must START
 *   with a `/` at a token boundary — line start or after whitespace;
 * - the cursor must sit AT or AFTER the `/` (a cursor before the `/` is
 *   navigation, never a completion seat);
 * - the WHOLE token (before AND after the cursor) must be a valid
 *   in-progress skill name (empty, a complete name, or a name prefix
 *   with one trailing hyphen) — a second `/`, a non-name character or a
 *   mid-word `/` is never a skill seat;
 * - the first logical line's leading command seat (line 0, only
 *   whitespace before the `/`) is NOT an inline seat — the existing
 *   command completion owns it;
 * - the query is the text between the `/` and the cursor (the apply
 *   replaces exactly that span).
 *
 * @param lines - the editor document lines.
 * @param cursorLine - the cursor's line index.
 * @param cursorCol - the cursor's code-unit column.
 * @returns the seat, or undefined when the position is not an inline
 *   skill reference.
 */
export function extractInlineSkillPrefix(
  lines: readonly string[],
  cursorLine: number,
  cursorCol: number,
): InlineSkillPrefix | undefined {
  const line = lines[cursorLine] ?? ''
  // The current token start: scan back to the last whitespace (or line
  // start). The token is the word the cursor is inside.
  let tokenStart = cursorCol
  while (tokenStart > 0 && !isWhitespaceChar(line[tokenStart - 1] ?? '')) tokenStart -= 1
  // The token must START with `/` at a token boundary, and the cursor
  // must sit at or after the `/` (a cursor before it is navigation).
  if (line[tokenStart] !== '/' || cursorCol <= tokenStart) return undefined
  // The WHOLE token (after the `/`) must be a valid in-progress skill
  // name: scan forward to the token end and validate it as one unit.
  let tokenEnd = tokenStart + 1
  while (tokenEnd < line.length && !isWhitespaceChar(line[tokenEnd] ?? '')) tokenEnd += 1
  if (!SKILL_TOKEN.test(line.slice(tokenStart + 1, tokenEnd))) return undefined
  // The first logical line's leading command seat is not an inline seat
  // (the existing command completion owns `/name` at line start).
  if (cursorLine === 0 && line.slice(0, tokenStart).trim() === '') return undefined
  return {
    slashStart: tokenStart,
    query: line.slice(tokenStart + 1, cursorCol),
  }
}

/**
 * The apply replacement for one accepted inline skill reference: replace
 * the `/` + query span with `/name` and guarantee exactly one separator
 * whitespace after it, with the cursor on the separator position.
 *
 * Rules (plan §5 Cut C):
 * - the suffix already starts with whitespace: keep it (no double space);
 * - the suffix is empty or does not start with whitespace: insert one
 *   space;
 * - the cursor lands right after the separator, ready to keep typing.
 *
 * @param line - the current editor line.
 * @param slashStart - the `/` index of the token (from
 *   {@link extractInlineSkillPrefix}).
 * @param cursorCol - the cursor column (the end of the query span).
 * @param name - the accepted skill name.
 * @returns the new line and cursor column.
 */
export function applyInlineSkillReference(
  line: string,
  slashStart: number,
  cursorCol: number,
  name: string,
): { line: string; cursorCol: number } {
  const before = line.slice(0, slashStart)
  const after = line.slice(cursorCol)
  const firstAfter = after[0]
  const hasSeparator = firstAfter !== undefined && isWhitespaceChar(firstAfter)
  const newLine = hasSeparator
    ? `${before}/${name}${after}`
    : `${before}/${name} ${after}`
  return {
    line: newLine,
    // The separator is exactly one char in both branches: the kept
    // whitespace or the inserted space.
    cursorCol: before.length + 1 + name.length + 1,
  }
}
