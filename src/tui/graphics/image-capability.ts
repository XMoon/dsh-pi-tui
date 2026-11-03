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
import { imageProtocolPreference, type ImageProtocolPreference } from './image-protocol-preference.ts'
import type { ImageGraphics } from './native-image.ts'

/** The image protocol a consumer may paint with right now. */
export type EffectiveImageProtocol = 'kitty' | 'iterm2' | 'sixel' | null

/**
 * Whether the process sits behind a transport boundary that must admit its own
 * protocol. Used only when NO managed handle exists: an inherited fork
 * capability must never leak a legacy Kitty/iTerm2 image sequence through a
 * multiplexer pane.
 */
function isMultiplexerTopology(environment: NodeJS.ProcessEnv): boolean {
  for (const marker of ['ZELLIJ', 'TMUX', 'STY'] as const) {
    if ((environment[marker] ?? '') !== '') return true
  }
  const term = (environment.TERM ?? '').toLowerCase()
  return term.startsWith('tmux')
    || term.startsWith('screen')
    || (environment.TERM_PROGRAM ?? '').toLowerCase() === 'herdr'
}

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
 *
 * Without a managed handle the explicit preference answers first: `none` and
 * `sixel` are text-only, and every multiplexer topology is text-only even when
 * the fork's static capability says `kitty`/`iterm2` (an explicit legacy
 * override must not become passthrough). Only an ordinary Direct terminal may
 * keep the fork's own `iterm2` answer, or a `kitty` answer owned by the Native
 * factory above.
 *
 * SIXEL (Image-8 / I8-2A) is the LAST branch and never a fallback: an existing
 * managed Kitty handle keeps precedence even while it is denied or pending, so
 * a revoked tmux virtual pane or an unanswered Zellij pane query still paints
 * text and never silently degrades to a different protocol. `PI_IMAGE_PROTOCOL`
 * and `getCapabilities().images` are not authorities for an admitted SIXEL
 * owner — the owner's own readiness projection is.
 */
export function effectiveImageProtocol(
  graphics: ImageGraphics | undefined,
  preference: ImageProtocolPreference = imageProtocolPreference(process.env),
): EffectiveImageProtocol {
  if (graphics !== undefined && graphics.mode === 'zellij-negotiated') {
    // ONE selection projection, never the inherited fork capability: a
    // negotiated pane answers exactly the protocol the live negotiation
    // committed, and only while that transport can really paint this frame.
    return graphics.canPaint() ? graphics.selectedProtocol() : null
  }
  if (graphics !== undefined && graphics.mode !== 'sixel') return graphics.canPaint() ? 'kitty' : null
  if (graphics !== undefined) return graphics.canPaint() ? 'sixel' : null
  if (preference === 'none' || preference === 'sixel') return null
  if (isMultiplexerTopology(process.env)) return null
  // An explicit protocol never accepts the OTHER static legacy capability:
  // `iterm2` may only answer the Direct iTerm2 path, and `kitty` may only
  // answer Kitty. A mismatch is text, not a cross-protocol fallback.
  const images = getCapabilities().images
  if (preference === 'iterm2') return images === 'iterm2' ? 'iterm2' : null
  if (preference === 'kitty') return images === 'kitty' ? 'kitty' : null
  return images ?? null
}
