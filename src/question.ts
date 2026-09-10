/**
 * The user-questions dialog flow (ask_user_question v2): the component that
 * sits in the EDITOR SEAT (kimi's mountEditorReplacement pattern) while the
 * agent asks — one question at a time, drafts per question, whole batch
 * submitted at the end — the Web QuestionComposer semantics (per-question
 * paging, batch submit, skip) with pi/kimi keyboard ergonomics (↑↓
 * highlight, digits, real Input for free text, review page).
 *
 * Pure component: the app layer owns the promise/abort plumbing, the seat
 * swap, and routes input here while the flow is active.
 * @module @xmoon76/dsh-pi-tui/question
 */

import { Input, matchesKey, type KeyId } from '@xmoon76/pi-tui'
import type { Component, Focusable } from '@xmoon76/pi-tui'
import { getGraphemeSegmenter, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import { componentKeymap } from './keybindings/component-keymap.ts'
import { color } from './theme.ts'

const segmenter = getGraphemeSegmenter()

/** One question in a user-questions ask (dsh shape mirrored for testability). */
export interface QuestionFlowQuestion {
  /** Stable caller-provided id, echoed in the answer. */
  id: string
  /** The question to display. */
  question: string
  /** Optional short heading/group label. */
  header?: string
  /** Optional detail block rendered dimmed above the options (Web parity). */
  detail?: string
  /** Optional choices rendered as a navigable list. */
  options?: readonly { label: string; description?: string }[]
  /** Whether more than one option may be selected. */
  multiSelect?: boolean
  /** Presentation intent: approve names the recommended option label. */
  intent?: { kind: string; approve?: string }
  /** Mask the free-text row's rendered content (an authorization secret
   *  prompt). The real value stays in the input's memory (the answer
   *  returns it); only the DISPLAY is bullets, and nothing here logs,
   *  records history, or writes the transcript. */
  masked?: boolean
}

/** One answered question, keyed by id. */
export interface QuestionFlowAnswer {
  /** The answered question id. */
  id: string
  /** Selected option labels. */
  selected: string[]
  /** Free-text answer for questions without options. */
  custom?: string
}

/** One draft per question, kept while the user pages around. */
interface Draft {
  selected: Set<string>
  custom: string
  skipped: boolean
}

/** The "type your own answer" row shown below options (pi isOther parity). */
const OTHER_ROW = '\u0000other'
/** The scroll-marker row's hit identity (mouse parity): the marker is a
 * DISTINCT semantic target from inert chrome — a press on an inert row
 * that repaints into the marker row must not toggle the expanded panel
 * (and vice versa). */
const MARKER_ROW = '\u0000marker'

/**
 * Default total physical-row budget of the question flow itself. The
 * QuestionFrame in tui-app.ts re-derives the budget from the terminal height
 * on every render (60% cap COLLAPSED, 8..24 content rows; up to 38 when
 * expanded) and pushes it through {@link QuestionFlow.setMaxRows}; 24 is the
 * fallback for direct renders.
 * The Frame wrapper adds its two border rows, and NOTHING clips the flow's
 * output in the editor-seat layout — so EVERYTHING (tabs, question, detail,
 * options with their descriptions, scroll marker, skipped note, hint) must
 * fit in the budget.
 */
const DEFAULT_BUDGET = 24
/**
 * Smallest supported content-row budget (a 16-row terminal caps the frame at
 * 10 rows). Below this the required rows (tabs, the question's first row,
 * the current option, the hint) cannot all coexist.
 */
const MIN_SUPPORTED_BUDGET = 8
/**
 * Largest supported content-row budget: the EXPANDED frame cap (80% of the
 * terminal, at most 40 frame rows) minus the two frame borders. An explicit
 * body expand ('e' / marker click) grows the panel beyond the default 60%
 * cap — the user asked for the room; the budget math is linear and holds
 * for every budget >= MIN_SUPPORTED_BUDGET.
 */
const MAX_BUDGET = 38
/**
 * Cap for the WRAPPED page scrollport content (question + detail + options
 * with their descriptions). Beyond it the content ends in a `... more
 * content hidden` note — wrapping an unbounded 100KB detail every frame
 * would be wasteful. 256 rows keeps realistic questions AND all their
 * answerable options reachable (7 options × ~19 wrapped description rows
 * at 50 columns fits); the cap is a hard wall, so a page whose content
 * alone exceeds 256 rows ends in the note — that page is unreachable in
 * practice, and the note makes the cut non-silent.
 */
const MAX_CONTENT_ROWS = 256

/**
 * Budgeted push of `content` to `lines`, wrapping it to `width`: pushes at
 * most `budget` PHYSICAL (wrapped) rows, appends a `... N more` marker when
 * content was cut, and returns the rows left for the next section. A 5000-char
 * single-line detail wraps to dozens of rows without this — the options and
 * hints would fall outside the dialog's maxHeight and the user would be
 * choosing blind.
 * @returns the remaining budget (≥ 0).
 */
function appendWrappedBudgeted(
  lines: string[],
  firstPrefix: string,
  continuationPrefix: string,
  content: string,
  width: number,
  budget: number,
): number {
  if (budget <= 0) return 0
  const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix))
  const contentWidth = Math.max(1, width - prefixWidth)
  const wrapped = wrapTextWithAnsi(content, contentWidth)
  // The `... N more` marker RIDES INSIDE the budget: when content is cut,
  // content rows cap at budget−1 so a section can never silently overflow
  // the dialog's total height.
  const hidden = wrapped.length > budget ? wrapped.length - (budget - 1) : 0
  const contentLimit = wrapped.length - hidden
  let used = 0
  for (; used < contentLimit; used += 1) {
    lines.push(`${used === 0 ? firstPrefix : continuationPrefix}${wrapped[used] ?? ''}`)
  }
  if (hidden > 0) {
    lines.push(color.textDim(`${continuationPrefix}... ${hidden} more line${hidden > 1 ? 's' : ''}`))
    used += 1
  }
  return Math.max(0, budget - used)
}

/**
 * Required-first push: the FIRST physical row always carries `content` —
 * never just a cut marker — while extra rows fill `budget` and a `... N
 * more` marker reports content that was itself cut, only when a row remains
 * after the content. Used for the question body and the highlighted option
 * label, whose first rows may never vanish (a 1-row budget shows the
 * content, not the marker).
 * @returns the remaining budget (≥ 0).
 */
