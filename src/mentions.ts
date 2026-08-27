/**
 * @-file mention grammar and editor completion for the editor: the pure
 * Client-local side of the `@`-mention surface (migration M1.10). The
 * HOST filesystem operations (fd/fdfind discovery, the recursive fallback
 * scan, existence probes) live in `src/runtime/direct/host-file-direct.ts` —
 * this module never assumes the Host filesystem IS the current Node
 * process filesystem. The editor's MentionProvider consumes the
 * `HostFilePort` seam; slash-command and path-argument completion keep
 * the fork's CombinedAutocompleteProvider (client-local editor
 * machinery).
 *
 * FILE-COMPLETION CONVERGENCE (the 2026-08-27 plan): the path query
 * parsing, ranking, quoting and presentation behind `@` mentions and
 * `/image` arguments are ONE shared engine in `src/file-completion/`
 * (plan §5-§8). THIS module keeps the mention GRAMMAR (extractAtPrefix,
 * findFileMentions, the send-time rewriter) and the MentionProvider
 * adapter; the engine owns the path math and BOTH sources (the Host-file
 * port for `@`, LocalFileSource for `/image`) answer discovery through
 * it. The FILE-COMPLETION CONTEXT classifier (plan §4) is the ONE gate —
 * file completion opens ONLY on `@...` and `/image ...`.
 * @module @xmoon76/dsh-pi-tui/mentions
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import {
  CombinedAutocompleteProvider,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@xmoon76/pi-tui'
import { shellCompletionContext, suggestShellCompletion } from './shell-completion.ts'
import { shellPrefixForMode, type EditorInputMode } from './editor-input-mode.ts'
import {
  classifyFileCompletionContext,
  extractAtPrefix,
  FILE_ARGUMENT_COMMANDS,
} from './file-completion/context.ts'
import { completePath, presentDiscovery, reattachDisplayBase, resolveQuery } from './file-completion/engine.ts'
import { listDirectChildren } from './file-completion/discovery.ts'
import { LocalFileSource } from './file-completion/local-file-source.ts'
import { resolveFdPath } from './file-completion/discovery.ts'
import type { PathCandidate } from './file-completion/types.ts'

// The migration-era surface re-exported for test pins (`mentions.test.ts`
// imports `resolvePathSearch` and `extractAtPrefix` from this module).
export { extractAtPrefix } from './file-completion/context.ts'
export { resolvePathSearch } from './file-completion/query.ts'

/** Token separators: `@` must sit at the start of the current token. */
const PATH_DELIMITERS = new Set([' ', '\t', '"', "'", '='])
/** Trailing punctuation allowed AFTER an unquoted mention token: stripped
 * for the existence probe but KEPT in the rewritten text, so a sentence
 * like "see @src/foo.ts, then…" still canonicalizes. */
const MENTION_TRAILING_PUNCTUATION = new Set([
  '.', ',', ';', ':', '!', '?', ')', ']', '}',
  '。', '，', '；', '：', '！', '？', '）', '】', '》',
])
/** CJK punctuation that ENDS an unquoted mention token. */
const CJK_MENTION_ENDERS = new Set([
  '，', '。', '；', '：', '！', '？', '、', '）', '】', '》', '」', '』', '…',
])

/** One `@`-mention token found in a draft. */
export interface FileMentionOccurrence {
  readonly start: number
  readonly end: number
  readonly path: string
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
 */
export function findFileMentions(text: string): FileMentionOccurrence[] {
  const mentions: FileMentionOccurrence[] = []
  let index = 0
  while (index < text.length) {
    const at = text.indexOf('@', index)
    if (at === -1) break
    const before = at === 0 ? '' : text[at - 1] ?? ''
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
      if (close === -1) break
      pathEnd = close
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
        end: quoted ? cursor : pathStart + path.length,
        path,
        quoted,
      })
    }
    index = quoted ? cursor : cursor + 1
  }
  return mentions
}

/** Whether the char is CJK (ideographs, kana, hangul, CJK punctuation,
 * full-width forms): a mention may sit DIRECTLY against CJK text without
 * a delimiter — CJK sentences glue the mention to the previous character —
 * while ASCII words keep the strict boundary rule (emails, `pkg@1.0.0`). */
function isCjkChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (code >= 0x3000 && code <= 0x303f)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7af)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xffef)
}

/**
 * Resolve ONE raw mention path to the candidate absolute path: `~`
 * expands through the homedir, an absolute path stays as-is, a relative
 * path resolves against the session workspace. PURE.
 */
