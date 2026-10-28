/**
 * The file-completion context classifier (TS8-A, moved out of the historical
 * `src/file-completion/context.ts`): the ONLY place that decides whether the
 * cursor sits in a file-completion context.
 *
 * TRIGGER GRAMMAR OWNERSHIP: the OFFICIAL shared grammar (`activeAtToken` in
 * @deepseek-ai/dsh-file-reference/grammar) accepts an `@` ONLY at the start of
 * a line or after whitespace (`/(?:^|\s)@/`). The rules below are that OFFICIAL
 * BASELINE plus FOUR INTENTIONAL TUI TRIGGER EXTENSIONS — a mention may
 * additionally sit glued to CJK text (CJK sentences glue the mention to the
 * previous character), or after a `=`, `"`, or `'` boundary
 * (`key=@src/foo`, `say "@src`, `say '@src`). The quote boundaries exist so a
 * mention can be typed inside an opening quote the editor has not closed yet.
 * These extensions only WIDEN when the terminal opens its completion dropdown;
 * they do not change the query sent to the Host (already the official form) nor
 * the mention serialization (already the official `formatFileMention`). They
 * are TUI UX policy, not the dsh official grammar — which is exactly why this
 * classifier is owned by the terminal layer and not by `domain/**`.
 *
 * File completion is allowed in exactly two contexts:
 *
 * - `mention` — an `@` token at a real token boundary (start of text, after a
 *   delimiter, or one of the documented TUI extensions above — so emails
 *   `a@b.com` and `pkg@1.0.0` never qualify);
 * - `path-argument` — the argument of a command EXPLICITLY declared as
 *   file-argument (`/attach`, `/image`; the neutral set lives in
 *   `domain/file-completion/path-argument-commands.ts`), never
 *   `getArgumentCompletions !== undefined`.
 *
 * Everywhere else (`none`) ordinary text AND ordinary paths — `./foo`,
 * `../foo`, `/tmp/foo`, `foo` — must neither naturally trigger a file
 * dropdown nor open one on Tab.
 *
 * THE COMMAND TOKEN IS POSITION-SCOPED: the seat is the LAST
 * declared command token before the cursor at a whitespace boundary, so
 * `hi /image ./a` (mid-body on the first line) and a later line's leading
 * `/attach ../f` are BOTH path arguments — while `weird/image /x`,
 * `https://host/image`, `x/image` and ordinary paths stay `none`. The `leading`
 * flag keeps the two SEATS distinct: only the FIRST logical line's leading
 * command token is the legacy slash-command seat (its Enter still follows the
 * command policy and the fork's argument apply owns its replacement); every
 * other seat is the INLINE attachment seat owned by
 * `tui/interaction/autocomplete/inline-attachment.ts`.
 * @module @xmoon76/dsh-pi-tui/tui/file-completion/context
 */

/** A half-open text range in the current line. */
export interface TextRange {
  readonly start: number
  readonly end: number
}

/**
 * One declared file-argument seat: the command token plus the argument text
 * from the first separator after the name to the cursor.
 */
export interface PathArgumentSeat {
  /** The declared command name (`image`, `attach`). */
  readonly command: string
  /** The `/` index of the command token. */
  readonly commandStart: number
  /** The argument text INCLUDING leftover separator whitespace. */
  readonly argument: string
  /** The replaced argument span (the separator is part of it). */
  readonly range: TextRange
  /** Whether this is the legacy leading command seat of the FIRST logical
   *  line (the slash command plane owns that position). */
  readonly leading: boolean
}

/**
 * The classified file-completion context at the cursor. File completion is
 * ALLOWED only in `mention` (`@...`) and `path-argument` (`/attach ...`,
 * `/image ...`) contexts — `none` means ordinary text/paths, where neither the
 * natural trigger nor Tab may open a file dropdown (kimi parity).
 */
