/**
 * The ONE Client-local product capability classifier for inline image pixels
 * (Image-7B-B, extended by Image-7C-3 and Image-7C).
 *
 * The fork's `getCapabilities().images` answers what the PROCESS's terminal
 * detects. That is the right authority for every non-managed surface — a
 * native Kitty mount, Ghostty/WezTerm/Warp/Tern legacy pixels, iTerm2 — but it
 * is the WRONG authority inside a multiplexer: a tmux pane detects no inline
 * protocol at all while a Zellij pane inherits the host's `TERM_PROGRAM` hint
 * even when its live pane query has not admitted Kitty graphics. Consumers
 * therefore ask this classifier instead of reading the fork capability
 * directly.
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
 * A managed handle owns its admission: a Direct capable Kitty protocol handle
 * is always paintable once its factory created it, the tmux virtual handle
 * answers its live revocation, and the Zellij handle answers its one-way pane
 * query. When a Zellij pane has NO admitted handle, the inherited host
 * capability must never fall back to legacy `a=T`; the pane paints text
 * instead. An EMPTY `ZELLIJ` value is not a Zellij session marker and must not
 * suppress a direct terminal's own capability.
 */
export function effectiveImageProtocol(graphics: KittyGraphics | undefined): EffectiveImageProtocol {
  if (graphics !== undefined) return graphics.canPaint() ? 'kitty' : null
  if ((process.env.ZELLIJ ?? '') !== '') return null
  return getCapabilities().images ?? null
}
