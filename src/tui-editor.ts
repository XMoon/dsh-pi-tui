/**
 * Host editor subclass: kimi CustomEditor parity for `@dir/`/`@dir\\`
 * mention completion (AGENTS.md decision 8 — consumer-side, the vendored fork
 * stays pristine). After every handled key, if the cursor sits on an
 * `@dir/` mention with the autocomplete closed, re-trigger completion so
 * Tab-accepting a directory immediately shows its children (kimi's
 * reopenAutocompleteAfterInput). Esc while autocomplete is active closes
 * it WITHOUT re-triggering (kimi parity).
 *
 * The editor also carries the terminal-prompt prefix: the fork's Editor is
 * constructed with `paddingX: 2` (kimi's CustomEditor reserves padding for
 * its `>` prompt the same way), and render() paints the prompt over the
 * first content row's leading padding — kimi's injectPromptSymbol
 * pattern, consumer-side only. The prompt is MODE-DRIVEN (the
 * shell-editor-mode plan): `❯ ` in prompt mode, `! ` in shell-context
 * mode and `!!` in shell-local mode — all exactly two cells wide, so the
 * editable body and cursor never jump when the mode changes. The `!` /
 * `!!` prefixes are editor STATE, never document text: the buffer holds
 * the bare command body, and the mode is serialized back into the
 * existing textual `!` / `!!` protocol only at host boundaries.
 * @module @xmoon76/dsh-pi-tui/tui-editor
 */

import { decodePrintableKey, Editor, matchesKey, truncateToWidth, type EditorTheme, type TUI } from '@xmoon76/pi-tui'
import { color } from './theme.ts'
import { classifyFileCompletionContext, FILE_ARGUMENT_COMMANDS } from './file-completion/context.ts'
import { editorModeFromHistoryEntry, type EditorInputMode } from './editor-input-mode.ts'

/** The fork's private autocomplete surface (runtime methods; kimi's
 * CustomEditor uses the same cast idiom). */
interface AutocompleteInternals {
  cancelAutocomplete(): void
  requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void
}

/** Visible width of the mode prompt — must equal the editor's paddingX,
 * so content and wrapped continuations start right after the prompt. All
 * three prompts (`❯ `, `! `, `!!`) are exactly this wide. */
const PROMPT_WIDTH = 2

/** Whether the cursor sits in a declared path-argument position (`/image
 * <arg>`): the classifier's `image-argument` kind, which the reopen gate
 * consumes (plan §11 — ONE classifier, never a per-command hardcode). */
function isFileArgumentContext(textBeforeCursor: string): boolean {
  return classifyFileCompletionContext(textBeforeCursor, FILE_ARGUMENT_COMMANDS).kind !== 'none'
}

/**
 * Paint the mode prompt over the first content row of the fork's editor
 * render. The fork renders every content row with `paddingX` spaces on
 * each side; the first visible content row's leading padding is replaced
 * by the prompt (kimi's injectPromptSymbol, which requires the same
 * leading padding). Wrapped continuation rows keep their padding, so they
 * indent under the prompt exactly like the transcript's user-message
 * bullet (BulletedComponent). No SGR is emitted for the trailing space, so
 * the text after the prompt keeps its own colouring.
 *
 * When the draft is scrolled (the fork paints `↑ N more` as the top row),
 * the first visible row is NOT the first line of the draft, so no prompt
 * is painted — a floating prompt on a continuation line would lie about
 * where the input starts (kimi paints unconditionally; the scroll
 * indicator makes the skip unambiguous here).
 */
function injectEditorPrompt(lines: string[], mode: EditorInputMode): string[] {
  if (lines.length < 3) return lines
  // Top row: a plain border when the editor is at the top of the draft, a
  // `─── ↑ N more ───` scroll indicator when scrolled. The ↑ never appears
  // in a plain border.
  if (lines[0]!.includes('↑')) return lines
  const first = lines[1]!
  if (first.length < PROMPT_WIDTH) return lines
  for (let i = 0; i < PROMPT_WIDTH; i++) {
    if (first[i] !== ' ') return lines
  }
  // All three prompts are exactly PROMPT_WIDTH cells: `❯ ` (roleUser),
  // `! ` and `!!` (both shellMode). The trailing space of `❯ `/`! ` is
  // unpainted so the body keeps its own colouring.
  const prompt = mode === 'prompt'
    ? `${color.roleUser('❯')} `
    : mode === 'shell-context'
      ? `${color.shellMode('!')} `
      : color.shellMode('!!')
  lines[1] = `${prompt}${first.slice(PROMPT_WIDTH)}`
  return lines
}

