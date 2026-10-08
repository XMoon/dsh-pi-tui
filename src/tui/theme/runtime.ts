/**
 * The live terminal palette + ANSI/TUI theme objects (TS8-E): the ONE owner
 * of the mutable current palette and of the chalk-backed style helpers,
 * searchable-picker/settings-list/editor/markdown themes and the host
 * markdown options. Every TUI renderer and every terminal-rendering
 * extension adapter (`extension/internal/component-compiler.ts`,
 * `slot-outlet.ts`) consumes this owner; the neutral palette vocabulary and
 * built-in palettes live in `domain/display/theme.ts`.
 * @module @xmoon76/dsh-pi-tui/tui/theme/runtime
 */

import { Chalk } from 'chalk'
import type {
  EditorTheme,
  MarkdownTheme,
  SettingsListTheme,
} from '@xmoon76/pi-tui'
import { darkColors, lightColors, withSearchCurrentTokens, type ColorPalette, type ThemeMode } from '../../domain/display/theme.ts'
import type { SearchablePickerTheme } from '../pickers/searchable-picker.ts'

/** The active palette; style helpers read it on every call, so swapping is live. */
export let currentPalette: ColorPalette = darkColors

/**
 * Switch the active palette; callers must invalidate rendered components.
 * `custom` uses the full palette in `customPalette`, or falls back to dark.
 * @param theme - the palette family.
 * @param custom - the resolved custom palette when `theme` is `custom`.
 */
export function setTheme(theme: ThemeMode, custom?: ColorPalette): void {
  if (theme === 'custom' && custom !== undefined) {
    currentPalette = withSearchCurrentTokens(custom)
  } else {
    currentPalette = theme === 'light' ? lightColors : darkColors
  }
}

const chalk = new Chalk({ level: 3 })
const hex = (token: string): InstanceType<typeof Chalk> => chalk.hex(currentPalette[token as keyof ColorPalette] ?? currentPalette.text)

/** Paint text with an explicit hex colour. Brand assets (the welcome whale
 * gradient) use a fixed ramp that is NOT a semantic token: it must not
 * follow the active palette, and custom themes do not override it. */
export const hexPaint = (hexValue: string, text: string): string => chalk.hex(hexValue)(text)

/** Style helpers by token name. The strong/dim/italic helpers accept an
 * optional TONE OVERRIDE (the footer layout's semantic tone override):
 * the override replaces the token, the style stays. */
export const color = {
  primary: (text: string) => hex('primary')(text),
  accent: (text: string) => hex('accent')(text),
  text: (text: string) => hex('text')(text),
  textStrong: (text: string, tone?: string) => chalk.bold.hex(
    currentPalette[(tone ?? 'textStrong') as keyof ColorPalette] ?? currentPalette.textStrong,
  )(text),
  textDim: (text: string, tone?: string) => hex((tone ?? 'textDim') as keyof ColorPalette)(text),
  textMuted: (text: string) => hex('textMuted')(text),
  border: (text: string) => hex('border')(text),
  borderFocus: (text: string) => hex('borderFocus')(text),
  success: (text: string) => hex('success')(text),
  warning: (text: string) => hex('warning')(text),
  error: (text: string) => hex('error')(text),
  diffAdded: (text: string) => hex('diffAdded')(text),
  diffRemoved: (text: string) => hex('diffRemoved')(text),
  diffAddedStrong: (text: string) => chalk.bold.hex(currentPalette.diffAddedStrong)(text),
  diffRemovedStrong: (text: string) => chalk.bold.hex(currentPalette.diffRemovedStrong)(text),
  diffGutter: (text: string) => hex('diffGutter')(text),
  diffMeta: (text: string) => hex('diffMeta')(text),
  roleUser: (text: string) => hex('roleUser')(text),
  /** User-bubble background paint (dsh-web `--dsw-specific-bubble`
   * parity): the whole user row reads as a floating block. The token is
   * optional — an absent `roleUserBg` makes this an identity function. */
  roleUserBg: (text: string) => currentPalette.roleUserBg === undefined
    ? text
    : chalk.bgHex(currentPalette.roleUserBg)(text),
  shellMode: (text: string) => hex('shellMode')(text),
  /** The current EXACT search occurrence: bold with an explicit themed
   * foreground AND background. NEVER the terminal's inverse attribute — a
   * palette that omits the tokens has them filled at apply time
   * ({@link withSearchCurrentTokens}), and this helper's own derivation stays
   * inside the palette. */
  searchCurrent: (text: string) => chalk.bold
    .hex(currentPalette.searchCurrentFg ?? currentPalette.textStrong)
    .bgHex(currentPalette.searchCurrentBg ?? currentPalette.primary)(text),
  /** The anchor-only current result's ROW background: it marks the owning
   * source/card row while every query occurrence on it stays weak-underlined.
   * Never a proven occurrence — provenance is unchanged. */
  searchAnchorBg: (text: string) => chalk.bgHex(currentPalette.searchAnchorBg ?? currentPalette.border)(text),
  /** Plain italics (kimi thinking parity); an optional tone override
   * colors the italic run. */
  italic: (text: string, tone?: string) => tone === undefined
    ? chalk.italic(text)
    : chalk.italic.hex(currentPalette[tone as keyof ColorPalette] ?? currentPalette.text)(text),
  /** Dim + italic for reasoning: intermediate thinking never reads like output. */
  textDimItalic: (text: string) => chalk.italic.hex(currentPalette.textDim)(text),
}

