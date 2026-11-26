/**
 * The `!`/`!!` shell completion grammar and semantic-port adapter: the POSIX
 * Bash word/acceptance grammar plus the bounded Windows PowerShell
 * literal-path adaptation (single-line literal tokens only; no native
 * PowerShell grammar, command/variable engine or execution).
 */

import type { AutocompleteSuggestions } from '@xmoon76/pi-tui'
import type { HostShellCompletionPort, HostShellCompletionTarget } from '../../../runtime/host-shell-completion-port.ts'
import { parseShellWords } from '../../../client/shell/words.ts'

const MAX_SHELL_CANDIDATES = 50

export type ShellCompletionKind = 'command' | 'subcommand' | 'variable' | 'paths'

/** The lexical state of the Shell WORD the cursor sits in: its decoded bytes,
 * the quote the cursor is inside (if any) and whether that quote is already
 * closed after the cursor. */
export interface ShellWordLexicalState {
  readonly valuePrefix: string
  readonly quote: "'" | '"' | undefined
  readonly closingQuoteAfterCursor: boolean
}

export interface ShellCompletionContext {
  readonly kind: ShellCompletionKind
  /** The range/query prefix: RAW for a path position (the accepted literal
   * replaces it), SEMANTIC for command/variable/subcommand positions. */
  readonly prefix: string
  readonly priorWords: readonly string[]
  /** Present for the positions whose acceptance is quote-aware (paths and
   * variables), so the accept branch can keep/close the cursor's quote. */
  readonly word?: ShellWordLexicalState
}

/** The ONE word-delimiter rule the start and the tail scanners share: an
 * unquoted/unescaped Shell blank or control operator ends the word. */
function isShellWordDelimiter(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n'
    || character === ';' || character === '|' || character === '&'
    || character === '(' || character === ')' || character === '<' || character === '>'
}

/** The subset of the delimiters that starts a NEW COMMAND word. A redirection
 * (`<`/`>`) or a closing `)` ends a word without opening a command position;
 * `&` covers both `&&` and a background `&`, `|` covers `||`/`|&`. */
function isShellCommandSeparator(character: string): boolean {
  return character === ';' || character === '&' || character === '|' || character === '('
}

function wordAtCursor(
  line: string,
  start: number,
  col: number,
): { readonly start: number; readonly quote: "'" | '"' | undefined; readonly commandPosition: boolean } {
  let wordStart = start
  let quote: "'" | '"' | undefined
  // Whether the NEXT word would start a command segment: the line start and a
  // command separator restore it; whitespace keeps it; a word consumes it.
  let nextIsCommand = true
  // Whether the word the cursor is in started a command segment.
  let wordIsCommand = true
  const startWord = (index: number): void => {
    if (index !== wordStart) return
    wordIsCommand = nextIsCommand
    nextIsCommand = false
  }
  for (let index = start; index < col; index += 1) {
    const character = line[index]!
    if (quote === "'") {
      if (character === "'") quote = undefined
      continue
    }
    if (quote === '"') {
      if (character === '\\') {
        const next = line[index + 1]
        if (next === '"' || next === '\\' || next === '$' || next === '`') index += 1
        continue
      }
      if (character === '"') quote = undefined
      continue
    }
    if (isShellWordDelimiter(character)) {
      wordStart = index + 1
      if (isShellCommandSeparator(character)) nextIsCommand = true
      continue
    }
    if (character === '\\') {
      startWord(index)
      if (index + 1 < col) index += 1
      continue
    }
    if (character === "'" || character === '"') {
      startWord(index)
      quote = character
      continue
    }
    startWord(index)
  }
  return {
    start: wordStart,
    quote,
    // An empty current word sits at the NEXT word's position.
    commandPosition: wordStart === col ? nextIsCommand : wordIsCommand,
  }
}

