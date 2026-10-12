/**
 * The Job Output search model (Phase 3B / B1-B, plan DECISION-01/§5.3): a
 * Job-instance-local Find over the REAL retained Output body, with the three
 * product states `INACTIVE / EDIT / NAVIGATE`, the fork's rendered
 * row/column matcher (`AltScreenSearchIndex`) and the Host's pure occurrence
 * highlighter (`highlightSearchLines`).
 *
 * It answers exactly one question — which rendered rows of the CURRENT retained
 * window match the query — and owns no Job fact: the only source it may index is
 * the official retained text the workspace already renders. Placeholder phases
 * (connecting / empty / unavailable) are never searchable, so the workspace can
 * never claim a match in text that does not exist. There is no second cursor, no
 * second Observer and no timer; the index lives only while this Job instance
 * does.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/job-output-search
 */

import {
  AltScreenSearchIndex,
  Input,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type AltScreenSearchMatch,
  type AltScreenSearchSegment,
  type Component,
  type Focusable,
} from '@xmoon76/pi-tui'
import { highlightSearchLines } from '../components/transcript/search-presentation.ts'
import { color } from '../theme/runtime.ts'

/**
 * The ONLY capability the search model needs from its source: `render(width)`.
 * The Output page passes the vendored `Text`; the Command page passes the
 * {@link JobCommandDocument}, which is the same shape but maps every painted row
 * back to the original command offsets. The model reaches into neither object
 * beyond this read-only renderer surface.
 */
export interface JobSearchTextSource {
  render(width: number): string[]
}

/** The ONE search state machine of the Job Output. */
export type JobOutputSearchMode = 'inactive' | 'edit' | 'navigate'

/** The `i / N` facts of the current epoch (both 0 with no match). */
export interface JobOutputSearchCounts {
  readonly selected: number
  readonly total: number
}

/** One retained-window RENDER epoch: the rendered Output rows, the query's
 *  provable matches inside them and the source TEXT they were rendered from,
 *  kept only while width + source + query hold. The SELECTION identity is
 *  deliberately NOT part of it — it survives a source replacement (see
 *  {@link JobOutputSearch.selectedGeometry}). */
interface JobOutputSearchEpoch {
  readonly sourceKey: string
  readonly text: string
  readonly width: number
  readonly lines: readonly string[]
  readonly matches: readonly AltScreenSearchMatch[]
}

/** The rendered geometry of one match: the row/column span of every segment.
 *  This is a RENDER-COORDINATE fact, so it may only be carried to another epoch
 *  through a PROVEN row mapping (see {@link JobOutputSearch.setSource}). */
type MatchGeometry = readonly AltScreenSearchSegment[]

/** Structural compare of two segment geometries (row + columns, in order). */
function sameGeometry(left: MatchGeometry, right: MatchGeometry): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (a.row !== b.row || a.startCol !== b.startCol || a.endCol !== b.endCol) return false
  }
  return true
}

/** How a pending selection is derived on the next epoch rebuild. `none` keeps
 *  the existing (key-identified) selection. */
type PendingSelection = 'none' | 'query' | 'next' | 'previous'

/** The longest run of trailing lines of `previous` that equals the leading run
 *  of `next` (KMP prefix function, O(previous + next)). Zero when no line can be
 *  proven to survive the new bounded window. Lines are compared by their
 *  ANSI-STRIPPED content (DECISION-03): a pure style/reset difference on the
 *  same visible row is not a different row. */
function longestLineOverlap(previous: readonly string[], next: readonly string[]): number {
  if (previous.length === 0 || next.length === 0) return 0
  const strippedNext = next.map(line => stripTerminalSequences(line))
  const strippedPrevious = previous.map(line => stripTerminalSequences(line))
  const prefix = new Array<number>(strippedNext.length).fill(0)
  for (let index = 1; index < strippedNext.length; index += 1) {
    let matched = prefix[index - 1]!
    while (matched > 0 && strippedNext[index] !== strippedNext[matched]) matched = prefix[matched - 1]!
    if (strippedNext[index] === strippedNext[matched]) matched += 1
    prefix[index] = matched
  }
  let matched = 0
  for (let index = 0; index < strippedPrevious.length; index += 1) {
    while (matched > 0 && strippedPrevious[index] !== strippedNext[matched]) matched = prefix[matched - 1]!
    if (matched < strippedNext.length && strippedPrevious[index] === strippedNext[matched]) matched += 1
  }
  return matched
}

/**
 * The Job retention anchor rebase (plan DECISION-03): after the bounded
 * retained window changed, keep the user's visible top row on the SAME
 * provable content.
 *
 * A pure append (`nextText.startsWith(previousText)`) keeps the byte position
 * unchanged. Otherwise the longest rendered-line suffix/prefix overlap says how
 * many old rows were evicted from the front, and the top offset moves by that
 * many rows. No provable overlap at all returns the old offset, which the
 * viewport clamps to the new window — the retained preview never fabricates a
 * GAP and never claims bytes it can no longer read.
 */
