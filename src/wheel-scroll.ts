/**
 * The fullscreen mouse-wheel step preference: the number of transcript
 * lines moved per wheel event. A pure Client preference — the schema, the
 * `/settings` row, the startup apply, the TuiApp and the tests all share
 * ONE parsing semantic (never a copied parseInt / fallback).
 *
 * The value rides the TUI settings document (persisted through the
 * ConfigPort like every other TUI preference) but is applied ONLY to the
 * alt screen's constructor option (`TuiAltScreenOptions.wheelScrollLines`)
 * — the fork's wheel handling is never reimplemented here.
 * @module @xmoon76/dsh-pi-tui/wheel-scroll
 */

/** The selectable wheel steps, in display order. */
export const WHEEL_SCROLL_LINE_VALUES = ['1', '2', '3', '5', '8'] as const

/** The accepted wheel step values. */
export type WheelScrollLines = 1 | 2 | 3 | 5 | 8

/** The fallback for a missing / invalid persisted value (default 1 —
 * the fork's own default, so an old settings file keeps the current
 * behavior). */
const WHEEL_SCROLL_LINES_FALLBACK: WheelScrollLines = 1

/** Parse a persisted wheel-scroll-lines value: `1/2/3/5/8` pass through,
 * anything else (missing, empty, malformed) falls back to 1. */
export function wheelScrollLinesOf(value: string | undefined): WheelScrollLines {
  if (value === '1' || value === '2' || value === '3' || value === '5' || value === '8') {
    return Number(value) as WheelScrollLines
  }
  return WHEEL_SCROLL_LINES_FALLBACK
}
