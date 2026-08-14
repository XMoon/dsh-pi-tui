/**
 * Semantic color palette for the dsh-pi-tui surface, aligned with pi's
 * theme-token vocabulary (colors.ts): brand, text, surface, state, diff,
 * and role tokens. Components read tokens through the helper functions
 * below; switching palettes later only swaps this module's exports.
 * @module @dsh-pi-tui/tui-app/theme
 */
import { Chalk } from 'chalk';
/** Dark palette (default), tuned for ≥ 4.5:1 contrast on black. */
export const darkColors = {
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
};
/** Light palette, tuned for ≥ 4.5:1 contrast on white (pi's values). */
export const lightColors = {
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
};
/** The active palette; style helpers read it on every call, so swapping is live. */
export let currentPalette = darkColors;
/**
 * Switch the active palette; callers must invalidate rendered components.
 * `custom` uses the full palette in `customPalette`, or falls back to dark.
 * @param theme - the palette family.
 * @param custom - the resolved custom palette when `theme` is `custom`.
 */
export function setTheme(theme, custom) {
    if (theme === 'custom' && custom !== undefined) {
        currentPalette = custom;
    }
    else {
        currentPalette = theme === 'light' ? lightColors : darkColors;
    }
}
/** Build a full palette from a custom theme file (base + overrides). */
export function resolveCustomTheme(file) {
    const base = file.base === 'light' ? lightColors : darkColors;
    return { ...base, ...file.colors };
}
/**
 * Classify a terminal background colour (OSC 11 reply) as dark or light by
 * relative luminance; a bright background selects the light palette.
 * @param rgb - the reported background colour.
 * @returns the matching palette family.
 */
export function detectThemeFromBackground(rgb) {
    const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
    return luminance >= 0.5 ? 'light' : 'dark';
}
const chalk = new Chalk({ level: 3 });
const hex = (token) => chalk.hex(currentPalette[token] ?? currentPalette.text);
/** Style helpers by token name. */
export const color = {
    primary: (text) => hex('primary')(text),
    accent: (text) => hex('accent')(text),
    text: (text) => hex('text')(text),
    textStrong: (text) => chalk.bold.hex(currentPalette.textStrong)(text),
    textDim: (text) => hex('textDim')(text),
    textMuted: (text) => hex('textMuted')(text),
    border: (text) => hex('border')(text),
    success: (text) => hex('success')(text),
    warning: (text) => hex('warning')(text),
    error: (text) => hex('error')(text),
    roleUser: (text) => hex('roleUser')(text),
    shellMode: (text) => hex('shellMode')(text),
};
/** SelectList palette from the semantic tokens. */
export const selectListTheme = {
    selectedPrefix: (text) => color.primary(text),
    selectedText: (text) => chalk.bold(text),
    description: (text) => color.textDim(text),
    scrollInfo: (text) => color.textMuted(text),
    noMatch: (text) => color.textMuted(text),
};
/** SettingsList palette from the semantic tokens. */
export const settingsListTheme = {
    label: (text, selected) => selected ? chalk.bold.hex(currentPalette.textStrong)(text) : color.text(text),
    value: (text, selected) => selected ? color.primary(text) : color.textDim(text),
    description: (text) => color.textDim(text),
    cursor: color.primary('›'),
    hint: (text) => color.textMuted(text),
};
/** Editor palette: focused border uses the brand token. */
export const editorTheme = {
    borderColor: (text) => color.border(text),
    selectList: selectListTheme,
};
/** Markdown palette for assistant messages. */
export const markdownTheme = {
    heading: (text) => chalk.bold.hex(currentPalette.textStrong)(text),
    link: (text) => color.primary(text),
    linkUrl: (text) => color.textMuted(text),
    code: (text) => color.primary(text),
    codeBlock: (text) => text,
    codeBlockBorder: (text) => color.textMuted(text),
    quote: (text) => color.textDim(text),
    quoteBorder: (text) => color.textDim(text),
    hr: (text) => color.border(text),
    listBullet: (text) => color.text(text.replace(/^-/, '•')),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
};
