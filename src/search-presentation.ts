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
  type AltScreenSearchSegment,
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
 * One searchable SOURCE REGION in a rendered card: the block-relative rows (and
 * optional visible columns) a renderer can PROVE belong to one semantic source.
 * `anchorRow` is the honest fallback row when no occurrence correspondence can
 * be proven.
 */
export interface SearchSourceRegion {
  readonly sourceKey: string
  readonly anchorRow: number
  readonly rowStart: number
  readonly rowEnd: number
  readonly columns?: { readonly startCol: number; readonly endCol: number }
  /** Whether rendered matches inside this region may be numbered as PROVEN
   * source occurrences. False means the region is position-only (a transformed
   * / relativized / truncated projection): it anchors, never enumerates — the
   * generic layer must not infer provenance from render order. */
  readonly enumerable?: boolean
}

/** One PROVEN occurrence mapping: the semantic source-local ordinal and the
 * rendered match (`matchIndex` indexes the card's matcher result) it maps to. */
export interface RenderedSourceOccurrence {
  readonly sourceOccurrence: number
  readonly matchIndex: number
  readonly segments: readonly AltScreenSearchSegment[]
}

/** The proven geometry of ONE semantic source in a rendered card. Only
 * occurrences whose correspondence the renderer can prove are listed; an empty
 * `occurrences` means "the source region is visible, but no occurrence can be
 * proven" — the selection anchors at `anchorRow` and shows NO strong highlight
 * rather than guessing. */
export interface RenderedSourceGeometry {
  readonly sourceKey: string
  readonly anchorRow: number
  readonly occurrences: readonly RenderedSourceOccurrence[]
}

/**
 * What to select inside one rendered block. The CURRENT target carries the
 * proven `geometry` of its own source; other visible matching cards are
 * decorated weak-only and never carry semantic identity.
 */
export interface RenderedSearchSelector {
  readonly query: string
  /** The semantic source-local ordinal of the target match. */
  readonly sourceOccurrence: number
  readonly geometry?: RenderedSourceGeometry
  readonly weakOnly?: boolean
}

/** One block's rendered search selection. `exact` is true ONLY when the
 * semantic occurrence was PROVEN to a rendered occurrence; a false selection is
 * an anchor-only degradation and must NOT strong-highlight anything. */
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

/** Whether every segment of a match lies FULLY inside the region (row range,
 * plus the visible-column span when the region declares one). A start-only
 * check would accept a match whose tail crosses out of the source. */
function matchInsideRegion(match: AltScreenSearchMatch, region: SearchSourceRegion): boolean {
  if (match.segments.length === 0) return false
  for (const segment of match.segments) {
    if (segment.row < region.rowStart || segment.row >= region.rowEnd) return false
    if (region.columns !== undefined) {
      if (segment.row !== region.rowStart) return false
      if (segment.startCol < region.columns.startCol || segment.endCol > region.columns.endCol) return false
    }
  }
  return true
}

/** Build the PROVEN geometry of one source from the card's matcher result and
 * the renderer-declared regions. Matches are claimed in render order, so the
 * source ordinal follows the VISIBLE text, never a raw-corpus ordinal. */
export function buildSourceGeometry(
  matches: readonly AltScreenSearchMatch[],
  regions: readonly SearchSourceRegion[],
  sourceKey: string,
): RenderedSourceGeometry | undefined {
  const sourceRegions = regions.filter(region => region.sourceKey === sourceKey)
  if (sourceRegions.length === 0) return undefined
  const occurrences: RenderedSourceOccurrence[] = []
  const enumerable = sourceRegions.some(region => region.enumerable !== false)
  if (enumerable) {
    matches.forEach((match, matchIndex) => {
      const region = sourceRegions.find(candidate => candidate.enumerable !== false && matchInsideRegion(match, candidate))
      if (region === undefined) return
      occurrences.push({ sourceOccurrence: occurrences.length, matchIndex, segments: match.segments })
    })
  }
  return { sourceKey, anchorRow: sourceRegions[0]!.anchorRow, occurrences }
}

