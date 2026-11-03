/**
 * The ONE Client-local parser for the user's explicit image protocol request.
 *
 * `PI_IMAGE_PROTOCOL` is a startup configuration input, not a terminal
 * capability: it selects which protocol family the product may use, while the
 * real transport gates (Direct DA1, Zellij pane DA1/version/Screen readiness,
 * tmux live server/client facts) still decide whether that family can paint.
 * This parser is a pure function with no cache, side effect or mutable state;
 * every consumer derives the same answer from the same original environment
 * object for the lifetime of the process.
 *
 * Invalid values are a startup configuration error, never a silent `auto`
 * fallback: the error names the variable, the actual value and every accepted
 * value.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/image-protocol-preference
 */

/** The explicit image protocol selection the user requested at startup. */
export type ImageProtocolPreference = 'auto' | 'kitty' | 'sixel' | 'iterm2' | 'none'

/** Parse the one startup image-protocol override; throw on an unknown value. */
export function imageProtocolPreference(environment: NodeJS.ProcessEnv = process.env): ImageProtocolPreference {
  const raw = environment.PI_IMAGE_PROTOCOL
  switch ((raw ?? '').trim().toLowerCase()) {
    case '':
    case 'auto':
      return 'auto'
    case 'kitty':
      return 'kitty'
    case 'sixel':
      return 'sixel'
    case 'iterm2':
      return 'iterm2'
    case 'none':
    case '0':
      return 'none'
    default:
      throw new Error(
        `Invalid PI_IMAGE_PROTOCOL: ${JSON.stringify(raw)}; expected auto, kitty, sixel, iterm2, none, 0`,
      )
  }
}
