/**
 * Delivered files browser (Delivered files PR1 M5 + PR2 preview): the ONE presentation
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
 * The Details page also owns the ONE read-only PREVIEW (Delivered files PR2):
 * the declared Host path/description plus a bounded page of the file's text,
 * read through {@link DeliveredFilePreviewCapability}. The preview holds AT MOST
 * one page, starts with a real `stat`, refuses known binary suffixes without a
 * read, and never paints a reply whose request identity is no longer its own.
 * Copy always sends the RAW declared path.
 * @module @xmoon76/dsh-pi-tui/tui/deliverables/delivered-files-panel
 */

import { Input, matchesKey, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { color } from '../theme/runtime.ts'
import { sanitizeDisplaySegment, sanitizeDisplayText } from '../presentation/terminal-text.ts'
import { DELIVERED_FILES_CHORDS } from '../keybindings/hints.ts'
import { fitDeliveredLabels } from '../presentation/labels.ts'
import {
  deliveredFileBasename,
  deliveredFileLabels,
  filterDeliveredFiles,
  type DeliveredFilesSnapshot,
} from '../../domain/deliverables/catalog.ts'
import type { PresentedFilePresentation } from '../../domain/transcript/types.ts'
import { DELIVERED_FILE_PAGE_LINES, DeliveredFileReadError, type DeliveredFilePage, type DeliveredFilePreviewCapability, type DeliveredFileReadFailureCode, type DeliveredFileStat } from '../../runtime/deliverables-port.ts'
import { SupersededReadError } from '../../runtime/read-error.ts'
import { isCancellation } from '../../runtime/process/tasks.ts'

/** The pages of the ONE managed overlay. */
export type DeliveredFilesPage = 'files' | 'turns' | 'details'
/** Which local seat owns the keyboard on the Files page. */
export type DeliveredFilesSeat = 'list' | 'filter'

/** The pointer actions the ONE action bar can paint. Keyboard equivalents
 *  (`/`, `T`/Shift+C, Esc) stay unchanged; a button is only a pointer shape of
 *  the same existing operation. */
type FooterAction = 'filter' | 'turns' | 'close' | 'back' | 'copy-path'

/** One painted action-bar cell range in panel coordinates. */
interface PaintedFooterHit {
  readonly action: FooterAction
  readonly startCol: number
  readonly endCol: number
}

/** One action-bar segment. `rank` is the whole-segment drop order: the highest
 *  rank is removed first, and rank 0 is the terminal action that is never
 *  dropped (only clipped, with its hit withdrawn). */
interface FooterSegment {
  readonly text: string
  readonly tone: 'hint' | 'button' | 'notice'
  readonly rank: number
  readonly action?: FooterAction
}

/** The semantic target under one painted cell. The identity string is the
 *  press-time fence: a click may only run the EXACT target the press named,
 *  even if a keyboard action repainted the row underneath the held pointer. */
interface PointerTarget {
  readonly kind: 'footer' | 'turn' | 'details' | 'list'
  readonly identity: string
  readonly action?: FooterAction
  readonly turn?: number
  readonly path?: string
}

/** One held pointer cell recorded at press time. */
interface PressedPointerCell {
  readonly page: DeliveredFilesPage
  readonly seat: DeliveredFilesSeat
  readonly x: number
  readonly y: number
  readonly identity: string
}

/** Where the browser opens: the turn/file the user actually acted on. */
export interface DeliveredFilesOpenIntent {
  readonly turn?: number
  readonly path?: string
  readonly page?: 'files' | 'details'
}

/** One preview load state (Delivered files PR2 §7.7). */
export type DeliveredFilesPreviewState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading-stat' }
  | { readonly kind: 'metadata'; readonly stat: DeliveredFileStat; readonly reason: 'unsupported-type' }
  | { readonly kind: 'loading-page'; readonly stat: DeliveredFileStat; readonly offset: number }
  | { readonly kind: 'text-page'; readonly page: DeliveredFilePage; readonly nextOffset: number }
  | { readonly kind: 'failure'; readonly code: DeliveredFileReadFailureCode | undefined; readonly stat?: DeliveredFileStat }

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
  /**
   * Delivered files PR2: the Host read capability for the Details preview,
   * bound to this snapshot's subject. Absent means this mount has no Host read
   * at all — the preview then paints the definite unavailable state.
   */
  readonly preview?: DeliveredFilePreviewCapability
  /**
   * Report an UNCLASSIFIED preview failure to the host diagnostics (the panel
   * still paints the generic `Unable to preview file`). Optional.
   */
  readonly reportUnclassifiedFailure?: (message: string, error: unknown) => void
  /**
   * Whether this surface really routes pointer events to the panel. PiTui
   * enables terminal mouse reporting ONLY on the fullscreen alt screen, so a
   * per-row `Details` verb painted on the regular surface would be a dead
   * affordance — the panel paints (and hit-tests) it only when this is true.
   * Keyboard selection + `Enter Preview` stays available either way.
   *
   * A FUNCTION is re-evaluated on every paint and on every hit test: ONE panel
   * survives a fullscreen screen swap (the overlay remounts the same instance),
   * so a value captured at construction would keep claiming a pointer the new
   * surface does not route.
   */
  readonly pointerActions?: boolean | (() => boolean)
  /**
   * The owned-task runner the host wires (`runOwned`). Every preview request is
   * an owned async workflow — never a bare `void promise` — so its failure is
   * reported through the host's diagnostics instead of escaping.
   */
  readonly runOwned?: (label: string, task: () => Promise<void>) => void
}

/** The per-file `Details` verb needs a distinguishable filename beside it. */
const DETAILS_VERB = 'Details'
/** One preview page: the plan's fixed 120-line window. */
/** Declared files with these suffixes are never read: metadata only. */
const PREVIEW_BINARY_SUFFIXES = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.pdf', '.zip', '.gz', '.tar', '.7z',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
] as const

/** The FIXED user-facing text of one preview refusal (never re-invented). */
function previewFailureText(code: DeliveredFileReadFailureCode | undefined): string {
  switch (code) {
    case 'not-found': return 'File no longer exists on Host'
    case 'not-text': return 'Not a UTF-8 text file'
    case 'not-regular-file': return 'File is no longer a regular file'
    case 'too-large': return 'Text page exceeds Host read limit'
    case 'session-unavailable': return 'Session file scope is unavailable'
    case 'service-unavailable': return 'Host file preview is unavailable'
    default: return 'Unable to preview file'
  }
}

