/**
 * The Job Command ORIGINAL-TEXT document (Phase 3B / B1-C): the ONE
 * consumer-layer fold that turns the official shell command label into a
 * paintable visual-row layout WHILE retaining the exact UTF-16 offset of every
 * displayed cell run.
 *
 * It exists because the vendored `Text` renderer cannot be used as the
 * copyable Command source: it expands TAB to three spaces, word-wraps, and
 * `trimEnd()`s every wrapped line (see plan §4.1). A round trip through those
 * rendered rows could therefore never reproduce the original command bytes.
 * This module keeps ONE authoritative mapping instead:
 * `visual row + display cell` -> `original UTF-16 half-open range`, so
 * `label.slice(start, end)` is always exactly the text the user pointed at.
 *
 * It holds no Job fact, no clipboard, no Host and no Session: the source is the
 * `JobObservedSnapshot.label` the workspace already renders, and the offsets
 * are the ONLY thing it adds. `\n`/`\r\n` are real hard-break tokens whose
 * offsets stay in the source range, a lone `\r` and every other C0/C1 control
 * are shown as safe text escapes (`\x1b`, `\x00`, `\r`, …) that still map back
 * to their single original character, TAB paints three cells but maps one `\t`,
 * and soft wrapping never inserts a source character.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/job-command-document
 */

import { getGraphemeSegmenter, visibleWidth, type Component } from '@xmoon76/pi-tui'

/** One same-row run of displayed cells that maps back to ONE original
 *  grapheme (or one control/TAB token). `startCol`/`endCol` are display cells
 *  within the visual row, `sourceStart`/`sourceEnd` the original UTF-16
 *  half-open range. */
export interface CommandVisualCellRun {
  readonly startCol: number
  readonly endCol: number
  readonly sourceStart: number
  readonly sourceEnd: number
  readonly display: string
}

/** One visual row of the Command document. `sourceEnd` is the CONTENT end
 *  (the hard break is excluded); `hardBreakEnd` includes the original LF/CRLF
 *  when this row ended on a real newline, otherwise it equals `sourceEnd`. */
export interface CommandVisualRow {
  readonly sourceStart: number
  readonly sourceEnd: number
  readonly hardBreakEnd: number
  readonly runs: readonly CommandVisualCellRun[]
  readonly rendered: string
}

/** The immutable layout of ONE command label at ONE width. */
export interface CommandVisualLayout {
  readonly width: number
  readonly source: string
  readonly rows: readonly CommandVisualRow[]
}

/** A point in the Command document: visual row plus display cell. */
export interface CommandPoint {
  readonly row: number
  readonly col: number
}

/** The single-cell placeholder a grapheme wider than the WHOLE grant paints as:
 *  the grapheme still maps back in full, the display never overflows the row. */
const OVERFLOW_PLACEHOLDER = '?'

/** TAB paints the fork's own display width (three cells) but maps ONE `\t`. */
const TAB_DISPLAY = '   '
const TAB_CELLS = 3

/** The lower-case escape of one control character (its ORIGINAL UTF-16 range
 *  is one code unit, so the display is always longer than the source). A lone
 *  CR gets the readable `\r` spelling (plan §4.1 rule 4): it is NOT a hard
 *  break, so it must never move the cursor. */
function controlDisplay(segment: string): string {
  let display = ''
  for (const character of segment) {
    const code = character.codePointAt(0)!
    if (code === 0x0d) display += '\\r'
    else if (code <= 0xff) display += `\\x${code.toString(16).padStart(2, '0')}`
    else display += `\\u{${code.toString(16)}}`
  }
  return display
}

/** Whether one grapheme starts with a control code that must NEVER be written
 *  to the terminal: C0 (except the TAB/LF/CRLF tokens handled by name), DEL and
 *  C1 — the set that can drive the cursor, change modes or start an escape
 *  sequence. Printable text after an ESC (e.g. the `[31m` of a raw SGR) stays
 *  printable text and is displayed literally, which is safe. A lone CR IS such
 *  a token: it moves the cursor, so it can never be painted raw. */
function isControlToken(segment: string): boolean {
  const code = segment.codePointAt(0)!
  if (code === 0x09 || code === 0x0a) return false
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)
}

/**
 * Build the visual layout of one original command label at one width. The scan
 * is a single pass over the grapheme segmentation of the source; the result
 * keeps the exact source string so every later offset is resolved against the
 * SAME bytes it was measured from.
 */
export function buildCommandVisualLayout(source: string, width: number): CommandVisualLayout {
  const safeWidth = Math.max(1, Math.floor(width))
  const rows: CommandVisualRow[] = []
  let runs: CommandVisualCellRun[] = []
  let rendered = ''
  let col = 0
  let rowStart = 0
  let rowEnd = 0

  const pushRow = (hardBreakEnd: number): void => {
    rows.push({ sourceStart: rowStart, sourceEnd: rowEnd, hardBreakEnd, runs, rendered })
    runs = []
    rendered = ''
    col = 0
  }

  for (const { segment, index } of getGraphemeSegmenter().segment(source)) {
    const start = index
    const end = index + segment.length
    if (segment === '\n' || segment === '\r\n') {
      // A real hard break: never painted as text, but its exact original range
      // is what `hardBreakEnd` carries into the next row.
      rowEnd = start
      pushRow(end)
      rowStart = end
      rowEnd = end
      continue
    }
    const isTab = segment === '\t'
    const control = !isTab && isControlToken(segment)
    let display = isTab ? TAB_DISPLAY : control ? controlDisplay(segment) : segment
    let cells = isTab ? TAB_CELLS : visibleWidth(display)
    if (!isTab && !control && cells === 0) {
      // A zero-width grapheme (a lone mark): it has no cell of its own, so it
      // rides on the previous run's source range and stays copyable.
      const previous = runs.length === 0 ? undefined : runs[runs.length - 1]
      if (previous === undefined) {
        runs.push({ startCol: 0, endCol: 0, sourceStart: start, sourceEnd: end, display })
      } else {
        runs[runs.length - 1] = { ...previous, sourceEnd: end, display: previous.display + display }
      }
      rowEnd = end
      continue
    }
    if (cells > safeWidth) {
      // Wider than the whole grant: paint ONE safe cell, still mapping the
      // entire grapheme.
      display = OVERFLOW_PLACEHOLDER
      cells = 1
    }
    if (col > 0 && col + cells > safeWidth) {
      // A SOFT wrap: no character is inserted, the previous row simply ends.
      rowEnd = start
      pushRow(start)
      rowStart = start
      rowEnd = start
    }
    runs.push({ startCol: col, endCol: col + cells, sourceStart: start, sourceEnd: end, display })
    rendered += display
    col += cells
    rowEnd = end
  }
  pushRow(rowEnd)
  return { width: safeWidth, source, rows }
}

