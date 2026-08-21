/**
 * Side-by-side preview of user-role visual schemes — repo code untouched,
 * pure display. Run in a real TTY (tmux):
 *
 *   env -u NO_COLOR node --import tsx/esm scripts/preview-role-styles.mts
 *
 * Shows the chosen scheme — background bubble with a brand-blue ❯ (dsh-web
 * parity) — in both the dark palette and the light palette, next to the
 * old kimi-style amber text for contrast, plus the editor-prompt colours.
 * Ctrl+C exits.
 * @module @xmoon76/dsh-pi-tui/preview-role-styles
 */

import { Chalk } from 'chalk'
import {
  ProcessTerminal, Text, TuiMainScreen, matchesKey,
  visibleWidth, wrapTextWithAnsi, type TuiInputListenerResult,
} from '@xmoon76/pi-tui'

const chalk = new Chalk({ level: 3 })
const dim = (s: string): string => chalk.hex('#888888')(s)
const darkBlue = (s: string): string => chalk.bold.hex('#679EFE')(s)
const darkBubbleBg = (s: string): string => chalk.bgHex('#2C2C2F')(s)
const lightBlue = (s: string): string => chalk.bold.hex('#4177E6')(s)
const lightBubbleBg = (s: string): string => chalk.bgHex('#E4EDFD')(s)
const amber = (s: string): string => chalk.bold.hex('#FFCB6B')(s)
const border = (s: string): string => chalk.hex('#5A5A5A')(s)

const W = 100
const MSG_ONE = 'Check the config load order — ENOTFOUND at src/app.ts:42, likely a missing env var.'
const MSG_TWO = 'Also verify the .env.example keys against the docs, since the preset loader reads them in sequence.'

/**
 * Wrap `text` to `width - 2` cells. The first row carries the plain `❯ `
 * marker, continuation rows indent 2 cells under it; every row is padded
 * to the full inner width so a background paint covers the whole row.
 */
function wrapped(width: number, text: string): string[] {
  const inner = Math.max(1, width - 2)
  return wrapTextWithAnsi(text, inner).map((line, index) => {
    const prefix = index === 0 ? '❯ ' : '  '
    return prefix + line + ' '.repeat(Math.max(0, inner - visibleWidth(line)))
  })
}

/** Bubble rows: full-row background, coloured ❯, body in the terminal default. */
function bubble(width: number, text: string, bg: (s: string) => string, bullet: (s: string) => string): string[] {
  return wrapped(width, text).map((row, index) => {
    if (index === 0 && row.startsWith('❯ ')) {
      return bg(bullet('❯') + ' ' + row.slice(2))
    }
    return bg(row)
  })
}

/** Old kimi look: the whole row (❯ + body + padding) in one amber paint. */
function amberRows(width: number, text: string): string[] {
  return wrapped(width, text).map(amber)
}

const blocks: string[] = [
  dim('dsh-pi-tui · user-role style preview (repo untouched) — Ctrl+C to exit'),
  '',
  dim('dark · bubble + brand-blue ❯ (chosen scheme)'),
  ...bubble(W, MSG_ONE, darkBubbleBg, darkBlue),
  ...bubble(W, MSG_TWO, darkBubbleBg, darkBlue),
  '',
  dim('light · bubble + deep brand-blue ❯ (light palette)'),
  ...bubble(W, MSG_ONE, lightBubbleBg, lightBlue),
  ...bubble(W, MSG_TWO, lightBubbleBg, lightBlue),
  '',
  dim('kimi amber text (rejected — kept for contrast)'),
  ...amberRows(W, MSG_ONE),
  ...amberRows(W, MSG_TWO),
  '',
  dim('editor prompt candidates:'),
  border('─'.repeat(W)),
  ` ${darkBlue('❯')} git status   ${lightBlue('❯')} git status   ${amber('❯')} git status`,
  border('─'.repeat(W)),
]

// Pad every line to the exact width so nothing wraps.
const preview = blocks
  .map(line => line + ' '.repeat(Math.max(0, W - visibleWidth(line))))
  .join('\n')

const terminal = new ProcessTerminal()
const tui = new TuiMainScreen(terminal)
tui.addChild(new Text(preview, 0, 0))
tui.addInputListener((data): TuiInputListenerResult => {
  if (matchesKey(data, 'ctrl+c')) {
    tui.stop()
    process.exit(0)
  }
  return undefined
})
tui.start()