/** Whether a declared path names a known binary/opaque type (no read). */
function isPreviewBinary(path: string): boolean {
  const lower = deliveredFileBasename(path).toLowerCase()
  return PREVIEW_BINARY_SUFFIXES.some(suffix => lower.endsWith(suffix))
}
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

/**
 * Break one PROJECTED PATH into cells, preserving EVERY character.
 *
 * {@link wrapPlainText} serves prose and drops the space at a wrap boundary;
 * a declared path is IDENTITY, so its safe projection must re-assemble exactly.
 * The break therefore happens between characters and nothing is removed.
 */
function wrapPreservingText(text: string, width: number): string[] {
  const limit = Math.max(1, Math.floor(width))
  const lines: string[] = []
  // A declared path is a raw string: the safe projection KEEPS a line feed, and
  // a returned `string[]` element is ONE physical row. Every LF is therefore a
  // row boundary of its own — never a byte inside an element.
  for (const segment of text.split('\n')) {
    let current = ''
    let currentWidth = 0
    for (const char of Array.from(segment)) {
      const charWidth = visibleWidth(char)
      if (currentWidth > 0 && currentWidth + charWidth > limit) {
        lines.push(current)
        current = ''
        currentWidth = 0
      }
      current += char
      currentWidth += charWidth
    }
    lines.push(current)
  }
  return lines
}

export class DeliveredFilesPanel implements Component {
  private readonly snapshot: DeliveredFilesSnapshot
  private readonly requestRender: () => void
  private readonly close: () => void
  private readonly copyPath: (path: string, settle: (ok: boolean) => void) => void
  private readonly previewCapability: DeliveredFilePreviewCapability | undefined
  private readonly reportUnclassifiedFailure: ((message: string, error: unknown) => void) | undefined
  private readonly pointerActionsSource: boolean | (() => boolean)
  private readonly runOwned: ((label: string, task: () => Promise<void>) => void) | undefined

  /** The LIVE pointer ownership of the surface this panel is mounted on. */
  private pointerOwned(): boolean {
    const source = this.pointerActionsSource
    return typeof source === 'function' ? source() : source
  }
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
  /** The copy request token: only the LATEST request may paint feedback. */
  private copySerial = 0
  /** The ONE preview state of this panel (at most one page is ever held). */
  private preview: DeliveredFilesPreviewState = { kind: 'idle' }
  /** The request identity: only the LATEST load may paint. */
  private previewSerial = 0
  private previewAbort: AbortController | undefined
  /** One-line restart/EOF notice above the preview body. */
  private previewNotice = ''
  /** The metadata already obtained for the current subject (failure context). */
  private previewStat: DeliveredFileStat | undefined
  /** One-shot: the next paint scrolls the body to the preview content. */
  private previewScrollToContent = false
  private maxRows = 20
  private disposed = false

  /** The LAST painted frame: geometry + semantic hit targets. */
  private paintedWidth = 0
  private paintedRows = 0
  private paintedListRows: ReadonlyMap<number, string> = new Map()
  /** The list identity this hit map was painted for: any state change that can
   *  reorder the list (a committed filter, a Turn switch) invalidates it BEFORE
   *  the next frame, so a click can never resolve against a list the user is no
   *  longer looking at. */
  private paintedListIdentity = ''
  /** Painted `Details` verb cells: row → { path, startCol, endCol }. Only the
   *  painted columns open the page; the rest of the row only selects. */
  private paintedActionRows: ReadonlyMap<number, { readonly path: string; readonly startCol: number; readonly endCol: number }> = new Map()
  /** The page/seat the recorded hit maps belong to. A page or seat change
   *  retires every recorded cell BEFORE the next frame. */
  private paintedPage: DeliveredFilesPage | undefined
  private paintedSeat: DeliveredFilesSeat | undefined
  /** The action-bar row and its painted button cells. */
  private paintedFooterRow = -1
  private paintedFooterHits: ReadonlyArray<PaintedFooterHit> = []
  /** Painted Turns-page rows: row → Turn. Only a complete click opens one. */
  private paintedTurnRows: ReadonlyMap<number, number> = new Map()
  /** The cell held by the current mouse press, if any. A synthesized click
   *  must resolve the SAME page/seat/target identity it recorded here; a
   *  keyboard repaint between press and release can never retarget the click. */
  private pressedCell: PressedPointerCell | undefined

  constructor(options: DeliveredFilesPanelOptions) {
    this.snapshot = options.snapshot
    this.requestRender = options.requestRender
    this.close = options.close
    this.copyPath = options.copyPath
    this.previewCapability = options.preview
    this.reportUnclassifiedFailure = options.reportUnclassifiedFailure
    this.pointerActionsSource = options.pointerActions ?? false
    this.runOwned = options.runOwned
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
    if (this.page === 'details') {
      const file = this.selectedFile()
      if (file !== undefined) this.startPreview(file.path)
    }
  }

