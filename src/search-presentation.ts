/**
 * The Host rendered-occurrence presentation layer for transcript search:
 * given one message component's rendered lines and the current semantic
 * occurrence, it selects the matching rendered occurrence and decorates
 * every visible occurrence with the SAME ANSI/grapheme/cell geometry the
 * native fullscreen search uses (the fork exports the pure matcher; the Host
 * never re-implements Unicode column mapping).
 *
 * This module is presentation-only: it never changes row counts or visible
 * width, and it never touches the message component's own render cache.
 * @module @xmoon76/dsh-pi-tui/search-presentation
 */

import {
  findAltScreenSearchMatches,
  sliceByColumn,
  visibleWidth,
  type AltScreenSearchMatch,
  type Component,
} from '@xmoon76/pi-tui'

/** The weak highlight of a visible non-current occurrence — the native
 * fullscreen search default. */
const SEARCH_MATCH_STYLE = (text: string): string => `\x1b[4m${text}\x1b[24m`

/** The strong highlight of the current occurrence — the native default. */
const SEARCH_CURRENT_MATCH_STYLE = (text: string): string => `\x1b[1;7m${text}\x1b[22;27m`

const KITTY_IMAGE_PREFIX = '\x1b_G'
const ITERM2_IMAGE_PREFIX = '\x1b]1337;File='

/**
 * What to select inside one rendered block: the query, the block-relative
 * rendered row range of the semantic source (when known) and the occurrence
 * ordinal inside that source.
 */
export interface RenderedSearchSelector {
  readonly query: string
  /** Block-relative rendered rows [start, end) of the semantic source. */
  readonly range?: { readonly start: number; readonly end: number }
  /** Visible-column span inside the (single-row) range for a FIELD-scoped
   * selection: a Workflow member row renders `label` and `status` on one row,
   * so a row-only range cannot tell the two fields apart. */
  readonly columns?: { readonly startCol: number; readonly endCol: number }
  readonly sourceOccurrence: number
}

/** One block's rendered search selection. `exact` is false when the semantic
 * occurrence could not be located inside its source range and the ordinal
 * fallback (or the card top) was used. */
export interface RenderedSearchSelection {
  readonly matches: readonly AltScreenSearchMatch[]
  readonly selectedIndex: number
  readonly selectedRow: number | undefined
  readonly exact: boolean
}

function isImageLine(line: string): boolean {
  return line.startsWith(KITTY_IMAGE_PREFIX)
    || line.startsWith(ITERM2_IMAGE_PREFIX)
    || line.includes(KITTY_IMAGE_PREFIX)
    || line.includes(ITERM2_IMAGE_PREFIX)
}

/** The run of zero-width escape sequences at the END of a rendered line
 * (SGR resets, OSC/OSC8 terminators, APC/DCS terminators): column slicing
 * cannot carry them, so the highlight assembly re-appends them verbatim or
 * the terminal state leaks into the following output. */
const TRAILING_ZERO_WIDTH = /(?:(?:\x1b\[[0-9;?]*[ -/]*[@-~])|(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))|(?:\x1b_[^\x07\x1b]*(?:\x07|\x1b\\))|(?:\x1bP[^\x07\x1b]*(?:\x07|\x1b\\)))+$/u

function trailingZeroWidthSequences(line: string): string {
  return line.match(TRAILING_ZERO_WIDTH)?.[0] ?? ''
}

/** Apply one style to the visible text while preserving embedded SGR codes
 * (the native `applySearchTextHighlight` shape: each plain run is wrapped). */