/** The original UTF-16 offset of one document point. `start` aligns to the
 *  first character of the grapheme under the point, `end` to the offset just
 *  after it — the one rule that makes a press start-anchored and a drag
 *  endpoint inclusive in both directions (plan §4.2). */
export function commandPointOffset(
  layout: CommandVisualLayout,
  point: CommandPoint,
  align: 'start' | 'end',
): number | undefined {
  const row = layout.rows[point.row]
  if (row === undefined) return undefined
  if (row.runs.length === 0) return row.sourceEnd
  // Negative columns (a pointer clamped past the left edge) read as column 0.
  const col = Math.max(0, point.col)
  for (const run of row.runs) {
    if (col < run.startCol) return run.sourceStart
    if (col < run.endCol) return align === 'start' ? run.sourceStart : run.sourceEnd
  }
  return row.runs[row.runs.length - 1]!.sourceEnd
}

/** The single half-open source range one gesture selects: `undefined` for a
 *  same-cell gesture (a plain click never copies). */
export function commandSelectionRange(
  layout: CommandVisualLayout,
  anchor: CommandPoint,
  focus: CommandPoint,
): { readonly start: number; readonly end: number } | undefined {
  const forward =
    focus.row > anchor.row || (focus.row === anchor.row && focus.col > anchor.col)
  const earlier = forward ? anchor : focus
  const later = forward ? focus : anchor
  if (earlier.row === later.row && earlier.col === later.col) return undefined
  const start = commandPointOffset(layout, earlier, 'start')
  const end = commandPointOffset(layout, later, 'end')
  if (start === undefined || end === undefined || end <= start) return undefined
  return { start, end }
}

/** The display column a source offset falls on inside one visual row. */
function columnAtOffset(
  row: CommandVisualRow,
  offset: number,
  align: 'start' | 'end',
): number {
  if (row.runs.length === 0) return 0
  for (const run of row.runs) {
    if (offset <= run.sourceStart) return run.startCol
    if (offset < run.sourceEnd) return align === 'start' ? run.startCol : run.endCol
  }
  return row.runs[row.runs.length - 1]!.endCol
}

/** The display columns of one visual row that a source range covers, or
 *  `undefined` when it covers none of that row's content. The hard-break cells
 *  between rows are deliberately not paintable. */
export function commandRowSelectionColumns(
  layout: CommandVisualLayout,
  row: number,
  start: number,
  end: number,
): { readonly startCol: number; readonly endCol: number } | undefined {
  const visual = layout.rows[row]
  if (visual === undefined) return undefined
  if (end <= visual.sourceStart || start >= visual.sourceEnd) return undefined
  const startCol = columnAtOffset(visual, Math.max(start, visual.sourceStart), 'start')
  const endCol = columnAtOffset(visual, Math.min(end, visual.sourceEnd), 'end')
  return endCol > startCol ? { startCol, endCol } : undefined
}

/**
 * The Command document as the exact `Component.render(width)` source the
 * ScrollView's child paints, with the layout cached per (source, width) so a
 * repaint or a snapshot push never rescans the label. The rendered strings are
 * ANSI-free safe text; the visual ROW COUNT and the cell width never depend on
 * the terminal state.
 */
export class JobCommandDocument implements Component {
  private sourceValue = ''
  private layoutValue: CommandVisualLayout | undefined
  private renderedLines: readonly string[] = []

  /** Replace the original command label. The layout is rebuilt lazily at the
   *  next render for the width that is actually painted. */
  setSource(source: string): void {
    if (source === this.sourceValue) return
    this.sourceValue = source
    this.layoutValue = undefined
    this.renderedLines = []
  }

  /** The original label currently laid out. */
  get source(): string {
    return this.sourceValue
  }

  /** The layout at one width, rebuilt only when the width or the source
   *  changed (plan §4.1 rule 7). */
  layoutAt(width: number): CommandVisualLayout {
    const safeWidth = Math.max(1, Math.floor(width))
    if (this.layoutValue === undefined || this.layoutValue.width !== safeWidth) {
      this.layoutValue = buildCommandVisualLayout(this.sourceValue, safeWidth)
      this.renderedLines = this.layoutValue.rows.map(row => row.rendered)
    }
    return this.layoutValue
  }

  /** The number of visual rows at the last laid-out width (0 before the first
   *  layout). */
  get rowCount(): number {
    return this.layoutValue?.rows.length ?? 0
  }

  render(width: number): string[] {
    this.layoutAt(width)
    return [...this.renderedLines]
  }

  invalidate(): void {
    this.layoutValue = undefined
    this.renderedLines = []
  }
}
