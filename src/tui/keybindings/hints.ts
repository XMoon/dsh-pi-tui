/**
 * Key hint formatting (plan §18): the ONE place that turns a KeyId into
 * the human label the footer/help/settings render. The UI must never
 * hard-code "Shift+Tab" again — it renders `keyHint(keymap, action)` so a
 * user remap automatically updates every hint.
 * @module @xmoon76/dsh-pi-tui/tui/keybindings/hints
 */

import type { KeyId } from '@xmoon76/pi-tui'

/**
 * The TSP renderer's FIXED parked-Question inspection chord (PR3-B B3 §3.8).
 *
 * The TSP interaction seat is not a Host command and owns no keymap action —
 * `Alt+Q` is dispatched from the raw SDK key stream — so this label can never
 * come from `keyHint`/`keysFor`. It also cannot go stale under a remap,
 * because no remap exists for it. It lives HERE, with the key-label
 * vocabulary, because the host-keybindings gate only sanctions key labels
 * owned by this tree: a renderer module must not hard-code the chord itself.
 */
export const TSP_CONTINUED_INSPECTION_LABEL = 'Alt+Q'

/**
 * The History editor-seat tenant's FIXED labels (Phase 3B / B3-A).
 *
 * The seat is a per-surface COMPONENT contract, not a Host command: it owns no
 * keymap action, so these labels can never come from `keyHint`/`keysFor`. They
 * also cannot go stale under a remap, because no remap exists for them. They
 * live HERE, with the key-label vocabulary, because the host-keybindings gate
 * only sanctions key labels owned by this tree: a panel or renderer module must
 * not hard-code the chords itself.
 */
export const HISTORY_PREVIEW_SCROLL_LABEL = 'Alt+↑↓'
export const HISTORY_COPY_LABEL = 'Alt+C'

/** The display name of a bare (unmodified) key id. */
const BASE_KEY_LABELS: Record<string, string> = {
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageUp: 'PageUp',
  pageDown: 'PageDown',
  // The canonical form lowercases named keys (pageUp → pageup, pageDown →
  // pagedown — convergence: the runtime parser lowercases, so the keymap
  // identity matches it). The DISPLAY mapping must cover both spellings so
  // hints always render PageUp/PageDown.
  pageup: 'PageUp',
  pagedown: 'PageDown',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  'ctrl+[': 'Ctrl+[',
}

/** Format one KeyId as a human label (`ctrl+shift+f` → `Ctrl+Shift+F`). */
export function formatKeyId(key: KeyId): string {
  const parts = key.split('+')
  const mods: string[] = []
  let base = ''
  for (const part of parts) {
    if (part === 'ctrl') mods.push('Ctrl')
    else if (part === 'alt') mods.push('Alt')
    else if (part === 'shift') mods.push('Shift')
    else if (part === 'super') mods.push('Super')
    else base = part
  }
  const baseLabel = BASE_KEY_LABELS[base] ?? (base.length === 1 ? base.toUpperCase() : base)
  return [...mods, baseLabel].join('+')
}

/** Format a `<leader>X` sequence label (`<leader>t` → `Leader T`). */
export function formatLeaderSequence(completingKey: KeyId): string {
  return `Leader ${formatKeyId(completingKey)}`
}

/** Join several key labels for one action (`Ctrl+F / Ctrl+Shift+F`). */
export function formatKeyList(keys: readonly KeyId[]): string {
  return keys.map(formatKeyId).join(' / ')
}

/** Format one already-labelled key list for an ACTION-BAR HINT: a BARE
 *  unmodified letter stays lowercase (`s`, never `S`) because `S` reads as ⇧S in
 *  prose — the design language's key rule (§4.1). A modified chord keeps its
 *  formatted form (`Shift+S`), and a list keeps its OWN separator spacing
 *  (`s / Shift+S`, the same shape {@link formatKeyList} paints). */
export function formatHintKeys(keys: string): string {
  return keys.split('/').map(part => {
    const core = part.trim()
    const lowered = /^[A-Za-z]$/u.test(core) ? core.toLowerCase() : core
    // Preserve the separator's own spacing instead of imposing one: the list
    // formatter's ` / ` must survive, and a compact `S/Shift+S` stays compact.
    return part.replace(core, lowered)
  }).join('/')
}
