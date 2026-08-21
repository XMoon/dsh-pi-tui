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
import { visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import { color } from './theme.ts'

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
 * The interactive question flow. Renders one question at a time with a tab
 * strip (answered marks), a navigable option list (↑↓/digits/Enter), a real
 * Input for free text, and a final review page (Submit/Cancel). Esc cancels
 * the whole flow; the app layer resolves the batch on done().
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
  private readonly otherInput = new Input()
  /** Review-page action highlight (0 = Submit, 1 = Cancel). */
  private submitIdx = 0
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
  /** Content row of the scroll marker in the last render (-1 = none);
   * clicking it toggles the expanded panel. */
  private lastMarkerRow = -1
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
    this.otherInput.onEscape = () => this.exitOther()
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
   * Primary-click routing (fullscreen): an option row selects it (single-
   * select advances, multi-select toggles, the "Type something." row enters
   * free-text), and the scroll marker toggles the expanded panel. The hit
   * map reflects the LAST rendered frame, which is what the user sees.
   */
  clickRow(row: number): void {
    if (row < 0 || this.tab >= this.questions.length) return
    const key = this.hitMap.get(row)
    if (key === OTHER_ROW) {
      // Already typing into it: re-entering would reset the input from the
      // draft and discard the in-progress text.
      if (this.editingOther) return
      const index = this.rows().findIndex(candidate => candidate.key === OTHER_ROW)
      if (index >= 0) {
        this.cursor = index
        this.pendingCursorScroll = true
        this.enterOther()
      }
      return
    }
    if (key !== undefined) {
      this.cursor = Number(key)
      this.pendingCursorScroll = true
      this.confirm()
      return
    }
    if (row === this.lastMarkerRow) {
      this.toggleExpanded()
    }
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
      const indent = ' '.repeat(visibleWidth(prefix))
      const badge = row.recommended ? ` ${color.primary('[recommended]')}` : ''
      const label = isCursor ? color.textStrong(row.label) : row.label
      // The free-text row swaps its label for the live Input while editing.
      // An EMPTY input renders only a subtle fake cursor — show the row's
      // own label dimmed instead (a bare cursor block reads as a blank row).
      if (row.key === OTHER_ROW && this.editingOther) {
        const inputLines = this.otherInput.render(Math.max(1, width - visibleWidth(prefix)))
        const inputLine = inputLines[0] ?? ''
        const stripped = inputLine.startsWith('> ') ? inputLine.slice(2) : inputLine
        lines.push(prefix + (this.otherInput.getValue() === '' ? color.textDim(row.label) : stripped))
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
    this.submitIdx = 0
    this.syncEditMode()
  }

  /** Optionless questions edit text directly; options start in list mode. */
  private syncEditMode(): void {
    this.resetBodyView()
    const question = this.questions[this.tab]
    const optionless = question !== undefined && (question.options?.length ?? 0) === 0
    this.editingOther = optionless
    if (optionless) {
      const draft = this.draft()
      this.otherInput.setValue(draft?.custom ?? '')
    } else {
      // The recommended row (intent.approve or a label suffix) is the default
      // highlight, so Enter adopts it directly (pi/questionnaire parity).
      const recommended = this.rows().findIndex(row => row.recommended)
      this.cursor = recommended >= 0 ? recommended : 0
    }
    this.otherInput.focused = this.focused && this.editingOther
  }

  /** Skip the current question (empty answer) and move on. */
  private skip(): void {
    const draft = this.draft()
    if (draft === undefined) return
    draft.selected.clear()
    draft.custom = ''
    draft.skipped = true
    this.advance()
  }

  /** Enter the free-text editing mode for the current question. */
  private enterOther(): void {
    this.editingOther = true
    const draft = this.draft()
    this.otherInput.setValue(draft?.custom ?? '')
    this.otherInput.focused = this.focused
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
    // All matches go through matchesKey so Kitty CSI-u (and modifyOtherKeys)
    // sequences are recognized alongside legacy ones — the flow previously
    // compared raw sequences ('\x1b[A' etc.), which silently dropped every
    // key on terminals that report CSI-u (the zellij + Kitty-protocol case).
    if (this.editingOther) {
      if (matchesKey(data, 'enter')) {
        this.commitOther(this.otherInput.getValue())
      } else if (matchesKey(data, 'escape')) {
        this.exitOther()
      } else if (matchesKey(data, 'pageUp')) {
        this.scrollBody(-1)
      } else if (matchesKey(data, 'pageDown')) {
        this.scrollBody(1)
      } else if (matchesKey(data, 'left')) {
        if (this.tab > 0) {
          this.tab -= 1
          this.cursor = 0
          this.submitIdx = 0
          this.syncEditMode()
        }
      } else if (matchesKey(data, 'right')) {
        // → in text mode: same "move on" verb as in list mode — commit the
        // typed answer (an empty one counts as skipped) and advance. Enter
        // stays the primary save key; → never discards in-progress text.
        this.commitOther(this.otherInput.getValue())
      } else {
        this.otherInput.handleInput(data)
      }
      return
    }
    const rows = this.rows()
    if (this.tab >= this.questions.length) {
      // Review page: ↑↓ choose Submit/Cancel, Enter executes, ← goes back
      // to the last question (drafts survive), Esc cancels. The action
      // highlight uses ↑↓ (kimi's question dialog); ← is the back verb
      // (it replaced the old 'b' key — the arrows own back/skip now).
      // `h` stays as the vim alias for ← (as in list mode); `l` has no
      // mapping because the review page binds no action to → (the arrows
      // no longer select Submit/Cancel — ↑↓ do).
      if (matchesKey(data, 'enter')) {
        if (this.submitIdx === 0) this.submit()
        else this.onCancel()
      } else if (matchesKey(data, 'escape')) {
        this.onCancel()
      } else if (matchesKey(data, 'left') || data === 'h') {
        // ← back to the last question (drafts survive).
        this.tab = Math.max(0, this.questions.length - 1)
        this.cursor = 0
        this.submitIdx = 0
        this.syncEditMode()
      } else if (matchesKey(data, 'up') || data === 'k') {
        this.submitIdx = 0
      } else if (matchesKey(data, 'down') || data === 'j') {
        this.submitIdx = 1
      }
      return
    }
    const digit = /^[1-9]$/.exec(data)
    if (digit !== null) {
      const row = rows[Number(digit[0]) - 1]
      if (row !== undefined) {
        this.cursor = rows.indexOf(row)
        this.pendingCursorScroll = true
        this.confirm()
      }
      return
    }
    if (matchesKey(data, 'up') || data === 'k') {
      if (rows.length === 0) return
      if (this.cursor === 0 && this.bodyScroll > 0) {
        // ↑ at the FIRST row with the page scrolled: scroll the body UP so
        // the question overview comes back into view (the pointer stays on
        // the first row — it is already visible, so no cursor follow).
        this.scrollBody(-1)
        return
      }
      this.cursor = (this.cursor - 1 + rows.length) % rows.length
      this.pendingCursorScroll = true
      return
    }
    if (matchesKey(data, 'down') || data === 'j') {
      if (rows.length === 0) return
      const atLastRow = this.cursor === rows.length - 1
      const scrolled = this.lastExpandable && this.lastContentRows > this.bodyScroll + this.lastVisibleRows
      if (atLastRow && scrolled) {
        // ↓ at the LAST row with more page content below: scroll the body
        // DOWN (the pointer stays on the last row). Only when the page
        // actually overflows — otherwise ↓ keeps the wrap-around.
        this.scrollBody(1)
        return
      }
      this.cursor = (this.cursor + 1) % rows.length
      this.pendingCursorScroll = true
      return
    }
    if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
      // PageUp/PageDown: scroll the body scrollport (no-op when it fits).
      this.scrollBody(matchesKey(data, 'pageUp') ? -1 : 1)
      return
    }
    if (data === 'e') {
      // Expand/collapse the body region (the scroll marker's keyboard twin).
      this.toggleExpanded()
      return
    }
    if (matchesKey(data, 'enter')) {
      this.confirm()
      return
    }
    if (matchesKey(data, 'left') || data === 'h') {
      // ← back: previous question (keeps the draft).
      if (this.tab > 0) {
        this.tab -= 1
        this.cursor = 0
        this.submitIdx = 0
        this.syncEditMode()
      }
      return
    }
    if (matchesKey(data, 'right') || data === 'l') {
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
        this.submitIdx = 0
        this.syncEditMode()
      } else {
        this.tab = this.questions.length
        this.cursor = 0
        this.submitIdx = 0
        this.syncEditMode()
      }
      return
    }
    if (matchesKey(data, 'escape')) {
      this.onCancel()
    }
  }

  invalidate(): void {
    this.otherInput.invalidate()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const lines: string[] = []
    // The hit map reflects THIS frame only (the review page populates none).
    this.hitMap.clear()
    this.lastMarkerRow = -1
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
      // Review page: every answer, then Submit/Cancel actions. The page
      // shares the SAME physical-row budget as the rest of the dialog: no
      // matter how long the answers are, the Submit/Cancel row and the hint
      // must stay visible — they are the REQUIRED tail (2 rows), and title,
      // separators, questions and answers share everything else,
      // row-budgeted with the usual `... N more lines` cut marker.
      let reviewBudget = this.budget - lines.length - 2
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
            ? draft.custom
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
      const submit = this.submitIdx === 0 ? color.textStrong('Submit') : color.textDim('Submit')
      const cancel = this.submitIdx === 1 ? color.textStrong('Cancel') : color.textDim('Cancel')
      lines.push(`${this.submitIdx === 0 ? color.primary('→ ') : '  '}${submit}   ${cancel}`)
      lines.push(color.textDim('↑↓ choose · ← back · ↵ confirm · esc cancel'))
      return lines
    }
    const question = this.questions[this.tab]
    const draft = this.draft()
    if (question === undefined || draft === undefined) return lines
    const rows = this.rows()
    const multi = question.multiSelect === true
    const skippedRow = draft.skipped ? 1 : 0
    const optionless = rows.length === 0 || (rows.length === 1 && rows[0]?.key === OTHER_ROW)
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
      lines.push(color.textDim(marker))
    } else {
      this.lastMarkerRow = -1
    }
    if (optionless) {
      // The free-text input is pinned below the scrollport (always visible).
      // An EMPTY input renders only a subtle fake cursor — on a small screen
      // that row reads as blank, so show a dim placeholder instead (typing
      // replaces it with the live value).
      const inputLines = this.otherInput.render(Math.max(1, safeWidth - 2))
      const inputLine = inputLines[0] ?? ''
      const stripped = inputLine.startsWith('> ') ? inputLine.slice(2) : inputLine
      lines.push(this.otherInput.getValue() === '' ? color.textDim(' Type your answer…') : ` ${stripped}`)
    }
    if (draft.skipped) {
      lines.push(color.textDim('(skipped)'))
    }
    lines.push('')
    // The hint composes from the parts that FIT: low-priority verbs drop out
    // instead of the whole line being ellipsized by the frame. 'esc cancel'
    // is the escape hatch and ALWAYS survives (it is reserved first — the
    // verbs drop from the end, so e.g. '→ skip' goes before 'esc cancel').
    // Scroll and expand are advertised only when the page overflows the
    // scrollport; once expanded, 'e' always collapses (frame 80% -> 60%).
    const optionCount = Math.min(rows.length, 9)
    const scrollable = this.lastExpandable
    // Text mode commits on → (empty = skipped), list mode skips/moves on —
    // the verb is advertised per mode ('→ next' vs '→ skip').
    const arrowVerb = this.editingOther ? '→ next' : '→ skip'
    const hintParts = [
      '↑↓ select',
      optionCount > 0 ? `1-${optionCount} choose` : '',
      multi ? '↵ toggle' : '↵ confirm',
      scrollable ? 'pgup/pgdn scroll' : '',
      !this.editingOther
        ? (this.bodyExpanded ? 'e collapse' : scrollable ? 'e expand' : '')
        : '',
      this.questions.length > 1 ? `← back · ${arrowVerb}` : arrowVerb,
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
