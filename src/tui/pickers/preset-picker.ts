/**
 * `/preset`: ONE root-owned capturing PiTui overlay carrying the Owner-frozen
 * TWO-page Preset surface.
 *
 * - **Catalog** — ONE `SearchablePicker` (search over name/id/description,
 *   Built-in→Custom groups, complete identity labels, atomic state chips) plus
 *   the ONE bottom Action Bar: `Use next`/`Use session`, `Set default`,
 *   `Close [Esc]` (`Esc` last). Selecting, searching and opening a row are
 *   BROWSE-ONLY; the two explicit bar actions are the only writers.
 * - **Details** — ONE strictly read-only scrolled Markdown reader: complete
 *   Name/ID/Type/Scope, the committed relationships, a broken row's failure
 *   reason, the complete description and — for a SHIPPED preset only — the
 *   official Mode guide appended in the same body. The only row below it is
 *   `Back [Esc]`.
 *
 * The panel owns only transient presentation state. Every read/write authority
 * stays in the command: `request.apply` / `request.setDefault` are the original
 * writers, `request.retry` re-enters the command's ONE roster-read owner, and
 * `request.isCurrent()` is rechecked at every admission. A settlement that
 * arrives after the panel was disposed or superseded changes nothing.
 * @module @xmoon76/dsh-pi-tui/tui/pickers/preset-picker
 */

