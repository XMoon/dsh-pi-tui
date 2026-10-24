/**
 * The embedded Plugin Manager page (S4-D1 / PR2): a PURE PiTui renderer and
 * input owner for the profile-wide official inventory. It paints the frozen
 * sections (`TUI & Extensions → Official DSH → Third-party → Experimental`),
 * the package Detail, the official install view, the removal confirmation and
 * the extension diagnostics page.
 *
 * It owns NO Host read, NO install request id and NO package execution: the
 * ONE `PluginManagerController` owns the official port and the install
 * lifecycle; this component only paints its facts and forwards explicit user
 * intents. Selection, search/filter, focus, scroll offsets, the painted hit
 * map and its revision are per-page state of THIS page.
 *
 * The page is a CHILD of the Settings workspace panel: it paints only inside
 * the local viewport the root grants it (`setViewport`), never the shared
 * Settings Header/Metadata/Rules/Action Bar, and it derives its own local
 * Chrome (Search/Filters, Host notice, business body, one semantic bar) from
 * that grant. Esc/Left/Shift+Tab at the list root report a navigation YIELD to
 * the root — they never close the page or release the Host claim.
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
  formatTuiContributionDiagnostic,
  formatTuiExtensionCapabilities,
  formatTuiExtensionRegistryCounts,
  serializeTuiExtensionDiagnostics,
  type TuiContributionDiagnostic,
  type TuiExtensionDiagnostics,
} from '../../app/plugin-manager/extension-inventory.ts'
import {
  AUTO_REVIEW_BUNDLE,
  AUTO_REVIEW_DISABLE_WARNING,
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

/** The minimum local content width of the adjacent List|Details pair. */
const DUAL_MIN_COLUMNS = 76
/** The 2-cell gutter between the two columns (design language §6.3). */
const COLUMN_GAP = 2
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

/** Surface-local keys (the handler the Action Bar names). */
const WORKSPACE_KEYS = {
  search: '/',
  install: 'i',
  refresh: 'r',
  copy: 'c',
  copyAll: 'C',
  diagnostics: 'd',
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
  autoDisable: 'confirm:auto-disable',
  cancel: 'confirm:cancel',
} as const

const DIAGNOSTICS_ACTION = {
  copyAll: 'diagnostics:copy-all',
  back: 'diagnostics:back',
} as const

/** Which page-local view is showing. */
export type PluginWorkspaceView = 'list' | 'details' | 'install' | 'confirm' | 'diagnostics'

/**
 * The local viewport the Settings root grants the embedded page for ONE frame.
 * It is the ONLY size authority the page plans against: `width` are the real
 * local cells (excluding any Categories rail), `rows` the real local rows
 * INCLUDING the single semantic bar row, and `allowDual` states whether the
 * root's projection has room for the adjacent `List | Details` pair.
 */
export interface PluginContentViewport {
  readonly width: number
  readonly rows: number
  readonly allowDual: boolean
}

/**
 * The narrow page contract the Settings root consumes. It is TUI-only: the
 * application layer keeps seeing a plain `Component`.
 */
export interface EmbeddedPluginPage extends Component {
  focused: boolean
  /** Release this page and the Host claim it owns, exactly once. */
  dispose(): void
  setViewport(viewport: PluginContentViewport): void
  currentView(): PluginWorkspaceView
  canYieldFocusToNavigation(): boolean
  pendingMutation(): boolean
  /**
   * The page's monotonic gesture revision. It bumps on EVERY local state change
   * that can move a painted target or its meaning (view, filter, query,
   * selected card, install phase, scroll, painted action set), so the Settings
   * root can fence a rail press it recorded before forwarding a key to this
   * page: the same view and yield status can still hide a changed list.
   */
  gestureRevision(): number
  /**
   * Whether the LAST painted frame is still CURRENT: its revision, local grant,
   * live Controller model/read generation, install phase, notice and status all
   * still match. Unlike {@link gestureRevision} this catches a Controller change
   * whose queued repaint has not run yet, so a root gesture recorded before that
   * change is refused instead of resolving against the stale hit map.
   */
  frameIsCurrent(): boolean
  cancelPointer(): void
  handleInput(data: string): void
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined
  onCellPress(x: number, y: number): void
  onCellClick(x: number, y: number): void
  /**
   * The List|Details split of the LAST local plan. The Settings root paints the
   * shared pane-header labels with these EXACT widths, so the header can never
   * drift from the columns the page really painted.
   */
  contentLayout(): { readonly dual: boolean; readonly leftWidth: number; readonly rightWidth: number }
}

/** One painted hit target of the LAST frame (never a screen-index authority). */
interface HitTarget {
  readonly kind: 'card' | 'action' | 'filter' | 'pane' | 'search' | 'diagnostic-fact' | 'diagnostic-action'
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
  /** The LOCAL viewport triple of the frame the press was admitted against. */
  readonly width: number
  readonly rows: number
  readonly allowDual: boolean
}

/** One line of the list projection. */
interface ListEntry {
  readonly kind: 'section' | 'subheader' | 'card' | 'empty'
  readonly label: string
  readonly value?: string
  readonly card?: PluginCardView
}

/**
 * The per-frame LOCAL chrome budget of the embedded page (design language §8):
 * one optional Search/Filters row, one optional Host-notice row, the business
 * body and the single semantic bar. The shared Settings Header/Metadata/Rules
 * belong to the ROOT and are never planned here.
 */
interface ChromePlan {
  readonly width: number
  readonly rows: number
  readonly searchRows: 0 | 1
  readonly noticeRows: 0 | 1
  readonly actionRows: 1
  readonly bodyRows: number
  readonly dual: boolean
  readonly leftWidth: number
  readonly rightWidth: number
}

/** One detail/install/confirm action line the frame really painted. */
interface PaintedActionLine {
  readonly value: string
  readonly line: number
}

/** One selectable diagnostics fact (a summary fact or one contribution). */
interface DiagnosticsFact {
  readonly id: string
  readonly copy: string
  readonly label?: string
  readonly contribution?: TuiContributionDiagnostic
}

/** One line span of one painted diagnostics fact (viewport source rows). */
interface DiagnosticSpan {
  readonly start: number
  readonly count: number
  /** The fact's leading identity/state rows (kept sticky while paging). */
  readonly headRows: number
}

interface DiagnosticsLayout {
  readonly lines: string[]
  readonly spans: ReadonlyMap<string, DiagnosticSpan>
  readonly targets: readonly {
    readonly kind: 'diagnostic-fact' | 'diagnostic-action'
    readonly value: string
    readonly line: number
    readonly startCol: number
    readonly endCol: number
  }[]
}

