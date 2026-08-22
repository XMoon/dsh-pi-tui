/**
 * @-file mention completion for the editor: a consumer-side wrapper over the
 * fork's CombinedAutocompleteProvider (kimi FileMentionProvider parity, so
 * the vendored fork stays pristine — AGENTS.md decision 8). With `fd` on
 * PATH, `@` completion is delegated to the fork's fd-backed whole-tree fuzzy
 * search (respects .gitignore, fans out across the workspace); without fd, a
 * bounded recursive scanner ranks candidates by basename/path affinity so
 * `@` still completes from anywhere in the tree instead of only the current
 * directory. The literal `@path` value is what gets submitted (kimi
 * semantics: the model reads the file itself).
 * @module @xmoon76/dsh-pi-tui/mentions
 */

import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@xmoon76/pi-tui'
import { shellCompletionContext, suggestShellCompletion } from './shell-completion.ts'

/** Token separators: `@` must sit at the start of the current token. */
const PATH_DELIMITERS = new Set([' ', '\t', '"', "'", '='])
/** Bounded recursive scan (kimi MAX_FALLBACK_SCAN). */
const MAX_FALLBACK_SCAN = 2000
/** Suggestion cap for the fallback (kimi MAX_FALLBACK_SUGGESTIONS). */
const MAX_FALLBACK_SUGGESTIONS = 50

/**
 * The `@` mention prefix of the text before the cursor: `@query` or
 * `@"quoted query"`, or null when the cursor is not inside a mention.
 * @param text - the line content before the cursor.
 */
export function extractAtPrefix(text: string): string | null {
  let tokenStart = 0
  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (PATH_DELIMITERS.has(text[index] ?? '')) {
      tokenStart = index + 1
      break
    }
  }
  if (text[tokenStart] !== '@') return null
  return text.slice(tokenStart)
}

/** Locate an executable `fd` on PATH (bare command names resolve through
 * PATH at spawn time; absolute/relative entries must exist and be X_OK). */
export function resolveFdPath(): string | null {
  const pathEntries = process.env.PATH?.split(':').filter(entry => entry !== '') ?? []
  for (const dir of pathEntries) {
    const candidate = join(dir, 'fd')
    try {
      accessSync(candidate, fsConstants.X_OK)
      return candidate
    } catch {
      // Not here; keep scanning.
    }
  }
  return null
}

/** One scanned candidate: relative display path + filesystem facts. */
interface FsMentionCandidate {
  readonly path: string
  readonly absolutePath: string
  readonly isDirectory: boolean
}

/** Recursively collect candidates under the workspace (bounded, `.git` skipped). */
function collectFsMentionCandidates(
  workDir: string,
  signal: AbortSignal,
): FsMentionCandidate[] {
  const candidates: FsMentionCandidate[] = []
  const stack: string[] = ['']
  let scanned = 0
  while (stack.length > 0 && scanned < MAX_FALLBACK_SCAN) {
    if (signal.aborted) break
    const relativeDir = stack.pop() ?? ''
    const absoluteDir = relativeDir === '' ? workDir : join(workDir, relativeDir)
    let entries
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (signal.aborted || scanned >= MAX_FALLBACK_SCAN) break
      if (entry.name === '.git') continue
      const relativePath = relativeDir === '' ? entry.name : join(relativeDir, entry.name)
      const absolutePath = join(absoluteDir, entry.name)
      let isDirectory = entry.isDirectory()
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(absolutePath).isDirectory()
        } catch {
          // Broken symlink or permission error — keep it as a file candidate.
        }
      }
      scanned += 1
      candidates.push({ path: relativePath, absolutePath, isDirectory })
      if (isDirectory && !entry.isSymbolicLink()) {
        stack.push(relativePath)
      }
    }
  }
  return candidates
}

/** Rank candidates against the query (kimi scoreCandidate semantics). */
function scoreCandidate(candidate: FsMentionCandidate, lowerQuery: string): number {
  if (lowerQuery === '') {
    const depthPenalty = candidate.path.split('/').length - 1
    return (candidate.isDirectory ? 120 : 100) - depthPenalty
  }
  const lowerPath = candidate.path.toLowerCase()
  const lowerBase = basename(candidate.path).toLowerCase()
  let score = 0
  if (lowerBase === lowerQuery) score = 100
  else if (lowerBase.startsWith(lowerQuery)) score = 80
  else if (lowerBase.includes(lowerQuery)) score = 50
  else if (lowerPath.includes(lowerQuery)) score = 30
  if (candidate.isDirectory && score > 0) score += 10
  return score
}

