/**
 * Home/End navigation behavior (issue #9).
 *
 * Two user habits exist for Home/End in fullscreen: some expect them to
 * move within the input (Ctrl+Home/End scroll the conversation), others
 * expect them to scroll the conversation (Ctrl+Home/End move within the
 * input). The `/settings` panel exposes this as `Home/End keys` with the
 * behavior-named values `input` and `viewport` (never a source-named
 * preset — plan §4.1).
 *
 * The mechanism needs NO vendor change: the alt screen's viewport already
 * consumes `tui.altScreen.top`/`bottom` BEFORE the editor sees the key,
 * and the editor already binds Home/End/Ctrl+Home/Ctrl+End to
 * cursorLineStart/cursorLineEnd. So the preset only remaps the two
 * viewport bindings:
 *
 * - `viewport` (default, unchanged behavior): top=`home`, bottom=`end` —
 *   Home/End scroll, Ctrl+Home/End reach the editor.
 * - `input`: top=`ctrl+home`, bottom=`ctrl+end` — Home/End reach the
 *   editor, Ctrl+Home/End scroll.
 *
 * Precedence (plan §4.7): explicit user keybindings > this preset >
 * vendor default. There is no independent user keybinding persistence
 * yet, so the preset currently overwrites `tui.altScreen.top`/`bottom`
 * in the user-bindings map; when user keybinding persistence arrives,
 * the resolved bindings must become default + navigation preset +
 * explicit user overrides (the preset must never clobber an explicit
 * user binding).
 * @module @xmoon76/dsh-pi-tui/home-end-keys
 */

import { getKeybindings } from '@xmoon76/pi-tui'

/** The two Home/End navigation behaviors. */
export type HomeEndKeysMode = 'input' | 'viewport'

/** Read the persisted mode with a `viewport` fallback for invalid values
 * (a stale or hand-edited settings document must never crash the boot). */
export function homeEndKeysModeOf(value: string | undefined): HomeEndKeysMode {
  return value === 'input' ? 'input' : 'viewport'
}

/**
 * Apply the Home/End navigation preset to the fullscreen viewport's
 * top/bottom bindings. Only those two bindings are touched — every other
 * user binding (and every other default) survives. The keybindings
 * manager is a global resolver, so the preset applies whether the
 * fullscreen is already up or not; call it BEFORE the first fullscreen
 * frame so the first frame and later behavior agree (plan §4.8).
 */
export function applyHomeEndKeyMode(mode: HomeEndKeysMode): void {
  const manager = getKeybindings()
  const bindings = manager.getUserBindings()
  manager.setUserBindings({
    ...bindings,
    'tui.altScreen.top': mode === 'input' ? 'ctrl+home' : 'home',
    'tui.altScreen.bottom': mode === 'input' ? 'ctrl+end' : 'end',
  })
}
