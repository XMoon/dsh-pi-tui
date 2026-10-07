/**
 * Neutral theme palette vocabulary (TS8-E): the semantic color-token shape,
 * the two built-in palettes and the pure palette/search-token derivation.
 *
 * This module is transport/UI-neutral by contract — no `node:fs`/`node:os`/
 * `node:path`, no `process.env`, no `chalk`, no `@xmoon76/pi-tui`, no
 * extension registry and no mutable current palette. The Client-local custom
 * theme file IO lives in `client/theme/files.ts`, the environment detection in
 * `client/theme/environment.ts` and the live terminal palette + ANSI/TUI
 * theme objects in `tui/theme/runtime.ts`.
 * @module @xmoon76/dsh-pi-tui/domain/display/theme
 */

/** Semantic palette tokens, mirroring pi's ColorPalette vocabulary. */
export interface ColorPalette {
  /** Dominant interactive/brand colour: links, inline code, selection. */
  primary: string
  /** Secondary highlight: approval prefix, active markers. */
  accent: string
  /** Default body text. */
  text: string
  /** Emphasised text. */
  textStrong: string
  /** Dimmed secondary text: thinking, hints, quotes. */
  textDim: string
  /** Faintest text: counters, borders. */
  textMuted: string
  /** Borders: panes, editor border. */
  border: string
  /** Focus / attention border (approval panel). */
  borderFocus: string
  /** Success: ✓ marks, completed states. */
  success: string
  /** Warning. */
  warning: string
  /** Error. */
  error: string
  /** Diff: added lines. */
  diffAdded: string
  /** Diff: removed lines. */
  diffRemoved: string
  /** Diff: added lines — intra-line changed words (bold). */
  diffAddedStrong: string
  /** Diff: removed lines — intra-line changed words (bold). */
  diffRemovedStrong: string
  /** Diff: line-number gutter. */
  diffGutter: string
  /** Diff: meta / hunk headers. */
  diffMeta: string
  /** User-message role colour: the ❯ marker (brand blue, not kimi amber). */
  roleUser: string
  /** User-message bubble background (dsh-web `--dsw-specific-bubble`
   * parity). Absent = no bubble, the role text colours the body instead. */
  roleUserBg?: string
  /** Shell-mode accent (reserved for `!` shell mode). */
  shellMode: string
  /** Transcript search: THE CURRENT exact occurrence's foreground. Paired with
   * {@link ColorPalette.searchCurrentBg}; the highlight is ALWAYS an explicit
   * themed block, never the terminal's inverse attribute. Optional only for a
   * palette that predates the tokens — {@link withSearchCurrentTokens} fills it
   * at every theme-apply boundary. */
  searchCurrentFg?: string
  /** Transcript search: the current exact occurrence's background. */
  searchCurrentBg?: string
  /** Transcript search: the ANCHOR-ONLY current result's row background. The
   * query occurrences on that row stay weak-underlined — the background marks
   * the owning source/card row, never a proven occurrence. Deliberately weaker
   * than {@link ColorPalette.searchCurrentBg}. */
  searchAnchorBg?: string
}

/** Dark palette (default), tuned for ≥ 4.5:1 contrast on black. */
export const darkColors: ColorPalette = {
  primary: '#4FA8FF',
  accent: '#5BC0BE',
  text: '#E0E0E0',
  textStrong: '#F5F5F5',
  textDim: '#888888',
  textMuted: '#6B6B6B',
  border: '#5A5A5A',
  borderFocus: '#E8A838',
  success: '#4EC87E',
  warning: '#E8A838',
  error: '#E85454',
  diffAdded: '#4EC87E',
  diffRemoved: '#E85454',
  diffAddedStrong: '#7AD99B',
  diffRemovedStrong: '#F08585',
  diffGutter: '#6B6B6B',
  diffMeta: '#888888',
  roleUser: '#679EFE',
  shellMode: '#BD93F9',
  /** dsh-web `--dsw-specific-bubble` (dark): neutral bluish-850. */
  roleUserBg: '#2C2C2F',
  /** Search current occurrence (dark): dark ink on a bright amber block. */
  searchCurrentFg: '#141410',
  searchCurrentBg: '#F5C542',
  /** Search anchor-only row (dark): a dim amber-tinted wash, clearly weaker
   * than the exact occurrence block. */
  searchAnchorBg: '#3A3220',
}