function appendContentFirst(
  lines: string[],
  firstPrefix: string,
  continuationPrefix: string,
  content: string,
  width: number,
  budget: number,
): number {
  if (budget <= 0) return 0
  const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix))
  const contentWidth = Math.max(1, width - prefixWidth)
  const wrapped = wrapTextWithAnsi(content, contentWidth)
  if (wrapped.length === 0) {
    lines.push(firstPrefix)
    return Math.max(0, budget - 1)
  }
  // The first row always carries content — never just the cut marker.
  lines.push(`${firstPrefix}${wrapped[0] ?? ''}`)
  let used = 1
  const extra = Math.min(wrapped.length - 1, Math.max(0, budget - 1))
  for (let i = 1; i <= extra; i++) {
    lines.push(`${continuationPrefix}${wrapped[i] ?? ''}`)
    used += 1
  }
  const hidden = wrapped.length - 1 - extra
  if (hidden > 0 && used < budget) {
    lines.push(color.textDim(`${continuationPrefix}... ${hidden} more line${hidden > 1 ? 's' : ''}`))
    used += 1
  }
  return Math.max(0, budget - used)
}

/** The current question's tab label: `Q{n}` or Submit. */
function tabLabel(index: number, total: number): string {
  return index === total ? 'Submit' : `Q${index + 1}`
}

/** Split a conventional recommendation suffix off the DISPLAY label (the
 * answer value keeps the full label — Web parseRecommendedLabel parity).
 * English-only: the TUI never writes or matches localized labels (repo
 * hard rule — user-facing strings are English). */
function parseRecommended(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*\(recommended\)\s*$/i
  return suffix.test(label)
    ? { label: label.replace(suffix, ''), recommended: true }
    : { label, recommended: false }
}

/** One rendered option row model. */
interface Row {
  /** Option index, or OTHER_ROW for the free-text row. */
  key: string
  label: string
  recommended: boolean
  description?: string
}

/**
 * The press-time semantic identity of a QuestionFlow mouse gesture
 * (mouse parity): the release click may only act on the EXACT target
 * that was pressed — a question advance / repaint between press and
 * release must not transfer the click to whatever repainted onto the
 * same cell.
 */
export interface QuestionMouseGesture {
  /** The question id at press time (a question advance rejects the
   * release). */
  questionId: string
  /** The LAST-PAINTED hit at the pressed row: an option key, OTHER_ROW,
   * the MARKER_ROW sentinel (the scroll marker is a distinct semantic
   * target — an inert press that repaints into the marker row must not
   * toggle the expanded panel), or undefined for inert chrome. */
  hit: string | undefined
}

/**
 * The interactive question flow. Renders one question at a time with a tab
 * strip (answered marks), a navigable option list (↑↓/digits/Enter), a real
 * Input for free text, and a final REVIEW page with NO two-choice control:
 * Enter submits, Esc cancels, ← edits the last answer (plan item 4). Esc
 * cancels the whole flow; the app layer resolves the batch on done().
 */
export class QuestionFlow implements Component, Focusable {
  private readonly questions: readonly QuestionFlowQuestion[]
  private readonly onDone: (answers: QuestionFlowAnswer[]) => void
  private readonly onCancel: () => void
  private readonly drafts: Draft[]
  /** Current question index; `questions.length` is the review page. */
  private tab = 0
  /** Highlighted option index within the current question. */
  private cursor = 0
  /** Free-text editing mode (the "Type something." row or an optionless question). */
  private editingOther = false
  /**
   * The free-text edit Input. REPLACED by a fresh instance whenever the
   * edit moves to a different question (see {@link otherInputTab}): the
   * Input's undo stack and kill ring are per-instance state, so reusing
   * one instance across questions would let the previous question's
   * editing history leak into the next row (round-3 finding — Ctrl+-
   * undo / Ctrl+Y yank resurrected the previous question's text).
   */
  private otherInput = new Input({ prompt: '' })
  /**
   * The tab whose draft/in-progress text the {@link otherInput} currently
   * holds. Entering a DIFFERENT question's edit replaces the Input and
   * re-seeds from that question's draft; an Esc → navigation → ↵ round
   * trip on the SAME question keeps the live Input and its in-progress
   * text.
   */
  private otherInputTab = -1
  /**
   * Current content-row budget (8..38). The editor-seat QuestionFrame in
   * tui-app.ts re-derives it from the terminal height on every render and
   * pushes it through {@link setMaxRows}; nothing clips the flow's output
   * in that layout, so every render must fit the budget exactly.
   */
  private budget = DEFAULT_BUDGET
  private _focused = false
  /**
   * Scroll offset (content rows) into the UNIFIED page scrollport (question,
   * detail, then every option with its description, then the free-text row).
   * PageUp/PageDown move it; ↑↓/digits/click move the cursor and the render
   * follows it into view (pendingCursorScroll).
   */
  private bodyScroll = 0
  /**
   * Expanded mode ('e' / marker click): the FRAME grows toward 80% (the
   * QuestionFrame reads isBodyExpanded each render), so the scrollport is
   * taller and more of the page — including option descriptions — is visible
   * at once. Everything stays reachable by scrolling either way.
   */
  private bodyExpanded = false
  /** Cursor moved since the last render: the next render must scroll the
   * cursor's rows into view. */
  private pendingCursorScroll = false
  /** Hit map from the last render: content row -> option row key. Built each
   * render; drives fullscreen click-to-select. */
  private readonly hitMap = new Map<number, string>()
  /** Visible width of the free-text row's prefix (pointer + marker +
   * space) from the last render: a click while editing must translate to
   * the Input's local column. (Mouse parity.) */
  private otherPrefixWidth = 0
  /** Content width from the last render (Input hit-testing). */
  private lastContentWidth = 0
  /** Physical row of the PINNED optionless free-text input from the last
   * render (-1 = none): the optionless input renders below the scrollport
   * and is not part of the page hit map, so a click on it must be routed
   * to the Input explicitly. (Mouse parity.) */
  private pinnedOtherRow = -1
  /** Content row of the scroll marker in the last render (-1 = none);
   * clicking it toggles the expanded panel. */
  private lastMarkerRow = -1
  /** The press-time semantic identity of a mouse gesture (mouse parity):
   * the release click may only act on the EXACT target that was pressed
   * — a question advance / repaint between press and release must not
   * transfer the click to whatever repainted onto the same cell. */
  private mousePressGesture: QuestionMouseGesture | undefined
  /** Scrollport height from the last render (scroll page math). */
  private lastRegionHeight = 0
  /** Wrapped page content length from the last render. */
  private lastContentRows = 0
  /** Content rows visible in the region from the last render (region minus
   * the marker row when overflowing). */
  private lastVisibleRows = 0
  /** Whether the page content overflows the scrollport on the last render —
   * 'e' (and the scroll verbs) are available when true. */
  private lastExpandable = false

  constructor(
    questions: readonly QuestionFlowQuestion[],
    onDone: (answers: QuestionFlowAnswer[]) => void,
    onCancel: () => void,
  ) {
    this.questions = questions
    this.onDone = onDone
    this.onCancel = onCancel
    this.drafts = questions.map(() => ({ selected: new Set<string>(), custom: '', skipped: false }))
    // The free-text input keeps the last answer for re-entry.
    this.otherInput.onSubmit = (value) => this.commitOther(value)
    // The Input's generic cancel (Esc/Ctrl+C) ALWAYS leaves the text
    // edit back to the outer layer (option list for choices, navigation
    // state for optionless) — the flow itself cancels only from that
    // outer state (handleOtherEscape → exitOther; question.cancel /
    // navigation-state Ctrl+C → onCancel).
    this.otherInput.onEscape = () => this.handleOtherEscape()
    // An optionless first question edits text from the start.
    this.syncEditMode()
  }

