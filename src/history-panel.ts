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
import { HISTORY_SEARCH_LIMIT } from './history-search.ts'
import { HISTORY_SEARCH_DEBOUNCE_MS } from './history-search.ts'

/** Split threshold: at or above this panel width the list and details
 * render side by side (plan §20). */
export const HISTORY_PANEL_SPLIT_WIDTH = 100
/** List share of the width in the split layout (plan §20: 55/45). */
export const HISTORY_PANEL_LIST_RATIO = 0.55
/** Detail budget (rows) in the STACKED layout (plan §20: 6–8). */
export const HISTORY_PANEL_STACKED_DETAIL_ROWS = 7
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

function sameRow(left: HistorySearchResult, right: HistorySearchResult): boolean {
  return left.id === right.id
    && left.content === right.content
    && left.sourceFile === right.sourceFile
    && left.sourceIndex === right.sourceIndex
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
    this.debounceMs = options.debounceMs ?? HISTORY_SEARCH_DEBOUNCE_MS
    this.maxRows = Math.max(8, options.maxRows ?? 24)
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
      limit: HISTORY_SEARCH_LIMIT,
      signal: controller.signal,
    }
    let results: HistorySearchResult[]
    try {
      results = await this.source.search(request)
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
      return
    }
    if (generation !== this.state.generation || controller.signal.aborted) return
    this.state.results = results
    this.state.loading = false
    this.state.selectedIndex = Math.min(this.state.selectedIndex, Math.max(0, results.length - 1))
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const lines: string[] = []
    // Title + scope tabs.
    lines.push(this.renderTitle(safeWidth))
    // Query row.
    lines.push(this.renderSearchRow(safeWidth))
    lines.push('')
    // Body: list (+ detail).
    const split = safeWidth >= HISTORY_PANEL_SPLIT_WIDTH
    this.renderBody(lines, safeWidth, split)
    // Footer.
    lines.push(this.renderFooter(safeWidth))
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

  private renderBody(lines: string[], width: number, split: boolean): void {
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
      this.renderSplit(lines, listWidth, detailWidth)
    } else {
      this.renderStacked(lines, width)
    }
  }

  private renderSplit(lines: string[], listWidth: number, detailWidth: number): void {
    const listLines = this.renderList(listWidth)
    const detailLines = this.renderDetail(detailWidth, this.selected())
    const rowCount = Math.max(listLines.length, detailLines.length)
    for (let row = 0; row < rowCount; row += 1) {
      const left = listLines[row] ?? ''
      const right = detailLines[row] ?? ''
      lines.push(`${left}${' '.repeat(Math.max(1, listWidth - visibleWidth(left)))}│${right}`)
    }
  }

  private renderStacked(lines: string[], width: number): void {
    const listLines = this.renderList(width)
    const detailLines = this.renderDetail(width, this.selected())
    lines.push(...listLines)
    if (detailLines.length > 0) {
      lines.push('')
      lines.push(`─`.repeat(width))
      lines.push(...detailLines)
    }
  }

  private renderList(width: number): string[] {
    const out: string[] = []
    const selected = this.selected()
    for (const result of this.state.results.slice(0, this.maxListRows())) {
      const isSelected = selected !== undefined && sameRow(selected, result)
      const marker = isSelected ? '› ' : '  '
      const age = result.ts === null ? '   ' : formatRelativeAge(result.ts).padStart(3)
      const prefix = `${marker}${age} `
      const label = compactRow(result.content)
      if (this.state.scope === 'all' && result.cwd !== null) {
        const dir = shortCwd(result.cwd).padEnd(14)
        out.push(`${prefix}${truncateToWidth(`${dir} ${label}`, width, '…')}`)
      } else {
        out.push(`${prefix}${truncateToWidth(label, width, '…')}`)
      }
    }
    if (this.state.results.length > this.maxListRows()) {
      out.push(`  (${this.state.results.length} results)`)
    }
    return out
  }

  private maxListRows(): number {
    return Math.max(4, this.maxRows - 8)
  }

  private renderDetail(width: number, result: HistorySearchResult | undefined): string[] {
    if (result === undefined) return []
    const out: string[] = []
    const budget = this.maxRows >= HISTORY_PANEL_SPLIT_WIDTH ? Math.max(6, this.maxRows - 9) : HISTORY_PANEL_STACKED_DETAIL_ROWS
    out.push(truncateToWidth('Details', width, '…'))
    out.push('')
    const contentWidth = Math.max(4, width - 2)
    const wrapped = wrapText(result.content, contentWidth)
    const contentBudget = budget - 4
    const visible = wrapped.slice(0, contentBudget)
    out.push(...visible.map(line => `  ${line}`))
    if (wrapped.length > visible.length) out.push(`  … more`)
    out.push('')
    if (result.cwd !== null) {
      out.push(truncateToWidth(`  Directory: ${result.cwd}`, width, '…'))
    }
    if (result.ts !== null) {
      out.push(`  Time: ${formatHistoryTime(result.ts)}`)
    } else {
      out.push(`  Time: Unknown (legacy history)`)
    }
    if (result.sessionId !== undefined) {
      out.push(truncateToWidth(`  Session: ${result.sessionId}`, width, '…'))
    }
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