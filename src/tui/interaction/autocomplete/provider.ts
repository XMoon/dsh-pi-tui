/**
 * The editor autocomplete provider (TS8-B, moved out of the historical root
 * mentions module): `@` mentions through the Host-file port — the SESSION
 * scope routes by the typed token (TS8-HF1): a bare workspace fuzzy query maps
 * the OFFICIAL Host discovery authority (`ctx.fileReferences` / the wire),
 * whose candidates arrive already filtered, ranked and bounded, while an
 * explicit path scope (`@src/`, `@../`, `@/abs`, `@~/`) maps the Host scoped
 * discovery through the SAME port. The Direct WORKSPACE scope keeps the legacy
 * scanner as a sessionless compatibility path — plus the fork's usual
 * slash-command completion and the CLIENT-local `/attach` + `/image`
 * path-argument completion. The FILE-COMPLETION CONTEXT classifier
 * (`tui/file-completion/context.ts`) is the ONE gate: file completion opens
 * ONLY on `@...`, `/attach ...` and `/image ...`.
 * @module @xmoon76/dsh-pi-tui/tui/interaction/autocomplete/provider
 */

import {
  CombinedAutocompleteProvider,
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand,
} from '@xmoon76/pi-tui'
import { shellCompletionContext, suggestShellCompletion } from '../../../shell-completion.ts'
import { shellPrefixForMode, type EditorInputMode } from '../editor-input-mode.ts'
import { applyInlineSkillReference, extractInlineSkillPrefix } from '../../../skill-reference-completion.ts'
import type { HumanSkillSummary } from '../../../skill-catalog.ts'
import {
  classifyFileCompletionContext,
  stripAtQuotes,
} from '../../file-completion/context.ts'
import { FILE_ARGUMENT_COMMANDS } from '../../../domain/file-completion/path-argument-commands.ts'
import { completePathArgument as completeLocalPathArgument } from '../../file-completion/path-argument.ts'
import { presentPathCandidate } from '../../file-completion/presentation.ts'
import {
  ClientLocalDiscoveryDriver,
  clientPathQueryEnvironment,
} from '../../../client/file-completion/local-discovery.ts'
import type {
  HostFileCandidate,
  HostFileListResult,
  HostFilePort,
  HostFileResolveResult,
  HostFileScope,
} from '../../../runtime/host-file-port.ts'

/** The fail-closed port: no file-aware completion at all. */
const NO_HOST_REFERENCES: HostFilePort = {
  async listReferences(): Promise<HostFileListResult> {
    return { kind: 'unavailable', reason: 'Host file discovery is not available' }
  },
  async resolveReference(): Promise<HostFileResolveResult> {
    return { kind: 'unavailable', reason: 'Host file existence probing is not available' }
  },
  async canonicalizeMentions(_scope: HostFileScope, text: string): Promise<string> {
    return text
  },
}

/** Whether two Host file scopes are the same (a session switch mid-flight
 * must drop the old session's candidate list). */
function sameHostFileScope(left: HostFileScope, right: HostFileScope): boolean {
  if (left.kind !== right.kind) return false
  return left.kind === 'session'
    ? left.sessionId === (right as { sessionId: string }).sessionId
    : left.cwd === (right as { cwd: string }).cwd
}

/**
 * The editor's autocomplete provider: `@` mentions through the Host-file
 * port (the SESSION scope's Host router answers a bare query from the
 * OFFICIAL `ctx.fileReferences` authority — `ctx.fileReferences` / the wire —
 * whose candidates arrive already filtered, ranked and bounded, and an
 * explicit path scope from the Host scoped scanner; the Direct WORKSPACE
 * scope keeps the legacy scanner as a sessionless compatibility path) plus
 * the fork's usual slash-command and path completion (client-local editor
 * machinery). The FILE-COMPLETION CONTEXT classifier (plan §4) drives
 * which positions ever complete files.
 */
