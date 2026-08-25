/**
 * @-file mention grammar and editor completion for the editor: the pure
 * Client-local side of the `@`-mention surface (migration M1.10). The
 * HOST filesystem operations (fd discovery, the recursive fallback scan,
 * existence probes) live in `src/runtime/direct/host-file-direct.ts` —
 * this module never assumes the Host filesystem IS the current Node
 * process filesystem. The editor's MentionProvider consumes the
 * `HostFilePort` seam; slash-command and path-argument completion keep
 * the fork's CombinedAutocompleteProvider (client-local editor
 * machinery).
 * @module @xmoon76/dsh-pi-tui/mentions
 */

import { readdirSync, statSync } from 'node:fs'
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
import { shellPrefixForMode, type EditorInputMode } from './editor-input-mode.ts'

/** Token separators: `@` must sit at the start of the current token. */
const PATH_DELIMITERS = new Set([' ', '\t', '"', "'", '='])
/** Trailing punctuation allowed AFTER an unquoted mention token: stripped
 * for the existence probe but KEPT in the rewritten text, so a sentence
 * like "see @src/foo.ts, then…" still canonicalizes. The set covers ASCII
 * sentence punctuation plus the CJK full-width forms. */
const MENTION_TRAILING_PUNCTUATION = new Set([
  '.', ',', ';', ':', '!', '?', ')', ']', '}',
  '。', '，', '；', '：', '！', '？', '）', '】', '》',
])
/** CJK punctuation that ENDS an unquoted mention token: CJK sentences
 * rarely put a space after a mention ("see @src/foo.ts,then..."), and paths
 * virtually never contain these characters — stopping the token there
 * keeps the mention canonical while the CJK punctuation stays as text. */
const CJK_MENTION_ENDERS = new Set([
  '，', '。', '；', '：', '！', '？', '、', '）', '】', '》', '」', '』', '…',
])

/** Whether the char is CJK (ideographs, kana, hangul, CJK punctuation,
 * full-width forms): a mention may sit DIRECTLY against CJK text without
 * a delimiter — CJK sentences glue the mention to the previous character
 * — while ASCII words keep the strict boundary rule (emails,
 * `pkg@1.0.0`). */
function isCjkChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (code >= 0x3000 && code <= 0x303f) // CJK punctuation
    || (code >= 0x3040 && code <= 0x30ff) // hiragana + katakana
    || (code >= 0x3400 && code <= 0x4dbf) // CJK extension A
    || (code >= 0x4e00 && code <= 0x9fff) // CJK unified ideographs
    || (code >= 0xac00 && code <= 0xd7af) // hangul
    || (code >= 0xf900 && code <= 0xfaff) // compatibility ideographs
    || (code >= 0xff00 && code <= 0xffef) // full-width forms
}
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

/** One `@`-mention token found in a draft. */
export interface FileMentionOccurrence {
  /** Token start (the `@` itself). */
  readonly start: number
  /** Token end (exclusive; the closing quote for quoted mentions). */
  readonly end: number
  /** The mention path WITHOUT the `@` (quotes stripped). */
  readonly path: string
  /** Whether the path was quoted (`@"…"`). */
  readonly quoted: boolean
}

/**
 * Find every `@`-file mention token in a draft. The token grammar mirrors
 * the editor's mention completion (PATH_DELIMITERS): `@` must sit at a
 * token boundary — start-of-text or after a delimiter — so emails
 * (`a@b.com`) and `pkg@1.0.0` are never treated as mentions. Two forms:
 * the bare token (`@src/foo.ts`, runs to the next delimiter) and the
 * quoted token (`@"dir with spaces/foo.ts"`, closed by a `"`). Trailing
 * sentence punctuation is stripped from the PATH (kept in the source text
 * by the caller's range replacement).
 * @param text - the draft text.
 */
