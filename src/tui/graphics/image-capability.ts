/**
 * The ONE Client-local product capability classifier for inline image pixels
 * (Image-7B-B).
 *
 * The fork's `getCapabilities().images` answers what the PROCESS's terminal
 * detects. That is the right authority for every non-managed surface — a
 * native Kitty mount, Ghostty/WezTerm/Warp legacy pixels, iTerm2 — but it is
 * the WRONG authority for the tmux virtual backend: inside a tmux pane the fork
 * detects no inline protocol at all, and the real admission lives in the
 * managed handle (one live server query, latched one-way). Consumers therefore
 * ask this classifier instead of reading the fork capability directly.
 *
 * This is a TUI presentation policy, not a Domain or Host fact: it decides
 * whether THIS frame may paint real pixels, and nothing here is persisted,
 * transmitted or exported.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/image-capability
 */

import { getCapabilities } from '@xmoon76/pi-tui'
import type { KittyGraphics } from './native-image.ts'

/** The image protocol a consumer may paint with right now. */
export type EffectiveImageProtocol = 'kitty' | 'iterm2' | null

/**
 * Whether THIS render may paint real pixels, and through which protocol.
 *
 * The tmux virtual handle is the only case that overrides the fork: it exists
 * only after a strict live admission, so its `canPaint()` is the current
 * binding/revocation state and a revoked handle paints text instead. Every
 * other terminal keeps the fork's own capability untouched.
 */
export function effectiveImageProtocol(graphics: KittyGraphics | undefined): EffectiveImageProtocol {
  if (graphics?.mode === 'tmux-virtual') return graphics.canPaint() ? 'kitty' : null
  return getCapabilities().images ?? null
}
