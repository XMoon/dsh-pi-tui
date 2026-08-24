/**
 * Semantic color palette for the dsh-pi-tui surface, aligned with pi's
 * theme-token vocabulary (colors.ts): brand, text, surface, state, diff,
 * and role tokens. Components read tokens through the helper functions
 * below; switching palettes later only swaps this module's exports.
 * @module @xmoon76/dsh-pi-tui/theme
 */

import { Chalk } from 'chalk'
import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from '@xmoon76/pi-tui'

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
}

/** The active palette; style helpers read it on every call, so swapping is live. */
export let currentPalette: ColorPalette = darkColors

/** Theme selection modes: built-in palettes or a custom palette file. */
export type ThemeMode = 'dark' | 'light' | 'custom'

/** One custom theme file: optional base palette plus color overrides. */
export interface CustomThemeFile {
  /** Display name, echoed in the theme picker. */
  name: string
  /** Base palette to inherit unset tokens from; defaults to dark. */
  base?: 'dark' | 'light'
  /** Token overrides; any subset of {@link ColorPalette}. */
  colors?: Partial<ColorPalette>
}

/**
 * Switch the active palette; callers must invalidate rendered components.
 * `custom` uses the full palette in `customPalette`, or falls back to dark.
 * @param theme - the palette family.
 * @param custom - the resolved custom palette when `theme` is `custom`.
 */
export function setTheme(theme: ThemeMode, custom?: ColorPalette): void {
  if (theme === 'custom' && custom !== undefined) {
    currentPalette = custom
  } else {
    currentPalette = theme === 'light' ? lightColors : darkColors
  }
}

/** Build a full palette from a custom theme file (base + overrides). */
export function resolveCustomTheme(file: CustomThemeFile): ColorPalette {
  const base = file.base === 'light' ? lightColors : darkColors
  return { ...base, ...file.colors }
}

/** Custom-theme directory convention: `~/.dsh-pi-tui/themes/*.json`. */
export function customThemesDir(): string {
  return join(homedir(), '.dsh-pi-tui', 'themes')
}

/** Names of the custom theme files (basename without the extension). */
export function customThemeNames(): string[] {
  try {
    return readdirSync(customThemesDir())
      .filter(file => file.endsWith('.json'))
      .map(file => file.slice(0, -'.json'.length))
  } catch {
    return []
  }
}

/** Hex colour format: `#rgb`, `#rrggbb`, or `#rrggbbaa`. */
const COLOR_FORMAT = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?([0-9a-fA-F]{2})?$/

/** The token names a custom theme may override. */
const PALETTE_KEYS: readonly (keyof ColorPalette)[] = [
  'primary', 'accent', 'text', 'textStrong', 'textDim', 'textMuted', 'border',
  'borderFocus', 'success', 'warning', 'error',
  'diffAdded', 'diffRemoved', 'diffAddedStrong', 'diffRemovedStrong',
  'diffGutter', 'diffMeta',
  'roleUser', 'roleUserBg', 'shellMode',
]

/**
 * Runtime schema validation for a custom theme file: the keys must be a
 * known token subset, every value a hex colour, and `base` one of the
 * built-in families. An invalid file resolves to undefined (callers fall
 * back and notify once), never a half-parsed palette.
 * @param value - the parsed JSON value.
 * @returns the validated theme file, or undefined.
 */
export function validateCustomTheme(value: unknown): CustomThemeFile | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const file = value as Record<string, unknown>
  if (typeof file.name !== 'string' || file.name.trim() === '') return undefined
  if (file.base !== undefined && file.base !== 'dark' && file.base !== 'light') return undefined
  const colors = file.colors
  if (colors !== undefined) {
    if (typeof colors !== 'object' || colors === null || Array.isArray(colors)) return undefined
    for (const [key, token] of Object.entries(colors)) {
      if (!PALETTE_KEYS.includes(key as keyof ColorPalette)) return undefined
      if (typeof token !== 'string' || !COLOR_FORMAT.test(token)) return undefined
    }
  }
  return {
    name: file.name,
    ...file.base === undefined ? {} : { base: file.base },
    ...colors === undefined ? {} : { colors: colors as Partial<ColorPalette> },
  }
}

/** Load and resolve one custom theme file, or undefined when missing/broken. */
export function loadCustomTheme(name: string): ColorPalette | undefined {
  try {
    const raw = readFileSync(join(customThemesDir(), `${name}.json`), 'utf8')
    const file = validateCustomTheme(JSON.parse(raw))
    return file === undefined ? undefined : resolveCustomTheme(file)
  } catch {
    return undefined
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

/**
 * Parse the COLORFGBG env var (VT100/xterm convention: `fg;bg`, sometimes
 * `fg;default;bg`) into a palette family. The LAST token is the background
 * ANSI 16-color index; 0–6 and 8 are dark, everything else (7, 9–15) light
 * (kimi's parseColorFgBg rule).
 * @param value - the raw COLORFGBG value; defaults to the environment.
 * @returns the palette family, or undefined when unset/unparsable.
 */
export function detectThemeFromColorFgBg(value: string | undefined = process.env.COLORFGBG): 'dark' | 'light' | undefined {
  if (value === undefined || value === '') return undefined
  const bgRaw = value.split(';').at(-1)
  if (bgRaw === undefined) return undefined
  const bg = Number.parseInt(bgRaw, 10)
  if (!Number.isInteger(bg)) return undefined
  const darkBackgrounds = new Set([0, 1, 2, 3, 4, 5, 6, 8])
  return darkBackgrounds.has(bg) ? 'dark' : 'light'
}

/**
 * Whether the environment opts out of colour (NO_COLOR, FORCE_COLOR=0, CI):
 * auto-detection then stays on the dark palette without querying the
 * terminal (kimi detect.ts parity).
 */
export function themeOptOut(): boolean {
  const env = process.env
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return true
  if (env.FORCE_COLOR === '0') return true
  if (env.CI !== undefined && env.CI !== '' && env.CI !== '0') return true
  return false
}

const chalk = new Chalk({ level: 3 })
const hex = (token: string): InstanceType<typeof Chalk> => chalk.hex(currentPalette[token as keyof ColorPalette] ?? currentPalette.text)

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
  /** Plain italics (kimi thinking parity); an optional tone override
   * colors the italic run. */
  italic: (text: string, tone?: string) => tone === undefined
    ? chalk.italic(text)
    : chalk.italic.hex(currentPalette[tone as keyof ColorPalette] ?? currentPalette.text)(text),
  /** Dim + italic for reasoning: intermediate thinking never reads like output. */
  textDimItalic: (text: string) => chalk.italic.hex(currentPalette.textDim)(text),
}

/** SelectList palette from the semantic tokens. */
export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => color.primary(text),
  selectedText: (text: string) => chalk.bold(text),
  description: (text: string) => color.textDim(text),
  scrollInfo: (text: string) => color.textMuted(text),
  noMatch: (text: string) => color.textMuted(text),
  groupHeader: (text: string) => chalk.bold.hex(currentPalette.textMuted)(text),
}

/**
 * Status-dot colour for a background-job status (dsh-web StateDot parity:
 * running = ongoing/primary, stopping = warning, completed = done/dim,
 * failed/killed/timed-out/lost = error). Unknown statuses fall back to the
 * muted token so a future wire status never crashes the renderer.
 */
export function taskStatusColor(status: string): (text: string) => string {
  switch (status) {
    case 'running': return color.primary
    case 'stopping': return color.warning
    case 'completed': return color.textDim
    case 'failed':
    case 'killed':
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
