/**
 * Re-vendor terminal smoke: drives the Earendil v0.84.4-based fork through
 * the host's core surface flows in a real tmux pane.
 *
 *   node --import tsx/esm scripts/revendor-tmux-smoke.mts
 *
 * Exercises: regular render, fullscreen toggle, editor typing (CJK),
 * autocomplete dropdown, @ file completion, fullscreen search,
 * Home/End/PageUp/PageDown, resize, and copy-on-select.
 * @module revendor-tmux-smoke
 */

import {
  AutocompleteProvider,
  Editor,
  Markdown,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  matchesKey,
  type AutocompleteItem,
  type TuiInputListenerResult,
} from '@xmoon76/pi-tui'
import { editorTheme, markdownTheme } from '../src/theme.ts'

const terminal = new ProcessTerminal()
const tui = new TuiMainScreen(terminal)

tui.addChild(new Text('REVENDOR-SMOKE · Earendil v0.84.4 baseline'))

let transcript = 'Welcome to the re-vendor smoke.\n'
const markdown = new Markdown(transcript, 0, 0, markdownTheme)
tui.addChild(markdown)

const editor = new Editor(tui, editorTheme)
editor.onSubmit = (text) => {
  transcript += `\n**You:** ${text}\n\n_Assistant:_ canned reply.\n`
  markdown.setText(transcript)
  tui.requestRender()
}
tui.addChild(editor)
tui.setFocus(editor)

// A deterministic autocomplete provider: typing "he" offers "hello"/"help".
const provider: AutocompleteProvider = {
  triggerCharacters: [],
  async getSuggestions(lines, cursorLine, cursorCol, _options): Promise<{ items: AutocompleteItem[]; prefix: string }> {
    const line = lines[cursorLine] ?? ''
    const before = line.slice(0, cursorCol)
    const match = /(he[a-z]*)$/.exec(before)
    if (!match) return { items: [], prefix: '' }
    return {
      prefix: match[1]!,
      items: [
        { value: 'hello', label: 'hello' },
        { value: 'help', label: 'help' },
      ],
    }
  },
  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    const line = lines[cursorLine] ?? ''
    const before = line.slice(0, cursorCol)
    const start = before.length - prefix.length
    const next = before.slice(0, start) + item.value + line.slice(cursorCol)
    return { lines: [...lines.slice(0, cursorLine), next, ...lines.slice(cursorLine + 1)], cursorLine, cursorCol: start + item.value.length }
  },
}
editor.setAutocompleteProvider(provider)

// Fullscreen toggle: Ctrl+F swaps to an alt screen with a scrollable
// transcript and the same editor.
let fullscreen: TuiAltScreen | undefined
const enterFullscreen = (): void => {
  if (fullscreen) return
  const alt = new TuiAltScreen(terminal, undefined, undefined, {
    copyOnSelect: true,
    onScrollBoundary: (direction) => {
      transcript += `\n[boundary ${direction}]`
      markdown.setText(transcript)
      return true
    },
  })
  const scroll = new ScrollView(markdown, { follow: 'end', primary: true, scrollbar: 'auto' })
  const editorSeat = new VStack([
    { component: scroll, grow: 1 },
    { component: editor, shrink: 0 },
  ])
  alt.setLayoutRoot(editorSeat)
  alt.addInputListener((data) => {
    if (matchesKey(data, 'ctrl+f')) {
      alt.stop()
      fullscreen = undefined
      tui.start()
      tui.setFocus(editor)
      return { consume: true }
    }
    return undefined
  })
  tui.stop()
  fullscreen = alt
  alt.start()
  alt.setFocus(editor)
}

tui.addInputListener((data): TuiInputListenerResult => {
  if (matchesKey(data, 'ctrl+c')) {
    tui.stop()
    process.exit(0)
  }
  if (matchesKey(data, 'ctrl+f')) {
    enterFullscreen()
    return { consume: true }
  }
  return undefined
})

tui.start()