export interface RetentionRebaseInput {
  readonly previousText: string
  readonly nextText: string
  readonly previousRenderedLines: readonly string[]
  readonly nextRenderedLines: readonly string[]
}

/**
 * How many rendered rows the new bounded window evicted from the FRONT of the
 * reference window, or `undefined` when no overlap can be proven at all (a
 * width re-wrap, a placeholder phase, an unrelated window). A pure append
 * proves ZERO eviction. This is the ONE mapping the anchor rebase and the
 * search-hit identity both follow.
 */
export function retentionEviction(input: RetentionRebaseInput): number | undefined {
  const { previousText, nextText, previousRenderedLines, nextRenderedLines } = input
  if (nextText.startsWith(previousText)) return 0
  const overlap = longestLineOverlap(previousRenderedLines, nextRenderedLines)
  if (overlap <= 0) return undefined
  return previousRenderedLines.length - overlap
}

/** The rebased top offset for one retention change (see {@link retentionEviction}). */
export function rebaseRetainedAnchor(input: RetentionRebaseInput & { readonly oldScrollTop: number }): number {
  const clamped = Math.max(0, input.oldScrollTop)
  const evictedRows = retentionEviction(input)
  return evictedRows === undefined ? clamped : Math.max(0, clamped - evictedRows)
}

/** The ONE visible SearchRow of the Job workspace: the real `Input` (focused
 *  through the live screen) plus the independent `i / N` fact. It renders ZERO
 *  rows when the frame's chrome plan did not grant it a row. */
class JobOutputSearchRow implements Component, Focusable {
  private readonly search: JobOutputSearch
  private readonly visible: (width: number) => boolean
  private focusedValue = false

  constructor(search: JobOutputSearch, visible: (width: number) => boolean) {
    this.search = search
    this.visible = visible
  }

  get focused(): boolean {
    return this.focusedValue
  }

  set focused(value: boolean) {
    this.focusedValue = value
    this.search.setInputFocused(value)
  }

  render(width: number): string[] {
    if (!this.visible(width)) return []
    const counts = this.search.countsFor(width)
    const query = this.search.query
    const countText = query === ''
      ? ''
      : counts.total === 0 ? '0/0 · No matches' : `${counts.selected + 1}/${counts.total}`
    const countRendered = countText === '' ? '' : color.textDim(` ${countText} `)
    const countWidth = visibleWidth(countRendered)
    const inputWidth = Math.max(1, width - countWidth)
    const inputLine = this.search.renderInput(inputWidth)
    const padding = ' '.repeat(Math.max(0, inputWidth - visibleWidth(inputLine)))
    const line = `${inputLine}${padding}${countRendered}`
    return [truncateToWidth(line, width, '…', true)]
  }

  invalidate(): void {
    this.search.invalidateInput()
  }
}

/**
 * The Job-local Find model. The panel owns the key dispatch and the physical
 * focus; this object owns the query, the mode, the one-epoch index and the ONE
 * pending reveal.
 */
export class JobOutputSearch {
  private readonly text: JobSearchTextSource
  private readonly index = new AltScreenSearchIndex()
  private readonly input: Input
  private readonly rowComponent: JobOutputSearchRow
  private modeValue: JobOutputSearchMode = 'inactive'
  private sourceKeyValue = '#absent'
  private sourceTextValue = ''
  private searchableValue = false
  private anchorRow = 0
  /** The viewport top the panel last painted: the fallback anchor when the
   *  previous selection cannot be proven in the new retained window. */
  private visibleAnchor = 0
  private pendingSelection: PendingSelection = 'none'
  private epoch: JobOutputSearchEpoch | undefined
  private revealPending = false
  /** The selected hit's identity, carried ACROSS source replacements as a
   *  RENDER geometry plus the PROVEN row eviction since it was captured: a pure
   *  append shifts by zero, a truncated window shifts by exactly the proven
   *  eviction count, and a change with no provable mapping drops the identity so
   *  the fallback re-selects from the visible anchor. A raw coordinate key alone
   *  is NOT enough — an eviction can land a DIFFERENT occurrence on the old
   *  coordinates. */
  private selectedGeometry: MatchGeometry | undefined
  private geometryShift = 0
  /** The rendered width the carried geometry was measured at (0 = none): a
   *  re-wrap has no proven row mapping, so the identity is dropped rather than
   *  compared across widths. */
  private geometryWidth = 0
  private selectedIndexValue = -1

