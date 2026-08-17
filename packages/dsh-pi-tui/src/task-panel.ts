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

import { Input, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import type { Component, Focusable } from '@xmoon76/pi-tui'
import { color, taskStatusColor } from './theme.ts'

/** One row of the task browser (the app layer's PickerItem equivalent). */
export interface TaskPanelItem {
  /** Stable picker value (agent:… / job:…). */
  value: string
  /** Primary label (`bash · pnpm build` / `subagent · research`). */
  label: string
  /** Status word (running / completed / …). */
  status: string
  /** Optional detail line (job detail / has-children note). */
  detail?: string
  /** Optional start timestamp (ms) — the panel derives a live elapsed. */
  startedAt?: number
  /** Group header label (subagents / jobs), rendered as a dim divider. */
  group?: string
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
  /** The filtered view (search query applied). */
  private filtered: TaskPanelItem[] = []
  private selected = 0
  /** Scroll offset into the filtered list. */
  private scroll = 0
  private readonly maxVisible: number
  private readonly options: TaskPanelOptions
  private readonly searchInput = new Input()
  private searchEnabled: boolean
  private readonly onSelect: (value: string) => void
  private readonly onCancel: () => void
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
    this.maxVisible = Math.max(1, maxVisible)
    this.options = options
    this.onSelect = onSelect
    this.onCancel = onCancel
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

  /** Replace the row list; the active search query re-applies and the
   * selection survives when its value is still present. */
  setItems(items: readonly TaskPanelItem[]): void {
    const previousValue = this.filtered[this.selected]?.value
    this.items = [...items]
    this.applyFilter(this.searchInput.getValue() ?? '')
    if (previousValue !== undefined) {
      const index = this.filtered.findIndex(item => item.value === previousValue)
      if (index !== -1) this.selected = index
    }
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
    // The `k`/`j` vim aliases for ↑/↓ apply ONLY when search is OFF: with a
    // search box up, `k`/`j` are ordinary letters a query may contain
    // ("task", "jq") — routing them as navigation would make those queries
    // untruncatable.
    const isNavUp = data === '\x1b[A' || (!this.searchEnabled && data === 'k')
    const isNavDown = data === '\x1b[B' || (!this.searchEnabled && data === 'j')
    const isPage = data === '\x1b[5~' || data === '\x1b[6~'
    if (!isNavUp && !isNavDown && !isPage && data !== '\r' && data !== '\n' && data !== '\x1b' && this.searchEnabled) {
      this.searchInput.handleInput(data)
      this.applyFilter(this.searchInput.getValue() ?? '')
      return
    }
    if (isNavUp) {
      if (this.filtered.length === 0) return
      this.selected = Math.max(0, this.selected - 1)
      this.ensureVisible()
      return
    }
    if (isNavDown) {
      if (this.filtered.length === 0) return
      this.selected = Math.min(this.filtered.length - 1, this.selected + 1)
      this.ensureVisible()
      return
    }
    if (isPage) {
      if (this.filtered.length === 0) return
      if (data === '\x1b[5~') this.selected = Math.max(0, this.selected - this.maxVisible)
      else this.selected = Math.min(this.filtered.length - 1, this.selected + this.maxVisible)
      this.ensureVisible()
      return
    }
    if (data === '\r' || data === '\n') {
      const item = this.filtered[this.selected]
      if (item !== undefined) this.onSelect(item.value)
      return
    }
    if (data === '\x1b') {
      this.onCancel()
    }
  }

  private ensureVisible(): void {
    if (this.selected < this.scroll) this.scroll = this.selected
    else if (this.selected >= this.scroll + this.maxVisible) this.scroll = this.selected - this.maxVisible + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.filtered.length - this.maxVisible)))
  }

  private applyFilter(query: string): void {
    if (query === '') {
      this.filtered = this.items
    } else {
      const needle = query.toLowerCase()
      this.filtered = this.items.filter(item =>
        `${item.value}\n${item.label}\n${item.status}\n${item.detail ?? ''}`.toLowerCase().includes(needle))
    }
    this.selected = 0
    this.scroll = 0
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const lines: string[] = []

    if (this.options.header !== undefined) {
      const counts = this.counts()
      const headerText = counts === '' ? this.options.header : `${this.options.header}  ${counts}`
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
    const running = this.items.filter(item => item.status === 'running' || item.status === 'stopping').length
    const done = this.items.filter(item => item.status === 'completed').length
    const failed = this.items.filter(item => item.status === 'failed' || item.status === 'killed' || item.status === 'timed_out' || item.status === 'lost').length
    const parts: string[] = []
    if (running > 0) parts.push(color.primary(`${running} running`))
    if (done > 0) parts.push(color.textDim(`${done} done`))
    if (failed > 0) parts.push(color.error(`${failed} failed`))
    if (parts.length === 0) parts.push(color.textDim(`${this.items.length} total`))
    return parts.join(' · ')
  }

  private renderRow(item: TaskPanelItem, selected: boolean, width: number): string[] {
    const dot = taskStatusColor(item.status)(DOT)
    const pointer = selected ? color.primary(POINTER) : ' '
    // Left column: pointer + dot + label.
    const leftPrefix = `${pointer} ${dot} `
    const leftWidth = visibleWidth(leftPrefix)
    const label = selected ? color.textStrong(item.label) : color.text(item.label)

    // Right column: status + elapsed, right-aligned. The tail reserves its
    // width on the right; the label wraps to the rest (2-cell gap minimum).
    const statusText = taskStatusColor(item.status)(item.status)
    const elapsedSeconds = item.startedAt === undefined ? undefined : Math.max(0, Math.floor((this.now - item.startedAt) / 1000))
    const elapsedText = elapsedSeconds === undefined ? '' : color.textMuted(formatElapsed(elapsedSeconds))
    const tail = [statusText, elapsedText].filter(part => part !== '').join(' ')
    const tailWidth = visibleWidth(tail)
    const available = width - leftWidth
    const labelBudget = Math.max(1, available - tailWidth - 2)
    const leftFinal = leftPrefix + truncateToWidth(label, labelBudget, '…')
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

  private hint(): string {
    const search = this.searchEnabled ? 'type to filter · ' : ''
    return `${search}↑↓ navigate · enter open · esc close`
  }
}