function closingQuoteIndex(line: string, from: number, quote: "'" | '"'): number {
  for (let index = from; index < line.length; index += 1) {
    const character = line[index]!
    if (quote === "'") {
      if (character === "'") return index
      continue
    }
    if (character === '\\') {
      const next = line[index + 1]
      if (next === '"' || next === '\\' || next === '$' || next === '`') index += 1
      continue
    }
    if (character === '"') return index
  }
  return -1
}

function closingQuoteAfter(line: string, col: number, quote: "'" | '"' | undefined): boolean {
  return quote !== undefined && closingQuoteIndex(line, col, quote) !== -1
}

/** The raw tail of the cursor's Shell word that a whole-word acceptance
 * replaces. A closing quote for the quote the cursor is inside is KEPT: the
 * literal generated for it deliberately stops before that quote. */
export function shellWordSuffix(line: string, col: number, quote: "'" | '"' | undefined): string {
  if (quote !== undefined) {
    const closing = closingQuoteIndex(line, col, quote)
    return closing === -1 ? line.slice(col) : line.slice(col, closing)
  }
  let index = col
  let substitution = 0
  let brace = 0
  let backtick = false
  while (index < line.length) {
    const character = line[index]!
    if (backtick) {
      if (character === '`') backtick = false
      index += 1
      continue
    }
    if (character === '\\') {
      index += 2
      continue
    }
    if (character === '`') {
      backtick = true
      index += 1
      continue
    }
    if (character === '$' && line[index + 1] === '(') {
      substitution += 1
      index += 2
      continue
    }
    if (character === '$' && line[index + 1] === '{') {
      brace += 1
      index += 2
      continue
    }
    if (substitution > 0) {
      if (character === '(') substitution += 1
      else if (character === ')') substitution -= 1
      index += 1
      continue
    }
    if (brace > 0) {
      if (character === '{') brace += 1
      else if (character === '}') brace -= 1
      index += 1
      continue
    }
    if (isShellWordDelimiter(character)) break
    if (character === "'" || character === '"') {
      const closing = closingQuoteIndex(line, index + 1, character)
      if (closing === -1) return line.slice(col)
      index = closing + 1
      continue
    }
    index += 1
  }
  return line.slice(col, index)
}

/** One pending here-document: its delimiter and whether `<<-` strips tabs. */
interface PendingHeredoc {
  readonly delimiter: string
  readonly stripTabs: boolean
}

/** Parse a `<<`/`<<-` delimiter at `from`, or undefined when this is not a
 *  here-document (a `<<<` here-string, or an unparsable delimiter). */
function heredocAt(line: string, from: number): PendingHeredoc | undefined {
  if (line[from] !== '<' || line[from + 1] !== '<') return undefined
  if (line[from + 2] === '<') return undefined
  let index = from + 2
  let stripTabs = false
  if (line[index] === '-') {
    stripTabs = true
    index += 1
  }
  while (line[index] === ' ' || line[index] === '\t') index += 1
  const quote = line[index]
  if (quote === "'" || quote === '"') {
    const closing = line.indexOf(quote, index + 1)
    if (closing === -1) return undefined
    const delimiter = line.slice(index + 1, closing)
    return delimiter === '' ? undefined : { delimiter, stripTabs }
  }
  const wordStart = index
  while (index < line.length && !isShellWordDelimiter(line[index]!)) index += 1
  const delimiter = line.slice(wordStart, index)
  return delimiter === '' ? undefined : { delimiter, stripTabs }
}

/**
 * Whether the command opened by the lines BEFORE the cursor is still open.
 *
 * This is a deliberately small Bash-aware state machine, not a parser:
 * - a trailing backslash CONTINUES the same logical line into the next one; it
 *   does not open a command by itself, so `printf a \` + `  b` is complete
 *   and the next physical line is a fresh command;
 * - a `#` comment (unquoted, at a word start) ends the line and its quotes
 *   never affect the state;
 * - a here-document body (until its delimiter line) is TEXT, not commands, so
 *   the cursor inside it is not a fresh command position;
 * - an unfinished quote, backtick, `$(` or `${` stays open across lines.
 */