  /**
   * Focus mirror for the editor-seat layout: the app focuses the wrapping
   * QuestionFrame, which forwards here. The free-text Input renders its
   * hardware cursor only while focused AND editing, so the mirror must sync
   * it — a plain field would leave the cursor permanently hidden.
   */
  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    if (this.editingOther) this.otherInput.focused = value
  }

  /**
   * Replace the content-row budget (the Frame wrapper adds its two border
   * rows on top). Called by QuestionFrame on every render immediately
   * before the flow renders, so no invalidation is needed; values outside
   * [MIN_SUPPORTED_BUDGET, MAX_BUDGET] are clamped.
   */
  setMaxRows(rows: number): void {
    this.budget = Math.max(MIN_SUPPORTED_BUDGET, Math.min(MAX_BUDGET, Math.floor(rows)))
  }

  /** Whether the panel is expanded (the frame grows toward 80% of the
   * terminal — QuestionFrame reads this every render). */
  isBodyExpanded(): boolean {
    return this.bodyExpanded
  }

  /**
   * Reset the view (scroll + expanded + pending cursor follow) — called on
   * every tab change so each question starts at its top, collapsed.
   */
  private resetBodyView(): void {
    this.bodyScroll = 0
    this.bodyExpanded = false
    this.pendingCursorScroll = false
  }

  /**
   * Page the unified scrollport. One page = the visible content rows. No-op
   * when the content fits the region.
   */
  private scrollBody(direction: -1 | 1): void {
    const visible = this.lastVisibleRows
    if (visible <= 0 || this.lastContentRows <= visible) return
    const maxScroll = this.lastContentRows - visible
    this.bodyScroll = Math.max(0, Math.min(this.bodyScroll + direction * visible, maxScroll))
  }

  /** Toggle the expanded panel ('e' or a click on the scroll marker).
   * Expanding is only meaningful when the page content overflows the
   * scrollport (everything fits -> a taller panel shows nothing new). The
   * SCROLL POSITION is kept: the taller region reveals MORE rows where the
   * user is looking (e.g. the option descriptions they scrolled to), instead
   * of jumping back to the top — the render clamps the offset to the new
   * maxScroll. */
  private toggleExpanded(): void {
    if (!this.bodyExpanded && !this.lastExpandable) return
    this.bodyExpanded = !this.bodyExpanded
  }

  /**
   * Record the press-time semantic identity of a mouse gesture (mouse
   * parity): the release click may only act on the EXACT target that was
   * pressed. The identity is the question id + the LAST-PAINTED hit
   * (option key / OTHER_ROW / undefined chrome) — never the physical
   * row alone, so a question advance or repaint between press and
   * release can never transfer the click to a different target.
   */
  beginMousePress(row: number): QuestionMouseGesture | undefined {
    const question = this.questions[this.tab]
    if (question === undefined) return undefined
    const gesture: QuestionMouseGesture = {
      questionId: question.id,
      hit: this.hitMap.get(row),
    }
    this.mousePressGesture = gesture
    return gesture
  }

  /**
   * Complete a mouse gesture: the release click may only run the action
   * for the EXACT press-time identity. A mismatch (question advanced,
   * the cell repainted to a different target, the gesture was never
   * started) is a no-op — the stale identity is always consumed.
   */
  completeMouseClick(gesture: QuestionMouseGesture | undefined, row: number, x?: number): void {
    this.mousePressGesture = undefined
    const question = this.questions[this.tab]
    if (question === undefined) return
    if (gesture === undefined || gesture.questionId !== question.id) return
    if (this.hitMap.get(row) !== gesture.hit) return
    this.clickRow(row, x)
  }

  /**
   * Primary-click routing (fullscreen): an option row selects it (single-
   * select advances, multi-select toggles, the "Type something." row enters
   * free-text), and the scroll marker toggles the expanded panel. While the
   * free-text row is already editing, `x` (the flow-local column) positions
   * the Input cursor at the clicked value column — the input is never
   * reset/reseeded. The hit map reflects the LAST rendered frame, which is
   * what the user sees.
   */
  clickRow(row: number, x?: number): void {
    if (row < 0 || this.tab >= this.questions.length) return
    const key = this.hitMap.get(row)
    if (key === OTHER_ROW) {
      // Already typing into it: position the Input cursor at the clicked
      // value column (the prefix is pointer + marker + space). Re-entering
      // would reset the input from the draft and discard the in-progress
      // text. (Mouse parity.)
      if (this.editingOther) {
        if (x !== undefined) {
          const question = this.questions[this.tab]
          const masked = question?.masked === true && this.otherInput.getValue() !== ''
          // The Input has an EMPTY prompt: its local column 0 IS the
          // first painted value cell. The optioned row's prefix is
          // pointer + marker + space; the pinned row's leading space is
          // the only offset — no hidden "> " prompt to compensate.
          const localX = row === this.pinnedOtherRow ? x - 1 : x - this.otherPrefixWidth
          if (localX >= 0) {
            if (masked) {
              // Masked: the painted row shows one bullet per visible
              // grapheme. Map the clicked bullet column to the grapheme
              // boundary and place the real cursor there (the mask never
              // exposes the value's real cell geometry).
              this.maskedClick(localX)
              return
            }
            this.otherInput.handleMouse?.({
              type: 'press',
              button: 'left',
              x: localX,
              y: 0,
              screenX: x,
              screenY: row,
              width: Math.max(1, this.lastContentWidth - this.otherPrefixWidth),
              height: 1,
              shift: false,
              alt: false,
              ctrl: false,
            })
          }
        }
        return
      }
      if (this.isOptionless()) {
        // Optionless: the pinned input is the ONLY row (rows() is empty),
        // so re-enter the edit directly, preserving the draft (mirror
        // Enter). (Mouse parity.)
        this.enterOther()
        return
      }
      const index = this.rows().findIndex(candidate => candidate.key === OTHER_ROW)
      if (index >= 0) {
        this.cursor = index
        this.pendingCursorScroll = true
        this.enterOther()
      }
      return
    }
    if (key === MARKER_ROW) {
      this.toggleExpanded()
      return
    }
    if (key !== undefined) {
      this.cursor = Number(key)
      this.pendingCursorScroll = true
      this.confirm()
      return
    }
  }

  /** One bullet per GRAPHEME of the real value, aligned with the Input's
   * horizontal-scroll viewport: the visible mask window shows the SAME
   * logical graphemes the Input renders, so a click on a visible bullet
   * maps to the visible grapheme (never the absolute value start). */
  private maskedBullets(): string {
    const value = this.otherInput.getValue()
    const graphemes = [...segmenter.segment(value)]
    const startIndex = this.maskedStartGrapheme(graphemes)
    return '•'.repeat(graphemes.length - startIndex)
  }

  /** The first grapheme index visible in the Input's horizontal-scroll
   * viewport (the mask window and the Input render the same graphemes). */
  private maskedStartGrapheme(graphemes: Array<{ index: number; segment: string }>): number {
    const startCol = this.otherInput.getRenderedStartColumn()
    let col = 0
    for (let i = 0; i < graphemes.length; i++) {
      if (col >= startCol) return i
      col += visibleWidth(graphemes[i]!.segment)
    }
    return graphemes.length
  }

  /** Map a clicked mask column to the real cursor: one visible bullet =
   * one logical grapheme (never split by UTF-16 code units), placed at
   * the grapheme boundary's UTF-16 index. */
  private maskedClick(localX: number): void {
    const value = this.otherInput.getValue()
    const graphemes = [...segmenter.segment(value)]
    const startIndex = this.maskedStartGrapheme(graphemes)
    const targetIndex = Math.min(graphemes.length, startIndex + localX)
    const cursor = targetIndex >= graphemes.length
      ? value.length
      : graphemes[targetIndex]!.index
    this.otherInput.setCursor(cursor)
  }

  /**
   * Build the UNIFIED page scrollport content: the question + detail first
   * (required-first — row 0 is always the question's first physical row),
   * a separator, then every option row (label + description), then the
   * free-text row. Each option row maps to its key for click hit-testing.
   * Capped at MAX_CONTENT_ROWS with a trailing `... more content hidden`
   * note, so wrapping an unbounded detail/description stays cheap.
   */
  private buildPageContent(
    question: QuestionFlowQuestion,
    rows: Row[],
    draft: Draft,
    multi: boolean,
    width: number,
  ): { lines: string[]; hits: Array<string | undefined> } {
    const lines: string[] = []
    const hits: Array<string | undefined> = []
    let left = MAX_CONTENT_ROWS
    left = appendContentFirst(
      lines,
      `${color.primary('?')}  `,
      '    ',
      color.textStrong(question.question),
      width,
      left,
    )
    hits.push(...new Array(lines.length).fill(undefined))
    if (question.detail !== undefined && question.detail !== '') {
      for (const line of question.detail.split('\n')) {
        if (left <= 1) {
          // Keep ONE row inside the cap for the cut marker: a detail that
          // never fits must still say so, without wrapping unboundedly.
          appendWrappedBudgeted(lines, '   ', '   ', color.textDim('... more content hidden'), width, left)
          break
        }
        left = appendWrappedBudgeted(lines, '   ', '   ', color.textDim(line), width, left)
      }
    }
    hits.push(...new Array(lines.length - hits.length).fill(undefined))
    lines.push('')
    hits.push(undefined)
    for (const row of rows) {
      const isCursor = rows[this.cursor] === row
      const selected = row.key === OTHER_ROW
        ? draft.custom !== ''
        : draft.selected.has(question.options?.[Number(row.key)]?.label ?? '')
      const marker = multi || row.key === OTHER_ROW
        ? selected ? color.success('[✓]') : color.textDim('[ ]')
        : selected ? color.success(`[${Number(row.key) + 1}]`) : color.textDim(`[${Number(row.key) + 1}]`)
      const pointer = isCursor ? color.primary('→') : ' '
      const prefix = `${pointer} ${marker} `
      if (row.key === OTHER_ROW && this.editingOther) this.otherPrefixWidth = visibleWidth(prefix)
      const indent = ' '.repeat(visibleWidth(prefix))
      const badge = row.recommended ? ` ${color.primary('[recommended]')}` : ''
      const label = isCursor ? color.textStrong(row.label) : row.label
      // The free-text row swaps its label for the live Input while editing.
      // An EMPTY input renders only a subtle fake cursor — show the row's
      // own label dimmed instead (a bare cursor block reads as a blank row).
      if (row.key === OTHER_ROW && this.editingOther) {
        const inputLines = this.otherInput.render(Math.max(1, width - visibleWidth(prefix)))
        const inputLine = inputLines[0] ?? ''
        if (question.masked === true && this.otherInput.getValue() !== '') {
          // A secret prompt: replace the rendered content with one bullet
          // per GRAPHEME of the real value (the input's own render pads to
          // the full width; the mask must not). The input's real value and
          // cursor are untouched — editing keeps working — only the display
          // is masked, and the value never reaches the transcript, history,
          // or any log.
          lines.push(prefix + color.textDim(this.maskedBullets()))
          hits.push(OTHER_ROW)
          continue
        }
        lines.push(prefix + (this.otherInput.getValue() === '' ? color.textDim(row.label) : inputLine))
        hits.push(OTHER_ROW)
        continue
      }
      const labelWidth = Math.max(1, width - visibleWidth(prefix))
      for (const wrapped of wrapTextWithAnsi(`${label}${badge}`, labelWidth)) {
        if (!this.pushPageRow(lines, hits, prefix + wrapped, row.key)) return { lines, hits }
      }
      if (row.description !== undefined && row.description !== '' && !(row.key === OTHER_ROW && this.editingOther)) {
        const descWidth = Math.max(1, width - visibleWidth(indent))
        for (const wrapped of wrapTextWithAnsi(color.textDim(row.description), descWidth)) {
          if (!this.pushPageRow(lines, hits, indent + wrapped, row.key)) return { lines, hits }
        }
      }
    }
    return { lines, hits }
  }

  /** Push one page-content row, capping at MAX_CONTENT_ROWS with a single
   * `... more content hidden` note (never a second one after the detail's).
   * @returns false when the cap was hit (callers stop building). */
  private pushPageRow(
    lines: string[],
    hits: Array<string | undefined>,
    line: string,
    key: string,
  ): boolean {
    if (lines.length >= MAX_CONTENT_ROWS) {
      if (lines[lines.length - 1]?.includes('more content hidden') !== true) {
        lines.push(color.textDim('... more content hidden'))
        hits.push(undefined)
      }
      return false
    }
    lines.push(line)
    hits.push(key)
    return true
  }

  /** The rows of the current question (options plus the free-text row). */
  private rows(): Row[] {
    const question = this.questions[this.tab]
    if (question === undefined) return []
    const rows: Row[] = (question.options ?? []).map((option, index) => {
      const { label, recommended } = parseRecommended(option.label)
      const approve = question.intent?.approve
      return {
        key: String(index),
        label,
        recommended: recommended || (approve !== undefined && option.label === approve),
        ...option.description === undefined ? {} : { description: option.description },
      }
    })
    if ((question.options?.length ?? 0) > 0) {
      rows.push({ key: OTHER_ROW, label: 'Type something.', recommended: false })
    }
    return rows
  }

  /** Whether the current question has NO selectable choices — pure free
   * text (an optionless question or a questions page whose only row is the
   * free-text row). Such a question has no list mode to fall back to: the
   * EDIT layer's Esc leaves for its NAVIGATION state (↵ re-enters the
   * edit, ←/→ page, Esc cancels the flow) instead of an option list. The
   * REVIEW page (tab past the last question) has no rows at all and must
   * never read as an edit page — syncEditMode runs on every advance,
   * review page included. */
  private isOptionless(rows: Row[] = this.rows()): boolean {
    if (this.tab >= this.questions.length) return false
    return rows.length === 0 || (rows.length === 1 && rows[0]?.key === OTHER_ROW)
  }

  /** The current question's draft. */
  private draft(): Draft | undefined {
    return this.drafts[this.tab]
  }

  /** Whether the current question has an answer (selected, custom, or skipped). */
  private answered(): boolean {
    const draft = this.draft()
    if (draft === undefined) return false
    return draft.selected.size > 0 || draft.custom !== '' || draft.skipped
  }

  /** The free-text row of the current question (present when options exist). */
  private otherRowIndex(): number {
    const rows = this.rows()
    return rows.findIndex(row => row.key === OTHER_ROW)
  }

  /** Enter on the highlighted row, or in text mode: commit and advance. */
  private confirm(): void {
    const draft = this.draft()
    if (draft === undefined) return
    // An OPTIONLESS question in the NAVIGATION state (Esc left the edit):
    // there are no rows to confirm — Enter re-enters the free-text edit
    // (this is the re-entry path that keeps pure-text questions
    // editable; without it a navigation-state optionless question would
    // be a dead end).
    if (this.isOptionless()) {
      this.enterOther()
      return
    }
    const rows = this.rows()
    const row = rows[this.cursor]
    if (row !== undefined && row.key !== OTHER_ROW) {
      const option = this.questions[this.tab]?.options?.[Number(row.key)]
      if (option !== undefined) {
        const label = option.label
        if (this.questions[this.tab]?.multiSelect === true) {
          if (draft.selected.has(label)) draft.selected.delete(label)
          else draft.selected.add(label)
          draft.skipped = false
          return // multi-select stays on the question; ←/→ pages on.
        }
        draft.selected.clear()
        draft.selected.add(label)
        draft.skipped = false
        this.advance()
      }
      return
    }
    if (row?.key === OTHER_ROW) {
      this.enterOther()
    }
  }

  /** Move to the next question (or the review page on the last one). */
  private advance(): void {
    this.tab += 1
    this.cursor = 0
    this.syncEditMode()
  }

  /** Optionless questions edit text directly; options start in list mode. */
  private syncEditMode(): void {
    this.resetBodyView()
    // Tab-change contract: in-progress free-text survives ONLY an Esc →
    // navigation → ↵ round trip on the SAME question. The moment the
    // user actually moves to ANOTHER question (←/→/skip/commit advance),
    // the uncommitted edit is DROPPED — invalidate the Input's owner so
    // the re-entry reseeds from the committed draft. This must happen on
    // EVERY tab change regardless of the NEXT question's type (a choices
    // stopover used to leave the old owner alive, so whether the text
    // survived depended on the intermediate question's kind — round
    // finding).
    if (this.otherInputTab !== -1 && this.otherInputTab !== this.tab) {
      this.otherInputTab = -1
    }
    const optionless = this.isOptionless()
    this.editingOther = optionless
    if (optionless) {
      // A DIFFERENT question's edit gets a FRESH Input seeded from that
      // question's committed draft (the Input's undo/kill history is
      // per-instance, so reuse would leak the previous question's
      // editing state — see resetOtherInput).
      const draft = this.draft()
      this.resetOtherInput(draft?.custom ?? '')
    } else {
      // The recommended row (intent.approve or a label suffix) is the default
      // highlight, so Enter adopts it directly (pi/questionnaire parity).
      const recommended = this.rows().findIndex(row => row.recommended)
      this.cursor = recommended >= 0 ? recommended : 0
    }
    this.otherInput.focused = this.focused && this.editingOther
  }

  /** Esc inside the free-text edit ALWAYS leaves the text edit back to the
   * outer layer — for a choices question back to its option list, for an
   * OPTIONLESS question back to the question's navigation state (where
   * Enter re-enters the edit, ←/→ page between questions, and Esc cancels
   * the flow). The flow's cancel only ever fires from that outer state, so
   * a pure-text question can never be stranded uneditable again. Shared by
   * the flow's question.cancel match and the Input's generic cancel
   * (tui.select.cancel: Esc/Ctrl+C). */
  private handleOtherEscape(): void {
    this.exitOther()
  }

  /** Skip the current question (empty answer) and move on. */
  private skip(): void {
    const draft = this.draft()
    if (draft === undefined) return
    draft.selected.clear()
    draft.custom = ''
    draft.skipped = true
    // The skip's advance() runs syncEditMode, which invalidates the
    // free-text Input's owner on the tab change — a later re-entry
    // reseeds from the EMPTY draft, so the (skipped) row never shows
    // stale in-progress text beside it.
    this.advance()
  }

  /** Enter the free-text editing mode for the current question. The shared
   * Input keeps in-progress text across an Esc → navigation → ↵ round
   * trip on the SAME question; entering a DIFFERENT question's edit (or a
   * fresh entry) seeds from that question's committed draft — the
   * previous question's text must never leak into the new row. */
  private enterOther(): void {
    this.editingOther = true
    if (this.otherInputTab !== this.tab) {
      const draft = this.draft()
      this.resetOtherInput(draft?.custom ?? '')
    }
    this.otherInput.focused = this.focused
  }

  /** (Re)create the free-text Input for a NEW question owner and seed it
   * with `value`. The Input's undo stack / kill ring / paste buffer are
   * PER-INSTANCE state, so a cross-question ownership change must start
   * from a fresh instance — reusing one Input across questions let
   * Ctrl+- (undo) / Ctrl+Y (yank) resurrect the previous question's text
   * in the new row (round-3 finding). */
  private resetOtherInput(value: string): void {
    // The Input has an EMPTY prompt: QuestionFlow paints its own prefix
    // (pointer + marker + space) and the pinned row's leading space, so
    // the Input's local column 0 IS the first painted value cell — no
    // hidden "> " prompt to strip or compensate in mouse translation.
    const input = new Input({ prompt: '' })
    input.onSubmit = (next) => this.commitOther(next)
    input.onEscape = () => this.handleOtherEscape()
    input.setValue(value)
    input.focused = this.focused && this.editingOther
    this.otherInput = input
    this.otherInputTab = this.tab
  }

  /** Leave text mode back to the option list. */
  private exitOther(): void {
    this.editingOther = false
    this.otherInput.focused = false
  }

  /** Commit the typed text into the draft and advance. */
  private commitOther(value: string): void {
    const draft = this.draft()
    if (draft === undefined) return
    const text = value.trim()
    draft.custom = text
    if (text === '') {
      // An empty "type something" answer counts as skipped (Web semantics) —
      // but NEVER when an earlier selection is still on the draft: the
      // skipped mark wins at submit time (`skipped` returns `selected: []`),
      // so committing empty text over a selection would silently wipe it
      // (the arrow-key move-on must keep an answered draft, list-mode
      // parity). With a selection, empty text just keeps the selection.
      if (draft.selected.size === 0) draft.skipped = true
    } else {
      // A custom answer replaces a single-select choice; multi-select keeps
      // its checked labels (Web draftCustom parity).
      if (this.questions[this.tab]?.multiSelect !== true) draft.selected.clear()
      draft.skipped = false
    }
    this.exitOther()
    this.advance()
  }

  /** Submit the whole batch from the review page. */
  private submit(): void {
    const answers: QuestionFlowAnswer[] = this.questions.map((question, index) => {
      const draft = this.drafts[index] as Draft
      if (draft.skipped) return { id: question.id, selected: [] }
      const custom = draft.custom.trim()
      if (custom !== '' && question.multiSelect !== true) {
        return { id: question.id, selected: [], custom }
      }
      return {
        id: question.id,
        selected: [...draft.selected],
        ...custom === '' ? {} : { custom },
      }
    })
    this.onDone(answers)
  }

  handleInput(data: string): void {
    if (data === '\u0000') return
    // Text mode: printable/cursor keys go to the real Input; Enter/Esc are
    // the flow's own verbs. PageUp/PageDown scroll the body even while
    // typing ('e' stays a letter here — expand is a list-mode verb).
    // All matches go through the component keymap (M5): the semantic
    // question.* actions resolve through matchesKey, so Kitty CSI-u (and
    // modifyOtherKeys) sequences are recognized alongside legacy ones —
    // the flow previously compared raw sequences ('\x1b[A' etc.), which
    // silently dropped every key on terminals that report CSI-u (the
    // zellij + Kitty-protocol case).
    if (this.editingOther) {
      // Text mode: EVERY editing key — Left/Right cursor movement,
      // Home/End, Ctrl+A/E/B/F, Backspace/Delete, word moves, kill/undo —
      // belongs to the shared Input (the flow previously intercepted
      // question.previous/next, so → committed+advanced and ← could page
      // back, stealing the text cursor). The flow keeps only its own
      // mode verbs: Enter commits, Esc leaves the edit (back to the
      // option list for choices, to the NAVIGATION state for optionless
      // — the second Esc there cancels the flow), PageUp/PageDown scroll
      // the body ('e' stays a letter here — expand is a list-mode verb).
      if (componentKeymap.matches(data, 'question.confirm')) {
        this.commitOther(this.otherInput.getValue())
      } else if (componentKeymap.matches(data, 'question.cancel')) {
        this.handleOtherEscape()
      } else if (componentKeymap.matches(data, 'question.pageUp')) {
        this.scrollBody(-1)
      } else if (componentKeymap.matches(data, 'question.pageDown')) {
        this.scrollBody(1)
      } else {
        this.otherInput.handleInput(data)
      }
      return
    }
    const rows = this.rows()
    if (this.tab >= this.questions.length) {
      // Review page (the 2026-08-22 plan, item 4): a pure review — NO
      // Submit/Cancel two-choice control, no focus, no ↑↓. Enter submits
      // the whole batch, Esc cancels the flow, ← returns to the last
      // question (drafts survive). The keys match user intuition and the
      // page carries one less state machine. `h` stays the vim alias for
      // ← (the review page has no text input to steal from).
      if (componentKeymap.matches(data, 'question.confirm')) {
        this.submit()
      } else if (componentKeymap.matches(data, 'question.cancel')) {
        this.onCancel()
      } else if (componentKeymap.matches(data, 'question.previous') || data === 'h') {
        // ← back to the last question (drafts survive).
        this.tab = Math.max(0, this.questions.length - 1)
        this.cursor = 0
        this.syncEditMode()
      }
      return
    }
    const digit = /^[1-9]$/.exec(data)
    if (digit !== null && !this.isOptionless()) {
      // A digit in an OPTIONLESS question's navigation state is text —
      // the option-choice shortcut does not exist without options (the
      // fall-through re-enters the edit below).
      const row = rows[Number(digit[0]) - 1]
      if (row !== undefined) {
        this.cursor = rows.indexOf(row)
        this.pendingCursorScroll = true
        this.confirm()
      }
      return
    }
    if (componentKeymap.matches(data, 'question.cursorUp') || data === 'k') {
      if (rows.length === 0) {
        // An OPTIONLESS navigation state has no list: the PHYSICAL ↑ is a
        // no-op here (no selection to move, and it must not bounce the
        // user into the edit for nothing); the vim 'k' alias is plain
        // text and falls through to the auto re-enter below.
        if (componentKeymap.matches(data, 'question.cursorUp')) return
      } else if (this.cursor === 0 && this.bodyScroll > 0) {
        // ↑ at the FIRST row with the page scrolled: scroll the body UP so
        // the question overview comes back into view (the pointer stays on
        // the first row — it is already visible, so no cursor follow).
        this.scrollBody(-1)
        return
      } else {
        this.cursor = (this.cursor - 1 + rows.length) % rows.length
        this.pendingCursorScroll = true
        return
      }
    }
    if (componentKeymap.matches(data, 'question.cursorDown') || data === 'j') {
      if (rows.length === 0) {
        // Same optionless rule: physical ↓ no-ops, 'j' is text.
        if (componentKeymap.matches(data, 'question.cursorDown')) return
      } else if (this.cursor === rows.length - 1
        && this.lastExpandable && this.lastContentRows > this.bodyScroll + this.lastVisibleRows) {
        // ↓ at the LAST row with more page content below: scroll the body
        // DOWN (the pointer stays on the last row). Only when the page
        // actually overflows — otherwise ↓ keeps the wrap-around.
        this.scrollBody(1)
        return
      } else {
        this.cursor = (this.cursor + 1) % rows.length
        this.pendingCursorScroll = true
        return
      }
    }
    if (componentKeymap.matches(data, 'question.pageUp') || componentKeymap.matches(data, 'question.pageDown')) {
      // PageUp/PageDown: scroll the body scrollport (no-op when it fits).
      this.scrollBody(componentKeymap.matches(data, 'question.pageUp') ? -1 : 1)
      return
    }
    if (componentKeymap.matches(data, 'question.toggleExpand') && !this.isOptionless()) {
      // Expand/collapse the body region (the scroll marker's keyboard twin).
      // In an OPTIONLESS navigation state 'e' is plain text (no list to
      // expand) — it falls through and re-enters the edit below.
      this.toggleExpanded()
      return
    }
    if (componentKeymap.matches(data, 'question.confirm')) {
      this.confirm()
      return
    }
    // ←/→ back/next (the physical arrows own these verbs). The vim h/l
    // aliases are LIST-mode conveniences only: they must NOT eat 'h'/'l'
    // inside an OPTIONLESS question's NAVIGATION state, where every
    // printable (h/l included) is text that auto-re-enters the edit
    // below (round finding — typing 'hello'/'linux' was hijacked).
    if (componentKeymap.matches(data, 'question.previous')
      || (!this.isOptionless() && data === 'h')) {
      // ← back: previous question (keeps the draft).
      if (this.tab > 0) {
        this.tab -= 1
        this.cursor = 0
        this.syncEditMode()
      }
      return
    }
    if (componentKeymap.matches(data, 'question.next')
      || (!this.isOptionless() && data === 'l')) {
      // → move on (the arrows own back/skip now, replacing the old 's'
      // skip key): an UNANSWERED question is marked skipped and advances
      // (web QuestionComposer skip parity); an ANSWERED one keeps its draft
      // and just advances. syncEditMode resets the body view (scroll/expand)
      // on EVERY tab change — forward included — so a scrolled/expanded
      // question never leaks its view into the next one.
      if (!this.answered()) {
        this.skip()
        return
      }
      if (this.tab < this.questions.length - 1) {
        this.tab += 1
        this.cursor = 0
        this.syncEditMode()
      } else {
        this.tab = this.questions.length
        this.cursor = 0
        this.syncEditMode()
      }
      return
    }
    if (componentKeymap.matches(data, 'question.cancel')) {
      this.onCancel()
      return
    }
    // An OPTIONLESS question in its NAVIGATION state (Esc left the edit):
    // every key that is not one of the flow's navigation verbs (← back,
    // → skip/next, ↵ re-edit, esc cancel, PgUp/PgDn scroll) is the user
    // typing again — re-enter the text edit and hand the key to the
    // shared Input (search-box semantics: no Enter prefix needed, and
    // digits/'e' are text here, not list-mode verbs).
    if (this.isOptionless()) {
      // Ctrl+C mirrors Esc's two-stage lifecycle: the FIRST press exits
      // the edit (the Input's tui.select.cancel → handleOtherEscape),
      // the SECOND press here cancels the flow.
      if (matchesKey(data, 'ctrl+c')) {
        this.onCancel()
        return
      }
      this.enterOther()
      this.otherInput.handleInput(data)
    }
  }

  invalidate(): void {
    this.otherInput.invalidate()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    this.lastContentWidth = safeWidth
    const lines: string[] = []
    // The hit map reflects THIS frame only (the review page populates none).
    this.hitMap.clear()
    this.lastMarkerRow = -1
    this.pinnedOtherRow = -1
    // Tab strip: Q1(✓) Q2(○) … Submit — answered marks, current highlighted.
    // Tabs carry NO leading/trailing spaces of their own (the box border
    // provides the padding), so every content row starts at the same column.
    const tabs = this.questions.map((_, index) => {
      const draft = this.drafts[index]
      const answered = draft !== undefined && (draft.selected.size > 0 || draft.custom !== '' || draft.skipped)
      const label = tabLabel(index, this.questions.length)
      const mark = answered ? '✓' : '○'
      return this.tab === index
        ? color.textStrong(`${mark} ${label}`)
        : color.textDim(`${mark} ${label}`)
    })
    const submitAnswered = this.drafts.every(draft => draft.selected.size > 0 || draft.custom !== '' || draft.skipped)
    const submitText = `${submitAnswered ? '✓' : '○'} Submit`
    tabs.push(this.tab === this.questions.length
      ? color.textStrong(submitText)
      : color.textDim(submitText))
    lines.push(tabs.join('  '))
    lines.push('')
    if (this.tab >= this.questions.length) {
      // Review page (plan item 4): every answer, then the fixed hint — NO
      // Submit/Cancel action row (Enter submits, Esc cancels, ← edits).
      // The page shares the SAME physical-row budget as the rest of the
      // dialog: no matter how long the answers are, the hint must stay
      // visible — it is the ONLY required tail row now (the blank
      // separator before it yields when space is tight, round-3 finding),
      // and title, separators, questions and answers share everything
      // else, row-budgeted with the usual `... N more lines` cut marker.
      let reviewBudget = this.budget - lines.length - 1
      reviewBudget = appendWrappedBudgeted(
        lines,
        '',
        '',
        color.textStrong('Review your answer before submit'),
        safeWidth,
        reviewBudget,
      )
      if (reviewBudget > 0) {
        lines.push('')
        reviewBudget -= 1
      }
      for (let qi = 0; qi < this.questions.length && reviewBudget > 0; qi++) {
        const question = this.questions[qi]
        const draft = this.drafts[qi]
        if (question === undefined || draft === undefined) continue
        const value = draft.skipped
          ? '(skipped)'
          : draft.custom !== '' && question.multiSelect !== true
            ? question.masked === true
              // A masked secret stays masked on the review page too: the
              // answer is confirmed as "typed", never re-shown in plaintext.
              ? '•'.repeat(draft.custom.length)
              : draft.custom
            : [...draft.selected].join(', ') + (draft.custom !== '' ? ` + ${draft.custom}` : '')
        reviewBudget = appendWrappedBudgeted(
          lines,
          `${color.textDim(`Q${qi + 1}`)}  `,
          '       ',
          question.question,
          safeWidth,
          reviewBudget,
        )
        if (reviewBudget > 0) {
          reviewBudget = appendWrappedBudgeted(
            lines,
            '  ',
            '    ',
            value === '' ? color.textDim('(no answer)') : value,
            safeWidth,
            reviewBudget,
          )
        }
      }
      if (reviewBudget > 0) {
        lines.push('')
        reviewBudget -= 1
      }
      lines.push(color.textDim('← back · ↵ submit · esc cancel'))
      return lines
    }
    const question = this.questions[this.tab]
    const draft = this.draft()
    if (question === undefined || draft === undefined) return lines
    const rows = this.rows()
    const multi = question.multiSelect === true
    const skippedRow = draft.skipped ? 1 : 0
    const optionless = this.isOptionless(rows)
    // Required tail — the rows that must render below the scrollport:
    //   choice page: (skipped) note + trailing blank + hint = 2 + skippedRow
    //   optionless:  input row + (skipped) note + trailing blank + hint =
    //                3 + skippedRow
    const tail = optionless ? 3 + skippedRow : 2 + skippedRow
    const header = question.header
    // The header is decorative: it renders only when the scrollport still
    // gets at least one row (the required-first guarantee below).
    const headerShown = header !== undefined && header !== '' && this.budget - lines.length - tail >= 2
    if (headerShown) {
      lines.push(color.textDim(header))
    }
    // UNIFIED SCROLLPORT: the whole page — question, detail, then every
    // option with its description, then the free-text row — is ONE region.
    // PageUp/PageDown browse it; ↑↓/digits/click move the cursor and the
    // view follows (pendingCursorScroll), so the pointer stays in view and
    // every description is reachable by scrolling on any screen size.
    const content = this.buildPageContent(question, rows, draft, multi, safeWidth)
    const regionHeight = Math.max(1, this.budget - lines.length - tail)
    const overflow = content.lines.length > regionHeight
    // The scroll marker reserves the region's last row (only when the region
    // has at least 2 rows — a 1-row region keeps its content, required-first).
    const visible = overflow && regionHeight >= 2 ? regionHeight - 1 : regionHeight
    this.lastRegionHeight = regionHeight
    this.lastContentRows = content.lines.length
    this.lastVisibleRows = visible
    this.lastExpandable = overflow && regionHeight >= 2
    const maxScroll = Math.max(0, content.lines.length - visible)
    this.bodyScroll = Math.min(this.bodyScroll, maxScroll)
    if (this.pendingCursorScroll) {
      // Cursor follow: the cursor's first content row must be visible.
      this.pendingCursorScroll = false
      const cursorKey = rows[this.cursor]?.key
      if (cursorKey !== undefined) {
        const first = content.hits.indexOf(cursorKey)
        if (first >= 0) {
          if (first < this.bodyScroll) this.bodyScroll = first
          else if (first >= this.bodyScroll + visible) this.bodyScroll = first - visible + 1
          this.bodyScroll = Math.max(0, Math.min(this.bodyScroll, maxScroll))
        }
      }
    }
    for (let index = this.bodyScroll; index < this.bodyScroll + visible && index < content.lines.length; index++) {
      const hit = content.hits[index]
      if (hit !== undefined) this.hitMap.set(lines.length, hit)
      lines.push(content.lines[index]!)
    }
    if (overflow && regionHeight >= 2) {
      const above = this.bodyScroll
      const below = content.lines.length - (this.bodyScroll + visible)
      const marker = above > 0 && below > 0
        ? `↑ ${above} up · ↓ ${below} more lines`
        : above > 0
          ? `↑ ${above} up`
          : `↓ ${below} more lines`
      this.lastMarkerRow = lines.length
      // The marker is a DISTINCT hit identity (mouse parity): a press on
      // an inert row that repaints into the marker row must not toggle
      // the expanded panel.
      this.hitMap.set(lines.length, MARKER_ROW)
      lines.push(color.textDim(marker))
    } else {
      this.lastMarkerRow = -1
    }
    if (optionless) {
      // The free-text input is pinned below the scrollport (always visible).
      // An EMPTY input renders only a subtle fake cursor — on a small screen
      // that row reads as blank, so show a dim placeholder instead (typing
      // replaces it with the live value). A MASKED question renders bullets
      // of the same display width (the value never reaches the transcript,
      // history, or any log — only the display is hidden).
      const inputLines = this.otherInput.render(Math.max(1, safeWidth - 2))
      const inputLine = inputLines[0] ?? ''
      // The pinned row is the free-text input: route clicks on it to the
      // Input (the page hit map only covers the scrollport). (Mouse
      // parity.)
      this.pinnedOtherRow = lines.length
      this.hitMap.set(lines.length, OTHER_ROW)
      if (question.masked === true && this.otherInput.getValue() !== '') {
        // A MASKED question renders one bullet per GRAPHEME of the real
        // value (the input's render pads to the full width; the mask must
        // not). The value never reaches the transcript, history, or any
        // log — only the display is hidden.
        lines.push(` ${color.textDim(this.maskedBullets())}`)
      } else {
        lines.push(this.otherInput.getValue() === '' ? color.textDim(' Type your answer…') : ` ${inputLine}`)
      }
    }
    if (draft.skipped) {
      lines.push(color.textDim('(skipped)'))
    }
    lines.push('')
    // The hint describes the CURRENT mode, never a generic list-mode verb
    // set:
    // - text EDIT (choices or optionless): ←→ are the TEXT cursor, Enter
    //   confirms, Esc LEAVES the edit back to the navigation layer
    //   (esc back — for choices its option list, for optionless its
    //   navigation state);
    // - optionless NAVIGATION state (after Esc): ↵ re-enters the edit,
    //   ← back / → skip page between questions, esc cancels the flow;
    // - choices list mode: ↑↓/digits/Enter select, ← back → skip, e
    //   expand, esc cancel.
    // List-only verbs (↑↓ select, 1-N choose, ↵ toggle, → next, e expand)
    // are never advertised while editing.
    // The hint composes from the parts that FIT: low-priority verbs drop
    // out instead of the whole line being ellipsized by the frame. The
    // escape verb ALWAYS survives (it is reserved first — the verbs drop
    // from the end, so e.g. '→ skip' goes before 'esc cancel').
    const scrollable = this.lastExpandable
    if (this.editingOther) {
      const editParts = [
        '←→ edit',
        '↵ confirm',
        scrollable ? 'pgup/pgdn scroll' : '',
      ].filter(part => part !== '')
      const cancel = 'esc back'
      let hint = ''
      for (const part of editParts) {
        const next = hint === '' ? part : `${hint} · ${part}`
        if (visibleWidth(`${next} · ${cancel}`) > safeWidth) break
        hint = next
      }
      lines.push(color.textDim(hint === '' ? cancel : `${hint} · ${cancel}`))
      return lines
    }
    if (optionless) {
      // Navigation state of an OPTIONLESS question: no list, no choice
      // verbs — ↵ re-enters the text edit, arrows page, Esc cancels.
      const navParts = [
        '↵ edit',
        this.questions.length > 1 || this.tab > 0 ? '← back · → skip' : '→ skip',
      ].filter(part => part !== '')
      const cancel = 'esc cancel'
      let hint = ''
      for (const part of navParts) {
        const next = hint === '' ? part : `${hint} · ${part}`
        if (visibleWidth(`${next} · ${cancel}`) > safeWidth) break
        hint = next
      }
      lines.push(color.textDim(hint === '' ? cancel : `${hint} · ${cancel}`))
      return lines
    }
    const optionCount = Math.min(rows.length, 9)
    const hintParts = [
      '↑↓ select',
      optionCount > 0 ? `1-${optionCount} choose` : '',
      multi ? '↵ toggle' : '↵ confirm',
      scrollable ? 'pgup/pgdn scroll' : '',
      this.bodyExpanded ? 'e collapse' : scrollable ? 'e expand' : '',
      this.questions.length > 1 ? '← back · → skip' : '→ skip',
      'esc cancel',
    ].filter(part => part !== '')
    const cancel = 'esc cancel'
    const verbs = hintParts.filter(part => part !== cancel)
    let hint = ''
    for (const part of verbs) {
      const next = hint === '' ? part : `${hint} · ${part}`
      if (visibleWidth(`${next} · ${cancel}`) > safeWidth) break
      hint = next
    }
    lines.push(color.textDim(hint === '' ? cancel : `${hint} · ${cancel}`))
    return lines
  }
}