function styleVisibleText(text: string, style: (value: string) => string): string {
  const sgr = /\x1b\[[0-9;]*m/g
  let result = ''
  let plainStart = 0
  let match: RegExpExecArray | null
  while ((match = sgr.exec(text)) !== null) {
    if (match.index > plainStart) result += style(text.slice(plainStart, match.index))
    result += match[0]
    plainStart = match.index + match[0].length
  }
  if (plainStart < text.length) result += style(text.slice(plainStart))
  return result
}

/**
 * Select the rendered occurrence that belongs to the semantic source. The
 * range-limited matches win (occurrence `sourceOccurrence` inside the range);
 * otherwise the ordinal is taken across the whole card (exact: false); an
 * empty card falls back to the card top.
 */
export function selectRenderedSearchMatch(
  matches: readonly AltScreenSearchMatch[],
  selector: RenderedSearchSelector,
): RenderedSearchSelection {
  const range = selector.range
  const columns = range === undefined ? undefined : selector.columns
  const scoped = range === undefined
    ? matches
    : matches.filter(match => {
      const first = match.segments[0]
      const last = match.segments[match.segments.length - 1]
      if (first === undefined || last === undefined) return false
      if (first.row < range.start || last.row >= range.end) return false
      // A field-scoped selection additionally requires the occurrence to START
      // inside the field's visible column span (label vs status on one row).
      if (columns !== undefined && (first.startCol < columns.startCol || first.startCol >= columns.endCol)) return false
      return true
    })
  if (scoped.length > 0 && selector.sourceOccurrence < scoped.length) {
    // The requested source occurrence exists inside its semantic range: the
    // exact rendered occurrence.
    const match = scoped[selector.sourceOccurrence]!
    return {
      matches,
      selectedIndex: matches.indexOf(match),
      selectedRow: match.segments[0]?.row,
      exact: true,
    }
  }
  if (matches.length > 0) {
    // No in-range occurrence (or the source ordinal overflows the range):
    // fall back to the whole-card ordinal and mark the selection inexact.
    const index = Math.min(Math.max(0, selector.sourceOccurrence), matches.length - 1)
    const match = matches[index]!
    return { matches, selectedIndex: index, selectedRow: match.segments[0]?.row, exact: false }
  }
  // The rendered text contains no occurrence at all (a presenter transformed
  // the canonical text): anchor the owning card top instead of dropping the
  // semantic result.
  return { matches, selectedIndex: -1, selectedRow: 0, exact: false }
}

/** Decorate every visible occurrence of `selection.matches` without changing
 * row count or visible width; the current occurrence uses the strong style. */
export function highlightSearchLines(
  lines: readonly string[],
  selection: RenderedSearchSelection,
): string[] {
  if (selection.selectedIndex < 0 || selection.matches.length === 0) return [...lines]
  const rangesByRow = new Map<number, Array<{ startCol: number; endCol: number; current: boolean }>>()
  selection.matches.forEach((match, matchIndex) => {
    for (const segment of match.segments) {
      const ranges = rangesByRow.get(segment.row) ?? []
      ranges.push({ startCol: segment.startCol, endCol: segment.endCol, current: matchIndex === selection.selectedIndex })
      rangesByRow.set(segment.row, ranges)
    }
  })
  const result = [...lines]
  for (const [row, ranges] of rangesByRow) {
    const line = result[row]
    if (line === undefined || isImageLine(line)) continue
    const lineWidth = visibleWidth(line)
    // Assemble ascending from the ORIGINAL line: re-slicing an already
    // highlighted line could drop a trailing ANSI reset at the slice edge.
    const sorted = [...ranges].sort((left, right) => left.startCol - right.startCol)
    let output = ''
    let cursor = 0
    for (const range of sorted) {
      const startCol = Math.min(range.startCol, lineWidth)
      const endCol = Math.min(range.endCol, lineWidth)
      if (endCol <= startCol) continue
      if (startCol > cursor) output += sliceByColumn(line, cursor, startCol - cursor, true)
      const highlighted = sliceByColumn(line, startCol, endCol - startCol, true)
      output += styleVisibleText(highlighted, range.current ? SEARCH_CURRENT_MATCH_STYLE : SEARCH_MATCH_STYLE)
      cursor = endCol
    }
    if (cursor < lineWidth) output += sliceByColumn(line, cursor, lineWidth - cursor, true)
    // Zero-width escape sequences at the END of the original line (a color
    // reset after the visible tail, an OSC8 hyperlink terminator, …) are not
    // part of any column slice: restore them from the ORIGINAL line unless the
    // assembled output already ends with them. Keyed on the final output, not
    // on `cursor >= lineWidth`: a reset can follow visible tail text too.
    const trailing = trailingZeroWidthSequences(line)
    if (trailing !== '' && !output.endsWith(trailing)) output += trailing
    result[row] = output
  }
  return result
}

/** Compute the selection for one rendered block (pure). */
export function renderedSearchSelection(
  lines: readonly string[],
  selector: RenderedSearchSelector,
): RenderedSearchSelection {
  return selectRenderedSearchMatch(findAltScreenSearchMatches(lines, selector.query), selector)
}

/**
 * Wraps a mounted message component and decorates its rendered lines with
 * the current search selection. The child component (and its render cache)
 * is reused; only the returned lines gain ANSI highlight.
 */
export class SearchHighlightComponent implements Component {
  private readonly child: Component
  private selector: RenderedSearchSelector

  constructor(child: Component, selector: RenderedSearchSelector) {
    this.child = child
    this.selector = selector
  }

  render(width: number): string[] {
    const lines = this.child.render(width)
    return highlightSearchLines(lines, renderedSearchSelection(lines, this.selector))
  }

  invalidate(): void {
    this.child.invalidate?.()
  }
}