/**
 * Paint a render-time PLACEHOLDER hint over an EMPTY prompt-mode draft
 * (the subagent viewer's `Message <label>…` affordance): `❯ <dim hint>`
 * with the cursor block staying at its own position after the text. The
 * placeholder is a presentation-only overlay — it never becomes part of
 * the draft (`getText()` stays empty), so typing over it edits a clean
 * buffer. Same structure as {@link injectEditorPrompt}: the first content
 * row's leading padding is replaced by the prompt, the hint is inserted
 * between the prompt and the (still positioned) cursor. Shell modes never
 * show a placeholder — the shell prompt itself is the affordance.
 */
function injectEditorPlaceholder(lines: string[], placeholder: string, width: number): string[] {
  if (lines.length < 3) return lines
  // Top row: a plain border when the editor is at the top of the draft, a
  // `─── ↑ N more ───` scroll indicator when scrolled. The ↑ never appears
  // in a plain border — an empty draft is never scrolled, but the guard
  // keeps the invariant cheap.
  if (lines[0]!.includes('↑')) return lines
  const first = lines[1]!
  if (first.length < PROMPT_WIDTH) return lines
  for (let i = 0; i < PROMPT_WIDTH; i++) {
    if (first[i] !== ' ') return lines
  }
  // The hint shares the row with the prompt + the cursor block: reserve
  // the prompt and one trailing cell so the row never overflows.
  const hint = truncateToWidth(placeholder, Math.max(1, width - PROMPT_WIDTH - 2), '…')
  lines[1] = `${color.roleUser('❯')} ${color.textDim(hint)}${first.slice(PROMPT_WIDTH)}`
  return lines
}

export class TuiEditor extends Editor {
  /** The render-time placeholder hint (empty prompt-mode draft only). */
  private placeholderText = ''
  /** The current input mode: `!` / `!!` are state, never document text. */
  private inputMode: EditorInputMode = 'prompt'
  /** An in-flight bracketed paste captured at the RAW layer: whether it
   * began in an EMPTY PROMPT (the normalization gate) and the content
   * accumulated so far. While set, every input chunk belongs to the
   * paste and is buffered here — never passed to the base editor. */
  private pasteCapture: { promptEmpty: boolean; buffer: string } | null = null
  /** A trailing `\x1b[20` / `\x1b[200` / `\x1b[201` chunk tail that may
   * be a paste marker split across chunks; stitched onto the next chunk
   * at the top of handleInput. */
  private pendingPasteMarker: string | null = null

  constructor(tui: TUI, theme: EditorTheme) {
    // paddingX: 2 reserves the left two cells for the mode prompt painted
    // by render(). Content and wrapped continuations start at column 2,
    // matching the transcript's user-message bullet indent, and the layout
    // width the fork uses for cursor navigation/wrapping stays in sync.
    super(tui, theme, { paddingX: PROMPT_WIDTH })
    // Dynamic border: shell modes use the shellMode token, the prompt the
    // normal border. The function reads the LIVE color helpers on every
    // call, so a theme switch repaints correctly (never a cached Chalk
    // function tied to a stale palette). The host's focus/plan/approval
    // overrides keep their precedence — they replace this function while
    // active and restore it (via the captured editorBorder) afterwards.
    this.borderColor = (text) => this.inputMode === 'prompt' ? color.border(text) : color.shellMode(text)
    // History recall decodes the serialized entry into mode + body; the
    // draft save/restore pair keeps the mode across ↑/↓ browsing (a draft
    // recalled as `!!pwd` must never come back as `❯ pwd`).
    this.onRecall = (entry) => {
      const { mode, text } = editorModeFromHistoryEntry(entry)
      this.setInputMode(mode)
      return text
    }
    this.onHistoryDraftSave = () => this.inputMode
    this.onHistoryDraftRestore = (state) => {
      if (state === 'prompt' || state === 'shell-context' || state === 'shell-local') {
        this.setInputMode(state)
      }
    }
  }

