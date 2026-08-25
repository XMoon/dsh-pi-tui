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
  Markdown,
  ProcessTerminal,
  ScrollView,
  SelectList,
  SettingsList,
  Text,
  TuiAltScreen,
  TuiMainScreen,
  VStack,
  getKeybindings,
  isKeyRelease,
  isKeyRepeat,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Editor,
  type Focusable,
  type OverlayHandle,
  type OverlayOptions,
  type SelectListTruncatePrimaryContext,
  type SettingItem,
  type SlashCommand,
  type Terminal,
  type TuiInputListenerResult,
} from '@xmoon76/pi-tui'
import { ImageThumbnail } from './components/media/image-thumbnail.ts'
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
import { isViewerAccessInteractive, resolveViewerAccess, viewerAccessHint, type ViewerAccess } from './tasks-browser.ts'
import { SelectedMarquee } from './marquee.ts'
import type { FileDiff } from '@deepseek-ai/dsh-tools'
import {
  firstLine,
  latestLine,
  parseCallPreview,
  parseReadEnvelopes,
  parseWriteEnvelope,
  parseSkillEnvelope,
  parseImageEnvelope,
  readFoldedPreview,
  writeFoldedPreview,
  skillFoldedPreview,
  imageFoldedPreview,
  relativizeToCwd,
  foldedCallPreview,
  genericRawInputLines,
  subagentModelDisplay,
  resultTextLines,
  askAnswersSummary,
  askAnswersLines,
  goalResultSummary,
  goalResultLines,
  GOAL_TOOL_NAMES,
  foldedResultSummaryFor,
  FOLDED_JSON_RESULT_TOOLS,
  focusToolDisplay,
  systemContextBody,
  toolCardHeader,
  toolEmoji,
  webCardLines,
  type ToolPresenter,
} from './present.ts'
import { TranscriptSearchComponent } from './search.ts'
import { HistoryPanel } from './history-panel.ts'
import type { HistorySearchSource } from './history-search.ts'
import { QuestionFlow } from './question.ts'
import { MentionProvider } from './mentions.ts'
import { recentTurnThreshold, textWithImageMarkers, type TranscriptMessage, type TurnActivity } from './transcript.ts'
import { FocusActivityComponent, projectFocus, type FocusProjectedBlock } from './focus-activity.ts'
import { WorkingIndicator } from './working.ts'
import { indeterminateProgressFrames } from './progress.ts'
import { cancellationError, type OwnedTaskOptions } from './detached.ts'
import { safeErrorMessage } from './error-boundary.ts'
import type { SurfaceHost } from './extension/internal/surface-host.ts'
import { InputRouter } from './input-router.ts'
import {
  isLocalShellCard,
  localShellHiddenMarker,
  localShellPreview,
  RUNNING_PREVIEW_LINES,
  SETTLED_PREVIEW_VISUAL_ROWS,
} from './local-shell-card.ts'
import { RESERVED_HOST_KEYS } from './keybinding-registry.ts'
import type { RendererRegistry } from './renderer-registry.ts'
import { OverlayBroker } from './overlay-broker.ts'
import { EditorSeatHolder } from './editor-seat-holder.ts'
import { TuiEditor } from './tui-editor.ts'
import type { EditorRegistry } from './editor-registry.ts'
import { compileView } from './extension/internal/component-compiler.ts'
import { AdvancedOverlayComponent } from './extension/internal/advanced-overlay.ts'
import { UnstableMountedComponentAdapter } from './extension/internal/unstable-mount.ts'
import { normalizeInputEvent } from './extension/internal/input-events.ts'
import type { ExtensionView, MessagePresentationSnapshot, ToolPresentationSnapshot } from './extension/public-types.ts'

/** How many most-recent turns Ctrl+O expands; mirrors pi's default. */
export const EXPAND_RECENT_TURNS = 3

/** Fullscreen Focus anchoring (plan §8.6): the collapsed Thought's header
 * lands one row below the viewport top so the previous context row stays
 * visible above it. Used on the COLLAPSE direction; the EXPAND direction
 * follows the end (plan supplement: the default view after expansion is
 * the latest content). */
export const FOCUS_ANCHOR_TOP_PADDING = 1

/** Whether a message is a Focus SECONDARY disclosure: a foldable process
 * card inside an expanded Thought that has its own compact/full two-state
 * renderer (plan §10). Shared by the render rule and the click handler —
 * never two different foldable sets. */
function isFocusSecondaryDisclosure(message: TranscriptMessage): boolean {
  return message.kind === 'thinking'
    || message.kind === 'tool'
    || message.kind === 'system'
    || message.kind === 'compaction'
}

/** The compaction lifecycle phase the working row advertises: idle (no
 * compaction), summarizing (compaction/start seen, the summary is being
 * generated), or applying (the summary landed, the compacted surface is
 * being committed). Derived by the runner from compaction/start →
 * compaction/summary → compaction/end (foldCompactionEvent). */
export type CompactionPhase = 'idle' | 'summarizing' | 'applying'

/** The indeterminate progress-bar frames shown while a compaction runs:
 * width 12 / block 3, the same visual weight as the footer context bar. */
const COMPACTION_PROGRESS_FRAMES = indeterminateProgressFrames()
/** Folded preview lines for tool results; mirrors pi's RESULT_PREVIEW_LINES. */
export const RESULT_PREVIEW_LINES = 3
/** Diff-body cap for default-view tool cards; mirrors kimi COMMAND_PREVIEW_LINES. */
export const DIFF_PREVIEW_LINES = 10
/** Folded bash-command preview lines (kimi parity: the command stays visible). */
export const FOLDED_COMMAND_LINES = 3
/** Folded diff preview rows (header + cap + footer; kimi COMMAND_PREVIEW_LINES scale). */
export const FOLDED_DIFF_LINES = 4
/**
 * Tools whose result is a structured XML envelope (read/write/read_image/
 * skill). Each has its own parser branch in the folded-card logic; this
 * set is the DEFENSIVE backstop: if a future envelope tool is added
 * without its parser, its raw `<…>` result never leaks into the folded
 * preview. Register new envelope tools here AND add their parser branch.
 */
export const XML_ENVELOPE_RESULT_TOOLS: ReadonlySet<string> = new Set(['read', 'write', 'read_image', 'skill'])

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
    this.lastTermColumns = width
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

  /** The terminal width the last render used (a resize changes wrapping and
   * the flow's hit map, so clicks must wait for a fresh render too). */
  get termColumns(): number {
    return this.lastTermColumns
  }

  get focused(): boolean {
    return this.flow.focused
  }

  set focused(value: boolean) {
    this.flow.focused = value
  }

  private lastTermColumns = 0
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
 * A paper-thin Component adapter over a picker's SelectList (review P2):
 * the vendored SelectList only fires onSelectionChange for ↑↓/PageUp/
 * PageDown — typing into the search box re-filters WITHOUT a selection
 * change, so a long selected label would keep marqueeing mid-cycle inside
 * the new filter instead of restarting from a fresh anchor. The adapter
 * intercepts handleInput, detects a search-query change (the vendored
 * getFilter() is the truth — a query edit is the ONLY input that moves
 * it), and resets the marquee. Zero fork divergence: the SelectList
 * itself is untouched, this wraps it on the consumer side.
 */
class MarqueeFilterAdapter implements Component {
  private readonly list: SelectList
  private readonly onFilterChange: () => void

  constructor(list: SelectList, onFilterChange: () => void) {
    this.list = list
    this.onFilterChange = onFilterChange
  }

  invalidate(): void {
    this.list.invalidate()
  }

  handleInput(data: string): void {
    const before = this.list.getFilter()
    this.list.handleInput(data)
    // A search-query edit re-filters the list: the selected row (whatever
    // it is now) must restart its marquee cycle from a fresh anchor. Keys
    // that do not move the query (arrows, Enter, Esc, Tab) leave it
    // untouched — their selection moves are handled by onSelectionChange.
    if (this.list.getFilter() !== before) {
      this.onFilterChange()
    }
  }

