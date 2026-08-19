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
  type Focusable,
  type OverlayHandle,
  type OverlayOptions,
  type SettingItem,
  type SlashCommand,
  type Terminal,
  type TuiInputListenerResult,
} from '@xmoon76/pi-tui'
import {
  detectThemeFromBackground,
  detectThemeFromColorFgBg,
  editorTheme,
  markdownTheme,
  selectListTheme,
  settingsListTheme,
  setTheme,
  themeOptOut,
  type ColorPalette,
} from './theme.ts'
import { isDiffResult, renderDiffLines, renderDiffView } from './diff.ts'
import { TaskBrowserPanel, type TaskPanelItem } from './task-panel.ts'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import {
  firstLine,
  latestLine,
  parseCallPreview,
  parseReadEnvelopes,
  readFoldedPreview,
  relativizeToCwd,
  foldedCallPreview,
  genericRawInputLines,
  resultTextLines,
  askAnswersSummary,
  toolCardHeader,
  toolEmoji,
  webCardLines,
  type ToolPresenter,
} from './present.ts'
import { TranscriptSearchComponent } from './search.ts'
import { QuestionFlow } from './question.ts'
import { MentionProvider } from './mentions.ts'
import { recentTurnThreshold, type TranscriptMessage } from './transcript.ts'
import { WorkingIndicator } from './working.ts'
import { cancellationError, type OwnedTaskOptions } from './detached.ts'
import { safeErrorMessage } from './error-boundary.ts'
import type { SurfaceHost } from './extension/internal/surface-host.ts'

/** How many most-recent turns Ctrl+O expands; mirrors pi's default. */
export const EXPAND_RECENT_TURNS = 3
/** Folded preview lines for tool results; mirrors pi's RESULT_PREVIEW_LINES. */
export const RESULT_PREVIEW_LINES = 3
/** Diff-body cap for default-view tool cards; mirrors kimi COMMAND_PREVIEW_LINES. */
export const DIFF_PREVIEW_LINES = 10
/** Folded bash-command preview lines (kimi parity: the command stays visible). */
export const FOLDED_COMMAND_LINES = 3
/** Folded diff preview rows (header + cap + footer; kimi COMMAND_PREVIEW_LINES scale). */
export const FOLDED_DIFF_LINES = 4

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
 * token, one cell of padding, width sized to the content. With `fillWidth`
 * the frame keeps the overlay's full width instead of hugging the widest
 * content row. Keyboard input forwards to the wrapped component.
 */
export class Frame implements Component {
  private readonly child: Component
  private readonly fillWidth: boolean

  constructor(child: Component, fillWidth = false) {
    this.child = child
    this.fillWidth = fillWidth
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
    const contentWidth = this.fillWidth
      ? inner
      : Math.min(inner, Math.max(1, ...lines.map(line => visibleWidth(line))))
    const frameWidth = contentWidth + 4
    const b = color.border
    const out = [b(`╭${'─'.repeat(frameWidth - 2)}╮`)]
    for (const line of lines) {
      const vis = visibleWidth(line)
      // Row shape is `│ line pad │`: borders and one padding cell each side
      // are fixed, so padding tops the content up to `contentWidth` — the row
      // is then exactly frameWidth cells, matching the border, and the right
      // border survives compositing. Padding to `inner` instead would stretch
      // rows past the border whenever the content is narrower than the panel.
      const pad = Math.max(0, contentWidth - vis)
      out.push(`${b('│')} ${line}${' '.repeat(pad)} ${b('│')}`)
    }
    out.push(b(`╰${'─'.repeat(frameWidth - 2)}╯`))
    return out
  }
}

/**
 * Frame for the question flow in the EDITOR SEAT: it re-derives the flow's
 * row budget from the terminal height on EVERY render (60% cap, 8..24
 * content rows — the flow's render output IS its height in the seat layout,
 * nothing clips it), so an active resize or a queued flow presented later
 * always budgets against the current terminal. It also forwards focus to the
 * flow so its free-text Input keeps the hardware cursor (a plain Frame would
 * swallow the focus flag).
 */
class QuestionFrame extends Frame implements Focusable {
  private readonly flow: QuestionFlow
  private readonly heightOf: () => number
  /** Rendered height of the last frame (fullscreen click hit-testing). */
  private lastRows = 0
  /** Terminal height the last render used (click staleness guard). */
  private lastTermRows = 0

  constructor(flow: QuestionFlow, heightOf: () => number) {
    super(flow, true)
    this.flow = flow
    this.heightOf = heightOf
  }

  render(width: number): string[] {
    const rows = Math.max(1, this.heightOf())
    this.lastTermRows = rows
    // The 60% cap is the DEFAULT (keeps the transcript visible); an explicit
    // body expand ('e' or a click on the scroll marker) grows the frame
    // toward 80% — the user asked for the room, and the flow's budget math
    // is proven for every budget up to MAX_BUDGET.
    const expanded = this.flow.isBodyExpanded()
    const frameRows = expanded
      ? Math.max(10, Math.min(40, Math.floor(rows * 0.8)))
      : Math.max(10, Math.min(26, Math.floor(rows * 0.6)))
    this.flow.setMaxRows(frameRows - 2)
    const out = super.render(width)
    this.lastRows = out.length
    return out
  }

  /** The frame's height from the last render (0 before the first one). */
  get rows(): number {
    return this.lastRows
  }

  /** The terminal height the last render used. */
  get termRows(): number {
    return this.lastTermRows
  }

  get focused(): boolean {
    return this.flow.focused
  }

  set focused(value: boolean) {
    this.flow.focused = value
  }
}

/** The session head card: identity facts, wrapped to the available width so
 * nothing is truncated, framed with a box whose width matches the editor's
 * border below it (a fixed-width rule looked misaligned next to the frame). */
class WelcomeCard implements Component {
  private facts: { cwd: string; sessionId: string; model: string; version: string; preset?: string } | undefined
  private idle = false
  private lastWidth = -1
  private cached: string[] = []

  /** Replace the facts; the next render rebuilds the card. */
  setFacts(facts: { cwd: string; sessionId: string; model: string; version: string; preset?: string }): void {
    this.facts = facts
    this.idle = false
    this.cached = []
  }

  /**
   * The pre-session state (deferred session creation): the card invites the
   * first message instead of naming a session that does not exist yet.
   */
  setIdle(idle: boolean): void {
    if (this.idle === idle) return
    this.idle = idle
    this.cached = []
  }

  invalidate(): void {
    this.cached = []
  }

  render(width: number): string[] {
    const facts = this.facts
    const b = color.border
    const inner = Math.max(1, width - 4)
    const renderRow = (line: string): string[] => wrapTextWithAnsi(line, inner).map(wrapped => {
      const vis = visibleWidth(wrapped)
      return `${b('│')} ${wrapped}${' '.repeat(Math.max(0, inner - vis))} ${b('│')}`
    })
    if (this.idle) {
      if (this.lastWidth === width && this.cached.length > 0) return this.cached
      this.lastWidth = width
      this.cached = [
        b(`╭${'─'.repeat(Math.max(0, width - 2))}╮`),
        ...renderRow(color.textMuted('🐋  dsh-pi-tui — type a message to start a session')),
        b(`╰${'─'.repeat(Math.max(0, width - 2))}╯`),
      ]
      return this.cached
    }
    if (facts === undefined) return []
    if (this.lastWidth === width && this.cached.length > 0) return this.cached
    this.lastWidth = width
    // Three columns: the session identity (full id — never truncated), the
    // model/preset, and the workspace. Each row wraps instead of ellipsizing,
    // so the box keeps the important facts readable. The card is session
    // chrome, so it reads muted — never as bright as user/assistant content.
    const line1 = `🐋  session ${color.textMuted(facts.sessionId)}`
    const line2 = [
      color.textMuted(facts.model),
      facts.preset === undefined ? '' : `preset ${color.textMuted(facts.preset)}`,
    ].filter(part => part !== '').join(' · ')
    const line3 = [
      color.textMuted(facts.cwd),
      color.textMuted(`v${facts.version}`),
    ].filter(part => part !== '').join(' · ')
    // Wrap each line to the box's inner width so long identities read in
    // full instead of ending in an ellipsis; the box spans the same width
    // as the editor border below it.
    this.cached = [
      b(`╭${'─'.repeat(Math.max(0, width - 2))}╮`),
      ...[line1, line2, line3].flatMap(renderRow),
      b(`╰${'─'.repeat(Math.max(0, width - 2))}╯`),
    ]
    return this.cached
  }
}

/** One blank row between consecutive transcript blocks (kimi/pi Spacer(1) parity). */
class Spacer implements Component {
  invalidate(): void {}
  render(): string[] {
    return ['']
  }
}

/**
 * Bullet + continuation-indent wrapper that keeps its child LIVE, so a
 * terminal resize re-renders the child at the new width instead of
 * re-wrapping a frozen render (the 5a76526 regression: assistant/user
 * messages were flattened to a static Text at build time, so markdown
 * tables could never reflow and border lines wrapped as plain text on
 * narrow windows). The bullet leads the FIRST line; wrapped continuation
 * lines indent under it (kimi prefix+indent parity).
 *
 * The prefixed output keeps a REFERENCE-STABLE cache: when the child
 * returns the same array instance (its own text+width cache hit) at the
 * same width, the wrapper returns the same prefixed array — so the fork's
 * per-frame processed-line reuse (fork AGENTS.md divergence 5) keeps
 * hitting on steady frames instead of re-normalizing every line.
 */
export class BulletedComponent implements Component {
  private readonly child: Component
  private readonly prefix: string
  private readonly prefixWidth: number
  private readonly indent: string
  private lastChild: string[] | undefined
  private lastWidth = -1
  private cached: string[] | undefined

  constructor(child: Component, prefix: string) {
    this.child = child
    this.prefix = prefix
    this.prefixWidth = visibleWidth(prefix)
    this.indent = ' '.repeat(this.prefixWidth)
  }

  invalidate(): void {
    this.child.invalidate?.()
  }

  dispose(): void {
    this.child.dispose?.()
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - this.prefixWidth)
    const child = this.child.render(inner)
    if (child === this.lastChild && width === this.lastWidth && this.cached !== undefined) {
      return this.cached
    }
    this.lastChild = child
    this.lastWidth = width
    this.cached = child.map((line, index) => (index === 0 ? this.prefix : this.indent) + line)
    return this.cached
  }
}

/**
 * Longest prefix of `text` whose WRAPPED height fits `budget` rows at
 * `width`, with an ellipsis marking a cut — the approval dialog's height
 * budget must count wrapped rows, not raw lines, because a single long
 * line can wrap across many display rows. Wrapped height is monotonic in
 * the prefix length, so a binary search bounds the wrap calls. The
 * ellipsis reserves its own row when truncating (a full last row would
 * otherwise push it onto a new row and overflow the budget).
 * @param text - the candidate text ('' yields '').
 * @param width - the wrap width.
 * @param budget - the row budget; 0 or negative yields '…' for non-empty.
 * @returns the fitted text and whether it was truncated.
 */
export function capWrappedToHeight(text: string, width: number, budget: number): { text: string; truncated: boolean } {
  if (text === '') return { text: '', truncated: false }
  // No row budgeted: nothing can render — the caller skips the child
  // (a single '…' row would overflow the budget it was promised).
  if (budget <= 0) return { text: '', truncated: true }
  const fits = (candidate: string, rows: number): boolean => wrapTextWithAnsi(candidate, width).length <= rows
  if (fits(text, budget)) return { text, truncated: false }
  // A single row: width-crop the text so the leading part stays readable
  // (a bare '…' row would lose everything).
  if (budget === 1) return { text: truncateToWidth(text, width, '…'), truncated: true }
  // More rows: the longest prefix fitting `budget - 1` rows, with the
  // ellipsis appended to the cut (it joins the last row when it has room,
  // or wraps to the reserved final row — never overflows the budget).
  const target = budget - 1
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(text.slice(0, mid), target)) low = mid
    else high = mid - 1
  }
  return { text: `${text.slice(0, low)}…`, truncated: true }
}

/**
 * Fit `text` into `budget` wrapped rows for the approval dialog, ending with
 * a dimmed `... N more` marker row when the content is cut. The marker rides
 * INSIDE the budget (content rows cap at budget−1, the marker itself is
 * width-cropped so it can never wrap), so a section can never silently
 * overflow the dialog's maxHeight — same marker semantics as the
 * question flow's `appendWrappedBudgeted`. A single-row budget keeps
 * the old width-cropped ellipsis (a bare marker row would waste the row).
 * @returns the display text (rows joined with '\n') and the hidden row count.
 */
function capWrappedToMarker(text: string, width: number, budget: number): { text: string; hidden: number } {
  if (text === '' || budget <= 0) return { text: '', hidden: 0 }
  const total = wrapTextWithAnsi(text, width).length
  if (total <= budget) return { text, hidden: 0 }
  if (budget === 1) return { text: truncateToWidth(text, width, '…'), hidden: total - 1 }
  // The longest prefix fitting budget−1 rows; the marker takes the last row.
  const target = budget - 1
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (wrapTextWithAnsi(text.slice(0, mid), width).length <= target) low = mid
    else high = mid - 1
  }
  const hidden = total - target
  const marker = truncateToWidth(color.textDim(`... ${hidden} more line${hidden > 1 ? 's' : ''}`), width, '…')
  return {
    text: `${text.slice(0, low)}\n${marker}`,
    hidden,
  }
}

/** The live job-output viewer body: a title line + refreshable text panel. */
class OutputViewerPanel implements Component {
  private readonly title: Text
  private readonly body: Text
  /** Key routing installed by openOutputViewer (Esc closes, `s` stops). */
  handleInput?: (data: string) => void

  constructor(title: string, initial: string) {
    this.title = new Text(title, 0, 0)
    this.body = new Text(initial, 0, 0)
  }

  invalidate(): void {
    this.title.invalidate()
    this.body.invalidate()
  }

  /** Replace the output body (the caller refreshes it on a timer). */
  setBody(text: string): void {
    this.body.setText(text)
    this.body.invalidate()
  }