export function resolveMentionCandidate(raw: string, sessionCwd: string): string {
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  if (isAbsolute(raw)) return raw
  return join(sessionCwd, raw)
}

/** The injected existence probe (Host-owned). */
export type MentionExistence = (candidate: string) => boolean | Promise<boolean>

/**
 * Send-time canonicalization of `@`-file mentions: the EDITOR keeps
 * showing the concise relative form the user typed, but the MODEL-facing
 * message carries the unambiguous absolute path. Rules: a relative path
 * resolves against `sessionCwd`; `~` expands through the homedir; an
 * absolute path stays as-is; a path that does NOT exist is left VERBATIM;
 * symlinks are absolutized, never realpath'd. Quoted mentions keep their
 * quotes. The EXISTENCE probe is injected — this module never touches the
 * filesystem itself.
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

/** The mention scope at suggestion time (never captured at install). */
export type MentionScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'workspace'; cwd: string }

/** The host-file seam (HostFilePort, structural). */
export type HostReferencesSeam = {
  listReferences: (
    scope: MentionScope,
    query: string,
    options?: { signal?: AbortSignal },
  ) => Promise<readonly import('./runtime/host-file-port.ts').HostFileCandidate[]>
  resolveReference: (
    scope: MentionScope,
    path: string,
    options?: { signal?: AbortSignal },
  ) => Promise<import('./runtime/host-file-port.ts').HostFileResolveResult>
  canonicalizeMentions: (scope: MentionScope, text: string) => Promise<string>
}

/** The fail-closed seam: no file-aware completion at all. */
const NO_HOST_REFERENCES = {
  async listReferences(): Promise<readonly import('./runtime/host-file-port.ts').HostFileCandidate[]> {
    return []
  },
  async resolveReference(): Promise<import('./runtime/host-file-port.ts').HostFileResolveResult> {
    return { kind: 'missing' }
  },
  async canonicalizeMentions(_scope: MentionScope, text: string): Promise<string> {
    return text
  },
}

/** Whether two mention scopes are the same (a session switch mid-flight
 * must drop the old session's candidate list). */
function sameMentionScope(left: MentionScope, right: MentionScope): boolean {
  if (left.kind !== right.kind) return false
  return left.kind === 'session'
    ? left.sessionId === (right as { sessionId: string }).sessionId
    : left.cwd === (right as { cwd: string }).cwd
}

/**
 * The editor's autocomplete provider: `@` mentions through the Host-file
 * port (the Direct adapter answers scoped discovery + fd/fdfind via the
 * shared engine) plus the fork's usual slash-command and path completion
 * (client-local editor machinery). The FILE-COMPLETION CONTEXT classifier
 * (plan §4) drives which positions ever complete files.
 */
export class MentionProvider implements AutocompleteProvider {
  private readonly inner: CombinedAutocompleteProvider
  private readonly workDir: string
  private readonly fileReferences: HostReferencesSeam
  /** The completion scope, resolved at SUGGESTION time. */
  private readonly scopeOf: () => MentionScope
  /** The EXPLICIT file-argument command set (plan §4.2 — never derived
   * from `getArgumentCompletions !== undefined`). */
  private readonly pathArgumentCommands: ReadonlySet<string>
  /** The live editor input mode (shell-editor-mode plan). */
  private readonly inputModeSource: () => EditorInputMode
  /** The `/image` discovery source: Client-local (never HostFilePort). */
  private readonly localSource: LocalFileSource

  constructor(
    slashCommands: readonly SlashCommand[],
    workDir: string,
    fileReferences: HostReferencesSeam | null,
    inputModeSource: () => EditorInputMode = () => 'prompt',
    scope: MentionScope | (() => MentionScope) = { kind: 'workspace', cwd: workDir },
    localFdPath: string | null = null,
  ) {
    this.workDir = workDir
    this.fileReferences = fileReferences ?? NO_HOST_REFERENCES
    this.inputModeSource = inputModeSource
    this.scopeOf = typeof scope === 'function' ? scope : () => scope
    this.inner = new CombinedAutocompleteProvider([...slashCommands], workDir, null)
    this.pathArgumentCommands = FILE_ARGUMENT_COMMANDS
    // `/image`'s discovery source: the CLIENT's own filesystem. `localFdPath`
    // is a test pin (null = the bounded local fallback, deterministic);
    // the DEFAULT is the PATH probe (fd then fdfind — plan §12), so the
    // installed surface shares the finder with `@`.
    this.localSource = new LocalFileSource(localFdPath === null ? resolveFdPath() : localFdPath)
  }

