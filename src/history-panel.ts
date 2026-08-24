/**
 * Ctrl+R input-history search panel — a modal surface that owns its query
 * input, its scope tabs, the list, the detail pane and the footer (plan §18).
 *
 * Anatomy (one `render(width)` call decides the layout — plan §20):
 * - title line (` Input History `) + scope tabs
 *   (`[ Current directory ]` / ` All directories `);
 * - search row: the panel's OWN query `Input` (plan §19 — no SelectList
 *   internal search, so the query state is never duplicated);
 * - list + detail: wide (width >= 100) side-by-side (55/45 split);
 *   narrow: stacked, with the detail capped at 6–8 rows (a huge prompt can
 *   never fill the terminal);
 * - footer: `type filter · ↑↓ select · Enter use · Tab scope · Esc cancel`.
 *
 * State machine (plan §24): closed → open(current, query="") → searching
 * (debounced) → ready → accepted → closed. Esc = cancel (the editor draft
 * is untouched — the panel never previews into it); Enter = accept (the
 * selected content goes to the editor through the app's `setEditorText`,
 * the panel closes, the editor regains focus — NEVER a submit, plan §33);
 * Tab = scope toggle with the query preserved; Ctrl+C = cancel (plan §35).
 *
 * Async safety (plan §14/§15): every refresh aborts the previous search,
 * bumps a generation counter, and only a result whose generation is STILL
 * current is committed — a stale response can never overwrite a fresher
 * query. The debounce is 75ms (local filesystem, plan §15).
 * @module @xmoon76/dsh-pi-tui/history-panel
 */

import { matchesKey } from '@xmoon76/pi-tui'
import { Input } from '@xmoon76/pi-tui'
import type { Component, Focusable } from '@xmoon76/pi-tui'
import { truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { HistorySearchResult, HistorySearchSource, HistoryScope } from './history-search.ts'
import { HISTORY_SEARCH_RESULT_LIMIT } from './history-search.ts'
import { HISTORY_SEARCH_DEBOUNCE_MS } from './history-search.ts'

/** Split threshold: at or above this panel width the list and details
 * render side by side (plan §20). */
export const HISTORY_PANEL_SPLIT_WIDTH = 100
/** List share of the width in the split layout (plan §20: 55/45). */
export const HISTORY_PANEL_LIST_RATIO = 0.55
/** Detail budget (rows) in the STACKED layout (plan §20: 6–8). */
export const HISTORY_PANEL_STACKED_DETAIL_ROWS = 7
/** Fixed chrome rows of the panel render: title, search, blank, footer. */
export const HISTORY_PANEL_CHROME_ROWS = 4
/** The footer hint (plan §59 — `Enter use`, not `Enter select`). */
export const HISTORY_PANEL_FOOTER = 'type filter · ↑↓ select · Enter use · Tab scope · Esc cancel'

/** Panel constructor options. */
export interface HistoryPanelOptions {
  /** The injected search source (the runner wires the file-backed one). */
  source: HistorySearchSource
  /** The working directory for the `current` scope. */
  cwd: string
  /** Accept handler: receives the selected record's content. */
  onAccept: (content: string) => void
  /** Cancel handler (Esc/Ctrl+C). */
  onClose: () => void
  /**
   * Fired whenever the panel commits new results (or an error/empty
   * state): the HOST repaints the overlay — an async search completing
   * without any further keypress must still paint its rows.
   */
  onResultsChanged?: () => void
  /** Optional debounce override (defaults to {@link HISTORY_SEARCH_DEBOUNCE_MS}). */
  debounceMs?: number
  /** Pre-fill the query when the panel opens. */
  initialQuery?: string
  /** The total vertical budget the panel may use (default 24). */
  maxRows?: number
}

interface HistoryPanelState {
  scope: HistoryScope
  query: string
  results: HistorySearchResult[]
  selectedIndex: number
  loading: boolean
  error?: string
  generation: number
}

/** One list `SelectItem` for the history rows. */
function historyToSelectItem(result: HistorySearchResult, scope: HistoryScope): { value: string; label: string } {
  const prefix = scope === 'all' && result.cwd !== null ? `${shortCwd(result.cwd)}  ` : ''
  return { value: result.id, label: `${prefix}${compactRow(result.content)}` }
}

/** The shortest distinctive cwd suffix (parent + name). */
function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(part => part !== '')
  return parts.length >= 2 ? parts.slice(-2).join('/') : cwd
}

