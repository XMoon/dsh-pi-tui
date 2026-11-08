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
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/search-presentation
 */

import {
  findAltScreenSearchMatches,
  getGraphemeSegmenter,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
  type AltScreenSearchMatch,
  type AltScreenSearchSegment,
  type Component,
} from '@xmoon76/pi-tui'
import { color } from '../../theme/runtime.ts'

const graphemeSegmenter = getGraphemeSegmenter()

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
  /** Untransformed semantic text for a DIRECT, single-line region. Absence
   * means position-only; this short-lived evidence is not another search corpus. */
  readonly sourceText?: string
  /** Whether rendered matches may be used as navigation candidates. False keeps
   * the region position-only even when it has visible columns. */
  readonly enumerable?: boolean
}

/** One proven semantic occurrence and its exact rendered match. */
export interface RenderedSourceOccurrence {
  readonly sourceOccurrence: number
  readonly normalizedSourceRange: { readonly start: number; readonly end: number }
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
  /** The current semantic source-local normalized range; unlike the stable key,
   * it changes when content reflows or a hit moves within its source. */
  readonly normalizedSourceRange?: { readonly start: number; readonly end: number }
  /** Suppress rendered matching until the owner remeasures when source-row
   * eligibility depends on renderer-specific layout such as wrapped chrome. */
  readonly suppressMatchesOnStaleGeometry?: boolean
  readonly geometry?: RenderedSourceGeometry
  readonly weakOnly?: boolean
}

/** Navigation-only rendered row range. It is best-effort geometry and does
 * not prove semantic occurrence correspondence. */
export interface RenderedSearchScrollRange {
  /** First rendered row of the navigation target, inclusive. */
  readonly startRow: number
  /** Last rendered row of the navigation target, inclusive. */
  readonly endRow: number
}

/** One block's rendered search selection. `exact` is true ONLY when the
 * semantic occurrence was PROVEN to a rendered occurrence; a false selection is
 * an anchor-only degradation and must NOT strong-highlight anything. */
export interface RenderedSearchSelection {
  readonly matches: readonly AltScreenSearchMatch[]
  readonly selectedIndex: number
  readonly selectedRow: number | undefined
  readonly exact: boolean
  /** Best-effort viewport geometry; never semantic occurrence proof. */
  readonly scrollRange?: RenderedSearchScrollRange
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

function graphemeBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>([0, text.length])
  for (const segment of graphemeSegmenter.segment(text)) boundaries.add(segment.index)
  return boundaries
}

