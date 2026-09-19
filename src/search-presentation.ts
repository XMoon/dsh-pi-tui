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
import { color } from './theme.ts'

/** The weak highlight of a visible non-current occurrence — the native
 * fullscreen search default. */
const SEARCH_MATCH_STYLE = (text: string): string => `\x1b[4m${text}\x1b[24m`

/** The strong highlight of the current occurrence: bold + explicit theme-aware
 * foreground/background (plan S3 §6.2). Deliberately NOT the terminal's inverse
 * attribute — provenance is unchanged, only the rendering is themed. */
const SEARCH_CURRENT_MATCH_STYLE = (text: string): string => color.searchCurrent(text)

/** The anchor-only current result's row wash (weaker than the exact block). */
const SEARCH_ANCHOR_STYLE = (text: string): string => color.searchAnchorBg(text)

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
  // The ANCHOR-ONLY current result (plan S3 §6.3): no proven occurrence, so
  // every match stays weak — but the owning source/card row gets a weaker
  // background so the user can still see WHERE the current N/M lives. The
  // occurrence provenance (selectedIndex = -1), the count and the scroll anchor
  // are all unchanged.
  if (selection.selectedIndex < 0 && selection.selectedRow !== undefined) {
    const row = selection.selectedRow
    const line = result[row]
    if (line !== undefined && !isImageLine(line)) result[row] = styleVisibleText(line, SEARCH_ANCHOR_STYLE)
  }
  return result
}

/** Structural line-identity compare: the fork caches render output by
 * reference while content/width are unchanged, so a changed line array means
 * the recorded geometry no longer describes the render. */
function sameSourceLines(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return false
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false
  return true
}

/**
 * Wraps a mounted message component and decorates its rendered lines with the
 * current search selection. The child component (and its render cache) is
 * reused; the caller's selection for THIS render epoch is reused too (no second
 * matcher scan). The wrapper NEVER reuses a strong selection against lines the
 * geometry was not measured on: a same-width content change (dynamic component,
 * image load, …) or a width change downgrades to weak-only until the next
 * rebuild recomputes geometry. `updateSelector`/`clear` keep the mounted
 * wrapper on the same epoch as the row map.
 */
export class SearchHighlightComponent implements Component {
  private readonly child: Component
  private selector: RenderedSearchSelector
  private selection: RenderedSearchSelection
  private selectionWidth: number
  private sourceLines: readonly string[]
  private disabled = false

  constructor(
    child: Component,
    selector: RenderedSearchSelector,
    selection: RenderedSearchSelection,
    width: number,
    lines: readonly string[],
  ) {
    this.child = child
    this.selector = selector
    this.selection = selection
    this.selectionWidth = width
    this.sourceLines = lines
  }

  /** Re-sync the wrapper with the geometry of the current render epoch (the
   * remeasure pass owns the row map and must not diverge from the paint). */
  updateSelector(selector: RenderedSearchSelector, selection: RenderedSearchSelection, width: number, lines: readonly string[]): void {
    this.selector = selector
    this.selection = selection
    this.selectionWidth = width
    this.sourceLines = lines
    this.disabled = false
  }

  /** The block is no longer part of the search presentation: stop decorating
   * (a mounted wrapper survives a measurement-only remeasure). */
  clear(): void {
    this.disabled = true
  }

  render(width: number): string[] {
    const lines = this.child.render(width)
    if (this.disabled) return lines
    if (width !== this.selectionWidth || !sameSourceLines(lines, this.sourceLines)) {
      // The recorded geometry does not describe these lines: decorate the
      // visible matches weak-only and never paint a stale strong occurrence or
      // a stale anchor row.
      this.selection = { matches: findAltScreenSearchMatches(lines, this.selector.query), selectedIndex: -1, selectedRow: undefined, exact: false }
      this.selectionWidth = width
      this.sourceLines = lines
    }
    return highlightSearchLines(lines, this.selection)
  }

  invalidate(): void {
    this.child.invalidate?.()
  }
}