  render(width: number): string[] {
    return [...this.title.render(width), '', ...this.body.render(width)]
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

/** The owned-task entry hosts wire to `runOwned` (diag pre-attached):
 * UI-layer one-shot flows route their async work through it instead of a
 * bare `void promise` (AGENTS.md hard rule). */
export type OwnedRunner = <T>(
  label: string,
  task: () => T | Promise<T>,
  options: Omit<OwnedTaskOptions<T>, 'diag' | 'sessionId'>,
) => void

/** Base callbacks every TuiApp host must provide; the external-editor
 * pair is bound on top of this (see {@link TuiAppEvents}). */
export interface TuiAppEventsBase {
  /** The user submitted a line in the editor. */
  onSubmit: (text: string) => void
  /** The user asked to quit (Ctrl+C in the TUI's own raw mode). */
  onExit: () => void
  /** Double-Esc: stop the current activity (turn, tool run). Optional. */
  onCancel?: () => void
  /**
   * Ctrl+S: steer with the current draft (possibly empty). The runner sends
   * the whole queue when it has messages, with the draft riding along, and
   * falls back to the draft alone otherwise. Optional.
   */
  onSteer?: (text: string) => void
  /**
   * The busy-Enter opposite chord (Ctrl+Enter): submit the draft in the
   * QUEUE delivery mode regardless of the busyEnter preference (web
   * busyEnter parity — the accelerated chord uses the other behavior).
   * Optional.
   */
  onQueueSubmit?: (text: string) => void
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
  /**
   * Shift+Tab with no overlay up: cycle the permission preset (read-only →
   * workspace-write → danger-full-access). The host applies the switch and
   * refreshes the footer. Optional.
   */
  onCyclePermission?: () => void
  /**
   * ↓ / Ctrl+J with an EMPTY editor and active background tasks: open the
   * task browser (running jobs/subagents). The host lists the jobs and
   * mounts the picker/viewer. Optional.
   */
  onOpenTasks?: () => void
  /**
   * Alt+↑ with queued input and no overlay up: pull every queued message back
   * into the editor draft (pi's dequeue). The host clears the inbox and the
   * draft lands via {@link TuiApp.setDraft}. Optional.
   */
  onDequeue?: () => void
}

/**
 * The application-surface events. The external-editor capability is a
 * BOUND pair declared only in the union: wiring `openExternalEditor`
 * REQUIRES `runOwned` — the Ctrl+G flow routes through the owned entry
 * (AGENTS.md), so a host cannot legally wire an editor hook without the
 * runner. Enforced at the type level (union) AND at construction time
 * (runtime check); without the editor hook neither field is needed and
 * Ctrl+G is a no-op.
 */
export type TuiAppEvents = TuiAppEventsBase & (
  | {
      /** Ctrl+G: open the external editor with the current draft. The TUI
       * stops before the call and restarts after it resolves; return the
       * new text. */
      openExternalEditor: (draft: string) => Promise<string>
      runOwned: OwnedRunner
    }
  | { openExternalEditor?: undefined; runOwned?: OwnedRunner }
)

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
  /** Optional detail block rendered dimmed above the options (Web parity). */
  detail?: string
  /** Optional choices rendered as a numbered menu. */
  options?: readonly { label: string; description?: string }[]
  /** Whether more than one option may be selected. */
  multiSelect?: boolean
  /** Presentation intent: approve names the recommended option label. */
  intent?: { kind: string; approve?: string }
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

/** Live state of one user-questions flow (the QuestionFlow seat). */
interface QuestionState {
  flow: QuestionFlow
  /** The mounted QuestionFrame, while this flow owns the editor seat. */
  frame?: QuestionFrame
  /**
   * Overlay handles suspended (hidden) while this flow owns the seat; they
   * are restored when the LAST queued flow settles, or transferred to the
   * next flow. The frontmost suspended handle may own further hidden
   * overlays through overlayDependents (reverse modal order).
   */
  suspendedOverlays: Set<OverlayHandle>
  resolve: (answers: TuiQuestionAnswer[]) => void
  reject: (error: unknown) => void
  signal?: AbortSignal
  onAbort?: () => void
  /** Latched by settle/cancel: every askQuestions promise settles exactly once. */
  settled?: boolean
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

/** Options for {@link TuiApp.openTaskBrowser}. */
export interface TaskBrowserOptions {
  /** Show a search input; typing filters rows by value/label/status/detail. */
  enableSearch?: boolean
  /** Title line above the rows (carries live counts). */
  header?: string
  /** Text shown when no row matches the filter. */
  noMatchText?: string
  /** Pre-fill the search input. */
  initialQuery?: string
  /** Overlay width in cells (default 72). */
  width?: number
  /** Overlay max height in rows (default 24). */
  maxHeight?: number
  /** Rows visible before the list scrolls (default 10). */
  maxVisible?: number
}

/** Live control of an open picker. */
export interface PickerHandle {
  /** Close the picker without a selection. */
  close(): void
  /** Replace the rows while the picker is open; the active query re-applies. */
  setItems(items: readonly PickerItem[]): void
}

/** Live control of an open task browser (rows carry status/startedAt). */
export interface TaskBrowserHandle {
  /** Close the browser without a selection. */
  close(): void
  /** Replace the rows while the browser is open; the active query re-applies. */
  setItems(items: readonly TaskPanelItem[]): void
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
  /** Current permission preset (read-only/workspace-write/danger-full-access/custom). */
  permission?: string
  /** Current context pressure in tokens, when measured. */
  contextTokens?: number
  /** Context window in tokens, when known. */
  contextWindow?: number
}

/** One queued inbox row for the queue pane (mirrors the agent Inbox's lists). */
export interface QueueItem {
  /** The pending message id (agent inbox identity). */
  id: string
  /** The message text, single-line display form. */
  text: string
  /** next-turn followup vs next-step steer. */
  mode: 'followup' | 'steer'
  /** Plugin notice (e.g. a background-job completion): NOT steerable — it
   * renders with its own marker and the hint drops the steer verbs. */
  notice?: boolean
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
  /**
   * The extension surface host (M2). When attached, the header/dock/footer
   * renders merge the extension outlets' content (header badges, dock
   * items, footer segments) into the host chrome. Optional — the surface
   * works identically without extensions.
   */
  extensionHost?: SurfaceHost
}

/**
 * The interactive surface: header, transcript, editor, footer. Owns the
 * TUI lifecycle, mode switching, folding, approval dialogs, and settings
 * overlay; input routing and rendering decisions live here so they are
 * testable without a real terminal.
 */
/** One cached component for a transcript message (stage J render cache). */
interface MessageComponentEntry {
  component: Component
  /** The fold boundary the component was built at (Ctrl+O / windowing). */
  boundary: number
  /** The theme revision at build time (colors are baked into the ANSI). */
  themeRev: number
  /** Whether the entry renders expanded (boundary + click override). */
  expanded: boolean
  /** The values the component was built from, for O(1) staleness checks:
   * text-bearing kinds compare the CURRENT text object — an unchanged
   * message keeps the same string instance, so the check is O(1) and
   * streaming chunks (which create a new string) reliably miss. */
  text?: string
  running?: boolean
  label?: string
  summary?: string
  status?: string
  args?: string
  result?: string
  meta?: unknown
  members?: unknown
  error?: { name: string; code: string }
}

export class TuiApp {
  private readonly terminal: Terminal
  /** The extension surface host (M2), when the runner attached one. */
  private readonly extensionHost: SurfaceHost | undefined
  private readonly tui: TuiMainScreen
  private readonly editor: Editor
  /**
   * The surface GENERATION: incremented only when a genuinely NEW surface
   * attaches (a fresh TuiApp / SurfaceHost), never by start/stop, fullscreen
   * toggles, or the external-editor stop/start round-trip. Async work that
   * outlives the surface (extension callbacks, pending promises) captures
   * the generation at dispatch time and becomes a benign no-op when it no
   * longer matches — the stale-generation contract (M0).
   */
  private generation = 1
  /** Latched by dispose(): after the final teardown, interactive
   * capabilities fail benignly instead of touching a dead terminal. */
  private disposed = false
  /**
   * The editor's SEAT (kimi's editorContainer): holds the editor normally,
   * the QuestionFrame while a question flow is active — so the dialog
   * renders in the editor's row position (full width, above the footer)
   * instead of a centered modal that covered the transcript.
   */
  private readonly editorSeat: Container
  private readonly header: Text
  private readonly messagesView: Container
  private readonly footer: Text
  private readonly events: TuiAppEvents
  /** Prompts awaiting the user's decision; one is shown at a time. */
  private readonly approvalQueue: PendingApproval[] = []
  /** The prompt currently on screen, if any. */
  private activeApproval: PendingApproval | undefined
  /** The active user-questions flow, if any (one on screen at a time). */
  private activeQuestions: QuestionState | undefined
  /** Flows waiting behind the active one (FIFO; shown on settle). */
  private readonly questionQueue: QuestionState[] = []
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
  /**
   * The persistent dock strip directly above the todo panel: the todo
   * summary. Empty lines drop out entirely.
   */
  private readonly dock: Text
  /**
   * The goal line between the todo panel and the queue pane: `goal ● …`
   * rendered only while a goal is set (display-only).
   */
  private readonly goalLine: Text
  /** Active background tasks for the footer badge (label + status). */
  private dockTasks: readonly { id: string; label: string; status: string; kind?: string }[] = []
  /** Live child subagents (continuable or running one-shot) for the footer badge (never jobs records). */
  private dockAgents: readonly { id: string; label: string; activity: string }[] = []
  /**
   * The queued-input pane below the todo panel: a border rule plus one
   * `❯ text` row per pending message and a dim hint. Renders nothing while
   * the queue is empty.
   */
  private readonly queuePane: Text
  /** The pending inbox messages (next-turn followups and next-step steers). */
  private queueItems: readonly QueueItem[] = []

  /** Whether any background task is running/stopping. */
  private tasksActive = false

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
  /** One shared in-flight autodetect; concurrent callers coalesce onto it
   * (overlapping OSC 11 queries would mis-pair replies by FIFO order). */
  private autoDetectInFlight: Promise<void> | undefined
  /** The LATEST shouldApply guard of the in-flight autodetect; consulted at
   * settle time so a late result can never override a newer explicit
   * choice; reset when the flight settles. */
  private autoDetectGuard: (() => boolean) | undefined
  /** Whether the terminal's live scheme reports are being tracked. */
  private followingTerminalTheme = false
  /** Terminal-scheme listeners, fanned out from every screen's reports. */
  private readonly terminalSchemeListeners = new Set<(theme: 'dark' | 'light') => void>()
  /** Per-screen scheme-report registrations, rebuilt on screen switches. */
  private schemeDisposers: (() => void)[] = []
  /** The mounted transcript-search overlay, while one is open. */
  private searchOverlay: OverlayHandle | undefined
  /** The search input component, while one is open (for match counts). */
  private searchComponent: TranscriptSearchComponent | undefined
  /** Overlay handles currently mounted on the active screen, for mode switches. */
  private readonly overlayHandles = new Set<OverlayHandle>()
  /** Capturing overlays hidden beneath a newer one (modal stacking), keyed by
   * the newer overlay's handle; restored when it hides. */
  private readonly overlayDependents = new Map<OverlayHandle, Set<OverlayHandle>>()
  /** Footer state. */
  private status: StatusData = { model: '', cwd: '', branch: '', turns: 0, steps: 0, statsLine: '' }
  /** Plan-mode badge state; appended to the header and footer when active. */
  private planMode = false
  /** The editor's normal border style, restored when plan mode ends. */
  private readonly editorBorder: (text: string) => string
  /** Welcome card shown above the transcript; renders nothing without facts. */
  private readonly welcomeCard = new WelcomeCard()
  /** Transient error line shown under the transcript; cleared by the next
   * repaint or after {@link TuiApp.NOTIFY_DURATION_MS}, whichever comes first. */
  private notifyText = ''
  /** Styling of the current notify line: info (default) is dim with a ℹ,
   * errors are red with a ✗. */
  private notifyKind: 'error' | 'info' = 'info'
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
  /** ONE external-editor ownership at a time: set synchronously at launch,
   * cleared in the launch's `finally` (success, failure or cancellation). */
  private externalEditorInFlight = false
  /** The live session's auto-generated title, shown in the header when set. */
  private sessionTitleText = ''
  /** The read-only subagent viewer: while set, the editor bar shows a
   * placeholder, the editor border switches to the accent color, and the
   * header carries a persistent badge — the transient notify line is not
   * the only signal. */
  private viewerMode: { id: string; label: string } | undefined
  /** The real draft preserved while the viewer covers the editor bar. */
  private draftBeforeViewer: string | undefined

  constructor(terminal: Terminal, events: TuiAppEvents, options: TuiAppOptions = {}) {
    // The external-editor capability is a BOUND pair: the Ctrl+G flow
    // routes through the owned-task entry, so an editor hook without the
    // runner would silently swallow the key. The type union already
    // forbids it at compile time; this catches runtime violations (plain
    // JS hosts, casts) loudly instead of failing silently.
    if (events.openExternalEditor !== undefined && events.runOwned === undefined) {
      throw new Error('openExternalEditor requires runOwned (the owned-task entry — AGENTS.md)')
    }
    this.terminal = terminal
    this.events = events
    this.extensionHost = options.extensionHost
    // F-17: an invalidation batch re-bakes the outlets; the host then
    // re-merges its chrome rows so the new content reaches the screen.
    this.extensionHost?.setChromeRefresher(() => this.refreshChrome())
    this.notifyDurationMs = options.notifyDurationMs ?? TuiApp.NOTIFY_DURATION_MS
    this.workspaceRoot = options.workspaceRoot
    this.present = options.present

    this.tui = new TuiMainScreen(terminal)
    this.editor = new Editor(this.tui, editorTheme)
    this.editorBorder = this.editor.borderColor
    this.editor.onSubmit = (text) => {
      this.rememberInput(text)
      // Fresh user input supersedes any transient notice (a stale error
      // from the previous submission must not outlive the next one).
      this.clearNotify()
      this.events.onSubmit(text)
    }
    this.editor.onChange = () => {
      // The footer's task badge advertises the ↓ browser ONLY while the
      // editor is empty; the editor mutates without going through
      // setStatus, so keep the badge truthful while tasks are active.
      if (this.tasksActive) this.renderFooter()
    }
    this.header = new Text('🐋  dsh-pi-tui', 0, 0)
    this.messagesView = new Container()
    this.dock = new Text('', 0, 0)
    this.todoPanel = new Text('', 0, 0)
    this.goalLine = new Text('', 0, 0)
    this.queuePane = new Text('', 0, 0)
    // The busy indicator repaints through a callback, not a captured screen:
    // the MAIN screen stops rendering while the alt screen (fullscreen) is
    // active, so a captured TuiMainScreen would freeze the animation at the
    // first frame. app.requestRender routes to the ACTIVE screen.
    this.working = new WorkingIndicator(() => this.requestRender(), options.workingIntervalMs === undefined
      ? {}
      : { intervalMs: options.workingIntervalMs })
    this.footer = new Text('', 0, 0)
    this.editorSeat = new Container()
    this.editorSeat.addChild(this.editor)
    // The working row sits between the todo panel and the editor seat so it
    // is always the row directly above the editor border (pi's
    // statusContainer).
    this.tui.addChild(this.header)
    this.tui.addChild(this.messagesView)
    this.tui.addChild(this.dock)
    this.tui.addChild(this.todoPanel)
    this.tui.addChild(this.goalLine)
    this.tui.addChild(this.queuePane)
    this.tui.addChild(this.working)
    this.tui.addChild(this.editorSeat)
    this.tui.addChild(this.footer)
    this.tui.setFocus(this.editor)
    // Input routes through routeInput (see its doc): the autocomplete
    // repaint must follow every keystroke on whichever screen renders.
    this.tui.addInputListener((data) => this.routeInput(data))
  }

  /**
   * App-level input routing plus the autocomplete repaint. The editor's
   * slash-command autocomplete resolves on a promise microtask AFTER the
   * keystroke's own paint, and the editor's own render requests go to the
   * MAIN screen — which is STOPPED while the alt screen renders (fullscreen),
   * so its renderRequested flag is stuck true and every request is dropped:
   * the fresh suggestion list would never paint (the visible frame always
   * shows the previous query's results — typing /res keeps showing /reload
   * first). Schedule a forced frame on the ACTIVE screen once the provider's
   * continuation has applied the fresh list. Deliberately a dsh-side fix:
   * the vendored fork stays pristine (see AGENTS.md decision 8).
   * @param data - the raw input sequence.
   */
  private routeInput(data: string): TuiInputListenerResult {
    const result = this.handleInput(data)
    // Two hops: the first microtask is queued BEFORE the editor's
    // autocomplete continuation, so the check must be deferred to a second
    // microtask that runs after the fresh list has been applied (otherwise
    // the very first keystroke, whose state is still null at check time,
    // never paints).
    queueMicrotask(() => {
      queueMicrotask(() => {
        if (this.editor.isShowingAutocomplete()) this.requestRender(true)
      })
    })
    return result
  }

  /** Enter raw mode and start rendering. */
  start(): void {
    this.tui.start()
  }

  /** Leave raw mode and stop rendering. */
  stop(): void {
    this.clearNotify()
    this.working.dispose()
    // Every pending question flow settles rejected: a stopped TUI must not
    // leave askQuestions promises hanging forever.
    this.cancelQuestionFlows()
    for (const dispose of this.schemeDisposers) dispose()
    this.schemeDisposers = []
    this.tui.stop()
    this.fullscreen?.stop()
    this.fullscreen = undefined
  }

  /**
   * FINAL surface disposal: the last lifecycle boundary (M0). Idempotent;
   * detaches the surface so old-generation callbacks become benign no-ops;
   * cancels every still-owned interactive resource (question flows, notify
   * timer, overlay graph, terminal-theme tracking). An ordinary `stop()`
   * (external-editor round-trip, mode switches) is NOT disposal — the
   * surface generation survives stop/start, so extension registrations stay
   * valid across the round-trip.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Settle every pending approval BEFORE stop(): settling hides overlay
    // handles (hideCursor), and stop() ends with showCursor — the reverse
    // order would leave the user's cursor hidden after exit. Iterate a COPY:
    // settleApproval splices the item out of approvalQueue, so walking the
    // live array would skip every other queued prompt and leave its promise
    // hanging forever (the round-2 review catch — same defect class the
    // cancelQuestionFlows sibling already avoided with its own copy).
    for (const pending of [...this.approvalQueue]) this.settleApproval(pending, 'cancelled')
    this.approvalQueue.length = 0
    if (this.activeApproval !== undefined) this.settleApproval(this.activeApproval, 'cancelled')
    this.stop()
    this.generation += 1
    this.clearNotify()
    if (this.notifyTimer !== undefined) {
      clearTimeout(this.notifyTimer)
      this.notifyTimer = undefined
    }
    this.terminalSchemeListeners.clear()
    this.expandedOverride.clear()
    this.messageComponents.clear()
    this.localMessages.length = 0
    this.overlayHandles.clear()
    this.overlayDependents.clear()
    // The transcript-search overlay dies with the surface: stale handles
    // must never focus() or repaint a dead component.
    this.searchOverlay = undefined
    this.searchComponent = undefined
    this.status = { model: '', cwd: '', branch: '', turns: 0, steps: 0, statsLine: '' }
    // Detach the extension surface host: its subscriptions and capability
    // set die with the surface (M2 stale-generation contract).
    this.extensionHost?.dispose()
  }

  /** The surface generation (M0): stable across start/stop/fullscreen/
   * external-editor round-trips, bumped only by a final dispose. */
  getSurfaceGeneration(): number {
    return this.generation
  }

  /** Whether this surface has been finally disposed (M0). */
  isDisposed(): boolean {
    return this.disposed
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
    // The subagent viewer is READ-ONLY: while viewing, every key except
    // Esc (exit) and Ctrl+O (fold toggle — the viewed transcript still
    // folds) is inert — no typing into the placeholder bar, no Enter
    // submit, no Ctrl+S steer, no ↓ browser. Overlays keep their keys.
    if (this.viewerMode !== undefined && !this.activeScreen.hasOverlayEntries
      && !matchesKey(data, 'escape') && !matchesKey(data, 'ctrl+o')) {
      return { consume: true }
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
    if (matchesKey(data, 'shift+tab')) {
      // Cycle the permission preset; overlays keep Shift+Tab for themselves.
      if (this.activeScreen.hasOverlayEntries) return undefined
      this.events.onCyclePermission?.()
      return { consume: true }
    }
    if (matchesKey(data, 'alt+up')) {
      // Dequeue (Alt+↑): pull queued input back into the editor; overlays
      // keep the key for themselves.
      if (this.activeScreen.hasOverlayEntries) return undefined
      this.events.onDequeue?.()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+enter')) {
      // The busy-Enter opposite chord (web busyEnter parity): Ctrl+Enter
      // forces the QUEUE delivery mode while the agent is busy, regardless
      // of the busyEnter preference (plain Enter then steers when the
      // preference is 'steer'). Overlays keep the key for themselves; the
      // editor never sees the chord — the submit mirrors a plain Enter
      // (history + notify clear + draft clear). Without a wired
      // onQueueSubmit the key falls through to the editor instead of
      // dropping the draft; an EMPTY draft falls through too — plain Enter
      // on an empty editor does not submit, and an empty chord would
      // otherwise dispatch a session-creating empty followup.
      if (this.activeScreen.hasOverlayEntries) return undefined
      if (this.events.onQueueSubmit === undefined) return undefined
      const text = this.editor.getText()
      if (text.trim() === '') return undefined
      this.rememberInput(text)
      this.clearNotify()
      this.editor.setText('')
      this.events.onQueueSubmit(text)
      return { consume: true }
    }
    if (matchesKey(data, 'escape')) {
      // Overlays (pickers, settings) own Esc while they are up.
      if (this.activeScreen.hasOverlayEntries) return undefined
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
      // An empty draft still fires the event — the runner steers every
      // queued message when the queue is non-empty, and only ignores the
      // key when there is nothing to send at all.
      if (this.activeScreen.hasOverlayEntries) return { consume: true }
      const draft = this.editor.getText()
      this.editor.setText('')
      this.events.onSteer?.(draft)
      return { consume: true }
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+j')) {
      // Task browser: with active background tasks and an EMPTY editor, ↓ /
      // Ctrl+J open the task list (nothing to move the cursor through). With
      // text present the keys keep their editing meaning; overlays own them.
      if (this.tasksActive && !this.activeScreen.hasOverlayEntries && this.editor.getText().trim() === '') {
        this.events.onOpenTasks?.()
        return { consume: true }
      }
    }
    if (matchesKey(data, 'ctrl+g')) {
      // External editor; overlays own Ctrl+G while up (alt-screen search).
      // An owned workflow routed through the host's runOwned (diag attached
      // by the runner): a spawn failure lands in diagnostics and notifies
      // here — never a bare `void somePromise()` (AGENTS.md). The editor
      // hook and runOwned are a BOUND pair (type union + constructor
      // check): without the editor hook Ctrl+G is a documented no-op.
      // Single-flight: while one launch is pending (the latch inside
      // launchExternalEditor is set synchronously), further Ctrl+G presses
      // are consumed without starting another editor.
      if (this.activeScreen.hasOverlayEntries) return { consume: true }
      if (this.events.openExternalEditor !== undefined && !this.externalEditorInFlight) {
        this.events.runOwned('external editor', () => this.launchExternalEditor(), {
          onError: (error: unknown) => {
            this.notify(`external editor failed: ${safeErrorMessage(error)}`, 'error')
          },
        })
      }
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

  /**
   * The screen currently rendering: the alt screen in fullscreen mode, the
   * main screen otherwise. Every render request, terminal query and overlay
   * mount routes through this accessor so regular and fullscreen modes
   * always target the ACTIVE screen (M0 naming; previously overlayHost).
   */
  private get activeScreen(): TuiMainScreen | TuiAltScreen {
    return this.fullscreen ?? this.tui
  }

  /**
   * Show an overlay on the active screen and track its handle, so a
   * fullscreen toggle can hide every mounted overlay on the old screen.
   * Capturing overlays stack modally: every other capturing overlay is
   * hidden beneath the new one and restored when it hides — the fork's
   * compositor interleaves stacked boxes line by line (two different-width
   * dialogs would garble into one frame), and modal hiding is done here so
   * the vendored fork stays pristine.
   *
   * While a question flow owns the seat (a logical capturing modal), a NEW
   * overlay joins the question's suspension set instead of appearing on top:
   * it is hidden, the question's directly suspended handles become ITS
   * dependents (kept hidden, restored only when it closes), and the overlay
   * itself becomes the question's frontmost suspended handle — so reverse
   * modal order survives the question. Question input keeps first priority
   * either way (routeInput).
   * @param component - the overlay content.
   * @param options - overlay sizing/positioning.
   * @returns the handle; hide() also forgets the handle.
   */
  private showOverlayOnHost(component: Component, options: OverlayOptions): OverlayHandle {
    const handle = this.activeScreen.showOverlay(component, options)
    this.overlayHandles.add(handle)
    const question = this.activeQuestions
    if (question !== undefined) {
      // Sweep: any tracked overlay still visible (normally none — the
      // question suspended every visible one at present) joins the
      // suspension alongside the new overlay.
      for (const other of this.overlayHandles) {
        if (other !== handle && !other.isHidden()) {
          other.setHidden(true)
          question.suspendedOverlays.add(other)
        }
      }
      if (options?.nonCapturing !== true) {
        // The new capturing overlay takes the modal front: the question's
        // directly suspended handles become its dependents (kept hidden),
        // so settling the question reveals IT, and settling it reveals the
        // overlays beneath — in reverse arrival order.
        const dependents = new Set<OverlayHandle>()
        for (const other of question.suspendedOverlays) dependents.add(other)
        if (dependents.size > 0) {
          for (const other of dependents) question.suspendedOverlays.delete(other)
          this.overlayDependents.set(handle, dependents)
        }
      }
      handle.setHidden(true)
      question.suspendedOverlays.add(handle)
      return { ...handle, hide: () => this.closeOverlayHandle(handle) }
    }
    if (options?.nonCapturing !== true) {
      const hidden = new Set<OverlayHandle>()
      for (const other of this.overlayHandles) {
        if (other !== handle && !other.isHidden()) {
          other.setHidden(true)
          hidden.add(other)
        }
      }
      if (hidden.size > 0) this.overlayDependents.set(handle, hidden)
    }
    return { ...handle, hide: () => this.closeOverlayHandle(handle) }
  }

  /**
   * Question-aware close for one tracked overlay handle (the wrapper's
   * hide). Without an active question this matches the historical behavior:
   * the handle's dependents are unhidden, the graph is cleaned, and the
   * overlay is removed. While a question owns the seat, the handle leaves
   * the question's suspension set, every dependency set drops it (no parent
   * retains a dead child), and its still-mounted dependents remain hidden
   * and become DIRECTLY owned by the question — they must not flash back
   * while the question is still up.
   */
  private closeOverlayHandle(handle: OverlayHandle): void {
    const question = this.activeQuestions
    if (question !== undefined) question.suspendedOverlays.delete(handle)
    for (const dependents of this.overlayDependents.values()) dependents.delete(handle)
    const owned = this.overlayDependents.get(handle)
    if (owned !== undefined) {
      this.overlayDependents.delete(handle)
      if (question !== undefined) {
        for (const dependent of owned) question.suspendedOverlays.add(dependent)
      } else {
        for (const dependent of owned) dependent.setHidden(false)
      }
    }
    this.overlayHandles.delete(handle)
    handle.hide()
  }

  /**
   * Launch the external editor with the current draft. The TUI stops first
   * (raw mode released) and restarts after the editor returns; a fullscreen
   * mode is not restored (the editor session ends in regular mode).
   *
   * SINGLE-FLIGHT: only ONE editor ownership exists at a time. The latch is
   * set synchronously at entry and cleared in the OUTERMOST `finally`, so
   * no stage — draft read, stop, the editor round-trip, draft apply, start —
   * can throw and leave the latch stuck: every terminal outcome (success,
   * failure, cancellation, a restart failure) releases it, and a repeated
   * Ctrl+G in the same input batch, a macro, or a direct caller can never
   * start a second editor while one is pending.
   */
  async launchExternalEditor(): Promise<void> {
    const open = this.events.openExternalEditor
    if (open === undefined || this.externalEditorInFlight || this.disposed) return
    this.externalEditorInFlight = true
    try {
      const draft = this.editor.getText()
      this.stop()
      try {
        const next = await open(draft)
        if (this.disposed) return
        // No redundant editor update when the editor saved the draft
        // unchanged (an update would bump history/undo and repaint).
        if (next !== '' && next !== draft) this.editor.setText(next)
      } finally {
        if (!this.disposed) this.start()
      }
    } finally {
      this.externalEditorInFlight = false
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
   * The persistence mirror is filled with the SAME semantics as the editor
   * (only consecutive duplicates collapse, 100-entry cap), so the mirror
   * always equals what ↑/↓ can recall — non-consecutive repeats like
   * `['a', 'b', 'a']` are legal history and must survive the round-trip.
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
    // Mirror: push newest→oldest, collapsing only CONSECUTIVE duplicates
    // (the editor's rule), capped at the same 100 entries as the editor.
    let last: string | undefined
    for (const entry of entries) {
      const trimmed = entry.trim()
      if (trimmed === '' || trimmed === last) continue
      last = trimmed
      this.inputHistory.push(trimmed)
    }
    if (this.inputHistory.length > TuiApp.INPUT_HISTORY_LIMIT) {
      this.inputHistory.length = TuiApp.INPUT_HISTORY_LIMIT
    }
  }

  /**
   * REPLACE the whole recall history (editor + persistence mirror) with the
   * entries of the CURRENT workspace. Session switches must not recall the
   * previous workspace's inputs nor pollute the new workspace's persisted
   * history, so the host resets on every session change.
   * @param entries - the new workspace's persisted entries, newest first.
   */
  resetInputHistory(entries: readonly string[]): void {
    this.editor.clearHistory()
    this.inputHistory.length = 0
    this.seedInputHistory(entries)
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
   * Drop SETTLED local cards (completed `!`/`!!` shell runs); running cards
   * survive so a live stream is never dismissed by a concurrent submit.
   * Local cards are a live view, not a record: context runs clear on submit
   * success (the transcript's user row takes over), local-only runs on the
   * next user submission (dispatchUserInput / steerNow).
   */
  clearSettledLocalMessages(): void {
    const running = this.localMessages.filter(message => message.kind === 'tool' && message.status === 'running')
    if (running.length === this.localMessages.length) return
    this.localMessages.length = 0
    this.localMessages.push(...running)
    this.rebuildMessages()
  }

  /**
   * Toggle between regular (terminal scrollback) and fullscreen (alt screen).
   * Overlays live on the active screen, so the switch hides every mounted
   * overlay; a pending approval prompt is re-rendered on the new screen.
   */
  toggleFullscreen(): void {
    if (this.disposed) return
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
    if (this.disposed) return
    const active = this.fullscreen !== undefined
    if (enabled === active) return
    const pending = this.activeApproval
    pending?.handle?.hide()
    // overlayHandles holds RAW handles (showOverlayOnHost stores them before
    // wrapping), so this loop calls the pi-tui hide directly: it removes
    // every overlay from the OLD screen's stack. The tracking graph below
    // (overlayHandles, overlayDependents, the active question's suspension)
    // is then cleared wholesale — every one of those handles is dead, and
    // the pending-approval rebuild re-suspends a fresh handle on the new
    // screen.
    for (const handle of this.overlayHandles) handle.hide()
    this.overlayHandles.clear()
    this.overlayDependents.clear()
    if (this.activeQuestions !== undefined) this.activeQuestions.suspendedOverlays.clear()
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
        { component: this.dock, shrink: 0 },
        { component: this.todoPanel, shrink: 0 },
        { component: this.goalLine, shrink: 0 },
        { component: this.queuePane, shrink: 0 },
        // The busy indicator row sits directly above the editor border
        // (pi's statusContainer placement); idle it renders zero rows.
        { component: this.working, shrink: 0 },
        { component: this.editorSeat, shrink: 0 },
        { component: this.footer, shrink: 0 },
      ])
      alt.setLayoutRoot(root)
      alt.addInputListener((data) => this.routeInput(data))
      this.tui.stop()
      alt.start()
      // The alt screen starts with NO focused component: without this, every
      // key after Ctrl+F is dropped (the app-level listener still sees
      // shortcuts, but the editor never receives text or Enter).
      alt.setFocus(this.editor)
      this.fullscreen = alt
      // The alt screen now owns the terminal input handler: scheme reports
      // arrive THERE, so re-register the fan-out on both screens.
      this.refreshSchemeRegistrations()
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
      // The main screen owns the terminal input handler again.
      this.refreshSchemeRegistrations()
    }
    this.events.onFullscreenChange?.(enabled)
    if (pending !== undefined) this.renderApprovalDialog(pending)
    // A question survives the switch through the SHARED seat (both screens'
    // layouts hold the same editorSeat): keep its frame focused on the new
    // screen — the flow's input routing is screen-agnostic. The old screen's
    // overlay handles are dead and were dropped from the tracking graph
    // above; the rebuilt approval (if any) is suspended afresh on the new
    // screen.
    const question = this.activeQuestions
    if (question?.frame !== undefined) {
      (this.fullscreen ?? this.tui).setFocus(question.frame)
    }
    // The surface slice tracks the mode switch (plan §7.1).
    this.extensionHost?.updateSurface({ fullscreen: enabled })
  }

  /**
   * Open the transcript-search overlay (Ctrl+Shift+F) and focus its input.
   * The search itself runs in the host against the folded transcript; this
   * surface only collects the query and reports navigation keys.
   */
  startTranscriptSearch(): void {
    if (this.disposed) return
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
    // Repaints do NOT clear the transient notify line: an active session
    // repaints every frame (streaming chunks, tool cards), and clearing on
    // each repaint would make every notice — including error blocks like
    // the divergence guard's — flash for a frame. The notify expires via
    // its 8s auto-clear timer or an explicit clear (user submit, session
    // switch, stop).
    // (The component cache is pruned inside rebuildMessages below.)
    this.rebuildMessages()
  }

  /**
   * Drop cached message components that left the live transcript (window
   * slides forward forever in a long session, so the cache must never grow
   * to full-history size). The live set is the current transcript plus the
   * local cards; entries outside it are disposed and removed. O(live +
   * cache) per rebuild — the same order as rebuildMessages. Runs at the
   * START of every rebuild, so local-card push/replace/clear paths prune
   * too (a replaced running card must not linger in the cache).
   */
  private pruneMessageComponents(): void {
    if (this.messageComponents.size === 0) return
    const live = new Set<TranscriptMessage>(this.messages)
    for (const message of this.localMessages) live.add(message)
    for (const [message, entry] of this.messageComponents) {
      if (live.has(message)) continue
      this.messageComponents.delete(message)
      const component = entry.component as { dispose?: () => void } | undefined
      if (component?.dispose !== undefined) {
        try {
          component.dispose()
        } catch {
          // Best effort: a cached component's dispose must not break a paint.
        }
      }
    }
  }

  /** Rebuild the message component tree from the current transcript state. */
  private rebuildMessages(): void {
    // Every rebuild path (transcript updates AND local-card push/replace/
    // clear) prunes the cache to the live set first.
    this.pruneMessageComponents()
    this.messagesView.clear()
    this.messagesView.addChild(this.welcomeCard)
    const boundary = this.expandBoundary()
    // Row heights for mouse hit-testing: components render (and cache) at
    // the same width the frame pass uses, so the heights match the screen.
    const width = this.terminal.columns
    const rows: Array<{ message: TranscriptMessage; height: number }> = []
    // One blank row separates consecutive blocks (pi/kimi Spacer parity), so
    // a session never reads as one undifferentiated wall of text. The spacer
    // row is charged to the preceding message's height, keeping the fullscreen
    // click hit-testing aligned with the rendered layout.
    const blocks: TranscriptMessage[] = [
      ...this.messages.filter(message => !(message.kind === 'thinking' && this.hideThinking)),
      ...this.localMessages,
    ]
    blocks.forEach((message, index) => {
      // Persistent per-message components (stage J): unchanged messages
      // reuse their component, so the fork's text-identity render caches
      // actually hit — markdown is not re-parsed and heights are not
      // recomputed for content that did not change. Only streaming/changed
      // messages rebuild.
      const component = this.componentForMessage(message, boundary)
      this.messagesView.addChild(component)
      const height = component.render(width).length + (index < blocks.length - 1 ? 1 : 0)
      rows.push({ message, height })
      if (index < blocks.length - 1) this.messagesView.addChild(new Spacer())
    })
    if (this.notifyText !== '') {
      // Errors flash red with a ✗; informational notices render dim with a ℹ
      // so a successful action never reads as a failure.
      const line = this.notifyKind === 'info'
        ? color.textDim(`ℹ ${this.notifyText}`)
        : color.error(`✗ ${this.notifyText}`)
      this.messagesView.addChild(new Text(line, 0, 0))
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
    this.syncExtensionState()
  }

  /**
   * Anchor the transcript view to its END (the latest content). Fullscreen
   * scrolls its ScrollView; the regular surface has no scroll view (it draws
   * into the terminal scrollback), so a forced full repaint re-renders from
   * row 0 and the main screen's viewport tracking lands on the bottom — the
   * same mechanism the fullscreen-toggle path uses to redraw cleanly.
   */
  scrollToBottom(): void {
    if (this.fullscreenScroll !== undefined) {
      this.fullscreenScroll.scrollToEnd()
    } else {
      this.tui.requestRender(true)
    }
  }

  /**
   * Set the live session's auto-generated title (from the session/title
   * log) for the header; undefined clears it.
   */
  setSessionTitle(title: string | undefined): void {
    this.sessionTitleText = title ?? ''
    this.renderHeader()
    this.extensionHost?.updateSession({ title: title ?? '' })
  }

  /**
   * Map a fullscreen click (0-based screen cell, from the alt screen's
   * onCellClick) onto a transcript message and toggle its individual
   * expansion — the web's click-to-disclose behavior for one card at a time.
   * The global Ctrl+O fold still wins, so keyboard behavior is unchanged.
   */
  private handleFullscreenClick(x: number, y: number): void {
    // A question owns the modal front: clicks inside its frame (the editor
    // seat, pinned above the footer) route to the flow — option rows select,
    // the body scroll marker toggles the expanded region. The seat's screen
    // range is derived from the bottom: footer height + the frame's last
    // rendered height.
    const question = this.activeQuestions
    if (question?.frame !== undefined) {
      // Stale-geometry guard: between a terminal resize and the next
      // repaint the frame's rendered height (and the flow's hit map) still
      // reflect the OLD terminal — a click in that window would map to the
      // wrong content row. Ignore clicks until the next render.
      if (this.terminal.rows !== question.frame.termRows) return
      const width = this.terminal.columns
      const height = this.terminal.rows
      const footerHeight = this.footer.render(width).length
      const seatHeight = question.frame.rows
      const seatBottom = height - footerHeight
      const seatTop = seatBottom - seatHeight
      if (y >= seatTop && y < seatBottom) {
        // Inside the frame: its side borders + padding occupy columns 0-1
        // and the last two; content rows start below the top border.
        if (x >= 2 && x <= width - 3) {
          question.flow.clickRow(y - seatTop - 1)
          this.requestRender()
        }
        return
      }
    }
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

  /** Drop all per-message expansion overrides (session-scoped state: a
   * session switch must not leak the old session's click toggles). */
  clearSessionOverrides(): void {
    this.expandedOverride.clear()
    // The per-message render cache is session-scoped too: old messages are
    // unreachable after a switch, so drop their cached components.
    this.messageComponents.clear()
  }

  /** Show or clear plan mode: header + footer badges and a warning-tinted editor border. */
  setPlanMode(active: boolean): void {
    this.planMode = active
    this.renderHeader()
    this.renderFooter()
    this.editor.borderColor = active ? color.warning : this.editorBorder
    this.editor.invalidate()
    this.requestRender()
    this.syncExtensionState()
  }

  /**
   * Show a transient line under the transcript. Cleared by the next
   * `setTranscript` repaint or after {@link TuiApp.NOTIFY_DURATION_MS},
   * whichever comes first, so a one-off notice never lingers forever.
   * @param text - the notice text.
   * @param kind - `'info'` renders dim with a ℹ (default, the common case);
   * `'error'` renders red with a ✗ — pass it explicitly for failures.
   */
  notify(text: string, kind: 'error' | 'info' = 'info'): void {
    this.notifyText = text
    this.notifyKind = kind
    if (this.notifyTimer !== undefined) clearTimeout(this.notifyTimer)
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = undefined
      this.notifyText = ''
      this.rebuildMessages()
    }, this.notifyDurationMs)
    this.rebuildMessages()
  }

  /** Clear the transient notify line and its pending auto-clear timer.
   * Called on fresh user input and session switches; repaints alone never
   * clear it (an active session would flash every notice away). Rebuilds
   * the transcript when a notice was actually showing. */
  clearNotify(): void {
    if (this.notifyText === '' && this.notifyTimer === undefined) return
    this.notifyText = ''
    if (this.notifyTimer !== undefined) {
      clearTimeout(this.notifyTimer)
      this.notifyTimer = undefined
    }
    this.rebuildMessages()
  }

  /**
   * Replace the editor draft. The runner restores a submission that the
   * divergence guard blocked, so the user's text survives for a retry.
   * While the subagent viewer covers the editor, the write goes to the
   * preserved draft (the placeholder bar stays up; the draft is restored
   * on exit).
   */
  setEditorText(text: string): void {
    if (this.viewerMode !== undefined) {
      this.draftBeforeViewer = text
      return
    }
    this.editor.setText(text)
  }

  /**
   * Enter or leave the read-only subagent viewer. While viewing, the
   * editor bar is covered by a placeholder (the real draft is preserved
   * and restored on exit), the editor border switches to the accent color,
   * and the header shows a persistent `[viewing subagent]` badge — so the
   * mode reads at a glance instead of relying on the transient notify.
   * @param mode - the child identity + label; `undefined` leaves the viewer.
   */
  setViewerMode(mode: { id: string; label: string } | undefined): void {
    if (mode === undefined) {
      if (this.viewerMode === undefined) return
      this.viewerMode = undefined
      this.editor.borderColor = this.editorBorder
      this.editor.setText(this.draftBeforeViewer ?? '')
      this.draftBeforeViewer = undefined
      this.editor.invalidate()
      this.renderHeader()
      this.requestRender()
      this.syncExtensionState()
      return
    }
    if (this.viewerMode === undefined) {
      this.draftBeforeViewer = this.editor.getText()
    }
    this.viewerMode = mode
    this.editor.borderColor = color.accent
    this.editor.setText(`viewing subagent: ${mode.label} — read-only · Esc returns`)
    this.editor.invalidate()
    this.renderHeader()
    this.requestRender()
    this.syncExtensionState()
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
    // Session identity mirrors into the extension snapshot (plan §7.2).
    this.extensionHost?.updateSession({
      sessionId: facts.sessionId,
      workspaceRoot: facts.cwd,
      ...facts.model === '' ? {} : { model: facts.model },
    })
  }

  /**
   * Toggle the pre-session welcome state (deferred session creation): the
   * card invites the first message; the first real facts replace it.
   */
  setWelcomeIdle(idle: boolean): void {
    this.welcomeCard.setIdle(idle)
    this.rebuildMessages()
  }

  /** The turn threshold at or above which collapsible entries expand. */
  private expandBoundary(): number {
    if (!this.toolOutputExpanded || EXPAND_RECENT_TURNS <= 0) return Number.POSITIVE_INFINITY
    return recentTurnThreshold(this.messages, EXPAND_RECENT_TURNS, ['thinking', 'system', 'tool'])
  }



  /** Theme revision for render-cache invalidation; bumped on every switch. */
  private themeRevision = 0

  /** Persistent components per transcript message (stage J cache). */
  private readonly messageComponents = new Map<TranscriptMessage, MessageComponentEntry>()

  /**
   * Get (or rebuild) the component for one message at this fold boundary.
   * Unchanged messages reuse their component instance, so the fork's
   * text-identity render caches (Text/Markdown key on `text === cachedText`
   * and width) hit on every frame: markdown is not re-parsed and heights
   * are not recomputed for content that did not change. The cache is
   * invalidated lazily per key: fold boundary, theme revision, expanded
   * state, and the message's own content — plus wholesale on session
   * switch (clearSessionOverrides).
   */
  private componentForMessage(message: TranscriptMessage, boundary: number): Component {
    const expanded = (message.kind === 'thinking' || message.kind === 'system' || message.kind === 'tool')
      && (message.turn >= boundary || this.expandedOverride.get(message) === true)
    const entry = this.messageComponents.get(message)
    if (entry === undefined) {
      const built: MessageComponentEntry = {
        component: this.renderMessage(message, boundary),
        boundary,
        themeRev: this.themeRevision,
        expanded,
      }
      this.captureComponentState(built, message)
      this.messageComponents.set(message, built)
      return built.component
    }
    if (entry.boundary !== boundary || entry.themeRev !== this.themeRevision
      || entry.expanded !== expanded || this.componentStale(entry, message)) {
      entry.component = this.renderMessage(message, boundary)
      entry.boundary = boundary
      entry.themeRev = this.themeRevision
      entry.expanded = expanded
      this.captureComponentState(entry, message)
    }
    return entry.component
  }

  /** Record the message values a component was built from. */
  private captureComponentState(entry: MessageComponentEntry, message: TranscriptMessage): void {
    switch (message.kind) {
      case 'user':
      case 'assistant':
      case 'thinking':
      case 'system':
        entry.text = message.text
        entry.running = message.kind === 'thinking' ? message.running : undefined
        entry.label = message.kind === 'system' ? message.label : undefined
        entry.summary = message.kind === 'system' ? message.summary : undefined
        break
      case 'tool':
        entry.status = message.status
        entry.args = message.args
        entry.result = message.result
        entry.meta = message.meta
        entry.members = message.members
        entry.error = message.error
        break
      case 'summary':
        break
    }
  }

  /** Whether the message content changed since the component was built. */
  private componentStale(entry: MessageComponentEntry, message: TranscriptMessage): boolean {
    switch (message.kind) {
      case 'user':
      case 'assistant':
        return entry.text !== message.text
      case 'thinking':
        return entry.text !== message.text || entry.running !== message.running
      case 'system':
        return entry.text !== message.text || entry.label !== message.label || entry.summary !== message.summary
      case 'tool':
        return entry.status !== message.status || entry.args !== message.args
          || entry.result !== message.result || entry.meta !== message.meta || entry.members !== message.members
          || entry.error !== message.error
      case 'summary':
        return false
    }
  }

  /** Render one transcript message as a pi-tui component. */
  private renderMessage(message: TranscriptMessage, boundary: number): Component {
    if (message.kind === 'user') {
      // Terminal-prompt style: the user's line reads like a shell command.
      // The ❯ leads the FIRST line; wrapped continuation lines indent under
      // it (kimi prefix+indent parity), so multi-line input stays aligned.
      return new BulletedComponent(new Text(message.text, 0, 0), `${color.roleUser('❯')} `)
    }
    if (message.kind === 'assistant') {
      // The whale bullet leads the FIRST markdown line; wrapped continuation
      // lines indent under it (kimi prefix+indent parity), so the bullet
      // never floats alone on its own row. The markdown stays a LIVE child:
      // a terminal resize re-renders it at the new width, so tables reflow
      // instead of re-wrapping a frozen render (the 5a76526 regression).
      return new BulletedComponent(new Markdown(message.text, 0, 0, markdownTheme), `${color.primary('🐋')}  `)
    }
    if (message.kind === 'thinking') {
      const expanded = message.turn >= boundary || this.expandedOverride.get(message) === true
      if (expanded) {
        // Expanded thinking stays dim+italic so reasoning never reads like
        // the assistant's actual output (web parity: a distinct style).
        return new Text(color.textDimItalic(`🐳  ${message.text}`), 0, 0)
      }
      // Folded: exactly two content rows plus the expand hint, so the block's
      // height is stable while reasoning streams (no per-frame jump). While a
      // step streams the rows follow the LATEST reasoning lines (the Web's
      // running summary); once settled they show the FIRST lines (settled
      // summary). Every row truncates to the terminal width, so a folded
      // block never wraps.
      const lines = message.text.split('\n').filter(line => line !== '')
      const shown = message.running === true ? lines.slice(-2) : lines.slice(0, 2)
      const prefix = '🐳  '
      const prefixWidth = visibleWidth(prefix)
      const contentWidth = Math.max(1, this.terminal.columns - prefixWidth)
      const rows = Array.from({ length: 2 }, (_, index) => {
        const text = shown[index] ?? ''
        const body = text === '' ? '' : truncateToWidth(text, contentWidth, '…')
        const pad = index === 0 ? prefix : ' '.repeat(prefixWidth)
        return color.textDimItalic(pad + body)
      })
      const remaining = lines.length - 2
      const hint = remaining > 0
        ? `... (${remaining} more lines, ctrl+o to expand)`
        : '(ctrl+o to expand)'
      rows.push(color.textDim(`${' '.repeat(prefixWidth)}${truncateToWidth(hint, contentWidth, '…')}`))
      return new Text(rows.join('\n'), 0, 0)
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
          row.addChild(new Text(color.textMuted(`${emoji}  Context injection ${message.label}`), 0, 0))
          // Injected content stays dimmed like tool-card bodies: context is
          // never mistaken for the assistant's actual output.
          row.addChild(new Text(color.textDim(message.text), 0, 0))
        } else {
          const summary = message.summary === undefined ? '' : ` — ${message.summary}`
          // Folded rows truncate to one line: a long label/summary must not
          // wrap the context row (same rule as folded thinking).
          row.addChild(new Text(truncateToWidth(
            color.textMuted(`${emoji}  Context injection ${message.label}${summary} (ctrl+o to expand)`),
            this.terminal.columns,
            '…',
          ), 0, 0))
        }
        return row
      }
      const text = expanded
        ? `${color.textMuted('§')} ${color.textDim(message.text)}`
        : color.textMuted(`§ ${truncateToWidth(preview(message.text, 2), Math.max(1, this.terminal.columns - 22), '…')} (ctrl+o to expand)`)
      return new Text(text, 0, 0)
    }
    if (message.kind === 'summary') {
      // Windowing: turns older than the display window collapse to one line.
      return new Text(color.textDim(message.text), 0, 0)
    }
    // Tool card: the Web row-model header (design title + relativized args
    // summary + status pill), with the result body when expanded. The whole
    // header reads dim like every other intermediate step; only the status
    // pill keeps its semantic color (ok/error/running).
    const card = new Container()
    const header = toolCardHeader(message.name, message.args, this.workspaceRoot)
    const summary = header.summary === '' ? '' : ` ${header.summary}`
    const emoji = toolEmoji(message.name)
    const pill = message.status === 'ok'
      ? color.success('[ok]')
      : message.status === 'error'
        ? color.error('[error]')
        : color.textDim('[running]')
    const head = `${color.textDim(`${emoji}  ${header.title}${summary}`)} ${pill}`
    if (message.turn >= boundary || this.expandedOverride.get(message) === true) {
      card.addChild(new Text(head, 0, 0))
      // An explicitly expanded card (mouse click) renders diff bodies in
      // full; the default recent-turn view caps them (kimi parity).
      this.renderToolBody(card, message, this.expandedOverride.get(message) === true)
    } else {
      // Folded cards render 2–3 rows instead of one cramped line: the header
      // row, then the call preview (bash `$ command` / edit-write diff —
      // kimi parity: the command and the change are visible without
      // expanding), then the result preview. Read cards keep the envelope
      // summary (`— N lines`), never a dump of the raw XML. Every row
      // truncates to the terminal width, so a folded block never wraps.
      const rows: string[] = []
      const callPreview = parseCallPreview(message.name, message.args)
      // The header already carries friendly summaries (todo counts, web
      // query/url via SUMMARY_KEYS, skill name via the first string arg),
      // so the folded preview only adds a tool identity when the header
      // summary is empty (e.g. an arg shape the generic derivation cannot
      // read). Web/skill/todo never need it — their headers are friendly.
      const foldedCall = header.summary === '' ? foldedCallPreview(message.name, message.args) : ''
      const resultPreview = message.name === 'read'
        ? readFoldedPreview(message.result)
        : message.result === ''
          ? ''
          : ` — ${preview(message.result, RESULT_PREVIEW_LINES)}`
      const callHead = foldedCall === '' ? '' : foldedCall
      const headWithPreview = `${head}${callHead}${resultPreview}`
      if (callPreview?.kind === 'bash' && callPreview.command !== '') {
        // The command row owns the result preview's separate line (kimi
        // ShellExecution layout), so the head row carries no result text.
        rows.push(truncateToWidth(`${head}${callHead}`, this.terminal.columns, '…'))
        const commandLines = callPreview.command.split('\n')
        const shown = commandLines.slice(0, FOLDED_COMMAND_LINES)
        const prompt = color.shellMode('$ ')
        const indent = '  '
        const contentWidth = Math.max(1, this.terminal.columns - visibleWidth(indent) - visibleWidth(prompt))
        rows.push(`${indent}${prompt}${truncateToWidth(color.textDim(shown[0] ?? ''), contentWidth, '…')}`)
        for (const line of shown.slice(1)) {
          rows.push(`${indent}${' '.repeat(visibleWidth(prompt))}${truncateToWidth(color.textDim(line), contentWidth, '…')}`)
        }
        if (commandLines.length > FOLDED_COMMAND_LINES) {
          rows.push(color.textDim(`${indent}… ${commandLines.length - FOLDED_COMMAND_LINES} more command lines (ctrl+o to expand)`))
        }
        // The result preview gets its own row so the command never shares a
        // line with output (kimi ShellExecution layout).
        if (resultPreview !== '') {
          rows.push(color.textDim(`  ${resultPreview}`))
        }
      } else if (callPreview?.kind === 'diff' && callPreview.diffs.length > 0) {
        rows.push(truncateToWidth(`${headWithPreview}`, this.terminal.columns, '…'))
        for (const line of renderDiffView(callPreview.diffs, this.workspaceRoot, {
          maxLines: FOLDED_DIFF_LINES,
          expandHint: 'ctrl+o to expand',
        })) {
          rows.push(`  ${line}`)
        }
      } else {
        rows.push(truncateToWidth(headWithPreview, this.terminal.columns, '…'))
      }
      card.addChild(new Text(rows.join('\n'), 0, 0))
    }
    return card
  }

  /**
   * The expanded card's terminal-command row: `$ cmd` (bash) or `PS> cmd`
   * (pwsh) in the shell prompt token, dimmed (kimi ShellExecution parity —
   * the folded card shows the command; the expanded body must not drop
   * it). Multi-line commands render every line under the prompt. No-op for
   * an empty command.
   * @param card - the card container to fill.
   * @param command - the command text.
   * @param prompt - the shell prompt token (`$ ` or `PS> `).
   */
  private addTerminalCommandRow(card: Container, command: string, prompt: string): void {
    if (command === '') return
    const styledPrompt = color.shellMode(prompt)
    const lines = command.split('\n')
    for (const [index, line] of lines.entries()) {
      const prefix = index === 0 ? styledPrompt : ' '.repeat(visibleWidth(styledPrompt))
      card.addChild(new Text(`${prefix}${color.textDim(line)}`, 0, 0))
    }
  }

  /** The bash/pwsh command from the raw args ('' when not a terminal call). */
  private terminalCommand(name: string, argsRaw: string): string {
    const call = parseCallPreview(name, argsRaw)
    return call?.kind === 'bash' ? call.command : ''
  }

  /** The shell prompt token for a terminal tool (pwsh renders `PS> `). */
  private shellPrompt(name: string): string {
    return name === 'pwsh' ? 'PS> ' : '$ '
  }

  /**
   * Render one expanded tool card's body. When the runner wired a presenter,
   * the body follows the tool's own render intent (presentResult): a read
   * card shows numbered lines plus the relativized path and total line
   * count, a search card groups matches by file and marks truncation, a
   * terminal card shows the output and exit status, and a diff card shows
   * the LCS-aligned, clustered diff (capped in the default view, full when
   * the card was explicitly expanded). Without a view the raw result text
   * renders, diff-colored when it looks like one; a diff-card call whose
   * result carried no view reuses the call-time diff so the block never
   * collapses (kimi parity).
   * @param card - the card container to fill.
   * @param message - the tool message.
   * @param explicitlyExpanded - whether the user expanded this card by hand.
   */
  private renderToolBody(
    card: Container,
    message: Extract<TranscriptMessage, { kind: 'tool' }>,
    explicitlyExpanded: boolean,
  ): void {
    // Workflow run cards: the body is the run's member tree, grouped by phase
    // in arrival order (Web WorkflowRunPanel parity). Rows render even while
    // the run is still streaming (members land incrementally).
    if (message.name === 'workflow' && message.members !== undefined) {
      const groups = new Map<string, NonNullable<Extract<TranscriptMessage, { kind: 'tool' }>['members']>>()
      for (const member of message.members) {
        const key = member.phase ?? ''
        const list = groups.get(key)
        if (list === undefined) groups.set(key, [member])
        else list.push(member)
      }
      for (const [phase, members] of groups) {
        if (phase !== '') card.addChild(new Text(color.textMuted(`  ${phase}`), 0, 0))
        for (const member of members) {
          const mark = member.status === 'ok'
            ? color.success('•')
            : member.status === 'error'
              ? color.error('✗')
              : color.primary('●')
          const statusText = member.status === 'ok'
            ? 'completed'
            : member.status === 'error'
              ? 'failed'
              : 'running'
          card.addChild(new Text(`  ${mark} ${member.label} — ${color.textDim(statusText)}`, 0, 0))
        }
      }
      return
    }
    // Running: surface the pending call's salient raw input when the tool
    // offered one (e.g. a background job id); edit/write calls render their
    // call-time diff (old_string → new_string / the written content) right
    // away instead of an empty body.
    if (message.status === 'running') {
      const callView = this.present?.call(message.name, message.args)
      if (callView !== undefined) {
        if (callView.card === 'diff' && callView.diffs.length > 0) {
          this.renderDiffBody(card, callView.diffs, explicitlyExpanded)
          return
        }
        // A terminal call (bash/pwsh) shows its command row right away (the
        // tool's own presentCall carries it as the card title), so an
        // expanding card never loses the command while it runs.
        if (callView.card === 'terminal') {
          this.addTerminalCommandRow(card, callView.title, this.shellPrompt(message.name))
          return
        }
        if (callView.card === 'generic' && (callView.rawInput !== undefined || (callView.content?.length ?? 0) > 0)) {
          // Keep the command row above the presenter's raw input (a no-op
          // for non-terminal tools, so generic cards are unchanged).
          this.addTerminalCommandRow(card, this.terminalCommand(message.name, message.args), this.shellPrompt(message.name))
          if (callView.rawInput !== undefined) {
            for (const line of genericRawInputLines(message.name, callView.rawInput)) {
              card.addChild(new Text(color.textDim(line), 0, 0))
            }
          }
          // UI-facing content blocks (plan/exit_plan_mode carry the plan
          // body here): text blocks render verbatim, others as pretty JSON.
          for (const block of callView.content ?? []) {
            if (block.type === 'text') card.addChild(new Text(color.textDim(block.text), 0, 0))
            else card.addChild(new Text(color.textDim(JSON.stringify(block, null, 2)), 0, 0))
          }
          return
        }
      }
      // No presenter view (or no presenter-specific case): bash/pwsh still
      // surface the command from the raw args (the folded card's preview
      // source), so the expanded card keeps the command row in every wiring.
      this.addTerminalCommandRow(card, this.terminalCommand(message.name, message.args), this.shellPrompt(message.name))
      return
    }
    // A settled ask_user_question renders its answered-count summary, never
    // the raw `{"answers":[…]}` JSON the tool's render text carries (Web
    // AskQuestionRow parity — the questions themselves were already shown in
    // the question flow, so the card only summarizes the outcome). A
    // cancelled/aborted flow shows the structured error identity instead.
    // This branch precedes the empty-result early return so a cancelled flow
    // (which carries an error and an empty result) still renders its verdict.
    if (message.name === 'ask_user_question') {
      if (message.error !== undefined) {
        card.addChild(new Text(color.textDim(`${message.error.name}: ${message.error.code}`), 0, 0))
        return
      }
      const summary = message.status === 'ok' ? askAnswersSummary(message.result) : undefined
      if (summary !== undefined) {
        card.addChild(new Text(color.textDim(summary), 0, 0))
        return
      }
      // Unparseable or failed: fall through to the generic presentation.
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
          // The result view carries output + exit only; the command comes
          // from the raw args (kimi ShellExecution parity: the command row
          // stays visible when the card expands).
          this.addTerminalCommandRow(card, this.terminalCommand(message.name, message.args), this.shellPrompt(message.name))
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
          this.renderDiffBody(card, resultView.diffs, explicitlyExpanded)
          return
        }
        case 'web': {
          // Web WebBlock parity: the structured retrieval (search sources /
          // fetch URL + status) replaces the raw result text.
          for (const line of webCardLines(resultView)) {
            card.addChild(new Text(color.textDim(line), 0, 0))
          }
          return
        }
        case 'generic': {
          // A generic result view with UI-facing content (plan review) shows
          // that content instead of the raw model-facing result text.
          const content = resultView.content ?? []
          if (content.length > 0) {
            for (const block of content) {
              if (block.type === 'text') card.addChild(new Text(color.textDim(block.text), 0, 0))
              else card.addChild(new Text(color.textDim(JSON.stringify(block, null, 2)), 0, 0))
            }
            return
          }
          break
        }
        default:
          break
      }
    }
    // No completed view (e.g. replay metadata absent): a diff-card call
    // reuses its call-time diff, so the block shown while running stays put
    // instead of collapsing to raw text (kimi parity).
    if (resultView === undefined) {
      const callView = this.present?.call(message.name, message.args)
      if (callView !== undefined && callView.card === 'diff' && callView.diffs.length > 0) {
        this.renderDiffBody(card, callView.diffs, explicitlyExpanded)
        return
      }
    }
    // Generic fallback: the raw result text dimmed (diffs keep their own
    // + / − colors, which already distinguish them from assistant output).
    // A read card without a presenter still renders its envelope as numbered
    // lines (never the raw XML); a merged group card renders one tree row per
    // file (kimi ReadGroup parity).
    if (message.name === 'read') {
      const envelopes = parseReadEnvelopes(message.result)
      if (envelopes.length > 0) {
        if (envelopes.length === 1) {
          const envelope = envelopes[0] as (typeof envelopes)[number]
          for (const line of envelope.lines) {
            card.addChild(new Text(color.textDim(`  ${line.number} │ ${line.text}`), 0, 0))
          }
          if (envelope.path !== '') {
            card.addChild(new Text(color.textMuted(`  path: ${relativizeToCwd(envelope.path, this.workspaceRoot)}`), 0, 0))
          }
          if (envelope.totalLines !== undefined) {
            card.addChild(new Text(color.textMuted(`  total lines: ${envelope.totalLines}`), 0, 0))
          }
        } else {
          envelopes.forEach((envelope, index) => {
            const branch = index === envelopes.length - 1 ? '└─' : '├─'
            const count = envelope.totalLines ?? (envelope.lines.length > 0 ? envelope.lines.length : undefined)
            card.addChild(new Text(color.textDim(
              `  ${branch} ${relativizeToCwd(envelope.path, this.workspaceRoot)}${count === undefined ? '' : ` · ${count} lines`}`,
            ), 0, 0))
          })
        }
        return
      }
    }
    if (isDiffResult(message.name, message.result)) {
      for (const line of renderDiffLines(message.result)) {
        card.addChild(new Text(line, 0, 0))
      }
    } else {
      // Bash/pwsh keep the `$ command` row above the raw output even
      // without a presenter (the folded card's preview source).
      this.addTerminalCommandRow(card, this.terminalCommand(message.name, message.args), this.shellPrompt(message.name))
      // With result blocks available, render with the Web's resultText
      // semantics (text verbatim, non-text as pretty JSON); otherwise the
      // joined text is the only material.
      const blocks = message.resultBlocks ?? []
      const lines = blocks.length > 0
        ? resultTextLines(blocks, message.status === 'error' ? { name: 'error', code: 'tool' } : undefined)
        : [message.result]
      for (const line of lines) {
        card.addChild(new Text(color.textDim(line), 0, 0))
      }
    }
  }

  /**
   * Fill a tool card with a diff body: LCS-aligned clustered lines, capped
   * at {@link DIFF_PREVIEW_LINES} in the default recent-turn view and full
   * when the card was explicitly expanded (kimi parity).
   * @param card - the card container to fill.
   * @param diffs - the diff hunks.
   * @param explicitlyExpanded - explicit expansion disables the cap.
   */
  private renderDiffBody(card: Container, diffs: readonly FileDiff[], explicitlyExpanded: boolean): void {
    for (const line of renderDiffView(diffs, this.workspaceRoot, {
      maxLines: explicitlyExpanded ? undefined : DIFF_PREVIEW_LINES,
    })) {
      card.addChild(new Text(line, 0, 0))
    }
  }

  /** Request a render on the active screen. Public so in-place submenu
   * components (async content swaps) can trigger the next frame. `force`
   * bypasses the render throttle (used to repaint the autocomplete list on
   * the keystroke's own frame). After a final dispose the request is a
   * benign no-op (M0 stale-generation contract). */
  requestRender(force = false): void {
    if (this.disposed) return
    // Live surface geometry (P1-1): the fork consumes the terminal resize
    // callback internally, so the extension surface slice is refreshed
    // from the CURRENT terminal geometry on every render — a resize lands
    // here on the first repaint after the event.
    this.syncSurfaceGeometry()
    ;(this.fullscreen ?? this.tui).requestRender(force)
  }

  /** Mirror the live terminal geometry into the extension surface slice
   * (width/height) when it changed; also refreshes focusedSeat from the
   * current mode. Cheap: no-op unless a value differs. */
  private syncSurfaceGeometry(): void {
    const host = this.extensionHost
    if (host === undefined) return
    const current = host.state().surface
    const width = this.terminal.columns
    const height = this.terminal.rows
    const focusedSeat = this.fullscreen !== undefined
      ? this.activeQuestions !== undefined || this.activeApproval !== undefined
        ? 'overlay'
        : 'editor'
      : this.activeQuestions !== undefined || this.activeApproval !== undefined
        ? 'overlay'
        : 'editor'
    if (current.width !== width || current.height !== height || current.focusedSeat !== focusedSeat) {
      host.updateSurface({ width, height, focusedSeat })
    }
  }

  /**
   * Reflect the todo list in the dock summary line: active (non-completed)
   * count and, when the list is non-empty, the first active item's text.
   * @param todos - the latest todo/write snapshot.
   */
  setTodoSummary(todos: readonly TodoItem[]): void {
    this.todoItems = todos
    this.renderDock()
    if (this.todoPanelVisible) this.renderTodoPanel()
    this.syncExtensionState()
  }

  /** Toggle the todo panel between the transcript and the editor. */
  toggleTodoPanel(): boolean {
    this.todoPanelVisible = !this.todoPanelVisible
    this.renderTodoPanel()
    // The dock summary hides while the panel is expanded (it would sit on
    // top of the full list); restore it on collapse.
    this.renderDock()
    this.requestRender()
    return this.todoPanelVisible
  }

  /** Whether the todo panel is currently shown. */
  isTodoPanelVisible(): boolean {
    return this.todoPanelVisible
  }

  /**
   * Rebuild the todo panel text: a border rule + `Todo` title (both indented
   * one cell) plus up to five rows, in_progress first, then pending, then
   * completed (strikethrough).
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
    const width = Math.max(1, this.terminal.columns)
    const border = color.border(` ${'─'.repeat(Math.max(0, width - 2))} `)
    // Title: bold, two-cell indent.
    const title = color.textStrong('  Todo')
    if (ordered.length === 0) {
      this.todoPanel.setText([border, title].join('\n'))
      return
    }
    const lines = ordered.map(todo => {
      const body = todo.status === 'completed' ? `\x1b[9m${todo.content}\x1b[29m` : todo.content
      return `${mark(todo)} ${body}`
    })
    this.todoPanel.setText([border, title, ...lines].join('\n'))
  }

  /** Hide/show thinking entries; the fold state is untouched. */
  toggleThinkingHidden(): boolean {
    this.hideThinking = !this.hideThinking
    this.rebuildMessages()
    return this.hideThinking
  }

  /** The todo summary line text (`☑ N active · first`), or '' when the
   * list is empty or the panel is expanded (the summary would sit on the
   * full list). Shared by renderDock and the extension state mirror
   * (P1-5). */
  private todoSummaryText(): string {
    if (this.todoPanelVisible || this.todoItems.length === 0) return ''
    const active = this.todoItems.filter(todo => todo.status !== 'completed')
    const done = this.todoItems.length - active.length
    const first = active[0]
    const label = first === undefined ? '' : first.content.length > 40 ? `${first.content.slice(0, 40)}…` : first.content
    return [
      done > 0 ? `${done} todo done` : '',
      active.length > 0 ? `${active.length} active` : '',
      label,
    ].filter(part => part !== '').join(' · ')
  }

  /**
   * Mirror the host's live state into the extension SurfaceStateStore (M2):
   * activity counts (working, queue, tasks, agents, todos) and session mode
   * (plan mode, viewer). Called from the setters so extension outlets and
   * subscribers see the same truth the host chrome renders. No-ops without
   * an attached extension host; batch delivery coalesces within a tick.
   */
  private syncExtensionState(): void {
    const host = this.extensionHost
    if (host === undefined) return
    host.updateActivity({
      working: this.working.isActive(),
      queuedCount: this.queueItems.length,
      taskCount: this.dockTasks.length,
      childAgentCount: this.dockAgents.length,
      todoCount: this.todoItems.length,
      // The rendered todo summary (P1-5: the first-party builtin dock item
      // renders it through the public slot API; the host provides the
      // TEXT, the extension owns the presentation). Always written — an
      // empty string CLEARS a previous summary (the store merge is
      // per-field monotonic, so omitting it would leave the stale text).
      todoSummary: this.todoSummaryText(),
    })
    host.updateSession({
      planMode: this.planMode,
      viewerMode: this.viewerMode !== undefined,
      busy: this.working.isActive(),
      turns: this.status.turns,
      steps: this.status.steps,
      ...this.status.model === '' ? {} : { model: this.status.model },
      ...this.status.cwd === '' ? {} : { cwd: this.status.cwd },
      ...this.status.branch === '' ? {} : { branch: this.status.branch },
      ...this.status.permission === undefined ? {} : { permission: this.status.permission },
    })
  }

  /**
   * Rebuild the chrome rows from the CURRENT semantic state (M2). The
   * runner calls this after attaching an extension host, so extension
   * badges/dock/footer content renders immediately; also called after
   * extension invalidations that changed chrome content.
   */
  refreshChrome(): void {
    this.renderHeader()
    this.renderFooter()
    this.renderDock()
    this.renderGoalLine()
    this.requestRender()
  }

  /** Whether thinking entries are currently hidden. */
  isThinkingHidden(): boolean {
    return this.hideThinking
  }

  /** Rebuild the header from base + session title + plan badge + extension
   * badges. Colours are applied AT RENDER TIME from the live palette — the
   * semantic state (plan mode, title) is stored separately, so a theme
   * switch only has to re-run this. */
  private renderHeader(): void {
    const badge = this.planMode ? ` ${color.warning('[plan]')}` : ''
    const viewerBadge = this.viewerMode === undefined ? '' : ` ${color.accent('[viewing subagent]')}`
    const title = this.viewerMode !== undefined
      ? ` · ${color.textMuted(this.viewerMode.label)}`
      : this.sessionTitleText === '' ? '' : ` · ${color.textMuted(this.sessionTitleText)}`
    // Extension header badges append after the host chrome (M2): the host
    // title stays host-owned; badges add semantics like `[plan]`.
    const extensionBadges = this.extensionHost?.headerBadgeText() ?? ''
    this.header.setText(`🐋  dsh-pi-tui${title}${badge}${viewerBadge}${extensionBadges}`)
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
    this.renderDock()
    this.renderGoalLine()
    this.syncExtensionState()
  }

  /**
   * Replace the active background-task list for the footer badge. Non-empty
   * sets arm the ↓/Ctrl+J task-browser trigger.
   * @param tasks - active jobs (id + label + lifecycle status), empty to hide.
   */
  setTasks(tasks: readonly { id: string; label: string; status: string; kind?: string }[]): void {
    this.dockTasks = tasks
    this.tasksActive = tasks.length > 0 || this.dockAgents.length > 0
    this.renderFooter()
    this.syncExtensionState()
  }

  /**
   * Replace the live child-subagent list for the footer badge. Continuable
   * children and foreground one-shot children never register jobs records
   * (AGENTS.md), so they arm the ↓/Ctrl+J trigger through this channel.
   * @param agents - live children (id + label + activity), empty to hide.
   */
  setAgents(agents: readonly { id: string; label: string; activity: string }[]): void {
    this.dockAgents = agents
    this.tasksActive = this.dockTasks.length > 0 || agents.length > 0
    this.renderFooter()
    this.syncExtensionState()
  }

  /** Whether background tasks are active (drives the ↓/Ctrl+J trigger). */
  isTasksActive(): boolean {
    return this.tasksActive
  }

  /**
   * Replace the pending inbox rows for the queue pane: a border rule, one
   * `❯ text` row per message, and a dim hint. An empty queue renders
   * nothing at all.
   * @param items - pending followups/steers, in delivery order.
   */
  setQueueItems(items: readonly QueueItem[]): void {
    this.queueItems = items
    this.renderQueuePane()
    this.syncExtensionState()
  }

  /** Rebuild the queue pane text from the current inbox rows. */
  private renderQueuePane(): void {
    const items = this.queueItems
    if (items.length === 0) {
      this.queuePane.setText('')
      this.requestRender()
      return
    }
    const width = Math.max(1, this.terminal.columns)
    // Panel border rules indent one cell on each side so the boundary never
    // reads as the editor's full-width border.
    const lines = [color.border(` ${'─'.repeat(Math.max(0, width - 2))} `)]
    for (const item of items) {
      // Plugin notices (background-job completions etc.) are NOT steerable:
      // they carry their own ⏳ marker so they never read as user input, and
      // the hint below drops the steer/edit verbs when nothing else is queued.
      const prefix = item.notice === true
        ? `${color.textDim('⏳')} `
        : `${color.accent('❯')} `
      const text = item.text.replace(/\s+/g, ' ').trim()
      const truncated = truncateToWidth(text, Math.max(1, width - visibleWidth(prefix)), '…')
      lines.push(prefix + (item.notice === true ? color.textDim(truncated) : truncated))
    }
    const hasSteerable = items.some(item => item.notice !== true)
    const hint = hasSteerable
      ? 'ctrl+s to steer all · alt+↑ to edit all · /queue for per-item actions'
      : 'job notices deliver after the current task · /tasks to view'
    lines.push(color.textDim(truncateToWidth(`  ${hint}`, Math.max(1, width - 2), '…')))
    this.queuePane.setText(lines.join('\n'))
    this.requestRender()
  }

  /**
   * Replace the editor draft wholesale (the Alt+↑ dequeue path pulls every
   * queued message back into the editor for editing). While the subagent
   * viewer covers the editor, the write goes to the preserved draft.
   */
  setDraft(text: string): void {
    if (this.viewerMode !== undefined) {
      this.draftBeforeViewer = text
      return
    }
    this.editor.setText(text)
    this.requestRender()
  }

  /** The editor's current draft text (the Alt+↑ dequeue merge reads it);
   * while the viewer covers the editor, the preserved draft is returned. */
  getDraft(): string {
    return this.viewerMode !== undefined && this.draftBeforeViewer !== undefined
      ? this.draftBeforeViewer
      : this.editor.getText()
  }

  /**
   * Headless-test hook: current overlay tracking-graph sizes. The graph
   * (overlayHandles / overlayDependents / the active question's suspension)
   * is behaviorally invisible — stale entries only leak memory — so the
   * headless suite asserts its sizes directly (e.g. the fullscreen teardown
   * must leave it empty instead of retaining dead handles).
   */
  overlayGraphState(): { handles: number; dependents: number; suspended: number } {
    return {
      handles: this.overlayHandles.size,
      dependents: this.overlayDependents.size,
      suspended: this.activeQuestions?.suspendedOverlays.size ?? 0,
    }
  }

  /**
   * Rebuild the persistent dock strip above the todo panel: the todo summary
   * as a single dim info line, only while non-empty. No border rule — a full
   * ─ line here visually collides with the editor's own full-width border
   * (user feedback); the summary reads as an info line, and only the
   * EXPANDED todo panel (Ctrl+T) carries a panel border. Background-task and
   * subagent details live in the footer badge and the ↓/Ctrl+J browser ONLY
   * — every fact has exactly one home.
   */
  private renderDock(): void {
    // While the todo panel is expanded the summary would sit directly on
    // top of the full list it summarizes — drop it so the panel's own
    // border rule is the single boundary.
    const extensionDock = this.extensionHost?.dockText() ?? ''
    const summary = this.todoSummaryText()
    const hostLine = summary === '' ? '' : color.textDim(`☑  ${summary}`)
    // With an extension host the FIRST-PARTY builtin dock item renders the
    // todo summary through the public slot API (P1-5); the host renders it
    // directly only when no host is attached (fallback, not a competing
    // registration).
    if (this.extensionHost !== undefined) {
      this.dock.setText(extensionDock)
      this.requestRender()
      return
    }
    this.dock.setText(hostLine)
    this.requestRender()
  }

  /** Rebuild the goal line: `goal ● <objective>` while a goal is set, hidden
   * otherwise (display-only — no verbs yet). */
  private renderGoalLine(): void {
    const goal = this.status.goal
    this.goalLine.setText(goal === undefined || goal === '' ? '' : color.primary(goal))
    this.requestRender()
  }

  /** Footer density presets: full keeps the stats line, compact drops it. */
  private footerPreset: 'full' | 'compact' = 'full'

  /** Set the footer density preset and repaint. */
  setFooterPreset(preset: 'full' | 'compact'): void {
    this.footerPreset = preset
    // Extension footer segments honor the density preset (F-18): low-
    // importance segments drop in compact mode.
    this.extensionHost?.setFooterCompact(preset === 'compact')
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
    // The mode slot (kimi parity): [yolo] flags the no-approval preset, and
    // every other preset badges too — including the default workspace-write —
    // so the effective write scope is always visible in the footer.
    const permissionBadge = this.status.permission === 'danger-full-access'
      ? color.warning('[yolo]')
      : this.status.permission === 'read-only'
        ? color.textMuted('[read-only]')
        : this.status.permission === 'workspace-write'
          ? color.text('[workspace-write]')
          : this.status.permission === 'custom'
            ? color.warning('[custom]')
            : ''
    // One combined badge (kimi splits bash/agent badges; a single badge
    // keeps the ↓ hint in exactly one place): counts both active jobs and
    // live continuable subagents.
    const badgeParts: string[] = []
    if (this.dockTasks.length > 0) {
      badgeParts.push(`${this.dockTasks.length} task${this.dockTasks.length === 1 ? '' : 's'} running`)
    }
    if (this.dockAgents.length > 0) {
      badgeParts.push(`${this.dockAgents.length} agent${this.dockAgents.length === 1 ? '' : 's'}`)
    }
    const taskBadge = badgeParts.length === 0
      ? ''
      : color.primary(`[${badgeParts.join(' · ')}${this.editor.getText().trim() === '' ? ' · ↓ view' : ''}]`)
    const line1 = [
      permissionBadge,
      this.planMode ? color.warning('[plan]') : '',
      // The goal badge moved OUT of the footer into its own line above the
      // editor (goalLine) — the footer keeps only turn/step state.
      this.status.model === '' ? '' : `[${this.status.model}]`,
      taskBadge,
      this.status.cwd,
      this.status.branch === '' ? '' : this.status.branch,
      context,
      // Turn/step counters: the first-party builtin provides them through
      // the extension footer segment (M3 dogfood). The host fallback stays
      // on whenever NO footer segment provides them (F3: a host attached
      // without the builtin — third-party-only or unloaded — must not lose
      // the counters).
      this.extensionHost?.hasFooterSegments() ? '' : `t${this.status.turns}/s${this.status.steps}`,
      // Extension footer segments append after the host status (M2); the
      // host owns ordering/truncation of its own parts, extensions join at
      // the end so host state always reads first.
      this.extensionHost?.footerText() ?? '',
    ].filter(part => part !== '')
    // Line 2: the stats line only; context pressure is the bar on line 1.
    const line2 = this.footerPreset === 'compact' ? '' : this.status.statsLine
    // Host-owned width budget (plan §8.3): the assembled line-1 is
    // truncated to the terminal width so extension segments can never
    // overflow the footer (truncateToWidth is ANSI-safe — it strips
    // styling, measures the visible width, and re-applies the style).
    const width = Math.max(1, this.terminal.columns)
    const line1Text = truncateToWidth(line1.join('  '), width, '…')
    this.footer.setText([dim(line1Text), line2 === '' ? '' : dim(line2)].filter(line => line !== '').join('\n'))
    this.requestRender()
  }

  /**
   * Install slash-command + file-path autocompletion on the editor, plus
   * `@`-file mentions (fd-backed when `fdPath` is provided; a bounded
   * recursive fallback otherwise — see mentions.ts).
   */
  setCommandCompletions(commands: readonly SlashCommand[], cwd: string, fdPath: string | null = null): void {
    this.editor.setAutocompleteProvider(new MentionProvider([...commands], cwd, fdPath))
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
   * Open the task browser overlay (the ↓ / Ctrl+J trigger with an empty
   * editor, and /tasks). Unlike the generic {@link openPicker}, rows carry a
   * status word + start timestamp so the panel can render status dots,
   * right-aligned status/elapsed columns, live counts, and a 1s elapsed
   * tick. Selection calls `onSelect` with the row value and closes; Esc
   * calls `onCancel`.
   * @param items - task rows (see TaskPanelItem).
   * @param onSelect - confirmed row value.
   * @param onCancel - dismissed without a choice.
   * @param options - header/search/sizing configuration.
   * @returns a handle to close the browser or replace its rows (e.g. when
   * jobs change while it is open).
   */
  openTaskBrowser(
    items: readonly TaskPanelItem[],
    onSelect: (value: string) => void,
    onCancel: () => void,
    options: TaskBrowserOptions = {},
  ): TaskBrowserHandle {
    const panel = new TaskBrowserPanel(
      items.map(item => ({ ...item })),
      options.maxVisible ?? 10,
      {
        header: options.header,
        noMatchText: options.noMatchText,
        enableSearch: options.enableSearch,
        initialQuery: options.initialQuery,
      },
      (value) => {
        close()
        onSelect(value)
      },
      () => {
        close()
        onCancel()
      },
      () => this.requestRender(),
    )
    const handle = this.showOverlayOnHost(new Frame(panel), { width: options.width ?? 72, maxHeight: options.maxHeight ?? 24 })
    // One close path: hide the overlay AND stop the panel's 1s elapsed tick
    // (an unref'd interval must still be cleared — the panel is gone).
    // `close` is a `let` declared before the panel callbacks above reference
    // it; it is assigned here, after `handle` exists. The callbacks only
    // fire on later user input, so the late assignment is safe.
    let close: () => void = () => {}
    close = (): void => {
      panel.dispose()
      handle.hide()
    }
    return {
      close,
      setItems: (next: readonly TaskPanelItem[]) => {
        panel.setItems(next.map(item => ({ ...item })))
        this.requestRender()
      },
    }
  }

  /**
   * Open the settings overlay as a SettingsList. The runner supplies the
   * items and reacts to changes/cancellation. Returns a CLOSER so an
   * action-style list (e.g. /subagents' View transcript / Interrupt) can
   * dismiss itself after the action — without it the list stays mounted as
   * a ghost overlay that eats every later key (the /subagents trap).
   * @param items - setting rows.
   * @param onChange - called with (id, newValue) on confirm.
   * @param onCancel - called when the user closes without applying.
   * @returns a function that closes the overlay.
   */
  openSettings(items: SettingItem[], onChange: (id: string, value: string) => void, onCancel: () => void): () => void {
    // SettingsList fires onCancel on Esc/ctrl+c; the overlay must close too,
    // so the cancel callback closes the handle captured after mounting.
    let handle: OverlayHandle | undefined
    // The settings theme is constructed PER OPEN: its cursor is a rendered
    // ANSI string, so a module-level constant would freeze the cursor
    // colour at import time and never follow a live theme switch.
    const settings = new SettingsList(items, 6, settingsListTheme(), onChange, () => {
      handle?.hide()
      onCancel()
    }, { enableSearch: true })
    handle = this.showOverlayOnHost(new Frame(settings), { width: 72, maxHeight: 28 })
    return () => handle?.hide()
  }

  /**
   * Open the live job-output viewer: a titled text panel refreshed by a
   * timer while open (the caller returns the accumulated output each tick;
   * a terminal job's final read is idempotent). Esc closes, `s` fires
   * onStop. Returns a closer (also invoked on Esc).
   * @param options - title, initial body, refresh callback, stop/close hooks.
   */
  openOutputViewer(options: {
    title: string
    initial: string
    refresh: () => string
    onStop?: () => void
    onClose?: () => void
    intervalMs?: number
  }): () => void {
    const panel = new OutputViewerPanel(options.title, options.initial)
    let closed = false
    let timer: NodeJS.Timeout | undefined
    const close = (): void => {
      if (closed) return
      closed = true
      if (timer !== undefined) clearInterval(timer)
      handle.hide()
      options.onClose?.()
    }
    panel.handleInput = (data: string): void => {
      if (matchesKey(data, 'escape')) {
        close()
      } else if (matchesKey(data, 's')) {
        options.onStop?.()
      }
    }
    const handle = this.showOverlayOnHost(new Frame(panel), { width: 88, maxHeight: 24 })
    timer = setInterval(() => {
      if (closed) return
      panel.setBody(options.refresh())
      this.requestRender()
    }, options.intervalMs ?? 1000)
    return close
  }

  /** Switch the active color theme and repaint everything. Every surface
   * re-renders from its semantic state with the NEW palette: header,
   * footer, dock, todo panel, queue pane, busy indicator, messages, and
   * the editor. (Overlays like settings construct their theme per open, so
   * they pick up the new palette on their next render too.) */
  applyTheme(theme: 'dark' | 'light'): void {
    setTheme(theme)
    // Rendered ANSI is baked into cached components: bump the revision so
    // the per-message render cache rebuilds on the next paint.
    this.themeRevision += 1
    // Publish the theme into the surface slice BEFORE the repaint: the
    // outlet refresh reads the revision from the store, so the order
    // matters (F-14 — a theme switch must re-bake extension ANSI).
    this.extensionHost?.updateSurface({ themeId: theme, themeRevision: this.themeRevision })
    this.repaintAllSurfaces()
  }

  /** Apply a resolved custom palette and repaint everything. */
  applyPalette(palette: ColorPalette): void {
    setTheme('custom', palette)
    this.themeRevision += 1
    // Same ordering as applyTheme (F-14).
    this.extensionHost?.updateSurface({ themeId: 'custom', themeRevision: this.themeRevision })
    this.repaintAllSurfaces()
  }

  /** Re-render every palette-dependent surface from its semantic state. */
  private repaintAllSurfaces(): void {
    // The welcome card keeps its OWN render cache (keyed on width): unlike
    // the Text-based surfaces, clearing the messages view never invalidates
    // it, so a theme switch would leave its ANSI-baked borders/text in the
    // OLD palette. Drop the cache here.
    this.welcomeCard.invalidate()
    this.rebuildMessages()
    // Extension outlets re-render with the live palette (theme revision).
    this.extensionHost?.refreshOutlets()
    this.renderHeader()
    this.renderFooter()
    this.renderDock()
    this.renderTodoPanel()
    this.renderGoalLine()
    this.renderQueuePane()
    this.working.refresh()
    this.editor.invalidate()
    this.requestRender()
  }

  /**
   * Query the terminal background (OSC 11) and apply the matching palette,
   * with the kimi detection chain: colour-opt-out environments (NO_COLOR /
   * FORCE_COLOR=0 / CI) stay dark without querying; a terminal that never
   * answers falls back to COLORFGBG (VT100/xterm convention); a terminal
   * with neither leaves the current theme untouched.
   *
   * The query targets the screen that OWNS the terminal input handler (the
   * alt screen in fullscreen mode): a query on the stopped main screen
   * would have its reply swallowed by the alt screen's OSC 11 consumer and
   * time out, silently turning `auto` into a no-op.
   *
   * Concurrent calls COALESCE onto one shared in-flight query — overlapping
   * OSC 11 queries have no sequence ids, so replies would mis-pair by FIFO
   * order. The LATEST {@link AutoDetectOptions.shouldApply} guard is
   * consulted at settle time, so a late result can never override a newer
   * explicit theme choice.
   * @param options.shouldApply - returns false to drop the settled result
   *   instead of applying it (default: always apply).
   */
  async autoDetectTheme(options?: { shouldApply?: () => boolean }): Promise<void> {
    if (themeOptOut() || this.disposed) return
    if (options?.shouldApply !== undefined) this.autoDetectGuard = options.shouldApply
    if (this.autoDetectInFlight === undefined) {
      this.autoDetectInFlight = this.runAutoDetect().finally(() => {
        this.autoDetectInFlight = undefined
        this.autoDetectGuard = undefined
      })
    }
    return this.autoDetectInFlight
  }

  private async runAutoDetect(): Promise<void> {
    const rgb = await this.activeScreen.queryTerminalBackgroundColor({ timeoutMs: 800 })
    if (this.disposed) return
    const guard = this.autoDetectGuard
    const apply = (): boolean => guard === undefined || guard()
    if (rgb !== undefined) {
      if (apply()) this.applyTheme(detectThemeFromBackground(rgb))
      return
    }
    const fromEnv = detectThemeFromColorFgBg()
    if (fromEnv !== undefined && apply()) this.applyTheme(fromEnv)
  }

  /**
   * Follow the terminal's live colour-scheme reports while `following` is
   * true. Enabling sends one DSR 996 query — xterm-class terminals only
   * START reporting after being asked — and reported schemes fan out to the
   * {@link onTerminalThemeChange} listeners (which guard whether to apply,
   * typically against the persisted `auto` preference). Disabling stops
   * tracking. Idempotent.
   * @param following - whether to track and apply live scheme reports.
   */
  trackTerminalTheme(following: boolean): void {
    if (following === this.followingTerminalTheme) return
    this.followingTerminalTheme = following
    if (!following) return
    this.activeScreen.queryTerminalColorScheme({ timeoutMs: 800 })
      .then((scheme) => {
        if (scheme === undefined || !this.followingTerminalTheme) return
        for (const listener of [...this.terminalSchemeListeners]) listener(scheme)
      })
      .catch(() => {})
  }

  /**
   * Register a live terminal-theme listener (colour-scheme reports). The
   * listener is registered on EVERY screen: reports arrive only at the
   * screen that owns the terminal input handler (the alt screen in
   * fullscreen mode), so the registrations never double-fire. The caller
   * guards whether to apply (typically: only while the persisted preference
   * is `auto`).
   * @param listener - receives the detected palette family.
   * @returns a disposer.
   */
  onTerminalThemeChange(listener: (theme: 'dark' | 'light') => void): () => void {
    this.terminalSchemeListeners.add(listener)
    this.refreshSchemeRegistrations()
    return () => {
      this.terminalSchemeListeners.delete(listener)
      this.refreshSchemeRegistrations()
    }
  }

  /** (Re)register the scheme-report fan-out on every screen. */
  private refreshSchemeRegistrations(): void {
    for (const dispose of this.schemeDisposers) dispose()
    this.schemeDisposers = []
    const screens: Array<TuiMainScreen | TuiAltScreen> = [this.tui]
    if (this.fullscreen !== undefined) screens.push(this.fullscreen)
    for (const screen of screens) {
      this.schemeDisposers.push(screen.onTerminalColorSchemeChange((scheme) => {
        for (const listener of [...this.terminalSchemeListeners]) listener(scheme)
      }))
    }
  }

  /**
   * Queue an approval prompt and resolve when the user decides. Requests
   * queue FIFO; only one dialog is on screen at a time. An aborted signal
   * settles the prompt `cancelled` immediately.
   * @param request - the tool, reason, and optional abort signal.
   * @returns the user's decision.
   */
  showApprovalPrompt(request: ApprovalPromptRequest): Promise<ApprovalOutcome> {
    // A disposed surface must never leave the caller hanging: settle
    // cancelled immediately (M0 stale-generation contract — the runner's
    // approval handler may fire during exit teardown).
    if (this.disposed) return Promise.resolve('cancelled')
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
    // Full terminal width (kimi dialog parity): a fixed 60-wide box on a
    // narrow terminal left base-content slivers glued to the border (the
    // "stray characters" report). The Box pads every row to the width, so
    // the frame spans the whole terminal and the base stays covered.
    const width = this.terminal.columns
    const maxHeight = Math.max(8, Math.min(16, this.terminal.rows - 2))
    const contentWidth = Math.max(1, width - 8)
    // Height budget in WRAPPED rows: the dialog must NEVER lose the key
    // hints or the bottom border to the maxHeight slice. The title and the
    // danger banner are width-cropped so each is exactly ONE display row;
    // the hints row wraps naturally and its WRAPPED height is counted
    // (shrunk when the terminal is too small for it). Fixed chrome = 1
    // title + danger + 1 blank spacer + hint rows + 2 Box paddingY
    // (Box(1,1)) + 2 Frame borders — keep in sync with the geometry below.
    const titleShown = truncateToWidth(`Approve ${pending.request.toolName}?`, contentWidth, '…')
    const dangerShown = pending.request.danger === true
      ? truncateToWidth('⚠ DANGEROUS COMMAND — confirm carefully', contentWidth, '…')
      : ''
    const HINTS = '[y] allow once   [n] reject   [esc/ctrl+c] cancel'
    const hintBudget = Math.max(0, maxHeight - (1 + (dangerShown === '' ? 0 : 1) + 1 + 2 + 2))
    const hintShown = capWrappedToHeight(HINTS, contentWidth, hintBudget).text
    const hintWrapped = hintShown === '' ? 0 : wrapTextWithAnsi(hintShown, contentWidth).length
    const chrome = 1 + (dangerShown === '' ? 0 : 1) + 1 + hintWrapped + 2 + 2
    // The reason and the argument preview share what the chrome leaves:
    // BOTH capped by their wrapped height, because a single long line can
    // wrap across many display rows (a raw-line count under-budgets). A cut
    // section ends in a `... N more` marker row that rides inside its
    // budget, so the dialog tells the user what was dropped.
    const reasonBudget = Math.max(0, maxHeight - chrome)
    const reasonRaw = pending.request.reason ?? ''
    const reasonShown = capWrappedToMarker(reasonRaw, contentWidth, reasonBudget).text
    const reasonWrapped = reasonShown === '' ? 0 : wrapTextWithAnsi(reasonShown, contentWidth).length
    const previewBudget = Math.max(0, maxHeight - chrome - reasonWrapped)
    const dialog = new Box(1, 1)
    dialog.addChild(new Text(titleShown, 1, 0))
    if (dangerShown !== '') {
      dialog.addChild(new Text(color.error(dangerShown), 1, 0))
    }
    if (pending.request.arguments !== undefined && pending.request.arguments !== '' && previewBudget > 0) {
      // Preview the first six argument lines; the marker helper owns ALL
      // truncation (a separate 240-char '…' pre-cap left an uncounted cut
      // when the capped string still fit the budget).
      const sixLines = pending.request.arguments.split('\n').slice(0, 6).join('\n')
      const previewShown = capWrappedToMarker(sixLines, contentWidth, previewBudget).text
      if (previewShown !== '') {
        dialog.addChild(new Text(color.textDim(previewShown), 1, 0))
      }
    }
    if (reasonShown !== '') {
      dialog.addChild(new Text(reasonShown, 1, 0))
    }
    dialog.addChild(new Text(' ', 1, 0))
    dialog.addChild(new Text(hintShown, 1, 0))
    pending.handle = this.showOverlayOnHost(new Frame(dialog), { width, maxHeight })
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
      this.activeScreen.setFocus(this.editor)
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
    // A disposed surface must never leave the caller hanging: settle
    // rejected immediately (M0 stale-generation contract — the runner's
    // questions provider may fire during exit teardown).
    if (this.disposed) {
      return Promise.reject(cancellationError('question flow cancelled'))
    }
    return new Promise<TuiQuestionAnswer[]>((resolve, reject) => {
      if (questions.length === 0) {
        resolve([])
        return
      }
      const state: QuestionState = {
        flow: new QuestionFlow(
          questions.map(question => ({
            id: question.id,
            question: question.question,
            ...question.header !== undefined ? { header: question.header } : {},
            ...question.detail !== undefined ? { detail: question.detail } : {},
            ...question.options !== undefined ? { options: question.options } : {},
            ...question.multiSelect !== undefined ? { multiSelect: question.multiSelect } : {},
            ...question.intent !== undefined ? { intent: question.intent } : {},
          })),
          (answers) => this.settleQuestions(state, answers),
          () => this.settleQuestions(state, undefined),
        ),
        suspendedOverlays: new Set(),
        resolve,
        reject,
        signal,
      }
      if (signal?.aborted === true) {
        reject(cancellationError('question flow aborted'))
        return
      }
      if (signal !== undefined) {
        const onAbort = (): void => this.abortQuestion(state)
        state.onAbort = onAbort
        signal.addEventListener('abort', onAbort, { once: true })
      }
      // One flow on screen at a time; concurrent requests queue FIFO and
      // show when the active one settles (an overwrite would orphan the
      // first promise forever — its identity guard would refuse to settle).
      if (this.activeQuestions === undefined) {
        this.presentQuestion(state)
      } else {
        this.questionQueue.push(state)
      }
    })
  }

  /** Mount one flow into the editor seat and make it the active one. */
  private presentQuestion(state: QuestionState): void {
    // Set the active flow BEFORE touching overlays: showOverlayOnHost and
    // the suspension bookkeeping branch on it.
    this.activeQuestions = state
    // A question is a logical capturing modal: every visible overlay is
    // suspended (hidden, state intact) until the flow settles — the same
    // stacking rule showOverlayOnHost applies to a new overlay.
    for (const handle of this.overlayHandles) {
      if (!handle.isHidden()) {
        handle.setHidden(true)
        state.suspendedOverlays.add(handle)
      }
    }
    const frame = new QuestionFrame(state.flow, () => this.terminal.rows)
    state.frame = frame
    this.editorSeat.clear()
    this.editorSeat.addChild(frame)
    const screen = this.fullscreen ?? this.tui
    screen.setFocus(frame)
    screen.requestRender()
  }

  /** Abort one flow (its signal fired). The ACTIVE flow settles rejected
   * and the queue advances; a QUEUED flow is removed from the queue and
   * rejected without ever being presented (the settle identity guard
   * would otherwise drop it silently and leave its promise pending). */
  private abortQuestion(state: QuestionState): void {
    if (state.settled === true) return
    if (this.activeQuestions === state) {
      this.settleQuestions(state, undefined)
      return
    }
    state.settled = true
    if (state.onAbort !== undefined && state.signal !== undefined) {
      state.signal.removeEventListener('abort', state.onAbort)
    }
    const index = this.questionQueue.indexOf(state)
    if (index !== -1) this.questionQueue.splice(index, 1)
    state.reject(cancellationError('question flow cancelled'))
  }

  /** Cancel every pending flow: each promise rejects exactly once. */
  private cancelQuestionFlows(): void {
    for (const state of [...this.questionQueue]) this.abortQuestion(state)
    if (this.activeQuestions !== undefined) {
      this.settleQuestions(this.activeQuestions, undefined)
    }
  }

  /** Route a key while a question flow is showing; every key is consumed. */
  private handleQuestionKey(data: string): TuiInputListenerResult {
    const state = this.activeQuestions
    if (state === undefined) return undefined
    state.flow.handleInput(data)
    this.requestRender()
    return { consume: true }
  }

  /** Resolve the question flow with its answers, or reject on cancel/abort. */
  private settleQuestions(state: QuestionState, answers: TuiQuestionAnswer[] | undefined): void {
    if (this.activeQuestions !== state || state.settled === true) return
    state.settled = true
    if (state.onAbort !== undefined && state.signal !== undefined) {
      state.signal.removeEventListener('abort', state.onAbort)
    }
    const next = this.questionQueue.shift()
    if (next !== undefined) {
      // Ownership transfer: the seat and the suspended overlays pass to the
      // next flow directly — the editor and the overlays are NEVER restored
      // between two queued flows (a restore would flash the editor row and
      // reveal overlays that must stay hidden under the question).
      next.suspendedOverlays = state.suspendedOverlays
      state.suspendedOverlays = new Set()
      const frame = new QuestionFrame(next.flow, () => this.terminal.rows)
      next.frame = frame
      this.editorSeat.clear()
      this.editorSeat.addChild(frame)
      this.activeQuestions = next
      const screen = this.fullscreen ?? this.tui
      screen.setFocus(frame)
      screen.requestRender()
      this.settle(state, answers)
      return
    }
    // Final restoration: the editor FIRST, then the suspended overlays — a
    // restored capturing overlay focuses itself through setHidden(false),
    // so the editor must not be re-focused afterwards.
    this.editorSeat.clear()
    this.editorSeat.addChild(this.editor)
    this.activeQuestions = undefined
    const screen = this.fullscreen ?? this.tui
    screen.setFocus(this.editor)
    for (const handle of state.suspendedOverlays) {
      if (this.overlayHandles.has(handle)) handle.setHidden(false)
    }
    state.suspendedOverlays.clear()
    screen.requestRender()
    this.settle(state, answers)
  }

  /** Resolve or reject the settled promise (exactly once, by construction). */
  private settle(state: QuestionState, answers: TuiQuestionAnswer[] | undefined): void {
    if (answers === undefined) {
      state.reject(cancellationError('question flow cancelled'))
    } else {
      state.resolve(answers)
    }
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
