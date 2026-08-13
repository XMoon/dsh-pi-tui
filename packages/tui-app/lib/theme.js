/**
 * Minimal theme for the dsh-pi-tui surface, in the same style as pi-tui's
 * test themes. Chalk level 3 (truecolor) matches modern terminals.
 * @module @dsh-pi-tui/tui-app/theme
 */
import { Chalk } from 'chalk';
const chalk = new Chalk({ level: 3 });
/** SelectList palette: selection, description, scroll, and empty-state hints. */
export const selectListTheme = {
    selectedPrefix: (text) => chalk.blue(text),
    selectedText: (text) => chalk.bold(text),
    description: (text) => chalk.dim(text),
    scrollInfo: (text) => chalk.dim(text),
    noMatch: (text) => chalk.dim(text),
};
/** Editor palette: only the border is styled; the rest is the terminal default. */
export const editorTheme = {
    borderColor: (text) => chalk.dim(text),
    selectList: selectListTheme,
};
/** Markdown palette for assistant messages. */
export const markdownTheme = {
    heading: (text) => chalk.bold.cyan(text),
    link: (text) => chalk.blue(text),
    linkUrl: (text) => chalk.dim(text),
    code: (text) => chalk.yellow(text),
    codeBlock: (text) => chalk.green(text),
    codeBlockBorder: (text) => chalk.dim(text),
    quote: (text) => chalk.italic(text),
    quoteBorder: (text) => chalk.dim(text),
    hr: (text) => chalk.dim(text),
    listBullet: (text) => chalk.cyan(text),
    bold: (text) => chalk.bold(text),
    italic: (text) => chalk.italic(text),
    strikethrough: (text) => chalk.strikethrough(text),
    underline: (text) => chalk.underline(text),
};
