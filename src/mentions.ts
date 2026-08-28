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
import { isAbsolute, join, win32 } from 'node:path'
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
import { completePath, presentDiscovery, resolveQuery } from './file-completion/engine.ts'
import { separatorOfRaw, stripAtQuotes } from './file-completion/query.ts'
import { LocalFileSource } from './file-completion/local-file-source.ts'
import { resolveFdPath } from './file-completion/discovery.ts'

// The migration-era surface re-exported for test pins (`mentions.test.ts`
// imports `resolvePathSearch` and `extractAtPrefix` from this module).
export { extractAtPrefix } from './file-completion/context.ts'
export { resolvePathSearch } from './file-completion/query.ts'

/** Token separators: `@` must sit at the start of the current token. */
const PATH_DELIMITERS = new Set([' ', '\t', '\n', '\r', '"', "'", '='])
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
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    return raw === '~'
      ? homedir()
      : join(homedir(), raw.slice(2).replace(/\\/g, '/'))
  }
  // `path.isAbsolute` follows the host OS. The mention grammar must also
  // preserve Windows drive/UNC references when a client process is POSIX
  // (and must not mistake a POSIX `/tmp` path for a Windows path on Windows).
  if (isAbsolute(raw) || (!raw.startsWith('/') && win32.isAbsolute(raw))) return raw
  // A relative Windows-looking token is still relative to the session scope;
  // normalize its separators only when the scope itself is POSIX.
  return raw.includes('\\') && process.platform !== 'win32'
    ? join(sessionCwd, raw.replace(/\\/g, '/'))
    : join(sessionCwd, raw)
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

/** Complete the argument text shared by the provider-level `/image`
 * path and the awaitable command compatibility hook. The caller chooses the
 * filesystem source and cwd; no HostFilePort is involved. */
