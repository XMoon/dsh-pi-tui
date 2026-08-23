/**
 * Host editor subclass: kimi CustomEditor parity for `@dir/` mention
 * completion (AGENTS.md decision 8 — consumer-side, the vendored fork
 * stays pristine). After every handled key, if the cursor sits on an
 * `@dir/` mention with the autocomplete closed, re-trigger completion so
 * Tab-accepting a directory immediately shows its children (kimi's
 * reopenAutocompleteAfterInput). Esc while autocomplete is active closes
 * it WITHOUT re-triggering (kimi parity).
 *
 * The editor also carries the terminal-prompt `❯ ` prefix: the fork's
 * Editor is constructed with `paddingX: 2` (kimi's CustomEditor reserves
 * padding for its `>` prompt the same way), and render() paints the
 * prompt over the first content row's leading padding — kimi's
 * injectPromptSymbol pattern, consumer-side only. The prompt reads like
 * the transcript's user messages (`❯ text`), so what the user is about
 * to send matches what their sent input looks like.
 * @module @xmoon76/dsh-pi-tui/tui-editor
 */

import { Editor, matchesKey, truncateToWidth, type EditorTheme, type TUI } from '@xmoon76/pi-tui'
import { color } from './theme.ts'
import { extractAtPrefix } from './mentions.ts'

/** The fork's private autocomplete surface (runtime methods; kimi's
 * CustomEditor uses the same cast idiom). */
interface AutocompleteInternals {
  cancelAutocomplete(): void
  requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void
}

/** Visible width of the `❯ ` prompt — must equal the editor's paddingX,
 * so content and wrapped continuations start right after the prompt. */
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
 * Paint the terminal-prompt `❯ ` over the first content row of the fork's
 * editor render. The fork renders every content row with `paddingX` spaces
 * on each side; the first visible content row's leading padding is replaced
 * by the prompt (kimi's injectPromptSymbol, which requires the same leading
 * padding). Wrapped continuation rows keep their padding, so they indent
 * under the prompt exactly like the transcript's user-message bullet
 * (BulletedComponent). No SGR is emitted for the trailing space, so the
 * text after the prompt keeps its own colouring.
 *
 * When the draft is scrolled (the fork paints `↑ N more` as the top row),
 * the first visible row is NOT the first line of the draft, so no prompt is
 * painted — a floating `❯` on a continuation line would lie about where the
 * input starts (kimi paints unconditionally; the scroll indicator makes the
 * skip unambiguous here).
 */
function injectEditorPrompt(lines: string[]): string[] {
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
  lines[1] = `${color.roleUser('❯')} ${first.slice(PROMPT_WIDTH)}`
  return lines
}

/**
 * Paint a render-time PLACEHOLDER hint over an EMPTY draft (the subagent
 * viewer's `Message <label>…` affordance): `❯ <dim hint>` with the cursor
 * block staying at its own position after the text. The placeholder is a
 * presentation-only overlay — it never becomes part of the draft
 * (`getText()` stays empty), so typing over it edits a clean buffer. Same
 * structure as {@link injectEditorPrompt}: the first content row's leading
 * padding is replaced by the prompt, the hint is inserted between the
 * prompt and the (still positioned) cursor.
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
  /** The render-time placeholder hint (empty draft only). */
  private placeholderText = ''

  constructor(tui: TUI, theme: EditorTheme) {
    // paddingX: 2 reserves the left two cells for the `❯ ` prompt painted
    // by render(). Content and wrapped continuations start at column 2,
    // matching the transcript's user-message bullet indent, and the layout
    // width the fork uses for cursor navigation/wrapping stays in sync.
    super(tui, theme, { paddingX: PROMPT_WIDTH })
  }

  /** Show a dim placeholder hint while the draft is EMPTY (e.g. the
   * subagent viewer's "Message <label>…"). Presentation-only: the hint is
   * never part of the draft text. Pass `''` to clear. */
  setPlaceholder(text: string): void {
    this.placeholderText = text
  }

  override render(width: number): string[] {
    const lines = super.render(width)
    if (this.placeholderText !== '' && this.getText().trim() === '') {
      return injectEditorPlaceholder(lines, this.placeholderText, width)
    }
    return injectEditorPrompt(lines)
  }

  override handleInput(data: string): void {
    // Esc + autocomplete activity: close WITHOUT re-triggering (kimi
    // parity — otherwise Esc would immediately reopen the list).
    if (matchesKey(data, 'escape') && this.isShowingAutocomplete()) {
      ;(this as unknown as AutocompleteInternals).cancelAutocomplete()
      return
    }
    super.handleInput(data)
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
