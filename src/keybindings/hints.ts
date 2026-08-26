/**
 * Key hint formatting (plan §18): the ONE place that turns a KeyId into
 * the human label the footer/help/settings render. The UI must never
 * hard-code "Shift+Tab" again — it renders `keyHint(keymap, action)` so a
 * user remap automatically updates every hint.
 * @module @xmoon76/dsh-pi-tui/keybindings/hints
 */

import type { KeyId } from '@xmoon76/pi-tui'

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
