/**
 * The user-questions dialog flow (ask_user_question v2): a focusable overlay
 * component that walks one question at a time, collects drafts per question,
 * and submits the whole batch at the end — the Web QuestionComposer
 * semantics (per-question paging, batch submit, skip) with pi/kimi keyboard
 * ergonomics (↑↓ highlight, digits, real Input for free text, review page).
 *
 * Pure component: the app layer owns the promise/abort plumbing and routes
 * input here while the flow is active.
 * @module @xmoon76/dsh-pi-tui/question
 */

import { Input } from '@xmoon76/pi-tui'
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

/** Max wrapped rows of a question's detail block (kimi MAX_BODY_LINES). */
const MAX_DETAIL_LINES = 12
/** Max visible option rows before the list windows around the cursor. */
const MAX_VISIBLE_OPTIONS = 7

/**
 * Push `content` to `lines`, wrapping it to `width` with a hanging indent.
 * The first physical line starts with `firstPrefix`; continuation lines get
 * `continuationPrefix`. Content may carry its own ANSI styling (the wrapper
 * splits styled runs correctly). Every emitted line is guaranteed ≤ width,
 * so a wrapped dialog never hits the Frame's ellipsis truncation.
 */
function appendWrapped(
  lines: string[],
  firstPrefix: string,
  continuationPrefix: string,
  content: string,
  width: number,
): void {
  const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(continuationPrefix))
  const contentWidth = Math.max(1, width - prefixWidth)
  const wrapped = wrapTextWithAnsi(content, contentWidth)
  if (wrapped.length === 0) {
    lines.push(firstPrefix)
    return
  }
  lines.push(`${firstPrefix}${wrapped[0] ?? ''}`)
  for (let i = 1; i < wrapped.length; i++) {
    lines.push(`${continuationPrefix}${wrapped[i] ?? ''}`)
  }
}

/** The current question's tab label: `Q{n}` or Submit. */
function tabLabel(index: number, total: number): string {
  return index === total ? 'Submit' : `Q${index + 1}`
}

/** Split a conventional recommendation suffix off the DISPLAY label (the
 * answer value keeps the full label — Web parseRecommendedLabel parity). */