  /** The virtual serialized line for a shell-mode editor position on the
   * FIRST document line. */
  private virtualShellLine(
    line: string,
    cursorCol: number,
  ): { line: string; cursorCol: number; prefixLength: number } | null {
    const mode = this.inputModeSource()
    if (mode === 'prompt') return null
    const prefix = shellPrefixForMode(mode)
    return { line: prefix + line, cursorCol: cursorCol + prefix.length, prefixLength: prefix.length }
  }

  /** The WIRE representation (the synthetic `!` prefix belongs to line 0). */
  private virtualWireShellContext(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): { line: string; cursorCol: number; prefixLength: number } | null {
    if (cursorLine !== 0) return null
    return this.virtualShellLine(lines[0] ?? '', cursorCol)
  }

  /** The SHELL SEMANTIC context: EVERY line of a shell-mode document is
   * part of the shell command. */
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
    // 1. The SHELL-BRIDGE grammar first (a `!` line's first word is a
    // command name; a path position falls through). The bridge never
    // competes with file completion.
    const wire = this.virtualWireShellContext(lines, cursorLine, cursorCol)
    const shellLine = wire ?? { line: currentLine, cursorCol, prefixLength: 0 }
    const shellContext = shellCompletionContext(shellLine.line, shellLine.cursorCol)
    if (shellContext !== undefined) {
      const suggestions = await suggestShellCompletion(shellContext, this.workDir, options)
      if (suggestions !== null) return suggestions
    }

    // 2. THE FILE-COMPLETION CONTEXT CLASSIFIER (plan §4): the ONLY places
    // file completion ever opens — `@` mentions and declared file-argument
    // commands (`/image`). In a shell MODE the classifier sees the virtual
    // serialized line (every line of a shell document is shell-owned); in
    // prompt mode the line parses as-written (a literal `!` draft is a
    // shell line through the same grammar — the classifier leaves it
    // `none`, and step 4 keeps the shell completion non-goal alive).
    const semantic = this.virtualShellSemanticContext(currentLine, cursorCol)
    const context = semantic !== null
      ? classifyFileCompletionContext(semantic.line, this.pathArgumentCommands)
      : classifyFileCompletionContext(textBeforeCursor, this.pathArgumentCommands)

    if (context.kind === 'mention') {
      return this.completeMention(context.query, options.signal)
    }
    if (context.kind === 'image-argument') {
      return this.completeImageArgument(context.query, options.signal)
    }

    // 3. Shell-mode natural-trigger suppression (mirrors the pre-plan
    // routing; kept because shell path completion is a NON-GOAL — plan
    // §27): a leading `/` is a PATH, never a slash command. Stay quiet
    // until Tab (which routes through the path branch below).
    if (semantic !== null && !options.force && currentLine.startsWith('/')) {
      return null
    }

    // 4. SHELL documents (a shell MODE, or a prompt-mode buffer holding the
    // literal `!` / `!!` wire form — the non-goal shell command
    // completion): the fork's own completion stays authoritative — command
    // names AND path positions. This is NOT the plan's ordinary-position
    // domain.
    const literalShellLine = textBeforeCursor.trimStart().startsWith('!')
    if (semantic !== null || literalShellLine) {
      try {
        return await this.inner.getSuggestions(lines, cursorLine, cursorCol, options)
      } catch {
        return null
      }
    }

