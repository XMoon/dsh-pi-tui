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
import { dispatchMouseEvent } from '@xmoon76/pi-tui'
import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { componentKeymap } from './keybindings/component-keymap.ts'
import { color, taskStatusColor } from './theme.ts'
import { SelectedMarquee } from './marquee.ts'
import { singlePhysicalLine } from './presentation-lines.ts'
import {
  isTaskItemActive,
  isTaskItemFailure,
  projectTaskItems,
  type TaskPanelItem,
  type TaskScope,
} from './task-presentation.ts'

export type { TaskPanelItem, TaskScope } from './task-presentation.ts'

/** One physical row of the last painted panel frame (mouse hit-testing).
 * The map is built from the EXACT final rows render() returns (including
 * the fit-loop and degraded paths), so a click can only act on
 * last-painted geometry. (Mouse parity.) */
type TaskMouseHit =
  | { kind: 'search' }
  | { kind: 'item'; value: string; index: number; listWidth?: number }
  | { kind: 'inert' }

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
  /** Quick (navigation-only) or Full (management) surface. */
  mode: 'quick' | 'full'
  /** Header title. The panel adds scope/type/count chips. */
  header?: string
  /** Rendered when the (filtered) list is empty. */
  noMatchText?: string
  /** Whether the `/` search action is available (Full mode). */
  enableSearch?: boolean
  /** Pre-fill the search input. A non-empty value enters search mode.
   * Ignored in Quick mode, which owns no search state. */
  initialQuery?: string
  /** Preserve whether the search editor was active across Quick/Full.
   * Ignored (forced off) in Quick mode, which owns no search state. */
  initialSearchMode?: boolean
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
  /** Use the long group names in the Task Center. */
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
 * `mode` selects the keyboard surface: `quick` is navigation-only (arrows,
 * `←`/`→` tree, `Tab` type, `Enter` open, `Esc` close) and consumes every
 * other key as a no-op; `full` owns search, scope, stop, refresh, paging and
 * reverse (`Shift+Tab`) type cycling. There is exactly one input contract —
 * no mode-less compatibility path.
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
  private searchMode: boolean
  private selectionTouched = false
  private readonly expandedIds: Set<string>
  private readonly collapsedIds: Set<string>
  /** Caller-configured item cap; the live terminal budget may lower it. */
  private readonly configuredMaxVisible: number
  private maxVisible: number
  /** Total inner rows granted by the surrounding Frame. */
  private maxRows = Number.POSITIVE_INFINITY
  /** The ACTUAL viewport the last render painted (after the fit loop
   * shrunk the budget estimate): the ack scope for viewportItems()/
   * onViewportExpose and the PageUp/PageDown step — never the budget
   * baseline, which detail rows / the sidebar can undershoot. */
  private lastRenderedStart = 0
  private lastRenderedCount = 0
  /** Whether render() recorded a painted viewport yet. Until the first
   * paint no row was ever seen, so the pre-paint default (0 rows) must
   * not over-claim; setMaxRows still bounds it to the live grant. */
  private hasRenderedViewport = false
  private readonly options: TaskPanelOptions
  private readonly searchInput = new Input()
  private searchEnabled: boolean
  /** Physical row → hit entry from the LAST render (mouse parity). */
  private hitMap: TaskMouseHit[] = []
  /** The width the hit map was painted at; a stale-width event is rejected. */
  private lastRenderWidth = 0
  /** The pressed item's VALUE (mouse parity): a synthesized click may only
   * activate the exact logical item that was pressed — an async
   * enrichment repaint between press and release must never activate
   * whatever moved into the same physical row. */
  private mousePressedValue: string | undefined
  private readonly onSelect: (value: string) => void
  private readonly onCancel: () => void
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
    this.configuredMaxVisible = Math.max(1, Math.floor(maxVisible))
    this.maxVisible = this.configuredMaxVisible
    // Pre-render default: the configured window (direct embedders have no
    // frame to tighten it). A framed mount's setMaxRows bounds it to the
    // live grant before the first paint; the first render overwrites it
    // with the ACTUAL painted window.
    this.lastRenderedCount = this.maxVisible
    this.options = options
    this.onSelect = onSelect
    this.onCancel = onCancel
    this.onStop = options.onStop
    this.onViewportExpose = options.onViewportExpose
    this.onRefresh = options.onRefresh
    this.onViewFull = options.onViewFull
    this.requestRender = requestRender
    this.mode = options.mode
    this.openedFrom = options.openedFrom ?? 'command'
    this.searchEnabled = options.enableSearch ?? false
    this.scope = options.initialScope ?? (this.mode === 'quick' ? 'active' : 'all')
    this.activeType = options.initialTypeFilter ?? null
    this.expandedIds = new Set(options.initialExpandedIds ?? [])
    this.collapsedIds = new Set(options.initialCollapsedIds ?? [])
    this.loading = options.loading ?? false
    this.refreshError = options.refreshError
    this.preferredValue = options.initialPreferredValue ?? options.initialSelectedId
    // Quick Tasks owns no search state: it is a navigation-only surface, and
    // a query restored from the full view would filter its rows AND hide the
    // "Open Task Center" pseudo-row (appended only while the query is empty)
    // with no keyboard way to clear it — a dead end that also removes the
    // only keyboard path back to Full. Force Quick's query and search mode
    // off whatever a caller passes; Full keeps the shared search state.
    this.searchMode = this.mode === 'quick'
      ? false
      : (options.initialSearchMode ?? (options.initialQuery ?? '') !== '')
    this.marquee = new SelectedMarquee({
      requestRender: () => this.requestRender(),
      now: options.marqueeNow,
    })
    this.searchInput.onEscape = () => {
      if (this.searchMode) {
        this.exitSearchMode()
      } else {
        this.onCancel()
      }
    }
    this.searchInput.onSubmit = () => this.openSelected()
    const initial = this.mode === 'quick' ? '' : (options.initialQuery ?? '')
    if (initial !== '') this.searchInput.setValue(initial)
    this.rebuildTypeCycle()
    // A restored type filter that no row satisfies produces a dead view;
    // validate it against the initial row set exactly like setItems does.
    if (this.activeType !== null && !this.typeOrder.includes(this.activeType)) this.activeType = null
    this.reproject(false)
    this.selectPreferred()
    this.startTick()
  }

  /** Update the live inner row budget without resetting selection, filters
   * or disclosure state (the responsive frame calls this on every resize;
   * the recompute uses the CURRENT chrome: header + search + hint tail +
   * indicator + optional refresh-error line). */
  setMaxRows(rows: number): void {
    this.maxRows = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : Number.POSITIVE_INFINITY
    this.recomputeVisibleBudget()
    this.ensureVisible()
    // Before the first paint the recorded viewport is the live grant (the
    // configured cap may be larger than what the frame allows); after a
    // render the PAINTED window is authoritative and untouched here.
    if (!this.hasRenderedViewport) this.lastRenderedCount = this.maxVisible
  }

  /** Derive the item window from the current chrome and row budget. */
  private recomputeVisibleBudget(): void {
    const prefix = (this.options.header === undefined ? 0 : 2) + (this.searchMode ? 2 : 0)
    const trailing = 2 // blank separator + navigation hint
    const refreshLine = this.refreshError !== undefined ? 1 : 0
    const group = this.filtered.some(item => item.group !== undefined) ? 1 : 0
    const budget = this.maxRows === Number.POSITIVE_INFINITY
      ? this.configuredMaxVisible
      : this.maxRows - prefix - trailing - refreshLine - group
    this.maxVisible = Math.max(1, Math.min(this.configuredMaxVisible, budget))
  }

  /** Replace rows while preserving the selected identity where possible. */
  setItems(items: readonly TaskPanelItem[], preferredValue?: string): void {
    const previousValue = this.filtered[this.selected]?.value
    this.items = [...items]
    this.loading = false
    // Forget exposures whose row left the attention set: a STABLE id can
    // exit failure and later re-enter it, and the runtime treats that as a
    // NEW attention event (it clears the acknowledged set when the failure
    // id disappears). The panel must mirror that — otherwise the second
    // failure of the same id would never re-expose (P2 edge case).
    if (this.exposedAttention.size > 0) {
      const currentAttention = new Set(this.items
        .filter(item => item.attention === true)
        .map(item => item.value))
      for (const id of [...this.exposedAttention]) {
        if (!currentAttention.has(id)) this.exposedAttention.delete(id)
      }
    }
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
    // A stale banner row changes the chrome: re-derive the budget now, so
    // paging/ack do not keep the pre-banner window until the next projection.
    this.recomputeVisibleBudget()
    this.requestRender()
  }

  /** Current rows after scope/type/search/disclosure projection. */
  visibleItems(): readonly TaskPanelItem[] {
    return this.filtered
  }

  /** ONLY the rows the CURRENT painted viewport actually rendered (the
   * ack scope: a failure the user never physically saw was never "seen").
   * Reflects the render-time fit (detail rows / the sidebar can shrink
   * the painted window below the budget baseline), never `maxVisible`. */
  viewportItems(): readonly TaskPanelItem[] {
    return this.filtered.slice(this.lastRenderedStart, this.lastRenderedStart + this.lastRenderedCount)
  }

  /**
   * Report attention rows that entered the open viewport for the first
   * time (deduped per row identity). Runs on every render — scrolling,
   * paging and row replacements all re-render — so a
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
    // The projection changed the row set: re-derive the live item budget
    // (the group/chrome estimate follows the current view).
    this.recomputeVisibleBudget()
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

  private cycleType(direction: 1 | -1): void {
    if (this.typeOrder.length === 0) return
    const index = this.activeType === null ? -1 : this.typeOrder.indexOf(this.activeType)
    if (index === -1) {
      // All (null): forward enters the first type, backward the last, so
      // the cycle is symmetric without a second code path.
      this.activeType = direction > 0
        ? this.typeOrder[0]!
        : this.typeOrder[this.typeOrder.length - 1]!
    } else {
      const next = index + direction
      this.activeType = next < 0 || next >= this.typeOrder.length ? null : this.typeOrder[next]!
    }
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
    // The search chrome (2 rows) enters the budget estimate immediately.
    this.recomputeVisibleBudget()
    this.requestRender()
  }

  private exitSearchMode(): void {
    if (!this.searchMode) return
    this.searchMode = false
    this.searchInput.focused = false
    // The search chrome (2 rows) leaves the budget estimate immediately.
    this.recomputeVisibleBudget()
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
    // Page by the ACTUAL last-rendered window (the fit loop may have
    // shrunk it below the budget baseline), so a page never skips rows
    // the user just saw.
    const pageSize = Math.max(1, this.lastRenderedCount)
    this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + direction * pageSize))
    this.ensureVisible()
  }

  private selectedItem(): TaskPanelItem | undefined {
    return this.filtered[this.selected]
  }

  private canStop(item: TaskPanelItem | undefined): boolean {
    if (item === undefined || item.kind === 'view-full') return false
    return item.canStop ?? false
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

  /** Input ownership is forwarded by FocusForwardingFrame. */
  handleInput(data: string): void {
    // Quick Tasks is a navigation-only surface: ONLY the whitelist below
    // produces behavior. Every other key is consumed here as a no-op so it
    // can neither fall into the Full state machine (stop confirmation,
    // search, scope/type/refresh actions) nor leak to the editor. This is
    // the input-ownership fix for the probabilistic "Esc cannot close
    // Quick" bug — Quick has no nested keyboard state left to unwind, so
    // Esc is always exactly one layer.
    if (this.mode === 'quick') {
      if (componentKeymap.matches(data, 'tasks.cursorUp')) { this.move(-1); return }
      if (componentKeymap.matches(data, 'tasks.cursorDown')) { this.move(1); return }
      if (componentKeymap.matches(data, 'tasks.tree.expand')) { this.treeExpand(); return }
      if (componentKeymap.matches(data, 'tasks.tree.collapse')) { this.treeCollapse(); return }
      if (componentKeymap.matches(data, 'tasks.type.next')) { this.cycleType(1); return }
      if (componentKeymap.matches(data, 'tasks.open')) { this.openSelected(); return }
      // In Quick the escape action means "close", never "leave search".
      if (componentKeymap.matches(data, 'tasks.search.exit')) { this.onCancel(); return }
      return
    }

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

    if (this.searchMode) {
      if (componentKeymap.matches(data, 'tasks.search.exit')) {
        this.exitSearchMode()
        return
      }
      if (componentKeymap.matches(data, 'tasks.cursorUp')) { this.move(-1); return }
      if (componentKeymap.matches(data, 'tasks.cursorDown')) { this.move(1); return }
      if (componentKeymap.matches(data, 'tasks.pageUp')) { this.page(-1); return }
      if (componentKeymap.matches(data, 'tasks.pageDown')) { this.page(1); return }
      if (componentKeymap.matches(data, 'tasks.open')) { this.openSelected(); return }
      if (componentKeymap.matches(data, 'tasks.type.next')) { this.cycleType(1); return }
      if (componentKeymap.matches(data, 'tasks.type.previous')) { this.cycleType(-1); return }
      // In search mode arrows/editing remain with Input. In particular S, A,
      // R, N and every other printable character are query text, never an
      // action with side effects.
      this.selectionTouched = true
      this.searchInput.handleInput(data)
      this.reproject(true)
      return
    }

    if (componentKeymap.matches(data, 'tasks.search.enter')) {
      this.enterSearchMode()
      return
    }
    if (componentKeymap.matches(data, 'tasks.scope.toggle')) {
      this.toggleScope()
      return
    }
    if (componentKeymap.matches(data, 'tasks.tree.expand')) {
      this.treeExpand()
      return
    }
    if (componentKeymap.matches(data, 'tasks.tree.collapse')) {
      this.treeCollapse()
      return
    }
    if (componentKeymap.matches(data, 'tasks.stop')) {
      this.requestStop()
      return
    }
    if (componentKeymap.matches(data, 'tasks.refresh')) {
      this.onRefresh?.()
      return
    }
    if (componentKeymap.matches(data, 'tasks.type.next')) {
      this.cycleType(1)
      return
    }
    if (componentKeymap.matches(data, 'tasks.type.previous')) {
      this.cycleType(-1)
      return
    }
    if (componentKeymap.matches(data, 'tasks.cursorUp')) { this.move(-1); return }
    if (componentKeymap.matches(data, 'tasks.cursorDown')) { this.move(1); return }
    if (componentKeymap.matches(data, 'tasks.pageUp')) { this.page(-1); return }
    if (componentKeymap.matches(data, 'tasks.pageDown')) { this.page(1); return }
    if (componentKeymap.matches(data, 'tasks.open')) { this.openSelected(); return }
    if (componentKeymap.matches(data, 'tasks.search.exit')) this.onCancel()
  }

  /**
   * Mouse parity: the hit map from the LAST render decides what a pointer
   * event may act on — the search row, a task/subagent row (left list
   * cell only in the wide layout; the detail pane is inert), or chrome
   * (header, group headers, inline details, indicator, error, hint). A
   * press records the pressed item's VALUE; a synthesized click activates
   * only when the same physical row still resolves to that exact value,
   * so an async enrichment repaint between press and release can never
   * activate whatever moved into the row. Wheel moves the selection
   * (clamping like the keyboard).
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // A click ends any gesture, and every left press starts a fresh
    // one: release the pressed identity up front — BEFORE the width
    // guard / hit lookup / search dispatch / inert return, so a
    // delegated search press (or a press on stale-width or missing-hit
    // geometry) still replaces the old latch. The TUI keeps the panel
    // as the press target for a handled search press, so a later
    // release on the same cell synthesizes a click that must not match
    // a stale identity. The local copy still guards the valid-row
    // comparison below.
    const pressedValue = this.mousePressedValue
    if (event.type === 'click' || (event.type === 'press' && event.button === 'left')) {
      this.mousePressedValue = undefined
    }
    // The hit map is only valid for the last painted width: a resize
    // that has not been repainted must not dispatch against stale
    // geometry (last-painted geometry is authoritative).
    if (event.width !== this.lastRenderWidth) return undefined
    const hit = this.hitMap[event.y]
    if (!hit) return undefined

    if (hit.kind === 'search') {
      if (event.type !== 'press') return undefined
      // The search row is ' ' + the Input's render (prompt stripped): the
      // Input's local x = event.x + 1 (the leading space maps to the
      // prompt's first column).
      const result = dispatchMouseEvent(this.searchInput, { ...event, x: event.x + 1, y: 0 })
      return result ? { ...result, focus: true } : undefined
    }

    if (hit.kind === 'item') {
      // The wide layout's detail pane is inert: a click there must never
      // activate the row merely because it shares the y.
      if (hit.listWidth !== undefined && event.x >= hit.listWidth) return undefined
      if (event.type === 'wheel' && event.wheelDelta) {
        if (this.filtered.length === 0) return undefined
        const delta = event.wheelDelta < 0 ? -1 : 1
        this.pendingStopValue = undefined
        this.selectionTouched = true
        this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + delta))
        this.ensureVisible()
        return { handled: true, render: true }
      }
      if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) return undefined
      if (event.type === 'press') {
        // The hit map is last-painted geometry: resolve the CURRENT
        // index by the pressed VALUE (a setItems() between paint and
        // press may have reordered rows WITHOUT a repaint, so the stale
        // index can point at a different item). No match => reject the
        // press — the pressed row no longer exists.
        const currentIndex = this.filtered.findIndex(candidate => candidate.value === hit.value)
        if (currentIndex === -1) return undefined
        this.mousePressedValue = hit.value
        if (this.selected !== currentIndex) {
          // Changing selection cancels a pending destructive
          // confirmation (mirror the keyboard navigation state machine:
          // cursor/page moves clear pendingStopValue).
          this.pendingStopValue = undefined
          this.selected = currentIndex
          this.selectionTouched = true
          this.ensureVisible()
        }
        return { handled: true, focus: true }
      }
      // click: activate only the exact pressed item (async enrichment
      // safety — press A → repaint → release must not activate B). The
      // hit map is last-painted geometry, so the pressed VALUE is the
      // identity — resolve the CURRENT item by that value (a setItems()
      // between press and release may have reordered/replaced rows
      // WITHOUT a repaint yet, so the index in the stale hit map can
      // point at a different item). No match => drop.
      if (pressedValue !== hit.value) return undefined
      // A pending destructive confirmation is a modal state: the click
      // must not bypass it (keyboard Enter is ignored there).
      if (this.pendingStopValue !== undefined) return { handled: true }
      const item = this.filtered.find(candidate => candidate.value === hit.value)
      if (item !== undefined) {
        if (item.kind === 'view-full') {
          this.onViewFull?.(this.getViewState())
        } else {
          this.onSelect(item.value)
        }
      }
      return { handled: true }
    }

    return undefined
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
    this.lastRenderWidth = safeWidth
    const lines: string[] = []
    const hits: TaskMouseHit[] = []
    const push = (line: string, hit: TaskMouseHit): void => {
      lines.push(line)
      hits.push(hit)
    }
    const limit = Number.isFinite(this.maxRows) ? Math.max(1, Math.floor(this.maxRows)) : Number.POSITIVE_INFINITY
    const hintLine = color.textMuted(`  ${this.hint()}`)
    const searchOn = this.searchMode
    // The retry verb is a Full-only action: Quick consumes R as a no-op, so
    // its stale/error banner shows the message without advertising a key
    // that cannot work there.
    const retrySuffix = this.mode === 'quick' ? '' : ' · R retry'
    // The banner is one physical row: a transport/refresh error message
    // (Error.message) may carry CR/LF AND arbitrary length, so it is
    // projected and width-truncated before it enters the row budget (a
    // direct embedding without a clipping frame must never wrap it into
    // extra terminal rows). The raw `refreshError` state stays untouched.
    const refreshErrorText = this.refreshError === undefined ? undefined : singlePhysicalLine(this.refreshError)
    const refreshErrorLine = refreshErrorText === undefined ? undefined
      : truncateToWidth(`${refreshErrorText}${retrySuffix}`, safeWidth, '…')
    // Hoisted chrome texts: the short-grant degradation rebuilds from
    // them without the unconditionally-kept blank spacers.
    const headerText = this.options.header === undefined ? undefined
      : truncateToWidth(this.headerText(), safeWidth, '…')
    const searchEmpty = this.getFilter() === ''
    const searchRowText = !searchOn ? '' : (() => {
      const searchLine = this.searchInput.render(Math.max(1, safeWidth - 2))[0] ?? ''
      const stripped = searchLine.startsWith('> ') ? searchLine.slice(2) : searchLine
      return searchEmpty ? ' / search…' : ` ${stripped}`
    })()

    if (headerText !== undefined) {
      push(color.textStrong(headerText), { kind: 'inert' })
      push('', { kind: 'inert' })
    }

    if (this.loading && this.items.length === 0) {
      push(color.textDim('Loading tasks…'), { kind: 'inert' })
      if (this.refreshError !== undefined) push(color.textMuted(refreshErrorLine!), { kind: 'inert' })
      push('', { kind: 'inert' })
      push(hintLine, { kind: 'inert' })
      this.lastRenderedStart = 0
      this.lastRenderedCount = 0
      this.hasRenderedViewport = true
      const result = this.finalizeEmpty(lines, hits)
      this.hitMap = result.hits
      return result.lines
    }

    if (searchOn) {
      // The search row: ' ' + the Input's render (prompt stripped). The
      // Input's local x = event.x + 1 (the leading space maps to the
      // prompt's first column).
      push(searchEmpty ? color.textDim(searchRowText) : searchRowText, { kind: 'search' })
      push('', { kind: 'inert' })
    }

    const rows = this.filtered
    if (rows.length === 0) {
      push(color.textDim(this.refreshError === undefined ? (this.options.noMatchText ?? 'No matching tasks') : 'Could not load tasks'), { kind: 'inert' })
      if (this.refreshError !== undefined) push(color.textMuted(refreshErrorLine!), { kind: 'inert' })
      push('', { kind: 'inert' })
      push(hintLine, { kind: 'inert' })
      this.lastRenderedStart = 0
      this.lastRenderedCount = 0
      this.hasRenderedViewport = true
      const result = this.finalizeEmpty(lines, hits)
      this.hitMap = result.hits
      return result.lines
    }

    this.ensureVisible()
    const listWidth = safeWidth >= 110 ? Math.max(40, Math.floor((safeWidth - 3) * 0.58)) : safeWidth
    let itemCount = Math.min(rows.length, this.maxVisible)
    let start = this.scroll
    const buildWindow = (count: number, from: number): { lines: string[]; hits: TaskMouseHit[] } => {
      const end = Math.min(rows.length, from + count)
      const visibleRows = rows.slice(from, end)
      const listLines: string[] = []
      const listHits: TaskMouseHit[] = []
      let lastGroup: string | undefined
      for (let i = 0; i < visibleRows.length; i += 1) {
        const item = visibleRows[i]!
        const group = displayGroup(item.group, this.options.groupLabels === true)
        if (group !== lastGroup) {
          if (group !== undefined) {
            listLines.push(color.textMuted(`── ${group} ──`))
            listHits.push({ kind: 'inert' })
          }
          lastGroup = group
        }
        const selected = from + i === this.selected
        listLines.push(...this.renderRow(item, selected, listWidth))
        listHits.push({ kind: 'item', value: item.value, index: from + i })
        if (safeWidth >= 70 && safeWidth < 110 && selected && item.kind !== 'view-full') {
          const detailLines = this.renderInlineDetail(item, safeWidth)
          listLines.push(...detailLines)
          listHits.push(...detailLines.map((): TaskMouseHit => ({ kind: 'inert' })))
        }
      }
      return { lines: listLines, hits: listHits }
    }
    let window = buildWindow(itemCount, start)
    const assemble = (): { lines: string[]; hits: TaskMouseHit[] } => {
      const out = [...lines]
      const outHits = [...hits]
      if (safeWidth >= 110) {
        const detail = this.detailLines(this.selectedItem())
        const merged: string[] = []
        const mergedHits: TaskMouseHit[] = []
        const detailWidth = Math.max(24, safeWidth - listWidth - 3)
        const max = Math.max(window.lines.length, detail.length)
        for (let i = 0; i < max; i += 1) {
          const left = truncateToWidth(window.lines[i] ?? '', listWidth, '…')
          const leftPad = ' '.repeat(Math.max(0, listWidth - visibleWidth(left)))
          const right = truncateToWidth(detail[i] ?? '', detailWidth, '…')
          merged.push(`${left}${leftPad} ${color.border('│')} ${right}`)
          // The left list cell is the item; the detail pane is inert.
          const windowHit = window.hits[i]
          mergedHits.push(windowHit !== undefined ? { ...windowHit, listWidth } as TaskMouseHit : { kind: 'inert' })
        }
        out.push(...merged)
        outHits.push(...mergedHits)
      } else {
        out.push(...window.lines)
        outHits.push(...window.hits)
      }
      if (rows.length > itemCount) {
        out.push(color.textMuted(`  ${this.selected + 1}/${rows.length}`))
        outHits.push({ kind: 'inert' })
      }
      if (this.refreshError !== undefined) {
        out.push(color.textMuted(truncateToWidth(`  ${refreshErrorText}${retrySuffix}`, safeWidth, '…')))
        outHits.push({ kind: 'inert' })
      }
      out.push('')
      outHits.push({ kind: 'inert' })
      out.push(hintLine)
      outHits.push({ kind: 'inert' })
      return { lines: out, hits: outHits }
    }
    let candidate = assemble()
    // Details, group headers and the detail pane consume physical rows
    // beyond the item count: shrink the selected-preserving window until
    // the whole component fits the live grant, instead of letting the
    // compositor clip the hint or the selected row.
    while (candidate.lines.length > limit && itemCount > 1) {
      itemCount -= 1
      const desired = Math.max(0, this.selected - Math.floor(itemCount / 2))
      start = Math.min(desired, Math.max(0, rows.length - itemCount))
      this.scroll = start
      window = buildWindow(itemCount, start)
      candidate = assemble()
    }
    if (candidate.lines.length <= limit) {
      // The ACTUAL viewport is the window the fit left. Record it BEFORE
      // the exposure ack so viewportItems()/onViewportExpose and the
      // PageUp/PageDown step agree with the rows physically painted — the
      // budget baseline can be larger than what details/sidebar allow.
      this.lastRenderedStart = start
      this.lastRenderedCount = itemCount
      this.hasRenderedViewport = true
      this.exposeViewport()
      this.hitMap = candidate.hits
      return candidate.lines
    }

    // Very short grants: true semantic degradation — search input
    // (searchMode) > selected main > hint > header > group > detail >
    // indicator > blank spacers. The selected main row is never squeezed
    // out by decorative blanks or the header (this path does not keep the
    // chrome prefix unconditionally). The final layout is decided BEFORE
    // the exposure ack: an extreme grant can drop the selected row
    // entirely (a 1-row grant + search mode paints only the search
    // input), and only rows the FINAL layout actually paints may be
    // acknowledged.
    const entries = this.windowEntries(start, itemCount, listWidth)
    const selectedEntry = entries.find(entry => entry.selected)
    const degraded = this.degradedFallback(
      selectedEntry,
      searchRowText,
      searchEmpty,
      headerText,
      rows.length > itemCount ? `  ${this.selected + 1}/${rows.length}` : undefined,
      limit,
      hintLine,
    )
    this.lastRenderedStart = degraded.paintsSelectedMain ? start : 0
    this.lastRenderedCount = degraded.paintsSelectedMain ? 1 : 0
    this.hasRenderedViewport = true
    this.exposeViewport()
    this.hitMap = degraded.hits
    return degraded.lines
  }

  /** True semantic degradation for very short grants. The declared
   * priority (search input > selected main > hint > header > group >
   * detail > indicator) is enforced by INCLUSION — the chrome prefix is
   * rebuilt from the hoisted texts and only kept when it fits after the
   * mandatory content, so the selected main row cannot lose to two
   * decorative blanks + the header. Returns whether the selected main row
   * is actually painted, so the callers ack only what the user saw. */
  private degradedFallback(
    selectedEntry: { group: string | undefined; main: string; details: string[] } | undefined,
    searchRowText: string,
    searchEmpty: boolean,
    headerText: string | undefined,
    indicatorText: string | undefined,
    limit: number,
    hintLine: string,
  ): { lines: string[]; hits: TaskMouseHit[]; paintsSelectedMain: boolean } {
    const mainRow = selectedEntry?.main
    const groupRow = selectedEntry !== undefined && selectedEntry.group !== undefined
      ? color.textMuted(`── ${selectedEntry.group} ──`)
      : undefined
    const detailRows = selectedEntry?.details ?? []
    // A typed query renders plain (the placeholder dims) — main-path parity.
    const searchShown = searchRowText === '' ? '' : (searchEmpty ? color.textDim(searchRowText) : searchRowText)
    // Mandatory content (priority 1-2): search row, then the selected
    // main row; the hint text follows (priority 3).
    const content: string[] = []
    const contentHits: TaskMouseHit[] = []
    if (searchShown !== '') {
      content.push(searchShown)
      contentHits.push({ kind: 'search' })
    }
    if (mainRow !== undefined) {
      content.push(mainRow)
      contentHits.push({ kind: 'item', value: selectedEntry !== undefined ? this.filtered[this.selected]?.value ?? '' : '', index: this.selected })
    }
    if (content.length >= limit) {
      const kept = content.slice(0, limit)
      const keptHits = contentHits.slice(0, limit)
      return { lines: kept, hits: keptHits, paintsSelectedMain: mainRow !== undefined && kept.includes(mainRow) }
    }
    const hintIncluded = content.length + 1 <= limit
    let used = content.length + (hintIncluded ? 1 : 0)
    // Optional chrome (priority 4-7) fills the leftover rows.
    let headerShown = false
    if (headerText !== undefined && used + 1 <= limit) { headerShown = true; used += 1 }
    let groupShown = false
    if (groupRow !== undefined && used + 1 <= limit) { groupShown = true; used += 1 }
    const detailsShown: string[] = []
    for (const detail of detailRows) {
      if (used + 1 > limit) break
      detailsShown.push(detail)
      used += 1
    }
    let indicatorShown = false
    if (indicatorText !== undefined && used + 1 <= limit) { indicatorShown = true; used += 1 }
    // Blank spacers last: only the hint's leading blank rides along.
    const hintBlank = used + 1 <= limit
    const out: string[] = []
    const outHits: TaskMouseHit[] = []
    if (headerShown) {
      out.push(color.textStrong(headerText!))
      outHits.push({ kind: 'inert' })
    }
    if (searchShown !== '') {
      out.push(searchShown)
      outHits.push({ kind: 'search' })
    }
    if (groupShown) {
      out.push(groupRow!)
      outHits.push({ kind: 'inert' })
    }
    if (mainRow !== undefined) {
      out.push(mainRow)
      outHits.push({ kind: 'item', value: this.filtered[this.selected]?.value ?? '', index: this.selected })
    }
    out.push(...detailsShown)
    outHits.push(...detailsShown.map((): TaskMouseHit => ({ kind: 'inert' })))
    if (indicatorShown) {
      out.push(color.textMuted(indicatorText!))
      outHits.push({ kind: 'inert' })
    }
    if (hintIncluded) {
      out.push(...(hintBlank ? ['', hintLine] : [hintLine]))
      outHits.push(...(hintBlank ? [{ kind: 'inert' }, { kind: 'inert' }] : [{ kind: 'inert' }]) as TaskMouseHit[])
    }
    // The main row is always painted in this branch (the extreme branch
    // above was the only path that could drop it).
    return { lines: out, hits: outHits, paintsSelectedMain: mainRow !== undefined }
  }

  /** The visible window as STRUCTURED rows (main + detail lines kept
   * apart), so a tiny-grant fallback can prioritize the selected main row
   * over its detail lines instead of tail-slicing a flat array. The
   * compact-layout inline detail (70-110 wide, selected row only) rides
   * with its entry; the wide-layout side pane is not part of the window. */
  private windowEntries(start: number, count: number, width: number): Array<{
    group: string | undefined
    main: string
    details: string[]
    selected: boolean
  }> {
    const entries: Array<{
      group: string | undefined
      main: string
      details: string[]
      selected: boolean
    }> = []
    const end = Math.min(this.filtered.length, start + count)
    for (let index = start; index < end; index += 1) {
      const item = this.filtered[index]
      if (item === undefined) continue
      const main = this.renderRow(item, index === this.selected, width)[0]!
      const details = index === this.selected && item.kind !== 'view-full'
        ? this.renderInlineDetail(item, width)
        : []
      entries.push({ group: item.group, main, details, selected: index === this.selected })
    }
    return entries
  }

  /** Finalize the empty/no-match assembly against the live grant
   * (setMaxRows contract covers every path): `render().length <= maxRows`
   * with priority search input > no-match message > hint > header > blank
   * spacers, so the hint survives whenever the grant physically allows it
   * (a head-keep slice would cut the hint on a short terminal). The hit
   * map is transformed identically. */
  private finalizeEmpty(lines: string[], hits: TaskMouseHit[]): { lines: string[]; hits: TaskMouseHit[] } {
    if (!Number.isFinite(this.maxRows)) return { lines, hits }
    const limit = Math.max(1, Math.floor(this.maxRows))
    if (lines.length <= limit) return { lines, hits }
    // Blank spacers are the lowest-value rows: drop them first.
    const compact: string[] = []
    const compactHits: TaskMouseHit[] = []
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] !== '') {
        compact.push(lines[index]!)
        compactHits.push(hits[index]!)
      }
    }
    if (compact.length <= limit) return { lines: compact, hits: compactHits }
    // The header is chrome: yield it before any content.
    const withoutHeader = this.options.header === undefined ? compact : compact.slice(1)
    const withoutHeaderHits = this.options.header === undefined ? compactHits : compactHits.slice(1)
    if (withoutHeader.length <= limit) return { lines: withoutHeader, hits: withoutHeaderHits }
    // Extreme grant: keep the head of the HEADER-FREE rows — the search
    // input, then the no-match message. Slicing `compact` here would
    // re-introduce the header and drop the message, which the declared
    // priority places ABOVE the header.
    return { lines: withoutHeader.slice(0, limit), hits: withoutHeaderHits.slice(0, limit) }
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
    const dot = taskStatusColor(item.status)(stateGlyph(item))
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
    // Single-row contract: the main task row owns exactly one physical
    // row, so its label is projected BEFORE measurement/truncation. The
    // raw `item.label` (runtime truth) stays untouched.
    const rowLabel = singlePhysicalLine(item.label)
    const label = this.marquee.render({ key: item.value, text: rowLabel, maxWidth: labelBudget, selected })
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
    // Single-row contract: every semantic line detailLines returns is
    // budgeted as one physical terminal row (the wide side pane and the
    // compact inline detail both truncate these). Dynamic text (label,
    // parentLabel, detail, …) is projected HERE, once, so no embedded
    // CR/LF can leak past the row budget or the hit map. The item's raw
    // fields are never rewritten.
    return lines.map(singlePhysicalLine)
  }

  private renderInlineDetail(item: TaskPanelItem, width: number): string[] {
    const detail = this.detailLines(item).slice(1, 4).join(' · ')
    return [truncateToWidth(`    ${color.textDim(detail)}`, width, '…')]
  }

  private hint(): string {
    if (this.pendingStopValue !== undefined) return 'Y confirm stop · Esc cancel'
    if (this.mode === 'quick') {
      // Navigation-only: advertise EXACTLY the whitelist. Every other key
      // is a consumed no-op, so the hint must not promise one.
      return '↑↓ select · ←→ tree · Tab type · Enter open · Esc close'
    }
    if (this.searchMode) {
      // Search mode owns every printable key as query text — A/S/N/R and
      // the tree arrows are QUERY characters now, never the ordinary task
      // actions. Advertise only what search mode actually does, with the
      // ESCAPE verb FIRST: the hint is one line and a default 80-column
      // terminal truncates the tail — esc back is the most important
      // verb, so it must never be the piece that gets cut off. Shift+Tab
      // is advertised because it now cycles types in reverse here too.
      return 'type to filter · Esc back · ←→ edit · ↑↓ select · Tab/⇧Tab type · Enter open'
    }
    const parts = ['↑↓ select', '←→ tree', 'Enter open', 'Esc close', 'S stop']
    if (this.searchEnabled) parts.push('/ search')
    parts.push('A scope', 'Tab type')
    return parts.join(' · ')
  }
}