export function shellCommandIsOpen(lines: readonly string[]): boolean {
  let quote: "'" | '"' | undefined
  let substitution = 0
  let brace = 0
  let backtick = false
  // A here-document body starts only after the LOGICAL command line ends (an
  // unescaped physical newline). `cat <<STOP \` + `STOP` is still one command,
  // so the second `STOP` is an argument, not the body delimiter.
  const declared: PendingHeredoc[] = []
  // Bodies are consumed IN ORDER: a command may declare more than one
  // (`cat <<A <<B`), each body ending at its own exact delimiter.
  const bodies: PendingHeredoc[] = []
  // A trailing backslash on the LAST previous line makes the cursor line a
  // CONTINUATION of that command, not a fresh command position. Inside earlier
  // lines the same backslash merely joins logical lines while scanning.
  let trailingContinuation = false
  for (const line of lines) {
    trailingContinuation = false
    const active = bodies[0]
    if (active !== undefined) {
      // Bash compares the delimiter line EXACTLY: `<<-` strips leading TABs
      // only, and spaces (leading or trailing) never match.
      const candidate = active.stripTabs ? line.replace(/^\t+/u, '') : line
      if (candidate === active.delimiter) bodies.shift()
      continue
    }
    let index = 0
    while (index < line.length) {
      const character = line[index]!
      if (backtick) {
        if (character === '`') backtick = false
        index += 1
        continue
      }
      if (quote === "'") {
        if (character === "'") quote = undefined
        index += 1
        continue
      }
      if (quote === '"') {
        if (character === '\\') index += 2
        else {
          if (character === '"') quote = undefined
          index += 1
        }
        continue
      }
      if (character === '\\') {
        // A trailing backslash joins the NEXT physical line to this command.
        if (index === line.length - 1) {
          trailingContinuation = true
          break
        }
        index += 2
        continue
      }
      if (character === '#' && (index === 0 || /[\s;|&()<>]/u.test(line[index - 1]!))) break
      if (character === "'" || character === '"') {
        quote = character
        index += 1
        continue
      }
      if (character === '`') {
        backtick = true
        index += 1
        continue
      }
      if (character === '$' && line[index + 1] === '(') {
        substitution += 1
        index += 2
        continue
      }
      if (character === '$' && line[index + 1] === '{') {
        brace += 1
        index += 2
        continue
      }
      if (character === '<' && line[index + 1] === '<') {
        const parsed = heredocAt(line, index)
        if (parsed !== undefined) {
          declared.push(parsed)
          index += 2
          continue
        }
      }
      if (substitution > 0) {
        if (character === '(') substitution += 1
        else if (character === ')') substitution -= 1
        index += 1
        continue
      }
      if (brace > 0) {
        if (character === '{') brace += 1
        else if (character === '}') brace -= 1
      }
      index += 1
    }
    // The bodies begin only once this logical command line has ended.
    if (!trailingContinuation && declared.length > 0) {
      bodies.push(...declared.splice(0, declared.length))
    }
  }
  return quote !== undefined || backtick || substitution > 0 || brace > 0
    || declared.length > 0 || bodies.length > 0 || trailingContinuation
}


/**
 * The PowerShell literal-path adaptation. A PowerShell Host shell has no
 * command/variable candidate source in this version, so ONLY a clearly
 * delimited single-line literal path token may reach the Host path bridge.
 * Backslash is an ordinary filename character in PowerShell; a single-quoted
 * literal is always literal (`''` is one apostrophe); double-quoted content is
 * accepted only while it stays literal (no `$` interpolation and no backtick
 * escape anywhere in the token). Variable/subexpression/backtick/here-string/
 * mixed quoting and multi-line continuations yield no candidates at all.
 */

/** The finite quote classes recognized by PowerShell's parser
 * (`CharTraits.IsSingleQuote` / `IsDoubleQuote`). This adapter only lets an
 * ASCII quote DELIMIT a raw token; recognized smart single quotes may appear
 * as doubled literal content, exactly as the adapter itself emits them. */