  /** The current input mode (read-only for the host). */
  getInputMode(): EditorInputMode {
    return this.inputMode
  }

  /** Close any open autocomplete dropdown and abort any pending completion
   * request (the host-owned stale-context guard — the declined-key
   * fallback cancels when the staged document differs from the host's
   * current autocomplete context, so a stale dropdown can never accept
   * candidates into the new document). Named distinctly: the fork's own
   * `cancelAutocomplete` is private and MUST stay reachable for its
   * internal callers — a same-named override would shadow it and recurse. */
  cancelHostAutocomplete(): void {
    ;(this as unknown as AutocompleteInternals).cancelAutocomplete()
  }

  /** Switch the input mode. A real change fires onChange (the host's
   * viewer-draft mirror and seat subscribers must observe the wire form
   * changing even when the body text did not) and CANCELS any open
   * autocomplete: a mode change swaps the completion grammar, and a
   * dropdown built for the old mode's context must not survive (a
   * prompt-mode file list would otherwise accept suggestions into a
   * shell body). */
  setInputMode(mode: EditorInputMode): void {
    if (this.inputMode === mode) return
    this.inputMode = mode
    ;(this as unknown as AutocompleteInternals).cancelAutocomplete()
    this.onChange?.(this.getText())
    this.tui.requestRender()
  }

  /** Show a dim placeholder hint while the draft is EMPTY (e.g. the
   * subagent viewer's "Message <label>…"). Presentation-only: the hint is
   * never part of the draft text. Pass `''` to clear. */
  setPlaceholder(text: string): void {
    this.placeholderText = text
  }

  /**
   * Replace the draft with a SERIALIZED user input line (`!!x` →
   * shell-local + `x`, `!x` → shell-context + `x`, anything else →
   * prompt + text). The single decode point for every host restore path
   * (blocked submissions, history accepts, dequeues, viewer restores) —
   * callers never re-implement prefix parsing.
   */
  setSerializedInput(text: string): void {
    const { mode, text: body } = editorModeFromHistoryEntry(text)
    this.setInputMode(mode)
    this.setText(body)
  }

  /** Test seam: the current mode (read-only). */
  inputModeForTest(): EditorInputMode {
    return this.inputMode
  }

  override render(width: number): string[] {
    const lines = super.render(width)
    if (this.inputMode === 'prompt' && this.placeholderText !== '' && this.getText().trim() === '') {
      return injectEditorPlaceholder(lines, this.placeholderText, width)
    }
    return injectEditorPrompt(lines, this.inputMode)
  }