/**
 * Select the rendered occurrence that belongs to the semantic source.
 * An exact highlight requires a PROVEN occurrence; otherwise the selection
 * anchors at the source region row (or the card top) and shows NO strong
 * highlight — a wrong strong highlight would misrepresent the N/M identity.
 *
 * NOTE (best-effort boundary): the index query is `trim().toLowerCase()` while
 * the fork matcher collapses internal whitespace (`/\s+/g` → single space), so
 * a semantic occurrence and the rendered occurrence set can differ for exotic
 * whitespace. A mapping is therefore always a best-effort claim, never a
 * guarantee.
 */
export function selectRenderedSearchMatch(
  matches: readonly AltScreenSearchMatch[],
  selector: RenderedSearchSelector,
): RenderedSearchSelection {
  if (selector.weakOnly === true) {
    // Every visible occurrence is decorated weak; no card is "current".
    return { matches, selectedIndex: -1, selectedRow: undefined, exact: false }
  }
  const geometry = selector.geometry
  if (geometry !== undefined) {
    const occurrence = geometry.occurrences.find(candidate => candidate.sourceOccurrence === selector.sourceOccurrence)
    if (occurrence !== undefined) {
      return { matches, selectedIndex: occurrence.matchIndex, selectedRow: occurrence.segments[0]?.row, exact: true }
    }
    return { matches, selectedIndex: -1, selectedRow: geometry.anchorRow, exact: false }
  }
  // No source geometry at all: anchor the card top, never strong-highlight.
  return { matches, selectedIndex: -1, selectedRow: 0, exact: false }
}

/** Decorate every visible occurrence of `selection.matches` without changing
 * row count or visible width. `selectedIndex >= 0` marks that occurrence
 * strong; `-1` with matches present decorates all of them weak (the other
 * visible cards while the current card owns the strong occurrence). */
export function highlightSearchLines(
  lines: readonly string[],
  selection: RenderedSearchSelection,
): string[] {
  if (selection.matches.length === 0) return [...lines]
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

/**
 * Wraps a mounted message component and decorates its rendered lines with the
 * current search selection. The child component (and its render cache) is
 * reused; the selection computed by the caller for THIS render epoch is reused
 * too (no second matcher scan). `updateSelector` lets a remeasure pass keep the
 * mounted wrapper on the SAME geometry epoch as the row map / scroll anchor.
 */
export class SearchHighlightComponent implements Component {
  private readonly child: Component
  private selector: RenderedSearchSelector
  private selection: RenderedSearchSelection
  private selectionWidth: number

  constructor(
    child: Component,
    selector: RenderedSearchSelector,
    selection: RenderedSearchSelection,
    width: number,
  ) {
    this.child = child
    this.selector = selector
    this.selection = selection
    this.selectionWidth = width
  }

  /** Re-sync the wrapper with the geometry of the current render epoch (the
   * remeasure pass owns the row map and must not diverge from the paint). */
  updateSelector(selector: RenderedSearchSelector, selection: RenderedSearchSelection, width: number): void {
    this.selector = selector
    this.selection = selection
    this.selectionWidth = width
  }

  render(width: number): string[] {
    const lines = this.child.render(width)
    if (width !== this.selectionWidth) {
      // A width change invalidates the recorded geometry (rows/columns are
      // width-baked and wrapping shifts). Until the next rebuild recomputes it,
      // downgrade to a weak-only, anchor-at-top selection rather than paint a
      // stale strong occurrence.
      this.selection = { matches: findAltScreenSearchMatches(lines, this.selector.query), selectedIndex: -1, selectedRow: 0, exact: false }
      this.selectionWidth = width
    }
    return highlightSearchLines(lines, this.selection)
  }

  invalidate(): void {
    this.child.invalidate?.()
  }
}