const POWERSHELL_SINGLE_QUOTE_CHARACTERS = new Set(["'", '\u2018', '\u2019', '\u201A', '\u201B'])
const POWERSHELL_DOUBLE_QUOTE_CHARACTERS = new Set(['"', '\u201C', '\u201D', '\u201E'])

function isPowerShellSingleQuoteCharacter(character: string | undefined): boolean {
  return character !== undefined && POWERSHELL_SINGLE_QUOTE_CHARACTERS.has(character)
}

function isPowerShellDoubleQuoteCharacter(character: string | undefined): boolean {
  return character !== undefined && POWERSHELL_DOUBLE_QUOTE_CHARACTERS.has(character)
}

/** One bare PowerShell word delimiter; unquoted whitespace and PowerShell
 * control operators/commas end the word. */
function isPowerShellWordDelimiter(character: string): boolean {
  return character === ' ' || character === '\t' || character === '\n'
    || character === ';' || character === '|' || character === '&'
    || character === '(' || character === ')' || character === '{' || character === '}'
    || character === '<' || character === '>' || character === ','
}

/** Find the closing ASCII quote after `from`, honoring a doubled quote of the
 * SAME recognized class. A single smart delimiter is returned as the close;
 * the caller refuses it because only an ASCII delimiter is unambiguous here. */
function findPowerShellClosingQuote(line: string, from: number, quote: "'" | '"'): number {
  for (let index = from; index < line.length; index += 1) {
    const character = line[index]!
    if (quote === "'") {
      if (!isPowerShellSingleQuoteCharacter(character)) continue
      if (line[index + 1] === character) {
        index += 1
        continue
      }
      return index
    }
    if (character === '`') {
      index += 1
      continue
    }
    if (character === '"') {
      if (line[index + 1] === '"') {
        index += 1
        continue
      }
      return index
    }
    if (isPowerShellDoubleQuoteCharacter(character)) return index
  }
  return -1
}

/** The proven role of the word starting at `tokenStart` in one simple
 * single-line PowerShell command. Whitespace never creates or consumes a
 * command role; a separator or any compound prefix has no bounded role. */
type PowerShellWordRole =
  | { readonly kind: 'command' }
  | { readonly kind: 'callArgument' }
  | { readonly kind: 'argument'; readonly firstWord: string; readonly priorWords: number }
  | { readonly kind: 'unavailable' }

function powerShellWordRole(line: string, prefixLength: number, tokenStart: number): PowerShellWordRole {
  let index = prefixLength
  let firstWord = ''
  let priorWords = 0
  let current = ''
  let started = false
  let quote: "'" | '"' | undefined
  let initialCall = false
  const finish = (): void => {
    if (!started) return
    priorWords += 1
    if (firstWord === '') firstWord = current
    current = ''
    started = false
  }
  while (index < tokenStart) {
    const character = line[index]!
    if (quote === "'") {
      if (isPowerShellSingleQuoteCharacter(character)) {
        if (character !== "'" && line[index + 1] === character) {
          current += character
          index += 2
          continue
        }
        if (character !== "'") return { kind: 'unavailable' }
        quote = undefined
        index += 1
        continue
      }
      current += character
      index += 1
      continue
    }
    if (quote === '"') {
      if (character === '`' || character === '$') return { kind: 'unavailable' }
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"'
          index += 2
          continue
        }
        quote = undefined
        index += 1
        continue
      }
      if (isPowerShellDoubleQuoteCharacter(character)) return { kind: 'unavailable' }
      current += character
      index += 1
      continue
    }
    if (character === ' ' || character === '\t' || character === '\n' || character === ',') {
      finish()
      index += 1
      continue
    }
    if (character === '&') {
      if (priorWords === 0 && !started && current === '' && !initialCall
        && (index + 1 === line.length || line[index + 1] === ' ' || line[index + 1] === '\t')) {
        initialCall = true
        index += 1
        continue
      }
      return { kind: 'unavailable' }
    }
    if (character === ';' || character === '|' || character === '(' || character === ')'
      || character === '{' || character === '}' || character === '<' || character === '>') {
      return { kind: 'unavailable' }
    }
    if (character === "'" || character === '"') {
      if (started) return { kind: 'unavailable' }
      started = true
      quote = character
      index += 1
      continue
    }
    if (isPowerShellSingleQuoteCharacter(character) || isPowerShellDoubleQuoteCharacter(character)) {
      return { kind: 'unavailable' }
    }
    if (character === '`' || character === '$' || character === '#'
      || line.startsWith('--%', index)
      || ((character === '@' || character === '[') && !started)) {
      return { kind: 'unavailable' }
    }
    current += character
    started = true
    index += 1
  }
  if (quote !== undefined) return { kind: 'unavailable' }
  finish()
  if (initialCall) return priorWords === 0 ? { kind: 'callArgument' } : { kind: 'unavailable' }
  if (priorWords === 0) return { kind: 'command' }
  return { kind: 'argument', firstWord, priorWords }
}