  /** Adopt the granted content row budget (overlay maxHeight minus borders).
   *  A changed grant reflows every row, so the last-painted hit maps are dead
   *  until the next frame. */
  setMaxRows(rows: number): void {
    const next = Math.max(1, Math.floor(rows))
    if (next === this.maxRows) return
    this.maxRows = next
    this.invalidatePaintedHits()
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
    this.cancelPreview()
    this.invalidatePaintedHits()
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

  /** The current Turn's projected labels, cached per Turn. */
  private projectedLabels(): readonly string[] {
    const turn = this.currentTurn()
    let labels = this.labelsByTurn.get(turn)
    if (labels === undefined) {
      labels = deliveredFileLabels(this.currentFiles(), { project: sanitizeDisplaySegment })
      this.labelsByTurn.set(turn, labels)
    }
    return labels
  }

  private labelOf(file: PresentedFilePresentation): string {
    const index = this.currentFiles().indexOf(file)
    return this.projectedLabels()[index] ?? deliveredFileBasename(file.path)
  }

  /**
   * The delivery's labels fitted ONCE for this panel width, keyed by raw path.
   *
   * The room is the NARROWEST consumer (the two-column list cell, capped again
   * by the Details title's room), so the list rows, the wide side pane and the
   * Details title all paint the SAME text for the same file and no clamp can
   * collapse two rows.
   */
  private fittedLabelsFor(width: number): ReadonlyMap<string, string> {
    const files = this.currentFiles()
    const actions = this.pointerOwned() && width >= ACTION_COLUMN_MIN_WIDTH
    const listWidth = this.twoColumn(width) ? Math.max(24, Math.floor((width - 3) * 0.58)) : width
    const listRoom = Math.max(1, listWidth - (actions ? visibleWidth(DETAILS_VERB) + 2 : 0) - 2)
    const titleRoom = Math.max(8, width - ' · Details'.length)
    const fitted = fitDeliveredLabels(this.projectedLabels(), Math.min(listRoom, titleRoom))
    return new Map(files.map((file, index) => [file.path, fitted[index]!]))
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
    // The selection must stay VISIBLE: filtering can move it far above the
    // current viewport (a retained file after the rows before it were filtered
    // out), so the top is re-derived from the selected index in BOTH
    // directions instead of only clamped to a legal scroll range.
    this.revealSelection(files, Math.max(0, files.findIndex(file => file.path === this.selectedPath)))
  }

  /** Scroll the minimal distance that puts one index inside the viewport. */
  private revealSelection(files: readonly { readonly path: string }[], index: number): void {
    const rows = Math.max(1, this.listRows())
    const maxTop = Math.max(0, files.length - rows)
    let top = Math.max(0, Math.min(this.listTop, maxTop))
    if (index < top) top = index
    else if (index >= top + rows) top = index - rows + 1
    this.listTop = Math.max(0, Math.min(top, maxTop))
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
    const top = Math.max(0, Math.min(maxTop, this.listTop + delta * rows))
    // A page gesture owns BOTH the viewport and the cursor: the selection moves
    // with the page and lands inside it. Moving only the top would be undone by
    // the next paint's reveal (which must keep the selection visible), leaving
    // PageUp stuck on the same page forever.
    const last = Math.min(files.length - 1, top + rows - 1)
    const index = Math.max(top, Math.min(last, this.selectedIndex() + delta * rows))
    this.listTop = top
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
      this.invalidatePaintedHits()
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
    if (DELIVERED_FILES_CHORDS.turns.keys.some(key => matchesKey(data, key))) return this.openTurns()
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
    if (matchesKey(data, 'escape')) return this.backFromTurns()
  }

  private handleDetailsInput(data: string): void {
    if (matchesKey(data, 'escape')) return this.backFromDetails()
    if (DELIVERED_FILES_CHORDS.copyPath.keys.some(key => matchesKey(data, key))) return this.copySelectedPath()
    const bodyRows = this.detailsBodyRows()
    // The scroll clamp needs "is there another row?", not the whole page: one row
    // past the viewport is enough, so a 2 MiB line is never wrapped in full here.
    const scrollWidth = this.paintedWidth === 0 ? 80 : this.paintedWidth
    const scrollLayout = this.detailsLayout(scrollWidth, this.detailsTop + bodyRows + 1)
    const total = scrollLayout.lines.length
    void scrollLayout
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
      if (this.detailsTop > 0) {
        this.detailsTop = Math.max(0, this.detailsTop - Math.max(1, bodyRows))
        this.requestRender()
        return
      }
      // At the top of the page: the previous 120-line window, when one exists.
      const page = this.preview.kind === 'text-page' ? this.preview.page : undefined
      if (page !== undefined && page.offset > 1) this.requestPreviewPage(Math.max(1, page.offset - DELIVERED_FILE_PAGE_LINES))
      return
    }
    if (matchesKey(data, 'pageDown')) {
      if (this.detailsTop + bodyRows < total) {
        this.detailsTop = Math.min(Math.max(0, total - bodyRows), this.detailsTop + Math.max(1, bodyRows))
        this.requestRender()
        return
      }
      // At the bottom of the page: the next 120-line window, never past EOF.
      const page = this.preview.kind === 'text-page' ? this.preview.page : undefined
      if (page !== undefined && !page.eof) this.requestPreviewPage(page.offset + DELIVERED_FILE_PAGE_LINES)
    }
  }

  /** The ONE Back transition from Turns (`[Back]` and Esc share it): the cursor
   *  move on that page is not a commitment, so the ORIGINAL Files Turn returns. */
  private backFromTurns(): void {
    if (this.page !== 'turns') return
    this.page = 'files'
    this.seat = 'list'
    this.turnCursor = this.restoreTurn
    this.requestRender()
  }

  /** The ONE Back transition from Details (`[Back]` and Esc share it). */
  private backFromDetails(): void {
    if (this.page !== 'details') return
    this.cancelPreview()
    this.page = 'files'
    this.seat = 'list'
    this.copyState = 'idle'
    this.requestRender()
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
    // The committed filter changes membership/order: the currently painted hit
    // cells describe the OLD list, so they are dropped until the next frame.
    this.invalidatePaintedHits()
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
    if (hadQuery) this.invalidatePaintedHits()
    this.requestRender()
  }

  private openDetails(): void {
    const file = this.selectedFile()
    if (file === undefined) return
    this.page = 'details'
    this.seat = 'list'
    this.detailsTop = 0
    this.copyState = 'idle'
    // A pending clipboard settlement from an EARLIER visit is stale now: this
    // page is a new read of the file, not the old page's outcome.
    this.copySerial += 1
    // Entering Preview: a REAL stat first. The request identity is
    // (turn, raw path, panel epoch, serial) — the serial is the epoch.
    this.startPreview(file.path)
    this.requestRender()
  }

  private openTurns(): void {
    this.cancelPreview()
    this.page = 'turns'
    this.seat = 'list'
    this.turnCursor = this.currentTurn()
    this.restoreTurn = this.currentTurn()
    this.requestRender()
  }

  private openFilesForTurn(turn: number): void {
    // A Turn switch replaces the whole list AND its preview: the old cells are
    // dead and no in-flight read may paint the new Turn's file.
    this.invalidatePaintedHits()
    this.cancelPreview()
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
    // ONE request token per copy: only the LATEST request may paint feedback, so
    // a slower earlier write can never overwrite a newer attempt, and a
    // settlement belonging to a page the user already left stays stale.
    this.copySerial += 1
    const serial = this.copySerial
    // The pending clipboard settlement is a NEW frame state: the old action
    // bar's cells are retired until the fresh outcome frame paints.
    this.invalidatePaintedHits()
    this.copyPath(file.path, (ok) => {
      if (this.disposed || serial !== this.copySerial) return
      // The selection may have moved while the clipboard write was pending: a
      // settlement for another Turn/file must never paint "copied" over it.
      if (this.page !== 'details' || this.currentTurn() !== turn || this.selectedPath !== file.path) return
      this.copyState = ok ? 'ok' : 'failed'
      this.requestRender()
    })
  }

  // ── preview (Delivered files PR2) ────────────────────────────────────────

  /** Run one preview request as an OWNED workflow (never a bare `void`). */
  private own(label: string, task: () => Promise<void>): void {
    const runOwned = this.runOwned
    if (runOwned !== undefined) {
      runOwned(label, task)
      return
    }
    // A mount without the runner (headless fixtures) still runs the task; its
    // own try/catch turns every failure into a painted state, so nothing here
    // can reject.
    task().catch((error: unknown) => {
      if (this.disposed) return
      this.failPreview(error)
    })
  }

