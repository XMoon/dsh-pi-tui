/**
 * The ORIGINAL-TEXT visual layout (Phase 3B): the ONE consumer-layer fold that
 * turns an arbitrary original string into a paintable visual-row layout WHILE
 * retaining the exact UTF-16 offset of every displayed cell run.
 *
 * It exists because the vendored `Text` renderer cannot be used as the
 * copyable source: it expands TAB to three spaces, word-wraps, and `trimEnd()`s
 * every wrapped line. A round trip through those rendered rows could therefore
 * never reproduce the original bytes. This module keeps ONE authoritative
 * mapping instead: `visual row + display cell` -> `original UTF-16 half-open
 * range`, so `source.slice(start, end)` is always exactly the text the user
 * pointed at.
 *
 * It holds no domain fact, no clipboard, no Host and no Session: the source is
 * the original string the owning surface already renders, and the offsets are
 * the ONLY thing it adds. `\n`/`\r\n` are real hard-break tokens whose offsets
 * stay in the source range, a lone `\r` and every other C0/C1 control are shown
 * as safe text escapes (`\x1b`, `\x00`, `\r`, …) that still map back to their
 * single original character, TAB paints three cells but maps one `\t`, and soft
 * wrapping never inserts a source character.
 *
 * Extracted verbatim from the Job Command document (Phase 3B / B1-C) so the
 * Job Command reader and the History preview share ONE offset mapping instead
 * of two divergent copies; the Job module keeps its named exports as aliases.
 *
 * @module @xmoon76/dsh-pi-tui/tui/components/source-text-layout
 */

import { getGraphemeSegmenter, visibleWidth } from '@xmoon76/pi-tui'

/** One same-row run of displayed cells that maps back to ONE original
 *  grapheme (or one control/TAB token). `startCol`/`endCol` are display cells
 *  within the visual row, `sourceStart`/`sourceEnd` the original UTF-16
 *  half-open range. */
export interface SourceTextVisualCellRun {
  readonly startCol: number
  readonly endCol: number
  readonly sourceStart: number
  readonly sourceEnd: number
  readonly display: string
}

/** One visual row of the document. `sourceEnd` is the CONTENT end (the hard
 *  break is excluded); `hardBreakEnd` includes the original LF/CRLF when this
 *  row ended on a real newline, otherwise it equals `sourceEnd`. */
export interface SourceTextVisualRow {
  readonly sourceStart: number
  readonly sourceEnd: number
  readonly hardBreakEnd: number
  readonly runs: readonly SourceTextVisualCellRun[]
  readonly rendered: string
}

/** The immutable layout of ONE source string at ONE width. */
export interface SourceTextVisualLayout {
  readonly width: number
  readonly source: string
  readonly rows: readonly SourceTextVisualRow[]
}