async function completeImageArgumentText(
  argument: string,
  cwd: string,
  source: LocalFileSource,
  signal: AbortSignal,
  allowEmpty: boolean,
): Promise<AutocompleteItem[] | null> {
  const leading = argument.match(/^[ \t]+/)?.[0] ?? ''
  let token = argument.slice(leading.length)
  if (token === '' && !allowEmpty) return null
  let quoted = false
  if (token.startsWith('"')) {
    quoted = true
    token = token.slice(1)
    const close = token.indexOf('"')
    if (close !== -1) {
      // A closed quote is already a complete token. Replacing the whole
      // command argument would otherwise delete text after that quote.
      return null
    }
  } else if (token.includes(' ') || token.includes('\t')) {
    // The fork's argument apply replaces one contiguous argument range, so an
    // unquoted later word must not cause the earlier word to be clobbered.
    return null
  }
  const items = await completePath(token, cwd, source, signal, { at: false, quoted })
  return items === null ? null : items.map(item => ({ ...item, value: `${leading}${item.value}` }))
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
  /** Client-local cwd for `/image`; intentionally separate from the Host
   * session scope so a future remote attach cannot make image completion read
   * the Host workspace. */
  private readonly localCwdOf: () => string
  /** The REQUEST SNAPSHOT (plan §9.2): the exact document lines + cursor
   * + mode + SCOPE of the most recent getSuggestions call that produced a
   * suggestion list. Strict file/extension results may apply ONLY when the
   * current document + cursor + scope still match this snapshot — a stale
   * dropdown (from an older request, or from a request resolved under a
   * switched session/workspace scope) can never modify the current draft.
   * Legacy shell-word results keep the fork's prefix-only adapter behavior;
   * direct calls without a captured request retain that same fallback. */
  private requestSnapshot: {
    lines: readonly string[]
    cursorLine: number
    cursorCol: number
    mode: EditorInputMode
    scope: MentionScope
    localCwd: string
    /** File and extension results require a full snapshot fence. The fork's
     * legacy shell-word adapter keeps its prefix-only behavior for direct
     * shell apply callers. */
    strict: boolean
  } | null = null
  /** The monotonically increasing request generation (plan §9.2 latest-
   * only): minted at REQUEST START (getSuggestions entry). A result —
   * host OR extension — captures its snapshot ONLY IF its minted
   * generation is still the latest; a late answer from an older request
   * (a provider that ignores AbortSignal) can never overwrite a NEWER
   * request's snapshot, so the next legitimate accept is not wrongly
   * fenced. */
  private requestGeneration = 0

  constructor(
    slashCommands: readonly SlashCommand[],
    workDir: string,
    fileReferences: HostReferencesSeam | null,
    inputModeSource: () => EditorInputMode = () => 'prompt',
    scope: MentionScope | (() => MentionScope) = { kind: 'workspace', cwd: workDir },
    localFdPath: string | null | undefined = undefined,
    localCwd: string | (() => string) = workDir,
  ) {
    this.workDir = workDir
    this.fileReferences = fileReferences ?? NO_HOST_REFERENCES
    this.inputModeSource = inputModeSource
    this.scopeOf = typeof scope === 'function' ? scope : () => scope
    this.localCwdOf = typeof localCwd === 'function' ? localCwd : () => localCwd
    this.inner = new CombinedAutocompleteProvider([...slashCommands], workDir, null)
    this.pathArgumentCommands = FILE_ARGUMENT_COMMANDS
    // `/image`'s discovery source: the CLIENT's own filesystem.
    // `localFdPath` is a test/API pin: UNDEFINED (the default) probes PATH
    // (fd then fdfind — plan §12), `null` FORCES the bounded local
    // fallback (deterministic tests), a string pins the finder.
    this.localSource = localFdPath === undefined
      ? new LocalFileSource(resolveFdPath())
      : new LocalFileSource(localFdPath)
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
    const generation = ++this.requestGeneration
    const requestMode = this.inputModeSource()
    const requestLocalCwd = this.localCwdOf()
    return this.getSuggestionsAtGeneration(generation, requestMode, requestLocalCwd, lines, cursorLine, cursorCol, options)
  }

  /** The generation-threaded core: mint ONCE (either here for the direct
   * path, or by the DELEGATED wrap at entry — getSuggestionsForGeneration)
   * and never reset the global counter after an await. The snapshot
   * capture binds only when the minted generation is still the latest, so
   * a late result from an older request (a provider or the extension chain
   * ignoring AbortSignal) can never overwrite a newer request's snapshot. */
  private async getSuggestionsAtGeneration(
    generation: number,
    requestMode: EditorInputMode,
    requestLocalCwd: string,
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const currentLine = lines[cursorLine] ?? ''
    const textBeforeCursor = currentLine.slice(0, cursorCol)
    // The REQUEST scope, captured at entry (never re-read after an await:
    // a session/workspace switch mid-request must not bake the NEW scope
    // into this request's snapshot — the apply fence compares it).
    const requestScope = this.scopeOf()
    // 1. The SHELL-BRIDGE grammar first (a `!` line's first word is a
    // command name; a path position falls through). The bridge never
    // competes with file completion.
    const wire = this.virtualWireShellContext(lines, cursorLine, cursorCol)
    const shellLine = wire ?? { line: currentLine, cursorCol, prefixLength: 0 }
    const shellContext = shellCompletionContext(shellLine.line, shellLine.cursorCol)
    if (shellContext !== undefined) {
      const suggestions = await suggestShellCompletion(shellContext, this.workDir, options)
      if (suggestions !== null) {
        return this.withRequestSnapshot(generation, requestScope, requestMode, requestLocalCwd, lines, cursorLine, cursorCol, suggestions, false)
      }
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
      return this.withRequestSnapshot(
        generation,
        requestScope,
        requestMode,
        requestLocalCwd,
        lines,
        cursorLine,
        cursorCol,
        await this.completeMention(requestScope, context.query, options.signal),
      )
    }
    if (context.kind === 'image-argument') {
      return this.withRequestSnapshot(
        generation,
        requestScope,
        requestMode,
        requestLocalCwd,
        lines,
        cursorLine,
        cursorCol,
        await this.completeImageArgument(context.query, requestLocalCwd, options.signal),
      )
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
        const result = await this.inner.getSuggestions(lines, cursorLine, cursorCol, options)
        return this.withRequestSnapshot(generation, requestScope, requestMode, requestLocalCwd, lines, cursorLine, cursorCol, result, false)
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
        const result = await this.getSlashCommandSuggestions(lines, cursorLine, cursorCol, options)
        return this.withRequestSnapshot(generation, requestScope, requestMode, requestLocalCwd, lines, cursorLine, cursorCol, result, false)
      } catch {
        return null
      }
    }
    return null
  }

  /** The vendored slash-command provider currently expects `/name` at
   * column zero even though the editor's slash-command context accepts
   * indentation. Normalize only for the inner query; keep its returned
   * `/name` prefix so the normal apply adapter preserves the original
   * indentation. File contexts never reach this helper. */
  private getSlashCommandSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const line = lines[cursorLine] ?? ''
    const before = line.slice(0, cursorCol)
    const trimmed = before.trimStart()
    const leading = before.length - trimmed.length
    if (leading === 0) return this.inner.getSuggestions(lines, cursorLine, cursorCol, options)
    const normalizedLines = lines.map((value, index) => index === cursorLine ? value.slice(leading) : value)
    return this.inner.getSuggestions(normalizedLines, cursorLine, cursorCol - leading, options)
  }

  /** Complete one `@` mention through the shared engine + HostFilePort:
   * the raw token is resolved against the SESSION scope, the port answers
   * Host discovery facts, and presentation (ranking/quoting/@-shape) is
   * the shared layer. Stale results are dropped twice: the port's own
   * abort check and the scope re-verification after the await. */
  private async completeMention(scope: MentionScope, atPrefix: string, signal: AbortSignal): Promise<AutocompleteSuggestions | null> {
    // `scope` is captured at request entry and deliberately threaded through
    // the await. A session switch while the Host request is in flight must
    // fence the old request instead of resolving it against the new session.
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
      { at: true, quoted, sep: separatorOfRaw(raw, query.winAbsolute || raw.includes('\\')) },
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
   * owns). A QUOTED argument (`/image "my f`) completes inside the quotes
   * — the shared quoting contract (plan §2.2): spaces inside the quotes
   * are PART OF THE TOKEN (the quote is the delimiter), so `my f` finds
   * `my file.txt`; the completed value keeps the closing quote. An
   * UNQUOTED argument with embedded spaces cannot complete (the fork's
   * apply replaces the whole argument range, so a later word would clobber
   * the earlier ones). */
  private async completeImageArgument(
    argument: string,
    localCwd: string,
    signal: AbortSignal,
  ): Promise<AutocompleteSuggestions | null> {
    const items = await completeImageArgumentText(argument, localCwd, this.localSource, signal, true)
    return items === null ? null : { prefix: argument, items }
  }

  /** Capture the request state right before a non-null suggestion result
   * is returned: the apply fence later requires the EXACT same document +
   * cursor + mode (+ the REQUEST scope) (plan §9.2 — the strong stale
   * check). A null result clears the snapshot (nothing to accept). ONLY
   * the LATEST request binds: a result minted for an OLDER generation (a
   * late answer from a provider/extension that ignored AbortSignal) is
   * dropped, so it cannot fence a newer request. The scope is the one
   * captured at REQUEST ENTRY (passed in by the caller) — never read at
   * capture time after an await (a session switch mid-request must not
   * bake the NEW session into an OLD request's snapshot). */
  private withRequestSnapshot<T extends AutocompleteSuggestions | null>(
    generation: number,
    scope: MentionScope,
    mode: EditorInputMode,
    localCwd: string,
    lines: readonly string[],
    cursorLine: number,
    cursorCol: number,
    result: T,
    strict = true,
  ): T {
    if (generation !== this.requestGeneration) return result
    if (result === null) this.requestSnapshot = null
    else this.requestSnapshot = {
      lines: [...lines],
      cursorLine,
      cursorCol,
      mode,
      scope,
      localCwd,
       strict,
    }
    return result
  }

  /** PUBLIC test/app seam (plan §9.2): the DELEGATING provider (the app's
   * M5 wrap) captures the host snapshot when the EXTENSION chain answers —
   * the base provider still owns the stale fence, but a suggestion list it
   * did not produce must bind the state it was computed against. The
   * DELEGATED call passes the generation minted at ITS entry AND the
   * REQUEST scope captured at ITS entry (before the extension await): a
   * late extension answer from an OLDER request — a newer request already
   * started, or the scope switched mid-flight — does not bind. */
  captureRequestSnapshot(
    generation: number,
    scope: MentionScope,
    lines: readonly string[],
    cursorLine: number,
    cursorCol: number,
    result: AutocompleteSuggestions | null,
    mode: EditorInputMode = this.inputModeSource(),
    localCwd: string = this.localCwdOf(),
  ): AutocompleteSuggestions | null {
    return this.withRequestSnapshot(generation, scope, mode, localCwd, lines, cursorLine, cursorCol, result)
  }

  /** The base provider's suggestion entry for the DELEGATED wrap: the
   * wrap mints the generation ONCE at entry and threads it HERE — the host
   * call binds its snapshot to the SAME generation the extension's answer
   * will use. A newer request that starts during the extension await bumps
   * the counter past it, and the late extension answer is dropped by the
   * generation check — NEVER reset the global counter after an await (that
   * would clobber a newer request's minted generation). */
  async getSuggestionsForGeneration(
    generation: number,
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
    requestMode: EditorInputMode = this.inputModeSource(),
    requestLocalCwd: string = this.localCwdOf(),
  ): Promise<AutocompleteSuggestions | null> {
    return this.getSuggestionsAtGeneration(generation, requestMode, requestLocalCwd, lines, cursorLine, cursorCol, options)
  }

  /** PUBLIC test/app seam (plan §9.2): THE DELEGATING provider mints its
   * OWN generation synchronously at request ENTRY (before calling the
   * host), and the host's getSuggestionsForGeneration REUSES it: the
   * extension's answer — which settles later — binds to THIS request,
   * never to a newer one that started while the extension was in flight. */
  mintRequestGeneration(): number {
    return ++this.requestGeneration
  }

  /** The generation the host's getSuggestions call minted. The delegated
   * wrap must read it SYNCHRONOUSLY right after the host settles (before
   * any await): the global counter advances on every new request, so an
   * async read could return a NEWER request's generation and let a late
   * extension result bind to the wrong request. */
  captureRequestGeneration(): number {
    return this.requestGeneration
  }

  /** The REQUEST scope, read synchronously by the DELEGATED wrap at entry:
   * the extension's snapshot must carry the scope THIS request resolved
   * under (a switch mid-request must fence the stale accept, not bake the
   * new session into the old request's snapshot). */
  scopeAtRequestTime(): MentionScope {
    return this.scopeOf()
  }

  /** The Client-local cwd captured alongside the Host scope for a delegated
   * request. `/image` must reject an answer if its local base changes while
   * the async discovery is in flight. */
  localCwdAtRequestTime(): string {
    return this.localCwdOf()
  }

  /** Whether the editor state still EXACTLY matches the request that
   * produced the current dropdown (line array, cursor, input mode, AND
   * the completion scope — a mode switch swaps the completion grammar,
   * and a session/workspace switch changes which Host filesystem answers,
   * so a dropdown built for one scope must never apply under another). */
  private requestMatchesSnapshot(lines: readonly string[], cursorLine: number, cursorCol: number): boolean {
    const snapshot = this.requestSnapshot
    if (snapshot === null) return false
    if (snapshot.cursorLine !== cursorLine || snapshot.cursorCol !== cursorCol) return false
    if (snapshot.mode !== this.inputModeSource()) return false
    if (!sameMentionScope(snapshot.scope, this.scopeOf())) return false
    if (snapshot.localCwd !== this.localCwdOf()) return false
    if (snapshot.lines.length !== lines.length) return false
    for (let index = 0; index < snapshot.lines.length; index += 1) {
      if (snapshot.lines[index] !== lines[index]) return false
    }
    return true
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const currentLine = lines[cursorLine] ?? ''
    // THE STALE FENCE (plan §9.1 minimum + §9.2 full snapshot): file and
    // extension results carry the EXACT document lines + cursor + mode + scope
    // of the request that produced them. An extension result at an ordinary
    // prompt position can otherwise keep the same prefix while an unrelated
    // edit changes the rest of the line. Legacy shell-word results retain the
    // fork's prefix-only adapter semantics because they are not file ranges.
    if (this.requestSnapshot?.strict === true
      && !this.requestMatchesSnapshot(lines, cursorLine, cursorCol)) {
      return { lines, cursorLine, cursorCol }
    }
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
  return stripAtQuotes(atPrefix)
}

/**
 * Slash-command PATH-argument compatibility completion (`/image <path>`).
 * It is awaitable because the shared engine's fuzzy fallback is asynchronous
 * and cancellable; the production editor normally reaches the provider-level
 * `/image` branch, but the command descriptor can use this same source when
 * the vendored provider calls its argument hook directly.
 *
 * The empty argument remains quiet in this legacy helper. The editor-level
 * `/image ` context owns the explicit cwd listing, while preserving the old
 * command-hook contract for callers that used an empty argument as "no
 * completion".
 */
export async function suggestPathArgument(
  argumentText: string,
  cwd: string,
  localFdPath: string | null | undefined = undefined,
): Promise<AutocompleteItem[] | null> {
  const source = new LocalFileSource(localFdPath)
  return completeImageArgumentText(argumentText, cwd, source, new AbortController().signal, false)
}