  constructor(text: JobSearchTextSource, visible: (width: number) => boolean, prompt = 'Find Output: ') {
    this.text = text
    this.input = new Input({ prompt })
    this.rowComponent = new JobOutputSearchRow(this, visible)
  }

  /** The mounted SearchRow (a real layout child, never a detached proxy). */
  get row(): Component & Focusable {
    return this.rowComponent
  }

  get mode(): JobOutputSearchMode {
    return this.modeValue
  }

  get query(): string {
    return this.input.getValue()
  }

  /** The raw retained text currently searchable ('' when none is). */
  get sourceText(): string {
    return this.sourceTextValue
  }

  /** The last measured render epoch: the source text it was rendered from, its
   *  width and its rendered rows. The panel uses it as the ONE anchor/selection
   *  baseline — the window that was actually DRAWN, never an undrawn snapshot. */
  renderedEpoch(): { readonly text: string; readonly width: number; readonly lines: readonly string[] } | undefined {
    const epoch = this.epoch
    return epoch === undefined ? undefined : { text: epoch.text, width: epoch.width, lines: epoch.lines }
  }

  /** Replace the ONLY searchable source. Placeholder phases pass
   *  `searchable = false` and are never indexed. `evictedRows` is the INCREMENTAL
   *  proven row eviction between the previous window and this one (`0` for a pure
   *  append, `undefined` when nothing can be proven): it moves the carried
   *  selection geometry with the content instead of trusting old coordinates. */
  setSource(text: string, searchable: boolean, evictedRows: number | undefined = undefined): void {
    const key = searchable ? text : '#placeholder'
    if (key === this.sourceKeyValue && searchable === this.searchableValue) return
    if (evictedRows === undefined) {
      this.selectedGeometry = undefined
      this.geometryShift = 0
      this.geometryWidth = 0
    } else {
      this.geometryShift += evictedRows
    }
    this.sourceKeyValue = key
    this.sourceTextValue = searchable ? text : ''
    this.searchableValue = searchable
    // The recorded RENDER epoch describes the PREVIOUS source: it must never be
    // paired with the new one (a two-snapshot interval would otherwise rebase
    // against the wrong rendered lines), so the next render rebuilds it. The
    // SELECTION identity is NOT dropped: a surviving occurrence stays current
    // across a pure append. A pending reveal SURVIVES the replacement too — it
    // is consumed against the current epoch, so a push landing between the
    // keypress and the paint cannot swallow it.
    this.epoch = undefined
  }

  /** Record the viewport top the panel last painted. */
  setVisibleAnchor(row: number): void {
    this.visibleAnchor = Math.max(0, row)
  }

  /** Open (or re-open) EDIT over the existing query. The caller has already
   *  proved a SearchRow is visible this frame. */
  openFind(scrollTop: number): void {
    this.anchorRow = Math.max(0, scrollTop)
    this.visibleAnchor = this.anchorRow
    this.pendingSelection = 'query'
    this.modeValue = 'edit'
    this.revealPending = false
    this.input.focused = true
  }

  /** `Enter` in EDIT: switch to NAVIGATE and select the nearest provable match
   *  to the viewport anchor captured when Find opened. */
  enterNavigate(): void {
    this.pendingSelection = 'query'
    this.modeValue = 'navigate'
    this.revealPending = true
  }

  /** Leave the search, preserving the query for the next Find and the viewport
   *  for the user. Follow stays paused. */
  exit(): void {
    this.modeValue = 'inactive'
    this.pendingSelection = 'none'
    this.revealPending = false
    this.input.focused = false
  }

  /** Step to the next/previous match (cyclic). Only the NAVIGATE state calls
   *  this. */
  step(direction: -1 | 1): void {
    this.pendingSelection = direction > 0 ? 'next' : 'previous'
    this.modeValue = 'navigate'
    this.revealPending = true
  }

  /** Apply one EDIT key through the real `Input`; whether the query changed. */
  editKey(data: string): boolean {
    const before = this.input.getValue()
    this.input.handleInput(data)
    if (this.input.getValue() === before) return false
    this.pendingSelection = 'query'
    return true
  }

  /** The SearchRow's Input line at the granted width. */
  renderInput(width: number): string {
    return this.input.render(Math.max(1, width))[0] ?? ''
  }

  setInputFocused(focused: boolean): void {
    this.input.focused = focused
  }

  invalidateInput(): void {
    this.input.invalidate()
  }

  /** The `i / N` facts of the current epoch. */
  countsFor(width: number): JobOutputSearchCounts {
    const epoch = this.ensureEpoch(width)
    return { selected: this.selectedIndexValue, total: epoch.matches.length }
  }

