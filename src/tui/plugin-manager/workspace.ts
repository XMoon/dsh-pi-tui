/**
 * The fullscreen Plugin Manager workspace (S4-D1): a PURE PiTui renderer and
 * input owner for the profile-wide official inventory. It paints the four
 * frozen sections (`TUI & Extensions → Official DSH → Third-party →
 * Experimental`), the package Detail, the official install view and the
 * removal confirmation.
 *
 * It owns NO Host read, NO install request id and NO package execution: the
 * ONE `PluginManagerController` owns the official port and the install
 * lifecycle; this component only paints its facts and forwards explicit user
 * intents. Selection, search/filter, focus, scroll offsets, the painted hit
 * map and its revision are per-open state of THIS page (plan §3).
 *
 * It is the layout root of the SAME `TuiAltScreen` lease the Settings workspace
 * uses (both in-place Settings embedding and the direct `/plugins` root), so it
 * never creates a second screen/focus owner.
 *
 * @module @xmoon76/dsh-pi-tui/tui/plugin-manager/workspace
 */

import {
  Input,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { renderActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import type { PluginInstallView, PluginManagerController } from '../../app/plugin-manager/controller.ts'
import {
  PLUGIN_ACTION,
  buildPluginDetailView,
  cardStatusChip,
  cardStatusTone,
  changeSummary,
  maskedSource,
  rowToggleEntryId,
  rowToggleValue,
  type PluginCardView,
  type PluginDetailAction,
  type PluginDetailView,
} from '../../app/plugin-manager/model.ts'

/** The frozen width breakpoint: `>=96` two columns, `<96` one column. */
export const PLUGIN_WORKSPACE_WIDE_MIN_COLUMNS = 96
/** The 2-cell gutter between the two columns (design language §6.3). */
const COLUMN_GAP = 2
/** The right pane keeps at least this many cells in the wide projection. */
const MIN_DETAIL_WIDTH = 24
/** The bounded log tail kept by the controller; the view only windows it. */
const LOG_TAIL_LINES = 40

/** The four local status filters (a view projection, never catalog truth). */
const FILTERS = ['all', 'enabled', 'installed', 'available'] as const
type PluginListFilter = typeof FILTERS[number]

const FILTER_LABELS: Record<PluginListFilter, string> = {
  all: 'All',
  enabled: 'Enabled',
  installed: 'Installed',
  available: 'Available',
}

/** Surface-local keys (the handler and the Action Bar read the same table). */
const WORKSPACE_KEYS = {
  search: '/',
  install: 'i',
  refresh: 'r',
  copy: 'c',
  logs: 'l',
  stop: 's',
} as const

const INSTALL_ACTION = {
  inspect: 'install:inspect',
  install: 'install:install',
  edit: 'install:edit',
  stop: 'install:stop',
  hide: 'install:hide',
  approve: 'install:approve',
  reconcile: 'install:reconcile',
  new: 'install:new',
  back: 'install:back',
} as const

const CONFIRM_ACTION = {
  remove: 'confirm:remove',
  cancel: 'confirm:cancel',
} as const

/** Which page-local view is showing. */
type PluginWorkspaceView = 'list' | 'details' | 'install' | 'confirm'

/** One painted hit target of the LAST frame (never a screen-index authority). */
interface HitTarget {
  readonly kind: 'card' | 'action' | 'filter' | 'pane' | 'search'
  readonly value: string
  readonly row: number
  readonly startCol: number
  readonly endCol: number
}

interface PressedGesture {
  readonly target: HitTarget
  readonly revision: number
  readonly view: PluginWorkspaceView
  readonly selectedValue: string | undefined
  readonly columns: number
  readonly rows: number
}

/** One line of the list projection. */
interface ListEntry {
  readonly kind: 'section' | 'subheader' | 'card' | 'empty'
  readonly label: string
  readonly value?: string
  readonly card?: PluginCardView
}

/** The per-frame chrome budget (design language §8). */
interface ChromePlan {
  readonly width: number
  readonly rows: number
  readonly wide: boolean
  readonly headerRows: number
  readonly metaRows: number
  readonly ruleRows: number
  readonly noticeRows: number
  readonly actionRows: number
  readonly bodyRows: number
  readonly leftWidth: number
  readonly rightWidth: number
}

/** One detail/install/confirm action line the frame really painted. */
interface PaintedActionLine {
  readonly value: string
  readonly line: number
}

/** The pure renderer/input owner of the Plugin Manager page. */
export class PluginManagerWorkspacePanel implements Component, Focusable {
  private readonly controller: PluginManagerController
  private readonly intents: PluginManagerWorkspacePanelIntents
  private view: PluginWorkspaceView = 'list'
  private searchEditing = false
  private query = ''
  private filter: PluginListFilter = 'all'
  private selectedValue: string | undefined
  private focus: 'list' | 'details' = 'list'
  private listOffset = 0
  private detailOffset = 0
  private detailSelection = 0
  /** Reveal the selected Detail action on the NEXT frame only (entering the
   * page keeps its identity/top visible; moving the cursor brings the action in). */
  private detailReveal = false
  private confirmSelection = 1
  private installSelection = 0
  private readonly searchInput = new Input({ prompt: '' })
  private readonly specInput = new Input({ prompt: '' })
  private readonly registryInput = new Input({ prompt: '' })
  private installFocus: 'spec' | 'registry' = 'spec'
  private registryIndex = 0
  private customRegistry = false
  private logsExpanded = false
  private logOffset = 0
  private _focused = false
  private disposed = false
  private revision = 0
  private paintedTargets: readonly HitTarget[] = []
  private paintedRevision = -1
  private paintedChrome: ChromePlan | undefined
  /** Whether the selected Detail action was inside the last painted viewport. */
  private paintedDetailSelectionVisible = false
  /** The action values actually painted in the last install/confirm frame. */
  private paintedInstallActions: ReadonlySet<string> = new Set()
  /** The install actions admitted by the CURRENT frame (approval is removed
   * when its build-script risk cannot be fully shown). */
  private currentInstallActions: readonly PluginDetailAction[] = []
  private paintedConfirmActions: ReadonlySet<string> = new Set()
  private pressedGesture: PressedGesture | undefined
  private lastRenderWidth = -1
  private lastRenderRows = -1
  private lastModelKey: string | undefined
  private lastView: PluginWorkspaceView | undefined
  private lastPhase: string | undefined
  private lastNotice: string | undefined
  private lastAppNotice: string | undefined
  private lastStatusState: 'loading' | 'ready' | 'error' | undefined
  private lastSelectedValue: string | undefined
  private lastFocus: 'list' | 'details' | undefined
  private lastFilter: PluginListFilter | undefined
  private lastQuery: string | undefined
  private readonly onDispose: (() => void) | undefined
  private disposeNotified = false

  constructor(
    controller: PluginManagerController,
    intents: PluginManagerWorkspacePanelIntents,
    options: { readonly onDispose?: () => void } = {},
  ) {
    this.controller = controller
    this.intents = intents
    this.onDispose = options.onDispose
    // A dispatched/failed/unknown/done attempt reopens on the SAME request
    // id/controller; only the explicit New-install action may replace it.
    if (controller.hasResumableInstall()) this.view = 'install'
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.syncInputFocus()
  }

  invalidate(): void {
    this.searchInput.invalidate()
    this.specInput.invalidate()
    this.registryInput.invalidate()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.searchInput.focused = false
    this.specInput.focused = false
    this.registryInput.focused = false
    if (this.disposeNotified) return
    this.disposeNotified = true
    this.onDispose?.()
  }

  /** The current page-local view (tests/diagnostics read it). */
  currentView(): PluginWorkspaceView {
    return this.view
  }

  /** The stable selected card value (tests/diagnostics read it). */
  selectedCardValue(): string | undefined {
    return this.selectedValue
  }

  // ── input ────────────────────────────────────────────────────────────────

  handleInput(data: string): void {
    if (this.disposed) return
    this.syncInputFocus()
    if (matchesKey(data, 'escape')) {
      this.handleEscape()
      return
    }
    if (this.searchEditing) {
      this.handleSearchInput(data)
      return
    }
    if (this.view === 'install') {
      this.handleInstallInput(data)
      return
    }
    if (this.view === 'confirm') {
      this.handleConfirmInput(data)
      return
    }
    if (this.view === 'details') {
      this.handleDetailsInput(data)
      return
    }
    this.handleListInput(data)
  }

  /** The panel is the layout root: wheel events route to the pane under the
   * pointer; press/click arrive through the alt screen's cell path. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    if (event.type !== 'wheel') return undefined
    const delta = event.wheelDelta ?? 0
    if (delta === 0) return undefined
    // A resize (or any state change) that has not painted yet must not scroll a
    // pane from the previous geometry; consume the wheel and wait for the frame.
    if (!this.frameIsCurrent()) return { handled: true }
    const plan = this.paintedChrome
    if (plan === undefined) return undefined
    if (plan.bodyRows <= 0) return undefined
    const bodyTop = this.bodyTop(plan)
    const inBody = event.y >= bodyTop && event.y < bodyTop + plan.bodyRows
    if (!inBody) return undefined
    if (this.view === 'details' || this.view === 'confirm' || this.view === 'install') {
      if (this.view === 'install') {
        this.scrollInstall(delta, plan)
        this.bumpRevision()
        this.intents.requestRender()
        return { handled: true }
      }
      this.detailOffset = Math.max(0, this.detailOffset + delta)
      this.bumpRevision()
      this.intents.requestRender()
      return { handled: true }
    }
    if (plan.wide && event.x >= plan.leftWidth + COLUMN_GAP) {
      this.detailOffset = Math.max(0, this.detailOffset + delta)
      this.bumpRevision()
      this.intents.requestRender()
      return { handled: true }
    }
    this.listOffset = Math.max(0, this.listOffset + delta)
    this.bumpRevision()
    this.intents.requestRender()
    return { handled: true }
  }

  onCellPress(x: number, y: number): void {
    if (this.disposed) return
    // Admission is against the LAST PAINTED frame: a resize/state change whose
    // repaint has not run must not record a target from the stale hit map.
    if (!this.frameIsCurrent()) {
      this.pressedGesture = undefined
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    const target = this.targetAt(x, y)
    this.pressedGesture = target === undefined
      ? undefined
      : {
        target,
        revision: this.revision,
        view: this.view,
        selectedValue: this.selectedValue,
        columns: this.intents.columns(),
        rows: this.intents.rows(),
      }
  }

  onCellClick(x: number, y: number): void {
    if (this.disposed) return
    const pressed = this.pressedGesture
    this.pressedGesture = undefined
    if (!this.frameIsCurrent()) {
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    const target = this.targetAt(x, y)
    if (pressed === undefined || target === undefined) return
    // The gesture must still resolve to the SAME painted target AND the same
    // revision/view/selection/geometry: a refresh, filter/search change, page
    // switch OR a resize (even before its repaint) refuses the click.
    if (
      this.revision !== pressed.revision
      || this.view !== pressed.view
      || this.selectedValue !== pressed.selectedValue
      || this.intents.columns() !== pressed.columns
      || this.intents.rows() !== pressed.rows
      || target.kind !== pressed.target.kind
      || target.value !== pressed.target.value
      || target.row !== pressed.target.row
      || target.startCol !== pressed.target.startCol
      || target.endCol !== pressed.target.endCol
    ) {
      return
    }
    this.activateTarget(target)
  }

  // ── list navigation ──────────────────────────────────────────────────────

  private handleListInput(data: string): void {
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.moveSelection(-1)
      return
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.moveSelection(1)
      return
    }
    if (matchesKey(data, 'pageUp')) {
      this.moveSelection(-this.listPageStep())
      return
    }
    if (matchesKey(data, 'pageDown')) {
      this.moveSelection(this.listPageStep())
      return
    }
    if (matchesKey(data, 'home')) {
      this.selectFirst()
      return
    }
    if (matchesKey(data, 'end')) {
      this.selectLast()
      return
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'right')) {
      this.enterDetails()
      return
    }
    if (matchesKey(data, 'tab')) {
      this.cycleFilter(1)
      return
    }
    if (data === WORKSPACE_KEYS.search) {
      this.beginSearch()
      return
    }
    if (data === WORKSPACE_KEYS.install || data === WORKSPACE_KEYS.install.toUpperCase()) {
      this.openInstallView()
      return
    }
    if (data === WORKSPACE_KEYS.refresh || data === WORKSPACE_KEYS.refresh.toUpperCase()) {
      this.controller.refresh()
      this.intents.requestRender()
    }
  }

  /** `i`: reopen the SAME attempt (including failed/unknown/done), or create
   * a fresh editor only when no attempt exists. */
  private openInstallView(): void {
    const existing = this.controller.installView()
    if (existing === undefined && !this.controller.beginManualInstall()) return
    const install = this.controller.installView()
    if (install === undefined) return
    this.view = 'install'
    this.installFocus = 'spec'
    if (existing === undefined) {
      this.resetInstallInputs()
    } else if (install.phase === 'editing' && this.specInput.getValue() === '' && install.spec !== '') {
      // A page recreated over an existing editor (or a hidden inspect) seeds
      // the controller's exact spec/registry instead of a blank form.
      this.seedInstallInputs(install)
    }
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** The explicit `n`/New install action; this is the only path allowed to
   * replace a terminal attempt's evidence with a fresh request. */
  private startNewInstall(): void {
    if (!this.controller.beginManualInstall()) return
    this.view = 'install'
    this.installFocus = 'spec'
    this.resetInstallInputs()
    this.bumpRevision()
    this.intents.requestRender()
  }

  private resetInstallInputs(): void {
    this.specInput.setValue('')
    this.registryInput.setValue('')
    this.registryIndex = 0
    this.customRegistry = false
  }

  /** Seed the editor widgets from the controller's exact editing attempt. */
  private seedInstallInputs(install: PluginInstallView): void {
    // Host-provided spec/registry are display-bound text: project them before
    // they reach the Input renderer, never only at the eventual Host call.
    this.specInput.setValue(sanitizedPhysicalLine(install.spec))
    const options = this.controller.registryOptions()
    if (install.registry === null) {
      this.registryIndex = 0
      this.customRegistry = false
      this.registryInput.setValue('')
      return
    }
    const index = options.findIndex(option => option.value === install.registry)
    if (index >= 0) {
      this.registryIndex = index
      this.customRegistry = false
      this.registryInput.setValue('')
    } else {
      this.registryIndex = options.length
      this.customRegistry = true
      this.registryInput.setValue(sanitizedPhysicalLine(install.registry))
    }
  }

  private handleDetailsInput(data: string): void {
    if (matchesKey(data, 'left')) {
      this.leaveDetails()
      return
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.moveDetailSelection(-1)
      return
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.moveDetailSelection(1)
      return
    }
    if (matchesKey(data, 'pageUp')) {
      this.detailOffset = Math.max(0, this.detailOffset - this.detailPageStep())
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'pageDown')) {
      this.detailOffset += this.detailPageStep()
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'home')) {
      this.detailOffset = 0
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'enter')) {
      this.activateDetailSelection()
      return
    }
    if (data === WORKSPACE_KEYS.copy || data === WORKSPACE_KEYS.copy.toUpperCase()) {
      this.copyCardIdentity()
      return
    }
    if (data === WORKSPACE_KEYS.search) {
      this.view = 'list'
      this.focus = 'list'
      this.beginSearch()
      return
    }
    if (data === WORKSPACE_KEYS.install || data === WORKSPACE_KEYS.install.toUpperCase()) {
      this.openInstallView()
      return
    }
    if (data === WORKSPACE_KEYS.refresh || data === WORKSPACE_KEYS.refresh.toUpperCase()) {
      this.controller.refresh()
      this.intents.requestRender()
    }
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, 'enter')) {
      this.searchEditing = false
      this.syncInputFocus()
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    this.searchInput.handleInput(data)
    const raw = this.searchInput.getValue()
    const next = sanitizedPhysicalLine(raw)
    if (next !== raw) this.searchInput.setValue(next)
    if (next !== this.query) {
      this.query = next
      this.renarrowSelection()
      this.bumpRevision()
      this.intents.requestRender()
    }
  }

  private handleConfirmInput(data: string): void {
    if (matchesKey(data, 'up') || matchesKey(data, 'left')) {
      this.confirmSelection = 0
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'right') || matchesKey(data, 'tab')) {
      this.confirmSelection = 1
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'enter')) {
      this.activateConfirmSelection()
    }
  }

  private handleInstallInput(data: string): void {
    const install = this.controller.installView()
    if (install === undefined) {
      this.view = 'list'
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    if (install.phase === 'editing') {
      if (matchesKey(data, 'tab')) {
        this.installFocus = this.installFocus === 'spec' ? 'registry' : 'spec'
        this.syncInputFocus()
        this.bumpRevision()
        this.intents.requestRender()
        return
      }
      if (this.installFocus === 'spec') {
        if (matchesKey(data, 'enter')) {
          if (!this.frameIsCurrent() || !this.paintedInstallActions.has(INSTALL_ACTION.inspect)) return
          this.submitInspect()
          return
        }
        this.specInput.handleInput(data)
        this.sanitizeSpecInput()
        this.intents.requestRender()
        return
      }
      if (this.customRegistry) {
        if (matchesKey(data, 'enter')) {
          this.submitInspect()
          return
        }
        this.registryInput.handleInput(data)
        this.sanitizeRegistryInput()
        this.intents.requestRender()
        return
      }
      if (matchesKey(data, 'up')) {
        this.cycleRegistry(-1)
        return
      }
      if (matchesKey(data, 'down')) {
        this.cycleRegistry(1)
        return
      }
      if (matchesKey(data, 'enter')) {
        this.submitInspect()
      }
      return
    }
    if (install.phase === 'inspecting') {
      if (matchesKey(data, 'enter')) this.controller.editInstall()
      return
    }
    if (install.phase === 'confirm') {
      if (matchesKey(data, 'enter')) {
        if (install.inspection?.status === 'accepted') {
          if (!this.frameIsCurrent() || !this.paintedInstallActions.has(INSTALL_ACTION.install)) return
          this.controller.confirmInstall()
        } else this.controller.editInstall()
      }
      return
    }
    if (install.phase === 'starting' || install.phase === 'installing' || install.phase === 'applying' || install.phase === 'cancelling') {
      if (data === WORKSPACE_KEYS.stop || data === WORKSPACE_KEYS.stop.toUpperCase()) {
        this.controller.cancelInstall()
        return
      }
      if (data === WORKSPACE_KEYS.logs || data === WORKSPACE_KEYS.logs.toUpperCase()) {
        this.logsExpanded = !this.logsExpanded
        this.logOffset = 0
        this.bumpRevision()
        this.intents.requestRender()
        return
      }
      if (data === WORKSPACE_KEYS.copy || data === WORKSPACE_KEYS.copy.toUpperCase()) {
        this.copyInstallDiagnostics()
        return
      }
      if (matchesKey(data, 'up')) {
        this.scrollInstall(-1, this.paintedChrome)
        this.intents.requestRender()
        return
      }
      if (matchesKey(data, 'down')) {
        this.scrollInstall(1, this.paintedChrome)
        this.intents.requestRender()
        return
      }
      if (matchesKey(data, 'enter')) this.activateInstallSelection()
      return
    }
    // done / failed / unknown: an explicit action list.
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.moveInstallSelection(-1)
      return
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.moveInstallSelection(1)
      return
    }
    if (matchesKey(data, 'enter')) {
      this.activateInstallSelection()
      return
    }
    if (data === 'n' || data === 'N') {
      this.startNewInstall()
      return
    }
    if (data === WORKSPACE_KEYS.logs || data === WORKSPACE_KEYS.logs.toUpperCase()) {
      this.logsExpanded = !this.logsExpanded
      this.logOffset = 0
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    if (data === WORKSPACE_KEYS.copy || data === WORKSPACE_KEYS.copy.toUpperCase()) {
      this.copyInstallDiagnostics()
    }
  }

  private handleEscape(): void {
    if (this.searchEditing) {
      this.query = ''
      this.searchInput.setValue('')
      this.searchEditing = false
      this.syncInputFocus()
      this.renarrowSelection()
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    if (this.view === 'install') {
      const install = this.controller.installView()
      if (install !== undefined && (install.phase === 'inspecting' || install.phase === 'confirm')) {
        this.controller.editInstall()
        return
      }
      this.leaveInstall()
      return
    }
    if (this.view === 'confirm') {
      this.controller.cancelRemove()
      this.view = 'details'
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    if (this.view === 'details') {
      this.leaveDetails()
      return
    }
    this.controller.requestClose()
  }

  // ── view transitions ─────────────────────────────────────────────────────

  private enterDetails(): void {
    if (this.selectedValue === undefined) return
    this.view = 'details'
    this.focus = 'details'
    this.detailOffset = 0
    this.detailSelection = 0
    this.detailReveal = false
    this.bumpRevision()
    this.intents.requestRender()
  }

  private leaveDetails(): void {
    this.view = 'list'
    this.focus = 'list'
    this.detailReveal = false
    this.bumpRevision()
    this.intents.requestRender()
  }

  private leaveInstall(): void {
    // Leaving the install VIEW never cancels the Host operation: the request id
    // and controller survive, and `i` reopens the SAME view/request.
    this.controller.hideInstall()
    this.view = 'list'
    this.focus = 'list'
    this.searchEditing = false
    this.bumpRevision()
    this.intents.requestRender()
  }

  private beginSearch(): void {
    this.searchEditing = true
    this.searchInput.setValue(this.query)
    this.syncInputFocus()
    this.bumpRevision()
    this.intents.requestRender()
  }

  private cycleFilter(delta: number): void {
    const index = FILTERS.indexOf(this.filter)
    const next = FILTERS[(index + delta + FILTERS.length) % FILTERS.length]!
    if (next === this.filter) return
    const previousCards = this.filteredCards(this.controller.model())
    const previousIndex = Math.max(0, previousCards.findIndex(card => card.value === this.selectedValue))
    this.filter = next
    const cards = this.filteredCards(this.controller.model())
    this.selectedValue = cards[Math.min(previousIndex, Math.max(0, cards.length - 1))]?.value
    this.detailSelection = 0
    this.detailOffset = 0
    this.bumpRevision()
    this.intents.requestRender()
  }

  private moveSelection(delta: number): void {
    const cards = this.filteredCards(this.controller.model())
    if (cards.length === 0) return
    const index = Math.max(0, cards.findIndex(card => card.value === this.selectedValue))
    const next = Math.min(Math.max(0, index + delta), cards.length - 1)
    const card = cards[next]
    if (card === undefined || card.value === this.selectedValue) return
    this.selectedValue = card.value
    this.detailOffset = 0
    this.detailSelection = 0
    this.bumpRevision()
    this.intents.requestRender()
  }

  private selectFirst(): void {
    const cards = this.filteredCards(this.controller.model())
    const first = cards[0]
    if (first === undefined || first.value === this.selectedValue) return
    this.selectedValue = first.value
    this.detailOffset = 0
    this.detailSelection = 0
    this.bumpRevision()
    this.intents.requestRender()
  }

  private selectLast(): void {
    const cards = this.filteredCards(this.controller.model())
    const last = cards[cards.length - 1]
    if (last === undefined || last.value === this.selectedValue) return
    this.selectedValue = last.value
    this.detailOffset = 0
    this.detailSelection = 0
    this.bumpRevision()
    this.intents.requestRender()
  }

  private moveDetailSelection(delta: number): void {
    const card = this.selectedCard()
    if (card === undefined) return
    const detail = this.detailView(card)
    if (detail.actions.length === 0) return
    const next = Math.min(Math.max(0, this.detailSelection + delta), detail.actions.length - 1)
    if (next === this.detailSelection) return
    this.detailSelection = next
    this.detailReveal = true
    this.bumpRevision()
    this.intents.requestRender()
  }

  private moveInstallSelection(delta: number): void {
    const actions = this.installActions()
    if (actions.length === 0) return
    const next = Math.min(Math.max(0, this.installSelection + delta), actions.length - 1)
    if (next === this.installSelection) return
    this.installSelection = next
    this.bumpRevision()
    this.intents.requestRender()
  }

  // ── activation (keyboard and mouse share this one admission path) ────────

  private activateTarget(target: HitTarget): void {
    switch (target.kind) {
      case 'search':
        this.beginSearch()
        return
      case 'filter': {
        const next = target.value as PluginListFilter
        if (next === this.filter) return
        const previousCards = this.filteredCards(this.controller.model())
        const previousIndex = Math.max(0, previousCards.findIndex(card => card.value === this.selectedValue))
        this.filter = next
        const cards = this.filteredCards(this.controller.model())
        this.selectedValue = cards[Math.min(previousIndex, Math.max(0, cards.length - 1))]?.value
        this.bumpRevision()
        this.intents.requestRender()
        return
      }
      case 'pane':
        this.focus = target.value === 'details' ? 'details' : 'list'
        this.view = target.value === 'details' ? 'details' : 'list'
        this.bumpRevision()
        this.intents.requestRender()
        return
      case 'card':
        if (target.value !== this.selectedValue) {
          this.selectedValue = target.value
          this.detailOffset = 0
          this.detailSelection = 0
          this.bumpRevision()
          this.intents.requestRender()
          return
        }
        this.enterDetails()
        return
      case 'action':
        this.dispatchAction(target.value)
    }
  }

  private dispatchAction(value: string): void {
    const card = this.selectedCard()
    const rowEntry = rowToggleEntryId(value)
    if (rowEntry !== undefined) {
      if (card !== undefined) this.controller.toggleRow(card.value, rowEntry)
      return
    }
    switch (value) {
      case PLUGIN_ACTION.back:
        this.leaveDetails()
        return
      case PLUGIN_ACTION.toggle:
        if (card !== undefined) this.controller.toggleCard(card.value)
        return
      case PLUGIN_ACTION.remove:
        if (card !== undefined && this.controller.requestRemove(card.value)) {
          this.view = 'confirm'
          this.confirmSelection = 1
          this.bumpRevision()
          this.intents.requestRender()
        }
        return
      case PLUGIN_ACTION.officialInstall: {
        if (card === undefined) return
        const detail = this.detailView(card)
        const action = detail.actions.find(candidate => candidate.value === PLUGIN_ACTION.officialInstall)
        if (action !== undefined && !action.enabled) {
          this.controller.explain(action.reason ?? 'this install action is not available')
          return
        }
        if (this.controller.beginOfficialInstall(card.value)) {
          this.view = 'install'
          this.installFocus = 'spec'
          this.bumpRevision()
          this.intents.requestRender()
        }
        return
      }
      case INSTALL_ACTION.inspect:
        this.submitInspect()
        return
      case INSTALL_ACTION.install:
        if (!this.frameIsCurrent() || !this.paintedInstallActions.has(INSTALL_ACTION.install)) return
        this.controller.confirmInstall()
        return
      case INSTALL_ACTION.edit:
      case INSTALL_ACTION.back:
        this.controller.editInstall()
        return
      case INSTALL_ACTION.stop:
        this.controller.cancelInstall()
        return
      case INSTALL_ACTION.hide:
        this.leaveInstall()
        return
      case INSTALL_ACTION.approve:
        this.controller.approvePendingBuilds()
        return
      case INSTALL_ACTION.reconcile:
        this.controller.reconcileInstall()
        return
      case INSTALL_ACTION.new:
        this.startNewInstall()
        return
      case CONFIRM_ACTION.remove:
        this.controller.confirmRemove()
        this.view = 'details'
        this.bumpRevision()
        this.intents.requestRender()
        return
      case CONFIRM_ACTION.cancel:
        this.controller.cancelRemove()
        this.view = 'details'
        this.bumpRevision()
        this.intents.requestRender()
        return
      default:
        return
    }
  }

  private activateDetailSelection(): void {
    const card = this.selectedCard()
    if (card === undefined) return
    // The keyboard action is admitted only when the CURRENT frame really
    // painted it: a resize/scroll that left it offscreen reveals it first.
    if (!this.frameIsCurrent() || !this.paintedDetailSelectionVisible) {
      this.detailReveal = true
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    const detail = this.detailView(card)
    const action = detail.actions[Math.min(this.detailSelection, detail.actions.length - 1)]
    if (action === undefined) return
    if (!action.enabled) {
      this.controller.explain(action.reason ?? 'this action is not available')
      return
    }
    this.dispatchAction(action.value)
  }

  private activateConfirmSelection(): void {
    const value = this.confirmSelection === 0 ? CONFIRM_ACTION.remove : CONFIRM_ACTION.cancel
    // Only the action this frame actually painted may be invoked from the
    // keyboard; a stale/short frame does not grant a hidden Remove/Cancel.
    if (!this.frameIsCurrent() || !this.paintedConfirmActions.has(value)) return
    this.dispatchAction(value)
  }

  private activateInstallSelection(): void {
    const actions = this.currentInstallActions
    const action = actions[Math.min(this.installSelection, Math.max(0, actions.length - 1))]
    if (action === undefined) return
    if (!this.frameIsCurrent() || !this.paintedInstallActions.has(action.value)) return
    if (!action.enabled) {
      this.controller.explain(action.reason ?? 'this action is not available')
      return
    }
    this.dispatchAction(action.value)
  }

  private submitInspect(): void {
    // The Inspect action is admitted only from the frame that painted it.
    if (!this.frameIsCurrent() || !this.paintedInstallActions.has(INSTALL_ACTION.inspect)) return
    const registry = this.chosenRegistry()
    this.controller.inspect(this.specInput.getValue(), registry)
    this.intents.requestRender()
  }

  private cycleRegistry(delta: number): void {
    const options = this.controller.registryOptions()
    const total = options.length + 1
    this.registryIndex = ((this.registryIndex + delta) % total + total) % total
    this.customRegistry = this.registryIndex === options.length
    this.syncInputFocus()
    this.bumpRevision()
    this.intents.requestRender()
  }

  private chosenRegistry(): string | null {
    if (this.customRegistry) return this.registryInput.getValue().trim()
    return this.controller.registryOptions()[this.registryIndex]?.value ?? null
  }

  private copyCardIdentity(): void {
    const card = this.selectedCard()
    if (card === undefined) return
    const payload = card.source === undefined
      ? card.name
      : `${card.name}\nsource: ${maskedSource(card.source)}`
    this.intents.onCopy(payload)
  }

  private copyInstallDiagnostics(): void {
    const install = this.controller.installView()
    if (install === undefined) return
    const outcome = install.outcome
    const summary = outcome === undefined ? undefined : sanitizedPhysicalLine(changeSummary(outcome))
    const message = install.message === undefined ? undefined : sanitizedPhysicalLine(install.message)
    const output = outcome?.packageResult?.output
    const headers = [
      ...(message === undefined || message === summary ? [] : [message]),
      ...(summary === undefined ? [] : [summary]),
      ...(outcome?.approvedBuilds === undefined ? [] : [
        `approved build scripts: ${outcome.approvedBuilds.map(line => sanitizedPhysicalLine(line)).join(', ')}`,
      ]),
      ...(outcome?.registries === undefined ? [] : [
        `registries: ${outcome.registries.map(registry => maskedSource(sanitizedPhysicalLine(registry ?? 'pnpm default'))).join(', ')}`,
      ]),
    ]
    // The raw Host output/log is the copy authority (byte-exact), never the
    // display projection: controls, tabs, CR/LF and repeated lines survive.
    const diagnostic = output === undefined || output === '' ? install.log.join('\n') : output
    if (headers.length === 0 && diagnostic === '') return
    this.intents.onCopy(headers.length === 0 ? diagnostic : `${headers.join('\n')}\n${diagnostic}`)
  }

  private sanitizeSpecInput(): void {
    const raw = this.specInput.getValue()
    const clean = sanitizedPhysicalLine(raw)
    if (clean !== raw) this.specInput.setValue(clean)
  }

  private sanitizeRegistryInput(): void {
    const raw = this.registryInput.getValue()
    const clean = sanitizedPhysicalLine(raw)
    if (clean !== raw) this.registryInput.setValue(clean)
  }

  private syncInputFocus(): void {
    const install = this.controller.installView()
    const editing = this.view === 'install' && install?.phase === 'editing'
    this.searchInput.focused = this._focused && this.searchEditing
    this.specInput.focused = this._focused && editing && this.installFocus === 'spec'
    this.registryInput.focused = this._focused && editing && this.installFocus === 'registry' && this.customRegistry
  }

  // ── model helpers ────────────────────────────────────────────────────────

  private selectedCard(): PluginCardView | undefined {
    if (this.selectedValue === undefined) return undefined
    return this.controller.card(this.selectedValue)
  }

  /** The pure Detail projection with the profile's current exemptions. */
  private detailView(card: PluginCardView): PluginDetailView {
    return buildPluginDetailView(card, this.controller.model().exemptions)
  }

  private static matchesQuery(card: PluginCardView, query: string): boolean {
    const needle = query.trim().toLowerCase()
    if (needle === '') return true
    const haystack = [
      card.name,
      card.title ?? '',
      card.description ?? '',
      card.source ?? '',
      card.installTarget?.spec ?? '',
      ...card.rows.flatMap(row => [row.moduleName, row.title ?? '', row.description ?? '']),
    ].join('\n').toLowerCase()
    return haystack.includes(needle)
  }

  private matchesFilter(card: PluginCardView): boolean {
    switch (this.filter) {
      case 'enabled': return card.enabled && card.availability !== 'missing'
      case 'installed': return card.installed && card.availability !== 'missing'
      case 'available': return card.availability === 'missing' || !card.enabled
      default: return true
    }
  }

  private filteredCards(model: ReturnType<PluginManagerController['model']>): readonly PluginCardView[] {
    const out: PluginCardView[] = []
    for (const section of model.sections) {
      for (const card of section.cards) {
        if (this.matchesFilter(card) && PluginManagerWorkspacePanel.matchesQuery(card, this.query)) out.push(card)
      }
    }
    return out
  }

  /** A filter/search edit keeps the selected package identity when it is still
   * visible; otherwise the nearest surviving index becomes the selection. */
  private renarrowSelection(): void {
    const cards = this.filteredCards(this.controller.model())
    if (cards.some(card => card.value === this.selectedValue)) return
    this.selectedValue = cards[0]?.value
    this.detailSelection = 0
    this.detailOffset = 0
  }

  private ensureSelection(): void {
    const cards = this.filteredCards(this.controller.model())
    if (cards.length === 0) {
      if (this.selectedValue !== undefined) {
        this.selectedValue = undefined
        this.bumpRevision()
      }
      if (this.view === 'details') {
        this.view = 'list'
        this.focus = 'list'
        this.detailSelection = 0
        this.detailOffset = 0
        this.detailReveal = false
        this.bumpRevision()
      }
      return
    }
    if (this.selectedValue !== undefined && cards.some(card => card.value === this.selectedValue)) return
    // The previously open card is gone (a successful removal or an external
    // change): leave a Detail that would otherwise silently show a DIFFERENT
    // package, and re-anchor the list on the nearest surviving identity.
    if (this.view === 'details') {
      this.view = 'list'
      this.focus = 'list'
      this.detailSelection = 0
      this.detailOffset = 0
      this.detailReveal = false
    }
    this.selectedValue = cards[0]!.value
    this.detailSelection = 0
    this.detailOffset = 0
    this.bumpRevision()
  }

  private listEntries(model: ReturnType<PluginManagerController['model']>): ListEntry[] {
    const entries: ListEntry[] = []
    const status = this.controller.status()
    if (model.cards.length === 0 && status.state !== 'ready') {
      return [{
        kind: 'empty',
        label: status.state === 'error' ? 'Plugin inventory unavailable' : 'Loading plugins…',
      }]
    }
    for (const section of model.sections) {
      const cards = section.cards.filter(card =>
        this.matchesFilter(card) && PluginManagerWorkspacePanel.matchesQuery(card, this.query))
      if (cards.length === 0) {
        // The unfiltered view keeps every frozen section discoverable with an
        // honest empty state; a filter/query drops the empty group instead.
        if (this.filter === 'all' && this.query.trim() === '') {
          entries.push({ kind: 'section', label: section.label })
          entries.push({
            kind: 'empty',
            label: status.state === 'error' && model.cards.length === 0
              ? 'Plugin inventory unavailable'
              : status.state === 'loading' && model.cards.length === 0
                ? 'Loading plugins…'
                : 'No plugins',
          })
        }
        continue
      }
      entries.push({ kind: 'section', label: section.label })
      if (section.id === 'third-party') {
        const proven = cards.filter(card => !card.unverified)
        const unverified = cards.filter(card => card.unverified)
        for (const card of proven) entries.push({ kind: 'card', label: card.name, value: card.value, card })
        if (unverified.length > 0) {
          entries.push({ kind: 'subheader', label: 'Unverified origin' })
          for (const card of unverified) entries.push({ kind: 'card', label: card.name, value: card.value, card })
        }
      } else {
        for (const card of cards) entries.push({ kind: 'card', label: card.name, value: card.value, card })
      }
    }
    return entries
  }

  private listPageStep(): number {
    const plan = this.paintedChrome
    return Math.max(1, (plan?.bodyRows ?? 5) - 1)
  }

  private detailPageStep(): number {
    return Math.max(1, (this.paintedChrome?.bodyRows ?? 5) - 1)
  }

  private installActions(): readonly PluginDetailAction[] {
    const install = this.controller.installView()
    if (install === undefined) return []
    const actions: PluginDetailAction[] = []
    if (install.phase === 'editing') {
      actions.push({ value: INSTALL_ACTION.inspect, label: 'Inspect', enabled: true, tone: 'normal' })
    } else if (install.phase === 'inspecting') {
      // Esc back is the only exit; a secondary Back row would not be the
      // action Enter dispatches in this phase.
    } else if (install.phase === 'confirm') {
      if (install.inspection?.status === 'accepted') {
        actions.push({ value: INSTALL_ACTION.install, label: 'Install', enabled: true, tone: 'normal' })
      }
      // A refused inspection and the confirm step both exit with Esc edit.
    } else if (install.phase === 'starting' || install.phase === 'installing' || install.phase === 'applying' || install.phase === 'cancelling') {
      if (install.cancellable) {
        actions.push({ value: INSTALL_ACTION.stop, label: 'Stop installation', enabled: true, tone: 'warning' })
      }
      actions.push({ value: INSTALL_ACTION.hide, label: 'Hide install view', enabled: true, tone: 'normal' })
    } else {
      const pending = this.controller.approvableBuilds()
      if (pending !== undefined) {
        actions.push({
          value: INSTALL_ACTION.approve,
          label: `Approve and retry ${pending.join(', ')}`,
          enabled: true,
          tone: 'warning',
        })
      }
      if (this.controller.canReconcileInstall()) {
        actions.push({ value: INSTALL_ACTION.reconcile, label: 'Check installation status', enabled: true, tone: 'normal' })
      }
      if (install.phase !== 'unknown') {
        actions.push({ value: INSTALL_ACTION.new, label: 'New install', enabled: true, tone: 'normal' })
      }
      actions.push({ value: INSTALL_ACTION.hide, label: 'Back', enabled: true, tone: 'normal' })
    }
    return actions
  }

  private scrollInstall(delta: number, plan: ChromePlan | undefined): void {
    const install = this.controller.installView()
    if (install === undefined) return
    if (install.phase === 'starting' || install.phase === 'installing' || install.phase === 'applying' || install.phase === 'cancelling') {
      const visible = this.visibleLogLines(plan)
      if (this.logsExpanded) {
        const max = Math.max(0, install.log.length - visible)
        this.logOffset = Math.min(Math.max(0, this.logOffset + delta), max)
      }
      return
    }
    this.installOffset = Math.max(0, this.installOffset + delta)
  }

  private visibleLogLines(plan: ChromePlan | undefined): number {
    const body = Math.max(1, plan?.bodyRows ?? 6)
    return Math.max(1, body - 6)
  }

  private installOffset = 0

  // ── rendering ────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.disposed) return []
    const safeWidth = Math.max(1, width)
    const liveRows = Math.max(1, Math.floor(this.intents.rows()))
    this.syncInputFocus()
    this.syncFrameState(safeWidth, liveRows)
    this.ensureSelection()
    this.ensureDetailSelection()
    const noticeLive = this.controller.notice() !== undefined
      || this.controller.status().state === 'error'
      || this.controller.model().exemptionWarnings.length > 0
      || this.intents.notice?.() !== undefined
    const plan = planChrome(safeWidth, liveRows, noticeLive)
    this.paintedChrome = plan
    const lines: string[] = []
    const targets: HitTarget[] = []
    if (plan.headerRows === 1) lines.push(this.renderHeader(plan))
    if (plan.metaRows === 1) lines.push(...this.renderMeta(plan, plan.headerRows, targets))
    if (plan.ruleRows >= 1) lines.push(color.border('─'.repeat(plan.width)))
    const bodyTop = this.bodyTop(plan)
    if (plan.bodyRows > 0) lines.push(...this.renderBody(plan, bodyTop, targets))
    if (plan.ruleRows >= 2) lines.push(color.border('─'.repeat(plan.width)))
    if (plan.noticeRows === 1) lines.push(this.renderNotice(plan))
    if (plan.actionRows === 1) lines.push(this.renderActionBar(plan))
    this.paintedTargets = targets
    this.paintedRevision = this.revision
    this.lastRenderWidth = safeWidth
    this.lastRenderRows = liveRows
    return lines.slice(0, plan.rows)
  }

  /** Bump the gesture revision whenever the NEXT frame could move a painted
   * target: model identity, view, install phase, notice, selection/focus,
   * filter/query or terminal geometry. */
  private syncFrameState(width: number, rows: number): void {
    const modelKey = this.modelStateKey()
    const install = this.controller.installView()
    const notice = this.controller.notice()
    const appNoticeKey = this.appNoticeKey()
    const statusState = this.controller.status().state
    let changed = false
    if (this.lastRenderWidth >= 0 && (this.lastRenderWidth !== width || this.lastRenderRows !== rows)) changed = true
    if (this.lastModelKey !== modelKey) { this.lastModelKey = modelKey; changed = true }
    if (this.lastView !== this.view) { this.lastView = this.view; changed = true }
    if (this.lastPhase !== install?.phase) {
      this.lastPhase = install?.phase
      this.installSelection = 0
      this.logsExpanded = false
      this.logOffset = 0
      this.installOffset = 0
      if (install?.phase === 'editing') this.seedInstallInputs(install)
      changed = true
    }
    if (this.lastNotice !== notice) { this.lastNotice = notice; changed = true }
    if (this.lastAppNotice !== appNoticeKey) { this.lastAppNotice = appNoticeKey; changed = true }
    if (this.lastStatusState !== statusState) { this.lastStatusState = statusState; changed = true }
    if (this.lastSelectedValue !== this.selectedValue) { this.lastSelectedValue = this.selectedValue; changed = true }
    if (this.lastFocus !== this.focus) { this.lastFocus = this.focus; changed = true }
    if (this.lastFilter !== this.filter) { this.lastFilter = this.filter; changed = true }
    if (this.lastQuery !== this.query) { this.lastQuery = this.query; changed = true }
    if (changed) this.bumpRevision()
  }

  private ensureDetailSelection(): void {
    if (this.view !== 'details') return
    const card = this.selectedCard()
    if (card === undefined) return
    const detail = this.detailView(card)
    if (detail.actions.length === 0) {
      this.detailSelection = 0
      return
    }
    if (this.detailSelection >= detail.actions.length) {
      this.detailSelection = detail.actions.length - 1
      this.bumpRevision()
    }
  }

  private bodyTop(plan: ChromePlan): number {
    return plan.headerRows + plan.metaRows + (plan.ruleRows >= 1 ? 1 : 0)
  }

  private renderHeader(plan: ChromePlan): string {
    const card = this.selectedCard()
    const trail = this.view === 'list'
      ? FILTER_LABELS[this.filter]
      : this.view === 'details'
        ? (card?.title ?? card?.name ?? 'Details')
        : this.view === 'install'
          ? 'Install'
          : 'Remove'
    const lead = `${color.textStrong('Plugins')}${color.textDim(` · ${sanitizedPhysicalLine(trail)}`)}`
    const model = this.controller.model()
    const enabled = model.cards.filter(entry => entry.enabled).length
    const counts = plan.wide
      ? `${model.cards.length} plugins · ${enabled} enabled`
      : `${enabled}/${model.cards.length} enabled`
    // A failed refresh keeps the last good list visible but must not look
    // current: the header carries the Stale word (the notice carries the error).
    const stale = this.controller.status().state === 'error' ? `${color.warning('Stale')} · ` : ''
    return composeEdge(lead, `${stale}${color.textMuted(counts)}`, plan.width)
  }

  private renderMeta(plan: ChromePlan, metaRow: number, targets: HitTarget[]): string[] {
    if (this.view !== 'list' && this.view !== 'details') {
      const context = this.view === 'install'
        ? 'Official install — inspect, confirm, then observe the Host result'
        : 'Removal confirmation — the exact package and consequence are shown below'
      return [fit(color.textDim(context), plan.width)]
    }
    const filterWidth = FILTERS.reduce((sum, filter) => sum + visibleWidth(FILTER_LABELS[filter]) + 3, 0)
    const searchWidth = Math.max(1, plan.width - filterWidth - 2)
    const lines: string[] = []
    if (this.searchEditing) {
      const input = this.searchInput.render(Math.max(1, searchWidth))
      lines.push(`${color.textDim('Search: ')}${input[0] ?? ''}`)
      targets.push({ kind: 'search', value: 'search', row: metaRow, startCol: 0, endCol: plan.width })
    } else {
      const query = this.query === '' ? '/' : sanitizedPhysicalLine(this.query)
      lines.push(composeEdge(
        `${color.textDim('Search: ')}${color.text(query)}`,
        this.filterChips(),
        plan.width,
      ))
      const text = this.query === '' ? 'Search: /' : `Search: ${query}`
      targets.push({ kind: 'search', value: 'search', row: metaRow, startCol: 0, endCol: visibleWidth(text) })
    }
    // The chips are painted only when the whole row fits beside the search
    // field; their hit targets are computed from the REAL painted columns.
    if (!this.searchEditing) {
      const rendered = this.filterChips()
      const start = plan.width - visibleWidth(rendered)
      if (start >= visibleWidth(this.query === '' ? 'Search: /' : `Search: ${this.query}`) + 1) {
        let column = start
        for (const filter of FILTERS) {
          const label = FILTER_LABELS[filter]
          const width = visibleWidth(label)
          targets.push({ kind: 'filter', value: filter, row: metaRow, startCol: column, endCol: column + width })
          column += width + 3
        }
      }
    }
    return lines
  }

  private filterChips(): string {
    return FILTERS.map((filter) => {
      const label = FILTER_LABELS[filter]
      if (filter === this.filter) return color.textStrong(label)
      return color.textDim(label)
    }).join(color.textMuted(' · '))
  }

  private renderNotice(plan: ChromePlan): string {
    const appNotice = this.intents.notice?.()
    const model = this.controller.model()
    const exemptionWarning = model.exemptionWarnings.length === 0
      ? undefined
      : `version exemptions: ${model.exemptionWarnings.join(' · ')}`
    const message = this.controller.notice()
      ?? (this.controller.status().state === 'error' ? this.controller.status().error : undefined)
      ?? exemptionWarning
      ?? appNotice?.text
    if (message === undefined) return fit('', plan.width)
    const kind = this.controller.status().state === 'error'
      || appNotice?.kind === 'error'
      || /failed|unknown|refused|cannot|error/i.test(message)
      ? 'error'
      : 'info'
    const text = sanitizedPhysicalLine(message)
    const prefix = kind === 'error' ? color.error('✗ ') : color.textMuted('ℹ ')
    return fit(prefix + (kind === 'error' ? color.error(text) : color.textMuted(text)), plan.width)
  }

  private renderActionBar(plan: ChromePlan): string {
    const segments = this.actionBarSegments()
    return color.textMuted(renderActionBarRow(segments, plan.width))
  }

  private actionBarSegments(): ActionBarSegment[] {
    const back = this.controller.host() === 'settings-entry' ? 'Esc back' : 'Esc close'
    if (this.searchEditing) {
      return [
        { text: 'Enter apply', priority: 80 },
        { text: 'Esc clear search', priority: 100 },
      ]
    }
    if (this.view === 'install') {
      const install = this.controller.installView()
      if (install === undefined) return [{ text: 'Esc back', priority: 100 }]
      if (install.phase === 'editing') {
        return [
          { text: 'Tab switch field', priority: 80 },
          { text: 'Enter inspect', priority: 70 },
          // Esc returns to the LIST, never closes the page: the hint must name
          // that real destination on both entry hosts.
          { text: 'Esc back', priority: 100 },
        ]
      }
      if (install.phase === 'inspecting') {
        return [{ text: 'Esc back', priority: 100 }]
      }
      if (install.phase === 'confirm') {
        return install.inspection?.status === 'accepted'
          ? [{ text: 'Enter install', priority: 90 }, { text: 'Esc edit', priority: 100 }]
          : [{ text: 'Esc edit', priority: 100 }]
      }
      if (install.phase === 'starting' || install.phase === 'installing' || install.phase === 'applying' || install.phase === 'cancelling') {
        return [
          ...(install.cancellable ? [{ text: 's stop', priority: 90 }] : []),
          { text: 'l logs', priority: 70 },
          { text: 'c copy', priority: 60 },
          { text: 'Esc hide', priority: 100 },
        ]
      }
      return [
        { text: 'Enter action', priority: 80 },
        ...(install.phase === 'unknown' ? [] : [{ text: 'n new', priority: 55 }]),
        { text: 'l logs', priority: 70 },
        { text: 'c copy', priority: 60 },
        { text: 'Esc back', priority: 100 },
      ]
    }
    if (this.view === 'confirm') {
      return [
        { text: 'Enter confirm', priority: 90 },
        { text: 'Esc cancel', priority: 100 },
      ]
    }
    // `i` never replaces a terminal attempt; name what it will actually open.
    const installHint = this.controller.installView() === undefined ? 'i install' : 'i install result'
    if (this.view === 'details') {
      return [
        { text: 'Enter action', priority: 80 },
        { text: '/ search', priority: 70 },
        { text: installHint, priority: 60 },
        { text: 'c copy', priority: 50 },
        { text: 'r refresh', priority: 40 },
        { text: 'Esc back', priority: 100 },
      ]
    }
    return [
      { text: 'Enter details', priority: 80 },
      { text: '/ search', priority: 70 },
      { text: installHint, priority: 60 },
      { text: 'Tab filter', priority: 50 },
      { text: 'r refresh', priority: 40 },
      { text: back, priority: 100 },
    ]
  }

  private renderBody(plan: ChromePlan, bodyTop: number, targets: HitTarget[]): string[] {
    if (this.view === 'install') return this.renderInstallBody(plan, bodyTop, targets)
    if (this.view === 'confirm') return this.renderConfirmBody(plan, bodyTop, targets)
    if (!plan.wide) {
      if (this.view === 'details') {
        const card = this.selectedCard()
        if (card === undefined) return padBody([color.textDim('Select a plugin first')], plan.bodyRows, plan.width)
        return this.renderDetailPane(card, plan.width, plan.bodyRows, true, bodyTop, 0, targets, true)
      }
      return this.renderListPane(plan.width, plan.bodyRows, bodyTop, 0, targets, true)
    }
    // Wide: left list always, right Detail preview/actions.
    const showPaneHeader = plan.bodyRows >= 2
    const headerRows = showPaneHeader ? 1 : 0
    const contentTop = bodyTop + headerRows
    const viewport = Math.max(0, plan.bodyRows - headerRows)
    const left = this.renderListPane(plan.leftWidth, viewport, contentTop, 0, targets, true)
    const rightX = plan.leftWidth + COLUMN_GAP
    const card = this.selectedCard()
    const right = card === undefined
      ? padBody([color.textDim('No plugin selected')], viewport, plan.rightWidth)
      : this.renderDetailPane(card, plan.rightWidth, viewport, this.focus === 'details', contentTop, rightX, targets, true)
    for (let i = 0; i < viewport; i += 1) {
      targets.push({ kind: 'pane', value: 'list', row: contentTop + i, startCol: 0, endCol: plan.leftWidth })
      targets.push({ kind: 'pane', value: 'details', row: contentTop + i, startCol: rightX, endCol: plan.width })
    }
    if (showPaneHeader) {
      const leftLabel = this.focus === 'list' ? color.textStrong('[Plugins]', 'primary') : color.textDim('Plugins')
      const rightLabel = this.focus === 'details' ? color.textStrong('[Details]', 'primary') : color.textDim('Details')
      const header = `${fit(leftLabel, plan.leftWidth)}${' '.repeat(COLUMN_GAP)}${fit(rightLabel, plan.rightWidth)}`
      return [header, ...joinPanes(left, right, plan.leftWidth, plan.rightWidth)]
    }
    return joinPanes(left, right, plan.leftWidth, plan.rightWidth)
  }

  private renderListPane(
    width: number,
    viewport: number,
    rowStart: number,
    offsetX: number,
    targets: HitTarget[],
    publish: boolean,
  ): string[] {
    const entries = this.listEntries(this.controller.model())
    if (entries.length === 0) {
      return padBody([color.textMuted('No matching plugins')], viewport, width)
    }
    const selectedIndex = entries.findIndex(entry => entry.kind === 'card' && entry.value === this.selectedValue)
    this.listOffset = rebaseOffset(this.listOffset, Math.max(0, selectedIndex), entries.length, viewport)
    const visible = entries.slice(this.listOffset, this.listOffset + viewport)
    const lines: string[] = []
    for (let i = 0; i < visible.length; i += 1) {
      const entry = visible[i]!
      lines.push(this.listEntryLine(entry, width))
      if (publish && entry.kind === 'card' && entry.value !== undefined) {
        targets.push({
          kind: 'card',
          value: entry.value,
          row: rowStart + i,
          startCol: offsetX,
          endCol: offsetX + width,
        })
      }
    }
    return padBody(lines, viewport, width)
  }

  private listEntryLine(entry: ListEntry, width: number): string {
    if (entry.kind === 'section') return color.textDim(truncateToWidth(entry.label, width, '…'))
    if (entry.kind === 'subheader') return color.textMuted(truncateToWidth(`  ${entry.label}`, width, '…'))
    if (entry.kind === 'empty') return color.textMuted(truncateToWidth(`  ${entry.label}`, width, '…'))
    const card = entry.card!
    const selected = card.value === this.selectedValue
    const busyValue = this.controller.busy()
    const busy = busyValue === card.value
      || card.rows.some(row => busyValue === rowToggleValue(row.entryId))
    const chip = busy ? 'busy' : cardStatusChip(card)
    let chipText = chip === undefined ? '' : `[${chip}]`
    let chipWidth = visibleWidth(chipText)
    // The floor guarantee: at an absurdly narrow width the chip yields WHOLE
    // rather than being cut by the line fit.
    if (chipText !== '' && width < 2 + 2 + chipWidth) {
      chipText = ''
      chipWidth = 0
    }
    const chipRoom = chipWidth === 0 ? 0 : chipWidth + 1
    const nameWidth = Math.max(1, width - 2 - chipRoom)
    const cursor = selected ? color.primary('> ') : '  '
    const name = abbreviateName(card.title ?? card.name, nameWidth)
    const nameText = selected ? color.textStrong(name) : color.text(name)
    if (chipText === '') return fit(cursor + nameText, width)
    const chipInk = cardStatusTone(card)
    return fit(
      `${cursor}${nameText}${' '.repeat(Math.max(1, width - 2 - visibleWidth(name) - chipWidth))}${paintTone(chipText, chipInk)}`,
      width,
    )
  }

  private renderDetailPane(
    card: PluginCardView,
    width: number,
    viewport: number,
    focused: boolean,
    rowStart: number,
    offsetX: number,
    targets: HitTarget[],
    publish: boolean,
  ): string[] {
    const detail = this.detailView(card)
    const built = detailLines(detail, width, focused && this.focus === 'details', this.detailSelection)
    const selected = built.actionLines[Math.min(this.detailSelection, Math.max(0, built.actionLines.length - 1))]
    this.detailOffset = focused && this.detailReveal
      ? rebaseOffset(this.detailOffset, selected?.line ?? 0, built.lines.length, viewport)
      : clampOffset(this.detailOffset, built.lines.length, viewport)
    if (focused) this.detailReveal = false
    this.paintedDetailSelectionVisible = focused
      && selected !== undefined
      && selected.line >= this.detailOffset
      && selected.line < this.detailOffset + viewport
    const visible = built.lines.slice(this.detailOffset, this.detailOffset + viewport)
    if (publish && focused) {
      for (const action of built.actionLines) {
        const y = action.line - this.detailOffset
        if (y < 0 || y >= viewport) continue
        targets.push({
          kind: 'action',
          value: action.value,
          row: rowStart + y,
          startCol: offsetX,
          endCol: offsetX + width,
        })
      }
    }
    return padBody(visible, viewport, width)
  }

  private renderInstallBody(plan: ChromePlan, bodyTop: number, targets: HitTarget[]): string[] {
    const install = this.controller.installView()
    if (install === undefined) return padBody([color.textDim('No install is open')], plan.bodyRows, plan.width)
    const pending = this.controller.approvableBuilds() !== undefined
    let actions = this.installActions()
    let built = this.installLines(install, plan.width, actions)
    const layout = (rendered: typeof built): {
      actionsStart: number
      actionBlock: string[]
      contentViewport: number
      content: string[]
      visible: string[]
      visibleActionBlock: number
      riskVisible: boolean
    } => {
      const actionsStart = rendered.actionStart
      const actionBlock = rendered.lines.slice(actionsStart)
      const contentViewport = Math.max(1, plan.bodyRows - Math.min(actionBlock.length, plan.bodyRows))
      const content = rendered.lines.slice(0, actionsStart)
      this.installOffset = clampOffset(this.installOffset, content.length, contentViewport)
      const visible = content.slice(this.installOffset, this.installOffset + contentViewport)
      const visibleActionBlock = Math.min(actionBlock.length, Math.max(0, plan.bodyRows - contentViewport))
      const riskVisible = rendered.riskStart >= 0
        && rendered.riskStart >= this.installOffset
        && rendered.riskEnd < this.installOffset + contentViewport
      return { actionsStart, actionBlock, contentViewport, content, visible, visibleActionBlock, riskVisible }
    }
    let body = layout(built)
    if (pending && actions.some(action => action.value === INSTALL_ACTION.approve) && !body.riskVisible) {
      // The approval is inseparable from its risk disclosure: if the current
      // frame cannot show the package names and the privilege warning, do not
      // offer Approve. Re-layout without it so its action line/target vanishes.
      actions = actions.filter(action => action.value !== INSTALL_ACTION.approve)
      built = this.installLines(install, plan.width, actions)
      body = layout(built)
    }
    this.currentInstallActions = actions
    if (actions.length > 0 && this.installSelection >= actions.length) {
      this.installSelection = actions.length - 1
      this.bumpRevision()
    }
    const out = padBody(body.visible, body.contentViewport, plan.width)
    for (const line of body.actionBlock) out.push(fit(line, plan.width))
    const painted = new Set<string>()
    for (const action of built.actionLines) {
      const y = body.contentViewport + (action.line - body.actionsStart)
      if (y < body.contentViewport || y >= body.contentViewport + body.visibleActionBlock) continue
      painted.add(action.value)
      targets.push({ kind: 'action', value: action.value, row: bodyTop + y, startCol: 0, endCol: plan.width })
    }
    this.paintedInstallActions = painted
    return padBody(out, plan.bodyRows, plan.width)
  }

  /** Build the install body lines + the action lines actually painted. */
  private installLines(
    install: PluginInstallView,
    width: number,
    actions: readonly PluginDetailAction[],
  ): { lines: string[]; actionLines: PaintedActionLine[]; actionStart: number; riskStart: number; riskEnd: number } {
    const lines: string[] = []
    let riskStart = -1
    let riskEnd = -1
    if (install.officialName !== undefined) {
      lines.push(color.textDim(`Official catalog · ${sanitizedPhysicalLine(install.officialName)}`))
    }
    if (install.phase === 'editing') {
      const label = 'Spec    '
      const specLine = this.specInput.render(Math.max(1, width - visibleWidth(label)))[0] ?? ''
      lines.push(`${color.textDim(label)}${specLine}`)
      const options = this.controller.registryOptions()
      const registry = this.customRegistry
        ? `custom ${this.registryInput.render(Math.max(1, width - 16))[0] ?? ''}`
        : maskedSource(sanitizedPhysicalLine(options[this.registryIndex]?.label ?? 'pnpm configuration default'))
      const field = this.installFocus === 'registry' ? color.primary('> ') : '  '
      lines.push(`${color.textDim('Reg     ')}${field}${color.text(truncateToWidth(registry, Math.max(1, width - 12), '…'))}`)
      if (!this.customRegistry) {
        const hint = options.map(option => maskedSource(sanitizedPhysicalLine(option.label))).join(' · ')
        if (hint !== '') lines.push(color.textMuted(truncateToWidth(`        ${hint}`, width, '…')))
      }
      if (install.message !== undefined) lines.push(color.warning(truncateToWidth(sanitizedPhysicalLine(install.message), width, '…')))
      lines.push('')
    } else if (install.phase === 'inspecting') {
      lines.push(color.textDim(truncateToWidth(`Inspecting ${sanitizedPhysicalLine(install.spec)}…`, width, '…')))
      if (install.message !== undefined) lines.push(color.warning(truncateToWidth(sanitizedPhysicalLine(install.message), width, '…')))
      lines.push('')
    } else if (install.phase === 'confirm') {
      const inspection = install.inspection
      if (inspection?.status === 'accepted') {
        lines.push(color.textStrong(truncateToWidth(sanitizedPhysicalLine(inspection.name ?? install.spec), width, '…')))
        const offered = inspection.version === undefined
          ? ''
          : `offered version ${sanitizedPhysicalLine(inspection.version)} · `
        const intent = inspection.bundle === false
          ? 'Installs the package; no bundle activation is requested.'
          : 'Activates the bundle after a successful install.'
        lines.push(color.warning(truncateToWidth(`${offered}${intent}`, width, '…')))
        const bundle = inspection.bundle === null ? 'unknown' : inspection.bundle ? 'yes' : 'no'
        lines.push(color.textDim(truncateToWidth(
          `source ${sanitizedPhysicalLine(inspection.kind)} · registry ${maskedSource(sanitizedPhysicalLine(inspection.registry ?? 'pnpm default'))} · bundle ${bundle}${
            inspection.host === undefined ? '' : ` · host ${sanitizedPhysicalLine(inspection.host)}`
          }`,
          width,
          '…',
        )))
        if (inspection.description !== undefined) {
          lines.push(...wrapTextWithAnsi(sanitizedPhysicalLine(inspection.description), width).map(line => color.textDim(line)))
        }
      } else if (inspection?.status === 'refused') {
        lines.push(color.error(truncateToWidth(`refused: ${sanitizedPhysicalLine(inspection.problem)}`, width, '…')))
        lines.push(...wrapTextWithAnsi(sanitizedPhysicalLine(inspection.reason), width).map(line => color.textMuted(line)))
        if (inspection.registries !== undefined && inspection.registries.length > 0) {
          lines.push(color.textMuted(truncateToWidth(
            `registries: ${inspection.registries.map(registry => maskedSource(sanitizedPhysicalLine(registry ?? 'pnpm default'))).join(', ')}`,
            width,
            '…',
          )))
        }
      }
      if (install.message !== undefined) lines.push(color.warning(truncateToWidth(sanitizedPhysicalLine(install.message), width, '…')))
      lines.push('')
    } else if (install.phase === 'starting' || install.phase === 'installing' || install.phase === 'applying' || install.phase === 'cancelling') {
      lines.push(color.textStrong(`${install.phase}${install.spec === '' ? '' : ` · ${sanitizedPhysicalLine(install.spec)}`}`))
      if (install.message !== undefined) lines.push(color.textMuted(truncateToWidth(sanitizedPhysicalLine(install.message), width, '…')))
      lines.push('')
      const log = install.log.slice(0, LOG_TAIL_LINES)
      const collapsed = this.logsExpanded ? log : log.slice(Math.max(0, log.length - this.visibleLogLines(this.paintedChrome)))
      if (this.logsExpanded) {
        const visible = this.visibleLogLines(this.paintedChrome)
        const start = Math.min(this.logOffset, Math.max(0, log.length - visible))
        for (const line of log.slice(start, start + visible)) {
          lines.push(truncateToWidth(sanitizedPhysicalLine(line), width, '…'))
        }
      } else {
        for (const line of collapsed) lines.push(truncateToWidth(sanitizedPhysicalLine(line), width, '…'))
      }
      lines.push('')
    } else {
      // done / failed / unknown
      lines.push(color.textStrong(`${install.phase}${install.officialName === undefined ? '' : ` · ${sanitizedPhysicalLine(install.officialName)}`}`))
      const pending = this.controller.approvableBuilds()
      if (pending !== undefined) {
        // The approval risk is the FIRST fact: at 80x10 the pinned Approve
        // action must never appear above a hidden risk explanation.
        riskStart = lines.length
        // Every exact package name is part of the authorization: wrap each
        // one instead of ellipsizing the joined list. `riskEnd` then covers
        // all lines the user must actually see before Approve is admitted.
        lines.push(color.warning('Build scripts blocked for:'))
        for (const name of pending) {
          lines.push(...wrapTextWithAnsi(`- ${sanitizedPhysicalLine(name)}`, width).map(line => color.warning(line)))
        }
        lines.push(...wrapTextWithAnsi(
          'These packages execute scripts with your user privileges. Approve only when you trust them.',
          width,
        ).map(line => color.warning(line)))
        riskEnd = lines.length - 1
      }
      const outcome = install.outcome
      const summary = outcome === undefined ? undefined : sanitizedPhysicalLine(changeSummary(outcome))
      if (summary !== undefined) {
        lines.push(...wrapTextWithAnsi(summary, width).map(line => color.text(line)))
        if (outcome!.version !== undefined) {
          lines.push(color.textDim(`installed version ${sanitizedPhysicalLine(outcome!.version)}`))
        }
        if (outcome!.application === 'restart-required') {
          lines.push(color.warning('Restart required — the change is not active until DSH restarts.'))
        } else if (outcome!.application === 'overridden') {
          lines.push(color.warning('Overridden — a higher-priority composition still wins.'))
        }
        if (outcome!.approvedBuilds !== undefined && outcome!.approvedBuilds.length > 0) {
          lines.push(color.textDim(truncateToWidth(
            `approved build scripts: ${outcome!.approvedBuilds.map(line => sanitizedPhysicalLine(line)).join(', ')}`,
            width,
            '…',
          )))
        }
        if (outcome!.registries !== undefined && outcome!.registries.length > 0) {
          lines.push(color.textDim(truncateToWidth(
            `registries: ${outcome!.registries.map(registry => maskedSource(sanitizedPhysicalLine(registry ?? 'pnpm default'))).join(', ')}`,
            width,
            '…',
          )))
        }
        const output = outcome!.packageResult?.output
        if (output !== undefined && output !== '') {
          lines.push('')
          const outputLines = output.split(/\r?\n/).filter(line => line !== '')
          for (const line of outputLines.slice(-8)) {
            lines.push(truncateToWidth(sanitizedPhysicalLine(line), width, '…'))
          }
          if (outcome!.packageResult?.truncated === true) {
            lines.push(color.textMuted('(Host truncated the package output)'))
          }
        }
      }
      if (install.message !== undefined && sanitizedPhysicalLine(install.message) !== summary) {
        lines.push(color.textMuted(truncateToWidth(sanitizedPhysicalLine(install.message), width, '…')))
      }
      // The Host packageResult.output is the same captured pnpm output the
      // install-log events stream; show the log only when there is no output.
      if (outcome?.packageResult?.output === undefined && install.log.length > 0) {
        lines.push('')
        const visible = this.visibleLogLines(this.paintedChrome)
        const log = install.log.slice(0, LOG_TAIL_LINES)
        const shown = this.logsExpanded ? log.slice(this.logOffset, this.logOffset + visible) : log.slice(Math.max(0, log.length - visible))
        for (const line of shown) lines.push(truncateToWidth(sanitizedPhysicalLine(line), width, '…'))
      }
      lines.push('')
    }
    const actionLines = paintActions(lines, actions, this.installSelection, width, false)
    return {
      lines: actionLines.lines,
      actionLines: actionLines.actionLines,
      actionStart: actionLines.actionLines[0]?.line ?? actionLines.lines.length,
      riskStart,
      riskEnd,
    }
  }

  private renderConfirmBody(plan: ChromePlan, bodyTop: number, targets: HitTarget[]): string[] {
    const card = this.controller.confirmingCard()
    const name = this.controller.confirmingName() ?? '(unknown)'
    const actions: PluginDetailAction[] = [
      { value: CONFIRM_ACTION.remove, label: 'Remove', enabled: card !== undefined, tone: 'warning' },
      { value: CONFIRM_ACTION.cancel, label: 'Cancel', enabled: true, tone: 'normal' },
    ]
    const content: string[] = []
    content.push(color.textStrong(truncateToWidth(`Remove ${sanitizedPhysicalLine(name)}?`, plan.width, '…')))
    if (card === undefined) {
      content.push(color.error('This bundle changed since the confirmation opened. Re-open it from the list.'))
    }
    content.push(...wrapTextWithAnsi(
      'This unloads the bundle and removes the profile dependency. Installed files are removed and DSH does not reinstall it automatically.',
      plan.width,
    ).map(line => color.textDim(line)))
    // The two real choices are PINNED to the body floor without a separate
    // title row: at 80x10 the exact name, the consequence and both choices fit.
    const actionBlock = paintActions([], actions, this.confirmSelection, plan.width, false)
    const actionRows = actionBlock.lines.length
    const contentViewport = Math.max(1, plan.bodyRows - Math.min(actionRows, plan.bodyRows))
    const out = padBody(content.slice(0, contentViewport), contentViewport, plan.width)
    const visibleActions = actionBlock.lines.slice(0, Math.max(0, plan.bodyRows - contentViewport))
    for (const line of visibleActions) out.push(fit(line, plan.width))
    this.paintedConfirmActions = new Set()
    for (const action of actionBlock.actionLines) {
      const y = contentViewport + action.line
      if (y < contentViewport || y >= contentViewport + visibleActions.length) continue
      this.paintedConfirmActions = new Set([...this.paintedConfirmActions, action.value])
      targets.push({ kind: 'action', value: action.value, row: bodyTop + y, startCol: 0, endCol: plan.width })
    }
    return padBody(out, plan.bodyRows, plan.width)
  }

  // ── hit map ──────────────────────────────────────────────────────────────

  private targetAt(x: number, y: number): HitTarget | undefined {
    for (const target of this.paintedTargets) {
      if (y === target.row && x >= target.startCol && x < target.endCol) return target
    }
    return undefined
  }

  /** True only while the live terminal geometry and state version still match
   * the frame whose hit map is installed in `paintedTargets`. */
  /** The semantic presentation key of the inventory. A same-truth reread
   * creates a new model object but the SAME key, so an invalidation that
   * returns identical facts cannot invalidate an already-painted action; any
   * fact that could change a pixel or an action changes the key. */
  private modelStateKey(): string {
    return JSON.stringify(this.controller.model())
  }

  private appNoticeKey(): string | undefined {
    const notice = this.intents.notice?.()
    return notice === undefined ? undefined : `${notice.kind}:${notice.text}`
  }

  /** True only while the live semantic facts AND terminal geometry still match
   * the frame whose hit map is installed in `paintedTargets`. Comparing only
   * the panel revision would miss an async controller model/phase/notice update
   * whose queued repaint has not run yet. */
  private frameIsCurrent(): boolean {
    return this.paintedRevision === this.revision
      && this.lastRenderWidth === this.intents.columns()
      && this.lastRenderRows === this.intents.rows()
      && this.modelStateKey() === this.lastModelKey
      && this.controller.installView()?.phase === this.lastPhase
      && this.controller.notice() === this.lastNotice
      && this.appNoticeKey() === this.lastAppNotice
      && this.controller.status().state === this.lastStatusState
  }

  private bumpRevision(): void {
    this.revision += 1
  }
}

/** The intents the app composition wires into the workspace page. */
export interface PluginManagerWorkspacePanelIntents {
  /** The live terminal row budget. */
  readonly rows: () => number
  /** The live terminal column budget. */
  readonly columns: () => number
  /** Repaint the hosting screen. */
  readonly requestRender: () => void
  /** The ONE app-owned notice (never a second notice store). */
  readonly notice?: () => { readonly text: string; readonly kind: 'info' | 'error' } | undefined
  /** Copy exact text through the app's Client-local clipboard owner. */
  readonly onCopy: (text: string) => void
}

/**
 * The concrete page factory the composition zone injects into the application
 * Plugin Manager owner. It constructs exactly one workspace page and nothing
 * else — no wrapper, cache, registry or lifecycle.
 */
export function createPluginManagerWorkspacePanel(
  controller: PluginManagerController,
  intents: PluginManagerWorkspacePanelIntents & { readonly onDispose?: () => void },
): PluginManagerWorkspacePanel {
  return new PluginManagerWorkspacePanel(controller, intents, {
    ...(intents.onDispose === undefined ? {} : { onDispose: intents.onDispose }),
  })
}

// ── pure rendering helpers ─────────────────────────────────────────────────

function planChrome(width: number, rows: number, noticeLive: boolean): ChromePlan {
  const safeRows = Math.max(1, Math.floor(rows))
  const headerRows = safeRows >= 2 ? 1 : 0
  const actionRows = 1
  const base = Math.max(0, safeRows - headerRows - actionRows)
  const metaRows = safeRows >= 7 && base - 1 >= 3 ? 1 : 0
  const noticeRows = safeRows >= 6 && noticeLive && base - metaRows - 1 >= 2 ? 1 : 0
  const bodyWithoutRules = Math.max(0, base - metaRows - noticeRows)
  const ruleRows = bodyWithoutRules >= 5 ? 2 : 0
  const bodyRows = Math.max(0, bodyWithoutRules - ruleRows)
  const wide = width >= PLUGIN_WORKSPACE_WIDE_MIN_COLUMNS
  let leftWidth = width
  let rightWidth = width
  if (wide) {
    leftWidth = Math.min(42, Math.max(30, Math.floor((width - COLUMN_GAP) * 0.42)))
    rightWidth = Math.max(MIN_DETAIL_WIDTH, width - leftWidth - COLUMN_GAP)
    // Keep the sum exact; a terminal width that cannot carry the minimum right
    // pane falls back to the one-column projection.
    if (leftWidth + COLUMN_GAP + rightWidth > width) {
      return planSingleColumn(width, safeRows)
    }
  }
  return {
    width,
    rows: safeRows,
    wide,
    headerRows,
    metaRows,
    ruleRows,
    noticeRows,
    actionRows,
    bodyRows,
    leftWidth,
    rightWidth,
  }
}

function planSingleColumn(width: number, safeRows: number): ChromePlan {
  const headerRows = safeRows >= 2 ? 1 : 0
  const actionRows = 1
  const base = Math.max(0, safeRows - headerRows - actionRows)
  const metaRows = safeRows >= 7 && base - 1 >= 3 ? 1 : 0
  const noticeRows = 0
  const bodyWithoutRules = Math.max(0, base - metaRows)
  const ruleRows = bodyWithoutRules >= 5 ? 2 : 0
  const bodyRows = Math.max(0, bodyWithoutRules - ruleRows)
  return {
    width,
    rows: safeRows,
    wide: false,
    headerRows,
    metaRows,
    ruleRows,
    noticeRows,
    actionRows,
    bodyRows,
    leftWidth: width,
    rightWidth: width,
  }
}

function composeEdge(left: string, right: string, width: number): string {
  if (right === '') return fit(left, width)
  const leftWidth = visibleWidth(left)
  const rightWidth = visibleWidth(right)
  if (leftWidth + rightWidth + 1 > width) return fit(left, width)
  return fit(left, width - rightWidth - 1) + ' ' + right
}

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

function padBody(lines: string[], viewport: number, width: number): string[] {
  while (lines.length < viewport) lines.push(fit('', width))
  return lines.slice(0, viewport)
}

function joinPanes(left: readonly string[], right: readonly string[], leftWidth: number, rightWidth: number): string[] {
  const lines: string[] = []
  const count = Math.max(left.length, right.length)
  for (let i = 0; i < count; i += 1) {
    lines.push(`${fit(left[i] ?? '', leftWidth)}${' '.repeat(COLUMN_GAP)}${fit(right[i] ?? '', rightWidth)}`)
  }
  return lines
}

function rebaseOffset(offset: number, selected: number, count: number, viewport: number): number {
  if (viewport <= 0) return 0
  let next = offset
  if (selected < next) next = selected
  if (selected >= next + viewport) next = selected - viewport + 1
  const max = Math.max(0, count - viewport)
  return Math.min(Math.max(0, next), max)
}

function clampOffset(offset: number, count: number, viewport: number): number {
  if (viewport <= 0) return 0
  return Math.min(Math.max(0, offset), Math.max(0, count - viewport))
}

/** Head…tail abbreviation for a long package identity (design language §6.4). */
function abbreviateName(text: string, width: number): string {
  const safe = sanitizedPhysicalLine(text)
  if (visibleWidth(safe) <= width) return safe
  if (width <= 1) return truncateToWidth(safe, width, '…', false)
  const headWidth = Math.ceil((width - 1) / 2)
  const tailWidth = Math.max(0, width - 1 - headWidth)
  const head = sliceByColumn(safe, 0, headWidth, true)
  const tail = sliceByColumn(safe, Math.max(0, visibleWidth(safe) - tailWidth), tailWidth, true)
  return `${head}…${tail}`
}

/** Strip ANSI only for a width measurement of already-painted text. */
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function paintTone(text: string, tone: 'normal' | 'dim' | 'muted' | 'success' | 'warning' | 'error'): string {
  switch (tone) {
    case 'error': return color.error(text)
    case 'warning': return color.warning(text)
    case 'success': return color.success(text)
    case 'dim': return color.textDim(text)
    case 'muted': return color.textMuted(text)
    default: return color.text(text)
  }
}

interface DetailRender {
  readonly lines: string[]
  readonly actionLines: readonly PaintedActionLine[]
}

/** Build the Detail body lines and remember which painted lines are actions. */
function detailLines(detail: PluginDetailView, width: number, focused: boolean, selectedAction: number): DetailRender {
  const lines: string[] = []
  const versionText = detail.card.version === undefined ? '' : ` ${sanitizedPhysicalLine(detail.card.version)}`
  const experimentalText = detail.card.experimental ? ' [experimental]' : ''
  const titleRoom = Math.max(1, width - visibleWidth(versionText) - visibleWidth(experimentalText))
  const titleLine = `${color.textStrong(truncateToWidth(sanitizedPhysicalLine(detail.title), titleRoom, '…'))}${color.textDim(versionText)}${
    detail.card.experimental ? color.warning(experimentalText) : ''
  }`
  lines.push(fit(titleLine, width))
  lines.push(...wrapTextWithAnsi(sanitizedPhysicalLine(detail.card.name), width).map(line => color.textDim(line)))
  if (detail.card.official) lines.push(color.textMuted('Official DSH catalog entry'))
  for (const group of detail.groups) {
    lines.push('')
    lines.push(color.textDim(group.title === 'Status' ? '‣ Status' : group.title))
    for (const fact of group.facts) {
      lines.push(...factLines(fact.label, fact.value, fact.tone, width))
    }
  }
  const actions = detail.actions
  const actionLines: PaintedActionLine[] = []
  lines.push('')
  lines.push(color.textDim('Actions'))
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!
    const cursor = focused && index === selectedAction ? color.primary('> ') : '  '
    const actionLabel = sanitizedPhysicalLine(action.label)
    const label = action.enabled
      ? (focused && index === selectedAction ? color.textStrong(actionLabel) : color.text(actionLabel))
      : color.textDim(actionLabel)
    const reason = action.enabled || action.reason === undefined
      ? ''
      : color.textMuted(` — ${sanitizedPhysicalLine(action.reason)}`)
    actionLines.push({ value: action.value, line: lines.length })
    lines.push(fit(`${cursor}${label}${reason}`, width))
  }
  return { lines, actionLines }
}

function factLines(label: string, value: string, tone: 'normal' | 'dim' | 'success' | 'warning' | 'error', width: number): string[] {
  const labelColumn = Math.min(16, Math.max(8, Math.floor(width / 3)))
  const safeLabel = sanitizedPhysicalLine(label)
  const safeValue = sanitizedPhysicalLine(value)
  const paint = (text: string): string => {
    switch (tone) {
      case 'success': return color.success(text)
      case 'warning': return color.warning(text)
      case 'error': return color.error(text)
      case 'dim': return color.textDim(text)
      default: return color.text(text)
    }
  }
  const lines: string[] = []
  if (visibleWidth(safeLabel) > labelColumn) {
    lines.push(...wrapTextWithAnsi(safeLabel, width).map(line => color.textDim(line)))
    for (const line of wrapTextWithAnsi(safeValue, Math.max(1, width - 2))) {
      lines.push(`  ${paint(line)}`)
    }
    return lines
  }
  const labelText = safeLabel + ' '.repeat(labelColumn - visibleWidth(safeLabel))
  const valueWidth = Math.max(1, width - labelColumn)
  const wrapped = wrapTextWithAnsi(safeValue, valueWidth)
  wrapped.forEach((line, index) => {
    if (index === 0) lines.push(fit(`${color.textDim(labelText)}${paint(line)}`, width))
    else lines.push(fit(`${' '.repeat(labelColumn)}${paint(line)}`, width))
  })
  return lines
}

/** Paint an action list at the end of `lines`, returning their line indices. */
function paintActions(
  lines: string[],
  actions: readonly PluginDetailAction[],
  selected: number,
  width: number,
  showTitle = true,
): { lines: string[]; actionLines: PaintedActionLine[] } {
  const actionLines: PaintedActionLine[] = []
  if (showTitle) lines.push(color.textDim('Actions'))
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!
    const cursor = index === selected ? color.primary('> ') : '  '
    const actionLabel = sanitizedPhysicalLine(action.label)
    const label = action.enabled
      ? (index === selected ? color.textStrong(actionLabel) : color.text(actionLabel))
      : color.textDim(actionLabel)
    const reason = action.enabled || action.reason === undefined ? '' : color.textMuted(` — ${sanitizedPhysicalLine(action.reason)}`)
    actionLines.push({ value: action.value, line: lines.length })
    lines.push(fit(`${cursor}${label}${reason}`, width))
  }
  return { lines, actionLines }
}