export type FileCompletionContext =
  | {
      kind: 'mention'
      /** The raw mention prefix INCLUDING `@` (and an unclosed `"` when
       * quoted): `@src/fo`, `@"my file`. */
      query: string
      /** The replaced span in the line: [cursorCol - query.length, cursorCol). */
      range: TextRange
    }
  | (PathArgumentSeat & {
      kind: 'path-argument'
      /** The raw argument text (the same value as {@link PathArgumentSeat.argument}). */
      query: string
    })
  | { kind: 'none' }

/** Token separators: `@` must sit at the start of the current token.
 * Whitespace (incl. tab/newline) is the OFFICIAL baseline; `"`, `'` and
 * `=` are the three non-CJK INTENTIONAL TUI trigger extensions (see the
 * module header). */
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

/** The token-boundary whitespace set of a command token: the same `\s`
 * semantics the inline skill grammar uses (`/image` at a whitespace boundary,
 * never glued to a word, a URL segment or a path). */
function isWhitespaceChar(char: string): boolean {
  return /\s/.test(char)
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
  // previous character — the same CJK-glued boundary rule the `@`-mention
  // completion trigger applies).
  for (let index = token.length - 1; index >= 1; index -= 1) {
    if (token[index] === '@' && isCjkChar(token[index - 1] ?? '')) return token.slice(index)
  }
  return null
}

/**
 * The raw token + quoted flag of one `@` prefix (`@src/fo` → `src/fo`;
 * `@"my file` → `my file`; an unclosed quote stays unclosed — the ranking term
 * is the text inside the quotes).
 */
export function stripAtQuotes(atPrefix: string): { raw: string; quoted: boolean } {
  if (atPrefix.startsWith('@"')) {
    const inner = atPrefix.slice(2)
    return { raw: inner.endsWith('"') ? inner.slice(0, -1) : inner, quoted: true }
  }
  const inner = atPrefix.slice(1)
  return { raw: inner.endsWith('"') ? inner.slice(0, -1) : inner, quoted: false }
}

/**
 * Find the declared file-argument seat at the cursor: the LAST declared
 * command token before the cursor whose `/` sits at a token boundary (start of
 * text or after whitespace).
 *
 * The separator AFTER the command name is what makes a position an ARGUMENT
 * seat: `/image` (no separator yet) is the command-name seat (the inline
 * `/name` action list or the legacy line-0 command completion owns it), and a
 * LATER declared token always supersedes an earlier one, so
 * `hi /image ./a /attach` is not an `/image` argument seat.
 *
 * @param textBeforeCursor - the line content before the cursor.
 * @param pathArgumentCommands - the explicit file-argument command set
 *   (never derived from `getArgumentCompletions`).
 * @param line - the cursor's logical line index (only the FIRST line's leading
 *   token is the legacy command seat).
 * @returns the seat, or undefined when the position is not a declared
 *   file-argument position.
 */
