/**
 * Minimal theme for the dsh-pi-tui surface, in the same style as pi-tui's
 * test themes. Chalk level 3 (truecolor) matches modern terminals.
 * @module @dsh-pi-tui/tui-app/theme
 */

import { Chalk } from 'chalk'
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@dsh-pi-tui/pi-tui'

const chalk = new Chalk({ level: 3 })

/** SelectList palette: selection, description, scroll, and empty-state hints. */
export const selectListTheme: SelectListTheme = {
  selectedPrefix: (text: string) => chalk.blue(text),
  selectedText: (text: string) => chalk.bold(text),
  description: (text: string) => chalk.dim(text),
  scrollInfo: (text: string) => chalk.dim(text),
  noMatch: (text: string) => chalk.dim(text),
}

/** Editor palette: only the border is styled; the rest is the terminal default. */
export const editorTheme: EditorTheme = {
  borderColor: (text: string) => chalk.dim(text),
  selectList: selectListTheme,
}

/** Markdown palette for assistant messages. */
export const markdownTheme: MarkdownTheme = {
  heading: (text: string) => chalk.bold.cyan(text),
  link: (text: string) => chalk.blue(text),
  linkUrl: (text: string) => chalk.dim(text),
  code: (text: string) => chalk.yellow(text),
  codeBlock: (text: string) => chalk.green(text),
  codeBlockBorder: (text: string) => chalk.dim(text),
  quote: (text: string) => chalk.italic(text),
  quoteBorder: (text: string) => chalk.dim(text),
  hr: (text: string) => chalk.dim(text),
  listBullet: (text: string) => chalk.cyan(text),
  bold: (text: string) => chalk.bold(text),
  italic: (text: string) => chalk.italic(text),
  strikethrough: (text: string) => chalk.strikethrough(text),
  underline: (text: string) => chalk.underline(text),
}
