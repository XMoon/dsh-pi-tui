/**
 * Delivered files browser (Delivered files PR1 / M5): the ONE presentation
 * owner of the delivered-files overlay. Files / Turns / Details are pages of a
 * single component behind a single `OverlayBroker` lease — switching a page
 * never mounts a second overlay, so Esc can never peel two layers.
 *
 * The panel owns presentation-local state only: the captured `snapshot` is the
 * whole data input (the application owner derived it once), `turn + raw path`
 * is the selection identity, and the filtered list is DERIVED on every render
 * (never a second stored list). Pointer hit-testing always reads the last
 * painted rows/columns, so a resize or a stale frame can never resolve a click
 * against geometry the user is not looking at.
 *
 * PR1 reads NO file content: the Details page shows the DECLARED Host path and
 * description only, and Copy copies that raw declared path string.
 * @module @xmoon76/dsh-pi-tui/tui/deliverables/delivered-files-panel
 */

import { Input, matchesKey, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { color } from '../theme/runtime.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'
import {
  deliveredFileBasename,
  deliveredFileLabels,
  filterDeliveredFiles,
  type DeliveredFilesSnapshot,
} from '../../domain/deliverables/catalog.ts'
import type { PresentedFilePresentation } from '../../domain/transcript/types.ts'

/** The pages of the ONE managed overlay. */
export type DeliveredFilesPage = 'files' | 'turns' | 'details'
/** Which local seat owns the keyboard on the Files page. */
export type DeliveredFilesSeat = 'list' | 'filter'

/** Where the browser opens: the turn/file the user actually acted on. */
export interface DeliveredFilesOpenIntent {
  readonly turn?: number
  readonly path?: string
  readonly page?: 'files' | 'details'
}

export interface DeliveredFilesPanelOptions {
  /** The catalog captured by the application owner at open time. */
  readonly snapshot: DeliveredFilesSnapshot
  readonly initial?: DeliveredFilesOpenIntent
  /** Ask the host for one frame (presentation-only state changed). */
  readonly requestRender: () => void
  /** Close the managed overlay (the Files-page Esc). */
  readonly close: () => void
  /**
   * Copy the RAW declared Host path. The host performs the real clipboard
   * attempt and calls `settle` EXACTLY once with its outcome; the panel only
   * renders that outcome (never a fabricated success).
   */
  readonly copyPath: (path: string, settle: (ok: boolean) => void) => void
}

/** The per-file `Details` verb needs a distinguishable filename beside it. */
const DETAILS_VERB = 'Details'
const ACTION_COLUMN_MIN_WIDTH = 44
/** The filter row is chrome: a short screen drops it (the `/` seat stays
 * reachable and paints the row while it owns the keyboard). */
const FILTER_ROW_MIN_ROWS = 14
/** Two columns only when the real drawable area can hold both. */
const TWO_COLUMN_MIN_WIDTH = 104
const TWO_COLUMN_MIN_ROWS = 18

/** The declared path of the current selection, or undefined. */
function fileOf(files: readonly PresentedFilePresentation[], path: string | undefined): PresentedFilePresentation | undefined {
  if (path === undefined) return undefined
  return files.find(file => file.path === path)
}

/** A deterministic width-preserving plain-text wrapper (paths have no spaces
 * and still must break instead of overflowing). */
function wrapPlainText(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width))
  const lines: string[] = []
  let current = ''
  let currentWidth = 0
  const flush = (): void => {
    lines.push(current)
    current = ''
    currentWidth = 0
  }
  for (const char of Array.from(text)) {
    if (char === '\n') {
      flush()
      continue
    }
    const charWidth = visibleWidth(char)
    if (currentWidth + charWidth > limit) {
      const space = current.lastIndexOf(' ')
      if (space > 0) {
        lines.push(current.slice(0, space))
        current = current.slice(space + 1)
        currentWidth = visibleWidth(current)
      } else {
        flush()
      }
    }
    if (currentWidth === 0 && char === ' ') continue
    current += char
    currentWidth += charWidth
  }
  if (current !== '' || lines.length === 0) lines.push(current)
  return lines
}

