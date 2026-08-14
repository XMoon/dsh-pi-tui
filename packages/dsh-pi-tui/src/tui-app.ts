/**
 * The dsh-pi-tui application core: the interactive surface over the pi-tui
 * framework. The terminal is injected so tests can drive a headless
 * virtual terminal (@xterm/headless) instead of a real TTY; the process
 * entry point (startProcessTui) supplies ProcessTerminal.
 *
 * Surface layout (regular mode): header (todo status), message transcript,
 * editor, footer status line. Fullscreen mode (Ctrl+F) renders the same
 * component tree through TuiAltScreen's layout engine, where the transcript
 * scrolls inside the alt screen.
 *
 * Keys: Enter submit, Ctrl+C/Ctrl+D exit, Ctrl+O expand/collapse recent turns,
 * Ctrl+F toggle fullscreen, Tab autocomplete (slash commands + paths).
 * @module @xmoon76/dsh-pi-tui/tui-app
 */

import {
  Box,
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Markdown,
  ProcessTerminal,
  ScrollView,
  SelectList,
  SettingsList,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  type SettingItem,
  type SlashCommand,
  type Terminal,
  type TuiInputListenerResult,
} from '@xmoon76/pi-tui'
import {
  detectThemeFromBackground,
  editorTheme,
  markdownTheme,
  selectListTheme,
  settingsListTheme,
  setTheme,
  type ColorPalette,
} from './theme.ts'
import { isDiffResult, renderDiffLines, renderDiffView } from './diff.ts'
import { firstLine, latestLine, relativizeToCwd, toolCardHeader, toolEmoji, type ToolPresenter } from './present.ts'
import { TranscriptSearchComponent } from './search.ts'
import { recentTurnThreshold, type TranscriptMessage } from './transcript.ts'
import { WorkingIndicator } from './working.ts'

/** How many most-recent turns Ctrl+O expands; mirrors pi's default. */
export const EXPAND_RECENT_TURNS = 3
/** Folded preview lines for tool results; mirrors pi's RESULT_PREVIEW_LINES. */
export const RESULT_PREVIEW_LINES = 3

/** First lines of a multi-line text, joined for folded previews. */
function preview(text: string, lines: number): string {
  const parts = text.split('\n')
  const first = parts.slice(0, lines).join(' ').trim()
  const rest = parts.length > lines ? '…' : ''
  // Width-based truncation, not code-unit slicing: a raw slice can split a
  // surrogate pair / ZWJ emoji in the middle. The overflow marker rides in
  // the ellipsis slot (it is the same '…' the rest-marker would add).
  return truncateToWidth(first, rest === '' ? 120 : 119, rest)
}



/** Context bar width in cells; pi renders `[███░░░] pct` in the footer. */
const CONTEXT_BAR_WIDTH = 12

/**
 * Rounded-frame wrapper for overlay content: `╭─╮` border in the border
 * token, one cell of padding, width sized to the content. Keyboard input
 * forwards to the wrapped component.
 */
export class Frame implements Component {
  private readonly child: Component

  constructor(child: Component) {
    this.child = child
  }

  invalidate(): void {
    this.child.invalidate?.()
  }

  handleInput(data: string): void {
    this.child.handleInput?.(data)
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.child.wantsKeyRelease
  }

  render(width: number): string[] {
    const inner = Math.max(1, Math.floor(width) - 4)
    const lines = this.child.render(inner).map(line => truncateToWidth(line, inner, '…'))
    const contentWidth = Math.min(inner, Math.max(1, ...lines.map(line => visibleWidth(line))))
    const frameWidth = contentWidth + 4
    const b = color.border
    const out = [b(`╭${'─'.repeat(frameWidth - 2)}╮`)]
    for (const line of lines) {
      const vis = visibleWidth(line)
      // Row shape is `│ line pad │`: borders and one padding cell each side
      // are fixed, so padding only tops the content up to `inner` — the row
      // is then exactly frameWidth cells and the right border survives
      // compositing.
      const pad = Math.max(0, inner - vis)
      out.push(`${b('│')} ${line}${' '.repeat(pad)} ${b('│')}`)
    }
    out.push(b(`╰${'─'.repeat(frameWidth - 2)}╯`))
    return out
  }
}

/** The session head card: identity facts, wrapped to the available width so
 * nothing is truncated, framed with a box whose width matches the editor's
 * border below it (a fixed-width rule looked misaligned next to the frame). */
class WelcomeCard implements Component {
  private facts: { cwd: string; sessionId: string; model: string; version: string; preset?: string } | undefined
  private lastWidth = -1
  private cached: string[] = []

  /** Replace the facts; the next render rebuilds the card. */
  setFacts(facts: { cwd: string; sessionId: string; model: string; version: string; preset?: string }): void {
    this.facts = facts
    this.cached = []
  }

  invalidate(): void {
    this.cached = []
  }

  render(width: number): string[] {
    const facts = this.facts
    if (facts === undefined) return []
    if (this.lastWidth === width && this.cached.length > 0) return this.cached
    this.lastWidth = width
    // Three columns: the session identity (full id — never truncated), the
    // model/preset, and the workspace. Each row wraps instead of ellipsizing,
    // so the box keeps the important facts readable.
    const line1 = `🐋 session ${color.textDim(facts.sessionId)}`
    const line2 = [
      color.text(facts.model),
      facts.preset === undefined ? '' : `preset ${color.textMuted(facts.preset)}`,
    ].filter(part => part !== '').join(' · ')
    const line3 = [
      color.textMuted(facts.cwd),
      `v${facts.version}`,
    ].filter(part => part !== '').join(' · ')
    // Wrap each line to the box's inner width so long identities read in
    // full instead of ending in an ellipsis; the box spans the same width
    // as the editor border below it.
    const inner = Math.max(1, width - 4)
    const b = color.border
    this.cached = [
      b(`╭${'─'.repeat(Math.max(0, width - 2))}╮`),
      ...[line1, line2, line3].flatMap(line => wrapTextWithAnsi(line, inner).map(wrapped => {
        const vis = visibleWidth(wrapped)
        return `${b('│')} ${wrapped}${' '.repeat(Math.max(0, inner - vis))} ${b('│')}`
      })),
      b(`╰${'─'.repeat(Math.max(0, width - 2))}╯`),
    ]
    return this.cached
  }
}

/** Pi-style context progress bar: `[███░░░░░░░░░] 25%`. */
function contextBar(used: number, window: number): string {
  const ratio = Math.min(1, Math.max(0, used / window))
  const filled = Math.round(ratio * CONTEXT_BAR_WIDTH)
  const pct = Math.min(100, Math.max(0, Math.ceil(ratio * 100)))
  const bar = '█'.repeat(filled) + '░'.repeat(CONTEXT_BAR_WIDTH - filled)
  return `${color.primary(`[${bar}]`)} ${pct}%`
}

/** Callbacks the application surface reports to its host (the dsh bundle). */
export interface TuiAppEvents {
  /** The user submitted a line in the editor. */
  onSubmit: (text: string) => void
  /** The user asked to quit (Ctrl+C in the TUI's own raw mode). */
  onExit: () => void
  /** Double-Esc: stop the current activity (turn, tool run). Optional. */
  onCancel?: () => void
  /** Ctrl+S: steer the running turn with the current draft. Optional. */
  onSteer?: (text: string) => void
  /**
   * Ctrl+G: open the external editor with the current draft. The TUI stops
   * before the call and restarts after it resolves; return the new text.
   * Optional.
   */
  openExternalEditor?: (draft: string) => Promise<string>
  /** Fullscreen mode changed (Ctrl+F toggle or a settings-panel write). Optional. */
  onFullscreenChange?: (fullscreen: boolean) => void
  /** The transcript-search query changed (Ctrl+Shift+F opens the search). Optional. */
  onSearchQuery?: (query: string) => void
  /** Enter inside the search: jump to the next match. Optional. */
  onSearchNext?: () => void
  /** Shift+Enter inside the search: jump to the previous match. Optional. */
  onSearchPrev?: () => void
  /** The search was closed (Escape). Optional. */
  onSearchClose?: () => void
  /**
   * The FIRST Esc press with no overlay up. The host may consume it (return
   * true) to exit a runner-owned mode (e.g. the subagent viewer) instead of
   * arming the double-Esc cancel. Optional.
   */
  onSingleEscape?: () => boolean | void
}