function parseRecommended(label: string): { label: string; recommended: boolean } {
  const suffix = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i
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
  focused = false

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
      // An empty "type something" answer counts as skipped (Web semantics).
      draft.skipped = true
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
    // the flow's own verbs.
    if (this.editingOther) {
      if (data === '\r' || data === '\n') {
        this.commitOther(this.otherInput.getValue())
      } else if (data === '\x1b') {
        this.exitOther()
      } else if (data === '\x1b[D') {
        if (this.tab > 0) {
          this.tab -= 1
          this.cursor = 0
          this.submitIdx = 0
          this.syncEditMode()
        }
      } else if (data === '\x1b[C') {
        if (this.tab < this.questions.length - 1) {
          this.tab += 1
          this.cursor = 0
          this.submitIdx = 0
          this.syncEditMode()
        } else {
          this.tab = this.questions.length
          this.submitIdx = 0
          this.syncEditMode()
        }
      } else {
        this.otherInput.handleInput(data)
      }
      return
    }
    const rows = this.rows()
    if (this.tab >= this.questions.length) {
      // Review page: ←/→ choose Submit/Cancel, Enter executes, Esc cancels.
      if (data === '\r' || data === '\n') {
        if (this.submitIdx === 0) this.submit()
        else this.onCancel()
      } else if (data === '\x1b') {
        this.onCancel()
      } else if (data === '\x1b[D' || data === 'h') {
        this.submitIdx = 0
      } else if (data === '\x1b[C' || data === 'l') {
        this.submitIdx = 1
      } else if (data === 'b') {
        // Back to the last question (drafts survive).
        this.tab = Math.max(0, this.questions.length - 1)
        this.cursor = 0
        this.submitIdx = 0
        this.syncEditMode()
      }
      return
    }
    const digit = /^[1-9]$/.exec(data)
    if (digit !== null) {
      const row = rows[Number(digit[0]) - 1]
      if (row !== undefined) {
        this.cursor = rows.indexOf(row)
        this.confirm()
      }
      return
    }
    if (data === '\x1b[A' || data === 'k') {
      if (rows.length > 0) this.cursor = (this.cursor - 1 + rows.length) % rows.length
      return
    }
    if (data === '\x1b[B' || data === 'j') {
      if (rows.length > 0) this.cursor = (this.cursor + 1) % rows.length
      return
    }
    if (data === '\r' || data === '\n') {
      this.confirm()
      return
    }
    if (data === '\x1b[D' || data === 'h') {
      // ←: previous question (keeps the draft).
      if (this.tab > 0) {
        this.tab -= 1
        this.cursor = 0
        this.submitIdx = 0
        this.syncEditMode()
      }
      return
    }
    if (data === '\x1b[C' || data === 'l') {
      // →: next question (or review page).
      if (this.tab < this.questions.length - 1) {
        this.tab += 1
        this.cursor = 0
        this.submitIdx = 0
      } else {
        this.tab = this.questions.length
        this.cursor = 0
        this.submitIdx = 0
        this.syncEditMode()
      }
      return
    }
    if (data === 's') {
      // Skip the current question (only meaningful outside text mode).
      this.skip()
      return
    }
    if (data === '\x1b') {
      this.onCancel()
    }
  }

  invalidate(): void {
    this.otherInput.invalidate()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const lines: string[] = []
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
      // Review page: every answer, then Submit/Cancel actions. Question
      // texts wrap with a hanging indent so long questions read in full.
      lines.push(color.textStrong('Review your answer before submit'))
      this.questions.forEach((question, index) => {
        const draft = this.drafts[index]
        if (draft === undefined) return
        const value = draft.skipped
          ? '(skipped)'
          : draft.custom !== '' && question.multiSelect !== true
            ? draft.custom
            : [...draft.selected].join(', ') + (draft.custom !== '' ? ` + ${draft.custom}` : '')
        appendWrapped(lines, `${color.textDim(`Q${index + 1}`)}  `, '       ', question.question, safeWidth)
        appendWrapped(lines, `  `, '    ', value === '' ? color.textDim('(no answer)') : value, safeWidth)
      })
      lines.push('')
      const submit = this.submitIdx === 0 ? color.textStrong('Submit') : color.textDim('Submit')
      const cancel = this.submitIdx === 1 ? color.textStrong('Cancel') : color.textDim('Cancel')
      lines.push(`${this.submitIdx === 0 ? color.primary('→ ') : '  '}${submit}   ${cancel}`)
      lines.push(color.textDim('← → choose · b back · ↵ confirm · esc cancel'))
      return lines
    }
    const question = this.questions[this.tab]
    const draft = this.draft()
    if (question === undefined || draft === undefined) return lines
    if (question.header !== undefined && question.header !== '') {
      lines.push(color.textDim(question.header))
    }
    // The question body wraps with a `?` marker and hanging indent — the
    // Frame must never ellipsize a question mid-sentence.
    appendWrapped(lines, `${color.primary('?')}  `, '    ', color.textStrong(question.question), safeWidth)
    if (question.detail !== undefined && question.detail !== '') {
      const detailLines = question.detail.split('\n')
      const shown = detailLines.slice(0, MAX_DETAIL_LINES)
      for (const line of shown) {
        appendWrapped(lines, '   ', '   ', color.textDim(line), safeWidth)
      }
      if (detailLines.length > MAX_DETAIL_LINES) {
        lines.push(color.textDim(`   ... ${detailLines.length - MAX_DETAIL_LINES} more lines`))
      }
    }
    const rows = this.rows()
    const multi = question.multiSelect === true
    const editingOther = this.editingOther && rows.some(row => row.key === OTHER_ROW)
    if (rows.length > 0 && !(rows.length === 1 && rows[0]?.key === OTHER_ROW)) {
      lines.push('')
      // Window the option list around the cursor (kimi maxVisibleOptions):
      // a long option list scrolls instead of overflowing the dialog.
      const visibleCount = Math.min(rows.length, MAX_VISIBLE_OPTIONS)
      const half = Math.floor(MAX_VISIBLE_OPTIONS / 2)
      const maxStart = Math.max(0, rows.length - visibleCount)
      const start = Math.max(0, Math.min(this.cursor - half, maxStart))
      const end = Math.min(rows.length, start + visibleCount)
      for (let index = start; index < end; index++) {
        const row = rows[index]
        if (row === undefined) continue
        if (row.key === OTHER_ROW && this.editingOther) {
          const prefix = `${color.primary('→')} ${color.textDim(`[${index + 1}]`)} `
          const inputLines = this.otherInput.render(Math.max(1, safeWidth - visibleWidth(prefix)))
          const inputLine = inputLines[0] ?? ''
          const stripped = inputLine.startsWith('> ') ? inputLine.slice(2) : inputLine
          lines.push(prefix + stripped)
          continue
        }
        const selected = row.key === OTHER_ROW
          ? draft.custom !== ''
          : draft.selected.has(question.options?.[Number(row.key)]?.label ?? '')
        const marker = multi || row.key === OTHER_ROW
          ? selected ? color.success('[✓]') : color.textDim('[ ]')
          : selected ? color.success(`[${Number(row.key) + 1}]`) : color.textDim(`[${Number(row.key) + 1}]`)
        const pointer = index === this.cursor ? color.primary('→') : ' '
        const prefix = `${pointer} ${marker} `
        const badge = row.recommended ? ` ${color.primary('[recommended]')}` : ''
        const label = index === this.cursor ? color.textStrong(row.label) : row.label
        // Label and [recommended] badge share the row; the description gets
        // its OWN wrapped dim lines so nothing is crammed or ellipsized.
        appendWrapped(lines, prefix, ' '.repeat(visibleWidth(prefix)), `${label}${badge}`, safeWidth)
        if (row.description !== undefined && row.description !== '') {
          const descIndent = ' '.repeat(visibleWidth(prefix))
          appendWrapped(lines, descIndent, descIndent, color.textDim(row.description), safeWidth)
        }
      }
      if (rows.length > visibleCount) {
        lines.push(color.textDim(`   showing ${start + 1}-${end} of ${rows.length}`))
      }
    } else if (this.editingOther || (question.options?.length ?? 0) === 0) {
      // Optionless question: the real Input owns the line (placeholder hint).
      const inputLines = this.otherInput.render(Math.max(1, safeWidth - 2))
      const inputLine = inputLines[0] ?? ''
      const stripped = inputLine.startsWith('> ') ? inputLine.slice(2) : inputLine
      lines.push(` ${stripped}`)
    }
    if (draft.skipped) {
      lines.push(color.textDim('(skipped)'))
    }
    lines.push('')
    // The hint composes from the parts that FIT: low-priority verbs drop out
    // instead of the whole line being ellipsized by the frame.
    const optionCount = Math.min(rows.length, 9)
    const hintParts = [
      '↑↓ select',
      optionCount > 0 ? `1-${optionCount} choose` : '',
      multi ? '↵ toggle' : '↵ confirm',
      this.questions.length > 1 ? '←→ switch' : '',
      's skip',
      'esc cancel',
    ].filter(part => part !== '')
    let hint = ''
    for (const part of hintParts) {
      const next = hint === '' ? part : `${hint} · ${part}`
      if (visibleWidth(next) > safeWidth) break
      hint = next
    }
    lines.push(color.textDim(hint === '' ? 'esc cancel' : hint))
    return lines
  }
}