/** The keyboard hints of one page, most important last (Esc is always last). */
interface HintSegments {
  readonly select?: string
  readonly toggle?: string
  readonly filter?: string
  readonly turns?: string
  readonly enter: string
  readonly esc: string
}

export class DeliveredFilesPanel implements Component {
  private readonly snapshot: DeliveredFilesSnapshot
  private readonly requestRender: () => void
  private readonly close: () => void
  private readonly copyPath: (path: string, settle: (ok: boolean) => void) => void
  private readonly filterInput = new Input({ prompt: '' })
  private readonly labelsByTurn = new Map<number, readonly string[]>()

  private page: DeliveredFilesPage = 'files'
  private seat: DeliveredFilesSeat = 'list'
  private turnCursor: number
  /** The Turn the Files page was on before visiting the Turns page. */
  private restoreTurn: number
  private selectedPath: string | undefined
  private filter = ''
  private listTop = 0
  private detailsTop = 0
  private copyState: 'idle' | 'ok' | 'failed' = 'idle'
  private maxRows = 20
  private disposed = false

  /** The LAST painted frame: geometry + semantic hit targets. */
  private paintedWidth = 0
  private paintedRows = 0
  private paintedListRows: ReadonlyMap<number, number> = new Map()
  /** Painted `Details` verb cells: row → { index, startCol, endCol }. Only the
   *  painted columns open the page; the rest of the row only selects. */
  private paintedActionRows: ReadonlyMap<number, { readonly index: number; readonly startCol: number; readonly endCol: number }> = new Map()

  constructor(options: DeliveredFilesPanelOptions) {
    this.snapshot = options.snapshot
    this.requestRender = options.requestRender
    this.close = options.close
    this.copyPath = options.copyPath
    const first = this.snapshot.turns[0]
    if (first === undefined) throw new Error('the delivered-files panel requires at least one delivered turn')
    const intent = options.initial
    const turn = intent?.turn !== undefined && this.snapshot.turns.some(candidate => candidate.turn === intent.turn)
      ? intent.turn
      : first.turn
    this.turnCursor = turn
    this.restoreTurn = turn
    const files = this.filesOfTurn(turn)
    this.selectedPath = fileOf(files, intent?.path)?.path ?? files[0]?.path
    this.page = intent?.page === 'details' && this.selectedFile() !== undefined ? 'details' : 'files'
  }

  /** Adopt the granted content row budget (overlay maxHeight minus borders). */
  setMaxRows(rows: number): void {
    this.maxRows = Math.max(1, Math.floor(rows))
  }

  /** Test/diagnostic read: the page the panel currently presents. */
  currentPage(): DeliveredFilesPage {
    return this.page
  }

  /** Test/diagnostic read: the current selection identity (turn + raw path). */
  selection(): { readonly turn: number; readonly path: string | undefined } {
    return { turn: this.currentTurn(), path: this.selectedPath }
  }

  invalidate(): void {
    this.filterInput.invalidate()
  }

  dispose(): void {
    this.disposed = true
    this.paintedWidth = 0
    this.paintedRows = 0
    this.paintedListRows = new Map()
    this.paintedActionRows = new Map()
  }

  // ── data derivation (never stored as a second list) ──────────────────────

  private currentTurn(): number {
    return this.snapshot.turns.some(candidate => candidate.turn === this.turnCursor) ? this.turnCursor : this.snapshot.turns[0]!.turn
  }

  private filesOfTurn(turn: number): readonly PresentedFilePresentation[] {
    return this.snapshot.turns.find(candidate => candidate.turn === turn)?.files ?? []
  }

  private currentFiles(): readonly PresentedFilePresentation[] {
    return this.filesOfTurn(this.currentTurn())
  }