  render(width: number): string[] {
    return this.list.render(width)
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
 * The COMPACT Thinking disclosure card, WIDTH-AWARE (the unified
 * disclosure model, plan §4/§13): the `▸ Thinking` title, the latest
 * reasoning line as the preview and the owner hint are truncated AT
 * RENDER TIME to the CURRENT terminal width. The message component cache
 * deliberately does NOT key on width — a terminal resize keeps the same
 * component, and this card re-derives its rows per render (the same
 * live-child pattern as BulletedComponent), so:
 *   - a wide → narrow resize truncates every row to the new width and
 *     the fixed three-row geometry never wraps (the stale-build trap:
 *     Text wraps its pre-truncated text at the new width and inflates
 *     the block);
 *   - a narrow → wide resize restores the full-width preview instead of
 *     freezing the old narrow truncation.
 * The EMPTY entry renders the bare title — never a fake "No reasoning"
 * row (plan §13.3). The output is REFERENCE-STABLE per width: the same
 * component + same width returns the same array instance, so steady
 * frames keep the fork's per-frame processed-line reuse.
 */
export class ThinkingCompactComponent implements Component {
  private readonly message: Extract<TranscriptMessage, { kind: 'thinking' }>
  private readonly hint: ExpandHint
  private cached: string[] | undefined
  private cachedWidth = -1

  constructor(message: Extract<TranscriptMessage, { kind: 'thinking' }>, hint: ExpandHint) {
    this.message = message
    this.hint = hint
  }

  invalidate(): void {
    this.cached = undefined
    this.cachedWidth = -1
  }

  render(width: number): string[] {
    if (this.cached !== undefined && this.cachedWidth === width) return this.cached
    const previewLine = latestLine(this.message.text)
    let lines: string[]
    if (previewLine === '') {
      // An existing block with no text yet (a very short streaming /
      // replay edge): the bare title — never a fake "No reasoning" row.
      lines = [truncateToWidth(color.textDim('▸ Thinking'), Math.max(1, width), '…')]
    } else {
      const hintVerb = this.hint ?? 'ctrl+o'
      lines = [
        truncateToWidth(color.textDim('▸ Thinking'), Math.max(1, width), '…'),
        truncateToWidth(color.textDimItalic(`  ${previewLine}`), Math.max(1, width), '…'),
        truncateToWidth(color.textDim(`  (${hintVerb} to expand)`), Math.max(1, width), '…'),
      ]
    }
    this.cached = lines
    this.cachedWidth = width
    return lines
  }
}

/**
 * User-message bubble: the whole row is painted with the role background
 * (dsh-web `--dsw-specific-bubble` parity — user input is a floating
 * block, NOT a text colour, so it never collides with the assistant's
 * brand-blue whale or kimi's amber), the ❯ marker leads the FIRST line in
 * the role colour, and wrapped continuation lines indent under it with the
 * background kept across the row.
 *
 * The child stays LIVE (a resize re-wraps at the new width — the 5a76526
 * rule) and the prefixed output is REFERENCE-STABLE like BulletedComponent:
 * same child array + same width → same prefixed array, so the fork's
 * per-frame processed-line reuse keeps hitting on steady frames.
 */
export class UserBubbleComponent implements Component {
  private readonly child: Component
  private readonly marker: string
  private readonly markerWidth: number
  private readonly bg: (text: string) => string
  private lastChild: string[] | undefined
  private lastWidth = -1
  private cached: string[] | undefined

  constructor(child: Component, marker: string, bg: (text: string) => string) {
    this.child = child
    this.marker = marker
    this.markerWidth = visibleWidth(marker)
    this.bg = bg
  }

  invalidate(): void {
    this.child.invalidate?.()
  }

  dispose(): void {
    this.child.dispose?.()
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - this.markerWidth)
    const child = this.child.render(inner)
    if (child === this.lastChild && width === this.lastWidth && this.cached !== undefined) {
      return this.cached
    }
    this.lastChild = child
    this.lastWidth = width
    const indent = ' '.repeat(this.markerWidth)
    this.cached = child.map((line, index) => {
      const prefix = index === 0 ? this.marker : indent
      // Pad to the full row so the bubble background covers the whole
      // line, wrapped continuation rows included.
      const pad = ' '.repeat(Math.max(0, inner - visibleWidth(line)))
      return this.bg(prefix + line + pad)
    })
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

/** The subagent viewer address: the exact direct parent + the child, the
 * catalog mode, the store activity, and the SURFACE authority. The mode
 * is the child's DURABLE semantic; the access is the CURRENT viewer
 * authority (plan §6.10) — a depth-1 continuable child is interactive,
 * everything else is read-only from this surface (a nested descendant
 * belongs to its exact parent, never to the root). The parent session id
 * pins the follow-up write path (the DSH continuation contract requires
 * the EXACT live direct parent Agent; the UI never guesses the parent
 * from the current live agent). */
export interface SubagentViewerTarget {
  /** The durable direct-parent session id authorizing the child. */
  readonly parentSessionId: string
  /** The durable child session id (stable across activations). */
  readonly childSessionId: string
  /** The child's durable creation label (display). */
  readonly label: string
  /** Catalog classification: `continuable` opens an interactive viewer,
   * `one-shot` stays read-only. NEVER derived from activity. */
  readonly mode: 'one-shot' | 'continuable'
  /** Store snapshot activity (running = live record, inactive = persisted
   * only). Display-only; it is NOT the success/failure of anything. */
  readonly activity: 'running' | 'inactive'
  /** The viewer's interaction authority (plan §6.10): mode is the durable
   * semantic, access is what THIS surface may do. `interactive-direct-child`
   * enables the follow-up editor; `readonly-one-shot` and `readonly-nested`
   * lock it (the mode is still displayed truthfully — a nested continuable
   * child is never relabeled one-shot). Absent = derived from the mode
   * (continuable → interactive-direct-child, one-shot → readonly-one-shot);
   * a nested row's caller must pass `readonly-nested` explicitly. */
  readonly access?: ViewerAccess
}

/** A semantic follow-up submit from the interactive subagent viewer: the
 * runner's write path is `ctx.subagents.followup(exactParent, …)`, NEVER
 * the main-session submit/steer/queue path. */
export interface SubagentViewerSubmit {
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly text: string
}

/** The footer override while the subagent viewer is open: the footer shows
 * the VIEWED child's own identity instead of the parent session's (the
 * parent's permission/model/plan/task badges describe a session the user
 * is not looking at). The runner sets this on viewer open, refreshes it as
 * the child's own events fold (turns/steps/stats), and clears it on exit. */
export interface SubagentViewerFooter {
  /** The child's durable creation label. */
  readonly label: string
  /** Catalog classification (the viewer's interactivity). */
  readonly mode: 'one-shot' | 'continuable'
  /** Store snapshot activity (running / inactive). */
  readonly activity: 'running' | 'inactive'
  /** The child session's workspace ('' when unknown, e.g. a cold child). */
  readonly cwd: string
  /** Completed child turns (from the child's OWN event log). */
  readonly turns: number
  /** Child model requests (steps). */
  readonly steps: number
  /** The child's own stats line (formatStats of its event log). */
  readonly statsLine: string
}

/** Base callbacks every TuiApp host must provide; the external-editor
 * pair is bound on top of this (see {@link TuiAppEvents}). */
export interface TuiAppEventsBase {
  /** The user submitted a line in the editor. */
  onSubmit: (text: string) => void
  /**
   * Ctrl+V with image intake (plan M3): the host consumed the key and asks
   * the runner to probe the clipboard — an image lands as a draft
   * placeholder, plain text as an editor insert. Optional; absent keeps
   * the pre-pipeline behavior (the key falls through to the editor).
   */
  onClipboardPaste?: () => void
  /**
   * Whether a submitted line may enter the EDITOR history (both the
   * in-memory recall and the editor's own stack; the runner's persisted
   * JSONL history has its own guard). A multimodal line whose image
   * placeholders die with their drafts must NOT be recalled as text —
   * re-sending it would silently drop the images (review finding).
   * Optional; absent keeps the unconditional behavior.
   */
  shouldRememberInput?: (text: string) => boolean
  /**
   * Whether the current draft references a staged image (the image-only
   * submit gate: an empty-text draft with images is NOT empty). Optional —
   * absent means the draft text is the only emptiness authority.
   */
  isImageDraft?: () => boolean
  /** The user asked to quit (Ctrl+C in the TUI's own raw mode). */
  onExit: () => void
  /** Stop the current activity (busy: a SINGLE Esc fires this directly;
   * idle: a double-Esc within the window fires it when the editor is
   * non-empty — an empty editor opens the rewind picker instead, see
   * {@link onRewind}). The runner's handler interrupts the agent while
   * preserving its queue (web Stop parity). Optional. */
  onCancel?: () => void
  /**
   * Conversation rewind (pi parity): an idle double-Esc within the window
   * with an EMPTY editor asks the host to open the rewind picker (fork the
   * conversation from an earlier user turn). Busy Esc, overlays,
   * autocomplete, replacement editors and a NON-empty draft never reach
   * this (they keep their existing semantics). Optional; absent keeps the
   * historical double-Esc cancel.
   */
  onRewind?: () => void
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
  /**
   * A follow-up submit from the INTERACTIVE subagent viewer (Enter while
   * viewing a `continuable` child): the runner delivers the text through
   * `ctx.subagents.followup(exactLiveParent, childId, …)` — never the
   * main-session submit/steer/queue path. The draft has ALREADY been
   * cleared by the app; the runner restores it (merged) when the delivery
   * is rejected, through the app's viewer-draft API. Optional.
   */
  onSubagentSubmit?: (request: SubagentViewerSubmit) => void
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
  /**
   * M6: a plugin keybinding fired (the InputRouter mapped a normalized
   * key to a SEMANTIC action). The host executes the action through its
   * own paths — the plugin never receives raw input or a live object.
   * Optional.
   */
  onExtensionAction?: (action: import('./extension/public-types.ts').TuiAction) => void
  /** M11: extension callback health transitions from the editor seat. */
  onExtensionError?: (record: { slot: string; id: string; error: unknown }) => void
  onExtensionRecovered?: (record: { slot: string; id: string }) => void
  /**
   * Phase 4: the advanced host-state setTheme for a NON-built-in theme
   * name (a registered plugin theme). The runner resolves the palette
   * through the theme registry and applies it; unknown names are a no-op.
   * Optional.
   */
  onAdvancedSetTheme?: (name: string) => void
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
  /** Mask the free-text row's rendered content (an authorization secret
   *  prompt). The real value stays in the input's memory and is returned
   *  in the answer; only the DISPLAY is bullets, and nothing is logged,
   *  put in history, or shown anywhere else. */
  masked?: boolean
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

/** One category tab of a categorized picker (e.g. /sessions: Main / All /
 * Subagents). Tab cycles the open categories; the active category's header
 * titles the picker. The `items` factory runs on every activation (open,
 * Tab cycle, setItems/refresh), so a caller may read live state (e.g. a
 * title map filled in the background). */
export interface PickerCategory {
  /** Stable id (setCategory target). */
  id: string
  /** Short tab label. */
  label: string
  /** Picker title while this category is active. */
  header: string
  /** Rows for this category, rebuilt on every activation. */
  items: () => readonly PickerItem[]
}

/** Host-internal live state of the open categorized picker (Tab cycling). */
interface CategorizedPickerState {
  /** The category tabs, in cycle order. */
  readonly categories: readonly PickerCategory[]
  /** Index of the active category. */
  index: number
  /** Close the CURRENT overlay (select/cancel/close/abort all funnel here). */
  close(): void
  /** Advance to the next category (Tab), carrying the search query. */
  cycle(): void
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
  /** Phase 4: abort the picker (closes it and fires onCancel). */
  signal?: AbortSignal
  /** Optional category tabs: Tab cycles them while the picker is open. The
   * picker opens on `categories[0]`; the caller's `items` argument is only
   * the initial rows (the first category's factory wins on activation). */
  categories?: readonly PickerCategory[]
  /**
   * Marquee the SELECTED row's primary label when it overflows (plan §7):
   * the label scrolls horizontally cell by cell while selected; every
   * other region (tree connector, current marker, description) stays
   * fixed. Only the selected row animates, at most one timer per picker,
   * disposed on close. `labelPartsOf` splits the presentation prefix
   * (tree connector + current marker) from the marqueeable title so the
   * prefix never scrolls (plan §7.7); `now` injects the clock (tests).
   */
  marquee?: {
    labelPartsOf?: (label: string) => { prefix: string; title: string }
    now?: () => number
  }
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
  /** Row-level action (e.g. `i` = interrupt a subagent). Fires for the
   * selected row while the search box is closed; the row value carries the
   * picker identity (`agent:…` / `job:…`). */
  onAction?: (value: string, action: 'interrupt') => void
}

/** Live control of an open picker. */
export interface PickerHandle {
  /** Close the picker without a selection. */
  close(): void
  /** Replace the rows while the picker is open; the active query re-applies.
   * On a CATEGORIZED picker this re-runs the ACTIVE category's items
   * factory instead (the argument is ignored — the factory reads live
   * state); prefer {@link refresh} there. */
  setItems(items: readonly PickerItem[]): void
  /** Categorized pickers only: re-run the ACTIVE category's items factory
   * (e.g. after background data the factory reads landed). No-op on a
   * plain picker. */
  refresh?(): void
  /** Categorized pickers only: switch to a category by id (re-running its
   * items factory). No-op on a plain picker. */
  setCategory?(id: string): void
  /** Host-internal: drop the abort listener (the imperative select
   * broker's settle path — a settled promise must not retain the
   * listener on the caller's signal). */
  _removeAbortListener?(): void
}

/** Live control of an open task browser (rows carry status/startedAt). */
export interface TaskBrowserHandle {
  /** Close the browser without a selection. */
  close(): void
  /** Replace the rows while the browser is open; the active query
   * re-applies. `preferredValue` is the row the cursor should land on when
   * the user has NOT moved it yet (plan §6.6 — the first running subagent,
   * else the first active job; the tree itself never re-sorts for the
   * cursor). */
  setItems(items: readonly TaskPanelItem[], preferredValue?: string): void
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
  /**
   * The durable-image loader + thumbnail theme (plan M8/M9). When wired,
   * user/assistant/tool-result image blocks render as inline thumbnails
   * (Kitty/iTerm2) with text fallbacks; absent, image blocks render as
   * their flat text only (the surface still works without the pipeline).
   */
  imageLoader?: import('./image/loader.ts').ImageLoader
  imageTheme?: import('./components/media/image-thumbnail.ts').ImageThumbnailTheme
  /** Working-indicator frame interval in ms; injectable so tests stay fast. */
  workingIntervalMs?: number
  /**
   * The extension surface host (M2). When attached, the header/dock/footer
   * renders merge the extension outlets' content (header badges, dock
   * items, footer segments) into the host chrome. Optional — the surface
   * works identically without extensions.
   */
  extensionHost?: SurfaceHost
  /**
   * M6: the plugin keybinding resolver (wired by the runner from the M5
   * KeybindingRegistry). Maps a NORMALIZED key (the InputRouter has
   * already decoded raw terminal input) → a plugin SEMANTIC action —
   * plugins never see raw terminal data. Optional — the surface works
   * identically without it.
   */
  pluginActionFor?: (key: import('./extension/public-types.ts').NormalizedKey) => import('./extension/public-types.ts').TuiAction | undefined
  /** M6: resolves the contribution id for keybinding health diagnostics. */
  pluginActionIdFor?: (key: import('./extension/public-types.ts').NormalizedKey) => string | undefined
  /**
   * M7: the transcript/tool renderer registry (wired by the runner).
   * When present, tool cards and (optionally) messages may be rendered by
   * plugins; the host fallback stays when no renderer produces a view or
   * a renderer throws. Optional — the surface works identically without
   * it.
   */
  renderers?: RendererRegistry
  /**
   * M9: the editor registry (single-winner). When present, a plugin
   * editor may occupy the editor seat through the atomic handoff; the
   * host default editor is the fallback. Optional — the surface works
   * identically without it.
   */
  editorRegistry?: EditorRegistry
  /**
   * Host-owned clipboard strategy for fullscreen drag-selection copy
   * (issue #7). When wired, the alt screen's selection copy routes
   * through this callback (the shared tmux → platform helper → OSC 52
   * policy in src/clipboard.ts) instead of the vendor's raw OSC 52
   * write; the returned boolean drives the `Copied!` / `Copy failed`
   * flash. Optional — absent keeps the vendor's OSC 52 fallback.
   */
  copySelection?: (text: string) => Promise<boolean>
  /**
   * The empty-editor double-Ctrl+C exit window in ms (issue #8);
   * injectable so headless tests never wait the real 1.5s. The footer
   * hint's lifetime is EXACTLY this window — the two share one timer.
   */
  ctrlCExitWindowMs?: number
  /**
   * Phase 2: the ADVANCED normalized input capture route (wired by the
   * runner from the service's advanced registry). Consulted by the host
   * input path AFTER its own capturing flows (questions, approvals,
   * overlays) and reserved lifecycle keys, and BEFORE the editor and the
   * Stable keybindings — an advanced plugin can preempt ordinary
   * editor/panel input, never a Host question/approval/overlay or a
   * fatal-recovery shortcut. Optional — the surface works identically
   * without it.
   */
  advancedInputRoute?: (data: string) => 'consumed' | 'passed'
  /**
   * Phase 3: the UNSTABLE raw input route (wired by the runner from the
   * service's unstable registry). Consulted by the host input path BEFORE
   * terminal protocol decoding — a raw capture can see, consume or rewrite
   * ANY chunk. The returned outcome is applied exactly once (a rewrite
   * goes straight to the host decoder, never re-entering the chain).
   * Optional — the surface works identically without it.
   */
  unstableInputRoute?: (data: string, surfaceId: string) => import('./extension/internal/unstable-input.ts').UnstableRawRouteResult
  /**
   * Phase 3: whether any raw capture is live (the host arms the emergency
   * fail-safe only while captures exist, so the fail-safe never changes
   * ordinary Esc behavior). Optional.
   */
  unstableInputsLive?: () => boolean
  /**
   * Phase 3: the raw capture registry revision (the fail-safe tracker
   * stamps each Esc press with it — a release/re-register bumps the
   * revision, so presses from a previous capture session never count
   * toward a new session's triple-Esc). Optional.
   */
  unstableInputsRevision?: () => number
  /**
   * Phase 3: the Host emergency fail-safe release (wired by the runner to
   * the service's `_unstableEmergencyRelease`). Triggered by the
   * host-owned triple-Esc pattern BEFORE the captures are consulted — it
   * cannot be rewritten or consumed by a capture. Optional.
   */
  unstableFailSafeRelease?: () => void
  /**
   * Ctrl+R input-history search (plan §27): the injected search source. The
   * runner wires the file-backed implementation; the host owns the open/
   * close/refresh/scope/accept lifecycle and never reads the filesystem
   * itself. Optional — absent, Ctrl+R falls through unbound.
   */
  historySearchSource?: import('./history-search.ts').HistorySearchSource
  /**
   * The live working directory the `current` scope resolves against (the
   * runner forwards the session cwd). Fallback: `workspaceRoot`; absent
   * cwd keeps the search scoped to the session root.
   */
  historySearchCwd?: () => string
  /**
   * The live session identity the `session` scope filters by (the runner
   * forwards `liveAgent?.session.id`). A GETTER like `historySearchCwd` —
   * resolved at panel OPEN time, never a snapshot: a session switch must
   * make the next Ctrl+R search the NEW session. Absent (or resolving
   * undefined — no session yet on a deferred start), the panel defaults
   * to the `current` scope and hides the session tab.
   */
  historySearchSessionId?: () => string | undefined
}

/**
 * The interactive surface: header, transcript, editor, footer. Owns the
 * TUI lifecycle, mode switching, folding, approval dialogs, and settings
 * overlay; input routing and rendering decisions live here so they are
 * testable without a real terminal.
 */
/** Parse a tool args/result string as JSON for the semantic snapshot
 * (best-effort: an unparsable raw string is passed through as-is). */
function safeParseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** Deep-freeze a parsed JSON value (round-1 finding 4: the public
 * snapshot contract is deeply immutable — a renderer must never mutate
 * the arguments/result it received, and a mutation must never leak into
 * a later renderer in the same chain). */
function deepFreeze(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item)
    return Object.freeze(value)
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

/** The fold-hint owner of one collapsible card (the thinking-disclosure
 * redesign, plan §12): `click` — fullscreen mouse-owned secondary cards
 * (Thinking included); `ctrl+o` — the ordinary keyboard master
 * (tool/system/compaction); `alt+t` — the Thinking bulk owner (regular);
 * `undefined` — a card that is ALWAYS expanded (regular Focus
 * non-Thinking secondaries, no hint needed). Each disclosure has exactly
 * one bulk owner: Ctrl+O never touches Thinking. */
type ExpandHint = 'click' | 'ctrl+o' | 'alt+t' | undefined

/** One cached component for a transcript message (stage J render cache). */
interface MessageComponentEntry {
  component: Component
  /** The fold boundary the component was built at (Ctrl+O / windowing). */
  boundary: number
  /** The theme revision at build time (colors are baked into the ANSI). */
  themeRev: number
  /** Whether the entry renders expanded (boundary + click override). */
  expanded: boolean
  /** The full-reveal flag (tool bodies / large diffs): per-card override
   * OR any REGULAR expanded root. Part of the cache identity — a
   * Focus toggle must rebuild the diff presentation. */
  fullReveal: boolean
  /** The fold-hint owner: click (fullscreen mouse-owned), ctrl+o (the
   * keyboard master), alt+t (the Thinking bulk owner) or undefined
   * (regular Focus secondaries are always full). Part of the cache
   * identity — a surface switch must not reuse the old hint. */
  expandHint: ExpandHint
  /** The values the component was built from, for O(1) staleness checks:
   * text-bearing kinds compare the CURRENT text object — an unchanged
   * message keeps the same string instance, so the check is O(1) and
   * streaming chunks (which create a new string) reliably miss. */
  text?: string
  /** The full content blocks (user/assistant) the component was built
   * from — an immutable array identity, so a settled image block landing
   * on a text-only component marks it stale (round-1 finding 2). */
  content?: unknown
  /** The tool card's result content blocks identity (review finding 7): a
   * resultBlocks transition to image-bearing content must rebuild the
   * card even when the flattened result text barely changed. */
  resultBlocks?: unknown
  running?: boolean
  label?: string
  summary?: string
  status?: string
  args?: string
  result?: string
  meta?: unknown
  members?: unknown
  error?: { name: string; code: string }
  /** Compaction card facts (kind 'compaction'). */
  items?: number
  tokens?: number
  errorText?: string
  /** M7: the renderer that produced this component, when one did (the
   * cache identity — plan §12.1: a renderer HMR/unload must rebuild). */
  rendererId?: string
  /** M7: the renderer registry revision at build time. */
  rendererRevision?: number
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
  /** The M4 widget zones (extension widgets around the editor seat). */
  private readonly widgetsAbove: Text
  private readonly widgetsBelow: Text
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
  /** Ctrl+O master switch: expand the most recent turns' collapsible
   * entries (the ordinary fold) — and, in REGULAR Focus, the DERIVED
   * reveal of the recent Focus Thoughts (never written into
   * focusExpandedTurns). Fullscreen Focus disclosures are mouse-owned:
   * Ctrl+O does not pierce them. */
  private toolOutputExpanded = false
  /** Alt+T: the ONE Thinking disclosure preference — whether Thinking
   * blocks render FULL (true) or COMPACT with a preview (false). Thinking
   * is never hidden: a block exists whenever the model produced reasoning
   * and the current projection contains it. Shared by Focus ON/OFF and
   * both surfaces; never reset by Focus, fullscreen or session switches
   * (a runtime UI preference, plan §5.3). Per-message overrides (fullscreen
   * clicks, search reveals) layer on top of this bulk default. */
  private thinkingExpanded = false
  /** The latest todo/write snapshot; rendered as a panel when visible. */
  private todoItems: readonly TodoItem[] = []
  /** Ctrl+T: whether the todo panel between transcript and editor is shown. */
  private todoPanelVisible = false
  /** Fullscreen click on the todo panel (or the panel's own expand verb):
   * whether the panel shows the FULL list or the compact five rows. */
  private todoExpanded = false
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

  /**
   * The seat currently owning keyboard focus, derived from the ACTUAL
   * focused capturing surface (follow-up P1): any capturing overlay — not
   * just question/approval — reports 'overlay' while it owns the screen.
   * `none` means nothing captures input (a stopped surface or a focus
   * that belongs to no seat).
   */
  private focusSeat: 'editor' | 'overlay' | 'editor-panel' | 'none' = 'editor'
  /** The seat value the snapshot last published (mutation guard for the
   * microtask-coalesced publish below). */
  private publishedFocusSeat: 'editor' | 'overlay' | 'editor-panel' | 'none' = 'editor'
  /** A focus-seat change publishes through one coalesced microtask so a
   * burst of mount/close calls in one tick delivers ONE snapshot update. */
  private focusSeatPublishScheduled = false
  /** Re-entrancy guard for syncSurfaceGeometry (review finding 4): a
   * resize callback can fire while a width change is already being
   * applied; the nested call is dropped. */
  private syncingSurfaceGeometry = false

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
  /** The Ctrl+R input-history panel, while one is open. */
  private historyPanel: HistoryPanel | undefined
  /** The overlay handle of the history panel (hide() closes it). */
  private historyOverlay: OverlayHandle | undefined
  /** The injected Ctrl+R search source (the runner wires the file-backed
   * implementation; the host never touches the filesystem). */
  private readonly historySearchSource: HistorySearchSource | undefined
  /** The live working directory for the panel's `current` scope — a GETTER
   * (the runner's `sessionCwd()`), never a snapshot: a session switch moves
   * the whole surface's cwd with the new session header, so the panel must
   * resolve the cwd at OPEN time, not at construction time. */
  private readonly historySearchCwd: (() => string) | undefined
  /** The live session identity for the panel's `session` scope — a GETTER
   * (the runner's `liveAgent?.session.id`), never a snapshot: a session
   * switch must make the next Ctrl+R search the NEW session. */
  private readonly historySearchSessionId: (() => string | undefined) | undefined
  /** The open CATEGORIZED picker (e.g. /sessions): Tab cycles its
   * categories while it is open. Cleared when the picker closes. */
  private activeCategorizedPicker: CategorizedPickerState | undefined
  /** M8: the overlay stacking graph (extracted from TuiApp — plan §13).
   * The broker owns the modal-stacking + question-suspension rules; the
   * host keeps the physical screen mounts. */
  private readonly overlayBroker: OverlayBroker
  /** M8: still-owned plugin overlay leases (closed by the final dispose —
   * plan §13.3: leases are generation-scoped). */
  private readonly extensionOverlayLeases = new Set<import('./extension/public-types.ts').TuiOverlayHandle>()
  /** Phase 2: still-owned ADVANCED interactive overlay leases (closed by
   * the final dispose; re-mounted across fullscreen screen swaps). */
  private readonly advancedOverlayLeases = new Set<import('./extension/advanced-types.ts').AdvancedOverlayLease & { _remount(): void; _recompile(): void }>()
  /** Phase 2: the live ADVANCED overlay wrappers (recompiled on terminal
   * resize so the plugin's render(ctx) sees the new geometry). */
  private readonly advancedOverlayWrappers = new Set<import('./extension/internal/advanced-overlay.ts').AdvancedOverlayComponent>()
  /** Phase 2: the ADVANCED normalized input capture route (wired by the
   * runner; consulted after host capturing flows + reserved keys). */
  private readonly advancedInputRoute: ((data: string) => 'consumed' | 'passed') | undefined
  /** Phase 3: the UNSTABLE raw input route (wired by the runner; consulted
   * BEFORE terminal protocol decoding). */
  private readonly unstableInputRoute: ((data: string, surfaceId: string) => import('./extension/internal/unstable-input.ts').UnstableRawRouteResult) | undefined
  /** Phase 3: whether any raw capture is live (arms the fail-safe). */
  private readonly unstableInputsLive: (() => boolean) | undefined
  /** Phase 3: the raw capture registry revision (stale-press invalidation
   * for the fail-safe tracker). */
  private readonly unstableInputsRevision: (() => number) | undefined
  /** Phase 3: the Host emergency fail-safe release (triple-Esc). */
  private readonly unstableFailSafeRelease: (() => void) | undefined
  /** Phase 3: the fail-safe Esc-press stamps (timestamp + capture-session
   * revision; triple-Esc within the window at the SAME revision triggers
   * the release). */
  private unstableEscPresses: { at: number; revision: number }[] = []
  /** Phase 3: still-owned UNSTABLE mount leases (closed by the final
   * dispose; re-mounted across fullscreen screen swaps). */
  private readonly unstableMountLeases = new Set<import('./extension/unstable-types.ts').UnstableMountLease & { _remount(): void }>()
  /** Phase 3: the live UNSTABLE mount adapters (dropped on remount). */
  private readonly unstableMountAdapters = new Set<import('./extension/internal/unstable-mount.ts').UnstableMountedComponentAdapter>()
  /** Phase 3: the UNSTABLE mount lease id counter. */
  private unstableMountCounter = 0
  // M8: the overlay graph (handles/dependents) lives in the broker — the
  // host reads it through the accessors below. The old private sets were
  // removed; every use now goes through this.overlayBroker.
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
  /** Timestamp of the last Esc press, for the IDLE double-Esc cancel (a
   * busy agent cancels on a single Esc — pi parity). */
  private lastEscapeAt: number | undefined
  /** Idle double-Esc window in ms. */
  private static readonly ESCAPE_CANCEL_WINDOW_MS = 400
  /** Footer wrap cap (plan §14): host line-1 wraps to at most 3 physical
   * rows, the stats line to 1, total never above 4 — a long extension
   * segment folds from the tail first. */
  private static readonly FOOTER_MAX_LINES = 4
  /**
   * The agent-busy state pushed by the runner at turn/compaction
   * boundaries (pi parity): while busy, a SINGLE Esc stops the current
   * activity instead of arming the double-Esc cancel.
   */
  private busy = false
  /** Context compaction in flight: the working row shows "Compacting
   * context…" (summarizing) or "Applying compacted context…" (applying)
   * in place of the Working label until the matched compaction/end. */
  private compactionPhase: CompactionPhase = 'idle'
  /** The working row's turn-derived activity (setWorking input). */
  private workingActive = false
  /** Phase 4: the plugin working-message override (advanced host state). */
  private workingMessageOverride: string | undefined
  /** Timestamp of the last Ctrl+C press, for the empty-editor exit chord. */
  private lastCtrlCAt: number | undefined
  /** The empty-editor double-Ctrl+C exit window in ms. A 500ms window
   * silently misses a human-paced double press (0.6–1s apart), which
   * read as "the chord doesn't work"; 1.5s covers a natural double
   * press, and the armed state is announced by the hint. */
  private static readonly CTRL_C_EXIT_WINDOW_MS = 1500
  /** Issue #8: the effective exit window (injectable for tests). */
  private readonly ctrlCExitWindowMs: number
  /** Issue #8: whether the exit chord is armed — the footer's second line
   * shows `Press Ctrl+C again to exit` while armed, and the hint's
   * lifetime is EXACTLY the exit window (one shared timer, never a
   * lingering notify). */
  private ctrlCExitArmed = false
  private ctrlCExitTimer: NodeJS.Timeout | undefined
  /** Session workspace root for path relativization (Web relativizeToCwd). */
  private readonly workspaceRoot: string | undefined
  /** The tool presentation bridge, wired by the runner to the live registry. */
  private readonly present: ToolPresenter | undefined
  /**
   * M6: the plugin keybinding resolver. Maps a RAW input sequence to a
   * plugin SEMANTIC action via the InputRouter's normalization — a plugin
   * never sees raw terminal data, only the normalized key → action. Wired
   * by the runner from the M5 KeybindingRegistry; undefined = no plugin
   * keybindings (the surface runs exactly as before).
   */
  private readonly pluginActionFor: ((key: import('./extension/public-types.ts').NormalizedKey) => import('./extension/public-types.ts').TuiAction | undefined) | undefined
  private readonly pluginActionIdFor: ((key: import('./extension/public-types.ts').NormalizedKey) => string | undefined) | undefined
  /** M6: the host-owned input precedence router (normalization + rules). */
  private readonly inputRouter: InputRouter
  /** M7: the transcript/tool renderer registry (optional). */
  private readonly renderers: RendererRegistry | undefined
  /** M9: the editor registry (optional). */
  private readonly editorRegistry: EditorRegistry | undefined
  /** Issue #7: the host-owned clipboard strategy for fullscreen drag
   * selection (tmux → platform helper → OSC 52); undefined keeps the
   * vendor's raw OSC 52 write. */
  private readonly copySelection: ((text: string) => Promise<boolean>) | undefined
  /**
   * P1-1: the renderer registry revision observed by the LAST render pass.
   * When the registry revision moves (a renderer registered/unloaded —
   * HMR, dynamic registration), the transcript message cache MUST be
   * rebuilt on the next render: the cache identity embeds the revision
   * (componentForMessage), but a plain repaint reuses the old cached
   * components. The check is O(1) per render (revisionOf()), and the
   * rebuild only re-runs renderers for entries whose identity changed.
   */
  private lastRendererRevision = -1
  /** M9: the editor seat holder (the atomic handoff + current occupant). */
  private readonly editorSeatHolder: EditorSeatHolder
  /** The durable-image loader (plan M8): optional, wired by the runner. */
  private readonly imageLoader: import('./image/loader.ts').ImageLoader | undefined
  /** The thumbnail fallback theme (plan M9): optional, wired by the runner. */
  private readonly imageTheme: import('./components/media/image-thumbnail.ts').ImageThumbnailTheme | undefined
  /** The busy indicator row directly above the editor border; idle renders nothing. */
  private readonly working: WorkingIndicator
  /** The fullscreen transcript ScrollView, for click hit-testing offsets. */
  private fullscreenScroll: ScrollView | undefined
  /**
   * Per-message expansion overrides from mouse clicks: a message whose entry
   * is true stays expanded even when the global fold is off; absent falls
   * back to the global boundary. In FULLSCREEN Focus the per-card override
   * IS the secondary disclosure owner (the mouse controls the cards —
   * Ctrl+O does not pierce them); in REGULAR Focus any expanded root
   * full-reveals its non-Thinking process regardless of the fold or the
   * override.
   */
  private readonly expandedOverride = new Map<TranscriptMessage, boolean>()
  /**
   * Focus Mode (plan): the persisted preference is applied through
   * {@link setFocusMode}; while ON, the transcript projection replaces each
   * turn's intermediate activity with a live Thought block (see
   * focus-activity.ts). The WorkingIndicator is NEVER hidden by Focus —
   * the two surfaces are independent (plan §3).
   */
  private focusModeEnabled = false
  /**
   * The user's per-turn Thought disclosures. LIVE running turns are
   * allowed (plan §2.3) and `turn/end` NEVER clears the choice (plan
   * §16.2/Invariant 7); session switches and subagent-viewer scope
   * changes do. Focus off keeps the set but stops consulting it (plan
   * §16.4).
   */
  private readonly focusExpandedTurns = new Set<number>()
  /** The folder's per-turn activities (same fold state as `messages`). */
  private turnActivities: ReadonlyMap<number, TurnActivity> = new Map()
  /** The FocusActivityComponent cache, keyed by turn: rebuilds on the
   * activity revision, the expansion state, the theme revision, or the
   * precomputed Tool display (plan §39). render() still re-reads
   * Date.now() per frame, so the running duration refreshes on the
   * WorkingIndicator's repaint heartbeat. */
  private readonly focusActivityComponents = new Map<number, {
    /** The activity object the component was built from (identity key). */
    activity: TurnActivity
    component: FocusActivityComponent
    revision: number
    expanded: boolean
    themeRev: number
    toolDisplay?: string
  }>()
  /** The parent session's expansion set while the subagent viewer covers
   * the surface (turn numbers are per-session — plan §26). */
  private readonly focusExpansionsStack: Set<number>[] = []
  /**
   * Per-OCCURRENCE image-display collapse overrides from fullscreen clicks:
   * a collapsed attachment occurrence renders its constant info bar
   * (`🖼️ name · W×H · bytes`) only — the image rows collapse, the identity
   * never does. Keyed by message object + the image block's index within
   * `message.content` (the folder's entry objects are stable within one
   * folder lifetime — the same identity the per-message render cache and
   * `expandedOverride` use), so the SAME durable attachment displayed twice
   * collapses independently: clicking "this position's picture" never
   * touches the other occurrence. Absent = expanded. Cleared on session
   * switch with the other click overrides.
   */
  private readonly collapsedOccurrences = new Map<TranscriptMessage, Set<number>>()
  /** Rendered row heights per transcript block, for mouse hit-testing.
   * Message rows carry their message + attachment spans; Focus activity
   * rows carry the activity (the whole collapsed Thought block — and the
   * expanded header — is the toggle hit area, plan §17.1). */
  private messageRows: ReadonlyArray<{
    message?: TranscriptMessage
    activity?: TurnActivity
    height: number
    /** The row span (block-relative) of every attachment's click region. */
    attachments: ReadonlyArray<{ imageIndex: number; start: number; end: number }>
    /** Set ONLY on process rows revealed by an EXPANDED Focus Thought
     * (plan §8.8 / review P2): the fullscreen click handler collapses the
     * owner turn when this is set. The user's own rows and the FINAL
     * assistant never carry it — clicking them must not collapse the
     * Thought. */
    collapseFocusOwnerOnClick?: number
  }> = []
  /** ONE external-editor ownership at a time: set synchronously at launch,
   * cleared in the launch's `finally` (success, failure or cancellation). */
  private externalEditorInFlight = false
  /** The live session's auto-generated title, shown in the header when set. */
  private sessionTitleText = ''
  /** The mode-aware subagent viewer: while set, the editor bar shows the
   * child's draft (continuable) or a read-only placeholder (one-shot),
   * the editor border switches to the accent color, and the header
   * carries a persistent badge — the transient notify line is not the
   * only signal. */
  private viewerMode: SubagentViewerTarget | undefined
  /** The MAIN session's real draft, preserved while the viewer covers the
   * editor bar (restored on exit). Never written by viewer editing. */
  private mainDraftBeforeViewer: string | undefined
  /** Per-child unsent drafts (`childSessionId → text`): isolated from the
   * main draft, retained across viewer open/close cycles. */
  private subagentDrafts = new Map<string, string>()
  /** Bumped on every viewer open / close / child switch. Async viewer-
   * bound work (follow-up sends) captures it at start and refuses to
   * touch the surface once it changed. */
  private viewerGeneration = 0
  /** While the subagent viewer is up, the footer shows the viewed child's
   * own identity (label/mode/activity/turns/stats) instead of the parent
   * session's status — set/cleared by the runner on viewer open/close.
   * Viewer mode is host-owned chrome: extension footer segments (main-
   * session semantics) do not render while it is set. */
  private viewerFooter: SubagentViewerFooter | undefined

  constructor(terminal: Terminal, events: TuiAppEvents, options: TuiAppOptions = {}) {
    // The external-editor capability is a BOUND pair: the Ctrl+G flow
    // routes through the owned-task entry, so an editor hook without the
    // runner would silently swallow the key. The type union already
    // forbids it at compile time; this catches runtime violations (plain
    // JS hosts, casts) loudly instead of failing silently.
    if (events.openExternalEditor !== undefined && events.runOwned === undefined) {
      throw new Error('openExternalEditor requires runOwned (the owned-task entry — AGENTS.md)')
    }
    // Resize-aware terminal wrapper (follow-up P1): the fork consumes the
    // terminal's resize callback INTERNALLY (its own requestRender), so
    // `app.requestRender` — where syncSurfaceGeometry lives — never fires
    // on a resize. The wrapper captures the onResize hook at start() and
    // funnels it through the app's geometry mirror, so a width change
    // re-bakes the width-budgeted outlets (dock/footer) and re-merges the
    // chrome immediately instead of keeping the old segment set baked at
    // the stale width.
    //
    // Receiver fidelity (review finding 3): callable members are bound to
    // the TARGET — `this.terminal` consumers (both TuiMainScreen and
    // TuiAltScreen) and any captured-method callback must observe the
    // implementation's own `this`, never the Proxy receiver. Getter-only
    // members (columns/rows) read through the target.
    const resizeAware: Terminal = new Proxy(terminal, {
      get: (target, prop, receiver) => {
        if (prop === 'start') {
          return (onInput: (data: string) => void, onResize: () => void): void => {
            target.start(onInput, () => {
              // The app may be disposed before the terminal stops.
              if (!this.disposed) this.syncSurfaceGeometry()
              onResize()
            })
          }
        }
        const value = Reflect.get(target, prop, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    this.terminal = resizeAware
    this.events = events
    this.extensionHost = options.extensionHost
    // F-17: an invalidation batch re-bakes the outlets; the host then
    // re-merges its chrome rows so the new content reaches the screen.
    this.extensionHost?.setChromeRefresher(() => this.refreshChrome())
    this.notifyDurationMs = options.notifyDurationMs ?? TuiApp.NOTIFY_DURATION_MS
    this.ctrlCExitWindowMs = options.ctrlCExitWindowMs ?? TuiApp.CTRL_C_EXIT_WINDOW_MS
    this.workspaceRoot = options.workspaceRoot
    this.present = options.present
    this.pluginActionFor = options.pluginActionFor
    this.pluginActionIdFor = options.pluginActionIdFor
    this.advancedInputRoute = options.advancedInputRoute
    this.unstableInputRoute = options.unstableInputRoute
    this.unstableInputsLive = options.unstableInputsLive
    this.unstableInputsRevision = options.unstableInputsRevision
    this.unstableFailSafeRelease = options.unstableFailSafeRelease
    this.inputRouter = new InputRouter(RESERVED_HOST_KEYS)
    this.renderers = options.renderers
    this.editorRegistry = options.editorRegistry
    this.copySelection = options.copySelection
    this.overlayBroker = new OverlayBroker({
      question: () => this.activeQuestions,
      setFocusSeat: (seat) => this.setFocusSeat(seat),
    })

    this.tui = new TuiMainScreen(resizeAware)
    // The host default editor is the TuiEditor subclass: kimi parity for
    // `@dir/` mention completion (Tab-accepting a directory reopens the
    // dropdown at its children; Esc closes it without re-triggering).
    this.editor = new TuiEditor(this.tui, editorTheme)
    this.editorBorder = this.editor.borderColor
    this.editor.onSubmit = (text) => {
      // DEFENSE IN DEPTH: the app-level guard consumes Enter while a
      // continuable viewer is up, so the host editor's own onSubmit never
      // fires there — but a replacement editor's submit routes through
      // submitDraft anyway, and this branch keeps a stray host submit from
      // ever landing in the PARENT session while viewing. Viewer
      // submissions are deliberately NOT remembered in the shared editor
      // history: an ↑ recall in the MAIN editor would otherwise resend a
      // child-scoped follow-up to the parent.
      const target = this.viewerMode
      if (target !== undefined && isViewerAccessInteractive(resolveViewerAccess(target.mode, target.access))) {
        this.clearNotify()
        this.events.onSubagentSubmit?.({
          parentSessionId: target.parentSessionId,
          childSessionId: target.childSessionId,
          text,
        })
        return
      }
      this.rememberInput(text)
      // Fresh user input supersedes any transient notice (a stale error
      // from the previous submission must not outlive the next one).
      this.clearNotify()
      // Issue #8: a successful submit is a fresh explicit action — the
      // armed exit chord (and its footer hint) must not survive.
      this.clearCtrlCExit()
      this.events.onSubmit(text)
    }
    this.editor.onChange = () => {
      // The footer's task badge advertises the ↓ browser ONLY while the
      // editor is empty; the editor mutates without going through
      // setStatus, so keep the badge truthful while tasks are active.
      if (this.tasksActive) this.renderFooter()
      // The visible editor IS the child draft while a continuable viewer
      // is up: mirror every change into the per-child slot (the runner's
      // restore and stale guards read the slot, not the live component).
      const viewer = this.viewerMode
      if (viewer !== undefined && isViewerAccessInteractive(resolveViewerAccess(viewer.mode, viewer.access))) {
        this.subagentDrafts.set(viewer.childSessionId, this.seatEditor().getText())
      }
      // P1-11: every HOST-driven editor mutation notifies the seat
      // holder's subscribers (the fork Editor's own typing/editing flows
      // through onChange — the plugin subscription protocol must observe
      // host-driven draft/cursor changes).
      this.editorSeatHolder.notifyChanged()
    }
    // M9: the editor seat holder — the atomic handoff + current occupant.
    // The host default editor is the adapter source; a plugin editor
    // (single-winner from the editor registry) can replace it.
    this.imageLoader = options.imageLoader
    this.imageTheme = options.imageTheme
    this.historySearchSource = options.historySearchSource
    // Keep the GETTER: the cwd must be resolved at panel-open time (a
    // session switch changes `sessionCwd()` — see the field doc).
    this.historySearchCwd = options.historySearchCwd
    // Same for the session identity: a session switch must make the next
    // Ctrl+R search the NEW session (see the field doc).
    this.historySearchSessionId = options.historySearchSessionId
    this.editorSeatHolder = new EditorSeatHolder({
      hostAdapter: () => this.hostEditorAdapter(),
      surfaceId: `tui-${Date.now().toString(36)}`,
      generation: () => this.generation,
      // Round-2 P1: a plugin editor's invalidate() recompiles its view and
      // swaps the child in the seat (the M4 compiler caches at
      // construction — a live plugin view needs a recompile to repaint).
      viewSwap: (component) => {
        if (this.disposed) return
        this.editorSeat.clear()
        this.editorSeat.addChild(component)
        this.requestRender()
      },
      actionSink: (action) => {
        // The sink routes through the HOST-OWNED paths (round-1 finding
        // 2): submit/queue-submit go through submitDraft (history +
        // notify clear + seat draft clear, exactly like a normal Enter),
        // steer through the host steer, external editor through the
        // owned entry. The plugin never bypasses submission/session
        // safety.
        switch (action) {
          case 'submit': {
            const text = this.seatEditor().getText()
            if (text.trim() === '') return false
            this.submitDraft(false)
            return true
          }
          case 'queue-submit': {
            const text = this.seatEditor().getText()
            if (text.trim() === '') return false
            this.submitDraft(true)
            return true
          }
          case 'steer': {
            const text = this.seatEditor().getText()
            this.seatEditor().setText('')
            this.editorSeatHolder.notifyChanged()
            this.events.onSteer?.(text)
            return true
          }
          case 'open-external-editor': {
            if (this.events.openExternalEditor === undefined || this.externalEditorInFlight) return false
            this.events.runOwned('external editor', () => this.launchExternalEditor(), {
              onError: (error: unknown) => {
                this.notify(`external editor failed: ${safeErrorMessage(error)}`, 'error')
              },
            })
            return true
          }
        }
      },
      notifyError: (message) => this.notify(`editor failed: ${message}`, 'error'),
      recordError: (id, message) => {
        try { this.events.onExtensionError?.({ slot: 'editor', id, error: message }) } catch {}
      },
      clearError: (id) => {
        try { this.events.onExtensionRecovered?.({ slot: 'editor', id }) } catch {}
      },
    })
    // M9: the editor seat holder's host adapter + view swap were built
    // above; the seat child mounts later (editorSeat is created below).
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
    // The M4 widget zones: bounded rows above and below the editor seat,
    // fed by the extension widget outlets. Host-owned Text components — a
    // plugin can never touch the editor seat or the root layout.
    this.widgetsAbove = new Text('', 0, 0)
    this.widgetsBelow = new Text('', 0, 0)
    this.editorSeat = new Container()
    this.editorSeat.addChild(this.editor)
    // If a plugin editor already won the registry (registration before
    // the surface), hand off immediately. MUST run after editorSeat
    // exists — the handoff re-mounts the seat child (mountSeatChild
    // clears/refills this.editorSeat).
    this.reconcileEditorWinner()
    // The working row sits between the todo panel and the editor seat so it
    // is always the row directly above the editor border (pi's
    // statusContainer). The widget zones sit directly around the editor
    // seat: above between the working row and the seat, below between the
    // seat and the footer.
    this.tui.addChild(this.header)
    this.tui.addChild(this.messagesView)
    this.tui.addChild(this.dock)
    this.tui.addChild(this.todoPanel)
    this.tui.addChild(this.goalLine)
    this.tui.addChild(this.queuePane)
    this.tui.addChild(this.working)
    this.tui.addChild(this.widgetsAbove)
    this.tui.addChild(this.editorSeat)
    this.tui.addChild(this.widgetsBelow)
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
    // Issue #8: the exit-chord timer dies with the surface — a stopped
    // TUI must never fire a stale disarm into a dead footer.
    this.clearCtrlCExit()
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
    this.disposeMessageComponents()
    this.localMessages.length = 0
    for (const lease of this.extensionOverlayLeases) lease.close()
    this.extensionOverlayLeases.clear()
    // Phase 2: close every still-owned ADVANCED interactive overlay lease
    // (the wrappers die with the surface; the plugin's dispose() runs).
    for (const lease of this.advancedOverlayLeases) lease.close()
    this.advancedOverlayLeases.clear()
    this.advancedOverlayWrappers.clear()
    // Phase 3: close every still-owned UNSTABLE mount lease (the adapters
    // die with the surface; the plugin's dispose() runs).
    for (const lease of this.unstableMountLeases) lease.close()
    this.unstableMountLeases.clear()
    this.unstableMountAdapters.clear()
    // Phase 4: settle every still-open imperative broker promise (select/
    // custom) — the picker/overlay dies with the surface; the promises
    // must not hang.
    for (const settle of [...this.pendingBrokerSettles]) settle()
    this.pendingBrokerSettles.clear()
    this.overlayBroker.clear()
    // The transcript-search overlay dies with the surface: stale handles
    // must never focus() or repaint a dead component.
    this.searchOverlay = undefined
    this.searchComponent = undefined
    // The Ctrl+R history panel dies with the surface: its in-flight search
    // is aborted (a late result must never touch a dead component).
    this.historyPanel?.dispose()
    this.historyPanel = undefined
    this.historyOverlay = undefined
    this.status = { model: '', cwd: '', branch: '', turns: 0, steps: 0, statsLine: '' }
    // Detach the extension surface host: its subscriptions and capability
    // set die with the surface (M2 stale-generation contract).
    this.extensionHost?.dispose()
    // P1-12: the editor seat holder's FINAL disposal — every host
    // capability a plugin editor captured (replaceText, dispatch,
    // subscribe, invalidate) becomes inert; a late plugin callback can no
    // longer mutate the seat or dispatch a real submission.
    this.editorSeatHolder.dispose()
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

  /**
   * M6: normalize raw terminal input to the public key identity (the ONLY
   * key shape a plugin ever sees). Returns undefined for protocol
   * artifacts (Kitty press/repeat/release), paste bursts and multi-char
   * input.
   * @param data - the raw terminal data.
   */
  normalizeKey(data: string): import('./extension/public-types.ts').NormalizedKey | undefined {
    // Protocol artifacts are filtered by the router FIRST (plan §11.2):
    // press/repeat/release events never reach plugin code.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined
    return this.inputRouter.normalize(data)
  }

  /**
   * P1-5: normalize raw terminal input into a SEMANTIC editor input event
   * (the ONLY input shape a plugin editor ever sees — never raw terminal
   * bytes). Terminal protocol decoding (legacy + Kitty CSI-u +
   * modifyOtherKeys encodings) happens HERE in the host; a plugin editor
   * behaves identically on every terminal.
   *
   * Classification:
   * - bracketed paste (`\x1b[200~...\x1b[201~`, the fork re-wraps pastes
   *   this way) → `{ kind: 'paste', text }`;
   * - one key press (parseKey resolves legacy/CSI-u/modifyOtherKeys) →
   *   `{ kind: 'key', key: NormalizedKey }`;
   * - a plain printable run (multi-char chunk that is not a single key) →
   *   `{ kind: 'text', text }`;
   * - anything else (unparseable control sequences) → undefined (the host
   *   keeps it; a plugin editor never sees it).
   */
  private editorInputEventOf(data: string): import('./extension/public-types.ts').EditorInputEvent | undefined {
    // Phase 2: ONE shared classification (extension/internal/input-events.ts)
    // serves the editor channel, the advanced captures and the advanced
    // interactive components — never two decoders that can drift.
    return normalizeInputEvent(data)
  }

  /**
   * P1-5: route one raw input through a REPLACEMENT editor as a SEMANTIC
   * event. The replacement hook receives {@link EditorInputEvent} — never
   * raw terminal bytes (the host decoded the protocol in
   * editorInputEventOf). Returning true CONSUMES the event (the plugin
   * owns it); the seat adapter already isolates a throwing handler (the
   * plugin can never crash the host input path).
   *
   * When the replacement DECLINES the event:
   * - `forceEscapeRoute` (the Esc pre-route): return undefined so the
   *   caller's post-if host fallback runs (overlay Esc handling and the
   *   host's own single-Esc arming mint on re-entry);
   * - otherwise (the route.kind === 'editor' branch): the declined event
   *   is retried against plugin keybindings first (editorReplacement is
   *   flipped off so a binding may claim it), then Enter submits through
   *   the normal host path, and only then does the HOST EDITING fallback
   *   run — the vendored Editor at the replacement's current text/cursor,
   *   with the resulting draft/cursor copied back into the visible
   *   replacement (the P1-5 contract).
   */
  private handleReplacementEditorInput(
    data: string,
    context: Parameters<InputRouter['route']>[1],
    forceEscapeRoute: boolean,
  ): TuiInputListenerResult {
    const replacement = this.seatEditor().handleInput
    if (replacement === undefined) return undefined
    const event = this.editorInputEventOf(data)
    if (event === undefined) return undefined
    if (replacement(event)) return { consume: true }
    if (forceEscapeRoute) return undefined
    // Declined regular editor input: retry against plugin bindings only
    // after the replacement editor has explicitly handed it back.
    const retry = this.inputRouter.route(data, { ...context, editorReplacement: false }, (key) => this.pluginActionForFor(key))
    if (retry.kind === 'plugin-action') {
      try {
        this.events.onExtensionAction?.(retry.action)
        this.recoverKeybinding(retry.key)
      } catch (error) {
        this.reportKeybindingError(retry.key, error)
      }
      return { consume: true }
    }
    if (matchesKey(data, 'enter') && !matchesKey(data, 'shift+enter')) {
      this.submitDraft(false)
      return { consume: true }
    }
    // ExtensionEditor's false result follows the public contract: let the
    // vendored host editor process the event at the replacement's current
    // text/cursor, then copy the result back into the visible seat. The
    // replacement remains the owner of the draft; the host is only the
    // editing-semantics fallback for this one declined event.
    this.editorSeatHolder.handleHostFallbackInput(data)
    return { consume: true }
  }

  /** Resolve a normalized key through the runner's resolver (M6). */
  private pluginActionForFor(key: import('./extension/public-types.ts').NormalizedKey): import('./extension/public-types.ts').TuiAction | undefined {
    try {
      return this.pluginActionFor?.(key)
    } catch (error) {
      this.reportKeybindingError(key, error)
      return undefined
    }
  }

  private keybindingIdFor(key: import('./extension/public-types.ts').NormalizedKey): string | undefined {
    try {
      return this.pluginActionIdFor?.(key)
    } catch {
      return undefined
    }
  }

  private reportKeybindingError(key: import('./extension/public-types.ts').NormalizedKey, error: unknown): void {
    try {
      const id = this.keybindingIdFor(key)
      if (id === undefined) return
      this.events.onExtensionError?.({ slot: 'keybinding', id, error })
    } catch {
      // Diagnostics are observational and must never escape the input path.
    }
  }

  private recoverKeybinding(key: import('./extension/public-types.ts').NormalizedKey): void {
    try {
      const id = this.keybindingIdFor(key)
      if (id === undefined) return
      this.events.onExtensionRecovered?.({ slot: 'keybinding', id })
    } catch {
      // Diagnostics are observational and must never escape the input path.
    }
  }

  /** Shared key routing: questions, then approval, then folding/mode/cancel/exit. */
  private handleInput(data: string): TuiInputListenerResult {
    // Phase 3: the UNSTABLE raw interception stage — BEFORE terminal
    // protocol decoding (plan §4). A raw capture can see, consume or
    // rewrite ANY chunk (Enter, Esc, Ctrl+C, paste, CSI-u, terminal-
    // specific protocols). The Host emergency fail-safe is detected FIRST
    // (host-owned, not rewritable by the Unstable API): triple-Esc within
    // the window releases every raw capture and closes every unstable
    // mount, restoring Host input. The fail-safe is armed only while
    // captures are live, so ordinary Esc behavior is unchanged otherwise.
    if (this.unstableInputRoute !== undefined) {
      if (this.unstableInputsLive?.() !== true) {
        // No captures are live: the fail-safe is disarmed — drop any
        // stale Esc stamps (hygiene; the revision stamp already
        // invalidates them on the next registration).
        this.unstableEscPresses = []
      } else if (this.unstableFailSafe(data)) {
        try {
          this.unstableFailSafeRelease?.()
        } catch {
          // The release is Host recovery; a throwing release must never
          // escape the input path.
        }
        this.notify('unstable captures released (emergency fail-safe)', 'info')
        return { consume: true }
      }
      const outcome = this.unstableInputRoute(data, this.extensionHost?.surfaceId ?? 'tui')
      if (outcome.action === 'consume') return { consume: true }
      if (outcome.action === 'rewrite') {
        // The rewritten chunk flows through the host's OWN processing AND
        // propagates to the focused component (the fork's listener-result
        // `data` field). Each terminal chunk passes the interception chain
        // at most once: the rewrite goes straight to the host decoder and
        // never re-enters the raw stage (handleInputCore has no raw
        // stage).
        const result = this.handleInputCore(outcome.data)
        if (result === undefined) return { data: outcome.data }
        return result
      }
    }
    return this.handleInputCore(data)
  }

  /** The host's own input precedence ladder (the raw stage has already
   * run — see {@link handleInput}). */
  private handleInputCore(data: string): TuiInputListenerResult {
    // Kitty-protocol terminals report press, repeat, and release events as
    // separate sequences; the app must act on the PRESS only. A release of
    // Ctrl+O would otherwise double-toggle the fold (press expands, release
    // collapses — a single press would appear to do nothing), and a release
    // of Esc would trip the double-Esc cancel. The framework already filters
    // releases for the focused component; listeners are on their own.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined
    // The double-Esc window is a CONSECUTIVE-press chord: any real
    // non-Esc key press between the two Esc presses disarms it (review
    // E12 — `Esc → Left → Esc` must not rewind). Releases/repeats already
    // returned above, so only genuine presses reach this line.
    if (!matchesKey(data, 'escape')) this.lastEscapeAt = undefined
    if (this.activeQuestions !== undefined) {
      return this.handleQuestionKey(data)
    }
    if (this.activeApproval !== undefined) {
      return this.handleApprovalKey(data)
    }
    // The subagent viewer input policy is MODE-AWARE:
    // - one-shot: read-only — every key except Esc (exit) and Ctrl+O (the
    //   viewed transcript still folds) is inert — no typing into the
    //   placeholder bar, no Enter submit, no Ctrl+S steer, no ↓ browser;
    // - continuable: the editor is LIVE (typing falls through to it), but
    //   Enter submits to the SUBAGENT (never the parent) and every
    //   parent-owned lifecycle key is consumed here, BEFORE the host
    //   ladder, so the viewer can never steer/queue/dequeue the parent
    //   session or exit the TUI from inside the child view.
    if (this.viewerMode !== undefined && !this.activeScreen.hasOverlayEntries) {
      const viewer = this.viewerMode
      if (!isViewerAccessInteractive(resolveViewerAccess(viewer.mode, viewer.access))) {
        if (!matchesKey(data, 'escape') && !matchesKey(data, 'ctrl+o')) {
          return { consume: true }
        }
      } else if (matchesKey(data, 'enter') && !matchesKey(data, 'shift+enter')) {
        this.submitSubagentDraft()
        return { consume: true }
      } else if (this.viewerParentLockedKey(data)) {
        return { consume: true }
      }
      // Esc (exit) and Ctrl+O (fold) fall through to the host ladder.
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
    // A categorized picker (e.g. /sessions) owns Tab while it is open:
    // cycle to the next category. Checked BEFORE the overlay guard — Tab
    // must not fall through to the focused picker component.
    if (matchesKey(data, 'tab') && this.activeCategorizedPicker !== undefined) {
      this.activeCategorizedPicker.cycle()
      return { consume: true }
    }
    // A managed non-search overlay owns the focused component. App-level
    // lifecycle handlers must not consume its keys before pi-tui dispatches
    // them to that component.
    if (this.activeScreen.hasOverlayEntries) return undefined
    // Ctrl+R input-history search (host-reserved lifecycle key, §29): the
    // overlay guard above keeps the key with any active overlay/question/
    // approval/viewer (plan §28/§30); with nothing up, the host opens the
    // history panel. Unbound (no historySearchSource): falls through to the
    // editor like any un-reserved key. The continuable subagent viewer keeps
    // its OWN live editor — plan §30 M1 restricts Ctrl+R to the MAIN editor,
    // so the chord is a no-op there (never the child draft, never the parent
    // draft): the viewer's parent-owned chords already consume Enter etc.
    if (matchesKey(data, 'ctrl+r') && this.historySearchSource !== undefined
      && this.viewerMode === undefined) {
      this.openHistorySearch()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+shift+f') || matchesKey(data, 'ctrl+f')) {
      this.startTranscriptSearch()
      return { consume: true }
    }
    // P1-10: a PLUGIN editor occupying the seat receives editor-routed input
    // before plugin keybindings. Enter remains host-owned: forward it through
    // the hidden host editor so active autocomplete gets its normal confirm /
    // submit semantics before the resulting draft is synchronized back. The
    // plugin editor never receives host-owned Enter; Shift+Enter stays with
    // the plugin (its own multiline editing).
    if (this.seatEditor().handleInput !== undefined
      && matchesKey(data, 'enter') && !matchesKey(data, 'shift+enter')) {
      this.editorSeatHolder.handleHostFallbackInput(data)
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
    if (matchesKey(data, 'alt+k')) {
      // Dismiss settled local shell cards (Alt+K — plan §5.4 quick clear):
      // completed `!`/`!!` runs leave the live view; running cards never
      // do (the process is NOT cancelled — Esc owns that). Overlays keep
      // the key for themselves like the other Alt chords.
      if (this.activeScreen.hasOverlayEntries) return undefined
      this.dismissSettledLocalShell()
      this.requestRender()
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
      const text = this.seatEditor().getText()
      if (text.trim() === '') return undefined
      this.rememberInput(text)
      this.clearNotify()
      this.seatEditor().setText('')
      this.editorSeatHolder.notifyChanged()
      // Consumed at the app level: request the frame ourselves (the
      // stale-clear trap — see the Ctrl+C branch).
      this.requestRender()
      this.events.onQueueSubmit(text)
      return { consume: true }
    }
    if (matchesKey(data, 'escape')) {
      // Overlays (pickers, settings) own Esc while they are up.
      if (this.activeScreen.hasOverlayEntries) return undefined
      // Autocomplete owns Esc while the dropdown is open: let the editor
      // close it (TuiEditor intercepts; kimi parity). Without this the
      // app-level consume swallows Esc and the dropdown cannot close.
      // Capability-detected: a REPLACEMENT editor with its own dropdown
      // gets the same pass-through (its focused component handles Esc).
      if ((this.seatEditor() as { isShowingAutocomplete?: () => boolean }).isShowingAutocomplete?.() === true) {
        return undefined
      }
      // P1-6: a REPLACEMENT editor owns Esc for its own modal state
      // machine (vim normal-mode entry) — route it through the editor
      // channel below instead of the host's double-Esc cancel. If the
      // plugin DECLINES it, the editor route hands it back to the host
      // fallback (which includes this cancel path on re-entry).
      if (this.seatEditor().handleInput !== undefined) {
        return this.handleReplacementEditorInput(data, this.inputRouterContext(), true)
      }
      // The host may consume the first Esc (runner-owned modes like the
      // subagent viewer); otherwise it arms the double-Esc cancel.
      if (this.events.onSingleEscape?.() === true) return { consume: true }
      // pi parity: a SINGLE Esc while the agent is busy stops the current
      // activity (turn, tool run, compaction) — partial content stays on
      // screen. Idle keeps the double-Esc cancel.
      if (this.busy) {
        this.lastEscapeAt = undefined
        this.events.onCancel?.()
        return { consume: true }
      }
      const now = Date.now()
      if (this.lastEscapeAt !== undefined && now - this.lastEscapeAt < TuiApp.ESCAPE_CANCEL_WINDOW_MS) {
        this.lastEscapeAt = undefined
        // Conversation rewind (pi parity): an EMPTY editor opens the rewind
        // picker; a non-empty draft keeps the historical cancel semantics —
        // a half-written draft is never dragged into a rewind (plan Case C).
        // A host without rewind keeps the cancel for both cases.
        if (this.seatEditor().getText().trim() === '' && this.events.onRewind !== undefined) {
          this.events.onRewind()
        } else {
          this.events.onCancel?.()
        }
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
    if (matchesKey(data, 'ctrl+v')) {
      // Clipboard paste with image intake (plan M3): with a host handler
      // the key is consumed and the runner probes the clipboard once — an
      // image becomes a draft placeholder and plain text falls back to an
      // editor insert. WITHOUT a handler the key falls through to the
      // editor exactly like the pre-pipeline behavior (round-1 finding 6).
      if (this.events.onClipboardPaste === undefined) return { consume: false }
      this.events.onClipboardPaste()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+t')) {
      // Todo panel toggle (kimi semantics; Ctrl+T never reaches the editor).
      this.toggleTodoPanel()
      return { consume: true }
    }
    if (matchesKey(data, 'alt+t')) {
      // Alt+T = the Thinking DETAIL bulk owner (never hide/show): every
      // Thinking block collapses or expands together, Focus ON/OFF and
      // both surfaces alike. Per-message overrides are cleared first so
      // the result is predictable (plan §9).
      this.toggleThinkingExpanded()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+s')) {
      // Steer: send the draft into the running turn and clear the editor.
      // An empty draft still fires the event — the runner steers every
      // queued message when the queue is non-empty, and only ignores the
      // key when there is nothing to send at all.
      if (this.activeScreen.hasOverlayEntries) return { consume: true }
      const draft = this.seatEditor().getText()
      this.seatEditor().setText('')
      this.editorSeatHolder.notifyChanged()
      // Consumed at the app level: request the frame ourselves (the
      // stale-clear trap — see the Ctrl+C branch).
      this.requestRender()
      this.events.onSteer?.(draft)
      return { consume: true }
    }
    if (matchesKey(data, 'down')) {
      // Task browser: with active background tasks and an EMPTY editor, ↓
      // opens the task list (nothing to move the cursor through). With text
      // present the key keeps its editing meaning; overlays own it. (The
      // former Ctrl+J chord is gone: legacy terminals send Ctrl+J as LF,
      // which the editor treats as Enter — the key was unreliable, and ↓
      // plus `/tasks` remain the two entries.)
      if (this.tasksActive && !this.activeScreen.hasOverlayEntries && this.seatEditor().getText().trim() === '') {
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
      // pi parity (handleCtrlC): a first press CLEARS a non-empty editor
      // (recording the time); a second press within the window on the now
      // EMPTY editor exits. Overlays own the key (the global overlay guard
      // above already passed them through). Issue #8: every arm shows the
      // footer hint for EXACTLY the exit window (armCtrlCExit), and the
      // exit path disarms it — the hint never outlives the window.
      const text = this.seatEditor().getText()
      if (text !== '') {
        this.seatEditor().setText('')
        this.editorSeatHolder.notifyChanged()
        this.armCtrlCExit()
        // The key is CONSUMED at the app level, so the fork's input path
        // never reaches the focused editor and never requests its own
        // frame — without an explicit render the cleared draft stays on
        // screen until the next keypress (the stale-clear trap, seen in
        // tmux: the editor reads empty but the old text is still
        // visible). Same pattern as setDraft/submitDraft.
        this.requestRender()
        return { consume: true }
      }
      const now = Date.now()
      if (this.lastCtrlCAt !== undefined && now - this.lastCtrlCAt < this.ctrlCExitWindowMs) {
        this.clearCtrlCExit()
        this.events.onExit()
      } else {
        // First press on an EMPTY editor changes nothing visible, and the
        // exit window is easy to miss — announce the armed state so a
        // slow second press is not a silent no-op (the next Enter would
        // otherwise send an empty draft). The second press within the
        // window exits.
        this.armCtrlCExit()
      }
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+d')) {
      // Ctrl+D quits like /exit (and Ctrl+C). The editor's delete-char-
      // forward remains on the Delete key. Issue #8: an armed exit chord
      // must not leave its hint behind on a Ctrl+D exit.
      this.clearCtrlCExit()
      this.events.onExit()
      return { consume: true }
    }
    // M6: the router first determines whether a capturing path owns the key.
    // A replacement editor gets the first chance for editor-routed input;
    // only an explicit decline is eligible for a plugin binding. The host
    // editor keeps the normal last-stage plugin binding behavior.
    const context = this.inputRouterContext()
    const replacement = this.seatEditor().handleInput
    // A generic managed overlay owns the focused component. Do not probe the
    // seat editor or plugin bindings here; returning undefined lets pi-tui
    // dispatch the raw key to the overlay component (including reserved keys).
    if (context.hasOverlay) return undefined
    // Phase 2: the ADVANCED normalized captures (plan §5/§11). Consulted
    // AFTER the host's own capturing flows (questions, approvals, overlays)
    // and reserved lifecycle keys, BEFORE the editor and the Stable
    // keybindings — an advanced plugin can preempt ordinary editor/panel
    // input, but never a Host question/approval/overlay or a fatal-recovery
    // shortcut (session safety stays Host-owned). The registry normalizes
    // the raw chunk itself (the shared Host decoder); a consuming capture
    // stops the event here.
    if (this.advancedInputRoute !== undefined && this.advancedInputRoute(data) === 'consumed') {
      return { consume: true }
    }
    const route = this.inputRouter.route(data, context, (key) => this.pluginActionForFor(key))
    if (route.kind === 'protocol') return undefined
    if (route.kind === 'consumed') {
      // A generic overlay is the focused owner. The app listener must not
      // consume its key before pi-tui dispatches to that component; this also
      // lets reserved overlay keys (Esc, Ctrl+Enter, etc.) reach the overlay.
      if (context.hasOverlay) return undefined
      // With the host editor in the seat, a reserved key that was not
      // handled by the app ladder must still reach the fork Editor (notably
      // Enter, whose onSubmit lives on the focused component). A replacement
      // editor has no host onSubmit, so its reserved fallback remains inert.
      return replacement === undefined ? undefined : { consume: true }
    }
    if (replacement !== undefined && (route.kind === 'editor' || route.kind === 'viewer-editor')) {
      return this.handleReplacementEditorInput(data, context, false)
    }
    if ((route.kind === 'editor' || route.kind === 'viewer-editor') && replacement === undefined) {
      // P2-R5: only the HOST seat may forward to the hidden host editor. A
      // display-only replacement editor (no handleInput hook) owns the seat
      // too: the public contract (public-types.ts) says ordinary typing is
      // NOT silently routed into the hidden host editor while it is
      // visible. Consume the key so the focused replacement component (or
      // the app's own listeners) keep it, and the hidden host draft never
      // diverges from what the user sees.
      if (this.seatEditor().id !== 'host') return { consume: true }
      // Leave normal host editing to pi-tui's focused-component dispatch.
      // Returning undefined is important: TuiBase then calls Editor.handleInput
      // and schedules its immediate active-screen repaint. Calling the editor
      // here and returning consume=true would update the draft but skip that
      // framework repaint, making typed characters appear to be swallowed.
      return undefined
    }
    if (route.kind === 'plugin-action') {
      try {
        this.events.onExtensionAction?.(route.action)
          this.recoverKeybinding(route.key)
      } catch (error) {
        this.reportKeybindingError(route.key, error)
      }
      return { consume: true }
    }
    return undefined
  }

  /** The live surface context the InputRouter reads (M6). */
  private inputRouterContext(): Parameters<InputRouter['route']>[1] {
    return {
      questionActive: this.activeQuestions !== undefined,
      approvalActive: this.activeApproval !== undefined,
      // The viewer's input mode: 'readonly' locks the editor (one-shot AND
      // nested — only an interactive direct child edits), 'continuable'
      // keeps it live (the HOST guard already consumed the parent-owned
      // chords before the router is consulted).
      viewerInputMode: this.viewerMode === undefined || this.activeScreen.hasOverlayEntries
        ? 'none'
        : isViewerAccessInteractive(resolveViewerAccess(this.viewerMode.mode, this.viewerMode.access)) ? 'continuable' : 'readonly',
      hasOverlay: this.activeScreen.hasOverlayEntries,
      searchActive: this.searchOverlay !== undefined,
      editorReplacement: this.seatEditor().handleInput !== undefined,
      // P1-06: the focused EDITOR owns its keys. The fork dispatches to
      // app-level listeners BEFORE the focused component, so the router
      // must ask the seat editor directly whether it would consume this
      // input; a plugin binding may only claim a key the editor declines
      // (arrows/Tab/multiline movement stay with the editor while it is
      // focused — never stolen by a plugin binding). The probe asks the
      // fork's GLOBAL keybinding manager whether the raw input matches ANY
      // editor-owned binding (navigation, editing, submit, tab, select) —
      // the exact set the focused Editor consumes. It never executes the
      // editor (no double-handling); a chord the editor has no binding for
      // (e.g. Ctrl+Alt+X) is NOT editor-owned and may fire a plugin
      // binding.
      editorAccepts: (data) => {
        const focused = this.activeScreen.getFocusedComponent()
        if (focused === undefined || focused === null) return false
        if (focused !== this.seatEditor().component) return false
        // The seat editor is focused: it owns every key its binding set
        // defines. (The seat editor's component is either the fork Editor
        // or a plugin editor's compiled view — a plugin editor that wants
        // its own keys must provide a handleInput component; until then
        // the host's keybinding set is the conservative ownership rule.)
        const kb = getKeybindings()
        return [
          'tui.editor.cursorUp', 'tui.editor.cursorDown', 'tui.editor.cursorLeft',
          'tui.editor.cursorRight', 'tui.editor.cursorWordLeft', 'tui.editor.cursorWordRight',
          'tui.editor.cursorLineStart', 'tui.editor.cursorLineEnd', 'tui.editor.pageUp',
          'tui.editor.pageDown', 'tui.editor.jumpForward', 'tui.editor.jumpBackward',
          'tui.editor.historyPrevious', 'tui.editor.historyNext',
          'tui.editor.deleteCharBackward', 'tui.editor.deleteCharForward',
          'tui.editor.deleteWordBackward', 'tui.editor.deleteWordForward',
          'tui.editor.deleteToLineStart', 'tui.editor.deleteToLineEnd',
          'tui.editor.yank', 'tui.editor.yankPop', 'tui.editor.undo',
          'tui.input.newLine', 'tui.input.submit', 'tui.input.tab', 'tui.input.copy',
          'tui.select.up', 'tui.select.down', 'tui.select.pageUp', 'tui.select.pageDown',
          'tui.select.confirm', 'tui.select.cancel',
        ].some(binding => kb.matches(data, binding as never))
      },
    }
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
    // P1-09: never mount on a finally-disposed surface (the plugin lease
    // path guards earlier; this is the last-chance guard for every other
    // caller — a stopped screen's showOverlay would otherwise revive a
    // dead surface's overlay stack).
    if (this.disposed) {
      return { hide: () => {}, setHidden: () => {}, isHidden: () => true, focus: () => {}, unfocus: () => {}, isFocused: () => false }
    }
    const handle = this.activeScreen.showOverlay(component, options)
    // M8: the stacking graph + suspension rules live in the broker (plan
    // §13 — behavior identical; the existing modal-stacking tests gate
    // the extraction).
    return this.overlayBroker.track(handle, { nonCapturing: options?.nonCapturing === true })
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
    // M8: the broker owns the graph + question-aware close; the host
    // recomputes the focused seat from the live state after (follow-up
    // P1 — the broker's editor-seat report is a coarse signal, the host
    // re-derives the truth).
    this.overlayBroker.closeForHost(handle)
    this.publishFocusSeat()
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
      const draft = this.seatEditor().getText()
      this.stop()
      try {
        const next = await open(draft)
        if (this.disposed) return
        // No redundant editor update when the editor saved the draft
        // unchanged (an update would bump history/undo and repaint).
        if (next !== '' && next !== draft) {
          this.seatEditor().setText(next)
          this.editorSeatHolder.notifyChanged()
        }
      } finally {
        if (!this.disposed) this.start()
      }
    } finally {
      this.externalEditorInFlight = false
    }
  }

  /** Record a submitted line into the editor history and the persistence
   * mirror. The host may REFUSE via `shouldRememberInput` (e.g. a
   * multimodal draft whose placeholders die with their drafts — recalling
   * it would re-send dead placeholders as plain text; review finding). */
  private rememberInput(text: string): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    if (this.events.shouldRememberInput?.(text) === false) return
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
   * @returns the stored replacement (`next`), so a caller that keeps the
   *   card reference (e.g. a streaming tail refresher) can chain updates —
   *   the array element is replaced, so the OLD reference no longer indexes.
   */
  updateLocalMessage(message: TranscriptMessage, next: TranscriptMessage): TranscriptMessage {
    const index = this.localMessages.indexOf(message)
    if (index === -1) return next
    // A click-expanded local card keeps its override across the running →
    // settled replacement: the message identity changes, the presentation
    // state must not (plan §5.2 — never key expansion on the object alone).
    const override = this.expandedOverride.get(message)
    if (override !== undefined) {
      this.expandedOverride.delete(message)
      this.expandedOverride.set(next, override)
    }
    this.localMessages[index] = next
    this.rebuildMessages()
    return next
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
   * The quick-dismiss semantic action for settled local shell cards (plan
   * §5.4): removes completed `!`/`!!` runs from the live view. A RUNNING
   * card is never dismissed (a live stream survives), the shell process is
   * NOT cancelled (Esc owns that), no session event is deleted, and an
   * already-submitted `!` context payload is untouched — the transcript's
   * user row is the durable record either way. `!!` stays local-only.
   */
  dismissSettledLocalShell(): void {
    this.clearSettledLocalMessages()
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
    for (const handle of this.overlayBroker.handles()) handle.hide()
    this.overlayBroker.clear()
    if (this.activeQuestions !== undefined) this.activeQuestions.suspendedOverlays.clear()
    if (enabled) {
      // The alt screen owns mouse handling (wheel scroll, drag selection,
      // right-click paste — pi's fullscreen behavior); a same-cell primary
      // click reaches us through its onCellClick callback so cards can be
      // expanded individually, exactly like a web disclosure row.
      const alt = new TuiAltScreen(this.terminal, undefined, undefined, {
        onCellClick: (x, y) => this.handleFullscreenClick(x, y),
        // Issue #7: the host clipboard policy (tmux-aware, platform
        // helpers, OSC 52 last) replaces the vendor's raw OSC 52 write —
        // the alt screen never needs to understand tmux/SSH/Wayland/X11.
        copySelection: this.copySelection,
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
      // shortcuts, but the editor never receives text or Enter). M9: focus
      // the CURRENT seat occupant (round-2 finding 2).
      alt.setFocus(this.seatEditor().component)
      this.fullscreen = alt
      // The alt screen now owns the terminal input handler: scheme reports
      // arrive THERE, so re-register the fan-out on both screens.
      this.refreshSchemeRegistrations()
    } else {
      this.fullscreen?.stop()
      this.fullscreen = undefined
      this.fullscreenScroll = undefined
      this.tui.start()
      // Regular never re-reads a fullscreen per-card state: drop the
      // Thinking overrides a fullscreen click (or a search reveal)
      // created, so returning to fullscreen later starts from the bulk
      // preference again (plan §6.2's preferred cleanup — the regular
      // surface's only Thinking state is the bulk preference; search
      // reveals set fresh overrides as needed).
      this.clearThinkingExpansionOverrides()
      // The alt screen's exit repaint starts at the hardware cursor row, so
      // rows above it (e.g. a dialog the alt screen composited) survive in
      // the terminal buffer. Force a full repaint so the regular surface
      // redraws cleanly from row 0. M9: focus the current seat occupant.
      this.tui.requestRender(true)
      this.tui.setFocus(this.seatEditor().component)
      // The main screen owns the terminal input handler again.
      this.refreshSchemeRegistrations()
    }
    this.events.onFullscreenChange?.(enabled)
    // M8 (round-1 finding 2): still-open plugin overlay leases re-mount on
    // the CURRENT active screen (their raw handles died with the old
    // screen's teardown above). Phase 2: the ADVANCED interactive overlay
    // leases follow the same migration.
    this.remountExtensionOverlays()
    this.remountAdvancedOverlays()
    this.remountUnstableMounts()
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
    // The screen swap re-established focus (or re-mounted the approval
    // dialog): re-derive the seat from the live state (follow-up P1).
    this.setFocusSeat('editor')
    // Rebuild the projection for the NEW surface: the regular Ctrl+O
    // derived Focus reveal must not leak into fullscreen (and vice
    // versa) — the projection re-derives from the live surface context.
    this.rebuildMessages()
    this.publishFocusSeat()
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

  /**
   * Ctrl+R input-history search: open the modal panel (plan §18/§27). The
   * host owns the lifecycle; the panel owns the query/scope/list/detail
   * state; the injected search source owns the filesystem. A second
   * Ctrl+R while the panel is up is a no-op (the panel already owns the
   * keys through the overlay guard).
   */
  openHistorySearch(): void {
    if (this.historyPanel !== undefined) return
    if (this.historySearchSource === undefined) return
    if (this.disposed) return
    const columns = this.terminal.columns
    const rows = this.terminal.rows
    // The overlay must NEVER exceed the terminal (plan §51): width/height
    // are clamped to the real columns/rows (a 50×10 terminal must not
    // request a 60×14 panel). The panel's row budget is the overlay's
    // maxHeight minus the Frame's two border rows.
    const width = Math.min(columns - 2, Math.max(20, Math.min(100, columns - 6)))
    const maxHeight = Math.min(rows - 2, Math.max(8, Math.min(30, rows - 4)))
    const panel = new HistoryPanel({
      source: this.historySearchSource,
      // Resolve the cwd at OPEN time (session switches move it): the
      // injected getter reflects the LIVE session, the status cwd is the
      // fallback when no getter is wired.
      cwd: this.historySearchCwd?.() ?? this.status.cwd,
      // The session identity is captured ONCE at open time, like the cwd:
      // the panel's default scope and every request use this snapshot for
      // the panel's whole lifetime (a switch while the panel is up keeps
      // the search stable; the next open re-resolves).
      sessionId: this.historySearchSessionId?.(),
      maxRows: maxHeight - 2, // the Frame adds its two border rows
      onResultsChanged: () => this.requestRender(),
      onAccept: (content) => {
        this.closeHistorySearch()
        // Accept = "bring back and EDIT", never submit (plan §33): the
        // text replaces the editor draft through the seat setter; the
        // fork's overlay hide() restores editor focus automatically.
        this.setEditorText(content)
      },
      onClose: () => this.closeHistorySearch(),
    })
    panel.start()
    this.historyPanel = panel
    this.historyOverlay = this.showOverlayOnHost(new Frame(panel), { width, maxHeight })
  }

  /** Close the history panel (Esc/Ctrl+C, accept, surface dispose). */
  closeHistorySearch(): void {
    if (this.historyOverlay === undefined) return
    this.historyPanel?.dispose()
    this.historyOverlay.hide()
    this.historyOverlay = undefined
    this.historyPanel = undefined
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
   * entries (tool, system cards) render folded unless the Ctrl+O master
   * switch is on and the entry belongs to the most recent turns (or, in
   * REGULAR Focus, an expanded Thought root full-reveals its process —
   * fullscreen secondaries are mouse-owned). Thinking has its OWN detail
   * owner: Alt+T (the shared `thinkingExpanded` preference) plus per-card
   * overrides — Ctrl+O never touches it.
   * @param messages - the folded transcript.
   * @param activities - the same fold state's per-turn Focus activities
   *   (plan §19: messages and activities must come from ONE fold snapshot,
   *   so a repaint never shows a stale header against fresh rows).
   */
  setTranscript(messages: readonly TranscriptMessage[], activities?: ReadonlyMap<number, TurnActivity>): void {
    this.messages = messages
    if (activities !== undefined) this.turnActivities = activities
    // Repaints do NOT clear the transient notify line: an active session
    // repaints every frame (streaming chunks, tool cards), and clearing on
    // each repaint would make every notice — including error blocks like
    // the divergence guard's — flash for a frame. The notify expires via
    // its 8s auto-clear timer or an explicit clear (user submit, session
    // switch, stop).
    // (The component cache is pruned inside rebuildMessages below.)
    this.rebuildMessages()
  }

  /** Replace ONLY the turn activities (the messages stay). The runner
   * prefers the combined {@link setTranscript} snapshot — this setter is
   * for callers that repaint messages separately. */
  setTurnActivities(activities: ReadonlyMap<number, TurnActivity>): void {
    this.turnActivities = activities
    this.rebuildMessages()
  }

  /** Whether Focus Mode is currently projecting the transcript. */
  isFocusModeEnabled(): boolean {
    return this.focusModeEnabled
  }

  /** Turn Focus Mode on/off (the runner's unified setter — the persisted
   * preference, the system-prompt section and this surface all read the
   * SAME runtime state). Off restores the ordinary transcript projection
   * immediately; the expansion set is kept but not consulted (plan §16.4). */
  setFocusMode(enabled: boolean): void {
    if (this.focusModeEnabled === enabled) return
    this.focusModeEnabled = enabled
    // Focus is a transcript PROJECTION, never a Thinking preference
    // owner: switching Focus ON/OFF leaves the shared thinkingExpanded
    // bulk preference untouched (plan §17). The rebuild re-derives the
    // projection for the new mode.
    this.rebuildMessages()
    this.requestRender()
  }

  /** Toggle one turn's Thought disclosure (click on the header — plan
   * §16.1). Running turns are toggleable; turn/end never reverts the
   * choice. Closing is a COLLAPSE ALL: the turn's secondary expansions
   * are cleared with it (plan §6/§18), so reopening shows the process
   * timeline compact again. In fullscreen the EXPAND direction follows
   * the end (the user sees the latest content) and the COLLAPSE direction
   * anchors the Thought header in view (plan supplement). */
  toggleFocusTurn(turn: number): void {
    if (this.focusExpandedTurns.has(turn)) {
      this.collapseFocusTurn(turn, { anchorFullscreen: true })
      return
    }
    this.setFocusTurnExpanded(turn, true, { anchorFullscreen: true })
  }

  /** Force one turn's Thought open (transcript-search jumps — plan §23:
   * the match must be visible without a second click). Deliberately NO
   * anchor: the search caller owns the jump target, and an unconditional
   * Thought-header anchor would fight the match's own position (plan
   * §8.9). */
  expandFocusTurn(turn: number): void {
    this.setFocusTurnExpanded(turn, true)
  }

  /** Reveal one search-matched message: open its owner Thought (Focus on)
   * and full-reveal the matched SECONDARY card, so the hit is visible
   * even though the FULLSCREEN process timeline defaults to compact (plan
   * §28 — regular mode full-reveals the whole process anyway). A hit
   * inside Thinking full-reveals ONLY that block via its per-message
   * override — the thinkingExpanded bulk preference is never touched by
   * search (plan §14). The search caller owns the jump target — no
   * anchor. */
  revealSearchMatch(message: TranscriptMessage): void {
    const turn = 'turn' in message ? message.turn : undefined
    if (turn !== undefined && this.focusModeEnabled) {
      this.setFocusTurnExpanded(turn, true)
    }
    if (isFocusSecondaryDisclosure(message)) {
      this.expandedOverride.set(message, true)
    }
    this.rebuildMessages()
  }

  /** Clear every secondary expansion of one turn (the root Collapse All
   * reset — plan §16): reopening the Thought never restores the previous
   * long outputs — the FULLSCREEN timeline re-derives compact, while
   * regular mode full-reveals the process anyway. */
  private clearFocusSecondaryExpansions(turn: number): void {
    for (const message of this.messages) {
      if (!('turn' in message)) continue
      if (message.turn !== turn) continue
      if (!isFocusSecondaryDisclosure(message)) continue
      this.expandedOverride.delete(message)
    }
  }

  /** The explicit user-facing Collapse All: clear the turn's secondary
   * expansions, then close the root Thought (plan §16/§18). */
  private collapseFocusTurn(turn: number, options: { anchorFullscreen?: boolean } = {}): void {
    this.clearFocusSecondaryExpansions(turn)
    this.setFocusTurnExpanded(turn, false, options)
  }

  /**
   * The unified Focus disclosure transition (plan §8.4): every entry
   * point — header click, expanded-body click, search jumps — funnels
   * through here. With `anchorFullscreen` (user clicks only, never the
   * search path), the fullscreen viewport is adjusted AFTER the rebuild:
   * the EXPAND direction follows the END (the default view after
   * expansion is the latest content — the final answer or the newest
   * process output — and the viewport keeps following as it grows), and
   * the COLLAPSE direction anchors the turn's Thought header in view with
   * follow-end disabled (plan supplement).
   */
  private setFocusTurnExpanded(
    turn: number,
    expanded: boolean,
    options: { anchorFullscreen?: boolean } = {},
  ): void {
    if (this.focusExpandedTurns.has(turn) === expanded) return
    if (expanded) this.focusExpandedTurns.add(turn)
    else this.focusExpandedTurns.delete(turn)
    // 1. flip the set → 2. rebuild the projection (rebuildMessages already
    // requests a render) → 3. re-measure the row map at the current width
    // (a thumbnail that just finished loading must not shift the anchor).
    this.rebuildMessages()
    if (options.anchorFullscreen && this.fullscreenScroll !== undefined) {
      this.refreshMessageRows()
      const width = this.terminal.columns
      // The ScrollView's content height must reflect the NEW projection
      // BEFORE the scroll, or scrollTo would clamp against the stale
      // collapsed height. The layout pass uses the same rendered line
      // count the frame will paint (cached renders make this cheap).
      const contentHeight = this.messagesView.render(width).length
      const viewportHeight = this.fullscreenScroll.viewportHeight
      this.fullscreenScroll.updateLayout(contentHeight, viewportHeight, () => this.requestRender())
      if (expanded) {
        // 4. EXPAND: follow the end — the user sees the latest content
        // and the viewport keeps following as the process grows (plan
        // supplement: the default view after expansion is the end).
        this.fullscreenScroll.scrollToEnd()
      } else {
        // 4. COLLAPSE: anchor the Thought header `FOCUS_ANCHOR_TOP_PADDING`
        // rows below the viewport top (one row of previous context stays
        // visible); disableFollow breaks follow-end so the collapsed
        // content cannot snap back to the tail (plan §8.7).
        const transcriptRow = this.focusTurnTranscriptRow(turn)
        if (transcriptRow !== undefined) {
          const welcomeHeight = this.welcomeCard.render(width).length
          this.fullscreenScroll.scrollTo(
            welcomeHeight + transcriptRow - FOCUS_ANCHOR_TOP_PADDING,
            { disableFollow: true },
          )
        }
      }
    }
    this.requestRender()
  }

  /** The projected transcript row (in `messageRows` coordinates, welcome
   * card excluded) where a turn's Thought header starts. Returns undefined
   * when the turn is not currently projected (e.g. Focus off, or the turn
   * was windowed away). */
  private focusTurnTranscriptRow(turn: number): number | undefined {
    let row = 0
    for (const entry of this.messageRows) {
      if (entry.activity?.turn === turn) return row
      row += entry.height
    }
    return undefined
  }

  /** Enter the subagent-viewer scope: the child session's turn numbers are
   * its own namespace, so the parent's disclosures must not leak into it
   * (plan §26). The parent set is PRESERVED BY COPY and restored on exit
   * (pushing the live set itself would hand the stack the object this
   * method then empties). */
  enterFocusViewerScope(): void {
    this.focusExpansionsStack.push(new Set(this.focusExpandedTurns))
    this.focusExpandedTurns.clear()
    this.rebuildMessages()
  }

  /** Leave the subagent-viewer scope, restoring the parent's disclosures. */
  exitFocusViewerScope(): void {
    const restored = this.focusExpansionsStack.pop()
    if (restored === undefined) return
    this.focusExpandedTurns.clear()
    for (const turn of restored) this.focusExpandedTurns.add(turn)
    this.rebuildMessages()
  }

  /** Leave the subagent-viewer scope WITHOUT restoring: the parent session
   * is gone (a session swap), so its parked disclosure snapshot must be
   * DISCARDED — restoring it would leak the old session's turn expansions
   * into the new one (plan §16.3). Usually a no-op: the swap's
   * clearSessionOverrides already dropped the stack; this method makes the
   * teardown's intent explicit and stays correct even if that ordering
   * ever changes. */
  discardFocusViewerScope(): void {
    this.focusExpansionsStack.pop()
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
  private pruneMessageComponents(projectionExpanded: ReadonlySet<number>): void {
    // The FocusActivityComponent cache is pruned to the LIVE projected
    // blocks INDEPENDENTLY of the message cache: a turn that left the
    // window — or Focus turned off — must not keep a stale Thought
    // component around, and a cleared message cache must not leave one
    // either.
    if (this.focusActivityComponents.size > 0) {
      const liveTurns = new Set<number>()
      for (const block of this.projectedBlocks(projectionExpanded)) {
        if (block.kind === 'activity') liveTurns.add(block.activity.turn)
      }
      for (const turn of this.focusActivityComponents.keys()) {
        if (!liveTurns.has(turn)) this.focusActivityComponents.delete(turn)
      }
    }
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

  /** The Focus projection over the current transcript (identity = the raw
   * messages when Focus is off — plan §12.1). */
  /** The effective expanded-turn set for the Focus projection: manual
   * disclosures PLUS the regular Ctrl+O derived recent turns (keyboard
   * master — never written into focusExpandedTurns, so switching to
   * fullscreen does not inherit the keyboard full-reveal). */
  private focusProjectionExpandedTurns(): ReadonlySet<number> {
    if (!this.focusModeEnabled || this.fullscreen !== undefined || !this.toolOutputExpanded) {
      return this.focusExpandedTurns
    }
    const boundary = this.expandBoundary()
    if (!Number.isFinite(boundary) || this.focusExpandedTurns.size === 0) {
      if (!Number.isFinite(boundary)) return this.focusExpandedTurns
      const derived = new Set<number>()
      for (const message of this.messages) {
        if ('turn' in message && message.turn >= boundary) derived.add(message.turn)
      }
      return derived
    }
    const union = new Set(this.focusExpandedTurns)
    for (const message of this.messages) {
      if ('turn' in message && message.turn >= boundary) union.add(message.turn)
    }
    return union
  }

  private projectedBlocks(projectionExpanded: ReadonlySet<number>): FocusProjectedBlock[] {
    return projectFocus(this.messages, this.turnActivities, projectionExpanded, this.focusModeEnabled)
  }

  /** The precomputed Focus Tool-line display for one activity: presenter-
   * first, static fallback second (plan §38/§9.4). The FocusActivityComponent
   * stays a pure renderer — the presentation bridge lives here. */
  private focusToolDisplayFor(activity: TurnActivity): string | undefined {
    const tool = activity.tool
    if (tool === undefined) return undefined
    return focusToolDisplay(tool, { presenter: this.present, cwd: this.workspaceRoot })
  }

  /** Get (or rebuild) the FocusActivityComponent for one turn: rebuilds
   * when the activity OBJECT changed (session/viewer switches mint fresh
   * folder objects, so the same turn number from another session can
   * never reuse this one's component), the activity revision moved, the
   * disclosure flipped, the theme switched, or the precomputed Tool
   * display changed (plan §39). render() re-reads Date.now() every frame,
   * so the running duration is always live. */
  private focusActivityComponentFor(activity: TurnActivity, expanded: boolean, toolDisplay: string | undefined): FocusActivityComponent {
    const entry = this.focusActivityComponents.get(activity.turn)
    if (entry !== undefined && entry.activity === activity
      && entry.revision === activity.revision
      && entry.expanded === expanded && entry.themeRev === this.themeRevision
      && entry.toolDisplay === toolDisplay) {
      return entry.component
    }
    const component = new FocusActivityComponent({ activity, expanded, toolDisplay })
    this.focusActivityComponents.set(activity.turn, {
      activity,
      component,
      revision: activity.revision,
      expanded,
      themeRev: this.themeRevision,
      toolDisplay,
    })
    return component
  }

  /** Rebuild the message component tree from the current transcript state. */
  private rebuildMessages(): void {
    // Every rebuild path (transcript updates AND local-card push/replace/
    // clear) prunes the cache to the live set first. The derived
    // projection set is computed ONCE per rebuild and shared by the
    // pruning pass, the projection and every activity-component
    // construction (review findings).
    const projectionExpanded = this.focusProjectionExpandedTurns()
    this.pruneMessageComponents(projectionExpanded)
    this.messagesView.clear()
    this.messagesView.addChild(this.welcomeCard)
    const boundary = this.expandBoundary()
    // Row heights for mouse hit-testing: components render (and cache) at
    // the same width the frame pass uses, so the heights match the screen.
    const width = this.terminal.columns
    const rows: Array<{
      message?: TranscriptMessage
      activity?: TurnActivity
      height: number
      attachments: ReadonlyArray<{ imageIndex: number; start: number; end: number }>
    }> = []
    // One blank row separates consecutive blocks (pi/kimi Spacer parity), so
    // a session never reads as one undifferentiated wall of text. The spacer
    // row is charged to the preceding block's height, keeping the fullscreen
    // click hit-testing aligned with the rendered layout.
    const blocks: FocusProjectedBlock[] = [
      ...this.projectedBlocks(projectionExpanded),
      ...this.localMessages.map(message => ({ kind: 'message', message }) as FocusProjectedBlock),
    ]
    blocks.forEach((block, index) => {
      let component: Component
      let rendered: string[]
      let truncatedMarker = false
      let attachments: ReadonlyArray<{ imageIndex: number; start: number; end: number }> = []
      if (block.kind === 'activity') {
        // The live Thought disclosure; the hidden process rows (if any)
        // render as ordinary message blocks below it (plan §15).
        component = this.focusActivityComponentFor(
          block.activity,
          projectionExpanded.has(block.activity.turn),
          this.focusToolDisplayFor(block.activity),
        )
        rendered = component.render(width)
      } else {
        // Persistent per-message components (stage J): unchanged messages
        // reuse their component, so the fork's text-identity render caches
        // actually hit — markdown is not re-parsed and heights are not
        // recomputed for content that did not change. Only streaming/changed
        // messages rebuild.
        component = this.componentForMessage(block.message, boundary)
        rendered = component.render(width)
        truncatedMarker = block.truncated === true
        attachments = this.attachmentRangesOf(component, width)
      }
      if (rendered.length === 0 && !truncatedMarker) {
        // A zero-row block must not occupy a spacer row: the image
        // pipeline's non-text-block retention keeps reasoning-only
        // assistant messages (no text, no image) as empty entries, and an
        // invisible block's Spacer would read as an extra blank line
        // between the surrounding cards. Skip the component, the spacer
        // and the row height — the click map stays aligned (height 0
        // never hits, see handleFullscreenClick).
        rows.push({
          ...(block.kind === 'message' ? { message: block.message } : { activity: block.activity }),
          ...(block.kind === 'message' && block.collapseFocusOwnerOnClick !== undefined
            ? { collapseFocusOwnerOnClick: block.collapseFocusOwnerOnClick }
            : {}),
          height: 0,
          attachments: [],
        })
        return
      }
      this.messagesView.addChild(component)
      // The max-tokens truncated marker rides under the final assistant
      // (plan §13.8): one muted row, charged to the message's hit region.
      if (truncatedMarker) {
        this.messagesView.addChild(new Text(color.textMuted('  (output may be truncated)'), 0, 0))
      }
      const height = rendered.length + (truncatedMarker ? 1 : 0) + (index < blocks.length - 1 ? 1 : 0)
      rows.push({
        ...(block.kind === 'message' ? { message: block.message } : { activity: block.activity }),
        ...(block.kind === 'message' && block.collapseFocusOwnerOnClick !== undefined
          ? { collapseFocusOwnerOnClick: block.collapseFocusOwnerOnClick }
          : {}),
        height,
        attachments,
      })
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
   * Set the agent-busy flag (pi parity): while busy, a single Esc stops
   * the current activity. The runner pushes it at turn/start, turn/end,
   * compaction/start and compaction/end boundaries.
   */
  setBusy(busy: boolean): void {
    this.busy = busy
  }

  /**
   * Advertise the compaction lifecycle phase: the working row (above the
   * editor border) shows "Compacting context…" while summarizing and
   * "Applying compacted context…" while the replacement commits, each
   * with an indeterminate progress bar driven by the indicator's own
   * frame tick — pi's status-indicator parity. The runner derives the
   * phase from compaction/start → compaction/summary → compaction/end
   * (foldCompactionEvent); on end it re-derives the row from the turn
   * state (a turn-enclosed compaction hands back to the turn animation,
   * a standalone one clears the row).
   */
  setCompactionPhase(phase: CompactionPhase): void {
    if (this.compactionPhase === phase) return
    this.compactionPhase = phase
    this.reconcileWorkingRow()
    this.requestRender()
  }

  /** Compatibility wrapper for the pre-phase boolean API: active maps to
   * the summarizing phase (the runner now uses {@link setCompactionPhase}
   * so the applying stage is expressible). */
  setCompacting(active: boolean): void {
    this.setCompactionPhase(active ? 'summarizing' : 'idle')
  }

  /** The per-attachment click regions inside one message component: the row
   * span (message-relative) of every COLLAPSIBLE `ImageThumbnail` child —
   * the host wires a `collapsedRef` only for user/assistant message
   * attachments. Tool-card images (no collapsedRef) stay inside their
   * card's own click surface: their rows advance the counter but never
   * enter a collapse range, so a click there still folds/unfolds the card
   * instead of being swallowed by an inert attachment toggle. Every other
   * child's height still advances the row counter, so the spans line up
   * with the rendered layout.
   *
   * The ordinal among COLLAPSIBLE thumbnails IS the occurrence's image
   * index: renderUserBlocks / renderBlockSequence create a collapsible
   * thumbnail for EVERY image block of the message in content order, so
   * the nth thumbnail ↔ the nth image block — the same index the host's
   * collapsedRef getter reads. */
  private attachmentRangesOf(
    component: Component,
    width: number,
  ): ReadonlyArray<{ imageIndex: number; start: number; end: number }> {
    if (!(component instanceof Container)) return []
    const ranges: Array<{ imageIndex: number; start: number; end: number }> = []
    let row = 0
    let imageIndex = 0
    for (const child of component.children) {
      const height = child.render(width).length
      if (child instanceof ImageThumbnail && child.collapsible) {
        ranges.push({ imageIndex, start: row, end: row + height })
        imageIndex += 1
      }
      row += height
    }
    return ranges
  }

  /** Re-measure the message row map (heights + attachment spans) from the
   * cached components — called before a fullscreen click hit-test so a
   * thumbnail that just finished loading (1 row → image rows) never shifts
   * the hit map. Cached renders make this cheap (reference-stable lines). */
  private refreshMessageRows(): void {
    const width = this.terminal.columns
    const boundary = this.expandBoundary()
    // The derived projection set is computed ONCE per refresh (never per
    // activity block — review finding).
    const projectionExpanded = this.focusProjectionExpandedTurns()
    const blocks: FocusProjectedBlock[] = [
      ...this.projectedBlocks(projectionExpanded),
      ...this.localMessages.map(message => ({ kind: 'message', message }) as FocusProjectedBlock),
    ]
    const rows: Array<{
      message?: TranscriptMessage
      activity?: TurnActivity
      height: number
      attachments: ReadonlyArray<{ imageIndex: number; start: number; end: number }>
    }> = []
    blocks.forEach((block, index) => {
      let component: Component
      let rendered: string[]
      let truncatedMarker = false
      let attachments: ReadonlyArray<{ imageIndex: number; start: number; end: number }> = []
      if (block.kind === 'activity') {
        component = this.focusActivityComponentFor(
          block.activity,
          projectionExpanded.has(block.activity.turn),
          this.focusToolDisplayFor(block.activity),
        )
        rendered = component.render(width)
      } else {
        component = this.componentForMessage(block.message, boundary)
        rendered = component.render(width)
        truncatedMarker = block.truncated === true
        attachments = this.attachmentRangesOf(component, width)
      }
      if (rendered.length === 0 && !truncatedMarker) {
        // Same zero-row rule as rebuildMessages: no spacer row, no height —
        // the click map must mirror the rendered layout exactly.
        rows.push({
          ...(block.kind === 'message' ? { message: block.message } : { activity: block.activity }),
          ...(block.kind === 'message' && block.collapseFocusOwnerOnClick !== undefined
            ? { collapseFocusOwnerOnClick: block.collapseFocusOwnerOnClick }
            : {}),
          height: 0,
          attachments: [],
        })
        return
      }
      const height = rendered.length + (truncatedMarker ? 1 : 0) + (index < blocks.length - 1 ? 1 : 0)
      rows.push({
        ...(block.kind === 'message' ? { message: block.message } : { activity: block.activity }),
        ...(block.kind === 'message' && block.collapseFocusOwnerOnClick !== undefined
          ? { collapseFocusOwnerOnClick: block.collapseFocusOwnerOnClick }
          : {}),
        height,
        attachments,
      })
    })
    this.messageRows = rows
  }

  /** The live collapse flag for ONE image-block occurrence (message object
   * + image index within its content). Read at render time — a fullscreen
   * click only repaints. */
  private occurrenceCollapsedRef(message: TranscriptMessage, imageIndex: number): () => boolean {
    return () => this.collapsedOccurrences.get(message)?.has(imageIndex) ?? false
  }

  /** Toggle ONE image occurrence's display (fullscreen click). The info
   * bar stays constant — only that image's rows collapse/expand; a
   * repeated attachment elsewhere in the transcript is untouched. */
  private toggleAttachmentCollapsed(message: TranscriptMessage, imageIndex: number): void {
    let indices = this.collapsedOccurrences.get(message)
    if (indices === undefined) {
      indices = new Set()
      this.collapsedOccurrences.set(message, indices)
    }
    if (indices.has(imageIndex)) indices.delete(imageIndex)
    else indices.add(imageIndex)
    // Rebuild so the row map reflects the new heights immediately (the
    // thumbnail's render cache key carries the collapse bit, so the cached
    // message component re-renders in place).
    this.rebuildMessages()
  }

  /**
   * Show or hide the busy indicator on the row directly above the editor
   * border: while a turn is streaming or a tool is running (the runner
   * derives it from turn/start and turn/end). A compaction in flight keeps
   * the row live under its own label (see {@link setCompactionPhase}).
   */
  setWorking(active: boolean): void {
    this.workingActive = active
    this.reconcileWorkingRow()
    this.requestRender()
    this.syncExtensionState()
  }

  /** The working row's effective label: the base Working label (or the
   * Phase-4 plugin override) ALWAYS leads, and a running compaction
   * appends its stage — one unified row whether the turn is busy, the
   * compaction is standalone, or both. */
  private effectiveWorkingMessage(): string {
    const base = this.workingMessageOverride ?? 'Working...'
    switch (this.compactionPhase) {
      case 'summarizing':
        return `${base} · Compacting context…`
      case 'applying':
        return `${base} · Applying compacted context…`
      case 'idle':
        return base
    }
  }

  /** Reconcile the working row against its two drivers (turn activity,
   * compaction): the row animates while either is live, with the label
   * chosen by {@link effectiveWorkingMessage} and an indeterminate
   * progress-bar suffix while a compaction runs. */
  private reconcileWorkingRow(): void {
    this.working.setMessage(this.effectiveWorkingMessage())
    if (this.compactionPhase === 'idle') {
      this.working.setSuffixAnimation(undefined)
    } else {
      this.working.setSuffixAnimation({ frames: COMPACTION_PROGRESS_FRAMES })
    }
    if (this.workingActive || this.compactionPhase !== 'idle') {
      this.working.start()
    } else {
      this.working.stop()
      this.working.setText('')
    }
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

  /** Scroll the fullscreen transcript to the top (the symmetric
   * counterpart of scrollToBottom). */
  scrollToTop(): void {
    if (this.fullscreenScroll !== undefined) {
      this.fullscreenScroll.scrollToStart()
    } else {
      this.tui.requestRender(true)
    }
  }

  /** M5 test hook: the fullscreen ScrollView's live geometry (plan §14.2 —
   * tests assert `scrollTop` / `isFollowingEnd` / `viewportHeight` /
   * `maxScrollTop` directly, never a terminal screenshot). `contentHeight`
   * is the rendered transcript height the layout engine feeds the scroll
   * view (the same line count the frame paints); `maxScrollTop` is the
   * clamp — tests can then assert an anchored view is NOT at the max.
   * Undefined while not fullscreen. */
  fullscreenScrollForTest(): { scrollTop: number; isFollowingEnd: boolean; viewportHeight: number; contentHeight: number; maxScrollTop: number } | undefined {
    if (this.fullscreenScroll === undefined) return undefined
    const contentHeight = this.messagesView.render(this.terminal.columns).length
    const viewportHeight = this.fullscreenScroll.viewportHeight
    return {
      scrollTop: this.fullscreenScroll.scrollTop,
      isFollowingEnd: this.fullscreenScroll.isFollowingEnd,
      viewportHeight,
      contentHeight,
      maxScrollTop: Math.max(0, contentHeight - viewportHeight),
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
   * Fullscreen Focus disclosures are mouse-owned: the per-card override
   * decides, and the Ctrl+O keyboard fold does not pierce them.
   */
  private handleFullscreenClick(x: number, y: number): void {
    // A question owns the modal front: clicks inside its frame (the editor
    // seat, pinned above the footer) route to the flow — option rows select,
    // the body scroll marker toggles the expanded region. The seat's screen
    // range is derived from the bottom: footer height + the frame's last
    // rendered height.
    const question = this.activeQuestions
    if (question?.frame !== undefined) {
      // The question owns the modal front: EVERY click while a question is
      // up is captured here (in-frame clicks route to the flow; out-of-frame
      // clicks and the stale-geometry window are ignored) — background todo/
      // transcript interaction must not be reachable behind the modal.
      // Stale-geometry guard: between a terminal resize (rows OR columns —
      // a width change rewraps the body and shifts the flow's hit map) and
      // the next repaint, the frame's rendered height and hit map still
      // reflect the OLD terminal.
      if (this.terminal.rows !== question.frame.termRows || this.terminal.columns !== question.frame.termColumns) return
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
      }
      return
    }
    void x
    const width = this.terminal.columns
    const height = this.terminal.rows
    const footerHeight = this.footer.render(width).length
    const editorHeight = this.editorSeat.render(width).length
    const workingHeight = this.working.render(width).length
    const queueHeight = this.queuePane.render(width).length
    const goalHeight = this.goalLine.render(width).length
    const todoHeight = this.todoPanel.render(width).length
    // Bottom-up geometry, clamped to the terminal: a tiny terminal (or a
    // tall editor/queue) can push the derived rows off-screen, in which
    // case no click maps onto the panel — never a negative or inverted
    // region. Fullscreen layout, bottom-up: footer, editor seat, working
    // row, queue pane, goal line, todo panel, dock, scroll pane, header.
    const todoBottom = Math.max(0, Math.min(height, height - footerHeight - editorHeight - workingHeight - queueHeight - goalHeight))
    const todoTop = Math.max(0, todoBottom - todoHeight)
    // The dock strip (the todo summary row) sits directly above the panel:
    // clicking it opens the panel (mouse parity with Ctrl+T). The summary
    // is hidden while the panel is open, so the dock renders zero rows and
    // this branch is inert — the two regions never fight.
    const dockHeight = this.dock.render(width).length
    if (dockHeight > 0 && y >= todoTop - dockHeight && y < todoTop) {
      this.toggleTodoPanel()
      return
    }
    // A click on the todo panel's own rows runs the three-state loop
    // (compact → full list → back to the summary row), so the mouse opens
    // AND closes the panel without Ctrl+T.
    if (todoTop < todoBottom && y >= todoTop && y < todoBottom) {
      this.handleTodoPanelClick()
      return
    }
    // Fullscreen layout: header row(s), then the transcript scroll pane.
    const headerHeight = this.header.render(width).length
    const rowInScroll = y - headerHeight
    if (rowInScroll < 0) return
    const scrollTop = this.fullscreenScroll?.scrollTop ?? 0
    const welcomeHeight = this.welcomeCard.render(width).length
    const messageRow = rowInScroll + scrollTop - welcomeHeight
    if (messageRow < 0) return
    // Re-measure first: a thumbnail that just finished loading grew from
    // its 1-row info bar to info + image rows — a stale map would misplace
    // the click (cached renders make this cheap).
    this.refreshMessageRows()
    let row = 0
    for (const entry of this.messageRows) {
      if (messageRow < row + entry.height) {
        // A Focus Thought block: the whole rendered block (collapsed body
        // AND expanded header) toggles the turn disclosure (plan §17.1 —
        // the header is always a hit area; the collapsed preview rows too).
        if (entry.activity !== undefined) {
          this.toggleFocusTurn(entry.activity.turn)
          return
        }
        // A message row (activity rows never reach here): narrow the
        // optional message for the attachment/message toggles below.
        const message = entry.message
        if (message === undefined) return
        const inMessage = messageRow - row
        // Attachment rows win FIRST (plan §8.3): a click on an image's
        // info bar or its image rows toggles THAT OCCURRENCE's display —
        // the identity stays, the picture collapses/expands, and a
        // repeated attachment elsewhere stays untouched. A click on an
        // attachment inside an EXPANDED Thought must never collapse the
        // whole turn (the attachment's own hit area is the intent).
        for (const attachment of entry.attachments) {
          if (inMessage >= attachment.start && inMessage < attachment.end) {
            this.toggleAttachmentCollapsed(message, attachment.imageIndex)
            return
          }
        }
        // A message row REVEALED BY an expanded Focus Thought (its
        // thinking / tool / result / intermediate rows carry the owner
        // mark from the projection, plan §8.8 / review P2): the click
        // routes to the NEAREST disclosure owner (plan §14/§15) —
        // attachment > secondary > outer Thought. The user's OWN rows
        // and the FINAL assistant never carry the mark, so clicking them
        // keeps the old behavior (ordinary card toggle, no Thought
        // collapse).
        if (entry.collapseFocusOwnerOnClick !== undefined) {
          // 2. nearest disclosure: a SECONDARY card (thinking / tool /
          // system / compaction) toggles ITSELF — the root Thought stays
          // open (plan §14 step 2).
          if (isFocusSecondaryDisclosure(message)) {
            this.toggleMessageExpanded(message)
            return
          }
          // 3. outer disclosure: a NON-secondary process row (e.g. an
          // intermediate assistant) collapses the owner Thought — the
          // header stays anchored in view (plan §14 step 3).
          this.collapseFocusTurn(entry.collapseFocusOwnerOnClick, { anchorFullscreen: true })
          return
        }
        // 4. ordinary message toggle (the pre-Focus behavior).
        this.toggleMessageExpanded(message)
        return
      }
      row += entry.height
    }
  }

  /** Toggle one collapsible message's individual expansion (mouse click).
   * The same foldable set as the render rule (plan §32 — never two
   * different sets): thinking / tool / system / compaction. A THINKING
   * click flips the card's EFFECTIVE state, not just the override: under
   * a bulk-full preference a click collapses only that card (override
   * false), under a bulk-compact preference it expands only that card
   * (override true) — the per-card override always expresses the
   * opposite of the effective state (plan §3.5/E4). */
  private toggleMessageExpanded(message: TranscriptMessage): void {
    if (!isFocusSecondaryDisclosure(message)) return
    if (message.kind === 'thinking') {
      if (this.effectiveThinkingExpanded(message)) {
        if (this.thinkingExpanded) this.expandedOverride.set(message, false)
        else this.expandedOverride.delete(message)
      } else {
        this.expandedOverride.set(message, true)
      }
    } else if (this.expandedOverride.get(message) === true) {
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
    // The Focus disclosures are session-scoped transient state too: a
    // switched-in session must never inherit the old session's turn
    // numbers (plan §16.3). The persisted Focus preference survives. The
    // VIEWER-SCOPE STACK is equally session-scoped: it holds the old
    // parent's disclosure snapshot while a subagent viewer is open, and a
    // session swap must DISCARD it (never restore the old session's turns
    // into the new one — the swap teardown's discardFocusViewerScope is
    // then a no-op; see that method).
    this.focusExpandedTurns.clear()
    this.focusExpansionsStack.length = 0
    // The attachment collapse toggles are session-scoped too: a switched-in
    // session's attachments start expanded (the click state must never leak).
    this.collapsedOccurrences.clear()
    // The per-message render cache is session-scoped too: old messages are
    // unreachable after a switch, so drop their cached components — with
    // disposal so thumbnail loader subscriptions never leak (round-2
    // finding 2).
    this.disposeMessageComponents()
  }

  /** Dispose every cached message component, then clear the cache. The
   * component dispose is idempotent (thumbnails release their loader
   * subscription once). */
  private disposeMessageComponents(): void {
    for (const entry of this.messageComponents.values()) {
      const component = entry.component as { dispose?: () => void } | undefined
      if (component?.dispose !== undefined) {
        try {
          component.dispose()
        } catch {
          // Best effort: a cached component's dispose must not break teardown.
        }
      }
    }
    this.messageComponents.clear()
  }

  /** Show or clear plan mode: header + footer badges and a warning-tinted editor border. */
  setPlanMode(active: boolean): void {
    this.planMode = active
    this.renderHeader()
    this.renderFooter()
    const seat = this.seatEditor()
    seat.borderColor = active ? color.warning : this.editorBorder
    seat.invalidate()
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
   * Issue #8: arm the empty-editor double-Ctrl+C exit window. The footer's
   * second line switches to `Press Ctrl+C again to exit` for EXACTLY
   * {@link ctrlCExitWindowMs} — the hint and the exit window share ONE
   * timer, so a stale hint can never outlive a dead window (the old
   * notify-based hint lingered ~8s while the window was already gone).
   */
  private armCtrlCExit(): void {
    this.clearCtrlCExit()
    this.lastCtrlCAt = Date.now()
    this.ctrlCExitArmed = true
    this.renderFooter()
    this.ctrlCExitTimer = setTimeout(() => {
      this.ctrlCExitTimer = undefined
      this.lastCtrlCAt = undefined
      this.ctrlCExitArmed = false
      this.renderFooter()
      this.requestRender()
    }, this.ctrlCExitWindowMs)
    this.ctrlCExitTimer.unref?.()
  }

  /**
   * Issue #8: disarm the exit chord and restore the footer. Public so the
   * runner clears it on session switches (a stale armed window must not
   * exit the NEW session). Idempotent; safe after dispose (renderFooter
   * requests are benign no-ops then).
   */
  clearCtrlCExit(): void {
    if (this.ctrlCExitTimer !== undefined) {
      clearTimeout(this.ctrlCExitTimer)
      this.ctrlCExitTimer = undefined
    }
    if (this.ctrlCExitArmed || this.lastCtrlCAt !== undefined) {
      this.ctrlCExitArmed = false
      this.lastCtrlCAt = undefined
      this.renderFooter()
    }
  }

  /**
   * Replace the editor draft. The runner restores a submission that the
   * divergence guard blocked, so the user's text survives for a retry.
   * While a CONTINUABLE subagent viewer covers the editor, the write goes
   * to the CHILD's draft slot + the visible editor (the main draft stays
   * untouched); a ONE-SHOT viewer keeps the main draft write (the
   * placeholder bar stays up; the main draft is restored on exit).
   */
  setEditorText(text: string): void {
    const target = this.viewerMode
    if (target !== undefined && isViewerAccessInteractive(resolveViewerAccess(target.mode, target.access))) {
      this.subagentDrafts.set(target.childSessionId, text)
      this.seatEditor().setText(text)
      this.editorSeatHolder.notifyChanged()
      this.requestRender()
      return
    }
    if (target !== undefined) {
      this.mainDraftBeforeViewer = text
      return
    }
    // M9: every public draft mutation targets the visible seat occupant, not
    // the hidden host editor left behind by an editor handoff.
    this.seatEditor().setText(text)
    this.editorSeatHolder.notifyChanged()
    this.requestRender()
  }

  /**
   * Insert text at the editor cursor — the image-placeholder insertion
   * path (`/image`, Ctrl+V). A replacement editor without cursor insertion
   * falls back to appending at the end of the draft; the host editor
   * inserts at the cursor (fork `Editor.insertTextAtCursor`). In a
   * continuable viewer the insert targets the CHILD draft (image support
   * in the viewer is a later milestone — text-only follow-ups for now).
   */
  insertIntoEditor(text: string): void {
    const target = this.viewerMode
    if (target !== undefined && isViewerAccessInteractive(resolveViewerAccess(target.mode, target.access))) {
      const editor = this.seatEditor()
      if (editor.insertTextAtCursor !== undefined) {
        editor.insertTextAtCursor(text)
      } else {
        editor.setText(editor.getText() + text)
      }
      this.editorSeatHolder.notifyChanged()
      this.requestRender()
      return
    }
    if (target !== undefined) {
      this.mainDraftBeforeViewer = (this.mainDraftBeforeViewer ?? this.seatEditor().getText()) + text
      return
    }
    const editor = this.seatEditor()
    if (editor.insertTextAtCursor !== undefined) {
      editor.insertTextAtCursor(text)
    } else {
      editor.setText(editor.getText() + text)
    }
    this.editorSeatHolder.notifyChanged()
    this.requestRender()
  }

  /**
   * Enter, switch or leave the MODE-AWARE subagent viewer. The target
   * carries the exact direct parent + child + catalog mode + activity
   * (never guessed later):
   * - `continuable`: the editor shows the child's OWN draft (empty on the
   *   first visit, restored on re-entry); typing edits it; Enter submits
   *   a follow-up through {@link TuiAppEvents.onSubagentSubmit};
   * - `one-shot`: the editor bar is covered by a read-only placeholder.
   * The MAIN draft is preserved in {@link mainDraftBeforeViewer} on entry
   * and restored on exit; the child drafts live in {@link subagentDrafts}
   * and never mix with the main draft.
   * @param mode - the viewer target; `undefined` leaves the viewer.
   */
  setViewerMode(mode: SubagentViewerTarget | undefined): void {
    if (mode === undefined) {
      if (this.viewerMode === undefined) return
      const leaving = this.viewerMode
      this.viewerMode = undefined
      this.viewerGeneration += 1
      // Save the outgoing child's unsent draft. The MAP is the child
      // slot's source of truth (onChange mirrors every edit; a map-only
      // stale restore may hold MORE than the visible text), so the
      // visible text is folded in ONLY when it carries something the map
      // does not already know (a replacement editor whose text never
      // mirrors through onChange). A visible text the map already
      // contains (equal or a substring of the merge) never duplicates —
      // a stale restore's merged text survives an exit exactly once.
      if (isViewerAccessInteractive(resolveViewerAccess(leaving.mode, leaving.access))) {
        this.parkSubagentDraft(leaving.childSessionId)
      }
      // M9 (round-2 finding 1): the viewer restore writes the preserved
      // main draft to the CURRENT seat occupant (a plugin editor's draft
      // returns to the plugin, never to a hidden host editor).
      const seat = this.seatEditor()
      seat.borderColor = this.editorBorder
      this.clearViewerPlaceholder()
      seat.setText(this.mainDraftBeforeViewer ?? '')
      this.mainDraftBeforeViewer = undefined
      seat.invalidate()
      this.editorSeatHolder.notifyChanged()
      this.renderHeader()
      this.requestRender()
      this.syncExtensionState()
      return
    }
    if (this.viewerMode === undefined) {
      this.mainDraftBeforeViewer = this.seatEditor().getText()
      // The viewer renders ONLY the child transcript: the main session's
      // local cards (`!` shell runs) must never leak into it. The runner
      // repaints the child folder right after, so the cleared list is
      // rebuilt from the child content.
      this.localMessages.length = 0
      this.rebuildMessages()
    } else if (isViewerAccessInteractive(resolveViewerAccess(this.viewerMode.mode, this.viewerMode.access))) {
      // Switching child: park the outgoing child's draft first.
      this.parkSubagentDraft(this.viewerMode.childSessionId)
    }
    this.viewerMode = mode
    this.viewerGeneration += 1
    // M9: cover the CURRENT seat occupant (a plugin editor's component
    // receives the child draft / placeholder; the preserved drafts stay
    // in their own slots).
    const seat = this.seatEditor()
    seat.borderColor = color.accent
    if (isViewerAccessInteractive(resolveViewerAccess(mode.mode, mode.access))) {
      // The empty-draft placeholder advertises the viewer's OWN verbs
      // (Enter sends to the CHILD — never the parent — Esc returns).
      this.setViewerPlaceholder(`Message ${mode.label}… — Enter send · Esc back`)
      seat.setText(this.subagentDrafts.get(mode.childSessionId) ?? '')
    } else {
      this.clearViewerPlaceholder()
      seat.setText(`viewing subagent: ${mode.label} — ${viewerAccessHint(mode.mode, resolveViewerAccess(mode.mode, mode.access))} · Esc returns`)
    }
    seat.invalidate()
    this.editorSeatHolder.notifyChanged()
    this.renderHeader()
    this.requestRender()
    this.syncExtensionState()
  }

  /** The viewer generation for stale-guards: async viewer-bound work
   * captures this value at start and must not touch the surface once it
   * changed (a viewer open/close/switch bumps it). */
  getViewerGeneration(): number {
    return this.viewerGeneration
  }

  /** Replace the footer while the subagent viewer is open: the footer
   * shows the VIEWED child's own identity (label/mode/activity/turns/
   * stats) instead of the parent session's status. Pass `undefined` to
   * restore the parent footer. The runner sets it on viewer open,
   * refreshes it as the child's own events fold, and clears it on exit. */
  setViewerFooter(footer: SubagentViewerFooter | undefined): void {
    this.viewerFooter = footer
    this.renderFooter()
  }

  /** Park one child's unsent draft when its viewer session ends (exit or
   * child switch). The MAP is the child slot's source of truth, so the
   * visible text is folded in ONLY when it carries something the map does
   * not already know:
   * - the map is EMPTY/unset → the visible text becomes the slot;
   * - the visible text is the map's merge PREFIX (`visible` followed by
   *   `\n\n` — the exact shape a map-only restore produces: the older
   *   visible text on top, the restored submission beneath) → the map
   *   already contains the visible text, keep it (a stale restore's
   *   merged text survives an exit exactly once, never duplicated);
   * - otherwise (a replacement editor whose text never mirrors through
   *   onChange edited beyond the map — including DELETIONS, which a
   *   substring check would wrongly classify as "already known") → the
   *   visible text is appended beneath the map, nothing is lost.
   * Exact equality short-circuits as "already parked". */
  private parkSubagentDraft(childSessionId: string): void {
    const visible = this.seatEditor().getText()
    const slotted = this.subagentDrafts.get(childSessionId)
    if (visible === slotted) return
    if (slotted === undefined || slotted === '') {
      if (visible !== '') this.subagentDrafts.set(childSessionId, visible)
      return
    }
    if (visible === '') return
    this.subagentDrafts.set(childSessionId,
      slotted.startsWith(`${visible}\n\n`)
        ? slotted
        : `${slotted}\n\n${visible}`)
  }

  /** The unsent draft of one child (the viewer's per-child slot), merged
   * with `text` so a FAILED follow-up never loses input: whatever the
   * child draft currently holds (possibly newer user input typed while
   * the request was in flight) stays on top, the failed submission is
   * preserved visibly beneath it. MAP-ONLY: a stale send (the viewer was
   * closed/switched/reopened since the send started — its generation
   * moved on) must NEVER touch the current surface, even when the user
   * re-opened the SAME child: the visible editor belongs to the NEW
   * viewer session, and the restored text surfaces through the map on
   * the next entry instead. The runner's CURRENT-session restore (the
   * viewer never moved) goes through setEditorText(mergeDraft(...)),
   * which updates the visible editor; this API is only for stale
   * restores. */
  restoreSubagentDraft(childSessionId: string, text: string): void {
    if (text === '') return
    const current = this.subagentDrafts.get(childSessionId) ?? ''
    this.subagentDrafts.set(childSessionId, current === '' ? text : `${current}\n\n${text}`)
  }

  /** Enter in a continuable viewer: snapshot the child draft, clear the
   * visible editor, and hand the follow-up to the runner through
   * {@link TuiAppEvents.onSubagentSubmit}. The draft is cleared BEFORE
   * the async delivery; a rejection restores it (merged) — the user's
   * input never silently disappears. */
  private submitSubagentDraft(): void {
    if (this.disposed) return
    const target = this.viewerMode
    if (target === undefined || target.mode !== 'continuable') return
    if (this.events.onSubagentSubmit === undefined) return
    const text = this.seatEditor().getText()
    if (text.trim() === '') return
    this.clearNotify()
    // Issue #8: a successful submit is a fresh explicit action — the armed
    // exit chord (and its footer hint) must not survive into the next
    // interaction.
    this.clearCtrlCExit()
    // Snapshot + clear the visible child draft. The per-child SLOT is
    // cleared EXPLICITLY — not via the onChange mirror — because a
    // replacement editor in the seat does not guarantee onChange: an
    // accepted submission must never resurrect in the child's slot (a
    // reopened viewer would otherwise show already-delivered text).
    this.subagentDrafts.set(target.childSessionId, '')
    this.seatEditor().setText('')
    this.editorSeatHolder.notifyChanged()
    this.requestRender()
    this.events.onSubagentSubmit({
      parentSessionId: target.parentSessionId,
      childSessionId: target.childSessionId,
      text,
    })
  }

  /** Keys the interactive (continuable) viewer consumes so they can never
   * act on the PARENT session: the host ladder handles them for the main
   * editor, and inside the viewer they must be inert (the child is the
   * only input target). Esc/Ctrl+O/Enter are deliberately NOT listed —
   * they fall through to the host's exit/fold/submit paths. */
  private viewerParentLockedKey(data: string): boolean {
    if (matchesKey(data, 'down') && this.tasksActive && this.seatEditor().getText().trim() === '') {
      // The empty-editor ↓ task-browser trigger must not open the
      // PARENT's browser from inside the viewer.
      return true
    }
    return matchesKey(data, 'ctrl+s')        // steer all (parent)
      || matchesKey(data, 'ctrl+enter')      // queue submit (parent)
      || matchesKey(data, 'alt+up')          // dequeue (parent)
      || matchesKey(data, 'shift+tab')       // permission cycle (parent)
      || matchesKey(data, 'ctrl+f') || matchesKey(data, 'ctrl+shift+f') // main-transcript search
      || matchesKey(data, 'ctrl+c')          // clear/exit chord (would exit the TUI)
      || matchesKey(data, 'ctrl+d')          // exit
      || matchesKey(data, 'ctrl+g')          // external editor (main draft)
      || matchesKey(data, 'ctrl+t')          // todo panel
      || matchesKey(data, 'alt+t')           // thinking detail bulk toggle
      || matchesKey(data, 'ctrl+v')          // clipboard image intake (main draft store)
  }

  /** Show a render-time placeholder hint on the host editor (empty draft
   * only — it is NEVER part of the draft text). A replacement editor in
   * the seat has no placeholder surface; the hint is host-editor-only. */
  private setViewerPlaceholder(text: string): void {
    ;(this.editor as import('./tui-editor.ts').TuiEditor).setPlaceholder(text)
  }

  /** Clear the host editor's render-time placeholder. */
  private clearViewerPlaceholder(): void {
    ;(this.editor as import('./tui-editor.ts').TuiEditor).setPlaceholder('')
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
  /** Phase 4: the current theme id ('dark' | 'light' | 'custom'), tracked
   * by applyTheme/applyPalette (the advanced host-state getTheme). */
  private currentThemeId: string = 'dark'

  /** Persistent components per transcript message (stage J cache). */
  private readonly messageComponents = new Map<TranscriptMessage, MessageComponentEntry>()


  /** M7: a renderer failure sink (the runner wires the extension
   * service's health ledger — round-1 finding 3: failures must be
   * observable, never swallowed). Optional. */
  private rendererError: ((record: { id: string; error: unknown; slot?: 'message' | 'tool' }) => void) | undefined

  /** M7 (P1-08): a renderer RECOVERY sink — called when a renderer that
   * previously failed renders successfully again, so its health record
   * clears (the next failure starts a NEW error generation). */
  private rendererRecovered: ((record: { id: string; slot?: 'message' | 'tool' }) => void) | undefined

  /** M7: wire the renderer-failure sink (the runner calls this with the
   * extension service's health recording). */
  setRendererErrorSink(sink: (record: { id: string; error: unknown; slot?: 'message' | 'tool' }) => void): void {
    this.rendererError = sink
  }

  /** M7 (P1-08): wire the renderer-recovery sink. */
  setRendererRecoveredSink(sink: (record: { id: string; slot?: 'message' | 'tool' }) => void): void {
    this.rendererRecovered = sink
  }

  /**
   * M8: mount a MANAGED overlay for a plugin (plan §13.3). The view is the
   * M4 component kit — the host compiles it, mounts it through the overlay
   * broker (modal stacking, focus, fullscreen migration, teardown) and
   * returns a generation-scoped lease whose close() is idempotent. The
   * surface's final dispose closes every still-owned lease.
   * @param view - the ExtensionView to present.
   * @param options - sizing/positioning hints.
   */
  showExtensionOverlay(
    view: import('./extension/public-types.ts').ExtensionView,
    options: import('./extension/public-types.ts').TuiOverlayOptions = {},
  ): import('./extension/public-types.ts').TuiOverlayHandle {
    // P1-09: a surface that was FINALLY disposed is inert — a late plugin
    // call must never mount on the dead app or mint a new lease (the
    // dispose cleanup already closed every owned lease; a new one would
    // resurrect a handle after teardown). The inert-lease shape matches
    // the no-surface-host path below.
    if (this.disposed) {
      return { close: () => {}, hide: () => {}, show: () => {} }
    }
    const mountOptions = this.overlayOptionsOf(options)
    // The lease KEEPS the view + options so a fullscreen screen swap can
    // RE-MOUNT it on the new active screen (round-1 finding 2 — a plugin
    // overlay must survive a fullscreen toggle, not become a stale handle
    // on the dead screen). The raw handle dies with the old screen; the
    // lease re-creates it after the swap.
    let raw: OverlayHandle | undefined
    let hiddenByLease = false
    let closed = false
    const mount = (): void => {
      if (closed || raw !== undefined) return
      const compiled = compileView(view)
      const component = compiled.isEmpty ? new Text('', 0, 0) : compiled.component
      raw = this.showOverlayOnHost(component, mountOptions)
      if (hiddenByLease) raw.setHidden(true)
    }
    mount()
    const lease: import('./extension/public-types.ts').TuiOverlayHandle & { _remount(): void } = {
      close: () => {
        if (closed) return
        closed = true
        // Drop the lease from the owned set (round-1 finding 1: a closed
        // lease must not leak until dispose).
        this.extensionOverlayLeases.delete(lease)
        raw?.hide()
        raw = undefined
      },
      hide: () => {
        if (closed) return
        hiddenByLease = true
        raw?.setHidden(true)
      },
      show: () => {
        if (closed) return
        hiddenByLease = false
        raw?.setHidden(false)
      },
      // Host-internal: re-create the raw handle on the CURRENT active
      // screen after a fullscreen swap (the old raw handle died with the
      // old screen). Idempotent (a live raw handle skips).
      _remount: () => {
        if (closed) return
        raw = undefined
        mount()
      },
    }
    // The surface's dispose closes every still-owned lease: track it.
    this.extensionOverlayLeases.add(lease)
    return lease
  }

  /** Map the public overlay options onto the host's mount options. */
  private overlayOptionsOf(options: import('./extension/public-types.ts').TuiOverlayOptions): OverlayOptions {
    return {
      ...(options.width === undefined ? {} : { width: options.width }),
      ...(options.minWidth === undefined ? {} : { minWidth: options.minWidth }),
      ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
      ...(options.anchor === undefined ? {} : { anchor: options.anchor }),
      ...(options.offsetX === undefined ? {} : { offsetX: options.offsetX }),
      ...(options.offsetY === undefined ? {} : { offsetY: options.offsetY }),
      ...(options.row === undefined ? {} : { row: options.row }),
      ...(options.col === undefined ? {} : { col: options.col }),
      ...(options.margin === undefined ? {} : { margin: options.margin }),
      nonCapturing: options.nonCapturing === true,
    }
  }

  /**
   * M8: re-mount every still-open plugin lease on the CURRENT active
   * screen. Called by the host after a fullscreen toggle (the old screen's
   * overlays died with it — plan §13.3: a managed lease survives the
   * screen migration).
   */
  private remountExtensionOverlays(): void {
    for (const lease of this.extensionOverlayLeases) {
      ;(lease as unknown as { _remount(): void })._remount()
    }
  }

  /** M8 test hook: the number of still-owned plugin overlay leases
   * (asserts a closed lease is dropped and dispose clears the set). */
  ownedExtensionOverlayLeasesForTest(): number {
    return this.extensionOverlayLeases.size
  }

  // ── Phase 2: ADVANCED interactive overlays (plan §6/§8) ─────────────────

  /**
   * Phase 2: mount an INTERACTIVE managed overlay hosting a plugin's
   * focused interactive component (plan §8). The host wraps the plugin
   * component (render compiled through the M4 kit, input normalized by
   * the shared Host decoder, focus via the fork's Focusable protocol),
   * mounts it through the overlay broker (modal stacking, focus,
   * fullscreen migration, teardown) and returns a generation-scoped
   * lease. The surface's final dispose closes every still-owned lease.
   * @param component - the plugin's interactive component.
   * @param options - sizing/positioning hints.
   */
  showAdvancedInteractiveOverlay(
    component: import('./extension/advanced-types.ts').AdvancedInteractiveComponent,
    options: import('./extension/public-types.ts').TuiOverlayOptions = {},
  ): import('./extension/advanced-types.ts').AdvancedOverlayLease {
    // A finally-disposed surface is inert: a late plugin call must never
    // mount on the dead app or mint a new lease (same rule as the stable
    // overlay path).
    if (this.disposed) {
      return {
        id: 'inert',
        active: false,
        focused: false,
        focus: () => {},
        blur: () => {},
        invalidate: () => {},
        close: () => {},
        hide: () => {},
        show: () => {},
      }
    }
    const mountOptions = this.overlayOptionsOf(options)
    const id = `adv-overlay-${++this.advancedOverlayCounter}`
    // The lease KEEPS the component + options so a fullscreen screen swap
    // can RE-MOUNT it on the new active screen (the raw handle dies with
    // the old screen — same contract as the stable overlay lease).
    let wrapper: import('./extension/internal/advanced-overlay.ts').AdvancedOverlayComponent | undefined
    let raw: OverlayHandle | undefined
    let hiddenByLease = false
    let closed = false
    const mount = (): void => {
      if (closed || raw !== undefined) return
      const created = new AdvancedOverlayComponent(
        component,
        () => this.advancedRenderContext(),
        (message: string) => this.notify(`advanced overlay: ${message}`, 'error'),
      )
      wrapper = created
      this.advancedOverlayWrappers.add(created)
      raw = this.showOverlayOnHost(created, mountOptions)
      if (hiddenByLease) raw.setHidden(true)
    }
    mount()
    const lease: import('./extension/advanced-types.ts').AdvancedOverlayLease & { _remount(): void; _recompile(): void } = {
      id,
      get active() {
        return !closed
      },
      get focused() {
        return raw?.isFocused() ?? false
      },
      focus: () => {
        if (closed) return
        hiddenByLease = false
        raw?.setHidden(false)
        raw?.focus()
      },
      blur: () => {
        if (closed) return
        raw?.unfocus()
      },
      invalidate: () => {
        if (closed) return
        wrapper?.invalidate()
        this.requestRender()
      },
      close: () => {
        if (closed) return
        closed = true
        this.advancedOverlayLeases.delete(lease)
        if (wrapper !== undefined) {
          this.advancedOverlayWrappers.delete(wrapper)
          // The wrapper's dispose() runs the plugin's dispose() (isolated
          // inside the wrapper) — the plugin component never outlives its
          // overlay.
          wrapper.dispose()
        }
        raw?.hide()
        raw = undefined
        wrapper = undefined
      },
      hide: () => {
        if (closed) return
        hiddenByLease = true
        raw?.setHidden(true)
      },
      show: () => {
        if (closed) return
        hiddenByLease = false
        raw?.setHidden(false)
      },
      // Host-internal: re-create the raw handle on the CURRENT active
      // screen after a fullscreen swap (the old raw handle died with the
      // old screen). Idempotent (a live raw handle skips). The OLD wrapper
      // is dropped from the live set WITHOUT disposing it — the plugin
      // component must survive the screen migration (the lease stays
      // live); the dead screen's overlay stack is the only remaining
      // reference and dies with the screen.
      _remount: () => {
        if (closed) return
        if (wrapper !== undefined) {
          this.advancedOverlayWrappers.delete(wrapper)
        }
        raw = undefined
        mount()
      },
      // Host-internal: recompile the plugin's render() output (terminal
      // resize — the plugin's render(ctx) must see the new geometry).
      _recompile: () => {
        if (closed) return
        wrapper?.invalidate()
      },
    }
    // The surface's dispose closes every still-owned lease: track it.
    this.advancedOverlayLeases.add(lease)
    return lease
  }

  /** Phase 2: re-mount every still-open ADVANCED lease on the CURRENT
   * active screen (fullscreen toggle — the old screen's overlays died
   * with it; a managed lease survives the screen migration). */
  private remountAdvancedOverlays(): void {
    for (const lease of this.advancedOverlayLeases) {
      lease._remount()
    }
  }

  /** Phase 2: recompile every live ADVANCED overlay wrapper (terminal
   * resize — the plugin's render(ctx) sees the new geometry). */
  private recompileAdvancedOverlays(): void {
    for (const wrapper of this.advancedOverlayWrappers) {
      wrapper.invalidate()
    }
  }

  /** Phase 2 test hook: the number of still-owned ADVANCED overlay leases. */
  ownedAdvancedOverlayLeasesForTest(): number {
    return this.advancedOverlayLeases.size
  }

  /** Phase 2 test hook: the number of live ADVANCED overlay wrappers
   * (asserts a fullscreen remount drops the old wrapper — the set must
   * not grow across screen migrations). */
  advancedOverlayWrappersForTest(): number {
    return this.advancedOverlayWrappers.size
  }

  /** Phase 2: the live render context for ADVANCED interactive overlays
   * (surfaceId/generation/geometry; `focused` is added by the wrapper). */
  private advancedRenderContext(): Omit<import('./extension/advanced-types.ts').AdvancedRenderContext, 'focused'> {
    return {
      surfaceId: this.extensionHost?.surfaceId ?? 'tui',
      generation: this.generation,
      width: this.terminal.columns,
      height: this.terminal.rows,
    }
  }

  // ── Phase 3: UNSTABLE raw input + low-level surface seam (plan §4–§10) ──

  /** The emergency fail-safe window (ms): three Esc presses within this
   * window trigger the release. */
  private static readonly UNSTABLE_FAILSAFE_WINDOW_MS = 1500

  /**
   * The Host emergency fail-safe detector (plan §7): triple-Esc within
   * {@link UNSTABLE_FAILSAFE_WINDOW_MS} at the SAME capture-session
   * revision. Runs BEFORE the raw captures are consulted, so it cannot be
   * rewritten or consumed by a capture. The first two Esc presses pass
   * through (a plugin surface may use Esc normally); the third is
   * consumed and triggers the release.
   *
   * Stale-press invalidation (round-1 finding): each press is stamped
   * with the raw capture registry revision, which bumps on EVERY
   * register/dispose. A release (fail-safe, owner unload) followed by a
   * re-register therefore invalidates every earlier press — a stale pair
   * from a previous capture session can never make the first Esc of a
   * new session count as the third press.
   * @param data - the raw chunk.
   * @returns true when the fail-safe fired (the caller must consume the
   *   chunk and run the release).
   */
  private unstableFailSafe(data: string): boolean {
    // Only a PRESS counts: Kitty CSI-u release/repeat events
    // (`\x1b[27;1:3u` / `\x1b[27;1:2u`) match matchesKey('escape') but
    // must never increment the fail-safe tracker (round-2 finding — a
    // release/repeat would otherwise make the third press fire early).
    if (isKeyRelease(data) || isKeyRepeat(data) || !matchesKey(data, 'escape')) return false
    const revision = this.unstableInputsRevision?.() ?? 0
    const now = Date.now()
    this.unstableEscPresses = this.unstableEscPresses.filter(press =>
      now - press.at < TuiApp.UNSTABLE_FAILSAFE_WINDOW_MS && press.revision === revision)
    this.unstableEscPresses.push({ at: now, revision })
    if (this.unstableEscPresses.length >= 3) {
      this.unstableEscPresses = []
      return true
    }
    return false
  }

  /**
   * Phase 3: the UNSTABLE low-level surface handle (plan §10) — a
   * SELECTED set of host surface capabilities for low-level plugins. It
   * NEVER exposes `TuiApp`, `TuiMainScreen`, `TuiAltScreen` or the
   * terminal object. A finally-disposed surface is inert.
   */
  unstableSurfaceHandle(): import('./extension/unstable-types.ts').UnstableSurfaceHandle {
    const app = this
    return {
      surfaceId: this.extensionHost?.surfaceId ?? 'tui',
      generation: this.generation,
      get width() {
        return app.terminal.columns
      },
      get height() {
        return app.terminal.rows
      },
      requestRender: () => {
        if (app.disposed) return
        app.requestRender()
      },
      mountComponent: (component, options) => app.showUnstableMount(component, options),
    }
  }

  /**
   * Phase 3: mount a low-level component (plan §9 option A) as a capturing
   * overlay. The plugin renders RAW lines and receives RAW input (the
   * Unstable contract — no sanitization); the host owns the physical
   * mount, focus, stacking, fullscreen migration and teardown. The
   * surface's final dispose closes every still-owned lease.
   */
  showUnstableMount(
    component: import('./extension/unstable-types.ts').UnstableMountedComponent,
    options: import('./extension/public-types.ts').TuiOverlayOptions = {},
  ): import('./extension/unstable-types.ts').UnstableMountLease {
    if (this.disposed) {
      return {
        id: 'inert',
        active: false,
        focused: false,
        focus: () => {},
        blur: () => {},
        invalidate: () => {},
        close: () => {},
        hide: () => {},
        show: () => {},
      }
    }
    const mountOptions = this.overlayOptionsOf(options)
    const id = `unstable-mount-${++this.unstableMountCounter}`
    let adapter: import('./extension/internal/unstable-mount.ts').UnstableMountedComponentAdapter | undefined
    let raw: OverlayHandle | undefined
    let hiddenByLease = false
    let closed = false
    const mount = (): void => {
      if (closed || raw !== undefined) return
      const created = new UnstableMountedComponentAdapter(
        component,
        (message: string) => this.notify(`unstable mount: ${message}`, 'error'),
      )
      adapter = created
      this.unstableMountAdapters.add(created)
      raw = this.showOverlayOnHost(created, mountOptions)
      if (hiddenByLease) raw.setHidden(true)
    }
    mount()
    const lease: import('./extension/unstable-types.ts').UnstableMountLease & { _remount(): void } = {
      id,
      get active() {
        return !closed
      },
      get focused() {
        return raw?.isFocused() ?? false
      },
      focus: () => {
        if (closed) return
        hiddenByLease = false
        raw?.setHidden(false)
        raw?.focus()
      },
      blur: () => {
        if (closed) return
        raw?.unfocus()
      },
      invalidate: () => {
        if (closed) return
        this.requestRender()
      },
      close: () => {
        if (closed) return
        closed = true
        this.unstableMountLeases.delete(lease)
        if (adapter !== undefined) {
          this.unstableMountAdapters.delete(adapter)
          adapter.dispose()
        }
        raw?.hide()
        raw = undefined
        adapter = undefined
      },
      hide: () => {
        if (closed) return
        hiddenByLease = true
        raw?.setHidden(true)
      },
      show: () => {
        if (closed) return
        hiddenByLease = false
        raw?.setHidden(false)
      },
      // Host-internal: re-create the raw handle on the CURRENT active
      // screen after a fullscreen swap. The OLD adapter is dropped from
      // the live set WITHOUT disposing it (the plugin component must
      // survive the screen migration).
      _remount: () => {
        if (closed) return
        if (adapter !== undefined) {
          this.unstableMountAdapters.delete(adapter)
        }
        raw = undefined
        mount()
      },
    }
    this.unstableMountLeases.add(lease)
    return lease
  }

  /** Phase 3: re-mount every still-open UNSTABLE lease on the CURRENT
   * active screen (fullscreen toggle). */
  private remountUnstableMounts(): void {
    for (const lease of this.unstableMountLeases) {
      lease._remount()
    }
  }

  /** Phase 3 test hook: the number of still-owned UNSTABLE mount leases. */
  ownedUnstableMountLeasesForTest(): number {
    return this.unstableMountLeases.size
  }

  /** Phase 3 test hook: the number of live UNSTABLE mount adapters
   * (asserts a fullscreen remount drops the old adapter). */
  unstableMountAdaptersForTest(): number {
    return this.unstableMountAdapters.size
  }

  /** Phase 2: the ADVANCED editor controls (plan §9) — direct semantic
   * editor actions through the host's editor seat. The host owns
   * submission/session safety; these controls only carry text/cursor/
   * focus. A disposed surface is inert. */
  advancedEditorControls(): import('./extension/advanced-types.ts').AdvancedEditorControls {
    const app = this
    return {
      getEditorState: () => app.editorSeatHolder.snapshot(),
      setEditorText: (text) => {
        if (app.disposed) return
        app.seatEditor().setText(text)
        app.editorSeatHolder.notifyChanged()
      },
      setEditorCursor: (offset) => {
        if (app.disposed) return
        app.seatEditor().setCursor(offset)
        app.editorSeatHolder.notifyChanged()
      },
      insertEditorText: (text, at) => {
        if (app.disposed) return
        const current = app.seatEditor()
        const offset = at ?? current.getCursor()
        const draft = current.getText()
        const next = draft.slice(0, offset) + text + draft.slice(offset)
        current.setText(next)
        current.setCursor(offset + text.length)
        app.editorSeatHolder.notifyChanged()
      },
      pasteToEditor: (text) => {
        if (app.disposed) return
        const current = app.seatEditor()
        const offset = current.getCursor()
        const draft = current.getText()
        const next = draft.slice(0, offset) + text + draft.slice(offset)
        current.setText(next)
        current.setCursor(offset + text.length)
        app.editorSeatHolder.notifyChanged()
      },
      requestEditorFocus: () => {
        if (app.disposed) return
        // Best-effort: focus the seat component only when no capturing
        // flow (question/approval/overlay) owns the seat — those flows
        // restore their own focus and must never be stolen.
        if (app.activeQuestions !== undefined || app.activeApproval !== undefined
          || app.activeScreen.hasOverlayEntries) return
        app.activeScreen.setFocus(app.seatEditor().component)
      },
    }
  }

  /** Phase 2 test hook: the current ADVANCED editor controls (probes the
   * seam without going through the service). */
  advancedEditorControlsForTest(): import('./extension/advanced-types.ts').AdvancedEditorControls {
    return this.advancedEditorControls()
  }

  // ── Phase 4: the imperative UI broker + host-state facade (plan §4A/§4D) ─

  /**
   * Phase 4: the ADVANCED imperative UI broker (plan §4A) — select/
   * confirm/input/notify/custom built on the Host's OWN picker, question
   * flow and notify infrastructure (never a second modal manager). A
   * disposed surface settles every prompt immediately.
   */
  advancedUiBroker(): {
    select(options: import('./extension/advanced-types.ts').AdvancedSelectOptions): Promise<string | undefined>
    confirm(options: import('./extension/advanced-types.ts').AdvancedConfirmOptions): Promise<boolean>
    input(options: import('./extension/advanced-types.ts').AdvancedInputOptions): Promise<string | undefined>
    notify(message: string, options?: import('./extension/advanced-types.ts').AdvancedNotifyOptions): void
    custom(factory: (host: import('./extension/advanced-types.ts').AdvancedCustomHost) => import('./extension/advanced-types.ts').AdvancedInteractiveComponent, options?: import('./extension/public-types.ts').TuiOverlayOptions, signal?: AbortSignal): Promise<unknown>
  } {
    const app = this
    return {
      select: (options) => app.advancedSelect(options),
      confirm: (options) => app.advancedConfirm(options),
      input: (options) => app.advancedInput(options),
      notify: (message, options) => {
        if (app.disposed) return
        app.notify(message, options?.type ?? 'info')
      },
      custom: (factory, options, signal) => app.advancedCustom(factory, options, signal),
    }
  }

  /** Phase 4: imperative selection — a picker overlay resolving with the
   * selected value, or undefined on cancel/abort/dispose. */
  private advancedSelect(options: import('./extension/advanced-types.ts').AdvancedSelectOptions): Promise<string | undefined> {
    if (this.disposed) return Promise.resolve(undefined)
    return new Promise<string | undefined>((resolve) => {
      let settled = false
      // Declared BEFORE settle: an already-aborted signal fires onCancel
      // SYNCHRONOUSLY inside openPicker, so settle must not hit a TDZ
      // reference to handle (round-6 finding — the promise would reject
      // with a ReferenceError instead of resolving undefined).
      let handle: PickerHandle | undefined
      // The zero-arg settle registered in pendingBrokerSettles (the
      // surface-dispose path) — removed on a normal select/cancel/abort
      // (round-2 finding: an anonymous entry would retain the closed
      // picker until surface dispose). Routes through settle() so the
      // dispose path shares the same single-settle semantics (round-3
      // follow-up).
      const brokerSettle = (): void => settle(undefined)
      const settle = (value: string | undefined): void => {
        if (settled) return
        settled = true
        this.pendingBrokerSettles.delete(brokerSettle)
        // Round-5 asymmetry: a settled promise must not retain the
        // picker's abort listener on the caller's signal (the dispose
        // path routes through settle too). Optional-chained: the
        // already-aborted path never registered a listener.
        handle?._removeAbortListener?.()
        resolve(value)
      }
      handle = this.openPicker(
        options.items.map(item => ({ ...item })),
        (value) => settle(value),
        () => settle(undefined),
        {
          header: options.header,
          enableSearch: options.enableSearch,
          width: options.width,
          maxHeight: options.maxHeight,
          signal: options.signal,
        },
      )
      // The surface's dispose settles the prompt (the picker overlay dies
      // with the surface; the promise must not hang). Guarded: an
      // already-aborted signal settles synchronously inside openPicker —
      // the entry must not be added afterwards.
      if (!settled) this.pendingBrokerSettles.add(brokerSettle)
    })
  }

  /** Phase 4: imperative confirmation — a yes/no question resolving with
   * the choice; cancel/abort/dispose resolves false. */
  private advancedConfirm(options: import('./extension/advanced-types.ts').AdvancedConfirmOptions): Promise<boolean> {
    const approve = options.approveLabel ?? 'Yes'
    const reject = options.rejectLabel ?? 'No'
    return this.askQuestions([{
      id: 'advanced-confirm',
      question: options.question,
      ...(options.detail === undefined ? {} : { detail: options.detail }),
      options: [{ label: approve }, { label: reject }],
    }], options.signal)
      .then(answers => answers[0]?.selected[0] === approve)
      .catch(() => false)
  }

  /** Phase 4: imperative free-text input — a question with a free-text
   * row resolving with the text; cancel/abort/dispose resolves
   * undefined. */
  private advancedInput(options: import('./extension/advanced-types.ts').AdvancedInputOptions): Promise<string | undefined> {
    return this.askQuestions([{
      id: 'advanced-input',
      question: options.question,
      ...(options.detail === undefined ? {} : { detail: options.detail }),
    }], options.signal)
      .then(answers => answers[0]?.custom)
      .catch(() => undefined)
  }

  /**
   * Phase 4: custom interactive UI (plan §4B) — mount a factory-built
   * interactive component and resolve with the result reported through
   * the public host facade's done(), or undefined on close/cancel/
   * dispose. The factory receives ONLY the public facade — never a
   * private TUI object. A throwing factory is isolated (resolves
   * undefined).
   */
  private advancedCustom(
    factory: (host: import('./extension/advanced-types.ts').AdvancedCustomHost) => import('./extension/advanced-types.ts').AdvancedInteractiveComponent,
    options: import('./extension/public-types.ts').TuiOverlayOptions = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (this.disposed) return Promise.resolve(undefined)
    const app = this
    return new Promise<unknown>((resolve) => {
      let settled = false
      // Declared BEFORE the factory call: a factory that synchronously
      // calls host.done()/close() must not hit a TDZ reference.
      let lease: import('./extension/advanced-types.ts').AdvancedOverlayLease | undefined
      // The zero-arg settle registered in pendingBrokerSettles (the
      // surface-dispose path) — the set holds `() => void` entries.
      const brokerSettle = (): void => settle(undefined)
      const settle = (result: unknown): void => {
        if (settled) return
        settled = true
        this.pendingBrokerSettles.delete(brokerSettle)
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        lease?.close()
        resolve(result)
      }
      // The fiber-cancellation path (round-1 finding): owner unload aborts
      // the signal — the promise settles undefined and the surface closes.
      const onAbort = (): void => settle(undefined)
      if (signal !== undefined) {
        if (signal.aborted) {
          resolve(undefined)
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      const host: import('./extension/advanced-types.ts').AdvancedCustomHost = {
        surfaceId: this.extensionHost?.surfaceId ?? 'tui',
        generation: this.generation,
        get width() { return app.terminal.columns },
        get height() { return app.terminal.rows },
        done: (result) => settle(result),
        close: () => settle(undefined),
      }
      let component: import('./extension/advanced-types.ts').AdvancedInteractiveComponent
      try {
        component = factory(host)
      } catch (error) {
        // Round-4 follow-up: drop the abort listener before returning —
        // a throwing factory never mounts, so the listener must not stay
        // registered on the caller's signal.
        if (signal !== undefined) signal.removeEventListener('abort', onAbort)
        this.notify(`custom UI failed: ${safeErrorMessage(error)}`, 'error')
        resolve(undefined)
        return
      }
      // Round-2 finding: a factory that settles SYNCHRONOUSLY (calls
      // host.done()/close() during the factory call) must not mount the
      // overlay afterwards — the settle already resolved the promise and
      // the lease was still undefined, so the mount would leak forever
      // (the surface-dispose path cannot clean it up either: settle
      // returns early on `settled`).
      if (!settled) {
        lease = this.showAdvancedInteractiveOverlay(component, options)
        // The surface's dispose settles the promise (the overlay dies with
        // the surface).
        this.pendingBrokerSettles.add(brokerSettle)
      }
    })
  }

  /** Phase 4: the pending broker settles (run on the surface's final
   * dispose — every still-open select/custom promise settles instead of
   * hanging). */
  private readonly pendingBrokerSettles = new Set<() => void>()

  /** Phase 4 test hook: the number of still-pending broker settles
   * (asserts a normal select/custom completion leaves none behind). */
  pendingBrokerSettlesForTest(): number {
    return this.pendingBrokerSettles.size
  }

  /**
   * Phase 4: the ADVANCED host-state facade (plan §4D) — theme query/
   * select, title override, working-indicator override and tool-expansion
   * preference. A disposed surface is inert.
   */
  advancedHostState(): import('./extension/advanced-types.ts').AdvancedHostState {
    const app = this
    return {
      getTheme: () => app.currentThemeId,
      setTheme: (name) => {
        if (app.disposed) return
        if (name === 'dark' || name === 'light') {
          app.applyTheme(name)
          return
        }
        // A registered plugin theme name: the runner resolves the palette
        // through the theme registry (wired below); unknown names are a
        // no-op.
        app.events.onAdvancedSetTheme?.(name)
      },
      setTitle: (title) => {
        if (app.disposed) return
        app.setSessionTitle(title)
      },
      setWorkingMessage: (message) => {
        if (app.disposed) return
        // The override feeds the working row's effective label: a running
        // compaction keeps its own label, the override applies otherwise.
        app.workingMessageOverride = message ?? undefined
        app.reconcileWorkingRow()
        app.requestRender()
      },
      setToolsExpanded: (expanded) => {
        if (app.disposed) return
        app.setToolOutputExpanded(expanded)
      },
    }
  }

  /** Phase 4 test hook: the current ADVANCED host-state facade. */
  advancedHostStateForTest(): import('./extension/advanced-types.ts').AdvancedHostState {
    return this.advancedHostState()
  }

  /** Phase 4 test hook: the working indicator's current label (probes the
   * working-message override). */
  workingTextForTest(): string {
    return this.working.messageText()
  }

  /** Phase 2: the ADVANCED overlay lease id counter. */
  private advancedOverlayCounter = 0
  /** Phase 2: the last geometry the ADVANCED overlays were recompiled at
   * (the resize latch — recompile only on an actual geometry change). */
  private lastAdvancedGeometry: { width: number; height: number } = { width: -1, height: -1 }

  /** M9: the host default editor adapted to the seat surface. The fork's
   * cursor is `{line, col}`; the seat uses a flat OFFSET (line lengths
   * summed + col), so plugin editors and the host agree on one shape. */
  private hostEditorAdapter(): import('./editor-seat-holder.ts').HostEditorAdapter {
    // Capture the editor so object-literal getters keep the right `this`.
    const editor = this.editor
    return {
      getText: () => editor.getText(),
      setText: (text) => editor.setText(text),
      isShowingAutocomplete: () => editor.isShowingAutocomplete(),
      getCursor: () => {
        const cursor = editor.getCursor()
        const lines = editor.getText().split('\n')
        let offset = 0
        for (let line = 0; line < cursor.line && line < lines.length; line++) {
          offset += lines[line]!.length + 1
        }
        return offset + cursor.col
      },
      setCursor: (offset) => {
        const text = editor.getText()
        const lines = text.split('\n')
        let remaining = Math.max(0, Math.min(offset, text.length))
        for (let line = 0; line < lines.length; line++) {
          const length = lines[line]?.length ?? 0
          if (remaining <= length) {
            editor.setCursor?.({ line, col: remaining })
            return
          }
          remaining -= length + 1
        }
        const line = Math.max(0, lines.length - 1)
        editor.setCursor?.({ line, col: lines[line]?.length ?? 0 })
      },
      setTextAndCursor: (text, offset) => {
        // Editor.setTextAndCursor normalizes CRLF/CR and expands tabs before
        // clamping the cursor. Convert the flat replacement offset against
        // that same stored representation, otherwise a tab/newline before
        // the cursor would shift the host position by a different amount.
        const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '    ')
        const lines = normalized.split('\n')
        let remaining = Math.max(0, Math.min(offset, text.length))
        const rawPrefix = text.slice(0, remaining)
        remaining = rawPrefix.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\t/g, '    ').length
        let line = 0
        for (; line < lines.length; line++) {
          const length = lines[line]?.length ?? 0
          if (remaining <= length) break
          remaining -= length + 1
        }
        const targetLine = Math.min(line, Math.max(0, lines.length - 1))
        editor.setTextAndCursor(normalized, { line: targetLine, col: remaining })
      },
      insertTextAtCursor: (text) => editor.insertTextAtCursor(text),
      handleInput: (data) => editor.handleInput(data),
      runWithoutChange: <T>(task: () => T): T => {
        const onChange = editor.onChange
        editor.onChange = undefined
        try {
          return task()
        } finally {
          editor.onChange = onChange
        }
      },
      get focused() { return editor.focused },
      borderColor: (text) => editor.borderColor(text),
      invalidate: () => editor.invalidate(),
      addToHistory: (text) => editor.addToHistory(text),
      clearHistory: () => editor.clearHistory(),
      component: editor,
    }
  }

  /**
   * M9: reconcile the seat with the editor registry's current winner —
   * perform the atomic handoff when the winner changed. Called after the
   * registry revision changes (the runner wires it) and at construction.
   */
  reconcileEditorWinner(): void {
    const registry = this.editorRegistry
    if (registry === undefined) return
    const winner = registry.winner()
    const current = this.editorSeatHolder.currentEditor()
    const targetId = winner?.id
    if (current.id === (targetId ?? 'host')) return
    // Perform the atomic handoff (create → transfer → mount → dispose).
    // The registry revision rides along so a failed target's guard clears
    // on a same-id re-registration (round-1 finding 4).
    this.editorSeatHolder.handoff(winner === undefined ? undefined : {
      id: winner.id,
      create: (host) => winner.create(host),
    }, registry.snapshot().revision)
    // Re-mount the seat child: the editor seat now holds the new
    // occupant's component (the host default editor or the plugin's).
    this.mountSeatChild()
  }

  /**
   * M9: mount the CURRENT seat occupant's component into the editor seat
   * (the host default editor or the plugin winner's compiled view). The
   * question flow's seat restore uses the same path, so a plugin editor
   * survives a question round-trip.
   *
   * P1-06/P1-10: the mount ALSO transfers focus to the new occupant when
   * the editor seat currently owns input — after a handoff the plugin
   * editor's component must actually receive keys (typing, arrows), not
   * leave the old host Editor focused. Focus transfer is skipped while a
   * capturing flow (question/approval) owns the seat — those flows
   * restore their own focus.
   */
  private mountSeatChild(): void {
    const component = this.seatEditor().component
    this.editorSeat.clear()
    this.editorSeat.addChild(component)
    // Focus follows the occupant: if the seat owns input right now (no
    // question/approval/overlay is capturing), the NEW component must be
    // the focused component — otherwise every key after a handoff still
    // targets the old host Editor (P1-06 probe would see the WRONG
    // focused component and plugin bindings would steal editor keys).
    if (this.activeQuestions === undefined && this.activeApproval === undefined
      && !this.activeScreen.hasOverlayEntries) {
      this.activeScreen.setFocus(component)
    }
  }

  /**
   * M9: the CURRENT seat editor (all host editor access routes through
   * this — plan §14: business code stops scattering this.editor.*).
   */
  private seatEditor(): import('./editor-seat-holder.ts').SeatEditor {
    return this.editorSeatHolder.currentEditor()
  }

  /** M9 public hook: reconcile the seat with the registry's winner NOW
   * (tests + the runner call it after a winner change; the render-path
   * reconcile is the live fallback). */
  reconcileEditorNow(): void {
    this.reconcileEditorWinner()
  }

  /** M9 test hook: the CURRENT seat occupant's text (probes what the
   * seat actually renders — getDraft preserves the viewer draft). */
  seatTextForTest(): string {
    return this.seatEditor().getText()
  }

  /** M9 test hook: the CURRENT seat occupant (component rendering probe). */
  seatEditorForTest(): import('./editor-seat-holder.ts').SeatEditor {
    return this.seatEditor()
  }

  /** P2-R5 test hook: the HIDDEN host editor's live text (probes that a
   * display-only replacement editor never silently routes typing into the
   * hidden host editor while the plugin seat is visible). */
  hostEditorTextForTest(): string {
    return this.editor.getText()
  }

  /** M7 test hook: build (or fetch) the cached component entry for one
   * message at a fold boundary, exposing the renderer identity. */
  messageCacheEntryForTest(message: TranscriptMessage, boundary = 0): MessageComponentEntry | undefined {
    this.componentForMessage(message, boundary)
    return this.messageComponents.get(message)
  }

  /**
   * M7: build the semantic presentation snapshot for one message (plan
   * §12 — renderers receive ONLY semantic snapshots, never mutable
   * messages or containers). Returns undefined for kinds a renderer
   * cannot present.
   */
  private semanticSnapshotOf(message: TranscriptMessage): MessagePresentationSnapshot | undefined {
    switch (message.kind) {
      case 'user':
      case 'assistant':
        return { kind: message.kind, turn: message.turn, text: message.text }
      case 'thinking':
        return { kind: 'thinking', turn: message.turn, text: message.text, running: message.running }
      case 'system':
        return { kind: 'system', turn: message.turn, text: message.text, label: message.label, summary: message.summary }
      case 'tool': {
        return {
          kind: 'tool',
          turn: message.turn,
          tool: Object.freeze({
            callId: `${message.turn}:${message.name}:${message.args.slice(0, 32)}`,
            toolName: message.name,
            status: message.status,
            arguments: message.args === '' ? undefined : deepFreeze(safeParseArgs(message.args)),
            result: message.result === '' ? undefined : deepFreeze(safeParseArgs(message.result)),
            expanded: message.turn >= 0,
          }),
        }
      }
      case 'summary':
        return { kind: 'summary', turn: 0, text: message.text }
      case 'compaction':
        // Host-owned card: extension renderers never present compaction
        // records (the host fallback below renders them).
        return undefined
    }
  }

  /** Whether a message currently sits inside an EXPANDED Focus Thought
   * (its turn's root disclosure is open — plan §33): a MANUAL disclosure
   * (focusExpandedTurns) or the regular Ctrl+O keyboard master's DERIVED
   * reveal (never written into focusExpandedTurns — the two surfaces do
   * not pollute each other). Both count: regular mode full-reveals ANY
   * expanded root. */
  private isInsideExpandedFocus(message: TranscriptMessage, boundary: number): boolean {
    if (!this.focusModeEnabled || !('turn' in message)) return false
    const turn = message.turn
    return this.focusExpandedTurns.has(turn) || this.isRegularCtrlOExpandedTurn(turn, boundary)
  }

  /** Regular + Focus + Ctrl+O: whether `turn` is a DERIVED recent Focus
   * turn — the keyboard master's root-expansion scope (it feeds the
   * projection and isInsideExpandedFocus; never written into
   * focusExpandedTurns). Fullscreen never derives. */
  private isRegularCtrlOExpandedTurn(turn: number, boundary: number): boolean {
    if (!this.focusModeEnabled || this.fullscreen !== undefined || !this.toolOutputExpanded) return false
    return Number.isFinite(boundary) && turn >= boundary
  }

  /** The effective expansion of one Thinking block (the unified disclosure
   * model, plan §6/§7): the per-message override wins when present — in
   * FULLSCREEN that is a click or a search reveal; in REGULAR it is only
   * ever a search reveal, because entering regular clears every
   * fullscreen click override (see setFullscreen), so a stale per-card
   * state can never surface there. Otherwise the shared bulk preference.
   * Focus ON/OFF is irrelevant: there is exactly one Thinking detail
   * state for the whole app. */
  private effectiveThinkingExpanded(message: Extract<TranscriptMessage, { kind: 'thinking' }>): boolean {
    const override = this.expandedOverride.get(message)
    if (override !== undefined) return override
    return this.thinkingExpanded
  }

  /** The effective expansion of one foldable message (plan §9/§33),
   * SURFACE-ADAPTIVE: Thinking is its OWN disclosure — a compact/full
   * detail level controlled by Alt+T (bulk) plus per-card overrides
   * (fullscreen clicks, search reveals); Ctrl+O never touches it. Inside
   * an expanded Focus Thought a NON-Thinking SECONDARY card is compact
   * unless its per-card override says otherwise in FULLSCREEN (the mouse
   * fine-inspection mode), while in REGULAR ANY expanded root —
   * Ctrl+O-derived or manually revealed — full-reveals its non-Thinking
   * process (no mouse, so no dead compact affordances). Every other
   * context keeps the existing rule. */
  private effectiveMessageExpanded(message: TranscriptMessage, boundary: number): boolean {
    if (message.kind === 'thinking') {
      return this.effectiveThinkingExpanded(message)
    }
    if ('turn' in message && this.isInsideExpandedFocus(message, boundary) && isFocusSecondaryDisclosure(message)) {
      if (this.fullscreen !== undefined) {
        // Fullscreen: explicit secondary disclosure only.
        return this.expandedOverride.get(message) === true
      }
      // Regular: no mouse, so no compact secondary affordance — ANY
      // expanded Focus root (Ctrl+O-derived OR manually revealed /
      // search / viewer restore) full-reveals its non-Thinking process.
      // There is never a dead `(ctrl+o to expand)` card that Ctrl+O
      // cannot open.
      return true
    }
    return this.existingMessageExpandedRule(message, boundary)
  }

  /** The pre-secondary expansion rule: LOCAL `!`/`!!` shell cards read the
   * master Ctrl+O switch (never the unbounded turn marker — a long log
   * would fill the TUI); every other foldable card reads the recent-turn
   * boundary or its per-card override. Thinking is NOT in the foldable
   * set here: Ctrl+O owns tool/system/compaction detail, Alt+T owns
   * Thinking detail (plan §2.4/§18). */
  private existingMessageExpandedRule(message: TranscriptMessage, boundary: number): boolean {
    if (isLocalShellCard(message)) {
      return this.toolOutputExpanded || this.expandedOverride.get(message) === true
    }
    return (message.kind === 'system' || message.kind === 'tool' || message.kind === 'compaction')
      && (message.turn >= boundary || this.expandedOverride.get(message) === true)
  }

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
  /** The surface-adaptive render state of one foldable message: the
   * effective expansion, the full-reveal flag (tool bodies / large
   * diffs) and the fold-hint owner (click / ctrl+o / alt+t). Computed
   * ONCE per componentForMessage call and PART OF THE RENDER-CACHE
   * IDENTITY — a Focus toggle or a surface switch must rebuild the
   * component when any of these change, even when the message content
   * and the boundary are unchanged (review finding: fullReveal and the
   * fold-hint owner were not cached, so `Ctrl+O ON → /focus on` reused
   * the capped diff component). */
  private messageRenderState(
    message: TranscriptMessage,
    boundary: number,
  ): { expanded: boolean; fullReveal: boolean; expandHint: ExpandHint } {
    const expanded = this.effectiveMessageExpanded(message, boundary)
    const insideFocusSecondary = 'turn' in message
      && this.isInsideExpandedFocus(message, boundary)
      && isFocusSecondaryDisclosure(message)
    // The fold-hint owner (plan §12): Thinking is Alt+T-owned in regular
    // and click-owned in fullscreen; fullscreen Focus SECONDARY cards are
    // click-owned; every other fold is Ctrl+O-owned. A regular Focus
    // non-Thinking secondary is ALWAYS full — no hint.
    const expandHint: ExpandHint = message.kind === 'thinking'
      ? (this.fullscreen !== undefined ? 'click' : 'alt+t')
      : insideFocusSecondary
        ? (this.fullscreen !== undefined ? 'click' : undefined)
        : 'ctrl+o'
    // The FULL-REVEAL flag for tool bodies (large diffs): true for the
    // per-card override AND for any REGULAR Focus expanded root (the
    // surface contract — no mouse, so a capped diff would be unreadable);
    // fullscreen keeps the per-card override semantics.
    const fullReveal = this.expandedOverride.get(message) === true
      || (this.fullscreen === undefined && insideFocusSecondary)
    return { expanded, fullReveal, expandHint }
  }

  private componentForMessage(message: TranscriptMessage, boundary: number): Component {
    // Focus-expanded turns reveal their process TIMELINE (plan §15.1 +
    // the secondary-disclosure supplement): in FULLSCREEN the foldable
    // process cards default COMPACT inside an open Thought and only the
    // per-card override full-reveals them; in REGULAR any expanded root
    // full-reveals (no mouse, no dead compact cards). Collapsed Focus
    // turns never reach this method: their process rows are absent from
    // the projection.
    const state = this.messageRenderState(message, boundary)
    // M7 (plan §12.1): the cache identity embeds the RENDERER id + the
    // registry revision — a renderer registering/unloading rebuilds the
    // affected components (an HMR must never hit an old component).
    const entry = this.messageComponents.get(message)
    if (entry === undefined) {
      const built = this.buildMessage(message, boundary, state)
      this.captureComponentState(built, message)
      this.messageComponents.set(message, built)
      return built.component
    }
    // Staleness: fold boundary, theme revision, expansion, the full-reveal
    // flag, the click-hint owner, the RENDERER identity (registry revision
    // changed → the winner may differ), or the message's own content. The
    // registry revision comparison is the CHEAP gate (plan §23): renderer
    // functions run only inside buildMessage, never for unchanged content.
    const rendererRevisionChanged = this.renderers !== undefined && entry.rendererRevision !== this.renderers.snapshot().revision
    if (entry.boundary !== boundary || entry.themeRev !== this.themeRevision
      || entry.expanded !== state.expanded
      || entry.fullReveal !== state.fullReveal
      || entry.expandHint !== state.expandHint
      || rendererRevisionChanged
      || this.componentStale(entry, message)) {
      // Dispose the OLD component (a thumbnail's loader subscription) so a
      // rebuild never leaks listeners (round-1 finding 7).
      const previous = entry.component as { dispose?: () => void } | undefined
      if (previous?.dispose !== undefined) {
        try {
          previous.dispose()
        } catch {
          // Best effort: a cached component's dispose must not break a paint.
        }
      }
      const rebuilt = this.buildMessage(message, boundary, state)
      entry.component = rebuilt.component
      entry.boundary = rebuilt.boundary
      entry.themeRev = rebuilt.themeRev
      entry.expanded = rebuilt.expanded
      entry.fullReveal = rebuilt.fullReveal
      entry.expandHint = rebuilt.expandHint
      entry.rendererId = rebuilt.rendererId
      entry.rendererRevision = rebuilt.rendererRevision
      this.captureComponentState(entry, message)
    }
    return entry.component
  }

  /**
   * Build one message's component + renderer identity in a SINGLE pass
   * (round-1 finding 1: the recorded identity always matches the view
   * actually built). When the renderer registry is present, the plugin
   * chain runs ONCE here and its result — view + rendererId + the
   * registry revision (even for a HOST-fallback entry — round-1 finding
   * 2) — is what the cache stores. Renderers never run in the frame loop
   * for unchanged content (plan §23).
   */
  private buildMessage(
    message: TranscriptMessage,
    boundary: number,
    state: { expanded: boolean; fullReveal: boolean; expandHint: ExpandHint },
  ): MessageComponentEntry {
    const registry = this.renderers
    const rendered = registry === undefined ? undefined : this.renderThroughExtensions(message, state.expanded)
    return {
      // The EFFECTIVE expansion (the surface-adaptive rule) drives the
      // renderer: fullscreen secondaries default compact (per-card
      // override full-reveals), regular expanded roots full-reveal.
      component: rendered === undefined
        ? this.renderMessage(message, state.expanded, state.expandHint, state.fullReveal)
        : rendered.component,
      boundary,
      themeRev: this.themeRevision,
      expanded: state.expanded,
      fullReveal: state.fullReveal,
      expandHint: state.expandHint,
      rendererId: rendered?.rendererId,
      rendererRevision: registry === undefined ? undefined : registry.snapshot().revision,
    }
  }

  /** Record the message values a component was built from. */
  private captureComponentState(entry: MessageComponentEntry, message: TranscriptMessage): void {
    switch (message.kind) {
      case 'user':
      case 'assistant':
      case 'thinking':
      case 'system':
        entry.text = message.text
        entry.content = message.kind === 'user' || message.kind === 'assistant' ? message.content : undefined
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
        entry.resultBlocks = message.resultBlocks
        break
      case 'summary':
        break
      case 'compaction':
        entry.text = message.text
        entry.items = message.items
        entry.tokens = message.tokens
        entry.running = message.running
        entry.errorText = message.error
        break
    }
  }

  /** Whether the message content changed since the component was built. */
  private componentStale(entry: MessageComponentEntry, message: TranscriptMessage): boolean {
    switch (message.kind) {
      case 'user':
      case 'assistant':
        return entry.text !== message.text || entry.content !== message.content
      case 'thinking':
        return entry.text !== message.text || entry.running !== message.running
      case 'system':
        return entry.text !== message.text || entry.label !== message.label || entry.summary !== message.summary
      case 'tool':
        return entry.status !== message.status || entry.args !== message.args
          || entry.result !== message.result || entry.meta !== message.meta || entry.members !== message.members
          || entry.error !== message.error || entry.resultBlocks !== message.resultBlocks
      case 'summary':
        return false
      case 'compaction':
        return entry.text !== message.text || entry.items !== message.items
          || entry.tokens !== message.tokens || entry.running !== message.running
          || entry.errorText !== message.error
    }
  }

  /**
   * Render one transcript message as a pi-tui component — the HOST
   * renderer (M7: extensions are consulted by buildMessage, which owns
   * the plugin chain + identity; renderMessage itself never re-runs a
   * renderer, so a throwing renderer is invoked exactly once per build
   * and the host fallback is single-path).
   */
  /**
   * Render a message's content blocks IN ORDER (plan §15.2): text blocks
   * fold into one text component per run, image blocks render as inline
   * thumbnails between them — `[text, image, text]` stays `text → image →
   * text` on screen. Other block kinds (reasoning/tool-call) are skipped
   * exactly like the flat `textWithImageMarkers` path. Only reached when
   * the loader and theme are wired.
   */
  private renderBlockSequence(
    content: readonly import('@deepseek-ai/dsh-llm').ContentBlock[],
    makeText: (text: string) => Component,
    message: TranscriptMessage,
  ): Component {
    if (this.imageLoader === undefined || this.imageTheme === undefined) {
      // Loader-less hosts keep the image POSITION as an inline marker — a
      // mixed message must never silently lose its images (the fold's flat
      // text uses the same projection).
      return makeText(textWithImageMarkers(content))
    }
    const container = new Container()
    let buffer = ''
    const flush = (): void => {
      if (buffer !== '') {
        container.addChild(makeText(buffer))
        buffer = ''
      }
    }
    let imageIndex = 0
    for (const block of content) {
      if (block.type === 'text') {
        buffer += block.text
      } else if (block.type === 'image') {
        flush()
        container.addChild(new ImageThumbnail(
          block.attachment as import('./image/admission.ts').ImageAttachmentRefLike,
          this.imageLoader,
          this.imageTheme,
          this.occurrenceCollapsedRef(message, imageIndex),
        ))
        imageIndex += 1
      }
    }
    flush()
    return container
  }

  /**
   * A user message with images: ONE bubble whose text keeps an inline
   * `🖼️ name` placeholder at every image's ORIGINAL position — the user's
   * own words then read like the draft they submitted (`what is this 🖼️
   * shot.png`), instead of a bubble with the image silently moved to its
   * own row. The thumbnails follow as attachment rows in block order; the
   * bubble marker carries the position, the thumbnail carries the picture.
   */
  private renderUserBlocks(
    content: readonly import('@deepseek-ai/dsh-llm').ContentBlock[],
    message: TranscriptMessage,
  ): Component {
    const container = new Container()
    container.addChild(new UserBubbleComponent(
      new Text(textWithImageMarkers(content), 0, 0),
      `${color.roleUser('❯')} `,
      color.roleUserBg,
    ))
    let imageIndex = 0
    for (const block of content) {
      if (block.type === 'image') {
        container.addChild(new ImageThumbnail(
          block.attachment as import('./image/admission.ts').ImageAttachmentRefLike,
          this.imageLoader!,
          this.imageTheme!,
          this.occurrenceCollapsedRef(message, imageIndex),
        ))
        imageIndex += 1
      }
    }
    return container
  }

  private renderMessage(message: TranscriptMessage, expanded: boolean, expandHint: ExpandHint, fullReveal: boolean): Component {
    if (message.kind === 'user') {
      // dsh-web parity: the user's own input is a floating BUBBLE (its
      // `--dsw-specific-bubble` background block) with a brand-blue ❯ —
      // never kimi's amber text colour, and never the assistant's whale
      // blue. The ❯ leads the FIRST line; wrapped continuation lines keep
      // the background and indent under the marker, so multi-line input
      // stays aligned inside one block.
      if (message.content !== undefined && this.imageLoader !== undefined && this.imageTheme !== undefined) {
        return this.renderUserBlocks(message.content, message)
      }
      return new UserBubbleComponent(
        new Text(message.text, 0, 0),
        `${color.roleUser('❯')} `,
        color.roleUserBg,
      )
    }
    if (message.kind === 'assistant') {
      // The whale bullet leads the FIRST markdown line; wrapped continuation
      // lines indent under it (kimi prefix+indent parity), so the bullet
      // never floats alone on its own row. The markdown stays a LIVE child:
      // a terminal resize re-renders it at the new width, so tables reflow
      // instead of re-wrapping a frozen render (the 5a76526 regression).
      if (message.content !== undefined && this.imageLoader !== undefined && this.imageTheme !== undefined) {
        return this.renderBlockSequence(message.content, (text) =>
          new BulletedComponent(new Markdown(text, 0, 0, markdownTheme), `${color.primary('🐋')}  `), message)
      }
      return new BulletedComponent(new Markdown(message.text, 0, 0, markdownTheme), `${color.primary('🐋')}  `)
    }
    if (message.kind === 'thinking') {
      // The unified Thinking disclosure card (plan §4/§13): COMPACT is
      // the width-aware ThinkingCompactComponent — its rows truncate AT
      // RENDER TIME to the current terminal width, so a resize keeps the
      // fixed three-row geometry and never freezes a stale truncation
      // (the message cache does not key on width). FULL stays a plain
      // Text: the `▾ Thinking` title plus the whole reasoning body
      // (dim+italic so reasoning never reads like the assistant's actual
      // output), wrapping normally per the Text/Markdown policy; the
      // compact preview is never repeated next to the full body.
      if (!expanded) {
        return new ThinkingCompactComponent(message, expandHint)
      }
      const head = color.textDim('▾ Thinking')
      const body = message.text === '' ? '' : message.text.split('\n').map(line => `  ${line}`).join('\n')
      return new Text([head, color.textDimItalic(body)].filter(line => line !== '').join('\n'), 0, 0)
    }
    if (message.kind === 'system') {
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
          // never mistaken for the assistant's actual output. XML-framed
          // envelopes (the skill loader's `<skill_content>` body, the skill
          // catalog and workspace instructions' `<system-reminder>` frame)
          // render their parsed content line by line — never the raw tags
          // (the same no-XML rule as the read/write/skill tool cards); a
          // malformed skill envelope renders no body at all. Plain context
          // text keeps the raw-body behavior.
          const body = systemContextBody(message.text)
          if (body === undefined) {
            row.addChild(new Text(color.textDim(message.text), 0, 0))
          } else {
            for (const line of body) {
              row.addChild(new Text(color.textDim(line), 0, 0))
            }
          }
        } else {
          // The folded row shows the producer's one-line account, falling
          // back to the skill envelope's instruction count (the tool-card
          // `— N lines of instructions` suffix) when the row is a skill
          // injection without a summary, so the fold still says something
          // about what the model received.
          const summary = message.summary === undefined
            ? skillFoldedPreview(message.text)
            : ` — ${message.summary}`
          // Folded rows truncate to one line: a long label/summary must not
          // wrap the context row (same rule as folded thinking).
          row.addChild(new Text(truncateToWidth(
            color.textMuted(`${emoji}  Context injection ${message.label}${summary} (${expandHint ?? 'ctrl+o'} to expand)`),
            this.terminal.columns,
            '…',
          ), 0, 0))
        }
        return row
      }
      const unwrapped = systemContextBody(message.text)?.join('\n') ?? message.text
      const text = expanded
        ? `${color.textMuted('§')} ${color.textDim(unwrapped)}`
        : color.textMuted(`§ ${truncateToWidth(preview(unwrapped, 2), Math.max(1, this.terminal.columns - 22), '…')} (${expandHint ?? 'ctrl+o'} to expand)`)
      return new Text(text, 0, 0)
    }
    if (message.kind === 'summary') {
      // Windowing: turns older than the display window collapse to one line.
      return new Text(color.textDim(message.text), 0, 0)
    }
    if (message.kind === 'compaction') {
      // Compaction card (web CompactionItem parity): a title row with the
      // shadowed item/token counts, expandable to the summary body. The
      // running card shows "Compacting context…" until the summary lands.
      const title = message.error !== undefined
        ? color.error('🗜 Compaction failed')
        : message.running === true
          ? color.textMuted('🗜 Compacting context…')
          : color.text('🗜 Context compacted')
      const counts = (message.items > 0 || message.tokens > 0)
        ? `Compacted ${message.items} history item${message.items === 1 ? '' : 's'} (~${message.tokens} tokens)`
        : ''
      const card = new Container()
      card.addChild(new Text(title, 0, 0))
      if (expanded) {
        if (counts !== '') card.addChild(new Text(color.textDim(counts), 0, 0))
        if (message.text !== '') {
          card.addChild(new Markdown(message.text, 0, 0, markdownTheme))
        } else if (message.error !== undefined) {
          card.addChild(new Text(color.textDim(message.error), 0, 0))
        }
      } else {
        const summary = counts === '' ? '' : counts
        card.addChild(new Text(truncateToWidth(
          color.textDim(`${summary}${summary === '' ? '' : ' '}(${expandHint ?? 'ctrl+o'} to expand)`),
          this.terminal.columns,
          '…',
        ), 0, 0))
      }
      return card
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
    // LOCAL `!`/`!!` shell cards read the master Ctrl+O switch (plan §5.3),
    // never the unbounded turn marker: collapsed by default so a long log
    // cannot fill the TUI, expanded only while Ctrl+O is on.
    const localShell = isLocalShellCard(message)
    if (expanded) {
      card.addChild(new Text(head, 0, 0))
      // An explicitly expanded card renders diff bodies in full; the
      // default recent-turn view caps them (kimi parity). The flag is
      // the FULL REVEAL: the per-card override (the fullscreen secondary
      // disclosure) or any REGULAR Focus expanded root — a capped diff in
      // regular mode would have no mouse affordance to open it.
      this.renderToolBody(card, message, fullReveal)
    } else {
      // Folded cards render 2–3 rows instead of one cramped line: the header
      // row, then the call preview (bash `$ command` / edit-write diff —
      // kimi parity: the command and the change are visible without
      // expanding), then the result preview. Read cards keep the envelope
      // summary (`— N lines`), never a dump of the raw XML. Every row
      // truncates to the terminal width, so a folded block never wraps.
      // LOCAL `!`/`!!` shell cards get their OWN folded layout (plan §5.1):
      // the command row plus the newest 5 (running) / 20 visual (settled)
      // rows of output with a hidden-count marker — a long log previews
      // instead of filling the TUI.
      if (localShell) {
        this.renderLocalShellFolded(card, message, head)
        return card
      }
      const rows: string[] = []
      const callPreview = parseCallPreview(message.name, message.args)
      // The header already carries friendly summaries (todo counts, web
      // query/url via SUMMARY_KEYS, skill name via the first string arg),
      // so the folded preview only adds a tool identity when the header
      // summary is empty (e.g. an arg shape the generic derivation cannot
      // read). Web/skill/todo never need it — their headers are friendly.
      const foldedCall = header.summary === '' ? foldedCallPreview(message.name, message.args) : ''
      let resultPreview: string
      if (message.name === 'read') {
        resultPreview = readFoldedPreview(message.result)
      } else if (message.name === 'write') {
        // The write tool's result is an XML confirmation envelope
        // (`<path>…</path> <type>…</type> <content>Updated file</content>`,
        // no content echo). The folded row shows the verb (` — Updated`),
        // never the raw envelope — the same no-XML rule as read cards; a
        // malformed envelope shows no preview at all.
        resultPreview = writeFoldedPreview(message.result)
      } else if (message.name === 'skill') {
        // The skill tool's result is a `<skill_content>` instruction block.
        // The folded row shows the instruction size (` — N lines of
        // instructions`); the header already carries `skill · <name>`.
        resultPreview = skillFoldedPreview(message.result)
      } else if (message.name === 'read_image') {
        // read_image's result is a `<path>/<type>image/<content>` envelope
        // (the companion block is the image payload, never text). The
        // folded row shows the content summary (e.g. ` — PNG image ·
        // 800x600 px`), never the raw envelope.
        resultPreview = imageFoldedPreview(message.result)
      } else if (message.name === 'ask_user_question') {
        // The folded preview never shows the raw `{"answers":[…]}` JSON the
        // tool's render text carries (Web AskQuestionRow parity): the
        // answered-count summary replaces it when parseable. A FAILED call
        // shows no summary at all (its error identity is the verdict), and
        // an unparseable result shows no preview either — the no-JSON
        // contract holds even for malformed text.
        const summary = message.error === undefined ? askAnswersSummary(message.result) : undefined
        resultPreview = summary === undefined ? '' : ` — ${summary}`
      } else if (GOAL_TOOL_NAMES.has(message.name)) {
        // Same rule for the goal family: the folded preview summarizes the
        // `{"goal":…}` result (`phase active · revision 3 · 2/6 rounds`,
        // `no goal set`) instead of dumping raw JSON; failed calls and
        // unparseable results show no preview.
        const summary = message.error === undefined ? goalResultSummary(message.result) : undefined
        resultPreview = summary === undefined ? '' : ` — ${summary}`
      } else if (FOLDED_JSON_RESULT_TOOLS.has(message.name)) {
        // Web parity: the folded row never shows the result JSON. The TUI
        // keeps its result-preview row but shows a parsed summary (ralph:
        // its friendly first line; schedule/cordis: derived phrases) — and
        // NO preview at all when nothing can be derived, never raw JSON.
        // A failed call's summary doubles as its error identity (e.g. a
        // schedule error object's code), so it is NOT suppressed.
        const summary = foldedResultSummaryFor(message.name, message.result)
        resultPreview = summary === undefined || summary === '' ? '' : ` — ${summary}`
      } else if (XML_ENVELOPE_RESULT_TOOLS.has(message.name) && message.result.trimStart().startsWith('<')) {
        // Defensive: every XML-envelope tool above (read/write/skill/
        // read_image) has its own parser branch, so this arm only fires
        // when a NEW envelope tool is added without registering its parser
        // here. Register it in XML_ENVELOPE_RESULT_TOOLS and add the
        // branch — never let an envelope fall through to the raw preview.
        resultPreview = ''
      } else {
        resultPreview = message.result === ''
          ? ''
          : ` — ${preview(message.result, RESULT_PREVIEW_LINES)}`
      }
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
          rows.push(color.textDim(`${indent}… ${commandLines.length - FOLDED_COMMAND_LINES} more command lines (${expandHint ?? 'ctrl+o'} to expand)`))
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
          expandHint: `${expandHint ?? 'ctrl+o'} to expand`,
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
   * M7: present one message through the plugin renderer registry. Returns
   * the compiled component, or undefined (host fallback). The tool branch
   * uses the keyed tool renderer; other kinds use the message chain.
   * @param message - the transcript message.
   * @param boundary - the fold boundary (the snapshot's expanded state).
   */
  private renderThroughExtensions(
    message: TranscriptMessage,
    expanded: boolean,
  ): { component: Component; rendererId: string } | undefined {
    const registry = this.renderers
    if (registry === undefined) return undefined
    const snapshot = this.semanticSnapshotOf(message)
    if (snapshot === undefined) return undefined
    if (snapshot.kind === 'tool' && snapshot.tool !== undefined) {
      // The tool snapshot's expanded state is the SAME effective rule the
      // host renderer uses (the secondary-disclosure rule) — a plugin
      // renderer must never see a recent tool as expanded inside an open
      // Thought when the host keeps it compact (review finding).
      const tool = { ...snapshot.tool, expanded }
      const compiled = new Map<string, Component>()
      const rendered = registry.renderTool(tool, (id, error) => this.rendererError?.({ id, error, slot: 'tool' }), (id, view) => {
        const component = this.compileExtensionViewIsolated(view, id, 'tool')
        if (component === undefined) return false
        compiled.set(id, component)
        return true
      })
      if (rendered === undefined) return undefined
      const component = compiled.get(rendered.rendererId) ?? this.compileExtensionViewIsolated(rendered.view, rendered.rendererId, 'tool')
      if (component === undefined) return undefined
      // P1-08: a SUCCESSFUL render clears the renderer's failure record.
      this.rendererRecovered?.({ id: rendered.rendererId, slot: 'tool' })
      return { component, rendererId: rendered.rendererId }
    }
    const compiled = new Map<string, Component>()
    const rendered = registry.renderMessage(snapshot, (id, error) => this.rendererError?.({ id, error, slot: 'message' }), (id, view) => {
      const component = this.compileExtensionViewIsolated(view, id, 'message')
      if (component === undefined) return false
      compiled.set(id, component)
      return true
    })
    if (rendered === undefined) return undefined
    const component = compiled.get(rendered.rendererId) ?? this.compileExtensionViewIsolated(rendered.view, rendered.rendererId, 'message')
    if (component === undefined) return undefined
    // P1-08: a SUCCESSFUL render clears the renderer's failure record.
    this.rendererRecovered?.({ id: rendered.rendererId, slot: 'message' })
    return { component, rendererId: rendered.rendererId }
  }

  /**
   * M7 (P1-07): compile a renderer-returned view INSIDE the per-renderer
   * isolation boundary. `RendererRegistry.render*` catches throws from
   * `record.render()`, but the returned view's compilation is a separate
   * hostile surface (a throwing `spans` getter, a broken tree shape) — a
   * compile failure must ABDICATE to the host card (undefined) like a
   * render throw, never escape into the render path. The failure is
   * recorded through the same bounded health sink.
   */
  private compileExtensionViewIsolated(view: ExtensionView, rendererId: string, slot?: 'message' | 'tool'): Component | undefined {
    try {
      return compileView(view).component
    } catch (error) {
      this.rendererError?.({ id: rendererId, error, slot })
      return undefined
    }
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
   * The folded (collapsed) layout of a LOCAL `!`/`!!` shell card (plan
   * §5.1): the card head, the `$ command` row, the newest preview rows
   * (5 source lines while running, up to 20 visual rows once settled),
   * and the hidden-count marker when content was cut. The capture layer
   * (bounded-output caps) is untouched — this is display policy only.
   * @param card - the card container to fill.
   * @param message - the local shell tool message (name 'shell', unbounded
   *   turn — see {@link isLocalShellCard}).
   * @param head - the already-rendered card head line.
   */
  private renderLocalShellFolded(
    card: Container,
    message: Extract<TranscriptMessage, { kind: 'tool' }>,
    head: string,
  ): void {
    const running = message.status === 'running'
    const indent = '  '
    const contentWidth = Math.max(1, this.terminal.columns - visibleWidth(indent) - 2)
    const budget = running ? RUNNING_PREVIEW_LINES : SETTLED_PREVIEW_VISUAL_ROWS
    const mode = running ? 'lines' : 'visual'
    const preview = localShellPreview(message.result, contentWidth, budget, mode)
    const rows = [truncateToWidth(head, this.terminal.columns, '…')]
    // The command row (kimi ShellExecution layout): the local shell card's
    // `args` IS the raw command string (never JSON).
    const prompt = color.shellMode('$ ')
    rows.push(`${indent}${prompt}${truncateToWidth(color.textDim(message.args), contentWidth, '…')}`)
    for (const line of preview.rows) {
      rows.push(`${indent}${truncateToWidth(color.textDim(line), contentWidth, '…')}`)
    }
    if (preview.hidden > 0) {
      rows.push(color.textDim(`${indent}${localShellHiddenMarker(preview.hidden, running, preview.partial)}`))
    }
    card.addChild(new Text(rows.join('\n'), 0, 0))
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
    // LOCAL `!`/`!!` shell cards render their own expanded body (plan
    // §5.1): the `$ command` row (the card's `args` IS the raw command
    // string, never JSON) plus the retained buffer — while running that is
    // the live bounded tail, once settled the final output. No presenter,
    // no diff, no image pipeline applies to a local run.
    if (isLocalShellCard(message)) {
      this.addTerminalCommandRow(card, message.args, '$ ')
      if (message.result !== '') {
        for (const line of message.result.split('\n')) {
          card.addChild(new Text(color.textDim(line), 0, 0))
        }
      }
      return
    }
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
      // A subagent-family call with an explicit model/provider override
      // shows it immediately (subagentModelDisplay renders nothing when the
      // call carries no override — official subagent calls stay unchanged).
      const modelLine = subagentModelDisplay(message.name, message.args)
      if (modelLine !== undefined) card.addChild(new Text(color.textDim(modelLine), 0, 0))
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
            else card.addChild(new Text(color.textDim(this.blockDisplayText(block)), 0, 0))
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
        // The expanded card carries the actual answers, one line per
        // question (`● id → answer`; skipped questions dimmed) — the
        // count alone would leave the user unable to recall their choices
        // once the question flow closed.
        const answerLines = askAnswersLines(message.result)
        if (answerLines !== undefined) {
          for (const line of answerLines) {
            card.addChild(new Text(`  ${line.skipped ? color.textMuted(line.text) : color.textDim(line.text)}`, 0, 0))
          }
        }
        return
      }
      // Unparseable or failed: fall through to the generic presentation.
    }
    // A settled goal tool (get_goal/create_goal/update_goal) renders its
    // `{"goal":…}` result as field lines (`● objective: …`, `● phase: … ·
    // revision N`, …), never the raw JSON the tool's render text carries.
    // A cancelled/aborted call shows the structured error identity instead.
    if (GOAL_TOOL_NAMES.has(message.name)) {
      if (message.error !== undefined) {
        card.addChild(new Text(color.textDim(`${message.error.name}: ${message.error.code}`), 0, 0))
        return
      }
      const goalLines = message.status === 'ok' ? goalResultLines(message.result) : undefined
      if (goalLines !== undefined) {
        for (const line of goalLines) {
          card.addChild(new Text(color.textDim(line), 0, 0))
        }
        return
      }
      // Unparseable or failed: fall through to the generic presentation.
    }
    if (message.result === '' && (message.resultBlocks?.length ?? 0) === 0) return
    // A settled subagent-family call keeps its model/provider line above the
    // result (only when the call args carried an explicit override).
    const settledModelLine = subagentModelDisplay(message.name, message.args)
    if (settledModelLine !== undefined) card.addChild(new Text(color.textDim(settledModelLine), 0, 0))
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
          // that content instead of the raw model-facing result text. Image
          // blocks render as thumbnails in order (round-4 finding 1) — the
          // same ordered renderer the no-presenter fallback uses; a
          // text-only generic view keeps the EXACT legacy per-block loop
          // (round-5 finding 3).
          //
          // Call presentation stays: a BACKGROUND bash/pwsh settles into a
          // generic "started background job …" result, so the expanded card
          // must keep the `$ command` row above it (call and result are two
          // stages, never substitutes — the 2026-08-22 plan). No-op for
          // every non-terminal tool (terminalCommand returns '').
          this.addTerminalCommandRow(card, this.terminalCommand(message.name, message.args), this.shellPrompt(message.name))
          const content = resultView.content ?? []
          if (content.length > 0) {
            const hasImages = content.some(block => block.type === 'image')
            if (hasImages && this.imageLoader !== undefined && this.imageTheme !== undefined) {
              let buffer = ''
              const flush = (): void => {
                if (buffer !== '') {
                  card.addChild(new Text(color.textDim(buffer), 0, 0))
                  buffer = ''
                }
              }
              for (const block of content) {
                if (block.type === 'text') {
                  buffer += block.text
                } else if (block.type === 'image') {
                  flush()
                  card.addChild(new ImageThumbnail(
                    block.attachment as import('./image/admission.ts').ImageAttachmentRefLike,
                    this.imageLoader,
                    this.imageTheme,
                  ))
                } else {
                  // Non-text/non-image blocks keep the legacy JSON form,
                  // interleaved in order (round-5 finding 4).
                  flush()
                  card.addChild(new Text(color.textDim(JSON.stringify(block, null, 2)), 0, 0))
                }
              }
              flush()
            } else {
              for (const block of content) {
                if (block.type === 'text') card.addChild(new Text(color.textDim(block.text), 0, 0))
                else card.addChild(new Text(color.textDim(this.blockDisplayText(block)), 0, 0))
              }
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
      // Malformed read result on a SUCCESSFUL call: render nothing rather
      // than the raw envelope (an error call falls through to the error
      // text below, which is not an envelope).
      if (message.status === 'ok') return
    }
    if (message.name === 'skill') {
      // Without a presenter (replay edge), the skill instruction envelope
      // renders its instructions body + name, never the raw XML.
      const envelope = parseSkillEnvelope(message.result)
      if (envelope !== undefined) {
        card.addChild(new Text(color.textMuted(`  skill: ${envelope.name}`), 0, 0))
        for (const line of envelope.instructions.split('\n')) {
          card.addChild(new Text(color.textDim(line), 0, 0))
        }
        return
      }
      if (message.status === 'ok') return
    }
    if (message.name === 'read_image') {
      // Without a presenter, the image envelope renders its summary + path,
      // never the raw XML; the image payload block is never dumped as JSON
      // (resultTextLines projects image blocks to a placeholder). With the
      // image pipeline wired, the RESULT image blocks render as thumbnails
      // below the summary (the envelope summary + the actual pixels).
      const envelope = parseImageEnvelope(message.result)
      if (envelope !== undefined) {
        card.addChild(new Text(color.textDim(`  ${envelope.summary}`), 0, 0))
        card.addChild(new Text(color.textMuted(`  path: ${relativizeToCwd(envelope.path, this.workspaceRoot)}`), 0, 0))
        this.renderResultImageBlocks(card, message.resultBlocks)
        return
      }
      if (message.status === 'ok') {
        this.renderResultImageBlocks(card, message.resultBlocks)
        return
      }
    }
    if (message.name === 'write') {
      // Without a presenter (replay edge), the write confirmation envelope
      // renders its verb + path, never the raw XML (read-card rule).
      const envelope = parseWriteEnvelope(message.result)
      if (envelope !== undefined) {
        card.addChild(new Text(color.textDim(
          `  ${envelope.verb} ${relativizeToCwd(envelope.path, this.workspaceRoot)}`,
        ), 0, 0))
        return
      }
      if (message.status === 'ok') return
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
      // joined text is the only material. Result IMAGE blocks render as
      // inline thumbnails in order when the image pipeline is wired (plan
      // M11: covers read-image, MCP image results, screenshot tools).
      const blocks = message.resultBlocks ?? []
      const hasResultImages = blocks.some(block => block.type === 'image')
      if (hasResultImages && this.imageLoader !== undefined && this.imageTheme !== undefined) {
        let buffer = ''
        const flush = (): void => {
          if (buffer !== '') {
            card.addChild(new Text(color.textDim(buffer), 0, 0))
            buffer = ''
          }
        }
        for (const block of blocks) {
          if (block.type === 'text') {
            buffer += block.text
          } else if (block.type === 'image') {
            flush()
            card.addChild(new ImageThumbnail(
              block.attachment as import('./image/admission.ts').ImageAttachmentRefLike,
              this.imageLoader,
              this.imageTheme,
            ))
          } else {
            // Non-text/non-image blocks keep the legacy JSON form, in order
            // (round-5 finding 4).
            flush()
            card.addChild(new Text(color.textDim(JSON.stringify(block, null, 2)), 0, 0))
          }
        }
        flush()
      } else {
        const lines = blocks.length > 0
          ? resultTextLines(blocks, message.status === 'error' ? { name: 'error', code: 'tool' } : undefined)
          : [message.result]
        for (const line of lines) {
          card.addChild(new Text(color.textDim(line), 0, 0))
        }
      }
    }
  }

  /**
   * Display form for a non-text block WITHOUT the image pipeline: image
   * blocks project to a compact placeholder — never a JSON dump (the
   * read_image envelope rule, review finding); everything else keeps the
   * legacy pretty-JSON form.
   */
  private blockDisplayText(block: import('@deepseek-ai/dsh-llm').ContentBlock): string {
    if (block.type === 'image') return '[image]'
    return JSON.stringify(block, null, 2)
  }

  /** Append the result's IMAGE blocks as thumbnails (any tool card that
   * returns images but has its own summary path — read_image today, MCP
   * image results and screenshot tools next). No-op without the pipeline
   * or without image blocks. */
  private renderResultImageBlocks(
    card: Container,
    blocks: readonly import('@deepseek-ai/dsh-llm').ContentBlock[] | undefined,
  ): void {
    if (blocks === undefined || this.imageLoader === undefined || this.imageTheme === undefined) return
    for (const block of blocks) {
      if (block.type === 'image') {
        card.addChild(new ImageThumbnail(
          block.attachment as import('./image/admission.ts').ImageAttachmentRefLike,
          this.imageLoader,
          this.imageTheme,
        ))
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
    // M9: a cheap editor-winner reconciliation on every render request —
    // the registry's invalidation (register/unload) funnels here through
    // the service batcher → SurfaceHost sink. The compare is O(1) when
    // unchanged (id comparison), so the frame loop cost is negligible
    // (plan §23).
    this.reconcileEditorWinner()
    // P1-1: a renderer register/unload bumps the registry revision — the
    // message cache embeds it, so the affected transcript components must
    // be REBUILT on this render (never waiting for a key, resize, session
    // event or setStatus). O(1) gate; the rebuild itself only re-runs
    // renderers for entries whose identity changed (plan §23).
    if (this.renderers !== undefined) {
      const revision = this.renderers.revisionOf()
      if (revision !== this.lastRendererRevision) {
        this.lastRendererRevision = revision
        this.rebuildMessages()
      }
    }
    // Live surface geometry (P1-1): the fork consumes the terminal resize
    // callback internally, so the extension surface slice is refreshed
    // from the CURRENT terminal geometry on every render — a resize lands
    // here on the first repaint after the event.
    this.syncSurfaceGeometry()
    ;(this.fullscreen ?? this.tui).requestRender(force)
  }

  /** Mirror the live terminal geometry into the extension surface slice
   * (width/height) when it changed; also refreshes focusedSeat from the
   * current mode. Cheap: no-op unless a value differs. A WIDTH change
   * re-bakes the width-budgeted outlets (dock/footer) and re-merges the
   * chrome on the spot, so a resize lands on the first repaint after the
   * event (follow-up P1: the footer must not keep the old segment set at
   * the new width). */
  private syncSurfaceGeometry(): void {
    // Re-entrancy guard (review finding 4): the resize callback can fire
    // while a width change is already being applied (a terminal that
    // re-reports size during start/restart, or refreshChrome's own render
    // request). A nested call would re-bake the outlets and re-merge the
    // chrome mid-pass; the outer pass already reads the CURRENT geometry,
    // so the nested call has nothing new to add — drop it.
    if (this.syncingSurfaceGeometry) return
    this.syncingSurfaceGeometry = true
    try {
      const width = this.terminal.columns
      const height = this.terminal.rows
      // Phase 2: a terminal resize recompiles every live ADVANCED overlay
      // wrapper — the plugin's render(ctx) must see the new geometry (the
      // compiled view itself re-wraps at the current width per frame, but
      // the plugin's render() output is only re-read on invalidate). Runs
      // even without an extension host (tests mount advanced overlays
      // directly on the app); the last-geometry latch keeps it resize-only.
      if (width !== this.lastAdvancedGeometry.width || height !== this.lastAdvancedGeometry.height) {
        this.lastAdvancedGeometry = { width, height }
        this.recompileAdvancedOverlays()
      }
      const host = this.extensionHost
      if (host === undefined) return
      const current = host.state().surface
      // focusedSeat derives from the actual focus state (follow-up P1): the
      // seat tracker is updated by showOverlayOnHost/closeOverlayHandle/
      // question/approval/fullscreen entry; the requestRender mirror only
      // publishes it here (plus the stale-frame safety net below). The LIVE
      // focusSeat (not the microtask-published copy) is authoritative — a
      // publish that changed nothing must still mirror the real seat.
      this.publishFocusSeat()
      const focusedSeat = this.focusSeat
      if (current.width !== width || current.height !== height || current.focusedSeat !== focusedSeat) {
        host.updateSurface({ width, height, focusedSeat })
        if (current.width !== width) {
          // The outlet budgets are baked from the snapshot width: re-bake
          // the width-budgeted outlets (dock + footer) and re-merge the
          // chrome rows NOW, so the new width takes effect immediately —
          // waiting for the next extension invalidation would keep the old
          // low/high segment set baked at the stale width (follow-up P1).
          host.refreshOutlets()
          this.refreshChrome()
        }
      }
    } finally {
      this.syncingSurfaceGeometry = false
    }
  }

  /**
   * Recompute the focused seat from the live focus state and publish it
   * through one coalesced microtask. The seat is derived from the ACTUAL
   * focused capturing surface (follow-up P1): the search input, a picker,
   * settings, the task browser, an approval dialog or a question flow all
   * report 'overlay' while they own input — never a stale 'editor'.
   */
  private publishFocusSeat(): void {
    const question = this.activeQuestions
    if (question !== undefined) {
      this.setFocusSeat('overlay')
      return
    }
    if (this.activeApproval !== undefined) {
      this.setFocusSeat('overlay')
      return
    }
    const screen = this.activeScreen
    if (!this.disposed && screen.hasOverlayEntries && screen.getFocusedComponent() !== null) {
      this.setFocusSeat('overlay')
      return
    }
    this.setFocusSeat('editor')
  }

  /** Set the current focus seat and schedule one coalesced snapshot publish
   * when it changed (a burst of mount/close calls in one tick delivers ONE
   * update — same batching contract as the state store). */
  private setFocusSeat(seat: 'editor' | 'overlay' | 'editor-panel' | 'none'): void {
    if (this.focusSeat === seat) return
    this.focusSeat = seat
    if (this.focusSeatPublishScheduled || this.disposed) return
    this.focusSeatPublishScheduled = true
    queueMicrotask(() => {
      this.focusSeatPublishScheduled = false
      if (this.disposed) return
      this.publishedFocusSeat = this.focusSeat
      this.extensionHost?.updateSurface({ focusedSeat: this.publishedFocusSeat })
    })
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
    // Hiding resets the expansion: the next Ctrl+T shows the compact panel.
    if (!this.todoPanelVisible) this.todoExpanded = false
    this.renderTodoPanel()
    // The dock summary hides while the panel is expanded (it would sit on
    // top of the full list); restore it on collapse.
    this.renderDock()
    this.requestRender()
    return this.todoPanelVisible
  }

  /** Toggle the todo panel between the compact five rows and the full list
   * (fullscreen click on the panel's area). */
  toggleTodoExpanded(): boolean {
    if (!this.todoPanelVisible) return false
    this.todoExpanded = !this.todoExpanded
    this.renderTodoPanel()
    this.requestRender()
    return this.todoExpanded
  }

  /** The fullscreen click loop over the todo panel's own rows: compact →
   * full list → back to the summary row (the panel closes). The mouse thus
   * opens AND closes the panel without Ctrl+T; the dock summary row itself
   * opens it (handleFullscreenClick's dock region). */
  private handleTodoPanelClick(): void {
    if (this.todoExpanded) this.toggleTodoPanel()
    else this.toggleTodoExpanded()
  }

  /** Whether the todo panel is currently shown. */
  isTodoPanelVisible(): boolean {
    return this.todoPanelVisible
  }

  /** Whether the todo panel is showing the full list (headless-test hook). */
  isTodoPanelExpanded(): boolean {
    return this.todoExpanded
  }

  /**
   * Rebuild the todo panel text: a border rule + `Todo` title (both indented
   * one cell) plus up to five rows by default (in_progress first, then
   * pending, then completed (strikethrough)); the full list when expanded
   * (fullscreen click on the panel toggles).
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
    ]
    const shown = this.todoExpanded ? ordered : ordered.slice(0, 5)
    const width = Math.max(1, this.terminal.columns)
    const border = color.border(` ${'─'.repeat(Math.max(0, width - 2))} `)
    // Title: bold, two-cell indent.
    const title = color.textStrong('  Todo')
    if (shown.length === 0) {
      this.todoPanel.setText([border, title].join('\n'))
      return
    }
    const lines = shown.map(todo => {
      const body = todo.status === 'completed' ? `\x1b[9m${todo.content}\x1b[29m` : todo.content
      return `${mark(todo)} ${body}`
    })
    this.todoPanel.setText([border, title, ...lines].join('\n'))
  }

  /** Whether Thinking blocks currently render FULL (true) or COMPACT with
   * a preview (false). The single Thinking disclosure preference — shared
   * by Focus ON/OFF and both surfaces (plan §5.2). */
  isThinkingExpanded(): boolean {
    return this.thinkingExpanded
  }

  /** Set the Thinking detail bulk preference directly (the declarative
   * surface — `/settings` uses this; Alt+T uses the toggle). Clears
   * every per-card Thinking override FIRST, exactly like Alt+T: a
   * declarative value is a bulk statement ("all Thinking at this level"),
   * so a stale fullscreen click or search reveal must never partially
   * counteract it (review finding). Repaints even when the value is
   * unchanged, if the clear changed any effective state. */
  setThinkingExpanded(expanded: boolean): void {
    const hadOverrides = this.clearThinkingExpansionOverrides()
    if (this.thinkingExpanded === expanded && !hadOverrides) return
    this.thinkingExpanded = expanded
    this.rebuildMessages()
  }

  /** Drop every per-message Thinking override. Alt+T calls this FIRST so
   * the bulk toggle is never partially counteracted by stale per-card
   * states (plan §9): the user asked for ALL Thinking at one detail
   * level, so old click/search overrides must not survive. Also used by
   * the fullscreen → regular transition (plan §6.2's preferred cleanup:
   * regular must never re-read a fullscreen click state) and by the
   * declarative /settings setter. Iterates the OVERRIDE MAP — the
   * visible transcript is windowed, so a clicked card that scrolled out
   * of the window must still be reset (a later search jump or window
   * restore must never resurrect a stale per-card state).
   * @returns whether any override was removed (the caller must repaint
   *   when true, even if the bulk value did not change). */
  private clearThinkingExpansionOverrides(): boolean {
    let removed = false
    for (const message of this.expandedOverride.keys()) {
      if (message.kind !== 'thinking') continue
      this.expandedOverride.delete(message)
      removed = true
    }
    return removed
  }

  /** Alt+T: bulk collapse/expand every Thinking block (the disclosure
   * owner). Clears per-message overrides first so the outcome is
   * predictable: Alt+T expand → ALL Thinking full; Alt+T collapse →
   * ALL Thinking compact (plan §9). */
  toggleThinkingExpanded(): boolean {
    this.clearThinkingExpansionOverrides()
    this.thinkingExpanded = !this.thinkingExpanded
    this.rebuildMessages()
    return this.thinkingExpanded
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
    // Layout budgets are host-owned (plan §19, follow-up P1): renderHeader
    // derives the header badge budget from the CURRENT terminal width on
    // every render, renderDock owns the dock row budget, and the footer
    // outlet is bounded by the terminal width inside its own refresh.
    this.renderHeader()
    this.renderFooter()
    this.renderDock()
    this.renderGoalLine()
    this.renderWidgets()
    this.requestRender()
  }

  /** Rebuild the header from base + session title + plan badge + extension
   * badges. Colours are applied AT RENDER TIME from the live palette — the
   * semantic state (plan mode, title) is stored separately, so a theme
   * switch only has to re-run this. */
  private renderHeader(): void {
    // Host-owned header budget (plan §19, follow-up P1): the badge run gets
    // the width the HOST'S OWN header content leaves free — the fixed
    // prefix PLUS the session/viewer title and the plan/viewer badges
    // (a long title would otherwise consume the row and make the final
    // header wrap even though the badge run fits its own budget). Re-derived
    // on EVERY render so a resize or a title change re-bakes the budget.
    const badge = this.planMode ? ` ${color.warning('[plan]')}` : ''
    const viewerBadge = this.viewerMode === undefined ? '' : ` ${color.accent(
      isViewerAccessInteractive(resolveViewerAccess(this.viewerMode.mode, this.viewerMode.access))
        ? '[viewing subagent · continuable]'
        : this.viewerMode.access === 'readonly-nested'
          ? '[viewing subagent · nested · read-only]'
          : '[viewing subagent · one-shot · read-only]',
    )}`
    const title = this.viewerMode !== undefined
      ? ` · ${color.textMuted(this.viewerMode.label)}`
      : this.sessionTitleText === '' ? '' : ` · ${color.textMuted(this.sessionTitleText)}`
    const hostOwned = `🐋  dsh-pi-tui${title}${badge}${viewerBadge}`
    // The badge run gets what the host chrome leaves; -2 reserves the
    // trailing space + a safety cell so the composed row never wraps.
    this.extensionHost?.setHeaderBudget(Math.max(1, this.terminal.columns - visibleWidth(hostOwned) - 2))
    // Extension header badges append after the host chrome (M2): the host
    // title stays host-owned; badges add semantics like `[plan]`.
    const extensionBadges = this.extensionHost?.headerBadgeText() ?? ''
    this.header.setText(`${hostOwned}${extensionBadges}`)
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

  /** Notice rows shown in full before the `+N more` fold (user rows are never folded). */
  private static readonly MAX_NOTICE_ROWS = 5

  /** Rebuild the queue pane text from the current inbox rows. */
  private renderQueuePane(): void {
    const items = this.queueItems
    if (items.length === 0) {
      // An emptied pane must not leave its previously painted rows behind
      // (fork trap): the empty Text renders no lines and the requested
      // frame repaints the region.
      this.queuePane.setText('')
      this.requestRender()
      return
    }
    const width = Math.max(1, this.terminal.columns)
    // Panel border rules indent one cell on each side so the boundary never
    // reads as the editor's full-width border.
    const lines = [color.border(` ${'─'.repeat(Math.max(0, width - 2))} `)]
    // User-origin rows are the user's OWN queued input: always fully
    // visible, never folded. Notice rows (plugin notifications, subagent
    // reports, injected instructions) are at-a-glance transport only:
    // beyond MAX_NOTICE_ROWS they collapse into one `+N more` line, so a
    // backlog of child settlements can never flood the pane — the task
    // browser remains their browse surface, and each claimed notice drops
    // the count (and eventually the group) automatically.
    const userRows = items.filter(item => item.notice !== true)
    const noticeRows = items.filter(item => item.notice === true)
    const shownNotices = noticeRows.slice(0, TuiApp.MAX_NOTICE_ROWS)
    for (const item of userRows) {
      const text = item.text.replace(/\s+/g, ' ').trim()
      const truncated = truncateToWidth(text, Math.max(1, width - visibleWidth('❯ ')), '…')
      // User-origin rows carry the SAME brand-blue ❯ as the transcript
      // bubbles and the editor prompt — one marker for the user's own
      // input everywhere (pending here, delivered up there).
      lines.push(`${color.roleUser('❯')} ${truncated}`)
    }
    for (const item of shownNotices) {
      // Notices are NOT steerable: they carry their own ⏳ marker so they
      // never read as user input, and the hint below drops the steer/edit
      // verbs when nothing else is queued.
      const text = item.text.replace(/\s+/g, ' ').trim()
      const truncated = truncateToWidth(text, Math.max(1, width - visibleWidth('⏳ ')), '…')
      lines.push(`${color.textDim('⏳')} ${color.textDim(truncated)}`)
    }
    const folded = noticeRows.length - shownNotices.length
    if (folded > 0) {
      lines.push(color.textDim(truncateToWidth(
        `  +${folded} more notices pending · they deliver as the next turn runs`,
        Math.max(1, width - 2),
        '…',
      )))
    }
    const hasSteerable = userRows.length > 0
    const hint = hasSteerable
      ? 'ctrl+s to steer all · alt+↑ to edit all'
      : 'notices deliver after the current task · /tasks to view'
    lines.push(color.textDim(truncateToWidth(`  ${hint}`, Math.max(1, width - 2), '…')))
    this.queuePane.setText(lines.join('\n'))
    this.requestRender()
  }

  /**
   * Replace the editor draft wholesale (the Alt+↑ dequeue path pulls every
   * queued message back into the editor for editing). While a CONTINUABLE
   * subagent viewer covers the editor, the write goes to the CHILD's
   * draft slot + the visible editor; a ONE-SHOT viewer keeps the main
   * draft write (restored on exit).
   */
  setDraft(text: string): void {
    const target = this.viewerMode
    if (target !== undefined && isViewerAccessInteractive(resolveViewerAccess(target.mode, target.access))) {
      this.subagentDrafts.set(target.childSessionId, text)
      this.seatEditor().setText(text)
      this.editorSeatHolder.notifyChanged()
      this.requestRender()
      return
    }
    if (target !== undefined) {
      this.mainDraftBeforeViewer = text
      return
    }
    // M9: write the CURRENT seat occupant (host default or plugin editor).
    this.seatEditor().setText(text)
    this.editorSeatHolder.notifyChanged()
    this.requestRender()
  }

  /** The editor's current draft text (the Alt+↑ dequeue merge reads it).
   * In a continuable viewer the VISIBLE editor is the authority — it is
   * exactly what the user sees and submits: a replacement editor's edits
   * (through its own handleInput) never mirror through the host's
   * onChange, so the per-child slot may lag and must never be submitted
   * in the visible text's place. The slot remains the CROSS-SESSION
   * store (park on exit/switch, map-only stale restores, re-entry seed);
   * the visible text is the CURRENT-session truth. A one-shot viewer
   * returns the preserved main draft. */
  getDraft(): string {
    const target = this.viewerMode
    if (target === undefined) return this.seatEditor().getText()
    if (isViewerAccessInteractive(resolveViewerAccess(target.mode, target.access))) {
      return this.seatEditor().getText()
    }
    return this.mainDraftBeforeViewer ?? ''
  }

  /**
   * M6 host-owned draft submission (the semantic actions submit-draft /
   * queue-draft route through this, NOT a raw dispatch): mirrors the
   * editor's Enter-submit path exactly — history, notify clear and draft
   * clear — then fires the submit/queue event through the runner. The
   * plugin never touches the editor directly.
   * @param forceQueue - Ctrl+Enter parity: queue delivery regardless of
   *   the busyEnter preference.
   */
  submitDraft(forceQueue = false): void {
    // P1-12: a finally-disposed surface never submits — a late plugin
    // callback (or a stale host dispatch) must not produce a real
    // session-side effect after teardown.
    if (this.disposed) return
    const target = this.viewerMode
    const text = this.getDraft()
    // An image-only draft is NOT empty: the placeholder expansion resolves
    // it to real content blocks at submission (plan §11.1).
    if (text.trim() === '' && this.events.isImageDraft?.() !== true) return
    this.clearNotify()
    // Issue #8: a successful submit is a fresh explicit action — the armed
    // exit chord (and its footer hint) must not survive into the next
    // interaction.
    this.clearCtrlCExit()
    if (target !== undefined && isViewerAccessInteractive(resolveViewerAccess(target.mode, target.access))) {
      // A plugin action inside an interactive viewer submits to the
      // SUBAGENT (the semantic target of the visible editor), never the
      // parent — and the queue verb is meaningless for the child (its
      // inbox is the only queue). The draft restore on rejection is the
      // runner's job (onSubagentSubmit), exactly like the Enter path.
      // Viewer submissions never enter the shared editor history (an ↑
      // recall in the MAIN editor must not resend child-scoped text to
      // the parent). The per-child slot clears EXPLICITLY (a replacement
      // editor does not guarantee the onChange mirror).
      this.subagentDrafts.set(target.childSessionId, '')
      this.seatEditor().setText('')
      this.editorSeatHolder.notifyChanged()
      this.requestRender()
      this.events.onSubagentSubmit?.({
        parentSessionId: target.parentSessionId,
        childSessionId: target.childSessionId,
        text,
      })
      return
    }
    if (target !== undefined) {
      // One-shot viewer: submission is impossible (the input guard + the
      // placeholder keep it read-only); a defensive call keeps the main
      // draft intact and does NOT fire a parent submit.
      return
    }
    this.rememberInput(text)
    // Clear the draft like a normal Enter submit (the runner's dispatch
    // owns the session/guard path). M9: clear the CURRENT seat occupant.
    this.seatEditor().setText('')
    this.editorSeatHolder.notifyChanged()
    if (forceQueue) {
      this.events.onQueueSubmit?.(text)
    } else {
      this.events.onSubmit(text)
    }
    this.requestRender()
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
      handles: this.overlayBroker.graphState().handles,
      dependents: this.overlayBroker.graphState().dependents,
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
    // The dock strip is ONE summary row zone (label + at most one detail
    // line): host-owned row budget (plan §19).
    this.extensionHost?.setDockMaxRows(2)
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

  /**
   * Rebuild the M4 widget zones around the editor seat. The host owns the
   * row budget (plan §19 — minimum editor usability always wins): the above
   * zone gets a fixed budget, the below zone gets the remaining rows before
   * the footer. An empty zone renders NOTHING (the fork's emptied-pane quirk
   * means an empty Text would keep its old rows — the outlet text is
   * rewrittten wholesale on every refresh, and an empty text hides the
   * zone).
   */
  private renderWidgets(): void {
    const host = this.extensionHost
    if (host === undefined) {
      this.widgetsAbove.setText('')
      this.widgetsBelow.setText('')
      this.requestRender()
      return
    }
    // Host-owned budgets (plan §19): the above zone gets a fixed 3 rows,
    // the below zone the rows between the seat and the footer (a footer
    // recovery/status line always survives — the plan's height priority).
    const width = Math.max(1, this.terminal.columns)
    const belowBudget = Math.max(1, Math.min(3, Math.max(1, Math.floor(this.terminal.rows / 4))))
    host.setWidgetRowsAbove(3)
    host.setWidgetRowsBelow(belowBudget)
    const above = host.widgetsAboveText()
    const below = host.widgetsBelowText()
    this.widgetsAbove.setText(above)
    this.widgetsBelow.setText(below)
    void width
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
    const width = Math.max(1, this.terminal.columns)
    // The subagent viewer is host-owned chrome: the footer switches to the
    // VIEWED child's own identity (the parent's permission/model/plan/task
    // badges and the extension footer segments describe a session the user
    // is not looking at — extension segments do not render while viewing).
    if (this.viewerFooter !== undefined) {
      const footer = this.viewerFooter
      const modeBadge = color.accent(footer.mode === 'one-shot'
        ? '[subagent · one-shot]'
        : '[subagent · continuable]')
      const activity = footer.activity === 'running'
        ? color.primary('● running')
        : color.textMuted('inactive')
      const line1 = [
        modeBadge,
        footer.label === '' ? '' : footer.label,
        activity,
        footer.cwd === '' ? '' : footer.cwd,
        `t${footer.turns}/s${footer.steps}`,
      ].filter(part => part !== '')
      // The parent's Ctrl+C exit hint is meaningless inside the viewer
      // (Ctrl+C is inert there — the viewer guard consumes it), so it is
      // never rendered: the child's stats line shows instead (compact
      // preset keeps its usual behavior of dropping line 2).
      const line2Final = this.footerPreset === 'compact' ? '' : footer.statsLine
      this.footer.setText(this.footerRows(line1, line2Final, width))
      this.requestRender()
      return
    }
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
    // Issue #8: while the Ctrl+C exit chord is armed, the second line is
    // the exit hint for EXACTLY the exit window (one shared timer) — it
    // temporarily covers the stats, and even the compact preset shows it
    // (the user just triggered an explicit interaction and needs the
    // feedback).
    const line2 = this.ctrlCExitArmed
      ? 'Press Ctrl+C again to exit'
      : this.footerPreset === 'compact' ? '' : this.status.statsLine
    this.footer.setText(this.footerRows(line1, line2, width))
    this.requestRender()
  }

  /** The shared footer layout (plan §14): line 1 wraps with the host row
   * budget (≤3 physical rows), the stats line caps to one row; the caps
   * are the overflow BACKSTOP, not the normal compression — a long
   * extension segment folds from the tail first, matching the
   * FooterSegmentOutlet's own priority folding (the 0710746 overflow
   * concern stays covered by the outlet budget). */
  private footerRows(line1: readonly string[], line2: string, width: number): string {
    const hostBudget = TuiApp.FOOTER_MAX_LINES - (line2 === '' ? 0 : 1)
    const line1Rows = wrapTextWithAnsi(line1.join('  '), width)
    const rows: string[] = []
    for (let index = 0; index < Math.min(line1Rows.length, hostBudget); index += 1) {
      const row = line1Rows[index]!
      rows.push(index === hostBudget - 1 && line1Rows.length > hostBudget
        ? TuiApp.capRowWithEllipsis(row, width)
        : row)
    }
    if (line2 !== '') {
      const statsRows = wrapTextWithAnsi(line2, width)
      rows.push(statsRows.length > 1 ? TuiApp.capRowWithEllipsis(statsRows[0]!, width) : statsRows[0]!)
    }
    return rows.map(row => dim(row)).join('\n')
  }

  /** Force a visible `…` on a wrapped row that still has hidden content
   * behind it (wrapTextWithAnsi rows already fit the width, so a plain
   * truncateToWidth would not add the marker). */
  private static capRowWithEllipsis(row: string, width: number): string {
    return `${truncateToWidth(row, Math.max(1, width - 1), '')}…`
  }

  /**
   * Install slash-command + file-path autocompletion on the editor, plus
   * `@`-file mentions (fd-backed when `fdPath` is provided; a bounded
   * recursive fallback otherwise — see mentions.ts).
   * @param extensionSuggest - M5: consulted AFTER the host provider returns
   *   null (the plugin autocomplete chain). Receives the same editor
   *   position; returns suggestions or null.
   */
  setCommandCompletions(
    commands: readonly SlashCommand[],
    cwd: string,
    fdPath: string | null = null,
    extensionSuggest?: (query: {
      lines: readonly string[]
      cursorLine: number
      cursorCol: number
      signal: AbortSignal
      force?: boolean
    }) => Promise<{ items: import('@xmoon76/pi-tui').AutocompleteItem[]; prefix: string } | null>,
  ): void {
    const base = new MentionProvider([...commands], cwd, fdPath)
    if (extensionSuggest === undefined) {
      this.editor.setAutocompleteProvider(base)
      return
    }
    // A delegating provider: the host's own completions run FIRST; the
    // plugin chain (M5 AutocompleteRegistry) is consulted only when the
    // host provider has nothing. applyCompletion always delegates to the
    // host provider (the fork's completion semantics own the editor).
    const delegated: import('@xmoon76/pi-tui').AutocompleteProvider = {
      async getSuggestions(lines, cursorLine, cursorCol, options) {
        const host = await base.getSuggestions(lines, cursorLine, cursorCol, options)
        if (host !== null) return host
        return extensionSuggest({ lines, cursorLine, cursorCol, signal: options.signal, force: options.force })
      },
      applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
        base.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
      shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
        base.shouldTriggerFileCompletion(lines, cursorLine, cursorCol),
    }
    this.editor.setAutocompleteProvider(delegated)
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
    if (options.categories !== undefined && options.categories.length > 0) {
      return this.openCategorizedPicker(items, onSelect, onCancel,
        options as PickerOptions & { categories: readonly PickerCategory[] })
    }
    // Selected-row label marquee (plan §7): ONE driver per picker, armed
    // only while the SELECTED row overflows, disposed on close. The
    // truncatePrimary seam keeps the tree connector / current marker as a
    // fixed prefix — only the title scrolls (plan §7.7).
    const marquee = options.marquee === undefined ? undefined : new SelectedMarquee({
      requestRender: () => this.requestRender(),
      now: options.marquee.now,
    })
    const layout = marquee === undefined ? {} : {
      truncatePrimary: (ctx: SelectListTruncatePrimaryContext) => {
        if (!ctx.isSelected) return truncateToWidth(ctx.text, ctx.maxWidth, '')
        const parts = options.marquee!.labelPartsOf?.(ctx.text) ?? { prefix: '', title: ctx.text }
        const prefixWidth = visibleWidth(parts.prefix)
        const window = marquee.render({
          key: ctx.item.value,
          text: parts.title,
          maxWidth: Math.max(1, ctx.maxWidth - prefixWidth),
          selected: true,
        })
        return parts.prefix + window
      },
    }
    const list = new SelectList(
      items.map(item => ({ ...item })),
      10,
      selectListTheme,
      layout,
      {
        enableSearch: options.enableSearch,
        header: options.header,
        noMatchText: options.noMatchText,
        showHint: options.showHint,
        initialQuery: options.initialQuery,
      },
    )
    if (marquee !== undefined) {
      // A selection move re-anchors the marquee cycle (fresh pause).
      list.onSelectionChange = () => marquee.reset()
    }
    // The marquee wraps the list in the filter adapter (search edits must
    // restart the cycle even without a selection move — review P2); with
    // no marquee the list mounts directly, exactly as before.
    const mounted = marquee === undefined ? list : new MarqueeFilterAdapter(list, () => marquee.reset())
    const handle = this.showOverlayOnHost(new Frame(mounted, true), { width: options.width ?? 64, maxHeight: options.maxHeight ?? 24 })
    // Phase 4: an abort signal closes the picker and fires onCancel (the
    // imperative select broker's fiber-cancellation path). The listener
    // is removed on a normal select/cancel AND on the handle's close
    // (round-1 finding 4 + round-5 asymmetry: a settled promise must not
    // retain the listener on the caller's signal).
    let onAbort: (() => void) | undefined
    const removeAbortListener = (): void => {
      if (onAbort !== undefined && options.signal !== undefined) {
        options.signal.removeEventListener('abort', onAbort)
        onAbort = undefined
      }
    }
    if (options.signal !== undefined) {
      onAbort = (): void => {
        handle.hide()
        onCancel()
      }
      if (options.signal.aborted) {
        onAbort()
        onAbort = undefined
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    list.onSelect = (item) => {
      removeAbortListener()
      marquee?.dispose()
      handle.hide()
      onSelect(item.value)
    }
    list.onCancel = () => {
      removeAbortListener()
      marquee?.dispose()
      handle.hide()
      onCancel()
    }
    return {
      close: () => {
        removeAbortListener()
        marquee?.dispose()
        handle.hide()
      },
      setItems: (next) => {
        list.setItems(next.map(item => ({ ...item })))
        this.requestRender()
      },
      _removeAbortListener: removeAbortListener,
    }
  }

  /**
   * Open a CATEGORIZED picker: the overlay opens on `categories[0]` and Tab
   * cycles the tabs (each category re-runs its `items` factory and re-titles
   * the picker with its own header; the live search query is carried across
   * the switch). All close paths (select, cancel, handle.close, signal
   * abort) clear the Tab-cycling state. Consumer-side only — the fork
   * SelectList stays pristine (the header is baked into the constructor, so
   * a category switch rebuilds the overlay rather than mutating it).
   */
  private openCategorizedPicker(
    items: readonly PickerItem[],
    onSelect: (value: string) => void,
    onCancel: () => void,
    options: PickerOptions & { categories: readonly PickerCategory[] },
  ): PickerHandle {
    const categories = options.categories
    let currentIndex = 0
    let overlay: OverlayHandle | undefined
    let list: SelectList | undefined
    // Selected-row label marquee (plan §7): ONE driver for the whole
    // categorized picker (a category switch rebuilds the SelectList, the
    // marquee survives — the fresh list re-anchors it), disposed on close.
    const marquee = options.marquee === undefined ? undefined : new SelectedMarquee({
      requestRender: () => this.requestRender(),
      now: options.marquee.now,
    })
    const layout = marquee === undefined ? {} : {
      truncatePrimary: (ctx: SelectListTruncatePrimaryContext) => {
        if (!ctx.isSelected) return truncateToWidth(ctx.text, ctx.maxWidth, '')
        const parts = options.marquee!.labelPartsOf?.(ctx.text) ?? { prefix: '', title: ctx.text }
        const prefixWidth = visibleWidth(parts.prefix)
        const window = marquee.render({
          key: ctx.item.value,
          text: parts.title,
          maxWidth: Math.max(1, ctx.maxWidth - prefixWidth),
          selected: true,
        })
        return parts.prefix + window
      },
    }
    // The live search query, carried across category switches (the rebuilt
    // SelectList re-applies it via initialQuery).
    let query = ''
    let onAbort: (() => void) | undefined
    const state: CategorizedPickerState = {
      categories,
      index: 0,
      close: () => {
        if (this.activeCategorizedPicker === state) this.activeCategorizedPicker = undefined
        if (onAbort !== undefined && options.signal !== undefined) {
          options.signal.removeEventListener('abort', onAbort)
          onAbort = undefined
        }
        marquee?.dispose()
        overlay?.hide()
      },
      cycle: () => {
        // Carry the CURRENT search query into the rebuilt category.
        query = list?.getFilter() ?? query
        currentIndex = (currentIndex + 1) % categories.length
        state.index = currentIndex
        activate()
      },
    }
    const activate = (): void => {
      // A category switch is a NEW view: the marquee must restart from the
      // fresh anchor even when the same row (same value/label/width)
      // survives the switch — the identity check alone would let it
      // continue mid-cycle (review round 3).
      marquee?.reset()
      const category = categories[currentIndex]!
      const next = new SelectList(
        category.items().map(item => ({ ...item })),
        10,
        selectListTheme,
        layout,
        {
          enableSearch: options.enableSearch,
          header: category.header,
          noMatchText: options.noMatchText,
          showHint: options.showHint,
          initialQuery: query === '' ? options.initialQuery : query,
        },
      )
      if (marquee !== undefined) next.onSelectionChange = () => marquee.reset()
      next.onSelect = (item) => {
        query = next.getFilter()
        state.close()
        onSelect(item.value)
      }
      next.onCancel = () => {
        query = next.getFilter()
        state.close()
        onCancel()
      }
      overlay?.hide()
      list = next
      // Search edits inside a category must restart the marquee too (the
      // vendored SelectList fires no selection change for query edits).
      const mounted = marquee === undefined ? next : new MarqueeFilterAdapter(next, () => marquee.reset())
      overlay = this.showOverlayOnHost(new Frame(mounted, true), { width: options.width ?? 64, maxHeight: options.maxHeight ?? 24 })
    }
    // Phase 4 parity: an abort signal closes the CURRENT overlay and fires
    // onCancel. The listener lives once on the signal — category switches
    // replace the overlay, never the listener. An ALREADY-aborted signal
    // settles synchronously: the picker must never mount (activate) after
    // its own cancellation.
    let aborted = false
    if (options.signal !== undefined) {
      onAbort = (): void => {
        aborted = true
        state.close()
        onCancel()
      }
      if (options.signal.aborted) {
        onAbort()
        onAbort = undefined
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
    }
    // The caller's items are the initial rows; the first category's factory
    // re-runs on activation and wins. A pre-aborted signal never mounts.
    void items
    if (!aborted) {
      activate()
      this.activeCategorizedPicker = state
    }
    return {
      close: () => state.close(),
      setItems: () => {
        // Categorized: re-run the ACTIVE category's items factory (the
        // factory reads live state); the argument is a compatibility no-op.
        if (list === undefined) return
        list.setItems(categories[currentIndex]!.items().map(item => ({ ...item })))
        this.requestRender()
      },
      refresh: () => {
        if (list === undefined) return
        list.setItems(categories[currentIndex]!.items().map(item => ({ ...item })))
        this.requestRender()
      },
      setCategory: (id) => {
        const index = categories.findIndex(category => category.id === id)
        if (index === -1) return
        // Carry the CURRENT search query into the rebuilt category.
        query = list?.getFilter() ?? query
        currentIndex = index
        state.index = index
        activate()
      },
      _removeAbortListener: () => {
        if (onAbort !== undefined && options.signal !== undefined) {
          options.signal.removeEventListener('abort', onAbort)
          onAbort = undefined
        }
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
        onAction: options.onAction,
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
    const handle = this.showOverlayOnHost(new Frame(panel, true), { width: options.width ?? 72, maxHeight: options.maxHeight ?? 24 })
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
      setItems: (next: readonly TaskPanelItem[], preferredValue?: string) => {
        panel.setItems(next.map(item => ({ ...item })), preferredValue)
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
   * @param onChange - called with (id, newValue) on confirm. The third
   *   argument `revert` restores a row's DISPLAYED value (used by the M5
   *   plugin-settings path when the row's onChange rejects — the fork
   *   optimistically mutates the row before the callback runs).
   * @param onCancel - called when the user closes without applying.
   * @returns a function that closes the overlay.
   */
  openSettings(
    items: SettingItem[],
    onChange: (id: string, value: string, revert: (previousValue: string) => void) => void,
    onCancel: () => void,
  ): () => void {
    // SettingsList fires onCancel on Esc/ctrl+c; the overlay must close too,
    // so the cancel callback closes the handle captured after mounting.
    let handle: OverlayHandle | undefined
    // The settings theme is constructed PER OPEN: its cursor is a rendered
    // ANSI string, so a module-level constant would freeze the cursor
    // colour at import time and never follow a live theme switch.
    const settings = new SettingsList(items, 6, settingsListTheme(), (id, value) => {
      // The fork has ALREADY mutated the row's currentValue before calling
      // onChange. The revert callback restores a row's DISPLAYED value
      // through the SettingsList's own updateValue (used by the M5
      // plugin-settings path when the row's onChange rejects — the open
      // panel must not keep the rejected value). The CALLER supplies the
      // previous value (the registry still holds it before apply commits).
      const revert = (previousValue: string): void => settings.updateValue(id, previousValue)
      onChange(id, value, revert)
    }, () => {
      handle?.hide()
      onCancel()
    }, { enableSearch: true })
    handle = this.showOverlayOnHost(new Frame(settings, true), { width: 72, maxHeight: 28 })
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
    const handle = this.showOverlayOnHost(new Frame(panel, true), { width: 88, maxHeight: 24 })
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
    // Phase 4: track the current theme id (the advanced host-state
    // facade's getTheme).
    this.currentThemeId = theme
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
    // Phase 4: track the current theme id.
    this.currentThemeId = 'custom'
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
      this.activeScreen.setFocus(this.seatEditor().component)
      // The approval dialog is gone: the seat is the editor again (or the
      // next queued prompt's — showNextApproval re-derives it) (follow-up P1).
      this.setFocusSeat('editor')
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
            ...question.masked !== undefined ? { masked: question.masked } : {},
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
    for (const handle of this.overlayBroker.handles()) {
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
    // The question flow owns the seat (follow-up P1).
    this.setFocusSeat('overlay')
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
      // The next queued flow owns the seat (follow-up P1).
      this.setFocusSeat('overlay')
      screen.requestRender()
      this.settle(state, answers)
      return
    }
    // Final restoration: the editor FIRST, then the suspended overlays — a
    // restored capturing overlay focuses itself through setHidden(false),
    // so the editor must not be re-focused afterwards. M9: restore the
    // CURRENT seat occupant (host default or plugin editor).
    this.mountSeatChild()
    this.activeQuestions = undefined
    const screen = this.fullscreen ?? this.tui
    // M9 (round-1 finding 5): focus the CURRENT seat occupant (the host
    // default or the plugin editor's component) — never a hardcoded host
    // editor.
    screen.setFocus(this.seatEditor().component)
    for (const handle of state.suspendedOverlays) {
      if (this.overlayBroker.isTracked(handle)) handle.setHidden(false)
    }
    state.suspendedOverlays.clear()
    // The flow released the seat: re-derive it from the live focus AFTER
    // the overlays were restored (a restored capturing overlay owns the
    // seat again) (follow-up P1).
    this.setFocusSeat('editor')
    this.publishFocusSeat()
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