function proveDirectFieldOccurrences(
  matches: readonly AltScreenSearchMatch[],
  renderedLines: readonly string[],
  region: SearchSourceRegion,
  query: string,
): RenderedSourceOccurrence[] | undefined {
  const sourceText = region.sourceText
  const columns = region.columns
  const row = region.rowStart
  if (sourceText === undefined || /[\r\n]/u.test(sourceText) || region.enumerable === false) return undefined
  if (region.rowEnd !== row + 1 || region.anchorRow !== row || row < 0 || row >= renderedLines.length) return undefined
  if (columns === undefined
    || !Number.isInteger(columns.startCol) || !Number.isInteger(columns.endCol)
    || columns.startCol < 0 || columns.endCol <= columns.startCol) return undefined

  const line = renderedLines[row]!
  const fieldWidth = columns.endCol - columns.startCol
  if (columns.endCol > visibleWidth(line) || visibleWidth(sourceText) !== fieldWidth) return undefined
  const paintedField = stripTerminalSequences(sliceByColumn(line, columns.startCol, fieldWidth, true))
  if (visibleWidth(paintedField) !== fieldWidth) return undefined

  const trimmedQuery = query.trim()
  const needle = trimmedQuery.toLowerCase()
  if (needle === '' || needle.length !== trimmedQuery.length || needle.replace(/\s+/gu, ' ') !== needle) return undefined
  const normalizedSource = sourceText.toLowerCase()
  const normalizedPainted = paintedField.toLowerCase()
  if (normalizedSource.length !== sourceText.length
    || normalizedPainted.length !== paintedField.length
    || normalizedSource !== normalizedPainted) return undefined

  const sourceBoundaries = graphemeBoundaries(sourceText)
  const normalizedSourceBoundaries = graphemeBoundaries(normalizedSource)
  const paintedBoundaries = graphemeBoundaries(paintedField)
  const normalizedPaintedBoundaries = graphemeBoundaries(normalizedPainted)
  const semanticRanges: Array<{ sourceOccurrence: number; start: number; end: number }> = []
  let start = 0
  while (true) {
    const index = normalizedSource.indexOf(needle, start)
    if (index < 0) break
    const end = index + needle.length
    if (!sourceBoundaries.has(index) || !sourceBoundaries.has(end)
      || !normalizedSourceBoundaries.has(index) || !normalizedSourceBoundaries.has(end)
      || !paintedBoundaries.has(index) || !paintedBoundaries.has(end)
      || !normalizedPaintedBoundaries.has(index) || !normalizedPaintedBoundaries.has(end)) return undefined
    semanticRanges.push({ sourceOccurrence: semanticRanges.length, start: index, end })
    start = index + Math.max(1, needle.length)
  }

  const candidates = matches
    .map((match, matchIndex) => ({ match, matchIndex }))
    .filter(candidate => matchInsideRegion(candidate.match, region))
  if (candidates.length !== semanticRanges.length) return undefined

  const occurrences: RenderedSourceOccurrence[] = []
  for (let index = 0; index < semanticRanges.length; index += 1) {
    const semantic = semanticRanges[index]!
    const candidate = candidates[index]!
    if (candidate.match.segments.length !== 1) return undefined
    const segment = candidate.match.segments[0]!
    const startCol = columns.startCol + visibleWidth(paintedField.slice(0, semantic.start))
    const endCol = columns.startCol + visibleWidth(paintedField.slice(0, semantic.end))
    if (segment.row !== row || segment.startCol !== startCol || segment.endCol !== endCol) return undefined
    occurrences.push({
      sourceOccurrence: semantic.sourceOccurrence,
      normalizedSourceRange: { start: semantic.start, end: semantic.end },
      matchIndex: candidate.matchIndex,
      segments: candidate.match.segments,
    })
  }
  return occurrences
}

/** Build the PROVEN geometry of one source from the current render and a
 * renderer-supplied direct-field source. Missing, transformed or ambiguous
 * provenance yields a real anchor geometry with no exact occurrences. */
export function buildSourceGeometry(
  matches: readonly AltScreenSearchMatch[],
  renderedLines: readonly string[],
  regions: readonly SearchSourceRegion[],
  sourceKey: string,
  query: string,
): RenderedSourceGeometry | undefined {
  const sourceRegions = regions.filter(region => region.sourceKey === sourceKey)
  if (sourceRegions.length === 0) return undefined
  const evidenceRegions = sourceRegions.filter(region => region.sourceText !== undefined)
  const directRegion = evidenceRegions.length === 1 && evidenceRegions[0]!.enumerable !== false
    ? evidenceRegions[0]
    : undefined
  const occurrences = directRegion === undefined
    ? []
    : proveDirectFieldOccurrences(matches, renderedLines, directRegion, query) ?? []
  return {
    sourceKey,
    anchorRow: directRegion?.anchorRow ?? sourceRegions[0]!.anchorRow,
    occurrences,
  }
}

/** Select the occurrence whose source ordinal AND normalized source range
 * match a field geometry proven against the current rendered lines. Matcher
 * order or occurrence count alone never proves semantic identity. */
export function selectRenderedSearchMatch(
  matches: readonly AltScreenSearchMatch[],
  selector: RenderedSearchSelector,
): RenderedSearchSelection {
  if (selector.weakOnly === true) {
    // Every visible occurrence is decorated weak; no card is "current".
    return { matches, selectedIndex: -1, selectedRow: undefined, exact: false }
  }
  const geometry = selector.geometry
  if (geometry !== undefined && selector.normalizedSourceRange !== undefined) {
    const targetRange = selector.normalizedSourceRange
    const occurrence = geometry.occurrences.find(candidate =>
      candidate.sourceOccurrence === selector.sourceOccurrence
      && candidate.normalizedSourceRange.start === targetRange.start
      && candidate.normalizedSourceRange.end === targetRange.end)
    if (occurrence !== undefined) {
      return { matches, selectedIndex: occurrence.matchIndex, selectedRow: occurrence.segments[0]?.row, exact: true }
    }
    return { matches, selectedIndex: -1, selectedRow: geometry.anchorRow, exact: false }
  }
  if (geometry !== undefined) {
    return { matches, selectedIndex: -1, selectedRow: geometry.anchorRow, exact: false }
  }
  // No source geometry at all: anchor the card top, never strong-highlight.
  return { matches, selectedIndex: -1, selectedRow: 0, exact: false }
}