import {
  Markdown,
  getKeybindings,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type RowBudgetAware,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import type {
  PresetApplyOutcome,
  PresetDefaultOutcome,
  PresetPickerRequest,
  PresetPickerRoster,
} from '../../app/command/preset-presentation.ts'
import { safeErrorMessage } from '../../runtime/process/errors.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'
import { ACTION_BAR_SEPARATOR, layoutActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { color, currentPalette, HOST_MARKDOWN_OPTIONS, markdownTheme, selectListTheme } from '../theme/runtime.ts'
import { builtInGuide } from '../tsp/preset-guide-content.ts'
import { isBuiltInPresetRow, presetDisplayText } from './preset-display.ts'
import {
  joinBadgeParts,
  SearchablePicker,
  type SearchablePickerBadgePart,
  type SearchablePickerItem,
} from './searchable-picker.ts'

/** The read/write lifecycle of the panel. `pending` is an ADMITTED write. */
type PresetPhase = 'loading' | 'ready' | 'error' | 'pending'
/** The ONE visible page: Detail REPLACES the Catalog in the same overlay. */
type PresetPage = 'catalog' | 'details'
/** The two logical regions of the Catalog; only `actions` may write. */
type PresetZone = 'list' | 'actions'
/** Which explicit write owns the `pending` phase (the visible label). */
type PendingKind = 'use' | 'default'

/** The identified bar actions. `close` is the dismissal authority. */
type PresetActionId = 'use' | 'set-default' | 'close' | 'retry'

/** One roster row projected for display. Derived from the live DTO on every
 *  read — never a second store. */
interface PresetRowView {
  readonly id: string
  readonly name: string
  readonly description: string | undefined
  readonly builtIn: boolean
  readonly broken: string | undefined
}

/** The RESERVED group keys of the two catalogue groups (NUL-prefixed so no
 *  user preset id can collide with them). */
const BUILT_IN_GROUP_KEY = '\u0000built-in'
const CUSTOM_GROUP_KEY = '\u0000custom'
const BUILT_IN_GROUP_LABEL = 'Built-in'
const CUSTOM_GROUP_LABEL = 'Custom'

/** One complete painted Action Bar action span (columns inside the row). */
interface BarHit {
  readonly id: PresetActionId
  readonly start: number
  readonly end: number
}

interface BarSegment extends ActionBarSegment {
  readonly id: PresetActionId
  readonly enabled: boolean
}

/** The last painted frame: pointer geometry and the semantic facts a gesture
 *  must still agree with at release time. */
interface PresetFrame {
  readonly width: number
  readonly barRow: number
  readonly backRow: number
  /** The complete painted `Back [Esc]` span, absent when it did not fit. */
  readonly backHit: { readonly start: number; readonly end: number } | undefined
  readonly readerLineCount: number
  readonly readerRows: number
  /** How many Catalog list-body rows really painted this frame (a one-row
   *  grant belongs to the exit bar alone, so no row hit may survive from an
   *  older frame). */
  readonly listRows: number
  readonly barHits: readonly BarHit[]
  /** Every action id the bar layout really painted this frame (enabled AND
   *  disabled): a segment the layout dropped is never a keyboard target. */
  readonly fittingActions: readonly PresetActionId[]
  /** The ENABLED actions the bar really painted this frame (pointer targets). */
  readonly paintedActions: readonly PresetActionId[]
  readonly pageMarker: string
  readonly selectionMarker: string
  readonly generation: number
}

type PresetPress =
  | {
    readonly kind: 'bar'
    readonly id: PresetActionId
    readonly row: number
    readonly start: number
    readonly end: number
    readonly width: number
    readonly height: number
    readonly originX: number
    readonly originY: number
    readonly pageMarker: string
    readonly selectionMarker: string
    readonly generation: number
  }
  | {
    readonly kind: 'back'
    readonly row: number
    readonly width: number
    readonly height: number
    readonly originX: number
    readonly originY: number
    readonly pageMarker: string
    readonly selectionMarker: string
    readonly generation: number
  }

/** The panel's dependencies: the command-owned request plus the two app seams
 *  (repaint and the identity-safe overlay closer). */
export interface PresetPickerPanelDeps {
  readonly request: PresetPickerRequest
  /** Ask the surface for one repaint after a local state change. */
  requestRender(): void
  /** Retire ONLY this panel's overlay (the app owns the identity-safe slot). */
  close(): void
}

export class PresetPickerPanel implements Component, RowBudgetAware, Focusable {
  private readonly deps: PresetPickerPanelDeps
  private readonly picker: SearchablePicker
  /** Roster rows by raw id, projected from the last adopted read. */
  private rows = new Map<string, PresetRowView>()
  private phase: PresetPhase = 'loading'
  private page: PresetPage = 'catalog'
  private zone: PresetZone = 'list'
  private pendingKind: PendingKind | undefined
  private roster: PresetPickerRoster | undefined
  /** The browse target: a raw preset id, never an index or a drawn label. */
  private selectedId: string | undefined
  /** The base id the actions zone owns Enter for (a disabled id never wins). */
  private actionFocus: PresetActionId | undefined
  /** The ONE local status statement (read failure / last write outcome). */
  private notice = ''
  private noticeIsError = false
  /** The single Details reader offset; one reading, one scroll. */
  private detailsScroll = 0
  private readerLines: string[] = []
  private detailsDocument: Markdown | undefined
  private rowGrant = Number.POSITIVE_INFINITY
  private _focused = false
  /** Semantic changes revoke every outstanding pointer gesture. A pure repaint
   *  keeps the generation stable, so press→release on unchanged geometry is a
   *  valid one-click action. */
  private gestureGeneration = 0
  /** Set by a row PRESS that moved the highlight: its release may only browse
   *  (the first click selects, the second click on the same row activates). */
  private suppressSelect = false
  private pressed: PresetPress | undefined
  private lastFrame: PresetFrame | undefined
  /** The palette the currently baked row strings were painted with. */
  private palette = currentPalette
  private disposed = false

  constructor(deps: PresetPickerPanelDeps) {
    this.deps = deps
    // The panel mounts IMMEDIATELY in its loading state: the command opens it
    // before the roster read and hydrates the same instance in place.
    this.picker = new SearchablePicker([], Number.POSITIVE_INFINITY, selectListTheme, {}, {
      enableSearch: true,
      externalHint: true,
      header: 'Agent presets',
      noMatchText: '  Loading agent presets…',
      descriptionMode: 'selected-below',
      badgeLayout: 'wrap-when-needed',
    })
    this.picker.onSelect = (item) => { this.onPickerSelect(item) }
    this.picker.onCancel = () => { this.deps.close() }
    this.picker.onSelectionChange = () => {
      this.invalidateGestures()
      this.syncSelection()
      this.deps.requestRender()
    }
  }

  /** Whether this panel has been torn down (the command's late-load fence). */
  isDisposed(): boolean {
    return this.disposed
  }

  /** Ownership-safe external teardown: the overlay slot owns the close path;
   *  this only fences late reads/settlements from touching a dead surface. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.invalidateGestures()
    this.lastFrame = undefined
    this.readerLines = []
    this.detailsDocument = undefined
  }

  get focused(): boolean {
    return this._focused
  }

  set focused(value: boolean) {
    // A focus transition is NOT a semantic change here: the app pairs a blur
    // and a focus around the SAME pointer press (the press that first focuses
    // the overlay), so revoking the just-armed gesture would make one-click
    // activation impossible. Every real revocation (keyboard input, selection,
    // query, page/phase change, resize, roster refresh, disposal) bumps the
    // generation explicitly.
    this._focused = value
    this.picker.focused = value
  }

  /** Host row-budget seam: the picker absorbs the remainder after the ONE
   *  status row and the ONE action bar. */
  setMaxRows(rows: number): void {
    const next = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : Number.POSITIVE_INFINITY
    if (next !== this.rowGrant) this.invalidateGestures()
    this.rowGrant = next
  }

  /** Enter (or re-enter) the loading presentation. The first load owns an empty
   *  body; a Retry keeps the previous roster as read-only facts and states the
   *  running read in the status row instead. */
  setLoading(): void {
    if (!this.ensureCurrent()) return
    this.invalidateGestures()
    this.phase = 'loading'
    this.pendingKind = undefined
    this.notice = ''
    this.noticeIsError = false
    this.page = 'catalog'
    this.zone = 'list'
    if (this.roster === undefined) {
      this.picker.setItems([])
      this.picker.setNoMatchText('  Loading agent presets…')
    }
    this.deps.requestRender()
  }

  /** Adopt one authoritative roster read IN PLACE (never a second overlay). */
  setRoster(input: PresetPickerRoster): void {
    if (!this.ensureCurrent()) return
    this.invalidateGestures()
    this.roster = input
    const rows = this.projectRows(input)
    this.rows = new Map(rows.map(row => [row.id, row]))
    this.phase = 'ready'
    this.pendingKind = undefined
    this.notice = ''
    this.noticeIsError = false
    this.picker.setNoMatchText(rows.length === 0 ? '  No agent presets configured.' : '  No matching presets')
    // Seed the browse target from the REAL committed facts, then the first
    // roster row — never a fabricated "selected" flag.
    const seed = this.selectedId ?? input.currentId ?? input.pendingId ?? input.defaultId ?? rows[0]?.id
    this.selectedId = seed
    this.picker.setItems(this.buildItems())
    if (seed !== undefined) this.picker.setSelectedValue(seed)
    this.syncSelection()
    // The Details page describes ONE preset: if the new read no longer carries
    // it, fall back to the catalogue (query and target stay).
    if (this.page === 'details' && !this.rows.has(this.selectedId ?? '')) {
      this.page = 'catalog'
      this.zone = 'list'
    }
    this.rebuildReader()
    this.deps.requestRender()
  }

  /** An in-panel read failure: the exact message stays readable, the failed
   *  response NEVER becomes an empty roster, and no retry runs by itself. */
  setLoadError(message: string): void {
    if (!this.ensureCurrent()) return
    this.invalidateGestures()
    this.phase = 'error'
    this.pendingKind = undefined
    this.page = 'catalog'
    this.zone = 'list'
    const detail = sanitizedPhysicalLine(message)
    this.notice = detail
    this.noticeIsError = true
    if (this.roster === undefined) {
      // First load failed: the empty body names the failure, and the COMPLETE
      // reason is painted (wrapped) in the status rows above the bar — a
      // single truncated body cell is not a readable error.
      this.picker.setItems([])
      this.picker.setNoMatchText(`  ${color.error('Preset catalog unavailable')}`)
    }
    this.deps.requestRender()
  }

  /* ------------------------------------------------------------ projection */

  private projectRows(input: PresetPickerRoster): PresetRowView[] {
    const rows = input.roster.presets.map((preset): PresetRowView => {
      const display = presetDisplayText(preset)
      return {
        id: preset.id,
        name: display.name,
        description: display.description,
        builtIn: isBuiltInPresetRow(preset),
        broken: preset.broken,
      }
    })
    return [...rows.filter(row => row.builtIn), ...rows.filter(row => !row.builtIn)]
  }

  /** The live Session's preset: `Current` is never fabricated without one. */
  private currentId(): string | undefined {
    return this.deps.request.subject.sessionless ? undefined : this.roster?.currentId
  }

  /** The run-local pending preset: a live panel never invents `Next session`. */
  private pendingId(): string | undefined {
    return this.deps.request.subject.sessionless ? this.roster?.pendingId : undefined
  }

  private defaultId(): string | undefined {
    return this.roster?.defaultId
  }

  private committed(id: string): boolean {
    return id === this.currentId() || id === this.pendingId() || id === this.defaultId()
  }

  /** One row's short factual detail, painted under the SELECTED row only. */
  private rowDetail(row: PresetRowView): string {
    const kind = row.builtIn ? BUILT_IN_GROUP_LABEL : CUSTOM_GROUP_LABEL
    const published = row.description === undefined || row.description.trim() === ''
      ? 'No description.'
      : sanitizedPhysicalLine(row.description)
    return row.broken === undefined
      ? `${kind} · ${published}`
      : `${kind} · Failed to load: ${sanitizedPhysicalLine(row.broken)}`
  }

  /** One row's atomic state chips. Each part is pre-painted `textMuted` (the
   *  problem state `warning`) so selection never recolours it. */
  private badgePartsOf(row: PresetRowView): SearchablePickerBadgePart[] | undefined {
    const parts: SearchablePickerBadgePart[] = []
    if (row.id === this.currentId()) parts.push({ kind: 'chip', text: color.textMuted('[current]') })
    if (row.id === this.pendingId()) parts.push({ kind: 'chip', text: color.textMuted('[next session]') })
    if (row.id === this.defaultId()) parts.push({ kind: 'chip', text: color.textMuted('[default]') })
    if (row.id === this.selectedId && !this.committed(row.id)) parts.push({ kind: 'chip', text: color.textMuted('[draft]') })
    if (row.broken !== undefined) parts.push({ kind: 'chip', text: color.warning('[unavailable]') })
    return parts.length === 0 ? undefined : parts
  }

  private buildItems(): SearchablePickerItem[] {
    return [...this.rows.values()].map((row): SearchablePickerItem => {
      const name = sanitizedPhysicalLine(row.name)
      const id = sanitizedPhysicalLine(row.id)
      const badgeParts = this.badgePartsOf(row)
      const badge = badgeParts === undefined ? undefined : joinBadgeParts(badgeParts)
      return {
        value: row.id,
        // The complete identity is drawn (`Name (id)`); the renderer's cell
        // truncation is a DRAWING fact only — the raw id is the action identity
        // and the search basis below always carries the complete fields.
        label: name === id ? id : `${name} (${id})`,
        description: this.rowDetail(row),
        group: row.builtIn ? BUILT_IN_GROUP_LABEL : CUSTOM_GROUP_LABEL,
        groupKey: row.builtIn ? BUILT_IN_GROUP_KEY : CUSTOM_GROUP_KEY,
        ...(badge === undefined ? {} : { badge }),
        ...(badgeParts === undefined ? {} : { badgeParts }),
        // Complete `name id description` — never a truncated label.
        searchText: `${row.name} ${row.id} ${row.description ?? ''}`,
      }
    })
  }

  /** Keep the panel's browse target equal to the picker's live selection (the
   *  list fact). Rebuilding the rows refreshes the `[draft]` chip without ever
   *  changing the selection itself. */
  private syncSelection(): void {
    const next = this.picker.getSelectedItem()?.value
    if (next === this.selectedId) return
    this.selectedId = next
    if (this.phase === 'ready') this.picker.setItems(this.buildItems())
  }

  private selectedRowView(): PresetRowView | undefined {
    // The SELECTION is a list fact (the filtered visible row), never the last
    // pointer hit map: the status, availability and bar are derived BEFORE the
    // picker paints this frame, and a filtered row is what the user acts on.
    const item = this.picker.getSelectedItem()
    return item === null ? undefined : this.rows.get(item.value)
  }

  /* ------------------------------------------------------------ admission */

  private ensureCurrent(): boolean {
    if (this.disposed) return false
    if (this.deps.request.isCurrent()) return true
    // The captured subject/token moved: this panel owns nothing any more.
    this.deps.close()
    return false
  }

  private invalidateGestures(): void {
    this.gestureGeneration += 1
    this.pressed = undefined
    this.suppressSelect = false
    this.picker.clearMousePress()
  }

  /** The ONE availability decision: painted and admitted from this result. */
  private writeAvailability(): { use?: string; setDefault?: string } {
    const row = this.selectedRowView()
    if (row === undefined) return { use: 'No preset selected', setDefault: 'No preset selected' }
    if (row.broken !== undefined) return { use: 'Preset failed to load', setDefault: 'Preset failed to load' }
    const defaultId = this.defaultId()
    return {
      setDefault: this.roster?.canSetDefault !== true
        ? 'Settings unavailable'
        : row.id === defaultId
          ? 'Already the default'
          : undefined,
    }
  }

  /** The operations of the CURRENT page/phase (unfocused), in bar order. */
  private baseActions(): Array<BarSegment & { readonly label: string; readonly shortLabel: string }> {
    const close = (): BarSegment & { readonly label: string; readonly shortLabel: string } => ({
      text: 'Close [Esc]',
      priority: 1000,
      id: 'close',
      enabled: true,
      label: 'Close',
      shortLabel: 'Close',
    })
    if (this.phase === 'loading' || this.phase === 'pending') return [close()]
    if (this.page === 'details') return []
    if (this.phase === 'error') {
      return [
        {
          text: 'Retry',
          priority: 10,
          id: 'retry',
          enabled: true,
          label: 'Retry',
          shortLabel: 'Retry',
        },
        close(),
      ]
    }
    const availability = this.writeAvailability()
    const action = (
      id: 'use' | 'set-default',
      label: string,
      short: string,
      reason: string | undefined,
      priority: number,
    ): BarSegment & { readonly label: string; readonly shortLabel: string } => ({
      text: label,
      short,
      priority,
      id,
      enabled: reason === undefined,
      label,
      shortLabel: short,
    })
    return [
      action('use', this.deps.request.subject.sessionless ? 'Use next' : 'Use session', 'Use', availability.use, 30),
      action('set-default', 'Set default', 'Default', availability.setDefault, 20),
      close(),
    ]
  }

  /** The CURRENTLY enabled actions the last bar layout can really paint: an
   *  action the layout dropped at this width is not a keyboard target (the same
   *  rule pointer hits already follow). Availability itself is re-derived from
   *  the current state, never from a paint-time snapshot. */
  private paintedRing(): PresetActionId[] {
    const frame = this.lastFrame
    const base = this.baseActions()
    // A Details frame carries no bar: the next Catalog bar will be laid out at
    // the same width, so derive the fitting set from the CURRENT actions
    // instead of treating every action as absent.
    const fitting = frame === undefined
      ? undefined
      : frame.barRow >= 0
        ? frame.fittingActions
        : layoutActionBarRow(base, Math.max(0, Math.floor(frame.width) - 2)).spans
          .map(span => base[span.inputIndex]!.id)
    return base
      .filter(segment => segment.enabled && (fitting === undefined || fitting.includes(segment.id)))
      .map(segment => segment.id)
  }

  /** The ONE enabled action of the ring, wrapping in `delta`'s direction. */
  private stepActionFocus(delta: -1 | 1): void {
    const ring = this.paintedRing()
    if (ring.length === 0) return
    const at = ring.findIndex(id => id === this.focusedActionId(ring))
    this.actionFocus = ring[(Math.max(at, 0) + delta + ring.length) % ring.length]
    this.deps.requestRender()
  }

  /** The ONE painted enabled action the actions zone currently owns Enter for.
   *  A disabled or dropped action owns no Enter, so the fallback never parks
   *  the keyboard on a dead entry. */
  private focusedActionId(ring: readonly PresetActionId[] = this.paintedRing()): PresetActionId | undefined {
    return ring.find(id => id === this.actionFocus) ?? ring[0]
  }

  /** The bar operations with the `Verb [Enter]` cue on the ONE focus the
   *  actions zone currently owns. Close already spells its real Esc device; a
   *  focused Close names the Enter that now runs it (one action advertises
   *  ONE key). */
  private buildActions(focus: PresetActionId | undefined): BarSegment[] {
    return this.baseActions().map((segment): BarSegment => {
      if (segment.id !== focus || !segment.enabled) return segment
      const text = segment.id === 'close' ? 'Close [Enter]' : `${segment.label} [Enter]`
      const short = segment.id === 'close' ? undefined : `${segment.shortLabel} [Enter]`
      return { ...segment, text, ...(short === undefined ? {} : { short }) }
    })
  }

  /* --------------------------------------------------------------- writers */

  private dispatchAction(id: PresetActionId): void {
    if (this.disposed) return
    if (id !== 'close' && !this.paintedRing().includes(id)) return
    if (id === 'close') {
      this.deps.close()
      return
    }
    if (id === 'retry') {
      if (this.phase === 'error') this.retry()
      return
    }
    if (this.page !== 'catalog' || this.phase !== 'ready') return
    if (!this.ensureCurrent()) return
    const row = this.selectedRowView()
    if (row === undefined || row.broken !== undefined) return
    const availability = this.writeAvailability()
    if (id === 'use' && availability.use === undefined) this.applySelection(row)
    if (id === 'set-default' && availability.setDefault === undefined) this.saveDefault(row)
  }

  /** Re-enter loading through the command's ONE read owner. The frame is
   *  committed BEFORE the re-entrant retry callback runs. */
  private retry(): void {
    if (this.phase !== 'error') return
    this.invalidateGestures()
    this.phase = 'loading'
    this.notice = ''
    this.noticeIsError = false
    this.zone = 'list'
    if (this.roster === undefined) {
      this.picker.setItems([])
      this.picker.setNoMatchText('  Loading agent presets…')
    }
    this.deps.requestRender()
    this.deps.request.retry()
  }

  /** Commit the browse target through the ORIGINAL session-preset write. */
  private applySelection(row: PresetRowView): void {
    this.notice = ''
    this.noticeIsError = false
    this.phase = 'pending'
    this.pendingKind = 'use'
    this.zone = 'actions'
    this.actionFocus = 'use'
    this.invalidateGestures()
    this.deps.requestRender()
    const request = this.deps.request
    request.runOwned('preset selection', () => request.isCurrent()
      ? request.apply(row.id)
      : Promise.resolve<PresetApplyOutcome>({ kind: 'superseded' }), {
      isCancellation: () => this.disposed,
      onResult: (outcome) => {
        if (this.disposed) return
        // A superseded operation owns nothing: no frame, no close decision.
        if (outcome.kind === 'superseded') return
        // A staged/committed switch and a true indeterminate all dismiss the
        // panel: the authoritative display reconciles from the Host, and the
        // command has already notified the outcome.
        if (outcome.kind === 'pending' || outcome.kind === 'switched' || outcome.kind === 'indeterminate') {
          this.deps.close()
          return
        }
        this.restoreAfterRefusal(
          outcome.kind === 'locked'
            ? 'Locked: this session has already started.'
            : outcome.message,
        )
      },
      onError: (error) => {
        if (this.disposed) return
        this.restoreAfterRefusal(`Preset selection failed: ${safeErrorMessage(error)}`)
      },
    })
  }

  /** Commit a new-session default through the ORIGINAL config writer. */
  private saveDefault(row: PresetRowView): void {
    this.notice = ''
    this.noticeIsError = false
    this.phase = 'pending'
    this.pendingKind = 'default'
    this.zone = 'actions'
    this.actionFocus = 'set-default'
    this.invalidateGestures()
    this.deps.requestRender()
    const request = this.deps.request
    request.runOwned('preset default', () => request.isCurrent()
      ? request.setDefault(row.id)
      : Promise.resolve<PresetDefaultOutcome>({ kind: 'superseded' }), {
      isCancellation: () => this.disposed,
      onResult: (outcome) => {
        if (this.disposed) return
        if (outcome.kind === 'superseded') return
        // `saved` and `unconfirmed` both dismiss: a raising settings mutation
        // proves neither commit nor rollback, so the next read is authoritative.
        this.deps.close()
      },
      onError: (error) => {
        if (this.disposed) return
        this.restoreAfterRefusal(`Default preset save failed: ${safeErrorMessage(error)}`)
      },
    })
  }

  /** Restore the READY catalogue after a KNOWN refusal, keeping the target and
   *  stating the reason in the status row. Never an automatic retry. */
  private restoreAfterRefusal(notice: string): void {
    this.phase = 'ready'
    this.pendingKind = undefined
    this.page = 'catalog'
    this.zone = 'list'
    this.notice = notice
    this.noticeIsError = true
    this.invalidateGestures()
    this.deps.requestRender()
  }

  /* ---------------------------------------------------------- details page */

  /** Enter the strictly read-only Details page for the PAINTED selection. */
  private openDetails(id?: string): void {
    if (this.disposed || this.phase !== 'ready' || this.page !== 'catalog') return
    if (!this.ensureCurrent()) return
    const item = this.picker.getSelectedItem()
    if (item === null) return
    if (id !== undefined && item.value !== id) return
    const row = this.rows.get(item.value)
    if (row === undefined) return
    this.selectedId = row.id
    this.page = 'details'
    this.zone = 'list'
    this.detailsScroll = 0
    this.rebuildReader()
    this.invalidateGestures()
    this.deps.requestRender()
  }

  private backToCatalog(): void {
    if (this.page !== 'details') return
    this.page = 'catalog'
    this.zone = 'list'
    // The query, selection and list window are the SAME list state: nothing to
    // restore, the picker was never unmounted.
    this.invalidateGestures()
    this.deps.requestRender()
  }

  /** Rebuild the ONE Details Markdown document from the current read. Called
   *  on entry, on a hydrate while open, and (via {@link syncPalette}) after a
   *  palette change. */
  private rebuildReader(): void {
    this.readerLines = []
    this.detailsDocument = undefined
    if (this.page !== 'details') return
    const row = this.rows.get(this.selectedId ?? '')
    if (row === undefined) return
    this.detailsDocument = new Markdown(this.detailsBody(row), 0, 0, markdownTheme, undefined, HOST_MARKDOWN_OPTIONS)
  }

  /** The complete read-only details body as ONE Markdown source. Identity
   *  values keep their hard line breaks; the shipped guide is appended in the
   *  SAME body, and a Custom row never borrows it. */
  private detailsBody(row: PresetRowView): string {
    const lines: string[] = []
    const fact = (label: string, value: string): void => {
      lines.push(`**${label}**  ${sanitizeDisplayText(value)}  `)
    }
    fact('Name', row.name)
    fact('ID', row.id)
    fact('Type', row.builtIn ? 'Built-in' : 'Custom')
    fact('Scope', this.deps.request.subject.sessionless
      ? 'Use: next session only · Default: future new sessions'
      : 'Use: current blank session · Default: future new sessions')
    if (row.id === this.currentId()) fact('Current session', row.id)
    if (row.id === this.pendingId()) fact('Next session', row.id)
    if (row.id === this.defaultId()) fact('New-session default', row.id)
    if (row.broken !== undefined) fact('Failed to load', row.broken)
    lines.push('', '## Description', '')
    const description = row.description?.trim() ?? ''
    lines.push(description === '' ? 'No description provided.' : sanitizeDisplayText(row.description!))
    const guide = builtInGuide({ id: row.id, builtIn: row.builtIn })
    if (guide !== undefined) lines.push('', sanitizeDisplayText(guide))
    // The vendored Markdown renderer supports `#`/`##` only. The official guide
    // (and any user description) may carry `###` sub-headings: project every
    // deeper level to a bold line so no literal `###` marker is ever painted.
    return lines.join('\n').replace(/^#{3,6}\s+(.+)$/gm, '**$1**')
  }

  /* --------------------------------------------------------------- input */

  private isListNavigation(data: string): boolean {
    const kb = getKeybindings()
    return kb.matches(data, 'tui.select.up')
      || kb.matches(data, 'tui.select.down')
      || kb.matches(data, 'tui.select.pageUp')
      || kb.matches(data, 'tui.select.pageDown')
  }

  handleInput(data: string): void {
    if (this.disposed) return
    if (!this.ensureCurrent()) return
    // Every keyboard input revokes an outstanding pointer gesture.
    this.invalidateGestures()
    if (this.page === 'details') {
      this.handleDetailsInput(data)
      return
    }
    if (matchesKey(data, 'escape')) {
      // The ONE Esc ladder: an admitted write closes; otherwise clear a
      // non-empty query before closing the overlay.
      if (this.phase === 'pending') {
        this.deps.close()
        return
      }
      if (this.picker.getFilter() !== '') {
        const keep = this.picker.getSelectedItem()?.value
        this.picker.setFilter('')
        if (keep !== undefined) this.picker.setSelectedValue(keep)
        this.syncSelection()
        this.deps.requestRender()
        return
      }
      this.deps.close()
      return
    }
    if (this.phase === 'pending') return
    if (this.phase === 'loading') {
      // A running (re-)read admits the search box only; no browse, no write.
      if (this.isListNavigation(data) || matchesKey(data, 'enter') || matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) return
      this.forwardSearchInput(data)
      return
    }
    if (this.phase === 'error') {
      if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
        this.zone = this.zone === 'list' ? 'actions' : 'list'
        this.deps.requestRender()
        return
      }
      if (this.zone === 'actions') {
        if (matchesKey(data, 'left') || matchesKey(data, 'up')) return this.stepActionFocus(-1)
        if (matchesKey(data, 'right') || matchesKey(data, 'down')) return this.stepActionFocus(1)
        if (matchesKey(data, 'enter')) {
          const id = this.focusedActionId()
          if (id !== undefined) this.dispatchAction(id)
          return
        }
        // A failed read has no browsable list: the search box stays editable
        // from the footer zone too (the Esc ladder needs it in every phase).
        this.forwardSearchInput(data)
        return
      }
      // A failed read owns no browsable list: only the search box stays live.
      if (this.isListNavigation(data) || matchesKey(data, 'enter')) return
      this.forwardSearchInput(data)
      return
    }
    // Ready catalogue.
    if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
      this.zone = this.zone === 'list' ? 'actions' : 'list'
      this.deps.requestRender()
      return
    }
    if (this.zone === 'actions') {
      if (matchesKey(data, 'left') || matchesKey(data, 'up')) return this.stepActionFocus(-1)
      if (matchesKey(data, 'right') || matchesKey(data, 'down')) return this.stepActionFocus(1)
      if (matchesKey(data, 'enter')) {
        const id = this.focusedActionId()
        if (id !== undefined) this.dispatchAction(id)
      }
      // The actions zone owns the keyboard: every other key is consumed (Tab
      // returns to the list, where typing edits the search).
      return
    }
    if (matchesKey(data, 'enter')) {
      // Enter on the highlighted row opens Details — it NEVER writes.
      this.openDetails()
      return
    }
    this.forwardSearchInput(data)
  }

  /** Delegate one key to the catalog's search/list, keeping the browse target
   *  on its row while the new query still shows it (the picker's own filter
   *  resets to the first visible row; the panel restores the identity). */
  private forwardSearchInput(data: string): void {
    const filterBefore = this.picker.getFilter()
    const selectedBefore = this.picker.getSelectedItem()?.value
    this.picker.handleInput(data)
    if (this.picker.getFilter() !== filterBefore && selectedBefore !== undefined) {
      this.picker.setSelectedValue(selectedBefore)
    }
    this.syncSelection()
    this.deps.requestRender()
  }

  private handleDetailsInput(data: string): void {
    // The Details page paints ONE way back (`Back [Esc]`); Enter is not an
    // advertised action there.
    if (matchesKey(data, 'escape')) {
      this.backToCatalog()
      return
    }
    const pageRows = Math.max(1, (this.lastFrame?.readerRows ?? 1) - 1)
    const maxScroll = Math.max(0, (this.lastFrame?.readerLineCount ?? 0) - Math.max(1, this.lastFrame?.readerRows ?? 1))
    let next: number | undefined
    if (matchesKey(data, Key.up)) next = this.detailsScroll - 1
    else if (matchesKey(data, Key.down)) next = this.detailsScroll + 1
    else if (matchesKey(data, Key.pageUp)) next = this.detailsScroll - pageRows
    else if (matchesKey(data, Key.pageDown)) next = this.detailsScroll + pageRows
    else if (matchesKey(data, Key.home)) next = 0
    else if (matchesKey(data, Key.end)) next = maxScroll
    if (next === undefined) return
    this.detailsScroll = Math.max(0, Math.min(next, maxScroll))
    this.deps.requestRender()
  }

  /* --------------------------------------------------------------- mouse */

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    if (!this.ensureCurrent()) return undefined
    const frame = this.lastFrame
    if (frame === undefined || event.width !== frame.width) return undefined
    // ANY real wheel on the surface revokes an outstanding pointer gesture
    // (footer/back press, browse press), wherever it lands: list chrome, the
    // status row, the bar itself or the reader. A wheel that moved the content
    // must never let a later release run a previously pressed action.
    if (event.type === 'wheel' && (event.wheelDelta ?? 0) !== 0) this.invalidateGestures()
    const pressed = this.pressed
    if (event.type === 'click' || (event.type === 'press' && event.button === 'left')) this.pressed = undefined

    if (this.page === 'details') {
      if (event.y === frame.backRow) {
        if (event.type === 'wheel') {
          this.scrollReader(event.wheelDelta ?? 0)
          return { handled: true, render: true }
        }
        const back = frame.backHit
        if (back === undefined || event.x < back.start || event.x >= back.end) {
          // The row carries only its complete painted Back span; nothing else
          // on the last physical row is a pointer target.
          return { handled: true }
        }
        if (event.type === 'press') {
          if (event.button !== 'left') return { handled: true }
          this.pressed = {
            kind: 'back',
            row: event.y,
            width: event.width,
            height: event.height,
            originX: event.screenX - event.x,
            originY: event.screenY - event.y,
            pageMarker: frame.pageMarker,
            selectionMarker: frame.selectionMarker,
            generation: frame.generation,
          }
          return { handled: true, focus: !this.focused }
        }
        if (event.type === 'release') return { handled: true }
        if (event.type !== 'click' || event.button !== 'left') return { handled: true }
        if (pressed?.kind !== 'back'
          || pressed.row !== event.y
          || pressed.width !== event.width
          || pressed.height !== event.height
          || pressed.originX !== event.screenX - event.x
          || pressed.originY !== event.screenY - event.y
          || pressed.pageMarker !== this.pageMarker()
          || pressed.selectionMarker !== this.selectionMarker()
          || pressed.generation !== this.gestureGeneration
          || pressed.generation !== frame.generation) {
          return { handled: true }
        }
        this.backToCatalog()
        return { handled: true }
      }
      // One read-only reader: a wheel ANYWHERE on the page scrolls it; the
      // bar-less page has no other pointer target.
      if (event.type === 'wheel') {
        this.scrollReader(event.wheelDelta ?? 0)
        return { handled: true, render: true }
      }
      return { handled: true }
    }

    if (event.y === frame.barRow) {
      if (event.type === 'wheel') return { handled: true }
      const hit = frame.barHits.find(candidate => event.x >= candidate.start && event.x < candidate.end)
      if (event.type === 'press') {
        if (event.button !== 'left' || hit === undefined) return { handled: true }
        this.pressed = {
          kind: 'bar',
          id: hit.id,
          row: event.y,
          start: hit.start,
          end: hit.end,
          width: event.width,
          height: event.height,
          originX: event.screenX - event.x,
          originY: event.screenY - event.y,
          pageMarker: frame.pageMarker,
          selectionMarker: frame.selectionMarker,
          generation: frame.generation,
        }
        return { handled: true, focus: !this.focused }
      }
      if (event.type === 'release') return { handled: true }
      if (event.type !== 'click' || event.button !== 'left' || hit === undefined) return { handled: true }
      // The release must name the SAME action, its exact painted span, the
      // same page/selection and the same gesture generation: a resize, refresh,
      // navigation or replacement between press and release commits nothing.
      if (pressed?.kind !== 'bar'
        || pressed.id !== hit.id
        || pressed.row !== event.y
        || pressed.start !== hit.start
        || pressed.end !== hit.end
        || pressed.width !== event.width
        || pressed.height !== event.height
        || pressed.originX !== event.screenX - event.x
        || pressed.originY !== event.screenY - event.y
        || pressed.pageMarker !== this.pageMarker()
        || pressed.selectionMarker !== this.selectionMarker()
        || pressed.generation !== this.gestureGeneration
        || pressed.generation !== frame.generation) {
        return { handled: true }
      }
      this.dispatchAction(hit.id)
      return { handled: true }
    }

    // Only the painted list-body rows are the picker's own identity-fenced
    // router: the status row and every cell below the painted body are inert,
    // and a one-row grant paints the exit bar alone (no older row hit may be
    // replayed against it).
    if (event.y >= frame.listRows) return { handled: true }

    // The list/search rows are the picker's own identity-fenced router. A row
    // PRESS that MOVES the highlight only browses: its release can never open
    // Details, so the first click can never look like an activation.
    if (event.type === 'press' && event.button === 'left') this.suppressSelect = false
    const before = this.picker.getSelectedItem()?.value
    const result = this.picker.handleMouse?.(event)
    if (event.type === 'press' && event.button === 'left') {
      this.suppressSelect = before !== this.picker.getSelectedItem()?.value
    }
    // A capturing overlay consumes every event inside its painted body: an
    // inert row (header/group/spacer/search detail) must never scroll or click
    // the transcript behind the modal.
    return result ?? { handled: true }
  }

  /** The picker's `onSelect` (pointer activation only — keyboard Enter is
   *  admitted by {@link handleInput} directly). A browse-only press consumes
   *  the release without opening the page. */
  private onPickerSelect(item: SearchablePickerItem): void {
    if (this.disposed) return
    if (this.suppressSelect) {
      this.suppressSelect = false
      this.syncSelection()
      this.deps.requestRender()
      return
    }
    this.openDetails(item.value)
  }

  private scrollReader(delta: number): void {
    if (delta === 0) return
    // Scrolling is a semantic change for the pointer: an outstanding Back press
    // must not survive a wheel that moved the reading.
    this.invalidateGestures()
    const maxScroll = Math.max(0, (this.lastFrame?.readerLineCount ?? 0) - Math.max(1, this.lastFrame?.readerRows ?? 1))
    const step = delta < 0 ? -1 : 1
    this.detailsScroll = Math.max(0, Math.min(this.detailsScroll + step, maxScroll))
    this.deps.requestRender()
  }

  /* --------------------------------------------------------------- paint */

  invalidate(): void {
    this.picker.invalidate()
    this.detailsDocument?.invalidate()
  }

  /** The live-palette check: rows bake their chip ink at build time, so a
   *  palette switch must rebuild them through the CURRENT `color.*`, and the
   *  Details Markdown must drop its cached ANSI lines. */
  private syncPalette(): void {
    if (this.palette === currentPalette) return
    this.palette = currentPalette
    if (this.rows.size > 0) this.picker.setItems(this.buildItems())
    this.detailsDocument?.invalidate()
  }

  private pageMarker(): string {
    return `${this.page}:${this.phase}:${String(this.pendingKind)}`
  }

  private selectionMarker(): string {
    return `${this.selectedId ?? ''}:${this.zone}:${String(this.actionFocus)}`
  }

  render(width: number): string[] {
    if (this.disposed) return []
    this.syncPalette()
    const budget = Number.isFinite(this.rowGrant) ? Math.max(1, Math.floor(this.rowGrant)) : Number.POSITIVE_INFINITY
    if (this.page === 'details') return this.renderDetails(width, budget)
    return this.renderCatalog(width, budget)
  }

  private renderCatalog(width: number, budget: number): string[] {
    const bar = this.renderBar(width)
    // A one-row grant is the real exit bar ALONE: no list row may be painted,
    // and the frame's previous row hit map stops being a pointer target.
    if (budget === 1) {
      this.lastFrame = {
        width,
        barRow: 0,
        backRow: -1,
        backHit: undefined,
        readerLineCount: 0,
        readerRows: 0,
        listRows: 0,
        barHits: bar.hits,
        fittingActions: bar.fitted,
        paintedActions: bar.painted,
        pageMarker: this.pageMarker(),
        selectionMarker: this.selectionMarker(),
        generation: this.gestureGeneration,
      }
      return [bar.line]
    }
    const status = this.catalogStatus()
    // The status area is ONE compacts line for a hint, but a READ failure keeps
    // its COMPLETE reason: it wraps into as many rows as the grant can spare
    // (always leaving the real exit bar and at least one list row).
    const statusText = status === undefined ? [] : wrapTextWithAnsi(`  ${sanitizedPhysicalLine(status.text)}`, width)
    const statusLimit = budget === Number.POSITIVE_INFINITY ? statusText.length : Math.max(0, budget - 2)
    const statusLines = status === undefined || statusLimit === 0
      ? []
      : (status.error ? statusText.slice(0, statusLimit) : statusText.slice(0, 1)).map(line => this.paintStatusLine(line, status.error))
    const listRows = budget === Number.POSITIVE_INFINITY
      ? Number.POSITIVE_INFINITY
      : Math.max(1, budget - 1 - statusLines.length)
    this.picker.setMaxRows(listRows)
    const list = this.picker.render(width)
    const lines = [...list, ...statusLines]
    lines.push(bar.line)
    this.lastFrame = {
      width,
      barRow: lines.length - 1,
      backRow: -1,
      backHit: undefined,
      readerLineCount: 0,
      readerRows: 0,
      listRows: list.length,
      barHits: bar.hits,
      fittingActions: bar.fitted,
      paintedActions: bar.painted,
      pageMarker: this.pageMarker(),
      selectionMarker: this.selectionMarker(),
      generation: this.gestureGeneration,
    }
    return lines
  }

  /** The ONE body/status statement above the bar. It carries the real disabled
   *  reason (PiTui paints no tooltip), the running-read placeholder or the last
   *  write outcome. The empty body's own statement stays in the list. */
  private catalogStatus(): { text: string; error: boolean } | undefined {
    if (this.phase === 'pending') {
      return { text: this.pendingKind === 'default' ? 'Saving default…' : 'Applying preset…', error: false }
    }
    if (this.phase === 'loading') {
      return this.roster === undefined ? undefined : { text: 'Loading agent presets…', error: false }
    }
    if (this.phase === 'error') {
      return { text: this.notice === '' ? 'Preset catalog unavailable' : this.notice, error: true }
    }
    if (this.notice !== '') return { text: this.notice, error: this.noticeIsError }
    const availability = this.writeAvailability()
    const reason = availability.use ?? availability.setDefault
    return reason === undefined ? undefined : { text: reason, error: false }
  }

  private paintStatusLine(line: string, error: boolean): string {
    return error ? color.error(line) : color.textDim(line)
  }

  private renderBar(width: number): { line: string; hits: readonly BarHit[]; fitted: readonly PresetActionId[]; painted: readonly PresetActionId[] } {
    const contentWidth = Math.max(0, Math.floor(width) - 2)
    const base = this.baseActions()
    const baseLayout = layoutActionBarRow(base, contentWidth)
    const baseFitting = baseLayout.truncated
      ? []
      : baseLayout.spans.map(span => base[span.inputIndex]!.id)
    const enabledFitting = (fitting: readonly PresetActionId[]): PresetActionId[] =>
      base.filter(segment => segment.enabled && fitting.includes(segment.id)).map(segment => segment.id)
    // Choose the focus among the actions the CURRENT layout really paints: a
    // segment dropped at this width is not an Enter target, and a focus cue
    // that would itself push its action out falls back to the first painted
    // enabled entry.
    let focus = this.zone === 'actions' ? this.focusedActionId(enabledFitting(baseFitting)) : undefined
    for (;;) {
      const segments = this.buildActions(focus)
      const layout = layoutActionBarRow(segments, contentWidth)
      if (layout.truncated || layout.spans.length === 0) {
        return { line: truncateToWidth(`  ${color.textMuted(layout.text)}`, width, ''), hits: [], fitted: [], painted: [] }
      }
      const hits: BarHit[] = []
      const fitted: PresetActionId[] = []
      const painted: PresetActionId[] = []
      const line = layout.spans.map((span) => {
        const segment = segments[span.inputIndex]!
        fitted.push(segment.id)
        if (segment.enabled) {
          hits.push({ id: segment.id, start: span.startCol + 2, end: span.endCol + 2 })
          painted.push(segment.id)
        }
        return segment.enabled ? color.primary(span.text) : color.textDim(span.text)
      }).join(color.textMuted(ACTION_BAR_SEPARATOR))
      if (focus === undefined) {
        return { line: truncateToWidth(`  ${line}`, width, ''), hits, fitted, painted }
      }
      const ring = enabledFitting(fitted)
      if (ring.includes(focus)) {
        return { line: truncateToWidth(`  ${line}`, width, ''), hits, fitted, painted }
      }
      if (ring.length === 0) {
        return { line: truncateToWidth(`  ${line}`, width, ''), hits, fitted, painted }
      }
      // The focused action was dropped by the cue layout: repaint with the
      // first action this layout really offers.
      focus = ring[0]!
      this.actionFocus = focus
    }
  }

  private renderDetails(width: number, budget: number): string[] {
    const row = this.rows.get(this.selectedId ?? '')
    if (row === undefined) return []
    const title = this.renderDetailsTitle(width, row)
    const back = this.renderBack(width)
    const lines: string[] = []
    let readerRows = 0
    if (budget <= 1) {
      lines.push(back.line)
    } else if (budget === 2) {
      // Identity + the real way back; the reader yields whole.
      lines.push(title, back.line)
    } else {
      readerRows = budget - 2
      lines.push(title)
      lines.push(...this.renderReader(width, readerRows))
      lines.push(back.line)
    }
    this.lastFrame = {
      width,
      barRow: -1,
      backRow: lines.length - 1,
      backHit: back.complete ? { start: 2, end: 2 + visibleWidth('Back [Esc]') } : undefined,
      readerLineCount: readerRows > 0 ? this.readerLines.length : 0,
      readerRows,
      listRows: 0,
      barHits: [],
      fittingActions: [],
      paintedActions: [],
      pageMarker: this.pageMarker(),
      selectionMarker: this.selectionMarker(),
      generation: this.gestureGeneration,
    }
    return lines
  }

  private renderDetailsTitle(width: number, row: PresetRowView): string {
    const label = color.textStrong('Preset details')
    const suffix = color.textDim(` · ${sanitizedPhysicalLine(row.name)}`)
    return truncateToWidth(label + suffix, width, '')
  }

  /** ONE continuous Markdown reader at the CURRENT width: a resize re-wraps the
   *  same source and the offset is clamped, never truncated. */
  private renderReader(width: number, rows: number): string[] {
    this.readerLines = this.detailsDocument?.render(width) ?? []
    const maxScroll = Math.max(0, this.readerLines.length - Math.max(1, rows))
    this.detailsScroll = Math.max(0, Math.min(this.detailsScroll, maxScroll))
    return this.readerLines.slice(this.detailsScroll, this.detailsScroll + rows)
  }

  private renderBack(width: number): { line: string; complete: boolean } {
    const text = 'Back [Esc]'
    if (visibleWidth(text) + 2 > width) {
      return { line: truncateToWidth(`  ${text}`, width, ''), complete: false }
    }
    return { line: `  ${color.primary('Back')}${color.textMuted(' [Esc]')}`, complete: true }
  }
}
