/**
 * The ONE Schedule workspace panel (S5-PR4): a fullscreen, leased layout root
 * that paints the controller's official catalog snapshot and forwards user
 * actions as the ONE semantic intent stream. It never reads a Host, never
 * keeps a second task model and never owns a screen lease — the host leases
 * the terminal, calls {@link ScheduleWorkspacePanel.setSnapshot} on every
 * controller change and routes pointer presses/clicks to this root.
 *
 * The panel is the focus target of that lease: it receives every key and
 * decides the mode-local intent (list/detail/history/editor/help/confirm).
 * `render(width)` is pure over the latest snapshot and panel-local view state
 * (scroll offsets, search binding, the in-panel chooser); it starts no timer,
 * calls no Host and dispatches nothing. Mouse actions are resolved only
 * against the LAST painted frame and a task row is re-proved by its stable id
 * in the CURRENT snapshot, so a stale frame cannot act.
 *
 * @module @xmoon76/dsh-pi-tui/tui/schedule/workspace-panel
 */

import {
  CURSOR_MARKER,
  Input,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@xmoon76/pi-tui'
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import type {
  ScheduleCatalogEntry,
  ScheduleConfirm,
  ScheduleFilter,
  ScheduleIntent,
  ScheduleNotice,
  ScheduleWorkspaceSnapshot,
} from '../../app/schedule/presentation.ts'
import {
  editorFields,
  focusedField,
  type ScheduleEditorDraft,
  type ScheduleFormField,
  type ScheduleTargetKind,
  type ScheduleTimingKind,
} from '../../domain/schedule/form.ts'
import {
  EDITOR_LABEL_WIDTH,
  editorChooserTitle,
  editorFieldHint,
  editorFocusIntent,
  editorModeLabel,
  fieldIndexById,
  isEditorTextInput,
  sessionChooserOptions,
  targetChooserOptions,
  timingChooserOptions,
  weekdayFromField,
  type ScheduleEditorChoice,
} from './form.ts'
import {
  deliveryFacts,
  formatDeliveryFloor,
  formatExecutionActivity,
  formatLocalInstant,
  formatOccurrence,
  formatRuleSummary,
  formatSeconds,
  formatTargetSummary,
  officialTimeZone,
  scheduleStatusText,
  shortScheduleId,
  type ScheduleTaskStatus,
} from './format.ts'
import {
  ACTION_BAR_SEPARATOR,
  renderActionBarRow,
  type ActionBarSegment,
} from '../presentation/action-bar.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import { formatKeyId } from '../keybindings/hints.ts'

/** The two-column layout boundary. */
export const SCHEDULE_WIDE_COLUMNS = 120
export const SCHEDULE_WIDE_ROWS = 30
/** The narrow (<80 columns) action-bar order. */
const NARROW_COLUMNS = 80
/** The label column of a detail fact row. */
const DETAIL_LABEL_WIDTH = 16
/** The editor's fact label column (mode, revision, creation floor). */
const EDITOR_FACT_LABEL_WIDTH = 20

/** The responsive shape of one Schedule frame. */
export type ScheduleWorkspaceLayout = 'single' | 'wide'

/**
 * Derive the responsive layout from the LIVE terminal size. There is NO
 * minimum-size refusal gate (design-language §8): the two-column layout needs
 * ≥120×≥30, every narrower or shorter terminal keeps the fully interactive
 * single column and degrades its decoration instead.
 */
export function scheduleWorkspaceLayout(columns: number, rows: number): ScheduleWorkspaceLayout {
  const cols = Math.floor(columns)
  const lines = Math.floor(rows)
  if (!Number.isFinite(cols) || !Number.isFinite(lines)) return 'single'
  return cols >= SCHEDULE_WIDE_COLUMNS && lines >= SCHEDULE_WIDE_ROWS ? 'wide' : 'single'
}

/** The panel's construction inputs. */
export interface ScheduleWorkspacePanelDeps {
  /** The CURRENT controller snapshot; called on every frame. */
  readonly snapshot: () => ScheduleWorkspaceSnapshot
  /** The ONE semantic intent entry (the controller owns all semantics). */
  readonly dispatch: (intent: ScheduleIntent) => void
  /** Repaint request for panel-local state changes (scroll, search focus). */
  readonly requestRender: () => void
  /** Live terminal rows. */
  readonly rows: () => number
  /** Live terminal columns. */
  readonly columns: () => number
  /** Close the workspace (only the list root's Esc does this). */
  readonly close: () => void
}

/** The four panes Tab rotates through in the wide layout. */
type FocusPane = 'filter' | 'search' | 'list' | 'detail'

/** A semantic action painted somewhere in the frame. */
type ScheduleAction =
  | 'new'
  | 'refresh'
  | 'clear-ended'
  | 'help'
  | 'search'
  | 'enter-detail'
  | 'close'
  | 'history-more'
  | 'detail-history'
  | 'detail-edit'
  | 'detail-toggle'
  | 'detail-run'
  | 'detail-delete'
  | 'back'
  | 'close-help'
  | 'confirm'
  | 'cancel'

/** What one painted pointer region means. */
type ScheduleHit =
  | { readonly kind: 'row'; readonly id: string }
  | { readonly kind: 'filter'; readonly filter: ScheduleFilter }
  | { readonly kind: 'search' }
  | { readonly kind: 'action'; readonly action: ScheduleAction }
  | { readonly kind: 'field'; readonly id: string }

/** One painted pointer region of the last frame. */
interface PaintedRegion {
  readonly row: number
  readonly from: number
  readonly to: number
  readonly hit: ScheduleHit
}

/** The LAST painted frame; the only geometry a pointer may resolve against. */
interface PaintedFrame {
  readonly width: number
  readonly height: number
  readonly regions: readonly PaintedRegion[]
}

/** One piece of a painted row. */
interface CellSegment {
  /** Unpainted text used for fit/truncation and width accounting. */
  readonly plain: string
  /** Paints the fitted text. */
  readonly paint?: (text: string) => string
  /** Pre-painted text that already fits (the focused text field's Input). */
  readonly raw?: string
  readonly hit?: ScheduleHit
}

/** One logical body row (a row hit or an editor field may cover it whole). */
interface BodyLine {
  readonly segments: readonly CellSegment[]
  readonly rowId?: string
  readonly fieldId?: string
  /** The physical row the multi-line field's caret is on (scroll anchor). */
  readonly caretRow?: boolean
  /** The open editor chooser's heading, and the selected option's index. */
  readonly chooserTitle?: boolean
  readonly chooserIndex?: number
}

/** The panel-local chooser one editor field opens. */
interface OpenChooser {
  readonly fieldId: string
  readonly title: string
  readonly options: readonly ScheduleEditorChoice[]
  readonly index: number
}

/** The identity of the confirmation the last frame painted. */
interface PaintedConfirm {
  readonly kind: ScheduleConfirm['kind']
  readonly token: number
}

/** One status/read banner the list paints above its rows. */
interface PaintedBanner {
  readonly text: string
  readonly paint: (text: string) => string
}

/**
 * The ONE Schedule workspace panel.
 */
export class ScheduleWorkspacePanel implements Component, Focusable {
  private readonly deps: ScheduleWorkspacePanelDeps
  private snapshot: ScheduleWorkspaceSnapshot
  private disposed = false
  private _focused = false
  private searchFocused = false
  private focusPane: FocusPane = 'list'
  private chooser: OpenChooser | undefined
  private listScroll = 0
  /** A wheel gesture owns the list viewport until the selection changes. */
  private listScrollPinned = false
  private detailScroll = 0
  private historyScroll = 0
  private editorScroll = 0
  private helpScroll = 0
  private frame: PaintedFrame | undefined
  private paintedConfirm: PaintedConfirm | undefined
  private pressed: { readonly key: string } | undefined
  private readonly searchInput = new Input({ prompt: '' })
  private readonly editorInput = new Input({ prompt: '' })
  private editorFieldId: string | undefined
  /** The snapshot value the search binding last observed, and the last value
   *  this panel dispatched. A newer local edit is never overwritten by a
   *  snapshot that has not caught up with it. */
  private searchBaseline: string | undefined
  private searchDispatched: string | undefined
  /** The same binding facts for the focused editor text field. */
  private editorBaseline: string | undefined
  private editorDispatched: string | undefined
  /** The raw multi-line buffer of the focused RAW field (Prompt/RRULE,
   *  newlines preserved: the stored bytes are never flattened). */
  private rawDraft: string | undefined
  /** The exact value this panel last dispatched for that RAW field. */
  private rawDispatched: string | undefined
  /** The raw field's caret, as a CODE-POINT index into {@link rawDraft}. */
  private rawCursor: number | undefined

  constructor(deps: ScheduleWorkspacePanelDeps) {
    this.deps = deps
    this.snapshot = deps.snapshot()
  }

  /** Publish a newer controller snapshot (the host calls this on every change). */
  setSnapshot(snapshot: ScheduleWorkspaceSnapshot): void {
    if (this.disposed) return
    const previous = this.snapshot
    this.snapshot = snapshot
    if (snapshot.mode !== previous.mode) {
      this.detailScroll = 0
      this.historyScroll = 0
      this.editorScroll = 0
      this.helpScroll = 0
    }
    if (snapshot.mode !== 'list'
      || previous.mode !== 'list'
      || previous.selectedId !== snapshot.selectedId
      || previous.filter !== snapshot.filter
      || previous.query !== snapshot.query) {
      // The selection/filter/search changed: the controller's cursor wins
      // again over a wheel gesture that pinned the viewport.
      this.listScrollPinned = false
    }
    if (snapshot.mode !== 'editor') {
      this.chooser = undefined
      this.editorFieldId = undefined
      this.editorBaseline = undefined
      this.editorDispatched = undefined
    }
    if (snapshot.mode !== 'list') {
      this.searchFocused = false
      this.focusPane = 'list'
      this.searchBaseline = undefined
      this.searchDispatched = undefined
    }
    if (snapshot.confirm === undefined) this.paintedConfirm = undefined
    // Adopt a newer field value BEFORE the next input event: a snapshot change
    // is committed here, not only on the next frame.
    if (snapshot.mode === 'editor') this.syncEditorInput()
  }

  /** Release panel-local state exactly once (idempotent). */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.frame = undefined
    this.pressed = undefined
    this.paintedConfirm = undefined
    this.chooser = undefined
    this.editorFieldId = undefined
    this.editorBaseline = undefined
    this.editorDispatched = undefined
    this.rawDraft = undefined
    this.searchBaseline = undefined
    this.searchDispatched = undefined
    this.searchInput.focused = false
    this.editorInput.focused = false
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.searchInput.focused = value && this.searchFocused
    this.editorInput.focused = value && this.snapshot.mode === 'editor' && this.chooser === undefined
  }

  /** The Component contract: no child theme cache to invalidate. */
  invalidate(): void {
    this.searchInput.invalidate()
    this.editorInput.invalidate()
  }

  // ── input ──────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return
    if (this.snapshot.confirm !== undefined) {
      this.handleConfirmInput(data)
      return
    }
    if (this.chooser !== undefined) {
      this.handleChooserInput(data)
      return
    }
    if (this.searchFocused) {
      this.handleSearchInput(data)
      return
    }
    switch (this.snapshot.mode) {
      case 'list':
        this.handleListInput(data)
        return
      case 'detail':
        this.handleDetailInput(data)
        return
      case 'history':
        this.handleHistoryInput(data)
        return
      case 'editor':
        this.handleEditorInput(data)
        return
      case 'help':
        this.handleHelpInput(data)
        return
    }
  }

  private handleConfirmInput(data: string): void {
    if (this.matchesLetter(data, 'y')) {
      this.commitPaintedConfirm()
      return
    }
    if (this.matchesLetter(data, 'n') || matchesKey(data, 'escape')) {
      this.cancelConfirm()
    }
  }

  private handleListInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.deps.close()
      return
    }
    if (matchesKey(data, 'up') || this.matchesLetter(data, 'k')) {
      this.deps.dispatch({ kind: 'move', delta: -1 })
      return
    }
    if (matchesKey(data, 'down') || this.matchesLetter(data, 'j')) {
      this.deps.dispatch({ kind: 'move', delta: 1 })
      return
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      // The pane focus rotation is the WIDE layout's; a single column has no
      // second pane to focus without leaving the screen.
      if (this.currentLayout() === 'wide') this.rotateFocus(matchesKey(data, 'tab') ? 1 : -1)
      return
    }
    if (matchesKey(data, '/')) {
      this.focusSearch()
      return
    }
    if (this.matchesLetter(data, 'a')) {
      this.deps.dispatch({ kind: 'set-filter', filter: 'active' })
      return
    }
    if (this.matchesLetter(data, 'p')) {
      this.deps.dispatch({ kind: 'set-filter', filter: 'paused' })
      return
    }
    if (this.matchesLetter(data, 'e')) {
      this.deps.dispatch({ kind: 'set-filter', filter: 'ended' })
      return
    }
    if (this.matchesLetter(data, 'l')) {
      this.deps.dispatch({ kind: 'set-filter', filter: 'all' })
      return
    }
    if (this.matchesLetter(data, 'r')) {
      this.deps.dispatch({ kind: 'refresh' })
      return
    }
    if (this.matchesLetter(data, 'n')) {
      this.deps.dispatch({ kind: 'open-create' })
      return
    }
    if (matchesKey(data, 'enter')) {
      this.deps.dispatch({ kind: 'open-detail' })
      return
    }
    if (this.matchesLetter(data, 'x')) {
      this.deps.dispatch({ kind: 'ask-clear-ended' })
      return
    }
    if (matchesKey(data, '?')) {
      this.deps.dispatch({ kind: 'open-help' })
    }
  }

  private handleDetailInput(data: string): void {
    if (matchesKey(data, '?')) {
      this.deps.dispatch({ kind: 'open-help' })
      return
    }
    if (matchesKey(data, 'escape')) {
      this.deps.dispatch({ kind: 'back' })
      return
    }
    if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
      this.pageBody(matchesKey(data, 'pageUp') ? -1 : 1)
      return
    }
    if (this.matchesLetter(data, 'h')) {
      this.deps.dispatch({ kind: 'open-history' })
      return
    }
    if (this.matchesLetter(data, 'e')) {
      this.deps.dispatch({ kind: 'open-edit' })
      return
    }
    if (matchesKey(data, 'space')) {
      this.deps.dispatch({ kind: 'toggle-active' })
      return
    }
    if (this.matchesLetter(data, 'u')) {
      this.deps.dispatch({ kind: 'ask-run' })
      return
    }
    if (this.matchesLetter(data, 'd')) {
      this.deps.dispatch({ kind: 'ask-delete' })
    }
  }

  private handleHistoryInput(data: string): void {
    if (matchesKey(data, '?')) {
      this.deps.dispatch({ kind: 'open-help' })
      return
    }
    if (matchesKey(data, 'escape')) {
      this.deps.dispatch({ kind: 'back' })
      return
    }
    if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
      this.pageBody(matchesKey(data, 'pageUp') ? -1 : 1)
      return
    }
    if (matchesKey(data, 'enter') && this.snapshot.history?.nextBefore !== undefined) {
      this.deps.dispatch({ kind: 'history-more' })
    }
  }

  private handleEditorInput(data: string): void {
    const draft = this.snapshot.editor
    if (draft === undefined) return
    const focused = focusedField(draft)
    // A TEXT field owns every printable character, `?` included; Help is the
    // `?` action only where there is no text to type (the kind/target/advanced
    // /weekday controls). The choice/kind fields open their chooser on Enter.
    const typing = focused !== undefined && (isEditorTextInput(focused) || (focused !== undefined && this.isRawEditorField(focused)))
    if (matchesKey(data, '?') && !typing) {
      this.deps.dispatch({ kind: 'open-help' })
      return
    }
    if (matchesKey(data, 'escape')) {
      this.deps.dispatch({ kind: 'back' })
      return
    }
    if (matchesKey(data, 'ctrl+s')) {
      this.deps.dispatch({ kind: 'save' })
      return
    }
    if (matchesKey(data, 'ctrl+r')) {
      this.deps.dispatch({ kind: 'reload-latest' })
      return
    }
    if (matchesKey(data, 'tab')) {
      this.deps.dispatch(editorFocusIntent(draft, 1))
      this.deps.requestRender()
      return
    }
    if (matchesKey(data, 'shift+tab')) {
      this.deps.dispatch(editorFocusIntent(draft, -1))
      this.deps.requestRender()
      return
    }
    if (focused !== undefined && this.isRawEditorField(focused)) {
      // A RAW field is MULTI-LINE text: Enter inserts a line, Backspace deletes,
      // printable input (a paste included) appends verbatim.
      this.handleRawInput(draft, focused, data)
      return
    }
    if (matchesKey(data, 'enter')) {
      this.activateField(draft)
      return
    }
    const field = focusedField(draft)
    if (field === undefined || !isEditorTextInput(field)) return
    this.syncEditorInput()
    this.editorInput.handleInput(data)
    const next = this.editorInput.getValue()
    if (next !== this.editorDispatched) {
      this.editorDispatched = next
      this.deps.dispatch({ kind: 'set-field', fieldId: field.id, value: next })
      this.deps.requestRender()
    }
  }

  /** Prompt and RRULE are RAW multi-line fields: their stored bytes (newlines
   *  included) are edited verbatim, never through the single-line sanitizer. */
  private isRawEditorField(field: ScheduleFormField): boolean {
    return field.id === 'prompt' || field.id === 'timing-rrule'
  }

  private handleRawInput(draft: ScheduleEditorDraft, field: ScheduleFormField, data: string): void {
    const buffer = this.rawDraft ?? field.value
    const points = Array.from(buffer)
    let caret = Math.max(0, Math.min(this.rawCursor ?? points.length, points.length))
    const lineStart = (at: number): number => {
      const newline = points.lastIndexOf('\n', at - 1)
      return newline < 0 ? 0 : newline + 1
    }
    const lineEnd = (at: number): number => {
      const newline = points.indexOf('\n', at)
      return newline < 0 ? points.length : newline
    }
    let insert: string[] | undefined
    const pasted = data.match(/^\x1b\[200~([\s\S]*)\x1b\[201~$/u)?.[1]
    if (pasted !== undefined) insert = Array.from(pasted)
    else if (matchesKey(data, 'enter')) insert = ['\n']
    else if (matchesKey(data, 'backspace')) {
      if (caret > 0) { points.splice(caret - 1, 1); caret -= 1 }
    } else if (matchesKey(data, 'delete')) {
      if (caret < points.length) points.splice(caret, 1)
    } else if (matchesKey(data, 'left')) {
      caret = Math.max(0, caret - 1)
    } else if (matchesKey(data, 'right')) {
      caret = Math.min(points.length, caret + 1)
    } else if (matchesKey(data, 'home')) {
      caret = lineStart(caret)
    } else if (matchesKey(data, 'end')) {
      caret = lineEnd(caret)
    } else if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      // Keep the visual column across lines, like every multi-line editor.
      const start = lineStart(caret)
      const column = caret - start
      if (matchesKey(data, 'up') && start > 0) {
        const previousStart = lineStart(start - 1)
        caret = Math.min(previousStart + column, start - 1)
      } else if (matchesKey(data, 'down') && lineEnd(caret) < points.length) {
        const nextStart = lineEnd(caret) + 1
        caret = Math.min(nextStart + column, lineEnd(nextStart))
      }
    } else if (this.isPrintableInput(data)) {
      insert = Array.from(data)
    } else {
      return
    }
    if (insert !== undefined) {
      points.splice(caret, 0, ...insert)
      caret += insert.length
    }
    const next = points.join('')
    this.rawCursor = caret
    // Caret-only movement changes no text: it must not publish a draft write.
    if (next !== buffer) {
      this.rawDraft = next
      this.rawDispatched = next
      this.deps.dispatch({ kind: 'set-field', fieldId: field.id, value: next })
    }
    this.deps.requestRender()
  }

  /** Any printable Unicode input (CJK, emoji, text pastes) — only C0/C1
   *  control bytes (and the ESC introducer) are input protocol, never text. */
  private isPrintableInput(data: string): boolean {
    if (data.length === 0) return false
    for (const character of data) {
      const code = character.codePointAt(0) ?? 0
      if (code === 0x0a) continue
      if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return false
    }
    return true
  }

  private handleHelpInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.deps.dispatch({ kind: 'close-help' })
      return
    }
    if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
      this.pageBody(matchesKey(data, 'pageUp') ? -1 : 1)
    }
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.exitSearch()
      return
    }
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      if (this.currentLayout() === 'wide') this.rotateFocus(matchesKey(data, 'tab') ? 1 : -1)
      else this.exitSearch()
      return
    }
    this.syncSearchInput()
    this.searchInput.handleInput(data)
    const next = this.searchInput.getValue()
    if (next !== this.searchDispatched) {
      this.searchDispatched = next
      this.deps.dispatch({ kind: 'set-query', query: next })
      this.deps.requestRender()
    }
  }

  private handleChooserInput(data: string): void {
    const chooser = this.chooser
    if (chooser === undefined) return
    if (matchesKey(data, 'escape')) {
      this.chooser = undefined
      this.deps.requestRender()
      return
    }
    if (matchesKey(data, 'up') || this.matchesLetter(data, 'k')) {
      this.chooser = { ...chooser, index: wrapIndex(chooser.index - 1, chooser.options.length) }
      this.deps.requestRender()
      return
    }
    if (matchesKey(data, 'down') || this.matchesLetter(data, 'j')) {
      this.chooser = { ...chooser, index: wrapIndex(chooser.index + 1, chooser.options.length) }
      this.deps.requestRender()
      return
    }
    if (matchesKey(data, 'enter')) this.chooseOption(chooser)
  }

  private chooseOption(chooser: OpenChooser): void {
    const option = chooser.options[chooser.index]
    this.chooser = undefined
    if (option === undefined) {
      this.deps.requestRender()
      return
    }
    switch (chooser.fieldId) {
      case 'timing-kind':
        this.deps.dispatch({ kind: 'select-timing-kind', timing: option.value as ScheduleTimingKind })
        return
      case 'target-kind':
        this.deps.dispatch({ kind: 'select-target-kind', target: option.value as ScheduleTargetKind })
        return
      case 'target-session':
        this.deps.dispatch({ kind: 'select-target-session', sessionId: option.value })
        return
      default:
        this.deps.requestRender()
    }
  }

  private activateField(draft: ScheduleEditorDraft): void {
    const field = focusedField(draft)
    if (field === undefined) return
    if (field.id === 'timing-kind') {
      this.openChooser(field, timingChooserOptions())
      return
    }
    if (field.id === 'target-kind') {
      this.openChooser(field, targetChooserOptions())
      return
    }
    if (field.id === 'target-session') {
      this.openChooser(field, sessionChooserOptions(this.snapshot.sessions))
      return
    }
    if (field.kind === 'weekday') {
      const weekday = weekdayFromField(field)
      if (weekday !== undefined) {
        this.deps.dispatch({ kind: 'toggle-weekday', weekday })
        this.deps.requestRender()
      }
      return
    }
    if (field.kind === 'toggle') {
      this.deps.dispatch({ kind: 'toggle-advanced' })
      this.deps.requestRender()
    }
  }

  private openChooser(field: ScheduleFormField, options: readonly ScheduleEditorChoice[]): void {
    if (options.length === 0) {
      this.deps.requestRender()
      return
    }
    this.chooser = { fieldId: field.id, title: editorChooserTitle(field), options, index: 0 }
    this.deps.requestRender()
  }

  private focusSearch(): void {
    this.searchFocused = true
    this.focusPane = 'search'
    this.syncSearchInput()
    this.deps.requestRender()
  }

  private exitSearch(): void {
    this.searchFocused = false
    this.focusPane = 'list'
    this.searchInput.focused = false
    this.deps.requestRender()
  }

  private rotateFocus(delta: number): void {
    const order: readonly FocusPane[] = ['filter', 'search', 'list', 'detail']
    const index = order.indexOf(this.focusPane)
    const next = order[wrapIndex(index + delta, order.length)]
    this.focusPane = next
    this.searchFocused = next === 'search'
    if (this.searchFocused) this.syncSearchInput()
    else this.searchInput.focused = false
    this.deps.requestRender()
  }

  private commitPaintedConfirm(): void {
    const confirm = this.snapshot.confirm
    const painted = this.paintedConfirm
    if (confirm === undefined || painted === undefined) return
    if (confirm.kind !== painted.kind || confirm.token !== painted.token) return
    this.deps.dispatch({ kind: 'confirm' })
  }

  private cancelConfirm(): void {
    if (this.snapshot.confirm === undefined) return
    this.deps.dispatch({ kind: 'cancel' })
  }

  /** Scroll a non-list body by one visible page. Panel-local, never a Host intent. */
  private pageBody(direction: -1 | 1): void {
    const page = Math.max(1, Math.floor(this.deps.rows()) - 4)
    if (this.snapshot.mode === 'detail') this.detailScroll = Math.max(0, this.detailScroll + direction * page)
    else if (this.snapshot.mode === 'history') this.historyScroll = Math.max(0, this.historyScroll + direction * page)
    else if (this.snapshot.mode === 'help') this.helpScroll = Math.max(0, this.helpScroll + direction * page)
    this.deps.requestRender()
  }

  private matchesLetter(data: string, letter: 'a' | 'd' | 'e' | 'h' | 'j' | 'k' | 'l' | 'n' | 'p' | 'r' | 'u' | 'x' | 'y'): boolean {
    return matchesKey(data, letter) || matchesKey(data, Key.shift(letter))
  }

  // ── rendering ──────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.disposed) return []
    const paintedWidth = Math.max(1, Math.floor(width))
    const rows = Math.max(1, Math.floor(this.deps.rows()))
    const columns = Math.max(1, Math.floor(this.deps.columns()))
    const layout = scheduleWorkspaceLayout(Math.min(paintedWidth, columns), rows)
    this.syncSearchInput()
    this.syncEditorInput()
    const snapshot = this.snapshot
    this.paintedConfirm = snapshot.confirm === undefined
      ? undefined
      : { kind: snapshot.confirm.kind, token: snapshot.confirm.token }

    const lines: string[] = []
    const regions: PaintedRegion[] = []
    this.paintTitleRow(lines, regions, paintedWidth)
    this.paintFilterRow(lines, regions, paintedWidth, layout)
    this.paintSearchRow(lines, regions, paintedWidth)
    // A stale/error catalog is a fact about EVERY page: the detail and history
    // snapshots behind it were read before the invalidation, so the banner is
    // painted above the body instead of only inside the list.
    const banner = this.listBanner()
    if (banner !== undefined) {
      lines.push(banner.paint(truncateToWidth(sanitizedPhysicalLine(banner.text), paintedWidth, '…', false)))
    }
    const bodyHeight = Math.max(0, rows - 4 - (banner === undefined ? 0 : 1))

    if (snapshot.confirm !== undefined) {
      this.paintSingleBody(lines, regions, paintedWidth, bodyHeight, this.confirmBody(snapshot.confirm, paintedWidth), 0)
    } else if (snapshot.mode === 'help') {
      this.paintSingleBody(lines, regions, paintedWidth, bodyHeight, this.helpBody(paintedWidth), this.helpScroll)
    } else if (layout === 'wide') {
      this.paintWideBody(lines, regions, paintedWidth, bodyHeight)
    } else {
      this.paintSingleMode(lines, regions, paintedWidth, bodyHeight)
    }

    this.paintActionBar(lines, regions, paintedWidth)
    while (lines.length < rows) lines.push(' '.repeat(paintedWidth))
    this.frame = {
      width: paintedWidth,
      height: lines.length,
      regions,
    }
    return lines.slice(0, rows)
  }

  private paintTitleRow(lines: string[], regions: PaintedRegion[], width: number): void {
    const segments: CellSegment[] = [{ plain: 'Schedule · Host tasks', paint: color.textStrong }]
    // The New/Refresh shortcuts are the list root's; a modal confirmation and
    // every other mode own the keyboard, so their buttons are not painted (and
    // therefore cannot be clicked) there either.
    if (this.snapshot.mode === 'list' && this.snapshot.confirm === undefined) {
      segments.push(
        { plain: '  ' },
        { plain: 'New [N]', paint: color.primary, hit: { kind: 'action', action: 'new' } },
        { plain: '  ' },
        { plain: 'Refresh [R]', paint: color.primary, hit: { kind: 'action', action: 'refresh' } },
      )
    }
    this.pushSegments(lines, regions, width, segments)
  }

  private paintFilterRow(
    lines: string[],
    regions: PaintedRegion[],
    width: number,
    layout: ScheduleWorkspaceLayout,
  ): void {
    const filters: readonly { readonly filter: ScheduleFilter; readonly label: string }[] = [
      { filter: 'all', label: 'All' },
      { filter: 'active', label: 'Active' },
      { filter: 'paused', label: 'Paused' },
      { filter: 'ended', label: 'Ended' },
    ]
    const interactive = this.snapshot.mode === 'list' && this.snapshot.confirm === undefined
    const segments: CellSegment[] = []
    if (layout === 'wide' && this.focusPane === 'filter') {
      segments.push({ plain: '> ', paint: color.primary })
    }
    for (const [index, entry] of filters.entries()) {
      if (index > 0) segments.push({ plain: ' ' })
      const chip = `[${entry.label}]`
      segments.push({
        plain: chip,
        paint: this.snapshot.filter === entry.filter
          ? text => color.textStrong(text, 'primary')
          : color.textDim,
        ...(interactive ? { hit: { kind: 'filter', filter: entry.filter } } : {}),
      })
    }
    this.pushSegments(lines, regions, width, segments)
  }

  private paintSearchRow(lines: string[], regions: PaintedRegion[], width: number): void {
    const focused = this.searchFocused
    const query = this.snapshot.query
    const prefix = focused ? '> ' : ''
    const label = 'Search / '
    const budget = Math.max(1, width - visibleWidth(prefix) - visibleWidth(label))
    const segments: CellSegment[] = []
    if (focused) segments.push({ plain: prefix, paint: color.primary })
    segments.push({ plain: label, paint: color.textDim })
    if (focused && this._focused) {
      this.searchInput.focused = true
      const raw = (this.searchInput.render(budget)[0] ?? '').replaceAll(CURSOR_MARKER, '')
      segments.push({ plain: query, raw })
    } else {
      segments.push(query === ''
        ? { plain: 'Type to search…', paint: color.textDim }
        : { plain: sanitizedPhysicalLine(query), paint: color.text })
    }
    const row = lines.length
    this.pushSegments(lines, regions, width, segments)
    if (this.snapshot.mode === 'list' && this.snapshot.confirm === undefined) {
      regions.push({ row, from: 0, to: width, hit: { kind: 'search' } })
    }
  }

  private paintSingleMode(
    lines: string[],
    regions: PaintedRegion[],
    width: number,
    bodyHeight: number,
  ): void {
    switch (this.snapshot.mode) {
      case 'list':
        this.paintListBody(lines, regions, width, bodyHeight)
        return
      case 'detail': {
        const content = this.detailBody(this.detailEntry(), width)
        this.paintSingleBody(lines, regions, width, bodyHeight, content, this.scrolled(this.detailScroll, content.length, bodyHeight))
        return
      }
      case 'history': {
        const content = this.historyBody(width)
        this.paintSingleBody(lines, regions, width, bodyHeight, content, this.scrolled(this.historyScroll, content.length, bodyHeight))
        return
      }
      case 'editor': {
        const content = this.editorBody(width)
        this.editorScroll = this.chooser === undefined
          ? this.revealField(content, this.editorScroll, bodyHeight)
          : this.revealChooser(content, this.editorScroll, bodyHeight)
        this.paintSingleBody(lines, regions, width, bodyHeight, content, this.editorScroll)
        return
      }
      case 'help':
        // Help is painted by its own full-width branch in `render`.
        return
    }
  }

  private paintListBody(
    lines: string[],
    regions: PaintedRegion[],
    width: number,
    bodyHeight: number,
  ): void {
    const content = this.listBody()
    this.listScroll = this.listViewport(content, bodyHeight)
    this.paintSingleBody(lines, regions, width, bodyHeight, content, this.listScroll)
  }

  private paintWideBody(
    lines: string[],
    regions: PaintedRegion[],
    width: number,
    bodyHeight: number,
  ): void {
    const leftWidth = Math.max(20, Math.floor((width - 2) * 0.4))
    const rightWidth = Math.max(1, width - 2 - leftWidth)
    const list = this.listBody()
    this.listScroll = this.listViewport(list, bodyHeight)
    const right = this.wideRightBody(rightWidth)
    let rightScroll: number
    switch (this.snapshot.mode) {
      case 'list':
      case 'detail':
        rightScroll = this.scrolled(this.detailScroll, right.length, bodyHeight)
        this.detailScroll = rightScroll
        break
      case 'history':
        rightScroll = this.scrolled(this.historyScroll, right.length, bodyHeight)
        this.historyScroll = rightScroll
        break
      case 'editor':
        this.editorScroll = this.chooser === undefined
          ? this.revealField(right, this.editorScroll, bodyHeight)
          : this.revealChooser(right, this.editorScroll, bodyHeight)
        rightScroll = this.editorScroll
        break
      default:
        rightScroll = 0
    }
    for (let index = 0; index < bodyHeight; index += 1) {
      const left = list[this.listScroll + index]
      const rightLine = right[rightScroll + index]
      this.pushWideRow(lines, regions, leftWidth, rightWidth, left, rightLine)
    }
  }

  private wideRightBody(width: number): readonly BodyLine[] {
    switch (this.snapshot.mode) {
      case 'list':
      case 'detail':
        return this.detailBody(this.detailEntry(), width)
      case 'history':
        return this.historyBody(width)
      case 'editor':
        return this.editorBody(width)
      default:
        return []
    }
  }

  private listBody(): readonly BodyLine[] {
    const snapshot = this.snapshot
    const content: BodyLine[] = []
    if (snapshot.notice !== undefined) content.push(this.noticeLine(snapshot.notice))
    if (snapshot.rows.length === 0) {
      const empty = snapshot.total > 0
        ? 'No tasks match the current filter or search.'
        : snapshot.status === 'loading' ? 'Loading scheduled tasks…' : 'No scheduled tasks yet.'
      content.push({ segments: [{ plain: empty, paint: color.textDim }] })
      return content
    }
    for (const entry of snapshot.rows) {
      content.push({
        segments: this.listRowSegments(entry, entry.id === snapshot.selectedId),
        rowId: entry.id,
      })
    }
    return content
  }

  private listBanner(): PaintedBanner | undefined {
    const snapshot = this.snapshot
    if (snapshot.status === 'ready') return undefined
    const detail = snapshot.statusMessage === undefined ? '' : ` · ${sanitizedPhysicalLine(snapshot.statusMessage)}`
    if (snapshot.status === 'loading') {
      return { text: 'Loading scheduled tasks…', paint: color.textDim }
    }
    if (snapshot.status === 'error') {
      return { text: `Schedule unavailable${detail}`, paint: color.error }
    }
    return { text: `Showing the last read catalog${detail}`, paint: color.warning }
  }

  private listRowSegments(entry: ScheduleCatalogEntry, selected: boolean): readonly CellSegment[] {
    return [
      { plain: selected ? '> ' : '  ', paint: selected ? color.primary : undefined },
      { plain: scheduleStatusText(entry), paint: this.statusPaint(entry.status) },
      { plain: '  ' },
      { plain: sanitizedPhysicalLine(entry.title), paint: selected ? text => color.textStrong(text) : color.text },
      { plain: '  ' },
      { plain: sanitizedPhysicalLine(formatRuleSummary(entry)), paint: color.textDim },
      { plain: '  ' },
      { plain: sanitizedPhysicalLine(formatTargetSummary(entry.target)), paint: color.textDim },
      { plain: '  ' },
      { plain: sanitizedPhysicalLine(formatOccurrence(entry)), paint: color.textMuted },
    ]
  }

  private detailBody(entry: ScheduleCatalogEntry | undefined, width: number): readonly BodyLine[] {
    const active = this.snapshot.mode === 'list'
      && this.focusPane === 'detail'
      && this.currentLayout() === 'wide'
    const out: BodyLine[] = [{
      segments: [{
        plain: active ? '[Details]' : 'Details',
        paint: active ? text => color.textStrong(text, 'primary') : color.textStrong,
      }],
    }]
    if (entry === undefined) {
      out.push({ segments: [{ plain: 'Loading task…', paint: color.textDim }] })
      return out
    }
    const valueWidth = Math.max(1, width - DETAIL_LABEL_WIDTH - 1)
    const fact = (label: string, value: string, paint: (text: string) => string = color.text): void => {
      const wrapped = wrapTextWithAnsi(sanitizedPhysicalLine(value), valueWidth)
      for (const [index, part] of wrapped.entries()) {
        out.push({
          segments: [
            { plain: index === 0 ? fit(label, DETAIL_LABEL_WIDTH) : ' '.repeat(DETAIL_LABEL_WIDTH), paint: color.textDim },
            { plain: part, paint },
          ],
        })
      }
    }
    fact('Title', entry.title, color.textStrong)
    fact('Status', scheduleStatusText(entry), this.statusPaint(entry.status))
    fact('Execution', formatExecutionActivity(entry), entry.executionActive === true ? color.primary : color.textDim)
    const floor = formatDeliveryFloor(entry)
    fact('Delivery floor', floor ?? 'none', floor === undefined ? color.textDim : color.text)
    fact('Official timing', formatRuleSummary(entry))
    fact('Time zone', officialTimeZone(entry), color.textDim)
    fact('Occurrence', formatOccurrence(entry))
    fact('Target', formatTargetSummary(entry.target), color.textDim)
    fact('Id', entry.id, color.textDim)
    out.push({ segments: [{ plain: '' }] })
    out.push({ segments: [{ plain: 'Prompt', paint: color.textDim }] })
    // The stored prompt may be multi-line: every stored line is painted as its
    // own block instead of flattening the instruction into one line.
    for (const stored of entry.prompt.split('\n')) {
      const wrapped = wrapTextWithAnsi(sanitizedPhysicalLine(stored), Math.max(1, width))
      for (const line of wrapped.length === 0 ? [''] : wrapped) {
        out.push({ segments: [{ plain: line, paint: color.text }] })
      }
    }
    if (entry.lastDelivery !== undefined) {
      const receipt = deliveryFacts(entry.lastDelivery)
      out.push({ segments: [{ plain: '' }] })
      out.push({ segments: [{ plain: 'Last delivery', paint: color.textDim }] })
      fact('Scheduled', receipt.scheduledAt)
      fact('Delivered', receipt.deliveredAt)
      fact('Message', receipt.messageId, color.textDim)
      fact('Target Session', receipt.targetSessionId, color.textDim)
    }
    return out
  }

  private historyBody(width: number): readonly BodyLine[] {
    const out: BodyLine[] = [{ segments: [{ plain: 'Delivery history', paint: color.textStrong }] }]
    const history = this.snapshot.history
    if (history === undefined) {
      out.push({ segments: [{ plain: 'Loading deliveries…', paint: color.textDim }] })
      return out
    }
    if (history.status === 'loading') {
      out.push({ segments: [{ plain: 'Loading deliveries…', paint: color.textDim }] })
    }
    if (history.status === 'error') {
      out.push({
        segments: [{
          plain: sanitizedPhysicalLine(history.message ?? 'Delivery history could not be read.'),
          paint: color.error,
        }],
      })
    }
    if (history.records.length === 0 && history.status === 'ready') {
      out.push({ segments: [{ plain: 'No saved deliveries.', paint: color.textDim }] })
    }
    const valueWidth = Math.max(1, width - DETAIL_LABEL_WIDTH - 1)
    for (const [index, record] of history.records.entries()) {
      if (index > 0) out.push({ segments: [{ plain: '' }] })
      const fact = (label: string, value: string): void => {
        for (const [partIndex, part] of wrapTextWithAnsi(sanitizedPhysicalLine(value), valueWidth).entries()) {
          out.push({
            segments: [
              { plain: partIndex === 0 ? fit(label, DETAIL_LABEL_WIDTH) : ' '.repeat(DETAIL_LABEL_WIDTH), paint: color.textDim },
              { plain: part, paint: color.text },
            ],
          })
        }
      }
      fact('Scheduled', `${formatLocalInstant(record.scheduledAt)} UTC`)
      fact('Delivered', `${formatLocalInstant(record.deliveredAt)} UTC`)
      fact('Message', record.messageId)
      if (record.prompt !== undefined) {
        let first = true
        for (const stored of record.prompt.split('\n')) {
          const wrapped = wrapTextWithAnsi(sanitizedPhysicalLine(stored), valueWidth)
          for (const part of wrapped.length === 0 ? [''] : wrapped) {
            out.push({
              segments: [
                { plain: first ? fit('Prompt', DETAIL_LABEL_WIDTH) : ' '.repeat(DETAIL_LABEL_WIDTH), paint: color.textDim },
                { plain: part, paint: color.text },
              ],
            })
            first = false
          }
        }
      }
    }
    this.historyNotes(history, out)
    return out
  }

  private historyNotes(history: NonNullable<ScheduleWorkspaceSnapshot['history']>, out: BodyLine[]): void {
    if (history.earlierRecordsUnavailable) {
      out.push({ segments: [{ plain: 'Earlier deliveries may exist but are unavailable.', paint: color.textMuted }] })
    }
    if (history.earlierRecordsPruned) {
      out.push({ segments: [{ plain: 'Earlier deliveries were removed by the retention limit.', paint: color.textMuted }] })
    }
    if (history.missCode !== undefined) {
      out.push({ segments: [{ plain: sanitizedPhysicalLine(`Miss  ${history.missCode}`), paint: color.warning }] })
    }
    if (history.message !== undefined && history.status !== 'error') {
      out.push({ segments: [{ plain: sanitizedPhysicalLine(history.message), paint: color.warning }] })
    }
  }

  private editorBody(width: number): readonly BodyLine[] {
    const out: BodyLine[] = []
    const draft = this.snapshot.editor
    if (draft === undefined) {
      out.push({ segments: [{ plain: 'Loading editor…', paint: color.textDim }] })
      return out
    }
    const fact = (label: string, value: string, paint: (text: string) => string = color.text): void => {
      out.push({
        segments: [
          { plain: fit(label, EDITOR_FACT_LABEL_WIDTH), paint: color.textDim },
          { plain: sanitizedPhysicalLine(value), paint },
        ],
      })
    }
    out.push({ segments: [{ plain: 'Schedule editor', paint: color.textStrong }] })
    fact('Mode', editorModeLabel(draft.mode))
    if (draft.mode === 'edit') {
      fact('Expected updated at', draft.expectedUpdatedAt === undefined || draft.expectedUpdatedAt === null
        ? 'none'
        : draft.expectedUpdatedAt)
    }
    const limits = this.snapshot.limits
    fact('New Session floor', limits === undefined ? 'unknown' : formatSeconds(limits.newSessionIntervalSeconds))
    if (this.snapshot.notice !== undefined) out.push(this.noticeLine(this.snapshot.notice))
    out.push({ segments: [{ plain: '' }] })

    const fields = editorFields(draft)
    const focused = Math.max(0, Math.min(draft.focused, Math.max(0, fields.length - 1)))
    for (const [index, field] of fields.entries()) {
      const selected = index === focused
      const hint = editorFieldHint(field)
      const hintWidth = Math.min(visibleWidth(hint), 20)
      const valueBudget = Math.max(1, width - 2 - EDITOR_LABEL_WIDTH - 2 - hintWidth - 1)
      const segments: CellSegment[] = [
        { plain: selected ? '> ' : '  ', paint: selected ? color.primary : undefined },
        { plain: fit(field.label, EDITOR_LABEL_WIDTH), paint: color.textDim },
      ]
      if (this.isRawEditorField(field)) {
        // Multi-line raw text: one painted row per stored `\n` (the value keeps
        // the bytes; only the display wraps).
        const buffer = selected && this._focused ? (this.rawDraft ?? field.value) : field.value
        const lines = buffer.split('\n')
        if (selected && this._focused) {
          const caret = Math.max(0, Math.min(this.rawCursor ?? Array.from(buffer).length, Array.from(buffer).length))
          // Locate the caret line/column in CODE POINTS so CJK/emoji are never
          // split, then paint a window around it (the caret stays visible on a
          // long line).
          let consumed = 0
          let caretLine = 0
          let caretColumn = 0
          for (const [lineIndex, value] of lines.entries()) {
            const length = Array.from(value).length
            if (caret <= consumed + length) {
              caretLine = lineIndex
              caretColumn = caret - consumed
              break
            }
            consumed += length + 1
            caretLine = lineIndex + 1
            caretColumn = 0
          }
          // The horizontal window is measured in TERMINAL CELLS, not code
          // points: wide CJK/emoji would otherwise be cut after composeRow()
          // truncation and hide the caret.
          const windowCells = Math.max(1, valueBudget - 1)
          for (const [lineIndex, value] of lines.entries()) {
            const points = Array.from(value)
            let shown: string
            if (lineIndex === caretLine) {
              const beforePoints = points.slice(0, caretColumn)
              // Keep the END of the text before the caret, then fill the rest
              // with text after it; the caret itself always fits.
              let kept = ''
              let used = 0
              for (let index = beforePoints.length - 1; index >= 0; index -= 1) {
                const width = visibleWidth(beforePoints[index] ?? '')
                if (used + width > windowCells) break
                kept = (beforePoints[index] ?? '') + kept
                used += width
              }
              const remaining = Math.max(0, windowCells - used)
              const after = truncateToWidth(points.slice(caretColumn).join(''), remaining, '', false)
              shown = `${kept}▏${after}`
            } else {
              shown = truncateToWidth(value, windowCells, '', false)
            }
            out.push({
              segments: lineIndex === 0
                ? [
                    { plain: '> ', paint: color.primary },
                    { plain: fit(field.label, EDITOR_LABEL_WIDTH), paint: color.textDim },
                    { plain: sanitizedPhysicalLine(shown), paint: color.textStrong },
                  ]
                : [
                    { plain: '  ' },
                    { plain: ' '.repeat(EDITOR_LABEL_WIDTH) },
                    { plain: sanitizedPhysicalLine(shown), paint: color.textStrong },
                  ],
              fieldId: field.id,
              ...(lineIndex === caretLine ? { caretRow: true } : {}),
            })
          }
          continue
        }
        segments.push({
          plain: lines.join(' ⏎ '),
          paint: selected ? text => color.textStrong(text) : color.text,
        })
        segments.push({ plain: '  ' })
        segments.push({ plain: hint, paint: color.textMuted })
        out.push({ segments, fieldId: field.id })
        continue
      }
      if (selected && isEditorTextInput(field) && this._focused) {
        this.editorInput.focused = true
        segments.push({
          plain: sanitizedPhysicalLine(field.value),
          raw: (this.editorInput.render(valueBudget)[0] ?? '').replaceAll(CURSOR_MARKER, ''),
        })
      } else {
        segments.push({
          plain: sanitizedPhysicalLine(field.value),
          paint: selected ? text => color.textStrong(text) : color.text,
        })
      }
      segments.push({ plain: '  ' })
      segments.push({ plain: hint, paint: color.textMuted })
      out.push({ segments, fieldId: field.id })
    }

    out.push({ segments: [{ plain: '' }] })
    out.push({ segments: [{ plain: 'Sessions', paint: color.textDim }] })
    if (this.snapshot.sessions.length === 0) {
      out.push({ segments: [{ plain: 'No Sessions available', paint: color.textDim }] })
    } else {
      const chosen = draft.target.kind === 'session' ? draft.target.sessionId : undefined
      for (const session of this.snapshot.sessions) {
        const segments: CellSegment[] = [
          { plain: sanitizedPhysicalLine(`  ${session.id}`), paint: color.text },
        ]
        if (session.title !== undefined) {
          segments.push({ plain: sanitizedPhysicalLine(`  ${session.title}`), paint: color.textDim })
        }
        if (chosen === session.id) segments.push({ plain: '  [current]', paint: color.textMuted })
        out.push({ segments })
      }
    }

    if (this.chooser !== undefined) {
      out.push({ segments: [{ plain: '' }] })
      out.push({
        segments: [{
          plain: sanitizedPhysicalLine(`${this.chooser.title} · Enter choose · Esc cancel`),
          paint: color.textStrong,
        }],
        chooserTitle: true,
      })
      for (const [index, option] of this.chooser.options.entries()) {
        const selected = index === this.chooser.index
        out.push({
          segments: [
            { plain: selected ? '> ' : '  ', paint: selected ? color.primary : undefined },
            { plain: sanitizedPhysicalLine(option.label), paint: selected ? text => color.textStrong(text) : color.text },
          ],
          chooserIndex: index,
        })
      }
    }
    return out
  }

  private helpBody(width: number): readonly BodyLine[] {
    const entries: readonly (readonly [string, string])[] = [
      ['↑/↓, j/k', 'Move the task selection'],
      ['Enter', 'Open the selected task'],
      ['N', 'Create a task'],
      ['R', 'Refresh the Host catalog'],
      ['/', 'Focus search; Esc returns to the list'],
      ['A / P / E / L', 'Filter All / Active / Paused / Ended'],
      ['X', 'Clear ended tasks'],
      ['?', 'This help page'],
      ['H (detail)', 'Delivery history'],
      ['E (detail)', 'Edit the task'],
      ['Space (detail)', 'Pause or resume the task'],
      ['U (detail)', 'Run the task now'],
      ['D (detail)', 'Delete the task'],
      ['Enter (history)', 'Load the next page when More is shown'],
      [`${formatKeyId(Key.tab)} / ${formatKeyId(Key.shift(Key.tab))}`, 'Rotate focus: filter, search, list, detail'],
      ['PgUp / PgDn', 'Scroll detail, history or help'],
      [`${formatKeyId(Key.ctrl('s'))} (editor)`, 'Save the schedule'],
      [`${formatKeyId(Key.ctrl('r'))} (editor)`, 'Reload the latest Host revision, keeping your draft'],
      [`${formatKeyId(Key.tab)} / ${formatKeyId(Key.shift(Key.tab))} (editor)`, 'Move between fields'],
      ['y / n', 'Confirm or cancel a confirmation'],
      ['Esc', 'Back one layer; close the workspace at the list root'],
    ]
    const out: BodyLine[] = [{ segments: [{ plain: 'Schedule help', paint: color.textStrong }] }]
    for (const [key, description] of entries) {
      for (const [index, part] of wrapTextWithAnsi(description, Math.max(1, width - EDITOR_LABEL_WIDTH)).entries()) {
        out.push({
          segments: [
            { plain: index === 0 ? fit(key, EDITOR_LABEL_WIDTH) : ' '.repeat(EDITOR_LABEL_WIDTH), paint: color.primary },
            { plain: part, paint: color.text },
          ],
        })
      }
    }
    return out
  }

  private confirmBody(confirm: ScheduleConfirm, width: number): readonly BodyLine[] {
    const question = confirmQuestion(confirm)
    const out: BodyLine[] = [{ segments: [{ plain: '' }] }]
    out.push({ segments: [{ plain: 'Confirm', paint: color.textStrong }] })
    for (const part of wrapTextWithAnsi(sanitizedPhysicalLine(question), Math.max(1, width - 2))) {
      out.push({ segments: [{ plain: `  ${part}`, paint: color.text }] })
    }
    out.push({ segments: [{ plain: '' }] })
    out.push({
      segments: [
        { plain: 'Confirm [Y]', paint: text => color.textStrong(text, 'primary'), hit: { kind: 'action', action: 'confirm' } },
        { plain: '   ' },
        { plain: 'Cancel [N]', paint: color.textDim, hit: { kind: 'action', action: 'cancel' } },
        { plain: '   ' },
        { plain: 'Esc cancel', paint: color.textMuted },
      ],
    })
    return out
  }

  private noticeLine(notice: ScheduleNotice): BodyLine {
    return {
      segments: [{
        plain: sanitizedPhysicalLine(`${notice.kind === 'error' ? '✗' : 'ℹ'} ${notice.text}`),
        paint: notice.kind === 'error' ? color.error : color.textMuted,
      }],
    }
  }

  private detailEntry(): ScheduleCatalogEntry | undefined {
    const snapshot = this.snapshot
    if (snapshot.detail !== undefined) return snapshot.detail
    return snapshot.rows.find(row => row.id === snapshot.selectedId)
  }

  private statusPaint(status: ScheduleTaskStatus): (text: string) => string {
    switch (status) {
      case 'active': return color.primary
      case 'paused': return color.warning
      case 'ended': return color.textDim
    }
  }

  // ── body painting helpers ──────────────────────────────────────────────────

  private paintSingleBody(
    lines: string[],
    regions: PaintedRegion[],
    width: number,
    bodyHeight: number,
    content: readonly BodyLine[],
    offset: number,
  ): void {
    const start = Math.max(0, Math.min(offset, Math.max(0, content.length - bodyHeight)))
    for (let index = 0; index < bodyHeight; index += 1) {
      const line = content[start + index]
      if (line === undefined) {
        lines.push(' '.repeat(width))
        continue
      }
      this.pushBodyLine(lines, regions, width, line)
    }
  }

  private pushBodyLine(
    lines: string[],
    regions: PaintedRegion[],
    width: number,
    bodyLine: BodyLine,
  ): void {
    const row = lines.length
    const composed = this.composeRow(width, bodyLine.segments)
    lines.push(composed.line)
    for (const region of composed.regions) {
      regions.push({ row, from: region.from, to: region.to, hit: region.hit })
    }
    if (bodyLine.rowId !== undefined) {
      regions.push({ row, from: 0, to: width, hit: { kind: 'row', id: bodyLine.rowId } })
    }
    if (bodyLine.fieldId !== undefined) {
      regions.push({ row, from: 0, to: width, hit: { kind: 'field', id: bodyLine.fieldId } })
    }
  }

  private pushWideRow(
    lines: string[],
    regions: PaintedRegion[],
    leftWidth: number,
    rightWidth: number,
    left: BodyLine | undefined,
    right: BodyLine | undefined,
  ): void {
    const row = lines.length
    const leftComposed = left === undefined
      ? { line: ' '.repeat(leftWidth), regions: [] as readonly { from: number; to: number; hit: ScheduleHit }[] }
      : this.composeRow(leftWidth, left.segments)
    const rightComposed = right === undefined
      ? { line: ' '.repeat(rightWidth), regions: [] as readonly { from: number; to: number; hit: ScheduleHit }[] }
      : this.composeRow(rightWidth, right.segments)
    lines.push(`${leftComposed.line}  ${rightComposed.line}`)
    for (const region of leftComposed.regions) {
      regions.push({ row, from: region.from, to: region.to, hit: region.hit })
    }
    if (left?.rowId !== undefined) {
      regions.push({ row, from: 0, to: leftWidth, hit: { kind: 'row', id: left.rowId } })
    }
    for (const region of rightComposed.regions) {
      regions.push({ row, from: region.from + leftWidth + 2, to: region.to + leftWidth + 2, hit: region.hit })
    }
    if (right?.fieldId !== undefined) {
      regions.push({
        row,
        from: leftWidth + 2,
        to: leftWidth + 2 + rightWidth,
        hit: { kind: 'field', id: right.fieldId },
      })
    }
  }

  private pushSegments(
    lines: string[],
    regions: PaintedRegion[],
    width: number,
    segments: readonly CellSegment[],
  ): void {
    const row = lines.length
    const composed = this.composeRow(width, segments)
    lines.push(composed.line)
    for (const region of composed.regions) {
      regions.push({ row, from: region.from, to: region.to, hit: region.hit })
    }
  }

  private composeRow(
    width: number,
    segments: readonly CellSegment[],
  ): { readonly line: string; readonly regions: readonly { readonly from: number; readonly to: number; readonly hit: ScheduleHit }[] } {
    let line = ''
    let column = 0
    const regions: { from: number; to: number; hit: ScheduleHit }[] = []
    for (const segment of segments) {
      const remaining = width - column
      if (remaining <= 0) break
      const painted = segment.raw === undefined
        ? (() => {
            const fitted = truncateToWidth(segment.plain, remaining, '…', false)
            return segment.paint === undefined ? fitted : segment.paint(fitted)
          })()
        : truncateToWidth(segment.raw, remaining, '…', false)
      const paintedWidth = visibleWidth(painted)
      if (paintedWidth <= 0) continue
      line += painted
      if (segment.hit !== undefined) {
        regions.push({ from: column, to: column + paintedWidth, hit: segment.hit })
      }
      column += paintedWidth
    }
    if (column < width) line += ' '.repeat(width - column)
    return { line, regions }
  }

  // ── action bar ─────────────────────────────────────────────────────────────

  private paintActionBar(lines: string[], regions: PaintedRegion[], width: number): void {
    const segments: ActionBarSegment[] = []
    const actions: (ScheduleAction | undefined)[] = []
    const add = (text: string, priority: number, action?: ScheduleAction, short?: string): void => {
      segments.push({ text, priority, ...(short === undefined ? {} : { short }) })
      actions.push(action)
    }
    if (this.snapshot.confirm !== undefined) {
      // The action bar stays `<key> <verb>`; `Esc` is the LAST segment while
      // keeping the highest retained priority (design-language D8).
      add('y confirm', 9, 'confirm')
      add('n cancel', 8, 'cancel')
      add('Esc cancel', 10, 'cancel')
    } else {
      switch (this.snapshot.mode) {
        case 'list':
          add('Enter details', 9, 'enter-detail', 'Enter')
          add('n create', 8, 'new', 'n')
          add('/ search', 7, 'search', '/')
          add('x clear ended', 5, 'clear-ended', 'x')
          add('? help', 4, 'help', '?')
          add('r refresh', 3, 'refresh', 'r')
          add('Esc close', 10, 'close', 'Esc')
          break;
        case 'detail':
          add('h history', 6, 'detail-history')
          add('e edit', 7, 'detail-edit')
          add('Space pause/resume', 5, 'detail-toggle')
          add('u run now', 4, 'detail-run')
          add('d delete', 3, 'detail-delete')
          add('Esc back', 10, 'back')
          break
        case 'history':
          if (this.snapshot.history?.nextBefore !== undefined) add('Enter more', 6, 'history-more')
          add('Esc back', 10, 'back')
          break
        case 'editor':
          add(`${formatKeyId(Key.ctrl('s'))} save`, 8)
          add(`${formatKeyId(Key.ctrl('r'))} reload latest`, 7, undefined)
          add('Tab next field', 6, undefined)
          add('Esc discard', 10, 'back')
          break
        case 'help':
          add('Esc close help', 10, 'close-help')
          break
      }
    }
    const rendered = renderActionBarRow(segments, width)
    const row = lines.length
    lines.push(color.textMuted(rendered))
    const parts = rendered.split(ACTION_BAR_SEPARATOR)
    let x = 0
    let segmentIndex = 0
    for (const [index, part] of parts.entries()) {
      const trimmed = part.trimEnd()
      while (segmentIndex < segments.length && !actionPartMatches(trimmed, segments[segmentIndex].text)) {
        segmentIndex += 1
      }
      if (segmentIndex >= segments.length) break
      const action = actions[segmentIndex]
      if (action !== undefined && trimmed !== '') {
        regions.push({ row, from: x, to: x + visibleWidth(trimmed), hit: { kind: 'action', action } })
      }
      x += visibleWidth(part)
      if (index < parts.length - 1) x += visibleWidth(ACTION_BAR_SEPARATOR)
      segmentIndex += 1
    }
  }

  // ── pointer ───────────────────────────────────────────────────────────────

  onCellPress(x: number, y: number): void {
    if (this.disposed) {
      this.pressed = undefined
      return
    }
    const frame = this.frame
    if (frame === undefined || x < 0 || y < 0 || x >= frame.width || y >= frame.height) {
      this.pressed = undefined
      return
    }
    const hit = regionAt(frame, x, y)
    this.pressed = hit === undefined ? undefined : { key: hitKey(hit) }
  }

  onCellClick(x: number, y: number): void {
    if (this.disposed) return
    const frame = this.frame
    const pressed = this.pressed
    this.pressed = undefined
    if (frame === undefined || x < 0 || y < 0 || x >= frame.width || y >= frame.height) return
    const hit = regionAt(frame, x, y)
    if (hit === undefined) return
    if (pressed !== undefined && pressed.key !== hitKey(hit)) return
    this.activateHit(hit)
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed || event.type !== 'wheel') return undefined
    const frame = this.frame
    if (frame === undefined || event.width !== frame.width || event.height !== frame.height) return undefined
    const delta = event.wheelDelta ?? 0
    if (delta === 0) return undefined
    const step = delta < 0 ? -1 : 1
    if (this.snapshot.confirm !== undefined) return undefined
    if (this.snapshot.mode === 'list') {
      if (this.focusPane === 'detail') {
        this.detailScroll = Math.max(0, this.detailScroll + step)
      } else {
        this.listScroll = Math.max(0, this.listScroll + step)
        this.listScrollPinned = true
      }
    } else if (this.snapshot.mode === 'detail') {
      this.detailScroll = Math.max(0, this.detailScroll + step)
    } else if (this.snapshot.mode === 'history') {
      this.historyScroll = Math.max(0, this.historyScroll + step)
    } else if (this.snapshot.mode === 'editor') {
      this.editorScroll = Math.max(0, this.editorScroll + step)
    } else if (this.snapshot.mode === 'help') {
      this.helpScroll = Math.max(0, this.helpScroll + step)
    }
    this.deps.requestRender()
    return { handled: true, render: true }
  }

  private activateHit(hit: ScheduleHit): void {
    switch (hit.kind) {
      case 'row':
        if (!this.snapshot.rows.some(row => row.id === hit.id)) return
        this.deps.dispatch({ kind: 'open-detail', id: hit.id })
        return
      case 'filter':
        // The chips are list-page affordances; a stale hit from another page
        // must never change the filter.
        if (this.snapshot.mode !== 'list' || this.snapshot.confirm !== undefined) return
        this.deps.dispatch({ kind: 'set-filter', filter: hit.filter })
        return
      case 'search':
        if (this.snapshot.mode !== 'list' || this.snapshot.confirm !== undefined) return
        this.focusSearch()
        return
      case 'field': {
        const draft = this.snapshot.editor
        if (draft === undefined) return
        const index = fieldIndexById(editorFields(draft), hit.id)
        if (index === undefined) return
        this.deps.dispatch({ kind: 'focus-field', index })
        return
      }
      case 'action':
        this.activateAction(hit.action)
    }
  }

  private activateAction(action: ScheduleAction): void {
    switch (action) {
      case 'new': this.deps.dispatch({ kind: 'open-create' }); return
      case 'refresh': this.deps.dispatch({ kind: 'refresh' }); return
      case 'clear-ended': this.deps.dispatch({ kind: 'ask-clear-ended' }); return
      case 'help': this.deps.dispatch({ kind: 'open-help' }); return
      case 'search': this.focusSearch(); return
      case 'enter-detail': this.deps.dispatch({ kind: 'open-detail' }); return
      case 'close': this.deps.close(); return
      case 'history-more':
        if (this.snapshot.history?.nextBefore !== undefined) this.deps.dispatch({ kind: 'history-more' })
        return
      case 'detail-history': this.deps.dispatch({ kind: 'open-history' }); return
      case 'detail-edit': this.deps.dispatch({ kind: 'open-edit' }); return
      case 'detail-toggle': this.deps.dispatch({ kind: 'toggle-active' }); return
      case 'detail-run': this.deps.dispatch({ kind: 'ask-run' }); return
      case 'detail-delete': this.deps.dispatch({ kind: 'ask-delete' }); return
      case 'back': this.deps.dispatch({ kind: 'back' }); return
      case 'close-help': this.deps.dispatch({ kind: 'close-help' }); return
      case 'confirm': this.commitPaintedConfirm(); return
      case 'cancel': this.cancelConfirm()
    }
  }

  // ── panel-local state ──────────────────────────────────────────────────────

  private currentLayout(): ScheduleWorkspaceLayout {
    return scheduleWorkspaceLayout(this.deps.columns(), this.deps.rows())
  }

  private syncSearchInput(): void {
    if (!this.searchFocused) {
      const display = sanitizedPhysicalLine(this.snapshot.query)
      if (this.searchInput.getValue() !== display) this.searchInput.setValue(display)
      this.searchBaseline = undefined
      this.searchDispatched = undefined
    } else if (this.searchBaseline === undefined) {
      this.bindSearchInput()
    } else if (this.snapshot.query !== this.searchBaseline) {
      // The controller published a newer query: adopt it unless it is the
      // exact value this panel already dispatched (an echo).
      const display = sanitizedPhysicalLine(this.snapshot.query)
      if (display !== this.searchDispatched) this.searchInput.setValue(display)
      this.searchBaseline = this.snapshot.query
      this.searchDispatched = display
    }
    this.searchInput.focused = this._focused && this.searchFocused
  }

  private bindSearchInput(): void {
    const display = sanitizedPhysicalLine(this.snapshot.query)
    this.searchBaseline = this.snapshot.query
    this.searchDispatched = display
    this.searchInput.setValue(display)
  }

  private syncEditorInput(): void {
    const draft = this.snapshot.editor
    const field = draft === undefined ? undefined : focusedField(draft)
    if (draft === undefined || field === undefined || !isEditorTextInput(field)) {
      this.editorFieldId = undefined
      this.editorBaseline = undefined
      this.editorDispatched = undefined
      this.editorInput.focused = false
      return
    }
    if (this.isRawEditorField(field)) {
      // The multi-line field keeps its own raw buffer; a newer published value
      // (another window, a controller re-read) is adopted unless it is the echo
      // of what this panel just dispatched.
      if (this.editorFieldId !== field.id) {
        this.editorFieldId = field.id
        this.rawDraft = field.value
        this.rawDispatched = field.value
        this.rawCursor = Array.from(field.value).length
      } else if (field.value !== this.rawDispatched) {
        this.rawDraft = field.value
        this.rawDispatched = field.value
        this.rawCursor = Array.from(field.value).length
      }
      this.editorInput.focused = false
      return
    }
    this.rawDraft = undefined
    this.rawDispatched = undefined
    this.rawCursor = undefined
    if (this.editorFieldId !== field.id) {
      const display = sanitizedPhysicalLine(field.value)
      this.editorFieldId = field.id
      this.editorBaseline = field.value
      this.editorDispatched = display
      this.editorInput.setValue(display)
    } else if (field.value !== this.editorBaseline) {
      // The controller published a newer field value: adopt it unless it is
      // the exact value this panel already dispatched (an echo).
      const display = sanitizedPhysicalLine(field.value)
      if (display !== this.editorDispatched) this.editorInput.setValue(display)
      this.editorBaseline = field.value
      this.editorDispatched = display
    }
    this.editorInput.focused = this._focused && this.chooser === undefined
  }

  /**
   * The visible list window. A wheel gesture pins the viewport until the
   * selection/filter/search changes; otherwise the controller's selection is
   * kept visible.
   */
  private listViewport(content: readonly BodyLine[], bodyHeight: number): number {
    if (this.listScrollPinned) return this.scrolled(this.listScroll, content.length, bodyHeight)
    return this.revealSelection(content, this.listScroll, bodyHeight)
  }

  private revealSelection(
    content: readonly BodyLine[],
    scroll: number,
    bodyHeight: number,
  ): number {
    const selected = content.findIndex(line => line.rowId !== undefined && line.rowId === this.snapshot.selectedId)
    let next = scroll
    if (bodyHeight > 0 && selected >= 0) {
      if (selected < next) next = selected
      else if (selected >= next + bodyHeight) next = selected - bodyHeight + 1
    }
    return this.scrolled(next, content.length, bodyHeight)
  }

  private revealChooser(content: readonly BodyLine[], scroll: number, bodyHeight: number): number {
    const selected = content.findIndex(line => line.chooserIndex === this.chooser?.index)
    const title = content.findIndex(line => line.chooserTitle === true)
    if (bodyHeight <= 0 || selected < 0) return this.scrolled(scroll, content.length, bodyHeight)
    let next = scroll
    if (selected < next) next = selected
    else if (selected >= next + bodyHeight) next = selected - bodyHeight + 1
    // Keep the chooser heading beside its selected option whenever both fit.
    if (title >= 0 && title < next && selected - title < bodyHeight) next = title
    return this.scrolled(next, content.length, bodyHeight)
  }

  private revealField(content: readonly BodyLine[], scroll: number, bodyHeight: number): number {
    const draft = this.snapshot.editor
    if (draft === undefined) return 0
    const field = focusedField(draft)
    if (field === undefined) return 0
    // A multi-line RAW field renders one body row per stored line: scroll to the
    // row the CARET is on, never merely to the field's first row.
    const caretIndex = content.findIndex(line => line.fieldId === field.id && line.caretRow === true)
    const index = caretIndex >= 0 ? caretIndex : content.findIndex(line => line.fieldId === field.id)
    let next = scroll
    if (bodyHeight > 0 && index >= 0) {
      if (index < next) next = index
      else if (index >= next + bodyHeight) next = index - bodyHeight + 1
    }
    return this.scrolled(next, content.length, bodyHeight)
  }

  private scrolled(scroll: number, contentLength: number, bodyHeight: number): number {
    return Math.max(0, Math.min(scroll, Math.max(0, contentLength - bodyHeight)))
  }
}