/** Convert one rendered match to its inclusive first/last row range. */
function renderedSearchMatchRowRange(match: AltScreenSearchMatch | undefined): RenderedSearchScrollRange | undefined {
  if (match === undefined || match.segments.length === 0) return undefined
  return {
    startRow: match.segments[0]!.row,
    endRow: match.segments[match.segments.length - 1]!.row,
  }
}

/** Choose conservative navigation geometry without changing provenance
 * selection. A single first candidate may be used only when the region itself
 * identifies a field or starts below card chrome; this remains inexact. */
export function selectRenderedSearchScrollRange(
  matches: readonly AltScreenSearchMatch[],
  selection: RenderedSearchSelection,
  selector: RenderedSearchSelector,
  regions: readonly SearchSourceRegion[],
): RenderedSearchScrollRange | undefined {
  if (selector.weakOnly === true) return undefined

  if (selection.exact && selection.selectedIndex >= 0) {
    const exactRange = renderedSearchMatchRowRange(matches[selection.selectedIndex])
    if (exactRange !== undefined) return exactRange
  }

  const sourceKey = selector.geometry?.sourceKey
  const sourceRegions = sourceKey === undefined
    ? []
    : regions.filter(region => region.sourceKey === sourceKey)
  if (sourceRegions.length > 0) {
    const candidates = matches.filter(match => sourceRegions.some(region => matchInsideRegion(match, region)))
    if (selector.sourceOccurrence === 0 && candidates.length === 1
      && sourceRegions.some(region => region.columns !== undefined || region.rowStart > 0)) {
      const candidateRange = renderedSearchMatchRowRange(candidates[0])
      if (candidateRange !== undefined) return candidateRange
    }
    const anchor = selection.selectedRow
    return anchor === undefined ? undefined : { startRow: anchor, endRow: anchor }
  }

  return { startRow: 0, endRow: 0 }
}

/** One visible-column range to decorate on one rendered row. */
export interface RenderedColumnRange {
  readonly startCol: number
  readonly endCol: number
}

/** One range plus the style its visible text is wrapped in. */
export interface RenderedColumnHighlight {
  readonly range: RenderedColumnRange
  readonly style: (text: string) => string
}

/**
 * Decorate visible column ranges of ALREADY rendered rows without changing
 * their visible width or row count. This is the ONE ansi-safe column-range
 * highlighter: the transcript search and the Job Command drag selection both
 * route through it, so neither re-implements the assembly.
 *
 * Each painted row is re-assembled ascending from the ORIGINAL line — never
 * from a partially highlighted one — because re-slicing an already highlighted
 * line can drop a trailing ANSI reset at the slice edge. The run of zero-width
 * escape sequences at the END of the original line (a reset after the visible
 * tail, an OSC8 terminator, …) is part of no column slice and is restored
 * verbatim unless the assembled output already ends with it; otherwise the
 * terminal state leaks into the following output.
 */