/** SearchablePicker palette from the semantic tokens (a structural
 * superset of the upstream SelectListTheme, so it still satisfies the
 * Editor's autocomplete theme slot). */
export const selectListTheme: SearchablePickerTheme = {
  selectedPrefix: (text: string) => color.primary(text),
  selectedText: (text: string) => chalk.bold(text),
  description: (text: string) => color.textDim(text),
  scrollInfo: (text: string) => color.textMuted(text),
  noMatch: (text: string) => color.textMuted(text),
  groupHeader: (text: string) => chalk.bold.hex(currentPalette.textMuted)(text),
}

/**
 * Status-dot colour for a job status (dsh-web StateDot parity:
 * running = ongoing/primary, stopping/killed = warning, completed = done/dim,
 * failed/timed-out/lost = error). Unknown statuses fall back to the
 * muted token so a future wire status never crashes the renderer.
 */
export function taskStatusColor(status: string): (text: string) => string {
  switch (status) {
    case 'running': return color.primary
    case 'stopping': return color.warning
    case 'completed': return color.textDim
    case 'failed':
    case 'killed': return color.warning
    case 'timed_out':
    case 'lost':
      return color.error
    default: return color.textMuted
  }
}

/**
 * SettingsList palette from the semantic tokens. A FUNCTION, not a
 * module-level constant: `cursor` is a pre-rendered ANSI string, so a
 * constant would freeze the cursor colour at module load and never follow
 * a live theme switch. Call it fresh for every overlay/settings open.
 */
export function settingsListTheme(): SettingsListTheme {
  return {
    label: (text: string, selected: boolean) => selected ? chalk.bold.hex(currentPalette.textStrong)(text) : color.text(text),
    value: (text: string, selected: boolean) => selected ? color.primary(text) : color.textDim(text),
    description: (text: string) => color.textDim(text),
    cursor: color.primary('›'),
    hint: (text: string) => color.textMuted(text),
  }
}

/** Editor palette: focused border uses the brand token. */
export const editorTheme: EditorTheme = {
  borderColor: (text: string) => color.border(text),
  selectList: selectListTheme,
}

/**
 * Markdown rendering options shared by EVERY host transcript renderer
 * (assistant cards, thinking blocks, plugin component compilation).
 * LaTeX-to-Unicode rendering is deliberately OFF (the kimi-host parity
 * choice): the Earendil 0.84.4 re-vendor introduced `renderLatex`
 * defaulting to true, which silently changed how `$...$`/`$$...$$`
 * segments in assistant output render. Keep the pre-re-vendor rendering;
 * revisit as an explicit setting if LaTeX output ever becomes a product
 * requirement.
 */
export const HOST_MARKDOWN_OPTIONS = { renderLatex: false } as const

/** Markdown palette for assistant messages. */
export const markdownTheme: MarkdownTheme = {
  heading: (text: string) => chalk.bold.hex(currentPalette.textStrong)(text),
  link: (text: string) => color.primary(text),
  linkUrl: (text: string) => color.textMuted(text),
  code: (text: string) => color.primary(text),
  codeBlock: (text: string) => text,
  codeBlockBorder: (text: string) => color.textMuted(text),
  quote: (text: string) => color.textDim(text),
  quoteBorder: (text: string) => color.textDim(text),
  hr: (text: string) => color.border(text),
  listBullet: (text: string) => color.text(text.replace(/^-/, '•')),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  strikethrough: (text: string) => chalk.strikethrough(text),
  underline: (text: string) => chalk.underline(text),
}