/** What an approval prompt shows; mirrors the approval/request payload. */
export interface ApprovalPromptRequest {
  /** The tool asking for permission. */
  toolName: string
  /** The asker's human-readable reason, when one exists. */
  reason?: string
  /** Aborting withdraws the prompt and settles `cancelled`. */
  signal?: AbortSignal
  /** The tool call's arguments (paired via the request's callId), when known. */
  arguments?: string
  /** A destructive command matched a danger pattern; render a warning. */
  danger?: boolean
}

/** Closed approval outcomes the user can produce at the prompt. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

/** One todo entry as logged by todo/write; statuses and text verbatim. */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** One question in a user-questions ask (dsh shape mirrored for testability). */
export interface TuiQuestion {
  /** Stable caller-provided id, echoed in the answer. */
  id: string
  /** The question to display. */
  question: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional choices rendered as a numbered menu. */
  options?: readonly { label: string; description?: string }[]
  /** Whether more than one option may be selected. */
  multiSelect?: boolean
}

/** One answered question, keyed by id. */
export interface TuiQuestionAnswer {
  /** The answered question id. */
  id: string
  /** Selected option labels. */
  selected: string[]
  /** Free-text answer for questions without options. */
  custom?: string
}

/** Live state of one user-questions flow (one question on screen at a time). */
interface QuestionState {
  questions: readonly TuiQuestion[]
  /** The question currently on screen. */
  index: number
  /** Selected labels per question id. */
  selected: Map<string, Set<string>>
  /** Free-text answers per question id (no-option questions). */
  custom: Map<string, string>
  /** Typed free-text for the current no-option question. */
  customText: string
  handle?: OverlayHandle
  resolve: (answers: TuiQuestionAnswer[]) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
}

/** One picker row; `group` renders a workspace-style header before the group. */
export interface PickerItem {
  value: string
  label: string
  description?: string
  group?: string
}

/** Options for {@link TuiApp.openPicker}. */
export interface PickerOptions {
  /** Show a search input; typing filters rows by id/label/description. */
  enableSearch?: boolean
  /** Title line above the rows (carries `filtered/total` when search is on). */
  header?: string
  /** Text shown when no row matches the filter. */
  noMatchText?: string
  /** Pre-fill the search input (e.g. `/sessions <query>`). */
  initialQuery?: string
  /** Overlay width in cells (default 64). */
  width?: number
  /** Overlay max height in rows (default 24). */
  maxHeight?: number
  /** Render the key-hint footer line. */
  showHint?: boolean
}

/** Live control of an open picker. */
export interface PickerHandle {
  /** Close the picker without a selection. */
  close(): void
  /** Replace the rows while the picker is open; the active query re-applies. */
  setItems(items: readonly PickerItem[]): void
}

/** Footer status data supplied by the runner. */
export interface StatusData {
  /** Provider/model label, e.g. `opencode-go/deepseek-v4-flash`. */
  model: string
  /** The working directory, shortened for display. */
  cwd: string
  /** Git branch name, empty when not a git checkout. */
  branch: string
  /** Active goal badge text (e.g. `goal ● objective`), when a goal is live. */
  goal?: string
  /** Completed turns and steps so far. */
  turns: number
  /** Steps (model requests) so far. */
  steps: number
  /** Stats line (pi vocabulary), preformatted by the runner. */
  statsLine: string
  /** Current context pressure in tokens, when measured. */
  contextTokens?: number
  /** Context window in tokens, when known. */
  contextWindow?: number
}

/** One queued prompt awaiting the user's y/n/esc decision. */
interface PendingApproval {
  request: ApprovalPromptRequest
  resolve: (outcome: ApprovalOutcome) => void
  handle?: OverlayHandle
  onAbort?: () => void
  /** Settled once: an abort and a user decision must not double-resolve. */
  settled?: boolean
}

/** Injectable TuiApp options; every field is optional. */
export interface TuiAppOptions {
  /** How long a notify line stays before it auto-clears, in ms. */
  notifyDurationMs?: number
  /** Session workspace root; workspace-rooted path summaries display relative to it. */
  workspaceRoot?: string
  /** Tool presentation bridge (web-parity cards via the live tool registry). */
  present?: ToolPresenter
  /** Working-indicator frame interval in ms; injectable so tests stay fast. */
  workingIntervalMs?: number
}

/**
 * The interactive surface: header, transcript, editor, footer. Owns the
 * TUI lifecycle, mode switching, folding, approval dialogs, and settings
 * overlay; input routing and rendering decisions live here so they are
 * testable without a real terminal.
 */
export class TuiApp {
  private readonly terminal: Terminal
  private readonly tui: TuiMainScreen
  private readonly editor: Editor
  private readonly header: Text
  private readonly messagesView: Container
  private readonly footer: Text
  private readonly events: TuiAppEvents
  /** Prompts awaiting the user's decision; one is shown at a time. */
  private readonly approvalQueue: PendingApproval[] = []
  /** The prompt currently on screen, if any. */
  private activeApproval: PendingApproval | undefined
  /** The active user-questions flow, if any (one at a time). */
  private activeQuestions: QuestionState | undefined
  /** The folded transcript; re-rendered into the messages view on change. */
  private messages: readonly TranscriptMessage[] = []
  /** Local (non-session) cards — e.g. `!` shell runs — rendered after the transcript. */
  private readonly localMessages: TranscriptMessage[] = []
  /** Submitted input history (newest first), mirrored for persistence. */
  private readonly inputHistory: string[] = []
  /** Cap for the persisted input history per working directory. */
  private static readonly INPUT_HISTORY_LIMIT = 100
  /** Ctrl+O master switch: expand the most recent turns' collapsible entries. */
  private toolOutputExpanded = false
  /** Alt+T: hide thinking entries entirely (they stay in the log). */
  private hideThinking = false
  /** The latest todo/write snapshot; rendered as a panel when visible. */
  private todoItems: readonly TodoItem[] = []
  /** Ctrl+T: whether the todo panel between transcript and editor is shown. */
  private todoPanelVisible = false
  /** The todo panel Text; empty when hidden. */
  private readonly todoPanel: Text

  /** Whether the Ctrl+O expansion master switch is on. */
  isToolOutputExpanded(): boolean {
    return this.toolOutputExpanded
  }