function diagnosticsFactId(
  group: 'associated' | 'unassociated',
  entry: TuiContributionDiagnostic,
): string {
  return `diagnostics:${group}:${entry.owner}:${entry.extensionPoint}:${entry.id}`
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
  /** The confirm page's own content scroll (the pinned choices never move). */
  private confirmOffset = 0
  private paintedConfirmScrollMax = 0
  private installSelection = 0
  /** The diagnostics page's own immutable read (captured on entry/refresh)
   *  and its fact selection/scroll state. */
  private diagnosticsSnapshot: TuiExtensionDiagnostics | undefined
  /** The last painted diagnostics CONTENT key (a same-content reread keeps
   *  the painted revision stable). */
  private lastDiagnosticsKey: string | undefined
  private diagnosticsSelection = 0
  private diagnosticsOffset = 0
  private diagnosticsReveal = false
  /** Whether the CURRENT diagnostics content is taller than its body. */
  private diagnosticsScrollable = false
  /** The painted fact spans and viewport of the LAST diagnostics frame. */
  private diagnosticsSpans: ReadonlyMap<string, DiagnosticSpan> = new Map()
  private diagnosticsViewport = 0
  private diagnosticsLineCount = 0
  /** Whether the selected fact's FIRST row is inside the painted body. */
  private diagnosticsSelectionVisible = false
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
  /** The action values actually painted in the LAST confirm frame, in order.
   *  The keyboard selection indexes THIS list, so hiding the dangerous primary
   *  (risk not fully visible) cannot leave Enter pointing at it. */
  private paintedConfirmActionValues: readonly string[] = []
  private pressedGesture: PressedGesture | undefined
  /** The LOCAL viewport granted by the Settings root. The page never reads the
   *  physical terminal: its layout (and dual admission) lives entirely here. */
  private viewport: PluginContentViewport = { width: 0, rows: 0, allowDual: false }
  private lastRenderWidth = -1
  private lastRenderRows = -1
  private lastRenderAllowDual: boolean | undefined
  private lastModelKey: string | undefined
  private lastView: PluginWorkspaceView | undefined
  private lastPhase: string | undefined
  private lastNotice: string | undefined
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
    // Every page starts on the Plugin List. A previous attempt (running or
    // terminal) is NOT auto-opened: the Controller keeps its request id/log and
    // the explicit `i` reopens the SAME attempt from the list.
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    this._focused = value
    this.syncInputFocus()
  }

  /**
   * Install the local viewport the Settings root grants this frame. An
   * identical grant keeps every selection/filter/scroll offset AND the painted
   * action grants; ANY change (width, rows or dual admission) revokes the old
   * painted actions/confirm/scroll authority and marks the frame stale until
   * the next paint. It never reads the Host and never re-plans business state.
   */
  setViewport(viewport: PluginContentViewport): void {
    if (this.disposed) return
    const width = Math.max(1, Math.floor(viewport.width))
    const rows = Math.max(1, Math.floor(viewport.rows))
    const allowDual = viewport.allowDual === true
    if (width === this.viewport.width && rows === this.viewport.rows && allowDual === this.viewport.allowDual) return
    this.viewport = { width, rows, allowDual }
    // A viewport change revokes the GRANTS of the previous frame, but it is not
    // a zero-body frame: the selected install/confirm index survives so a
    // resize round trip restores the SAME action the user was on.
    this.revokePaintedGrants()
    this.pressedGesture = undefined
    this.bumpRevision()
  }

  /**
   * Whether the page may hand the keyboard back to the Settings Categories
   * rail. Pure query: only the untouched List root qualifies — never an edit,
   * never a pending mutation, and never a background install (Esc hiding an
   * install must be able to leave the page).
   */
  canYieldFocusToNavigation(): boolean {
    return this.view === 'list' && !this.searchEditing && this.controller.busy() === undefined
  }

  /**
   * Whether a User navigation may not abandon this page right now. The
   * Controller's own mutation guard is the authority; a dispatched Host install
   * is deliberately NOT included (Esc hide leaves it running).
   */
  pendingMutation(): boolean {
    return this.controller.busy() !== undefined
  }

  /** See {@link EmbeddedPluginPage.gestureRevision}. */
  gestureRevision(): number {
    return this.revision
  }

  /** Revoke one in-flight press (never a Host operation). */
  cancelPointer(): void {
    this.pressedGesture = undefined
  }

  /** The List|Details split of the last local plan (see the interface). */
  contentLayout(): { readonly dual: boolean; readonly leftWidth: number; readonly rightWidth: number } {
    const plan = this.paintedChrome
    if (plan === undefined) return { dual: false, leftWidth: this.viewport.width, rightWidth: this.viewport.width }
    return { dual: plan.dual, leftWidth: plan.leftWidth, rightWidth: plan.rightWidth }
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
    // §4.2: below the body floor the frame paints ONLY its real Esc
    // destination, so every other key (body action, copy, filter, search edit)
    // is a hidden action and must not run. The floor is read from the CURRENT
    // grant: `setViewport` may have shrunk it after the last paint.
    if (this.bodyFloor() <= 0) return
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
    if (this.view === 'diagnostics') {
      this.handleDiagnosticsInput(data)
      return
    }
    if (this.view === 'details') {
      this.handleDetailsInput(data)
      return
    }
    this.handleListInput(data)
  }

  /** The embedded page: the wheel routes to the pane under the LOCAL pointer;
   *  the Settings root translates press/click into this page's coordinates. */
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
    if (this.view === 'diagnostics') {
      this.scrollDiagnostics(delta > 0 ? 1 : -1, Math.abs(delta))
      return { handled: true }
    }
    if (this.view === 'install') {
      if (this.scrollInstall(delta, plan)) this.bumpRevision()
      this.intents.requestRender()
      return { handled: true }
    }
    if (this.view === 'confirm') {
      this.scrollConfirm(delta > 0 ? 1 : -1)
      return { handled: true }
    }
    // The List|Details pair routes by the column the pointer is REALLY over:
    // the List column scrolls the list, the Details column scrolls the details,
    // and the 2-cell pair gutter belongs to neither pane (§3.4: inert). A
    // single-column frame scrolls the ONE view it paints.
    if (!plan.dual) {
      if (this.view === 'details') this.scrollDetail(delta)
      else this.scrollList(delta)
      return { handled: true }
    }
    if (event.x >= plan.leftWidth && event.x < plan.leftWidth + COLUMN_GAP) return { handled: true }
    if (event.x >= plan.leftWidth + COLUMN_GAP) this.scrollDetail(delta)
    else this.scrollList(delta)
    return { handled: true }
  }

  /** A wheel that cannot move the painted window is NOT a gesture boundary: a
   *  no-op bump would revoke a legitimate press the user still holds (the
   *  Settings root fences its rail presses by this page's revision). */
  private scrollList(delta: number): void {
    const next = Math.max(0, this.listOffset + delta)
    if (next !== this.listOffset) {
      this.listOffset = next
      this.bumpRevision()
    }
    this.intents.requestRender()
  }

  private scrollDetail(delta: number): void {
    const next = Math.max(0, this.detailOffset + delta)
    if (next !== this.detailOffset) {
      this.detailOffset = next
      this.bumpRevision()
    }
    this.intents.requestRender()
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
        width: this.viewport.width,
        rows: this.viewport.rows,
        allowDual: this.viewport.allowDual,
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
    // revision/view/selection/LOCAL viewport: a refresh, filter/search change,
    // page switch OR a local viewport change (even before its repaint) refuses
    // the click.
    if (
      this.revision !== pressed.revision
      || this.view !== pressed.view
      || this.selectedValue !== pressed.selectedValue
      || this.viewport.width !== pressed.width
      || this.viewport.rows !== pressed.rows
      || this.viewport.allowDual !== pressed.allowDual
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
    // Left at the List root is the plugin page's OWN "back to Categories"
    // verb (the Settings root only commits the focus change). It never closes
    // Settings and never runs while an edit or a mutation owns the page.
    if (matchesKey(data, 'left')) {
      if (this.canYieldFocusToNavigation()) this.intents.onYieldNavigation()
      return
    }
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
    if (data === WORKSPACE_KEYS.diagnostics) {
      this.openDiagnostics()
      return
    }
    if (data === WORKSPACE_KEYS.refresh || data === WORKSPACE_KEYS.refresh.toUpperCase()) {
      this.controller.refresh()
      this.intents.requestRender()
    }
  }

  /** `d`: open the read-only extension diagnostics page over the same
   *  controller/lease. One explicit read per entry; `r` rereads there. */
  private openDiagnostics(): void {
    if (!this.frameIsCurrent()) return
    this.diagnosticsSelection = 0
    this.diagnosticsOffset = 0
    this.diagnosticsReveal = false
    this.view = 'diagnostics'
    this.bumpRevision()
    this.intents.requestRender()
  }

  private leaveDiagnostics(): void {
    this.view = 'list'
    this.focus = 'list'
    this.diagnosticsReveal = false
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Reread the live extension diagnostics on explicit request. The official
   *  package inventory is NOT refreshed by this key. */
  private reloadDiagnostics(): void {
    // The next paint performs exactly ONE new read (see syncFrameState).
    const count = this.diagnosticsFacts().length
    this.diagnosticsSelection = Math.min(this.diagnosticsSelection, Math.max(0, count - 1))
    this.diagnosticsReveal = true
    this.bumpRevision()
    this.intents.requestRender()
  }

  private handleDiagnosticsInput(data: string): void {
    if (matchesKey(data, 'up') || matchesKey(data, 'ctrl+p')) {
      this.moveDiagnosticsSelection(-1)
      return
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'ctrl+n')) {
      this.moveDiagnosticsSelection(1)
      return
    }
    if (matchesKey(data, 'pageUp')) {
      this.scrollDiagnostics(-1)
      return
    }
    if (matchesKey(data, 'pageDown')) {
      this.scrollDiagnostics(1)
      return
    }
    if (matchesKey(data, 'home')) {
      this.selectDiagnosticsFirst()
      return
    }
    if (matchesKey(data, 'end')) {
      this.selectDiagnosticsLast()
      return
    }
    if (data === WORKSPACE_KEYS.copy) {
      this.copyDiagnosticsSelection()
      return
    }
    if (data === WORKSPACE_KEYS.copyAll) {
      this.copyAllDiagnostics()
      return
    }
    if (data === WORKSPACE_KEYS.refresh || data === WORKSPACE_KEYS.refresh.toUpperCase()) {
      this.reloadDiagnostics()
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
    if (matchesKey(data, 'pageUp')) {
      this.scrollConfirm(-1)
      return
    }
    if (matchesKey(data, 'pageDown')) {
      this.scrollConfirm(1)
      return
    }
    if (matchesKey(data, 'up') || matchesKey(data, 'left')) {
      this.confirmSelection = Math.max(0, this.confirmSelection - 1)
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'down') || matchesKey(data, 'right') || matchesKey(data, 'tab')) {
      this.confirmSelection = Math.min(this.confirmSelection + 1, Math.max(0, this.paintedConfirmActionValues.length - 1))
      this.bumpRevision()
      this.intents.requestRender()
      return
    }
    if (matchesKey(data, 'enter')) {
      this.activateConfirmSelection()
    }
  }

  /** Scroll only the confirmation content; the two choices stay pinned. */
  private scrollConfirm(direction: 1 | -1): void {
    if (this.paintedConfirmScrollMax <= 0) return
    const step = Math.max(1, this.paintedChrome?.bodyRows ?? 1)
    const next = Math.min(Math.max(0, this.confirmOffset + direction * step), this.paintedConfirmScrollMax)
    if (next === this.confirmOffset) return
    this.confirmOffset = next
    this.bumpRevision()
    this.intents.requestRender()
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
      this.controller.cancelConfirmation()
      this.closeConfirmation()
      return
    }
    if (this.view === 'diagnostics') {
      this.leaveDiagnostics()
      return
    }
    if (this.view === 'details') {
      this.leaveDetails()
      return
    }
    // The untouched List root yields the keyboard back to the Settings
    // Categories rail: it never closes the page or releases the Host claim.
    if (this.canYieldFocusToNavigation()) this.intents.onYieldNavigation()
  }

  // ── view transitions ─────────────────────────────────────────────────────

  private enterDetails(): void {
    // Admission follows the CURRENT painted frame: after a resize but before
    // the repaint, `paintedChrome` still describes the old geometry. The same
    // currentness fence the mouse/Detail/confirm gates use closes that window.
    if (!this.frameIsCurrent()) return
    // A zero-body frame paints no row; Enter/Right on an invisible selection
    // must not change the page (the bar stops advertising it too).
    if ((this.paintedChrome?.bodyRows ?? 0) <= 0) return
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

  /** Enter the ONE shared confirmation view with Cancel as the default choice. */
  private openConfirmation(): void {
    this.view = 'confirm'
    this.confirmSelection = 1
    this.confirmOffset = 0
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** Leave the confirmation view without writing; the controller owns cancel. */
  private closeConfirmation(): void {
    this.confirmOffset = 0
    this.view = 'details'
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

  // ── diagnostics page ─────────────────────────────────────────────────────

  /** The selectable facts of the CURRENT diagnostics snapshot: the three
   *  summary facts followed by every contribution (associated, then the
   *  unassociated group). Headings are never selectable. */
  private diagnosticsFacts(): readonly DiagnosticsFact[] {
    const view = this.diagnosticsSnapshot
    if (view === undefined) return []
    const facts: DiagnosticsFact[] = [
      { id: 'diagnostics:health', label: 'Health', copy: view.healthSummary },
      { id: 'diagnostics:registries', label: 'Registries', copy: formatTuiExtensionRegistryCounts(view.registryCounts) },
      { id: 'diagnostics:capabilities', label: 'Capabilities', copy: formatTuiExtensionCapabilities(view.capabilities) },
    ]
    for (const entry of view.entries) facts.push(this.diagnosticsEntryFact(entry, 'associated'))
    for (const entry of view.unmappedEntries) facts.push(this.diagnosticsEntryFact(entry, 'unassociated'))
    return facts
  }

  private diagnosticsEntryFact(entry: TuiContributionDiagnostic, group: 'associated' | 'unassociated'): DiagnosticsFact {
    return {
      id: diagnosticsFactId(group, entry),
      copy: formatTuiContributionDiagnostic(entry),
      contribution: entry,
    }
  }

  private ensureDiagnosticsSelection(count: number): void {
    if (this.view !== 'diagnostics') return
    if (count === 0) {
      this.diagnosticsSelection = 0
      return
    }
    if (this.diagnosticsSelection >= count) {
      this.diagnosticsSelection = count - 1
      this.bumpRevision()
    }
  }

  private moveDiagnosticsSelection(delta: number): void {
    const count = this.diagnosticsFacts().length
    if (count === 0) return
    const next = Math.min(Math.max(0, this.diagnosticsSelection + delta), count - 1)
    if (next === this.diagnosticsSelection) return
    this.diagnosticsSelection = next
    this.diagnosticsReveal = true
    this.bumpRevision()
    this.intents.requestRender()
  }

  private selectDiagnosticsFirst(): void {
    // Always re-reveal: Home must bring a wheel-scrolled selection back even
    // when its index is already first.
    this.diagnosticsSelection = 0
    this.diagnosticsReveal = true
    this.bumpRevision()
    this.intents.requestRender()
  }

  private selectDiagnosticsLast(): void {
    const count = this.diagnosticsFacts().length
    if (count === 0) return
    this.diagnosticsSelection = count - 1
    this.diagnosticsReveal = true
    this.bumpRevision()
    this.intents.requestRender()
  }

  /**
   * The number of CONTINUATION rows the next page can carry. The sticky
   * identity/state rows consume part of the body, so the offset step must
   * shrink by the same amount: otherwise PgDn would skip the rows that are
   * not painted (the 30x8 case has body 3, sticky 2, capacity 1).
   */
  private diagnosticsScrollCapacity(): number {
    const viewport = this.diagnosticsViewport
    if (viewport <= 0) return 1
    const base = Math.max(1, viewport - 1)
    const fact = this.diagnosticsFacts()[this.diagnosticsSelection]
    const span = fact === undefined ? undefined : this.diagnosticsSpans.get(fact.id)
    const sticky = span !== undefined
      && span.start < this.diagnosticsOffset + base
      && span.start + span.count > this.diagnosticsOffset
    const stickyRows = sticky ? Math.min(span!.headRows, Math.max(0, viewport - 1)) : 0
    return Math.max(1, viewport - stickyRows)
  }

  /** PgUp/PgDn (or a wheel click) move the content by at most the visible
   *  continuation capacity. A wheel may request fewer lines; it is clamped
   *  to the same capacity so it cannot skip a row. */
  private scrollDiagnostics(direction: -1 | 1, requestedLines?: number): void {
    const capacity = this.diagnosticsScrollCapacity()
    const step = Math.min(Math.max(1, requestedLines ?? capacity), capacity)
    const viewport = this.diagnosticsViewport
    const fact = this.diagnosticsFacts()[this.diagnosticsSelection]
    const span = fact === undefined ? undefined : this.diagnosticsSpans.get(fact.id)
    const stickyRowsFor = (offset: number): number => span !== undefined
      && span.start < offset
      && span.start + span.count > offset
      ? Math.min(span.headRows, Math.max(0, viewport - 1))
      : 0
    // The sticky identity rows reserve body space, exactly like the paint; the
    // scroll bound must therefore leave the final continuation row reachable.
    const max = (() => {
      const probe = Math.max(0, this.diagnosticsOffset + direction * step)
      return Math.max(0, this.diagnosticsLineCount - Math.max(1, viewport - stickyRowsFor(probe)))
    })()
    const next = Math.min(Math.max(0, this.diagnosticsOffset + direction * step), max)
    this.diagnosticsOffset = next
    // Keep the SELECTED fact visible: if the current selection no longer
    // intersects the new page, select the first fact that does. This is the
    // About page's page-scroll model, so `c` never copies an offscreen fact
    // after paging.
    if (viewport > 0) {
      const facts = this.diagnosticsFacts()
      const current = facts[this.diagnosticsSelection]
      const currentSpan = current === undefined ? undefined : this.diagnosticsSpans.get(current.id)
      const currentVisible = currentSpan !== undefined
        && currentSpan.start + currentSpan.count > next
        && currentSpan.start < next + viewport
      if (!currentVisible) {
        const index = facts.findIndex(fact => {
          const span = this.diagnosticsSpans.get(fact.id)
          return span !== undefined && span.start + span.count > next && span.start < next + viewport
        })
        if (index >= 0) this.diagnosticsSelection = index
      }
    }
    this.diagnosticsReveal = false
    this.bumpRevision()
    this.intents.requestRender()
  }

  /** `c`: copy the SELECTED fact's exact payload (a summary value or the
   *  full contribution block, including the whole lastError). Copy is
   *  admitted only when the selected fact's FIRST row is on screen: paging
   *  inside a too-tall block must never copy an identity the user cannot
   *  see. */
  private copyDiagnosticsSelection(): void {
    if (!this.diagnosticsSelectionVisible) return
    const fact = this.diagnosticsFacts()[this.diagnosticsSelection]
    if (fact === undefined) return
    this.intents.onCopy(fact.copy)
  }

  /** `C`: Copy All of the SAME immutable snapshot the page painted. */
  private copyAllDiagnostics(): void {
    const view = this.diagnosticsSnapshot
    if (view === undefined) return
    this.intents.onCopy(serializeTuiExtensionDiagnostics(view))
  }

  /** Build the diagnostics body from ONE captured snapshot. Every displayed
   *  value, the header counts and every copy payload come from this snapshot;
   *  facts are wrapped (never ellipsized) and the per-fact Copy/action
   *  targets are derived from the REAL painted cells. */
  private buildDiagnosticsLayout(width: number, selectedId: string | undefined): DiagnosticsLayout {
    const view = this.diagnosticsSnapshot
    if (view === undefined) {
      return {
        lines: [
          color.warning('Extension diagnostics unavailable — the extension service is not attached.'),
        ],
        spans: new Map(),
        targets: [],
      }
    }
    const lines: string[] = []
    const spans = new Map<string, DiagnosticSpan>()
    const targets: {
      kind: 'diagnostic-fact' | 'diagnostic-action'
      value: string
      line: number
      startCol: number
      endCol: number
    }[] = []
    const markerWidth = 2
    const contentWidth = Math.max(1, width - markerWidth)
    const copyLabel = ` Copy [${WORKSPACE_KEYS.copy.toUpperCase()}]`
    const copyWidth = visibleWidth(copyLabel)
    const facts = this.diagnosticsFacts()
    const factById = new Map(facts.map(fact => [fact.id, fact]))
    const plainMarker = '  '
    const selectedMarker = color.primary('> ')
    const markerFor = (selected: boolean): string => selected ? selectedMarker : plainMarker
    const appendCopyTarget = (factId: string): void => {
      const last = lines.length - 1
      if (last < 0) return
      const startCol = visibleWidth(stripAnsi(lines[last]!))
      const endCol = startCol + copyWidth
      if (endCol > width) return
      lines[last] += color.primary(copyLabel)
      targets.push({ kind: 'diagnostic-fact', value: factId, line: last, startCol, endCol })
    }
    const pushHeading = (text: string): void => {
      lines.push(color.textDim(truncateToWidth(sanitizedPhysicalLine(text), width, '…')))
    }
    const pushSummary = (fact: DiagnosticsFact): void => {
      const label = fact.label ?? ''
      const head = `${label}  `
      const headWidth = visibleWidth(head)
      const valueWidth = Math.max(1, contentWidth - headWidth)
      const wrapped = wrapTextWithAnsi(sanitizedPhysicalLine(fact.copy), valueWidth)
      const parts = wrapped.length === 0 ? [''] : wrapped
      const selected = fact.id === selectedId
      const ink = selected ? color.textStrong : color.text
      const start = lines.length
      parts.forEach((part, index) => {
        if (index === 0) lines.push(`${markerFor(selected)}${color.textDim(head)}${ink(part)}`)
        else lines.push(`${' '.repeat(markerWidth + headWidth)}${ink(part)}`)
      })
      spans.set(fact.id, { start, count: lines.length - start, headRows: 1 })
      appendCopyTarget(fact.id)
    }
    const pushContribution = (fact: DiagnosticsFact): void => {
      const entry = fact.contribution!
      const selected = fact.id === selectedId
      const marker = markerFor(selected)
      const ink = selected ? color.textStrong : color.text
      const chip = `[${entry.state}]`
      const chipWidth = visibleWidth(chip)
      const chipTone = entry.state === 'active'
        ? 'muted'
        : entry.state === 'failed' || entry.state === 'shadowed' ? 'warning' : 'dim'
      const header = sanitizedPhysicalLine(`${entry.extensionPoint}:${entry.id}`)
      const start = lines.length
      let headerRows = 1
      if (contentWidth < chipWidth + 2) {
        // An absurdly narrow frame cannot carry the whole chip beside the
        // label: keep BOTH, the chip on its own full line.
        const parts = wrapTextWithAnsi(header, contentWidth)
        ;(parts.length === 0 ? [''] : parts).forEach((part, index) => {
          lines.push(`${index === 0 ? marker : plainMarker}${ink(part)}`)
        })
        lines.push(`${plainMarker}${paintTone(chip, chipTone)}`)
        headerRows = lines.length - start
      } else {
        // The identity (`extensionPoint:id`) wraps as ONE uninterrupted
        // string; the state chip follows on the LAST wrapped line (or its own
        // line when it cannot fit there) so it never splits the identity.
        const parts = wrapTextWithAnsi(header, contentWidth)
        const normalized = parts.length === 0 ? [''] : parts
        normalized.forEach((part, index) => {
          const lineMarker = index === 0 ? marker : plainMarker
          if (index === normalized.length - 1) {
            const gap = contentWidth - visibleWidth(part) - chipWidth
            if (gap >= 1) {
              lines.push(`${lineMarker}${ink(part)}${' '.repeat(gap)}${paintTone(chip, chipTone)}`)
            } else {
              lines.push(`${lineMarker}${ink(part)}`)
              lines.push(`${plainMarker}${paintTone(chip, chipTone)}`)
            }
          } else {
            lines.push(`${lineMarker}${ink(part)}`)
          }
        })
        headerRows = lines.length - start
      }
      if (entry.lastError !== undefined) {
        const errorHead = 'error  '
        const errorHeadWidth = visibleWidth(errorHead)
        const errorWidth = Math.max(1, contentWidth - errorHeadWidth)
        const parts = wrapTextWithAnsi(sanitizedPhysicalLine(entry.lastError), errorWidth)
        ;(parts.length === 0 ? [''] : parts).forEach((part, index) => {
          // The selection cursor belongs to the fact's FIRST line only; the
          // error block is a continuation, never a second selected row.
          if (index === 0) lines.push(`${plainMarker}${color.textDim(errorHead)}${color.error(part)}`)
          else lines.push(`${' '.repeat(markerWidth + errorHeadWidth)}${color.error(part)}`)
        })
      }
      spans.set(fact.id, { start, count: lines.length - start, headRows: headerRows })
      appendCopyTarget(fact.id)
    }
    for (const fact of facts) {
      if (fact.label !== undefined) pushSummary(fact)
    }
    if (view.entries.length > 0) {
      if (lines.length > 0) lines.push('')
      pushHeading('Contributions')
      let owner: string | undefined
      for (const entry of view.entries) {
        if (entry.owner !== owner) {
          owner = entry.owner
          pushHeading(`Owner: ${entry.owner}${entry.entryId === undefined ? '' : ` (entry: ${entry.entryId})`}`)
        }
        const fact = factById.get(diagnosticsFactId('associated', entry))
        if (fact !== undefined) pushContribution(fact)
      }
    }
    if (view.unmappedEntries.length > 0) {
      if (lines.length > 0) lines.push('')
      pushHeading('Unassociated extension contributions')
      let owner: string | undefined
      for (const entry of view.unmappedEntries) {
        if (entry.owner !== owner) {
          owner = entry.owner
          pushHeading(`Owner: ${entry.owner}`)
        }
        const fact = factById.get(diagnosticsFactId('unassociated', entry))
        if (fact !== undefined) pushContribution(fact)
      }
    }
    if (lines.length > 0) lines.push('')
    const actionLine = lines.length
    let column = 0
    let painted = ''
    // Whole-segment degradation: Copy All first, then Back. At the narrow
    // floor both fit; a segment never paints a partial affordance.
    for (const segment of [
      { id: DIAGNOSTICS_ACTION.copyAll, text: `Copy All [${WORKSPACE_KEYS.copy.toUpperCase()}]` },
      { id: DIAGNOSTICS_ACTION.back, text: 'Back' },
    ]) {
      const separator = painted === '' ? '' : '   '
      const segmentWidth = visibleWidth(segment.text)
      if (column + visibleWidth(separator) + segmentWidth > width) break
      painted += `${separator}${color.primary(segment.text)}`
      const startCol = column + visibleWidth(separator)
      targets.push({
        kind: 'diagnostic-action',
        value: segment.id,
        line: actionLine,
        startCol,
        endCol: startCol + segmentWidth,
      })
      column = startCol + segmentWidth
    }
    lines.push(painted)
    return { lines, spans, targets }
  }

  private renderDiagnosticsBody(plan: ChromePlan, bodyTop: number, targets: HitTarget[]): string[] {
    const facts = this.diagnosticsFacts()
    this.ensureDiagnosticsSelection(facts.length)
    const selectedId = facts[this.diagnosticsSelection]?.id
    const built = this.buildDiagnosticsLayout(plan.width, selectedId)
    const viewport = plan.bodyRows
    this.diagnosticsSpans = built.spans
    this.diagnosticsViewport = viewport
    this.diagnosticsLineCount = built.lines.length
    const span = selectedId === undefined ? undefined : built.spans.get(selectedId)
    this.diagnosticsScrollable = built.lines.length > viewport
    if (span !== undefined && this.diagnosticsReveal) {
      // A fact taller than the viewport is revealed from its FIRST line, so
      // the cursor, identity and state chip are always on screen; PgUp/PgDn
      // then pages the remaining rows. A shorter fact aligns fully.
      if (span.count > viewport) this.diagnosticsOffset = span.start
      else if (span.start < this.diagnosticsOffset) this.diagnosticsOffset = span.start
      else if (span.start + span.count > this.diagnosticsOffset + viewport) {
        this.diagnosticsOffset = span.start + span.count - viewport
      }
    }
    const stickyRowsFor = (offset: number): number => span !== undefined
      && span.start < offset
      && span.start + span.count > offset
      ? Math.min(span.headRows, Math.max(0, viewport - 1))
      : 0
    // The sticky identity rows consume part of the body, so the offset window
    // is not `viewport` rows tall at the end: clamping with the plain
    // `count - viewport` bound would leave the last continuation rows
    // unreachable. The clamp therefore keeps room for the real painted rows.
    const maxOffset = Math.max(0, built.lines.length - Math.max(1, viewport - stickyRowsFor(this.diagnosticsOffset)))
    this.diagnosticsOffset = Math.min(Math.max(0, this.diagnosticsOffset), maxOffset)
    const stickyRows = stickyRowsFor(this.diagnosticsOffset)
    this.diagnosticsSelectionVisible = span !== undefined
      && (stickyRows > 0
        || (span.start >= this.diagnosticsOffset && span.start < this.diagnosticsOffset + viewport))
    this.diagnosticsReveal = false
    for (const target of built.targets) {
      const y = target.line - this.diagnosticsOffset + (target.line >= this.diagnosticsOffset ? stickyRows : 0)
      if (y < 0 || y >= viewport) continue
      targets.push({
        kind: target.kind,
        value: target.value,
        row: bodyTop + y,
        startCol: target.startCol,
        endCol: target.endCol,
      })
    }
    const visible = stickyRows === 0
      ? built.lines.slice(this.diagnosticsOffset, this.diagnosticsOffset + viewport)
      : [
          ...built.lines.slice(span!.start, span!.start + stickyRows),
          ...built.lines.slice(this.diagnosticsOffset, this.diagnosticsOffset + viewport - stickyRows),
        ]
    return padBody(visible, viewport, plan.width)
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
        return
      case 'diagnostic-fact': {
        const fact = this.diagnosticsFacts().find(candidate => candidate.id === target.value)
        if (fact === undefined) return
        this.intents.onCopy(fact.copy)
        return
      }
      case 'diagnostic-action':
        if (target.value === DIAGNOSTICS_ACTION.copyAll) this.copyAllDiagnostics()
        else if (target.value === DIAGNOSTICS_ACTION.back) this.leaveDiagnostics()
    }
  }

  private dispatchAction(value: string): void {
    const card = this.selectedCard()
    const rowEntry = rowToggleEntryId(value)
    if (rowEntry !== undefined) {
      if (card !== undefined && this.controller.toggleRow(card.value, rowEntry)) this.openConfirmation()
      return
    }
    switch (value) {
      case PLUGIN_ACTION.back:
        this.leaveDetails()
        return
      case PLUGIN_ACTION.toggle:
        if (card !== undefined && this.controller.toggleCard(card.value)) this.openConfirmation()
        return
      case PLUGIN_ACTION.remove:
        if (card !== undefined && this.controller.requestRemove(card.value)) this.openConfirmation()
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
        this.closeConfirmation()
        return
      case CONFIRM_ACTION.autoDisable:
        this.controller.confirmAutoDisable()
        this.closeConfirmation()
        return
      case CONFIRM_ACTION.cancel:
        this.controller.cancelConfirmation()
        this.closeConfirmation()
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
    const value = this.paintedConfirmActionValues[this.confirmSelection]
    if (value === undefined) return
    // Only the action this frame actually painted may be invoked from the
    // keyboard; a stale/short frame does not grant a hidden Remove/Cancel or a
    // dangerous primary whose consequence is not fully visible.
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

  /** Returns whether the window really moved: a no-op wheel is not a gesture
   *  boundary (see {@link scrollList}). */
  private scrollInstall(delta: number, plan: ChromePlan | undefined): boolean {
    const install = this.controller.installView()
    if (install === undefined) return false
    if (install.phase === 'starting' || install.phase === 'installing' || install.phase === 'applying' || install.phase === 'cancelling') {
      const visible = this.visibleLogLines(plan)
      if (!this.logsExpanded) return false
      const max = Math.max(0, install.log.length - visible)
      const next = Math.min(Math.max(0, this.logOffset + delta), max)
      if (next === this.logOffset) return false
      this.logOffset = next
      return true
    }
    const next = Math.max(0, this.installOffset + delta)
    if (next === this.installOffset) return false
    this.installOffset = next
    return true
  }

  private visibleLogLines(plan: ChromePlan | undefined): number {
    const body = Math.max(1, plan?.bodyRows ?? 6)
    return Math.max(1, body - 6)
  }

  private installOffset = 0

  // ── rendering ────────────────────────────────────────────────────────────

  render(width: number): string[] {
    if (this.disposed) return []
    if (width !== this.viewport.width) {
      throw new Error(
        `the embedded Plugin Manager page must be rendered at its granted viewport width (${this.viewport.width}), not ${width}`,
      )
    }
    this.syncInputFocus()
    this.syncFrameState()
    this.ensureSelection()
    this.ensureDetailSelection()
    this.ensureDiagnosticsSelection(this.diagnosticsFacts().length)
    // Diagnostics paints extension health only: a Host inventory notice must
    // not dominate a freshly read extension projection, and the shared App
    // notice is painted ONCE by the Settings root (never here).
    const plan = this.livePlan()
    this.paintedChrome = plan
    const lines: string[] = []
    const targets: HitTarget[] = []
    if (plan.searchRows === 1) lines.push(this.renderSearchRow(plan, 0, targets))
    if (plan.noticeRows === 1) lines.push(this.renderNotice(plan))
    const bodyTop = this.bodyTop(plan)
    if (plan.bodyRows > 0) {
      lines.push(...this.renderBody(plan, bodyTop, targets))
    } else {
      // No body row was painted, so no body-derived action is authorized by
      // this frame. Revoke every painted permission and force a fresh visible
      // selection when the body returns; `frameIsCurrent()` alone must not
      // resurrect an old Approve/Disable/Remove from the previous frame.
      this.revokePaintedActions()
    }
    // The semantic bar is ALWAYS the local last row: the Settings root moves it
    // to the frame's physical last row unless the Categories rail owns the keys.
    lines.push(this.renderActionBar(plan))
    this.paintedTargets = targets
    this.paintedRevision = this.revision
    this.lastRenderWidth = this.viewport.width
    this.lastRenderRows = this.viewport.rows
    this.lastRenderAllowDual = this.viewport.allowDual
    return lines.slice(0, plan.rows)
  }

  /** Revoke every body-derived permission a previous frame granted. */
  private revokePaintedGrants(): void {
    this.paintedDetailSelectionVisible = false
    this.paintedInstallActions = new Set()
    this.paintedConfirmActions = new Set()
    this.paintedConfirmActionValues = []
    this.paintedConfirmScrollMax = 0
    this.diagnosticsScrollable = false
    this.diagnosticsSelectionVisible = false
  }

  /** A ZERO-BODY frame additionally forces a fresh visible selection when the
   *  body returns: a stale index could otherwise point at a dangerous action
   *  that the short frame never painted. */
  private revokePaintedActions(): void {
    this.revokePaintedGrants()
    this.installSelection = Number.MAX_SAFE_INTEGER
  }

  /** Bump the gesture revision whenever the NEXT frame could move a painted
   * target: model identity, view, install phase, Host notice, selection/focus,
   * filter/query or the LOCAL viewport grant. */
  private syncFrameState(): void {
    const modelKey = this.modelStateKey()
    const install = this.controller.installView()
    const notice = this.controller.notice()
    const statusState = this.controller.status().state
    let changed = false
    if (this.lastRenderWidth >= 0
      && (this.lastRenderWidth !== this.viewport.width
        || this.lastRenderRows !== this.viewport.rows
        || this.lastRenderAllowDual !== this.viewport.allowDual)) changed = true
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
    if (this.lastStatusState !== statusState) { this.lastStatusState = statusState; changed = true }
    if (this.lastSelectedValue !== this.selectedValue) { this.lastSelectedValue = this.selectedValue; changed = true }
    if (this.lastFocus !== this.focus) { this.lastFocus = this.focus; changed = true }
    if (this.lastFilter !== this.filter) { this.lastFilter = this.filter; changed = true }
    if (this.lastQuery !== this.query) { this.lastQuery = this.query; changed = true }
    if (this.view === 'diagnostics') {
      // ONE immutable read per diagnostics paint: host invalidation (a
      // ledger failure/recovery) repaints and therefore derives current
      // facts, while copy still uses exactly the painted snapshot.
      const next = this.intents.diagnostics?.()
      const key = next === undefined ? 'unavailable' : serializeTuiExtensionDiagnostics(next)
      this.diagnosticsSnapshot = next
      if (this.lastDiagnosticsKey !== key) { this.lastDiagnosticsKey = key; changed = true }
    }
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

  /** The first local row of the business body: the admitted chrome above it. */
  private bodyTop(plan: ChromePlan): number {
    return plan.searchRows + plan.noticeRows
  }

  /** The local chrome plan the CURRENT grant implies: the same pure function
   *  {@link render} paints, evaluated from the live grant and controller facts.
   *  Input admission must agree with the frame the bar describes. */
  private livePlan(): ChromePlan {
    const hostNoticeLive = this.controller.notice() !== undefined
      || this.controller.status().state === 'error'
      || this.controller.model().exemptionWarnings.length > 0
    // Diagnostics paints extension health only: the shared App notice belongs
    // to the Settings root and a Host inventory notice never dominates it.
    return planChrome(this.viewport, this.view, this.view !== 'diagnostics' && hostNoticeLive)
  }

  /** The business-body floor of the CURRENT grant (never the last paint's):
   *  `setViewport` may shrink it before the repaint that installs it. */
  private bodyFloor(): number {
    return this.livePlan().bodyRows
  }

  /** The ONE admitted Search/Filters row of the list and details views. */
  private renderSearchRow(plan: ChromePlan, row: number, targets: HitTarget[]): string {
    const filterWidth = FILTERS.reduce((sum, filter) => sum + visibleWidth(FILTER_LABELS[filter]) + 3, 0)
    const searchWidth = Math.max(1, plan.width - filterWidth - 2)
    if (this.searchEditing) {
      const input = this.searchInput.render(Math.max(1, searchWidth))
      targets.push({ kind: 'search', value: 'search', row, startCol: 0, endCol: plan.width })
      return `${color.textDim('Search: ')}${input[0] ?? ''}`
    }
    const query = this.query === '' ? '/' : sanitizedPhysicalLine(this.query)
    const painted = composeEdge(
      `${color.textDim('Search: ')}${color.text(query)}`,
      this.filterChips(),
      plan.width,
    )
    const text = this.query === '' ? 'Search: /' : `Search: ${query}`
    targets.push({ kind: 'search', value: 'search', row, startCol: 0, endCol: visibleWidth(text) })
    // The chips are painted only when the whole row fits beside the search
    // field; their hit targets are computed from the REAL painted columns.
    const rendered = this.filterChips()
    const start = plan.width - visibleWidth(rendered)
    if (start >= visibleWidth(text) + 1) {
      let column = start
      for (const filter of FILTERS) {
        const label = FILTER_LABELS[filter]
        const width = visibleWidth(label)
        targets.push({ kind: 'filter', value: filter, row, startCol: column, endCol: column + width })
        column += width + 3
      }
    }
    return painted
  }

  private filterChips(): string {
    return FILTERS.map((filter) => {
      const label = FILTER_LABELS[filter]
      if (filter === this.filter) return color.textStrong(label)
      return color.textDim(label)
    }).join(color.textMuted(' · '))
  }

  /** The page's OWN Host notice row: a settled/refused operation message, a
   *  failed inventory read or a version-exemption warning. The shared App
   *  notice is NOT a second source here — the Settings root paints it once. */
  private renderNotice(plan: ChromePlan): string {
    const model = this.controller.model()
    const exemptionWarning = model.exemptionWarnings.length === 0
      ? undefined
      : `version exemptions: ${model.exemptionWarnings.join(' · ')}`
    const message = this.controller.notice()
      ?? (this.controller.status().state === 'error' ? this.controller.status().error : undefined)
      ?? exemptionWarning
    if (message === undefined) return fit('', plan.width)
    const failed = this.controller.status().state === 'error'
    const kind = failed || /failed|unknown|refused|cannot|error/i.test(message) ? 'error' : 'info'
    const text = sanitizedPhysicalLine(message)
    // A failed inventory read keeps the last good data visible but must not
    // look current: the page's OWN notice row states the Stale fact (the
    // retired fullscreen header used to carry it).
    const stale = failed ? color.warning('Stale · ') : ''
    const prefix = kind === 'error' ? color.error('✗ ') : color.textMuted('ℹ ')
    return fit(`${stale}${prefix}${kind === 'error' ? color.error(text) : color.textMuted(text)}`, plan.width)
  }

  private renderActionBar(plan: ChromePlan): string {
    const segments = this.actionBarSegments(plan)
    return color.textMuted(renderActionBarRow(segments, plan.width))
  }

  private actionBarSegments(plan: ChromePlan): ActionBarSegment[] {
    const segments = this.frameActionBarSegments()
    // §4.2: a zero-body frame paints no body-derived action, choice, copy or
    // edit. Only the REAL Esc destination stays advertised — exactly the key
    // the input gate admits — so the bar can never promise an invisible action
    // (a hidden Enter/search/filter/refresh must not look executable).
    return plan.bodyRows <= 0
      ? segments.filter(segment => segment.text.startsWith('Esc '))
      : segments
  }

  private frameActionBarSegments(): ActionBarSegment[] {
    // The page is ALWAYS embedded in the Settings lease: Esc at the list root
    // yields to the Categories rail and never closes the screen.
    const back = 'Esc back'
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
      const hasPrimary = this.paintedConfirmActionValues.some(value => value !== CONFIRM_ACTION.cancel)
      return [
        { text: hasPrimary ? 'Enter confirm' : 'Enter cancel', priority: 90 },
        ...(this.paintedConfirmScrollMax > 0 ? [{ text: 'PgUp/PgDn details', priority: 80 }] : []),
        { text: 'Esc cancel', priority: 100 },
      ]
    }
    if (this.view === 'diagnostics') {
      if (this.diagnosticsSnapshot === undefined) {
        return [
          { text: `${WORKSPACE_KEYS.refresh} reread`, priority: 60 },
          { text: 'Esc back', priority: 100 },
        ]
      }
      return [
        { text: 'Up/Down fact', priority: 40 },
        ...(this.diagnosticsScrollable ? [{ text: 'PgUp/PgDn scroll', priority: 35 }] : []),
        ...(this.diagnosticsSelectionVisible ? [{ text: `${WORKSPACE_KEYS.copy} copy`, priority: 70 }] : []),
        { text: `${WORKSPACE_KEYS.copyAll} copy all`, priority: 65 },
        { text: `${WORKSPACE_KEYS.refresh} reread`, priority: 60 },
        { text: 'Esc back', priority: 100 },
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
      { text: `${WORKSPACE_KEYS.diagnostics} diagnostics`, priority: 45 },
      { text: 'r refresh', priority: 40 },
      { text: back, priority: 100 },
    ]
  }

  private renderBody(plan: ChromePlan, bodyTop: number, targets: HitTarget[]): string[] {
    if (this.view === 'install') return this.renderInstallBody(plan, bodyTop, targets)
    if (this.view === 'confirm') return this.renderConfirmBody(plan, bodyTop, targets)
    if (this.view === 'diagnostics') return this.renderDiagnosticsBody(plan, bodyTop, targets)
    if (!plan.dual) {
      // The single column paints the CURRENTLY visible view: Details while the
      // keyboard is in Details, the List everywhere else (a narrow or
      // risk-starved frame never fabricates a hidden second column).
      if (this.view === 'details') {
        const card = this.selectedCard()
        if (card === undefined) return padBody([color.textDim('Select a plugin first')], plan.bodyRows, plan.width)
        return this.renderDetailPane(card, plan.width, plan.bodyRows, true, bodyTop, 0, targets, true)
      }
      return this.renderListPane(plan.width, plan.bodyRows, bodyTop, 0, targets, true)
    }
    // The adjacent List|Details pair. Its identity labels belong to the
    // Settings root's ONE shared pane header, never to this page.
    const left = this.renderListPane(plan.leftWidth, plan.bodyRows, bodyTop, 0, targets, true)
    const rightX = plan.leftWidth + COLUMN_GAP
    const card = this.selectedCard()
    const right = card === undefined
      ? padBody([color.textDim('No plugin selected')], plan.bodyRows, plan.rightWidth)
      : this.renderDetailPane(card, plan.rightWidth, plan.bodyRows, this.focus === 'details', bodyTop, rightX, targets, true)
    for (let i = 0; i < plan.bodyRows; i += 1) {
      targets.push({ kind: 'pane', value: 'list', row: bodyTop + i, startCol: 0, endCol: plan.leftWidth })
      targets.push({ kind: 'pane', value: 'details', row: bodyTop + i, startCol: rightX, endCol: plan.width })
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
    // Paint the cursor with the FINAL in-range selection: the restored frame
    // after a zero-row body must show which (safe) action Enter would dispatch.
    if (actions.length > 0 && this.installSelection >= actions.length) {
      this.installSelection = actions.length - 1
    }
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
    const kind = this.controller.confirmationKind()
    const name = this.controller.confirmingName() ?? '(unknown)'
    const entryId = this.controller.confirmationEntryId()
    const autoDisable = kind === 'auto-disable-bundle' || kind === 'auto-disable-row'
    const title = kind === 'auto-disable-row'
      ? `Disable ${sanitizedPhysicalLine(entryId ?? 'the Auto Review row')} in Auto Review?`
      : autoDisable
        ? 'Disable Auto Review?'
        : `Remove ${sanitizedPhysicalLine(name)}?`
    const primaryValue = kind === 'remove'
      ? CONFIRM_ACTION.remove
      : autoDisable ? CONFIRM_ACTION.autoDisable : undefined
    const primary: PluginDetailAction | undefined = primaryValue === undefined
      ? undefined
      : {
          value: primaryValue,
          label: kind === 'remove' ? 'Remove' : 'Disable Auto Review',
          // A stale card keeps the disabled primary for the controller's
          // explicit "changed since the confirmation opened" refusal; the
          // dangerous primary is WITHHELD only when its risk is not visible.
          enabled: card !== undefined,
          tone: 'warning',
        }
    const content: string[] = []
    content.push(color.textStrong(truncateToWidth(title, plan.width, '…')))
    if (card === undefined) {
      content.push(color.error('This bundle changed since the confirmation opened. Re-open it from the list.'))
    }
    // The required consequence block: every line inside it must be visible on
    // the SAME frame that paints the dangerous primary. The Auto warning is the
    // fixed Owner text; an ordinary remove requires its unload consequence.
    let riskStart = -1
    let riskEnd = -1
    if (autoDisable) {
      riskStart = content.length
      content.push(...wrapTextWithAnsi(AUTO_REVIEW_DISABLE_WARNING, plan.width).map(line => color.warning(line)))
      riskEnd = content.length - 1
      // The Host teardown detail is supplemental, not part of the required
      // consequence; it may scroll without withholding the primary.
      content.push(...wrapTextWithAnsi(
        'The official Host teardown moves existing Auto sessions to Full access; Auto Review is not a sandbox.',
        plan.width,
      ).map(line => color.textDim(line)))
    } else if (kind === 'remove') {
      if (name === AUTO_REVIEW_BUNDLE) {
        riskStart = content.length
        content.push(...wrapTextWithAnsi(AUTO_REVIEW_DISABLE_WARNING, plan.width).map(line => color.warning(line)))
      } else {
        riskStart = content.length
      }
      content.push(...wrapTextWithAnsi(
        'This unloads the bundle and removes the profile dependency. Installed files are removed and DSH does not reinstall it automatically.',
        plan.width,
      ).map(line => color.textDim(line)))
      riskEnd = content.length - 1
    }
    const cancelAction: PluginDetailAction = { value: CONFIRM_ACTION.cancel, label: 'Cancel', enabled: true, tone: 'normal' }
    const fullActions: readonly PluginDetailAction[] = primary === undefined ? [cancelAction] : [primary, cancelAction]
    /** The action rows/content viewport depend only on the action COUNT, never
     *  on which action is selected. Compute geometry without painting. */
    const actionRowsFor = (count: number): number => Math.min(count, plan.bodyRows)
    const contentViewportFor = (count: number): number => Math.max(0, plan.bodyRows - actionRowsFor(count))
    const fullViewport = contentViewportFor(fullActions.length)
    const riskVisible = riskStart < 0
      || (fullViewport > 0
        && riskStart >= this.confirmOffset
        && riskEnd < this.confirmOffset + fullViewport)
    let actions: readonly PluginDetailAction[] = fullActions
    if (primary !== undefined && !riskVisible) {
      // The dangerous action is inseparable from its consequence. Withhold it
      // from BOTH the paint and the hit map; keep Cancel/Esc and scrolling.
      const hint = wrapTextWithAnsi(
        'Scroll with PgUp/PgDn to read the consequence. The dangerous action is withheld until it is fully visible.',
        plan.width,
      ).map(line => color.warning(line))
      content.splice(1, 0, ...hint)
      actions = [cancelAction]
    }
    // Resolve the selection AGAINST THE VISIBLE ACTION LIST BEFORE painting, so
    // the cursor, the painted values and the action bar are one frame. A value
    // that vanished (primary withheld) falls back to Cancel; Cancel never
    // becomes a hidden dangerous action.
    const previousValue = this.paintedConfirmActionValues[this.confirmSelection]
    const visibleCount = Math.min(actions.length, plan.bodyRows)
    const visibleList = actions.slice(0, visibleCount)
    const previousIndex = previousValue === undefined ? -1 : visibleList.findIndex(action => action.value === previousValue)
    const cancelIndex = visibleList.findIndex(action => action.value === CONFIRM_ACTION.cancel)
    const selection = previousIndex >= 0 ? previousIndex : Math.max(0, cancelIndex)
    this.confirmSelection = selection
    const actionBlock = paintActions([], actions, selection, plan.width, false)
    const actionRows = actionRowsFor(actions.length)
    const contentViewport = contentViewportFor(actions.length)
    this.paintedConfirmScrollMax = Math.max(0, content.length - contentViewport)
    this.confirmOffset = clampOffset(this.confirmOffset, content.length, contentViewport)
    const visibleContent = content.slice(this.confirmOffset, this.confirmOffset + contentViewport)
    const out = padBody([...visibleContent], contentViewport, plan.width)
    const visibleActions = actionBlock.lines.slice(0, actionRows)
    for (const line of visibleActions) out.push(fit(line, plan.width))
    const values: string[] = []
    this.paintedConfirmActions = new Set()
    for (const action of actionBlock.actionLines) {
      const y = contentViewport + action.line
      if (y < contentViewport || y >= contentViewport + visibleActions.length) continue
      values.push(action.value)
      this.paintedConfirmActions = new Set([...this.paintedConfirmActions, action.value])
      targets.push({ kind: 'action', value: action.value, row: bodyTop + y, startCol: 0, endCol: plan.width })
    }
    this.paintedConfirmActionValues = values
    // `selection` is already an index in the visible list; clamp only for the
    // degenerate zero-row body.
    this.confirmSelection = Math.min(selection, Math.max(0, values.length - 1))
    return padBody(out, plan.bodyRows, plan.width)
  }

  // ── hit map ──────────────────────────────────────────────────────────────

  private targetAt(x: number, y: number): HitTarget | undefined {
    for (const target of this.paintedTargets) {
      if (y === target.row && x >= target.startCol && x < target.endCol) return target
    }
    return undefined
  }

  /** The semantic presentation key of the inventory: the Host read generation
   *  plus the classified model. ANY new read (an explicit refresh or a Host
   *  invalidation) invalidates an already-painted action even when it returns
   *  byte-identical facts — §3.4 lists `Press -> Host invalidate` among the
   *  releases that must be refused — and any fact that could change a pixel or
   *  an action changes the key as well. */
  private modelStateKey(): string {
    return JSON.stringify([this.controller.readGeneration(), this.controller.model()])
  }

  /** True only while the live semantic facts AND the LOCAL viewport grant still
   * match the frame whose hit map is installed in `paintedTargets`. Comparing
   * only the panel revision would miss an async controller model/phase/notice
   * update whose queued repaint has not run yet. */
  frameIsCurrent(): boolean {
    return this.paintedRevision === this.revision
      && this.lastRenderWidth === this.viewport.width
      && this.lastRenderRows === this.viewport.rows
      && this.lastRenderAllowDual === this.viewport.allowDual
      && this.modelStateKey() === this.lastModelKey
      && this.controller.installView()?.phase === this.lastPhase
      && this.controller.notice() === this.lastNotice
      && this.controller.status().state === this.lastStatusState
  }

  private bumpRevision(): void {
    this.revision += 1
  }
}

/** The intents the app composition wires into the embedded page. */
export interface PluginManagerWorkspacePanelIntents {
  /** Repaint the hosting screen. */
  readonly requestRender: () => void
  /** Copy exact text through the app's Client-local clipboard owner. */
  readonly onCopy: (text: string) => void
  /** The current extension diagnostics read. Absent = no extension service
   *  (the page states Unavailable and never paints an empty healthy report). */
  readonly diagnostics?: () => TuiExtensionDiagnostics | undefined
  /** The Settings root's navigation yield (Esc/Left/Shift+Tab at the list
   * root). The page only reports the intent; the ROOT commits the focus. */
  readonly onYieldNavigation: () => void
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

/**
 * The ONE local chrome plan of the embedded page (§3.2 priority order): the
 * semantic bar is always the last row, the business body keeps at least one
 * real row, then the Host notice (only with two free rows) and the
 * Search/Filters row (list/details only, with two free rows) may claim one.
 * The adjacent List|Details pair additionally requires a dual-allowing root
 * grant, 76 local columns AND six real business body rows.
 */
function planChrome(viewport: PluginContentViewport, view: PluginWorkspaceView, noticeLive: boolean): ChromePlan {
  const width = Math.max(1, Math.floor(viewport.width))
  const rows = Math.max(1, Math.floor(viewport.rows))
  const actionRows = 1
  let free = Math.max(0, rows - actionRows)
  const noticeRows: 0 | 1 = free >= 2 && noticeLive ? 1 : 0
  if (noticeRows === 1) free -= 1
  const searchRows: 0 | 1 = free >= 2 && (view === 'list' || view === 'details') ? 1 : 0
  if (searchRows === 1) free -= 1
  const bodyRows = free
  const dual = viewport.allowDual
    && (view === 'list' || view === 'details')
    && width >= DUAL_MIN_COLUMNS
    && bodyRows >= 6
  // The fixed split (§3.2): 42% of the pair, clamped to 30..42 columns. The
  // 76-column floor above keeps the right pane at >= 24 columns by
  // construction, so no second admission test is needed.
  const leftWidth = dual ? Math.min(42, Math.max(30, Math.floor((width - COLUMN_GAP) * 0.42))) : width
  const rightWidth = dual ? width - leftWidth - COLUMN_GAP : width
  return {
    width,
    rows,
    searchRows,
    noticeRows,
    actionRows,
    bodyRows,
    dual,
    leftWidth,
    rightWidth,
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
