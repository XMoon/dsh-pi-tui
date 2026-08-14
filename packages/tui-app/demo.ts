/**
 * Interactive demo of the dsh-pi-tui surface: run it in a real terminal.
 *
 *   node --import tsx/esm demo.ts
 *
 * Type a message and press Enter; the transcript area echoes it plus a
 * canned assistant reply (no model is connected in this milestone).
 * Ctrl+C exits.
 * @module @xmoon76/tui-app/demo
 */

import {
  Editor,
  Markdown,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  matchesKey,
  type TuiInputListenerResult,
} from '@xmoon76/pi-tui'
import { editorTheme, markdownTheme } from './src/theme.ts'

const terminal = new ProcessTerminal()
const tui = new TuiMainScreen(terminal)

tui.addChild(new Text('dsh-pi-tui · demo mode'))

let transcript = 'Welcome to **dsh-pi-tui**. Type a message below and press Enter.\n'
const markdown = new Markdown(transcript, 0, 0, markdownTheme)
tui.addChild(markdown)

const editor = new Editor(tui, editorTheme)
editor.onSubmit = (text) => {
  transcript += `\n**You:** ${text}\n\n_Assistant:_ canned reply — no model connected in this milestone yet.\n`
  markdown.setText(transcript)
  tui.requestRender()
}
tui.addChild(editor)
tui.setFocus(editor)

tui.addInputListener((data): TuiInputListenerResult => {
  if (matchesKey(data, 'ctrl+c')) {
    tui.stop()
    process.exit(0)
  }
  return undefined
})

tui.start()