export function highlightColumnRanges(
  lines: readonly string[],
  rangesByRow: ReadonlyMap<number, readonly RenderedColumnHighlight[]>,
): string[] {
  const result = [...lines]
  for (const [row, highlights] of rangesByRow) {
    const line = result[row]
    if (line === undefined || isImageLine(line) || highlights.length === 0) continue
    const lineWidth = visibleWidth(line)
    const sorted = [...highlights].sort((left, right) => left.range.startCol - right.range.startCol)
    let output = ''
    let cursor = 0
    for (const highlight of sorted) {
      const startCol = Math.max(cursor, Math.min(highlight.range.startCol, lineWidth))
      const endCol = Math.min(highlight.range.endCol, lineWidth)
      if (endCol <= startCol) continue
      if (startCol > cursor) output += sliceByColumn(line, cursor, startCol - cursor, true)
      const highlighted = sliceByColumn(line, startCol, endCol - startCol, true)
      output += styleVisibleText(highlighted, highlight.style)
      cursor = endCol
    }
    if (cursor < lineWidth) output += sliceByColumn(line, cursor, lineWidth - cursor, true)
    const trailing = trailingZeroWidthSequences(line)
    if (trailing !== '' && !output.endsWith(trailing)) output += trailing
    result[row] = output
  }
  return result
}

/** Decorate every visible occurrence of `selection.matches` without changing
 * row count or visible width. `selectedIndex >= 0` marks that occurrence
 * strong; `-1` with matches present decorates all of them weak (the other
 * visible cards while the current card owns the strong occurrence). An
 * anchor-only current also washes `selectedRow` even when the card has NO
 * visible occurrence of the query (the source may live behind a transform). */
export function highlightSearchLines(
  lines: readonly string[],
  selection: RenderedSearchSelection,
): string[] {
  let result = [...lines]
  if (selection.matches.length > 0) {
    const candidatesByRow = new Map<number, Array<{ range: RenderedColumnRange; current: boolean }>>()
    selection.matches.forEach((match, matchIndex) => {
      for (const segment of match.segments) {
        const candidates = candidatesByRow.get(segment.row) ?? []
        candidates.push({
          range: { startCol: segment.startCol, endCol: segment.endCol },
          current: matchIndex === selection.selectedIndex,
        })
        candidatesByRow.set(segment.row, candidates)
      }
    })

    const rangesByRow = new Map<number, RenderedColumnHighlight[]>()
    for (const [row, candidates] of candidatesByRow) {
      candidates.sort((left, right) => left.range.startCol - right.range.startCol || right.range.endCol - left.range.endCol)
      const merged: Array<{ range: RenderedColumnRange; current: boolean }> = []
      for (const candidate of candidates) {
        const previous = merged.at(-1)
        if (previous !== undefined && candidate.range.startCol < previous.range.endCol) {
          merged[merged.length - 1] = {
            range: {
              startCol: previous.range.startCol,
              endCol: Math.max(previous.range.endCol, candidate.range.endCol),
            },
            current: previous.current || candidate.current,
          }
        } else {
          merged.push(candidate)
        }
      }
      rangesByRow.set(row, merged.map(item => ({
        range: item.range,
        style: item.current ? SEARCH_CURRENT_MATCH_STYLE : SEARCH_MATCH_STYLE,
      })))
    }
    result = highlightColumnRanges(result, rangesByRow)
  }
  // The ANCHOR-ONLY current result (plan S3 §6.3): no proven occurrence, so
  // every match stays weak — but the owning source/card row gets a weaker
  // background so the user can still see WHERE the current N/M lives. The
  // occurrence provenance (selectedIndex = -1), the count and the scroll anchor
  // are all unchanged. This applies EVEN with no visible occurrence: the
  // source region is the honest anchor in that case.
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
 * geometry was not measured on: generic selectors downgrade to weak-only after
 * a same-width content change or width change; when source-row eligibility is
 * renderer-specific and cannot be recomputed here, the selector can fail closed
 * with no matches until the owner remeasures. `updateSelector`/`clear` keep the
 * mounted wrapper on the same epoch as the row map.
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
      // The recorded geometry does not describe these lines, so never paint a
      // stale strong occurrence or anchor wash. Generic selectors can retain
      // visible weak matches; renderer-specific source-row policies fail closed
      // until their owner measures and supplies a fresh selector.
      const matches = this.selector.suppressMatchesOnStaleGeometry === true
        ? []
        : findAltScreenSearchMatches(lines, this.selector.query)
      this.selection = { matches, selectedIndex: -1, selectedRow: undefined, exact: false }
      this.selectionWidth = width
      this.sourceLines = lines
    }
    return highlightSearchLines(lines, this.selection)
  }

  invalidate(): void {
    this.child.invalidate?.()
  }
}