  override handleInput(data: string): void {
    // A bracketed-paste marker split across input chunks (real terminals
    // keep markers whole, but a chunk boundary must not lose them):
    // stitch a buffered marker prefix onto this chunk, and buffer a
    // trailing prefix for the next one.
    data = this.stitchPendingPasteMarker(data)
    data = this.bufferTrailingPasteMarker(data)
    // Esc + autocomplete activity: close WITHOUT re-triggering (kimi
    // parity — otherwise Esc would immediately reopen the list). This
    // keeps its priority over the shell-mode Esc exit below.
    if (matchesKey(data, 'escape') && this.isShowingAutocomplete()) {
      ;(this as unknown as AutocompleteInternals).cancelAutocomplete()
      return
    }
    // Esc on an EMPTY shell body cancels the whole shell mode (the app
    // passes Esc through only in this state — see the app's escape
    // branch). The autocomplete branch above already won when the
    // dropdown is open.
    if (matchesKey(data, 'escape') && this.inputMode !== 'prompt' && this.getText() === '') {
      this.setInputMode('prompt')
      return
    }
    // Backspace on an EMPTY shell body steps the mode back:
    // shell-local -> shell-context -> prompt. A non-empty body keeps the
    // normal editor Backspace behavior.
    if (matchesKey(data, 'backspace') && this.inputMode !== 'prompt' && this.getText() === '') {
      this.setInputMode(this.inputMode === 'shell-local' ? 'shell-context' : 'prompt')
      return
    }
    // A typed `!` on an EMPTY body enters the shell modes — no debounce,
    // no ambiguous waiting state, each key produces a complete state. The
    // consumed prefix keystrokes never reach the base editor.
    const printable = decodePrintableKey(data) ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined)
    if (printable === '!') {
      if (this.inputMode === 'prompt' && this.getText() === '') {
        this.setInputMode('shell-context')
        return
      }
      if (this.inputMode === 'shell-context' && this.getText() === '') {
        this.setInputMode('shell-local')
        return
      }
      // shell-local + empty: `!` is an ordinary body character (no fourth
      // mode — intentional, guarded by a test).
    }
    // Closed-dropdown Tab is explicit and context-gated. In prompt mode the
    // host provider owns only `@` and declared path arguments; ordinary prose
    // and ordinary paths must not fall through to the fork's broad file
    // completion. A slash command name is the one non-file case delegated to
    // the fork so command-name completion remains intact.
    if (matchesKey(data, 'tab') && !this.isShowingAutocomplete() && this.inputMode === 'prompt') {
      const { line, col } = this.getCursor()
      const beforeCursor = this.getLines()[line]?.slice(0, col) ?? ''
      const context = classifyFileCompletionContext(beforeCursor, FILE_ARGUMENT_COMMANDS)
      if (context.kind === 'mention' || context.kind === 'image-argument') {
        ;(this as unknown as AutocompleteInternals)
          .requestAutocomplete({ force: true, explicitTab: true })
        return
      }
      const trimmed = beforeCursor.trimStart()
      if (/^\/[^\s/]*$/.test(trimmed)) {
        // Let the fork resolve slash-command names (`/he`, including an
        // indented form after its provider-side normalization).
      } else {
        // Still run the provider request so the separate extension
        // autocomplete chain can answer ordinary positions. MentionProvider's
        // host file branch remains closed for this `none` context.
        ;(this as unknown as AutocompleteInternals)
          .requestAutocomplete({ force: true, explicitTab: true })
        return
      }
    }
    // Tab on a leading `/` in a shell mode is a PATH, never a slash
    // command: the fork's handleTabCompletion routes a space-free
    // leading-`/` line to slash-command completion, which would list
    // commands for `/usr/lo`. Force the file-completion path instead
    // (the provider's virtual prefix keeps the shell grammar intact).
    // An open dropdown keeps Tab as accept — only a closed one routes.
    if (matchesKey(data, 'tab') && !this.isShowingAutocomplete() && this.inputMode !== 'prompt') {
      const { line, col } = this.getCursor()
      const beforeCursor = this.getLines()[line]?.slice(0, col) ?? ''
      const trimmed = beforeCursor.trimStart()
      if (trimmed.startsWith('/') && !trimmed.includes(' ')) {
        ;(this as unknown as AutocompleteInternals)
          .requestAutocomplete({ force: true, explicitTab: true })
        return
      }
    }
    // Bracketed paste: captured at the RAW layer BEFORE the base editor
    // sees it. The prefix normalization therefore happens PRE-INSERT —
    // the base editor's undo snapshots contain the NORMALIZED body, so
    // undoing a normalized paste can never resurrect a raw `!!` in the
    // document (the shell-editor-mode invariant: prefixes are state,
    // never document text). Large pastes (>10 lines / >1000 chars) keep
    // the fork's paste-registry path because the stripped content is
    // re-wrapped as a bracketed paste below.
    if (this.pasteCapture !== null || data.includes('\x1b[200~')) {
      // Drain paste chunks ITERATIVELY: one input chunk may carry many
      // complete paste segments — recursion per segment would overflow
      // the stack. The autocomplete reopen runs AFTER the normalized
      // pastes and the residual input landed, so a pasted `@dir/` reopens
      // like ordinary input.
      this.processPasteChunks(data)
      this.reopenAutocompleteAfterInput()
      return
    }
    if (data !== '') super.handleInput(data)
    this.triggerNonstandardMentionCompletion(data)
    this.reopenAutocompleteAfterInput()
  }

  /** Trigger the provider for mention boundaries that the vendored editor's
   * generic symbol gate does not know about (CJK glue and `=`/quote
   * delimiters). Ordinary prose and path positions remain untouched; the
   * shared classifier is the only file-context decision point. */
  private triggerNonstandardMentionCompletion(data: string): void {
    if (this.isShowingAutocomplete()) return
    const printable = decodePrintableKey(data) ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined)
    // Virtual terminals and paste-like test seams may deliver several plain
    // characters in one input event. Escape sequences are navigation/control
    // keys, not text, even though their bytes include printable characters.
    if (printable === undefined && data.includes('\x1b')) return
    if (printable === undefined && ![...data].some(character => character.charCodeAt(0) >= 32)) return
    const { line, col } = this.getCursor()
    const before = this.getLines()[line]?.slice(0, col) ?? ''
    const context = classifyFileCompletionContext(before, FILE_ARGUMENT_COMMANDS)
    if (context.kind !== 'mention') return
    const beforeAt = before[context.range.start - 1]
    // Start/space/tab are already handled by the fork for bare mentions. Its
    // generic gate does not reliably recognize quoted forms (`@"...`),
    // including when they begin after whitespace, so the classified quoted
    // context is an explicit exception. Nonstandard boundaries (`=`, CJK,
    // quote delimiters) are also owned by this consumer-side trigger and must
    // work when a real terminal delivers one key per input event.
    const quotedMention = context.query.startsWith('@"')
    const nonstandardBoundary = beforeAt !== undefined && beforeAt !== ' ' && beforeAt !== '\t'
    if (!quotedMention && !nonstandardBoundary) return
    ;(this as unknown as AutocompleteInternals)
      .requestAutocomplete({ force: false, explicitTab: false })
  }

  /** Stitch a buffered paste-marker prefix onto this chunk. */
  private stitchPendingPasteMarker(data: string): string {
    if (this.pendingPasteMarker !== null) {
      data = this.pendingPasteMarker + data
      this.pendingPasteMarker = null
    }
    return data
  }

  /** Buffer a trailing paste-marker prefix for the next chunk: any
   * suffix that is a proper prefix of `\x1b[200~` / `\x1b[201~` — except
   * a LONE `\x1b`, which IS the complete Esc key (buffering it would
   * delay every Esc press; real terminals write a paste marker
   * atomically, so a split after the first byte is not observable in
   * practice). A complete `~`-terminated marker is never a split prefix.
   * The tail lengths are FULL byte counts (`\x1b` is one char).
   *
   * TRADEOFF (documented): a stitched sequence that never forms a real
   * marker flows through the normal chain — this also REPAIRS split CSI
   * sequences (`\x1b[A` arriving as `\x1b[` + `A`), which the fork
   * otherwise drops. The only loss is an input stream that ENDS with an
   * incomplete CSI tail and never delivers the continuation — real
   * terminals send each key's sequence atomically, so this does not
   * occur in practice, and the upstream editor is strictly worse (it
   * loses the tail immediately). */
  private bufferTrailingPasteMarker(data: string): string {
    if (data.endsWith('~')) return data
    let markerTail = 0
    if (data.endsWith('\x1b[201') || data.endsWith('\x1b[200')) markerTail = 5
    else if (data.endsWith('\x1b[20')) markerTail = 4
    else if (data.endsWith('\x1b[2')) markerTail = 3
    else if (data.endsWith('\x1b[')) markerTail = 2
    if (markerTail === 0) return data
    this.pendingPasteMarker = data.slice(-markerTail)
    return data.slice(0, -markerTail)
  }

  /** Drain one input chunk that contains paste markers ITERATIVELY. Each
   * iteration re-runs the marker stitch/tail buffering, then feeds the
   * chunk to {@link capturePaste}; the residual (trailing keys or the
   * next paste segment) becomes the next iteration. An ordinary residual
   * (no marker) goes through the full interception chain — exactly one
   * level, since it cannot re-enter the paste branch without a marker. */
  private processPasteChunks(initial: string): void {
    let chunk = initial
    for (;;) {
      chunk = this.stitchPendingPasteMarker(chunk)
      chunk = this.bufferTrailingPasteMarker(chunk)
      if (this.pasteCapture === null && !chunk.includes('\x1b[200~')) {
        if (chunk !== '') this.handleInput(chunk)
        return
      }
      const residuals = this.capturePaste(chunk)
      const residual = residuals.length > 0 ? residuals[0]! : ''
      if (residual === '') return
      chunk = residual
    }
  }

  /** Accumulate one raw bracketed-paste chunk; on the closing marker,
   * normalize (empty-prompt `!` / `!!` prefix → shell mode, prefix
   * stripped) and hand the stripped content to the base editor as a
   * re-wrapped bracketed paste, so the fork's full handlePaste path
   * (text normalization, large-paste registry, atomic undo) applies. A
   * paste into a non-empty editor, or into an already-shell-mode editor,
   * is never reinterpreted — its `!` is ordinary body text. Returns the
   * residual input (trailing keys after the closing marker) for the
   * caller to route through the full interception chain. */
  private capturePaste(data: string): string[] {
    const residuals: string[] = []
    if (this.pasteCapture === null) {
      const start = data.indexOf('\x1b[200~')
      const before = data.slice(0, start)
      if (before !== '') {
        // Residual input BEFORE the opening marker goes through the FULL
        // interception chain FIRST — a `!` in the same chunk enters the
        // shell mode and the paste then lands in that state (`!\x1b[200~cmd…`
        // is a shell command, never a prompt with a literal `!`).
        this.handleInput(before)
      }
      this.pasteCapture = { promptEmpty: this.inputMode === 'prompt' && this.getText() === '', buffer: '' }
      data = data.slice(start + '\x1b[200~'.length)
    }
    const end = data.indexOf('\x1b[201~')
    if (end === -1) {
      this.pasteCapture.buffer += data
      return residuals
    }
    this.pasteCapture.buffer += data.slice(0, end)
    const capture = this.pasteCapture
    this.pasteCapture = null
    let content = capture.buffer
    let mode: EditorInputMode = 'prompt'
    if (capture.promptEmpty && content.startsWith('!!')) {
      mode = 'shell-local'
      content = content.slice(2)
    } else if (capture.promptEmpty && content.startsWith('!')) {
      mode = 'shell-context'
      content = content.slice(1)
    }
    if (mode !== 'prompt') this.setInputMode(mode)
    if (content !== '') super.handleInput(`\x1b[200~${content}\x1b[201~`)
    const remaining = data.slice(end + '\x1b[201~'.length)
    if (remaining !== '') residuals.push(remaining)
    return residuals
  }

  /** Reopen `@dir/` mention completion right after a key closed it (e.g.
   * Tab accepted a directory), and the same for a slash-command path
   * argument (`/image subdir/`): the editor's natural trigger only fires on
   * letters, so a freshly accepted trailing `/` would otherwise leave the
   * children hidden until the next keystroke. Mirrors kimi's
   * reopenAutocompleteAfterInput for the @-mention case, extended to
   * path-argument commands. */
  private reopenAutocompleteAfterInput(): void {
    if (this.isShowingAutocomplete()) return
    const { line, col } = this.getCursor()
    const textBeforeCursor = this.getLines()[line]?.slice(0, col) ?? ''
    // ONE classifier (plan §11): `@dir/` mentions AND `/image dir/` arguments
    // reopen through the same directory-shaped context gate — never a
    // per-command hardcode, and never a plain trailing `/` (a `see /tmp/`
    // position stays closed).
    if ((textBeforeCursor.endsWith('/') || textBeforeCursor.endsWith('\\')) && isFileArgumentContext(textBeforeCursor)) {
      ;(this as unknown as AutocompleteInternals)
        .requestAutocomplete({ force: false, explicitTab: false })
    }
  }
}
