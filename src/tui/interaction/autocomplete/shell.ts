/** The `!`/`!!` shell completion grammar and semantic-port adapter. */

import type { AutocompleteSuggestions } from '@xmoon76/pi-tui'
import type { HostShellCompletionPort } from '../../../runtime/host-shell-completion-port.ts'
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
  sessionId: string | undefined,
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
  const outcome = await port.complete({ sessionId, request, signal: options.signal })
  if (options.signal.aborted || outcome.kind !== 'ok') return null
  if (context.kind === 'paths') {
    const candidates = outcome.candidates.slice(0, MAX_SHELL_CANDIDATES)
    return candidates.length === 0 ? null : {
      items: candidates.map(candidate => {
        const directory = candidate.endsWith('/') || candidate.endsWith('\\')
        const value = port.pathAuthority === 'host' && context.word !== undefined
          ? hostPathLiteral(candidate, context.word, directory)
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
  return context.kind === 'command'
    ? matchesFor(context.prefix, outcome.candidates, commandWordLiteral)
    : matchesFor(context.prefix, outcome.candidates)
}
