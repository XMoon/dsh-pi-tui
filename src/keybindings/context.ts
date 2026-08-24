/**
 * The context contract of the keybinding resolver (plan §6). The type
 * itself lives in types.ts; this module adds the pure derivation helper so
 * components and tests build a context from a narrow state view without
 * reaching into TuiApp.
 * @module @xmoon76/dsh-pi-tui/keybindings/context
 */

import type { KeybindingContext } from './types.ts'

/** A partial state view sufficient to derive a {@link KeybindingContext}. */
export interface KeybindingContextState {
  readonly questionActive?: boolean
  readonly approvalActive?: boolean
  readonly viewerMode?: 'none' | 'readonly' | 'continuable'
  readonly searchActive?: boolean
  readonly overlayActive?: boolean
  readonly agentRunning?: boolean
  /** A boolean, or a LAZY thunk (the resolver only evaluates it when a
   * rule predicate needs it — the live editor must not be read on every
   * keystroke). */
  readonly editorEmpty?: boolean | (() => boolean)
  readonly autocompleteActive?: boolean
  readonly tasksActive?: boolean
  readonly focusedSeat?: 'editor' | 'overlay' | 'editor-panel' | 'none'
}

/** Derive a complete context from a partial state view (defaults: the
 * idle main-editor state). TuiApp's `keybindingContext()` and the focused
 * components both use this, so the resolver never reads live fields
 * directly. */
export function deriveKeybindingContext(state: KeybindingContextState = {}): KeybindingContext {
  const editorEmpty = state.editorEmpty ?? true
  return {
    focusedSeat: state.focusedSeat ?? 'editor',
    questionActive: state.questionActive ?? false,
    approvalActive: state.approvalActive ?? false,
    viewerMode: state.viewerMode ?? 'none',
    searchActive: state.searchActive ?? false,
    overlayActive: state.overlayActive ?? false,
    agentRunning: state.agentRunning ?? false,
    // LAZY: reading the live editor on every keystroke would add a draft
    // read to the input path (the input-router test asserts exactly one
    // read per printable key). The getter defers to the thunk.
    get editorEmpty() {
      return typeof editorEmpty === 'function' ? editorEmpty() : editorEmpty
    },
    autocompleteActive: state.autocompleteActive ?? false,
    tasksActive: state.tasksActive ?? false,
  }
}