/** The ONE confirmation question (the controller owns settlement). */
function confirmQuestion(confirm: ScheduleConfirm): string {
  switch (confirm.kind) {
    case 'delete':
      return `Delete "${confirm.title}" (${confirm.shortId})? Its saved deliveries are removed too.`
    case 'clear-ended':
      return 'Clear every ended task on this Host — not only the filtered rows? This cannot be undone.'
    case 'run':
      return `Run "${confirm.title}" now? The next scheduled occurrence is not consumed.`
    case 'discard':
      return 'Discard the unsaved schedule changes?'
  }
}

/** Fit plain text to an exact cell column. */
function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  return clamped + ' '.repeat(Math.max(0, width - visibleWidth(clamped)))
}

/** Wrap one index into `[0, length)`. */
function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return ((index % length) + length) % length
}

/** Whether an action-bar part is the painted (possibly ellipsized) segment. */
function actionPartMatches(part: string, text: string): boolean {
  if (part === text) return true
  if (part.endsWith('…')) {
    const core = part.slice(0, -1)
    return core !== '' && text.startsWith(core)
  }
  // A compacted segment paints only its `short` token; the full text still
  // contains that token (`N` inside `[N] Create`).
  return text.startsWith(part) || text.includes(part)
}

/** The stable identity of one hit, used to reject a mismatched press/click. */
function hitKey(hit: ScheduleHit): string {
  switch (hit.kind) {
    case 'row': return `row:${hit.id}`
    case 'filter': return `filter:${hit.filter}`
    case 'search': return 'search'
    case 'action': return `action:${hit.action}`
    case 'field': return `field:${hit.id}`
  }
}

/** Resolve the painted region at one cell of the LAST frame. */
function regionAt(frame: PaintedFrame, x: number, y: number): ScheduleHit | undefined {
  return frame.regions.find(region => region.row === y && x >= region.from && x < region.to)?.hit
}
