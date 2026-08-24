/**
 * The focused-component keymap (plan §3.3/§5 M5): a tiny read-only keymap
 * for components that own their input while focused (QuestionFlow,
 * TaskBrowserPanel). The component actions are non-configurable in the
 * first version, so the effective keys ARE the definition defaults — the
 * component never hard-codes a physical key, and a future M4 opening of
 * component actions only needs to swap this class for the full manager.
 *
 * Component-local printable keys (h/j/k/l/e/i/digits) stay component
 * logic — they only exist while the component owns the seat (plan §14).
 * @module @xmoon76/dsh-pi-tui/keybindings/component-keymap
 */

import { matchesKey, type KeyId } from '@xmoon76/pi-tui'
import { APP_KEYBINDINGS } from './definitions.ts'
import { formatKeyId } from './hints.ts'
import type { AppKeybindingId } from './types.ts'

/** The read-only component keymap. */
export class ComponentKeymap {
  /** Whether the raw event matches one component action's default keys. */
  matches(data: string, action: AppKeybindingId): boolean {
    const definition = APP_KEYBINDINGS[action]
    if (definition === undefined) return false
    return definition.defaultKeys.some(key => matchesKey(data, key))
  }

  /** The default keys of one component action. */
  keysFor(action: AppKeybindingId): KeyId[] {
    return [...(APP_KEYBINDINGS[action]?.defaultKeys ?? [])]
  }

  /** The human hint for one component action. */
  keyHint(action: AppKeybindingId): string {
    const keys = this.keysFor(action)
    return keys.length === 0 ? '' : keys.map(formatKeyId).join(' / ')
  }
}

/** The shared instance (the component keymaps are stateless). */
export const componentKeymap = new ComponentKeymap()