    // 5. PROMPT MODE, ordinary position (plan §2.1): file completion is
    // CLOSED — `foo`, `./foo`, `../foo`, `/tmp/foo`, `hello foo` never
    // produce a file dropdown, natural or forced (a forced request is
    // refused by shouldTriggerFileCompletion before it gets here). The ONE
    // keeper: slash command NAME completion — a separate mechanism (plan
    // §27) that never touches file paths.
    if (options.force === true) return null
    if (textBeforeCursor.trimStart().startsWith('/') && !textBeforeCursor.trimStart().includes(' ')) {
      try {
        return await this.inner.getSuggestions(lines, cursorLine, cursorCol, options)
      } catch {
        return null
      }
    }
    return null
  }

  /** Complete one `@` mention through the shared engine + HostFilePort:
   * the raw token is resolved against the SESSION scope, the port answers
   * Host discovery facts, and presentation (ranking/quoting/@-shape) is
   * the shared layer. Stale results are dropped twice: the port's own
   * abort check and the scope re-verification after the await. */
  private async completeMention(atPrefix: string, signal: AbortSignal): Promise<AutocompleteSuggestions | null> {
    const scope = this.scopeOf()
    // The editor's at-prefix INCLUDES the `@` (and an unclosed `"` for the
    // quoted form): the port's contract keeps the whole prefix (its Direct
    // adapter strips and resolves the scope). The engine's raw token for
    // ranking is the stripped form; the port returns the DISPLAY paths
    // already reattached (its contract: user-facing paths).
    const candidates = await this.discoverMention(scope, atPrefix, signal)
    if (signal.aborted || candidates.length === 0) return null
    if (!sameMentionScope(scope, this.scopeOf())) return null
    const { raw, quoted } = stripMentionToken(atPrefix)
    const query = resolveQuery(raw, this.workDir)
    const items = presentDiscovery(
      candidates.map(candidate => ({ path: candidate.path, kind: candidate.kind })),
      query.searchTerm,
      { at: true, quoted, sep: query.winAbsolute ? '\\' : '/' },
    )
    if (items.length === 0) return null
    return { prefix: atPrefix, items }
  }

  /** The discovery step (separated for the abort-fence test seam). */
  private async discoverMention(
    scope: MentionScope,
    atPrefix: string,
    signal: AbortSignal,
  ): Promise<readonly import('./runtime/host-file-port.ts').HostFileCandidate[]> {
    try {
      return await this.fileReferences.listReferences(scope, atPrefix, { signal })
    } catch {
      return []
    }
  }

  /** Complete one `/image` argument through the shared engine + the
   * Client-local source (NEVER HostFilePort). An EMPTY argument lists the
   * cwd (Tab on `/image ` — the directory-listing semantics the engine
   * owns). A QUOTED argument (`/image "my fi`) completes inside the
   * quotes — the shared quoting contract (plan §2.2) — and the completed
   * value keeps the closing quote. An unquoted argument with embedded
   * spaces cannot complete (the fork's apply replaces the whole argument
   * range, so a later word would clobber the earlier ones). */
  private async completeImageArgument(argument: string, signal: AbortSignal): Promise<AutocompleteSuggestions | null> {
    const leading = argument.match(/^[ \t]+/)?.[0] ?? ''
    let token = argument.slice(leading.length)
    let quoted = false
    if (token.startsWith('"')) {
      quoted = true
      token = token.startsWith('"') ? token.slice(1) : token
      const close = token.indexOf('"')
      if (close !== -1) token = token.slice(0, close)
    }
    if (token.includes(' ') || token.includes('\t')) return null
    const items = await completePath(token, this.workDir, this.localSource, signal, { at: false, quoted })
    if (items === null) return null
    return { prefix: argument, items: items.map(item => ({ ...item, value: `${leading}${item.value}` })) }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] ?? ''
    // THE STALE FENCE (plan §9.1): the request's prefix must still be the
    // text immediately before the cursor. Any edit since the request —
    // typing, Backspace, Delete, cursor move, paste, mode/session switch —
    // makes the replacement WRONG (the old code cut `cursorCol - prefix.length`
    // into the middle of the new draft, deleting `@`-preceding text). A
    // stale accept returns the document UNCHANGED.
    const start = cursorCol - prefix.length
    if (start < 0 || currentLine.slice(start, cursorCol) !== prefix) {
      return { lines, cursorLine, cursorCol }
    }
    // Shell-bridge apply: replace only the current word (the `!` prefix and
    // everything before stay untouched).
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
    // SYMMETRIC SHELL-SEMANTIC adapter (shell mode): the classification ran
    // on the virtual line, so the apply must too.
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
    // Shell mode: the classifier sees the virtual serialized line (a
    // leading `/` is a PATH, never a slash command — the fork's
    // bare-slash-command block must not swallow Tab on a shell line).
    const semantic = this.virtualShellSemanticContext(currentLine, cursorCol)
    const context = semantic !== null
      ? classifyFileCompletionContext(semantic.line, this.pathArgumentCommands)
      : classifyFileCompletionContext(textBeforeCursor, this.pathArgumentCommands)
    // SHELL documents (a shell MODE, or a literal `!` shell line): keep the
    // fork's own gate — BUT on the VIRTUAL serialized line (the synthetic
    // `!` prefix makes the fork's line-start judgment see a shell line, so
    // `/usr/lo` reads as a PATH, never a bare slash command — the
    // pre-plan shell-mode parity the plan keeps as a non-goal).
    if (semantic !== null || textBeforeCursor.trimStart().startsWith('!')) {
      if (semantic !== null) {
        const virtualLines = lines.map((line, index) => index === cursorLine ? semantic.line : line)
        return this.inner.shouldTriggerFileCompletion?.(virtualLines, cursorLine, semantic.cursorCol) ?? true
      }
      return this.inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
    }
    // PROMPT-MODE ordinary positions (plan §2.1/§10): the HOST's built-in
    // file completion is CLOSED — the request must still RUN so the
    // extension chain (a SEPARATE mechanism, plan §27 non-goal) can be
    // consulted, but the host's own file branch returns null for `none`
    // contexts (getSuggestions above). ONE fast-fail: a leading `/` with
    // NO separator character (neither space NOR tab — tab is a fork path
    // delimiter) is a slash command NAME — the Tab handler routes it to
    // command-name completion (its own branch, never the file gate). The
    // classifier's `image-argument` (a tab-separated `/image\t` IS an
    // argument position) wins over the fast-fail.
    if (context.kind === 'none'
      && textBeforeCursor.trimStart().startsWith('/')
      && !textBeforeCursor.trimStart().includes(' ')
      && !textBeforeCursor.trimStart().includes('\t')) {
      return this.inner.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
    }
    // An empty or bare textual position: let the request run (the
    // extension chain is separate); the host file branch is closed.
    return true
  }
}

