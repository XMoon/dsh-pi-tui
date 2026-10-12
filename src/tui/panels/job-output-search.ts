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
  type Component,
  type Focusable,
  type Text,
} from '@xmoon76/pi-tui'
import { highlightSearchLines } from '../components/transcript/search-presentation.ts'
import { color } from '../theme/runtime.ts'

/** The ONE search state machine of the Job Output. */
export type JobOutputSearchMode = 'inactive' | 'edit' | 'navigate'

/** The `i / N` facts of the current epoch (both 0 with no match). */
export interface JobOutputSearchCounts {
  readonly selected: number
  readonly total: number
}

/** One retained-window render epoch: the rendered Output rows and the query's
 *  provable matches inside them, kept only while width + source + query hold. */
interface JobOutputSearchEpoch {
  readonly sourceKey: string
  readonly width: number
  readonly lines: readonly string[]
  readonly matches: readonly AltScreenSearchMatch[]
  readonly selectedIndex: number
  readonly selectedKey: string | undefined
}

/** The UI-local identity of one rendered match (`AltScreenSearchIndex` result).
 *  Not exported by the fork, so it is re-derived here from the same segment
 *  geometry the index exposes. */
const matchKey = (match: AltScreenSearchMatch): string => {
  const first = match.segments[0]
  const last = match.segments[match.segments.length - 1]
  return first && last ? `${first.row}:${first.startCol}:${last.row}:${last.endCol}` : ''
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
export function rebaseRetainedAnchor(input: {
  readonly previousText: string
  readonly nextText: string
  readonly previousRenderedLines: readonly string[]
  readonly nextRenderedLines: readonly string[]
  readonly oldScrollTop: number
}): number {
  const { previousText, nextText, previousRenderedLines, nextRenderedLines, oldScrollTop } = input
  const clamped = Math.max(0, oldScrollTop)
  if (nextText.startsWith(previousText)) return clamped
  const overlap = longestLineOverlap(previousRenderedLines, nextRenderedLines)
  if (overlap <= 0) return clamped
  const evictedRows = previousRenderedLines.length - overlap
  return Math.max(0, clamped - evictedRows)
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
  private readonly text: Text
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

  constructor(text: Text, visible: (width: number) => boolean) {
    this.text = text
    this.input = new Input({ prompt: 'Find Output: ' })
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

  /** The rendered width of the last measured epoch (undefined before the first
   *  Output render). The retention rebase reuses it to compare rendered rows. */
  get renderedWidth(): number | undefined {
    return this.epoch?.width
  }

  /** The rendered rows of the last measured epoch. */
  get renderedLines(): readonly string[] | undefined {
    return this.epoch?.lines
  }

  /** Replace the ONLY searchable source. Placeholder phases pass
   *  `searchable = false` and are never indexed. */
  setSource(text: string, searchable: boolean): void {
    const key = searchable ? text : '#placeholder'
    if (key === this.sourceKeyValue && searchable === this.searchableValue) return
    this.sourceKeyValue = key
    this.sourceTextValue = searchable ? text : ''
    this.searchableValue = searchable
    // The recorded epoch describes the PREVIOUS source: it must never be paired
    // with the new one (a two-snapshot interval would otherwise rebase against
    // the wrong rendered lines). The next render rebuilds it. A pending reveal
    // SURVIVES the replacement: it is consumed against the current epoch, so a
    // push landing between the keypress and the paint cannot swallow it.
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
    return { selected: epoch.selectedIndex, total: epoch.matches.length }
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
      selectedIndex: epoch.selectedIndex,
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
    const selected = epoch.matches[epoch.selectedIndex]
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
      const exactIndex = this.epoch?.selectedKey === undefined
        ? -1
        : matches.findIndex(match => matchKey(match) === this.epoch!.selectedKey)
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
    this.epoch = {
      sourceKey: this.sourceKeyValue,
      width,
      lines,
      matches,
      selectedIndex,
      selectedKey: selectedIndex >= 0 ? matchKey(matches[selectedIndex]!) : undefined,
    }
    return this.epoch
  }
}