  /** The filtered list of the current Turn, in declaration order. */
  private filteredFiles(): readonly PresentedFilePresentation[] {
    return filterDeliveredFiles(this.currentFiles(), this.filter)
  }

  private labelOf(file: PresentedFilePresentation): string {
    const turn = this.currentTurn()
    let labels = this.labelsByTurn.get(turn)
    if (labels === undefined) {
      labels = deliveredFileLabels(this.currentFiles())
      this.labelsByTurn.set(turn, labels)
    }
    const index = this.currentFiles().indexOf(file)
    return labels[index] ?? deliveredFileBasename(file.path)
  }

  private selectedFile(): PresentedFilePresentation | undefined {
    return fileOf(this.currentFiles(), this.selectedPath)
  }

  /** The selected file's position in the CURRENT filtered list, else 0. */
  private selectedIndex(): number {
    const files = this.filteredFiles()
    if (files.length === 0) return -1
    const index = files.findIndex(file => file.path === this.selectedPath)
    return index === -1 ? 0 : index
  }

  /** Keep the raw-path selection inside the filtered result (first match). */
  private normalizeSelection(): void {
    const files = this.filteredFiles()
    if (files.length === 0) {
      this.selectedPath = undefined
      this.listTop = 0
      return
    }
    if (!files.some(file => file.path === this.selectedPath)) this.selectedPath = files[0]!.path
    this.listTop = Math.max(0, Math.min(this.listTop, Math.max(0, files.length - this.listRows())))
  }

  private moveSelection(delta: number): void {
    const files = this.filteredFiles()
    if (files.length === 0) return
    const index = Math.max(0, Math.min(files.length - 1, this.selectedIndex() + delta))
    this.selectedPath = files[index]!.path
    const rows = this.listRows()
    if (index < this.listTop) this.listTop = index
    if (index >= this.listTop + rows) this.listTop = index - rows + 1
    this.requestRender()
  }

  private pageSelection(delta: number): void {
    const files = this.filteredFiles()
    if (files.length === 0) return
    const rows = Math.max(1, this.listRows())
    const maxTop = Math.max(0, files.length - rows)
    this.listTop = Math.max(0, Math.min(maxTop, this.listTop + delta * rows))
    const index = Math.max(this.listTop, Math.min(files.length - 1, this.selectedIndex()))
    this.selectedPath = files[index]!.path
    this.requestRender()
  }