/** A point in the document: visual row plus display cell. */
export interface SourceTextPoint {
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
 *  CR gets the readable `\r` spelling: it is NOT a hard break, so it must never
 *  move the cursor. */
function controlDisplay(control: string): string {
  const code = control.codePointAt(0)!
  if (code === 0x0d) return '\\r'
  return `\\x${code.toString(16).padStart(2, '0')}`
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
 * Build the visual layout of one original source string at one width. The scan
 * is a single pass over the grapheme segmentation of the source; the result
 * keeps the exact source string so every later offset is resolved against the
 * SAME bytes it was measured from.
 */
export function buildSourceTextVisualLayout(source: string, width: number): SourceTextVisualLayout {
  const safeWidth = Math.max(1, Math.floor(width))
  const rows: SourceTextVisualRow[] = []
  let runs: SourceTextVisualCellRun[] = []
  let rendered = ''
  let col = 0
  let rowStart = 0
  let rowEnd = 0
  /** A LEADING zero-width grapheme has no cell of its own yet: it belongs to
   *  the first painted cell of the row, so it waits for that run instead of
   *  becoming a zero-cell run no gesture could ever reach. */
  let pendingMark = ''
  let pendingMarkStart = 0

  const pushRow = (hardBreakEnd: number): void => {
    // A row made ONLY of zero-width graphemes: they stay one zero-cell run at
    // the row's own column, so the row still maps a real source range.
    if (pendingMark !== '') {
      runs.push({ startCol: col, endCol: col, sourceStart: pendingMarkStart, sourceEnd: rowEnd, display: pendingMark })
      rendered += pendingMark
      pendingMark = ''
    }
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
      // A zero-width grapheme (a lone mark / selector) owns no cell: it rides on
      // the base character it belongs to and stays inside that character's
      // ORIGINAL range. It therefore EXTENDS the previous run when there is one
      // and otherwise pends for the next run. `rendered` is updated in every
      // path, so "concatenating every run's display reproduces the painted row"
      // holds universally.
      const previous = runs.length === 0 ? undefined : runs[runs.length - 1]
      if (previous === undefined) {
        if (pendingMark === '') pendingMarkStart = start
        pendingMark += display
      } else {
        runs[runs.length - 1] = { ...previous, sourceEnd: end, display: previous.display + display }
        rendered += display
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
    // A pended leading zero-width grapheme belongs to THIS first painted cell:
    // its source range starts before the base character, so a gesture anchored
    // on the cell always carries the mark with it.
    runs.push({
      startCol: col,
      endCol: col + cells,
      sourceStart: pendingMark === '' ? start : pendingMarkStart,
      sourceEnd: end,
      display: pendingMark + display,
    })
    rendered += pendingMark + display
    pendingMark = ''
    col += cells
    rowEnd = end
  }
  pushRow(rowEnd)
  return { width: safeWidth, source, rows }
}

/** The original UTF-16 offset of one document point. `start` aligns to the
 *  first character of the grapheme under the point, `end` to the offset just
 *  after it — the one rule that makes a press start-anchored and a drag
 *  endpoint inclusive in both directions. */
export function sourceTextPointOffset(
  layout: SourceTextVisualLayout,
  point: SourceTextPoint,
  align: 'start' | 'end',
): number | undefined {
  const row = layout.rows[point.row]
  if (row === undefined) return undefined
  if (row.runs.length === 0) return row.sourceEnd
  // Negative columns (a pointer clamped past the left edge) read as column 0.
  const col = Math.max(0, point.col)
  for (const run of row.runs) {
    if (run.endCol === run.startCol) {
      // A row made ONLY of zero-width graphemes: the whole row is that run, so
      // its own column must still resolve to a real offset.
      if (col <= run.startCol) return align === 'start' ? run.sourceStart : run.sourceEnd
      continue
    }
    if (col < run.startCol) return run.sourceStart
    if (col < run.endCol) return align === 'start' ? run.sourceStart : run.sourceEnd
  }
  return row.runs[row.runs.length - 1]!.sourceEnd
}

/** The single half-open source range one gesture selects: `undefined` for a
 *  same-cell gesture (a plain click never copies). */
export function sourceTextSelectionRange(
  layout: SourceTextVisualLayout,
  anchor: SourceTextPoint,
  focus: SourceTextPoint,
): { readonly start: number; readonly end: number } | undefined {
  const forward =
    focus.row > anchor.row || (focus.row === anchor.row && focus.col > anchor.col)
  const earlier = forward ? anchor : focus
  const later = forward ? focus : anchor
  if (earlier.row === later.row && earlier.col === later.col) return undefined
  const start = sourceTextPointOffset(layout, earlier, 'start')
  const end = sourceTextPointOffset(layout, later, 'end')
  if (start === undefined || end === undefined || end <= start) return undefined
  return { start, end }
}

/** The display column a source offset falls on inside one visual row. */
function columnAtOffset(
  row: SourceTextVisualRow,
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
export function sourceTextRowSelectionColumns(
  layout: SourceTextVisualLayout,
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