interface PowerShellWordScan {
  readonly start: number
  readonly value: string
  readonly quote: "'" | '"' | undefined
  readonly closingQuoteAfterCursor: boolean
  /** Whether the token STARTED with a quote (its whole value is quoted). */
  readonly startedQuoted: boolean
  readonly uncertain: boolean
  readonly end: number
}

function scanPowerShellWord(line: string, prefixLength: number, col: number): PowerShellWordScan {
  let tokenStart = prefixLength
  let value = ''
  let rawLength = 0
  let quote: "'" | '"' | undefined
  let startedQuoted = false
  let closedQuote = false
  let uncertain = false
  let index = prefixLength
  while (index < col) {
    const character = line[index]!
    if (quote === "'") {
      if (isPowerShellSingleQuoteCharacter(character)) {
        if (line[index + 1] === character) {
          value += character
          rawLength += 2
          index += 2
          continue
        }
        quote = undefined
        closedQuote = true
        index += 1
        continue
      }
      value += character
      rawLength += 1
      index += 1
      continue
    }
    if (quote === '"') {
      if (character === '"') {
        if (line[index + 1] === '"') {
          value += '"'
          rawLength += 2
          index += 2
          continue
        }
        quote = undefined
        closedQuote = true
        index += 1
        continue
      }
      if (character === '`' || character === '$' || isPowerShellDoubleQuoteCharacter(character)) {
        uncertain = true
        break
      }
      value += character
      rawLength += 1
      index += 1
      continue
    }
    if (isPowerShellWordDelimiter(character)) {
      tokenStart = index + 1
      value = ''
      rawLength = 0
      quote = undefined
      startedQuoted = false
      closedQuote = false
      index += 1
      continue
    }
    if (rawLength === 0) {
      if (character === '#') {
        uncertain = true
        break
      }
      if (character === '-' && line.startsWith('--%', index)) {
        uncertain = true
        break
      }
    }
    if (character === "'" || character === '"') {
      if (rawLength > 0) {
        uncertain = true
        break
      }
      startedQuoted = true
      quote = character
      rawLength += 1
      index += 1
      continue
    }
    if (isPowerShellSingleQuoteCharacter(character) || isPowerShellDoubleQuoteCharacter(character)) {
      uncertain = true
      break
    }
    if (character === '`' || character === '$') {
      uncertain = true
      break
    }
    if ((character === '@' || character === '[') && rawLength === 0) {
      uncertain = true
      break
    }
    value += character
    rawLength += 1
    index += 1
  }
  // A quote that CLOSED before the cursor leaves the cursor outside the
  // literal word; completing there would have no trustworthy raw range.
  if (closedQuote && quote === undefined) uncertain = true
  // The caret must not split a doubled quote or a double-quote escape pair.
  if (quote === "'" && isPowerShellSingleQuoteCharacter(line[col - 1]) && line[col - 1] === line[col]) {
    uncertain = true
  }
  if (quote === '"' && (line[col - 1] === '`' || (line[col - 1] === '"' && line[col] === '"'))) {
    uncertain = true
  }
  let end = col
  if (!uncertain) {
    if (quote !== undefined) {
      const closing = findPowerShellClosingQuote(line, col, quote)
      if (closing === -1) {
        end = line.length
        // An unterminated double-quoted range is still the whole rest of the
        // line; interpolation or a backtick ANYWHERE in that replaced range is
        // unproven.
        if (quote === '"' && /[`$]/u.test(line.slice(col))) uncertain = true
      } else {
        if (quote === "'" && line[closing] !== "'") uncertain = true
        if (quote === '"' && line[closing] !== '"') uncertain = true
        const tail = line.slice(col, closing)
        if (quote === '"' && /[`$]/u.test(tail)) uncertain = true
        end = closing + 1
        // A closing quote adjacent to more unquoted text is a MIXED token;
        // replacing only the quoted part would leave a second mixed token.
        if (end < line.length && !isPowerShellWordDelimiter(line[end]!)) uncertain = true
      }
    } else {
      let tailIndex = col
      while (tailIndex < line.length) {
        const character = line[tailIndex]!
        if (isPowerShellWordDelimiter(character)) break
        if (character === '$' || character === '`' || character === "'" || character === '"'
          || isPowerShellSingleQuoteCharacter(character) || isPowerShellDoubleQuoteCharacter(character)) {
          uncertain = true
          break
        }
        tailIndex += 1
      }
      end = tailIndex
    }
  }
  const closingQuoteAfterCursor = quote !== undefined && findPowerShellClosingQuote(line, col, quote) !== -1
  return {
    start: tokenStart,
    value,
    quote,
    closingQuoteAfterCursor,
    startedQuoted,
    uncertain,
    end,
  }
}