  /** Revoke the in-flight read: nothing it returns may paint any more. */
  private cancelPreview(): void {
    this.previewSerial += 1
    const controller = this.previewAbort
    this.previewAbort = undefined
    controller?.abort(new Error('delivered file preview superseded'))
    this.preview = { kind: 'idle' }
    this.previewNotice = ''
    this.previewStat = undefined
    this.previewScrollToContent = false
  }

  /** Enter Preview: a REAL stat first, then (unless binary) the first page. */
  private startPreview(path: string): void {
    this.previewNotice = ''
    this.previewStat = undefined
    this.detailsTop = 0
    const capability = this.previewCapability
    if (capability === undefined) {
      // No Host read on this mount: a definite state, never a fake preview.
      this.preview = { kind: 'failure', code: 'service-unavailable' }
      this.requestRender()
      return
    }
    const serial = this.beginPreviewRequest()
    const signal = this.previewAbort!.signal
    this.preview = { kind: 'loading-stat' }
    this.requestRender()
    this.own('delivered file preview', () => this.loadPreview(serial, path, signal))
  }

  /** Take the next request identity and abort the previous read. */
  private beginPreviewRequest(): number {
    this.previewSerial += 1
    this.previewAbort?.abort(new Error('delivered file preview superseded'))
    this.previewAbort = new AbortController()
    return this.previewSerial
  }

  /** Whether a reply still owns the visible Preview (identity, page and life). */
  private ownsPreview(serial: number): boolean {
    return !this.disposed && serial === this.previewSerial && this.page === 'details'
  }

  private async loadPreview(serial: number, path: string, signal: AbortSignal): Promise<void> {
    const capability = this.previewCapability
    if (capability === undefined) return
    try {
      const stat = await capability.stat(path, signal)
      if (!this.ownsPreview(serial)) return
      this.previewStat = stat
      if (isPreviewBinary(path)) {
        // A known binary suffix is metadata only: no read, no bytes injected.
        this.preview = { kind: 'metadata', stat, reason: 'unsupported-type' }
        this.requestRender()
        return
      }
      this.preview = { kind: 'loading-page', stat, offset: 1 }
      this.requestRender()
      const page = await capability.read(path, 1, signal)
      if (!this.ownsPreview(serial)) return
      this.preview = { kind: 'text-page', page, nextOffset: page.offset + DELIVERED_FILE_PAGE_LINES }
      this.previewStat = page.stat
      this.previewScrollToContent = true
      this.requestRender()
    } catch (error) {
      if (!this.ownsPreview(serial)) return
      this.failPreview(error)
    }
  }

  /** Request one explicit page (PgUp/PgDn at a page edge). */
  private requestPreviewPage(offset: number): void {
    const file = this.selectedFile()
    const capability = this.previewCapability
    if (file === undefined || capability === undefined) return
    const stat = this.previewStat
    if (stat === undefined) return
    this.previewNotice = ''
    const serial = this.beginPreviewRequest()
    const signal = this.previewAbort!.signal
    this.preview = { kind: 'loading-page', stat, offset }
    this.requestRender()
    this.own('delivered file preview page', () => this.loadPage(serial, file.path, offset, signal, stat))
  }

  private async loadPage(
    serial: number,
    path: string,
    offset: number,
    signal: AbortSignal,
    previous: DeliveredFileStat,
  ): Promise<void> {
    const capability = this.previewCapability
    if (capability === undefined) return
    try {
      const page = await capability.read(path, offset, signal)
      if (!this.ownsPreview(serial)) return
      if (page.stat.version !== previous.version) {
        // The Host file changed between pages: never splice two versions.
        this.startPreview(path)
        this.previewNotice = 'File changed; preview restarted'
        this.requestRender()
        return
      }
      this.preview = { kind: 'text-page', page, nextOffset: page.offset + DELIVERED_FILE_PAGE_LINES }
      this.previewStat = page.stat
      this.previewScrollToContent = true
      this.requestRender()
    } catch (error) {
      if (!this.ownsPreview(serial)) return
      this.failPreview(error)
    }
  }

  /** One DEFINITE state for a refusal; an unknown failure is reported, generic. */
  private failPreview(error: unknown): void {
    // The caller's own cancellation is not a state: the request was revoked by a
    // newer navigation, and that newer flow owns the page.
    if (isCancellation(error)) return
    // A SUPERSEDED read is UI-SILENT by contract (`docs/architecture/host-client.md`,
    // `read-error.ts`, plan §7.5): the connection generation moved on, so the reply
    // describes a transport epoch this page no longer talks to. It must therefore
    // not be presented, not be mapped to a Host refusal, not be retried inside the
    // same operation, and not reach diagnostics as an error. It still has to END
    // the loading state, so the page falls back to the neutral `idle` body (the
    // declared path/description stay painted); the user's next explicit entry
    // re-requests from `stat`.
    if (error instanceof SupersededReadError) {
      this.preview = { kind: 'idle' }
      this.previewStat = undefined
      this.previewNotice = ''
      this.requestRender()
      return
    }
    const stat = this.previewStat
    if (error instanceof DeliveredFileReadError) {
      this.preview = { kind: 'failure', code: error.code, ...(stat === undefined ? {} : { stat }) }
      this.requestRender()
      return
    }
    this.reportUnclassifiedFailure?.('delivered file preview', error)
    this.preview = { kind: 'failure', code: undefined, ...(stat === undefined ? {} : { stat }) }
    this.requestRender()
  }

  /** The preview rows of the Details body for one width. */
  private previewLines(width: number): string[] {
    const contentWidth = Math.max(8, Math.floor(width))
    const lines: string[] = []
    switch (this.preview.kind) {
      case 'idle':
        break
      case 'loading-stat':
        lines.push(color.textDim('Loading…'))
        break
      case 'loading-page':
        lines.push(color.textDim(`Loading lines ${this.preview.offset}…`))
        break
      case 'metadata': {
        lines.push(color.textDim('Preview unavailable for this file type'))
        if (this.preview.stat.bytes !== undefined) lines.push(color.textDim(`Size: ${this.preview.stat.bytes} bytes`))
        break
      }
      case 'text-page': {
        const page = this.preview.page
        if (page.lines === 0) {
          // An EOF page is a definite end, never a retry loop.
          lines.push(color.textDim('(end of file)'))
        } else {
          for (const line of page.text.split('\n')) {
            // Source lines are NEVER dropped: a long line wraps losslessly.
            lines.push(...wrapPreservingText(sanitizeDisplayText(line), contentWidth))
          }
        }
        break
      }
      case 'failure': {
        lines.push(color.error(previewFailureText(this.preview.code)))
        const stat = this.preview.stat
        if (stat !== undefined && stat.bytes !== undefined) lines.push(color.textDim(`Size: ${stat.bytes} bytes`))
        break
      }
    }
    return lines
  }

