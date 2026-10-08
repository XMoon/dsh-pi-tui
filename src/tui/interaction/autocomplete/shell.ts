/**
 * Shell editor-completion grammar/adapter (TS8-E): parse a `!`/`!!` editor line
 * at the cursor into a completion context and shape the Client shell
 * candidates into the fork's suggestion batch.
 *
 * It consumes the Client-local capability (`client/shell/compgen.ts`) and the
 * shell word parser (`client/shell/words.ts`). Path positions stay with the
 * fork's fd-backed provider — the shell bridge never competes with it.
 * @module @xmoon76/dsh-pi-tui/tui/interaction/autocomplete/shell
 */

import type { AutocompleteSuggestions } from '@xmoon76/pi-tui'
import { MAX_SHELL_CANDIDATES, hasSubcommandCompletion, requestShellCandidates } from '../../../client/shell/compgen.ts'
import { parseShellWords } from '../../../client/shell/words.ts'

/** Which completion the cursor needs on a `!` line. */
export type ShellCompletionKind = 'command' | 'subcommand' | 'variable'

/** The parsed completion context at the cursor on a `!` line. */
export interface ShellCompletionContext {
  readonly kind: ShellCompletionKind
  /** The word being completed ('' when the cursor sits right after a space). */
  readonly prefix: string
  /** The parsed words BEFORE the current word (no `!` prefix). */
  readonly priorWords: readonly string[]
}

/**
 * Parse the editor line at the cursor for shell completion. Returns a
 * context only when the line is a `!`/`!!` line AND the cursor completes a
 * shell-bridge word (command name, subcommand, `$VAR`); a path position
 * returns undefined so the caller falls through to the fork's fd
 * completion — paths are not the bridge's job.
 * @param line - the full editor line.
 * @param col - the cursor column.
 */
export function shellCompletionContext(line: string, col: number): ShellCompletionContext | undefined {
  if (!line.startsWith('!')) return undefined
  const prefixLength = line.startsWith('!!') ? 2 : 1
  const before = line.slice(prefixLength, col)
  const lastSpace = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\t'))
  const currentWord = before.slice(lastSpace + 1)
  const prior = lastSpace === -1 ? '' : before.slice(0, lastSpace)
  const priorWords = parseShellWords(prior)
  if (priorWords.length === 0) {
    // The first word: a command name. An explicit path (`.`, `..`, `/`,
    // `~`) is a path, not a command — the fd provider owns it.
    if (currentWord.startsWith('.') || currentWord.startsWith('/') || currentWord.startsWith('~')) return undefined
    return { kind: 'command', prefix: currentWord, priorWords }
  }
  if (currentWord.startsWith('$')) {
    return { kind: 'variable', prefix: currentWord, priorWords }
  }
  if (priorWords.length === 1 && hasSubcommandCompletion(priorWords[0]!)) {
    return { kind: 'subcommand', prefix: currentWord, priorWords }
  }
  return undefined
}

/** Filter one candidate list to the prefix and cap it ('' prefix keeps all). */
function matchesFor(prefix: string, candidates: readonly string[]): AutocompleteSuggestions | null {
  const matched = prefix === ''
    ? candidates
    : candidates.filter(name => name.startsWith(prefix))
  if (matched.length === 0) return null
  return {
    items: matched.slice(0, MAX_SHELL_CANDIDATES).map(name => ({ value: name, label: name })),
    prefix,
  }
}

/**
 * Suggest shell completions for a parsed `!` line context. Returns null
 * when nothing matches or the shell is unavailable — the editor then shows
 * no suggestions (the caller falls through to the fork's own provider).
 * @param context - the parsed cursor context.
 * @param cwd - the session workspace (compgen runs there).
 * @param options - the editor's request options (signal; force: an empty
 *   command prefix lists the cached commands on explicit Tab, while a
 *   natural trigger with an empty prefix stays quiet).
 */
export async function suggestShellCompletion(
  context: ShellCompletionContext,
  cwd: string,
  options: { signal: AbortSignal; force?: boolean },
): Promise<AutocompleteSuggestions | null> {
  // An already-aborted request never spawns a shell (the editor's latest
  // request won this race; a stale one must stay silent).
  if (options.signal.aborted) return null
  if (context.kind === 'command') {
    // A natural trigger with an empty prefix would flash the whole command
    // list on every `!` keystroke — only explicit Tab asks for it.
    if (context.prefix === '' && options.force !== true) return null
    const commands = await requestShellCandidates({ kind: 'commands' }, cwd, options.signal)
    return matchesFor(context.prefix, commands)
  }
  if (context.kind === 'variable') {
    const names = await requestShellCandidates({ kind: 'variables', prefix: context.prefix.slice(1) }, cwd, options.signal)
    const items = names.map(name => ({ value: `$${name}`, label: `$${name}` }))
    return items.length === 0 ? null : { items, prefix: context.prefix }
  }
  // Subcommand of a known listable command: the live lister wins, the
  // static fallback covers commands/versions that cannot list themselves
  // (a failed lister is NOT a valid empty list).
  const candidates = await requestShellCandidates({ kind: 'subcommands', command: context.priorWords[0]! }, cwd, options.signal)
  return matchesFor(context.prefix, candidates)
}