/** Light palette, tuned for ≥ 4.5:1 contrast on white (pi's values). */
export const lightColors: ColorPalette = {
  primary: '#1565C0',
  accent: '#00838F',
  text: '#1A1A1A',
  textStrong: '#1A1A1A',
  textDim: '#454545',
  textMuted: '#5F5F5F',
  border: '#737373',
  borderFocus: '#92660A',
  success: '#0E7A38',
  warning: '#92660A',
  error: '#B91C1C',
  diffAdded: '#0E7A38',
  diffRemoved: '#B91C1C',
  diffAddedStrong: '#0E7A38',
  diffRemovedStrong: '#B91C1C',
  diffGutter: '#737373',
  diffMeta: '#5F5F5F',
  roleUser: '#4177E6',
  shellMode: '#7C3AED',
  /** dsh-web `--dsw-specific-bubble` (light): deepseek-100. */
  roleUserBg: '#E4EDFD',
  /** Search current occurrence (light): dark ink on a saturated amber block. */
  searchCurrentFg: '#1A1A1A',
  searchCurrentBg: '#FFD75E',
  /** Search anchor-only row (light): a pale amber wash. */
  searchAnchorBg: '#FFF0C2',
}

/** Theme selection modes: built-in palettes or a custom palette file. */
export type ThemeMode = 'dark' | 'light' | 'custom'

/** Whether a palette's body text is LIGHT ink — i.e. a DARK-family palette
 * (`darkColors.text` is light on a dark background). Used only to pick the
 * inherited search block. Accepts the same `#rgb` / `#rrggbb` / `#rrggbbaa`
 * forms the custom-theme validator does (alpha is ignored). */
function bodyTextIsLight(color: string): boolean {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/u.exec(color.trim())
  if (match === null) return false
  const hex = match[1]!
  const full = hex.length === 3 ? hex.split('').map(ch => ch + ch).join('') : hex.slice(0, 6)
  // Perceived luminance (ITU-R BT.601); > 0.5 = light ink.
  const luminance = (0.299 * parseInt(full.slice(0, 2), 16)
    + 0.587 * parseInt(full.slice(2, 4), 16)
    + 0.114 * parseInt(full.slice(4, 6), 16)) / 255
  return luminance > 0.5
}

/** Fill the search-current tokens a palette that predates them omits. The
 * inherited pair comes from the built-in palette of the MATCHING family — a
 * light-ink palette inherits the dark-family block and vice versa — so the
 * current occurrence is always an explicit themed block, never the
 * terminal-inverse fallback. */
export function withSearchCurrentTokens(palette: ColorPalette): ColorPalette {
  if (palette.searchCurrentFg !== undefined && palette.searchCurrentBg !== undefined && palette.searchAnchorBg !== undefined) {
    return palette
  }
  const base = bodyTextIsLight(palette.text) ? darkColors : lightColors
  return {
    ...palette,
    searchCurrentFg: palette.searchCurrentFg ?? base.searchCurrentFg,
    searchCurrentBg: palette.searchCurrentBg ?? base.searchCurrentBg,
    searchAnchorBg: palette.searchAnchorBg ?? base.searchAnchorBg,
  }
}

/**
 * Classify a terminal background colour (OSC 11 reply) as dark or light by
 * relative luminance; a bright background selects the light palette.
 * @param rgb - the reported background colour.
 * @returns the matching palette family.
 */
export function detectThemeFromBackground(rgb: { r: number; g: number; b: number }): 'dark' | 'light' {
  const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255
  return luminance >= 0.5 ? 'light' : 'dark'
}