/** The completion item for one candidate: `@path` (quoted when it has
 * spaces), directories keep their trailing `/` so `@dir/` continues. */
function toMentionItem(candidate: FsMentionCandidate): AutocompleteItem {
  const valuePath = candidate.isDirectory ? `${candidate.path}/` : candidate.path
  const value = valuePath.includes(' ') ? `@"${valuePath}"` : `@${valuePath}`
  return {
    value,
    label: `${basename(candidate.path)}${candidate.isDirectory ? '/' : ''}`,
    description: candidate.absolutePath,
  }
}

/** Expand a leading `~` in one argument token (other tokens unchanged). */
function expandHomeToken(token: string): string {
  if (token === '~') return homedir()
  if (token.startsWith('~/')) return join(homedir(), token.slice(2))
  return token
}

/**
 * Slash-command PATH-argument completion (`/image <path>`): complete the
 * single argument token against the session cwd — shell-style and
 * directory-local (the fd whole-tree fuzzy search stays `@`'s job). Handles
 * `~`, absolute and relative forms and mirrors the fork's getFileSuggestions
 * display rules so a completed value always reads like what the user typed
 * (`./`, `~/` and `dir/` forms preserved); directories keep their trailing
 * `/` so Tab-accepting one continues completion. Returns null when the
 * argument is not a single completable token (embedded spaces) or the
 * directory cannot be read — the editor then shows no suggestions.
 * @param argumentText - the text after the command name (the fork passes
 *   everything up to the cursor; its argument apply replaces that whole
 *   range, so only single-token arguments can complete).
 * @param cwd - the session workspace (resolve relative forms against it).
 */
export function suggestPathArgument(argumentText: string, cwd: string): AutocompleteItem[] | null {
  const token = argumentText
  // Embedded spaces are a quoted-token case (deferred); completing a later
  // word would clobber the earlier ones, so stay quiet.
  if (token === '' || token.includes(' ') || token.includes('\t')) return null
  const expanded = expandHomeToken(token)
  const absolute = token.startsWith('~') || token.startsWith('/')
  let searchDir: string
  let searchPrefix: string
  if (
    token === './' || token === '../' || token === '~' || token === '~/' || token === '/' || token === ''
  ) {
    // Complete the whole root directory (the fork's isRootPrefix cases).
    searchDir = absolute ? expanded : join(cwd, expanded)
    searchPrefix = ''
  } else if (token.endsWith('/')) {
    // Show the directory's contents.
    searchDir = absolute ? expanded : join(cwd, expanded)
    searchPrefix = ''
  } else {
    // Split into directory + basename prefix.
    searchDir = absolute ? dirname(expanded) : join(cwd, dirname(expanded))
    searchPrefix = basename(expanded)
  }
  let entries
  try {
    entries = readdirSync(searchDir, { withFileTypes: true })
  } catch {
    return null
  }
  const items: AutocompleteItem[] = []
  for (const entry of entries) {
    if (!entry.name.toLowerCase().startsWith(searchPrefix.toLowerCase())) continue
    let isDirectory = entry.isDirectory()
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = statSync(join(searchDir, entry.name)).isDirectory()
      } catch {
        // Broken symlink or permission error — treat as a file candidate.
      }
    }
    // Mirror the fork's display construction: `dir/` appends the entry, a
    // `~/`/absolute/relative directory prefix is preserved, a bare token
    // completes within the cwd.
    const name = entry.name
    let relativePath: string
    if (token.endsWith('/')) {
      relativePath = token + name
    } else if (token.includes('/') || token.includes('\\')) {
      if (token.startsWith('~/')) {
        const dir = dirname(token.slice(2))
        relativePath = `~/${dir === '.' ? name : join(dir, name)}`
      } else if (token.startsWith('/')) {
        const dir = dirname(token)
        relativePath = dir === '/' ? `/${name}` : `${dir}/${name}`
      } else {
        relativePath = join(dirname(token), name)
        if (token.startsWith('./') && !relativePath.startsWith('./')) {
          relativePath = `./${relativePath}`
        }
      }
    } else {
      relativePath = token.startsWith('~') ? `~/${name}` : name
    }
    const pathValue = isDirectory ? `${relativePath}/` : relativePath
    // Same quoting rule as the fork's buildCompletionValue: spaces need
    // quotes so the value stays one shell word for the /image handler.
    const value = pathValue.includes(' ') ? `"${pathValue}"` : pathValue
    items.push({
      value,
      label: `${name}${isDirectory ? '/' : ''}`,
      description: join(searchDir, entry.name),
    })
  }
  if (items.length === 0) return null
  // Directories first, then alphabetically (the fork's sort order).
  items.sort((left, right) => {
    const leftIsDir = left.label.endsWith('/')
    const rightIsDir = right.label.endsWith('/')
    if (leftIsDir && !rightIsDir) return -1
    if (!leftIsDir && rightIsDir) return 1
    return left.label.localeCompare(right.label)
  })
  return items
}

