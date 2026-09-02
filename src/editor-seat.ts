/**
 * The EditorSeat (M9, plan §14): the narrow seam between TuiApp and
 * whatever editor occupies the editor seat. The host editor (the fork's
 * Editor) is the DEFAULT implementation; a plugin editor (Editor SDK,
 * single-winner) can replace it through an atomic handoff.
 *
 * The seat contract keeps EVERY host invariant intact (plan §14.3): the
 * host owns busy-Enter, Ctrl+Enter, local-command classification, paste
 * protection, approval/question capture, session guard/lock, external
 * editor, and exit — the seat only carries TEXT, CURSOR, FOCUS, history,
 * autocomplete, and the border style. A plugin editor can never bypass
 * those through this seam.
 *
 * The PHYSICAL mount slot ({@link EditorSeatMount}) is deliberately
 * NON-OWNING (re-vendor lifecycle follow-up P1): it only projects the
 * current occupant — the EditorSeatHolder owns the replacement editor and
 * its compiled component, the question flow state owns the QuestionFrame.
 * mount/detach ≠ dispose; only handoff / final teardown dispose.
 * @module @xmoon76/dsh-pi-tui/editor-seat
 */

import { Container, type Component } from '@xmoon76/pi-tui'

/**
 * The non-owning physical mount slot inside the editor seat (re-vendor
 * lifecycle follow-up P1). The vendored Container is an OWNING container
 * (X007: clear/removeChild/dispose release child resources), but the seat
 * is only a mounting point — replacing the occupant (editor ↔ QuestionFrame
 * ↔ editor) must NEVER dispose it:
 *
 * ```text
 * EditorSeatHolder ── owns the replacement editor + compiled component
 * EditorSeatMount ── projects the CURRENT occupant, never disposes it
 * Question state ─── owns the QuestionFlow / QuestionFrame lifetime
 * ```
 *
 * This is the same principle as the transcript projection model:
 * mount/projection ≠ lifecycle ownership. Every owning Container method
 * (removeChild/clear/dispose) is overridden to only re-point `children` —
 * the seat can never accidentally dispose a mounted component through the
 * vendored owning semantics.
 */
export class EditorSeatMount extends Container {
  /** Swap the current occupant without touching its lifecycle. */
  replace(component: Component): void {
    this.children = [component]
  }

  /** Detach the current occupant without disposing it. */
  detach(): void {
    this.children = []
  }

  override removeChild(component: Component): void {
    const index = this.children.indexOf(component)
    if (index !== -1) this.children.splice(index, 1)
  }

  override clear(): void {
    this.children = []
  }

  override dispose(): void {
    this.children = []
  }
}

/** The fork's autocomplete provider shape (structural — the host's
 * MentionProvider chain). */
export interface EditorSeatAutocompleteProvider {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<{ items: unknown[]; prefix: string } | null>
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: unknown,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number }
  shouldTriggerFileCompletion?(lines: string[], cursorLine: number, cursorCol: number): boolean
}

/** The editor-seat surface TuiApp consumes (the ONLY editor access the
 * host uses — plan §14: business code stops scattering this.editor.*). */
export interface EditorSeat {
  /** The current draft text. */
  getText(): string
  /** Replace the draft wholesale. */
  setText(text: string): void
  /** The cursor offset within the draft. */
  getCursor?(): number
  setCursor?(offset: number): void
  /** Whether the editor currently owns keyboard focus. */
  readonly focused: boolean
  /** The border-color style hook (plan mode/viewer tint it). */
  borderColor: (text: string) => string
  /** Invalidate the render cache (theme switches etc.). */
  invalidate(): void
  /** Add one line to the input history (recall). */
  addToHistory(text: string): void
  /** Clear the input history (session switch). */
  clearHistory(): void
  /** Install the autocomplete provider chain. */
  setAutocompleteProvider(provider: EditorSeatAutocompleteProvider): void
  /** Whether the autocomplete list is currently showing. */
  isShowingAutocomplete?(): boolean
  /** Submit hook (the host's Enter path). */
  onSubmit: ((text: string) => void) | undefined
  /** Change hook (draft mutated). */
  onChange: (() => void) | undefined
  /** The wrapped component to mount in the editor seat. */
  readonly component: import('@xmoon76/pi-tui').Component
}

/**
 * The seat's runtime editor state handed to a plugin editor at handoff
 * (plan §14.2 — atomic: create next → transfer draft/cursor → mount →
 * focus → dispose old).
 */
export interface EditorTransferState {
  readonly text: string
  readonly cursor: number
}