/** Whether a decoded PowerShell token is a literal PATH word in its proven
 * role. A bare executable command position is never admitted; only an initial
 * `&` call argument or an ordinary argument may complete. */
function isPowerShellPathValue(value: string, role: PowerShellWordRole['kind'], startedQuoted: boolean): boolean {
  if (role === 'command' || role === 'unavailable') return false
  if (value === '') return role === 'argument'
  if (!startedQuoted && value.startsWith('-')) return false
  const pathShape = value === '.' || value === '..'
    || value.startsWith('.\\') || value.startsWith('./') || value.startsWith('..\\') || value.startsWith('../')
    || value.startsWith('~') || /^[A-Za-z]:[\\/]/u.test(value)
    || value.includes('\\') || value.includes('/')
  if (role === 'callArgument') return startedQuoted || pathShape
  return true
}

/** Parse one PowerShell `!`/`!!` line for a literal path position. */
export function powershellCompletionContext(line: string, col: number): ShellCompletionContext | undefined {
  if (!line.startsWith('!')) return undefined
  const prefixLength = line.startsWith('!!') ? 2 : 1
  if (col < prefixLength) return undefined
  const scan = scanPowerShellWord(line, prefixLength, col)
  if (scan.uncertain) return undefined
  const role = powerShellWordRole(line, prefixLength, scan.start)
  if (role.kind === 'unavailable') return undefined
  if (!isPowerShellPathValue(scan.value, role.kind, scan.startedQuoted)) return undefined
  // The first argument after `git` is a subcommand position, which this
  // adapter does not source. It must stay unavailable, never fall back to
  // Host path candidates.
  if (role.kind === 'argument' && /^git$/iu.test(role.firstWord) && role.priorWords === 1) return undefined
  return {
    kind: 'paths',
    prefix: line.slice(scan.start, col),
    priorWords: [],
    word: {
      valuePrefix: scan.value,
      quote: scan.quote,
      closingQuoteAfterCursor: scan.closingQuoteAfterCursor,
    },
  }
}

/** The RAW range one PowerShell literal-path acceptance replaces: the whole
 * current token, including a closing quote after the cursor. */
export function powershellWordRange(line: string, prefixLength: number, col: number): { readonly start: number; readonly end: number } | undefined {
  const scan = scanPowerShellWord(line, prefixLength, col)
  if (scan.uncertain) return undefined
  const role = powerShellWordRole(line, prefixLength, scan.start)
  if (role.kind === 'unavailable') return undefined
  return { start: scan.start, end: scan.end }
}

