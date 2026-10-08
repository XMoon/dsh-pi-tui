/**
 * Presentation-boundary projections shared by single-row renderers.
 *
 * @module @xmoon76/dsh-pi-tui/tui/presentation/lines
 */

import { stripTerminalSequences } from '@xmoon76/pi-tui'

/**
 * Project arbitrary presentation text onto exactly one physical terminal
 * row.
 *
 * Raw/domain text must remain unchanged; call this only at a presentation
 * boundary that semantically owns exactly one physical row (a renderer
 * whose returned `string[]` element is budgeted as one terminal row).
 * Width primitives (`visibleWidth`, `truncateToWidth`), marquee windowing,
 * and hit-map construction are not newline sanitizers: an embedded CR/LF
 * inside one array element escapes the row budget and the mouse hit map.
 *
 * Deliberately preserves ordinary/leading/trailing spaces (some
 * presentation labels carry structural whitespace); it only collapses
 * CR/LF row breaks into a single ordinary space, keeping the whole text
 * visible instead of dropping every line after the first.
 */
export function singlePhysicalLine(text: string): string {
  return text.replace(/[\r\n]+/g, ' ')
}

/**
 * The stricter sibling of {@link singlePhysicalLine} for text that may also
 * carry terminal escape sequences or other control characters (a Host
 * session title/label): COMPLETE CSI/OSC/… sequences are stripped whole via
 * the shared primitive (so a raw `\x1b[31m` can never leave visible `[31m`
 * payload), line breaks and tabs become spaces, and any remaining C0/C1
 * control character is dropped. The result is guaranteed to be a single
 * physical row with no terminal-control content.
 */
export function sanitizedPhysicalLine(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\u0009-\u000d]+/g, ' ')
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, '')
}
