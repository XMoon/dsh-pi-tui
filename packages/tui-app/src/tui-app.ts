/**
 * The dsh-pi-tui application core: a small TUI surface over the pi-tui
 * framework. The terminal is injected so tests can drive a headless
 * virtual terminal (@xterm/headless) instead of a real TTY; the process
 * entry point (startProcessTui) supplies ProcessTerminal.
 * @module @dsh-pi-tui/tui-app/tui-app
 */

import {
  Editor,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  matchesKey,
  type Terminal,
  type TuiInputListenerResult,
} from '@dsh-pi-tui/pi-tui'
import { editorTheme } from './theme.ts'

/** Callbacks the application surface reports to its host (the dsh bundle). */
export interface TuiAppEvents {
  /** The user submitted a line in the editor. */
  onSubmit: (text: string) => void
  /** The user asked to quit (Ctrl+C in the TUI's own raw mode). */
  onExit: () => void
}

/**
 * The minimal interactive surface: a header line plus a multiline editor.
 * Owns the TUI lifecycle; input routing and rendering decisions live here
 * so they are testable without a real terminal.
 */
export class TuiApp {
  private readonly tui: TuiMainScreen
  private readonly editor: Editor
  private readonly events: TuiAppEvents

  constructor(terminal: Terminal, events: TuiAppEvents) {
    this.events = events
    this.tui = new TuiMainScreen(terminal)
    this.editor = new Editor(this.tui, editorTheme)
    this.editor.onSubmit = (text) => this.events.onSubmit(text)
    this.tui.addChild(new Text('dsh-pi-tui'))
    this.tui.addChild(this.editor)
    this.tui.setFocus(this.editor)
    this.tui.addInputListener((data): TuiInputListenerResult => {
      if (matchesKey(data, 'ctrl+c')) {
        this.events.onExit()
        return { consume: true }
      }
      return undefined
    })
  }

  /** Enter raw mode and start rendering. */
  start(): void {
    this.tui.start()
  }

  /** Leave raw mode and stop rendering. */
  stop(): void {
    this.tui.stop()
  }
}

/** Start the TUI on the process terminal (raw-mode stdin/stdout). */
export function startProcessTui(events: TuiAppEvents): TuiApp {
  const app = new TuiApp(new ProcessTerminal(), events)
  app.start()
  return app
}
