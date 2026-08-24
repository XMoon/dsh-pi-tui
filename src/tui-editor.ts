/**
 * Host editor subclass: kimi CustomEditor parity for `@dir/` mention
 * completion (AGENTS.md decision 8 — consumer-side, the vendored fork
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
import { extractAtPrefix } from './mentions.ts'
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

/** Whether the text before the cursor is a slash-command line WITH an
 * argument position (`/cmd <arg>`): the command name is the first
 * whitespace-delimited (space OR tab — the fork's path delimiters) token
 * after the leading `/`; anything after it is the argument the completion
 * re-trigger targets. */
function isSlashCommandArgument(textBeforeCursor: string): boolean {
  const trimmed = textBeforeCursor.trimStart()
  if (!trimmed.startsWith('/')) return false
  const separatorIndex = trimmed.search(/[ \t]/)
  if (separatorIndex <= 0) return false
  const commandName = trimmed.slice(1, separatorIndex)
  return commandName !== '' && !commandName.includes('/')
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
  /** Whether the editor was empty when a bracketed paste began (the
   * paste-normalization gate: a paste into a NON-empty editor is never
   * reinterpreted as a shell line). */
  private pasteStartEmpty: boolean | null = null

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

  /** Switch the input mode. A real change fires onChange (the host's
   * viewer-draft mirror and seat subscribers must observe the wire form
   * changing even when the body text did not). */
  setInputMode(mode: EditorInputMode): void {
    if (this.inputMode === mode) return
    this.inputMode = mode
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
    // Esc + autocomplete activity: close WITHOUT re-triggering (kimi
    // parity — otherwise Esc would immediately reopen the list). This
    // keeps its priority over the shell-mode Esc exit below.
    if (matchesKey(data, 'escape') && this.isShowingAutocomplete()) {
      ;(this as unknown as AutocompleteInternals).cancelAutocomplete()
      return
    }
    // Track whether the editor was empty when a bracketed paste began: a
    // paste that lands in an EMPTY prompt and starts with `!` / `!!` is
    // normalized into a shell-mode entry (kimi parity — typed-key
    // interception does not cover bracketed paste). A paste into a
    // non-empty editor is never reinterpreted.
    if (data.includes('\x1b[200~')) this.pasteStartEmpty = this.getText() === ''
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
    super.handleInput(data)
    // Paste normalization runs AFTER the base pipeline applied the paste
    // (the fork's handlePaste is private): one synchronous pass, so no
    // intermediate `❯ !!git status` frame is ever visible.
    if (data.includes('\x1b[201~')) {
      const startedEmpty = this.pasteStartEmpty
      this.pasteStartEmpty = null
      if (startedEmpty === true) {
        const { mode, text } = editorModeFromHistoryEntry(this.getText())
        if (mode !== 'prompt') {
          this.setInputMode(mode)
          this.setText(text)
        }
      }
    }
    this.reopenAutocompleteAfterInput()
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
    if (textBeforeCursor.endsWith('/') && (extractAtPrefix(textBeforeCursor) !== null || isSlashCommandArgument(textBeforeCursor))) {
      ;(this as unknown as AutocompleteInternals)
        .requestAutocomplete({ force: false, explicitTab: false })
    }
  }
}