/** The list row label: the first line of the content, compacted. */
function compactRow(content: string): string {
  const first = content.split('\n')[0] ?? ''
  return first.length > 60 ? `${first.slice(0, 59)}…` : first
}

/** The detail Time value for a row: never a fabricated timestamp. */
export function formatHistoryTime(ts: number): string {
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** The relative age for a row (`12m`, `38m`, `2h`, `3d`), newest-look. */
export function formatRelativeAge(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts)
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo`
  return `${Math.floor(months / 12)}y`
}

/**
 * The Ctrl+R search panel. Mounted as a capturing overlay component:
 * while it is up it owns Tab (scope), Enter (accept), Esc/Ctrl+C (cancel),
 * ↑/↓/PgUp/PgDn (list) and the query input.
 */
export class HistoryPanel implements Component, Focusable {
  private readonly state: HistoryPanelState = {
    scope: 'current',
    query: '',
    results: [],
    selectedIndex: 0,
    loading: false,
    generation: 0,
  }
  private readonly input: Input
  private readonly source: HistorySearchSource
  private readonly cwd: string
  private readonly onAccept: (content: string) => void
  private readonly onClose: () => void
  private readonly onResultsChanged: (() => void) | undefined
  private readonly debounceMs: number
  private readonly maxRows: number
  private _focused = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined

  constructor(options: HistoryPanelOptions) {
    this.source = options.source
    this.cwd = options.cwd
    this.onAccept = options.onAccept
    this.onClose = options.onClose
    this.onResultsChanged = options.onResultsChanged
    this.debounceMs = options.debounceMs ?? HISTORY_SEARCH_DEBOUNCE_MS
    // NO unconditional floor: the host derives maxRows from the real
    // overlay height (maxHeight minus the Frame border), so a tiny
    // terminal gets a tiny panel — a floor here would push the framed
    // output past the overlay and clip the footer.
    this.maxRows = options.maxRows ?? 24
    this.input = new Input()
    this.state.query = options.initialQuery ?? ''
    this.input.setValue(this.state.query)
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.input.focused = value
  }

  invalidate(): void {
    this.input.invalidate()
  }

  /** Whether the panel is showing the empty (no-matches) state. */
  hasResults(): boolean {
    return !this.state.loading && this.state.results.length > 0
  }

  /** The selected result, or undefined when the list is empty. */
  selected(): HistorySearchResult | undefined {
    return this.state.results[this.state.selectedIndex]
  }

  handleInput(data: string): void {
    // Tab: scope toggle — the query SURVIVES (plan §31).
    if (matchesKey(data, 'tab')) {
      this.toggleScope()
      return
    }
    // Navigation: ↑/↓/PgUp/PgDn select within the list.
    if (matchesKey(data, 'up') || matchesKey(data, 'down')
      || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
      this.moveSelection(data)
      return
    }
    // Enter: accept the selected row into the editor (NO submit).
    if (matchesKey(data, 'enter') || matchesKey(data, 'ctrl+j')) {
      this.acceptSelected()
      return
    }
    // Esc / Ctrl+C: cancel — the editor draft is untouched.
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
      this.cancel()
      return
    }
    // The query input owns every other key (typing, backspace, arrows
    // inside the query, Home/End, delete...).
    this.input.handleInput(data)
    const next = this.input.getValue()
    if (next !== this.state.query) {
      this.state.query = next
      this.state.selectedIndex = 0
      this.scheduleSearch()
    }
  }

  /** Open-time init: run the initial (empty-query) search immediately. */
  start(): void {
    void this.refresh() // allowlist: refresh() never rejects (errors land in the panel state)
  }

  /** Cancel and forget (called by the host on close). */
  dispose(): void {
    // Invalidate the generation: a source that ignores the abort and
    // settles LATE (resolve OR reject) must never commit into the closed
    // panel — the refresh's generation check is the fence for both paths.
    this.state.generation += 1
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
    this.controller?.abort()
    this.controller = undefined
  }

  private toggleScope(): void {
    this.state.scope = this.state.scope === 'current' ? 'all' : 'current'
    this.state.selectedIndex = 0
    this.scheduleSearch()
  }

  private moveSelection(data: string): void {
    const count = this.state.results.length
    if (count === 0) return
    const index = this.state.selectedIndex
    if (matchesKey(data, 'up')) this.state.selectedIndex = index === 0 ? count - 1 : index - 1
    else if (matchesKey(data, 'down')) this.state.selectedIndex = index === count - 1 ? 0 : index + 1
    else if (matchesKey(data, 'pageUp')) this.state.selectedIndex = Math.max(0, index - 6)
    else this.state.selectedIndex = Math.min(count - 1, index + 6)
  }

  private acceptSelected(): void {
    const selected = this.selected()
    if (selected === undefined) return // zero-match Enter: a documented no-op
    // Cancel any in-flight search (the search belongs to the panel session).
    this.dispose()
    this.onAccept(selected.content)
  }

  private cancel(): void {
    this.dispose()
    this.onClose()
  }

  private scheduleSearch(): void {
    // The query/scope changed NOW: invalidate the in-flight generation and
    // abort its request IMMEDIATELY — a response that lands during the
    // debounce window must never commit results for the PREVIOUS query
    // (plan §14; the refresh's generation check is the second fence).
    this.state.generation += 1
    this.controller?.abort()
    this.controller = undefined
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh() // allowlist: refresh() never rejects (errors land in the panel state)
    }, this.debounceMs)
    // The first keystroke shows loading immediately (the debounce only
    // delays the file reads, not the state flip).
    if (!this.state.loading) {
      this.state.loading = true
      this.onResultsChanged?.()
    }
  }

  /** Run one search with the CURRENT query/scope; commit only when this
   * generation is still live (stale results are dropped, plan §14). */
  private async refresh(): Promise<void> {
    const generation = ++this.state.generation
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.state.loading = true
    this.state.error = undefined
    const request = {
      scope: this.state.scope,
      cwd: this.cwd,
      query: this.state.query,
      limit: HISTORY_SEARCH_RESULT_LIMIT,
      signal: controller.signal,
    }
    let results: HistorySearchResult[]
    try {
      // The source returns a bounded page (results + an optional
      // continuation for older history). The panel renders only the page's
      // results today; "Search older" is a later UI phase on that contract.
      const page = await this.source.search(request)
      results = page.results
    } catch (error) {
      // Second fence for a late failure: the generation was invalidated by
      // scheduleSearch/dispose, and the abort was requested — an
      // abort-ignoring source must not paint "History unavailable" into a
      // panel that no longer owns this query.
      if (generation !== this.state.generation || controller.signal.aborted) return
      this.state.loading = false
      this.state.error = 'History unavailable'
      this.state.results = []
      this.state.selectedIndex = 0
      this.onResultsChanged?.()
      return
    }
    if (generation !== this.state.generation || controller.signal.aborted) return
    this.state.results = results
    this.state.loading = false
    this.state.selectedIndex = Math.min(this.state.selectedIndex, Math.max(0, results.length - 1))
    this.onResultsChanged?.()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const lines: string[] = []
    // Title + scope tabs.
    lines.push(this.renderTitle(safeWidth))
    if (this.maxRows <= 1) return lines
    // Query row.
    lines.push(this.renderSearchRow(safeWidth))
    if (this.maxRows <= 2) return lines
    // Chrome is adaptive on tiny budgets: the blank row yields first, the
    // footer next — the render NEVER exceeds maxRows (plan §51), so a
    // small overlay height cannot clip the panel.
    let chrome = 2 // title + search
    if (this.maxRows >= 5) {
      lines.push('')
      chrome = 3
    }
    const bodyBudget = Math.max(1, this.maxRows - chrome - 1) // -1 footer
    const split = safeWidth >= HISTORY_PANEL_SPLIT_WIDTH
    this.renderBody(lines, safeWidth, split, bodyBudget)
    if (this.maxRows >= 4) lines.push(this.renderFooter(safeWidth))
    return lines
  }

  private renderTitle(width: number): string {
    const current = this.state.scope === 'current'
    const currentTab = current ? '[ Current directory ]' : '  Current directory  '
    const allTab = !current ? '[ All directories ]' : '  All directories  '
    const title = ` History Search `
    const titleWidth = visibleWidth(title)
    const tabs = ` ${currentTab}   ${allTab} `
    const gap = ' '.repeat(Math.max(0, width - titleWidth - visibleWidth(tabs)))
    return `${title}${gap}${tabs}`.slice(0, width)
  }

  private renderSearchRow(width: number): string {
    const label = 'Search: '
    const labelWidth = visibleWidth(label)
    const inputLines = this.input.render(Math.max(1, width - labelWidth))
    const first = inputLines[0] ?? ''
    // Keep the same width for the wrapped remainder.
    return `${label}${first}${' '.repeat(Math.max(0, width - labelWidth - visibleWidth(first)))}`
  }

  private renderBody(lines: string[], width: number, split: boolean, bodyBudget: number): void {
    if (this.state.error !== undefined) {
      lines.push(`  ${this.state.error}`)
      return
    }
    if (this.state.loading && this.state.results.length === 0) {
      lines.push(`  Loading history…`)
      return
    }
    if (this.state.results.length === 0) {
      lines.push(`  ${this.state.query === '' ? 'No history yet' : 'No matching history'}`)
      return
    }
    if (split) {
      const listWidth = Math.max(20, Math.floor(width * HISTORY_PANEL_LIST_RATIO))
      const detailWidth = Math.max(10, width - listWidth - 3)
      this.renderSplit(lines, listWidth, detailWidth, bodyBudget)
    } else {
      this.renderStacked(lines, width, bodyBudget)
    }
  }

  private renderSplit(lines: string[], listWidth: number, detailWidth: number, bodyBudget: number): void {
    const listLines = this.renderList(listWidth, bodyBudget)
    const detailLines = this.renderDetail(detailWidth, this.selected(), bodyBudget)
    if (detailLines.length === 0) {
      // The detail was suppressed (its metadata cannot fit the budget):
      // render the list alone — a stray `│` separator must not appear.
      lines.push(...listLines)
      return
    }
    const rowCount = Math.max(listLines.length, detailLines.length)
    for (let row = 0; row < rowCount; row += 1) {
      const left = listLines[row] ?? ''
      const right = detailLines[row] ?? ''
      lines.push(`${left}${' '.repeat(Math.max(1, listWidth - visibleWidth(left)))}│${right}`)
    }
  }

  private renderStacked(lines: string[], width: number, bodyBudget: number): void {
    // The stacked layout splits the body budget with NO unconditional
    // minimums: the detail is shown ONLY when it can keep its full
    // metadata (header + blank + Directory/Time/Session — 5 rows); below
    // that the space goes entirely to the list. list + divider + detail
    // ALWAYS fits bodyBudget — on an 8-row terminal the detail disappears
    // instead of clipping the footer or slicing its metadata.
    const minDetailRows = 2 + 3 // 'Details' + blank + up to 3 metadata rows
    const dividerRows = 2 // blank + ─ divider (only when the detail renders)
    const reservedForList = 1
    const availableForDetail = Math.max(0, bodyBudget - dividerRows - reservedForList)
    const detailBudget = availableForDetail >= minDetailRows
      ? Math.min(HISTORY_PANEL_STACKED_DETAIL_ROWS, availableForDetail)
      : 0
    const divider = detailBudget > 0 ? dividerRows : 0
    const listBudget = Math.max(1, bodyBudget - divider - detailBudget)
    const listLines = this.renderList(width, listBudget)
    const detailLines = this.renderDetail(width, this.selected(), detailBudget)
    lines.push(...listLines)
    if (detailLines.length > 0) {
      lines.push('')
      lines.push(`─`.repeat(width))
      lines.push(...detailLines)
    }
  }

  /**
   * Render the list rows within a budget. The visible window FOLLOWS the
   * selection (plan §21: SelectList's viewport algorithm — the selected
   * row stays on screen while the cursor walks past the window), instead
   * of always slicing the head: with 100 results and a 16-row window,
   * ↓ to row 17 must scroll the window, never hide the › marker.
   * Every rendered line is truncated to `width` INCLUDING the row prefix
   * (`› age dir label`), so a split layout never overflows the column.
   */
  private renderList(width: number, budget: number): string[] {
    const out: string[] = []
    const count = this.state.results.length
    if (count === 0 || budget <= 0) return out
    // The "(N results)" counter row (when it appears) occupies one row of
    // the budget too — the list NEVER exceeds `budget` rows, even at
    // budget 1 (the counter wins that row rather than overflowing).
    let visible = Math.min(count, budget)
    const needsCounter = count > visible
    if (needsCounter && visible + 1 > budget) visible = Math.max(0, visible - 1)
    // Viewport: center the selection, clamp to the ends (SelectList's
    // algorithm: start = clamp(selected - floor(visible/2), 0, count - visible)).
    const start = Math.max(0, Math.min(this.state.selectedIndex - Math.floor(visible / 2), count - visible))
    const end = start + visible
    for (let index = start; index < end; index += 1) {
      const result = this.state.results[index]
      if (result === undefined) continue
      const isSelected = index === this.state.selectedIndex
      const marker = isSelected ? '› ' : '  '
      const age = result.ts === null ? '   ' : formatRelativeAge(result.ts).padStart(3)
      const prefix = `${marker}${age} `
      const prefixWidth = visibleWidth(prefix)
      const label = compactRow(result.content)
      const labelWidth = Math.max(1, width - prefixWidth)
      let line: string
      if (this.state.scope === 'all' && result.cwd !== null) {
        const dir = shortCwd(result.cwd).padEnd(14)
        const dirWidth = visibleWidth(dir)
        const rest = truncateToWidth(label, Math.max(1, labelWidth - dirWidth), '…')
        line = `${prefix}${truncateToWidth(`${dir} ${rest}`, labelWidth, '…')}`
      } else {
        line = `${prefix}${truncateToWidth(label, labelWidth, '…')}`
      }
      // The full row (prefix + content) must never exceed the column.
      out.push(truncateToWidth(line, width, '…'))
    }
    if (needsCounter) {
      out.push(`  (${count} results)`)
    }
    return out
  }

  /**
   * The detail pane, strictly bounded to `budget` rows (may be 0 — the
   * stacked layout then simply skips it). The METADATA rows (Directory/
   * Time/Session) are reserved first; the wrapped content takes whatever
   * remains, so a small budget truncates content — never the metadata —
   * and the `… more` marker replaces the last content row instead of
   * adding one. The assembly never exceeds `budget` at ANY size.
   */
  private renderDetail(width: number, result: HistorySearchResult | undefined, budget: number): string[] {
    if (result === undefined || budget <= 0) return []
    const meta: string[] = []
    if (result.cwd !== null) {
      meta.push(truncateToWidth(`  Directory: ${result.cwd}`, width, '…'))
    }
    if (result.ts !== null) {
      meta.push(`  Time: ${formatHistoryTime(result.ts)}`)
    } else {
      meta.push(`  Time: Unknown (legacy history)`)
    }
    if (result.sessionId !== undefined) {
      meta.push(truncateToWidth(`  Session: ${result.sessionId}`, width, '…'))
    }
    // The detail renders ONLY when the budget can hold its FULL metadata
    // ('Details' + blank + every metadata row): content takes the
    // remainder, metadata is never truncated. A budget too small for the
    // metadata suppresses the pane entirely (the split layout then shows
    // the list alone; the stacked layout skips the divider too).
    if (budget < 2 + meta.length) return []
    const out: string[] = ['Details']
    let remaining = budget - 1
    if (remaining <= 0) return out
    out.push('')
    remaining -= 1
    // Reserve the metadata + one inter-blank first; content gets the rest.
    const metadataRows = meta.length
    const blankRows = metadataRows > 0 && remaining > metadataRows ? 1 : 0
    const contentRows = Math.max(0, remaining - metadataRows - blankRows)
    const wrapped = wrapText(result.content, Math.max(4, width - 2))
    let shown = wrapped.slice(0, contentRows)
    if (wrapped.length > shown.length && shown.length > 0) {
      shown = shown.slice(0, -1)
      shown.push('  … more')
    }
    out.push(...shown.map(line => truncateToWidth(`  ${line}`, width, '…')))
    if (blankRows > 0 && shown.length > 0) out.push('')
    out.push(...meta)
    return out
  }

  private renderFooter(width: number): string {
    return truncateToWidth(`  ${HISTORY_PANEL_FOOTER}`, width, '…')
  }
}

/** Wrap text to a width without splitting CJK code points. */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = []
  for (const raw of text.split('\n')) {
    let line = ''
    for (const character of raw) {
      const next = line + character
      if (visibleWidth(next) > width && line !== '') {
        lines.push(line)
        line = character
      } else {
        line = next
      }
    }
    lines.push(line)
  }
  return lines
}