/** Encode one literal path as a PowerShell single-quoted literal. Every
 * single-quote character in the official class is a delimiter; doubling the
 * ORIGINAL character makes it literal content. Double-quote class characters
 * are plain content inside this single-quoted literal. */
export function powershellPathLiteral(value: string): string {
  return `'${value.replace(/['\u2018\u2019\u201A\u201B]/gu, quote => `${quote}${quote}`)}'`
}

/** The RAW range a WHOLE-WORD acceptance replaces: the raw word start, and the
 * raw word end. A closing quote the cursor is inside is part of the range (the
 * accepted literal stops before it, so keeping it would leave `""`); otherwise
 * the range ends where the word's tail ends. The command/subcommand query is
 * the DECODED word, whose length can differ from this raw range (`zo\ s`), so
 * the query prefix alone can never locate the replaced bytes. */
export function shellWordRange(
  line: string,
  prefixLength: number,
  col: number,
): { readonly start: number; readonly end: number } {
  const token = wordAtCursor(line, prefixLength, col)
  if (token.quote !== undefined) {
    const closing = closingQuoteIndex(line, col, token.quote)
    if (closing !== -1) return { start: token.start, end: closing + 1 }
  }
  return { start: token.start, end: col + shellWordSuffix(line, col, token.quote).length }
}

/** Parse the editor line at the cursor for one shell-specific candidate source. */
export function shellCompletionContext(line: string, col: number): ShellCompletionContext | undefined {
  if (!line.startsWith('!')) return undefined
  const prefixLength = line.startsWith('!!') ? 2 : 1
  const token = wordAtCursor(line, prefixLength, col)
  const rawPrefix = line.slice(token.start, col)
  const valuePrefix = parseShellWords(rawPrefix)[0] ?? ''
  const priorWords = parseShellWords(line.slice(prefixLength, token.start))
  const word: ShellWordLexicalState = {
    valuePrefix,
    quote: token.quote,
    closingQuoteAfterCursor: closingQuoteAfter(line, col, token.quote),
  }
  const isPath = valuePrefix.startsWith('.') || valuePrefix.startsWith('/') || valuePrefix.startsWith('~')
    || valuePrefix.includes('/') || valuePrefix.includes('\\')
  // A command position is the line start or the first word after a top-level
  // separator (`;`, `&&`, `||`, `|`, `&`, `(`); a path there stays a path.
  if (token.commandPosition) {
    return isPath
      ? { kind: 'paths', prefix: rawPrefix, priorWords, word }
      : { kind: 'command', prefix: valuePrefix, priorWords }
  }
  // A `$VAR` word is queried by its DECODED name, so a quoted token
  // (`!echo "$HO`) completes like an unquoted one.
  if (valuePrefix.startsWith('$')) return { kind: 'variable', prefix: valuePrefix, priorWords, word }
  if (isPath || (priorWords.length !== 1 || priorWords[0] !== 'git')) {
    return { kind: 'paths', prefix: rawPrefix, priorWords, word }
  }
  return { kind: 'subcommand', prefix: valuePrefix, priorWords }
}

function singleQuotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function unquotedPathLiteral(value: string, expandHome: boolean): string {
  if (!expandHome || !value.startsWith('~/')) return singleQuotedLiteral(value)
  const suffix = value.slice(2)
  return `~/${suffix === '' ? '' : singleQuotedLiteral(suffix)}`
}

