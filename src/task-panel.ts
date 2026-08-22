/**
 * TaskBrowserPanel — the visual layer over the task-browser row model
 * (tasks-browser.ts). Rendered as an overlay inside a Frame (the ↓ / Ctrl+J
 * trigger with an empty editor, and /tasks), it replaces the generic
 * SelectList with a dsh-web JobListAction-style list: status dots, aligned
 * kind · label / status · elapsed columns, group headers, live 1s elapsed
 * ticking, and type-to-filter search.
 *
 * The row MODEL stays in tasks-browser.ts (buildTaskRows / taskRowLabel /
 * describeTaskRow / rowGroup) — this component only presents it.
 * @module @xmoon76/dsh-pi-tui/task-panel
 */

import { Input, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import type { Component, Focusable } from '@xmoon76/pi-tui'
import { color, taskStatusColor } from './theme.ts'

/** One row of the task browser (the app layer's PickerItem equivalent). */
export interface TaskPanelItem {
  /** Stable picker value (agent:… / job:…). */
  value: string
  /** Primary label (`bash · pnpm build` / `subagent · research`). */
  label: string
  /** An always-visible TAIL appended after the label (`continuable` /
   * `one-shot`): truncation applies to the label only, so a narrow screen
   * or a long label can never silently cut the mode off (the viewer's
   * interactivity must be readable before Enter). */
  suffix?: string
  /** Status word (running / completed / …). */
  status: string
  /** Optional detail line (job detail / has-children note). */
  detail?: string
  /** Optional start timestamp (ms) — the panel derives a live elapsed. */
  startedAt?: number
  /** Group header label (subagents / jobs), rendered as a dim divider. */
  group?: string
  /** The row's type for the Tab filter: `subagent` or the job kind
   * (bash / pwsh / …). Absent rows never match a type filter and only
   * appear under All. */
  type?: string
}

/** Options for {@link TaskBrowserPanel}. */
export interface TaskPanelOptions {
  /** Header line (title + live counts). */
  header?: string
  /** Rendered when the (filtered) list is empty. */
  noMatchText?: string
  /** Show a search input; typing filters rows by value/label/status/detail. */
  enableSearch?: boolean
  /** Pre-fill the search input. */
  initialQuery?: string
  /** Row-level action: `i` on a selected row while the search box is
   * closed (a subagent interrupt; `i` stays a search letter when the box
   * is open, same rule as the `k`/`j` navigation aliases). */
  onAction?: (value: string, action: 'interrupt') => void
}

/**
 * Render the `status · elapsed` tail: elapsed is humanized as `2s` / `1m5s` /
 * `1h2m` (dsh-web duration parity), omitted when absent.
 */
export function formatElapsed(elapsed: number | undefined): string {
  if (elapsed === undefined || !Number.isFinite(elapsed)) return ''
  const total = Math.max(0, Math.floor(elapsed))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  if (hours > 0) return `${hours}h${minutes}m`
  if (minutes > 0) return `${minutes}m${seconds}s`
  return `${seconds}s`
}

const POINTER = '→'
const DOT = '●'

/**
 * The task browser surface: a searchable, live-updating list of task rows
 * with status dots and aligned columns. Owns its own scroll window so the
 * list can grow beyond the overlay height.
 */
export class TaskBrowserPanel implements Component, Focusable {
  private items: TaskPanelItem[] = []
  /** The filtered view (search query + type filter applied). */
  private filtered: TaskPanelItem[] = []
  private selected = 0
  /** Scroll offset into the filtered list. */
  private scroll = 0
  /** The active type filter (null = All). */
  private activeType: string | null = null
  /** Distinct row types in first-appearance order (the Tab cycle). */
  private typeOrder: string[] = []
  /** Whether the user moved the selection since the panel opened (nav
   * keys or search typing). Until then, an async setItems enrichment may
   * re-focus the list head — the plan's "preferred initial selection". */
  private selectionTouched = false
  private readonly maxVisible: number
  private readonly options: TaskPanelOptions
  private readonly searchInput = new Input()
  private searchEnabled: boolean
  private readonly onSelect: (value: string) => void
  private readonly onCancel: () => void
  private readonly onAction: ((value: string, action: 'interrupt') => void) | undefined
  /** Live tick: bumped every second while a running row is visible. */
  private now = Date.now()
  private tickTimer: NodeJS.Timeout | undefined
  /** Latched by dispose(): an in-flight tick callback must not render. */
  private disposed = false
  private readonly requestRender: () => void
  private _focused = false

  constructor(
    items: readonly TaskPanelItem[],
    maxVisible: number,
    options: TaskPanelOptions,
    onSelect: (value: string) => void,
    onCancel: () => void,
    requestRender: () => void,
  ) {
    this.items = [...items]
    this.filtered = [...items]
    this.rebuildTypeCycle()
    this.maxVisible = Math.max(1, maxVisible)
    this.options = options
    this.onSelect = onSelect
    this.onCancel = onCancel
    this.onAction = options.onAction
    this.requestRender = requestRender
    this.searchEnabled = options.enableSearch ?? false
    this.searchInput.onEscape = () => this.onCancel()
    this.searchInput.onSubmit = (value) => {
      const item = this.filtered[this.selected]
      if (item !== undefined) this.onSelect(item.value)
    }
    const initial = options.initialQuery ?? ''
    if (initial !== '') {
      this.searchInput.setValue(initial)
      this.applyFilter(initial)
    }
    this.startTick()
  }

  /** Replace the row list; the active search query + type filter re-apply.
   * A selection the USER moved survives when its value is still present.
   * An untouched selection follows the fresh list's head on the FIRST
   * enrichment — the /tasks async-merge race: the browser opens on the
   * jobs half, the subagent catalog lands later, and the cursor must land
   * on the preferred row (the enriched list is already sorted running
   * subagents first, so its head IS first-running-subagent ?? first
   * running job), not stay stuck on the first pre-enrichment job. */
  setItems(items: readonly TaskPanelItem[]): void {
    const previousValue = this.filtered[this.selected]?.value
    this.items = [...items]
    this.rebuildTypeCycle()
    if (this.activeType !== null && !this.typeOrder.includes(this.activeType)) {
      // The filtered type vanished from the row set: fall back to All
      // instead of showing a permanently empty list.
      this.activeType = null
    }
    this.applyFilter(this.searchInput.getValue() ?? '')
    if (this.selectionTouched) {
      if (previousValue !== undefined) {
        const index = this.filtered.findIndex(item => item.value === previousValue)
        if (index !== -1) this.selected = index
      }
    }
  }

  /** Rebuild the Tab type cycle from the current rows (first-appearance
   * order, never derived from label strings). */
  private rebuildTypeCycle(): void {
    const seen: string[] = []
    for (const item of this.items) {
      if (item.type !== undefined && !seen.includes(item.type)) seen.push(item.type)
    }
    this.typeOrder = seen
  }

  /** Tab: cycle the type filter All → subagent → bash → pwsh → … → All. */
  private cycleType(): void {
    const order = this.typeOrder
    if (order.length === 0) return
    const index = this.activeType === null ? -1 : order.indexOf(this.activeType)
    if (index === -1) {
      // All → the first type.
      this.activeType = order[0]!
    } else if (index + 1 >= order.length) {
      // Last type → back to All.
      this.activeType = null
    } else {
      this.activeType = order[index + 1]!
    }
    // Cycling the type filter is a USER interaction with the list: a later
    // async enrichment must not re-focus the head over the user's scope
    // (round-1 review finding).
    this.selectionTouched = true
    this.applyFilter(this.searchInput.getValue() ?? '')
  }

  /** The current search query. */
  getFilter(): string {
    return this.searchInput.getValue() ?? ''
  }

  /** The number of rows currently visible (after filtering). */
  get filteredCount(): number {
    return this.filtered.length
  }

  private startTick(): void {
    // The 1s elapsed tick only matters while a live row is visible (a
    // startedAt timestamp whose number is moving); the interval is cheap
    // and the render is a no-op change when nothing moved. unref() so the
    // timer never keeps the process alive (tests, /exit).
    this.tickTimer = setInterval(() => {
      // A callback already past this point when dispose() runs must not
      // request a render for a dead panel.
      if (this.disposed) return
      const hasLive = this.items.some(item =>
        item.startedAt !== undefined && (item.status === 'running' || item.status === 'stopping'))
      if (!hasLive) return
      this.now = Date.now()
      this.requestRender()
    }, 1000)
    this.tickTimer.unref()
  }

  /** Stop the tick (the overlay is closing). */
  dispose(): void {
    this.disposed = true
    if (this.tickTimer !== undefined) clearInterval(this.tickTimer)
    this.tickTimer = undefined
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.searchInput.focused = value
  }

  invalidate(): void {
    this.searchInput.invalidate()
  }

  handleInput(data: string): void {
    // Navigation keys always move the list; Enter confirms; Esc cancels.
    // Every OTHER key (printable, backspace, ctrl+w/u, cursor-left/right
    // inside the query, …) goes to the search Input while search is on —
    // the SelectList pattern: a filter box must be editable, not just
    // typeable.
    //
    // All key matches go through matchesKey (never raw sequence compares):
    // it recognizes legacy AND Kitty CSI-u / modifyOtherKeys encodings, so
    // terminals that report CSI-u (zellij + Kitty-protocol, Windows
    // Terminal, WezTerm, kitty…) keep the panel navigable — the raw
    // compares ('\x1b[A' etc.) silently dropped every arrow/page key there.
    //
    // The `k`/`j` vim aliases for ↑/↓ apply ONLY when search is OFF: with a
    // search box up, `k`/`j` are ordinary letters a query may contain
    // ("task", "jq") — routing them as navigation would make those queries
    // untruncatable.
    const isNavUp = matchesKey(data, 'up') || (!this.searchEnabled && data === 'k')
    const isNavDown = matchesKey(data, 'down') || (!this.searchEnabled && data === 'j')
    const isPage = matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')
    // Row-level interrupt (`i`): fires while the search box is CLOSED, or
    // while it is open but EMPTY and the selection sits on a subagent row
    // (`agent:` value). An empty query means no filtering is in progress —
    // `i` on a subagent row is the interrupt intent, not a query letter.
    // With a non-empty query (or a job row selected) `i` stays a query
    // character, exactly like `k`/`j` while search is on.
    if (data === 'i' && this.onAction !== undefined && !this.searchEnabled) {
      const item = this.filtered[this.selected]
      if (item !== undefined) this.onAction(item.value, 'interrupt')
      return
    }
    if (
      data === 'i' && this.onAction !== undefined && this.searchEnabled
      && (this.searchInput.getValue() ?? '') === ''
    ) {
      const item = this.filtered[this.selected]
      if (item !== undefined && item.value.startsWith('agent:')) {
        this.onAction(item.value, 'interrupt')
        return
      }
    }
    // Tab cycles the type filter (All → subagent → bash → pwsh → …).
    // Consumed before the search input so a query can never contain a tab.
    if (matchesKey(data, 'tab')) {
      this.cycleType()
      return
    }
    if (!isNavUp && !isNavDown && !isPage && !matchesKey(data, 'enter') && !matchesKey(data, 'escape') && this.searchEnabled) {
      // Typing a search query is a user interaction with the list: a later
      // enrichment must not re-focus the head over the user's filter.
      this.selectionTouched = true
      this.searchInput.handleInput(data)
      this.applyFilter(this.searchInput.getValue() ?? '')
      return
    }
    if (isNavUp) {
      if (this.filtered.length === 0) return
      this.selectionTouched = true
      this.selected = Math.max(0, this.selected - 1)
      this.ensureVisible()
      return
    }
    if (isNavDown) {
      if (this.filtered.length === 0) return
      this.selectionTouched = true
      this.selected = Math.min(this.filtered.length - 1, this.selected + 1)
      this.ensureVisible()
      return
    }
    if (isPage) {
      if (this.filtered.length === 0) return
      this.selectionTouched = true
      if (matchesKey(data, 'pageUp')) this.selected = Math.max(0, this.selected - this.maxVisible)
      else this.selected = Math.min(this.filtered.length - 1, this.selected + this.maxVisible)
      this.ensureVisible()
      return
    }
    if (matchesKey(data, 'enter')) {
      const item = this.filtered[this.selected]
      if (item !== undefined) this.onSelect(item.value)
      return
    }
    if (matchesKey(data, 'escape')) {
      this.onCancel()
    }
  }

  private ensureVisible(): void {
    if (this.selected < this.scroll) this.scroll = this.selected
    else if (this.selected >= this.scroll + this.maxVisible) this.scroll = this.selected - this.maxVisible + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.filtered.length - this.maxVisible)))
  }

  private applyFilter(query: string): void {
    const typeActive = this.activeType !== null
    if (query === '' && !typeActive) {
      this.filtered = this.items
    } else {
      const needle = query.toLowerCase()
      this.filtered = this.items.filter(item =>
        (!typeActive || item.type === this.activeType)
        && (query === '' || `${item.value}\n${item.label}\n${item.suffix ?? ''}\n${item.status}\n${item.detail ?? ''}\n${item.group ?? ''}`.toLowerCase().includes(needle)))
    }
    this.selected = 0
    this.scroll = 0
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const lines: string[] = []

    if (this.options.header !== undefined) {
      const counts = this.counts()
      // The active type filter shows as a chip so a type-filtered list
      // never looks like a broken search ("where did the jobs go?").
      const chip = this.activeType === null ? '' : `  [${this.activeType}]`
      const headerText = counts === '' ? `${this.options.header}${chip}` : `${this.options.header}${chip}  ${counts}`
      lines.push(color.textStrong(truncateToWidth(headerText, safeWidth, '…')))
      lines.push('')
    }

    if (this.searchEnabled) {
      const searchLine = this.searchInput.render(Math.max(1, safeWidth - 2))[0] ?? ''
      const stripped = searchLine.startsWith('> ') ? searchLine.slice(2) : searchLine
      lines.push(this.searchInput.getValue() === '' ? color.textDim(' search…') : ` ${stripped}`)
      lines.push('')
    }

    if (this.filtered.length === 0) {
      lines.push(color.textDim(this.options.noMatchText ?? 'no active tasks'))
      lines.push('')
      lines.push(color.textMuted(`  ${this.hint()}`))
      return lines
    }

    this.ensureVisible()
    const start = this.scroll
    const end = Math.min(this.filtered.length, start + this.maxVisible)
    let lastGroup: string | undefined
    for (let i = start; i < end; i++) {
      const item = this.filtered[i]
      if (item === undefined) continue
      if (item.group !== lastGroup) {
        if (item.group !== undefined) {
          lines.push(color.textMuted(`── ${item.group} ──`))
        }
        lastGroup = item.group
      }
      lines.push(...this.renderRow(item, i === this.selected, safeWidth))
    }

    // Scroll indicator (position within the filtered list).
    if (this.filtered.length > this.maxVisible) {
      lines.push(color.textMuted(`  ${this.selected + 1}/${this.filtered.length}`))
    }

    lines.push('')
    lines.push(color.textMuted(`  ${this.hint()}`))
    return lines
  }

  private counts(): string {
    // Under a TYPE filter the counts describe the VISIBLE scope (the
    // header chip already names it — counting the hidden rows would
    // mislead); without one the full surface totals stay (search alone
    // keeps the pre-existing behavior, round-1 review finding).
    const scope = this.activeType === null ? this.items : this.filtered
    const running = scope.filter(item => item.status === 'running' || item.status === 'stopping').length
    const done = scope.filter(item => item.status === 'completed').length
    const failed = scope.filter(item => item.status === 'failed' || item.status === 'killed' || item.status === 'timed_out' || item.status === 'lost').length
    const parts: string[] = []
    if (running > 0) parts.push(color.primary(`${running} running`))
    if (done > 0) parts.push(color.textDim(`${done} done`))
    if (failed > 0) parts.push(color.error(`${failed} failed`))
    if (parts.length === 0) parts.push(color.textDim(`${scope.length} total`))
    return parts.join(' · ')
  }

  private renderRow(item: TaskPanelItem, selected: boolean, width: number): string[] {
    const dot = taskStatusColor(item.status)(DOT)
    const pointer = selected ? color.primary(POINTER) : ' '
    // Left column: pointer + dot + label.
    const leftPrefix = `${pointer} ${dot} `
    const leftWidth = visibleWidth(leftPrefix)

    // Right column: status + elapsed, right-aligned. The tail reserves its
    // width on the right; the label wraps to the rest (2-cell gap minimum).
    const statusText = taskStatusColor(item.status)(item.status)
    const elapsedSeconds = item.startedAt === undefined ? undefined : Math.max(0, Math.floor((this.now - item.startedAt) / 1000))
    const elapsedText = elapsedSeconds === undefined ? '' : color.textMuted(formatElapsed(elapsedSeconds))
    const tail = [statusText, elapsedText].filter(part => part !== '').join(' ')
    const tailWidth = visibleWidth(tail)
    const available = width - leftWidth
    const labelBudget = Math.max(1, available - tailWidth - 2)
    const suffix = item.suffix === undefined || item.suffix === '' ? '' : ` · ${item.suffix}`
    const suffixWidth = visibleWidth(suffix)
    if (suffix === '') {
      // No mode suffix: the classic single-column layout (the tail reserves
      // its width; the label truncates to the rest; the whole line is
      // truncated as the final backstop).
      const truncated = truncateToWidth(item.label, labelBudget, '…')
      const leftFinal = leftPrefix + (selected ? color.textStrong(truncated) : color.text(truncated))
      const pad = Math.max(1, available - visibleWidth(leftFinal) - tailWidth)
      const line = leftFinal + ' '.repeat(pad) + tail
      const out = [truncateToWidth(line, width, '…')]
      if (item.detail !== undefined && item.detail !== '') {
        const indent = ' '.repeat(leftWidth)
        const detailLines = wrapTextWithAnsi(color.textDim(item.detail), Math.max(1, width - leftWidth))
        for (const wrapped of detailLines.slice(0, 2)) {
          out.push(truncateToWidth(indent + wrapped, width, '…'))
        }
      }
      return out
    }
    // The mode suffix is a HARD layout contract (plan §4.0): the mode must
    // stay readable on ANY width that physically fits it. The suffix is
    // reserved FIRST; the status tail (the activity dimension — mode and
    // activity are independent, never traded) keeps its full width next;
    // only the LABEL compresses (its truncation budget is whatever the
    // suffix and tail leave). The tail is dropped entirely only when the
    // label is already at zero and the mode would otherwise be cut.
    // The mode suffix is a HARD layout contract (plan §4.0): the mode must
    // stay readable on ANY width that physically fits it. The suffix is
    // reserved FIRST; the status tail (the activity dimension — mode and
    // activity are independent, never traded) keeps its full width next;
    // only the LABEL compresses (its truncation budget is whatever the
    // suffix and tail leave, minus one cell for the pad). The tail is
    // dropped entirely only when the label is already at zero and the
    // mode would otherwise be cut.
    const labelLimit = Math.max(0, available - suffixWidth - tailWidth - 1)
    const truncated = truncateToWidth(item.label, labelLimit, '…')
    const leftFinal = leftPrefix
      + (selected ? color.textStrong(truncated) : color.text(truncated))
      + (selected ? color.textStrong(suffix) : color.text(suffix))
    const leftFinalWidth = visibleWidth(leftFinal)
    const tailPart = tailWidth <= width - leftFinalWidth
      ? tail
      : (labelLimit === 0 && width - leftFinalWidth > 0
          ? truncateToWidth(tail, width - leftFinalWidth, '…')
          : '')
    const pad = Math.max(0, width - leftFinalWidth - visibleWidth(tailPart))
    const line = leftFinal + ' '.repeat(pad) + tailPart
    const out = [truncateToWidth(line, width, '…')]
    if (item.detail !== undefined && item.detail !== '') {
      const indent = ' '.repeat(leftWidth)
      const detailLines = wrapTextWithAnsi(color.textDim(item.detail), Math.max(1, width - leftWidth))
      for (const wrapped of detailLines.slice(0, 2)) {
        out.push(truncateToWidth(indent + wrapped, width, '…'))
      }
    }
    return out
  }

  private hint(): string {
    const search = this.searchEnabled ? 'type to filter · ' : ''
    // Tab cycles the type filter; advertise the verb only when the cycle
    // has at least two entries (All + one type — a single-kind list would
    // advertise a no-op toggle).
    const typeHint = this.typeOrder.length > 1 ? 'tab type · ' : ''
    // The interrupt verbatim shows only while a subagent row is selectable
    // (search off, or an empty query on a subagent row): `i` on a job row
    // is a search letter, so advertising it unconditionally would lie.
    // Without the hint the merged /tasks surface hid its only terminate
    // entry — the old /subagents submenu is gone (ec74c9b).
    const interrupt = this.filtered.some(item => item.value.startsWith('agent:'))
      ? 'i interrupt · '
      : ''
    return `${search}${typeHint}${interrupt}↑↓ navigate · enter open · esc close`
  }
}
