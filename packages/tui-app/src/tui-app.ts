/**
 * The dsh-pi-tui application core: a small TUI surface over the pi-tui
 * framework. The terminal is injected so tests can drive a headless
 * virtual terminal (@xterm/headless) instead of a real TTY; the process
 * entry point (startProcessTui) supplies ProcessTerminal.
 * @module @dsh-pi-tui/tui-app/tui-app
 */

import {
  Box,
  Editor,
  Markdown,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  matchesKey,
  type OverlayHandle,
  type Terminal,
  type TuiInputListenerResult,
} from '@dsh-pi-tui/pi-tui'
import { editorTheme, markdownTheme } from './theme.ts'

/** Callbacks the application surface reports to its host (the dsh bundle). */
export interface TuiAppEvents {
  /** The user submitted a line in the editor. */
  onSubmit: (text: string) => void
  /** The user asked to quit (Ctrl+C in the TUI's own raw mode). */
  onExit: () => void
}

/** What an approval prompt shows; mirrors the approval/request payload. */
export interface ApprovalPromptRequest {
  /** The tool asking for permission. */
  toolName: string
  /** The asker's human-readable reason, when one exists. */
  reason?: string
  /** Aborting withdraws the prompt and settles `cancelled`. */
  signal?: AbortSignal
}

/** Closed approval outcomes the user can produce at the prompt. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

/** One todo entry as logged by todo/write; statuses and text verbatim. */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** One queued prompt awaiting the user's y/n/esc decision. */
interface PendingApproval {
  request: ApprovalPromptRequest
  resolve: (outcome: ApprovalOutcome) => void
  handle?: OverlayHandle
  onAbort?: () => void
}

/**
 * The minimal interactive surface: a header line plus a multiline editor.
 * Owns the TUI lifecycle; input routing and rendering decisions live here
 * so they are testable without a real terminal.
 */
export class TuiApp {
  private readonly tui: TuiMainScreen
  private readonly editor: Editor
  private readonly markdown: Markdown
  private readonly header: Text
  private readonly events: TuiAppEvents
  /** Prompts awaiting the user's decision; one is shown at a time. */
  private readonly approvalQueue: PendingApproval[] = []
  /** The prompt currently on screen, if any. */
  private activeApproval: PendingApproval | undefined

  constructor(terminal: Terminal, events: TuiAppEvents) {
    this.events = events
    this.tui = new TuiMainScreen(terminal)
    this.editor = new Editor(this.tui, editorTheme)
    this.editor.onSubmit = (text) => this.events.onSubmit(text)
    this.markdown = new Markdown('', 0, 0, markdownTheme)
    this.header = new Text('dsh-pi-tui')
    this.tui.addChild(this.header)
    this.tui.addChild(this.markdown)
    this.tui.addChild(this.editor)
    this.tui.setFocus(this.editor)
    this.tui.addInputListener((data): TuiInputListenerResult => {
      if (this.activeApproval !== undefined) {
        return this.handleApprovalKey(data)
      }
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

  /** Replace the transcript body and request a re-render. */
  setTranscript(text: string): void {
    this.markdown.setText(text)
    this.tui.requestRender()
  }

  /**
   * Reflect the todo list in the header line: active (non-completed) count
   * and, when the list is non-empty, the first active item's text.
   * @param todos - the latest todo/write snapshot.
   */
  setTodoSummary(todos: readonly TodoItem[]): void {
    const active = todos.filter(todo => todo.status !== 'completed')
    const done = todos.length - active.length
    if (active.length === 0) {
      this.header.setText(done > 0 ? `dsh-pi-tui · ${done} todo done` : 'dsh-pi-tui')
    } else {
      const first = active[0]
      const label = first === undefined ? '' : first.content.length > 30 ? `${first.content.slice(0, 30)}…` : first.content
      this.header.setText(`dsh-pi-tui · ${active.length} active · ${label}`)
    }
    this.tui.requestRender()
  }

  /**
   * Queue an approval prompt and resolve when the user decides. Requests
   * queue FIFO; only one dialog is on screen at a time. An aborted signal
   * settles the prompt `cancelled` immediately.
   * @param request - the tool, reason, and optional abort signal.
   * @returns the user's decision.
   */
  showApprovalPrompt(request: ApprovalPromptRequest): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
      const pending: PendingApproval = { request, resolve }
      if (request.signal !== undefined) {
        const onAbort = (): void => this.settleApproval(pending, 'cancelled')
        pending.onAbort = onAbort
        request.signal.addEventListener('abort', onAbort, { once: true })
        if (request.signal.aborted) {
          this.settleApproval(pending, 'cancelled')
          return
        }
      }
      this.approvalQueue.push(pending)
      this.showNextApproval()
    })
  }

  /** Render the next queued prompt, if any and none is showing. */
  private showNextApproval(): void {
    if (this.activeApproval !== undefined || this.approvalQueue.length === 0) return
    const pending = this.approvalQueue.shift()
    if (pending === undefined) return
    const dialog = new Box(1, 1)
    dialog.addChild(new Text(`Approve ${pending.request.toolName}?`))
    if (pending.request.reason !== undefined && pending.request.reason !== '') {
      dialog.addChild(new Text(pending.request.reason))
    }
    dialog.addChild(new Text(''))
    dialog.addChild(new Text('[y] allow once   [n] reject   [esc] cancel'))
    pending.handle = this.tui.showOverlay(dialog, { width: 60, maxHeight: 10 })
    this.activeApproval = pending
  }

  /** Route a key while a prompt is showing; every key is consumed. */
  private handleApprovalKey(data: string): TuiInputListenerResult {
    const pending = this.activeApproval
    if (pending === undefined) return undefined
    if (matchesKey(data, 'y')) this.settleApproval(pending, 'allowed-once')
    else if (matchesKey(data, 'n')) this.settleApproval(pending, 'rejected')
    else if (matchesKey(data, 'escape')) this.settleApproval(pending, 'cancelled')
    return { consume: true }
  }

  /** Resolve one prompt, hide its dialog, and show the next in line. */
  private settleApproval(pending: PendingApproval, outcome: ApprovalOutcome): void {
    if (this.activeApproval !== pending) return
    this.activeApproval = undefined
    pending.handle?.hide()
    pending.onAbort !== undefined && pending.request.signal !== undefined
      && pending.request.signal.removeEventListener('abort', pending.onAbort)
    pending.resolve(outcome)
    this.tui.setFocus(this.editor)
    this.showNextApproval()
  }
}

/** Start the TUI on the process terminal (raw-mode stdin/stdout). */
export function startProcessTui(events: TuiAppEvents): TuiApp {
  const app = new TuiApp(new ProcessTerminal(), events)
  app.start()
  return app
}