export function findFileMentions(text: string): FileMentionOccurrence[] {
  const mentions: FileMentionOccurrence[] = []
  let index = 0
  while (index < text.length) {
    const at = text.indexOf('@', index)
    if (at === -1) break
    const before = at === 0 ? '' : text[at - 1] ?? ''
    // The token-start rule: `@` must follow start-of-text, a delimiter,
    // or CJK text (CJK sentences glue the mention to the previous
    // character). Emails (`a@b.com`) and `pkg@1.0.0` never qualify.
    if (!(at === 0 || PATH_DELIMITERS.has(before) || isCjkChar(before))) {
      index = at + 1
      continue
    }
    let cursor = at + 1
    let quoted = false
    let pathStart = cursor
    let pathEnd = cursor
    if (text[cursor] === '"') {
      quoted = true
      cursor += 1
      pathStart = cursor
      const close = text.indexOf('"', cursor)
      if (close === -1) break // unterminated quote: nothing after it can parse
      pathEnd = close
      // The token range INCLUDES the closing quote (the rewriter replaces
      // [start, end) and supplies its own quotes).
      cursor = close + 1
    } else {
      while (cursor < text.length
        && !PATH_DELIMITERS.has(text[cursor] ?? '')
        && !CJK_MENTION_ENDERS.has(text[cursor] ?? '')) cursor += 1
      pathEnd = cursor
    }
    let path = text.slice(pathStart, pathEnd)
    while (path.length > 0 && MENTION_TRAILING_PUNCTUATION.has(path[path.length - 1] ?? '')) {
      path = path.slice(0, -1)
    }
    if (path !== '') {
      mentions.push({
        start: at,
        // Unquoted: the span ends where the STRIPPED path ends, so the
        // stripped punctuation stays in the source text (`@file.ts,` →
        // `@/abs/file.ts` + `,`); the rewriter supplies its own quotes for
        // the quoted form, so there the full span (closing quote included)
        // is replaced.
        end: quoted ? cursor : pathStart + path.length,
        path,
        quoted,
      })
    }
    // After a QUOTED token the cursor sits on the char right after the
    // closing quote — it may be another `@` (`@"a.txt"@b.txt`), so resume
    // AT the cursor; an unquoted token ends ON a delimiter, which can be
    // skipped (round-2 review finding).
    index = quoted ? cursor : cursor + 1
  }
  return mentions
}

/**
 * Resolve ONE raw mention path to the candidate absolute path: `~`
 * expands through the homedir, an absolute path stays as-is, a relative
 * path resolves against the session workspace. PURE — the existence
 * probe is injected (migration M1.10).
 * @param raw - the mention path (quotes stripped).
 * @param sessionCwd - the session's working directory.
 * @returns the candidate absolute path.
 */
export function resolveMentionCandidate(raw: string, sessionCwd: string): string {
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  if (isAbsolute(raw)) return raw
  return join(sessionCwd, raw)
}

/** The injected existence probe (Host-owned): the Direct adapter backs it
 * with the Host filesystem; a Remote adapter backs it with the official
 * fileReferences capability. */
export type MentionExistence = (candidate: string) => boolean | Promise<boolean>

/**
 * Send-time canonicalization of `@`-file mentions (the 2026-08-22 plan,
 * item 7): the EDITOR keeps showing the concise relative form the user
 * typed, but the MODEL-facing message carries the unambiguous absolute
 * path, so a weaker model does not have to guess which workspace
 * `@src/foo.ts` lives in. Rules: a relative path resolves against
 * `sessionCwd`; `~` expands through the homedir; an absolute path stays
 * as-is; a path that does NOT exist is left VERBATIM (typos and non-path
 * `@` words are never mangled); symlinks are absolutized, never
 * realpath'd — the user's link path is the intent. Quoted mentions keep
 * their quotes in the rewritten text. The EXISTENCE probe is injected —
 * this module never touches the filesystem itself (migration M1.10).
 * @param text - the draft text.
 * @param sessionCwd - the session's working directory (the resolution
 *   base for relative mentions).
 * @param exists - the Host existence probe.
 * @returns the canonicalized text (unchanged when no mention resolves).
 */
