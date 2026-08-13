/**
 * Semantic color palette for the dsh-pi-tui surface, aligned with pi's
 * theme-token vocabulary (colors.ts): brand, text, surface, state, diff,
 * and role tokens. Components read tokens through the helper functions
 * below; switching palettes later only swaps this module's exports.
 * @module @dsh-pi-tui/tui-app/theme
 */

import { Chalk } from 'chalk'
import type {
  EditorTheme,
  MarkdownTheme,
  SelectListTheme,
  SettingsListTheme,
} from '@dsh-pi-tui/pi-tui'

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

/** Switch the active palette; callers must invalidate rendered components. */
export function setTheme(theme: 'dark' | 'light'): void {
  currentPalette = theme === 'light' ? lightColors : darkColors
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
}

/** SelectList palette from the semantic tokens. */
export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => color.primary(text),
  selectedText: (text: string) => chalk.bold(text),
  description: (text: string) => color.textDim(text),
  scrollInfo: (text: string) => color.textMuted(text),
  noMatch: (text: string) => color.textMuted(text),
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
