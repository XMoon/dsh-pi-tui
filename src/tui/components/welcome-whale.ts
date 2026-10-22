/**
 * The shared whale mascot primitive: the five original whale designs, the
 * fixed brand gradient and the shared layout width.
 *
 * The Welcome card and the Settings `About` page paint the SAME five variants
 * with the SAME gradient — this module is their ONE source, so a variant can
 * never drift between the two surfaces. The pattern and the colour ramp are
 * brand assets, not semantic tokens: a custom theme does not override them.
 * @module @xmoon76/dsh-pi-tui/tui/components/welcome-whale
 */

import { visibleWidth } from '@xmoon76/pi-tui'
import { hexPaint } from '../theme/runtime.ts'

/** The whale mascot variants: five original designs; one is picked once per
 * card/page lifetime (see {@link pickWelcomeWhaleVariant}). */
const WELCOME_WHALES = [
  [
    '        o',
    '      O',
    '     :',
    "  .--'---._      \\_/",
    " (  o      `-----//",
    ' ~~~\\_)~~~~~~~~~~~~',
  ],
  [
    '       z Z',
    "   .------._     \\_/",
    "  (  -      `----//",
    " ~~`~~\\_)~~~~~~~~~~",
  ],
  [
    '                   *',
    " \\_/      .-------.",
    "  \\\\____.'     o  _>",
    "   `-----------\\_)",
  ],
  [
    '       <3',
    '       :',
    "   .---'--.",
    " ( o      `.__  \\_/",
    "   `---\\_)-----`-//",
  ],
  [
    '          \\   /',
    '           \\_/',
    '           | |',
    ' ~~~~~~~~~/ /~~~~~~',
    "         '       o",
    '               o',
  ],
] as const

/** Brand ramp for the whale rows: cyan → blue. Fixed (not a semantic
 * token): custom themes do not override the logo gradient. */
const WELCOME_WHALE_COLORS = [
  '#63C7D1',
  '#5DBBD4',
  '#56AFD7',
  '#50A3D9',
  '#4996DA',
  '#4389D8',
] as const

/** The widest whale row across all variants (visible width, ANSI-free).
 * All variants share this layout width so the position stays consistent
 * across picks. */
export const WELCOME_WHALE_WIDTH: number = Math.max(...WELCOME_WHALES.flat().map(line => visibleWidth(line)))

/** The number of whale variants a pick can choose from. */
export const WELCOME_WHALE_VARIANTS = WELCOME_WHALES.length

/**
 * Pick one whale variant. The caller keeps the picked index for its own
 * lifetime: a resize or a fact change never re-picks.
 * @returns a variant index in `[0, WELCOME_WHALE_VARIANTS)`.
 */
export function pickWelcomeWhaleVariant(): number {
  return Math.floor(Math.random() * WELCOME_WHALES.length)
}

/**
 * The picked whale variant, painted with the fixed brand gradient (rows
 * beyond the 6-color ramp reuse the last ramp color).
 * @returns the painted lines of the variant, one per whale row.
 */
export function renderWelcomeWhaleLines(variant: number): string[] {
  const whale = WELCOME_WHALES[variant] ?? WELCOME_WHALES[0]
  return whale.map((line, index) => hexPaint(
    WELCOME_WHALE_COLORS[Math.min(index, WELCOME_WHALE_COLORS.length - 1)]!,
    line,
  ))
}