export class MentionProvider implements AutocompleteProvider {
  private readonly inner: CombinedAutocompleteProvider
  private readonly workDir: string
  private readonly fileReferences: HostFilePort
  /** The completion scope, resolved at SUGGESTION time. */
  private readonly scopeOf: () => HostFileScope
  /** The EXPLICIT file-argument command set (plan §4.2 — never derived
   * from `getArgumentCompletions !== undefined`). */
  private readonly pathArgumentCommands: ReadonlySet<string>
  /** The live editor input mode (shell-editor-mode plan). */
  private readonly inputModeSource: () => EditorInputMode
  /** The `/attach` and `/image` discovery driver: Client-local (never HostFilePort). */
  private readonly localDiscovery: ClientLocalDiscoveryDriver
  /** Client-local cwd for `/image`; intentionally separate from the Host
   * session scope so a future remote attach cannot make image completion read
   * the Host workspace. */
  private readonly localCwdOf: () => string
  /** The detached human skill catalog for INLINE skill reference completion
   * (the plain-text `/name` lexicon). A read-only Client presentation cache:
   * it never loads a skill body, never authorizes an invocation, and is
   * deliberately NOT part of the command `claims` — a skill reference is not
   * a command advertisement (the per-skill command wrappers keep their own
   * completion/claim path). */
  private readonly skillReferences: readonly HumanSkillSummary[]
  /** Whether Host-shell completion facts are reachable (shell amendment
   * M3-4 PR3): true on Direct (the compgen bridge reads the Host process's
   * own state); false on Remote — the compgen/path bridge then stays SILENT
   * (no Client `process.env.PATH`, no Client filesystem guessing for Host
   * shell state). */
  private readonly hostShellCompletion: boolean
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
    scope: HostFileScope
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
    fileReferences: HostFilePort | null,
    inputModeSource: () => EditorInputMode = () => 'prompt',
    scope: HostFileScope | (() => HostFileScope) = { kind: 'workspace', cwd: workDir },
    localFdPath: string | null | undefined = undefined,
    localCwd: string | (() => string) = workDir,
    skillReferences: readonly HumanSkillSummary[] = [],
    hostShellCompletion: boolean = true,
  ) {
    this.workDir = workDir
    this.fileReferences = fileReferences ?? NO_HOST_REFERENCES
    this.inputModeSource = inputModeSource
    this.scopeOf = typeof scope === 'function' ? scope : () => scope
    this.localCwdOf = typeof localCwd === 'function' ? localCwd : () => localCwd
    this.skillReferences = skillReferences
    this.hostShellCompletion = hostShellCompletion
    this.inner = new CombinedAutocompleteProvider([...slashCommands], workDir, null)
    this.pathArgumentCommands = FILE_ARGUMENT_COMMANDS
    // `/attach` and `/image` discovery driver: the CLIENT's own filesystem.
    // `localFdPath` is a test/API pin: UNDEFINED (the default) probes the
    // Client PATH (fd then fdfind), `null` FORCES the bounded local fallback
    // (deterministic tests), a string pins the finder.
    this.localDiscovery = new ClientLocalDiscoveryDriver(localFdPath)
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
    const shellContext = this.hostShellCompletion
      ? shellCompletionContext(shellLine.line, shellLine.cursorCol)
      : undefined
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
    if (context.kind === 'path-argument') {
      return this.withRequestSnapshot(
        generation,
        requestScope,
        requestMode,
        requestLocalCwd,
        lines,
        cursorLine,
        cursorCol,
        await this.completePathArgument(context.query, requestLocalCwd, options.signal),
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
    //
    // SHELL AMENDMENT (M3-4 PR3): the WHOLE shell completion decision is
    // Host-facts-gated, not just the compgen bridge. `inner` is the fork's
    // fd-backed path provider over the CLIENT filesystem, so a shell line on
    // a backend without Host shell facts (Remote) must show NO suggestions
    // at any position — command OR path. Letting the path branch fall
    // through would leak Client filesystem state as if it were the Host
    // workspace.
    const literalShellLine = textBeforeCursor.trimStart().startsWith('!')
    if (semantic !== null || literalShellLine) {
      if (!this.hostShellCompletion) return null
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
    // refused by shouldTriggerFileCompletion before it gets here). The
    // keepers: the INLINE SKILL REFERENCE lexicon (the plain-text `/name`
    // completion at whitespace token boundaries — a separate mechanism
    // from the command plane, plan §5 Cut B) and the slash command NAME
    // completion (plan §27) that never touches file paths.
    const inline = extractInlineSkillPrefix(lines, cursorLine, cursorCol)
    if (inline !== undefined) {
      const items = this.suggestInlineSkills(inline.query)
      if (items.length > 0) {
        // The inline prefix is the QUERY part only — never `/`-prefixed:
        // the vendored editor's confirm treats a `/`-prefixed prefix as a
        // leading command and falls through to submit, while an inline
        // accept must only insert the reference. The result binds the
        // FULL request snapshot (strict fence), so a stale dropdown can
        // never apply into a changed draft or a switched scope.
        return this.withRequestSnapshot(generation, requestScope, requestMode, requestLocalCwd, lines, cursorLine, cursorCol, { prefix: inline.query, items })
      }
      // No candidates: clear the snapshot (nothing to accept) — the same
      // null-clears contract as the file path, so a later direct apply
      // can never reuse an older request's dropdown.
      return this.withRequestSnapshot(generation, requestScope, requestMode, requestLocalCwd, lines, cursorLine, cursorCol, null)
    }
    // 6. PROMPT MODE leading command name (the FIRST logical line's
    // command seat only — a later line's leading `/name` is an inline
    // skill seat, never a command).
    if (options.force === true) return null
    if (cursorLine === 0 && textBeforeCursor.trimStart().startsWith('/') && !textBeforeCursor.trimStart().includes(' ')) {
      try {
        const result = await this.getSlashCommandSuggestions(lines, cursorLine, cursorCol, options)
        return this.withRequestSnapshot(generation, requestScope, requestMode, requestLocalCwd, lines, cursorLine, cursorCol, result, false)
      } catch {
        return null
      }
    }
    return null
  }

  /** The inline skill candidates for one query: the detached human skill
   * catalog filtered by the fork's fuzzy matcher (never a copied fuzzy
   * algorithm), name/label/description presentation only. The command
   * list is deliberately NOT mixed in — a skill reference is not a
   * command advertisement. */
  private suggestInlineSkills(query: string): AutocompleteItem[] {
    return fuzzyFilter([...this.skillReferences], query, skill => skill.name).map(skill => ({
      value: skill.name,
      label: skill.name,
      description: skill.description,
    }))
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

  /** Complete one `@` mention through the HostFilePort: the grammar is
   * stripped to the OFFICIAL query form, the port answers the Host
   * authority's already-ranked candidates, and this layer is
   * PRESENTATION-ONLY (the official mention grammar's quoting + labels —
   * no second ranking pass). Stale results are dropped twice: the port's
   * own abort check and the scope re-verification after the await. */
  private async completeMention(scope: HostFileScope, atPrefix: string, signal: AbortSignal): Promise<AutocompleteSuggestions | null> {
    // `scope` is captured at request entry and deliberately threaded through
    // the await. A session switch while the Host request is in flight must
    // fence the old request instead of resolving it against the new session.
    // The editor's at-prefix INCLUDES the `@`; the discovery step strips the
    // grammar so the port receives the official query form. The port returns
    // the DISPLAY paths (its contract: user-facing paths).
    const candidates = await this.discoverMention(scope, atPrefix, signal)
    if (signal.aborted || candidates.length === 0) return null
    if (!sameHostFileScope(scope, this.scopeOf())) return null
    const { quoted } = stripAtQuotes(atPrefix)
    // PRESENTATION ONLY: the port's candidates are already filtered,
    // ranked and bounded by the Host discovery authority — this layer
    // preserves their order exactly (no second client-side ranking pass
    // that could drop or reorder Host-returned candidates) and owns just
    // the `@`/quoting shape, labels and directory continuation. The `@`
    // VALUE is the official grammar's, so no Client path-query environment
    // participates here.
    const items = candidates.map(candidate =>
      presentPathCandidate(
        { path: candidate.path, kind: candidate.kind },
        { at: true, quoted },
      ))
      // The OFFICIAL grammar's refusal (a path it cannot represent safely)
      // is the grammar's authority — the candidate is filtered, exactly as
      // the official client does; this is not a second relevance judgment.
      .filter((item): item is AutocompleteItem => item !== undefined)
    if (items.length === 0) return null
    return { prefix: atPrefix, items }
  }

  /** The discovery step (separated for the abort-fence test seam). The
   *  editor's `@`/quote grammar is stripped HERE — the port receives the
   *  OFFICIAL wire query form (the path text following `@`) that
   *  `FileReferenceService.list` and the generated Remote accept. An
   *  `unavailable` capability (or a transport failure) presents as no
   *  candidates — the port keeps the two states distinct, the completion
   *  surface does not invent rows for either. */
  private async discoverMention(
    scope: HostFileScope,
    atPrefix: string,
    signal: AbortSignal,
  ): Promise<readonly HostFileCandidate[]> {
    const { raw: officialQuery } = stripAtQuotes(atPrefix)
    try {
      const result = await this.fileReferences.listReferences(scope, officialQuery, { signal })
      return result.kind === 'ok' ? result.items : []
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
  private async completePathArgument(
    argument: string,
    localCwd: string,
    signal: AbortSignal,
  ): Promise<AutocompleteSuggestions | null> {
    const items = await completeLocalPathArgument(
      argument,
      localCwd,
      this.localDiscovery,
      clientPathQueryEnvironment(),
      signal,
      { allowEmpty: true },
    )
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
    scope: HostFileScope,
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
    scope: HostFileScope,
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
  scopeAtRequestTime(): HostFileScope {
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
    if (!sameHostFileScope(snapshot.scope, this.scopeOf())) return false
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
    // INLINE SKILL REFERENCE apply (the plain-text `/name` lexicon): the
    // suggestion prefix is the QUERY part — never `/`-prefixed, so the
    // vendored editor's confirm does NOT fall through to submit. This
    // branch re-verifies the slash token position (the classifier), the
    // catalog membership AND the request snapshot before replacing
    // `/query` with `/name ` — only the current token is touched, the
    // suffix survives, and the cursor lands on the separator position
    // ready to keep typing. The snapshot must be the STRICT one this
    // provider produced (inline or extension results): a null snapshot
    // (cleared by a null result) or a non-strict legacy shell/command
    // snapshot (a different document/mode) must never apply here — a
    // catalog member at an inline seat without the strict snapshot is
    // rejected outright (identity), never handed to the fork's
    // argument-apply (which would mangle the reference).
    const inline = extractInlineSkillPrefix(lines, cursorLine, cursorCol)
    if (inline !== undefined && inline.query === prefix) {
      const isSkill = this.skillReferences.some(skill => skill.name === item.value)
      if (isSkill && this.requestSnapshot?.strict !== true) {
        return { lines, cursorLine, cursorCol }
      }
      if (isSkill) {
        const applied = applyInlineSkillReference(currentLine, inline.slashStart, cursorCol, item.value)
        const newLines = [...lines]
        newLines[cursorLine] = applied.line
        return {
          lines: newLines,
          cursorLine,
          cursorCol: applied.cursorCol,
        }
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
      // Shell amendment (M3-4 PR3): without Host shell facts (Remote) a
      // shell line triggers NOTHING — the request itself would fall through
      // to the Client-filesystem path provider.
      if (!this.hostShellCompletion) return false
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
    // classifier's `path-argument` (a tab-separated `/image\t` IS an
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