  /** Set the Ctrl+O expansion master switch and repaint. */
  setToolOutputExpanded(expanded: boolean): void {
    this.toolOutputExpanded = expanded
    this.rebuildMessages()
  }
  /** Fullscreen (alt-screen) instance; absent in regular mode. */
  private fullscreen: TuiAltScreen | undefined
  /** The mounted transcript-search overlay, while one is open. */
  private searchOverlay: OverlayHandle | undefined
  /** The search input component, while one is open (for match counts). */
  private searchComponent: TranscriptSearchComponent | undefined
  /** Overlay handles currently mounted on the active screen, for mode switches. */
  private readonly overlayHandles = new Set<OverlayHandle>()
  /** Footer state. */
  private status: StatusData = { model: '', cwd: '', branch: '', turns: 0, steps: 0, statsLine: '' }
  /** Header text (todo summary), kept for theme-swap repaints. */
  private headerText = '🐋 dsh-pi-tui'
  /** Footer text, kept for theme-swap repaints. */
  private footerText = ''
  /** Plan-mode badge state; appended to the header and footer when active. */
  private planMode = false
  /** The editor's normal border style, restored when plan mode ends. */
  private readonly editorBorder: (text: string) => string
  /** Todo summary segment of the header (without the base or badges). */
  private todoText = ''
  /** Welcome card shown above the transcript; renders nothing without facts. */
  private readonly welcomeCard = new WelcomeCard()
  /** Transient error line shown under the transcript; cleared by the next
   * repaint or after {@link TuiApp.NOTIFY_DURATION_MS}, whichever comes first. */
  private notifyText = ''
  /** The pending auto-clear for {@link notifyText}, while one is armed. */
  private notifyTimer: NodeJS.Timeout | undefined
  /** How long a notify line stays before it auto-clears, in ms. */
  private static readonly NOTIFY_DURATION_MS = 8000
  /** The notify auto-clear window; injectable so tests stay fast. */
  private readonly notifyDurationMs: number
  /** Timestamp of the last Esc press, for double-Esc cancellation. */
  private lastEscapeAt: number | undefined
  /** Double-Esc window in ms. */
  private static readonly ESCAPE_CANCEL_WINDOW_MS = 400
  /** Session workspace root for path relativization (Web relativizeToCwd). */
  private readonly workspaceRoot: string | undefined
  /** The tool presentation bridge, wired by the runner to the live registry. */
  private readonly present: ToolPresenter | undefined
  /** The busy indicator row directly above the editor border; idle renders nothing. */
  private readonly working: WorkingIndicator
  /** The fullscreen transcript ScrollView, for click hit-testing offsets. */
  private fullscreenScroll: ScrollView | undefined
  /**
   * Per-message expansion overrides from mouse clicks: a message whose entry
   * is true stays expanded even when the global fold is off; absent falls
   * back to the global boundary. The global Ctrl+O fold always wins, so the
   * keyboard behavior is unaffected by mouse toggles.
   */
  private readonly expandedOverride = new Map<TranscriptMessage, boolean>()
  /** Rendered row heights per transcript message, for mouse hit-testing. */
  private messageRows: ReadonlyArray<{ message: TranscriptMessage; height: number }> = []
  /** The live session's auto-generated title, shown in the header when set. */
  private sessionTitleText = ''

  constructor(terminal: Terminal, events: TuiAppEvents, options: TuiAppOptions = {}) {
    this.terminal = terminal
    this.events = events
    this.notifyDurationMs = options.notifyDurationMs ?? TuiApp.NOTIFY_DURATION_MS
    this.workspaceRoot = options.workspaceRoot
    this.present = options.present

    this.tui = new TuiMainScreen(terminal)
    this.editor = new Editor(this.tui, editorTheme)
    this.editorBorder = this.editor.borderColor
    this.editor.onSubmit = (text) => {
      this.rememberInput(text)
      this.events.onSubmit(text)
    }
    this.header = new Text('🐋 dsh-pi-tui', 0, 0)
    this.messagesView = new Container()
    this.todoPanel = new Text('', 0, 0)
    this.working = new WorkingIndicator(this.tui, options.workingIntervalMs === undefined
      ? {}
      : { intervalMs: options.workingIntervalMs })
    this.footer = new Text('', 0, 0)
    // The working row sits between the todo panel and the editor so it is
    // always the row directly above the editor border (pi's statusContainer).
    this.tui.addChild(this.header)
    this.tui.addChild(this.messagesView)
    this.tui.addChild(this.todoPanel)
    this.tui.addChild(this.working)
    this.tui.addChild(this.editor)
    this.tui.addChild(this.footer)
    this.tui.setFocus(this.editor)
    this.tui.addInputListener((data) => this.handleInput(data))
  }

  /** Enter raw mode and start rendering. */
  start(): void {
    this.tui.start()
  }

  /** Leave raw mode and stop rendering. */
  stop(): void {
    this.clearNotify()
    this.working.dispose()
    this.tui.stop()
    this.fullscreen?.stop()
    this.fullscreen = undefined
  }

  /** Shared key routing: questions, then approval, then folding/mode/cancel/exit. */
  private handleInput(data: string): TuiInputListenerResult {
    // Kitty-protocol terminals report press, repeat, and release events as
    // separate sequences; the app must act on the PRESS only. A release of
    // Ctrl+O would otherwise double-toggle the fold (press expands, release
    // collapses — a single press would appear to do nothing), and a release
    // of Esc would trip the double-Esc cancel. The framework already filters
    // releases for the focused component; listeners are on their own.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined
    if (this.activeQuestions !== undefined) {
      return this.handleQuestionKey(data)
    }
    if (this.activeApproval !== undefined) {
      return this.handleApprovalKey(data)
    }
    // Transcript search owns these keys while its overlay is up; everything
    // else falls through to the focused search input.
    if (this.searchOverlay !== undefined) {
      if (matchesKey(data, 'escape')) {
        this.closeTranscriptSearch()
        return { consume: true }
      }
      if (matchesKey(data, 'enter')) {
        this.events.onSearchNext?.()
        return { consume: true }
      }
      if (matchesKey(data, 'shift+enter')) {
        this.events.onSearchPrev?.()
        return { consume: true }
      }
      if (matchesKey(data, 'ctrl+f')) {
        // Ctrl+F is the search toggle; a second press closes the overlay.
        this.closeTranscriptSearch()
        return { consume: true }
      }
      return undefined
    }
    if (matchesKey(data, 'ctrl+shift+f') || matchesKey(data, 'ctrl+f')) {
      this.startTranscriptSearch()
      return { consume: true }
    }
    if (matchesKey(data, 'escape')) {
      // Overlays (pickers, settings) own Esc while they are up.
      if (this.overlayHost.hasOverlayEntries) return undefined
      // The host may consume the first Esc (runner-owned modes like the
      // subagent viewer); otherwise it arms the double-Esc cancel.
      if (this.events.onSingleEscape?.() === true) return { consume: true }
      const now = Date.now()
      if (this.lastEscapeAt !== undefined && now - this.lastEscapeAt < TuiApp.ESCAPE_CANCEL_WINDOW_MS) {
        this.lastEscapeAt = undefined
        this.events.onCancel?.()
      } else {
        this.lastEscapeAt = now
      }
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+o')) {
      this.toolOutputExpanded = !this.toolOutputExpanded
      this.rebuildMessages()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+t')) {
      // Todo panel toggle (kimi semantics; Ctrl+T never reaches the editor).
      this.toggleTodoPanel()
      return { consume: true }
    }
    if (matchesKey(data, 'alt+t')) {
      // Hide/show thinking entries independently of the Ctrl+O fold.
      this.toggleThinkingHidden()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+s')) {
      // Steer: send the draft into the running turn and clear the editor.
      if (this.overlayHost.hasOverlayEntries) return { consume: true }
      const draft = this.editor.getText()
      if (draft.trim() === '') return { consume: true }
      this.editor.setText('')
      this.events.onSteer?.(draft)
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+g')) {
      // External editor; overlays own Ctrl+G while up (alt-screen search).
      if (this.overlayHost.hasOverlayEntries) return { consume: true }
      void this.launchExternalEditor()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+c')) {
      this.events.onExit()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+d')) {
      // Ctrl+D quits like /exit (and Ctrl+C). The editor's delete-char-
      // forward remains on the Delete key.
      this.events.onExit()
      return { consume: true }
    }
    return undefined
  }

  /** The screen currently rendering: the alt screen in fullscreen mode. */
  private get overlayHost(): TuiMainScreen | TuiAltScreen {
    return this.fullscreen ?? this.tui
  }