export async function expandFileMentionsForSubmit(
  text: string,
  sessionCwd: string,
  exists: MentionExistence,
): Promise<string> {
  const mentions = findFileMentions(text)
  if (mentions.length === 0) return text
  let out = ''
  let cursor = 0
  for (const mention of mentions) {
    const candidate = resolveMentionCandidate(mention.path, sessionCwd)
    const rewritten = await exists(candidate)
      ? (mention.quoted ? `@"${candidate}"` : `@${candidate}`)
      : text.slice(mention.start, mention.end)
    out += text.slice(cursor, mention.start) + rewritten
    cursor = mention.end
  }
  out += text.slice(cursor)
  return out
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

/** The Host-file discovery seam the editor completion consumes (the
 * `HostFilePort` subset — migration M1.10): `@` mentions complete against
 * the HOST filesystem through the port, never the local fs. */
export type HostReferencesSeam = import('./runtime/host-file-port.ts').HostFilePort

/** The completion scope of one MentionProvider instance: the runner
 * resolves it at install time (the live SESSION when one exists, the
 * workspace cwd otherwise) so the port is addressed by HOST identity —
 * never by a client-side path assumption. */
export type MentionScope = import('./runtime/host-file-port.ts').HostFileScope

/**
 * The editor's autocomplete provider: `@` mentions through the Host-file
 * port (the Direct adapter runs the fd whole-tree fuzzy search or the
 * bounded recursive fallback) plus the fork's usual slash-command and
 * path completion (client-local editor machinery). applyCompletion always
 * delegates to the fork (its `@` branch already handles quoting and
 * directory continuation).
 */
export class MentionProvider implements AutocompleteProvider {
  private readonly inner: CombinedAutocompleteProvider
  private readonly workDir: string
  private readonly fileReferences: HostReferencesSeam
  private readonly scope: MentionScope
  /** The slash commands whose argument completion is a PATH (the host
   * attaches `getArgumentCompletions`, e.g. `/image`): ONLY these tolerate
   * a trailing-space argument as a Tab file-completion site — every other
   * command keeps the fork's judgment. */
  private readonly pathArgumentCommands: ReadonlySet<string>
  /** The live editor input mode (the shell-editor-mode plan): the editor
   * buffer no longer contains the `!` / `!!` prefix, so the provider
   * synthesizes a VIRTUAL serialized line at the completion boundary —
   * the shell grammar in shell-completion.ts stays untouched. */
  private readonly inputModeSource: () => EditorInputMode

  constructor(
    slashCommands: readonly SlashCommand[],
    workDir: string,
    fileReferences: HostReferencesSeam,
    inputModeSource: () => EditorInputMode = () => 'prompt',
    scope: MentionScope = { kind: 'workspace', cwd: workDir },
  ) {
    this.workDir = workDir
    this.fileReferences = fileReferences
    this.inputModeSource = inputModeSource
    this.scope = scope
    // The fork's fdPath is null: the `@` branch is intercepted below and
    // routed through the port, so the fork never sees an `@` prefix here.
    this.inner = new CombinedAutocompleteProvider([...slashCommands], workDir, null)
    this.pathArgumentCommands = new Set(
      slashCommands
        .filter(command => command.getArgumentCompletions !== undefined)
        .map(command => command.name),
    )
  }

  /** The virtual serialized line for a shell-mode editor position on the
   * FIRST document line: the synthetic `!` / `!!` prefix plus the shifted
   * cursor column. Null in prompt mode or on a LATER line — the wire
   * document carries the prefix on line 0 only, so a body continuation
   * line completes as ordinary text (paths), exactly like the wire. */
  private virtualShellLine(
    line: string,
    cursorCol: number,
  ): { line: string; cursorCol: number; prefixLength: number } | null {
    const mode = this.inputModeSource()
    if (mode === 'prompt') return null
    const prefix = shellPrefixForMode(mode)
    return { line: prefix + line, cursorCol: cursorCol + prefix.length, prefixLength: prefix.length }
  }

  /** The WIRE representation: the synthetic `!` / `!!` prefix belongs to
   * LINE 0 only — the serialized wire document carries it once, and a
   * body continuation line is ordinary text. Used for the shell-grammar
   * parse and the Stable-extension wire query. Null in prompt mode or on
   * a later line. */
  private virtualWireShellContext(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): { line: string; cursorCol: number; prefixLength: number } | null {
    if (cursorLine !== 0) return null
    return this.virtualShellLine(lines[0] ?? '', cursorCol)
  }

  /** The SHELL SEMANTIC context: EVERY line of a shell-mode document is
   * part of the shell command, so slash-vs-path routing, the apply
   * classification and the Tab gating treat any line as shell-owned. The
   * synthetic prefix is staged on the cursor line and stripped from the
   * result — the wire document itself never changes. Null in prompt
   * mode. */
  private virtualShellSemanticContext(
    currentLine: string,
    cursorCol: number,
  ): { line: string; cursorCol: number; prefixLength: number } | null {
    return this.virtualShellLine(currentLine, cursorCol)
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
      // The Host-file discovery owns the fd/fallback decision (migration
      // M1.10); an empty result is a null suggestion, exactly like the
      // pre-migration fd and fallback paths. The port is addressed by the
      // runner-resolved SCOPE (session identity when live), never a
      // client-side path assumption. A port rejection degrades to no
      // suggestions (the editor must never crash on a discovery failure),
      // and an aborted request is re-checked AFTER the await: a late
      // result can never overwrite newer suggestions (the fork's own
      // post-await abort check, applied to the port branch).
      let candidates: readonly import('./runtime/host-file-port.ts').HostFileCandidate[]
      try {
        candidates = await this.fileReferences.listReferences(this.scope, atPrefix, { signal: options.signal })
      } catch {
        return null
      }
      if (options.signal.aborted || candidates.length === 0) return null
      return {
        prefix: atPrefix,
        items: candidates.map(candidate => ({
          value: candidate.value,
          label: candidate.label,
          description: candidate.description,
        })),
      }
    }
    // `!`/`!!` shell lines: command names, subcommands and `$VAR` names come
    // from the real-shell compgen bridge (docs/input-and-card-polish.md §1);
    // path positions fall through to the fork's fd completion below. In a
    // shell MODE the buffer holds the bare body, so the shell grammar
    // receives the VIRTUAL serialized line (the synthetic prefix — line 0
    // only, matching the wire document); in prompt mode the line is
    // parsed as-is (a literal `!` draft). The leading-`/` suppression is
    // SHELL-SEMANTIC: EVERY line of a shell-mode document is shell-owned,
    // so a path on any line stays a path (never a slash command).
    const wire = this.virtualWireShellContext(lines, cursorLine, cursorCol)
    const shellLine = wire ?? { line: currentLine, cursorCol, prefixLength: 0 }
    const shellContext = shellCompletionContext(shellLine.line, shellLine.cursorCol)
    if (shellContext !== undefined) {
      const suggestions = await suggestShellCompletion(shellContext, this.workDir, options)
      if (suggestions !== null) return suggestions
      // No shell suggestions (or the shell is unavailable): fall through —
      // a path position still gets the fork's file completion.
    } else if (this.virtualShellSemanticContext(currentLine, cursorCol) !== null
      && !options.force && currentLine.startsWith('/')) {
      // A NATURAL trigger on a leading `/` in a shell mode is a PATH,
      // never a slash command: the fork's slash-command branch must not
      // flash the command list while the user types `/usr/lo` — on ANY
      // line. Stay quiet until Tab (which routes through the path branch
      // below) — this matches the pre-mode behavior, where the literal
      // `!` prefix kept the fork's slash branch off.
      return null
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
    // pattern as the fork's slash-command apply. In a shell MODE the
    // context check runs on the VIRTUAL serialized line, but the apply
    // itself operates on the REAL line: the completion prefix sits after
    // the synthetic `!`, so it is identical in both forms and no prefix
    // stripping is needed — the synthetic prefix never enters the buffer.
    const wire = this.virtualWireShellContext(lines, cursorLine, cursorCol)
    const shellLine = wire ?? { line: currentLine, cursorCol, prefixLength: 0 }
    if (shellCompletionContext(shellLine.line, shellLine.cursorCol) !== undefined) {
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
    // SYMMETRIC SHELL-SEMANTIC adapter: every non-shell apply (path
    // completion, Stable-extension suggestions) on ANY line of a
    // shell-mode document runs on the virtual line — the fork's
    // line-start judgments then see the `!` prefix (an absolute path
    // like `/u` is never mistaken for a slash command, on line 0 or a
    // continuation line, and an extension prefix computed on the wire
    // line stays coordinate-consistent). The synthetic prefix is
    // stripped from the applied result, so it never enters the buffer.
    const semantic = this.virtualShellSemanticContext(currentLine, cursorCol)
    if (semantic !== null) {
      const wireLines = lines.map((line, index) => index === cursorLine ? semantic.line : line)
      const applied = this.inner.applyCompletion(wireLines, cursorLine, semantic.cursorCol, item, prefix)
      const resultLines = [...applied.lines]
      resultLines[cursorLine] = resultLines[cursorLine]!.slice(semantic.prefixLength)
      return {
        lines: resultLines,
        cursorLine: applied.cursorLine,
        cursorCol: Math.max(0, applied.cursorCol - semantic.prefixLength),
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
    // In a shell MODE a leading `/` is a PATH, never a slash command: the
    // fork's bare-slash-command block (`/usr/lo` has no space) must not
    // swallow Tab. The VIRTUAL SHELL-SEMANTIC line keeps the fork's own
    // judgment on the cursor line — on ANY line of the shell document
    // (the wire representation still carries the prefix on line 0 only).
    const semantic = this.virtualShellSemanticContext(currentLine, cursorCol)
    if (semantic !== null) {
      const virtualLines = lines.map((line, index) => index === cursorLine ? semantic.line : line)
      return this.inner.shouldTriggerFileCompletion?.(virtualLines, cursorLine, semantic.cursorCol) ?? true
    }
    return this.inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
  }
}