/** The raw token + quoted flag of one editor at-prefix (`@src/fo` →
 * `src/fo`; `@"my file` → `my file`; the unclosed quote stays unclosed —
 * the ranking term is the text inside the quotes). */
function stripMentionToken(atPrefix: string): { raw: string; quoted: boolean } {
  if (atPrefix.startsWith('@"')) {
    const inner = atPrefix.slice(2)
    return { raw: inner.endsWith('"') ? inner.slice(0, -1) : inner, quoted: true }
  }
  const inner = atPrefix.slice(1)
  return { raw: inner.endsWith('"') ? inner.slice(0, -1) : inner, quoted: false }
}

/**
 * Slash-command PATH-argument completion (`/image <path>`): the SYNC
 * COMPATIBILITY wrapper over the shared engine's QUERY/RANKING/
 * PRESENTATION (plan §20 — the same modules behind `@` and the async
 * `/image` path). The discovery step here is DIRECTORY-LOCAL ONLY, and
 * deliberately synchronous: the fork's `getArgumentCompletions` contract
 * is sync `AutocompleteItem[] | null` (the fork calls it per keystroke
 * and cannot await), and the engine's scoped-listing branch is itself a
 * bounded `readdirSync` — so this wrapper shares the engine's query,
 * ranking, quoting, separator dialect and display-base reattachment, and
 * answers only what its sync shape allows. The fd/fdfind whole-tree fuzzy
 * search (async, cancellable) is the provider-level `/image` path
 * ({@link MentionProvider.completeImageArgument} → {@link completePath}),
 * which the installed completion surface uses; this wrapper is the
 * migration-era seam the existing tests pin, and it never runs an
 * unbounded scan.
 *
 * @param argumentText - the text after the command name.
 * @param cwd - the session workspace (resolve relative forms against it).
 */
export function suggestPathArgument(argumentText: string, cwd: string): AutocompleteItem[] | null {
  const token = argumentText
  const leading = token.match(/^[ \t]+/)?.[0] ?? ''
  const parsed = token.slice(leading.length)
  if (parsed === '' || parsed.includes(' ') || parsed.includes('\t')) return null
  const query = resolveQuery(parsed, cwd)
  const entries = localChildrenOf(query)
  if (entries.length === 0) return null
  const items = presentDiscovery(
    entries.map(entry => reattachDisplayBase(entry, query)),
    query.searchTerm,
    { at: false, quoted: false, sep: query.winAbsolute ? '\\' : '/' },
  )
  return items.length === 0 ? null : items.map(item => ({ ...item, value: `${leading}${item.value}` }))
}

/** The DIRECT children of one directory through the engine's own listing
 * (a scoped query's search base is its directory — the same bounded
 * readdir the async engine uses; a missing/unreadable directory yields []
 * (never a crash). Symlinks to directories complete with `/` (the engine's
 * entryIsDirectory rule). */
function localChildrenOf(query: import('./file-completion/types.ts').PathCompletionQuery): PathCandidate[] {
  return listDirectChildren(query.searchBase)
    .map(entry => ({ path: entry.path, kind: entry.isDirectory ? 'directory' : 'file' }))
}