  /** The number of retained visual rows this epoch may scroll (0 when the body
   *  is a placeholder or empty — the position never claims Job history). */
  positionTotal(width: number): number {
    return this.searchableValue ? this.ensureEpoch(width).lines.length : 0
  }

  /** The decorated Output rows: the original rendered lines, with every visible
   *  occurrence weak-highlighted and the current one strongly highlighted. Row
   *  count and visible width are never changed. */
  bodyLines(width: number): string[] {
    const lines = this.text.render(width)
    if (this.modeValue === 'inactive' || !this.searchableValue) return lines
    const epoch = this.ensureEpoch(width)
    return highlightSearchLines(lines, {
      matches: epoch.matches,
      selectedIndex: this.selectedIndexValue,
      selectedRow: undefined,
      exact: true,
    })
  }

  /** Consume the ONE pending reveal at the frame-painted boundary. Returns a new
   *  scroll top only when the selected match is outside the viewport. */
  consumeReveal(scrollTop: number, viewportHeight: number, width: number): number | undefined {
    if (!this.revealPending) return undefined
    this.revealPending = false
    if (viewportHeight <= 0) return undefined
    const epoch = this.ensureEpoch(width)
    const selected = epoch.matches[this.selectedIndexValue]
    const first = selected?.segments[0]
    const last = selected?.segments[selected.segments.length - 1]
    if (first === undefined || last === undefined) return undefined
    if (first.row >= scrollTop && last.row <= scrollTop + viewportHeight - 1) return undefined
    return Math.max(0, first.row - Math.floor(viewportHeight / 3))
  }

  private ensureEpoch(width: number): JobOutputSearchEpoch {
    const reusable = this.epoch !== undefined
      && this.epoch.width === width
      && this.epoch.sourceKey === this.sourceKeyValue
    if (reusable && this.pendingSelection === 'none') return this.epoch!
    // A width change RE-WRAPS the rows: the carried geometry has no proven row
    // mapping across widths, so it must never be compared — a different
    // occurrence could occupy the old coordinates. Drop it and let the visible
    // anchor decide.
    if (this.geometryWidth !== 0 && this.geometryWidth !== width) {
      this.selectedGeometry = undefined
      this.geometryShift = 0
      this.geometryWidth = 0
    }
    const lines = reusable ? this.epoch!.lines : this.searchableValue ? this.text.render(width) : []
    const matches = this.index.search(lines, this.query).matches
    // The first match at/after the given row, else the first match (the fork's
    // own search geometry): the SELECTION is always provable from a row that
    // exists in the NEW window, never from an old ordinal or a lost key.
    const nearestIndex = (row: number): number => {
      let low = 0
      let high = matches.length
      while (low < high) {
        const middle = low + Math.floor((high - low) / 2)
        if ((matches[middle]!.segments[0]?.row ?? 0) < row) low = middle + 1
        else high = middle
      }
      return low < matches.length ? low : 0
    }
    let selectedIndex = -1
    if (matches.length > 0) {
      // The carried hit, moved by the PROVEN eviction: the same occurrence in
      // the new window's coordinates. A row that no longer exists (negative) or
      // a geometry another occurrence now occupies cannot match.
      const predicted = this.selectedGeometry === undefined
        ? undefined
        : this.selectedGeometry.map(segment => ({
            row: segment.row - this.geometryShift,
            startCol: segment.startCol,
            endCol: segment.endCol,
          }))
      const exactIndex = predicted === undefined
        ? -1
        : matches.findIndex(match => sameGeometry(match.segments, predicted))
      if (this.pendingSelection === 'query') {
        selectedIndex = nearestIndex(this.anchorRow)
      } else if (this.pendingSelection === 'next') {
        const base = exactIndex >= 0 ? exactIndex : nearestIndex(this.visibleAnchor)
        selectedIndex = (base + 1) % matches.length
      } else if (this.pendingSelection === 'previous') {
        const base = exactIndex >= 0 ? exactIndex : nearestIndex(this.visibleAnchor)
        selectedIndex = (base - 1 + matches.length) % matches.length
      } else {
        // A lost current hit falls back to the nearest PROVABLE match at/after
        // the visible anchor (DECISION-03), never to a stale ordinal.
        selectedIndex = exactIndex >= 0 ? exactIndex : nearestIndex(this.visibleAnchor)
      }
    }
    this.pendingSelection = 'none'
    this.selectedIndexValue = selectedIndex
    this.selectedGeometry = selectedIndex >= 0
      ? matches[selectedIndex]!.segments.map(segment => ({ ...segment }))
      : undefined
    this.geometryShift = 0
    this.geometryWidth = this.selectedGeometry === undefined ? 0 : width
    this.epoch = {
      sourceKey: this.sourceKeyValue,
      text: this.sourceTextValue,
      width,
      lines,
      matches,
    }
    return this.epoch
  }
}
