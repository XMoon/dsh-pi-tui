/**
 * The file-completion context classifier (plan §4): the ONLY place that
 * decides whether the cursor sits in a file-completion context. File
 * completion is allowed in exactly two contexts:
 *
 * - `mention` — an `@` token at a real token boundary (start of text, after
 *   a delimiter, or glued to CJK text — so emails `a@b.com` and `pkg@1.0.0`
 *   never qualify);
 * - `image-argument` — the argument of a command EXPLICITLY declared as
 *   file-argument (`/image`), never `getArgumentCompletions !== undefined`
 *   (plan §4.2: file commands must be explicit).
 *
 * Everywhere else (`none`) ordinary text AND ordinary paths — `./foo`,
 * `../foo`, `/tmp/foo`, `foo` — must neither naturally trigger a file
 * dropdown nor open one on Tab.
 * @module @xmoon76/dsh-pi-tui/file-completion/context
 */

import type { FileCompletionContext } from './types.ts'

/** The EXPLICIT file-argument command set (plan §4.2 — never derived from
 * `getArgumentCompletions !== undefined`): ONLY these command names make
 * their argument position a file-completion context. `image` today; a new
 * path-argument command must be added here AND get the matching
 * getArgumentCompletions wiring. */
export const FILE_ARGUMENT_COMMANDS: ReadonlySet<string> = new Set(['image'])

/** Token separators: `@` must sit at the start of the current token. */
const PATH_DELIMITERS = new Set([' ', '\t', '\n', '\r', '"', "'", '='])

/** Whether the char is CJK (ideographs, kana, hangul, CJK punctuation,
 * full-width forms): a mention may sit DIRECTLY against CJK text without
 * a delimiter — CJK sentences glue the mention to the previous character —
 * while ASCII words keep the strict boundary rule (emails, `pkg@1.0.0`). */
export function isCjkChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (code >= 0x3000 && code <= 0x303f) // CJK punctuation
    || (code >= 0x3040 && code <= 0x30ff) // hiragana + katakana
    || (code >= 0x3400 && code <= 0x4dbf) // CJK extension A
    || (code >= 0x4e00 && code <= 0x9fff) // CJK unified ideographs
    || (code >= 0xac00 && code <= 0xd7af) // hangul
    || (code >= 0xf900 && code <= 0xfaff) // compatibility ideographs
    || (code >= 0xff00 && code <= 0xffef) // full-width forms
}

/** The position of an UNCLOSED `"` (null when every quote is closed):
 * the completion cursor sits inside a quoted token exactly when a quote
 * is open at the end of the text. */
function findUnclosedQuote(text: string): number | null {
  let inQuotes = false
  let quoteStart = -1
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '"') {
      inQuotes = !inQuotes
      if (inQuotes) quoteStart = index
    }
  }
  return inQuotes ? quoteStart : null
}

/**
 * The `@` mention prefix of the text before the cursor: `@query`,
 * `@"quoted query"` (the unclosed quoted form), or null when the cursor
 * is not inside a mention. Token grammar: `@` must sit at a token
 * boundary — start-of-text, after a delimiter, or glued to CJK text — so
 * emails (`a@b.com`) and `pkg@1.0.0` are never mentions.
 * @param text - the line content before the cursor.
 */
export function extractAtPrefix(text: string): string | null {
  // Quoted form: an unclosed `"` immediately after an `@` whose own
  // position is a valid token start (`@"my file` while typing inside the
  // quotes).
  const quoteStart = findUnclosedQuote(text)
  if (quoteStart !== null && text[quoteStart - 1] === '@') {
    const at = quoteStart - 1
    const before = at === 0 ? '' : text[at - 1] ?? ''
    if (before === '' || PATH_DELIMITERS.has(before) || isCjkChar(before)) return text.slice(at)
  }
  // Bare form: the current token (after the last delimiter)...
  let tokenStart = 0
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (PATH_DELIMITERS.has(text[index] ?? '')) {
      tokenStart = index + 1
      break
    }
  }
  const token = text.slice(tokenStart)
  if (token.startsWith('@')) return token
  // ...or a CJK-glued `@` INSIDE the token (the character right before the
  // `@` is a CJK code point, e.g. `\u770b\u770b@foo`): the LAST such `@`
  // is the mention start (a CJK sentence glues the mention to the
  // previous character — the same rule findFileMentions applies).
  for (let index = token.length - 1; index >= 1; index -= 1) {
    if (token[index] === '@' && isCjkChar(token[index - 1] ?? '')) return token.slice(index)
  }
  return null
}

/** The whitespace separator between a slash command name and its argument
 * (the fork's argument branch passes everything after the FIRST space). */
const SLASH_SEPARATOR = /[ \t]/

/**
 * Whether the text before the cursor is the ARGUMENT of a named command
 * that is explicitly declared as file-argument completable.
 * @param textBeforeCursor - the line content before the cursor.
 * @param pathArgumentCommands - the explicit file-argument command set
 *   (plan §4.2 — never derived from `getArgumentCompletions`).
 * @returns the argument text (INCLUDING leftover separator whitespace, so
 *   a multi-space separator survives the fork's whole-range apply), or
 *   undefined when the position is not a declared file-argument position.
 */
export function imageArgumentOf(
  textBeforeCursor: string,
  pathArgumentCommands: ReadonlySet<string>,
): string | undefined {
  const trimmedStart = textBeforeCursor.trimStart()
  if (!trimmedStart.startsWith('/')) return undefined
  const separatorIndex = trimmedStart.search(SLASH_SEPARATOR)
  if (separatorIndex <= 0) return undefined
  const commandName = trimmedStart.slice(1, separatorIndex)
  if (!pathArgumentCommands.has(commandName)) return undefined
  // The argument is everything after the FIRST separator character AFTER
  // THE COMMAND NAME — i.e. on the TRIMMED string, then translated back to
  // the ORIGINAL line (leading whitespace before `/image` is indentation,
  // not a separator; searching the original string for the first
  // whitespace would match that indentation and fail the <= 0 guard).
  // The fork's combined provider hands the argument branch the same slice
  // (textBeforeCursor.slice(spaceIndex + 1)), so leading separator
  // whitespace belongs to the ARGUMENT and the completed value keeps it.
  const trimOffset = textBeforeCursor.length - textBeforeCursor.trimStart().length
  const originalSeparator = trimOffset + separatorIndex
  return textBeforeCursor.slice(originalSeparator + 1)
}

/**
 * Classify the file-completion context at the cursor (plan §4.1): exactly
 * one of `mention`, `image-argument`, or `none`.
 * @param textBeforeCursor - the line content before the cursor.
 * @param pathArgumentCommands - the EXPLICIT file-argument command set
 *   (`/image` today; never derived from `getArgumentCompletions`).
 */
export function classifyFileCompletionContext(
  textBeforeCursor: string,
  pathArgumentCommands: ReadonlySet<string>,
): FileCompletionContext {
  // A declared command argument owns the whole command line. In particular,
  // `/image @foo` is still a Client-local image path, not a Host mention.
  const argument = imageArgumentOf(textBeforeCursor, pathArgumentCommands)
  if (argument !== undefined) {
    return {
      kind: 'image-argument',
      query: argument,
      range: { start: textBeforeCursor.length - argument.length, end: textBeforeCursor.length },
    }
  }
  const atPrefix = extractAtPrefix(textBeforeCursor)
  if (atPrefix !== null) {
    return {
      kind: 'mention',
      query: atPrefix,
      range: { start: textBeforeCursor.length - atPrefix.length, end: textBeforeCursor.length },
    }
  }
  return { kind: 'none' }
}