  // ── mouse ───────────────────────────────────────────────────────────────

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Without a real pointer owner the panel never claims a cell.
    if (this.disposed || !this.pointerOwned()) return undefined
    if (event.type === 'drag') {
      // A drag is a text selection, never an activation: the press identity is
      // retired so no later release can complete it.
      this.pressedCell = undefined
      return undefined
    }
    if (event.type !== 'press' && event.type !== 'click') return undefined
    if (event.button !== 'left') {
      this.pressedCell = undefined
      return undefined
    }
    const completeClick = event.type === 'click'
    // Only a frame painted at THIS geometry can be hit: a resize (or a changed
    // content grant) invalidates the recorded rows before the next paint.
    if (Math.floor(event.width) !== this.paintedWidth || Math.floor(event.height) !== this.paintedRows) {
      this.pressedCell = undefined
      return undefined
    }
    // The frame's page/seat must still be the live one: a page or seat change
    // retires every recorded cell until the next paint.
    if (this.paintedPage !== this.page) {
      this.pressedCell = undefined
      return undefined
    }
    const liveSeat = this.page === 'files' ? this.seat : 'list'
    if (this.paintedSeat !== liveSeat) {
      this.pressedCell = undefined
      return undefined
    }
    const target = this.pointerTargetAt(event.x, event.y)
    if (!completeClick) {
      // A PRESS may select / consume, but never enters a page, runs a footer
      // action or opens a Turn. Its semantic target identity is the fence the
      // synthesized click must reproduce.
      if (target === undefined) {
        this.pressedCell = undefined
        return undefined
      }
      // A BUTTON keeps its press: a row's `Details` verb, every action-bar
      // button, and a Turns-page row (that page is a navigation list, not
      // selectable content). The press half owns the gesture, so a drag never
      // completes it.
      if (target.kind !== 'list') {
        this.pressedCell = { page: this.page, seat: liveSeat, x: event.x, y: event.y, identity: target.identity }
        return { handled: true }
      }
      // A Files BODY row (a listed file's path/description, never its verb)
      // leaves the press UNCONSUMED: the modal's fork opt-in
      // (`textSelectionInsets`, divergence X068) turns it into a text selection
      // clipped to the frame's content rectangle. The row is still selected by
      // the complete click the release synthesizes when the press did not drag,
      // and the recorded identity keeps that click from retargeting a list
      // repainted under the held pointer.
      this.pressedCell = { page: this.page, seat: liveSeat, x: event.x, y: event.y, identity: target.identity }
      return undefined
    }

