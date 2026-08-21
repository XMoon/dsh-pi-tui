/**
 * Host editor subclass: kimi CustomEditor parity for `@dir/` mention
 * completion (AGENTS.md decision 8 — consumer-side, the vendored fork
 * stays pristine). After every handled key, if the cursor sits on an
 * `@dir/` mention with the autocomplete closed, re-trigger completion so
 * Tab-accepting a directory immediately shows its children (kimi's
 * reopenAutocompleteAfterInput). Esc while autocomplete is active closes
 * it WITHOUT re-triggering (kimi parity).
 * @module @xmoon76/dsh-pi-tui/tui-editor
 */

import { Editor, matchesKey } from '@xmoon76/pi-tui'
import { extractAtPrefix } from './mentions.ts'

/** The fork's private autocomplete surface (runtime methods; kimi's
 * CustomEditor uses the same cast idiom). */
interface AutocompleteInternals {
  cancelAutocomplete(): void
  requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void
}

export class TuiEditor extends Editor {
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
   * Tab accepted a directory). Mirrors kimi's reopenAutocompleteAfterInput
   * for the @-mention case only. */
  private reopenAutocompleteAfterInput(): void {
    if (this.isShowingAutocomplete()) return
    const { line, col } = this.getCursor()
    const textBeforeCursor = this.getLines()[line]?.slice(0, col) ?? ''
    if (textBeforeCursor.endsWith('/') && extractAtPrefix(textBeforeCursor) !== null) {
      ;(this as unknown as AutocompleteInternals)
        .requestAutocomplete({ force: false, explicitTab: false })
    }
  }
}
