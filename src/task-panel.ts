/**
 * Task Center presentation component.
 *
 * TaskBrowserPanel owns only presentation state (scope, search, disclosure,
 * selection and confirmation). Runtime truth is supplied as row-shaped input
 * and is never reordered or mutated here. Quick Tasks and the full Task Center
 * use the same component with different layout/default options.
 *
 * @module @xmoon76/dsh-pi-tui/task-panel
 */

import { Input, matchesKey, truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import type { Component, Focusable } from '@xmoon76/pi-tui'
import { componentKeymap } from './keybindings/component-keymap.ts'
import { color, taskStatusColor } from './theme.ts'
import { SelectedMarquee } from './marquee.ts'
import {
  isTaskItemActive,
  isTaskItemFailure,
  projectTaskItems,
  type TaskPanelItem,
  type TaskScope,
} from './task-presentation.ts'

export type { TaskPanelItem, TaskScope } from './task-presentation.ts'

/** The state carried when Quick Tasks opens the full Task Center. */
export interface TaskBrowserViewState {
  readonly mode: 'quick' | 'full'
  readonly openedFrom: 'quick' | 'command'
  readonly scope: TaskScope
  readonly typeFilter: string | null
  readonly searchMode: boolean
  readonly searchQuery: string
  readonly selectedId: string | null
  readonly expandedIds: ReadonlySet<string>
  readonly collapsedIds: ReadonlySet<string>
}

/** Options for {@link TaskBrowserPanel}. */
export interface TaskPanelOptions {
  /** Header title. The panel adds scope/type/count chips in explicit mode. */
  header?: string
  /** Rendered when the (filtered) list is empty. */
  noMatchText?: string
  /** Whether the `/` search action is available. */
  enableSearch?: boolean
  /** Pre-fill the search input. A non-empty value enters search mode. */
  initialQuery?: string
  /** Preserve whether the search editor was active across Quick/Full. */
  initialSearchMode?: boolean
  /**
   * Legacy row-level action: `i` on a selected row while search is closed
   * (mode-less direct callers only). The signature is deliberately UNCHANGED
   * so a strictly-typed old embedder keeps compiling. The production Task
   * Center never passes this — it uses {@link onStop}.
   */
  onAction?: (value: string, action: 'interrupt') => void
  /** Confirmed Stop: emitted only after the S → Y confirmation chord. */
  onStop?: (value: string) => void
  /**
   * Called ONCE per attention row the first time it enters the open
   * viewport (scroll window), with the fresh ids. The runner uses it to
   * acknowledge failures the user has actually seen — including rows
   * scrolled into view AFTER the panel opened (PR review P1/P2).
   */
  onViewportExpose?: (ids: readonly string[]) => void
  /** Re-list the runtime catalog. */
  onRefresh?: () => void
  /** Quick Tasks → full Task Center. */
  onViewFull?: (state: TaskBrowserViewState) => void
  /** Production mode enables explicit navigation/search behavior. */
  mode?: 'quick' | 'full'
  openedFrom?: 'quick' | 'command'
  initialScope?: TaskScope
  initialTypeFilter?: string | null
  initialExpandedIds?: readonly string[]
  initialCollapsedIds?: readonly string[]
  initialSelectedId?: string
  /** Initial preferred row (normally the first running row). */
  initialPreferredValue?: string
  /** Show a loading state until the first refresh commits. */
  loading?: boolean
  /** Cached rows are still usable, but the latest refresh failed. */
  refreshError?: string
  /** Use the long group names in the Task Center; legacy callers keep theirs. */
  groupLabels?: boolean
  /** Test hook: the selected-row marquee's clock. */
  marqueeNow?: () => number
}

/** Render elapsed seconds as `2s`, `1m5s`, or `1h2m`. */
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
const PSEUDO_VIEW_ALL = 'task:view-all'

function displayGroup(group: string | undefined, longLabels: boolean): string | undefined {
  if (!longLabels || group === undefined) return group
  if (group === 'subagents') return 'Subagents / transcripts'
  if (group === 'jobs') return 'Jobs / executions'
  return group
}

function stateGlyph(item: TaskPanelItem): string {
  if (item.status === 'stopping') return '◐'
  if (isTaskItemFailure(item.status)) return '×'
  if (item.status === 'completed') return '○'
  return isTaskItemActive(item) ? DOT : '○'
}

/**
 * The shared Quick/Full Task Center list.
 *
 * When `mode` is omitted the component keeps its historical direct-call
 * behavior (search-on-open and `i` callback) for embedders that have not yet
 * migrated. The application always supplies `mode`, so user-facing behavior
 * uses explicit search mode and confirmed `S` stop actions.
 */
export class TaskBrowserPanel implements Component, Focusable {
  private items: TaskPanelItem[] = []
  private filtered: TaskPanelItem[] = []
  private selected = 0
  private scroll = 0
  private activeType: string | null
  private typeOrder: string[] = []
  private scope: TaskScope
  private readonly mode: 'quick' | 'full'
  private readonly openedFrom: 'quick' | 'command'
  private readonly explicitMode: boolean
  private searchMode: boolean
  private selectionTouched = false
  private readonly expandedIds: Set<string>
  private readonly collapsedIds: Set<string>
  private readonly maxVisible: number
  private readonly options: TaskPanelOptions
  private readonly searchInput = new Input()
  private searchEnabled: boolean
  private readonly onSelect: (value: string) => void
  private readonly onCancel: () => void
  private readonly onAction: ((value: string, action: 'interrupt') => void) | undefined
  private readonly onStop: ((value: string) => void) | undefined
  private readonly onViewportExpose: ((ids: readonly string[]) => void) | undefined
  private readonly exposedAttention = new Set<string>()
  private readonly onRefresh: (() => void) | undefined
  private readonly onViewFull: ((state: TaskBrowserViewState) => void) | undefined
  private now = Date.now()
  private tickTimer: NodeJS.Timeout | undefined
  private disposed = false
  private readonly requestRender: () => void
  private readonly marquee: SelectedMarquee
  private _focused = false
  private pendingStopValue: string | undefined
  private loading: boolean
  private refreshError: string | undefined
  private preferredValue: string | undefined

  constructor(
    items: readonly TaskPanelItem[],
    maxVisible: number,
    options: TaskPanelOptions,
    onSelect: (value: string) => void,
    onCancel: () => void,
    requestRender: () => void,
  ) {
    this.items = [...items]
    this.maxVisible = Math.max(1, maxVisible)
    this.options = options
    this.onSelect = onSelect
    this.onCancel = onCancel
    this.onAction = options.onAction
    this.onStop = options.onStop
    this.onViewportExpose = options.onViewportExpose
    this.onRefresh = options.onRefresh
    this.onViewFull = options.onViewFull
    this.requestRender = requestRender
    this.mode = options.mode ?? 'full'
    this.openedFrom = options.openedFrom ?? 'command'
    this.explicitMode = options.mode !== undefined
    this.searchEnabled = options.enableSearch ?? false
    this.scope = options.initialScope ?? (this.explicitMode && this.mode === 'quick' ? 'active' : this.explicitMode ? 'all' : 'all')
    this.activeType = options.initialTypeFilter ?? null
    this.expandedIds = new Set(options.initialExpandedIds ?? [])
    this.collapsedIds = new Set(options.initialCollapsedIds ?? [])
    this.loading = options.loading ?? false
    this.refreshError = options.refreshError
    this.preferredValue = options.initialPreferredValue ?? options.initialSelectedId
    this.searchMode = options.initialSearchMode ?? (!this.explicitMode || (options.initialQuery ?? '') !== '')
    this.marquee = new SelectedMarquee({
      requestRender: () => this.requestRender(),
      now: options.marqueeNow,
    })
    this.searchInput.onEscape = () => {
      if (this.explicitMode && this.searchMode) {
        this.exitSearchMode()
      } else {
        this.onCancel()
      }
    }
    this.searchInput.onSubmit = () => this.openSelected()
    const initial = options.initialQuery ?? ''
    if (initial !== '') this.searchInput.setValue(initial)
    this.rebuildTypeCycle()
    // A restored type filter that no row satisfies produces a dead view;
    // validate it against the initial row set exactly like setItems does.
    if (this.activeType !== null && !this.typeOrder.includes(this.activeType)) this.activeType = null
    this.reproject(false)
    this.selectPreferred()
    this.startTick()
  }

  /** Replace rows while preserving the selected identity where possible. */
  setItems(items: readonly TaskPanelItem[], preferredValue?: string): void {
    const previousValue = this.filtered[this.selected]?.value
    this.items = [...items]
    this.loading = false
    if (preferredValue !== undefined) this.preferredValue = preferredValue
    this.rebuildTypeCycle()
    if (this.activeType !== null && !this.typeOrder.includes(this.activeType)) this.activeType = null
    this.reproject(false)
    if (this.pendingStopValue !== undefined && !this.canStop(this.items.find(item => item.value === this.pendingStopValue))) {
      this.pendingStopValue = undefined
    }
    if (this.selectionTouched && previousValue !== undefined) {
      const index = this.filtered.findIndex(item => item.value === previousValue)
      if (index !== -1) {
        this.selected = index
        this.ensureVisible()
        return
      }
    }
    if (!this.selectionTouched) this.selectPreferred()
  }

  /** Set the async refresh state without discarding cached rows. */
  setRefreshState(state: 'loading' | 'ready' | 'stale', error?: string): void {
    this.loading = state === 'loading'
    this.refreshError = state === 'stale' ? error ?? 'Refresh failed' : undefined
    if (state === 'ready') this.loading = false
    this.requestRender()
  }

  /** Current rows after scope/type/search/disclosure projection. */
  visibleItems(): readonly TaskPanelItem[] {
    return this.filtered
  }

  /** ONLY the rows the current viewport actually renders (the ack scope:
   * a failure the user has not scrolled to was never "seen"). */
  viewportItems(): readonly TaskPanelItem[] {
    return this.filtered.slice(this.scroll, this.scroll + this.maxVisible)
  }

  /**
   * Report attention rows that entered the open viewport for the first
   * time (deduped per row identity). Runs on every render — scrolling,
   * paging, running-jump and row replacements all re-render — so a
   * failure "scrolled into view" after the panel opened is acknowledged
   * exactly once (the runtime's acknowledge is idempotent anyway).
   */
  private exposeViewport(): void {
    if (this.onViewportExpose === undefined) return
    const fresh: string[] = []
    for (const item of this.viewportItems()) {
      if (item.attention !== true || this.exposedAttention.has(item.value)) continue
      this.exposedAttention.add(item.value)
      fresh.push(item.value)
    }
    if (fresh.length > 0) this.onViewportExpose(fresh)
  }

  /** Current view state used by Quick → Full. */
  getViewState(): TaskBrowserViewState {
    return {
      mode: this.mode,
      openedFrom: this.openedFrom,
      scope: this.scope,
      typeFilter: this.activeType,
      searchMode: this.searchMode,
      searchQuery: this.getFilter(),
      selectedId: this.filtered[this.selected]?.value ?? null,
      expandedIds: new Set(this.expandedIds),
      collapsedIds: new Set(this.collapsedIds),
    }
  }

  getFilter(): string {
    return this.searchInput.getValue() ?? ''
  }

  get filteredCount(): number {
    return this.filtered.length
  }

  private rebuildTypeCycle(): void {
    const seen: string[] = []
    for (const item of this.items) {
      if (item.kind === 'view-full') continue
      if (item.type !== undefined && !seen.includes(item.type)) seen.push(item.type)
    }
    this.typeOrder = seen
  }

  private reproject(resetSelection: boolean): void {
    const query = this.getFilter()
    const projection = projectTaskItems(this.items, {
      scope: this.scope,
      typeFilter: this.activeType,
      query,
      expandedIds: this.expandedIds,
      collapsedIds: this.collapsedIds,
      autoExpandRunning: true,
      includeAttentionInActive: this.mode === 'quick' && !this.items.some(isTaskItemActive),
    })
    this.filtered = [...projection.rows]
    // Quick's pseudo-row is deliberately outside the business projection. It
    // is hidden while refining a search/type filter so it cannot be mistaken
    // for a task match.
    if (this.mode === 'quick' && query === '' && this.activeType === null) {
      // "Open Task Center", not "View all N tasks": the transition keeps
      // the current scope (it is a context-preserving promotion, never a
      // scope reset), and agents/jobs are counted SEPARATELY because a
      // background one-shot legitimately occupies one row in each registry
      // — a summed "task" count would double-count it (PR review).
      const real = this.items.filter(item => item.kind !== 'view-full')
      const agents = real.filter(item => item.source === 'subagent').length
      const jobs = real.filter(item => item.source === 'job').length
      const failures = real.filter(item => item.attention === true || isTaskItemFailure(item.status)).length
      const stats = [`${agents} agent${agents === 1 ? '' : 's'}`, `${jobs} job${jobs === 1 ? '' : 's'}`]
      if (failures > 0) stats.push(`${failures} failed`)
      this.filtered.push({
        value: PSEUDO_VIEW_ALL,
        kind: 'view-full',
        label: `Open Task Center · ${stats.join(' · ')}…`,
        status: 'completed',
        canOpen: true,
      })
    }
    if (resetSelection) {
      this.selected = 0
      this.scroll = 0
      this.marquee.reset()
    } else {
      this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1))
      this.ensureVisible()
    }
  }

  private selectPreferred(): void {
    const target = this.preferredValue
    if (target === undefined) return
    const index = this.filtered.findIndex(item => item.value === target)
    if (index === -1) return
    this.selected = index
    this.ensureVisible()
  }

  private cycleType(): void {
    if (this.typeOrder.length === 0) return
    const index = this.activeType === null ? -1 : this.typeOrder.indexOf(this.activeType)
    this.activeType = index === -1 || index + 1 >= this.typeOrder.length ? (index === -1 ? this.typeOrder[0]! : null) : this.typeOrder[index + 1]!
    this.selectionTouched = true
    this.reproject(true)
  }

  private toggleScope(): void {
    this.scope = this.scope === 'active' ? 'all' : 'active'
    this.selectionTouched = true
    this.reproject(true)
  }

  private enterSearchMode(): void {
    if (!this.searchEnabled || this.searchMode) return
    this.searchMode = true
    this.searchInput.focused = this._focused
    this.selectionTouched = true
    this.requestRender()
  }

  private exitSearchMode(): void {
    if (!this.searchMode) return
    this.searchMode = false
    this.searchInput.focused = false
    this.requestRender()
  }

  private move(delta: number): void {
    if (this.filtered.length === 0) return
    this.pendingStopValue = undefined
    this.selectionTouched = true
    this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + delta))
    this.ensureVisible()
  }

  private page(direction: -1 | 1): void {
    if (this.filtered.length === 0) return
    this.pendingStopValue = undefined
    this.selectionTouched = true
    this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + direction * this.maxVisible))
    this.ensureVisible()
  }

  private selectedItem(): TaskPanelItem | undefined {
    return this.filtered[this.selected]
  }

  private canStop(item: TaskPanelItem | undefined): boolean {
    if (item === undefined || item.kind === 'view-full') return false
    return item.canStop ?? item.interruptible ?? false
  }

  private openSelected(): void {
    const item = this.selectedItem()
    if (item === undefined) return
    if (item.kind === 'view-full') {
      this.onViewFull?.(this.getViewState())
      return
    }
    this.onSelect(item.value)
  }

  private requestStop(): void {
    const item = this.selectedItem()
    if (!this.canStop(item)) return
    this.pendingStopValue = item!.value
    this.requestRender()
  }

  private confirmStop(): void {
    const value = this.pendingStopValue
    this.pendingStopValue = undefined
    if (value === undefined) return
    const item = this.items.find(candidate => candidate.value === value)
    if (!this.canStop(item)) return
    this.onStop?.(value)
  }

  private treeExpand(): void {
    const item = this.selectedItem()
    if (item === undefined || item.kind === 'view-full' || !item.hasChildren) return
    if (!item.expanded) {
      this.collapsedIds.delete(item.value)
      this.expandedIds.add(item.value)
      this.reproject(false)
      return
    }
    const child = this.filtered.find(candidate => candidate.parentId === item.value)
    if (child !== undefined) {
      this.selectionTouched = true
      this.selected = this.filtered.indexOf(child)
      this.ensureVisible()
    }
  }

  private treeCollapse(): void {
    const item = this.selectedItem()
    if (item === undefined || item.kind === 'view-full') return
    if (item.expanded) {
      this.expandedIds.delete(item.value)
      this.collapsedIds.add(item.value)
      this.reproject(false)
      return
    }
    const parentId = item.parentId
    if (parentId === undefined) return
    const parentIndex = this.filtered.findIndex(candidate => candidate.value === parentId)
    if (parentIndex !== -1) {
      this.pendingStopValue = undefined
      this.selectionTouched = true
      this.selected = parentIndex
      this.ensureVisible()
    }
  }

  private runningMove(direction: 1 | -1): void {
    const running = this.filtered.filter(item => item.kind !== 'view-full' && isTaskItemActive(item))
    if (running.length === 0) return
    const current = this.selectedItem()
    const currentIndex = current === undefined ? -1 : running.findIndex(item => item.value === current.value)
    const next = currentIndex === -1
      ? (direction > 0 ? running[0]! : running[running.length - 1]!)
      : running[(currentIndex + direction + running.length) % running.length]!
    const index = this.filtered.findIndex(item => item.value === next.value)
    if (index === -1) return
    this.pendingStopValue = undefined
    this.selectionTouched = true
    this.selected = index
    this.ensureVisible()
  }

  /** Input ownership is forwarded by FocusForwardingFrame. */
  handleInput(data: string): void {
    if (this.pendingStopValue !== undefined) {
      if (matchesKey(data, 'escape')) {
        this.pendingStopValue = undefined
        this.requestRender()
        return
      }
      if (matchesKey(data, 'y') || data === 'Y') {
        this.confirmStop()
        return
      }
      // A navigation gesture changes selection and therefore invalidates the
      // destructive confirmation. Other keys are ignored, never dispatched.
      if (componentKeymap.matches(data, 'tasks.cursorUp')) this.move(-1)
      else if (componentKeymap.matches(data, 'tasks.cursorDown')) this.move(1)
      else if (componentKeymap.matches(data, 'tasks.pageUp')) this.page(-1)
      else if (componentKeymap.matches(data, 'tasks.pageDown')) this.page(1)
      return
    }

    if (this.explicitMode && this.searchMode) {
      if (componentKeymap.matches(data, 'tasks.search.exit')) {
        this.exitSearchMode()
        return
      }
      if (componentKeymap.matches(data, 'tasks.cursorUp')) { this.move(-1); return }
      if (componentKeymap.matches(data, 'tasks.cursorDown')) { this.move(1); return }
      if (componentKeymap.matches(data, 'tasks.pageUp')) { this.page(-1); return }
      if (componentKeymap.matches(data, 'tasks.pageDown')) { this.page(1); return }
      if (componentKeymap.matches(data, 'tasks.open')) { this.openSelected(); return }
      if (componentKeymap.matches(data, 'tasks.type.next')) { this.cycleType(); return }
      // In search mode arrows/editing remain with Input. In particular S, A,
      // R, N and every other printable character are query text, never an
      // action with side effects.
      this.selectionTouched = true
      this.searchInput.handleInput(data)
      this.reproject(true)
      return
    }

    if (this.explicitMode && componentKeymap.matches(data, 'tasks.search.enter')) {
      this.enterSearchMode()
      return
    }
    if (this.explicitMode && componentKeymap.matches(data, 'tasks.scope.toggle')) {
      this.toggleScope()
      return
    }
    if (this.explicitMode && componentKeymap.matches(data, 'tasks.tree.expand')) {
      this.treeExpand()
      return
    }
    if (this.explicitMode && componentKeymap.matches(data, 'tasks.tree.collapse')) {
      this.treeCollapse()
      return
    }
    if (this.explicitMode && componentKeymap.matches(data, 'tasks.running.next')) {
      this.runningMove(1)
      return
    }
    if (this.explicitMode && componentKeymap.matches(data, 'tasks.running.previous')) {
      this.runningMove(-1)
      return
    }
    if (this.explicitMode && componentKeymap.matches(data, 'tasks.stop')) {
      this.requestStop()
      return
    }
    if (this.explicitMode && componentKeymap.matches(data, 'tasks.view.full') && this.mode === 'quick') {
      this.onViewFull?.(this.getViewState())
      return
    }
    if (this.explicitMode && componentKeymap.matches(data, 'tasks.refresh')) {
      this.onRefresh?.()
      return
    }
    if (componentKeymap.matches(data, 'tasks.type.next')) {
      this.cycleType()
      return
    }

    const isNavUp = componentKeymap.matches(data, 'tasks.cursorUp') || (!this.searchEnabled && data === 'k')
    const isNavDown = componentKeymap.matches(data, 'tasks.cursorDown') || (!this.searchEnabled && data === 'j')
    const isPageUp = componentKeymap.matches(data, 'tasks.pageUp')
    const isPageDown = componentKeymap.matches(data, 'tasks.pageDown')

    // Compatibility only: old direct embedders used i. The application passes
    // `mode`, so production has no printable interrupt binding at all.
    if (!this.explicitMode && this.onAction !== undefined && matchesKey(data, 'i')) {
      // Preserve the historical direct-call behavior only for an empty
      // query. Once the legacy search contains text, i is ordinary query
      // input; production explicit mode has no i path at all.
      if (this.getFilter() === '') {
        const item = this.selectedItem()
        if (item?.interruptible === true) this.onAction(item.value, 'interrupt')
      } else {
        this.selectionTouched = true
        this.searchInput.handleInput(data)
        this.reproject(true)
      }
      return
    }

    if (!this.explicitMode && this.searchEnabled && !isNavUp && !isNavDown && !isPageUp && !isPageDown
      && !componentKeymap.matches(data, 'tasks.open') && !componentKeymap.matches(data, 'tasks.search.exit')) {
      this.selectionTouched = true
      this.searchInput.handleInput(data)
      this.reproject(true)
      return
    }
    if (isNavUp) { this.move(-1); return }
    if (isNavDown) { this.move(1); return }
    if (isPageUp) { this.page(-1); return }
    if (isPageDown) { this.page(1); return }
    if (componentKeymap.matches(data, 'tasks.open')) { this.openSelected(); return }
    if (componentKeymap.matches(data, 'tasks.search.exit')) this.onCancel()
  }

  private ensureVisible(): void {
    if (this.selected < this.scroll) this.scroll = this.selected
    else if (this.selected >= this.scroll + this.maxVisible) this.scroll = this.selected - this.maxVisible + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, this.filtered.length - this.maxVisible)))
  }

  private startTick(): void {
    this.tickTimer = setInterval(() => {
      if (this.disposed) return
      const hasLive = this.items.some(item => item.startedAt !== undefined && isTaskItemActive(item))
      if (!hasLive) return
      this.now = Date.now()
      this.requestRender()
    }, 1000)
    this.tickTimer.unref()
  }

  dispose(): void {
    this.disposed = true
    if (this.tickTimer !== undefined) clearInterval(this.tickTimer)
    this.tickTimer = undefined
    this.marquee.dispose()
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.searchInput.focused = value && this.searchMode
  }

  invalidate(): void {
    this.searchInput.invalidate()
  }

  render(width: number): string[] {
    this.now = Date.now()
    const safeWidth = Math.max(1, width)
    const lines: string[] = []
    const explicit = this.explicitMode

    if (this.options.header !== undefined) {
      const header = explicit ? this.headerText() : this.legacyHeaderText()
      lines.push(color.textStrong(truncateToWidth(header, safeWidth, '…')))
      lines.push('')
    }

    if (this.loading && this.items.length === 0) {
      lines.push(color.textDim('Loading tasks…'))
      if (this.refreshError !== undefined) lines.push(color.textMuted(`${this.refreshError} · R retry`))
      lines.push('')
      lines.push(color.textMuted(`  ${this.hint()}`))
      return lines
    }

    if (this.explicitMode && this.searchMode) {
      const searchLine = this.searchInput.render(Math.max(1, safeWidth - 2))[0] ?? ''
      const stripped = searchLine.startsWith('> ') ? searchLine.slice(2) : searchLine
      lines.push(this.getFilter() === '' ? color.textDim(' / search…') : ` ${stripped}`)
      lines.push('')
    } else if (!explicit && this.searchEnabled) {
      const searchLine = this.searchInput.render(Math.max(1, safeWidth - 2))[0] ?? ''
      const stripped = searchLine.startsWith('> ') ? searchLine.slice(2) : searchLine
      lines.push(this.getFilter() === '' ? color.textDim(' search…') : ` ${stripped}`)
      lines.push('')
    }

    const rows = this.filtered
    if (rows.length === 0) {
      lines.push(color.textDim(this.refreshError === undefined ? (this.options.noMatchText ?? 'No matching tasks') : 'Could not load tasks'))
      if (this.refreshError !== undefined) lines.push(color.textMuted(`${this.refreshError} · R retry`))
      lines.push('')
      lines.push(color.textMuted(`  ${this.hint()}`))
      return lines
    }

    this.ensureVisible()
    this.exposeViewport()
    const start = this.scroll
    const end = Math.min(rows.length, start + this.maxVisible)
    const visibleRows = rows.slice(start, end)
    const listWidth = safeWidth >= 110 ? Math.max(40, Math.floor((safeWidth - 3) * 0.58)) : safeWidth
    const listLines: string[] = []
    let lastGroup: string | undefined
    for (let i = 0; i < visibleRows.length; i += 1) {
      const item = visibleRows[i]!
      const group = displayGroup(item.group, this.options.groupLabels === true)
      if (group !== lastGroup) {
        if (group !== undefined) listLines.push(color.textMuted(`── ${group} ──`))
        lastGroup = group
      }
      const selected = start + i === this.selected
      listLines.push(...this.renderRow(item, selected, listWidth))
      if (safeWidth >= 70 && safeWidth < 110 && selected && item.kind !== 'view-full') {
        listLines.push(...this.renderInlineDetail(item, safeWidth))
      }
    }

    if (safeWidth >= 110) {
      const detail = this.detailLines(this.selectedItem())
      const merged: string[] = []
      const detailWidth = Math.max(24, safeWidth - listWidth - 3)
      const max = Math.max(listLines.length, detail.length)
      for (let i = 0; i < max; i += 1) {
        const left = truncateToWidth(listLines[i] ?? '', listWidth, '…')
        const leftPad = ' '.repeat(Math.max(0, listWidth - visibleWidth(left)))
        const right = truncateToWidth(detail[i] ?? '', detailWidth, '…')
        merged.push(`${left}${leftPad} ${color.border('│')} ${right}`)
      }
      lines.push(...merged)
    } else {
      lines.push(...listLines)
    }

    if (rows.length > this.maxVisible) lines.push(color.textMuted(`  ${this.selected + 1}/${rows.length}`))
    if (this.refreshError !== undefined) lines.push(color.textMuted(`  ${this.refreshError} · R retry`))
    lines.push('')
    lines.push(color.textMuted(`  ${this.hint()}`))
    return lines
  }

  private legacyHeaderText(): string {
    const chip = this.activeType === null ? '' : `  [${this.activeType}]`
    const rows = this.filtered.filter(item => item.kind !== 'view-full')
    const running = rows.filter(isTaskItemActive).length
    const done = rows.filter(item => item.status === 'completed').length
    const failed = rows.filter(item => isTaskItemFailure(item.status)).length
    const counts = [
      running > 0 ? `${running} running` : '',
      done > 0 ? `${done} done` : '',
      failed > 0 ? `${failed} failed` : '',
    ].filter(part => part !== '').join(' · ')
    return `${this.options.header ?? ''}${chip}${counts === '' ? '' : `  ${counts}`}`
  }

  private headerText(): string {
    const real = this.items.filter(item => item.kind !== 'view-full')
    const visible = this.filtered.filter(item => item.kind !== 'view-full').length
    const active = real.filter(isTaskItemActive).length
    const done = real.filter(item => item.status === 'completed').length
    const failed = real.filter(item => isTaskItemFailure(item.status)).length
    const chips = [`[${this.scope.toUpperCase()}]`]
    if (this.activeType !== null) chips.push(`[${this.activeType}]`)
    if (this.getFilter() !== '') chips.push(`[search: ${this.getFilter()}]`)
    const stats = [`${active} active`]
    if (done > 0) stats.push(`${done} done`)
    if (failed > 0) stats.push(`${failed} failed`)
    stats.push(`${visible}/${real.length} shown`)
    return `${this.options.header ?? 'Tasks'} ${chips.join(' ')}  ${stats.join(' · ')}`
  }

  private renderRow(item: TaskPanelItem, selected: boolean, width: number): string[] {
    const dot = taskStatusColor(item.status)(this.explicitMode ? stateGlyph(item) : DOT)
    const attention = item.attention === true ? color.error('!') : ''
    const pointer = selected ? color.primary(POINTER) : ' '
    const leftPrefix = `${pointer} ${attention}${dot} `
    const tree = item.treePrefix ?? ''
    const treeWidth = visibleWidth(tree)
    const statusText = item.kind === 'view-full' ? '' : taskStatusColor(item.status)(item.status)
    const elapsedSeconds = item.startedAt === undefined ? undefined : Math.max(0, Math.floor(((item.finishedAt ?? this.now) - item.startedAt) / 1000))
    const elapsedText = item.kind === 'view-full' || elapsedSeconds === undefined ? '' : color.textMuted(formatElapsed(elapsedSeconds))
    const tail = [statusText, elapsedText].filter(part => part !== '').join(' ')
    const tailWidth = visibleWidth(tail)
    const suffix = item.suffix === undefined || item.suffix === '' ? '' : ` · ${item.suffix}`
    const suffixWidth = visibleWidth(suffix)
    const leftWidth = visibleWidth(leftPrefix)
    const available = Math.max(1, width - leftWidth)
    const labelBudget = Math.max(0, available - treeWidth - suffixWidth - tailWidth - 1)
    const label = this.marquee.render({ key: item.value, text: item.label, maxWidth: labelBudget, selected })
    const tone = item.ancestorContext === true ? color.textDim : selected ? color.textStrong : color.text
    const left = leftPrefix + tree + tone(label) + (selected ? color.textStrong(suffix) : color.text(suffix))
    const tailPart = tailWidth <= width - visibleWidth(left) ? tail : (labelBudget === 0 ? truncateToWidth(tail, Math.max(1, width - visibleWidth(left)), '…') : '')
    const pad = Math.max(1, width - visibleWidth(left) - visibleWidth(tailPart))
    return [truncateToWidth(left + ' '.repeat(pad) + tailPart, width, '…')]
  }

  private detailLines(item: TaskPanelItem | undefined): string[] {
    if (item === undefined || item.kind === 'view-full') return ['Selected', 'No task selected']
    const elapsed = item.startedAt === undefined ? undefined : Math.max(0, Math.floor(((item.finishedAt ?? this.now) - item.startedAt) / 1000))
    const lines = ['Selected', item.label]
    if (item.source === 'subagent' || item.mode !== undefined) {
      if (item.mode !== undefined) lines.push(`mode      ${item.mode}`)
      lines.push(`activity  ${item.status}`)
      if (elapsed !== undefined) lines.push(`duration  ${formatElapsed(elapsed)}`)
      if (item.parentLabel !== undefined) lines.push(`parent    ${item.parentLabel}`)
      else if (item.parentId !== undefined && item.parentId !== '') lines.push(`parent    ${item.parentId}`)
      if (item.depth !== undefined) lines.push(`depth     ${item.depth}`)
      if (item.access !== undefined) lines.push(`access    ${item.access}`)
    } else {
      if (item.type !== undefined) lines.push(`kind      ${item.type}`)
      lines.push(`status    ${item.status}`)
      if (elapsed !== undefined) lines.push(`elapsed   ${formatElapsed(elapsed)}`)
      if (item.startedAt !== undefined) lines.push(`started   ${new Date(item.startedAt).toISOString()}`)
      if (item.detail !== undefined && item.detail !== '') lines.push(`detail    ${item.detail}`)
    }
    if (this.pendingStopValue === item.value) lines.push(`Stop ${item.label}?  Y confirm · Esc cancel`)
    return lines
  }

  private renderInlineDetail(item: TaskPanelItem, width: number): string[] {
    const detail = this.detailLines(item).slice(1, 4).join(' · ')
    return [truncateToWidth(`    ${color.textDim(detail)}`, width, '…')]
  }

  private hint(): string {
    if (this.pendingStopValue !== undefined) return 'Y confirm stop · Esc cancel'
    if (!this.explicitMode) {
      const search = this.searchEnabled ? 'type to filter · ' : ''
      const type = this.typeOrder.length > 1 ? 'tab type · ' : ''
      const interrupt = this.filtered.some(item => item.interruptible === true) ? 'i interrupt · ' : ''
      return `${search}${type}${interrupt}↑↓ navigate · enter open · esc close`
    }
    const parts: string[] = []
    if (this.searchMode) parts.push('search mode')
    else if (this.searchEnabled) parts.push('/ search')
    parts.push('A active/all', 'Tab type', '←→ tree', 'N next running', 'S stop', 'Enter open', 'R refresh')
    if (this.mode === 'quick') parts.push('T Task Center')
    parts.push('Esc back')
    return parts.join(' · ')
  }
}
