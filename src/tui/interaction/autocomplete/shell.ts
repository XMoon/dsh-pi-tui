/** The `!`/`!!` shell completion grammar and semantic-port adapter. */

import type { AutocompleteSuggestions } from '@xmoon76/pi-tui'
import type { HostShellCompletionPort } from '../../../runtime/host-shell-completion-port.ts'
import { parseShellWords } from '../../../client/shell/words.ts'

const MAX_SHELL_CANDIDATES = 50

export type ShellCompletionKind = 'command' | 'subcommand' | 'variable' | 'paths'

export interface ShellCompletionContext {
  readonly kind: ShellCompletionKind
  readonly prefix: string
  readonly priorWords: readonly string[]
}

/** Parse the editor line at the cursor for one shell-specific candidate source. */
export function shellCompletionContext(line: string, col: number): ShellCompletionContext | undefined {
  if (!line.startsWith('!')) return undefined
  const prefixLength = line.startsWith('!!') ? 2 : 1
  const before = line.slice(prefixLength, col)
  const lastSpace = Math.max(before.lastIndexOf(' '), before.lastIndexOf('\t'))
  const currentWord = before.slice(lastSpace + 1)
  const prior = lastSpace === -1 ? '' : before.slice(0, lastSpace)
  const priorWords = parseShellWords(prior)
  const isPath = currentWord.startsWith('.') || currentWord.startsWith('/') || currentWord.startsWith('~')
    || currentWord.includes('/') || currentWord.includes('\\')
  if (priorWords.length === 0) {
    return isPath
      ? { kind: 'paths', prefix: currentWord, priorWords }
      : { kind: 'command', prefix: currentWord, priorWords }
  }
  if (currentWord.startsWith('$')) return { kind: 'variable', prefix: currentWord, priorWords }
  if (isPath || (priorWords.length !== 1 || priorWords[0] !== 'git')) {
    return { kind: 'paths', prefix: currentWord, priorWords }
  }
  return { kind: 'subcommand', prefix: currentWord, priorWords }
}

function matchesFor(prefix: string, candidates: readonly string[]): AutocompleteSuggestions | null {
  const matched = (prefix === '' ? candidates : candidates.filter(candidate => candidate.startsWith(prefix)))
    .slice(0, MAX_SHELL_CANDIDATES)
  return matched.length === 0 ? null : {
    items: matched.map(value => ({ value, label: value })),
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
  const request = context.kind === 'command'
    ? { kind: 'commands' as const, prefix: context.prefix }
    : context.kind === 'variable'
      ? { kind: 'variables' as const, prefix: context.prefix.slice(1) }
      : context.kind === 'subcommand'
        ? { kind: 'subcommands' as const, command: context.priorWords[0]!, prefix: context.prefix }
        : { kind: 'paths' as const, prefix: context.prefix }
  const outcome = await port.complete({ sessionId, request, signal: options.signal })
  if (options.signal.aborted || outcome.kind !== 'ok') return null
  if (context.kind === 'paths') {
    const candidates = outcome.candidates.slice(0, MAX_SHELL_CANDIDATES)
    return candidates.length === 0 ? null : {
      items: candidates.map(value => ({ value, label: value })),
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
  return matchesFor(context.prefix, outcome.candidates)
}