export function pathArgumentSeat(
  textBeforeCursor: string,
  pathArgumentCommands: ReadonlySet<string>,
  line = 0,
): PathArgumentSeat | undefined {
  let last: { command: string; commandStart: number; argumentStart: number | undefined } | undefined
  for (let index = 0; index < textBeforeCursor.length; index += 1) {
    // A `/name` INSIDE a quoted token is PATH CONTENT, never a command: in
    // `look /image "my /attach file.png` the only command is `/image`, and the
    // quoted text (including the unclosed quote the user is still typing in)
    // must not be re-interpreted as a second attachment command. Skip the whole
    // quoted run so its `/` characters are never candidates.
    if (textBeforeCursor[index] === '"') {
      const close = textBeforeCursor.indexOf('"', index + 1)
      if (close === -1) {
        // Unclosed: the rest of the line is inside this token, so no later
        // `/name` can be a command seat.
        break
      }
      index = close
      continue
    }
    if (textBeforeCursor[index] !== '/') continue
    const before = index === 0 ? '' : textBeforeCursor[index - 1] ?? ''
    if (before !== '' && !isWhitespaceChar(before)) continue
    // The command-name run ends at the first separator or the next `/`
    // (`/usr/bin`, `/image/foo` are never declared command names).
    let end = index + 1
    while (end < textBeforeCursor.length) {
      const char = textBeforeCursor[end]!
      if (isWhitespaceChar(char) || char === '/') break
      end += 1
    }
    const command = textBeforeCursor.slice(index + 1, end)
    if (command === '' || !pathArgumentCommands.has(command)) continue
    // The argument is everything after the FIRST separator character after the
    // command name; a multi-space separator belongs to the argument (the fork's
    // legacy argument apply replaces the whole range, so keeping the leftover
    // whitespace in the value preserves the separator count).
    //
    // The separator MUST be whitespace: `/image/foo` and `/attach/foo` are
    // ordinary paths, not a declared command followed by an argument —
    // accepting a `/` there would turn any path segment into an attachment
    // seat.
    const separator = textBeforeCursor[end]
    if (separator !== undefined && !isWhitespaceChar(separator)) continue
    last = separator === undefined
      ? { command, commandStart: index, argumentStart: undefined }
      : { command, commandStart: index, argumentStart: end + 1 }
  }
  if (last === undefined || last.argumentStart === undefined) return undefined
  const argument = textBeforeCursor.slice(last.argumentStart)
  return {
    command: last.command,
    commandStart: last.commandStart,
    argument,
    range: { start: last.argumentStart, end: textBeforeCursor.length },
    // The legacy command seat is the FIRST logical line's LEADING token
    // (indentation included: the fork's command completion accepts it).
    leading: line === 0 && textBeforeCursor.slice(0, last.commandStart).trim() === '',
  }
}

/**
 * The argument text of a declared file-argument seat at the cursor (the
 * `pathArgumentSeat()` answer, or undefined when the position is not one).
 * @param textBeforeCursor - the line content before the cursor.
 * @param pathArgumentCommands - the explicit file-argument command set.
 */
export function pathArgumentOf(
  textBeforeCursor: string,
  pathArgumentCommands: ReadonlySet<string>,
): string | undefined {
  return pathArgumentSeat(textBeforeCursor, pathArgumentCommands)?.argument
}

/**
 * Classify the file-completion context at the cursor: exactly one of
 * `mention`, `path-argument`, or `none`.
 * @param textBeforeCursor - the line content before the cursor.
 * @param pathArgumentCommands - the EXPLICIT file-argument command set
 *   (`/attach`, `/image`; never derived from `getArgumentCompletions`).
 * @param options.line - the cursor's logical line index; only the first
 *   line's leading command token is the legacy slash-command seat.
 * @param options.shell - whether the position belongs to a SHELL document (a
 *   `!`/`!!` input mode, or a prompt-mode buffer holding the literal wire
 *   form). A shell command's own arguments are SHELL words: their text is
 *   never a Client-local attachment site, even when it literally reads
 *   `/image <path>`, because the attachment plane and the shell plane are
 *   different authorities. `!`-prefixed lines therefore classify as `none`/
 *   `mention` only, and the shell bridge keeps ownership.
 */
export function classifyFileCompletionContext(
  textBeforeCursor: string,
  pathArgumentCommands: ReadonlySet<string>,
  options: { readonly line?: number; readonly shell?: boolean } = {},
): FileCompletionContext {
  // A declared command argument owns the position. In particular,
  // `/image @foo` is still a Client-local image path, not a Host mention.
  // A SHELL position never reaches the attachment seat (see `options.shell`).
  const seat = options.shell === true
    ? undefined
    : pathArgumentSeat(textBeforeCursor, pathArgumentCommands, options.line ?? 0)
  if (seat !== undefined) return { kind: 'path-argument', query: seat.argument, ...seat }
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