/** The recursive fallback suggestion set for one `@` prefix. */
function fsMentionSuggestions(workDir: string, atPrefix: string, signal: AbortSignal): AutocompleteSuggestions | null {
  if (signal.aborted) return null
  const query = atPrefix.slice(1)
  const candidates = collectFsMentionCandidates(workDir, signal)
  if (candidates.length === 0 || signal.aborted) return null
  const lowerQuery = query.toLowerCase()
  const ranked = candidates
    .map(candidate => ({ candidate, score: scoreCandidate(candidate, lowerQuery) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      if (a.candidate.isDirectory !== b.candidate.isDirectory) {
        return a.candidate.isDirectory ? -1 : 1
      }
      return a.candidate.path.localeCompare(b.candidate.path)
    })
    .slice(0, MAX_FALLBACK_SUGGESTIONS)
    .map(entry => entry.candidate)
  if (ranked.length === 0) return null
  return { prefix: atPrefix, items: ranked.map(toMentionItem) }
}

/**
 * The editor's autocomplete provider: `@` mentions (fd-backed when fd is
 * available, recursive ranked fallback otherwise) plus the fork's usual
 * slash-command and path completion. applyCompletion always delegates to the
 * fork (its `@` branch already handles quoting and directory continuation).
 */
export class MentionProvider implements AutocompleteProvider {
  private readonly inner: CombinedAutocompleteProvider
  private readonly workDir: string
  private readonly fdPath: string | null

  constructor(
    slashCommands: readonly SlashCommand[],
    workDir: string,
    fdPath: string | null,
  ) {
    this.workDir = workDir
    this.fdPath = fdPath
    this.inner = new CombinedAutocompleteProvider([...slashCommands], workDir, fdPath)
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? ''
    const textBeforeCursor = currentLine.slice(0, cursorCol)
    const atPrefix = extractAtPrefix(textBeforeCursor)
    if (atPrefix !== null) {
      if (this.fdPath !== null) {
        try {
          return await this.inner.getSuggestions(lines, cursorLine, cursorCol, options)
        } catch {
          // fd failed to spawn: keep `@` usable through the fallback.
        }
      }
      return fsMentionSuggestions(this.workDir, atPrefix, options.signal)
    }
    // `!`/`!!` shell lines: command names, subcommands and `$VAR` names come
    // from the real-shell compgen bridge (docs/input-and-card-polish.md §1);
    // path positions fall through to the fork's fd completion below.
    const shellContext = shellCompletionContext(currentLine, cursorCol)
    if (shellContext !== undefined) {
      const suggestions = await suggestShellCompletion(shellContext, this.workDir, options)
      if (suggestions !== null) return suggestions
      // No shell suggestions (or the shell is unavailable): fall through —
      // a path position still gets the fork's file completion.
    }
    try {
      return await this.inner.getSuggestions(lines, cursorLine, cursorCol, options)
    } catch {
      return null
    }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] ?? ''
    // A shell-completion item replaces the current word only (command
    // names, subcommands, `$VAR` names all land as one plain word); the
    // `!` prefix and everything before the word stay untouched. Same
    // pattern as the fork's slash-command apply.
    if (shellCompletionContext(currentLine, cursorCol) !== undefined) {
      const before = currentLine.slice(0, cursorCol - prefix.length)
      const after = currentLine.slice(cursorCol)
      const newLine = `${before}${item.value} ${after}`
      const newLines = [...lines]
      newLines[cursorLine] = newLine
      return {
        lines: newLines,
        cursorLine,
        cursorCol: before.length + item.value.length + 1,
      }
    }
    return this.inner.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }

  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    const currentLine = lines[cursorLine] ?? ''
    const textBeforeCursor = currentLine.slice(0, cursorCol)
    // A slash-command line WITH an argument position — even a trailing-space
    // empty one (`/image `) — is a file-completion site: Tab must list the
    // cwd. The fork's check trims BOTH ends, so `/image ` reads as a bare
    // command name and Tab is silently blocked; trimStart keeps the trailing
    // space visible. A pure command name (`/image`, no space) stays blocked —
    // Tab there completes the command name, never files.
    const trimmedStart = textBeforeCursor.trimStart()
    if (trimmedStart.startsWith('/') && trimmedStart.includes(' ')) return true
    return this.inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
  }
}