  // ── keyboard ────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return
    if (this.page === 'details') {
      this.handleDetailsInput(data)
      return
    }
    if (this.page === 'turns') {
      this.handleTurnsInput(data)
      return
    }
    this.handleFilesInput(data)
  }

  private handleFilesInput(data: string): void {
    if (this.seat === 'filter') {
      if (matchesKey(data, 'enter')) return this.commitFilter()
      if (matchesKey(data, 'escape')) return this.leaveFilter()
      const before = this.filterInput.getValue()
      this.filterInput.handleInput(data)
      const after = this.filterInput.getValue()
      if (after === before) return
      this.filter = after
      this.normalizeSelection()
      this.requestRender()
      return
    }
    if (matchesKey(data, 'up')) return this.moveSelection(-1)
    if (matchesKey(data, 'down')) return this.moveSelection(1)
    if (matchesKey(data, 'pageUp')) return this.pageSelection(-1)
    if (matchesKey(data, 'pageDown')) return this.pageSelection(1)
    if (matchesKey(data, 'enter')) {
      if (this.selectedFile() !== undefined) this.openDetails()
      return
    }
    if (matchesKey(data, '/') || data === '/') return this.enterFilter()
    if (matchesKey(data, 'shift+t')) return this.openTurns()
    if (matchesKey(data, 'escape')) {
      this.close()
      return
    }
  }

  private handleTurnsInput(data: string): void {
    if (matchesKey(data, 'up') || matchesKey(data, 'down')) {
      const turns = this.snapshot.turns
      const current = Math.max(0, turns.findIndex(candidate => candidate.turn === this.turnCursor))
      const next = Math.max(0, Math.min(turns.length - 1, current + (matchesKey(data, 'up') ? -1 : 1)))
      this.turnCursor = turns[next]!.turn
      this.requestRender()
      return
    }
    if (matchesKey(data, 'enter')) {
      this.openFilesForTurn(this.turnCursor)
      return
    }
    if (matchesKey(data, 'escape')) {
      // Back to the files of the Turn that was selected BEFORE the visit: the
      // cursor move on this page is not a commitment.
      this.page = 'files'
      this.seat = 'list'
      this.turnCursor = this.restoreTurn
      this.requestRender()
      return
    }
  }

  private handleDetailsInput(data: string): void {
    if (matchesKey(data, 'escape')) {
      this.page = 'files'
      this.seat = 'list'
      this.copyState = 'idle'
      this.requestRender()
      return
    }
    if (matchesKey(data, 'shift+c')) return this.copySelectedPath()
    const bodyRows = this.detailsBodyRows()
    const total = this.detailsBodyLines(this.paintedWidth === 0 ? 80 : this.paintedWidth).length
    if (matchesKey(data, 'up')) {
      this.detailsTop = Math.max(0, this.detailsTop - 1)
      this.requestRender()
      return
    }
    if (matchesKey(data, 'down')) {
      this.detailsTop = Math.min(Math.max(0, total - bodyRows), this.detailsTop + 1)
      this.requestRender()
      return
    }
    if (matchesKey(data, 'pageUp')) {
      this.detailsTop = Math.max(0, this.detailsTop - Math.max(1, bodyRows))
      this.requestRender()
      return
    }
    if (matchesKey(data, 'pageDown')) {
      this.detailsTop = Math.min(Math.max(0, total - bodyRows), this.detailsTop + Math.max(1, bodyRows))
      this.requestRender()
    }
  }

  private enterFilter(): void {
    this.seat = 'filter'
    this.filterInput.focused = true
    this.filterInput.setValue(this.filter)
    this.requestRender()
  }

  /** Enter confirms the current filter and returns to the list. */
  private commitFilter(): void {
    this.seat = 'list'
    this.filterInput.focused = false
    this.filter = this.filterInput.getValue()
    this.normalizeSelection()
    this.requestRender()
  }

  /** Esc clears a non-empty query and returns to the list in either case. */
  private leaveFilter(): void {
    this.seat = 'list'
    this.filterInput.focused = false
    const hadQuery = this.filterInput.getValue() !== ''
    this.filterInput.setValue('')
    this.filter = ''
    if (hadQuery) this.normalizeSelection()
    this.requestRender()
  }

  private openDetails(): void {
    if (this.selectedFile() === undefined) return
    this.page = 'details'
    this.seat = 'list'
    this.detailsTop = 0
    this.copyState = 'idle'
    this.requestRender()
  }

  private openTurns(): void {
    this.page = 'turns'
    this.seat = 'list'
    this.turnCursor = this.currentTurn()
    this.restoreTurn = this.currentTurn()
    this.requestRender()
  }

  private openFilesForTurn(turn: number): void {
    this.turnCursor = turn
    this.page = 'files'
    this.seat = 'list'
    this.filter = ''
    this.filterInput.setValue('')
    this.filterInput.focused = false
    this.listTop = 0
    const files = this.filesOfTurn(turn)
    this.selectedPath = files[0]?.path
    this.requestRender()
  }

  private copySelectedPath(): void {
    const file = this.selectedFile()
    if (file === undefined) return
    const turn = this.currentTurn()
    this.copyPath(file.path, (ok) => {
      if (this.disposed) return
      // The selection may have moved while the clipboard write was pending: a
      // settlement for another Turn/file must never paint "copied" over it.
      if (this.page !== 'details' || this.currentTurn() !== turn || this.selectedPath !== file.path) return
      this.copyState = ok ? 'ok' : 'failed'
      this.requestRender()
    })
  }

  // ── mouse ───────────────────────────────────────────────────────────────

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    if (event.type !== 'press' && event.type !== 'click') return undefined
    if (event.button !== 'left') return undefined
    // Only a frame painted at THIS width can be hit: a resize invalidates the
    // recorded rows before the next paint.
    if (Math.floor(event.width) !== this.paintedWidth || Math.floor(event.height) !== this.paintedRows) return undefined
    if (this.page !== 'files' || this.seat !== 'list') return undefined
    const action = this.paintedActionRows.get(event.y)
    if (action !== undefined && event.x >= action.startCol && event.x < action.endCol) {
      const file = this.filteredFiles()[action.index]
      if (file === undefined) return undefined
      this.selectedPath = file.path
      this.openDetails()
      return { handled: true, render: true }
    }
    const index = this.paintedListRows.get(event.y)
    if (index === undefined) return undefined
    const file = this.filteredFiles()[index]
    if (file === undefined) return undefined
    // A list click SELECTS; opening needs the explicit Details action.
    this.selectedPath = file.path
    this.requestRender()
    return { handled: true, render: true }
  }

  // ── layout ──────────────────────────────────────────────────────────────

  private filterRowShown(): boolean {
    return this.seat === 'filter' || this.maxRows >= FILTER_ROW_MIN_ROWS
  }

  private headerRows(): number {
    return 1
  }

  private listRows(): number {
    const chrome = this.headerRows() + (this.filterRowShown() ? 1 : 0) + 1
    return Math.max(1, this.maxRows - chrome)
  }

  private twoColumn(width: number): boolean {
    return Math.floor(width) >= TWO_COLUMN_MIN_WIDTH && this.maxRows >= TWO_COLUMN_MIN_ROWS
  }

  /** The granted rows of the Details scrolling body. */
  private detailsBodyRows(): number {
    return Math.max(1, this.maxRows - 2)
  }

  private detailsBodyLines(width: number): string[] {
    const file = this.selectedFile()
    if (file === undefined) return []
    const contentWidth = Math.max(8, Math.floor(width))
    const lines: string[] = []
    lines.push(`${color.textDim('Host: ')}${sanitizeDisplayText(file.path)}`)
    if (file.description !== undefined && file.description !== '') {
      const wrapped = wrapPlainText(sanitizeDisplayText(file.description), Math.max(4, contentWidth - 'Description: '.length))
      wrapped.forEach((line, index) => {
        lines.push(`${index === 0 ? color.textDim('Description: ') : ' '.repeat('Description: '.length)}${line}`)
      })
    }
    lines.push('')
    return lines
  }

  // ── rendering ───────────────────────────────────────────────────────────

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const rows: string[] = []
    const actionRows = new Map<number, { index: number; startCol: number; endCol: number }>()
    const listRows = new Map<number, number>()

    if (this.page === 'details') {
      const file = this.selectedFile()
      const title = file === undefined ? 'Details' : `${sanitizeDisplayText(deliveredFileBasename(file.path))} · Details`
      rows.push(truncateToWidth(color.textDim(title), safeWidth, '…'))
      const bodyRows = Math.max(1, this.maxRows - 2)
      const body = this.detailsBodyLines(safeWidth)
      const top = Math.min(this.detailsTop, Math.max(0, body.length - bodyRows))
      const windowed = body.slice(top, top + bodyRows)
      while (windowed.length < bodyRows) windowed.push('')
      rows.push(...windowed.map(line => truncateToWidth(line, safeWidth, '…')))
      rows.push(this.actionBar(safeWidth, this.copyState === 'ok'
        ? 'Path copied'
        : this.copyState === 'failed' ? 'Could not copy path' : undefined))
      this.paint(safeWidth, rows, listRows, actionRows)
      return rows
    }

    if (this.page === 'turns') {
      rows.push(truncateToWidth(color.textDim(`Delivered files · ${this.snapshot.turns.length} Turns`), safeWidth, '…'))
      if (this.filterRowShown()) rows.push('')
      const area = Math.max(1, this.maxRows - rows.length - 1)
      const turns = this.snapshot.turns
      const current = Math.max(0, turns.findIndex(candidate => candidate.turn === this.turnCursor))
      const top = Math.max(0, Math.min(current, turns.length - area))
      const visible = turns.slice(top, top + area)
      for (const entry of visible) {
        const selected = entry.turn === this.turnCursor
        const label = `Turn ${entry.turn} · ${entry.files.length} ${entry.files.length === 1 ? 'file' : 'files'}`
        rows.push(truncateToWidth(`${selected ? color.primary('>') : ' '} ${label}`, safeWidth, '…'))
      }
      while (rows.length < this.maxRows - 1) rows.push('')
      rows.push(this.actionBar(safeWidth))
      this.paint(safeWidth, rows, listRows, actionRows)
      return rows
    }

    // ── Files ──
    const twoColumn = this.twoColumn(safeWidth)
    const files = this.currentFiles()
    const filtered = this.filteredFiles()
    const count = filtered.length === files.length
      ? `${files.length} ${files.length === 1 ? 'file' : 'files'}`
      : `${filtered.length}/${files.length} files`
    const wideHeader = safeWidth >= 46
    rows.push(truncateToWidth(
      color.textDim(wideHeader
        ? `Delivered files · Turn ${this.currentTurn()} · ${count}`
        : `Delivered files · Turn ${this.currentTurn()}`),
      safeWidth,
      '…',
    ))
    if (this.filterRowShown()) rows.push(this.filterRow(safeWidth))

    const area = Math.max(1, this.maxRows - rows.length - 1)
    const listWidth = twoColumn ? Math.max(24, Math.floor((safeWidth - 3) * 0.58)) : safeWidth
    const sideWidth = twoColumn ? Math.max(8, safeWidth - listWidth - 3) : 0
    const listTop = Math.max(0, Math.min(this.listTop, Math.max(0, filtered.length - area)))
    this.listTop = listTop
    const visible = filtered.slice(listTop, listTop + area)
    const selectedIndex = this.selectedIndex()
    const actions = safeWidth >= ACTION_COLUMN_MIN_WIDTH
    const actionColumn = visibleWidth(DETAILS_VERB) + 2

    for (const [offset, file] of visible.entries()) {
      const index = listTop + offset
      const selected = index === selectedIndex
      const marker = selected ? color.primary('>') : ' '
      const label = sanitizeDisplayText(this.labelOf(file))
      const bodyWidth = Math.max(1, listWidth - (actions ? actionColumn : 0))
      const labelText = truncateToWidth(label, Math.max(1, bodyWidth - 2), '…')
      const gap = actions ? Math.max(1, bodyWidth - 2 - visibleWidth(labelText)) : 0
      const painted = actions
        ? `${marker} ${color.textDim(labelText)}${' '.repeat(gap)}${color.primary(DETAILS_VERB)}`
        : `${marker} ${color.textDim(labelText)}`
      rows.push(truncateToWidth(painted, listWidth, '…'))
      listRows.set(rows.length - 1, index)
      if (actions) {
        const startCol = listWidth - visibleWidth(DETAILS_VERB)
        if (visibleWidth(painted) >= startCol) {
          actionRows.set(rows.length - 1, { index, startCol, endCol: listWidth })
        }
      }
    }
    // Fill the list window so the two-column side pane and the action bar keep
    // their real positions on a short result set.
    while (rows.length < this.maxRows - 1) rows.push('')

    if (twoColumn) {
      const side = this.sidePane(sideWidth, area)
      for (let index = 0; index < area; index += 1) {
        const rowIndex = this.headerRows() + (this.filterRowShown() ? 1 : 0) + index
        const left = rows[rowIndex] ?? ''
        const right = side[index] ?? ''
        rows[rowIndex] = `${padTo(left, listWidth)}   ${truncateToWidth(right, sideWidth, '…')}`
      }
    }
    rows.push(this.actionBar(safeWidth))
    this.paint(safeWidth, rows, listRows, actionRows)
    return rows
  }

  /** The wide Files right pane: the selected file's DECLARED metadata only. */
  private sidePane(width: number, rows: number): string[] {
    const file = this.selectedFile()
    const lines: string[] = []
    if (file === undefined) return lines
    lines.push(...wrapPlainText(sanitizeDisplayText(this.labelOf(file)), width))
    const fullPath = wrapPlainText(sanitizeDisplayText(file.path), width)
    lines.push(...fullPath.map(line => color.textDim(line)))
    if (file.description !== undefined && file.description !== '') {
      lines.push(...wrapPlainText(sanitizeDisplayText(file.description), width).map(line => color.textDim(line)))
    } else {
      lines.push(...wrapPlainText('No description', width).map(line => color.textDim(line)))
    }
    lines.push('')
    lines.push(color.primary('Enter for Details'))
    lines.push(color.textDim('No Host read in PR1'))
    return lines.slice(0, rows)
  }

  private filterRow(width: number): string {
    const prefix = color.textDim('Filter: ')
    const prefixWidth = visibleWidth('Filter: ')
    const query = this.filterInput.render(Math.max(1, width - prefixWidth))
    return truncateToWidth(`${prefix}${query[0] ?? ''}`, width, '…')
  }

  /** The action bar: page hints in the design-language order, Esc last, with
   *  the low-priority hints dropped first on a narrow screen. */
  private actionBar(width: number, notice?: string): string {
    if (notice !== undefined) {
      const painted = notice === 'Path copied' ? color.success(notice) : color.error(notice)
      return truncateToWidth(painted, width, '…')
    }
    const hints = this.hints()
    const segments: string[] = []
    if (hints.select !== undefined) segments.push(hints.select)
    segments.push(hints.enter)
    if (hints.filter !== undefined) segments.push(hints.filter)
    if (hints.turns !== undefined) segments.push(hints.turns)
    segments.push(hints.esc)
    const render = (): string => segments.map(segment => color.textDim(segment)).join(color.textDim(' · '))
    // Degrade least-informative first, keeping the action and Esc readable.
    const dropOrder = [hints.turns, hints.filter, hints.select]
    for (const candidate of dropOrder) {
      if (candidate === undefined) continue
      const index = segments.indexOf(candidate)
      if (index === -1) continue
      if (visibleWidth(render()) <= width) break
      segments.splice(index, 1)
    }
    return truncateToWidth(render(), width, '…')
  }

  private hints(): HintSegments {
    if (this.page === 'details') return { enter: 'C Copy path', esc: 'Esc Back' }
    if (this.page === 'turns') return { select: '↑↓ Select', enter: 'Enter Open', esc: 'Esc Back' }
    if (this.seat === 'filter') {
      return {
        enter: 'Enter Apply',
        esc: this.filter === '' ? 'Esc Back' : 'Esc Clear',
      }
    }
    return {
      select: '↑↓ Select',
      enter: 'Enter Details',
      filter: '/ Filter',
      turns: 'T Turns',
      esc: 'Esc Close',
    }
  }

  private paint(
    width: number,
    rows: readonly string[],
    listRows: ReadonlyMap<number, number>,
    actionRows: ReadonlyMap<number, { readonly index: number; readonly startCol: number; readonly endCol: number }>,
  ): void {
    this.paintedWidth = width
    this.paintedRows = rows.length
    this.paintedListRows = listRows
    this.paintedActionRows = actionRows
  }
}

function padTo(text: string, width: number): string {
  const visible = visibleWidth(text)
  if (visible >= width) return truncateToWidth(text, width, '…')
  return `${text}${' '.repeat(width - visible)}`
}