  /**
   * Show an overlay on the active screen and track its handle, so a
   * fullscreen toggle can hide every mounted overlay on the old screen.
   * @param component - the overlay content.
   * @param options - overlay sizing/positioning.
   * @returns the handle; hide() also forgets the handle.
   */
  private showOverlayOnHost(component: Component, options: OverlayOptions): OverlayHandle {
    const handle = this.overlayHost.showOverlay(component, options)
    this.overlayHandles.add(handle)
    return {
      ...handle,
      hide: () => {
        this.overlayHandles.delete(handle)
        handle.hide()
      },
    }
  }

  /**
   * Launch the external editor with the current draft. The TUI stops first
   * (raw mode released) and restarts after the editor returns; a fullscreen
   * mode is not restored (the editor session ends in regular mode).
   */
  async launchExternalEditor(): Promise<void> {
    const open = this.events.openExternalEditor
    if (open === undefined) return
    const draft = this.editor.getText()
    this.stop()
    try {
      const next = await open(draft)
      if (next !== '') this.editor.setText(next)
    } finally {
      this.start()
    }
  }

  /** Record a submitted line into the editor history and the persistence mirror. */
  private rememberInput(text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    this.editor.addToHistory(trimmed)
    if (this.inputHistory[0] === trimmed) return
    this.inputHistory.unshift(trimmed)
    if (this.inputHistory.length > TuiApp.INPUT_HISTORY_LIMIT) this.inputHistory.pop()
  }