function hostPathLiteral(value: string, word: ShellWordLexicalState, directory: boolean): string {
  if (word.quote === undefined) {
    const expandsHome = word.valuePrefix === '~' || word.valuePrefix.startsWith('~/')
    return unquotedPathLiteral(value, expandsHome)
  }
  const close = !word.closingQuoteAfterCursor && !directory
  if (word.quote === "'") return `'${value.replaceAll("'", "'\\''")}${close ? "'" : ''}`
  const escaped = value.replace(/[\\"$`]/gu, character => `\\${character}`)
  return `"${escaped}${close ? '"' : ''}`
}

/** The unquoted characters a Bash command word can carry without escaping:
 * everything else is backslash-escaped so a command NAME is inserted as one
 * word instead of being re-parsed as shell source. */
const SAFE_COMMAND_WORD_CHARACTER = /^[A-Za-z0-9_@%+=:,./-]$/u

/** Encode one `compgen -A command` name as ONE Bash-safe executable word. */
function commandWordLiteral(name: string): string {
  let word = ''
  for (const character of name) {
    word += SAFE_COMMAND_WORD_CHARACTER.test(character) ? character : `\\${character}`
  }
  return word
}

function matchesFor(
  prefix: string,
  candidates: readonly string[],
  encode: (candidate: string) => string = candidate => candidate,
): AutocompleteSuggestions | null {
  const matched = (prefix === '' ? candidates : candidates.filter(candidate => candidate.startsWith(prefix)))
    .slice(0, MAX_SHELL_CANDIDATES)
  return matched.length === 0 ? null : {
    items: matched.map(candidate => ({ value: encode(candidate), label: candidate })),
    prefix,
  }
}

/** Query only the selected Host/Direct adapter; Remote never uses local path fallback here. */
export async function suggestShellCompletion(
  context: ShellCompletionContext,
  port: HostShellCompletionPort,
  target: HostShellCompletionTarget,
  options: { readonly signal: AbortSignal; readonly force?: boolean },
): Promise<AutocompleteSuggestions | null> {
  if (options.signal.aborted) return null
  if (context.kind === 'command' && context.prefix === '' && options.force !== true) return null
  const pathPrefix = context.kind === 'paths' ? context.word?.valuePrefix ?? context.prefix : context.prefix
  const hostPathPrefix = context.kind === 'paths'
    && context.word?.quote !== undefined
    && pathPrefix.startsWith('~')
    ? `./${pathPrefix}`
    : pathPrefix
  const request = context.kind === 'command'
    ? { kind: 'commands' as const, prefix: context.prefix }
    : context.kind === 'variable'
      ? { kind: 'variables' as const, prefix: context.prefix.slice(1) }
      : context.kind === 'subcommand'
        ? { kind: 'subcommands' as const, command: context.priorWords[0]!, prefix: context.prefix }
        : { kind: 'paths' as const, prefix: hostPathPrefix }
  const outcome = await port.complete({ target, request, signal: options.signal })
  if (options.signal.aborted || outcome.kind !== 'ok') return null
  if (context.kind === 'paths') {
    const candidates = outcome.candidates.slice(0, MAX_SHELL_CANDIDATES)
    return candidates.length === 0 ? null : {
      items: candidates.map(candidate => {
        const directory = candidate.endsWith('/') || candidate.endsWith('\\')
        const value = port.pathAuthority === 'host' && context.word !== undefined
          ? port.pathLiteralDialect === 'powershell'
            ? powershellPathLiteral(candidate)
            : hostPathLiteral(candidate, context.word, directory)
          : candidate
        return { value, label: candidate }
      }),
      prefix: context.prefix,
    }
  }
  if (context.kind === 'variable') {
    const names = context.prefix.slice(1)
    const matched = outcome.candidates
      .filter(name => names === '' || name.startsWith(names))
      .slice(0, MAX_SHELL_CANDIDATES)
      .map(name => ({ value: `$${name}`, label: `$${name}` }))
    return matched.length === 0 ? null : { items: matched, prefix: context.prefix }
  }
  // A command NAME and a git SUBCOMMAND are both inserted at a command-word
  // position: a produced name (compgen / `git --list-cmds`) is untrusted text
  // and must become one Bash-safe word exactly like a command name.
  return context.kind === 'command' || context.kind === 'subcommand'
    ? matchesFor(context.prefix, outcome.candidates, commandWordLiteral)
    : matchesFor(context.prefix, outcome.candidates)
}
