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
  /** Success: ✓ marks, completed states. */
  success: string
  /** Warning. */
  warning: string
  /** Error. */
  error: string
  /** User-message role colour. */
  roleUser: string
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
  success: '#4EC87E',
  warning: '#E8A838',
  error: '#E85454',
  roleUser: '#FFCB6B',
  shellMode: '#BD93F9',
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
  success: '#0E7A38',
  warning: '#92660A',
  error: '#B91C1C',
  roleUser: '#9A4A00',
  shellMode: '#7C3AED',
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

/** Load and resolve one custom theme file, or undefined when missing/broken. */
export function loadCustomTheme(name: string): ColorPalette | undefined {
  try {
    const raw = readFileSync(join(customThemesDir(), `${name}.json`), 'utf8')
    const file = JSON.parse(raw) as CustomThemeFile
    return resolveCustomTheme(file)
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

const chalk = new Chalk({ level: 3 })
const hex = (token: string): InstanceType<typeof Chalk> => chalk.hex(currentPalette[token as keyof ColorPalette] ?? currentPalette.text)

/** Style helpers by token name. */
export const color = {
  primary: (text: string) => hex('primary')(text),
  accent: (text: string) => hex('accent')(text),
  text: (text: string) => hex('text')(text),
  textStrong: (text: string) => chalk.bold.hex(currentPalette.textStrong)(text),
  textDim: (text: string) => hex('textDim')(text),
  textMuted: (text: string) => hex('textMuted')(text),
  border: (text: string) => hex('border')(text),
  success: (text: string) => hex('success')(text),
  warning: (text: string) => hex('warning')(text),
  error: (text: string) => hex('error')(text),
  roleUser: (text: string) => hex('roleUser')(text),
  shellMode: (text: string) => hex('shellMode')(text),
  /** Plain italics (kimi thinking parity). */
  italic: (text: string) => chalk.italic(text),
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

/** SettingsList palette from the semantic tokens. */
export const settingsListTheme: SettingsListTheme = {
  label: (text: string, selected: boolean) => selected ? chalk.bold.hex(currentPalette.textStrong)(text) : color.text(text),
  value: (text: string, selected: boolean) => selected ? color.primary(text) : color.textDim(text),
  description: (text: string) => color.textDim(text),
  cursor: color.primary('›'),
  hint: (text: string) => color.textMuted(text),
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