  /**
   * Seed the editor's recall history from persisted entries (newest first).
   * @param entries - persisted entries, most recent first.
   */
  seedInputHistory(entries: readonly string[]): void {
    // addToHistory unshifts, so seed oldest→newest to keep the persisted order.
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry === undefined) continue
      const trimmed = entry.trim()
      if (trimmed !== '') this.editor.addToHistory(trimmed)
    }
  }

  /** The current input history (newest first) for persistence. */
  getInputHistory(): readonly string[] {
    return [...this.inputHistory]
  }

  /**
   * Append a local card rendered after the session transcript (e.g. `!`
   * shell runs). The card is always expanded (its turn is unbounded).
   * @param message - the local card to show.
   * @returns the stored card reference, for {@link updateLocalMessage}.
   */
  pushLocalMessage(message: TranscriptMessage): TranscriptMessage {
    this.localMessages.push(message)
    this.rebuildMessages()
    return message
  }

  /**
   * Replace one local card by reference. Settling a card by its own identity
   * (not "the last one") keeps concurrent cards independent: a card settled
   * after a newer one was pushed must not overwrite the newer card.
   * @param message - the card reference {@link pushLocalMessage} returned.
   * @param next - the settled replacement.
   */
  updateLocalMessage(message: TranscriptMessage, next: TranscriptMessage): void {
    const index = this.localMessages.indexOf(message)
    if (index === -1) return
    this.localMessages[index] = next
    this.rebuildMessages()
  }

  /** Replace the most recent local card (running → settled). */
  updateLastLocalMessage(message: TranscriptMessage): void {
    const index = this.localMessages.length - 1
    if (index < 0) return
    this.localMessages[index] = message
    this.rebuildMessages()
  }

  /** Drop all local cards (session switch). */
  clearLocalMessages(): void {
    if (this.localMessages.length === 0) return
    this.localMessages.length = 0
    this.rebuildMessages()
  }

  /**
   * Toggle between regular (terminal scrollback) and fullscreen (alt screen).
   * Overlays live on the active screen, so the switch hides every mounted
   * overlay; a pending approval prompt is re-rendered on the new screen.
   */
  toggleFullscreen(): void {
    this.setFullscreen(this.fullscreen === undefined)
  }

  /** Whether the alt screen is currently active (fullscreen mode). */
  isFullscreen(): boolean {
    return this.fullscreen !== undefined
  }

  /**
   * Enter or leave fullscreen (alt screen), reporting the change through
   * {@link TuiAppEvents.onFullscreenChange} so the host can persist it.
   * @param enabled - true renders the alt screen, false returns to the main screen.
   */
  setFullscreen(enabled: boolean): void {
    const active = this.fullscreen !== undefined
    if (enabled === active) return
    const pending = this.activeApproval
    pending?.handle?.hide()
    for (const handle of this.overlayHandles) handle.hide()
    this.overlayHandles.clear()
    if (enabled) {
      // The alt screen owns mouse handling (wheel scroll, drag selection,
      // right-click paste — pi's fullscreen behavior); a same-cell primary
      // click reaches us through its onCellClick callback so cards can be
      // expanded individually, exactly like a web disclosure row.
      const alt = new TuiAltScreen(this.terminal, undefined, undefined, {
        onCellClick: (x, y) => this.handleFullscreenClick(x, y),
      })
      // Fullscreen layout: header and todo pinned, the transcript scrolls in
      // the middle (grow), and the editor + footer stay pinned to the bottom
      // of the screen — the implicit document scrollview would roll the
      // editor away with the transcript when scrolling back. The pinned rows
      // are shrink-proof: when a long transcript overflows the screen the
      // shrink pass must compress the SCROLL pane, never the editor.
      this.fullscreenScroll = new ScrollView(this.messagesView, {
        follow: 'end',
        primary: true,
        scrollbar: 'auto',
      })
      const root = new VStack([
        { component: this.header, shrink: 0 },
        // grow is a stack-entry option: the transcript pane takes all the
        // height the pinned rows leave behind.
        { component: this.fullscreenScroll, grow: 1 },
        { component: this.todoPanel, shrink: 0 },
        // The busy indicator row sits directly above the editor border
        // (pi's statusContainer placement); idle it renders zero rows.
        { component: this.working, shrink: 0 },
        { component: this.editor, shrink: 0 },
        { component: this.footer, shrink: 0 },
      ])
      alt.setLayoutRoot(root)
      alt.addInputListener((data) => this.handleInput(data))
      this.tui.stop()
      alt.start()
      // The alt screen starts with NO focused component: without this, every
      // key after Ctrl+F is dropped (the app-level listener still sees
      // shortcuts, but the editor never receives text or Enter).
      alt.setFocus(this.editor)
      this.fullscreen = alt
    } else {
      this.fullscreen?.stop()
      this.fullscreen = undefined
      this.fullscreenScroll = undefined
      this.tui.start()
      // The alt screen's exit repaint starts at the hardware cursor row, so
      // rows above it (e.g. a dialog the alt screen composited) survive in
      // the terminal buffer. Force a full repaint so the regular surface
      // redraws cleanly from row 0.
      this.tui.requestRender(true)
      this.tui.setFocus(this.editor)
    }
    this.events.onFullscreenChange?.(enabled)
    if (pending !== undefined) this.renderApprovalDialog(pending)
  }

  /**
   * Open the transcript-search overlay (Ctrl+Shift+F) and focus its input.
   * The search itself runs in the host against the folded transcript; this
   * surface only collects the query and reports navigation keys.
   */
  startTranscriptSearch(): void {
    if (this.searchOverlay !== undefined) {
      this.searchOverlay.focus()
      return
    }
    const component = new TranscriptSearchComponent((query) => {
      this.events.onSearchQuery?.(query)
    })
    this.searchComponent = component
    this.searchOverlay = this.showOverlayOnHost(component, {
      anchor: 'top-right',
      width: '40%',
      minWidth: 24,
      margin: 1,
    })
  }

  /** Close the transcript-search overlay and report the close. */
  closeTranscriptSearch(): void {
    if (this.searchOverlay === undefined) return
    this.searchOverlay.hide()
    this.searchOverlay = undefined
    this.searchComponent = undefined
    this.events.onSearchClose?.()
  }

  /** Publish the current match position for the overlay header (1-based, total). */
  setSearchResult(index: number, count: number): void {
    this.searchComponent?.setResult(index, count)
    this.searchComponent?.invalidate()
  }

  /** Whether the transcript search is open. */
  isSearching(): boolean {
    return this.searchOverlay !== undefined
  }

  /**
   * Replace the transcript and rebuild the message components. Collapsible
   * entries (thinking, tool cards) render folded unless the Ctrl+O master
   * switch is on and the entry belongs to the most recent turns.
   * @param messages - the folded transcript.
   */
  setTranscript(messages: readonly TranscriptMessage[]): void {
    this.messages = messages
    // A fresh transcript is a repaint: the transient notify line clears.
    this.clearNotify()
    this.rebuildMessages()
  }

  /** Rebuild the message component tree from the current transcript state. */
  private rebuildMessages(): void {
    this.messagesView.clear()
    this.messagesView.addChild(this.welcomeCard)
    const boundary = this.expandBoundary()
    // Row heights for mouse hit-testing: components render (and cache) at
    // the same width the frame pass uses, so the heights match the screen.
    const width = this.terminal.columns
    const rows: Array<{ message: TranscriptMessage; height: number }> = []
    for (const message of this.messages) {
      // Alt+T hides thinking entries without touching the fold state.
      if (message.kind === 'thinking' && this.hideThinking) continue
      const component = this.renderMessage(message, boundary)
      this.messagesView.addChild(component)
      rows.push({ message, height: component.render(width).length })
    }
    for (const message of this.localMessages) {
      const component = this.renderMessage(message, boundary)
      this.messagesView.addChild(component)
      rows.push({ message, height: component.render(width).length })
    }
    if (this.notifyText !== '') {
      this.messagesView.addChild(new Text(color.error(`✗ ${this.notifyText}`), 0, 0))
    }
    this.messageRows = rows
    this.renderTodoPanel()
    this.requestRender()
  }

  /**
   * Show or hide the busy indicator on the row directly above the editor
   * border: while a turn is streaming or a tool is running (the runner
   * derives it from turn/start and turn/end).
   */
  setWorking(active: boolean): void {
    if (active) {
      this.working.start()
    } else {
      this.working.stop()
      this.working.setText('')
    }
    this.requestRender()
  }

  /**
   * Set the live session's auto-generated title (from the session/title
   * log) for the header; undefined clears it.
   */
  setSessionTitle(title: string | undefined): void {
    this.sessionTitleText = title ?? ''
    this.renderHeader()
  }

  /**
   * Map a fullscreen click (0-based screen cell, from the alt screen's
   * onCellClick) onto a transcript message and toggle its individual
   * expansion — the web's click-to-disclose behavior for one card at a time.
   * The global Ctrl+O fold still wins, so keyboard behavior is unchanged.
   */
  private handleFullscreenClick(x: number, y: number): void {
    void x
    const width = this.terminal.columns
    // Fullscreen layout: header row(s), then the transcript scroll pane.
    const headerHeight = this.header.render(width).length
    const rowInScroll = y - headerHeight
    if (rowInScroll < 0) return
    const scrollTop = this.fullscreenScroll?.scrollTop ?? 0
    const welcomeHeight = this.welcomeCard.render(width).length
    const messageRow = rowInScroll + scrollTop - welcomeHeight
    if (messageRow < 0) return
    let row = 0
    for (const entry of this.messageRows) {
      if (messageRow < row + entry.height) {
        this.toggleMessageExpanded(entry.message)
        return
      }
      row += entry.height
    }
  }

  /** Toggle one collapsible message's individual expansion (mouse click). */
  private toggleMessageExpanded(message: TranscriptMessage): void {
    if (message.kind !== 'thinking' && message.kind !== 'tool' && message.kind !== 'system') return
    if (this.expandedOverride.get(message) === true) {
      this.expandedOverride.delete(message)
    } else {
      this.expandedOverride.set(message, true)
    }
    this.rebuildMessages()
  }

  /** Show or clear plan mode: header + footer badges and a warning-tinted editor border. */
  setPlanMode(active: boolean): void {
    this.planMode = active
    this.renderHeader()
    this.renderFooter()
    this.editor.borderColor = active ? color.warning : this.editorBorder
    this.editor.invalidate()
    this.requestRender()
  }

  /**
   * Show a transient error line under the transcript. Cleared by the next
   * `setTranscript` repaint or after {@link TuiApp.NOTIFY_DURATION_MS},
   * whichever comes first, so a one-off notice never lingers forever.
   */
  notify(text: string): void {
    this.notifyText = text
    if (this.notifyTimer !== undefined) clearTimeout(this.notifyTimer)
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      this.notifyText = ''
      this.rebuildMessages()
    }, this.notifyDurationMs)
    this.rebuildMessages()
  }

  /** Clear the transient notify line and its pending auto-clear timer. */
  private clearNotify(): void {
    this.notifyText = ''
    if (this.notifyTimer !== undefined) {
      clearTimeout(this.notifyTimer)
      this.notifyTimer = undefined
    }
  }

  /**
   * Set the session head rendered above the transcript: the session identity,
   * model, version, preset, and cwd, wrapped to the terminal width with a
   * full-width rule beneath. Replaces any previous head.
   * @param facts - directory, session id, model, version, and the optional agent preset to display.
   */
  setWelcomeCard(facts: { cwd: string; sessionId: string; model: string; version: string; preset?: string }): void {
    this.welcomeCard.setFacts(facts)
    this.rebuildMessages()
  }

  /** The turn threshold at or above which collapsible entries expand. */
  private expandBoundary(): number {
    if (!this.toolOutputExpanded || EXPAND_RECENT_TURNS <= 0) return Number.POSITIVE_INFINITY
    return recentTurnThreshold(this.messages, EXPAND_RECENT_TURNS, ['thinking', 'system', 'tool'])
  }



  /** Render one transcript message as a pi-tui component. */
  private renderMessage(message: TranscriptMessage, boundary: number): Component {
    if (message.kind === 'user') {
      // Terminal-prompt style: the user's line reads like a shell command.
      return new Text(`${color.roleUser('❯')} ${message.text}`, 0, 0)
    }
    if (message.kind === 'assistant') {
      // The whale bullet is its own Text so it never reflows into the body.
      const row = new Container()
      row.addChild(new Text(`${color.primary('🐋')} `, 0, 0))
      row.addChild(new Markdown(message.text, 0, 0, markdownTheme))
      return row
    }
    if (message.kind === 'thinking') {
      const expanded = message.turn >= boundary || this.expandedOverride.get(message) === true
      const text = expanded
        // Expanded thinking stays dimmed so reasoning never reads like the
        // assistant's actual output (web parity: a distinct disclosure style).
        ? color.textDim(`🐳 ${message.text}`)
        // Folded: while the step still streams, the row follows the LATEST
        // line of reasoning (the Web's running summary); once settled it
        // shows the first line (the Web's settled summary).
        : color.textDim(`🐳 ${
          message.running === true
            ? preview(latestLine(message.text), 1)
            : preview(firstLine(message.text), 1)
        } (ctrl+o to expand)`)
      return new Text(text, 0, 0)
    }
    if (message.kind === 'system') {
      const expanded = message.turn >= boundary || this.expandedOverride.get(message) === true
      // Labeled entries are context injections: the row names the producer
      // like the Web ContextInjectionRow (Context injection · label), with a notice
      // form's one-line account on the folded row. Unlabeled entries keep
      // the generic section marker.
      if (message.label !== undefined) {
        const row = new Container()
        const emoji = message.emoji ?? '📎'
        if (expanded) {
          row.addChild(new Text(color.textMuted(`${emoji} Context injection ${message.label}`), 0, 0))
          // Injected content stays dimmed like tool-card bodies: context is
          // never mistaken for the assistant's actual output.
          row.addChild(new Text(color.textDim(message.text), 0, 0))
        } else {
          const summary = message.summary === undefined ? '' : ` — ${message.summary}`
          row.addChild(new Text(color.textMuted(`${emoji} Context injection ${message.label}${summary} (ctrl+o to expand)`), 0, 0))
        }
        return row
      }
      const text = expanded
        ? `${color.textMuted('§')} ${message.text}`
        : color.textMuted(`§ ${preview(message.text, 2)} (ctrl+o to expand)`)
      return new Text(text, 0, 0)
    }
    if (message.kind === 'summary') {
      // Windowing: turns older than the display window collapse to one line.
      return new Text(color.textDim(message.text), 0, 0)
    }
    // Tool card: the Web row-model header (design title + relativized args
    // summary + status pill), with the result body when expanded.
    const card = new Container()
    const header = toolCardHeader(message.name, message.args, this.workspaceRoot)
    const summary = header.summary === '' ? '' : ` ${header.summary}`
    const emoji = toolEmoji(message.name)
    const pill = message.status === 'ok'
      ? color.success('[ok]')
      : message.status === 'error'
        ? color.error('[error]')
        : color.textDim('[running]')
    const head = `${emoji} ${header.title}${summary} ${pill}`
    if (message.turn >= boundary || this.expandedOverride.get(message) === true) {
      card.addChild(new Text(head, 0, 0))
      this.renderToolBody(card, message)
    } else {
      const resultPreview = message.result === ''
        ? ''
        : ` — ${preview(message.result, RESULT_PREVIEW_LINES)}`
      card.addChild(new Text(`${head}${resultPreview}`, 0, 0))
    }
    return card
  }

  /**
   * Render one expanded tool card's body. When the runner wired a presenter,
   * the body follows the tool's own render intent (presentResult): a read
   * card shows numbered lines plus the relativized path and total line
   * count, a search card groups matches by file and marks truncation, a
   * terminal card shows the output and exit status, and a diff card colors
   * the hunks. Without a view the raw result text renders, diff-colored
   * when it looks like one.
   * @param card - the card container to fill.
   * @param message - the tool message.
   */
  private renderToolBody(card: Container, message: Extract<TranscriptMessage, { kind: 'tool' }>): void {
    // Running: surface the pending call's salient raw input when the tool
    // offered one (e.g. a background job id); otherwise the header alone.
    if (message.status === 'running') {
      const callView = this.present?.call(message.name, message.args)
      if (callView !== undefined && callView.card === 'generic' && callView.rawInput !== undefined) {
        const raw = typeof callView.rawInput === 'string' ? callView.rawInput : JSON.stringify(callView.rawInput, null, 2)
        card.addChild(new Text(color.textDim(raw), 0, 0))
      }
      return
    }
    if (message.result === '' && (message.resultBlocks?.length ?? 0) === 0) return
    const resultView = this.present?.result(message.name, message.args, {
      content: message.resultBlocks ?? [],
      isError: message.status === 'error',
      ...message.meta === undefined ? {} : { meta: message.meta },
    })
    if (resultView !== undefined) {
      switch (resultView.card) {
        case 'read': {
          for (const line of resultView.lines) {
            card.addChild(new Text(color.textDim(`  ${line.number} │ ${line.text}`), 0, 0))
          }
          card.addChild(new Text(color.textMuted(`  path: ${relativizeToCwd(resultView.path, this.workspaceRoot)}`), 0, 0))
          card.addChild(new Text(color.textMuted(`  total lines: ${resultView.totalLines}`), 0, 0))
          return
        }
        case 'search': {
          if (resultView.shape === 'matches') {
            for (const file of resultView.files) {
              card.addChild(new Text(color.textMuted(`  ${relativizeToCwd(file.path, this.workspaceRoot)}`), 0, 0))
              for (const match of file.matches) {
                card.addChild(new Text(color.textDim(`    ${match.lineNumber} │ ${match.line}`), 0, 0))
              }
            }
            if (resultView.truncated) {
              card.addChild(new Text(color.textMuted(`  … truncated — ${resultView.total} total matches`), 0, 0))
            }
          } else {
            for (const path of resultView.paths) {
              card.addChild(new Text(color.textDim(`  ${relativizeToCwd(path, this.workspaceRoot)}`), 0, 0))
            }
            if (resultView.truncated) {
              card.addChild(new Text(color.textMuted(`  … truncated — ${resultView.total} total paths`), 0, 0))
            }
          }
          return
        }
        case 'terminal': {
          if (resultView.output !== undefined && resultView.output !== '') {
            for (const line of resultView.output.split('\n')) {
              card.addChild(new Text(color.textDim(line), 0, 0))
            }
          }
          const exit = resultView.exitCode !== undefined
            ? `[exit ${resultView.exitCode}]`
            : resultView.signal !== undefined
              ? `[signal ${resultView.signal}]`
              : ''
          if (exit !== '') card.addChild(new Text(color.textDim(exit), 0, 0))
          return
        }
        case 'diff': {
          for (const line of renderDiffView(resultView.diffs, this.workspaceRoot)) {
            card.addChild(new Text(line, 0, 0))
          }
          return
        }
        default:
          break
      }
    }
    // Generic fallback: the raw result text dimmed (diffs keep their own
    // + / − colors, which already distinguish them from assistant output).
    if (isDiffResult(message.name, message.result)) {
      for (const line of renderDiffLines(message.result)) {
        card.addChild(new Text(line, 0, 0))
      }
    } else {
      card.addChild(new Text(color.textDim(message.result), 0, 0))
    }
  }

  /** Request a render on the active screen. Public so in-place submenu
   * components (async content swaps) can trigger the next frame. */
  requestRender(): void {
    ;(this.fullscreen ?? this.tui).requestRender()
  }

  /**
   * Reflect the todo list in the header line: active (non-completed) count
   * and, when the list is non-empty, the first active item's text.
   * @param todos - the latest todo/write snapshot.
   */
  setTodoSummary(todos: readonly TodoItem[]): void {
    this.todoItems = todos
    const active = todos.filter(todo => todo.status !== 'completed')
    const done = todos.length - active.length
    if (active.length === 0) {
      this.todoText = done > 0 ? ` · ${done} todo done` : ''
    } else {
      const first = active[0]
      const label = first === undefined ? '' : first.content.length > 30 ? `${first.content.slice(0, 30)}…` : first.content
      this.todoText = ` · ${active.length} active · ${label}`
    }
    this.renderHeader()
    if (this.todoPanelVisible) this.renderTodoPanel()
  }

  /** Toggle the todo panel between the transcript and the editor. */
  toggleTodoPanel(): boolean {
    this.todoPanelVisible = !this.todoPanelVisible
    this.renderTodoPanel()
    this.requestRender()
    return this.todoPanelVisible
  }

  /** Whether the todo panel is currently shown. */
  isTodoPanelVisible(): boolean {
    return this.todoPanelVisible
  }

  /**
   * Rebuild the todo panel text: a header line plus up to five rows,
   * in_progress first, then pending, then completed (strikethrough).
   */
  private renderTodoPanel(): void {
    if (!this.todoPanelVisible) {
      this.todoPanel.setText('')
      return
    }
    const mark = (todo: TodoItem): string => todo.status === 'in_progress'
      ? color.primary('●')
      : todo.status === 'completed' ? color.success('✓') : color.textDim('○')
    const ordered = [
      ...this.todoItems.filter(todo => todo.status === 'in_progress'),
      ...this.todoItems.filter(todo => todo.status === 'pending'),
      ...this.todoItems.filter(todo => todo.status === 'completed'),
    ].slice(0, 5)
    if (ordered.length === 0) {
      this.todoPanel.setText(color.border('─ todo ─'))
      return
    }
    const lines = ordered.map(todo => {
      const body = todo.status === 'completed' ? `\x1b[9m${todo.content}\x1b[29m` : todo.content
      return `${mark(todo)} ${body}`
    })
    this.todoPanel.setText([color.border('─ todo ─'), ...lines].join('\n'))
  }

  /** Hide/show thinking entries; the fold state is untouched. */
  toggleThinkingHidden(): boolean {
    this.hideThinking = !this.hideThinking
    this.rebuildMessages()
    return this.hideThinking
  }

  /** Whether thinking entries are currently hidden. */
  isThinkingHidden(): boolean {
    return this.hideThinking
  }

  /** Rebuild the header from base + session title + todo summary + plan badge. */
  private renderHeader(): void {
    const badge = this.planMode ? ` ${color.warning('[plan]')}` : ''
    const title = this.sessionTitleText === '' ? '' : ` · ${color.textMuted(this.sessionTitleText)}`
    this.headerText = `🐋 dsh-pi-tui${title}${this.todoText}${badge}`
    this.header.setText(this.headerText)
    this.requestRender()
  }

  /**
   * Update the footer: line 1 `[model] …/cwd branch [ctx bar] t/steps`,
   * line 2 the stats line (full preset) or nothing (compact). Partial
   * updates merge.
   * @param status - the new status values.
   */
  setStatus(status: Partial<StatusData>): void {
    this.status = { ...this.status, ...status }
    this.renderFooter()
  }

  /** Footer density presets: full keeps the stats line, compact drops it. */
  private footerPreset: 'full' | 'compact' = 'full'

  /** Set the footer density preset and repaint. */
  setFooterPreset(preset: 'full' | 'compact'): void {
    this.footerPreset = preset
    this.renderFooter()
  }

  /** Whether the footer currently uses the compact preset. */
  getFooterPreset(): 'full' | 'compact' {
    return this.footerPreset
  }

  /** Rebuild the two footer lines from the current status and plan badge. */
  private renderFooter(): void {
    const context = this.status.contextTokens !== undefined && this.status.contextWindow !== undefined
      && this.status.contextWindow > 0
      ? contextBar(this.status.contextTokens, this.status.contextWindow)
      : ''
    const line1 = [
      this.planMode ? color.warning('[plan]') : '',
      this.status.goal === undefined || this.status.goal === '' ? '' : color.primary(this.status.goal),
      this.status.model === '' ? '' : `[${this.status.model}]`,
      this.status.cwd,
      this.status.branch === '' ? '' : this.status.branch,
      context,
      `t${this.status.turns}/s${this.status.steps}`,
    ].filter(part => part !== '')
    // Line 2: the stats line only; context pressure is the bar on line 1.
    const line2 = this.footerPreset === 'compact' ? '' : this.status.statsLine
    this.footerText = [dim(line1.join('  ')), line2 === '' ? '' : dim(line2)].filter(line => line !== '').join('\n')
    this.footer.setText(this.footerText)
    this.requestRender()
  }

  /** Install slash-command + file-path autocompletion on the editor. */
  setCommandCompletions(commands: readonly SlashCommand[], cwd: string): void {
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...commands], cwd))
  }

  /**
   * Open a single-choice picker overlay (SelectList). Selecting calls
   * `onSelect` with the item value and closes; Esc calls `onCancel`.
   * @param items - choice rows.
   * @param onSelect - confirmed choice.
   * @param onCancel - dismissed without a choice.
   * @param options - search/hint/group configuration for the picker.
   * @returns a handle to close the picker or replace its rows (e.g. when
   * background data such as session titles arrives while it is open).
   */
  openPicker(
    items: readonly PickerItem[],
    onSelect: (value: string) => void,
    onCancel: () => void,
    options: PickerOptions = {},
  ): PickerHandle {
    const list = new SelectList(
      items.map(item => ({ ...item })),
      10,
      selectListTheme,
      {},
      {
        enableSearch: options.enableSearch,
        header: options.header,
        noMatchText: options.noMatchText,
        showHint: options.showHint,
        initialQuery: options.initialQuery,
      },
    )
    const handle = this.showOverlayOnHost(new Frame(list), { width: options.width ?? 64, maxHeight: options.maxHeight ?? 24 })
    list.onSelect = (item) => {
      handle.hide()
      onSelect(item.value)
    }
    list.onCancel = () => {
      handle.hide()
      onCancel()
    }
    return {
      close: () => handle.hide(),
      setItems: (next) => {
        list.setItems(next.map(item => ({ ...item })))
        this.requestRender()
      },
    }
  }

  /**
   * Open the settings overlay as a SettingsList. The runner supplies the
   * items and reacts to changes/cancellation.
   * @param items - setting rows.
   * @param onChange - called with (id, newValue) on confirm.
   * @param onCancel - called when the user closes without applying.
   */
  openSettings(items: SettingItem[], onChange: (id: string, value: string) => void, onCancel: () => void): void {
    // SettingsList fires onCancel on Esc/ctrl+c; the overlay must close too,
    // so the cancel callback closes the handle captured after mounting.
    let handle: OverlayHandle | undefined
    const settings = new SettingsList(items, 6, settingsListTheme, onChange, () => {
      handle?.hide()
      onCancel()
    }, { enableSearch: true })
    handle = this.showOverlayOnHost(new Frame(settings), { width: 72, maxHeight: 28 })
  }

  /** Switch the active color theme and repaint everything. */
  applyTheme(theme: 'dark' | 'light'): void {
    setTheme(theme)
    // Rebuild messages (fresh component instances) and refresh text caches.
    this.rebuildMessages()
    this.header.setText(this.headerText)
    this.footer.setText(this.footerText)
    this.editor.invalidate()
    this.requestRender()
  }

  /** Apply a resolved custom palette and repaint everything. */
  applyPalette(palette: ColorPalette): void {
    setTheme('custom', palette)
    this.rebuildMessages()
    this.header.setText(this.headerText)
    this.footer.setText(this.footerText)
    this.editor.invalidate()
    this.requestRender()
  }

  /**
   * Query the terminal background (OSC 11) and apply the matching palette.
   * A terminal that never answers leaves the current theme untouched.
   */
  async autoDetectTheme(): Promise<void> {
    const rgb = await this.tui.queryTerminalBackgroundColor({ timeoutMs: 800 })
    if (rgb === undefined) return
    this.applyTheme(detectThemeFromBackground(rgb))
  }

  /**
   * Register a live terminal-theme listener (colour-scheme reports). The
   * runner uses it to follow the terminal when the preference is `auto`.
   * @param listener - receives the detected palette family.
   * @returns a disposer.
   */
  onTerminalThemeChange(listener: (theme: 'dark' | 'light') => void): () => void {
    return this.tui.onTerminalColorSchemeChange((scheme) => listener(scheme))
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
    // A signal that aborted while the prompt was queued (e.g. a turn cancel
    // aborts every in-flight request) must never reach the screen: settle it
    // cancelled right away instead of popping a stale dialog.
    if (pending.request.signal?.aborted === true) {
      this.settleApproval(pending, 'cancelled')
      return
    }
    this.renderApprovalDialog(pending)
    this.activeApproval = pending
  }

  /** Build and mount the approval dialog for one prompt on the active screen. */
  private renderApprovalDialog(pending: PendingApproval): void {
    const dialog = new Box(1, 1)
    dialog.addChild(new Text(`Approve ${pending.request.toolName}?`))
    if (pending.request.danger === true) {
      dialog.addChild(new Text(color.error('⚠ DANGEROUS COMMAND — confirm carefully')))
    }
    if (pending.request.arguments !== undefined && pending.request.arguments !== '') {
      const preview = pending.request.arguments.split('\n').slice(0, 6).join('\n')
      dialog.addChild(new Text(color.textDim(preview.length > 240 ? `${preview.slice(0, 240)}…` : preview)))
    }
    if (pending.request.reason !== undefined && pending.request.reason !== '') {
      dialog.addChild(new Text(pending.request.reason))
    }
    dialog.addChild(new Text(''))
    dialog.addChild(new Text('[y] allow once   [n] reject   [esc/ctrl+c] cancel'))
    pending.handle = this.showOverlayOnHost(new Frame(dialog), { width: 60, maxHeight: 16 })
  }

  /** Route a key while a prompt is showing; every key is consumed. */
  private handleApprovalKey(data: string): TuiInputListenerResult {
    const pending = this.activeApproval
    if (pending === undefined) return undefined
    if (matchesKey(data, 'y')) this.settleApproval(pending, 'allowed-once')
    else if (matchesKey(data, 'n')) this.settleApproval(pending, 'rejected')
    else if (matchesKey(data, 'escape')) this.settleApproval(pending, 'cancelled')
    else if (matchesKey(data, 'ctrl+c')) this.settleApproval(pending, 'cancelled')
    return { consume: true }
  }

  /**
   * Resolve one prompt and hide its dialog. The prompt may be on screen
   * (active), queued behind another, or never queued at all (its signal was
   * already aborted on arrival) — every state must settle the promise
   * exactly once and never leave a cancelled prompt in the queue.
   */
  private settleApproval(pending: PendingApproval, outcome: ApprovalOutcome): void {
    if (pending.settled === true) return
    pending.settled = true
    if (this.activeApproval === pending) {
      this.activeApproval = undefined
      pending.handle?.hide()
      this.overlayHost.setFocus(this.editor)
    } else {
      const queued = this.approvalQueue.indexOf(pending)
      if (queued !== -1) this.approvalQueue.splice(queued, 1)
    }
    if (pending.onAbort !== undefined && pending.request.signal !== undefined) {
      pending.request.signal.removeEventListener('abort', pending.onAbort)
    }
    pending.resolve(outcome)
    if (this.activeApproval === undefined) this.showNextApproval()
  }

  /**
   * Ask the user one or more questions through the dialog overlay. One
   * question is on screen at a time; numbered keys select/toggle options,
   * Enter confirms the current question, Esc (or an aborted signal) rejects.
   * Questions without options collect a typed free-text answer.
   * @param questions - the questions to ask.
   * @param signal - optional abort; settles the flow rejected.
   * @returns the answers, in question order.
   */
  askQuestions(questions: readonly TuiQuestion[], signal?: AbortSignal): Promise<TuiQuestionAnswer[]> {
    return new Promise<TuiQuestionAnswer[]>((resolve, reject) => {
      if (questions.length === 0) {
        resolve([])
        return
      }
      const state: QuestionState = {
        questions,
        index: 0,
        selected: new Map(),
        custom: new Map(),
        customText: '',
        resolve,
        reject,
        signal,
      }
      if (signal?.aborted === true) {
        reject(new Error('question flow aborted'))
        return
      }
      if (signal !== undefined) {
        const onAbort = (): void => this.settleQuestions(state, 'cancelled')
        state.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.activeQuestions = state
      this.renderQuestion(state)
    })
  }

  /** Build and mount the dialog for the state's current question. */
  private renderQuestion(state: QuestionState): void {
    const question = state.questions[state.index]
    if (question === undefined) {
      this.settleQuestions(state, 'done')
      return
    }
    const dialog = new Box(1, 1)
    if (question.header !== undefined && question.header !== '') {
      dialog.addChild(new Text(color.textDim(question.header)))
    }
    dialog.addChild(new Text(question.question))
    const options = question.options ?? []
    if (options.length > 0) {
      options.forEach((option, index) => {
        const checked = state.selected.get(question.id)?.has(option.label) === true ? color.success('✓') : ' '
        dialog.addChild(new Text(`${checked} ${index + 1}) ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`))
      })
    } else if (question.multiSelect !== true) {
      dialog.addChild(new Text(`> ${state.customText}`))
      dialog.addChild(new Text('(type an answer, enter to confirm)'))
    }
    dialog.addChild(new Text(''))
    const verb = question.multiSelect === true ? 'toggle' : 'select'
    dialog.addChild(new Text(`[1-9] ${verb}   [enter] confirm   [esc] cancel   (${state.index + 1}/${state.questions.length})`))
    state.handle?.hide()
    state.handle = this.showOverlayOnHost(new Frame(dialog), { width: 72, maxHeight: 24 })
  }

  /** Route a key while a question is showing; every key is consumed. */
  private handleQuestionKey(data: string): TuiInputListenerResult {
    const state = this.activeQuestions
    if (state === undefined) return undefined
    const question = state.questions[state.index]
    if (question === undefined) {
      this.settleQuestions(state, 'done')
      return { consume: true }
    }
    const options = question.options ?? []
    const digit = /^[1-9]$/.exec(data)
    if (digit !== null) {
      const option = options[Number(digit[0]) - 1]
      if (option !== undefined) {
        const selected = state.selected.get(question.id) ?? new Set<string>()
        if (question.multiSelect === true) {
          if (selected.has(option.label)) selected.delete(option.label)
          else selected.add(option.label)
        } else {
          selected.clear()
          selected.add(option.label)
        }
        state.selected.set(question.id, selected)
        this.renderQuestion(state)
      }
      return { consume: true }
    }
    if (matchesKey(data, 'enter')) {
      if (options.length > 0) {
        state.index += 1
        this.renderQuestion(state)
      } else if (question.multiSelect !== true) {
        // Free-text answer collected above the hint line.
        state.custom.set(question.id, state.customText)
        state.customText = ''
        state.index += 1
        this.renderQuestion(state)
      }
      return { consume: true }
    }
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.settleQuestions(state, 'cancelled')
      return { consume: true }
    }
    // Free-text input for no-option questions; a chunk may carry several
    // printable characters (paste-like delivery), so append every one.
    if (options.length === 0 && question.multiSelect !== true) {
      if (data === '\x7f' || data === '\b') {
        state.customText = [...state.customText].slice(0, -1).join('')
        this.renderQuestion(state)
      } else {
        let appended = false
        for (const char of data) {
          if (char.charCodeAt(0) >= 32) {
            state.customText += char
            appended = true
          }
        }
        if (appended) this.renderQuestion(state)
      }
    }
    return { consume: true }
  }

  /** Resolve the question flow with its answers, or reject on cancel. */
  private settleQuestions(state: QuestionState, outcome: 'done' | 'cancelled'): void {
    if (this.activeQuestions !== state) return
    this.activeQuestions = undefined
    state.handle?.hide()
    if (state.onAbort !== undefined && state.signal !== undefined) {
      state.signal.removeEventListener('abort', state.onAbort)
    }
    this.overlayHost.setFocus(this.editor)
    if (outcome === 'cancelled') {
      state.reject(new Error('question flow cancelled'))
      return
    }
    const answers: TuiQuestionAnswer[] = state.questions.map(question => {
      const selected = [...(state.selected.get(question.id) ?? [])]
      const custom = (question.options ?? []).length === 0 && question.multiSelect !== true
        ? state.custom.get(question.id)
        : undefined
      return custom === undefined ? { id: question.id, selected } : { id: question.id, selected, custom }
    })
    state.resolve(answers)
  }
}

// Style helpers from the theme module's token functions.
import { color } from './theme.ts'
const dim = color.textDim

/**
 * Start the TUI on the process terminal (raw-mode stdin/stdout). The runner
 * passes the presentation bridge and workspace root through the options.
 */
export function startProcessTui(events: TuiAppEvents, options: TuiAppOptions = {}): TuiApp {
  const app = new TuiApp(new ProcessTerminal(), events, options)
  app.start()
  return app
}
