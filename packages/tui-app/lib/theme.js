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
/** The active palette; a light theme can swap this later. */
export const currentPalette = darkColors;
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
