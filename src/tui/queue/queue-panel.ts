/**
 * The PiTui Queue manager Wide Overlay (PR-Q): ONE component whose body swaps
 * between Browse, Edit and Confirm-delete — never a stack of second modals.
 *
 * It renders from the application-level {@link QueueManagerController}'s view
 * DTO (the controller owns every decision and every Host write); this panel owns
 * only the terminal presentation: the Frame body rows, the action bar's click
 * regions, the local keys and the pointer translation. The Wide Overlay sizing
 * ladder (88 / 72 / 64 / terminal width) lives in
 * {@link queueOverlayGeometry}, which the host's overlay options and the frame's
 * row grant both read.
 *
 * Selection is the Host occurrence id (`SearchablePicker.value`), never a
 * rendered row index. Edit uses the fork's multiline `Editor` as the focused
 * control: `Enter` inserts a newline, the panel-local `Ctrl+S` saves (it must
 * never reach the global steer action) and `Esc` backs out one level.
 *
 * @module @xmoon76/dsh-pi-tui/tui/queue/queue-panel
 */

import { Editor, matchesKey, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component, Focusable, TUI, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { SearchablePicker, type SearchablePickerItem } from '../pickers/searchable-picker.ts'
import { QUEUE_CHORDS, type QueueChordId } from '../keybindings/hints.ts'
import { color, editorTheme, selectListTheme } from '../theme/runtime.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'
import { attachmentCountLabel, type QueueManagerController, type QueueManagerRow, type QueueManagerView } from '../../app/queue/manager.ts'

/** The One Wide Overlay geometry of the queue manager (design language D10). */
export interface QueueOverlayGeometry {
  readonly width: number
  readonly maxHeight: number
  readonly key: string
}

/**
 * The frozen Wide Overlay geometry: the declared content step is `88` (a list
 * with a selected-item detail line and a right-aligned count), snapped DOWN to
 * `72`, then `64`, then exactly the terminal width below `64`. Height is
 * `min(rows − 2, 28)`; the frame paints two border rows inside that height.
 */
export function queueOverlayGeometry(columns: number, rows: number): QueueOverlayGeometry {
  const safeColumns = Math.max(1, Math.floor(columns))
  const safeRows = Math.max(1, Math.floor(rows))
  const width = safeColumns >= 88 ? 88 : safeColumns >= 72 ? 72 : safeColumns >= 64 ? 64 : safeColumns
  const maxHeight = Math.min(Math.max(1, safeRows - 2), 28)
  return { width, maxHeight, key: `${safeColumns}:${safeRows}:${width}:${maxHeight}` }
}

/** The pane's ONE local-chord owner (matching and painted labels agree). */
export interface QueueChordMatcher {
  matches(id: QueueChordId, data: string): boolean
}

/** The default matcher over the frozen panel-local table. */
export const QUEUE_CHORD_MATCHER: QueueChordMatcher = {
  matches: (id, data) => QUEUE_CHORDS[id].keys.some(key => matchesKey(data, key)),
}

/** The panel's host-owned callbacks. */
export interface QueuePanelOptions {
  readonly controller: QueueManagerController
  readonly requestRender: () => void
  /** The active screen the multiline editor routes its render requests to. */
  readonly screen: () => TUI
  readonly chords?: QueueChordMatcher
  /** Ask the host to retire the overlay (Browse's Esc). */
  readonly close: () => void
}

/** One painted action-bar segment with its clickable cell range. */
interface BarSegment {
  readonly id: ActionId
  text: string
  readonly priority: number
  readonly short?: string
}

type ActionId = 'edit' | 'delete' | 'save' | 'confirm' | 'cancel' | 'navigate'

/** One action-bar layout result: the painted row plus whole-segment ranges. */
interface BarLayout {
  readonly text: string
  readonly ranges: readonly { readonly id: ActionId; readonly start: number; readonly end: number }[]
}

const BAR_SEPARATOR = ' · '

/** Lay out the action bar exactly like the shared row (compact short forms
 * first, then drop whole lowest-priority segments; Esc is never dropped). */
function layoutBar(input: readonly BarSegment[], width: number): BarLayout {
  const list = input.map(segment => ({ ...segment }))
  for (;;) {
    const pieces: { id: ActionId; start: number; end: number }[] = []
    let cursor = 0
    let text = ''
    for (const [index, segment] of list.entries()) {
      if (index > 0) {
        text += BAR_SEPARATOR
        cursor += BAR_SEPARATOR.length
      }
      const start = cursor
      text += segment.text
      cursor += visibleWidth(segment.text)
      pieces.push({ id: segment.id, start, end: cursor })
    }
    if (visibleWidth(text) <= width || list.length <= 1) {
      return { text: color.textDim(truncateToWidth(text, width, '…', true)), ranges: pieces }
    }
    const shortenable = list.find(segment => segment.short !== undefined && segment.text !== segment.short)
    if (shortenable !== undefined) {
      shortenable.text = shortenable.short!
      continue
    }
    let lowest = 0
    for (let index = 1; index < list.length; index += 1) {
      if (list[index]!.priority < list[lowest]!.priority) lowest = index
    }
    list.splice(lowest, 1)
  }
}

/** One last-painted hit region of the panel. */
type PanelHit =
  | { readonly kind: 'picker'; readonly offsetY: number }
  | { readonly kind: 'action'; readonly ranges: readonly { readonly id: ActionId; readonly start: number; readonly end: number }[] }
  | { readonly kind: 'inert' }

interface PanelPress {
  readonly hit: PanelHit
  readonly width: number
  /** The exact action segment the press resolved (when it hit one). */
  readonly actionId?: ActionId
}

export class QueuePanel implements Component, Focusable {
  private readonly controller: QueueManagerController
  private readonly requestRender: () => void
  private readonly screen: () => TUI
  private readonly chords: QueueChordMatcher
  private readonly closePanel: () => void
  private readonly picker: SearchablePicker
  private editor: Editor | undefined
  private maxRows = 24
  private hits: PanelHit[] = []
  private lastRenderWidth = -1
  private pressed: PanelPress | undefined
  private pickerSignature = ''
  private focusedFlag = false

  constructor(options: QueuePanelOptions) {
    this.controller = options.controller
    this.requestRender = options.requestRender
    this.screen = options.screen
    this.chords = options.chords ?? QUEUE_CHORD_MATCHER
    this.closePanel = options.close
    this.picker = new SearchablePicker([], 5, selectListTheme, {}, {
      enableSearch: false,
      descriptionMode: 'selected-below',
      showHint: false,
      noMatchText: 'No queued messages',
    })
    this.picker.onSelect = (item) => {
      // Browse activation: a text-only occurrence opens Edit; an
      // attachment-bearing one states why it cannot (the controller decides
      // from the RAW content, never from this label).
      this.controller.startEdit(item.value)
    }
    this.picker.onSelectionChange = (item) => {
      this.controller.select(item.value)
    }
    this.picker.onCancel = () => {
      this.controller.close()
      this.closePanel()
    }
  }

  get focused(): boolean {
    return this.focusedFlag
  }

  set focused(value: boolean) {
    this.focusedFlag = value
    if (this.editor !== undefined) this.editor.focused = value
  }

  /** The host's row grant (the frame's `maxHeight − 2`). */
  setMaxRows(rows: number): void {
    this.maxRows = Math.max(1, Math.floor(rows))
    this.picker.setMaxRows(Math.max(1, this.maxRows - 2))
  }

  invalidate(): void {}

  dispose(): void {
    this.editor = undefined
  }

  handleInput(data: string): void {
    const view = this.controller.view()
    switch (view.mode) {
      case 'closed':
        return
      case 'browse': {
        if (this.chords.matches('edit', data)) {
          // The panel forwards the CURRENT selection only. It never substitutes
          // the first live row: after a lost Dock preselection the manager must
          // answer `Select a queued message` instead of editing another occurrence.
          this.controller.startEdit()
          return
        }
        if (this.chords.matches('remove', data)) {
          this.controller.startDelete()
          return
        }
        if (this.chords.matches('cancel', data)) {
          this.controller.close()
          this.closePanel()
          return
        }
        // Semantic key matching, never a raw escape-sequence comparison:
        // CSI-u/modifyOtherKeys/SS3 spellings of Up/Down all move the cursor.
        if (matchesKey(data, 'down')) {
          this.moveSelection(view, 1)
          return
        }
        if (matchesKey(data, 'up')) {
          this.moveSelection(view, -1)
          return
        }
        // Everything else is consumed by the sheet: a stray key must never
        // reach the background composer.
        return
      }
      case 'edit': {
        if (this.chords.matches('save', data)) {
          this.controller.save()
          return
        }
        if (this.chords.matches('cancel', data)) {
          this.controller.cancelBack()
          return
        }
        const editor = this.ensureEditor(view)
        // Enter inserts a newline in the edit page (the official composer's
        // submit gesture belongs to the Composer, never to this local draft).
        if (data === '\r' || data === '\n') {
          editor.insertTextAtCursor('\n')
          return
        }
        editor.handleInput(data)
        return
      }
      case 'confirm-delete': {
        if (this.chords.matches('edit', data)) {
          this.controller.confirmDelete()
          return
        }
        if (this.chords.matches('cancel', data)) this.controller.cancelBack()
        return
      }
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // press → release → synthesized click: the release leaves the press
    // identity intact for the click to validate and activate.
    if (event.type === 'release') return undefined
    if (event.type !== 'press' && event.type !== 'click' && event.type !== 'wheel') return undefined
    if (event.button !== 'left' && event.type !== 'wheel') return undefined
    if (event.width !== this.lastRenderWidth) return undefined
    const hit = this.hits[event.y]
    if (hit === undefined || hit.kind === 'inert') return undefined
    if (hit.kind === 'picker') {
      // Translate into the picker's own content box; the picker's press/click
      // identity discipline (pressed value) is preserved verbatim.
      const translated = { ...event, y: event.y - hit.offsetY }
      const result = (this.picker as Component & { handleMouse?: (event: TuiMouseEvent) => TuiMouseEventResult | undefined })
        .handleMouse?.(translated)
      return result === undefined ? undefined : { handled: true }
    }
    if (event.type === 'wheel') return undefined
    const segment = hit.ranges.find(range => event.x >= range.start && event.x < range.end)
    if (segment === undefined) return undefined
    if (event.type === 'press') {
      this.pressed = { hit, width: event.width, actionId: segment.id }
      return { handled: true }
    }
    const pressed = this.pressed
    this.pressed = undefined
    if (pressed === undefined || pressed.width !== event.width) return undefined
    if (pressed.hit.kind !== 'action' || pressed.actionId !== segment.id) return undefined
    this.activate(segment.id)
    return { handled: true }
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    this.lastRenderWidth = safeWidth
    this.hits = []
    const view = this.controller.view()
    const lines: string[] = []
    const record = (line: string, hit: PanelHit): void => {
      lines.push(line)
      this.hits.push(hit)
    }
    switch (view.mode) {
      case 'closed':
        return []
      case 'browse':
        this.renderBrowse(safeWidth, view, record)
        return lines
      case 'edit':
        this.renderEdit(safeWidth, view, record)
        return lines
      case 'confirm-delete':
        this.renderConfirm(safeWidth, view, record)
        return lines
    }
  }

  private renderBrowse(width: number, view: QueueManagerView, record: (line: string, hit: PanelHit) => void): void {
    const budget = this.maxRows
    const noticeRows = view.notice === undefined ? 0 : 1
    // Body rows above the action bar. Spacers are the first degradation.
    const body = Math.max(0, budget - 1 - 1 - noticeRows)
    let blanks = body >= 6 ? 2 : 0
    const detailRows = view.selected !== undefined && !view.selected.textOnly ? 1 : 0
    let listRows = body - blanks - detailRows
    if (listRows < 1) {
      blanks = 0
      listRows = body - detailRows
    }
    this.syncPicker(view, Math.max(1, listRows))
    record(this.browseHeader(width, view), { kind: 'inert' })
    if (blanks > 0) record('', { kind: 'inert' })
    const pickerOffset = this.hits.length
    if (listRows >= 1) {
      for (const line of this.picker.render(width)) record(line, { kind: 'picker', offsetY: pickerOffset })
    }
    if (detailRows > 0) {
      record(color.textDim(truncateToWidth('  Contains attachments · Editing unavailable', width, '…')), { kind: 'inert' })
    }
    if (blanks > 0) record('', { kind: 'inert' })
    if (view.notice !== undefined) {
      record(noticeLine(view.notice, width), { kind: 'inert' })
    }
    this.pushBar(width, this.browseActions(view), record)
  }

  private renderEdit(width: number, view: QueueManagerView, record: (line: string, hit: PanelHit) => void): void {
    const noticeRows = view.notice === undefined ? 0 : 1
    const body = Math.max(1, this.maxRows - 1 - 1 - noticeRows)
    const blanks = body >= 4 ? 2 : 0
    const editorRows = Math.max(1, body - blanks)
    record(editHeader(width, view), { kind: 'inert' })
    if (blanks > 0) record('', { kind: 'inert' })
    const editor = this.ensureEditor(view)
    const safeDraft = sanitizeDisplayText(view.draft ?? '')
    if (editor.getText() !== safeDraft) editor.setText(safeDraft)
    const rendered = editor.render(width)
    // The fork editor paints its own top/bottom border; the overlay Frame is
    // the ONE frame, so only its content rows are painted. A short grant clips
    // the visible window from the BOTTOM (the caret is kept by the editor's own
    // scroll window).
    const content = rendered.slice(1, -1)
    const visible = content.length > editorRows ? content.slice(content.length - editorRows) : content
    for (const line of visible) record(truncateToWidth(line, width, '…'), { kind: 'inert' })
    if (blanks > 0) record('', { kind: 'inert' })
    if (view.notice !== undefined) record(noticeLine(view.notice, width), { kind: 'inert' })
    this.pushBar(width, [
      { id: 'save', text: `${QUEUE_CHORDS.save.label} save`, priority: 30 },
      { id: 'cancel', text: `${QUEUE_CHORDS.cancel.label} cancel`, priority: 100 },
    ], record)
  }

  private renderConfirm(width: number, view: QueueManagerView, record: (line: string, hit: PanelHit) => void): void {
    const noticeRows = view.notice === undefined ? 0 : 1
    const budget = Math.max(1, this.maxRows - 2 - noticeRows)
    record(confirmHeader(view), { kind: 'inert' })
    const row = view.selected
    let remaining = budget
    const spacer = remaining >= 4
    if (spacer) {
      record('', { kind: 'inert' })
      remaining -= 1
    }
    // Priority: the irreversibility warning always survives; the selected
    // message text yields first, the attachment line second.
    const warning = color.warning(truncateToWidth('This queued message cannot be restored after deletion.', width, '…'))
    let textRows = remaining >= 3 ? 2 : remaining >= 2 ? 1 : 0
    const attachmentRow = row !== undefined && row.attachments.length > 0 && remaining - textRows >= 1
    if (attachmentRow) textRows = Math.max(0, Math.min(textRows, remaining - 1))
    // Reserve one row for the warning.
    textRows = Math.min(textRows, Math.max(0, remaining - 1))
    if (row !== undefined && textRows > 0) {
      for (const line of wrapLines(row.text, width, textRows)) record(line, { kind: 'inert' })
    }
    if (attachmentRow && row !== undefined) {
      record(color.textDim(truncateToWidth(`  ${singleLine(row.attachments.join(' · '))}`, width, '…')), { kind: 'inert' })
    }
    if (spacer) record('', { kind: 'inert' })
    record(warning, { kind: 'inert' })
    if (view.notice !== undefined) record(noticeLine(view.notice, width), { kind: 'inert' })
    this.pushBar(width, [
      { id: 'confirm', text: `${QUEUE_CHORDS.edit.label} confirm`, priority: 30 },
      { id: 'cancel', text: `${QUEUE_CHORDS.cancel.label} cancel`, priority: 100 },
    ], record)
  }

  private pushBar(width: number, segments: BarSegment[], record: (line: string, hit: PanelHit) => void): void {
    const layout = layoutBar(segments, width)
    // ONE row carries every surviving segment; a press/click is resolved to the
    // exact segment cell range, never to the whole row.
    const lineIndex = this.hits.length
    record(layout.text, { kind: 'inert' })
    this.hits[lineIndex] = { kind: 'action', ranges: layout.ranges }
  }

  private browseHeader(width: number, view: QueueManagerView): string {
    return headerRow('Queue', width, `${view.count} queued`)
  }

  private browseActions(view: QueueManagerView): BarSegment[] {
    const actions: BarSegment[] = []
    if (view.selected !== undefined && view.selected.textOnly) {
      actions.push({ id: 'edit', text: `Edit [${QUEUE_CHORDS.edit.label}]`, priority: 20 })
    }
    actions.push({ id: 'delete', text: `Delete [${QUEUE_CHORDS.remove.label}]`, priority: 30 })
    // Navigation is a painted FACT, not an action: it carries its own inert
    // identity so a click can never close the panel through the Esc segment.
    actions.push({ id: 'navigate', text: '↑↓ navigate', priority: 10 })
    actions.push({ id: 'cancel', text: `${QUEUE_CHORDS.cancel.label} close`, priority: 100 })
    return actions
  }

  private moveSelection(view: QueueManagerView, delta: number): void {
    if (view.rows.length === 0) return
    const current = view.rows.findIndex(row => row.id === view.selectedId)
    const index = Math.min(Math.max(0, (current === -1 ? 0 : current) + delta), view.rows.length - 1)
    this.controller.select(view.rows[index]!.id)
  }

  private activate(id: ActionId): void {
    switch (id) {
      case 'edit':
        this.controller.startEdit()
        return
      case 'delete':
        this.controller.startDelete()
        return
      case 'save':
        this.controller.save()
        return
      case 'confirm':
        this.controller.confirmDelete()
        return
      case 'cancel':
        if (this.controller.view().mode === 'browse') this.controller.close()
        else this.controller.cancelBack()
        return
      case 'navigate':
        return
    }
  }

  /** Re-project the picker's rows from the controller view (value = Host id). */
  private syncPicker(view: QueueManagerView, rows: number): void {
    const items: SearchablePickerItem[] = view.rows.map(row => pickerItem(row))
    const signature = items.map(item => `${item.value}\u0000${item.label}\u0000${item.description ?? ''}`).join('\u0001')
    if (signature !== this.pickerSignature) {
      this.pickerSignature = signature
      this.picker.setItems(items)
    }
    this.picker.setMaxRows(Math.max(1, rows))
    if (view.selectedId === undefined) this.picker.clearSelection()
    else this.picker.setSelectedValue(view.selectedId)
  }

  private ensureEditor(view: QueueManagerView): Editor {
    if (this.editor === undefined) {
      // The editor is constructed ONCE for the panel's life. Render requests
      // are routed to the host's CURRENT active screen (the panel survives a
      // fullscreen swap), and the panel's own view supplies the text/cursor.
      const routed = Object.create(this.screen()) as TUI
      routed.requestRender = () => this.requestRender()
      const editor = new Editor(routed, editorTheme, { paddingX: 0 })
      editor.onChange = (text: string) => {
        // The editor shows a SANITIZED copy. While the user has not changed it,
        // the controller keeps the RAW Host text (so saving an untouched queued
        // message preserves its bytes); after a real edit the safe text is the
        // new data. A Host control sequence is never rendered.
        const raw = this.controller.view().draft ?? ''
        const safe = sanitizeDisplayText(text)
        this.controller.setDraft(safe === sanitizeDisplayText(raw) ? raw : safe)
      }
      const safe = sanitizeDisplayText(view.draft ?? '')
      editor.setText(safe)
      editor.focused = this.focusedFlag
      this.editor = editor
    }
    return this.editor
  }
}

/** One picker row: `value` IS the Host occurrence id. */
function pickerItem(row: QueueManagerRow): SearchablePickerItem {
  const badge = attachmentCountLabel(row.fileCount, row.imageCount)
  return {
    value: row.id,
    label: singleLine(row.text),
    ...(row.attachments.length === 0 ? {} : { description: singleLine(row.attachments.join(' · ')) }),
    ...(badge === undefined ? {} : { badge }),
  }
}

/** Role-1 title + right-aligned count on ONE row (the count yields first). */
function headerRow(title: string, width: number, count: string): string {
  const titleWidth = visibleWidth(title)
  const countWidth = visibleWidth(count)
  if (titleWidth + 1 + countWidth > width) {
    return color.textStrong(truncateToWidth(title, width, ''))
  }
  return color.textStrong(title) + ' '.repeat(Math.max(1, width - titleWidth - countWidth)) + color.textMuted(count)
}

function editHeader(width: number, view: QueueManagerView): string {
  const index = view.rows.findIndex(row => row.id === view.selectedId)
  const count = `${Math.max(1, index + 1)}/${Math.max(1, view.count)}`
  return headerRow('Edit queued message', width, count)
}

function confirmHeader(view: QueueManagerView): string {
  void view
  return color.textStrong('Delete queued message')
}

function noticeLine(notice: { readonly text: string; readonly kind: 'info' | 'error' }, width: number): string {
  const text = truncateToWidth(sanitizeDisplayText(notice.text), width, '…')
  return notice.kind === 'error'
    ? color.error(` ${text}`)
    : color.textDim(` ${text}`)
}

/** One line's display projection (never a control byte, never a newline). */
function singleLine(text: string): string {
  return sanitizeDisplayText(text).replace(/\s+/gu, ' ').trim()
}

/** Wrap `text` into at most `rows` single-line rows, ending with an ellipsis
 * when it does not all fit. */
function wrapLines(text: string, width: number, rows: number): string[] {
  const words = singleLine(text).split(' ').filter(word => word !== '')
  const out: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (visibleWidth(candidate) <= width) {
      current = candidate
      continue
    }
    if (current !== '') out.push(current)
    current = word
    if (out.length === rows) break
  }
  if (out.length < rows && current !== '') out.push(current)
  if (out.length === 0) out.push('')
  const visible = out.slice(0, rows)
  if (out.length > rows || words.join(' ').length > visible.join(' ').length) {
    visible[visible.length - 1] = truncateToWidth(`${visible[visible.length - 1]}…`, width, '…')
  }
  return visible
}