    // A synthesized click is only valid for the EXACT cell and semantic target
    // the press recorded. A keyboard scroll/page/filter between press and
    // release can repaint a different Turn/file/action under the held pointer;
    // that click must not transfer.
    const pressed = this.pressedCell
    this.pressedCell = undefined
    if (pressed === undefined || target === undefined) return undefined
    if (pressed.x !== event.x || pressed.y !== event.y
      || pressed.page !== this.page || pressed.seat !== liveSeat
      || pressed.identity !== target.identity) return undefined
    if (target.kind === 'footer' && target.action !== undefined) {
      this.runFooterAction(target.action)
      return { handled: true, render: true }
    }
    if (target.kind === 'turn' && target.turn !== undefined) {
      this.openFilesForTurn(target.turn)
      return { handled: true, render: true }
    }
    if (target.kind === 'details' && target.path !== undefined) {
      this.selectedPath = target.path
      this.openDetails()
      return { handled: true, render: true }
    }
    if (target.kind === 'list' && target.path !== undefined) {
      this.selectedPath = target.path
      this.requestRender()
      return { handled: true, render: true }
    }
    return undefined
  }

  /** Resolve the ONE painted semantic target under a cell, or undefined. The
   *  identity encodes page + seat + kind + the target's own values + the exact
   *  painted columns/row, so neither a repaint nor a re-layout can retarget a
   *  held click. */
  private pointerTargetAt(x: number, y: number): PointerTarget | undefined {
    const page = this.page
    const seat = page === 'files' ? this.seat : 'list'
    const prefix = `${page}\u0000${seat}`
    // The action bar owns its painted button cells on EVERY page.
    if (y === this.paintedFooterRow) {
      const hit = this.paintedFooterHits.find(candidate =>
        x >= candidate.startCol && x < candidate.endCol)
      if (hit === undefined) return undefined
      return {
        kind: 'footer',
        action: hit.action,
        identity: `${prefix}\u0000footer\u0000${hit.action}\u0000${hit.startCol}\u0000${hit.endCol}`,
      }
    }
    // Turns rows: a complete click opens THAT Turn; the row + Turn are part of
    // the identity because the list can scroll between press and release.
    if (page === 'turns') {
      const turn = this.paintedTurnRows.get(y)
      if (turn === undefined) return undefined
      return { kind: 'turn', turn, identity: `${prefix}\u0000turn\u0000${turn}\u0000${y}` }
    }
    // The Details body is a read-only preview; only its footer is interactive.
    if (page === 'details') return undefined
    // Files body: only the list seat claims rows.
    if (this.seat !== 'list') return undefined
    // LAST-PAINTED identity: the frame's list must still be the live list. A
    // committed filter, a Turn switch or any other membership/order change
    // invalidates the recorded cells, so a click can never act on a row the
    // user never saw there.
    if (this.paintedListIdentity !== this.listIdentity()) return undefined
    const action = this.paintedActionRows.get(y)
    if (action !== undefined && x >= action.startCol && x < action.endCol) {
      return {
        kind: 'details',
        path: action.path,
        identity: `${prefix}\u0000details\u0000${action.path}\u0000${action.startCol}\u0000${action.endCol}`,
      }
    }
    const path = this.paintedListRows.get(y)
    if (path === undefined) return undefined
    return { kind: 'list', path, identity: `${prefix}\u0000list\u0000${path}` }
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

  /**
   * The WRAPPED projection of the current text page, materialised only as far as
   * the caller needs. A page is at most 120 source lines, but ONE of them may be
   * a near-2 MiB line: wrapping it at a narrow width yields tens of thousands of
   * physical rows, so re-wrapping the whole page on every keystroke and again on
   * every paint is not affordable. The cache is keyed by the page IDENTITY and
   * the width, and a page / version / width change discards it.
   */
  private wrapCache: {
    page: DeliveredFilePage
    width: number
    source: string[]
    /** The CURRENT source line's safe projection (sanitized once). */
    projected: string | undefined
    sourceLine: number
    /** The CODE-UNIT offset inside `projected`: wrapping progress is exact. */
    charOffset: number
    rows: string[]
  } | undefined
  /** Internal diagnostic: source lines projected since the last reset. */
  private wrappedSourceLines = 0
  /** Internal diagnostic: PHYSICAL rows materialised since the last reset. */
  private wrappedPhysicalRows = 0

  /**
   * ONE physical row of the current page, advanced character by character.
   *
   * The previous version wrapped a whole source line with `wrapPreservingText`,
   * which materialises every row of that line at once: one legal ~2 MiB line at
   * 12 columns is ~175k rows, and spreading them into `push(...)` even threw
   * `RangeError`. Wrapping progress is now the (line, code-unit offset) pair and
   * each call yields exactly one row, so the work is bounded by the viewport.
   */
  private nextPhysicalRow(cache: NonNullable<DeliveredFilesPanel['wrapCache']>, limit: number): string | undefined {
    while (cache.sourceLine < cache.source.length) {
      if (cache.projected === undefined) {
        // Source lines are NEVER dropped: a long line wraps losslessly.
        cache.projected = sanitizeDisplayText(cache.source[cache.sourceLine]!)
        cache.charOffset = 0
        this.wrappedSourceLines += 1
      }
      const line = cache.projected
      if (cache.charOffset >= line.length) {
        // The line ended; an EMPTY line is still one physical row.
        cache.sourceLine += 1
        cache.projected = undefined
        if (line.length > 0) continue
        return ''
      }
      let row = ''
      let rowWidth = 0
      while (cache.charOffset < line.length) {
        const code = line.codePointAt(cache.charOffset)!
        const char = String.fromCodePoint(code)
        const charWidth = visibleWidth(char)
        if (rowWidth > 0 && rowWidth + charWidth > limit) break
        row += char
        rowWidth += charWidth
        cache.charOffset += char.length
      }
      return row
    }
    return undefined
  }

  private ensurePreviewRows(contentWidth: number, needed: number): { rows: string[]; complete: boolean } {
    const state = this.preview
    if (state.kind !== 'text-page') return { rows: [], complete: true }
    const page = state.page
    let cache = this.wrapCache
    if (cache === undefined || cache.page !== page || cache.width !== contentWidth) {
      cache = {
        page,
        width: contentWidth,
        source: page.text.split('\n'),
        projected: undefined,
        sourceLine: 0,
        charOffset: 0,
        rows: [],
      }
      this.wrapCache = cache
      this.wrappedSourceLines = 0
      this.wrappedPhysicalRows = 0
    }
    const limit = Math.max(1, Math.floor(contentWidth))
    while (cache.rows.length < needed) {
      const row = this.nextPhysicalRow(cache, limit)
      if (row === undefined) break
      // Bounded append: never spread a huge array into one call.
      cache.rows.push(row)
      this.wrappedPhysicalRows += 1
    }
    return { rows: cache.rows, complete: cache.sourceLine >= cache.source.length }
  }

  private detailsLayout(width: number, neededPreviewRows = 0): { lines: string[]; previewStart: number } {
    const file = this.selectedFile()
    if (file === undefined) return { lines: [], previewStart: 0 }
    const contentWidth = Math.max(8, Math.floor(width))
    const lines: string[] = []
    // The COMPLETE projected path is wrapped, never clipped: it is the identity
    // the (necessarily clamped) title cannot always show.
    const hostPrefix = 'Host: '
    const hostChunks = wrapPreservingText(sanitizeDisplayText(file.path), Math.max(8, contentWidth - hostPrefix.length))
    hostChunks.forEach((chunk, index) => {
      lines.push(`${index === 0 ? color.textDim(hostPrefix) : ' '.repeat(hostPrefix.length)}${chunk}`)
    })
    if (file.description !== undefined && file.description !== '') {
      const wrapped = wrapPlainText(sanitizeDisplayText(file.description), Math.max(4, contentWidth - 'Description: '.length))
      wrapped.forEach((line, index) => {
        lines.push(`${index === 0 ? color.textDim('Description: ') : ' '.repeat('Description: '.length)}${line}`)
      })
    }
    lines.push('')
    const previewStart = lines.length
    // ONE place paints the page's notice, so a version restart stays visible
    // after the NEW first page has already loaded.
    if (this.previewNotice !== '') lines.push(color.textDim(this.previewNotice))
    if (this.preview.kind === 'text-page' && this.preview.page.lines > 0) {
      const { rows } = this.ensurePreviewRows(contentWidth, neededPreviewRows)
      lines.push(...rows)
    } else {
      lines.push(...this.previewLines(contentWidth))
    }
    return { lines, previewStart }
  }

  // ── rendering ───────────────────────────────────────────────────────────

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const rows: string[] = []
    const actionRows = new Map<number, { path: string; startCol: number; endCol: number }>()
    const listRows = new Map<number, string>()
    // ONE fitted label set for this width, shared by every surface of the page.
    const fittedByPath = this.fittedLabelsFor(safeWidth)

    if (this.page === 'details') {
      const file = this.selectedFile()
      const titleSuffix = ' · Details'
      const titleLabel = file === undefined
        ? ''
        : fittedByPath.get(file.path) ?? sanitizeDisplaySegment(deliveredFileBasename(file.path))
      const title = file === undefined ? 'Details' : `${titleLabel}${titleSuffix}`
      rows.push(truncateToWidth(color.textDim(title), safeWidth, '…'))
      const bodyRows = Math.max(1, this.maxRows - 2)
      const layout = this.detailsLayout(safeWidth, this.detailsTop + bodyRows)
      const body = layout.lines
      if (this.previewScrollToContent) {
        this.previewScrollToContent = false
        this.detailsTop = Math.max(0, Math.min(layout.previewStart, Math.max(0, body.length - bodyRows)))
      }
      const top = Math.min(this.detailsTop, Math.max(0, body.length - bodyRows))
      const windowed = body.slice(top, top + bodyRows)
      while (windowed.length < bodyRows) windowed.push('')
      rows.push(...windowed.map(line => truncateToWidth(line, safeWidth, '…')))
      const footer = this.footerLayout(safeWidth, this.copyState === 'ok'
        ? 'Path copied'
        : this.copyState === 'failed' ? 'Could not copy path' : undefined)
      rows.push(footer.text)
      this.paint(safeWidth, rows, listRows, actionRows, footer.hits)
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
      const turnRows = new Map<number, number>()
      for (const entry of visible) {
        const selected = entry.turn === this.turnCursor
        const label = `Turn ${entry.turn} · ${entry.files.length} ${entry.files.length === 1 ? 'file' : 'files'}`
        const row = rows.length
        rows.push(truncateToWidth(`${selected ? color.primary('>') : ' '} ${label}`, safeWidth, '…'))
        turnRows.set(row, entry.turn)
      }
      while (rows.length < this.maxRows - 1) rows.push('')
      const footer = this.footerLayout(safeWidth)
      rows.push(footer.text)
      // A painted Turn row is a complete-click target; the action bar owns its
      // own buttons. Nothing else on this page claims a cell.
      this.paint(safeWidth, rows, new Map(), actionRows, footer.hits, turnRows)
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
    // The granted area changes with the terminal: a shrink must REVEAL the
    // selection again instead of leaving it below the new viewport (the stored
    // top was legal for the previous, taller frame).
    const currentIndex = filtered.findIndex(file => file.path === this.selectedPath)
    if (currentIndex >= 0) this.revealSelection(filtered, currentIndex)
    const listTop = Math.max(0, Math.min(this.listTop, Math.max(0, filtered.length - area)))
    this.listTop = listTop
    const visible = filtered.slice(listTop, listTop + area)
    const selectedIndex = this.selectedIndex()
    // A verb is painted only where a pointer can really reach it.
    const actions = this.pointerOwned() && safeWidth >= ACTION_COLUMN_MIN_WIDTH

    for (const [offset, file] of visible.entries()) {
      const index = listTop + offset
      const selected = index === selectedIndex
      const marker = selected ? color.primary('>') : ' '
      const label = fittedByPath.get(file.path) ?? sanitizeDisplaySegment(this.labelOf(file))
      if (!actions) {
        rows.push(truncateToWidth(`${marker} ${color.textDim(label)}`, listWidth, '…'))
        listRows.set(rows.length - 1, file.path)
        continue
      }
      // The verb is right-aligned against the LIST cell, and its hit cells are
      // measured from the ACTUAL painted prefix: a hit computed from the room
      // the label left over disagreed with what the user sees.
      const verbWidth = visibleWidth(DETAILS_VERB)
      const visibleLabel = truncateToWidth(label, Math.max(1, listWidth - verbWidth - 3), '…')
      const prefix = `${marker} ${color.textDim(visibleLabel)}`
      const gap = Math.max(1, listWidth - verbWidth - visibleWidth(prefix))
      const paintedPrefix = `${prefix}${' '.repeat(gap)}`
      const startCol = visibleWidth(paintedPrefix)
      rows.push(truncateToWidth(`${paintedPrefix}${color.primary(DETAILS_VERB)}`, listWidth, '…'))
      listRows.set(rows.length - 1, file.path)
      if (startCol + verbWidth <= listWidth) {
        // The PAINTED identity is the raw path: a repaint that swapped the list
        // (a committed filter, a Turn switch) must not resolve this cell against
        // whatever file now occupies the same index.
        actionRows.set(rows.length - 1, { path: file.path, startCol, endCol: startCol + verbWidth })
      }
    }
    // Fill the list window so the two-column side pane and the action bar keep
    // their real positions on a short result set.
    while (rows.length < this.maxRows - 1) rows.push('')

    if (twoColumn) {
      const side = this.sidePane(sideWidth, area, this.selectedFile() === undefined
        ? undefined
        : fittedByPath.get(this.selectedFile()!.path))
      for (let index = 0; index < area; index += 1) {
        const rowIndex = this.headerRows() + (this.filterRowShown() ? 1 : 0) + index
        const left = rows[rowIndex] ?? ''
        const right = side[index] ?? ''
        rows[rowIndex] = `${padTo(left, listWidth)}   ${truncateToWidth(right, sideWidth, '…')}`
      }
    }
    const footer = this.footerLayout(safeWidth)
    rows.push(footer.text)
    this.paint(safeWidth, rows, listRows, actionRows, footer.hits)
    return rows
  }

  /** The wide Files right pane: the selected file's DECLARED metadata only. */
  private sidePane(width: number, rows: number, fittedLabel: string | undefined): string[] {
    const file = this.selectedFile()
    const lines: string[] = []
    if (file === undefined) return lines
    // The SAME fitted label the list and the Details title paint; a path wraps
    // without losing characters.
    lines.push(...wrapPreservingText(fittedLabel ?? sanitizeDisplaySegment(this.labelOf(file)), width))
    const fullPath = wrapPreservingText(sanitizeDisplayText(file.path), width)
    lines.push(...fullPath.map(line => color.textDim(line)))
    if (file.description !== undefined && file.description !== '') {
      lines.push(...wrapPlainText(sanitizeDisplayText(file.description), width).map(line => color.textDim(line)))
    } else {
      lines.push(...wrapPlainText('No description', width).map(line => color.textDim(line)))
    }
    lines.push('')
    lines.push(color.primary('Enter for Preview'))
    // The Files page itself never reads the Host: the preview belongs to the
    // Details page, and selecting a row here must not trigger a `stat`/`read`.
    return lines.slice(0, rows)
  }

  private filterRow(width: number): string {
    const prefix = color.textDim('Filter: ')
    const prefixWidth = visibleWidth('Filter: ')
    const query = this.filterInput.render(Math.max(1, width - prefixWidth))
    return truncateToWidth(`${prefix}${query[0] ?? ''}`, width, '…')
  }

  /**
   * The action bar: real pointer buttons (`[Filter] · [Turns] · [Close]`,
   * `[Back]`, `[Copy path] · [Back]`) plus keyboard-only hints. Hints are
   * dropped WHOLE first; a button is dropped whole only when the bar cannot
   * fit it, and the terminal action (`[Close]` / `[Back]`) is never dropped
   * while its text still fits. A button that would be clipped paints no hit.
   */
  private footerLayout(width: number, notice?: string): { readonly text: string; readonly hits: readonly PaintedFooterHit[] } {
    const kept = [...this.footerSegments(notice)]
    const plainWidth = (): number => kept.reduce((total, segment, index) =>
      total + visibleWidth(segment.text) + (index === 0 ? 0 : 3), 0)
    while (plainWidth() > width) {
      let dropIndex = -1
      let dropRank = 0
      for (const [index, segment] of kept.entries()) {
        if (segment.rank > dropRank) {
          dropRank = segment.rank
          dropIndex = index
        }
      }
      if (dropIndex === -1) break
      kept.splice(dropIndex, 1)
    }
    let text = ''
    let column = 0
    const hits: PaintedFooterHit[] = []
    kept.forEach((segment, index) => {
      if (index > 0) {
        text += color.textDim(' · ')
        column += 3
      }
      const startCol = column
      if (segment.tone === 'button') {
        text += color.primary(segment.text)
        if (segment.action !== undefined) {
          hits.push({ action: segment.action, startCol, endCol: startCol + visibleWidth(segment.text) })
        }
      } else if (segment.tone === 'notice') {
        text += notice === 'Path copied' ? color.success(segment.text) : color.error(segment.text)
      } else {
        text += color.textDim(segment.text)
      }
      column += visibleWidth(segment.text)
    })
    // The only way the bar exceeds `width` now is a terminal action wider than
    // the whole row: clip it and publish NO hit for the clipped cells.
    if (column > width) return { text: truncateToWidth(text, width, '…'), hits: [] }
    return { text, hits }
  }

  /** The ordered action-bar segments of the current page/seat.
   *
   *  Only a real AltScreen gets pointer BUTTONS. A regular surface keeps the
   *  pre-PR keyboard hints (never a bracketed button with no owner), exactly
   *  like the transcript tail fails open to its slash-command entry. */
  private footerSegments(notice?: string): readonly FooterSegment[] {
    const pointer = this.pointerOwned()
    if (this.page === 'details') {
      const segments: FooterSegment[] = []
      if (notice !== undefined) segments.push({ text: notice, tone: 'notice', rank: pointer ? 1 : 4 })
      if (pointer) {
        // Copy path is the optional middle action; Back stays reachable.
        segments.push({ text: '[Copy path]', tone: 'button', rank: 2, action: 'copy-path' })
        segments.push({ text: '[Back]', tone: 'button', rank: 0, action: 'back' })
      } else {
        segments.push({ text: `${DELIVERED_FILES_CHORDS.copyPath.label} Copy path`, tone: 'hint', rank: 2 })
        segments.push({ text: 'Esc Back', tone: 'hint', rank: 0 })
      }
      return segments
    }
    if (this.page === 'turns') {
      return pointer
        ? [
            { text: '↑↓ Select', tone: 'hint', rank: 2 },
            { text: 'Enter Open', tone: 'hint', rank: 1 },
            { text: '[Back]', tone: 'button', rank: 0, action: 'back' },
          ]
        : [
            { text: '↑↓ Select', tone: 'hint', rank: 2 },
            { text: 'Enter Open', tone: 'hint', rank: 1 },
            { text: 'Esc Back', tone: 'hint', rank: 0 },
          ]
    }
    if (this.seat === 'filter') {
      return pointer
        ? [
            { text: 'Enter Apply', tone: 'hint', rank: 2 },
            { text: this.filter === '' ? 'Esc Back' : 'Esc Clear', tone: 'hint', rank: 1 },
            { text: '[Close]', tone: 'button', rank: 0, action: 'close' },
          ]
        : [
            { text: 'Enter Apply', tone: 'hint', rank: 2 },
            { text: this.filter === '' ? 'Esc Back' : 'Esc Clear', tone: 'hint', rank: 0 },
          ]
    }
    if (pointer) {
      // The full bar is 60 cells; at 44 terminal columns the two keyboard hints
      // drop whole and the three buttons remain, exactly as the design mock.
      return [
        { text: 'Enter Preview', tone: 'hint', rank: 4 },
        { text: '↑↓ Select', tone: 'hint', rank: 3 },
        { text: '[Filter]', tone: 'button', rank: 2, action: 'filter' },
        { text: '[Turns]', tone: 'button', rank: 1, action: 'turns' },
        { text: '[Close]', tone: 'button', rank: 0, action: 'close' },
      ]
    }
    // Keyboard-only fallback: whole-segment drops keep the primary action and
    // Esc, never a half-painted hint.
    return [
      { text: 'Enter Preview', tone: 'hint', rank: 4 },
      { text: '↑↓ Select', tone: 'hint', rank: 3 },
      { text: '/ Filter', tone: 'hint', rank: 2 },
      { text: `${DELIVERED_FILES_CHORDS.turns.label} Turns`, tone: 'hint', rank: 1 },
      { text: 'Esc Close', tone: 'hint', rank: 0 },
    ]
  }

  /** Run ONE painted action-bar action (only a complete click reaches here). */
  private runFooterAction(action: FooterAction): void {
    switch (action) {
      case 'filter':
        this.enterFilter()
        return
      case 'turns':
        this.openTurns()
        return
      case 'close':
        this.close()
        return
      case 'back':
        if (this.page === 'details') this.backFromDetails()
        else this.backFromTurns()
        return
      case 'copy-path':
        this.copySelectedPath()
    }
  }

  /** The identity of the LIST the current frame paints (order + membership). */
  private listIdentity(): string {
    if (this.page !== 'files') return ''
    return `${this.currentTurn()}\u0000${this.filter}\u0000${this.filteredFiles().map(file => file.path).join('\u0000')}`
  }

  /** Drop every recorded hit target (a state change invalidates the frame). */
  private invalidatePaintedHits(): void {
    this.paintedListRows = new Map()
    this.paintedActionRows = new Map()
    this.paintedFooterHits = []
    this.paintedFooterRow = -1
    this.paintedTurnRows = new Map()
    this.paintedWidth = 0
    this.paintedRows = 0
    this.paintedListIdentity = ''
    this.paintedPage = undefined
    this.paintedSeat = undefined
    this.pressedCell = undefined
  }

  private paint(
    width: number,
    rows: readonly string[],
    listRows: ReadonlyMap<number, string>,
    actionRows: ReadonlyMap<number, { readonly path: string; readonly startCol: number; readonly endCol: number }>,
    footerHits: ReadonlyArray<PaintedFooterHit> = [],
    turnRows: ReadonlyMap<number, number> = new Map(),
  ): void {
    this.paintedWidth = width
    this.paintedRows = rows.length
    this.paintedListRows = listRows
    this.paintedActionRows = actionRows
    this.paintedFooterHits = footerHits
    // The action bar is ALWAYS the last painted row of every page.
    this.paintedFooterRow = rows.length - 1
    this.paintedTurnRows = turnRows
    this.paintedListIdentity = this.listIdentity()
    this.paintedPage = this.page
    this.paintedSeat = this.page === 'files' ? this.seat : 'list'
  }
}

function padTo(text: string, width: number): string {
  const visible = visibleWidth(text)
  if (visible >= width) return truncateToWidth(text, width, '…')
  return `${text}${' '.repeat(width - visible)}`
}
