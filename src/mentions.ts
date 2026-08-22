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
import { basename, dirname, isAbsolute, join, win32 } from 'node:path'
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
 * Pure token → search-dir/prefix resolution (no filesystem access): which
 * directory a completion token reads and what basename prefix it filters.
 * Exported so the POSIX and Windows ROOT semantics are pinned without
 * touching the fs — `dirname` leaves a trailing separator ONLY on roots,
 * and a root must stay a root (`/` stripped would read `''`; a drive root
 * keeps its trailing separator while the drive-relative form drops it; a
 * UNC share keeps its legal trailing form).
 * @param token - the parsed argument token (no leading separator
 *   whitespace).
 * @param cwd - the session workspace (relative forms resolve against it).
 * @param expanded - `expandHomeToken(token)` (the caller already computed
 *   it; kept as a param so the fs-free contract stays pure).
 * @returns the readdir target, the basename prefix, and whether the token
 *   is genuinely Windows-dialect (the caller's display math needs it).
 */
export function resolvePathSearch(
  token: string,
  cwd: string,
  expanded: string,
): { searchDir: string; searchPrefix: string; winAbsolute: boolean } {
  // Absolute detection covers every platform form: POSIX `/x`, Windows
  // drive (`C:\x`, `C:/x`) and UNC (`\\server\share`) paths. The win32
  // check engages ONLY for genuinely Windows-dialect tokens — win32 alone
  // would also accept a bare POSIX `/x` token, which must keep the POSIX
  // dialect (its dirname/join use backslashes).
  const posixAbsolute = isAbsolute(expanded)
  const winAbsolute = !posixAbsolute && win32.isAbsolute(expanded)
  const absolute = token.startsWith('~') || posixAbsolute || winAbsolute
  const pathDirname = winAbsolute ? win32.dirname : dirname
  const pathBasename = winAbsolute ? win32.basename : basename
  if (
    token === './' || token === '../' || token === '~' || token === '~/' || token === '/' || token === ''
  ) {
    // Complete the whole root directory (the fork's isRootPrefix cases).
    return { searchDir: absolute ? expanded : join(cwd, expanded), searchPrefix: '', winAbsolute }
  }
  if (token.endsWith('/') || token.endsWith('\\')) {
    // Show the directory's contents (a Windows path ends with `\`).
    return { searchDir: absolute ? expanded : join(cwd, expanded), searchPrefix: '', winAbsolute }
  }
  // Split into directory + basename prefix. dirname leaves a trailing
  // separator ONLY on roots — which must keep it (see the doc comment) —
  // so the dirname result is used verbatim, never stripped.
  return {
    searchDir: absolute ? pathDirname(expanded) : join(cwd, dirname(expanded)),
    searchPrefix: pathBasename(expanded),
    winAbsolute,
  }
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
  // Leading whitespace belongs to the SEPARATOR, not the token: the fork's
  // argument branch passes everything after the FIRST space, so a
  // multi-space separator (`/image    t.png` — the fork also normalizes
  // tabs to four spaces, so a pasted-tab draft reads exactly like this)
  // yields an argument with leading spaces. The completed VALUE keeps that
  // leading whitespace, because the fork's apply replaces the WHOLE
  // argument range — without the padding the path would glue to the
  // command (`/image` + `subdir/` → `/imagesubdir/`).
  const leading = token.match(/^[ \t]+/)?.[0] ?? ''
  const parsed = token.slice(leading.length)
  // Embedded spaces are a quoted-token case (deferred); completing a later
  // word would clobber the earlier ones, so stay quiet.
  if (parsed === '' || parsed.includes(' ') || parsed.includes('\t')) return null
  const expanded = expandHomeToken(parsed)
  const { searchDir, searchPrefix, winAbsolute } = resolvePathSearch(parsed, cwd, expanded)
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
        isDirectory = statSync(winAbsolute ? win32.join(searchDir, entry.name) : join(searchDir, entry.name)).isDirectory()
      } catch {
        // Broken symlink or permission error — treat as a file candidate.
      }
    }
    // Mirror the fork's display construction: `dir/` appends the entry, a
    // `~/`/absolute/relative directory prefix is preserved, a bare token
    // completes within the cwd. Windows drive/UNC tokens keep their own
    // `\` dialect (win32 math), so the completed value reads like what the
    // user typed on Windows.
    const name = entry.name
    let relativePath: string
    if (parsed.endsWith('/') || parsed.endsWith('\\')) {
      relativePath = parsed + name
    } else if (winAbsolute) {
      relativePath = win32.join(win32.dirname(parsed), name)
    } else if (parsed.includes('/') || parsed.includes('\\')) {
      if (parsed.startsWith('~/')) {
        const dir = dirname(parsed.slice(2))
        relativePath = `~/${dir === '.' ? name : join(dir, name)}`
      } else if (parsed.startsWith('/')) {
        const dir = dirname(parsed)
        relativePath = dir === '/' ? `/${name}` : `${dir}/${name}`
      } else {
        relativePath = join(dirname(parsed), name)
        if (parsed.startsWith('./') && !relativePath.startsWith('./')) {
          relativePath = `./${relativePath}`
        }
      }
    } else {
      relativePath = parsed.startsWith('~') ? `~/${name}` : name
    }
    const pathValue = isDirectory ? `${relativePath}/` : relativePath
    // Same quoting rule as the fork's buildCompletionValue: spaces need
    // quotes so the value stays one shell word for the /image handler. The
    // separator's leading whitespace rides in front of the quoted value.
    const value = leading + (pathValue.includes(' ') ? `"${pathValue}"` : pathValue)
    items.push({
      value,
      label: `${name}${isDirectory ? '/' : ''}`,
      description: winAbsolute ? win32.join(searchDir, entry.name) : join(searchDir, entry.name),
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
  /** The slash commands whose argument completion is a PATH (the host
   * attaches `getArgumentCompletions`, e.g. `/image`): ONLY these tolerate
   * a trailing-space argument as a Tab file-completion site — every other
   * command keeps the fork's judgment. */
  private readonly pathArgumentCommands: ReadonlySet<string>

  constructor(
    slashCommands: readonly SlashCommand[],
    workDir: string,
    fdPath: string | null,
  ) {
    this.workDir = workDir
    this.fdPath = fdPath
    this.inner = new CombinedAutocompleteProvider([...slashCommands], workDir, fdPath)
    this.pathArgumentCommands = new Set(
      slashCommands
        .filter(command => command.getArgumentCompletions !== undefined)
        .map(command => command.name),
    )
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
    // A PATH-ARGUMENT command's argument position — even a trailing-space
    // or trailing-TAB empty one (`/image `, `/image<TAB>`) — is a
    // file-completion site: Tab must list the cwd. The fork's check trims
    // BOTH ends, so a trailing separator reads as a bare command name and
    // Tab is silently blocked; trimStart keeps the separator visible and
    // the argument position is detected on ANY whitespace (space or tab —
    // the fork's own path delimiters). ONLY commands that declare
    // path-argument completion get this override — a trailing `/help ` or
    // `/help<TAB>` keeps the fork's judgment (command completion, never a
    // file list). A pure command name (`/image`, no separator) stays
    // blocked — Tab there completes the command name, never files.
    const trimmedStart = textBeforeCursor.trimStart()
    if (trimmedStart.startsWith('/')) {
      const separatorIndex = trimmedStart.search(/[ \t]/)
      if (separatorIndex > 0) {
        const commandName = trimmedStart.slice(1, separatorIndex)
        if (this.pathArgumentCommands.has(commandName)) return true
      }
    }
    return this.inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
  }
}
